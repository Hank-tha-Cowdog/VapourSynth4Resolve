# smoothuv — VS4/arm64 port (2026-11-13, VSRes R82 migration)

Source: dubhatervapoursynth/vapoursynth-smoothuv (API-3-era, x86-only meson guard).

Changes: native VS4 plumbing (VapourSynth4.h/VSHelper4.h with vsh:: helpers;
VSNode/VSFrame; map*/mapSetError; getFramePropertiesRO; newVideoFrame2 with the
VSVideoFormat value; cfYUV; createVideoFilter with VSFilterDependency
rpStrictSpatial — the filter only requests frame n); VapourSynthPluginInit2
(returnType "clip:vnode;"); portable C kernels (sum_pixels_C + smoothN_C)
replicating the SSE2 arithmetic exactly (unsigned 16-bit accumulation + count,
strict `thres > |diff|`, divin[count] reciprocal via mulhi>>16); SSE2 kept
under TS_HAVE_SSE2 for x86; meson guard relaxed to a warning.

Acceptance: **bit-exact vs the shipped collection build** (identical frame
hashes, radius 3, chroma pattern, all planes).
Re-verified on structured input (strip fields, not flat frames): still
bit-exact.
