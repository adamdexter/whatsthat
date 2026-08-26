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
//
// Resident behaviour (v1.10.0): the app is meant to live in the menu bar so
// scheduled sends fire from a warm session — it starts at login hidden,
// respawns an engine that dies (bounded), warns before quitting with sends
// pending, and posts notifications for things that need a human.

const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const { spawn } = require('child_process');
const { app, BrowserWindow, Tray, Menu, dialog, nativeImage, nativeTheme, shell, Notification } = require('electron');

// Dev/test hook: WHATSTHAT_THEME=light|dark forces the appearance.
if (process.env.WHATSTHAT_THEME) nativeTheme.themeSource = process.env.WHATSTHAT_THEME;

const windowBg = () => (nativeTheme.shouldUseDarkColors ? '#1e1e20' : '#f2f2f1');

const ROOT = path.join(__dirname, '..');
const VERSION = require(path.join(ROOT, 'package.json')).version;
const PACKAGED = app.isPackaged;
const DEFAULT_PORT = Number(process.env.PORT || 3847);
const HANDSHAKE_TIMEOUT_MS = 120000; // launch-time npm update check can be slow
const POLL_MS = 15000;
const RESPAWN_DELAYS_MS = [2000, 10000, 30000];
const RESPAWN_WINDOW_MS = 10 * 60 * 1000;
const HOLD_NOTIFY_AFTER_MS = 2 * 60 * 1000;

// Data dir: explicit override, else Application Support. Named explicitly —
// Electron's default userData uses the package name (`whatsthat`) which on
// case-insensitive APFS would alias the same folder under another spelling.
const DATA_DIR_OVERRIDDEN = Boolean(process.env.WHATSTHAT_DATA_DIR);
const DATA_DIR = process.env.WHATSTHAT_DATA_DIR || path.join(app.getPath('appData'), 'WhatsThat');
const SHELL_DIR = path.join(DATA_DIR, 'shell');
// The shell's own Chromium profile (window cache, cookies, prefs) lives in a
// subfolder so it never mixes with the engine's files. Must precede the
// single-instance lock, which is kept in userData.
app.setPath('userData', SHELL_DIR);
app.setPath('sessionData', SHELL_DIR);

const { readEngineInfo, pidAlive } = require(path.join(ROOT, 'src', 'datadir'));

let serverChild = null; // set only when WE spawned the engine
let serverPort = null;
let win = null;
let tray = null;
let tearingDown = false;
let quitConfirmed = false;
let engineStatus = 'starting'; // starting | running | restarting | stopped | attached
let respawnTimer = null;
const restarts = []; // timestamps of recent respawns
let lastState = null;
let launchedHidden = false;

// ---------- shell log + prefs ----------
function slog(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(SHELL_DIR, { recursive: true });
    fs.appendFileSync(path.join(SHELL_DIR, 'shell.log'), `${line}\n`);
  } catch {
    /* logging must never break the shell */
  }
}
const PREFS_FILE = path.join(SHELL_DIR, 'shell.local.json');
function readPrefs() {
  try {
    return JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8'));
  } catch {
    return {};
  }
}
function writePrefs(patch) {
  fs.mkdirSync(SHELL_DIR, { recursive: true });
  fs.writeFileSync(PREFS_FILE, JSON.stringify({ ...readPrefs(), ...patch }, null, 2));
}

// ---------- engine discovery ----------
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

async function post(pathname) {
  if (!serverPort) throw new Error('engine not running');
  const res = await fetch(`http://127.0.0.1:${serverPort}${pathname}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status}`);
  return data;
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

// ---------- engine lifecycle ----------
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
    slog(`engine spawned (pid ${child.pid}, ${PACKAGED ? 'packaged' : 'dev'}, port ${port || 'ephemeral'})`);

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
    child.on('exit', (code, signal) => {
      if (child !== serverChild) return; // a stale child must not act after a newer spawn
      serverChild = null;
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`engine exited before listening (code ${code}) — is another instance running?`));
      } else if (!tearingDown) {
        slog(`engine exited (code ${code}${signal ? `, signal ${signal}` : ''})`);
        scheduleRespawn(code ?? signal);
      }
    });
  });
}

async function startEngine() {
  // Prefer the well-known port (stable OAuth redirect, findable by
  // run-due.js); fall back to an ephemeral one only if something that is
  // not WhatsThat squats on it.
  const port = (await portFree(DEFAULT_PORT)) ? DEFAULT_PORT : 0;
  serverPort = await spawnEngine(port);
  engineStatus = 'running';
}

