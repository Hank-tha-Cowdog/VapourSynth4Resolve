# deblock — VS4/arm64 re-vendor (2026-11-13, VSRes R82 migration)

Source: HomeOfVapourSynthEvolution/VapourSynth-Deblock (holywu; the shipped
libdeblock.dylib carries com.holywu.deblock — source now IDENTIFIED, was
previously unresolved).

**No source changes needed.** Upstream v9.0 is already VS4/API-4-native
(VapourSynthPluginInit2, "clip:vnode;", createVideoFilter, map* — and
`-DDEBLOCK_X86` with C fallbacks for the SSE4 path; meson skips SSE4 on
non-x86 hosts). Built against R82 with the standard meson recipe
(`vapoursynth get-include` template).

Acceptance: **bit-exact vs the shipped collection build** on engaged input
(8px subtle block field, quant 25 and quant 40 with offsets — output differs
from source, i.e. the filter actually ran).
