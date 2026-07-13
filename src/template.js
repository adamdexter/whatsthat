'use strict';

const VAR_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

// Unique variable names referenced in a template, in order of first appearance.
function extractVars(template) {
  const vars = new Set();
  for (const m of String(template).matchAll(VAR_RE)) vars.add(m[1]);
  return [...vars];
}

// Case-insensitive, trimmed lookup of a variable name against row keys.
function lookup(row, name) {
  const want = name.trim().toLowerCase();
  for (const key of Object.keys(row)) {
    if (key.trim().toLowerCase() === want) return { found: true, value: row[key] };
  }
  return { found: false, value: undefined };
}

// Render a template against a row of fields. Reports unknown vars (no matching
// column) and empty vars (column exists but this row's cell is blank).
function render(template, row) {
  const unknown = [];
  const empty = [];
  const text = String(template).replace(VAR_RE, (_, name) => {
    const { found, value } = lookup(row, name);
    if (!found) {
      unknown.push(name.trim());
      return '';
    }
    const v = value == null ? '' : String(value).trim();
    if (v === '') empty.push(name.trim());
    return v;
  });
  return { text, unknown: [...new Set(unknown)], empty: [...new Set(empty)] };
}

module.exports = { extractVars, render, lookup };
