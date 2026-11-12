// RenderQueueBar — the batch render queue affordance (beta-batch).
//
// Mounted inline in the tab strip next to ConfigWriteStatus. Contract:
//   - renders NOTHING when the bridge lacks the queue API (standalone/dev
//     builds, UI tests) — zero DOM footprint, zero window access at render
//     time (window is touched only inside guarded effects/handlers).
//   - enqueue renders THIS node's own composed script (nodeGuid); the main
//     process refuses with a clear error until the chain has been applied
//     in Resolve.
//   - progress + completion stream in via onRenderQueueEvent; jobs list is
//     authoritative from 'queue' events + the initial list().
//   - cancel is per job; 'Clear finished' removes terminal jobs.
import React, { useEffect, useState } from 'react';

export interface RenderQueueJobView {
    id: string;
    state: string;
    encoder: string;
    outputPath: string;
    label?: string;
    progress?: { frame: number; total: number; percent: number } | null;
    error?: string | null;
    bytes?: number;
    clipInfo?: { width: number; height: number; frames?: number; pixFmt?: string; formatName?: string | null } | null;
}

interface QueueEvent {
    type: 'queue' | 'job' | 'progress';
    jobs?: RenderQueueJobView[];
    job?: RenderQueueJobView;
    id?: string;
    progress?: { frame: number; total: number; percent: number };
}

const STATE_LABEL: Record<string, string> = {
    queued: 'queued', running: 'rendering', done: 'done', error: 'failed',
    cancelled: 'cancelled', interrupted: 'interrupted',
};

function chipColor(state: string): string {
    switch (state) {
        case 'done': return '#7ee787';
        case 'error': return '#ff7b72';
        case 'running': return '#ff2bd6';
        case 'cancelled':
        case 'interrupted': return '#d2a8ff';
        default: return '#9a8fb3';
    }
}

