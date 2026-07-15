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
- History: v1.1.0 = core app + send rules + autocomplete; v1.2.0 = scheduled sends.

## Feature map (v1.2.0)

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
| `draft.local.json` | Template, sheet URL, delays, send-rule filters |
| `schedule.local.json` | Scheduled campaigns + lifecycle state |
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
  `npm update whatsapp-web.js`.

## User's setup (context)

- Google consent screen is on his Workspace; sheet: "WhatsThat Contacts"
  (id `<your-spreadsheet-id>`), tab `Contacts`, columns
  `firstName lastName nickname phone email rank Status`; rank dropdown
  Prospect/EA/FC/MM, Status Active/Inactive.
- One contact has no phone number in the sheet (auto-excluded until added).
- Deferred idea: import contacts straight from the Google Workspace Directory
  (People API `people.listDirectoryPeople`, `directory.readonly`) — needs
  admin-enabled sharing; directory profiles often lack mobile numbers.
