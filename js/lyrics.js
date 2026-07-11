/*
 * lyrics.js — port of main.py's _build_display_lines() / _tick() /
 * _render_lyrics() word-grouping and sync-offset logic.
 *
 * Formats (see song_library.py's syllable_mode + main.py's is_synced_word):
 *   - syllable entries (avg text length < 8 chars): grouped into words/lines
 *     here via buildDisplayLines(), then words are highlighted one at a time.
 *   - line-level entries (avg text length >= 8 chars, "midi" format): each
 *     lyrics[] entry is a whole line; word highlight position within the
 *     line is interpolated from time-to-next-line / word count.
 */

const SYNC_OFFSET_MIDI_MS = 282;  // ms app delays lyrics for MIDI/KAR songs
const SYNC_OFFSET_MP3_MS = 1400;  // ms app delays lyrics for MP3/WAV songs

// Installed Android APK (Trusted Web Activity) launches start lyrics
// noticeably earlier than the module compared to a regular browser tab.
// android-app:// is only set as document.referrer by a TWA launch, never
// by a normal browser tab (desktop or mobile), so this is a reliable check.
const TWA_EXTRA_OFFSET_MS = 3000;
const IS_TWA = document.referrer.startsWith("android-app://");
let twaOffsetLogged = false;

// Per-song-type (MIDI vs MP3) manual offset override, live-tuned via the
// +/- controls in Now Playing. Once a type has been tuned at least once,
// its stored value fully replaces that type's base (+TWA) offset — the
// user is dialing in the real correct number by ear, so we stop guessing.
const SYNC_OFFSET_STORAGE_KEYS = { midi: "sd90.syncOffset.midi", mp3: "sd90.syncOffset.mp3" };

function isSyllableMode(lyrics) {
  if (!lyrics.length) return false;
  const avgLen = lyrics.reduce((sum, l) => sum + l.text.length, 0) / lyrics.length;
  return avgLen < 8;
}

/**
 * Group syllable LyricLine entries into words, then lines. Faithful port of
 * main.py's _build_display_lines(): trailing space = word/line boundary,
 * gap > 2000ms always breaks a line, and (in syllable-not-synced-word mode)
 * a gap > 500ms with no trailing space still closes out the current word.
 */
function buildDisplayLines(lyrics) {
  const hasSpaceMarkers = lyrics.some((s) => s.text.endsWith(" ") || s.text.includes("\n"));

  let isSyncedWord = false;
  if (hasSpaceMarkers) {
    isSyncedWord = !lyrics.slice(0, -1).some((s, i) => {
      return (
        !s.text.endsWith(" ") &&
        !s.text.includes("\n") &&
        lyrics[i + 1].time_ms - s.time_ms < 500
      );
    });
  }

  const lines = [];
  let curWords = [];
  let curLineStart = null;
  let curWordParts = [];
  let curWordStart = null;

  function flushWord() {
    if (curWordParts.length) {
      curWords.push({ time_ms: curWordStart, text: curWordParts.join("") });
      curWordParts = [];
      curWordStart = null;
    }
  }
  function flushLine() {
    flushWord();
    if (curWords.length) {
      lines.push({ time_ms: curLineStart, words: curWords });
      curWords = [];
    }
    curLineStart = null;
  }

  for (let i = 0; i < lyrics.length; i++) {
    const syl = lyrics[i];
    const hasNewline = syl.text.includes("\n") || syl.text.includes("\r");
    const endsWord = syl.text.endsWith(" ") || hasNewline;
    const clean = syl.text.replace(/\r\n/g, "").replace(/\r/g, "").replace(/\n/g, "").replace(/ +$/, "");

    if (curLineStart !== null && i > 0) {
      const gap = syl.time_ms - lyrics[i - 1].time_ms;
      if (hasNewline || gap > 2000) {
        flushLine();
      } else if (!isSyncedWord && gap > 500 && curWordParts.length) {
        flushWord();
      }
    }

    if (!clean) {
      if (endsWord) flushWord();
      continue;
    }

    if (curLineStart === null) curLineStart = syl.time_ms;
    if (curWordStart === null) curWordStart = syl.time_ms;

    curWordParts.push(clean);

    if (hasSpaceMarkers) {
      if (endsWord) {
        flushWord();
      } else if (isSyncedWord) {
        flushLine();
      }
    } else {
      flushWord();
    }
  }
  flushLine();
  return lines;
}

class LyricsPlayer {
  constructor({ emptyEl, scrollEl, progressFillEl, elapsedLblEl, durationLblEl }) {
    this.emptyEl = emptyEl;
    this.scrollEl = scrollEl;
    this.progressFillEl = progressFillEl;
    this.elapsedLblEl = elapsedLblEl;
    this.durationLblEl = durationLblEl;

    this.song = null;
    this.displayLines = null;
    this.lyricsTotalMs = 0;
    this.timerRunning = false;
    this.lyricsVisible = false;
    this.syncStartTime = 0;
    this.tickHandle = null;

    this.autoNext = false; // toggled via setAutoNext(); persisted in app.js
    this.autoNextTriggered = false; // guards against re-triggering mid-song
    this.onAutoNext = null; // () => void — called once, 2000ms before track end
  }

