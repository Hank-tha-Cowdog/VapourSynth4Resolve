// Owned inert fixtures and strict VM HTTP/child/clock ports only. No actual
// 7z/model/helper/product, network, UI, credential or owner path is dispatched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { stagePort } = require('./test-fixtures/__test_model_stage_port');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const MODEL_SOURCE = fs.readFileSync(path.join(__dirname, 'model-manager.js'), 'utf8');
const PROBE_SOURCE = fs.readFileSync(path.join(__dirname, 'probe-process.js'), 'utf8');
const FLAG = '.extraction-unverified.json';
const DEFAULT_TIMEOUT = 30 * 60 * 1000;
const DEFAULT_OUTPUT = 4 * 1024 * 1024;

function harness(t, options = {}) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vsres-extract-life-')));
    const models = path.join(root, 'models'), id = 'fixture-model', dir = path.join(models, id);
    const marker = path.join(dir, 'extracted.json'), flag = path.join(dir, FLAG);
    fs.mkdirSync(dir, { recursive: true });
    const payload = Buffer.from('inert extractor lifecycle archive\n');
    const entry = { id, version: 'fixture', asset: 'https://fixture.invalid/archive.7z',
        sha256: crypto.createHash('sha256').update(payload).digest('hex'), downloadBytes: payload.length, diskBytesNeeded: 1024 * 1024 };
    const metadata = { id, version: entry.version, sha256: entry.sha256, extractedAt: 1000 };
    fs.writeFileSync(path.join(dir, 'download.7z'), payload);
    const env = { VSRES_MODELS_ROOT: models, ...(options.env || {}) };
    let now = 1000;
    const timers = new Map(), readers = [], children = [], requests = [], childCalls = [];
    const readWaiters = [], spawnWaiters = [];
    const clock = {
        setTimeout(fn, ms) { const token = { fn, at: now + ms }; timers.set(token, token); return token; },
        clearTimeout(token) { timers.delete(token); },
        advance(ms) { now += ms; for (const token of [...timers.values()].sort((a, b) => a.at - b.at)) {
            if (token.at <= now && timers.delete(token)) token.fn();
        } },
    };
    const capture = promise => { const state = { done: false, value: null, error: null };
        promise.then(value => { state.done = true; state.value = value; }, error => { state.done = true; state.error = error; }); return state; };
    const flush = async () => { for (let i = 0; i < 1800; i++) await Promise.resolve(); };
    const anchor = path.join(models, `.vsres-${id}.transaction.json`), custody = path.join(models, `.vsres-custody-${id}`);
    const h = { root, models, id, dir, marker, flag, anchor, custody, payload, entry, metadata, env, readers, children, requests, childCalls,
        clock, timers, capture, flush, nextReader: () => new Promise(resolve => readWaiters.push(resolve)),
        nextSpawn: () => new Promise(resolve => spawnWaiters.push(resolve)) };
    const filePorts = { ...fs,
        existsSync(file) { if (['/opt/homebrew/bin/7z', '/opt/homebrew/bin/7za', '/usr/local/bin/7z', '/usr/bin/7z'].includes(file)) return true; return fs.existsSync(file); },
        createReadStream(file, config) {
            const reader = new EventEmitter(); reader.fd = config.fd; reader.closed = false; reader.ended = false;
            reader.endData = () => { if (reader.closed || reader.ended) return; reader.ended = true;
                reader.emit('data', fs.readFileSync(reader.fd)); reader.emit('end'); };
            reader.close = () => { if (!reader.closed) { fs.closeSync(reader.fd); reader.closed = true; reader.emit('close'); } };
            reader.release = () => { reader.endData(); reader.close(); };
            readers.push(reader); for (const resolve of readWaiters.splice(0)) resolve(reader);
            if (!options.holdHash) queueMicrotask(reader.release);
            return reader;
        },
        ...(options.fileOverrides?.(h) || {}),
    };
    function newProbePort() {
        const module = { exports: {} };
        vm.runInNewContext(PROBE_SOURCE, { module, exports: module.exports, Buffer, process: { env },
            setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
            require(name) { if (name === 'buffer') return require('node:buffer'); throw new Error('Unadmitted utility dependency: ' + name); },
        }, { filename: 'fixture-probe-process.js', timeout: 1000 });
        return module.exports;
    }
    let probe = newProbePort();
    const spawn = (bin, args, config) => {
        childCalls.push({ bin, args, config });
        if (options.spawnThrows) throw new Error('synthetic extractor spawn failure');
        const child = new EventEmitter(); child.pid = 20000 + children.length; // inert event metadata
        child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kills = [];
        child.exitCode = null; child.signalCode = null; child.closed = false;
        child.close = (code = 0, signal = null) => { if (child.closed) return; child.closed = true;
            child.exitCode = code; child.signalCode = signal; child.stdout.end(); child.stderr.end();
            child.emit('exit', code, signal); child.emit('close', code, signal); };
        child.kill = signal => { child.kills.push(signal); if (options.closeOnKill) queueMicrotask(() => child.close(null, signal)); return true; };
        children.push(child); h.stageDir = args.find(value => value.startsWith('-o')).slice(2);
        h.stageMarker = path.join(h.stageDir, 'extracted.json'); options.onSpawn?.(h, child);
        for (const resolve of spawnWaiters.splice(0)) resolve(child);
        return child;
    };
    const get = (_url, _config, callback) => {
        const request = new EventEmitter(); request.closed = false;
        request.close = () => { if (!request.closed) { request.closed = true; request.emit('close'); } };
        request.destroy = request.close; requests.push(request);
        queueMicrotask(() => { const response = new PassThrough(); response.statusCode = 200;
            response.headers = { 'content-length': String(payload.length) }; response.on('close', request.close);
            callback(response); if (!response.destroyed) response.end(payload); });
        return request;
    };
    function load(reuseProbe = false) {
        if (!reuseProbe) probe = newProbePort();
        const module = { exports: {} };
        vm.runInNewContext(MODEL_SOURCE, { module, exports: module.exports, Buffer, URL, AbortController, queueMicrotask,
            Date: { now: () => now }, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
            process: { env, getuid: () => process.getuid(), hrtime: { bigint: () => options.monotonic ? options.monotonic(now) : BigInt(now) * 1000000n } }, require(name) {
                if (name === 'buffer') return require('node:buffer');
                if (name === './model-stage-transaction') return stagePort(filePorts, crypto, env, { Date: { now: () => now } });
                if (name === 'fs') return filePorts;
                if (name === 'path') return path;
                if (name === 'os') return { homedir: () => path.join(root, 'home') };
                if (name === 'crypto') return crypto;
                if (name === 'child_process') return { spawn };
                if (name === './probe-process') return probe;
                if (name === '../shared/model-registry.json') return { models: [entry] };
                if (name === 'https' || name === 'http') return { get };
                throw new Error('Unadmitted model dependency: ' + name);
            },
        }, { filename: 'fixture-model-manager.js', timeout: 1000 });
        const handlers = {}; module.exports.registerModelManager({ handle: (name, fn) => { handlers[name] = fn; } }, () => {});
        h.handlers = handlers;
    }
    Object.assign(h, { restart: load, list: () => h.handlers['models:list']().models[0],
        start: (budgets = {}) => capture(h.handlers['models:extract']({}, { id, ...budgets })),
        download: () => capture(h.handlers['models:download']({}, { id })),
        writeReady: () => fs.writeFileSync(marker, JSON.stringify(metadata)),
        savedRecords: () => fs.readdirSync(dir).filter(n => n.startsWith('.completion-') && n.endsWith('.record')) });
    load(true);
    t.after(() => { for (const child of children) child.close(null, 'SIGKILL');
        for (const reader of readers) reader.close(); timers.clear(); fs.rmSync(root, { recursive: true, force: true }); });
    return h;
}

