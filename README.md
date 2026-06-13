# 🌸 OniSelf — WhatsApp Selfbot (Neele)

Ein **monolithischer** WhatsApp-Selfbot auf [Baileys](https://github.com/WhiskeySockets/Baileys).
Der gesamte Core **und alle Commands** stecken in **einer Datei**: [`oniself.js`](oniself.js).
Kein Plugin-System, kein dynamischer Loader — clonen, `.env` ausfüllen, starten.

**Features:** YouTube/TikTok/Instagram/Facebook-Downloader · Stable-Diffusion-Bilder
(Automatic1111) · Minispiele · die deutschsprachige **Neele**-Chat-Persona.

---

## ✨ Features & Befehle

> Standard-Prefix ist `.` (in der `.env` änderbar).

### 🎨 KI / Stable Diffusion
| Befehl | Beschreibung |
|---|---|
| `.ai <prompt>` / `.img <prompt>` | Bild generieren (A1111 `txt2img`) |
| `.set <key> <wert>` | Setting ändern (siehe unten) |
| `.settings` | deine aktuellen Settings anzeigen |
| `.setreset` | Settings auf Standard zurücksetzen |
| `.chat <text>` | mit **Neele** plaudern (Gemini) |

**Settings** (`.set <key> <wert>`), persistent **pro User**:

| Key (+ Aliase) | Beispiel | Wirkung |
|---|---|---|
| `hr` / `hires` | `.set hr on` | Hi-Res-Fix an/aus |
| `scale` | `.set scale 2` | Hi-Res-Skalierung (1–4) |
| `upscaler` | `.set upscaler R-ESRGAN 4x+ Anime6B` | Hi-Res-Upscaler |
| `hrsteps` | `.set hrsteps 12` | Hi-Res-Pass-Steps |
| `denoise` | `.set denoise 0.4` | Denoising-Stärke (0–1) |
| `steps` | `.set steps 30` | Sampling-Steps |
| `cfg` | `.set cfg 7` | CFG-Scale |
| `sampler` | `.set sampler DPM++ 2M Karras` | Sampler |
| `seed` | `.set seed 12345` | Seed (`-1` = random) |
| `size` | `.set size 768x1152` | Breite×Höhe |
| `neg` | `.set neg lowres, blurry` | Negativ-Prompt |
| `faces` | `.set faces on` | Restore Faces |

> **Wichtig (war ein bekannter Bug):** Diese Settings landen **tatsächlich im
> API-Payload**. `oniself.js` baut den `txt2img`-Body in `buildSdPayload()`
> explizit aus den gespeicherten Settings **und loggt den gesendeten Payload**
> vor jedem Request (`🎨 txt2img-Payload → A1111` in der Konsole). So ist
> nachweisbar, dass Hi-Res, Scale, Upscaler & Co. wirklich ankommen.

### 📥 Downloader
| Befehl | Beschreibung |
|---|---|
| `.yt <url\|suche>` | YouTube-Video |
| `.ytmp3 <url\|suche>` | YouTube als MP3 |
| `.play <suche>` | Song suchen → MP3 |
| `.tiktok` / `.tt <url>` | TikTok-Video oder Foto-Slideshow |
| `.ig <url>` | Instagram |
| `.fb <url>` | Facebook |
| `.dl <url>` | Plattform automatisch erkennen |

Limits: max. Dateigröße (`DOWNLOAD_MAX_MB`, Standard 100 MB) und Timeout
(`DOWNLOAD_TIMEOUT_MS`). Bei Fehlschlag kommt ein klarer Fehlertext.

### 🎮 Minispiele
| Befehl | Beschreibung |
|---|---|
| `.ttt` / `.ttt <1-9>` | TicTacToe gegen den Bot |
| `.hangman` / `.hangman <buchstabe>` | Galgenmännchen |
| `.quiz` + `.answer <antwort>` | Quiz |
| `.guess` + `.guess <zahl>` | Zahlenraten 1–100 |
| `.dice [seiten]` | Würfeln |

### ⚙️ System
`.menu` · `.ping` · `.alive` · `.whoami`

---

## 🚀 Setup

```bash
# 1. Klonen
git clone <repo-url> OniSelf-Bot
cd OniSelf-Bot

# 2. Abhängigkeiten installieren
npm install

# 3. Konfigurieren
cp .env.example .env
nano .env        # mindestens OWNER_NUMBER eintragen

# 4. Starten
node oniself.js   # oder: npm start
```

Beim ersten Start erscheint ein **QR-Code** im Terminal → in WhatsApp scannen
(**Einstellungen → Verknüpfte Geräte → Gerät verknüpfen**). Die Session wird im
Ordner `session/` gespeichert und überlebt Neustarts — **kein erneuter Scan**.

**Pairing per Code statt QR:** Setze `ONISELF_PAIR_NUMBER` in der `.env` (deine
Nummer, nur Ziffern). Dann druckt der Bot einen 8-stelligen Code für
*„Mit Nummer verknüpfen"*.

### Dauerhaft laufen lassen (optional)
```bash
npm i -g pm2
pm2 start oniself.js --name oniself
pm2 save
```

---

## 🔑 Konfiguration (`.env`)

Alle Werte sind in [`.env.example`](.env.example) dokumentiert. Die wichtigsten:

| Variable | Zweck |
|---|---|
| `OWNER_NUMBER` | deine Nummer(n), Ziffern, kommasepariert — darf owner-only Befehle |
| `ONISELF_PREFIX` | Befehls-Prefix (Standard `.`) |
| `ONISELF_OWNER_ONLY` | `true` = nur Owner darf Befehle (echter Selfbot) |
| `ONISELF_PAIR_NUMBER` | Pairing per Code statt QR |
| `SD_ENDPOINT` | A1111-URL (z.B. Cloudflare-Tunnel) für die KI-Bilder |
| `GEMINI_API_KEY` | Google-Gemini-Key für `.chat` |
| `HEARTBEAT_URL` | optionaler Status-Ping |

> 🔒 `.env` und `session/` stehen in `.gitignore` — **niemals committen**.
> Es sind keinerlei Secrets oder Telefonnummern im Code hinterlegt.

---

## 🖼️ KI-Backend (Stable Diffusion)

`.ai` ruft eine **Automatic1111-WebUI** über `POST /sdapi/v1/txt2img` auf. Du
brauchst also einen erreichbaren A1111-Server **mit `--api`**:

- **Lokal:** A1111 mit `--api` starten → `SD_FALLBACK_ENDPOINT=http://127.0.0.1:7860`.
- **Google Colab + Cloudflare-Tunnel:** A1111 in Colab starten, per
  `cloudflared` tunneln und die Tunnel-URL als `SD_ENDPOINT` setzen
  (oder ein Notebook legt sie in `cache/colab.json` als `{"url": "..."}` ab —
  das wird automatisch erkannt).

Ist **keine** GPU erreichbar, fällt `.ai` (sofern `SD_POLLINATIONS_FALLBACK=true`)
auf den kostenlosen Online-Dienst `image.pollinations.ai` zurück, damit trotzdem
ein Bild kommt.

---

## 🏗️ Architektur (kurz)

Alles in **`oniself.js`**, klar in Abschnitte gegliedert:
Helfer → AI-Settings-Store → SD-Client → Downloader → Chat-KI → Minispiele →
**`COMMANDS`-Map** → Message-Router → Baileys-Verbindung (Auth, Reconnect-Backoff,
Crash-Guards). Neue Befehle fügst du mit einem `cmd([...], { run })`-Eintrag hinzu.

Persona, Prefix, Defaults und alle `.env`-Werte liegen in [`config.js`](config.js).

Eine Analyse, wie dieser Base-Bot aus dem ursprünglichen Multi-Session-Projekt
extrahiert wurde, steht in [`ANALYSE.md`](ANALYSE.md).

---

## ⚠️ Hinweise

- **Selbstbot-Risiko:** Das Automatisieren eines persönlichen WhatsApp-Accounts
  verstößt gegen WhatsApps AGB und kann zur Sperrung führen. Nutzung auf eigenes
  Risiko, am besten mit einer Zweitnummer.
- Die Downloader nutzen öffentliche Dritt-APIs; deren Verfügbarkeit kann
  schwanken. Lade nur Inhalte herunter, für die du die Rechte hast.

## 📄 Lizenz
MIT — siehe [LICENSE](LICENSE).
