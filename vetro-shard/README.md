# Athan TV Alarm — Vetro Shard

A proof-of-concept [Vetro Shard](https://github.com/andrearicci93/vetro/blob/main/app/docs/plugins.md) that gives Athan TV a **background adhan alarm**.

## Why

A Tizen web widget stops ticking when it leaves the screen, and Samsung rejects `background-support="enable"` in self-signed packages. Vetro's service, however, is always running as root on the TV. This Shard lives inside that service and, at each prayer time, launches the already-installed Athan TV widget with `app_launcher`. The widget then shows its full-screen prayer overlay and plays `adan.mp3`.

## Install (on a rooted TV with Vetro 0.7+)

1. Build the bundle: `node tools/build-vetro-shard.js` → `dist/athan-alarm.vplugin`.
2. In Vetro: **Shards → Developer mode → on**, then **Install from a file** and pick the `.vplugin`.
3. Switch the Shard **on**; open its **Athan TV** tab.
4. Enter the mosque slug (the part after `mawaqit.net/en/`, e.g. `assalam-argenteuil`) and press **Save**. Press **Test launch** to confirm the widget opens.
5. Leave it on. It re-reads the schedule every 30 minutes and checks every 30 seconds.

The widget must already be installed. The Tizen app id to launch is configurable (default `AthanTizen.AthanTizen`, from `tizen-app/config.xml`).

## How it works

- Fetches `https://mawaqit.net/en/<slug>` **directly from Node** — no CORS, no proxy, no PC.
- Extracts `confData` and converts the mosque's local prayer times to absolute UTC timestamps using `Intl` time zones. On a TV without time-zone data you can set a fallback UTC offset in minutes (this does not handle DST automatically).
- Every poll: if an adhan happened within the last 90 seconds and was not already fired, runs `/usr/bin/app_launcher -s <appId>` as root. Each prayer fires once; a late launch (TV was off) is skipped.
- Optional `POST /plugins/athan-alarm/api/schedule` accepts UTC events pushed from another client, so the widget can be the source of truth instead.

## Security and limits

- Vetro Shards are **not sandboxed**: `exec` means the Shard can run commands as root. This is a trust decision — install only code you have read. `permissions` is a label, not a limit.
- Root via Vetro needs Tizen 6–9 and can be removed by a firmware update; Tizen 10 has no root route at present.
- The alarm only works while Vetro's service is running. Waking a sleeping panel is not guaranteed — `app_launcher` normally brings the widget to the front.
- `apiVersion: 1`, ES5 only, text-only bundle (1 file, ~29 KB).

## Development

```
node tools/test-vetro-shard.js                # mocked ctx: fetch/parse/trigger/dedupe/routes
node .cache/vetro/app/scripts/vetro-plugin.cjs check vetro-shard/athan-alarm
node tools/build-vetro-shard.js               # dist/athan-alarm.vplugin + SHA-256
```

The `check` command uses Vetro's own tooling (downloaded into the git-ignored `.cache/` folder) and applies the same checks the TV applies on install.
