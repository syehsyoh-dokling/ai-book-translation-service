# 📚 AI Book Translation API — Dokumentasi Lengkap

## Base URL
```
http://localhost:3000/api
```

---

## 🔄 Alur Sistem (Flow)

```
┌─────────────────────────────────────────────────────────────────────┐
│                         ALUR LENGKAP                                │
│                                                                     │
│  1. UPLOAD BUKU                                                     │
│     POST /api/books/upload  ─────────────────────────────────────  │
│     ↓ (background, async)                                           │
│     - Ekstrak semua teks PDF → simpan ke DB (book_pages)           │
│     - Terjemah halaman 1 (cover) → simpan ke DB (translations)     │
│                                                                     │
│  2. TAMPIL DAFTAR BUKU                                              │
│     GET /api/books  →  cover page sudah siap, sisanya belum         │
│                                                                     │
│  3. USER PILIH BUKU + BAHASA                                        │
│     GET /api/books/:id?lang=id  →  tampilkan cover                 │
│                                                                     │
│  4. MULAI SESI BACA                                                 │
│     POST /api/books/:id/sessions                                    │
│     Body: { targetLang: "id", agentId: "claude" }                  │
│     Response: { sessionId, totalPages }                             │
│                                                                     │
│  5. BACA HALAMAN (saat user klik tombol halaman)                    │
│     GET /api/sessions/:sessionId/pages/1                            │
│     ↓                                                               │
│     ┌─────────────────────────────────────────┐                    │
│     │ Cek DB cache                            │                    │
│     │   ├─ ADA → return langsung (fromCache)  │                    │
│     │   └─ TIDAK ADA:                         │                    │
│     │       ├─ Bahasa sama? → simpan & return │                    │
│     │       └─ Bahasa beda:                   │                    │
│     │           1. Ambil teks asli dari DB    │                    │
│     │           2. Split sesuai batas agent   │                    │
│     │           3. Kirim ke AI agent          │                    │
│     │           4. Terima hasil terjemahan    │                    │
│     │           5. Simpan ke DB               │                    │
│     │           6. Return ke user             │                    │
│     └─────────────────────────────────────────┘                    │
│     ↓ (background)                                                  │
│     Pre-fetch halaman 2 & 3 secara otomatis                        │
│                                                                     │
│  6. USER KLIK HALAMAN BERIKUTNYA                                    │
│     GET /api/sessions/:sessionId/pages/2                            │
│     → Sudah ada di cache (pre-fetch) → return instan               │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 🤖 Token Budget per AI Agent

| Agent          | Context Max | Chunk Dikirim | Keterangan              |
|----------------|-------------|---------------|-------------------------|
| Claude Sonnet  | 200k tokens | 12,000 chars  | Terbaik untuk nuansa    |
| GPT-4o         | 128k tokens | 10,000 chars  | Stabil & cepat          |
| Gemini 1.5 Pro | 1M tokens   | 15,000 chars  | Bisa chunk lebih besar  |
| Deepseek       | 64k tokens  | 8,000 chars   | Ekonomis                |

**1 halaman buku** = ~2,500 karakter = dipastikan muat dalam 1 chunk.

---

## 📡 Endpoints

### `GET /api/health`
Cek status server dan agent.

**Response:**
```json
{
  "success": true,
  "status": "ok",
  "agentsReady": 2,
  "totalAgents": 4
}
```

---

### `POST /api/books/upload`
Upload buku PDF baru.

**Request:** `multipart/form-data`
```
file        : [PDF file] (wajib)
title       : "Judul Buku" (opsional, default dari nama file)
author      : "Nama Pengarang" (opsional)
defaultLang : "id" (opsional, untuk terjemah cover page, default "id")
agentId     : "claude" (opsional)
```

**Contoh curl:**
```bash
curl -X POST http://localhost:3000/api/books/upload \
  -F "file=@/path/to/buku-arab.pdf" \
  -F "title=Kitab Al-Hikam" \
  -F "author=Ibnu Atha'illah" \
  -F "defaultLang=id" \
  -F "agentId=claude"
```

**Response (201):**
```json
{
  "success": true,
  "book": {
    "id": "uuid-xxx",
    "title": "Kitab Al-Hikam",
    "author": "Ibnu Atha'illah",
    "totalPages": 248,
    "status": "processing"
  },
  "message": "Upload berhasil. Cover page sedang diterjemah di background."
}
```

---

### `GET /api/books`
Daftar semua buku.

```bash
curl http://localhost:3000/api/books
```

**Response:**
```json
{
  "success": true,
  "books": [
    {
      "id": "uuid-xxx",
      "title": "Kitab Al-Hikam",
      "author": "Ibnu Atha'illah",
      "language": "ar",
      "totalPages": 248,
      "coverReady": true,
      "uploadedAt": "2025-05-05T10:00:00Z"
    }
  ]
}
```

---

### `GET /api/books/:id?lang=id`
Detail buku + cover page yang sudah diterjemah.

```bash
curl "http://localhost:3000/api/books/uuid-xxx?lang=id"
```

**Response:**
```json
{
  "success": true,
  "book": {
    "id": "uuid-xxx",
    "title": "Kitab Al-Hikam",
    "language": "ar",
    "totalPages": 248,
    "coverPage": {
      "pageNumber": 1,
      "text": "Termasuk tanda-tanda sandaran pada amal adalah berkurangnya harapan tatkala datang kesalahan...",
      "lang": "id",
      "ready": true
    },
    "stats": {
      "totalPages": 248,
      "cachedPages": 5,
      "percentReady": 2
    }
  }
}
```

---

### `POST /api/books/:id/sessions`
Mulai sesi baca.

```bash
curl -X POST http://localhost:3000/api/books/uuid-xxx/sessions \
  -H "Content-Type: application/json" \
  -d '{"targetLang":"id","agentId":"claude","userId":"user123"}'
