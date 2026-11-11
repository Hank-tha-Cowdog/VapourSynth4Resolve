// Persistent preview client. One active request and one latest-wins queued
// request share a generation-owned child. Source interruption, deadline and
// protocol failures never overlap a replacement with an unconfirmed old child.
'use strict';
const { spawn } = require('child_process');
const { constants: BUFFER_CONSTANTS } = require('buffer');

const IDLE_MS = 60_000;
const REQUEST_MS = 30_000; // Existing one-shot caller's render budget.
const CLOSE_GRACE_MS = 5_000; // Existing owned-child cleanup observation grace.
// Ordinary scopes have 126,976 fixed integer cells plus geometry-dependent
// columns. A synthetic 8192-column scope fixture fits below ~9MiB with a
// conservative numeric/delimiter allowance. This is an operational budget, NOT
// a universal format/geometry maximum. Exceeding it is a visible failure.
const RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_CONSECUTIVE_CRASHES = 3;
const TIMER_MAX = 0x7fffffff;

function positiveInteger(value, maximum, name) {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
        throw new RangeError(`${name} must be an integer from 1 to ${maximum}`);
    }
    return value;
}

class RenderWorker {
    constructor({ python, renderScript, vsPythonDir, log, idleMs, env,
        timeoutMs = REQUEST_MS, closeGraceMs = CLOSE_GRACE_MS,
        maxResponseBytes = RESPONSE_BYTES }) {
        this.python = python;
        this.renderScript = renderScript;
        this.vsPythonDir = vsPythonDir || null;
        this.log = log || (() => {});
        this.idleMs = idleMs || IDLE_MS;
        this.timeoutMs = positiveInteger(timeoutMs, TIMER_MAX, 'timeoutMs');
        this.closeGraceMs = positiveInteger(closeGraceMs, TIMER_MAX, 'closeGraceMs');
        this.maxResponseBytes = positiveInteger(maxResponseBytes,
            BUFFER_CONSTANTS.MAX_STRING_LENGTH, 'maxResponseBytes');
        this.envOverride = env || null;
        this.proc = null;
        this.context = null;
        this.inflight = null;
        this.queued = null;
        this.buffer = '';
        this.consecutiveCrashes = 0;
        this.idleTimer = null;
        this.disposed = false;
    }

    _env() {
        const env = { ...(this.envOverride ?? process.env) };
        if (this.vsPythonDir) env.VSRES_VS_PYTHON = this.vsPythonDir;
        return env;
    }

    _owns(ctx) { return this.context === ctx && !ctx.closed; }

    _closure(known) { return { closureKnown: known, closureUnknown: !known }; }

    _settle(entry, response) {
        if (!entry || entry.settled) return;
        entry.settled = true;
        if (entry.timer) clearTimeout(entry.timer);
        entry.timer = null;
        if (this.inflight === entry) this.inflight = null;
        if (this.queued === entry) this.queued = null;
        entry.resolve({ id: entry.req.id, ...response });
    }

    _clearIdle() {
        if (this.idleTimer) clearTimeout(this.idleTimer);
        this.idleTimer = null;
    }

    _armIdle() {
        this._clearIdle();
        const ctx = this.context;
        if (this.disposed || !ctx || ctx.stopping) return;
        this.idleTimer = setTimeout(() => {
            this.idleTimer = null;
            if (this._owns(ctx) && !this.inflight && !this.queued) {
                this._stop(ctx, { error: 'render worker idle shutdown' }, 'idle');
            }
        }, this.idleMs);
    }

