# tcomb — VS4/arm64 port (2026-11-13, VSRes R82 migration)

Source: dubhatervapoursynth/vapoursynth-tcomb (API-3-era; upstream already ships
x86-optional SIMD via `-DTCOMB_X86` with full C fallbacks — nothing kernel-side
was needed).

Changes: VapourSynth4.h/VSHelper4.h (C-mangled helpers: `vsh_bitblt`,
`vsh_isConstantVideoFormat`); VSNode/VSFrame; map* renames (incl.
mapDeleteKey/mapGetError/mapSetError/getFramePropertiesRW); maAppend/maReplace;
cf* color families; `&vi->format` for newVideoFrame; the init callback removed —
each of the FIVE chained stages (TCombStage1-4 + TComb) now uses createVideoFilter
with a VSFilterDependency (rpGeneral — stages request n-2 and n);
VapourSynthPluginInit2 with returnType "clip:vnode;".

**R82 compatibility fix:** the plugin's internal `invokeCache` called
`std.Cache`, which R82 REMOVED (R79 already made it a passthrough with a
deprecation warning). Patched to the modern semantics: pass the clip through
unchanged.

Acceptance: **bit-exact vs the shipped collection build** (identical frame
hashes, mode 2, luma+chroma pattern; the old build's Cache warning path
produces the same pixels).
Re-verified on structured input (strip fields, not flat frames): still
bit-exact.
