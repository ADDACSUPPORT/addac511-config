# ADDAC511 config panel

**https://addacsupport.github.io/addac511-config/**

Read, edit and write the presets of an [ADDAC511 VC Stochastic Voltage
Generator](https://www.addacsystem.com/en/products/modules/addac500-series/addac511)
— connected over USB, or offline on a `.bin` backup.

- **Chrome or Edge:** connect the module over USB, read its presets, edit, and
  write them back. Nothing is written until you ask for it.
- **Any browser:** open a `.bin` backup, edit it, and save it again.
- **Firmware updates (Chrome or Edge):** the Firmware view installs the latest
  release over USB. Presets and calibration are kept.

It edits everything the module stores apart from calibration: the global
settings and all 16 presets, with the voltage, quantizer, gate, probability,
distribution, smooth, time, envelope, clock and sequencer settings for each of
the four channels and three states, plus CV assignments, logic outputs, custom
scales, note probabilities and time divisions. You can also create, duplicate,
delete and reorder presets, and import one from another backup.

Calibration data is never modified.

### Before you start

Take a backup first (*Save .bin*), so you can always get back to what you had.

Presets saved by older firmware are shown as **legacy**: they load normally, and
editing one brings it up to date. If a preset is reported with a checksum
problem, its data may be damaged — restore a known-good backup.

### Privacy

The page runs entirely in your browser. Nothing is uploaded: your presets go
between the module, the page and your own files only.

---

This repository is published automatically from ADDAC's firmware repository, so
changes made here are overwritten.
