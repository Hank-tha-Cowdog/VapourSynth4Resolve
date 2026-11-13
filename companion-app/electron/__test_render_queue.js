// render-queue.js — sequential render queue (python runner → rawvideo →
// ffmpeg). All processes are fakes (injectable spawnImpl driving real
// PassThrough streams); no media, no binaries, no Resolve.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');

const { createRenderQueue, ENCODERS } = require('./render-queue');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'vsres-rq-')); }
function writeScript(dir, name = 'composed.vpy') {
    const p = path.join(dir, name);
    fs.writeFileSync(p, 'src.set_output()\n');
    return p;
}
function runtimes() {
    return {
        python: '/fake/bundle/python3',
        runner: '/fake/scripts/render_chain_runner.py',
        ffmpeg: '/fake/bundle/ffmpeg',
        pluginPath: '/fake/bundle/Plugins',
    };
}

const INFO = {
    width: 1920, height: 1080, frames: 24,
    fps_num: 24000, fps_den: 1001,
    pix_fmt: 'gbrpf32le', format: 'RGBS',
    matrix: 1, transfer: 1, primaries: 1, range: 0,
};

// ---- fake process harness --------------------------------------------------
function makeHarness() {
    const spawns = [];
    const spawnImpl = (cmd, argv, opts) => {
        const base = path.basename(cmd);
        const kind = base.startsWith('python') ? (argv.includes('--info') ? 'info' : 'render') : 'ffmpeg';
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.stdin = kind === 'ffmpeg' ? new PassThrough() : null;
        child.killed = [];
        child.kill = (sig) => { child.killed.push(sig); if (child._onKill) child._onKill(sig); };
        spawns.push({ cmd, argv, opts, child, kind });
        return child;
    };
    return { spawns, spawnImpl };
}

function finishInfo(rec, { info = INFO, code = 0, stderr = '' } = {}) {
    setImmediate(() => {
        if (code === 0) rec.child.stdout.write(JSON.stringify(info) + '\n');
        if (stderr) rec.child.stderr.write(stderr);
        rec.child.stdout.end();
        rec.child.stderr.end();
        rec.child.emit('exit', code, null);
    });
}
function finishRender(rec, { code = 0, stderr = '', frames = 10 } = {}) {
    setImmediate(() => {
        if (frames > 0) rec.child.stderr.write(`Frame: ${Math.floor(frames / 2)}/${frames} (50.0%)\n`);
        if (stderr) rec.child.stderr.write(stderr);
        rec.child.stdout.end();
        rec.child.stderr.end();
        rec.child.emit('exit', code, null);
    });
}
function finishFfmpeg(rec, { code = 0, stderr = '' } = {}) {
    if (stderr) rec.child.stderr.write(stderr);
    rec.child.stderr.end();
    // Drain stdin then exit when the producer closes it (mirrors real ffmpeg).
    rec.child.stdin.on('finish', () => rec.child.emit('exit', code, null));
    rec.child.stdin.resume();
}

// Auto-driving spawn: info resolves with JSON, render+ffmpeg succeed.
function autoSpawn(h, { info = INFO, renderCode = 0, renderStderr = '' } = {}) {
    return (c, a, o) => {
        const rec = h.spawnImpl(c, a, o);
        const r = h.spawns[h.spawns.length - 1];
        if (r.kind === 'info') finishInfo(r, { info });
        else if (r.kind === 'render') finishRender(r, { code: renderCode, stderr: renderStderr, frames: 6 });
        else finishFfmpeg(r);
        return rec;
    };
}

test('add validation: every refusal + auto-extension + completed add', async () => {
    const dir = tmpDir();
    const h = makeHarness();
    const q = createRenderQueue({ spawnImpl: autoSpawn(h), resolveRuntimes: () => runtimes() });
    const script = writeScript(dir);

    assert.equal(q.add(null).ok, false);
    assert.equal(q.add({ scriptPath: 'relative.vpy', outputPath: path.join(dir, 'o') }).ok, false);
    assert.equal(q.add({ scriptPath: path.join(dir, 'missing.vpy'), outputPath: path.join(dir, 'o') }).ok, false);
    const notVpy = path.join(dir, 'x.txt'); fs.writeFileSync(notVpy, 'x');
    assert.equal(q.add({ scriptPath: notVpy, outputPath: path.join(dir, 'o') }).ok, false);
    assert.equal(q.add({ scriptPath: script, outputPath: path.join(dir, 'o'), encoder: 'nope' }).ok, false);
    const existing = path.join(dir, 'out.mov'); fs.writeFileSync(existing, 'x');
    assert.equal(q.add({ scriptPath: script, outputPath: existing }).ok, false);

    const added = q.add({ scriptPath: script, outputPath: path.join(dir, 'out'), encoder: 'ffv1' });
    assert.equal(added.ok, true);
    assert.equal(q.find(added.id).outputPath, path.join(dir, 'out.mkv')); // extension appended
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(q.find(added.id).state, 'done');
    const late = q.cancel(added.id);
    assert.equal(late.ok, false); // finished jobs cannot be cancelled
});

