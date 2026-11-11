// CST (Color Space Transform) qualification.
//
// 1. TABLE integrity: the TS gamut-pair table == tests/fixtures/cst_gamut_pairs.json
//    (the fixture was generated with the primaries→XYZ math VERIFIED against the
//    PUBLISHED BT.709/sRGB and BT.2020 RGB→XYZ matrices); pair round-trips ≈ I.
// 2. EMIT honesty: unsupported params are REJECTED with useful messages (never
//    silently Rec.709); identity stages skipped and labeled; policy documented.
// 3. REAL-RUNTIME qualification: the EMITTED script (the actual Python a chain
//    step carries) runs through the STAGED bundle python + real VapourSynth,
//    and sampled pixels are compared against expected values computed
//    INDEPENDENTLY in this test (published transfer/matrix constants via the
//    XYZ intermediate — NOT the TS pair table, NOT the emitted RPN).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..', '..');
const BUNDLE = path.join(REPO, 'build-portable', 'portable', 'VapourSynth.ofx.bundle');
const PY = path.join(BUNDLE, 'Contents', 'Frameworks', 'Python.framework',
    'Versions', 'Current', 'bin', 'python3');

// shared/cst-transform.ts is TypeScript — compile it (types stripped) with
// the devDependency tsc into a temp dir, same approach as __test_scope_metrics.
const tscBin = path.join(__dirname, '..', 'node_modules', 'typescript', 'bin', 'tsc');
const tsTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vsres-cst-ts-'));
spawnSync(process.execPath, [tscBin,
    path.join(__dirname, '..', 'shared', 'cst-transform.ts'),
    '--outDir', tsTmp, '--module', 'commonjs', '--target', 'es2022', '--skipLibCheck'],
    { stdio: 'pipe' });

const {
    emitCstBody, cstTemplateBody, CST_GAMUT_PAIRS, CST_GAMUTS, CST_DEFAULT_PARAMS,
} = require(path.join(tsTmp, 'cst-transform.js'));

// ── 1. Table integrity vs the fixture ──────────────────────────────────────
test('gamut table == verified fixture JSON (published-reference-checked)', () => {
    const fx = JSON.parse(fs.readFileSync(path.join(REPO, 'tests', 'fixtures', 'cst_gamut_pairs.json'), 'utf8'));
    const pairs = fx.pairs;
    assert.deepEqual(Object.keys(pairs).sort(), Object.keys(CST_GAMUT_PAIRS).sort(),
        'same pair keys');
    for (const k of Object.keys(pairs)) {
        assert.deepEqual(CST_GAMUT_PAIRS[k], pairs[k], `pair ${k} identical to fixture`);
    }
});

test('every gamut pair round-trips to identity (< 1e-4)', () => {
    const mul = (a, b) => a.map((r, i) => r.map((_, j) => a[i].reduce((s, v, k2) => s + v * b[k2][j], 0)));
    for (const src of CST_GAMUTS) {
        for (const dst of CST_GAMUTS) {
            if (src === dst) continue;
            const fwd = CST_GAMUT_PAIRS[`${src}>${dst}`];
            const back = CST_GAMUT_PAIRS[`${dst}>${src}`];
            const rt = mul(back, fwd);
            const err = Math.max(...rt.flatMap((r, i) => r.map((v, j) => Math.abs(v - (i === j ? 1 : 0)))));
            assert.ok(err < 1e-4, `${src}><${dst} round-trip err ${err}`);
            // White preservation: [1,1,1] maps to [1,1,1].
            const w = fwd.map(r => r.reduce((s, v) => s + v, 0));
            assert.ok(Math.max(...w.map(v => Math.abs(v - 1))) < 1e-4, `${src}>${dst} white`);
        }
    }
});

// ── 2. Emit honesty ─────────────────────────────────────────────────────────
test('template == default-params emit; deterministic', () => {
    assert.equal(cstTemplateBody(), emitCstBody({ ...CST_DEFAULT_PARAMS }));
    assert.equal(emitCstBody({ ...CST_DEFAULT_PARAMS }), emitCstBody({ ...CST_DEFAULT_PARAMS }));
});