// Bounded auto-restart: up to RESPAWN_DELAYS_MS.length restarts within
// RESPAWN_WINDOW_MS, with growing delays; beyond that, stop and say so once.
function scheduleRespawn(why) {
  const now = Date.now();
  while (restarts.length && now - restarts[0] > RESPAWN_WINDOW_MS) restarts.shift();
  if (restarts.length >= RESPAWN_DELAYS_MS.length) {
    engineStatus = 'stopped';
    slog(`engine restart budget exhausted (${restarts.length} restarts in ${RESPAWN_WINDOW_MS / 60000} min) — giving up`);
    refreshTray();
    notify('WhatsThat engine stopped', 'It kept crashing. Open WhatsThat to restart it.');
    dialog
      .showMessageBox({
        type: 'error',
        buttons: ['Restart engine', 'Quit WhatsThat'],
        defaultId: 0,
        cancelId: 0,
        message: 'The background engine keeps stopping',
        detail: `It exited (${why}) ${restarts.length + 1} times in ${RESPAWN_WINDOW_MS / 60000} minutes. Restart it, or quit and check ${path.join(SHELL_DIR, 'shell.log')}.`,
      })
      .then(({ response }) => {
        if (response === 0) restartEngine();
        else {
          quitConfirmed = true;
          app.quit();
        }
      });
    return;
  }
  const delay = RESPAWN_DELAYS_MS[restarts.length];
  restarts.push(now);
  engineStatus = 'restarting';
  refreshTray();
  slog(`engine restart ${restarts.length}/${RESPAWN_DELAYS_MS.length} in ${delay / 1000}s`);
  clearTimeout(respawnTimer);
  respawnTimer = setTimeout(respawn, delay);
}

async function respawn() {
  if (tearingDown) return;
  try {
    await startEngine();
    slog(`engine back on port ${serverPort}`);
    // The port may have changed: point the renderer (whose EventSource
    // would otherwise retry a dead port forever) at the new one.
    if (win) win.loadURL(`http://127.0.0.1:${serverPort}`);
    refreshTray();
  } catch (err) {
    slog(`engine respawn failed: ${err.message}`);
    scheduleRespawn('spawn failed');
  }
}

function restartEngine() {
  restarts.length = 0;
  respawn();
}

// ---------- window ----------
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
  if (app.dock && !app.dock.isVisible()) app.dock.show();
  if (win) {
    win.show();
    win.focus();
  } else if (serverPort) {
    createWindow();
  }
}

// ---------- login item / hidden launch ----------
function loginItem() {
  try {
    return app.getLoginItemSettings();
  } catch {
    return { openAtLogin: false, status: 'not-registered', wasOpenedAtLogin: false };
  }
}

function setOpenAtLogin(on) {
  try {
    app.setLoginItemSettings({ openAtLogin: on });
    writePrefs({ openAtLogin: on });
    slog(`login item ${on ? 'enabled' : 'disabled'} → ${JSON.stringify(loginItem())}`);
  } catch (err) {
    slog(`login item change failed: ${err.message}`);
  }
}

// First packaged boot enrols the login item once (user decision: the app
// should be there at login so scheduled sends fire); afterwards the tray
// checkbox is the only thing that changes it. If macOS lost the
// registration (app moved), re-register once per boot.
function applyLoginItemPolicy() {
  if (!PACKAGED) return;
  const prefs = readPrefs();
  if (!prefs.loginItemDefaultApplied) {
    setOpenAtLogin(true);
    writePrefs({ loginItemDefaultApplied: true, loginItemDefaultAppliedAt: new Date().toISOString() });
    return;
  }
  const li = loginItem();
  if (prefs.openAtLogin && !li.openAtLogin && (li.status === 'not-found' || li.status === 'not-registered')) {
    slog(`login item registration lost (${li.status}) — re-registering`);
    setOpenAtLogin(true);
  }
}

// macOS 13+ has no "open hidden" flag any more; detect a login launch from
// the launch event, with a boot-time heuristic as the safety net.
function detectHiddenLaunch() {
  if (process.argv.includes('--hidden') || process.env.WHATSTHAT_HIDDEN === '1') return true;
  if (!PACKAGED) return false;
  const li = loginItem();
  if (li.wasOpenedAtLogin) return true;
  return Boolean(li.openAtLogin && os.uptime() < 300);
}

// ---------- notifications ----------
function notify(title, body) {
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body: String(body || '').slice(0, 200) });
    n.on('click', showWindow);
    n.show();
    slog(`notified: ${title} — ${body}`);
  } catch (err) {
    slog(`notification failed: ${err.message}`);
  }
}

