# ANALYSE — Bestand `/root/OniSelf` → Base-Bot

> Erstellt in Schritt 0, bevor irgendetwas gebaut wurde. Nichts im Original
> wurde verändert. Der Base-Bot liegt sauber daneben in `/root/OniSelf-Bot`.

## Was der bestehende Bot ist

`/root/OniSelf` ist **kein** monolithischer Bot, sondern eine ausgewachsene
**Multi-Session-Plattform** (`onimai-platform`, v2.0.0):

- Entry-Point: `core/index.js` (startet mehrere WhatsApp-Sessions parallel,
  Web-Server, Watchdogs, Reaction-Worker, Colab-Orchestrator …).
- **Plugin-Architektur**: Commands liegen in `commands/<kategorie>/*.js` und
  werden dynamisch über `core/plugins/registry.js` geladen. Routing über
  `core/events/message-handler.js` → `EventBus`.
- Sessions, Web-Frontend (`web/`), Telemetrie, XP/Economy, Sticker-Engine,
  Notebook-Anbindung u.v.m. — alles eng verzahnt und auf die private Infra
  (eigene Server, Colab-Notebook, aaPanel/nginx) zugeschnitten.

Das ist genau **das Gegenteil** von dem, was hier gewünscht ist. Der Base-Bot
extrahiert die Kern-Features in **eine Datei** ohne Plugin-Loader.

## WhatsApp-Library

| | Original | Base-Bot |
|---|---|---|
| Paket | `@neelegirly/baileys` 2.2.27 (**privater Fork**) + `@neelegirly/wa-api` (Multi-Session-Wrapper) | bevorzugt `@neelegirly/baileys` (optional), sonst `baileys` 6.7.23 „legacy"/stable |
| API | Standard-Baileys API (`makeWASocket`, `useMultiFileAuthState`, `fetchLatestBaileysVersion`, `DisconnectReason`, `Browsers`) | identisch |

**Lib beibehalten ≙ Baileys beibehalten.** Der Base-Bot lädt den privaten Fork
`@neelegirly/baileys` **bevorzugt** (als `optionalDependency` + `overrides`),
fällt aber auf das **öffentliche `baileys`-Paket** zurück, wenn der Fork nicht
installiert ist. Hintergrund: Der private Fork (`@neelegirly/*`) lässt sich von
Fremden **nicht installieren** (privates Repo, npm-Token abgelaufen) — als
`optionalDependency` bricht `npm install` deshalb **nicht** ab, und Fremde
bekommen automatisch das funktionsgleiche öffentliche Paket. Auf dem
Original-Host (Fork vorhanden) nutzt der Bot den Fork. Beste aus beiden Welten.

## Session-Speicherung

- Original: zentraler SQLite-Store (`sqlite-auth-state.js`-Shim, hartcodiert
  von `@neelegirly/wa-api` erwartet) → `sessionStore.db`, dazu ein
  Legacy-JSON→DB-Migrator. Auf die private Multi-Session-Infra zugeschnitten.
- Base-Bot: **`useMultiFileAuthState('session')`** — der Baileys-Standard.
  Eine Session, Auth liegt im Ordner `session/`, überlebt Neustarts, **kein
  QR-Scan bei jedem Start**. Genau so im Ziel-Layout vorgesehen.

## SD / KI-Anbindung (Stable Diffusion)

- Live-Pfad im Original: `commands/ai/ai.js` (1600+ Zeilen). Postet direkt an
  Automatic1111 `POST /sdapi/v1/txt2img`.
- Endpoint-Auflösung: `cache/colab.json` (vom Colab-Notebook geschrieben,
  Cloudflare-Tunnel-URL) → ENV `SD_ENDPOINT` → statische Fallback-Liste
  (`127.0.0.1:17860` = frpc-Tunnel etc.).
- **Per-User-Settings**: `commands/lib/aiSettings.js` → JSON-Store
  (`data/aiSettings.json`), Schema in `DEFAULTS`/`SETTABLE`.
- **Der „Settings landen nicht im Payload"-Bug**: Im Live-`ai.js` ist er
  bereits gefixt — Zeile ~1155: `const payload = { ...userSettings, prompt,
  ...inlineOverrides, send_images:true }`. Alle A1111-Felder (`enable_hr`,
  `hr_scale`, `hr_upscaler`, `denoising_strength`, `hr_second_pass_steps`,
  `steps`, `cfg_scale`, `width`, `height`, `sampler_name`,
  `negative_prompt`) werden tatsächlich in den Body gemergt.
  **Der Base-Bot baut den Payload genauso explizit** und **loggt ihn vor dem
  Request** (Abschluss-Checkliste: „Settings landen nachweislich im Payload").
- Online-Fallback im Original: `image.pollinations.ai`, wenn keine GPU
  erreichbar. Im Base-Bot als optionaler Fallback übernommen.

## Downloader

- `uploads/downloader.js` + `services/downloader/*`. Nutzt das private Paket
  `@neelegirly/downloader` **plus** öffentliche, keylose Fallback-APIs:
  `nayan-video-downloader.vercel.app`, `api.siputzx.my.id`, `api.bk9.site`.
- Plattformen: YouTube (Video/MP3, auch Suche), TikTok (Video + Slideshow),
  Instagram, Facebook, Spotify, SoundCloud.
- Base-Bot nutzt `.yt`, `.ytmp3`/`.play`, `.tiktok`/`.tt`, `.ig`, `.fb` —
  bevorzugt über den **privaten Fork `@neelegirly/downloader`** (falls
  installiert, `ytdown`/`tikdown`/`instagram`/`fbdown2`/`alldown`), sonst über
  die **öffentlichen Fallback-APIs**. Mit Größen-/Timeout-Limit und klarem
  Fehlertext. Der Fork ist `optionalDependency` — fehlt er, laufen die
  öffentlichen APIs.

## Games

- Original `commands/fun/minigames.js`: **Glücksspiel** (Slots, Roulette,
  Fishing) gekoppelt an ein Economy/XP-System.
- Der Prompt wünscht klassische **Minispiele** (TicTacToe, Galgenmännchen,
  Quiz, Würfeln, Zahlenraten) — die baut der Base-Bot **neu & self-contained**
  (State pro Chat, keine Economy-Kopplung). Annahme dokumentiert; leicht
  anpassbar.

## Persona

- Text-KI im Original: `ai/ai-engine.js` → Google **Gemini** (`gemini-1.5-flash`),
  Key aus `OniSelfAPI.env` (`GEMINI_API_KEY`). Generische „Assistant"-Persona.
- Base-Bot: zentrale **„Neele"-Persona** in `config.js` (deutschsprachig,
  freundlich-frech). Wird als System-Prompt für `.chat` **und** als Ton für
  Bot-Texte (Begrüßung, `.menu`, Hilfe) verwendet.

## Owner / Selfmode

- Original: `runtime/self-mode.js` mit **hartcodierten Owner-Nummern** +
  DSGVO-Blocker + Whitelist-Dateien.
- Base-Bot: Owner **ausschließlich** über `.env` (`OWNER_NUMBER`,
  kommasepariert). **Keine** echten Nummern im Repo (Sicherheit). Optionaler
  „nur Owner"-Lockdown via `ONISELF_OWNER_ONLY=true`.

## Secrets

- Original liest `OniSelfAPI.env`. Base-Bot liest `.env` (Template
  `.env.example`). Nichts wird hartcodiert; `.env` und `session/` sind
  ge-`.gitignore`-d.
