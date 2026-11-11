// Fixture-isolation canaries — the 2026-10-31 viewer-journey leak, closed and
// PROVEN from three directions, without Electron, without contacting the
// machine's running Resolve, and without opening any real media.
//
// Root cause being guarded: the renderer's mount-time auto-discovery
// (App.tsx) live-queries the MACHINE'S Resolve via resolve-api and ADOPTS the
// playhead clip over a test fixture (filePath + trim handles) — a channel
// that ignores HOME/userData isolation entirely. Layers proven here:
//   L1  VSRES_DISABLE_RESOLVE_DISCOVERY — the disabled session resolves
//       honestly and NEVER spawns the Resolve query helper.
//   L2  VSRES_ALLOWED_SOURCE_ROOTS — renderPreviewFrame refuses a draft that
//       binds a canary path outside the roots BEFORE any python runs (a
//       recording sample-python proves zero renderer executions).
//   L3  the same refusal on the file-based (host node) branch.
//   Positive control — a fixture-rooted draft PASSES the guard and the
//       renderer python IS invoked: the guard never eats legitimate renders.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { renderPreviewFrame, _forTest } = require('./preview-companion');
const { allowedSourceRoots, pathsOutsideAllowedRoots } = _forTest;

const TMP_ROOTS = [];
test.after(() => {
    for (const d of TMP_ROOTS) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});
const newTemp = (label) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), `vsres-isocanary-${label}-`));
    TMP_ROOTS.push(d);
    return d;
};

// Per-test environment ownership (harness rule): the merged root suite shares
// one process, so every env write here is saved and restored by the caller.
function withEnv(overrides, body) {
    const keys = Object.keys(overrides);
    const saved = {};
    for (const k of keys) { saved[k] = process.env[k]; }
    for (const k of keys) {
        if (overrides[k] === undefined) delete process.env[k];
        else process.env[k] = overrides[k];
    }
    return Promise.resolve(body()).finally(() => {
        for (const k of keys) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
    });
}

// A "python" that only records that it was executed (argv appended to a log)
// and exits 1. If the isolation guard works, this file is NEVER spawned for
// refused renders; for the positive control it IS — proving the guard is the
// only thing standing between a leaked path and a real render.
function makeRecorderPython(dir) {
    const log = path.join(dir, 'python-spawned.log');
    const script = path.join(dir, 'canary-python.sh');
    fs.writeFileSync(script, `#!/bin/sh\necho "$@" >> ${JSON.stringify(log)}\nexit 1\n`);
    fs.chmodSync(script, 0o755);
    return { script, log };
}

