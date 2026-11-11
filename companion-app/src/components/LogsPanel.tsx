// Logs tab — streamed VS evaluation + companion-app diagnostics.
// Wired to window.electron.onLog from the existing vapoursage IPC channel.
//
// PERSISTENCE (live feedback Oct 27): the buffer used to live in component
// state and was LOST on every tab unmount. The store is now module-level:
// it survives tab switches and remounts within this companion session.
// Retention is bounded (default 2000 entries, oldest dropped, disclosed —
// exports NEVER claim completeness when entries were discarded). Follow-tail
// auto-scrolls unless the user scrolls up; jumping back down re-engages it.
// Exports: plain text and Markdown, with timestamps/levels. The header
// context line (app version + active node + revision) is included so an
// export is interpretable later; keys/tokens never appear (they are not
// logged in the first place; the export also redacts common token shapes
// as defense in depth).

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Trash2, FileDown, Copy, ArrowDown } from 'lucide-react';
import type { LogEntry } from '../types';

const RETENTION_LIMIT = 2000;

// Module-level store: survives tab switches and component remounts.
const logStore: LogEntry[] = [];
let droppedCount = 0;
const listeners = new Set<(entries: LogEntry[], dropped: number) => void>();

function pushLog(entry: LogEntry) {
    logStore.push(entry);
    if (logStore.length > RETENTION_LIMIT) {
        const overflow = logStore.length - RETENTION_LIMIT;
        logStore.splice(0, overflow);
        droppedCount += overflow;
    }
    for (const l of listeners) l(logStore.slice(), droppedCount);
}

export function getAppVersion(): string {
    return 'v2.0.0-alpha (build Oct 27 2026)';
}

