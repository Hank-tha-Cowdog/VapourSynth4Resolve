// Quantitative preview-scope metrics — PURE functions, no DOM, testable in
// node. Everything here measures the PREVIEW IMAGE (8-bit, display-referred,
// post-output-stage RGB): these are measurements of what the viewer shows,
// NEVER of the original source material. Callers must label results with
// that provenance (the Scopes panel does).
//
// Measurements are objective (level distributions, counts, angles). They are
// NOT restoration-quality judgments — no "good/bad" is computed or implied.
//
// Vectorscope mapping: full-range 8-bit RGB → BT.601 YUV (the same family
// the preview output stage renders to for display), U/V plotted on a 128×128
// grid. Deterministic and unit-verified against saturated primaries.

export interface ScopeMetrics {
    histogram: { r: number[]; g: number[]; b: number[]; luma: number[] };
    // Per sampled column (≤ maxColumns), per channel: 256-bin occupancy.
    parade: { columns: number; r: Uint32Array[]; g: Uint32Array[]; b: Uint32Array[] };
    vectorscope: { size: number; grid: Uint32Array };   // grid = size*size
    clipping: {
        low: { r: number; g: number; b: number };
        high: { r: number; g: number; b: number };
        fraction: number;   // pixels with any-channel clip / sampled
    };
    lumaStats: { min: number; max: number; avg: number };
    sampledPixels: number;
    sourceSize: { width: number; height: number };
}

const MAX_COLUMNS = 256;

export function computeScopeMetrics(
    pixels: Uint8ClampedArray | Uint8Array,
    width: number,
    height: number,
): ScopeMetrics {
    if (width <= 0 || height <= 0) throw new Error('computeScopeMetrics: empty image');
    const n = width * height;
    if (pixels.length < n * 4) throw new Error('computeScopeMetrics: pixel buffer too small');

    const histogram = {
        r: new Array<number>(256).fill(0),
        g: new Array<number>(256).fill(0),
        b: new Array<number>(256).fill(0),
        luma: new Array<number>(256).fill(0),
    };
    const colCount = Math.min(width, MAX_COLUMNS);
    const strideX = Math.max(1, Math.floor(width / colCount));
    const paradeR: Uint32Array[] = [], paradeG: Uint32Array[] = [], paradeB: Uint32Array[] = [];
    for (let c = 0; c < colCount; c++) {
        paradeR.push(new Uint32Array(256));
        paradeG.push(new Uint32Array(256));
        paradeB.push(new Uint32Array(256));
    }
    const VS_SIZE = 128;
    const grid = new Uint32Array(VS_SIZE * VS_SIZE);
    const clip = { low: { r: 0, g: 0, b: 0 }, high: { r: 0, g: 0, b: 0 }, anyCount: 0 };
    let lumaMin = 255, lumaMax = 0, lumaSum = 0;
    let sampled = 0;

    // Row subsample for responsiveness on large frames (statistics on a
    // uniform subsample remain representative for level distributions).
    const strideY = Math.max(1, Math.floor(height / 512));
    for (let y = 0; y < height; y += strideY) {
        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;
            const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
            histogram.r[r]++; histogram.g[g]++; histogram.b[b]++;
            const luma = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
            histogram.luma[Math.min(255, luma)]++;
            if (luma < lumaMin) lumaMin = luma;
            if (luma > lumaMax) lumaMax = luma;
            lumaSum += luma;
            // Parade: sampled columns only.
            if (x % strideX === 0) {
                const c = Math.min(colCount - 1, Math.floor(x / strideX));
                paradeR[c][r]++; paradeG[c][g]++; paradeB[c][b]++;
            }
            // Clipping (8-bit display levels).
            let any = false;
            if (r === 0) { clip.low.r++; any = true; }
            if (g === 0) { clip.low.g++; any = true; }
            if (b === 0) { clip.low.b++; any = true; }
            if (r === 255) { clip.high.r++; any = true; }
            if (g === 255) { clip.high.g++; any = true; }
            if (b === 255) { clip.high.b++; any = true; }
            if (any) clip.anyCount++;
            // Vectorscope (BT.601 full-range U/V, 128×128 grid).
            const u = -0.169 * r - 0.331 * g + 0.5 * b;
            const v = 0.5 * r - 0.419 * g - 0.081 * b;
            const gx = clampInt(Math.round((u + 128) * (VS_SIZE - 1) / 256), 0, VS_SIZE - 1);
            const gy = clampInt(Math.round((v + 128) * (VS_SIZE - 1) / 256), 0, VS_SIZE - 1);
            grid[gy * VS_SIZE + gx]++;
            sampled++;
        }
    }
    return {
        histogram,
        parade: { columns: colCount, r: paradeR, g: paradeG, b: paradeB },
        vectorscope: { size: VS_SIZE, grid },
        clipping: { low: clip.low, high: clip.high, fraction: sampled ? clip.anyCount / sampled : 0 },
        lumaStats: { min: lumaMin, max: lumaMax, avg: sampled ? lumaSum / sampled : 0 },
        sampledPixels: sampled,
        sourceSize: { width, height },
    };
}

function clampInt(v: number, lo: number, hi: number): number {
    return v < lo ? lo : v > hi ? hi : v;
}

// Stale-result guard for the panel: rapid toggles/seeks/A-B can start
// several decodes; only the LATEST generation may commit its result.
export function makeGenerationGuard() {
    let latest = 0;
    return {
        begin(): number { return ++latest; },
        isCurrent(gen: number): boolean { return gen === latest; },
        cancelAll(): void { latest++; },
    };
}