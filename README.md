# Athan TV

Standalone prayer-times app for Samsung Tizen TVs, powered by [mawaqit.net](https://mawaqit.net). Pick your mosque and its adhan/iqama times, Jumu'ah and announcements stay on screen.

![Athan TV dashboard](docs/screenshots/dashboard.jpg)

## Features

- **Themes** – Midnight, Emerald, Sapphire, Onyx, Ramadan and **OLED B&W** (pure black & white, no colour accents).
- **Jumu'ah** – Friday prayer times shown on the dashboard alongside the six daily prayers and announcements.
- **Adhan notification** – full-screen reminder with adhan audio at each prayer, optional 5/10/15-minute pre-alert, and a Tizen notification banner.

No server or computer is needed: the TV fetches the mosque data directly.

## Sign and install on your Samsung TV

GitHub Actions builds an unsigned `AthanTV.wgt` (also attached to the `v0.1.0` release). Sign it with your Samsung certificate profile in Tizen Studio, then install with:

```powershell
sdb install dist\AthanTV.wgt
```

You can also install the signed package manually with **App2Samsung**. The app is **not yet available in the TV app store**.

## Development

```powershell
node tools\dev-server.js        # browser testing with a mawaqit.net proxy
node tools\build-wgt.js         # build the unsigned .wgt
node tools\changelog.js         # regenerate CHANGELOG.md from commits
```

Version: **0.1.0** · [Changelog](CHANGELOG.md) · [MIT License](LICENSE)
