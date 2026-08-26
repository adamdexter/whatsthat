'use strict';

// Tee console output into a rotated log file. A Finder-launched app has no
// terminal, so this is the only trace of what the engine did.

const fs = require('fs');
const path = require('path');
const util = require('util');

function rotateIfNeeded(file, maxBytes, keep) {
  let size;
  try {
    size = fs.statSync(file).size;
  } catch {
    return false;
  }
  if (size <= maxBytes) return false;
  for (let i = keep; i >= 1; i--) {
    const from = i === 1 ? file : `${file}.${i - 1}`;
    try {
      fs.renameSync(from, `${file}.${i}`);
    } catch {
      /* nothing at that slot */
    }
  }
  return true;
}

function installFileLog({ file, maxBytes = 5 * 1024 * 1024, keep = 2, console: con = console } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  rotateIfNeeded(file, maxBytes, keep);
  let writes = 0;
  const write = (level, args) => {
    try {
      fs.appendFileSync(file, `[${new Date().toISOString()}] [${level}] ${util.format(...args)}\n`);
      if (++writes % 200 === 0) rotateIfNeeded(file, maxBytes, keep);
    } catch {
      /* logging must never take the engine down */
    }
  };
  for (const level of ['log', 'info', 'warn', 'error']) {
    const orig = con[level].bind(con);
    con[level] = (...args) => {
      orig(...args);
      write(level, args);
    };
  }
  return { file };
}

module.exports = { installFileLog, rotateIfNeeded };
