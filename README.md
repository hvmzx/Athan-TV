# Mawaqit TV

A standalone prayer-times dashboard for Samsung Tizen TVs, powered directly by your favourite mosque
on [mawaqit.net](https://mawaqit.net).

![Mawaqit TV dashboard](docs/screenshots/dashboard.jpg)

Pick a country, select your mosque, and the TV displays its official adhan and iqama times,
Jumu'ah schedule, announcements, and the Hijri date. At prayer time, the app plays the Adhan and
takes over the screen with a full-size reminder and countdown. Keep the app on your TV's *Screen
Off* (Eco) mode and the full sound + notification experience keeps running with the panel dark.

---

## Features

- **100% Standalone (v0.1.0)** – Runs directly on your Samsung TV. No computer, server, or Docker container to run on your local network.
- **Mosque Picker** – Browse 156 countries and search among thousands of mosques by name, city, address, or postal code. Results update live as you type (the country map is cached locally, so typing costs almost no bandwidth).
- **TV Dashboard** – Mosque name, mosque-local clock, Gregorian + Hijri dates, next-prayer countdown, six prayer cards (Fajr, Shuruq, Dhuhr, Asr, Maghrib, Isha) and Iqama times. No mosque logo: text only, so the header stays calm and burn-in friendly.
- **Jumu'ah & Announcements** – Displays up to three Jumu'ah prayer times and an announcement ticker.
- **Adhan & Notifications** (all fire while Athan TV is on screen — see *Audio & Notifications*):
  - **On screen**: Full-screen modal takeover with the glowing crescent, mosque name, Iqama countdown, and real Adhan audio playback (`adan.mp3**), plus a native Tizen notification banner. Dismiss anytime with **OK** or **BACK**.
  - **Panel dark**: Use the TV's *Screen Off* mode — the app stays on screen logically, keeps ticking, and still takes over with sound at prayer time.
  - **Pre-alert reminder**: Optional discreet chime and reminder toast + banner 5, 10, or 15 minutes before the adhan.
- **OLED / QLED Burn-in Protection** – Gentle 20-minute Lissajous pixel drift prevents static retention during continuous display.
- **Remote-First UI** – Bespoke 2D spatial navigation for D-pad arrows, Samsung BACK (`10009`), LG Back (`461`), and OK (`13`).
- **Offline Tolerant** – Cached in `localStorage`; mosque timezones and DST transitions are handled internally.
- **Bilingual** – French & English interface (French by default).
- **Themes** – Six dark colour themes (Midnight, Emerald, Sapphire, Pitch black, **OLED B&W** monochrome on pure `#000`, Ramadan), selectable in Settings. Themes work purely through CSS variables on `<html data-theme="…">`. OLED forces every colour — including status dots, badges, images and one-off accents — to black/white/gray.
- **Support Mawaqit** – The PayPal donation QR code for the Mawaqit platform (that powers the data) is shown directly in Settings.

---

## Architecture

```text
Samsung Smart TV (tizen-app/)
          │
          │ Direct HTTPS (W3C / Tizen Web App)
          ▼
      mawaqit.net
```

The TV app connects directly to `mawaqit.net`, parses mosque `confData` client-side, computes Iqama offsets and timezones, and renders the dashboard.

*(An optional self-hosted FastAPI backend remains available in `repos/mawaqit-api/` for developers or third-party integrations).*

---

## Repository Layout

```text
.
├── tizen-app/               Tizen web app (the .wgt source)
│   ├── config.xml           Tizen manifest & privileges
│   ├── index.html           Main UI markup & audio player
│   ├── audio/
│   │   └── adan.mp3         Adhan audio played at prayer times
│   ├── css/style.css        Responsive 10-foot TV styles & focus states
│   ├── js/
│   │   ├── mawaqit.js       Direct Mawaqit scraping, caching & prayer math
│   │   ├── app.js           State machine, audio manager, triggers & OLED drift
│   │   ├── nav.js           Spatial D-pad remote navigation
│   │   ├── countries.js     Bundled 156-country directory
│   │   └── i18n.js          French & English dictionaries
│   ├── assets/
│   │   └── donate-qr.png     Mawaqit PayPal donation QR code
│   ├── logo.png             Transparent line-art logo used in-app
│   └── icon.png             TV home screen icon (opaque)
├── tools/
│   ├── build-wgt.js         Builds the unsigned .wgt package (Node.js)
│   ├── dev-server.js        Dev HTTP server with CORS proxy for PC browsers
│   ├── generate-icons.js    Regenerates application icons
│   ├── make-icon.py         Flattens logo.png onto the opaque launcher icon (Pillow)
│   └── make-qr.js           Regenerates assets/donate-qr.png (qrcode npm pkg in .cache/qrgen)
├── dist/                    Built packages ready for signing
└── docs/screenshots/
```

---

## 1. Test in a Desktop Browser

Desktop browsers enforce strict same-origin CORS that `mawaqit.net` does not open to browsers. To test on a computer, use the included dev server which serves the app and proxies API calls:

```powershell
node tools\dev-server.js
```

Open:
<http://localhost:8080/?base=http://localhost:8080/mawaqit>

Follow the on-screen setup: **Country → Mosque Search → Dashboard**.

---

## 2. Build the `.wgt` Package

Build the Tizen widget archive:

```powershell
node tools\build-wgt.js
```

Output: `dist/athan-tv-<version>.wgt` (the version comes from `tizen-app/config.xml`, currently `0.1.0`).
The builder reads the archive back and verifies the entry list, including `config.xml` as the first ZIP entry as required by Samsung Tizen OS.

GitHub Actions does the same build on every push and on `v*` tags: it uploads the `.wgt`, its SHA-256 checksum and the changelog as a build artifact (and attaches them to the tag's GitHub release). Only signing and installing happen locally.

> **Manifest gotcha (proven on-device):** the TV's package loader rejects
> `config.xml` files that contain **XML comments** — even perfectly valid ones —
> with `install failed [118, -4] Operation not allowed: Load archive info fail`.
> Keep `config.xml` comments-free and pure ASCII; the build refuses
> otherwise. After a failed `[118]` attempt the TV poisons that package id
> (hidden copies), so re-tests need a fresh `package=` / `tizen:application id=`.

> **4K note:** on UHD TVs the Tizen web engine renders every web app at a
> 1080p logical surface and the system upscales it — native 4K raster is not
> reachable from web apps. (Proven on-device 2026-11 with a temporary
> diagnostics build: `UI 1920×1080 · screen 1920×1080` even on a 4K panel —
> the web environment literally does not know about UHD. Nuvio/Netflix "4K" is the
> hardware video-decoder plane, not app UI.) Keep UI transforms on integer pixels
> (the OLED drift already `Math.round`s) and avoid CSS transitions on
> `transform` for full-screen panels: animated fractional-pixel interpolation
> visibly softens text after each drift step.

> **Background experiment (`--bg`) — CLOSED, dead end.** `node tools\build-wgt.js --bg`
> built `dist/athan-tv-bg-1.2.0.wgt` (same app, fresh id `AthanTvB.AthanTvB`,
> `background-support="enable"`). **Result on-device 2026-11-09: install failed.**
> Samsung's package loader rejects `enable` from self-signed certificates —
> background mode is partner-gated. Practical law for this TV: a web app runs
> only while on screen; the hands-off prayer experience is the TV's **Screen
> Off** mode. Never reuse the burned `AthanTvB` id.

---

## Asset generators

- `tizen-app/icon.png` is the flattened, **fully opaque** launcher icon. The
  in-app `logo.png` stays transparent, but the launcher icon must not: the
  Samsung selection highlight turns white behind transparent pixels, making the
  logo flip from dark to white when selected. Regenerate with
  `tools/make-icon.py` (needs Pillow; run with any Python that has it installed).
- `tizen-app/assets/donate-qr.png` regenerates with:
  ```powershell
  npm --prefix .cache\qrgen install qrcode
  node tools\make-qr.js
  ```

---

## 3. Sign and Install on your Samsung TV

Samsung TVs only install packages signed with an authorized Samsung Certificate.

### One-Time Setup

1. Install **Tizen Studio** with the **TV extension** via the Tizen Studio Package Manager.
2. In Tizen Studio, open **Tools → Certificate Manager**:
   - Create a new **Samsung Certificate** profile for **TV**.
   - Generate an **Author Certificate** and a **Distributor Certificate** (add your TV's DUID).
   - Name your profile (e.g. `MawaqitTV`).
3. Enable **Developer Mode** on your Samsung TV:
   - Open the **Apps** panel on your TV.
   - Press `1 2 3 4 5` on your remote control.
   - Switch Developer Mode to **ON** and enter your computer's local IP address.
   - Restart the TV (hold the Power button on the remote until the Samsung logo appears).
4. Connect via Tizen Studio **Device Manager** or command line:
   ```powershell
   sdb connect <TV_IP>:26101
   ```
   Right-click your TV in Device Manager and select **Permit to install applications**.

### Sign the Package

Using the Tizen Studio CLI terminal:

```powershell
tizen package -t wgt -s MawaqitTV -- dist\athan-tv-0.1.0.wgt
```

### Install onto the TV

```powershell
sdb install dist\athan-tv-0.1.0.wgt
```

The **Mawaqit TV** icon will now appear in your TV's apps ribbon!

---

## 4. Usage & Controls

1. Launch **Mawaqit TV** on your TV.
2. Select your **Country** (or filter by typing).
3. Type at least 2 characters of your mosque's name, city, or postal code and select your mosque.
4. The dashboard displays prayer times, next-prayer countdown, Jumu'ah, and announcements.

### Remote Key Shortcuts

| Remote Key | Action |
| :--- | :--- |
| **D-pad Arrows** | Move focus between cards, buttons, and inputs |
| **OK / Enter** | Select focused item; dismiss active prayer overlay |
| **BACK / Return** | Go back one screen; dismiss prayer overlay or settings |

### Audio & Notifications

- **Audio Unlock**: Modern TV browsers suspend audio until the first interaction. Press any key on your remote after launching the app once to prime the audio context.
- **Prayer Moment**: When the adhan time is reached while the app is on screen:
  - The screen opens a full prayer overlay and plays `adan.mp3`. Press **OK** or **BACK** to dismiss and stop the audio.
  - A native Samsung Tizen `StatusNotification` banner with adhan audio is posted alongside the overlay/toasts.
- **Frozen-when-hidden reality**: The manifest ships with `background-support="disable"` (the stable, install-safe configuration proven on-device). Leaving the app for the Smart Hub stops its timers — no banner will fire while another app or the home screen is up. The supported "hands-off" mode is the TV's own **Settings → Power Saving / Eco → Screen Off**, which keeps the on-screen app alive and only blanks the panel. The in-app test (*Settings → Notifications → Tester*) shows the exact next-prayer notification 5 s after pressing it; press it before switching to Screen Off mode and verify.
- **Late Launch Protection**: If the app is opened more than 90 seconds after a prayer started, it will not interrupt you with an alarm.
- **OLED Protection**: The dashboard slowly shifts by ±3 pixels over 20-minute intervals to protect OLED/QLED displays from burn-in.

---

## 5. Settings

Press the **Réglages / Settings** button on the bottom right of the dashboard to configure:

- **Langue**: Switch between Français and English. Notifications always follow this setting.
- **Notifications**: Toggle system notifications On/Off. *Tester* replays, after 5 seconds, the exact notification the next prayer would post, so you can verify real wording and sound.
- **Rappel avant l'adhan**: Set a reminder chime 5, 10, or 15 minutes before the adhan (or Off).
- **Thème**: Midnight, Émeraude, Saphir, Nuit noire, **OLED N&B** (strict monochrome on pure `#000`) or Ramadan.
- **Son**: Turn audio On/Off and test the adhan sound.
- **Soutenir Mawaqit**: The PayPal donation QR code for the Mawaqit platform, displayed directly in the settings.
- **Changer de mosquée**: Pick a different mosque without losing your settings.

---

## 6. Changelog & Versioning

The first release of this project is **0.1.0** (tag `v0.1.0`). `CHANGELOG.md` is
generated from the Conventional Commits between two version tags — only `feat:`
and `fix:` commits appear, grouped under **Features** and **Fixes**:

```powershell
node tools\changelog.js            # version from config.xml, commits since the last v* tag
node tools\changelog.js 0.2.0      # preview/regenerate a specific section
node tools\changelog.js 0.1.0 --from root   # the first release includes all commits
```

The GitHub Actions workflow regenerates the changelog on every build and
attaches it to the release for a `v*` tag.

### Commit convention

Every commit is a single line with no body:

```text
feat: live mosque search while typing
fix: keep reminder toast clear of the prayer overlay
chore: normalize line endings
```

Use `feat:` for new behaviour, `fix:` for bug fixes and `chore:`/`docs:`/`refactor:`
for work that should not appear in the changelog.

---

## Credits & License

- Prayer data provided by [mawaqit.net](https://mawaqit.net).
- Adhan audio: `audio/adan.mp3`.
- Backend proxy in `repos/mawaqit-api` adapted from [mrsofiane/mawaqit-api](https://github.com/mrsofiane/mawaqit-api) (MIT).
- This is an unofficial, community-driven project built for personal and home use on Samsung Smart TVs.
