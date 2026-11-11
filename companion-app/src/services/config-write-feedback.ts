import type { NodeConfig } from '../types';

export type ConfigWriteIntent = 'automatic' | 'apply-and-close';
export type ConfigWriteOutcome = 'idle' | 'waiting' | 'bridge-unavailable' | 'no-host-path'
    | 'not-attempted' | 'editor-only' | 'write-reported' | 'unconfirmed';

export interface ConfigWriteFeedback {
    pending: number;
    outcome: ConfigWriteOutcome;
    intent: ConfigWriteIntent | null;
    detail: string;
    error: boolean;
    closeScheduled: boolean;
    /** Renderer-lifetime warning. A later successful reply cannot resolve an earlier unknown. */
    unconfirmedDetail: string | null;
}

export const INITIAL_CONFIG_WRITE_FEEDBACK: ConfigWriteFeedback = Object.freeze({
    pending: 0, outcome: 'idle', intent: null, detail: '', error: false,
    closeScheduled: false, unconfirmedDetail: null,
});

const MAX_DETAIL = 4096;
const TRUNCATED = '… [details truncated]';
function detail(value: unknown, fallback: string): string {
    try {
        const text = typeof value === 'string' ? value
            : value && typeof (value as { message?: unknown }).message === 'string'
                ? (value as { message: string }).message : fallback;
        if (!text.trim()) return fallback;
        return text.length > MAX_DETAIL ? text.slice(0, MAX_DETAIL - TRUNCATED.length) + TRUNCATED : text;
    } catch { return fallback; }
}

type Observation = Pick<ConfigWriteFeedback, 'outcome' | 'detail' | 'error' | 'closeScheduled'>;
function unknownReply(message = 'The companion response did not establish a configuration-write outcome.'): Observation {
    return { outcome: 'unconfirmed', detail: message, error: true, closeScheduled: false };
}

function readReply(value: unknown, intent: ConfigWriteIntent): Observation {
    try {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return unknownReply();
        const reply = value as Record<string, unknown>;
        const { ok, writePhase, closeScheduled } = reply;
        if (typeof ok !== 'boolean' || typeof closeScheduled !== 'boolean') return unknownReply();
        if (writePhase === 'no-host-path' && ok && !closeScheduled) {
            return { outcome: 'no-host-path', detail: detail(reply.note, 'No host result path is configured.'),
                error: false, closeScheduled: false };
        }
        if (writePhase === 'not-attempted' && !ok && !closeScheduled) {
            return { outcome: 'not-attempted', detail: detail(reply.error, 'The companion could not prepare the write.'),
                error: true, closeScheduled: false };
        }
        if (writePhase === 'unconfirmed' && !ok && !closeScheduled) {
            return unknownReply(detail(reply.error, 'The companion could not confirm a completed write.'));
        }
        if (writePhase === 'editor-only' && ok && !closeScheduled && intent === 'automatic') {
            return { outcome: 'editor-only', detail: detail(reply.note, 'Edits remain in this editor; no pending file write was requested.'),
                error: false, closeScheduled: false };
        }
        if (writePhase === 'write-reported') {
            if ((ok && closeScheduled !== (intent === 'apply-and-close')) || (!ok && closeScheduled)) {
                return unknownReply('The companion reply did not match the requested close behavior.');
            }
            return { outcome: 'write-reported', detail: ok ? ''
                : detail(reply.error, 'The write was reported, but the configuration request ended with an error.'),
                error: !ok, closeScheduled };
        }
        return unknownReply();
    } catch { return unknownReply('The companion response could not be read safely.'); }
}

/** Observes replies only: no timers, retries, payload retention, native cleanup or host-completion inference. */
export function createConfigWriteFeedbackObserver() {
    let state = { ...INITIAL_CONFIG_WRITE_FEEDBACK };
    let serial = 0;
    let latest = 0;
    let listener: { token: object; update: (snapshot: ConfigWriteFeedback) => void } | null = null;
    const snapshot = () => ({ ...state });
    const notify = () => {
        // Feedback must never throw into the dispatch path or cause a resend.
        try { listener?.update(snapshot()); } catch { /* The request outcome is still retained here. */ }
    };
    return {
        snapshot,
        subscribe(update: (value: ConfigWriteFeedback) => void) {
            const token = {};
            listener = { token, update };
            notify();
            return () => { if (listener?.token === token) listener = null; };
        },
        unavailable(intent: ConfigWriteIntent, reason: unknown) {
            latest = ++serial;
            state = { ...state, intent, outcome: 'bridge-unavailable',
                detail: detail(reason, 'The configuration bridge is unavailable.'), error: true, closeScheduled: false };
            notify();
        },
        begin(intent: ConfigWriteIntent) {
            const id = ++serial;
            latest = id;
            state = { ...state, pending: state.pending + 1, intent, outcome: 'waiting',
                detail: '', error: false, closeScheduled: false };
            notify();
            let settled = false;
            const finish = (observation: Observation) => {
                if (settled) return;
                settled = true;
                state = { ...state, pending: state.pending - 1,
                    ...(id === latest ? observation : {}),
                    unconfirmedDetail: observation.outcome === 'unconfirmed'
                        ? observation.detail : state.unconfirmedDetail };
                notify();
            };
            return {
                resolve: (value: unknown) => finish(readReply(value, intent)),
                reject: (reason: unknown) => finish(unknownReply(detail(reason,
                    'No configuration-write acknowledgement was received.'))),
            };
        },
    };
}

type Observer = ReturnType<typeof createConfigWriteFeedbackObserver>;
interface WriteBridge {
    applyConfig?: (config: NodeConfig, options?: { close?: boolean }) => unknown;
}

/** Calls the existing bridge once. Preparation failures and invoked-but-unconfirmed outcomes stay distinct. */
export function requestConfigWrite(
    getBridge: () => WriteBridge | undefined, config: NodeConfig,
    options: { close: boolean }, observer: Observer,
): Promise<void> | undefined {
    const intent = options.close ? 'apply-and-close' : 'automatic';
    let bridge: WriteBridge | undefined;
    let apply: WriteBridge['applyConfig'];
    try {
        bridge = getBridge();
        apply = bridge?.applyConfig;
    } catch (error) { observer.unavailable(intent, error); return; }
    if (typeof apply !== 'function') { observer.unavailable(intent, 'The configuration bridge is unavailable.'); return; }
    const request = observer.begin(intent);
    try {
        const response = apply.call(bridge, config, options);
        return Promise.resolve(response).then(request.resolve, request.reject);
    } catch (error) { request.reject(error); }
}
