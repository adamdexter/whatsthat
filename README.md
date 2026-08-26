# WhatsThat 💬

**Personal WhatsApp messages, at the scale of a real personal network.**

Some messages shouldn't come from a marketing platform. When you're inviting
thirty or forty people you actually know to dinner, a talk, or a round of
golf, a broadcast blast from a business account is the wrong tone — and
pasting the same message into WhatsApp forty times, changing the name each
time, is an evening you won't get back (and one wrong paste away from sending
"Hey Mike!" to Sarah).

WhatsThat is the middle path. It sends **individually personalized 1:1
WhatsApp messages from your own number** — each one rendered from a template
with the recipient's own name and details, delivered one at a time with
natural pauses, exactly as if you'd typed them yourself. Your contact list
stays in a private Google Sheet you control. Everything runs **locally on
your Mac**: no service, no server, no third party ever sees your contacts or
your messages.

It was built for a simple, recurring need — a personal outreach list touched
a handful of times a year — and it optimizes for trust over volume: test on
yourself before anyone else gets a message, refuse to send anything with a
broken variable, keep a written report of exactly what happened.

## What it does

- **Contacts from a private Google Sheet** (read-only access) or pasted
  CSV/spreadsheet cells.
- **Templates with `{{variables}}`** filled per person, with autocomplete and
  a live per-contact preview that renders WhatsApp formatting (*bold*,
  _italic_, ~strikethrough~, `code`) the way the recipient will see it.
- **Send rules**: columns like `rank` or `Status` become one-click filters;
  fine-tune with per-person checkboxes and an Inverse-selection button.
- **Test on yourself first**, then send with live progress and a saved
  per-contact report.
- **Schedule for later** — fires even with the app closed (the Mac just has
  to be on).
- **Remembers where you left off** — message, contact list, and exact
  selection survive restarts.
- **Keeps itself working** — checks for library updates at every launch and
  recovers automatically from WhatsApp Web's frequent silent changes.

## Quick start

**As a Mac app** (recommended):

```bash
npm install
npm run dist                                   # builds dist/mac-arm64/WhatsThat.app
ditto dist/mac-arm64/WhatsThat.app /Applications/
open -a WhatsThat                              # or double-click it in Applications
```

It is an unsigned personal build: an app you built on this Mac opens
normally; one copied from elsewhere gets blocked once — allow it under
System Settings → Privacy & Security → "Open Anyway" (or
`xattr -dr com.apple.quarantine /Applications/WhatsThat.app`).
Coming from an older checkout? `npm run migrate-data` copies your linked
session, draft, Google token and reports into
`~/Library/Application Support/WhatsThat` first (copy only — nothing is
deleted), so the app connects without a new QR scan.

**From the terminal** (same engine, opens in your browser):

```bash
npm start            # opens http://localhost:3847
npm start --fresh    # same, but start blank instead of restoring last session
```

The first launch downloads a private Chrome build (~160 MB, one-time) used
only for the WhatsApp connection — the app shows a progress bar while it
does. The app opens on Setup until WhatsApp is linked,
then lives in two tabs — **Contacts** (who) and **Message** (what + send) —
with connection status always visible in the toolbar; the gear (or clicking
the WhatsApp capsule) reopens Setup anytime.

## One-time setup

### 1. Link WhatsApp

Scan the QR code shown in the app: phone → **Settings → Linked Devices →
Link a Device**. This is the same mechanism as WhatsApp Web in a browser —
messages come from *your* number. The session is saved locally in
`.wwebjs_auth/` so future launches connect automatically.

### 2. Connect Google Sheets

The app walks you through creating OAuth credentials (~10 minutes, one time).
The app asks for **read-only** Sheets access — it can never modify your data.

Notes:
- **Google Workspace** accounts: choose an *Internal* consent screen — the
  connection never expires.
- Personal Gmail: an *External* consent screen in *Testing* mode works, but
  Google expires it every 7 days (reconnecting is one click).

### 3. Your contact sheet

Row 1 is headers and must include a `phone` column. Every other column
automatically becomes a template variable:

| firstName | lastName | nickname | phone        | rank | Status |
|-----------|----------|----------|--------------|------|--------|
| Ada       | Lovelace | Ada      | 415-555-0134 | FC   | Active |

- Bare 10-digit numbers are treated as US (`+1`); international numbers need
  their country code with a leading `+`.
- A row without a valid phone number is shown, but excluded from sending.
- `node scripts/create-sheet.js` can build a ready-made, formatted contact
  sheet for you (asks separately for one-time write access; the app itself
  stays read-only).

## Sending a campaign

1. **Load contacts** — paste your Sheet URL and click *Load from Sheet* (or
   expand the CSV option and paste cells straight from any spreadsheet).
