// Preview tab — request a render of the current chain against the OFX plugin's most
// recently cached source frame, display the resulting PNG.
//
// Flow:
//   1. User clicks Render Preview (or chain changes and we debounce-trigger automatically)
//   2. previewChain(chainJson, mix) sends a request to the OFX plugin's PreviewService
//   3. OFX plugin runs VS against the cached source, writes preview PNG
//   4. main process polls until the response file mtime changes, then base64-encodes
//   5. We set the dataUrl as the <img> src
//
// Phase 2 will replace this with IOSurface zero-copy for sub-frame latency. For Phase 1
// the PNG round-trip is sufficient — 1-frame previews of a typical chain land in
// roughly the time of a normal OFX render.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
    Sun, RefreshCw, AlertCircle, Pause, Play,
} from 'lucide-react';
import { BrailleSpinner } from './BrailleSpinner';
import type { NodeConfig } from '../types';
import { isStepApproved } from '../../shared/draft-composer';

interface Props {
    config: NodeConfig;
    unavailableReason?: string;
}

interface PreviewState {
    status: 'idle' | 'rendering' | 'ready' | 'error' | 'unconfirmed';
    dataUrl?: string;
    error?: string;
    elapsedMs?: number;
    lastMtime?: number;
}

function previewRequestErrorDetail(error: unknown): string {
    const fallback = 'No usable error details were returned.';
    try {
        const text = typeof error === 'string' ? error
            : error && typeof error === 'object' && 'message' in error
                && typeof error.message === 'string' ? error.message : fallback;
        if (!text.trim()) return fallback;
        const marker = '\n[details truncated]';
        return text.length > 4096 ? text.slice(0, 4096 - marker.length) + marker : text;
    } catch { return fallback; }
}

