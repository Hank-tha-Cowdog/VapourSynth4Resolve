# R82 test bundle — assembly notes (2026-11-13)

First staged R82 OFX bundle: 39 plugins (23 native API-4 + 16 ported/
re-vendored replacements; znedi3 added as the nnedi3 successor), staged from
a copy of the R79 staged bundle with the R82 core swapped in. Audit: PASS
(PATH_POLICY_PASS_NOT_RUNTIME_QUALIFIED, 0 violations). Chain render
(DFTTest→TComb→SmoothUV→Deblock→neo-f3kdb→zsmooth→znedi3) = byte-identical
to the R79 shipped bundle on the same script.

## Excluded from the test bundle (17 API-3, pending port/cut)
asharp, awarpsharp2, bilateral, bm3dcpu (cut candidate), ctmf, dfttest2_gcc,
eedi2, fftspectrum, it (Zig toolchain), knlmeanscl, nnedi3 (superseded by
znedi3), retinex, rgsf, tdeintmod, tedgemask, vsort, wwxd — plus lsmashsource
(deferred until the LGPL libav* kit; its port is module-verified).

## Assembly gotchas (each cost a cycle)
1. Manual copy of the R82 core into a bundle copy SKIPS the CMake target's
   fixups: re-run -id for libvapoursynth.4/libvsscript, the abi3.so -change,
   and stage fftw where a rebuilt plugin needs it (bm3d/dctfilter/dfttest
   link fftw3f + fftw3f_threads — same treatment as mvtools).
2. install_name_tool invalidates the code signature; arm64 SIGKILLs damaged
   binaries ("Killed: 9"). Re-sign (ad-hoc codesign -f -s -) AFTER ALL
   fixups.
3. THE MTIME TRAP, again: re-signing changes the bundle python exe's mtime —
   any vsconfig toml entry written BEFORE signing is stale and silently
   ignored ("Python executable and library path couldn't be determined").
   Write the toml LAST.
4. The toml key = the libvsscript path as DYLD reports it (the Resources
   copy vspipe loads), and the config lives at
   $XDG_CONFIG_HOME/vapoursynth/vapoursynth.toml or
   $HOME/.config/vapoursynth/vapoursynth.toml (R82 reads the same paths;
   confirmed in src-R82/src/vsscript/vsscript.cpp).
5. lsmash currently links Homebrew ffmpeg libs — excluded until its LGPL
   kit exists (its load-time libav deps would need the full treatment).
