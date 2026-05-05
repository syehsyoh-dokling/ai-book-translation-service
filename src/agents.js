"use strict";
/**
 * agents.js — AI Translation Engine
 *
 * Mendukung 4 provider AI:
 *   1. Claude (Anthropic) — default
 *   2. OpenAI GPT-4
 *   3. Google Gemini
 *   4. Deepseek
 *
 * Setiap agent punya:
 *   - maxChunkChars: batas karakter per kiriman (berdasarkan context window)
 *   - translate(text, sourceLang, targetLang): fungsi terjemahan
 */

require("dotenv").config();

// ── Agent Definitions ─────────────────────────────────────────────────────────
const AGENTS = {

  // ── 1. Claude (Anthropic) ─────────────────────────────────────────────────
  claude: {
    id: "claude",
    displayName: "Claude (Anthropic)",
    model: process.env.CLAUDE_MODEL || "claude-sonnet-4-20250514",
    // Context 200k tokens ≈ ~150k kata. Kirim 12.000 char (~3k kata) per chunk
    // agar ada ruang untuk sistem prompt + output
    maxChunkChars: parseInt(process.env.CHUNK_SIZE_OVERRIDE) || 12000,
    available: !!process.env.ANTHROPIC_API_KEY,

    async translate(text, sourceLang, targetLang) {
      const Anthropic = require("@anthropic-ai/sdk");
      const client = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });

      const systemPrompt = buildSystemPrompt(sourceLang, targetLang);

      const resp = await client.messages.create({
        model: this.model,
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: "user", content: text }],
      });

      const translated = resp.content
        .filter(b => b.type === "text")
        .map(b => b.text)
        .join("");

      return {
        translatedText: translated,
        tokensSent: resp.usage?.input_tokens || estimateTokens(text),
        tokensReceived: resp.usage?.output_tokens || estimateTokens(translated),
      };
    },
  },

  // ── 2. OpenAI GPT-4 ──────────────────────────────────────────────────────
  openai: {
    id: "openai",
    displayName: "GPT-4o (OpenAI)",
    model: process.env.OPENAI_MODEL || "gpt-4o",
    // GPT-4o: 128k tokens. Kirim 10.000 char per chunk (aman)
    maxChunkChars: parseInt(process.env.CHUNK_SIZE_OVERRIDE) || 10000,
    available: !!process.env.OPENAI_API_KEY,

    async translate(text, sourceLang, targetLang) {
      const resp = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 4096,
          messages: [
            { role: "system", content: buildSystemPrompt(sourceLang, targetLang) },
            { role: "user", content: text },
          ],
        }),
      });

      if (!resp.ok) {
        const err = await resp.text();
        throw new Error(`OpenAI error ${resp.status}: ${err}`);
      }

      const data = await resp.json();
      const translated = data.choices[0]?.message?.content || "";

      return {
        translatedText: translated,
        tokensSent: data.usage?.prompt_tokens || estimateTokens(text),
        tokensReceived: data.usage?.completion_tokens || estimateTokens(translated),
      };
    },
  },

  // ── 3. Google Gemini ──────────────────────────────────────────────────────
  gemini: {
    id: "gemini",
    displayName: "Gemini 1.5 Pro (Google)",
    model: process.env.GEMINI_MODEL || "gemini-1.5-pro",
    // Gemini 1.5 Pro: 1M tokens. Bisa kirim lebih besar
    maxChunkChars: parseInt(process.env.CHUNK_SIZE_OVERRIDE) || 15000,
    available: !!process.env.GEMINI_API_KEY,

    async translate(text, sourceLang, targetLang) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${process.env.GEMINI_API_KEY}`;

      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: `${buildSystemPrompt(sourceLang, targetLang)}\n\n---TEKS---\n${text}`,
            }],
          }],
          generationConfig: { maxOutputTokens: 4096 },
        }),
      });

      if (!resp.ok) {
        const err = await resp.text();
        throw new Error(`Gemini error ${resp.status}: ${err}`);
      }

      const data = await resp.json();
      const translated = data.candidates?.[0]?.content?.parts?.[0]?.text || "";

      return {
        translatedText: translated,
        tokensSent: estimateTokens(text),
        tokensReceived: estimateTokens(translated),
      };
    },
  },

  // ── 4. Deepseek ───────────────────────────────────────────────────────────
  deepseek: {
    id: "deepseek",
    displayName: "Deepseek Chat",
    model: process.env.DEEPSEEK_MODEL || "deepseek-chat",
    // Deepseek: 64k tokens. Kirim 8.000 char per chunk
    maxChunkChars: parseInt(process.env.CHUNK_SIZE_OVERRIDE) || 8000,
    available: !!process.env.DEEPSEEK_API_KEY,

    async translate(text, sourceLang, targetLang) {
      const resp = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 4096,
          messages: [
            { role: "system", content: buildSystemPrompt(sourceLang, targetLang) },
            { role: "user", content: text },
          ],
        }),
      });

      if (!resp.ok) {
        const err = await resp.text();
        throw new Error(`Deepseek error ${resp.status}: ${err}`);
      }

      const data = await resp.json();
      const translated = data.choices?.[0]?.message?.content || "";

      return {
        translatedText: translated,
        tokensSent: data.usage?.prompt_tokens || estimateTokens(text),
        tokensReceived: data.usage?.completion_tokens || estimateTokens(translated),
      };
    },
  },
};

// ── Helper: System Prompt ─────────────────────────────────────────────────────
function buildSystemPrompt(sourceLang, targetLang) {
  const langNames = {
    id: "Bahasa Indonesia",
    en: "English",
    ar: "Arabic (Bahasa Arab)",
    ms: "Malay (Bahasa Melayu)",
    fr: "French (Bahasa Prancis)",
    de: "German (Bahasa Jerman)",
    es: "Spanish (Bahasa Spanyol)",
    zh: "Chinese Simplified (Bahasa Mandarin)",
    ja: "Japanese (Bahasa Jepang)",
    ko: "Korean (Bahasa Korea)",
    ru: "Russian (Bahasa Rusia)",
    tr: "Turkish (Bahasa Turki)",
    fa: "Persian/Farsi (Bahasa Persia)",
    ur: "Urdu",
  };

  const srcName = langNames[sourceLang] || sourceLang;
  const tgtName = langNames[targetLang] || targetLang;

  return `Anda adalah penerjemah profesional buku yang ahli dan akurat.

TUGAS: Terjemahkan teks berikut dari ${srcName} ke ${tgtName}.

ATURAN WAJIB:
1. Terjemahkan SELURUH teks yang diberikan — tidak ada yang boleh dilewati
2. Pertahankan SEMUA format paragraf, baris baru, dan spasi asli
3. Jika ada nomor ayat, nomor halaman, atau penomoran — PERTAHANKAN
4. Jangan tambahkan komentar, catatan, atau penjelasan Anda sendiri
5. Jangan tambahkan kalimat pembuka seperti "Berikut terjemahannya:" — langsung output terjemahan
6. Untuk istilah teknis atau nama diri, boleh cantumkan teks asli dalam kurung () jika membantu
7. Pertahankan konsistensi terminologi sepanjang teks
8. Untuk teks Arab: perhatikan konteks keagamaan, gunakan istilah baku yang sudah dikenal

OUTPUT: Hanya teks terjemahan, tidak ada yang lain.`;
}

// ── Helper: Estimasi token ────────────────────────────────────────────────────
function estimateTokens(text) {
  // Estimasi kasar: 1 token ≈ 4 karakter (untuk teks Latin)
  // Untuk Arab/China: 1 token ≈ 1.5 karakter
  return Math.ceil((text || "").length / 3.5);
}

// ── getAgent: ambil agent berdasarkan ID, fallback ke yang tersedia ────────────
function getAgent(agentId) {
  const preferred = AGENTS[agentId];
  if (preferred && preferred.available) return preferred;

  // Fallback: cari agent lain yang tersedia
  const defaultOrder = [
    process.env.DEFAULT_AGENT || "claude",
    "claude", "openai", "gemini", "deepseek",
  ];

  for (const id of defaultOrder) {
    if (AGENTS[id] && AGENTS[id].available) return AGENTS[id];
  }

  throw new Error(
    "Tidak ada AI agent yang terkonfigurasi. Isi minimal satu API key di file .env"
  );
}

// ── listAgents: daftar semua agent dan statusnya ──────────────────────────────
function listAgents() {
  return Object.values(AGENTS).map(a => ({
    id: a.id,
    displayName: a.displayName,
    model: a.model,
    maxChunkChars: a.maxChunkChars,
    available: a.available,
    isDefault: a.id === (process.env.DEFAULT_AGENT || "claude"),
  }));
}

// ── splitIntoChunks: bagi teks panjang sesuai batas agent ────────────────────
function splitIntoChunks(text, maxChars) {
  if (text.length <= maxChars) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxChars) {
      chunks.push(remaining);
      break;
    }

    // Cari titik potong terbaik: akhir paragraf, lalu akhir kalimat
    let cutAt = maxChars;

    // Coba potong di akhir paragraf (\n\n)
    const paraBreak = remaining.lastIndexOf("\n\n", maxChars);
    if (paraBreak > maxChars * 0.6) {
      cutAt = paraBreak + 2;
    } else {
      // Coba potong di akhir kalimat (. ! ?)
      const sentenceEnd = remaining.search(/[.!?؟]\s/g);
      const lastSentence = remaining.lastIndexOf(". ", maxChars) ||
                          remaining.lastIndexOf("! ", maxChars) ||
                          remaining.lastIndexOf("? ", maxChars) ||
                          remaining.lastIndexOf("؟ ", maxChars); // Arab
      if (lastSentence > maxChars * 0.6) {
        cutAt = lastSentence + 2;
      } else {
        // Potong di spasi terdekat
        const lastSpace = remaining.lastIndexOf(" ", maxChars);
        if (lastSpace > 0) cutAt = lastSpace + 1;
      }
    }

    chunks.push(remaining.slice(0, cutAt).trim());
    remaining = remaining.slice(cutAt).trim();
  }

  return chunks.filter(c => c.length > 0);
}

// ── translateText: terjemah teks (handle chunking otomatis) ──────────────────
async function translateText(text, sourceLang, targetLang, agentId) {
  const agent = getAgent(agentId);

  // Bagi teks menjadi chunks sesuai kapasitas agent
  const chunks = splitIntoChunks(text, agent.maxChunkChars);

  console.log(`  🤖 Agent: ${agent.displayName} | Chunks: ${chunks.length} | Total chars: ${text.length}`);

  let totalTokensSent = 0;
  let totalTokensReceived = 0;
  const translatedChunks = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    console.log(`  📤 Chunk ${i+1}/${chunks.length}: ${chunk.length} chars`);

    const result = await agent.translate(chunk, sourceLang, targetLang);
    translatedChunks.push(result.translatedText);
    totalTokensSent += result.tokensSent || 0;
    totalTokensReceived += result.tokensReceived || 0;

    // Jeda kecil antar chunk agar tidak rate-limit
    if (i < chunks.length - 1) {
      await new Promise(r => setTimeout(r, 300));
    }
  }

  return {
    translatedText: translatedChunks.join("\n\n"),
    agentUsed: agent.id,
    tokensSent: totalTokensSent,
    tokensReceived: totalTokensReceived,
  };
}

module.exports = { getAgent, listAgents, translateText, splitIntoChunks, estimateTokens, AGENTS };
