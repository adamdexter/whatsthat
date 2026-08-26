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
  controls, dark mode);
  v1.8.0 = tabbed layout (Contacts / Message segmented control; Setup via
  gear + clickable WhatsApp capsule, auto-opens when link needed);
  v1.9.0 = WhatsThat.app (electron-builder, unsigned, asar off), data dir in
  ~/Library/Application Support/WhatsThat + one-time migration, Chromium via
  @puppeteer/browsers, engine pinned in the app, `engine.local.json`
  occupancy file, app + tray icons;
  v1.10.0 = resident resilience: WhatsApp auto-reconnect with backoff +
  liveness probe, scheduler holds ("waiting for WhatsApp") + nudges, launchd
  fallback runs the .app's own binary with a self-repairing plist, shell
  engine auto-respawn, login item + hidden launch, quit guard, notifications,
  richer tray;
  v1.11.0 = local API token + Host allowlist + OAuth state nonce +
  `/api/ping`, rotated engine log, CSV-first contacts, Data & reports card
  (reveal folders, Start fresh…), report reveal, `googleapis` →
  `@googleapis/sheets` (−200 MB), docs restructure;
  v1.12.0 = viewport layout (page never scrolls; contact table takes the
  remaining height), sent/failed chips filter the run list, "Last sent"
  column from the send reports (`/api/history`);
  v1.13.0 = public repo: history rewritten to drop the hard-coded contact
  list from `scripts/create-sheet.js` (now CSV-driven) and the sheet id from
  CLAUDE.md, public README, `dmg` build target, repo metadata, first
  GitHub Release;
  v1.14.0 = "Last sent" column removed (too noisy; `/api/history` +
  `src/history.js` stay for a future export), side-by-side layout toggle
  for wide windows (`body[data-layout=split]`, persisted as `draft.layout`);
  v1.15.0 = GitHub Actions (CI tests on push/PR; release build on `v*` tags
  attaches dmg/zip), `examples/contacts-sample.csv`, README badges;
  v1.16.0 = scale-aware send-rule detection for any custom column
  (`public/columns.js`), ask-once for ambiguous columns, columns panel,
  `draft.columnKinds`; sample CSV gains a `city` column;
  v1.17.0 = "Hide unselected" toggle on the contact table (constant label,
  pressed state, count line shows "· N hidden"; persisted as
  `draft.hideUnselected`).

## Feature map (v1.14.0)

- **Contacts**: Google Sheet (OAuth, read-only scope) or pasted CSV/TSV; row 1
  headers, `phone` column required; E.164 normalization (bare 10-digit → +1).
