'use strict';

// scripts/run-due.js — the launchd runner. Must delegate to a running app
// (found via PORT or engine.local.json), never boot a second client while
// the WhatsApp profile is in use, and report honestly when nothing sends.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawn, execFile } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { TOKEN, AUTH } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const RUN_DUE = path.join(ROOT, 'scripts', 'run-due.js');
const CONTACTS = [{ id: 1, fields: { firstName: 'Ada' }, phone: '+14155550134', phoneError: null }];

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'whatsthat-rundue-'));

function runDue(env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [RUN_DUE], { env: { ...process.env, WHATSTHAT_MOCK: '1', ...env } }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, out: stdout + stderr });
    });
  });
}

async function waitFor(fn, timeoutMs = 15000, everyMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  throw new Error('waitFor timed out');
}

function bootApp(port, dataDir) {
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    // A slow tick so the app does not send the campaign before run-due asks it to.
    env: { ...process.env, WHATSTHAT_MOCK: '1', PORT: String(port), WHATSTHAT_NO_OPEN: '1', WHATSTHAT_API_TOKEN: TOKEN, WHATSTHAT_DATA_DIR: dataDir, WHATSTHAT_TICK_MS: '60000' },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  const ready = waitFor(async () => {
    try {
      return (await (await fetch(`${base}/api/state`, { headers: AUTH })).json()).wa.status === 'ready';
    } catch {
      return false;
    }
  });
  return { child, base, ready };
}

const dueCampaign = () => ({
  campaigns: [{ id: 'due', createdAt: new Date().toISOString(), sendAt: new Date(Date.now() - 5000).toISOString(), contacts: CONTACTS, template: 'From run-due, {{firstName}}', status: 'pending', delayMinMs: 1, delayMaxMs: 2 }],
});

test('delegates to the app on PORT, and finds it via engine.local.json when PORT is unset', async () => {
  const dir = tmp();
  const port = 3942;
  const app = bootApp(port, dir);
  try {
    await app.ready;
    fs.writeFileSync(path.join(dir, 'schedule.local.json'), JSON.stringify(dueCampaign()));

    const viaPort = await runDue({ WHATSTHAT_DATA_DIR: dir, PORT: String(port) });
    assert.equal(viaPort.code, 0, viaPort.out);
    assert.match(viaPort.out, new RegExp(`App is running on port ${port} — asking it to send`));
    assert.match(viaPort.out, /"ran":true/);
    const sent = await (await fetch(`${app.base}/api/mock/sent`, { headers: AUTH })).json();
    assert.ok(sent.sent.some((m) => m.text === 'From run-due, Ada'), 'the APP sent it');

    fs.writeFileSync(path.join(dir, 'schedule.local.json'), JSON.stringify(dueCampaign()));
    const viaFile = await runDue({ WHATSTHAT_DATA_DIR: dir, PORT: '' });
    assert.match(viaFile.out, new RegExp(`App is running on port ${port}`), 'discovered through engine.local.json');
  } finally {
    app.child.kill();
  }
});

test('reports ran:false when the app is up but WhatsApp is not ready', async () => {
  const dir = tmp();
  const port = 3943;
  const app = bootApp(port, dir);
  try {
    await app.ready;
    await fetch(`${app.base}/api/mock/disconnect`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...AUTH }, body: JSON.stringify({ reason: 'LOGOUT' }) });
    await waitFor(async () => (await (await fetch(`${app.base}/api/state`, { headers: AUTH })).json()).wa.status === 'qr');
    fs.writeFileSync(path.join(dir, 'schedule.local.json'), JSON.stringify(dueCampaign()));
    const r = await runDue({ WHATSTHAT_DATA_DIR: dir, PORT: String(port) });
    assert.equal(r.code, 0);
    assert.match(r.out, /"ran":false/);
    assert.match(r.out, /whatsapp not ready/);
  } finally {
    app.child.kill();
  }
});

test('never boots a second client while the WhatsApp profile lock belongs to a live process', async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, '.wwebjs_auth', 'session'), { recursive: true });
  fs.symlinkSync(`Mac.local-${process.pid}`, path.join(dir, '.wwebjs_auth', 'session', 'SingletonLock'));
  fs.writeFileSync(path.join(dir, 'schedule.local.json'), JSON.stringify(dueCampaign()));
  const r = await runDue({ WHATSTHAT_DATA_DIR: dir, PORT: '3944' });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /profile is in use by pid/);
  assert.ok(!/booting headless/.test(r.out));
  const sched = JSON.parse(fs.readFileSync(path.join(dir, 'schedule.local.json'), 'utf8'));
  assert.equal(sched.campaigns[0].status, 'pending', 'campaign untouched for the next tick');
});

test('exits quietly when nothing is due', async () => {
  const dir = tmp();
  const r = await runDue({ WHATSTHAT_DATA_DIR: dir, PORT: '3945' });
  assert.equal(r.code, 0);
  assert.equal(r.out.trim(), '');
});

test('trimLog keeps only the tail of an oversized scheduler.log', () => {
  const { trimLog } = require('../scripts/run-due');
  const file = path.join(tmp(), 'scheduler.log');
  fs.writeFileSync(file, 'x'.repeat(1000) + '\nTAIL');
  assert.equal(trimLog(file, { max: 5000, keep: 100 }), false, 'under the cap: untouched');
  assert.equal(fs.statSync(file).size, 1005);
  assert.equal(trimLog(file, { max: 500, keep: 100 }), true);
  const kept = fs.readFileSync(file, 'utf8');
  assert.equal(kept.length, 100);
  assert.ok(kept.endsWith('TAIL'));
  assert.equal(trimLog(path.join(tmp(), 'missing.log')), false, 'missing file is fine');
});