    _start() {
        const proc = spawn(this.python, [this.renderScript, '--server'],
            { env: this._env(), stdio: ['pipe', 'pipe', 'pipe'] });
        const ctx = { proc, closed: false, stopping: null, buffer: '',
            stdoutBytes: 0, maxResponseBytes: this.maxResponseBytes };
        this.context = ctx;
        this.proc = proc;
        this.buffer = '';
        proc.stdout.setEncoding('utf8');
        proc.stdout.on('data', data => this._stdout(ctx, data));
        proc.stderr.setEncoding('utf8');
        proc.stderr.on('data', () => { /* Drain, never retain worker chatter. */ });
        for (const [name, stream] of [['stdout', proc.stdout], ['stderr', proc.stderr]]) {
            stream.on('error', error => {
                if (this._owns(ctx) && !ctx.stopping) {
                    this._stop(ctx, { error: `render worker ${name} stream failed: ` +
                        String(error.code || error.message).slice(0, 200) }, 'error');
                }
            });
        }
        proc.stdin.on('error', error => {
            if (this._owns(ctx) && !ctx.stopping) {
                this._stop(ctx, { error: 'render worker write failed: ' +
                    String(error.code || error.message).slice(0, 200) }, 'write');
            }
        });
        proc.on('error', error => {
            if (!this._owns(ctx)) return;
            if (!proc.pid) {
                this._closed(ctx, 'render worker spawn failed: ' +
                    String(error.code || error.message).slice(0, 200));
            } else if (ctx.stopping) {
                this._unknown(ctx, 'termination control error: ' +
                    String(error.code || error.message).slice(0, 200));
            } else {
                this._stop(ctx, { error: 'render worker error: ' +
                    String(error.code || error.message).slice(0, 200) }, 'error');
            }
        });
        proc.on('close', () => this._closed(ctx));
        return ctx;
    }

    _stdout(ctx, data) {
        if (!this._owns(ctx) || ctx.stopping || this.disposed) return;
        const text = typeof data === 'string' ? data : data.toString('utf8');
        let start = 0;
        while (start < text.length) {
            const newline = text.indexOf('\n', start);
            const end = newline < 0 ? text.length : newline;
            const piece = text.slice(start, end);
            const bytes = Buffer.byteLength(piece, 'utf8') + (newline < 0 ? 0 : 1);
            if (bytes > ctx.maxResponseBytes - ctx.stdoutBytes) {
                this._stop(ctx, { outputLimit: true,
                    error: `render worker stdout exceeded its ${ctx.maxResponseBytes}-byte response budget; increase maxOutputBytes (worker maxResponseBytes) for a larger legitimate payload.` }, 'protocol');
                return;
            }
            ctx.stdoutBytes += bytes;
            ctx.buffer += piece;
            this.buffer = ctx.buffer;
            if (newline < 0) return;
            const line = ctx.buffer.trim();
            ctx.buffer = '';
            this.buffer = '';
            start = newline + 1;
            if (!line) continue;
            let response;
            try { response = JSON.parse(line); } catch { continue; }
            const active = this.inflight;
            if (!active || active.ctx !== ctx || !response ||
                typeof response !== 'object' || response.id !== active.req.id) continue;
            if (Array.isArray(response) || typeof response.ok !== 'boolean') {
                this._stop(ctx, { protocolError: true,
                    error: 'render worker returned a malformed response for the active request' }, 'protocol');
                return;
            }
            // A real script error is a final response, not permission to
            // replay it through one-shot based on words inside its message.
            try { active.onRequestComplete?.(); }
            catch (error) {
                this._stop(ctx, { error: 'render worker output completion observer failed: ' +
                    String(error.message).slice(0, 200) }, 'error');
                return;
            }
            this._settle(active, response.ok ? response : {
                ...response, noAutomaticReplay: true,
            });
            this.consecutiveCrashes = 0;
            ctx.stdoutBytes = 0;
            ctx.maxResponseBytes = this.maxResponseBytes;
            this._pump();
            if (!this.inflight) this._armIdle();
            if (!this._owns(ctx) || ctx.stopping) return;
        }
    }

    _closed(ctx, spawnError) {
        if (!this._owns(ctx)) return; // Old-generation events never touch new work.
        ctx.closed = true;
        if (ctx.stopping?.timer) clearTimeout(ctx.stopping.timer);
        const active = this.inflight?.ctx === ctx ? this.inflight : null;
        const stop = ctx.stopping;
        this._clearIdle();
        this.context = null;
        this.proc = null;
        this.buffer = '';
        ctx.buffer = '';
        if (active) {
            this._settle(active, stop ? { ...stop.response, ...this._closure(true) } : {
                ok: false, error: spawnError || 'render worker exited mid-request',
                ...this._closure(true), noAutomaticReplay: false,
            });
        }
        if (this.disposed) {
            this._settle(this.queued, { ok: false, superseded: true,
                error: 'render worker disposed', ...this._closure(true), noAutomaticReplay: true });
            return;
        }
        if (!stop && active) {
            this.consecutiveCrashes += 1;
            this.log(`render worker exited mid-request (${this.consecutiveCrashes}x)`);
        } else if (stop?.kind === 'source' || stop?.kind === 'idle' || !active) {
            this.consecutiveCrashes = 0;
        }
        this._pump();
    }

