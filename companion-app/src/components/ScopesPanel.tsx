// Scopes — quantitative preview measurement with an HONESTY CONTRACT.
//
// Measurement domain (primary): NATIVE-DEPTH, signal-referred metrics computed
// in the render worker from the actual Source/Chain signal BEFORE the 8-bit
// display conversion. The payload carries FIXED-GRID sample-density
// WAVEFORM data (240 cols × 64 levels per plane) — the renderer draws
// conventional density waveforms (never min–max envelope fills, which painted
// solid bands where no samples exist).
//
// Waveform modes: Parade (R|G|B side by side, consistent vertical scales),
// Combined overlay, Luma (the payload's own labeled luma grid). No per-frame
// auto-normalization: density is relative to the per-column sample count
// (constant stride ⇒ a fixed scale — real signal changes stay visible).
//
// Vectorscope: 1× mapping is CALIBRATED so the payload's full chroma range
// fills the plot area; gain (2×/4×/8×) magnifies ONLY the trace around the
// center — the graticule, targets, labels and skin-tone line keep their 1×
// positions (stable reference geometry); out-of-bounds trace clips cleanly.
//
// Layout: right panel beside the viewer, width persisted (localStorage,
// SEPARATELY from recipes); a discoverable draggable divider on the left
// edge (pointer + keyboard); canvases RESIZE their REAL pixel resolution
// (ResizeObserver — plots gain resolution, not stretched bitmaps).
//
// Fallback honesty: three DISTINCT states — signal (normal), unavailable
// (with reason), and an EXPLICITLY CHOSEN 8-bit display-referred fallback.
// Never silent substitution. No subjective restoration-quality judgment.
// All processing is local; stale results rejected by the preview coordinator.
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Activity } from 'lucide-react';

export interface ScopePayload {
    domain: string;                 // 'signal-referred' | 'unavailable'
    format?: string;
    family?: 'YUV' | 'RGB' | 'GRAY';
    depth?: number;
    sampleType?: 'integer' | 'float';
    subsampleStride?: number;
    histBins?: number;
    histogram?: number[][];
    columns?: number[][][];         // per plane: [x, min, max, avg][]
    /** Fixed-grid sample-density waveform (240 cols × 64 levels per plane). */
    wave?: { cols: number; levels: number; planes: number[][][]; luma: number[][] | null; note?: string } | null;
    /** RGB ANALYSIS CONVENTION: actual R/G/B for BOTH source and chain —
     * YUV input is converted with VapourSynth resize (documented behavior)
     * using the source's frame props or the node's configured input matrix
     * as a LABELED controlled assumption. Like-for-like across modes. */
    rgb?: { basis: string; matrix?: string; range?: string;
            excursions?: { low: number; high: number };
            depth?: number; sampleType?: string;
            wave?: number[][][]; unavailable?: boolean } | null;
    /** Labeled luma profile (basis states its assumptions). */
    luma?: { basis: string; columns: number[][] } | null;
    chroma?: { size: number; grid: number[]; basis: string } | null;
    excursions?: { low: number; high: number };
    planeSamples?: Record<string, number>;
    note?: string;
    error?: string;
}

interface Props {
    /** Native-depth worker metrics for the CURRENT displayed frame. */
    payload: ScopePayload | null;
    /** Display PNG of the same frame — the FALLBACK measurement only. */
    dataUrl: string | null;
    label: 'source preview' | 'processed preview';
    frame: number;
    timeS: number;
    width: number;
    height: number;
    chainNote: string;
    displayMatrixAssumed?: string | null;
    /** Playback state — drives the honest live/retained label. */
    playing?: boolean;
    /** LIVE metrics-only refresh while playing (bounded ~1/s from the
     * preview coordinator; separate from the frame path). */
    liveScope?: { payload: unknown; frame: number; timeS: number; at: number } | null;
    /** Layout state (owned by the preview for render gating + persistence). */
    open: boolean;
    onToggle: (open: boolean) => void;
    panelWidth: number;
    onResize: (px: number) => void;
}

const PLANE_COLORS = ['rgba(255,80,80,0.8)', 'rgba(80,255,120,0.8)', 'rgba(90,140,255,0.8)'];
const canvasButtonStyle: React.CSSProperties = {
    padding: '5px 10px', background: '#160a24', border: '1px solid #3a2456',
    color: '#f0e6ff', borderRadius: 4, cursor: 'pointer', fontSize: 11, minHeight: 28,
    display: 'inline-flex', alignItems: 'center', gap: 4,
};
const PLANE_NAMES_YUV = ['Y', 'U', 'V'];
const PLANE_NAMES_RGB = ['R', 'G', 'B'];

const canvasStyle: React.CSSProperties = {
    background: '#0b0b10', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 4, width: '100%',
    display: 'block',
};

/** Real-resolution canvas hook: canvas pixels track the CSS box (no bitmap
 * stretching), redrawing the current view whenever the box resizes. */
