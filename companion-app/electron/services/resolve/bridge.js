/**
 * VSR Phase 0 — Node-side Resolve bridge. Owns the long-lived Python child
 * (bridge.py): NDJSON over stdio, id-correlated request/response, a 5s/15s
 * watchdog, a boot timeout, capped restarts, and graceful shutdown.
 *
 * PORTED FROM First Cut v3 (FCRS-001), as a move rather than a rewrite — see the
 * header of bridge.py. The only structural change is that the three First Cut
 * singletons this file reached for (timestampLogger, flags, tracing) are now
 * constructor options with inert defaults. That keeps the control flow identical in
 * both trees while removing the dependency on modules this app does not have, so the
 * merge into First Cut v4 stays a file move.
 */

'use strict';

const { spawn } = require('child_process');
const readline = require('readline');
const path = require('path');
const fs = require('fs');

const BRIDGE_PY = path.join(__dirname, 'bridge.py');

/** Same probe order the existing resolve-api.js uses: brew python first, then the
 *  Command Line Tools python, which is enough to import DaVinciResolveScript. */
function findPython() {
  for (const p of ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3']) {
    if (fs.existsSync(p)) return p;
  }
  return 'python3';
}
const MAC_API = '/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting';
const MAC_LIB = '/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/fusionscript.so';

/** Tracing shim: same shape as First Cut's span, does nothing. */
const NO_TRACE = {
  startSpan() {
    const span = {
      setVerdict() { return span; },
      setStatus() { return span; },
      end() {},
    };
    return span;
  },
};

class ResolveBridge {
  constructor(opts = {}) {
    this.python = opts.python || process.env.VSR_RESOLVE_PYTHON || findPython();
    this.scriptPath = opts.scriptPath || BRIDGE_PY;
    this.callTimeoutMs = opts.callTimeoutMs || 15000;
    this.bootTimeoutMs = opts.bootTimeoutMs || 30000;
    this.watchdogEnabled = opts.watchdog !== false;
    this.watchdogIntervalMs = opts.watchdogIntervalMs || 5000;
    this.watchdogTimeoutMs = opts.watchdogTimeoutMs || 15000;
    this.maxRestarts = opts.maxRestarts != null ? opts.maxRestarts : 3;
    this.warn = opts.warn || ((...a) => console.warn(...a));
    this.tracer = opts.tracer || NO_TRACE;
    this._proc = null;
    this._rl = null;
    this._nextId = 1;
    this._pending = new Map();
    this._restarts = 0;
    this._watchdog = null;
    this._closed = false;
    this._bootTimer = null;
  }

