// Schema-driven parameter panel for named supported filters.
//
// One FilterSchema (shared/filter-schemas.ts) drives the controls,
// validation, tooltips and the step's generated code. Structured edits
// REGENERATE the code via schema.emit — the generated form is exactly the
// qualified template, so the panel cannot drift from what the
// qualification harness verified. If the step's code was hand-edited beyond
// the schema form, the panel shows a CUSTOM badge, the script editor stays
// available below, and the panel never silently overwrites the user's
// script — code is the truth; the schema panel is a structured editing
// convenience.
//
// Advanced params collapse behind a disclosure. Every control has a
// keyboard-focusable label and a tooltip (title + aria-describedby) that
// explains what/how/when — never just the parameter name.
import React, { useMemo, useState } from 'react';
import { RotateCcw, ChevronDown, Wrench } from 'lucide-react';
import { FILTER_SCHEMAS, stepMatchesSchema, schemaDefaults, type FilterSchema, type ParamDef } from '../../shared/filter-schemas';

export interface FilterParamsPanelProps {
    filterType: string;
    params: Record<string, unknown>;
    code: string;                       // current step code (truth)
    onChange: (params: Record<string, unknown>) => void;
}

const SCHEMA_COMMENT = (schema: FilterSchema) => `# ${schema.label}: ${schema.purpose}\n`;

