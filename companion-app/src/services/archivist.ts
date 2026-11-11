// Renderer-side helper to talk to the main-process Anthropic streaming bridge.
// Phase 2 (TKT-A5) expands this into a multi-vendor provider abstraction.

import type { ChatMessage } from '../types';

export interface ToolUseProposal {
    name: string;
    toolUseId: string;
    input: unknown;
    /** Present when the main-process agentic loop is awaiting an ack for this
     *  tool call — echo it back via sendArchivistToolAck so the model receives
     *  a real tool_result describing what the UI did. */
    editId?: string;
}

export interface StreamHandle {
    cancel: () => void;
    done: Promise<void>;
}

type ApiBridge = NonNullable<Window['electron']> & {
    sendArchivistMessage?: (payload: {
        messages: ChatMessage[];
        system: string;
        modelId: string;
    }) => Promise<{ requestId: string }>;
    onArchivistChunk?: (cb: (chunk: { requestId: string; text: string }) => void) => () => void;
    onArchivistComplete?: (cb: (info: { requestId: string }) => void) => () => void;
    onArchivistError?: (cb: (info: { requestId: string; error: string }) => void) => () => void;
    onArchivistToolUse?: (cb: (info: { requestId: string } & ToolUseProposal) => void) => () => void;
    abortArchivist?: (requestId: string) => void;
    sendArchivistToolAck?: (payload: {
        editId: string;
        outcome: string;
        chainLength?: number;
        appliedOps?: number;
    }) => void;
    onMcpChainEdit?: (cb: (payload: {
        editId: string;
        operations: unknown;
        explanation?: string;
    }) => void) => () => void;
};

/** Ack a bridged tool call (agentic propose_chain_edit or MCP apply_chain_edit). */
export function ackToolBridge(payload: {
    editId: string; outcome: string; chainLength?: number; appliedOps?: number;
}): void {
    const bridge = window.electron as ApiBridge | undefined;
    bridge?.sendArchivistToolAck?.(payload);
}

/** Subscribe to chain edits arriving from external MCP clients. */
export function onMcpChainEdit(
    cb: (payload: { editId: string; operations: unknown; explanation?: string }) => void
): () => void {
    const bridge = window.electron as ApiBridge | undefined;
    return bridge?.onMcpChainEdit?.(cb) ?? (() => {});
}

// Limits apply only while waiting for the local invoke response, not to a turn's
// normal output. Serialized UTF-16 units bound retained payload, not process RSS.
export const CHAT_STARTUP_LIMITS = Object.freeze({
    events: 64, serializedUnits: 32_768, setupMs: 10_000,
    terminalIds: 64, requestIdUnits: 128,
});
// A local timeout/cancel cannot prove backend termination. Quarantined requests
// block new renderer dispatches, including compaction, until a matched terminal.
const uncertainRequests = new Set<Promise<void>>();
let uncertaintySettled: { done: Promise<void>; resolve: () => void } | null = null;

type StreamEvent =
    | { kind: 'chunk'; requestId: string; text: string }
    | { kind: 'tool'; requestId: string; proposal: ToolUseProposal }
    | { kind: 'complete'; requestId: string }
    | { kind: 'error'; requestId: string; error: string };

