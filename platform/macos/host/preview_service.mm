#import <Foundation/Foundation.h>

#include <dispatch/dispatch.h>
#include <fcntl.h>
#include <unistd.h>
#include <fstream>
#include <memory>
#include <sstream>

#include <VapourSynth4.h>
#include <VSScript4.h>

#include "preview_service.h"
#include "frame_io.h"

#include "../../../common/chain/composer.h"
#include "../../../common/config/config.h"
#include "../../../common/filters/filter_registry.h"
#include "../../../common/logging/log.h"

namespace vsres::macos {

namespace {

std::string read_file(const std::string& path) {
    std::ifstream in(path);
    if (!in.is_open()) return {};
    std::ostringstream ss;
    ss << in.rdbuf();
    return ss.str();
}

// Source-filter callback for the preview VS pipeline. Returns the popout-cached source
// frame as a VSFrame. We pull rgba/w/h from instance data; the source provider runs
// once per request (in the dispatch handler) and the snapshot is copied here.
struct PreviewSourceData {
    std::vector<float> rgba;  // owned copy, interleaved top-to-bottom
    VSVideoInfo vi{};
};

const VSFrame* VS_CC preview_source_get_frame(
    int /*n*/, int activation_reason, void* instance_data,
    void** /*frame_data*/, VSFrameContext* frame_ctx,
    VSCore* core, const VSAPI* api)
{
    if (activation_reason != arInitial) return nullptr;
    auto* d = static_cast<PreviewSourceData*>(instance_data);
    if (!d) {
        api->setFilterError("Preview source missing instance data", frame_ctx);
        return nullptr;
    }

    VSFrame* f = api->newVideoFrame(&d->vi.format, d->vi.width, d->vi.height, nullptr, core);
    if (!f) {
        api->setFilterError("Preview source frame alloc failed", frame_ctx);
        return nullptr;
    }

    // Split interleaved RGBA into planar RGB (we drop alpha; preview is RGB).
    const int w = d->vi.width;
    const int h = d->vi.height;
    float* r = reinterpret_cast<float*>(api->getWritePtr(f, 0));
    float* g = reinterpret_cast<float*>(api->getWritePtr(f, 1));
    float* b = reinterpret_cast<float*>(api->getWritePtr(f, 2));
    const ptrdiff_t rs = api->getStride(f, 0) / static_cast<ptrdiff_t>(sizeof(float));
    const ptrdiff_t gs = api->getStride(f, 1) / static_cast<ptrdiff_t>(sizeof(float));
    const ptrdiff_t bs = api->getStride(f, 2) / static_cast<ptrdiff_t>(sizeof(float));

    for (int y = 0; y < h; ++y) {
        const float* src_row = d->rgba.data() + static_cast<size_t>(y) * w * 4;
        float* rr = r + y * rs;
        float* gr = g + y * gs;
        float* br = b + y * bs;
        for (int x = 0; x < w; ++x) {
            rr[x] = src_row[x * 4 + 0];
            gr[x] = src_row[x * 4 + 1];
            br[x] = src_row[x * 4 + 2];
        }
    }
    return f;
}

void VS_CC preview_source_free(void* instance_data, VSCore* /*core*/, const VSAPI* /*api*/) {
    delete static_cast<PreviewSourceData*>(instance_data);
}

// One-shot preview render. Builds a fresh VSCore+VSScript every call so we don't
// collide with the plugin's main vs_runtime. Slow path (a few hundred ms — many
// seconds for heavy filters) but isolated and predictable.
bool render_preview_to_png(const std::string& chain_json,
                            float mix,
                            const PreviewSourceSnapshot& source,
                            const std::string& out_png_path,
                            std::string* out_error)
{
    const VSSCRIPTAPI* sapi = getVSScriptAPI(VSSCRIPT_API_VERSION);
    if (!sapi) {
        const char* detail = getVSScriptAPILastError();
        if (out_error) {
            *out_error = (detail && *detail)
                ? std::string("VSScript init failed: ") + detail
                : std::string("no VSScript API (no detail)");
        }
        return false;
    }
    const VSAPI* api = sapi->getVSAPI(VAPOURSYNTH_API_VERSION);
    if (!api)  { if (out_error) *out_error = "no VSAPI"; return false; }

    const auto free_core = [api](VSCore* p) { api->freeCore(p); };
    std::unique_ptr<VSCore, decltype(free_core)> core_owner(api->createCore(0), free_core);
    if (!core_owner) { if (out_error) *out_error = "createCore failed"; return false; }
    VSCore* core = core_owner.get();

    // createScript consumes the core even on failure. Transfer it before creating
    // any node/frame references that could otherwise outlive a failed transfer.
    const auto free_script = [sapi](VSScript* p) { sapi->freeScript(p); };
    std::unique_ptr<VSScript, decltype(free_script)> script_owner(
        sapi->createScript(core_owner.release()), free_script);
    if (!script_owner) { if (out_error) *out_error = "createScript failed"; return false; }

    // Reverse destruction order releases frames/nodes/maps before the script
    // (which owns the core), including early returns and C++ stack unwinding.
    auto data = std::make_unique<PreviewSourceData>();
    data->rgba = source.rgba;  // copy — small relative to render time
    data->vi.width = source.width;
    data->vi.height = source.height;
    data->vi.numFrames = 1;
    if (!api->queryVideoFormat(&data->vi.format, cfRGB, stFloat, 32, 0, 0, core)) {
        if (out_error) *out_error = "queryVideoFormat failed";
        return false;
    }

    const auto free_node = [api](VSNode* p) { api->freeNode(p); };
    std::unique_ptr<VSNode, decltype(free_node)> source_node(api->createVideoFilter2(
        "PreviewSource", &data->vi,
        preview_source_get_frame, preview_source_free,
        fmUnordered, nullptr, 0, data.get(), core), free_node);
    if (!source_node) {
        if (out_error) *out_error = "createVideoFilter2 failed";
        return false;
    }
    data.release();  // The successfully created node now owns its instance data.

    auto chain = vsres::parse_chain(chain_json);
    chain.mix = mix;

    // TKT-SRC: if the chain has a source file path, run the preview in
    // source-mode (VS loads the file directly via lsmas, ignoring the
    // cached-frame source_node). This is what makes preview work when the
    // user just identified a source and the OFX-side cache is still empty —
    // we don't need Resolve to have rendered anything yet, the chain has
    // everything it needs to read the file itself.
    //
    // parse_chain leaves chain.source_mode.mode at Disabled by default
    // (that's plugin_entry.cpp's call in the OFX render path because the
    // mode also depends on file-existence stat checks and retime detection).
    // For the preview we trust the path: if it's set, try source-mode. If
    // lsmas can't open it, evaluateBuffer below errors out cleanly and the
    // colorist sees the failure in the popout banner.
    const bool use_source_mode = !chain.source_mode.source_file_path.empty();
    if (use_source_mode) {
        chain.source_mode.mode = vsres::SourceMode::Active;
        // Preview always renders at source-native dims (no final upscale to
        // a timeline). Timeline_w/h = 0 tells compose_script to skip the
        // Spline36 upscale block.
        chain.source_mode.timeline_width  = 0;
        chain.source_mode.timeline_height = 0;
    }

    vsres::StepContext ctx{source.width, source.height, 1, 0};
    const std::string script = vsres::compose_script(chain, ctx);

    const auto free_map = [api](VSMap* p) { api->freeMap(p); };
    std::unique_ptr<VSMap, decltype(free_map)> vars(api->createMap(), free_map);
    if (!vars) { if (out_error) *out_error = "createMap failed"; return false; }
    // mapConsumeNode consumes this reference even when it reports an error.
    if (api->mapConsumeNode(vars.get(), "source", source_node.release(), maAppend)) {
        if (out_error) *out_error = "mapConsumeNode failed";
        return false;
    }
    if (sapi->setVariables(script_owner.get(), vars.get())) {
        if (out_error) *out_error = "setVariables failed";
        return false;
    }
    vars.reset();

    if (sapi->evaluateBuffer(script_owner.get(), script.c_str(), "Preview.vpy")) {
        const char* detail = sapi->getError(script_owner.get());
        if (out_error) *out_error = detail ? detail : "preview script evaluation failed";
        return false;
    }

    std::unique_ptr<VSNode, decltype(free_node)> output(sapi->getOutputNode(script_owner.get(), 0), free_node);
    if (!output) {
        if (out_error) *out_error = "preview script did not call set_output()";
        return false;
    }

    char err_buf[1024]{};
    const auto free_frame = [api](const VSFrame* p) { api->freeFrame(p); };
    std::unique_ptr<const VSFrame, decltype(free_frame)> frame(
        api->getFrame(0, output.get(), err_buf, sizeof(err_buf)), free_frame);
    if (!frame) {
        if (out_error) *out_error = std::string("getFrame: ") + err_buf;
        return false;
    }
    const bool ok = frame_io::save_vs_frame_as_png(frame.get(), api, out_png_path);
    if (!ok && out_error) *out_error = "PNG write failed";
    return ok;
}

}  // namespace

struct PreviewService::Impl {
    std::string req_path;
    std::string resp_png_path;
    SourceProvider source_provider;

