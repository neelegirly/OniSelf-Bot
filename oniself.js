'use strict';

/* ===========================================================================
 *  🌸 OniSelf — monolithischer WhatsApp-Selfbot (Baileys)
 * ---------------------------------------------------------------------------
 *  EINE Datei. Core + ALLE Commands. Kein Plugin-Loader, keine /plugins.
 *  Features: Downloader · Stable-Diffusion-KI · Minispiele · Neele-Persona.
 *
 *  Befehle stehen in der COMMANDS-Map weiter unten. Router ist prefix-basiert.
 *  Setup & Doku: siehe README.md / .env.example.
 * =========================================================================== */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const { Boom } = require('@hapi/boom');

const config = require('./config');

// ── Baileys laden ──────────────────────────────────────────────────────────
// Öffentliches Upstream-Paket "baileys". (Der private @neelegirly-Fork des
// Original-Projekts lässt sich von Fremden nicht installieren — siehe
// ANALYSE.md. Gleiche API, deshalb 1:1 austauschbar.) Der Fallback erlaubt es,
// den Bot auch in einer Umgebung zu starten, in der nur der Fork installiert
// ist (z.B. zum Testen auf dem Original-Host).
let baileys;
try {
  baileys = require('baileys');
} catch (_) {
  baileys = require('@neelegirly/baileys');
}
const makeWASocket = baileys.default || baileys.makeWASocket;
const {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers,
} = baileys;

// ===========================================================================
//  LOGGER
// ===========================================================================
const log = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } },
}).child({ mod: 'OniSelf' });

const SESSION_DIR = path.join(__dirname, 'session');
const DATA_DIR = path.join(__dirname, 'data');
for (const d of [SESSION_DIR, DATA_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

// ===========================================================================
//  ANTI-CRASH GUARDS — loggen statt crashen
// ===========================================================================
process.on('uncaughtException', (err) => {
  log.error({ err: err && err.message }, 'uncaughtException — Crash verhindert.');
});
process.on('unhandledRejection', (reason) => {
  log.error({ reason: (reason && reason.message) || String(reason) }, 'unhandledRejection — abgefangen.');
});

// ===========================================================================
//  KLEINE HELFER
// ===========================================================================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtMB = (bytes) => (bytes / (1024 * 1024)).toFixed(1);
const onlyDigits = (s) => String(s || '').replace(/[^0-9]/g, '');
const shorten = (t, m = 120) => { const r = String(t || '').replace(/\s+/g, ' ').trim(); return r.length <= m ? r : r.slice(0, m - 1) + '…'; };

// Hübscher Rahmen im Neele-Stil
function frame(title, lines) {
  const out = [`╭─── 🌸 ${title} ───╮`];
  for (const l of lines) out.push(`  ${l}`);
  out.push(`╰───────────────────╯`, config.persona.footer);
  return out.join('\n');
}

// ===========================================================================
//  PERSISTENTER JSON-STORE (für AI-Settings)
// ===========================================================================
function jsonLoad(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_) { return fallback; }
}
function jsonSave(file, data) {
  try {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);     // atomar — ein Crash mitten im Write korruptiert nichts
    return true;
  } catch (e) { log.error({ err: e.message, file }, 'jsonSave fehlgeschlagen'); return false; }
}

// ===========================================================================
//  AI-SETTINGS  (per-User, persistent)
// ---------------------------------------------------------------------------
//  Schema = eine Quelle der Wahrheit für `.set` und `.settings`. Die Keys
//  heißen EXAKT wie die A1111-txt2img-Felder → 1:1-Merge in den Payload.
// ===========================================================================
const SETTINGS_FILE = path.join(DATA_DIR, 'ai-settings.json');

// type: int | float | bool | str ; aliases = Kurzformen für `.set <alias>`
const SETTABLE = {
  steps:                { type: 'int',   min: 1,   max: 150,  label: 'Steps' },
  cfg_scale:            { type: 'float', min: 1,   max: 30,   label: 'CFG',      aliases: ['cfg'] },
  sampler_name:         { type: 'str',   label: 'Sampler',    aliases: ['sampler'] },
  scheduler:            { type: 'str',   label: 'Scheduler' },
  seed:                 { type: 'int',   min: -1,  label: 'Seed' },
  width:                { type: 'int',   min: 256, max: 2048, label: 'Breite' },
  height:               { type: 'int',   min: 256, max: 2048, label: 'Höhe' },
  negative_prompt:      { type: 'str',   label: 'Negativ',    aliases: ['neg', 'negative'] },
  restore_faces:        { type: 'bool',  label: 'Restore Faces', aliases: ['faces'] },
  enable_hr:            { type: 'bool',  label: 'Hi-Res',     aliases: ['hr', 'hires'] },
  hr_scale:             { type: 'float', min: 1,   max: 4,    label: 'Hi-Res Scale', aliases: ['scale'] },
  hr_upscaler:          { type: 'str',   label: 'Upscaler',   aliases: ['upscaler'] },
  hr_second_pass_steps: { type: 'int',   min: 0,   max: 150,  label: 'Hi-Res Steps', aliases: ['hrsteps'] },
  denoising_strength:   { type: 'float', min: 0,   max: 1,    label: 'Denoise',  aliases: ['denoise', 'strength'] },
};

// Alias → echter Key
const SETTING_ALIASES = {};
for (const [key, spec] of Object.entries(SETTABLE)) {
  SETTING_ALIASES[key] = key;
  for (const a of (spec.aliases || [])) SETTING_ALIASES[a] = key;
}

function getUserSettings(userNum) {
  const all = jsonLoad(SETTINGS_FILE, {});
  const key = onlyDigits(userNum) || 'default';
  return { ...config.sdDefaults, ...(all[key] || {}) };
}
function setUserSetting(userNum, settingKey, value) {
  const all = jsonLoad(SETTINGS_FILE, {});
  const key = onlyDigits(userNum) || 'default';
  if (!all[key]) all[key] = {};
  all[key][settingKey] = value;
  jsonSave(SETTINGS_FILE, all);
}
function resetUserSettings(userNum) {
  const all = jsonLoad(SETTINGS_FILE, {});
  const key = onlyDigits(userNum) || 'default';
  delete all[key];
  jsonSave(SETTINGS_FILE, all);
}

