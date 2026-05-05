"use strict";
/**
 * translationService.js — Layanan inti terjemahan per halaman
 *
 * Alur per halaman:
 * 1. Cek cache DB → jika sudah ada, return langsung
 * 2. Cek apakah bahasa target == bahasa asli → skip AI, simpan langsung
 * 3. Ambil teks asli halaman dari cache DB atau ekstrak dari PDF
 * 4. Kirim ke AI agent → terima hasil terjemahan
 * 5. Simpan ke DB → return ke user
 * 6. Background: pre-fetch halaman berikutnya
 */

const path  = require("fs").existsSync ? require("path") : { join: (...a) => a.join("/") };
const fs    = require("fs");
const { v4: uuidv4 } = require("uuid");
require("dotenv").config();

const db          = require("./db");
const { translateText } = require("./agents");
const { extractPdf, buildBookPages } = require("./pdfService");

const UPLOAD_DIR   = process.env.UPLOAD_DIR  || "./uploads";
const ENABLE_PREFETCH = process.env.ENABLE_PREFETCH !== "false";
const PREFETCH_AHEAD  = parseInt(process.env.PREFETCH_PAGES_AHEAD) || 2;

// Set untuk track halaman yang sedang diproses (avoid duplicate)
const processing = new Set();

/**
 * Pastikan semua halaman buku sudah diekstrak ke DB.
 * Dipanggil sekali saat upload atau sesi pertama.
 */
async function ensureBookExtracted(book) {
  const existingCount = db.getRawPageCount(book.id);
  if (existingCount > 0) return; // sudah ada

  console.log(`📖 Ekstrak PDF: ${book.originalName || book.filename}`);

  const filePath = path.join(UPLOAD_DIR, book.filename);
  if (!fs.existsSync(filePath)) {
    throw new Error(`File PDF tidak ditemukan: ${filePath}`);
  }

  const { rawPages } = await extractPdf(filePath);
  const bookPages    = buildBookPages(rawPages);

  // Simpan setiap halaman ke DB
  for (const page of bookPages) {
    db.insertRawPage({
      id:         uuidv4(),
      bookId:     book.id,
      pageNumber: page.bookPageNum,
      rawText:    page.text,
      charCount:  page.charCount,
    });
  }

  // Update total halaman di metadata buku
  db.updateBook(book.id, {
    total_book_pages: bookPages.length,
  });

  console.log(`✅ Ekstraksi selesai: ${bookPages.length} halaman buku`);
}

/**
 * Ambil halaman yang sudah diterjemah (atau terjemahkan jika belum).
 *
 * @param {string} bookId
 * @param {number} pageNumber  - nomor halaman buku (1-based)
 * @param {string} targetLang  - kode bahasa target ("id", "en", "ar", dst)
 * @param {string} agentId     - agent yang dipilih user
 * @returns {Object} { pageNumber, totalPages, text, agentUsed, fromCache, isSameLanguage }
 */
