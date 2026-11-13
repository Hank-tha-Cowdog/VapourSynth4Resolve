// VapourSynth OFX plugin — macOS Apple Silicon, v2.0 scaffolding.
//
// Phase 0: pass-through filter. Proves the bundle loads in Resolve 21 and that the float32
// RGBA pipeline + Metal render suite handoff works. Phase 1 wires in:
//   - common/chain/composer to build a VS script from the `_config` JSON blob
//   - common/marshal for vDSP-accelerated OFX<->VS pixel transfer
//   - common/color for OCIO transforms
//   - host/popout_launcher.mm for the Configure... button -> Electron app spawn

#include "ofxsImageEffect.h"

#include "../../../common/chain/composer.h"
#include "../../../common/chain/rate_contract.h"
#include "../../../common/filters/filter_registry.h"
#include "../../../common/fs/private_io.h"
#include "../../../common/logging/log.h"

#include "frame_io.h"
#include "popout_launcher.h"
#include "render_overlay.h"
#include "vs_runtime.h"

#include "../../../common/config/config.h"
#include "../../../common/identity/guid.h"
using vsres::identity::valid_node_guid;

#include <VapourSynth4.h>

#include <sys/stat.h>     // stat() for runtime self-check
#include <random>         // node guid generation
#include <dlfcn.h>        // dladdr() for bundle-relative vs-python discovery

#include <dispatch/dispatch.h>

#include <fcntl.h>         // open() for private writes
#include <unistd.h>        // write()

#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <memory>
#include <mutex>

namespace {
// SECURITY (security review #7 remainder, 2026-11-05; hardened 2026-11-11):
// sidecars, per-node configs and composed scripts can carry clip paths,
// code and chat state. The implementation lives in common/fs/private_io so
// it is unit-tested directly: private 0600 modes, O_NOFOLLOW on the opened
// descriptor, hardlink refusal, existing-file mode migration (fchmod) and
// symlink-free parent chains. Callers treat diagnostics/sidecars as
// best-effort, fail-closed.
using vsres::fs::ensure_private_dir;
using vsres::fs::write_private_file;
}  // namespace
#include <string>
#include <unordered_map>
#include <vector>

namespace {

constexpr char kPluginName[]        = "VapourSynth";
constexpr char kPluginGrouping[]    = "VapourSynth OFX";
constexpr char kPluginDescription[] = "VapourSynth filter chain — deinterlace, denoise, restoration "
                                      "and more, configured in the popout.";
constexpr char kPluginIdentifier[]  = "com.vapoursynth.resolveofx";
constexpr unsigned int kPluginVersionMajor = 2;
constexpr unsigned int kPluginVersionMinor = 0;

class VapourSynthPlugin final : public OFX::ImageEffect {
public:
    explicit VapourSynthPlugin(OfxImageEffectHandle handle)
        : ImageEffect(handle)
        , dst_clip_(fetchClip(kOfxImageEffectOutputClipName))
        , src_clip_(fetchClip(kOfxImageEffectSimpleSourceClipName))
        , configure_button_(fetchPushButtonParam("configure"))
        , swap_button_(fetchPushButtonParam("swap"))
        , mix_param_(fetchDoubleParam("mix"))
        , config_param_(fetchStringParam("_config"))
        , status_param_(fetchStringParam("status"))
        , error_param_(fetchStringParam("_errorMessage"))
    {
        vsres::register_builtin_filters();

        // Initialize applied state from the host. Pending companion file edits
        // cannot change it until the explicit host action accepts them.
        std::string restored_config;
        config_param_->getValue(restored_config);
        // NODE GUID: stable per-instance identity, generated ONCE and
        // persisted inside the _config JSON. It survives project save/reopen
        // (Resolve serializes the param) and travels with the param value on
        // host-side undo/redo. Resolve's OFX paste/duplicate copies param
        // VALUES, so a duplicated node initially shares the source's GUID —
        // the first mutation (Apply/accept) regenerates it for the copy, so
        // histories do not stay mixed after the first edit. This fixes the
        // previous scheme where identity was the instance POINTER (changed
        // every process launch and every duplication) and recovery used one
        // global sidecar (cross-node overwrites).
        ensure_node_guid(restored_config);
        store_cached_config(restored_config);
        const size_t param_bytes = restored_config.size();

        // Sidecar policy: DO NOT auto-restore from sidecar on createInstance.
        //
        // The sidecar at ~/Library/Application Support/VapourSynth-OFX/last-config.json
        // is written by apply_popout_result as a recovery snapshot, but reading it
        // back on every createInstance has a worse failure mode than not having
        // it: when a colorist drags a FRESH VapourSynth OFX node onto a NEW Fusion
        // node, the plugin sees an empty `_config` param (correct — it's a new
        // instance) and used to silently slurp the previous node's chain off the
        // sidecar. Cross-node bleed-through, very confusing.
        //
        // The sidecar is only a recovery copy. Exact-build host persistence
        // and render behavior still require native qualification.
        vsres::log::info("host", "VapourSynth OFX plugin instance created (v2.0) — "
                                "param=" + std::to_string(param_bytes) + " bytes, "
                                "cached_config_=" + std::to_string(restored_config.size()) + " bytes"
                                + (restored_config.empty() ? " · fresh instance (sidecar not auto-loaded — see plugin_entry.cpp comment)"
                                                          : ""));

        // Register for the companion-exit auto-apply observer. Both registration
        // (here) and the main-queue lookup run on the host main thread, so an
        // instance can never be looked up after its destructor finished.
        instance_id_ = next_instance_id().fetch_add(1, std::memory_order_relaxed);
        {
            std::lock_guard<std::mutex> lock(live_registry_mutex());
            live_instances()[instance_id_] = this;
        }
    }

    ~VapourSynthPlugin() override {
        release_node_guid_claim();
        {
            std::lock_guard<std::mutex> lock(live_registry_mutex());
            live_instances().erase(instance_id_);
        }
        // Cancel without waiting: a queued observer block that runs afterwards
        // finds no registry entry and no-ops. It captured only the id and the
        // session shared_ptr, never this.
        for (dispatch_source_t watcher : exit_watchers_) {
            if (!watcher) continue;
            dispatch_source_cancel(watcher);
            dispatch_release(watcher);
        }
    }

    void render(const OFX::RenderArguments& args) override;
    void getFramesNeeded(const OFX::FramesNeededArguments& args,
                         OFX::FramesNeededSetter& setter) override;
    bool isIdentity(const OFX::IsIdentityArguments& args,
                    OFX::Clip*& identityClip,
                    double& identityTime) override;
    void changedParam(const OFX::InstanceChangedArgs& args,
                      const std::string& paramName) override;

private:
    void render_passthrough(const OFX::RenderArguments& args, OFX::Image& src, OFX::Image& dst);
    // Loud refusal frame for FileMissing / FileChanged: fills the window with
    // saturated red so an unavailable or altered source can never render as
    // plausible silent output. Instant; no VapourSynth evaluation.
    void render_red_frame(const OFX::RenderArguments& args, OFX::Image& dst);
    void render_chain(const OFX::RenderArguments& args, OFX::Image& src, OFX::Image& dst,
                      const std::string& config_json);
    void marshal_vs_to_ofx(const VSAPI* api, const VSFrame* f, OFX::Image& dst,
                           const OfxRectI& window);
    // Temporal radius — how many frames ahead/behind we might need to access
    // to render frame N. QTGMC walks ±3 frames by default (the mv.Analyse
    // delta=1,2,3 calls in havsfunc r33). TTempSmooth uses ±3. SMDegrain
    // ±radius. Bigger isn't strictly wrong (just declares we MIGHT need more
    // frames; harmless if we don't use them), but too small breaks temporal
    // filters that try to access frames outside the declared window.
    //
    // We parse the action's config snapshot for known temporal-filter patterns. Falls back
    // to 3 if the chain has ANY enabled+approved step (safe default for
    // QTGMC), or 0 if the chain is empty / passthrough. TKT for later:
    // per-step radius declaration via a filter-registry hook instead of
    // string-matching the script source.
    static int current_radius(const std::string& config_json) {
        if (config_json.empty()) return 0;
        // Cheap substring check on the chain JSON. Misses creative ways to
        // call QTGMC (e.g. assigning haf.QTGMC to a local var first) but
        // catches the conventional path the Archivist's scripts generate.
        auto contains = [&](const char* needle) {
            return config_json.find(needle) != std::string::npos;
        };
        if (contains("QTGMC")) {
            // QTGMC's reach is NOT the ±3 of its mv.Analyse delta=1..3 vectors
            // alone: preset Slower sets TR0=2, and SourceMatch (up to 3) adds
            // further temporal passes. A filter fetching past the window we
            // declare in getFramesNeeded gets "no image" from Resolve and the
            // whole chain errors ("Analyse: failed to retrieve first frame
            // from super clip"). Declaring generously is harmless — Resolve
            // just prefetches a wider window — so cover QTGMC's worst case.
            return 10;
        }
        if (contains("SMDegrain")    // havsfunc.SMDegrain — variable radius, 3 is safe lower bound
         || contains("mv.Analyse")   // raw mvtools — assume ±3
         || contains("TTempSmooth")  // ttmpsm — radius 3 default
         || contains("MCTemporalDenoise")) {
            return 3;
        }
        return 0;
    }

    OFX::Clip* dst_clip_;
    OFX::Clip* src_clip_;
    OFX::PushButtonParam* configure_button_;
    OFX::PushButtonParam* swap_button_;
    OFX::DoubleParam*     mix_param_;
    OFX::StringParam*     config_param_;
    OFX::StringParam*     status_param_;
    OFX::StringParam*     error_param_;