async function assertBlocked(h) {
    for (const name of ['models:download', 'models:extract', 'models:remove']) {
        assert.equal((await h.handlers[name]({}, { id: h.id })).ok, false, name);
    }
}

function writer(h, index = 0) {
    assert.ok(h.children[index], `expected admitted inert writer ${index}; structured preflight refusal must not become a TypeError`);
    return h.children[index];
}

function completed(result) {
    assert.equal(result.done, true, 'the selected terminal condition must settle this operation');
    assert.equal(result.error, null, 'IPC outcome must be structured, not a rejected handler');
    return result.value;
}

test('extractor lifecycle: quiet fixed argv and staged publication wait for actual child close', async t => {
    const h = harness(t); const result = h.start(); await h.flush();
    assert.equal(h.children.length, 1); assert.equal(result.done, false); assert.equal(h.list().state, 'failed');
    assert.equal(h.list().canDiscard, false); assert.equal(fs.existsSync(h.anchor), true);
    const args = Array.from(h.childCalls[0].args);
    assert.deepEqual(args.slice(0, 5), ['x', '-y', '-bso0', '-bsp0', '-bse2']);
    assert.equal(args[5], `-o${h.stageDir}`); assert.notEqual(h.stageDir, h.dir);
    assert.equal(args[6], path.join(path.dirname(h.stageDir), 'archive.7z'));
    assert.deepEqual(fs.readFileSync(path.join(h.dir, 'download.7z')), h.payload);
    writer(h).close(); await h.flush();
    assert.equal(completed(result).ok, true); assert.equal(completed(result).closureKnown, true);
    assert.equal(h.list().state, 'ready'); assert.equal(fs.existsSync(h.anchor), false);
    assert.deepEqual(fs.readFileSync(path.join(h.dir, 'download.7z')), h.payload);
});

