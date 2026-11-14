# lghost — VS4/arm64 port (2026-11-13, VSRes R82 migration)

Source: HomeOfVapourSynthEvolution/VapourSynth-LGhost (holywu; shipping id
com.holywu.lghost — source now IDENTIFIED, previously unresolved).

Changes: VapourSynth4.h/VSHelper4.h (vsh:: namespaced helpers incl.
vsh::vsh_aligned_malloc/free, vsh::int64ToIntS, vsh::isConstantVideoFormat);
VSNode/VSFrame; map* renames (mapGetIntArray, mapNumElements, mapSetError,
mapGetNode); cfRGB; `&vi->format` for newVideoFrame2; getCoreInfo out-param;
init callback removed → createVideoFilter with VSFilterDependency rpStrictSpatial
(requests frame n only); VapourSynthPluginInit2 with returnType "clip:vnode;".
The LGHOST_X86 block (vectorclass dispatch) stays compile-gated; arm64 uses
filter_c<> templates natively.

Acceptance: **bit-exact vs the shipped collection build** — verified on
structured input in BOTH the 8-bit integer path (YUV420P8, multi-mode) and the
32-bit float path (GRAYS).
