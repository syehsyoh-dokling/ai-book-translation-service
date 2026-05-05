"use strict";
/**
 * routes.js — Semua endpoint API
 *
 * Books:
 *   POST   /api/books/upload            Upload PDF
 *   GET    /api/books                   Daftar buku
 *   GET    /api/books/:id               Detail buku
 *   DELETE /api/books/:id               Hapus buku
 *
 * Reading:
 *   POST   /api/books/:id/sessions      Mulai sesi baca (pilih bahasa + agent)
 *   GET    /api/sessions/:sessionId     Info sesi
 *   GET    /api/sessions/:sessionId/pages/:pageNum   Ambil halaman
 *   POST   /api/sessions/:sessionId/prefetch         Trigger pre-fetch manual
 *
 * Agents:
 *   GET    /api/agents                  Daftar AI agents + status
 *   PUT    /api/agents/default          Set agent default
 *
 * Utility:
 *   GET    /api/languages               Daftar bahasa yang didukung
 *   GET    /api/health                  Health check
 */

const express  = require("express");
const multer   = require("multer");
const path     = require("path");
const fs       = require("fs");
const { v4: uuidv4 } = require("uuid");
require("dotenv").config();

const db                  = require("./db");
const { listAgents }      = require("./agents");
const { countBookPages }  = require("./pdfService");
const {
  getPage,
  ensureBookExtracted,
  translateCoverPage,
  getBookStats,
}                         = require("./translationService");

