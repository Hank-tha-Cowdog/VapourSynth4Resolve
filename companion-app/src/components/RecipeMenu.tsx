// Recipe menu — portable, identity-free chain recipes.
//
// A recipe is the deliberate processing choice: filter order, params, bypass
// states, color management, mix. It NEVER contains source paths, node
// identity (GUID), chat history, credentials or render caches — the
// main-process store strips and refuses those keys. Applying a recipe
// replaces THIS node's chain and color/mix settings while keeping the
// node's own source binding and identity (detected afresh by discovery —
// the recipe's original source is never imported). Recipes are independent
// copies: editing this node afterwards never touches the saved recipe or
// any other node.
//
// CONTROLLED POPOVER (live feedback: the old <details> stayed open after
// Apply because its open state was never wired to the element). Behavior:
//   • open/close is React-controlled (open={open}); summary click toggles,
//     Apply closes, Escape closes, outside-click closes — and an
//     outside click never lands in a popup element behind the trigger.
//   • focus returns to the summary when closed.
//   • an UNFINISHED name draft is PRESERVED on dismissal (never
//     silently discarded) and restored when reopened.
//   • search + bounded scrollable picker for 50–100 recipes: filter by
//     substring (name), case-insensitive, sorted by recency-independent
//     name order, capped-height scroll region so the popup never outgrows
//     the viewport; empty and error states are explicit; delete/export
//     are secondary actions per entry.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BookMarked, Save, Upload, Download, Trash2, Search } from 'lucide-react';

interface RecipeSummary { name: string; slug: string; stepCount: number }

