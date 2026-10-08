// Descriptions shown by the (i) buttons.
//
// Based on the ADDAC511 user's guide (revision 2.0, April 2026) and checked
// against what the firmware does with each value; where the two disagree the
// firmware wins, since that is what the module will do. Written against the
// panel's own labels.
//
// Keys are schema.js field keys, plus a few for the editors that are not plain
// fields (steps, note probabilities, time divisions, CV and logic assignments,
// custom scales, preset slots). test/help.test.js fails if a field has no entry.
(function (root) {
    'use strict';

    const HELP = {
        // ---- global ----
        screensaver_mode: 'Blanks the screen after a while without use, to extend the life of the OLED display.',
        screensaver_wait_time: 'How long the module waits without a knob or button being touched before the screensaver starts.',
        auto_return_to_main: 'Return to the main screen automatically after a while without use.',
        time_auto_return_to_main: 'How long the module waits before returning to the main screen, when AUTO RETURN TO MAIN is on.',
        cv_before_gate: 'The order in which each channel updates its CV and gate outputs. They are only microseconds apart, but some modules care: CV / GATE sets the voltage before the gate opens, so a sampling module sees the new value. This is one setting for all channels, although the module shows it on the per-channel GATE screen.',

        // ---- voltage ----
        voltage_mode: 'The channel’s operating mode. RANDOM generates a new voltage at every clock tick. ENVELOPE generates attack, sustain, release and rest stages with random times and levels. Choosing ENVELOPE also sets TIME MODE to TIME and the gate size to ASR, as on the module; turning the sequencer ON switches back to RANDOM.',
        cv_mode: 'Output range of this channel: UNIPOLAR 0 to +5 V, or BIPOLAR −5 to +5 V. One setting for all three states of the channel.',
        v_min: 'The lowest voltage the channel can generate. In ENVELOPE mode, the lowest level an envelope can peak at.',
        v_max: 'The highest voltage the channel can generate. In ENVELOPE mode, the highest level an envelope can peak at.',
        v_rest: 'ENVELOPE mode: the voltage the output sits at between envelopes, during the rest stage. It can be below VOLTAGE MIN, and negative on a bipolar channel.',
        v_nvsteps: 'Divides the MIN to MAX range into this many equal steps, so new values only land on those voltages. CONTINUOUS uses the DAC’s full 16-bit resolution.',
        v_range_lock: 'How the module’s knobs edit the range. OFF: MIN and MAX are set independently. ON: the range size is locked, so moving MIN moves MAX with it and vice versa. The stored values are the same either way.',
        'channel_states_balance.a': 'With RANDOM STATE on, the chance of moving to state A at each clock tick. The three should add up to 1 (100%): any shortfall is the chance of staying in the current state, and anything over 100% is taken from C first, then B.',
        'channel_states_balance.b': 'With RANDOM STATE on, the chance of moving to state B at each clock tick. The three should add up to 1 (100%): any shortfall is the chance of staying in the current state, and anything over 100% is taken from C first, then B.',
        'channel_states_balance.c': 'With RANDOM STATE on, the chance of moving to state C at each clock tick. The three should add up to 1 (100%): any shortfall is the chance of staying in the current state, and anything over 100% is taken from C first, then B.',
        states_random_active: 'Change state automatically at each clock tick, by the state chances below. On the module this is the screen reached by double-clicking a state button. Pressing a state button still switches immediately, until the next tick. One setting for the whole channel.',

        // ---- quantize ----
        v_quantization_scale_id: 'The scale the output is quantized to. OFF disables quantizing. The eight custom scales are edited in the Scales tab.',
        v_root_note: 'The root note of the scale. The first number is the semitone from C (0 = C, 7 = G); the second detunes it in cents.',
        v_quantize_rel_source: 'What gets quantized. Normally the channel’s own generated voltage. Choosing another channel or a CV input turns this channel into a quantizer for that signal, and its own voltage, probability and distribution settings stop affecting the output. On the module, the state then shows read-only FOLLOWING screens.',
        v_quantize_post: 'Where the quantizer sits relative to smoothing. PRE SMOOTH quantizes first and then glides between notes (glissando). POST SMOOTH smooths first and quantizes the result, so the glide steps through scale notes (arpeggio-like).',
        quantization_rounding: 'How a voltage is turned into a note. NEAREST NOTE takes the closest note, NOTE ABOVE and NOTE BELOW the closest in that direction. NOTE PROBABILITY uses the voltage only to pick the octave, then picks the note by the note probabilities below. NOTE PROBABILITY is not available with QUANTIZE set to POST SMOOTH.',
        v_quantize_transpose_mode: 'The unit TRANSPOSE is counted in: SEMITONES, SCALE DEGREES (moves within the scale’s own notes, so with a 7-note scale 1 is Ionian, 2 Dorian and so on, and −1 is Locrian), OCTAVES or CENTS.',
        v_quantize_transpose_semitones: 'Transposes the quantized output by this many semitones (−24 to +24).',
        v_quantize_transpose_scale_degrees: 'Transposes within the scale: each step moves to the next note of the selected scale, so the result stays in key. With a 7-note scale this gives the modes.',
        v_quantize_transpose_octaves: 'Transposes the quantized output by whole octaves (−4 to +4).',
        v_quantize_transpose_cents: 'Detunes the quantized output by this many cents (−49 to +49), for microtonal offsets.',
        note_probabilities: 'Used when ROUNDING is NOTE PROBABILITY: how likely each note is to be chosen, relative to the others. Notes outside the selected scale are never chosen.',

        // ---- gate ----
        v_gate_size: 'How long the gate stays high. A percentage of the time until the next value, or a fixed 1 ms or 10 ms trigger. In ENVELOPE mode it can follow the envelope instead: A (attack), AS (attack and sustain) or ASR (attack, sustain and release). FOLLOW passes the source channel’s gate through when the clock comes from another channel.',
        gate_size_deviation: 'Randomly varies the gate size at every step, by up to this percentage of it.',
        v_gate_probability: 'The chance that a gate is output at each step: 0% never, 100% always. Separate from the PROBABILITY setting, which can also hold the gate back (see APPLIES TO).',
        v_gate_skip_steps: 'Holds the gate low once every this many steps, breaking up a regular pattern. OFF never skips.',
        v_smooth_triggers_gate: 'Outputs a 1 ms or 10 ms trigger each time the output moves to a new quantized note or a new smoothing step, instead of one gate per clock tick. With an envelope, this gives arpeggio-like triggers as it crosses notes. No effect when nothing is quantized or stepped.',

        // ---- probability & distribution ----
        v_probability: 'The chance that a new value is generated at each step. When it fails, the output holds the previous value until the next step. 100% always generates.',
        v_skip_steps: 'Skips value generation in a regular pattern. Positive: skip once every n steps. Negative: only generate once every n steps. OFF never skips.',
        v_probability_apply_to_cv_and_gate: 'CV ONLY: a step that fails PROBABILITY still outputs its gate, so the rhythm is unaffected. CV + GATE: the gate is held back too.',
        v_p_linearity: 'Stored and shown on the module, but the current firmware does not use it: changing it has no effect on the output.',
        'v_distribution.mode': 'How new voltages are spread within the range. OFF: every voltage is equally likely. FREE: a bell curve centred on POSITION, as wide as SPREAD; values falling outside the range are brought back in. WALK: equally likely, but only near the previous value, giving a wandering, stock-market-like line.',
        'v_distribution.pos': 'FREE distribution: where in the range the most likely values sit, from the bottom (0) to the top (1) of the range.',
        'v_distribution.spread': 'How wide the distribution is. Small values cluster tightly around POSITION (or, in WALK, stay close to the previous value); large values spread across the range.',
        v_weight: 'Tilts the distribution towards the lower or the higher part of the range. 50% is neutral.',

        // ---- smooth ----
        v_smooth_curve: 'Glides from one value to the next instead of jumping: LINEAR, LOG, EXP or BEZIER curve. OFF jumps immediately.',
        v_smooth_duration: 'How long the glide takes, as a percentage of the time until the next value. The timing follows the clock, so it stays in sync even with a random clock. With an external clock it is based on the last interval between two pulses, so an unsteady clock gives uneven glides.',
        v_smooth_resolution: 'A bit-crusher on the smoothed output: limits the DAC to 2^n levels, from 2 bits (4 levels) to 16 bits (65,536, no effect).',
        v_smooth_step_mode: 'Turns the glide into a staircase. OFF: a continuous glide. V STEPS: in a set number of equal voltage steps. TIME: a new step at a fixed time interval.',
        v_smooth_v_steps: 'STEP MODE V STEPS: how many steps each glide is divided into.',
        v_smooth_step_time: 'STEP MODE TIME: the time between steps of the glide, in milliseconds.',

        // ---- time ----
        time_mode: 'How the time between values is set. TIME: a random interval between TIME MIN and TIME MAX. BPM: a tempo, with the intervals picked from the time divisions below. BPM CH1–4: use another channel’s tempo.',
        t_min: 'TIME mode: the shortest time between two values. Setting it above TIME MAX gives a steady clock at a fixed rate.',
        t_max: 'TIME mode: the longest time between two values.',
        bpm: 'The tempo in beats per minute. Each step lasts a time division of the beat, picked from the time divisions below.',
        bpm_beat_note: 'The note value that counts as one beat, like the bottom number of a time signature. In effect it multiplies or divides the tempo, allowing odd meters.',
        t_range_relative: 'How the module’s knobs edit TIME MIN and MAX. ABSOLUTE: set independently. RELATIVE: the range length is kept, so moving MIN moves MAX with it. The stored times are the same either way.',
        'time_divisions': 'BPM mode: up to 11 divisions a step can last, from 32/1 to 1/32, odd ones included. Each has a probability; at every step one is picked by those odds. A division with 0% is never picked. Repeating a division increases its chance.',
        'sync_or_zero_probability': 'BPM mode: the chance of a SYNC step, which lasts exactly until the next beat. After odd divisions the steps drift off the beat; a SYNC step puts them back on it.',
        't_distribution.mode': 'How intervals are spread between TIME MIN and MAX. OFF: equally likely. FREE: a bell curve centred on POSITION. WALK: close to the previous interval. In ENVELOPE mode it applies to every stage time and to the scale.',
        't_distribution.pos': 'FREE distribution: where the most likely intervals sit, from TIME MIN (0) to TIME MAX (1).',
        't_distribution.spread': 'How wide the time distribution is. Small values keep intervals close to POSITION (or, in WALK, to the previous interval).',
        t_weight: 'Tilts the time distribution towards shorter or longer intervals. 50% is neutral.',

        // ---- envelope ----
        envelope_mode: 'What starts an envelope. LOOP: a new envelope follows each one, freely. TRIGGER: a clock pulse starts one, and its length is ignored. GATE: a clock pulse starts one and holds the sustain until the gate falls. TRIGGER and GATE are for clocks from the clock inputs.',
        envelope_size_src: 'Which channel the envelope stage times are measured against. This channel itself: the stages use the fixed times (ATTACK MIN and so on). Another channel: they use the relative times (REL), as a percentage of that channel\u2019s step, so the envelope stretches with its tempo.',
        envelope_scale_min: 'Each envelope is stretched or shrunk by a random factor between SCALE MIN and SCALE MAX, keeping the proportions of its stages. 1.0 leaves the times as set.',
        envelope_scale_max: 'The largest stretch factor. See SCALE MIN.',
        envelope_attack_shape: 'The attack curve, from logarithmic through linear (50%) to exponential.',
        envelope_release_shape: 'The release curve, from logarithmic through linear (50%) to exponential.',
        t_min_attack: 'The attack lasts a random time between ATTACK MIN and ATTACK MAX. A MIN above MAX gives a fixed time.',
        t_max_attack: 'The longest attack time.',
        t_min_sustain: 'The sustain stage lasts a random time between SUSTAIN MIN and SUSTAIN MAX.',
        t_max_sustain: 'The longest sustain time.',
        t_min_release: 'The release lasts a random time between RELEASE MIN and RELEASE MAX.',
        t_max_release: 'The longest release time.',
        t_min_rest: 'After the release, the output sits at VOLTAGE REST for a random time between REST MIN and REST MAX.',
        t_max_rest: 'The longest rest time.',
        t_min_attack_rel: 'When SIZE SOURCE is another channel: the shortest attack, as a percentage of that channel\u2019s step.',
        t_max_attack_rel: 'When SIZE SOURCE is another channel: the longest attack, as a percentage of that channel\u2019s step.',
        t_min_sustain_rel: 'When SIZE SOURCE is another channel: the shortest sustain, as a percentage of that channel\u2019s step.',
        t_max_sustain_rel: 'When SIZE SOURCE is another channel: the longest sustain, as a percentage of that channel\u2019s step.',
        t_min_release_rel: 'When SIZE SOURCE is another channel: the shortest release, as a percentage of that channel\u2019s step.',
        t_max_release_rel: 'When SIZE SOURCE is another channel: the longest release, as a percentage of that channel\u2019s step.',

        // ---- clock ----
        clock: 'Where this state’s clock comes from. Its own channel means the internal clock, so the channel is independent. Another channel makes it follow that channel (slave). CLK IN uses a front-panel clock input; LOGIC uses one of the logic outputs.',
        clock_mult_div: 'Following another channel with DELAY BY TIME off: multiplies or divides that channel’s clock (x2 = twice as fast, /2 = half as fast).',
        clock_use_time: 'Following another channel: delays each incoming clock by a time from this state’s own TIME and distribution settings, steady or random. The delay replaces MULT / DIV.',
        clock_use_bpm: 'Following another channel: ON follows its tempo grid (where its beats fall); OFF follows its actual gate output, which depends on all of its other settings.',

        // ---- sequencer ----
        seq_mode: 'The Lock state. TRACK: random generation runs and keeps recording its output into the sequence, overwriting the oldest step. HOLD: the sequence is kept and editable but not played; random generation runs. ON: the sequence plays and random generation stops (except for steps marked to change). Turning the sequencer ON switches ENVELOPE mode back to RANDOM.',
        seq_steps: 'The length of the sequence, up to 32 steps. OFF disables it.',
        seq_step_mode: 'What the sequence controls. VOLTAGE: the voltages come from the steps but timing stays random. TIME: the timing comes from the steps but voltages stay random. BOTH: everything comes from the sequence.',
        seq_step_dir: 'Playback direction: FORWARD, REVERSE or PING-PONG (back and forth).',
        seq_offset: 'Starts the sequence this many steps later, rotating it.',
        seq_voltage: 'The voltage of each step. The readout shows it as a note.',
        seq_gate_on: 'Whether each step outputs a gate.',
        seq_time: 'TIME mode: how long each step lasts, in milliseconds. Unlike a conventional sequencer, every step can have its own length.',
        seq_bpm_div: 'BPM mode: how long each step lasts, as a fraction of the beat (1/4, 1/3, 3/2…). Any division is possible.',
        seq_step_probability: 'The chance that each step plays. When it fails, the previous step’s voltage is held for this step’s duration.',

        // ---- presets ----
        preset_slots: 'The module has 16 preset slots, each holding all four channels with their three states. LEGACY: saved by firmware older than the checksum, and loads exactly as before. OK: checksummed. CHECKSUM: the data does not match its checksum and may be damaged. Editing a slot adds or updates its checksum.',
        selected: 'The preset the module loads when it is switched on. "None" starts from the built-in default preset.',

        // ---- CV assignments ----
        cva: 'The CV inputs, channel outputs and clock inputs can each drive any parameter of any channel and state. One input can drive several parameters at once, like a macro. Up to 64 per preset. They are applied top to bottom, so when two drive the same parameter the lower one wins. A parameter driven by CV cannot be changed from the module\u2019s knobs.',
        'cva.input': 'The signal that drives this assignment: one of the eight CV inputs, a channel\u2019s own CV output (so one channel can modulate another), or a clock input. Clock inputs can only trigger gate functions.',
        'cva.channel': 'The channel whose parameter is controlled.',
        'cva.state': 'The state whose settings the CV changes. It changes them whether or not that state is the active one, so the effect is heard while that state plays. A few actions (HOLD, MUTE, STATE A/B/C and the ALL transport actions) act on the channel or the module instead. On the module this is set from the state selected when the assignment is saved.',
        'cva.function_id': 'The parameter or action being controlled. "Follows the CV" functions track the voltage continuously. "Triggered when the CV goes high" functions fire once each time the CV crosses half scale, or on each clock pulse. A function marked "no effect" is offered by the module but does nothing in the current firmware.',
        'cva.gain': 'Scales the incoming CV before it is applied, from 0 (no effect) to 1 (full range). Applied after inversion. Not used for clock inputs, and not offered for triggered functions, as on the module.',
        'cva.offset': 'Shifts the scaled CV up, in volts (0 to 5 V), so the parameter can start from part-way up its range. Not used for clock inputs, and not offered for triggered functions, as on the module.',
        'cva.inverted': 'Inverts the incoming CV before gain and offset, so a rising voltage turns the parameter down. For triggered functions, it makes them fire when the CV goes low.',

        // ---- logic outputs ----
        lga: 'Three logic outputs, each built from up to 20 lines: a logic operation (AND, OR, XOR\u2026) on two signals, a counter, or a clock derived from a channel\u2019s tempo. The lines, including each counter\u2019s length, are built on the module; here the clock and pulse settings can be edited.',
        'lga.n_lines': 'How many operation lines this output has. Lines can feed each other, so later lines can combine earlier results.',
        lga_bpm_mult_div: 'BPM clock lines: the output clock as a multiple or division of the channel\u2019s tempo. A setting of 24 gives a 24-pulses-per-beat, MIDI-style clock.',
        lga_bpm_gate_trigger_mode: 'BPM clock lines: the shape of each pulse. GATE: high for half the period. 1 ms or 10 ms: a short trigger.',
        lga_counter_gate_trigger_mode: 'COUNTER lines: what is output when the count is reached. GATE: the counted input pulse is passed through at its own length. 1 ms or 10 ms: a short trigger instead.',

        // ---- custom scales ----
        'custom_scale.name': 'The name shown on the module when this scale is selected.',
        'custom_scale.n_semitones': 'How many of the notes below the scale uses. Notes past this count are ignored.',
        'custom_scale.semitones': 'The scale’s notes, as semitones above the root (0 to 12; halves are allowed for quarter tones). The readout below shows them in cents.',
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = HELP;
    else root.Help511 = HELP;
})(typeof window !== 'undefined' ? window : globalThis);
