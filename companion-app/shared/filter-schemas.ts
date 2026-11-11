// Shared filter parameter schemas — ONE source driving the UI controls,
// validation, script generation (emit), tooltips and the chatbot's
// capability descriptions. Every schema's emit() reproduces the
// EXACT template qualified through scripts/qualify_filters.py and
// scripts/verify_templates.sh, so structured edits cannot drift from the
// qualified form. A step whose code no longer matches emit(params) is
// CUSTOM: the panel shows a custom badge and never overwrites the user's
// script silently.

export type ParamKind = 'enum' | 'bool' | 'range' | 'number';

export interface ParamDef {
    key: string;
    label: string;
    /** What it does, when to use it, and the quality/performance tradeoff. */
    help: string;
    kind: ParamKind;
    options?: string[];
    min?: number;
    max?: number;
    step?: number;
    unit?: string;
    default: unknown;
    advanced?: boolean;
}

export interface FilterSchema {
    type: string;
    label: string;
    purpose: string;
    /** Input requirements the panel surfaces (8-bit, float32, field order…). */
    inputRequirements?: string;
    params: ParamDef[];
    /** params → the step's Python code (matches the qualified template). */
    emit: (p: Record<string, unknown>) => string;
    /** Template body used for new steps (matches FilterLibrary templates). */
    template: () => string;
}

import { emitCstBody, cstTemplateBody, CST_GAMUT_PAIRS, CST_TRANSFERS, CST_MATRICES, CST_RANGES, CST_GAMUTS, CST_OUT_FORMATS } from './cst-transform';
import { QTGMC_PRESETS } from './draft-composer';

const num = (p: Record<string, unknown>, k: string, d: number): number =>
    typeof p[k] === 'number' && Number.isFinite(p[k]) ? p[k] as number : d;

