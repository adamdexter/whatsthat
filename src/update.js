'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// Launch-time auto-update of whatsapp-web.js. WhatsApp Web changes under us
// (see CLAUDE.md — the July 2026 `_serialized`→`$1` rename), so every
// interactive launch checks the npm registry and installs a newer release
// before the server boots. Failures never block launch: worst case we keep
// running the installed version and record why in update.local.json, which
// /api/state surfaces so the UI can show what happened.

const defaultExec = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 180000, ...opts }, (err, stdout, stderr) => {
      if (err) {
        const why = err.killed ? 'timed out' : String(stderr || err.message).trim().split('\n')[0];
        reject(new Error(why));
      } else {
        resolve(String(stdout).trim());
      }
    });
  });

async function checkAndUpdate({ rootDir, dataDir = rootDir, exec = defaultExec, log = () => {}, registryTimeoutMs = 10000 }) {
  const resultFile = path.join(dataDir, 'update.local.json');
  const record = (result) => {
    const full = { checkedAt: new Date().toISOString(), ...result };
    try {
      fs.writeFileSync(resultFile, JSON.stringify(full, null, 2));
    } catch {
      /* recording is best-effort */
    }
    return full;
  };

  const pkgFile = path.join(rootDir, 'node_modules', 'whatsapp-web.js', 'package.json');
  const installed = JSON.parse(fs.readFileSync(pkgFile, 'utf8')).version;

  // The launchd runner may be mid-send with the library loaded — swapping
  // node_modules under an active WhatsApp session is not worth the race.
  try {
    const sched = JSON.parse(fs.readFileSync(path.join(dataDir, 'schedule.local.json'), 'utf8'));
    if ((sched.campaigns || []).some((c) => c.status === 'running')) {
      log('auto-update: a scheduled send is running — skipping the check this launch');
      return record({ installed, skipped: 'scheduled send in progress' });
    }
  } catch {
    /* no schedule file — nothing running */
  }

  let latest;
  try {
    latest = await exec('npm', ['view', 'whatsapp-web.js', 'version'], { cwd: rootDir, timeout: registryTimeoutMs });
  } catch (err) {
    log(`auto-update: could not reach the npm registry (${err.message}) — keeping v${installed}`);
    return record({ installed, error: `registry check failed: ${err.message}` });
  }

  if (latest === installed) {
    log(`auto-update: whatsapp-web.js v${installed} is current`);
    return record({ installed, latest, updated: false });
  }

  log(`auto-update: whatsapp-web.js v${latest} available (installed v${installed}) — updating before launch…`);

  // Retire our version-pinned compatibility patch before the version changes
  // under it — patch-package would otherwise fail the install's postinstall.
  // Kept in patches-retired/ so it can be restored if the new release turns
  // out not to include the fix (see CLAUDE.md → architecture invariants).
  const patchName = `whatsapp-web.js+${installed}.patch`;
  const patchFile = path.join(rootDir, 'patches', patchName);
  const retiredFile = path.join(rootDir, 'patches-retired', patchName);
  let patchRetired = false;
  if (fs.existsSync(patchFile)) {
    fs.mkdirSync(path.dirname(retiredFile), { recursive: true });
    fs.renameSync(patchFile, retiredFile);
    patchRetired = true;
    log(`auto-update: retired patches/${patchName} (kept in patches-retired/) — v${latest} should supersede it. If sends break, restore the patch and run: npm install whatsapp-web.js@${installed}`);
  }

  try {
    await exec('npm', ['install', `whatsapp-web.js@${latest}`], { cwd: rootDir });
  } catch (err) {
    if (patchRetired) fs.renameSync(retiredFile, patchFile); // tree unchanged — keep the patch active
    log(`auto-update: install failed (${err.message}) — continuing with v${installed}`);
    return record({ installed, latest, updated: false, error: `install failed: ${err.message}` });
  }

  const now = JSON.parse(fs.readFileSync(pkgFile, 'utf8')).version;
  log(`auto-update: whatsapp-web.js updated v${installed} → v${now}`);
  return record({ installed: now, previous: installed, latest, updated: true, patchRetired });
}

module.exports = { checkAndUpdate };