test('extractor lifecycle: active ownership never trusts old or writer-supplied completion metadata', async t => {
    const h = harness(t, { onSpawn: h => fs.writeFileSync(h.stageMarker, JSON.stringify(h.metadata)) }); h.writeReady();
    const old = fs.readFileSync(h.marker); const result = h.start(); assert.equal(h.list().state, 'failed'); await h.flush();
    assert.equal(h.list().state, 'failed'); assert.equal(h.list().canDiscard, false); await assertBlocked(h);
    writer(h).close(); await h.flush(); assert.equal(completed(result).ok, false);
    assert.deepEqual(fs.readFileSync(h.marker), old, 'untrusted candidate metadata never replaces old readiness');
    assert.equal(h.list().state, 'ready', 'unchanged verified old tree becomes available only after known disposition');
});

test('extractor lifecycle: known staged failure preserves oldReady and archive across module reload', async t => {
    const h = harness(t); h.writeReady(); const old = fs.readFileSync(h.marker), archive = fs.lstatSync(path.join(h.dir, 'download.7z'));
    const result = h.start(); await h.flush(); assert.equal(fs.existsSync(h.anchor), true);
    writer(h).stderr.write('bounded stderr failure'); writer(h).close(7); await h.flush();
    assert.equal(completed(result).ok, false); assert.match(completed(result).error, /bounded stderr failure/);
    assert.deepEqual(fs.readFileSync(h.marker), old); assert.equal(fs.lstatSync(path.join(h.dir, 'download.7z')).ino, archive.ino);
    assert.equal(h.list().state, 'ready'); h.restart(); assert.equal(h.list().state, 'ready');
    assert.equal(h.list().retainedStorage.status, 'retained'); assert.equal(h.list().retainedStorage.bytes, null);
});

test('extractor lifecycle: 30minute provisional child deadline requests owned stop then waits for close', async t => {
    const h = harness(t); const result = h.start(); await h.flush(); const child = writer(h);
    h.clock.advance(DEFAULT_TIMEOUT - 1); await h.flush(); assert.equal(child.kills.length, 0);
    h.clock.advance(1); await h.flush(); assert.deepEqual(child.kills, ['SIGKILL']); assert.equal(result.done, false);
    child.close(null, 'SIGKILL'); await h.flush();
    assert.equal(completed(result).reason, 'probe-timeout'); assert.equal(completed(result).closureKnown, true);
    assert.equal(h.list().state, 'downloaded'); assert.equal(fs.existsSync(h.anchor), false);
});

test('extractor lifecycle: stdout and stderr share one explicit byte budget and stopped output cannot publish', async t => {
    const h = harness(t); const result = h.start({ maxOutputBytes: 8 }); await h.flush(); const child = writer(h);
    child.stdout.write('12345'); child.stderr.write('6789'); await h.flush();
    assert.deepEqual(child.kills, ['SIGKILL']); child.close(null, 'SIGKILL'); await h.flush();
    assert.equal(completed(result).reason, 'probe-output-limit'); assert.equal(completed(result).ok, false); assert.equal(h.list().state, 'downloaded');
});

