'use strict';

const { google } = require('googleapis');

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets.readonly'];

// Accepts a full Google Sheets URL (including multi-account /u/N/ URLs) or a
// bare spreadsheet id.
function extractSpreadsheetId(input) {
  const s = String(input || '').trim();
  const m = s.match(/\/spreadsheets\/(?:u\/\d+\/)?d\/([a-zA-Z0-9-_]+)/);
  if (m) return m[1];
  if (/^[a-zA-Z0-9-_]{20,}$/.test(s)) return s;
  return null;
}

// Google Sheets access via OAuth (Desktop-app client, loopback redirect).
// Credentials + tokens live in the given JsonStore (a gitignored local file).
function createSheets({ store, redirectUri }) {
  function getOAuthClient() {
    const cfg = store.read();
    if (!cfg.clientId || !cfg.clientSecret) return null;
    const oauth2 = new google.auth.OAuth2(cfg.clientId, cfg.clientSecret, redirectUri);
    if (cfg.tokens) oauth2.setCredentials(cfg.tokens);
    // Persist refreshed access tokens so reconnects aren't needed.
    oauth2.on('tokens', (tokens) => {
      const cur = store.read();
      store.patch({ tokens: { ...(cur.tokens || {}), ...tokens } });
    });
    return oauth2;
  }

  return {
    status() {
      const cfg = store.read();
      return {
        configured: Boolean(cfg.clientId && cfg.clientSecret),
        connected: Boolean(cfg.tokens && cfg.tokens.refresh_token),
      };
    },

    setCredentials(clientId, clientSecret) {
      store.patch({ clientId: String(clientId).trim(), clientSecret: String(clientSecret).trim(), tokens: null });
    },

    authUrl() {
      const oauth2 = getOAuthClient();
      if (!oauth2) throw new Error('Set your Google OAuth client ID and secret first');
      return oauth2.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES });
    },

    async handleCallback(code) {
      const oauth2 = getOAuthClient();
      if (!oauth2) throw new Error('Google credentials are not configured');
      const { tokens } = await oauth2.getToken(code);
      store.patch({ tokens });
    },

    disconnect() {
      store.patch({ tokens: null });
    },

    // Fetch all populated cells. tabName optional — defaults to the first tab.
    async fetchValues(spreadsheetId, tabName) {
      const oauth2 = getOAuthClient();
      if (!oauth2 || !store.read().tokens) throw new Error('Google is not connected yet');
      const sheets = google.sheets({ version: 'v4', auth: oauth2 });

      let tab = tabName && String(tabName).trim();
      if (!tab) {
        const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties.title' });
        tab = meta.data.sheets?.[0]?.properties?.title;
        if (!tab) throw new Error('The spreadsheet has no sheets');
      }
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `'${tab.replace(/'/g, "''")}'`,
      });
      return res.data.values || [];
    },
  };
}

module.exports = { createSheets, extractSpreadsheetId, SCOPES };
