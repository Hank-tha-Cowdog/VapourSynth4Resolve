// A shared status report can precede rendering. Show its age and uncertainty;
// reading the same report again must never imply that Resolve is running now.
import React, { useEffect, useId, useRef, useState } from 'react';
import { CheckCircle2, AlertOctagon, MinusCircle, Loader2, ChevronDown, X } from 'lucide-react';
import {
    INITIAL_STATUS_FEED, pollPluginStatus, statusPresentation,
    type StatusFeed, type StatusTone,
} from '../services/plugin-status';

export const PluginStatusBanner: React.FC = () => {
    const [feed, setFeed] = useState<StatusFeed>(INITIAL_STATUS_FEED);
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const stop = pollPluginStatus(
            () => window.electron?.readPluginStatus?.(), next => {
                // Pair a newly written report with its receipt-time clock, not
                // the previous interval tick. Genuine future times still warn.
                setNow(Date.now()); setFeed(next);
            },
            { schedule: fn => window.setTimeout(fn, 1000),
              cancel: handle => window.clearTimeout(handle as number) },
        );
        // Age still advances when a bridge request is delayed. Reads stay serial.
        const clock = window.setInterval(() => setNow(Date.now()), 1000);
        return () => { stop(); window.clearInterval(clock); };
    }, []);
    return <StatusTitleIcon feed={feed} now={now} />;
};

const PALETTES = {
    neutral: { bg: '#171222', border: '#493857', fg: '#ddd1e9', Icon: MinusCircle },
    configured: { bg: '#10241e', border: '#3f7058', fg: '#b0ebca', Icon: CheckCircle2 },
    warning: { bg: '#2a2114', border: '#82622e', fg: '#f4ce91', Icon: AlertOctagon },
    error: { bg: '#301a23', border: '#925065', fg: '#ffc1ce', Icon: AlertOctagon },
} satisfies Record<StatusTone, object>;

/** The same view is used by the app and the isolated synthetic UI checks. */
export const PluginStatusView: React.FC<{ feed: StatusFeed; now: number }> = ({ feed, now }) => {
    const [showReport, setShowReport] = useState(false);
    const trigger = useRef<HTMLButtonElement>(null);
    const reportId = `plugin-status-report-${useId()}`;
    const view = statusPresentation(feed, now);
    const palette = PALETTES[view.tone];
    const Icon = feed.availability === 'loading' ? Loader2 : palette.Icon;
    const report = feed.report;
    const error = report?.error || null;
    const hasDetails = !!(error || report?.scriptPreview);
    const missing = extractMissingPlugin(error);
    const hint = missing ? suggestedAlternative(missing) : null;
    useEffect(() => { if (!hasDetails) setShowReport(false); }, [hasDetails]);
    const closeReport = () => { setShowReport(false); trigger.current?.focus(); };

    return (
        <section className="vs-plugin-status" aria-label="Plugin status" style={{ flexShrink: 0 }}>
            <style>{`
                .vs-plugin-status button:focus-visible, .vs-plugin-status pre:focus-visible {
                    outline: 2px solid #e3bdff; outline-offset: 3px;
                }
                .vs-plugin-status button:hover { background: rgba(255,255,255,0.09) !important; }
                .vs-plugin-status pre { scrollbar-color: #7d629b #100b19; }
            `}</style>
            {/* COMPACT single-line status: icon + title + age + inline error
                first line + details toggle. The explanatory message moved into
                the expandable report (the old full-height block ate workspace
                before the chain/preview — live feedback). Errors keep their
                first line inline so real failures stay discoverable. */}
            <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8,
                padding: '3px 14px', background: palette.bg,
                borderBottom: `1px solid ${palette.border}`, color: palette.fg, fontSize: 11 }}>
                <Icon size={13} aria-hidden="true" style={{ flexShrink: 0 }} />
                <div role="status" aria-live="polite" aria-atomic="true"
                    style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'baseline',
                        flex: '1 1 auto', minWidth: 0, overflowWrap: 'anywhere' }}>
                    <strong style={{ fontSize: 11, lineHeight: 1.4 }}>{view.title}</strong>
                    {view.age && <span style={{ color: '#c5b7d1', fontSize: 10 }}>{view.age}</span>}
                    {error && <span style={{ color: '#ffc1ce', fontSize: 11 }}>
                        {missing ? <>Missing plugin: <strong>core.{missing}</strong>{hint ? ` · ${hint}` : ''}</>
                            : firstLine(error).slice(0, 200)}
                    </span>}
                </div>
                {hasDetails && <button ref={trigger} type="button"
                    aria-expanded={showReport} aria-controls={reportId}
                    onClick={() => setShowReport(open => !open)}
                    style={{ ...buttonStyle, minHeight: 24, padding: '2px 8px', fontSize: 10,
                        color: palette.fg, borderColor: palette.border }}>
                    {showReport ? 'Hide' : 'Details'}
                    <ChevronDown size={11} aria-hidden="true" style={{
                        transform: showReport ? 'rotate(180deg)' : undefined,
                    }} />
                </button>}
            </div>
            {hasDetails && <section id={reportId} hidden={!showReport} aria-label="Last plugin status report"
                onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); closeReport(); } }}
                style={{ background: '#100b19', borderBottom: `1px solid ${palette.border}`,
                    padding: '10px 16px', maxHeight: 320, overflow: 'auto', color: '#e3d4f0' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <strong style={{ fontSize: 12 }}>Last reported details</strong>
                    <span style={{ fontSize: 11, opacity: 0.8, lineHeight: 1.5 }}>{view.message}</span>
                    <div style={{ flex: 1 }} />
                    <button type="button" aria-label="Close status report" onClick={closeReport}
                        style={{ ...buttonStyle, width: 44, padding: 8, justifyContent: 'center' }}>
                        <X size={16} aria-hidden="true" />
                    </button>
                </div>
                {error && <div style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: 11, marginBottom: 5, color: '#ffc1ce' }}>Reported error</div>
                    <pre tabIndex={0} style={{ ...preStyle, color: '#ffc1ce', borderColor: '#925065' }}>{error}</pre>
                </div>}
                {report?.scriptPreview && <div>
                    <div style={{ fontSize: 11, marginBottom: 5 }}>Reported VapourSynth script</div>
                    <pre tabIndex={0} style={preStyle}>{report.scriptPreview}</pre>
                </div>}
            </section>}
        </section>
    );
};

