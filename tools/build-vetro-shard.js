/*
 * Builds a Vetro Shard bundle from vetro-shard/athan-alarm/.
 * The bundle format is the one plugin-host.js accepts on the TV:
 * { format: 'vetro-plugin', version: 1, manifest, files: { ... } }
 * Usage: node tools/build-vetro-shard.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const SHARD = path.join(ROOT, "vetro-shard", "athan-alarm");
const DIST = path.join(ROOT, "dist");
const OUTPUT = path.join(DIST, "athan-alarm.vplugin");

function checkManifest(manifest) {
    if (!/^[a-z][a-z0-9-]{1,31}$/.test(manifest.id || "")) {
        throw new Error("Invalid plugin id");
    }
    if (path.basename(SHARD) !== manifest.id) {
        throw new Error("Folder name must equal the plugin id");
    }
    if (manifest.apiVersion !== 1) {
        throw new Error("Only Vetro plugin API 1 is supported");
    }
    const perms = manifest.permissions || [];
    if (!Array.isArray(perms) || perms.some((p) => p !== "exec")) {
        throw new Error("permissions must be [] or ['exec']");
    }
    if (manifest.ui && (!manifest.ui.label || manifest.ui.label.length > 24)) {
        throw new Error("ui.label must be 1-24 characters");
    }
}

function checkEs5(source) {
    // The TV runs Node 4.4 on some models. node --check only proves the local
    // Node can parse it, so also reject syntax that 4.4 does not understand.
    execFileSync(process.execPath, ["--check", path.join(SHARD, "index.js")], { stdio: "pipe" });
    const patterns = [
        [/=>/, "arrow function"],
        [/`/, "template literal"],
        [/\b(?:let|const|class)\s+[A-Za-z_$]/, "let/const/class"],
        [/Object\.assign|Array\.from|\.includes\(|\.startsWith\(|\.endsWith\(/, "ES6 API"]
    ];
    for (const [pattern, label] of patterns) {
        if (pattern.test(source)) {
            throw new Error("Not ES5 compatible: " + label);
        }
    }
}

function main() {
    const manifest = JSON.parse(fs.readFileSync(path.join(SHARD, "manifest.json"), "utf8"));
    checkManifest(manifest);

    const files = {};
    for (const name of fs.readdirSync(SHARD).sort()) {
        if (name.charAt(0) === "." || name === "manifest.json" || name === "config.json") {
            continue;
        }
        const file = path.join(SHARD, name);
        if (!fs.statSync(file).isFile()) {
            continue;
        }
        const buffer = fs.readFileSync(file);
        if (buffer.includes(0)) {
            throw new Error(name + " is binary; a Shard holds text only");
        }
        files[name] = buffer.toString("utf8");
    }

    const entry = manifest.main || "index.js";
    if (typeof files[entry] !== "string") {
        throw new Error("Entry file " + entry + " is missing");
    }
    checkEs5(files[entry]);

    const bundle = { format: "vetro-plugin", version: 1, manifest, files };
    const text = JSON.stringify(bundle) + "\n";
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > 512 * 1024) {
        throw new Error("Bundle is larger than the TV limit of 512 KB");
    }

    fs.mkdirSync(DIST, { recursive: true });
    fs.writeFileSync(OUTPUT, text, "utf8");
    const sha = crypto.createHash("sha256").update(text, "utf8").digest("hex");
    fs.writeFileSync(OUTPUT + ".sha256", sha + "  athan-alarm.vplugin\n", "ascii");

    console.log("Built " + OUTPUT);
    console.log("Plugin " + manifest.id + " v" + manifest.version + " · " +
        Object.keys(files).length + " files · " + bytes + " bytes");
    console.log("sha256 " + sha);
    console.log("Install: Vetro Shards -> 'or from a file' (Developer mode), then switch it on.");
}

main();