export const FILTER_SCHEMAS: Record<string, FilterSchema> = {
    qtgmc: {
        type: 'qtgmc', label: 'QTGMC Deinterlace',
        purpose: 'Motion-compensated deinterlace — the standard for interlaced video. Single-rate by default.',
        inputRequirements: 'Interlaced YUV (the composer provides YUV420P16). Field order must be correct.',
        params: [
            { key: 'preset', label: 'Preset', kind: 'enum', default: 'Slower',
                options: [...QTGMC_PRESETS],
                help: 'Quality/speed. Fast presets trade motion-vector refinement for render speed — fine for scrubbing; Slower/Very Slow for final renders.' },
            { key: 'tff', label: 'Top-field-first', kind: 'bool', default: true,
                help: 'Field order. Wrong order → combing. Trust the probe verdict (pixel content) over the container flag.' },
            { key: 'fpsDivisor', label: 'Output rate', kind: 'enum', default: '2', options: ['1', '2'],
                help: '2 = single-rate (keeps source cadence; recommended). 1 = full-rate bob (double frame count — the timeline must run at the doubled rate to consume it correctly).' },
            { key: 'sourceMatch', label: 'Source match', kind: 'range', min: 0, max: 3, step: 1, default: 0, advanced: true,
                help: 'Matches output to the source fields (0=off, 1–3 = stronger). Sharper but slower; 3 can over-sharper grainy tape.' },
            { key: 'lossless', label: 'Lossless', kind: 'range', min: 0, max: 2, step: 1, default: 0, advanced: true,
                help: '2 = interpolate exact source fields back in (lossless weave). Needs the correct field order.' },
            { key: 'noiseProcess', label: 'Noise process', kind: 'range', min: 0, max: 2, step: 1, default: 0, advanced: true,
                help: '0 = off (preservation default — grain is part of the record). 1/2 denoise+regrain; needs fft3dfilter.' },
        ],
        emit: (p) => {
            // Preset whitelist (no silent Slower substitution for exposed
            // presets, no arbitrary string interpolation): same canonical
            // list as the typed emitter. Values outside it fall back like
            // native sanitize_preset does.
            const presetRaw = typeof p.preset === 'string' ? p.preset : 'Slower';
            const preset = QTGMC_PRESETS.includes(presetRaw) ? presetRaw : 'Slower';
            const tff = p.tff === undefined ? true : Boolean(p.tff);
            const div = Number(p.fpsDivisor ?? 2) === 1 ? 1 : 2;
            let call = `clip = havs.QTGMC(clip, Preset='${preset}'`;
            if (tff !== null) call += `, TFF=${tff ? 'True' : 'False'}`;
            call += `, FPSDivisor=${div}`;
            const sm = p.sourceMatch;
            if (Number.isInteger(sm) && (sm as number) >= 1 && (sm as number) <= 3) call += `, SourceMatch=${sm}`;
            const ll = p.lossless;
            if (Number.isInteger(ll) && (ll as number) >= 0 && (ll as number) <= 2) call += `, Lossless=${ll}`;
            const np = p.noiseProcess;
            if (Number.isInteger(np) && (np as number) >= 0 && (np as number) <= 2) call += `, NoiseProcess=${np}`;
            return call + ')\n';
        },
        template: () => "clip = havs.QTGMC(clip, Preset='Slower', TFF=True, FPSDivisor=2)\n",
    },
    cas: {
        type: 'cas', label: 'CAS Sharpen',
        purpose: 'Contrast-adaptive sharpen — sharpens edges without halos. Safe default for restoration.',
        params: [
            { key: 'sharpness', label: 'Sharpness', kind: 'range', min: 0, max: 1, step: 0.05, default: 0.4, unit: '',
                help: '0–1. 0.3–0.5 is a natural restoration range: noticeable detail gain without ringing on tape edges.' },
        ],
        emit: (p) => `clip = core.cas.CAS(clip, sharpness=${num(p, 'sharpness', 0.4)})\n`,
        template: () => 'clip = core.cas.CAS(clip, sharpness=0.4)\n',
    },
    dfttest: {
        type: 'dfttest', label: 'DFTTest Denoise',
        purpose: 'Frequency-domain spatial denoise on YUV — no RGB bounce; lighter CPU than BM3D.',
        params: [
            { key: 'sigma', label: 'Sigma', kind: 'range', min: 0, max: 128, step: 1, default: 48, unit: 'luma noise level',
                help: 'Noise estimate. Higher = stronger denoise but detail loss. 32–64 covers most analog tape.' },
            { key: 'tbsize', label: 'Temporal size', kind: 'range', min: 0, max: 16, step: 1, default: 1, advanced: true,
                help: '1 = spatial only (safe with motion). >1 adds temporal denoising — needs clean motion or it smears.' },
        ],
        emit: (p) => `clip = core.dfttest.DFTTest(clip, tbsize=${num(p, 'tbsize', 1)}, sigma=${num(p, 'sigma', 48).toFixed(1)})\n`,
        template: () => 'clip = core.dfttest.DFTTest(clip, tbsize=1, sigma=48.0)\n',
    },
    nlm_ispc: {
        type: 'nlm_ispc', label: 'NLM Denoise (ISPC)',
        purpose: 'Non-local means denoise — strongest measured reduction on the qualification fixture.',
        params: [
            { key: 'h', label: 'Strength (h)', kind: 'range', min: 0, max: 32, step: 0.5, default: 8, unit: '',
                help: 'Denoise strength. h≈8 was the strongest tested reduction (37→26 HF). Higher flattens grain structure.' },
            { key: 'd', label: 'Search distance', kind: 'range', min: 0, max: 3, step: 1, default: 0, advanced: true,
                help: 'Patch search distance. 0 = in-frame (fast). 1+ looks across time — smoother but slower and can ghost.' },
        ],
        emit: (p) => `clip = core.nlm_ispc.NLMeans(clip, d=${num(p, 'd', 0)}, a=2, s=4, h=${num(p, 'h', 8).toFixed(1)})\n`,
        template: () => 'clip = core.nlm_ispc.NLMeans(clip, d=0, a=2, s=4, h=8.0)\n',
    },
    neo_f3kdb: {
        type: 'neo_f3kdb', label: 'Deband',
        purpose: 'Rebuild banded gradients (sky, ramps) with dithered noise.',
        params: [
            { key: 'range', label: 'Detection range', kind: 'range', min: 0, max: 64, step: 1, default: 15, unit: '',
                help: 'How far apart two pixel values must be to count as a band step. Example: a DV tape sky stepping 16→18→20 needs range≥3. Raise if banding survives (visible steps stay), lower if grain gets eaten.' },
            { key: 'grainy', label: 'Luma grain', kind: 'range', min: 0, max: 64, step: 1, default: 0, unit: '',
                help: 'Dither noise added on luma to mask remaining steps. 0 for clean masters; 8–16 for heavy banding you could not fully debounce. Example: broadcast tape with posterized dusk sky → range 15, grainy 8.' },
        ],
        emit: (p) => `clip = core.neo_f3kdb.Deband(clip, range=${num(p, 'range', 15)}, y=64, cb=64, cr=64, grainy=${num(p, 'grainy', 0)}, grainc=${num(p, 'grainy', 0)})\n`,
        template: () => 'clip = core.neo_f3kdb.Deband(clip, range=15, y=64, cb=64, cr=64, grainy=0, grainc=0)\n',
    },
    fft3dfilter: {
        type: 'fft3dfilter', label: 'FFT3D Denoise',
        purpose: 'Frequency-domain spatio-temporal denoise for film grain and analog tape.',
        params: [
            { key: 'sigma', label: 'Sigma', kind: 'range', min: 0, max: 16, step: 0.5, default: 2, unit: '',
                help: 'Noise attenuation strength. Example: 16mm telecine grain → sigma 2–3; VHS chroma crawl → sigma 3.5 on the chroma planes. Above ~5 fine detail (hair, fabric weave) starts to smear — zoom to 200% and check before committing.' },
            { key: 'bt', label: 'Temporal radius (bt)', kind: 'range', min: 0, max: 5, step: 1, default: 3, advanced: true,
                help: 'Frames averaged in the temporal window. 0 = spatial-only (safe with motion). Higher smooths noise better but GHOSTS on moving subjects — if people walk and leave trails, lower bt. Keep at 3 for locked-off or slow material.' },
        ],
        emit: (p) => `clip = core.fft3dfilter.FFT3DFilter(clip, sigma=${num(p, 'sigma', 2).toFixed(1)}, bt=${num(p, 'bt', 3)}, bw=32, bh=32, ow=16, oh=16)\n`,
        template: () => 'clip = core.fft3dfilter.FFT3DFilter(clip, sigma=2.0, bt=3, bw=32, bh=32, ow=16, oh=16)\n',
    },
    bm3dmetal: {
        type: 'bm3dmetal', label: 'BM3D Denoise (Metal)',
        purpose: 'Block-matching 3D denoise, Metal-accelerated — the fastest quality denoise on Apple Silicon. Preserves grain structure better than FFT3D at equal strength.',
        inputRequirements: 'The Metal build takes FLOAT RGB: the generated script bounces to RGBS and back automatically.',
        params: [
            { key: 'sigma', label: 'Sigma', kind: 'range', min: 0, max: 24, step: 0.5, default: 3, unit: '',
                help: 'Noise level estimate, applied to all three planes. Start at 3.0 and judge on real footage: tape hiss ~2–3, 16mm scan grain ~4–5. Above 8 you are smoothing, not denoising — check edges at 200% zoom.' },
            { key: 'radius', label: 'Temporal radius', kind: 'range', min: 0, max: 4, step: 1, default: 0, unit: '',
                help: '0 = spatial only (fast). >0 adds the temporal (3D) pass: better grain retention, slower, and it can smear fast motion. Example: locked-off interview → radius 2; handheld run-and-gun → keep 0.' },
        ],
        emit: (p) =>
            '# BM3D spatial+temporal denoise. Metal build takes FLOAT RGB input:\n' +
            '# bounce to RGBS with to_rgb, run BM3D, return to YUV after.\n' +
            '# sigma: noise level estimate; start 3.0 and judge on real footage.\n' +
            '# radius>0 enables the temporal (3D) pass — slower, better grain retention.\n' +
            'clip = to_rgb(clip, depth=32)\n' +
            `clip = core.bm3dmetal.BM3D(clip, sigma=[${num(p, 'sigma', 3).toFixed(1)}, ${num(p, 'sigma', 3).toFixed(1)}, ${num(p, 'sigma', 3).toFixed(1)}], radius=${num(p, 'radius', 0)})\n` +
            "clip = to_yuv(clip, css='420', depth=16)\n",
        template: () =>
            '# BM3D spatial+temporal denoise. Metal build takes FLOAT RGB input:\n' +
            '# bounce to RGBS with to_rgb, run BM3D, return to YUV after.\n' +
            '# sigma: noise level estimate; start 3.0 and judge on real footage.\n' +
            '# radius>0 enables the temporal (3D) pass — slower, better grain retention.\n' +
            'clip = to_rgb(clip, depth=32)\n' +
            'clip = core.bm3dmetal.BM3D(clip, sigma=[3.0, 3.0, 3.0], radius=0)\n' +
            "clip = to_yuv(clip, css='420', depth=16)\n",
    },
    ttmpsm: {
        type: 'ttmpsm', label: 'Temporal Denoise',
        purpose: 'Temporal-only smoother (TTempSmooth) — averages successive frames to kill shimmering analog noise while PRESERVING grain.',
        inputRequirements: 'Low-motion or locked-off sources. NOT for handheld/action (use a gated/3D filter instead).',
        params: [
            { key: 'maxr', label: 'Radius (frames)', kind: 'range', min: 1, max: 6, step: 1, default: 3, unit: '',
                help: 'How many neighboring frames enter the average. 3 = ±3 frames. Bigger smooths more but doubles ghost risk on subject movement. Example: a static camera-on-tripod interview → maxr 4 is safe; anything with pans → 2 or skip temporal.' },
            { key: 'thresh', label: 'Threshold', kind: 'range', min: 1, max: 30, step: 1, default: 6, unit: '',
                help: 'Per-plane blend gate: differences above this are treated as motion and NOT averaged. Raise to tolerate more noise; too high blends moving edges (ghosting). Start 6; static noisy tape tolerates 10–12.' },
        ],
        emit: (p) =>
            '# Temporal-only denoise: averages similar frames, preserves grain.\n' +
            '# maxr: temporal radius (frames); thresh: per-plane blend threshold.\n' +
            `clip = core.ttmpsm.TTempSmooth(clip, maxr=${num(p, 'maxr', 3)}, thresh=[${num(p, 'thresh', 6)}, ${num(p, 'thresh', 6)}, ${num(p, 'thresh', 6)}])\n`,
        template: () =>
            '# Temporal-only denoise: averages similar frames, preserves grain.\n' +
            '# maxr: temporal radius (frames); thresh: per-plane blend threshold.\n' +
            'clip = core.ttmpsm.TTempSmooth(clip, maxr=3, thresh=[6, 6, 6])\n',
    },
    ttmpsm_flicker: {
        type: 'ttmpsm_flicker', label: 'Flicker Fix — Temporal',
        purpose: 'Gate-thresholded temporal smoother for STATIC-camera flicker (frame-to-frame brightness pumping). Gates motion, so only the flicker is averaged away.',
        inputRequirements: 'Static/locked-off camera. Luminance pumping that follows camera motion needs a different tool (flicker was verified on the static-flicker fixture).',
        params: [
            { key: 'maxr', label: 'Radius (frames)', kind: 'range', min: 1, max: 6, step: 1, default: 3, unit: '',
                help: 'Frames averaged. Flicker periods of several frames need maxr ≥ period. Example: an old-projector transfer pumping every 2–3 frames → maxr 3–4 removes it.' },
            { key: 'thresh', label: 'Blend gate', kind: 'range', min: 1, max: 30, step: 1, default: 12, unit: '',
                help: 'Differences below this are flicker (averaged); above this are content (kept). 12 handles typical projection flicker; too high risks ghosting.' },
            { key: 'mdiff', label: 'Motion gate', kind: 'range', min: 8, max: 128, step: 8, default: 64, unit: '', advanced: true,
                help: 'Per-plane motion gate: frames differing more than this are EXCLUDED from the average entirely. Lower = stricter motion safety (less ghosting, less flicker fix). Keep 64 unless you see ghost trails.' },
        ],
        emit: (p) =>
            '# TTempSmooth: temporal averaging of SIMILAR frames only (gates motion).\n' +
            '# maxr = temporal radius; thresh = blend gate; use on locked-off/shaky-free shots.\n' +
            `clip = core.ttmpsm.TTempSmooth(clip, maxr=${num(p, 'maxr', 3)}, thresh=[${num(p, 'thresh', 12)}, ${num(p, 'thresh', 12)}, ${num(p, 'thresh', 12)}], mdiff=[${num(p, 'mdiff', 64)}, ${num(p, 'mdiff', 64)}, ${num(p, 'mdiff', 64)}])\n`,
        template: () =>
            '# TTempSmooth: temporal averaging of SIMILAR frames only (gates motion).\n' +
            '# maxr = temporal radius; thresh = blend gate; use on locked-off/shaky-free shots.\n' +
            'clip = core.ttmpsm.TTempSmooth(clip, maxr=3, thresh=[12, 12, 12], mdiff=[64, 64, 64])\n',
    },
    deblock: {
        type: 'deblock', label: 'Deblock',
        purpose: 'Reduce block-edge artifacts from lossy compression (H.264/MPEG captures, DV-from-DVD rips, over-compressed mezzanines).',
        params: [
            { key: 'quant', label: 'Quant', kind: 'range', min: 0, max: 64, step: 1, default: 24, unit: '',
                help: 'Strength, scaled to the source quantizer. Rough guide: DVD-sourced 24–32, heavily crushed dark blocks 40+. Too high softens real edges — set, then zoom on flat dark walls and confirm the grid pattern went without the whole frame going waxy.' },
        ],
        emit: (p) =>
            '# Deblock: soften block edges from lossy sources.\n' +
            `clip = core.deblock.Deblock(clip, quant=${num(p, 'quant', 24)})\n`,
        template: () =>
            '# Deblock: soften block edges from lossy sources.\n' +
            'clip = core.deblock.Deblock(clip, quant=24)\n',
    },
    wnnm: {
        type: 'wnnm', label: 'WNNM Denoise (heavy)',
        purpose: 'Weighted nuclear-norm denoise — the strongest quality option, and correspondingly the SLOWEST. Reserve for hero shots.',
        inputRequirements: 'Float32 input: the generated script converts to YUV420PS and back. NOT for playback-speed work (measured multiple seconds per frame).',
        params: [
            { key: 'sigma', label: 'Sigma', kind: 'range', min: 0, max: 40, step: 0.5, default: 12, unit: '',
                help: 'Noise level estimate per plane. 12 is a strong grain-suppression setting; 8 keeps more texture. Because this filter is so slow, test on a SHORT trim of the worst section first — do not set it by guessing at the whole clip.' },
        ],
        emit: (p) =>
            '# WNNM: nuclear-norm denoise — float32 input, bounce back after.\n' +
            '# sigma = noise level; VERY slow: reserve for critical sections.\n' +
            'clip = core.resize.Bicubic(clip, format=vs.YUV420PS)\n' +
            `clip = core.wnnm.WNNM(clip, sigma=[${num(p, 'sigma', 12).toFixed(1)}, ${num(p, 'sigma', 12).toFixed(1)}, ${num(p, 'sigma', 12).toFixed(1)}])\n` +
            'clip = core.resize.Bicubic(clip, format=vs.YUV420P16)\n',
        template: () =>
            '# WNNM: nuclear-norm denoise — float32 input, bounce back after.\n' +
            '# sigma = noise level; VERY slow: reserve for critical sections.\n' +
            'clip = core.resize.Bicubic(clip, format=vs.YUV420PS)\n' +
            'clip = core.wnnm.WNNM(clip, sigma=[12.0, 12.0, 12.0])\n' +
            'clip = core.resize.Bicubic(clip, format=vs.YUV420P16)\n',
    },
    lghost: {
        type: 'lghost', label: 'Ghost Removal',
        purpose: 'Analog ghost/tap-echo reduction — the faint shifted double-image from multipath VHS/RF captures.',
        params: [
            { key: 'mode', label: 'Mode', kind: 'enum', default: '2', options: ['0', '1', '2'],
                help: '0 = positive ghost only, 1 = negative only, 2 = both. Example: VHS with a pale echo to the right of every bright edge → start 2 and check; if the ghost darkens edges instead, the polarity is negative → 1.' },
            { key: 'shift', label: 'Shift (px)', kind: 'range', min: 1, max: 8, step: 1, default: 1, unit: '',
                help: 'Ghost offset in pixels. Measure it honestly first: zoom to 400% on a hard vertical edge and count pixels between the edge and its echo. 1 covers most tape ghosts.' },
            { key: 'intensity', label: 'Intensity', kind: 'range', min: 0, max: 32, step: 1, default: 12, unit: '',
                help: 'Subtraction weight. Raise until the echo just disappears; too high burns a dark rim where the ghost was. When NOT to use: if the shift changes across the tape (drum speed drift), no single shift value works — fix capture instead.' },
        ],
        emit: (p) =>
            '# LGhost: subtract a shifted tap of the picture (analog VHS-style ghosting).\n' +
            '# mode 2 = both polarities; shift 1 = one-pixel echo; intensity 12 = blend weight.\n' +
            `clip = core.lghost.LGhost(clip, mode=[${num(p, 'mode', 2)}, ${num(p, 'mode', 2)}, ${num(p, 'mode', 2)}], shift=[${num(p, 'shift', 1)}, ${num(p, 'shift', 1)}, ${num(p, 'shift', 1)}], intensity=[${num(p, 'intensity', 12)}, ${num(p, 'intensity', 12)}, ${num(p, 'intensity', 12)}])\n`,
        template: () =>
            '# LGhost: subtract a shifted tap of the picture (analog VHS-style ghosting).\n' +
            '# mode 2 = both polarities; shift 1 = one-pixel echo; intensity 12 = blend weight.\n' +
            'clip = core.lghost.LGhost(clip, mode=[2, 2, 2], shift=[1, 1, 1], intensity=[12, 12, 12])\n',
    },
    eedi3m: {
        type: 'eedi3m', label: 'Deinterlace — EEDI3 (alt)',
        purpose: 'Edge-directed field interpolation — the alternative to QTGMC for material with poor motion boundaries (thin lines that QTGMC smears).',
        inputRequirements: 'Interlaced input; emits FIELDS at field rate — pair with a decimator (e.g. tivtc/vivtc) for single-rate output. Field order must be correct.',
        params: [
            { key: 'field', label: 'Field order', kind: 'enum', default: '1', options: ['0', '1'],
                help: 'Which field the interpolation targets: 1 = TFF (top-first), 0 = BFF. If the result combs, the order is wrong — flip it. When NOT to use: default to QTGMC; come here only when QTGMC visibly smears thin motion boundaries (railings, text). Example: EEDI3 per-field on thin-line animation that QTGMC softened.' },
        ],
        emit: (p) =>
            '# EEDI3 alt: edge-directed interpolation per field (not QTGMC).\n' +
            '# Pair with a decimator for single-rate; field=1 = TFF.\n' +
            `clip = core.eedi3m.EEDI3(core.std.SeparateFields(clip, tff=${num(p, 'field', 1) === 0 ? 'False' : 'True'}), field=${num(p, 'field', 1)})\n`,
        template: () =>
            '# EEDI3 alt: edge-directed interpolation per field (not QTGMC).\n' +
            '# Pair with a decimator for single-rate; field=1 = TFF.\n' +
            'clip = core.eedi3m.EEDI3(core.std.SeparateFields(clip, tff=True), field=1)\n',
    },
    tweak: {
        type: 'tweak', label: 'Levels / Saturation (Tweak)',
        purpose: 'Simple levels/saturation/brightness via the PYTHON adjust helper (adjust.Tweak) — the verified safe path (the native core.adjust plugin hard-aborts on this input type).',
        params: [
            { key: 'sat', label: 'Saturation', kind: 'range', min: 0, max: 2, step: 0.05, default: 1.1, unit: '',
                help: '1.0 = untouched. Example: faded VHS chroma → 1.1–1.2 restores punch; above 1.3 chroma noise amplifies visibly. Set with the vectorscope or Pipeline tab open, not by eye alone.' },
            { key: 'cont', label: 'Contrast', kind: 'range', min: 0, max: 2, step: 0.05, default: 1.05, unit: '',
                help: '1.0 = untouched. Example: washed broadcast tape → 1.05–1.15. Above ~1.2 clips highlights — check the histogram for crushed peaks before committing.' },
            { key: 'bright', label: 'Brightness', kind: 'range', min: -0.5, max: 0.5, step: 0.01, default: 0, unit: '',
                help: 'Additive lift. Use small values for black-level trims only — big shifts belong in the Resolve color pipeline (node order: this chain runs BEFORE Resolve grading), so prefer grading there.' },
        ],
        emit: (p) => {
            const bright = num(p, 'bright', 0);
            const brightArg = bright !== 0 ? `, bright=${Number(bright.toFixed(2))}` : '';
            return '# Tweak: simple levels op via the PYTHON adjust helper (safe path —\n' +
                '# the native core.adjust plugin hard-aborts on YUV422P10).\n' +
                `clip = adjust.Tweak(clip, sat=${Number(num(p, 'sat', 1.1).toFixed(2))}, cont=${Number(num(p, 'cont', 1.05).toFixed(2))}${brightArg})\n`;
        },
        template: () =>
            '# Tweak: simple levels op via the PYTHON adjust helper (safe path —\n' +
            '# the native core.adjust plugin hard-aborts on YUV422P10).\n' +
            'clip = adjust.Tweak(clip, sat=1.1, cont=1.05)\n',
    },
    ivtc: {
        type: 'ivtc', label: 'IVTC — 3:2 Pulldown',
        purpose: 'Field-match + decimate telecined film back to its native 23.976p cadence.',
        inputRequirements: 'TELECINED 29.97fps sources ONLY. NEVER run on native-interlaced or PAL material — this drops real frames there.',
        params: [
            { key: 'order', label: 'Field order', kind: 'enum', default: '0', options: ['0', '1'],
                help: '0 = BFF, 1 = TFF — MUST match the source or matching fails (combing survives). Example: a 1990s US DVD transfer with probe verdict BFF → 0. When NOT to use: if the probe verdict is uncertain, deinterlace instead; a wrong IVTC silently eats frames.' },
        ],
        emit: (p) =>
            '# IVTC: field-match each frame to its original progressive film frame\n' +
            '# (TFM), then drop the duplicated pulldown frames (TDecimate).\n' +
            `clip = core.tivtc.TFM(clip, order=${num(p, 'order', 0)})   # order=0 BFF / 1 TFF — set from probe\n` +
            'clip = core.tivtc.TDecimate(clip)      # 30000/1001 -> 24000/1001\n',
        template: () =>
            '# IVTC: field-match each frame to its original progressive film frame\n' +
            '# (TFM), then drop the duplicated pulldown frames (TDecimate).\n' +
            'clip = core.tivtc.TFM(clip, order=0)   # order=0 BFF / 1 TFF — set from probe\n' +
            'clip = core.tivtc.TDecimate(clip)      # 30000/1001 -> 24000/1001\n',
    },
    edgefixer_continuity: {
        type: 'edgefixer_continuity', label: 'EdgeFixer — Continuity Fix',
        purpose: 'Rebuild damaged edge ROWS (telecine switch noise, capture border tears) by interpolating from neighbouring rows.',
        params: [
            { key: 'top', label: 'Top rows', kind: 'range', min: 0, max: 8, step: 1, default: 2, unit: '',
                help: 'Rows replaced at the top edge. Example: VHS with a torn 2-line top border → top=2 removes it. 0 disables that edge.' },
            { key: 'left', label: 'Left rows', kind: 'range', min: 0, max: 8, step: 1, default: 0, unit: '',
                help: 'Columns replaced at the left edge. Use only for visible damage — over-use smears real picture content at the border.' },
            { key: 'right', label: 'Right rows', kind: 'range', min: 0, max: 8, step: 1, default: 0, unit: '',
                help: 'Columns replaced at the right edge. Example: head-switching noise at the bottom of tape is BOTTOM, not here.' },
            { key: 'bottom', label: 'Bottom rows', kind: 'range', min: 0, max: 8, step: 1, default: 0, unit: '',
                help: 'Rows replaced at the bottom edge — the classic VHS head-switching tear lives here. Example: bottom=4 for a 3–4 line tear.' },
            { key: 'radius', label: 'Radius', kind: 'range', min: 1, max: 10, step: 1, default: 3, unit: '', advanced: true,
                help: 'How far the interpolation may look for replacement values. Raise only if the fix looks smeary at low values; too high pulls in distant content.' },
        ],
        emit: (p) =>
            '# Continuity: replace damaged edge ROWS with interpolated values.\n' +
            '# left/top/right/bottom = number of edge rows to fix; 0 disables.\n' +
            `clip = core.edgefixer.Continuity(clip, left=${num(p, 'left', 0)}, top=${num(p, 'top', 2)}, right=${num(p, 'right', 0)}, bottom=${num(p, 'bottom', 0)}, radius=${num(p, 'radius', 3)})\n`,
        template: () =>
            '# Continuity: replace damaged edge ROWS with interpolated values.\n' +
            '# left/top/right/bottom = number of edge rows to fix; 0 disables.\n' +
            'clip = core.edgefixer.Continuity(clip, left=0, top=2, right=0, bottom=0, radius=3)\n',
    },
    tcomb: {
        type: 'tcomb', label: 'Dot-Crawl / Rainbow Comb',
        purpose: 'Comb filter for composite-video decoder artifacts: dot crawl on edges and cross-color rainbows. Chroma-only relief; luma untouched.',
        inputRequirements: '8-bit YUV — the generated script bounces to YUV420P8 and back automatically.',
        params: [
            { key: 'mode', label: 'Mode', kind: 'enum', default: '0', options: ['0', '1', '2'],
                help: '0 = both luma+chroma combs (standard); 1/2 = chroma-only variants for heavy cases. Example: a VHS composite capture with crawling dots on sharp edges → start 0; if luma softens, try the chroma-only mode.' },
            { key: 'fthreshl', label: 'Field gate (luma)', kind: 'range', min: 1, max: 64, step: 1, default: 12, unit: '', advanced: true,
                help: 'Difference gate for the FIELD pass. Lower = more aggressive; too low eats fine luma detail on motion. Raise if grain flickers.' },
            { key: 'fthreshc', label: 'Field gate (chroma)', kind: 'range', min: 1, max: 64, step: 1, default: 12, unit: '', advanced: true,
                help: 'Chroma gate for the field pass. Rainbows sit in chroma — raise this if colors shimmer; lower only when the comb is needed strongly.' },
            { key: 'othreshl', label: 'Frame gate (luma)', kind: 'range', min: 1, max: 64, step: 1, default: 24, unit: '', advanced: true,
                help: 'Gate for the FRAME pass (2x the field default). Usually leave at 2× the luma field gate.' },
            { key: 'othreshc', label: 'Frame gate (chroma)', kind: 'range', min: 1, max: 64, step: 1, default: 24, unit: '', advanced: true,
                help: 'Chroma gate for the frame pass. Example: persistent rainbow on red titles → lower othreshc gradually until it fades without desaturating.' },
        ],
        emit: (p) =>
            '# TComb: comb filter for dot crawl + cross-color (composite decoders).\n' +
            '# fthresh* = field gate, othresh* = frame gate; 8-bit input.\n' +
            `clip = core.tcomb.TComb(core.resize.Bicubic(clip, format=vs.YUV420P8), mode=${num(p, 'mode', 0)}, fthreshl=${num(p, 'fthreshl', 12)}, fthreshc=${num(p, 'fthreshc', 12)}, othreshl=${num(p, 'othreshl', 24)}, othreshc=${num(p, 'othreshc', 24)})\n`,
        template: () =>
            '# TComb: comb filter for dot crawl + cross-color (composite decoders).\n' +
            '# fthresh* = field gate, othresh* = frame gate; 8-bit input.\n' +
            'clip = core.tcomb.TComb(core.resize.Bicubic(clip, format=vs.YUV420P8), mode=0, fthreshl=12, fthreshc=12, othreshl=24, othreshc=24)\n',
    },
    smoothuv_derainbow: {
        type: 'smoothuv_derainbow', label: 'Chroma Derainbow',
        purpose: 'Spatially smooth CHROMA only — removes rainbow shimmer on high-contrast edges without touching luma detail.',
        inputRequirements: '8-bit YUV — the generated script bounces to YUV420P8 and back automatically.',
        params: [
            { key: 'radius', label: 'Radius', kind: 'range', min: 1, max: 10, step: 1, default: 3, unit: '',
                help: 'Neighbourhood size for chroma averaging. Example: thin rainbow lines on a bright edge → radius 3–4 clears them; too high smears colored detail (paintings, neon).' },
            { key: 'threshold', label: 'Threshold', kind: 'range', min: 1, max: 300, step: 1, default: 150, unit: '',
                help: 'Only chroma differences BELOW this are smoothed (higher = stronger). Example: stubborn rainbows → raise toward 200; if legitimate colors bleed together, come back down.' },
            { key: 'interlaced', label: 'Interlaced source', kind: 'bool', default: true,
                help: 'Keeps field structure while smoothing. TRUE for interlaced tape BEFORE deinterlacing; FALSE only for progressive material — wrong value smears fields together.' },
        ],
        emit: (p) =>
            '# SmoothUV: spatially smooth CHROMA only (rainbow shimmer).\n' +
            '# radius/threshold tune sensitivity; interlaced=True keeps field structure.\n' +
            `clip = core.smoothuv.SmoothUV(core.resize.Bicubic(clip, format=vs.YUV420P8), radius=${num(p, 'radius', 3)}, threshold=${num(p, 'threshold', 150)}, interlaced=${p.interlaced === undefined || p.interlaced === true ? 'True' : 'False'})\n`,
        template: () =>
            '# SmoothUV: spatially smooth CHROMA only (rainbow shimmer).\n' +
            '# radius/threshold tune sensitivity; interlaced=True keeps field structure.\n' +
            'clip = core.smoothuv.SmoothUV(core.resize.Bicubic(clip, format=vs.YUV420P8), radius=3, threshold=150, interlaced=True)\n',
    },
    removedirt: {
        type: 'removedirt', label: 'Dirt/Dust Restore',
        purpose: 'Replace brief high-motion blocks (dust specks, dirt, sparkle) with neighbouring low-motion content — the archival dust remover.',
        inputRequirements: '8-bit YUV — the generated script bounces to YUV420P8 and back automatically.',
        params: [
            { key: 'gmthreshold', label: 'Global motion gate', kind: 'range', min: 10, max: 200, step: 5, default: 80, unit: '',
                help: 'Frame-level motion gate: scenes moving more than this are skipped entirely (protects real motion). Example: locked-off camera with dust flicker → 80 default works; handheld footage → raise toward 120 or skip this filter.' },
            { key: 'mthreshold', label: 'Block motion gate', kind: 'range', min: 10, max: 200, step: 5, default: 80, unit: '',
                help: 'Per-block gate: blocks differing more than this from neighbours are replaced. Lower = removes more, but real small detail (falling snow, sparkles you WANT) also goes. When NOT to use: fast cuts or genuine small-object motion.' },
        ],
        emit: (p) =>
            '# RemoveDirt: replace HIGH-motion blocks with low-motion neighbours.\n' +
            '# gm/mthreshold = motion gates; 8-bit input.\n' +
            `clip = core.rdvs.RestoreMotionBlocks(core.resize.Bicubic(clip, format=vs.YUV420P8), core.resize.Bicubic(clip, format=vs.YUV420P8), gmthreshold=${num(p, 'gmthreshold', 80)}, mthreshold=${num(p, 'mthreshold', 80)})\n`,
        template: () =>
            '# RemoveDirt: replace HIGH-motion blocks with low-motion neighbours.\n' +
            '# gm/mthreshold = motion gates; 8-bit input.\n' +
            'clip = core.rdvs.RestoreMotionBlocks(core.resize.Bicubic(clip, format=vs.YUV420P8), core.resize.Bicubic(clip, format=vs.YUV420P8), gmthreshold=80, mthreshold=80)\n',
    },
    cst: {
        type: 'cst', label: 'Color Space Transform (CST)',
        purpose: 'Manual color-space transform: operator-stated input/output GAMUT (primaries), TRANSFER function, YUV↔RGB matrix and RANGE — mathematically explicit, float32 (RGBS) throughout. NO automatic detection (the OFX API exposes no node-input color metadata): Unknown stays unknown; the operator states the interpretation. Identity stages are skipped and labeled.',
        inputRequirements: 'Any chain format (YUV P16 or RGB float; alpha is not carried by the chain working formats — pre-existing composer behavior). Duration/FPS/dims unchanged.',
        params: [
            { key: 'inPrimaries', label: 'Input gamut', kind: 'enum', default: '709',
                options: ['709', '2020', 'p3d65', '170m'],
                help: 'Input PRIMARY chromaticities: 709=Rec.709/sRGB · 2020=Rec.2020 · p3d65=DCI-P3 (D65) · 170m=SMPTE-C (NTSC 525). This is the GAMUT, separate from transfer and YUV matrix. Unsupported pairs are rejected at emit time, never silently defaulted.' },
            { key: 'inTransfer', label: 'Input transfer', kind: 'enum', default: '1886',
                options: ['linear', '1886', '709oetf', 'srgb', 'pq', 'hlg'],
                help: 'Input TRANSFER decode → linear: 1886=BT.1886 display (2.4 power, LB=0) · 709oetf=BT.709 camera OETF · srgb=sRGB display · pq=SMPTE ST.2084 (normalized 0–1) · hlg=ARIB STD-B67. Unknown stays unknown — pick what the SOURCE actually uses.' },
            { key: 'inMatrix', label: 'Input YUV matrix', kind: 'enum', default: 'auto',
                options: Object.keys(CST_MATRICES),
                help: 'YUV↔RGB decode matrix: auto reads frame _Matrix props (VS default); explicit overrides are 601 (170m), 709, 2020 ncl, 470bg (PAL). RGB input ignores this (decode step is skipped).' },
            { key: 'inRange', label: 'Input range', kind: 'enum', default: 'auto',
                options: Object.keys(CST_RANGES),
                help: 'auto reads _ColorRange props; limited=TV swing (16–235 × bit depth); full=PC 0–max.' },
            { key: 'outPrimaries', label: 'Output gamut', kind: 'enum', default: '709',
                options: ['709', '2020', 'p3d65', '170m'],
                help: 'Output gamut for the ENCODE side. Same gamut as input → no gamut matrix (labeled).' },
            { key: 'outTransfer', label: 'Output transfer', kind: 'enum', default: '1886',
                options: ['linear', '1886', '709oetf', 'srgb', 'pq', 'hlg'],
                help: 'Output transfer encode (linear → signal). Same as input → no transfer curves (labeled).' },
            { key: 'outMatrix', label: 'Output matrix', kind: 'enum', default: '709',
                options: ['601', '709', '2020ncl', '470bg', 'rgb'],
                help: 'Output encode: explicit YUV matrix, or rgb = keep float RGBS (no YUV encode). Output must be EXPLICIT — no auto (an auto output would be a silent default).' },
            { key: 'outRange', label: 'Output range', kind: 'enum', default: 'limited',
                options: Object.keys(CST_RANGES),
                help: 'Output range (limited=TV, full=PC). auto = VS resize default.' },
            { key: 'outSubsampling', label: 'Output subsampling', kind: 'enum', default: '420',
                options: Object.keys(CST_OUT_FORMATS),
                help: 'YUV chroma subsampling for the output encode (ignored when output matrix = rgb): 420=YUV420P16 (chain default), 422, 444.' },
            { key: 'rangePolicy', label: 'Out-of-range policy', kind: 'enum', default: 'clamp',
                options: ['clamp', 'pass'], advanced: true,
                help: 'clamp (default): samples outside [0,1] are clamped BEFORE the transfer curves — otherwise the curve math is undefined and excursions would be lost. pass (advanced): preserve out-of-range values through the gamut matrix; PQ/HLG/pow WILL misbehave on them — opt-in only.' },
        ],
        emit: (p) => emitCstBody(p),
        template: () => cstTemplateBody(),
    },
    scdetect: {
        type: 'scdetect', label: 'Scene-Cut Detection',
        purpose: 'Marks shot boundaries in frame PROPERTIES only (_SceneChangePrev/_SceneChangeNext), so downstream filters that read those properties can gate temporal work at cuts. VERIFIED empirically: pixels are untouched; at a hard cut the frame before gets _SceneChangeNext=1 and the frame after gets _SceneChangePrev=1. It does NOT create Resolve timeline markers, does NOT split clips or make edits, and does NOT change the image by itself.',
        inputRequirements: 'Needs the misc plugin (installed by the documented plugin step). Only useful when LATER steps actually read _SceneChange* (QTGMC and motion-compensated interpolators/temporal denoisers do).',
        params: [
            { key: 'threshold', label: 'Threshold', kind: 'range', min: 0.01, max: 0.9, step: 0.01, default: 0.2, unit: '',
                help: 'Sensitivity (0–1). Example: a 1990s tape with hard cuts → 0.2 marks them; lower toward 0.1 also flags dissolves/fades, at the risk of false marks on heavy grain. LIMITS: it cannot help filters that ignore _SceneChange*, it never touches Resolve\'s timeline, and in single-frame preview the marks are computed exactly as in sequential evaluation (VapourSynth evaluates the neighbouring frames lazily). ORDER: place BEFORE deinterlace/interpolation so they see the marks.' },
        ],
        emit: (p) =>
            '# SCDetect: mark scene cuts in frame props (no pixel change by design).\n' +
            '# Run BEFORE interpolation/deinterlace so those filters gate on cuts.\n' +
            `clip = core.misc.SCDetect(clip, threshold=${Number(num(p, 'threshold', 0.2).toFixed(2))})\n`,
        template: () =>
            '# SCDetect: mark scene cuts in frame props (no pixel change by design).\n' +
            '# Run BEFORE interpolation/deinterlace so those filters gate on cuts.\n' +
            'clip = core.misc.SCDetect(clip, threshold=0.2)\n',
    },
    blockfps: {
        type: 'blockfps', label: 'Motion Interpolate (BlockFPS)',
        purpose: 'Motion-compensated frame-rate conversion — the classical CPU path (mvtools). Resamples frame rate by shifting blocks along estimated motion.',
        inputRequirements: 'PROGRESSIVE input (run AFTER deinterlace). Scene cuts should be marked (place after Scene-Cut Detection).',
        params: [
            { key: 'num', label: 'Target numerator', kind: 'range', min: 1, max: 120, step: 1, default: 24, unit: '',
                help: 'Target rate = num/den. Example: 25p → 24p → num=24, den=1; 25p → 23.976 → num=24000, den=1001. The script emits exactly these; the timeline must run the resulting rate.' },
            { key: 'den', label: 'Target denominator', kind: 'range', min: 1, max: 1001, step: 1, default: 1, unit: '',
                help: 'Denominator of the target rate. Keep 1 for integer targets; 1001 for NTSC-family rates (24000/1001).' },
            { key: 'mode', label: 'Blend mode', kind: 'range', min: 0, max: 3, step: 1, default: 3, unit: '', advanced: true,
                help: '0=copy, 1=blend, 2=worst, 3=best. Keep 3 (best motion compensation); lower only for debugging artifacts. Tradeoff: mode 3 is slowest — expect several × realtime on long clips.' },
        ],
        emit: (p) =>
            '# BlockFPS: motion-compensated resample of frame rate.\n' +
            'sup = core.mv.Super(clip, pel=2)\n' +
            'bw = core.mv.Analyse(sup, isb=True, delta=1)\n' +
            'fw = core.mv.Analyse(sup, isb=False, delta=1)\n' +
            '# Example 25p -> 24p; set num/den from your targets.\n' +
            `clip = core.mv.BlockFPS(clip, sup, bw, fw, num=${num(p, 'num', 24)}, den=${num(p, 'den', 1)}, mode=${num(p, 'mode', 3)})\n`,
        template: () =>
            '# BlockFPS: motion-compensated resample of frame rate.\n' +
            'sup = core.mv.Super(clip, pel=2)\n' +
            'bw = core.mv.Analyse(sup, isb=True, delta=1)\n' +
            'fw = core.mv.Analyse(sup, isb=False, delta=1)\n' +
            '# Example 25p -> 24p; set num/den from your targets.\n' +
            'clip = core.mv.BlockFPS(clip, sup, bw, fw, num=24, den=1, mode=3)\n',
    },
    rife: {
        type: 'rife', label: 'RIFE Interpolate (neural)',
        purpose: 'Neural frame interpolation (RIFE v4.4 via the vsmlrt ONNX adapter). Availability follows the live capability snapshot — install/verify from the Models tab first.',
        inputRequirements: 'FLOAT RGB; dimensions padded to ÷32 by the generated script and cropped back exactly. Run AFTER deinterlace.',
        params: [
            { key: 'multi', label: 'Frame multiplier', kind: 'range', min: 2, max: 8, step: 1, default: 2, unit: '×',
                help: 'Output frames per input frame. 2 doubles the rate IN THE SCRIPT — the OFX node still delivers on Resolve\'s timeline clock, so the TIMELINE rate must be planned for the multiplied output. Example: 25p→50p with a 50fps timeline. When NOT to use: never on interlaced input; never as a silent substitute for a decimation/IVTC request.' },
        ],
        emit: (p) =>
            '# RIFE neural interpolation (vsmlrt ONNX adapter + RIFE v4.4 weights).\n' +
            '# RIFE needs FLOAT RGB and dimensions divisible by 32 — bounce to RGB,\n' +
            '# pad, interpolate, crop back. Geometry/aspect are preserved exactly.\n' +
            'clip = to_rgb(clip, depth=32)\n' +
            '_pad_w = (-clip.width) % 32\n' +
            '_pad_h = (-clip.height) % 32\n' +
            'clip = core.std.AddBorders(clip, left=_pad_w // 2, right=_pad_w - _pad_w // 2,\n' +
            '                           top=_pad_h // 2, bottom=_pad_h - _pad_h // 2)\n' +
            'clip = vsmlrt.RIFE(clip, multi=' + num(p, 'multi', 2) + ', model=vsmlrt.RIFEModel.v4_4, backend=vsmlrt.Backend.ORT_CPU())\n' +
            'clip = core.std.Crop(clip, left=_pad_w // 2, right=_pad_w - _pad_w // 2,\n' +
            '                     top=_pad_h // 2, bottom=_pad_h - _pad_h // 2) if (_pad_w or _pad_h) else clip\n' +
            '# ORDER: run AFTER deinterlace (interpolating interlaced fields is wrong).\n' +
            '# multi=2 doubles frames IN THE SCRIPT; the OFX node still returns frames\n' +
            "# on Resolve's timeline clock — plan the timeline rate accordingly.\n",
        template: () =>
            '# RIFE neural interpolation (vsmlrt ONNX adapter + RIFE v4.4 weights).\n' +
            '# RIFE needs FLOAT RGB and dimensions divisible by 32 — bounce to RGB,\n' +
            '# pad, interpolate, crop back. Geometry/aspect are preserved exactly.\n' +
            'clip = to_rgb(clip, depth=32)\n' +
            '_pad_w = (-clip.width) % 32\n' +
            '_pad_h = (-clip.height) % 32\n' +
            'clip = core.std.AddBorders(clip, left=_pad_w // 2, right=_pad_w - _pad_w // 2,\n' +
            '                           top=_pad_h // 2, bottom=_pad_h - _pad_h // 2)\n' +
            'clip = vsmlrt.RIFE(clip, multi=2, model=vsmlrt.RIFEModel.v4_4, backend=vsmlrt.Backend.ORT_CPU())\n' +
            'clip = core.std.Crop(clip, left=_pad_w // 2, right=_pad_w - _pad_w // 2,\n' +
            '                     top=_pad_h // 2, bottom=_pad_h - _pad_h // 2) if (_pad_w or _pad_h) else clip\n' +
            '# ORDER: run AFTER deinterlace (interpolating interlaced fields is wrong).\n' +
            '# multi=2 doubles frames IN THE SCRIPT; the OFX node still returns frames\n' +
            "# on Resolve's timeline clock — plan the timeline rate accordingly.\n",
    },
    nnedi3_upscale: {
        type: 'nnedi3_upscale', label: 'Upscale — NNEDI3 ×2',
        purpose: 'Neural-network-style ×2 upscale in BOTH dimensions (dh doubling + transpose trick). The composer then fits the doubled frames to the TIMELINE size via Spline36.',
        inputRequirements: 'PROGRESSIVE input. field parity below stays 0 for progressive content.',
        params: [
            { key: 'field', label: 'Field parity', kind: 'enum', default: '0', options: ['0', '1'],
                help: '0/1 select which parity nnedi3 interpolates from. Keep 0 for progressive material (the normal case); flip to 1 only if a diagonal-artifact pattern appears on test frames. Example: 576i→ deinterlace FIRST, then this for 1152p→1080p delivery.' },
        ],
        emit: (p) =>
            '# NNEDI3 x2 BOTH dimensions: double height (dh=True), transpose, double\n' +
            '# again, transpose back. field=0/1 selects the interpolation parity —\n' +
            '# keep 0 for progressive content. No target-size placeholders: the\n' +
            "# composer's source-mode output stage then fits the doubled frames\n" +
            '# to the TIMELINE dimensions via Spline36 (set the timeline to your\n' +
            '# intended delivery resolution).\n' +
            `clip = core.nnedi3.nnedi3(clip, field=${num(p, 'field', 0)}, dh=True)\n` +
            'clip = core.std.Transpose(clip)\n' +
            `clip = core.nnedi3.nnedi3(clip, field=${num(p, 'field', 0)}, dh=True)\n` +
            'clip = core.std.Transpose(clip)\n',
        template: () =>
            '# NNEDI3 x2 BOTH dimensions: double height (dh=True), transpose, double\n' +
            '# again, transpose back. field=0/1 selects the interpolation parity —\n' +
            '# keep 0 for progressive content. No target-size placeholders: the\n' +
            "# composer's source-mode output stage then fits the doubled frames\n" +
            '# to the TIMELINE dimensions via Spline36 (set the timeline to your\n' +
            '# intended delivery resolution).\n' +
            'clip = core.nnedi3.nnedi3(clip, field=0, dh=True)\n' +
            'clip = core.std.Transpose(clip)\n' +
            'clip = core.nnedi3.nnedi3(clip, field=0, dh=True)\n' +
            'clip = core.std.Transpose(clip)\n',
    },
    unresize_debicubic: {
        type: 'unresize_debicubic', label: 'Unresize (Debicubic)',
        purpose: 'INVERT a bicubic upscale — recover the pre-upscale image when you know both the source and current dimensions. The descale runs on the FULL-RESOLUTION samples; only the pixel FORMAT is converted (YUV444PS), never the size.',
        inputRequirements: 'Only meaningful when the footage was genuinely bicubic-upscaled (e.g. DV→SD DVD flows). On natively-shot sizes this just softens.',
        params: [
            { key: 'width', label: 'Width (px)', kind: 'number', min: 16, max: 8192, step: 2, default: 320,
                help: 'The TRUE pre-upscale width (the descale TARGET is the full-resolution clip). Example: a 720-wide composite that was blown up from 320-wide analog → width=320 recovers the original sampling.' },
            { key: 'height', label: 'Height (px)', kind: 'number', min: 16, max: 8192, step: 2, default: 240,
                help: 'The TRUE pre-upscale height. Verify from the format history before trusting it — wrong values distort geometry, not just sharpness.' },
        ],
        // DATAFLOW (validated 2026-11-11): Debicubic must see the
        // FULL-RESOLUTION pixels — it reconstructs the pre-upscale sampling
        // from them. The previous emission first resized the clip DOWN to the
        // target size and then descaled at the same dimensions, discarding
        // the high-resolution samples before the inverse filter ran (a no-op
        // double step, not an inverse resize). Only the FORMAT converts here;
        // width/height/src_width/src_height passed to Debicubic are the
        // descale targets (src_* default to width/height in the plugin).
        emit: (p) =>
            `clip = core.descale.Debicubic(core.resize.Bicubic(clip, format=vs.YUV444PS), width=${num(p, 'width', 320)}, height=${num(p, 'height', 240)})\n`,
        template: () =>
            'clip = core.descale.Debicubic(core.resize.Bicubic(clip, format=vs.YUV444PS), width=320, height=240)\n',
    },
};

