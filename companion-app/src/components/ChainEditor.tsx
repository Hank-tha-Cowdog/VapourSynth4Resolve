// Chain Editor — the ordered list of filter steps with stage dividers.
//
// Renders steps sorted by stage (unless manualOrder is on), with stage-group headers
// between transitions. Each step is a card with: enable toggle (eye), filter label,
// stage badge, expand-to-edit, delete.
//
// Accordion behavior: at most one step is expanded at a time. The expanded card
// flex-fills the remaining chain area so its editor takes every available pixel
// (no viewport-relative math; the editor lives inside a flex chain that resolves
// to exact pixels).
//
// Drag-reorder is Phase 2 — @dnd-kit lands when we have more than one filter type
// to actually reorder within a stage. For now the chain is mutated by Add / Remove /
// Enable / disable only.

import React, { useRef, useState } from 'react';
import { Eye, EyeOff, Trash2, ChevronDown, ChevronRight } from 'lucide-react';
import { STAGE_LABELS } from '../constants';
import type { ChainStep, ClipMetadata, FilterStage } from '../types';
import { StageNumber, stageLabelForNumber } from '../types';
import { PythonEditor } from './PythonEditor';
import { QTGMCPanel } from '../filter-panels/QTGMCPanel';
import { FilterParamsPanel } from './FilterParamsPanel';
import { FILTER_SCHEMAS } from '../../shared/filter-schemas';
import { executableTextForStep, isStepApproved } from '../../shared/draft-composer';
import { reconcileChainExpansion } from '../services/chain-expansion';

interface Props {
    chain: ChainStep[];
    manualOrder: boolean;
    setManualOrder: (b: boolean) => void;
    onChange: (chain: ChainStep[]) => void;
    /** Threaded down to native filter panels (QTGMC shows the probe's
     *  field-order verdict as a hint next to the TFF/BFF selector). */
    clipMetadata?: ClipMetadata | null;
}

// Display name for a step on the card row. The Archivist is expected to set
// `step.params.label` to a meaningful name (e.g. "QTGMC — Archival
// Deinterlace") when it inserts new steps; if that's missing we fall back
// to the raw filter type. A `script`-type step with no label reads as just
// "script" which tells the colorist nothing — so for script steps we also
// peek at `step.params.title` and `step.params.name` as additional fallbacks
// the Archivist sometimes uses.
function stepDisplayName(step: ChainStep): string {
    const p = step.params as Record<string, unknown> | undefined;
    const candidates = [p?.label, p?.title, p?.name];
    for (const c of candidates) {
        if (typeof c === 'string' && c.trim().length > 0) return c.trim();
    }
    return step.type;
}

// Does a params edit change the step's EXECUTABLE content? `label` is
// cosmetic (section comment only) — every other key can alter emitted
// Python, so any change to it invalidates approval (see update()).
function paramsExecutableChanged(step: ChainStep, nextParams: Record<string, unknown>): boolean {
    const prev = step.params ?? {};
    const keys = new Set([...Object.keys(prev), ...Object.keys(nextParams)]);
    for (const key of keys) {
        if (key === 'label') continue;
        if (JSON.stringify(prev[key]) !== JSON.stringify(nextParams[key])) return true;
    }
    return false;
}

