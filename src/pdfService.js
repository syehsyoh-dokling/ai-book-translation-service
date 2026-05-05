"use strict";
/**
 * pdfService.js — Ekstraksi teks dari PDF
 *
 * Fungsi utama:
 *   extractAllPages(filePath)  → ekstrak semua halaman ke array teks
 *   extractPage(filePath, n)   → ekstrak halaman ke-N
 *   buildBookPages(rawPages)   → bagi teks ke "halaman buku" sesuai CHARS_PER_BOOK_PAGE
 */

const fs       = require("fs");
const path     = require("path");
const pdfParse = require("pdf-parse");
require("dotenv").config();

const CHARS_PER_BOOK_PAGE = parseInt(process.env.CHARS_PER_BOOK_PAGE) || 2500;

/**
 * Ekstrak metadata + semua teks dari PDF.
 * pdf-parse mengekstrak seluruh dokumen sekaligus,
 * lalu kita split per halaman PDF menggunakan page callback.
 *
 * @returns {Object} { metadata, pages: [{pageNum, text, charCount}] }
 */
async function extractPdf(filePath) {
  const buffer = fs.readFileSync(filePath);

  const rawPages = [];

  // Gunakan pagerender callback untuk menangkap per halaman
  const options = {
    pagerender: (pageData) => {
      return pageData.getTextContent({ normalizeWhitespace: true }).then(tc => {
        const text = tc.items
          .map(item => item.str)
          .join(" ")
          .replace(/\s{3,}/g, "\n\n")   // spasi berlebih → paragraf
          .replace(/  +/g, " ")          // double space → single
          .trim();

        rawPages.push({
          pdfPageNum: rawPages.length + 1,
          text,
          charCount: text.length,
        });

        return text;
      });
    },
  };

  let parsed;
  try {
    parsed = await pdfParse(buffer, options);
  } catch (err) {
    // Fallback: tanpa per-page rendering
    console.warn("Per-page render failed, using full-text fallback:", err.message);
    const fallback = await pdfParse(buffer);
    rawPages.push({
      pdfPageNum: 1,
      text: fallback.text,
      charCount: fallback.text.length,
    });
    parsed = fallback;
  }

  // Metadata buku
  const metadata = {
    title:         parsed.info?.Title   || detectTitle(rawPages[0]?.text || ""),
    author:        parsed.info?.Author  || "",
    totalPdfPages: parsed.numpages      || rawPages.length,
    language:      detectLanguage(rawPages.slice(0, 3).map(p => p.text).join(" ")),
  };

  return { metadata, rawPages };
}

/**
 * Gabungkan semua teks PDF menjadi "halaman buku" semu.
 * Setiap halaman buku ≈ CHARS_PER_BOOK_PAGE karakter,
 * dipotong di batas paragraf atau kalimat.
 *
 * @param {Array} rawPages - array { pdfPageNum, text }
 * @returns {Array} bookPages - array { bookPageNum, text, pdfPagesSpanned }
 */
function buildBookPages(rawPages) {
  // Gabungkan semua teks dengan penanda halaman PDF
  const fullText = rawPages
    .map(p => p.text)
    .join("\n\n")
    .replace(/\n{4,}/g, "\n\n\n"); // normalisasi baris kosong berlebih

  if (!fullText.trim()) {
    return [{ bookPageNum: 1, text: "(Halaman kosong atau tidak dapat diekstrak)", charCount: 0 }];
  }

  // Split menjadi halaman buku
  const bookPages = [];
  let remaining   = fullText.trim();
  let pageNum     = 1;

  while (remaining.length > 0) {
    if (remaining.length <= CHARS_PER_BOOK_PAGE) {
      bookPages.push({
        bookPageNum: pageNum,
        text:        remaining,
        charCount:   remaining.length,
      });
      break;
    }

    // Cari titik potong terbaik
    let cutAt = CHARS_PER_BOOK_PAGE;

    // Prioritas 1: akhir paragraf
    const paraIdx = remaining.lastIndexOf("\n\n", CHARS_PER_BOOK_PAGE);
    if (paraIdx > CHARS_PER_BOOK_PAGE * 0.5) {
      cutAt = paraIdx + 2;
    } else {
      // Prioritas 2: akhir kalimat
      for (const sep of [". ", "! ", "? ", "؟ ", "。", "\n"]) {
        const idx = remaining.lastIndexOf(sep, CHARS_PER_BOOK_PAGE);
        if (idx > CHARS_PER_BOOK_PAGE * 0.5) {
          cutAt = idx + sep.length;
          break;
        }
      }
    }

    const chunk = remaining.slice(0, cutAt).trim();
    bookPages.push({
      bookPageNum: pageNum,
      text:        chunk,
      charCount:   chunk.length,
    });

    remaining = remaining.slice(cutAt).trim();
    pageNum++;
  }

  return bookPages;
}

/**
 * Deteksi bahasa berdasarkan karakter dalam teks
 */
function detectLanguage(sample) {
  if (!sample) return "unknown";

  const counts = {
    ar: (sample.match(/[\u0600-\u06FF]/g) || []).length,
    zh: (sample.match(/[\u4E00-\u9FFF]/g) || []).length,
    ja: (sample.match(/[\u3040-\u30FF]/g) || []).length,
    ko: (sample.match(/[\uAC00-\uD7A3]/g) || []).length,
    fa: (sample.match(/[\u0600-\u06FF\uFB50-\uFDFF]/g) || []).length,
    ru: (sample.match(/[\u0400-\u04FF]/g) || []).length,
  };

  // Cek karakter non-Latin dominan
  const maxNonLatin = Object.entries(counts).sort((a,b) => b[1]-a[1])[0];
  if (maxNonLatin[1] > sample.length * 0.2) return maxNonLatin[0];

  // Heuristic Latin: ID vs EN
  const idWords  = /\b(dan|yang|ini|itu|dengan|untuk|dari|pada|dalam|tidak|akan|ada|juga|sudah|saya|kami|kita|mereka|bukan|seperti|tentang|oleh|kepada|karena|namun|bahwa|bisa|lebih|setelah|sebelum|sangat|semua|atau|jika|harus|maka)\b/gi;
  const idScore  = (sample.match(idWords) || []).length;
  if (idScore > 5) return "id";

  const msWords  = /\b(dan|yang|ini|itu|dengan|untuk|dari|pada|dalam|tidak|akan|ada|juga|sudah|saya|kami|kita|mereka)\b/gi;
  const msScore  = (sample.match(msWords) || []).length;
  if (msScore > 3) return "ms";

  return "en"; // default Latin → English
}

/**
 * Coba ekstrak judul dari baris pertama teks
 */
function detectTitle(firstPageText) {
  if (!firstPageText) return "Tanpa Judul";
  const lines = firstPageText.split("\n").map(l => l.trim()).filter(Boolean);
  // Judul biasanya baris pertama yang panjangnya 5-100 karakter
  for (const line of lines.slice(0, 5)) {
    if (line.length >= 5 && line.length <= 100) return line;
  }
  return lines[0]?.slice(0, 80) || "Tanpa Judul";
}

/**
 * Hitung total halaman buku dari file PDF
 * (untuk menampilkan "X dari Y halaman" di UI)
 */
async function countBookPages(filePath) {
  try {
    const { rawPages } = await extractPdf(filePath);
    const bookPages    = buildBookPages(rawPages);
    return bookPages.length;
  } catch {
    return 0;
  }
}

module.exports = { extractPdf, buildBookPages, detectLanguage, countBookPages, CHARS_PER_BOOK_PAGE };
