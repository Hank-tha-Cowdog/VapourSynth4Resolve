import React from 'react';
import type { ConfigWriteFeedback } from '../services/config-write-feedback';

const LABELS: Record<ConfigWriteFeedback['outcome'], string> = {
    idle: '',
    waiting: 'Waiting for a companion configuration reply.',
    'bridge-unavailable': 'Configuration bridge unavailable; this action was not invoked.',
    'no-host-path': 'The companion reported no host configuration path.',
    'not-attempted': 'The companion reported that the file write could not be started.',
    'editor-only': 'Edits remain in this editor; no pending file write was requested.',
    'write-reported': 'The companion reported a configuration file write.',
    unconfirmed: 'One or more configuration-write outcomes are unconfirmed.',
};

export interface WorkspaceStatusCounts {
    total?: number;
    approved?: number;
    drafts?: number;
    disabled?: number;
    chatMessages?: number;
}

// ONE status chip (live feedback Oct 27: the persistent green "Chain
// configured" strip AND the separate write-details row both wasted vertical
// space). Contract:
//   - mounted INLINE in the existing tab bar — zero extra status-row height
//   - native <details>: click/Enter toggles; closing leaves no row behind
//   - keyboard + label + text: never color alone
//   - genuine errors show INLINE in the chip (discoverable without opening)
//   - routine publishing instructions + the reply disclaimer live INSIDE the
//     details body, in the DOM for AT/static markup, not stacked as banners
//   - truthful: chain counts come from the ACTIVE node's React state; write
//     feedback is this window's own observation — never another node's.
//   - 'configured' (chain built), 'saved' (write reported), 'accepted by the
//     plugin' (host status) and 'rendered' are distinct; the chip labels the
//     write/save layer only and defers render status to the plugin banner.
export const ConfigWriteStatus: React.FC<{
    feedback: ConfigWriteFeedback;
    manualHostApply?: boolean;
    counts?: WorkspaceStatusCounts;
}> = ({ feedback, manualHostApply = false, counts }) => {
    const quiet = feedback.outcome === 'idle' && !feedback.pending && !feedback.unconfirmedDetail
        && !feedback.detail && !feedback.closeScheduled;
    // Same contract as the old row: a quiet non-manual window renders
    // nothing. Manual-host windows always show the chip (it is the single
    // status surface now), and any activity/error shows regardless.
    if (!manualHostApply && quiet) return null;

    const errorish = feedback.outcome === 'unconfirmed'
        || feedback.outcome === 'bridge-unavailable'
        || feedback.outcome === 'not-attempted'
        || feedback.outcome === 'no-host-path'
        || !!feedback.unconfirmedDetail;

    // Chip label: state word (never color alone) + inline error when real.
    const stateWord = errorish ? 'Error' : quiet ? 'OK' : 'Activity';
    const chainSummary = counts && typeof counts.total === 'number'
        ? `${counts.total} step${counts.total === 1 ? '' : 's'}`
            + (counts.drafts ? `, ${counts.drafts} draft${counts.drafts === 1 ? '' : 's'}` : '')
        : null;

    return (
        <details aria-label="Workspace status and write details" style={{
            fontSize: 11, flexShrink: 0, position: 'relative', color: '#c4b5d8',
        }}>
            <summary style={{
                listStyle: 'none', display: 'inline-flex', alignItems: 'center',
                gap: 6, cursor: 'pointer', minHeight: 24, padding: '0 8px',
                border: '1px solid', borderRadius: 11,
                borderColor: errorish ? '#925065' : '#3a2456',
                background: errorish ? 'rgba(146, 80, 101, 0.25)' : '#160a24',
                color: errorish ? '#ffc1ce' : '#e3d4f0',
            }} aria-label={`Workspace status: ${stateWord}${chainSummary ? `, ${chainSummary}` : ''}. Open for write details.`}>
                <span aria-hidden="true" style={{
                    width: 7, height: 7, borderRadius: 4,
                    background: errorish ? '#ff5577' : quiet ? '#44ff99' : '#f4ce91',
                    display: 'inline-block',
                }} />
                <strong style={{ fontWeight: 600 }}>{stateWord}</strong>
                {chainSummary && <span style={{ opacity: 0.75 }}>{chainSummary}</span>}
                <span style={{ opacity: 0.6, fontSize: 10 }}>details</span>
            </summary>
            <div style={{
                position: 'absolute', right: 0, top: '100%', zIndex: 30,
                minWidth: 300, maxWidth: 420, padding: '10px 12px', marginTop: 4,
                background: '#100b19', border: '1px solid #493857', borderRadius: 6,
                boxShadow: '0 8px 24px rgba(0,0,0,0.55)', fontSize: 11, lineHeight: 1.5,
                color: '#e3d4f0',
            }} tabIndex={0} role="group"
                aria-label="Write and chain status details for this window">
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
                    <strong>Write status</strong>
                    <span role={feedback.error ? 'alert' : 'status'}>{LABELS[feedback.outcome] || 'Idle.'}</span>
                </div>
                {feedback.closeScheduled && <div role="status">Window closing was scheduled, not confirmed.</div>}
                {feedback.pending > 0 && (
                    <div role="status">{feedback.pending} configuration request{feedback.pending === 1 ? '' : 's'} still await{feedback.pending === 1 ? 's' : ''} a reply.</div>
                )}
                {feedback.unconfirmedDetail && (
                    <div role="alert" style={{ color: '#ffb5c4', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                        An earlier write outcome remains unconfirmed. {feedback.unconfirmedDetail}
                    </div>
                )}
                {feedback.detail && (
                    <div style={{
                        whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
                        maxHeight: 120, overflowY: 'auto', color: '#e3d5f5',
                    }}>
                        {feedback.detail}
                    </div>
                )}
                {manualHostApply && <div role="note" style={{ marginTop: 6 }}>
                    Use <strong>Save and close</strong> to publish edits. The node applies them
                    automatically when this window closes — no further <strong>Resolve-side action</strong> is needed.
                </div>}
                <div style={{ marginTop: 6, color: '#c4b5d8' }}>
                    These replies do not confirm that Resolve applied or rendered the configuration.
                </div>
            </div>
        </details>
    );
};