/** Is this step's code exactly what the schema would emit for its params?
 * Full-line comments are stripped before comparison (the templates carry
 * teaching comments; emit may or may not). False = CUSTOM (hand-edited
 * beyond the schema) — the panel must never overwrite it silently. */
export function stepMatchesSchema(schema: FilterSchema, params: Record<string, unknown>,
    code: string): boolean {
    if (!schema) return false;
    try {
        const stripComments = (s: string) => (s ?? '')
            .split('\n')
            .map(l => l.trim())
            .filter(l => l.length > 0 && !l.startsWith('#'))
            .join('\n')
            .trimEnd();
        return stripComments(schema.emit(params)) === stripComments(code);
    } catch {
        return false;
    }
}

/** The COMPLETE default parameter set for a schema-backed step (C07,
 * 2026-11-11). Seeded into newly added steps (App.tsx) and merged beneath
 * every structured edit (FilterParamsPanel), so the strict emitters always
 * receive every key they require — a sparse param set previously threw on
 * the FIRST edit of a freshly added CST step, before onChange could save
 * anything, and individual resets hit the same missing-parameter problem. */
export function schemaDefaults(type: string): Record<string, unknown> {
    const schema = FILTER_SCHEMAS[type];
    if (!schema) return {};
    const out: Record<string, unknown> = {};
    for (const p of schema.params) {
        if (p.default !== undefined) out[p.key] = p.default;
    }
    return out;
}