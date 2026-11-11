// VapourSynth Companion — popout app shell, wired to live local state.
// Phase 1 scope: chain editor + filter library + Skippy chat work end-to-end against
// local state. Phase 2 wires `previewChain` IPC for live preview frames.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { MessageSquare } from 'lucide-react';
import { ArchivistChat } from './components/ArchivistChat';
import { ChainEditor, ManualOrderToggle } from './components/ChainEditor';
import { FilterLibrary, LibraryEntry } from './components/FilterLibrary';
import { CompanionChainPreview } from './components/CompanionChainPreview';
import { ScriptView } from './components/ScriptView';
import { ModelsPanel } from './components/ModelsPanel';
import { RecipeMenu } from './components/RecipeMenu';
import type { NeuralCapabilitySnapshot } from './services/app-reference';
import { CenterTabs, CenterTab } from './components/CenterTabs';
import { ClipInfoBar } from './components/ClipInfoBar';
import { PluginStatusBanner } from './components/PluginStatusBanner';
import { ConfigWriteStatus } from './components/ConfigWriteStatus';
import { EditorStartupStatus } from './components/EditorStartupStatus';
import { createEditorBootstrap, INITIAL_EDITOR_STARTUP } from './services/editor-bootstrap';
import { createConfigWriteFeedbackObserver, INITIAL_CONFIG_WRITE_FEEDBACK, requestConfigWrite } from './services/config-write-feedback';
import { PreviewPanel } from './components/PreviewPanel';
import { PipelinePanel } from './components/PipelinePanel';
import { OCIOBadge } from './components/OCIOBadge';
import { LogsPanel } from './components/LogsPanel';
import { SettingsModal } from './components/SettingsModal';
import { ARCHIVIST_GREETING, LLM_MODELS } from './constants';
import { StageNumber } from './types';
import { streamArchivist, ackToolBridge, onMcpChainEdit } from './services/archivist';
import { buildArchivistSystemPrompt } from './services/archivist-prompt';
import { applyOperations } from './services/chain-ops';
import { isStepApproved } from '../shared/draft-composer';
import { FILTER_SCHEMAS, schemaDefaults } from '../shared/filter-schemas';
import { COLOR_SPACE_GROUPS, GAMMA_GROUPS, type OptionGroup } from './services/color-menus';
import { inferColorDefaults } from './services/color-heuristic';
import {
    summarizeMessages, COMPACTION_THRESHOLD, KEEP_RECENT,
} from './services/compactor';
import type {
    NodeConfig, ChainStep, ChatMessage, ColorManagement, ChainOperation,
    SourceClipMetadata,
} from './types';

const DEFAULT_COLOR_MGMT: ColorManagement = {
    inputColorSpace: 'Rec.709',
    inputGamma: 'BT.1886',
    outputColorSpace: 'Rec.709',
    outputGamma: 'BT.1886',
    ocioConfig: 'studio-config-v2.1.0_aces-v1.3_ocio-v2.3',
};

const mkid = (prefix: string) => prefix + '-' + Math.random().toString(36).slice(2, 10);

function sourceRequestErrorDetail(error: unknown): string {
    const fallback = 'No usable error details were returned.';
    try {
        const text = typeof error === 'string' ? error
            : error && typeof error === 'object' && 'message' in error
                && typeof error.message === 'string' ? error.message : fallback;
        if (!text.trim()) return fallback;
        const marker = '\n[details truncated]';
        return text.length > 4096 ? text.slice(0, 4096 - marker.length) + marker : text;
    } catch { return fallback; }
}

const DEFAULT_CONFIG: NodeConfig = {
    schemaVersion: 1,
    nodeId: 'local-dev',
    manualOrder: false,
    colorManagement: DEFAULT_COLOR_MGMT,
    chain: [],
    mix: 1.0,
    archivist: {
        panelOpen: true,
        panelWidth: 380,
        selectedModelId: LLM_MODELS[0].id,
        thinkingMode: false,
        autoApply: true,  // chain edits go straight to the canvas; user approves per-link instead of per-chat-message
        messages: [
            { id: mkid('msg'), role: 'assistant', text: ARCHIVIST_GREETING, timestamp: new Date().toISOString() },
        ],
    },
};

