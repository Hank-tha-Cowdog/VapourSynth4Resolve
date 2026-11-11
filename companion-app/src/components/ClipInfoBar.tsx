// Clip metadata strip. Two layers:
//
//   timeline (auto): always present. Captured by the C++ side from the OFX clip API
//                    on every Configure click. Reflects what Resolve delivers to the
//                    plugin — i.e. timeline-conformed dimensions, NOT source-native.
//
//   source (opt-in): present once the user identifies the source file (drag-drop from
//                    Finder OR click "Identify source…"). Stored in NodeConfig and
//                    auto-re-probed via ffprobe on every Configure click thereafter.
//
// We show both layers so a 720×480 NTSC DV source on a 1920×1080 HD timeline doesn't
// look like a 1920×1080 progressive clip in the Archivist's eyes.

import React, { useCallback, useRef, useState } from 'react';
import {
    FileVideo, Activity, FileQuestion, FileCheck2,
    RefreshCw, X, AlertTriangle,
} from 'lucide-react';
import { BrailleSpinner } from './BrailleSpinner';
import type { ClipMetadata, SourceClipMetadata } from '../types';
import { deriveScanVerdict, type ScanVerdict, type Confidence } from '../services/scan-verdict';

// Mirrors the discriminated union in App.tsx — kept structural so the component
// doesn't need to import the type.
type ResolveDiscovery =
    | { status: 'discovering' }
    | { status: 'discovered'; filePath: string }
    | { status: 'matched' }
    | { status: 'scripting-disabled'; message: string }
    | { status: 'not-installed' }
    | { status: 'no-clip'; message: string }
    | { status: 'unknown-failure'; message: string }
    | { status: 'request-unconfirmed' }
    | { status: 'idle' };

interface Props {
    metadata: ClipMetadata | undefined;
    resolveDiscovery: ResolveDiscovery;
    sourceRequestFailure?: string | null;
    onSourceProbed: (source: SourceClipMetadata) => void;
    onSourceCleared: () => void;
}

function identificationErrorDetail(value: unknown, fallback: string): string {
    try {
        const text = typeof value === 'string' ? value
            : value && typeof value === 'object' && 'message' in value
                && typeof value.message === 'string' ? value.message : fallback;
        if (!text.trim()) return fallback;
        const marker = '\n[details truncated]';
        return text.length > 4096 ? text.slice(0, 4096 - marker.length) + marker : text;
    } catch { return fallback; }
}

// Base probe-producer shape plus fields read by the UI/heuristics. This does not
// validate metadata accuracy, media authority, resource bounds or backend closure.
function isUsableSourceMetadata(value: unknown, filePath: string): value is SourceClipMetadata {
    const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
    const text = (v: unknown) => v === null || typeof v === 'string';
    const number = (v: unknown) => v === null || (typeof v === 'number' && Number.isFinite(v));
    const fields = (v: Record<string, unknown>, strings: string[], numbers: string[]) =>
        strings.every(k => text(v[k])) && numbers.every(k => number(v[k]));
    if (!record(value) || value.filePath !== filePath || typeof value.fileName !== 'string'
        || !value.fileName.trim() || typeof value.probedAt !== 'string' || !Number.isFinite(Date.parse(value.probedAt))
        || !fields(value, ['container', 'formatName'], ['duration', 'bitRate', 'sizeBytes'])) return false;
    const video = value.video;
    if (video !== null) {
        if (!record(video) || !fields(video,
            ['codec', 'codecTag', 'rFps', 'pixelFormat', 'colorSpace', 'colorPrimaries', 'colorTransfer',
                'colorRange', 'fieldOrder', 'sampleAspectRatio', 'displayAspectRatio', 'chromaLocation'],
            ['width', 'height', 'fps', 'bitDepth', 'frameCount', 'duration', 'bitRate'])) return false;
        if (video.detectedScanType != null && (typeof video.detectedScanType !== 'string'
            || !['tt', 'bb', 'progressive', 'undetermined'].includes(video.detectedScanType))) return false;
        if (video.scanConfidence !== undefined && !number(video.scanConfidence)) return false;
        const breakdown = video.scanBreakdown;
        if (breakdown != null && (!record(breakdown)
            || !['tff', 'bff', 'progressive', 'undetermined', 'total'].every(k =>
                typeof breakdown[k] === 'number' && Number.isFinite(breakdown[k])))) return false;
        if (video.mediainfo != null && (!record(video.mediainfo) || !fields(video.mediainfo,
            ['scanType', 'scanOrder', 'scanTypeOriginal', 'scanOrderOriginal', 'format', 'formatProfile', 'codecId'], []))) return false;
    }
    const audio = value.audio;
    if (audio !== null && (!record(audio) || !fields(audio, ['codec', 'channelLayout'],
        ['channels', 'sampleRate', 'bitRate', 'bitDepth']))) return false;
    if (value.sourceHash !== undefined && !text(value.sourceHash)) return false;
    if (['sourceSize', 'sourceMtimeMs', 'sourceInPoint', 'sourceOutPoint'].some(k => value[k] !== undefined && !number(value[k]))) return false;
    if (['fileMissing', 'retimeDetected'].some(k => value[k] !== undefined && typeof value[k] !== 'boolean')) return false;
    return true;
}

