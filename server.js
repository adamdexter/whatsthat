'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const express = require('express');

const { JsonStore } = require('./src/store');
const { createSheets, extractSpreadsheetId } = require('./src/sheets');
const { buildContacts } = require('./src/contacts');
const { parseCsv } = require('./src/csv');
const { render } = require('./src/template');
const { createRunner } = require('./src/runner');
const { createWhatsApp } = require('./src/whatsapp');
const { createScheduleStore, isAgentInstalled, agentSpec, ensureAgent, uninstallAgent, agentPaths } = require('./src/schedule');
const { resolveDataDir, migrateData, readEngineInfo, writeEngineInfo, updateEngineInfo, removeEngineInfo, pidAlive } = require('./src/datadir');
const { expectedBuildId } = require('./src/browser');
const { installFileLog } = require('./src/log');
const { createHistory } = require('./src/history');

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
// Repo root in terminal mode, ~/Library/Application Support/WhatsThat for the
// app (and for terminal mode once a session lives there) — src/datadir.js.
const { dir: DATA_DIR, source: DATA_DIR_SOURCE } = resolveDataDir({ rootDir: ROOT });
const REPORTS_DIR = path.join(DATA_DIR, 'reports');
const LOG_DIR = path.join(DATA_DIR, 'logs');
// A Finder-launched app has no terminal: keep a rotated engine log.
if (PACKAGED || process.env.WHATSTHAT_LOG_FILE) {
  const { file } = installFileLog({ file: process.env.WHATSTHAT_LOG_FILE || path.join(LOG_DIR, 'engine.log') });
  console.log(`Logging to ${file}`);
}
console.log(`Data directory: ${DATA_DIR} (${DATA_DIR_SOURCE})`);

// One-time move of an older checkout's data (session, draft, tokens, reports)
// into the new home: copy + verify, never delete, no-op once the marker
// exists. WHATSTHAT_MIGRATE_FROM is set by the dev app shell and by
// `npm run migrate-data`.
let migration = null;
if (process.env.WHATSTHAT_MIGRATE_FROM) {
  try {
    const result = migrateData({ from: process.env.WHATSTHAT_MIGRATE_FROM, to: DATA_DIR, log: console.log });
    if (result.migrated) migration = result;
  } catch (err) {
    console.error(`Data migration skipped: ${err.message}`);
  }
}

// What this build drives. In the packaged app the engine is pinned per
// release (no launch-time npm update), so the UI's update banner reports it
// as such instead of reading a possibly-migrated update.local.json.
const ENGINE_INFO = (() => {
  let whatsappWebJs = null;
  let chromeBuild = null;
  try {
    whatsappWebJs = require('whatsapp-web.js/package.json').version;
    chromeBuild = expectedBuildId();
  } catch {
    /* library missing — surfaced by the WhatsApp client itself */
  }
  return { whatsappWebJs, chromeBuild };
})();

// Tests/mock never touch launchctl. The packaged app DOES install the agent:
// it is the fallback that sends when the app itself has been quit.
const NO_AGENT = process.env.WHATSTHAT_NO_AGENT === '1' || MOCK;

// --fresh: boot without the previous session's draft (message, loaded
// contacts, selection). `npm start --fresh` reaches us as npm_config_fresh;
// `npm start -- --fresh` and `node server.js --fresh` as argv. The draft is
// set aside, not deleted, so one fresh boot is recoverable.
const FRESH = process.argv.includes('--fresh') || process.env.npm_config_fresh === 'true';
const DRAFT_FILE = path.join(DATA_DIR, 'draft.local.json');
function setDraftAside() {
  if (!fs.existsSync(DRAFT_FILE)) return false;
  fs.renameSync(DRAFT_FILE, path.join(DATA_DIR, 'draft.backup.local.json'));
  return true;
}
if (FRESH && setDraftAside()) console.log('Fresh start: previous draft set aside as draft.backup.local.json');

// Local API token. Every /api route except /api/ping and the OAuth callback
// requires it — as the cookie set when the page loads, or an
// X-WhatsThat-Token header (app shell, run-due.js, tests). With the Host
// allowlist below this shuts out drive-by web pages and DNS rebinding; it is
// not a defense against another process on this Mac (which can read the
// token from engine.local.json anyway).
const API_TOKEN = process.env.WHATSTHAT_API_TOKEN || crypto.randomBytes(24).toString('hex');

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
const history = createHistory(REPORTS_DIR);

const app = express();

