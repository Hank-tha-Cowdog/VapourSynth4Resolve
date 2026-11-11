// Provider settings — API keys (cloud) + endpoint URLs (local backends).
//
// Each provider row shows saved-key status (Key saved / No key saved) plus inputs to
// update. Keys are stored in the macOS Keychain (service: com.vapoursynth.resolveofx,
// account: <providerId>) via the main-process keytar wrapper. Endpoint URLs live in
// a plain JSON sidecar so users can hand-edit if they prefer.

import React, { useCallback, useEffect, useId, useState } from 'react';
import { Check, Key, Globe, Eye, EyeOff } from 'lucide-react';
import { BrailleSpinner } from './BrailleSpinner';
import { SettingsDialog } from './SettingsDialog';
import type { ProviderCatalogEntry } from '../types';

interface Props {
    onClose: () => void;
}

interface RowState {
    keyInput: string;
    endpointInput: string;
    masked: string | null;
    hasKey: boolean;
    showKey: boolean;
    saving: 'idle' | 'saving' | 'saved' | 'error';
    errorMessage?: string;
}

export const SettingsModal: React.FC<Props> = ({ onClose }) => {
    const [catalog, setCatalog] = useState<Record<string, ProviderCatalogEntry> | null>(null);
    const [rows, setRows] = useState<Record<string, RowState>>({});
    const [loadError, setLoadError] = useState<string | null>(null);

    // Load provider catalog + current API-key status on mount.
    useEffect(() => {
        (async () => {
            const cat = await window.electron?.listProviders?.();
            if (!cat) throw new Error('Settings bridge is unavailable');
            setCatalog(cat);
            const initial: Record<string, RowState> = {};
            for (const pid of Object.keys(cat)) {
                const status = await window.electron?.hasApiKey?.(pid);
                let endpoint = '';
                let endpointError: string | undefined;
                try { endpoint = (await window.electron?.getEndpoint?.(pid)) || ''; }
                catch (e: any) { endpointError = e?.message || 'Endpoint could not be loaded'; }
                initial[pid] = {
                    keyInput: '',
                    endpointInput: endpoint || '',
                    masked: status?.masked ?? null,
                    hasKey: status?.hasKey ?? false,
                    showKey: false,
                    saving: endpointError ? 'error' : 'idle',
                    errorMessage: endpointError,
                };
            }
            setRows(initial);
        })().catch((e) => setLoadError(e?.message || 'Settings could not be loaded'));
    }, []);

    const updateRow = useCallback((pid: string, patch: Partial<RowState>) => {
        setRows(r => ({ ...r, [pid]: { ...r[pid], ...patch } }));
    }, []);

    const saveKey = useCallback(async (pid: string) => {
        const row = rows[pid];
        if (!row) return;
        updateRow(pid, { saving: 'saving' });
        try {
            const api = window.electron;
            if (!api?.setApiKey || !api?.setEndpoint || !api?.hasApiKey) {
                throw new Error('Settings bridge is unavailable');
            }
            if (row.keyInput.length > 0 && !row.keyInput.trim()) {
                throw new Error('Enter an API key or use Forget key');
            }
            // Validate/persist the endpoint before saving a new key, so an invalid
            // credential-bearing URL cannot make a failed Save store that key.
            await api.setEndpoint(pid, row.endpointInput || '');
            if (row.keyInput.length > 0) {
                await api.setApiKey(pid, row.keyInput);
            }
            const status = await api.hasApiKey(pid);
            updateRow(pid, {
                saving: 'saved',
                keyInput: '',
                hasKey: status?.hasKey ?? false,
                masked: status?.masked ?? null,
            });
            setTimeout(() => updateRow(pid, { saving: 'idle' }), 1400);
        } catch (e: any) {
            updateRow(pid, { saving: 'error', errorMessage: e?.message || String(e) });
        }
    }, [rows, updateRow]);

    const clearKey = useCallback(async (pid: string) => {
        updateRow(pid, { saving: 'saving' });
        try {
            const api = window.electron;
            if (!api?.setApiKey || !api?.hasApiKey) throw new Error('Settings bridge is unavailable');
            await api.setApiKey(pid, '');
            const status = await api.hasApiKey(pid);
            updateRow(pid, {
                saving: 'saved', keyInput: '',
                hasKey: status?.hasKey ?? false, masked: status?.masked ?? null,
            });
            setTimeout(() => updateRow(pid, { saving: 'idle' }), 1400);
        } catch (e: any) {
            updateRow(pid, { saving: 'error', errorMessage: e?.message || 'Key could not be removed' });
        }
    }, [updateRow]);

    return (
        <SettingsDialog onClose={onClose}>
                <div style={{
                    overflowY: 'auto',
                    padding: '12px 18px 18px',
                    fontSize: 13,
                }}>
                    <p style={{ opacity: 0.6, marginTop: 6, marginBottom: 16, fontSize: 12, lineHeight: 1.55 }}>
                        Keys are stored in the macOS Keychain (service{' '}
                        <code style={{ color: '#a3ff8a' }}>com.vapoursynth.resolveofx</code>).
                        Local backends (LM Studio, Ollama) don't need keys but need an endpoint URL.
                        Tool use (chain edits via Skippy's <code>propose_chain_edit</code>) is
                        only implemented on Anthropic for now — other providers respond with text only.
                    </p>

                    {loadError && <p role="alert" style={{ color: '#ff5577' }}>{loadError}</p>}
                    {!catalog && !loadError ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, opacity: 0.7 }}>
                            <BrailleSpinner size={14} />
                            Loading providers…
                        </div>
                    ) : (
                        Object.entries(catalog || {}).map(([pid, cfg]) => {
                            const row = rows[pid];
                            if (!row) return null;
                            return (
                                <ProviderRow
                                    key={pid}
                                    pid={pid}
                                    cfg={cfg}
                                    row={row}
                                    onUpdate={updateRow}
                                    onSave={saveKey}
                                    onClear={clearKey}
                                />
                            );
                        })
                    )}
                </div>
        </SettingsDialog>
    );
};

