#include "color.h"

namespace vsres {

namespace {

// SECURITY (2026-11-05, security review #1 route 2): color-space/gamma labels
// can arrive from imported recipes; flatten control chars so a label can
// never break out of the emitted comment line.
std::string sanitize_comment(const std::string& s) {
    std::string out = s;
    for (char& ch : out) {
        unsigned char u = static_cast<unsigned char>(ch);
        if (u < 0x20 || u == 0x7f) ch = ' ';
    }
    return out;
}

// Map our UI's color-space label (Rec.709 / Rec.2020 / etc.) to the matrix
// coefficient string mvsfunc.ToYUV / .ToRGB expects. mvsfunc accepts:
//   '601' / '709' / '2020' / '2020ncl' / '170m' / '240m' / 'YCgCo' / 'rgb' …
// Anything else we don't recognize falls back to '709' since Resolve's default
// timeline is BT.709 and 99% of restoration material we'd see is 709-space.
const char* matrix_for(const std::string& cs) {
    // MATCHING MUST BE TOLERANT OF THE UI'S LABELS, NOT JUST CANONICAL NAMES.
    //
    // This function previously compared against the bare string "Rec.601" while
    // the companion app's menu ships "Rec.601 (525)" and "Rec.601 (625)" — and
    // its own heuristic correctly infers "Rec.601 (525)" for NTSC SD. The
    // parenthetical meant nothing matched, so every standard-definition source
    // silently fell through to the 709 default and was decoded with the wrong
    // matrix coefficients. The emitted script even said so plainly:
    //
    //     # Input color management: Rec.601 (525) / BT.1886
    //     clip = mvf.ToYUV(src, css='420', depth=16, matrix='709')
    //
    // A comment saying 601 above a call passing 709. Substring matching, so a
    // label change in the UI cannot resurrect this.
    auto has = [&cs](const char* needle) {
        return cs.find(needle) != std::string::npos;
    };

    // Order matters: check the more specific tokens first.
    if (has("2020") || has("2100")) return "2020";
    if (has("470BG") || has("470bg")) return "470bg";
    if (has("240M") || has("240m")) return "240m";
    if (has("170M") || has("170m")) return "170m";
    if (has("601")) {
        // 525-line (NTSC) and 625-line (PAL) 601 use DIFFERENT primaries. The
        // luma coefficients coincide, but 625-line is BT.470BG. Distinguish them
        // so PAL material is not tagged as NTSC.
        if (has("625") || has("PAL") || has("pal")) return "470bg";
        return "170m";                       // 525-line / NTSC, and bare "Rec.601"
    }
    if (has("PAL") || has("pal")) return "470bg";
    if (has("709") || has("sRGB")) return "709";   // sRGB shares primaries with 709
    // ACES / DCI-P3 / unrecognized → 709. Real OCIO transform is TKT-OCIO.
    return "709";
}

}  // namespace

ColorSpaceMenu load_menu_from_config(const std::string& /*config_name*/) {
    // Phase 1: replace with real OCIO config parsing.
    return {
        {"Rec.709", "Rec.2020", "DCI-P3", "ACES2065-1", "ACEScg", "sRGB"},
        {"BT.1886", "sRGB", "Linear", "PQ", "HLG", "Gamma 2.4"},
    };
}

std::string vs_input_transform_fragment(const ColorManagement& cm) {
    // Convert Resolve's 32-bit float RGB (RGBS) → YUV420P16, the format the
    // overwhelming majority of restoration filters expect (QTGMC, BM3D,
    // MAnalyse, DFTTest, ...). Without this conversion, every chain step has
    // to insert its own resize.* call AND the Archivist has to remember to
    // do it — fragile.
    //
    // YUV420P16 picked for two reasons:
    //   (1) QTGMC + Field-Ops filters need YUV — they reason about luma/chroma
    //       fields separately, undefined behavior on packed RGB.
    //   (2) 16-bit integer is the precision sweet spot — float RGB → int16
    //       loses less than 1 LSB per channel for footage already in 0-1 range,
    //       and most filters internally promote back to float when they need to.
    //
    // mvsfunc.ToYUV handles the resampling, matrix multiply, and bit-depth
    // conversion atomically. The matrix arg comes from the user's selected
    // Input Color Space dropdown.
    std::string code;
    code += "# Input color management: " + sanitize_comment(cm.input_color_space)
          + " / " + sanitize_comment(cm.input_gamma) + "\n";
    code += "# Auto-convert RGB float32 → YUV420P16 so restoration filters\n";
    code += "# (QTGMC, BM3D, ...) get the planar YUV input they expect.\n";
    code += "clip = mvf.ToYUV(src, css='420', depth=16, matrix='";
    code += matrix_for(cm.input_color_space);
    code += "')\n";
    return code;
}

std::string vs_output_transform_fragment(const ColorManagement& cm) {
    // Convert back to RGB float32 for Resolve. Idempotent if the chain's last
    // step already produced RGB (e.g., the user explicitly used to_rgb()) —
    // we check the format family before re-converting to avoid double-mangling.
    std::string code;
    code += "# Output color management: " + sanitize_comment(cm.output_color_space)
          + " / " + sanitize_comment(cm.output_gamma) + "\n";
    code += "# Auto-convert back to RGB float32 if the chain left clip in YUV.\n";
    code += "if clip.format.color_family != vs.RGB:\n";
    code += "    clip = mvf.ToRGB(clip, depth=32, matrix='";
    code += matrix_for(cm.output_color_space);
    code += "')\n";
    // Promote to RGBS (32-bit float) regardless of depth so Resolve's OFX
    // float pipeline sees consistent input — protects against a chain that
    // produced RGB24 or similar.
    code += "if clip.format.bits_per_sample != 32 or clip.format.sample_type != vs.FLOAT:\n";
    code += "    clip = mvf.Depth(clip, depth=32, sample=vs.FLOAT)\n";
    return code;
}

}  // namespace vsres
