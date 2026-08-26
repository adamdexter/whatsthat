'use strict';

// End-to-end test: boots the real server in mock mode and drives the HTTP API
// through the full flow — load contacts, preview, test send, run, report.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { TOKEN, AUTH } = require('./helpers');

const PORT = 3931;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsthat-e2e-'));
let server;

async function api(p, opts = {}) {
  const res = await fetch(`${BASE}${p}`, {
    headers: { 'Content-Type': 'application/json', ...AUTH },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function waitFor(fn, timeoutMs = 15000, everyMs = 150) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = await fn();
    if (val) return val;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  throw new Error('waitFor timed out');
}

before(async () => {
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      WHATSTHAT_MOCK: '1',
      PORT: String(PORT),
      WHATSTHAT_NO_OPEN: '1',
      WHATSTHAT_API_TOKEN: TOKEN,
      WHATSTHAT_DATA_DIR: DATA_DIR,
      WHATSTHAT_TICK_MS: '200', // fast in-app scheduler tick for the schedule test
    },
    stdio: 'ignore',
  });
  await waitFor(async () => {
    try {
      const { data } = await api('/api/state');
      return data.wa && data.wa.status === 'ready';
    } catch {
      return false;
    }
  });
});

after(() => {
  if (server) server.kill();
});

const CSV = [
  'firstName,lastName,nickname,phone',
  'Ada,Lovelace,Ada,415-555-0134',
  'Alan,Turing,Al,+1 (415) 555-0199', // mock: not registered on WhatsApp
  'Grace,Hopper,Gracie,4155550198', // mock: send fails
  'Bad,Row,,555-13', // invalid phone
].join('\n');

let contacts;

test('load contacts from CSV', async () => {
  const { status, data } = await api('/api/contacts/csv', { method: 'POST', body: { csv: CSV } });
  assert.equal(status, 200);
  assert.equal(data.error, null);
  assert.deepEqual(data.headers, ['firstName', 'lastName', 'nickname', 'phone']);
  assert.equal(data.contacts.length, 4);
  assert.equal(data.contacts[0].phone, '+14155550134');
  assert.equal(data.contacts[3].phone, null);
  contacts = data.contacts;
});

test('preview-all renders per contact with warnings', async () => {
  const { data } = await api('/api/preview-all', {
    method: 'POST',
    body: {
      template: 'Hey {{nickname}}, it is {{firstName}} {{lastName}} day!',
      contacts: contacts.map((c) => ({ id: c.id, fields: c.fields })),
    },
  });
  assert.equal(data.previews.length, 4);
  assert.equal(data.previews[0].text, 'Hey Ada, it is Ada Lovelace day!');
  assert.deepEqual(data.previews[3].empty, ['nickname']); // Bad Row has empty nickname
});

test('test-send delivers to self', async () => {
  const { status, data } = await api('/api/test-send', {
    method: 'POST',
    body: { template: 'Hi {{firstName}}!', fields: contacts[0].fields },
  });
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.text, 'Hi Ada!');
  const sent = (await api('/api/mock/sent')).data.sent;
  assert.ok(sent.some((s) => s.chatId === 'self' && s.text === 'Hi Ada!'));
});

test('test-send rejects unknown variables', async () => {
  const { status, data } = await api('/api/test-send', {
    method: 'POST',
    body: { template: 'Hi {{bogus}}!', fields: contacts[0].fields },
  });
  assert.equal(status, 400);
  assert.match(data.error, /Unknown variable/);
});

test('full run: sends, reports failures, writes report', async () => {
  const { status, data } = await api('/api/run', {
    method: 'POST',
    body: { contacts, template: 'Hey {{firstName}}!', delayMinMs: 1, delayMaxMs: 2 },
  });
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.total, 4);

  // Wait for the run to finish — the report file exists from the first
  // contact onward (crash-safety), so wait for status 'complete'.
  const reportName = await waitFor(async () => {
    const { data: d } = await api('/api/reports');
    if (!d.reports || !d.reports[0]) return null;
    const { data: r } = await api(`/api/reports/${d.reports[0]}`);
    return r.status === 'complete' ? d.reports[0] : null;
  });
  const { data: report } = await api(`/api/reports/${reportName}`);
  assert.equal(report.status, 'complete');
  assert.equal(report.summary.total, 4);
  assert.equal(report.summary.sent, 1); // only Ada
  assert.equal(report.summary.failed, 3);

  const byName = Object.fromEntries(report.results.map((r) => [r.fields.firstName, r]));
  assert.equal(byName.Ada.status, 'sent');
  assert.match(byName.Alan.error, /not registered/);
  assert.match(byName.Grace.error, /mock send failure/);
  assert.match(byName.Bad.error, /Invalid phone/);

  const sent = (await api('/api/mock/sent')).data.sent;
  assert.ok(sent.some((s) => s.chatId === '14155550134@c.us' && s.text === 'Hey Ada!'));
});

