'use strict';

// Local API hardening (v1.11.0): every /api route needs the token (cookie or
// header) except discovery + the OAuth callback; Host and Origin are
// allowlisted; the OAuth callback needs our one-shot state nonce.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { TOKEN, AUTH } = require('./helpers');

const PORT = 3946;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsthat-token-'));
let server;

function boot(port, dataDir, env = {}) {
  return spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, WHATSTHAT_MOCK: '1', PORT: String(port), WHATSTHAT_NO_OPEN: '1', WHATSTHAT_DATA_DIR: dataDir, WHATSTHAT_API_TOKEN: TOKEN, ...env },
    stdio: 'ignore',
  });
}

async function waitFor(fn, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('waitFor timed out');
}
// Discovery works before WhatsApp is ready; the assertions below want the
// mock client settled, so wait for that through the unauthenticated ping.
const up = (port) => async () => {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/ping`);
    return res.ok && (await res.json()).wa.status === 'ready';
  } catch {
    return false;
  }
};

// Raw request with full control over Host/headers.
const raw = (port, { method = 'GET', path: p = '/', headers = {}, body } = {}) =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });

before(async () => {
  server = boot(PORT, DATA_DIR);
  await waitFor(up(PORT));
});
after(() => server && server.kill());

test('/api/state: 401 without a token, 200 with the header or the cookie, 401 with a wrong one', async () => {
  assert.equal((await fetch(`${BASE}/api/state`)).status, 401);
  assert.equal((await fetch(`${BASE}/api/state`, { headers: AUTH })).status, 200);
  assert.equal((await fetch(`${BASE}/api/state`, { headers: { Cookie: `whatsthat_token=${TOKEN}` } })).status, 200);
  assert.equal((await fetch(`${BASE}/api/state`, { headers: { 'X-WhatsThat-Token': 'nope' } })).status, 401);
  assert.equal((await fetch(`${BASE}/api/state`, { headers: { 'X-WhatsThat-Token': `${TOKEN}x` } })).status, 401);
});

test('the page load sets the token cookie (HttpOnly, SameSite=Strict); assets do not', async () => {
  const page = await raw(PORT, { path: '/', headers: { host: `127.0.0.1:${PORT}` } });
  assert.equal(page.status, 200);
  const cookie = [].concat(page.headers['set-cookie'] || []).find((c) => c.startsWith('whatsthat_token='));
  assert.ok(cookie, 'cookie set');
  assert.match(cookie, /whatsthat_token=test-token/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  const asset = await raw(PORT, { path: '/style.css', headers: { host: `127.0.0.1:${PORT}` } });
  assert.equal(asset.status, 200);
  assert.equal(asset.headers['set-cookie'], undefined);
});

test('every mutating route refuses without a token and changes nothing', async () => {
  const routes = ['/api/draft', '/api/run', '/api/test-send', '/api/schedule', '/api/run/cancel', '/api/google/disconnect', '/api/schedule/run-due', '/api/contacts/csv', '/api/draft/reset', '/api/open-folder', '/api/whatsapp/reconnect', '/api/agent/uninstall', '/api/mock/disconnect'];
  await fetch(`${BASE}/api/draft`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...AUTH }, body: JSON.stringify({ template: 'keep me' }) });
  for (const r of routes) {
    const res = await fetch(`${BASE}${r}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ template: 'evil', reason: 'CONFLICT', what: 'data' }) });
    assert.equal(res.status, 401, r);
  }
  const state = await (await fetch(`${BASE}/api/state`, { headers: AUTH })).json();
  assert.equal(state.draft.template, 'keep me');
  assert.equal(state.wa.status, 'ready', 'mock disconnect was refused too');
  const sent = await (await fetch(`${BASE}/api/mock/sent`, { headers: AUTH })).json();
  assert.equal(sent.sent.length, 0);
});

test('the SSE stream needs the token too', async () => {
  const denied = await raw(PORT, { path: '/api/events', headers: { host: `127.0.0.1:${PORT}` } });
  assert.equal(denied.status, 401);
  await new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/events', headers: { host: `127.0.0.1:${PORT}`, Cookie: `whatsthat_token=${TOKEN}` } }, (res) => {
      assert.equal(res.statusCode, 200);
      res.once('data', (d) => {
        assert.match(String(d), /event: wa_state/);
        req.destroy();
        resolve();
      });
    });
    req.on('error', (e) => (e.code === 'ECONNRESET' ? resolve() : reject(e)));
  });
});

