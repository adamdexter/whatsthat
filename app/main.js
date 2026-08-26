'use strict';

// WhatsThat Mac app shell — window + tray around the engine (server.js).
//
// Attaches to an already-running engine on the default port when one answers
// /api/state (a terminal `npm start`), otherwise spawns one using Electron's
// own binary as node (ELECTRON_RUN_AS_NODE — no separate runtime needed).
// Packaged (app.isPackaged): runs server.js directly with the engine pinned
// to this release and data in ~/Library/Application Support/WhatsThat.
// Dev (`npm run app`): runs scripts/launch.js (keeps the npm auto-update)
// against the same data dir, migrating the repo's data there once.
// Quit tears the child down via SIGTERM; the engine's v1.4.0 handler makes
// that clean.

const path = require('path');
const fs = require('fs');
const net = require('net');
const { spawn } = require('child_process');
const { app, BrowserWindow, Tray, Menu, dialog, nativeImage, nativeTheme, shell } = require('electron');

// Dev/test hook: WHATSTHAT_THEME=light|dark forces the appearance.
if (process.env.WHATSTHAT_THEME) nativeTheme.themeSource = process.env.WHATSTHAT_THEME;

const windowBg = () => (nativeTheme.shouldUseDarkColors ? '#1e1e20' : '#f2f2f1');

const ROOT = path.join(__dirname, '..');
const VERSION = require(path.join(ROOT, 'package.json')).version;
const PACKAGED = app.isPackaged;
const DEFAULT_PORT = Number(process.env.PORT || 3847);
const HANDSHAKE_TIMEOUT_MS = 120000; // launch-time npm update check can be slow

// Data dir: explicit override, else Application Support. Named explicitly —
// Electron's default userData uses the package name (`whatsthat`) which on
// case-insensitive APFS would alias the same folder under another spelling.
const DATA_DIR_OVERRIDDEN = Boolean(process.env.WHATSTHAT_DATA_DIR);
const DATA_DIR = process.env.WHATSTHAT_DATA_DIR || path.join(app.getPath('appData'), 'WhatsThat');
// The shell's own Chromium profile (window cache, cookies, prefs) lives in a
// subfolder so it never mixes with the engine's files. Must precede the
// single-instance lock, which is kept in userData.
app.setPath('userData', path.join(DATA_DIR, 'shell'));
app.setPath('sessionData', path.join(DATA_DIR, 'shell'));

const { readEngineInfo, pidAlive } = require(path.join(ROOT, 'src', 'datadir'));

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

// A running engine to attach to: the default port first, then whatever
// engine.local.json says is serving our data dir (an ephemeral-port fallback).
async function findExisting() {
  if (await probeExisting(DEFAULT_PORT)) return DEFAULT_PORT;
  const info = readEngineInfo(DATA_DIR);
  if (info && info.port !== DEFAULT_PORT && pidAlive(info.pid) && (await probeExisting(info.port))) return info.port;
  return null;
}

const portFree = (port) =>
  new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });

function spawnEngine(port) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const script = PACKAGED ? path.join(ROOT, 'server.js') : path.join(ROOT, 'scripts', 'launch.js');
    const child = spawn(process.execPath, [script], {
      cwd: DATA_DIR, // the engine's library writes cwd-relative caches
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        WHATSTHAT_NO_OPEN: '1', // the shell owns the window
        WHATSTHAT_DATA_DIR: DATA_DIR,
        PORT: String(port),
        ...(PACKAGED
          ? { WHATSTHAT_PACKAGED: '1' }
          : // Dev shell: move the checkout's data into Application Support
            // once (copy + verify, never deletes) — unless a test pointed us
            // at a scratch dir.
            DATA_DIR_OVERRIDDEN
            ? {}
            : { WHATSTHAT_MIGRATE_FROM: ROOT }),
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
    // Native chrome: frameless with inset traffic lights — the page's
    // toolbar header is the titlebar (drag region set in CSS).
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 19, y: 18 },
    backgroundColor: windowBg(),
  });
  nativeTheme.on('updated', () => {
    if (win) win.setBackgroundColor(windowBg());
  });
  // Google refuses OAuth inside an embedded browser, and nothing else the
  // page opens belongs in a second Electron window: hand every window.open
  // to the default browser (the OAuth callback still lands on our port).
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
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

function waLabel(state) {
  if (!state) return 'Engine unreachable';
  const b = state.wa?.browser;
  if (b && b.status === 'downloading') return `Downloading browser… ${b.percent ?? 0}%`;
  return WA_LABELS[state.wa?.status] || state.wa?.status;
}

async function refreshTray() {
  if (!tray || !serverPort) return;
  const state = await probeExisting(serverPort);
  const wa = waLabel(state);
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
  // Monochrome template image (app/assets/trayTemplate.png, @2x auto-loaded);
  // the "Template" suffix lets macOS tint it for light/dark menu bars. Falls
  // back to a text glyph when the asset is missing.
  const img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'trayTemplate.png'));
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
  if (img.isEmpty()) tray.setTitle('💬');
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
    // Packaged builds get the Dock icon from the bundle; in dev the process
    // is Electron's, so set it by hand.
    if (!PACKAGED && app.dock) {
      const icon = path.join(__dirname, 'assets', 'icon.png');
      if (fs.existsSync(icon)) app.dock.setIcon(icon);
    }

    const existing = await findExisting();
    if (existing) {
      serverPort = existing; // terminal-started instance — attach, don't spawn
    } else {
      try {
        // Prefer the well-known port (stable OAuth redirect, findable by
        // run-due.js); fall back to an ephemeral one only if something
        // that is not WhatsThat squats on it.
        const port = (await portFree(DEFAULT_PORT)) ? DEFAULT_PORT : 0;
        serverPort = await spawnEngine(port);
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
        // Engine did not go quietly: reap its browser too, or it would keep
        // the WhatsApp profile locked.
        const info = readEngineInfo(DATA_DIR);
        if (info && info.pid === child.pid && info.chromePid) {
          try {
            process.kill(info.chromePid, 'SIGKILL');
          } catch {
            /* already gone */
          }
        }
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
