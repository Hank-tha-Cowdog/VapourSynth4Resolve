// Skippy — persistent, collapsible per-node AI chat panel.
//
// Forked from vapoursage's SageComms.tsx, rewritten leaner for the OFX-popout context.
// Pending chain edits are received from main.js via the propose_chain_edit tool;
// they're rendered as a Confirm card inside the assistant message. Apply mutates the
// chain via the parent's handler and converts the pendingAction to an APPLIED receipt
// so the buttons disappear.

import React, { useEffect, useId, useRef } from 'react';
import { Brain, X, Check, ChevronRight, Zap, ZapOff, Settings, FileDown, PanelLeftClose, Copy } from 'lucide-react';
import { BrailleSpinner } from './BrailleSpinner';
import type { ChatMessage, LLMModel, ChainOperation } from '../types';
import { LLM_MODELS } from '../constants';
import { summarizeOperations } from '../services/chain-ops';
import { canSendChatMessage, composerKeyAction } from '../services/chat-composer';

interface ArchivistChatProps {
    width: number;
    isResizing: boolean;
    startResizing: (e: React.MouseEvent) => void;
    messages: ChatMessage[];
    isThinking: boolean;
    requestUncertain?: boolean;
    inputValue: string;
    setInputValue: (s: string) => void;
    handleSend: () => void;
    selectedModel: LLMModel | null;
    setSelectedModel: (m: LLMModel) => void;
    autoApply: boolean;
    onSetAutoApply: (v: boolean) => void;
    onOpenSettings: () => void;
    onToggleCollapse: () => void;
    onExportChat: () => void;
    onApplyChainEdit: (messageId: string, operations: ChainOperation[]) => void;
    onDismissChainEdit: (messageId: string) => void;
}

