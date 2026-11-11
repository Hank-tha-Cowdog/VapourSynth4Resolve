export type EditorMode = 'host' | 'host-manual' | 'standalone' | 'legacy';
export interface EditorStartupState {
    phase: 'waiting' | 'unavailable' | 'ready';
    mode: EditorMode | null;
    detail: string;
}
export const INITIAL_EDITOR_STARTUP: EditorStartupState = Object.freeze({
    phase: 'waiting', mode: null, detail: 'Waiting for editor configuration.',
});

interface BootstrapBridge {
    syncFromHost?: (callback: (config: unknown) => void) => (() => void) | undefined;
    getEditorConfiguration?: () => unknown;
}
const object = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);
function errorDetail(value: unknown, fallback: string): string {
    try {
        const text = typeof value === 'string' ? value
            : object(value) && typeof value.message === 'string' ? value.message : fallback;
        if (!text.trim()) return fallback;
        const marker = '\n[details truncated]';
        return text.length > 4096 ? text.slice(0, 4096 - marker.length) + marker : text;
    } catch { return fallback; }
}

/** One snapshot request per controller, with a compatibility push listener. No retries or timeouts. */
export function createEditorBootstrap() {
    let state = { ...INITIAL_EDITOR_STARTUP };
    let applied = false;
    let snapshotStarted = false;
    let pending: { config: Record<string, unknown> | null; mode: EditorMode; note: string } | null = null;
    let active: {
        token: object;
        apply: (config: Record<string, unknown> | null, mode: EditorMode) => void;
        update: (value: EditorStartupState) => void;
        unsubscribe?: () => void;
    } | null = null;
    const notify = () => {
        try { active?.update({ ...state }); } catch { /* Readiness remains held in this controller. */ }
    };
    const issue = (detail: string) => {
        state = { ...state, phase: applied ? 'ready' : 'unavailable', detail };
        notify();
    };
    const deliver = () => {
        if (!active || applied || !pending) return;
        const value = pending;
        pending = null;
        try {
            active.apply(value.config, value.mode);
            applied = true;
            state = { phase: 'ready', mode: value.mode, detail: value.note };
            notify();
        } catch (error) {
            issue(errorDetail(error, 'The reported configuration could not be prepared for this editor.'));
        }
    };
    const accept = (config: unknown, mode: EditorMode, note = '') => {
        if (config !== null && !object(config)) {
            issue('The companion configuration was not an object.'); return;
        }
        if (config === null && mode !== 'standalone') {
            issue('No host configuration was supplied.'); return;
        }
        if (applied) {
            // A late authoritative mode may refine the origin without overwriting local edits.
            if (mode !== 'legacy') {
                state = { phase: 'ready', mode, detail: note };
                notify();
            }
            return;
        }
        if (!pending || mode !== 'legacy') pending = { config, mode, note };
        deliver();
    };
    const reply = (value: unknown) => {
        try {
            if (!object(value) || typeof value.ok !== 'boolean') {
                issue('The companion did not return a usable configuration response.'); return;
            }
            if (!value.ok) {
                issue(errorDetail(value.error, 'The companion could not establish editor configuration.')); return;
            }
            if (value.mode !== 'host' && value.mode !== 'host-manual' && value.mode !== 'standalone') {
                issue('The companion returned an unknown editor configuration mode.'); return;
            }
            accept(value.config, value.mode, typeof value.note === 'string' ? errorDetail(value.note, '') : '');
        } catch { issue('The configuration response could not be read.'); }
    };
    return {
        snapshot: () => ({ ...state }),
        connect(
            getBridge: () => BootstrapBridge | undefined,
            apply: (config: Record<string, unknown> | null, mode: EditorMode) => void,
            update: (value: EditorStartupState) => void,
        ) {
            active?.unsubscribe?.();
            const token = {};
            active = { token, apply, update };
            notify();
            let bridge: BootstrapBridge | undefined;
            try {
                bridge = getBridge();
                if (!bridge) { issue('The editor configuration bridge is unavailable.'); }
                const subscribe = bridge?.syncFromHost;
                if (typeof subscribe === 'function') {
                    const cleanup = subscribe.call(bridge, config => {
                        if (active?.token === token) accept(config, 'legacy');
                    });
                    if (active?.token === token) active.unsubscribe = cleanup;
                    else cleanup?.();
                }
            } catch (error) { issue(errorDetail(error, 'The configuration subscription could not be established.')); }
            try {
                const get = bridge?.getEditorConfiguration;
                if (!snapshotStarted && typeof get === 'function') {
                    snapshotStarted = true;
                    Promise.resolve(get.call(bridge)).then(reply,
                        error => issue(errorDetail(error, 'The configuration request did not complete.')));
                } else if (!snapshotStarted && bridge) {
                    state = { ...state, detail: applied ? state.detail
                        : 'Waiting for host-sync; this bridge has no configuration snapshot method.' };
                    notify();
                }
            } catch (error) { issue(errorDetail(error, 'The configuration request could not be invoked.')); }
            deliver();
            return () => {
                if (active?.token !== token) return;
                const cleanup = active.unsubscribe;
                active = null;
                cleanup?.();
            };
        },
    };
}