    _unknown(ctx, reason) {
        if (!this._owns(ctx) || !ctx.stopping || ctx.stopping.unknown) return;
        const stop = ctx.stopping;
        stop.unknown = true;
        if (stop.timer) clearTimeout(stop.timer);
        stop.timer = null;
        stop.response = { ...stop.response, ...this._closure(false),
            terminationError: reason, noAutomaticReplay: true };
        this._settle(this.inflight?.ctx === ctx ? this.inflight : null, stop.response);
        this._settle(this.queued, { ok: false,
            error: 'render worker closure is unconfirmed; no automatic replay is permitted.',
            ...this._closure(false), noAutomaticReplay: true });
        ctx.buffer = '';
        this.buffer = '';
        // Retain the exact old child until close. No queued work is replayed
        // on late close; every affected request has already settled once.
    }

    _stop(ctx, response, kind = 'manual') {
        if (!this._owns(ctx) || ctx.stopping) return;
        this._clearIdle();
        if (this.inflight?.ctx === ctx && this.inflight.timer) {
            clearTimeout(this.inflight.timer);
            this.inflight.timer = null;
        }
        ctx.stopping = { kind, response: { ok: false, ...response,
            noAutomaticReplay: true }, unknown: false, timer: null };
        if (!['source', 'idle', 'manual'].includes(kind)) {
            this._settle(this.queued, { ok: false,
                error: 'Queued preview was not dispatched after a render worker failure: ' + response.error,
                ...(response.timeout ? { timeout: true } : {}),
                ...(response.outputLimit ? { outputLimit: true } : {}),
                ...(response.protocolError ? { protocolError: true } : {}),
                ...this._closure(false), noAutomaticReplay: true });
        }
        ctx.buffer = '';
        this.buffer = '';
        if (!ctx.proc.pid) { this._closed(ctx); return; }
        let accepted;
        try { accepted = ctx.proc.kill('SIGKILL'); }
        catch (error) {
            this._unknown(ctx, 'termination threw: ' + String(error.code || error.message).slice(0, 200));
            return;
        }
        if (!this._owns(ctx)) return; // A synchronous close was already observed.
        if (accepted !== true) {
            this._unknown(ctx, 'termination signal was not accepted');
            return;
        }
        if (ctx.stopping.unknown) return;
        ctx.stopping.timer = setTimeout(() => {
            if (this._owns(ctx)) this._unknown(ctx,
                `child close was not observed within ${this.closeGraceMs}ms after termination`);
        }, this.closeGraceMs);
    }

    _kill() {
        if (this.context) this._stop(this.context,
            { error: 'render worker stopped' }, 'manual');
    }

