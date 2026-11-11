// Where the image comes from: the module over USB, or a .bin file.
//
// Both sources expose the same two operations - read an image, write an image -
// so the UI does not care which is in use.
//
// The module speaks newline-terminated ASCII commands over USB CDC. Two framings
// exist: the length-framed bk2/rt2 (preferred) and the older bkram/rtram, which
// terminates with an unescaped "!FIM!" and so can be truncated by preset data
// containing those five bytes. Which one a module speaks is decided once, on
// connecting (see detect()), and never changed during the session: switching
// after a timeout would read the tail of one transfer as the start of another.
(function (root) {
    'use strict';

    const Bin = typeof module !== 'undefined' && module.exports ? require('./bin.js') : root.Bin511;

    const BAUD = 115200;
    const END_MARK = [0x21, 0x46, 0x49, 0x4D, 0x21]; // "!FIM!"
    const CHUNK = 512;          // write block size, as the module expects
    const PROBE_MS = 1200;      // long enough for the module to answer a new command
    const READ_MS = 4000;       // a stalled transfer must not hang forever
    // Writing erases and reprograms ~400 kB of flash: about 100 sector erases at
    // 70 ms typical and 300 ms worst case (IS25LP064 datasheet), so ~8 s typical
    // and ~30 s worst. The first version waited 16 s.
    const WRITE_MS = 60000;
    const SETTLE_MS = 150;      // silence that means the line is clear

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const hex = (n) => (n >>> 0).toString(16).toUpperCase();

    class Timeout extends Error {
        constructor(what) { super('the module stopped responding while ' + what); this.name = 'Timeout'; }
    }

    class SerialSource {
        static get supported() { return typeof navigator !== 'undefined' && 'serial' in navigator; }

        // `timing` overrides the timeouts; only the tests pass it.
        constructor(timing) {
            this.t = Object.assign({ probe: PROBE_MS, read: READ_MS, write: WRITE_MS, settle: SETTLE_MS }, timing || {});
            this.port = null;
            this.reader = null;
            this.pending = new Uint8Array(0); // bytes received but not yet consumed
            this.waiters = [];                // resolved whenever bytes arrive or the port closes
            this.closed = false;
            this.lengthFramed = null;         // decided once, at connect
            this.version = undefined;         // undefined: not asked; null: firmware too old to say
        }

        get connected() { return !!this.port && !this.closed; }

        async connect() {
            // No filter: the Daisy CDC is a generic STM32 VCP (0x0483/0x5740) and
            // users have reported clones, so let them pick the port.
            this.port = await navigator.serial.requestPort();
            await this.port.open({ baudRate: BAUD, bufferSize: 4095 });
            this.attach(this.port.readable.getReader());
            await this.handshake();
            await this.detect();
            return this;
        }

        async disconnect() {
            try { if (this.reader) await this.reader.cancel(); } catch (e) { /* closing anyway */ }
            try { if (this.readLoop) await this.readLoop; } catch (e) { /* closing anyway */ }
            try { if (this.reader) this.reader.releaseLock(); } catch (e) { /* closing anyway */ }
            try { if (this.port) await this.port.close(); } catch (e) { /* closing anyway */ }
            this.port = null; this.reader = null;
        }

        get name() { return 'ADDAC511 over USB'; }

        // ---------- raw io ----------
        // One read loop for the life of the connection. Bytes only ever arrive
        // here and are appended to `pending`; nothing else calls reader.read().
        // The earlier design started a read per wait and abandoned it on timeout,
        // so the next chunk from the module resolved that orphaned read and was
        // lost - which corrupted every transfer after the first timeout.
        attach(reader) {
            this.reader = reader;
            this.pending = new Uint8Array(0);
            this.closed = false;
            this.readLoop = (async () => {
                try {
                    for (;;) {
                        const { value, done } = await reader.read();
                        if (done) break;
                        if (value && value.length) {
                            const merged = new Uint8Array(this.pending.length + value.length);
                            merged.set(this.pending); merged.set(value, this.pending.length);
                            this.pending = merged;
                            this.wake();
                        }
                    }
                } catch (e) {
                    this.readError = e;
                } finally {
                    this.closed = true;
                    this.wake();
                }
            })();
        }

        wake() {
            const w = this.waiters;
            this.waiters = [];
            for (const f of w) f();
        }

        async write(bytes) {
            const w = this.port.writable.getWriter();
            try { await w.write(bytes); } finally { w.releaseLock(); }
        }

        async send(cmd) { await this.write(new TextEncoder().encode(cmd)); }

        // Wait for more bytes, with a deadline. Unlike the old page, a stalled
        // module cannot hang the panel; unlike the first version of this one, a
        // deadline passing loses nothing.
        pump(timeoutMs, what) {
            return new Promise((resolve, reject) => {
                if (this.closed) { reject(new Error('the serial port closed')); return; }
                let done = false;
                const timer = setTimeout(() => {
                    if (done) return;
                    done = true;
                    this.waiters = this.waiters.filter((f) => f !== onData);
                    reject(new Timeout(what || 'reading'));
                }, timeoutMs);
                const onData = () => {
                    if (done) return;
                    done = true;
                    clearTimeout(timer);
                    if (this.closed && !this.pending.length) reject(new Error('the serial port closed'));
                    else resolve();
                };
                this.waiters.push(onData);
            });
        }

        // Discard anything still arriving from an earlier command: wait until the
        // line has been silent for `quietMs`. A reply that arrives after its own
        // deadline (a slow flash write, say) must not be read as the answer to
        // the next command.
        async settle(quietMs, maxMs) {
            quietMs = quietMs || this.t.settle;
            const deadline = Date.now() + (maxMs || 3000);
            for (;;) {
                this.pending = new Uint8Array(0);
                try {
                    await this.pump(quietMs, 'settling');
                } catch (e) {
                    if (e instanceof Timeout) return; // silent: clean slate
                    throw e;
                }
                if (Date.now() > deadline) {
                    throw new Error('the module keeps sending data; disconnect and reconnect it');
                }
            }
        }

        async readLine(timeoutMs, what) {
            for (;;) {
                const nl = this.pending.indexOf(0x0A);
                if (nl >= 0) {
                    const line = new TextDecoder().decode(this.pending.subarray(0, nl));
                    this.pending = this.pending.subarray(nl + 1);
                    // the legacy backup path leaves a trailing NUL in the stream
                    const clean = line.replace(/\0/g, '').trim();
                    if (clean === '') continue;
                    return clean;
                }
                await this.pump(timeoutMs, what);
            }
        }

        async readExactly(n, what, onProgress) {
            while (this.pending.length < n) {
                try {
                    await this.pump(this.t.read, what);
                } catch (e) {
                    // say how far it got: 0 bytes, an exact multiple of 64 kB and a
                    // random point each point to a different cause
                    if (e instanceof Timeout) throw new Timeout(`${what} (received ${this.pending.length.toLocaleString('en')} of ${n.toLocaleString('en')} bytes)`);
                    throw e;
                }
                if (onProgress) onProgress(Math.min(this.pending.length, n), n);
            }
            const out = this.pending.subarray(0, n).slice();
            this.pending = this.pending.subarray(n);
            return out;
        }

        // Send a command on a clean line.
        async command(cmd) {
            await this.settle();
            await this.send(cmd);
        }

        async handshake() {
            await this.command('test\n');
            const line = await this.readLine(this.t.probe, 'connecting');
            if (!/test_received/.test(line)) throw new Error('unexpected reply to test: ' + line);
            return true;
        }

        // Decide the transfer protocol once, here, and never change it during the
        // session. The first version fell back to the old protocol whenever the
        // new one timed out, which on a new module meant reading the tail of the
        // new transfer as the start of the old one.
        //   - firmware that answers "ver" has bk2/rt2
        //   - builds between bk2/rt2 and "ver" answer "rt2 0 0" with NOK (a zero
        //     length is refused before anything happens); older firmware ignores it
        async detect() {
            await this.command('ver\n');
            try {
                const line = await this.readLine(this.t.probe, 'reading the firmware version');
                this.version = /^V[\w.\-]+$/.test(line) ? line : null;
            } catch (e) {
                if (!(e instanceof Timeout)) throw e;
                this.version = null;
            }
            if (this.version) { this.lengthFramed = true; return; }
            await this.command('rt2 0 0\n');
            try {
                this.lengthFramed = (await this.readLine(this.t.probe, 'checking the firmware')) === 'NOK';
            } catch (e) {
                if (!(e instanceof Timeout)) throw e;
                this.lengthFramed = false;
            }
        }

        // kept for callers: the version was read when connecting
        async readVersion() { return this.version; }

        // ---------- read the image ----------
        readImage(onProgress) {
            return this.lengthFramed ? this.readImageFramed(onProgress) : this.readImageLegacy(onProgress);
        }

        async readImageFramed(onProgress) {
            await this.command('bk2\n');
            const header = await this.readLine(this.t.probe * 2, 'starting the backup');
            const m = /^(\d+)\s+([0-9A-Fa-f]+)$/.exec(header);
            if (!m) throw new Error('unexpected reply to the backup command: ' + header.slice(0, 40));
            const len = parseInt(m[1], 10), crc = parseInt(m[2], 16);
            const bytes = await this.readExactly(len, 'backing up', onProgress);
            const got = Bin.crc32(bytes);
            if (got !== crc) throw new Error(`backup CRC mismatch: module said ${hex(crc)}, got ${hex(got)}`);
            return bytes;
        }

        async readImageLegacy(onProgress) {
            await this.command('bkram\n');
            // the payload length is implicit, so read until the end marker shows up
            for (;;) {
                const at = indexOfSeq(this.pending, END_MARK);
                if (at >= 0) {
                    const bytes = this.pending.subarray(0, at).slice();
                    const crc = await this.remoteCrc();
                    const got = Bin.crc32(bytes);
                    if (got !== crc) throw new Error(`backup CRC mismatch: module said ${hex(crc)}, got ${hex(got)}`);
                    return bytes;
                }
                await this.pump(this.t.read, 'backing up');
                if (onProgress) onProgress(this.pending.length, 0);
            }
        }

        async remoteCrc() {
            // settle() also drops the NUL the module sends after the end marker
            await this.command('getcrc\n');
            const line = await this.readLine(this.t.probe, 'reading the checksum');
            return parseInt(line, 16);
        }

        // ---------- write the image ----------
        writeImage(bytes, onProgress, onPhase) {
            return this.lengthFramed ? this.writeImageFramed(bytes, onProgress, onPhase) : this.writeImageLegacy(bytes, onProgress, onPhase);
        }

        async writeImageFramed(bytes, onProgress, onPhase) {
            const crc = Bin.crc32(bytes);
            await this.command(`rt2 ${bytes.length} ${hex(crc)}\n`);
            const ready = await this.readLine(this.t.probe * 2, 'starting the restore');
            if (ready !== 'RDY') throw new Error('unexpected reply to the restore command: ' + ready.slice(0, 40));
            await this.streamBytes(bytes, onProgress);
            if (onPhase) onPhase('writing');
            const reply = await this.readLine(this.t.write, 'writing to the module’s memory');
            if (reply === 'NOK') throw new Error('the module rejected the transfer (checksum mismatch); nothing was erased');
            const echoed = parseInt(reply, 16);
            if (echoed !== crc) throw new Error(`write verify failed: module stored ${hex(echoed)}, sent ${hex(crc)}`);
        }

        async writeImageLegacy(bytes, onProgress, onPhase) {
            const at = indexOfSeq(bytes, END_MARK);
            if (at >= 0) {
                throw new Error(
                    'This firmware uses the older framing, which has no escaping, and the data ' +
                    `contains the sequence "!FIM!" at byte ${at} - it would truncate the restore. ` +
                    'Remove it (most likely from a preset name), or update the firmware.');
            }
            const crc = Bin.crc32(bytes);
            await this.command('rtram\n');
            await sleep(500); // the old firmware gives no ready signal
            await this.streamBytes(bytes, onProgress);
            await this.write(new Uint8Array(END_MARK));
            if (onPhase) onPhase('writing');
            const reply = await this.readLine(this.t.write, 'writing to the module’s memory');
            if (reply === 'NOK') throw new Error('the module reported the write failed');
            const echoed = parseInt(reply, 16);
            if (echoed !== crc) throw new Error(`write verify failed: module stored ${hex(echoed)}, sent ${hex(crc)}`);
        }

        async streamBytes(bytes, onProgress) {
            const w = this.port.writable.getWriter();
            try {
                for (let i = 0; i < bytes.length; i += CHUNK) {
                    await w.write(bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
                    if (onProgress) onProgress(Math.min(i + CHUNK, bytes.length), bytes.length);
                }
            } finally { w.releaseLock(); }
        }
    }

    function indexOfSeq(hay, needle) {
        outer: for (let i = 0; i <= hay.length - needle.length; i++) {
            for (let k = 0; k < needle.length; k++) if (hay[i + k] !== needle[k]) continue outer;
            return i;
        }
        return -1;
    }

    // ---------- .bin files ----------
    const FileSource = {
        async read(file) {
            const buf = await file.arrayBuffer();
            return { bytes: new Uint8Array(buf), name: file.name };
        },

        // Addac511_DD-MM-YYYY.bin. The old page used getDay() (day of the week)
        // where getDate() was meant, so every file in a week collided.
        suggestedName(date) {
            const d = date || new Date();
            const p = (n) => String(n).padStart(2, '0');
            return `Addac511_${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()}.bin`;
        },

        save(bytes, filename) {
            const blob = new Blob([bytes], { type: 'application/octet-stream' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = filename || FileSource.suggestedName();
            document.body.appendChild(a);
            a.click();
            setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
        },
    };

    const api = { SerialSource, FileSource, Timeout, indexOfSeq, BAUD, END_MARK };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.Serial511 = api;
})(typeof window !== 'undefined' ? window : globalThis);
