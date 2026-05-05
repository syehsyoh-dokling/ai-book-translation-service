# AI Book Translation API

## Arsitektur Sistem

```
USER (UI)
  │
  ▼
┌─────────────────────────────────────────────────────────┐
│                    EXPRESS API SERVER                    │
│                                                         │
│  POST /api/books/upload     → Upload PDF buku           │
│  GET  /api/books            → Daftar semua buku         │
│  GET  /api/books/:id        → Detail buku + cover page  │
│  POST /api/books/:id/read   → Mulai sesi baca           │
│  GET  /api/pages/:sessionId/:pageNum  → Ambil halaman   │
│  POST /api/pages/prefetch   → Pre-fetch halaman berikut │
│  GET  /api/agents           → Daftar AI agents tersedia │
│  PUT  /api/agents/config    → Konfigurasi agent         │
└──────────────┬──────────────────────────────────────────┘
               │
       ┌───────▼────────┐
       │  PDF EXTRACTOR │  ← pdf-parse: ekstrak teks per chunk
       └───────┬────────┘
               │
       ┌───────▼────────┐
       │  PAGE MANAGER  │  ← Bagi teks ke halaman (token-aware)
       └───────┬────────┘
               │
       ┌───────▼────────────────────────────────┐
       │         TRANSLATION ENGINE              │
       │                                         │
       │  Jika target_lang == source_lang:       │
       │    → SKIP AI, simpan langsung           │
       │                                         │
       │  Jika berbeda:                          │
       │    → Pilih AI Agent sesuai config:      │
       │      • Claude (Anthropic) — default     │
       │      • OpenAI GPT-4                     │
       │      • Gemini Pro                       │
       │      • Deepseek                         │
       │    → Kirim chunk ≤ batas token agent    │
       │    → Terima hasil terjemahan            │
       └───────┬────────────────────────────────┘
               │
       ┌───────▼────────┐
       │   SQLite DB    │  ← Cache halaman yang sudah diterjemah
       └────────────────┘
```

## Alur Baca Buku

1. User upload PDF → sistem ekstrak metadata + cover page (hal 1)
2. Cover page langsung diterjemahkan saat upload
3. User klik "Baca" → sistem buat reading session
4. User klik halaman N → cek cache → jika belum ada, ekstrak + terjemah
5. Sistem pre-fetch halaman N+1 di background
6. Hasil disimpan di cache agar tidak diterjemah ulang

## Token Budget per Agent

| Agent          | Max Input Tokens | Chunk Size (chars) |
|----------------|------------------|--------------------|
| Claude Sonnet  | 180,000          | 12,000             |
| GPT-4o         | 120,000          | 10,000             |
| Gemini Pro     | 900,000          | 15,000             |
| Deepseek       | 60,000           | 8,000              |

## Menjalankan

```bash
cp .env.example .env
# Isi API keys di .env
npm start
```
