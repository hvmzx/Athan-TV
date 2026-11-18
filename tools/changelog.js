/*
 * Generates CHANGELOG.md from Conventional Commits.
 *
 * Usage:
 *   node tools/changelog.js                 # version from config.xml, since the last v* tag
 *   node tools/changelog.js 0.2.0           # section for 0.2.0
 *   node tools/changelog.js 0.1.0 --from root   # first release: include all commits
 *
 * Only "feat:" and "fix:" commits are listed (under Features / Fixes).
 * "chore:", "docs:", "refactor:" etc. are deliberately omitted.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const CHANGELOG = path.join(ROOT, "CHANGELOG.md");
const HEADER = "# Changelog\n";

function git(args) {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

function configVersion() {
    const xml = fs.readFileSync(path.join(ROOT, "tizen-app", "config.xml"), "utf8");
    const match = xml.match(/\bversion="([^"]+)"/);
    if (!match) {
        throw new Error("Could not read version from tizen-app/config.xml");
    }
    return match[1];
}

function tags() {
    try {
        return git(["tag", "--list", "v*", "--sort=-v:refname"]).split("\n").filter(Boolean);
    } catch (error) {
        return [];
    }
}

function previousRef(version, fromFlag) {
    if (fromFlag) {
        return fromFlag;
    }
    const current = "v" + version;
    const older = tags().filter((tag) => tag !== current)[0];
    if (older) {
        return older;
    }
    return git(["rev-list", "--max-parents=0", "HEAD"]).split("\n")[0];
}

function subjects(range) {
    const output = git(["log", "--no-merges", "--pretty=format:%s", range + "..HEAD"]);
    return output ? output.split("\n").map((line) => line.trim()).filter(Boolean) : [];
}

function group(commits) {
    const features = [];
    const fixes = [];
    for (const subject of commits) {
        const match = /^(feat|fix)(?:\([^)]*\))?!?:\s+(.+)$/i.exec(subject);
        if (!match) {
            continue;
        }
        const text = match[2].replace(/^./, (c) => c.toUpperCase());
        (match[1].toLowerCase() === "feat" ? features : fixes).push(text);
    }
    return { features, fixes };
}

function render(version, grouped) {
    const lines = ["## " + version, ""];
    if (grouped.features.length) {
        lines.push("### Features", "");
        for (const item of grouped.features) {
            lines.push("- " + item);
        }
        lines.push("");
    }
    if (grouped.fixes.length) {
        lines.push("### Fixes", "");
        for (const item of grouped.fixes) {
            lines.push("- " + item);
        }
        lines.push("");
    }
    return lines.join("\n").trimEnd() + "\n";
}

function main() {
    const args = process.argv.slice(2);
    const version = args.find((arg) => !arg.startsWith("-")) || configVersion();
    const fromIndex = args.indexOf("--from");
    const fromFlag = fromIndex === -1 ? null : args[fromIndex + 1];

    const range = previousRef(version, fromFlag);
    const grouped = group(subjects(range));
    const section = render(version, grouped);

    const existing = fs.existsSync(CHANGELOG) ? fs.readFileSync(CHANGELOG, "utf8") : HEADER;
    const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const sectionPattern = new RegExp("## " + escaped + "\\n[\\s\\S]*?(?=\\n## |$)", "g");
    const withoutVersion = existing.replace(sectionPattern, "").replace(/\n{3,}/g, "\n\n").trimEnd();
    const updated = (withoutVersion.startsWith("# Changelog") ? withoutVersion : HEADER.trimEnd()) +
        "\n\n" + section;

    fs.writeFileSync(CHANGELOG, updated, "utf8");
    process.stdout.write(section);
}

main();
