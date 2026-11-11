// Python-discovery contract tests — executes the REAL findPython from
// preview-companion.js / neural-capability.js / vs-plugin-probe.js with an
// ISOLATED filesystem view (fs.existsSync stubbed per test; no real python
// is launched, no real paths are probed outside the fixtures).
//
// Covers the release-hardening requirement: packaged-app discovery must be
// dev-machine-assumption-free:
//   R1. PACKAGED mode prefers the embedded framework under process.resourcesPath.
//   R2. Homebrew/system fallbacks are DEV-GATED (VSRES_DEV_PYTHON) — a packaged
//       app NEVER silently falls back to a machine's local install.
//   R3. Missing embedded framework → null + an HONEST error, never a
//       silent fallback or a crash.
//   R4. Paths with spaces and Unicode resolve unchanged (no quoting/re-split).
//   R5. All three modules share the same discovery contract.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('vm');

// Load a module's findPython WITHOUT executing its side effects: evaluate the
// file in a context where require/fs/path/child_process are stubbed, then
// read the function from the transpiled source via its own reference.
function loadFindPython(rel) {
  const filename = path.join(__dirname, rel);
  const src = fs.readFileSync(filename, 'utf8');
  const fnMatch = src.match(/function findPython\(\) \{[\s\S]*?\n\}/);
  assert.ok(fnMatch, 'findPython exists in ' + rel);
  const moduleScope = { process: { env: {}, resourcesPath: undefined }, require: () => ({}), console };
  vm.runInNewContext('var process = this.process; var require = this.require; var console = this.console;\n' + fnMatch[0] + '\nthis.findPython = findPython;', moduleScope, { filename });
  return moduleScope.findPython;
}

function isolate({ env = {}, resourcesPath, exists }) {
  return {
    process: { env, resourcesPath },
    require: () => ({ spawn: () => { throw new Error('no spawn in discovery tests'); } }),
    console,
    __exists: exists,
  };
}

const FIXTURES = {
  embedded: '/Fixture App Resources/OFX/VapourSynth.ofx.bundle/Contents/Frameworks/Python.framework/Versions/Current/bin/python3',
  embeddedUnicode: '/VäpnöürSünÿth App/Resources/OFX/VapourSynth.ofx.bundle/Contents/Frameworks/Python.framework/Versions/Current/bin/python3',
  homebrew: '/opt/homebrew/opt/python@3.14/bin/python3.14',
  systemPy: '/usr/bin/python3',
};

function probe(rel, { env, resourcesPath, exists }) {
  const filename = path.join(__dirname, rel);
  const src = fs.readFileSync(filename, 'utf8');
  const fnMatch = src.match(/function findPython\(\) \{[\s\S]*?\n\}/);
  const ctx = {
    process: { env, resourcesPath },
    fs: { existsSync: (p) => exists(p) },
    path: path,
  };
  ctx.global = ctx;
  vm.runInNewContext('var process = this.process; var fs = this.fs; var path = this.path;\n' + fnMatch[0] + '\nthis.findPython = findPython;', ctx, { filename });
  return ctx.findPython;
}

const MODULES = [
  '../electron/neural-capability.js',
  '../electron/vs-plugin-probe.js',
];

// preview-companion's candidate builder is EXPORTED (_forTest.runtimeCandidates,
// ctx-injectable: isolated fs/env/resourcesPath/__dirname views). Exercise the
// REAL exported function — no source slicing, no bypass.
const pc = require('../electron/preview-companion');
function pcCandidates({ env = {}, resourcesPath, exists, dirname }) {
  return pc._forTest.runtimeCandidates({ env, resourcesPath, exists,
    dirname: dirname || '/Fake/companion-app/electron' });
}
function pcFirstPath(view) {
  for (const c of pcCandidates(view)) {
    if (c.path && view.exists(c.path) && !String(c.path).includes('app.asar')) return c.path;
  }
  return null;
}

const PC_FIXTURES = {
  embedded: '/Fixture App Resources/OFX/VapourSynth.ofx.bundle/Contents/Frameworks/Python.framework/Versions/Current/bin/python3',
  embeddedUnicode: '/VäpnöürSünÿth App/Resources/OFX/VapourSynth.ofx.bundle/Contents/Frameworks/Python.framework/Versions/Current/bin/python3',
  homebrew: '/opt/homebrew/opt/python@3.14/bin/python3.14',
  systemPy: '/usr/bin/python3',
  devCheckout: '/Fake/build-portable/portable/VapourSynth.ofx.bundle/Contents/Frameworks/Python.framework/Versions/Current/bin/python3',
};

test('../electron/preview-companion.js: packaged mode prefers the EMBEDDED framework (dev paths never first)', () => {
  const out = pcFirstPath({ env: {}, resourcesPath: '/Fixture App Resources',
    exists: (p) => p === PC_FIXTURES.embedded || p === PC_FIXTURES.homebrew || p === PC_FIXTURES.systemPy });
  assert.equal(out, PC_FIXTURES.embedded, 'embedded framework wins even when Homebrew exists');
});

test('../electron/preview-companion.js: NO Homebrew/system fallback without the explicit dev gate', () => {
  const out = pcFirstPath({ env: {}, resourcesPath: '/missing',
    exists: (p) => p === PC_FIXTURES.homebrew || p === PC_FIXTURES.systemPy });
  assert.equal(out, null, 'a packaged/misconfigured app must NOT borrow the machine python');
});

