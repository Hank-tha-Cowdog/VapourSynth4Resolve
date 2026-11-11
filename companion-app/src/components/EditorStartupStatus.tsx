import React from 'react';
import type { EditorStartupState } from '../services/editor-bootstrap';

export const EditorStartupStatus: React.FC<{
    state: EditorStartupState;
    onClose?: () => void;
}> = ({ state, onClose }) => {
    if (state.phase === 'ready' && (state.mode === 'host' || state.mode === 'host-manual') && !state.detail) return null;
    const waiting = state.phase === 'waiting';
    const ready = state.phase === 'ready';
    return (
        <section aria-label="Editor configuration setup" style={{
            padding: ready ? '8px 16px' : 24, background: '#160a24',
            color: '#f0e6ff', lineHeight: 1.5, fontSize: 12, flexShrink: 0,
        }}>
            <div role={state.phase === 'unavailable' ? 'alert' : 'status'}>
                <strong>{ready ? state.mode === 'host' ? 'Host configuration was reported for this editor.'
                    : state.mode === 'host-manual' ? 'Manual host apply: editor configuration was reported.'
                    : state.mode === 'standalone' ? 'Standalone editor: no host result path was reported.'
                    : 'Configuration received through the compatibility host-sync channel.'
                    : waiting ? 'Waiting for editor configuration.' : 'Editor configuration unavailable.'}</strong>
                {state.detail && <div tabIndex={0} role="region" aria-label="Editor configuration details"
                    style={{ maxHeight: 160, overflowY: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                    {state.detail}
                </div>}
            </div>
            {!ready && (
                <p>Editing and automatic configuration writes are held until configuration is received.
                    Check the companion and host setup; this view does not retry or confirm native recovery.</p>
            )}
            {onClose && !ready && (
                <button type="button" onClick={onClose} style={{
                    minHeight: 44, padding: '6px 14px', color: '#f0e6ff',
                    background: '#2a1850', border: '1px solid #705080', borderRadius: 4,
                }}>Close editor</button>
            )}
        </section>
    );
};