// Validiert + konvertiert einen Rohwert gegen das Schema → {ok,value}|{ok:false,error}
function coerceSetting(key, raw) {
  const spec = SETTABLE[key];
  if (!spec) return { ok: false, error: `Unbekanntes Setting "${key}"` };
  const s = String(raw == null ? '' : raw).trim();
  switch (spec.type) {
    case 'int': {
      const v = parseInt(s, 10);
      if (isNaN(v)) return { ok: false, error: `${spec.label}: Ganzzahl erwartet` };
      if (spec.min != null && v < spec.min) return { ok: false, error: `${spec.label}: min ${spec.min}` };
      if (spec.max != null && v > spec.max) return { ok: false, error: `${spec.label}: max ${spec.max}` };
      return { ok: true, value: v };
    }
    case 'float': {
      const v = parseFloat(s.replace(',', '.'));
      if (isNaN(v)) return { ok: false, error: `${spec.label}: Zahl erwartet` };
      if (spec.min != null && v < spec.min) return { ok: false, error: `${spec.label}: min ${spec.min}` };
      if (spec.max != null && v > spec.max) return { ok: false, error: `${spec.label}: max ${spec.max}` };
      return { ok: true, value: Math.round(v * 1000) / 1000 };
    }
    case 'bool': {
      const on = ['on', 'true', '1', 'yes', 'ja', 'an'].includes(s.toLowerCase());
      const off = ['off', 'false', '0', 'no', 'nein', 'aus'].includes(s.toLowerCase());
      if (!on && !off) return { ok: false, error: `${spec.label}: on/off erwartet` };
      return { ok: true, value: on };
    }
    default: return { ok: true, value: s };
  }
}

// ===========================================================================
//  STABLE-DIFFUSION-CLIENT
// ===========================================================================

// Endpoint-Auflösung (erste nicht-leere gewinnt). Siehe config.sd.
function resolveSdEndpoint() {
  if (config.sd.endpoint) return config.sd.endpoint.replace(/\/$/, '');
  try {
    const p = path.join(__dirname, 'cache', 'colab.json');
    if (fs.existsSync(p)) {
      const d = jsonLoad(p, {});
      if (d && typeof d.url === 'string' && /^https?:\/\//i.test(d.url)) return d.url.replace(/\/$/, '');
    }
  } catch (_) {}
  if (config.sd.colabUrl) return config.sd.colabUrl.replace(/\/$/, '');
  return config.sd.fallbackEndpoint.replace(/\/$/, '');
}

/**
 * BAUT DEN txt2img-PAYLOAD — und genau hier landen die User-Settings WIRKLICH
 * im Request. Jedes A1111-Feld wird explizit aus den Settings übernommen; die
 * Hi-Res-Felder werden nur gesetzt, wenn enable_hr aktiv ist. Inline-Overrides
 * (z.B. aus dem Prompt) werden zuletzt drübergemergt.
 */
function buildSdPayload(settings, prompt, overrides = {}) {
  const payload = {
    prompt: `${prompt}, masterpiece, best quality, highly detailed`,
    negative_prompt: settings.negative_prompt,
    steps: settings.steps,
    cfg_scale: settings.cfg_scale,
    width: settings.width,
    height: settings.height,
    sampler_name: settings.sampler_name,
    scheduler: settings.scheduler,
    seed: settings.seed,
    restore_faces: !!settings.restore_faces,
    enable_hr: !!settings.enable_hr,
    send_images: true,
    save_images: false,
  };
  // Hi-Res-Felder NUR wenn aktiv — sonst lehnt A1111 teils ab / ignoriert sie.
  if (settings.enable_hr) {
    payload.hr_scale = settings.hr_scale;
    payload.hr_upscaler = settings.hr_upscaler;
    payload.hr_second_pass_steps = settings.hr_second_pass_steps;
    payload.denoising_strength = settings.denoising_strength;
  }
  Object.assign(payload, overrides);
  return payload;
}

/**
 * Generiert ein Bild über A1111. Loggt den Payload (Beweis: Settings sind drin),
 * gibt { buffers, info } zurück oder wirft mit klarem Fehlertext.
 */
async function sdGenerate(settings, prompt, overrides = {}) {
  const endpoint = resolveSdEndpoint();
  const payload = buildSdPayload(settings, prompt, overrides);

  // ── BEWEIS: Settings landen im Payload (Abschluss-Checkliste) ──
  log.info({
    endpoint,
    sentToApi: {
      steps: payload.steps, cfg_scale: payload.cfg_scale,
      width: payload.width, height: payload.height,
      sampler_name: payload.sampler_name, seed: payload.seed,
      enable_hr: payload.enable_hr, hr_scale: payload.hr_scale,
      hr_upscaler: payload.hr_upscaler, hr_second_pass_steps: payload.hr_second_pass_steps,
      denoising_strength: payload.denoising_strength,
    },
  }, '🎨 txt2img-Payload → A1111');

  let res;
  try {
    res = await axios.post(`${endpoint}/sdapi/v1/txt2img`, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: config.sd.timeoutMs,
    });
  } catch (err) {
    const code = err.code || (err.response && err.response.status);
    if (code === 'ECONNREFUSED' || code === 'ECONNABORTED' || code === 'ETIMEDOUT' || !err.response) {
      throw new Error(`SD-Backend nicht erreichbar (${endpoint}). Läuft A1111 mit --api? Tunnel offline?`);
    }
    const detail = (err.response && err.response.data && (err.response.data.detail || err.response.data.error)) || err.message;
    throw new Error(`SD-Fehler (HTTP ${code}): ${shorten(String(detail), 140)}`);
  }

  if (!res.data || !Array.isArray(res.data.images) || !res.data.images.length) {
    throw new Error('SD lieferte kein Bild zurück (kein Modell geladen?).');
  }
  const buffers = res.data.images.map((b64) => Buffer.from(String(b64).split(',').pop(), 'base64'));
  let info = {};
  try { info = typeof res.data.info === 'string' ? JSON.parse(res.data.info) : (res.data.info || {}); } catch (_) {}
  return { buffers, info, endpoint };
}

