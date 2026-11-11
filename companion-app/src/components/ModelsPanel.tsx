// Models tab — curated optional neural models with explicit, in-app
// lifecycle management. No terminal installs.
//
// Every entry shows publisher, version, download size, disk need, checksum,
// backend compatibility and an honest LICENSE flag (a flag, never clearance).
// Downloads are explicit and cancellable with progress; the archive is
// published as downloaded only after its upstream checksum is verified;
// extraction uses the DETECTED 7z (a missing extractor is an honest error —
// never a downloaded/setup script). Lifecycle tooltips:
//   absent     → nothing on disk
//   downloading→ owned transfer in flight (stop/cleanup waits for known close)
//   downloaded → verified archive on disk, not yet usable
//   ready      → extracted where the runtime can load it
// Failed entries expose backend recovery guidance. Discard is offered only
// when the backend explicitly permits it, then uses scope confirmation.
// Removal refuses tracked active transfers/extractions; this lifecycle ownership
// is not hostile-process containment (the separate B1′ release gate stays open).
import React, { useCallback, useEffect, useState } from 'react';
import { Download, X, Trash2, Package, PackageCheck, ShieldAlert, HardDrive, ChevronDown } from 'lucide-react';
import type { ModelRegistryEntry, ModelProgressPayload } from '../types';

const STATE_LABEL: Record<string, string> = {
    absent: 'Not downloaded',
    downloading: 'Downloading…',
    interrupted: 'Interrupted — partial download (retry or remove)',
    downloaded: 'Downloaded + verified (needs extraction)',
    ready: 'Ready — extracted for the runtime',
    failed: 'Failed',
};

const fmtMB = (bytes: number) => `${Math.round(bytes / 1_000_000).toLocaleString()} MB`;
const RETENTION_STATUS_LABEL = { retained: 'Retained', pending: 'Pending', held: 'Held' };
const retainedSizeText = (bytes: number | null) => {
    if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 0) return 'Retained size not measured.';
    const unit = bytes >= 1_000_000_000 ? 'GB' : bytes >= 1_000_000 ? 'MB' : 'bytes';
    const divisor = unit === 'GB' ? 1_000_000_000 : unit === 'MB' ? 1_000_000 : 1;
    return `Reported retained size: ${(bytes / divisor).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${unit}.`;
};

