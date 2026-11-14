# R82 migration — wave 2: ports + cut decisions (2026-11-13)

## Ported this wave (all API-3 → VS4, all BIT-EXACT vs the shipped builds
## on gradient inputs; each added to the R82 test plugin set)

| plugin | source | notes |
|---|---|---|
| eedi2 | HomeOfVapourSynthEvolution/VapourSynth-EEDI2 | standard conversion; vs_bitblt→vsh::bitblt, cloneFrameRef→addFrameRef; doubled-height output vi via &d->vi2 |
| tedgemask | dubhatervapoursynth/vapoursynth-tedgemask | standard; malloc'd data; `!d.vi->format`→`.numPlanes` |
| asharp | dubhatervapoursynth/vapoursynth-asharp | standard; getFrameFormat→getVideoFrameFormat |
| awarpsharp2 | dubhatervapoursynth/vapoursynth-awarpsharp2 | FOUR filters, one shared init; AWarp needs 2 deps (node+mask); format equality via vsh::isSameVideoFormat; sse2.cpp stays x86-gated |
| bilateral | HomeOfVapourSynthEvolution/VapourSynth-Bilateral | pure C++ (no intrinsics), GNUmakefile repo → manual clang++ build; templated vs_aligned_malloc<T> (V3) → reinterpret_cast of vsh::vsh_aligned_malloc; headers only get their deps via includers — added VSHelper4 include; YCoCg clause dropped (V4 removed the family) |

Build recipe additions learned: several old repos include the path-prefixed
`<vapoursynth/VapourSynth.h>` form — swap to `VapourSynth4.h` AND pass
`-I<prefix>/include` (parent) so the prefixed form resolves to the target
prefix, not a stale system copy (`/usr/local/include/vapoursynth/` holds an
old install that otherwise wins and redefines V4 enums).

## Cut decisions (recorded — the set shrinks by design)

- **nnedi3** → SUPERSEDED by znedi3 (shipped replacement; the vendored
  havsfunc prefers the znedi3 namespace with an nnedi3 fallback).
- **wwxd, it, vsort/vs-mlrt** → CUT for now: zero functional references in
  the app (only inventory listings; no recipe/schema uses them). vs-mlrt
  also drags the onnxruntime dependency stack.
- **dfttest2_gcc** → CUT: superseded by the ported dfttest; the _gcc suffix
  was a build-artifact variant.
- **bm3dcpu** → CUT: CPU duplicate of the bm3d family; every supported Mac
  (macOS 26+ arm64) has Metal, where the shipped bm3d/bm3dmetal path runs.

Deferred (not cut): **knlmeanscl** (OpenCL-only; no successor port attempted
yet), **lsmashsource** (port done + module-verified; deferred until its
LGPL libav* kit exists — it currently links Homebrew ffmpeg).

## Remaining port queue (inventory-only but kept for set parity)

ctmf, retinex, tdeintmod, rgsf, fftspectrum (its SSE kernels need the
sse2neon treatment; niche spectrum visualizer — could also be cut).

## Usage-analysis method (worth repeating)

Grepping the companion's `filter-schemas.ts` + FilterLibrary + recipes for
each plugin name distinguishes REAL usage from inventory listings
(installed-plugins.ts mirrors the shipped set and is not evidence of use).
Only nnedi3 (via filter-schemas) had functional references among the
remaining 17 — everything else was inventory-only.
