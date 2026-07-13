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

const PORT = Number(process.env.PORT || 3847);
const MOCK = process.env.WHATSTHAT_MOCK === '1';
const NO_OPEN = process.env.WHATSTHAT_NO_OPEN === '1';
const ROOT = __dirname;
const DATA_DIR = process.env.WHATSTHAT_DATA_DIR || ROOT; // overridable for tests
const REPORTS_DIR = path.join(DATA_DIR, 'reports');

const googleStore = new JsonStore(path.join(DATA_DIR, 'google.local.json'));
const draftStore = new JsonStore(path.join(DATA_DIR, 'draft.local.json'));

const sheetsApi = createSheets({
  store: googleStore,
  redirectUri: `http://localhost:${PORT}/api/google/callback`,
});
const wa = createWhatsApp({ mock: MOCK });
const runner = createRunner({ wa, reportsDir: REPORTS_DIR });

const app = express();
app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(ROOT, 'public')));

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
app.get('/api/state', (req, res) => {
  res.json({
    mock: MOCK,
    wa: wa.getState(),
    google: sheetsApi.status(),
    draft: draftStore.read(),
    running: runner.isRunning(),
  });
});

app.post('/api/draft', (req, res) => {
  const allowed = ['template', 'sheetUrl', 'tabName', 'delayMinMs', 'delayMaxMs'];
  const patch = {};
  for (const key of allowed) {
    if (key in req.body) patch[key] = req.body[key];
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
    res.status(400).send(`<body style="font-family:sans-serif;padding:40px"><h2>❌ Google connection failed</h2><p>${String(err.message)}</p></body>`);
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
app.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}`;
  console.log(`WhatsThat ${MOCK ? '(MOCK MODE) ' : ''}running at ${url}`);
  if (process.platform === 'darwin' && !NO_OPEN) execFile('open', [url]);
});

wa.initialize();
