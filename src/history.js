'use strict';

// "Last message sent" per contact, derived from the send reports — the
// record of what WhatsThat actually delivered. Local by design: it works
// for pasted-CSV contacts too, and the app's Google token is read-only.
// Keyed by E.164 phone (the same normalized value the contact table shows).

const fs = require('fs');
const path = require('path');

function buildHistory(reportsDir) {
  let files = [];
  try {
    files = fs
      .readdirSync(reportsDir)
      .filter((f) => /^run-.*\.json$/.test(f))
      .sort(); // named by start time ⇒ chronological
  } catch {
    return { byPhone: {}, reports: 0 };
  }
  const byPhone = {};
  for (const file of files) {
    let report;
    try {
      report = JSON.parse(fs.readFileSync(path.join(reportsDir, file), 'utf8'));
    } catch {
      continue; // a report being written right now, or corrupt — skip
    }
    const at = report.summary?.startedAt || null;
    for (const r of report.results || []) {
      if (r.status !== 'sent' || !r.phone) continue;
      const count = (byPhone[r.phone]?.count || 0) + 1;
      byPhone[r.phone] = { at, text: r.text || '', reportFile: file, count }; // later file wins
    }
  }
  return { byPhone, reports: files.length };
}

// Rebuilds only when the reports directory changed (names + mtimes).
function createHistory(reportsDir) {
  let signature = null;
  let cached = null;
  const currentSignature = () => {
    try {
      return fs
        .readdirSync(reportsDir)
        .filter((f) => /^run-.*\.json$/.test(f))
        .map((f) => `${f}:${fs.statSync(path.join(reportsDir, f)).mtimeMs}`)
        .join('|');
    } catch {
      return '';
    }
  };
  return {
    get() {
      const sig = currentSignature();
      if (sig !== signature || !cached) {
        cached = buildHistory(reportsDir);
        signature = sig;
      }
      return cached;
    },
  };
}

module.exports = { buildHistory, createHistory };
