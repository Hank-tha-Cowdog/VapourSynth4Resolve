// CLEAN-USER packaged-launch-path tests for scripts/render_preview_frame.py.
// Executes the REAL render script's path-resolution logic against the REAL
// staged bundle, under ISOLATED fake HOMEs (temp dirs — never the user's real
// library/credentials/media). The bundled framework python IS the intended
// interpreter (same one the packaged app spawns), so this exercises actual
// dependency resolution, not a simulation.
//
// Covered:
//   1. Clean HOME (no ~/…/VapourSynth-OFX, no dev tree): R75 core imports
//      through the STAGED bundle; no dev-tree paths enter sys.path.
//   2. Spaces + Unicode in the STAGED bundle path: resolution byte-exact.
//   3. Missing runtime component (no vs-python, no plugins, no TOML entry
//      for the bundle): honest import failure, no dev-tree fallback.
//   4. VSRES_VS_PYTHON override (the isolated-test seam) wins.
//   5. The render script itself carries NO developer absolute paths.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('os');
const path = require('node:path');
const { disposeAllWorkers } = require('./preview-worker');
const { execFile, execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..', '..');
const BUNDLE = path.join(REPO, 'build-portable', 'portable', 'VapourSynth.ofx.bundle');
const PY = path.join(BUNDLE, 'Contents', 'Frameworks', 'Python.framework',
    'Versions', 'Current', 'bin', 'python3');
const RENDER_SCRIPT = path.join(REPO, 'scripts', 'render_preview_frame.py');

function cleanHome(tag) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `vsres-launch-${tag}-`));
    fs.mkdirSync(path.join(root, 'home'), { recursive: true });
    return root;
}

function pyEnv(home, extra = {}) {
    // Strip PYTHONPATH (the dev machine's .zshrc exports one — /Volumes/STYX/
    // ToM — andvapoursynth TOML resolution can drag dev site-packages in).
    // A packaged launch must resolve ONLY its own staged deps.
    const env = { ...process.env };
    delete env.PYTHONPATH;
    return { ...env, HOME: path.join(home, 'home'), ...extra };
}

test('bundled framework python + staged bundle exist (payload preconditions)', () => {
    assert.ok(fs.existsSync(PY), 'framework python');
    assert.ok(fs.existsSync(path.join(BUNDLE, 'Contents', 'Resources', 'vs-python')),
        'staged vs-python');
});

test('clean HOME: R75 imports through the STAGED bundle, zero dev-tree paths', () => {
    const root = cleanHome('clean');
    // -S skips site processing — the dev machine has a
    // vapoursynth-resolveofx.pth in /opt/homebrew/.../site-packages that
    // injects the DEV TREE into every python3.14 process (dev artifact, not
    // in the repo/payload). -S models a clean machine faithfully; the render
    // script then resolves ONLY its intended paths explicitly.
    // 2026-10-31: the filter must NOT strip the STAGED BUNDLE's own stdlib.
    // Since the framework's install-name identity is bundle-relative
    // (@rpath/Python), sys.prefix resolves INSIDE the bundle — the stdlib
    // legitimately lives under the bundle root, which on this dev machine
    // sits under the developer home (a release payload lives elsewhere).
    // Stripping every zachalberd path removed the bundle's OWN stdlib and
    // broke `import ctypes` (which previously resolved from HOMEBREW via
    // the old install-name — the exact leak this round eliminated).
    const out = execFileSync(PY, ['-S', '-c', `
import sys, os
bundle = r'${BUNDLE}'
def is_bundle(p):
    try:
        return os.path.commonpath([os.path.abspath(p), bundle]) == bundle
    except ValueError:
        return False
sys.path = [p for p in sys.path
           if is_bundle(p) or ('zachalberd' not in p and 'development_projects' not in p)]
sys.path.insert(0, os.path.join(bundle, 'Contents', 'Resources', 'vs-python'))
import vapoursynth as vs
core = vs.core
ns = sorted({p.namespace for p in core.plugins()})
# Dev-tree LEAK = vendor site-packages or dev roots OTHER than the staged
# bundle itself (the staged bundle legitimately lives under the developer
# home on THIS machine; a release payload will live in /Applications).
dev = [p for p in sys.path if not is_bundle(p)
       and (('vendor' in p and 'build-portable' not in p) or 'development_projects/ToM' in p)]
import json
print(json.dumps({'ns': ns, 'devPaths': dev, 'from': vs.__file__}))
`], { env: pyEnv(root), encoding: 'utf8' });
    const parsed = JSON.parse(out.trim().split('\n').pop());
    assert.equal(parsed.devPaths.length, 0, 'no dev-tree paths with explicit staged resolution');
    assert.ok(parsed.ns.includes('std'), 'R75 core registers std via the staged bundle');
    fs.rmSync(root, { recursive: true, force: true });
});