export default function App() {
    const [config, setConfig] = useState<NodeConfig>(DEFAULT_CONFIG);
    const [writeFeedback, setWriteFeedback] = useState(INITIAL_CONFIG_WRITE_FEEDBACK);
    const writeObserver = useRef<ReturnType<typeof createConfigWriteFeedbackObserver> | null>(null);
    if (!writeObserver.current) writeObserver.current = createConfigWriteFeedbackObserver();
    useEffect(() => writeObserver.current!.subscribe(setWriteFeedback), []);
    const [startup, setStartup] = useState(INITIAL_EDITOR_STARTUP);
    const editorBootstrap = useRef<ReturnType<typeof createEditorBootstrap> | null>(null);
    if (!editorBootstrap.current) editorBootstrap.current = createEditorBootstrap();
    const isEditorReady = startup.phase === 'ready';
    // Lock heartbeat: prove THIS editor is usable so a wedged prior
    // instance loses the node lock to a fresh Configure (main.js).
    useEffect(() => {
        if (!isEditorReady) return;
        const ping = () => { try { window.electron?.editorHeartbeat?.(); } catch { /* best effort */ } };
        ping();
        const t = setInterval(ping, 3000);
        return () => clearInterval(t);
    }, [isEditorReady]);
    const [libraryWidth] = useState(220);
    const [libraryCollapsed, setLibraryCollapsed] = useState(false);
    const [chatWidth, setChatWidth] = useState(config.archivist.panelWidth);
    const [isResizingChat, setIsResizingChat] = useState(false);
    const [chatInput, setChatInput] = useState('');
    const [isThinking, setIsThinking] = useState(false);
    const [chatTurnUncertain, setChatTurnUncertain] = useState(false);
    // Synchronous per-conversation guard: React busy state alone can lag an event.
    const chatTurnActive = useRef(false);
    const [activeTab, setActiveTab] = useState<CenterTab>('chain');
    // Cmd+W (native-menu accelerator → 'shortcut:toggle-ab') reaches the
    // PREVIEW-SCOPED A/B toggle through this ref. The preview registers its
    // toggle on mount (and clears it on unmount), so the shortcut can never
    // fire on another tab or before the preview exists.
    const abToggleRef = useRef<(() => void) | null>(null);
    const registerAbToggle = useCallback((fn: (() => void) | null) => { abToggleRef.current = fn; }, []);
    useEffect(() => {
        const off = window.electron?.onShortcut?.((payload) => {
            if (payload?.name !== 'toggle-ab') return;
            // Guard 1: only the Preview tab owns the shortcut.
            if (activeTab !== 'preview') return;
            // Guard 2: never hijack a text field (chat composer, script
            // editor, time entry, recipe naming, model fields).
            const t = document.activeElement;
            if (t && t instanceof HTMLElement &&
                t.closest('input, textarea, select, [contenteditable="true"]')) return;
            abToggleRef.current?.();
        });
        return () => { off?.(); };
    }, [activeTab]);
    const [settingsOpen, setSettingsOpen] = useState(false);
    // Configuration is the single source of truth, including after host delivery.
    // Unknown saved IDs require a choice rather than silently selecting a provider.
    const selectedModel = LLM_MODELS.find(m => m.id === config.archivist.selectedModelId) ?? null;

    useEffect(() => {
        return editorBootstrap.current!.connect(() => window.electron, incoming => {
            // Deep-merge against DEFAULT_CONFIG. The host may legitimately send a
            // partial config — e.g. on the very first Configure click before any
            // Accept, cached_config_ on the C++ side is empty and we get
            // `{"clipMetadata": {...}}` with no other fields. Without this merge,
            // `config.mix.toFixed()` / `config.chain.length` crash on first render.
            const inc = (incoming ?? {}) as Partial<NodeConfig>;
            const incomingColor = inc.colorManagement;
            // Color profiles may also be partial. Fill absent fields, but keep
            // malformed supplied values behind the startup gate before setConfig.
            if (incomingColor != null && (typeof incomingColor !== 'object' || Array.isArray(incomingColor))) {
                throw new Error('Editor colorManagement must be an object.');
            }
            const mergedColor = { ...DEFAULT_CONFIG.colorManagement, ...(incomingColor ?? {}) };
            for (const field of Object.keys(DEFAULT_CONFIG.colorManagement) as (keyof ColorManagement)[]) {
                const value = incomingColor && Object.prototype.hasOwnProperty.call(incomingColor, field)
                    ? incomingColor[field] : undefined;
                if (value === undefined) mergedColor[field] = DEFAULT_CONFIG.colorManagement[field];
                else if (typeof value !== 'string') throw new Error(`Editor colorManagement.${field} must be text.`);
                else mergedColor[field] = value;
            }
            const incArc: Partial<NodeConfig['archivist']> = inc.archivist ?? {};
            const incomingMessages: ChatMessage[] = Array.isArray(incArc.messages) ? incArc.messages : [];
            const messages: ChatMessage[] = incomingMessages.map(
                (m) => m && m.id ? m : { ...m, id: mkid('msg') }
            );

            const merged: NodeConfig = {
                schemaVersion:   inc.schemaVersion   ?? DEFAULT_CONFIG.schemaVersion,
                nodeId:          inc.nodeId          ?? DEFAULT_CONFIG.nodeId,
                // Stable per-node identity round-trips through the renderer —
                // dropping it here forked the guid on every accepted save
                // (live defect: each Save-and-close regenerated identity).
                // CRITICAL (live save failure Oct 27, fresh node): set the
                // key ONLY when a value exists. `nodeGuid: undefined` puts a
                // PRESENT-but-undefined key on the object; IPC structured
                // clone preserves it; main-side isManualHostConfig treats a
                // present non-string as invalid → every Save and close was
                // rejected with 'A valid host session and chain array are
                // required.' and the companion exited without publishing.
                ...(inc.nodeGuid != null ? { nodeGuid: inc.nodeGuid } : {}),
                manualOrder:     inc.manualOrder     ?? DEFAULT_CONFIG.manualOrder,
                colorManagement: mergedColor,
                chain:           Array.isArray(inc.chain) ? inc.chain : [],
                mix:             typeof inc.mix === 'number' ? inc.mix : 1.0,
                clipMetadata:    inc.clipMetadata,
                archivist: {
                    panelOpen:       incArc.panelOpen       ?? DEFAULT_CONFIG.archivist.panelOpen,
                    panelWidth:      incArc.panelWidth      ?? DEFAULT_CONFIG.archivist.panelWidth,
                    selectedModelId: incArc.selectedModelId ?? DEFAULT_CONFIG.archivist.selectedModelId,
                    thinkingMode:    incArc.thinkingMode    ?? DEFAULT_CONFIG.archivist.thinkingMode,
                    autoApply:       incArc.autoApply       ?? DEFAULT_CONFIG.archivist.autoApply,
                    messages: messages.length > 0 ? messages : DEFAULT_CONFIG.archivist.messages,
                },
            };
            setConfig(merged);
        }, setStartup);
    }, []);

    // Auto-compaction (TKT-A6). When the chat passes the threshold, summarize the older
    // chunk via the current LLM and replace it with a single `kind: 'compaction'` marker
    // message. The trigger checks both length AND idle state — never compact while a
    // turn is streaming. compactionLock_ prevents concurrent attempts.
    const compactionLock = useRef(false);
    // Tool-bridge acks already sent, keyed by editId. Guards against StrictMode's
    // double-invoked state updaters sending duplicate tool_results to the model.
    const ackedEditIdsRef = useRef<Set<string>>(new Set());
    useEffect(() => {
        if (!isEditorReady || !selectedModel) return;
        const msgs = config.archivist.messages;
        if (msgs.length < COMPACTION_THRESHOLD) return;
        if (compactionLock.current) return;
        if (isThinking) return;

        compactionLock.current = true;
        const oldHead = msgs.slice(0, msgs.length - KEEP_RECENT);
        const newTail = msgs.slice(msgs.length - KEEP_RECENT);

        (async () => {
            try {
                const summary = await summarizeMessages(oldHead, selectedModel.id);
                const compactionMsg: ChatMessage = {
                    id: mkid('msg'),
                    role: 'assistant',
                    kind: 'compaction',
                    text: `${oldHead.length} earlier messages compacted:\n\n${summary}`,
                    timestamp: new Date().toISOString(),
                };
                setConfig(c => ({
                    ...c,
                    archivist: {
                        ...c.archivist,
                        messages: [compactionMsg, ...newTail],
                    },
                }));
            } catch (err) {
                // Leave history untouched on failure. Will retry on next trigger.
                console.warn('[compactor] failed:', err);
            } finally {
                compactionLock.current = false;
            }
        })();
    }, [config.archivist.messages.length, isThinking, selectedModel?.id, isEditorReady]);

    useEffect(() => {
        if (!isResizingChat) return;
        const onMove = (e: MouseEvent) => {
            const w = Math.max(280, Math.min(700, window.innerWidth - e.clientX));
            setChatWidth(w);
        };
        const onUp = () => setIsResizingChat(false);
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        return () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };
    }, [isResizingChat]);

    // Runtime plugin availability — probe once per window when the editor is
    // live. The static manifest overclaimed (live case: fft3dfilter); the
    // probe is the honest source for Filter Library badges + the Archivist
    // prompt manifest. Failures keep undefined → curated labels stand.
    const [registeredNamespaces, setRegisteredNamespaces] = useState<ReadonlySet<string> | null>(null);
    useEffect(() => {
        if (!isEditorReady) return;
        let cancelled = false;
        (async () => {
            try {
                const result = await window.electron?.probeNamespaces?.();
                if (!cancelled && result?.ok && Array.isArray(result.namespaces)) {
                    setRegisteredNamespaces(new Set<string>(result.namespaces));
                    console.log(`[plugin-probe] ${result.namespaces.length} registered namespaces verified`);
                } else if (!cancelled) {
                    console.warn('[plugin-probe] unavailable:', result?.error);
                }
            } catch (error) {
                if (!cancelled) console.warn('[plugin-probe] failed:', error);
            }
        })();
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isEditorReady]);

    // LIVE neural-capability snapshot for the chat prompt (one authoritative
    // source with the Models UI; refreshed when the Models tab reports state
    // changes). Falls back to undefined → the reference states NOT-USABLE
    // with the last known level, never a stale categorical claim.
    const [neuralCapability, setNeuralCapability] = useState<NeuralCapabilitySnapshot | null>(null);
    const refreshNeuralCapability = useCallback(async () => {
        // C09 (2026-11-11): a refresh that FAILS or reports not-ok must
        // INVALIDATE the stored snapshot — keeping the last 'usable' state
        // left a stale snapshot that could keep RIFE addable and the prompt
        // claiming capability after the runtime regressed. Unknown state is
        // honest: prompt says not-usable-with-reason, library shows missing.
        try {
            const snap = await window.electron?.neuralCapability?.();
            if (snap?.ok && snap.rife) setNeuralCapability({ rife: snap.rife });
            else setNeuralCapability({ rife: undefined });
        } catch {
            setNeuralCapability({ rife: undefined });
        }
    }, []);
    useEffect(() => {
        if (!isEditorReady) return;
        void refreshNeuralCapability();
    }, [isEditorReady, refreshNeuralCapability]);

    // Export THIS node's conversation to Markdown (roles, order and code
    // fences preserved). Only the current node's messages — never another
    // node's history, never settings/keys. Saved via dialog; clipboard
    // failure surfaces as an alert, not a silent skip.
    const onExportChat = useCallback(async () => {
        const exportMarkdown = (msgs: ChatMessage[], guid: string | undefined) => {
            const lines: string[] = [
                `# VapourSynth for Resolve — Skippy conversation`,
                ``,
                `Node: ${guid ?? '(legacy node)'}`,
                `Exported: ${new Date().toISOString()}`,
                `Messages: ${msgs.length}`,
                ``,
                `---`,
                ``,
            ];
            for (const m of msgs) {
                const who = m.role === 'user' ? 'You' : m.role === 'assistant' ? 'Skippy' : m.role;
                lines.push(`## ${who}${m.timestamp ? ` — ${m.timestamp}` : ''}`);
                lines.push('');
                // Fence any fenced blocks one level deeper so message structure
                // survives as valid Markdown.
                lines.push(m.text.replace(/```/g, '````'));
                lines.push('');
            }
            return lines.join('\n');
        };
        try {
            const markdown = exportMarkdown(config.archivist.messages, config.nodeGuid);
            const result = await window.electron?.saveTextFile?.({
                defaultName: `vsr-chat-${(config.nodeGuid ?? 'legacy').slice(0, 12)}-${Date.now()}.md`,
                contents: markdown,
            });
            if (result && result.ok === false) {
                window.alert(`Export failed: ${result.error ?? 'unknown error'}`);
            }
        } catch (e) {
            window.alert(`Export failed: ${e instanceof Error ? e.message : String(e)}`);
        }
    }, [config.archivist.messages, config.nodeGuid]);

    const onAddFilter = useCallback((entry: LibraryEntry) => {
        setConfig(c => {
            let params: Record<string, unknown> = {};
            if (entry.type === 'script') {
                // Curated library templates seed the editor with a WORKING,
                // probe-verified starting point (not a blank page); the
                // colorist still reviews/approves it as a draft step.
                // schemaType binds schema-backed entries to structured panels.
                params = {
                    code: entry.template ?? '',
                    ...(entry.schemaType ? { schemaType: entry.schemaType } : {}),
                    ...(entry.label && entry.label !== 'Script' ? { label: entry.label } : {}),
                };
            } else if (entry.type === 'qtgmc') {
                // Seed field order from the probe verdict when we have one —
                // idet pixel content beats the container flag (see docs/agentic.md,
                // Field-order policy). Falls back to TFF, the safer guess for
                // non-DV material; the panel shows the verdict hint either way.
                const detected = (c.clipMetadata?.source as
                    { video?: { detectedScanType?: string } } | null | undefined)?.video?.detectedScanType;
                params = {
                    label: 'QTGMC — Deinterlace',
                    preset: 'Slower',
                    tff: detected !== 'bb',
                    fpsDivisor: 2,
                };
            }
            // C07 (2026-11-11): schema-backed entries (CST and every other
            // filter schema — including script entries BOUND via schemaType)
            // are seeded with the schema's COMPLETE default parameter set.
            // The structured panel's strict emitter requires every key on the
            // first edit; a sparse param set threw before anything could
            // save, and the initial template also read as CUSTOM.
            const schemaBoundType = entry.type === 'script' ? entry.schemaType : entry.type;
            if (schemaBoundType && FILTER_SCHEMAS[schemaBoundType]) {
                params = { ...schemaDefaults(schemaBoundType), ...params };
            }
            const newStep: ChainStep = {
                id: mkid('step'),
                type: entry.type,
                stage: StageNumber[entry.stage],
                enabled: true,
                version: 1,
                // CONTENT-BOUND APPROVAL (2026-11-11): every executable step
                // enters the chain UNAPPROVED with no binding. The user's
                // review click (Approve in the chain editor) stores
                // approvedContent with the exact emitted body; both composers
                // skip anything not content-bound. Previously a library-added
                // qtgmc had no approval field and both composers treated the
                // missing field as LIVE (security re-review finding).
                approved: false,
                approvedContent: null,
                params,
            };
            return { ...c, chain: [...c.chain, newStep] };
        });
    }, []);

    const onChainChange = useCallback((chain: ChainStep[]) => {
        setConfig(c => ({ ...c, chain }));
    }, []);

    const onSetManualOrder = useCallback((manualOrder: boolean) => {
        setConfig(c => ({ ...c, manualOrder }));
    }, []);

    const onMixChange = useCallback((mix: number) => {
        setConfig(c => ({ ...c, mix }));
    }, []);

    // Decode the raw tool-use input from the model into typed ChainOperations.
    // Tolerant: skip malformed operations rather than reject the whole batch.
    const decodeOperations = useCallback((input: unknown, currentChain: ChainStep[]): ChainOperation[] => {
        const raw = (input ?? {}) as { operations?: unknown[]; edits?: unknown[] };
        // Back-compat: earlier prompt shape used `edits` (all adds). Treat as add-only.
        const legacyAdds = (raw.edits ?? []).map((e: any) => ({ op: 'add', step: e }));
        const ops = (raw.operations ?? legacyAdds) as any[];
        // eslint-disable-next-line no-console
        console.log('[decodeOperations] raw tool input:', JSON.stringify(input).slice(0, 500));
        // eslint-disable-next-line no-console
        console.log('[decodeOperations] candidate ops count:', ops.length);
        const out: ChainOperation[] = [];
        for (const o of ops) {
            if (!o || typeof o !== 'object') {
                // eslint-disable-next-line no-console
                console.warn('[decodeOperations] skipping non-object op:', o);
                continue;
            }
            if (o.op === 'add') {
                const s = o.step ?? o;
                if (!s.type || typeof s.stage !== 'number' || typeof s.code !== 'string') {
                    // eslint-disable-next-line no-console
                    console.warn('[decodeOperations] skipping malformed add — type:', typeof s.type, 'stage:', typeof s.stage, 'code:', typeof s.code, 'step:', JSON.stringify(s).slice(0, 200));
                    continue;
                }
                out.push({
                    op: 'add',
                    step: {
                        id: mkid('step'),
                        type: s.type,
                        stage: s.stage,
                        enabled: true,
                        // Skippy-emitted steps land as DRAFTS. The colorist
                        // reviews the script, then clicks Approve on the link
                        // header to flip approved=true and let the composer
                        // emit code for it. Manual library-add steps (see
                        // onAddFilter in App.tsx) get approved=true directly
                        // since the user added them deliberately.
                        approved: false,
                        version: 1,
                        params: { code: s.code, ...(s.label ? { label: s.label } : {}) },
                    },
                });
            } else if (o.op === 'update' && typeof o.target_id === 'string') {
                const exists = currentChain.some(s => s.id === o.target_id);
                if (!exists) continue;
                const patch: Partial<ChainStep> & { params?: Record<string, unknown> } = {};
                if (typeof o.stage === 'number') patch.stage = o.stage;
                if (typeof o.code === 'string')  patch.params = { code: o.code };
                if (typeof o.label === 'string') {
                    patch.params = { ...(patch.params ?? {}), label: o.label };
                }
                out.push({ op: 'update', targetId: o.target_id, patch });
            } else if (o.op === 'remove' && typeof o.target_id === 'string') {
                out.push({ op: 'remove', targetId: o.target_id });
            } else {
                // eslint-disable-next-line no-console
                console.warn('[decodeOperations] skipping unknown op:', o.op, JSON.stringify(o).slice(0, 200));
            }
        }
        // eslint-disable-next-line no-console
        console.log('[decodeOperations] decoded', out.length, 'operations');
        return out;
    }, []);

    const onSendChat = useCallback(() => {
        if (!selectedModel || !chatInput.trim() || chatTurnActive.current) return;
        chatTurnActive.current = true;
        setChatTurnUncertain(false);
        let settled = false;
        let assistantId: string | null = null;
        let lastReportedError: string | null = null;
        const finish = () => {
            if (settled) return;
            settled = true;
            chatTurnActive.current = false;
            setIsThinking(false);
            setChatTurnUncertain(false);
        };
        const reportError = (msg: string) => {
            const previous = lastReportedError;
            const next = `_${msg}_`;
            lastReportedError = next;
            setChatTurnUncertain(true);
            setConfig(c => {
                const msgs = c.archivist.messages.map(m => {
                    if (m.id !== assistantId) return m;
                    // Preserve response text; replace only this turn's previous diagnostic.
                    const text = m.text === previous ? ''
                        : previous && m.text.endsWith(`\n\n${previous}`)
                            ? m.text.slice(0, -previous.length - 2) : m.text;
                    return { ...m, text: text ? `${text}\n\n${next}` : next };
                });
                return { ...c, archivist: { ...c.archivist, messages: msgs } };
            });
        };
        try {
            const userMsg: ChatMessage = {
                id: mkid('msg'), role: 'user',
                text: chatInput.trim(), timestamp: new Date().toISOString(),
            };
            const assistantSlot: ChatMessage = {
                id: mkid('msg'), role: 'assistant',
                text: '', timestamp: new Date().toISOString(),
            };

            const history = [...config.archivist.messages, userMsg];
            assistantId = assistantSlot.id;
            const autoApply = config.archivist.autoApply;

            setConfig(c => ({
                ...c,
                archivist: { ...c.archivist, messages: [...history, assistantSlot] },
            }));
            setChatInput('');
            setIsThinking(true);

            const system = buildArchivistSystemPrompt(
                config.chain, config.colorManagement, config.clipMetadata,
                registeredNamespaces ?? undefined,
                neuralCapability ?? undefined,
                // Truthful per-session capability: ONLY the selected model's
                // real toolLoop gets tool-use instructions; text-only adapters
                // (OpenAI/OpenRouter/LM Studio/Ollama incl. Claude-via-OR)
                // get the manual paste path and must never claim control.
                { toolLoop: selectedModel.toolLoop === true,
                  manualOrder: config.manualOrder },
            );

            streamArchivist({
                messages: history,
                system,
                modelId: selectedModel.id,
                onChunk: (chunk) => {
                    setConfig(c => {
                        const msgs = c.archivist.messages.map(m =>
                            m.id === assistantId ? { ...m, text: m.text + chunk } : m
                        );
                        return { ...c, archivist: { ...c.archivist, messages: msgs } };
                    });
                    // Keep the braille spinner spinning while the model is still
                    // streaming. Was setting false here on the first chunk, which
                    // stopped the animation immediately when text started arriving.
                    // Keep it busy through tool rounds until the stream settles.
                },
                onToolUse: (proposal) => {
                    if (proposal.name !== 'propose_chain_edit') return;
                    const explanation = ((proposal.input ?? {}) as { explanation?: string }).explanation;

                    // Ack the main-process agentic loop exactly once per editId so the
                    // model receives a tool_result describing what the UI did. Guarded
                    // because the setConfig updater below can run twice in StrictMode.
                    const ackOnce = (outcome: string, chainLength: number, appliedOps: number) => {
                        if (!proposal.editId || ackedEditIdsRef.current.has(proposal.editId)) return;
                        ackedEditIdsRef.current.add(proposal.editId);
                        ackToolBridge({ editId: proposal.editId, outcome, chainLength, appliedOps });
                    };

                    // Capture current chain at the moment of tool use so update/remove refs resolve.
                    setConfig(c => {
                        const operations = decodeOperations(proposal.input, c.chain);
                        if (operations.length === 0) {
                            ackOnce('no valid operations decoded — nothing applied', c.chain.length, 0);
                            return c;
                        }

                        if (autoApply) {
                            // Apply immediately. Replace pendingAction with an APPLIED receipt
                            // so the message clearly shows it took effect without a stale Apply button.
                            const nextChain = applyOperations(c.chain, operations);
                            ackOnce('auto-applied to the chain', nextChain.length, operations.length);
                            const msgs = c.archivist.messages.map(m =>
                                m.id === assistantId
                                    ? {
                                        ...m,
                                        text: m.text || explanation || 'Applied chain edit.',
                                        pendingAction: { type: 'APPLIED' as const, appliedAt: new Date().toISOString() },
                                      }
                                    : m
                            );
                            return {
                                ...c,
                                chain: nextChain,
                                archivist: { ...c.archivist, messages: msgs },
                            };
                        }

                        ackOnce('confirm card shown — user must approve before it takes effect; do not assume it is applied', c.chain.length, 0);
                        const msgs = c.archivist.messages.map(m =>
                            m.id === assistantId
                                ? {
                                    ...m,
                                    text: m.text || explanation || 'Proposed chain edit:',
                                    pendingAction: { type: 'CONFIRM_CHAIN_EDIT' as const, operations, explanation },
                                  }
                                : m
                        );
                        return { ...c, archivist: { ...c.archivist, messages: msgs } };
                    });
                },
                onError: reportError,
            }).done.then(finish, () => {
                try { reportError('Skippy could not finish this message. Please try again.'); }
                finally { finish(); }
            });
        } catch {
            try { reportError('Skippy could not start this message. Please try again.'); }
            finally { finish(); }
        }
    }, [chatInput, selectedModel, config.archivist.messages, config.archivist.autoApply,
        config.chain, config.colorManagement, config.clipMetadata, decodeOperations]);

    // Clip-source identification:
    //   - timeline layer:  C++ side auto-injects from OFX clip API every Configure.
    //   - source layer:    auto-discovered via Resolve's Python scripting API on
    //                      every Configure click (zero gestures). Falls back to
    //                      drag-drop / picker if scripting is disabled.
    //   - Both layers auto-re-probe via ffprobe on every launch.
    type ResolveDiscovery =
        | { status: 'discovering' }
        | { status: 'discovered'; filePath: string }
        | { status: 'matched' }                     // discovered path equals cached
        | { status: 'scripting-disabled'; message: string }
        | { status: 'not-installed' }
        | { status: 'no-clip'; message: string }
        | { status: 'unknown-failure'; message: string }
        | { status: 'request-unconfirmed' }
        | { status: 'idle' };
    const [resolveDiscovery, setResolveDiscovery] =
        useState<ResolveDiscovery>({ status: 'idle' });
    // Failure evidence is independent of concurrent discovery progress. A later
    // matched path cannot acknowledge an earlier rejected probe or clear this.
    const [sourceRequestFailure, setSourceRequestFailure] = useState<string | null>(null);

    const onSourceProbed = useCallback((source: SourceClipMetadata) => {
        setConfig(c => {
            // TKT-SRC: if Input CS / Input γ are still at the factory defaults
            // (the user hasn't touched them since the chain was created),
            // auto-suggest the heuristic-inferred values so SD/NTSC sources
            // don't silently get processed as Rec.709. Only updates inputs —
            // outputs reflect what Resolve's timeline expects, which the user
            // should set explicitly.
            const cmIsDefault =
                c.colorManagement.inputColorSpace === DEFAULT_COLOR_MGMT.inputColorSpace &&
                c.colorManagement.inputGamma      === DEFAULT_COLOR_MGMT.inputGamma;
            let nextCM = c.colorManagement;
            if (cmIsDefault && source.video) {
                const h = inferColorDefaults(source.video);
                if (h.suggestedMatrix !== c.colorManagement.inputColorSpace ||
                    h.suggestedTransfer !== c.colorManagement.inputGamma) {
                    console.log(`[color-heuristic] source-derived inputs: matrix=${h.suggestedMatrix} γ=${h.suggestedTransfer} (${h.rationale})`);
                    nextCM = {
                        ...c.colorManagement,
                        inputColorSpace: h.suggestedMatrix,
                        inputGamma:      h.suggestedTransfer,
                    };
                }
            }
            // Reprobes replace the source metadata wholesale from ffprobe —
            // which has no notion of the Resolve clip's trim handles or retime.
            // Those come only from discovery (resolve-query.py), so preserve
            // the previously discovered values when the fresh probe lacks them.
            const prev = c.clipMetadata?.source;
            const merged: SourceClipMetadata = {
                ...source,
                sourceInPoint: source.sourceInPoint ?? prev?.sourceInPoint ?? null,
                sourceOutPoint: source.sourceOutPoint ?? prev?.sourceOutPoint ?? null,
                retimeDetected: source.retimeDetected ?? prev?.retimeDetected ?? false,
            };
            return {
                ...c,
                colorManagement: nextCM,
                clipMetadata: { ...(c.clipMetadata ?? {}), source: merged },
            };
        });
    }, []);
    // Patch trim handles + retime verdict from a fresh discovery result into
    // the cached source. Discovery is the ONLY producer of these fields (the
    // ffprobe reprobe doesn't know them), so every discovery hit — including
    // one whose path matches the cache — refreshes them.
    const patchSourceFromDiscovery = useCallback((d: {
        sourceInPoint?: number | null; sourceOutPoint?: number | null; retimeDetected?: boolean;
    }) => {
        if (d.sourceInPoint == null && d.sourceOutPoint == null && d.retimeDetected == null) return;
        setConfig(c => {
            const source = c.clipMetadata?.source;
            if (!source) return c;
            return {
                ...c,
                clipMetadata: { ...c.clipMetadata, source: {
                    ...source,
                    ...(d.sourceInPoint != null ? { sourceInPoint: d.sourceInPoint } : {}),
                    ...(d.sourceOutPoint != null ? { sourceOutPoint: d.sourceOutPoint } : {}),
                    ...(d.retimeDetected != null ? { retimeDetected: d.retimeDetected } : {}),
                } },
            };
        });
    }, []);
    const onSourceCleared = useCallback(() => {
        setConfig(c => {
            if (!c.clipMetadata) return c;
            const { source: _drop, ...rest } = c.clipMetadata;
            return { ...c, clipMetadata: rest };
        });
    }, []);

    // Auto-discover the source file path via Resolve's Python scripting API on
    // mount. If we get a hit, ffprobe it and update clipMetadata.source. If the
    // discovery returns the same path that's already cached, the auto-reprobe
    // effect below will refresh ffprobe data. If discovery fails (scripting
    // disabled / not installed / no clip), we surface a contextual hint via
    // resolveDiscovery state and fall back to the cached path (if any).
    // Runs for BOTH host session modes — 'host' and 'host-manual' (the manual
    // apply mode Resolve launches with today). The old 'host'-only gate meant
    // discovery never ran for Configure launches, forcing the manual Identify
    // button every time. Standalone mode (no host session) stays excluded.
    const discoveryAttemptedRef = useRef(false);
    useEffect(() => {
        if (!isEditorReady) return;
        const mode = startup?.mode;
        const isHostSession = mode === 'host' || mode === 'host-manual';
        if (!isHostSession) return;
        if (discoveryAttemptedRef.current) return;
        discoveryAttemptedRef.current = true;
        if (!window.electron?.queryCurrentClip) return;

        setResolveDiscovery({ status: 'discovering' });
        (async () => {
            const result = await window.electron!.queryCurrentClip!();
            if (!result?.ok || !result.filePath) {
                if (result?.scriptingDisabled) {
                    setResolveDiscovery({
                        status: 'scripting-disabled',
                        message: 'Enable Resolve → Preferences → System → General → External Scripting Using → Local for fully automatic source detection.',
                    });
                } else if (result?.notInstalled) {
                    setResolveDiscovery({ status: 'not-installed' });
                } else if (result?.helperFailed || result?.discoveryTimeout) {
                    // DISTINCT from 'no clip': the discovery helper itself
                    // crashed/timed out (live Oct 27: Fusion-side SIGSEGV in
                    // fusionscript.so). Non-blocking; manual Identify stays
                    // the usable path; never retried in a loop.
                    setResolveDiscovery({
                        status: 'unknown-failure',
                        message: result.error || 'Source discovery helper failed.',
                    });
                } else if (result?.scriptingUnavailable) {
                    setResolveDiscovery({
                        status: 'unknown-failure',
                        message: result.error || 'Resolve scripting unavailable.',
                    });
                } else {
                    setResolveDiscovery({
                        status: 'no-clip',
                        message: result?.error || 'No clip at the Resolve playhead.',
                    });
                }
                return;
            }

            const cachedPath = config.clipMetadata?.source?.filePath;
            if (cachedPath === result.filePath) {
                setResolveDiscovery({ status: 'matched' });
                // Same media file, but the user may have re-trimmed the clip
                // since the last Configure — refresh the trim handles + retime
                // verdict every discovery hit.
                patchSourceFromDiscovery(result);
                return;
            }
            // New / different path → ffprobe it and adopt.
            setResolveDiscovery({ status: 'discovered', filePath: result.filePath });
            const probe = await window.electron!.probeClip!(result.filePath);
            if (probe?.ok && probe.metadata) {
                onSourceProbed(probe.metadata);
                // The fresh probe has no trim/retime fields; adopt the
                // discovery verdicts on top of the new metadata.
                patchSourceFromDiscovery(result);
            }
        })().catch(error => {
            setSourceRequestFailure(sourceRequestErrorDetail(error));
            setResolveDiscovery({ status: 'request-unconfirmed' });
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isEditorReady, startup.mode]);

    // After a source.filePath is cached, re-probe asynchronously on subsequent
    // mounts. Most ffprobes finish in <200ms so this is invisible; if the file
    // moved/deleted we set fileMissing=true on the cached snapshot.
    //
    // TKT-SRC dedup key: `${filePath}|${hashPresent}`. The hash bit forces a
    // re-probe when a session resumes with cached metadata that predates the
    // Phase 1 hash field (the sidecar at last-config.json has filePath but no
    // sourceHash). Without it, the colorist would never see the hash chip on
    // sources first identified before the Phase 1 install.
    const reprobedKeyRef = useRef<string | null>(null);
    useEffect(() => {
        if (!isEditorReady || startup.mode !== 'host') return;
        const cached = config.clipMetadata?.source;
        if (!cached?.filePath) return;
        const key = `${cached.filePath}|${cached.sourceHash ? 'h' : 'nohash'}`;
        if (reprobedKeyRef.current === key) return;
        reprobedKeyRef.current = key;
        if (!cached.sourceHash) {
            console.log(`[reprobe] cached source has no hash yet — re-probing for fingerprint: ${cached.filePath}`);
        }

        (async () => {
            const result = await window.electron?.probeClip?.(cached.filePath);
            if (!result) return;
            if (!result.ok) {
                if (result.missing) {
                    setConfig(c => {
                        const existing = c.clipMetadata?.source;
                        if (!existing) return c;
                        return {
                            ...c,
                            clipMetadata: {
                                ...c.clipMetadata,
                                source: { ...existing, fileMissing: true },
                            },
                        };
                    });
                }
                return;
            }
            if (result.metadata) {
                if (result.metadata.sourceHash) {
                    console.log(`[reprobe] got fingerprint #${result.metadata.sourceHash.slice(0, 6)} for ${result.metadata.fileName}`);
                } else {
                    // No hash on the metadata — the main-process side threw
                    // somewhere. The hash IPC plumbs `integrityError` for
                    // exactly this case so the colorist sees the failure in
                    // DevTools instead of staring at a missing chip.
                    const err = (result as { integrityError?: string }).integrityError;
                    console.warn(`[reprobe] no fingerprint returned for ${result.metadata.fileName}${err ? ` — ${err}` : ''}`);
                }
                onSourceProbed(result.metadata);
            }
        })().catch(error => {
            setSourceRequestFailure(sourceRequestErrorDetail(error));
            setResolveDiscovery({ status: 'request-unconfirmed' });
        });
    }, [config.clipMetadata?.source?.filePath, config.clipMetadata?.source?.sourceHash, onSourceProbed, isEditorReady, startup.mode]);

    const onApplyChainEdit = useCallback((messageId: string, operations: ChainOperation[]) => {
        setConfig(c => {
            const nextChain = applyOperations(c.chain, operations);
            const msgs = c.archivist.messages.map(m =>
                m.id === messageId
                    ? { ...m, pendingAction: { type: 'APPLIED' as const, appliedAt: new Date().toISOString() } }
                    : m
            );
            return { ...c, chain: nextChain, archivist: { ...c.archivist, messages: msgs } };
        });
    }, []);

    const onDismissChainEdit = useCallback((messageId: string) => {
        setConfig(c => {
            const msgs = c.archivist.messages.map(m =>
                m.id === messageId
                    ? { ...m, pendingAction: { type: 'DISMISSED' as const, dismissedAt: new Date().toISOString() } }
                    : m
            );
            return { ...c, archivist: { ...c.archivist, messages: msgs } };
        });
    }, []);

    // Chain edits arriving from external MCP clients (apply_chain_edit tool).
    // Same decode + applyOperations path as Skippy edits; the applied edit
    // shows up in the chat log as a receipt so the colorist sees what happened,
    // and the live-sync effect pushes the new chain to the OFX plugin as usual.
    useEffect(() => {
        if (!isEditorReady) return;
        return onMcpChainEdit(({ editId, operations, explanation }) => {
            if (ackedEditIdsRef.current.has(editId)) return;
            setConfig(c => {
                const ops = decodeOperations({ operations }, c.chain);
                if (ops.length === 0) {
                    if (!ackedEditIdsRef.current.has(editId)) {
                        ackedEditIdsRef.current.add(editId);
                        ackToolBridge({ editId, outcome: 'no valid operations decoded — nothing applied', chainLength: c.chain.length, appliedOps: 0 });
                    }
                    return c;
                }
                const nextChain = applyOperations(c.chain, ops);
                if (!ackedEditIdsRef.current.has(editId)) {
                    ackedEditIdsRef.current.add(editId);
                    ackToolBridge({ editId, outcome: 'applied', chainLength: nextChain.length, appliedOps: ops.length });
                }
                const receipt: ChatMessage = {
                    id: mkid('msg'), role: 'assistant',
                    text: `⚡ External agent (MCP) edited the chain — ${explanation || `${ops.length} operation(s)`}`,
                    timestamp: new Date().toISOString(),
                    pendingAction: { type: 'APPLIED' as const, appliedAt: new Date().toISOString() },
                };
                return {
                    ...c,
                    chain: nextChain,
                    archivist: { ...c.archivist, messages: [...c.archivist.messages, receipt] },
                };
            });
        });
    }, [decodeOperations, isEditorReady]);

    const onSetAutoApply = useCallback((autoApply: boolean) => {
        setConfig(c => ({ ...c, archivist: { ...c.archivist, autoApply } }));
    }, []);

    const onAccept = useCallback(() => {
        if (!isEditorReady) return;
        // Observe the existing request; its reply is not a Resolve completion acknowledgement.
        void requestConfigWrite(() => window.electron, config, { close: true }, writeObserver.current!);
    }, [config, isEditorReady]);

    const onCancel = useCallback(() => {
        window.electron?.windowControl('window-close');
    }, []);

    // Live sync requests a companion file write after configuration edits.
    // File-write feedback is separate from reported plugin status or a Resolve render.
    //
    // 250 ms debounce keeps us from spamming the OFX file watcher during fast
    // typing in the Python editor (every keystroke triggers a config change).
    // Wait for reported configuration, then skip its first ready effect tick.
    // Later local edits can request writes; readiness is not a native acknowledgement.
    const seenInitial = useRef(false);
    const liveSyncDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => {
        if (!isEditorReady) return;
        if (!seenInitial.current) {
            seenInitial.current = true;
            // eslint-disable-next-line no-console
            console.log('[live-sync] initial mount, skipping first sync. config.chain.length =', config.chain.length);
            return;
        }
        if (liveSyncDebounce.current) clearTimeout(liveSyncDebounce.current);
        liveSyncDebounce.current = setTimeout(() => {
            const approved = config.chain.filter(s => s.enabled && isStepApproved(s)).length;
            const drafts   = config.chain.filter(s => s.enabled && !isStepApproved(s)).length;
            const disabled = config.chain.filter(s => !s.enabled).length;
            // eslint-disable-next-line no-console
            console.log(`[live-sync] pushing config: ${config.chain.length} total · ${approved} approved · ${drafts} drafts · ${disabled} disabled · ${config.archivist.messages.length} chat msgs`);
            if (config.chain.length > 0) {
                // eslint-disable-next-line no-console
                console.log('[live-sync] chain detail:', config.chain.map(s => ({
                    id: s.id, type: s.type, stage: s.stage, enabled: s.enabled, approved: s.approved,
                    codeBytes: typeof s.params?.code === 'string' ? s.params.code.length : 0,
                })));
            }
            void requestConfigWrite(() => window.electron, config, { close: false }, writeObserver.current!);
        }, 250);
        return () => {
            if (liveSyncDebounce.current) clearTimeout(liveSyncDebounce.current);
        };
    }, [config, isEditorReady]);

    const chatOpen = config.archivist.panelOpen;

    if (!isEditorReady) {
        return <EditorStartupStatus state={startup} onClose={onCancel} />;
    }

    return (
        <div style={{
            display: 'flex', flexDirection: 'column', height: '100vh',
            background: '#0a0414', color: '#f0e6ff',
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
            overflow: 'hidden',
        }}>
            <TitleBar onAccept={onAccept} onCancel={onCancel} manualHostApply={startup.mode === 'host-manual'}
                statusSlot={<PluginStatusBanner />} />
            {/* FULL-HEIGHT CHAT: the body is one horizontal row — the status
                bars live INSIDE the workspace column (left), and the chat
                column spans the entire app height alongside it. Chat no
                longer starts below the global bars (live feedback: stacked
                bars above both columns was not full-height chat), and the
                workspace reclaims the full width whenever chat collapses. */}
            <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
            <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
            <EditorStartupStatus state={startup} />
            {/* R4 (live feedback): the full-width "No recent status update"
                banner row is GONE — PluginStatusBanner now renders ONE
                title-bar status icon (TitleBar statusSlot) with details in
                a popup. No horizontal bar above the workspace. */}
            {/* UNIFIED STATUS (live feedback Oct 27): the persistent green
                ChainStateBar row AND the separate write-details row are GONE.
                One compact status chip now lives INLINE in the CenterTabs strip
                below — zero extra status-row height; click/Enter opens details;
                closing leaves nothing behind. Chain counts come from this node's
                live React state; write feedback is this window's own. */}
            <ColorManagementBar
                cm={config.colorManagement}
                onChange={(cm) => setConfig(c => ({ ...c, colorManagement: cm }))}
            />
            <ClipInfoBar
                metadata={config.clipMetadata}
                resolveDiscovery={resolveDiscovery}
                sourceRequestFailure={sourceRequestFailure}
                onSourceProbed={onSourceProbed}
                onSourceCleared={onSourceCleared}
            />
            <main style={{ display: 'flex', flex: 1, minHeight: 0 }}>
                <FilterLibrary
                    width={libraryWidth}
                    collapsed={libraryCollapsed}
                    onToggleCollapse={() => setLibraryCollapsed(!libraryCollapsed)}
                    onAdd={onAddFilter}
                    registeredNamespaces={registeredNamespaces ?? undefined}
                    neural={neuralCapability ?? undefined}
                />
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                    <CenterTabs
                        active={activeTab}
                        onChange={setActiveTab}
                        rightSlot={<>
                            {/* The one status chip — always visible in the
                                existing tab strip (no extra row). */}
                            <ConfigWriteStatus
                                feedback={writeFeedback}
                                manualHostApply={startup.mode === 'host-manual'}
                                counts={{
                                    total: config.chain.length,
                                    approved: config.chain.filter(s => s.enabled && isStepApproved(s)).length,
                                    drafts: config.chain.filter(s => s.enabled && !isStepApproved(s)).length,
                                    disabled: config.chain.filter(s => !s.enabled).length,
                                    chatMessages: config.archivist.messages.length,
                                }}
                            />
                            {activeTab === 'chain' && <>
                                <RecipeMenu
                                    onApply={(recipe) => {
                                        // Apply = replace THIS node's chain/color/mix, keeping the
                                        // node's own source binding, identity and chat. The recipe
                                        // carries no source (stripped at save), so nothing foreign
                                        // is imported; discovery re-detects as usual.
                                        setConfig(c => ({
                                            ...c,
                                            chain: recipe.chain as never,
                                            colorManagement: (recipe.colorManagement as never) ?? c.colorManagement,
                                            mix: typeof recipe.mix === 'number' ? recipe.mix : c.mix,
                                            manualOrder: typeof recipe.manualOrder === 'boolean' ? recipe.manualOrder : c.manualOrder,
                                        }));
                                    }}
                                    onSaveCurrent={async (name: string) => {
                                        const r = await window.electron?.saveRecipe?.({
                                            payload: {
                                                schemaVersion: 1,
                                                name,
                                                chain: config.chain,
                                                colorManagement: config.colorManagement,
                                                mix: config.mix,
                                                manualOrder: config.manualOrder,
                                            },
                                        });
                                        if (!r?.ok) return r?.error ?? 'recipe save failed';
                                        return `Saved "${r.recipe?.name ?? name}".`;
                                    }}
                                />
                                <ManualOrderToggle value={config.manualOrder} onChange={onSetManualOrder} />
                            </>}
                        </>}
                    />
                    {activeTab === 'chain' && (
                        <ChainEditor
                            chain={config.chain}
                            manualOrder={config.manualOrder}
                            setManualOrder={onSetManualOrder}
                            onChange={onChainChange}
                            clipMetadata={config.clipMetadata}
                        />
                    )}
                    {activeTab === 'pipeline' && <PipelinePanel config={config} />}
                    {activeTab === 'script'   && <ScriptView config={config} />}
                    {activeTab === 'models'   && <ModelsPanel onCapabilityChanged={refreshNeuralCapability} />}
                    {activeTab === 'preview'  && (startup.mode === 'host'
                        ? <PreviewPanel config={config} />
                        : startup.mode === 'host-manual'
                        // Manual-host sessions get the DRAFT-WYSIWYG preview:
                        // the current editor chain, composed companion-side
                        // (exact native mirror) and rendered through the real
                        // runtime — with per-step bypass pills and a
                        // latest-request-wins coordinator. Provenance is
                        // labeled DRAFT and never claimed as applied.
                        ? <CompanionChainPreview
                            config={config}
                            onChainChange={onChainChange}
                            onRegisterAbToggle={registerAbToggle} />
                        : <PreviewPanel config={config}
                            unavailableReason="Preview capability is unconfirmed. No preview request will be sent until a supported host preview path is established." />)}
                    {activeTab === 'logs'     && <LogsPanel nodeContext={`node ${config.nodeGuid ?? 'legacy'} · chain ${config.chain.length} steps`} />}
                </div>
            </main>
            </div>{/* /workspace column */}
            {chatOpen ? (
                <ArchivistChat
                    width={chatWidth}
                    isResizing={isResizingChat}
                    startResizing={(e) => { e.preventDefault(); setIsResizingChat(true); }}
                    messages={config.archivist.messages}
                    isThinking={isThinking}
                    requestUncertain={chatTurnUncertain}
                    inputValue={chatInput}
                    setInputValue={setChatInput}
                    handleSend={onSendChat}
                    selectedModel={selectedModel}
                    setSelectedModel={(m) => {
                        setConfig(c => ({ ...c, archivist: { ...c.archivist, selectedModelId: m.id } }));
                    }}
                    autoApply={config.archivist.autoApply}
                    onSetAutoApply={onSetAutoApply}
                    onOpenSettings={() => setSettingsOpen(true)}
                    onToggleCollapse={() =>
                        setConfig(c => ({ ...c, archivist: { ...c.archivist, panelOpen: false } }))}
                    onExportChat={onExportChat}
                    onApplyChainEdit={onApplyChainEdit}
                    onDismissChainEdit={onDismissChainEdit}
                />
            ) : (
                <CollapsedChatRail onExpand={() =>
                    setConfig(c => ({ ...c, archivist: { ...c.archivist, panelOpen: true } }))}
                />
            )}
            </div>{/* /body row: workspace + full-height chat */}
            {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
        </div>
    );
}

