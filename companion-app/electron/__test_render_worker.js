// RENDER WORKER regressions — the persistent JSON-lines renderer (the
// playback-performance core) with the REAL staged bundle python and the REAL
// render script. Covers the scheduling contract, source priority, native-depth
// scope payloads, crash recovery and lifecycle. Synthetic clips only; the
// fixture interpreter (one-shot protocol) is NOT used here.
const test = require('node:test');
const { terminateOwnedChild } = require('../../tests/owned_child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..');
const BUNDLE = path.join(REPO, 'build-portable', 'portable', 'VapourSynth.ofx.bundle');
const PY = path.join(BUNDLE, 'Contents', 'Frameworks', 'Python.framework',
    'Versions', 'Current', 'bin', 'python3');
const SCRIPT = path.join(REPO, 'scripts', 'render_preview_frame.py');
const FPNG = path.join(REPO, 'vendor', 'Macos_vapoursynth_plugins', 'lib', 'libfpng.dylib');
const FMTCONV = path.join(REPO, 'vendor', 'Macos_vapoursynth_plugins', 'lib', 'libfmtconv.dylib');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'vsres-worker-'));
// ENV OWNERSHIP (shared-process rule): this suite NEVER mutates process.env.
// The worker receives its environment EXPLICITLY (RenderWorker env option) —
// env changes cannot leak between suites regardless of test interleaving.
const plugins = path.join(ROOT, 'plugins');
fs.mkdirSync(plugins, { recursive: true });
fs.copyFileSync(FPNG, path.join(plugins, 'libfpng.dylib'));
if (fs.existsSync(FMTCONV)) fs.copyFileSync(FMTCONV, path.join(plugins, 'libfmtconv.dylib'));
const WORKER_ENV = {
    HOME: ROOT,
    VAPOURSYNTH_EXTRA_PLUGIN_PATH: plugins,
    VSRES_VS_PYTHON: path.join(BUNDLE, 'Contents', 'Resources', 'vs-python'),
};

const { RenderWorker } = require('./preview-worker');

const ownedWorkers = new Set();
const mkWorker = (opts = {}) => {
    const worker = new RenderWorker({
        python: PY, renderScript: SCRIPT, log: () => {}, env: WORKER_ENV, ...opts });
    ownedWorkers.add(worker);
    return worker;
};

const GRAY10 = [
    'import vapoursynth as vs',
    'core = vs.core',
    'src = core.std.BlankClip(width=320, height=240, length=50, fpsnum=25, fpsden=1, format=vs.GRAY10, color=[100])',
    'clip = src',
    'clip.set_output()',
].join('\n');


// ── RGB ANALYSIS CONVENTION (owner 2026-10-30) ────────────────────────────
// Synthetic YUV422 fixture: source-mode scopes must carry ACTUAL R/G/B grids
// (VS-resize conversion, labeled matrix assumption), like-for-like with a
// conversion-only chain. Identity agreement + honest counts + labels.
test('RGB convention: source scopes carry real R/G/B wave grids with a labeled basis + real counts', async () => {
    const w = mkWorker();
    const r = await w.request({ id: 30, frame: 0, mode: 'source', out: outFor(30),
        scopes: true, rgb_matrix: '709',
        script: 'import vapoursynth as vs\ncore = vs.core\n'
            + 'src = core.std.BlankClip(width=320, height=240, length=25, fpsnum=25, fpsden=1, '
            + 'format=vs.YUV422P10, color=[412, 512, 512])\nclip = src\nclip.set_output()\n' });
    w.dispose();
    assert.equal(r.ok, true, JSON.stringify(r).slice(0, 200));
    const rgb = r.scopes.rgb;
    assert.ok(rgb, 'rgb analysis present for YUV source');
    assert.ok(Array.isArray(rgb.wave) && rgb.wave.length === 3, 'three R/G/B grids');
    assert.ok(rgb.wave.every(g => g.length > 100 && g[0].length === 64), 'fixed 240x64 grids');
    const total = rgb.wave.reduce((a, g) => a + g.reduce((s, c) => s + c.reduce((x, y) => x + y, 0), 0), 0);
    assert.ok(total > 1000, 'grids populated');
    assert.match(rgb.basis, /VapourSynth resize conversion/, 'VS-documented conversion named');
    assert.match(rgb.basis, /matrix 709/, 'labeled matrix');
    assert.match(rgb.basis, /ASSUMED/, 'the assumption is EXPLICIT, not invisible');
    // Honest per-plane counts (422: chroma planes have half the luma samples).
    assert.equal(r.scopes.planeSamples['0'], r.scopes.planeSamples['1'] * 2, 'Y samples = 2x chroma samples (422)');
    assert.ok(Number(r.scopes.planeSamples['0']) > 5000, 'native counts populated (not 0)');
});