    // Auto-apply support: the id indexes this instance in the process-wide
    // registry so the companion-exit observer can find a live instance from
    // the main queue without capturing a raw pointer that could dangle.
    uint64_t instance_id_ = 0;
    std::vector<dispatch_source_t> exit_watchers_;
    static std::mutex& live_registry_mutex() { static std::mutex m; return m; }
    static std::unordered_map<uint64_t, VapourSynthPlugin*>& live_instances() {
        static std::unordered_map<uint64_t, VapourSynthPlugin*> m;
        return m;
    }
    static std::atomic<uint64_t>& next_instance_id() { static std::atomic<uint64_t> v{1}; return v; }
    // Observes the dev-launched companion process. On exit, marshals to the
    // host main thread and applies the saved revision through the exact path
    // the Apply companion changes button uses. No-op when the instance is
    // gone, the companion saved nothing, or the result is not ready.
    void schedule_auto_apply(const std::shared_ptr<vsres::macos::PopoutSession>& session) {
        const int pid = session->child_pid();
        if (pid <= 0) {
            // SHIPPED LAUNCH (NSWorkspace gives no PID; child_pid stays 0):
            // the exit observer above can never arm, and the manual Apply
            // button was removed — live gap found 2026-11-12: "Save and close
            // applies automatically" never fired for the shipped app, so a
            // saved chain sat in the exchange while the node rendered
            // passthrough. Poll the private exchange result instead and apply
            // the FIRST ready revision (the companion writes result.json on
            // save-and-close). One apply per Configure generation; a refusal
            // is surfaced by apply_popout_result and recovered via the next
            // Configure press, exactly like the dev path.
            __block dispatch_source_t timer_ref = nullptr;
            __block bool satisfied = false;
            dispatch_source_t timer = dispatch_source_create(
                DISPATCH_SOURCE_TYPE_TIMER, 0, 0,
                dispatch_get_global_queue(QOS_CLASS_DEFAULT, 0));
            if (!timer) return;
            timer_ref = timer;
            const uint64_t id = instance_id_;
            dispatch_source_set_timer(timer,
                dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC),
                2 * NSEC_PER_SEC, 500 * NSEC_PER_MSEC);
            dispatch_source_set_event_handler(timer, ^{
                // Worker-queue context: probe off-main; marshal only on Ready.
                std::string probe, probe_error;
                uint64_t probe_revision = 0;
                const auto state = session->read_result(probe, probe_revision, probe_error);
                if (state != vsres::macos::PopoutSession::ResultState::Ready) return;
                dispatch_async(dispatch_get_main_queue(), ^{
                    if (satisfied) return;
                    VapourSynthPlugin* self = nullptr;
                    {
                        std::lock_guard<std::mutex> lock(live_registry_mutex());
                        auto& live = live_instances();
                        const auto it = live.find(id);
                        if (it != live.end()) self = it->second;
                    }
                    if (!self) return;   // instance torn down; nothing to apply
                    satisfied = true;
                    if (timer_ref) dispatch_source_cancel(timer_ref);
                    self->auto_apply_from_session(session);
                });
            });
            dispatch_retain(timer);
            exit_watchers_.push_back(timer);
            dispatch_resume(timer);
            vsres::log::info("host", "shipped companion — watching the exchange "
                                     "for a saved revision to auto-apply");
            return;
        }
        dispatch_source_t watcher = dispatch_source_create(
            DISPATCH_SOURCE_TYPE_PROC, static_cast<uintptr_t>(pid), DISPATCH_PROC_EXIT,
            dispatch_get_global_queue(QOS_CLASS_DEFAULT, 0));
        if (!watcher) return;
        const uint64_t id = instance_id_;
        dispatch_source_set_event_handler(watcher, ^{
            // Worker-queue context: marshal to main and touch nothing else.
            dispatch_async(dispatch_get_main_queue(), ^{
                VapourSynthPlugin* self = nullptr;
                {
                    std::lock_guard<std::mutex> lock(live_registry_mutex());
                    auto& live = live_instances();
                    const auto it = live.find(id);
                    if (it != live.end()) self = it->second;
                }
                if (self) {
                    self->auto_apply_from_session(session);
                } else {
                    vsres::log::info("host", "companion exited after instance teardown; nothing to auto-apply");
                }
            });
        });
        dispatch_retain(watcher);
        exit_watchers_.push_back(watcher);
        dispatch_resume(watcher);
        vsres::log::info("host", "companion exit will auto-apply the saved revision (pid="
                                 + std::to_string(pid) + ")");
    }
    // Main-thread only (main-queue block or InstanceChanged). Shares the
    // explicit-apply path; only the trigger differs.
    void auto_apply_from_session(const std::shared_ptr<vsres::macos::PopoutSession>& session) {
        std::string result, error;
        uint64_t revision = 0;
        const auto state = session->read_result(result, revision, error);
        if (state == vsres::macos::PopoutSession::ResultState::Empty) {
            vsres::log::info("host", "companion exited without a saved revision; nothing to auto-apply");
            return;
        }
        if (state != vsres::macos::PopoutSession::ResultState::Ready) {
            vsres::log::warn("host", "auto-apply skipped: " + (error.empty()
                ? std::string("no new ready revision") : error));
            if (!error.empty()) error_param_->setValue(error);
            return;
        }
        vsres::log::info("host", "auto-applying companion-saved revision "
                                 + std::to_string(revision));
        apply_popout_result(result, session, revision);
    }

    vsres::macos::VsRuntime vs_runtime_;
    // Separate runtime for pre-accept chain validation (apply_popout_result).
    // Never shared with render_chain's instance: a render may be in flight on
    // another thread while the main thread validates, and open() tears down
    // whatever graph the instance owns. Both render and validation use the
    // same (config, dims, radius) cache keys, so a validated chain is warm.
    vsres::macos::VsRuntime validation_runtime_;
    mutable std::mutex session_mutex_;
    std::shared_ptr<vsres::macos::PopoutSession> popout_session_;
    // Retain prior pending directories through this instance's lifetime. Old
    // companions never receive a later generation's private path/token.
    std::vector<std::shared_ptr<vsres::macos::PopoutSession>> retained_sessions_;
    // Logical retained configuration/snapshot custody, not total RSS or disk.
    // Failed/unconfirmed launches consume their slot/reserve too.
    size_t retained_payload_reserve_bytes_ = 0;
    static constexpr size_t kMaxRetainedGenerations = 8;
    static constexpr size_t kMaxConfigBytes = 8 * 1024 * 1024;
    static constexpr size_t kRetainedPayloadBudget = 96 * 1024 * 1024;

    std::shared_ptr<vsres::macos::PopoutSession> session_snapshot() const {
        std::lock_guard<std::mutex> lock(session_mutex_);
        return popout_session_;
    }


    // Applied configuration only. Own one string snapshot per host action;
    // never hold this mutex across host calls.
    mutable std::mutex config_mutex_;
    std::string cached_config_;

    std::string config_snapshot() const {
        std::lock_guard<std::mutex> lock(config_mutex_);
        return cached_config_;
    }

    void store_cached_config(std::string config_json) {
        std::lock_guard<std::mutex> lock(config_mutex_);
        cached_config_.swap(config_json);
    }

    std::string promote_restored_config(const std::string& restored_config) {
        std::lock_guard<std::mutex> lock(config_mutex_);
        // A watcher update can arrive while the OFX fallback value is fetched.
        // Never replace that newer accepted value with a stale restore value.
        if (cached_config_.empty()) cached_config_ = restored_config;
        return cached_config_;
    }

    // Write a status JSON snapshot to whatever the active PopoutSession's status path
    // is. The popout polls that file and surfaces state / errors in its banner so the
    // user can see WHY a chain isn't producing output (e.g. "havsfunc not found").
    // STICKY REFUSAL: while a saved revision is refused (see set_refusal_note),
    // masking states (passthrough/chain-empty/…) are rewritten to
    // config-apply-refused so the banner — and Skippy's get_plugin_status —
    // keep surfacing it. Cleared only when a new revision is accepted.
    void write_status(const std::string& state,
                      const std::string& error,
                      const std::string& script_preview,
                      int step_count) const;
    void set_refusal_note(const std::string& note);
    void clear_refusal_note();
    mutable std::mutex refusal_mutex_;
    std::string refusal_note_;

    // Dedup key for the chain-error log line in render_chain. Stores
    // `config_json|err`; if the next render produces the same pair, we
    // skip re-logging. Cleared on successful open so a transient failure
    // followed by recovery still leaves a clean log trail.
    std::string last_logged_error_key_;
    // C06 (2026-11-11): end-of-clip clamp log fires once per runtime, not per
    // rendered frame (Resolve hammers render() at 24-60 Hz).
    bool frame_clamp_logged_ = false;

    // Stable per-instance GUID (nodeGuid), generated once and persisted in
    // the _config JSON. Fork semantics in the .cpp definitions: incoming
    // config without a guid while this instance has identity → regenerate
    // (paste/legacy); incoming different guid → adopt; and a guid already
    // claimed by a DIFFERENT live instance → FORK (copy/paste duplication —
    // every constructed node owns a distinct identity).
    void ensure_node_guid(std::string& config_json);
    void release_node_guid_claim();
    static std::string generate_guid();
    static std::mutex& guid_registry_mutex() { static std::mutex m; return m; }
    static std::unordered_map<std::string, VapourSynthPlugin*>& guid_registry() {
        static std::unordered_map<std::string, VapourSynthPlugin*> r;
        return r;
    }
    std::string node_guid_;
    bool guid_regenerated_ = false;

    // Stable per-instance node id derived from `this` pointer + pid. Used so multi-node
    // graphs can cache to distinct files. Computed lazily.
    std::string node_id() const;

    // Snapshot OFX clip metadata (resolution, fps, field order, aspect, frame count,
    // pipeline depth) at a given time. Returned as JSON shaped to match the renderer's
    // ClipMetadata interface; the popout displays this and the Archivist's per-turn
    // system prompt includes it. Source-file path is NOT exposed by OFX, so no ffprobe.
    vsres::config::Json capture_clip_info(double time) const;

    void apply_popout_result(const std::string& result_json,
                             const std::shared_ptr<vsres::macos::PopoutSession>& session, uint64_t revision);
};

std::string VapourSynthPlugin::generate_guid() {
    std::uniform_int_distribution<uint32_t> dist(0, 0xffffffffu);
    std::random_device rd;
    char buf[40];
    std::snprintf(buf, sizeof(buf), "%08x-%04x-%04x-%04x-%08x",
        dist(rd), dist(rd) & 0xffff, (dist(rd) & 0xfff) | 0x4000,
        (dist(rd) & 0x3fff) | 0x8000, dist(rd));
    return std::string(buf);
}

// Node-GUID validation: shared rule in common/identity/guid.h — a guid is
// ONLY ever [A-Za-z0-9-]{1,64}. Everything that builds a sidecar/lock/.vpy
// filename from node_guid_ goes through it: a corrupt or hostile config
// cannot steer writes outside the nodes directory.

void VapourSynthPlugin::ensure_node_guid(std::string& config_json) {
    if (config_json.empty()) return;
    try {
        auto j = vsres::config::parse(config_json);
        if (!j.is_object()) return;
        const bool has_guid = j.contains("nodeGuid") && j.at("nodeGuid").is_string();
        bool rewrote_param = false;
        if (!has_guid) {
            if (!node_guid_.empty()) {
                // This instance already has identity: an incoming config
                // without a guid is a paste/legacy overwrite — fork it so
                // the two nodes' histories diverge instead of staying mixed.
                node_guid_ = generate_guid();
                guid_regenerated_ = true;
            } else {
                node_guid_ = generate_guid();
            }
            j["nodeGuid"] = node_guid_;
            config_json = vsres::config::serialize_compact(j);
            config_param_->setValue(config_json);
            rewrote_param = true;
            vsres::log::info("host", "node guid assigned: " + node_guid_
                + (guid_regenerated_ ? " (forked on incoming config)" : ""));
        } else {
            const auto incoming = j.at("nodeGuid").get<std::string>();
            if (!valid_node_guid(incoming)) {
                // Corrupt/hostile guid (path chars, traversal, oversized):
                // NEVER adopted for any path. Fork a fresh identity instead —
                // the sidecar/lock files stay inside the nodes directory.
                node_guid_ = generate_guid();
                guid_regenerated_ = true;
                j["nodeGuid"] = node_guid_;
                config_json = vsres::config::serialize_compact(j);
                config_param_->setValue(config_json);
                rewrote_param = true;
                vsres::log::info("host", "invalid incoming node guid refused — fresh guid forked");
            } else if (!node_guid_.empty() && incoming != node_guid_) {
                node_guid_ = incoming;
                vsres::log::info("host", "node guid switched with incoming config: " + node_guid_);
            } else if (node_guid_.empty()) {
                node_guid_ = incoming;
            }
        }
        // DUPLICATION-FORK (live defect: copies shared identity). Resolve's
        // copy/paste and clip duplication construct a new instance that
        // restores the SOURCE node's _config verbatim — same nodeGuid. The
        // old code simply adopted it, so both live instances shared identity:
        // per-node chat, sidecars and source binding collided. A guid may be
        // claimed by exactly ONE live instance; a second constructor claiming
        // an already-claimed guid FORKS to a fresh identity and rewrites its
        // own param. Released in the destructor, so project save/reopen
        // (destroy-then-construct) keeps the saved guid.
        {
            std::lock_guard<std::mutex> lock(guid_registry_mutex());
            auto& reg = guid_registry();
            const auto it = reg.find(node_guid_);
            if (it != reg.end() && it->second != this) {
                const std::string previous = node_guid_;
                node_guid_ = generate_guid();
                j["nodeGuid"] = node_guid_;
                config_json = vsres::config::serialize_compact(j);
                config_param_->setValue(config_json);
                guid_regenerated_ = true;
                vsres::log::info("host", "node guid forked on duplication: " + previous
                    + " -> " + node_guid_ + " (each node owns a distinct identity)");
            }
            reg[node_guid_] = this;
        }
    } catch (...) {
        // Malformed config: identity stays empty; renders still work.
    }
}