test('happy path: info → raw pipe → done; argv, pix_fmt, color tags, env', async () => {
    const dir = tmpDir();
    const h = makeHarness();
    const events = [];
    const q = createRenderQueue({
        spawnImpl: autoSpawn(h), resolveRuntimes: () => runtimes(),
        emit: (e) => events.push(e),
    });
    const script = writeScript(dir);
    const out = path.join(dir, 'render.mov');
    const res = q.add({ scriptPath: script, outputPath: out, encoder: 'prores' });
    assert.equal(res.ok, true);
    await new Promise(resolve => setTimeout(resolve, 80));
    const job = q.find(res.id);
    assert.equal(job.state, 'done');
    assert.deepEqual(job.clipInfo, { width: 1920, height: 1080, frames: 24, pixFmt: 'gbrpf32le', formatName: 'RGBS' });

    const info = h.spawns.find(s => s.kind === 'info');
    const render = h.spawns.find(s => s.kind === 'render');
    const ff = h.spawns.find(s => s.kind === 'ffmpeg');
    assert.deepEqual(info.argv, ['/fake/scripts/render_chain_runner.py', '--info', script]);
    assert.deepEqual(render.argv, ['/fake/scripts/render_chain_runner.py', script]);
    assert.equal(render.opts.env.VAPOURSYNTH_EXTRA_PLUGIN_PATH, '/fake/bundle/Plugins');

    const fa = ff.argv;
    assert.ok(fa.includes('-f') && fa.includes('rawvideo'));
    assert.ok(fa.includes('-pix_fmt') && fa.includes('gbrpf32le'));
    assert.ok(fa.includes('-s') && fa.includes('1920x1080'));
    assert.ok(fa.includes('-r') && fa.includes('24000/1001'));
    assert.ok(fa.includes('-colorspace') && fa.includes('1'));
    assert.ok(fa.includes('-color_trc') && fa.includes('1'));
    assert.ok(fa.includes('-color_primaries') && fa.includes('1'));
    assert.ok(fa.includes('-color_range') && fa.includes('0'));
    for (const a of ENCODERS.prores.args) assert.ok(fa.includes(a));
    assert.ok(fa.includes(out));

    const progress = events.filter(e => e.type === 'progress');
    assert.ok(progress.length >= 1);
    assert.equal(progress[0].progress.total, 6);
    assert.ok(events.some(e => e.type === 'job' && e.job.state === 'running'));
    assert.ok(events.some(e => e.type === 'job' && e.job.state === 'done'));
});

test('sequencing: jobs run one at a time, in order', async () => {
    const dir = tmpDir();
    const h = makeHarness();
    const order = [];
    const q = createRenderQueue({
        spawnImpl: (c, a, o) => {
            const rec = h.spawnImpl(c, a, o);
            const r = h.spawns[h.spawns.length - 1];
            if (r.kind === 'info') finishInfo(r);
            else if (r.kind === 'render') { order.push(r.argv[1]); setTimeout(() => finishRender(r, { frames: 4 }), 10); }
            else finishFfmpeg(r);
            return rec;
        },
        resolveRuntimes: () => runtimes(),
    });
    const a = q.add({ scriptPath: writeScript(dir, 'a.vpy'), outputPath: path.join(dir, 'a.mov') });
    const b = q.add({ scriptPath: writeScript(dir, 'b.vpy'), outputPath: path.join(dir, 'b.mov') });
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(q.find(a.id).state, 'done');
    assert.equal(q.find(b.id).state, 'done');
    assert.deepEqual(order, [path.join(dir, 'a.vpy'), path.join(dir, 'b.vpy')]);
    assert.equal(h.spawns.filter(s => s.kind === 'render').length, 2);
});

test('render failure: job errors with the stderr tail; next job still runs', async () => {
    const dir = tmpDir();
    const h = makeHarness();
    let first = true;
    const q = createRenderQueue({
        spawnImpl: (c, a, o) => {
            const rec = h.spawnImpl(c, a, o);
            const r = h.spawns[h.spawns.length - 1];
            if (r.kind === 'info') finishInfo(r);
            else if (r.kind === 'render') {
                const fail = first; first = false;
                finishRender(r, fail ? { code: 2, stderr: 'Render failed: boom\n', frames: 0 } : { frames: 4 });
            } else finishFfmpeg(r);
            return rec;
        },
        resolveRuntimes: () => runtimes(),
    });
    const a = q.add({ scriptPath: writeScript(dir, 'bad.vpy'), outputPath: path.join(dir, 'bad.mov') });
    const b = q.add({ scriptPath: writeScript(dir, 'good.vpy'), outputPath: path.join(dir, 'good.mov') });
    await new Promise(resolve => setTimeout(resolve, 250));
    const ja = q.find(a.id), jb = q.find(b.id);
    assert.equal(ja.state, 'error');
    assert.match(ja.error, /render failed \(2\)/);
    assert.match(ja.error, /boom/);
    assert.equal(jb.state, 'done');
});