async function getPage(bookId, pageNumber, targetLang, agentId) {
  // 1. Ambil metadata buku
  const book = db.getBook(bookId);
  if (!book) throw new Error(`Buku tidak ditemukan: ${bookId}`);

  // 2. Pastikan PDF sudah diekstrak
  await ensureBookExtracted(book);

  // 3. Total halaman
  const totalPages = book.total_book_pages || db.getRawPageCount(bookId);

  if (pageNumber < 1 || pageNumber > totalPages) {
    throw new Error(`Halaman ${pageNumber} tidak ada (total: ${totalPages})`);
  }

  // 4. Cek cache terjemahan
  const cached = db.getTranslation(bookId, pageNumber, targetLang);
  if (cached) {
    console.log(`⚡ Cache hit: buku=${bookId} hal=${pageNumber} lang=${targetLang}`);

    // Background: pre-fetch halaman berikutnya
    if (ENABLE_PREFETCH) {
      prefetchNext(bookId, pageNumber, totalPages, targetLang, agentId);
    }

    return {
      pageNumber,
      totalPages,
      text:          cached.translatedText || cached.translated_text,
      agentUsed:     cached.agentUsed      || cached.agent_used,
      isSameLanguage:!!(cached.isSameLanguage || cached.is_same_language),
      fromCache:     true,
      tokensSent:    cached.tokensSent     || cached.tokens_sent     || 0,
      tokensReceived:cached.tokensReceived || cached.tokens_received || 0,
    };
  }

  // 5. Ambil teks asli
  const rawPage = db.getRawPage(bookId, pageNumber);
  if (!rawPage) {
    throw new Error(`Teks asli halaman ${pageNumber} belum tersedia`);
  }

  const rawText    = rawPage.rawText || rawPage.raw_text;
  const sourceLang = book.language || "unknown";

  // 6. Cek apakah bahasa sama (tidak perlu terjemahan)
  const isSameLanguage = isSameLang(sourceLang, targetLang);

  let result;

  if (isSameLanguage) {
    // ── Bahasa sama: langsung simpan tanpa kirim ke AI ──
    console.log(`🔄 Bahasa sama (${sourceLang}): simpan langsung hal=${pageNumber}`);
    result = {
      translatedText: rawText,
      agentUsed:      "none",
      tokensSent:     0,
      tokensReceived: 0,
    };
  } else {
    // ── Terjemahkan dengan AI ──
    // Guard: hindari double-processing halaman yang sama
    const lockKey = `${bookId}:${pageNumber}:${targetLang}`;
    if (processing.has(lockKey)) {
      // Tunggu proses yang sedang berjalan (polling sederhana)
      console.log(`⏳ Menunggu proses yang sudah berjalan: ${lockKey}`);
      await waitForProcessing(bookId, pageNumber, targetLang);
      return getPage(bookId, pageNumber, targetLang, agentId); // retry dari cache
    }

    processing.add(lockKey);
    try {
      console.log(`🚀 Terjemah: hal=${pageNumber} | ${sourceLang}→${targetLang} | agent=${agentId || "default"}`);
      result = await translateText(rawText, sourceLang, targetLang, agentId);
    } finally {
      processing.delete(lockKey);
    }
  }

  // 7. Simpan hasil ke DB
  db.insertTranslation({
    id:             uuidv4(),
    bookId,
    pageNumber,
    targetLang,
    translatedText: result.translatedText,
    agentUsed:      result.agentUsed,
    tokensSent:     result.tokensSent,
    tokensReceived: result.tokensReceived,
    isSameLanguage,
    translatedAt:   new Date().toISOString(),
  });

  // 8. Pre-fetch background
  if (ENABLE_PREFETCH) {
    prefetchNext(bookId, pageNumber, totalPages, targetLang, agentId);
  }

  return {
    pageNumber,
    totalPages,
    text:           result.translatedText,
    agentUsed:      result.agentUsed,
    isSameLanguage,
    fromCache:      false,
    tokensSent:     result.tokensSent,
    tokensReceived: result.tokensReceived,
  };
}

/**
 * Pre-fetch halaman berikutnya di background (tidak blocking)
 */
function prefetchNext(bookId, currentPage, totalPages, targetLang, agentId) {
  for (let i = 1; i <= PREFETCH_AHEAD; i++) {
    const nextPage = currentPage + i;
    if (nextPage > totalPages) break;

    // Hanya pre-fetch jika belum ada di cache
    const already = db.getTranslation(bookId, nextPage, targetLang);
    const lockKey = `${bookId}:${nextPage}:${targetLang}`;

    if (!already && !processing.has(lockKey)) {
      console.log(`🔮 Pre-fetch background: hal=${nextPage}`);
      // Fire and forget — error diabaikan
      getPage(bookId, nextPage, targetLang, agentId)
        .catch(e => console.warn(`Pre-fetch hal=${nextPage} gagal:`, e.message));
    }
  }
}

/**
 * Polling tunggu proses terjemahan selesai (maks 60 detik)
 */
async function waitForProcessing(bookId, pageNumber, targetLang, maxWaitMs = 60000) {
  const lockKey  = `${bookId}:${pageNumber}:${targetLang}`;
  const deadline = Date.now() + maxWaitMs;

  while (processing.has(lockKey) && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 500));
  }

  if (processing.has(lockKey)) {
    throw new Error(`Terjemahan timeout: hal=${pageNumber}`);
  }
}

/**
 * Normalisasi kode bahasa dan cek kesamaan
 */
function isSameLang(a, b) {
  if (!a || !b) return false;
  const normalize = s => s.toLowerCase().trim().slice(0, 2);
  return normalize(a) === normalize(b);
}

/**
 * Terjemahkan cover/halaman 1 segera setelah upload
 */
async function translateCoverPage(book, targetLang, agentId) {
  try {
    await ensureBookExtracted(book);
    await getPage(book.id, 1, targetLang, agentId);
    db.updateBook(book.id, { cover_translated: 1 });
    console.log(`✅ Cover page (hal 1) sudah diterjemah: buku=${book.id}`);
  } catch (e) {
    console.error("Cover page translation failed:", e.message);
  }
}

/**
 * Statistik cache buku
 */
function getBookStats(bookId, targetLang) {
  const book       = db.getBook(bookId);
  const totalPages = book?.total_book_pages || 0;
  let   cached     = 0;

  for (let i = 1; i <= totalPages; i++) {
    if (db.getTranslation(bookId, i, targetLang)) cached++;
  }

  return {
    totalPages,
    cachedPages: cached,
    percentReady: totalPages ? Math.round((cached / totalPages) * 100) : 0,
  };
}

module.exports = { getPage, ensureBookExtracted, translateCoverPage, getBookStats, isSameLang };
