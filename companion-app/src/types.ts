// Companion app types. Kept-from-vapoursage types lifted verbatim; standalone-app types
// (Project, VideoFile, Directory, ProcessingPreset, ProcessingJob, UserProfile, BatchPlan)
// dropped per the v2.0 plan.

import type { LucideIcon } from 'lucide-react';

// ----- Kept from vapoursage -----

export interface LogEntry {
    timestamp: string;
    type: 'info' | 'error' | 'success' | 'warn' | 'runtime';
    message: string;
}

export interface Attachment {
    name: string;
    mimeType: string;
    content: string;
    type: 'image' | 'text';
}

// Discriminated chain-edit operations. The Archivist proposes these via the
// propose_chain_edit tool; the renderer applies them.
export type ChainOperation =
    | { op: 'add';    step: ChainStep }
    | { op: 'update'; targetId: string; patch: Partial<ChainStep> & { params?: Record<string, unknown> } }
    | { op: 'remove'; targetId: string };

export interface ChatMessage {
    id: string;
    role: 'user' | 'assistant' | 'system';
    text: string;
    timestamp: string;
    /** Marks a synthetic message produced by auto-compaction so the UI can style it
     *  differently from a real Archivist reply. Set when the message is the summary
     *  inserted by services/compactor. */
    kind?: 'compaction';
    pendingAction?:
        | { type: 'CONFIRM_CHAIN_EDIT'; operations: ChainOperation[]; explanation?: string }
        | { type: 'APPLIED';   appliedAt: string }     // post-Apply receipt — replaces the card
        | { type: 'DISMISSED'; dismissedAt: string };  // post-Dismiss receipt
    attachments?: Attachment[];
}

export type LLMProviderId =
    | 'anthropic' | 'openai' | 'google' | 'openrouter' | 'xai' | 'lmstudio' | 'ollama';

export interface LLMModel {
    /** Namespaced id used everywhere in the UI + IPC: `<provider>/<apiModelId>` */
    id: string;
    name: string;
    provider: LLMProviderId;
    icon: LucideIcon;
    /** True ONLY where the app's tool-use loop is implemented (Anthropic
     *  today). Text-only models can propose edits as prose but CANNOT be
     *  claimed to have changed a chain. */
    toolLoop?: boolean;
    /** Model availability has NOT been live-tested through this app.
     *  Cloud IDs may be docs-checked; local IDs are static examples, not
     *  discovered loaded models. A saved key is not proof of availability. */
    unverified?: boolean;
}

export interface ProviderCatalogEntry {
    label: string;
    type: 'anthropic' | 'openai' | 'google' | 'ollama';
    needsApiKey: boolean;
    keychainAccount: string | null;
    defaultEndpoint: string | null;
    supportsTools: boolean;
    models: Array<{ id: string; name: string }>;
}

export interface PluginDefinition {
    namespace: string;
    name: string;
    version: string;
    description: string;
    essential: boolean;
}

export interface RuntimeManifest {
    coreVersion: string;
    pythonVersion: string;
    architecture: 'x64' | 'arm64';
    bundledPlugins: PluginDefinition[];
    bundledScripts: string[];
}

export interface RuntimePathInfo {
    path: string;
    exists: boolean;
}

export interface RuntimeHealth {
    python: RuntimePathInfo;
    ffmpeg: RuntimePathInfo;
    ffprobe: RuntimePathInfo;
    vs: RuntimePathInfo;
    platform: string;
    gpu: string;
}

// ----- New in v2.0 -----

export type FilterStage =
    | 'preprocess' | 'field-ops' | 'crop' | 'denoise' | 'restore'
    | 'sharpen' | 'frame-ops' | 'resize' | 'format';

// Stage numeric values mirror common/filters/filter.h.
export const StageNumber: Record<FilterStage, number> = {
    'preprocess': 10,
    'field-ops':  20,
    'crop':       30,
    'denoise':    40,
    'restore':    50,
    'sharpen':    60,
    'frame-ops':  70,
    'resize':     80,
    'format':     90,
};

