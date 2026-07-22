# WhatsThat — project conventions

Local Mac web app that sends personalized 1:1 WhatsApp messages (via
whatsapp-web.js linked-device automation) to contacts from a private Google
Sheet. Single user (Adam), ~30–40 recipients, 6–8 campaigns/year.

## Versioning (required on every user-facing change)

- Single source of truth: `version` in `package.json`. The server exposes it
  via `/api/state`, the UI shows it in the header, and boot logs print it.
- Semver: **minor** bump for features, **patch** for fixes. Bump in the same
  commit as the change.
- Tag every version bump: `git tag v<X.Y.Z>` after committing.
- History: v1.1.0 = core app + send rules + autocomplete; v1.2.0 = scheduled sends;
  v1.2.1 = patch whatsapp-web.js for the July 2026 WA Web `_serialized`→`$1` breakage;
  v1.3.0 = launch-time auto-update + state restore across restarts + `--fresh`;
  v1.3.1 = pin WA Web build + startup watchdog (2026-07-22 build hangs auth).

## Feature map (v1.3.0)

- **Contacts**: Google Sheet (OAuth, read-only scope) or pasted CSV/TSV; row 1
  headers, `phone` column required; E.164 normalization (bare 10-digit → +1).
- **Send rules**: columns with ≤8 distinct repeating values (rank, Status)
  become toggle chips that drive selection; persisted in the draft.
- **Templates**: `{{variable}}` per column, case-insensitive; `{`-triggered
  autocomplete; strict rendering (empty/unknown variable ⇒ contact fails, never
  sends a broken message).
- **Sending**: test-send-to-self; sequential run with randomized 4–10s delays;
  live SSE progress; incremental crash-safe JSON reports in `reports/`.
- **Scheduling**: snapshot campaigns in `schedule.local.json`; in-app 30s tick
  + launchd agent (`net.whatsthat.scheduler`, every 2 min → `scripts/run-due.js`)
  sends with the app closed; 6h staleness cutoff → `missed`.
- **Auto-update**: `npm start` runs `scripts/launch.js` → `src/update.js`
  checks the npm registry and installs a newer whatsapp-web.js before the
  server boots (skipped in mock, via `WHATSTHAT_NO_UPDATE=1`, or while a
  scheduled send is running). Result lands in `update.local.json`; the UI
  shows a banner. On a version change the version-pinned patch is retired to
  `patches-retired/` first (restored automatically if the install fails).
- **State restore**: the draft also persists the loaded contact list
  (`contactsCache`), exact selection (`selectedIds`), and preview choice, so
  a restart repopulates everything ("restored from last session" note in the
  UI). `npm start --fresh` (or `-- --fresh`, or `node server.js --fresh`)
  sets the draft aside as `draft.backup.local.json` and boots blank.

## Testing

- `npm test` — 55 unit + e2e tests (server boots in mock mode; no real
  WhatsApp/Google). e2e uses `WHATSTHAT_TICK_MS=200` for fast scheduler ticks.
- Mock mode: `WHATSTHAT_MOCK=1` (numbers ending 99 = not on WhatsApp, 98 =
  send fails; mock always shows a QR first, then auto-readies).
- Frontend changes: verify in-browser against a mock server on a spare port
  (`PORT=3852 WHATSTHAT_DATA_DIR=<tmp>`) — NEVER against the user's live
  instance on 3847.
- Browser-automation gotchas learned the hard way: synthetic `type` needs OS
  window focus — use `document.execCommand('insertText', …)` in page JS
  instead (fires real input events). Check for stale servers with
  `lsof -nP -iTCP:<port> -sTCP:LISTEN` (the `-ti :p1,:p2` form silently
  matches nothing).
- **Never fully tested**: a real send on a live WhatsApp account (needs the
  user's linked session). Everything up to that boundary is covered.

## Local data (all gitignored, never commit)

| File | Contents |
|---|---|
| `.wwebjs_auth/` | WhatsApp session — treat like a password |
| `google.local.json` | App OAuth (client id/secret + **read-only** token) |
| `google-setup.local.json` | Write-scope token used only by `scripts/` |
| `draft.local.json` | Template, sheet URL, delays, filters, contacts cache, selection |
| `draft.backup.local.json` | Previous draft, set aside by a `--fresh` boot |
| `schedule.local.json` | Scheduled campaigns + lifecycle state |
| `update.local.json` | What the launch-time auto-updater did last |
| `patches-retired/` | Patches the auto-updater retired on a version change |
| `scheduler.log` | launchd runner output |

## Architecture invariants

- The app's Google token is **read-only** (`spreadsheets.readonly`) by design.
  Anything that writes to Sheets lives in `scripts/` with its own token file
  (`scripts/create-sheet.js` built the user's contact sheet).
- Only ONE process may use the WhatsApp session at a time (Chromium profile
  lock). `scripts/run-due.js` therefore checks `/api/state` first and delegates
  to the app when it's running; it must keep doing so.
- launchd plist must reference the stable node symlink
  (`/opt/homebrew/bin/node`), not `process.execPath` (Cellar paths break on
  `brew upgrade node`).
- whatsapp-web.js is unofficial: a WhatsApp Web update can break it until the
  lib ships a fix. First move on weird send failures:
  `npm update whatsapp-web.js`; if already on latest, check the repo's recent
  issues/PRs — community patches usually appear within days.
- **WhatsApp Web build pin** (`WEB_PIN` in `src/whatsapp.js`): startup is
  pinned to build 2.3000.1043085068 served from `.wwebjs_cache/` — the
  2026-07-22 build (…1043632247) hangs 1.34.7 between `authenticated` and
  `ready`. The pin silently deactivates if the cached html is missing (fresh
  machine), and a 3-min startup watchdog turns silent hangs into a UI error.
  **Remove the pin when upstream ships a working release** (the auto-update
  banner announces releases); override ad hoc with `WHATSTHAT_WEB_PIN=`.
- `patches/whatsapp-web.js+1.34.7.patch` (applied by patch-package on
  postinstall) carries upstream PR #201850: tolerates WA Web 2.3000.x renaming
  message-key `_serialized` → `$1` (July 2026 breakage; symptom was
  "Execution context was destroyed" on send). The auto-updater retires it to
  `patches-retired/` when it installs a newer release. **Auto-update
  recovery**: if sends break right after an auto-update, the new release
  likely lacks the fix — move the patch back from `patches-retired/` to
  `patches/` and `npm install whatsapp-web.js@<previous>` (the version is in
  `update.local.json`).

## User's setup (context)

- Google consent screen is on his Workspace; sheet: "WhatsThat Contacts"
  (id `<your-spreadsheet-id>`), tab `Contacts`, columns
  `firstName lastName nickname phone email rank Status`; rank dropdown
  Prospect/EA/FC/MM, Status Active/Inactive.
- One contact has no phone number in the sheet (auto-excluded until added).
- Deferred idea: import contacts straight from the Google Workspace Directory
  (People API `people.listDirectoryPeople`, `directory.readonly`) — needs
  admin-enabled sharing; directory profiles often lack mobile numbers.
