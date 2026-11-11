#pragma once

// OFX <-> VapourSynth pixel marshaling, float32 RGBA only.
//
// The OFX render path hands us 4-channel interleaved float32 RGBA frames; VapourSynth wants planar
// float32 (RGB, each channel separate). Marshaling lives here so it can be replaced with vDSP /
// Accelerate / Metal paths in one place when we optimize past the scalar reference implementation.
//
// Public API is platform-independent. The Windows v1.x scalar loops at
// platform/windows/src/VapourSynthPlugin.cpp:117-168 and :308-356 are the reference for correctness.

#include <cstdint>

namespace vsres {

struct Plane {
    float* data;
    int stride;  // bytes
};

struct RgbaFrame {
    float* data;     // interleaved RGBA
    int width;
    int height;
    int stride;      // bytes between rows
};

struct PlanarRgb {
    Plane r;
    Plane g;
    Plane b;
    int width;
    int height;
};

// Interleaved OFX RGBA float32 -> planar VS RGB float32. Drops alpha.
void interleaved_to_planar(const RgbaFrame& src, PlanarRgb& dst);

// Planar VS RGB float32 -> interleaved OFX RGBA float32. Alpha set to 1.0.
void planar_to_interleaved(const PlanarRgb& src, RgbaFrame& dst);

}  // namespace vsres