test('unsupported params are REJECTED with useful messages (never silent defaults)', () => {
    const cases = [
        [{ ...CST_DEFAULT_PARAMS, inPrimaries: 'aces' }, /input primaries.*aces/s],
        [{ ...CST_DEFAULT_PARAMS, outPrimaries: 'xyz' }, /unsupported output primaries.*xyz/s],
        [{ ...CST_DEFAULT_PARAMS, inTransfer: 'gamma22' }, /unsupported input transfer/s],
        [{ ...CST_DEFAULT_PARAMS, outMatrix: 'auto' }, /output matrix.*auto/s],
        [{ ...CST_DEFAULT_PARAMS, outMatrix: 'ycgco' }, /unsupported output matrix.*ycgco/s],
        [{ ...CST_DEFAULT_PARAMS, rangePolicy: 'drop' }, /range policy/s],
    ];
    for (const [params, re] of cases) {
        assert.throws(() => emitCstBody(params), re, JSON.stringify(Object.keys(params)));
    }
});

test('identity stages skipped + labeled; explicit stages all present + labeled', () => {
    const sameGamutSameXfer = emitCstBody({ ...CST_DEFAULT_PARAMS });
    assert.match(sameGamutSameXfer, /primaries unchanged — no gamut matrix applied/);
    // 2026-11-05 (correctness review C02): the comment is now honest — curves are only
    // skipped when BOTH transfer and primaries are unchanged, and the claim
    // matches the emission exactly.
    assert.match(sameGamutSameXfer, /transfer and primaries unchanged — no transfer curves applied/);
    assert.doesNotMatch(sameGamutSameXfer, /ShufflePlanes/);
    assert.doesNotMatch(sameGamutSameXfer, /→ linear/, 'identity transform emits no curves');
    // Same transfer but a gamut CHANGE still requires the linear roundtrip.
    const sameXferGamutChange = emitCstBody({ ...CST_DEFAULT_PARAMS, outPrimaries: '2020' });
    assert.match(sameXferGamutChange, /decode\/gamut\/encode roundtrip/);
    assert.match(sameXferGamutChange, /→ linear/);

    const full = emitCstBody({ ...CST_DEFAULT_PARAMS, inPrimaries: '2020', outPrimaries: 'p3d65' });
    assert.match(full, /Gamut: Rec\.2020 → DCI-P3 \(D65\)/);
    assert.match(full, /ShufflePlanes/);
    assert.match(full, /MANUAL transform — no auto detection/);
    assert.match(full, /clamp samples to \[0,1\] BEFORE the transfer curves/);
    // C03: the clamp policy also applies AFTER the gamut matrix now.
    assert.match(full, /AND AFTER the gamut matrix/);
    // Out-of-range policy pass is labeled with its misbehavior warning.
    const passing = emitCstBody({ ...CST_DEFAULT_PARAMS, rangePolicy: 'pass' });
    assert.match(passing, /PASS through — transfer curve math is undefined outside \[0,1\]/);
});

// ── 3. Real-runtime qualification ──────────────────────────────────────────
// The emitted body runs inside the SAME preamble the draft composer emits;
// src is a synthetic clip with known values; expected values are computed
// HERE via the XYZ intermediate (independent of the pair table and RPN).
const PREAMBLE = `import vapoursynth as vs
core = vs.core
`;

// Independent reference math (pure python floats, published constants).
const REF = `
W_D65 = (0.3127, 0.3290)
GAM = {
 '709':  {'R': (0.640, 0.330), 'G': (0.300, 0.600), 'B': (0.150, 0.060)},
 '2020': {'R': (0.708, 0.292), 'G': (0.170, 0.797), 'B': (0.131, 0.046)},
 'p3d65':{'R': (0.680, 0.320), 'G': (0.265, 0.690), 'B': (0.150, 0.060)},
 '170m': {'R': (0.630, 0.340), 'G': (0.310, 0.595), 'B': (0.155, 0.070)},
}
def xyz(xy):
    x, y = xy
    return [x / y, 1.0, (1 - x - y) / y]
def mat_mul(a, b):
    return [[sum(a[i][k] * b[k][j] for k in range(3)) for j in range(3)] for i in range(3)]
def mat_vec(a, v):
    return [sum(a[i][k] * v[k] for k in range(3)) for i in range(3)]
def mat_inv_3x3(m):
    a = [row[:] + [1.0 if i == j else 0.0 for j in range(3)] for i, row in enumerate(m)]
    for col in range(3):
        piv = max(range(col, 3), key=lambda r: abs(a[r][col]))
        a[col], a[piv] = a[piv], a[col]
        inv = 1.0 / a[col][col]
        a[col] = [v * inv for v in a[col]]
        for r in range(3):
            if r != col and a[r][col] != 0.0:
                f = a[r][col]
                a[r] = [v - f * w for v, w in zip(a[r], a[col])]
    return [row[3:] for row in a]
def gamut_matrix(name):
    p = GAM[name]
    cols = [xyz(p['R']), xyz(p['G']), xyz(p['B'])]
    M = [[cols[c][i] for c in range(3)] for i in range(3)]
    s = mat_vec(mat_inv_3x3(M), xyz(W_D65))
    return [[cols[c][i] * s[c] for c in range(3)] for i in range(3)]
def gamut_pair(src, dst):
    return mat_mul(mat_inv_3x3(gamut_matrix(dst)), gamut_matrix(src))
def xf_1886_dec(v): return max(v, 0.0) ** 2.4
def xf_1886_enc(l): return max(l, 0.0) ** (1.0 / 2.4)
def xf_srgb_dec(v):
    v = max(v, 0.0)
    return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4
def xf_709_dec(v):
    v = max(v, 0.0)
    return v / 4.5 if v < 0.0812 else ((v + 0.099) / 1.099) ** (1.0 / 0.45)
`;