// (Removed Oct 27, live feedback): ChainStateBar + ChainStateDot — the
// persistent green 'local chain' strip consumed a full status row. Its
// counts moved into the unified status chip in the CenterTabs strip
// (ConfigWriteStatus counts prop — see components/ConfigWriteStatus.tsx).

const TitleBar: React.FC<{
    onAccept: () => void;
    onCancel: () => void;
    manualHostApply?: boolean;
    statusSlot?: React.ReactNode;
}> = ({ onAccept, onCancel, manualHostApply = false, statusSlot }) => {
    const closeNoteId = React.useId();
    return (
    <header style={{
        WebkitAppRegion: 'drag',
        height: 44,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '0 12px 0 70px',
        background: 'linear-gradient(90deg, #1a0830 0%, #2a0f4a 50%, #1a0830 100%)',
        borderBottom: '1px solid rgba(255, 43, 214, 0.4)',
        flexShrink: 0,
    } as React.CSSProperties}>
        <span style={{
            fontFamily: 'Brush Script MT, cursive',
            fontSize: 24,
            color: '#ff2bd6',
            textShadow: '0 0 14px #ff2bd6, 0 0 28px rgba(138, 43, 226, 0.7)',
            letterSpacing: 1,
        }}>Vapoursynth</span>
        <span style={{ opacity: 0.45, fontSize: 11, letterSpacing: 1 }}>
            FOR RESOLVE · v2.0.0-alpha
        </span>
        <div style={{ flex: 1 }} />
        {/* Mix slider removed — Resolve's OFX panel already exposes the chain's
            wet/dry control. Duplicating it in the popout was confusing and
            invited the question "which one wins?" (answer was 'this one
            overrides Resolve's', which is the wrong way around). */}
        <div
            style={{
                WebkitAppRegion: 'no-drag',
                display: 'flex', alignItems: 'center', gap: 12,
            } as React.CSSProperties}
        >
            {/* Publishing-instructions note removed (live feedback: repeated
                permanent copy). The single one-line reminder in
                ConfigWriteStatus covers it; aria-describedby now points at
                that nothing extra is claimed. */}
            <span id={closeNoteId} hidden aria-hidden="true" />
            {statusSlot}
            <button type="button" onClick={onCancel} aria-describedby={closeNoteId} style={{
                minHeight: 32,
                padding: '3px 12px', background: 'transparent',
                border: '1px solid #444', color: '#f0e6ff',
                borderRadius: 4, cursor: 'pointer', fontSize: 12,
            }}>Close</button>
            <button type="button" onClick={onAccept} style={{
                minHeight: 32,
                padding: '3px 16px',
                background: 'linear-gradient(135deg, #ff2bd6, #8a2be2)',
                border: 'none', color: '#fff', borderRadius: 4,
                cursor: 'pointer', fontSize: 12, fontWeight: 600,
                boxShadow: '0 0 12px rgba(255, 43, 214, 0.4)',
            }}>{manualHostApply ? 'Save and close' : 'Apply and close'}</button>
        </div>
    </header>
    );
};