export const ClipInfoBar: React.FC<Props> = ({
    metadata, resolveDiscovery, sourceRequestFailure = null, onSourceProbed, onSourceCleared,
}) => {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [dropActive, setDropActive] = useState(false);
    // Covers manual entry points synchronously, before React can paint disabled
    // buttons. This is per-view admission, not backend cancellation or a global lock.
    const identification = useRef({ active: false, uncertain: false });

    // Internal continuation: picker and drop acquire admission before calling it.
    const probePath = useCallback(async (filePath: string) => {
        let invoked = false;
        try {
            const bridge = window.electron;
            const probe = bridge?.probeClip;
            if (typeof probe !== 'function') { setError('ffprobe IPC unavailable.'); return; }
            invoked = true;
            const result = await probe.call(bridge, filePath);
            if (result && typeof result === 'object' && !Array.isArray(result)
                && result.ok === true && !result.error && isUsableSourceMetadata(result.metadata, filePath)) {
                onSourceProbed(result.metadata);
            } else {
                identification.current.uncertain = true;
                setError(identificationErrorDetail(result?.error, 'No usable source metadata was confirmed.'));
            }
        } catch (error) {
            if (invoked) identification.current.uncertain = true;
            setError(identificationErrorDetail(error, 'The source metadata request could not complete.'));
        }
    }, [onSourceProbed]);

    const onPickFile = useCallback(async () => {
        if (identification.current.active) return;
        identification.current.active = true;
        setBusy(true); setError(null);
        let invoked = false;
        try {
            const bridge = window.electron;
            const pick = bridge?.pickClipFile;
            if (typeof pick !== 'function') { setError('File picker IPC unavailable.'); return; }
            invoked = true;
            const picked = await pick.call(bridge);
            const valid = picked && typeof picked === 'object' && !Array.isArray(picked);
            const pickedError = valid && 'error' in picked ? picked.error : undefined;
            if (valid && picked.ok === false && picked.canceled === true && !pickedError && !picked.filePath) return;
            if (valid && picked.ok === true && picked.canceled !== true && !pickedError
                && typeof picked.filePath === 'string' && picked.filePath.trim()) {
                await probePath(picked.filePath);
            } else {
                identification.current.uncertain = true;
                setError(identificationErrorDetail(pickedError, 'The file picker did not confirm a result.'));
            }
        } catch (error) {
            if (invoked) identification.current.uncertain = true;
            setError(identificationErrorDetail(error, 'The file picker request could not complete.'));
        } finally {
            if (!identification.current.uncertain) {
                identification.current.active = false;
                setBusy(false);
            }
        }
    }, [probePath]);

    // File.path was removed in Electron 32. Resolve the dropped File through
    // preload's webUtils bridge before submitting the existing probe request.
    const onDrop = useCallback(async (e: React.DragEvent) => {
        e.preventDefault();
        setDropActive(false);
        if (identification.current.active) return;
        identification.current.active = true;
        setBusy(true); setError(null);
        try {
            const file = e.dataTransfer?.files?.[0];
            if (!file) { setError('No file was supplied. Use Identify source to choose a media file.'); return; }
            const bridge = window.electron;
            const getPath = bridge?.getDroppedFilePath;
            if (typeof getPath !== 'function') {
                setError('File drop is unavailable in this companion build. Use Identify source to choose a file.');
                return;
            }
            const path = getPath.call(bridge, file);
            if (typeof path !== 'string' || !path.trim()) {
                setError('The dropped item has no disk-backed file path. Use Identify source to choose a file.');
                return;
            }
            await probePath(path);
        } catch (error) {
            // Path extraction failed before probePath submitted a media request.
            // probePath handles its own invoked-request uncertainty internally.
            setError(identificationErrorDetail(error, 'The dropped file could not be identified.'));
        }
        finally {
            if (!identification.current.uncertain) {
                identification.current.active = false;
                setBusy(false);
            }
        }
    }, [probePath]);

    const t = metadata?.timeline;
    const s = metadata?.source;

    const onDragOver = (e: React.DragEvent) => {
        e.preventDefault();
        if (identification.current.active) return;
        if (!dropActive) setDropActive(true);
    };
    const onDragLeave = () => setDropActive(false);

    // Synthesize ONE authoritative answer for scan type / field order across all
    // sources (ffprobe / idet / mediainfo) rather than rendering each source as a
    // separate chip — that was the bug the user surfaced: too many chips made it
    // unclear what the clip actually is. Per-source detail moves into tooltips.
    const verdict: ScanVerdict | null = s?.video ? deriveScanVerdict(s.video) : null;

    return (
        <div
            style={barStyle(dropActive)}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            title={dropActive ? 'Drop the source media file to identify it' : undefined}
        >
            {!t && !s && (
                <>
                    <Activity size={12} color="#aaa" aria-hidden="true" />
                    <span style={{ fontSize: 11 }}>No clip metadata available.</span>
                </>
            )}
            {s && s.video ? (
                <>
                    <FileCheck2 size={12} color="#44ff99" />
                    <span style={fileNameStyle} title={s.filePath}>
                        {s.fileMissing
                            ? <span style={{ color: '#ffaa44' }}>{s.fileName} (missing)</span>
                            : s.fileName}
                    </span>
                    {/* TKT-SRC: tiny fingerprint chip so the user can see at a glance
                        that the source has been hashed for integrity checking. Shows
                        first 6 chars of the sha256 digest — enough to spot when a
                        re-probe yielded a different hash without exposing all 64
                        chars. Hover for the full digest + size + mtime. */}
                    {s.sourceHash && (
                        <span
                            title={
                                `sha256 fingerprint (first 1 MB + last 1 MB + size)\n`
                                + `${s.sourceHash}\n`
                                + (s.sourceSize ? `size: ${(s.sourceSize / (1024*1024)).toFixed(2)} MB\n` : '')
                                + (s.sourceMtimeMs ? `mtime: ${new Date(s.sourceMtimeMs).toISOString()}` : '')
                            }
                            style={{
                                fontSize: 9, opacity: 0.55,
                                fontFamily: 'JetBrains Mono, Menlo, monospace',
                                color: '#9be5a0',
                                padding: '1px 5px',
                                background: 'rgba(68, 255, 153, 0.08)',
                                border: '1px solid rgba(68, 255, 153, 0.25)',
                                borderRadius: 2,
                                letterSpacing: 0.4,
                                cursor: 'help',
                            }}
                        >
                            #{s.sourceHash.slice(0, 6)}
                        </span>
                    )}
                    <Sep />
                    {s.video.width != null && s.video.height != null && (
                        <LabeledChip label="res" color="#44ff99" title="Source-native resolution (from ffprobe)">
                            {s.video.width}×{s.video.height}
                        </LabeledChip>
                    )}
                    {s.video.fps != null && (
                        <LabeledChip label="fps" color="#44ff99"
                                     title={s.video.rFps ? `r_frame_rate ${s.video.rFps}` : undefined}>
                            {formatFps(s.video.fps)}
                        </LabeledChip>
                    )}
                    {s.video.codec && (
                        <LabeledChip label="codec" color="#44ff99" title={s.video.codec}>
                            {(s.video.codecTag || s.video.codec.split(' ')[0]).toLowerCase()}
                        </LabeledChip>
                    )}
                    {s.video.pixelFormat && (
                        <LabeledChip label="pix fmt" color="#44ff99">
                            {s.video.pixelFormat}
                        </LabeledChip>
                    )}

                    {s.video.sampleAspectRatio && (
                        <LabeledChip label="par" color="#44ff99"
                                     title={`sample aspect ratio ${s.video.sampleAspectRatio}, display ${s.video.displayAspectRatio || '?'}`}>
                            {s.video.sampleAspectRatio}
                        </LabeledChip>
                    )}

                    {/* --- Verdict + provenance: at most 4 chips, color by confidence not by value.
                          Each chip carries a small graphical glyph that conveys the concept at a glance:
                            ▦ progressive (solid raster)         ☷ interlaced (alternating fields)
                            ⤒ top-field-first (TFF)              ⤓ bottom-field-first (BFF)
                            ⌑ ambiguous/unknown
                          The glyph leads the chip's value so the eye can skim the row without reading. --- */}
                    {verdict && (() => {
                        const color = confidenceColor(verdict.confidence);
                        const suspect = verdict.confidence === 'suspected';
                        return (
                            <>
                                <LabeledChip
                                    label="current scan"
                                    color={color}
                                    title={verdict.explanation}
                                >
                                    <span style={{ marginRight: 4 }}>{scanGlyph(verdict.scanType)}</span>
                                    {verdict.scanType}
                                    {suspect && ' ⚠'}
                                </LabeledChip>
                                {verdict.scanType === 'Interlaced'
                                 && verdict.fieldOrder !== 'N/A' && (
                                    <LabeledChip
                                        label="current order"
                                        color={color}
                                        title={verdict.explanation}
                                    >
                                        <span style={{ marginRight: 4 }}>{orderGlyph(verdict.fieldOrder)}</span>
                                        {verdict.fieldOrder}
                                    </LabeledChip>
                                )}
                                {verdict.original && (
                                    <>
                                        <LabeledChip
                                            label="original scan"
                                            color="#c4a8ff"
                                            title={`MediaInfo provenance — what this material was BEFORE encoding. The CURRENT chips reflect what the clip is now (which is what matters for filter params).\n\nOriginal scan type: ${verdict.original.scanType}`}
                                        >
                                            <span style={{ marginRight: 4 }}>{scanGlyph(verdict.original.scanType)}</span>
                                            {verdict.original.scanType}
                                        </LabeledChip>
                                        {verdict.original.scanType === 'Interlaced'
                                         && verdict.original.fieldOrder !== 'N/A'
                                         && verdict.original.fieldOrder !== '?' && (
                                            <LabeledChip
                                                label="original order"
                                                color="#c4a8ff"
                                                title={`Original field order (provenance only): ${verdict.original.fieldOrder}`}
                                            >
                                                <span style={{ marginRight: 4 }}>{orderGlyph(verdict.original.fieldOrder)}</span>
                                                {verdict.original.fieldOrder}
                                            </LabeledChip>
                                        )}
                                    </>
                                )}
                            </>
                        );
                    })()}

                    {s.video.colorSpace && (
                        <LabeledChip
                            label="matrix" color="#44ff99"
                            title={`primaries=${s.video.colorPrimaries} transfer=${s.video.colorTransfer} matrix=${s.video.colorSpace} range=${s.video.colorRange}`}
                        >
                            {s.video.colorSpace}
                        </LabeledChip>
                    )}
                </>
            ) : t ? (
                <>
                    <FileVideo size={12} color="#ffaa44" />
                    <span style={fileNameStyle} title="Timeline-conformed delivery from OFX. Identify source for native props.">
                        Timeline delivery
                    </span>
                    <Sep />
                    {t.width != null && t.height != null && (
                        <LabeledChip label="res (timeline)"
                                     title="As delivered to OFX — timeline-conformed, NOT source-native">
                            {t.width}×{t.height}
                        </LabeledChip>
                    )}
                    {t.fps != null && (
                        <LabeledChip label="fps">{formatFps(t.fps)}</LabeledChip>
                    )}
                    {t.fieldOrder && (
                        <LabeledChip label="scan" color={fieldOrderColor(t.fieldOrder)}
                                     title={`field_order = ${t.fieldOrder} (timeline)`}>
                            {fieldOrderLabel(t.fieldOrder)}
                        </LabeledChip>
                    )}
                    {t.pixelAspectRatio != null && (
                        <LabeledChip label="par"
                                     title={`pixel aspect ratio ${t.pixelAspectRatio.toFixed(4)}`}>
                            {t.pixelAspectRatio.toFixed(3)}
                        </LabeledChip>
                    )}
                    {t.pipelineBitDepth && (
                        <LabeledChip label="depth">{t.pipelineBitDepth}</LabeledChip>
                    )}
                </>
            ) : null}

            <div style={{ flex: 1 }} />

            {error && (
                <span role="alert" aria-label="Source identification error details" tabIndex={0} style={{
                    fontSize: 11, color: '#ff8aa0', flexBasis: '100%',
                    overflowWrap: 'anywhere', whiteSpace: 'pre-wrap', lineHeight: 1.5,
                    maxHeight: 128, overflowY: 'auto',
                }}>
                    {identification.current.uncertain && <>
                        <strong>Source identification outcome unconfirmed.</strong>{'\n'}
                        Another manual request is held in this view. Backend completion is unconfirmed;
                        this view does not retry or confirm recovery.{'\n'}
                    </>}
                    {error}
                </span>
            )}

            {busy && !identification.current.uncertain && <span role="status" style={{ fontSize: 11 }}>Identifying source…</span>}

            {sourceRequestFailure && (
                <div role="alert" style={{ flexBasis: '100%', color: '#ffcc99', fontSize: 11, lineHeight: 1.5 }}>
                    <strong>An automatic source metadata update is unconfirmed.</strong>
                    <div>The request or its result handling failed. Backend completion is unconfirmed.
                        No automatic retry is scheduled for this failure.</div>
                    {s && <div>Cached source metadata remains displayed.</div>}
                    <div role="region" aria-label="Automatic source metadata error details" tabIndex={0}
                        style={{ maxHeight: 128, overflowY: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                        {sourceRequestFailure}
                    </div>
                </div>
            )}

            {/* Resolve auto-discovery status — only meaningful when no source cached.
                Discovering: spinner. Scripting disabled: actionable instruction.
                Other failure modes: short message. Once a source is identified
                (manually or via API) these messages disappear. */}
            {!s && resolveDiscovery.status === 'discovering' && (
                <span role="status" style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }}>
                    <BrailleSpinner size={11} />
                    Asking Resolve…
                </span>
            )}
            {!s && resolveDiscovery.status === 'scripting-disabled' && (
                <span role="status" style={{ fontSize: 11, color: '#ffaa44', lineHeight: 1.5 }}>
                    Automatic source discovery is unavailable. Use Identify source to choose a file.
                </span>
            )}
            {!s && (resolveDiscovery.status === 'no-clip' || resolveDiscovery.status === 'unknown-failure') && (
                <span role="status" style={{
                    fontSize: 11, overflowWrap: 'anywhere', lineHeight: 1.5,
                }}>
                    {(resolveDiscovery as { message?: string }).message || 'auto-discovery unavailable'}
                </span>
            )}

            {!s && resolveDiscovery.status !== 'discovering' && !error && (
                <span style={{ fontSize: 10, opacity: 0.4 }}>
                    or drop a file here, or
                </span>
            )}

            {!s ? (
                <button type="button" onClick={onPickFile} disabled={busy} style={primaryBtn}>
                    {busy && !identification.current.uncertain ? <BrailleSpinner size={11} /> : <FileQuestion size={11} />}
                    {identification.current.uncertain ? 'Outcome unconfirmed' : busy ? 'Identifying…' : 'Identify source…'}
                </button>
            ) : (
                <>
                    {s.fileMissing && (
                        <Chip color="#ffaa44" title="The cached source file path no longer exists">
                            <AlertTriangle size={9} style={{ display: 'inline', marginRight: 3 }} />
                            file moved
                        </Chip>
                    )}
                    <button type="button" onClick={onPickFile} disabled={busy} style={ghostBtn}
                        aria-label="Identify a different source file" title="Re-identify source (pick a different file)">
                        {busy && !identification.current.uncertain ? <BrailleSpinner size={11} /> : <RefreshCw size={11} />}
                    </button>
                    <button type="button" onClick={onSourceCleared} disabled={busy} style={ghostBtn}
                        aria-label="Forget source file" title="Forget source file">
                        <X size={11} />
                    </button>
                </>
            )}
        </div>
    );
};

