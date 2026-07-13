'use strict';

const { normalizePhone } = require('./phone');

// Build contact objects from a values matrix (Google Sheets or parsed CSV).
// Row 0 is the header row; a "phone" column (case-insensitive) is required.
// Returns { headers, contacts, error }. Each contact:
//   { id, fields: { header: value, ... }, phone: '+1...' | null, phoneError }
function buildContacts(values) {
  if (!values || values.length === 0) {
    return { headers: [], contacts: [], error: 'The sheet is empty' };
  }
  const headers = values[0].map((h) => String(h).trim());
  const phoneIdx = headers.findIndex((h) => h.toLowerCase() === 'phone');
  if (phoneIdx === -1) {
    return {
      headers: headers.filter(Boolean),
      contacts: [],
      error: `No "phone" column found in the header row. Found: ${headers.filter(Boolean).join(', ') || '(nothing)'}`,
    };
  }
  // Duplicate headers would silently collapse to one column and could send
  // messages built from the wrong data — refuse them outright.
  const seen = new Set();
  const dups = new Set();
  for (const h of headers) {
    if (!h) continue;
    const key = h.toLowerCase();
    if (seen.has(key)) dups.add(h);
    seen.add(key);
  }
  if (dups.size) {
    return {
      headers: headers.filter(Boolean),
      contacts: [],
      error: `Duplicate column header(s): ${[...dups].join(', ')} — rename them in the sheet so each {{variable}} is unambiguous`,
    };
  }
  if (values.length < 2) {
    return { headers: headers.filter(Boolean), contacts: [], error: 'No contact rows below the header row' };
  }

  const contacts = [];
  for (let r = 1; r < values.length; r++) {
    const rowVals = values[r] || [];
    const fields = {};
    headers.forEach((h, i) => {
      if (h) fields[h] = rowVals[i] != null ? String(rowVals[i]).trim() : '';
    });
    const { e164, error } = normalizePhone(rowVals[phoneIdx]);
    contacts.push({ id: r, fields, phone: e164, phoneError: error });
  }
  return { headers: headers.filter(Boolean), contacts, error: null };
}

// Best-effort display name for a contact, for logs and the UI.
function displayName(contact) {
  const f = contact.fields || {};
  const get = (name) => {
    for (const key of Object.keys(f)) {
      if (key.trim().toLowerCase() === name) return String(f[key]).trim();
    }
    return '';
  };
  const name = [get('firstname') || get('first name'), get('lastname') || get('last name')]
    .filter(Boolean)
    .join(' ');
  return name || contact.phone || `row ${contact.id + 1}`;
}

module.exports = { buildContacts, displayName };