const ColorManagementBar: React.FC<{
    cm: ColorManagement;
    onChange: (cm: ColorManagement) => void;
}> = ({ cm, onChange }) => {
    return (
        <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            flexWrap: 'wrap',
            padding: '4px 14px', borderBottom: '1px solid #2a1850',
            background: '#0d0418', fontSize: 11, flexShrink: 0,
        }}>
            <OCIOBadge size={12} />
            <GroupedSelect label="Input CS"  value={cm.inputColorSpace}  groups={COLOR_SPACE_GROUPS}
                           onChange={(v) => onChange({ ...cm, inputColorSpace: v })} />
            <GroupedSelect label="Input γ (label)"   value={cm.inputGamma}       groups={GAMMA_GROUPS}
                           onChange={(v) => onChange({ ...cm, inputGamma: v })} />
            <span style={{ opacity: 0.4 }}>→</span>
            <GroupedSelect label="Output CS" value={cm.outputColorSpace} groups={COLOR_SPACE_GROUPS}
                           onChange={(v) => onChange({ ...cm, outputColorSpace: v })} />
            <GroupedSelect label="Output γ (label)"  value={cm.outputGamma}      groups={GAMMA_GROUPS}
                           onChange={(v) => onChange({ ...cm, outputGamma: v })} />
            <button
                onClick={() => onChange({
                    ...cm,
                    inputColorSpace: cm.outputColorSpace, inputGamma: cm.outputGamma,
                    outputColorSpace: cm.inputColorSpace, outputGamma: cm.inputGamma,
                })}
                style={{
                    padding: '3px 10px', background: 'transparent',
                    border: '1px solid #444', color: '#f0e6ff',
                    borderRadius: 4, cursor: 'pointer', fontSize: 11,
                }}
            >Swap</button>
            {/* Matrix-only limitation moved to contextual help (live feedback: the
                permanent sentence consumed a full row). The TRUTH is preserved
                verbatim — gamma labels do NOT transform pixels — it is now
                discoverable via hover/focus on this info button instead of a
                permanent banner. */}
            <button type="button" aria-label="Color conversion limits" title="Color conversion is limited to RGB/YUV matrices. Gamma selections do not apply transfer-function transforms."
                style={{
                    background: 'transparent', border: 'none', color: '#a08ec4',
                    cursor: 'help', padding: '2px 4px', display: 'inline-flex', alignItems: 'center',
                    gap: 3, fontSize: 10, minHeight: 24, minWidth: 24,
                }}>
                ⓘ matrix-only
            </button>
        </div>
    );
};

