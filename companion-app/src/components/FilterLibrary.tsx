// Filter Library sidebar — stage-grouped list of usable filter entries.
// User clicks a filter to add it to the chain; it auto-drops into its canonical stage.
// Collapsible (chevron toggle in header) — when collapsed shows a thin neon rail.
//
// TRUTH: `available: 'verified'` entries call ONLY probe-verified registered
// namespaces (scripts/probe_vs_plugins.py) and are usable as-is. 'missing'
// entries are curated-but-absent on this machine — badge says so and Add is
// disabled. 'separate-install' entries (RIFE) need an external runtime —
// labelled as such, never as a roadmap promise. The old fake
// "comingIn v2.1/v2.2" placeholders are gone: BM3D Metal IS registered
// today; RIFE needs vs-mlrt and is labelled by what it needs, not a version.

import React from 'react';
import { Plus, ChevronLeft, ChevronRight, Layers } from 'lucide-react';
import { STAGE_LABELS, STAGE_ORDER } from '../constants';
import type { FilterStage } from '../types';
import { cstTemplateBody } from '../../shared/cst-transform';

export interface LibraryEntry {
    type: string;
    label: string;
    stage: FilterStage;
    description: string;
    /** verified = probe-confirmed registered; missing = curated but absent
     *  here (Add disabled); separate-install = needs an external runtime. */
    availability: 'verified' | 'missing' | 'separate-install';
    /** Registered `core.<X>` namespaces this entry requires (for the probe). */
    requires?: string[];
    /** Template code for script-type entries. Params like {{SIGMA}} stay
     *  editable in the CodeMirror step editor. */
    template?: string;
    /** Binding to a shared/filter-schemas.ts entry: script steps added
     *  from this library entry carry params.schemaType so the schema
     *  panel renders structured controls for the step. */
    schemaType?: string;
}