```

**Response (201):**
```json
{
  "success": true,
  "session": {
    "sessionId": "session-uuid",
    "bookId": "uuid-xxx",
    "bookTitle": "Kitab Al-Hikam",
    "targetLang": "id",
    "agentId": "claude",
    "currentPage": 1,
    "totalPages": 248
  }
}
```

---

### `GET /api/sessions/:sessionId/pages/:pageNum`
⭐ **Endpoint Utama** — Ambil halaman buku.

```bash
# Halaman 1
curl "http://localhost:3000/api/sessions/session-uuid/pages/1"

# Halaman 5
curl "http://localhost:3000/api/sessions/session-uuid/pages/5"
```

**Response:**
```json
{
  "success": true,
  "page": {
    "pageNumber": 5,
    "totalPages": 248,
    "text": "Fasal ketiga membahas tentang hakikat tawakal...\n\nSeorang yang bertawakal sejati tidak akan...",
    "targetLang": "id",
    "agentUsed": "claude",
    "isSameLanguage": false,
    "fromCache": false,
    "meta": {
      "tokensSent": 820,
      "tokensReceived": 650,
      "charCount": 2340
    },
    "navigation": {
      "hasPrev": true,
      "hasNext": true,
      "prevPage": 4,
      "nextPage": 6,
      "progress": 2
    }
  }
}
```

---

### `POST /api/sessions/:sessionId/prefetch`
Pre-fetch halaman tertentu di background.

```bash
curl -X POST http://localhost:3000/api/sessions/session-uuid/prefetch \
  -H "Content-Type: application/json" \
  -d '{"pages":[10,11,12]}'
```

---

### `GET /api/agents`
Daftar AI agent dan statusnya.

```bash
curl http://localhost:3000/api/agents
```

**Response:**
```json
{
  "success": true,
  "agents": [
    {
      "id": "claude",
      "displayName": "Claude (Anthropic)",
      "model": "claude-sonnet-4-20250514",
      "maxChunkChars": 12000,
      "available": true,
      "isDefault": true
    },
    {
      "id": "openai",
      "displayName": "GPT-4o (OpenAI)",
      "model": "gpt-4o",
      "maxChunkChars": 10000,
      "available": false,
      "isDefault": false
    }
  ]
}
```

---

### `PUT /api/agents/default`
Ganti agent default.

```bash
curl -X PUT http://localhost:3000/api/agents/default \
  -H "Content-Type: application/json" \
  -d '{"agentId":"openai"}'
```

---

### `GET /api/languages`
Daftar bahasa yang didukung.

```bash
curl http://localhost:3000/api/languages
```

---

## 🧩 Integrasi dengan UI (Contoh JavaScript)

```javascript
const API = "http://localhost:3000/api";

// 1. Upload buku
async function uploadBook(file, targetLang = "id") {
  const form = new FormData();
  form.append("file", file);
  form.append("defaultLang", targetLang);
  form.append("agentId", "claude");

  const res  = await fetch(`${API}/books/upload`, { method:"POST", body:form });
  const data = await res.json();
  return data.book; // { id, title, totalPages }
}

// 2. Ambil cover page untuk ditampilkan
async function getCoverPage(bookId, lang = "id") {
  const res  = await fetch(`${API}/books/${bookId}?lang=${lang}`);
  const data = await res.json();
  return data.book.coverPage; // { text, ready }
}

// 3. Mulai sesi baca
async function startReading(bookId, targetLang, agentId = "claude") {
  const res  = await fetch(`${API}/books/${bookId}/sessions`, {
    method:  "POST",
    headers: { "Content-Type":"application/json" },
    body:    JSON.stringify({ targetLang, agentId }),
  });
  const data = await res.json();
  return data.session.sessionId;
}

// 4. Ambil halaman (dipanggil setiap user klik "Halaman Berikutnya")
async function readPage(sessionId, pageNumber) {
  const res  = await fetch(`${API}/sessions/${sessionId}/pages/${pageNumber}`);
  const data = await res.json();
  if (!data.success) throw new Error(data.error);
  return data.page; // { text, navigation, meta }
}

// ── Contoh pemakaian lengkap ──
async function main() {
  // Upload
  const book = await uploadBook(myPdfFile, "id");
  console.log(`Buku: ${book.title} (${book.totalPages} halaman)`);

  // Tunggu cover siap (polling sederhana)
  let coverReady = false;
  while (!coverReady) {
    const cover = await getCoverPage(book.id, "id");
    coverReady  = cover.ready;
    if (!coverReady) await new Promise(r => setTimeout(r, 2000));
  }

  // Mulai baca
  const sessionId = await startReading(book.id, "id", "claude");

  // Baca halaman per halaman
  for (let page = 1; page <= book.totalPages; page++) {
    const result = await readPage(sessionId, page);
    console.log(`\n─── Halaman ${page}/${result.totalPages} ───`);
    console.log(result.text);
    console.log(`[${result.fromCache ? "CACHE" : "TERJEMAH BARU"} | ${result.agentUsed}]`);

    // Simulasi user baca 3 detik
    await new Promise(r => setTimeout(r, 3000));
  }
}
```

---

## ⚙️ Konfigurasi .env

```env
# Server
PORT=3000

# AI Agents (isi minimal satu)
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
GEMINI_API_KEY=...
DEEPSEEK_API_KEY=...

# Agent default
DEFAULT_AGENT=claude

# Ukuran halaman buku (~2500 karakter ≈ 1 halaman buku fisik)
CHARS_PER_BOOK_PAGE=2500

# Pre-fetch otomatis
ENABLE_PREFETCH=true
PREFETCH_PAGES_AHEAD=2
```
