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
// with the app and terminal closed — and, for the resident Mac app, the
// fallback when the app itself was quit. The dev checkout and the packaged
// app share the label: whichever booted last owns the agent, and each
// repairs it (ensureAgent) on its next boot.

const AGENT_LABEL = 'net.whatsthat.scheduler';

function agentPaths() {
  const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', `${AGENT_LABEL}.plist`);
  return { plist, label: AGENT_LABEL };
}

const escXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function agentPlistXml({ nodePath, scriptPath, logPath, intervalSec = 120, env = null }) {
  const envXml =
    env && Object.keys(env).length
      ? `
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env)
  .map(([k, v]) => `    <key>${escXml(k)}</key><string>${escXml(v)}</string>`)
  .join('\n')}
  </dict>`
      : '';
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
  <key>RunAtLoad</key><false/>${envXml}
  <key>StandardOutPath</key><string>${escXml(logPath)}</string>
  <key>StandardErrorPath</key><string>${escXml(logPath)}</string>
</dict>
</plist>
`;
}

// What the agent should run for THIS engine. Packaged: the app's own binary
// as node (ELECTRON_RUN_AS_NODE) against the unpacked scripts/run-due.js,
// with the data dir spelled out (launchd starts with an empty env).
function agentSpec({ rootDir, dataDir = rootDir, packaged = false, execPath = process.execPath, env = process.env, port = null } = {}) {
  return {
    nodePath: packaged ? execPath : stableNodePath(),
    scriptPath: path.join(rootDir, 'scripts', 'run-due.js'),
    logPath: path.join(dataDir, 'logs', 'scheduler.log'),
    env: {
      WHATSTHAT_DATA_DIR: dataDir,
      ...(port ? { PORT: String(port) } : {}),
      ...(packaged ? { ELECTRON_RUN_AS_NODE: '1', WHATSTHAT_PACKAGED: '1' } : {}),
      ...(env.WHATSTHAT_CHROME ? { WHATSTHAT_CHROME: env.WHATSTHAT_CHROME } : {}),
    },
  };
}

const launchctl = (args) => execFileSync('launchctl', args, { stdio: 'ignore' });

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

// `spec` is an agentSpec() result (or { rootDir, dataDir } for the old
// call shape). `exec`/`plistPath` are injectable for tests.
function installAgent(spec, { exec = launchctl, plistPath } = {}) {
  if (!spec.scriptPath) spec = agentSpec(spec);
  const plist = plistPath || agentPaths().plist;
  fs.mkdirSync(path.dirname(plist), { recursive: true });
  fs.mkdirSync(path.dirname(spec.logPath), { recursive: true }); // launchd will not create it
  fs.writeFileSync(plist, agentPlistXml(spec));
  const domain = `gui/${process.getuid()}`;
  try {
    exec(['bootout', domain, plist]);
  } catch {
    /* not loaded yet — fine */
  }
  exec(['bootstrap', domain, plist]);
  return { installed: true, plist };
}

// Self-repair: (re)install only when the on-disk plist differs from what
// this engine wants (app moved, reinstalled, dev↔packaged, data dir change)
// or launchd no longer has it loaded. Deterministic rendering makes a
// string compare sufficient.
function ensureAgent(spec, { exec = launchctl, plistPath, installed = isAgentInstalled } = {}) {
  if (!spec.scriptPath) spec = agentSpec(spec);
  const plist = plistPath || agentPaths().plist;
  const desired = agentPlistXml(spec);
  let current = null;
  try {
    current = fs.readFileSync(plist, 'utf8');
  } catch {
    /* not installed */
  }
  if (current === desired && installed()) return { installed: true, plist, changed: false, repaired: false };
  installAgent(spec, { exec, plistPath: plist });
  return { installed: true, plist, changed: true, repaired: Boolean(current) && current !== desired };
}

function uninstallAgent({ exec = launchctl, plistPath } = {}) {
  const plist = plistPath || agentPaths().plist;
  const domain = `gui/${process.getuid()}`;
  try {
    exec(['bootout', domain, plist]);
  } catch {
    /* wasn't loaded */
  }
  try {
    fs.unlinkSync(plist);
  } catch {
    /* wasn't there */
  }
  return { installed: false, plist };
}

module.exports = {
  createScheduleStore,
  agentPlistXml,
  agentPaths,
  isAgentInstalled,
  agentSpec,
  installAgent,
  ensureAgent,
  uninstallAgent,
  stableNodePath,
  MAX_LATENESS_MS,
  STALE_RUNNING_MS,
  AGENT_LABEL,
};