    int request_fd = -1;
    dispatch_source_t source = nullptr;
    dispatch_queue_t queue = nullptr;
    std::atomic<bool> rendering{false};

    ~Impl() {
        if (source) {
            dispatch_source_cancel(source);
            source = nullptr;
        }
        if (request_fd >= 0) {
            close(request_fd);
            request_fd = -1;
        }
        if (queue) {
            // dispatch queues are ARC-managed; releasing the ObjC++ reference goes
            // through dispatch_release on non-ARC or just clears the strong ref under
            // ARC. We're built with -fobjc-arc by default; this is a no-op there.
            queue = nullptr;
        }
        if (!req_path.empty()) unlink(req_path.c_str());
        if (!resp_png_path.empty()) unlink(resp_png_path.c_str());
    }

    void handle_request() {
        // Drain the file: read latest contents, kick off render off the watcher thread.
        std::string request_json = read_file(req_path);
        if (request_json.empty()) return;

        // Coalesce: if a render is already in flight, the in-flight one will see the
        // latest file contents when it returns. Don't queue up multiple renders.
        bool expected = false;
        if (!rendering.compare_exchange_strong(expected, true)) return;

        dispatch_async(queue, ^{
            std::string current = read_file(req_path);

            // Parse the request JSON to extract chain + mix + (optional) requestId.
            auto j = vsres::config::parse(current);
            std::string chain_json;
            float mix = 1.0f;
            if (j.is_object()) {
                if (j.contains("chain") && j["chain"].is_string()) {
                    chain_json = j.value("chain", std::string{});
                } else {
                    // Allow the entire request JSON to BE the chain (simpler popout side).
                    chain_json = current;
                }
                if (j.contains("mix") && j["mix"].is_number()) {
                    mix = j.value("mix", 1.0f);
                }
            } else {
                chain_json = current;
            }

            PreviewSourceSnapshot snap;
            const bool have_source = source_provider(snap);

            // TKT-SRC: detect source-mode chains by peeking at the JSON for a
            // clipMetadata.source.filePath. If present, the chain loads from
            // disk via lsmas — no need for a cached OFX source frame. Skip
            // the "scrub Resolve once" gate so the preview works the moment
            // the colorist identifies a source.
            bool source_mode_capable = false;
            try {
                auto cj = vsres::config::parse(chain_json);
                if (cj.is_object() && cj.contains("clipMetadata")
                    && cj["clipMetadata"].is_object()
                    && cj["clipMetadata"].contains("source")
                    && cj["clipMetadata"]["source"].is_object()) {
                    const auto& src = cj["clipMetadata"]["source"];
                    const std::string path = src.value("filePath", std::string{});
                    source_mode_capable = !path.empty()
                        && !src.value("fileMissing", false)
                        && !src.value("retimeDetected", false);
                }
            } catch (...) { /* fall through; not source-mode */ }

            const bool snap_usable = have_source
                && !snap.rgba.empty()
                && snap.width > 0 && snap.height > 0;

            if (!snap_usable && !source_mode_capable) {
                log::warn("preview", "no source frame cached yet; scrub the Resolve timeline once first");
                rendering.store(false);
                return;
            }
            if (!snap_usable && source_mode_capable) {
                // We'll let lsmas read the source directly. Fill snap with a
                // 1x1 placeholder so the source filter the preview pipeline
                // builds doesn't crash on zero dims even though nothing
                // downstream consumes it.
                snap.rgba.assign(4, 0.0f);  // 1×1 RGBA float zeros
                snap.width  = 1;
                snap.height = 1;
                snap.timecode = 0.0;
                log::info("preview", "source-mode preview — loading via lsmas, ignoring empty cached frame");
            }

            std::string err;
            const bool ok = render_preview_to_png(chain_json, mix, snap, resp_png_path, &err);
            if (!ok) {
                log::error("preview", "render_preview_to_png failed: " + err);
            } else {
                log::info("preview", "preview written to " + resp_png_path
                                       + " (" + std::to_string(snap.width) + "x"
                                       + std::to_string(snap.height) + ")");
            }
            rendering.store(false);
        });
    }