- **Send rules** (any column; v1.16.0 made the detection scale-aware):
  `public/columns.js` `classifyColumns({headers, contacts, decisions})`
  labels every non-phone column `filter` / `ask` / `field`: distinct
  (case-insensitive, non-empty) values ≤ max(4, ceil(10% × N)) ⇒ filter;
  ≤ max(8, ceil(25% × N)) and still repeating ⇒ ask; unique-per-person,
  constant (no blanks to contrast), empty or beyond ⇒ field. The user's
  answers live in `draft.columnKinds` ({header.lower: 'filter'|'field'})
  and override the heuristic; the Contacts tab shows a one-time prompt for
  `ask` columns and a *columns…* panel (every column, its reason, a Send
  rule/Field segmented choice, "Reset to automatic"). Filter chips drive
  selection; active filters persist as `draft.filters`. Manual per-contact
  checkboxes + Inverse selection remain, plus a **Hide unselected** toggle
  (`button.toggle` + `aria-pressed`, label never changes — state is the
  pressed look + "· N hidden" in the count line; unchecking a row while on
  removes it from view; empty-state row when nothing is selected).
  Unit-tested in `test/columns.test.js`.
  `examples/*.csv` + `examples/README.md` are the documented scenarios
  (8/12/14/20/40 contacts); `README.md` "Custom fields & send rules" quotes
  their real classifications — regenerate both if the thresholds change.
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
- **Tabbed layout** (v1.8.0): toolbar segmented control switches
  body[data-view] between `contacts` and `message` (cards shown per view via
  CSS; boot notice stays global). Setup (WhatsApp + Google cards) is NOT a
  tab: gear button / clickable WhatsApp capsule open it (`openSetup(pinned)`),
  it auto-opens on boot until WA is ready and on a live `qr` transition, and
  auto-advances to the last tab when `ready` arrives un-pinned. Last tab
  persists as `activeTab` in the draft.
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
- **Packaged app** (v1.9.0, `npm run dist` → `dist/mac-arm64/WhatsThat.app`
  + zip): electron-builder with **`asar: false`** (launchd must exec
  `scripts/run-due.js` by path; puppeteer/wwebjs do plain fs work) and an
  explicit `files` allowlist (the repo root holds the WhatsApp session and
  OAuth token — a default glob would bundle them). `scripts/verify-build.js`
  proves both directions after every build (engine deps + patch marker
  present; sessions/tokens/reports/tests/electron absent; bundle id
  `net.whatsthat.app`; ad-hoc signature). Packaged shell spawns `server.js`
  directly with `WHATSTHAT_PACKAGED=1` (no `launch.js`, so no auto-update:
  engine pinned per release, `/api/state.update = {installed, pinned:true}`)
  and `cwd: DATA_DIR`. Port policy: attach to a WhatsThat on 3847, else
  spawn on 3847 (stable OAuth redirect), `PORT=0` only if a non-WhatsThat
  squatter holds it. Icons: `build/icon.html` (canvas drawing) → `npm run
  icons` (Electron offscreen) → `build/icon.icns` + `app/assets/icon.png`
  (dev Dock) + `app/assets/trayTemplate{,@2x}.png`. Unsigned: a locally
  built app never gets the quarantine xattr; a transferred zip needs
  Privacy & Security → "Open Anyway" on Sequoia (right-click → Open no
  longer bypasses Gatekeeper).
- **Data dir** (`src/datadir.js` `resolveDataDir`): `WHATSTHAT_DATA_DIR` →
  `~/Library/Application Support/WhatsThat` when packaged → same dir when it
  already holds `.wwebjs_auth/session` (terminal mode follows the app: one
  session, one dir) → repo root. Everything data-like derives from it
  (`reports/`, `scheduler.log`, `.wwebjs_cache`, `chromium/`, `logs/`);
  `/api/state.paths` lists them. **Migration** (`migrateData`, run by
  `npm run migrate-data` or on boot via `WHATSTHAT_MIGRATE_FROM`, which the
  dev shell passes): copy + size-verify into a `.migrating` staging dir,
  atomic rename, skips Chromium lock files / `.wwebjs_cache` /
  `google-setup.local.json`, never overwrites, never deletes, refuses when
  the source session's `SingletonLock` pid is alive or a campaign is
  running; `.migrated-from.json` marker makes it a one-time no-op.
  `engine.local.json` (0600) names the occupant `{pid, port, version,
  chromePid…}`: shell attach for ephemeral ports, `run-due.js` port
  discovery, and a cross-port instance lock in the listen callback (an
  engine that finds a live, answering occupant on another port exits 1).
  The shell keeps its own Chromium profile under `<DATA_DIR>/shell`
  (`app.setPath('userData')` before the single-instance lock).
- **Chromium** (`src/browser.js` `ensureBrowser`, called inside
  `wa.initialize()` before the startup watchdog is armed): `WHATSTHAT_CHROME`
  (missing path ⇒ error, never a silent fall-through) → `<DATA_DIR>/chromium`
  → `~/.cache/puppeteer` (`PUPPETEER_CACHE_DIR`) → download via
  `@puppeteer/browsers` `install()` (~160 MB, 338 MB unpacked). Build id =
  `puppeteer-core`'s `PUPPETEER_REVISIONS.chrome`, so it always matches the
  library. Progress rides `wa.browser {status, percent, source}` on the
  normal `wa_state` SSE; the UI shows a bar, the tray a percentage. Chromium
  is never bundled in the app.