export const ArchivistChat: React.FC<ArchivistChatProps> = ({
    width, isResizing, startResizing, messages, isThinking, requestUncertain = false, inputValue, setInputValue,
    handleSend, selectedModel, setSelectedModel, autoApply, onSetAutoApply,
    onOpenSettings, onToggleCollapse, onExportChat, onApplyChainEdit, onDismissChainEdit,
}) => {
    const endRef = useRef<HTMLDivElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const composerHintId = `skippy-composer-hint-${useId()}`;
    const busy = isThinking || requestUncertain;
    const sendBlocked = busy || !selectedModel;
    const canSend = canSendChatMessage(inputValue, sendBlocked);

    // CONTAINED scroll only. scrollIntoView() walks EVERY scrollable ancestor
    // — including the WINDOW — and fired on chat REMOUNT while the workspace
    // was mid-reflow (chat reopen + scopes open): it scrolled the document
    // 214px, clipping the title bar (owner reproduction 2026-10-29). Scrolling
    // the chat's OWN list (scrollTop, like LogsPanel) can never move the page.
    useEffect(() => {
        const list = listRef.current;
        if (list) list.scrollTop = list.scrollHeight;
    }, [messages, isThinking]);

    const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        const action = composerKeyAction({ key: e.key, shiftKey: e.shiftKey,
            isComposing: e.nativeEvent.isComposing, keyCode: e.nativeEvent.keyCode,
            repeat: e.repeat }, inputValue, sendBlocked);
        if (action !== 'native') e.preventDefault();
        if (action === 'send') handleSend();
    };

    return (
        <aside aria-label="Skippy chat" style={{
            width, flexShrink: 0,
            display: 'flex', flexDirection: 'column',
            background: '#100722', borderLeft: '1px solid #2a1850',
            position: 'relative', overflow: 'hidden',
        }}>
            <div onMouseDown={startResizing} style={{
                position: 'absolute', left: 0, top: 0, bottom: 0, width: 4,
                cursor: 'col-resize',
                background: isResizing ? '#ff2bd6' : 'transparent',
                transition: 'background 0.15s', zIndex: 2,
            }} />

            <header style={{
                padding: '6px 12px',
                display: 'flex', alignItems: 'center', gap: 8,
                flexWrap: 'wrap',
                borderBottom: '1px solid #2a1850',
                background: 'linear-gradient(180deg, #1a0830 0%, #100722 100%)',
                minWidth: 0,
            }}>
                <Brain size={16} color="#ff2bd6" />
                <strong style={{
                    color: '#ff2bd6', fontSize: 13,
                    textShadow: '0 0 8px rgba(255, 43, 214, 0.5)',
                }}>Skippy</strong>
                <div style={{ flex: '1 1 8px', minWidth: 0 }} />
                <AutoApplyToggle value={autoApply} onChange={onSetAutoApply} />
                <ModelSelector selected={selectedModel} onSelect={setSelectedModel} />
                <button type="button" onClick={onOpenSettings} aria-label="Open provider settings"
                    style={{ background: 'none', border: 'none', color: '#999', cursor: 'pointer',
                        padding: 2, minWidth: 28, minHeight: 28, display: 'inline-flex', alignItems: 'center' }}
                    title="Provider settings — API keys + endpoints"
                >
                    <Settings size={14} />
                </button>
                <button type="button" onClick={onExportChat} aria-label="Export this node's conversation to Markdown"
                    style={{ background: 'none', border: 'none', color: '#999', cursor: 'pointer',
                        padding: 2, minWidth: 28, minHeight: 28, display: 'inline-flex', alignItems: 'center' }}
                    title="Export conversation to Markdown (this node only)"
                >
                    <FileDown size={14} />
                </button>
                {/* CLEAR collapse affordance (live feedback: the X was not
                    discoverable as collapse). PanelLeftClose + 'Collapse' label. */}
                <button type="button" onClick={onToggleCollapse} aria-label="Collapse Skippy chat to the side"
                    aria-expanded={true}
                    style={{ background: 'none', border: 'none', color: '#999', cursor: 'pointer',
                        padding: '2px 6px', display: 'inline-flex', alignItems: 'center', gap: 4,
                        fontSize: 11 }}
                    title="Collapse chat to the side panel"
                >
                    <PanelLeftClose size={14} />
                    <span>Collapse</span>
                </button>
            </header>

            <div ref={listRef} style={{
                flex: 1, overflowY: 'auto', padding: '12px 14px',
                display: 'flex', flexDirection: 'column', gap: 10,
            }}>
                {messages.map((m) => (
                    <MessageBubble key={m.id} message={m}
                        onApply={(ops) => onApplyChainEdit(m.id, ops)}
                        onDismiss={() => onDismissChainEdit(m.id)}
                    />
                ))}
                {busy && (
                    <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 10, opacity: 0.85, fontSize: 12 }}>
                        {!requestUncertain && <BrailleSpinner size={16} />}
                        <span style={{ fontStyle: 'italic', color: '#d9b6ff' }}>
                            {requestUncertain ? 'Request status unknown. Sending is paused.' : 'Skippy is thinking…'}
                        </span>
                    </div>
                )}
                <div ref={endRef} />
            </div>

            <div style={{
                padding: '10px 14px', borderTop: '1px solid #2a1850',
                background: '#0a0414',
            }}>
                <textarea
                    aria-label="Message Skippy"
                    aria-describedby={composerHintId}
                    value={inputValue}
                    onChange={(e) => setInputValue(e.target.value)}
                    onKeyDown={onKeyDown}
                    placeholder={autoApply
                        ? "Ask Skippy — edits apply live as you watch…"
                        : "Ask Skippy for help…"}
                    rows={3}
                    style={{
                        width: '100%', boxSizing: 'border-box',
                        background: '#1a0830', color: '#f0e6ff',
                        border: '1px solid #2a1850', borderRadius: 6, padding: 8,
                        fontSize: 13, fontFamily: 'inherit', resize: 'none',
                        minHeight: 44,
                    }}
                />
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                    <span id={composerHintId} style={{ color: '#c5b7d1', fontSize: 11, lineHeight: 1.4,
                        flex: '1 1 120px', minWidth: 0, overflowWrap: 'anywhere' }}>
                        {requestUncertain ? 'Keep drafting. Sending stays blocked until the request is confirmed ended.'
                            : isThinking ? 'Waiting for Skippy. You can keep drafting.'
                            : !selectedModel ? 'Saved model unavailable in this build. Pick a model in the selector above. Your draft is kept.'
                            : 'Enter to send · Shift+Enter for a new line'}
                    </span>
                    <button type="button" onClick={handleSend} disabled={!canSend}
                        style={{
                            padding: '4px 12px', minHeight: 44,
                            background: canSend
                                ? 'linear-gradient(135deg, #ff2bd6, #8a2be2)'
                                : '#2a1850',
                            border: 'none', color: '#fff', borderRadius: 4,
                            cursor: canSend ? 'pointer' : 'not-allowed',
                            fontSize: 12, fontWeight: 600, flexShrink: 0,
                        }}
                    >
                        {requestUncertain ? 'Waiting for status' : isThinking ? 'Waiting for Skippy' : 'Send'}
                    </button>
                </div>
            </div>
        </aside>
    );
};

