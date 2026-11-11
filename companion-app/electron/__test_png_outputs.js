// Exact caller + worker in a VM. All child/stream/clock/filesystem ports are
// in memory; source reads below are the only actual application-file reads.
const test = require('node:test');
const assert = require('node:assert/strict');
const realFs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const buffer = require('node:buffer');
const callerSource = realFs.readFileSync(process.env.VSRES_PNG_CALLER || path.join(__dirname, 'preview-companion.js'), 'utf8');
const workerSource = realFs.readFileSync(process.env.VSRES_PNG_WORKER || path.join(__dirname, 'preview-worker.js'), 'utf8');
const baseline = process.env.VSRES_PNG_BASELINE === '1';
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const NODE = '/fixture/home/Library/Application Support/VapourSynth-OFX/nodes/fixture.vpy';
const GOOD = { ok: true, frame: 5, total: 100, fpsNum: 30000, fpsDen: 1001,
    durationS: 100100 / 30000, presentationTimeS: 5005 / 30000,
    width: 8192, height: 4320, scopes: { domain: 'signal-referred', depth: 16 }, displayMatrixAssumed: '709' };

function fixture(options = {}) {
    const files = new Map(), fds = new Map(), children = [], wires = [], effects = [], timers = new Map();
    let inode = 0, fd = 0, unique = 0, now = 0, timer = 0;
    const env = { HOME: '/fixture/home', VSRES_SAMPLE_PYTHON: '/fixture/python',
        VSRES_ALLOWED_SOURCE_ROOTS: '/fixture', ...(options.env || {}) };
    const entry = (body = '', extra = {}) => ({ body: Buffer.from(body), dev: 1, ino: ++inode,
        uid: 42, nlink: 1, mode: 0o100600, mtimeMs: 1, ctimeMs: 1, kind: 'file', ...extra });
    const seed = (file, body = '', extra = {}) => { const value = entry(body, extra); files.set(file, value); return value; };
    seed(NODE, 'clip = "SYNTHETIC"\n');
    function stat(value) {
        if (!value) throw Object.assign(Error('ENOENT'), { code: 'ENOENT' });
        return { ...value, size: value.size ?? value.body.length,
            isFile: () => value.kind === 'file', isDirectory: () => value.kind === 'dir' };
    }
    const fs = {
        constants: realFs.constants,
        existsSync(file) { return files.has(file) || file === '/fixture/python'; },
        realpathSync(file) { return files.get(file)?.target || file; },
        lstatSync(file) { effects.push(['lstat', file]); return stat(files.get(file)); },
        fstatSync(handle) { effects.push(['fstat', handle]); return stat(fds.get(handle)?.value); },
        mkdtempSync(prefix) { const dir = prefix + ++unique; seed(dir, '', { kind: 'dir', mode: options.privateMode ?? 0o40700 }); effects.push(['mkdir', dir]); return dir; },
        mkdirSync(file) { effects.push(['mkdir', file]); },
        rmdirSync(file) { assert.equal([...files.keys()].some(p => p.startsWith(file + '/')), false); files.delete(file); effects.push(['rmdir', file]); },
        openSync(file, flags, mode) {
            effects.push(['open', file, flags]);
            if (flags === 'wx') { assert.equal(mode, 0o600); assert.equal(files.has(file), false); seed(file); }
            let value = files.get(file); if (!value) throw Error('ENOENT');
            if (value.kind === 'link' && typeof flags === 'number' && (flags & realFs.constants.O_NOFOLLOW)) throw Error('ELOOP');
            if (value.kind === 'link') value = files.get(value.target);
            fds.set(++fd, { file, value }); return fd;
        },
        closeSync(handle) { assert.ok(fds.delete(handle)); effects.push(['close', handle]); },
        readSync(handle, target, offset, length, position) {
            const value = fds.get(handle).value;
            const count = value.body.copy(target, offset, position, position + length);
            effects.push(['read-fd', count, length]); options.onRead?.(value, files, fds.get(handle).file);
            return count;
        },
        readFileSync(file, encoding) {
            effects.push(['read-path', file]); let value = files.get(file);
            if (value?.kind === 'link') value = files.get(value.target);
            if (!value) throw Error('ENOENT'); return encoding ? value.body.toString() : Buffer.from(value.body);
        },
        writeFileSync(handle, body) { fds.get(handle).value.body = Buffer.from(body); },
        unlinkSync(file) { effects.push(['unlink', file]); files.delete(file); },
    };
    function spawn(bin, args) {
        const child = new EventEmitter(); child.pid = 100 + children.length;
        for (const stream of ['stdin', 'stdout', 'stderr']) { child[stream] = new EventEmitter(); child[stream].setEncoding = () => {}; }
        child.stdin.write = text => { wires.push({ child, request: JSON.parse(text) }); return true; };
        child.kill = signal => {
            effects.push(['kill', child.pid, signal]);
            if (options.killCloseInline) child.close(null, 'SIGKILL');
            return options.killAccepted !== false;
        };
        child.close = (code = 0, signal = null) => { child.exitCode = code; child.signalCode = signal; child.emit('close', code, signal); };
        const once = child.once.bind(child);
        child.once = (name, listener) => {
            if (options.bindOnceError && name === 'close') throw Error('synthetic output observer bind failure');
            return once(name, listener);
        };
        child.bin = bin; child.args = [...args]; children.push(child); return child;
    }
    const clock = { advance(ms) {
        const end = now + ms; let iterations = 0;
        while (true) {
            const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
            if (!due) break; assert.ok(++iterations < 1000); timers.delete(due[0]); now = due[1].at; due[1].fn();
        }
        now = end;
    } };
    const modules = new Map();
    class ClockDate extends Date { static now() { return now; } }
    function load(name) {
        if (modules.has(name)) return modules.get(name);
        const module = { exports: {} };
        vm.runInNewContext(name === 'caller' ? callerSource : workerSource, {
            module, exports: module.exports, __dirname: '/fixture/app/electron', Buffer, Date: ClockDate,
            process: { env, pid: 42, getuid: () => 42, versions: {}, resourcesPath: '/fixture/resources' },
            setTimeout(fn, ms) { const id = ++timer; timers.set(id, { fn, at: now + ms }); return id; },
            clearTimeout(id) { timers.delete(id); },
            require(name) {
                if (name === 'fs') return fs;
                if (name === 'path') return path;
                if (name === 'os') return { tmpdir: () => '/fixture/tmp', homedir: () => env.HOME };
                if (name === 'buffer') return buffer;
                if (name === 'crypto') return { randomUUID: () => 'fixture-' + ++unique };
                if (name === 'child_process') return { spawn };
                if (name === './preview-worker') return load('worker');
                if (name === './prod-paths') return { helperScript: () => '/fixture/render.py' };
                if (name === './probe-process') return { hasPendingProbeStop: () => false, runProbeProcess() { throw Error('Selfcheck not admitted'); } };
                if (name === '../package.json') return { version: 'fixture' };
                throw Error('Unadmitted PNG dependency: ' + name);
            },
        }, { timeout: 1000, filename: name });
        modules.set(name, module.exports); return module.exports;
    }
    const api = load('caller'), workerModule = load('worker');
    return { files, fds, effects, children, wires, clock, env, workerModule, seed,
        render: extra => api.renderPreviewFrame({ nodeGuid: 'fixture', ...extra }),
        dirs: () => [...files].filter(([, v]) => v.kind === 'dir').map(([name]) => name),
        send(index, response = GOOD, extra = {}) {
            const wire = wires[index]; if (extra.body !== null) seed(wire.request.out, extra.body ?? 'SYNTHETIC PNG', extra.file);
            wire.child.stdout.emit('data', JSON.stringify({ id: wire.request.id, ...response }) + '\n');
        },
        oneShot(response = GOOD, extra = {}) {
            const child = children[children.length - 1]; const out = child.args[child.args.indexOf('--out') + 1];
            if (extra.body !== null) seed(out, extra.body ?? 'SYNTHETIC PNG', extra.file);
            child.stdout.emit('data', typeof response === 'string' ? response : JSON.stringify(response));
            child.close(extra.code ?? 0, extra.signal ?? null);
        },
        cleanup() { for (const child of children) child.close(1); timers.clear(); },
    };
}
function check(name, fn, original = false) {
    if (!baseline || original) test(name, async t => { const h = fixture(); t.after(() => h.cleanup()); await fn(h); });
}

