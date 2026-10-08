// What each stored field means: labels, ranges, defaults and option names.
//
// Hand-written against the module's own screens (code/src/hmi/*.cpp), because the
// firmware has no label table - every label is an ad-hoc sprintf spread across
// ~10,400 lines. Ranges come from the per-screen min_enc/max_enc blocks and from
// preset_load_channel(), which is the firmware's own validation layer. Defaults
// come from Addac511::init_default_preset().
//
// Offsets and enum values are NOT here: those are generated into offsets.json.
// This file only ever refers to a field by name and an enumerator by name, so a
// test can check every reference against the firmware.
(function (root) {
    'use strict';

    // scope: where a field lives and how it is indexed
    //   global  - PresetsCommon, one per module
    //   preset  - Preset, one per preset
    //   c       - Preset[channel]
    //   cs      - Preset[channel][state]
    const G = 'global', P = 'preset', C = 'c', CS = 'cs';

    const f = (key, label, type, extra) => Object.assign({ key, label, type }, extra || {});

    // enum field; `labels` renames enumerators for display, `omit` hides some
    const en = (key, label, enumName, extra) => f(key, label, 'enum', Object.assign({ enumName }, extra));
    const bool = (key, label, extra) => f(key, label, 'bool', extra);
    const pct = (key, label, extra) => f(key, label, 'percent', Object.assign({ min: 0, max: 1, step: 0.01 }, extra));
    const volt = (key, label, extra) => f(key, label, 'voltage', extra);
    const us = (key, label, extra) => f(key, label, 'timeUs', Object.assign({ min: 0, max: 200000000, step: 1000 }, extra));
    const int = (key, label, min, max, extra) => f(key, label, 'int', Object.assign({ min, max, step: 1 }, extra));
    const num = (key, label, min, max, step, extra) => f(key, label, 'float', Object.assign({ min, max, step }, extra));

    // ---------- option labels that are not just the enumerator name ----------
    const LABELS = {
        CVOutMode: { UNIPOLAR: 'UNIPOLAR (0..5V)', BIPOLAR: 'BIPOLAR (-5..+5V)' },
        VoltageMode: { NORMAL: 'RANDOM', ENVELOPE: 'ENVELOPE' },
        SmoothStepMode: { OFF: 'OFF', VOLTAGE: 'V STEPS', TIME: 'TIME' },
        TrgQuant: { OFF: 'OFF', ONE_MS: '1 ms', TEN_MS: '10 ms' },
        QuantizeRounding: {
            NEAREST: 'NEAREST NOTE', FLOOR: 'NOTE BELOW',
            CEILING: 'NOTE ABOVE', PROBABILITY: 'NOTE PROBABILITY',
        },
        TransposeMode: {
            SEMITONES: 'SEMITONES', SCALE_DEGREES: 'SCALE DEGREES',
            OCTAVES: 'OCTAVES', CENTS: 'CENTS',
        },
        StepMode: { VOLTAGE: 'VOLTAGE', TIME: 'TIME', BOTH: 'BOTH' },
        StepDir: { FW: 'FORWARD', RV: 'REVERSE', PINGPONG: 'PING-PONG' },
        SequencerMode: { TRACK: 'TRACK', HOLD: 'HOLD', ON: 'ON' },
        EnvelopeMode: { LOOP: 'LOOP', TRIGGER: 'TRIGGER', GATE: 'GATE' },
        DistributionMode: { OFF: 'OFF', FREE: 'FREE', WALK: 'WALK' },
        SmoothCurve: { OFF: 'OFF', LIN: 'LINEAR', LOG: 'LOG', EXP: 'EXP', BEZIER: 'BEZIER' },
        TimeMode: {
            TIME: 'TIME', BPM: 'BPM', BPM_CH1: 'BPM CH1', BPM_CH2: 'BPM CH2',
            BPM_CH3: 'BPM CH3', BPM_CH4: 'BPM CH4',
        },
        ClockSource: {
            INTERNAL1: 'CH 1', INTERNAL2: 'CH 2', INTERNAL3: 'CH 3', INTERNAL4: 'CH 4',
            CLK_IN_1: 'CLK IN 1', CLK_IN_2: 'CLK IN 2', CLK_IN_3: 'CLK IN 3', CLK_IN_4: 'CLK IN 4',
            LOGIC_OUT1: 'LOGIC 1', LOGIC_OUT2: 'LOGIC 2', LOGIC_OUT3: 'LOGIC 3',
        },
        BitResolution: null, // rendered as "n bit" from the enumerator
    };

    // Built-in quantizer scales (Addac511::init_all_scales_). Ids 8..15 are the
    // eight editable custom scales, which the Scales tab names.
    const BUILTIN_SCALES = ['OFF', 'CHROMATIC', 'MAJOR', 'MINOR', 'PENTA MAJ', 'PENTA MIN', 'TIZITA MIN', 'OCTAVES'];

    // Logic/CV input namespace (hmi/hmi_assign.cpp:1414-1478). Also the namespace
    // for v_quantize_rel_source, where a state's own channel is index channel+8.
    const INPUT_NAMES = [
        'CV IN 1', 'CV IN 2', 'CV IN 3', 'CV IN 4', 'CV IN 5', 'CV IN 6', 'CV IN 7', 'CV IN 8',
        'CH 1', 'CH 2', 'CH 3', 'CH 4',
        'GT OUT 1', 'GT OUT 2', 'GT OUT 3', 'GT OUT 4',
        'LOGIC 1', 'LOGIC 2', 'LOGIC 3',
    ];

    // ---------- sections ----------
    const SECTIONS = [
        {
            id: 'global', title: 'Global', scope: G,
            lead: 'Settings the module keeps outside any preset.',
            fields: [
                int('screensaver_mode', 'SCREENSAVER', 0, 1, { optionLabels: ['OFF', 'ON'], def: 0 }),
                int('screensaver_wait_time', 'SCREENSAVER WAIT', 10, 300, {
                    choices: [10, 60, 120, 300], choiceLabels: ['10 s', '1 MIN', '2 MIN', '5 MIN'], def: 60,
                }),
                bool('auto_return_to_main', 'AUTO RETURN TO MAIN', { def: true }),
                int('time_auto_return_to_main', 'AUTO RETURN AFTER', 1000, 600000, {
                    choices: [10000, 30000, 60000], choiceLabels: ['10 s', '30 s', '60 s'], def: 30000,
                }),
                bool('cv_before_gate', 'OUTPUT ORDER', {
                    def: true, falseLabel: 'GATE / CV', trueLabel: 'CV / GATE',
                }),
            ],
        },
        {
            id: 'voltage', title: 'Voltage', scope: CS,
            lead: 'How the next CV value is chosen.',
            fields: [
                en('voltage_mode', 'MODE', 'VoltageMode', { def: 'NORMAL' }),
                en('cv_mode', 'CV OUT RANGE', 'CVOutMode', { scope: C, def: 'UNIPOLAR' }),
                volt('v_min', 'VOLTAGE MIN', { def: 0 }),
                volt('v_max', 'VOLTAGE MAX', { def: 1 }),
                volt('v_rest', 'VOLTAGE REST', { def: 0, when: (v) => v.voltage_mode === 'ENVELOPE' }),
                int('v_nvsteps', 'VOLTAGE STEPS', 0, 320, { def: 0, zeroLabel: 'CONTINUOUS' }),
                bool('v_range_lock', 'RANGE LOCK', { def: false }),
                num('channel_states_balance.a', 'STATE A WEIGHT', 0, 1, 0.01, { scope: C, sub: 'channel_states_balance', member: 'a', def: 0.33 }),
                num('channel_states_balance.b', 'STATE B WEIGHT', 0, 1, 0.01, { scope: C, sub: 'channel_states_balance', member: 'b', def: 0.33 }),
                num('channel_states_balance.c', 'STATE C WEIGHT', 0, 1, 0.01, { scope: C, sub: 'channel_states_balance', member: 'c', def: 0.33 }),
                bool('states_random_active', 'RANDOM STATE', { scope: C, def: false }),
            ],
        },
        {
            id: 'quantize', title: 'Quantize', scope: CS,
            lead: 'Snapping the output to a scale.',
            fields: [
                f('v_quantization_scale_id', 'SCALE', 'scale', { def: 0 }),
                f('v_root_note', 'ROOT NOTE', 'note', { def: 0 }),
                int('v_quantize_rel_source', 'SOURCE', 0, 18, { def: null, inputNames: true }),
                bool('v_quantize_post', 'QUANTIZE', { def: false, falseLabel: 'PRE SMOOTH', trueLabel: 'POST SMOOTH' }),
                en('quantization_rounding', 'ROUNDING', 'QuantizeRounding', { def: 'NEAREST' }),
                en('v_quantize_transpose_mode', 'TRANSPOSE MODE', 'TransposeMode', { def: 'SEMITONES' }),
                int('v_quantize_transpose_semitones', 'TRANSPOSE', -24, 24, { def: 0, when: (v) => v.v_quantize_transpose_mode === 'SEMITONES' }),
                int('v_quantize_transpose_scale_degrees', 'TRANSPOSE', -21, 21, { def: 0, when: (v) => v.v_quantize_transpose_mode === 'SCALE_DEGREES' }),
                int('v_quantize_transpose_octaves', 'TRANSPOSE', -4, 4, { def: 0, when: (v) => v.v_quantize_transpose_mode === 'OCTAVES' }),
                int('v_quantize_transpose_cents', 'TRANSPOSE', -49, 49, { def: 0, when: (v) => v.v_quantize_transpose_mode === 'CENTS' }),
            ],
        },
        {
            id: 'gate', title: 'Gate', scope: CS,
            lead: 'When and how long the gate output fires.',
            fields: [
                f('v_gate_size', 'GATE SIZE', 'gateSize', { def: 0.5 }),
                pct('gate_size_deviation', 'SIZE DEVIATION', { def: 0 }),
                pct('v_gate_probability', 'GATE PROBABILITY', { def: 1 }),
                int('v_gate_skip_steps', 'GATE SKIP STEPS', 0, 100, { def: 0, zeroLabel: 'OFF' }),
                f('v_smooth_triggers_gate', 'TRIGGER QUANTIZE', 'enum', { enumName: 'TrgQuant', def: 'OFF' }),
            ],
        },
        {
            id: 'probability', title: 'Probability & Shape', scope: CS,
            lead: 'How often a new value is generated, and how it is distributed.',
            fields: [
                pct('v_probability', 'PROBABILITY', { def: 1 }),
                int('v_skip_steps', 'SKIP STEPS', -100, 100, { def: 0, zeroLabel: 'OFF' }),
                bool('v_probability_apply_to_cv_and_gate', 'APPLIES TO', { def: false, falseLabel: 'CV ONLY', trueLabel: 'CV + GATE' }),
                pct('v_p_linearity', 'PROBABILITY LINEARITY', { def: 0.5 }),
                en('v_distribution.mode', 'DISTRIBUTION', 'DistributionMode', { sub: 'v_distribution', member: 'mode', def: 'OFF' }),
                num('v_distribution.pos', 'DISTRIBUTION POS', 0, 1, 0.001, { sub: 'v_distribution', member: 'pos', def: 0.5,
                    when: (v) => v['v_distribution.mode'] === 'FREE' }),
                num('v_distribution.spread', 'DISTRIBUTION SPREAD', 0.001, 1, 0.001, { sub: 'v_distribution', member: 'spread', def: 0.2,
                    when: (v) => v['v_distribution.mode'] !== 'OFF' }),
                pct('v_weight', 'DISTRIBUTION LINEARITY', { def: 0.5 }),
            ],
        },
        {
            id: 'smooth', title: 'Smooth', scope: CS,
            lead: 'Interpolation between one value and the next.',
            fields: [
                en('v_smooth_curve', 'CURVE', 'SmoothCurve', { def: 'OFF' }),
                pct('v_smooth_duration', 'DURATION', { def: 1, when: (v) => v.v_smooth_curve !== 'OFF' }),
                en('v_smooth_resolution', 'RESOLUTION', 'BitResolution', { def: 'RES_16BIT', min: 2,
                    when: (v) => v.v_smooth_curve !== 'OFF' }),
                en('v_smooth_step_mode', 'STEP MODE', 'SmoothStepMode', { def: 'OFF', when: (v) => v.v_smooth_curve !== 'OFF' }),
                int('v_smooth_v_steps', 'STEPS', 3, 16, { def: 16, when: (v) => v.v_smooth_curve !== 'OFF' && v.v_smooth_step_mode === 'VOLTAGE' }),
                int('v_smooth_step_time', 'STEP TIME', 50, 10000, { def: 50, unit: 'ms',
                    when: (v) => v.v_smooth_curve !== 'OFF' && v.v_smooth_step_mode === 'TIME' }),
            ],
        },
        {
            id: 'time', title: 'Time', scope: CS,
            lead: 'How long until the next value.',
            fields: [
                en('time_mode', 'TIME MODE', 'TimeMode', { def: 'BPM' }),
                us('t_min', 'TIME MIN', { def: 100000, when: (v) => v.time_mode === 'TIME' }),
                us('t_max', 'TIME MAX', { def: 500000, when: (v) => v.time_mode === 'TIME' }),
                num('bpm', 'BPM', 0.1, 300, 0.1, { def: 120, when: (v) => v.time_mode !== 'TIME' }),
                f('bpm_beat_note', 'BEAT NOTE', 'tdiv', { sub: 'bpm_beat_note', def: '1/1',
                    when: (v) => v.time_mode !== 'TIME' }),
                bool('t_range_relative', 'RANGE MODE', { def: false, falseLabel: 'ABSOLUTE', trueLabel: 'RELATIVE',
                    when: (v) => v.time_mode === 'TIME' }),
                en('t_distribution.mode', 'TIME DISTRIBUTION', 'DistributionMode', { sub: 't_distribution', member: 'mode', def: 'OFF' }),
                num('t_distribution.pos', 'TIME DIST POS', 0, 1, 0.001, { sub: 't_distribution', member: 'pos', def: 0.5,
                    when: (v) => v['t_distribution.mode'] === 'FREE' }),
                num('t_distribution.spread', 'TIME DIST SPREAD', 0.001, 1, 0.001, { sub: 't_distribution', member: 'spread', def: 0.2,
                    when: (v) => v['t_distribution.mode'] !== 'OFF' }),
                pct('t_weight', 'TIME LINEARITY', { def: 0.5 }),
            ],
        },
        {
            id: 'envelope', title: 'Envelope', scope: CS,
            lead: 'Envelope mode stage times and shapes.',
            when: (v) => v.voltage_mode === 'ENVELOPE',
            fields: [
                en('envelope_mode', 'ENVELOPE MODE', 'EnvelopeMode', { def: 'LOOP' }),
                en('envelope_size_src', 'SIZE SOURCE', 'ClockSource', { def: null }),
                num('envelope_scale_min', 'SCALE MIN', 0.01, 100, 0.01, { def: 1 }),
                num('envelope_scale_max', 'SCALE MAX', 0.01, 100, 0.01, { def: 0 }),
                pct('envelope_attack_shape', 'ATTACK SHAPE', { def: 0.5 }),
                pct('envelope_release_shape', 'RELEASE SHAPE', { def: 0.5 }),
                us('t_min_attack', 'ATTACK MIN', { def: 125000 }),
                us('t_max_attack', 'ATTACK MAX', { def: 0 }),
                us('t_min_sustain', 'SUSTAIN MIN', { def: 125000 }),
                us('t_max_sustain', 'SUSTAIN MAX', { def: 0 }),
                us('t_min_release', 'RELEASE MIN', { def: 125000 }),
                us('t_max_release', 'RELEASE MAX', { def: 0 }),
                us('t_min_rest', 'REST MIN', { def: 250000 }),
                us('t_max_rest', 'REST MAX', { def: 0 }),
                pct('t_min_attack_rel', 'ATTACK MIN (REL)', { def: 0.125 }),
                pct('t_max_attack_rel', 'ATTACK MAX (REL)', { def: 0 }),
                pct('t_min_sustain_rel', 'SUSTAIN MIN (REL)', { def: 0.25 }),
                pct('t_max_sustain_rel', 'SUSTAIN MAX (REL)', { def: 0 }),
                pct('t_min_release_rel', 'RELEASE MIN (REL)', { def: 0.125 }),
                pct('t_max_release_rel', 'RELEASE MAX (REL)', { def: 0 }),
            ],
        },
        {
            id: 'clock', title: 'Clock', scope: CS,
            lead: 'What drives this state.',
            fields: [
                en('clock', 'CLOCK SOURCE', 'ClockSource', { def: null }),
                en('clock_mult_div', 'MULT / DIV', 'ClockMultDiv', { def: 'MULT_1', multDivLabels: true }),
                bool('clock_use_time', 'DELAY BY TIME', { def: false }),
                bool('clock_use_bpm', 'FOLLOW BPM', { def: true }),
                pct('sync_or_zero_probability', 'SYNC / ZERO PROBABILITY', { def: 0 }),
            ],
        },
        {
            id: 'sequencer', title: 'Sequencer (Lock)', scope: CS,
            lead: 'The 32-step shift register. Steps are edited in the table below.',
            fields: [
                en('seq_mode', 'MODE', 'SequencerMode', { def: 'HOLD' }),
                int('seq_steps', 'STEPS', 0, 32, { def: 16, zeroLabel: 'OFF' }),
                en('seq_step_mode', 'STEP MODE', 'StepMode', { def: 'BOTH' }),
                en('seq_step_dir', 'DIRECTION', 'StepDir', { def: 'FW' }),
                int('seq_offset', 'OFFSET', 0, 31, { def: 0 }),
            ],
            steps: {
                count: 'seq_steps',
                columns: [
                    { key: 'seq_voltage', label: 'VOLTAGE', type: 'voltage', def: 0 },
                    { key: 'seq_gate_on', label: 'GATE', type: 'bool', def: true },
                    { key: 'seq_time', label: 'TIME', type: 'timeUs', def: 500000 },
                    { key: 'seq_bpm_div', label: 'BPM DIV', type: 'tdiv', def: '1/1' },
                    { key: 'seq_step_probability', label: 'PROB', type: 'percent', def: 1 },
                ],
            },
        },
    ];

    // Per-channel-state sections the editor shows for the selected channel/state.
    const CHANNEL_SECTIONS = SECTIONS.filter((s) => s.scope === CS || s.scope === C);

    // Fields the panel deliberately does not expose, and why. A test checks that
    // every field in Preset is either in a section or listed here, so a field
    // added to the firmware cannot be silently forgotten.
    const UNEXPOSED = {
        version: 'stamped by the firmware; the trailer carries the real format version',
        id: 'slot bookkeeping, maintained by the editor',
        name: 'edited in the Presets tab',
        n_assigns: 'derived from the CV assignment list',
        current_state: 'obsolete stale pointer, kept for layout only',
        v_quantization_scale: 'obsolete stale pointer, superseded by v_quantization_scale_id',
        current_state_id: 'live state selection, not a setting',
        bpm_mode: 'dead legacy field, superseded by time_mode',
        time_divisions: 'edited in the Time divisions editor',
        note_probabilities: 'edited in the Quantize note-probability editor',
        cva: 'edited in the CV & Logic tab',
        lga: 'edited in the CV & Logic tab',
        custom_scale: 'edited in the Scales tab',
        counter: 'the counters’ running position when the preset was saved, not a setting (the count length is part of the logic line)',
        lga_bpm_mult_div: 'edited in the CV & Logic tab',
        lga_bpm_gate_trigger_mode: 'edited in the CV & Logic tab',
        lga_counter_gate_trigger_mode: 'edited in the CV & Logic tab',
        seq_step_once: 'live per-step edit state, not a stored setting',
        seq_step_always: 'live per-step edit state, not a stored setting',
    };

    const api = {
        SECTIONS, CHANNEL_SECTIONS, LABELS, BUILTIN_SCALES, INPUT_NAMES, UNEXPOSED,
        SCOPES: { G, P, C, CS },
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.Schema511 = api;
})(typeof window !== 'undefined' ? window : globalThis);
