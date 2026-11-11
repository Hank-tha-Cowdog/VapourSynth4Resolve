// VM caller + actual lifecycle module, with only in-memory fs/children/clocks.
// No Python, helper, native code, media, UI, network or owner store executes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const callerPath = process.env.VSRES_SELFCHECK_TEST_SCRIPT || path.join(__dirname, 'preview-companion.js');
const helperPath = process.env.VSRES_SELFCHECK_HELPER_SCRIPT || path.join(__dirname, 'probe-process.js');
const callerSource = fs.readFileSync(callerPath, 'utf8');
const helperSource = fs.readFileSync(helperPath, 'utf8');
const baselineOnly = process.env.VSRES_SELFCHECK_BASELINE === '1';
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const PY1 = '/fixture/resources/OFX/VapourSynth.ofx.bundle/Contents/Frameworks/Python.framework/Versions/Current/bin/python3';
const PY2 = '/fixture/build-portable/portable/VapourSynth.ofx.bundle/Contents/Frameworks/Python.framework/Versions/Current/bin/python3';
const SCRIPT = '/fixture/render.py';
const NODE = '/fixture/home/Library/Application Support/VapourSynth-OFX/nodes/fixture.vpy';
const CACHE1 = PY1 + '\x00' + SCRIPT;
const GOOD = { ok: true, version: 'R75', bits: 64, platform: 'fixture-arm64', from: '/fixture/vapoursynth/__init__.py' };

function observe(promise) {
    const state = { settled: false, values: [] };
    Promise.resolve(promise).then(value => { state.settled = true; state.value = value; state.values.push(value); },
        error => { state.settled = true; state.error = error; });
    return state;
}

