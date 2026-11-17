// Regression guard for the seal-breaking bytecode bug (field report
// 2026-11-17): the embedded Python wrote __pycache__ caches into its own
// signed Python.framework, invalidating the code-signing seal of the
// framework AND the companion app, which made the Install-for-Resolve trust
// gate refuse permanently. Fix = startup env guard (PYTHONDONTWRITEBYTECODE)
// + a signature-aware repair in the install flow that removes ONLY files
// codesign reports as unsealed additions and re-verifies before proceeding
// (strict verification itself is unchanged, fail-closed preserved). This test
// locks in: the pure helpers, the main.js wiring, and (when a built app is
// present) the live behaviour of the embedded python under both environments,
// including a real codesign round-trip of the repair.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const {
  applyPythonNoCacheEnv, sweepBundleBytecode,
  parseCodesignBytecodeAdditions, repairUnsealedBytecode,
} = require('./py-runtime-env');

function makeTempTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vsres-pycache-test-'));
  const fw = path.join(root, 'Contents/Frameworks/Python.framework/Versions/3.14/lib/python3.14');
  fs.mkdirSync(path.join(fw, 'encodings/__pycache__'), { recursive: true });
  fs.mkdirSync(path.join(fw, 'ctypes/__pycache__'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Contents/Resources/vs-python/__pycache__'), { recursive: true });
  fs.mkdirSync(path.join(fw, 'lib-dynload'), { recursive: true });
  fs.writeFileSync(path.join(fw, 'os.py'), '# keeper\n');
  fs.writeFileSync(path.join(fw, 'encodings/__pycache__/x.cpython-314.pyc'), 'cache');
  fs.writeFileSync(path.join(fw, 'ctypes/__pycache__/y.cpython-314.pyc'), 'cache');
  fs.writeFileSync(path.join(root, 'Contents/Resources/vs-python/__pycache__/z.pyc'), 'cache');
  fs.writeFileSync(path.join(fw, 'lib-dynload/_ctypes.cpython-314-darwin.so'), 'binary');
  // A directory that merely CONTAINS the word — must be preserved.
  fs.mkdirSync(path.join(root, '__pycache__-notes'), { recursive: true });
  fs.writeFileSync(path.join(root, '__pycache__-notes/keep.txt'), 'keep');
  return root;
}

const findPycacheDirs = root => {
  const found = [];
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const p = path.join(dir, e.name);
      if (e.name === '__pycache__') found.push(p);
      else walk(p);
    }
  };
  walk(root);
  return found.sort();
};

const rp = p => { try { return fs.realpathSync(p); } catch { return p; } };

const realVerifier = bundlePath => {
  const r = spawnSync('/usr/bin/codesign',
    ['--verify', '--deep', '--strict', '--verbose=4', bundlePath], { encoding: 'utf8', timeout: 300000 });
  return { ok: r.status === 0, output: `${r.stdout || ''}\n${r.stderr || ''}` };
};

test('applyPythonNoCacheEnv: sets guard vars, respects existing values, tolerates junk', () => {
  const env = {};
  applyPythonNoCacheEnv(env, '/tmp/cache-prefix');
  assert.equal(env.PYTHONDONTWRITEBYTECODE, '1');
  assert.equal(env.PYTHONPYCACHEPREFIX, '/tmp/cache-prefix');

  const preset = { PYTHONDONTWRITEBYTECODE: '0', PYTHONPYCACHEPREFIX: '/keep' };
  applyPythonNoCacheEnv(preset, '/tmp/other');
  assert.equal(preset.PYTHONDONTWRITEBYTECODE, '0', 'explicit values win');
  assert.equal(preset.PYTHONPYCACHEPREFIX, '/keep');

  const noPrefix = {};
  applyPythonNoCacheEnv(noPrefix);
  assert.equal(noPrefix.PYTHONDONTWRITEBYTECODE, '1');
  assert.equal(noPrefix.PYTHONPYCACHEPREFIX, undefined);

  assert.equal(applyPythonNoCacheEnv(null, '/x'), null);
  assert.equal(applyPythonNoCacheEnv('nope'), 'nope');
});

