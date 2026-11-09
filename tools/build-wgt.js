/*
 * Builds an unsigned Tizen .wgt (a ZIP with config.xml at the root).
 * Usage: node tools/build-wgt.js
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
        local.writeUInt16LE(0x0800, 6);
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
        central.writeUInt16LE(0x0800, 8);
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

function readVersion() {
    const config = fs.readFileSync(path.join(APP_DIR, "config.xml"), "utf8");
    const match = config.match(/<widget[^>]*\sversion="([^"]+)"/);
    return match ? match[1] : "1.0.0";
}

function main() {
    const version = readVersion();
    const files = walk(APP_DIR, "");

    // config.xml must be the first entry for Tizen tooling.
    files.sort((a, b) => {
        if (a.name === "config.xml") return -1;
        if (b.name === "config.xml") return 1;
        return a.name.localeCompare(b.name);
    });

    fs.mkdirSync(DIST_DIR, { recursive: true });
    const output = path.join(DIST_DIR, "athan-tv-" + version + ".wgt");
    fs.writeFileSync(output, buildZip(files));

    const size = fs.statSync(output).size;
    console.log("Built " + output);
    console.log("Files: " + files.length + " · Size: " + (size / 1024).toFixed(1) + " KB");
    console.log("This package is unsigned. See README.md for signing/installation.");
}

main();
