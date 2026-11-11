// Namespace cache/child contracts. All process/fs/helper/clock ports are fake;
// the actual Python/core/plugin probe is never interpreted or launched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

class Clock {
    constructor() { this.now = 0; this.next = 1; this.tasks = new Map(); }
    set(fn, ms) { const id = this.next++; this.tasks.set(id, { fn, at: this.now + ms }); return id; }
    clear(id) { this.tasks.delete(id); }
    advance(ms) {
        const end = this.now + ms;
        for (let n = 0; n < 1000; n++) {
            const due = [...this.tasks].filter(([, value]) => value.at <= end)
                .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
            if (!due) { this.now = end; return; }
            this.tasks.delete(due[0]); this.now = due[1].at; due[1].fn();
        }
        throw new Error('Finite fake-clock step bound exceeded');
    }
}
class Signal {
    constructor() { this.aborted = false; this.listeners = new Set(); }
    addEventListener(name, fn) { assert.equal(name, 'abort'); this.listeners.add(fn); }
    removeEventListener(name, fn) { assert.equal(name, 'abort'); this.listeners.delete(fn); }
    abort() { this.aborted = true; for (const fn of [...this.listeners]) fn(); }
}

function fixture(t, initial = {}) {
    const clock = new Clock(), calls = [], modules = new Map();
    const state = { python: true, helper: '/fixture/probe_vs_plugins.py', throwNext: false, ...initial };
    const process = { env: { VSRES_SAMPLE_PYTHON: '/fixture/python3', ...(initial.env || {}) },
        resourcesPath: '/fixture/Resources' };
    let attempts = 0;
    const spawn = (bin, args, options) => {
        attempts++;
        assert.equal(bin, '/fixture/python3'); assert.equal(args.length, 1);
        assert.equal(typeof args[0], 'string'); assert.equal(args[0], state.helper);
        assert.deepEqual(Array.from(options.stdio), ['ignore', 'pipe', 'pipe']);
        if (state.throwNext) { state.throwNext = false; throw new Error('synthetic spawn constructor failure'); }
        const child = new EventEmitter();
        child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
        Object.assign(child, { pid: 100 + calls.length, exitCode: null, signalCode: null,
            closed: false, closeOnKill: true, kills: [] });
        child.close = (code = 0, signal = null) => {
            if (child.closed) return;
            child.closed = true; child.exitCode = code; child.signalCode = signal;
            child.emit('exit', code, signal); child.emit('close', code, signal);
        };
        child.kill = signal => {
            child.kills.push(signal);
            if (child.closeOnKill) clock.set(() => child.close(null, signal), 0);
            return true;
        };
        calls.push({ bin, args: Array.from(args), options, child });
        return child;
    };
    function load(name) {
        if (modules.has(name)) return modules.get(name);
        const module = { exports: {} };
        vm.runInNewContext(fs.readFileSync(path.join(__dirname, name), 'utf8'), {
            module, exports: module.exports, process, Buffer,
            Date: { now: () => clock.now },
            setTimeout: (fn, ms) => clock.set(fn, ms), clearTimeout: id => clock.clear(id),
            require(dependency) {
                if (dependency === 'child_process') return { spawn };
                if (dependency === 'path') return path;
                if (dependency === 'fs') return { existsSync: file => file === '/fixture/python3' && state.python };
                if (dependency === 'buffer') return require('node:buffer');
                if (dependency === './prod-paths') return { helperScript(name) {
                    assert.equal(name, 'probe_vs_plugins.py'); return state.helper;
                } };
                if (dependency === './probe-process') return load('probe-process.js');
                throw new Error('Unadmitted namespace-probe dependency: ' + dependency);
            },
        }, { filename: name, timeout: 1000 });
        modules.set(name, module.exports);
        return module.exports;
    }
    const api = load('vs-plugin-probe.js');
    t.after(() => { for (const call of calls) call.child.close(1); clock.tasks.clear(); });
    return { api, state, process, calls, clock, get attempts() { return attempts; } };
}
function observe(fn) {
    const state = { settled: false, value: null, error: null };
    try { Promise.resolve(fn()).then(value => { state.settled = true; state.value = value; },
        error => { state.settled = true; state.error = error; }); }
    catch (error) { state.settled = true; state.error = error; }
    return state;
}
async function flush() { for (let n = 0; n < 8; n++) await Promise.resolve(); }
async function tick(h, ms) { h.clock.advance(ms); await flush(); }
const query = (h, options) => observe(() => h.api.probeNamespaces(options));
function complete(h, namespaces, child = h.calls.at(-1).child, code = 0, signal = null) {
    child.stdout.emit('data', JSON.stringify({ ok: true, namespaces })); child.close(code, signal);
}
function unknown(result, reason) {
    assert.equal(result.settled, true, 'unknown result must settle under the selected policy');
    assert.equal(result.error, null); assert.equal(result.value.namespaces, null);
    assert.equal(typeof result.value.error, 'string');
    if (reason) assert.equal(result.value.reason, reason);
    return result.value;
}
function names(result, expected) {
    assert.equal(result.settled, true); assert.equal(result.error, null);
    assert.equal(result.value.error, null); assert.deepEqual(Array.from(result.value.namespaces), expected);
}