function fixture(options = {}) {
    let now = 0, timerId = 0, inode = 10, fd = 10, uuid = 0;
    const timers = new Map(), calls = [], requests = [], effects = [], modules = new Map();
    const files = new Map([[NODE, { body: 'clip = "SYNTHETIC"\n', dev: 1, ino: ++inode }]]), fds = new Map();
    const env = { HOME: '/fixture/home', VSRES_ALLOWED_SOURCE_ROOTS: '/fixture', ...(options.env || {}) };
    const settings = { helperMissing: false, runtimeMissing: false, deferWorker: false,
        spawnThrows: new Map(), ...options };
    const clock = {
        set(fn, ms) { const id = ++timerId; timers.set(id, { at: now + ms, fn }); return id; },
        clear(id) { timers.delete(id); },
        advance(ms) {
            const end = now + ms; let rounds = 0;
            while (true) {
                const due = [...timers.entries()].filter(([, t]) => t.at <= end)
                    .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
                if (!due) break;
                assert.ok(++rounds < 1000); now = due[1].at; timers.delete(due[0]); due[1].fn();
            }
            now = end;
        },
    };
    const fakeFs = {
        constants: require('node:fs').constants,
        mkdtempSync(prefix) {
            const dir = prefix + ++uuid;
            files.set(dir, { body: '', dev: 1, ino: ++inode, uid: 42, nlink: 1, mode: 0o40700, directory: true });
            effects.push(['mkdir', dir]); return dir;
        },
        rmdirSync(dir) {
            assert.equal([...files.keys()].some(file => file.startsWith(dir + '/')), false);
            assert.ok(files.delete(dir)); effects.push(['rmdir', dir]);
        },
        existsSync(file) {
            effects.push(['exists', file]);
            return files.has(file) || (!settings.runtimeMissing && [PY1, PY2, '/fixture/trusted'].includes(file));
        },
        realpathSync: file => file,
        readFileSync(file, encoding) {
            effects.push(['read', file]); const entry = files.get(file);
            if (!entry) throw Error('Missing fixture file: ' + file);
            return encoding ? entry.body : Buffer.from(entry.body);
        },
        mkdirSync(file) { effects.push(['mkdir', file]); },
        openSync(file, flags, mode) {
            assert.equal(flags, 'wx'); assert.equal(mode, 0o600);
            effects.push(['open', file]); assert.equal(files.has(file), false);
            files.set(file, { body: '', dev: 1, ino: ++inode }); fds.set(++fd, file); return fd;
        },
        fstatSync(handle) { const entry = files.get(fds.get(handle)); return { ...entry, isFile: () => true }; },
        lstatSync(file) { const entry = files.get(file); if (!entry) throw Error('ENOENT'); return {
            ...entry, isFile: () => !entry.directory, isDirectory: () => entry.directory === true }; },
        writeFileSync(handle, body) { files.get(fds.get(handle)).body = String(body); },
        closeSync(handle) { assert.ok(fds.delete(handle)); },
        unlinkSync(file) { effects.push(['unlink', file]); files.delete(file); },
    };
    function spawn(bin, args, opts) {
        const index = calls.length;
        const thrown = settings.spawnThrows.get(index);
        if (thrown) { calls.push({ bin, args, opts, child: null }); throw Object.assign(Error('synthetic spawn refusal'), { code: thrown }); }
        const child = new EventEmitter(); child.pid = 1000 + index;
        child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
        child.exitCode = null; child.signalCode = null; child.kills = [];
        child.closeOnKill = false; child.killAccepted = true; child.killThrows = false;
        child.kill = signal => {
            child.kills.push(signal);
            if (child.killThrows) throw Object.assign(Error('synthetic stop refusal'), { code: 'EPERM' });
            if (child.closeOnKill) queueMicrotask(() => child.close(null, 'SIGKILL'));
            return child.killAccepted;
        };
        child.close = (code = 0, signal = null) => {
            child.exitCode = code; child.signalCode = signal;
            child.emit('exit', code, signal); child.emit('close', code, signal);
        };
        calls.push({ bin, args: [...args], opts, child });
        return child;
    }
    const worker = { request(request) {
        const entry = { request }; requests.push(entry);
        if (settings.deferWorker) return new Promise(resolve => { entry.resolve = resolve; });
        return Promise.resolve({ ok: false, error: 'fixture renderer refused', noAutomaticReplay: true });
    } };
    class ClockDate extends Date { static now() { return now; } }
    const processPort = { env, pid: 4242, getuid: () => 42, versions: {}, resourcesPath: '/fixture/resources' };
    function load(name) {
        if (modules.has(name)) return modules.get(name);
        const module = { exports: {} };
        vm.runInNewContext(name === 'caller' ? callerSource : helperSource, {
            module, exports: module.exports, __dirname: '/fixture/app/electron',
            process: processPort, Buffer, Date: ClockDate,
            setTimeout: (fn, ms) => clock.set(fn, ms), clearTimeout: id => clock.clear(id),
            require(name) {
                if (name === 'child_process') return { spawn };
                if (name === './probe-process') return load('helper');
                if (name === 'fs') return fakeFs;
                if (name === 'os') return { homedir: () => env.HOME, tmpdir: () => '/fixture/tmp' };
                if (name === 'path') return path;
                if (name === 'buffer') return require('node:buffer');
                if (name === 'crypto') return { randomUUID: () => 'fixture-' + ++uuid };
                if (name === './prod-paths') return { helperScript: () => settings.helperMissing ? null : SCRIPT };
                if (name === './preview-worker') return { getWorker: () => worker, disposeAllWorkers() {} };
                if (name === '../package.json') return { version: 'inert-test' };
                throw Error('Unadmitted selfcheck dependency: ' + name);
            },
        }, { filename: name === 'caller' ? 'preview-companion.js' : 'probe-process.js', timeout: 1000 });
        modules.set(name, module.exports); return module.exports;
    }
    const api = load('caller'), helper = load('helper');
    return { api, helper, env, settings, calls, requests, effects, files, timers, clock,
        cache: api._forTest.capabilityCache,
        render: options => api.renderPreviewFrame({ nodeGuid: 'fixture', ...options }),
        reply(index, body = GOOD, code = 0, signal = null) {
            const child = calls[index].child;
            child.stdout.emit('data', typeof body === 'string' ? body : JSON.stringify(body) + '\n');
            child.close(code, signal);
        },
        seedPending() {
            const state = observe(helper.runProbeProcess(spawn, '/fixture/seed', [], { stdio: ['ignore', 'pipe', 'pipe'] },
                { kind: 'selfcheck', timeoutMs: 10, maxOutputBytes: 1024 }, { closeTimeoutMs: 5 }));
            return { state, child: calls[calls.length - 1].child };
        },
        closeAll() { for (const call of calls) call.child?.close(1); timers.clear(); },
    };
}

function check(name, body, baseline = false) {
    if (!baselineOnly || baseline) test(name, async t => {
        const h = fixture(); t.after(() => h.closeAll()); await body(h);
    });
}

check('baseline: a silent selfcheck never falls through to a candidate before exact close', async h => {
    const state = observe(h.render()); await flush(); const child = h.calls[0].child;
    h.clock.advance(10_000); await flush();
    assert.equal(h.calls.length, 1, 'no candidate replay during unconfirmed stop');
    assert.equal(state.settled, false, 'accepted termination still observes close');
    child.close(null, 'SIGKILL'); await flush();
    assert.equal(state.value.timeout, true); assert.equal(state.value.closureKnown, true);
    assert.equal(h.requests.length, 0);
}, true);

