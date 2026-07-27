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
  v1.3.1 = pin WA Web build + startup watchdog (2026-07-22 build hangs auth);
  v1.4.0 = unpin (self-update defeats pinning), self-healing watchdog,
  single-instance guard, clean signal teardown, stale-tab auto-reload;
  v1.5.0 = inverse selection, WhatsApp-markup preview, cancel-button lifecycle;
  v1.5.1 = fix silent no-op sends to LID-migrated chats (repeat test-send bug);
  v1.6.0 = Mac app shell Phase A (Electron window+tray, attach-or-spawn,
  PORT=0 handshake, WHATSTHAT_PACKAGED, dataDir-based auth path);
  v1.7.0 = macOS-native design system (frameless window, AppKit-style
  controls, dark mode).

## Feature map (v1.7.0)

- **Contacts**: Google Sheet (OAuth, read-only scope) or pasted CSV/TSV; row 1
  headers, `phone` column required; E.164 normalization (bare 10-digit → +1).
- **Send rules**: columns with ≤8 distinct repeating values (rank, Status)
  become toggle chips that drive selection; persisted in the draft. Manual
  per-contact checkboxes + an Inverse-selection button on the contact table.
- **Templates**: `{{variable}}` per column, case-insensitive; `{`-triggered
  autocomplete; strict rendering (empty/unknown variable ⇒ contact fails, never
  sends a broken message); preview renders WhatsApp markup (*bold*, _italic_,
  ~strike~, `code`) via `public/format.js` — sent text keeps the raw markers.
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
- **Mac app shell** (`app/main.js`, `npm run app` — Phase A of the approved
  Electron plan): window + 💬 tray (status, pending sends) around the
  engine. Attaches to a terminal-started instance on 3847 when one answers
  `/api/state`; otherwise spawns `scripts/launch.js` with
  `ELECTRON_RUN_AS_NODE=1` (no system node needed) and parses the
  `whatsthat-listening <port>` stdout handshake. Cmd+Q SIGTERMs only a child
  it spawned; closing the window hides it (engine + scheduling stay alive).
  Engine flags added for it: `PORT=0` (ephemeral + handshake; origins and
  the OAuth redirect are built at listen time), `WHATSTHAT_PACKAGED=1`
  (implies NO_OPEN + NO_AGENT; exposed as `packaged` in `/api/state`),
  `createWhatsApp({ dataDir })` for the auth-session location.
- **Design system** (v1.7.0, `public/style.css`): macOS-native tokens with
  full dark mode (`prefers-color-scheme` variables — every new style must
  work in both), AppKit-style controls (push buttons, custom checkboxes,
  focus rings, menu-style autocomplete), frosted sticky toolbar that IS the
  frameless window's titlebar in the shell (`titleBarStyle: 'hidden'`,
  `body.in-app` set via Electron UA adds traffic-light inset + drag region;
  `-webkit-app-region` is a no-op in browsers so the same CSS serves both).
  `WHATSTHAT_THEME=light|dark` forces the shell appearance for testing.
  Gotcha: `background:` shorthand after/before `background-image:` silently
  drops layers — use multi-layer `background-image` (bit us on checkboxes).

## Testing

- `npm test` — 80 unit + e2e tests (server boots in mock mode; no real
  WhatsApp/Google). e2e uses `WHATSTHAT_TICK_MS=200` for fast scheduler ticks.
- App shell smoke (manual, mock): `PORT=3852 WHATSTHAT_MOCK=1
  WHATSTHAT_DATA_DIR=<tmp> npm run app` → window + tray appear, UI works;
  quit via `osascript -e 'quit app "Electron"'` and assert zero surviving
  processes + port freed. Attach mode: start a mock `node server.js` first,
  launch the shell, confirm its log has NO `whatsthat-listening` line (it
  attached), and that quitting the shell leaves the server running.
- Express gotcha: on EADDRINUSE the `app.listen` callback still fires with
  `server.address()` null — guard before dereferencing (bit us in v1.6.0).
- Mock mode: `WHATSTHAT_MOCK=1` (numbers ending 99 = not on WhatsApp, 98 =
  send fails; mock always shows a QR first, then auto-readies).
- Frontend changes: verify in-browser against a mock server on a spare port
  (`PORT=3852 WHATSTHAT_DATA_DIR=<tmp>`) — NEVER against the user's live
  instance on 3847. Never send on the user's live session without him; a
  read-only puppeteer.connect to the client's DevTools port is the approved
  way to inspect live state (see invariants below).
- Browser-automation gotchas learned the hard way: synthetic `type` needs OS
  window focus — use `document.execCommand('insertText', …)` in page JS
  instead (fires real input events; an element inside a closed `<details>`
  must be revealed with `.open = true` first). Check for stale servers with
  `lsof -nP -iTCP:<port> -sTCP:LISTEN` (the `-ti :p1,:p2` form silently
  matches nothing).
- **Live-verified** (2026-07-22): QR link, session restore, connect→ready,
  and repeated test-send-to-self on the user's real account.