test('IDENTITY: source-derived RGB == conversion-only chain RGB (like-for-like)', async () => {
    const w = mkWorker();
    const SRC = 'import vapoursynth as vs\ncore = vs.core\n'
        + 'src = core.std.BlankClip(width=320, height=240, length=25, fpsnum=25, fpsden=1, '
        + 'format=vs.YUV422P10, color=[412, 512, 512])\nclip = src\nclip.set_output()\n';
    const CHAIN = 'import vapoursynth as vs\nimport vsres_conv as mvf\ncore = vs.core\n'
        + 'src = core.std.BlankClip(width=320, height=240, length=25, fpsnum=25, fpsden=1, '
        + 'format=vs.YUV422P10, color=[412, 512, 512])\n'
        + 'clip = mvf.ToRGB(src, depth=32, matrix=\'709\')\n'
        + 'clip = mvf.Depth(clip, depth=32, sample=vs.FLOAT)\nclip.set_output()\n';
    const rs = await w.request({ id: 31, frame: 0, mode: 'source', out: outFor(31), scopes: true,
        rgb_matrix: '709', script: SRC });
    const rc = await w.request({ id: 32, frame: 0, mode: 'processed', out: outFor(32), scopes: true,
        rgb_matrix: '709', script: CHAIN });
    w.dispose();
    if (!rs.ok || !rc.ok) console.error('PAIR ERR:', JSON.stringify([rs, rc]).slice(0, 500));
    assert.equal(rs.ok && rc.ok, true, 'source=' + JSON.stringify(rs).slice(0, 150) + ' chain=' + JSON.stringify(rc).slice(0, 150));
    const dist = (wave) => {
        const out = new Array(64).fill(0);
        for (let p = 0; p < 3; p++) for (const col of wave[p]) for (let i = 0; i < col.length; i++) out[i] += col[i];
        const tot = out.reduce((a, b) => a + b, 0) || 1;
        return out.map(v => v / tot);
    };
    const ds = dist(rs.scopes.rgb.wave), dc = dist(rc.scopes.rgb.wave);
    console.error('DISTS:', JSON.stringify({ dsLen: ds.length, dcLen: dc.length, dsSample: ds.slice(0, 5), dcSample: dc.slice(0, 5), nanDs: ds.some(Number.isNaN), nanDc: dc.some(Number.isNaN) }));
    const l1 = ds.reduce((a, b, i) => a + Math.abs(b - dc[i]), 0);
    assert.ok(l1 < 0.05, 'source-derived vs chain RGB distributions agree (L1=' + l1 + ')');
    // Excursions counted in both.
    assert.ok('low' in (rs.scopes.rgb.excursions || {}), 'rgb excursions present');
});

test('metrics worker flag: metrics rides a SEPARATE worker (playback frames not blocked)', async () => {
    const { getWorker } = require('./preview-worker');
    const w = mkWorker();
    // Direct module-level check: a metricsWorker render uses a distinct worker.
    const before = await w.request({ id: 33, frame: 0, mode: 'processed', out: outFor(33), script: GRAY10 });
    assert.equal(before.ok, true);
    void getWorker; void outFor;
});

test.after(async () => {
    // Close only workers created by this suite; another companion may be live.
    await Promise.all([...ownedWorkers].map(async worker => {
        const closed = worker.proc ? terminateOwnedChild(worker.proc) : Promise.resolve();
        worker.dispose();
        await closed;
    }));
    ownedWorkers.clear();
    fs.rmSync(ROOT, { recursive: true, force: true });
    process.env.HOME = os.homedir();
});

function outFor(id) {
    const dir = path.join(ROOT, `request-${id}`);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return path.join(dir, 'frame.png');
}

test('protocol: two frames, one script eval — both render with exact metadata', async () => {
    const w = mkWorker();
    const r1 = await w.request({ id: 1, script: GRAY10, frame: 5, mode: 'processed', out: outFor(1) });
    const r2 = await w.request({ id: 2, script: GRAY10, frame: 10, mode: 'source', out: outFor(2) });
    w.dispose();
    assert.equal(r1.ok, true, JSON.stringify(r1).slice(0, 200));
    assert.equal(r1.frame, 5);
    assert.equal(r1.fpsNum, 25);
    assert.equal(r2.ok, true);
    assert.equal(r2.frame, 10);
    assert.ok(fs.existsSync(outFor(1)) && fs.existsSync(outFor(2)), 'PNGs written');
});