check('baseline: combined selfcheck capture stops without using retained early success', async h => {
    h.env.VSRES_SELFCHECK_MAX_OUTPUT_BYTES = '512';
    const state = observe(h.render()); await flush(); const child = h.calls[0].child;
    child.stdout.emit('data', JSON.stringify(GOOD) + '\n');
    child.stderr.emit('data', 'x'.repeat(513));
    assert.equal(child.kills.length, 1);
    child.close(null, 'SIGKILL'); await flush();
    assert.equal(state.value.outputLimit, true); assert.equal(h.requests.length, 0);
    assert.equal(h.cache.size, 0);
}, true);

check('baseline: signalled completion stays unknown without cached negative or candidate fallback', async h => {
    const state = observe(h.render()); await flush(); h.reply(0, GOOD, null, 'SIGTERM'); await flush();
    assert.equal(h.requests.length, 0); assert.equal(h.cache.size, 0);
    assert.equal(h.calls.length, 1);
    assert.equal(state.value.capabilityUnknown, true); assert.equal(state.value.reason, 'selfcheck-signalled');
}, true);

check('baseline: timeout is not a cached missing-backend verdict', async h => {
    const state = observe(h.render()); await flush(); h.clock.advance(15_000); await flush();
    assert.equal(h.cache.has(CACHE1), false);
    assert.equal(h.calls.length, 1); assert.equal(state.value.closureUnknown, true);
    assert.equal(state.value.timeout, true); assert.equal(state.value.noAutomaticReplay, true);
}, true);

check('baseline: read-stream failures are handled through owned stop rather than uncaught events', async h => {
    const state = observe(h.render()); await flush();
    assert.doesNotThrow(() => h.calls[0].child.stdout.emit('error', Error('synthetic read pipe failure')));
    h.calls[0].child.close(1); await flush();
    assert.equal(state.value.capabilityUnknown, true); assert.equal(h.requests.length, 0);
}, true);

check('normal complete success is cached and preserves exact selfcheck argv and bundle environment', async h => {
    const first = h.render(); await flush();
    assert.equal(h.calls[0].bin, PY1); assert.deepEqual(h.calls[0].args, [SCRIPT, '--selfcheck']);
    assert.equal(h.calls[0].opts.env.VSRES_VS_PYTHON,
        '/fixture/resources/OFX/VapourSynth.ofx.bundle/Contents/Resources/vs-python');
    h.reply(0); await first; assert.equal(h.requests.length, 1); assert.equal(h.cache.get(CACHE1).ok, true);
    h.clock.advance(1_000_000); await h.render();
    assert.equal(h.calls.length, 1); assert.equal(h.requests.length, 2);
});

check('classified exit-zero negative may continue to the next candidate', async h => {
    const pending = h.render(); await flush(); h.reply(0, { ok: false, reason: 'vapoursynth-module-missing' });
    await flush(); assert.equal(h.calls.length, 2); assert.equal(h.calls[1].bin, PY2);
    h.reply(1); await pending; assert.equal(h.requests.length, 1);
    assert.equal(h.cache.get(CACHE1).reason, 'vapoursynth-module-missing');
});

check('normal negative keeps the existing sixty-second TTL rather than a permanent failure', async h => {
    const first = h.render(); await flush(); h.reply(0, { ok: false, reason: 'native-library-missing' }); await flush();
    h.reply(1, { ok: false, reason: 'native-library-missing' }); const missing = await first;
    assert.match(missing.error, /No VapourSynth-capable python/);
    await h.render(); assert.equal(h.calls.length, 2);
    h.clock.advance(60_001); const corrected = h.render(); await flush(); assert.equal(h.calls.length, 3);
    h.reply(2); await corrected; assert.equal(h.requests.length, 1);
});

check('pidless asynchronous ENOENT and EACCES preserve classified candidate fallthrough', async h => {
    const pending = h.render(); await flush(); const first = h.calls[0].child; first.pid = undefined;
    first.emit('error', Object.assign(Error('synthetic missing executable'), { code: 'ENOENT' })); first.close(-2);
    await flush(); assert.equal(h.cache.get(CACHE1).reason, 'missing-executable');
    const second = h.calls[1].child; second.pid = undefined;
    second.emit('error', Object.assign(Error('synthetic denied executable'), { code: 'EACCES' })); second.close(-2);
    const result = await pending; assert.match(result.error, /not-executable/);
    assert.equal(h.requests.length, 0);
});

