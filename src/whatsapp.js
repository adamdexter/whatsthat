'use strict';

const path = require('path');
const QRCode = require('qrcode');
const { ensureBrowser } = require('./browser');

// NOTE on version pinning: don't. We tried pinning the WA Web build via
// webVersion/webVersionCache (v1.3.1) — on 2.3000.x builds the page
// self-updates to the live version right after loading the pinned html,
// which forces a reload in the middle of the library's startup sequence and
// wedges it silently (an in-flight page evaluation dies; the rejection is
// swallowed inside the exposeFunction bridge and 'ready' never fires). The
// same race happens unpinned whenever WA ships a build mid-launch, so the
// real defense is the self-healing startup watchdog below.
// (webVersionCache.path below only relocates the library's html cache — it
// does not pin anything.)

// Both implementations expose the same interface:
//   initialize()                 — start connecting (resolves when startup settles)
//   getState()                   — { status, qrDataUrl, self, error, browser }
//   onUpdate(cb)                 — cb(state) on every state change
//   checkNumber(e164)            — serialized chat id, or null if not on WhatsApp
//   send(chatId, text)
//   sendToSelf(text)
//   logout()
//   destroy()
//   reconnect()                  — manual relaunch (resets the retry budget)
//   browserPid()                 — pid of the Chromium we launched, or null
// status: 'starting' | 'qr' | 'authenticating' | 'ready' | 'disconnected' | 'error'
// browser: { status: 'resolving' | 'downloading' | 'ready' | 'error', percent, source, error }
// reconnect: { attempts, max, lastReason, nextAt, count }  — automatic relaunch budget
// liveness: { checkedAt, waState, unhealthy }               — periodic page probe (ready only)

// A resident app lives with a session for weeks. Three things go wrong and
// the library reports them differently:
//   - WhatsApp drops/evicts the session → 'disconnected' with a reason;
//   - the page wedges without telling anyone → nothing at all (wwebjs does
//     not watch puppeteer's browser/page lifecycle) — hence the liveness probe;
//   - the user unlinks from the phone → 'disconnected' LOGOUT/UNPAIRED, which
//     only a human (QR scan) can fix.
// Everything recoverable funnels into relaunch(): destroy + initialize with
// a capped exponential backoff, shared with the startup watchdog.
const BACKOFF_MS = [5000, 15000, 45000, 120000, 300000];
const MAX_ATTEMPTS = 5;
const STABLE_MS = 10 * 60 * 1000; // ready this long ⇒ the retry budget resets
const LIVENESS_EVERY_MS = 3 * 60 * 1000;
const LIVENESS_TIMEOUT_MS = 20000;
const LIVENESS_RESET_AT = 3; // consecutive non-CONNECTED probes before Socket.reconnect()
const LIVENESS_RELAUNCH_AT = 5; // …before a full relaunch

function classifyDisconnect(reason) {
  const r = String(reason || '').toUpperCase();
  if (r === 'LOGOUT' || r === 'UNPAIRED' || r === 'UNPAIRED_IDLE') return 'relink';
  if (r === 'TOS_BLOCK' || r === 'SMB_TOS_BLOCK' || r === 'PROXYBLOCK') return 'fatal';
  return 'relaunch'; // CONFLICT, UNLAUNCHED, DEPRECATED_VERSION, TIMEOUT, unknown, undefined (browser gone)
}

const freshReconnect = () => ({ attempts: 0, max: MAX_ATTEMPTS, lastReason: null, nextAt: null, count: 0 });
const freshLiveness = () => ({ checkedAt: null, waState: null, unhealthy: 0 });