export function streamArchivist(args: {
    messages: ChatMessage[];
    system: string;
    modelId: string;
    onChunk: (text: string) => void;
    onError: (msg: string) => void;
    onToolUse?: (proposal: ToolUseProposal) => void;
}): StreamHandle {
    if (uncertainRequests.size) {
        args.onError('Message not sent: another request has unknown backend status. Sending remains blocked until it ends.');
        return { cancel: () => {}, done: uncertaintySettled!.done.then(() => {
            args.onError('This message was not sent. The earlier unknown requests have ended; review and resend it if needed.');
        }) };
    }
    const bridge = window.electron as ApiBridge | undefined;
    if (!bridge?.sendArchivistMessage) {
        args.onError('Anthropic IPC bridge missing — companion app may be out of date.');
        return { cancel: () => {}, done: Promise.resolve() };
    }

    let myRequestId: string | null = null;
    let settled = false, attempted = false, uncertain = false;
    let terminalObserved = false;
    let cancelRequested = false, abortSent = false, cleanupFailed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let resolveDone!: () => void;
    const done = new Promise<void>(resolve => { resolveDone = resolve; });
    const pending: string[] = [];
    let retainedUnits = 0;
    const terminals = new Map<string, 'complete' | 'error'>();
    let terminalOverflowReported = false;
    const cleanups = new Map<StreamEvent['kind'], () => void>();
    const validId = (id: unknown): id is string => typeof id === 'string'
        && id.length > 0 && id.length <= CHAT_STARTUP_LIMITS.requestIdUnits;
    const clearTimer = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
    const clearPending = () => { pending.length = 0; retainedUnits = 0; };
    const remove = (kinds: StreamEvent['kind'][]) => {
        for (const kind of kinds) {
            const off = cleanups.get(kind); cleanups.delete(kind);
            try { off?.(); } catch { cleanupFailed = true; }
        }
    };
    const finish = (error?: string) => {
        if (settled) return;
        settled = true;
        clearTimer(); clearPending(); terminals.clear();
        remove(['chunk', 'tool', 'complete', 'error']);
        uncertainRequests.delete(done);
        if (!uncertainRequests.size) {
            const epoch = uncertaintySettled; uncertaintySettled = null; epoch?.resolve();
        }
        try {
            let message = uncertain
                ? 'The request was reported as ended after a setup failure or cancellation request. Review any response or changes already received before sending again.'
                : error;
            if (cleanupFailed) message = `${message ?? 'The request ended.'} Local event cleanup was incomplete.`;
            if (message !== undefined) args.onError(message);
        } finally { resolveDone(); }
    };
    const rememberTerminal = (event: StreamEvent) => {
        if ((event.kind !== 'complete' && event.kind !== 'error') || !validId(event.requestId)) return;
        if (!terminals.has(event.requestId) && terminals.size >= CHAT_STARTUP_LIMITS.terminalIds) {
            if (!terminalOverflowReported) {
                terminalOverflowReported = true;
                args.onError('Terminal status buffer limit exceeded. Backend status remains unknown and sending stays blocked.');
            }
            return;
        }
        // Only bounded IDs/kinds remain in quarantine, never text/tool payloads.
        if (!terminals.has(event.requestId)) terminals.set(event.requestId, event.kind);
    };
    const markUnknown = (reason: string) => {
        if (settled || uncertain) return;
        if (!attempted) { finish(reason); return; }
        uncertain = true;
        if (!uncertaintySettled) {
            let resolve!: () => void;
            const done = new Promise<void>(ready => { resolve = ready; });
            uncertaintySettled = { done, resolve };
        }
        uncertainRequests.add(done); clearTimer();
        for (const encoded of pending) rememberTerminal(JSON.parse(encoded) as StreamEvent);
        clearPending(); remove(['chunk', 'tool']);
        try {
            args.onError(`${reason} Backend status is unknown; sending stays blocked until a matching terminal report is received.`);
        } finally {
            if (terminalObserved) finish();
        }
    };
    const deliver = (event: StreamEvent) => {
        if (settled || event.requestId !== myRequestId) return;
        if (event.kind === 'complete') finish();
        else if (event.kind === 'error') finish(event.error);
        else if (!uncertain && event.kind === 'chunk') args.onChunk(event.text);
        else if (!uncertain && event.kind === 'tool') args.onToolUse?.(event.proposal);
    };
    const receive = (event: StreamEvent) => {
        if (settled) return;
        if (myRequestId !== null) {
            if (event.requestId === myRequestId && (event.kind === 'complete' || event.kind === 'error')) terminalObserved = true;
            try { deliver(event); }
            catch { markUnknown('Local response handling failed; response output was discarded.'); }
            return;
        }
        if (uncertain) { rememberTerminal(event); return; }
        try {
            const encoded = JSON.stringify(event);
            if (typeof encoded !== 'string') throw new Error('Unsupported startup data');
            if (!validId(event.requestId) || pending.length >= CHAT_STARTUP_LIMITS.events
                || encoded.length > CHAT_STARTUP_LIMITS.serializedUnits - retainedUnits) {
                markUnknown('Request setup exceeded the startup buffer limit; buffered output was discarded.');
                if (uncertain) rememberTerminal(event);
                return;
            }
            pending.push(encoded); retainedUnits += encoded.length;
        } catch {
            markUnknown('Request setup contained unsupported startup data; buffered output was discarded.');
            if (uncertain) rememberTerminal(event);
        }
    };
    const requestAbort = () => {
        if (!cancelRequested || abortSent || !myRequestId || settled || !bridge.abortArchivist) return;
        abortSent = true;
        try { bridge.abortArchivist(myRequestId); }
        catch { /* Delivery is not acknowledgement; retain quarantine regardless. */ }
    };
    const register = (kind: StreamEvent['kind'], off: () => void) => {
        if (settled) { try { off(); } catch { cleanupFailed = true; } }
        else cleanups.set(kind, off);
    };
    try {
        register('chunk', bridge.onArchivistChunk!(c => receive({ kind: 'chunk', requestId: c.requestId, text: c.text })));
        register('tool', bridge.onArchivistToolUse?.(info => receive({ kind: 'tool', requestId: info.requestId, proposal: info })) ?? (() => {}));
        register('complete', bridge.onArchivistComplete!(info => receive({ kind: 'complete', requestId: info.requestId })));
        register('error', bridge.onArchivistError!(info => receive({ kind: 'error', requestId: info.requestId, error: info.error })));
        if (!settled) {
            timer = setTimeout(() => markUnknown('Request setup did not complete within the local startup deadline.'), CHAT_STARTUP_LIMITS.setupMs);
            attempted = true;
            bridge.sendArchivistMessage({ messages: args.messages, system: args.system, modelId: args.modelId })
                .then(({ requestId }) => {
                    if (settled) return;
                    clearTimer();
                    if (!validId(requestId)) { markUnknown('Request setup returned an invalid request identifier.'); return; }
                    myRequestId = requestId;
                    if (uncertain) {
                        terminalObserved = terminals.has(requestId); terminals.clear();
                        if (terminalObserved) finish(); else requestAbort();
                        return;
                    }
                    const early = pending.splice(0).map(encoded => JSON.parse(encoded) as StreamEvent);
                    retainedUnits = 0;
                    terminalObserved = early.some(event => event.requestId === myRequestId
                        && (event.kind === 'complete' || event.kind === 'error'));
                    for (const event of early) {
                        if (settled || uncertain) break;
                        deliver(event);
                    }
                }).catch(() => markUnknown('Request setup failed after dispatch was attempted.'));
        }
    } catch (err) {
        const reason = attempted ? 'Request setup threw after dispatch was attempted.'
            : (err instanceof Error ? err.message : String(err));
        markUnknown(reason);
    }
    return {
        cancel: () => {
            if (settled) return;
            cancelRequested = true;
            markUnknown('Cancellation was requested locally; backend termination is not confirmed.');
            requestAbort();
        },
        done,
    };
}
