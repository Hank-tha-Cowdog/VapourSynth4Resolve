// Companion chain preview — DRAFT-WYSIWYG with latest-request-wins rendering.
//
// ARCHITECTURE (the fix for the live defects):
//   • The PROCESSED view renders the CURRENT EDITOR CHAIN via the companion-
//     side draft composer (shared/draft-composer — an exact mirror of the
//     native composer). Toggling a step, bypassing a filter or editing a
//     parameter re-renders immediately. Labeled DRAFT — never claimed as
//     applied; the accepted chain (host-composed) stays a distinct state shown
//     by provenance.
//   • A bypass pill per step (execution order) toggles `enabled` without
//     touching params/position/approval. Color is never the only signal:
//     each pill carries text (filter label), an eye/eye-off ICON and an
//     explicit aria state. All-off renders the source at the SAME content
//     moment (a chain with zero live steps composes to conversion-only —
//     by construction, not a special case).
//   • LATEST-REQUEST-WINS COORDINATOR: rapid toggles coalesce; the newest
//     desired state is retained while a render is in flight; obsolete
//     results are discarded by request id (an old completion can NEVER
//     overwrite a newer request); the last VALID frame stays visible with a
//     restrained indicator while the next result is pending; every render is
//     bounded (30s) and cancellable. Errors keep the last valid frame and
//     show the actual message; the chain is never silently substituted.
//   • Identity: cache key = node GUID + source path + time + mode + FULL chain
//     identity (step ids, params, stage, enabled, approved) + color
//     management + mix + timeline geometry. Any change invalidates. No
//     cross-node fallback: the draft is composed from this session's config;
//     the accepted-chain view requires THIS node's script file.
//   • TIME CONTRACT preserved: presentation-time driven; each mode resolves
//     via its own evaluated rational fps; A/B (hold-left, any zoom) compares
//     the same content moment; pan = middle-drag / Space+drag; wheel zoom;
//     Fit = Shift+Z. Bypassing a rate/geometry-changing step recomputes the
//     mapping through the draft's own evaluated fps — the moment is
//     preserved, not the output frame number.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw, Sun, Moon, AlertCircle, Play, Pause, Maximize2, Eye, EyeOff } from 'lucide-react';
import { BrailleSpinner } from './BrailleSpinner';
import { ScopesPanel } from './ScopesPanel';
import { composeDraftScript, isStepApproved } from '../../shared/draft-composer';
import type { NodeConfig, ChainStep } from '../types';

interface Props {
    config: NodeConfig;
    onChainChange?: (chain: ChainStep[]) => void;   // bypass persistence hook
    /** App registers the A/B toggle here so the Cmd+W native-menu accelerator
     *  can reach it; App guards tab-activeness + text-field focus. */
    onRegisterAbToggle?: (fn: (() => void) | null) => void;
}

type Mode = 'processed' | 'source';

interface Rendered {
    dataUrl: string;
    frame: number;
    total: number;
    fpsNum: number;
    fpsDen: number;
    durationS: number | null;
    timeS: number;
    width: number;
    height: number;
    provenance: string;
    scopes?: unknown;
    displayMatrixAssumed?: string | null;
}

const PLAY_TICK_MS = 40;    // wall-clock transport tick; frames render best-effort
// (25 ticks/s — measured renders: 8–30ms warm source/chain on the dev
// machine, so most ticks complete; the old 100ms tick visibly stuttered at
// ~10 renders/s. Timing stays 1×; dropped ticks are inherent best-effort.)