void VapourSynthPlugin::release_node_guid_claim() {
    std::lock_guard<std::mutex> lock(guid_registry_mutex());
    auto& reg = guid_registry();
    for (auto it = reg.begin(); it != reg.end();) {
        if (it->second == this) it = reg.erase(it); else ++it;
    }
}

void VapourSynthPlugin::render(const OFX::RenderArguments& args) {
    // Unconditional entry log so we can see when Resolve is asking us to
    // render. Absence of this log when the user presses Play means Resolve
    // never called us at all (likely cached frames or render-cache problem);
    // presence + no exit log means we're deadlocked inside VS.
    const auto render_t0 = std::chrono::steady_clock::now();
    vsres::log::info("host",
        "render() ENTER time=" + std::to_string(args.time)
        + " win=" + std::to_string(args.renderWindow.x1) + "," + std::to_string(args.renderWindow.y1)
        + "→" + std::to_string(args.renderWindow.x2) + "," + std::to_string(args.renderWindow.y2));

    std::unique_ptr<OFX::Image> src(src_clip_->fetchImage(args.time));
    std::unique_ptr<OFX::Image> dst(dst_clip_->fetchImage(args.time));
    if (!src || !dst) OFX::throwSuiteStatusException(kOfxStatErrValue);
    if (dst->getPixelDepth() != OFX::eBitDepthFloat ||
        dst->getPixelComponents() != OFX::ePixelComponentRGBA) {
        OFX::throwSuiteStatusException(kOfxStatErrUnsupported);
    }

    // Render consumes applied state and never writes OFX parameters.
    std::string config_json = config_snapshot();
    if (config_json.empty()) {
        config_param_->getValueAtTime(args.time, config_json);
        config_json = promote_restored_config(config_json);
    }

    if (config_json.empty()) {
        write_status("passthrough", "", "", 0);
        render_passthrough(args, *src, *dst);
        const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now() - render_t0).count();
        vsres::log::info("host", "render() EXIT passthrough — " + std::to_string(elapsed) + " ms");
        return;
    }

    render_chain(args, *src, *dst, config_json);
    const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now() - render_t0).count();
    vsres::log::info("host", "render() EXIT chain — " + std::to_string(elapsed) + " ms");
}

void VapourSynthPlugin::render_passthrough(const OFX::RenderArguments& args,
                                           OFX::Image& src, OFX::Image& dst) {
    const OfxRectI win = args.renderWindow;
    const int row_bytes = (win.x2 - win.x1) * 4 * static_cast<int>(sizeof(float));
    for (int y = win.y1; y < win.y2; ++y) {
        if (abort()) break;
        const float* src_pix = static_cast<const float*>(src.getPixelAddress(win.x1, y));
        float*       dst_pix = static_cast<float*>      (dst.getPixelAddress(win.x1, y));
        if (src_pix && dst_pix) std::memcpy(dst_pix, src_pix, row_bytes);
    }
}

void VapourSynthPlugin::render_red_frame(const OFX::RenderArguments& args,
                                         OFX::Image& dst) {
    const OfxRectI win = args.renderWindow;
    for (int y = win.y1; y < win.y2; ++y) {
        if (abort()) break;
        float* row = static_cast<float*>(dst.getPixelAddress(win.x1, y));
        if (!row) continue;
        for (int x = 0; x < win.x2 - win.x1; ++x) {
            row[x * 4 + 0] = 1.0f;
            row[x * 4 + 1] = 0.0f;
            row[x * 4 + 2] = 0.0f;
            row[x * 4 + 3] = 1.0f;
        }
    }
}

std::string VapourSynthPlugin::node_id() const {
    static thread_local char buf[48];
    std::snprintf(buf, sizeof(buf), "n-%p", static_cast<const void*>(this));
    return std::string(buf);
}

// STICKY REFUSAL. When pre-accept validation refuses a saved revision, that
// refusal is the single most important fact about this node's state — the
// user's edit is NOT applied and playback shows the previous chain (often
// passthrough, which reads like success). Live fallout (Oct 26): the
// companion's next render overwrote the refused status with "passthrough",
// the banner showed nothing actionable, and Skippy claimed the change had
// landed. The refusal therefore stays sticky: every subsequent status write
// keeps surfacing it until a NEW revision is accepted. Real render states
// (chain-ok/chain-error) keep their own semantics with the refusal noted.
void VapourSynthPlugin::set_refusal_note(const std::string& note) {
    std::lock_guard<std::mutex> lock(refusal_mutex_);
    refusal_note_ = note;
}

void VapourSynthPlugin::clear_refusal_note() {
    std::lock_guard<std::mutex> lock(refusal_mutex_);
    refusal_note_.clear();
}

void VapourSynthPlugin::write_status(const std::string& state,
                                     const std::string& error,
                                     const std::string& script_preview,
                                     int step_count) const {
    std::string effective_state = state;
    std::string effective_error = error;
    {
        std::lock_guard<std::mutex> lock(refusal_mutex_);
        if (!refusal_note_.empty() && state != "config-apply-refused") {
            if (state == "passthrough" || state == "chain-empty"
                || state == "chain-disabled" || state == "chain-awaiting-approval") {
                // These states read like "nothing wrong" while the user's last
                // saved edit sits refused. Surface the refusal instead.
                effective_state = "config-apply-refused";
                effective_error = "The saved chain was refused and is NOT applied: "
                    + refusal_note_
                    + "\nThis node is passing frames through unprocessed. Fix the chain in the companion and save again.";
            } else {
                // chain-ok (rendered the PREVIOUS chain — do not read as
                // "your edit worked") and real errors: keep the state, note
                // the refusal in the error text.
                effective_error = error.empty() ? std::string{}
                    : error + "\n";
                effective_error += "Note: the last saved revision was refused and is not applied. "
                    + refusal_note_;
            }
        }
    }
    // Keep this session's directory alive for this synchronous host-action write.
    const auto session = session_snapshot();
    if (!session) return;
    const std::string path = session->status_path();
    if (path.empty()) return;

    vsres::config::Json j = vsres::config::Json::object();
    j["state"]          = effective_state;
    j["error"]          = effective_error.empty() ? vsres::config::Json(nullptr) : vsres::config::Json(effective_error);
    j["scriptPreview"]  = script_preview;
    j["stepCount"]      = step_count;
    j["timestampMs"]    = static_cast<long long>(
        std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::system_clock::now().time_since_epoch()).count());

    std::ofstream out(path, std::ios::trunc);
    if (out.is_open()) {
        out << j.dump();
    }
}

vsres::config::Json VapourSynthPlugin::capture_clip_info(double time) const {
    using Json = vsres::config::Json;
    if (!src_clip_ || !src_clip_->isConnected()) return Json{};

    // We emit ONLY the `timeline` subset here. The source-native subset (from
    // ffprobe) is preserved by the caller across Configure clicks — see the merge
    // logic in changedParam("configure"). The renderer's ClipMetadata has shape
    // { timeline: {...}, source?: {...} } and the C++ side never touches `source`.

    Json timeline = Json::object();

    OfxRectD rod  = src_clip_->getRegionOfDefinition(time);
    const int w   = static_cast<int>(std::round(rod.x2 - rod.x1));
    const int h   = static_cast<int>(std::round(rod.y2 - rod.y1));

    OfxRangeD r   = src_clip_->getFrameRange();
    const int n   = static_cast<int>(std::round(r.max - r.min)) + 1;

    const double fps = src_clip_->getFrameRate();
    const double par = src_clip_->getPixelAspectRatio();

    std::string field_order;
    switch (src_clip_->getFieldOrder()) {
        case OFX::eFieldNone:  field_order = "progressive"; break;
        case OFX::eFieldUpper: field_order = "tt"; break;   // TFF
        case OFX::eFieldLower: field_order = "bb"; break;   // BFF
        case OFX::eFieldBoth:  field_order = "interlaced"; break;
        default:               field_order = "unknown"; break;
    }
    std::string pipeline_depth;
    switch (src_clip_->getPixelDepth()) {
        case OFX::eBitDepthUByte:  pipeline_depth = "8-bit"; break;
        case OFX::eBitDepthUShort: pipeline_depth = "16-bit int"; break;
        case OFX::eBitDepthFloat:  pipeline_depth = "32-bit float"; break;
        default:                   pipeline_depth = "unknown"; break;
    }

    timeline["width"]              = w;
    timeline["height"]             = h;
    timeline["fps"]                = fps;
    timeline["pixelAspectRatio"]   = par;
    timeline["fieldOrder"]         = field_order;
    timeline["pipelineBitDepth"]   = pipeline_depth;
    timeline["frameCount"]         = n;
    timeline["duration"]           = (fps > 0.0) ? (n / fps) : 0.0;

    if (par > 0.0) {
        char buf[64];
        std::snprintf(buf, sizeof(buf), "%.4f", par);
        timeline["sampleAspectRatio"] = std::string(buf);
    } else {
        timeline["sampleAspectRatio"] = nullptr;
    }
    if (h > 0 && par > 0.0) {
        char buf[64];
        std::snprintf(buf, sizeof(buf), "%.4f", (w * par) / h);
        timeline["displayAspectRatio"] = std::string(buf);
    } else {
        timeline["displayAspectRatio"] = nullptr;
    }

    timeline["capturedAt"] = std::to_string(
        std::chrono::duration_cast<std::chrono::seconds>(
            std::chrono::system_clock::now().time_since_epoch()).count());

    return timeline;
}