  setAutoNext(enabled) {
    this.autoNext = enabled;
  }

  loadSong(song) {
    this.song = song;
    this.displayLines = null;
    this.lyricsTotalMs = song.lyrics.length ? song.lyrics[song.lyrics.length - 1].time_ms : 0;
    this.autoNextTriggered = false;
    this.resetTimer();
    this.progressFillEl.style.width = "0%";
    this.elapsedLblEl.textContent = "0:00";
    const totalMs = this.lyricsTotalMs || song.duration_ms || 0;
    this.durationLblEl.textContent = totalMs ? fmtTime(totalMs) : "--:--";
    this.showStatic();
  }

  _songSyncType() {
    const path = (this.song && this.song.mp3_path) || "";
    const ext = path.split(".").pop().toLowerCase();
    return ext === "mid" || ext === "kar" ? "midi" : "mp3";
  }

  _defaultSyncOffsetMs(type) {
    let offsetMs = type === "midi" ? SYNC_OFFSET_MIDI_MS : SYNC_OFFSET_MP3_MS;
    if (IS_TWA) offsetMs += TWA_EXTRA_OFFSET_MS;
    return offsetMs;
  }

  _manualSyncOffsetMs(type) {
    const raw = localStorage.getItem(SYNC_OFFSET_STORAGE_KEYS[type]);
    if (raw === null) return null;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  }

  // Read live on every tick, so adjustSyncOffset() takes effect on the
  // currently-playing song immediately — no timer restart required.
  _currentSyncOffsetMs() {
    const type = this._songSyncType();
    const manual = this._manualSyncOffsetMs(type);
    if (manual !== null) return manual;
    if (IS_TWA && !twaOffsetLogged) {
      twaOffsetLogged = true;
      if (typeof uiLog === "function") {
        uiLog(`[SYNC] TWA detected, +${TWA_EXTRA_OFFSET_MS}ms lyrics offset applied`);
      }
    }
    return this._defaultSyncOffsetMs(type);
  }

  // Nudges the live offset for the current song's type by deltaMs and
  // persists it as that type's new default going forward, replacing the
  // static base (+TWA) value entirely.
  adjustSyncOffset(deltaMs) {
    const type = this._songSyncType();
    const current = this._manualSyncOffsetMs(type);
    const base = current !== null ? current : this._defaultSyncOffsetMs(type);
    localStorage.setItem(SYNC_OFFSET_STORAGE_KEYS[type], String(base + deltaMs));
    return this.getSyncOffsetInfo();
  }

  getSyncOffsetInfo() {
    const type = this._songSyncType();
    const manual = this._manualSyncOffsetMs(type);
    return {
      type,
      isManual: manual !== null,
      effectiveMs: manual !== null ? manual : this._defaultSyncOffsetMs(type),
      baseMs: type === "midi" ? SYNC_OFFSET_MIDI_MS : SYNC_OFFSET_MP3_MS,
      twaMs: IS_TWA ? TWA_EXTRA_OFFSET_MS : 0,
    };
  }

  startTimer() {
    if (!this.song) return;
    if (this.tickHandle !== null) {
      clearTimeout(this.tickHandle);
      this.tickHandle = null;
    }
    if (!this.timerRunning) {
      this.syncStartTime = performance.now();
      this.timerRunning = true;
      this.displayLines = isSyllableMode(this.song.lyrics)
        ? buildDisplayLines(this.song.lyrics)
        : null;
    }
    this._tick();
  }

  resetTimer() {
    this.timerRunning = false;
    this.lyricsVisible = false;
    if (this.tickHandle !== null) {
      clearTimeout(this.tickHandle);
      this.tickHandle = null;
    }
  }

  setLyricsVisible(visible) {
    this.lyricsVisible = visible;
    if (visible && !this.timerRunning) this.startTimer();
    if (!visible) this.showStatic();
  }

  _tick() {
    if (!this.timerRunning) return;
    const elapsedMs = Math.max(0, performance.now() - this.syncStartTime - this._currentSyncOffsetMs());

    const totalMs = this.lyricsTotalMs || (this.song && this.song.duration_ms) || 0;
    if (totalMs > 0) {
      this.progressFillEl.style.width = `${Math.min(1, elapsedMs / totalMs) * 100}%`;
    }
    this.elapsedLblEl.textContent = fmtTime(elapsedMs);

    if (this.lyricsVisible) this._renderAnimated(elapsedMs);

    // Port of main.py's _tick() Auto Next trigger: fires once, 2000ms before
    // the track ends, using raw (non-offset-adjusted) elapsed time against
    // duration_ms minus the sync offset — same formula as desktop.
    if (this.autoNext && !this.autoNextTriggered && this.song && this.song.duration_ms) {
      const elapsed = performance.now() - this.syncStartTime;
      const remaining = this.song.duration_ms - elapsed - this._currentSyncOffsetMs();
      if (remaining <= 2000) {
        this.autoNextTriggered = true;
        this.resetTimer();
        if (this.onAutoNext) this.onAutoNext();
        return;
      }
    }

    this.tickHandle = setTimeout(() => this._tick(), 33);
  }