export const FILTER_LIBRARY: LibraryEntry[] = [
    { type: 'script', label: 'Script', stage: 'preprocess', availability: 'verified',
      description: 'Freeform Python step. Stage is user-selectable.' },

    { type: 'script', label: 'Color Space Transform (CST)', stage: 'format', availability: 'verified', schemaType: 'cst',
      description: 'Manual color-space transform: explicit input/output gamut (primaries), transfer '
        + 'function, YUV matrix and range — float32 math, no auto detection of the node input '
        + '(the OFX API exposes none; Unknown stays unknown). Identity stages are skipped and labeled.',
      template: cstTemplateBody() },

    { type: 'qtgmc', label: 'QTGMC Deinterlace', stage: 'field-ops', availability: 'verified',
      requires: ['mv', 'nnedi3'],
      description: 'havsfunc.QTGMC — motion-compensated deinterlace with typed params. '
        + 'Single-rate (no bob) by default; double-rate for srestore workflows.' },

    { type: 'script', label: 'IVTC — 3:2 Pulldown', stage: 'field-ops', availability: 'verified', schemaType: 'ivtc',
      requires: ['tivtc'],
      description: 'TFM field-match + TDecimate — restore native 23.976p from telecined sources.',
      template: [
        '# IVTC: field-match each frame to its original progressive film frame',
        '# (TFM), then drop the duplicated pulldown frames (TDecimate).',
        'clip = core.tivtc.TFM(clip, order=0)   # order=0 BFF / 1 TFF — set from probe',
        'clip = core.tivtc.TDecimate(clip)      # 30000/1001 -> 24000/1001',
      ].join('\n') },

        { type: 'script', label: 'BM3D Denoise (Metal)', stage: 'denoise', availability: 'verified', schemaType: 'bm3dmetal',
      requires: ['bm3dmetal'],
      description: 'core.bm3dmetal.BM3D — block-matching 3D denoise, Metal-accelerated '
        + '(fastest on Apple Silicon). sigma≈2–5 keeps grain structure.',
      template: [
        '# BM3D spatial+temporal denoise. Metal build takes FLOAT RGB input:',
        '# bounce to RGBS with to_rgb, run BM3D, return to YUV after.',
        '# sigma: noise level estimate; start 3.0 and judge on real footage.',
        '# radius>0 enables the temporal (3D) pass — slower, better grain retention.',
        "clip = to_rgb(clip, depth=32)",
        'clip = core.bm3dmetal.BM3D(clip, sigma=[3.0, 3.0, 3.0], radius=0)',
        "clip = to_yuv(clip, css='420', depth=16)",
      ].join('\n') },

    { type: 'script', label: 'Deband', stage: 'restore', availability: 'verified', schemaType: 'neo_f3kdb',
      requires: ['neo_f3kdb'],
      description: 'core.neo_f3kdb.F3kdb — gradient debanding (sky/ramp banding).',
      template: [
        '# Deband: rebuild banded gradients with dithered noise.',
        '# range: band-detection range per plane; raise if banding survives.',
        'clip = core.neo_f3kdb.Deband(clip, range=15, y=64, cb=64, cr=64, grainy=0, grainc=0)',
      ].join('\n') },

        { type: 'script', label: 'Temporal Denoise', stage: 'denoise', availability: 'verified', schemaType: 'ttmpsm',
      requires: ['zsmooth'],
      description: 'core.zsmooth.TTempSmooth — temporal-only smoother for low-motion sources.',
      template: [
        '# Temporal-only denoise: averages similar frames, preserves grain.',
        '# maxr: temporal radius (frames); thresh: per-plane blend threshold.',
        'clip = core.zsmooth.TTempSmooth(clip, maxr=3, thresh=[6, 6, 6])',
      ].join('\n') },

        { type: 'script', label: 'Deblock', stage: 'restore', availability: 'verified', schemaType: 'deblock',
      requires: ['deblock'],
      description: 'core.deblock.Deblock — reduce H.264/MPEG block artifacts.',
      template: [
        '# Deblock: soften block edges from lossy sources.',
        'clip = core.deblock.Deblock(clip, quant=24)',
      ].join('\n') },

    { type: 'script', label: 'EdgeFixer — Continuity Fix', stage: 'restore', availability: 'verified', schemaType: 'edgefixer_continuity',
      requires: ['edgefixer'],
      description: 'core.edgefixer.ContinuityFixer — repair edge-row artifacts (telecine/border).',
      template: [
        '# Continuity: replace damaged edge ROWS with interpolated values.',
        '# left/top/right/bottom = number of edge rows to fix; 0 disables.',
        'clip = core.edgefixer.Continuity(clip, left=0, top=2, right=0, bottom=0, radius=3)',
      ].join('\n') },

    // ── NEW CAPABILITIES — all qualified through scripts/qualify_filters.py
    // (25/25 real-runtime PASS with effect + passthrough assertions) and
    // scripts/verify_templates.sh against the real tape. Honest blocked
    // entries are NOT added as usable: knlm (no OpenCL ICD),
    // dfttest2_gcc (crashes), native core.adjust (crashes — Python helper
    // is the verified safe path for Tweak). ──────────────────────────────

    { type: 'script', label: 'DFTTest Denoise', stage: 'denoise', availability: 'verified', schemaType: 'dfttest',
      requires: ['dfttest'],
      description: 'core.dfttest.DFTTest — frequency-domain spatial denoise on YUV (no RGB bounce; '
        + 'complementary to BM3D Metal: works at native chroma, lighter CPU).',
      template: [
        '# DFTTest: frequency-domain spatial denoise. tbsize=1 = spatial-only;',
        '# raise tbsize for temporal (needs clean motion or it smears).',
        'clip = core.dfttest.DFTTest(clip, tbsize=1, sigma=48.0)',
      ].join('\n') },

    { type: 'script', label: 'NLM Denoise (ISPC)', stage: 'denoise', availability: 'verified', schemaType: 'nlm_ispc',
      requires: ['nlm_ispc'],
      description: 'core.nlm_ispc.NLMeans — non-local-means denoise (ISPC SIMD; strongest measured '
        + 'noise reduction on the qualification fixture: 37.1→25.9 HF at h=8).',
      template: [
        '# NLMeans: non-local-means denoise. d/a/s = search window; h = strength.',
        '# Stronger per-dollar-of-quality than temporal smoothers on grainy sources.',
        'clip = core.nlm_ispc.NLMeans(clip, d=0, a=2, s=4, h=8.0)',
      ].join('\n') },

        { type: 'script', label: 'WNNM Denoise (heavy)', stage: 'denoise', availability: 'verified', schemaType: 'wnnm',
      requires: ['wnnm'],
      description: 'core.wnnm.WNNM — weighted nuclear-norm denoise (needs float32 input; slow, very '
        + 'high quality — for hero shots, not playback).',
      template: [
        '# WNNM: nuclear-norm denoise — float32 input, bounce back after.',
        '# sigma = noise level; VERY slow: reserve for critical sections.',
        "clip = core.resize.Bicubic(clip, format=vs.YUV420PS)",
        'clip = core.wnnm.WNNM(clip, sigma=[12.0, 12.0, 12.0])',
        'clip = core.resize.Bicubic(clip, format=vs.YUV420P16)',
      ].join('\n') },

        { type: 'script', label: 'Flicker Fix — Temporal', stage: 'denoise', availability: 'verified', schemaType: 'ttmpsm_flicker',
      requires: ['zsmooth'],
      description: 'core.zsmooth.TTempSmooth — gate-thresholded temporal smoother for STATIC-camera '
        + 'flicker (gates motion; verified on the static-flicker fixture).',
      template: [
        '# TTempSmooth: temporal averaging of SIMILAR frames only (gates motion).',
        '# maxr = temporal radius; thresh = blend gate; use on locked-off/shaky-free shots.',
        'clip = core.zsmooth.TTempSmooth(clip, maxr=3, thresh=[12, 12, 12], mdiff=[64, 64, 64])',
      ].join('\n') },

        { type: 'script', label: 'Ghost Removal', stage: 'restore', availability: 'verified', schemaType: 'lghost',
      requires: ['lghost'],
      description: 'core.lghost.LGhost — analog ghost/tap-echo reduction (mode/shift/intensity arrays).',
      template: [
        '# LGhost: subtract a shifted tap of the picture (analog VHS-style ghosting).',
        '# mode 2 = both polarities; shift 1 = one-pixel echo; intensity 12 = blend weight.',
        'clip = core.lghost.LGhost(clip, mode=[2, 2, 2], shift=[1, 1, 1], intensity=[12, 12, 12])',
      ].join('\n') },

    { type: 'script', label: 'Dot-Crawl / Rainbow Comb', stage: 'restore', availability: 'verified', schemaType: 'tcomb',
      requires: ['tcomb'],
      description: 'core.tcomb.TComb — dot-crawl and cross-color comb/rainbow removal (composite-video '
        + 'artifacts; 8-bit input).',
      template: [
        '# TComb: comb filter for dot crawl + cross-color (composite decoders).',
        '# fthresh* = field gate, othresh* = frame gate; 8-bit input.',
        "clip = core.tcomb.TComb(core.resize.Bicubic(clip, format=vs.YUV420P8), mode=0, fthreshl=12, fthreshc=12, othreshl=24, othreshc=24)",
      ].join('\n') },

    { type: 'script', label: 'Chroma Derainbow', stage: 'restore', availability: 'verified', schemaType: 'smoothuv_derainbow',
      requires: ['smoothuv'],
      description: 'core.smoothuv.SmoothUV — spatial chroma derainbow (rainbow shimmer on edges; '
        + 'luma untouched, 8-bit input).',
      template: [
        '# SmoothUV: spatially smooth CHROMA only (rainbow shimmer).',
        '# radius/threshold tune sensitivity; interlaced=True keeps field structure.',
        "clip = core.smoothuv.SmoothUV(core.resize.Bicubic(clip, format=vs.YUV420P8), radius=3, threshold=150, interlaced=True)",
      ].join('\n') },

    { type: 'script', label: 'Dirt/Dust Restore', stage: 'restore', availability: 'verified', schemaType: 'removedirt',
      requires: ['rdvs'],
      description: 'core.rdvs.RestoreMotionBlocks — RemoveDirt motion-block restoration (dust/dirt '
        + 'specks; 8-bit input).',
      template: [
        '# RemoveDirt: replace HIGH-motion blocks with low-motion neighbours.',
        '# gm/mthreshold = motion gates; 8-bit input.',
        "clip = core.rdvs.RestoreMotionBlocks(core.resize.Bicubic(clip, format=vs.YUV420P8), core.resize.Bicubic(clip, format=vs.YUV420P8), gmthreshold=80, mthreshold=80)",
      ].join('\n') },

        { type: 'script', label: 'Deinterlace — EEDI3 (alt)', stage: 'field-ops', availability: 'verified', schemaType: 'eedi3m',
      requires: ['eedi3m'],
      description: 'core.eedi3m.EEDI3 — edge-directed field interpolation, alternative to QTGMC for '
        + 'poor-motion-boundary material (per-field).',
      template: [
        '# EEDI3 alt: edge-directed interpolation per field (not QTGMC).',
        '# Pair with a decimator for single-rate; field=1 = TFF.',
        'clip = core.eedi3m.EEDI3(core.std.SeparateFields(clip, tff=True), field=1)',
      ].join('\n') },

    { type: 'script', label: 'Unresize (Debicubic)', stage: 'resize', availability: 'verified', schemaType: 'unresize_debicubic',
      requires: ['descale'],
      description: 'core.descale.Debicubic — invert a prior bicubic upscale (recover pre-upscale '
        + 'detail; float 444 input).',
      template: [
        '# Debicubic: invert a previous bicubic resize (undo broadcast upscaling).',
        '# width/height = the ORIGINAL pre-upscale dims; float 444 required.',
        "clip = core.descale.Debicubic(core.resize.Bicubic(clip, format=vs.YUV444PS, width=320, height=240), width=320, height=240, src_width=320, src_height=240)",
      ].join('\n') },

        { type: 'script', label: 'Levels / Saturation (Tweak)', stage: 'preprocess', availability: 'verified', schemaType: 'tweak',
      requires: [],
      // NOTE: the PYTHON adjust helper, not core.adjust — the native plugin
      // hard-aborts the process on this input (qualification finding).
      description: 'adjust.Tweak (Python helper) — sat/bright/cont levels. The native core.adjust '
        + 'plugin hard-crashes on this input type; the helper is the verified safe path.',
      template: [
        '# Tweak: simple levels op via the PYTHON adjust helper (safe path —',
        '# the native core.adjust plugin hard-aborts on YUV422P10).',
        'clip = adjust.Tweak(clip, sat=1.1, cont=1.05)',
      ].join('\n') },

    { type: 'script', label: 'Scene-Cut Detection', stage: 'frame-ops', availability: 'verified', schemaType: 'scdetect',
      requires: ['misc'],
      description: 'core.misc.SCDetect — writes _SceneChange* frame properties (used by QTGMC/interpolators; '
        + 'run BEFORE rate-changing steps).',
      template: [
        '# SCDetect: mark scene cuts in frame props (no pixel change by design).',
        '# Run BEFORE interpolation/deinterlace so those filters gate on cuts.',
        'clip = core.misc.SCDetect(clip, threshold=0.2)',
      ].join('\n') },

    { type: 'script', label: 'FFT3D Denoise', stage: 'denoise', availability: 'verified', schemaType: 'fft3dfilter',
      requires: ['fft3dfilter'],
      description: 'core.fft3dfilter.FFT3DFilter — frequency-domain 3D denoise (film grain, analog tape).',
      template: [
        '# FFT3DFilter: frequency-domain spatio-temporal denoise. sigma: noise',
        '# attenuation per frequency (0..); bt: temporal radius (0 = spatial only).',
        'clip = core.fft3dfilter.FFT3DFilter(clip, sigma=2.0, bt=3, bw=32, bh=32, ow=16, oh=16)',
      ].join('\n') },

    { type: 'script', label: 'CAS Sharpen', stage: 'sharpen', availability: 'verified', schemaType: 'cas',
      requires: ['cas'],
      description: 'core.cas.CAS — contrast-adaptive sharpen (no halos; sharpness 0..1).',
      template: [
        '# CAS: contrast-adaptive sharpen — sharpens edges without halo/ring.',
        '# sharpness 0.0..1.0 (0.4 is a natural start for restoration).',
        'clip = core.cas.CAS(clip, sharpness=0.4)',
      ].join('\n') },

    { type: 'script', label: 'Motion Interpolate (BlockFPS)', stage: 'frame-ops', availability: 'verified', schemaType: 'blockfps',
      requires: ['mv'],
      // The CLASSICAL bundled path. RIFE (neural) is a separate FilterLibrary
      // entry gated on the live capability snapshot (weights+adapter+backend+
      // load+inference); this entry never silently substitutes for a RIFE
      // request.
      description: 'core.mv.BlockFPS — motion-compensated frame-rate conversion (classical, CPU).',
      template: [
        '# BlockFPS: motion-compensated resample of frame rate.',
        'sup = core.mv.Super(clip, pel=2)',
        'bw = core.mv.Analyse(sup, isb=True, delta=1)',
        'fw = core.mv.Analyse(sup, isb=False, delta=1)',
        '# Example 25p -> 24p; set num/den from your targets.',
        'clip = core.mv.BlockFPS(clip, sup, bw, fw, num=24, den=1, mode=3)',
      ].join('\n') },

    { type: 'script', label: 'RIFE Interpolate (neural)', stage: 'frame-ops', availability: 'verified', schemaType: 'rife',
      requires: [],
      // RIFE availability is decided by the RUNTIME CAPABILITY SNAPSHOT, not a
      // static namespace probe: weights+adapter+backend+load+inference. The
      // effectiveAvailability override below degrades to 'missing' with the
      // exact missing component when inference is not verified.
      description: 'vsmlrt.RIFE — neural frame interpolation (ONNX). Availability reflects the '
        + 'live capability snapshot (weights → adapter → backend → load → inference); '
        + 'install/verify from the Models tab.',
      template: [
        '# RIFE neural interpolation (vsmlrt ONNX adapter + RIFE v4.4 weights).',
        '# RIFE needs FLOAT RGB and dimensions divisible by 32 — bounce to RGB,',
        '# pad, interpolate, crop back. Geometry/aspect are preserved exactly.',
        'clip = to_rgb(clip, depth=32)',
        '_pad_w = (-clip.width) % 32',
        '_pad_h = (-clip.height) % 32',
        "clip = core.std.AddBorders(clip, left=_pad_w // 2, right=_pad_w - _pad_w // 2,",
        "                           top=_pad_h // 2, bottom=_pad_h - _pad_h // 2)",
        "clip = vsmlrt.RIFE(clip, multi=2, model=vsmlrt.RIFEModel.v4_4, backend=vsmlrt.Backend.ORT_CPU())",
        "clip = core.std.Crop(clip, left=_pad_w // 2, right=_pad_w - _pad_w // 2,",
        "                     top=_pad_h // 2, bottom=_pad_h - _pad_h // 2) if (_pad_w or _pad_h) else clip",
        '# ORDER: run AFTER deinterlace (interpolating interlaced fields is wrong).',
        '# multi=2 doubles frames IN THE SCRIPT; the OFX node still returns frames',
        "# on Resolve's timeline clock — plan the timeline rate accordingly.",
      ].join('\n') },

    { type: 'script', label: 'Upscale — NNEDI3 ×2', stage: 'resize', availability: 'verified', schemaType: 'nnedi3_upscale',
      requires: ['nnedi3'],
      description: 'core.nnedi3.nnedi3 ×2 doubled upscale + Spline36 downscale to target.',
      template: [
        '# NNEDI3 x2 BOTH dimensions: double height (dh=True), transpose, double',
        '# again, transpose back. field=0/1 selects the interpolation parity —',
        '# keep 0 for progressive content. No target-size placeholders: the',
        "# composer's source-mode output stage then fits the doubled frames",
        '# to the TIMELINE dimensions via Spline36 (set the timeline to your',
        '# intended delivery resolution).',
        'clip = core.nnedi3.nnedi3(clip, field=0, dh=True)',
        'clip = core.std.Transpose(clip)',
        'clip = core.nnedi3.nnedi3(clip, field=0, dh=True)',
        'clip = core.std.Transpose(clip)',
      ].join('\n') },
];

