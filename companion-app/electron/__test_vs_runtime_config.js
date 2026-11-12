// vs-runtime-config.js — hermetic VSScript TOML generation. Pure filesystem
// against synthetic bundles in temp dirs; no real bundle, no binaries.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ensureVapourSynthConfig, bundleRuntimePaths } = require('./vs-runtime-config');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'vsres-vsrc-')); }

function fakeBundle(root) {
    const b = path.join(root, 'VapourSynth.ofx.bundle');
    const p = bundleRuntimePaths(b);
    for (const key of ['vsscript', 'pythonExe', 'pythonLib']) {
        fs.mkdirSync(path.dirname(p[key]), { recursive: true });
        fs.writeFileSync(p[key], 'x');
    }
    return b;
}

test('writes the TOML keyed by the bundle libvsscript, mtime-bound and quoted', () => {
    const dir = tmpDir();
    const bundle = fakeBundle(dir);
    const configHome = path.join(dir, 'xdg');
    const r = ensureVapourSynthConfig({ bundlePath: bundle, configHome });
    assert.equal(r.ok, true);
    assert.equal(r.written, true);
    const text = fs.readFileSync(r.path, 'utf8');
    const p = bundleRuntimePaths(bundle);
    assert.ok(text.startsWith(`"${p.vsscript}" = [`));
    assert.ok(text.includes(`"${p.pythonExe}"`));
    assert.ok(text.includes(`"${p.pythonLib}"`));
    const mtime = Math.floor(fs.statSync(p.pythonExe).mtimeMs / 1000);
    assert.ok(text.trimEnd().endsWith(`"${mtime}"]`));
    // 0700 dir, 0600 file
    assert.equal(fs.statSync(path.dirname(r.path)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(r.path).mode & 0o777, 0o600);
});

test('idempotent: identical content is not rewritten; a new mtime rewrites', () => {
    const dir = tmpDir();
    const bundle = fakeBundle(dir);
    const configHome = path.join(dir, 'xdg');
    const first = ensureVapourSynthConfig({ bundlePath: bundle, configHome });
    assert.equal(first.written, true);
    const second = ensureVapourSynthConfig({ bundlePath: bundle, configHome });
    assert.equal(second.written, false);   // no churn
    const p = bundleRuntimePaths(bundle);
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(p.pythonExe, later, later); // simulates a re-staged bundle
    const third = ensureVapourSynthConfig({ bundlePath: bundle, configHome });
    assert.equal(third.written, true);     // stale mtime → regenerated
    const mtime = Math.floor(fs.statSync(p.pythonExe).mtimeMs / 1000);
    assert.ok(fs.readFileSync(third.path, 'utf8').includes(`"${mtime}"]`));
});

test('refusals: missing bundle parts and missing bundlePath', () => {
    const dir = tmpDir();
    const configHome = path.join(dir, 'xdg');
    assert.equal(ensureVapourSynthConfig({}).ok, false);
    assert.equal(ensureVapourSynthConfig({ bundlePath: '/nope/ofx.bundle', configHome }).ok, false);
    const partial = path.join(dir, 'partial.ofx.bundle');
    fs.mkdirSync(path.join(partial, 'Contents', 'Resources', 'vs-python', 'vapoursynth'), { recursive: true });
    fs.writeFileSync(path.join(partial, 'Contents', 'Resources', 'vs-python', 'vapoursynth', 'libvsscript.dylib'), 'x');
    assert.equal(ensureVapourSynthConfig({ bundlePath: partial, configHome }).ok, false);
});
