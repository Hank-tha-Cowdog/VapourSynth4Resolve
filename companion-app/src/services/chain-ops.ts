// Apply a sequence of ChainOperations to a chain. Pure function so tests + the
// Skippy's auto-apply path use the same logic.
//
// APPROVAL BINDS CONTENT (security re-review, 2026-11-05): tool input can
// never grant approval or carry a binding. Added steps enter
// approved=false with no approvedContent; updates that change executable
// content clear both. Only an explicit user Approve click in the destination
// editor sets the flag AND the binding (see ChainEditor update()).

import type { ChainOperation, ChainStep } from '../types';

export function applyOperations(chain: ChainStep[], operations: ChainOperation[]): ChainStep[] {
    let next = chain;
    for (const op of operations) {
        if (op.op === 'add') {
            // These operations come from chatbot/MCP proposals, not the
            // library's explicit user-add/Approve controls.
            next = [...next, { ...op.step, approved: false, approvedContent: null }];
        } else if (op.op === 'update') {
            next = next.map(s => {
                if (s.id !== op.targetId) return s;
                const merged: ChainStep = { ...s, ...op.patch };
                // Merge params shallowly so a partial param update doesn't drop other params.
                if (op.patch.params) {
                    merged.params = { ...s.params, ...op.patch.params };
                }
                // Approval belongs to the reviewed executable inputs. A model
                // updating an approved (including legacy) step must not inherit
                // permission to run replacement code or changed parameters.
                const executableChanged = merged.type !== s.type
                    || merged.stage !== s.stage
                    || merged.enabled !== s.enabled
                    || Object.entries(op.patch.params ?? {}).some(
                        ([key, value]) => key !== 'label' && value !== s.params[key]
                    );
                // Tool input cannot grant approval or supply a binding, even
                // for an unchanged draft.
                merged.approved = executableChanged || s.approved === false || op.patch.approved === false
                    ? false
                    : s.approved;
                merged.approvedContent = executableChanged ? null : s.approvedContent;
                return merged;
            });
        } else if (op.op === 'remove') {
            next = next.filter(s => s.id !== op.targetId);
        }
    }
    return next;
}

// Short human-readable summary of an op list for the Confirm card header.
export function summarizeOperations(operations: ChainOperation[]): string {
    const counts = { add: 0, update: 0, remove: 0 };
    for (const op of operations) counts[op.op]++;
    const parts: string[] = [];
    if (counts.add)    parts.push(`+${counts.add} add`);
    if (counts.update) parts.push(`~${counts.update} update`);
    if (counts.remove) parts.push(`-${counts.remove} remove`);
    return parts.join(' · ') || 'no-op';
}