2. **Choose recipients** — columns with a few repeating values (like `rank`,
   `Status`) appear as **Send rules**: toggle the values you want and the
   matching people are selected. Fine-tune with the checkboxes, *select all*,
   or **Inverse selection** (flips every checkbox — handy for "everyone
   except these few").
3. **Write the message** — type `{` for variable autocomplete, or click a
   `{{chip}}`. WhatsApp formatting works: `*bold*`, `_italic_`,
   `~strikethrough~`, `` `code` ``. The preview below renders it exactly as
   the recipient's phone will, for any contact you pick.
4. **Send a test to yourself** — the fully rendered message arrives in your
   own WhatsApp ("message yourself" chat). Iterate until it feels right.
5. **Send** — confirm the recipient count and go. Messages go out one at a
   time with randomized 4–10 s pauses (configurable), with live per-person
   progress. Walk away if you like: a full report lands in
   `reports/run-<timestamp>.json`.

### Safety rails you can rely on

- A contact with an **empty or missing variable value is failed, never sent
  a broken message** — the UI warns you before the run and offers to
  deselect them.
- Numbers not registered on WhatsApp are reported as failures, not
  silently skipped.
- A send that WhatsApp doesn't positively confirm is reported as an
  **error** — the app never shows a ✓ it can't stand behind.
- Reports are written incrementally, so even a crash mid-run leaves an
  accurate record.

## Scheduling

**Schedule for later…** snapshots the current recipients and message and
sends at the chosen time — the app and terminal can be closed. The first
schedule installs a small macOS background agent
(`net.whatsthat.scheduler`, checks every 2 minutes).

- The Mac must be **on** at send time. Asleep past the send time? It fires
  on wake — unless it's more than **6 hours** late, in which case it's
  marked *missed* (a stale "see you tonight!" never goes out a day later).
- If the app is open at the time, it sends with live progress instead.
- Pending sends show a countdown and Cancel in the UI; background activity
  logs to `scheduler.log`.
- Remove the agent anytime:
  `launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/net.whatsthat.scheduler.plist`

## Between sessions

- **Everything is restored on relaunch** — message, loaded contacts, and
  your exact selection ("Restored from your last session" appears above the
  contact list). Start clean instead with `npm start --fresh`; the previous
  draft is kept as `draft.backup.local.json`, so nothing is lost.
- **Auto-update**: every `npm start` checks for a newer version of the
  WhatsApp library and installs it before the app boots (WhatsApp Web
  changes constantly; staying current is the best defense). A banner in the
  app tells you when this happened. Skip with `WHATSTHAT_NO_UPDATE=1`.

## When something goes wrong

- **"Another process is already using port 3847"** — WhatsThat is already
  running (or a stuck leftover is). The message includes the exact command
  to clear it. Only one instance can use the WhatsApp session at a time.
- **Startup stalls on "Authenticating…"** — usually WhatsApp shipping a new
  Web build mid-launch. The app now detects the stall within ~2 minutes and
  relaunches its browser automatically; if it stalls twice you'll get a
  visible error with next steps rather than an endless spinner.
- **"Disconnected"** — restart the app (`npm start`). If WhatsApp shows the
  QR again, your linked-device session expired: re-scan once.
- **Send failures right after an update** — WhatsApp Web changes can break
  the automation library until a fix ships; the app carries local
  compatibility patches and updates itself at launch. If a campaign
  suddenly fails wholesale, wait for/check a library update and retry.

## Your data

Everything lives in the project folder, all gitignored:

| Path                       | Contents                                       |
|----------------------------|------------------------------------------------|
| `.wwebjs_auth/`            | WhatsApp session — **treat like a password**   |
| `google.local.json`        | Google OAuth credentials + read-only token     |
| `draft.local.json`         | Message, sheet URL, selection, contact cache   |
| `draft.backup.local.json`  | Previous draft, set aside by a `--fresh` start |
| `schedule.local.json`      | Scheduled sends and their status               |
| `update.local.json`        | What the launch-time auto-updater did          |
| `reports/`                 | Per-run send reports                           |
| `scheduler.log`            | Background scheduler output                    |

Nothing ever leaves your machine except the WhatsApp messages themselves and
read-only Google Sheets API calls.

## Honest limitations

- **Unofficial automation.** This drives WhatsApp Web via
  [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js), which
  is not sanctioned by Meta. At this volume — dozens of messages a few times
  a year, to people who know you and want to hear from you — the practical
  risk is low, but it is not zero. Don't use this for spam; beyond the
  ethics, that *is* how numbers get banned.
- WhatsApp Web changes frequently and can break the library until a fix
  ships (the auto-updater + bundled patches exist precisely for this).
- Scheduled sends need the Mac powered on — linked-device sending cannot
  work with the machine off.

## Run it as a Mac app

`WhatsThat.app` (built by `npm run dist`, see Quick start) is the same
engine in a real, frameless macOS window — traffic lights inset into the
toolbar, native-style controls, automatic light/dark mode — with WhatsApp
status and pending scheduled sends visible from the menu-bar icon.
Closing the window keeps the engine (and scheduled sends) running; Cmd+Q
quits fully. If a terminal-started instance is already running, the app
attaches to it rather than starting a second one — and leaves it running
when you quit.

The app keeps everything in `~/Library/Application Support/WhatsThat` (see
"Your data"); the library it drives is fixed per build, so updating means
rebuilding. `npm run app` runs the same shell from the checkout for
development, against the same data folder.

It is built to live in the menu bar: it starts at login (hidden — use the
menu-bar icon → Open WhatsThat, or toggle *Start at Login* there), keeps the
WhatsApp session warm so scheduled sends go out in seconds, reconnects by
itself when WhatsApp drops the session (and tells you when it needs a QR
scan), restarts its own engine if that ever crashes, and asks before
quitting while sends are pending. A scheduled send that comes due while
WhatsApp is down simply waits ("waiting for WhatsApp") and fires the moment
the link is back — within the usual 6-hour window. If you quit anyway, the
background scheduler (launchd, installed on your first scheduled send)
still runs the sends with its own session; *Remove Background Scheduler* in
the menu-bar menu turns that off.

## Development

```bash
npm test         # 114 unit + end-to-end tests (mock mode; no real sends)
npm run mock     # run the app against a fake WhatsApp client
```

Mock-mode rules: numbers ending `99` are "not on WhatsApp"; numbers ending
`98` fail on send. See `CLAUDE.md` for project conventions, architecture
invariants, and the full change history.
