// Installed VapourSynth plugin manifest.
//
// What's here = what ships in the v2.0-alpha vendored plugin bundle
// (vendor/Macos_vapoursynth_plugins/lib/). The Archivist consumes this list
// via its system prompt so it stops hallucinating namespaces like `core.svp1`
// (SmoothVideo Project — commercial, NOT bundled) or `core.rife` (neural
// frame interpolation — NOT bundled).
//
// Each entry has:
//   - namespace: the `core.<X>` attribute used in Python (e.g. `mv` →
//     `core.mv.Super`). MUST match what the plugin actually registers.
//   - purpose:  one-line description for the LLM.
//   - typicalUse: optional canonical invocation pattern so the model has
//     a working recipe to crib from instead of inventing one.
//
// When you add a plugin to vendor/Macos_vapoursynth_plugins/lib, append
// it here too — the LLM only ever knows what this list says it knows.
// TODO (TKT-PLUGIN-PROBE): replace with a runtime probe via VSAPI
// core->plugins() so we don't have to keep this in sync by hand.

export interface PluginInfo {
    namespace: string;
    purpose: string;
    typicalUse?: string;
}

// Grouped for the LLM's mental model. Order within a group is rough
// "most-used first."
export const INSTALLED_PLUGINS: { group: string; plugins: PluginInfo[] }[] = [
    {
        group: 'Source / I/O',
        plugins: [
            { namespace: 'lsmas',  purpose: 'L-SMASH source — direct file load (mp4/mov/m2ts/mkv/dv/avi)',
              typicalUse: "src = core.lsmas.LWLibavSource(r'/path/to/file.mov')" },
            { namespace: 'fpng',   purpose: 'PNG read/write' },
        ],
    },
    {
        group: 'Field-ops / Deinterlace / IVTC',
        plugins: [
            { namespace: 'nnedi3', purpose: 'NNEDI3 neural deinterlacer (CPU)',
              typicalUse: "clip = core.nnedi3.nnedi3(clip, field=1)" },
            { namespace: 'nnedi3cl', purpose: 'NNEDI3 OpenCL build (faster on AMD/Intel iGPU)' },
            { namespace: 'sneedif', purpose: 'NNEDI3-like deinterlace, faster' },
            { namespace: 'eedi2',  purpose: 'EEDI2 deinterlacer' },
            { namespace: 'eedi3m', purpose: 'EEDI3 deinterlacer, modern build' },
            { namespace: 'sangnom', purpose: 'SangNom deinterlacer' },
            { namespace: 'tdm',    purpose: 'TDeintMod — field-matching deinterlacer' },
            { namespace: 'tcomb',  purpose: 'TComb — combing-residual cleaner (post-deinterlace)' },
            { namespace: 'tivtc',  purpose: 'TFM + TDecimate — telecine field-matching & decimation (3:2 pulldown removal)',
              typicalUse: "clip = core.tivtc.TFM(clip, order=0); clip = core.tivtc.TDecimate(clip)" },
            { namespace: 'vivtc',  purpose: 'VFM + VDecimate — alternative IVTC, faster than tivtc',
              typicalUse: "clip = core.vivtc.VFM(clip, order=0); clip = core.vivtc.VDecimate(clip)" },
            { namespace: 'it',     purpose: 'IT — interlace tracker for variable-cadence sources' },
            { namespace: 'fh',     purpose: 'FieldHint — apply per-frame field overrides from a hints file' },
        ],
    },
    {
        group: 'Motion estimation / Frame interpolation',
        plugins: [
            { namespace: 'mv',     purpose: 'mvtools — the standard motion-estimation suite. Used by QTGMC (via havsfunc), SMDegrain, BlockFPS, etc.',
              typicalUse: "sup = core.mv.Super(clip); bw = core.mv.Analyse(sup, isb=True); fw = core.mv.Analyse(sup, isb=False); clip = core.mv.BlockFPS(clip, sup, bw, fw, num=60000, den=1001)" },
            // NB: NO svp1 / svp2 (commercial), NO rife (separate install), NO
            // mlrt (vs-mlrt — separate). If asked for "AI frame interpolation"
            // tell the user it's a separate install — DO NOT call core.rife/svp.
        ],
    },
    {
        group: 'Denoise',
        plugins: [
            { namespace: 'bm3d',     purpose: 'BM3D — block-matching 3D denoise (CPU reference build)' },
            { namespace: 'bm3dcpu',  purpose: 'BM3D — modern CPU implementation, faster than original' },
            { namespace: 'bm3dmetal', purpose: 'BM3D — Apple Metal-accelerated, fastest on Apple Silicon (PREFER on this Mac)' },
            { namespace: 'dfttest',  purpose: 'DFTTest — 3D FFT-based denoise, good for film grain' },
            { namespace: 'dfttest2', purpose: 'DFTTest2 — newer/faster variant' },
            { namespace: 'knlm',     purpose: 'KNLMeansCL — non-local-means denoise via OpenCL' },
            { namespace: 'ttmpsm',   purpose: 'TTempSmooth — temporal-only smoother (low-motion sources)' },
            { namespace: 'focus2',   purpose: 'TemporalSoften2 — fast temporal denoise' },
            { namespace: 'fft3dfilter', purpose: 'FFT3DFilter — 3D Fourier denoise' },
            { namespace: 'wnnm',     purpose: 'WNNM — weighted nuclear norm denoise (very slow, very high quality)' },
            { namespace: 'nlm_ispc', purpose: 'Non-local means via ISPC' },
            { namespace: 'smoothuv', purpose: 'SmoothUV — chroma denoiser' },
            { namespace: 'zsmooth',  purpose: 'ZSmooth — fast spatial smoother' },
            { namespace: 'bilateral', purpose: 'Bilateral filter' },
            { namespace: 'ctmf',     purpose: 'Constant-time median filter' },
        ],
    },
    {
        group: 'Restore / Repair',
        plugins: [
            { namespace: 'rgvs',     purpose: 'RemoveGrain / Repair — classic spatial post-processing primitives' },
            { namespace: 'rgsf',     purpose: 'RemoveGrain — single-precision float build' },
            { namespace: 'deblock',  purpose: 'Deblock — H.264/MPEG block-artifact reducer' },
            { namespace: 'neo_f3kdb', purpose: 'Flash3kyuu Deband — gradient debanding' },
            { namespace: 'lghost',   purpose: 'LGhost — ghost/double-image removal' },
            { namespace: 'retinex',  purpose: 'Retinex — adaptive local contrast for crushed shadows' },
            { namespace: 'edgefixer', purpose: 'EdgeFixer — corrects edge-row artifacts from telecine' },
            { namespace: 'bore',     purpose: 'Bore — fixes black/white border bleed' },
            { namespace: 'area',     purpose: 'AreaFilter — masked per-region processing' },
            { namespace: 'rowmanip', purpose: 'Row manipulation primitives' },
        ],
    },
    {
        group: 'Sharpen',
        plugins: [
            { namespace: 'cas',      purpose: 'CAS — AMD Contrast-Adaptive Sharpen' },
            { namespace: 'warp',     purpose: 'aWarpSharp2 — edge-warping sharpener (heavy)' },
            { namespace: 'asharp',   purpose: 'AdaptiveSharpen' },
        ],
    },
    {
        group: 'Resize / Format',
        plugins: [
            { namespace: 'resize2',  purpose: 'Modern resize replacement (better than core.resize)' },
            { namespace: 'descale',  purpose: 'Descale — inverse of common upscale kernels' },
            { namespace: 'fmtc',     purpose: 'fmtconv — best-in-class bit-depth + colorspace conversion',
              typicalUse: "clip = core.fmtc.bitdepth(clip, bits=16)" },
            { namespace: 'tcanny',   purpose: 'TCanny — edge detection (for masks)' },
            { namespace: 'tedgemask', purpose: 'TEdgeMask — edge-detection masks' },
            { namespace: 'gauss',    purpose: 'GaussianBlur' },
            { namespace: 'misc',     purpose: 'MiscFilters — utility primitives (AverageFrames, Hysteresis, etc.)' },
        ],
    },
    {
        group: 'Color / Levels',
        plugins: [
            // adjust ships as a Python module, not a plugin namespace, so
            // there's no `core.adjust` — use `adjust.Tweak(clip, ...)`.
            // Listed in the helper-imports section, not here.
        ],
    },
    {
        group: 'Diagnostic / Test',
        plugins: [
            { namespace: 'hist',     purpose: 'Histogram — built-in scopes overlay' },
            { namespace: 'fftspectrum', purpose: 'FFTSpectrum — frequency-domain visualization' },
            { namespace: 'pickframes', purpose: 'Frame-selection helpers' },
            { namespace: 'dmetrics', purpose: 'Difference metrics for A/B' },
        ],
    },
];

