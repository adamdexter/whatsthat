# WhatsThat 💬

Send personalized 1:1 WhatsApp messages to a list of people — from **your own
number**, fully automated, with a per-contact success/failure report.

Contacts come from a **Google Sheet** (or pasted CSV). Messages are written
once with `{{variables}}` that are filled in per person.

Everything runs **locally on your Mac**. No third-party service ever sees your
contacts or messages.

## Quick start

```bash
npm install
npm start        # opens http://localhost:3847
```

Then follow the numbered steps in the UI:

1. **WhatsApp** — scan the QR code once (phone → Settings → Linked Devices →
   Link a Device). The session is saved in `.wwebjs_auth/` for future runs.
2. **Google** — one-time OAuth setup (instructions are in the UI card).
3. **Contacts** — paste your Google Sheet URL and load.
4. **Message** — write your template; click a `{{chip}}` to insert a variable.
5. **Send** — "Send test to me" delivers a rendered preview to your own
   WhatsApp; then hit Send and walk away.

## The sheet format

Row 1 is the header row and must include a `phone` column. Every other column
becomes a template variable, matched case-insensitively:

| firstName | lastName | nickname | phone        | favoriteTeam |
|-----------|----------|----------|--------------|--------------|
| Ada       | Lovelace | Ada      | 415-555-0134 | Analytical FC|

Template:

```
Hey {{nickname}}! It's Adam — go {{favoriteTeam}}! 🎉
```

Phone numbers: bare 10-digit numbers are treated as US (`+1`). International
numbers must include their country code with a leading `+`.

## Safety rails

- A contact whose template variable is **empty** (or references a missing
  column) is **failed, not sent** a broken message. The UI warns before you run.
- Numbers are checked for WhatsApp registration before sending; unregistered
  numbers show up as failures in the report.
- Randomized 4–10s delays between sends (configurable) keep the sending
  pattern human-like.
- Reports are saved to `reports/run-<timestamp>.json`.

## Good to know

- **Unofficial automation.** This drives WhatsApp Web via
  [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js), which is
  not sanctioned by Meta. At this volume (dozens of messages a few times a
  year, to people who know you) the risk is low, but it is not zero.
- **Google consent screen**: if your OAuth consent screen is *External* and in
  *Testing* mode, Google expires the connection every 7 days — you'll just
  need to click Connect again. *Internal* (Google Workspace) never expires.
- First launch downloads a Chromium build for the WhatsApp client (~1 min).
- If WhatsApp shows "Disconnected", restart the app (`npm start`).

## Development

```bash
npm test         # unit + end-to-end tests (server runs in mock mode)
npm run mock     # run the app with a fake WhatsApp client (no real sends)
```

Mock-mode rules: numbers ending `99` are "not on WhatsApp"; numbers ending
`98` fail on send.

## Local data (all gitignored)

| Path                | Contents                                  |
|---------------------|-------------------------------------------|
| `.wwebjs_auth/`     | WhatsApp session — treat like a password  |
| `google.local.json` | Google OAuth credentials + tokens         |
| `draft.local.json`  | Your saved template / sheet URL / delays  |
| `reports/`          | Per-run send reports                      |
