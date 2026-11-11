#pragma once

// Per-OFX-instance VapourSynth runtime state.
//
// Owns a VSCore + VSScript + the output VSNode. Caches the parsed script so we don't reparse
// per frame — replicates the (script, dims, depth) cache from the v1.x Windows plugin at
// platform/windows/src/VapourSynthPlugin.cpp:175-247, with two changes:
//   - float32 RGBA only (drop the 16-bit int branch)
//   - the cache key includes the entire chain JSON, not just user code, so changes to
//     enabled/disabled steps, stage order, or color management invalidate cleanly.

#include "ofxsImageEffect.h"

#include <VapourSynth4.h>
#include <VSScript4.h>

#include <atomic>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

namespace vsres::macos {

struct VsRuntimeConfig {
    OFX::Clip* source_clip = nullptr;
    int width = 0;
    int height = 0;
    int radius = 0;       // temporal window
    int min_frame = 0;    // OFX clip frame range min
    int max_frame = 0;    // OFX clip frame range max (inclusive)
};

class VsRuntime {
public:
    VsRuntime();
    ~VsRuntime();

    // Reconfigures iff (cache_key, dims, radius) changed. Returns true on success;
    // populates last_error_ on failure (call last_error() to inspect).
    bool open(const std::string& cache_key,
              const std::string& vs_script,
              const VsRuntimeConfig& config);

    // Fetches a rendered frame at the given clip-time index. Caller owns the result and
    // must release with the_api->freeFrame(frame).
    const VSFrame* get_frame(int frame_index, std::string* out_error);

    // C06 (2026-11-11): cadence/length of the CURRENTLY OPEN graph (-1 when
    // not open). Set on every successful open() and cache restore; the host's
    // timing-contract enforcement reads these.
    std::int64_t output_fps_num() const { return cached_fps_num_; }
    std::int64_t output_fps_den() const { return cached_fps_den_; }
    std::int64_t output_num_frames() const { return cached_num_frames_; }

    // Current OFX render output frame. The clip-mode OFX source uses it as the
    // fallback fetch target when a temporal filter requests a frame Resolve
    // refuses (outside the window getFramesNeeded declared): fetching the
    // nearest in-window frame keeps the chain rendering instead of erroring
    // the whole graph. Called from the render thread; cheap atomic store.
    void set_center_frame(int frame) { center_frame_.store(frame, std::memory_order_relaxed); }

    const std::string& last_error() const { return last_error_; }
    bool is_open() const { return node_ != nullptr; }

    // True when open() with these inputs would be a cache hit (no script
    // re-evaluation). Lets callers skip courtesy progress UI when the open
    // will be instant. Covers both the active graph and retired ones: the
    // host asks for several render sizes in an interleaved pattern (viewer,
    // thumbnails, UI tiles); a single active-slot cache thrashes and pays
    // a full script re-evaluation (~seconds) on every alternation. Retired
    // graphs are restored without re-parsing.
    bool is_cached(const std::string& cache_key, const VsRuntimeConfig& cfg) const {
        if (is_open()
            && cached_key_ == cache_key
            && cached_width_ == cfg.width
            && cached_height_ == cfg.height
            && cached_radius_ == cfg.radius) {
            return true;
        }
        for (const OpenEntry& e : open_cache_) {
            if (e.key == cache_key
                && e.width == cfg.width
                && e.height == cfg.height
                && e.radius == cfg.radius) {
                return true;
            }
        }
        return false;
    }

private:
    // One fully-opened (core, script, node) graph retired from active duty.
    // All three pointers are owned; freeScript releases the core with it.
    struct OpenEntry {
        std::string key;
        int width = -1;
        int height = -1;
        int radius = -1;
        // C06 (2026-11-11): the graph's own output cadence/length — the host
        // enforces the timing contract from these after a cache restore too.
        std::int64_t fps_num = -1;
        std::int64_t fps_den = -1;
        std::int64_t num_frames = -1;
        VSCore* core = nullptr;
        VSScript* script = nullptr;
        VSNode* node = nullptr;
    };
    void teardown();
    // Frees the active graph only. Retired entries stay alive for restore.
    // Frees active + every retired entry (destructor path).
    void teardown_all();
    // Moves the active graph into the retired cache (bounded, FIFO eviction
    // from the back) without freeing it, and clears the active members.
    void retire_active_bounded();
    // Finds a retired graph matching (key, dims, radius), retires the
    // current active one, and adopts the match as active. No re-parse.
    bool restore_from_cache(const std::string& cache_key, const VsRuntimeConfig& cfg);

    const VSAPI*       api_ = nullptr;
    const VSSCRIPTAPI* sapi_ = nullptr;
    VSCore*  core_   = nullptr;  // Owned by script_ when open
    VSScript* script_ = nullptr;
    VSNode*  node_   = nullptr;

    std::string cached_key_;
    int cached_width_ = -1;
    int cached_height_ = -1;
    int cached_radius_ = -1;
    // C06 (2026-11-11): cadence/length of the currently open graph.
    std::int64_t cached_fps_num_ = -1;
    std::int64_t cached_fps_den_ = -1;
    std::int64_t cached_num_frames_ = -1;

    // Retired-but-alive graphs, most recent first. The host interleaves
    // render sizes; keeping the last few open avoids a full script
    // re-evaluation on every size alternation. Bounded: eviction frees.
    std::vector<OpenEntry> open_cache_;
    static constexpr size_t kMaxCachedEntries = 3;

    // Failure-cache fingerprint. When evaluateBuffer fails we record the
    // exact (script, dims, radius) tuple that produced the error here so a
    // subsequent open() call with the SAME inputs short-circuits to the
    // cached error instead of re-parsing the same bad script and re-logging
    // the same traceback for every single frame Resolve asks us to render.
    // Cleared when teardown() runs.
    std::string failed_key_;
    int failed_width_ = -1;
    int failed_height_ = -1;
    int failed_radius_ = -1;

    std::atomic<int> center_frame_{0};

    std::string last_error_;
};

}  // namespace vsres::macos