// Poll-and-diff (every POLL_MS via refreshTray). Transitions, not states,
// produce toasts; the first poll only seeds what we have already seen.
const seen = { seeded: false, campaigns: new Map(), holdNotified: false, attention: false, engineStopped: false };
function diffAndNotify(state) {
  if (!state) return;
  const schedule = state.schedule || [];
  if (!seen.seeded) {
    for (const c of schedule) seen.campaigns.set(c.id, c.status);
    seen.seeded = true;
    return;
  }
  for (const c of schedule) {
    const prev = seen.campaigns.get(c.id);
    if (prev && prev !== c.status) {
      const n = (c.contacts || []).length;
      if (c.status === 'done') {
        const s = c.summary || {};
        notify('Scheduled send complete', `${s.sent ?? n} sent${s.failed ? `, ${s.failed} failed` : ''}.`);
      } else if (c.status === 'failed' || c.status === 'missed') {
        notify(`Scheduled send ${c.status}`, c.error || `${n} contacts were not messaged.`);
      }
    }
    seen.campaigns.set(c.id, c.status);
  }
  const hold = state.scheduleHold;
  if (hold && hold.since && Date.now() - Date.parse(hold.since) > HOLD_NOTIFY_AFTER_MS) {
    if (!seen.holdNotified) {
      notify('Scheduled send is waiting for WhatsApp', `${hold.reason} — open WhatsThat to fix the link.`);
      seen.holdNotified = true;
    }
  } else if (!hold) {
    seen.holdNotified = false;
  }
  const wa = state.wa || {};
  const budgetGone = wa.reconnect && wa.reconnect.attempts >= wa.reconnect.max && wa.status !== 'ready';
  const needsHuman = wa.status === 'error' || budgetGone || (wa.status === 'qr' && !(win && win.isVisible()));
  if (needsHuman && !seen.attention) {
    notify('WhatsApp needs attention', wa.error || `WhatsApp is ${wa.status}.`);
    seen.attention = true;
  } else if (wa.status === 'ready') {
    seen.attention = false;
  }
}

// ---------- tray ----------
const WA_LABELS = {
  starting: 'Starting…',
  qr: 'Scan QR to link',
  authenticating: 'Authenticating…',
  ready: 'Connected',
  disconnected: 'Disconnected',
  error: 'Error',
};

function waLabel(state) {
  if (!state) return engineStatus === 'restarting' ? 'Engine restarting…' : engineStatus === 'stopped' ? 'Engine stopped' : 'Engine unreachable';
  const wa = state.wa || {};
  const b = wa.browser;
  if (b && b.status === 'downloading' && wa.status !== 'ready') return `Downloading browser… ${b.percent ?? 0}%`;
  if (wa.reconnect && wa.reconnect.attempts > 0 && wa.status === 'starting') return `Reconnecting… (${wa.reconnect.attempts}/${wa.reconnect.max})`;
  return WA_LABELS[wa.status] || wa.status || 'Unknown';
}

// Text next to the template icon: nothing when all is well.
function trayGlyph(state) {
  if (!state) return engineStatus === 'restarting' ? '…' : '!';
  const s = state.wa?.status;
  if (s === 'starting' || s === 'authenticating') return '…';
  if (s === 'ready' && !state.scheduleHold) return '';
  return '!';
}

async function refreshTray() {
  if (!tray) return;
  const state = serverPort ? await probeExisting(serverPort) : null;
  lastState = state;
  diffAndNotify(state);
  const wa = waLabel(state);
  const pending = state ? state.pendingCount ?? (state.schedule || []).filter((c) => c.status === 'pending').length : 0;
  const hold = state?.scheduleHold;
  const li = PACKAGED ? loginItem() : null;
  const agentInstalled = Boolean(state?.agent?.installed && state?.agent?.mode === 'launchd');
  const lines = [
    { label: `WhatsApp: ${wa}${state?.wa?.self?.number ? ` (${state.wa.self.number})` : ''}`, enabled: false },
    ...(pending
      ? [{ label: hold ? `${hold.count} of ${pending} scheduled waiting for WhatsApp` : `${pending} scheduled send${pending === 1 ? '' : 's'} pending`, enabled: false }]
      : []),
    ...(engineStatus === 'restarting' ? [{ label: `Engine restarting (${restarts.length}/${RESPAWN_DELAYS_MS.length})…`, enabled: false }] : []),
    ...(engineStatus === 'stopped' ? [{ label: 'Engine stopped', enabled: false }, { label: 'Restart engine', click: restartEngine }] : []),
    ...(serverChild || engineStatus !== 'attached' ? [] : [{ label: 'Attached to a terminal-started instance', enabled: false }]),
    { type: 'separator' },
    { label: 'Open WhatsThat', click: showWindow },
    {
      label: 'Reconnect WhatsApp',
      enabled: Boolean(state) && state.wa?.status !== 'ready' && !state.running,
      click: () => post('/api/whatsapp/reconnect').then(refreshTray, (err) => slog(`reconnect failed: ${err.message}`)),
    },
    {
      label: 'Open Reports Folder',
      enabled: Boolean(state?.paths?.reportsDir),
      click: () => {
        const dir = state?.paths?.reportsDir;
        if (!dir) return;
        fs.mkdirSync(dir, { recursive: true });
        shell.openPath(dir);
      },
    },
    { type: 'separator' },
    ...(li
      ? li.status === 'requires-approval'
        ? [
            {
              label: 'Start at Login — approve in System Settings…',
              click: () => shell.openExternal('x-apple.systempreferences:com.apple.LoginItems-Settings.extension'),
            },
          ]
        : [{ label: 'Start at Login', type: 'checkbox', checked: Boolean(li.openAtLogin), click: (item) => (setOpenAtLogin(item.checked), refreshTray()) }]
      : [{ label: 'Start at Login (packaged app only)', enabled: false }]),
    ...(agentInstalled
      ? [
          {
            label: 'Remove Background Scheduler',
            click: () => post('/api/agent/uninstall').then(refreshTray, (err) => slog(`uninstall failed: ${err.message}`)),
          },
        ]
      : []),
    { type: 'separator' },
    { label: 'Quit WhatsThat', role: 'quit' },
  ];
  tray.setToolTip(`WhatsThat v${VERSION} — WhatsApp: ${wa}`);
  const glyph = trayGlyph(state);
  if (tray.getTitle() !== glyph) tray.setTitle(glyph);
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
  setInterval(refreshTray, POLL_MS);
}

