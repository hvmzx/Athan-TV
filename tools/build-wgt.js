/*
 * Builds an unsigned Tizen .wgt (a ZIP with config.xml at the root).
 * Usage: node tools/build-wgt.js          → dist/AthanTV.wgt (fixed release name)
 *        node tools/build-wgt.js --probe  → dist/athan-tv-probe.wgt (3-file diagnostic)
 *        node tools/build-wgt.js --bg     → dist/athan-tv-bg-1.2.0.wgt (sacrificial
 *                                          experiment package: fresh id +
 *                                          background-support="enable")
 *
 * HARD RULES for tizen-app/config.xml — proven on-device (TV TQ65S90CA via
 * Apps2Samsung v3.2.0-beta, Nov 2026). The TV rejects the install with
 * "install failed[118, -4] Operation not allowed: Load archive info fail"
 * for a manifest that is valid XML but breaks its loader:
 *   - NO XML COMMENTS anywhere in config.xml. Both packages proven to install
 *     on this TV (NuvioTV001, FreeMyTVio) ship a bare <?xml?> + <widget> file
 *     with zero comments and zero non-ASCII; our byte-identical probe passed
 *     only the build whose comment block was removed. Keep it that way —
 *     document manifest rationale here or in README, never in the manifest.
 *   - required_version must be <= the TV platform (we ship 2.3).
 *   - background-support must stay "disable": PROVEN DEAD END on this TV —
 *     the --bg experiment below (fresh id AthanTvB.AthanTvB, otherwise the
 *     same comment-free ASCII manifest, only flipped to "enable") failed
 *     install on 2026-11-09. Background mode is partner-gated; a web app
 *     cannot have it with a self-signed author/distributor cert. The id is
 *     burned (do not reuse AthanTvB for any future probe).
 *   - No http://tizen.org/feature/network.internet feature; access origin="*"
 *     plus the internet privilege is what the working apps declare.
 *   - After a failed [118] attempt the package id gets poisoned on the TV
 *     (failed-install copies linger): every diagnosis round needs a FRESH id.
 * Enforced below: buildPackage() refuses any config.xml with comments or
 * non-ASCII bytes.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ROOT = path.join(__dirname, "..");
const APP_DIR = path.join(ROOT, "tizen-app");
const DIST_DIR = path.join(ROOT, "dist");

function walk(directory, prefix) {
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    let files = [];
    for (const entry of entries) {
        if (entry.name.startsWith(".") || entry.name.startsWith("_")) {
            continue;
        }
        const full = path.join(directory, entry.name);
        const name = prefix ? prefix + "/" + entry.name : entry.name;
        if (entry.isDirectory()) {
            files = files.concat(walk(full, name));
        } else if (entry.isFile()) {
            files.push({ full, name });
        }
    }
    return files;
}

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(buffer) {
    let crc = 0xffffffff;
    for (let i = 0; i < buffer.length; i++) {
        crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
    const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
    const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    return { time, date: day };
}

function buildZip(entries) {
    const now = new Date();
    const stamp = dosDateTime(now);
    const localParts = [];
    const centralParts = [];
    let offset = 0;

    for (const entry of entries) {
        const data = fs.readFileSync(entry.full);
        const compressed = zlib.deflateRawSync(data, { level: 9 });
        const name = Buffer.from(entry.name, "utf8");
        const crc = crc32(data);

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0, 6);
        local.writeUInt16LE(8, 8);
        local.writeUInt16LE(stamp.time, 10);
        local.writeUInt16LE(stamp.date, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(compressed.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(name.length, 26);
        local.writeUInt16LE(0, 28);

        localParts.push(local, name, compressed);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0, 8);
        central.writeUInt16LE(8, 10);
        central.writeUInt16LE(stamp.time, 12);
        central.writeUInt16LE(stamp.date, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(compressed.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt16LE(0, 30);
        central.writeUInt16LE(0, 32);
        central.writeUInt16LE(0, 34);
        central.writeUInt16LE(0, 36);
        central.writeUInt32LE(0, 38);
        central.writeUInt32LE(offset, 42);
        centralParts.push(central, name);

        offset += local.length + name.length + compressed.length;
    }

    const centralBuffer = Buffer.concat(centralParts);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralBuffer.length, 12);
    end.writeUInt32LE(offset, 16);
    end.writeUInt16LE(0, 20);

    return Buffer.concat(localParts.concat([centralBuffer, end]));
}

function readVersion(appDir) {
    const config = fs.readFileSync(path.join(appDir, "config.xml"), "utf8");
    const match = config.match(/<widget[^>]*\sversion="([^"]+)"/);
    return match ? match[1] : "1.0.0";
}

/* Samsung's TV manifest loader rejects commented config.xml files outright
   ([118, -4] "Load archive info fail") even though they are valid XML.
   Refuse to build such a package. */