    bool start() {
        // The request file is created empty up front so the watcher has an fd to bind.
        std::ofstream creat(req_path);
        creat.close();
        request_fd = open(req_path.c_str(), O_RDONLY);
        if (request_fd < 0) {
            log::error("preview", "open(request_path) failed");
            return false;
        }

        queue = dispatch_queue_create("com.vapoursynth.resolveofx.preview", DISPATCH_QUEUE_SERIAL);

        source = dispatch_source_create(DISPATCH_SOURCE_TYPE_VNODE, request_fd,
                                        DISPATCH_VNODE_WRITE | DISPATCH_VNODE_EXTEND,
                                        queue);
        if (!source) {
            log::error("preview", "dispatch_source_create failed");
            close(request_fd);
            request_fd = -1;
            return false;
        }
        __block Impl* self_impl = this;
        dispatch_source_set_event_handler(source, ^{
            self_impl->handle_request();
        });
        dispatch_resume(source);
        return true;
    }
};

PreviewService::PreviewService(std::string request_path,
                                std::string response_png_path,
                                SourceProvider source_provider)
    : impl_(std::make_unique<Impl>()) {
    impl_->req_path = std::move(request_path);
    impl_->resp_png_path = std::move(response_png_path);
    impl_->source_provider = std::move(source_provider);
}

PreviewService::~PreviewService() = default;

bool PreviewService::start() {
    return impl_->start();
}

}  // namespace vsres::macos