function useResizingCanvas(
    draw: ((c: HTMLCanvasElement) => void) | null,
): React.MutableRefObject<HTMLCanvasElement | null> {
    const ref = useRef<HTMLCanvasElement | null>(null);
    useEffect(() => {
        const c = ref.current;
        if (!c || !draw) return;
        const apply = () => {
            const w = Math.max(80, Math.floor(c.clientWidth));
            const h = Math.max(60, Math.floor(c.clientHeight));
            if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
            draw(c);
        };
        apply();
        const ro = new ResizeObserver(apply);
        ro.observe(c);
        return () => ro.disconnect();
    }, [draw]);
    return ref;
}

export const ScopesPanel: React.FC<Props> = ({
    payload, dataUrl, label, frame, timeS, width, height, chainNote,
    displayMatrixAssumed, playing = false, liveScope = null,
    open, onToggle, panelWidth, onResize,
}) => {
    const fallbackRef = useRef<HTMLCanvasElement | null>(null);
    const [fallbackMetrics, setFallbackMetrics] = useState<{ low: number; high: number; fraction: number } | null>(null);

    // R7: DISPLAY preferences — persisted SEPARATELY from image-processing
    // recipes (localStorage vsres.scopes.* — never in the chain config).
    const [scopeView, setScopeView] = useState<'histogram' | 'waveform' | 'vector'>(() => {
        try {
            const v = typeof localStorage !== 'undefined' ? localStorage.getItem('vsres.scopes.view') : null;
            return v === 'waveform' || v === 'vector' ? v : 'histogram';
        } catch { return 'histogram'; }
    });
    const [waveMode, setWaveMode] = useState<'parade' | 'combined' | 'luma' | 'native'>(() => {
        try {
            const v = typeof localStorage !== 'undefined' ? localStorage.getItem('vsres.scopes.wavemode') : null;
            return v === 'combined' || v === 'luma' || v === 'native' ? v : 'parade';
        } catch { return 'parade'; }
    });
    const [vectorZoom, setVectorZoom] = useState<1 | 2 | 4 | 8>(() => {
        const v = Number(typeof localStorage !== 'undefined' ? localStorage.getItem('vsres.scopes.zoom') : 1);
        return v === 2 || v === 4 || v === 8 ? v : 1;
    });
    const [graticule, setGraticule] = useState(() =>
        (typeof localStorage !== 'undefined' ? localStorage.getItem('vsres.scopes.graticule') : null) !== '0');
    const [skinTone, setSkinTone] = useState(() =>
        (typeof localStorage !== 'undefined' ? localStorage.getItem('vsres.scopes.skintone') : null) === '1');
    const ls = useCallback((k: string, v: string) => {
        try { if (typeof localStorage !== 'undefined') localStorage.setItem(k, v); } catch { /* fine */ }
    }, []);
    useEffect(() => { ls('vsres.scopes.view', scopeView); }, [scopeView, ls]);
    useEffect(() => { ls('vsres.scopes.wavemode', waveMode); }, [waveMode, ls]);
    useEffect(() => { ls('vsres.scopes.zoom', String(vectorZoom)); }, [vectorZoom, ls]);
    useEffect(() => { ls('vsres.scopes.graticule', graticule ? '1' : '0'); }, [graticule, ls]);
    useEffect(() => { ls('vsres.scopes.skintone', skinTone ? '1' : '0'); }, [skinTone, ls]);

    const signal = payload && payload.domain === 'signal-referred' ? payload : null;
    // R6: three DISTINCT states — never blend them:
    //   signal          → native-depth worker metrics (the normal path)
    //   unavailable     → metrics failed/absent for THIS frame → honest state
    //   displayFallback → EXPLICITLY CHOSEN by the user (button below)
    const unavailable = !signal && !!payload && payload.domain !== 'signal-referred';
    const [displayFallback, setDisplayFallback] = useState(false);
    useEffect(() => { setDisplayFallback(false); }, [frame, timeS, label]);
    const downgraded = !signal && !unavailable && displayFallback && !!dataUrl;

    // FLICKER FIX (owner repro: during playback the panel alternated between
    // the plot and the empty prompt, every scope type): throttled playback
    // frames arrive with scopes=null, and the EMPTY state unmounted+remounted
    // the canvas each time. The plot now PERSISTS: keep the last valid signal
    // for this node/mode and mark it stale honestly — the canvas never
    // unmounts between updates; the empty prompt only shows when there has
    // never been a measurement for this label.
    const [lastSignal, setLastSignal] = useState<{ sig: ScopePayload; frame: number; timeS: number } | null>(null);
    useEffect(() => {
        if (signal) setLastSignal({ sig: signal, frame, timeS });
    }, [signal, frame, timeS]);
    useEffect(() => { setLastSignal(null); }, [label]);   // different node/mode → truly empty
    // LIVE DURING PLAYBACK: the coordinator pushes metrics-only payloads
    // (~1/s). Displayed with an honest LIVE label; if momentarily absent,
    // the last plot is retained and marked by its own frame/time (never
    // presented as current). Paused → the view's own payload (fresh).
    const liveSig = playing && liveScope?.payload && (liveScope.payload as ScopePayload).domain === 'signal-referred'
        ? liveScope.payload as ScopePayload : null;
    const retained = !signal && !unavailable && lastSignal ? lastSignal : null;
    const showSignal = signal ?? liveSig ?? retained?.sig ?? null;
    const isStale = playing
        ? !liveSig           // playing + no live payload → retained is stale
        : (!!retained && !signal);

    // ── Splitter: discoverable divider on the LEFT edge (pointer + keyboard).
    // The panel is position:relative so the divider renders on its edge; the
    // drag captures the pointer (release-outside safe) and clamps 240–640px.
    const drag = useRef<{ startX: number; startW: number } | null>(null);
    const onSplitterDown = (e: React.PointerEvent) => {
        drag.current = { startX: e.clientX, startW: panelWidth };
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    };
    const onSplitterMove = (e: React.PointerEvent) => {
        if (!drag.current) return;
        const next = Math.max(240, Math.min(640, drag.current.startW - (e.clientX - drag.current.startX)));
        onResize(next);
    };
    const onSplitterUp = (e: React.PointerEvent) => {
        drag.current = null;
        try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* fine */ }
    };
    const onSplitterKey = (e: React.KeyboardEvent) => {
        const step = e.shiftKey ? 64 : 16;
        if (e.key === 'ArrowLeft') { e.preventDefault(); onResize(Math.max(240, panelWidth + step)); }
        else if (e.key === 'ArrowRight') { e.preventDefault(); onResize(Math.min(640, panelWidth - step)); }
    };

    // ── Real-resolution canvases (per view) ──────────────────────────────
    const histDraw = useMemo(() => showSignal && scopeView === 'histogram'
        ? (c: HTMLCanvasElement) => drawPayloadHistogram(c, showSignal) : null, [showSignal, scopeView]);
    const waveDraw = useMemo(() => showSignal && scopeView === 'waveform'
        ? (c: HTMLCanvasElement) => drawPayloadWaveform(c, showSignal, waveMode) : null, [showSignal, scopeView, waveMode]);
    const vectorDraw = useMemo(() => showSignal && scopeView === 'vector'
        ? (c: HTMLCanvasElement) => drawPayloadVectorscope(c, showSignal, { zoom: vectorZoom, graticule, skinTone })
        : null, [showSignal, scopeView, vectorZoom, graticule, skinTone]);
    const histRef = useResizingCanvas(histDraw);
    const waveRef = useResizingCanvas(waveDraw);
    const vectorRef = useResizingCanvas(vectorDraw);

    // ── Fallback: measure the 8-bit DISPLAY PNG (labeled downgrade) ──
    useEffect(() => {
        if (!open || !downgraded || !dataUrl) { setFallbackMetrics(null); return; }
        let cancelled = false;
        const img = new Image();
        img.onload = () => {
            if (cancelled) return;
            const w = Math.min(512, img.naturalWidth || img.width);
            const h = Math.max(1, Math.round((img.naturalHeight || img.height) * (w / (img.naturalWidth || img.width))));
            const canvas = document.createElement('canvas');
            canvas.width = w; canvas.height = h;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            if (!ctx) return;
            ctx.drawImage(img, 0, 0, w, h);
            const d = ctx.getImageData(0, 0, w, h).data;
            let low = 0, high = 0;
            const n = w * h;
            for (let i = 0; i < d.length; i += 4) {
                if (d[i] === 0 || d[i + 1] === 0 || d[i + 2] === 0) low++;
                if (d[i] === 255 || d[i + 1] === 255 || d[i + 2] === 255) high++;
            }
            if (!cancelled) setFallbackMetrics({ low, high, fraction: (low + high > 0) ? (low + high) / n : 0 });
            const c = fallbackRef.current;
            if (c) drawFallbackHistogram(c, d, w, h);
        };
        img.src = dataUrl;
        return () => { cancelled = true; };
    }, [open, downgraded, dataUrl]);

    const axisLabel = useCallback(() => {
        if (!signal?.depth) return '';
        if (signal.sampleType === 'float') return 'normalized 0–1 (float)';
        return `code values 0–${(1 << (signal.depth || 8)) - 1} (${signal.depth}-bit)`;
    }, [signal]);

    // ── Collapsed: discoverable icon rail ──────────────────────────────────
    if (!open) {
        return (
            <div style={{ width: 34, display: 'flex', flexDirection: 'column', alignItems: 'center',
                justifyContent: 'flex-start', paddingTop: 8, borderLeft: '1px solid #2a1850', flexShrink: 0 }}>
                <button type="button" onClick={() => onToggle(true)} aria-expanded={false}
                    aria-label="Open Scopes (quantitative preview measurement)"
                    title="Scopes — histogram, sample-density waveform, vectorscope and clipping at native signal depth"
                    style={{ background: 'transparent', border: '1px solid #3a2456', borderRadius: 6,
                        padding: '8px 3px', cursor: 'pointer', color: '#9da3b4', minHeight: 64 }}>
                    <span style={{ writingMode: 'vertical-rl', fontSize: 11, letterSpacing: 1 }}>
                        <Activity size={11} aria-hidden="true" /> Scopes
                    </span>
                </button>
            </div>
        );
    }

    // F3: plot heights grow with the panel width (clamped 150–340px) so
    // widening the panel yields taller, more readable plots; the canvases
    // redraw at REAL resolution via ResizeObserver (no bitmap stretch).
    const plotH = Math.round(Math.max(150, Math.min(340, panelWidth * 0.72)));
    const waveH = Math.round(Math.max(170, Math.min(380, panelWidth * 0.8)));
    const planes = showSignal?.histogram?.length ?? 0;
    const names = (showSignal?.family === 'RGB' ? PLANE_NAMES_RGB : PLANE_NAMES_YUV);
    const lumaAvailable = !!(showSignal?.wave?.luma);

    return (
        <div style={{ width: panelWidth, minWidth: panelWidth, flexShrink: 0,
            borderLeft: '1px solid #2a1850', position: 'relative',
            display: 'flex', flexDirection: 'column', background: '#0d0716', minHeight: 0 }}>
            {/* Discoverable resize divider (left edge; pointer + keyboard). */}
            <div
                role="separator" aria-orientation="vertical" tabIndex={0}
                aria-label="Resize scopes panel (arrow keys)"
                onPointerDown={onSplitterDown} onPointerMove={onSplitterMove}
                onPointerUp={onSplitterUp} onPointerCancel={onSplitterUp}
                onKeyDown={onSplitterKey}
                title="Drag to resize · ◂ ▸ arrow keys"
                style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: 7,
                    cursor: 'col-resize', zIndex: 20,
                    background: 'rgba(58,36,86,0.35)',
                    borderLeft: '2px solid rgba(58,36,86,0.9)',
                    transition: 'border-color 0.12s' }} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px',
                borderBottom: '1px solid #2a1850', flexShrink: 0 }}>
                <Activity size={11} aria-hidden="true" />
                <strong style={{ fontSize: 11, color: '#ffc4f0' }}>Scopes</strong>
                <span style={{ flex: 1 }} />
                <button type="button" onClick={() => onToggle(false)} aria-expanded={false}
                    aria-label="Collapse Scopes" title="Collapse"
                    style={{ background: 'transparent', border: 'none', color: '#9da3b4', cursor: 'pointer', fontSize: 13 }}>
                    ▸
                </button>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: 8, fontSize: 10.5, color: '#8b93a7', minHeight: 0 }}>
                <div style={{ marginBottom: 6, lineHeight: 1.5 }}>
                    Measured: <strong style={{ color: '#c8d0e0' }}>{label}</strong>
                    {' '}· {playing
                        ? (liveSig
                            ? <span title="Metrics-only refresh ~1×/s while playing; the frame path is untouched">live · frame {liveScope?.frame} · {(liveScope?.timeS ?? 0).toFixed(2)}s (~1/s updates)</span>
                            : <span style={{ color: '#f4ce91' }}>last measurement (frame {lastSignal?.frame} · {lastSignal?.timeS.toFixed(2)}s) — next live update momentarily</span>)
                        : <>frame {frame} · {timeS.toFixed(2)}s</>} · {width}×{height}
                    <br />Chain: {chainNote}
                </div>
                {showSignal ? (
                    <>
                        <div style={{ marginBottom: 6, padding: '4px 6px', background: 'rgba(68,255,153,0.06)',
                            border: '1px solid rgba(68,255,153,0.25)', borderRadius: 4, lineHeight: 1.5 }}>
                            <strong style={{ color: '#7dffbb' }}>Signal-referred</strong> measurement at
                            {' '}{showSignal.depth}-bit {showSignal.format} ({showSignal.sampleType}) — taken BEFORE the 8-bit
                            display conversion, stride-subsampled (every {showSignal.subsampleStride}th row/col).<br />
                            Axis: {axisLabel()}. Excursions beyond range are counted, not clipped.
                            {displayMatrixAssumed ? ` Display conversion assumed matrix ${displayMatrixAssumed} (unlabeled source).` : ''}
                        </div>
                        <div role="group" aria-label="Scope view"
                            style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
                            {(['histogram', 'waveform', 'vector'] as const).map(v => (
                                <button key={v} type="button" onClick={() => setScopeView(v)}
                                    aria-pressed={scopeView === v}
                                    title={v === 'histogram' ? 'Per-plane histogram at native depth'
                                        : v === 'waveform' ? 'Sample-density waveform — image position → x, level → y'
                                        : 'Vectorscope — chroma occupancy with graticule options'}
                                    style={{ ...canvasButtonStyle, padding: '3px 8px', minHeight: 24,
                                        borderColor: scopeView === v ? '#ff2bd6' : '#3a2456',
                                        color: scopeView === v ? '#ffc4f0' : '#f0e6ff',
                                        fontWeight: scopeView === v ? 700 : 400 }}>
                                    {v === 'histogram' ? 'Histogram' : v === 'waveform' ? 'Waveform' : 'Vectorscope'}
                                </button>
                            ))}
                        </div>
                        {scopeView === 'histogram' && <>
                            <div style={{ marginBottom: 2 }}>Histogram ({axisLabel()}) — channels {names.slice(0, planes).join(' · ')}</div>
                            <canvas ref={histRef} style={{ ...canvasStyle, height: plotH }}
                                aria-label="Per-plane histogram at native signal depth" />
                        </>}
                        {scopeView === 'waveform' && <>
                            <div role="group" aria-label="Waveform mode"
                                style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 4 }}>
                                {(['parade', 'combined', 'luma', 'native'] as const).map(m => {
                                    const isYuv = showSignal?.family === 'YUV';
                                    const rgbAvailable = !!(showSignal?.rgb?.wave);
                                    const disabled = (m === 'luma' && !lumaAvailable)
                                        || (m === 'native' && !isYuv)
                                        || ((m === 'parade' || m === 'combined') && !rgbAvailable);
                                    return <button key={m} type="button" onClick={() => setWaveMode(m)}
                                        aria-pressed={waveMode === m}
                                        disabled={disabled}
                                        title={m === 'parade' ? 'RGB parade — ACTUAL R/G/B for both source and chain (like-for-like; YUV sources converted with the labeled matrix assumption)'
                                            : m === 'combined' ? 'RGB overlaid on one plot (same conversion as parade)'
                                            : m === 'native' ? 'Native Y/U/V planes (no RGB conversion — the raw file planes)'
                                            : showSignal?.luma?.basis ? `Luma — ${showSignal.luma.basis}`
                                                : 'Luma not available for this signal'}
                                        style={{ ...canvasButtonStyle, padding: '2px 8px', minHeight: 22, fontSize: 10,
                                            borderColor: waveMode === m ? '#ff2bd6' : '#3a2456',
                                            opacity: disabled ? 0.35 : 1,
                                            color: waveMode === m ? '#ffc4f0' : '#f0e6ff' }}>
                                        {m === 'parade' ? 'Parade R|G|B' : m === 'combined' ? 'Combined RGB'
                                            : m === 'native' ? 'Y/U/V native' : 'Luma'}
                                    </button>;
                                })}
                            </div>
                            <canvas ref={waveRef} style={{ ...canvasStyle, height: waveMode === 'parade' ? waveH : Math.round(waveH * 0.85) }}
                                aria-label="Sample-density waveform — image horizontal position on x, signal level on y" />
                            <div style={{ marginTop: 3, opacity: 0.6, lineHeight: 1.4 }}>
                                {showSignal.wave?.note || 'sample-density waveform'}
                                {waveMode === 'luma' && showSignal.luma ? ` · Luma basis: ${showSignal.luma.basis}` : ''}
                            </div>
                        </>}
                        {scopeView === 'vector' && <>
                            <div role="group" aria-label="Vectorscope display options"
                                style={{ display: 'flex', gap: 4, marginBottom: 4, flexWrap: 'wrap' }}>
                                <span aria-label="Trace gain (signal magnification; graticule stays at 1×)"
                                    title="Gain magnifies the TRACE only; targets/labels/skin line keep their 1× positions"
                                    style={{ fontSize: 10, opacity: 0.7, alignSelf: 'center' }}>gain</span>
                                {[1, 2, 4, 8].map(z => (
                                    <button key={z} type="button" onClick={() => setVectorZoom(z as 1 | 2 | 4 | 8)}
                                        aria-pressed={vectorZoom === z}
                                        title={`Trace magnification ${z}× — display only; measured values unchanged`}
                                        style={{ ...canvasButtonStyle, padding: '2px 8px', minHeight: 22, fontSize: 10,
                                            borderColor: vectorZoom === z ? '#ff2bd6' : '#3a2456',
                                            color: vectorZoom === z ? '#ffc4f0' : '#f0e6ff' }}>
                                        {z}×
                                    </button>
                                ))}
                                <button type="button" onClick={() => setGraticule(g => !g)} aria-pressed={graticule}
                                    title="R/G/B/C/M/Y target boxes (75% amplitude, Rec.709-derived graticule — matrix assumption labeled)"
                                    style={{ ...canvasButtonStyle, padding: '2px 8px', minHeight: 22, fontSize: 10,
                                        borderColor: graticule ? '#ff2bd6' : '#3a2456', color: graticule ? '#ffc4f0' : '#f0e6ff' }}>
                                    Graticule
                                </button>
                                <button type="button" onClick={() => setSkinTone(s => !s)} aria-pressed={skinTone}
                                    title="Approximate typical skin-hue line — a visual reference, NOT a skin detector or a requirement"
                                    style={{ ...canvasButtonStyle, padding: '2px 8px', minHeight: 22, fontSize: 10,
                                        borderColor: skinTone ? '#ff2bd6' : '#3a2456', color: skinTone ? '#ffc4f0' : '#f0e6ff' }}>
                                    Skin line
                                </button>
                            </div>
                            {showSignal.chroma ? (
                                <canvas ref={vectorRef}
                                    style={{ ...canvasStyle, width: '100%', maxWidth: Math.min(360, panelWidth - 24), aspectRatio: '1 / 1', margin: '0 auto' }}
                                    aria-label="Chroma vectorscope from native-depth samples with graticule" />
                            ) : <div style={{ opacity: 0.6 }}>(no chroma planes in this signal)</div>}
                            {showSignal.chroma && (
                                <div style={{ marginTop: 3, opacity: 0.6, lineHeight: 1.4 }}>
                                    {showSignal.chroma.basis}. Gain {vectorZoom}× magnifies the trace only —
                                    graticule stays at 1×.
                                </div>
                            )}
                        </>}
                        <div style={{ marginTop: 6, lineHeight: 1.6 }}>
                            Input: {showSignal.depth}-bit {showSignal.format} (native planes {names.slice(0, planes).join(' · ')})
                            {showSignal.rgb && !showSignal.rgb.unavailable && <><br />
                                Analysis: RGB — {showSignal.rgb.basis}</>}
                            {showSignal.rgb?.unavailable && <><br />
                                <span style={{ color: '#f4ce91' }}>RGB analysis unavailable: {showSignal.rgb.basis}</span></>}
                            <br />Range excursions (native): {showSignal.excursions?.low.toLocaleString()} below ·
                            {' '}{showSignal.excursions?.high.toLocaleString()} at/above range
                            {showSignal.rgb?.excursions && <>
                                {' '}· RGB (converted): {showSignal.rgb.excursions.low.toLocaleString()} below ·
                                {' '}{showSignal.rgb.excursions.high.toLocaleString()} above [0,1]</>}
                            <br />Sampled per native plane: {names.slice(0, planes)
                                .map((n, i) => `${n} ${(showSignal.planeSamples ?? {})[String(i)]?.toLocaleString() ?? '—'}`)
                                .join(' · ')}
                            {' '}(stride {showSignal.subsampleStride})
                        </div>
                    </>
                ) : unavailable ? (
                    <>
                        <div style={{ marginBottom: 6, padding: '4px 6px', background: 'rgba(255,196,94,0.08)',
                            border: '1px solid rgba(255,196,94,0.3)', borderRadius: 4, lineHeight: 1.5 }}>
                            <strong style={{ color: '#f4ce91' }}>Native measurement unavailable</strong> for this
                            frame{payload?.error ? `: ${payload.error}` : ' (no worker metrics arrived with it)'}.
                            This is NOT a display-referred measurement — nothing is substituted silently.
                        </div>
                        {dataUrl && (
                            <button type="button" onClick={() => setDisplayFallback(true)}
                                aria-label="Measure the displayed 8-bit image instead (explicit downgrade)"
                                style={{ ...canvasButtonStyle }}>
                                Measure displayed image instead (8-bit, display-referred)
                            </button>
                        )}
                    </>
                ) : downgraded ? (
                    <>
                        <div style={{ marginBottom: 6, padding: '4px 6px', background: 'rgba(255,196,94,0.08)',
                            border: '1px solid rgba(255,196,94,0.3)', borderRadius: 4, lineHeight: 1.5 }}>
                            <strong style={{ color: '#f4ce91' }}>Display-referred fallback</strong>: you chose to
                            measure the 8-bit displayed PNG. Not signal-referred;
                            {' '}10-bit distinctions are NOT visible here; native depth is NOT claimed.
                        </div>
                        <canvas ref={fallbackRef} style={{ ...canvasStyle, height: 110 }}
                            aria-label="Fallback 8-bit display-referred histogram" />
                        {fallbackMetrics && (
                            <div style={{ marginTop: 6, lineHeight: 1.6 }}>
                                Clipped pixels (display 8-bit): {fallbackMetrics.low.toLocaleString()} at 0 ·
                                {' '}{fallbackMetrics.high.toLocaleString()} at 255
                                ({(fallbackMetrics.fraction * 100).toFixed(2)}% of sampled pixels)
                            </div>
                        )}
                    </>
                ) : (
                    <div style={{ opacity: 0.7 }}>Identify a source and render a frame to measure it.</div>
                )}
                <div style={{ marginTop: 8, opacity: 0.55, lineHeight: 1.5 }}>
                    Measurements describe the selected preview signal — objective level/counts, not
                    restoration-quality judgments.
                </div>
            </div>
        </div>
    );
};