- **Resident resilience** (v1.10.0). *Engine* (`src/whatsapp.js`): every
  recoverable failure funnels into a single-flight `relaunch(reason)`
  (destroy → initialize) with backoff 5s/15s/45s/2m/5m and a budget of 5
  attempts that resets after 10 min of `ready` or on a manual reconnect;
  the startup watchdog is just another caller of it. `retrying` is held only
  while scheduling/destroying (NOT while the new initialize() is pending) so
  the watchdog can interrupt a stalled relaunch; a generation counter tells
  a superseded initialize() its rejection is expected. `'disconnected'`
  reasons are classified (`classifyDisconnect`): LOGOUT/UNPAIRED* ⇒ *relink*
  (status `disconnected`, QR needed — LOGOUT re-injects by itself, UNPAIRED
  gets one budget-free relaunch to surface the QR); TOS_BLOCK/SMB_TOS_BLOCK/
  PROXYBLOCK ⇒ *fatal* (`error`, no retry); everything else ⇒ relaunch.
  `takeoverOnConflict: true` (15 s): the app reclaims the session when
  web.whatsapp.com is opened elsewhere. **Liveness probe** every 3 min while
  `ready`: `client.getState()` raced against 20 s — a throw/null means the
  page is gone (wwebjs emits nothing for that) ⇒ relaunch; non-CONNECTED 3×
  ⇒ `resetState()`, 5× ⇒ relaunch. State exposes `reconnect {attempts, max,
  lastReason, nextAt, count}`, `liveness`, `readyAt`. `POST
  /api/whatsapp/reconnect` (409 mid-run); MOCK-only `POST /api/mock/disconnect
  {reason}` / `/api/mock/relink` drive the tests. `unhandledRejection` now
  logs instead of killing the engine; `uncaughtException` closes the browser
  and exits 70 (the shell respawns). *Scheduler*: `executeDue` runs
  `findDue()` housekeeping FIRST (staleness applies even with WA down), then
  holds due campaigns while WA ≠ ready — status stays `pending` (Cancel
  works), `waitingSince`/`waitReason` set, `/api/state.scheduleHold` +
  `pendingCount`, UI shows "due — waiting for WhatsApp (…)"; a ready
  transition fires `executeDue` immediately; a `disconnected|error` hold
  nudges `wa.reconnect()` at most every 10 min (never on `qr`). *launchd
  fallback*: `NO_AGENT = env || MOCK` (PACKAGED no longer implies it);
  `agentSpec()` builds the plist for THIS engine — packaged: the .app binary
  as node (`ELECTRON_RUN_AS_NODE`) + unpacked `scripts/run-due.js`, with
  `EnvironmentVariables` (`WHATSTHAT_DATA_DIR`, `PORT`, `WHATSTHAT_PACKAGED`,
  `WHATSTHAT_CHROME` if set) because launchd starts with an empty env;
  `ensureAgent()` compares the rendered plist with the file on disk and
  re-bootstraps only on change or when unloaded — called on every boot when a
  plist exists or campaigns are pending (self-repair after move/reinstall/
  dev↔packaged; both share the label, last boot wins) and from `POST
  /api/schedule`; `/api/state.agent {mode, installed, plist, nodePath,
  scriptPath, repairedAt, error}`; `POST /api/agent/uninstall`.
  `run-due.js` probes `engine.local.json`'s port, then `PORT`, then 3847,
  and refuses to boot its own client while the profile's `SingletonLock`
  pid is alive. *Shell* (`app/main.js`): bounded engine auto-respawn (3 in 10
  min, 2s/10s/30s; the window is re-pointed at the new port; a stale child's
  exit is ignored via identity check; budget exhausted ⇒ one dialog with
  "Restart engine"); login item enrolled once on the first packaged boot
  (`shell/shell.local.json` flag; tray checkbox afterwards;
  `requires-approval` opens System Settings; lost registration re-applied);
  hidden launch = `--hidden` / `WHATSTHAT_HIDDEN=1` / `wasOpenedAtLogin` /
  (openAtLogin && uptime < 5 min) ⇒ dock hidden, no window until "Open";
  quit guard on `before-quit` when we own the engine and sends are pending
  or running (wording depends on whether the launchd fallback is installed;
  `powerMonitor shutdown` quits silently; attach mode never guards);
  notifications by poll-and-diff every 15 s (campaign done/failed/missed,
  hold > 2 min, WA needs a human — click opens the window; the first poll
  only seeds); tray glyph next to the template icon (`…` starting, `!`
  attention), rows for reconnecting/hold/engine state, Reconnect WhatsApp,
  Open Reports Folder, Start at Login, Remove Background Scheduler.
  `logs/shell.log` records all of it.
