'use strict';

const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const express = require('express');

const { JsonStore } = require('./src/store');
const { createSheets, extractSpreadsheetId } = require('./src/sheets');
const { buildContacts } = require('./src/contacts');
const { parseCsv } = require('./src/csv');
const { render } = require('./src/template');
const { createRunner } = require('./src/runner');
const { createWhatsApp } = require('./src/whatsapp');
const { createScheduleStore, isAgentInstalled, installAgent } = require('./src/schedule');

const VERSION = require('./package.json').version;
// PORT=0 asks the OS for an ephemeral port (the app shell does this in
// packaged mode); the actual port is announced on stdout at listen time.
const PORT = Number(process.env.PORT ?? 3847);
const MOCK = process.env.WHATSTHAT_MOCK === '1';
// Running inside the packaged Mac app: the shell owns opening windows,
// scheduling (app-resident tick), and engine updates (per-release pinning).
const PACKAGED = process.env.WHATSTHAT_PACKAGED === '1';
const NO_OPEN = process.env.WHATSTHAT_NO_OPEN === '1' || PACKAGED;
const ROOT = __dirname;
const DATA_DIR = process.env.WHATSTHAT_DATA_DIR || ROOT; // overridable for tests
const REPORTS_DIR = path.join(DATA_DIR, 'reports');

const NO_AGENT = process.env.WHATSTHAT_NO_AGENT === '1' || MOCK || PACKAGED; // tests/mock/app skip launchctl

// --fresh: boot without the previous session's draft (message, loaded
// contacts, selection). `npm start --fresh` reaches us as npm_config_fresh;
// `npm start -- --fresh` and `node server.js --fresh` as argv. The draft is
// set aside, not deleted, so one fresh boot is recoverable.
const FRESH = process.argv.includes('--fresh') || process.env.npm_config_fresh === 'true';
const DRAFT_FILE = path.join(DATA_DIR, 'draft.local.json');
if (FRESH && fs.existsSync(DRAFT_FILE)) {
  fs.renameSync(DRAFT_FILE, path.join(DATA_DIR, 'draft.backup.local.json'));
  console.log('Fresh start: previous draft set aside as draft.backup.local.json');
}

const googleStore = new JsonStore(path.join(DATA_DIR, 'google.local.json'));
const draftStore = new JsonStore(DRAFT_FILE);
const updateStore = new JsonStore(path.join(DATA_DIR, 'update.local.json'));
const scheduleStore = createScheduleStore(path.join(DATA_DIR, 'schedule.local.json'));

// Constructed at listen time: with PORT=0 the real port (needed for the
// OAuth redirect URI and the origin allowlist) is only known then. Requests
// can't arrive before the 'listening' callback runs, so routes are safe to
// reference this.
let sheetsApi;
const wa = createWhatsApp({ mock: MOCK, dataDir: DATA_DIR });
const runner = createRunner({ wa, reportsDir: REPORTS_DIR });

const app = express();
app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(ROOT, 'public')));

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Reject state-changing requests from other origins (a malicious web page
// could otherwise fire POSTs at localhost). GET navigations (OAuth callback)
// don't carry an Origin header, and same-origin fetches match.
const ALLOWED_ORIGINS = new Set(); // populated at listen time (PORT=0 support)
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && req.headers.origin && !ALLOWED_ORIGINS.has(req.headers.origin)) {
    return res.status(403).json({ error: 'Cross-origin requests are not allowed' });
  }
  next();
});

// ---------- Server-sent events ----------
const sseClients = new Set();
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(payload);
}