// ── Payload drawing helpers ────────────────────────────────────────────────
function drawPayloadHistogram(c: HTMLCanvasElement, p: ScopePayload) {
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const { width: w, height: h } = c;
    ctx.clearRect(0, 0, w, h);
    const bins = p.histBins ?? 256;
    const max = Math.max(1, ...(p.histogram ?? []).map(plane => Math.max(...plane)));
    (p.histogram ?? []).forEach((plane, pi) => {
        ctx.fillStyle = PLANE_COLORS[pi % 3];
        const bw = w / bins;
        for (let b = 0; b < plane.length; b++) {
            const bh = Math.round((plane[b] / max) * h);
            if (bh > 0) ctx.fillRect(Math.floor(b * bw), h - bh, Math.max(0.5, bw), bh);
        }
    });
}

/** Conventional SAMPLE-DENSITY waveform from the payload's fixed grids:
 * image horizontal position → x axis, signal level → y axis (0 at bottom),
 * per-cell density → coverage/opacity. No min–max envelope fills, no
 * auto-normalization (density is relative to the per-column sample count,
 * which is constant by construction) — a bright sky paints ONLY where
 * samples exist. Modes: parade (R|G|B side by side, one shared vertical
 * scale), combined overlay, luma grid. */
function drawPayloadWaveform(c: HTMLCanvasElement, p: ScopePayload,
                             mode: 'parade' | 'combined' | 'luma' | 'native') {
    const ctx = c.getContext('2d');
    if (!ctx || !p.wave) return;
    const { width: w, height: h } = c;
    ctx.clearRect(0, 0, w, h);
    const cols = p.wave.cols;
    const levels = p.wave.levels;

    const drawGrid = (grid: number[][], x0: number, gw: number, color: string) => {
        // Fixed scale: each sampled column contributes the SAME number of
        // samples, so cell density = count / perColumnTotal is directly
        // comparable across frames.
        let perColumnTotal = 0;
        for (let s = 0; s < grid.length && s < 3; s++) perColumnTotal = Math.max(perColumnTotal, 0);
        perColumnTotal = 0;
        for (const lvl of grid[0] ?? []) perColumnTotal += lvl;
        if (perColumnTotal <= 0) perColumnTotal = 1;
        ctx.fillStyle = color;
        const cw = Math.max(1, gw / cols);
        for (let gx = 0; gx < grid.length; gx++) {
            const column = grid[gx];
            for (let ly = 0; ly < column.length; ly++) {
                const count = column[ly];
                if (!count) continue;
                const alpha = Math.min(1, Math.pow(count / perColumnTotal, 0.45));
                const yTop = Math.round(h - ((ly + 1) / levels) * h);
                const yBot = Math.round(h - (ly / levels) * h);
                const xPix = Math.round(x0 + (gx / Math.max(1, cols - 1)) * gw);
                ctx.globalAlpha = 0.25 + 0.75 * alpha;
                ctx.fillRect(xPix, yTop, Math.max(1, cw), Math.max(1, yBot - yTop));
            }
        }
        ctx.globalAlpha = 1;
    };

    // F4: subtle horizontal LEVEL guides at 0/25/50/75/100% with readable
    // values in the signal's own convention (code values at native depth, or
    // normalized for float) — drawn UNDER the data, never over it.
    const drawLevelGuides = (x0: number, gw: number) => {
        ctx.strokeStyle = 'rgba(255,255,255,0.08)';
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.font = '8px sans-serif';
        ctx.setLineDash([2, 4]);
        const depth = p.depth ?? 8;
        const isFloat = p.sampleType === 'float';
        for (const frac of [0, 0.25, 0.5, 0.75, 1]) {
            const y = Math.round(h - frac * (h - 2)) - 1;
            ctx.beginPath();
            ctx.moveTo(x0, y); ctx.lineTo(x0 + gw, y); ctx.stroke();
            const label = isFloat ? frac.toFixed(2)
                : String(Math.round(frac * ((1 << depth) - 1)));
            if (frac > 0 && frac < 1) ctx.fillText(label, x0 + 2, y - 2);
        }
        ctx.setLineDash([]);
    };
    // RGB ANALYSIS CONVENTION: parade/combined measure the payload's RGB
    // grids — ACTUAL R/G/B derived identically for source (VS resize from
    // native YUV, labeled assumption) and chain (native RGB) — like-for-like.
    // 'native' mode shows the raw Y/U/V planes with truthful labels.
    const grids = (mode === 'native' ? (p.wave?.planes ?? [])
        : (p.rgb?.wave ?? p.wave?.planes ?? []));
    const labelsFor = (mode === 'native'
        ? (p.family === 'YUV' ? ['Y', 'U', 'V'] : PLANE_NAMES_RGB)
        : PLANE_NAMES_RGB);
    if (mode === 'parade' && grids.length >= 3) {
        // Separate R|G|B plots, CONSISTENT vertical scales (same grid → same
        // y mapping on every plot).
        const gap = 6;
        const gw = (w - gap * (grids.length - 1)) / grids.length;
        grids.forEach((g, i) => {
            const x0 = i * (gw + gap);
            drawLevelGuides(x0, gw);
            drawGrid(g, x0, gw, PLANE_COLORS[i]);
        });
        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        ctx.font = '9px sans-serif';
        grids.forEach((_, i) => {
            ctx.fillText(labelsFor[i] ?? `P${i}`, i * (gw + gap) + 2, 10);
        });
        // Level reference lines (0% and 100%) across the parade.
        ctx.strokeStyle = 'rgba(255,255,255,0.12)';
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.moveTo(0, h - 1); ctx.lineTo(w, h - 1);
        ctx.moveTo(0, 1); ctx.lineTo(w, 1);
        ctx.stroke();
        ctx.setLineDash([]);
    } else if (mode === 'luma' && p.wave?.luma) {
        drawLevelGuides(0, w);
        drawGrid(p.wave.luma, 0, w, 'rgba(240,230,255,0.9)');
        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        ctx.font = '9px sans-serif';
        ctx.fillText('L', 2, 10);
    } else {
        // Combined overlay (RGB convention when available; native for GRAY).
        drawLevelGuides(0, w);
        grids.forEach((g, i) => drawGrid(g, 0, w, PLANE_COLORS[i % 3]));
    }
    void cols; void levels;
}

