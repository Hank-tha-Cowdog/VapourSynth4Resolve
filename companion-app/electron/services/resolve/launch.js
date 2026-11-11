/**
 * Launch DaVinci Resolve if it is not running, and wait until its scripting API
 * actually answers.
 *
 * The third of the three things Phase 0 adds on top of the port. It is separate from
 * the bridge because the bridge's job is to hold a connection, and a bridge that
 * silently started an application as a side effect of being constructed would be a
 * surprising thing to own.
 *
 * "Running" and "answering" are different states and the gap between them is long.
 * Resolve's process exists many seconds before scriptapp('Resolve') returns anything
 * but None — it has to finish loading, and on a cold start it may show a project
 * manager or a dialog and never get there at all. So this polls the API rather than
 * the process table, and gives up with a clear reason instead of hanging.
 */

'use strict';

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { ResolveBridge } = require('./bridge');

const APP = '/Applications/DaVinci Resolve/DaVinci Resolve.app';

function isInstalled() {
  return fs.existsSync(APP);
}

/** Is the process up? Says nothing about whether scripting answers yet. */
function isRunning() {
  return new Promise((resolve) => {
    execFile('/usr/bin/pgrep', ['-x', 'Resolve'], (err, stdout) => {
      resolve(!err && String(stdout).trim().length > 0);
    });
  });
}

function open() {
  const child = spawn('/usr/bin/open', ['-a', APP], { detached: true, stdio: 'ignore' });
  child.unref();
}

/**
 * Try one short-lived bridge. Resolves to the boot info, or null if the API is not
 * answering yet. A failure here is expected during startup and is not an error.
 */
async function probe(opts = {}) {
  const b = new ResolveBridge({
    ...opts,
    watchdog: false,
    maxRestarts: 0,
    bootTimeoutMs: opts.probeTimeoutMs || 8000,
  });
  try {
    return await b.start();
  } catch (_) {
    return null;
  } finally {
    try { await b.stop(); } catch (_) { /* nothing to stop */ }
  }
}

/**
 * @returns {Promise<{ok:boolean, launched:boolean, info?:object, reason?:string}>}
 */
async function ensureRunning(opts = {}) {
  const timeoutMs = opts.timeoutMs || 120000;
  const pollMs = opts.pollMs || 3000;

  if (!isInstalled()) {
    return { ok: false, launched: false, reason: `DaVinci Resolve is not installed at ${APP}` };
  }

  const first = await probe(opts);
  if (first) return { ok: true, launched: false, info: first };

  let launched = false;
  if (!(await isRunning())) {
    open();
    launched = true;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    const info = await probe(opts);
    if (info) return { ok: true, launched, info };
  }

  // Distinguish the two failures, because the fixes are different: a process that
  // never appeared is an install or permissions problem, whereas a process that is up
  // but silent is almost always scripting left at "Local" disabled in preferences, or
  // a modal dialog — the project manager included — holding the API closed.
  const up = await isRunning();
  return {
    ok: false,
    launched,
    reason: up
      ? 'Resolve is running but its scripting API did not answer. Check Preferences > '
        + 'System > General > External scripting using, and close any open dialog or '
        + 'the Project Manager.'
      : 'Resolve did not start.',
  };
}

module.exports = { ensureRunning, isInstalled, isRunning, probe, APP };