test('REAL runtime: emitted 709→2020 gamut matrix matches the independent XYZ reference (< 3e-4)', () => {
    const src = `src = core.std.BlankClip(width=32, height=8, length=2, fpsnum=25, fpsden=1, format=vs.RGBS, color=[0.9, 0.4, 0.2])
clip = src`;
    const params = { ...CST_DEFAULT_PARAMS, inPrimaries: '709', outPrimaries: '2020',
        inTransfer: 'linear', outTransfer: 'linear', outMatrix: 'rgb' };
    const probe = `import sys, json
f = clip.get_frame(0)
print(json.dumps([f[i][2, 2] for i in range(3)]))
`;
    const r = spawnSync(PY, ['-c', PREAMBLE + src + '\n' + emitCstBody(params) + '\n' + probe],
        { encoding: 'utf8', timeout: 60_000 });
    assert.equal(r.status, 0, 'runtime eval failed: ' + (r.stderr || '').slice(0, 300));
    const got = JSON.parse(r.stdout.trim().split('\n').pop());
    // Independent expected value — computed in THIS test's python (XYZ path).
    const ref = spawnSync(PY, ['-c', REF + `
import json
M = gamut_pair('709', '2020')
print(json.dumps([round(v, 6) for v in mat_vec(M, [0.9, 0.4, 0.2])]))
`], { encoding: 'utf8', timeout: 30_000 });
    const exp = JSON.parse(ref.stdout.trim().split('\n').pop());
    for (let i = 0; i < 3; i++) {
        assert.ok(Math.abs(got[i] - exp[i]) < 3e-4, `plane ${i}: got ${got[i]} expected ${exp[i]}`);
    }
});

test('REAL runtime: sRGB decode + BT.1886 encode compose correctly', () => {
    const src = `src = core.std.BlankClip(width=32, height=8, length=2, fpsnum=25, fpsden=1, format=vs.RGBS, color=[0.5, 0.5, 0.5])
clip = src`;
    const params = { ...CST_DEFAULT_PARAMS, inTransfer: 'srgb', outTransfer: '1886', outMatrix: 'rgb' };
    const probe = `import json
f = clip.get_frame(0)
print(json.dumps([f[i][2, 2] for i in range(3)]))
`;
    const r = spawnSync(PY, ['-c', PREAMBLE + src + '\n' + emitCstBody(params) + '\n' + probe],
        { encoding: 'utf8', timeout: 60_000 });
    assert.equal(r.status, 0, 'runtime eval failed: ' + (r.stderr || '').slice(0, 300));
    const got = JSON.parse(r.stdout.trim().split('\n').pop());
    const ref = spawnSync(PY, ['-c', REF + `
import json
lin = xf_srgb_dec(0.5)
out = xf_1886_enc(lin)
print(json.dumps([round(out, 6)]))
`], { encoding: 'utf8', timeout: 30_000 });
    const exp = JSON.parse(ref.stdout.trim().split('\n').pop())[0];
    for (let i = 0; i < 3; i++) {
        assert.ok(Math.abs(got[i] - exp) < 3e-4, `plane ${i}: got ${got[i]} expected ${exp}`);
    }
});

