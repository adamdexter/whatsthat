'use strict';

const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');

// WhatsApp Web build pin. WA ships new builds continuously, and a new build
// can wedge whatsapp-web.js between 'authenticated' and 'ready' (first seen
// 2026-07-22: build 2.3000.1043632247 hung startup; 2.3000.1043085068 is the
// last build that reached ready on this session). While pinned, the cached
// copy in .wwebjs_cache/ is served instead of whatever WA pushes. Remove the
// pin once upstream ships a release that handles current builds — the
// auto-update banner announces new releases. Override with
// WHATSTHAT_WEB_PIN=<version>, or WHATSTHAT_WEB_PIN= (empty) to unpin.
const WEB_PIN = process.env.WHATSTHAT_WEB_PIN ?? '2.3000.1043085068';
const CACHE_DIR = path.join(__dirname, '..', '.wwebjs_cache');

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

  // Pin only when the build is actually cached: a strict pin with no cached
  // copy would block first-ever linking on a fresh machine. Unpinned runs get
  // whatever WA serves (and may hang — the startup watchdog surfaces that).
  const pinnedHtml = path.join(CACHE_DIR, `${WEB_PIN}.html`);
  const usePin = Boolean(WEB_PIN) && fs.existsSync(pinnedHtml);
  if (WEB_PIN && !usePin) {
    console.warn(`WhatsApp Web pin ${WEB_PIN} is not in .wwebjs_cache/ — running unpinned on the live version`);
  }

  const client = new Client({
    // Anchored to the repo so running from any CWD reuses the same session
    // (and never drops credentials outside the gitignore's protection).
    authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '..', '.wwebjs_auth') }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      ...(process.env.WHATSTHAT_CHROME ? { executablePath: process.env.WHATSTHAT_CHROME } : {}),
    },
    ...(usePin
      ? {
        webVersion: WEB_PIN,
        webVersionCache: { type: 'local', path: CACHE_DIR, strict: true },
      }
      : {}),
  });

  // A WA Web build change can wedge startup silently (an in-page evaluation
  // that never returns) — the app then sits at "Authenticating…" forever.
  // Surface that as an error instead. Not armed while showing the QR: that
  // state legitimately waits on a human.
  const STARTUP_LIMIT_MS = 3 * 60 * 1000;
  let startupTimer = null;
  const armStartupWatchdog = () => {
    clearTimeout(startupTimer);
    startupTimer = setTimeout(() => {
      if (state.status === 'starting' || state.status === 'authenticating') {
        state.status = 'error';
        state.error =
          'WhatsApp startup hung for 3+ minutes — usually a WhatsApp Web update breaking the automation library. Quit (Ctrl+C) and relaunch; if it persists, see CLAUDE.md → auto-update recovery.';
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
    async send(chatId, text) {
      await client.sendMessage(chatId, text);
    },
    async sendToSelf(text) {
      await client.sendMessage(client.info.wid._serialized, text);
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
