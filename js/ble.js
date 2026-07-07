/*
 * ble.js — Web Bluetooth MIDI transport for the Ketron SD90.
 *
 * Mirrors midi_controller.py's bleak (BLE-MIDI) path — the path actually
 * reachable from main.py's _select_song(), NOT the dead send_pc_ble():
 *   - GATT service:        03b80e5a-ede8-4b33-a751-6ce34ec4c700 (BLE-MIDI)
 *   - GATT characteristic: 7772e5db-3868-4112-a1a9-f2669d106bf3
 *   - Every write is prefixed with a 2-byte BLE-MIDI header/timestamp
 *     (0x80, 0x80) before each MIDI event, matching send_sysex_ble /
 *     _short_bleak in midi_controller.py.
 *
 * TABS sysex format: F0 26 7C 05 00 CMD VAL F7, sent as a "tap": VAL=0x7F
 * (press) then, 50 ms later, VAL=0x00 (release) — see _sysex_tap() in main.py.
 * Registration up/down uses a different prefix: F0 26 79 05 00 CMD VAL F7.
 */

const MIDI_SERVICE = "03b80e5a-ede8-4b33-a751-6ce34ec4c700";
const MIDI_CHAR = "7772e5db-3868-4112-a1a9-f2669d106bf3";

/** Appends a line to the on-screen debug panel (js/app.js wires visibility). */
function uiLog(line) {
  const el = document.getElementById("debugLog");
  if (!el) return;
  const time = new Date().toLocaleTimeString();
  el.textContent += `[${time}] ${line}\n`;
  el.scrollTop = el.scrollHeight;
}

const TABS = {
  START_STOP: { prefix: [0x26, 0x7c, 0x05, 0x00], cmd: 0x38 },
  LYRIC:      { prefix: [0x26, 0x7c, 0x05, 0x00], cmd: 0x15 },
  ENTER:      { prefix: [0x26, 0x7c, 0x05, 0x00], cmd: 0x0d },
  EXIT:       { prefix: [0x26, 0x7c, 0x05, 0x00], cmd: 0x0e },
  XFADE:      { prefix: [0x26, 0x7c, 0x05, 0x00], cmd: 0x3d },
  DIAL_DOWN:  { prefix: [0x26, 0x7c, 0x05, 0x00], cmd: 0x00 },
  DIAL_UP:    { prefix: [0x26, 0x7c, 0x05, 0x00], cmd: 0x01 },
  REGS_UP:    { prefix: [0x26, 0x79, 0x05, 0x00], cmd: 0x62 },
  REGS_DOWN:  { prefix: [0x26, 0x79, 0x05, 0x00], cmd: 0x61 },
};

class KetronBLE {
  constructor() {
    this.device = null;
    this.characteristic = null;
    this.onStatusChange = null; // (status: "disconnected"|"connecting"|"connected", detail?) => void
    this.onRegistrationChange = null; // (bankMsb, program) => void — module-driven reg change
    this.onPlayerStart = null; // () => void — CC#7 volume burst (any source starting playback)
    // Set once we know writeValueWithoutResponse isn't safe for this
    // characteristic/platform — sticky for the rest of the connection.
    this._forceWriteWithResponse = false;
    this._rxBankMsb = 0; // last-seen CC#0 bank MSB from the module, ch16
  }

  get isConnected() {
    return !!(this.characteristic && this.device && this.device.gatt.connected);
  }

  _setStatus(status, detail) {
    if (this.onStatusChange) this.onStatusChange(status, detail);
  }

  async _delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  /**
   * Runs the GATT connect -> service -> characteristic chain with retries.
   * "GATT operation failed" on Android is often transient (BLE stack race,
   * or the peripheral still finishing its previous disconnect) and clears
   * up on retry with a short backoff — this does NOT fix a device that is
   * actively held open by another app (desktop bleak client, MIDIberryM,
   * etc.), which will keep failing every attempt until that app disconnects.
   */
  async _connectGattChain(attempts = 3) {
    const delays = [300, 700, 1500];
    let lastErr;
    for (let i = 0; i < attempts; i++) {
      try {
        if (i > 0) {
          this._setStatus("connecting", `Retrying… (${i + 1}/${attempts})`);
          // A stale gatt handle from the previous failed attempt can itself
          // cause the next getPrimaryService()/getCharacteristic() call to
          // fail silently — drop it before trying again.
          if (this.device && this.device.gatt.connected) {
            this.device.gatt.disconnect();
          }
          await this._delay(delays[i - 1]);
        }
        const server = await this.device.gatt.connect();
        await this._delay(150);
        const service = await server.getPrimaryService(MIDI_SERVICE);
        await this._delay(100);
        const characteristic = await service.getCharacteristic(MIDI_CHAR);
        return characteristic;
      } catch (err) {
        lastErr = err;
        const msg = `[ble] GATT chain attempt ${i + 1}/${attempts} failed: ${err.message || err}`;
        console.warn(msg);
        uiLog(msg);
      }
    }
    throw lastErr;
  }