interface RowProps {
    pid: string;
    cfg: ProviderCatalogEntry;
    row: RowState;
    onUpdate: (pid: string, patch: Partial<RowState>) => void;
    onSave: (pid: string) => void;
    onClear: (pid: string) => void;
}

const ProviderRow: React.FC<RowProps> = ({ pid, cfg, row, onUpdate, onSave, onClear }) => {
    const id = useId();
    const labelId = `provider-label-${id}`;
    const hintId = `provider-entry-hint-${id}`;
    const errorId = `provider-error-${id}`;
    const busy = row.saving === 'saving';
    const describedBy = row.saving === 'error' ? `${hintId} ${errorId}` : hintId;
    const entryHint = cfg.needsApiKey
        ? row.hasKey
            ? 'Leave the API-key field empty to keep the saved key. Use Forget key to remove it.'
            : 'Enter your own API key, then choose Save.'
        : 'No API key is needed; enter the endpoint URL for your local backend.';
    return (
        <section aria-labelledby={labelId} style={{
            padding: '12px 0',
            borderBottom: '1px solid rgba(255, 43, 214, 0.12)',
        }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <strong id={labelId} style={{ fontSize: 13, color: '#f0e6ff' }}>{cfg.label}</strong>
                {cfg.supportsTools && (
                    <span style={{
                        fontSize: 9, padding: '1px 6px', letterSpacing: 0.4,
                        background: 'rgba(255, 43, 214, 0.18)',
                        border: '1px solid rgba(255, 43, 214, 0.45)',
                        color: '#ff2bd6', borderRadius: 3, textTransform: 'uppercase',
                    }}>
                        tool use
                    </span>
                )}
                <div style={{ flex: 1 }} />
                {cfg.needsApiKey && row.hasKey ? (
                    <span style={{
                        fontSize: 10, color: '#44ff99', display: 'flex', alignItems: 'center', gap: 4,
                    }}>
                        <Check size={11} /> Key saved {row.masked ? `(${row.masked})` : ''}
                    </span>
                ) : cfg.needsApiKey ? (
                    <span style={{ fontSize: 10, opacity: 0.5 }}>No key saved</span>
                ) : (
                    <span style={{ fontSize: 10, opacity: 0.6 }}>No key needed</span>
                )}
                {(busy || row.saving === 'saved') && (
                    <span role="status" style={{ fontSize: 11, color: busy ? '#c5b7d1' : '#44ff99' }}>
                        {busy ? 'Updating settings…' : 'Settings updated'}
                    </span>
                )}
            </div>

            <p id={hintId} style={{ color: '#c5b7d1', fontSize: 12, lineHeight: 1.5, margin: '0 0 8px' }}>
                {entryHint} Save stores settings; it does not test the connection.
            </p>

            {cfg.needsApiKey && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                    <Key size={12} color="#888" />
                    <input
                        aria-label={`API key for ${cfg.label}`}
                        aria-describedby={describedBy}
                        disabled={busy}
                        type={row.showKey ? 'text' : 'password'}
                        autoComplete="off"
                        autoCapitalize="none"
                        spellCheck={false}
                        value={row.keyInput}
                        onChange={(e) => onUpdate(pid, { keyInput: e.target.value })}
                        placeholder={row.hasKey ? 'enter new key to replace' : 'paste API key'}
                        style={inputStyle}
                    />
                    <button type="button"
                        onClick={() => onUpdate(pid, { showKey: !row.showKey })}
                        aria-label={`Show entered API key for ${cfg.label}`}
                        aria-pressed={row.showKey}
                        disabled={busy}
                        title={row.showKey ? 'Hide' : 'Reveal'}
                        style={iconBtnStyle}
                    >
                        {row.showKey ? <EyeOff size={12} /> : <Eye size={12} />}
                    </button>
                </div>
            )}

            {(cfg.defaultEndpoint || !cfg.needsApiKey) && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                    <Globe size={12} color="#888" />
                    <input
                        aria-label={`Endpoint URL for ${cfg.label}`}
                        aria-describedby={describedBy}
                        disabled={busy}
                        type="text"
                        value={row.endpointInput}
                        onChange={(e) => onUpdate(pid, { endpointInput: e.target.value })}
                        placeholder={cfg.defaultEndpoint || 'endpoint URL'}
                        style={inputStyle}
                    />
                </div>
            )}

            {row.saving === 'error' && (
                <p id={errorId} role="alert" style={{
                    color: '#ff8aa0', fontSize: 12, lineHeight: 1.5,
                    margin: '0 0 8px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
                }}>
                    Settings need attention: {row.errorMessage || 'The operation did not complete. Review the entries and try again.'}
                </p>
            )}

            <div style={{ display: 'flex', gap: 8, fontSize: 11 }}>
                <button type="button" onClick={() => onSave(pid)} style={primaryBtn} disabled={busy}
                    aria-label={`${busy ? 'Updating settings' : 'Save settings'} for ${cfg.label}`}>
                    {busy ? <BrailleSpinner size={11} /> : null}
                    {busy ? 'Updating…' : 'Save'}
                </button>
                {row.hasKey && cfg.needsApiKey && (
                    <button type="button" onClick={() => onClear(pid)} style={ghostBtn} disabled={busy}
                        aria-label={`Forget saved API key for ${cfg.label}`}>
                        Forget key
                    </button>
                )}
                <div style={{ flex: 1 }} />
                <span style={{ fontSize: 10, opacity: 0.45, alignSelf: 'center' }}>
                    {cfg.models.length} model{cfg.models.length === 1 ? '' : 's'}
                </span>
            </div>
        </section>
    );
};

const inputStyle: React.CSSProperties = {
    flex: 1,
    background: '#0a0414',
    color: '#f0e6ff',
    border: '1px solid #2a1850',
    borderRadius: 4,
    padding: '5px 8px',
    fontSize: 12,
    fontFamily: 'JetBrains Mono, Menlo, monospace',
};

const iconBtnStyle: React.CSSProperties = {
    background: 'transparent',
    border: '1px solid #2a1850',
    color: '#aaa',
    cursor: 'pointer',
    padding: 4,
    borderRadius: 4,
    display: 'flex', alignItems: 'center',
    minWidth: 44, minHeight: 44,
};

const primaryBtn: React.CSSProperties = {
    padding: '4px 12px',
    background: 'linear-gradient(135deg, #ff2bd6, #8a2be2)',
    border: 'none', color: '#fff', borderRadius: 4,
    cursor: 'pointer', fontWeight: 600,
    display: 'flex', alignItems: 'center', gap: 6,
    minHeight: 44,
};

const ghostBtn: React.CSSProperties = {
    padding: '4px 10px',
    background: 'transparent',
    border: '1px solid #555',
    color: '#aaa', borderRadius: 4,
    cursor: 'pointer',
    minHeight: 44,
};