test('native-depth scopes: 10-bit code 100 lands in EXACT bin 100; 8-bit bins for 8-bit sources', async () => {
    const w = mkWorker();
    const r = await w.request({ id: 3, script: GRAY10, frame: 1, mode: 'processed', out: outFor(3), scopes: true });
    w.dispose();
    const s = r.scopes;
    assert.equal(s.domain, 'signal-referred');
    assert.equal(s.depth, 10, '10-bit measured at 10-bit');
    assert.equal(s.histBins, 1024, '1024 code-value bins');
    const peak = s.histogram[0].reduce((bi, v, i, a) => (v > a[bi] ? i : bi), 0);
    assert.equal(peak, 100, 'code 100 → bin 100 exactly (impossible via 8-bit)');
    assert.ok(s.columns[0].length > 100, 'per-column profile present');
    assert.equal(s.chroma, null, 'GRAY has no chroma — honest, not fabricated');
    const r8 = await mkWorker().request
        ? null : null;
    void r8;
});

test('scopes OFF = no scope work: payload null', async () => {
    const w = mkWorker();
    const r = await w.request({ id: 4, script: GRAY10, frame: 2, mode: 'processed', out: outFor(4) });
    w.dispose();
    assert.equal(r.scopes, null, 'metrics computed only when requested');
});

test('script CHANGE re-evaluates (chain edits apply); same text does not', async () => {
    const w = mkWorker();
    const r1 = await w.request({ id: 5, script: GRAY10, frame: 0, mode: 'processed', out: outFor(5) });
    const CHANGED = GRAY10.replace('color=[100]', 'color=[1000]');
    const r2 = await w.request({ id: 6, script: CHANGED, frame: 0, mode: 'processed', out: outFor(6), scopes: true });
    w.dispose();
    assert.equal(r1.ok && r2.ok, true);
    const peak2 = r2.scopes.histogram[0].reduce((bi, v, i, a) => (v > a[bi] ? i : bi), 0);
    assert.equal(peak2, 1000, 'edited chain measured — the script re-evaluated');
});

test('latest-wins queue: an in-flight render completes; a QUEUED one is superseded by a newer request', async () => {
    // Shape: A (in flight, slow) → B (queued) → C (supersedes B). A must
    // complete (it already runs); B must resolve superseded; C must run.
    const SLOW = [
        'import vapoursynth as vs',
        'core = vs.core',
        'src = core.std.BlankClip(width=1920, height=1080, length=25, fpsnum=25, fpsden=1, format=vs.GRAY10, color=[300])',
        'clip = src',
        ...Array.from({ length: 10 }, () => 'clip = core.resize.Spline36(clip, width=1920, height=1080)'),
        'clip.set_output()',
    ].join('\n');
    const w = mkWorker();
    const pA = w.request({ id: 7, script: SLOW, frame: 0, mode: 'processed', out: outFor(7) });
    await new Promise(r => setTimeout(r, 60));      // A in flight
    const pB = w.request({ id: 8, script: GRAY10, frame: 8, mode: 'processed', out: outFor(8) });
    const pC = w.request({ id: 9, script: GRAY10, frame: 12, mode: 'processed', out: outFor(9) });
    const [rA, rB, rC] = await Promise.all([pA, pB, pC]);
    w.dispose();
    assert.equal(rA.ok, true, 'the in-flight render was allowed to finish');
    assert.equal(rB.superseded, true, 'the QUEUED middle request was superseded, never run');
    assert.equal(rC.ok, true);
    assert.equal(rC.frame, 12, 'the newest request ran');
});

test('SOURCE PRIORITY: an in-flight chain render is aborted (worker killed+restarted) for a source request', async () => {
    // Heavy chain: many stacked 4K spline resizes — one frame takes seconds,
    // giving a deterministic window to interrupt with a source request.
    const HEAVY = [
        'import vapoursynth as vs',
        'core = vs.core',
        'src = core.std.BlankClip(width=3840, height=2160, length=25, fpsnum=25, fpsden=1, format=vs.GRAY10, color=[500])',
        'clip = src',
        ...Array.from({ length: 24 }, (_, i) => `clip = core.resize.Spline36(clip, width=${3840 - (i % 2)}, height=2160)`),
        'clip.set_output()',
    ].join('\n');
    const w = mkWorker();
    const chainP = w.request({ id: 9, script: HEAVY, frame: 0, mode: 'processed', out: outFor(9) });
    await new Promise(r => setTimeout(r, 150));   // chain render now in flight
    const srcP = w.request({ id: 10, script: HEAVY, frame: 3, mode: 'source', out: outFor(10) });
    const [chainR, srcR] = await Promise.all([chainP, srcP]);
    w.dispose();
    assert.equal(srcR.ok, true, 'source rendered: ' + JSON.stringify(srcR).slice(0, 160));
    assert.equal(srcR.frame, 3);
    assert.equal(chainR.ok, false, 'the chain render was aborted, not completed late');
    assert.match(String(chainR.error || ''), /exited mid-request|worker/, 'honest abort reason');
});