  showStatic() {
    const lyrics = (this.song && this.song.lyrics) || [];
    if (!lyrics.length) {
      this.emptyEl.hidden = false;
      this.scrollEl.hidden = true;
      this.scrollEl.innerHTML = "";
      return;
    }
    this.emptyEl.hidden = true;
    this.scrollEl.hidden = false;

    const syllableMode = isSyllableMode(lyrics);
    const lines = syllableMode ? buildDisplayLines(lyrics) : lyrics.map((l) => ({ text: l.text }));

    this.scrollEl.innerHTML = "";
    for (const line of lines) {
      const text = syllableMode ? line.words.map((w) => w.text).join(" ") : line.text;
      const div = document.createElement("div");
      div.className = "lyric-line";
      div.textContent = text;
      this.scrollEl.appendChild(div);
    }
  }

  _renderAnimated(elapsedMs) {
    const isSyl = isSyllableMode(this.song.lyrics) && this.displayLines !== null;
    const items = isSyl ? this.displayLines : this.song.lyrics;
    if (!items.length) return;

    const itemText = (item) => (isSyl ? item.words.map((w) => w.text).join(" ") : item.text);

    let currentIdx = -1;
    for (let i = 0; i < items.length; i++) {
      if (items[i].time_ms <= elapsedMs) currentIdx = i;
      else break;
    }

    this.scrollEl.innerHTML = "";

    if (currentIdx < 0) {
      const upcoming = items.slice(0, 5);
      upcoming.forEach((item, i) => {
        const div = document.createElement("div");
        div.className = "lyric-line" + (i === 0 ? " is-near" : "");
        div.textContent = itemText(item);
        this.scrollEl.appendChild(div);
      });
      return;
    }

    const pastStart = Math.max(0, currentIdx - 3);
    for (let i = pastStart; i < currentIdx; i++) {
      const dist = currentIdx - i;
      const div = document.createElement("div");
      div.className = "lyric-line" + (dist === 1 ? " is-near" : "");
      div.textContent = itemText(items[i]);
      this.scrollEl.appendChild(div);
    }

    const curLine = document.createElement("div");
    curLine.className = "lyric-line is-current";

    if (isSyl) {
      const cur = items[currentIdx];
      let curWordIdx = -1;
      for (let wi = 0; wi < cur.words.length; wi++) {
        if (cur.words[wi].time_ms <= elapsedMs) curWordIdx = wi;
        else break;
      }
      cur.words.forEach((word, wi) => {
        const span = document.createElement("span");
        span.className =
          "lyric-word " + (wi === curWordIdx ? "is-active" : wi < curWordIdx ? "is-sung" : "is-upcoming");
        span.textContent = (wi > 0 ? " " : "") + word.text;
        curLine.appendChild(span);
      });
    } else {
      const line = items[currentIdx];
      const lyrics = this.song.lyrics;
      const nextTimeMs = currentIdx + 1 < lyrics.length ? lyrics[currentIdx + 1].time_ms : line.time_ms + 5000;
      const words = line.text.split(/\s+/).filter(Boolean);
      if (words.length) {
        const lineDuration = Math.max(nextTimeMs - line.time_ms, 1);
        const wordDuration = lineDuration / words.length;
        const elapsedInLine = elapsedMs - line.time_ms;
        const wordIdx = Math.min(Math.floor(elapsedInLine / (wordDuration * 0.8)), words.length - 1);
        words.forEach((word, j) => {
          const span = document.createElement("span");
          span.className = "lyric-word " + (j === wordIdx ? "is-active" : "is-upcoming");
          span.textContent = (j > 0 ? " " : "") + word;
          curLine.appendChild(span);
        });
      } else {
        curLine.textContent = line.text;
      }
    }
    this.scrollEl.appendChild(curLine);
    curLine.scrollIntoView({ block: "center" });

    const nextEnd = Math.min(items.length - 1, currentIdx + 4);
    for (let i = currentIdx + 1; i <= nextEnd; i++) {
      const dist = i - currentIdx;
      const div = document.createElement("div");
      div.className = "lyric-line" + (dist === 1 ? " is-near" : "");
      div.textContent = itemText(items[i]);
      this.scrollEl.appendChild(div);
    }
  }
}

function fmtTime(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
