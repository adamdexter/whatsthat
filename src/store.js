'use strict';

const fs = require('fs');
const path = require('path');

// Tiny JSON-file persistence for settings/drafts. Synchronous by design —
// these are small files written on user actions, not hot paths.
class JsonStore {
  constructor(file) {
    this.file = file;
  }

  read() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return {};
    }
  }

  write(data) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(data, null, 2));
  }

  patch(partial) {
    const next = { ...this.read(), ...partial };
    this.write(next);
    return next;
  }
}

module.exports = { JsonStore };
