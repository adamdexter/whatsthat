'use strict';

const path = require('path');
const QRCode = require('qrcode');

// NOTE on version pinning: don't. We tried pinning the WA Web build via
// webVersion/webVersionCache (v1.3.1) — on 2.3000.x builds the page
// self-updates to the live version right after loading the pinned html,
// which forces a reload in the middle of the library's startup sequence and
// wedges it silently (an in-flight page evaluation dies; the rejection is
// swallowed inside the exposeFunction bridge and 'ready' never fires). The
// same race happens unpinned whenever WA ships a build mid-launch, so the
// real defense is the self-healing startup watchdog below.

// Both implementations expose the same interface:
//   initialize()                 — start connecting (resolves when startup settles)
//   getState()                   — { status, qrDataUrl, self, error }
//   onUpdate(cb)                 — cb(state) on every state change
//   checkNumber(e164)            — serialized chat id, or null if not on WhatsApp
//   send(chatId, text)
//   sendToSelf(text)
//   logout()
// status: 'starting' | 'qr' | 'authenticating' | 'ready' | 'disconnected' | 'error'

function createRealWhatsApp() {
  const { Client, LocalAuth } = require('whatsapp-web.js');
  const listeners = new Set();
  const state = { status: 'starting', qrDataUrl: null, self: null, error: null };
  const emit = () => listeners.forEach((cb) => cb({ ...state }));

  const client = new Client({
    // Anchored to the repo so running from any CWD reuses the same session
    // (and never drops credentials outside the gitignore's protection).
    authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '..', '.wwebjs_auth') }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      // Signal teardown is owned by whoever created us (server.js signal
      // handler / run-due.js) via destroy() — not puppeteer's own handler,
      // which has left orphaned node processes holding the port.
      handleSIGINT: false,
      handleSIGTERM: false,
      ...(process.env.WHATSTHAT_CHROME ? { executablePath: process.env.WHATSTHAT_CHROME } : {}),
    },
  });

  // Self-healing startup watchdog. WhatsApp Web can hot-update and reload
  // the page mid-startup (it ships several builds a day during churn weeks),
  // which kills an in-flight init step whose rejection is swallowed inside
  // the library — the app would sit at "Authenticating…" forever. When
  // startup stalls, destroy the client and relaunch it once: the retry loads
  // the settled live build directly and normally comes straight up. A second
  // stall becomes a visible error. Not armed while showing the QR: that
  // state legitimately waits on a human.
  const STARTUP_LIMIT_MS = 2 * 60 * 1000;
  let startupTimer = null;
  let startupRetried = false;
  let retrying = false;
  const stalled = () => state.status === 'starting' || state.status === 'authenticating';
  const armStartupWatchdog = () => {
    clearTimeout(startupTimer);
    startupTimer = setTimeout(async () => {
      if (!stalled()) return;
      if (!startupRetried) {
        startupRetried = true;
        retrying = true;
        console.warn('WhatsApp startup stalled (likely a WhatsApp Web update mid-launch) — relaunching the client…');
        try {
          await client.destroy();
        } catch {
          /* browser may already be half-dead */
        }
        state.status = 'starting';
        state.error = null;
        emit();
        try {
          armStartupWatchdog();
          await client.initialize();
        } catch (err) {
          state.status = 'error';
          state.error = `WhatsApp relaunch failed: ${err.message}`;
          emit();
        } finally {
          retrying = false;
        }
      } else {
        state.status = 'error';
        state.error =
          'WhatsApp startup stalled twice — WhatsApp Web is likely mid-rollout of a breaking change. Quit (Ctrl+C), wait a few minutes, and relaunch; the auto-updater will pick up a library fix as soon as one ships.';
        emit();
      }
    }, STARTUP_LIMIT_MS);
    if (startupTimer.unref) startupTimer.unref();
  };

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
    emit();
  });
  client.on('auth_failure', (msg) => {
    state.status = 'error';
    state.error = `WhatsApp auth failure: ${msg}`;
    emit();
  });
  client.on('disconnected', (reason) => {
    if (retrying) return; // expected while the watchdog relaunches the client
    state.status = 'disconnected';
    state.error = `Disconnected: ${reason}. Restart the app to reconnect.`;
    state.self = null;
    emit();
  });

  return {
    async initialize() {
      try {
        armStartupWatchdog();
        await client.initialize();
      } catch (err) {
        // A watchdog relaunch destroys the first client mid-flight; that
        // rejection is expected and the retry owns the state from here.
        if (retrying) return;
        state.status = 'error';
        state.error = `Failed to start WhatsApp client: ${err.message}`;
        emit();
      }
    },
    getState: () => ({ ...state }),
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
    // Close the browser cleanly (used by the headless scheduled-send runner).
    async destroy() {
      await client.destroy();
    },
  };
}

// Mock client for tests and UI development without a real WhatsApp account.
// Deterministic failure rules:
//   number ending in 99 -> not registered on WhatsApp
//   number ending in 98 -> send throws
function createMockWhatsApp() {
  const listeners = new Set();
  const state = { status: 'starting', qrDataUrl: null, self: null, error: null };
  const emit = () => listeners.forEach((cb) => cb({ ...state }));
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const sent = [];

  return {
    _sent: sent,
    async initialize() {
      await delay(200);
      state.status = 'qr';
      state.qrDataUrl = await QRCode.toDataURL('whatsthat-mock-qr-not-real', { width: 280, margin: 1 });
      emit();
      await delay(1500);
      state.status = 'ready';
      state.qrDataUrl = null;
      state.self = { number: '+15550000001', name: 'Mock Me' };
      emit();
    },
    getState: () => ({ ...state }),
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
    async destroy() {},
  };
}

function createWhatsApp({ mock = false } = {}) {
  return mock ? createMockWhatsApp() : createRealWhatsApp();
}

module.exports = { createWhatsApp };
