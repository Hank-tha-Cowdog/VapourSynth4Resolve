// Script view — the EFFECTIVE VapourSynth script for the selected node.
//
// Read-only, syntax-highlighted, COPYABLE, organized into the same named
// sections the composer emits (# ════ SOURCE/INPUT/STEP n/OUTPUT ════):
// each section renders as a collapsible header with the section body,
// so long scripts stay navigable (CodeMirror line numbers kept).
//
// Honesty: this is the host-composed script for THIS node (per-GUID .vpy
// preferred), reflecting the LAST ACCEPTED revision — not live drafts.
// The chain maps to STEP sections by construction (the composer names
// them from the same chain state). Unapproved drafts show a divergence
// notice. No editable sync claim. Arbitrary Python in steps is NOT
// sandboxed (the runtime executes it in-process); approval is the
// deliberate gate.
import React, { useCallback, useEffect, useState } from 'react';
import { Copy, Check, FileCode2, ChevronDown } from 'lucide-react';
import { PythonEditor } from './PythonEditor';
import type { NodeConfig } from '../types';
import { isStepApproved } from '../../shared/draft-composer';

type Section = { title: string; kind: 'source' | 'input' | 'step' | 'output' | 'head'; body: string };

export function splitSections(script: string): Section[] {
    const lines = script.split('\n');
    const sections: Section[] = [];
    let current: Section = { title: 'PRELUDE', kind: 'head', body: '' };
    const marker = /^# ═+ (SOURCE|INPUT|OUTPUT) ═+/;
    const stepMarker = /^# ═+ (STEP [0-9]+ \/ [0-9]+ · .*?) ═+/;
    for (const line of lines) {
        const m = stepMarker.exec(line) || marker.exec(line);
        if (m) {
            sections.push(current);
            const kind = m[1].startsWith('SOURCE') ? 'source'
                : m[1].startsWith('INPUT') ? 'input'
                : m[1].startsWith('OUTPUT') ? 'output' : 'step';
            current = { title: m[1], kind, body: line + "\n" };
        } else {
            current.body += line + "\n";
        }
    }
    sections.push(current);
    return sections.filter(s => ((s as unknown as { body: string }).body || '').trim().length > 0);
}

export const ScriptView: React.FC<{ config: NodeConfig }> = ({ config }) => {
    const [script, setScript] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);
    const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

    const load = useCallback(async () => {
        try {
            const text = await window.electron?.readComposedScript?.({ nodeGuid: config.nodeGuid });
            if (typeof text !== 'string') {
                setError('Composed-script read unavailable in this build.');
                return;
            }
            if (!text.trim()) {
                setScript(null);
                setError('No composed script yet — render a frame in Resolve first. '
                    + 'The host writes its exact evaluation script on every render.');
                return;
            }
            setError(null);
            setScript(text);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
    }, [config.nodeGuid]);

    useEffect(() => { void load(); }, [load, config.nodeGuid]);

    const draftCount = config.chain.filter(s => !isStepApproved(s)).length;
    const onCopy = async () => {
        if (!script) return;
        try {
            await navigator.clipboard.writeText(script);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1400);
        } catch { /* clipboard permission; CodeMirror selection still works */ }
    };
    const sections = script ? splitSections(script) : [];
    const toggle = (title: string) => setCollapsed(prev => {
        const next = new Set(prev);
        if (next.has(title)) next.delete(title); else next.add(title);
        return next;
    });

    return (
        <section aria-label="Effective VapourSynth script" style={{
            flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0,
            background: '#0b0512',
        }}>
            <div style={{
                padding: '5px 14px', fontSize: 11, color: '#b9a9d6',
                borderBottom: '1px solid #2a1850', display: 'flex',
                flexWrap: 'wrap', gap: 10, alignItems: 'center', flexShrink: 0,
            }}>
                <FileCode2 size={12} aria-hidden="true" />
                <strong>Effective script</strong>
                <span style={{ opacity: 0.8 }}>exactly what the node evaluates in Resolve (host-composed)</span>
                {draftCount > 0 && (
                    <span role="status" style={{ color: '#f4ce91' }}>
                        {draftCount} unapproved draft{draftCount === 1 ? '' : 's'} in the Chain tab — not in this script until saved &amp; accepted
                    </span>
                )}
                <span style={{ flex: 1 }} />
                <button type="button" onClick={() => void load()} disabled={!script && !error}
                    style={buttonStyle}>Reload</button>
                <button type="button" onClick={() => void onCopy()} disabled={!script}
                    aria-label="Copy the full script (including section headers) to the clipboard" style={buttonStyle}>
                    {copied ? <><Check size={11} aria-hidden="true" /> Copied</> : <><Copy size={11} aria-hidden="true" /> Copy</>}
                </button>
            </div>
            <div role="note" style={{
                padding: '3px 14px', fontSize: 10.5, color: '#8e7cb8', lineHeight: 1.5,
                borderBottom: '1px solid #1a1030', flexShrink: 0,
            }}>
                Sections map to the chain: SOURCE (identified media) → INPUT (auto conversion) → each STEP (one
                ordered chain card) → OUTPUT (transform + timeline fit). Collapsing is view-only; Copy always
                includes the full script. Arbitrary step Python runs <strong>unsandboxed</strong> in the node —
                approval is the deliberate gate.
            </div>
            {error && <div role="alert" style={{
                padding: '10px 14px', color: '#ffc1ce', fontSize: 12, lineHeight: 1.5,
            }}>{error}</div>}
            {script && (
                <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 8 }}>
                    {sections.map((s, i) => {
                        const body = s.body;
                        const isCollapsed = collapsed.has(s.title);
                        const color = s.kind === 'source' ? '#7dffbb'
                            : s.kind === 'input' || s.kind === 'output' ? '#c4a8ff' : '#f0e6ff';
                        return (
                            <div key={i} style={{ marginBottom: 8, border: '1px solid #241440', borderRadius: 6, overflow: 'hidden' }}>
                                <button type="button" onClick={() => toggle(s.title)}
                                    aria-expanded={!isCollapsed}
                                    aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} section: ${s.title}`}
                                    style={{
                                        display: 'flex', width: '100%', alignItems: 'center', gap: 6,
                                        background: '#130a24', border: 'none', color,
                                        padding: '6px 10px', cursor: 'pointer',
                                        fontSize: 11, fontWeight: 600, textAlign: 'left',
                                    }}>
                                    <ChevronDown size={11} aria-hidden="true" style={{
                                        transform: isCollapsed ? 'rotate(-90deg)' : undefined }} />
                                    {s.title}
                                </button>
                                {!isCollapsed && (
                                    <div style={{ height: Math.min(360, Math.max(80, body.split('\n').length * 16)),
                                        borderTop: '1px solid #241440' }}>
                                        <PythonEditor value={body} readOnly onChange={() => {}} />
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
        </section>
    );
};

const buttonStyle: React.CSSProperties = {
    padding: '3px 9px', background: '#160a24', border: '1px solid #3a2456',
    color: '#f0e6ff', borderRadius: 4, cursor: 'pointer', fontSize: 11, minHeight: 28,
    display: 'inline-flex', alignItems: 'center', gap: 5,
};