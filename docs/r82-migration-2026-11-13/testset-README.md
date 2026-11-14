# R82 API-4 test set — build recipe + staging (2026-11-13)

Test-only set. Nothing here ships; the shipped beta stays on R79 until the
migration lands as a release.

## Build recipe (proven)

Prereqs: R82 prefix `vendor/vapoursynth/install-R82` (banked), meson
(brew), ninja, python 3.14 for build-time module imports.

```bash
export PKG_CONFIG_PATH="$REPO/vendor/vapoursynth/install-R82/lib/pkgconfig"
export PYTHONPATH="$REPO/vendor/vapoursynth/install-R82/lib/python3.14/site-packages"
# meson projects (dubhatervapoursynth ports):
meson setup build --buildtype=release && ninja -C build
# makefile projects (znedi3):
git submodule update --init
make vsznedi3.so LDFLAGS="-shared -undefined dynamic_lookup"
# rename to lib<name>.dylib; znedi3 additionally needs nnedi3_weights.bin
# beside the dylib.
```

Load-verification probe: `env -i` + `VAPOURSYNTH_EXTRA_PLUGIN_PATH=<dir>` +
python3.14 with the R82 site-packages first on sys.path; assert the
namespace registers and render one frame.

## Staged (verified under R82 this session)

| Plugin | Source | Build | Verification |
|---|---|---|---|
| znedi3 | sekrit-twc/znedi3 (vsxx4 wrapper; API-4) | Makefile, arm64 C paths | **full render PASS** (`nnedi3(field=1, dh=True)` 128→128×256) |
| tivtc | dubhatervapoursynth/vapoursynth-tivtc | meson | **full render PASS** (TFM order=1; TDecimate registered) |
| fieldhint | dubhatervapoursynth/vapoursynth-fieldhint | meson | loaded + registered (`fh.FieldHint`; render needs real hint data) |
| lsmashsource | HomeOfAviSynthPlusEvolution/L-SMASH-Works | cmake (+6-site vanilla-FFmpeg port, see `L-SMASH-Works/PATCHES.md`) | **full render PASS on real media** — `LWLibavSource` → YUV422P10 640×480 from interlaced.mov; source→znedi3 chain 640×960 |
| temporalsoften2 (focus2) | dubhatervapoursynth/vapoursynth-temporalsoften2 | meson (VS4 port + C kernels; PATCHES.md) | **full render PASS**; 8-bit **bit-exact** vs shipped; parity script `parity-ts.py` |
| zsmooth (incl. TTempSmooth) | shipped API-4 build | — | **byte-identical to the old ttmpsm** (0 diff) — replaces it via app-side namespace swap |
| smoothuv | dubhatervapoursynth/vapoursynth-smoothuv | meson (VS4 port + C kernels; PATCHES.md) | **full render PASS + BIT-EXACT vs shipped** (radius 3, chroma pattern) |
| tcomb | dubhatervapoursynth/vapoursynth-tcomb | meson (VS4 port; upstream C fallbacks; PATCHES.md) | **full render PASS + BIT-EXACT vs shipped**; incl. the R82 std.Cache-removal fix |
| dfttest | HomeOfVapourSynthEvolution/VapourSynth-DFTTest | meson + fftw3f (VS4 port; upstream C fallbacks; PATCHES.md) | **BIT-EXACT vs shipped** on textured input (gray t1/t3, yuv t3); incl. the queryVideoFormat/#undef'd VS_MAKE_VIDEO_ID + getCoreInfo V4 fixes |
| neo-f3kdb | HomeOfAviSynthPlusEvolution/neo_f3kdb | cmake (+ wrapper V4 port; PATCHES.md) | **BIT-EXACT vs shipped** on engaged gradient input (range 15/31) |
| deblock | HomeOfVapourSynthEvolution/VapourSynth-Deblock | meson (VS4-native upstream — NO edits; REVENDOR.md) | **BIT-EXACT vs shipped** on engaged input (8px blocks, q25 + q40/offsets) |
| lghost | HomeOfVapourSynthEvolution/VapourSynth-LGhost | meson (VS4 port; PATCHES.md) | **BIT-EXACT vs shipped** — int8 AND float32 paths |
| wnnm | WolframRhodium/VapourSynth-WNNM | manual clang++ + **Accelerate** (replaces MKL/ArmPL; PATCHES.md) | **BIT-EXACT vs shipped** (float32 gradient, sigma 0.04) |
| removedirtvs | handaimaoh/removedirtvs | clang++ + **sse2neon shim** (x86-only kernels; PATCHES.md) | **BIT-EXACT vs shipped** — all 3 filters |
| miscfilters | shipped API-4 build | — | needed by zsmooth's scenechange path; loads under R82 |
| cas | HolyWu/VapourSynth-CAS | meson | **full render PASS** |
| dctfilter | HolyWu/VapourSynth-DCTFilter | meson | **full render PASS** |
| bm3d | HomeOfVapourSynthEvolution/VapourSynth-BM3D | meson (+brew fftw3f) | loads; low-level API (Basic/Final — the app recipes use bm3dmetal.BM3D) |
| bm3dmetal | Sunflower-Dolls/Vapoursynth-BM3DMETAL | cmake (OBJCXX) | **full render PASS** + **bit-identical parity vs the shipped R79 vendor build** (same frame sha256) |

Recipe notes added this batch: VapourSynth-BM3D needs `/opt/homebrew/lib/pkgconfig`
in PKG_CONFIG_PATH (fftw3f); BM3DMETAL needs the INNER include dir
(`install-R82/include/vapoursynth`) as VAPOURSYNTH_INCLUDE_DIRECTORY.

Note: znedi3 registers namespace `znedi3` — it satisfies the havsfunc
patch's preferred path (`core.znedi3.nnedi3` before `core.nnedi3.nnedi3`).

## GPU addendum (same session)

R82 GPU compute through MoltenVK verified on this Mac:
`BlankClip(gpu=True)` → GPU-resident `BoxBlur` → `GPUDownload` → output
bit-identical to CPU. Core dlopens `libvulkan.1.dylib`/`libMoltenVK.dylib`
(search list includes `@executable_path/../Frameworks/` first).

## Next re-vendor candidates (API-4 upstream confirmed)

lsmashsource (L-SMASH-Works), cas (HolyWu), dctfilter (HolyWu), bm3d
family (VapourSynth-BM3D), it (theChaosCoder, Zig). Then the port/cut
pass for the 17 api3-at-upstream + 8 manual rows
(see r82-migration-manifest.md).