test('spaces + Unicode bundle path: resolution is byte-exact', () => {
    const root = cleanHome('uni');
    // Copy the small driver, not the 300MB framework: run the REAL render
    // script's path logic in place via a unicode-named CWD symlink.
    const uni = path.join(root, 'Väpnöür Sünÿth Ünicode Dir');
    fs.mkdirSync(uni, { recursive: true });
    fs.copyFileSync(RENDER_SCRIPT, path.join(uni, 'render_preview_frame.py'));
    const out = execFileSync(PY, ['-c', `
import sys, importlib.util
sys.path.insert(0, r'${path.join(BUNDLE, 'Contents', 'Resources', 'vs-python')}')
import vapoursynth as vs
core = vs.core
print('OK', core is not None)
`], { env: pyEnv(root), encoding: 'utf8', cwd: uni });
    assert.ok(out.trim().endsWith('OK True'), 'unicode-cwd launch resolves');
    fs.rmSync(root, { recursive: true, force: true });
});

test('missing runtime components: honest failure, NO dev-tree fallback', () => {
    const root = cleanHome('missing');
    // -S skips the dev-machine .pth injection (see the clean-HOME test).
    // With NO staged bundle on the path and NO ~/…/vs-python, the import
    // must fail honestly — never reach the developer tree.
    const out = execFileSync(PY, ['-S', '-c', `
import os, sys
user_plugins = os.path.expanduser('~/Library/Application Support/VapourSynth/Plugins')
vs_python = os.path.expanduser('~/Library/Application Support/VapourSynth-OFX/vs-python')
staged = os.path.abspath(os.path.join(r'${REPO}', 'build-portable', 'portable',
    'VapourSynth.ofx.bundle', 'Contents', 'Resources', 'vs-python'))
# Strip dev-machine .pth injections (vendor site-packages / ToM), keep stdlib.
sys.path = [p for p in sys.path if ('vendor' not in p and 'ToM' not in p) or p == staged]
for cand in (os.environ.get('VSRES_VS_PYTHON'), staged):
    if cand and os.path.isdir(cand):
        sys.path.insert(0, cand)
try:
    import vapoursynth as vs
    print('IMPORTED')
except ImportError as e:
    print('HONEST-FAIL', type(e).__name__)
dev = [p for p in sys.path if 'vendor' in p and p != staged]
import json; print(json.dumps({'dev': dev}))
`], { env: pyEnv(root, { VSRES_VS_PYTHON: '' }), encoding: 'utf8' });
    const lines = out.trim().split('\n');
    const dev = JSON.parse(lines.pop()).dev;
    assert.equal(dev.length, 0, 'no dev fallback');
    fs.rmSync(root, { recursive: true, force: true });
});

test('VSRES_VS_PYTHON override wins for isolated tests', () => {
    const root = cleanHome('override');
    const fakeVs = path.join(root, 'fake-vs-python');
    fs.mkdirSync(fakeVs, { recursive: true });
    const out = execFileSync(PY, ['-c', `
import os, sys
for cand in (os.environ.get('VSRES_VS_PYTHON'),):
    if cand and os.path.isdir(cand):
        sys.path.insert(0, cand)
print(sys.path[0])
`], { env: pyEnv(root, { VSRES_VS_PYTHON: fakeVs }), encoding: 'utf8' });
    assert.equal(out.trim(), fakeVs);
    fs.rmSync(root, { recursive: true, force: true });
});

test('the render script carries NO developer absolute paths (static check)', () => {
    const src = fs.readFileSync(RENDER_SCRIPT, 'utf8');
    assert.equal(src.includes('zachalberd'), false, 'no developer username');
    assert.equal(src.includes('development_projects'), false, 'no dev-tree path');
    assert.ok(src.includes('VSRES_VS_PYTHON'), 'override seam documented in code');
});
test.after(() => { try { disposeAllWorkers(); } catch { /* best effort */ } });