/** Vectorscope: 1× CALIBRATED so the payload's full chroma range (u,v ∈
 * [-1,1] around neutral) fills the plot area. Gain magnifies ONLY the trace
 * around the center — the graticule, 75% target boxes, labels and the
 * approximate skin-tone line keep their 1× positions (stable reference
 * geometry); out-of-bounds trace clips cleanly. Circular geometry is
 * preserved in the rectangular panel (single scale factor, no independent
 * axis stretching). */
function drawPayloadVectorscope(c: HTMLCanvasElement, p: ScopePayload,
    opts: { zoom: number; graticule: boolean; skinTone: boolean }) {
    const ctx = c.getContext('2d');
    if (!ctx || !p.chroma) return;
    const { width: w, height: h } = c;
    ctx.clearRect(0, 0, w, h);
    const s = p.chroma.size;
    const cx = w / 2, cy = h / 2;
    // 1× base mapping: FULL chroma range fills the plot (calibrated — no
    // half-area waste). Trace scale multiplies by gain; references stay at base.
    const base = Math.min(w, h) / 2 - 2;
    const trace = base * (opts.zoom / 1);
    const ref = base;

    // Trace (gain-magnified, clipped to the plot).
    const max = Math.max(1, ...p.chroma.grid);
    ctx.fillStyle = 'rgba(140,220,120,0.8)';
    for (let gy = 0; gy < s; gy++) {
        for (let gx = 0; gx < s; gx++) {
            const v = p.chroma.grid[gy * s + gx];
            if (!v) continue;
            const u = ((gx + 0.5) / s) * 2 - 1;
            const vv = ((gy + 0.5) / s) * 2 - 1;
            const px = cx + u * trace, py = cy - vv * trace;
            if (px < -2 || px > w + 2 || py < -2 || py > h + 2) continue;  // clean clip
            ctx.globalAlpha = Math.min(1, 0.25 + (v / max) * 0.75);
            ctx.fillRect(px - 1.5, py - 1.5, 3, 3);
        }
    }
    ctx.globalAlpha = 1;
    if (opts.zoom > 1) {
        ctx.strokeStyle = 'rgba(255,255,255,0.18)';
        ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.font = '9px sans-serif';
        ctx.fillText(`trace gain ${opts.zoom}× (graticule at 1×)`, 4, h - 5);
    }

    // References at the 1× calibrated mapping — NEVER moved by gain.
    // F4: unobtrusive center dot (neutral chroma) + calibrated reference
    // circle at the graticule radius + subtle radial guides toward targets.
    if (opts.graticule) {
        ctx.fillStyle = 'rgba(255,255,255,0.45)';
        ctx.beginPath(); ctx.arc(cx, cy, 1.6, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.10)';
        ctx.beginPath(); ctx.arc(cx, cy, ref, 0, Math.PI * 2); ctx.stroke();
        ctx.strokeStyle = 'rgba(255,255,255,0.07)';
        const KR0 = 0.2126, KB0 = 0.0722;
        for (const [, R, G, B] of [
            ['R', 0.75, 0, 0], ['M', 0.75, 0, 0.75], ['B', 0, 0, 0.75],
            ['C', 0, 0.75, 0.75], ['G', 0, 0.75, 0], ['Y', 0.75, 0.75, 0],
        ] as [string, number, number, number][]) {
            const Y = KR0 * R + 0.7152 * G + KB0 * B;
            const u = 2 * 0.5 * (B - Y) / (1 - KB0);
            const v = 2 * 0.5 * (R - Y) / (1 - KR0);
            const tx = cx + u * ref, ty = cy - v * ref;
            ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(tx, ty); ctx.stroke();
        }
    }
    if (opts.graticule) {
        const KR = 0.2126, KB = 0.0722, A = 0.75;
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx.fillStyle = 'rgba(255,255,255,0.6)';
        ctx.font = '10px sans-serif';
        for (const [name, R, G, B] of [
            ['R', A, 0, 0], ['G', 0, A, 0], ['B', 0, 0, A],
            ['C', 0, A, A], ['M', A, 0, A], ['Y', A, A, 0],
        ] as [string, number, number, number][]) {
            const Y = KR * R + 0.7152 * G + KB * B;
            const u = 2 * 0.5 * (B - Y) / (1 - KB);
            const v = 2 * 0.5 * (R - Y) / (1 - KR);
            const px = cx + u * ref, py = cy - v * ref;
            ctx.strokeRect(px - 6, py - 6, 12, 12);
            ctx.fillText(name, px + 7, py + 3);
        }
    }
    if (opts.skinTone) {
        const angle = 123 * Math.PI / 180;
        const dx = Math.cos(angle), dy = Math.sin(angle);
        ctx.strokeStyle = 'rgba(255,170,140,0.5)';
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.moveTo(cx - dx * ref, cy + dy * ref);
        ctx.lineTo(cx + dx * ref, cy - dy * ref);
        ctx.stroke();
        ctx.setLineDash([]);
    }
}

function drawFallbackHistogram(c: HTMLCanvasElement, d: Uint8ClampedArray, w: number, h: number) {
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const { width: cw, height: ch } = c;
    ctx.clearRect(0, 0, cw, ch);
    const hist = [new Array(256).fill(0), new Array(256).fill(0), new Array(256).fill(0)];
    for (let i = 0; i < d.length; i += 4) {
        hist[0][d[i]]++; hist[1][d[i + 1]]++; hist[2][d[i + 2]]++;
    }
    void w; void h;
    const max = Math.max(1, ...hist.map(plane => Math.max(...plane)));
    hist.forEach((plane, pi) => {
        ctx.fillStyle = PLANE_COLORS[pi];
        plane.forEach((v, b) => {
            const bh = Math.round((v / max) * ch);
            if (bh > 0) ctx.fillRect(Math.floor(b * cw / 256), ch - bh, Math.max(1, cw / 256), bh);
        });
    });
}