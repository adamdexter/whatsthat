'use strict';

// Engine flags added for the Mac app shell: PORT=0 with a machine-readable
// port handshake, WHATSTHAT_PACKAGED, and the dataDir-based WhatsApp auth
// path.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { TOKEN, AUTH } = require('./helpers');

const SERVER = path.join(__dirname, '..', 'server.js');

function startServer(env) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsthat-appmode-'));
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      WHATSTHAT_MOCK: '1',
      WHATSTHAT_NO_OPEN: '1',
      WHATSTHAT_API_TOKEN: TOKEN,
      WHATSTHAT_DATA_DIR: dataDir,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.dataDir = env && env.WHATSTHAT_DATA_DIR ? env.WHATSTHAT_DATA_DIR : dataDir;
  child.stderrText = '';
  child.stderr.on('data', (d) => (child.stderrText += d));
  return child;
}

const waitForHandshake = (child, timeoutMs = 15000) =>
  new Promise((resolve, reject) => {
    let out = '';
    const t = setTimeout(() => reject(new Error(`no handshake line in: ${out}`)), timeoutMs);
    child.stdout.on('data', (d) => {
      out += d;
      const m = out.match(/^whatsthat-listening (\d+)$/m);
      if (m) {
        clearTimeout(t);
        resolve(Number(m[1]));
      }
    });
  });

const stop = (child) =>
  new Promise((resolve) => {
    child.on('exit', resolve);
    child.kill();
  });

test('PORT=0 binds an ephemeral port and announces it on stdout', async () => {
  const server = startServer({ PORT: '0' });
  try {
    const port = await waitForHandshake(server);
    assert.ok(port > 0 && port !== 3847, `got ephemeral port ${port}`);
    const res = await fetch(`http://127.0.0.1:${port}/api/state`, { headers: AUTH });
    assert.equal(res.status, 200);
    const state = await res.json();
    assert.ok(state.version, 'state served on the announced port');
  } finally {
    await stop(server);
  }
});

test('fixed port also announces the handshake line', async () => {
  const server = startServer({ PORT: '3934' });
  try {
    const port = await waitForHandshake(server);
    assert.equal(port, 3934);
  } finally {
    await stop(server);
  }
});

test('WHATSTHAT_PACKAGED is exposed in state and pins the engine (mock still skips launchctl)', async () => {
  const server = startServer({ PORT: '3935', WHATSTHAT_PACKAGED: '1' });
  try {
    const port = await waitForHandshake(server);
    const state = await (await fetch(`http://127.0.0.1:${port}/api/state`, { headers: AUTH })).json();
    assert.equal(state.packaged, true, 'packaged flag plumbed through to state');
    assert.equal(state.agentInstalled, true, 'agent path skipped in mock');
    assert.equal(state.agent.mode, 'none', 'mock never touches launchctl (PACKAGED alone no longer implies NO_AGENT)');
    assert.equal(state.update.pinned, true, 'no launch-time updater in the app');
    assert.match(state.update.installed, /^\d+\.\d+\.\d+/, 'reports the bundled whatsapp-web.js version');
    assert.equal(state.engine.whatsappWebJs, state.update.installed);
    assert.match(state.engine.chromeBuild, /^\d+\.\d+\.\d+\.\d+$/);
  } finally {
    await stop(server);
  }
});

test('state reports the data dir, derived paths, and browser readiness', async () => {
  const server = startServer({ PORT: '3936' });
  try {
    const port = await waitForHandshake(server);
    const state = await (await fetch(`http://127.0.0.1:${port}/api/state`, { headers: AUTH })).json();
    assert.equal(state.dataDir, server.dataDir);
    assert.equal(state.paths.reportsDir, path.join(server.dataDir, 'reports'));
    assert.equal(state.paths.authDir, path.join(server.dataDir, '.wwebjs_auth'));
    assert.equal(state.wa.browser.status, 'ready');
    assert.equal(state.wa.browser.source, 'mock');
    assert.equal(state.migration, null);
    assert.deepEqual(state.run, { active: false, total: 0, done: 0, sent: 0, failed: 0, cancelled: 0, startedAt: null });
    assert.equal(state.paths.logDir, path.join(server.dataDir, 'logs'));
    assert.equal(state.update.pinned, undefined, 'terminal mode keeps the real updater record');
  } finally {
    await stop(server);
  }
});

