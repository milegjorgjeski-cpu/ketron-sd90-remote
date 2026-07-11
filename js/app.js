/* app.js — song list, bottom-nav navigation, and BLE/lyrics wiring. */

(async function () {
  const ble = new KetronBLE();

  // Debug hooks for chrome://inspect remote debugging — trigger single
  // commands from DevTools console and watch the [BLE TX] logs directly.
  window.ble = ble;
  window.debugSendRegsUp = () => ble.regsUp();
  window.debugSendPC = (reg, bank) => ble.sendRegistrationNumber(reg, bank);

  const els = {
    btnConn: document.getElementById("btnConn"),
    connDot: document.getElementById("connDot"),
    connLabel: document.getElementById("connLabel"),
    topBadge: document.getElementById("topBadge"),
    bleWarning: document.getElementById("bleWarning"),
    btnDismissWarning: document.getElementById("btnDismissWarning"),

    btnToggleDebug: document.getElementById("btnToggleDebug"),
    debugPanel: document.getElementById("debugPanel"),
    debugLog: document.getElementById("debugLog"),
    btnClearDebug: document.getElementById("btnClearDebug"),
    btnCloseDebug: document.getElementById("btnCloseDebug"),

    btnBack: document.getElementById("btnBack"),
    npTitle: document.getElementById("npTitle"),
    npArtist: document.getElementById("npArtist"),
    lyricsEmpty: document.getElementById("lyricsEmpty"),
    lyricsScroll: document.getElementById("lyricsScroll"),
    progressFill: document.getElementById("progressFill"),
    elapsedLbl: document.getElementById("elapsedLbl"),
    durationLbl: document.getElementById("durationLbl"),
    syncOffsetLabel: document.getElementById("syncOffsetLabel"),
    btnSyncOffsetDown: document.getElementById("btnSyncOffsetDown"),
    btnSyncOffsetUp: document.getElementById("btnSyncOffsetUp"),
    btnPlay: document.getElementById("btnPlay"),
    btnLyrics: document.getElementById("btnLyrics"),

    setIndicator: document.getElementById("setIndicator"),
    setIndicatorText: document.getElementById("setIndicatorText"),
    btnSetPrev: document.getElementById("btnSetPrev"),
    btnSetNext: document.getElementById("btnSetNext"),

    setPlayingView: document.getElementById("setPlayingView"),
    btnSetPlayingBack: document.getElementById("btnSetPlayingBack"),
    setPlayingName: document.getElementById("setPlayingName"),
    setPlayingCount: document.getElementById("setPlayingCount"),
    setPlayingList: document.getElementById("setPlayingList"),
    btnSetPlayFromStart: document.getElementById("btnSetPlayFromStart"),
    btnSetPlayingEdit: document.getElementById("btnSetPlayingEdit"),
    btnSetPlayingAllSets: document.getElementById("btnSetPlayingAllSets"),

    searchInput: document.getElementById("searchInput"),
    bankFilters: document.getElementById("bankFilters"),
    songCount: document.getElementById("songCount"),
    songList: document.getElementById("songList"),

    setsListView: document.getElementById("setsListView"),
    setEditorView: document.getElementById("setEditorView"),
    setsList: document.getElementById("setsList"),
    btnSetEditorBack: document.getElementById("btnSetEditorBack"),
    setNameInput: document.getElementById("setNameInput"),
    setOrderList: document.getElementById("setOrderList"),
    setSongCount: document.getElementById("setSongCount"),
    setSearchInput: document.getElementById("setSearchInput"),
    setBankFilters: document.getElementById("setBankFilters"),
    setPickerList: document.getElementById("setPickerList"),
    btnDeleteSet: document.getElementById("btnDeleteSet"),
    btnSaveSet: document.getElementById("btnSaveSet"),

    btnRegUp: document.getElementById("btnRegUp"),
    btnRegDown: document.getElementById("btnRegDown"),
    btnEnter: document.getElementById("btnEnter"),
    btnExit: document.getElementById("btnExit"),
    btnXfade: document.getElementById("btnXfade"),
    btnAutoNext: document.getElementById("btnAutoNext"),
    btnSync: document.getElementById("btnSync"),
    deviceName: document.getElementById("deviceName"),

    toast: document.getElementById("toast"),
    navItems: document.querySelectorAll(".nav-item"),
    screens: document.querySelectorAll(".screen"),
    screensWrap: document.getElementById("screensWrap"),
  };

  const player = new LyricsPlayer({
    emptyEl: els.lyricsEmpty,
    scrollEl: els.lyricsScroll,
    progressFillEl: els.progressFill,
    elapsedLblEl: els.elapsedLbl,
    durationLblEl: els.durationLbl,
  });

  let songs = [];
  let filteredSongs = [];
  let activeBank = "all";
  let selectedSong = null;
  let isPlaying = false;
  let lyricsOn = false;

  // ── Sets (playlists) ────────────────────────────────────────────────────
  const SETS_KEY = "sd90.sets";
  let sets = [];
  let activeSet = null; // { id, name, songs } — the set currently loaded as the queue
  let activeSetIndex = -1; // index of the current song within activeSet.songs
  let viewingSet = null; // set currently shown in the browse/song-list overlay — may differ from activeSet
  let editingSet = null; // draft being edited in the set editor (deep-cloned)
  let isNewSet = false;
  let setPickerBank = "all";
  let setPickerFiltered = [];
  let deleteConfirmPending = false;
  let deleteConfirmTimer = null;

  // Short-lived ignore window after our own sends, mirroring main.py's
  // _ignore_midi_input — avoids treating our own PC send as an incoming
  // module-driven registration change (echo loop).
  let ignoreMidiInput = false;
  let lastPlayerStartMs = 0;

  // ── Toast ──────────────────────────────────────────────────────────────
  let toastTimer = null;
  function showToast(msg, isError = false) {
    els.toast.textContent = msg;
    els.toast.className = "toast show" + (isError ? " error" : "");
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      els.toast.classList.remove("show");
      setTimeout(() => (els.toast.hidden = true), 250);
    }, 2200);
  }

  // ── Bottom-nav navigation ─────────────────────────────────────────────
  // animateDir: +1 when arriving via a left swipe (next screen), -1 via a
  // right swipe (previous screen); omitted for plain tap nav (no animation).
  function showScreen(name, animateDir) {
    els.screens.forEach((s) => s.classList.toggle("active", s.id === "screen" + capitalize(name)));
    els.navItems.forEach((n) => n.classList.toggle("active", n.dataset.screen === name));

    if (animateDir) {
      const active = document.getElementById("screen" + capitalize(name));
      if (active) {
        active.style.setProperty("--swipe-from", animateDir > 0 ? "24px" : "-24px");
        active.classList.remove("swipe-enter");
        void active.offsetWidth; // restart animation
        active.classList.add("swipe-enter");
        active.addEventListener("animationend", () => active.classList.remove("swipe-enter"), { once: true });
      }
    }

    // Arriving at Songs with a song already active shouldn't require manual
    // scrolling to find it — every row already exists in the DOM (the list
    // isn't lazy/batched), so this just needs to run the same highlight+
    // scroll used elsewhere (e.g. selectSong's scrollToSong option).
    if (name === "songs") {
      updateActiveSongHighlight({ scroll: true });
    }
  }
  function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  els.navItems.forEach((btn) => {
    btn.addEventListener("click", () => {
      const screen = btn.dataset.screen;
      // Tapping "Sets" while a set is actively playing jumps straight to its
      // scoped song list (same view as tapping the set card) instead of the
      // top-level sets list — avoids re-finding the active set every time.
      if (screen === "sets" && activeSet) {
        openSetPlayingView(activeSet);
        return;
      }
      if (els.setPlayingView.classList.contains("visible")) closeSetPlayingView();
      showScreen(screen);
    });
  });
  els.btnBack.addEventListener("click", () => {
    stopPlayback(false);
    showScreen("songs");
  });

  // ── Swipe navigation between the four main screens ─────────────────────
  // Same fixed order as the bottom nav: Now Playing, Songs, Sets, More.
  const SCREEN_ORDER = ["now", "songs", "sets", "more"];
  const SWIPE_INTENT_PX = 18; // early "this is a horizontal drag" threshold
  const SWIPE_COMMIT_PX = 60; // distance that commits a screen change
  const SWIPE_COMMIT_VELOCITY = 0.3; // px/ms — a fast flick commits even if short

  function swipeableNow() {
    // Don't hijack gestures over the full-screen set editor, the set-playing
    // scoped overlay, or the debug panel — only the four bottom-nav screens
    // participate in swipe navigation.
    if (!els.setEditorView.hidden) return false;
    if (els.setPlayingView.classList.contains("visible")) return false;
    if (els.debugPanel.classList.contains("visible")) return false;
    return true;
  }

  function activeScreenInfo() {
    const el = document.querySelector(".screen.active");
    const idx = el ? SCREEN_ORDER.indexOf(el.id.replace("screen", "").toLowerCase()) : -1;
    return { el, idx };
  }

  let swipeStart = null; // { x, y, id, t }
  let swipeIntentLocked = false; // horizontal-drag intent confirmed for this gesture
  let swipeEl = null; // the active screen element currently being dragged

  els.screensWrap.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (!swipeableNow()) return;
    swipeStart = { x: e.clientX, y: e.clientY, id: e.pointerId, t: performance.now() };
    swipeIntentLocked = false;
    swipeEl = null;
  });

  els.screensWrap.addEventListener("pointermove", (e) => {
    if (!swipeStart || e.pointerId !== swipeStart.id) return;
    const dx = e.clientX - swipeStart.x;
    const dy = e.clientY - swipeStart.y;

    if (!swipeIntentLocked) {
      // Still ambiguous — leave vertical list/lyrics scrolling alone until
      // the drag is clearly horizontal.
      if (Math.abs(dx) > Math.abs(dy) * 1.5 && Math.abs(dx) > SWIPE_INTENT_PX) {
        if (!swipeableNow()) { swipeStart = null; return; }
        const { el, idx } = activeScreenInfo();
        if (idx === -1) { swipeStart = null; return; }
        swipeIntentLocked = true;
        swipeEl = el;
        swipeEl.style.transition = "none";
        try { els.screensWrap.setPointerCapture(e.pointerId); } catch {}
      } else {
        return;
      }
    }

    // Intent locked for the rest of this gesture — track the finger 1:1.
    e.preventDefault();
    swipeEl.style.transform = `translateX(${dx}px)`;
  });

  function finishSwipe(el, dir, curIdx) {
    const width = els.screensWrap.clientWidth || window.innerWidth;
    el.style.transition = "transform 130ms ease";
    el.style.transform = `translateX(${dir > 0 ? -width : width}px)`;
    let done = false;
    const advance = () => {
      if (done) return;
      done = true;
      el.removeEventListener("transitionend", advance);
      clearTimeout(fallback);
      el.style.transition = "";
      el.style.transform = "";
      showScreen(SCREEN_ORDER[curIdx + dir], dir);
    };
    el.addEventListener("transitionend", advance, { once: true });
    const fallback = setTimeout(advance, 180); // in case transitionend doesn't fire
  }

  function snapBack(el) {
    el.style.transition = "transform 150ms ease";
    requestAnimationFrame(() => { el.style.transform = "translateX(0)"; });
    let done = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      el.removeEventListener("transitionend", cleanup);
      clearTimeout(fallback);
      el.style.transition = "";
      el.style.transform = "";
    };
    el.addEventListener("transitionend", cleanup, { once: true });
    const fallback = setTimeout(cleanup, 200);
  }

  function endSwipe(e) {
    if (!swipeStart || e.pointerId !== swipeStart.id) return;
    const wasLocked = swipeIntentLocked;
    const el = swipeEl;
    const dx = e.clientX - swipeStart.x;
    const dt = Math.max(1, performance.now() - swipeStart.t);
    swipeStart = null;
    swipeIntentLocked = false;
    swipeEl = null;
    if (!wasLocked || !el) return; // plain tap or a vertical scroll — nothing to unwind

    const velocity = Math.abs(dx) / dt; // px/ms
    const { idx: curIdx } = activeScreenInfo();
    const dir = dx < 0 ? 1 : -1; // left swipe → next screen, right swipe → previous
    const nextIdx = curIdx + dir;
    const inRange = nextIdx >= 0 && nextIdx < SCREEN_ORDER.length;
    const committed = inRange && (Math.abs(dx) > SWIPE_COMMIT_PX || velocity > SWIPE_COMMIT_VELOCITY);

    if (committed) {
      finishSwipe(el, dir, curIdx);
    } else {
      snapBack(el);
    }
  }
  els.screensWrap.addEventListener("pointerup", endSwipe);
  els.screensWrap.addEventListener("pointercancel", () => {
    if (swipeIntentLocked && swipeEl) snapBack(swipeEl);
    swipeStart = null;
    swipeIntentLocked = false;
    swipeEl = null;
  });

  // ── BLE connection ─────────────────────────────────────────────────────
  let warningDismissed = false;
  function updateBleWarning(status) {
    els.bleWarning.classList.toggle("visible", status !== "connected" && !warningDismissed);
  }
  els.btnDismissWarning.addEventListener("click", () => {
    warningDismissed = true;
    els.bleWarning.classList.remove("visible");
  });

  // ── Debug panel ─────────────────────────────────────────────────────────
  // Single source of truth for show/hide — every trigger (toggle button,
  // close button, outside tap, swipe-down) routes through this.
  function setDebugPanelVisible(visible) {
    els.debugPanel.classList.toggle("visible", visible);
  }

  els.btnToggleDebug.addEventListener("click", () => {
    setDebugPanelVisible(!els.debugPanel.classList.contains("visible"));
  });
  els.btnCloseDebug.addEventListener("click", () => {
    setDebugPanelVisible(false);
  });
  els.btnClearDebug.addEventListener("click", () => {
    els.debugLog.textContent = "";
  });

  // Fallback: tap anywhere outside the panel closes it.
  document.addEventListener("click", (e) => {
    if (!els.debugPanel.classList.contains("visible")) return;
    if (els.debugPanel.contains(e.target) || e.target === els.btnToggleDebug) return;
    setDebugPanelVisible(false);
  });

  // Fallback: swipe down on the header closes it (avoids hijacking log scroll).
  const debugHeader = els.debugPanel.querySelector(".debug-header");
  let debugTouchStartY = null;
  debugHeader.addEventListener("touchstart", (e) => {
    debugTouchStartY = e.touches[0].clientY;
  }, { passive: true });
  debugHeader.addEventListener("touchend", (e) => {
    if (debugTouchStartY === null) return;
    const dy = e.changedTouches[0].clientY - debugTouchStartY;
    debugTouchStartY = null;
    if (dy > 40) setDebugPanelVisible(false);
  });

  ble.onStatusChange = (status, detail) => {
    els.connDot.className = "dot " + status;
    if (status === "connected") {
      els.connLabel.textContent = detail || "Connected";
      els.deviceName.textContent = detail || "Connected";
    } else if (status === "connecting") {
      els.connLabel.textContent = detail || "Connecting…";
    } else {
      els.connLabel.textContent = "Not connected";
      els.deviceName.textContent = "none";
    }
    updateBleWarning(status);
  };

  els.btnConn.addEventListener("click", async () => {
    if (ble.isConnected) {
      ble.disconnect();
      return;
    }
    try {
      await ble.connect();
      showToast("Connected to SD90");
    } catch (err) {
      showToast(err.message || "BLE connection failed", true);
    }
  });

  async function guardedBleCall(fn, label) {
    if (!ble.isConnected) {
      showToast("Connect a MIDI device first.", true);
      return;
    }
    try {
      await fn();
    } catch (err) {
      showToast(`${label} failed: ${err.message}`, true);
    }
  }

  // ── Load songs.json ────────────────────────────────────────────────────
  async function loadSongs() {
    const res = await fetch("songs.json");
    songs = await res.json();
    buildBankFilters();
    applyFilters();
  }

  // Generic bank-chip filter builder — reused for both the main song list
  // and the set-editor's song picker, which need their own independent
  // active-bank state.
  function buildBankFilterChips(container, getActive, setActive, onChange) {
    const banks = Array.from(new Set(songs.map((s) => s.bank))).sort((a, b) => {
      const an = Number(a), bn = Number(b);
      if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
      return String(a).localeCompare(String(b));
    });
    function makeChip(value, label) {
      const chip = document.createElement("button");
      chip.className = "bank-chip" + (value === getActive() ? " active" : "");
      chip.textContent = label;
      chip.addEventListener("click", () => {
        setActive(value);
        container.querySelectorAll(".bank-chip").forEach((c) => c.classList.remove("active"));
        chip.classList.add("active");
        onChange();
      });
      return chip;
    }
    container.innerHTML = "";
    container.appendChild(makeChip("all", "All"));
    for (const b of banks) container.appendChild(makeChip(b, `Bank ${b}`));
  }

  function buildBankFilters() {
    buildBankFilterChips(els.bankFilters, () => activeBank, (v) => (activeBank = v), applyFilters);
  }

  function applyFilters() {
    const q = els.searchInput.value.trim().toLowerCase();
    filteredSongs = songs.filter((s) => {
      if (activeBank !== "all" && String(s.bank) !== String(activeBank)) return false;
      if (!q) return true;
      return (s.title || "").toLowerCase().includes(q) || (s.artist || "").toLowerCase().includes(q);
    });
    renderSongList();
  }
  els.searchInput.addEventListener("input", applyFilters);

  function renderSongList() {
    els.songCount.textContent = `${filteredSongs.length} song${filteredSongs.length === 1 ? "" : "s"}`;
    els.songList.innerHTML = "";
    if (!filteredSongs.length) {
      const li = document.createElement("li");
      li.className = "empty-msg";
      li.textContent = "No songs match your search.";
      els.songList.appendChild(li);
      return;
    }
    const frag = document.createDocumentFragment();
    for (const song of filteredSongs) frag.appendChild(makeSongCard(song));
    els.songList.appendChild(frag);
  }

  function makeSongCard(song) {
    const li = document.createElement("li");
    li.className = "song-card" + (isActiveSong(song) ? " is-active" : "");
    li.dataset.reg = song.reg_number;
    li.dataset.bank = song.bank;

    const reg = document.createElement("div");
    reg.className = "song-reg";
    reg.textContent = song.reg_number != null ? "#" + song.reg_number : "—";

    const info = document.createElement("div");
    info.className = "song-info";
    const title = document.createElement("p");
    title.className = "song-title";
    title.textContent = song.title || "Untitled";
    const artist = document.createElement("p");
    artist.className = "song-artist";
    artist.textContent = song.artist || "Unknown artist";
    info.append(title, artist);

    const flag = document.createElement("div");
    flag.className = "song-lyrics-flag" + ((song.lyrics || []).length ? " has-lyrics" : "");
    flag.textContent = "♪";

    li.append(reg, info, flag);
    li.addEventListener("click", () => selectSong(song, { autoplay: true }));
    return li;
  }

  // ── Active song highlighting (Songs list) ───────────────────────────────
  function isActiveSong(song) {
    return !!selectedSong &&
      Number(song.reg_number) === Number(selectedSong.reg_number) &&
      Number(song.bank) === Number(selectedSong.bank);
  }

  function updateActiveSongHighlight({ scroll = false } = {}) {
    let activeRow = null;
    els.songList.querySelectorAll(".song-card").forEach((row) => {
      const match = !!selectedSong &&
        Number(row.dataset.reg) === Number(selectedSong.reg_number) &&
        Number(row.dataset.bank) === Number(selectedSong.bank);
      row.classList.toggle("is-active", match);
      if (match) activeRow = row;
    });
    if (scroll && activeRow) {
      activeRow.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }

  // ── Song selection ─────────────────────────────────────────────────────
  // sendMidi=false is used for module-driven sync (a registration change
  // arrived over BLE) — the module already changed, so we only update the UI.
  // autoplay=true is used for module-driven sync and Auto Next: the module's
  // own autoplay kicks in on a PC/registration change, so app state (play
  // button, timer, lyrics) is set to match immediately, same as main.py's
  // _select_song()/_on_sd90_program_change().
  async function selectSong(song, { sendMidi = true, autoplay = false, fromSet = false, scrollToSong = false, preserveScreen = false } = {}) {
    if (!fromSet) {
      activeSet = null;
      activeSetIndex = -1;
    }
    selectedSong = song;
    updateSetIndicator();
    updateActiveSongHighlight({ scroll: scrollToSong });
    stopPlayback(false);
    player.loadSong(song);
    updateSyncOffsetLabel();

    els.npTitle.textContent = song.title || "Untitled";
    els.npArtist.textContent = song.artist || "Unknown artist";
    els.topBadge.hidden = false;
    els.topBadge.textContent = `Bank ${song.bank ?? "—"} · Reg ${song.reg_number ?? "—"}`;

    // Auto Next passes preserveScreen when the user is browsing this same set
    // in #setPlayingView — don't yank them to Now Playing mid-set, just let
    // the highlight update (already done above via updateSetIndicator()).
    if (!preserveScreen) showScreen("now");

    function beginAutoplay() {
      setPlayingUi(true);
      player.startTimer();
      if ((song.lyrics || []).length) {
        setLyricsUi(true);
        player.setLyricsVisible(true);
      }
    }

    if (!sendMidi) {
      if (autoplay) beginAutoplay();
      return;
    }

    if (song.reg_number == null) return;
    if (!ble.isConnected) {
      showToast("Connect a MIDI device to load this song on the keyboard.", true);
      return;
    }
    ignoreMidiInput = true;
    try {
      await ble.sendRegistrationNumber(song.reg_number, Number(song.bank) || 1);
      if (autoplay) beginAutoplay();
    } catch (err) {
      showToast(`Program change failed: ${err.message}`, true);
    } finally {
      setTimeout(() => { ignoreMidiInput = false; }, 500);
    }
  }

  // ── Module -> app sync (bidirectional) ──────────────────────────────────
  ble.onRegistrationChange = (bankMsb, program) => {
    if (ignoreMidiInput) return;
    uiLog(`[BLE RX] reg change: bank=${bankMsb} program=${program}`);
    const song = songs.find((s) => {
      if (s.reg_number == null) return false;
      const { bankMsb: cc, program: pc } = KetronBLE.regToMidi(s.reg_number, Number(s.bank) || 1);
      return cc === bankMsb && pc === program;
    });
    if (!song) return;
    showToast(`Synced from module: ${song.title || "Untitled"}`);
    selectSong(song, { sendMidi: false, autoplay: true, scrollToSong: true });
  };

  ble.onPlayerStart = () => {
    if (ignoreMidiInput) return;
    const now = performance.now();
    if (now - lastPlayerStartMs < 500) return;
    lastPlayerStartMs = now;
    if (!isPlaying && selectedSong) {
      setPlayingUi(true);
      player.startTimer();
    }
  };

  // ── Auto Next ────────────────────────────────────────────────────────────
  const AUTO_NEXT_KEY = "sd90.autoNext";
  player.setAutoNext(localStorage.getItem(AUTO_NEXT_KEY) === "1");
  if (els.btnAutoNext) {
    els.btnAutoNext.classList.toggle("is-on", player.autoNext);
    els.btnAutoNext.addEventListener("click", () => {
      const enabled = !player.autoNext;
      player.setAutoNext(enabled);
      localStorage.setItem(AUTO_NEXT_KEY, enabled ? "1" : "0");
      els.btnAutoNext.classList.toggle("is-on", enabled);
    });
  }

  // ── Live lyrics sync offset (per song-type, tuned by ear during playback) ─
  function updateSyncOffsetLabel() {
    if (!els.syncOffsetLabel) return;
    const info = player.getSyncOffsetInfo();
    if (info.isManual) {
      els.syncOffsetLabel.textContent = `Lyrics sync: ${info.effectiveMs}ms (tuned)`;
    } else if (info.twaMs) {
      els.syncOffsetLabel.textContent = `Lyrics sync: ${info.baseMs}ms + ${info.twaMs}ms TWA = ${info.effectiveMs}ms`;
    } else {
      els.syncOffsetLabel.textContent = `Lyrics sync: ${info.effectiveMs}ms`;
    }
  }
  if (els.btnSyncOffsetDown && els.btnSyncOffsetUp) {
    els.btnSyncOffsetDown.addEventListener("click", () => {
      player.adjustSyncOffset(-50);
      updateSyncOffsetLabel();
    });
    els.btnSyncOffsetUp.addEventListener("click", () => {
      player.adjustSyncOffset(50);
      updateSyncOffsetLabel();
    });
  }
  updateSyncOffsetLabel();

  player.onAutoNext = () => {
    // Set-aware: if a set is currently loaded as the queue, Auto Next walks
    // its order instead of the full filtered song list.
    if (activeSet && activeSet.songs.length) {
      const idx = Math.min(activeSetIndex + 1, activeSet.songs.length - 1);
      const song = resolveSetSong(activeSet.songs[idx]);
      // If the user is browsing this same set in #setPlayingView, keep them
      // there — just advance the highlight — instead of yanking them to Now
      // Playing. Manual bottom-nav taps still close the overlay as before;
      // this only covers the automatic advance.
      const stayInSetPlayingView =
        els.setPlayingView.classList.contains("visible") &&
        !!viewingSet && viewingSet.id === activeSet.id;
      activeSetIndex = idx;
      if (song) {
        selectSong(song, {
          sendMidi: true,
          autoplay: true,
          fromSet: true,
          scrollToSong: true,
          preserveScreen: stayInSetPlayingView,
        });
      }
      return;
    }
    const list = filteredSongs.length ? filteredSongs : songs;
    if (!list.length) return;
    let idx = selectedSong ? list.indexOf(selectedSong) : -1;
    idx = idx === -1 ? 0 : idx + 1;
    idx = Math.max(0, Math.min(idx, list.length - 1));
    selectSong(list[idx], { sendMidi: true, autoplay: true, scrollToSong: true });
  };

  // ── Sets (playlists) ─────────────────────────────────────────────────────
  function loadSets() {
    try {
      const raw = localStorage.getItem(SETS_KEY);
      sets = raw ? JSON.parse(raw) : [];
    } catch (err) {
      sets = [];
    }
  }
  function persistSets() {
    localStorage.setItem(SETS_KEY, JSON.stringify(sets));
  }

  function resolveSetSong(entry) {
    return songs.find((s) =>
      Number(s.reg_number) === Number(entry.reg_number) && Number(s.bank) === Number(entry.bank)
    );
  }

  // Sums duration_ms across a set's entries via the same resolveSetSong
  // lookup used for playback. Songs with missing/zero duration count as 0
  // toward the total, but flip `missing` so callers can mark the total as a
  // lower bound (e.g. "~34:12").
  function computeSetDuration(entries) {
    let totalMs = 0;
    let missing = false;
    for (const entry of entries) {
      const song = resolveSetSong(entry);
      const ms = song && Number(song.duration_ms);
      if (ms) totalMs += ms;
      else missing = true;
    }
    return { totalMs, missing };
  }

  function formatDuration(ms) {
    const totalSec = Math.round(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
    const ss = String(s).padStart(2, "0");
    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }

  // Builds the "· mm:ss" (or "· ~mm:ss") suffix for a song-count label.
  // Returns "" for an empty set so callers can omit the separator entirely.
  function setDurationSuffix(entries) {
    if (!entries.length) return "";
    const { totalMs, missing } = computeSetDuration(entries);
    return ` · ${missing ? "~" : ""}${formatDuration(totalMs)}`;
  }

  function updateSetIndicator() {
    if (!activeSet || !activeSet.songs.length) {
      els.setIndicator.hidden = true;
      return;
    }
    els.setIndicator.hidden = false;
    els.setIndicatorText.textContent =
      `Set: ${activeSet.name || "Untitled set"} - song ${activeSetIndex + 1} of ${activeSet.songs.length}`;
    els.btnSetPrev.disabled = activeSetIndex <= 0;
    els.btnSetNext.disabled = activeSetIndex >= activeSet.songs.length - 1;
    if (els.setPlayingView.classList.contains("visible")) {
      updateSetPlayingHighlight({ scroll: true });
    }
  }

  function playSet(set) {
    if (!set.songs.length) {
      showToast("This set has no songs yet.", true);
      return;
    }
    activeSet = set;
    activeSetIndex = 0;
    const song = resolveSetSong(set.songs[0]);
    if (!song) {
      showToast("First song in this set was not found in the song list.", true);
      return;
    }
    selectSong(song, { autoplay: true, fromSet: true, scrollToSong: true });
  }

  function setAdvance(direction) {
    if (!activeSet || !activeSet.songs.length) return;
    const idx = Math.max(0, Math.min(activeSetIndex + direction, activeSet.songs.length - 1));
    if (idx === activeSetIndex) return;
    const song = resolveSetSong(activeSet.songs[idx]);
    activeSetIndex = idx;
    if (song) selectSong(song, { autoplay: true, fromSet: true, scrollToSong: true });
  }
  els.btnSetPrev.addEventListener("click", () => setAdvance(-1));
  els.btnSetNext.addEventListener("click", () => setAdvance(1));

  // ── Set browse view (full-screen overlay) ────────────────────────────────
  // Mirrors the main Songs list's row markup and active-song highlight/
  // scroll-into-view behavior, but scoped to a single set's songs in play
  // order. Reached two ways: tapping a set card (browse any set, no
  // autoplay) or tapping the "Set: ..." indicator in Now Playing (view the
  // currently active set). Both share this one view via `viewingSet`, which
  // is independent of `activeSet` (the set actually driving playback).
  function openSetPlayingView(set) {
    const target = set || activeSet;
    if (!target || !target.songs.length) {
      if (set) showToast("This set has no songs yet.", true);
      return;
    }
    viewingSet = target;
    renderSetPlayingList();
    els.setPlayingView.classList.add("visible");
  }
  function closeSetPlayingView() {
    els.setPlayingView.classList.remove("visible");
    viewingSet = null;
  }
  els.setIndicatorText.addEventListener("click", () => openSetPlayingView());
  els.btnSetPlayingBack.addEventListener("click", closeSetPlayingView);

  els.btnSetPlayFromStart.addEventListener("click", () => {
    if (!viewingSet) return;
    const set = viewingSet;
    closeSetPlayingView();
    playSet(set);
  });
  els.btnSetPlayingEdit.addEventListener("click", () => {
    if (!viewingSet) return;
    const set = viewingSet;
    closeSetPlayingView();
    showScreen("sets");
    openSetEditor(set);
  });
  // Escape hatch back to the top-level sets list when the bottom-nav "Sets"
  // tap is routing here because a set is active — doesn't touch playback,
  // just swaps which screen/view is shown.
  els.btnSetPlayingAllSets.addEventListener("click", () => {
    closeSetPlayingView();
    showScreen("sets");
  });

  function renderSetPlayingList() {
    els.setPlayingName.textContent = viewingSet.name || "Untitled set";
    els.setPlayingCount.textContent =
      `${viewingSet.songs.length} song${viewingSet.songs.length === 1 ? "" : "s"}` +
      setDurationSuffix(viewingSet.songs);
    els.setPlayingList.innerHTML = "";
    const frag = document.createDocumentFragment();
    viewingSet.songs.forEach((entry, idx) => frag.appendChild(makeSetPlayingRow(entry, idx)));
    els.setPlayingList.appendChild(frag);
    updateSetPlayingHighlight({ scroll: true });
  }

  function makeSetPlayingRow(entry, idx) {
    const song = resolveSetSong(entry);
    const li = document.createElement("li");
    li.className = "song-card";
    li.dataset.index = String(idx);

    const reg = document.createElement("div");
    reg.className = "song-reg";
    reg.textContent = entry.reg_number != null ? "#" + entry.reg_number : "—";

    const info = document.createElement("div");
    info.className = "song-info";
    const title = document.createElement("p");
    title.className = "song-title";
    title.textContent = song ? song.title || "Untitled" : `Reg ${entry.reg_number} (Bank ${entry.bank})`;
    const artist = document.createElement("p");
    artist.className = "song-artist";
    artist.textContent = song ? song.artist || "Unknown artist" : "Song not found in library";
    info.append(title, artist);

    const flag = document.createElement("div");
    flag.className = "song-lyrics-flag" + ((song && song.lyrics || []).length ? " has-lyrics" : "");
    flag.textContent = "♪";

    li.append(reg, info, flag);
    li.addEventListener("click", () => jumpToSetIndex(idx));
    return li;
  }

  function updateSetPlayingHighlight({ scroll = false } = {}) {
    const isViewingActiveSet = !!activeSet && !!viewingSet && activeSet.id === viewingSet.id;
    let activeRow = null;
    els.setPlayingList.querySelectorAll(".song-card").forEach((row) => {
      const match = isViewingActiveSet && Number(row.dataset.index) === activeSetIndex;
      row.classList.toggle("is-active", match);
      if (match) activeRow = row;
    });
    if (scroll && activeRow) {
      activeRow.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }

  // Clicking a row makes the browsed set the active set and jumps to that
  // song, same as a normal song click — but stays on this view so the user
  // can keep picking songs, so it deliberately does not close the overlay.
  function jumpToSetIndex(idx) {
    if (!viewingSet || idx < 0 || idx >= viewingSet.songs.length) return;
    const song = resolveSetSong(viewingSet.songs[idx]);
    activeSet = viewingSet;
    activeSetIndex = idx;
    if (song) {
      selectSong(song, { autoplay: true, fromSet: true, scrollToSong: true });
    } else {
      updateSetIndicator();
      showToast("Song not found in library", true);
    }
  }

  // ── Sets list screen ─────────────────────────────────────────────────────
  function renderSetsList() {
    els.setsList.innerHTML = "";
    if (!sets.length) {
      const p = document.createElement("p");
      p.className = "empty-hint";
      p.textContent = "No set lists yet. Create one to plan a performance order ahead of time.";
      els.setsList.appendChild(p);
    } else {
      const frag = document.createDocumentFragment();
      for (const set of sets) frag.appendChild(makeSetCard(set));
      els.setsList.appendChild(frag);
    }
    const newCard = document.createElement("div");
    newCard.className = "set-card set-card-new";
    newCard.innerHTML = `<p class="set-name">&#43; New set</p>`;
    newCard.addEventListener("click", () => openSetEditor(null));
    els.setsList.appendChild(newCard);
  }

  function makeSetCard(set) {
    const card = document.createElement("div");
    card.className = "set-card";

    const main = document.createElement("div");
    main.className = "set-card-main";
    const name = document.createElement("p");
    name.className = "set-name";
    name.textContent = set.name || "Untitled set";
    const meta = document.createElement("p");
    meta.className = "set-meta";
    meta.textContent =
      `${set.songs.length} song${set.songs.length === 1 ? "" : "s"}` + setDurationSuffix(set.songs);
    main.append(name, meta);

    const editBtn = document.createElement("button");
    editBtn.className = "set-edit-btn";
    editBtn.innerHTML = "&#9998;";
    editBtn.setAttribute("aria-label", "Edit set");
    editBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openSetEditor(set);
    });

    card.append(main, editBtn);
    card.addEventListener("click", () => openSetPlayingView(set));
    return card;
  }

  // ── Set editor ───────────────────────────────────────────────────────────
  function openSetEditor(set) {
    editingSet = set
      ? { id: set.id, name: set.name, songs: set.songs.map((s) => ({ ...s })) }
      : { id: String(Date.now()), name: "", songs: [] };
    isNewSet = !set;
    deleteConfirmPending = false;
    clearTimeout(deleteConfirmTimer);
    els.btnDeleteSet.textContent = "Delete";
    els.btnDeleteSet.classList.remove("confirm");
    els.btnDeleteSet.hidden = isNewSet;

    els.setNameInput.value = editingSet.name;
    setPickerBank = "all";
    els.setSearchInput.value = "";
    buildSetBankFilters();
    renderSetOrderList();
    applySetPickerFilters();

    els.setsListView.hidden = true;
    els.setEditorView.hidden = false;
  }

  function closeSetEditor() {
    editingSet = null;
    els.setEditorView.hidden = true;
    els.setsListView.hidden = false;
    renderSetsList();
  }

  els.btnSetEditorBack.addEventListener("click", closeSetEditor);

  els.setNameInput.addEventListener("input", () => {
    editingSet.name = els.setNameInput.value;
  });

  els.btnSaveSet.addEventListener("click", () => {
    const name = els.setNameInput.value.trim();
    if (!name) {
      showToast("Enter a set name.", true);
      return;
    }
    editingSet.name = name;
    const idx = sets.findIndex((s) => s.id === editingSet.id);
    if (idx === -1) sets.push(editingSet);
    else sets[idx] = editingSet;
    persistSets();
    if (activeSet && activeSet.id === editingSet.id) {
      activeSet = editingSet;
      updateSetIndicator();
    }
    showToast("Set saved");
    closeSetEditor();
  });

  els.btnDeleteSet.addEventListener("click", () => {
    if (!deleteConfirmPending) {
      deleteConfirmPending = true;
      els.btnDeleteSet.textContent = "Tap again to confirm";
      els.btnDeleteSet.classList.add("confirm");
      deleteConfirmTimer = setTimeout(() => {
        deleteConfirmPending = false;
        els.btnDeleteSet.textContent = "Delete";
        els.btnDeleteSet.classList.remove("confirm");
      }, 3000);
      return;
    }
    clearTimeout(deleteConfirmTimer);
    sets = sets.filter((s) => s.id !== editingSet.id);
    persistSets();
    if (activeSet && activeSet.id === editingSet.id) {
      activeSet = null;
      activeSetIndex = -1;
      updateSetIndicator();
    }
    showToast("Set deleted");
    closeSetEditor();
  });

  // Song order list (current set contents) — up/down + remove, plus
  // pointer-based drag reordering on the handle (works for mouse and touch
  // via the unified Pointer Events API, no external libraries).
  let pointerDrag = null;

  function renderSetOrderList() {
    els.setSongCount.textContent =
      `${editingSet.songs.length} song${editingSet.songs.length === 1 ? "" : "s"}` +
      setDurationSuffix(editingSet.songs);
    els.setOrderList.innerHTML = "";
    if (!editingSet.songs.length) {
      const li = document.createElement("li");
      li.className = "empty-msg";
      li.textContent = "No songs added yet — pick some below.";
      els.setOrderList.appendChild(li);
      return;
    }
    const frag = document.createDocumentFragment();
    editingSet.songs.forEach((entry, idx) => frag.appendChild(makeSetOrderRow(entry, idx)));
    els.setOrderList.appendChild(frag);
  }

  function moveSetSong(from, to) {
    if (to < 0 || to >= editingSet.songs.length || from === to) return;
    const [item] = editingSet.songs.splice(from, 1);
    editingSet.songs.splice(to, 0, item);
    renderSetOrderList();
  }

  function makeSetOrderRow(entry, idx) {
    const song = resolveSetSong(entry);
    const li = document.createElement("li");
    li.className = "set-order-row";
    li.dataset.index = String(idx);

    const handle = document.createElement("span");
    handle.className = "set-order-handle";
    handle.innerHTML = "&#9776;";

    const pos = document.createElement("span");
    pos.className = "set-order-pos";
    pos.textContent = String(idx + 1);

    const info = document.createElement("div");
    info.className = "song-info";
    const title = document.createElement("p");
    title.className = "song-title";
    title.textContent = song ? song.title || "Untitled" : `Reg ${entry.reg_number} (Bank ${entry.bank})`;
    const artist = document.createElement("p");
    artist.className = "song-artist";
    artist.textContent = song ? song.artist || "Unknown artist" : "Song not found in library";
    info.append(title, artist);

    const removeBtn = document.createElement("button");
    removeBtn.className = "set-order-remove";
    removeBtn.innerHTML = "&#10005;";
    removeBtn.setAttribute("aria-label", "Remove from set");
    removeBtn.addEventListener("click", () => {
      editingSet.songs.splice(idx, 1);
      renderSetOrderList();
    });

    li.append(handle, pos, info, removeBtn);

    handle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      const rect = li.getBoundingClientRect();
      pointerDrag = {
        li,
        startY: e.clientY,
        startIndex: Number(li.dataset.index),
        currentIndex: Number(li.dataset.index),
        rowHeight: rect.height + 6, // + row margin-bottom
      };
      li.classList.add("dragging");
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener("pointermove", (e) => {
      if (!pointerDrag || pointerDrag.li !== li) return;
      const dy = e.clientY - pointerDrag.startY;
      li.style.transform = `translateY(${dy}px)`;
      const shift = Math.round(dy / pointerDrag.rowHeight);
      pointerDrag.currentIndex = Math.max(0, Math.min(editingSet.songs.length - 1, pointerDrag.startIndex + shift));
    });
    function endPointerDrag() {
      if (!pointerDrag || pointerDrag.li !== li) return;
      li.style.transform = "";
      li.classList.remove("dragging");
      const { startIndex, currentIndex } = pointerDrag;
      pointerDrag = null;
      if (startIndex !== currentIndex) moveSetSong(startIndex, currentIndex);
    }
    handle.addEventListener("pointerup", endPointerDrag);
    handle.addEventListener("pointercancel", endPointerDrag);

    return li;
  }

  // Song picker (reuses the song-card markup/search/bank-filter pattern).
  function buildSetBankFilters() {
    buildBankFilterChips(
      els.setBankFilters,
      () => setPickerBank,
      (v) => (setPickerBank = v),
      applySetPickerFilters
    );
  }

  function applySetPickerFilters() {
    const q = els.setSearchInput.value.trim().toLowerCase();
    setPickerFiltered = songs.filter((s) => {
      if (setPickerBank !== "all" && String(s.bank) !== String(setPickerBank)) return false;
      if (!q) return true;
      return (s.title || "").toLowerCase().includes(q) || (s.artist || "").toLowerCase().includes(q);
    });
    renderSetPickerList();
  }
  els.setSearchInput.addEventListener("input", applySetPickerFilters);

  function renderSetPickerList() {
    els.setPickerList.innerHTML = "";
    if (!setPickerFiltered.length) {
      const li = document.createElement("li");
      li.className = "empty-msg";
      li.textContent = "No songs match your search.";
      els.setPickerList.appendChild(li);
      return;
    }
    const frag = document.createDocumentFragment();
    for (const song of setPickerFiltered) frag.appendChild(makeSetPickerRow(song));
    els.setPickerList.appendChild(frag);
  }

  function makeSetPickerRow(song) {
    const li = document.createElement("li");
    li.className = "song-card";

    const reg = document.createElement("div");
    reg.className = "song-reg";
    reg.textContent = song.reg_number != null ? "#" + song.reg_number : "—";

    const info = document.createElement("div");
    info.className = "song-info";
    const title = document.createElement("p");
    title.className = "song-title";
    title.textContent = song.title || "Untitled";
    const artist = document.createElement("p");
    artist.className = "song-artist";
    artist.textContent = song.artist || "Unknown artist";
    info.append(title, artist);

    const addBtn = document.createElement("button");
    addBtn.className = "set-add-btn";
    addBtn.textContent = "+";
    addBtn.setAttribute("aria-label", "Add to set");
    addBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      editingSet.songs.push({ reg_number: song.reg_number, bank: Number(song.bank) || 1 });
      renderSetOrderList();
      showToast(`Added "${song.title || "Untitled"}"`);
    });

    li.append(reg, info, addBtn);
    return li;
  }

  // ── Transport controls ─────────────────────────────────────────────────
  function setPlayingUi(playing) {
    isPlaying = playing;
    els.btnPlay.textContent = playing ? "■ Stop" : "▶ Play";
    els.btnPlay.classList.toggle("is-playing", playing);
  }
  function setLyricsUi(on) {
    lyricsOn = on;
    els.btnLyrics.classList.toggle("is-active", on);
  }
  function stopPlayback(sendSysex = true) {
    if (isPlaying && sendSysex) guardedBleCall(() => ble.startStop(), "Start/Stop");
    setPlayingUi(false);
    setLyricsUi(false);
    player.resetTimer();
    player.showStatic();
  }

  els.btnPlay.addEventListener("click", async () => {
    if (!selectedSong) return;
    await guardedBleCall(() => ble.startStop(), "Start/Stop");
    setPlayingUi(!isPlaying);
    if (isPlaying) {
      player.startTimer();
      if ((selectedSong.lyrics || []).length) {
        setLyricsUi(true);
        player.setLyricsVisible(true);
      }
    } else {
      player.resetTimer();
      player.showStatic();
      setLyricsUi(false);
    }
  });

  els.btnLyrics.addEventListener("click", async () => {
    await guardedBleCall(() => ble.toggleLyric(), "Lyric toggle");
    if (lyricsOn) {
      setLyricsUi(false);
      player.setLyricsVisible(false);
    } else if (selectedSong && (selectedSong.lyrics || []).length) {
      setLyricsUi(true);
      player.setLyricsVisible(true);
    }
  });

  els.btnRegUp.addEventListener("click", () => guardedBleCall(() => ble.regsUp(), "Reg up"));
  els.btnRegDown.addEventListener("click", () => guardedBleCall(() => ble.regsDown(), "Reg down"));
  els.btnEnter.addEventListener("click", () => guardedBleCall(() => ble.enter(), "Enter"));
  els.btnExit.addEventListener("click", () => guardedBleCall(() => ble.exit(), "Exit"));
  els.btnXfade.addEventListener("click", () => guardedBleCall(() => ble.xfade(), "Xfade"));

  // ── Sync songs.json ──────────────────────────────────────────────────────
  // Manual-only: the PC serving the app isn't always running, so this is
  // never attempted automatically — only on button press. Failure is caught
  // and swallowed so the UI just keeps whatever is already loaded.
  els.btnSync.addEventListener("click", async () => {
    try {
      const res = await fetch("songs.json", { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const fresh = await res.json();
      songs = fresh;
      buildBankFilters();
      applyFilters();
      showToast(`Songs updated (${songs.length} songs)`);
    } catch (err) {
      showToast("PC not reachable — using cached songs", true);
    }
  });

  // ── Service worker (offline shell + cached songs.json) ─────────────────
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("service-worker.js").catch(() => {});
    });
  }

  showScreen("songs");
  updateBleWarning("disconnected");
  loadSets();
  renderSetsList();
  try {
    await loadSongs();
    // renderSetsList() above ran before songs.json resolved, so set cards
    // computed duration (and resolved titles) against an empty songs array.
    // Re-render whichever set view is currently visible now that songs are
    // available — otherwise durations stay stuck showing "~0:00".
    if (!els.setsListView.hidden) renderSetsList();
    if (!els.setEditorView.hidden) renderSetOrderList();
    if (els.setPlayingView.classList.contains("visible")) renderSetPlayingList();
  } catch (err) {
    showToast("Failed to load songs.json", true);
  }
})();