/** R4: ONE title-bar status icon (replaces the full-width banner row).
 * Small icon button (tone-colored, NO blinking); hover/focus shows a short
 * explanation (title + aria-label); click/Enter opens a details popup;
 * Escape/Close dismisses and RETURNS FOCUS to the icon. A stale
 * lack-of-update message renders NEUTRAL — it never masquerades as a
 * processing fault (tone comes from statusPresentation, unchanged). */
export const StatusTitleIcon: React.FC<{ feed: StatusFeed; now: number }> = ({ feed, now }) => {
    const [open, setOpen] = useState(false);
    const trigger = useRef<HTMLButtonElement>(null);
    const panelId = `plugin-status-popup-${useId()}`;
    const view = statusPresentation(feed, now);
    const palette = PALETTES[view.tone];
    const Icon = feed.availability === 'loading' ? Loader2 : palette.Icon;
    const report = feed.report;
    const error = report?.error || null;
    const missing = extractMissingPlugin(error);
    const hint = missing ? suggestedAlternative(missing) : null;
    const close = () => { setOpen(false); trigger.current?.focus(); };
    const summary = [view.title, view.age, view.message].filter(Boolean).join(' · ');

    return (
        <div style={{ WebkitAppRegion: 'no-drag', position: 'relative', display: 'flex' } as React.CSSProperties}>
            <button ref={trigger} type="button"
                aria-label={`Plugin status: ${summary}`}
                aria-expanded={open} aria-haspopup="dialog"
                title={summary}
                onClick={() => setOpen(o => !o)}
                style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    width: 34, minHeight: 30, background: open ? 'rgba(255,255,255,0.08)' : 'transparent',
                    border: `1px solid ${palette.border}`, borderRadius: 5, cursor: 'pointer',
                    color: palette.fg, padding: 0 }}>
                <Icon size={14} aria-hidden="true" />
            </button>
            {open && (
                <div id={panelId} role="dialog" aria-label="Plugin status details"
                    onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); close(); } }}
                    style={{ position: 'absolute', top: '100%', right: 0, marginTop: 6, zIndex: 60,
                        width: 360, maxWidth: '80vw', background: '#100b19',
                        border: `1px solid ${palette.border}`, borderRadius: 6,
                        boxShadow: '0 12px 32px rgba(0,0,0,0.55)', color: '#e3d4f0',
                        padding: '10px 12px', fontSize: 11.5, lineHeight: 1.5 }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                        <strong style={{ color: palette.fg }}>{view.title}</strong>
                        {view.age && <span style={{ opacity: 0.7 }}>{view.age}</span>}
                        <div style={{ flex: 1 }} />
                        <button type="button" aria-label="Close status details" onClick={close}
                            style={{ ...buttonStyle, minHeight: 24, padding: '2px 8px', fontSize: 10 }}>
                            <X size={12} aria-hidden="true" />
                        </button>
                    </div>
                    {view.message && <p style={{ margin: '6px 0' }}>{view.message}</p>}
                    {missing && <p style={{ margin: '4px 0', color: '#ffc1ce' }}>
                        Missing plugin: <strong>core.{missing}</strong>{hint ? ` · ${hint}` : ''}</p>}
                    {error && <pre tabIndex={0} style={{ ...preStyle, color: '#ffc1ce',
                        borderColor: '#925065', maxHeight: 180, overflow: 'auto' }}>{error}</pre>}
                    {report?.scriptPreview && <pre tabIndex={0} style={{ ...preStyle, maxHeight: 140, overflow: 'auto' }}>
                        {report.scriptPreview}</pre>}
                    <p style={{ margin: '6px 0 0', opacity: 0.6, fontSize: 10.5 }}>
                        A shared status report can precede rendering; reading it again never
                        implies Resolve is running now. Age and uncertainty are shown.
                    </p>
                </div>
            )}
        </div>
    );
};