test('sweepBundleBytecode: removes only __pycache__ dirs, idempotent, non-throwing', () => {
  const root = makeTempTree();
  try {
    const before = findPycacheDirs(root);
    assert.equal(before.length, 3, 'fixture has three cache dirs');

    const first = sweepBundleBytecode(root);
    assert.equal(first.removed.length, 3);
    assert.deepEqual(first.errors, []);
    assert.deepEqual(findPycacheDirs(root), [], 'all caches removed');

    // Keepers intact: sources, extension modules, and lookalike names.
    assert.ok(fs.existsSync(path.join(root, 'Contents/Frameworks/Python.framework/Versions/3.14/lib/python3.14/os.py')));
    assert.ok(fs.existsSync(path.join(root, 'Contents/Frameworks/Python.framework/Versions/3.14/lib/python3.14/lib-dynload/_ctypes.cpython-314-darwin.so')));
    assert.ok(fs.existsSync(path.join(root, '__pycache__-notes/keep.txt')), 'lookalike dir preserved');

    const second = sweepBundleBytecode(root);
    assert.equal(second.removed.length, 0, 'idempotent');

    assert.deepEqual(sweepBundleBytecode('/no/such/path').removed, []);
    assert.deepEqual(sweepBundleBytecode('').removed, []);
    assert.deepEqual(sweepBundleBytecode(null).removed, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('parseCodesignBytecodeAdditions: only unsealed pycache additions under the root', () => {
  const root = '/bundle';
  const output = [
    'file added: /bundle/Contents/Frameworks/Python.framework/Versions/3.14/lib/python3.14/re/__pycache__/_parser.cpython-314.pyc',
    'file modified: /bundle/Contents/MacOS/evil',            // modified ≠ added: not our business
    'file added: /bundle/Contents/MacOS/payload.dylib',       // added but not bytecode: refused, never deleted
    'file added: /bundle/Contents/x/__pycache__/note.txt',    // right dir, not bytecode extension
    'file added: /elsewhere/__pycache__/outside.pyc',         // outside the root
    '/bundle: valid on disk',
  ].join('\n');
  const found = parseCodesignBytecodeAdditions(output, root);
  assert.deepEqual(found, [
    '/bundle/Contents/Frameworks/Python.framework/Versions/3.14/lib/python3.14/re/__pycache__/_parser.cpython-314.pyc',
  ]);
  assert.deepEqual(parseCodesignBytecodeAdditions('', root), []);
  assert.deepEqual(parseCodesignBytecodeAdditions(output, '/other'), []);
});

test('repairUnsealedBytecode: fail-closed, touches nothing but proven additions', () => {
  const root = makeTempTree();
  const stays = [];  // files that must never be deleted by the repair
  try {
    // 1. Already verifying → no action at all.
    let r = repairUnsealedBytecode(root, { runVerify: () => ({ ok: true, output: '' }) });
    assert.deepEqual(r, { ok: true, action: 'none', removed: [], output: '' });

    // 2. Additions only → removed, re-verify passes.
    const add1 = path.join(root, 'Contents/Frameworks/Python.framework/Versions/3.14/lib/python3.14/encodings/__pycache__/x.cpython-314.pyc');
    const add2 = path.join(root, 'Contents/Resources/vs-python/__pycache__/z.pyc');
    const addOut = `file added: ${add1}\nfile added: ${add2}\n`;
    const resolvedAdds = [rp(add1), rp(add2)];  // resolve while the files still exist
    r = repairUnsealedBytecode(root, { runVerify: () => ({ ok: false, output: addOut }) });
    assert.equal(r.ok, false, 're-verify still failing (fake verifier) → fail closed');
    assert.equal(r.action, 'removed');
    assert.deepEqual(r.removed.sort(), resolvedAdds.sort());
    assert.ok(!fs.existsSync(add1) && !fs.existsSync(add2), 'additions removed');

    // 3. New additions + a real residual failure → refuse, additions gone, keeper intact.
    fs.mkdirSync(path.dirname(add1), { recursive: true });
    fs.writeFileSync(add1, 'cache');
    const keeper = path.join(root, 'Contents/Frameworks/Python.framework/Versions/3.14/lib/python3.14/os.py');
    r = repairUnsealedBytecode(root, {
      runVerify: () => ({ ok: false, output: `file added: ${add1}\nfile modified: ${keeper}\n` }),
    });
    assert.equal(r.ok, false, 'residual failure → refuse');
    assert.equal(r.action, 'removed');
    assert.ok(!fs.existsSync(add1), 'bytecode addition removed');
    assert.ok(fs.existsSync(keeper), 'modified file (not an addition) never deleted');

    // 4. Failure with no bytecode additions → nothing touched, refuse.
    const modOut = `file modified: ${keeper}\n`;
    const before = fs.readFileSync(keeper, 'utf8');
    r = repairUnsealedBytecode(root, { runVerify: () => ({ ok: false, output: modOut }) });
    assert.equal(r.ok, false);
    assert.equal(r.action, 'none');
    assert.deepEqual(r.removed, []);
    assert.equal(fs.readFileSync(keeper, 'utf8'), before, 'nothing changed');

    // 5. No verifier supplied → refuse.
    r = repairUnsealedBytecode(root, {});
    assert.equal(r.ok, false);

    assert.deepEqual(stays, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('main.js wiring: startup guard + signature-aware repair stay present', () => {
  const src = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  assert.match(src, /applyPythonNoCacheEnv\(process\.env/, 'startup guard applied to process.env');
  assert.match(src, /repairUnsealedBytecode\(RUNTIMES\.ofxBundle\.path/, 'install flow repairs the source bundle');
  assert.match(src, /--verify', '--deep', '--strict', '--verbose=4'/, 'repair consults codesign with addition-reporting verbosity');
});

test('live: guard keeps the bundle clean, repair restores a broken seal (built app required)', { skip: !findFrameworkPython() }, t => {
  const python = findFrameworkPython();
  const framework = path.dirname(path.dirname(path.dirname(path.dirname(python)))); // .../Python.framework
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'vsres-live-pycache-'));
  const clone = path.join(scratch, 'Python.framework');
  const preexisting = findPycacheDirs(framework);
  if (preexisting.length) {
    t.skip(`source framework already carries ${preexisting.length} bytecode caches (dirty live install) — live check needs a pristine build`);
    fs.rmSync(scratch, { recursive: true, force: true });
    return;
  }
  try {
    execFileSync('cp', ['-cR', framework, clone]);

    const bare = { ...process.env };
    delete bare.PYTHONDONTWRITEBYTECODE;
    delete bare.PYTHONPYCACHEPREFIX;
    const run = env => spawnSync(path.join(clone, path.relative(framework, python)),
      ['-c', 'import ctypes, tomllib, pathlib, encodings'], { env, timeout: 60000 });

    // (a) Without the guard, caches ARE written (the mechanism behind the bug)
    // and the REAL codesign verification reports the bundle broken.
    const r1 = run(bare);
    assert.equal(r1.status, 0, `bare python failed: ${r1.stderr}`);
    assert.ok(findPycacheDirs(clone).length > 0, 'fixture must show the unguarded write');
    assert.equal(realVerifier(clone).ok, false, 'dirty bundle must fail real verification');

    // (a2) The signature-aware repair restores it: real codesign round-trip.
    const repaired = repairUnsealedBytecode(clone, { runVerify: realVerifier });
    assert.equal(repaired.action, 'removed');
    assert.ok(repaired.removed.length > 0, 'removed the unsealed caches');
    assert.equal(repaired.ok, true, `repair must restore the seal: ${repaired.output}`);
    assert.deepEqual(findPycacheDirs(clone), [], 'no caches left');
    assert.equal(realVerifier(clone).ok, true, 'bundle verifies clean after repair');

    // (a3) Negative: a genuinely modified (non-addition) file is refused, untouched.
    const victim = path.join(clone, 'Versions/3.14/lib/python3.14/os.py');
    const orig = fs.readFileSync(victim);
    fs.appendFileSync(victim, '\n# tampered\n');
    const tampered = fs.readFileSync(victim);
    const refused = repairUnsealedBytecode(clone, { runVerify: realVerifier });
    assert.equal(refused.ok, false, 'modified file → fail closed');
    assert.equal(refused.action, 'none');
    assert.deepEqual(fs.readFileSync(victim), tampered, 'tampered file untouched by the repair');
    fs.writeFileSync(victim, orig);

    // (b) Fresh clone: with the guard, nothing is written.
    fs.rmSync(clone, { recursive: true, force: true });
    execFileSync('cp', ['-cR', framework, clone]);
    const guarded = applyPythonNoCacheEnv({ ...process.env, PYTHONPYCACHEPREFIX: path.join(scratch, 'pyc') });
    const r2 = run(guarded);
    assert.equal(r2.status, 0, `guarded python failed: ${r2.stderr}`);
    assert.deepEqual(findPycacheDirs(clone), [], 'guard must prevent all bytecode writes into the bundle');
    assert.equal(realVerifier(clone).ok, true, 'bundle still verifies clean after a guarded run');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

function findFrameworkPython() {
  const candidates = [
    path.join(__dirname, '..', 'dist/mac-arm64/VapourSynth Companion.app/Contents/Resources/OFX/VapourSynth.ofx.bundle/Contents/Frameworks/Python.framework/Versions/3.14/bin/python3.14'),
    '/Applications/VapourSynth Companion.app/Contents/Resources/OFX/VapourSynth.ofx.bundle/Contents/Frameworks/Python.framework/Versions/3.14/bin/python3.14',
  ];
  for (const c of candidates) { if (fs.existsSync(c)) return c; }
  return null;
}