const AutoApplyToggle: React.FC<{ value: boolean; onChange: (v: boolean) => void }> = ({ value, onChange }) => (
    <button
        onClick={() => onChange(!value)}
        title={value
            ? 'Auto-apply ON — chain edits apply immediately'
            : 'Auto-apply OFF — chain edits show a Confirm card'}
        style={{
            display: 'flex', alignItems: 'center', gap: 4,
            padding: '2px 8px',
            background: value ? 'rgba(255, 43, 214, 0.18)' : 'transparent',
            border: value ? '1px solid #ff2bd6' : '1px solid #2a1850',
            color: value ? '#ff2bd6' : '#999',
            borderRadius: 4, cursor: 'pointer', fontSize: 10,
            fontWeight: 600, letterSpacing: 0.5,
            textShadow: value ? '0 0 6px rgba(255, 43, 214, 0.6)' : 'none',
            textTransform: 'uppercase',
        }}
    >
        {value ? <Zap size={11} /> : <ZapOff size={11} />}
        Auto
    </button>
);

const MessageBubble: React.FC<{
    message: ChatMessage;
    onApply: (operations: ChainOperation[]) => void;
    onDismiss: () => void;
}> = ({ message, onApply, onDismiss }) => {
    // Per-message copy-to-clipboard with visible success feedback.
    const [copied, setCopied] = React.useState(false);
    const onCopyMessage = async () => {
        try {
            await navigator.clipboard.writeText(message.text);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1400);
        } catch { /* clipboard permission; text selection still works */ }
    };
    const isUser = message.role === 'user';
    const isCompaction = message.kind === 'compaction';
    const pa = message.pendingAction;
    return (
        <div style={{
            alignSelf: isCompaction ? 'stretch' : (isUser ? 'flex-end' : 'flex-start'),
            maxWidth: isCompaction ? '100%' : '88%',
            background: isCompaction
                ? 'rgba(138, 43, 226, 0.10)'
                : (isUser
                    ? 'linear-gradient(135deg, #6a1b9a, #4a148c)'
                    : '#1a0830'),
            border: isCompaction
                ? '1px dashed rgba(255, 43, 214, 0.4)'
                : (isUser ? 'none' : '1px solid #2a1850'),
            borderRadius: 8, padding: '8px 12px',
            fontSize: isCompaction ? 12 : 13, lineHeight: 1.45,
            opacity: isCompaction ? 0.85 : 1,
        }}>
            <div style={{
                fontSize: 10, opacity: 0.55, marginBottom: 4,
                textTransform: 'uppercase', letterSpacing: 0.5,
                color: isCompaction ? '#ff2bd6' : undefined,
            }}>
                {isCompaction ? 'Archived history' : (isUser ? 'You' : 'Skippy')}
            </div>
            <div style={{ whiteSpace: 'pre-wrap' }}>{message.text}</div>
            <button type="button" onClick={onCopyMessage}
                aria-label={copied ? 'Message copied to clipboard' : 'Copy this message to the clipboard'}
                title={copied ? 'Copied!' : 'Copy message'}
                style={{
                    position: 'relative', float: 'right',
                    background: 'none', border: 'none', cursor: 'pointer',
                    color: copied ? '#7dffbb' : 'rgba(240, 230, 255, 0.45)',
                    padding: '2px 4px', marginTop: 4,
                }}>
                {copied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
            </button>

            {pa?.type === 'CONFIRM_CHAIN_EDIT' && (
                <PendingChainEdit
                    operations={pa.operations}
                    onApply={() => onApply(pa.operations)}
                    onDismiss={onDismiss}
                />
            )}
            {pa?.type === 'APPLIED' && (
                <ActionReceipt kind="applied" timestamp={pa.appliedAt} />
            )}
            {pa?.type === 'DISMISSED' && (
                <ActionReceipt kind="dismissed" timestamp={pa.dismissedAt} />
            )}
        </div>
    );
};

