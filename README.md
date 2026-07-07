# Ketron SD90 Remote — Web App (PWA)

A mobile-first Progressive Web App that controls a Ketron SD90 arranger
keyboard over **Bluetooth LE MIDI**, mirroring the desktop app's song
library, registration switching, and word-synced lyrics display.

**Live app:** https://milegjorgjeski-cpu.github.io/ketron-sd90-remote/

## Folder structure

```
web_app/
  index.html            App shell (Songs list + Now Playing views)
  manifest.json         PWA manifest (installable, standalone display)
  service-worker.js     Offline cache (app shell + songs.json)
  css/style.css         Mobile UI styling
  js/ble.js             Web Bluetooth MIDI transport (BLE-MIDI + SysEx/TABS)
  js/lyrics.js          Word-grouping + sync-offset logic (ported from main.py)
  js/app.js             Song list, search/filter, navigation, wiring
  songs.json            Generated song library (see export_songs.py)
  icons/                PWA icons (icon-192.png, icon-512.png)
  export_songs.py       Rebuilds songs.json from the SD90 Remote songs/ folder
  make_icons.py         Regenerates the PWA icons
  serve_https.py        Local HTTPS dev server with a self-signed cert
```

## Regenerating songs.json

Whenever the songs library changes (`C:\Users\mileg\OneDrive\Desktop\Ketron SD90 Remote\songs\`),
re-run the exporter from this folder:

```
python export_songs.py
```

This scans every song folder's `song_info.json` + `lyrics.json` and writes a
single compact `songs.json` array with `title`, `artist`, `reg_number`,
`bank`, `mp3_path`, `duration_ms`, `lyrics`, and `lyric_format`
(`"syllable"`, `"synced-word"`, `"midi"`, or `null` if the song has no lyrics).

## Why there's no audio playback

Songs live on the keyboard itself (or its SD card / `G:\` drive) — the app
never has an actual audio file to play. Exactly like the desktop app, this
PWA doesn't play mp3/midi audio at all: pressing a song sends a **Program
Change** (bank + registration) over BLE so the *keyboard* loads and plays the
song, and the app runs its own clock (using `duration_ms` from the library)
to keep the on-screen lyrics in sync, compensating with the same 282ms
(MIDI/KAR source) / 1400ms (MP3/WAV source) offsets as `main.py`.

## Testing locally

Web Bluetooth only works in a "secure context": `https://` or `http://localhost`.

### Option A — same PC, browser only (simplest)

No certificate needed — `localhost` counts as secure:

```
cd web_app
python -m http.server 8000
```

Open `http://localhost:8000/` in Chrome/Edge on the same PC.

### Option B — testing from your phone over Wi-Fi (needs HTTPS)

Your phone can't use `localhost`, so it needs a real HTTPS endpoint. Run the
bundled dev server, which generates a self-signed certificate on first run:

```
cd web_app
python serve_https.py
```

It prints something like:

```
Serving .../web_app
  Local:   https://localhost:8443/
  Network: https://192.168.1.23:8443/   <- open this on your phone
```

Open the **Network** URL on your phone (same Wi-Fi as this PC). The browser
will warn about the self-signed certificate — tap **Advanced → Proceed** (Chrome)
or **visit this website** (Safari). This is expected and safe on your own LAN.

Requires the `cryptography` package (`pip install cryptography`) the first
time it generates a cert; already installed in this environment.

> Note: Web Bluetooth is supported in Chrome/Edge on Android and desktop.
> **iOS Safari does not support Web Bluetooth** — on iPhone/iPad you'd need
> a third-party browser such as [Bluefy](https://apps.apple.com/app/bluefy-web-ble-browser/id1492822055).

### Option C — GitHub Pages (permanent HTTPS hosting) — already deployed

This app is live at **https://milegjorgjeski-cpu.github.io/ketron-sd90-remote/**
(repo: [ketron-sd90-remote](https://github.com/milegjorgjeski-cpu/ketron-sd90-remote),
served from the `master` branch root). Open that URL on your phone — it's
HTTPS by default, so Web Bluetooth works with no certificate warnings and no
need to keep your PC's server running.

Re-run `export_songs.py`, then `git add -A && git commit && git push`
whenever the song library changes.

## Installing as an app

Once served over HTTPS (or localhost), most mobile browsers offer
"Add to Home Screen" / an install icon in the address bar — this uses
`manifest.json` to install the PWA with its own icon and a standalone
(no browser chrome) window.

## BLE / SysEx protocol reference

- GATT service: `03b80e5a-ede8-4b33-a751-6ce34ec4c700` (BLE-MIDI)
- GATT characteristic: `7772e5db-3868-4112-a1a9-f2669d106bf3`
- Registration select: Bank-select CC (`0xB0|ch`) + Program Change (`0xC0|ch`),
  channel 16 (`ch=15`), bank/program computed from `reg_number`/`bank` the
  same way as `MidiController.reg_to_midi()`.
- TABS buttons — SysEx `F0 26 7C 05 00 <cmd> <val> F7`, sent as a "tap"
  (`val=0x7F` then, 50ms later, `val=0x00`):
  - `START_STOP = 0x38`, `LYRIC = 0x15`, `ENTER = 0x0D`, `EXIT = 0x0E`
- Registration step buttons use a different prefix, `F0 26 79 05 00 <cmd> <val> F7`:
  - `REGS_UP = 0x62`, `REGS_DOWN = 0x61`