function createRealWhatsApp({ dataDir = path.join(__dirname, '..'), env = process.env } = {}) {
  const { Client, LocalAuth } = require('whatsapp-web.js');
  const listeners = new Set();
  const state = {
    status: 'starting',
    qrDataUrl: null,
    self: null,
    error: null,
    browser: { status: 'resolving', percent: null, source: null, error: null },
    reconnect: freshReconnect(),
    liveness: freshLiveness(),
    readyAt: null,
  };
  const snapshot = () => ({ ...state, browser: { ...state.browser }, reconnect: { ...state.reconnect }, liveness: { ...state.liveness } });
  const emit = () => listeners.forEach((cb) => cb(snapshot()));

  const authDir = path.join(dataDir, '.wwebjs_auth');
  const cacheDir = path.join(dataDir, '.wwebjs_cache');

  // Kept as our own reference: the library merges defaults INTO this object
  // and reads it at launch time, so the executable path resolved in
  // initialize() lands here (the same way LocalAuth injects userDataDir).
  const puppeteerOpts = {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    // Signal teardown is owned by whoever created us (server.js signal
    // handler / run-due.js) via destroy() — not puppeteer's own handler,
    // which has left orphaned node processes holding the port.
    handleSIGINT: false,
    handleSIGTERM: false,
  };

  const client = new Client({
    // The session lives under dataDir (the repo root in terminal mode, the
    // Application Support dir for the app) — see src/datadir.js.
    authStrategy: new LocalAuth({ dataPath: authDir }),
    puppeteer: puppeteerOpts,
    // The library's WA Web html cache defaults to ./.wwebjs_cache relative to
    // process.cwd() and mkdirs it unguarded mid-startup — fatal when cwd is
    // read-only (a Finder-launched app). Anchor it to the data dir.
    webVersionCache: { type: 'local', path: cacheDir },
    // This app is the canonical WhatsApp Web client for the account: when
    // web.whatsapp.com is opened elsewhere (CONFLICT) reclaim the session
    // after 15 s instead of tearing the browser down (user decision).
    takeoverOnConflict: true,
    takeoverTimeoutMs: 15000,
  });

  // ---- relaunch machinery ----
  // `retrying` is true only while a relaunch is being scheduled/destroying
  // (backoff wait → destroy → initialize() *called*); it is NOT held while
  // the new initialize() is pending, so the startup watchdog can interrupt a
  // relaunch that stalls too. `gen` tells a superseded initialize() that its
  // rejection is expected. `closed` is set by destroy(): no timer fires after
  // the owner tore us down.
  let retrying = false;
  let closed = false;
  let gen = 0;
  let startupTimer = null;
  let reconnectTimer = null;
  let livenessTimer = null;
  const unref = (t) => (t && t.unref ? t.unref() : t);
  const sleep = (ms) =>
    new Promise((resolve) => {
      reconnectTimer = unref(setTimeout(resolve, ms));
    });

  // Self-healing startup watchdog. WhatsApp Web can hot-update and reload
  // the page mid-startup (it ships several builds a day during churn weeks),
  // which kills an in-flight init step whose rejection is swallowed inside
  // the library — the app would sit at "Authenticating…" forever. A stall
  // is just another reason to relaunch (with the shared budget). Not armed
  // while showing the QR: that state legitimately waits on a human.
  const STARTUP_LIMIT_MS = 2 * 60 * 1000;
  const stalled = () => state.status === 'starting' || state.status === 'authenticating';
  const armStartupWatchdog = () => {
    clearTimeout(startupTimer);
    startupTimer = unref(
      setTimeout(() => {
        if (!stalled() || closed) return;
        console.warn('WhatsApp startup stalled (likely a WhatsApp Web update mid-launch) — relaunching the client…');
        relaunch('startup stalled');
      }, STARTUP_LIMIT_MS)
    );
  };

  // Destroy + initialize with backoff. Returns true when a new initialize()
  // was started. Manual relaunches skip the backoff and reset the budget.
  async function relaunch(reason, { manual = false } = {}) {
    if (retrying || closed) return false;
    const r = state.reconnect;
    if (manual || (state.readyAt && Date.now() - Date.parse(state.readyAt) > STABLE_MS)) r.attempts = 0;
    if (r.attempts >= r.max) {
      state.status = 'error';
      state.error = `WhatsApp disconnected (${reason}) and ${r.max} reconnect attempts failed — use "Reconnect WhatsApp" in the menu bar, or quit and relaunch.`;
      emit();
      return false;
    }
    retrying = true;
    const myGen = ++gen;
    const attempt = ++r.attempts;
    const delay = manual ? 0 : BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)];
    r.lastReason = String(reason);
    r.nextAt = new Date(Date.now() + delay).toISOString();
    state.status = 'starting';
    state.self = null;
    state.qrDataUrl = null;
    state.error = delay ? `Reconnecting in ${Math.round(delay / 1000)}s (attempt ${attempt}/${r.max}) after: ${reason}` : `Reconnecting (attempt ${attempt}/${r.max}) after: ${reason}`;
    emit();
    console.warn(`WhatsApp: ${state.error}`);
    if (delay) await sleep(delay);
    if (closed) {
      retrying = false;
      return false;
    }
    try {
      await client.destroy();
    } catch {
      /* browser may already be half-dead */
    }
    if (closed) {
      retrying = false;
      return false;
    }
    r.nextAt = null;
    state.status = 'starting';
    state.error = null;
    emit();
    let started = false;
    try {
      await resolveBrowser();
      armStartupWatchdog();
      client
        .initialize()
        .catch((err) => {
          if (gen !== myGen || closed) return; // superseded by a newer relaunch — expected
          state.status = 'error';
          state.error = `WhatsApp relaunch failed: ${err.message}`;
          emit();
        });
      started = true;
    } catch (err) {
      state.browser = { ...state.browser, status: 'error', error: err.message };
      state.status = 'error';
      state.error = `Could not get a browser for WhatsApp Web: ${err.message}`;
      emit();
    } finally {
      retrying = false;
    }
    return started;
  }

  // ---- liveness probe ----
  // A wedged or crashed page emits nothing, so while 'ready' ask the page
  // for its socket state every few minutes. Gone page ⇒ relaunch; a socket
  // that stays off CONNECTED gets one Socket.reconnect() nudge, then a
  // relaunch.
  const scheduleLiveness = () => {
    clearTimeout(livenessTimer);
    if (closed) return;
    livenessTimer = unref(setTimeout(checkLiveness, LIVENESS_EVERY_MS));
  };
  async function checkLiveness() {
    if (closed) return;
    if (state.status !== 'ready' || retrying) return scheduleLiveness();
    const l = state.liveness;
    let waState;
    try {
      waState = await Promise.race([
        client.getState(),
        new Promise((_, reject) => unref(setTimeout(() => reject(new Error(`no answer within ${LIVENESS_TIMEOUT_MS / 1000}s`)), LIVENESS_TIMEOUT_MS))),
      ]);
    } catch (err) {
      state.liveness = { checkedAt: new Date().toISOString(), waState: null, unhealthy: l.unhealthy + 1 };
      console.warn(`WhatsApp liveness probe failed (${err.message}) — relaunching`);
      relaunch(`liveness: ${err.message}`);
      return scheduleLiveness();
    }
    const before = `${l.waState}/${l.unhealthy}`;
    if (waState === 'CONNECTED') {
      state.liveness = { checkedAt: new Date().toISOString(), waState, unhealthy: 0 };
    } else if (waState == null) {
      state.liveness = { checkedAt: new Date().toISOString(), waState: null, unhealthy: l.unhealthy + 1 };
      relaunch('liveness: page has no WhatsApp state');
    } else {
      const unhealthy = l.unhealthy + 1;
      state.liveness = { checkedAt: new Date().toISOString(), waState, unhealthy };
      if (unhealthy === LIVENESS_RESET_AT) {
        console.warn(`WhatsApp socket stuck in ${waState} — asking it to reconnect`);
        client.resetState().catch(() => {});
      } else if (unhealthy >= LIVENESS_RELAUNCH_AT) {
        relaunch(`liveness: stuck in ${waState}`);
      }
    }
    if (`${state.liveness.waState}/${state.liveness.unhealthy}` !== before) emit();
    scheduleLiveness();
  }

  client.on('qr', async (qr) => {
    clearTimeout(startupTimer);
    state.status = 'qr';
    state.qrDataUrl = await QRCode.toDataURL(qr, { width: 280, margin: 1 });
    emit();
  });
  client.on('authenticated', () => {
    armStartupWatchdog();
    state.status = 'authenticating';
    state.qrDataUrl = null;
    emit();
  });
  client.on('ready', () => {
    clearTimeout(startupTimer);
    state.status = 'ready';
    state.qrDataUrl = null;
    state.error = null;
    state.self = { number: `+${client.info.wid.user}`, name: client.info.pushname || '' };
    state.readyAt = new Date().toISOString();
    if (state.reconnect.attempts > 0) state.reconnect.count++;
    state.reconnect.nextAt = null;
    state.liveness = freshLiveness();
    emit();
    scheduleLiveness();
  });
  client.on('auth_failure', (msg) => {
    state.status = 'error';
    state.error = `WhatsApp auth failure: ${msg}`;
    emit();
  });
  client.on('disconnected', (reason) => {
    if (retrying || closed) return; // our own destroy in flight
    const kind = classifyDisconnect(reason);
    state.self = null;
    state.qrDataUrl = null;
    if (kind === 'fatal') {
      state.status = 'error';
      state.error = `WhatsApp refused the session (${reason}) — this account or connection is blocked; nothing to retry.`;
      emit();
      return;
    }
    if (kind === 'relink') {
      state.status = 'disconnected';
      state.error = `WhatsApp was unlinked (${reason}) — scan the QR to link this Mac again.`;
      emit();
      // LOGOUT: the library wipes the session and re-injects on the same
      // browser, emitting 'qr' by itself. UNPAIRED*: it tears the browser
      // down, so one relaunch (no backoff, no budget) surfaces a fresh QR.
      if (String(reason).toUpperCase() !== 'LOGOUT') relaunch(reason, { manual: true });
      return;
    }
    state.status = 'disconnected';
    state.error = `Disconnected (${reason}) — reconnecting…`;
    emit();
    relaunch(reason);
  });

  // Locate (or download) the Chrome build puppeteer expects. Done once, before
  // the startup watchdog is armed — a 160 MB download must not count as a
  // stalled start.
  async function resolveBrowser() {
    if (puppeteerOpts.executablePath) return;
    state.browser = { status: 'resolving', percent: null, source: null, error: null };
    emit();
    const { executablePath, source } = await ensureBrowser({
      dataDir,
      env,
      log: console.log,
      onProgress: (percent) => {
        state.browser = { ...state.browser, status: 'downloading', percent };
        emit();
      },
    });
    puppeteerOpts.executablePath = executablePath;
    state.browser = { status: 'ready', percent: null, source, error: null };
    emit();
  }

  return {
    async initialize() {
      try {
        await resolveBrowser();
      } catch (err) {
        state.browser = { ...state.browser, status: 'error', error: err.message };
        state.status = 'error';
        state.error = `Could not get a browser for WhatsApp Web: ${err.message}`;
        emit();
        return;
      }
      const myGen = ++gen;
      try {
        armStartupWatchdog();
        await client.initialize();
      } catch (err) {
        // A relaunch destroys this client mid-flight; that rejection is
        // expected and the relaunch owns the state from here.
        if (gen !== myGen || closed) return;
        state.status = 'error';
        state.error = `Failed to start WhatsApp client: ${err.message}`;
        emit();
      }
    },
    getState: snapshot,
    onUpdate: (cb) => listeners.add(cb),
    async checkNumber(e164) {
      const id = await client.getNumberId(e164.replace(/^\+/, ''));
      return id ? id._serialized : null;
    },
    // client.sendMessage resolving to undefined means the library could not
    // find the chat (or the sent message) — upstream treats that as a quiet
    // success, but for us an unconfirmed send is a failure: surface it
    // instead of reporting a ✓ for a message that may never have left.
    async send(chatId, text) {
      const sent = await client.sendMessage(chatId, text);
      if (!sent) throw new Error('WhatsApp did not confirm the send (chat lookup failed) — check the phone before assuming it went out');
    },
    async sendToSelf(text) {
      const sent = await client.sendMessage(client.info.wid._serialized, text);
      if (!sent) throw new Error('WhatsApp did not confirm the send (chat lookup failed) — check your phone before retrying');
    },
    async logout() {
      await client.logout();
      state.status = 'disconnected';
      state.error = 'Logged out. Restart the app to link again.';
      state.self = null;
      emit();
    },
    // Manual relaunch (tray "Reconnect WhatsApp", scheduler nudge). Rejects
    // while one is already in flight.
    async reconnect() {
      if (retrying) throw new Error('A reconnect is already in progress');
      if (closed) throw new Error('WhatsApp client is closed');
      const started = await relaunch('manual', { manual: true });
      if (!started) throw new Error(state.error || 'Reconnect did not start');
    },
    // Close the browser cleanly (used by the headless scheduled-send runner
    // and the engine's signal handler). No timer fires after this.
    async destroy() {
      closed = true;
      clearTimeout(startupTimer);
      clearTimeout(reconnectTimer);
      clearTimeout(livenessTimer);
      await client.destroy();
    },
    browserPid() {
      try {
        return client.pupBrowser?.process()?.pid ?? null;
      } catch {
        return null;
      }
    },
    _authDir: authDir, // introspection for tests
    _cacheDir: cacheDir,
  };
}

