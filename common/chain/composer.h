#pragma once

// Chain composer — JSON chain config -> full VS Python script.
//
// Phase 1: stable-sort steps by Stage (unless manual_order is true), thread filter fragments,
// wrap with color management input/output transforms and master-mix Merge.

#include "../color/color.h"
#include "../filters/filter.h"
#include <string>
#include <vector>

namespace vsres {

struct ChainStep {
    std::string id;
    std::string type;     // matches IFilter::type_id()
    int stage;            // declared per-step (lets Script override its stage)
    bool enabled;
    /** Per-link approval gate. The composer emits Python ONLY for steps where
     *  enabled && approved && approved_content matches the step's CURRENT
     *  emitted executable body. Approval BINDS THE EXECUTABLE CONTENT
     *  (security re-review 2026-11-05): a stale approval flag on changed
     *  content never runs. Missing/false approval or a missing/mismatched
     *  binding is NOT approved — legacy chains saved before the binding
     *  existed must be re-approved in the companion (fail closed). */
    bool approved = false;
    int version;
    std::string params_json;
    /** The exact executable body (the filter fragment's `body`) the approval
     *  was granted for. Empty = never approved. Compared byte-for-byte
     *  against the freshly emitted body at composition and status time. */
    std::string approved_content;
};

// TKT-SRC: source-mode state machine. Determines which input the chain runs on.
//
// Disabled     — current behavior. VS pulls frames from the OFX clip via the
//                ofx_source_get_frame callback. Frames are timeline-conformed
//                (already upscaled by Resolve). Temporal filters that need
//                frames outside the getFramesNeeded window will fail with
//                "OFX source clip returned no image" — this is the QTGMC
//                mv.Super-first-frame bug.
// Active       — chain emits `src = core.lsmas.LWLibavSource(filepath)`.
//                VS has direct disk access; mv.Super and other whole-clip
//                temporal filters work. Clip range matches source range
//                (no in/out trimming in Resolve). Final output transform
//                scales to timeline dims via core.resize.Spline36.
// ActiveTrimmed — Active + an explicit core.std.Trim to the user-specified
//                in/out points. Used when clip_range != source_total_frames.
// RetimeDisabled — retime curve detected on the Resolve clip. Source-mode
//                cannot handle non-1:1 frame mappings reliably. Falls back
//                to Disabled with a loud popout-banner warning.
// FileMissing   — source.filePath doesn't exist. Render returns the red
//                "SOURCE MISSING" error frame instead of falling back.
// FileChanged   — source file's hash no longer matches what was probed.
//                Same behavior as FileMissing — error frame, force user to
//                re-link.
enum class SourceMode {
    Disabled,
    Active,
    ActiveTrimmed,
    RetimeDisabled,
    FileMissing,
    FileChanged,
};

struct SourceModeConfig {
    SourceMode mode = SourceMode::Disabled;
    // Absolute path to the source file. Quoted into the emitted Python.
    std::string source_file_path;
    // Probe fingerprints recorded by the companion at identification time
    // (chunk-hash probe). Negative = not recorded → no change detection.
    // plugin_entry stats the file and compares to decide FileChanged; a
    // changed file invalidates the recorded trim mapping and frame counts.
    int64_t source_size = -1;
    int64_t source_mtime_ms = -1;
    // Trim window for ActiveTrimmed (0-indexed source frame numbers).
    // -1 = not recorded by the companion → treat as untrimmed (Active).
    // plugin_entry decides ActiveTrimmed vs Active from these sentinels.
    int source_in_point = -1;
    int source_out_point = -1;
    // Timeline dimensions for the final upscale in source-mode. We pass these
    // through because the source is at its native dims (e.g. 720x480) but
    // Resolve expects timeline dims (e.g. 1920x1080) back.
    int timeline_width = 0;
    int timeline_height = 0;
    // Human-readable reason exposed to the popout status banner. Empty when
    // mode == Disabled / Active / ActiveTrimmed.
    std::string fallback_reason;
};

struct Chain {
    int schema_version = 1;
    std::string node_id;
    // Stable per-instance identity, HOST-GENERATED once and persisted inside
    // the OFX _config JSON (so it survives project save/reopen and travels
    // with the param on host-side undo). Not the UI label — that's node_id.
    // Empty only for configs created by older builds (host regenerates).
    std::string node_guid;
    bool manual_order = false;
    ColorManagement color;
    std::vector<ChainStep> steps;
    float mix = 1.0f;
    SourceModeConfig source_mode;
};

// Parses a `_config` JSON blob into a Chain.
Chain parse_chain(const std::string& config_json);

// Serializes a Chain back to compact JSON for `_config`.
std::string serialize_chain(const Chain& chain);

// Gate accounting for a composition pass (or a status probe). `emitted` is
// the number of steps the composer actually writes into the script:
// enabled + approved + content-bound + registered filter.
struct ComposeStats {
    int total = 0;      // all steps
    int enabled = 0;    // enabled steps (whatever their approval state)
    int emitted = 0;    // enabled + approved + binding matches + filter known
    int unapproved = 0; // enabled, filter known, but not approved / binding stale
    int unknown = 0;    // enabled but no registered filter type
};

// Composes the final VS Python script from a Chain + the active StepContext.
// When `stats` is non-null it receives the gate accounting for this pass.
std::string compose_script(const Chain& chain, const StepContext& ctx,
                           ComposeStats* stats = nullptr);

// Gate accounting without building the script (for status/preflight surfaces
// that must agree with what compose_script would emit). Same rules, same
// per-step gate; `ctx` only matters if a filter's emission depends on it.
ComposeStats summarize_chain(const Chain& chain, const StepContext& ctx);

}  // namespace vsres
