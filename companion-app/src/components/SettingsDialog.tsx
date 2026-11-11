import React, { useEffect, useId, useRef } from 'react';
import { Key, X } from 'lucide-react';
import { handleSettingsDialogKey, mountSettingsDialogFocus } from '../services/settings-dialog-focus';

interface Props {
    children: React.ReactNode;
    onClose: () => void;
}

// Presentation and keyboard lifecycle only; provider/key operations belong to SettingsModal.
export const SettingsDialog: React.FC<Props> = ({ children, onClose }) => {
    const dialogRef = useRef<HTMLDivElement>(null);
    const titleId = `provider-settings-title-${useId()}`;
    const hintId = `provider-settings-hint-${useId()}`;
    useEffect(() => {
        if (dialogRef.current) return mountSettingsDialogFocus(dialogRef.current);
    }, []);

    return (
        <div onClick={onClose} style={{
            position: 'fixed', inset: 0, background: 'rgba(0, 0, 0, 0.7)',
            backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center',
            justifyContent: 'center', zIndex: 1000,
        }}>
            <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId}
                aria-describedby={hintId} tabIndex={-1}
                onClick={event => event.stopPropagation()}
                onKeyDown={event => {
                    if (dialogRef.current) handleSettingsDialogKey({
                        key: event.key, shiftKey: event.shiftKey,
                        defaultPrevented: event.defaultPrevented,
                        isComposing: event.nativeEvent.isComposing, keyCode: event.nativeEvent.keyCode,
                        preventDefault: () => event.preventDefault(),
                        stopPropagation: () => event.stopPropagation(),
                    }, dialogRef.current, onClose);
                }}
                style={{
                    width: 'min(640px, 92vw)', maxHeight: '86vh', background: '#100722',
                    border: '1px solid rgba(255, 43, 214, 0.4)', borderRadius: 10,
                    boxShadow: '0 0 40px rgba(255, 43, 214, 0.25), 0 8px 32px rgba(0, 0, 0, 0.5)',
                    display: 'flex', flexDirection: 'column',
                }}>
                <header style={{
                    padding: '10px 18px', borderBottom: '1px solid #2a1850',
                    display: 'flex', alignItems: 'center', gap: 10,
                    background: 'linear-gradient(90deg, #1a0830 0%, #2a0f4a 50%, #1a0830 100%)',
                }}>
                    <Key size={16} color="#ff2bd6" />
                    <div style={{ flex: 1 }}>
                        <strong id={titleId} style={{
                            color: '#ff2bd6', textShadow: '0 0 8px rgba(255, 43, 214, 0.5)',
                            letterSpacing: 0.3,
                        }}>LLM Provider Settings</strong>
                        <p id={hintId} style={{ color: '#c5b7d1', fontSize: 11, margin: '4px 0 0' }}>
                            Press Escape to close settings.
                        </p>
                    </div>
                    <button type="button" data-dialog-initial-focus="" onClick={onClose}
                        aria-label="Close provider settings" title="Close (Escape)"
                        style={{
                            background: 'none', border: 'none', color: '#aaa', cursor: 'pointer',
                            padding: 4, minWidth: 44, minHeight: 44,
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                        }}>
                        <X size={16} />
                    </button>
                </header>
                {children}
            </div>
        </div>
    );
};
