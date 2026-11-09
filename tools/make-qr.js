/*
 * Regenerates tizen-app/assets/donate-qr.png — the QR code for the Mawaqit
 * donation PayPal link, rendered in the "Support Mawaqit" panel.
 *
 * One-time dev dependency (gitignored, NOT shipped in the .wgt — the PNG is
 * the deliverable):
 *   cd .cache/qrgen && npm init -y && npm install qrcode
 *
 * Usage: node tools/make-qr.js
 */
"use strict";

const path = require("path");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");
const QR_LIB = path.join(ROOT, ".cache", "qrgen", "node_modules", "qrcode");
const OUT = path.join(ROOT, "tizen-app", "assets", "donate-qr.png");

const DONATE_URL = "https://www.paypal.com/donate/?hosted_button_id=9MASUPX7BUYKE";

if (!fs.existsSync(QR_LIB)) {
    console.error("Missing dev dependency. Run:  npm --prefix .cache/qrgen install qrcode");
    process.exit(1);
}

const QRCode = require(QR_LIB);

fs.mkdirSync(path.dirname(OUT), { recursive: true });

QRCode.toFile(
    OUT,
    DONATE_URL,
    {
        errorCorrectionLevel: "M",
        margin: 4,
        width: 640,
        color: { dark: "#0d1417", light: "#ffffff" }
    },
    function (err) {
        if (err) {
            console.error(err);
            process.exit(1);
        }
        const size = fs.statSync(OUT).size;
        console.log("Wrote " + OUT + " (" + (size / 1024).toFixed(1) + " KB) for " + DONATE_URL);
    }
);