test('extractor lifecycle: default combined capture is4MiB and consumes stdout without unbounded retention', async t => {
    const h = harness(t); const result = h.start(); await h.flush(); const child = writer(h);
    assert.equal(child.stdout.listenerCount('data'), 1); assert.equal(child.stderr.listenerCount('data'), 1);
    child.stdout.write(Buffer.alloc(DEFAULT_OUTPUT, 120)); assert.equal(child.kills.length, 0);
    child.stderr.write('x'); await h.flush(); assert.equal(child.kills.length, 1);
    child.close(null, 'SIGKILL'); await h.flush(); assert.equal(completed(result).reason, 'probe-output-limit');
});

test('extractor lifecycle: unknown stop holds model and shared-kind ownership until exact late close', async t => {
    const h = harness(t); const result = h.start({ timeoutMs: 10 }); await h.flush(); const child = writer(h);
    h.clock.advance(10); h.clock.advance(5000); await h.flush();
    assert.equal(completed(result).closureKnown, false); assert.equal(h.list().canDiscard, false); await assertBlocked(h);
    const reads = h.readers.length; h.restart(true); const refused = h.start(); await h.flush();
    assert.equal(completed(refused).ok, false); assert.equal(h.readers.length, reads); assert.equal(h.children.length, 1);
    child.close(null, 'SIGKILL'); await h.flush(); assert.equal(h.list().state, 'failed');
    assert.equal(completed(result).closureKnown, false, 'returned unknown is immutable');
});

test('extractor lifecycle: PIDerror and pipe error observe close while stale events cannot release a retry', async t => {
    for (const pipe of [false, true]) {
        const h = harness(t); const first = h.start(); await h.flush(); const old = writer(h);
        (pipe ? old.stderr : old).emit('error', new Error('synthetic owned error'));
        h.clock.advance(5000); await h.flush(); assert.equal(completed(first).closureKnown, false); await assertBlocked(h);
        old.close(null, 'SIGKILL'); await h.flush();
        assert.equal((await h.handlers['models:extraction-recovery']({}, { id: h.id, action: 'restore' })).ok, true);
        const second = h.start(); await h.flush(); assert.equal(h.children.length, 2);
        old.emit('close', 0); old.emit('error', new Error('stale error')); await h.flush();
        assert.equal(second.done, false); assert.equal(h.list().canDiscard, false); await assertBlocked(h);
        writer(h, 1).close(); await h.flush(); assert.equal(completed(second).ok, true);
    }
});

test('extractor lifecycle: explicit budgets override invalid environment and invalid budgets do not mutate old marker', async t => {
    const configured = harness(t, { env: { VSRES_MODEL_EXTRACT_TIMEOUT_MS: 'bad', VSRES_MODEL_EXTRACT_MAX_OUTPUT_BYTES: 'bad' } });
    configured.writeReady(); const good = configured.start({ timeoutMs: 200, maxOutputBytes: 128 }); await configured.flush();
    assert.equal(configured.children.length, 1); writer(configured).close(); await configured.flush(); assert.equal(completed(good).ok, true);
    for (const value of [0, -1, 'bad']) {
        const h = harness(t); h.writeReady(); const before = fs.readFileSync(h.marker); const result = h.start({ timeoutMs: value }); await h.flush();
        assert.equal(completed(result).reason, 'probe-invalid-budget'); assert.equal(h.children.length, 0);
        assert.deepEqual(fs.readFileSync(h.marker), before); assert.equal(fs.existsSync(h.flag), false); assert.equal(h.list().state, 'ready');
    }
});

test('extractor lifecycle: environment budgets remain visible and child exit signal never becomes ready', async t => {
    const h = harness(t, { env: { VSRES_MODEL_EXTRACT_TIMEOUT_MS: '20', VSRES_MODEL_EXTRACT_MAX_OUTPUT_BYTES: '12' } });
    const result = h.start(); await h.flush(); h.clock.advance(19); assert.equal(writer(h).kills.length, 0);
    h.clock.advance(1); assert.equal(writer(h).kills.length, 1); writer(h).close(null, 'SIGKILL'); await h.flush();
    assert.equal(completed(result).reason, 'probe-timeout');
    const signalled = harness(t); const reply = signalled.start(); await signalled.flush(); writer(signalled).close(null, 'SIGTERM'); await signalled.flush();
    assert.equal(completed(reply).ok, false); assert.equal(signalled.list().state, 'downloaded');
});

