# smoothuv — VS4/arm64 port (2026-11-13, VSRes R82 migration)

Source: dubhatervapoursynth/vapoursynth-smoothuv (API-3-era, x86-only meson guard).

Changes: native VS4 plumbing (VapourSynth4.h/VSHelper4.h with vsh:: helpers;
VSNode/VSFrame; map*/mapSetError; getFramePropertiesRO; newVideoFrame2 with the
VSVideoFormat value; cfYUV; createVideoFilter with rpStrictSpatial — the filter
only requests frame n); VapourSynthPluginInit2 (returnType "clip:vnode;");
portable C kernels (sum_pixels_C + smoothN_C) replicating the SSE2 arithmetic;
SSE2 kept under TS_HAVE_SSE2; meson guard relaxed to a warning.

## The lane-offset bug (found by the R82 bundle chain-bisect; FIXED)

First C-kernel draft read the neighbour as `sp[x]` — missing the per-lane
offset (`sp[x + i]`). The SSE2 version gets the offset implicitly: its
8-lane load `loadl(srcp + x)` delivers `sp[x+0..x+7]` to lanes 0..7. With
`sp[x]` every lane read lane 0's neighbour, so only 1/8 of the pixels used
the correct window.

Why initial verification MISSED it: the parity inputs were UNIFORM blocks
(8px stripes) — with a constant field, an offset by ±radius columns reads
the same values, so the bug is invisible. It surfaced only in the bundle
chain (dfttest+tcomb output feeding smoothuv): chroma differed from the
shipped build in every 8-pixel group.

**Fix:** `int nb = sp[x + i];` — then BIT-EXACT vs the shipped build on the
divergent input AND on gradient inputs.

## Acceptance (final)

- **Bit-exact vs the shipped build** on: (a) 8px grey+chroma stripe field
  at radius 3 (original test), (b) the dfttest→tcomb output field that
  originally diverged, (c) 2px-step gradient ramps.
- **End-to-end**: the R82 test bundle chain
  (DFTTest→TComb→SmoothUV→Deblock→neo-f3kdb→zsmooth→znedi3) renders
  byte-identical output to the shipped R79 bundle.
- LESSON (now a rule): uniform inputs mask lane/offset kernel bugs. Any
  hand-written kernel must also pass a NON-uniform gradient input, and the
  chain must be verified end-to-end.
