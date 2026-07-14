'use strict';

const path = require('path');
const QRCode = require('qrcode');

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
      ...(process.env.WHATSTHAT_CHROME ? { executablePath: process.env.WHATSTHAT_CHROME } : {}),
    },
  });

  client.on('qr', async (qr) => {
    state.status = 'qr';
    state.qrDataUrl = await QRCode.toDataURL(qr, { width: 280, margin: 1 });
    emit();
  });
  client.on('authenticated', () => {
    state.status = 'authenticating';
    state.qrDataUrl = null;
    emit();
  });
  client.on('ready', () => {
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