check('synchronous spawn errors preserve structured classification without substring guessing', async h => {
    h.settings.spawnThrows.set(0, 'EACCES'); const pending = h.render(); await flush();
    assert.equal(h.cache.get(CACHE1).reason, 'not-executable');
    h.reply(1); await pending; assert.equal(h.requests.length, 1);
});

check('complete malformed or trailing output aborts unknown rather than falling through or caching', async h => {
    const pending = h.render(); await flush();
    h.reply(0, JSON.stringify(GOOD) + '\nTRAILING NOT JSON\n'); const result = await pending;
    assert.equal(result.reason, 'selfcheck-invalid-output'); assert.equal(result.capabilityUnknown, true);
    assert.equal(h.calls.length, 1); assert.equal(h.cache.size, 0); assert.equal(h.requests.length, 0);
});

check('nonzero stdout success remains an operational failure without candidate replay', async h => {
    const pending = h.render(); await flush(); h.reply(0, GOOD, 1); const result = await pending;
    assert.equal(result.reason, 'selfcheck-exited'); assert.equal(h.calls.length, 1);
    assert.equal(h.cache.size, 0); assert.equal(h.requests.length, 0);
});

check('normal completed architecture diagnostics retain their classified negative behavior', async h => {
    const pending = h.render(); await flush(); h.calls[0].child.stderr.emit('data', 'Bad CPU type in executable');
    h.reply(0, 'not JSON', 1); await flush(); assert.equal(h.cache.get(CACHE1).reason, 'incompatible-architecture');
    h.reply(1); await pending; assert.equal(h.requests.length, 1);
});

check('invalid startup budgets refuse before trusted seam, cache, UUID, file effects or dispatch', async h => {
    h.env.VSRES_SAMPLE_PYTHON = '/fixture/trusted'; h.cache.set(CACHE1, { ok: true, at: 0 });
    for (const value of ['0', '-1', '1.5', 'Infinity', 'bad', '2147483648']) {
        h.env.VSRES_SELFCHECK_TIMEOUT_MS = value;
        const result = await h.render({ draftScript: 'clip = "SYNTHETIC"' });
        assert.equal(result.reason, 'probe-invalid-budget'); assert.equal(result.capabilityUnknown, true);
    }
    delete h.env.VSRES_SELFCHECK_TIMEOUT_MS;
    for (const value of ['0', '-1', '1.5', 'bad', String(require('node:buffer').constants.MAX_STRING_LENGTH + 1)]) {
        h.env.VSRES_SELFCHECK_MAX_OUTPUT_BYTES = value;
        assert.equal((await h.render({ draftScript: 'clip = "SYNTHETIC"' })).reason, 'probe-invalid-budget');
    }
    assert.equal(h.effects.length, 0); assert.equal(h.calls.length, 0); assert.equal(h.requests.length, 0);
});

check('larger finite startup budgets permit slow import and large legitimate version metadata', async h => {
    h.env.VSRES_SELFCHECK_TIMEOUT_MS = '20000'; h.env.VSRES_SELFCHECK_MAX_OUTPUT_BYTES = String(2 * 1024 * 1024);
    const pending = h.render(); await flush(); h.clock.advance(10_001);
    assert.equal(h.calls[0].child.kills.length, 0);
    h.reply(0, { ...GOOD, version: 'V'.repeat(1024 * 1024 + 100) }); await pending;
    assert.equal(h.requests.length, 1); assert.equal(h.calls[0].child.kills.length, 0);
});

check('pending shared stop guards trusted seam and cached success before draft allocation', async h => {
    const seeded = h.seedPending(); h.clock.advance(10); await flush();
    assert.equal(h.helper.hasPendingProbeStop('selfcheck'), true);
    h.env.VSRES_SAMPLE_PYTHON = '/fixture/trusted'; h.cache.set(CACHE1, { ok: true, at: 0 });
    const effects = h.effects.length;
    const result = await h.render({ draftScript: 'clip = "NEVER ALLOCATED"' });
    assert.equal(result.reason, 'probe-stop-pending'); assert.equal(result.closureUnknown, true);
    assert.equal(h.effects.length, effects); assert.equal(h.calls.length, 1); assert.equal(h.requests.length, 0);
    seeded.child.close(null, 'SIGKILL'); await flush();
    assert.equal(h.helper.hasPendingProbeStop('selfcheck'), false);
});

check('another pending selfcheck after await prevents positive cache publication or render', async h => {
    const pending = h.render(); await flush(); const seeded = h.seedPending();
    h.clock.advance(10); await flush(); h.reply(0); const result = await pending;
    assert.equal(result.reason, 'probe-stop-pending'); assert.equal(h.requests.length, 0); assert.equal(h.cache.size, 0);
    seeded.child.close(null, 'SIGKILL');
});