test('namespace probe remains lazy on import', t => { const h = fixture(t); assert.equal(h.calls.length, 0); });

test('namespace healthy cache and force preserve established concurrent behavior', async t => {
    const h = fixture(t); const first = query(h); complete(h, ['std', 'resize']); await flush(); names(first, ['std', 'resize']);
    const cached = query(h); await flush(); names(cached, ['std', 'resize']); assert.equal(h.calls.length, 1);
    const refreshed = query(h, { force: true }); assert.equal(h.calls.length, 2);
    const during = query(h); await flush(); names(during, ['std', 'resize']); assert.equal(h.calls.length, 2);
    complete(h, ['std', 'fmtc']); await flush(); names(refreshed, ['std', 'fmtc']);
    const after = query(h); await flush(); names(after, ['std', 'fmtc']); assert.equal(h.calls.length, 2);
});

test('namespace normal zero-exit explicit empty list is distinct from unknown', async t => {
    const h = fixture(t); const result = query(h); complete(h, []); await flush(); names(result, []);
});

test('namespace positive JSON cannot verify namespaces after nonzero exit or signal', async t => {
    for (const [code, signal] of [[7, null], [null, 'SIGTERM']]) {
        const h = fixture(t); const result = query(h); complete(h, ['unverified'], undefined, code, signal); await flush();
        unknown(result, 'namespace-probe-exit');
    }
});

test('namespace known closed component failure is cached until force', async t => {
    const h = fixture(t); const first = query(h);
    h.calls[0].child.stdout.emit('data', '{"ok":false,"error":"fixture import failure"}'); h.calls[0].child.close(1); await flush();
    assert.equal(unknown(first).namespaces, null);
    const cached = query(h); await flush(); unknown(cached); assert.equal(h.calls.length, 1);
    const forced = query(h, { force: true }); complete(h, ['std']); await flush(); names(forced, ['std']);
});

test('namespace missing Python keeps stable absence cache until force', async t => {
    const h = fixture(t, { python: false }); const missing = query(h); await flush(); unknown(missing);
    h.state.python = true; const cached = query(h); await flush(); unknown(cached); assert.equal(h.calls.length, 0);
    const forced = query(h, { force: true }); complete(h, ['std']); await flush(); names(forced, ['std']);
});

test('namespace missing helper keeps stable absence cache until force', async t => {
    const h = fixture(t, { helper: null }); const missing = query(h); await flush(); unknown(missing);
    h.state.helper = '/fixture/probe_vs_plugins.py'; const cached = query(h); await flush(); unknown(cached); assert.equal(h.calls.length, 0);
    const forced = query(h, { force: true }); complete(h, ['std']); await flush(); names(forced, ['std']);
});

test('namespace malformed or non-string verdict is unknown and not negatively cached', async t => {
    for (const raw of ['not-json', '{"ok":true,"namespaces":[7]}', '{"ok":true}', 'null']) {
        const h = fixture(t); const first = query(h); h.calls[0].child.stdout.emit('data', raw); h.calls[0].child.close(0); await flush();
        unknown(first, 'namespace-output-invalid');
        const retry = query(h); assert.equal(h.calls.length, 2); complete(h, ['std']); await flush(); names(retry, ['std']);
    }
});