const buttonStyle: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 5, minHeight: 44,
    padding: '6px 10px', background: 'transparent', border: '1px solid #685276',
    borderRadius: 5, color: '#e3d4f0', cursor: 'pointer', fontSize: 12, flexShrink: 0,
};
const preStyle: React.CSSProperties = {
    margin: 0, padding: 10, fontSize: 11, lineHeight: 1.55,
    color: '#d8c1fa', background: '#0a0610', border: '1px solid #493857', borderRadius: 5,
    fontFamily: 'JetBrains Mono, Menlo, monospace', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
};

function firstLine(s: string): string {
    const nl = s.indexOf('\n');
    return nl >= 0 ? s.slice(0, nl) : s;
}

/** Look for the "No attribute with the name <X> exists" pattern that VS emits
 *  when a chain references an uninstalled plugin namespace (`core.svp1`,
 *  `core.rife`, ...). When found, return the namespace name so the banner can
 *  surface "Missing plugin: <X>" directly instead of making the colorist
 *  parse the Python traceback. Returns null if the error is something else. */
export function extractMissingPlugin(error: string | null): string | null {
    if (!error) return null;
    const m = error.match(/No attribute with the name (\w+) exists/);
    return m ? m[1] : null;
}

/** Map a known-uninstalled plugin namespace → a one-line hint at the
 *  recommended bundled alternative. Used in the banner so a SVP-attempt
 *  produces actionable "use mv.BlockFPS instead" guidance instead of a
 *  bare traceback. List intentionally short — covers only the alternatives
 *  Skippy most often hallucinates. */
export function suggestedAlternative(namespace: string): string | null {
    switch (namespace) {
        case 'svp1':
        case 'svp2':
            return 'Frame interpolation: SVP isn\'t bundled. Use core.mv.BlockFPS (mvtools) instead — ask Skippy to swap it.';
        case 'rife':
        case 'mlrt':
        case 'ort':
            return 'Neural frame interpolation: vs-mlrt + ONNX models aren\'t bundled in v2.0-alpha. Use core.mv.BlockFPS (mvtools) for classical motion-comp interpolation.';
        case 'flux':
            return 'FluxSmooth isn\'t bundled. Try core.zsmooth or core.ttmpsm for temporal smoothing.';
        case 'yadifmod':
        case 'bwdif':
            return 'This deinterlacer isn\'t bundled. Use havsfunc.QTGMC or core.nnedi3.nnedi3 instead.';
        default:
            return null;
    }
}
