'use strict';

// Put the freshly built WhatsThat.app into /Applications and relaunch it.
// `npm run install-app` = `npm run dist` + this. Refuses to swap the bundle
// under a send in progress; quits a running app first (the quit guard may
// ask about pending scheduled sends — answer it in the dialog).

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { readEngineInfo, appSupportDir } = require('../src/datadir');

const ROOT = path.join(__dirname, '..');
const BUILT = path.join(ROOT, 'dist', 'mac-arm64', 'WhatsThat.app');
const TARGET = process.argv[2] || '/Applications/WhatsThat.app';
const PORT = 3847;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const version = (app) => {
  try {
    return execFileSync('defaults', ['read', path.join(app, 'Contents', 'Info.plist'), 'CFBundleShortVersionString'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
};
const appProcesses = () => {
  const r = spawnSync('pgrep', ['-f', `${TARGET}/Contents/MacOS/WhatsThat`], { encoding: 'utf8' });
  return r.stdout.trim().split('\n').filter(Boolean);
};

async function ping() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/ping`, { signal: AbortSignal.timeout(1500) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function main() {
  if (!fs.existsSync(BUILT)) throw new Error(`nothing built at ${BUILT} — run \`npm run dist\` first`);
  const next = version(BUILT);
  console.log(`built: v${next}; installed: ${version(TARGET) ? `v${version(TARGET)}` : 'none'}`);

  const live = await ping();
  if (live) {
    const info = readEngineInfo(live.dataDir || appSupportDir());
    if (info && info.token) {
      const state = await (await fetch(`http://127.0.0.1:${PORT}/api/state`, { headers: { 'X-WhatsThat-Token': info.token } })).json();
      if (state.running) throw new Error('a send is in progress — try again when it has finished');
      if (state.pendingCount) console.log(`note: ${state.pendingCount} scheduled send(s) pending — the app will ask before quitting; confirm in the dialog`);
    }
  }
  if (appProcesses().length) {
    console.log('quitting the running app…');
    spawnSync('osascript', ['-e', 'quit app "WhatsThat"']);
    for (let i = 0; i < 30 && appProcesses().length; i++) await sleep(500);
    if (appProcesses().length) throw new Error('the app is still running (a dialog may be waiting for you) — quit it, then rerun');
  }

  fs.rmSync(TARGET, { recursive: true, force: true });
  execFileSync('ditto', [BUILT, TARGET]);
  console.log(`installed v${version(TARGET)} → ${TARGET}`);
  spawnSync('open', ['-a', TARGET]);
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const p = await ping();
    if (p) {
      console.log(`running: v${p.version} on ${PORT} (WhatsApp: ${p.wa.status})`);
      return;
    }
  }
  console.log('launched, but the engine has not answered yet — check the menu bar');
}

main().catch((err) => {
  console.error(`✗ ${err.message}`);
  process.exit(1);
});