test('guard scanner: quoted absolute paths are checked against the allowed roots', () => {
    const fx = '/vsres-fixture-tree';
    // The exact leak shape: a draft binding a media path outside the roots.
    const leaky = "src = core.lsmas.LWLibavSource(r'/Volumes/TEST_MEDIA/real/tape.mov')\nclip = src\nclip.set_output()\n";
    assert.deepEqual(pathsOutsideAllowedRoots(leaky, [fx]),
        ['/Volumes/TEST_MEDIA/real/tape.mov']);
    // Fixture-rooted path passes.
    const clean = `src = core.lsmas.LWLibavSource(r'${fx}/anamorphic.mov')\nclip = src\nclip.set_output()\n`;
    assert.deepEqual(pathsOutsideAllowedRoots(clean, [fx]), []);
    // Double-quoted bindings are caught too.
    assert.deepEqual(pathsOutsideAllowedRoots('x("/outside/d.mov")', [fx]), ['/outside/d.mov']);
    // Prefix bleed: /fxEVIL must NOT be accepted as inside /fx.
    assert.deepEqual(pathsOutsideAllowedRoots(`x(r'${fx}EVIL/media.mov')`, [fx]), [`${fx}EVIL/media.mov`]);
    // Exact root match is allowed.
    assert.deepEqual(pathsOutsideAllowedRoots(`x(r'${fx}')`, [fx]), []);
    // The composed-draft helper literal (~/...) is exempt BY DESIGN: it
    // expands under the session HOME (inside an isolated tree) and VapourSynth
    // sources cannot open an unexpanded ~ path anyway.
    const helperLine = "os.path.expanduser('~/Library/Application Support/VapourSynth-OFX/vs-python')";
    assert.deepEqual(pathsOutsideAllowedRoots(helperLine, [fx]), []);
    // Set-but-empty root list refuses EVERY absolute path (strictest posture).
    const anyAbs = "x(r'/anything.mov')";
    assert.deepEqual(pathsOutsideAllowedRoots(anyAbs, []), ['/anything.mov']);
    // RELATIVE traversal (2026-10-31 audit): a relative-with-slash binding
    // resolves against the process CWD — outside any root — and is refused.
    assert.deepEqual(pathsOutsideAllowedRoots("x(r'../../owner/canary.mov')", [fx]), ['../../owner/canary.mov']);
    assert.deepEqual(pathsOutsideAllowedRoots("x('sub/dir/canary.mov')", [fx]), ['sub/dir/canary.mov']);
    // Bare relative name with NO slash: cannot traverse; not flagged (the
    // open fails against the companion CWD on its own) — documented posture.
    assert.deepEqual(pathsOutsideAllowedRoots("x('media.mov')", [fx]), []);
    // Unicode: byte-exact matching; an outside path with non-ASCII is
    // refused exactly like ASCII.
    assert.deepEqual(pathsOutsideAllowedRoots("x(r'/média/ownér-canary.mov')", [fx]), ['/média/ownér-canary.mov']);
    assert.deepEqual(pathsOutsideAllowedRoots(`x(r'${fx}/média-fixture.mov')`, [fx]), []);
    // env parsing: unset → null (guard inert); set → split on the pathsep.
    return withEnv({ VSRES_ALLOWED_SOURCE_ROOTS: undefined }, () => {
        assert.equal(allowedSourceRoots(), null);
    }).then(() => withEnv({ VSRES_ALLOWED_SOURCE_ROOTS: `${fx}${path.delimiter}/Library/Application Support/VapourSynth-OFX` }, () => {
        assert.deepEqual(allowedSourceRoots(), [fx, '/Library/Application Support/VapourSynth-OFX']);
    }));
});

test('discovery seam: an isolated session never spawns the Resolve query helper', () => withEnv({ VSRES_DISABLE_RESOLVE_DISCOVERY: '1' }, async () => {
    // Fresh-require resolve-api with a spawn recorder installed BEFORE the
    // require, so the module's destructured spawn captures the recorder. The
    // disabled promise must resolve honestly with ZERO spawns — proving this
    // instance cannot read the machine's live Resolve (the exact channel that
    // adopted the owner's clip over the journey fixture).
    const cp = require('child_process');
    const realSpawn = cp.spawn;
    let spawns = 0;
    cp.spawn = function recordedSpawn(...args) {
        spawns++;
        return realSpawn.apply(this, args);
    };
    try {
        delete require.cache[require.resolve('./resolve-api')];
        const api = require('./resolve-api');
        const result = await api.queryCurrentClip();
        assert.equal(result.ok, false);
        assert.equal(result.scriptingUnavailable, true);
        assert.match(result.error, /isolated session/);
        assert.equal(spawns, 0, 'the query helper must never be spawned for an isolated session');
    } finally {
        cp.spawn = realSpawn;
        delete require.cache[require.resolve('./resolve-api')];
    }
}));

test('draft render: a canary path outside the roots is refused BEFORE any python runs', () => {
    const dir = newTemp('draft');
    const home = path.join(dir, 'home');
    const { script, log } = makeRecorderPython(dir);
    const roots = path.join(dir, 'fixture');
    return withEnv({
        HOME: home,
        VSRES_SAMPLE_PYTHON: script,       // trusted seam: any execution lands in the log
        VSRES_NO_RENDER_WORKER: '1',
        VSRES_ALLOWED_SOURCE_ROOTS: roots,
    }, async () => {
        const result = await renderPreviewFrame({
            frame: 0,
            draftScript: "src = core.lsmas.LWLibavSource(r'/definitely/outside/canary-owner-style.mov')\nclip = src\nclip.set_output()\n",
        });
        assert.equal(result.ok, false);
        assert.match(result.error, /outside the allowed fixture roots/);
        assert.match(result.error, /canary-owner-style\.mov/);
        assert.equal(fs.existsSync(log), false, 'no renderer python may run for a refused draft');
        // Fail-closed EARLY: not even the draft temp file is written.
        assert.equal(fs.existsSync(path.join(home, 'Library', 'Application Support', 'VapourSynth-OFX')), false,
            'the composed-script directory must not be created for a refused draft');
    });
});

