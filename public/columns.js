'use strict';

// Which contact columns are send rules (filters) and which are per-contact
// fields — decided from the data, scaled to the list size, with the user's
// remembered answers on top.
//
//   distinct ≤ max(AUTO_FLOOR, ceil(AUTO_RATIO × contacts))  → filter (automatic)
//   distinct ≤ max(ASK_FLOOR,  ceil(ASK_RATIO  × contacts))  → ask the user once
//   otherwise                                                → per-contact field
//
// "distinct" counts non-empty values case-insensitively; a column whose
// values never repeat (names, emails) is always a field. The floors keep
// small lists sensible (14 contacts × 10% = 2 would hide a 4-value column).

const AUTO_FLOOR = 4;
const AUTO_RATIO = 0.1;
const ASK_FLOOR = 8;
const ASK_RATIO = 0.25;

function columnStats(header, contacts) {
  const seen = new Map(); // lowercased -> first display casing
  let blanks = 0;
  for (const c of contacts) {
    const v = String((c.fields && c.fields[header]) ?? '').trim();
    if (v === '') blanks++;
    else if (!seen.has(v.toLowerCase())) seen.set(v.toLowerCase(), v);
  }
  return { header, distinct: seen.size, values: [...seen.values()].sort((a, b) => a.localeCompare(b)), hasBlank: blanks > 0, blanks };
}

// decisions: { [header.toLowerCase()]: 'filter' | 'field' }
function classifyColumns({ headers = [], contacts = [], decisions = {} } = {}) {
  const n = contacts.length;
  const autoMax = Math.max(AUTO_FLOOR, Math.ceil(AUTO_RATIO * n));
  const askMax = Math.max(ASK_FLOOR, Math.ceil(ASK_RATIO * n));
  const out = [];
  for (const header of headers) {
    if (header.trim().toLowerCase() === 'phone') continue;
    const stats = columnStats(header, contacts);
    const { distinct, hasBlank } = stats;
    const options = distinct + (hasBlank ? 1 : 0); // chips a filter would show
    const repeating = options >= 2 && distinct < n; // something to choose between, and not one-per-contact
    const decided = decisions[header.trim().toLowerCase()];
    let kind;
    let reason;
    if (decided === 'field') {
      kind = 'field';
      reason = 'chosen';
    } else if (decided === 'filter') {
      kind = distinct >= 1 ? 'filter' : 'field';
      reason = distinct >= 1 ? 'chosen' : 'empty';
    } else if (n < 2 || !repeating) {
      kind = 'field';
      reason = distinct === 0 ? 'empty' : distinct >= n ? 'unique' : 'constant';
    } else if (distinct <= autoMax) {
      kind = 'filter';
      reason = 'auto';
    } else if (distinct <= askMax) {
      kind = 'ask';
      reason = 'ambiguous';
    } else {
      kind = 'field';
      reason = 'too-many';
    }
    out.push({ ...stats, kind, reason, total: n, autoMax, askMax });
  }
  return out;
}

// Loaded as a plain <script> in the browser; require()d in node tests.
if (typeof module !== 'undefined') module.exports = { classifyColumns, columnStats, AUTO_FLOOR, AUTO_RATIO, ASK_FLOOR, ASK_RATIO };
