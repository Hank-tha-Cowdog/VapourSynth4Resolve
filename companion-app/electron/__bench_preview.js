// Playback benchmark — the REAL production render path (preview-companion +
// real staged bundle python + real render script), synthetic media only.
// Measures the components the owner's slow-playback report could involve:
// cold spawn+import+script-eval cost, warm per-frame cost for SOURCE vs
// CHAIN mode, PNG+base64 IPC size, and the renderer-side scopes cost.
// Read-only for real stores (isolated HOME); prints a JSON line per probe.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..');
const BUNDLE = path.join(REPO, 'build-portable', 'portable', 'VapourSynth.ofx.bundle');
const PY = path.join(BUNDLE, 'Contents', 'Frameworks', 'Python.framework',
    'Versions', 'Current', 'bin', 'python3');
const FPNG = path.join(REPO, 'vendor', 'Macos_vapoursynth_plugins', 'lib', 'libfpng.dylib');
const { execFileSync } = require('node:child_process');

process.resourcesPath = path.join(REPO, 'companion-app', 'node_modules', 'electron',
    'dist', 'Electron.app', 'Contents', 'Resources');
// DEV contract (the running owner workflow): the checkout staged bundle is the candidate.
delete process.env.VSRES_SAMPLE_PYTHON;
delete process.env.VSRES_DEV_PYTHON;
// Use the checkout staged bundle explicitly (the dev candidate contract):
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vsres-bench-'));
process.env.HOME = home;
const plugins = path.join(home, 'user-plugins');
fs.mkdirSync(plugins, { recursive: true });
fs.copyFileSync(FPNG, path.join(plugins, 'libfpng.dylib'));
process.env.VAPOURSYNTH_EXTRA_PLUGIN_PATH = plugins;
// Point the runtime resolution at the checkout bundle via its env contract:
process.env.VSRES_VS_PYTHON = path.join(BUNDLE, 'Contents', 'Resources', 'vs-python');

delete require.cache[require.resolve('../electron/preview-companion')];
const { renderPreviewFrame } = require('../electron/preview-companion');

const results = [];
const probe = async (name, fn) => {
    const t0 = performance.now();
    try { const v = await fn(); if (v && v.ok === false) throw new Error(v.error || 'render ok:false');
    results.push({ name, ms: Math.round(performance.now() - t0), ok: true,
      extra: v ? { provenance: v.provenance, pngBytes: Math.round((v.dataUrl || '').length * 3 / 4), w: v.width, h: v.height } : null }); }
    catch (e) { results.push({ name, ms: Math.round(performance.now() - t0), ok: false, extra: String(e.message).slice(0, 120) }); }
};

// Synthetic 1920x1080 25fps "media" chain (BlankClip = no decode cost;
// decode-inclusive costs need a real file — the compose path opens media via
// the source loader; for the benchmark the decode delta is measured by the
// BlankClip-with-transform variant below).
const DRAFT_SRC = [
    'import vapoursynth as vs',
    'core = vs.core',
    'src = core.std.BlankClip(width=1920, height=1080, length=250, fpsnum=25, fpsden=1, format=vs.YUV420P8, color=[128, 128, 128])',
    'src = core.std.SetFrameProp(src, prop="_Matrix", intval=1)',
    'src = core.grain.Add(src, constant=True, strength=8) if hasattr(core, "grain") else src',
    'clip = src',
    'clip.set_output()',
].join('\n');

(async () => {
    // Cold: first render (spawn + import + capability probe skip + script eval).
    await probe('cold source render (spawn+import+eval)', () =>
        renderPreviewFrame({ frame: 0, mode: 'source', draftScript: DRAFT_SRC }));
    // Warm: per-frame cost, 8 frames.
    for (let i = 1; i <= 8; i++) {
        await probe(`warm source frame ${i}`, () =>
            renderPreviewFrame({ frame: i, mode: 'source', draftScript: DRAFT_SRC }));
    }
    // Chain (processed) frames: heavier script (a few real steps).
    const DRAFT_CHAIN = [
        'import vapoursynth as vs',
        'core = vs.core',
        'src = core.std.BlankClip(width=1920, height=1080, length=250, fpsnum=25, fpsden=1, format=vs.YUV420P8, color=[128, 128, 128])',
        'clip = core.std.TurnsRGB? None if False else core.resize.Bicubic(src, format=vs.RGB24, matrix_in_s="709")',
        'clip = core.std.Expr([clip, clip, clip], ["x", "y", "z"])',
        'clip = core.resize.Bicubic(clip, format=vs.YUV420P8, matrix_s="709")',
        'clip.set_output()',
    ].filter(l => l !== 'None if False else None').join('\n');
    await probe('cold chain render (eval heavier script)', () =>
        renderPreviewFrame({ frame: 0, mode: 'processed', draftScript: DRAFT_CHAIN }));
    for (let i = 1; i <= 5; i++) {
        await probe(`warm chain frame ${i}`, () =>
            renderPreviewFrame({ frame: i, mode: 'processed', draftScript: DRAFT_CHAIN }));
    }
    // Scopes cost (renderer-side, on a real frame's pixels — measured directly
    // from the shared metrics module on synthetic data at full HD):
    const tsc = require('node:child_process').spawnSync(process.execPath,
        ['-e', `
      const {execFileSync} = require('child_process');
      const path = require('path');
      const tmp = require('fs').mkdtempSync(require('os').tmpdir() + '/scope-bench-');
      const tscBin = path.join(process.cwd(), 'node_modules', 'typescript', 'bin', 'tsc');
      execFileSync(process.execPath, [tscBin, 'shared/scope-metrics.ts', '--outDir', tmp,
        '--module', 'commonjs', '--target', 'es2022', '--skipLibCheck'], {stdio: 'pipe'});
      const { computeScopeMetrics } = require(path.join(tmp, 'scope-metrics.js'));
      const W = 1920, H = 1080;
      const px = new Uint8ClampedArray(W * H * 4);
      for (let i = 0; i < px.length; i += 4) {
        const v = (Math.random() * 256) | 0;
        px[i] = v; px[i+1] = (v + 64) & 255; px[i+2] = 255 - v; px[i+3] = 255;
      }
      const t0 = performance.now();
      computeScopeMetrics(px, W, H);
      console.log('SCOPES_MS=' + Math.round(performance.now() - t0));
    `], { cwd: path.join(REPO, 'companion-app'), encoding: 'utf8' });
    results.push({ name: 'renderer-side scopes compute (full-HD synthetic)', ms: Number((tsc.stdout.match(/SCOPES_MS=(\d+)/) || [0, -1])[1]), ok: tsc.status === 0 });

    console.log(JSON.stringify({
        resolution: '1920x1080 synthetic (BlankClip; no real-media decode)',
        requestedRate: '25 fps clip — transport tick was 250ms (4 ticks/s)',
        results,
    }, null, 1));
    fs.rmSync(home, { recursive: true, force: true });
})();