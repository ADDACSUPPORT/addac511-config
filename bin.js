// Typed read/write over the 511's flash image, driven by offsets.json.
//
// The stored format is a raw memcpy of the firmware's C++ structs, so every
// access here is "read N bytes at this offset as this type". Nothing in this
// file knows what a parameter means - that is schema.js - which keeps the
// layout (generated, authoritative) separate from the labels (hand-written).
//
// Array fields are row-major, exactly as C lays them out: a [4][3] field is
// indexed (channel * 3 + state), and [4][3][32] is ((ch * 3 + state) * 32 + step).
(function (root) {
    'use strict';

    // ---------- CRC32 (zlib: poly 0xEDB88320 reflected, init/final 0xFFFFFFFF) ----------
    // Must match the firmware's hardware CRC unit (hw.cpp: CRC_INPUTDATA_INVERSION_BYTE
    // + CRC_OUTPUTDATA_INVERSION_ENABLED over the default polynomial).
    const CRC_TABLE = (() => {
        const t = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
            t[n] = c >>> 0;
        }
        return t;
    })();

    function crc32(bytes, start, length) {
        start = start || 0;
        length = length === undefined ? bytes.length - start : length;
        let c = 0xFFFFFFFF;
        for (let i = 0; i < length; i++) c = CRC_TABLE[(c ^ bytes[start + i]) & 0xFF] ^ (c >>> 8);
        return (c ^ 0xFFFFFFFF) >>> 0;
    }

    // ---------- scalar accessors ----------
    // Keyed by the C type name as gen_offsets.py reports it.
    const SCALARS = {
        'int':      { size: 4, get: (d, o) => d.getInt32(o, true),   set: (d, o, v) => d.setInt32(o, v | 0, true) },
        'uint32_t': { size: 4, get: (d, o) => d.getUint32(o, true),  set: (d, o, v) => d.setUint32(o, v >>> 0, true) },
        'int16_t':  { size: 2, get: (d, o) => d.getInt16(o, true),   set: (d, o, v) => d.setInt16(o, v | 0, true) },
        'uint16_t': { size: 2, get: (d, o) => d.getUint16(o, true),  set: (d, o, v) => d.setUint16(o, v & 0xFFFF, true) },
        'uint8_t':  { size: 1, get: (d, o) => d.getUint8(o),         set: (d, o, v) => d.setUint8(o, v & 0xFF) },
        'int8_t':   { size: 1, get: (d, o) => d.getInt8(o),          set: (d, o, v) => d.setInt8(o, v | 0) },
        'float':    { size: 4, get: (d, o) => d.getFloat32(o, true), set: (d, o, v) => d.setFloat32(o, v, true) },
        'bool':     { size: 1, get: (d, o) => d.getUint8(o) !== 0,   set: (d, o, v) => d.setUint8(o, v ? 1 : 0) },
        'char':     { size: 1, get: (d, o) => d.getUint8(o),         set: (d, o, v) => d.setUint8(o, v & 0xFF) },
        // a stale RAM pointer the firmware no longer reads; kept for layout only
        'pointer':  { size: 4, get: (d, o) => d.getUint32(o, true),  set: (d, o, v) => d.setUint32(o, v >>> 0, true) },
    };

    function enumAccessor(size) {
        // enum class : int is signed and reads -1 in a preset that predates the
        // field; an unscoped enum is one unsigned byte and reads 255 instead.
        return size === 1
            ? { size: 1, get: (d, o) => d.getUint8(o), set: (d, o, v) => d.setUint8(o, v & 0xFF) }
            : { size: 4, get: (d, o) => d.getInt32(o, true), set: (d, o, v) => d.setInt32(o, v | 0, true) };
    }

    // ---------- a view onto one struct instance ----------
    class StructView {
        constructor(model, structName, base) {
            this.model = model;
            this.def = model.structs[structName];
            if (!this.def) throw new Error('unknown struct ' + structName);
            this.structName = structName;
            this.base = base;
        }

        field(name) {
            const f = this.def.byName[name];
            if (!f) throw new Error(this.structName + ' has no field ' + name);
            return f;
        }

        // flat element index from per-dimension indices, row-major
        flatIndex(f, idx) {
            if (!f.dims) return 0;
            if (idx === undefined) idx = [];
            if (!Array.isArray(idx)) idx = [idx];
            if (idx.length !== f.dims.length) {
                throw new Error(f.name + ' needs ' + f.dims.length + ' indices, got ' + idx.length);
            }
            let flat = 0;
            for (let i = 0; i < f.dims.length; i++) {
                const v = idx[i];
                if (!(v >= 0 && v < f.dims[i])) throw new Error(f.name + ' index ' + i + ' out of range: ' + v);
                flat = flat * f.dims[i] + v;
            }
            return flat;
        }

        offsetOf(name, idx) {
            const f = this.field(name);
            return this.base + f.offset + this.flatIndex(f, idx) * f.elem_size;
        }

        get(name, idx) {
            const f = this.field(name);
            const acc = this.model.accessor(f);
            if (!acc) throw new Error(f.name + ' is a struct; use sub()');
            return acc.get(this.model.dv, this.offsetOf(name, idx));
        }

        set(name, idx, value) {
            const f = this.field(name);
            const acc = this.model.accessor(f);
            if (!acc) throw new Error(f.name + ' is a struct; use sub()');
            acc.set(this.model.dv, this.offsetOf(name, idx), value);
            return this;
        }

        // a nested struct element (cva[i], custom_scale[i], time_divisions[c][s][k], ...)
        sub(name, idx) {
            const f = this.field(name);
            if (!this.model.structs[f.type]) throw new Error(f.name + ' is not a struct field');
            return new StructView(this.model, f.type, this.offsetOf(name, idx));
        }

        // char[] fields: NUL-terminated, the rest of the bytes left alone on read
        getString(name) {
            const f = this.field(name);
            const o = this.base + f.offset;
            const n = f.dims ? f.dims[0] : 1;
            let s = '';
            for (let i = 0; i < n; i++) {
                const c = this.model.dv.getUint8(o + i);
                if (c === 0) break;
                s += String.fromCharCode(c);
            }
            return s;
        }

        // Writes the string and zero-fills the remainder, so a name never carries
        // bytes of whatever was there before (which would make saves non-reproducible).
        setString(name, value) {
            const f = this.field(name);
            const o = this.base + f.offset;
            const n = f.dims ? f.dims[0] : 1;
            for (let i = 0; i < n; i++) {
                const c = i < value.length ? value.charCodeAt(i) & 0x7F : 0;
                this.model.dv.setUint8(o + i, i === n - 1 ? 0 : c);
            }
            return this;
        }

        bytes() { return new Uint8Array(this.model.buf, this.base, this.def.size); }
    }

    // ---------- the model: offsets.json plus a buffer ----------
    class Model {
        constructor(offsets, arrayBuffer) {
            this.offsets = offsets;
            this.structs = {};
            for (const [name, def] of Object.entries(offsets.structs)) {
                const byName = {};
                for (const f of def.fields) byName[f.name] = f;
                this.structs[name] = { size: def.size, fields: def.fields, byName };
            }
            this.enums = offsets.enums;
            this.consts = offsets.consts;
            this.layout = offsets.layout;
            this.attach(arrayBuffer);
        }

        attach(arrayBuffer) {
            this.buf = arrayBuffer;
            this.dv = new DataView(arrayBuffer);
            this.u8 = new Uint8Array(arrayBuffer);
            return this;
        }

        accessor(f) {
            if (SCALARS[f.type]) return SCALARS[f.type];
            if (this.enums[f.type]) return enumAccessor(this.enums[f.type].size);
            if (this.structs[f.type]) return null; // use sub()
            throw new Error('no accessor for type ' + f.type + ' (field ' + f.name + ')');
        }

        view(structName, base) { return new StructView(this, structName, base); }

        // enumerator value by name, so schema.js never hardcodes a number
        enumValue(enumName, key) {
            const e = this.enums[enumName];
            if (!e) throw new Error('unknown enum ' + enumName);
            const v = e.values.find((x) => x.name === key);
            if (!v) throw new Error(enumName + ' has no ' + key);
            return v.value;
        }

        // enumerators excluding the COUNT marker, in declaration order
        enumMembers(enumName) {
            const e = this.enums[enumName];
            if (!e) throw new Error('unknown enum ' + enumName);
            return e.values.filter((x) => !/^COUNT/.test(x.name));
        }
    }

    const api = { Model, StructView, crc32, SCALARS };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.Bin511 = api;
})(typeof window !== 'undefined' ? window : globalThis);
