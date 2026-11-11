#include "filter_registry.h"
#include "filter_script.h"
#include "filter_qtgmc.h"

namespace vsres {

const char* stage_name(Stage s) {
    switch (s) {
        case Stage::Preprocess: return "Preprocess";
        case Stage::FieldOps:   return "Field Ops";
        case Stage::Crop:       return "Crop";
        case Stage::Denoise:    return "Denoise";
        case Stage::Restore:    return "Restore";
        case Stage::Sharpen:    return "Sharpen";
        case Stage::FrameOps:   return "Frame Ops";
        case Stage::Resize:     return "Resize";
        case Stage::Format:     return "Format";
    }
    return "Unknown";
}

FilterRegistry& FilterRegistry::instance() {
    static FilterRegistry inst;
    return inst;
}

void FilterRegistry::register_filter(std::unique_ptr<IFilter> filter) {
    filters_.push_back(std::move(filter));
}

const IFilter* FilterRegistry::find(const std::string& type_id) const {
    for (const auto& f : filters_) {
        if (type_id == f->type_id()) return f.get();
    }
    return nullptr;
}

std::vector<FilterRegistry::Entry> FilterRegistry::list() const {
    std::vector<Entry> out;
    out.reserve(filters_.size());
    for (const auto& f : filters_) {
        out.push_back({f->type_id(), f->canonical_stage(), f->stage_user_selectable()});
    }
    return out;
}

void register_builtin_filters() {
    auto& r = FilterRegistry::instance();
    r.register_filter(std::make_unique<ScriptFilter>());
    r.register_filter(std::make_unique<QTGMCFilter>());  // Phase 2: first native node
    // Phase 2 (next): BM3DFilter, RIFEFilter.
}

}  // namespace vsres