- **Local API hardening** (v1.11.0). `API_TOKEN = WHATSTHAT_API_TOKEN ||
  randomBytes(24)` per boot; `GET /` (and `/index.html`) sets it as an
  `HttpOnly; SameSite=Strict` cookie; one `/api` middleware accepts the
  cookie or an `X-WhatsThat-Token` header (timing-safe compare) and exempts
  only `/api/ping` (unauthenticated discovery: version, packaged, mock,
  dataDir, wa.status) and `/api/google/callback` (Google's top-level
  redirect carries no cookie; it is guarded by a one-shot `state` nonce from
  `GET /api/google/auth-url` instead — `/api/google/connect` is gone). A
  Host allowlist (`localhost:<port>`, `127.0.0.1:<port>`) on ALL routes
  defeats DNS rebinding; the Origin check on non-GET stays. The token is
  written into `engine.local.json` (0600): the shell passes it to a spawned
  engine via env and reads it from the file when attaching; `run-due.js`
  reads it the same way. The page reloads once on a 401 (stale cookie after
  an engine restart). Tests pin `WHATSTHAT_API_TOKEN=test-token`
  (`test/helpers.js` `AUTH`). Threat model: drive-by web pages and DNS
  rebinding — NOT another process on this Mac (it can read the file).
- **Logs** (`src/log.js` `installFileLog`): in packaged mode (or with
  `WHATSTHAT_LOG_FILE`) console output is teed into `<DATA_DIR>/logs/engine.log`
  (5 MB, 2 rotations); the shell writes `logs/shell.log`; launchd writes
  `logs/scheduler.log` (run-due trims it; `installAgent` creates the dir —
  launchd will not). Tray "Show Logs" / Setup → Data & reports reveal it.
- **UX** (v1.11.0): Contacts leads with pasted CSV (`#src-csv` open unless
  Google is connected; `#btn-load-sheet` disabled with a hint until then —
  `renderContactSources()`); Setup gains a "Data & reports" card (data
  path, Show Reports Folder / Show Logs via `POST /api/open-folder
  {what}`, "Start fresh…" via `POST /api/draft/reset` = the app's
  `--fresh`); the run report shows the absolute path + "Show in Finder";
  `/api/state.run {active,total,done,sent,failed,cancelled,startedAt}`
  (`runner.status()`).
- **Layout** (v1.12.0): `html, body { height: 100% }`, body is a flex
  column, `main` fills the rest (`overflow: auto` only as a safety valve on
  the Message tab); on the Contacts tab `main` is `overflow: hidden`, the
  card is a flex column and `#contacts-table-wrap` is `flex: 1; min-height: 0;
  overflow: auto` — the table scrolls, the window never does, at any size.
  The source pickers (`<details>`) fold once a list is loaded
  (`renderContactSources` runs from `setContacts`). Shell window default
  1180×1040, min 720×600. `#progress-list` caps at 40vh.
- **Run report filter** (v1.12.0): the summary counts are
  `button.report-chip[data-status]` toggles; `S.reportFilter` hides
  `.progress-item[data-status]` rows, greys the chip (`.off`), and
  `applyReportFilter()` shows "No message status selected…" when nothing is
  visible. Reset on every new run.
