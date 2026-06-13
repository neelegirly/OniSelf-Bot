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
// Bevorzugt der private @neelegirly-Fork (falls installiert — optionalDependency),
// sonst das öffentliche Upstream-Paket "baileys". Gleiche API, 1:1 austauschbar.
// So nutzt der Bot auf dem Original-Host den Fork, bleibt aber für Fremde, die
// nur das öffentliche Paket bekommen, voll lauffähig. Siehe ANALYSE.md.
let baileys, baileysImpl;
try {
  baileys = require('@neelegirly/baileys');
  baileysImpl = '@neelegirly/baileys (Fork)';
} catch (_) {
  baileys = require('baileys');
  baileysImpl = 'baileys (public)';
}
const makeWASocket = baileys.default || baileys.makeWASocket;
const {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers,
  downloadContentFromMessage,
} = baileys;

// ffmpeg (für Sticker / Audio-Konvertierung) — bevorzugt das mitgelieferte
// Binary von @ffmpeg-installer, sonst system-ffmpeg im PATH.
const { execFile } = require('child_process');
let FFMPEG = 'ffmpeg';
try { FFMPEG = require('@ffmpeg-installer/ffmpeg').path; } catch (_) { /* system ffmpeg */ }

// ===========================================================================
//  LOGGER
// ===========================================================================
const log = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } },
}).child({ mod: 'OniSelf' });