// Human-readable display names for each canonical stage. Used by the chain
// editor + pipeline panel so the user sees "Field Ops" instead of "stage 20".
export const StageDisplayName: Record<FilterStage, string> = {
    'preprocess': 'Preprocess',
    'field-ops':  'Field Ops',
    'crop':       'Crop',
    'denoise':    'Denoise',
    'restore':    'Restore',
    'sharpen':    'Sharpen',
    'frame-ops':  'Frame Ops',
    'resize':     'Resize',
    'format':     'Format',
};

/** Reverse lookup: 20 → "Field Ops" · 50 → "Restore" · unknown → "stage N" */
export function stageLabelForNumber(n: number): string {
    for (const [key, num] of Object.entries(StageNumber)) {
        if (num === n) return StageDisplayName[key as FilterStage];
    }
    return `stage ${n}`;
}

export interface ChainStep {
    id: string;
    type: string;
    stage: number;
    enabled: boolean;
    /** Per-link approval gate. The Archivist auto-pushes new scripts to the
     *  chain (autoApply default-on at the chat level), but each link starts
     *  unapproved — the user reviews the script, then clicks Approve to mark
     *  it live. APPROVAL BINDS CONTENT (security re-review 2026-11-05): the
     *  Approve click stores the step's exact executable body in
     *  `approvedContent`, and BOTH composers emit Python only for steps where
     *  enabled && approved && approvedContent still equals the emitted body
     *  byte-for-byte (see shared/draft-composer isStepApproved). A stale flag
     *  on edited content never runs; a missing binding never approves (legacy
     *  chains fail closed and must be re-approved). New steps — library,
     *  Archivist, model, recipe import — enter approved=false. */
    approved?: boolean;
    /** The exact executable body the approval was granted for. Not portable:
     *  recipe import and model operations never carry it; only an explicit
     *  user Approve click in the destination editor sets it. */
    approvedContent?: string | null;
    version: number;
    params: Record<string, unknown>;
}

export interface ColorManagement {
    inputColorSpace: string;
    inputGamma: string;
    outputColorSpace: string;
    outputGamma: string;
    ocioConfig: string;
}

export interface ArchivistState {
    panelOpen: boolean;
    panelWidth: number;
    selectedModelId: string;
    thinkingMode: boolean;
    autoApply: boolean;  // when true, proposed chain edits apply without the Confirm card
    messages: ChatMessage[];
}

// Clip metadata has two layers and we keep them separate so the Archivist can tell
// the difference (and so the UI can show "source-native" badges where appropriate).
//
//   - `timeline` is what Resolve delivers to the OFX plugin — i.e. the timeline-
//     conformed dimensions/fps/etc. Auto-captured by the C++ side from the OFX clip
//     API on every Configure click. A 720×480 source on a 1920×1080 timeline shows
//     1920×1080 here, because Resolve scales/conforms BEFORE passing frames to OFX.
//
//   - `source` is the actual source file's native properties from ffprobe. Only
//     present after the user identifies the source file once (drag-drop or picker).
//     Auto-re-probed on every subsequent Configure click while the file still exists.

export interface TimelineClipMetadata {
    width: number | null;
    height: number | null;
    fps: number | null;
    pixelAspectRatio: number | null;
    fieldOrder: string | null;        // tt | bb | progressive | interlaced | unknown
    pipelineBitDepth: string | null;  // 8-bit / 16-bit int / 32-bit float
    frameCount: number | null;
    duration: number | null;          // seconds
    sampleAspectRatio: string | null;
    displayAspectRatio: string | null;
    capturedAt: string;               // ISO timestamp
}