// TKT-SRC Phase 2: resolve the source-mode state by validating the file at the
// path stored in clipMetadata.source. Called from render_chain right after
// parse_chain — parse_chain already extracted filePath / trim points / timeline
// dims from the JSON; this function decides whether source-mode is safe to
// activate by checking the file's existence + a few sanity flags.
//
// Phase 2 keeps the decision tree minimal:
//   - no filePath                  → SourceMode::Disabled (use OFX clip)
//   - file doesn't exist           → SourceMode::FileMissing (would render error frame; Phase 4)
//   - retimeDetected flag in JSON  → SourceMode::RetimeDisabled (council unanimous: don't try)
//   - default                      → SourceMode::Active (full-source restoration)
//
// Phase 2 does NOT yet:
//   - check the file's hash matches the stored sourceHash (Phase 4)
//   - detect trim by comparing clip frame range to source frame count (Phase 2b)
//   - distinguish Active vs ActiveTrimmed (default to Active for now; trim
//     handling lands in Phase 2b after we wire in/out points through the UI)
// C01 (2026-11-11): the runtime cache key for a rendered chain. The composed
// script EMBEDS the mix blend (composer: `std.core.Merge(..., weight=mix)`),
// but the config JSON alone is identical when only the OFX Mix parameter
// changes or animates — a warm cache would then keep serving the original
// graph's blend forever. The effective mix is therefore part of the key.
// 0x1f cannot appear in valid JSON text, so the separator is unambiguous.
static std::string cache_key_with_mix(const std::string& json, double mix) {
    char buf[40];
    std::snprintf(buf, sizeof buf, "%.10g", mix);
    return json + "\x1f mix=" + buf;
}

static vsres::SourceMode decide_source_mode(const std::string& config_json,
                                            const vsres::SourceModeConfig& parsed,
                                            std::string* fallback_reason_out) {
    using SourceMode = vsres::SourceMode;
    auto set_reason = [&](const std::string& r) { if (fallback_reason_out) *fallback_reason_out = r; };

    if (parsed.source_file_path.empty()) {
        set_reason("no source file identified (drag-drop a clip or use Identify Source)");
        return SourceMode::Disabled;
    }

    // Re-parse just enough JSON to see retimeDetected + scan a few more flags.
    try {
        auto j = vsres::config::parse(config_json);
        if (j.is_object() && j.contains("clipMetadata") && j["clipMetadata"].is_object()) {
            const auto& src = j["clipMetadata"].value("source", vsres::config::Json::object());
            if (src.value("retimeDetected", false)) {
                set_reason("Resolve clip has a retime curve — source-mode disabled to avoid frame-mapping errors");
                return SourceMode::RetimeDisabled;
            }
        }
    } catch (...) {
        // Malformed JSON shouldn't crash us; fall through and try the path check.
    }

    struct stat st;
    if (stat(parsed.source_file_path.c_str(), &st) != 0) {
        set_reason("source file not found at " + parsed.source_file_path);
        return SourceMode::FileMissing;
    }

    // FileChanged: the companion recorded size/mtime fingerprints from its
    // chunk-hash probe at identification time. A mismatch means the file at
    // the recorded path is no longer the one that was probed — the recorded
    // trim points and frame mapping describe the OLD content, and rendering
    // through them silently produces wrong frames. Refuse (red error frame)
    // rather than render plausible-but-wrong output. Unrecorded (-1)
    // fingerprints keep the legacy behavior (Active).
    if (parsed.source_size >= 0 && static_cast<int64_t>(st.st_size) != parsed.source_size) {
        set_reason("source file size changed since identification (" + std::to_string(st.st_size)
            + " bytes now, " + std::to_string(parsed.source_size)
            + " recorded) — re-identify the source in the companion");
        return SourceMode::FileChanged;
    }
    if (parsed.source_mtime_ms >= 0) {
        const int64_t mtime_ms = static_cast<int64_t>(st.st_mtimespec.tv_sec) * 1000
            + static_cast<int64_t>(st.st_mtimespec.tv_nsec) / 1000000;
        if (mtime_ms != parsed.source_mtime_ms) {
            set_reason("source file modified since identification (mtime "
                + std::to_string(mtime_ms) + " now, " + std::to_string(parsed.source_mtime_ms)
                + " recorded) — re-identify the source in the companion");
            return SourceMode::FileChanged;
        }
    }

    // Trim handles recorded (Resolve GetSourceStartFrame/GetSourceEndFrame via
    // discovery): render the clip's marked source span, not the head of the
    // media. Without this, a trimmed clip in source-mode renders source frames
    // from 0 — plausible-but-wrong output (the wrong section of the tape).
    // Unrecorded sentinels (-1) keep whole-source Active.
    if (parsed.source_in_point >= 0 && parsed.source_out_point >= parsed.source_in_point) {
        return SourceMode::ActiveTrimmed;
    }

    return SourceMode::Active;
}

