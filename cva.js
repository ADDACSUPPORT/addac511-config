// CV assignments: reading, creating, editing and deleting them in a stored preset.
//
// The rules are the module's own (code/src/hmi/hmi_assign.cpp, addac511.cpp
// add_cva / remove_cva / process_cva_), so the panel only ever writes
// assignments the module could have created itself:
//   - inputs 0-7 CV IN, 8-11 CV OUT, 19-22 CLOCK IN (12-18 are never offered)
//   - analog functions stored as type 2 (BOTH), digital as type 1
//   - clock inputs drive digital functions only (the firmware's stated intent)
//   - gain and offset 0.00-1.00, as on the module's screen; ignored for clock
//     inputs, and not offered for digital functions (as on the module)
//   - id equals the position in the list; at most MAX_CV_ASSIGNS entries
// The function names come from offsets.js (generated from init_functions()).
(function (root) {
    'use strict';

    const TYPE_ANALOG = 0, TYPE_DIGITAL = 1, TYPE_BOTH = 2;

    // The CV-assign screen's inputs and names (hmi_assign.cpp, lines ~456-462).
    const INPUTS = [];
    for (let i = 0; i < 8; i++) INPUTS.push({ value: i, name: 'CV IN ' + (i + 1), clock: false });
    for (let i = 0; i < 4; i++) INPUTS.push({ value: 8 + i, name: 'CV OUT ' + (i + 1), clock: false });
    for (let i = 0; i < 4; i++) INPUTS.push({ value: 19 + i, name: 'CLOCK IN ' + (i + 1), clock: true });
    const isClockInput = (input) => input >= 19 && input <= 22;

    class CvAssignments {
        constructor(offsets) {
            this.max = offsets.consts.MAX_CV_ASSIGNS;
            this.channels = offsets.consts.N_CHANNELS;
            this.states = offsets.consts.N_STATES;
            this.logicInputs = offsets.consts.N_LOGIC_INPUTS;
            this.funcCount = offsets.cv.func_count;
            this.functions = offsets.cv.functions;
            this.byKey = new Map(this.functions.map((f) => [f.kind + ':' + f.id, f]));
            const cva = offsets.structs.Preset.fields.find((f) => f.name === 'cva');
            this.entrySize = cva.elem_size;
            this.defaultAnalog = this.functions.find((f) => f.kind === 'analog' && f.name === 'FUNC_VOLTAGE_MIN');
            this.firstDigital = this.functions.find((f) => f.kind === 'digital');
        }

        // ---------- catalogue ----------
        find(kind, id) { return this.byKey.get(kind + ':' + id) || null; }

        functionsFor(input) {
            return isClockInput(input) ? this.functions.filter((f) => f.kind === 'digital') : this.functions;
        }

        // ---------- one entry ----------
        // The kind of function a stored entry drives, decoding the same three
        // encodings the firmware does (cva_rules.h cv_assignment_is_digital).
        decode(view, index) {
            const type = view.get('function_type');
            const rawId = view.get('function_id');
            let kind, id, legacy = false;
            if (type === TYPE_ANALOG) {
                kind = 'analog'; id = rawId;
            } else if (type === TYPE_BOTH) {
                if (rawId >= this.funcCount) { kind = 'digital'; id = rawId - this.funcCount; legacy = true; } else { kind = 'analog'; id = rawId; }
            } else {
                kind = 'digital'; id = rawId;
            }
            const a = {
                index,
                input: view.get('input'),
                channel: view.get('channel'),
                state: view.get('state'),
                kind, id, legacy, type,
                gain: view.get('gain'),
                offset: view.get('offset'),
                inverted: view.get('inverted'),
            };
            a.fn = this.find(kind, id);
            a.problems = this.problems(a);
            return a;
        }

        // Would the firmware apply it safely? Mirrors cv_assignment_is_valid().
        isSafe(a) {
            return a.channel < this.channels && a.state >= 0 && a.state < this.states && a.input < this.logicInputs;
        }

        // Everything that makes an entry something the module would not have
        // created; the first two would be skipped by the firmware on load.
        problems(a) {
            const p = [];
            if (!(a.channel < this.channels)) p.push(`channel ${a.channel + 1} does not exist`);
            if (!(a.state >= 0 && a.state < this.states)) p.push(`state ${a.state} does not exist`);
            if (!INPUTS.some((i) => i.value === a.input)) p.push(`input ${a.input} is not one the module offers`);
            if (!a.fn) p.push(`unknown ${a.kind} function ${a.id}`);
            return p;
        }

        // Whether gain and offset can be set, as on the module's edit screen.
        // Clock inputs ignore them (process_cva_ only scales inputs below 12).
        // Digital functions do still scale a CV before their half-scale trigger
        // threshold, but the module does not offer gain and offset for them, so
        // neither does the panel; the stored values are left as they are.
        gainOffsetReason(a) {
            if (isClockInput(a.input) || a.input >= 12) return 'ignored for clock inputs';
            if (a.kind === 'digital') return 'not set for gate-triggered functions, as on the module';
            return null;
        }

        write(view, a) {
            view.set('input', undefined, a.input);
            view.set('channel', undefined, a.channel);
            view.set('state', undefined, a.state);
            view.set('function_type', undefined, a.kind === 'digital' ? TYPE_DIGITAL : TYPE_BOTH);
            view.set('function_id', undefined, a.id);
            view.set('gain', undefined, a.gain);
            view.set('offset', undefined, a.offset);
            view.set('inverted', undefined, !!a.inverted);
        }

        // ---------- the list in a preset ----------
        count(preset) {
            const n = preset.get('n_assigns');
            return n < 0 ? 0 : Math.min(n, this.max); // as preset_load() clamps it
        }

        list(preset) {
            const out = [];
            for (let i = 0, n = this.count(preset); i < n; i++) out.push(this.decode(preset.sub('cva', [i]), i));
            return out;
        }

        // A new assignment with the module's defaults (VMIN, gain 1, offset 0),
        // for the channel and state the user is looking at.
        add(preset, channel, state) {
            const n = this.count(preset);
            if (n >= this.max) throw new Error(`a preset holds at most ${this.max} CV assignments`);
            const v = preset.sub('cva', [n]);
            v.bytes().fill(0);
            v.set('id', undefined, n);
            this.write(v, {
                input: 0, channel: channel || 0, state: state || 0,
                kind: 'analog', id: this.defaultAnalog.id, gain: 1, offset: 0, inverted: false,
            });
            preset.set('n_assigns', undefined, n + 1);
            return n;
        }

        // Apply changes to one entry, keeping it something the module accepts.
        // Untouched fields keep their stored bytes.
        update(preset, index, changes) {
            const v = preset.sub('cva', [index]);
            const a = this.decode(v, index);
            if ('input' in changes) {
                a.input = changes.input;
                // a clock input cannot drive an analog function: switch to the first digital one
                if (isClockInput(a.input) && a.kind !== 'digital') { a.kind = 'digital'; a.id = this.firstDigital.id; }
                v.set('input', undefined, a.input);
            }
            if ('function' in changes) {
                const [kind, id] = changes.function;
                if (!this.find(kind, id)) throw new Error('unknown function ' + kind + ' ' + id);
                if (isClockInput(a.input) && kind !== 'digital') throw new Error('a clock input drives digital functions only');
                a.kind = kind; a.id = id;
            }
            if ('input' in changes || 'function' in changes) {
                v.set('function_type', undefined, a.kind === 'digital' ? TYPE_DIGITAL : TYPE_BOTH);
                v.set('function_id', undefined, a.id);
            }
            if ('channel' in changes) v.set('channel', undefined, clampInt(changes.channel, 0, this.channels - 1));
            if ('state' in changes) v.set('state', undefined, clampInt(changes.state, 0, this.states - 1));
            if ('gain' in changes) v.set('gain', undefined, clamp01(changes.gain));
            if ('offset' in changes) v.set('offset', undefined, clamp01(changes.offset));
            if ('inverted' in changes) v.set('inverted', undefined, !!changes.inverted);
            return this.decode(v, index);
        }

        // Remove one entry: later entries move up as raw bytes (so they are not
        // re-encoded), ids are renumbered as remove_cva() does, and the freed
        // slot is zeroed so saves stay deterministic.
        remove(preset, index) {
            const n = this.count(preset);
            if (index < 0 || index >= n) throw new Error('no assignment ' + (index + 1));
            for (let i = index; i < n - 1; i++) {
                preset.sub('cva', [i]).bytes().set(preset.sub('cva', [i + 1]).bytes());
            }
            preset.sub('cva', [n - 1]).bytes().fill(0);
            preset.set('n_assigns', undefined, n - 1);
            for (let i = 0; i < n - 1; i++) preset.sub('cva', [i]).set('id', undefined, i);
        }

        // Entries that drive the same parameter as a later one. They are
        // processed in list order, so the later entry's value is the one that
        // sticks: { index -> index of the entry that overrides it }.
        overridden(list) {
            const last = new Map(), out = new Map();
            for (const a of list) {
                const key = [a.channel, a.state, a.kind, a.id].join(':');
                if (last.has(key)) out.set(last.get(key), a.index);
                last.set(key, a.index);
            }
            return out;
        }
    }

    const clamp01 = (v) => Math.min(1, Math.max(0, Number(v) || 0));
    const clampInt = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(v) || 0)));

    const api = { CvAssignments, INPUTS, isClockInput, TYPE_ANALOG, TYPE_DIGITAL, TYPE_BOTH };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.Cva511 = api;
})(typeof window !== 'undefined' ? window : globalThis);