    request(request, lifecycle = {}) {
        const req = { ...request };
        if (!lifecycle || typeof lifecycle !== 'object' ||
                (lifecycle.onDispatch !== undefined && typeof lifecycle.onDispatch !== 'function')) {
            return Promise.resolve({ id: req.id, ok: false,
                error: 'Invalid internal render worker dispatch observer',
                notDispatched: true, noAutomaticReplay: true });
        }
        if (this.disposed) return Promise.resolve({ id: req.id, ok: false,
            superseded: true, error: 'render worker disposed',
            ...this._closure(!this.context), noAutomaticReplay: true });
        if (this.context?.stopping && (this.context.stopping.unknown ||
                !['source', 'idle', 'manual'].includes(this.context.stopping.kind))) return Promise.resolve({ id: req.id, ok: false,
            error: 'render worker closure is unconfirmed; wait for close before retrying.',
            ...this._closure(false), noAutomaticReplay: true });
        let timeoutMs, maxResponseBytes;
        try {
            timeoutMs = positiveInteger(req.timeoutMs === undefined ? this.timeoutMs : req.timeoutMs, TIMER_MAX, 'timeoutMs');
            maxResponseBytes = positiveInteger(req.maxResponseBytes === undefined ? this.maxResponseBytes : req.maxResponseBytes,
                BUFFER_CONSTANTS.MAX_STRING_LENGTH, 'maxResponseBytes');
        } catch (error) {
            return Promise.resolve({ id: req.id, ok: false, error: error.message,
                invalidBudget: true, ...this._closure(!this.context), noAutomaticReplay: true });
        }
        let resolve;
        const promise = new Promise(done => { resolve = done; });
        const entry = { req, resolve, maxResponseBytes, ctx: null, settled: false, timer: null,
            onDispatch: lifecycle.onDispatch, onRequestComplete: null };
        entry.timer = setTimeout(() => {
            if (entry.settled) return;
            entry.timer = null;
            if (this.inflight === entry) {
                this._stop(entry.ctx, { timeout: true,
                    error: `Preview render timed out after ${timeoutMs}ms. Simplify the chain or provide a larger timeoutMs budget and retry.` }, 'timeout');
            } else if (this.queued === entry) {
                this._settle(entry, { ok: false, timeout: true,
                    error: `Preview render request timed out after ${timeoutMs}ms while queued.`,
                    ...this._closure(!this.context), noAutomaticReplay: true });
            }
        }, timeoutMs);
        this._settle(this.queued, { ok: false, superseded: true, noAutomaticReplay: true });
        this.queued = entry;
        if (this.inflight?.req.mode === 'processed' && req.mode === 'source') {
            this.consecutiveCrashes = 0;
            this._stop(this.context, { error: 'render worker interrupted for source priority',
                superseded: true }, 'source');
        }
        this._pump();
        return promise;
    }

    _pump() {
        if (this.disposed || !this.queued || this.inflight || this.context?.stopping) return;
        if (!this.context) {
            if (this.consecutiveCrashes >= MAX_CONSECUTIVE_CRASHES) {
                this._settle(this.queued, { ok: false,
                    error: 'render worker repeatedly crashed — falling back',
                    ...this._closure(true), noAutomaticReplay: false });
                return;
            }
            try { this._start(); }
            catch (error) {
                this._settle(this.queued, { ok: false,
                    error: 'render worker could not start: ' + String(error.code || error.message).slice(0, 200),
                    ...this._closure(true), noAutomaticReplay: false });
                return;
            }
        }
        const entry = this.queued;
        this.queued = null;
        const ctx = this.context;
        entry.ctx = ctx;
        this.inflight = entry;
        ctx.stdoutBytes = 0;
        ctx.maxResponseBytes = entry.maxResponseBytes;
        this._clearIdle();
        try {
            entry.onRequestComplete = entry.onDispatch?.(ctx.proc);
            if (entry.onRequestComplete !== undefined && typeof entry.onRequestComplete !== 'function') {
                throw new TypeError('dispatch observer must return a function or undefined');
            }
        } catch (error) {
            this._settle(entry, { ok: false, notDispatched: true, noAutomaticReplay: true,
                error: 'render worker output dispatch observer failed: ' + String(error.message).slice(0, 200) });
            this._pump();
            if (!this.inflight) this._armIdle();
            return;
        }
        try {
            // Internal timers/ChildProcess objects are never serialized.
            const wire = { ...entry.req };
            delete wire.timeoutMs;
            delete wire.maxResponseBytes;
            ctx.proc.stdin.write(JSON.stringify(wire) + '\n');
        } catch (error) {
            this._stop(ctx, { error: 'render worker write failed: ' +
                String(error.code || error.message).slice(0, 200) }, 'write');
        }
    }

    dispose() {
        this.disposed = true;
        this._settle(this.queued, { ok: false, superseded: true,
            error: 'render worker disposed', ...this._closure(!this.context), noAutomaticReplay: true });
        if (this.context) this._stop(this.context,
            { error: 'render worker disposed', superseded: true }, 'dispose');
        else this._clearIdle();
    }
}

const workers = new Map();
function getWorker(key, opts) {
    let worker = workers.get(key);
    // Disposal does not let a new cached instance bypass an old live child.
    if (!worker || (worker.disposed && !worker.context)) {
        worker = new RenderWorker(opts);
        workers.set(key, worker);
    }
    return worker;
}
function disposeAllWorkers() {
    for (const [key, worker] of workers) {
        worker.dispose();
        if (!worker.context) workers.delete(key);
    }
}

module.exports = { RenderWorker, getWorker, disposeAllWorkers };
