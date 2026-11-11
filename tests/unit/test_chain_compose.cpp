// Minimal stand-alone composer smoke test. Wired via add_executable in tests/CMakeLists.txt.
// Catch2 lands in a later commit; for now this is a `return 0 / != 0` runner.

#include "../../common/chain/composer.h"
#include "../../common/chain/rate_contract.h"
#include "../../common/identity/guid.h"
#include "../../common/filters/filter_registry.h"
#include "../../common/color/color.h"
#include "../../common/config/config.h"

#include <cmath>
#include <cstdio>
#include <fstream>
#include <locale>
#include <sstream>
#include <string>

#ifndef VSRES_TEST_FIXTURE_DIR
#define VSRES_TEST_FIXTURE_DIR ""
#endif

namespace {

int fail(const char* msg) {
    std::fprintf(stderr, "FAIL: %s\n", msg);
    return 1;
}


// Builds a step whose approval is content-bound EXACTLY like an approval
// click in the companion: run the REAL registered emitter and store its body
// as approved_content. Tests that need a deliberately stale or invalid
// binding construct the struct fields directly instead.
std::string emitted_body(const std::string& type, const std::string& params_json) {
    vsres::register_builtin_filters();
    const vsres::IFilter* f = vsres::FilterRegistry::instance().find(type);
    if (!f) return {};
    vsres::StepParams p{params_json};
    return f->emit(p, vsres::StepContext{0, 0, 0, 0}).body;
}

vsres::ChainStep bound_step(std::string id, std::string type, int stage, bool enabled,
                            std::string params_json, bool approved = true) {
    vsres::ChainStep s;
    s.id = std::move(id);
    s.type = std::move(type);
    s.stage = stage;
    s.enabled = enabled;
    s.approved = approved;
    s.version = 1;
    s.params_json = std::move(params_json);
    s.approved_content = approved ? emitted_body(s.type, s.params_json) : std::string{};
    return s;
}

int test_roundtrip_empty_chain() {
    vsres::Chain in;
    in.node_id = "abc";
    in.mix = 0.75f;
    std::string serialized = vsres::serialize_chain(in);
    vsres::Chain out = vsres::parse_chain(serialized);
    if (out.node_id != in.node_id) return fail("node_id roundtrip");
    if (out.mix != in.mix) return fail("mix roundtrip");
    if (!out.steps.empty()) return fail("empty chain produced steps");
    return 0;
}

int test_stage_sort() {
    vsres::register_builtin_filters();
    vsres::Chain c;
    c.steps.push_back(bound_step("a", "script", 80, true, R"({"code":"# resize"})"));
    c.steps.push_back(bound_step("b", "script", 20, true, R"({"code":"# deinterlace"})"));
    c.steps.push_back(bound_step("c", "script", 50, true, R"({"code":"# restore"})"));
    vsres::StepContext ctx{1920, 1080, 100, 0};
    std::string script = vsres::compose_script(c, ctx);
    // Expect order: deinterlace (20) -> restore (50) -> resize (80).
    auto pos_deint  = script.find("# deinterlace");
    auto pos_restor = script.find("# restore");
    auto pos_resize = script.find("# resize");
    if (pos_deint == std::string::npos)  return fail("missing deinterlace step");
    if (pos_restor == std::string::npos) return fail("missing restore step");
    if (pos_resize == std::string::npos) return fail("missing resize step");
    if (!(pos_deint < pos_restor && pos_restor < pos_resize)) return fail("stage sort wrong order");
    return 0;
}

int test_manual_order_respected() {
    vsres::register_builtin_filters();
    vsres::Chain c;
    c.manual_order = true;
    c.steps.push_back(bound_step("a", "script", 80, true, R"({"code":"# first"})"));
    c.steps.push_back(bound_step("b", "script", 20, true, R"({"code":"# second"})"));
    vsres::StepContext ctx{1920, 1080, 100, 0};
    std::string script = vsres::compose_script(c, ctx);
    auto pos_first  = script.find("# first");
    auto pos_second = script.find("# second");
    if (pos_first == std::string::npos || pos_second == std::string::npos)
        return fail("manual_order omitted a step");
    if (!(pos_first < pos_second)) return fail("manual_order not respected");
    return 0;
}

int test_disabled_step_skipped() {
    vsres::register_builtin_filters();
    vsres::Chain c;
    c.steps.push_back(bound_step("a", "script", 20, true, R"({"code":"# keep"})"));
    c.steps.push_back(bound_step("b", "script", 30, false, R"({"code":"# drop"})"));
    vsres::StepContext ctx{1920, 1080, 100, 0};
    std::string script = vsres::compose_script(c, ctx);
    if (script.find("# keep") == std::string::npos) return fail("enabled step missing");
    if (script.find("# drop") != std::string::npos) return fail("disabled step was emitted");
    return 0;
}

int test_havs_alias_in_preamble() {
    // Regression: live client session 2026-08-09 — script steps written in the
    // documented `havs.QTGMC(...)` convention failed with "name 'havs' is not
    // defined" because the preamble only did `import havsfunc`. Both spellings
    // must work.
    vsres::register_builtin_filters();
    vsres::Chain c;
    c.steps.push_back(bound_step("a", "script", 20, true, R"json({"code":"clip = havs.QTGMC(clip, Preset='Fast', TFF=False)"})json"));
    vsres::StepContext ctx{720, 480, 100, 0};
    std::string script = vsres::compose_script(c, ctx);
    if (script.find("import havsfunc") == std::string::npos)
        return fail("preamble missing havsfunc import");
    if (script.find("havs = havsfunc") == std::string::npos)
        return fail("preamble missing havs alias");
    return 0;
}

int test_qtgmc_defaults() {
    vsres::register_builtin_filters();
    vsres::Chain c;
    c.steps.push_back(bound_step("q", "qtgmc", 20, true, R"({"tff":false,"fpsDivisor":2})"));
    vsres::StepContext ctx{720, 576, 100, 0};
    std::string script = vsres::compose_script(c, ctx);
    if (script.find("import havsfunc as havs") == std::string::npos)
        return fail("qtgmc missing havsfunc import");
    if (script.find("clip = havs.QTGMC(clip, Preset='Slower', TFF=False, FPSDivisor=2)") == std::string::npos)
        return fail("qtgmc default emission wrong");
    // havsfunc rejects TFF=0 — booleans must be capitalized Python bools.
    if (script.find("TFF=0") != std::string::npos || script.find("TFF=false") != std::string::npos)
        return fail("qtgmc emitted non-Python boolean");
    return 0;
}

// TIME CONTRACT (corrected Oct 27 from live evidence): QTGMC(FPSDivisor=2)
// must NOT be followed by AssumeFPS. Measured on the installed runtime:
// QTGMC bobs to 2928 @ 50fps and FPSDivisor=2 SelectEvery-decimates to
// 1464 frames @ 25fps — the ORIGINAL duration, already correct. A composer
// halving made the chain 117.12s and desynchronized A/B. Lock NO rate
// correction for every QTGMC configuration.
int test_qtgmc_never_emits_assumefps() {
    vsres::register_builtin_filters();
    const vsres::StepContext ctx{720, 576, 100, 0};
    for (const char* params : {
        R"({"tff":true,"fpsDivisor":2})",
        R"({"tff":true,"fpsDivisor":1})",
        R"({"tff":true,"fpsDivisor":2,"inputType":1})",
        R"({"tff":false,"fpsDivisor":2,"preset":"Fast"})",
    }) {
        vsres::Chain c;
        c.steps.push_back(bound_step("q", "qtgmc", 20, true, params));
        const std::string script = vsres::compose_script(c, ctx);
        if (script.find("AssumeFPS") != std::string::npos)
            return fail("qtgmc composer emitted AssumeFPS");
    }
    return 0;
}

int test_qtgmc_tuned_params() {
    vsres::register_builtin_filters();
    vsres::Chain c;
    c.steps.push_back(bound_step("q", "qtgmc", 20, true, R"({"preset":"Fast","tff":true,"fpsDivisor":1,"sharpness":0.5,"tr2":3,"sourceMatch":3,"lossless":2,"ezDenoise":2.5})"));
    vsres::StepContext ctx{720, 486, 100, 0};
    std::string script = vsres::compose_script(c, ctx);
    if (script.find("Preset='Fast'") == std::string::npos)     return fail("qtgmc preset not emitted");
    if (script.find("TFF=True") == std::string::npos)          return fail("qtgmc TFF=True missing");
    if (script.find("FPSDivisor=1") == std::string::npos)      return fail("qtgmc double-rate missing");
    if (script.find("Sharpness=0.5") == std::string::npos)     return fail("qtgmc sharpness missing");
    if (script.find("TR2=3") == std::string::npos)             return fail("qtgmc TR2 missing");
    if (script.find("SourceMatch=3") == std::string::npos)     return fail("qtgmc SourceMatch missing");
    if (script.find("Lossless=2") == std::string::npos)        return fail("qtgmc Lossless missing");
    if (script.find("EZDenoise=2.5") == std::string::npos)     return fail("qtgmc EZDenoise missing");
    return 0;
}

// CORRECTED 2026-08-11: Lossless=2 was the archival default through v4 of the reference
// job and it was wrong — it reinstates the tape's original field lines verbatim among
// motion-smoothed ones, and that alternation measures as a stationary comb once
// enlarged (comb ratio 9.09 vs 0.85 on a static shot). Lossless=0 is now the
// recommendation, paired with ThSAD2 to recover the grain that QTGMC's temporal
// smooth would otherwise eat (74.2% retained at the default vs 89.5% at ThSAD2=96).
//
// This guards the fix at the one point it could silently regress: filter_qtgmc.cpp's
// range check on `lossless` used to require >=1, so a caller that explicitly asked
// for 0 got it silently dropped in favour of QTGMC's own default. That happened to be
// harmless (0 IS QTGMC's own default) but relied on two facts lining up rather than
// on the emitter actually honouring what it was told — and ThSAD2 did not exist as an
// emittable param at all.
int test_qtgmc_corrected_defaults() {
    vsres::register_builtin_filters();
    vsres::Chain c;
    c.steps.push_back(bound_step("q", "qtgmc", 20, true, R"({"preset":"Placebo","tff":false,"fpsDivisor":1,"sourceMatch":3,"lossless":0,"thSad2":96})"));
    vsres::StepContext ctx{720, 480, 100, 0};
    std::string script = vsres::compose_script(c, ctx);
    if (script.find("SourceMatch=3") == std::string::npos)  return fail("qtgmc SourceMatch missing");
    // The regression this test exists to catch: Lossless=0 must appear EXPLICITLY in
    // the composed script, not be silently omitted because it equals QTGMC's default.
    if (script.find("Lossless=0") == std::string::npos)     return fail("qtgmc Lossless=0 dropped");
    if (script.find("ThSAD2=96") == std::string::npos)      return fail("qtgmc ThSAD2 missing");
    return 0;
}

// Lossless=1/2 must still emit for a caller who explicitly wants the old behaviour
// (e.g. reproducing a legacy master bit-for-bit) — 0 becoming the default recommendation
// does not mean the other values stop being valid QTGMC arguments.
int test_qtgmc_lossless_nonzero_still_works() {
    vsres::register_builtin_filters();
    vsres::Chain c;
    c.steps.push_back(bound_step("q", "qtgmc", 20, true, R"({"tff":false,"lossless":2})"));
    vsres::StepContext ctx{720, 480, 100, 0};
    std::string script = vsres::compose_script(c, ctx);
    if (script.find("Lossless=2") == std::string::npos)
        return fail("qtgmc Lossless=2 (explicit legacy value) no longer emits");
    return 0;
}

int test_qtgmc_injection_hardening() {
    vsres::register_builtin_filters();
    vsres::Chain c;
    // A hostile preset string must not reach the emitted Python.
    c.steps.push_back(bound_step("q", "qtgmc", 20, true, R"({"preset":"'); import os #","tff":true})"));
    vsres::StepContext ctx{720, 576, 100, 0};
    std::string script = vsres::compose_script(c, ctx);
    if (script.find("import os") != std::string::npos) return fail("qtgmc preset injection leaked");
    if (script.find("Preset='Slower'") == std::string::npos) return fail("qtgmc bad preset didn't fall back");
    return 0;
}

int test_qtgmc_progressive_repair_omits_tff() {
    vsres::register_builtin_filters();
    vsres::Chain c;
    // InputType=1 (progressive repair) — QTGMC forbids TFF here; must be omitted.
    c.steps.push_back(bound_step("q", "qtgmc", 20, true, R"({"tff":true,"inputType":1})"));
    vsres::StepContext ctx{720, 576, 100, 0};
    std::string script = vsres::compose_script(c, ctx);
    if (script.find("TFF=") != std::string::npos)      return fail("qtgmc emitted TFF for InputType=1");
    if (script.find("InputType=1") == std::string::npos) return fail("qtgmc InputType missing");
    return 0;
}

// The colour matrix must follow the label the UI actually ships, not a canonical
// name. matrix_for() once compared against the bare string "Rec.601" while the
// companion app's menu offers "Rec.601 (525)" / "Rec.601 (625)" — the
// parenthetical meant nothing matched and every standard-definition source
// silently decoded with Rec.709 coefficients. The emitted script said
// "# Input color management: Rec.601 (525)" directly above matrix='709'.
int test_color_matrix_matches_ui_labels() {
    struct Case { const char* label; const char* expect; };
    const Case cases[] = {
        {"Rec.601 (525)", "170m"},   // NTSC SD — the label the app's heuristic infers
        {"Rec.601 (625)", "470bg"},  // PAL SD — different primaries, must not be 170m
        {"Rec.601",       "170m"},
        {"SMPTE 170M",    "170m"},
        {"Rec.709",       "709"},
        {"Rec.2020",      "2020"},
        {"PAL",           "470bg"},
    };
    for (const auto& c : cases) {
        vsres::ColorManagement cm;
        cm.input_color_space = c.label;
        const std::string frag = vsres::vs_input_transform_fragment(cm);
        const std::string want = std::string("matrix='") + c.expect + "'";
        if (frag.find(want) == std::string::npos) {
            std::fprintf(stderr, "FAIL: input space %s -> expected %s\n  got: %s\n",
                         c.label, want.c_str(), frag.c_str());
            return 1;
        }
    }
    return 0;
}

// NoiseProcess=0 must survive into the emitted call. Zero is meaningful here — it
// is the archival setting — so it must not be skipped the way absent/zero tuning
// params are. Presets above 'Slower' otherwise enable noise processing, which needs
// fft3dfilter (not present in this arm64 plugin set) and alters the tape's grain.
int test_qtgmc_noise_process_zero_is_emitted() {
    vsres::register_builtin_filters();
    vsres::Chain c;
    c.steps.push_back(bound_step("q", "qtgmc", 20, true, R"({"tff":false,"fpsDivisor":1,"sourceMatch":3,"lossless":2,"noiseProcess":0})"));
    vsres::StepContext ctx{720, 480, 100, 0};
    std::string s = vsres::compose_script(c, ctx);
    if (s.find("NoiseProcess=0") == std::string::npos) return fail("NoiseProcess=0 not emitted");
    if (s.find("SourceMatch=3") == std::string::npos)  return fail("SourceMatch=3 not emitted");
    if (s.find("Lossless=2") == std::string::npos)     return fail("Lossless=2 not emitted");
    return 0;
}

std::string compose_qtgmc_params(const std::string& params) {
    vsres::register_builtin_filters();
    vsres::Chain chain;
    chain.steps.push_back(bound_step("q", "qtgmc", 20, true, params));
    return vsres::compose_script(chain, {720, 480, 100, 0});
}

// Inspect the real emitter's call, without evaluating Python or a VS script.
std::string qtgmc_argument(const std::string& script, const std::string& name) {
    const auto call = script.find("clip = havs.QTGMC(");
    if (call == std::string::npos) return {};
    const auto close = script.find(')', call);
    const std::string prefix = ", " + name + "=";
    const auto field = script.find(prefix, call);
    if (field == std::string::npos || field >= close) return {};
    const auto first = field + prefix.size();
    const auto last = script.find_first_of(",)", first);
    return script.substr(first, last - first);
}

bool finite_float_literal(const std::string& text, double& value) {
    if (text.empty() || text.find_first_of(".eE") == std::string::npos) return false;
    std::istringstream input(text);
    input.imbue(std::locale::classic());
    input >> std::noskipws >> value;
    return input && input.peek() == std::char_traits<char>::eof() && std::isfinite(value);
}

class GroupedCommaPunct final : public std::numpunct<char> {
protected:
    char do_decimal_point() const override { return ','; }
    char do_thousands_sep() const override { return '.'; }
    std::string do_grouping() const override { return "\3"; }
};

class ScopedGlobalLocale {
public:
    explicit ScopedGlobalLocale(const std::locale& next) : previous_(std::locale()) {
        std::locale::global(next);
    }
    ~ScopedGlobalLocale() { std::locale::global(previous_); }
    ScopedGlobalLocale(const ScopedGlobalLocale&) = delete;
    ScopedGlobalLocale& operator=(const ScopedGlobalLocale&) = delete;
private:
    std::locale previous_;
};

int test_qtgmc_host_locale_does_not_change_literals() {
    // A synthetic facet avoids depending on an installed named locale. The
    // surrounding integer stream once emitted ThSAD2=4.096 under this locale.
    const ScopedGlobalLocale locale(
        std::locale(std::locale::classic(), new GroupedCommaPunct));
    const auto script = compose_qtgmc_params(
        R"({"sharpness":0.5,"thSad2":4096,"sourceMatch":3,"lossless":2,"noiseProcess":0})");
    if (qtgmc_argument(script, "ThSAD2") != "4096")
        return fail("host locale grouped a QTGMC integer argument");
    if (qtgmc_argument(script, "Sharpness") != "0.5")
        return fail("host locale changed a Python decimal separator");
    if (qtgmc_argument(script, "SourceMatch") != "3"
        || qtgmc_argument(script, "Lossless") != "2"
        || qtgmc_argument(script, "NoiseProcess") != "0")
        return fail("host locale changed QTGMC enum arguments");
    return 0;
}

int test_qtgmc_float_literals_roundtrip() {
    struct Case { const char* params; const char* argument; double expected; };
    const Case cases[] = {
        {R"({"sharpness":0.12345678901234567})", "Sharpness", 0.12345678901234567},
        {R"({"sharpness":1.0000000000000002})", "Sharpness", 1.0000000000000002},
        {R"({"sharpness":0.0000001})", "Sharpness", 0.0000001},
        {R"({"sharpness":1.0})", "Sharpness", 1.0},
        {R"({"sharpness":0})", "Sharpness", 0.0},
        {R"({"ezDenoise":1.2345678901234567})", "EZDenoise", 1.2345678901234567},
        {R"({"ezKeepGrain":0.12345678901234567})", "EZKeepGrain", 0.12345678901234567},
    };
    for (const auto& test : cases) {
        const auto token = qtgmc_argument(compose_qtgmc_params(test.params), test.argument);
        double parsed = 0;
        // Full-token parsing and binary equality are independent of the
        // emitter's choice between fixed and scientific notation.
        if (!finite_float_literal(token, parsed) || parsed != test.expected)
            return fail("QTGMC float lost precision, type syntax, or full-token validity");
    }
    return 0;
}

int test_qtgmc_signed_zero_and_disabled_noise() {
    const auto script = compose_qtgmc_params(
        R"({"sharpness":-0.0,"ezDenoise":-0.0,"ezKeepGrain":0.0})");
    double parsed = 1;
    if (!finite_float_literal(qtgmc_argument(script, "Sharpness"), parsed)
        || parsed != 0.0 || !std::signbit(parsed))
        return fail("QTGMC floating serialization lost the sign of zero");
    if (!qtgmc_argument(script, "EZDenoise").empty()
        || !qtgmc_argument(script, "EZKeepGrain").empty())
        return fail("disabled zero-valued QTGMC noise controls were emitted");
    return 0;
}

int test_qtgmc_nonfinite_and_wrong_type_are_not_emitted() {
    const char* invalid[] = {
        R"({"sharpness":"NaN"})", R"({"sharpness":"Infinity"})",
        R"({"sharpness":"1.25"})", R"({"sharpness":null})",
        R"({"sharpness":true})", R"({"sharpness":NaN})",
        R"({"sharpness":Infinity})", R"({"sharpness":-Infinity})",
    };
    for (const char* params : invalid) {
        if (!qtgmc_argument(compose_qtgmc_params(params), "Sharpness").empty())
            return fail("nonfinite or nonnumeric JSON became a QTGMC float argument");
    }
    // nlohmann rejects numeric overflow with out_of_range(406), rather than
    // parse_error. Accept that explicit rejection, without claiming a host
    // exception boundary or changing the existing config parser here.
    bool overflow_rejected = false;
    try {
        overflow_rejected = qtgmc_argument(
            compose_qtgmc_params(R"({"sharpness":1e309})"), "Sharpness").empty();
    } catch (const vsres::config::Json::out_of_range& error) {
        overflow_rejected = error.id == 406;
    }
    return overflow_rejected ? 0 : fail("overflow became a QTGMC numeric literal");
}

int test_qtgmc_enum_values_cannot_narrow_into_valid_values() {
    const char* invalid[] = {
        "4294967296", "4294967297", "18446744073709551615",
        "9223372036854775807", "-9223372036854775808", "-4294967295",
        "-1", "4", "1.0", "1.5", "true", "null", "\"1\"", "[]", "{}",
    };
    for (const char* value : invalid) {
        const std::string json = std::string("{\"sourceMatch\":") + value
            + ",\"lossless\":" + value + ",\"noiseProcess\":" + value + "}";
        const auto script = compose_qtgmc_params(json);
        if (!qtgmc_argument(script, "SourceMatch").empty()
            || !qtgmc_argument(script, "Lossless").empty()
            || !qtgmc_argument(script, "NoiseProcess").empty())
            return fail("out-of-domain or full-width enum narrowed into an emitted value");
    }
    return 0;
}

int test_qtgmc_enum_valid_boundaries_remain_emittable() {
    struct Case { const char* params; const char* argument; const char* expected; };
    const Case cases[] = {
        {R"({"sourceMatch":1})", "SourceMatch", "1"},
        {R"({"sourceMatch":3})", "SourceMatch", "3"},
        {R"({"lossless":0})", "Lossless", "0"},
        {R"({"lossless":2})", "Lossless", "2"},
        {R"({"noiseProcess":0})", "NoiseProcess", "0"},
        {R"({"noiseProcess":2})", "NoiseProcess", "2"},
    };
    for (const auto& test : cases) {
        if (qtgmc_argument(compose_qtgmc_params(test.params), test.argument) != test.expected)
            return fail("QTGMC valid enum boundary was dropped or changed");
    }
    // SourceMatch has no valid zero, unlike the two zero-valued controls above.
    if (!qtgmc_argument(compose_qtgmc_params(R"({"sourceMatch":0})"), "SourceMatch").empty())
        return fail("QTGMC SourceMatch=0 was emitted");
    return 0;
}

}  // namespace

// TKT-SRC Phase 2b/4: source-mode sentinels, fingerprints and trim composition.
// A regression back to 0-defaults for source_in_point would silently trim
// every unrecorded clip to a single frame; these lock the sentinels down.
int test_source_mode_sentinel_defaults() {
    vsres::Chain c;
    if (c.source_mode.source_in_point != -1)  return fail("source_in_point default is not -1");
    if (c.source_mode.source_out_point != -1) return fail("source_out_point default is not -1");
    if (c.source_mode.source_size != -1)       return fail("source_size default is not -1");
    if (c.source_mode.source_mtime_ms != -1)   return fail("source_mtime_ms default is not -1");
    return 0;
}

int test_source_fingerprint_and_trim_parse() {
    const char* json = R"({
        "schemaVersion": 1,
        "clipMetadata": { "source": {
            "filePath": "/synthetic/source.mov",
            "sourceInPoint": 100,
            "sourceOutPoint": 359,
            "sourceSize": 4096,
            "sourceMtimeMs": 1760000000000,
            "retimeDetected": false
        } }
    })";
    vsres::Chain c = vsres::parse_chain(json);
    if (c.source_mode.source_file_path != "/synthetic/source.mov")
        return fail("source_file_path not parsed");
    if (c.source_mode.source_in_point != 100)  return fail("source_in_point not parsed");
    if (c.source_mode.source_out_point != 359) return fail("source_out_point not parsed");
    if (c.source_mode.source_size != 4096)      return fail("source_size not parsed");
    if (c.source_mode.source_mtime_ms != 1760000000000LL)
        return fail("source_mtime_ms not parsed");
    return 0;
}

int test_active_trimmed_emits_trim() {
    vsres::register_builtin_filters();
    vsres::Chain c;
    c.source_mode.mode = vsres::SourceMode::ActiveTrimmed;
    c.source_mode.source_file_path = "/synthetic/source.mov";
    c.source_mode.source_in_point = 100;
    c.source_mode.source_out_point = 359;
    c.steps.push_back(bound_step("a", "script", 20, true, R"({"code":"# pass"})"));
    vsres::StepContext ctx{1920, 1080, 260, 3};
    std::string script = vsres::compose_script(c, ctx);
    const std::string trim = "core.std.Trim(src, first=100, last=359)";
    if (script.find(trim) == std::string::npos) {
        std::string got = script.substr(script.find("std.Trim") != std::string::npos
            ? script.find("std.Trim") - 4 : 0, 48);
        std::fprintf(stderr, "  emitted: %.48s\n", got.c_str());
        return fail("ActiveTrimmed did not emit the recorded trim window");
    }
    if (script.find("LWLibavSource(_vsres_src_path)") == std::string::npos)
        return fail("ActiveTrimmed did not direct-load the source via the hex-decoded path");
    // SECURITY (2026-11-05, security review #1/correctness review C11): the path must be hex-
    // encoded, never interpolated raw. Decode and compare exactly.
    auto hx = script.find("bytes.fromhex('");
    if (hx == std::string::npos) return fail("hex path emission missing");
    auto hex_end = script.find('\'', hx + 15);
    if (hex_end == std::string::npos) return fail("hex literal unterminated");
    std::string hex = script.substr(hx + 15, hex_end - (hx + 15));
    std::string decoded;
    for (size_t i = 0; i + 1 < hex.size(); i += 2) {
        int byte = 0;
        for (int k = 0; k < 2; ++k) {
            char c = hex[i + k];
            byte <<= 4;
            if (c >= '0' && c <= '9') byte |= c - '0';
            else if (c >= 'a' && c <= 'f') byte |= c - 'a' + 10;
            else return fail("non-hex char in emitted path");
        }
        decoded += static_cast<char>(byte);
    }
    if (decoded != "/synthetic/source.mov")
        return fail("hex path does not round-trip to the recorded source path");
    return 0;
}

// ── 2026-11-05 audit regressions (security review #1 + correctness review C11) ────────────
int test_source_path_injection_is_inert() {
    vsres::register_builtin_filters();
    vsres::Chain c;
    c.source_mode.mode = vsres::SourceMode::Active;
    c.source_mode.source_file_path = "x'); import os; os.system('touch /pwned'); #";
    c.steps.push_back(bound_step("a", "script", 20, true, R"({"code":"# pass"})"));
    vsres::StepContext ctx{1920, 1080, 100, 0};
    std::string script = vsres::compose_script(c, ctx);
    if (script.find("os.system") != std::string::npos)
        return fail("crafted filename payload appears in the script");
    if (script.find("r'") != std::string::npos)
        return fail("a raw single-quoted path literal remains");
    if (script.find("_vsres_src_path = bytes.fromhex(") == std::string::npos)
        return fail("hex path emission missing");
    if (script.find("LWLibavSource(_vsres_src_path)") == std::string::npos)
        return fail("loader does not use the decoded variable");
    return 0;
}

int test_source_path_apostrophe_composes() {
    vsres::register_builtin_filters();
    vsres::Chain c;
    c.source_mode.mode = vsres::SourceMode::Active;
    c.source_mode.source_file_path = "/synthetic/John's tape.mov";
    c.steps.push_back(bound_step("a", "script", 20, true, R"({"code":"# pass"})"));
    vsres::StepContext ctx{1920, 1080, 100, 0};
    std::string script = vsres::compose_script(c, ctx);
    if (script.find("r'/synthetic/John's tape.mov'") != std::string::npos)
        return fail("raw path literal emitted (would be a Python SyntaxError)");
    auto hx = script.find("bytes.fromhex('");
    if (hx == std::string::npos) return fail("hex path emission missing");
    // 2f 73 79 6e ... "/synthetic/John's tape.mov" — spot-check the hex
    // begins with the '/' and 's' of /synthetic and ends before the quote.
    if (script.compare(hx + 15, 4, "2f73") != 0)
        return fail("hex does not encode /s of the path");
    return 0;
}

int test_step_label_newline_flattened() {
    vsres::register_builtin_filters();
    vsres::Chain c;
    // Label carries a newline + an attempted statement (recipe-import route).
    c.steps.push_back(bound_step("a", "script", 20, true, "{\"code\":\"# pass\", \"label\":\"innocent\\nimport os\\nos.system('pwned')\"}"));
    vsres::StepContext ctx{1920, 1080, 100, 0};
    std::string script = vsres::compose_script(c, ctx);
    auto line_pos = script.find("STEP 1 / 1");
    if (line_pos == std::string::npos) return fail("STEP header missing");
    auto line_end = script.find('\n', line_pos);
    std::string line = script.substr(line_pos, line_end - line_pos);
    if (line.find("import os") == std::string::npos)
        return fail("flattened label should keep its text on the comment line");
    if (line.find("os.system") == std::string::npos)
        return fail("payload text should remain inert INSIDE the comment");
    // The payload must not appear on any non-comment line: every line
    // containing os.system must be a comment line (starts with '#').
    size_t at = 0;
    while ((at = script.find("os.system", at)) != std::string::npos) {
        auto ls = script.rfind('\n', at);
        std::string ln = script.substr(ls + 1, script.find('\n', at) - ls - 1);
        size_t first_non_space = ln.find_first_not_of(' ');
        if (first_non_space == std::string::npos || ln[first_non_space] != '#')
            return fail("payload on a non-comment line");
        ++at;
    }
    return 0;
}

int test_vsmlrt_guarded_import_in_preamble() {
    vsres::register_builtin_filters();
    vsres::Chain c;
    c.steps.push_back(bound_step("a", "script", 20, true, R"({"code":"# pass"})"));
    vsres::StepContext ctx{1920, 1080, 100, 0};
    std::string script = vsres::compose_script(c, ctx);
    if (script.find("import vsmlrt") == std::string::npos)
        return fail("guarded vsmlrt import missing (correctness review C08)");
    if (script.find("except Exception:") == std::string::npos)
        return fail("vsmlrt import failure must be contained");
    return 0;
}

int test_node_guid_roundtrip() {
    vsres::Chain c;
    c.node_id = "label";
    c.node_guid = "0a1b2c3d-0e1f-4a2b-8c3d-4e5f60718293";
    vsres::Chain out = vsres::parse_chain(vsres::serialize_chain(c));
    if (out.node_guid != c.node_guid) return fail("node_guid lost in serialize/parse roundtrip");
    // Legacy configs without a guid parse to empty (host regenerates).
    vsres::Chain legacy = vsres::parse_chain(R"({"schemaVersion":1,"nodeId":"x"})");
    if (!legacy.node_guid.empty()) return fail("legacy config fabricated a node_guid");
    return 0;
}

// Node-guid validation — the SAME rule the host uses before building any
// sidecar/lock/.vpy filename (common/identity/guid.h). A corrupt or hostile
// config carrying traversal/path characters in nodeGuid must never be
// adoptable for a filename.
int test_node_guid_validation_rejects_paths() {
    using vsres::identity::valid_node_guid;
    if (!valid_node_guid("0a1b2c3d-0e1f-4a2b-8c3d-4e5f60718293"))
        return fail("normal uuid rejected");
    if (!valid_node_guid("a")) return fail("single char rejected");
    if (!valid_node_guid(std::string(64, 'a'))) return fail("64-char boundary rejected");
    // Everything that could escape the nodes directory:
    for (const char* bad : {"../recipes", "..", ".", "a/b", "a\\b", "/etc", "a b",
                            "a.b", "\t", "..%2f.."}) {
        if (valid_node_guid(bad)) { std::fprintf(stderr, "BAD=%s\n", bad); return fail("traversal-ish guid accepted"); }
    }
    if (valid_node_guid("")) return fail("empty guid accepted");
    if (valid_node_guid(std::string(65, 'a'))) return fail("65-char guid accepted");
    return 0;
}

// ── 2026-11-11 approval-content binding (security re-review closure) ──────

int test_approval_requires_content_binding() {
    vsres::register_builtin_filters();
    // Correct binding → emitted.
    {
        vsres::Chain c;
        c.steps.push_back(bound_step("a", "script", 20, true, R"({"code":"# live"})"));
        const std::string script = vsres::compose_script(c, {1920, 1080, 100, 0});
        if (script.find("# live") == std::string::npos)
            return fail("bound-approved step was not emitted");
    }
    // approved=true but missing binding → NOT emitted (fail closed).
    {
        vsres::Chain c;
        vsres::ChainStep s = bound_step("a", "script", 20, true, R"({"code":"# stale"})");
        s.approved_content.clear();
        c.steps.push_back(s);
        const std::string script = vsres::compose_script(c, {1920, 1080, 100, 0});
        if (script.find("# stale") != std::string::npos)
            return fail("unbound approval was emitted");
    }
    // approved=true with a binding for DIFFERENT content (edited after
    // approval) → the changed content must NOT run.
    {
        vsres::Chain c;
        vsres::ChainStep s = bound_step("a", "script", 20, true, R"({"code":"# benign"})");
        s.params_json = R"({"code":"# changed AFTER approval"})";
        c.steps.push_back(s);
        const std::string script = vsres::compose_script(c, {1920, 1080, 100, 0});
        if (script.find("changed AFTER approval") != std::string::npos)
            return fail("stale approval ran changed content");
    }
    // QTGMC variant: param edit after approval changes the emitted Python;
    // the stale binding must not emit the edited call.
    {
        vsres::Chain c;
        vsres::ChainStep s = bound_step("q", "qtgmc", 20, true, R"({"preset":"Slower","tff":false})");
        s.params_json = R"({"preset":"Placebo","tff":false})";
        c.steps.push_back(s);
        const std::string script = vsres::compose_script(c, {1920, 1080, 100, 0});
        if (script.find("Preset='Placebo'") != std::string::npos)
            return fail("stale QTGMC approval ran edited params");
    }
    // approved=false with a correct binding → not emitted.
    {
        vsres::Chain c;
        c.steps.push_back(bound_step("a", "script", 20, true, R"({"code":"# draft"})", false));
        const std::string script = vsres::compose_script(c, {1920, 1080, 100, 0});
        if (script.find("# draft") != std::string::npos)
            return fail("approved=false step ran");
    }
    return 0;
}

int test_approval_parse_fails_closed_and_roundtrips() {
    // Legacy JSON: approved present, binding absent → NOT emitted.
    {
        const char* legacy = R"({"schemaVersion":1,"chain":[{"id":"a","type":"script","stage":20,"enabled":true,"approved":true,"version":1,"params":{"code":"# legacy"}}]})";
        vsres::Chain c = vsres::parse_chain(legacy);
        if (c.steps.size() != 1) return fail("legacy chain did not parse");
        if (!c.steps[0].approved_content.empty())
            return fail("legacy chain fabricated a binding");
        const std::string script = vsres::compose_script(c, {1920, 1080, 100, 0});
        if (script.find("# legacy") != std::string::npos)
            return fail("legacy missing-binding approval ran");
    }
    // Missing `approved` entirely → NOT approved.
    {
        const char* nofield = R"({"schemaVersion":1,"chain":[{"id":"a","type":"script","stage":20,"enabled":true,"version":1,"params":{"code":"# nofield"}}]})";
        vsres::Chain c = vsres::parse_chain(nofield);
        if (c.steps[0].approved) return fail("missing approved defaulted to true");
        const std::string script = vsres::compose_script(c, {1920, 1080, 100, 0});
        if (script.find("# nofield") != std::string::npos)
            return fail("missing-approval step ran");
    }
    // Wrong-typed approved/approvedContent (null / number) → fail closed,
    // no exception escapes (nlohmann value() would have thrown on these).
    {
        const char* malformed = R"({"schemaVersion":1,"chain":[{"id":"a","type":"script","stage":20,"enabled":true,"approved":null,"approvedContent":7,"version":1,"params":{"code":"# malformed"}}]})";
        vsres::Chain c = vsres::parse_chain(malformed);
        if (c.steps[0].approved) return fail("null approval treated as true");
        const std::string script = vsres::compose_script(c, {1920, 1080, 100, 0});
        if (script.find("# malformed") != std::string::npos)
            return fail("malformed approval step ran");
    }
    // Roundtrip: serialize_chain carries approvedContent; parse keeps it; the
    // gate passes on the roundtripped chain.
    {
        vsres::Chain c;
        c.steps.push_back(bound_step("a", "script", 20, true, R"({"code":"# bound"})"));
        vsres::Chain out = vsres::parse_chain(vsres::serialize_chain(c));
        if (out.steps.size() != 1 || out.steps[0].approved_content != c.steps[0].approved_content)
            return fail("approvedContent lost in serialize/parse roundtrip");
        const std::string script = vsres::compose_script(out, {1920, 1080, 100, 0});
        if (script.find("# bound") == std::string::npos)
            return fail("roundtripped binding did not emit");
    }
    return 0;
}

int test_summarize_chain_matches_compose_gate() {
    vsres::register_builtin_filters();
    vsres::Chain c;
    c.steps.push_back(bound_step("a", "script", 20, true, R"({"code":"# ok"})"));                  // emitted
    c.steps.push_back(bound_step("b", "qtgmc", 30, true, R"({"tff":false})"));                    // emitted
    c.steps.push_back(bound_step("c", "script", 40, true, R"({"code":"# draft"})", false));       // unapproved
    vsres::ChainStep stale = bound_step("d", "script", 50, true, R"({"code":"# live"})");
    stale.params_json = R"({"code":"# edited"})";
    c.steps.push_back(stale);                                                                     // binding mismatch
    c.steps.push_back(bound_step("e", "mystery", 60, true, "{}"));                                // unknown
    c.steps.push_back(bound_step("f", "script", 70, false, R"({"code":"# off"})"));               // disabled

    vsres::ComposeStats stats;
    const std::string script = vsres::compose_script(c, {1920, 1080, 100, 0}, &stats);
    if (stats.total != 6 || stats.enabled != 5 || stats.emitted != 2
        || stats.unapproved != 2 || stats.unknown != 1)
        return fail("compose stats accounting wrong");
    const vsres::ComposeStats summary = vsres::summarize_chain(c, {1920, 1080, 100, 0});
    if (summary.total != stats.total || summary.enabled != stats.enabled
        || summary.emitted != stats.emitted || summary.unapproved != stats.unapproved
        || summary.unknown != stats.unknown)
        return fail("summarize_chain disagrees with the compose pass");
    if (script.find("# ok") == std::string::npos || script.find("QTGMC") == std::string::npos)
        return fail("emitted steps missing from script");
    if (script.find("# draft") != std::string::npos || script.find("# edited") != std::string::npos
        || script.find("# off") != std::string::npos)
        return fail("non-emittable steps leaked into the script");
    return 0;
}

int test_qtgmc_parity_fixture() {
    // Cross-language emission matrix. The companion's node parity test
    // (__test_qtgmc_parity.js) consumes the SAME file: preset whitelist,
    // argument order, integer-vs-float handling and float formatting must
    // agree byte-for-byte, because the approval-content binding compares the
    // two composers' emitted bodies.
    vsres::register_builtin_filters();
    const std::string path = std::string(VSRES_TEST_FIXTURE_DIR) + "/qtgmc_parity.json";
    std::ifstream in(path);
    if (!in) return fail("qtgmc_parity.json fixture missing");
    std::stringstream buf;
    buf << in.rdbuf();
    auto cases = vsres::config::parse(buf.str());
    if (!cases.is_array() || cases.empty()) return fail("qtgmc_parity.json did not parse");
    const vsres::IFilter* f = vsres::FilterRegistry::instance().find("qtgmc");
    if (!f) return fail("qtgmc filter not registered");
    for (const auto& c : cases) {
        vsres::StepParams p{c.at("params").dump()};
        const std::string body = f->emit(p, vsres::StepContext{0, 0, 0, 0}).body;
        const std::string want = c.at("expected").get<std::string>();
        if (body != want) {
            std::fprintf(stderr, "PARITY FAIL case=%s\n  want: [%s]\n  got:  [%s]\n",
                         c.at("name").get<std::string>().c_str(), want.c_str(), body.c_str());
            return fail("qtgmc emission diverged from the parity fixture");
        }
    }
    return 0;
}

// C01 (2026-11-11): the MIX value materializes in the composed script (the
// blend weight) — which is exactly why the native runtime cache key must
// carry the EFFECTIVE mix, not just the JSON. This pins the composition
// contract the key correctness depends on.
int test_mix_blend_and_cache_key_material() {
    vsres::register_builtin_filters();
    vsres::Chain c;
    c.node_id = "mix-node";
    c.manual_order = false;
    c.steps.push_back(bound_step("s1", "cas", 50, true, "{\"sharpness\":0.4}"));
    vsres::StepContext ctx{1920, 1080, 2, 10};

    c.mix = 0.25f;
    const std::string quarter = vsres::compose_script(c, ctx);
    if (quarter.find("weight=0.25") == std::string::npos) {
        return fail("mix 0.25 must embed weight=0.25 in the composed script");
    }

    c.mix = 1.0f;
    const std::string full = vsres::compose_script(c, ctx);
    if (full.find("weight=") != std::string::npos) {
        return fail("mix 1.0 must not emit a blend");
    }
    if (full == quarter) {
        return fail("different mix values must produce different scripts (cache-key material)");
    }
    return 0;
}

// C06 (2026-11-11): the timing-contract arithmetic the host enforces
// (docs/timing-contract.md). Matching classes must stay supported — the
// accepted PAL baseline first, then fractional NTSC rates against the
// ROUNDED host fps values; rate-changing combinations must refuse.
int test_rate_contract_matching_and_refusal() {
    using vsres::rate::rates_match;
    if (!rates_match(25.0, 25, 1)) return fail("PAL 25/25 must match");
    if (!rates_match(29.97, 30000, 1001)) return fail("NTSC 30000/1001 vs rounded 29.97 must match");
    if (!rates_match(23.976, 24000, 1001)) return fail("film 24000/1001 vs rounded 23.976 must match");
    if (!rates_match(59.94, 60000, 1001)) return fail("59.94 vs 60000/1001 must match");
    if (!rates_match(50.0, 50, 1)) return fail("bob @50 on a 50 timeline must match");
    if (rates_match(25.0, 50, 1)) return fail("bob 2x on a 25 timeline must refuse");
    if (rates_match(25.0, 25, 2)) return fail("heavy decimation (12.5 fps output) must refuse");
    if (rates_match(29.97, 24000, 1001)) return fail("IVTC 24000/1001 on an NTSC video timeline must refuse");
    if (rates_match(24.0, 24000, 1001)) return fail("24 vs 23.976 is a real mismatch");
    if (rates_match(0.0, 25, 1)) return fail("unknown timeline rate must refuse");
    if (rates_match(25.0, 0, 1) || rates_match(25.0, 25, 0)) return fail("missing output rate must refuse");
    return 0;
}

int test_rate_contract_boundaries() {
    using vsres::rate::clamp_to_output;
    using vsres::rate::timeline_frame_index;
    if (timeline_frame_index(98.999999) != 99) return fail("rounding must land on the intended frame");
    if (timeline_frame_index(99.000001) != 99) return fail("float noise still rounds to the intended frame");
    if (timeline_frame_index(100.0) != 100) return fail("integral coordinates stay put");
    if (clamp_to_output(-3, 100) != 0) return fail("negative clamps to the first frame");
    if (clamp_to_output(100, 100) != 99) return fail("end-of-clip slot holds the last frame");
    if (clamp_to_output(99, 100) != 99) return fail("in-range index untouched");
    if (clamp_to_output(1000, -1) != 1000) return fail("unknown length leaves the index untouched");
    return 0;
}

int main() {
    struct Case { const char* name; int (*run)(); };
    const Case cases[] = {
        {"approval_requires_content_binding", test_approval_requires_content_binding},
        {"approval_parse_fails_closed_and_roundtrips", test_approval_parse_fails_closed_and_roundtrips},
        {"summarize_chain_matches_compose_gate", test_summarize_chain_matches_compose_gate},
        {"mix_blend_and_cache_key_material", test_mix_blend_and_cache_key_material},
        {"rate_contract_matching_and_refusal", test_rate_contract_matching_and_refusal},
        {"rate_contract_boundaries", test_rate_contract_boundaries},
        {"qtgmc_parity_fixture", test_qtgmc_parity_fixture},
        {"source_path_injection_is_inert", test_source_path_injection_is_inert},
        {"source_path_apostrophe_composes", test_source_path_apostrophe_composes},
        {"step_label_newline_flattened", test_step_label_newline_flattened},
        {"vsmlrt_guarded_import_in_preamble", test_vsmlrt_guarded_import_in_preamble},
        {"color_matrix_matches_ui_labels", test_color_matrix_matches_ui_labels},
        {"qtgmc_noise_process_zero_is_emitted", test_qtgmc_noise_process_zero_is_emitted},
        {"roundtrip_empty_chain", test_roundtrip_empty_chain},
        {"stage_sort", test_stage_sort},
        {"manual_order_respected", test_manual_order_respected},
        {"disabled_step_skipped", test_disabled_step_skipped},
        {"havs_alias_in_preamble", test_havs_alias_in_preamble},
        {"qtgmc_defaults", test_qtgmc_defaults},
        {"qtgmc_never_emits_assumefps", test_qtgmc_never_emits_assumefps},
        {"qtgmc_tuned_params", test_qtgmc_tuned_params},
        {"qtgmc_corrected_defaults", test_qtgmc_corrected_defaults},
        {"qtgmc_lossless_nonzero_still_works", test_qtgmc_lossless_nonzero_still_works},
        {"qtgmc_injection_hardening", test_qtgmc_injection_hardening},
        {"qtgmc_progressive_repair_omits_tff", test_qtgmc_progressive_repair_omits_tff},
        {"qtgmc_host_locale_does_not_change_literals", test_qtgmc_host_locale_does_not_change_literals},
        {"qtgmc_float_literals_roundtrip", test_qtgmc_float_literals_roundtrip},
        {"qtgmc_signed_zero_and_disabled_noise", test_qtgmc_signed_zero_and_disabled_noise},
        {"qtgmc_nonfinite_and_wrong_type_are_not_emitted", test_qtgmc_nonfinite_and_wrong_type_are_not_emitted},
        {"qtgmc_enum_values_cannot_narrow_into_valid_values", test_qtgmc_enum_values_cannot_narrow_into_valid_values},
        {"qtgmc_enum_valid_boundaries_remain_emittable", test_qtgmc_enum_valid_boundaries_remain_emittable},
        {"source_mode_sentinel_defaults", test_source_mode_sentinel_defaults},
        {"source_fingerprint_and_trim_parse", test_source_fingerprint_and_trim_parse},
        {"active_trimmed_emits_trim", test_active_trimmed_emits_trim},
        {"node_guid_roundtrip", test_node_guid_roundtrip},
        {"node_guid_validation_rejects_paths", test_node_guid_validation_rejects_paths},
    };
    int rc = 0;
    for (const auto& test : cases) {
        const int result = test.run();
        rc |= result;
        std::fprintf(stderr, "COMPOSER_CASE_%s %s\n", result == 0 ? "PASS" : "FAIL", test.name);
    }
    if (rc == 0) std::fprintf(stderr, "all tests passed; cases=%zu\n", sizeof(cases) / sizeof(cases[0]));
    return rc;
}