void VapourSynthPlugin::render_chain(const OFX::RenderArguments& args,
                                     OFX::Image& src, OFX::Image& dst,
                                     const std::string& config_json) {
    // The caller owns this action's snapshot. Parsing, composition, runtime cache
    // identity and radius must not observe different watcher updates mid-render.

    auto chain = vsres::parse_chain(config_json);
    double mix = 1.0;
    mix_param_->getValueAtTime(args.time, mix);
    chain.mix = static_cast<float>(mix);
    // C01 (2026-11-11): the runtime cache must distinguish renders by the
    // EFFECTIVE mix — the composed script embeds the blend, so a warm cache
    // keyed on the JSON alone would keep the old graph's blend when only the
    // OFX Mix knob moved (or animated) between frames.
    const std::string effective_key = cache_key_with_mix(config_json, mix);

    // TKT-SRC: decide the source-mode state, fill in timeline dims from the
    // OFX render args (the args.renderWindow / src image gives us the actual
    // dims Resolve is rendering at), then let the composer emit the right
    // Python (lsmas-source vs OFX-source).
    std::string source_mode_reason;
    chain.source_mode.mode = decide_source_mode(config_json, chain.source_mode, &source_mode_reason);
    chain.source_mode.fallback_reason = source_mode_reason;
    // Pull timeline dims from the actual OFX-clip image (more reliable than
    // clipMetadata.timeline.width/height which was captured at Configure time).
    {
        OfxRectI rect = src.getRegionOfDefinition();
        chain.source_mode.timeline_width  = rect.x2 - rect.x1;
        chain.source_mode.timeline_height = rect.y2 - rect.y1;
    }
    // Log so we can see exactly which mode is in effect per render. Won't
    // spam — render() is gated on Resolve actually rendering, not on a timer.
    const char* mode_label =
        chain.source_mode.mode == vsres::SourceMode::Active        ? "Active" :
        chain.source_mode.mode == vsres::SourceMode::ActiveTrimmed ? "ActiveTrimmed" :
        chain.source_mode.mode == vsres::SourceMode::RetimeDisabled? "RetimeDisabled" :
        chain.source_mode.mode == vsres::SourceMode::FileMissing   ? "FileMissing" :
        chain.source_mode.mode == vsres::SourceMode::FileChanged   ? "FileChanged" :
                                                                     "Disabled";
    vsres::log::info("host", std::string("source-mode: ") + mode_label
        + (source_mode_reason.empty() ? "" : " (" + source_mode_reason + ")")
        + " · timeline=" + std::to_string(chain.source_mode.timeline_width)
        + "x" + std::to_string(chain.source_mode.timeline_height)
        + (chain.source_mode.source_file_path.empty() ? "" : " · file=" + chain.source_mode.source_file_path));

    // FileMissing / FileChanged REFUSE to render (composer.h's documented
    // behavior): the recorded trim mapping and frame counts describe content
    // that is gone or altered. Falling back to clip-mode would render
    // plausible-but-wrong frames through a stale mapping — worse than loud.
    // A red frame + chain-error status is instant and actionable (re-identify
    // the source in the companion).
    if (chain.source_mode.mode == vsres::SourceMode::FileMissing
        || chain.source_mode.mode == vsres::SourceMode::FileChanged) {
        write_status("chain-error", source_mode_reason, "", 0);
        render_red_frame(args, dst);
        return;
    }

    OfxRectI rect = src.getRegionOfDefinition();
    auto range = src_clip_->getFrameRange();

    vsres::StepContext step_ctx{
        rect.x2 - rect.x1,
        rect.y2 - rect.y1,
        static_cast<int>(range.max - range.min) + 1,
        current_radius(config_json),
    };

    // Stash the source for the preview path (which runs outside this OFX action and
    // therefore can't pull fresh frames from src_clip_).

    // Gate accounting comes from the SAME pass that builds the script, so the
    // status counts below can never drift from what is actually emitted.
    vsres::ComposeStats compose_stats;
    std::string script = vsres::compose_script(chain, step_ctx, &compose_stats);
    const std::string script_preview = script.size() > 1200
        ? script.substr(0, 1200) + "\n…(truncated, " + std::to_string(script.size()) + " bytes total)"
        : script;

    // Persist the full composed script to disk on every render so the user
    // (and we, when debugging) can `cat` it to see exactly what VapourSynth
    // is evaluating. The status banner's "view composed script" button shows
    // a truncated preview; this file is the full thing with no truncation.
    // Overwritten on every render — only ever holds the latest. Diagnostic
    // only, not security-sensitive; lives next to last-config.json.
    {
        if (const char* home = std::getenv("HOME"); home && *home) {
            std::string dir = std::string(home) + "/Library/Application Support/VapourSynth-OFX";
            // SECURITY (2026-11-11): create/verify the product directory
            // chain before writing — real directories only, owner-checked,
            // 0700, symlinked components refused instead of followed.
            std::string dir_err;
            const bool dir_ok = ensure_private_dir(dir, /*check_parents=*/true, &dir_err);
            std::string path = dir + "/last-composed.vpy";
            std::string composed_dump =
                "# Composed VapourSynth script — written by render_chain on every render.\n"
                "# Overwritten in place. To inspect the failing chain:\n"
                "#   cat \"" + path + "\"\n"
                "# Composed at time=" + std::to_string(args.time) + " for " +
                std::to_string(chain.steps.size()) + " step(s).\n"
                "# ──────────────────────────────────────────────────────────────────\n" +
                script;
            if (!dir_ok) {
                vsres::log::warn("host", "composed-script dump skipped: " + dir_err);
            } else if (!write_private_file(path, composed_dump)) {
                vsres::log::warn("host", "composed-script dump write refused: " + path);
            }
            // PER-NODE copy: the companion's Script view and chain preview
            // read the script for THIS node (nodeGuid-keyed), never another
            // node's — the global file above stays only as a compatibility
            // pointer. Written under the same GUID as the sidecar store.
            //
            // STALE-THUMBNAIL GUARD (live defect Oct 27): Resolve renders this
            // node at MANY sizes (viewer, thumbnails, UI tiles — observed
            // 576x324, 184x92). Writing a script whose final resize matches
            // each incidental render size made the companion's preview replay
            // a stale thumbnail-dimension composition (soft + combing-looking
            // processed A/B). Record the per-node script ONLY at FULL viewer
            // size (>= half the timeline height): small renders still compose
            // and render normally (their script is evaluated in-process),
            // they just don't clobber the recorded script. The companion-side
            // stale-render guard (render_preview_frame.py) normalizes geometry
            // independently, so this is defense in depth, not the only fix.
            const int render_h = args.renderWindow.y2 - args.renderWindow.y1;
            const bool full_size_render = render_h * 2 >= chain.source_mode.timeline_height;
            if (dir_ok && !node_guid_.empty() && full_size_render && valid_node_guid(node_guid_)) {
                std::string node_dir = dir + "/nodes";
                ensure_private_dir(node_dir, /*check_parents=*/false);
                std::string node_path = node_dir + "/" + node_guid_ + ".vpy";
                std::string node_dump =
                    "# Composed VapourSynth script for node " + node_guid_ + "\n"
                    "# Written by render_chain on every FULL-SIZE render of this node\n"
                    "# (small thumbnail/UI renders do not clobber this file).\n" +
                    script;
                write_private_file(node_path, node_dump);
            }
        }
    }

    // Counts come from the composition pass above: emitted = enabled +
    // approved + content-bound + known filter — exactly what the script
    // contains. An approval whose content binding no longer matches counts
    // as awaiting-adjustment, never as running.
    const int total_steps = compose_stats.total;
    const int enabled_steps = compose_stats.enabled;
    const int approved_enabled = compose_stats.emitted;
    if (compose_stats.unapproved > 0 || compose_stats.unknown > 0) {
        vsres::log::info("host", "chain gate: emitted=" + std::to_string(compose_stats.emitted)
            + " unapproved-or-stale=" + std::to_string(compose_stats.unapproved)
            + " unknown=" + std::to_string(compose_stats.unknown));
    }
    // Four "passthrough-but-not-actually-broken" cases (mirrors the predicted
    // state logic in apply_popout_result above):
    //   - total == 0                            → chain-empty           (no steps)
    //   - total > 0 && enabled_steps == 0       → chain-disabled        (all toggled off)
    //   - enabled > 0 && approved_enabled == 0  → chain-awaiting-approval (all enabled are DRAFTs)
    //   - approved_enabled > 0                  → run VS via render_chain (the approved subset)
    if (total_steps == 0) {
        write_status("chain-empty", "", script_preview, 0);
        render_passthrough(args, src, dst);
        return;
    }
    if (enabled_steps == 0) {
        write_status("chain-disabled", "", script_preview, 0);
        render_passthrough(args, src, dst);
        return;
    }
    if (approved_enabled == 0) {
        // Every enabled step is awaiting approval. Don't try to run VS —
        // the composer already filters out unapproved steps so the script
        // would be a no-op. Surface a distinct status so the popout's banner
        // can prompt the user to click Approve on each link.
        write_status("chain-awaiting-approval", "", script_preview, enabled_steps);
        render_passthrough(args, src, dst);
        return;
    }

    vsres::macos::VsRuntimeConfig rcfg{
        src_clip_,
        step_ctx.width,
        step_ctx.height,
        step_ctx.radius,
        static_cast<int>(range.min),
        static_cast<int>(range.max),
    };
    // VS open is the expensive part on first render — parses the script,
    // builds the filter graph, initializes mvtools / nnedi3 weights / etc.
    // For QTGMC this can take 5–15s the FIRST time. Cached on subsequent
    // calls with the same (script, dimensions, radius) key.
    const auto open_t0 = std::chrono::steady_clock::now();
    vs_runtime_.set_center_frame(static_cast<int>(args.time));
    // Courtesy overlay while the first synthesis runs: the host UI shows
    // nothing during a long evaluateBuffer + first-frame render and looks
    // frozen. Hidden again as soon as the frame lands or we fall back.
    // Skipped entirely when the open will be an instant cache hit.
    const bool slow_open_expected = !vs_runtime_.is_cached(effective_key, rcfg);
    if (slow_open_expected) vsres::overlay_show(nullptr);
    if (!vs_runtime_.open(effective_key, script, rcfg)) {
        vsres::overlay_hide();
        const std::string err = vs_runtime_.last_error();
        write_status("chain-error", err, script_preview, enabled_steps);
        // Log the failure ONCE per (script, error) combination so the log
        // stream stays readable when Resolve hammers render() at 24-60 Hz
        // and every call hits the same Python exception. The vs_runtime
        // failure-cache already short-circuits the re-evaluation; this just
        // mirrors the suppression at the host-side log line. Cleared as
        // soon as the script changes (key differs) — next failure logs once
        // again. Same idea as macOS unified logging's coalescing.
        const std::string err_key = config_json + "|" + err;
        if (last_logged_error_key_ != err_key) {
            vsres::log::error("host", "VS evaluateBuffer failed: " + err);
            last_logged_error_key_ = err_key;
        }
        // Fall back to passthrough so the timeline keeps playing rather than going
        // black. The popout's status banner tells the user what failed.
        render_passthrough(args, src, dst);
        return;
    }
    // Successful open — reset the error-log dedup so future failures
    // surface fresh.
    last_logged_error_key_.clear();
    // C06 (2026-11-11): ENFORCE the declared timing contract
    // (docs/timing-contract.md). The timeline path maps output-frame
    // coordinates 1:1 onto script frames — honest ONLY when the chain's
    // output cadence equals the timeline's (the accepted PAL baseline and
    // every same-rate case, including fractional NTSC rates). A
    // rate-changing chain (bob at 2x, IVTC at 24000/1001, FPSDivisor
    // halving) on a mismatched timeline would play at the wrong speed:
    // refuse with the exact rates instead of silently retiming, clamping
    // or duplicating frames.
    {
        const double timeline_fps = src_clip_->getFrameRate();
        const std::int64_t onum = vs_runtime_.output_fps_num();
        const std::int64_t oden = vs_runtime_.output_fps_den();
        if (!vsres::rate::rates_match(timeline_fps, onum, oden)) {
            char tl_buf[32];
            std::snprintf(tl_buf, sizeof tl_buf, "%.4f", timeline_fps);
            const std::string out_desc = std::to_string(onum) + "/" + std::to_string(oden);
            const std::string msg =
                "Chain output rate " + out_desc + " fps does not match the timeline rate "
                + tl_buf + " fps. The timeline path maps frames 1:1, so a rate-changing "
                "chain cannot render honestly at the current timeline rate. Set the "
                "Resolve timeline (and render output) to " + out_desc + " fps, or change "
                "the chain (e.g. QTGMC FPSDivisor / remove the rate change) to match the "
                "timeline. Showing the passthrough frame instead of a wrong-speed result.";
            const std::string rate_key = "chain-rate-mismatch|" + effective_key;
            if (last_logged_error_key_ != rate_key) {
                last_logged_error_key_ = rate_key;
                vsres::log::warn("host", "rate mismatch refused: chain " + out_desc
                    + " fps vs timeline " + tl_buf + " fps");
            }
            write_status("chain-rate-mismatch", msg, script_preview, enabled_steps);
            vsres::overlay_hide();
            render_passthrough(args, src, dst);
            return;
        }
    }
    const auto open_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now() - open_t0).count();
    vsres::log::info("host", "VS open: " + std::to_string(open_ms) + " ms"
        + (open_ms > 100 ? " (parsed+initialized)" : " (cached)"));

    // OUTPUT-frame coordinate (host convention) rounded to the intended frame
    // and clamped to the clip's own length (C06, 2026-11-11): truncation
    // would select N−1 for 98.999999, and the end-of-clip slot holds the last
    // frame instead of erroring into passthrough.
    const int raw_frame_index = vsres::rate::timeline_frame_index(args.time - range.min);
    const int frame_index = vsres::rate::clamp_to_output(
        raw_frame_index, vs_runtime_.output_num_frames());
    if (frame_index != raw_frame_index && !frame_clamp_logged_) {
        frame_clamp_logged_ = true;
        vsres::log::warn("host", "frame index clamped to the clip: "
            + std::to_string(raw_frame_index) + " -> " + std::to_string(frame_index)
            + " (clip frames " + std::to_string(vs_runtime_.output_num_frames()) + ")");
    }
    std::string get_frame_err;
    const auto getframe_t0 = std::chrono::steady_clock::now();
    const VSFrame* f = vs_runtime_.get_frame(frame_index, &get_frame_err);
    const auto getframe_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now() - getframe_t0).count();
    if (!f) {
        vsres::overlay_hide();
        write_status("chain-error", "getFrame: " + get_frame_err, script_preview, enabled_steps);
        vsres::log::error("host", "VS getFrame failed (" + std::to_string(getframe_ms) + " ms): " + get_frame_err);
        render_passthrough(args, src, dst);
        return;
    }
    vsres::overlay_hide();
    vsres::log::info("host", "VS getFrame[" + std::to_string(frame_index)
        + "] OK: " + std::to_string(getframe_ms) + " ms");
    write_status("chain-ok", "", script_preview, enabled_steps);

    marshal_vs_to_ofx(/*api=*/nullptr, f, dst, args.renderWindow);
    // freeFrame is owned by vs_runtime_.api_; expose a helper later. For now retrieve it via getVSAPI.
    {
        const VSSCRIPTAPI* sapi = getVSScriptAPI(VSSCRIPT_API_VERSION);
        const VSAPI* api = sapi ? sapi->getVSAPI(VAPOURSYNTH_API_VERSION) : nullptr;
        if (api) api->freeFrame(f);
    }
}

void VapourSynthPlugin::marshal_vs_to_ofx(const VSAPI* /*api_unused*/, const VSFrame* f,
                                          OFX::Image& dst, const OfxRectI& window) {
    const VSSCRIPTAPI* sapi = getVSScriptAPI(VSSCRIPT_API_VERSION);
    const VSAPI* api = sapi->getVSAPI(VAPOURSYNTH_API_VERSION);

    const float* r_base = reinterpret_cast<const float*>(api->getReadPtr(f, 0));
    const float* g_base = reinterpret_cast<const float*>(api->getReadPtr(f, 1));
    const float* b_base = reinterpret_cast<const float*>(api->getReadPtr(f, 2));
    const int r_stride = api->getStride(f, 0) / static_cast<int>(sizeof(float));
    const int g_stride = api->getStride(f, 1) / static_cast<int>(sizeof(float));
    const int b_stride = api->getStride(f, 2) / static_cast<int>(sizeof(float));

    const int win_h = window.y2 - window.y1;
    for (int yi = 0; yi < win_h; ++yi) {
        if (abort()) break;
        const int ofx_y = window.y2 - 1 - yi;
        const float* r_row = r_base + yi * r_stride;
        const float* g_row = g_base + yi * g_stride;
        const float* b_row = b_base + yi * b_stride;
        float* dst_row = static_cast<float*>(dst.getPixelAddress(window.x1, ofx_y));
        if (!dst_row) continue;
        for (int x = window.x1; x < window.x2; ++x) {
            const int xi = x - window.x1;
            dst_row[(x - window.x1) * 4 + 0] = r_row[xi];
            dst_row[(x - window.x1) * 4 + 1] = g_row[xi];
            dst_row[(x - window.x1) * 4 + 2] = b_row[xi];
            dst_row[(x - window.x1) * 4 + 3] = 1.0f;
        }
    }
}

void VapourSynthPlugin::getFramesNeeded(const OFX::FramesNeededArguments& args,
                                        OFX::FramesNeededSetter& setter) {
    // Consume applied state, not pending companion-file edits.
    const std::string config_json = config_snapshot();
    const int radius = current_radius(config_json);
    OfxRangeD range{args.time - radius, args.time + radius};
    setter.setFramesNeeded(*src_clip_, range);
    vsres::log::info("host", "getFramesNeeded t=" + std::to_string(args.time)
        + " radius=" + std::to_string(radius)
        + " (cached_config_=" + std::to_string(config_json.size()) + " bytes)");
}