interface Props {
    width: number;
    collapsed: boolean;
    onToggleCollapse: () => void;
    onAdd: (entry: LibraryEntry) => void;
    /** Probe-verified registered namespaces (runtime truth). When undefined
     *  (probe unavailable) the curated `availability` labels stand. */
    registeredNamespaces?: ReadonlySet<string>;
    /** Live neural capability snapshot (C09): RIFE's availability comes from
     *  here, never from the static labels. Unknown/unusable ⇒ 'missing'. */
    neural?: { rife?: { usable?: boolean } | null } | null;
}

export const FilterLibrary: React.FC<Props> = ({ width, collapsed, onToggleCollapse, onAdd, registeredNamespaces, neural }) => {
    if (collapsed) {
        return (
            <aside
                aria-label="Filter Library"
                style={{
                    width: 44,
                    flexShrink: 0,
                    background: '#0a0414',
                    borderRight: '1px solid #2a1850',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                }}
            >
                <button type="button" onClick={onToggleCollapse}
                    aria-label="Open Filter Library" aria-expanded={false}
                    title="Open Filter Library"
                    style={{
                        width: '100%', minWidth: 44, minHeight: 44, padding: '12px 0',
                        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10,
                        background: 'none', border: 'none', cursor: 'pointer',
                    }}>
                    <Layers size={16} color="#ff2bd6" />
                    <ChevronRight size={14} color="#666" />
                </button>
            </aside>
        );
    }

    return (
        <aside aria-label="Filter Library" style={{
            width,
            flexShrink: 0,
            borderRight: '1px solid #2a1850',
            background: '#0a0414',
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
        }}>
            <header style={{
                display: 'flex',
                alignItems: 'center',
                padding: '10px 12px 10px 14px',
                borderBottom: '1px solid rgba(255, 43, 214, 0.15)',
                position: 'sticky',
                top: 0,
                background: '#0a0414',
                zIndex: 1,
            }}>
                <h3 style={{
                    fontSize: 10, opacity: 0.55,
                    textTransform: 'uppercase', letterSpacing: 1.2,
                    margin: 0,
                    flex: 1,
                }}>
                    Filter Library
                </h3>
                <button type="button" aria-label="Collapse Filter Library" aria-expanded={true}
                    onClick={onToggleCollapse}
                    style={{
                        background: 'none', border: 'none',
                        color: '#999', cursor: 'pointer', padding: 2, minWidth: 44, minHeight: 44,
                    }}
                    title="Collapse"
                >
                    <ChevronLeft size={14} />
                </button>
            </header>

            <div style={{ padding: '8px 0' }}>
                {STAGE_ORDER.map(stage => {
                    const entries = FILTER_LIBRARY.filter(e => e.stage === stage);
                    if (entries.length === 0) return null;
                    return (
                        <div key={stage} style={{ marginBottom: 10 }}>
                            <div style={{
                                padding: '4px 14px 3px',
                                fontSize: 9,
                                opacity: 0.42,
                                textTransform: 'uppercase',
                                letterSpacing: 0.8,
                                color: '#a78bfa',
                            }}>
                                {STAGE_LABELS[stage]}
                            </div>
                            {entries.map(entry => (
                                <FilterRow key={`${entry.stage}:${entry.label}`}
                                    entry={entry}
                                    registeredNamespaces={registeredNamespaces}
                                    neural={neural}
                                    onAdd={onAdd} />
                            ))}
                        </div>
                    );
                })}
            </div>
        </aside>
    );
};