// Host allowlist (all routes): a DNS-rebinding page reaches us with its own
// hostname in Host — refuse anything that is not our loopback address.
const ALLOWED_ORIGINS = new Set(); // populated at listen time (PORT=0 support)
const ALLOWED_HOSTS = new Set();
app.use((req, res, next) => {
  if (ALLOWED_HOSTS.size && !ALLOWED_HOSTS.has(req.headers.host)) return res.status(403).json({ error: 'Unexpected Host header' });
  next();
});
app.use(express.json({ limit: '4mb' }));
// The page picks up its API token as an HttpOnly cookie when it loads.
app.get(['/', '/index.html'], (req, res, next) => {
  res.cookie('whatsthat_token', API_TOKEN, { httpOnly: true, sameSite: 'strict', path: '/' });
  next();
});
app.use(express.static(path.join(ROOT, 'public')));

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const cookieToken = (req) => {
  const m = /(?:^|;\s*)whatsthat_token=([^;]+)/.exec(req.headers.cookie || '');
  return m ? decodeURIComponent(m[1]) : null;
};
const tokenOk = (t) => typeof t === 'string' && t.length === API_TOKEN.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(API_TOKEN));
const TOKEN_EXEMPT = new Set(['/ping', '/google/callback']); // discovery; Google's top-level redirect carries no cookie
app.use('/api', (req, res, next) => {
  if (TOKEN_EXEMPT.has(req.path)) return next();
  // Reject state-changing requests from other origins (a malicious web page
  // could otherwise fire POSTs at localhost); same-origin fetches match.
  if (req.method !== 'GET' && req.headers.origin && !ALLOWED_ORIGINS.has(req.headers.origin)) {
    return res.status(403).json({ error: 'Cross-origin requests are not allowed' });
  }
  if (!tokenOk(req.get('x-whatsthat-token') || cookieToken(req))) return res.status(401).json({ error: 'Missing or invalid API token' });
  next();
});

// Unauthenticated discovery: enough for a shell/run-due.js to know a
// WhatsThat is here and where its data (and therefore token) lives.
app.get('/api/ping', (req, res) => {
  res.json({ version: VERSION, packaged: PACKAGED, mock: MOCK, dataDir: DATA_DIR, wa: { status: wa.getState().status } });
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
// Record the browser we launched so the shell can reap it if the engine
// ever has to be force-killed.
wa.onUpdate((state) => {
  if (state.status === 'ready') updateEngineInfo(DATA_DIR, { chromePid: wa.browserPid?.() ?? null });
});

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
    run: runner.status(),
    lastRun,
    schedule: scheduleStore.list(),
    pendingCount: scheduleStore.list().filter((c) => c.status === 'pending').length,
    scheduleHold: scheduleHold(),
    agentInstalled: NO_AGENT ? true : Boolean(agentState.installed),
    agent: agentState,
    update: PACKAGED ? { installed: ENGINE_INFO.whatsappWebJs, pinned: true } : updateStore.read(),
    engine: ENGINE_INFO,
    dataDir: DATA_DIR,
    paths: {
      dataDir: DATA_DIR,
      reportsDir: REPORTS_DIR,
      authDir: path.join(DATA_DIR, '.wwebjs_auth'),
      logDir: LOG_DIR,
    },
    migration,
  });
});