const GroupedSelect: React.FC<{
    label: string;
    value: string;
    groups: OptionGroup[];
    onChange: (v: string) => void;
}> = ({ label, value, groups, onChange }) => (
    <label style={{ display: 'flex', alignItems: 'center', gap: 5, opacity: 0.85 }}>
        <span style={{ opacity: 0.7 }}>{label}</span>
        <select
            value={value}
            onChange={(e) => onChange(e.target.value)}
            style={{
                background: '#1a0830', color: '#f0e6ff',
                border: '1px solid #2a1850', borderRadius: 3,
                padding: '2px 6px', fontSize: 11, minWidth: 110,
            }}
        >
            {/* Render the current value as a one-off option if it isn't in any
                group — preserves chains stored with legacy names like
                'DCI-P3' (now renamed to P3-DCI in Resolve 21). */}
            {!groups.some(g => g.options.includes(value)) && value && (
                <option value={value}>{value}</option>
            )}
            {groups.map(g => (
                <optgroup key={g.label} label={g.label}>
                    {g.options.map(opt => (
                        <option key={opt} value={opt}>{opt}</option>
                    ))}
                </optgroup>
            ))}
        </select>
    </label>
);

const Select: React.FC<{
    label: string; value: string; options: string[]; onChange: (v: string) => void;
}> = ({ label, value, options, onChange }) => (
    <label style={{ display: 'flex', alignItems: 'center', gap: 5, opacity: 0.85 }}>
        <span style={{ opacity: 0.7 }}>{label}</span>
        <select
            value={value}
            onChange={(e) => onChange(e.target.value)}
            style={{
                background: '#1a0830', color: '#f0e6ff',
                border: '1px solid #2a1850', borderRadius: 3,
                padding: '2px 4px', fontSize: 11,
            }}
        >
            {options.map(o => <option key={o} value={o}>{o}</option>)}
        </select>
    </label>
);

const CollapsedChatRail: React.FC<{ onExpand: () => void }> = ({ onExpand }) => (
    <button type="button" onClick={onExpand} aria-label="Open Skippy" aria-expanded={false}
        style={{
            width: 44, minWidth: 44, minHeight: 44, flexShrink: 0,
            cursor: 'pointer', border: 'none', padding: 0,
            background: '#100722', borderLeft: '1px solid #2a1850',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
        title="Open Skippy"
    >
        <MessageSquare size={16} color="#ff2bd6" />
    </button>
);

// Footer was removed — Mix slider + Accept/Cancel moved into the title bar so the
// chain editor and other tabs get the full vertical real estate.