const Chip: React.FC<{ children: React.ReactNode; color?: string; title?: string }> = ({ children, color, title }) => (
    <span title={title} style={{
        fontSize: 10,
        padding: '1px 7px',
        background: color ? `${color}1f` : 'rgba(138, 43, 226, 0.18)',
        border: `1px solid ${color || 'rgba(138, 43, 226, 0.45)'}`,
        color: color || '#c4a8ff',
        borderRadius: 3,
        letterSpacing: 0.2,
        whiteSpace: 'nowrap',
    }}>{children}</span>
);

// Labeled chip — small uppercase category title above the value. Differentiates
// what each chip means (res vs par vs scan, etc.) at a glance, especially when
// we show two scan-type chips side by side ("scan (meta)" vs "scan (idet)").
const LabeledChip: React.FC<{
    label: string;
    children: React.ReactNode;
    color?: string;
    title?: string;
}> = ({ label, children, color, title }) => (
    <div title={title} style={{
        display: 'inline-flex',
        flexDirection: 'column',
        alignItems: 'center',
        padding: '2px 7px 1px',
        background: color ? `${color}14` : 'rgba(138, 43, 226, 0.12)',
        border: `1px solid ${color ? `${color}88` : 'rgba(138, 43, 226, 0.4)'}`,
        color: color || '#c4a8ff',
        borderRadius: 3,
        lineHeight: 1.1,
        whiteSpace: 'nowrap',
    }}>
        <span style={{
            fontSize: 7.5,
            opacity: 0.62,
            textTransform: 'uppercase',
            letterSpacing: 0.7,
            fontWeight: 600,
        }}>
            {label}
        </span>
        <span style={{ fontSize: 11, fontVariantNumeric: 'tabular-nums' }}>
            {children}
        </span>
    </div>
);