function assertManifestSafe(appDir) {
    const file = path.join(appDir, "config.xml");
    const bytes = fs.readFileSync(file);
    const text = bytes.toString("utf8");
    if (text.includes("<!--")) {
        throw new Error(
            "config.xml contains an XML comment. Samsung TV installers reject " +
            "commented manifests with [118, -4]. Move commentary to README.md " +
            "or the header comment of tools/build-wgt.js."
        );
    }
    for (let i = 0; i < bytes.length; i++) {
        if (bytes[i] > 0x7e) {
            throw new Error(
                "config.xml contains a non-ASCII byte (0x" + bytes[i].toString(16) + " at offset " + i + "). " +
                "Proven-to-install manifests are pure ASCII; keep it that way."
            );
        }
    }
}

/* Probe package: minimal payload sharing the app's manifest DNA. Installed
   on-device Nov 2026: proved the manifest, the signer tool and the push path
   were innocent while v1.1.1/v1.1.2 failed. Keep --probe around as a
   canary/tie-breaker for future install-toolchain issues. */
const PROBE_CONFIG = `<?xml version="1.0" encoding="UTF-8"?>
<widget xmlns="http://www.w3.org/ns/widgets" xmlns:tizen="http://tizen.org/ns/widgets" id="https://athantv.app/tizen" version="1.0.0" viewmodes="maximized">
    <tizen:application id="AthanProbe.AthanProbe" package="AthanProbe" required_version="2.3"/>
    <name>Athan TV Probe</name>
    <author href="https://athantv.app">Athan TV</author>
    <description>Install probe.</description>
    <content src="index.html"/>
    <icon src="icon.png"/>
    <feature name="http://tizen.org/feature/screen.size.all"/>
    <access origin="*" subdomains="true"/>
    <tizen:privilege name="http://tizen.org/privilege/internet"/>
    <tizen:profile name="tv-samsung"/>
    <tizen:setting screen-orientation="landscape" context-menu="disable" background-support="disable" encryption="disable" install-location="auto" hwkey-event="enable"/>
</widget>
`;