- **Send history API** (v1.12.0; the table column was removed in v1.14.0 as
  too noisy): `src/history.js` folds `reports/run-*.json` into
  `{ byPhone: { '+1…': { at, text, reportFile, count } } }` — last
  *successful* send per E.164 phone, later report wins, cached by dir
  signature; `GET /api/history`. Local by design (read-only Google token,
  CSV contacts have no sheet). Kept for a future history view/export.
- **Side by side** (v1.14.0): toolbar toggle `#btn-split` → `S.layout` →
  `body[data-layout="split"]` (persisted as `draft.layout`). Under
  `@media (min-width: 1280px)` and outside Setup, `main` becomes a 2-column
  grid: `#card-contacts` (flex column, table scrolls) left, `#col-message`
  (a wrapper around the Message + Send cards, `display: contents` in tabbed
  mode) right as its own scrolling column; the segmented control hides.
  Narrower than 1280px the toggle button hides and tabs come back with the
  setting remembered. Note the card display rules are `main .card` (not
  `main > .card`) because of that wrapper.
- **Sheets client**: `src/sheets.js` uses `@googleapis/sheets` (same
  `auth.OAuth2`, same token file) — the 200 MB `googleapis` umbrella is a
  devDependency now, used only by `scripts/create-sheet.js`.

## Testing

- **CI** (`.github/workflows/ci.yml`): `npm ci && npm test` on `macos-14`
  with `PUPPETEER_SKIP_DOWNLOAD=1` for every push to main and every PR.
  **Release** (`.github/workflows/release.yml`): a `v*` tag push runs the
  tests, `npm run dist`, and creates/updates that tag's GitHub Release with
  the dmg + zip (`gh release upload --clobber` when the release already
  exists, so a local `gh release create` beforehand is fine). The release
  flow is therefore: bump + commit + `git tag vX.Y.Z` + `git push origin
  main --tags` — no local build needed.
  Gotcha: electron-builder auto-publishes when it sees a git tag (`Implicit
  publishing triggered by git tag`) and fails without GH_TOKEN — the dist
  script passes `--publish never`. GitHub also dropped the tag event when
  the workflow file and the tag arrived in the same push; re-pushing the tag
  (`git push origin :refs/tags/vX && git push origin vX`) fires it.

- `npm test` — 131 unit + e2e tests (server boots in mock mode; no real
  WhatsApp/Google). e2e uses `WHATSTHAT_TICK_MS=200` for fast scheduler ticks.
  Every spawned server gets `WHATSTHAT_API_TOKEN: TOKEN` and every raw
  `fetch` of `/api/*` sends `AUTH` (`test/helpers.js`); discovery polls
  use `/api/ping`. `test/api-token.test.js` is the hardening matrix.
  `test/resilience.test.js` drives holds/reconnects through the mock hooks;
  `test/run-due.test.js` runs the real `scripts/run-due.js` against a mock
  engine (delegation, discovery, lock refusal).
- Shell resilience smoke (dev, mock): boot `npm run app` with a tmp data dir,
  `kill -9` the pid in `engine.local.json` → `shell/shell.log` shows
  "engine restart 1/3 in 2s" then "engine back on port …", `/api/state`
  answers again, quit is clean. Packaged (real session): `open -a WhatsThat`
  → `shell.log` shows "login item enabled → {status:'enabled'…}" once;
  `open -a WhatsThat --args --hidden` → System Events counts 0 windows;
  scheduling a send to yourself 2 days out then cancelling installs the
  launchd plist (`cat ~/Library/LaunchAgents/net.whatsthat.scheduler.plist`
  shows the .app binary + EnvironmentVariables; `launchctl print
  gui/$(id -u)/net.whatsthat.scheduler`) and leaves it installed. Never
  quit with a pending send in an automated check — the quit guard dialog
  blocks. A real login → menu-bar-only launch is the one thing only the user
  can verify (`wasOpenedAtLogin` + the uptime heuristic).