export const PreviewPanel: React.FC<Props> = ({ config, unavailableReason }) => {
    const [state, setState] = useState<PreviewState>({ status: 'idle' });
    const [dimPreview, setDimPreview] = useState(false);
    const inflight = useRef(false);

    const renderOnce = useCallback(async () => {
        if (unavailableReason || inflight.current) return;
        if (!window.electron?.previewChain || !window.electron?.readPreviewImage) {
            setState({ status: 'error', error: 'Preview IPC unavailable.' });
            return;
        }
        inflight.current = true;
        setState(s => ({ ...s, status: 'rendering' }));

        const t0 = performance.now();
        try {
            const result = await window.electron.previewChain(JSON.stringify(config), config.mix, 0);
            const elapsed = performance.now() - t0;

            if (!result.ok) {
                setState({ status: 'error', error: result.error ?? 'unknown error', elapsedMs: elapsed });
                inflight.current = false;
                return;
            }
            const img = await window.electron.readPreviewImage();
            if (!img.ok || !img.dataUrl) {
                setState({ status: 'error', error: img.error ?? 'read failed', elapsedMs: elapsed });
                inflight.current = false;
                return;
            }
            setState({
                status: 'ready',
                dataUrl: img.dataUrl,
                elapsedMs: elapsed,
                lastMtime: result.mtime,
            });
            inflight.current = false;
        } catch (error) {
            // Rejection does not establish native completion. Keep the local
            // admission held; no finally/reset/retry or cancellation inference.
            setState(s => ({
                ...s, status: 'unconfirmed', error: previewRequestErrorDetail(error),
                elapsedMs: performance.now() - t0,
            }));
        }
    }, [config, unavailableReason]);

    // Debounced auto-refresh when the chain or mix changes. 600 ms feels right for a
    // colorist iterating in a Script step (long enough that typing doesn't kick off a
    // render on every keystroke; short enough that pausing for a beat triggers one).
    // Only triggers when at least one step is enabled + approved — otherwise the
    // composer would emit a passthrough script and we'd waste a render cycle on
    // a no-op.
    const liveSteps = config.chain.filter(s => s.enabled && isStepApproved(s));
    const chainKey = JSON.stringify({
        chain: liveSteps.map(s => ({ id: s.id, params: s.params, stage: s.stage })),
        mix: config.mix,
        cm: config.colorManagement,
    });
    useEffect(() => {
        if (unavailableReason || liveSteps.length === 0) return;
        const t = setTimeout(() => { renderOnce(); }, 600);
        return () => clearTimeout(t);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [chainKey, unavailableReason]);

    // Retry once when the user first enters the Preview tab (component mount).
    // If a previous chainKey-triggered render failed because the source frame
    // wasn't cached yet, the user might have since scrubbed Resolve — try
    // again on tab entry so they don't have to manually click Render.
    useEffect(() => {
        if (unavailableReason || liveSteps.length === 0) return;
        if (state.status === 'ready') return;  // already have a frame
        const t = setTimeout(() => { renderOnce(); }, 200);
        return () => clearTimeout(t);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [unavailableReason]);

    // Auto-follow: while the Preview tab is mounted, poll the OFX-side render
    // every 2 s so the preview "follows" Resolve's playhead as the colorist
    // scrubs. Skipped while a render is in flight (no queue build-up) and when
    // the chain has no approved steps (passthrough). Toggle off with the
    // pause button in the footer.
    //
    // This is a stopgap until TKT-PREV ships a real transport (frame-number
    // request, pre-rendered cache, play/scrub/loop). Today's preview can only
    // show "the frame Resolve last rendered through the plugin" because that's
    // what the OFX-side cache contains — so the auto-follow tracks that.
    const [autoFollow, setAutoFollow] = useState(true);
    const hasLiveSteps = liveSteps.length > 0;
    useEffect(() => {
        if (unavailableReason || !autoFollow) return;
        if (!hasLiveSteps) return;
        const interval = setInterval(() => {
            if (inflight.current) return;
            renderOnce();
        }, 2000);
        return () => clearInterval(interval);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [autoFollow, hasLiveSteps, renderOnce, unavailableReason]);

    if (unavailableReason) return (
        <section aria-label="Frame preview unavailable" role="status" style={{
            flex: 1, padding: 32, color: '#e3d5f5', background: '#100a19', lineHeight: 1.6,
        }}>
            <h2 style={{ fontSize: 18 }}>Native preview unavailable</h2>
            <p>{unavailableReason}</p>
            <p>No preview request is sent from this view.</p>
        </section>
    );

    const requestHeld = state.status === 'unconfirmed';
    const renderDisabled = requestHeld || state.status === 'rendering' || config.chain.length === 0;
    return (
        <section aria-label="Frame preview" style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
            background: '#000',
        }}>
            <div style={{
                flex: 1,
                position: 'relative',
                background: '#000',
                minHeight: 0,
                overflow: 'hidden',
            }}>
                {state.dataUrl ? (
                    <img
                        src={state.dataUrl}
                        alt="Processed single-frame preview"
                        style={{
                            width: '100%',
                            height: '100%',
                            objectFit: 'contain',
                            display: 'block',
                            // Dimming changes display brightness only; no source image is available.
                            opacity: dimPreview ? 0.35 : 1,
                            transition: 'opacity 0.15s',
                        }}
                    />
                ) : (
                    <EmptyState status={state.status} error={state.error} />
                )}

                {state.status === 'rendering' && state.dataUrl && (
                    <div role="status" style={{
                        position: 'absolute',
                        top: 12, left: 12,
                        padding: '5px 10px',
                        background: 'rgba(26, 8, 48, 0.85)',
                        border: '1px solid rgba(255, 43, 214, 0.4)',
                        color: '#ff2bd6',
                        borderRadius: 4,
                        fontSize: 11,
                        display: 'flex', alignItems: 'center', gap: 6,
                        backdropFilter: 'blur(8px)',
                    }}>
                        <BrailleSpinner size={12} />
                        Waiting for preview… Previous preview still shown.
                    </div>
                )}

                {requestHeld && state.dataUrl && (
                    <div style={{
                        position: 'absolute', inset: 0, padding: 24,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        background: 'rgba(10, 4, 20, 0.72)',
                    }}>
                        <UnconfirmedPreviewNotice error={state.error} previousImage />
                    </div>
                )}

                <button
                    type="button"
                    onClick={() => setDimPreview(v => !v)}
                    aria-label="Dim preview"
                    aria-pressed={dimPreview}
                    disabled={!state.dataUrl}
                    style={{
                        position: 'absolute',
                        top: 12, right: 12,
                        padding: '6px 12px',
                        background: 'rgba(26, 8, 48, 0.85)',
                        border: '1px solid rgba(255, 43, 214, 0.4)',
                        color: '#f0e6ff',
                        borderRadius: 4,
                        cursor: state.dataUrl ? 'pointer' : 'not-allowed',
                        minHeight: 44,
                        fontSize: 11,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        backdropFilter: 'blur(8px)',
                    }}
                    title="Dims the processed image only. Source comparison is unavailable."
                >
                    <Sun size={12} aria-hidden="true" />
                    Dim preview
                </button>

                {/* Neither input route establishes the current playhead position here. */}
                {state.dataUrl && (
                    <div style={{
                        position: 'absolute',
                        bottom: 12, left: 12,
                        padding: '6px 10px',
                        background: 'rgba(26, 8, 48, 0.85)',
                        border: '1px solid rgba(196, 168, 255, 0.35)',
                        color: '#f0e6ff',
                        borderRadius: 4,
                        fontSize: 10,
                        lineHeight: 1.45,
                        maxWidth: 320,
                        backdropFilter: 'blur(8px)',
                    }}
                    >
                        <div style={{
                            fontSize: 9, fontWeight: 700, color: '#c4a8ff',
                            letterSpacing: 0.5, marginBottom: 2,
                            fontFamily: 'JetBrains Mono, Menlo, monospace',
                        }}>
                            SINGLE FRAME · NO PLAYBACK
                        </div>
                        <div style={{ opacity: 0.75 }}>
                            This is a single processed frame. Its position may differ from Resolve's current playhead.
                            Dimming does not show the original source.
                        </div>
                    </div>
                )}
            </div>

            <footer style={{
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                gap: 12,
                padding: '8px 14px',
                background: '#0d0418',
                borderTop: '1px solid #2a1850',
                flexShrink: 0,
            }}>
                <button
                    type="button"
                    onClick={renderOnce}
                    disabled={renderDisabled}
                    style={{
                        padding: '5px 12px',
                        minHeight: 44,
                        background: renderDisabled
                            ? '#2a1850'
                            : 'linear-gradient(135deg, #ff2bd6, #8a2be2)',
                        border: 'none',
                        color: '#fff',
                        borderRadius: 4,
                        cursor: renderDisabled ? 'not-allowed' : 'pointer',
                        fontSize: 11,
                        fontWeight: 600,
                        display: 'flex', alignItems: 'center', gap: 6,
                    }}
                    title="Request the current chain as a single-frame preview"
                >
                    <RefreshCw size={11} />
                    Render preview
                </button>
                {state.elapsedMs !== undefined && (
                    <span style={{ fontSize: 10, opacity: 0.55, fontVariantNumeric: 'tabular-nums' }}>
                        last request: {(state.elapsedMs / 1000).toFixed(2)} s
                    </span>
                )}
                {/* This switch controls interval requests only; chain edits still refresh. */}
                <button
                    type="button"
                    onClick={() => setAutoFollow(v => !v)}
                    aria-label="Periodic preview refresh"
                    aria-pressed={autoFollow}
                    disabled={requestHeld || config.chain.length === 0}
                    style={{
                        padding: '5px 10px',
                        minHeight: 44,
                        background: autoFollow ? 'rgba(68, 255, 153, 0.12)' : 'rgba(170, 170, 190, 0.08)',
                        border: `1px solid ${autoFollow ? 'rgba(68, 255, 153, 0.4)' : 'rgba(170, 170, 190, 0.25)'}`,
                        color: autoFollow ? '#44ff99' : '#aab',
                        borderRadius: 4,
                        cursor: requestHeld || config.chain.length === 0 ? 'not-allowed' : 'pointer',
                        fontSize: 10,
                        fontWeight: 600,
                        display: 'flex', alignItems: 'center', gap: 5,
                        letterSpacing: 0.4,
                    }}
                    title={requestHeld ? 'Preview requests are held because the earlier request outcome is unconfirmed.' : autoFollow
                        ? 'Requests a preview every 2 seconds when approved steps are present and no preview is in flight.'
                        : 'Periodic requests are off. Chain edits and Render preview can still update the image; an in-flight request continues.'}
                >
                    {autoFollow ? <Pause size={10} aria-hidden="true" /> : <Play size={10} aria-hidden="true" />}
                    {requestHeld ? 'Periodic refresh held' : autoFollow ? 'Periodic refresh · 2 s' : 'Periodic refresh off'}
                </button>
                <div style={{ flex: 1 }} />
                <span style={{ fontSize: 11, opacity: 0.8, flexBasis: '100%', lineHeight: 1.5 }}>
                    {requestHeld ? 'Further preview requests are held in this view. The earlier request may still be running.' : config.chain.length === 0
                        ? 'add a step to render'
                        : 'Chain edits and Render preview can update the image even with periodic refresh off.'}
                </span>
            </footer>
        </section>
    );
};

const UnconfirmedPreviewNotice: React.FC<{ error?: string; previousImage?: boolean }> = ({ error, previousImage }) => (
    <div role="alert" aria-label="Unconfirmed preview request" tabIndex={0} style={{
        boxSizing: 'border-box', maxHeight: '100%', maxWidth: 520, overflowY: 'auto',
        padding: 24, color: '#ff5577', textAlign: 'center',
        display: 'flex', flexDirection: 'column', gap: 8,
    }}>
        <div style={{ fontSize: 13 }}>Preview outcome unconfirmed</div>
        <div style={{ fontSize: 11, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>
            {error?.trim() || 'No usable error details were returned.'}
        </div>
        <div style={{ fontSize: 12, color: '#f0e6ff', lineHeight: 1.55 }}>
            The preview reply could not be confirmed. The earlier request may still be running.
            Further preview requests are held in this view.
            {previousImage && ' Previous preview still shown.'}
        </div>
    </div>
);

const EmptyState: React.FC<{ status: PreviewState['status']; error?: string }> = ({ status, error }) => {
    if (status === 'unconfirmed') return <UnconfirmedPreviewNotice error={error} />;
    if (status === 'error') {
        return (
            <div role="alert" aria-label="Preview error details" tabIndex={0} style={{
                width: '100%', height: '100%',
                boxSizing: 'border-box', overflowY: 'auto',
                display: 'flex', alignItems: 'center', justifyContent: 'flex-start',
                flexDirection: 'column', gap: 8,
                color: '#ff5577',
                padding: 24, textAlign: 'center',
            }}>
                <AlertCircle size={20} aria-hidden="true" />
                <div style={{ fontSize: 12, opacity: 0.85 }}>Preview failed</div>
                <div style={{ fontSize: 11, maxWidth: 480, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>
                    {error?.trim() || 'The preview request did not complete.'}
                </div>
                <div style={{ fontSize: 12, maxWidth: 520, lineHeight: 1.55, color: '#f0e6ff' }}>
                    Review the reported error before requesting another preview. A timeout alone does not identify the cause.
                    If a source frame is missing, check that VapourSynth is applied to the clip and render a frame through the effect in Resolve.
                </div>
            </div>
        );
    }
    if (status === 'rendering') {
        return (
            <div role="status" style={{
                width: '100%', height: '100%',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                flexDirection: 'column', gap: 12,
                opacity: 0.7,
            }}>
                <BrailleSpinner size={20} />
                <div style={{ fontSize: 12, opacity: 0.85, color: '#ff2bd6' }}>
                    Waiting for preview…
                </div>
                <div style={{ fontSize: 10, opacity: 0.5, color: '#f0e6ff' }}>
                    Rendering time depends on the enabled filters.
                </div>
            </div>
        );
    }
    return (
        <div style={{
            width: '100%', height: '100%',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexDirection: 'column', gap: 8,
            opacity: 0.5,
        }}>
            <div style={{ fontSize: 11, opacity: 0.55, letterSpacing: 1 }}>PREVIEW</div>
            <div style={{ fontSize: 12, opacity: 0.7, textAlign: 'center', maxWidth: 460 }}>
                Add, enable and approve a step to request a single-frame preview.<br />
                <span style={{ opacity: 0.6 }}>
                    Timeline input needs a frame cached by the effect in Resolve. An identified source file may be read directly.
                    This view has no playback or source comparison.
                </span>
            </div>
        </div>
    );
};