// Mock client for tests and UI development without a real WhatsApp account.
// Deterministic failure rules:
//   number ending in 99 -> not registered on WhatsApp
//   number ending in 98 -> send throws
function createMockWhatsApp() {
  const listeners = new Set();
  const state = {
    status: 'starting',
    qrDataUrl: null,
    self: null,
    error: null,
    browser: { status: 'ready', percent: null, source: 'mock', error: null },
    reconnect: freshReconnect(),
    liveness: freshLiveness(),
    readyAt: null,
  };
  const snapshot = () => ({ ...state, browser: { ...state.browser }, reconnect: { ...state.reconnect }, liveness: { ...state.liveness } });
  const emit = () => listeners.forEach((cb) => cb(snapshot()));
  const timers = new Set();
  let closed = false;
  const delay = (ms) =>
    new Promise((r) => {
      const t = setTimeout(() => {
        timers.delete(t);
        r();
      }, ms);
      timers.add(t);
    });
  const sent = [];
  const becomeReady = () => {
    state.status = 'ready';
    state.qrDataUrl = null;
    state.error = null;
    state.self = { number: '+15550000001', name: 'Mock Me' };
    state.readyAt = new Date().toISOString();
    if (state.reconnect.attempts > 0) state.reconnect.count++;
    state.reconnect.nextAt = null;
    emit();
  };
  const showQr = async () => {
    state.status = 'qr';
    state.self = null;
    state.qrDataUrl = await QRCode.toDataURL('whatsthat-mock-qr-not-real', { width: 280, margin: 1 });
    emit();
  };
  // Same shape as the real relaunch, compressed to a few hundred ms.
  const relaunch = async (reason, { manual = false } = {}) => {
    if (manual) state.reconnect.attempts = 0;
    state.reconnect.attempts++;
    state.reconnect.lastReason = String(reason);
    state.status = 'starting';
    state.self = null;
    state.error = `Reconnecting (attempt ${state.reconnect.attempts}/${state.reconnect.max}) after: ${reason}`;
    emit();
    await delay(300);
    if (closed) return;
    becomeReady();
  };

  return {
    _sent: sent,
    async initialize() {
      await delay(200);
      await showQr();
      await delay(1500);
      if (closed) return;
      becomeReady();
    },
    // Test hooks (exposed by server.js only in mock mode).
    async _disconnect(reason) {
      const kind = classifyDisconnect(reason);
      state.self = null;
      state.qrDataUrl = null;
      if (kind === 'fatal') {
        state.status = 'error';
        state.error = `WhatsApp refused the session (${reason}) — this account or connection is blocked; nothing to retry.`;
        emit();
        return;
      }
      if (kind === 'relink') {
        state.status = 'disconnected';
        state.error = `WhatsApp was unlinked (${reason}) — scan the QR to link this Mac again.`;
        emit();
        await delay(100);
        await showQr();
        return;
      }
      state.status = 'disconnected';
      state.error = `Disconnected (${reason}) — reconnecting…`;
      emit();
      relaunch(reason);
    },
    async _relink() {
      becomeReady();
    },
    getState: snapshot,
    onUpdate: (cb) => listeners.add(cb),
    async checkNumber(e164) {
      await delay(50);
      if (e164.endsWith('99')) return null;
      return `${e164.replace(/^\+/, '')}@c.us`;
    },
    async send(chatId, text) {
      await delay(100);
      if (chatId.replace('@c.us', '').endsWith('98')) throw new Error('mock send failure');
      sent.push({ chatId, text });
    },
    async sendToSelf(text) {
      await delay(100);
      sent.push({ chatId: 'self', text });
    },
    async logout() {
      state.status = 'disconnected';
      state.error = 'Logged out (mock).';
      state.self = null;
      emit();
    },
    async reconnect() {
      await relaunch('manual', { manual: true });
    },
    async destroy() {
      closed = true;
      for (const t of timers) clearTimeout(t);
    },
    browserPid: () => null,
  };
}

function createWhatsApp({ mock = false, dataDir, env } = {}) {
  return mock ? createMockWhatsApp() : createRealWhatsApp({ dataDir, env });
}

module.exports = { createWhatsApp, classifyDisconnect };
