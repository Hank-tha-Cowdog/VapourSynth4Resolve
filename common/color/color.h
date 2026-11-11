#pragma once

// OCIO 2.x + ACES Studio config integration.
//
// Phase 1: link OCIO statically, ship `studio-config-v2.1.0_aces-v1.3_ocio-v2.3.ocioz` in
// the bundle Resources, expose the Resolve-CST-mirrored Input/Output Color Space + Gamma dropdowns
// to both the OFX Inspector and the popout color header.

#include <string>
#include <vector>

namespace vsres {

struct ColorManagement {
    std::string input_color_space = "Rec.709";
    std::string input_gamma = "BT.1886";
    std::string output_color_space = "Rec.709";
    std::string output_gamma = "BT.1886";
    std::string ocio_config = "studio-config-v2.1.0_aces-v1.3_ocio-v2.3";
};

// Populated by reading the active OCIO config. Used to drive Choice param menus.
struct ColorSpaceMenu {
    std::vector<std::string> color_spaces;
    std::vector<std::string> gammas;
};

ColorSpaceMenu load_menu_from_config(const std::string& config_name);

// Emits a VS resize call that performs the input color management transform onto `src`.
// Phase 1 implementation: delegates to fmtc/resize with matrix_in_s/transfer_in_s strings.
std::string vs_input_transform_fragment(const ColorManagement& cm);

// Emits the matching output transform.
std::string vs_output_transform_fragment(const ColorManagement& cm);

}  // namespace vsres
