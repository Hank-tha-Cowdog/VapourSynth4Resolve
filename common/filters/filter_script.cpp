#include "filter_script.h"
#include "../config/config.h"

namespace vsres {

ScriptFragment ScriptFilter::emit(const StepParams& params, const StepContext& /*ctx*/) const {
    ScriptFragment frag;
    frag.imports = "";

    auto j = config::parse(params.json);
    std::string code = j.value("code", std::string("# empty script step"));
    if (code.empty() || code.back() != '\n') code += '\n';
    frag.body = std::move(code);

    return frag;
}

}  // namespace vsres
