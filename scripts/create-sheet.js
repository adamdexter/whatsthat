'use strict';

// One-off setup: builds a "WhatsThat Contacts" Google Sheet from a CSV —
// populated, header frozen and bold, dropdowns on low-cardinality columns
// (rank, Status…) — then points the app's saved draft at it.
//
// Reuses the app's OAuth client but asks separately for Sheets WRITE scope
// with its own token file (google-setup.local.json); the app itself stays
// read-only.
//
// Usage: node scripts/create-sheet.js path/to/contacts.csv
//   Row 1 = headers, must include `phone`. Other columns become template
//   variables. A `Status` column gets an Active/Inactive dropdown; any other
//   column with ≤ 8 distinct values gets a dropdown of those values.

const fs = require('fs');
const http = require('http');
const path = require('path');
const { execFile } = require('child_process');
const { google } = require('googleapis');
const { JsonStore } = require('../src/store');
const { parseCsv } = require('../src/csv');
const { resolveDataDir } = require('../src/datadir');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = resolveDataDir({ rootDir: ROOT }).dir;
const PORT = 3853;
const REDIRECT = `http://localhost:${PORT}/callback`;
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];
const MAX_DROPDOWN_VALUES = 8;

const appStore = new JsonStore(path.join(DATA_DIR, 'google.local.json'));
const setupStore = new JsonStore(path.join(DATA_DIR, 'google-setup.local.json'));
const draftStore = new JsonStore(path.join(DATA_DIR, 'draft.local.json'));

function loadRows(file) {
  if (!file) throw new Error('Usage: node scripts/create-sheet.js path/to/contacts.csv');
  const rows = parseCsv(fs.readFileSync(file, 'utf8')).filter((r) => r.some((c) => String(c).trim()));
  if (rows.length < 2) throw new Error('The CSV needs a header row and at least one contact');
  const header = rows[0].map((h) => String(h).trim());
  if (!header.some((h) => h.toLowerCase() === 'phone')) throw new Error('The CSV needs a `phone` column');
  return { header, rows: rows.slice(1) };
}

async function getAuth() {
  const { clientId, clientSecret } = appStore.read();
  if (!clientId || !clientSecret) {
    throw new Error('No Google credentials found — save them in the WhatsThat UI (Setup → Google) first');
  }
  const oauth2 = new google.auth.OAuth2(clientId, clientSecret, REDIRECT);
  const cached = setupStore.read();
  if (cached.tokens && cached.tokens.refresh_token) {
    oauth2.setCredentials(cached.tokens);
    return oauth2;
  }
  const url = oauth2.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES });
  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, REDIRECT);
      if (u.pathname !== '/callback') return res.end();
      res.end('<body style="font-family:sans-serif;padding:40px"><h2>✅ Authorized</h2><p>You can close this tab — the sheet is being created.</p></body>');
      server.close();
      const c = u.searchParams.get('code');
      if (c) resolve(c);
      else reject(new Error(u.searchParams.get('error') || 'no authorization code'));
    });
    server.listen(PORT, '127.0.0.1', () => {
      console.log('Opening your browser — approve Sheets write access for the Google account that owns the sheet…');
      execFile('open', [url]);
    });
  });
  const { tokens } = await oauth2.getToken(code);
  oauth2.setCredentials(tokens); // getToken() does not attach them itself
  setupStore.write({ tokens });
  return oauth2;
}

async function main() {
  const { header, rows } = loadRows(process.argv[2]);
  const auth = await getAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  const created = await sheets.spreadsheets.create({
    requestBody: {
      properties: { title: 'WhatsThat Contacts' },
      sheets: [{ properties: { title: 'Contacts', gridProperties: { frozenRowCount: 1 } } }],
    },
  });
  const spreadsheetId = created.data.spreadsheetId;
  const sheetId = created.data.sheets[0].properties.sheetId;
  const url = created.data.spreadsheetUrl;

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: 'Contacts!A1',
    valueInputOption: 'RAW',
    requestBody: { values: [header, ...rows] },
  });

  const dropdown = (colIndex, values) => ({
    setDataValidation: {
      range: { sheetId, startRowIndex: 1, endRowIndex: 500, startColumnIndex: colIndex, endColumnIndex: colIndex + 1 },
      rule: {
        condition: { type: 'ONE_OF_LIST', values: values.map((v) => ({ userEnteredValue: v })) },
        strict: true,
        showCustomUi: true,
      },
    },
  });
  const dropdowns = [];
  header.forEach((h, i) => {
    if (['phone', 'email'].includes(h.toLowerCase())) return;
    if (h.toLowerCase() === 'status') return dropdowns.push(dropdown(i, ['Active', 'Inactive']));
    const values = [...new Set(rows.map((r) => String(r[i] ?? '').trim()).filter(Boolean))];
    if (values.length >= 2 && values.length <= MAX_DROPDOWN_VALUES && values.length < rows.length / 2) dropdowns.push(dropdown(i, values));
  });

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        ...dropdowns,
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
            cell: { userEnteredFormat: { textFormat: { bold: true } } },
            fields: 'userEnteredFormat.textFormat.bold',
          },
        },
        { autoResizeDimensions: { dimensions: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: header.length } } },
      ],
    },
  });

  // Point the app's saved draft at the new sheet so it's prefilled in the UI.
  draftStore.patch({ sheetUrl: url, tabName: 'Contacts' });

  console.log(`\n✅ Created: ${url}`);
  console.log(`${rows.length} contacts, ${dropdowns.length} dropdown column(s). The app's "sheet URL" field now points at it (reload the page).`);
}

main().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