export const ChainEditor: React.FC<Props> = ({ chain, manualOrder, onChange, clipMetadata }) => {
    // Multi-expand accordion — every step starts open so the user sees the full
    // chain at a glance. Click the header to collapse an individual step. New
    // steps added by the Archivist auto-expand (they're added to the set in
    // the useEffect below).
    const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set(chain.map(s => s.id)));
    const knownIds = useRef<ReadonlySet<string>>(new Set(chain.map(s => s.id)));

    // Whenever a new step appears in `chain` that we haven't seen before,
    // auto-expand it (matches the "Archivist drops a script → user sees it
    // immediately" UX). Existing collapsed steps stay collapsed.
    React.useEffect(() => {
        const currentIds = chain.map(step => step.id);
        const previouslyKnown = knownIds.current;
        knownIds.current = new Set(currentIds);
        setExpandedIds(prev => reconcileChainExpansion(prev, previouslyKnown, currentIds));
    }, [chain]);

    const sorted = manualOrder
        ? chain
        : [...chain].sort((a, b) => a.stage - b.stage);

    const update = (id: string, patch: Partial<ChainStep>) => {
        onChange(chain.map(s => {
            if (s.id !== id) return s;
            const next: ChainStep = { ...s, ...patch };
            // SECURITY (security re-review, 2026-11-05; content binding
            // 2026-11-11): APPROVAL BINDS THE EXECUTABLE CONTENT — for every
            // executable step type. A script edit changes the code; a QTGMC
            // preset/option edit changes the generated Python. Either one
            // invalidates BOTH the flag and the stored content binding; the
            // user re-approves the new content explicitly. Label-only edits
            // are cosmetic (section comment only) and keep the approval. An
            // Approve click binds the CURRENT executable body (or refuses to
            // approve when the body cannot be computed).
            const executableChanged =
                (patch.type !== undefined && patch.type !== s.type) ||
                (patch.version !== undefined && patch.version !== s.version) ||
                (patch.params !== undefined && paramsExecutableChanged(s, patch.params));
            if (executableChanged) {
                next.approved = false;
                next.approvedContent = null;
            } else if (patch.approved === true) {
                const content = executableTextForStep(next);
                if (content !== null) {
                    next.approvedContent = content;
                } else {
                    next.approved = false;
                    next.approvedContent = null;
                }
            } else if (patch.approved === false) {
                next.approvedContent = null;
            }
            return next;
        }));
    };
    const remove = (id: string) => {
        setExpandedIds(prev => {
            const next = new Set(prev);
            next.delete(id);
            return next;
        });
        onChange(chain.filter(s => s.id !== id));
    };
    const toggleExpand = (id: string) => {
        setExpandedIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    };

    // Group consecutive steps with the same stage into a single visual block.
    const grouped: { stage: FilterStage; steps: ChainStep[] }[] = [];
    let cursor = -1;
    for (const step of sorted) {
        const stageKey = stageNumberToKey(step.stage);
        if (grouped.length === 0 || step.stage !== cursor) {
            grouped.push({ stage: stageKey, steps: [step] });
            cursor = step.stage;
        } else {
            grouped[grouped.length - 1].steps.push(step);
        }
    }

    // 1-indexed ordinal position for each step in the chain. We surface this
    // as "Step N · <filter>" on the card so the colorist reads the chain like
    // a numbered list rather than a soup of stage-labelled boxes. The number
    // counts ALL steps (enabled or not, approved or not) so that disabling a
    // step doesn't renumber the others mid-edit.
    const stepNumberById = new Map<string, number>();
    sorted.forEach((s, i) => stepNumberById.set(s.id, i + 1));

    return (
        <section style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            background: '#0d0418',
            overflow: 'hidden',
        }}>
            <div style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                minHeight: 0,
                overflowY: 'auto',
                padding: 8,
                gap: 0,
            }}>
                {chain.length === 0 ? (
                    <div style={{
                        opacity: 0.4, fontSize: 13,
                        textAlign: 'center', marginTop: 40,
                    }}>
                        Empty chain.<br />
                        Click a filter in the library to add it.
                    </div>
                ) : (
                    grouped.map((group, gi) => {
                        return (
                            <div key={gi} style={{
                                display: 'flex',
                                flexDirection: 'column',
                                // NATURAL HEIGHT throughout: one coherent outer
                                // scroll. The previous flex:1 sizing on groups with
                                // an expanded card constrained every card to the
                                // visible viewport, which made cards overlap and
                                // pushed scrolling into nested per-panel areas.
                                flexShrink: 0,
                            }}>
                                {/* Skip divider for the first group — its label is redundant
                                    with the "stage N" badge in the step card. Render dividers
                                    only at transitions between stages. */}
                                {gi > 0 && <StageDivider stage={group.stage} />}
                                {group.steps.map(step => (
                                    <StepCard
                                        key={step.id}
                                        step={step}
                                        stepNumber={stepNumberById.get(step.id) ?? 0}
                                        isExpanded={expandedIds.has(step.id)}
                                        clipMetadata={clipMetadata}
                                        onToggleExpand={() => toggleExpand(step.id)}
                                        onToggle={() => update(step.id, { enabled: !step.enabled })}
                                        onApprove={() => update(step.id, { approved: true })}
                                        onRemove={() => remove(step.id)}
                                        onParamsChange={(params) => update(step.id, { params })}
                                    />
                                ))}
                            </div>
                        );
                    })
                )}
            </div>
        </section>
    );
};

// Standalone Manual-Order toggle, lifted out of the (now-removed) Chain Editor header
// so App.tsx can mount it on the right edge of the CenterTabs strip.
export const ManualOrderToggle: React.FC<{
    value: boolean;
    onChange: (v: boolean) => void;
}> = ({ value, onChange }) => (
    <label style={{
        fontSize: 11, opacity: 0.7,
        display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer',
    }}>
        <input
            type="checkbox"
            checked={value}
            onChange={(e) => onChange(e.target.checked)}
            style={{ accentColor: '#ff2bd6' }}
        />
        Manual Order
    </label>
);

