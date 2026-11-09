/*
 * Generates the 512x423 Tizen TV app icon (no external dependencies).
 * Usage: node tools/generate-icons.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const OUT = path.join(__dirname, "..", "tizen-app", "icon.png");
const LOGO = path.join(__dirname, "..", "tizen-app", "logo.png");
const WIDTH = 512;
const HEIGHT = 423;
const SCALE = 2;

if (fs.existsSync(LOGO) && process.argv.indexOf("--force") === -1) {
    console.log("Official Athan TV logo is already in use at tizen-app/icon.png.");
    console.log("Pass --force if you specifically want to generate the procedural icon.");
    process.exit(0);
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

function chunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const typeBuffer = Buffer.from(type, "ascii");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
    return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodePng(width, height, rgba) {
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;  // bit depth
    ihdr[9] = 6;  // RGBA
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0;

    const stride = width * 4;
    const raw = Buffer.alloc((stride + 1) * height);
    for (let y = 0; y < height; y++) {
        raw[y * (stride + 1)] = 0;
        rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
    }

    return Buffer.concat([
        signature,
        chunk("IHDR", ihdr),
        chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
        chunk("IEND", Buffer.alloc(0))
    ]);
}

function mix(a, b, amount) {
    const value = Math.max(0, Math.min(1, amount));
    return a + (b - a) * value;
}

function insideCircle(x, y, cx, cy, radius) {
    const dx = x - cx;
    const dy = y - cy;
    return dx * dx + dy * dy <= radius * radius;
}

function insidePolygon(x, y, points) {
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const xi = points[i][0];
        const yi = points[i][1];
        const xj = points[j][0];
        const yj = points[j][1];
        const intersect = ((yi > y) !== (yj > y)) &&
            (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi);
        if (intersect) {
            inside = !inside;
        }
    }
    return inside;
}

function starPoints(cx, cy, outer, inner, rotation) {
    const points = [];
    for (let i = 0; i < 10; i++) {
        const radius = i % 2 === 0 ? outer : inner;
        const angle = rotation + (Math.PI / 5) * i;
        points.push([cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius]);
    }
    return points;
}

function render() {
    const width = WIDTH * SCALE;
    const height = HEIGHT * SCALE;
    const pixels = Buffer.alloc(width * height * 4);

    const cx = width * 0.5;
    const cy = height * 0.5;
    const outerRadius = height * 0.27;
    const subCx = cx + height * 0.10;
    const subCy = cy - height * 0.035;
    const subRadius = height * 0.245;

    const star = starPoints(cx + height * 0.30, cy - height * 0.24, height * 0.056, height * 0.022, -Math.PI / 2);
    const star2 = starPoints(cx - height * 0.29, cy - height * 0.205, height * 0.025, height * 0.010, -Math.PI / 2);

    for (let y = 0; y < height; y++) {
        const v = y / height;
        for (let x = 0; x < width; x++) {
            let r = mix(13, 3, v);
            let g = mix(50, 10, v);
            let b = mix(60, 16, v);

            const gx = x - width * 0.5;
            const gy = y - height * 0.53;
            const glow = Math.max(0, 1 - Math.sqrt(gx * gx + gy * gy) / (width * 0.66));
            r += 8 * glow * glow;
            g += 42 * glow * glow;
            b += 40 * glow * glow;

            const dx = x - cx;
            const dy = y - cy;
            const distance = Math.sqrt(dx * dx + dy * dy);

            // Soft gold halo around the crescent.
            if (distance > outerRadius && distance < outerRadius + height * 0.10) {
                const halo = 1 - (distance - outerRadius) / (height * 0.10);
                r = mix(r, 233, halo * 0.10);
                g = mix(g, 198, halo * 0.10);
                b = mix(b, 106, halo * 0.10);
            }

            if (insideCircle(x, y, cx, cy, outerRadius) &&
                !insideCircle(x, y, subCx, subCy, subRadius)) {
                const edge = Math.min(1, (outerRadius - distance) / (height * 0.012));
                r = mix(180, 246, edge);
                g = mix(146, 216, edge);
                b = mix(62, 132, edge);
            }

            if (insidePolygon(x, y, star) || insidePolygon(x, y, star2)) {
                r = 247;
                g = 227;
                b = 166;
            }

            const offset = (y * width + x) * 4;
            pixels[offset] = Math.round(r);
            pixels[offset + 1] = Math.round(g);
            pixels[offset + 2] = Math.round(b);
            pixels[offset + 3] = 255;
        }
    }

    // Box downsample to the final resolution.
    const output = Buffer.alloc(WIDTH * HEIGHT * 4);
    for (let y = 0; y < HEIGHT; y++) {
        for (let x = 0; x < WIDTH; x++) {
            let r = 0;
            let g = 0;
            let b = 0;
            for (let sy = 0; sy < SCALE; sy++) {
                for (let sx = 0; sx < SCALE; sx++) {
                    const offset = ((y * SCALE + sy) * width + (x * SCALE + sx)) * 4;
                    r += pixels[offset];
                    g += pixels[offset + 1];
                    b += pixels[offset + 2];
                }
            }
            const samples = SCALE * SCALE;
            const out = (y * WIDTH + x) * 4;
            output[out] = Math.round(r / samples);
            output[out + 1] = Math.round(g / samples);
            output[out + 2] = Math.round(b / samples);
            output[out + 3] = 255;
        }
    }

    return encodePng(WIDTH, HEIGHT, output);
}

fs.writeFileSync(OUT, render());
console.log("Wrote", OUT, "(" + WIDTH + "x" + HEIGHT + ")");