- Packaged app: `npm run dist` builds `dist/WhatsThat-<v>-arm64.dmg` + `.zip`
  (the unpacked app stays in `dist/mac-arm64/`; verify-build runs
  automatically), then a mock
  smoke by running the binary directly — `open -a` drops env:
  `WHATSTHAT_MOCK=1 WHATSTHAT_DATA_DIR=$(mktemp -d) PORT=3852
  dist/mac-arm64/WhatsThat.app/Contents/MacOS/WhatsThat` → window + tray,
  `engine.local.json` in the data dir with `packaged:true`, engine cwd =
  data dir (`lsof -p <pid>`), `update.pinned`; quit via `osascript -e 'quit
  app "WhatsThat"'` → no `WhatsThat.app` processes, port freed, occupancy
  file gone. Install with `ditto dist/mac-arm64/WhatsThat.app /Applications/`.
  Download-path check without touching real data: `WHATSTHAT_DATA_DIR=$(mktemp
  -d) PUPPETEER_CACHE_DIR=/nonexistent PORT=3855 node server.js` → log shows
  "Downloading Chrome…", `wa.browser.source: 'downloaded'`, reaches `qr`.
- Note the engine's stdout is invisible for a Finder-launched app until the
  v1.11.0 log file lands — for now redirect the binary's output when testing.
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
- **Live-verified**: QR link, session restore, connect→ready, repeated
  test-send-to-self (2026-07-22); a full campaign to real contacts and a
  launchd-driven scheduled send with the app closed (before 2026-08-25); the
  packaged app end-to-end incl. migration and test-send (2026-08-25).
- **Never yet done on live**: the auto-updater actually installing a newer
  release (only run against fakes — first exercised whenever upstream ships
  a release newer than 1.34.7; terminal mode only, the app is pinned).

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
| `engine.local.json` | Occupant of this data dir: pid, port, version, chromePid (0600; removed on clean exit) |
| `.migrated-from.json` | Marker written by the one-time data migration (what was copied, from where) |
| `chromium/` | Chrome for Testing downloaded by `src/browser.js` when no cache copy exists |
| `shell/` | The Electron shell's own profile (window cache/cookies) + `shell.local.json` prefs — never the engine's |
| `logs/` | `engine.log` (packaged), `shell.log`, `scheduler.log` |

Two homes: the repo root (terminal mode, historically) and
`~/Library/Application Support/WhatsThat` (the app, and terminal mode once a
session lives there — see `resolveDataDir`). The user's data was migrated
2026-08-25; the repo copies are stale backups.

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
- **All data paths derive from `DATA_DIR`** — never `ROOT` or `process.cwd()`.
  Two bugs taught this: whatsapp-web.js's `LocalWebCache` writes
  `./.wwebjs_cache` relative to cwd with an unguarded `mkdirSync` mid-startup
  (fatal when a Finder-launched app has cwd `/` — fixed by
  `webVersionCache.path` + spawning the engine with `cwd: DATA_DIR`), and
  `scheduler.log` was rootDir-based.
- **Never bundle Chromium**; `WHATSTHAT_CHROME` always wins when set (and a
  wrong path is an error). `@puppeteer/browsers` is pinned exactly to what
  puppeteer-core pins — bump them together when whatsapp-web.js moves.
- **Packaged mode pins the engine**: `scripts/launch.js`/`src/update.js` are
  not even in the bundle; fixes reach the app only via a new build. Never
  set Electron's `runAsNode: false` fuse — the engine spawn depends on
  `ELECTRON_RUN_AS_NODE`. Keep `build.files` an allowlist and let
  `scripts/verify-build.js` prove nothing private shipped.
- **Every `/api` route inherits the token middleware** — never register a
  route above it in `server.js`, and never add to `TOKEN_EXEMPT` without a
  reason as strong as the two it has. New probes/tools use `/api/ping` for
  discovery and the token (from `engine.local.json`) for everything else.
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

## Status & outstanding (as of 2026-08-25, v1.9.0)