test('info failure: job errors before ffmpeg is ever spawned', async () => {
    const dir = tmpDir();
    const h = makeHarness();
    const q = createRenderQueue({
        spawnImpl: (c, a, o) => {
            const rec = h.spawnImpl(c, a, o);
            const r = h.spawns[h.spawns.length - 1];
            if (r.kind === 'info') finishInfo(r, { code: 1, stderr: 'Render failed: no output clip' });
            else if (r.kind === 'render') finishRender(r);
            else finishFfmpeg(r);
            return rec;
        },
        resolveRuntimes: () => runtimes(),
    });
    const a = q.add({ scriptPath: writeScript(dir, 'broken.vpy'), outputPath: path.join(dir, 'broken.mov') });
    await new Promise(resolve => setTimeout(resolve, 80));
    const ja = q.find(a.id);
    assert.equal(ja.state, 'error');
    assert.match(ja.error, /composed script check failed \(1\)/);
    assert.match(ja.error, /no output clip/);
    assert.equal(h.spawns.some(s => s.kind === 'ffmpeg'), false);
});

test('cancel during render: SIGTERM both processes → cancelled', async () => {
    const dir = tmpDir();
    const h = makeHarness();
    const timers = [];
    let renderRec = null;
    const q = createRenderQueue({
        spawnImpl: (c, a, o) => {
            const rec = h.spawnImpl(c, a, o);
            const r = h.spawns[h.spawns.length - 1];
            if (r.kind === 'info') finishInfo(r);
            else if (r.kind === 'render') { renderRec = r; /* stays running */ }
            else finishFfmpeg(r);
            return rec;
        },
        resolveRuntimes: () => runtimes(),
        setTimeoutImpl: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    });
    const a = q.add({ scriptPath: writeScript(dir, 'c.vpy'), outputPath: path.join(dir, 'c.mov') });
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(q.find(a.id).state, 'running');
    const ffRec = h.spawns.find(s => s.kind === 'ffmpeg');
    // Simulate the processes honoring SIGTERM by exiting.
    renderRec.child._onKill = () => setImmediate(() => { renderRec.child.stdout.end(); renderRec.child.stderr.end(); renderRec.child.emit('exit', 143, 'SIGTERM'); });
    ffRec.child._onKill = () => setImmediate(() => { ffRec.child.stderr.end(); ffRec.child.emit('exit', 143, 'SIGTERM'); });
    const res = q.cancel(a.id);
    assert.equal(res.ok, true);
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.deepEqual(renderRec.child.killed, ['SIGTERM']);
    assert.deepEqual(ffRec.child.killed, ['SIGTERM']);
    assert.equal(q.find(a.id).state, 'cancelled');
    // Grace escalation must be a no-op on concluded procs.
    for (const t of timers) t.fn();
});

test('persistence: queue survives reload; running → interrupted', async () => {
    const dir = tmpDir();
    const jobsFile = path.join(dir, 'queue.json');
    const h = makeHarness();
    const q1 = createRenderQueue({ spawnImpl: h.spawnImpl, resolveRuntimes: () => runtimes(), jobsFile });
    const script = writeScript(dir);
    const added = q1.add({ scriptPath: script, outputPath: path.join(dir, 'p.mov') });
    assert.equal(added.ok, true);
    q1.cancel(added.id); // keep it from running under the bare harness
    // Simulate a crash while running: rewrite the file with state=running.
    const data = JSON.parse(fs.readFileSync(jobsFile, 'utf8'));
    data.jobs[0].state = 'running';
    fs.writeFileSync(jobsFile, JSON.stringify(data));

    const q2 = createRenderQueue({ spawnImpl: h.spawnImpl, resolveRuntimes: () => runtimes(), jobsFile });
    const list = q2.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].state, 'interrupted');
});

test('remove + clearFinished', async () => {
    const dir = tmpDir();
    const h = makeHarness();
    const q = createRenderQueue({ spawnImpl: autoSpawn(h), resolveRuntimes: () => runtimes() });
    const script = writeScript(dir);
    const a = q.add({ scriptPath: script, outputPath: path.join(dir, 'a.mov') });
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(q.find(a.id).state, 'done');
    assert.equal(q.remove('nope').ok, false);
    assert.equal(q.remove(a.id).ok, true);   // finished jobs may be removed
    const b = q.add({ scriptPath: script, outputPath: path.join(dir, 'b.mov') });
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(q.find(b.id).state, 'done');
    assert.equal(q.clearFinished().removed, 1);
    assert.equal(q.list().length, 0);
});