test('../electron/preview-companion.js: packaged-sim NEVER consults the dev checkout', () => {
  const out = pcFirstPath({ env: { VSRES_PACKAGED_SIM: '1' }, resourcesPath: '/missing',
    exists: (p) => p === PC_FIXTURES.devCheckout || p === PC_FIXTURES.homebrew });
  assert.equal(out, null, 'packaged mode has no dev-checkout or machine-python fallback');
  const src = fs.readFileSync(path.join(__dirname, '../electron/preview-companion.js'), 'utf8');
  assert.ok(src.includes("VSRES_PACKAGED_SIM !== '1'"), 'the exclusion is explicit in the selector');
});

test('../electron/preview-companion.js: DEV mode adds the checkout staged bundle (the 2026-10-29 live fix)', () => {
  const cands = pcCandidates({ env: {}, resourcesPath: '/missing',
    exists: () => true, dirname: '/Fake/companion-app/electron' });
  const kinds = cands.map(c => c.source);
  assert.deepEqual(kinds, ['packaged-bundle', 'dev-checkout-bundle'],
    "dev mode: packaged first, then the project's own staged bundle — never machine pythons");
  assert.equal(cands[1].vsPythonDir.endsWith('Resources/vs-python'), true,
    'the dev candidate carries the staged vs-python for clean imports');
});

test('../electron/preview-companion.js: dev fallback ONLY behind the explicit VSRES_DEV_PYTHON gate', () => {
  const out = pcFirstPath({ env: { VSRES_DEV_PYTHON: '1' }, resourcesPath: '/missing',
    exists: (p) => p === PC_FIXTURES.homebrew });
  assert.equal(out, PC_FIXTURES.homebrew, 'dev gate admits the dev fallback');
});

test('../electron/preview-companion.js: missing everything → null (caller surfaces the honest error)', () => {
  const out = pcFirstPath({ env: {}, resourcesPath: '/missing', exists: () => false });
  assert.equal(out, null);
});

test('../electron/preview-companion.js: spaces + Unicode paths resolve byte-exact (no re-splitting)', () => {
  const out = pcFirstPath({ env: {}, resourcesPath: '/VäpnöürSünÿth App/Resources',
    exists: (p) => p === PC_FIXTURES.embeddedUnicode });
  assert.equal(out, PC_FIXTURES.embeddedUnicode);
});

test('../electron/preview-companion.js: VSRES_SAMPLE_PYTHON test seam still wins for isolated fixtures', () => {
  const out = pcFirstPath({ env: { VSRES_SAMPLE_PYTHON: '/tmp/vsres-fixture python3' },
    resourcesPath: '/x',
    exists: (p) => p === '/tmp/vsres-fixture python3' || p === PC_FIXTURES.embedded });
  assert.equal(out, '/tmp/vsres-fixture python3');
});

for (const rel of MODULES) {
  test(`${rel}: packaged mode prefers the EMBEDDED framework (dev paths never first)`, () => {
    const out = probe(rel, {
      env: {},
      resourcesPath: '/Fixture App Resources',
      exists: (p) => p === FIXTURES.embedded || p === FIXTURES.homebrew || p === FIXTURES.systemPy,
    });
    assert.equal(out(), FIXTURES.embedded, 'embedded framework wins even when Homebrew exists');
  });

  test(`${rel}: NO Homebrew/system fallback without the explicit dev gate`, () => {
    const out = probe(rel, {
      env: {}, // no VSRES_DEV_PYTHON, no VSRES_SAMPLE_PYTHON
      resourcesPath: '/missing',
      exists: (p) => p === FIXTURES.homebrew || p === FIXTURES.systemPy,
    });
    assert.equal(out(), null, 'a packaged/misconfigured app must NOT borrow the machine python');
  });

  test(`${rel}: dev fallback ONLY behind the explicit VSRES_DEV_PYTHON gate`, () => {
    const out = probe(rel, {
      env: { VSRES_DEV_PYTHON: '1' },
      resourcesPath: '/missing',
      exists: (p) => p === FIXTURES.homebrew,
    });
    assert.equal(out(), FIXTURES.homebrew, 'dev gate admits the dev fallback');
  });

  test(`${rel}: missing everything → null (caller surfaces the honest error)`, () => {
    const out = probe(rel, { env: {}, resourcesPath: '/missing', exists: () => false });
    assert.equal(out(), null);
  });

  test(`${rel}: spaces + Unicode paths resolve byte-exact (no re-splitting)`, () => {
    const out = probe(rel, {
      env: {},
      resourcesPath: '/VäpnöürSünÿth App/Resources',
      exists: (p) => p === FIXTURES.embeddedUnicode,
    });
    assert.equal(out(), FIXTURES.embeddedUnicode);
  });

  test(`${rel}: VSRES_SAMPLE_PYTHON test seam still wins for isolated fixtures`, () => {
    const out = probe(rel, {
      env: { VSRES_SAMPLE_PYTHON: '/tmp/vsres-fixture python3' },
      resourcesPath: '/x',
      exists: (p) => p === '/tmp/vsres-fixture python3' || p === FIXTURES.embedded,
    });
    assert.equal(out(), '/tmp/vsres-fixture python3');
  });
}

// R3 evidence: the caller's honest failure message exists in the real source.
test('preview render path surfaces an honest no-python error (not a silent fallback)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../electron/preview-companion.js'), 'utf8');
  assert.ok(src.includes('No VapourSynth-capable python found for the preview renderer [launch mode:'),
    'the no-python error names the launch mode, build identity and every candidate');
  assert.ok(src.includes('reinstall the companion app'),
    'the packaged-mode hint is actionable');
});