check('PNG baseline: metadata overflow refuses before a path read or allocation', async h => {
    const pending = h.render({ maxPngBytes: 8 }); await flush(); h.send(0, GOOD, { file: { size: 9 } });
    const result = await pending; assert.equal(result.pngOutputLimit, true);
    assert.equal(h.effects.some(e => e[0] === 'read-path' && e[1] === h.wires[0].request.out), false);
}, true);
check('PNG baseline: a final symlink never reads or removes its external target', async h => {
    h.seed('/fixture/KEEP', 'SECRET SENTINEL'); const pending = h.render(); await flush();
    h.send(0, GOOD, { file: { kind: 'link', target: '/fixture/KEEP' } });
    const result = await pending; assert.equal(result.ok, false); assert.equal(h.files.get('/fixture/KEEP').body.toString(), 'SECRET SENTINEL');
    assert.equal(h.effects.some(e => e[0] === 'read-path' && e[1] === h.wires[0].request.out), false);
}, true);
check('PNG baseline: one-shot native scopes and display assumption survive with geometry and time', async h => {
    h.env.VSRES_NO_RENDER_WORKER = '1'; const pending = h.render({ frame: 5, time: .2, sar: '4:3', scopes: true }); await flush();
    h.oneShot(); const result = await pending;
    assert.equal(JSON.stringify(result.scopes), JSON.stringify(GOOD.scopes)); assert.equal(result.displayMatrixAssumed, '709');
    for (const key of ['frame', 'total', 'fpsNum', 'fpsDen', 'durationS', 'presentationTimeS', 'width', 'height']) assert.equal(result[key], GOOD[key]);
}, true);
check('PNG baseline: each output is inside a private owned request directory', async h => {
    const pending = h.render(); await flush(); const out = h.wires[0].request.out;
    assert.equal(path.basename(out), 'frame.png'); assert.equal(h.files.get(path.dirname(out)).mode & 0o777, 0o700);
    h.send(0); await pending; assert.deepEqual(h.dirs(), []);
}, true);
check('PNG normal worker metadata and bounded descriptor EOF read preserve full frame', async h => {
    const pending = h.render({ time: .2, mode: 'source', sar: '4:3', scopes: true }); await flush();
    assert.equal(h.wires[0].request.maxPngBytes, 128 * 1024 * 1024); assert.equal(h.wires[0].request.time, .2);
    h.send(0); const result = await pending; assert.equal(result.ok, true); assert.equal(JSON.stringify(result.scopes), JSON.stringify(GOOD.scopes));
    assert.equal(result.displayMatrixAssumed, '709'); assert.equal(result.width, 8192); assert.equal(result.height, 4320);
    assert.equal(h.fds.size, 0); assert.deepEqual(h.dirs(), []); assert.ok(h.effects.some(e => e[0] === 'read-fd' && e[1] === 0));
    assert.equal(h.children[0].listenerCount('close'), 1, 'completed output leases do not accumulate close listeners');
});
check('PNG regular-file uid and single-link checks refuse unsafe outputs', async h => {
    for (const file of [{ kind: 'fifo' }, { uid: 99 }, { nlink: 2 }, { size: 0 }]) {
        const pending = h.render(); await flush(); h.send(h.wires.length - 1, GOOD, { file });
        assert.equal((await pending).ok, false); assert.equal(h.fds.size, 0);
    }
});
check('PNG invalid explicit policy refuses before file effects or child dispatch', async h => {
    const maximum = Math.min(buffer.constants.MAX_LENGTH, Math.floor((buffer.constants.MAX_STRING_LENGTH - 22) / 4) * 3);
    for (const maxPngBytes of [null, 0, -1, 1.5, Infinity, '12', maximum + 1]) {
        assert.match((await h.render({ maxPngBytes })).error, /Invalid preview maxPngBytes/);
    }
    assert.deepEqual(h.effects, []); assert.equal(h.children.length, 0);
});
check('PNG startup policy strictness and explicit precedence remain visible', async h => {
    h.env.VSRES_PREVIEW_MAX_PNG_BYTES = '16'; let pending = h.render(); await flush(); assert.equal(h.wires[0].request.maxPngBytes, 16); h.send(0); await pending;
    pending = h.render({ maxPngBytes: 32 }); await flush(); assert.equal(h.wires[1].request.maxPngBytes, 32); h.send(1); await pending;
    for (const bad of ['', '0', '-1', '1.5', 'Infinity', ' 12', '１']) { h.env.VSRES_PREVIEW_MAX_PNG_BYTES = bad; assert.match((await h.render()).error, /Invalid preview maxPngBytes/); }
});
check('PNG short reads and initial finite-size anomalies fail without leaking fds', async h => {
    for (const size of [99, -1, Infinity]) {
        const pending = h.render({ maxPngBytes: 128 }); await flush(); h.send(h.wires.length - 1, GOOD, { file: { size } });
        assert.equal((await pending).ok, false); assert.equal(h.fds.size, 0);
    }
});
check('PNG normal backend errors clean both fixed files without one-shot replay', async h => {
    const pending = h.render(); await flush(); const out = h.wires[0].request.out; h.seed(out.replace('.png', '0.png'), 'PARTIAL');
    h.send(0, { ok: false, error: 'script failed' }); assert.equal((await pending).ok, false);
    assert.deepEqual(h.dirs(), []); assert.equal(h.children.length, 1);
});
check('PNG unknown active worker retains output until exact late close', async h => {
    const pending = h.render(); await flush(); h.seed(h.wires[0].request.out, 'PARTIAL'); h.clock.advance(35_000); await flush();
    const result = await pending; assert.equal(result.closureUnknown, true); assert.equal(h.dirs().length, 1);
    h.children[0].close(null, 'SIGKILL'); assert.deepEqual(h.dirs(), []); assert.equal(h.children.length, 1);
});
check('PNG queued supersession cleans only never-dispatched output', async h => {
    const a = h.render(), b = h.render(), c = h.render(); await flush();
    assert.equal((await b).superseded, true); assert.equal(h.wires.length, 1); assert.equal(h.dirs().length, 2);
    h.send(0); await a; await flush(); assert.equal(h.wires.length, 2); h.send(1); await c; assert.deepEqual(h.dirs(), []);
});
check('PNG source switch binds replacement cleanup to its own dispatched generation', async h => {
    const a = h.render({ mode: 'processed' }); await flush(); const old = h.children[0];
    const b = h.render({ mode: 'source' }); await flush(); old.close(null, 'SIGKILL'); await a; await flush();
    assert.equal(h.children.length, 2); assert.equal(h.dirs().length, 1); old.close(1); assert.equal(h.dirs().length, 1);
    h.send(1); assert.equal((await b).ok, true); assert.deepEqual(h.dirs(), []);
});
check('PNG one-shot unknown termination retains private directory until exact close', async h => {
    h.env.VSRES_NO_RENDER_WORKER = '1'; const pending = h.render(); await flush(); h.clock.advance(35_000); await flush();
    assert.equal((await pending).closureUnknown, true); assert.equal(h.dirs().length, 1);
    h.children[0].close(null, 'SIGKILL'); assert.deepEqual(h.dirs(), []);
    for (const style of ['late', 'inline', 'refused']) {
        const f = fixture({ env: { VSRES_NO_RENDER_WORKER: '1' }, bindOnceError: true,
            killCloseInline: style === 'inline', killAccepted: style !== 'refused' });
        try {
            const attempted = f.render(); await flush();
            assert.equal(f.effects.filter(e => e[0] === 'kill').length, 1);
            if (style === 'late') { f.clock.advance(5000); await flush(); }
            const failed = await attempted;
            assert.match(failed.error, /output observer failed/); assert.equal(failed.noAutomaticReplay, true);
            if (style === 'inline') { assert.equal(failed.closureKnown, true); assert.deepEqual(f.dirs(), []); }
            else {
                assert.equal(failed.closureUnknown, true); assert.equal(f.dirs().length, 1);
                assert.equal((await f.render()).closureUnknown, true); assert.equal(f.children.length, 1);
                f.children[0].close(null, 'SIGKILL'); assert.deepEqual(f.dirs(), []);
            }
        } finally { f.cleanup(); }
    }
});
check('PNG normal negative or malformed one-shot cleans selected and numbered files', async h => {
    h.env.VSRES_NO_RENDER_WORKER = '1';
    for (const response of ['NOT JSON', { ok: false, error: 'bad PNG', pngOutputLimit: true }]) {
        const pending = h.render(); await flush(); const child = h.children[h.children.length - 1]; const out = child.args[child.args.indexOf('--out') + 1];
        h.seed(out.replace('.png', '0.png'), 'PARTIAL'); h.oneShot(response); const result = await pending;
        assert.equal(result.ok, false); if (typeof response === 'object') assert.equal(result.pngOutputLimit, true); assert.deepEqual(h.dirs(), []);
    }
});
check('PNG dispatch observer throw refuses stdin without unhandled errors or replay', async h => {
    const worker = new h.workerModule.RenderWorker({ python: '/fixture/python', renderScript: '/fixture/render.py' });
    const result = await worker.request({ id: 1 }, { onDispatch() { throw Error('OBSERVER FIRST'); } });
    assert.equal(result.notDispatched, true); assert.equal(result.noAutomaticReplay, true); assert.match(result.error, /OBSERVER FIRST/);
    assert.equal(h.wires.length, 0); worker.dispose();
});
check('PNG completion observer throw becomes owned stop and preserves first error', async h => {
    const worker = new h.workerModule.RenderWorker({ python: '/fixture/python', renderScript: '/fixture/render.py' });
    const pending = worker.request({ id: 1 }, { onDispatch() { return () => { throw Error('COMPLETION FIRST'); }; } });
    h.send(0); h.children[0].stderr.emit('error', Error('LATE')); h.children[0].close(1);
    const result = await pending; assert.match(result.error, /COMPLETION FIRST/); assert.equal(result.noAutomaticReplay, true); assert.equal(h.children.length, 1);
});
check('PNG observer remains internal and never serialized into the wire request', async h => {
    const worker = new h.workerModule.RenderWorker({ python: '/fixture/python', renderScript: '/fixture/render.py' }); let complete = 0;
    const pending = worker.request({ id: 1 }, { onDispatch() { return () => complete++; } });
    assert.deepEqual(Object.keys(h.wires[0].request), ['id']); h.send(0); await pending; assert.equal(complete, 1);
    h.children[0].stdout.emit('data', JSON.stringify({ id: 1, ok: false }) + '\n'); assert.equal(complete, 1); worker.dispose();
});
check('PNG invalid observer refuses before process creation', async h => {
    const worker = new h.workerModule.RenderWorker({ python: '/fixture/python', renderScript: '/fixture/render.py' });
    assert.equal((await worker.request({ id: 1 }, { onDispatch: 1 })).notDispatched, true); assert.equal(h.children.length, 0);
});
check('PNG queued timeout cleans an empty never-dispatched directory', async h => {
    const a = h.render({ timeoutMs: 100 }), b = h.render({ timeoutMs: 10 }); await flush(); h.clock.advance(10); await flush();
    assert.equal((await b).timeout, true); assert.equal(h.dirs().length, 1); h.send(0); await a; assert.deepEqual(h.dirs(), []);
});
check('PNG disposal retains active directory until close and clears never-dispatched queue', async h => {
    const a = h.render(), b = h.render(); await flush(); h.workerModule.disposeAllWorkers(); h.clock.advance(5000); await flush();
    await a; await b; assert.equal(h.dirs().length, 1); h.children[0].close(1); assert.deepEqual(h.dirs(), []);
});
check('PNG chunk reads stay within admitted bytes and the fixed read chunk', async h => {
    const pending = h.render({ maxPngBytes: 512 * 1024 }); await flush(); h.send(0, GOOD, { body: Buffer.alloc(256 * 1024, 1) });
    assert.equal((await pending).ok, true);
    const reads = h.effects.filter(e => e[0] === 'read-fd');
    assert.equal(reads.reduce((sum, e) => sum + e[1], 0), 256 * 1024);
    assert.ok(reads.every(e => e[2] <= 64 * 1024)); assert.equal(h.fds.size, 0);
});