- **Never yet done on live**: a full campaign run to real contacts, a real
  scheduled send, and the auto-updater actually installing a newer release
  (that path has only run against fakes — first exercised whenever upstream
  ships a release newer than 1.34.7).

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
- **Do NOT pin the WhatsApp Web build** (tried in v1.3.1, removed in v1.4.0):
  on 2.3000.x builds the page self-updates to the live version right after
  loading pinned html, forcing a mid-startup reload that wedges the library
  silently between `authenticated` and `ready` (in-flight evaluation dies;
  rejection swallowed in the exposeFunction bridge). The same race happens
  unpinned when WA ships a build mid-launch. Defense: the self-healing
  startup watchdog in `src/whatsapp.js` (2 min stall → destroy + relaunch
  once → then visible error). Diagnosis trick that cracked it: puppeteer
  .connect to the running client's DevTools port (chrome arg
  `--remote-debugging-port=0`, find via `lsof -p <chrome pid>`) and probe
  `window.WWebJS` / `window.Debug.VERSION` read-only.
- **One instance per port, enforced**: the WhatsApp client starts only after
  `app.listen` succeeds — a second launch exits with a pointer to the running
  instance (never boots an invisible client). SIGINT/SIGTERM destroy the
  client deterministically (puppeteer's own signal handlers are disabled;
  they've raced node's exit and left orphaned servers squatting on 3847).
- `patches/whatsapp-web.js+1.34.7.patch` (applied by patch-package on
  postinstall) carries three fixes for the July 2026 WA Web churn:
  upstream PR #201850 (message-key `_serialized` → `$1` rename tolerance;
  symptom was "Execution context was destroyed" on send), upstream PR
  #201839 (sent message indexed under the sibling lid/pn wid), and our own
  getChat fallback via `WAWebApiContact.getAlternateUserWid` — after LID
  migration a chat (notably the self-chat) can be indexed ONLY under the
  lid wid, and the pn-wid miss made upstream sendMessage silently send
  nothing (first test-send worked, every later one no-opped). `src/whatsapp.js`
  also treats an unconfirmed send (undefined return) as an error, never a ✓.
  The auto-updater retires the patch to `patches-retired/` when it installs
  a newer release. **Auto-update recovery**: if sends break right after an
  auto-update, the new release likely lacks these fixes — move the patch
  back from `patches-retired/` to `patches/` and
  `npm install whatsapp-web.js@<previous>` (version in `update.local.json`).

## Status & outstanding (as of 2026-07-22, v1.5.1)

Working end-to-end on the user's live account: link, connect (with
self-healing against WA Web's mid-launch build swaps), repeated test-sends.
The 2026-07-22 WA churn produced three live-debugged fixes, all carried in
`patches/whatsapp-web.js+1.34.7.patch` (details in invariants below):
`_serialized`→`$1` rename, sent-message alternate-wid lookup, and the
LID-migrated chat lookup miss that silently no-op'd sends.

Mac-app roadmap (Electron plan approved 2026-07-26; Phase A shipped v1.6.0,
native design system v1.7.0):
- **Phase B (v1.8.0)**: electron-builder packaging (engine unpacked from
  asar), data → `~/Library/Application Support/WhatsThat`, first-run
  onboarding (consent screen, Chromium download via `@puppeteer/browsers`
  + existing `WHATSTHAT_CHROME` override, QR, CSV-first contacts),
  app-resident scheduling replaces launchd in packaged mode, API token
  hardening. Packaged mode pins the engine per release — no live npm
  updates on user machines.
- **Phase C (v2.0.0)**: signing/notarization (needs Adam's Apple Developer
  ID — his call), electron-updater + public GitHub Releases as the
  fix-delivery channel, .icns icon, LICENSE.
- Ship gate: no distribution before a full live campaign has succeeded.

Outstanding / watchlist:
- **First full live campaign run** (and first real scheduled send) still
  pending — everything up to that boundary is verified.
- **Upstream release watch**: when whatsapp-web.js ships > 1.34.7, the
  auto-updater installs it and retires our patch to `patches-retired/`. If
  sends then break, follow "Auto-update recovery" below. Track the LID/PN
  work upstream (PRs #201839/#201850/#201853, issues #201849/#201857).
- **Auto-updater's real-install path** has only run against fakes; its first
  real execution deserves a glance at the boot log and banner.
- **Watchdog relaunch** (v1.4.0) has never fired against a real wedge.
- Never clarified: the user once asked for autocomplete "as well as a…" —
  the second half never arrived; ask if it comes up.
- Deferred idea: import contacts from the Google Workspace Directory
  (People API `people.listDirectoryPeople`, `directory.readonly`) — needs
  admin-enabled sharing; directory profiles often lack mobile numbers.

## User's setup (context)

- Google consent screen is on his Workspace; sheet: "WhatsThat Contacts"
  (id `<your-spreadsheet-id>`), tab `Contacts`, columns
  `firstName lastName nickname phone email rank Status`; rank dropdown
  Prospect/EA/FC/MM, Status Active/Inactive.
- One contact has no phone number in the sheet (auto-excluded until added).