test('exempt: /api/ping answers without a token and leaks no draft; the OAuth callback is refused on state, not token', async () => {
  const ping = await (await fetch(`${BASE}/api/ping`)).json();
  assert.ok(ping.version);
  assert.equal(ping.dataDir, DATA_DIR);
  assert.equal(ping.wa.status, 'ready');
  assert.equal(ping.draft, undefined);
  const cb = await fetch(`${BASE}/api/google/callback?code=abc&state=forged`);
  assert.equal(cb.status, 400);
  assert.match(await cb.text(), /state mismatch/);
  const noState = await fetch(`${BASE}/api/google/callback?code=abc`);
  assert.equal(noState.status, 400);
  const authUrl = await fetch(`${BASE}/api/google/auth-url`, { headers: AUTH });
  assert.equal(authUrl.status, 400, 'authenticated but no credentials configured');
  assert.equal((await fetch(`${BASE}/api/google/auth-url`)).status, 401);
});

test('an unexpected Host header (DNS rebinding) is refused everywhere', async () => {
  for (const p of ['/', '/api/ping', '/api/state']) {
    const res = await raw(PORT, { path: p, headers: { host: 'attacker.example', ...AUTH } });
    assert.equal(res.status, 403, p);
  }
  assert.equal((await raw(PORT, { path: '/api/ping', headers: { host: `localhost:${PORT}` } })).status, 200);
  assert.equal((await raw(PORT, { path: '/api/ping', headers: { host: `127.0.0.1:${PORT}` } })).status, 200);
});

test('cross-origin POSTs are refused even with a token; "null" and other-port origins included', async () => {
  for (const origin of ['https://evil.example', 'null', `http://127.0.0.1:${PORT + 1}`]) {
    const res = await fetch(`${BASE}/api/run/cancel`, { method: 'POST', headers: { Origin: origin, ...AUTH } });
    assert.equal(res.status, 403, origin);
  }
  assert.equal((await fetch(`${BASE}/api/run/cancel`, { method: 'POST', headers: { Origin: `http://localhost:${PORT}`, ...AUTH } })).status, 200);
});

test('the token is recorded in engine.local.json (0600) so the shell and run-due.js can find it', () => {
  const file = path.join(DATA_DIR, 'engine.local.json');
  const info = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(info.token, TOKEN);
  assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600');
});

test('with no WHATSTHAT_API_TOKEN the engine mints a random one per boot', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsthat-token2-'));
  const port = PORT + 1;
  const child = boot(port, dir, { WHATSTHAT_API_TOKEN: '' });
  try {
    await waitFor(up(port));
    const { token } = JSON.parse(fs.readFileSync(path.join(dir, 'engine.local.json'), 'utf8'));
    assert.match(token, /^[0-9a-f]{48}$/);
    assert.notEqual(token, TOKEN);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/state`, { headers: AUTH })).status, 401, 'the shared test token is not accepted');
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { 'X-WhatsThat-Token': token } })).status, 200);
  } finally {
    child.kill();
  }
});

test('/api/draft/reset sets the draft aside and /api/open-folder validates its argument', async () => {
  await fetch(`${BASE}/api/draft`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...AUTH }, body: JSON.stringify({ template: 'to be reset' }) });
  const r1 = await (await fetch(`${BASE}/api/draft/reset`, { method: 'POST', headers: AUTH })).json();
  assert.equal(r1.backedUp, true);
  assert.ok(fs.existsSync(path.join(DATA_DIR, 'draft.backup.local.json')));
  const state = await (await fetch(`${BASE}/api/state`, { headers: AUTH })).json();
  assert.equal(state.draft.template, undefined, 'draft is blank now');
  const r2 = await (await fetch(`${BASE}/api/draft/reset`, { method: 'POST', headers: AUTH })).json();
  assert.equal(r2.backedUp, false, 'nothing to set aside the second time');
  const bad = await fetch(`${BASE}/api/open-folder`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...AUTH }, body: JSON.stringify({ what: '../etc' }) });
  assert.equal(bad.status, 400);
  const ok = await (await fetch(`${BASE}/api/open-folder`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...AUTH }, body: JSON.stringify({ what: 'logs' }) })).json();
  assert.equal(ok.dir, path.join(DATA_DIR, 'logs'));
  assert.ok(fs.existsSync(ok.dir), 'created on demand (mock never launches Finder)');
});
