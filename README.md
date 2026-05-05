# AI Book Translation Service

Express API for uploading books, extracting PDF pages, creating translation sessions, and translating page content through configurable AI agents.

## Capabilities

- Upload PDF book files.
- Store book metadata and translation sessions.
- Extract and retrieve pages.
- Translate pages on demand.
- Warm up next pages for smoother reading.
- List supported agents and languages.
- Change the default translation agent.

## Tech Stack

- Node.js and Express.
- Multer for uploads.
- `pdf-parse` for PDF extraction.
- Local JSON/SQLite-style persistence helpers.
- Anthropic SDK plus provider abstraction in `src/agents.js`.

## Structure

```text
server.js
src/
  agents.js
  db.js
  pdfService.js
  routes.js
  translationService.js
API_DOCS.md
```

## Quick Start

```bash
npm install
copy .env.example .env
npm start
```

Development mode:

```bash
npm run dev
```

## API Overview

```text
GET    /api/health
POST   /api/books/upload
GET    /api/books
GET    /api/books/:id
DELETE /api/books/:id
POST   /api/books/:id/session
GET    /api/sessions/:sessionId
GET    /api/sessions/:sessionId/pages/:page
POST   /api/sessions/:sessionId/warmup
GET    /api/agents
PUT    /api/agents/default
GET    /api/languages
```

Detailed request/response notes are in `API_DOCS.md`.

## Environment

Use `.env.example` as the template. Provider keys must stay in `.env` and must not be committed.

## Notes

This service is separate from the main Unapindo API and from the translator web UI.
