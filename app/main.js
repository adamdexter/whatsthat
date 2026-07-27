'use strict';

// WhatsThat Mac app shell (Phase A — see plans/CLAUDE.md).
// Owns a window + tray around the existing engine: attaches to an
// already-running instance on the default port, otherwise spawns
// scripts/launch.js (keeping the dev-mode npm auto-update) using Electron's
// own binary as node (ELECTRON_RUN_AS_NODE — no separate runtime needed).
// Quit tears the child down via SIGTERM; the engine's v1.4.0 handler makes
// that clean.

const path = require('path');
const { spawn } = require('child_process');
const { app, BrowserWindow, Tray, Menu, dialog, nativeImage } = require('electron');

const ROOT = path.join(__dirname, '..');
const VERSION = require(path.join(ROOT, 'package.json')).version;
const DEFAULT_PORT = Number(process.env.PORT || 3847);
const HANDSHAKE_TIMEOUT_MS = 120000; // launch-time npm update check can be slow

let serverChild = null; // set only when WE spawned the engine
let serverPort = null;
let win = null;
let tray = null;
let tearingDown = false;

const stateUrl = (port) => `http://127.0.0.1:${port}/api/state`;

async function probeExisting(port) {
  try {
    const res = await fetch(stateUrl(port), { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const state = await res.json();
    return state && state.version ? state : null;
  } catch {
    return null;
  }
}

function spawnEngine() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'launch.js')], {
      cwd: ROOT,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        WHATSTHAT_NO_OPEN: '1', // the shell owns the window
        PORT: String(DEFAULT_PORT),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    serverChild = child;

    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error(`engine did not announce a port within ${HANDSHAKE_TIMEOUT_MS / 1000}s`));
      }
    }, HANDSHAKE_TIMEOUT_MS);

    let out = '';
    child.stdout.on('data', (d) => {
      process.stdout.write(d); // keep the engine log visible in dev
      out += d;
      const m = out.match(/^whatsthat-listening (\d+)$/m);
      if (m && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    child.stderr.on('data', (d) => process.stderr.write(d));
    child.on('exit', (code) => {
      serverChild = null;
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`engine exited before listening (code ${code}) — is another instance running?`));
      } else if (!tearingDown) {
        // Engine died under us (crash or external kill) — surface it.
        dialog.showErrorBox('WhatsThat engine stopped', `The background engine exited (code ${code}). Quit and relaunch the app.`);
      }
    });
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 940,
    minWidth: 720,
    minHeight: 520,
    title: 'WhatsThat',
  });
  win.loadURL(`http://127.0.0.1:${serverPort}`);
  win.on('close', (e) => {
    // macOS convention: closing the window keeps the app (and engine —
    // scheduled sends!) alive; Cmd+Q quits for real.
    if (!tearingDown && process.platform === 'darwin') {
      e.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => {
    win = null;
  });
}

function showWindow() {
  if (win) {
    win.show();
    win.focus();
  } else if (serverPort) {
    createWindow();
  }
}

const WA_LABELS = {
  starting: 'Starting…',
  qr: 'Scan QR to link',
  authenticating: 'Authenticating…',
  ready: 'Connected',
  disconnected: 'Disconnected',
  error: 'Error',
};

async function refreshTray() {
  if (!tray || !serverPort) return;
  const state = await probeExisting(serverPort);
  const wa = state ? WA_LABELS[state.wa?.status] || state.wa?.status : 'Engine unreachable';
  const pending = state ? (state.schedule || []).filter((c) => c.status === 'pending').length : 0;
  const lines = [
    { label: `WhatsApp: ${wa}${state?.wa?.self?.number ? ` (${state.wa.self.number})` : ''}`, enabled: false },
    ...(pending ? [{ label: `${pending} scheduled send${pending === 1 ? '' : 's'} pending`, enabled: false }] : []),
    ...(serverChild ? [] : [{ label: 'Attached to a terminal-started instance', enabled: false }]),
    { type: 'separator' },
    { label: 'Open WhatsThat', click: showWindow },
    { type: 'separator' },
    { label: 'Quit WhatsThat', role: 'quit' },
  ];
  tray.setToolTip(`WhatsThat v${VERSION} — WhatsApp: ${wa}`);
  tray.setContextMenu(Menu.buildFromTemplate(lines));
}

function createTray() {
  tray = new Tray(nativeImage.createEmpty());
  tray.setTitle('💬'); // text-only menu-bar presence
  refreshTray();
  setInterval(refreshTray, 15000);
}

// Only one shell at a time; a second launch focuses the first.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);

  app.setName('WhatsThat');
  app.setAboutPanelOptions({
    applicationName: 'WhatsThat',
    applicationVersion: VERSION,
  });

  app.whenReady().then(async () => {
    const existing = await probeExisting(DEFAULT_PORT);
    if (existing) {
      serverPort = DEFAULT_PORT; // terminal-started instance — attach, don't spawn
    } else {
      try {
        serverPort = await spawnEngine();
      } catch (err) {
        dialog.showErrorBox('WhatsThat could not start', err.message);
        app.exit(1);
        return;
      }
    }
    createWindow();
    createTray();
  });

  app.on('activate', showWindow); // Dock icon click

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', (e) => {
    tearingDown = true;
    if (serverChild && serverChild.exitCode === null) {
      e.preventDefault();
      const child = serverChild;
      const force = setTimeout(() => {
        child.kill('SIGKILL');
        app.exit(0);
      }, 6000);
      child.once('exit', () => {
        clearTimeout(force);
        app.exit(0);
      });
      child.kill('SIGTERM'); // engine's signal handler destroys the browser cleanly
    }
  });
}
