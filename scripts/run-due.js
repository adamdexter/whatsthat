'use strict';

// Invoked by the launchd agent every 2 minutes (and harmless to run by hand).
// Sends any due scheduled campaigns:
//   - If the WhatsThat app is running, it asks the APP to send (the app owns
//     the WhatsApp session — two processes must never share it).
//   - Otherwise it boots its own headless WhatsApp client, sends, and exits.
// Exits silently when nothing is due, so the every-2-min spawn costs nothing.

const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const { resolveDataDir, readEngineInfo, pidAlive, sessionLockPid } = require(path.join(ROOT, 'src', 'datadir'));
const DATA_DIR = resolveDataDir({ rootDir: ROOT }).dir;
const PORT = Number(process.env.PORT || 3847);
const MOCK = process.env.WHATSTHAT_MOCK === '1';

const { createScheduleStore } = require(path.join(ROOT, 'src', 'schedule'));

const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);

// launchd appends our stdout/stderr to scheduler.log forever (Electron-as-
// node even prints a harmless codesign line on every start). Keep the tail.
const LOG_MAX = 2 * 1024 * 1024;
const LOG_KEEP = 256 * 1024;
function trimLog(file = path.join(DATA_DIR, 'logs', 'scheduler.log'), { max = LOG_MAX, keep = LOG_KEEP } = {}) {
  try {
    const size = fs.statSync(file).size;
    if (size <= max) return false;
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(keep);
    const n = fs.readSync(fd, buf, 0, keep, size - keep);
    fs.closeSync(fd);
    fs.writeFileSync(file, buf.subarray(0, n)); // launchd's O_APPEND fd carries on at the new end
    return true;
  } catch {
    return false;
  }
}

// The app normally sits on 3847, but engine.local.json is authoritative
// (an app that fell back to an ephemeral port still owns the session).
function candidatePorts() {
  const info = readEngineInfo(DATA_DIR);
  const ports = info && pidAlive(info.pid) ? [info.port] : [];
  ports.push(PORT, 3847);
  return [...new Set(ports)];
}

async function findRunningApp() {
  for (const port of candidatePorts()) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return port;
    } catch {
      /* nothing on that port */
    }
  }
  return null;
}

async function main() {
  trimLog();
  const schedule = createScheduleStore(path.join(DATA_DIR, 'schedule.local.json'));
  const due = schedule.findDue();
  if (due.length === 0) return; // the common case: nothing to do, exit quietly

  log(`${due.length} due campaign(s)`);

  const appPort = await findRunningApp();
  if (appPort) {
    // The app owns the WhatsApp session — trigger it and let it send.
    log(`App is running on port ${appPort} — asking it to send`);
    const token = readEngineInfo(DATA_DIR)?.token || process.env.WHATSTHAT_API_TOKEN;
    const res = await fetch(`http://127.0.0.1:${appPort}/api/schedule/run-due`, {
      method: 'POST',
      headers: token ? { 'X-WhatsThat-Token': token } : {},
    });
    const data = await res.json().catch(() => ({}));
    log(`App response: ${JSON.stringify(data)}`);
    return;
  }

  // Nobody answered, but is the WhatsApp profile still open (an engine that
  // is starting, or one that hung without a port)? Two clients on one
  // profile is the one thing that must never happen — wait for the next tick.
  const lockPid = sessionLockPid(DATA_DIR);
  if (lockPid && pidAlive(lockPid)) {
    log(`WhatsApp profile is in use by pid ${lockPid} but no app answered — skipping this tick`);
    return;
  }

  // App is closed — run headless with our own client.
  log('App is not running — booting headless WhatsApp client');
  const { createWhatsApp } = require(path.join(ROOT, 'src', 'whatsapp'));
  const { createRunner } = require(path.join(ROOT, 'src', 'runner'));
  const wa = createWhatsApp({ mock: MOCK, dataDir: DATA_DIR });

  // Signal teardown is ours now (puppeteer's own handlers are disabled) —
  // make sure an interrupted manual run doesn't leave a browser behind.
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      try {
        await wa.destroy?.();
      } catch {
        /* browser already gone */
      }
      process.exit(130);
    });
  }

  // 240s: enough for a slow boot plus one startup-watchdog relaunch.
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('WhatsApp client did not become ready within 240s')), 240000);
    wa.onUpdate((state) => {
      if (state.status === 'ready') {
        clearTimeout(timeout);
        resolve();
      } else if (state.status === 'qr' && !MOCK) {
        // A saved session never shows a QR — this means the link is gone.
        clearTimeout(timeout);
        reject(new Error('WhatsApp session is not linked (QR scan needed) — open the app and link first'));
      } else if (state.status === 'error' || state.status === 'disconnected') {
        clearTimeout(timeout);
        reject(new Error(state.error || state.status));
      }
    });
  });

  wa.initialize();

  try {
    await ready;
  } catch (err) {
    log(`Cannot send: ${err.message}`);
    for (const c of due) schedule.patch(c.id, { status: 'failed', error: err.message });
    process.exit(1);
  }

  const runner = createRunner({ wa, reportsDir: path.join(DATA_DIR, 'reports') });

  for (const campaign of due) {
    schedule.patch(campaign.id, { status: 'running', startedAt: new Date().toISOString() });
    log(`Sending "${campaign.template.slice(0, 40)}…" to ${campaign.contacts.length} contacts`);
    try {
      const { summary, reportFile } = await runner.start({
        contacts: campaign.contacts,
        template: campaign.template,
        delayMinMs: campaign.delayMinMs,
        delayMaxMs: campaign.delayMaxMs,
        onProgress: (e) => {
          if (e.type === 'progress') log(`  ${e.status}: ${e.name}${e.error ? ` (${e.error})` : ''}`);
        },
      });
      schedule.patch(campaign.id, { status: 'done', finishedAt: new Date().toISOString(), summary, reportFile });
      log(`Done: ${summary.sent} sent, ${summary.failed} failed`);
    } catch (err) {
      schedule.patch(campaign.id, { status: 'failed', error: err.message });
      log(`Failed: ${err.message}`);
    }
  }

  if (wa.destroy) await wa.destroy().catch(() => {});
  process.exit(0);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[${new Date().toISOString()}] Scheduler error:`, err.message);
    process.exit(1);
  });
}

module.exports = { trimLog };
