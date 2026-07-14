# WhatsThat — project conventions

## Versioning (required on every user-facing change)

- Single source of truth: `version` in `package.json`. The server exposes it
  via `/api/state`, the UI shows it in the header, and boot logs print it.
- Semver: **minor** bump for features, **patch** for fixes. Bump in the same
  commit as the change.
- Tag every version bump: `git tag v<X.Y.Z>` after committing.

## Testing

- `npm test` — unit + e2e (server boots in mock mode; no real WhatsApp/Google).
- Mock mode: `WHATSTHAT_MOCK=1` (numbers ending 99 = not on WhatsApp, 98 = send fails).
- Frontend changes: verify in-browser against a mock server on a spare port
  (e.g. `PORT=3852`) — never against the user's live instance on 3847.

## Local data (all gitignored, never commit)

`.wwebjs_auth/` (WhatsApp session), `google.local.json` (OAuth), `draft.local.json`,
`schedule.local.json`, `reports/`.

## Architecture notes

- The app's Google token is **read-only** (`spreadsheets.readonly`) by design.
  Anything that writes to Sheets lives in `scripts/` with its own token file.
- Only ONE process may use the WhatsApp session at a time (Chromium profile
  lock) — the scheduled-send runner must check the app isn't running before
  booting its own client.
