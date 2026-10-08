// The 511's flash image: 16 preset slots, the global block, and the slot table.
//
// Everything is done by PATCHING a copy of the bytes that came off the module or
// out of a .bin, never by regenerating the image. That keeps padding, the legacy
// fields the firmware still reads, and anything a future firmware adds, so an
// edit touches only what was actually edited.
(function (root) {
    'use strict';

    const Bin = typeof module !== 'undefined' && module.exports ? require('./bin.js') : root.Bin511;

    // Per-slot trailer (firmware >= 0xFF03). Absent in older slots, which is how
    // "legacy" is detected: erased flash reads 0xFFFFFFFF, never the magic.
    const TRAILER = { CURRENT: 'current', LEGACY: 'legacy', BAD_CRC: 'crc-mismatch' };

    class Image511 {
        constructor(offsets, arrayBuffer) {
            this.offsets = offsets;
            const size = offsets.layout.image_size;
            // A short file (the 163840-byte factory .bin is 8 slots) is padded;
            // the firmware only ever reads whole slots, so zero-fill is safe.
            const buf = new ArrayBuffer(size);
            const dst = new Uint8Array(buf);
            const src = new Uint8Array(arrayBuffer);
            dst.set(src.subarray(0, Math.min(src.length, size)));
            this.truncated = src.length > size;
            this.padded = src.length < size;
            this.originalSize = src.length;
            this.model = new Bin.Model(offsets, buf);
            this.common = this.model.view('PresetsCommon', offsets.layout.presets_common_offset);
            this.original = dst.slice(); // for dirty-checking and Revert
        }

        get bytes() { return this.model.u8; }
        get maxPresets() { return this.model.consts.MAX_PRESETS; }
        get slotSize() { return this.model.layout.slot_size; }

        slotOffset(i) { return this.model.layout.preset_base_offset + i * this.slotSize; }
        preset(i) { return this.model.view('Preset', this.slotOffset(i)); }

        // ---------- the slot table ----------
        // preset[i] holds the module's ABSOLUTE flash address, or 0 when empty.
        // The editor works in file offsets, so the address is derived, never copied.
        slotAddress(i) { return 0x90000000 + this.slotOffset(i); }
        isOccupied(i) { return this.common.get('preset', [i]) !== 0; }

        setOccupied(i, occupied) {
            this.common.set('preset', [i], occupied ? this.slotAddress(i) : 0);
            this.refreshCounts();
        }

        refreshCounts() {
            let n = 0;
            for (let i = 0; i < this.maxPresets; i++) if (this.isOccupied(i)) n++;
            this.common.set('npresets', undefined, n);
            const sel = this.common.get('selected');
            if (sel < 0 || sel >= this.maxPresets || !this.isOccupied(sel)) {
                this.common.set('selected', undefined, n > 0 ? this.firstOccupied() : -1);
            }
            return n;
        }

        firstOccupied() {
            for (let i = 0; i < this.maxPresets; i++) if (this.isOccupied(i)) return i;
            return -1;
        }

        occupiedSlots() {
            const out = [];
            for (let i = 0; i < this.maxPresets; i++) if (this.isOccupied(i)) out.push(i);
            return out;
        }

        presetName(i) { return this.isOccupied(i) ? this.preset(i).getString('name') : ''; }

        // ---------- trailer ----------
        trailerView(i) {
            return this.model.view('PresetTrailer', this.slotOffset(i) + this.model.layout.trailer_offset_in_slot);
        }

        readTrailer(i) {
            const t = this.trailerView(i);
            return {
                magic: t.get('magic'),
                format: t.get('format'),
                payloadSize: t.get('payload_size'),
                crc32: t.get('crc32'),
            };
        }

        hasTrailer(i) {
            const t = this.readTrailer(i);
            const presetSize = this.model.structs.Preset.size;
            return t.magic === this.model.consts.PRESET_TRAILER_MAGIC &&
                   t.payloadSize > 0 && t.payloadSize <= presetSize;
        }

        payloadCrc(i, size) {
            return Bin.crc32(this.model.u8, this.slotOffset(i), size);
        }

        trailerStatus(i) {
            if (!this.isOccupied(i)) return null;
            if (!this.hasTrailer(i)) return TRAILER.LEGACY;
            const t = this.readTrailer(i);
            return this.payloadCrc(i, t.payloadSize) === t.crc32 ? TRAILER.CURRENT : TRAILER.BAD_CRC;
        }

        // The firmware version that introduced the trailer, read from the enum
        // rather than hardcoded, so a bump cannot leave the panel behind.
        trailerFormatVersion() {
            const e = this.model.enums.PresetVersions;
            const named = e && e.values.filter((v) => /^PRESET_VERSION_/.test(v.name));
            return named && named.length ? named[named.length - 1].value : 0xFF03;
        }

        // Must be called after ANY edit to a slot. Without it the firmware reads a
        // stale CRC and reports the preset as corrupt.
        stampTrailer(i) {
            const presetSize = this.model.structs.Preset.size;
            const t = this.trailerView(i);
            t.set('magic', undefined, this.model.consts.PRESET_TRAILER_MAGIC);
            t.set('format', undefined, this.trailerFormatVersion());
            t.set('payload_size', undefined, presetSize);
            t.set('crc32', undefined, this.payloadCrc(i, presetSize));
            return this;
        }

        // ---------- slot operations (what pman did, plus restamping) ----------
        copySlot(srcImage, srcIndex, dstIndex) {
            const presetSize = this.model.structs.Preset.size;
            const src = new Uint8Array(srcImage.model.buf, srcImage.slotOffset(srcIndex), presetSize);
            this.model.u8.set(src, this.slotOffset(dstIndex));
            this.preset(dstIndex).set('id', undefined, dstIndex);
            this.setOccupied(dstIndex, true);
            this.stampTrailer(dstIndex);
            return this;
        }

        duplicate(srcIndex, dstIndex) { return this.copySlot(this, srcIndex, dstIndex); }

        deleteSlot(i) {
            // Zero the slot so a deleted preset leaves nothing readable behind;
            // the slot-table entry is what the firmware actually consults.
            this.model.u8.fill(0, this.slotOffset(i), this.slotOffset(i) + this.slotSize);
            this.setOccupied(i, false);
            return this;
        }

        moveSlot(from, to) {
            if (from === to) return this;
            const presetSize = this.model.structs.Preset.size;
            const tmp = this.model.u8.slice(this.slotOffset(from), this.slotOffset(from) + presetSize);
            const dstWas = this.isOccupied(to);
            const dstTmp = this.model.u8.slice(this.slotOffset(to), this.slotOffset(to) + presetSize);
            this.model.u8.set(tmp, this.slotOffset(to));
            this.model.u8.set(dstTmp, this.slotOffset(from));
            const srcWas = true;
            this.setOccupied(to, srcWas);
            this.setOccupied(from, dstWas);
            this.preset(to).set('id', undefined, to);
            this.stampTrailer(to);
            if (dstWas) {
                this.preset(from).set('id', undefined, from);
                this.stampTrailer(from);
            } else {
                this.model.u8.fill(0, this.slotOffset(from), this.slotOffset(from) + this.slotSize);
            }
            return this;
        }

        firstFreeSlot() {
            for (let i = 0; i < this.maxPresets; i++) if (!this.isOccupied(i)) return i;
            return -1;
        }

        // ---------- validation ----------
        // Mirrors Addac511::presets_common_is_valid_().
        commonIsValid() {
            const CHECK = 'addac voltage generator check check';
            if (this.common.getString('check') !== CHECK) return false;
            if (this.common.get('preset_slot_size') !== this.slotSize) return false;
            for (let i = 0; i < this.maxPresets; i++) {
                const v = this.common.get('preset', [i]);
                if (v !== 0 && v !== this.slotAddress(i)) return false;
            }
            return true;
        }

        // The legacy bkram/rtram framing has no escaping, so this byte sequence
        // anywhere in the payload truncates a restore. Reachable by typing it into
        // a preset name, so it is checked before any legacy-path send.
        findEndMarker() {
            const needle = [0x21, 0x46, 0x49, 0x4D, 0x21]; // "!FIM!"
            const u8 = this.model.u8;
            for (let i = 0; i <= u8.length - needle.length; i++) {
                let hit = true;
                for (let k = 0; k < needle.length; k++) {
                    if (u8[i + k] !== needle[k]) { hit = false; break; }
                }
                if (hit) return i;
            }
            return -1;
        }

        // ---------- dirty tracking ----------
        isDirty() {
            const a = this.model.u8, b = this.original;
            for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return true;
            return false;
        }

        changedRanges() {
            const a = this.model.u8, b = this.original, out = [];
            let start = -1;
            for (let i = 0; i <= a.length; i++) {
                const diff = i < a.length && a[i] !== b[i];
                if (diff && start < 0) start = i;
                if (!diff && start >= 0) { out.push([start, i]); start = -1; }
            }
            return out;
        }

        dirtySlots() {
            const out = new Set();
            for (const [s, e] of this.changedRanges()) {
                for (let i = 0; i < this.maxPresets; i++) {
                    const o = this.slotOffset(i);
                    if (s < o + this.slotSize && e > o) out.add(i);
                }
            }
            return [...out].sort((x, y) => x - y);
        }

        commonDirty() {
            return this.changedRanges().some(([s, e]) => s < this.model.structs.PresetsCommon.size && e > 0);
        }

        revert() {
            this.model.u8.set(this.original);
            return this;
        }

        markSaved() {
            this.original = this.model.u8.slice();
            return this;
        }

        // Restamp every slot whose bytes changed. Called before a save or a write.
        stampDirtySlots() {
            const slots = this.dirtySlots().filter((i) => this.isOccupied(i));
            for (const i of slots) this.stampTrailer(i);
            return slots;
        }

        toBlobBytes() { return this.model.u8; }
    }

    const api = { Image511, TRAILER };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.Image511 = api;
})(typeof window !== 'undefined' ? window : globalThis);
