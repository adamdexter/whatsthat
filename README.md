# WhatsThat 💬

[![CI](https://github.com/adamdexter/whatsthat/actions/workflows/ci.yml/badge.svg)](https://github.com/adamdexter/whatsthat/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/adamdexter/whatsthat?include_prereleases&label=release)](https://github.com/adamdexter/whatsthat/releases/latest)

**Personal WhatsApp messages, at the scale of a real personal network — from a Mac app that runs entirely on your machine.**

> **Status: alpha/beta.** It works end-to-end and is in daily use by its author,
> but it is young, macOS-only, unsigned, and built on unofficial WhatsApp
> automation. Read [Honest limitations](#honest-limitations) before you rely on it.

Some messages shouldn't come from a marketing platform. When you're inviting
thirty or forty people you actually know to dinner, a talk, or a round of
golf, a broadcast from a business account is the wrong tone — and pasting the
same message into WhatsApp forty times, changing the name each time, is an
evening you won't get back (and one wrong paste away from sending
"Hey Mike!" to Sarah).

WhatsThat is the middle path. It sends **individually personalized 1:1
WhatsApp messages from your own number** — each one rendered from a template
with the recipient's own name and details, delivered one at a time with
natural pauses, exactly as if you'd typed them yourself. Your contact list
stays in a spreadsheet you control. Everything runs **locally on your Mac**:
no service, no server, no third party ever sees your contacts or messages.

It was built for a simple, recurring need — a personal outreach list touched a
handful of times a year — and it optimizes for trust over volume: test on
yourself before anyone else gets a message, refuse to send anything with a
broken variable, keep a written report of exactly what happened.

## What it does

- **Contacts from pasted spreadsheet cells / CSV**, or from a private Google
  Sheet (read-only access).
- **Templates with `{{variables}}`** filled per person, with autocomplete and
  a live per-contact preview that renders WhatsApp formatting (*bold*,
  _italic_, ~strikethrough~, `code`) the way the recipient sees it.
- **Send rules from your own columns**: whatever categories your sheet has
  (`rank`, `Status`, `city`, `group`…) become one-click filters. The app
  works out which columns are categories from the data — scaled to your list
  size — and asks about the borderline ones once; fine-tune with per-person
  checkboxes and an Inverse-selection button.
- **Test on yourself first**, then send with live progress and a saved
  per-contact report you can filter by sent/failed.
- **Schedule for later** — fires even with the app closed (the Mac has to be on).
- **Lives in the menu bar**: starts at login, keeps the WhatsApp session
  warm, reconnects by itself when WhatsApp drops it, and tells you when it
  needs a QR scan.
- **Remembers where you left off** — message, contact list, and exact
  selection survive restarts.
- **Side by side on wide screens** — a toolbar toggle shows Contacts and
  Message next to each other instead of as tabs.

## Install

**Requirements:** macOS 13 or newer on Apple Silicon (arm64), a WhatsApp
account on your phone, ~600 MB of disk (the app plus a private Chrome build
it downloads once).

### Option A — download the app

1. Grab `WhatsThat-<version>-arm64.dmg` from the
   [latest release](https://github.com/adamdexter/whatsthat/releases/latest),
   open it, drag **WhatsThat** to Applications.
2. It is **not code-signed** (no Apple Developer certificate yet), so macOS
   blocks the first launch. Open it once anyway: **System Settings → Privacy
   & Security → "Open Anyway"**, or from a terminal:
   `xattr -dr com.apple.quarantine /Applications/WhatsThat.app`.
3. Launch it. On first run it downloads the private Chrome build WhatsApp
   Web runs in (progress bar, ~160 MB, once), then shows the WhatsApp QR.

### Option B — build it yourself

```bash
git clone https://github.com/adamdexter/whatsthat.git
cd whatsthat
npm install
npm run dist                      # → dist/WhatsThat-<version>-arm64.dmg (and .zip)
```

An app you built on your own Mac opens without the Gatekeeper step.

### Option C — run from the terminal (no app)

```bash
npm install
npm start                         # opens http://localhost:3847 in your browser
```

Same engine, same data folder, no menu-bar app.

## One-time setup

### 1. Link WhatsApp

Scan the QR code shown in the app: phone → **Settings → Linked Devices →
Link a Device**. This is the same mechanism as WhatsApp Web in a browser —
messages come from *your* number. The session is saved locally so future
launches connect automatically.

### 2. Contacts

The quickest way needs no setup: copy cells from any spreadsheet (Numbers,
Excel, Google Sheets) and paste them into the **Contacts** tab. Row 1 is
headers and must include a `phone` column; every other column becomes a
template variable:

| firstName | lastName | nickname | phone        | rank | Status |
|-----------|----------|----------|--------------|------|--------|
| Ada       | Lovelace | Ada      | 415-555-0134 | FC   | Active |

- Bare 10-digit numbers are treated as US (`+1`); international numbers
  need their country code with a leading `+`.
- A row without a valid phone number is shown but excluded from sending.
- Want to try it before touching your own list? The [`examples/`](examples/)
  folder has five fictional lists (dinner party, team offsite, alumni
  reunion, golf day, a general one) on reserved `555` numbers — nobody
  real can receive anything — each with notes on what the app makes of its
  columns.

**Google Sheets (optional).** If you'd rather load straight from a private
Sheet, Setup (gear) → Google walks you through creating OAuth credentials
(~10 minutes, once). The app asks for **read-only** access — it can never
modify your sheet.
- Google Workspace accounts: choose an *Internal* consent screen — the
  connection never expires.
- Personal Gmail: an *External* consent screen in *Testing* mode works, but
  Google expires it every 7 days (reconnecting is one click).
- `node scripts/create-sheet.js contacts.csv` builds a formatted sheet
  (frozen bold header, dropdowns for columns like `Status`) from a CSV. It
  asks separately for one-time write access; the app itself stays read-only.

## Custom fields & send rules

WhatsThat has no fixed schema beyond `phone`. Whatever columns your
spreadsheet has are yours to use, in two ways at once:

**Every column is a variable.** `department` becomes `{{department}}`,
`Home Course` becomes `{{Home Course}}` — names are matched
case-insensitively and typing `{` in the message offers all of them. The app
is strict on purpose: if a contact's value for a variable is empty, that
contact is **failed rather than sent a message with a hole in it** (the
preview warns you first, and offers to deselect them).

**Columns whose values repeat become send rules.** A rule is a row of chips
above the contact list — one per value — and toggling chips reselects the
matching people. Which columns qualify is decided from your data, scaled to
the size of the list:

| Distinct values in the column | What happens |
|---|---|
| ≤ **max(4, 10 % of contacts)** | Becomes a send rule automatically |
| ≤ **max(8, 25 % of contacts)**, and still repeating | The app **asks once** whether it's a rule or a per-contact field |
| More than that, or unique per person, or the same for everyone | Stays a plain field |

So with 50 contacts a column with up to 5 values is a rule on sight, one
with 6–13 values gets a question, and one with 14+ (or a value per person)
is a field. With 14 contacts the floors apply: up to 4 automatic, up to 8
asked. Blank cells count as their own chip — `attending` that's either
`Yes` or empty gives you a *(blank)* rule for "hasn't replied yet".

The question looks like this, once per column, and the answer is remembered
in your draft:

> **city** has 6 different values across 14 people — is it a way to *choose
> who gets a message*, or just information about each person?
> [Send rule] [Per-contact field]

*columns…* next to "Send rules" opens a panel listing every column with its
current role and why (*4 values · few repeating values*, *14 values · unique
per person*, *your choice*), a Send rule / Field switch for each, and *Reset
to automatic*. Use it to force a 14-value column into a rule, or to keep a
column like `manager` as text only.

A worked example — a 20-person team roster:

| firstName | phone | office | department | tshirtSize | manager | attending |
|---|---|---|---|---|---|---|
| Elena | 415-555-0108 | Lisbon | Engineering | S | Maya Okafor | |
| Kwame | 415-555-0109 | Berlin | Design | XL | Theo Lindqvist | Yes |

- `office` (4 values) and `tshirtSize` (4) → rules, automatically.
- `attending` → rule: *Yes* / *(blank)*.
- `department` (6) and `manager` (7) → asked. You'd say **rule** for
  department and **field** for manager.
- Message: *"{{firstName}}, we still need your RSVP for the offsite — reply
  today? {{manager}} has the details."* sent to `attending = (blank)`.

That file is [`examples/team-offsite.csv`](examples/team-offsite.csv); the
other scenarios in [`examples/README.md`](examples/README.md) show the same
rules at 8, 12, 14 and 40 people.

## Sending a campaign

1. **Load contacts** — paste cells, or load your Sheet.
2. **Choose recipients** — columns whose values repeat across people (like
   `rank`, `Status`, `city`) appear as **Send rules**: toggle the values you
   want and the matching people are selected. A column with up to 10 % as
   many distinct values as you have contacts (at least 4) is a rule
   automatically; one with up to 25 % (at least 8) gets a one-time question
   — *send rule, or per-contact field?* — and your answer is remembered.
   *columns…* lets you change any column's role later. Fine-tune with the
   checkboxes, *select all*, or **Inverse selection** ("everyone except
   these few"); **Hide unselected** collapses the table to just the people
   who'll get the message (the count line says how many are hidden).
3. **Write the message** — type `{` for variable autocomplete, or click a
   `{{chip}}`. WhatsApp formatting works: `*bold*`, `_italic_`,
   `~strikethrough~`, `` `code` ``. The preview renders exactly what the
   recipient's phone will show, for any contact you pick.
4. **Send a test to yourself** — the fully rendered message arrives in your
   own WhatsApp ("message yourself" chat). Iterate until it feels right.
5. **Send** — confirm the count and go. Messages go out one at a time with
   randomized 4–10 s pauses (configurable), with live per-person progress.
   Walk away if you like: a full report is saved, and the sent/failed
   counts under the list toggle which rows you see.

### Safety rails you can rely on

- A contact with an **empty or missing variable value is failed, never sent
  a broken message** — the UI warns you before the run and offers to
  deselect them.
- Numbers not registered on WhatsApp are reported as failures, not silently
  skipped.
- A send that WhatsApp doesn't positively confirm is reported as an
  **error** — the app never shows a ✓ it can't stand behind.
- Reports are written incrementally, so even a crash mid-run leaves an
  accurate record.

## Scheduling

**Schedule for later…** snapshots the current recipients and message and
sends at the chosen time.

- With the app in the menu bar, the send goes out from its warm session in
  seconds. If WhatsApp happens to be down at that moment it simply waits
  ("waiting for WhatsApp") and fires when the link is back.
- If you quit the app, a small macOS background agent
  (`net.whatsthat.scheduler`, installed on your first schedule) runs the
  send with its own session. *Remove Background Scheduler* in the menu-bar
  menu turns that off.
- The Mac must be **on**. Asleep past the send time? It fires on wake —
  unless it's more than **6 hours** late, in which case it's marked *missed*
  (a stale "see you tonight!" never goes out a day later).

## Your data & privacy

Everything stays on this Mac, in `~/Library/Application Support/WhatsThat`:

| File / folder              | Contents                                                       |
|----------------------------|----------------------------------------------------------------|
| `.wwebjs_auth/`            | WhatsApp session — **treat like a password**                   |
| `google.local.json`        | Google OAuth client + **read-only** token (only if you connect Google) |
| `draft.local.json`         | Your message, sheet URL, delays, send rules, loaded contacts, selection |
| `schedule.local.json`      | Scheduled campaigns and what happened to them                  |
| `reports/`                 | One JSON report per send (`run-<timestamp>.json`)             |
| `chromium/`                | The private Chrome build WhatsApp Web runs in                  |
| `logs/`                    | `engine.log`, `shell.log`, `scheduler.log` (rotated)          |
| `shell/`                   | The app window's own browser profile                           |

Setup (gear) → *Data & reports* reveals the reports and logs folders and has
*Start fresh…* to set the draft aside without touching the WhatsApp or
Google connections.

The app talks to a local web engine on `127.0.0.1`; that API is protected by
a per-launch token and a Host/Origin allowlist, so a web page you happen to
have open cannot read your contacts or send messages through it. No
telemetry, no network calls except WhatsApp Web itself, Google (only if you
connect it), and the one-time Chrome download.

## Honest limitations

- **Unofficial automation.** This drives WhatsApp Web via
  [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js), which is
  not sanctioned by Meta. At this volume — dozens of messages a few times a
  year, to people who know you and want to hear from you — the practical
  risk is low, but it is not zero. **Don't use this for spam**; beyond the
  ethics, that *is* how numbers get banned.
- WhatsApp Web changes frequently and can break the library until a fix
  ships. The app carries compatibility patches, self-heals from the common
  mid-launch breakages, and reconnects on its own — but a new breaking
  change can still stop sends until a new release.
- macOS on Apple Silicon only, unsigned (see Install). Intel Macs and
  Windows/Linux are not supported.
- Scheduled sends need the Mac powered on — linked-device sending cannot work
  with the machine off.

## When something goes wrong

- **Startup stalls on "Authenticating…"** — usually WhatsApp shipping a new
  Web build mid-launch. The app detects the stall and relaunches its browser;
  if it keeps failing you get a visible error with next steps.
- **"Disconnected" / "Scan QR"** — the app reconnects by itself for ordinary
  drops. If it asks for a QR, your linked-device session was ended (from the
  phone, or by WhatsApp): scan once.
- **Send failures right after WhatsApp changed something** — wait for a new
  WhatsThat release; the engine inside the app is pinned per release so an
  upstream fix reaches you as a new download.
- Logs: menu-bar icon → *Show Logs*.

## Development

```bash
npm test         # unit + end-to-end tests (mock WhatsApp, no real sends)
npm run mock     # run the engine against a fake WhatsApp client
npm run app      # the Mac app shell from the checkout (dev mode)
npm run dist     # build the .dmg/.zip
```

Mock-mode rules: numbers ending `99` are "not on WhatsApp"; numbers ending
`98` fail on send (`examples/contacts-sample.csv` includes one of each).
`CLAUDE.md` holds the project conventions, architecture invariants, and the
full change history.

CI runs the full test suite on every push and pull request (macOS runner,
mock mode). Pushing a `v*` tag builds the app on GitHub's runners and
attaches the `.dmg`/`.zip` to that tag's release.

## License

Not yet decided — until a license file is added, all rights are reserved by
the author. Issues and pull requests are welcome in the meantime.
