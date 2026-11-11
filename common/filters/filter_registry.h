#pragma once

#include "filter.h"
#include <memory>
#include <string>
#include <vector>

namespace vsres {

// Single source of truth for available filter types. The OFX side queries this to dispatch
// chain steps to generators; the popout exports a TS mirror to populate its Filter Library.
class FilterRegistry {
public:
    static FilterRegistry& instance();

    void register_filter(std::unique_ptr<IFilter> filter);
    const IFilter* find(const std::string& type_id) const;

    struct Entry {
        std::string type_id;
        Stage stage;
        bool stage_user_selectable;
    };
    std::vector<Entry> list() const;

private:
    FilterRegistry() = default;
    std::vector<std::unique_ptr<IFilter>> filters_;
};

// Phase 0: registers the built-in filters (Script). Phase 2+: QTGMC, etc.
void register_builtin_filters();

}  // namespace vsres