bool VapourSynthPlugin::isIdentity(const OFX::IsIdentityArguments& args,
                                   OFX::Clip*& identityClip,
                                   double& /*identityTime*/) {
    // Identity and render use the applied snapshot contract.
    const std::string config_json = config_snapshot();
    if (config_json.empty()) {
        vsres::log::info("host", "isIdentity=TRUE (cached_config_ empty) — Resolve will bypass");
        identityClip = src_clip_;
        return true;
    }
    // Parse the chain to check if there's anything enabled + approved +
    // content-bound to do. If everything is unapproved (DRAFTs, stale
    // bindings) or disabled, we ARE an identity. Uses the same gate as the
    // composer so identity and render can never disagree.
    vsres::Chain c = vsres::parse_chain(config_json);
    const vsres::ComposeStats g = vsres::summarize_chain(c, vsres::StepContext{0, 0, 0, 0});
    const int approved_enabled = g.emitted;
    if (approved_enabled == 0) {
        vsres::log::info("host", "isIdentity=TRUE (no approved+content-bound steps) — Resolve will bypass");
        identityClip = src_clip_;
        return true;
    }
    vsres::log::info("host", "isIdentity=FALSE — chain has "
        + std::to_string(approved_enabled) + " live step(s); Resolve will call render()");
    return false;
}

void VapourSynthPlugin::changedParam(const OFX::InstanceChangedArgs& args,
                                     const std::string& paramName) {
    if (paramName == "configure") {
        // Configure opens from applied state; saving does not apply edits.
        // Inject fresh OFX-derived TIMELINE metadata into the config payload heading
        // out to the popout. We preserve any existing source-native ffprobe block
        // (clipMetadata.source) so the user's prior "identify source file" choice
        // survives across Configures. cached_config_ itself isn't mutated; we re-
        // extract timeline on every Configure so timeline edits in Resolve are
        // reflected without project restart.
        std::string config = config_snapshot();
        try {
            auto j = vsres::config::parse(config);
            if (!j.is_object()) j = vsres::config::Json::object();

            vsres::config::Json clip_meta = vsres::config::Json::object();
            if (j.contains("clipMetadata") && j["clipMetadata"].is_object()) {
                clip_meta = j["clipMetadata"];
                // Drop any legacy top-level fields from the old single-layer shape.
                // Only `timeline` and `source` are valid at this level now.
                for (const std::string& legacy : {"filePath", "fileName", "probedAt",
                                                  "source", "container", "formatName",
                                                  "video", "audio", "raw"}) {
                    // Skip "source" — that's our valid new key. We mean the legacy
                    // discriminator string that used to live here.
                    if (legacy == "source") {
                        if (clip_meta.contains("source") && clip_meta["source"].is_string()) {
                            clip_meta.erase("source");
                        }
                        continue;
                    }
                    clip_meta.erase(legacy);
                }
            }
            clip_meta["timeline"] = capture_clip_info(args.time);
            j["clipMetadata"] = clip_meta;
            config = j.dump();
        } catch (const std::exception& e) {
            vsres::log::warn("host", std::string("failed to inject clipMetadata: ") + e.what());
        }
        vsres::log::info("host", "Configure pressed — launching popout with "
                                + std::to_string(config.size())
                                + " bytes of config (incl. clipMetadata)");

        // Rotate the exchange generation on every Configure. Never hand new
        // paths/token to an earlier publisher or treat process exit as proof.
        const auto previous = session_snapshot();
        bool recovery_required = false;
        bool input_is_pending = false;
        std::string retained_snapshot;
        if (previous) {
            std::string pending, error;
            uint64_t revision = 0;
            const auto state = previous->read_result(pending, revision, error, &retained_snapshot);
            recovery_required = state == vsres::macos::PopoutSession::ResultState::Ready ||
                                state == vsres::macos::PopoutSession::ResultState::Invalid;
            if (recovery_required && !pending.empty()) {
                // Known transport shapes are valid, but acceptance/freshness is
                // unconfirmed. Show those retained edits for explicit review.
                config = pending;
                input_is_pending = true;
            }
        }
        std::shared_ptr<vsres::macos::PopoutSession> session;
        {
            std::lock_guard<std::mutex> lock(session_mutex_);
            // Admission and all allocating ownership operations precede any
            // private-file preparation or external app launch. Reserve one
            // bounded accepted canonical body in addition to actual inputs.
            if (config.size() <= kMaxConfigBytes && retained_snapshot.size() <= kMaxConfigBytes &&
                retained_sessions_.size() < kMaxRetainedGenerations) {
                const size_t reserve = config.size() + retained_snapshot.size() + kMaxConfigBytes;
                if (reserve <= kRetainedPayloadBudget - retained_payload_reserve_bytes_) {
                    session = std::make_shared<vsres::macos::PopoutSession>(
                        config, recovery_required, input_is_pending, std::move(retained_snapshot));
                    retained_sessions_.push_back(session);  // may throw only BEFORE launch
                    retained_payload_reserve_bytes_ += reserve;
                }
            }
        }
        if (!session) {
            status_param_->setValue("Companion session limit reached; no launch submitted");
            error_param_->setValue("Retained history is limited to 8 generations and 96 MiB of configuration/snapshot reserve. Existing files are retained. Copy any needed pending configuration files before removing/reloading this effect; host persistence is unconfirmed."
                + (previous ? " Latest session status path: " + previous->status_path() : std::string{}));
            return;
        }
        // Durable ownership above survives false/throw/unknown launch results.
        // Never delete its files or recycle capacity on an assumed failed start.
        if (session->launch()) {
            {
                std::lock_guard<std::mutex> lock(session_mutex_);
                popout_session_.swap(session);  // nonallocating/noexcept shared_ptr commit
            }
            // Owner request: the chain applies itself when the companion is
            // closed after Save and close — no second click in Resolve. The
            // manual Apply companion changes button remains as the fallback
            // when the exit observation is unavailable.
            schedule_auto_apply(popout_session_);
        }
    } else if (paramName == "_config") {
        // Honor host-driven undo/redo/restoration, including clearing the chain.
        std::string restored;
        config_param_->getValue(restored);
        store_cached_config(restored);
    } else if (paramName == "swap") {
        // Phase 1 swaps the in/out color management Choice params.
        vsres::log::info("host", "Swap pressed (no-op in Phase 0)");
    }
}

