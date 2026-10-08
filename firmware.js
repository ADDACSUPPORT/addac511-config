// Firmware updates: which builds exist, fetching one safely, and flashing it.
//
// Builds are published by CI next to the panel (firmware/manifest.json on the
// GitHub Pages site), in two channels: "release" from V* tags, and "dev" from
// main. Flashing uses WebUSB DFU against the ADDAC511 bootloader, through the
// vendored dfu.js / dfuse.js - the same code the earlier flashing pages used.
//
// The decisions (which interface, which address, whether a download is intact)
// are plain functions so they can be tested without a module attached.
(function (root) {
    'use strict';

    const Bin = typeof module !== 'undefined' && module.exports ? require('./bin.js') : root.Bin511;

    // Always the GitHub copy: it is the one CI keeps current, and it serves
    // Access-Control-Allow-Origin: *, so the GitLab dev URL and file:// can use it too.
    const FIRMWARE_BASE = 'https://addacsupport.github.io/addac511-config/firmware/';

    // ST's vendor id: both the ADDAC511 bootloader and the STM32 ROM bootloader use it.
    const USB_VENDOR_ST = 0x0483;

    // Where the application image goes. The bootloader exposes QSPI flash from
    // 0x90000000, but that start is the presets region (0x90000000-0x90064000)
    // and the bootloader loads the program from 0x90100000 (its linker script's
    // QSPIFLASH origin). The device does not advertise this; the earlier page
    // hard-coded the same "+0x100000". Writing here never touches the presets.
    const QSPI_BASE = 0x90000000;
    const APP_ADDRESS = 0x90100000;
    const PRESETS_END = 0x90064000;

    // ---------- the manifest ----------
    async function fetchManifest(fetchImpl) {
        const f = fetchImpl || root.fetch.bind(root);
        const r = await f(FIRMWARE_BASE + 'manifest.json', { cache: 'no-cache' });
        if (!r.ok) throw new Error('could not load the firmware list (HTTP ' + r.status + ')');
        return parseManifest(await r.json());
    }

    function parseManifest(m) {
        if (!m || m.schema !== 1 || !m.channels) throw new Error('unrecognised firmware list');
        const out = {};
        for (const ch of ['release', 'dev']) {
            out[ch] = (m.channels[ch] || [])
                .filter((e) => e && e.version && e.file && e.size > 0 && /^[0-9A-F]{8}$/i.test(e.crc32))
                .slice()
                .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
        }
        return { channels: out, updated: m.updated };
    }

    // ?channel=dev shows development builds; everyone else only ever sees releases.
    function channelFromUrl(search) {
        const p = new URLSearchParams(search || '');
        return p.get('channel') === 'dev' ? 'dev' : 'release';
    }

    // "V2.1" vs "V2-40-gaf91": release tags are dotted numbers; dev builds are
    // git describe output, which is a tag plus "-<commits>-g<hash>".
    function parseVersion(v) {
        const m = /^V(\d+(?:\.\d+)*)(?:-(\d+)-g([0-9a-f]+))?(-dirty)?$/i.exec(String(v || '').trim());
        if (!m) return null;
        return {
            parts: m[1].split('.').map(Number),
            ahead: m[2] ? Number(m[2]) : 0,
            hash: m[3] || null,
            dirty: !!m[4],
        };
    }

    // Negative if a < b. A dev build is newer than the tag it describes.
    function compareVersions(a, b) {
        const x = parseVersion(a), y = parseVersion(b);
        if (!x || !y) return 0;
        const n = Math.max(x.parts.length, y.parts.length);
        for (let i = 0; i < n; i++) {
            const d = (x.parts[i] || 0) - (y.parts[i] || 0);
            if (d) return d;
        }
        return x.ahead - y.ahead;
    }

    // The newest release that is newer than what the module runs, or null.
    function updateAvailable(running, releases) {
        if (!running || !releases || !releases.length) return null;
        const newest = releases.reduce((best, e) => (compareVersions(e.version, best.version) > 0 ? e : best));
        return compareVersions(newest.version, running) > 0 ? newest : null;
    }

    // ---------- downloading ----------
    // The CRC is checked before anything reaches the module: a truncated or
    // corrupted download must never be flashed.
    async function downloadBuild(entry, fetchImpl, onProgress) {
        const f = fetchImpl || root.fetch.bind(root);
        const r = await f(FIRMWARE_BASE + entry.file);
        if (!r.ok) throw new Error('could not download ' + entry.version + ' (HTTP ' + r.status + ')');
        const bytes = new Uint8Array(await r.arrayBuffer());
        if (onProgress) onProgress(bytes.length, entry.size);
        verifyBuild(bytes, entry);
        return bytes;
    }

    function verifyBuild(bytes, entry) {
        if (bytes.length !== entry.size) {
            throw new Error(`download of ${entry.version} is ${bytes.length} bytes, expected ${entry.size}`);
        }
        const crc = Bin.crc32(bytes).toString(16).toUpperCase().padStart(8, '0');
        if (crc !== entry.crc32.toUpperCase()) {
            throw new Error(`download of ${entry.version} is corrupted (CRC ${crc}, expected ${entry.crc32})`);
        }
        return true;
    }

    // A local .bin has no manifest entry to check against, so at least make sure
    // it is shaped like an application image: a stack pointer into RAM, and a
    // reset vector into the SRAM the bootloader copies the program to.
    function looksLikeFirmware(bytes) {
        if (!bytes || bytes.length < 1024) return 'too small to be a firmware image';
        if (bytes.length > 0x700000) return 'larger than the program area';
        const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const sp = dv.getUint32(0, true), reset = dv.getUint32(4, true);
        // The initial stack pointer is the TOP of the stack, i.e. one past the end
        // of RAM (0x20020000 for this firmware), so the upper bound is inclusive.
        const stackOk = (a) => (a > 0x20000000 && a <= 0x20020000) || (a > 0x24000000 && a <= 0x24080000);
        if (!stackOk(sp)) return 'the first word is not a stack pointer into RAM';
        if (!(reset >= 0x24000000 && reset < 0x24080000)) return 'the reset vector does not point into the program SRAM';
        return null;
    }

    // ---------- picking the DFU interface ----------
    // interfaces: [{ name }] as dfu.js reports them; returns the one to use or throws.
    function pickInterface(interfaces) {
        if (!interfaces || !interfaces.length) {
            throw new Error('The selected device has no DFU interface. Is the module in update mode?');
        }
        const qspi = interfaces.find((i) => i.name && i.name.includes('0x90000000'));
        if (qspi) return qspi;
        if (interfaces.some((i) => i.name && i.name.includes('0x08000000'))) {
            throw new Error('This is the STM32\'s built-in bootloader, which is used to install the ' +
                'ADDAC511 bootloader itself, not the firmware. Use the bootloader page for that.');
        }
        if (interfaces.length === 1) return interfaces[0];
        throw new Error('Could not find the ADDAC511 bootloader\'s flash interface.');
    }

    // segments: dfuse memory map; checks the write lands where it must.
    function checkTarget(segments, size) {
        const seg = (segments || []).find((s) => APP_ADDRESS >= s.start && APP_ADDRESS < s.end);
        if (!seg || !seg.writable) throw new Error('the bootloader does not expose a writable area at 0x90100000');
        if (APP_ADDRESS + size > seg.end) throw new Error('the firmware does not fit in the program area');
        if (APP_ADDRESS < PRESETS_END) throw new Error('refusing to write over the presets'); // can't happen; guards edits
        return seg;
    }

    // ---------- flashing ----------
    // events: { status(text), progress(done, total) }
    async function flash(bytes, events, deps) {
        deps = deps || {};
        const usb = deps.usb || root.navigator.usb;
        const dfu = deps.dfu || root.dfu;
        const dfuse = deps.dfuse || root.dfuse;
        const say = (t) => events && events.status && events.status(t);
        if (!usb) throw new Error('Firmware updates need WebUSB, which Chrome and Edge provide.');

        say('Choose the module in the browser’s list…');
        const selected = await usb.requestDevice({ filters: [{ vendorId: USB_VENDOR_ST }] });
        const interfaces = dfu.findDeviceDfuInterfaces(selected);
        await fixInterfaceNames(dfu, selected, interfaces);
        const settings = pickInterface(interfaces);

        let device = new dfu.Device(selected, settings);
        await device.open();
        const desc = await readFunctionalDescriptor(dfu, device);
        let transferSize = desc.TransferSize || 1024;
        const manifestationTolerant = desc.CanDnload ? !!desc.ManifestationTolerant : true;

        if (desc.DFUVersion === 0x011a && device.settings.alternate.interfaceProtocol === 0x02) {
            device = new dfuse.Device(device.device_, device.settings);
        }
        if (!device.memoryInfo) throw new Error('the bootloader did not report its memory map');
        checkTarget(device.memoryInfo.segments, bytes.length);
        device.startAddress = APP_ADDRESS;

        try {
            const st = await device.getStatus();
            if (st.state === dfu.dfuERROR) await device.clearStatus();
        } catch (e) { /* the earlier page tolerated this too */ }

        // route the library's logging into our UI, phase by phase
        device.logInfo = (m) => {
            if (/Erasing/.test(m)) say('Erasing the program area…');
            else if (/Copying/.test(m)) say('Writing the firmware…');
            else if (/Manifesting/.test(m)) say('Finishing…');
        };
        device.logProgress = (done, total) => events && events.progress && events.progress(done, total);
        device.logWarning = () => {};
        device.logDebug = () => {};
        device.logError = (m) => say(String(m));

        await device.do_download(transferSize, bytes, manifestationTolerant);
        if (!manifestationTolerant) {
            try { await device.waitDisconnected(5000); } catch (e) { /* restarted anyway */ }
        } else {
            try { await device.close(); } catch (e) { /* already gone */ }
        }
        say('Done. The module restarts with the new firmware.');
    }

    async function fixInterfaceNames(dfu, selected, interfaces) {
        if (!interfaces.some((i) => i.name == null)) return;
        const tmp = new dfu.Device(selected, interfaces[0]);
        await tmp.device_.open();
        await tmp.device_.selectConfiguration(1);
        const mapping = await tmp.readInterfaceNames();
        await tmp.close();
        for (const i of interfaces) {
            if (i.name === null) {
                i.name = mapping[i.configuration.configurationValue][i['interface'].interfaceNumber][i.alternate.alternateSetting];
            }
        }
    }

    async function readFunctionalDescriptor(dfu, device) {
        const data = await device.readConfigurationDescriptor(0);
        const cfg = dfu.parseConfigurationDescriptor(data);
        if (cfg.bConfigurationValue !== device.settings.configuration.configurationValue) return {};
        const d = cfg.descriptors.find((x) => x.bDescriptorType === 0x21 && Object.prototype.hasOwnProperty.call(x, 'bcdDFUVersion'));
        if (!d) return {};
        return {
            ManifestationTolerant: (d.bmAttributes & 0x04) !== 0,
            CanDnload: (d.bmAttributes & 0x01) !== 0,
            TransferSize: d.wTransferSize,
            DFUVersion: d.bcdDFUVersion,
        };
    }

    const api = {
        FIRMWARE_BASE, USB_VENDOR_ST, QSPI_BASE, APP_ADDRESS, PRESETS_END,
        fetchManifest, parseManifest, channelFromUrl, parseVersion, compareVersions,
        updateAvailable, downloadBuild, verifyBuild, looksLikeFirmware,
        pickInterface, checkTarget, flash,
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.Firmware511 = api;
})(typeof window !== 'undefined' ? window : globalThis);