// Helpers also in scope (Python modules, not core.* namespaces).
export const PYTHON_HELPERS = [
    { name: 'havsfunc',  purpose: 'Hybrid AVS Functions — QTGMC, SMDegrain, daa, FineDehalo, FineDehalo2, etc.' },
    { name: 'mvsfunc',   purpose: 'mvs-func / mvf — ToRGB, ToYUV, Depth, Preview, BM3DCPU wrapper' },
    { name: 'adjust',    purpose: 'adjust.Tweak — hue/sat/bright/cont' },
    { name: 'nnedi3_resample', purpose: 'NNEDI3-based upscale resampler (optional, may be absent)' },
];

// Markdown block dropped straight into the Archivist system prompt.
// Compact-but-complete: namespace, one-liner, occasional usage hint.
//
// TRUTH RECONCILIATION: the curated manifest above is a guide, not proof.
// `available` is the ACTUALLY registered namespace set from the runtime
// probe (electron/vs-plugin-probe.js). Entries the probe does not confirm
// are NOT offered as callable — they move to the NOT INSTALLED section,
// because a chain referencing an unregistered namespace fails the host's
// pre-accept validation ("no attribute or namespace named X"). Live case:
// fft3dfilter was listed here but never registered; a generated step
// calling it was refused. Pass undefined to get the legacy static view.
export function pluginManifestForPrompt(available?: ReadonlySet<string>): string {
    const verified = (ns: string) => available === undefined || available.has(ns);
    const lines: string[] = [];
    lines.push('**INSTALLED VAPOURSYNTH PLUGINS — this is the complete list. Code that references any other `core.<X>` namespace will fail at runtime with `AttributeError: No attribute with the name X exists`.**');
    lines.push('');
    let offered = 0;
    for (const group of INSTALLED_PLUGINS) {
        if (group.plugins.length === 0) continue;
        const plugins = group.plugins.filter(p => verified(p.namespace));
        if (!plugins.length) continue;
        offered += plugins.length;
        lines.push(`*${group.group}*`);
        for (const p of plugins) {
            const head = `- \`core.${p.namespace}\` — ${p.purpose}`;
            lines.push(p.typicalUse ? `${head}\n  \`\`\`python\n  ${p.typicalUse}\n  \`\`\`` : head);
        }
        lines.push('');
    }
    if (available !== undefined) {
        const claimedMissing = INSTALLED_PLUGINS
            .flatMap(g => g.plugins.map(p => p.namespace))
            .filter(ns => !available.has(ns));
        if (claimedMissing.length) {
            lines.push('**CLAIMED BUT NOT REGISTERED on this machine (probe-verified absent) — do not reference:**');
            for (const ns of claimedMissing) lines.push(`- \`core.${ns}\``);
            lines.push('');
        }
    }
    lines.push('*Python helper modules in scope (import-free):*');
    for (const h of PYTHON_HELPERS) {
        lines.push(`- \`${h.name}\` — ${h.purpose}`);
    }
    lines.push('');
    lines.push('**NOT INSTALLED — do not reference, even if commonly suggested online:**');
    lines.push('- `core.svp1` / `core.svp2` — SmoothVideo Project (commercial, separate license)');
    lines.push('- Neural interpolation: check the CURRENT capability snapshot — `core.ort` (vs-mlrt ONNX backend) registers when installed, and RIFE is usable ONLY when the snapshot reports inference-verified (weights + adapter + backend + load). Never claim RIFE works from extraction alone.');
    lines.push('- `core.flux` — FluxSmooth (not in this bundle)');
    lines.push('- `core.deint` / `core.yadifmod` / `core.bwdif` — alternative deinterlacers we did not bundle');
    lines.push('');
    lines.push('If the colorist asks for something that needs an uninstalled plugin, **say so explicitly in your prose and propose an alternative from the installed list**. Don\'t emit code that calls the missing plugin.');
    if (offered === 0 && available !== undefined) {
        lines.unshift('**WARNING: the runtime plugin probe found no registered namespaces — the manifest below may be unreliable. Confirm the VapourSynth runtime is installed before trusting any `core.<X>` call.**', '');
    }
    return lines.join('\n');
}