/** Probe-reconciled per-entry availability. 'verified' stands only when every
 *  required namespace is registered (or no requirement); curated entries
 *  whose requirements the probe contradicts degrade to 'missing' — the badge
 *  and Add-disable reflect runtime truth, not the static guide.
 *
 *  C09 (2026-11-11):
 *  - A known probe that lacks EVERY requirement degrades to 'missing' too —
 *    the static declared status can never keep such an entry 'verified'
 *    (CAS with an empty probe set used to show verified and stay addable).
 *    'separate-install' remains a distinct label only when NOTHING it
 *    requires is present (the honest "install it separately" case).
 *  - NEURAL OVERRIDE: RIFE's availability comes from the live capability
 *    snapshot (weights → adapter → backend → load → inference), never from
 *    a static namespace list. An unusable OR UNKNOWN snapshot is 'missing';
 *    nothing about RIFE may show verified without live inference evidence. */
export function effectiveAvailability(
    entry: LibraryEntry,
    registeredNamespaces?: ReadonlySet<string>,
    neural?: { rife?: { usable?: boolean } | null } | null,
): 'verified' | 'missing' | 'separate-install' {
    if (entry.schemaType === 'rife') {
        return neural?.rife?.usable === true ? 'verified' : 'missing';
    }
    if (registeredNamespaces && entry.requires?.length) {
        const allRegistered = entry.requires.every(ns => registeredNamespaces.has(ns));
        if (!allRegistered) {
            if (entry.availability === 'separate-install'
                && !entry.requires.some(ns => registeredNamespaces.has(ns))) {
                return 'separate-install';
            }
            return 'missing';
        }
        return entry.availability === 'missing' ? 'missing' : 'verified';
    }
    return entry.availability;
}

