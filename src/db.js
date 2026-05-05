"use strict";
/**
 * db.js — SQLite database setup using node-sqlite3-wasm
 * Schema:
 *   books         — metadata setiap buku yang diupload
 *   book_pages    — teks asli per halaman (cache ekstraksi PDF)
 *   translations  — hasil terjemahan per halaman per bahasa
 *   read_sessions — sesi baca per user
 *   agent_config  — konfigurasi AI agent aktif
 */

const path  = require("path");
const fs    = require("fs");
require("dotenv").config();

const DB_PATH = process.env.DB_PATH || "./data/books.db";
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

// Gunakan node-sqlite3-wasm (pure WASM, tidak perlu build native)
const { DatabaseSync } = require("node:sqlite");   // Node 22.5+ built-in sqlite!

let db;
try {
  // Node 22 punya built-in sqlite — coba dulu
  db = new DatabaseSync(DB_PATH);
  console.log("✅ SQLite (Node built-in) connected:", DB_PATH);
} catch (e) {
  // Fallback: simpan ke memory-based JSON store
  console.warn("⚠️  Node built-in SQLite unavailable, using JSON store");
  db = null;
}

// ── JSON Fallback Store ───────────────────────────────────────────────────────
// Digunakan jika SQLite tidak tersedia (misal environment terbatas)
const STORE_PATH = path.resolve("./data/store.json");

function loadStore() {
  try { return JSON.parse(fs.readFileSync(STORE_PATH, "utf8")); }
  catch { return { books: {}, pages: {}, translations: {}, sessions: {}, agentConfig: {} }; }
}