const Sep: React.FC = () => (
    <span style={{ width: 1, height: 12, background: '#2a1850', margin: '0 2px' }} />
);

function fieldOrderLabel(fo: string): string {
    switch (fo) {
        case 'tt': return 'TFF';
        case 'bb': return 'BFF';
        case 'tb': return 'TFF-coded BFF';
        case 'bt': return 'BFF-coded TFF';
        case 'progressive': return 'progressive';
        case 'interlaced': return 'interlaced';
        case 'unknown': return 'fields ?';
        default: return fo;
    }
}

function fieldOrderColor(fo: string): string | undefined {
    if (fo === 'progressive') return '#44ff99';
    if (fo === 'tt' || fo === 'bb' || fo === 'tb' || fo === 'bt' || fo === 'interlaced') {
        return '#ffaa44';
    }
    return undefined;
}

// Split helpers that derive scan TYPE and field ORDER from ffprobe's combined
// field_order token. MediaInfo already separates these natively.
function scanTypeFromFo(fo: string): 'Interlaced' | 'Progressive' | 'Ambiguous' {
    if (fo === 'progressive') return 'Progressive';
    if (fo === 'undetermined' || fo === 'unknown') return 'Ambiguous';
    return 'Interlaced';
}
function fieldOrderLabelFromFo(fo: string): string {
    if (fo === 'progressive') return 'N/A';
    if (fo === 'tt' || fo === 'tb') return 'TFF';
    if (fo === 'bb' || fo === 'bt') return 'BFF';
    if (fo === 'undetermined' || fo === 'unknown') return '?';
    return '—';
}
function scanTypeColor(type: 'Interlaced' | 'Progressive' | 'Ambiguous'): string {
    if (type === 'Progressive') return '#44ff99';
    if (type === 'Interlaced')  return '#ffaa44';
    return '#999';
}

