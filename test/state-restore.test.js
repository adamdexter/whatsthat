'use strict';

// State persistence across restarts: the draft round-trips the loaded contact
// list + selection through /api/draft and /api/state, and `--fresh` sets the
// previous draft aside so the app boots clean.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { TOKEN, AUTH } = require('./helpers');

const PORT = 3932;
const BASE = `http://127.0.0.1:${PORT}`;
const SERVER = path.join(__dirname, '..', 'server.js');

async function api(p, opts = {}) {
  const res = await fetch(`${BASE}${p}`, {
    headers: { 'Content-Type': 'application/json', ...AUTH },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

function startServer(dataDir, extraArgs = []) {
  const child = spawn(process.execPath, [SERVER, ...extraArgs], {
    env: {
      ...process.env,
      WHATSTHAT_MOCK: '1',
      PORT: String(PORT),
      WHATSTHAT_NO_OPEN: '1',
      WHATSTHAT_API_TOKEN: TOKEN,
      WHATSTHAT_DATA_DIR: dataDir,
      npm_config_fresh: '', // never inherit a --fresh from the test invocation
    },
    stdio: 'ignore',
  });
  return child;
}

async function waitForServer(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { status } = await api('/api/state');
      if (status === 200) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not come up');
}

const stop = (child) =>
  new Promise((resolve) => {
    child.on('exit', resolve);
    child.kill();
  });

const CACHE = {
  headers: ['firstName', 'phone'],
  contacts: [
    { id: 0, phone: '+14155550101', fields: { firstName: 'Ada', phone: '415-555-0101' } },
    { id: 1, phone: '+14155550102', fields: { firstName: 'Grace', phone: '415-555-0102' } },
    { id: 2, phone: '+14155550103', fields: { firstName: 'Katherine', phone: '415-555-0103' } },
  ],
  source: 'sheet',
  loadedAt: '2026-07-22T12:00:00.000Z',
};

test('draft persists contactsCache/selectedIds/previewId across a server restart', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsthat-restore-'));
  let server = startServer(dataDir);
  await waitForServer();

  await api('/api/draft', {
    method: 'POST',
    body: { template: 'Hey {{firstName}}', contactsCache: CACHE, selectedIds: [0, 2], previewId: 2 },
  });
  await stop(server);

  server = startServer(dataDir);
  await waitForServer();
  const { data } = await api('/api/state');
  assert.equal(data.draft.template, 'Hey {{firstName}}');
  assert.equal(data.draft.contactsCache.contacts.length, 3);
  assert.equal(data.draft.contactsCache.loadedAt, CACHE.loadedAt);
  assert.deepEqual(data.draft.selectedIds, [0, 2]);
  assert.equal(data.draft.previewId, 2);
  await stop(server);
});

test('--fresh sets the draft aside as draft.backup.local.json and boots clean', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsthat-fresh-'));
  let server = startServer(dataDir);
  await waitForServer();
  await api('/api/draft', { method: 'POST', body: { template: 'old message', selectedIds: [1] } });
  await stop(server);

  server = startServer(dataDir, ['--fresh']);
  await waitForServer();
  const { data } = await api('/api/state');
  assert.deepEqual(data.draft, {}, 'draft is empty after --fresh');
  const backup = JSON.parse(fs.readFileSync(path.join(dataDir, 'draft.backup.local.json'), 'utf8'));
  assert.equal(backup.template, 'old message');
  assert.ok(!fs.existsSync(path.join(dataDir, 'draft.local.json')), 'old draft file is gone');

  // New work after a fresh boot persists normally again.
  await api('/api/draft', { method: 'POST', body: { template: 'new message' } });
  const after = await api('/api/state');
  assert.equal(after.data.draft.template, 'new message');
  await stop(server);
});

test('/api/state exposes the auto-update record', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsthat-updrec-'));
  fs.writeFileSync(
    path.join(dataDir, 'update.local.json'),
    JSON.stringify({ checkedAt: '2026-07-22T12:00:00.000Z', installed: '1.34.8', previous: '1.34.7', updated: true, patchRetired: true })
  );
  const server = startServer(dataDir);
  await waitForServer();
  const { data } = await api('/api/state');
  assert.equal(data.update.updated, true);
  assert.equal(data.update.previous, '1.34.7');
  await stop(server);
});
