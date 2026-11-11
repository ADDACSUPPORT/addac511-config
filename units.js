// Conversions between what the module stores and what a person reads.
//
// A port of code/src/utils.cpp plus the display rules scattered through
// code/src/hmi/*.cpp. The struct stores normalized voltages (0..1), times in
// microseconds and a few magic-coded floats; none of that belongs in the UI.
(function (root) {
    'use strict';

    const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

    // CVOutMode: 0 = UNIPOLAR (0..5V), 1 = BIPOLAR (-5..+5V)
    const UNIPOLAR = 0, BIPOLAR = 1;

    // ---------- voltage ----------
    function normToVolts(v, mode) {
        return mode === BIPOLAR ? (v - 0.5) * 10 : v * 5;
    }

    function voltsToNorm(volts, mode) {
        return mode === BIPOLAR ? volts / 10 + 0.5 : volts / 5;
    }

    // Port of v_to_note(). Returns { semitone, cents, name, octave }.
    function vToNote(v, mode) {
        const volts = normToVolts(v, mode);
        let octave = volts >= 0 ? Math.trunc(volts) : Math.trunc(volts) - 1;
        const d = volts - octave;
        const stf = d * 12;
        let st = Math.trunc(stf);
        let cents = (stf - st) * 100;
        if (cents > 50) { cents -= 100; st++; }
        if (st > 11) { st = 0; octave++; }
        return { semitone: st + 12 * octave, cents, name: NOTE_NAMES[st] + octave, octave, pitchClass: st };
    }

    // Port of note_to_v().
    function noteToV(semitone, cents, mode) {
        const stf = (cents || 0) / 100 + semitone;
        return mode === BIPOLAR ? 0.5 + stf / 120 : stf / 60;
    }

    const centsToV = (cents) => cents / 100 / 12;

    function formatVolts(v, mode, decimals) {
        return normToVolts(v, mode).toFixed(decimals === undefined ? 2 : decimals) + ' V';
    }

    function formatNote(v, mode) {
        const n = vToNote(v, mode);
        const c = Math.round(n.cents);
        return n.name + (c ? (c > 0 ? ' +' : ' ') + c + '¢' : '');
    }

    // ---------- time ----------
    const usToMs = (us) => us / 1000;
    const msToUs = (ms) => Math.round(ms * 1000);

    function formatTime(us) {
        if (us >= 1000000) return (us / 1000000).toFixed(2) + ' s';
        if (us >= 1000) return (us / 1000).toFixed(us >= 100000 ? 0 : 1) + ' ms';
        return us + ' µs';
    }

    // Port of time_to_tdiv().
    function timeToTdiv(us, bpm) {
        let num = Math.trunc(us * (bpm / 60) * 1e-6);
        if (num < 1) num = 1;
        let den = Math.trunc((60 / bpm) * 1e6 / us);
        if (den < 1) den = 1;
        return { numerator: num, denominator: den, probability: 1 };
    }

    const tdivToUs = (num, den, bpm) => Math.round((60 / bpm) * 1e6 * num / den);

    // ---------- gate size magic codes ----------
    // hmi/hmi_quantize.cpp:858-871 - gate_size is a float but the values below
    // zero are codes, not durations, and 0 / 0.01 are fixed pulse widths.
    const GATE_CODES = [
        { v: -0.04, label: 'A',      help: 'attack only' },
        { v: -0.03, label: 'AS',     help: 'attack + sustain' },
        { v: -0.02, label: 'ASR',    help: 'full envelope' },
        { v: -0.01, label: 'FOLLOW', help: 'follow the source channel gate' },
        { v: 0.00,  label: '1ms',    help: 'fixed 1 ms trigger' },
        { v: 0.01,  label: '10ms',   help: 'fixed 10 ms trigger' },
    ];

    function gateSizeLabel(v) {
        const code = GATE_CODES.find((c) => Math.abs(c.v - v) < 0.005);
        if (code) return code.label;
        return Math.round(v * 100) + ' %';
    }

    // ---------- misc display ----------
    // state.cpp:441-473 - ClockMultDiv enumerator -> the multiplier it means
    function clockMultDivLabel(name) {
        const m = /^MULT_(\d+)$/.exec(name);
        if (m) return m[1] === '1' ? 'x1' : 'x' + m[1];
        const d = /^DIV_(\d+)$/.exec(name);
        if (d) return '/' + d[1];
        return name;
    }

    const percent = (v, decimals) => (v * 100).toFixed(decimals === undefined ? 0 : decimals) + ' %';

    const api = {
        NOTE_NAMES, UNIPOLAR, BIPOLAR, GATE_CODES,
        normToVolts, voltsToNorm, vToNote, noteToV, centsToV,
        formatVolts, formatNote, usToMs, msToUs, formatTime,
        timeToTdiv, tdivToUs, gateSizeLabel, clockMultDivLabel, percent,
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.Units511 = api;
})(typeof window !== 'undefined' ? window : globalThis);