export function formatLogsMarkdown(entries: LogEntry[], context: string, dropped: number): string {
    const lines: string[] = [
        '# VapourSynth for Resolve — companion session log',
        '',
        `- Exported: ${new Date().toISOString()}`,
        `- Context: ${context}`,
        `- Entries: ${entries.length}${dropped ? ` (plus ${dropped} earlier entries dropped by the ${RETENTION_LIMIT}-entry retention limit — NOT included; this export is incomplete)` : ''}`,
        '',
        '---',
        '',
    ];
    for (const l of entries) {
        lines.push(`**[${l.type}] ${l.timestamp}**`);
        lines.push('');
        lines.push(String(l.message).replace(/```/g, '````'));
        lines.push('');
    }
    return lines.join('\n');
}

export function formatLogsText(entries: LogEntry[], context: string, dropped: number): string {
    const head = [
        `VapourSynth for Resolve — companion session log`,
        `Exported: ${new Date().toISOString()}`,
        `Context: ${context}`,
        `Entries: ${entries.length}${dropped ? ` (plus ${dropped} earlier entries dropped by the ${RETENTION_LIMIT}-entry retention limit — NOT included; this export is incomplete)` : ''}`,
        '',
    ].join('\n');
    return head + entries.map(l => `[${l.timestamp}] [${l.type}] ${l.message}`).join('\n') + '\n';
}

// Defense in depth: redact token-like shapes if one ever reaches a log.
export function redactSecrets(text: string): string {
    return String(text)
        .replace(/\b(sk-[A-Za-z0-9_-]{8,})\b/g, 'sk-…[redacted]')
        .replace(/\b([A-Za-z0-9_-]{20,})@api\b/g, '[redacted]@api');
}

export const LogsPanel: React.FC<{ nodeContext?: string }> = ({ nodeContext = '' }) => {
    const [logs, setLogs] = useState<LogEntry[]>(() => logStore.slice());
    const [dropped, setDropped] = useState(droppedCount);
    const [followTail, setFollowTail] = useState(true);
    const [copied, setCopied] = useState(false);
    const scroller = useRef<HTMLDivElement>(null);

    useEffect(() => {
        // Subscribe to the module store; the buffer persists across unmounts.
        const cleanup = window.electron?.onLog?.((entry) => {
            pushLog({ ...entry, message: redactSecrets(entry.message) });
        });
        const listener = (entries: LogEntry[], d: number) => { setLogs(entries); setDropped(d); };
        listeners.add(listener);
        listener(logStore.slice(), droppedCount);
        return () => { listeners.delete(listener); cleanup?.(); };
    }, []);

    useEffect(() => {
        if (followTail && scroller.current) {
            scroller.current.scrollTop = scroller.current.scrollHeight;
        }
    }, [logs, followTail]);

    const onScroll = useCallback(() => {
        const el = scroller.current;
        if (!el) return;
        const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        setFollowTail(atBottom);
    }, []);

    const context = [getAppVersion(), nodeContext].filter(Boolean).join(' · ');
    const onExport = async (kind: 'md' | 'txt') => {
        const contents = kind === 'md'
            ? formatLogsMarkdown(logs, context, dropped)
            : formatLogsText(logs, context, dropped);
        try {
            const result = await window.electron?.saveTextFile?.({
                defaultName: `vsr-logs-${Date.now()}.${kind}`,
                contents,
            });
            if (result && result.ok === false) {
                window.alert(`Export failed: ${result.error ?? 'unknown error'}`);
            }
        } catch (e) {
            window.alert(`Export failed: ${e instanceof Error ? e.message : String(e)}`);
        }
    };
    const onCopy = async () => {
        try {
            await navigator.clipboard.writeText(formatLogsText(logs, context, dropped));
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1400);
        } catch { /* clipboard permission; selection still works */ }
    };

    return (
        <section style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, background: '#000' }}>
            <header style={{
                display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8,
                padding: '6px 14px', borderBottom: '1px solid #2a1850', background: '#0d0418',
            }}>
                <span style={{ fontSize: 10, opacity: 0.55, textTransform: 'uppercase', letterSpacing: 1.2 }}>
                    Session logs · {logs.length} kept{dropped ? ` · ${dropped} dropped` : ''}
                </span>
                <span role="note" title={`Retention limit ${RETENTION_LIMIT} entries per companion session; oldest dropped. Exports state when entries were dropped.`}
                    style={{ fontSize: 10, opacity: 0.45, textTransform: 'uppercase', letterSpacing: 1 }}>
                    [retention {RETENTION_LIMIT}]
                </span>
                <div style={{ flex: 1 }} />
                {!followTail && (
                    <button type="button" onClick={() => setFollowTail(true)}
                        aria-label="Resume following the newest log entries"
                        style={buttonStyle}>
                        <ArrowDown size={11} aria-hidden="true" /> Follow
                    </button>
                )}
                <button type="button" onClick={() => void onCopy()} disabled={!logs.length}
                    aria-label="Copy log as text to clipboard" style={buttonStyle}>
                    <Copy size={11} aria-hidden="true" /> {copied ? 'Copied' : 'Copy'}
                </button>
                <button type="button" onClick={() => void onExport('md')} disabled={!logs.length}
                    aria-label="Export log to Markdown file" style={buttonStyle}>
                    <FileDown size={11} aria-hidden="true" /> .md
                </button>
                <button type="button" onClick={() => void onExport('txt')} disabled={!logs.length}
                    aria-label="Export log to plain text file" style={buttonStyle}>
                    <FileDown size={11} aria-hidden="true" /> .txt
                </button>
                <button type="button" aria-label="Clear displayed log messages"
                    disabled={!logs.length}
                    onClick={() => { logStore.length = 0; droppedCount = 0;
                        for (const l of listeners) l([], 0); }}
                    style={buttonStyle}>
                    <Trash2 size={11} aria-hidden="true" /> Clear
                </button>
            </header>
            <div ref={scroller} onScroll={onScroll} role="region"
                aria-label="Session log messages" tabIndex={0}
                style={{
                    flex: 1, overflowY: 'auto',
                    fontFamily: 'JetBrains Mono, Menlo, monospace',
                    fontSize: 11, padding: 12, lineHeight: 1.5,
                    whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
                }}>
                {logs.length === 0 ? (
                    <div style={{ opacity: 0.75 }}>No log messages yet this session. The buffer survives tab switches.</div>
                ) : logs.map((l, i) => (
                    <div key={i} style={{ color: levelColor(l.type), marginBottom: 2 }}>
                        <span style={{ opacity: 0.4, marginRight: 8 }}>{l.timestamp}</span>
                        <span style={{ display: 'inline-block', minWidth: 60, opacity: 0.7, marginRight: 8 }}>[{l.type}]</span>
                        <span>{l.message}</span>
                    </div>
                ))}
            </div>
        </section>
    );
};

const buttonStyle: React.CSSProperties = {
    background: 'transparent', border: '1px solid #444', color: '#aaa',
    cursor: 'pointer', padding: '3px 8px', borderRadius: 3, fontSize: 11,
    display: 'flex', alignItems: 'center', gap: 4, minHeight: 28,
};

function levelColor(type: LogEntry['type']): string {
    switch (type) {
        case 'error':   return '#ff5577';
        case 'warn':    return '#ffaa44';
        case 'success': return '#44ff99';
        case 'runtime': return '#aaa';
        case 'info':    return '#f0e6ff';
    }
}