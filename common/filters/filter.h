#pragma once

// Filter step interface.
//
// Each filter type (Script, QTGMC, future Denoise/AI/etc.) declares a canonical stage and
// emits a VS Python fragment from its JSON params. The chain composer threads fragments
// together in stage order.

#include <string>

namespace vsres {

// Canonical pipeline stages — see docs/architecture.md for rationale.
enum class Stage : int {
    Preprocess     = 10,
    FieldOps       = 20,
    Crop           = 30,
    Denoise        = 40,
    Restore        = 50,
    Sharpen        = 60,
    FrameOps       = 70,
    Resize         = 80,
    Format         = 90,
};

const char* stage_name(Stage s);

// Opaque JSON params slice for a single step. Phase 1 uses nlohmann::json under the hood;
// kept as std::string here so the public surface doesn't leak a JSON lib choice.
struct StepParams {
    std::string json;
};

struct StepContext {
    int width;
    int height;
    int frame_count;
    int radius;
};

// Output of a filter generator — the Python fragment that transforms `clip` and any
// out-of-band imports it needs.
struct ScriptFragment {
    std::string imports;  // e.g. "import havsfunc as havs\n"
    std::string body;     // e.g. "clip = havs.QTGMC(clip, Preset='Slow')\n"
};

// Filter implementations subclass this and register themselves via filter_registry.
class IFilter {
public:
    virtual ~IFilter() = default;
    virtual const char* type_id() const = 0;
    virtual Stage canonical_stage() const = 0;
    virtual bool stage_user_selectable() const { return false; }  // Script overrides to true
    virtual ScriptFragment emit(const StepParams& params, const StepContext& ctx) const = 0;
};

}  // namespace vsres
