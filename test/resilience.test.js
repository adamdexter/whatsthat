'use strict';

// Resident-app resilience (v1.10.0), driven through the mock client's
// disconnect hooks: scheduled sends HOLD while WhatsApp is down (and fire
// the moment it is back), staleness still applies while holding, drops
// auto-reconnect with a budget, blocks stay fatal, manual reconnect works
// and is refused mid-send.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const PORT = 3940;
const BASE = `http://127.0.0.1:${PORT}`;
const CONTACTS = [{ id: 1, fields: { firstName: 'Ada' }, phone: '+14155550134', phoneError: null }];
let server;

async function api(p, opts = {}) {
  const res = await fetch(`${BASE}${p}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}
const state = async () => (await api('/api/state')).data;

async function waitFor(fn, timeoutMs = 10000, everyMs = 100) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  throw new Error(`waitFor timed out (last: ${JSON.stringify(last)})`);
}

function boot(port, dataDir, extraEnv = {}) {
  return spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, WHATSTHAT_MOCK: '1', PORT: String(port), WHATSTHAT_NO_OPEN: '1', WHATSTHAT_DATA_DIR: dataDir, WHATSTHAT_TICK_MS: '200', ...extraEnv },
    stdio: 'ignore',
  });
}

before(async () => {
  server = boot(PORT, fs.mkdtempSync(path.join(os.tmpdir(), 'whatsthat-resilience-')));
  await waitFor(async () => {
    try {
      return (await state()).wa.status === 'ready';
    } catch {
      return false;
    }
  }, 15000);
});

after(() => {
  if (server) server.kill();
});

test('a due campaign holds while WhatsApp is down, says why, and fires the moment it is back', async () => {
  await api('/api/mock/disconnect', { method: 'POST', body: { reason: 'LOGOUT' } });
  await waitFor(async () => (await state()).wa.status === 'qr');

  const { status, data } = await api('/api/schedule', {
    method: 'POST',
    body: { sendAt: new Date(Date.now() + 300).toISOString(), contacts: CONTACTS, template: 'Held hello, {{firstName}}!', delayMinMs: 1, delayMaxMs: 2 },
  });
  assert.equal(status, 200, JSON.stringify(data));
  const id = data.campaign.id;

  const held = await waitFor(async () => {
    const c = (await state()).schedule.find((x) => x.id === id);
    return c && c.waitReason ? c : null;
  });
  assert.equal(held.status, 'pending', 'still pending (cancellable), not failed');
  assert.match(held.waitReason, /WhatsApp is qr/);
  assert.ok(held.waitingSince);
  const st = await state();
  assert.equal(st.scheduleHold.count, 1);
  assert.match(st.scheduleHold.reason, /qr/);
  assert.equal(st.pendingCount, 1);

  const runDue = await api('/api/schedule/run-due', { method: 'POST' });
  assert.deepEqual(runDue.data, { ran: false, reason: 'whatsapp not ready', waiting: 1 });

  await api('/api/mock/relink', { method: 'POST' });
  const done = await waitFor(async () => {
    const c = (await state()).schedule.find((x) => x.id === id);
    return c && c.status === 'done' ? c : null;
  });
  assert.equal(done.summary.sent, 1);
  assert.equal(done.waitReason, null, 'hold cleared once it ran');
  assert.equal((await state()).scheduleHold, null);
  const sent = (await api('/api/mock/sent')).data.sent;
  assert.ok(sent.some((m) => m.text === 'Held hello, Ada!'));
});

test('staleness housekeeping still runs while holding (a 7h-old campaign becomes missed, not sent)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsthat-stale-'));
  fs.writeFileSync(
    path.join(dir, 'schedule.local.json'),
    JSON.stringify({
      campaigns: [
        { id: 'stale', createdAt: new Date().toISOString(), sendAt: new Date(Date.now() - 7 * 3600000).toISOString(), contacts: CONTACTS, template: 'stale', status: 'pending' },
      ],
    })
  );
  const port = 3941;
  const child = boot(port, dir);
  try {
    // The mock sits in 'starting' then 'qr' for ~1.7s before 'ready'; the
    // 200ms tick must mark this missed during that window.
    const c = await waitFor(async () => {
      try {
        const st = (await (await fetch(`http://127.0.0.1:${port}/api/state`)).json()).schedule[0];
        return st.status === 'missed' ? st : null;
      } catch {
        return null;
      }
    }, 8000);
    assert.match(c.error, /unavailable/);
    const sent = await (await fetch(`http://127.0.0.1:${port}/api/mock/sent`)).json();
    assert.equal(sent.sent.length, 0, 'never sent');
  } finally {
    child.kill();
  }
});

test('a dropped session (CONFLICT) reconnects by itself and counts it', async () => {
  const before = (await state()).wa.reconnect.count;
  await api('/api/mock/disconnect', { method: 'POST', body: { reason: 'CONFLICT' } });
  const wa = await waitFor(async () => {
    const w = (await state()).wa;
    return w.status === 'ready' && w.reconnect.count === before + 1 ? w : null;
  });
  assert.equal(wa.reconnect.lastReason, 'CONFLICT');
  assert.ok(wa.readyAt);
});

test('a block (TOS_BLOCK) is fatal — no retry — until a manual reconnect', async () => {
  await api('/api/mock/disconnect', { method: 'POST', body: { reason: 'TOS_BLOCK' } });
  await waitFor(async () => (await state()).wa.status === 'error');
  await new Promise((r) => setTimeout(r, 700));
  const wa = (await state()).wa;
  assert.equal(wa.status, 'error', 'still error — nothing retried');
  assert.match(wa.error, /TOS_BLOCK/);

  const res = await api('/api/whatsapp/reconnect', { method: 'POST' });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  await waitFor(async () => (await state()).wa.status === 'ready');
});

test('reconnect is refused while a send is in progress', async () => {
  const run = await api('/api/run', {
    method: 'POST',
    body: { contacts: [CONTACTS[0], { ...CONTACTS[0], id: 2, phone: '+14155550135' }], template: 'Run {{firstName}}', delayMinMs: 400, delayMaxMs: 500 },
  });
  assert.equal(run.status, 200, JSON.stringify(run.data));
  const res = await api('/api/whatsapp/reconnect', { method: 'POST' });
  assert.equal(res.status, 409);
  assert.match(res.data.error, /in progress/);
  await waitFor(async () => (await state()).running === false, 10000);
});

test('/api/agent/uninstall is a no-op in mock mode and the agent state is reported', async () => {
  const st = await state();
  assert.equal(st.agent.mode, 'none');
  assert.equal(st.agentInstalled, true);
  const res = await api('/api/agent/uninstall', { method: 'POST' });
  assert.equal(res.status, 200);
  assert.equal(res.data.agent.mode, 'none');
});
