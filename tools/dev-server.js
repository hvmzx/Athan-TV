/*
 * Development server for the standalone TV app.
 *
 * A desktop browser enforces CORS, but mawaqit.net only allows its own origin.
 * This server serves tizen-app/ and proxies /mawaqit/* to https://mawaqit.net/*
 * so the app can be tested outside a TV. The packaged app does NOT use this:
 * on a TV it fetches mawaqit.net through the native Tizen Download API.
 *
 * Usage:
 *   node tools/dev-server.js
 *   open http://localhost:8080/?base=http://localhost:8080/mawaqit
 */
"use strict";

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "tizen-app");
const PORT = Number(process.env.PORT || 8080);
const PROXY_PREFIX = "/mawaqit";
const USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 AthanTV-Dev/1.0";

const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
    ".mp3": "audio/mpeg"
};

function proxy(req, res) {
    const target = req.url.slice(PROXY_PREFIX.length) || "/";
    const upstream = https.request({
        hostname: "mawaqit.net",
        path: target,
        method: "GET",
        headers: {
            "User-Agent": USER_AGENT,
            "Accept": "application/json, text/html;q=0.9, */*;q=0.8",
            "Accept-Encoding": "identity"
        }
    }, (response) => {
        res.writeHead(response.statusCode || 502, {
            "Content-Type": response.headers["content-type"] || "application/octet-stream",
            "Cache-Control": "no-store"
        });
        response.pipe(res);
    });

    upstream.on("error", (error) => {
        if (!res.headersSent) {
            res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
        }
        res.end("proxy error: " + error.message);
    });
    upstream.setTimeout(45000, () => upstream.destroy(new Error("upstream timeout")));
    upstream.end();
}

function serveStatic(req, res) {
    const clean = decodeURIComponent((req.url || "/").split("?")[0]);
    const relative = clean === "/" ? "index.html" : clean.replace(/^\/+/, "");
    const file = path.resolve(ROOT, relative);

    if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
        res.writeHead(403);
        res.end("forbidden");
        return;
    }

    fs.readFile(file, (error, data) => {
        if (error) {
            res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("not found: " + relative);
            return;
        }
        res.writeHead(200, {
            "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
            "Cache-Control": "no-store"
        });
        res.end(data);
    });
}

function startServer(port) {
    const server = http.createServer((req, res) => {
        if (req.url.indexOf(PROXY_PREFIX + "/") === 0) {
            proxy(req, res);
            return;
        }
        serveStatic(req, res);
    });

    server.on("error", (err) => {
        if (err.code === "EADDRINUSE") {
            console.log("Port " + port + " in use, trying port " + (port + 1) + "...");
            startServer(port + 1);
        } else {
            console.error("Server error:", err);
        }
    });

    server.listen(port, () => {
        console.log("Athan TV dev server is running!");
        console.log("Open in your browser: http://localhost:" + port + "/?base=http://localhost:" +
            port + PROXY_PREFIX);
    });
}

startServer(PORT);
