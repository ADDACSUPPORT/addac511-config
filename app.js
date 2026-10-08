// The UI. The only file that touches the DOM.
//
// Rendering is a full rebuild on every change, with focus restored by element id.
// That keeps state handling trivial for a page with this many interdependent
// fields: there is one source of truth (the image bytes) and the screen is always
// a pure function of it.
(function () {
    'use strict';

    const offsets = window.Offsets511;
    const Bin = window.Bin511;
    const U = window.Units511;
    const Schema = window.Schema511;
    const { Image511, TRAILER } = window.Image511;
    const { SerialSource, FileSource } = window.Serial511;
    const Firmware = window.Firmware511;
    const HELP = window.Help511;
    const Cva = window.Cva511;
    const CV = new Cva.CvAssignments(offsets);

    const N_CH = offsets.consts.N_CHANNELS;
    const N_ST = offsets.consts.N_STATES;
    const STATE_NAMES = ['A', 'B', 'C'];
    const MAX_STEPS = offsets.consts.MAX_SEQUENCER_STEPS;

    const TABS = [
        { id: 'presets', title: 'Presets' },
        { id: 'global', title: 'Global' },
        { id: 'voltage', title: 'Voltage' },
        { id: 'quantize', title: 'Quantize' },
        { id: 'gate', title: 'Gate' },
        { id: 'probability', title: 'Probability' },
        { id: 'smooth', title: 'Smooth' },
        { id: 'time', title: 'Time' },
        { id: 'envelope', title: 'Envelope' },
        { id: 'clock', title: 'Clock' },
        { id: 'sequencer', title: 'Sequencer' },
        { id: 'assign', title: 'CV & Logic' },
        { id: 'scales', title: 'Scales' },
        { id: 'firmware', title: 'Firmware' },
    ];

    const S = {
        img: null,
        baseline: null,
        source: null,
        serial: null,
        tab: 'presets',
        ch: 0,
        st: 0,
        slot: 0,
        messages: [],
        busy: null,
        // firmware updates: the manifest is fetched the first time the tab opens
        fw: {
            channel: Firmware.channelFromUrl(typeof location !== 'undefined' ? location.search : ''),
            manifest: null,
            loading: false,
            error: null,
        },
    };

    // ---------- tiny dom helper ----------
    function el(tag, props, ...kids) {
        const n = document.createElement(tag);
        // Allow el('tbody', rows) as well as el('tbody', {}, rows): anything that is
        // not a plain attribute object is a child. Without this, passing a node or
        // an array as the second argument silently drops it and sets junk attributes.
        if (props !== null && props !== undefined &&
            (typeof props !== 'object' || Array.isArray(props) || props.tagName || props.nodeType)) {
            kids.unshift(props);
            props = null;
        }
        for (const [k, v] of Object.entries(props || {})) {
            if (v === undefined || v === null || v === false) continue;
            if (k === 'class') n.className = v;
            else if (k === 'text') n.textContent = v;
            else if (k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(), v);
            else if (k === 'html') n.innerHTML = v;
            else n.setAttribute(k, v === true ? '' : v);
        }
        for (const kid of kids.flat()) {
            if (kid === null || kid === undefined || kid === false) continue;
            n.appendChild(typeof kid === 'object' ? kid : document.createTextNode(String(kid)));
        }
        return n;
    }
    const $ = (id) => document.getElementById(id);

    // Native Element.append() turns null into the text "null", which is how
    // "null" once showed up beside unit-less number fields. Optional children
    // are passed as null throughout, so always append through here.
    function add(parent, ...kids) {
        parent.append(...kids.flat().filter((k) => k !== null && k !== undefined && k !== false));
        return parent;
    }

    function say(text, kind) { S.messages.push({ text, kind: kind || 'note' }); }

    // ---------- field access ----------
    // One place that knows how a schema entry maps onto the stored bytes.
    function viewFor(img, section, desc) {
        const scope = desc.scope || section.scope;
        if (scope === 'global') return { view: img.common, idx: undefined };
        const p = img.preset(S.slot);
        if (scope === 'c') return { view: p, idx: [S.ch] };
        if (scope === 'cs') return { view: p, idx: [S.ch, S.st] };
        return { view: p, idx: undefined };
    }

    function readRaw(img, section, desc, stepIdx) {
        const { view, idx } = viewFor(img, section, desc);
        if (desc.sub && desc.member) {
            const i = stepIdx === undefined ? idx : (idx || []).concat(stepIdx);
            return view.sub(desc.sub, i).get(desc.member);
        }
        if (desc.sub) return view.sub(desc.sub, stepIdx === undefined ? idx : (idx || []).concat(stepIdx));
        const i = stepIdx === undefined ? idx : (idx || []).concat(stepIdx);
        return view.get(desc.key, i);
    }

    function writeRaw(img, section, desc, value, stepIdx) {
        const { view, idx } = viewFor(img, section, desc);
        if (desc.sub && desc.member) {
            const i = stepIdx === undefined ? idx : (idx || []).concat(stepIdx);
            view.sub(desc.sub, i).set(desc.member, undefined, value);
        } else {
            const i = stepIdx === undefined ? idx : (idx || []).concat(stepIdx);
            view.set(desc.key, i, value);
        }
        afterEdit();
    }

    function afterEdit() {
        // Any touched slot must be restamped or the module reports it corrupt.
        S.img.stampDirtySlots();
        render();
    }

    // enum helpers -------------------------------------------------------------
    function enumOptions(desc) {
        const members = new Bin.Model(offsets, new ArrayBuffer(8)).enumMembers(desc.enumName);
        const labels = Schema.LABELS[desc.enumName];
        return members.map((m) => ({
            value: m.value,
            label: desc.multDivLabels ? U.clockMultDivLabel(m.name)
                : desc.enumName === 'BitResolution' ? m.value + ' bit'
                : (labels && labels[m.name]) || m.name,
            name: m.name,
        })).filter((o) => !(desc.min !== undefined && o.value < desc.min));
    }

    // the current per-state values, keyed the way schema `when` predicates expect
    function stateValues(section) {
        const out = {};
        const names = {};
        for (const s of Schema.SECTIONS) for (const d of s.fields) names[d.key] = { s, d };
        for (const [key, { s, d }] of Object.entries(names)) {
            if (d.type !== 'enum' && d.type !== 'bool') continue;
            try {
                const raw = readRaw(S.img, s, d);
                if (d.type === 'enum') {
                    const o = enumOptions(d).find((x) => x.value === raw);
                    out[key] = o ? o.name : raw;
                } else out[key] = raw;
            } catch (e) { /* not addressable in this context */ }
        }
        return out;
    }

    // ---------- (i) descriptions ----------
    // Each (i) toggles its description from help.js. `inst` tells apart repeated
    // rows - the eight custom-scale cards each have a NAME - so opening one does
    // not open them all, and every button keeps a unique, stable id (render()
    // restores focus by id).
    const openInfo = new Set();
    const infoSlot = (key, inst) => key + (inst === undefined ? '' : '#' + inst);
    const infoDomId = (key, inst) => 'info-' + infoSlot(key, inst).replace(/[^\w-]/g, '_');

    function infoButton(key, label, inst) {
        if (!HELP[key]) return null;
        const slot = infoSlot(key, inst);
        const open = openInfo.has(slot);
        return el('button', {
            type: 'button', class: 'info', id: infoDomId(key, inst) + '-btn',
            title: 'About ' + label, 'aria-label': 'About ' + label,
            'aria-expanded': String(open), 'aria-controls': infoDomId(key, inst),
            onclick: () => { if (open) openInfo.delete(slot); else openInfo.add(slot); render(); },
        }, 'i');
    }

    function infoText(key, inst) {
        return HELP[key] && openInfo.has(infoSlot(key, inst))
            ? el('div', { class: 'desc', id: infoDomId(key, inst) }, HELP[key]) : null;
    }

    // a card heading with its (i), and the description under it when open
    const cardHead = (title, key, inst) => [
        el('h2', {}, title, infoButton(key, title, inst)),
        infoText(key, inst),
    ];

    // table column headings with (i); open descriptions go above the table
    const headCell = (label, key) => el('th', {}, label, key ? infoButton(key, label) : null);
    const columnNotes = (keys) => el('div', { class: 'colnotes' }, keys.map((k) => infoText(k)));

    // ---------- widgets ----------
    let rowSeq = 0;

    function fieldRow(section, desc, opts) {
        opts = opts || {};
        const id = 'f_' + section.id + '_' + desc.key.replace(/\W/g, '_') + '_' + (rowSeq++);
        // 'note' and 'tdiv' address a whole nested struct, so they are compared by
        // bytes rather than as a single value.
        const isStruct = desc.type === 'note' || desc.type === 'tdiv';
        let raw = null, was = null, changed = false;
        if (isStruct) {
            changed = !sameBytes(subBytes(S.img, section, desc), subBytes(S.baseline, section, desc));
        } else {
            raw = readRaw(S.img, section, desc);
            try { was = readRaw(S.baseline, section, desc); } catch (e) { was = raw; }
            changed = !sameValue(raw, was);
        }

        const ctl = el('div', { class: 'ctl' });
        const hints = [];
        buildControl(ctl, hints, section, desc, raw, id);

        if (changed && !isStruct) hints.push(el('span', { class: 'was', text: 'was ' + display(desc, was, section) }));
        else if (changed) hints.push(el('span', { class: 'was', text: 'changed' }));

        const scope = desc.scope || section.scope;
        const row = el('div', { class: 'row' + (changed ? ' changed' : '') },
            el('div', { class: 'lbl' }, el('span', {}, desc.label),
                scope === 'c' ? el('span', { class: 'tag', text: 'ch' }) : null,
                scope === 'global' ? el('span', { class: 'tag', text: 'global' }) : null,
                infoButton(desc.key, desc.label)),
            ctl,
            hints.length ? el('div', { class: 'hint' }, hints.map((h, i) => i ? [' · ', h] : h)) : null,
            infoText(desc.key));
        return row;
    }

    function subBytes(img, section, desc) {
        const { view, idx } = viewFor(img, section, desc);
        return view.sub(desc.sub || desc.key, idx).bytes();
    }

    function sameBytes(a, b) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
        return true;
    }

    function sameValue(a, b) {
        if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-9;
        return a === b;
    }

    function display(desc, v, section) {
        switch (desc.type) {
            case 'enum': {
                const o = enumOptions(desc).find((x) => x.value === v);
                return o ? o.label : String(v);
            }
            case 'bool': return v ? (desc.trueLabel || 'ON') : (desc.falseLabel || 'OFF');
            case 'percent': return U.percent(v);
            case 'voltage': return U.formatVolts(v, cvMode());
            case 'timeUs': return U.formatTime(v);
            case 'gateSize': return U.gateSizeLabel(v);
            case 'scale': return scaleName(v);
            default:
                if (desc.choices) {
                    const i = desc.choices.indexOf(v);
                    if (i >= 0) return desc.choiceLabels[i];
                }
                if (desc.zeroLabel && v === 0) return desc.zeroLabel;
                if (desc.inputNames) return Schema.INPUT_NAMES[v] || String(v);
                if (desc.optionLabels && desc.optionLabels[v] !== undefined) return desc.optionLabels[v];
                return String(typeof v === 'number' && !Number.isInteger(v) ? +v.toFixed(3) : v);
        }
    }

    const cvMode = () => {
        try { return S.img.preset(S.slot).get('cv_mode', [S.ch]); } catch (e) { return U.UNIPOLAR; }
    };

    function scaleName(id) {
        if (id < Schema.BUILTIN_SCALES.length) return Schema.BUILTIN_SCALES[id];
        const i = id - 8;
        const nm = S.img.preset(S.slot).sub('custom_scale', [i]).getString('name');
        return 'CUSTOM ' + (i + 1) + (nm ? ' (' + nm + ')' : '');
    }

    function buildControl(ctl, hints, section, desc, raw, id) {
        const set = (v) => writeRaw(S.img, section, desc, v);

        const selectOf = (options, current, onPick) => {
            const sel = el('select', { id, onchange: (e) => onPick(Number(e.target.value)) },
                options.map((o) => el('option', { value: o.value, selected: o.value === current }, o.label)));
            if (!options.some((o) => o.value === current)) {
                sel.appendChild(el('option', { value: current, selected: true }, '(' + current + ')'));
            }
            return sel;
        };

        switch (desc.type) {
            case 'enum':
                ctl.appendChild(selectOf(enumOptions(desc), raw, set));
                break;

            case 'bool':
                ctl.appendChild(selectOf(
                    [{ value: 0, label: desc.falseLabel || 'OFF' }, { value: 1, label: desc.trueLabel || 'ON' }],
                    raw ? 1 : 0, (v) => set(!!v)));
                break;

            case 'scale': {
                const opts = Schema.BUILTIN_SCALES.map((n, i) => ({ value: i, label: n }));
                for (let i = 0; i < offsets.consts.N_CUSTOM_SCALES; i++) opts.push({ value: 8 + i, label: scaleName(8 + i) });
                ctl.appendChild(selectOf(opts, raw, set));
                break;
            }

            case 'voltage': {
                const mode = cvMode();
                const num = el('input', {
                    type: 'number', id, step: 0.01, min: U.normToVolts(0, mode), max: U.normToVolts(1, mode),
                    value: U.normToVolts(raw, mode).toFixed(3),
                    onchange: (e) => set(clamp01(U.voltsToNorm(Number(e.target.value), mode))),
                });
                add(ctl, el('input', {
                    type: 'range', min: 0, max: 1, step: 0.001, value: raw,
                    'aria-label': desc.label,
                    oninput: (e) => set(Number(e.target.value)),
                }), num, el('span', { class: 'readout', text: 'V · ' + U.formatNote(raw, mode) }));
                break;
            }

            case 'percent':
                add(ctl, el('input', {
                    type: 'range', min: 0, max: 100, step: 1, value: Math.round(raw * 100),
                    'aria-label': desc.label, oninput: (e) => set(Number(e.target.value) / 100),
                }), el('input', {
                    type: 'number', id, min: 0, max: 100, step: 1, value: Math.round(raw * 100),
                    onchange: (e) => set(clamp01(Number(e.target.value) / 100)),
                }), el('span', { class: 'readout', text: '%' }));
                break;

            case 'timeUs': {
                const ms = U.usToMs(raw);
                add(ctl, el('input', {
                    type: 'number', id, min: 0, step: 1, value: +ms.toFixed(3),
                    onchange: (e) => set(Math.max(0, U.msToUs(Number(e.target.value)))),
                }), el('span', { class: 'readout', text: 'ms · ' + U.formatTime(raw) }));
                break;
            }

            case 'gateSize': {
                const codes = U.GATE_CODES.map((c) => ({ value: Math.round(c.v * 100), label: c.label }));
                const isCode = U.GATE_CODES.some((c) => Math.abs(c.v - raw) < 0.005);
                const pctVal = Math.round(raw * 100);
                ctl.appendChild(selectOf(
                    codes.concat(isCode ? [] : [{ value: pctVal, label: pctVal + ' %' }]),
                    pctVal, (v) => set(v / 100)));
                add(ctl, el('input', {
                    type: 'number', id, min: 2, max: 90, step: 1, value: pctVal,
                    title: 'percent of the time until the next value',
                    onchange: (e) => set(Math.min(90, Math.max(2, Number(e.target.value))) / 100),
                }), el('span', { class: 'readout', text: '%' }));
                break;
            }

            case 'note': {
                const n = readRaw(S.img, section, { key: desc.key, scope: desc.scope, sub: desc.key, member: 'semitone' });
                const cents = readRaw(S.img, section, { key: desc.key, scope: desc.scope, sub: desc.key, member: 'cents' });
                const mode = cvMode();
                const writeNote = (semi, c) => {
                    const { view, idx } = viewFor(S.img, section, desc);
                    const sub = view.sub(desc.key, idx);
                    sub.set('semitone', undefined, semi);
                    sub.set('cents', undefined, c);
                    sub.set('v', undefined, U.noteToV(semi, c, mode));
                    afterEdit();
                };
                add(ctl, el('input', {
                    type: 'number', id, min: -60, max: 60, step: 1, value: n,
                    onchange: (e) => writeNote(Math.round(Number(e.target.value)), cents),
                }), el('span', { class: 'readout', text: U.NOTE_NAMES[((n % 12) + 12) % 12] }),
                    el('input', {
                        type: 'number', min: -50, max: 50, step: 1, value: +cents.toFixed(1),
                        title: 'cents',
                        onchange: (e) => writeNote(n, Number(e.target.value)),
                    }), el('span', { class: 'readout', text: 'cents' }));
                break;
            }

            case 'tdiv': {
                const { view, idx } = viewFor(S.img, section, desc);
                const sub = view.sub(desc.sub, idx);
                const put = (k, v) => { sub.set(k, undefined, v); afterEdit(); };
                add(ctl, el('input', {
                    type: 'number', id, min: 1, max: 31, step: 1, value: sub.get('numerator'),
                    onchange: (e) => put('numerator', clampInt(e.target.value, 1, 31)),
                }), el('span', { text: '/' }), el('input', {
                    type: 'number', min: 1, max: 31, step: 1, value: sub.get('denominator'),
                    onchange: (e) => put('denominator', clampInt(e.target.value, 1, 31)),
                }));
                break;
            }

            default: {
                // int / float, with choices or a plain slider+number
                if (desc.choices) {
                    ctl.appendChild(selectOf(
                        desc.choices.map((c, i) => ({ value: c, label: desc.choiceLabels[i] })), raw, set));
                    break;
                }
                if (desc.inputNames) {
                    ctl.appendChild(selectOf(
                        Schema.INPUT_NAMES.map((n, i) => ({ value: i, label: n })), raw, set));
                    break;
                }
                if (desc.optionLabels) {
                    ctl.appendChild(selectOf(
                        desc.optionLabels.map((n, i) => ({ value: i, label: n })), raw, set));
                    break;
                }
                const isInt = desc.type === 'int';
                const step = desc.step || (isInt ? 1 : 0.01);
                add(ctl, el('input', {
                    type: 'range', min: desc.min, max: desc.max, step, value: raw,
                    'aria-label': desc.label,
                    oninput: (e) => set(isInt ? Math.round(Number(e.target.value)) : Number(e.target.value)),
                }), el('input', {
                    type: 'number', id, min: desc.min, max: desc.max, step, value: isInt ? raw : +raw.toFixed(4),
                    onchange: (e) => {
                        let v = Number(e.target.value);
                        v = Math.min(desc.max, Math.max(desc.min, v));
                        set(isInt ? Math.round(v) : v);
                    },
                }), desc.unit ? el('span', { class: 'readout', text: desc.unit }) : null,
                    desc.zeroLabel && raw === 0 ? el('span', { class: 'readout', text: desc.zeroLabel }) : null);
            }
        }

        // "copy to" - the editor's answer to the module's long-press copy. Without
        // it, setting one value across 4 channels x 3 states is 12 edits.
        const scope = desc.scope || section.scope;
        if (scope === 'cs' || scope === 'c') {
            ctl.appendChild(el('button', {
                class: 'copy', title: 'Copy this value to other channels and states',
                onclick: () => copyAcross(section, desc),
            }, '⇒ all'));
        }
    }

    const clamp01 = (v) => Math.min(1, Math.max(0, v));
    const clampInt = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(v))));

    function copyAcross(section, desc) {
        const value = readRaw(S.img, section, desc);
        const scope = desc.scope || section.scope;
        const ch = S.ch, st = S.st;
        for (let c = 0; c < N_CH; c++) {
            for (let s = 0; s < N_ST; s++) {
                S.ch = c; S.st = s;
                if (scope === 'c' && s > 0) continue;
                try { writeRawQuiet(section, desc, value); } catch (e) { /* skip */ }
            }
        }
        S.ch = ch; S.st = st;
        say(`${desc.label} copied to all channels and states.`);
        afterEdit();
    }

    function writeRawQuiet(section, desc, value) {
        const { view, idx } = viewFor(S.img, section, desc);
        if (desc.sub && desc.member) view.sub(desc.sub, idx).set(desc.member, undefined, value);
        else view.set(desc.key, idx, value);
    }

    // ---------- tabs ----------
    function renderSectionTab(host, sectionId) {
        const section = Schema.SECTIONS.find((s) => s.id === sectionId);
        if (!section) return;
        const values = stateValues(section);

        if (section.when && !section.when(values)) {
            host.appendChild(el('p', { class: 'lead' },
                'This group only applies when VOLTAGE MODE is ENVELOPE for the selected channel and state.'));
        }
        if (section.lead) host.appendChild(el('p', { class: 'lead', text: section.lead }));

        const visible = section.fields.filter((d) => !d.when || d.when(values));
        const hidden = section.fields.length - visible.length;

        const card = el('section', { class: 'card' }, el('h2', { text: section.title }),
            visible.map((d) => fieldRow(section, d)));
        const grid = el('div', { class: 'grid' }, card);
        host.appendChild(grid);

        if (hidden) {
            host.appendChild(el('p', { class: 'lead', text:
                `${hidden} field${hidden > 1 ? 's' : ''} hidden: not used with the current mode, exactly as on the module.` }));
        }
        if (section.steps) renderSteps(host, section);
        if (sectionId === 'quantize') renderNoteProbabilities(host);
        if (sectionId === 'time') renderTimeDivisions(host);
    }

    function renderSteps(host, section) {
        const p = S.img.preset(S.slot);
        const n = p.get(section.steps.count, [S.ch, S.st]);
        const mode = cvMode();
        const head = el('tr', el('th', { text: '#' }), section.steps.columns.map((c) => headCell(c.label, c.key)));
        const rows = [];
        for (let k = 0; k < MAX_STEPS; k++) {
            const tds = [el('td', { class: 'n', text: String(k + 1) })];
            for (const c of section.steps.columns) {
                const td = el('td');
                const idx = [S.ch, S.st, k];
                if (c.type === 'bool') {
                    td.appendChild(el('input', {
                        type: 'checkbox', checked: p.get(c.key, idx),
                        'aria-label': c.label + ' step ' + (k + 1),
                        onchange: (e) => { p.set(c.key, idx, e.target.checked); afterEdit(); },
                    }));
                } else if (c.type === 'voltage') {
                    const v = p.get(c.key, idx);
                    add(td, el('input', {
                        type: 'number', step: 0.01, value: +U.normToVolts(v, mode).toFixed(3),
                        'aria-label': c.label + ' step ' + (k + 1),
                        onchange: (e) => { p.set(c.key, idx, clamp01(U.voltsToNorm(Number(e.target.value), mode))); afterEdit(); },
                    }), el('span', { class: 'readout', text: U.formatNote(v, mode) }));
                } else if (c.type === 'timeUs') {
                    td.appendChild(el('input', {
                        type: 'number', step: 1, min: 0, value: +U.usToMs(p.get(c.key, idx)).toFixed(2),
                        'aria-label': c.label + ' step ' + (k + 1),
                        onchange: (e) => { p.set(c.key, idx, Math.max(0, U.msToUs(Number(e.target.value)))); afterEdit(); },
                    }));
                } else if (c.type === 'percent') {
                    td.appendChild(el('input', {
                        type: 'number', step: 1, min: 0, max: 100, value: Math.round(p.get(c.key, idx) * 100),
                        'aria-label': c.label + ' step ' + (k + 1),
                        onchange: (e) => { p.set(c.key, idx, clamp01(Number(e.target.value) / 100)); afterEdit(); },
                    }));
                } else if (c.type === 'tdiv') {
                    const sub = p.sub(c.key, idx);
                    add(td, el('input', {
                        type: 'number', min: 1, max: 31, value: sub.get('numerator'),
                        'aria-label': 'numerator step ' + (k + 1),
                        onchange: (e) => { sub.set('numerator', undefined, clampInt(e.target.value, 1, 31)); afterEdit(); },
                    }), el('span', { text: '/' }), el('input', {
                        type: 'number', min: 1, max: 31, value: sub.get('denominator'),
                        'aria-label': 'denominator step ' + (k + 1),
                        onchange: (e) => { sub.set('denominator', undefined, clampInt(e.target.value, 1, 31)); afterEdit(); },
                    }));
                }
                tds.push(td);
            }
            rows.push(el('tr', { class: k >= n ? 'beyond' : '' }, tds));
        }
        host.appendChild(el('section', { class: 'card wide' },
            el('h2', { text: 'Steps · channel ' + (S.ch + 1) + ' state ' + STATE_NAMES[S.st] }),
            el('p', { class: 'lead', text: `Steps beyond ${n} are dimmed: the sequencer only plays the first ${n}.` }),
            columnNotes(section.steps.columns.map((c) => c.key)),
            el('table', { class: 'steps' }, el('thead', head), el('tbody', rows))));
    }

    function renderNoteProbabilities(host) {
        const p = S.img.preset(S.slot);
        const rows = U.NOTE_NAMES.map((nm, k) => {
            const v = p.get('note_probabilities', [S.ch, S.st, k]);
            return el('div', { class: 'row' },
                el('div', { class: 'lbl', text: nm }),
                el('div', { class: 'ctl' },
                    el('input', {
                        type: 'range', min: 0, max: 100, step: 1, value: Math.round(v * 100),
                        'aria-label': 'probability of ' + nm,
                        oninput: (e) => { p.set('note_probabilities', [S.ch, S.st, k], Number(e.target.value) / 100); afterEdit(); },
                    }),
                    el('span', { class: 'readout', text: U.percent(v) })));
        });
        // one (i) for the card: the twelve note rows share its description
        host.appendChild(el('div', { class: 'grid' }, el('section', { class: 'card described' },
            cardHead('Note probabilities', 'note_probabilities'),
            el('p', { class: 'lead', text: 'Used when ROUNDING is NOTE PROBABILITY.' }), rows)));
    }

    function renderTimeDivisions(host) {
        const p = S.img.preset(S.slot);
        const n = offsets.consts.N_TIME_DIVISIONS;
        const rows = [];
        for (let k = 0; k < n; k++) {
            const sub = p.sub('time_divisions', [S.ch, S.st, k]);
            rows.push(el('tr',
                el('td', { class: 'n', text: String(k + 1) }),
                el('td', el('input', {
                    type: 'number', min: 1, max: 99, value: sub.get('numerator'),
                    'aria-label': 'numerator ' + (k + 1),
                    onchange: (e) => { sub.set('numerator', undefined, clampInt(e.target.value, 1, 99)); afterEdit(); },
                }), el('span', { text: ' / ' }), el('input', {
                    type: 'number', min: 1, max: 99, value: sub.get('denominator'),
                    'aria-label': 'denominator ' + (k + 1),
                    onchange: (e) => { sub.set('denominator', undefined, clampInt(e.target.value, 1, 99)); afterEdit(); },
                })),
                el('td', el('input', {
                    type: 'number', min: 0, max: 100, value: Math.round(sub.get('probability') * 100),
                    'aria-label': 'probability ' + (k + 1),
                    onchange: (e) => { sub.set('probability', undefined, clamp01(Number(e.target.value) / 100)); afterEdit(); },
                }), el('span', { class: 'readout', text: '%' }))));
        }
        host.appendChild(el('section', { class: 'card wide' },
            cardHead('Time divisions', 'time_divisions'),
            el('p', { class: 'lead', text: 'Each division can be given a probability; zero means it is never chosen.' }),
            el('table', { class: 'steps' },
                el('thead', el('tr', el('th', { text: '#' }), el('th', { text: 'Division' }), el('th', { text: 'Probability' }))),
                el('tbody', rows))));
    }

    // ---------- presets tab ----------
    function renderPresets(host) {
        host.appendChild(el('p', { class: 'lead' },
            'The module has 16 slots. ',
            el('b', { text: 'Legacy' }),
            ' means the slot was written by firmware older than the one that stamps a checksum — ' +
            'it still loads normally. Editing a slot restamps it.'));

        const items = [];
        for (let i = 0; i < S.img.maxPresets; i++) {
            const occupied = S.img.isOccupied(i);
            const status = S.img.trailerStatus(i);
            const sel = i === S.slot;
            items.push(el('li', { class: sel ? 'sel' : '' },
                el('span', { class: 'n', text: String(i + 1) }),
                occupied
                    ? el('input', {
                        type: 'text', class: 'nm', value: S.img.presetName(i), maxlength: 19,
                        'aria-label': 'name of preset ' + (i + 1),
                        onchange: (e) => {
                            const v = e.target.value.toUpperCase();
                            if (v.includes('!FIM!')) { say('A preset name cannot contain "!FIM!" — it would truncate a restore on older firmware.', 'err'); render(); return; }
                            S.img.preset(i).setString('name', v); afterEdit();
                        },
                    })
                    : el('span', { class: 'nm' }, el('span', { class: 'tag empty', text: 'empty' })),
                occupied && status === TRAILER.LEGACY ? el('span', { class: 'tag legacy', text: 'legacy' }) : null,
                occupied && status === TRAILER.BAD_CRC ? el('span', { class: 'tag bad', text: 'checksum' }) : null,
                occupied && status === TRAILER.CURRENT ? el('span', { class: 'tag', text: 'ok' }) : null,
                occupied ? el('button', { onclick: () => { S.slot = i; S.tab = 'voltage'; render(); } }, 'Edit') : null,
                occupied ? el('button', {
                    onclick: () => {
                        const free = S.img.firstFreeSlot();
                        if (free < 0) { say('All 16 slots are in use.', 'err'); render(); return; }
                        S.img.duplicate(i, free); say(`Preset ${i + 1} duplicated into slot ${free + 1}.`); render();
                    },
                }, 'Duplicate') : null,
                occupied ? el('button', {
                    class: 'danger',
                    onclick: () => {
                        if (!confirm(`Delete preset ${i + 1} (${S.img.presetName(i)})?`)) return;
                        S.img.deleteSlot(i); say(`Preset ${i + 1} deleted. Nothing is written until you save or write to the module.`); render();
                    },
                }, 'Delete') : null,
                occupied && i > 0 ? el('button', { title: 'Move up', onclick: () => { S.img.moveSlot(i, i - 1); render(); } }, '↑') : null,
                occupied && i < S.img.maxPresets - 1 ? el('button', { title: 'Move down', onclick: () => { S.img.moveSlot(i, i + 1); render(); } }, '↓') : null));
        }

        const selOpts = [];
        for (let i = 0; i < S.img.maxPresets; i++) if (S.img.isOccupied(i)) selOpts.push({ v: i, l: (i + 1) + ' · ' + S.img.presetName(i) });

        host.appendChild(el('div', { class: 'grid' },
            el('section', { class: 'card wide' },
                cardHead('Slots', 'preset_slots'),
                el('ul', { class: 'slots' }, items),
                el('div', { class: 'actions', style: 'margin-top:10px' },
                    el('button', {
                        onclick: () => importFromFile(),
                    }, 'Import preset from another .bin…'))),
            el('section', { class: 'card' },
                el('h2', { text: 'Selected at startup' }),
                el('div', { class: 'row' },
                    el('div', { class: 'lbl' }, el('span', {}, 'LOADS ON POWER-UP'), infoButton('selected', 'LOADS ON POWER-UP')),
                    el('div', { class: 'ctl' },
                        el('select', {
                            onchange: (e) => { S.img.common.set('selected', undefined, Number(e.target.value)); afterEdit(); },
                        }, el('option', { value: -1, selected: S.img.common.get('selected') < 0 }, 'none (default preset)'),
                            selOpts.map((o) => el('option', { value: o.v, selected: S.img.common.get('selected') === o.v }, o.l)))),
                    infoText('selected')))));
    }

    function importFromFile() {
        const input = el('input', { type: 'file', accept: '.bin', style: 'display:none' });
        input.addEventListener('change', async () => {
            if (!input.files[0]) return;
            try {
                const { bytes } = await FileSource.read(input.files[0]);
                const other = new Image511(offsets, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
                const avail = other.occupiedSlots();
                if (!avail.length) { say('That file has no presets in it.', 'err'); render(); return; }
                const list = avail.map((i) => `${i + 1}: ${other.presetName(i)}`).join('\n');
                const pick = prompt('Which preset should be imported?\n\n' + list + '\n\nEnter its number:');
                if (pick === null) return;
                const from = parseInt(pick, 10) - 1;
                if (!avail.includes(from)) { say('That slot is empty in the chosen file.', 'err'); render(); return; }
                const free = S.img.firstFreeSlot();
                if (free < 0) { say('All 16 slots are in use — delete one first.', 'err'); render(); return; }
                S.img.copySlot(other, from, free);
                say(`"${other.presetName(from)}" imported into slot ${free + 1}.`);
            } catch (e) {
                say('Could not read that file: ' + e.message, 'err');
            }
            render();
        });
        document.body.appendChild(input);
        input.click();
        setTimeout(() => input.remove(), 0);
    }

    // ---------- CV & logic ----------
    function renderAssign(host) {
        const p = S.img.preset(S.slot);
        const list = CV.list(p);
        const overridden = CV.overridden(list);
        const full = list.length >= CV.max;

        host.appendChild(el('p', { class: 'lead' },
            `${list.length} of ${CV.max} CV assignments in use. A parameter under CV control is read-only on the module. ` +
            'Assignments are applied top to bottom, so when two drive the same parameter the lower one wins.'));

        const rows = [];
        for (const a of list) {
            const i = a.index;
            const label = (what) => what + ' of assignment ' + (i + 1);
            const set = (changes) => {
                try { CV.update(p, i, changes); } catch (e) { say(e.message, 'err'); }
                afterEdit();
            };

            // the function list: what this input can drive, grouped by kind
            const choices = CV.functionsFor(a.input);
            const group = (kind, title) => {
                const fs = choices.filter((f) => f.kind === kind);
                return fs.length ? el('optgroup', { label: title }, fs.map((f) => el('option', {
                    value: f.kind + ':' + f.id, selected: f.kind === a.kind && f.id === a.id,
                }, f.short + ' · ' + f.desc + (f.handled ? '' : ' (no effect)')))) : null;
            };
            const fnSelect = el('select', {
                'aria-label': label('function'),
                onchange: (e) => { const [k, id] = e.target.value.split(':'); set({ function: [k, Number(id)] }); },
            }, group('analog', 'Follows the CV'), group('digital', 'Triggered when the CV goes high'),
                a.fn ? null : el('option', { value: '', selected: true }, `(unknown ${a.kind} ${a.id})`));

            const why = CV.gainOffsetReason(a);
            const gain = el('input', {
                type: 'number', min: 0, max: 1, step: 0.01, value: +a.gain.toFixed(2),
                disabled: !!why, title: why || 'gain, 0.00 to 1.00', 'aria-label': label('gain'),
                onchange: (e) => set({ gain: Number(e.target.value) }),
            });
            const offset = el('input', {
                type: 'number', min: 0, max: 5, step: 0.05, value: +(a.offset * 5).toFixed(2),
                disabled: !!why, title: why || 'offset in volts, 0 to 5 V', 'aria-label': label('offset'),
                onchange: (e) => set({ offset: Number(e.target.value) / 5 }),
            });

            const notes = [];
            if (a.problems.length) notes.push('Not something the module creates: ' + a.problems.join('; ') + '.' +
                (CV.isSafe(a) ? '' : ' The firmware skips it when loading the preset.'));
            if (a.fn && !a.fn.handled) notes.push('This function has no effect in the current firmware.');
            if (overridden.has(i)) notes.push(`Assignment ${overridden.get(i) + 1} drives the same parameter and is applied after this one, so it wins.`);
            if (why && a.kind === 'analog' && (a.gain !== 1 || a.offset !== 0)) notes.push('Stored gain/offset are ' + why + '.');

            rows.push(el('tr', { class: a.problems.length ? 'bad' : '' },
                el('td', { class: 'n', text: String(i + 1) }),
                el('td', el('select', {
                    'aria-label': label('input'),
                    onchange: (e) => set({ input: Number(e.target.value) }),
                }, Cva.INPUTS.map((x) => el('option', { value: x.value, selected: x.value === a.input }, x.name)),
                    Cva.INPUTS.some((x) => x.value === a.input) ? null : el('option', { value: a.input, selected: true }, `(input ${a.input})`))),
                el('td', el('select', {
                    'aria-label': label('channel'), onchange: (e) => set({ channel: Number(e.target.value) }),
                }, [0, 1, 2, 3].map((k) => el('option', { value: k, selected: a.channel === k }, 'CH ' + (k + 1))))),
                el('td', el('select', {
                    'aria-label': label('state'), onchange: (e) => set({ state: Number(e.target.value) }),
                }, [0, 1, 2].map((k) => el('option', { value: k, selected: a.state === k }, STATE_NAMES[k])))),
                el('td', fnSelect),
                el('td', gain),
                el('td', offset, why ? null : el('span', { class: 'readout', text: 'V' })),
                el('td', el('input', {
                    type: 'checkbox', checked: a.inverted, 'aria-label': label('invert'),
                    onchange: (e) => set({ inverted: e.target.checked }),
                })),
                el('td', el('button', {
                    class: 'danger', title: 'Delete assignment ' + (i + 1), 'aria-label': 'Delete assignment ' + (i + 1),
                    onclick: () => { CV.remove(p, i); say(`CV assignment ${i + 1} deleted.`); afterEdit(); },
                }, '×'))));
            if (notes.length) rows.push(el('tr', { class: 'note-row' }, el('td'), el('td', { colspan: 8, class: 'hint' }, notes.join(' '))));
        }

        host.appendChild(el('section', { class: 'card wide' },
            cardHead('CV assignments', 'cva'),
            list.length ? columnNotes(['cva.input', 'cva.channel', 'cva.state', 'cva.function_id', 'cva.gain', 'cva.offset', 'cva.inverted']) : null,
            list.length ? el('table', { class: 'steps' },
                el('thead', el('tr', [['#'], ['Input', 'cva.input'], ['Channel', 'cva.channel'], ['State', 'cva.state'],
                    ['Function', 'cva.function_id'], ['Gain', 'cva.gain'], ['Offset', 'cva.offset'], ['Inv', 'cva.inverted'], ['']]
                    .map(([h, k]) => headCell(h, k)))),
                el('tbody', rows))
              : el('p', { class: 'lead', text: 'This preset has no CV assignments.' }),
            el('div', { class: 'actions', style: 'margin-top:10px' },
                el('button', {
                    disabled: full,
                    title: full ? `The module holds at most ${CV.max}.` :
                        `Adds CV IN 1 → VOLTAGE MIN on channel ${S.ch + 1}, state ${STATE_NAMES[S.st]}, as the module does`,
                    onclick: () => {
                        try { CV.add(p, S.ch, S.st); } catch (e) { say(e.message, 'err'); }
                        afterEdit();
                    },
                }, 'Add assignment'),
                full ? el('span', { class: 'readout', text: `All ${CV.max} in use.` }) : null)));

        const lrows = [];
        for (let o = 0; o < offsets.consts.N_LOGIC_OUTPUTS; o++) {
            const lg = p.sub('lga', [o]);
            lrows.push(el('tr',
                el('td', { class: 'n', text: String(o + 1) }),
                el('td', { class: 'mono', text: String(lg.get('n_lines')) }),
                el('td', el('input', {
                    type: 'number', min: -30, max: 32, value: p.get('lga_bpm_mult_div', [o]),
                    'aria-label': 'bpm mult/div ' + (o + 1),
                    onchange: (e) => { p.set('lga_bpm_mult_div', [o], clampInt(e.target.value, -30, 32)); afterEdit(); },
                })),
                el('td', el('select', {
                    'aria-label': 'bpm gate mode ' + (o + 1),
                    onchange: (e) => { p.set('lga_bpm_gate_trigger_mode', [o], Number(e.target.value)); afterEdit(); },
                }, PULSE_MODES.map((nm, k) =>
                    el('option', { value: k, selected: p.get('lga_bpm_gate_trigger_mode', [o]) === k }, nm)))),
                el('td', el('select', {
                    'aria-label': 'counter gate mode ' + (o + 1),
                    onchange: (e) => { p.set('lga_counter_gate_trigger_mode', [o], Number(e.target.value)); afterEdit(); },
                }, PULSE_MODES.map((nm, k) =>
                    el('option', { value: k, selected: p.get('lga_counter_gate_trigger_mode', [o]) === k }, nm))))));
        }
        host.appendChild(el('section', { class: 'card wide' },
            cardHead('Logic outputs', 'lga'),
            columnNotes(['lga.n_lines', 'lga_bpm_mult_div', 'lga_bpm_gate_trigger_mode', 'lga_counter_gate_trigger_mode']),
            el('table', { class: 'steps' },
                el('thead', el('tr', [['#'], ['Lines', 'lga.n_lines'], ['BPM mult/div', 'lga_bpm_mult_div'],
                    ['BPM pulse', 'lga_bpm_gate_trigger_mode'], ['Counter pulse', 'lga_counter_gate_trigger_mode']].map(([h, k]) => headCell(h, k)))),
                el('tbody', lrows)),
            el('p', { class: 'lead', text: 'Logic line operations are built on the module; their count is shown for reference.' })));
    }

    // the logic outputs' pulse shape: addac511.cpp process_logic, 0 / 1 / 2
    const PULSE_MODES = ['GATE', '1 ms', '10 ms'];

    // ---------- scales ----------
    function renderScales(host) {
        const p = S.img.preset(S.slot);
        host.appendChild(el('p', { class: 'lead' },
            'Eight custom scales, stored per preset. Semitone offsets are relative to the root note; ' +
            'the quantizer uses them when SCALE is set to one of these.'));
        const cards = [];
        for (let i = 0; i < offsets.consts.N_CUSTOM_SCALES; i++) {
            const sc = p.sub('custom_scale', [i]);
            const nSemis = sc.get('n_semitones');
            const semis = [];
            for (let k = 0; k < 12; k++) semis.push(sc.get('semitones', [k]));
            const cents = semis.slice(0, nSemis).map((s) => Math.round(s * 100) + '¢').join(' · ');
            cards.push(el('section', { class: 'card' },
                el('h2', { text: 'Custom ' + (i + 1) }),
                el('div', { class: 'row' },
                    el('div', { class: 'lbl' }, el('span', {}, 'NAME'), infoButton('custom_scale.name', 'NAME', i)),
                    el('div', { class: 'ctl' }, el('input', {
                        type: 'text', value: sc.getString('name'), maxlength: 19,
                        'aria-label': 'name of custom scale ' + (i + 1),
                        onchange: (e) => { sc.setString('name', e.target.value.toUpperCase()); afterEdit(); },
                    })), infoText('custom_scale.name', i)),
                el('div', { class: 'row' },
                    el('div', { class: 'lbl' }, el('span', {}, 'NOTES'), infoButton('custom_scale.n_semitones', 'NOTES', i)),
                    el('div', { class: 'ctl' }, el('input', {
                        type: 'number', min: 0, max: 12, value: nSemis,
                        'aria-label': 'note count of custom scale ' + (i + 1),
                        onchange: (e) => { sc.set('n_semitones', undefined, clampInt(e.target.value, 0, 12)); afterEdit(); },
                    })), infoText('custom_scale.n_semitones', i)),
                el('div', { class: 'row' },
                    el('div', { class: 'lbl' }, el('span', {}, 'SEMITONES'), infoButton('custom_scale.semitones', 'SEMITONES', i)),
                    infoText('custom_scale.semitones', i)),
                el('div', { class: 'row full' },
                    el('div', { class: 'ctl' }, semis.map((v, k) => el('input', {
                        type: 'number', step: 0.5, min: 0, max: 12, value: +v.toFixed(2),
                        style: 'width:4.6em' + (k >= nSemis ? ';opacity:.4' : ''),
                        'aria-label': 'semitone ' + (k + 1) + ' of custom scale ' + (i + 1),
                        onchange: (e) => { sc.set('semitones', [k], Number(e.target.value)); afterEdit(); },
                    })))),
                el('div', { class: 'row' }, el('div', { class: 'lbl', text: '' }),
                    el('div', { class: 'hint', text: cents || 'no notes — this scale is unused' }))));
        }
        host.appendChild(el('div', { class: 'grid' }, cards));
    }

    // ---------- firmware ----------
    const MANUAL_URL = 'https://media.addacsystem.com/ADDAC511/ADDAC511_VCSVGenerator_FW20.pdf';
    const BOOTLOADER_URL = 'https://addacsupport.github.io/ADDAC511-bootloader/';
    const FACTORY_PRESETS_URL = 'https://media.addacsystem.com/ADDAC511/ADDAC511_FACTORYpresets.bin';

    function loadManifest() {
        if (S.fw.loading || S.fw.manifest || S.fw.error) return;
        S.fw.loading = true;
        Firmware.fetchManifest()
            .then((m) => { S.fw.manifest = m; S.fw.error = null; })
            .catch((e) => { S.fw.error = 'Could not load the list of firmware builds: ' + (e.message || e); })
            .then(() => { S.fw.loading = false; offerUpdate(); render(); });
    }

    // Once we know both what the module runs and what has been released, say so, once.
    let updateOffered = false;
    function offerUpdate() {
        if (updateOffered || !S.serial || !S.serial.connected || !S.fw.manifest) return;
        const v = S.serial.version;
        const releases = S.fw.manifest.channels.release;
        const newer = v ? Firmware.updateAvailable(v, releases) : null;
        if (newer) {
            updateOffered = true;
            say(`The module runs ${v}; firmware ${newer.version} is available in the Firmware tab.`);
        } else if (v === null && releases.length) {
            updateOffered = true;
            say('The module runs firmware older than the version query, so older than ' + releases[0].version +
                '. Updating adds checksummed presets and more reliable transfers — see the Firmware tab.');
        }
    }

    function renderFirmware(host) {
        if (typeof fetch !== 'undefined') loadManifest();
        const usbOk = typeof navigator !== 'undefined' && !!navigator.usb;
        const showDev = S.fw.channel === 'dev' || S.fw.devUnlocked;
        if (S.fw.channel === 'dev') S.fw.devUnlocked = true; // keep the switch once arrived via ?channel=dev

        host.appendChild(el('p', { class: 'lead' },
            'Update the module’s firmware over USB. Presets and calibration are kept: the update ' +
            'only rewrites the program area of the module’s memory.'));
        if (!usbOk) {
            host.appendChild(el('div', { class: 'msg err' }, el('span', { text:
                'Firmware updates need WebUSB, which Chrome and Edge provide. Presets can still be edited here in any browser.' })));
        }

        const connected = S.serial && S.serial.connected;
        const running = connected
            ? (S.serial.version || (S.serial.version === null ? 'firmware older than the version query' : 'unknown'))
            : null;

        const list = el('section', { class: 'card' },
            el('h2', { text: S.fw.channel === 'dev' ? 'Development builds' : 'Releases' }));
        if (showDev) {
            list.appendChild(el('div', { class: 'seg', style: 'margin-bottom:10px' }, ['release', 'dev'].map((c) => el('button', {
                'aria-pressed': String(S.fw.channel === c),
                onclick: () => { S.fw.channel = c; render(); },
            }, c === 'release' ? 'Releases' : 'Development builds'))));
        }
        if (S.fw.channel === 'dev') {
            list.appendChild(el('div', { class: 'msg note' }, el('span', { text:
                'Development builds are work in progress: new features, untested combinations. Use a release unless you were asked to try one.' })));
        }
        if (running) list.appendChild(el('p', { class: 'lead', text: 'Connected module runs: ' + running }));
        if (S.fw.loading && !S.fw.manifest) list.appendChild(el('p', { class: 'lead', text: 'Loading the list of builds…' }));
        if (S.fw.error) list.appendChild(el('div', { class: 'msg err' }, el('span', { text: S.fw.error })));

        if (S.fw.manifest) {
            const entries = S.fw.manifest.channels[S.fw.channel] || [];
            if (!entries.length) list.appendChild(el('p', { class: 'lead', text: 'Nothing published in this channel yet.' }));
            entries.forEach((e, i) => {
                const installed = connected && S.serial.version === e.version;
                list.appendChild(el('div', { class: 'build' },
                    el('div', { class: 'build-head' },
                        el('b', { class: 'mono', text: e.version }),
                        i === 0 ? el('span', { class: 'tag', text: S.fw.channel === 'dev' ? 'newest' : 'latest' }) : null,
                        installed ? el('span', { class: 'tag', text: 'installed' }) : null,
                        el('span', { class: 'readout', text: (e.date || '').slice(0, 10) + ' · ' + Math.round(e.size / 1024) + ' kB' }),
                        el('button', {
                            class: i === 0 ? 'primary' : null,
                            disabled: !!S.busy || !usbOk,
                            onclick: () => installBuild(e),
                        }, 'Install')),
                    e.notes ? el('details', {}, el('summary', { text: 'What changed' }),
                        el('pre', { class: 'notes', text: e.notes })) : null));
            });
        }

        const howto = el('section', { class: 'card' },
            el('h2', { text: 'How to update' }),
            el('ol', { class: 'howto' },
                el('li', {}, 'Optional: back up your presets with ', el('b', { text: 'Read from module' }), ' and ',
                    el('b', { text: 'Save .bin' }), '. The update leaves them alone, but a backup costs nothing.'),
                el('li', {}, 'On the module, open ', el('b', { text: 'MENU → UPDATE FIRMWARE' }),
                    '. It restarts in update mode, and this page lets go of its connection.'),
                el('li', {}, 'Press ', el('b', { text: 'Install' }), ' and choose ', el('b', { text: 'DFU in FS Mode' }),
                    ' in the browser’s list.'),
                el('li', {}, 'Wait for it to finish. The module restarts with the new firmware.')),
            el('p', { class: 'lead', text:
                'Windows: if the module does not appear in update mode, install the WinUSB driver for it once with Zadig (zadig.akeo.ie).' }),
            el('p', { class: 'lead' },
                el('a', { href: MANUAL_URL, target: '_blank', rel: 'noopener' }, 'User manual'), ' · ',
                el('a', { href: BOOTLOADER_URL, target: '_blank', rel: 'noopener' }, 'Updating the bootloader'), ' \u00B7 ',
                el('a', { href: FACTORY_PRESETS_URL }, 'Factory presets (.bin)')));

        const cards = [list, howto];
        if (S.fw.channel === 'dev') {
            cards.push(el('section', { class: 'card' },
                el('h2', { text: 'Install a file' }),
                el('p', { class: 'lead', text: 'Flash a .bin built locally. It is checked to be an application image first.' }),
                el('div', { class: 'actions' },
                    el('button', { disabled: !!S.busy || !usbOk, onclick: pickLocalFirmware }, 'Choose .bin…'))));
        }
        host.appendChild(el('div', { class: 'grid' }, cards));
    }

    function pickLocalFirmware() {
        const input = el('input', { type: 'file', accept: '.bin', style: 'display:none' });
        input.addEventListener('change', async () => {
            if (!input.files[0]) return;
            const { bytes, name } = await FileSource.read(input.files[0]);
            const problem = Firmware.looksLikeFirmware(bytes);
            if (problem) { say(`${name} does not look like ADDAC511 firmware: ${problem}.`, 'err'); render(); return; }
            if (!confirm(`Install ${name}?\n\nFirst put the module in update mode: MENU → UPDATE FIRMWARE.`)) return;
            await flashBytes(bytes, name);
        });
        document.body.appendChild(input);
        input.click();
        setTimeout(() => input.remove(), 0);
    }

    async function installBuild(entry) {
        if (!confirm(`Install ${entry.version}?\n\nFirst put the module in update mode: MENU → UPDATE FIRMWARE.\n\nPresets and calibration are kept.`)) return;
        let bytes;
        try {
            // downloaded and CRC-checked before anything reaches the module
            await withBusy('Downloading ' + entry.version, async (p) => { bytes = await Firmware.downloadBuild(entry, null, p); });
        } catch (e) { say(describe(e), 'err'); render(); return; }
        await flashBytes(bytes, entry.version);
    }

    async function flashBytes(bytes, label) {
        // In update mode the module's serial port disappears; let go of it cleanly.
        if (S.serial && S.serial.connected) await disconnect();
        try {
            await withBusy('Installing ' + label, async (p) => {
                await Firmware.flash(bytes, {
                    status: (t) => { S.busy = Object.assign({}, S.busy, { what: t }); renderHeader(); },
                    progress: (done, total) => p(done, total),
                });
            });
            say(`${label} installed. Reconnect once the module has restarted.`);
        } catch (e) {
            say(e && e.name === 'NotFoundError'
                ? 'No device was chosen. Is the module in update mode (MENU → UPDATE FIRMWARE)?'
                : describe(e), 'err');
        }
        render();
    }

    // ---------- chrome ----------
    function renderHeader() {
        const actions = $('actions');
        actions.textContent = '';
        const busy = !!S.busy;

        if (SerialSource.supported) {
            actions.appendChild(el('button', {
                disabled: busy,
                onclick: S.serial && S.serial.connected ? disconnect : connect,
            }, S.serial && S.serial.connected ? 'Disconnect' : 'Connect to module'));
            if (S.serial && S.serial.connected) {
                add(actions, 
                    el('button', { disabled: busy, onclick: readFromModule }, 'Read from module'),
                    el('button', { disabled: busy || !S.img, class: 'primary', onclick: writeToModule }, 'Write to module'));
            }
        }
        add(actions, 
            el('button', {
                disabled: busy, 'aria-pressed': String(S.tab === 'firmware'),
                onclick: () => { S.tab = S.tab === 'firmware' && S.img ? 'presets' : 'firmware'; render(); },
            }, 'Firmware'),
            el('button', { disabled: busy, onclick: openFile }, 'Open .bin…'),
            el('button', { disabled: busy || !S.img, onclick: saveFile }, 'Save .bin'));

        if (S.busy) {
            actions.appendChild(el('progress', S.busy.total ? { value: S.busy.done, max: S.busy.total } : {}));
        }

        const dot = $('dot'), txt = $('statusText');
        const connected = S.serial && S.serial.connected;
        dot.className = 'dot' + (connected ? ' on' : '');
        let t = connected ? 'Connected' : (SerialSource.supported ? 'Not connected' : 'USB needs Chrome or Edge');
        if (connected && S.serial.lengthFramed === true) t += ' · checksummed transfer';
        if (connected && S.serial.lengthFramed === false) t += ' · older firmware';
        if (connected && S.serial.version) t += ' · ' + S.serial.version;
        if (S.busy) t = S.busy.what + '…';
        txt.textContent = t;
    }

    function renderTabs() {
        const nav = $('tabs');
        nav.textContent = '';
        if (!S.img) return;
        const dirtySlots = S.img.dirtySlots();
        for (const t of TABS) {
            const pip = (t.id === 'presets' && (dirtySlots.length || S.img.commonDirty())) ||
                        (t.id === 'global' && S.img.commonDirty());
            nav.appendChild(el('button', {
                role: 'tab', 'aria-selected': String(S.tab === t.id),
                onclick: () => { S.tab = t.id; render(); },
            }, t.title, pip ? el('span', { class: 'pip', text: ' ●' }) : null));
        }
    }

    function renderPicker() {
        const p = $('picker');
        p.textContent = '';
        if (!S.img) return;
        const perState = ['voltage', 'quantize', 'gate', 'probability', 'smooth', 'time', 'envelope', 'clock', 'sequencer'];
        const needsSlot = perState.concat(['assign', 'scales']);
        if (!needsSlot.includes(S.tab)) return;

        const occupied = S.img.occupiedSlots();
        add(p, el('label', { text: 'Preset' }), el('select', {
            onchange: (e) => { S.slot = Number(e.target.value); render(); },
        }, occupied.map((i) => el('option', { value: i, selected: i === S.slot }, (i + 1) + ' · ' + S.img.presetName(i)))));

        if (!perState.includes(S.tab)) return;
        add(p, el('label', { text: 'Channel' }), el('div', { class: 'seg' },
            [0, 1, 2, 3].map((c) => el('button', {
                'aria-pressed': String(c === S.ch), onclick: () => { S.ch = c; render(); },
            }, String(c + 1)))));
        add(p, el('label', { text: 'State' }), el('div', { class: 'seg' },
            [0, 1, 2].map((s) => el('button', {
                'aria-pressed': String(s === S.st), onclick: () => { S.st = s; render(); },
            }, STATE_NAMES[s]))));
    }

    function renderSaveBar() {
        const bar = $('savebar');
        if (!S.img || !S.img.isDirty()) { bar.hidden = true; return; }
        bar.hidden = false;
        const slots = S.img.dirtySlots();
        const bits = [];
        if (slots.length) bits.push(slots.length + ' preset' + (slots.length > 1 ? 's' : '') + ' (' + slots.map((i) => i + 1).join(', ') + ')');
        if (S.img.commonDirty()) bits.push('global settings');
        $('dirtyCount').textContent = 'Unsaved changes: ' + bits.join(' and ');
        const a = $('saveActions');
        a.textContent = '';
        add(a, 
            el('button', { onclick: () => { S.img.revert(); say('All changes reverted.'); render(); } }, 'Revert'),
            el('button', { disabled: !!S.busy, onclick: saveFile }, 'Save .bin'),
            S.serial && S.serial.connected
                ? el('button', { class: 'primary', disabled: !!S.busy, onclick: writeToModule }, 'Write to module')
                : null);
    }

    function renderMessages(host) {
        for (const m of S.messages) {
            host.appendChild(el('div', { class: 'msg ' + m.kind }, el('span', { text: m.text }),
                el('button', { onclick: () => { S.messages = S.messages.filter((x) => x !== m); render(); } }, 'Dismiss')));
        }
    }

    // ---------- render ----------
    function render() {
        const focused = document.activeElement && document.activeElement.id;
        const selStart = document.activeElement && document.activeElement.selectionStart;
        rowSeq = 0;

        renderHeader();
        renderTabs();
        renderPicker();

        const main = $('main');
        main.textContent = '';
        renderMessages(main);

        if (S.tab === 'firmware') {
            renderFirmware(main);
            renderSaveBar();
            return;
        }

        if (!S.img) {
            main.appendChild(el('div', { class: 'empty-state' },
                el('h1', { text: 'Edit your ADDAC511 presets' }),
                el('p', { text: SerialSource.supported
                    ? 'Connect the module over USB and read its presets, or open a .bin backup.'
                    : 'Open a .bin backup to edit it. Reading and writing the module over USB needs Chrome or Edge.' }),
                el('p', { class: 'lead', text: 'Nothing is written to the module until you choose to write.' })));
            renderSaveBar();
            return;
        }

        if (S.tab === 'presets') renderPresets(main);
        else if (S.tab === 'assign') renderAssign(main);
        else if (S.tab === 'scales') renderScales(main);
        else renderSectionTab(main, S.tab);

        renderSaveBar();

        if (focused && $(focused)) {
            const n = $(focused);
            n.focus();
            if (selStart !== undefined && selStart !== null && n.setSelectionRange) {
                try { n.setSelectionRange(selStart, selStart); } catch (e) { /* not a text input */ }
            }
        }
    }

    // ---------- actions ----------
    function loadImage(bytes, label) {
        S.img = new Image511(offsets, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
        S.baseline = new Image511(offsets, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
        const first = S.img.firstOccupied();
        S.slot = first < 0 ? 0 : first;
        S.tab = 'presets';

        if (!S.img.commonIsValid()) {
            say('This module’s global block does not look initialised, so the slot list may be wrong. ' +
                'On the module, hold MENU + STATE C at power-up to reset it.', 'err');
        }
        if (S.img.padded) {
            say(`${label} is ${S.img.originalSize} bytes, smaller than a full backup; the missing slots are treated as empty.`);
        }
        const legacy = S.img.occupiedSlots().filter((i) => S.img.trailerStatus(i) === TRAILER.LEGACY);
        if (legacy.length) {
            say(`${legacy.length} preset${legacy.length > 1 ? 's were' : ' was'} saved by older firmware and ${legacy.length > 1 ? 'carry' : 'carries'} no checksum. ` +
                'They load normally; editing one adds a checksum.');
        }
        const bad = S.img.occupiedSlots().filter((i) => S.img.trailerStatus(i) === TRAILER.BAD_CRC);
        if (bad.length) {
            say('Checksum mismatch on preset ' + bad.map((i) => i + 1).join(', ') +
                '. The data may be corrupted, or was edited by a tool that did not restamp it.', 'err');
        }
        render();
    }

    async function withBusy(what, fn) {
        S.busy = { what, done: 0, total: 0 };
        render();
        try { await fn((done, total) => { S.busy = { what, done, total }; renderHeader(); }); } finally { S.busy = null; render(); }
    }

    async function connect() {
        try {
            S.serial = new SerialSource();
            await withBusy('Connecting', async () => {
                await S.serial.connect();
                await S.serial.readVersion();
            });
            offerUpdate();
            say('Connected. Use "Read from module" to load its presets.');
        } catch (e) {
            S.serial = null;
            say(describe(e), 'err');
        }
        render();
    }

    async function disconnect() {
        if (S.serial) await S.serial.disconnect();
        S.serial = null;
        render();
    }

    async function readFromModule() {
        if (S.img && S.img.isDirty() && !confirm('Reading from the module discards your unsaved changes. Continue?')) return;
        try {
            let bytes;
            await withBusy('Reading from the module', async (p) => { bytes = await S.serial.readImage(p); });
            loadImage(bytes, 'The module’s memory');
            say('Read ' + bytes.length.toLocaleString() + ' bytes and verified the checksum.');
        } catch (e) { say(describe(e), 'err'); }
        render();
    }

    async function writeToModule() {
        const slots = S.img.stampDirtySlots();
        const marker = S.img.findEndMarker();
        if (S.serial.lengthFramed === false && marker >= 0) {
            say('This firmware uses the older transfer framing, and the data contains the bytes "!FIM!" ' +
                `at offset ${marker}, which would truncate the restore. Most likely a preset name — change it first.`, 'err');
            render();
            return;
        }
        const what = slots.length ? `Write ${slots.length} changed preset(s) to the module?` : 'Write the global settings to the module?';
        if (!confirm(what + '\n\nThis replaces the presets stored on the module. Calibration is not touched.')) return;
        try {
            await withBusy('Sending to the module', async (p) => {
                await S.serial.writeImage(S.img.toBlobBytes(), p, () => {
                    // erasing and rewriting the flash takes a while, with nothing to show for it
                    S.busy = { what: 'Writing to the module\u2019s memory (up to half a minute)', done: 0, total: 0 };
                    renderHeader();
                });
            });
            S.img.markSaved();
            S.baseline = new Image511(offsets, S.img.toBlobBytes().slice().buffer);
            // The module keeps running the presets it loaded; a write only
            // changes what is stored. Say so, and name the preset it starts with.
            const sel = S.img.common.get('selected');
            const startup = sel >= 0 && S.img.isOccupied(sel) ? `"${S.img.presetName(sel)}" (preset ${sel + 1})` : 'the built-in default preset';
            const edited = slots.filter((i) => S.img.isOccupied(i)).map((i) => `"${S.img.presetName(i)}"`);
            say('Written and verified. The module keeps playing what it had loaded until a preset is loaded again: ' +
                (edited.length ? `load ${edited.join(', ')} on the module to use the changes. ` : '') +
                `At power-up it loads ${startup}.`);
        } catch (e) { say(describe(e), 'err'); }
        render();
    }

    function openFile() {
        if (S.img && S.img.isDirty() && !confirm('Opening a file discards your unsaved changes. Continue?')) return;
        const input = el('input', { type: 'file', accept: '.bin', style: 'display:none' });
        input.addEventListener('change', async () => {
            if (!input.files[0]) return;
            try {
                const { bytes, name } = await FileSource.read(input.files[0]);
                loadImage(bytes, name);
            } catch (e) { say('Could not read that file: ' + e.message, 'err'); render(); }
        });
        document.body.appendChild(input);
        input.click();
        setTimeout(() => input.remove(), 0);
    }

    function saveFile() {
        S.img.stampDirtySlots();
        FileSource.save(S.img.toBlobBytes(), FileSource.suggestedName());
        S.img.markSaved();
        S.baseline = new Image511(offsets, S.img.toBlobBytes().slice().buffer);
        say('Saved. Restore it with "Write to module", or with the older backup page.');
        render();
    }

    function describe(e) {
        if (e && e.name === 'NotFoundError') return 'No port was chosen.';
        if (e && e.name === 'Timeout') return e.message + ' Check the cable, or try reconnecting.';
        return (e && e.message) || String(e);
    }

    // The old flashing pages redirect to ?tab=firmware (releases) and
    // ?channel=dev (development builds), so land straight on the Firmware view.
    if (typeof location !== 'undefined') {
        const q = new URLSearchParams(location.search);
        if (q.get('tab') === 'firmware' || q.get('channel') === 'dev') S.tab = 'firmware';
    }

    window.addEventListener('beforeunload', (e) => {
        if (S.img && S.img.isDirty()) { e.preventDefault(); e.returnValue = ''; }
    });

    // A handle for the Node test harness (web/test/app.test.js), which runs this
    // file against a minimal DOM so the real render paths and event handlers are
    // exercised in CI. Inert in a browser.
    window.__test = {
        loadImage: (bytes, label) => loadImage(bytes, label),
        setTab: (t) => { S.tab = t; render(); },
        setChannelState: (c, s) => { S.ch = c; S.st = s; render(); },
        image: () => S.img,
        state: S,
        render,
        setFirmwareManifest: (m) => { S.fw.manifest = Firmware.parseManifest(m); S.fw.error = null; render(); },
        setFirmwareChannel: (c) => { S.fw.channel = c; render(); },
    };

    render();
})();