const AVAILABILITY_BADGE: Record<string, { text: string; title: string; bg: string; fg: string }> = {
    missing: {
        text: 'missing', title: 'Required plugin is not registered on this machine (runtime-probe-verified). Install it into the VapourSynth plugin path, then reopen.',
        bg: 'rgba(146, 80, 101, 0.25)', fg: '#ffc1ce',
    },
    'separate-install': {
        text: 'separate install', title: 'Requires an external runtime/model (not bundled). Install it separately; nothing is downloaded silently.',
        bg: 'rgba(130, 98, 46, 0.25)', fg: '#f4ce91',
    },
};

const FilterRow: React.FC<{
    entry: LibraryEntry;
    registeredNamespaces?: ReadonlySet<string>;
    neural?: { rife?: { usable?: boolean } | null } | null;
    onAdd: (e: LibraryEntry) => void;
}> = ({ entry, registeredNamespaces, neural, onAdd }) => {
    const availability = effectiveAvailability(entry, registeredNamespaces, neural);
    const usable = availability === 'verified';
    const badge = AVAILABILITY_BADGE[availability];
    return (
        <button
            onClick={() => usable && onAdd(entry)}
            disabled={!usable}
            title={`${entry.description}${badge ? `\n\n${badge.title}` : ''}`}
            style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                width: '100%',
                padding: '6px 14px',
                background: 'transparent',
                border: 'none',
                color: usable ? '#f0e6ff' : '#666',
                textAlign: 'left',
                cursor: usable ? 'pointer' : 'not-allowed',
                fontSize: 12,
                transition: 'background 0.1s',
            }}
            onMouseEnter={(e) => { if (usable) e.currentTarget.style.background = '#1a0830'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
        >
            {usable
                ? <Plus size={12} color="#ff2bd6" />
                : <span style={{ width: 12 }} />}
            <span style={{ flex: 1 }}>{entry.label}</span>
            {badge && (
                <span style={{
                    fontSize: 9,
                    padding: '1px 5px',
                    background: badge.bg,
                    border: '1px solid rgba(255, 255, 255, 0.12)',
                    borderRadius: 3,
                    color: badge.fg,
                    letterSpacing: 0.3,
                    whiteSpace: 'nowrap',
                }}>
                    {badge.text}
                </span>
            )}
        </button>
    );
};