// Online-Notfall-Fallback, wenn keine GPU erreichbar ist.
async function pollinationsFallback(prompt, width, height) {
  const seed = Math.floor(Math.random() * 2147483647);
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=${width}&height=${height}&seed=${seed}&nologo=true&model=flux`;
  const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 45000, headers: { 'User-Agent': 'Mozilla/5.0' } });
  const buf = Buffer.from(res.data);
  if (buf.length < 10000) throw new Error('Pollinations lieferte kein gültiges Bild.');
  return buf;
}

// ===========================================================================
//  DOWNLOADER  (öffentliche, keylose Fallback-APIs)
// ===========================================================================
const DL_APIS = {
  nayan: 'https://nayan-video-downloader.vercel.app',
  siputzx: 'https://api.siputzx.my.id',
  bk9: 'https://api.bk9.site',
};

function detectPlatform(url) {
  const u = String(url).toLowerCase();
  if (/youtube\.com|youtu\.be/.test(u)) return 'youtube';
  if (/tiktok\.com/.test(u)) return 'tiktok';
  if (/instagram\.com/.test(u)) return 'instagram';
  if (/facebook\.com|fb\.watch|fb\.com/.test(u)) return 'facebook';
  return 'unknown';
}

// YouTube-Suche per Ergebnisseiten-Scrape → erste Video-URL
async function youtubeSearchUrl(query) {
  try {
    const res = await axios.get(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36' },
      timeout: 15000,
    });
    const m = res.data.match(/\/watch\?v=([a-zA-Z0-9_-]{11})/);
    if (m) return `https://www.youtube.com/watch?v=${m[1]}`;
  } catch (_) {}
  return null;
}

/**
 * Holt Medien-Metadaten/Download-Links für eine URL (oder YT-Suchbegriff).
 * type: 'audio' | 'video' | 'auto'. Gibt {title,video,audio,image,images,platform} zurück.
 */
async function fetchMediaMeta(queryOrUrl, type) {
  const isUrl = /^https?:\/\//i.test(queryOrUrl);
  let platform = isUrl ? detectPlatform(queryOrUrl) : 'youtube';

  // ── YouTube ──
  if (platform === 'youtube') {
    let target = queryOrUrl;
    if (!isUrl) {
      target = await youtubeSearchUrl(queryOrUrl);
      if (!target) throw new Error('Kein YouTube-Treffer für die Suche gefunden.');
    }
    const apis = [
      async () => {
        const r = await axios.get(`${DL_APIS.nayan}/ytdown?url=${encodeURIComponent(target)}`, { timeout: 30000 });
        if (r.data && r.data.status && r.data.data) {
          const d = r.data.data;
          return { title: d.title, video: d.video || d.audio, audio: d.audio, image: d.thumbnail || d.thumb, platform };
        }
        throw new Error('nayan ytdown');
      },
      async () => {
        const r = await axios.get(`${DL_APIS.siputzx}/api/d/ytmp3?url=${encodeURIComponent(target)}`, { timeout: 25000 });
        if (r.data && r.data.status && r.data.data) {
          const d = r.data.data;
          return { title: d.title, audio: d.dl, video: d.dl, image: d.thumbnail, platform };
        }
        throw new Error('siputzx ytmp3');
      },
    ];
    return await tryApis(apis);
  }

  // ── TikTok ──
  if (platform === 'tiktok') {
    let resolved = queryOrUrl;
    if (/vm\.tiktok\.com|vt\.tiktok\.com/.test(queryOrUrl)) {
      try {
        const r = await axios.get(queryOrUrl, { maxRedirects: 5, timeout: 15000 });
        resolved = (r.request && r.request.res && r.request.res.responseUrl) || queryOrUrl;
      } catch (_) {}
    }
    const extract = (d) => ({
      title: d.title,
      video: d.video || d.hdvideo,
      audio: d.audio || d.music,
      images: Array.isArray(d.images) ? d.images.filter(Boolean) : [],
      platform,
    });
    const apis = [
      async () => { const r = await axios.get(`${DL_APIS.nayan}/tikdown?url=${encodeURIComponent(resolved)}`, { timeout: 30000 }); if (r.data && r.data.status && r.data.data) return extract(r.data.data); throw new Error('nayan tikdown'); },
      async () => { const r = await axios.get(`${DL_APIS.siputzx}/api/d/tiktok?url=${encodeURIComponent(resolved)}`, { timeout: 25000 }); if (r.data && r.data.status && r.data.data) return extract(r.data.data); throw new Error('siputzx tiktok'); },
    ];
    return await tryApis(apis);
  }

  // ── Instagram ──
  if (platform === 'instagram') {
    const isImg = (u) => /\.(webp|jpg|jpeg|png|heic)(\?|$)/i.test(u);
    const apis = [
      async () => {
        const r = await axios.get(`${DL_APIS.nayan}/instagram?url=${encodeURIComponent(queryOrUrl)}`, { timeout: 25000, validateStatus: () => true });
        if (r.status === 200 && r.data && r.data.status && r.data.data) {
          const d = r.data.data;
          const vids = (Array.isArray(d.video) ? d.video : (d.video ? [d.video] : [])).filter((u) => !isImg(u));
          const imgs = [...(Array.isArray(d.images) ? d.images : []), ...(Array.isArray(d.thumb) ? d.thumb : (d.thumb ? [d.thumb] : []))];
          if (vids[0] || imgs[0]) return { title: d.title || 'Instagram', video: vids[0], image: imgs[0], platform };
        }
        throw new Error('nayan ig');
      },
      async () => {
        const r = await axios.get(`${DL_APIS.siputzx}/api/d/igdl?url=${encodeURIComponent(queryOrUrl)}`, { timeout: 20000 });
        if (r.data && r.data.status && Array.isArray(r.data.data) && r.data.data[0]) {
          const u = r.data.data[0].url || r.data.data[0];
          if (u) return { title: 'Instagram', video: isImg(u) ? undefined : u, image: isImg(u) ? u : undefined, platform };
        }
        throw new Error('siputzx ig');
      },
    ];
    return await tryApis(apis);
  }

  // ── Facebook ──
  if (platform === 'facebook') {
    const apis = [
      async () => {
        const r = await axios.get(`${DL_APIS.nayan}/alldown?url=${encodeURIComponent(queryOrUrl)}`, { timeout: 25000 });
        if (r.data && r.data.status && r.data.data) {
          const d = r.data.data; const video = d.high || d.low || d.hd || d.sd;
          if (video) return { title: d.title || 'Facebook', video, image: d.thumbnail, platform };
        }
        throw new Error('nayan fb');
      },
    ];
    return await tryApis(apis);
  }

  throw new Error('Plattform nicht erkannt. Unterstützt: YouTube, TikTok, Instagram, Facebook.');
}

async function tryApis(apis) {
  let lastErr = null;
  for (const fn of apis) {
    try { const r = await fn(); if (r) return r; }
    catch (e) { lastErr = e; }
  }
  throw new Error('Alle Download-APIs sind gerade nicht erreichbar. Bitte später erneut versuchen.' + (lastErr ? ` (${shorten(lastErr.message, 60)})` : ''));
}