test('REAL runtime: YUV limited-range decode honors matrix/range; 170m vs 709 differ honestly', () => {
    // YUV limited 100/128/128: different matrices decode to DIFFERENT RGB —
    // the matrix control is real, not cosmetic.
    const src = `src = core.std.BlankClip(width=32, height=8, length=2, fpsnum=25, fpsden=1, format=vs.YUV420P16, color=[100*257, 128*257, 128*257])
clip = src`;
    const probe = `import json
f = clip.get_frame(0)
print(json.dumps([f[i][2, 2] for i in range(3)]))
`;
    const outs = {};
    for (const matrix of ['601', '709']) {
        const params = { ...CST_DEFAULT_PARAMS, inMatrix: matrix, inRange: 'limited',
            inTransfer: 'linear', outTransfer: 'linear', outMatrix: 'rgb' };
        const r = spawnSync(PY, ['-c', PREAMBLE + src + '\n' + emitCstBody(params) + '\n' + probe],
            { encoding: 'utf8', timeout: 60_000 });
        assert.equal(r.status, 0, `${matrix} eval failed: ` + (r.stderr || '').slice(0, 300));
        outs[matrix] = JSON.parse(r.stdout.trim().split('\n').pop());
    }
    assert.notDeepEqual(outs['601'], outs['709'], 'matrices must decode differently');
    // 170m decode of Y=100 limited: R = G = B = (100-16)/219 * ... computed:
    // limited Y → full: (100*257 - 16*257)/(219*257) → luma scalar ≈ 0.38356.
    const y709 = outs['709'][1];   // G ≈ decoded luma (U=V neutral)
    assert.ok(Math.abs(y709 - (100 - 16) / 219) < 3e-3, `709 luma decode ${y709} vs ${(100 - 16) / 219}`);
    void outs;
});

test('REAL runtime: full pipeline (YUV 420P16 limited → 2020 gamut → PQ → YUV444 full) evaluates', () => {
    const src = `src = core.std.BlankClip(width=32, height=24, length=2, fpsnum=25, fpsden=1, format=vs.YUV420P16, color=[20000, 32768, 32768])
clip = src`;
    const params = {
        ...CST_DEFAULT_PARAMS, inPrimaries: '2020', inTransfer: '1886',
        inMatrix: '2020ncl', inRange: 'limited',
        outPrimaries: 'p3d65', outTransfer: 'pq',
        outMatrix: '709', outRange: 'full', outSubsampling: '444',
    };
    const probe = `import json
c = clip
print(json.dumps([c.width, c.height, c.num_frames, str(c.format.name)]))
`;
    const r = spawnSync(PY, ['-c', PREAMBLE + src + '\n' + emitCstBody(params) + '\n' + probe],
        { encoding: 'utf8', timeout: 60_000 });
    assert.equal(r.status, 0, 'full pipeline failed: ' + (r.stderr || '').slice(0, 400));
    const meta = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.deepEqual(meta, [32, 24, 2, 'YUV444P16'], 'dims/FPS/format preserved (420→444 as chosen)');
    // Duration/fps unchanged: 2 frames @ 25/1 both before and after.
    const probe2 = `import json
print(json.dumps([clip.num_frames, clip.fps_num, clip.fps_den]))`;
    const r2 = spawnSync(PY, ['-c', PREAMBLE + src + '\n' + emitCstBody(params) + '\n' + probe2],
        { encoding: 'utf8', timeout: 60_000 });
    assert.deepEqual(JSON.parse(r2.stdout.trim().split('\n').pop()), [2, 25, 1], 'duration/FPS unchanged');
});

test('REAL runtime: clamp policy truncates excursions; pass policy preserves them', () => {
    // An out-of-range RED excursion (1.4) through identity transfers.
    const src = `src = core.std.BlankClip(width=32, height=8, length=2, fpsnum=25, fpsden=1, format=vs.RGBS, color=[1.4, 0.2, 0.1])
clip = src`;
    const probeFix = `import json
f = clip.get_frame(0)
print(json.dumps([f[0][2, 2]]))`;
    const mk = (policy) => {
        const params = { ...CST_DEFAULT_PARAMS, inTransfer: 'linear', outTransfer: 'linear',
            outMatrix: 'rgb', rangePolicy: policy };
        return spawnSync(PY, ['-c', PREAMBLE + src + '\n' + emitCstBody(params) + '\n' + probeFix],
            { encoding: 'utf8', timeout: 60_000 });
    };
    const clamp = mk('clamp');
    assert.equal(clamp.status, 0);
    const clampV = JSON.parse(clamp.stdout.trim().split('\n').pop())[0];
    assert.ok(Math.abs(clampV - 1.0) < 1e-6, `clamp policy: ${clampV} (expected 1.0)`);
    const pass = mk('pass');
    assert.equal(pass.status, 0);
    const passV = JSON.parse(pass.stdout.trim().split('\n').pop())[0];
    assert.ok(Math.abs(passV - 1.4) < 1e-4, `pass policy: ${passV} (expected 1.4 preserved)`);
});

test.after(() => { /* nothing persistent: all subprocesses are one-shot */ });