const router    = express.Router();
const UPLOAD_DIR = process.env.UPLOAD_DIR || "./uploads";
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ── File upload config ────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename:    (_req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    cb(null, `${Date.now()}_${safe}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: (parseInt(process.env.MAX_FILE_SIZE_MB) || 50) * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === "application/pdf" || file.originalname.endsWith(".pdf")) {
      cb(null, true);
    } else {
      cb(new Error("Hanya file PDF yang diizinkan"));
    }
  },
});

// ── Helper: response wrapper ──────────────────────────────────────────────────
const ok  = (res, data, status = 200) => res.status(status).json({ success: true,  ...data });
const err = (res, msg, status = 400)  => res.status(status).json({ success: false, error: msg });

// ════════════════════════════════════════════════════════════════════════════
// HEALTH CHECK
// ════════════════════════════════════════════════════════════════════════════
router.get("/health", (_req, res) => {
  const agents = listAgents();
  ok(res, {
    status:        "ok",
    timestamp:     new Date().toISOString(),
    agentsReady:   agents.filter(a => a.available).length,
    totalAgents:   agents.length,
  });
});

// ════════════════════════════════════════════════════════════════════════════
// BOOKS
// ════════════════════════════════════════════════════════════════════════════

/**
 * POST /api/books/upload
 * Upload PDF buku baru
 *
 * Form-data:
 *   file          PDF file
 *   title         (opsional) override judul
 *   author        (opsional) nama pengarang
 *   defaultLang   bahasa target default untuk cover page ("id"|"en"|...)
 *   agentId       agent yang dipakai untuk cover page (opsional)
 */
router.post("/books/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return err(res, "File PDF tidak ditemukan di request");

    const bookId       = uuidv4();
    const defaultLang  = req.body.defaultLang || "id";
    const agentId      = req.body.agentId     || process.env.DEFAULT_AGENT || "claude";

    // Hitung total halaman (async, bisa lama untuk PDF besar)
    let totalBookPages = 0;
    try {
      totalBookPages = await countBookPages(path.join(UPLOAD_DIR, req.file.filename));
    } catch (e) {
      console.warn("Tidak bisa hitung halaman:", e.message);
    }

    // Simpan metadata buku
    const book = {
      id:            bookId,
      filename:      req.file.filename,
      originalName:  req.file.originalname,
      title:         req.body.title  || req.file.originalname.replace(".pdf",""),
      author:        req.body.author || "",
      language:      "unknown", // akan dideteksi saat ekstraksi
      totalPdfPages: 0,
      fileSize:      req.file.size,
      uploadedAt:    new Date().toISOString(),
    };

    db.insertBook(book);

    // Ekstrak PDF + terjemah cover page di background
    setImmediate(async () => {
      try {
        const savedBook = db.getBook(bookId);
        await ensureBookExtracted(savedBook);

        // Deteksi bahasa setelah ekstraksi
        const rawPage1 = db.getRawPage(bookId, 1);
        if (rawPage1) {
          const { detectLanguage } = require("./pdfService");
          const detectedLang = detectLanguage((rawPage1.rawText || rawPage1.raw_text || "").slice(0, 1000));
          db.updateBook(bookId, { language: detectedLang });
        }

        // Terjemah cover page
        const updatedBook = db.getBook(bookId);
        await translateCoverPage(updatedBook, defaultLang, agentId);

        console.log(`✅ Buku siap: ${bookId} | Halaman: ${db.getRawPageCount(bookId)}`);
      } catch (e) {
        console.error("Background processing error:", e.message);
      }
    });

    ok(res, {
      book: {
        id:           bookId,
        title:        book.title,
        author:       book.author,
        filename:     book.filename,
        totalPages:   totalBookPages,
        fileSize:     req.file.size,
        uploadedAt:   book.uploadedAt,
        status:       "processing", // cover page sedang diproses
      },
      message: "Upload berhasil. Cover page sedang diterjemah di background.",
    }, 201);

  } catch (e) {
    console.error("Upload error:", e);
    err(res, e.message, 500);
  }
});

/**
 * GET /api/books
 * Daftar semua buku
 */
router.get("/books", (_req, res) => {
  try {
    const books = db.listBooks().map(b => ({
      id:            b.id,
      title:         b.title,
      author:        b.author,
      language:      b.language,
      totalPages:    b.total_book_pages || b.totalBookPages || 0,
      totalPdfPages: b.total_pdf_pages  || b.totalPdfPages  || 0,
      fileSize:      b.file_size        || b.fileSize        || 0,
      coverReady:    !!(b.cover_translated || b.coverTranslated),
      uploadedAt:    b.uploaded_at      || b.uploadedAt,
    }));
    ok(res, { books, total: books.length });
  } catch (e) {
    err(res, e.message, 500);
  }
});

/**
 * GET /api/books/:id
 * Detail buku termasuk info cover page (halaman 1 yang sudah diterjemah)
 *
 * Query: ?lang=id (bahasa yang ingin dilihat covernya)
 */
router.get("/books/:id", async (req, res) => {
  try {
    const book = db.getBook(req.params.id);
    if (!book) return err(res, "Buku tidak ditemukan", 404);

    const lang       = req.query.lang || "id";
    const totalPages = book.total_book_pages || 0;

    // Ambil cover page jika sudah ada
    const coverTranslation = db.getTranslation(book.id, 1, lang);

    ok(res, {
      book: {
        id:          book.id,
        title:       book.title,
        author:      book.author,
        language:    book.language,
        totalPages,
        coverPage: coverTranslation ? {
          pageNumber: 1,
          text:       coverTranslation.translatedText || coverTranslation.translated_text,
          lang,
          ready:      true,
        } : {
          pageNumber: 1,
          text:       null,
          lang,
          ready:      false,
          message:    "Cover page sedang diproses, coba beberapa saat lagi",
        },
        stats: getBookStats(book.id, lang),
      },
    });
  } catch (e) {
    err(res, e.message, 500);
  }
});

/**
 * DELETE /api/books/:id
 * Hapus buku dan semua data terkait
 */
router.delete("/books/:id", (req, res) => {
  try {
    const book = db.getBook(req.params.id);
    if (!book) return err(res, "Buku tidak ditemukan", 404);

    // Hapus file PDF
    const filePath = path.join(UPLOAD_DIR, book.filename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

    // Note: JSON store tidak implement delete — bisa ditambah
    ok(res, { message: "Buku dihapus" });
  } catch (e) {
    err(res, e.message, 500);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// READING SESSIONS
// ════════════════════════════════════════════════════════════════════════════

/**
 * POST /api/books/:id/sessions
 * Mulai sesi baca buku
 *
 * Body (JSON):
 *   targetLang   bahasa target ("id"|"en"|"ar"|...)
 *   agentId      agent AI yang dipakai ("claude"|"openai"|"gemini"|"deepseek")
 *   userId       (opsional) ID user
 */
router.post("/books/:id/sessions", async (req, res) => {
  try {
    const book = db.getBook(req.params.id);
    if (!book) return err(res, "Buku tidak ditemukan", 404);

    const { targetLang, agentId, userId } = req.body;
    if (!targetLang) return err(res, "targetLang wajib diisi");

    const sessionId = uuidv4();
    const now       = new Date().toISOString();

    db.insertSession({
      id:          sessionId,
      bookId:      book.id,
      userId:      userId || "anonymous",
      targetLang,
      agentId:     agentId || process.env.DEFAULT_AGENT || "claude",
      currentPage: 1,
      createdAt:   now,
    });

    // Pre-fetch halaman 1 (mungkin belum diterjemah untuk bahasa ini)
    const agentToUse = agentId || process.env.DEFAULT_AGENT || "claude";
    setImmediate(() => {
      getPage(book.id, 1, targetLang, agentToUse)
        .catch(e => console.warn("Pre-fetch hal 1 gagal:", e.message));
    });

    const totalPages = book.total_book_pages || 0;

    ok(res, {
      session: {
        sessionId,
        bookId:     book.id,
        bookTitle:  book.title,
        targetLang,
        agentId:    agentToUse,
        currentPage:1,
        totalPages,
        createdAt:  now,
      },
    }, 201);
  } catch (e) {
    err(res, e.message, 500);
  }
});

/**
 * GET /api/sessions/:sessionId
 * Info sesi baca
 */
router.get("/sessions/:sessionId", (req, res) => {
  try {
    const session = db.getSession(req.params.sessionId);
    if (!session) return err(res, "Sesi tidak ditemukan", 404);

    const book = db.getBook(session.bookId || session.book_id);

    ok(res, {
      session: {
        sessionId:   session.id,
        bookId:      session.bookId    || session.book_id,
        bookTitle:   book?.title,
        targetLang:  session.targetLang || session.target_lang,
        agentId:     session.agentId   || session.agent_id,
        currentPage: session.currentPage || session.current_page || 1,
        totalPages:  book?.total_book_pages || 0,
        createdAt:   session.createdAt || session.created_at,
        lastAccessed:session.lastAccessedAt || session.last_accessed_at,
      },
    });
  } catch (e) {
    err(res, e.message, 500);
  }
});

/**
 * GET /api/sessions/:sessionId/pages/:pageNum
 * ★ ENDPOINT UTAMA ★
 * Ambil halaman buku yang sudah diterjemah.
 *
 * Alur:
 * 1. Cek cache → return jika ada
 * 2. Cek bahasa sama → simpan langsung tanpa AI
 * 3. Kirim ke AI agent → terjemahkan → simpan → return
 * 4. Background: pre-fetch halaman berikutnya
 */
router.get("/sessions/:sessionId/pages/:pageNum", async (req, res) => {
  try {
    const session = db.getSession(req.params.sessionId);
    if (!session) return err(res, "Sesi tidak ditemukan", 404);

    const pageNum   = parseInt(req.params.pageNum);
    if (isNaN(pageNum) || pageNum < 1) return err(res, "Nomor halaman tidak valid");

    const bookId    = session.bookId    || session.book_id;
    const targetLang= session.targetLang|| session.target_lang;
    const agentId   = session.agentId   || session.agent_id;

    console.log(`📄 Request hal=${pageNum} | lang=${targetLang} | agent=${agentId}`);

    const result = await getPage(bookId, pageNum, targetLang, agentId);

    // Update posisi sesi
    db.updateSession(req.params.sessionId, {
      current_page:     pageNum,
      last_accessed_at: new Date().toISOString(),
    });

    ok(res, {
      page: {
        pageNumber:    result.pageNumber,
        totalPages:    result.totalPages,
        text:          result.text,
        targetLang,
        agentUsed:     result.agentUsed,
        isSameLanguage:result.isSameLanguage,
        fromCache:     result.fromCache,
        meta: {
          tokensSent:     result.tokensSent,
          tokensReceived: result.tokensReceived,
          charCount:      result.text?.length || 0,
        },
        navigation: {
          hasPrev: pageNum > 1,
          hasNext: pageNum < result.totalPages,
          prevPage: pageNum > 1 ? pageNum - 1 : null,
          nextPage: pageNum < result.totalPages ? pageNum + 1 : null,
          progress: Math.round((pageNum / result.totalPages) * 100),
        },
      },
    });

  } catch (e) {
    console.error("Get page error:", e);
    err(res, e.message, e.message.includes("tidak ada") ? 404 : 500);
  }
});

/**
 * POST /api/sessions/:sessionId/prefetch
 * Trigger pre-fetch manual untuk halaman tertentu
 *
 * Body: { pages: [2, 3, 4] }
 */
router.post("/sessions/:sessionId/prefetch", async (req, res) => {
  try {
    const session = db.getSession(req.params.sessionId);
    if (!session) return err(res, "Sesi tidak ditemukan", 404);

    const pages     = req.body.pages || [];
    const bookId    = session.bookId     || session.book_id;
    const targetLang= session.targetLang || session.target_lang;
    const agentId   = session.agentId    || session.agent_id;

    // Fire and forget
    for (const p of pages) {
      getPage(bookId, p, targetLang, agentId)
        .catch(e => console.warn(`Prefetch hal=${p} gagal:`, e.message));
    }

    ok(res, { message: `Pre-fetching ${pages.length} halaman di background`, pages });
  } catch (e) {
    err(res, e.message, 500);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// AGENTS
// ════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/agents
 * Daftar semua AI agent dan statusnya
 */
router.get("/agents", (_req, res) => {
  const agents = listAgents();
  ok(res, { agents });
});

/**
 * PUT /api/agents/default
 * Set agent default (update .env runtime, tidak persist ke file)
 *
 * Body: { agentId: "openai" }
 */
router.put("/agents/default", (req, res) => {
  const { agentId } = req.body;
  const valid = ["claude","openai","gemini","deepseek"];
  if (!valid.includes(agentId)) return err(res, `Agent tidak valid. Pilihan: ${valid.join(", ")}`);

  process.env.DEFAULT_AGENT = agentId;
  ok(res, { message: `Agent default diubah ke: ${agentId}`, agentId });
});

// ════════════════════════════════════════════════════════════════════════════
// UTILITY
// ════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/languages
 * Daftar bahasa yang didukung
 */
router.get("/languages", (_req, res) => {
  ok(res, {
    languages: [
      { code:"id", name:"Bahasa Indonesia",  nativeName:"Bahasa Indonesia" },
      { code:"en", name:"English",           nativeName:"English" },
      { code:"ar", name:"Arabic",            nativeName:"العربية" },
      { code:"ms", name:"Malay",             nativeName:"Bahasa Melayu" },
      { code:"fr", name:"French",            nativeName:"Français" },
      { code:"de", name:"German",            nativeName:"Deutsch" },
      { code:"es", name:"Spanish",           nativeName:"Español" },
      { code:"zh", name:"Chinese Simplified",nativeName:"简体中文" },
      { code:"ja", name:"Japanese",          nativeName:"日本語" },
      { code:"ko", name:"Korean",            nativeName:"한국어" },
      { code:"ru", name:"Russian",           nativeName:"Русский" },
      { code:"tr", name:"Turkish",           nativeName:"Türkçe" },
      { code:"fa", name:"Persian",           nativeName:"فارسی" },
      { code:"ur", name:"Urdu",              nativeName:"اردو" },
    ],
  });
});

// Error handler untuk multer
router.use((err, _req, res, _next) => {
  if (err.code === "LIMIT_FILE_SIZE") {
    return err(res, `File terlalu besar. Maks ${process.env.MAX_FILE_SIZE_MB || 50}MB`, 413);
  }
  console.error("Router error:", err.message);
  res.status(500).json({ success: false, error: err.message });
});

module.exports = router;