// Lädt eine URL als Buffer mit Größenlimit.
async function downloadBuffer(url) {
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: config.download.timeoutMs,
    maxContentLength: config.download.maxMB * 1024 * 1024,
    maxBodyLength: config.download.maxMB * 1024 * 1024,
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': '*/*' },
  });
  return Buffer.from(res.data);
}

// ===========================================================================
//  CHAT-KI (Gemini · Neele-Persona)
// ===========================================================================
const chatHistories = new Map(); // chatId -> [{role, text}]

async function neeleChat(chatId, userText, senderName) {
  const key = config.chat.geminiKey;
  if (!key) {
    return '🌸 Mein KI-Hirn ist noch nicht verkabelt~ Trag einen `GEMINI_API_KEY` in die `.env` ein, dann plaudere ich richtig mit dir 💖';
  }
  const hist = chatHistories.get(chatId) || [];
  hist.push({ role: 'user', text: userText });
  while (hist.length > config.chat.maxHistory) hist.shift();

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.chat.geminiModel}:generateContent?key=${key}`;
    const payload = {
      contents: hist.map((h) => ({ role: h.role, parts: [{ text: h.text }] })),
      systemInstruction: { parts: [{ text: `${config.persona.systemPrompt}\nDu sprichst gerade mit "${senderName}".` }] },
      generationConfig: { temperature: 0.8, maxOutputTokens: 800 },
    };
    const res = await axios.post(url, payload, { timeout: 20000 });
    const answer = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (answer && answer.trim()) {
      hist.push({ role: 'model', text: answer.trim() });
      chatHistories.set(chatId, hist);
      return answer.trim();
    }
    throw new Error('leere Antwort');
  } catch (e) {
    log.warn({ err: e.message }, 'Gemini-Call fehlgeschlagen');
    return '🌸 Uff, gerade hakt mein KI-Backend. Probier es gleich nochmal 💭';
  }
}

// ===========================================================================
//  MINISPIELE  (State pro Chat)
// ===========================================================================
const games = {
  ttt: new Map(),      // chatId -> { board, turn }
  hangman: new Map(),  // chatId -> { word, guessed:Set, wrong, max }
  quiz: new Map(),     // chatId -> { answer, question }
  guess: new Map(),    // chatId -> { number, tries }
};

const HANGMAN_WORDS = ['katze', 'sonne', 'wolke', 'schmetterling', 'kaffee', 'computer', 'fahrrad', 'blume', 'musik', 'drache', 'pizza', 'regenbogen'];
const QUIZ = [
  { q: 'Hauptstadt von Frankreich?', a: 'paris' },
  { q: 'Wie viele Beine hat eine Spinne?', a: '8' },
  { q: 'Welches Element hat das Symbol "O"?', a: 'sauerstoff' },
  { q: 'Größter Planet im Sonnensystem?', a: 'jupiter' },
  { q: 'Wie viele Kontinente gibt es?', a: '7' },
  { q: 'Welche Farbe ergibt Blau + Gelb?', a: 'grün' },
  { q: 'In welchem Jahr fiel die Berliner Mauer?', a: '1989' },
];

function renderTtt(board) {
  const cell = (i) => board[i] || (i + 1);
  return `${cell(0)} │ ${cell(1)} │ ${cell(2)}\n──┼───┼──\n${cell(3)} │ ${cell(4)} │ ${cell(5)}\n──┼───┼──\n${cell(6)} │ ${cell(7)} │ ${cell(8)}`;
}
function tttWinner(b) {
  const L = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
  for (const [a, c, d] of L) if (b[a] && b[a] === b[c] && b[a] === b[d]) return b[a];
  return null;
}

// ===========================================================================
//  COMMAND-CONTEXT & SENDE-HELFER
// ===========================================================================
function buildCtx(sock, msg) {
  const from = msg.key.remoteJid;
  const isGroup = from.endsWith('@g.us');
  const senderJid = (isGroup ? (msg.key.participant || from) : from);
  const senderNum = onlyDigits((senderJid || '').split('@')[0].split(':')[0]);
  const fromMe = !!msg.key.fromMe;
  const isOwner = fromMe || config.ownerNumbers.includes(senderNum);

  const textContent =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption || '';

  const reply = (text, extra = {}) => sock.sendMessage(from, { text, ...extra }, { quoted: msg });
  const react = (emoji) => sock.sendMessage(from, { react: { text: emoji, key: msg.key } }).catch(() => {});

  return { sock, msg, from, isGroup, senderJid, senderNum, fromMe, isOwner, textContent, reply, react };
}

// ===========================================================================
//  COMMANDS  (alle direkt hier — keine Plugins)
// ---------------------------------------------------------------------------
//  Jeder Eintrag: { aliases?, owner?, desc, run(ctx, args, text) }
// ===========================================================================
const COMMANDS = {};
function cmd(names, def) {
  const arr = Array.isArray(names) ? names : [names];
  def.name = arr[0];
  for (const n of arr) COMMANDS[n] = def;
}

// ── MENU / HELP ──────────────────────────────────────────────────────────
cmd(['menu', 'help', 'hilfe'], {
  desc: 'Zeigt alle Befehle',
  run: async (ctx) => {
    const p = config.prefix;
    const body = [
      `╭━━━━━━━━━━━━━━━━━━━╮`,
      `   🌸 *${config.botName}* — Neele 🌸`,
      `╰━━━━━━━━━━━━━━━━━━━╯`,
      '',
      `🎨 *KI / Stable Diffusion*`,
      `• ${p}ai <prompt> — Bild generieren`,
      `• ${p}img <prompt> — Alias`,
      `• ${p}set <key> <wert> — Setting ändern`,
      `• ${p}settings — deine Settings`,
      `• ${p}setreset — zurücksetzen`,
      `• ${p}chat <text> — mit Neele plaudern`,
      '',
      `📥 *Downloader*`,
      `• ${p}yt <url|suche> — YouTube Video`,
      `• ${p}ytmp3 <url|suche> — YouTube MP3`,
      `• ${p}play <suche> — Song als MP3`,
      `• ${p}tiktok / ${p}tt <url>`,
      `• ${p}ig <url> — Instagram`,
      `• ${p}fb <url> — Facebook`,
      '',
      `🎮 *Minispiele*`,
      `• ${p}ttt <1-9> — TicTacToe`,
      `• ${p}hangman — Galgenmännchen`,
      `• ${p}guess <1-9> — Zahl, ${p}guess <n> raten`,
      `• ${p}quiz — Quizfrage, ${p}answer <a>`,
      `• ${p}dice [seiten] — Würfeln`,
      '',
      `⚙️ *System*`,
      `• ${p}ping — Latenz`,
      `• ${p}alive — Status`,
      `• ${p}whoami — wer bin ich`,
      config.persona.footer,
    ].join('\n');
    await ctx.reply(body);
  },
});

// ── SYSTEM ─────────────────────────────────────────────────────────────────
cmd('ping', {
  desc: 'Latenz-Check',
  run: async (ctx) => {
    const t0 = Date.now();
    const m = await ctx.reply('🏓 Pong...');
    const ms = Date.now() - t0;
    try { await ctx.sock.sendMessage(ctx.from, { edit: m.key, text: `🏓 *Pong!* ${ms}ms` }); }
    catch (_) { await ctx.reply(`🏓 *Pong!* ${ms}ms`); }
  },
});

cmd('alive', {
  desc: 'Status-Karte',
  run: async (ctx) => {
    const up = process.uptime();
    const h = Math.floor(up / 3600), m = Math.floor((up % 3600) / 60), s = Math.floor(up % 60);
    await ctx.reply(frame('OniSelf · ALIVE', [
      `🟢 Online & bereit`,
      `⏱️ Uptime: ${h}h ${m}m ${s}s`,
      `🎨 SD-Endpoint: ${shorten(resolveSdEndpoint(), 34)}`,
      `🧠 Chat-KI: ${config.chat.geminiKey ? 'aktiv' : 'aus (kein Key)'}`,
      `💾 RAM: ${fmtMB(process.memoryUsage().rss)} MB`,
    ]));
  },
});

cmd('whoami', {
  desc: 'Owner-Check',
  run: async (ctx) => {
    await ctx.reply([
      `👤 *Du bist:* ${ctx.senderNum || '—'}`,
      `${ctx.isOwner ? '👑 Owner — voller Zugriff' : '🙂 Normaler Nutzer'}`,
      `${ctx.fromMe ? '(eigene Nachricht)' : ''}`,
    ].join('\n'));
  },
});

// ── KI / STABLE DIFFUSION ────────────────────────────────────────────────
cmd(['ai', 'img', 'imagine', 'draw', 'sd'], {
  desc: 'Bild generieren (Stable Diffusion)',
  run: async (ctx, args, text) => {
    const prompt = text.trim();
    if (!prompt) return ctx.reply(`🌸 Gib mir einen Prompt~\nz.B. \`${config.prefix}ai cute anime girl, pink hair\``);

    const settings = getUserSettings(ctx.senderNum);
    await ctx.react('🎨');
    const status = await ctx.reply('🎨 *Generiere...* einen Moment 💭');
    const editStatus = (t) => ctx.sock.sendMessage(ctx.from, { edit: status.key, text: t }).catch(() => {});

    try {
      const { buffers, info, endpoint } = await sdGenerate(settings, prompt);
      const seed = info.seed != null ? info.seed : settings.seed;
      const cap = frame('OniSelf AI · RESULT', [
        `📐 ${info.width || settings.width}×${info.height || settings.height}`,
        `⚙️ Steps ${info.steps || settings.steps} · CFG ${info.cfg_scale || settings.cfg_scale}`,
        `🧪 ${info.sampler_name || settings.sampler_name}`,
        `🌱 Seed ${seed}`,
        `✨ Hi-Res ${settings.enable_hr ? `ON ×${settings.hr_scale} (${settings.hr_upscaler})` : 'OFF'}`,
        `🔥 ${shorten(prompt, 80)}`,
      ]);
      try { await ctx.sock.sendMessage(ctx.from, { delete: status.key }); } catch (_) {}
      await ctx.sock.sendMessage(ctx.from, { image: buffers[0], caption: cap }, { quoted: ctx.msg });
      await ctx.react('✅');
    } catch (err) {
      log.warn({ err: err.message }, 'SD-Generierung fehlgeschlagen');
      // Online-Fallback?
      if (config.sd.pollinationsFallback) {
        try {
          await editStatus('🌐 GPU offline — Online-Fallback...');
          const buf = await pollinationsFallback(`${prompt}, anime, masterpiece`, settings.width, settings.height);
          try { await ctx.sock.sendMessage(ctx.from, { delete: status.key }); } catch (_) {}
          await ctx.sock.sendMessage(ctx.from, {
            image: buf,
            caption: `🌸 *Online-Fallback* (lokale GPU war offline)\n_${shorten(prompt, 70)}_\n${config.persona.footer}`,
          }, { quoted: ctx.msg });
          await ctx.react('✨');
          return;
        } catch (fe) { log.warn({ err: fe.message }, 'Pollinations-Fallback fehlgeschlagen'); }
      }
      await ctx.react('❌');
      await editStatus(`❌ ${err.message}`);
    }
  },
});

cmd(['set', 'aiset'], {
  desc: 'AI-Setting ändern: .set <key> <wert>',
  run: async (ctx, args) => {
    const p = config.prefix;
    if (!args.length) {
      return ctx.reply(frame('OniSelf AI · SET', [
        `✏️ \`${p}set <key> <wert>\``,
        '',
        `Keys: hr, scale, upscaler, steps, size,`,
        `cfg, sampler, seed, neg, denoise, hrsteps, faces`,
        '',
        `Beispiele:`,
        `• ${p}set hr on`,
        `• ${p}set scale 2`,
        `• ${p}set steps 30`,
        `• ${p}set size 768x1152`,
        `• ${p}set upscaler R-ESRGAN 4x+ Anime6B`,
        '',
        `📋 ${p}settings zeigt alle`,
      ]));
    }

    const rawKey = args[0].toLowerCase();

    // Sonderfall: size = WxH in einem Befehl
    if (['size', 'aisize', 'res'].includes(rawKey)) {
      const m = (args[1] || '').match(/^(\d{3,4})[x×](\d{3,4})$/i);
      if (!m) return ctx.reply(`❌ Format: \`${p}set size 768x1152\``);
      const w = Math.max(256, Math.min(2048, parseInt(m[1])));
      const h = Math.max(256, Math.min(2048, parseInt(m[2])));
      setUserSetting(ctx.senderNum, 'width', w);
      setUserSetting(ctx.senderNum, 'height', h);
      return ctx.reply(`✅ Größe: *${w}×${h}*`);
    }

    const key = SETTING_ALIASES[rawKey];
    if (!key) return ctx.reply(`❌ Unbekanntes Setting "${rawKey}". \`${p}set\` zeigt alle.`);
    const rawVal = args.slice(1).join(' ').trim();
    if (rawVal === '') {
      const cur = getUserSettings(ctx.senderNum)[key];
      return ctx.reply(`⚙️ *${SETTABLE[key].label}* = \`${cur}\`\n✏️ ${p}set ${rawKey} <wert>`);
    }
    const res = coerceSetting(key, rawVal);
    if (!res.ok) return ctx.reply(`❌ ${res.error}`);
    setUserSetting(ctx.senderNum, key, res.value);
    await ctx.reply(`✅ *${SETTABLE[key].label}*: \`${res.value}\``);
  },
});

cmd(['settings', 'aisettings'], {
  desc: 'Zeigt deine AI-Settings',
  run: async (ctx) => {
    const s = getUserSettings(ctx.senderNum);
    await ctx.reply(frame('OniSelf AI · SETTINGS', [
      `⚙️ Steps: ${s.steps} · CFG: ${s.cfg_scale}`,
      `📐 Größe: ${s.width}×${s.height}`,
      `🧪 Sampler: ${s.sampler_name}`,
      `🌱 Seed: ${s.seed === -1 ? 'random' : s.seed}`,
      `✨ Hi-Res: ${s.enable_hr ? 'ON' : 'OFF'}`,
      `📐 HR-Scale: ${s.hr_scale} · Steps: ${s.hr_second_pass_steps}`,
      `🔍 Upscaler: ${s.hr_upscaler}`,
      `📏 Denoise: ${s.denoising_strength}`,
      `👤 Restore Faces: ${s.restore_faces ? 'ON' : 'OFF'}`,
      `🚫 Negativ: ${shorten(s.negative_prompt, 40)}`,
      '',
      `✏️ Ändern: ${config.prefix}set <key> <wert>`,
    ]));
  },
});

cmd(['setreset', 'aireset'], {
  desc: 'AI-Settings zurücksetzen',
  run: async (ctx) => { resetUserSettings(ctx.senderNum); await ctx.reply('✅ Settings auf Standard zurückgesetzt 🌸'); },
});

cmd(['chat', 'ask', 'neele'], {
  desc: 'Mit Neele plaudern (KI)',
  run: async (ctx, args, text) => {
    if (!text.trim()) return ctx.reply(`🌸 Frag mich was~ \`${config.prefix}chat wie geht's dir?\``);
    await ctx.react('🧠');
    const name = ctx.msg.pushName || 'du';
    const answer = await neeleChat(ctx.from, text.trim(), name);
    await ctx.reply(answer);
  },
});

// ── DOWNLOADER ───────────────────────────────────────────────────────────
async function runDownload(ctx, queryOrUrl, type) {
  if (!queryOrUrl) return ctx.reply('🌸 Gib mir einen Link oder Suchbegriff~');
  await ctx.react('📥');
  const status = await ctx.reply('📥 *Suche & lade...* 💭');
  const editStatus = (t) => ctx.sock.sendMessage(ctx.from, { edit: status.key, text: t }).catch(() => {});

  try {
    const meta = await fetchMediaMeta(queryOrUrl, type);

    // TikTok-Slideshow (mehrere Bilder)
    if (meta.images && meta.images.length && !meta.video) {
      try { await ctx.sock.sendMessage(ctx.from, { delete: status.key }); } catch (_) {}
      for (let i = 0; i < Math.min(meta.images.length, 15); i++) {
        const buf = await downloadBuffer(meta.images[i]);
        await ctx.sock.sendMessage(ctx.from, { image: buf, caption: i === 0 ? `🌸 *${meta.title || 'Slideshow'}* (${meta.images.length} Bilder)` : undefined }, { quoted: i === 0 ? ctx.msg : undefined });
        await sleep(300);
      }
      await ctx.react('✅');
      return;
    }

    // Audio gewünscht?
    if (type === 'audio' && meta.audio) {
      const buf = await downloadBuffer(meta.audio);
      if (buf.length > config.download.maxMB * 1024 * 1024) throw new Error(`Datei zu groß (${fmtMB(buf.length)}MB > ${config.download.maxMB}MB).`);
      try { await ctx.sock.sendMessage(ctx.from, { delete: status.key }); } catch (_) {}
      await ctx.sock.sendMessage(ctx.from, {
        audio: buf, mimetype: 'audio/mpeg', ptt: false,
        fileName: `${(meta.title || 'audio').replace(/[^a-zA-Z0-9-_ ]/g, '')}.mp3`,
      }, { quoted: ctx.msg });
      await ctx.react('✅');
      return;
    }

    // Sonst Video / Bild
    const mediaUrl = meta.video || meta.image || meta.audio;
    if (!mediaUrl) throw new Error('Kein abspielbares Medium gefunden.');
    const buf = await downloadBuffer(mediaUrl);
    if (buf.length > config.download.maxMB * 1024 * 1024) throw new Error(`Datei zu groß (${fmtMB(buf.length)}MB > ${config.download.maxMB}MB).`);
    try { await ctx.sock.sendMessage(ctx.from, { delete: status.key }); } catch (_) {}

    const caption = `🌸 *${shorten(meta.title || meta.platform || 'Download', 60)}*\n${config.persona.footer}`;
    if (meta.video) await ctx.sock.sendMessage(ctx.from, { video: buf, caption }, { quoted: ctx.msg });
    else if (meta.image) await ctx.sock.sendMessage(ctx.from, { image: buf, caption }, { quoted: ctx.msg });
    else await ctx.sock.sendMessage(ctx.from, { audio: buf, mimetype: 'audio/mpeg' }, { quoted: ctx.msg });
    await ctx.react('✅');
  } catch (err) {
    log.warn({ err: err.message, queryOrUrl }, 'Download fehlgeschlagen');
    await ctx.react('❌');
    await editStatus(`❌ ${err.message}`);
  }
}

cmd(['yt', 'youtube', 'ytv'], { desc: 'YouTube-Video', run: (ctx, a, t) => runDownload(ctx, t.trim(), 'video') });
cmd(['ytmp3', 'yta', 'mp3'], { desc: 'YouTube als MP3', run: (ctx, a, t) => runDownload(ctx, t.trim(), 'audio') });
cmd(['play', 'song', 'musik'], { desc: 'Song suchen & als MP3', run: (ctx, a, t) => runDownload(ctx, t.trim(), 'audio') });
cmd(['tiktok', 'tt'], { desc: 'TikTok', run: (ctx, a, t) => runDownload(ctx, t.trim(), 'video') });
cmd(['ig', 'insta', 'instagram'], { desc: 'Instagram', run: (ctx, a, t) => runDownload(ctx, t.trim(), 'auto') });
cmd(['fb', 'facebook'], { desc: 'Facebook', run: (ctx, a, t) => runDownload(ctx, t.trim(), 'video') });
cmd(['dl', 'download'], {
  desc: 'Auto-erkennen & laden',
  run: (ctx, a, t) => {
    const url = t.trim();
    if (!/^https?:\/\//i.test(url)) return ctx.reply('🌸 Schick mir einen Link~');
    return runDownload(ctx, url, 'auto');
  },
});

// ── MINISPIELE ─────────────────────────────────────────────────────────────
cmd(['ttt', 'tictactoe'], {
  desc: 'TicTacToe gegen den Bot',
  run: async (ctx, args) => {
    const p = config.prefix;
    let g = games.ttt.get(ctx.from);
    if (!g) { g = { board: Array(9).fill(null) }; games.ttt.set(ctx.from, g); return ctx.reply(`🎮 *TicTacToe* gestartet! Du bist ❌\n\n${renderTtt(g.board)}\n\nZieh mit \`${p}ttt <1-9>\``); }

    const pos = parseInt(args[0], 10) - 1;
    if (isNaN(pos) || pos < 0 || pos > 8) return ctx.reply(`🎮 Zieh mit \`${p}ttt <1-9>\`\n\n${renderTtt(g.board)}`);
    if (g.board[pos]) return ctx.reply(`❌ Feld ${pos + 1} ist belegt.\n\n${renderTtt(g.board)}`);

    g.board[pos] = '❌';
    let win = tttWinner(g.board);
    if (!win && g.board.some((c) => !c)) {
      // Bot zieht: gewinnen > blocken > Mitte > zufällig
      const empty = g.board.map((c, i) => (c ? null : i)).filter((i) => i != null);
      let move = null;
      const tryWin = (sym) => { for (const i of empty) { const b = [...g.board]; b[i] = sym; if (tttWinner(b) === sym) return i; } return null; };
      move = tryWin('⭕') ?? tryWin('❌') ?? (g.board[4] ? null : 4) ?? empty[Math.floor(Math.random() * empty.length)];
      g.board[move] = '⭕';
      win = tttWinner(g.board);
    }

    if (win) {
      games.ttt.delete(ctx.from);
      return ctx.reply(`${renderTtt(g.board)}\n\n${win === '❌' ? '🎉 *Du gewinnst!*' : '🤖 *Bot gewinnt!*'}`);
    }
    if (!g.board.some((c) => !c)) {
      games.ttt.delete(ctx.from);
      return ctx.reply(`${renderTtt(g.board)}\n\n🤝 *Unentschieden!*`);
    }
    await ctx.reply(`${renderTtt(g.board)}\n\nDu bist dran — \`${p}ttt <1-9>\``);
  },
});

cmd(['hangman', 'galgen'], {
  desc: 'Galgenmännchen — .hangman <buchstabe>',
  run: async (ctx, args) => {
    const p = config.prefix;
    let g = games.hangman.get(ctx.from);
    const render = (gg) => {
      const masked = gg.word.split('').map((c) => (gg.guessed.has(c) ? c : '_')).join(' ');
      return `🎯 *Galgenmännchen*\n\n\`${masked}\`\n\n❌ Fehler: ${gg.wrong}/${gg.max}\n🔤 Geraten: ${[...gg.guessed].join(', ') || '—'}`;
    };
    if (!g) {
      const word = HANGMAN_WORDS[Math.floor(Math.random() * HANGMAN_WORDS.length)];
      g = { word, guessed: new Set(), wrong: 0, max: 6 };
      games.hangman.set(ctx.from, g);
      return ctx.reply(`${render(g)}\n\nRate mit \`${p}hangman <buchstabe>\``);
    }
    const letter = (args[0] || '').toLowerCase().trim();
    if (!letter || letter.length !== 1 || !/[a-zäöüß]/.test(letter)) return ctx.reply(`${render(g)}\n\nGib EINEN Buchstaben: \`${p}hangman a\``);
    if (g.guessed.has(letter)) return ctx.reply(`🌸 "${letter}" hattest du schon.\n\n${render(g)}`);
    g.guessed.add(letter);
    if (!g.word.includes(letter)) g.wrong++;

    if (g.word.split('').every((c) => g.guessed.has(c))) {
      games.hangman.delete(ctx.from);
      return ctx.reply(`🎉 *Gewonnen!* Das Wort war *${g.word}* 💖`);
    }
    if (g.wrong >= g.max) {
      games.hangman.delete(ctx.from);
      return ctx.reply(`💀 *Verloren!* Das Wort war *${g.word}*`);
    }
    await ctx.reply(render(g));
  },
});

cmd(['quiz', 'trivia'], {
  desc: 'Quizfrage — antworte mit .answer',
  run: async (ctx) => {
    const q = QUIZ[Math.floor(Math.random() * QUIZ.length)];
    games.quiz.set(ctx.from, q);
    await ctx.reply(`🧠 *Quiz!*\n\n${q.q}\n\nAntworte mit \`${config.prefix}answer <deine antwort>\``);
  },
});
cmd(['answer', 'antwort'], {
  desc: 'Quiz-Antwort',
  run: async (ctx, args, text) => {
    const q = games.quiz.get(ctx.from);
    if (!q) return ctx.reply(`🌸 Kein Quiz aktiv. Starte mit \`${config.prefix}quiz\``);
    const given = text.trim().toLowerCase();
    if (!given) return ctx.reply('🌸 Was ist deine Antwort?');
    games.quiz.delete(ctx.from);
    if (given === q.a || given.includes(q.a)) await ctx.reply(`🎉 *Richtig!* (${q.a}) 💖`);
    else await ctx.reply(`❌ Leider falsch. Richtig wäre: *${q.a}*`);
  },
});

cmd(['guess', 'raten'], {
  desc: 'Zahlenraten 1-100',
  run: async (ctx, args) => {
    const p = config.prefix;
    let g = games.guess.get(ctx.from);
    if (!g) { g = { number: Math.floor(Math.random() * 100) + 1, tries: 0 }; games.guess.set(ctx.from, g); return ctx.reply(`🔢 *Zahlenraten!* Ich denke an eine Zahl 1-100.\n\nRate mit \`${p}guess <zahl>\``); }
    const n = parseInt(args[0], 10);
    if (isNaN(n)) return ctx.reply(`🔢 Rate eine Zahl: \`${p}guess 50\``);
    g.tries++;
    if (n === g.number) { games.guess.delete(ctx.from); return ctx.reply(`🎉 *Richtig!* Die Zahl war *${g.number}* — in ${g.tries} Versuchen! 💖`); }
    await ctx.reply(n < g.number ? `⬆️ *Höher* als ${n}` : `⬇️ *Tiefer* als ${n}`);
  },
});

cmd(['dice', 'würfel', 'roll'], {
  desc: 'Würfeln',
  run: async (ctx, args) => {
    const sides = Math.max(2, Math.min(1000, parseInt(args[0], 10) || 6));
    const r = Math.floor(Math.random() * sides) + 1;
    await ctx.react('🎲');
    await ctx.reply(`🎲 Du würfelst (1-${sides}): *${r}*`);
  },
});

// ===========================================================================
//  MESSAGE-HANDLER  (Parsing + Routing + Owner-Gate)
// ===========================================================================
async function handleMessage(sock, msg) {
  try {
    if (!msg.message || !msg.key) return;
    // Status-Broadcasts ignorieren
    if (msg.key.remoteJid === 'status@broadcast') return;

    const ctx = buildCtx(sock, msg);
    const raw = (ctx.textContent || '').trim();
    if (!raw) return;
    if (!raw.startsWith(config.prefix)) return;       // nur Befehle

    const withoutPrefix = raw.slice(config.prefix.length).trim();
    const parts = withoutPrefix.split(/\s+/);
    const name = (parts[0] || '').toLowerCase();
    const args = parts.slice(1);
    const text = withoutPrefix.slice(parts[0].length).trim();

    const command = COMMANDS[name];
    if (!command) return;

    // ── Owner-Gate ──
    if (config.ownerOnly && !ctx.isOwner) return;     // Selfbot-Lockdown
    if (command.owner && !ctx.isOwner) { await ctx.reply('🔒 Nur der Owner darf das.'); return; }

    log.info({ cmd: name, from: ctx.from, owner: ctx.isOwner }, '→ Befehl');
    await command.run(ctx, args, text);
  } catch (err) {
    log.error({ err: err.message }, 'Fehler im Message-Handler (abgefangen)');
    try { await sock.sendMessage(msg.key.remoteJid, { text: `❌ Interner Fehler: ${shorten(err.message, 100)}` }, { quoted: msg }); } catch (_) {}
  }
}

// ===========================================================================
//  HEARTBEAT (optional)
// ===========================================================================
let heartbeatTimer = null;
function startHeartbeat() {
  if (!config.heartbeat.url) return;
  const tick = async () => {
    try { await axios.get(config.heartbeat.url, { timeout: 8000 }); log.debug('Heartbeat ✓'); }
    catch (e) { log.debug({ err: e.message }, 'Heartbeat fehlgeschlagen'); }
  };
  tick();
  heartbeatTimer = setInterval(tick, Math.max(15, config.heartbeat.intervalSec) * 1000);
  log.info({ url: config.heartbeat.url, every: config.heartbeat.intervalSec + 's' }, '💓 Heartbeat aktiv');
}

// ===========================================================================
//  VERBINDUNG  (Baileys + Auth + Reconnect-Backoff)
// ===========================================================================
let reconnectAttempts = 0;

async function connect() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,            // wir drucken den QR selbst (s.u.)
    browser: Browsers.macOS('Desktop'),
    logger: pino({ level: 'silent' }),   // Baileys-Eigenlog stumm — wir loggen selbst
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });

  // ── Pairing-Code statt QR (wenn Nummer gesetzt & noch nicht registriert) ──
  if (config.pairNumber && !sock.authState.creds.registered) {
    await sleep(2000);
    try {
      const code = await sock.requestPairingCode(config.pairNumber);
      log.info(`\n\n🔗  PAIRING-CODE für +${config.pairNumber}:  ${code}\n    WhatsApp → Verknüpfte Geräte → "Mit Nummer verknüpfen"\n`);
    } catch (e) {
      log.error({ err: e.message }, 'Pairing-Code konnte nicht angefordert werden — nutze QR.');
    }
  }

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !config.pairNumber) {
      log.info('📱 QR-Code scannen (WhatsApp → Verknüpfte Geräte → Gerät verknüpfen):');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      reconnectAttempts = 0;
      const me = sock.user?.id?.split(':')[0] || '?';
      log.info(`\n🌸 ${config.botName} ist ONLINE als +${onlyDigits(me)} — Neele wartet auf Befehle 💖\n`);
      startHeartbeat();
    }

    if (connection === 'close') {
      if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
      const code = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output?.statusCode
        : lastDisconnect?.error?.output?.statusCode;

      if (code === DisconnectReason.loggedOut) {
        log.error('🚪 Ausgeloggt (loggedOut). Lösche den `session/`-Ordner und pair neu.');
        return; // KEIN automatischer Reconnect — Re-Pairing nötig
      }

      // Exponentielles Backoff (max 30s)
      reconnectAttempts++;
      const delay = Math.min(30000, 2000 * reconnectAttempts);
      log.warn({ code, attempt: reconnectAttempts }, `Verbindung getrennt — reconnect in ${delay / 1000}s…`);
      setTimeout(() => connect().catch((e) => log.error({ err: e.message }, 'Reconnect fehlgeschlagen')), delay);
    }
  });

  // ── Eingehende Nachrichten ──
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      await handleMessage(sock, msg);   // jeder Handler ist selbst try/catch-gekapselt
    }
  });

  return sock;
}

// ===========================================================================
//  START
// ---------------------------------------------------------------------------
//  Nur starten, wenn die Datei DIREKT ausgeführt wird (`node oniself.js`).
//  Bei `require('./oniself.js')` (z.B. Tests) wird NICHT verbunden — dann sind
//  die unten exportierten Funktionen isoliert nutzbar.
// ===========================================================================
function main() {
  const l = [
    '╭──────────────────────────────────────────╮',
    '│  🌸 OniSelf — WhatsApp Selfbot (Neele)     │',
    '│     Downloader · SD-KI · Minispiele        │',
    '╰──────────────────────────────────────────╯',
  ];
  for (const x of l) process.stdout.write(x + '\n');

  if (!config.ownerNumbers.length) {
    log.warn('⚠️  Keine OWNER_NUMBER in der .env gesetzt. Owner-only Befehle sind für niemanden freigeschaltet (außer eigene Nachrichten).');
  }

  connect().catch((err) => {
    log.fatal({ err: err.message }, 'Start fehlgeschlagen.');
    process.exit(1);
  });
}

if (require.main === module) main();

// Exporte für Tests / Wiederverwendung (Auto-Start bleibt aus bei require).
module.exports = {
  buildSdPayload, getUserSettings, setUserSetting, resetUserSettings,
  coerceSetting, SETTABLE, SETTING_ALIASES, resolveSdEndpoint,
  detectPlatform, COMMANDS, config,
};