check('two stopped selfchecks have independent tokens and one late close never clears the other', async h => {
    const a = h.seedPending(), b = h.seedPending(); h.clock.advance(15); await flush();
    assert.equal(a.state.value.cleanupUnconfirmed, true); assert.equal(b.state.value.cleanupUnconfirmed, true);
    a.child.close(null, 'SIGKILL'); assert.equal(h.helper.hasPendingProbeStop('selfcheck'), true);
    assert.equal((await h.render()).closureUnknown, true); assert.equal(h.calls.length, 2);
    b.child.close(null, 'SIGKILL'); assert.equal(h.helper.hasPendingProbeStop('selfcheck'), false);
    const retry = h.render(); await flush(); assert.equal(h.calls.length, 3); h.reply(2); await retry;
    assert.equal(h.requests.length, 1);
});

check('late close after unknown timeout permits only an explicit fresh request and no negative cache', async h => {
    const first = h.render(); await flush(); const child = h.calls[0].child;
    h.clock.advance(15_000); await flush(); const failed = await first;
    assert.equal(failed.timeout, true); assert.equal(failed.closureUnknown, true); assert.equal(h.cache.size, 0);
    child.close(null, 'SIGKILL'); await flush(); assert.equal(h.calls.length, 1);
    h.env.VSRES_SELFCHECK_TIMEOUT_MS = '20000'; const retry = h.render(); await flush();
    assert.equal(h.calls.length, 2); h.reply(1); await retry; assert.equal(h.requests.length, 1);
});

check('a stop arising during worker await prevents new one-shot fallback dispatch', async h => {
    h.settings.deferWorker = true;
    const pending = h.render(); await flush(); h.reply(0); await flush(); assert.equal(h.requests.length, 1);
    const seeded = h.seedPending(); h.clock.advance(10); await flush();
    h.requests[0].resolve({ ok: false, closureKnown: true, noAutomaticReplay: false, error: 'render worker exited mid-request' });
    const result = await pending; assert.equal(result.reason, 'probe-stop-pending'); assert.equal(h.calls.length, 2);
    seeded.child.close(null, 'SIGKILL');
});

check('older normal negative cannot overwrite newer positive capability or authorize a stale fallback', async h => {
    const older = h.render(), newer = h.render(); await flush(); assert.equal(h.calls.length, 2);
    h.reply(1); await newer; assert.equal(h.cache.get(CACHE1).ok, true);
    h.reply(0, { ok: false, reason: 'vapoursynth-module-missing' }); const stale = await older;
    assert.equal(stale.superseded, true); assert.equal(stale.noAutomaticReplay, true);
    assert.equal(h.cache.get(CACHE1).ok, true); assert.equal(h.calls.length, 2);
    await h.render(); assert.equal(h.calls.length, 2); assert.equal(h.requests.length, 2);
});

check('invalidation while selfcheck is pending fences stale positive cache and render publication', async h => {
    const pending = h.render(); await flush(); h.api._forTest.invalidateCapability(PY1, SCRIPT);
    h.reply(0); const result = await pending;
    assert.equal(result.superseded, true); assert.equal(h.cache.has(CACHE1), false); assert.equal(h.requests.length, 0);
});

check('missing renderer helper and absent executable paths retain clear diagnostics without probes', async h => {
    h.settings.helperMissing = true;
    assert.match((await h.render()).error, /helper script.*missing/); assert.equal(h.calls.length, 0);
    h.settings.helperMissing = false; h.settings.runtimeMissing = true;
    const result = await h.render(); assert.match(result.error, /No VapourSynth-capable python/);
    assert.match(result.error, /missing-executable/); assert.equal(h.calls.length, 0); assert.equal(h.cache.size, 0);
});

check('late old close and pipe errors cannot overwrite a corrected cached verdict or release another token', async h => {
    const first = h.render(); await flush(); const old = h.calls[0].child;
    h.clock.advance(15_000); await first; old.close(null, 'SIGKILL');
    const retry = h.render(); await flush(); h.reply(1); await retry; const corrected = h.cache.get(CACHE1);
    old.stdout.emit('data', '{"ok":false,"reason":"STALE"}\n');
    assert.doesNotThrow(() => old.stderr.emit('error', Error('late read error'))); old.close(1);
    assert.equal(h.cache.get(CACHE1), corrected); assert.equal(corrected.ok, true); assert.equal(h.requests.length, 1);
});