test('host node render: a canary script outside the roots is refused BEFORE any python runs', () => {
    const dir = newTemp('host');
    const home = path.join(dir, 'home');
    const { script, log } = makeRecorderPython(dir);
    const roots = path.join(dir, 'fixture');
    const nodes = path.join(home, 'Library', 'Application Support', 'VapourSynth-OFX', 'nodes');
    fs.mkdirSync(nodes, { recursive: true });
    const guid = 'beef0000-1111-2222-3333-444444444444';
    fs.writeFileSync(path.join(nodes, `${guid}.vpy`),
        "src = core.lsmas.LWLibavSource(r'/outside/root/node-canary.mov')\nclip = src\nclip.set_output()\n");
    return withEnv({
        HOME: home,
        VSRES_SAMPLE_PYTHON: script,
        VSRES_NO_RENDER_WORKER: '1',
        VSRES_ALLOWED_SOURCE_ROOTS: roots,
    }, async () => {
        const result = await renderPreviewFrame({ frame: 0, nodeGuid: guid });
        assert.equal(result.ok, false);
        assert.match(result.error, /outside the allowed fixture roots/);
        assert.match(result.error, /node-canary\.mov/);
        assert.equal(fs.existsSync(log), false, 'no renderer python may run for a refused node script');
    });
});

test('positive control: a fixture-rooted draft passes the guard and reaches the renderer', () => {
    const dir = newTemp('positive');
    const home = path.join(dir, 'home');
    const { script, log } = makeRecorderPython(dir);
    const roots = path.join(dir, 'fixture');
    return withEnv({
        HOME: home,
        VSRES_SAMPLE_PYTHON: script,
        VSRES_NO_RENDER_WORKER: '1',
        VSRES_ALLOWED_SOURCE_ROOTS: roots,
    }, async () => {
        const result = await renderPreviewFrame({
            frame: 0,
            draftScript: `src = core.lsmas.LWLibavSource(r'${roots}/anamorphic.mov')\nclip = src\nclip.set_output()\n`,
        });
        // The recorder python ran and failed honestly (exit 1) — the guard let
        // the fixture-rooted draft through and the failure is the python's,
        // NOT a refusal.
        assert.equal(result.ok, false);
        assert.doesNotMatch(result.error, /allowed fixture roots/,
            'a fixture-rooted draft must never be refused');
        assert.equal(fs.existsSync(log), true, 'the renderer python must actually be invoked');
        assert.match(fs.readFileSync(log, 'utf8'), /--script/, 'the recorder saw a render invocation');
    });
});

test('symlink escape: a link INSIDE the roots that points OUTSIDE is refused (realpath check)', () => {
    const dir = newTemp('symlink');
    const home = path.join(dir, 'home');
    const { script, log } = makeRecorderPython(dir);
    const fixture = path.join(dir, 'fixture');
    const ownerSide = path.join(dir, 'owner-side');   // OUTSIDE the roots
    fs.mkdirSync(fixture, { recursive: true });
    fs.mkdirSync(ownerSide, { recursive: true });
    fs.writeFileSync(path.join(ownerSide, 'owner-canary.mov'), 'synthetic');
    // The planted link lives INSIDE the fixture tree but resolves outside it.
    fs.symlinkSync(path.join(ownerSide, 'owner-canary.mov'), path.join(fixture, 'link.mov'));
    return withEnv({
        HOME: home,
        VSRES_SAMPLE_PYTHON: script,
        VSRES_NO_RENDER_WORKER: '1',
        VSRES_ALLOWED_SOURCE_ROOTS: fixture,
    }, async () => {
        const result = await renderPreviewFrame({
            frame: 0,
            draftScript: `src = core.lsmas.LWLibavSource(r'${fixture}/link.mov')\nclip = src\nclip.set_output()\n`,
        });
        // Lexically inside the roots, but realpath resolves to the owner-side
        // file — the exact symlink-escape the 2026-10-31 audit closed.
        assert.equal(result.ok, false);
        assert.match(result.error, /outside the allowed fixture roots/);
        assert.match(result.error, /link\.mov/);
        assert.equal(fs.existsSync(log), false, 'no renderer python may run for a refused draft');
    });
});