const StageDivider: React.FC<{ stage: FilterStage }> = ({ stage }) => (
    <div style={{
        margin: '8px 0 6px',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexShrink: 0,
    }}>
        <div style={{
            flex: 1, height: 1,
            background: 'linear-gradient(90deg, transparent, rgba(255, 43, 214, 0.4), transparent)',
        }} />
        <span style={{
            fontSize: 9, opacity: 0.7,
            textTransform: 'uppercase', letterSpacing: 1.5,
            color: '#ff2bd6',
            textShadow: '0 0 6px rgba(255, 43, 214, 0.5)',
        }}>
            — {STAGE_LABELS[stage]} —
        </span>
        <div style={{
            flex: 1, height: 1,
            background: 'linear-gradient(90deg, transparent, rgba(255, 43, 214, 0.4), transparent)',
        }} />
    </div>
);

const StepCard: React.FC<{
    step: ChainStep;
    stepNumber: number;
    isExpanded: boolean;
    clipMetadata?: ClipMetadata | null;
    onToggleExpand: () => void;
    onToggle: () => void;
    onApprove: () => void;
    onRemove: () => void;
    onParamsChange: (params: Record<string, unknown>) => void;
}> = ({ step, stepNumber, isExpanded, clipMetadata, onToggleExpand, onToggle, onApprove, onRemove, onParamsChange }) => {
    // Content-bound approval: approved===true AND approvedContent matches the
    // CURRENT executable body (see shared/draft-composer isStepApproved).
    // A stale flag on edited content shows as a draft — matching what the
    // composers will actually do.
    const isApproved = isStepApproved(step);
    const stepLabel = `Step ${stepNumber}: ${stepDisplayName(step)}`;
    return (
        <div role="group" aria-label={stepLabel} style={{
            marginBottom: 8,
            background: '#1a0830',
            // Amber outline on unapproved drafts so the user sees the work
            // hasn't gone live yet; green outline on approved + enabled steps
            // that the composer will emit code for.
            border: !isApproved
                ? '1px solid rgba(255, 170, 68, 0.6)'
                : (step.enabled ? '1px solid rgba(68, 255, 153, 0.35)' : '1px solid #2a1850'),
            borderRadius: 6,
            opacity: step.enabled ? 1 : 0.85,
            display: 'flex',
            flexDirection: 'column',
            // Natural height: expanded cards grow to their content and the
            // outer chain scroll carries the page (no flex:1 viewport squeeze
            // → no overlapping cards, no trapped nested scroll).
            flexShrink: 0,
        }}>
            <div style={{
                display: 'flex',
                alignItems: 'center',
                flexWrap: 'wrap',
                padding: '8px 10px',
                gap: 8,
                flexShrink: 0,
            }}>
                <button
                    type="button"
                    aria-label={`Enable ${stepLabel}`}
                    aria-pressed={step.enabled}
                    onClick={onToggle}
                    style={{
                        background: 'none', border: 'none',
                        color: step.enabled ? '#ff2bd6' : '#c4a8ff',
                        cursor: 'pointer', padding: 0,
                        minHeight: 44, minWidth: 44,
                    }}
                    title={step.enabled ? 'Disable step' : 'Enable step'}
                >
                    {step.enabled ? <Eye size={14} aria-hidden="true" /> : <EyeOff size={14} aria-hidden="true" />}
                </button>
                <button
                    type="button"
                    onClick={onToggleExpand}
                    aria-expanded={isExpanded}
                    style={{
                        flex: 1, display: 'flex', alignItems: 'center', gap: 6,
                        background: 'none', border: 'none', color: '#f0e6ff',
                        cursor: 'pointer', padding: 0, textAlign: 'left', fontSize: 13,
                        minHeight: 44, minWidth: 120,
                    }}
                >
                    {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    {/* "Step N · <name>" — the ordinal leads, then the user-meaningful
                        name. Prefer `step.params.label` (the Archivist sets this to
                        e.g. "QTGMC — Archival Deinterlace") and fall back to the raw
                        filter type. We DO NOT show the stage chip on the row — it
                        was adding "FIELD OPS" / "RESTORE" noise that read as the step
                        name, confusing colorists who just want a numbered recipe.
                        The stage info is still in the title tooltip and as a subtle
                        type-line below when expanded. */}
                    <span style={{
                        fontSize: 11, opacity: 0.6, fontWeight: 500,
                        fontFamily: 'JetBrains Mono, Menlo, monospace',
                        letterSpacing: 0.3,
                    }}>
                        Step&nbsp;{stepNumber}
                    </span>
                    <span style={{ opacity: 0.3, fontSize: 11 }}>·</span>
                    <code
                        style={{ fontWeight: 600, overflowWrap: 'anywhere' }}
                        title={`type: ${step.type}  ·  stage: ${stageLabelForNumber(step.stage)} (${step.stage} of 90)`}
                    >
                        {stepDisplayName(step)}
                    </code>
                    {!isApproved && (
                        <span style={{
                            fontSize: 10, fontWeight: 600,
                            padding: '1px 6px', background: 'rgba(255, 170, 68, 0.15)',
                            border: '1px solid rgba(255, 170, 68, 0.4)',
                            color: '#ffaa44', borderRadius: 3,
                        }}>
                            DRAFT
                        </span>
                    )}
                    {!step.enabled && (
                        <span style={{ fontSize: 10, color: '#c4a8ff' }}>DISABLED</span>
                    )}
                </button>
                {!isApproved && (
                    <button
                        type="button"
                        aria-label={`Approve ${stepLabel}`}
                        onClick={onApprove}
                        title="Approve this step for inclusion when enabled."
                        style={{
                            background: 'linear-gradient(135deg, #44ff99 0%, #2bff7e 100%)',
                            border: 'none', color: '#0a2014',
                            borderRadius: 4, fontSize: 11, fontWeight: 700,
                            padding: '4px 12px',
                            cursor: 'pointer',
                            minHeight: 44,
                            letterSpacing: 0.4,
                            textTransform: 'uppercase',
                            boxShadow: '0 0 8px rgba(68, 255, 153, 0.4)',
                        }}
                    >
                        Approve
                    </button>
                )}
                <button
                    type="button"
                    aria-label={`Remove ${stepLabel}`}
                    onClick={onRemove}
                    style={{ background: 'none', border: 'none', color: '#aaa', cursor: 'pointer', minHeight: 44, minWidth: 44 }}
                    title="Remove step"
                >
                    <Trash2 size={13} aria-hidden="true" />
                </button>
            </div>

            {isExpanded && (
                <div style={{
                    // Generous natural height for the script editor: long
                    // scripts scroll INSIDE CodeMirror (code-editor UX), but
                    // the card itself is natural-height so the outer chain
                    // scroll stays coherent. Typed panels (QTGMC) are natural
                    // height with no nested scroll at all.
                    minHeight: step.type === 'script' ? 320 : undefined,
                    height: step.type === 'script' ? 320 : 'auto',
                    display: 'flex',
                    flexDirection: 'column',
                    padding: step.type === 'script' ? 4 : 10,
                    borderTop: '1px solid #2a1850',
                    background: '#0d0418',
                }}>
                    <StepEditor step={step} clipMetadata={clipMetadata} onChange={onParamsChange} />
                </div>
            )}
        </div>
    );
};

const StepEditor: React.FC<{
    step: ChainStep;
    clipMetadata?: ClipMetadata | null;
    onChange: (params: Record<string, unknown>) => void;
}> = ({ step, clipMetadata, onChange }) => {
    // Typed native filter → dedicated panel (QTGMC keeps its typed panel).
    if (step.type === 'qtgmc') {
        return (
            <QTGMCPanel
                params={step.params}
                clipMetadata={clipMetadata}
                onChange={onChange}
            />
        );
    }
    // Script steps: freeform CodeMirror is the truth and stays available. If
    // a SCHEMA exists for this filter's type family (the FilterLibrary's
    // named filters carry a `schemaType` param binding them to a schema),
    // the schema panel renders structured controls that REGENERATE the code;
    // custom-edited code keeps the script editor as the expert option.
    if (step.type === 'script') {
        const code = typeof step.params.code === 'string' ? step.params.code : '';
        const schemaType = typeof step.params.schemaType === 'string' ? step.params.schemaType : null;
        const hasSchema = schemaType != null && FILTER_SCHEMAS[schemaType] != null;
        return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {hasSchema && (
                    <FilterParamsPanel
                        filterType={schemaType as string}
                        params={step.params}
                        code={code}
                        onChange={onChange}
                    />
                )}
                <div style={{ borderTop: hasSchema ? '1px solid #2a1850' : 'none', paddingTop: hasSchema ? 6 : 0 }}>
                    <PythonEditor
                        value={code}
                        onChange={(next) => onChange({ ...step.params, code: next })}
                    />
                </div>
            </div>
        );
    }
    return (
        <div style={{ fontSize: 12, opacity: 0.6 }}>
            Editor for <code>{step.type}</code> not yet implemented.
        </div>
    );
};

function stageNumberToKey(n: number): FilterStage {
    for (const [k, v] of Object.entries(StageNumber)) {
        if (v === n) return k as FilterStage;
    }
    return 'preprocess';
}
