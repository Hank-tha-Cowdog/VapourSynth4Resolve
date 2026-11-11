#pragma once

#include "filter.h"

namespace vsres {

// Freeform Python step. Emits the user's `params.code` verbatim as the body fragment.
// Stage is user-selectable; defaults to Preprocess if the JSON omits it.
class ScriptFilter : public IFilter {
public:
    const char* type_id() const override { return "script"; }
    Stage canonical_stage() const override { return Stage::Preprocess; }
    bool stage_user_selectable() const override { return true; }
    ScriptFragment emit(const StepParams& params, const StepContext& ctx) const override;
};

}  // namespace vsres