test('namespace stdout alone supplies verdict while stderr remains diagnostic', async t => {
    const h = fixture(t); const result = query(h);
    h.calls[0].child.stderr.emit('data', '{"ok":false,"error":"stderr is not a verdict"}');
    complete(h, ['std']); await flush(); names(result, ['std']);
});

test('namespace timeout settles unknown once and does not cache transient failure', async t => {
    const h = fixture(t); const result = query(h, { timeoutMs: 10, closeTimeoutMs: 5 });
    await tick(h, 10); const value = unknown(result, 'probe-timeout'); assert.equal(value.closed, true);
    assert.deepEqual(h.calls[0].child.kills, ['SIGKILL']);
    const retry = query(h); assert.equal(h.calls.length, 2); complete(h, ['std']); await flush(); names(retry, ['std']);
});

test('namespace combined capture bound rejects even otherwise valid stdout JSON', async t => {
    const h = fixture(t); const result = query(h, { maxOutputBytes: 64, closeTimeoutMs: 5 });
    const child = h.calls[0].child; child.stdout.emit('data', '{"ok":true,"namespaces":["std"]}');
    child.stderr.emit('data', Buffer.alloc(64)); child.close(0); await flush(); unknown(result, 'probe-output-limit');
});

test('namespace already-aborted caller never starts a child', async t => {
    const h = fixture(t); const signal = new Signal(); signal.abort(); const result = query(h, { signal });
    await flush(); unknown(result, 'probe-cancelled'); assert.equal(h.calls.length, 0);
});

test('namespace cancellation after JSON never publishes a verified list', async t => {
    const h = fixture(t); const signal = new Signal(); const result = query(h, { signal });
    h.calls[0].child.stdout.emit('data', '{"ok":true,"namespaces":["std"]}'); signal.abort(); await tick(h, 0);
    unknown(result, 'probe-cancelled'); assert.equal(signal.listeners.size, 0);
});

test('namespace forced operational failure invalidates older cache and late close cannot restore it', async t => {
    const h = fixture(t); const first = query(h); complete(h, ['old']); await flush(); names(first, ['old']);
    const refresh = query(h, { force: true, timeoutMs: 10, closeTimeoutMs: 5 }); const pending = h.calls[1].child;
    pending.closeOnKill = false; await tick(h, 15); unknown(refresh, 'probe-timeout');
    const held = query(h); await flush(); unknown(held, 'probe-stop-pending'); assert.equal(h.calls.length, 2);
    pending.stdout.emit('data', '{"ok":true,"namespaces":["late"]}'); pending.close(0); await flush();
    const retry = query(h); assert.equal(h.calls.length, 3); complete(h, ['new']); await flush(); names(retry, ['new']);
});

test('namespace pending-kind query blocks even a newer valid cache until the old stopped child closes', async t => {
    const h = fixture(t); const initial = query(h); complete(h, ['initial']); await flush(); names(initial, ['initial']);
    const older = query(h, { force: true, timeoutMs: 10, closeTimeoutMs: 5 }); const pending = h.calls[1].child; pending.closeOnKill = false;
    const newer = query(h, { force: true, timeoutMs: 100 }); complete(h, ['newer']); await flush(); names(newer, ['newer']);
    await tick(h, 15); unknown(older, 'probe-timeout');
    const held = query(h); await flush(); unknown(held, 'probe-stop-pending'); assert.equal(h.calls.length, 3);
    pending.close(1); await flush(); const cached = query(h); await flush(); names(cached, ['newer']); assert.equal(h.calls.length, 3);
});

test('namespace latest-started successful generation owns cache without coalescing', async t => {
    const h = fixture(t); const older = query(h); const newer = query(h); assert.equal(h.calls.length, 2);
    complete(h, ['newer'], h.calls[1].child); await flush(); names(newer, ['newer']);
    complete(h, ['older'], h.calls[0].child); await flush(); names(older, ['older']);
    const cached = query(h); await flush(); names(cached, ['newer']); assert.equal(h.calls.length, 2);
});