export interface SourceVideoMetadata {
    codec: string | null;
    codecTag: string | null;
    width: number | null;
    height: number | null;
    fps: number | null;
    rFps: string | null;          // raw "30000/1001" — useful for IVTC detection
    bitDepth: number | null;
    pixelFormat: string | null;
    colorSpace: string | null;
    colorPrimaries: string | null;
    colorTransfer: string | null;
    colorRange: string | null;
    /** Field order as the container metadata claims it. Can be wrong! e.g. a DV
     *  source transcoded to a progressive-flagged ProRes still has interlaced
     *  content. Compare against `detectedScanType` for ground truth. */
    fieldOrder: string | null;
    sampleAspectRatio: string | null;
    displayAspectRatio: string | null;
    chromaLocation: string | null;
    frameCount: number | null;
    duration: number | null;
    bitRate: number | null;
    /** Field-detection result from ffmpeg -vf idet on a 120-frame sample.
     *  "tt" / "bb" / "progressive" / "undetermined". This is what the pixels
     *  actually look like, regardless of what the container metadata claims. */
    detectedScanType?: 'tt' | 'bb' | 'progressive' | 'undetermined' | null;
    scanConfidence?: number | null;
    scanBreakdown?: {
        tff: number; bff: number; progressive: number; undetermined: number; total: number;
    } | null;
    /** MediaInfo CLI output. Distinct from ffprobe in that it separates scan type
     *  (Progressive/Interlaced/MBAFF/PAFF) from scan order (TFF/BFF), and exposes
     *  the "original" provenance metadata — what the source material was BEFORE
     *  any encoding. Only present if MediaInfo is installed on the system. */
    mediainfo?: {
        scanType: string | null;          // Interlaced | Progressive | MBAFF | PAFF
        scanOrder: string | null;         // TFF | BFF
        scanTypeOriginal: string | null;
        scanOrderOriginal: string | null;
        format: string | null;
        formatProfile: string | null;
        codecId: string | null;
    } | null;
}

export interface SourceAudioMetadata {
    codec: string | null;
    channels: number | null;
    channelLayout: string | null;
    sampleRate: number | null;
    bitRate: number | null;
    bitDepth: number | null;
}

export interface SourceClipMetadata {
    filePath: string;
    fileName: string;
    probedAt: string;
    container: string | null;
    formatName: string | null;
    duration: number | null;
    bitRate: number | null;
    sizeBytes: number | null;
    video: SourceVideoMetadata | null;
    audio: SourceAudioMetadata | null;
    /** Set when an auto-reprobe found the file missing — UI shows "file moved?"
     *  rather than treating the stale data as fresh. */
    fileMissing?: boolean;

    // ----- TKT-SRC: source-resolution restoration pipeline -----
    //
    // The chain can operate on source-native pixels (loaded via
    // core.lsmas.LWLibavSource) instead of Resolve's timeline-conformed frames.
    // These fields support the file-integrity check + frame-mapping path that
    // makes that safe. Design notes live in the repository's planning docs
    // (docs/ + docs/timing-contract.md).

    /** blake2b-512 hex digest of (first 1 MB + last 1 MB + size) of the source
     *  file at probe time. Catches the "same path, different content" footgun
     *  that a stat() check misses. */
    sourceHash?: string | null;
    /** File size at probe time (bytes). Cheap pre-hash invalidation signal —
     *  if the size changed we know we don't need to bother re-hashing to fail. */
    sourceSize?: number | null;
    /** mtime at probe time (ms epoch). Same purpose as sourceSize. */
    sourceMtimeMs?: number | null;

    /** Source-mode in-point (source frame # corresponding to Resolve clip
     *  in-point). Required when the Resolve clip is trimmed — i.e. clip range
     *  on timeline < source total frames. User enters via ClipInfoBar or the
     *  Archivist proposes via Resolve scripting API. Untrimmed clips: 0. */
    sourceInPoint?: number | null;
    /** Source-mode out-point. Untrimmed clips: source.video.frameCount - 1. */
    sourceOutPoint?: number | null;
    /** Set when a retime curve / speed effect is detected on the Resolve clip.
     *  When true, source-mode is disabled — frame math through retimes is too
     *  fragile per the TKT-SRC council deliberation. The popout banner shows
     *  an explicit "source-mode disabled (retime curve)" warning. */
    retimeDetected?: boolean;

    raw?: unknown;
}

export interface ClipMetadata {
    timeline?: TimelineClipMetadata;
    source?: SourceClipMetadata;
}

