// Source-mode resolver — mirrors the C++ `decide_source_mode()` in
// platform/macos/host/plugin_entry.cpp so the UI can describe what the chain
// will actually do without round-tripping through the OFX status JSON.
//
// Why duplicate the logic: at the moment the popout is rendering preview /
// banner UI we have the same source metadata the host has — re-deriving the
// mode keeps the React side responsive (no waiting for the next status write)
// and means the subway-map view stays in sync with what's coming out of
// compose_script().
//
// If the resolver disagrees with the host (e.g. host stat() sees a missing
// file the popout's metadata snapshot doesn't know about), the host wins
// silently — render() takes a different path and the resulting status JSON
// will overwrite the optimistic banner state.

import type { SourceClipMetadata } from '../types';

export type ReactSourceMode =
    | 'disabled'           // no source identified → OFX-clip path (current Resolve frames)
    | 'active'             // direct-from-disk via lsmas; full source clip
    | 'active-trimmed'     // direct-from-disk, in/out points applied
    | 'retime-disabled'    // retime curve on the Resolve clip; auto-fallback to OFX clip
    | 'file-missing';      // filePath was set but file is gone; render error frame

export interface SourceModeResolution {
    mode: ReactSourceMode;
    /** True when VS loads the source itself via LWLibavSource. Active / ActiveTrimmed.
     *  When false the chain consumes Resolve's timeline-conformed pixels via the
     *  OFX clip. */
    vsLoadsDirectly: boolean;
    /** Human-readable reason / rationale, shown in the banner + subway-map. */
    rationale: string;
}

export function resolveSourceMode(source: SourceClipMetadata | null | undefined): SourceModeResolution {
    if (!source?.filePath) {
        return {
            mode: 'disabled',
            vsLoadsDirectly: false,
            rationale: 'no source identified — chain reads Resolve\'s timeline-conformed frames via the OFX clip',
        };
    }

    if (source.fileMissing) {
        return {
            mode: 'file-missing',
            vsLoadsDirectly: false,
            rationale: `source file not found at ${source.filePath} — render will produce an error frame (Phase 4)`,
        };
    }

    if (source.retimeDetected) {
        return {
            mode: 'retime-disabled',
            vsLoadsDirectly: false,
            rationale: 'Resolve clip has a retime curve — source-mode disabled (council-recommended fallback to avoid frame-mapping errors)',
        };
    }

    if (source.sourceInPoint != null && source.sourceOutPoint != null) {
        return {
            mode: 'active-trimmed',
            vsLoadsDirectly: true,
            rationale: `source-mode active (trimmed) — VS loads frames ${source.sourceInPoint}..${source.sourceOutPoint} directly via core.lsmas.LWLibavSource`,
        };
    }

    return {
        mode: 'active',
        vsLoadsDirectly: true,
        rationale: 'source-mode active — VS loads the full source clip directly via core.lsmas.LWLibavSource (Resolve timeline frames bypassed)',
    };
}
