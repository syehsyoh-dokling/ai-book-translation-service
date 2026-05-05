"use strict";
/**
 * server.js — Entry point
 */

require("dotenv").config();
const express = require("express");
const cors    = require("cors");
const path    = require("path");
const fs      = require("fs");

const routes  = require("./src/routes");

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// Request logger
app.use((req, _res, next) => {
  const ts = new Date().toISOString().slice(11,19);
  console.log(`[${ts}] ${req.method.padEnd(6)} ${req.path}`);
  next();
});

// ── Routes ────────────────────────────────────────────────────────────────────
app.use("/api", routes);

// Root info
app.get("/", (_req, res) => {
  res.json({
    name:    "AI Book Translation API",
    version: "1.0.0",
    docs:    "Lihat README.md untuk dokumentasi endpoint",
    endpoints: {
      health:      "GET  /api/health",
      uploadBook:  "POST /api/books/upload",
      listBooks:   "GET  /api/books",
      bookDetail:  "GET  /api/books/:id?lang=id",
      startSession:"POST /api/books/:id/sessions",
      getPage:     "GET  /api/sessions/:sessionId/pages/:pageNum",
      agents:      "GET  /api/agents",
      languages:   "GET  /api/languages",
    },
  });
});

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ success: false, error: "Endpoint tidak ditemukan" });
});

// Global error handler
app.use((err, _req, res, _next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ success: false, error: "Internal server error" });
});

// ── Start ─────────────────────────────────────────────────────────────────────
// Check at least one agent configured
const { listAgents } = require("./src/agents");
const available = listAgents().filter(a => a.available);

console.log("\n🚀 AI Book Translation API");
console.log("─".repeat(40));
console.log(`📍 Port    : ${PORT}`);
console.log(`🗄  DB      : ${process.env.DB_PATH || "./data/books.db"}`);
console.log(`📁 Uploads : ${process.env.UPLOAD_DIR || "./uploads"}`);
console.log(`📄 Chars/page: ${process.env.CHARS_PER_BOOK_PAGE || 2500}`);
console.log("\n🤖 AI Agents:");
listAgents().forEach(a => {
  const icon = a.available ? "✅" : "❌";
  const def  = a.isDefault ? " (DEFAULT)" : "";
  console.log(`  ${icon} ${a.displayName.padEnd(25)} ${a.model}${def}`);
});

if (available.length === 0) {
  console.warn("\n⚠️  PERINGATAN: Tidak ada API key agent yang dikonfigurasi!");
  console.warn("   Salin .env.example ke .env dan isi minimal satu API key.\n");
}

app.listen(PORT, () => {
  console.log(`\n✅ Server berjalan: http://localhost:${PORT}\n`);
});

module.exports = app;
