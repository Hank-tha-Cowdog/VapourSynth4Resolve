# dfttest — VS4/arm64 port (2026-11-13, VSRes R82 migration)

Source: HomeOfVapourSynthEvolution/VapourSynth-DFTTest (API-3-era; upstream
already ships full C fallbacks — `filter_c`/`func_0_c`/`func_1_c` — with the
SSE2/AVX2/VCL2 code behind `-DDFTTEST_X86`; nothing kernel-side needed).

Changes: VapourSynth4.h/VSHelper4.h (C++ namespaced helpers:
`vsh::vsh_aligned_malloc/free`, `vsh::int64ToIntS`, `vsh::bitblt`,
`vsh::isConstantVideoFormat`); VSNode/VSFrame; map* renames (incl.
mapNumElements); cf* color families; `&vi->format` for newVideoFrame2; the init
callback removed → createVideoFilter with a VSFilterDependency (rpGeneral —
temporal stages request n±tbsize/2); VapourSynthPluginInit2 with returnType
"clip:vnode;".

**R82 API notes (new, important):**
- `VS_MAKE_VIDEO_ID` is an **internal helper #undef'd at the end of
  VapourSynth4.h** (line 174) — plugins cannot use it. The pad format is now
  built with the real V4 API: `vsapi->queryVideoFormat(&fmt, cfGray, st, bps,
  0, 0, core)` (replaces registerFormat entirely).
- `getCoreInfo` gained an out-param in V4: `getCoreInfo(core, &info)`.
- The pad format is an owned `VSVideoFormat` value (was `const VSFormat *`).
- fftw3f threads lib needs `-L/opt/homebrew/lib` at meson setup on this Mac.

Acceptance: **bit-exact vs the shipped collection build** — re-verified on REAL
textured input (stripe fields and an 8px subtle-block field; gray tbsize=1,
gray tbsize=3, YUV tbsize=3 all identical frame hashes; temporal path verified
engaged — t3 output differs from t1).
