#pragma once

// C06 (2026-11-11): the native timing contract's arithmetic, unit-testable.
//
// docs/timing-contract.md declares the contract; these helpers make the host
// ENFORCE it instead of hoping. The OFX timeline path maps output-frame
// coordinates 1:1 onto the script's frames, which is correct only when the
// chain's OUTPUT cadence equals the timeline's. Rate-changing chains (bob at
// 2x, IVTC at 24000/1001, FPSDivisor halving) on a mismatched timeline are
// refusable scoped bugs, not silently-wrong-speed frames.

#include <cmath>
#include <cstdint>

namespace vsres::rate {

// 0.005 fps sits below the smallest gap between standard rates
// (24 vs 23.976 = 0.024; 30 vs 29.97 = 0.03; 25 vs 24 = 1.0) and far above
// the float noise of fractional rates compared against rounded host values
// (30000/1001 = 29.97002997 vs 29.97 -> ~3e-5). Every standard pair lands on
// exactly one side of it.
inline constexpr double kRateMatchTolerance = 0.005;

inline bool rates_match(double timeline_fps, std::int64_t out_num, std::int64_t out_den) {
    if (!(timeline_fps > 0.0) || out_num <= 0 || out_den <= 0) return false;
    const double out_fps = static_cast<double>(out_num) / static_cast<double>(out_den);
    return std::abs(out_fps - timeline_fps) <= kRateMatchTolerance;
}

// Resolve requests OUTPUT-frame coordinates as doubles that are semantically
// integral; rounding (not truncation) makes fractional host noise land on the
// intended frame (truncation would select N-1 for 98.999999).
inline int timeline_frame_index(double output_frame_time_minus_min) {
    return static_cast<int>(std::llround(output_frame_time_minus_min));
}

// End-of-clip behavior: hold the last frame (Resolve can ask for the timeline
// end slot of an equal-length clip with rounding noise). Unknown length
// (num_frames <= 0) leaves the index untouched.
inline int clamp_to_output(int frame_index, std::int64_t num_frames) {
    if (frame_index < 0) return 0;
    if (num_frames > 0 && frame_index >= num_frames) {
        return static_cast<int>(num_frames - 1);
    }
    return frame_index;
}

}  // namespace vsres::rate