test('parseProgress accepts runner formats and rejects noise', () => {
    const dir = tmpDir();
    const h = makeHarness();
    const q = createRenderQueue({ spawnImpl: h.spawnImpl, resolveRuntimes: () => runtimes(), jobsFile: path.join(dir, 'q.json') });
    const parse = q._internals.parseProgress;
    assert.deepEqual(parse('Frame: 4/20 (20.0%)    '), { frame: 4, total: 20, percent: 20 });
    assert.deepEqual(parse('Frame: 199/199 (100.0%)'), { frame: 199, total: 199, percent: 100 });
    assert.equal(parse('Render failed:'), null);
    assert.equal(parse(''), null);
});

// ---- H.264 system-ffmpeg routing (2026-11-13) ------------------------------
// The bundled ffmpeg is LGPL-only (no libx264 — verified against the shipped
// beta.2 runtime). The h264 preset must route to a SYSTEM ffmpeg, be hidden
// when none is capable, and refuse at add/run time — never silently encode
// with a runtime that cannot.

test('h264 hidden from the encoder list when no capable system ffmpeg', () => {
    const h = makeHarness();
    const q = createRenderQueue({
        spawnImpl: h.spawnImpl, resolveRuntimes: () => runtimes(),
        systemFfmpegCapable: () => false,
    });
    const enc = q.encoders();
    assert.equal(enc.h264, undefined);
    assert.ok(enc.prores && enc.ffv1);
});

test('h264 listed when a capable system ffmpeg exists', () => {
    const h = makeHarness();
    const q = createRenderQueue({
        spawnImpl: h.spawnImpl, resolveRuntimes: () => runtimes(),
        systemFfmpegCapable: () => true,
    });
    assert.equal(q.encoders().h264.label, 'H.264 (system ffmpeg)');
});

test('adding an h264 job without a capable system ffmpeg is refused', () => {
    const dir = tmpDir();
    const h = makeHarness();
    const q = createRenderQueue({
        spawnImpl: h.spawnImpl, resolveRuntimes: () => runtimes(),
        systemFfmpegCapable: () => false,
    });
    const script = writeScript(dir);
    const res = q.add({ scriptPath: script, outputPath: path.join(dir, 'o.mp4'), encoder: 'h264' });
    assert.equal(res.ok, false);
    assert.match(res.error, /system ffmpeg/);
});

test('h264 job routes through the resolveRuntimes(encoder) system path', async () => {
    const dir = tmpDir();
    const h = makeHarness();
    const calls = [];
    const q = createRenderQueue({
        spawnImpl: autoSpawn(h),
        resolveRuntimes: (k) => {
            calls.push(k);
            return k === 'h264'
                ? { ...runtimes(), ffmpeg: '/fake/system/ffmpeg', ffmpegSource: 'system' }
                : runtimes();
        },
        systemFfmpegCapable: () => true,
    });
    const script = writeScript(dir);
    const res = q.add({ scriptPath: script, outputPath: path.join(dir, 'o'), encoder: 'h264' });
    assert.equal(res.ok, true);
    assert.equal(q.find(res.id).outputPath, path.join(dir, 'o.mp4'));
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(q.find(res.id).state, 'done');
    assert.ok(calls.includes('h264'), 'resolveRuntimes must receive the job encoder');
    const ff = h.spawns.find(s => s.kind === 'ffmpeg');
    assert.equal(ff.cmd, '/fake/system/ffmpeg');       // routed to the system ffmpeg
    assert.ok(ff.argv.includes('libx264'));
    const info = h.spawns.find(s => s.kind === 'info');
    assert.equal(info.cmd, '/fake/bundle/python3');    // python stays bundled
});

test('queued h264 job fails with the specific message when no system ffmpeg appears', async () => {
    const dir = tmpDir();
    const h = makeHarness();
    // Capable at add-time (race: system ffmpeg removed by run-time), then
    // resolveRuntimes reports no ffmpeg for h264.
    const q = createRenderQueue({
        spawnImpl: h.spawnImpl,
        resolveRuntimes: () => ({ ...runtimes(), ffmpeg: null, ffmpegSource: null }),
        systemFfmpegCapable: () => true,
    });
    const script = writeScript(dir);
    const res = q.add({ scriptPath: script, outputPath: path.join(dir, 'o.mp4'), encoder: 'h264' });
    assert.equal(res.ok, true);
    await new Promise(resolve => setTimeout(resolve, 80));
    const job = q.find(res.id);
    assert.equal(job.state, 'error');
    assert.match(job.error, /system ffmpeg/);
    assert.equal(h.spawns.length, 0, 'no process may start without a capable runtime');
});