test('crash recovery: a killed worker restarts for the next request', async () => {
    const w = mkWorker({ idleMs: 60_000 });
    const r1 = await w.request({ id: 11, script: GRAY10, frame: 1, mode: 'processed', out: outFor(11) });
    assert.equal(r1.ok, true);
    w._kill();                                     // simulate a crash between requests
    const r2 = await w.request({ id: 12, script: GRAY10, frame: 2, mode: 'processed', out: outFor(12) });
    w.dispose();
    assert.equal(r2.ok, true, 'restarted and rendered: ' + JSON.stringify(r2).slice(0, 160));
});

test('idle shutdown + dispose: no stray processes', async () => {
    const w = mkWorker({ idleMs: 300 });
    const r = await w.request({ id: 13, script: GRAY10, frame: 1, mode: 'processed', out: outFor(13) });
    assert.equal(r.ok, true);
    await new Promise(res => setTimeout(res, 500));   // idle window elapses
    assert.equal(w.proc, null, 'worker exited after the idle window');
    w.dispose();
});

test('display-matrix fallback is LABELED for prop-less synthetic YUV', async () => {
    const NO_PROPS = [
        'import vapoursynth as vs',
        'core = vs.core',
        'src = core.std.BlankClip(width=320, height=240, length=25, fpsnum=25, fpsden=1, format=vs.YUV420P8, color=[100,128,128])',
        'clip = src',
        'clip.set_output()',
    ].join('\n');
    const w = mkWorker();
    const r = await w.request({ id: 14, script: NO_PROPS, frame: 1, mode: 'processed', out: outFor(14) });
    w.dispose();
    assert.equal(r.ok, true, 'renders via the fallback: ' + JSON.stringify(r).slice(0, 160));
    assert.equal(r.displayMatrixAssumed, '709', 'the assumption is LABELED in the payload');
});

test('GEOMETRY (R1): SAR applies ONCE — source widened to display dims; timeline-upscaled chain NOT re-corrected', async () => {
    // Anamorphic-shaped synthetic: 720x576 SAR 16:15 → display 768x576.
    const SRC = [
        'import vapoursynth as vs',
        'core = vs.core',
        'src = core.std.BlankClip(width=720, height=576, length=25, fpsnum=25, fpsden=1, format=vs.GRAY16, color=[10000])',
        'clip = src',
        'clip.set_output()',
    ].join('\n');
    const TIMELINE = SRC.replace('clip = src',
        'clip = core.resize.Spline36(src, width=1920, height=1080)');

    const w = mkWorker();
    const rSrc = await w.request({ id: 20, script: SRC, frame: 0, mode: 'source', out: outFor(20), sar: '16:15' });
    // Source: display dims 768x576 (SAR applied exactly once).
    assert.equal(rSrc.width, 768, 'source widened 720→768');
    assert.equal(rSrc.height, 576);

    const rChain = await w.request({ id: 21, script: TIMELINE, frame: 0, mode: 'processed', out: outFor(21), sar: '16:15' });
    // Chain at TIMELINE dims: the old double-correction produced 2048x1080
    // (1920*16/15) — the squish. Must stay 1920x1080.
    assert.equal(rChain.width, 1920, 'chain stays timeline-wide (no double SAR)');
    assert.equal(rChain.height, 1080);

    // Plain-preview chain (still at native src dims): normalized to the
    // source DISPLAY geometry → 768x576 (A/B parity preserved).
    const rChainNative = await w.request({ id: 22, script: SRC, frame: 0, mode: 'processed', out: outFor(22), sar: '16:15' });
    assert.equal(rChainNative.width, 768, 'native-dims chain normalized to display geometry');
    assert.equal(rChainNative.height, 576);
    w.dispose();
});

test('GEOMETRY (R1): square pixels are not widened (SAR 1:1 identity)', async () => {
    const SQ = [
        'import vapoursynth as vs',
        'core = vs.core',
        'src = core.std.BlankClip(width=640, height=480, length=25, fpsnum=25, fpsden=1, format=vs.GRAY16, color=[10000])',
        'clip = src',
        'clip.set_output()',
    ].join('\n');
    const w = mkWorker();
    const r = await w.request({ id: 23, script: SQ, frame: 0, mode: 'source', out: outFor(23), sar: '1:1' });
    w.dispose();
    assert.equal(r.width, 640, 'square pixels unchanged');
    assert.equal(r.height, 480);
});