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

const SERVER = path.join(__dirname, '..', 'server.js');

function startServer(env) {
  return spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      WHATSTHAT_MOCK: '1',
      WHATSTHAT_NO_OPEN: '1',
      WHATSTHAT_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'whatsthat-appmode-')),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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
    const res = await fetch(`http://127.0.0.1:${port}/api/state`);
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

test('WHATSTHAT_PACKAGED is exposed in state and skips the launchd agent', async () => {
  const server = startServer({ PORT: '3935', WHATSTHAT_PACKAGED: '1' });
  try {
    const port = await waitForHandshake(server);
    const state = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
    assert.equal(state.packaged, true, 'packaged flag plumbed through to state');
    assert.equal(state.agentInstalled, true, 'agent path skipped');
  } finally {
    await stop(server);
  }
});

test('createWhatsApp anchors the auth dir to dataDir', () => {
  const { createWhatsApp } = require('../src/whatsapp');
  const wa = createWhatsApp({ mock: false, dataDir: '/tmp/appmode-x' });
  assert.equal(wa._authDir, path.join('/tmp/appmode-x', '.wwebjs_auth'));
  const def = createWhatsApp({ mock: false });
  assert.equal(def._authDir, path.join(__dirname, '..', '.wwebjs_auth'), 'default stays repo-anchored');
});