  async connect() {
    if (!navigator.bluetooth) {
      throw new Error("Web Bluetooth is not supported in this browser.");
    }
    this._setStatus("connecting");
    try {
      this.device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [MIDI_SERVICE] }],
        optionalServices: [MIDI_SERVICE],
      });
      this.device.addEventListener("gattserverdisconnected", () => {
        console.log("[BLE] gattserverdisconnected");
        uiLog("[BLE] gattserverdisconnected");
        this.characteristic = null;
        this._setStatus("disconnected");
      });
      this.characteristic = await this._connectGattChain();
      this._logCharacteristicProperties();
      await this._subscribeNotifications();
      this._setStatus("connected", this.device.name || "SD90");
      return true;
    } catch (err) {
      this._setStatus("disconnected");
      uiLog(`[BLE] connect error: ${err.name || ""} ${err.message || err}`);
      if (/GATT operation failed/i.test(err.message || "")) {
        throw new Error(
          "GATT operation failed. Make sure no other app (desktop Remote, MIDIberryM) is connected to WIDI Master, then try again."
        );
      }
      throw err;
    }
  }

  disconnect() {
    if (this.device && this.device.gatt.connected) {
      this.device.gatt.disconnect();
    }
    this.characteristic = null;
    this._setStatus("disconnected");
  }

  /** Logs which GATT write methods this characteristic actually supports. */
  _logCharacteristicProperties() {
    const p = this.characteristic && this.characteristic.properties;
    if (!p) return;
    // JSON.stringify(p) prints "{}" in Chrome because the booleans live on
    // the prototype as getters, not as own enumerable properties — read
    // them out explicitly instead.
    const flags = {
      write: p.write,
      writeWithoutResponse: p.writeWithoutResponse,
      read: p.read,
      notify: p.notify,
    };
    console.log("[BLE] characteristic.properties:", JSON.stringify(flags));
    uiLog(`[BLE] characteristic.properties: ${JSON.stringify(flags)}`);
    if (!p.writeWithoutResponse && p.write) {
      const msg = "[BLE] writeWithoutResponse unsupported by this characteristic — forcing writeValue() (with response) for all writes.";
      console.warn(msg);
      uiLog(msg);
      this._forceWriteWithResponse = true;
    } else {
      this._forceWriteWithResponse = false;
    }
  }

  /**
   * Subscribe to GATT notifications, mirroring bleak's start_notify() +
   * _on_midi callback in midi_controller.py's connect_ble_bleak(). Failing to
   * subscribe shouldn't block connect() — module->app sync just won't work.
   */
  async _subscribeNotifications() {
    this._rxBankMsb = 0;
    try {
      await this.characteristic.startNotifications();
      this.characteristic.addEventListener("characteristicvaluechanged", (event) => {
        this._onNotify(event.target.value);
      });
    } catch (err) {
      uiLog(`[BLE] startNotifications failed: ${err.name || ""} ${err.message || err}`);
    }
  }

  /**
   * Parse an incoming BLE-MIDI packet, port of _on_midi() in
   * midi_controller.py: skip the 2-byte header/timestamp, then walk events
   * looking for CC#0 (bank MSB, ch16), Program Change (ch16, registration),
   * and CC#7 volume-burst (player start) on any channel.
   */
  _onNotify(dataView) {
    if (dataView.byteLength < 3) return;
    const midi = new Uint8Array(dataView.buffer, dataView.byteOffset + 2, dataView.byteLength - 2);
    let i = 0;
    while (i < midi.length) {
      const status = midi[i];
      if (status === 0xbf && i + 2 < midi.length && midi[i + 1] === 0) {
        // CC#0 Bank Select MSB on ch16
        this._rxBankMsb = midi[i + 2] & 0x7f;
        i += 3;
      } else if (status === 0xcf && i + 1 < midi.length) {
        // Program Change on ch16 (registration)
        const program = midi[i + 1] & 0x7f;
        if (this.onRegistrationChange) this.onRegistrationChange(this._rxBankMsb, program);
        i += 2;
      } else if (
        status >= 0xb0 && status <= 0xbf &&
        i + 2 < midi.length && midi[i + 1] === 0x07 && (midi[i + 2] & 0x7f) > 0
      ) {
        // CC#7 Volume on any channel — volume-burst player-start signal
        if (this.onPlayerStart) this.onPlayerStart();
        i += 3;
      } else {
        i += 1;
      }
    }
  }

  /** Writes with detailed TX logging and a sticky fallback to writeValue(). */
  async _writeWithRetry(bytes) {
    if (!this.characteristic) throw new Error("BLE not connected");
    const arr = new Uint8Array(bytes);
    const hex = Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join(" ");
    console.log("[BLE TX]", hex);
    uiLog(`[BLE TX] ${hex}`);
    try {
      if (this._forceWriteWithResponse) {
        await this.characteristic.writeValue(arr);
      } else {
        try {
          await this.characteristic.writeValueWithoutResponse(arr);
        } catch (err) {
          const msg = `[BLE TX] writeValueWithoutResponse failed, falling back to writeValue() for all future writes: ${err.name} ${err.message}`;
          console.warn(msg);
          uiLog(msg);
          this._forceWriteWithResponse = true;
          await this.characteristic.writeValue(arr);
        }
      }
      console.log("[BLE TX] OK");
      uiLog("[BLE TX] OK");
    } catch (err) {
      console.log("[BLE TX] FAILED:", err.name, err.message);
      uiLog(`[BLE TX] FAILED: ${err.name} ${err.message}`);
      throw err;
    }
  }

  /** Raw SysEx (data = array of ints, WITHOUT the F0/F7 wrapper). */
  async sendSysex(data) {
    const msg = [0x80, 0x80, 0xf0, ...data, 0x80, 0xf7];
    await this._writeWithRetry(msg);
  }

  /**
   * Bank-select CC#0 + CC#32 (bank LSB, always 0 on the live desktop path)
   * + Program Change (channel 0-15). Sent as THREE separate GATT writes,
   * matching send_program_change()'s three _short() calls in
   * midi_controller.py — each _short() is its own write_gatt_char over BLE
   * (_short_bleak), not one combined packet.
   */
  async sendProgramChange(channel, bankMsb, program) {
    await this._writeWithRetry([0x80, 0x80, 0xb0 | channel, 0x00, bankMsb]);
    await this._writeWithRetry([0x80, 0x80, 0xb0 | channel, 0x20, 0x00]);
    await this._writeWithRetry([0x80, 0x80, 0xc0 | channel, program]);
  }

  /**
   * Registration number -> (bankMsb, program), matching
   * MidiController.reg_to_midi() in midi_controller.py:
   *   bank_offset = (bank - 1) * 8
   *   cc = bank_offset + (reg_number - 1) // 128
   *   pc = (reg_number - 1) % 128
   */
  static regToMidi(regNumber, bank) {
    const b = Number.isFinite(bank) ? bank : 1;
    const bankOffset = (b - 1) * 8;
    const cc = bankOffset + Math.floor((regNumber - 1) / 128);
    const pc = (regNumber - 1) % 128;
    return { bankMsb: cc, program: pc };
  }

  /** Select a song's registration by reg_number/bank, channel 16 (0-indexed 15). */
  async sendRegistrationNumber(regNumber, bank, channel = 15) {
    const { bankMsb, program } = KetronBLE.regToMidi(regNumber, bank);
    await this.sendProgramChange(channel, bankMsb, program);
  }

  /** Press (VAL=0x7F) then, 50ms later, release (VAL=0x00) — a "tap". */
  async sendTap(tabsCmd) {
    const { prefix, cmd } = tabsCmd;
    await this.sendSysex([...prefix, cmd, 0x7f]);
    await new Promise((r) => setTimeout(r, 50));
    await this.sendSysex([...prefix, cmd, 0x00]);
  }

  startStop() { return this.sendTap(TABS.START_STOP); }
  toggleLyric() { return this.sendTap(TABS.LYRIC); }
  enter() { return this.sendTap(TABS.ENTER); }
  exit() { return this.sendTap(TABS.EXIT); }
  xfade() { return this.sendTap(TABS.XFADE); }

  regsUp() {
    const msg = `[BLE] regsUp() called (isConnected=${this.isConnected})`;
    console.log(msg);
    uiLog(msg);
    return this.sendTap(TABS.REGS_UP).catch((err) => {
      const failMsg = `[BLE] regsUp() failed: ${err.name || ""} ${err.message || err}`;
      console.warn(failMsg);
      uiLog(failMsg);
      throw err;
    });
  }

  regsDown() {
    const msg = `[BLE] regsDown() called (isConnected=${this.isConnected})`;
    console.log(msg);
    uiLog(msg);
    return this.sendTap(TABS.REGS_DOWN).catch((err) => {
      const failMsg = `[BLE] regsDown() failed: ${err.name || ""} ${err.message || err}`;
      console.warn(failMsg);
      uiLog(failMsg);
      throw err;
    });
  }
}
