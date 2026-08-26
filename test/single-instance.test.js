'use strict';

// Only one instance may run per port (the port doubles as the WhatsApp
// session lock): a second launch must exit with a helpful message instead of
// booting an invisible client, and SIGTERM must shut an instance down cleanly.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const PORT = 3933;
const SERVER = path.join(__dirname, '..', 'server.js');

function startServer(dataDir, { capture = false } = {}) {
  return spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      WHATSTHAT_MOCK: '1',
      PORT: String(PORT),
      WHATSTHAT_NO_OPEN: '1',
      WHATSTHAT_DATA_DIR: dataDir,
    },
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'ignore',
  });
}

async function waitForServer(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/ping`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not come up');
}

const waitExit = (child, timeoutMs = 10000) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('child did not exit in time')), timeoutMs);
    child.on('exit', (code, signal) => {
      clearTimeout(t);
      resolve({ code, signal });
    });
  });

test('second instance on the same port exits with a helpful message', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsthat-single-'));
  const first = startServer(dataDir);
  try {
    await waitForServer();

    const second = startServer(dataDir, { capture: true });
    let out = '';
    second.stdout.on('data', (d) => (out += d));
    second.stderr.on('data', (d) => (out += d));
    const { code } = await waitExit(second);

    assert.equal(code, 1, 'second instance exits non-zero');
    assert.match(out, /already using port 3933/);
    assert.match(out, /WhatsThat v\d+\.\d+\.\d+/, 'identifies the running instance');
    assert.match(out, /lsof -nP -iTCP:3933/, 'gives the cleanup command');
  } finally {
    // Always reap — a leaked child keeps the test-runner process alive forever.
    first.kill();
    await waitExit(first).catch(() => first.kill('SIGKILL'));
  }
});

test('SIGTERM shuts the instance down cleanly (exit 0, port freed)', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsthat-sigterm-'));
  const server = startServer(dataDir);
  await waitForServer();

  server.kill('SIGTERM');
  const { code } = await waitExit(server);
  assert.equal(code, 0, 'graceful shutdown exits 0');

  // Port is actually free again: a new instance can bind immediately.
  const next = startServer(dataDir);
  await waitForServer();
  next.kill('SIGTERM');
  await waitExit(next);
});