test('run rejects when another run could conflict or inputs are bad', async () => {
  const empty = await api('/api/run', { method: 'POST', body: { contacts: [], template: 'x' } });
  assert.equal(empty.status, 400);
  const noTemplate = await api('/api/run', { method: 'POST', body: { contacts, template: ' ' } });
  assert.equal(noTemplate.status, 400);
});

test('draft persistence roundtrip', async () => {
  await api('/api/draft', { method: 'POST', body: { template: 'Hello {{firstName}}', sheetUrl: 'https://example' } });
  const { data } = await api('/api/state');
  assert.equal(data.draft.template, 'Hello {{firstName}}');
});

test('state exposes lastRun after a completed run (SSE-drop recovery)', async () => {
  const { data } = await api('/api/state');
  assert.ok(data.lastRun, 'lastRun present');
  assert.equal(data.lastRun.summary.total, 4);
  assert.ok(data.lastRun.reportFile);
});

test('history indexes the last successful send per phone from the reports', async () => {
  const { status, data } = await api('/api/history');
  assert.equal(status, 200);
  assert.ok(data.reports >= 1);
  const sent = (await api('/api/mock/sent')).data.sent;
  const phones = Object.keys(data.byPhone);
  assert.ok(phones.length >= 1, 'at least one delivered contact indexed');
  for (const phone of phones) {
    const h = data.byPhone[phone];
    assert.match(phone, /^\+\d+$/);
    assert.ok(h.at && h.reportFile && h.count >= 1);
    assert.ok(sent.some((m) => m.text === h.text), 'text is what the mock actually sent');
  }
  assert.equal(data.byPhone['+14155550199'], undefined, 'a not-on-WhatsApp number never appears');
});

test('the side-by-side layout choice persists in the draft', async () => {
  const set = await api('/api/draft', { method: 'POST', body: { layout: 'split' } });
  assert.equal(set.status, 200);
  assert.equal((await api('/api/state')).data.draft.layout, 'split');
  await api('/api/draft', { method: 'POST', body: { layout: 'tabs' } });
  assert.equal((await api('/api/state')).data.draft.layout, 'tabs');
  await api('/api/draft', { method: 'POST', body: { hideUnselected: true } });
  assert.equal((await api('/api/state')).data.draft.hideUnselected, true, 'view mode persists too');
});

test('cross-origin POSTs are rejected', async () => {
  const res = await fetch(`${BASE}/api/run/cancel`, {
    method: 'POST',
    headers: { Origin: 'https://evil.example' },
  });
  assert.equal(res.status, 403);
  // Same-origin passes
  const ok = await fetch(`${BASE}/api/run/cancel`, {
    method: 'POST',
    headers: { Origin: `http://127.0.0.1:${PORT}`, ...AUTH },
  });
  assert.equal(ok.status, 200);
});

test('draft endpoint survives a body-less POST', async () => {
  const res = await fetch(`${BASE}/api/draft`, { method: 'POST', headers: AUTH });
  assert.equal(res.status, 200);
});

test('OAuth callback without our state nonce is refused and reflects nothing', async () => {
  const res = await fetch(`${BASE}/api/google/callback?error=<script>alert(1)</script>&state=forged`);
  assert.equal(res.status, 400);
  const body = await res.text();
  assert.ok(!body.includes('<script>alert(1)</script>'), 'input never reaches the page');
  assert.match(body, /state mismatch/);
});

test('scheduled send: validates, fires via the in-app tick, reports done', async () => {
  // Validation
  const past = await api('/api/schedule', {
    method: 'POST',
    body: { sendAt: new Date(Date.now() - 3600000).toISOString(), contacts: [contacts[0]], template: 'x' },
  });
  assert.equal(past.status, 400);

  // Schedule 1s out; the 200ms tick should pick it up.
  const { status, data } = await api('/api/schedule', {
    method: 'POST',
    body: {
      sendAt: new Date(Date.now() + 1000).toISOString(),
      contacts: [contacts[0]], // Ada
      template: 'Scheduled hello, {{firstName}}!',
      delayMinMs: 1,
      delayMaxMs: 2,
    },
  });
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.campaign.status, 'pending');
  assert.equal(data.agent.installed, true); // mock mode: agent short-circuited

  const done = await waitFor(async () => {
    const { data: st } = await api('/api/state');
    const c = st.schedule.find((x) => x.id === data.campaign.id);
    return c && c.status === 'done' ? c : null;
  });
  assert.equal(done.summary.sent, 1);
  assert.ok(done.reportFile);

  const sent = (await api('/api/mock/sent')).data.sent;
  assert.ok(sent.some((s) => s.text === 'Scheduled hello, Ada!'));
});

test('scheduled send can be cancelled while pending', async () => {
  const { data } = await api('/api/schedule', {
    method: 'POST',
    body: {
      sendAt: new Date(Date.now() + 3600000).toISOString(),
      contacts: [contacts[0]],
      template: 'never sends',
    },
  });
  const res = await api('/api/schedule/cancel', { method: 'POST', body: { id: data.campaign.id } });
  assert.equal(res.status, 200);
  assert.equal(res.data.campaign.status, 'cancelled');
});
