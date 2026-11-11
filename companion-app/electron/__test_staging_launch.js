// PACKAGED-APP STAGING LAUNCH tests — exercise the REAL production helper
// path, not a substitute: a fake-but-faithful staged Resources/ layout
// (process.resourcesPath override) containing the REAL shipped scripts
// directory and the REAL staged OFX bundle, then the REAL preview-companion
// module spawning the REAL embedded framework python to render a known
// test signal. Isolated fake HOME; no dev PYTHONPATH; no user data.
//
// Covers (per the staging-launch request):
//   1. helperScript: packaged Resources/scripts wins; asar paths rejected
//      (fs.existsSync LIES for asar members — python gets ENOENT);
//      missing script → null → honest reinstall error.
//   2. End-to-end draft preview render through the production module with
//      a staged resourcesPath: REAL python + REAL script → PNG bytes.
//   3. Missing helper script in the staged layout → honest error naming
//      the helper, never a crash or silent fallback to dev paths.
//   4. resolveRuntimes: embedded bundle python selected when no runtime/
//      tree; runtime tree wins when present (legacy layout honored);
//      absent ffmpeg/ffprobe reported exists:false honestly.
//   5. All four production helper names resolve in the staged layout.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { disposeAllWorkers } = require('./preview-worker');

const REPO = path.join(__dirname, '..', '..');
const BUNDLE = path.join(REPO, 'build-portable', 'portable', 'VapourSynth.ofx.bundle');
const REAL_SCRIPTS = path.join(REPO, 'scripts');
const HELPERS = ['render_preview_frame.py', 'probe_vs_plugins.py', 'probe_rife.py', 'resolve-query.py'];
// resolve-query.py ships from companion-app/electron (its dev home); the rest from repo scripts/.
const HELPER_SOURCES = {
    'resolve-query.py': path.join(__dirname, 'resolve-query.py'),
};

function stagedResources() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vsres-staged-'));
    const res = path.join(root, 'Resources');
    fs.mkdirSync(path.join(res, 'scripts'), { recursive: true });
    for (const h of HELPERS) fs.copyFileSync(HELPER_SOURCES[h] || path.join(REAL_SCRIPTS, h), path.join(res, 'scripts', h));
    // The OFX bundle: symlink to the real staged bundle (spawn reads through
    // symlinks; the python is the REAL embedded framework interpreter).
    fs.mkdirSync(path.join(res, 'OFX'), { recursive: true });
    fs.symlinkSync(BUNDLE, path.join(res, 'OFX', 'VapourSynth.ofx.bundle'), 'dir');
    return { root, res };
}

function isolatedHome(tag) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `vsres-home-${tag}-`));
    return home;
}

const { helperScript, resolveRuntimes } = require('./prod-paths');

test.afterEach(() => { delete process.resourcesPath; });

test('staged layout preconditions: real bundle + real helpers', () => {
    assert.ok(fs.existsSync(path.join(BUNDLE, 'Contents', 'Frameworks', 'Python.framework',
        'Versions', 'Current', 'bin', 'python3')), 'embedded framework python');
    for (const h of HELPERS) assert.ok(fs.existsSync(HELPER_SOURCES[h] || path.join(REAL_SCRIPTS, h)), h);
});

test('helperScript: packaged Resources/scripts wins; asar candidates rejected', () => {
    const { res } = stagedResources();
    process.resourcesPath = res;
    assert.equal(helperScript('render_preview_frame.py'),
        path.join(res, 'scripts', 'render_preview_frame.py'));
    // A resourcesPath INSIDE an asar must never resolve (existsSync lies).
    process.resourcesPath = '/fake/App.app/Contents/Resources';
    const asarCandidate = helperScript('render_preview_frame.py');
    assert.ok(!String(asarCandidate).includes('app.asar'), 'no asar path leaks');
    // Missing everywhere → null (caller reports honestly).
    process.resourcesPath = res;
    assert.equal(helperScript('does-not-exist.py'), null);
});