void VapourSynthPlugin::apply_popout_result(const std::string& result_json,
    const std::shared_ptr<vsres::macos::PopoutSession>& session, uint64_t revision) {
    if (result_json.empty()) {
        vsres::log::warn("host", "popout returned empty result; ignoring");
        return;
    }
    // Minimum transport shape checks already passed. Parse known composer
    // fields and preallocate state before mutation; this is no global validator.
    const vsres::Chain validated_chain = vsres::parse_chain(result_json);

    // PRE-ACCEPT VALIDATION. A chat-generated script step can carry an
    // invalid call (observed live: resize2.Bicubic(primaries_in='smpte431',
    // primaries_out='709') — both argument names invented by the model). Such
    // a chain fails at script-evaluation time on EVERY render, and render_chain
    // falls back to passthrough — the node silently stops deinterlacing with
    // no obvious connection to the edit the user just saved.
    //
    // Refuse instead: compose the script and evaluate it through a real
    // VSScript BEFORE accepting the revision. VapourSynth is lazy, so
    // evaluateBuffer is parse + graph build only (no frame rendering) —
    // cheap, and it catches exactly the bad-call class. On failure the
    // previous working chain keeps rendering, the pending file is retained,
    // and the banner shows the actual Python error.
    //
    // Only source-mode chains are validated here: they evaluate without OFX
    // frames. Clip-mode (Disabled) scripts bind the OFXSource filter, which
    // can only fetch inside a render action — evaluating one here would
    // spuriously fail. Those keep the previous accept-then-render behavior.
    {
        std::string validation_reason;
        vsres::SourceModeConfig parsed_mode = validated_chain.source_mode;
        const vsres::SourceMode mode = decide_source_mode(result_json, parsed_mode, &validation_reason);
        if (mode == vsres::SourceMode::Active || mode == vsres::SourceMode::ActiveTrimmed) {
            vsres::Chain validate_chain = validated_chain;
            validate_chain.source_mode.mode = mode;
            validate_chain.source_mode.fallback_reason = validation_reason;
            // Timeline dims from the OFX clip (the final source-mode upscale
            // target); dims do not affect evaluation success.
            const OfxRectD rod = src_clip_->getRegionOfDefinition(0.0);
            validate_chain.source_mode.timeline_width  = static_cast<int>(std::round(rod.x2 - rod.x1));
            validate_chain.source_mode.timeline_height = static_cast<int>(std::round(rod.y2 - rod.y1));
            const OfxRangeD range = src_clip_->getFrameRange();
            vsres::StepContext step_ctx{
                validate_chain.source_mode.timeline_width,
                validate_chain.source_mode.timeline_height,
                static_cast<int>(range.max - range.min) + 1,
                current_radius(result_json),
            };
            const std::string script = vsres::compose_script(validate_chain, step_ctx);
            const vsres::macos::VsRuntimeConfig rcfg{
                src_clip_, step_ctx.width, step_ctx.height, step_ctx.radius,
                static_cast<int>(range.min), static_cast<int>(range.max),
            };
            if (!validation_runtime_.open(result_json, script, rcfg)) {
                const std::string err = "Refused: the saved chain does not evaluate — "
                    + validation_runtime_.last_error()
                    + "\nThe previous chain keeps rendering. Fix the chain in the companion and save again.";
                vsres::log::error("host", "apply refused (validation): " + validation_runtime_.last_error());
                set_refusal_note(validation_runtime_.last_error());
                status_param_->setValue("Saved chain refused — see error");
                error_param_->setValue(err);
                write_status("config-apply-refused", err, "", 0);
                return;
            }
            vsres::log::info("host", "pre-accept validation passed (evaluateBuffer ok)");
        }
    }

    std::string accepted_config = result_json;
    std::string accepted_identity = result_json;
    // A revision is being accepted: any earlier refusal no longer describes
    // this node's state. Clear BEFORE the accept-path status write so the
    // predicted-state report is not overlaid.
    clear_refusal_note();
    try {
        config_param_->setValue(result_json);
        // C01 (2026-11-11): synchronize the OFX Mix parameter with the
        // ACCEPTED revision's mix. Native rendering reads the PARAMETER (the
        // host-side live control), so without this an applied recipe authored
        // at mix 0.25 previewed at quarter strength but rendered at the
        // parameter's default 1.0 — preview/export disagreement. The
        // parameter remains the live, animatable control afterwards, and the
        // render cache key carries the effective mix so changes invalidate.
        {
            double accepted_mix = static_cast<double>(validated_chain.mix);
            if (!std::isfinite(accepted_mix)) accepted_mix = 1.0;
            accepted_mix = std::max(0.0, std::min(1.0, accepted_mix));
            if (std::abs(accepted_mix - mix_param_->getValue()) > 1e-6) {
                mix_param_->setValue(accepted_mix);
                vsres::log::info("host", "mix parameter synchronized to accepted revision: "
                    + std::to_string(accepted_mix));
            }
        }
        store_cached_config(std::move(accepted_config));
        session->mark_applied(revision, std::move(accepted_identity));
    } catch (...) {
        // A host can change state/reenter _config before returning an error.
        // No rollback or no-effect assertion; retain the pending revision.
        try { write_status("config-apply-unconfirmed", "Host configuration write did not return success. State may have changed; inspect the host before another apply.", "", 0); }
        catch (...) { /* The host-write outcome is still unknown. */ }
        throw;
    }

    // Write a host-action report based on the accepted chain
    //    state, without waiting for Resolve to render. Resolve doesn't render
    //    proactively when the user is sitting in the popout — only on
    //    scrub/play/refresh — so without this the banner polls a stale status
    //    file from the last render and the user sees no change after clicking
    //    Approve.
    //
    //    Distinguish four "passthrough-like" states so the banner copy can be
    //    accurate (the previous lump of everything into "chain-empty" produced
    //    misleading messages like "all chain steps are disabled" when the chain
    //    had zero steps at all):
    //      - total == 0                       → "chain-empty"           (nothing to do)
    //      - total > 0 && enabled == 0        → "chain-disabled"        (steps exist, all toggled off)
    //      - enabled > 0 && approved == 0     → "chain-awaiting-approval" (all enabled are drafts)
    //      - approved > 0                     → "config-applied"        (render unconfirmed)
    {
        const vsres::Chain& preview_chain = validated_chain;
        // Same gate as the composer/status path (summarize_chain routes
        // through the same per-step approval+binding check) — a predicted
        // count must never claim steps that will not emit.
        const vsres::ComposeStats g =
            vsres::summarize_chain(preview_chain, vsres::StepContext{0, 0, 0, 0});
        const int total = g.total;
        const int enabled = g.enabled;
        const int approved_enabled = g.emitted;
        // Per-step trace so we can see exactly what arrived if the predicted
        // state looks wrong. Without this, "Chain has no enabled steps" gives
        // no clue whether the chain is genuinely empty or has steps with
        // enabled=false coming from somewhere. `bound=T` means the step
        // carries an approvedContent binding (which the composer compares).
        std::string per_step_trace;
        for (const auto& s : preview_chain.steps) {
            per_step_trace += "\n    " + s.id + " type=" + s.type
                            + " stage=" + std::to_string(s.stage)
                            + " enabled=" + (s.enabled ? "T" : "F")
                            + " approved=" + (s.approved ? "T" : "F")
                            + " bound=" + (!s.approved_content.empty() ? "T" : "F");
        }

        std::string predicted_state;
        if (total == 0)                          predicted_state = "chain-empty";
        else if (enabled == 0)                   predicted_state = "chain-disabled";
        else if (approved_enabled == 0)          predicted_state = "chain-awaiting-approval";
        else                                     predicted_state = "config-applied";

        write_status(predicted_state, "", "", approved_enabled > 0 ? approved_enabled : enabled);

        vsres::log::info("host",
            "predicted status: state=" + predicted_state
            + " total=" + std::to_string(total)
            + " enabled=" + std::to_string(enabled)
            + " approved=" + std::to_string(approved_enabled)
            + per_step_trace);
    }

    // Recovery copy only; the constructor never auto-restores this sidecar.
    // It is not a host-save or per-node persistence acknowledgement.
    //
    //    Single file (not keyed by node) — simple for the v2.0-alpha single-
    //    OFX-node use case. TKT-DIST replaces this with per-project sidecar
    //    files keyed by Resolve's clipPath + node UUID once we have OCIO +
    //    bundled runtime in place.
    {
        const char* home = std::getenv("HOME");
        if (home && *home) {
            std::string dir = std::string(home) + "/Library/Application Support/VapourSynth-OFX";
            // SECURITY (2026-11-11, security review #7 remainder): verify/create the
            // product directory chain (real dirs, owner-checked, 0700) before
            // any write; a symlinked component refuses the whole block.
            std::string dir_err;
            if (ensure_private_dir(dir, /*check_parents=*/true, &dir_err)) {
            // Accept-path: re-derive identity (the incoming chain may carry a
            // guid — adopt it — or none — fork, e.g. legacy configs).
            std::string accepted_json = result_json;
            ensure_node_guid(accepted_json);
            // Per-node sidecar, keyed by the stable GUID: node store/history
            // no longer overwrite each other (the old single last-config.json
            // mixed every node's recovery copy). The global file stays as a
            // compatibility pointer for older companion builds.
            if (valid_node_guid(node_guid_)) {
                std::string node_dir = dir + "/nodes";
                ensure_private_dir(node_dir, /*check_parents=*/false);
                std::string per_node = node_dir + "/" + node_guid_ + ".json";
                if (write_private_file(per_node, accepted_json)) {
                    vsres::log::info("host", "node sidecar persisted: " + per_node);
                }
            }
            std::string sidecar = dir + "/last-config.json";
            if (write_private_file(sidecar, accepted_json)) {
                vsres::log::info("host", "sidecar persisted: " + sidecar
                    + " (" + std::to_string(accepted_json.size()) + " bytes)");
            }
            } else {
                vsres::log::warn("host", "sidecar persistence skipped: " + dir_err);
            }
        }
    }

    // Update status summary. Parse the chain count so the Inspector shows useful info.
    const vsres::Chain& chain = validated_chain;
    int active = 0;
    int total_step_chars = 0;
    for (const auto& s : chain.steps) {
        if (s.enabled) ++active;
        total_step_chars += static_cast<int>(s.params_json.size());
    }
    // Log a structured summary so the user can `log stream` to confirm what arrived.
    // Format: "applying popout result: 12345 bytes → N steps (M enabled), CCCC chars of params".
    vsres::log::info("host", "applying popout result: "
        + std::to_string(result_json.size()) + " bytes → "
        + std::to_string(chain.steps.size()) + " step(s) ("
        + std::to_string(active) + " enabled), "
        + std::to_string(total_step_chars) + " chars of params");
    std::string summary;
    if (active == 0) summary = "Empty chain — passthrough";
    else summary = std::to_string(active) + (active == 1 ? " filter applied; render pending" : " filters applied; render pending");
    status_param_->setValue(summary);

    // Clear any prior error since we just accepted a fresh config.
    error_param_->setValue("");
}

// ----------------------------- Factory -----------------------------

class VapourSynthFactory : public OFX::PluginFactoryHelper<VapourSynthFactory> {
public:
    VapourSynthFactory()
        : OFX::PluginFactoryHelper<VapourSynthFactory>(kPluginIdentifier,
                                                      kPluginVersionMajor,
                                                      kPluginVersionMinor) {}

    void describe(OFX::ImageEffectDescriptor& desc) override {
        desc.setLabels(kPluginName, kPluginName, kPluginName);
        desc.setPluginGrouping(kPluginGrouping);
        desc.setPluginDescription(kPluginDescription);

        desc.addSupportedContext(OFX::eContextFilter);
        desc.addSupportedContext(OFX::eContextGeneral);
        desc.addSupportedBitDepth(OFX::eBitDepthFloat);

        desc.setSingleInstance(false);
        desc.setHostFrameThreading(false);
        desc.setSupportsTiles(false);
        desc.setTemporalClipAccess(true);
        desc.setRenderTwiceAlways(false);
        desc.setSupportsMultipleClipPARs(false);
        desc.setSupportsMultiResolution(false);
        desc.setSupportsMultipleClipDepths(false);
    }

    void describeInContext(OFX::ImageEffectDescriptor& desc, OFX::ContextEnum /*ctx*/) override {
        OFX::ClipDescriptor* src = desc.defineClip(kOfxImageEffectSimpleSourceClipName);
        src->addSupportedComponent(OFX::ePixelComponentRGBA);
        src->setTemporalClipAccess(true);
        src->setSupportsTiles(false);
        src->setIsMask(false);

        OFX::ClipDescriptor* dst = desc.defineClip(kOfxImageEffectOutputClipName);
        dst->addSupportedComponent(OFX::ePixelComponentRGBA);
        dst->setSupportsTiles(false);

        OFX::PageParamDescriptor* page = desc.definePageParam("Controls");

        // Color management header. These four Choice params are Phase 0 stubs —
        // Phase 1 was meant to wire them to the live OCIO config and the actual
        // render, and never did. render()/parse_chain() read color management
        // exclusively from cached_config_ (the popout's own NodeConfig JSON,
        // written on Accept — see composer.cpp), never from these OFX params, so
        // whatever a colorist sets here in Resolve's own Inspector has silently
        // done nothing since Phase 0. Confirmed a real support case: a colorist
        // reasonably tried these first (they're right there in Resolve, before
        // ever opening the popout) and got a "mismatch" warning that pointed at
        // a completely different, correct set of values they'd already set in
        // the popout — two color-management surfaces, only one of them live.
        //
        // Disabling + relabeling rather than removing: removing an OFX param
        // some saved project already references by name is the kind of thing
        // that breaks a re-opened project in a way that's hard to diagnose.
        // Disabled+labeled is honest immediately, in Resolve's own UI, without
        // that risk. Fully wiring these to OCIO for real is a separate, larger
        // piece of work — tracked, not attempted here.
        OFX::GroupParamDescriptor* cm_group = desc.defineGroupParam("colorManagement");
        cm_group->setLabels("Color Management (set in popout)", "Color Management (set in popout)",
                             "Color Management (set in popout)");

        auto make_choice = [&](const char* id, const char* label,
                               const std::vector<std::string>& options, int default_idx) {
            OFX::ChoiceParamDescriptor* p = desc.defineChoiceParam(id);
            p->setLabels(label, label, label);
            for (const auto& opt : options) p->appendOption(opt);
            p->setDefault(default_idx);
            p->setParent(*cm_group);
            p->setEnabled(false);
            p->setHint("Not connected to the render — has no effect. Color management is read "
                       "from the popout's own Input/Output Color Space and Gamma dropdowns "
                       "(Configure... -> Pipeline tab). This control is a placeholder from an "
                       "earlier phase that was never wired up; left visible, disabled, rather "
                       "than removed, so it can't silently contradict the popout's real setting.");
            return p;
        };

        // Same options as before — still not live, but this fix isn't the place
        // to also relitigate the option list itself.
        const std::vector<std::string> color_spaces =
            {"Rec.709", "Rec.2020", "DCI-P3", "ACES2065-1", "ACEScg", "sRGB"};
        const std::vector<std::string> gammas =
            {"BT.1886", "sRGB", "Linear", "PQ", "HLG", "Gamma 2.4"};
        page->addChild(*make_choice("inputColorSpace",  "Input Color Space (inactive)",  color_spaces, 0));
        page->addChild(*make_choice("inputGamma",       "Input Gamma (inactive)",        gammas,       0));
        page->addChild(*make_choice("outputColorSpace", "Output Color Space (inactive)", color_spaces, 0));
        page->addChild(*make_choice("outputGamma",      "Output Gamma (inactive)",       gammas,       0));

        OFX::PushButtonParamDescriptor* swap = desc.definePushButtonParam("swap");
        swap->setLabels("Swap", "Swap In/Out", "Swap In/Out");
        swap->setParent(*cm_group);
        page->addChild(*swap);

        OFX::DoubleParamDescriptor* mix = desc.defineDoubleParam("mix");
        mix->setLabels("Mix", "Master Mix", "Master Mix");
        mix->setRange(0.0, 1.0);
        mix->setDisplayRange(0.0, 1.0);
        mix->setDefault(1.0);
        mix->setHint("Wet/dry blend at the end of the filter chain.");
        page->addChild(*mix);

        OFX::PushButtonParamDescriptor* configure = desc.definePushButtonParam("configure");
        configure->setLabels("Configure…", "Configure…", "Configure filter chain");
        configure->setHint("Edit and save in the companion. Saving and closing applies your edits to this node automatically.");
        page->addChild(*configure);

        // "Apply companion changes" button removed: the companion-exit
        // observer auto-applies the saved revision through the same path the
        // button used (schedule_auto_apply / auto_apply_from_session). The
        // button was a manual second click after every Save and close; the
        // exit watcher is the qualified path now. If observation ever fails,
        // the next Configure press recovers the pending revision for review.

        OFX::StringParamDescriptor* status = desc.defineStringParam("status");
        status->setLabels("Status", "Status", "Status");
        status->setStringType(OFX::eStringTypeSingleLine);
        status->setDefault("Empty chain — passthrough");
        status->setEnabled(false);
        page->addChild(*status);

        OFX::StringParamDescriptor* config = desc.defineStringParam("_config");
        config->setLabels("_config", "_config", "Internal chain JSON");
        config->setStringType(OFX::eStringTypeMultiLine);
        config->setDefault("");
        config->setIsSecret(true);
        // CRITICAL: explicit setIsPersistant + setAnimates(false) so Resolve
        // serializes this string param to the .drp project file on save and
        // restores it on project load. Without these, observed behavior in
        // Resolve 21 is: chain edits hold within a single session but vanish
        // after Resolve quit/reopen because the param's value never made it to
        // the project file. The OFX spec defaults kOfxParamPropPersistant to 1,
        // but Resolve's actual save logic seems gated on more than that for
        // multiline secret string params (probably because most hosts wouldn't
        // dream of using a 9 KB JSON blob as a string param).
        config->setIsPersistant(true);
        config->setAnimates(false);
        config->setEvaluateOnChange(true);   // change → re-render (matches our cached_config_ invalidation contract)
        page->addChild(*config);

        OFX::StringParamDescriptor* error = desc.defineStringParam("_errorMessage");
        error->setLabels("_errorMessage", "_errorMessage", "Last error");
        error->setStringType(OFX::eStringTypeMultiLine);
        error->setDefault("");
        error->setEnabled(false);
        error->setIsSecret(true);
        // Error string is per-session diagnostic; we DO want it not animated
        // but we don't need it persisted across project save.
        error->setIsPersistant(false);
        error->setAnimates(false);
        page->addChild(*error);
    }