// Color verdict chips by CONFIDENCE in the answer, not by the value itself. A
// confidently-detected interlaced clip should look as "trusted" as a confidently-
// detected progressive one. "suspected" (heuristic override) now uses BLUE so
// it reads as informational rather than alarming yellow — the verdict is still
// trustworthy, it just took inference rather than direct measurement to get
// there. Red is reserved for actual hazards (color/gamma mismatch).
// Tiny Unicode glyphs that visualize scan type / field order. Chosen for
// braille-adjacent texture (the spinner uses ⠿-family braille) so the chips
// read as part of the same visual family.
//   ▦ progressive — solid square pattern, "whole frame"
//   ☷ interlaced  — three horizontal bars, "alternating field lines"
//   ⤒ TFF         — arrow into top
//   ⤓ BFF         — arrow into bottom
//   ⌑ unknown     — circled dot
function scanGlyph(scanType: 'Interlaced' | 'Progressive' | 'Ambiguous' | string): string {
    if (scanType === 'Progressive') return '▦';
    if (scanType === 'Interlaced')  return '☷';
    return '⌑';
}
function orderGlyph(order: string): string {
    if (order === 'TFF') return '⤒';
    if (order === 'BFF') return '⤓';
    return '⌑';
}

function confidenceColor(c: Confidence): string {
    switch (c) {
        case 'high':      return '#44ff99';  // bright green — trusted directly
        case 'medium':    return '#7be0a0';  // softer green
        case 'low':       return '#ffaa44';  // amber — uncertain, double-check
        case 'suspected': return '#5ec8ff';  // sky blue — heuristic-inferred but high confidence
    }
}

