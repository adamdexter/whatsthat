'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { JsonStore } = require('./store');

// A scheduled campaign is a full snapshot taken at scheduling time —
// contacts, template, delays — so what you previewed is exactly what sends.
// Statuses: pending -> running -> done | failed; also cancelled | missed.

// If the machine was asleep/off past the send time, still send if we're
// within this window — beyond it the message is stale, so mark it missed.
const MAX_LATENESS_MS = 6 * 60 * 60 * 1000; // 6 hours
// A campaign stuck in 'running' longer than this was interrupted (crash/kill).
const STALE_RUNNING_MS = 30 * 60 * 1000;

function createScheduleStore(file) {
  const store = new JsonStore(file);
  const read = () => store.read().campaigns || [];
  const write = (campaigns) => store.write({ campaigns });

  return {
    list: read,

    get(id) {
      return read().find((c) => c.id === id) || null;
    },

    add({ sendAt, contacts, template, delayMinMs, delayMaxMs }) {
      const campaign = {
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        sendAt,
        contacts,
        template,
        delayMinMs,
        delayMaxMs,
        status: 'pending',
      };
      write([...read(), campaign]);
      return campaign;
    },

    patch(id, changes) {
      const campaigns = read().map((c) => (c.id === id ? { ...c, ...changes } : c));
      write(campaigns);
      return campaigns.find((c) => c.id === id) || null;
    },

    cancel(id) {
      const c = this.get(id);
      if (!c || c.status !== 'pending') return null;
      return this.patch(id, { status: 'cancelled', cancelledAt: new Date().toISOString() });
    },

    // Returns pending campaigns that should send now, after housekeeping:
    // overdue-beyond-window -> missed; stale 'running' -> failed.
    findDue(now = Date.now()) {
      for (const c of read()) {
        if (c.status === 'pending' && now - Date.parse(c.sendAt) > MAX_LATENESS_MS) {
          this.patch(c.id, {
            status: 'missed',
            error: `Machine was unavailable for more than ${MAX_LATENESS_MS / 3600000}h past the send time`,
          });
        } else if (c.status === 'running' && now - Date.parse(c.startedAt || c.sendAt) > STALE_RUNNING_MS) {
          this.patch(c.id, { status: 'failed', error: 'Run was interrupted (machine shutdown or crash)' });
        }
      }
      return read().filter((c) => c.status === 'pending' && Date.parse(c.sendAt) <= now);
    },
  };
}

// ---------- launchd background agent ----------
// One agent, fired every 2 minutes, runs scripts/run-due.js which exits
// immediately when nothing is due. This is what makes scheduled sends work
// with the app and terminal closed.

const AGENT_LABEL = 'net.whatsthat.scheduler';

function agentPaths() {
  const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', `${AGENT_LABEL}.plist`);
  return { plist, label: AGENT_LABEL };
}

function agentPlistXml({ nodePath, scriptPath, logPath, intervalSec = 120 }) {
  const escXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escXml(nodePath)}</string>
    <string>${escXml(scriptPath)}</string>
  </array>
  <key>StartInterval</key><integer>${intervalSec}</integer>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>${escXml(logPath)}</string>
  <key>StandardErrorPath</key><string>${escXml(logPath)}</string>
</dict>
</plist>
`;
}

function isAgentInstalled() {
  try {
    const out = execFileSync('launchctl', ['list'], { encoding: 'utf8' });
    return out.includes(AGENT_LABEL);
  } catch {
    return false;
  }
}

// Prefer a stable node path — process.execPath resolves to a version-pinned
// Homebrew Cellar path that breaks on `brew upgrade node`.
function stableNodePath() {
  for (const p of ['/opt/homebrew/bin/node', '/usr/local/bin/node']) {
    if (fs.existsSync(p)) return p;
  }
  return process.execPath;
}

function installAgent({ rootDir }) {
  const { plist } = agentPaths();
  const xml = agentPlistXml({
    nodePath: stableNodePath(),
    scriptPath: path.join(rootDir, 'scripts', 'run-due.js'),
    logPath: path.join(rootDir, 'scheduler.log'),
  });
  fs.mkdirSync(path.dirname(plist), { recursive: true });
  fs.writeFileSync(plist, xml);
  const domain = `gui/${process.getuid()}`;
  try {
    execFileSync('launchctl', ['bootout', domain, plist], { stdio: 'ignore' });
  } catch {
    /* not loaded yet — fine */
  }
  execFileSync('launchctl', ['bootstrap', domain, plist], { stdio: 'ignore' });
  return { installed: true, plist };
}

function uninstallAgent() {
  const { plist } = agentPaths();
  const domain = `gui/${process.getuid()}`;
  try {
    execFileSync('launchctl', ['bootout', domain, plist], { stdio: 'ignore' });
  } catch {
    /* wasn't loaded */
  }
  try {
    fs.unlinkSync(plist);
  } catch {
    /* wasn't there */
  }
}

module.exports = {
  createScheduleStore,
  agentPlistXml,
  agentPaths,
  isAgentInstalled,
  installAgent,
  uninstallAgent,
  MAX_LATENESS_MS,
  STALE_RUNNING_MS,
  AGENT_LABEL,
};