function saveStore(store) {
  fs.mkdirSync("./data", { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

// ── Database Adapter ─────────────────────────────────────────────────────────
// Ekspor satu interface yang sama, baik pakai SQLite maupun JSON store

class JsonStore {
  constructor() {
    this.data = loadStore();
  }

  _save() { saveStore(this.data); }

  // ── Books ──────────────────────────────────────────────────────────────────
  insertBook({ id, filename, originalName, title, author, language, totalPdfPages, fileSize, uploadedAt }) {
    this.data.books[id] = { id, filename, originalName, title, author, language, totalPdfPages, fileSize, uploadedAt, coverTranslated: false };
    this._save();
    return id;
  }

  getBook(id) { return this.data.books[id] || null; }

  listBooks() { return Object.values(this.data.books); }

  updateBook(id, fields) {
    if (!this.data.books[id]) return;
    Object.assign(this.data.books[id], fields);
    this._save();
  }

  // ── Raw Pages (teks asli dari PDF) ────────────────────────────────────────
  insertRawPage({ id, bookId, pageNumber, rawText, charCount }) {
    const key = `${bookId}:${pageNumber}`;
    this.data.pages[key] = { id, bookId, pageNumber, rawText, charCount, extractedAt: new Date().toISOString() };
    this._save();
    return id;
  }

  getRawPage(bookId, pageNumber) {
    return this.data.pages[`${bookId}:${pageNumber}`] || null;
  }

  getRawPageCount(bookId) {
    return Object.values(this.data.pages).filter(p => p.bookId === bookId).length;
  }

  // ── Translations ───────────────────────────────────────────────────────────
  insertTranslation({ id, bookId, pageNumber, targetLang, translatedText, agentUsed, tokensSent, tokensReceived, isSameLanguage, translatedAt }) {
    const key = `${bookId}:${pageNumber}:${targetLang}`;
    this.data.translations[key] = { id, bookId, pageNumber, targetLang, translatedText, agentUsed, tokensSent, tokensReceived, isSameLanguage, translatedAt };
    this._save();
    return id;
  }

  getTranslation(bookId, pageNumber, targetLang) {
    return this.data.translations[`${bookId}:${pageNumber}:${targetLang}`] || null;
  }

  // ── Sessions ───────────────────────────────────────────────────────────────
  insertSession({ id, bookId, userId, targetLang, agentId, currentPage, createdAt }) {
    this.data.sessions[id] = { id, bookId, userId, targetLang, agentId, currentPage, createdAt, lastAccessedAt: createdAt };
    this._save();
    return id;
  }

  getSession(id) { return this.data.sessions[id] || null; }

  updateSession(id, fields) {
    if (!this.data.sessions[id]) return;
    Object.assign(this.data.sessions[id], fields);
    this._save();
  }

  // ── Agent Config ───────────────────────────────────────────────────────────
  getAgentConfig(agentId) { return this.data.agentConfig[agentId] || null; }

  setAgentConfig(agentId, config) {
    this.data.agentConfig[agentId] = config;
    this._save();
  }
}

// ── SQLite Adapter ────────────────────────────────────────────────────────────
class SqliteStore {
  constructor(database) {
    this.db = database;
    this._init();
  }

  _init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS books (
        id TEXT PRIMARY KEY,
        filename TEXT NOT NULL,
        original_name TEXT,
        title TEXT,
        author TEXT,
        language TEXT DEFAULT 'unknown',
        total_pdf_pages INTEGER DEFAULT 0,
        total_book_pages INTEGER DEFAULT 0,
        file_size INTEGER,
        cover_translated INTEGER DEFAULT 0,
        uploaded_at TEXT
      );

      CREATE TABLE IF NOT EXISTS book_pages (
        id TEXT PRIMARY KEY,
        book_id TEXT NOT NULL,
        page_number INTEGER NOT NULL,
        raw_text TEXT,
        char_count INTEGER DEFAULT 0,
        extracted_at TEXT,
        UNIQUE(book_id, page_number),
        FOREIGN KEY(book_id) REFERENCES books(id)
      );

      CREATE TABLE IF NOT EXISTS translations (
        id TEXT PRIMARY KEY,
        book_id TEXT NOT NULL,
        page_number INTEGER NOT NULL,
        target_lang TEXT NOT NULL,
        translated_text TEXT,
        agent_used TEXT,
        tokens_sent INTEGER DEFAULT 0,
        tokens_received INTEGER DEFAULT 0,
        is_same_language INTEGER DEFAULT 0,
        translated_at TEXT,
        UNIQUE(book_id, page_number, target_lang),
        FOREIGN KEY(book_id) REFERENCES books(id)
      );

      CREATE TABLE IF NOT EXISTS read_sessions (
        id TEXT PRIMARY KEY,
        book_id TEXT NOT NULL,
        user_id TEXT,
        target_lang TEXT NOT NULL,
        agent_id TEXT DEFAULT 'claude',
        current_page INTEGER DEFAULT 1,
        created_at TEXT,
        last_accessed_at TEXT,
        FOREIGN KEY(book_id) REFERENCES books(id)
      );

      CREATE TABLE IF NOT EXISTS agent_config (
        agent_id TEXT PRIMARY KEY,
        display_name TEXT,
        api_key_env TEXT,
        model TEXT,
        max_chunk_chars INTEGER,
        enabled INTEGER DEFAULT 1,
        priority INTEGER DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_translations ON translations(book_id, page_number, target_lang);
      CREATE INDEX IF NOT EXISTS idx_pages ON book_pages(book_id, page_number);
    `);
  }

  insertBook({ id, filename, originalName, title, author, language, totalPdfPages, fileSize, uploadedAt }) {
    this.db.prepare(`
      INSERT OR IGNORE INTO books (id,filename,original_name,title,author,language,total_pdf_pages,file_size,uploaded_at)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(id, filename, originalName, title, author, language, totalPdfPages, fileSize, uploadedAt);
    return id;
  }

  getBook(id) {
    return this.db.prepare("SELECT * FROM books WHERE id=?").get(id) || null;
  }

  listBooks() { return this.db.prepare("SELECT * FROM books ORDER BY uploaded_at DESC").all(); }

  updateBook(id, fields) {
    const sets = Object.keys(fields).map(k => `${k}=?`).join(",");
    this.db.prepare(`UPDATE books SET ${sets} WHERE id=?`).run(...Object.values(fields), id);
  }

  insertRawPage({ id, bookId, pageNumber, rawText, charCount }) {
    this.db.prepare(`
      INSERT OR IGNORE INTO book_pages (id,book_id,page_number,raw_text,char_count,extracted_at)
      VALUES (?,?,?,?,?,?)
    `).run(id, bookId, pageNumber, rawText, charCount, new Date().toISOString());
    return id;
  }

  getRawPage(bookId, pageNumber) {
    return this.db.prepare("SELECT * FROM book_pages WHERE book_id=? AND page_number=?").get(bookId, pageNumber) || null;
  }

  getRawPageCount(bookId) {
    return this.db.prepare("SELECT COUNT(*) as c FROM book_pages WHERE book_id=?").get(bookId)?.c || 0;
  }

  insertTranslation({ id, bookId, pageNumber, targetLang, translatedText, agentUsed, tokensSent, tokensReceived, isSameLanguage, translatedAt }) {
    this.db.prepare(`
      INSERT OR REPLACE INTO translations
        (id,book_id,page_number,target_lang,translated_text,agent_used,tokens_sent,tokens_received,is_same_language,translated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(id, bookId, pageNumber, targetLang, translatedText, agentUsed, tokensSent||0, tokensReceived||0, isSameLanguage?1:0, translatedAt);
    return id;
  }

  getTranslation(bookId, pageNumber, targetLang) {
    return this.db.prepare(
      "SELECT * FROM translations WHERE book_id=? AND page_number=? AND target_lang=?"
    ).get(bookId, pageNumber, targetLang) || null;
  }

  insertSession({ id, bookId, userId, targetLang, agentId, currentPage, createdAt }) {
    this.db.prepare(`
      INSERT INTO read_sessions (id,book_id,user_id,target_lang,agent_id,current_page,created_at,last_accessed_at)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(id, bookId, userId, targetLang, agentId||"claude", currentPage||1, createdAt, createdAt);
    return id;
  }

  getSession(id) {
    return this.db.prepare("SELECT * FROM read_sessions WHERE id=?").get(id) || null;
  }

  updateSession(id, fields) {
    const sets = Object.keys(fields).map(k => `${k}=?`).join(",");
    this.db.prepare(`UPDATE read_sessions SET ${sets} WHERE id=?`).run(...Object.values(fields), id);
  }

  getAgentConfig(agentId) {
    return this.db.prepare("SELECT * FROM agent_config WHERE agent_id=?").get(agentId) || null;
  }

  setAgentConfig(agentId, config) {
    this.db.prepare(`
      INSERT OR REPLACE INTO agent_config (agent_id,display_name,api_key_env,model,max_chunk_chars,enabled,priority)
      VALUES (?,?,?,?,?,?,?)
    `).run(agentId, config.displayName, config.apiKeyEnv, config.model, config.maxChunkChars, config.enabled?1:0, config.priority||0);
  }
}

// ── Export ────────────────────────────────────────────────────────────────────
let store;
if (db) {
  store = new SqliteStore(db);
} else {
  store = new JsonStore();
}

module.exports = store;