function formatFps(fps: number): string {
    if (Math.abs(fps - Math.round(fps)) < 0.005) return Math.round(fps).toString();
    return fps.toFixed(3);
}

const barStyle = (dropActive: boolean): React.CSSProperties => ({
    display: 'flex', alignItems: 'center', gap: 6,
    // Wrap when there are many chips (scan info has up to 9 chips across the
    // three sources). Keeps the bar usable on narrow popout widths without
    // horizontal scrolling.
    flexWrap: 'wrap',
    rowGap: 4,
    padding: '5px 16px',
    background: dropActive
        ? 'linear-gradient(90deg, rgba(255, 43, 214, 0.18), rgba(138, 43, 226, 0.12))'
        : 'linear-gradient(90deg, rgba(68, 255, 153, 0.05), transparent 50%)',
    borderBottom: dropActive ? '1px solid #ff2bd6' : '1px solid #2a1850',
    fontSize: 11,
    flexShrink: 0,
    transition: 'background 0.12s, border-color 0.12s',
});

const fileNameStyle: React.CSSProperties = {
    fontWeight: 600, color: '#f0e6ff',
    maxWidth: 240,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};

const primaryBtn: React.CSSProperties = {
    minHeight: 44,
    padding: '3px 10px',
    background: 'linear-gradient(135deg, #ff2bd6, #8a2be2)',
    border: 'none', color: '#fff', borderRadius: 4,
    cursor: 'pointer', fontSize: 11, fontWeight: 600,
    display: 'flex', alignItems: 'center', gap: 5,
};

const ghostBtn: React.CSSProperties = {
    minHeight: 44, minWidth: 44,
    padding: '3px 6px',
    background: 'transparent',
    border: '1px solid #2a1850',
    color: '#aaa', borderRadius: 4,
    cursor: 'pointer',
    display: 'flex', alignItems: 'center',
};