export interface NodeConfig {
    schemaVersion: number;
    nodeId: string;
    /** Stable per-node identity, host-generated and persisted in the OFX
     *  _config JSON. Keys per-node history/sidecars; survives project
     *  save/reopen. Absent on legacy configs (host regenerates). */
    nodeGuid?: string;
    manualOrder: boolean;
    colorManagement: ColorManagement;
    chain: ChainStep[];
    mix: number;
    clipMetadata?: ClipMetadata;
    archivist: ArchivistState;
}

// ----- Electron bridge surface -----

/** Curated optional-model registry entry (electron/shared/model-registry.json). */
export interface ModelRegistryEntry {
    id: string;
    label: string;
    purpose: string;
    publisher: string;
    version: string;
    source: string;
    asset: string;
    sha256: string;
    downloadBytes: number;
    diskBytesNeeded: number;
    archiveFormat: string;
    compatibleBackend: string;
    /** Honest license flag — NOT legal clearance. */
    licenseStatus: string;
    recommended?: boolean;
    recommendationNote?: string;
    /** Lifecycle: absent → downloading → downloaded → ready (+ failed). */
    state?: 'absent' | 'downloading' | 'interrupted' | 'downloaded' | 'ready' | 'failed';
    /** Failed-entry diagnostics supplied by the backend's path/lifecycle checks. */
    error?: string;
    recovery?: string;
    /** Explicit permission to offer scope-confirmed discard for a failed entry. */
    canDiscard?: boolean;
    installedDir?: string | null;
    /** MEASURED on-disk size of the installed model directory. */
    installedBytes?: number | null;
    /** Estimated temporary headroom needed during extraction. */
    tempBytesNeeded?: number | null;
    /** Separately retained custody; informational, not cleanup or rollback authority. */
    retainedStorage?: {
        status: 'retained' | 'pending' | 'held';
        path: string;
        bytes: number | null;
        note: string;
    };
}

export interface ModelProgressPayload {
    id: string;
    received?: number;
    total?: number;
    fraction?: number | null;
    phase?: 'downloading' | 'verifying';
    done?: boolean;
    ok?: boolean;
}

export interface ApplyConfigResult {
    ok: boolean;
    /** Companion file-write observation only; no native apply/render acknowledgement. */
    writePhase?: 'no-host-path' | 'not-attempted' | 'editor-only' | 'unconfirmed' | 'write-reported';
    closeScheduled?: boolean;
    error?: string;
    note?: string;
}

export interface EditorConfigurationResult {
    ok: boolean;
    mode?: 'host' | 'host-manual' | 'standalone';
    note?: string;
    config?: Partial<NodeConfig> | null;
    error?: string;
}