export const RecipeMenu: React.FC<{
    onApply: (recipe: { chain: unknown[]; colorManagement?: unknown; mix?: number; manualOrder?: boolean; name: string }) => void;
    onSaveCurrent: (name: string) => Promise<string | null>;
}> = ({ onApply, onSaveCurrent }) => {
    const [open, setOpen] = useState(false);
    const [recipes, setRecipes] = useState<RecipeSummary[]>([]);
    const [note, setNote] = useState<string | null>(null);
    // Save-form state. window.prompt is NOT implemented in Electron (returns
    // undefined) — an inline form collects the name. The draft SURVIVES
    // dismissal: canceling or outside-click keeps nameDraft; only a
    // successful save clears it.
    const [saving, setSaving] = useState(false);
    const [nameDraft, setNameDraft] = useState('');
    const [query, setQuery] = useState('');
    const summaryRef = useRef<HTMLElement | null>(null);
    const popRef = useRef<HTMLDivElement | null>(null);
    const closeTimerRef = useRef<number | null>(null);

    const reload = useCallback(async () => {
        const r = await window.electron?.listRecipes?.();
        if (r?.ok) setRecipes(r.recipes ?? []);
    }, []);
    useEffect(() => { void reload(); }, [reload]);

    const close = useCallback((returnFocus = true) => {
        setOpen(false);
        setSaving(false);       // keep nameDraft on purpose — an unfinished draft is never lost
        if (returnFocus && summaryRef.current) {
            if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
            closeTimerRef.current = window.setTimeout(() => summaryRef.current?.focus(), 0);
        }
    }, []);

    // Escape + outside click (only if the click is not on the trigger itself,
    // which toggles natively). Focus-return handled by close().
    useEffect(() => {
        if (!open) return;
        const onDocPointerDown = (e: PointerEvent) => {
            const root = popRef.current;
            const summary = summaryRef.current;
            if (summary && summary.contains(e.target as Node)) return;   // summary click toggles
            if (root && root.contains(e.target as Node)) return;          // inside the popover
            close(false);
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && !e.defaultPrevented) close();
        };
        document.addEventListener('pointerdown', onDocPointerDown, true);
        document.addEventListener('keydown', onKey, true);
        return () => {
            document.removeEventListener('pointerdown', onDocPointerDown, true);
            document.removeEventListener('keydown', onKey, true);
        };
    }, [open, close]);
    useEffect(() => () => { if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current); }, []);

    const shown = useMemo(() => {
        const q = query.trim().toLowerCase();
        const list = q
            ? recipes.filter(r => r.name.toLowerCase().includes(q) || r.slug.toLowerCase().includes(q))
            : recipes;
        return [...list].sort((a, b) => a.name.localeCompare(b.name));
    }, [recipes, query]);

    const onSave = async () => {
        const name = nameDraft.trim();
        if (!name) return;
        const note = await onSaveCurrent(name);
        if (note) { setNote(note); setNameDraft(''); setSaving(false); void reload(); }
    };

    const onApplySlug = async (slug: string) => {
        const r = await window.electron?.loadRecipe?.({ slug });
        if (!r?.ok || !r.recipe) { setNote(r?.error ?? 'recipe load failed'); return; }
        onApply(r.recipe);
        setNote(`Applied "${r.recipe.name}" (${r.recipe.chain.length} steps). The node's source binding and identity are unchanged.`);
        close();
    };

    const onDelete = async (slug: string) => {
        const r = await window.electron?.deleteRecipe?.({ slug });
        if (r?.ok) { setNote('Recipe deleted.'); void reload(); }
        else setNote(r?.error ?? 'delete failed');
    };

    const onExport = async (slug: string) => {
        const r = await window.electron?.loadRecipe?.({ slug });
        if (!r?.ok || !r.recipe) { setNote(r?.error ?? 'recipe load failed'); return; }
        const out = await window.electron?.saveTextFile?.({
            defaultName: `vsr-recipe-${slug}.json`,
            contents: JSON.stringify(r.recipe, null, 2),
        });
        if (out && out.ok === false) setNote(out.error ?? 'export failed');
        else if (out?.ok) setNote('Recipe exported.');
    };

    const onImport = async () => {
        const picked = await window.electron?.openTextFile?.();
        if (!picked || picked.ok === false || picked.canceled) {
            if (picked?.error) setNote(picked.error);
            return;
        }
        try {
            const payload = JSON.parse(picked.contents ?? '');
            const r = await window.electron?.saveRecipe?.({ payload, fallbackName: 'imported recipe' });
            if (!r?.ok || !r.recipe) { setNote(r?.error ?? 'import failed'); return; }
            setNote(`Imported "${r.recipe.name}".`);
            void reload();
        } catch (e) {
            setNote(`import failed: not valid JSON (${e instanceof Error ? e.message : String(e)})`);
        }
    };

    return (
        <div style={{ position: 'relative', fontSize: 11, flexShrink: 0 }}>
            <button type="button" ref={summaryRef as React.RefObject<HTMLButtonElement>}
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label="Recipe menu — save, apply, export or import portable chain recipes"
                onClick={() => setOpen(v => !v)}
                style={{
                    display: 'inline-flex', alignItems: 'center', gap: 5,
                    minHeight: 26, padding: '0 9px', cursor: 'pointer',
                    border: '1px solid #3a2456', borderRadius: 11, background: '#160a24', color: '#e3d4f0',
                }}>
                <BookMarked size={11} aria-hidden="true" /> Recipes
            </button>
            {open && (
            <div ref={popRef} role="dialog" aria-label="Recipe actions" style={{
                position: 'absolute', right: 0, top: '100%', zIndex: 40,
                minWidth: 300, maxWidth: 420, padding: '8px 10px', marginTop: 4,
                background: '#100b19', border: '1px solid #493857', borderRadius: 6,
                boxShadow: '0 8px 24px rgba(0,0,0,0.55)', lineHeight: 1.5, color: '#e3d4f0',
            }}>
                <div style={{ fontSize: 10.5, opacity: 0.6, marginBottom: 6 }}>
                    Recipes carry the chain only (filters, order, bypass, color, mix). They never contain
                    your source path, node identity or chat history. Applying keeps this node's own source.
                </div>
                {recipes.length > 0 && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 6 }}>
                        <Search size={10} aria-hidden="true" style={{ opacity: 0.6 }} />
                        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)}
                            placeholder={`Search ${recipes.length} recipes…`}
                            aria-label="Search recipes"
                            style={{
                                flex: 1, minWidth: 0, boxSizing: 'border-box', background: '#160a24',
                                border: '1px solid #3a2456', color: '#f0e6ff', borderRadius: 4,
                                padding: '3px 6px', fontSize: 11,
                            }} />
                    </div>
                )}
                <div style={{ overflowY: 'auto', minHeight: 0 }}>
                    {shown.length === 0 && (
                        <div style={{ opacity: 0.7, marginBottom: 6 }}>
                            {recipes.length === 0 ? 'No saved recipes yet.' : 'No recipes match.'}
                        </div>
                    )}
                    {shown.length > 0 && (
                        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                            {shown.map((r) => (
                                <li key={r.slug} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                                    <button type="button" onClick={() => void onApplySlug(r.slug)}
                                        title={`Apply ${r.name} (${r.stepCount} steps) to this node`}
                                        aria-label={`Apply recipe ${r.name}`}
                                        style={{ flex: 1, textAlign: 'left', background: 'none', border: 'none',
                                            color: '#f0e6ff', cursor: 'pointer', fontSize: 11, padding: '2px 0',
                                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                        {r.name} <span style={{ opacity: 0.5 }}>({r.stepCount})</span>
                                    </button>
                                    <button type="button" onClick={() => void onExport(r.slug)} aria-label={`Export ${r.name}`}
                                        title="Export as portable JSON" style={miniBtn}><Download size={10} aria-hidden="true" /></button>
                                    <button type="button" onClick={() => void onDelete(r.slug)} aria-label={`Delete ${r.name}`}
                                        title="Delete this recipe" style={miniBtn}><Trash2 size={10} aria-hidden="true" /></button>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
                {saving ? (
                    <form onSubmit={(e) => { e.preventDefault(); void onSave(); }} style={{
                        display: 'flex', gap: 6, marginTop: 6, borderTop: '1px solid #2a1850', paddingTop: 6, alignItems: 'center',
                    }}>
                        <input autoFocus value={nameDraft}
                            onChange={(e) => setNameDraft(e.target.value)}
                            aria-label="Recipe name"
                            placeholder="Recipe name"
                            style={{
                                flex: 1, minWidth: 0, boxSizing: 'border-box', background: '#160a24',
                                border: '1px solid #3a2456', color: '#f0e6ff', borderRadius: 4,
                                padding: '3px 6px', fontSize: 11, minHeight: 28,
                            }} />
                        <button type="submit" disabled={!nameDraft.trim()} style={miniBtn}
                            aria-label={`Save the current chain as recipe "${nameDraft.trim() || ''}"`}
                            title="Save the CURRENT chain under this name"><Save size={10} aria-hidden="true" /> Save</button>
                        <button type="button" onClick={() => setSaving(false)}
                            style={miniBtn} aria-label="Cancel saving a recipe">Cancel</button>
                    </form>
                ) : (
                    <div style={{ display: 'flex', gap: 6, marginTop: 6, borderTop: '1px solid #2a1850', paddingTop: 6 }}>
                        <button type="button" onClick={() => setSaving(true)} style={miniBtn} title="Save the CURRENT chain as a new recipe"
                            aria-label="Save current chain as recipe"><Save size={10} aria-hidden="true" /> Save current…</button>
                        <button type="button" onClick={() => void onImport()} style={miniBtn} title="Import a recipe JSON file"
                            aria-label="Import recipe from file"><Upload size={10} aria-hidden="true" /> Import</button>
                    </div>
                )}
                {note && <div role="status" style={{ marginTop: 6, fontSize: 10.5, color: '#b9a9d6', overflowWrap: 'anywhere' }}>{note}</div>}
            </div>
            )}
        </div>
    );
};

const miniBtn: React.CSSProperties = {
    background: 'transparent', border: '1px solid #3a2456', color: '#c4a8ff',
    cursor: 'pointer', padding: '2px 6px', borderRadius: 4, fontSize: 10,
    display: 'inline-flex', alignItems: 'center', gap: 4, minHeight: 24, flexShrink: 0,
};