'use strict';

// ===========================================================================
//  OniSelf-Bot · Zentrale Konfiguration
// ---------------------------------------------------------------------------
//  Persona, Prefix, Defaults und alle aus der .env gelesenen Werte landen
//  hier. KEINE Secrets hardcoden — alles Sensible kommt aus der .env.
// ===========================================================================

const fs = require('fs');
const path = require('path');

// ── Winziger .env-Loader (dependency-frei) ─────────────────────────────────
// Liest die .env neben dieser Datei und schreibt fehlende Werte nach
// process.env. Bestehende echte Umgebungsvariablen (z.B. von PM2/Docker)
// gewinnen — die .env überschreibt sie NICHT.
(function loadEnv() {
  try {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return;
    for (const raw of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const idx = line.indexOf('=');
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim();
      let val = line.slice(idx + 1).trim();
      // Umschließende Quotes entfernen
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
  } catch (_) { /* .env optional */ }
})();

const env = process.env;
const bool = (v, def = false) => (v === undefined ? def : ['1', 'true', 'yes', 'on', 'ja'].includes(String(v).toLowerCase()));
const num = (v, def) => { const n = Number(v); return Number.isFinite(n) ? n : def; };

// ── Neele-Persona ──────────────────────────────────────────────────────────
// Zentral & leicht editierbar. Wird als System-Prompt für `.chat` UND als Ton
// für Bot-Texte (Begrüßung, Hilfe, Menü) verwendet.
const persona = {
  name: 'Neele',
  // System-Prompt für die Chat-KI (.chat). Frei anpassbar.
  systemPrompt:
    'Du bist Neele — ein freundlich-freches, charmantes WhatsApp-Girl mit rosa ' +
    'Anime-Vibe. Du antwortest locker, herzlich und mit einer Prise Humor, aber ' +
    'immer hilfsbereit und nie unhöflich. Du benutzt gelegentlich Emojis (🌸💖✨), ' +
    'aber übertreibst es nicht. Halte Antworten WhatsApp-tauglich (kurz bis mittel, ' +
    '*fett* für Betonung). Antworte IMMER in der Sprache, in der man dich anschreibt ' +
    '(Deutsch wenn deutsch, Englisch wenn englisch). Du bist KEIN steifer Assistent, ' +
    'sondern wirkst wie eine echte Person.',
  // Wiederverwendbare Textbausteine im Neele-Ton.
  greeting: '🌸 Hey~ Ich bin *Neele*! Tipp `{prefix}menu` und schau, was ich alles kann 💖',
  footer: '🌸 OniSelf · Neele',
};

const config = {
  // ── Basis ────────────────────────────────────────────────────────────────
  botName: env.ONISELF_BOTNAME || 'OniSelf',
  prefix: env.ONISELF_PREFIX || '.',
  // Owner-Nummern (nur Ziffern), kommasepariert in der .env.
  ownerNumbers: String(env.OWNER_NUMBER || env.ONISELF_OWNER_NUMBERS || '')
    .split(',').map((n) => n.replace(/[^0-9]/g, '')).filter(Boolean),
  // true → NUR Owner/eigene Nachrichten dürfen Befehle nutzen (echter Selfbot).
  // false → jeder darf Befehle nutzen, owner-only Befehle bleiben gesperrt.
  ownerOnly: bool(env.ONISELF_OWNER_ONLY, false),

  persona,

  // ── Pairing ────────────────────────────────────────────────────────────────
  // Nummer (nur Ziffern) für Pairing-Code statt QR. Leer → QR-Modus.
  pairNumber: String(env.ONISELF_PAIR_NUMBER || '').replace(/[^0-9]/g, ''),

  // ── Heartbeat (optional) ────────────────────────────────────────────────────
  heartbeat: {
    url: env.HEARTBEAT_URL || '',                 // leer → Heartbeat aus
    intervalSec: num(env.HEARTBEAT_INTERVAL_S, 60),
  },

  // ── Downloader ────────────────────────────────────────────────────────────
  download: {
    maxMB: num(env.DOWNLOAD_MAX_MB, 100),         // größere Dateien → Fehlertext
    timeoutMs: num(env.DOWNLOAD_TIMEOUT_MS, 60000),
  },

  // ── Stable Diffusion / KI ────────────────────────────────────────────────
  sd: {
    // Endpoint-Auflösung (erste nicht-leere gewinnt):
    //   1) SD_ENDPOINT          (manueller Override, z.B. Cloudflare-Tunnel)
    //   2) cache/colab.json .url (vom Colab-Notebook geschrieben)
    //   3) SD_COLAB_URL
    //   4) http://127.0.0.1:7860 (lokaler A1111)
    endpoint: env.SD_ENDPOINT || '',
    colabUrl: env.SD_COLAB_URL || '',
    fallbackEndpoint: env.SD_FALLBACK_ENDPOINT || 'http://127.0.0.1:7860',
    timeoutMs: num(env.SD_TIMEOUT_MS, 180000),
    // Online-Notfall-Fallback (image.pollinations.ai), wenn keine GPU erreichbar.
    pollinationsFallback: bool(env.SD_POLLINATIONS_FALLBACK, true),
  },

  // ── Text-KI (.chat) ──────────────────────────────────────────────────────
  chat: {
    geminiKey: env.GEMINI_API_KEY || '',
    geminiModel: env.GEMINI_MODEL || 'gemini-1.5-flash',
    maxHistory: num(env.CHAT_MAX_HISTORY, 10),
  },
};

// Default-AI-Settings (A1111 txt2img). Bewusst SDXL-Anime-tauglich gewählt.
// WICHTIG: Die Keys heißen exakt wie die A1111-Felder, damit sie 1:1 in den
// txt2img-Payload gemergt werden können (siehe oniself.js → buildSdPayload).
config.sdDefaults = {
  steps: 28,
  cfg_scale: 6.5,
  seed: -1,
  sampler_name: 'DPM++ 2M Karras',
  scheduler: 'Karras',
  negative_prompt:
    '(worst quality, low quality:1.4), lowres, bad anatomy, bad hands, missing fingers, ' +
    'extra digit, fewer digits, cropped, jpeg artifacts, signature, watermark, blurry, ' +
    'mutated, deformed, disfigured, ugly, duplicate, bad proportions',
  width: 832,
  height: 1216,
  // Hi-Res Fix — opt-in pro User via `.set hr on`
  enable_hr: false,
  hr_scale: 1.5,
  hr_upscaler: 'R-ESRGAN 4x+ Anime6B',
  hr_second_pass_steps: 12,
  denoising_strength: 0.4,
  restore_faces: false,
};

module.exports = config;
