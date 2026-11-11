#pragma once

// PNG output helpers for OFX images and VS frames.
//
// Both produce 16-bit-per-channel sRGB-tagged PNGs (mostly so colorists can sanity-
// check previews without rolling float interpretation). For OCIO-correct linear-light
// previews we'd write EXR — that's a follow-up once the basic flow ships.
//
// All writes are atomic: write to `<path>.tmp` then rename to `<path>` so file watchers
// on the other side never see a half-written PNG.

#include "ofxsImageEffect.h"

#include <VapourSynth4.h>

#include <string>

namespace vsres::macos::frame_io {

// Save a float32 RGB VS frame as 16-bit PNG. The frame must be cfRGB / stFloat / 32 bpc
// per the v2.0 pixel pipeline contract. Returns true on success.
bool save_vs_frame_as_png(const VSFrame* frame, const VSAPI* api, const std::string& path);

// Save a float32 RGBA OFX image as 16-bit PNG. Alpha is dropped.
bool save_ofx_image_as_png(OFX::Image* image, const std::string& path);

// Save raw interleaved float32 RGBA scanlines as 16-bit PNG.
//   rgba       : w*h*4 floats, row-major top-to-bottom
//   path       : output file. Atomic-renamed from <path>.tmp.
bool save_rgba_float_as_png(const float* rgba, int width, int height, const std::string& path);

}  // namespace vsres::macos::frame_io