// In-app equivalent of `npm start --fresh`: set the draft aside (kept as
// draft.backup.local.json) so the next page load starts blank.
app.post('/api/draft/reset', (req, res) => {
  try {
    res.json({ backedUp: setDraftAside() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reveal a data folder in Finder (the engine always runs on the Mac).
const OPENABLE = { reports: () => REPORTS_DIR, data: () => DATA_DIR, logs: () => LOG_DIR };
app.post('/api/open-folder', (req, res) => {
  const pick = OPENABLE[(req.body || {}).what];
  if (!pick) return res.status(400).json({ error: 'what must be reports, data, or logs' });
  const dir = pick();
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (process.platform === 'darwin' && !MOCK) execFile('open', [dir]);
    res.json({ ok: true, dir });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/draft', (req, res) => {
  const allowed = ['template', 'sheetUrl', 'tabName', 'delayMinMs', 'delayMaxMs', 'filters', 'contactsCache', 'selectedIds', 'previewId', 'activeTab'];
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

// The page asks for the consent URL (authenticated) and opens it in the
// user's browser — the app shell forwards window.open to the default
// browser because Google refuses OAuth inside embedded browsers. A one-shot
// `state` nonce ties the callback to that request (login-CSRF).
let pendingOAuthState = null;
app.get('/api/google/auth-url', (req, res) => {
  try {
    pendingOAuthState = crypto.randomBytes(16).toString('hex');
    res.json({ url: sheetsApi.authUrl({ state: pendingOAuthState }) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/google/callback', async (req, res) => {
  try {
    if (!pendingOAuthState || req.query.state !== pendingOAuthState) {
      throw new Error('Unexpected OAuth callback (state mismatch) — start the connection from WhatsThat again');
    }
    pendingOAuthState = null;
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

// launchd fallback agent — installed on first schedule, self-repaired at
// boot (see src/schedule.js ensureAgent). `listeningPort` is known after
// app.listen; the plist pins PORT so run-due.js finds a fixed-port engine
// even before engine.local.json exists.
let listeningPort = null;
const agentState = {
  mode: NO_AGENT ? 'none' : 'launchd',
  installed: NO_AGENT ? null : isAgentInstalled(),
  plist: agentPaths().plist,
  nodePath: null,
  scriptPath: null,
  checkedAt: null,
  repairedAt: null,
  error: null,
};
function currentAgentSpec() {
  return agentSpec({ rootDir: ROOT, dataDir: DATA_DIR, packaged: PACKAGED, port: listeningPort && listeningPort !== 0 ? listeningPort : null });
}
function ensureAgentNow() {
  if (NO_AGENT) return { installed: true, skipped: true };
  const spec = currentAgentSpec();
  agentState.nodePath = spec.nodePath;
  agentState.scriptPath = spec.scriptPath;
  agentState.checkedAt = new Date().toISOString();
  try {
    const r = ensureAgent(spec);
    agentState.installed = true;
    agentState.error = null;
    if (r.repaired) {
      agentState.repairedAt = agentState.checkedAt;
      console.log(`launchd agent re-pointed at ${spec.nodePath} ${spec.scriptPath}`);
    } else if (r.changed) {
      console.log(`launchd agent installed (${spec.nodePath} ${spec.scriptPath})`);
    }
    return { installed: true, repaired: r.repaired };
  } catch (err) {
    agentState.installed = false;
    agentState.error = `Background agent install failed: ${err.message}`;
    console.error(agentState.error);
    return { installed: false, error: agentState.error };
  }
}

app.post('/api/agent/uninstall', (req, res) => {
  if (NO_AGENT) return res.json({ agent: agentState });
  try {
    uninstallAgent();
    agentState.installed = false;
    agentState.error = null;
    res.json({ agent: agentState });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
  const agent = ensureAgentNow();

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
// the in-app timer, by the launchd runner when the app is open, and whenever
// WhatsApp comes back to 'ready'. A due campaign while WhatsApp is down is
// HELD (status stays pending, so Cancel still works) and labelled so the UI
// and tray can say why; the 6h staleness window still applies to it.
const NUDGE_EVERY_MS = 10 * 60 * 1000;
let lastNudgeAt = 0;
async function executeDue() {
  const due = scheduleStore.findDue(); // housekeeping (missed/interrupted) runs even with WA down
  if (!due.length) return { ran: false, reason: 'nothing due' };
  if (runner.isRunning()) return { ran: false, reason: 'a run is already in progress' };
  const waStatus = wa.getState().status;
  if (waStatus !== 'ready') {
    const waitReason = `WhatsApp is ${waStatus}`;
    const now = new Date().toISOString();
    let changed = false;
    for (const c of due) {
      if (c.waitReason !== waitReason) {
        scheduleStore.patch(c.id, { waitingSince: c.waitingSince || now, waitReason });
        changed = true;
      }
    }
    if (changed) broadcastSchedule();
    // A dead link gets a nudge (bounded); a QR needs a human, never nudge that.
    if ((waStatus === 'disconnected' || waStatus === 'error') && wa.reconnect && Date.now() - lastNudgeAt > NUDGE_EVERY_MS) {
      lastNudgeAt = Date.now();
      wa.reconnect().catch(() => {});
    }
    return { ran: false, reason: 'whatsapp not ready', waiting: due.length };
  }

  for (const campaign of due) {
    scheduleStore.patch(campaign.id, { status: 'running', startedAt: new Date().toISOString(), waitingSince: null, waitReason: null });
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
// A held campaign fires seconds after WhatsApp is back, not at the next tick.
wa.onUpdate((s) => {
  if (s.status === 'ready') executeDue().catch(() => {});
});

const scheduleHold = () => {
  const waiting = scheduleStore.list().filter((c) => c.status === 'pending' && c.waitReason);
  if (!waiting.length) return null;
  return { count: waiting.length, since: waiting.map((c) => c.waitingSince).sort()[0] || null, reason: waiting[0].waitReason };
};

// Manual relaunch of the WhatsApp client (tray "Reconnect WhatsApp").
app.post('/api/whatsapp/reconnect', async (req, res) => {
  if (runner.isRunning()) return res.status(409).json({ error: 'A send is in progress — reconnecting would interrupt it' });
  if (!wa.reconnect) return res.status(501).json({ error: 'Reconnect is not supported by this client' });
  try {
    await wa.reconnect();
    res.json({ ok: true, wa: wa.getState() });
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

// ---------- Reports ----------
// Last successful send per phone, from the reports (see src/history.js).
app.get('/api/history', (req, res) => {
  res.json(history.get());
});

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
  // Simulate WhatsApp dropping the session (reason as whatsapp-web.js would
  // report it) and the user relinking.
  app.post('/api/mock/disconnect', async (req, res) => {
    await wa._disconnect((req.body || {}).reason || 'CONFLICT');
    res.json({ wa: wa.getState() });
  });
  app.post('/api/mock/relink', async (req, res) => {
    await wa._relink();
    res.json({ wa: wa.getState() });
  });
}

// ---------- Boot ----------
// The WhatsApp client starts only after the port is won: only ONE process may
// use the session, and the port is the instance lock. A second launch exits
// here with a pointer to the running (or hung) instance instead of silently
// booting an invisible WhatsApp client with no UI.
const httpServer = app.listen(PORT, '127.0.0.1', async () => {
  // On EADDRINUSE the listen callback can still fire (via express's once
  // wrapper on the error path) with address() null — that path belongs to
  // the 'error' handler below.
  const addr = httpServer.address();
  if (!addr) return;
  const actualPort = addr.port;
  ALLOWED_ORIGINS.add(`http://localhost:${actualPort}`);
  ALLOWED_ORIGINS.add(`http://127.0.0.1:${actualPort}`);
  ALLOWED_HOSTS.add(`localhost:${actualPort}`);
  ALLOWED_HOSTS.add(`127.0.0.1:${actualPort}`);
  sheetsApi = createSheets({
    store: googleStore,
    redirectUri: `http://localhost:${actualPort}/api/google/callback`,
  });

  // Cross-port instance lock. A fixed port is its own lock, but an engine on
  // an ephemeral port sharing this data dir would boot a second WhatsApp
  // client against the same session. engine.local.json names the current
  // occupant; if it is alive and answering, we bow out.
  const other = readEngineInfo(DATA_DIR);
  if (other && other.pid !== process.pid && other.port !== actualPort && pidAlive(other.pid)) {
    let answering = false;
    try {
      answering = (await fetch(`http://127.0.0.1:${other.port}/api/ping`, { signal: AbortSignal.timeout(2000) })).ok;
    } catch {
      /* stale file — the pid is something else now */
    }
    if (answering) {
      console.error(
        `\n✗ WhatsThat v${other.version} is already running on this data directory (pid ${other.pid}, port ${other.port}). Use that instance, or quit it first.\n`
      );
      httpServer.close();
      process.exit(1);
    }
  }
  writeEngineInfo(DATA_DIR, {
    pid: process.pid,
    port: actualPort,
    version: VERSION,
    startedAt: new Date().toISOString(),
    packaged: PACKAGED,
    mock: MOCK,
    token: API_TOKEN,
  });

  listeningPort = actualPort;
  // Repair the launchd fallback if this data dir already relies on one (the
  // app moved/reinstalled, dev↔packaged switch, data dir change). Never
  // creates an agent on a machine that has not scheduled anything.
  if (!NO_AGENT && (fs.existsSync(agentPaths().plist) || scheduleStore.list().some((c) => c.status === 'pending'))) {
    ensureAgentNow();
  }

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
    const res = await fetch(`http://127.0.0.1:${PORT}/api/ping`, { signal: AbortSignal.timeout(2000) });
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
process.on('exit', () => removeEngineInfo(DATA_DIR)); // only if it is ours (pid match)
// whatsapp-web.js runs async page-event handlers with no catch; a rejection
// there used to take the whole engine down. A resident daemon logs it and
// lets the reconnect/liveness machinery deal with the consequences. A true
// uncaught exception still exits non-zero (the app shell respawns us) after
// closing the browser so the session lock is released.
process.on('unhandledRejection', (err) => {
  console.error('unhandledRejection (kept running):', err && err.stack ? err.stack : err);
});
process.on('uncaughtException', async (err) => {
  console.error('uncaughtException — shutting down:', err && err.stack ? err.stack : err);
  const force = setTimeout(() => process.exit(70), 5000);
  if (force.unref) force.unref();
  try {
    await wa.destroy?.();
  } catch {
    /* browser already gone */
  }
  process.exit(70);
});
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
