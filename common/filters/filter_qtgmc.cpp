#include "filter_qtgmc.h"
#include "../config/config.h"

#include <sstream>
#include <iomanip>
#include <limits>
#include <locale>

namespace vsres {

namespace {

// QTGMC's Preset argument is a free string in havsfunc, but we whitelist so a
// corrupted config can't inject Python. Unknown values fall back to Slower —
// the archival default used throughout our validation renders.
const char* sanitize_preset(const std::string& p) {
    static const char* kPresets[] = {
        "Placebo", "Very Slow", "Slower", "Slow", "Medium",
        "Fast", "Faster", "Draft", "Ultra Fast",
    };
    for (const char* known : kPresets) {
        if (p == known) return known;
    }
    return "Slower";
}

std::string py_bool(bool v) { return v ? "True" : "False"; }

// Validate the stored integer before get<int>() can narrow it. In particular,
// is_number_integer() also accepts unsigned JSON integers, so inspect that type
// first and retain its full width until the nonnegative bounds are checked.
bool is_bounded_nonnegative_integer(const config::Json& value, int minimum, int maximum) {
    if (minimum < 0 || maximum < minimum) return false;
    if (value.is_number_unsigned()) {
        const auto number = value.get<config::Json::number_unsigned_t>();
        return number >= static_cast<config::Json::number_unsigned_t>(minimum)
            && number <= static_cast<config::Json::number_unsigned_t>(maximum);
    }
    if (value.is_number_integer()) {
        const auto number = value.get<config::Json::number_integer_t>();
        return number >= minimum && number <= maximum;
    }
    return false;
}

// Preserve the configured double across Python serialization, independently of
// the host's locale. Integer-looking doubles still need Python float syntax.
std::string py_float(double v) {
    std::ostringstream os;
    os.imbue(std::locale::classic());
    os << std::setprecision(std::numeric_limits<double>::max_digits10) << v;
    std::string s = os.str();
    if (s.find('.') == std::string::npos && s.find('e') == std::string::npos) s += ".0";
    return s;
}

}  // namespace

ScriptFragment QTGMCFilter::emit(const StepParams& params, const StepContext& /*ctx*/) const {
    auto j = config::parse(params.json);

    // Field order. The renderer resolves 'auto' to a concrete boolean using the
    // probe verdict hierarchy (idet pixel content > MediaInfo > container flag)
    // BEFORE the step reaches the composer — by the time we emit Python, tff is
    // always concrete. havsfunc rejects TFF=0/1 (isinstance bool check), hence
    // the capitalized True/False emission.
    // PARITY + ROBUSTNESS (C12 follow-up 2026-11-05): every field read is
    // explicitly type-checked; a wrong-typed or out-of-range value falls back
    // to the same default the draft composer (shared/draft-composer.ts) uses.
    // nlohmann's value() THROWS on present-but-wrong types (and on null),
    // which previously let malformed recipe content abort composition. The
    // two composers must agree byte for byte — the approval-content binding
    // compares their emitted bodies.
    bool tff = true;
    if (j.contains("tff") && j.at("tff").is_boolean()) tff = j.at("tff").get<bool>();

    int fps_divisor = 2;
    if (j.contains("fpsDivisor") &&
        is_bounded_nonnegative_integer(j.at("fpsDivisor"), 0, (std::numeric_limits<int>::max)())) {
        fps_divisor = j.at("fpsDivisor").get<int>();
    }

    int input_type = 0;
    if (j.contains("inputType") && is_bounded_nonnegative_integer(j.at("inputType"), 0, 3)) {
        input_type = j.at("inputType").get<int>();
    }

    std::string preset = "Slower";
    if (j.contains("preset") && j.at("preset").is_string()) {
        preset = sanitize_preset(j.at("preset").get<std::string>());
    }

    std::ostringstream call;
    // Integer arguments must also remain Python literals when the host locale
    // groups thousands or changes the decimal separator.
    call.imbue(std::locale::classic());
    call << "clip = havs.QTGMC(clip, Preset='" << preset << "'";

    // TFF is required (and only meaningful) when the input actually has fields.
    if (input_type != 1) call << ", TFF=" << py_bool(tff);
    if (input_type != 0) call << ", InputType=" << input_type;

    // FPSDivisor=2 is QTGMC's own default (single-rate); emit explicitly anyway —
    // the composed script doubles as documentation in the status panel, and the
    // no-bob contract is the one parameter we never want implicit.
    call << ", FPSDivisor=" << (fps_divisor == 1 ? 1 : 2);

    // Optional tuning params — emitted only when present so QTGMC's own
    // preset-derived defaults stay in charge otherwise.
    if (j.contains("sharpness") && j.at("sharpness").is_number()) {
        call << ", Sharpness=" << py_float(j.at("sharpness").get<double>());
    }
    if (j.contains("tr2") && j.at("tr2").is_number_integer()) {
        call << ", TR2=" << j.at("tr2").get<int>();
    }
    if (j.contains("sourceMatch") && is_bounded_nonnegative_integer(j.at("sourceMatch"), 1, 3)) {
        const int sm = j.at("sourceMatch").get<int>();
        if (sm >= 1 && sm <= 3) call << ", SourceMatch=" << sm;
    }
    if (j.contains("lossless") && is_bounded_nonnegative_integer(j.at("lossless"), 0, 2)) {
        const int ll = j.at("lossless").get<int>();
        // 0 is QTGMC's own default AND the archival recommendation as of 2026-08-11
        // (see filter_qtgmc.h) — it must be emittable explicitly, not just omitted,
        // so a chain that overrides a preset's non-zero default back to 0 actually
        // says so in the composed script rather than relying on a silent fallback.
        if (ll >= 0 && ll <= 2) call << ", Lossless=" << ll;
    }
    // ThSAD2 — how readily QTGMC's final temporal smooth (TR2) will average a block
    // across frames. Not exposed until 2026-08-11: TR2 is a denoiser regardless of
    // NoiseProcess, and at QTGMC's default (256) it can eat a substantial fraction of
    // a tape's fine grain — measured 74% retained vs 89.5% at ThSAD2=96 on the reference job, for
    // about 6% of vertical detail. No fixed valid range in QTGMC; just require positive.
    if (j.contains("thSad2") && j.at("thSad2").is_number_integer()) {
        const int ts2 = j.at("thSad2").get<int>();
        if (ts2 > 0) call << ", ThSAD2=" << ts2;
    }
    // NoiseProcess — emitted when present, and 0 is a MEANINGFUL value here, so this
    // deliberately does not skip zero the way the tuning params above do.
    //
    // Two reasons a preservation chain wants NoiseProcess=0 explicitly:
    //   1. Presets above 'Slower' turn QTGMC's noise processing ON by default, and it
    //      requires fft3dfilter — absent from this arm64 plugin set, so the chain dies
    //      at compose time with a missing-plugin error rather than anything legible.
    //   2. Altering a tape's own grain is wrong for a preservation master. Grain is
    //      part of the record. Denoising, if wanted, belongs in its own reviewable
    //      stage where it can be judged and turned off.
    if (j.contains("noiseProcess") && is_bounded_nonnegative_integer(j.at("noiseProcess"), 0, 2)) {
        const int np = j.at("noiseProcess").get<int>();
        if (np >= 0 && np <= 2) call << ", NoiseProcess=" << np;
    }
    if (j.contains("ezDenoise") && j.at("ezDenoise").is_number()) {
        const double dn = j.at("ezDenoise").get<double>();
        if (dn > 0.0) call << ", EZDenoise=" << py_float(dn);
    }
    if (j.contains("ezKeepGrain") && j.at("ezKeepGrain").is_number()) {
        const double kg = j.at("ezKeepGrain").get<double>();
        if (kg > 0.0) call << ", EZKeepGrain=" << py_float(kg);
    }

    call << ")\n";

    // NO AssumeFPS HERE (reverted Oct 27, live correction): an earlier
    // change emitted core.std.AssumeFPS(fpsden * 2) after decimating QTGMC
    // on the misreading that '1464 frames still tagged 25fps' meant '12.5
    // fields/sec hiding in a 25fps tag'. MEASURED TRUTH on the installed
    // runtime: QTGMC bobs internally to 2928 @ 50fps and FPSDivisor=2
    // SelectEvery-decimates back to 1464 frames @ 25fps — the ORIGINAL
    // duration (1464/25 = 58.56s), already correct. QTGMC is single-rate
    // here; no manual rate correction belongs in the composer. The added
    // halving DOUBLED the chain duration (117.12s) and desynchronized A/B
    // (the processed view ran at half content speed while source ran real
    // time — the reported 'jumps far ahead' miscompare).

    ScriptFragment frag;
    frag.imports = "import havsfunc as havs\n";
    frag.body    = call.str();
    return frag;
}

}  // namespace vsres