app.get('/api/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  res.write(`event: wa_state\ndata: ${JSON.stringify(wa.getState())}\n\n`);
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

wa.onUpdate((state) => broadcast('wa_state', state));

// ---------- App state ----------
let lastRun = null; // most recent run_done event, for UI recovery after an SSE drop

app.get('/api/state', (req, res) => {
  res.json({
    version: VERSION,
    mock: MOCK,
    packaged: PACKAGED,
    wa: wa.getState(),
    google: sheetsApi.status(),
    draft: draftStore.read(),
    running: runner.isRunning(),
    lastRun,
    schedule: scheduleStore.list(),
    agentInstalled: NO_AGENT ? true : isAgentInstalled(),
    update: updateStore.read(),
  });
});

app.post('/api/draft', (req, res) => {
  const allowed = ['template', 'sheetUrl', 'tabName', 'delayMinMs', 'delayMaxMs', 'filters', 'contactsCache', 'selectedIds', 'previewId'];
  const patch = {};
  for (const key of allowed) {
    if (key in (req.body || {})) patch[key] = req.body[key];
  }
  res.json(draftStore.patch(patch));
});

// ---------- Google OAuth + Sheets ----------
app.post('/api/google/credentials', (req, res) => {
  const { clientId, clientSecret } = req.body || {};
  if (!clientId || !clientSecret) return res.status(400).json({ error: 'clientId and clientSecret are required' });
  sheetsApi.setCredentials(clientId, clientSecret);
  res.json(sheetsApi.status());
});

app.get('/api/google/connect', (req, res) => {
  try {
    res.redirect(sheetsApi.authUrl());
  } catch (err) {
    res.status(400).send(err.message);
  }
});

app.get('/api/google/callback', async (req, res) => {
  try {
    if (req.query.error) throw new Error(`Google returned: ${req.query.error}`);
    if (!req.query.code) throw new Error('No authorization code in callback');
    await sheetsApi.handleCallback(String(req.query.code));
    broadcast('google_status', sheetsApi.status());
    res.send('<body style="font-family:sans-serif;padding:40px"><h2>✅ Google connected</h2><p>You can close this tab and return to WhatsThat.</p></body>');
  } catch (err) {
    res.status(400).send(`<body style="font-family:sans-serif;padding:40px"><h2>❌ Google connection failed</h2><p>${escapeHtml(err.message)}</p></body>`);
  }
});

app.post('/api/google/disconnect', (req, res) => {
  sheetsApi.disconnect();
  res.json(sheetsApi.status());
});

// ---------- Contacts ----------
app.post('/api/contacts/sheet', async (req, res) => {
  try {
    const { sheetUrl, tabName } = req.body || {};
    const id = extractSpreadsheetId(sheetUrl);
    if (!id) return res.status(400).json({ error: 'That does not look like a Google Sheets URL or spreadsheet id' });
    const values = await sheetsApi.fetchValues(id, tabName);
    res.json(buildContacts(values));
  } catch (err) {
    const msg = /invalid_grant|No refresh token|not connected/i.test(err.message)
      ? `${err.message} — try reconnecting Google in Settings`
      : err.message;
    res.status(500).json({ error: msg });
  }
});

app.post('/api/contacts/csv', (req, res) => {
  const { csv } = req.body || {};
  if (!csv || !String(csv).trim()) return res.status(400).json({ error: 'CSV text is empty' });
  res.json(buildContacts(parseCsv(csv)));
});

// ---------- Preview & test send ----------
app.post('/api/preview-all', (req, res) => {
  const { template, contacts } = req.body || {};
  if (typeof template !== 'string') return res.status(400).json({ error: 'template is required' });
  const previews = (contacts || []).map((c) => ({ id: c.id, ...render(template, c.fields || {}) }));
  res.json({ previews });
});

app.post('/api/test-send', async (req, res) => {
  try {
    const { template, fields } = req.body || {};
    if (wa.getState().status !== 'ready') return res.status(409).json({ error: 'WhatsApp is not connected yet' });
    const { text, unknown, empty } = render(String(template || ''), fields || {});
    if (unknown.length) return res.status(400).json({ error: `Unknown variable(s): ${unknown.join(', ')}` });
    if (empty.length) return res.status(400).json({ error: `Empty value(s) for: ${empty.join(', ')}` });
    if (!text.trim()) return res.status(400).json({ error: 'Rendered message is empty' });
    await wa.sendToSelf(text);
    res.json({ ok: true, text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Campaign run ----------
app.post('/api/run', (req, res) => {
  const { contacts, template, delayMinMs, delayMaxMs } = req.body || {};
  if (wa.getState().status !== 'ready') return res.status(409).json({ error: 'WhatsApp is not connected yet' });
  if (runner.isRunning()) return res.status(409).json({ error: 'A run is already in progress' });
  if (!Array.isArray(contacts) || contacts.length === 0) return res.status(400).json({ error: 'No contacts selected' });
  if (!template || !String(template).trim()) return res.status(400).json({ error: 'The message template is empty' });

  runner
    .start({
      contacts,
      template,
      delayMinMs: Number(delayMinMs) || 4000,
      delayMaxMs: Number(delayMaxMs) || 10000,
      onProgress: (event) => {
        if (event.type === 'progress') {
          const { contact, ...rest } = event;
          broadcast('run_progress', { ...rest, phone: contact.phone });
        } else if (event.type === 'done') {
          lastRun = event;
          broadcast('run_done', event);
        }
      },
    })
    .catch((err) => broadcast('run_error', { error: err.message }));

  res.json({ started: true, total: contacts.length });
});

app.post('/api/run/cancel', (req, res) => {
  runner.cancel();
  res.json({ cancelling: true });
});

// ---------- Scheduled sends ----------
const broadcastSchedule = () => broadcast('schedule', { schedule: scheduleStore.list() });

app.post('/api/schedule', (req, res) => {
  const { sendAt, contacts, template, delayMinMs, delayMaxMs } = req.body || {};
  const at = Date.parse(sendAt);
  if (!at || Number.isNaN(at)) return res.status(400).json({ error: 'Invalid send time' });
  if (at < Date.now() - 60000) return res.status(400).json({ error: 'Send time is in the past' });
  if (!Array.isArray(contacts) || contacts.length === 0) return res.status(400).json({ error: 'No contacts selected' });
  if (!template || !String(template).trim()) return res.status(400).json({ error: 'The message template is empty' });

  const campaign = scheduleStore.add({
    sendAt: new Date(at).toISOString(),
    contacts,
    template,
    delayMinMs: Number(delayMinMs) || 4000,
    delayMaxMs: Number(delayMaxMs) || 10000,
  });

  // Make sure the background agent exists so this fires with the app closed.
  let agent = { installed: true };
  if (!NO_AGENT) {
    try {
      agent = isAgentInstalled() ? { installed: true } : installAgent({ rootDir: ROOT });
    } catch (err) {
      agent = { installed: false, error: `Background agent install failed: ${err.message}` };
    }
  }

  broadcastSchedule();
  res.json({ campaign, agent });
});

app.post('/api/schedule/cancel', (req, res) => {
  const c = scheduleStore.cancel((req.body || {}).id);
  if (!c) return res.status(404).json({ error: 'Campaign not found or not pending' });
  broadcastSchedule();
  res.json({ campaign: c });
});

// Runs any due campaigns through the app's own WhatsApp session. Called by
// the in-app timer and by the launchd runner when the app is open.
async function executeDue() {
  if (runner.isRunning()) return { ran: false, reason: 'a run is already in progress' };
  if (wa.getState().status !== 'ready') return { ran: false, reason: 'whatsapp not ready' };
  const due = scheduleStore.findDue();
  if (!due.length) return { ran: false, reason: 'nothing due' };

  for (const campaign of due) {
    scheduleStore.patch(campaign.id, { status: 'running', startedAt: new Date().toISOString() });
    broadcastSchedule();
    try {
      const { summary, reportFile } = await runner.start({
        contacts: campaign.contacts,
        template: campaign.template,
        delayMinMs: campaign.delayMinMs,
        delayMaxMs: campaign.delayMaxMs,
        onProgress: (event) => {
          if (event.type === 'progress') {
            const { contact, ...rest } = event;
            broadcast('run_progress', { ...rest, phone: contact.phone });
          } else if (event.type === 'done') {
            lastRun = event;
            broadcast('run_done', event);
          }
        },
      });
      scheduleStore.patch(campaign.id, { status: 'done', finishedAt: new Date().toISOString(), summary, reportFile });
    } catch (err) {
      scheduleStore.patch(campaign.id, { status: 'failed', error: err.message });
    }
    broadcastSchedule();
  }
  return { ran: true, count: due.length };
}

app.post('/api/schedule/run-due', async (req, res) => {
  res.json(await executeDue());
});

const TICK_MS = Number(process.env.WHATSTHAT_TICK_MS) || 30000;
setInterval(() => executeDue().catch(() => {}), TICK_MS);

// ---------- Reports ----------
app.get('/api/reports', (req, res) => {
  let files = [];
  try {
    files = fs
      .readdirSync(REPORTS_DIR)
      .filter((f) => f.startsWith('run-') && f.endsWith('.json'))
      .sort()
      .reverse();
  } catch {
    /* no reports yet */
  }
  res.json({ reports: files });
});

app.get('/api/reports/:file', (req, res) => {
  const file = path.basename(req.params.file); // no traversal
  const full = path.join(REPORTS_DIR, file);
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'Report not found' });
  res.sendFile(full);
});

// ---------- Mock helpers (tests only) ----------
if (MOCK) {
  app.get('/api/mock/sent', (req, res) => res.json({ sent: wa._sent }));
}

// ---------- Boot ----------
// The WhatsApp client starts only after the port is won: only ONE process may
// use the session, and the port is the instance lock. A second launch exits
// here with a pointer to the running (or hung) instance instead of silently
// booting an invisible WhatsApp client with no UI.
const httpServer = app.listen(PORT, '127.0.0.1', () => {
  // On EADDRINUSE the listen callback can still fire (via express's once
  // wrapper on the error path) with address() null — that path belongs to
  // the 'error' handler below.
  const addr = httpServer.address();
  if (!addr) return;
  const actualPort = addr.port;
  ALLOWED_ORIGINS.add(`http://localhost:${actualPort}`);
  ALLOWED_ORIGINS.add(`http://127.0.0.1:${actualPort}`);
  sheetsApi = createSheets({
    store: googleStore,
    redirectUri: `http://localhost:${actualPort}/api/google/callback`,
  });
  // Machine-readable handshake — the Mac app shell parses this line.
  console.log(`whatsthat-listening ${actualPort}`);
  const url = `http://localhost:${actualPort}`;
  console.log(`WhatsThat v${VERSION} ${MOCK ? '(MOCK MODE) ' : ''}running at ${url}`);
  if (process.platform === 'darwin' && !NO_OPEN) execFile('open', [url]);
  wa.initialize();
});

httpServer.on('error', async (err) => {
  if (err.code !== 'EADDRINUSE') {
    console.error(`Server failed to start: ${err.message}`);
    process.exit(1);
  }
  let detail = 'The occupant did not answer like a WhatsThat instance — find it with the lsof command below.';
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/state`, { signal: AbortSignal.timeout(2000) });
    const s = await res.json();
    detail = `It is WhatsThat v${s.version} (WhatsApp: ${s.wa?.status ?? 'unknown'}). Use that instance, or quit it first.`;
  } catch {
    /* keep the generic detail */
  }
  console.error(
    `\n✗ Another process is already using port ${PORT}. ${detail}\n` +
      `  If it is a stuck leftover instance, end it with:\n` +
      `  kill $(lsof -nP -iTCP:${PORT} -sTCP:LISTEN -t)\n`
  );
  process.exit(1);
});

// Deterministic teardown: destroy the WhatsApp client (closes its browser) on
// Ctrl+C / SIGTERM. Left to default handling, the browser's own signal hooks
// have raced node's exit and left orphaned servers squatting on the port.
let shuttingDown = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    if (shuttingDown) process.exit(130);
    shuttingDown = true;
    console.log('\nShutting down…');
    const force = setTimeout(() => process.exit(130), 5000);
    if (force.unref) force.unref();
    try {
      await wa.destroy?.();
    } catch {
      /* browser already gone */
    }
    process.exit(0);
  });
}