    OFX::ImageEffect* createInstance(OfxImageEffectHandle handle,
                                     OFX::ContextEnum /*ctx*/) override {
        return new VapourSynthPlugin(handle);
    }
};

}  // namespace

namespace OFX {
namespace Plugin {

// One-time process-global init that runs before any VS core gets created.
// Reason it exists: VS R75 changed its plugin search model — it no longer auto-
// scans ~/Library/Application Support/VapourSynth/Plugins/ the way older VS did.
// R75 looks at <vapoursynth.so>/plugins/ AND $VAPOURSYNTH_EXTRA_PLUGIN_PATH. The
// former is inside the VS install tree (fragile); the latter is the documented
// extension point. We point it at the user plugin dir so the install-vs-ecosystem
// script's symlinks become discoverable.
//
// setenv() with overwrite=0 means we respect a value the user already set in
// their environment.
static void ensure_vs_plugin_path() {
    const char* home = std::getenv("HOME");
    if (!home || !*home) return;
    // PORTABLE BUNDLE STAND-DOWN (beta.1 fix, 2026-11-12): when THIS bundle
    // stages its own curated plugin set (Contents/Plugins), the bundle must
    // win. Pre-setting the USER dir here made vs_runtime's override guard
    // (correctly) refuse to load the staged set — live fallout: Resolve
    // sessions evaluated chains against machine-specific plugins instead of
    // the shipped, audited ones. Dev trees without Contents/Plugins keep the
    // legacy behavior (user-dir symlinks stay discoverable).
    {
        Dl_info info = {};
        if (dladdr(reinterpret_cast<void*>(&ensure_vs_plugin_path), &info) && info.dli_fname) {
            std::filesystem::path exe_dir = std::filesystem::path(info.dli_fname).parent_path();
            std::error_code ec;
            if (std::filesystem::is_directory(exe_dir.parent_path() / "Plugins", ec)) {
                vsres::log::info("host",
                    "portable bundle stages its own plugins — user-dir path shim stood down");
                return;
            }
        }
    }
    std::string user_plugins = std::string(home) + "/Library/Application Support/VapourSynth/Plugins";
    setenv("VAPOURSYNTH_EXTRA_PLUGIN_PATH", user_plugins.c_str(), 0);
}

// Tell Python where our `vapoursynth` package lives. VSScript's internal init
// (libvsscript.dylib::realInit) calls Py_Initialize + PyImport_ImportModule("vapoursynth").
// Python's default sys.path is derived from the Python executable in the TOML
// (Homebrew's python3.14), which knows about Homebrew's site-packages — but NOT
// our private vendor prefix where we built VS R75. Without PYTHONPATH set,
// the import fails with "Failed to import the VapourSynth Python module" and
// every chain falls back to passthrough.
//
// VSRES_VS_SITE_PACKAGES is baked at build time by CMakeLists.txt from
// VSRES_VS_PREFIX. The realpath substitution there resolves the
// vendor/vapoursynth/active → install-R75 symlink so the path matches what
// dyld already shows for libvsscript.
static void ensure_vs_python_path() {
    // PORTABLE BUNDLE FIRST: when the OFX bundle embeds its own vs-python
    // package (Contents/Resources/vs-python — VSRES_PORTABLE_BUNDLE staging),
    // prefer it over any compile-time dev path so the bundle is portable.
    // Resolve this bundle's own directory via dladdr on a local symbol.
    std::string bundle_vs_python;
    {
        Dl_info info = {};
        if (dladdr(reinterpret_cast<void*>(&ensure_vs_python_path), &info) && info.dli_fname) {
            std::string macos_dir(info.dli_fname);  // .../Contents/MacOS/VapourSynth.ofx
            const auto slash = macos_dir.find_last_of('/');
            if (slash != std::string::npos) {
                bundle_vs_python = macos_dir.substr(0, slash) + "/../Resources/vs-python";
                struct stat st;
                if (!stat(bundle_vs_python.c_str(), &st) && S_ISDIR(st.st_mode)) {
                    std::string env_val = bundle_vs_python;
                    if (const char* existing = std::getenv("PYTHONPATH"); existing && *existing) {
                        env_val += ":";
                        env_val += existing;
                    }
                    setenv("PYTHONPATH", env_val.c_str(), 1);
                    vsres::log::info("host", "PYTHONPATH=" + bundle_vs_python + " (portable bundle)");
                    return;
                }
            }
        }
    }
#ifdef VSRES_VS_SITE_PACKAGES
    // Homebrew's python3.14 ships with its OWN `vapoursynth.so` (R73) at
    // /opt/homebrew/lib/python3.14/site-packages/vapoursynth.so. When VS R75
    // initializes Python via the path in vapoursynth.toml (Homebrew's python3.14),
    // Python's default sys.path includes that site-packages dir. If our R75
    // path isn't FIRST on sys.path, `import vapoursynth` picks up Homebrew's
    // R73 .so, which is ABI-incompatible with our R75 libvapoursynth.4.dylib
    // already loaded in the process → import fails.
    //
    // We must prepend our path to PYTHONPATH (Python prepends PYTHONPATH to
    // sys.path during Py_Initialize), and we MUST use overwrite=1 — if Resolve
    // happens to have PYTHONPATH set (even to empty), setenv(...,0) silently
    // refuses and Homebrew's R73 wins the import race.
    const char* existing = std::getenv("PYTHONPATH");
    std::string newval = VSRES_VS_SITE_PACKAGES;
    if (existing && *existing) {
        newval += ":";
        newval += existing;
    }
    setenv("PYTHONPATH", newval.c_str(), 1);

    // Log so we can `log stream` and confirm the env actually changed inside
    // Resolve's process. Without this, "Failed to import vapoursynth" is
    // ambiguous between "PYTHONPATH never got set" and "PYTHONPATH set but
    // Python ignored it".
    vsres::log::info("host", std::string("PYTHONPATH=") + (std::getenv("PYTHONPATH") ?: "(unset)"));
#endif
}

// Self-check at bundle load: detect "this binary was built on someone else's
// machine and the runtime they expected isn't on this Mac" — the classic
// developer-build-shared-with-another-user failure mode. Without this check,
// the bundle silently produces "Failed to acquire VSScript API" or "Failed to
// import VapourSynth Python module" on every render and the user has no idea
// the bundle was never meant to leave the build machine.
//
// This is the dev-build safety net. TKT-DIST replaces it with a self-contained
// Resources/vs-runtime/ that's correct on every Mac.
static void check_runtime_environment_or_warn() {
#ifdef VSRES_VS_SITE_PACKAGES
    struct stat st;
    if (stat(VSRES_VS_SITE_PACKAGES, &st) != 0) {
        // The baked PYTHONPATH doesn't exist on this machine — this bundle was
        // not built for this user. The chain-error banner will eventually show a
        // VSScript error, but log a much clearer one here so `log stream` finds it.
        vsres::log::error("host",
            std::string("RUNTIME MISSING: this OFX bundle expects VapourSynth at\n  ")
            + VSRES_VS_SITE_PACKAGES
            + "\nbut that path doesn't exist on this machine.\n"
              "This is the dev build's known limitation — it was built with absolute\n"
              "paths that only resolve on the build machine. If you got this bundle\n"
              "from someone else, you need to either:\n"
              "  (a) rebuild from source on this machine (scripts/build-vapoursynth.sh\n"
              "       + cmake -B build + cmake --build build), or\n"
              "  (b) wait for the release which ships a self-contained bundle.\n"
              "TKT-DIST tracks this — see docs/packaging.md in the source repository.");
    }
#endif
    // We'd also like to check ~/.config/vapoursynth/vapoursynth.toml here, but the
    // check is non-trivial: the TOML is keyed by the libvsscript path the OFX
    // binary links against. We can read otool-style or use dladdr() but it adds
    // complexity. Skipping for now — the VSScript-init error message we plumbed
    // through getVSScriptAPILastError() already tells the user what's missing.
}

void getPluginIDs(PluginFactoryArray& factories) {
    ensure_vs_plugin_path();
    ensure_vs_python_path();
    check_runtime_environment_or_warn();
    static VapourSynthFactory factory;
    factories.push_back(&factory);
}
}  // namespace Plugin
}  // namespace OFX