test('extractor lifecycle: valid hashing has no deadline and error without close gets only postfailure5s observation', async t => {
    const h = harness(t, { holdHash: true }); const result = h.start(); await h.flush();
    h.clock.advance(DEFAULT_TIMEOUT * 4); await h.flush(); assert.equal(result.done, false); assert.equal(h.timers.size, 0); assert.equal(h.children.length, 0);
    h.readers[0].emit('error', new Error('held hash failure')); await h.flush(); h.clock.advance(5000); await h.flush();
    assert.equal(completed(result).closureKnown, false); assert.equal(h.list().canDiscard, false); await assertBlocked(h);
    h.readers[0].close(); await h.flush(); assert.equal(h.children.length, 0); assert.equal(completed(result).closureKnown, false);
});

test('extractor hash: end then first error rejects only after actual close and never dispatches writer', async t => {
    for (const delayed of [false, true]) {
        const h = harness(t, { holdHash: true }); const result = h.start(); await h.flush(); const reader = h.readers[0];
        reader.endData(); reader.emit('error', new Error('first close failure')); reader.emit('error', new Error('later failure')); await h.flush();
        assert.equal(result.done, false); assert.equal(h.children.length, 0); assert.equal(fs.existsSync(h.flag), false);
        if (delayed) { h.clock.advance(5000); await h.flush(); assert.equal(completed(result).closureKnown, false); await assertBlocked(h); }
        reader.close(); await h.flush(); assert.equal(h.children.length, 0);
        assert.equal(completed(result).ok, false); assert.match(completed(result).error, /first close failure/);
        if (!delayed) assert.equal(completed(result).closureKnown, true);
    }
});

test('download hash: valid end followed by error cannot publish and retains guard until reader close', async t => {
    for (const delayed of [false, true]) {
        const h = harness(t, { holdHash: true }); const ready = h.nextReader(); const result = h.download(); const reader = await ready;
        reader.endData(); reader.emit('error', new Error('download close failure')); await h.flush();
        assert.equal(result.done, false); assert.equal(fs.existsSync(path.join(h.dir, 'download.partial')), true);
        assert.deepEqual(fs.readFileSync(path.join(h.dir, 'download.7z')), h.payload, 'existing archive untouched before close');
        if (delayed) { h.clock.advance(5000); await h.flush(); assert.equal(completed(result).closureKnown, false); }
        reader.close(); await h.flush(); assert.equal(completed(result).ok, false);
        assert.match(completed(result).error + (completed(result).primaryError || ''), /download close failure|stop could not be confirmed/);
        assert.equal(fs.existsSync(path.join(h.dir, 'download.partial')), false);
    }
});

test('extractor lifecycle: prestart failure preserves oldReady and no in-place unverified flag is needed', async t => {
    const h = harness(t, { spawnThrows: true }); h.writeReady(); const old = fs.readFileSync(h.marker);
    const result = h.start(); await h.flush();
    assert.equal(completed(result).notStarted, true); assert.equal(completed(result).closureKnown, true);
    assert.equal(h.children.length, 0); assert.deepEqual(fs.readFileSync(h.marker), old); assert.equal(fs.existsSync(h.anchor), false);
    h.restart(); assert.equal(h.list().state, 'ready'); assert.equal(h.list().retainedStorage.status, 'retained');
});

test('extractor lifecycle: invalid or linked unverified record blocks dispatch and preserves stand-in', async t => {
    for (const kind of ['invalid', 'symlink', 'hardlink']) {
        const h = harness(t); const target = path.join(h.root, 'outside-status'); fs.writeFileSync(target, 'preserve status stand-in');
        if (kind === 'invalid') fs.writeFileSync(h.flag, 'unknown old record');
        else if (kind === 'symlink') fs.symlinkSync(target, h.flag); else fs.linkSync(target, h.flag);
        const result = h.start(); await h.flush(); assert.equal(completed(result).ok, false); assert.equal(h.children.length, 0);
        assert.equal(fs.readFileSync(target, 'utf8'), 'preserve status stand-in'); assert.equal(fs.existsSync(h.flag), true);
    }
});