export const FilterParamsPanel: React.FC<FilterParamsPanelProps> = ({ filterType, params, code, onChange }) => {
    const schema = FILTER_SCHEMAS[filterType];
    const [showAdvanced, setShowAdvanced] = useState(false);
    const [focused, setFocused] = useState<string | null>(null);
    const isCustom = useMemo(() => schema && !stepMatchesSchema(schema, params, code), [schema, params, code]);

    if (!schema) return null;   // not a schema-driven filter

    const basic = schema.params.filter(p => !p.advanced);
    const advanced = schema.params.filter(p => p.advanced);
    const setParam = (key: string, value: unknown) => {
        // C07 (2026-11-11): every structured edit operates on a COMPLETE
        // param set — schema defaults beneath the stored params. A sparse
        // stored step (freshly added, after individual resets, or legacy)
        // previously reached the strict emitter without required keys and
        // THREW here, before onChange could save anything.
        const next = { ...schemaDefaults(filterType), ...params, [key]: value };
        const generated = SCHEMA_COMMENT(schema) + schema.emit(next);
        onChange({ ...next, code: generated });
    };

    const renderControl = (p: ParamDef) => {
        const value = params[p.key] ?? p.default;
        const id = `param-${filterType}-${p.key}`;
        const helpId = `${id}-help`;
        return (
            <div key={p.key} style={{ marginBottom: 8, display: 'flex', flexDirection: 'column', gap: 3 }}>
                <label htmlFor={id} style={{ fontSize: 11, fontWeight: 600, color: '#e3d4f0' }}>
                    {p.label}
                    {p.unit ? <span style={{ opacity: 0.5, fontWeight: 400 }}> ({p.unit})</span> : null}
                </label>
                {p.kind === 'enum' && (
                    <select id={id} value={String(value)} onChange={(e) => {
                        const raw = e.target.value;
                        const asNum = Number(raw);
                        setParam(p.key, p.options && typeof p.options[0] === 'number' && Number.isFinite(asNum) ? asNum : raw);
                    }}
                        aria-describedby={focused === p.key ? helpId : undefined}
                        onFocus={() => setFocused(p.key)} onBlur={() => setFocused(null)}
                        style={controlStyle}>
                        {(p.options ?? []).map((o) => <option key={String(o)} value={String(o)}>{String(o)}</option>)}
                    </select>
                )}
                {p.kind === 'bool' && (
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                        <input id={id} type="checkbox" checked={Boolean(value)}
                            onChange={(e) => setParam(p.key, e.target.checked)}
                            aria-describedby={focused === p.key ? helpId : undefined}
                            onFocus={() => setFocused(p.key)} onBlur={() => setFocused(null)}
                            style={{ accentColor: '#ff2bd6' }} />
                        <span style={{ color: Boolean(value) ? '#9be5a0' : '#c4a8ff' }}>{Boolean(value) ? 'Yes' : 'No'}</span>
                    </label>
                )}
                {p.kind === 'range' && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <input id={id} type="range" min={p.min} max={p.max} step={p.step ?? 0.1}
                            value={Number(value)} onChange={(e) => setParam(p.key, Number(e.target.value))}
                            aria-describedby={focused === p.key ? helpId : undefined}
                            onFocus={() => setFocused(p.key)} onBlur={() => setFocused(null)}
                            style={{ flex: 1, accentColor: '#ff2bd6' }} />
                        <span style={{ minWidth: 32, textAlign: 'right', fontSize: 11, fontVariantNumeric: 'tabular-nums' }}>
                            {String(value)}
                        </span>
                    </div>
                )}
                {p.kind === 'number' && (
                    <input id={id} type="number" min={p.min} max={p.max} step={p.step ?? 1}
                        value={Number(value)} onChange={(e) => {
                            const v = Number(e.target.value);
                            setParam(p.key, Number.isFinite(v) ? v : (p.default as number));
                        }}
                        aria-describedby={focused === p.key ? helpId : undefined}
                        onFocus={() => setFocused(p.key)} onBlur={() => setFocused(null)}
                        style={controlStyle} />
                )}
                <button type="button" onClick={() => setParam(p.key, p.default)}
                    aria-label={`Reset ${p.label} to its default`}
                    title={p.help}
                    style={{ background: 'none', border: 'none', color: '#8e7cb8', cursor: 'pointer',
                        padding: 0, fontSize: 10, display: 'inline-flex', alignItems: 'center', gap: 3, width: 'max-content' }}>
                    <RotateCcw size={9} aria-hidden="true" /> reset
                </button>
                {focused === p.key && (
                    <div id={helpId} role="note" style={{
                        fontSize: 10.5, color: '#b9a9d6', background: '#160a24',
                        border: '1px solid #3a2456', borderRadius: 4, padding: '4px 8px', lineHeight: 1.4,
                    }}>
                        {p.help}
                    </div>
                )}
            </div>
        );
    };

    return (
        <div aria-label={`${schema.label} parameters`} style={{ fontSize: 12 }}>
            <div style={{ fontSize: 10.5, color: '#8e7cb8', marginBottom: 6 }}>
                {schema.purpose}
                {schema.inputRequirements ? ` Input: ${schema.inputRequirements}` : ''}
            </div>
            {isCustom && (
                <div role="note" style={{
                    display: 'flex', gap: 6, alignItems: 'center', marginBottom: 8, padding: '4px 8px',
                    background: 'rgba(130, 98, 46, 0.15)', border: '1px solid rgba(244, 206, 145, 0.4)',
                    borderRadius: 4, color: '#f4ce91', fontSize: 10.5,
                }}>
                    <Wrench size={10} aria-hidden="true" />
                    CUSTOM — this step's script was hand-edited beyond the structured form. The script
                    below is the truth; structured edits here would regenerate the template form.
                    Edit the script directly, or reset to the template form deliberately.
                </div>
            )}
            {basic.map(renderControl)}
            {advanced.length > 0 && (
                <details onToggle={undefined} style={{ marginTop: 4 }}>
                    <summary style={{ cursor: 'pointer', fontSize: 10.5, color: '#a08ec4',
                        listStyle: 'none', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <ChevronDown size={10} aria-hidden="true" /> Advanced ({advanced.length})
                    </summary>
                    <div style={{ marginTop: 6 }}>{advanced.map(renderControl)}</div>
                </details>
            )}
        </div>
    );
};

const controlStyle: React.CSSProperties = {
    background: '#160a24', border: '1px solid #3a2456', color: '#f0e6ff',
    borderRadius: 4, padding: '3px 6px', fontSize: 11,
};