export const ModelsPanel: React.FC<{ onCapabilityChanged?: () => void }> = ({ onCapabilityChanged }) => {
    const [models, setModels] = useState<ModelRegistryEntry[]>([]);
    const [extractionAvailable, setExtractionAvailable] = useState(true);
    const [busy, setBusy] = useState<Record<string, string>>({});
    const [progress, setProgress] = useState<Record<string, ModelProgressPayload>>({});
    const [expanded, setExpanded] = useState<string | null>(null);

    const reload = useCallback(async () => {
        const result = await window.electron?.listModels?.();
        if (result?.ok && result.models) {
            setModels(result.models);
            setExtractionAvailable(result.extractionAvailable !== false);
        }
        onCapabilityChanged?.();
    }, [onCapabilityChanged]);

    useEffect(() => { void reload(); }, [reload]);
    useEffect(() => {
        const stop = window.electron?.onModelProgress?.(payload => {
            if (payload.done) {
                setProgress(p => { const n = { ...p }; delete n[payload.id]; return n; });
                void reload();
            } else {
                setProgress(p => ({ ...p, [payload.id]: payload }));
            }
        });
        return () => { stop?.(); };
    }, [reload]);

    const onDownload = async (id: string) => {
        setBusy(b => ({ ...b, [id]: 'starting' }));
        const result = await window.electron?.downloadModel?.({ id });
        if (!result?.ok && !result?.cancelled) {
            setBusy(b => ({ ...b, [id]: result?.error ?? 'download failed' }));
        } else {
            setBusy(b => { const n = { ...b }; delete n[id]; return n; });
        }
        void reload();
    };
    const onExtract = async (id: string) => {
        setBusy(b => ({ ...b, [id]: 'extracting' }));
        const result = await window.electron?.extractModel?.({ id });
        if (!result?.ok) setBusy(b => ({ ...b, [id]: result?.error ?? 'extraction failed' }));
        else setBusy(b => { const n = { ...b }; delete n[id]; return n; });
        void reload();
    };
    const onCancel = (id: string) => { void window.electron?.cancelModelDownload?.({ id }); };
    const onRemove = async (id: string) => {
        // Scope-confirmed removal: show exactly what will be deleted and
        // require an explicit confirmation; never silently drop files.
        const model = models.find(entry => entry.id === id);
        const removable = !progress[id] && (model?.state === 'ready' || model?.state === 'interrupted'
            || (model?.state === 'failed' && model.canDiscard === true));
        if (!removable) {
            setBusy(b => ({ ...b, [id]: 'Removal is unavailable. Follow the recovery guidance before trying again.' }));
            return;
        }
        try {
            const scope = await window.electron?.describeModelRemoval?.({ id });
            if (scope?.ok !== true) {
                setBusy(b => ({ ...b, [id]: scope?.error || 'Removal scope is unavailable. No removal was requested.' }));
                return;
            }
            const fmt = (b?: number) => b != null ? `${Math.round(b / 1_000_000).toLocaleString()} MB` : '?';
            const okay = window.confirm(
                `Remove this model?\n\nDirectory: ${scope.dir}\nFiles: ${scope.fileCount}\nSize: ${fmt(scope.bytes)}\n\n`
                + `Other models and shared runtimes are outside this removal scope.`);
            if (!okay) return;
            setBusy(b => ({ ...b, [id]: 'removing' }));
            const result = await window.electron?.removeModel?.({ id });
            if (result?.ok === true) {
                setBusy(b => { const next = { ...b }; delete next[id]; return next; });
            } else {
                setBusy(b => ({ ...b, [id]: result?.error || 'Removal failed. The files were not confirmed removed.' }));
            }
        } catch (error: any) {
            setBusy(b => ({ ...b, [id]: error?.message || String(error) }));
            return;
        }
        void reload().catch((error: any) => {
            setBusy(b => ({ ...b, [id]: `Model list could not be refreshed: ${error?.message || String(error)}` }));
        });
    };

    return (
        <section aria-label="Optional neural models" style={{
            flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0,
            background: '#0b0512', overflowY: 'auto', padding: 16,
        }}>
            <h2 style={{ margin: '0 0 4px', fontSize: 14, color: '#ff2bd6' }}>Optional neural models</h2>
            <p style={{ margin: '0 0 14px', fontSize: 11, opacity: 0.7, lineHeight: 1.5 }}>
                Neural filters (e.g. RIFE frame interpolation) need model weights that are NOT bundled.
                Download here — no terminal required. Downloads are explicit and cancellable; the
                archive is verified against the checksum published with the upstream release before
                it is kept. A checksum proves the file matches the release, not that the publisher is
                trustworthy — review the publisher and license line before downloading.
                {!extractionAvailable && <> ⚠ No 7z extractor found: download will work but
                extraction needs 7zip (brew install p7zip). The app will never run a downloaded
                installer for you.</>}
            </p>
            {models.map(model => {
                const p = progress[model.id];
                const state = p ? 'downloading' : model.state ?? 'absent';
                const removing = busy[model.id] === 'removing';
                const error = removing ? null : busy[model.id];
                const open = expanded === model.id;
                return (
                    <div key={model.id} role="group" aria-label={model.label} style={{
                        border: '1px solid #2a1850', borderRadius: 6, background: '#150a26',
                        marginBottom: 10, padding: '10px 12px',
                    }}>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'baseline' }}>
                            <strong style={{ fontSize: 12 }}>{model.label}</strong>
                            {model.recommended && (
                                <span title={model.recommendationNote}
                                    style={{ fontSize: 10, padding: '1px 6px', borderRadius: 3,
                                        background: 'rgba(68,255,153,0.12)', color: '#7dffbb',
                                        border: '1px solid rgba(68,255,153,0.35)' }}>Recommended</span>
                            )}
                            <span aria-label="Model lifecycle state" title={STATE_LABEL[state]} style={{
                                fontSize: 11, display: 'inline-flex', gap: 5, alignItems: 'center',
                                color: state === 'ready' ? '#7dffbb' : state === 'downloaded' ? '#f4ce91' : '#c4a8ff' }}>
                                {state === 'ready' ? <PackageCheck size={12} aria-hidden="true" />
                                    : <Package size={12} aria-hidden="true" />}
                                {STATE_LABEL[state]}
                            </span>
                            <span style={{ flex: 1 }} />
                            {state === 'absent' && <button type="button" disabled={removing} onClick={() => void onDownload(model.id)}
                                style={buttonStyle} aria-label={`Download ${model.label} (${fmtMB(model.downloadBytes)})`}>
                                <Download size={11} aria-hidden="true" /> Download {fmtMB(model.downloadBytes)}
                            </button>}
                            {state === 'downloading' && <button type="button" disabled={removing} onClick={() => onCancel(model.id)}
                                style={buttonStyle} aria-label="Cancel download"><X size={11} aria-hidden="true" /> Cancel</button>}
                            {state === 'interrupted' && <>
                                <button type="button" disabled={removing} onClick={() => void onDownload(model.id)}
                                    style={buttonStyle} aria-label={`Retry download of ${model.label} (overwrites the partial)`}>
                                    <Download size={11} aria-hidden="true" /> Retry download
                                </button>
                                <button type="button" disabled={removing} onClick={() => void onRemove(model.id)}
                                    style={buttonStyle} aria-label="Discard the partial download">
                                    <Trash2 size={11} aria-hidden="true" /> Discard
                                </button>
                            </>}
                            {state === 'failed' && model.canDiscard === true && <button type="button" disabled={removing}
                                onClick={() => void onRemove(model.id)} style={buttonStyle} aria-label="Discard failed model files">
                                <Trash2 size={11} aria-hidden="true" /> Discard
                            </button>}
                            {state === 'downloaded' && <button type="button" disabled={removing} onClick={() => void onExtract(model.id)}
                                style={buttonStyle} aria-label="Extract verified archive"><PackageCheck size={11} aria-hidden="true" /> Extract</button>}
                            {state === 'ready' && <button type="button" disabled={removing} onClick={() => void onRemove(model.id)}
                                style={buttonStyle} aria-label="Remove model files from disk">
                                <Trash2 size={11} aria-hidden="true" /> Remove
                            </button>}
                            <button type="button" onClick={() => setExpanded(open ? null : model.id)}
                                aria-expanded={open} style={buttonStyle} aria-label="Details">
                                <ChevronDown size={11} aria-hidden="true" style={{ transform: open ? 'rotate(180deg)' : undefined }} />
                            </button>
                        </div>
                        {p && (
                            <div role="status" style={{ marginTop: 8, fontSize: 11 }}>
                                {p.phase === 'verifying' ? 'Verifying checksum…'
                                    : `Downloading ${fmtMB(p.received ?? 0)}${p.total ? ` of ${fmtMB(p.total)}` : ''}`}
                                {p.fraction != null && <div style={{
                                    height: 4, background: '#22103a', borderRadius: 2, marginTop: 4,
                                }}><div style={{ width: `${Math.round(p.fraction * 100)}%`, height: '100%',
                                    background: '#ff2bd6', borderRadius: 2 }} /></div>}
                            </div>
                        )}
                        {state === 'failed' && <div role="alert" style={{ marginTop: 6, color: '#ffc1ce',
                            fontSize: 11, lineHeight: 1.5, overflowWrap: 'anywhere' }}>
                            <div>{model.error || 'Model files need attention.'}</div>
                            {model.recovery && <div>{model.recovery}</div>}
                        </div>}
                        {model.retainedStorage && <div role="note" aria-label="Retained model files" style={{
                            marginTop: 8, padding: '8px 10px', border: '1px solid #3a2456', borderRadius: 4,
                            fontSize: 11, lineHeight: 1.5, overflowWrap: 'anywhere',
                        }}>
                            <strong>Retained model files</strong>
                            <div>Stored separately from the current model folder.</div>
                            <div>Retention status: {RETENTION_STATUS_LABEL[model.retainedStorage.status]}</div>
                            <div>Location: <code style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{model.retainedStorage.path}</code></div>
                            <div>{retainedSizeText(model.retainedStorage.bytes)}</div>
                            <div>{model.retainedStorage.note}</div>
                        </div>}
                        {removing && <div role="status" style={{ marginTop: 6, fontSize: 11 }}>Removing model files…</div>}
                        {error && <div role="alert" style={{ marginTop: 6, color: '#ffc1ce', fontSize: 11,
                            lineHeight: 1.5, overflowWrap: 'anywhere' }}>{error}</div>}
                        {open && (
                            <dl style={{ margin: '10px 0 0', fontSize: 11, lineHeight: 1.6, display: 'grid',
                                gridTemplateColumns: 'max-content 1fr', columnGap: 12, rowGap: 2 }}>
                                <dt style={{ opacity: 0.6 }}>Purpose</dt><dd style={{ margin: 0 }}>{model.purpose}</dd>
                                <dt style={{ opacity: 0.6 }}>Publisher</dt><dd style={{ margin: 0 }}>{model.publisher}</dd>
                                <dt style={{ opacity: 0.6 }}>Version</dt><dd style={{ margin: 0 }}>{model.version} (<a href={model.source} target="_blank" rel="noreferrer">release</a>)</dd>
                                <dt style={{ opacity: 0.6 }}>Download</dt><dd style={{ margin: 0 }}>{fmtMB(model.downloadBytes)}</dd>
                                <dt style={{ opacity: 0.6 }}><HardDrive size={11} aria-hidden="true" /></dt>
                                <dd style={{ margin: 0 }}>~{fmtMB(model.diskBytesNeeded)} on disk after extraction</dd>
                                {model.installedBytes != null && <>
                                    <dt style={{ opacity: 0.6 }}>Measured</dt>
                                    <dd style={{ margin: 0 }}>{fmtMB(model.installedBytes)} installed now (measured)</dd>
                                </>}
                                {model.tempBytesNeeded != null && <>
                                    <dt style={{ opacity: 0.6 }}>Temp</dt>
                                    <dd style={{ margin: 0 }}>~{fmtMB(model.tempBytesNeeded)} free space needed during extraction</dd>
                                </>}
                                <dt style={{ opacity: 0.6 }}>Checksum</dt><dd style={{ margin: 0, fontFamily: 'ui-monospace, Menlo, monospace', overflowWrap: 'anywhere' }}>{model.sha256}</dd>
                                <dt style={{ opacity: 0.6 }}>Backend</dt><dd style={{ margin: 0 }}>{model.compatibleBackend}</dd>
                                <dt style={{ opacity: 0.6 }}><ShieldAlert size={11} aria-hidden="true" /></dt>
                                <dd style={{ margin: 0, color: '#f4ce91' }}>{model.licenseStatus}</dd>
                            </dl>
                        )}
                    </div>
                );
            })}
        </section>
    );
};

const buttonStyle: React.CSSProperties = {
    padding: '4px 10px', background: '#160a24', border: '1px solid #3a2456',
    color: '#f0e6ff', borderRadius: 4, cursor: 'pointer', fontSize: 11, minHeight: 28,
    display: 'inline-flex', alignItems: 'center', gap: 5,
};