test('extractor lifecycle: replaced root transaction journal is retained and cannot publish or release', async t => {
    const h = harness(t); const result = h.start(); await h.flush(); const target = path.join(h.root, 'outside-replacement');
    fs.writeFileSync(target, 'preserve replaced journal'); assert.equal(fs.existsSync(h.anchor), true);
    fs.unlinkSync(h.anchor); fs.linkSync(target, h.anchor);
    writer(h).close(); await h.flush(); assert.equal(completed(result).ok, false);
    assert.match(completed(result).error, /journal.*replaced|journal.*changed/); assert.equal(fs.readFileSync(target, 'utf8'), 'preserve replaced journal');
    assert.equal(fs.lstatSync(h.anchor).nlink, 2); assert.equal(h.list().state, 'failed'); assert.equal(h.list().canDiscard, false);
});

test('extractor lifecycle: completion metadata replaced during seed preflight is retained and no writer dispatches', async t => {
    let replaced = false;
    const h = harness(t, { fileOverrides: h => ({ opendirSync(file, ...args) {
        const opened = fs.opendirSync(file, ...args);
        if (!replaced && file === h.dir) { replaced = true; fs.renameSync(h.marker, path.join(h.root, 'original-record'));
            fs.writeFileSync(h.marker, 'foreign replacement must remain', { flag: 'wx' }); }
        return opened;
    } }) });
    h.writeReady(); const result = h.start(); await h.flush(); assert.equal(completed(result).ok, false); assert.equal(h.children.length, 0);
    assert.equal(fs.readFileSync(h.marker, 'utf8'), 'foreign replacement must remain');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h.root, 'original-record'), 'utf8')), h.metadata);
});

test('extractor lifecycle: relative marker link and its old target remain together in previous custody', async t => {
    const h = harness(t); fs.writeFileSync(path.join(h.dir, 'weight'), 'keep relative target'); fs.symlinkSync('weight', h.marker);
    const result = h.start(); await h.flush(); writer(h).close(); await h.flush();
    assert.equal(completed(result).ok, true); assert.equal(fs.readFileSync(path.join(h.dir, 'weight'), 'utf8'), 'keep relative target');
    const transactions = fs.readdirSync(h.custody).filter(n => /^[a-f0-9]{32}$/.test(n)); assert.equal(transactions.length, 1);
    const previous = path.join(h.custody, transactions[0], 'previous');
    assert.equal(fs.readlinkSync(path.join(previous, 'extracted.json')), 'weight');
    assert.equal(fs.realpathSync(path.join(previous, 'extracted.json')), path.join(previous, 'weight'));
});

test('extractor lifecycle: known failure admits fresh-token retry without modifying the original archive', async t => {
    const h = harness(t); const identity = fs.lstatSync(path.join(h.dir, 'download.7z'));
    const first = h.start(); await h.flush(); writer(h).close(2); await h.flush(); assert.equal(completed(first).ok, false);
    assert.equal(fs.lstatSync(path.join(h.dir, 'download.7z')).ino, identity.ino); assert.equal(fs.existsSync(h.anchor), false);
    h.restart(); const second = h.start(); await h.flush(); writer(h, 1).close(); await h.flush();
    assert.equal(completed(second).ok, true); assert.equal(h.list().state, 'ready');
    assert.equal(fs.readdirSync(h.custody).filter(n => /^[a-f0-9]{32}$/.test(n)).length, 2);
});

test('extractor lifecycle: nonzero stderr remains distinct from unrelated stdout diagnostic text', async t => {
    const h = harness(t); const result = h.start(); await h.flush();
    writer(h).stdout.write('not the failure explanation'); writer(h).stderr.write('actual bounded extraction failure'); writer(h).close(2); await h.flush();
    assert.match(completed(result).error, /actual bounded extraction failure/); assert(!completed(result).error.includes('not the failure explanation'));
    assert.equal(h.list().state, 'downloaded');
});
