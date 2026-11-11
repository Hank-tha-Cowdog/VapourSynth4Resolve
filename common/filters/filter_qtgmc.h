#pragma once

// Native QTGMC filter node (Phase 2) — emits a havsfunc.QTGMC call from typed
// params instead of a freeform Script body. First of the dedicated filter nodes
// (QTGMC → BM3D → RIFE per the Phase 2 plan).

#include "filter.h"

namespace vsres {

class QTGMCFilter : public IFilter {
public:
    const char* type_id() const override { return "qtgmc"; }
    Stage canonical_stage() const override { return Stage::FieldOps; }
    ScriptFragment emit(const StepParams& params, const StepContext& ctx) const override;
};

}  // namespace vsres
