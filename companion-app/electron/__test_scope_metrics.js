// Scope-metrics test-signal verification — the PURE measurement functions
// (shared/scope-metrics.ts) against KNOWN synthetic signals with exact
// expected levels. No DOM needed (the panel's canvas decode is browser-side;
// its honesty contract is separately asserted as a static source check).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// The shared module is TS with type-only syntax; require through a tiny
// inline transpile is overkill — but it compiles cleanly under tsx-style
// stripping? node:test can't import TS directly. Use the built output? The
// renderer build bundles it. Simplest robust approach: evaluate the TS with
// types stripped via a regex-light approach is fragile — instead, re-derive
// the module via the TypeScript compiler we know is present (devDependency).
const tsc = path.join(__dirname, '..', 'node_modules', 'typescript', 'bin', 'tsc');
const { execFileSync } = require('child_process');
const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'vsres-scope-'));
execFileSync(process.execPath, [tsc,
    path.join(__dirname, '..', 'shared', 'scope-metrics.ts'),
    '--outDir', tmp, '--module', 'commonjs', '--target', 'es2022', '--skipLibCheck'],
    { stdio: 'pipe' });
const { computeScopeMetrics, makeGenerationGuard } = require(path.join(tmp, 'scope-metrics.js'));

function solid(width, height, [r, g, b]) {
    const px = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < px.length; i += 4) { px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255; }
    return px;
}

function lumaGradient(width, height) {
    const px = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;
            const v = Math.round(x * 255 / (width - 1));
            px[i] = v; px[i + 1] = v; px[i + 2] = v; px[i + 3] = 255;
        }
    }
    return px;
}

test('solid red: R histogram spike, R-high clip, vectorscope in the red quadrant', () => {
    const m = computeScopeMetrics(solid(32, 32, [255, 0, 0]), 32, 32);
    assert.equal(m.histogram.r[255], m.sampledPixels, 'every pixel at R=255');
    assert.equal(m.clipping.high.r, m.sampledPixels, 'R high-clip everywhere');
    assert.equal(m.clipping.low.g, m.sampledPixels, 'G low-clip (value 0)');
    assert.equal(m.clipping.fraction, 1);
    // Red: u ≈ -43 (left), v ≈ +127 (bottom of the flipped plot).
    const { size, grid } = m.vectorscope;
    let best = { count: 0, gx: -1, gy: -1 };
    for (let gy = 0; gy < size; gy++) for (let gx = 0; gx < gx + 1 && gx < size; gx++) {
        const c = grid[gy * size + gx];
        if (c > best.count) best = { count: c, gx, gy };
    }
    assert.ok(best.gx < size / 2, 'chroma left half (u negative)');
    assert.ok(best.gy > size / 2, 'chroma lower half (v positive)');
});

test('saturated primaries occupy DISTINCT vectorscope quadrants', () => {
    const quads = {};
    for (const [name, rgb] of [['red', [255, 0, 0]], ['green', [0, 255, 0]], ['blue', [0, 0, 255]]]) {
        const m = computeScopeMetrics(solid(16, 16, rgb), 16, 16);
        const { size, grid } = m.vectorscope;
        let best = { count: 0, gx: -1, gy: -1 };
        for (let gy = 0; gy < size; gy++) for (let gx = 0; gx < size; gx++) {
            const c = grid[gy * size + gx];
            if (c > best.count) best = { count: c, gx, gy };
        }
        quads[name] = [Math.floor(best.gx / (size / 2)), Math.floor(best.gy / (size / 2))].join(',');
    }
    // red lower-left, green upper-left, blue upper-right — all distinct.
    assert.deepEqual(quads, { red: '0,1', green: '0,0', blue: '1,0' });
});

test('black and white: full clipping, exact luma bounds', () => {
    const black = computeScopeMetrics(solid(16, 16, [0, 0, 0]), 16, 16);
    assert.equal(black.lumaStats.min, 0); assert.equal(black.lumaStats.max, 0);
    assert.equal(black.clipping.low.r, black.sampledPixels);
    const white = computeScopeMetrics(solid(16, 16, [255, 255, 255]), 16, 16);
    assert.equal(white.lumaStats.min, 255); assert.equal(white.lumaStats.max, 255);
    assert.equal(white.clipping.high.b, white.sampledPixels);
});

test('mid-gray: zero clipping, luma exactly 128', () => {
    const m = computeScopeMetrics(solid(16, 16, [128, 128, 128]), 16, 16);
    assert.equal(m.clipping.fraction, 0, 'no clipped pixels');
    assert.equal(Math.round(m.lumaStats.avg), 128);
    assert.equal(m.histogram.luma[128], m.sampledPixels);
});

test('horizontal luma gradient: waveform rises monotonically across columns', () => {
    const W = 64, H = 8;
    const m = computeScopeMetrics(lumaGradient(W, H), W, H);
    assert.equal(m.lumaStats.min, 0);
    assert.equal(m.lumaStats.max, 255);
    assert.equal(m.clipping.fraction > 0, true, 'ramp endpoints clip by construction');
    // Per-column peak level increases left→right on the parade.
    const peaks = [];
    for (let c = 0; c < m.parade.columns; c++) {
        let hi = 0;
        for (let level = 0; level < 256; level++) if (m.parade.r[c][level]) hi = level;
        peaks.push(hi);
    }
    for (let c = 1; c < peaks.length; c++) {
        assert.ok(peaks[c] >= peaks[c - 1], `parade column peak regressed at ${c}`);
    }
    assert.ok(peaks[peaks.length - 1] > peaks[0] + 100, 'ramp spans most of the range');
});

test('generation guard: only the newest decode may commit', () => {
    const g = makeGenerationGuard();
    const a = g.begin();
    const b = g.begin();
    assert.equal(g.isCurrent(a), false, 'older generation superseded');
    assert.equal(g.isCurrent(b), true);
    g.cancelAll();
    assert.equal(g.isCurrent(b), false, 'cancelAll invalidates in-flight work');
    const c = g.begin();
    assert.equal(g.isCurrent(c), true);
});

test('malformed input: empty image rejected honestly', () => {
    assert.throws(() => computeScopeMetrics(new Uint8ClampedArray(0), 0, 0));
    assert.throws(() => computeScopeMetrics(new Uint8ClampedArray(3), 1, 1));
});

test('ScopesPanel honesty contract (static source check — payload-era wording)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'ScopesPanel.tsx'), 'utf8');
    // Domain honesty: signal-referred labeled with provenance; the
    // display-referred fallback labeled as a DOWNGRADE, never passed off
    // as signal-referred.
    assert.ok(src.includes('Signal-referred'), 'signal-referred domain labeled');
    assert.ok(src.includes('BEFORE the 8-bit'), 'pre-conversion sampling stated');
    assert.ok(src.includes('Display-referred fallback'), 'fallback downgrade labeled');
    assert.ok(src.includes('10-bit distinctions are NOT visible here'), 'fallback limits stated');
    assert.ok(src.includes('Not signal-referred'), 'fallback never claims signal precision');
    assert.ok(src.includes('restoration-quality judgments'), 'no subjective quality judgment');
    assert.ok(src.includes('willReadFrequently'), 'canvas read is performance-hinted');
    assert.ok(src.includes('counted, not clipped'), 'excursions counted, not silently clipped');
});

test.after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });