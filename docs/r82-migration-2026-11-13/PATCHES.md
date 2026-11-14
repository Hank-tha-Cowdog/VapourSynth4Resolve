# neo-f3kdb — VS4/arm64 port (2026-11-13, VSRes R82 migration)

Source IDENTIFIED + modernized: HomeOfAviSynthPlusEvolution/neo_f3kdb
(dual AviSynth+VapourSynth via the "dualsynth" wrapper; the deband kernels
are API-free and already have arm64/NEON support — PR #21 merged; upstream
ships sse2neon.h for non-x86). Upstream master is V3-API (the vendored
include/vapoursynth/VapourSynth.h = API 3.6); PR #36 (open) is a huge
highway-kernel rewrite — NOT adopted; instead the wrapper layer was ported:

include/dualsynth/ — COMPLETE V4 conversion:
- ds_common.hpp: `#include <VapourSynth4.h>`; register_vsfilter_proc takes
  (const VSPLUGINAPI*, VSPlugin*).
- ds_format.hpp: VSVideoFormat value + queryVideoFormat (registerFormat is
  V3-only); cf* families; YCoCg branch removed (V4 dropped the family).
- ds_videoinfo.hpp: ToVSVI builds VSVideoInfo field-wise (V4 format is a
  value; no 7th flags field).
- ds_frame.hpp: getFrameFormat → **getVideoFrameFormat**; cloneFrameRef →
  **addFrameRef**; newVideoFrame(&value_format).
- ds_filter.hpp: V3 fmSerial → **fmFrameState** (V4's explicit compat mode
  for single-frame-state code — the wrapper keeps one _frameCtx per functor);
  clip param type "clip" → "vnode".
- vs_wrapper.hpp: map* renames; Initialize template removed —
  createVideoFilter(out, name, out_vi, GetFrame, Delete, mode, deps, ndeps,
  filter, core) with the input clip as an rpGeneral dependency; GetFrame
  signature void*-instanceData; VapourSynthPluginInit2 + configPlugin with
  VS_MAKE_VERSION(4,0) + returnType "clip:vnode;".

Build: cmake (repo CMakeLists) with PKG_CONFIG_PATH → R82;
-I<repo>/include/avisynth only (the V3 vapoursynth header dir must be OFF
the include path). Target: build-cmake/libneo-f3kdb.dylib.

Acceptance: **bit-exact vs the shipped collection build** on ENGAGED input
(2px-step luma/chroma gradient ramps; both range=15 and range=31 outputs
differ from the source and from each other, and match the shipped build
byte-for-byte).