export const CompanionChainPreview: React.FC<Props> = ({ config, onChainChange, onRegisterAbToggle }) => {
    const [view, setView] = useState<Rendered | null>(null);
    const [pendingChain, setPendingChain] = useState<'idle' | 'rendering'>('idle');
    const [error, setError] = useState<string | null>(null);
    const [shownMode, setShownMode] = useState<Mode>('processed');
    const [timeInput, setTimeInput] = useState('0');
    const [playing, setPlaying] = useState(false);
    const playingRef = useRef(false);
    playingRef.current = playing;   // mirror for non-reactive readers
    const [zoom, setZoom] = useState({ scale: 1, tx: 0, ty: 0 });
    // Scopes layout state (persisted; open state gates scope WORK — the
    // worker computes metrics only when the panel is open).
    // LIVE SCOPE METRICS while playing (bounded ~1/s, non-blocking): a
    // SEPARATE metrics-only IPC refresh so playback frames stay metric-less
    // (fast) while the scopes panel shows genuinely LIVE measurements with an
    // honest rate label. Not the frame path; superseded results dropped.
    const [liveScope, setLiveScope] = useState<{ payload: unknown; frame: number; timeS: number; at: number } | null>(null);
    const liveScopeInflight = useRef(false);
    const [scopesOpen, setScopesOpen] = useState(() => {
        try { return (typeof localStorage !== 'undefined' ? localStorage.getItem('vsres.scopes.open') : null) === '1'; } catch { return false; }
    });
    const [scopesWidth, setScopesWidth] = useState(() => {
        const v = Number(typeof localStorage !== 'undefined' ? localStorage.getItem('vsres.scopes.width') : null);
        return Number.isFinite(v) && v >= 240 && v <= 640 ? v : 320;
    });
    useEffect(() => { try { if (typeof localStorage !== 'undefined') localStorage.setItem('vsres.scopes.open', scopesOpen ? '1' : '0'); } catch { /* fine */ } }, [scopesOpen]);
    useEffect(() => { try { if (typeof localStorage !== 'undefined') localStorage.setItem('vsres.scopes.width', String(scopesWidth)); } catch { /* fine */ } }, [scopesWidth]);

    // ── Coordinator state (refs: not part of render) ─────────────────────────
    const latestRequest = useRef(0);          // id of newest request
    const lastScopeMetricsAt = useRef(0);     // playback scope-throttle clock
    const completedRequest = useRef(0);       // id of newest COMPLETED result
    // C05 (2026-11-11): a COUNT, not a boolean — SOURCE priority dispatches a
    // second request while a processed render is still settling, so "busy"
    // must stay true until every dispatched render has settled.
    const inflight = useRef(0);
    const inflightMode = useRef<Mode | null>(null);   // mode of the newest dispatch
    const queuedResolve = useRef<null | (() => void)>(null);  // settle the coalesced caller
    const rerenderQueued = useRef<null | (() => void)>(null);
    const latest = useRef<{ timeS: number }>({ timeS: 0 });

    // ── Cache: identity = node + source + time + mode + chain + cm + mix ──
    // CORRECTNESS (2026-11-05, correctness review C04): trim in/out points and manualOrder
    // are part of the draft identity. They were previously missing from this
    // key, so changing the trim window or switching to manual ordering kept
    // the OLD preview (and skipped the re-render effect) — the component
    // showed the wrong source segment or filter order as current.
    const chainKey = useMemo(() => JSON.stringify({
        guid: config.nodeGuid ?? null,
        source: config.clipMetadata?.source?.filePath ?? null,
        trim: [config.clipMetadata?.source?.sourceInPoint ?? null,
               config.clipMetadata?.source?.sourceOutPoint ?? null],
        manualOrder: config.manualOrder ?? false,
        chain: config.chain.map(s => [s.id, s.params, s.stage, s.enabled, isStepApproved(s)]),
        cm: config.colorManagement,
        mix: config.mix,
        tl: [config.clipMetadata?.timeline?.width, config.clipMetadata?.timeline?.height],
    }), [config]);
    const cache = useRef<Map<string, Rendered>>(new Map());
    useEffect(() => { cache.current.clear(); }, [chainKey]);
    const sar = (config.clipMetadata?.source as { video?: { sampleAspectRatio?: string } } | undefined)
        ?.video?.sampleAspectRatio;
    // RGB ANALYSIS CONVENTION (scopes): map the node's configured input color
    // space to the conversion matrix string — the CONTROLLED assumption the
    // worker labels when a source leaves _Matrix unspecified. Same mapping
    // as the draft composer's matrixFor.
    const analysisMatrix = useMemo(() => {
        const cs = String(config.colorManagement?.inputColorSpace ?? 'Rec.709');
        if (cs.includes('2020')) return '2020ncl';
        if (cs.includes('601')) return '170m';
        // 709 / sRGB / DCI-P3 / unrecognized → 709 (the composer default;
        // labeled as an assumption by the worker when the source is YUV).
        return '709';
    }, [config.colorManagement?.inputColorSpace]);
    // Opening scopes re-measures the CURRENT frame at native depth.
    // NO inflight guard: if a render is busy, renderTime QUEUES this request
    // (latest-wins) — a guard here would skip the re-measure and leave the
    // panel on the cached scopes-null frame forever (race found in combined
    // test runs: open-while-rendering = permanent fallback display).
    useEffect(() => {
        if (scopesOpen) void renderTime(latest.current.timeS, shownMode);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [scopesOpen]);
    // PAUSE/SEEK → fresh scope measurement (the decoupling's other half):
    // playback frames carry no metrics (fast path); the moment playback
    // stops, measure the settled frame immediately.
    useEffect(() => {
        if (!playing && scopesOpen) void renderTime(latest.current.timeS, shownMode);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [playing]);
    // LIVE refresh loop (playing + panel open): metrics-only IPC every 1000ms
    // for the CURRENT shown time — the frame path is untouched; obsolete
    // completions (time moved on) are dropped by the timestamp check.
    useEffect(() => {
        if (!playing || !scopesOpen) { setLiveScope(null); return; }
        const tick = async () => {
            if (liveScopeInflight.current || !window.electron?.renderPreviewFrame) return;
            liveScopeInflight.current = true;
            const wantTime = latest.current.timeS;
            try {
                const r = await window.electron.renderPreviewFrame!({
                    time: wantTime, mode: shownMode,
                    sar, draftScript,
                    nodeGuid: config.nodeGuid,
                    scopes: true,
                    analysisMatrix,
                    metricsWorker: true,
                });
                if (r && r.ok && Math.abs((r.presentationTimeS ?? wantTime) - latest.current.timeS) < 0.75) {
                    setLiveScope({ payload: r.scopes ?? null, frame: r.frame ?? 0,
                        timeS: r.presentationTimeS ?? wantTime, at: performance.now() });
                }
            } catch { /* honest unavailable state shows via the panel */ }
            finally { liveScopeInflight.current = false; }
        };
        void tick();
        const timer = window.setInterval(() => void tick(), 1000);
        return () => { window.clearInterval(timer); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [playing, scopesOpen, shownMode, chainKey, analysisMatrix]);


    const timeline = {
        width: config.clipMetadata?.timeline?.width ?? 1920,
        height: config.clipMetadata?.timeline?.height ?? 1080,
    };

    // Draft script for the CURRENT chain (memoized with the chain identity).
    const draftScript = useMemo(() => {
        try {
            return composeDraftScript({
                manualOrder: config.manualOrder,
                mix: config.mix,
                chain: config.chain,
                colorManagement: config.colorManagement,
                clipMetadata: config.clipMetadata,
            } as never, timeline.width, timeline.height);
        } catch (e) {
            return `raise ValueError('draft compose failed: ${String(e).replace(/'/g, '')}')\n`;
        }
    }, [chainKey, config]); // eslint-disable-line react-hooks/exhaustive-deps

    const allOff = config.chain.every(s => !s.enabled || !isStepApproved(s));

    // ── Render one request through the coordinator ──────────────────────────
    const renderTime = useCallback(async (timeS: number, mode: Mode, opts?: { quiet?: boolean }) => {
        if (!window.electron?.renderPreviewFrame) {
            setError('Preview IPC unavailable in this build.');
            return;
        }
        // REQUESTED-TIME AUTHORITY (playhead-jump fix): `latest` tracks what
        // the USER asked for (scrub release position, transport tick target),
        // NOT the last rendered view. The old view-effect clobber made a
        // lagging quiet drag-render overwrite the playhead basis — release
        // then snapped the playhead to the stale render's time (drag right →
        // jump left). The playhead now stays at the requested position while
        // its frame decodes, and shows the matching frame when it lands.
        latest.current = { timeS };
        const key = `${chainKey}|${timeS.toFixed(3)}|${mode}`;
        if (cache.current.size > 24) {
            const oldest = cache.current.keys().next().value;
            if (oldest !== undefined) cache.current.delete(oldest);
        }
        // SCOPE/PLAYBACK DECOUPLING (measured: native metrics cost ~220ms per
        // 1080p frame — riding them along every 500ms of playback produced a
        // visible hitch twice a second). Per the owner's guidance, skipping
        // obsolete scope updates during PLAY is appropriate: while playing,
        // preview frames render WITHOUT metrics (pure fast path); the panel
        // retains the last plot with an honest stale badge; a pause/seek
        // triggers an immediate fresh measurement (see the playing-effect).
        // Playback timing is never sacrificed for scope work.
        const wantScopes = scopesOpen && !playingRef.current;
        const hit = cache.current.get(key);
        // R6: a cache entry rendered while scopes were CLOSED has no native
        // metrics — serving it with the panel open would silently fall back
        // to display-referred measurement. Re-render instead (scope-aware
        // cache bypass). Uses WANTSCOPES (the throttle-aware intent) so a
        // throttled playback render never re-caches a scope-less frame into
        // a bypass loop; paused/seeked frames always re-measure.
        const scopeStale = wantScopes && !(hit?.scopes as { domain?: string } | undefined)?.domain;
        if (hit && !scopeStale) {
            if (!opts?.quiet) { setView(hit); setShownMode(mode); setError(null); }
            return;
        }
        if (inflight.current > 0) {
            // C05 (2026-11-11) SOURCE PRIORITY: a SOURCE request must reach
            // main/worker IMMEDIATELY even while a processed render is in
            // flight — the worker preempts (stops) the processed render for
            // it (preview-worker.js source priority). Coalescing it here
            // starved that branch entirely: the source request never
            // dispatched until the processed render finished.
            const sourcePriority = mode === 'source' && inflightMode.current === 'processed';
            if (!sourcePriority) {
                // Coalescing queue for everything else. C05: advance the
                // latest token NOW — queued intent means the in-flight
                // completion is ALREADY obsolete (it must not publish); the
                // queued render claims its own fresh token when it starts.
                // The queued caller's promise settles when that render
                // starts — or immediately when superseded by an even newer
                // intent — instead of discarding its resolver.
                latestRequest.current += 1;
                return new Promise<void>((resolve) => {
                    queuedResolve.current?.();   // supersede: settle the older waiter
                    queuedResolve.current = resolve;
                    rerenderQueued.current = () => {
                        rerenderQueued.current = null;
                        const settle = queuedResolve.current;
                        queuedResolve.current = null;
                        void renderTime(timeS, mode, opts).finally(() => settle?.());
                    };
                });
            }
            // fall through: dispatch the source request now (worker preempts)
        }
        inflight.current += 1;
        inflightMode.current = mode;
        const request = ++latestRequest.current;
        if (!opts?.quiet) { setPendingChain('rendering'); setError(null); }
        const t0 = performance.now();
        // Honest renderer-side instrumentation (playback diagnostics): the
        // full in-app render round trip = IPC + main + worker + PNG dataUrl.
        // Exposed read-only for the CDP diagnostic harness; not used for
        // any behavior. window is not typed here — keep it untyped-safe.
        const w = window as unknown as { __vsresRenderStats?: { n: number; ms: number; max: number; lastAt: number } };
        if (!w.__vsresRenderStats) w.__vsresRenderStats = { n: 0, ms: 0, max: 0, lastAt: 0 };
        const stats = w.__vsresRenderStats;
        try {
            // ALL-OFF draft or source mode: the 'source' mode of the draft
            // script binds the same src — all-off processed == source at the
            // same moment by construction (conversion-only chain).
            const result = await window.electron.renderPreviewFrame!({
                time: timeS, mode,
                sar, draftScript,
                nodeGuid: config.nodeGuid,
                scopes: wantScopes,
                analysisMatrix,
            });
            inflight.current -= 1;   // this dispatch settled (C05: count-based)
            const dur = performance.now() - t0;
            stats.n += 1; stats.ms += dur; stats.lastAt = performance.now();
            if (dur > stats.max) stats.max = dur;
            if (result.ok) {
                const rendered: Rendered = {
                    dataUrl: result.dataUrl ?? '',
                    frame: result.frame ?? 0,
                    total: result.total ?? 0,
                    fpsNum: result.fpsNum ?? 0,
                    fpsDen: result.fpsDen ?? 1,
                    durationS: result.durationS ?? null,
                    timeS: result.presentationTimeS ?? timeS,
                    width: result.width ?? 0, height: result.height ?? 0,
                    provenance: result.provenance ?? 'draft',
                    scopes: (result as { scopes?: unknown }).scopes ?? null,
                    displayMatrixAssumed: (result as { displayMatrixAssumed?: string | null }).displayMatrixAssumed ?? null,
                };
                // PLAYBACK frames are transient: caching every played frame kept
                // 24 multi-megabyte dataUrls live (measured: GC pressure pushed
                // renders to 497ms max during a 10s play — the long-play stutter).
                // Paused/seeked frames (A/B holds, stepping, scrub release) still
                // cache for instant recall.
                //
                // C05 (2026-11-11): the cache write happens BEFORE the
                // obsolete/publish decision — an obsolete completion must not
                // PUBLISH, but its pixels are still valid for ITS key, so a
                // later queued intent with the same key hits the cache instead
                // of re-rendering (different keys still dispatch normally).
                if (!playingRef.current) cache.current.set(key, rendered);
                // LATEST-WINS: an obsolete completion NEVER overwrites.
                if (request < latestRequest.current) {
                    if (rerenderQueued.current) rerenderQueued.current();
                    return;
                }
                completedRequest.current = request;
                if (request === latestRequest.current) {
                    setView(rendered);
                    setShownMode(mode);
                    setError(null);
                    setTimeInput(rendered.timeS.toFixed(2));
                }
                setPendingChain('idle');
                if (rerenderQueued.current) rerenderQueued.current();
                return;
            }
            // Failure path — C05: an OBSOLETE failure stays silent (the newer
            // request owns the UI and the error display); only the current
            // request surfaces its message. Preemption (worker source
            // priority) settles exactly this way.
            if (request < latestRequest.current) {
                if (rerenderQueued.current) rerenderQueued.current();
                return;
            }
            // Keep the last valid frame; show the real message.
            setError(result.error ?? 'preview failed');
            setPendingChain('idle');
            if (rerenderQueued.current) rerenderQueued.current();
        } catch (e) {
            inflight.current -= 1;   // this dispatch settled (C05: count-based)
            if (request === latestRequest.current) {
                setError(e instanceof Error ? e.message : String(e));
                setPendingChain('idle');
            }
            if (rerenderQueued.current) rerenderQueued.current();
        }
    }, [chainKey, sar, config.nodeGuid, draftScript, scopesOpen]);

    // Re-render whenever the chain identity changes (toggles, params, bypass).
    useEffect(() => {
        void renderTime(latest.current.timeS, 'processed');
    }, [chainKey]); // eslint-disable-line react-hooks/exhaustive-deps

    // ── Bypass pills (per-step `enabled` toggle; params/position preserved) ─
    const toggleStep = useCallback((id: string) => {
        onChainChange?.(config.chain.map(s =>
            s.id === id ? { ...s, enabled: !s.enabled } : s));
    }, [config.chain, onChainChange]);
    const execOrder = useMemo(() =>
        (config.manualOrder ? config.chain : [...config.chain].sort((a, b) => a.stage - b.stage))
            .map(s => ({ ...s, label: typeof s.params?.label === 'string' && s.params.label ? s.params.label : s.type })),
        [config.chain, config.manualOrder]);

    // ── A/B hold + pan — SINGLE GESTURE OWNER ──────────────────────────
    // LIVE-RELEASE BUG (fixed): there used to be TWO pointerup effects. The
    // first cleared holding.current; the second then called restoreProcessed()
    // whose `if (!holding.current) return;` guard exited early — so releasing
    // the left button left the SOURCE image stuck on screen until the A/B
    // button was pressed. Also: blur cleared the flag without restoring, and
    // left-hold had no pointer capture (release outside the image could race).
    // ONE effect now owns gesture termination for every path (pointerup/
    // pointercancel anywhere, window blur, and capture is taken on BOTH hold
    // and pan so the release always routes here). The MOMENTARY hold is
    // separated from the PERSISTENT A/B toggle (baseMode): release restores
    // to the persistent choice, not always 'processed'.
    const holding = useRef(false);
    const panLast = useRef<{ x: number; y: number } | null>(null);
    const [spaceHeld, setSpaceHeld] = useState(false);
    const [baseMode, setBaseMode] = useState<Mode>('processed');
    const baseModeRef = useRef<Mode>('processed');
    baseModeRef.current = baseMode;
    const releaseGestures = useCallback(() => {
        const hadHold = holding.current;
        const hadPan = panLast.current !== null;
        holding.current = false;
        panLast.current = null;
        if (hadHold) void renderTime(latest.current.timeS, baseModeRef.current);
    }, [renderTime]);
    useEffect(() => {
        window.addEventListener('pointerup', releaseGestures);
        window.addEventListener('pointercancel', releaseGestures);
        window.addEventListener('blur', releaseGestures);
        return () => {
            window.removeEventListener('pointerup', releaseGestures);
            window.removeEventListener('pointercancel', releaseGestures);
            window.removeEventListener('blur', releaseGestures);
        };
    }, [releaseGestures]);
    useEffect(() => {
        const onDown = (e: KeyboardEvent) => {
            const t = e.target as HTMLElement | null;
            if (t?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
            if (e.code === 'Space') setSpaceHeld(true);
        };
        const onUp = (e: KeyboardEvent) => { if (e.code === 'Space') setSpaceHeld(false); };
        window.addEventListener('keydown', onDown);
        window.addEventListener('keyup', onUp);
        return () => { window.removeEventListener('keydown', onDown); window.removeEventListener('keyup', onUp); };
    }, []);

    const onImagePointerDown = (e: React.PointerEvent) => {
        const target = e.target as HTMLElement;
        if (target.closest('input, textarea, select, [contenteditable="true"]')) return;
        const panButton = e.button === 1 || (e.button === 0 && spaceHeld);
        if (panButton && zoom.scale !== 1) {
            e.preventDefault();
            panLast.current = { x: e.clientX, y: e.clientY };
            target.setPointerCapture?.(e.pointerId);
            return;
        }
        if (e.button !== 0) return;
        e.preventDefault();
        // Capture the pointer for the HOLD as well: the release — inside or
        // outside the image — always reaches the single release handler.
        target.setPointerCapture?.(e.pointerId);
        holding.current = true;
        setPlaying(false);
        void renderTime(latest.current.timeS, 'source');
    };
    const onImagePointerMove = (e: React.PointerEvent) => {
        const last = panLast.current;
        if (!last) return;
        setZoom(z => ({ ...z, tx: z.tx + (e.clientX - last.x), ty: z.ty + (e.clientY - last.y) }));
        panLast.current = { x: e.clientX, y: e.clientY };
    };

    // ── Zoom ────────────────────────────────────────────────────────────────
    const fit = useCallback(() => setZoom({ scale: 1, tx: 0, ty: 0 }), []);
    const onWheel = (e: React.WheelEvent) => {
        if ((e.target as HTMLElement).closest('input, textarea, select, [contenteditable="true"]')) return;
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
        setZoom(z => ({ ...z, scale: Math.min(8, Math.max(0.5, z.scale * factor)) }));
    };
    const onKeyDown = (e: React.KeyboardEvent) => {
        if ((e.target as HTMLElement).closest('input, textarea, select, [contenteditable="true"]')) return;
        if (e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'z') { e.preventDefault(); fit(); }
    };
    // Shift+Z = Fit — WINDOW-LEVEL while this component is mounted (the
    // Preview tab is active; the component unmounts on tab switch, so the
    // shortcut is scoped by mounting, NOT by requiring inner-container
    // focus). Text-field guard: typing capital Z in the script editor /
    // chat / time fields is NEVER intercepted. Deliberately NOT a menu
    // accelerator — a menu key equivalent would swallow the keystroke
    // before this guard could run.
    useEffect(() => {
        const onWinKeyDown = (e: KeyboardEvent) => {
            const t = e.target as HTMLElement | null;
            if (t?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
            if (e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'z') {
                e.preventDefault();
                fit();
            }
        };
        window.addEventListener('keydown', onWinKeyDown);
        return () => window.removeEventListener('keydown', onWinKeyDown);
    }, [fit]);
    // A/B toggle entry point for the native-menu accelerator (Cmd+W) routed
    // through App: flips the PERSISTENT baseMode and renders the new mode at
    // the current content moment. Registered up to App via onRegisterAbToggle.
    // Mode selection: switching NEVER waits behind an in-flight render (the
    // worker aborts a chain render for a source request; latest-wins drops
    // obsolete results). The segmented control shows the DISPLAYED mode.
    const selectMode = useCallback((next: Mode) => {
        if (baseModeRef.current === next) return;
        setBaseMode(next);
        playClock.current = null;
        if (playing) setPlaying(false);
        void renderTime(latest.current.timeS, next);
    }, [renderTime, playing]);
    const toggleAb = useCallback(() => {
        const next = baseModeRef.current === 'processed' ? 'source' : 'processed';
        setBaseMode(next);
        void renderTime(latest.current.timeS, next);
    }, [renderTime]);
    useEffect(() => {
        onRegisterAbToggle?.(toggleAb);
        return () => { onRegisterAbToggle?.(null); };
    }, [toggleAb, onRegisterAbToggle]);

    // ── Transport (time-driven) ─────────────────────────────────────────────
    // (view-effect clobber REMOVED — see the REQUESTED-TIME AUTHORITY note in
    // renderTime. latest.current is written only at request time.)
    const timeStep = 1 / ((view?.fpsNum ?? 25) / (view?.fpsDen ?? 1) || 25);
    // WALL-CLOCK PLAYBACK (the slow-playback fix): media time advances with
    // REAL elapsed time, not one-frame-per-render. The old transport advanced
    // 0.25s of media per completed render — a 25fps clip crawled at render
    // speed. Now frames render best-effort (single-flight, latest-wins) and
    // TIMING stays 1x regardless; choppiness is inherent and visible, timing
    // is never silently sacrificed. Scrubbing/mode changes pause + re-anchor.
    const playClock = useRef<{ wall: number; media: number } | null>(null);
    useEffect(() => {
        if (!playing) { playClock.current = null; return; }
        playClock.current = { wall: performance.now(), media: latest.current.timeS };
        const timer = window.setInterval(() => {
            if (inflight.current > 0 || holding.current) return;   // single-flight; the clock runs on
            const c = playClock.current; if (!c) return;
            const dur = view?.durationS ?? null;
            const target = c.media + (performance.now() - c.wall) / 1000;
            if (dur != null && target >= dur) {
                setPlaying(false);
                void renderTime(Math.max(0, dur - timeStep), shownMode);
                return;
            }
            void renderTime(target, shownMode);
        }, PLAY_TICK_MS);
        return () => window.clearInterval(timer);
    }, [playing, shownMode, renderTime, view?.durationS]);
    useEffect(() => { void renderTime(0, 'processed');
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const onGo = () => {
        const t = Number.parseFloat(timeInput);
        if (Number.isFinite(t) && t >= 0) { if (playing) setPlaying(false); void renderTime(t, shownMode); }
    };

    // ── Scrubbing (custom timeline) ────────────────────────────────────────
    // Playhead follows the pointer IMMEDIATELY (scrubTime state, decoupled
    // from render latency). SOURCE drags render latest-position-wins (the
    // worker makes source frames cheap); CHAIN drags keep the previous
    // processed frame and coalesce to ONE render on release (or the newest
    // release when several land back-to-back). Playback pauses on scrub.
    const [scrubTime, setScrubTime] = useState<number | null>(null);
    const scrubbing = useRef(false);
    const scrubLatest = useRef<number>(0);            // RELEASE TRUTH (ref —
    // state is batched and can be STALE in the up-handler closure; the
    // ref always holds the newest pointer position → the chosen time
    // SURVIVES release; no jump).
    const scrubMode = useRef<Mode>('processed');     // mode at drag START
    const trackRef = useRef<HTMLDivElement | null>(null);
    const lastScrubRender = useRef(0);
    const timeFromEvent = (clientX: number): number => {
        const el = trackRef.current;
        const dur = view?.durationS ?? 0;
        if (!el || dur <= 0) return 0;
        const r = el.getBoundingClientRect();
        return Math.max(0, Math.min(dur, ((clientX - r.left) / Math.max(1, r.width)) * dur));
    };
    const scrubRender = (t: number) => {
        // SOURCE scrub: latest-position-wins, throttled to the render pace —
        // a newer pointer position supersedes an unstarted older request.
        const now = performance.now();
        if (now - lastScrubRender.current < 60) return;
        lastScrubRender.current = now;
        void renderTime(t, 'source', { quiet: true });
    };
    const onTrackDown = (e: React.PointerEvent<HTMLDivElement>) => {
        if (!view) return;
        if (playing) setPlaying(false);
        scrubbing.current = true;
        scrubMode.current = shownMode;               // capture at drag START
        try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); }
        catch { /* capture unavailable (synthetic/test pointers) — release
            still routes here via pointerup on the track */ }
        const t = timeFromEvent(e.clientX);
        scrubLatest.current = t;
        setScrubTime(t);
        if (shownMode === 'source') scrubRender(t);
    };
    const onTrackMove = (e: React.PointerEvent<HTMLDivElement>) => {
        if (!scrubbing.current) return;
        const t = timeFromEvent(e.clientX);
        scrubLatest.current = t;
        setScrubTime(t);
        if (scrubMode.current === 'source') scrubRender(t);
    };
    const onTrackUp = (e: React.PointerEvent<HTMLDivElement>) => {
        if (!scrubbing.current) return;
        scrubbing.current = false;
        try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* not captured */ }
        const t = scrubLatest.current;              // REF — never stale
        setScrubTime(null);
        // Render the final selected frame exactly once on release, in the
        // mode the drag STARTED in (a mid-drag Source/Chain switch must not
        // redirect the release render). Playback stays PAUSED (intentional).
        void renderTime(t, scrubMode.current);
    };
    const onTrackKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (!view) return;
        const step = e.shiftKey ? 1 : timeStep;
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            e.preventDefault();
            if (playing) setPlaying(false);
            void renderTime(Math.max(0, latest.current.timeS + (e.key === 'ArrowLeft' ? -step : step)), shownMode);
        } else if (e.key === 'Home') { void renderTime(0, shownMode); }
        else if (e.key === 'End') { void renderTime(Math.max(0, (view.durationS ?? 0) - timeStep), shownMode); }
    };
    const onStep = (deltaT: number) => void renderTime(Math.max(0, latest.current.timeS + deltaT), shownMode);

    const draftLabel = allOff ? 'DRAFT · all steps bypassed — showing conversion-only chain'
        : 'DRAFT — current editor chain (not yet applied)';
    const provenanceNote = shownMode === 'source'
        ? `Source — pre-chain at display aspect${sar ? ` (SAR ${sar})` : ''}`
        : `${draftLabel}`;

    return (
        <section aria-label="Companion chain preview" style={{
            flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, background: '#000',
        }}>
            {/* BYPASS PILLS — execution order, per-step; icon+text+color+aria. */}
            {execOrder.length > 0 && (
                <div role="group" aria-label="Per-filter bypass controls (execution order)" style={{
                    display: 'flex', flexWrap: 'wrap', gap: 6, padding: '4px 10px',
                    borderBottom: '1px solid #2a1850', background: '#0d0716', flexShrink: 0,
                }}>
                    {execOrder.map((s) => {
                        const live = s.enabled && isStepApproved(s);
                        const Icon = live ? Eye : EyeOff;
                        return (
                            <button key={s.id} type="button"
                                onClick={() => toggleStep(s.id)}
                                aria-pressed={!s.enabled}
                                aria-label={`${live ? 'Bypass' : 'Enable'} ${s.label} (step stays in the chain with its settings; bypass is an editor state you can save)`}
                                title={`${s.label} — ${live ? 'click to bypass' : 'bypassed — click to enable'}. Bypass is an editor draft state: Save and Close publishes it. Approval is separate (${isStepApproved(s) ? 'approved' : 'draft/unapproved'}).`}
                                style={{
                                    display: 'inline-flex', alignItems: 'center', gap: 5,
                                    padding: '2px 9px', minHeight: 26, fontSize: 11,
                                    borderRadius: 11, cursor: 'pointer',
                                    border: `1px solid ${s.enabled ? 'rgba(68,255,153,0.4)' : 'rgba(255,85,119,0.4)'}`,
                                    background: s.enabled ? 'rgba(68,255,153,0.08)' : 'rgba(255,85,119,0.10)',
                                    color: s.enabled ? '#9be5a0' : '#ff8fa3',
                                    fontWeight: s.enabled ? 600 : 500,
                                }}>
                                <Icon size={11} aria-hidden="true" />
                                {s.label}
                                <span style={{ fontSize: 9, opacity: 0.6 }}>{s.enabled ? 'ON' : 'OFF'}</span>
                            </button>
                        );
                    })}
                </div>
            )}
            <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
            <div tabIndex={0} onKeyDown={onKeyDown} onWheel={onWheel}
                aria-label="Preview viewer — hold LEFT (any zoom) for same-time source; wheel zooms; Shift+Z fits; Cmd+W toggles A/B; middle-drag or Space+drag pans"
                style={{ flex: 1, position: 'relative', minHeight: 0, overflow: 'hidden',
                    background: '#000', cursor: zoom.scale !== 1 ? 'grab' : 'default', touchAction: 'none', outline: 'none' }}>
                {view?.dataUrl
                    ? <img src={view.dataUrl}
                        alt={`${provenanceNote}, ${view.timeS.toFixed(2)}s (frame ${view.frame})`}
                        draggable={false}
                        onPointerDown={onImagePointerDown}
                        onPointerMove={onImagePointerMove}
                        style={{
                            width: '100%', height: '100%', objectFit: 'contain', display: 'block',
                            userSelect: 'none', WebkitUserSelect: 'none',
                            transform: `translate(${zoom.tx}px, ${zoom.ty}px) scale(${zoom.scale})`,
                            transformOrigin: 'center', transition: 'transform 0.08s',
                        }} />
                    : <div role="status" style={{ padding: 32, color: '#e3d5f5', lineHeight: 1.6 }}>
                        {error ? <><AlertCircle size={14} aria-hidden="true" style={{ verticalAlign: -2 }} />{' '}
                            <strong>Preview error:</strong> {error}</>
                            : pendingChain === 'rendering'
                                ? <><BrailleSpinner size={12} /> Rendering the draft chain…</>
                                : 'Identify a source and render a frame to preview the chain.'}
                    </div>}
                {pendingChain === 'rendering' && view?.dataUrl && (
                    <div role="status" aria-label="Rendering in progress" style={{
                        position: 'absolute', top: 10, right: 10, padding: 4,
                        background: 'rgba(26, 8, 48, 0.85)', borderRadius: 4,
                        display: 'flex', alignItems: 'center', pointerEvents: 'none',
                    }}><BrailleSpinner size={10} /></div>
                )}
                {holding.current && (
                    <div role="status" style={{
                        position: 'absolute', top: 10, left: 10,
                        padding: '4px 10px', background: 'rgba(26, 8, 48, 0.85)',
                        border: '1px solid rgba(68, 255, 153, 0.4)', color: '#7dffbb',
                        borderRadius: 4, fontSize: 11, pointerEvents: 'none',
                    }}>SOURCE — same presentation time</div>
                )}
                {error && view?.dataUrl && (
                    <div role="alert" style={{
                        position: 'absolute', bottom: 10, left: 10, right: 10,
                        padding: '6px 10px', background: 'rgba(48, 26, 35, 0.92)',
                        border: '1px solid rgba(146, 80, 101, 0.5)', color: '#ffc1ce', fontSize: 11,
                        borderRadius: 4, pointerEvents: 'none',
                    }}>{error}</div>
                )}
            </div>
            <ScopesPanel
                payload={(view?.scopes ?? null) as import('./ScopesPanel').ScopePayload | null}
                dataUrl={view?.dataUrl ?? null}
                label={shownMode === 'source' ? 'source preview' : 'processed preview'}
                frame={view?.frame ?? 0}
                timeS={view?.timeS ?? 0}
                width={view?.width ?? 0}
                height={view?.height ?? 0}
                chainNote={view?.provenance === 'host' ? 'applied chain (host-rendered)'
                    : view?.provenance === 'host-legacy' ? 'applied chain (legacy shared file)'
                    : draftLabel}
                displayMatrixAssumed={view?.displayMatrixAssumed ?? null}
                playing={playing}
                liveScope={liveScope}
                open={scopesOpen}
                onToggle={setScopesOpen}
                panelWidth={scopesWidth}
                onResize={setScopesWidth}
            />
            </div>
            <div role="status" aria-label="Preview transport info" style={{
                padding: '3px 14px', fontSize: 11, color: '#b9a9d6',
                borderTop: '1px solid #2a1850', background: '#0d0716',
                display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', flexShrink: 0,
            }}>
                {/* R5 COMPACT: mode + time on one line; technical provenance
                    (draft semantics, SAR, upstream exclusions) moved to
                    on-demand title — the draft-vs-applied distinction stays
                    VISIBLE, just shorter. Truth is not removed. */}
                <strong title={provenanceNote}>{shownMode === 'source' ? 'Source · file preview' : 'Chain · editor draft (not applied)'}</strong>
                {view && <span title="Presentation time / duration (seconds)">{view.timeS.toFixed(2)}s{view.durationS != null ? ` / ${view.durationS.toFixed(2)}s` : ''}</span>}
                {view && <span title="Frame index / last frame of this signal">frame {view.frame}{view.total ? ` / ${view.total - 1}` : ''}</span>}
                {view && view.fpsDen ? <span title="Evaluated clip rate (fraction-exact)">{view.fpsNum}/{view.fpsDen} fps</span> : null}
                {playing && <span title="Frames render best-effort; timing stays 1× real time">playing (1× timing)</span>}
                {zoom.scale !== 1 && <span style={{ opacity: 0.8 }} title="Viewer zoom (Shift+Z fits)">zoom {zoom.scale.toFixed(2)}×</span>}
                <span style={{ opacity: 0.55, marginLeft: 'auto' }} title="Shortcuts: hold LEFT = same-time source (release restores); Shift+Z = fit; Cmd+W = toggle A/B (Preview tab, not while typing); wheel = zoom; middle-drag or Space+drag = pan. Cmd+W does NOT close this window — use Close / Save and close in the header.">
                    Shift+Z fits · Cmd+W A/B
                </span>
            </div>

            {/* R2b: the timeline owns a FULL-WIDTH row (its own bar) — never
                squeezed between transport controls. */}
            <div style={{ padding: '4px 14px', background: '#0d0716', flexShrink: 0 }}>
                <div ref={trackRef} data-testid="scrub-track"
                    role="slider" tabIndex={0}
                    aria-label="Timeline — drag to scrub; release renders the selected frame"
                    aria-valuemin={0} aria-valuemax={Math.max(view?.durationS ?? 0, 0)}
                    aria-valuenow={Number((scrubTime ?? latest.current.timeS).toFixed(2))}
                    aria-valuetext={`${(scrubTime ?? latest.current.timeS).toFixed(2)} of ${(view?.durationS ?? 0).toFixed(2)} seconds`}
                    onPointerDown={onTrackDown} onPointerMove={onTrackMove}
                    onPointerUp={onTrackUp} onPointerCancel={onTrackUp}
                    onKeyDown={onTrackKey}
                    style={{ position: 'relative', width: '100%', height: 24,
                        background: '#160a24', border: '1px solid #3a2456', borderRadius: 6,
                        cursor: view ? 'pointer' : 'default', touchAction: 'none' }}>
                    <div style={{ position: 'absolute', inset: '3px 0 3px 0', borderRadius: 4,
                        background: 'rgba(255,255,255,0.04)', overflow: 'hidden' }}>
                        <div style={{ position: 'absolute', top: 0, bottom: 0, left: 0,
                            width: `${Math.min(100, 100 * (scrubTime ?? latest.current.timeS) / Math.max(view?.durationS ?? 0, 0.001))}%`,
                            background: 'linear-gradient(90deg, rgba(138,43,226,0.35), rgba(255,43,214,0.35))' }} />
                        {/* Playhead: follows the pointer IMMEDIATELY; the RELEASE
                            position comes from the scrubLatest REF (never a stale
                            state closure — the release-jump fix). */}
                        <div style={{ position: 'absolute', top: 0, bottom: 0,
                            left: `calc(${Math.min(100, 100 * (scrubTime ?? latest.current.timeS) / Math.max(view?.durationS ?? 0, 0.001))}% - 2px)`,
                            width: 4, background: '#ff2bd6', borderRadius: 2,
                            boxShadow: '0 0 4px rgba(255,43,214,0.8)' }} />
                    </div>
                    {scrubbing.current && scrubMode.current === 'processed' && (
                        <span style={{ position: 'absolute', right: 6, top: 3, fontSize: 9,
                            color: '#b9a9d6', pointerEvents: 'none' }}>render on release</span>)}
                </div>
            </div>

            <div style={{
                padding: '6px 14px', borderTop: '1px solid #2a1850', background: '#0d0716',
                display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', fontSize: 12, flexShrink: 0,
            }}>
                <button type="button" onClick={() => setPlaying(p => !p)}
                    disabled={error != null && !view}
                    aria-label={playing ? 'Pause transport' : 'Play transport'} aria-pressed={playing} style={buttonStyle}>
                    {playing ? <Pause size={11} aria-hidden="true" /> : <Play size={11} aria-hidden="true" />}
                    {playing ? 'Pause' : 'Play'}
                </button>
                <button type="button" onClick={() => onStep(-timeStep)} disabled={pendingChain === 'rendering'} style={buttonStyle} aria-label="One displayed frame earlier">‹ Frame</button>
                <button type="button" onClick={() => onStep(timeStep)} disabled={pendingChain === 'rendering'} style={buttonStyle} aria-label="One displayed frame later">Frame ›</button>
                <input value={timeInput} onChange={e => setTimeInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') onGo(); }}
                    aria-label="Presentation time in seconds" inputMode="decimal" style={{
                        width: 64, padding: '4px 6px', background: '#160a24',
                        border: '1px solid #3a2456', color: '#f0e6ff', borderRadius: 4,
                    }} />
                <span style={{ opacity: 0.6 }}>s</span>
                <button type="button" onClick={onGo} disabled={pendingChain === 'rendering'} style={buttonStyle}>Go</button>
                <button type="button" onClick={() => void renderTime(latest.current.timeS, shownMode)}
                    disabled={pendingChain === 'rendering'} style={buttonStyle} aria-label="Re-render this time"><RefreshCw size={11} aria-hidden="true" /></button>
                <button type="button" onClick={fit} aria-label="Fit to viewer (Shift+Z)" style={buttonStyle}><Maximize2 size={11} aria-hidden="true" /> Fit</button>
                <span style={{ flex: 1 }} />
                <div role="group" aria-label="Preview mode — which signal is displayed"
                    style={{ display: 'inline-flex', border: '1px solid #3a2456', borderRadius: 6, overflow: 'hidden', flexShrink: 0 }}>
                    <button type="button" onClick={() => selectMode('source')} aria-pressed={baseMode === 'source'}
                        title="Source — the input BEFORE this plugin's processing: the original media file as identified to the plugin (upstream Resolve nodes/sizing/color are NOT included in the companion preview)."
                        style={segmentStyle(baseMode === 'source')}>
                        <Sun size={11} aria-hidden="true" /> Source
                    </button>
                    <button type="button" onClick={() => selectMode('processed')} aria-pressed={baseMode === 'processed'}
                        title="Chain — this plugin's processed output (the current filter chain)."
                        style={segmentStyle(baseMode === 'processed')}>
                        <Moon size={11} aria-hidden="true" /> Chain
                    </button>
                </div>
            </div>
        </section>
    );
};

const segmentStyle = (active: boolean): React.CSSProperties => ({
    padding: '4px 12px', minHeight: 30, fontSize: 12, display: 'inline-flex',
    alignItems: 'center', gap: 4, cursor: 'pointer',
    border: 'none',
    background: active ? 'rgba(255,43,214,0.22)' : 'transparent',
    color: active ? '#ffc4f0' : '#9da3b4',
    fontWeight: active ? 700 : 500,
    borderBottom: active ? '2px solid #ff2bd6' : '2px solid transparent',
});

const buttonStyle: React.CSSProperties = {
    padding: '4px 10px', background: '#160a24', border: '1px solid #3a2456',
    color: '#f0e6ff', borderRadius: 4, cursor: 'pointer', fontSize: 12, minHeight: 30,
    display: 'inline-flex', alignItems: 'center', gap: 4,
};