test('namespace old failed generation cannot clear a newer verified cache', async t => {
    const h = fixture(t); const older = query(h); const newer = query(h, { force: true });
    complete(h, ['newer'], h.calls[1].child); await flush(); names(newer, ['newer']);
    h.calls[0].child.pid = undefined; h.calls[0].child.emit('error', new Error('old spawn failure')); await flush(); unknown(older);
    const cached = query(h); await flush(); names(cached, ['newer']); assert.equal(h.calls.length, 2);
});

test('namespace known-closed operational forced failure clears older positive without caching invalid output', async t => {
    const h = fixture(t); const first = query(h); complete(h, ['old']); await flush(); names(first, ['old']);
    const refresh = query(h, { force: true }); h.calls[1].child.stdout.emit('data', 'bad-json'); h.calls[1].child.close(0); await flush();
    unknown(refresh, 'namespace-output-invalid');
    const retry = query(h); assert.equal(h.calls.length, 3); complete(h, ['new']); await flush(); names(retry, ['new']);
});

test('namespace late close after spawn failure cannot rewrite a newer snapshot', async t => {
    const h = fixture(t); const failed = query(h); const old = h.calls[0].child;
    old.pid = undefined; old.emit('error', new Error('fixture spawn error')); await flush(); unknown(failed);
    const fresh = query(h, { force: true }); complete(h, ['fresh']); await flush(); names(fresh, ['fresh']);
    assert.doesNotThrow(() => { old.stdout.emit('data', '{"ok":true,"namespaces":["late"]}'); old.close(0); }); await flush();
    const cached = query(h); await flush(); names(cached, ['fresh']);
});

test('namespace invalid option and budget inputs are visible and never dispatch', async t => {
    for (const options of [null, [], false, { timeoutMs: 0 }, { maxOutputBytes: 0 }, { signal: false }]) {
        const h = fixture(t); const result = query(h, options); await flush(); unknown(result, 'probe-invalid-budget'); assert.equal(h.calls.length, 0);
    }
});

test('namespace invalid operator budget is visible and not cached after correction', async t => {
    const h = fixture(t, { env: { VSRES_NAMESPACES_TIMEOUT_MS: 'invalid' } }); const failed = query(h); await flush();
    unknown(failed, 'probe-invalid-budget'); assert.equal(h.calls.length, 0);
    delete h.process.env.VSRES_NAMESPACES_TIMEOUT_MS; const retry = query(h); complete(h, ['std']); await flush(); names(retry, ['std']);
});

test('namespace explicit caller budget overrides the named operator deadline', async t => {
    const h = fixture(t, { env: { VSRES_NAMESPACES_TIMEOUT_MS: '10' } });
    const result = query(h, { timeoutMs: 100 }); await tick(h, 11); assert.equal(result.settled, false); assert.equal(h.calls[0].child.kills.length, 0);
    complete(h, ['std']); await flush(); names(result, ['std']);
});

test('namespace default sixty-second policy is visible as an operational failure', async t => {
    const h = fixture(t); const result = query(h); await tick(h, 59_999); assert.equal(result.settled, false);
    await tick(h, 1); assert.match(unknown(result, 'probe-timeout').error, /60000/);
});

test('namespace explicitly larger legitimate budget survives the provisional default', async t => {
    const h = fixture(t); const result = query(h, { timeoutMs: 120_000, maxOutputBytes: 8 * 1024 * 1024 });
    await tick(h, 60_001); assert.equal(h.calls[0].child.kills.length, 0);
    complete(h, ['std']); await flush(); names(result, ['std']);
});

test('namespace synchronous or asynchronous spawn failure stays unknown and does not poison a later call', async t => {
    for (const asynchronous of [false, true]) {
        const h = fixture(t, { throwNext: !asynchronous }); const result = query(h);
        if (asynchronous) { h.calls[0].child.pid = undefined; h.calls[0].child.emit('error', new Error('fixture spawn failure')); }
        await flush(); unknown(result, 'probe-spawn-failed');
        const retry = query(h); assert.equal(h.attempts, 2); complete(h, ['std']); await flush(); names(retry, ['std']);
    }
});