// ---------- quit guard ----------
// Quitting kills the warm session; with sends pending that deserves a
// confirmation whose wording says whether the launchd fallback will cover.
async function confirmQuit() {
  const state = serverPort ? await probeExisting(serverPort) : null;
  const pending = state ? state.pendingCount ?? 0 : 0;
  const running = Boolean(state?.running);
  if (!state || (!pending && !running)) {
    quitConfirmed = true;
    app.quit();
    return;
  }
  const fallback = Boolean(state.agent?.installed && state.agent?.mode === 'launchd');
  let message;
  let detail;
  if (running) {
    message = 'A send is in progress';
    detail = 'Quitting stops it mid-run. Contacts already messaged are in the report; the rest will not be sent.';
  } else {
    message = `${pending} scheduled send${pending === 1 ? '' : 's'} pending`;
    detail = fallback
      ? 'They will still go out through the background scheduler, which starts its own WhatsApp session — slower, and it needs the link to be healthy. Closing the window instead keeps WhatsThat warm in the menu bar.'
      : 'They will NOT go out while WhatsThat is quit. Close the window instead — WhatsThat keeps running in the menu bar.';
  }
  if (app.dock) app.dock.show();
  app.focus({ steal: true });
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    buttons: ['Quit', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    message,
    detail,
  });
  if (response === 0) {
    quitConfirmed = true;
    app.quit();
  }
}

// ---------- app ----------
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
    slog(`shell v${VERSION} starting (${PACKAGED ? 'packaged' : 'dev'}, data ${DATA_DIR})`);
    applyLoginItemPolicy();
    launchedHidden = detectHiddenLaunch();
    if (PACKAGED) slog(`login item: ${JSON.stringify(loginItem())}; hidden launch: ${launchedHidden}`);
    if (launchedHidden && app.dock) app.dock.hide();

    // Packaged builds get the Dock icon from the bundle; in dev the process
    // is Electron's, so set it by hand.
    if (!PACKAGED && app.dock) {
      const icon = path.join(__dirname, 'assets', 'icon.png');
      if (fs.existsSync(icon)) app.dock.setIcon(icon);
    }

    const { powerMonitor } = require('electron');
    powerMonitor.on('shutdown', () => {
      quitConfirmed = true; // never block logout/shutdown with a dialog
      app.quit();
    });

    createTray(); // first, so a slow engine start is visible in the menu bar

    const existing = await findExisting();
    if (existing) {
      serverPort = existing; // terminal-started instance — attach, don't spawn
      engineStatus = 'attached';
      slog(`attached to a running engine on port ${existing}`);
    } else {
      try {
        await startEngine();
      } catch (err) {
        slog(`engine failed to start: ${err.message}`);
        dialog.showErrorBox('WhatsThat could not start', err.message);
        app.exit(1);
        return;
      }
    }
    if (!launchedHidden) createWindow();
    refreshTray();
  });

  app.on('activate', showWindow); // Dock icon click

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', (e) => {
    if (tearingDown) return;
    // Attach mode: quitting the shell leaves the terminal engine (and its
    // scheduling) alone — nothing to guard.
    if (serverChild && !quitConfirmed) {
      e.preventDefault();
      confirmQuit();
      return;
    }
    tearingDown = true;
    clearTimeout(respawnTimer);
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
      slog('quitting — stopping engine');
      child.kill('SIGTERM'); // engine's signal handler destroys the browser cleanly
    }
  });
}