const PROBE_INDEX = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>Athan TV Probe</title></head>
<body style="background:#111;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<h1>Athan TV Probe OK</h1>
</body>
</html>
`;

function stageProbe() {
    const dir = path.join(ROOT, ".cache", "probe-app");
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "config.xml"), PROBE_CONFIG, "utf8");
    fs.writeFileSync(path.join(dir, "index.html"), PROBE_INDEX, "utf8");
    fs.copyFileSync(path.join(APP_DIR, "icon.png"), path.join(dir, "icon.png"));
    return dir;
}

/* Sacrificial background experiment — RESULT (2026-11-09): install FAILED.
   Samsung's loader rejects background-support="enable" from self-signed certs
   on this TV; the question is closed, keep this code only as the receipt.
   Full app under a FRESH package id with background-support="enable". */
function stageBg() {
    const dir = path.join(ROOT, ".cache", "bg-app");
    fs.rmSync(dir, { recursive: true, force: true });
    for (const file of walk(APP_DIR, "")) {
        const dest = path.join(dir, file.name);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        if (file.name === "config.xml") {
            let config = fs.readFileSync(file.full, "utf8");
            config = config
                .replace('version="1.1.7"', 'version="1.2.0"')
                .replace('id="AthanTizen.AthanTizen" package="AthanTizen"', 'id="AthanTvB.AthanTvB" package="AthanTvB"')
                .replace("<name>Athan TV</name>", "<name>Athan TV BG</name>")
                .replace("Prayer times and adhan on your Samsung TV.", "Background experiment build (sacrificial id).")
                .replace('background-support="disable"', 'background-support="enable"');
            if (config.includes("AthanTizen.AthanTizen") || !config.includes("background-support=\"enable\"")) {
                throw new Error("bg config patch failed — check tizen-app/config.xml anchors.");
            }
            fs.writeFileSync(dest, config, "utf8");
        } else {
            fs.copyFileSync(file.full, dest);
        }
    }
    return dir;
}

// Borrowed from the Nuvio/free-my-tv Tizen packagers: never trust a build
// until the archive itself has been read back and checked.
function verifyZip(output, files) {
    const buf = fs.readFileSync(output);
    const local = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
    if (!buf.subarray(0, 4).equals(local)) {
        throw new Error("Bad ZIP: missing local file header");
    }
    if (buf.toString("utf8", 30, 30 + "config.xml".length) !== "config.xml") {
        throw new Error("Bad ZIP: config.xml is not the first entry");
    }

    const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (eocd === -1) {
        throw new Error("Bad ZIP: missing end-of-central-directory record");
    }
    const count = buf.readUInt16LE(eocd + 10);
    let offset = buf.readUInt32LE(eocd + 16);
    const names = new Set();
    for (let i = 0; i < count; i++) {
        if (buf.readUInt32LE(offset) !== 0x02014b50) {
            throw new Error("Bad ZIP: corrupt central directory at entry " + i);
        }
        const nameLength = buf.readUInt16LE(offset + 28);
        const extraLength = buf.readUInt16LE(offset + 30);
        const commentLength = buf.readUInt16LE(offset + 32);
        names.add(buf.toString("utf8", offset + 46, offset + 46 + nameLength));
        offset += 46 + nameLength + extraLength + commentLength;
    }

    const expected = files.map((file) => file.name).sort();
    const actual = [...names].sort();
    if (count !== expected.length || expected.some((name, i) => name !== actual[i])) {
        throw new Error("Bad ZIP: archive contents do not match the staged files");
    }
}

function buildPackage(appDir, outName) {
    assertManifestSafe(appDir);
    const version = readVersion(appDir);
    const files = walk(appDir, "");

    // config.xml must be the first entry for Tizen tooling.
    files.sort((a, b) => {
        if (a.name === "config.xml") return -1;
        if (b.name === "config.xml") return 1;
        return a.name.localeCompare(b.name);
    });

    fs.mkdirSync(DIST_DIR, { recursive: true });
    const output = path.join(DIST_DIR, outName || "AthanTV.wgt");
    fs.writeFileSync(output, buildZip(files));
    verifyZip(output, files);

    const size = fs.statSync(output).size;
    console.log("Built " + output);
    console.log("Files: " + files.length + " · Size: " + (size / 1024).toFixed(1) + " KB");
    console.log("This package is unsigned. See README.md for signing/installation.");
}

function main() {
    if (process.argv.includes("--probe")) {
        buildPackage(stageProbe(), "athan-tv-probe.wgt");
    } else if (process.argv.includes("--bg")) {
        buildPackage(stageBg(), "athan-tv-bg-1.2.0.wgt");
    } else {
        buildPackage(APP_DIR);
    }
}

main();