declare global {
    interface Window {
        electron?: {
            executeScript: (script: string) => void;
            onLog: (cb: (log: LogEntry) => void) => () => void;
            onComplete: (cb: (result: { code: number, error?: string }) => void) => () => void;
            windowControl: (action: 'window-min' | 'window-max' | 'window-close') => void;
            selectDirectory: () => Promise<string | null>;
            checkRuntime: () => Promise<RuntimeHealth>;
            platform: string;
            revealFile: (path: string) => void;

            // v2.0 additions (Phase 1 wires the main-process side)
            syncFromHost?: (cb: (config: NodeConfig) => void) => () => void;
            getEditorConfiguration?: () => Promise<EditorConfigurationResult>;
            editorHeartbeat?: () => Promise<boolean>;
            requestFrame?: (timecode: number) => Promise<unknown /* IOSurface handle */>;
            // Sends the chain JSON to the OFX-side PreviewService, polls for the
            // resulting PNG to update, returns either { ok, path, mtime } or { ok: false, error }.
            previewChain?: (chain: string | object, mix: number, timecode?: number)
                => Promise<{ ok: boolean; path?: string; mtime?: number; error?: string }>;
            readPreviewImage?: () => Promise<{ ok: boolean; dataUrl?: string; bytes?: number; error?: string }>;
            /** Write the config to the OFX side. `options.close=false` (default true)
             *  skips the auto-close so the popout stays open — used by the live
             *  auto-sync that fires on every chain edit. Apply and close requests
             *  close=true. The reply does not confirm Resolve processing. */
            applyConfig?: (config: NodeConfig, options?: { close?: boolean }) => Promise<ApplyConfigResult>;
            getClipMetadata?: () => Promise<{
                width: number; height: number; fps: number;
                isInterlaced: boolean; colorSpace: string;
            }>;

            // Render queue (beta-batch): sequential renders of composed chains
            // on the bundled runtimes. Trust-gated to this window in main.js.
            renderQueueAdd?: (request: { nodeGuid?: string; scriptPath?: string; outputPath: string; encoder?: string; overwrite?: boolean; label?: string })
                => Promise<{ ok: boolean; id?: string; error?: string }>;
            renderQueueList?: () => Promise<{ ok: boolean; jobs?: RenderQueueJob[]; encoders?: Record<string, { label: string; extension: string }>; error?: string }>;
            renderQueueCancel?: (id: string) => Promise<{ ok: boolean; cancelling?: boolean; error?: string }>;
            renderQueueRemove?: (id: string) => Promise<{ ok: boolean; error?: string }>;
            renderQueueClear?: () => Promise<{ ok: boolean; removed?: number; error?: string }>;
            renderQueueChooseOutput?: (request: { encoder?: string; defaultPath?: string })
                => Promise<{ ok: boolean; path?: string; cancelled?: boolean; error?: string }>;
            onRenderQueueEvent?: (cb: (event: unknown) => void) => (() => void) | undefined;

            // Multi-vendor Settings IPC (TKT-A5)
            listProviders?: () => Promise<Record<string, ProviderCatalogEntry>>;
            hasApiKey?: (providerId: string)
                => Promise<{ hasKey: boolean; masked: string | null }>;
            setApiKey?: (providerId: string, key: string) => Promise<{ ok: boolean }>;
            listConfiguredProviders?: () => Promise<string[]>;
            getEndpoint?: (providerId: string) => Promise<string | null>;
            setEndpoint?: (providerId: string, url: string) => Promise<{ ok: boolean }>;

            // Source-clip identification + ffprobe
            pickClipFile?: () => Promise<{ ok: boolean; filePath?: string; canceled?: boolean }>;
            /** Resolve an opted-in File object in preload; no general filesystem lookup. */
            getDroppedFilePath?: (file: File) => string;
            probeClip?: (filePath: string)
                => Promise<{ ok: boolean; metadata?: SourceClipMetadata; error?: string; missing?: boolean }>;

            // OFX-side render status — populated by the plugin every render. The popout
            // polls this and surfaces state / error in a banner so the user knows when
            // the chain is actually running vs falling back to passthrough.
            readPluginStatus?: () => Promise<{
                ok: boolean;
                status?: {
                    state: 'idle' | 'passthrough' | 'chain-empty' | 'chain-ok' | 'chain-error';
                    error: string | null;
                    scriptPreview: string;
                    stepCount: number;
                    timestampMs: number;
                };
                error?: string;
            }>;

            // Install/Update the OFX plugin for Resolve (bundled vsres-install helper).
            pluginInstall?: (action: 'status' | 'install' | 'uninstall') => Promise<unknown>;

            // Ask the running DaVinci Resolve (via its Python scripting API) for the
            // file path of the clip at the current playhead. Zero-gesture auto-discovery
            // when the user has enabled scripting in Resolve preferences.
            queryCurrentClip?: () => Promise<{
                ok: boolean;
                filePath?: string;
                fileName?: string;
                clipName?: string;
                resolution?: string;
                fps?: string;
                duration?: string;
                fieldDominance?: string;
                codec?: string;
                audioCodec?: string;
                pixelAspect?: string;
                colorSpace?: string;
                gamma?: string;
                /** Source-media frame bounds of the playhead clip's trim handles
                 *  (Resolve GetSourceStartFrame/GetSourceEndFrame). Absent when
                 *  the scripting API doesn't expose them. */
                sourceInPoint?: number;
                sourceOutPoint?: number;
                /** True when the clip carries a speed retime (GetSpeed
                 *  Percentage ≠ 100) — source-mode must fall back to the OFX
                 *  clip because frame mapping is non-linear. */
                retimeDetected?: boolean;
                /** Source-discovery HELPER failure (crash/kill/non-JSON) —
                 *  distinct from scriptingDisabled ('no clip'): the helper
                 *  process itself failed; the manual Identify path stays
                 *  usable. Live case: Fusion-side SIGSEGV in
                 *  fusionscript.so, Oct 27. */
                helperFailed?: boolean;
                /** Source discovery exceeded its bounded timeout. */
                discoveryTimeout?: boolean;
                error?: string;
                notInstalled?: boolean;
                scriptingDisabled?: boolean;
                scriptingUnavailable?: boolean;
            }>;
            /** ACTUALLY registered VapourSynth namespaces (runtime probe of
             *  the same evaluation environment the chain renders in). The
             *  static manifest is a guide; this is the truth the Filter
             *  Library badges and Archivist manifest reconcile against. */
            probeNamespaces?: () => Promise<{
                ok: boolean;
                namespaces?: string[];
                probedAt?: number;
                error?: string;
            }>;
            /** Companion chain preview: render one frame of the HOST'S
             *  composed script (last-composed.vpy) — the exact script the
             *  node evaluates in Resolve. mode: 'processed' (chain result)
             *  or 'source' (pre-chain A/B). Carries the frame index + totals
             *  so stale responses are dropable by sequence. */
            renderPreviewFrame?: (request: {
                frame?: number;
                /** Presentation time in seconds — takes precedence over frame.
                 *  Each mode resolves time via its OWN evaluated fps so A/B
                 *  compares the same moment even when the chain changes
                 *  cadence (QTGMC/BlockFPS/RIFE). */
                time?: number;
                mode?: 'processed' | 'source';
                /** Probe sampleAspectRatio (e.g. '4:3') applied to source mode
                 *  so A/B shares display geometry. */
                sar?: string;
                /** Stable node identity — the host's per-node composed script
                 *  is preferred so previews never cross nodes. */
                nodeGuid?: string;
                /** DRAFT mode: the CURRENT editor chain composed by the
                 *  renderer through shared/draft-composer (exact native
                 *  mirror). Present = draft preview (live WYSIWYG, never
                 *  claimed as applied); absent = accepted-chain preview. */
                draftScript?: string;
                scopes?: boolean;
                /** RGB analysis convention for scopes: the node's configured
                 * input matrix (e.g. '709') — the CONTROLLED assumption for
                 * sources with unspecified _Matrix. */
                analysisMatrix?: string;
                /** Metrics-only refreshes ride a SEPARATE worker process so
                 * heavy scope renders never block playback frames. */
                metricsWorker?: boolean;
                /** Explicit positive preview budgets; omitted uses documented app defaults. */
                timeoutMs?: number;
                maxOutputBytes?: number;
                /** Full-size encoded PNG acceptance budget; no geometry clamp. */
                maxPngBytes?: number;
            }) => Promise<{
                ok: boolean;
                frame?: number;
                total?: number;
                fpsNum?: number;
                fpsDen?: number;
                durationS?: number | null;
                presentationTimeS?: number | null;
                width?: number;
                height?: number;
                dataUrl?: string;
                /** Native-depth scope metrics payload (see ScopesPanel.ScopePayload). */
                scopes?: unknown;
                /** Display-conversion assumption label ('709' when a prop-less
                 * clip forced the fallback — labeled, never silent). */
                displayMatrixAssumed?: string | null;
                /** 'draft' | 'host' | 'host-legacy' — what produced this frame. */
                provenance?: string;
                error?: string;
                timeout?: boolean;
                outputLimit?: boolean;
                pngOutputLimit?: boolean;
                protocolError?: boolean;
                closureKnown?: boolean;
                closureUnknown?: boolean;
                noAutomaticReplay?: boolean;
                selfcheck?: boolean;
                capabilityUnknown?: boolean;
                reason?: string;
                superseded?: boolean;
            }>;
            /** Read the host's composed script (last-composed.vpy) — the
             *  exact script text the node evaluates on every render. Empty
             *  string before the first render. */
            /** Read the host's composed script for THIS node (nodeGuid-keyed
             *  per-node copy preferred; the global file is a legacy
             *  fallback). Empty string before the first render. */
            readComposedScript?: (request?: { nodeGuid?: string }) => Promise<string>;
            /** Optional neural-model manager: curated registry with pinned
             *  upstream assets, explicit cancellable downloads, sha256
             *  verification, 7z extraction (detected, never downloaded
             *  installers), and honest lifecycle states. */
            listModels?: () => Promise<{
                ok: boolean; models?: ModelRegistryEntry[]; extractionAvailable?: boolean;
            }>;
            /** ONE authoritative neural-capability snapshot (Models UI, chat
             *  tools and app reference all read this). Level ladder:
             *  weights → adapter → backend → load → inference. "usable" is
             *  true ONLY at inference-verified. */
            neuralCapability?: () => Promise<{
                ok: boolean;
                rife?: {
                    level: 'weights' | 'adapter' | 'backend' | 'load' | 'inference';
                    usable: boolean;
                    detail: string;
                    backend?: string | null;
                    model?: string | null;
                };
            }>;
            downloadModel?: (request: { id: string }) => Promise<{
                ok: boolean; cancelled?: boolean; error?: string; models?: ModelRegistryEntry[];
            }>;
            /** Optional operational budgets are validated by the backend. */
            extractModel?: (request: { id: string; timeoutMs?: number; maxOutputBytes?: number;
                stageTimeoutMs?: number; stageHeadroomBytes?: number; stageMaxEntries?: number;
                stageMaxDepth?: number; stageMaxManifestBytes?: number }) => Promise<{
                ok: boolean; error?: string;
                closureKnown?: boolean; cleanupUnconfirmed?: boolean; noAutomaticReplay?: boolean;
                notStarted?: boolean; reason?: string; stopError?: string | null;
            }>;
            cancelModelDownload?: (request: { id: string }) => Promise<{ ok: boolean }>;
            removeModel?: (request: { id: string }) => Promise<{
                ok: boolean; models?: ModelRegistryEntry[];
                removed?: { dir: string; fileCount: number; bytes: number };
                error?: string;
            }>;
            /** Read-only preview of exactly what removal would delete
             *  (this model's directory only) — for the confirm UI. */
            describeModelRemoval?: (request: { id: string }) => Promise<{
                ok: boolean; dir?: string; fileCount?: number; bytes?: number; error?: string;
            }>;
            onModelProgress?: (handler: (payload: ModelProgressPayload) => void) => (() => void) | undefined;
            /** Save a text file via the OS save dialog (chat export). Only
             *  user-initiated; writes exactly the provided contents. */
            saveTextFile?: (request: {
                defaultName: string;
                contents: string;
            }) => Promise<{ ok: boolean; error?: string; path?: string }>;
            /** Read a text file the user chose (recipe import). */
            openTextFile?: () => Promise<{ ok: boolean; canceled?: boolean; contents?: string; path?: string; error?: string }>;
            /** Native-menu shortcut events (Cmd+W → toggle-ab). Returns an unsubscribe. */
            onShortcut?: (callback: (payload: { name: string }) => void) => () => void;
            /** Portable, identity-free recipe store (chain-only). */
            listRecipes?: () => Promise<{ ok: boolean; recipes?: { name: string; slug: string; stepCount: number }[] }>;
            saveRecipe?: (request: { payload: unknown; fallbackName?: string }) => Promise<{
                ok: boolean; path?: string; recipe?: { name: string; chain: unknown[] }; error?: string;
            }>;
            loadRecipe?: (request: { slug: string }) => Promise<{
                ok: boolean; recipe?: { schemaVersion: number; name: string; chain: unknown[];
                    colorManagement?: unknown; mix?: number; manualOrder?: boolean }; error?: string;
            }>;
            deleteRecipe?: (request: { slug: string }) => Promise<{ ok: boolean; error?: string }>;
        };
    }
}

export interface RenderQueueJob {
    id: string;
    state: string;
    encoder: string;
    outputPath: string;
    label?: string;
    progress?: { frame: number; total: number; percent: number } | null;
    error?: string | null;
    bytes?: number;
}