export const RenderQueueBar: React.FC<{ nodeGuid?: string | null; clipName?: string | null }> = ({ nodeGuid, clipName }) => {
    const [available, setAvailable] = useState(false);
    const [jobs, setJobs] = useState<RenderQueueJobView[]>([]);
    const [encoders, setEncoders] = useState<Record<string, { label: string; extension: string }>>({});
    const [encoder, setEncoder] = useState('prores');
    const [note, setNote] = useState<string | null>(null);

    useEffect(() => {
        let off: (() => void) | undefined;
        try {
            const bridge = window.electron;
            if (!bridge?.renderQueueList || !bridge?.renderQueueAdd) return;
            setAvailable(true);
            let mounted = true;
            bridge.renderQueueList().then(result => {
                if (!mounted || !result?.ok) return;
                setJobs(result.jobs ?? []);
                if (result.encoders) {
                    setEncoders(result.encoders);
                    const preferred = Object.keys(result.encoders).includes('prores')
                        ? 'prores' : Object.keys(result.encoders)[0];
                    if (preferred) setEncoder(preferred);
                }
            }).catch(() => { /* queue status stays empty; the button still works */ });
            off = bridge.onRenderQueueEvent?.((rawEvent: unknown) => {
                const event = rawEvent as QueueEvent;
                if (!mounted || !event) return;
                if (event.type === 'queue' && Array.isArray(event.jobs)) setJobs(event.jobs);
                else if (event.type === 'job' && event.job) {
                    setJobs(prev => {
                        const rest = prev.filter(j => j.id !== event.job!.id);
                        return [...rest, event.job!];
                    });
                } else if (event.type === 'progress' && event.id) {
                    setJobs(prev => prev.map(j => j.id === event.id && event.progress
                        ? { ...j, progress: event.progress } : j));
                }
            });
            return () => { mounted = false; try { off?.(); } catch { /* window gone */ } };
        } catch { return; }
    }, []);

    if (!available) return null;

    const active = jobs.filter(j => j.state === 'queued' || j.state === 'running');
    const running = jobs.find(j => j.state === 'running');
    const finished = jobs.length - active.length;

    const enqueue = async () => {
        setNote(null);
        try {
            const bridge = window.electron;
            if (!bridge) { setNote('the render queue is unavailable in this window'); return; }
            if (!nodeGuid) { setNote('This node has no identity yet; apply its chain in Resolve first.'); return; }
            const enc = encoders[encoder] ?? { extension: '.mov' };
            const base = (clipName || 'render').replace(/\.[^.]+$/, '');
            const pick = await bridge.renderQueueChooseOutput?.({
                encoder,
                defaultPath: `${base}-vsrender${enc.extension}`,
            });
            if (!pick?.ok) return;   // cancelled
            const res = await bridge.renderQueueAdd?.({
                nodeGuid, outputPath: pick.path!, encoder,
                label: `${base} · ${encoders[encoder]?.label ?? encoder}`,
            });
            if (!res?.ok) setNote(res?.error ?? 'the queue refused this render');
        } catch { setNote('the render queue is unavailable in this window'); }
    };

    const act = async (action: 'cancel' | 'remove' | undefined, id?: string) => {
        try {
            const bridge = window.electron;
            if (action === 'cancel' && id) await bridge?.renderQueueCancel?.(id);
            else if (action === 'remove' && id) await bridge?.renderQueueRemove?.(id);
        } catch { /* best effort; the next queue event resyncs */ }
    };

    return (
        <details style={{ position: 'relative' }}>
            <summary
                role="button"
                style={{
                    listStyle: 'none', cursor: 'pointer', userSelect: 'none',
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    padding: '3px 10px', borderRadius: 999,
                    border: '1px solid #3a2a5e', background: '#14082a',
                    color: '#d9c9ff', fontSize: 11, whiteSpace: 'nowrap',
                }}
                title="Render queue — encode this node's chain without Resolve"
            >
                <span aria-hidden="true">⚡</span>
                {running
                    ? `Rendering ${running.progress ? `${Math.round(running.progress.percent)}%` : '…'}`
                    : active.length > 0 ? `Queue · ${active.length}` : 'Render…'}
            </summary>
            <div style={{
                position: 'absolute', right: 0, top: '120%', zIndex: 50, minWidth: 380,
                background: '#120726', border: '1px solid #3a2a5e', borderRadius: 8,
                padding: 10, fontSize: 11, color: '#e8ddff',
                boxShadow: '0 8px 30px rgba(0,0,0,0.5)',
            }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    <strong style={{ fontWeight: 600 }}>Render chain</strong>
                    <select
                        value={encoder}
                        onChange={e => setEncoder(e.target.value)}
                        style={{ background: '#1c0f38', color: '#e8ddff', border: '1px solid #3a2a5e', borderRadius: 4, fontSize: 11, padding: '2px 4px' }}
                        aria-label="Encoder"
                    >
                        {Object.entries(encoders).map(([key, value]) => (
                            <option key={key} value={key}>{value.label}</option>
                        ))}
                        {Object.keys(encoders).length === 0 && <option value="prores">ProRes 422 HQ (10-bit 4:2:2)</option>}
                    </select>
                    <button
                        type="button"
                        onClick={enqueue}
                        style={{
                            minHeight: 26, padding: '3px 12px', marginLeft: 'auto',
                            background: 'linear-gradient(135deg, #ff2bd6, #8a2be2)',
                            border: 'none', color: '#fff', borderRadius: 4,
                            cursor: 'pointer', fontSize: 11, fontWeight: 600,
                        }}
                        title="Encode this node's composed chain to a file (no Resolve render)"
                    >Render this node…</button>
                </div>
                {note && <div style={{ color: '#ff7b72', marginBottom: 6 }}>{note}</div>}
                {jobs.length === 0 ? (
                    <div style={{ color: '#9a8fb3' }}>
                        Renders the node's composed chain with the bundled VapourSynth runtime —
                        no Resolve render needed. Jobs run one at a time.
                    </div>
                ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 240, overflowY: 'auto' }}>
                        {jobs.map(job => (
                            <div key={job.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                <span style={{ color: chipColor(job.state), minWidth: 72, fontWeight: 600 }}>
                                    {STATE_LABEL[job.state] ?? job.state}
                                </span>
                                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                                      title={job.error || job.outputPath}>
                                    {job.label || job.outputPath.split('/').pop()}
                                    {job.state === 'running' && job.progress ? ` · ${Math.round(job.progress.percent)}%` : ''}
                                    {job.state === 'error' && job.error ? ` — ${job.error.split('\n')[0]}` : ''}
                                </span>
                                {(job.state === 'queued' || job.state === 'running') && (
                                    <button type="button" onClick={() => act('cancel', job.id)}
                                        style={{ background: 'none', border: '1px solid #3a2a5e', color: '#d2a8ff', borderRadius: 4, fontSize: 10, padding: '1px 8px', cursor: 'pointer' }}>
                                        Cancel
                                    </button>
                                )}
                                {!(job.state === 'queued' || job.state === 'running') && (
                                    <button type="button" onClick={() => act('remove', job.id)}
                                        style={{ background: 'none', border: '1px solid #3a2a5e', color: '#9a8fb3', borderRadius: 4, fontSize: 10, padding: '1px 8px', cursor: 'pointer' }}>
                                        Remove
                                    </button>
                                )}
                            </div>
                        ))}
                        {finished > 0 && (
                            <button type="button"
                                onClick={() => { try { window.electron?.renderQueueClear?.(); } catch { /* bridge gone */ } }}
                                style={{ alignSelf: 'flex-start', background: 'none', border: '1px solid #3a2a5e', color: '#9a8fb3', borderRadius: 4, fontSize: 10, padding: '1px 8px', cursor: 'pointer', marginTop: 2 }}>
                                Clear finished
                            </button>
                        )}
                    </div>
                )}
            </div>
        </details>
    );
};