  start() {
    if (this._proc) return this._ready;
    this._ready = new Promise((resolve, reject) => {
      this._readyResolve = resolve;
      this._readyReject = reject;
    });
    const env = { ...process.env };
    if (fs.existsSync(MAC_API)) env.RESOLVE_SCRIPT_API = MAC_API;
    if (fs.existsSync(MAC_LIB)) env.RESOLVE_SCRIPT_LIB = MAC_LIB;

    this._proc = spawn(this.python, ['-u', this.scriptPath], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    this._rl = readline.createInterface({ input: this._proc.stdout });
    this._rl.on('line', (line) => this._onLine(line));
    this._proc.stderr.on('data', (d) => { if (process.env.VSR_RESOLVE_DEBUG) this.warn('[bridge.py]', String(d).trim()); });
    this._proc.on('exit', (code, sig) => this._onExit(code, sig));
    this._proc.on('error', (e) => { if (this._readyReject) this._readyReject(new Error(`spawn failed: ${e.message}`)); });

    this._bootTimer = setTimeout(() => {
      if (this._readyReject) this._readyReject(new Error(`bridge boot timed out after ${this.bootTimeoutMs}ms`));
    }, this.bootTimeoutMs);
    if (this._bootTimer.unref) this._bootTimer.unref();

    return this._ready;
  }

  _onLine(line) {
    line = String(line).trim();
    if (!line) return;
    let msg;
    try { msg = JSON.parse(line); } catch (_) { return; }
    if (msg.id === 0) { // boot/ready
      clearTimeout(this._bootTimer);
      if (msg.ok) { if (this.watchdogEnabled) this._startWatchdog(); this._readyResolve(msg.result); }
      else { this._readyReject(new Error(`bridge boot failed: ${msg.error && msg.error.message}`)); }
      return;
    }
    const p = this._pending.get(msg.id);
    if (!p) return;
    this._pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(Object.assign(new Error((msg.error && msg.error.message) || 'bridge error'), { type: msg.error && msg.error.type }));
  }

  // Trace every Resolve call as a span. Inert unless a tracer is supplied, so the
  // default path is the same code with no observable effect. The watchdog ping is
  // excluded as noise.
  call(method, params = {}, timeoutMs) {
    const p = this._call(method, params, timeoutMs);
    if (method === 'ping' || this.tracer === NO_TRACE) return p;
    const span = this.tracer.startSpan(`vsr.resolve.${method}`, { kind: 'CLIENT', attributes: { 'vsr.resolve.method': method } });
    return p.then(
      (r) => { span.setVerdict('ok').end(); return r; },
      (e) => { span.setStatus('ERROR', e && e.message).setVerdict('failed').end(); throw e; },
    );
  }

  _call(method, params = {}, timeoutMs) {
    if (this._closed) return Promise.reject(new Error('bridge closed'));
    if (!this._proc || !this._proc.stdin.writable) return Promise.reject(new Error('bridge child not running'));
    const id = this._nextId++;
    const to = timeoutMs || this.callTimeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this._pending.delete(id); reject(new Error(`call ${method} timed out after ${to}ms`)); }, to);
      this._pending.set(id, { resolve, reject, timer, method });
      this._proc.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }

  _startWatchdog() {
    this._watchdog = setInterval(() => {
      if (this._closed || !this._proc) return;
      this.call('ping', {}, this.watchdogTimeoutMs).catch((e) => {
        this.warn('[ResolveBridge] watchdog ping failed:', e.message);
        try { if (this._proc) this._proc.kill('SIGKILL'); } catch (_) { /* exit handler restarts */ }
      });
    }, this.watchdogIntervalMs);
    if (this._watchdog.unref) this._watchdog.unref();
  }

  _onExit(code, sig) {
    if (this._watchdog) { clearInterval(this._watchdog); this._watchdog = null; }
    for (const [, p] of this._pending) { clearTimeout(p.timer); p.reject(new Error('bridge child exited')); }
    this._pending.clear();
    this._proc = null;
    this._rl = null;
    if (this._closed) return;
    if (this._restarts < this.maxRestarts) {
      this._restarts += 1;
      this.warn(`[ResolveBridge] child exited (code=${code} sig=${sig}); restart #${this._restarts}`);
      setTimeout(() => { if (!this._closed) this.start(); }, 400 * this._restarts);
    } else {
      this.warn('[ResolveBridge] child exited and max restarts reached');
    }
  }

  async stop() {
    this._closed = true;
    if (this._watchdog) { clearInterval(this._watchdog); this._watchdog = null; }
    try { await this.call('shutdown', {}, 2000); } catch (_) { /* may already be gone */ }
    setTimeout(() => { try { if (this._proc) this._proc.kill('SIGTERM'); } catch (_) {} }, 300);
  }
}

/** Convenience: start a bridge, run fn(bridge), always stop. */
async function withBridge(fn, opts = {}) {
  const b = new ResolveBridge(opts);
  const info = await b.start();
  try {
    return await fn(b, info);
  } finally {
    await b.stop();
  }
}

module.exports = { ResolveBridge, withBridge, BRIDGE_PY, MAC_API, MAC_LIB };
