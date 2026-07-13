'use strict';

// End-to-end test: boots the real server in mock mode and drives the HTTP API
// through the full flow — load contacts, preview, test send, run, report.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const PORT = 3931;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsthat-e2e-'));
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
    env: { ...process.env, WHATSTHAT_MOCK: '1', PORT: String(PORT), WHATSTHAT_NO_OPEN: '1', WHATSTHAT_DATA_DIR: DATA_DIR },
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

  // Wait for the run to finish, then check the report list.
  const reportName = await waitFor(async () => {
    const { data: d } = await api('/api/reports');
    return d.reports && d.reports[0];
  });
  const { data: report } = await api(`/api/reports/${reportName}`);
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