const SESSION_DIR = path.join(__dirname, 'session');
const DATA_DIR = path.join(__dirname, 'data');
const TMP_DIR = path.join(__dirname, 'tmp');
for (const d of [SESSION_DIR, DATA_DIR, TMP_DIR]) {
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
//  DOWNLOADER
// ---------------------------------------------------------------------------
//  Bevorzugt der private Fork @neelegirly/downloader (falls installiert —
//  optionalDependency), danach die öffentlichen, keylosen Fallback-APIs. So
//  nutzt der Original-Host den Fork, Fremde bekommen trotzdem funktionierende
//  Downloads über die öffentlichen Endpoints.
// ===========================================================================
const DL_APIS = {
  nayan: 'https://nayan-video-downloader.vercel.app',
  siputzx: 'https://api.siputzx.my.id',
  bk9: 'https://api.bk9.site',
};

// Optionaler privater Downloader-Fork
let neeleDl = null;
try { neeleDl = require('@neelegirly/downloader'); } catch (_) { /* nicht installiert → öffentliche APIs */ }

// Extrahiert eine brauchbare URL aus String | {url|hd|sd|download|link} | Array
function pickUrl(v) {
  if (!v) return undefined;
  if (typeof v === 'string') return /^https?:\/\//i.test(v) ? v : undefined;
  if (Array.isArray(v)) { for (const x of v) { const u = pickUrl(x); if (u) return u; } return undefined; }
  if (typeof v === 'object') return pickUrl(v.url || v.hd || v.sd || v.download || v.link || v.high || v.low);
  return undefined;
}
// Normalisiert die (variable) Fork-Antwort auf unser Meta-Format. Liefert null,
// wenn nichts Brauchbares drin ist → Aufrufer fällt auf die öffentlichen APIs.
function normalizeNeele(raw, platform) {
  if (!raw) return null;
  const d = raw.data || raw.result || raw;
  const video = pickUrl(d.video) || pickUrl(d.hdvideo) || pickUrl(d.hd) || pickUrl(d.high) || pickUrl(d.url_hd);
  const audio = pickUrl(d.audio) || pickUrl(d.music) || pickUrl(d.mp3);
  const images = Array.isArray(d.images) ? d.images.map(pickUrl).filter(Boolean) : [];
  const image = pickUrl(d.image) || pickUrl(d.thumbnail) || pickUrl(d.thumb) || images[0];
  if (!video && !audio && !image && !images.length) return null;
  return { title: d.title || d.name || platform, video, audio, image, images, platform };
}
// Baut eine "tryApis"-taugliche Fork-Funktion (oder null, wenn Fork/Methode fehlt).
function neeleAttempt(method, arg, platform) {
  if (!neeleDl || typeof neeleDl[method] !== 'function') return null;
  return async () => {
    const r = normalizeNeele(await neeleDl[method](arg), platform);
    if (r) return r;
    throw new Error(`@neelegirly/downloader ${method}`);
  };
}

function detectPlatform(url) {
  const u = String(url).toLowerCase();
  if (/youtube\.com|youtu\.be/.test(u)) return 'youtube';
  if (/tiktok\.com/.test(u)) return 'tiktok';
  if (/instagram\.com/.test(u)) return 'instagram';
  if (/facebook\.com|fb\.watch|fb\.com/.test(u)) return 'facebook';
  if (/twitter\.com|x\.com/.test(u)) return 'twitter';
  if (/pinterest\.|pin\.it/.test(u)) return 'pinterest';
  if (/reddit\.com|redd\.it/.test(u)) return 'reddit';
  if (/threads\.net/.test(u)) return 'threads';
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
    const fork = neeleAttempt('ytdown', target, platform);
    if (fork) apis.unshift(fork);          // Fork bevorzugt
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
    const fork = neeleAttempt('tikdown', resolved, platform);
    if (fork) apis.unshift(fork);          // Fork bevorzugt
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
    const fork = neeleAttempt('instagram', queryOrUrl, platform);
    if (fork) apis.unshift(fork);          // Fork bevorzugt
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
    const fball = neeleAttempt('alldown', queryOrUrl, platform);
    const fb2 = neeleAttempt('fbdown2', queryOrUrl, platform);
    if (fball) apis.unshift(fball);
    if (fb2) apis.unshift(fb2);            // fbdown2 zuerst, dann alldown, dann public
    return await tryApis(apis);
  }

  // ── Twitter / X · Pinterest · Reddit · Threads ──
  // Fork-Methode bevorzugt, dann ein öffentlicher siputzx-Endpoint. Generische
  // Extraktion, da die Antwortformen variieren — schlägt sauber fehl, wenn nix.
  const GENERIC = {
    twitter:   { fork: 'twitterdown', api: 'twitter' },
    pinterest: { fork: 'pintarest',   api: 'pinterest' },
    reddit:    { fork: 'ndown',       api: 'reddit' },
    threads:   { fork: 'threads',     api: 'threads' },
  };
  if (GENERIC[platform]) {
    const g = GENERIC[platform];
    const apis = [
      async () => {
        const r = await axios.get(`${DL_APIS.siputzx}/api/d/${g.api}?url=${encodeURIComponent(queryOrUrl)}`, { timeout: 25000, validateStatus: () => true });
        const data = r.data && (r.data.data || r.data.result || r.data);
        const norm = normalizeNeele({ data }, platform);
        if (norm) return norm;
        throw new Error(`siputzx ${g.api}`);
      },
    ];
    const fork = neeleAttempt(g.fork, queryOrUrl, platform);
    if (fork) apis.unshift(fork);
    return await tryApis(apis);
  }

  throw new Error('Plattform nicht erkannt. Unterstützt: YouTube, TikTok, Instagram, Facebook, Twitter/X, Pinterest, Reddit, Threads.');
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
      `${p}ai · ${p}img <prompt> · ${p}upscale (reply Bild)`,
      `${p}set <key> <wert> · ${p}settings · ${p}setreset`,
      `${p}chat <text> — mit Neele plaudern`,
      '',
      `📥 *Downloader*`,
      `${p}yt · ${p}ytmp3 · ${p}play · ${p}tiktok · ${p}ig · ${p}fb`,
      `${p}twitter · ${p}pinterest · ${p}reddit · ${p}threads · ${p}dl`,
      '',
      `🎴 *Sticker & Media*`,
      `${p}sticker (${p}s) · ${p}toimg · ${p}tomp3 · ${p}vv`,
      '',
      `👥 *Gruppe*`,
      `${p}tagall · ${p}kick · ${p}promote · ${p}demote · ${p}add`,
      `${p}grouplink · ${p}setname · ${p}setdesc · ${p}mute · ${p}unmute · ${p}groupinfo`,
      '',
      `🛠️ *Utility*`,
      `${p}tr <lang> <text> · ${p}tts · ${p}qr · ${p}calc · ${p}weather`,
      `${p}wiki · ${p}urban · ${p}ip · ${p}short · ${p}jid`,
      '',
      `🎉 *Fun*`,
      `${p}8ball · ${p}flip · ${p}rps · ${p}joke · ${p}fact · ${p}ship · ${p}rate`,
      `${p}cat · ${p}dog · ${p}github · ${p}pokemon · ${p}crypto · ${p}fx · ${p}color`,
      `${p}lyrics · ${p}password · ${p}hug · ${p}pat · ${p}kiss · ${p}slap …`,
      '',
      `🎮 *Minispiele*`,
      `${p}ttt · ${p}hangman · ${p}quiz/${p}answer · ${p}guess · ${p}dice`,
      '',
      `⚙️ *System*`,
      `${p}ping · ${p}alive · ${p}whoami` + (ctx.isOwner ? ` · ${p}block · ${p}restart` : ''),
      '',
      `_${Object.keys(COMMANDS).length} Befehle aktiv_`,
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
      `📦 Lib: ${baileysImpl}`,
      `📥 DL: ${neeleDl ? 'neelegirly-Fork' : 'public APIs'}`,
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
//  MEDIA-HELFER  (Sticker / Konvertierung / zitierte Medien)
// ===========================================================================
function tmpFile(ext) { return path.join(TMP_DIR, `${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`); }

function ffmpegRun(args) {
  return new Promise((resolve, reject) => {
    execFile(FFMPEG, args, { timeout: 120000, maxBuffer: 1024 * 1024 * 64 }, (err) => (err ? reject(err) : resolve()));
  });
}

// Findet Medien im aktuellen ODER zitierten Message-Node → { node, type } | null
function findMedia(msg) {
  const scan = (mm) => {
    if (!mm) return null;
    if (mm.imageMessage) return { node: mm.imageMessage, type: 'image' };
    if (mm.videoMessage) return { node: mm.videoMessage, type: 'video' };
    if (mm.stickerMessage) return { node: mm.stickerMessage, type: 'sticker' };
    if (mm.audioMessage) return { node: mm.audioMessage, type: 'audio' };
    if (mm.documentMessage) return { node: mm.documentMessage, type: 'document' };
    if (mm.viewOnceMessageV2?.message) return scan(mm.viewOnceMessageV2.message);
    if (mm.viewOnceMessage?.message) return scan(mm.viewOnceMessage.message);
    return null;
  };
  const m = msg.message || {};
  const quoted = m.extendedTextMessage?.contextInfo?.quotedMessage;
  return scan(quoted) || scan(m);
}

async function mediaToBuffer(node, type) {
  const stream = await downloadContentFromMessage(node, type);
  let buf = Buffer.alloc(0);
  for await (const chunk of stream) buf = Buffer.concat([buf, chunk]);
  return buf;
}

async function gifBufToMp4(buf) {
  const inF = tmpFile('gif'), outF = tmpFile('mp4');
  fs.writeFileSync(inF, buf);
  await ffmpegRun(['-y', '-i', inF, '-movflags', 'faststart', '-pix_fmt', 'yuv420p', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', outF]);
  const out = fs.readFileSync(outF);
  try { fs.unlinkSync(inF); fs.unlinkSync(outF); } catch (_) {}
  return out;
}

// Erwähnte / zitierte JIDs (für kick, reactions …)
function mentionedOrQuoted(ctx) {
  const ci = ctx.msg.message?.extendedTextMessage?.contextInfo;
  if (ci?.mentionedJid?.length) return ci.mentionedJid;
  if (ci?.participant) return [ci.participant];
  return [];
}
function getQuotedText(ctx) {
  const q = ctx.msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
  if (!q) return '';
  return q.conversation || q.extendedTextMessage?.text || q.imageMessage?.caption || q.videoMessage?.caption || '';
}
async function isGroupAdmin(ctx, jid) {
  try {
    const meta = await ctx.sock.groupMetadata(ctx.from);
    const p = meta.participants.find((x) => x.id === (jid || ctx.senderJid));
    return !!p && (p.admin === 'admin' || p.admin === 'superadmin');
  } catch (_) { return false; }
}

// ===========================================================================
//  STICKER & MEDIA-KONVERTIERUNG
// ===========================================================================
cmd(['sticker', 's', 'stick'], {
  desc: 'Bild/Video → Sticker',
  run: async (ctx) => {
    const media = findMedia(ctx.msg);
    if (!media || (media.type !== 'image' && media.type !== 'video')) {
      return ctx.reply(`🌸 Antworte auf ein Bild/kurzes Video mit \`${config.prefix}sticker\` (oder sende es direkt mit \`.s\` als Caption).`);
    }
    await ctx.react('🎴');
    const inF = tmpFile(media.type === 'video' ? 'mp4' : 'jpg');
    const outF = tmpFile('webp');
    try {
      fs.writeFileSync(inF, await mediaToBuffer(media.node, media.type));
      const pad = 'scale=512:512:force_original_aspect_ratio=decrease,format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=#00000000';
      if (media.type === 'image') {
        await ffmpegRun(['-y', '-i', inF, '-vf', pad, '-f', 'webp', '-quality', '80', outF]);
      } else {
        await ffmpegRun(['-y', '-i', inF, '-t', '6', '-vf', `${pad.replace('format=rgba,', 'format=rgba,fps=15,')}`, '-loop', '0', '-an', '-vcodec', 'libwebp', '-preset', 'default', '-q:v', '55', outF]);
      }
      const webp = fs.readFileSync(outF);
      if (webp.length > 1024 * 1024) return ctx.reply('❌ Sticker zu groß — nimm ein kürzeres/kleineres Video.');
      await ctx.sock.sendMessage(ctx.from, { sticker: webp }, { quoted: ctx.msg });
      await ctx.react('✅');
    } catch (e) {
      log.warn({ err: e.message }, 'sticker');
      await ctx.react('❌');
      await ctx.reply('❌ Sticker-Erstellung fehlgeschlagen (ffmpeg).');
    } finally { try { fs.unlinkSync(inF); } catch (_) {} try { fs.unlinkSync(outF); } catch (_) {} }
  },
});

cmd(['toimg', 'toimage'], {
  desc: 'Sticker → Bild',
  run: async (ctx) => {
    const media = findMedia(ctx.msg);
    if (!media || media.type !== 'sticker') return ctx.reply(`🌸 Antworte auf einen Sticker mit \`${config.prefix}toimg\`.`);
    await ctx.react('🖼️');
    const inF = tmpFile('webp'), outF = tmpFile('png');
    try {
      fs.writeFileSync(inF, await mediaToBuffer(media.node, 'sticker'));
      await ffmpegRun(['-y', '-i', inF, outF]);
      await ctx.sock.sendMessage(ctx.from, { image: fs.readFileSync(outF), caption: '🌸 Sticker → Bild' }, { quoted: ctx.msg });
      await ctx.react('✅');
    } catch (e) { await ctx.react('❌'); await ctx.reply('❌ Konvertierung fehlgeschlagen.'); }
    finally { try { fs.unlinkSync(inF); } catch (_) {} try { fs.unlinkSync(outF); } catch (_) {} }
  },
});

cmd(['tomp3', 'toaudio'], {
  desc: 'Video → MP3',
  run: async (ctx) => {
    const media = findMedia(ctx.msg);
    if (!media || (media.type !== 'video' && media.type !== 'audio')) return ctx.reply(`🌸 Antworte auf ein Video mit \`${config.prefix}tomp3\`.`);
    await ctx.react('🎵');
    const inF = tmpFile('mp4'), outF = tmpFile('mp3');
    try {
      fs.writeFileSync(inF, await mediaToBuffer(media.node, media.type));
      await ffmpegRun(['-y', '-i', inF, '-vn', '-c:a', 'libmp3lame', '-b:a', '192k', outF]);
      await ctx.sock.sendMessage(ctx.from, { audio: fs.readFileSync(outF), mimetype: 'audio/mpeg' }, { quoted: ctx.msg });
      await ctx.react('✅');
    } catch (e) { await ctx.react('❌'); await ctx.reply('❌ Konvertierung fehlgeschlagen.'); }
    finally { try { fs.unlinkSync(inF); } catch (_) {} try { fs.unlinkSync(outF); } catch (_) {} }
  },
});

cmd(['vv', 'reveal'], {
  owner: true,
  desc: 'View-Once enthüllen',
  run: async (ctx) => {
    const media = findMedia(ctx.msg);
    if (!media) return ctx.reply(`🌸 Antworte auf eine View-Once-Nachricht mit \`${config.prefix}vv\`.`);
    const buf = await mediaToBuffer(media.node, media.type);
    if (media.type === 'video') await ctx.sock.sendMessage(ctx.from, { video: buf, caption: '👁️ enthüllt' });
    else if (media.type === 'audio') await ctx.sock.sendMessage(ctx.from, { audio: buf, mimetype: 'audio/mpeg' });
    else await ctx.sock.sendMessage(ctx.from, { image: buf, caption: '👁️ enthüllt' });
  },
});

// ===========================================================================
//  WEITERE DOWNLOADER
// ===========================================================================
cmd(['twitter', 'x', 'xdl'], { desc: 'Twitter/X', run: (ctx, a, t) => runDownload(ctx, t.trim(), 'auto') });
cmd(['pinterest', 'pin'], { desc: 'Pinterest', run: (ctx, a, t) => runDownload(ctx, t.trim(), 'auto') });
cmd(['reddit', 'rd'], { desc: 'Reddit', run: (ctx, a, t) => runDownload(ctx, t.trim(), 'auto') });
cmd(['threads'], { desc: 'Threads', run: (ctx, a, t) => runDownload(ctx, t.trim(), 'auto') });

// ===========================================================================
//  GRUPPEN-VERWALTUNG  (nur in Gruppen; Aktionen nur Admin/Owner)
// ===========================================================================
cmd(['tagall', 'everyone', 'all'], {
  desc: 'Alle markieren',
  run: async (ctx, a, text) => {
    if (!ctx.isGroup) return ctx.reply('🌸 Nur in Gruppen.');
    const meta = await ctx.sock.groupMetadata(ctx.from);
    const jids = meta.participants.map((p) => p.id);
    const body = `📢 *${text || 'Achtung!'}*\n\n` + jids.map((j) => `@${j.split('@')[0]}`).join(' ');
    await ctx.sock.sendMessage(ctx.from, { text: body, mentions: jids });
  },
});
cmd(['kick', 'remove'], {
  desc: 'Mitglied entfernen',
  run: async (ctx) => {
    if (!ctx.isGroup) return ctx.reply('🌸 Nur in Gruppen.');
    if (!ctx.isOwner && !(await isGroupAdmin(ctx))) return ctx.reply('🔒 Nur Admins.');
    const t = mentionedOrQuoted(ctx);
    if (!t.length) return ctx.reply('🌸 Markiere oder zitiere die Person.');
    try { await ctx.sock.groupParticipantsUpdate(ctx.from, t, 'remove'); await ctx.react('✅'); }
    catch (e) { await ctx.reply('❌ Klappte nicht (bin ich Admin?).'); }
  },
});
cmd(['add'], {
  owner: true, desc: 'Nummer zur Gruppe hinzufügen',
  run: async (ctx, a) => {
    if (!ctx.isGroup) return ctx.reply('🌸 Nur in Gruppen.');
    const num = onlyDigits(a[0] || ''); if (!num) return ctx.reply(`🌸 \`${config.prefix}add <nummer>\``);
    try { await ctx.sock.groupParticipantsUpdate(ctx.from, [`${num}@s.whatsapp.net`], 'add'); await ctx.react('✅'); }
    catch (e) { await ctx.reply('❌ Klappte nicht (Privatsphäre-Einstellung der Person / kein Admin?).'); }
  },
});
cmd(['promote'], {
  desc: 'Zum Admin machen',
  run: async (ctx) => {
    if (!ctx.isGroup) return ctx.reply('🌸 Nur in Gruppen.');
    if (!ctx.isOwner && !(await isGroupAdmin(ctx))) return ctx.reply('🔒 Nur Admins.');
    const t = mentionedOrQuoted(ctx); if (!t.length) return ctx.reply('🌸 Wen?');
    try { await ctx.sock.groupParticipantsUpdate(ctx.from, t, 'promote'); await ctx.react('✅'); } catch (e) { await ctx.reply('❌ Klappte nicht.'); }
  },
});
cmd(['demote'], {
  desc: 'Admin entziehen',
  run: async (ctx) => {
    if (!ctx.isGroup) return ctx.reply('🌸 Nur in Gruppen.');
    if (!ctx.isOwner && !(await isGroupAdmin(ctx))) return ctx.reply('🔒 Nur Admins.');
    const t = mentionedOrQuoted(ctx); if (!t.length) return ctx.reply('🌸 Wen?');
    try { await ctx.sock.groupParticipantsUpdate(ctx.from, t, 'demote'); await ctx.react('✅'); } catch (e) { await ctx.reply('❌ Klappte nicht.'); }
  },
});
cmd(['grouplink', 'glink'], {
  desc: 'Einladungslink',
  run: async (ctx) => {
    if (!ctx.isGroup) return ctx.reply('🌸 Nur in Gruppen.');
    try { const code = await ctx.sock.groupInviteCode(ctx.from); await ctx.reply(`🔗 https://chat.whatsapp.com/${code}`); }
    catch (e) { await ctx.reply('❌ Brauche Admin-Rechte.'); }
  },
});
cmd(['setname', 'setsubject'], {
  desc: 'Gruppenname ändern',
  run: async (ctx, a, text) => {
    if (!ctx.isGroup) return ctx.reply('🌸 Nur in Gruppen.'); if (!text) return ctx.reply('🌸 Neuer Name?');
    try { await ctx.sock.groupUpdateSubject(ctx.from, text); await ctx.react('✅'); } catch (e) { await ctx.reply('❌ Admin nötig.'); }
  },
});
cmd(['setdesc'], {
  desc: 'Gruppen-Beschreibung',
  run: async (ctx, a, text) => {
    if (!ctx.isGroup) return ctx.reply('🌸 Nur in Gruppen.'); if (!text) return ctx.reply('🌸 Neue Beschreibung?');
    try { await ctx.sock.groupUpdateDescription(ctx.from, text); await ctx.react('✅'); } catch (e) { await ctx.reply('❌ Admin nötig.'); }
  },
});
cmd(['mute', 'close'], {
  desc: 'Gruppe schließen (nur Admins schreiben)',
  run: async (ctx) => {
    if (!ctx.isGroup) return ctx.reply('🌸 Nur in Gruppen.');
    if (!ctx.isOwner && !(await isGroupAdmin(ctx))) return ctx.reply('🔒 Nur Admins.');
    try { await ctx.sock.groupSettingUpdate(ctx.from, 'announcement'); await ctx.reply('🔒 Gruppe geschlossen.'); } catch (e) { await ctx.reply('❌ Klappte nicht.'); }
  },
});
cmd(['unmute', 'open'], {
  desc: 'Gruppe öffnen',
  run: async (ctx) => {
    if (!ctx.isGroup) return ctx.reply('🌸 Nur in Gruppen.');
    if (!ctx.isOwner && !(await isGroupAdmin(ctx))) return ctx.reply('🔒 Nur Admins.');
    try { await ctx.sock.groupSettingUpdate(ctx.from, 'not_announcement'); await ctx.reply('🔓 Gruppe geöffnet.'); } catch (e) { await ctx.reply('❌ Klappte nicht.'); }
  },
});
cmd(['groupinfo', 'ginfo'], {
  desc: 'Gruppen-Info',
  run: async (ctx) => {
    if (!ctx.isGroup) return ctx.reply('🌸 Nur in Gruppen.');
    const m = await ctx.sock.groupMetadata(ctx.from);
    const admins = m.participants.filter((p) => p.admin).length;
    await ctx.reply(frame('Gruppen-Info', [
      `📛 ${m.subject}`,
      `👥 ${m.participants.length} Mitglieder · ${admins} Admins`,
      `👑 Owner: ${(m.owner || '—').split('@')[0]}`,
      m.desc ? `📝 ${shorten(m.desc, 120)}` : '',
    ].filter(Boolean)));
  },
});

// ===========================================================================
//  UTILITY
// ===========================================================================
cmd(['translate', 'tr', 'übersetze'], {
  desc: 'Übersetzen: .tr <lang> <text>',
  run: async (ctx, a, text) => {
    if (!a.length) return ctx.reply(`🌸 \`${config.prefix}tr en hallo welt\` · oder auf eine Nachricht antworten`);
    const lang = a[0];
    let q = text.slice(a[0].length).trim() || getQuotedText(ctx);
    if (!q) return ctx.reply('🌸 Text fehlt.');
    try {
      const r = await axios.get('https://translate.googleapis.com/translate_a/single', { params: { client: 'gtx', sl: 'auto', tl: lang, dt: 't', q }, timeout: 15000 });
      const out = (r.data[0] || []).map((x) => x[0]).join('');
      await ctx.reply(`🌐 *${lang}:* ${out}`);
    } catch (e) { await ctx.reply('❌ Übersetzung fehlgeschlagen.'); }
  },
});
cmd(['tts', 'say', 'voice'], {
  desc: 'Text → Sprachnachricht',
  run: async (ctx, a, text) => {
    let lang = 'de', q = text;
    if (a[0] && /^[a-z]{2}$/i.test(a[0])) { lang = a[0].toLowerCase(); q = text.slice(a[0].length).trim(); }
    if (!q) q = getQuotedText(ctx);
    if (!q) return ctx.reply(`🌸 \`${config.prefix}tts <text>\` (optional Sprache: \`.tts en hello\`)`);
    q = q.slice(0, 200);
    try {
      const buf = await downloadBuffer(`https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(q)}&tl=${lang}&client=tw-ob`);
      await ctx.sock.sendMessage(ctx.from, { audio: buf, mimetype: 'audio/mpeg', ptt: true }, { quoted: ctx.msg });
    } catch (e) { await ctx.reply('❌ TTS fehlgeschlagen (Text evtl. zu lang).'); }
  },
});
cmd(['qr', 'qrcode'], {
  desc: 'QR-Code generieren',
  run: async (ctx, a, text) => {
    if (!text) return ctx.reply(`🌸 \`${config.prefix}qr <text/url>\``);
    const buf = await downloadBuffer(`https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(text)}`);
    await ctx.sock.sendMessage(ctx.from, { image: buf, caption: '🔳 QR' }, { quoted: ctx.msg });
  },
});
cmd(['calc', 'rechne', 'math'], {
  desc: 'Taschenrechner',
  run: async (ctx, a, text) => {
    const expr = text.trim();
    if (!expr) return ctx.reply(`🌸 \`${config.prefix}calc 2+2*3\``);
    if (!/^[0-9+\-*/().,%\s]+$/.test(expr)) return ctx.reply('❌ Nur Zahlen und + - * / ( ) % erlaubt.');
    try {
      // eslint-disable-next-line no-new-func — Eingabe ist per Regex auf Ziffern/Operatoren beschränkt
      const r = Function(`"use strict"; return (${expr.replace(/,/g, '.')})`)();
      if (!Number.isFinite(r)) throw new Error('inf');
      await ctx.reply(`🧮 ${expr} = *${r}*`);
    } catch (_) { await ctx.reply('❌ Ungültiger Ausdruck.'); }
  },
});
cmd(['weather', 'wetter'], {
  desc: 'Wetter',
  run: async (ctx, a, text) => {
    if (!text) return ctx.reply(`🌸 \`${config.prefix}weather Berlin\``);
    try {
      const r = await axios.get(`https://wttr.in/${encodeURIComponent(text)}?format=j1&lang=de`, { timeout: 15000 });
      const c = r.data.current_condition[0], area = r.data.nearest_area[0];
      await ctx.reply(frame('Wetter', [
        `📍 ${area.areaName[0].value}, ${area.country[0].value}`,
        `🌡️ ${c.temp_C}°C (gefühlt ${c.FeelsLikeC}°C)`,
        `☁️ ${c.lang_de?.[0]?.value || c.weatherDesc[0].value}`,
        `💧 ${c.humidity}% · 💨 ${c.windspeedKmph} km/h`,
      ]));
    } catch (e) { await ctx.reply('❌ Ort nicht gefunden.'); }
  },
});
cmd(['wiki', 'wikipedia'], {
  desc: 'Wikipedia-Zusammenfassung',
  run: async (ctx, a, text) => {
    if (!text) return ctx.reply(`🌸 \`${config.prefix}wiki <thema>\``);
    const r = await axios.get(`https://de.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(text)}`, { timeout: 15000, validateStatus: () => true });
    if (r.status !== 200 || !r.data.extract) return ctx.reply('❌ Nichts gefunden.');
    await ctx.reply(`📖 *${r.data.title}*\n\n${shorten(r.data.extract, 600)}`);
  },
});
cmd(['urban', 'ud'], {
  desc: 'Urban Dictionary',
  run: async (ctx, a, text) => {
    if (!text) return ctx.reply(`🌸 \`${config.prefix}urban <wort>\``);
    const r = await axios.get(`https://api.urbandictionary.com/v0/define?term=${encodeURIComponent(text)}`, { timeout: 15000 });
    const d = r.data.list?.[0];
    if (!d) return ctx.reply('❌ Nichts gefunden.');
    await ctx.reply(`📕 *${text}*\n\n${shorten(d.definition, 500)}\n\n_${shorten(d.example, 200)}_`);
  },
});
cmd(['ip', 'ipinfo'], {
  desc: 'IP-Info',
  run: async (ctx, a, text) => {
    if (!text) return ctx.reply(`🌸 \`${config.prefix}ip 8.8.8.8\``);
    const r = await axios.get(`http://ip-api.com/json/${encodeURIComponent(text)}`, { timeout: 15000 });
    const d = r.data;
    if (d.status !== 'success') return ctx.reply('❌ Ungültige IP/Domain.');
    await ctx.reply(frame('IP-Info', [`🌐 ${d.query}`, `🏳️ ${d.country} (${d.countryCode})`, `🏙️ ${d.regionName}, ${d.city}`, `🏢 ${d.isp}`, `📍 ${d.lat}, ${d.lon}`]));
  },
});
cmd(['short', 'shorturl'], {
  desc: 'URL kürzen',
  run: async (ctx, a, text) => {
    if (!/^https?:\/\//i.test(text)) return ctx.reply(`🌸 \`${config.prefix}short <url>\``);
    const r = await axios.get(`https://is.gd/create.php?format=simple&url=${encodeURIComponent(text)}`, { timeout: 15000 });
    await ctx.reply(`🔗 ${String(r.data).trim()}`);
  },
});
cmd(['jid', 'chatid'], { desc: 'JID anzeigen', run: async (ctx) => ctx.reply(`🆔 Chat: \`${ctx.from}\`\n👤 Du: \`${ctx.senderJid}\``) });

// ===========================================================================
//  FUN
// ===========================================================================
const EIGHTBALL = ['Ja, definitiv! 💖', 'Sieht gut aus ✨', 'Vielleicht~ 🤔', 'Frag später nochmal 💭', 'Eher nicht 😅', 'Nein 🙅', 'Absolut! 🎉', 'Ohne Zweifel 👍', 'Verlass dich nicht drauf 🙃'];
cmd(['8ball', '8b', 'magic8'], { desc: 'Magische 8', run: async (ctx, a, text) => { if (!text) return ctx.reply('🌸 Stell mir eine Ja/Nein-Frage.'); await ctx.reply(`🎱 ${EIGHTBALL[Math.floor(Math.random() * EIGHTBALL.length)]}`); } });
cmd(['coinflip', 'flip', 'münze'], { desc: 'Münzwurf', run: async (ctx) => { await ctx.react('🪙'); await ctx.reply(Math.random() < 0.5 ? '🪙 *Kopf!*' : '🪙 *Zahl!*'); } });
cmd(['rps', 'schnick'], {
  desc: 'Schere-Stein-Papier',
  run: async (ctx, a) => {
    const EMO = { schere: '✂️', stein: '🪨', papier: '📄' };
    const norm = { rock: 'stein', paper: 'papier', scissors: 'schere', scissor: 'schere' };
    let me = (a[0] || '').toLowerCase(); me = norm[me] || me;
    if (!EMO[me]) return ctx.reply(`🌸 \`${config.prefix}rps schere|stein|papier\``);
    const bot = ['schere', 'stein', 'papier'][Math.floor(Math.random() * 3)];
    const beats = { schere: 'papier', stein: 'schere', papier: 'stein' };
    const res = me === bot ? '🤝 Unentschieden!' : (beats[me] === bot ? '🎉 Du gewinnst!' : '🤖 Ich gewinne!');
    await ctx.reply(`${EMO[me]} vs ${EMO[bot]}\n${res}`);
  },
});
cmd(['joke', 'witz'], {
  desc: 'Witz',
  run: async (ctx) => {
    try {
      const r = await axios.get('https://v2.jokeapi.dev/joke/Any?lang=de&safe-mode', { timeout: 15000 });
      await ctx.reply(r.data.type === 'single' ? `😄 ${r.data.joke}` : `😄 ${r.data.setup}\n\n... ${r.data.delivery}`);
    } catch (_) { await ctx.reply('❌ Gerade kein Witz parat 😅'); }
  },
});
cmd(['fact', 'fakt'], {
  desc: 'Zufälliger Fakt',
  run: async (ctx) => {
    try { const r = await axios.get('https://uselessfacts.jsph.pl/api/v2/facts/random?language=de', { timeout: 15000 }); await ctx.reply(`💡 ${r.data.text}`); }
    catch (_) { await ctx.reply('❌ Kein Fakt verfügbar.'); }
  },
});
cmd(['ship'], { desc: 'Liebes-Match', run: async (ctx, a, text) => { const pct = Math.floor(Math.random() * 101); const f = Math.round(pct / 10); await ctx.reply(`💘 *Liebes-Match*\n${text || 'ihr beide'}\n\n${'❤️'.repeat(f)}${'🤍'.repeat(10 - f)} *${pct}%*`); } });
cmd(['rate', 'bewerte'], { desc: 'Bewertung', run: async (ctx, a, text) => { if (!text) return ctx.reply(`🌸 \`${config.prefix}rate <etwas>\``); await ctx.reply(`📊 *${text}* → *${Math.floor(Math.random() * 101)}/100*`); } });
cmd(['password', 'pw', 'genpw'], { desc: 'Passwort-Generator', run: async (ctx, a) => { const len = Math.max(6, Math.min(64, parseInt(a[0]) || 16)); const ch = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%&*'; let pw = ''; for (let i = 0; i < len; i++) pw += ch[Math.floor(Math.random() * ch.length)]; await ctx.reply(`🔐 \`${pw}\``); } });
cmd(['cat', 'katze'], { desc: 'Katzenbild', run: async (ctx) => { try { const buf = await downloadBuffer('https://cataas.com/cat'); await ctx.sock.sendMessage(ctx.from, { image: buf, caption: '🐱 miau~' }, { quoted: ctx.msg }); } catch (_) { await ctx.reply('❌ Keine Katze 😿'); } } });
cmd(['dog', 'hund'], {
  desc: 'Hundebild',
  run: async (ctx) => {
    try {
      const r = await axios.get('https://random.dog/woof.json', { timeout: 15000 });
      const buf = await downloadBuffer(r.data.url);
      if (/\.mp4$/i.test(r.data.url)) await ctx.sock.sendMessage(ctx.from, { video: buf, caption: '🐶 wuff~', gifPlayback: true }, { quoted: ctx.msg });
      else await ctx.sock.sendMessage(ctx.from, { image: buf, caption: '🐶 wuff~' }, { quoted: ctx.msg });
    } catch (_) { await ctx.reply('❌ Kein Hund 🐾'); }
  },
});
cmd(['github', 'gh'], {
  desc: 'GitHub-Profil',
  run: async (ctx, a) => {
    if (!a[0]) return ctx.reply(`🌸 \`${config.prefix}github <user>\``);
    const r = await axios.get(`https://api.github.com/users/${encodeURIComponent(a[0])}`, { timeout: 15000, validateStatus: () => true });
    if (r.status !== 200) return ctx.reply('❌ Nutzer nicht gefunden.');
    const d = r.data; const buf = await downloadBuffer(d.avatar_url);
    await ctx.sock.sendMessage(ctx.from, { image: buf, caption: frame('GitHub', [`👤 ${d.login}${d.name ? ` (${d.name})` : ''}`, `📦 Repos: ${d.public_repos}`, `👥 ${d.followers} Follower · folgt ${d.following}`, d.bio ? `📝 ${d.bio}` : '', `🔗 ${d.html_url}`].filter(Boolean)) }, { quoted: ctx.msg });
  },
});
cmd(['pokemon', 'pokedex'], {
  desc: 'Pokédex',
  run: async (ctx, a) => {
    if (!a[0]) return ctx.reply(`🌸 \`${config.prefix}pokemon pikachu\``);
    const r = await axios.get(`https://pokeapi.co/api/v2/pokemon/${encodeURIComponent(a[0].toLowerCase())}`, { timeout: 15000, validateStatus: () => true });
    if (r.status !== 200) return ctx.reply('❌ Nicht gefunden.');
    const d = r.data; const img = d.sprites.other?.['official-artwork']?.front_default || d.sprites.front_default;
    const buf = await downloadBuffer(img);
    await ctx.sock.sendMessage(ctx.from, { image: buf, caption: frame('Pokédex', [`#${d.id} ${d.name}`, `📏 ${d.height / 10}m · ⚖️ ${d.weight / 10}kg`, `🔮 ${d.types.map((t) => t.type.name).join(', ')}`, `💪 ${d.abilities.map((x) => x.ability.name).join(', ')}`]) }, { quoted: ctx.msg });
  },
});
cmd(['crypto', 'coin'], {
  desc: 'Krypto-Kurs',
  run: async (ctx, a) => {
    const id = (a[0] || 'bitcoin').toLowerCase();
    const r = await axios.get(`https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=usd,eur&include_24hr_change=true`, { timeout: 15000 });
    const d = r.data[id];
    if (!d) return ctx.reply('❌ Coin nicht gefunden (z.B. bitcoin, ethereum, solana).');
    await ctx.reply(frame('Crypto', [`🪙 ${id}`, `💵 $${d.usd}`, `💶 €${d.eur}`, `📈 24h: ${(d.usd_24h_change || 0).toFixed(2)}%`]));
  },
});
cmd(['currency', 'fx', 'umrechnen'], {
  desc: 'Währungsrechner: .fx 100 usd eur',
  run: async (ctx, a) => {
    if (a.length < 3) return ctx.reply(`🌸 \`${config.prefix}fx 100 usd eur\``);
    const amt = parseFloat(a[0]); const from = a[1].toUpperCase(), to = a[2].toUpperCase();
    if (isNaN(amt)) return ctx.reply('❌ Betrag ungültig.');
    const r = await axios.get(`https://open.er-api.com/v6/latest/${from}`, { timeout: 15000 });
    const rate = r.data.rates?.[to];
    if (!rate) return ctx.reply('❌ Währung ungültig.');
    await ctx.reply(`💱 ${amt} ${from} = *${(amt * rate).toFixed(2)} ${to}*`);
  },
});
cmd(['color', 'farbe'], {
  desc: 'Farbe anzeigen',
  run: async (ctx, a) => {
    const hex = (a[0] || '').replace('#', '');
    if (!/^[0-9a-fA-F]{6}$/.test(hex)) return ctx.reply(`🌸 \`${config.prefix}color ff69b4\``);
    const buf = await downloadBuffer(`https://singlecolorimage.com/get/${hex}/400x400`);
    let name = '';
    try { const r = await axios.get(`https://www.thecolorapi.com/id?hex=${hex}`, { timeout: 10000 }); name = r.data?.name?.value || ''; } catch (_) {}
    await ctx.sock.sendMessage(ctx.from, { image: buf, caption: `🎨 #${hex}${name ? ` · ${name}` : ''}` }, { quoted: ctx.msg });
  },
});
cmd(['lyrics', 'songtext'], {
  desc: 'Songtext: .lyrics Künstler - Titel',
  run: async (ctx, a, text) => {
    const parts = text.split('-');
    if (parts.length < 2) return ctx.reply(`🌸 \`${config.prefix}lyrics Künstler - Titel\``);
    const r = await axios.get(`https://api.lyrics.ovh/v1/${encodeURIComponent(parts[0].trim())}/${encodeURIComponent(parts.slice(1).join('-').trim())}`, { timeout: 20000, validateStatus: () => true });
    if (r.status !== 200 || !r.data.lyrics) return ctx.reply('❌ Keine Lyrics gefunden.');
    await ctx.reply(`🎶 *${text.trim()}*\n\n${shorten(r.data.lyrics, 1500)}`);
  },
});

// ── Anime-Reaktions-GIFs (waifu.pics) ──
const REACTIONS = ['hug', 'pat', 'kiss', 'slap', 'cuddle', 'wave', 'smile', 'dance', 'cry', 'poke', 'bonk', 'blush', 'happy', 'wink', 'highfive', 'bite', 'lick'];
for (const re of REACTIONS) {
  cmd([re], {
    desc: `Anime-Reaktion: ${re}`,
    run: async (ctx) => {
      try {
        const r = await axios.get(`https://api.waifu.pics/sfw/${re}`, { timeout: 15000 });
        const gif = await downloadBuffer(r.data.url);
        const mp4 = await gifBufToMp4(gif);
        const targets = mentionedOrQuoted(ctx);
        const cap = targets.length ? `@${targets[0].split('@')[0]} — ${re}! 🌸` : `${re}! 🌸`;
        await ctx.sock.sendMessage(ctx.from, { video: mp4, gifPlayback: true, caption: cap, mentions: targets }, { quoted: ctx.msg });
      } catch (e) { log.warn({ err: e.message, re }, 'reaction'); await ctx.reply(`❌ ${re} gerade nicht verfügbar.`); }
    },
  });
}

// ===========================================================================
//  AI · UPSCALE  (A1111 extras)
// ===========================================================================
cmd(['upscale', 'hd', 'remini'], {
  desc: 'Bild hochskalieren (A1111)',
  run: async (ctx, a) => {
    const media = findMedia(ctx.msg);
    if (!media || media.type !== 'image') return ctx.reply(`🌸 Antworte auf ein Bild mit \`${config.prefix}upscale\`.`);
    await ctx.react('🔍');
    try {
      const buf = await mediaToBuffer(media.node, 'image');
      const scale = Math.max(2, Math.min(4, parseInt(a[0]) || 2));
      const r = await axios.post(`${resolveSdEndpoint()}/sdapi/v1/extra-single-image`, {
        image: buf.toString('base64'), upscaling_resize: scale, upscaler_1: 'R-ESRGAN 4x+',
      }, { timeout: config.sd.timeoutMs });
      if (!r.data.image) throw new Error('kein Bild');
      await ctx.sock.sendMessage(ctx.from, { image: Buffer.from(String(r.data.image).split(',').pop(), 'base64'), caption: `🔍 Upscaled ×${scale}` }, { quoted: ctx.msg });
      await ctx.react('✅');
    } catch (e) {
      await ctx.react('❌');
      const off = ['ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT'].includes(e.code) || !e.response;
      await ctx.reply(off ? '❌ SD-Backend nicht erreichbar.' : `❌ ${shorten(e.message, 120)}`);
    }
  },
});

// ===========================================================================
//  OWNER-TOOLS
// ===========================================================================
cmd(['block'], {
  owner: true, desc: 'Nutzer blockieren',
  run: async (ctx) => { const t = mentionedOrQuoted(ctx)[0] || (ctx.isGroup ? null : ctx.from); if (!t) return ctx.reply('🌸 Wen blockieren?'); await ctx.sock.updateBlockStatus(t, 'block'); await ctx.reply('🚫 Blockiert.'); },
});
cmd(['unblock'], {
  owner: true, desc: 'Nutzer entblocken',
  run: async (ctx) => { const t = mentionedOrQuoted(ctx)[0] || (ctx.isGroup ? null : ctx.from); if (!t) return ctx.reply('🌸 Wen entblocken?'); await ctx.sock.updateBlockStatus(t, 'unblock'); await ctx.reply('✅ Entblockt.'); },
});
cmd(['restart', 'neustart'], { owner: true, desc: 'Neustart (unter pm2)', run: async (ctx) => { await ctx.reply('🔄 Starte neu... (nur unter pm2/Prozessmanager)'); setTimeout(() => process.exit(0), 800); } });
cmd(['shutdown', 'kill'], { owner: true, desc: 'Bot stoppen', run: async (ctx) => { await ctx.reply('🛑 Fahre runter...'); setTimeout(() => process.exit(1), 800); } });

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
  log.info({ baileys: baileysImpl, downloader: neeleDl ? '@neelegirly/downloader (Fork)' : 'public APIs' }, '🔌 Backends');

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