**Live-proven**: link, connect (self-healing against WA Web's mid-launch
build swaps), repeated test-sends, a **full campaign run to real contacts**,
and a **real scheduled send fired by launchd with the app closed** (both
confirmed by the user 2026-08-25). The ship gate is satisfied. v1.9.0's
packaged `WhatsThat.app` was verified live the same day: Finder launch,
session restored from Application Support without a QR, test-send-to-self,
clean quit (no Chrome/engine survivors, lock + occupancy file removed), and
the Chromium download path against a blank data dir.

Mac-app roadmap (Electron plan approved 2026-07-26; Phase A shipped v1.6.0,
native design system v1.7.0, **Phase B split into three increments**):
- **v1.9.0 (shipped)**: electron-builder packaging, data in Application
  Support + one-time migration, Chromium via @puppeteer/browsers, engine
  pinned per release, app icon. Unsigned personal build.
- **v1.10.0 (shipped 2026-08-25)**: resident-scheduling resilience (see the
  feature map). Live-verified on the packaged app: login item enrolled
  (`enabled`, no approval prompt on this Mac), `--hidden` launch has no
  window, launchd fallback plist installed pointing at the .app binary and
  loaded, engine auto-respawn (dev). **Not yet exercised live**: a real
  WhatsApp drop/reconnect, the liveness probe catching a dead page, the
  quit-guard dialog, notifications, and a login-time hidden launch (needs
  the user to log out/in and glance at `shell/shell.log`).
- **v1.11.0 (shipped 2026-08-25)**: API hardening, engine log, CSV-first
  contacts, Data & reports card, report reveal, `@googleapis/sheets`, docs.
  Phase B is complete. No consent screen (deferred to Phase C).
- **Phase C (v2.0.0)**: signing/notarization (needs Adam's Apple Developer
  ID — his call), electron-updater, LICENSE (still undecided — README says
  "all rights reserved until then"). GitHub Releases with a DMG exist since
  v1.13.0 (`gh release create v<x> dist/*.dmg dist/*.zip`).

Outstanding / watchlist:
- **Upstream release watch**: when whatsapp-web.js ships > 1.34.7, the
  terminal-mode auto-updater installs it and retires our patch to
  `patches-retired/`. If sends then break, follow "Auto-update recovery"
  above. The packaged app is unaffected until rebuilt (engine pinned). Track
  the LID/PN work upstream (PRs #201839/#201850/#201853, issues #201849/#201857).
- **Auto-updater's real-install path** has only run against fakes.
- **Watchdog relaunch / auto-reconnect / liveness probe** have never fired
  against a real wedge or drop. The launchd agent IS now installed on this
  Mac (packaged spec) and ticks every 2 min.
- The repo checkout still holds the pre-migration copies of `.wwebjs_auth/`,
  `draft.local.json`, `google.local.json`, `reports/` (left in place by
  design). Safe to delete once the user is happy with the app.
- Never clarified: the user once asked for autocomplete "as well as a…" —
  the second half never arrived; ask if it comes up.
- Deferred idea: import contacts from the Google Workspace Directory
  (People API `people.listDirectoryPeople`, `directory.readonly`) — needs
  admin-enabled sharing; directory profiles often lack mobile numbers.

## Author's setup (context)

- Google consent screen is on a Workspace account (Internal — tokens never
  expire); contact sheet "WhatsThat Contacts" (`<your-spreadsheet-id>`),
  tab `Contacts`, columns `firstName lastName nickname phone email rank
  Status`; `rank` and `Status` are dropdown columns that drive the send
  rules. ~30–40 recipients, 6–8 campaigns a year.
- **This repo is public** (github.com/adamdexter/whatsthat, since
  2026-08-25). Never commit contact data, sheet ids, tokens, sessions or
  reports — `*.local.json`, `.wwebjs_auth/`, `reports/`, `logs/` are
  gitignored, and `scripts/create-sheet.js` reads contacts from a CSV
  argument (an early version hard-coded them; history was rewritten before
  publishing). Re-run the audit before every push:
  `git log --all -p | grep -E "[0-9]{3}-[0-9]{3}-[0-9]{4}|@[a-z]+\\.(org|com)"`
  should show only `555` test numbers and the author/npm emails.
