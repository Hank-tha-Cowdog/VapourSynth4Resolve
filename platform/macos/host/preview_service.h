#pragma once

// Watches a popout-written preview-request JSON file. On each request, renders the
// in-progress chain against the plugin's cached source frame (captured during the
// most recent OFX render()) and writes the result as a 16-bit PNG.
//
// Runs on a private serial dispatch queue, separate from Resolve's render thread,
// so the popout's preview iterations don't block the OFX pipeline.
//
// Owned by PopoutSession — request/response file paths are created in $TMPDIR and
// passed to the spawned Electron app as --preview-request-path / --preview-response-path
// arguments.

#include <dispatch/dispatch.h>

#include <atomic>
#include <functional>
#include <memory>
#include <string>
#include <vector>

namespace vsres::macos {

struct PreviewSourceSnapshot {
    std::vector<float> rgba;  // interleaved float32 RGBA, top-to-bottom rows
    int width = 0;
    int height = 0;
    double timecode = 0.0;
};

class PreviewService {
public:
    // Called every preview request. Must fill `out` with the most recent source frame
    // and return true. If no source is available yet (no Resolve render has happened),
    // return false and the request fails politely.
    using SourceProvider = std::function<bool(PreviewSourceSnapshot& out)>;

    PreviewService(std::string request_path,
                   std::string response_png_path,
                   SourceProvider source_provider);
    ~PreviewService();

    PreviewService(const PreviewService&) = delete;
    PreviewService& operator=(const PreviewService&) = delete;

    // Initializes the file watcher. Returns false if the request file can't be opened.
    bool start();

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

}  // namespace vsres::macos