test('engine.local.json names the occupant while up and is removed on exit', async () => {
  const server = startServer({ PORT: '3937' });
  const file = path.join(server.dataDir, 'engine.local.json');
  try {
    const port = await waitForHandshake(server);
    const info = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(info.pid, server.pid);
    assert.equal(info.port, port);
    assert.equal(info.mock, true);
    assert.ok(info.version);
  } finally {
    await stop(server);
  }
  assert.ok(!fs.existsSync(file), 'removed on clean shutdown');
});

test('a second engine on the same data dir but another port bows out', async () => {
  const first = startServer({ PORT: '3938' });
  try {
    await waitForHandshake(first);
    const second = startServer({ PORT: '0', WHATSTHAT_DATA_DIR: first.dataDir });
    const code = await new Promise((resolve) => second.on('exit', resolve));
    assert.equal(code, 1);
    assert.match(second.stderrText, /already running on this data directory/);
    assert.match(second.stderrText, /port 3938/);
    const info = JSON.parse(fs.readFileSync(path.join(first.dataDir, 'engine.local.json'), 'utf8'));
    assert.equal(info.pid, first.pid, 'the loser did not clobber the occupant file');
  } finally {
    await stop(first);
  }
});

test('WHATSTHAT_MIGRATE_FROM moves a checkout\'s data in on boot (once)', async () => {
  const from = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsthat-oldrepo-'));
  fs.mkdirSync(path.join(from, '.wwebjs_auth', 'session', 'Default'), { recursive: true });
  fs.writeFileSync(path.join(from, '.wwebjs_auth', 'session', 'Default', 'Cookies'), 'c');
  fs.writeFileSync(path.join(from, 'draft.local.json'), JSON.stringify({ template: 'migrated {{firstName}}' }));
  const server = startServer({ PORT: '3939', WHATSTHAT_MIGRATE_FROM: from });
  try {
    const port = await waitForHandshake(server);
    const state = await (await fetch(`http://127.0.0.1:${port}/api/state`, { headers: AUTH })).json();
    assert.equal(state.migration.migrated, true);
    assert.deepEqual(state.migration.copied.sort(), ['.wwebjs_auth', 'draft.local.json']);
    assert.equal(state.draft.template, 'migrated {{firstName}}', 'the migrated draft is what the server serves');
    assert.ok(fs.existsSync(path.join(server.dataDir, '.migrated-from.json')));
    assert.ok(fs.existsSync(path.join(from, 'draft.local.json')), 'source left in place');
  } finally {
    await stop(server);
  }
  const again = startServer({ PORT: '3939', WHATSTHAT_MIGRATE_FROM: from, WHATSTHAT_DATA_DIR: server.dataDir });
  try {
    const port = await waitForHandshake(again);
    const state = await (await fetch(`http://127.0.0.1:${port}/api/state`, { headers: AUTH })).json();
    assert.equal(state.migration, null, 'second boot is a no-op');
  } finally {
    await stop(again);
  }
});

test('createWhatsApp anchors the auth dir to dataDir', () => {
  const { createWhatsApp } = require('../src/whatsapp');
  const wa = createWhatsApp({ mock: false, dataDir: '/tmp/appmode-x' });
  assert.equal(wa._authDir, path.join('/tmp/appmode-x', '.wwebjs_auth'));
  assert.equal(wa._cacheDir, path.join('/tmp/appmode-x', '.wwebjs_cache'), 'html cache anchored too (never cwd)');
  const def = createWhatsApp({ mock: false });
  assert.equal(def._authDir, path.join(__dirname, '..', '.wwebjs_auth'), 'default stays repo-anchored');
});