const PendingChainEdit: React.FC<{
    operations: ChainOperation[];
    onApply: () => void;
    onDismiss: () => void;
}> = ({ operations, onApply, onDismiss }) => (
    <div role="group" aria-label="Proposed chain edit" style={{
        marginTop: 10, padding: 8, background: '#0a0414',
        borderRadius: 6, border: '1px dashed #ff2bd6',
    }}>
        <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 6 }}>
            Proposed chain edit · {summarizeOperations(operations)}
        </div>
        {operations.map((o, i) => (
            <div key={i} style={{ fontSize: 12, marginBottom: 3, display: 'flex', alignItems: 'center', gap: 4 }}>
                <ChevronRight size={10} />
                <OpDescription op={o} />
            </div>
        ))}
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button type="button" aria-label="Apply proposed chain edit" onClick={onApply} style={{
                flex: 1, padding: '4px 8px',
                minHeight: 44,
                background: 'linear-gradient(135deg, #ff2bd6, #8a2be2)',
                border: 'none', color: '#fff', borderRadius: 4,
                cursor: 'pointer', fontSize: 11, fontWeight: 600,
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
            }}>
                <Check size={12} aria-hidden="true" /> Apply proposal
            </button>
            <button type="button" aria-label="Dismiss proposed chain edit" onClick={onDismiss} style={{
                padding: '4px 8px', background: 'transparent',
                minHeight: 44,
                border: '1px solid #555', color: '#aaa',
                borderRadius: 4, cursor: 'pointer', fontSize: 11,
            }}>
                <X size={12} aria-hidden="true" /> Dismiss
            </button>
        </div>
    </div>
);

const OpDescription: React.FC<{ op: ChainOperation }> = ({ op }) => {
    if (op.op === 'add') {
        const labelStr =
            typeof (op.step.params as { label?: unknown }).label === 'string'
                ? ` — ${(op.step.params as { label: string }).label}`
                : '';
        return (
            <span>
                <strong style={{ color: '#44ff99' }}>add</strong>{' '}
                <code>{op.step.type}</code> @ stage {op.step.stage}{labelStr}
            </span>
        );
    }
    if (op.op === 'update') {
        const codeChanged = op.patch.params && 'code' in op.patch.params;
        return (
            <span>
                <strong style={{ color: '#ffaa44' }}>update</strong>{' '}
                <code style={{ opacity: 0.6 }}>{op.targetId.slice(-6)}</code>
                {codeChanged ? ' (script body)' : ''}
                {typeof op.patch.stage === 'number' ? ` → stage ${op.patch.stage}` : ''}
            </span>
        );
    }
    return (
        <span>
            <strong style={{ color: '#ff5577' }}>remove</strong>{' '}
            <code style={{ opacity: 0.6 }}>{op.targetId.slice(-6)}</code>
        </span>
    );
};

const ActionReceipt: React.FC<{ kind: 'applied' | 'dismissed'; timestamp: string }> = ({ kind, timestamp }) => (
    <div style={{
        marginTop: 10, padding: '6px 10px',
        borderRadius: 6,
        background: kind === 'applied' ? 'rgba(68, 255, 153, 0.08)' : 'rgba(120, 120, 120, 0.08)',
        border: `1px solid ${kind === 'applied' ? 'rgba(68, 255, 153, 0.4)' : 'rgba(120, 120, 120, 0.3)'}`,
        fontSize: 10,
        color: kind === 'applied' ? '#44ff99' : '#888',
        display: 'flex', alignItems: 'center', gap: 6,
        textTransform: 'uppercase', letterSpacing: 0.6,
    }}>
        {kind === 'applied' ? <Check size={11} /> : <X size={11} />}
        {kind === 'applied' ? 'Applied' : 'Dismissed'}
        <span style={{ marginLeft: 'auto', opacity: 0.6, fontVariantNumeric: 'tabular-nums' }}>
            {new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </span>
    </div>
);

const ModelSelector: React.FC<{ selected: LLMModel | null; onSelect: (m: LLMModel) => void }> = ({ selected, onSelect }) => (
    <select
        aria-label="Skippy model"
        value={selected?.id ?? ''}
        onChange={(e) => {
            const next = LLM_MODELS.find(m => m.id === e.target.value);
            if (next) onSelect(next);
        }}
        style={{
            background: '#1a0830', color: '#f0e6ff',
            border: '1px solid #2a1850', borderRadius: 4,
            fontSize: 11, padding: '2px 4px', cursor: 'pointer',
        }}
    >
        {!selected && <option value="" disabled>Choose a model</option>}
        {LLM_MODELS.map(m => (
            <option key={m.id} value={m.id}>{m.name}</option>
        ))}
    </select>
);
