# R82 flip record + LSMAS LGPL-kit relink (2026-11-14)

## LSMAS static-kit relink (the "LGPL-kit treatment", completed)

The shipped `liblsmashsource.1.dylib` linked 19 Homebrew dylibs including
x264/x265 (GPL) — unacceptable for our bundle policy. Resolution: relink
L-SMASH-Works against the project's OWN ffmpeg-9.0.2 LGPL kit
(`build-ffmpeg-encoder`), which is the same FFmpeg version and the same
API the port already targeted — so no source changes at all.

Recipe (all CMake variables; no kit modification — the kit's verified
manifest/config stay untouched):

```sh
K=$REPO/build-ffmpeg-encoder           # ffmpeg-9.0.2, LGPL-2.1+, static
SRC=$K/work/source/ffmpeg-9.0.2 ; BLD=$K/work/build
# 1. clean include dist (the ffmpeg source root contains a `version` FILE
#    that shadows C++'s <version> header if you -I the source root directly)
mkdir ffdist
for lib in libavcodec libavformat libavutil libswscale libswresample libavfilter; do
  mkdir -p ffdist/$lib
  for f in $SRC/$lib/*.h $BLD/$lib/*.h; do ln -sf "$f" ffdist/$lib/; done
done
for f in $BLD/*.h; do ln -sf "$f" ffdist/; done   # config.h, config_components.h
# 2. configure L-SMASH-Works against the dist + static libs
cmake -S . -B build-static -DCMAKE_BUILD_TYPE=Release \
  -DENABLE_DAV1D=OFF -DENABLE_MFX=OFF -DENABLE_XML2=OFF \
  -DCMAKE_C_FLAGS="-I$PWD/ffdist" -DCMAKE_CXX_FLAGS="-I$PWD/ffdist" \
  -DZLIB_LIBRARY="$(xcrun --show-sdk-path)/usr/lib/libz.1.tbd" \
  -DFFMPEG_<comp>_INCLUDE_DIR="$PWD/ffdist" -DFFMPEG_<comp>_LIBRARY="$BLD/lib<comp>/lib<comp>.a"
cmake --build build-static -j8
```

Pitfalls (each cost an iteration; do not relearn):
- `-I` the ffmpeg SOURCE ROOT → `#include <version>` picks the root
  `version` file → "expected unqualified-id". Use the ffdist symlink dir.
- `ZLIB_LIBRARY=/usr/lib/libz.1.dylib` fails: that path does not exist on
  modern macOS (dyld cache). Use the SDK's `libz.1.tbd`.
- dav1d/MFX/XML2 are LSMAS-side optional deps (ENABLE_DAV1D etc.), not
  ffmpeg-side; the LGPL kit has no dav1d, so disable them.
- avdevice/avfilter: LSMAS's FindFFMPEG asks for all components; point
  avdevice at libavutil.a (kit has --disable-avdevice; avdevice is not
  actually linked).

Result: `libLSMASHSource.dylib` links only `/usr/lib/libz.1.dylib`,
`libSystem`, `libc++`. **Frame-identical to the Homebrew-linked build**
(sha256 f1eb1e2e7e76 on tests/fixtures/interlaced.mov frame 10,
YUV422P10 640×480).

## The flip (repo-side, completed)

- `vendor/vapoursynth/active` → `install-R82` (was `install-R79`).
- `vendor/Macos_vapoursynth_plugins/lib`: 23 dylibs refreshed with the
  R82 ported/rebuilt artifacts (wave 1 + wave 2 + znedi3 + bm3dmetal +
  the static-kit LSMAS), under their canonical product names
  (`libdeblock.dylib`, `liblsmashsource.1.dylib`).
- `platform/macos/portable_plugins.txt` → the R82 curated set: **47
  plugins** (was 56). Removed vs the R79 set: nnedi3 (znedi3 succeeds),
  wwxd, it, vsort, dfttest2_gcc, bm3dcpu, tdeintmod, rgsf, fftspectrum,
  knlmeanscl, ttmpsm (zsmooth replaces). Added: znedi3, lsmashsource
  (now shippable), bm3dmetal refreshed. Every list name verified present
  in the vendor drop before write.
- Safety copy of the last R79 staged artifact:
  `~/.hermes/cache/scratch/R79-STAGED-SAFETY-COPY.bundle`.

The controlled staging flow is `cmake --build build-portable --target
portable_bundle` (copies core + python + plugins, runs
repair_portable_bundle.sh with `platform/macos/portable_plugins.txt` and
the vendor drop, then the fail-closed audit).

## Controlled-restage findings (first `portable_bundle` run after the flip)

1. **fftw absolute refs** — the R82-rebuilt libdfttest/libbm3d/libdctfilter
   link Homebrew fftw directly; the audit (correctly) failed the first
   staged artifact. `repair_portable_bundle.sh`'s fftw clause was mvtools-
   only; widened to all four peers (stages both libfftw3f.3 and
   libfftw3f_threads.3, rewrites absolute refs to
   `@loader_path/../Libraries/`). The vendored `@rpath/libfftw3f.3`
   refs resolve against the same 3.3.11 library (its compat version
   11.0.0 satisfies their 10.0.0 requirement).
2. **Stale CMake cache after flipping `active`** — `build-portable`'s cache
   held R79-resolved pkg-config entries (`VAPOURSYNTH_*`, `pkgcfg_*`) and
   the realpath of the old target, so the "R82" restage copied the R79
   python package ("Core R79" from the staged vspipe). Fix:
   `cmake -S . -B build-portable -U 'VAPOURSYNTH_*' -U 'pkgcfg_*' -U 'VSRES_VS_PREFIX_REAL'`
   then rebuild. **After ANY active-prefix flip, reconfigure with those -U
   globs before staging** — the source dir is the repo ROOT (the cache
   rejects platform/macos as a different source).
3. **Runtime toml for staged-bundle vspipe runs** — the config at
   `$HOME/.config/vapoursynth/vapoursynth.toml` is
   `"<libvsscript.dylib abs path>" = ["<python3.14 exe>", "<libpython3.14.dylib>", "<mtime of python exe>"]`.
   Regenerate with the STAGED bundle's paths + the mtime taken after all
   re-signing (Rule-5). A wrong shape fails silently (vspipe empty output).
4. Staged-bundle vspipe runs need
   `VAPOURSYNTH_EXTRA_PLUGIN_PATH=<bundle>/Contents/Plugins` (the OFX host
   sets this at runtime; bare vspipe does not).

## Controlled restage — QUALIFIED (2026-11-14)

The `portable_bundle` target (with the cache purge above) now produces the
official R82 portable artifact, qualified end-to-end:

- **47 plugins** staged; fail-closed audit PASS, zero violations.
- Staged `vspipe --version` → **Core R82**.
- **Chain render (DFTTest→TComb→SmoothUV→Deblock→neo-f3kdb→zsmooth→znedi3)
  byte-identical to the shipped R79 bundle** on the same script.
- Spot renders through every wave-2 port (eedi2, ctmf, bilateral, retinex,
  tedgemask, asharp, awarpsharp2) OK inside the staged bundle.
- LSMAS loads real media through the staged bundle, frame-identical
  (f1eb1e2e7e76).

Staging-flow fixes made along the way (all in this commit set):
`repair_portable_bundle.sh` fftw clause widened to all four peers;
znedi3 `nnedi3_weights.bin` data-file clause added (drop + Plugins/);
`install_vendored_plugins.py` now copies the weights into the user-path
install too (the .dylib-only loop skipped it — latent installed-bundle bug).