// Separate custom fixtures keep mutation oracles out of the main strict ports.
function special(name, options, fn) {
    if (!baseline) test(name, async t => { const h = fixture(options); t.after(() => h.cleanup()); await fn(h); });
}
special('PNG growth is refused at the bounded EOF probe', { onRead(value) { value.body = Buffer.concat([value.body, Buffer.from('GROW')]); } }, async h => {
    const pending = h.render(); await flush(); h.send(0); assert.match((await pending).error, /grew/); assert.equal(h.fds.size, 0);
});
special('PNG descriptor metadata change is refused before base64', { onRead(value) { value.mtimeMs++; } }, async h => {
    const pending = h.render(); await flush(); h.send(0); assert.match((await pending).error, /changed/); assert.equal(h.fds.size, 0);
});
special('PNG replaced final inode is preserved by owned cleanup', { onRead(value, files, file) { files.set(file, { ...value, ino: 999999, body: Buffer.from('KEEP REPLACEMENT') }); } }, async h => {
    const pending = h.render(); await flush(); h.send(0); const out = h.wires[0].request.out;
    assert.match((await pending).error, /changed/); assert.equal(h.files.get(out).body.toString(), 'KEEP REPLACEMENT');
});
special('PNG replaced private directory blocks reads and cleanup', { onRead(value, files, file) { const dir = path.dirname(file); files.set(dir, { ...files.get(dir), ino: 999999 }); } }, async h => {
    const pending = h.render(); await flush(); h.send(0); assert.match((await pending).error, /changed/); assert.equal(h.dirs().length, 1);
});
special('PNG nonprivate directory refuses before worker dispatch', { privateMode: 0o40755 }, async h => {
    assert.match((await h.render()).error, /private owned directory/); assert.equal(h.children.length, 0);
});
