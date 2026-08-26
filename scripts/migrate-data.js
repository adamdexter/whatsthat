'use strict';

// One-time move of WhatsThat's data (WhatsApp session, draft, Google token,
// schedule, reports) from a repo checkout into ~/Library/Application Support/
// WhatsThat — the home the Mac app uses. Copies and verifies; never deletes.
//   npm run migrate-data                # repo root → Application Support
//   node scripts/migrate-data.js <from> <to>

const path = require('path');
const { migrateData, appSupportDir, sessionLockPid, pidAlive } = require('../src/datadir');

const ROOT = path.join(__dirname, '..');
const from = process.argv[2] || ROOT;
const to = process.argv[3] || appSupportDir();

async function appAnswering(port) {
  try {
    return (await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
}

(async () => {
  if (await appAnswering(3847)) {
    console.error('✗ WhatsThat is running on port 3847 — quit it first (its WhatsApp session must not be copied while open).');
    process.exit(1);
  }
  const lockPid = sessionLockPid(from);
  if (lockPid && pidAlive(lockPid)) {
    console.error(`✗ The WhatsApp session in ${from} is open (pid ${lockPid}) — quit that WhatsThat first.`);
    process.exit(1);
  }
  try {
    const result = migrateData({ from, to, log: console.log });
    if (!result.migrated) {
      console.log(`Nothing to do: ${result.reason}${result.marker ? ` (on ${result.marker.at})` : ''}`);
    } else {
      console.log(`\nMigrated ${result.copied.length} item(s)${result.skipped.length ? `, kept ${result.skipped.length} existing` : ''}.`);
      console.log('The originals were left in place; delete them from the checkout once the app is working.');
    }
  } catch (err) {
    console.error(`✗ ${err.message}`);
    process.exit(1);
  }
})();