test('all four production helpers resolve in the staged layout', () => {
    const { res } = stagedResources();
    process.resourcesPath = res;
    for (const h of HELPERS) {
        assert.equal(helperScript(h), path.join(res, 'scripts', h), h);
    }
});

test('resolveRuntimes: embedded bundle python selected; ffmpeg/ffprobe honestly absent', () => {
    const { res } = stagedResources();
    const rt = resolveRuntimes({ resourcesPath: res });
    assert.equal(rt.python.source, 'ofx-bundle');
    assert.equal(rt.python.exists, true);
    assert.ok(rt.python.path.includes('Python.framework'), 'bundle interpreter');
    assert.equal(rt.ffmpeg.exists, false, 'runtime/ tree is optional — absent is honest');
    assert.equal(rt.ffprobe.exists, false, 'ditto ffprobe');
    // runtime/ tree wins when PRESENT (legacy layout honored).
    fs.mkdirSync(path.join(res, 'runtime', 'python', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(res, 'runtime', 'python', 'bin', 'python3'), '#!/bin/sh\n');
    const rt2 = resolveRuntimes({ resourcesPath: res });
    assert.equal(rt2.python.source, 'runtime');
    fs.rmSync(path.join(res, 'runtime'), { recursive: true, force: true });
});

test('resolveRuntimes: ffprobe requires a regular executable outside ASAR', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vsres-ffprobe-resources-'));
    const res = path.join(root, 'Resources');
    const bin = path.join(res, 'runtime', 'ffmpeg', 'ffprobe');
    const plugins = path.join(res, 'OFX', 'VapourSynth.ofx.bundle', 'Contents', 'Plugins');
    try {
        // Keep the unrelated plugin resolver inside this inert fixture too.
        fs.mkdirSync(plugins, { recursive: true });
        fs.mkdirSync(path.dirname(bin), { recursive: true });
        assert.equal(resolveRuntimes({ resourcesPath: res }).ffprobe.exists, false);
        fs.writeFileSync(bin, '', { mode: 0o644 });
        assert.equal(resolveRuntimes({ resourcesPath: res }).ffprobe.exists, false);
        fs.chmodSync(bin, 0o755);
        assert.deepEqual(resolveRuntimes({ resourcesPath: res }).ffprobe,
            { path: bin, exists: true });
        fs.unlinkSync(bin);
        fs.mkdirSync(bin);
        assert.equal(resolveRuntimes({ resourcesPath: res }).ffprobe.exists, false);
        fs.rmdirSync(bin);
        const outside = path.join(root, 'outside-helper');
        fs.writeFileSync(outside, '', { mode: 0o755 });
        fs.symlinkSync(outside, bin);
        assert.equal(resolveRuntimes({ resourcesPath: res }).ffprobe.exists, false);
        const asar = path.join(root, 'app.asar', 'Resources');
        const asarBin = path.join(asar, 'runtime', 'ffmpeg', 'ffprobe');
        fs.mkdirSync(path.dirname(asarBin), { recursive: true });
        fs.mkdirSync(path.join(asar, 'OFX', 'VapourSynth.ofx.bundle', 'Contents', 'Plugins'),
            { recursive: true });
        fs.writeFileSync(asarBin, '', { mode: 0o755 });
        assert.equal(resolveRuntimes({ resourcesPath: asar }).ffprobe.exists, false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('PRODUCTION PATH: draft preview renders a PNG through the staged layout', async () => {
    const { res } = stagedResources();
    const home = isolatedHome('render');
    process.resourcesPath = res;
    process.env.HOME = home;
    // Under --test-isolation=none, sibling suites' fixture env leaks in
    // (VSRES_SAMPLE_PYTHON points at a SYNTHETIC interpreter). Sanitize the
    // seams this test must not see, and restore them afterwards.
    const saved = ['VSRES_SAMPLE_PYTHON', 'VSRES_DEV_PYTHON', 'PYTHONPATH', 'VSRES_NO_RENDER_WORKER']
        .map(k => [k, process.env[k]]);
    for (const [k] of saved) delete process.env[k];
    // The preview PNG writer (fpng) is a USER-PLUGIN installed by the
    // documented clean-machine step (scripts/install_vendored_plugins.py).
    // Model the post-install machine: a plugins dir with ONLY the curated
    // fpng dylib (loading the RAW vendor dir would include the curated-OUT
    // crashing dylib — exactly what the installer exists to prevent).
    const pluginsDir = path.join(res, 'user-plugins');
    fs.mkdirSync(pluginsDir, { recursive: true });
    fs.copyFileSync(path.join(REPO, 'vendor', 'Macos_vapoursynth_plugins', 'lib', 'libfpng.dylib'),
        path.join(pluginsDir, 'libfpng.dylib'));
    process.env.VAPOURSYNTH_EXTRA_PLUGIN_PATH = pluginsDir;
    // Fresh require so module-level state rebinds to the staged layout.
    delete require.cache[require.resolve('./preview-companion')];
    const { renderPreviewFrame } = require('./preview-companion');
    const result = await renderPreviewFrame({
        frame: 0,
        draftScript: [
            'import vapoursynth as vs',
            'core = vs.core',
            'clip = core.std.BlankClip(width=64, height=48, format=vs.RGB24, color=[255, 0, 0])',
            'clip.set_output()',
        ].join('\n'),
    });
    process.env.HOME = os.homedir();
    delete process.env.VAPOURSYNTH_EXTRA_PLUGIN_PATH;
    for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    assert.ok(result.ok, 'render through the staged production path: ' + (result.error || ''));
    assert.match(result.dataUrl, /^data:image\/png;base64,/, 'PNG bytes returned');
    assert.equal(result.provenance, 'draft');
    const appSupport = path.join(home, 'Library', 'Application Support', 'VapourSynth-OFX');
    const leftovers = fs.existsSync(appSupport)
        ? fs.readdirSync(path.join(appSupport)).filter(f => f.startsWith('draft-')) : [];
    assert.equal(leftovers.length, 0, 'draft scripts cleaned up in the isolated home');
});

test('missing runtime/helper → honest error, no dev fallback (packaged-machine model)', async () => {
    const home = isolatedHome('missing-helper');
    process.resourcesPath = '/nonexistent-staged-Resources';
    process.env.HOME = home;
    process.env.VSRES_PACKAGED_SIM = '1';   // model a packaged machine: no checkout candidate
    // Sibling suites' fixture env must not leak under --test-isolation=none.
    const savedSeam = process.env.VSRES_SAMPLE_PYTHON;
    const savedNRW = process.env.VSRES_NO_RENDER_WORKER;
    delete process.env.VSRES_NO_RENDER_WORKER;
    delete process.env.VSRES_SAMPLE_PYTHON;
    delete process.env.VAPOURSYNTH_EXTRA_PLUGIN_PATH;
    // VSRES_DEV_PYTHON unset and resourcesPath bogus: findPython must fail
    // honestly BEFORE any script resolution attempt, or the render fails
    // with an honest error naming the problem — never a silent dev path.
    delete require.cache[require.resolve('./preview-companion')];
    const { renderPreviewFrame } = require('./preview-companion');
    const result = await renderPreviewFrame({
        draftScript: 'import vapoursynth as vs',
    });
    process.env.HOME = os.homedir();
    delete process.env.VSRES_PACKAGED_SIM;
    if (savedSeam !== undefined) process.env.VSRES_SAMPLE_PYTHON = savedSeam;
    if (savedNRW !== undefined) process.env.VSRES_NO_RENDER_WORKER = savedNRW;
    assert.equal(result.ok, false);
    assert.match(result.error, /launch mode: packaged \(simulated\)/, 'launch mode reported');
    assert.ok((result.error || '').length > 10, 'honest error message');
    assert.ok(!String(result.error).includes('homebrew'), 'never a dev-machine path in the error');
});
test.after(() => { try { disposeAllWorkers(); } catch { /* best effort */ } });
