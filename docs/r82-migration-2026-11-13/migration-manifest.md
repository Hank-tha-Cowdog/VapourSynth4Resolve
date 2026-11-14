# R82 / API-4 plugin migration — manifest (2026-11-13)

Scope: the 33 API-3 plugins in the shipped 56. Sources: automated upstream
audit + paced refinement + manual-identification pass (evidence = entry-point
symbol in current upstream sources; artifacts in scratch:
r82-api4-audit.jsonl, r82-api4-audit-refine.jsonl, r82-pass3.json,
r82-api4-merged.json).

## A. Re-vendor candidates — API-4 upstream exists (11 dylibs)

| Plugin | Upstream | Note |
|---|---|---|
| lsmashsource | HomeOfAviSynthPlusEvolution/L-SMASH-Works | **BUILT + VERIFIED** — 6-site vanilla-FFmpeg port applied (`split`/`pix_fmts` removals; maintainer-blessed path from issue #129; diff in `L-SMASH-Works/PATCHES.md`). Full render on real media + source→znedi3 chain under R82. Shipping note: built against dynamic libav* (brew) — DMG requires the LGPL-kit/static linkage story before distribution. |
| nnedi3 | sekrit-twc/znedi3 (vsxx4) or HolyWu/VapourSynth-nnedi3vk | **BUILT + VERIFIED** (znedi3, arm64) |
| tivtc | dubhatervapoursynth/vapoursynth-tivtc | **BUILT + VERIFIED** |
| fieldhint | dubhatervapoursynth/vapoursynth-fieldhint | **BUILT + VERIFIED** (registration) |
| cas | HolyWu/VapourSynth-CAS | **BUILT + VERIFIED** |
| dctfilter | HolyWu/VapourSynth-DCTFilter | **BUILT + VERIFIED** |
| bm3dmetal | Sunflower-Dolls/Vapoursynth-BM3DMETAL | **BUILT + VERIFIED + bit-identical parity vs shipped build** |
| bm3d | HomeOfVapourSynthEvolution/VapourSynth-BM3D | **BUILT** (low-level API; app recipes use bm3dmetal.BM3D — migration-relevant one is done) |
| bm3dcpu | mapping unclear; NOT called by app recipes | **cut candidate** (verify vs vendor usage first) |
| it | theChaosCoder/vapoursynth-it | API-4 reference; **Zig** toolchain needed |

## B. API-3 at latest upstream — port / rebuild / cut (17 dylibs)

asharp, awarpsharp2, bilateral, ctmf, deblock, dfttest, eedi2, knlmeanscl,
retinex, rgsf, smoothuv, tcomb, tdeintmod, tedgemask, temporalsoften2, wwxd,
+ bm3d recheck. Notes:
- dubhatervapoursynth maintains ports of several (asharp, awarpsharp2,
  smoothuv, tcomb, tedgemask, temporalsoften2, wwxd) but **currently at
  API 3** — candidates for either our own mechanical API-4 port (small C
  sources; pattern established) or waiting on his updates.
- rgsf: upstream cold since 2016; superseded by removegrain (already API-4)
  → recommended **cut**.
- knlmeanscl / bilateral / ctmf / deblock / dfttest / eedi2 / retinex:
  identify + port or cut per usefulness (see filter library usage).

## C. Manual identification outstanding (8)

dfttest2_gcc → AmusementClub/vs-dfttest2 (probed api3; deeper build-file
check pending — repo has gpu_source/ dirs worth a second look).
fftspectrum → sgt0/vapoursynth-fftspectrum-rs (Rust, 2026-11; entry point not
locatable by symbol — Rust bindings; manual verify).
neo-f3kdb → HomeOfAviSynthPlusEvolution/neo_f3kdb (2026-09 active; probe
inconclusive — second look needed).
lghost → HomeOfVapourSynthEvolution/VapourSynth-LGhost (2020; api3).
removedirtvs → only ancient pins (2013/2015) → **cut candidate**.
it (old) → HomeOfVapourSynthEvolution/VapourSynth-IT (2018, api3) — the
Zig port covers it.
vsort → not found in AmusementClub; manual.
wnnm → WolframRhodium/VapourSynth-WNNM (api3; port candidate).

## D. First R82 test build (definition)

Core: install-R82 (banked: static-zimg patch, Cython 3.3.1, filters-lib
staging). Plugins: the 23 existing API-4 + category A as they build
(znedi3/tivtc/fieldhint done). GPU: bundle libvulkan.1.dylib +
libMoltenVK.dylib + MoltenVK_icd.json under Contents/Frameworks (core's first
loader candidate is @executable_path/../Frameworks/) + Apache-2.0 notices.
Qualification: per-namespace full render with real material (R80+ rejects
API-3 silently), CPU-parity diffs R79↔R82 per filter, QTGMC end-to-end
against znedi3+mvtools, GPU probe on the M5 testbed.

## E. Build recipe (proven)

See r82-testset/README.md. Knowns: meson needs PKG_CONFIG_PATH +
PYTHONPATH pointing at install-R82; Makefile plugins need
`LDFLAGS="-shared -undefined dynamic_lookup"`; weights files ship beside
dylibs.


## F. Portability triage (2026-11-13, post-re-vendor pass)

Classification of every remaining candidate upstream source:

- **Mechanical tier (VS4 headers + api3-style init): exhausted.** tivtc,
  fieldhint were the easy ones and are done. No further mechanical cases
  were found among the remaining candidates.
- **Rewrite tier (API-3-era source: `VapourSynth.h`, VSNodeRef, old
  VSMap/VSHelper usage — needs a real per-plugin modernization):**
  asharp, awarpsharp2, dfttest2_gcc, eedi2, smoothuv, tcomb, tedgemask,
  wnnm, wwxd (9 confirmed; several more in the unresolved set are almost
  certainly the same once their sources are pinned).
- **REWRITE TIER — FIRST PORTS DONE (2026-11-13):**
  - `temporalsoften2` (focus2 namespace) — ported to native VS4 + portable C
    kernels (x86 SSE2 guarded), meson arm64 guard relaxed. 8-bit output is
    **bit-exact** vs the shipped collection build; >8-bit follows the source's
    own arithmetic (the collection build used its own reimplementation).
    Port + notes: `r82-testset/vapoursynth-temporalsoften2/` (PATCHES.md).
  - `smoothuv` — **PORTED + BIT-EXACT** vs the shipped collection build
    (native VS4 + C kernels replicating the SSE2 arithmetic). Port + notes:
    `r82-testset/vapoursynth-smoothuv/` (PATCHES.md).
  - **R82 TEST BUNDLE STAGED (2026-11-13):** 39 plugins (23 native API-4 +
    16 replacements + znedi3), audit PASS, chain render byte-identical to the
    R79 shipped bundle. Notes: `r82-test-bundle-notes.md`.
  - `tcomb` — **PORTED + BIT-EXACT** vs the shipped build; includes the R82
    `std.Cache`-removal fix (passthrough semantics; R79 already deprecated it).
    Port + notes: `r82-testset/vapoursynth-tcomb/` (PATCHES.md).
  - `neo-f3kdb` — **PORTED (full dualsynth wrapper V4 conversion) + BIT-EXACT**;
    source identified (HomeOfAviSynthPlusEvolution/neo_f3kdb, V3-API upstream;
    vendored sse2neon for arm64, PR #21 NEON). `r82-testset/neo_f3kdb/`
    (PATCHES.md).
  - `removedirtvs` — **PORTED (sse2neon shim for the SSE2-only kernels) +
    BIT-EXACT** on all three filters; source identified (handaimaoh/
    removedirtvs, com.fakeurl.removedirtvs). `r82-testset/removedirtvs/`
    (PATCHES.md).
  - `wnnm` — **PORTED (Accelerate instead of MKL/ArmPL) + BIT-EXACT**;
    CPU-only upstream, float32. `r82-testset/VapourSynth-WNNM/` (PATCHES.md).
  - `lghost` — **PORTED + BIT-EXACT** vs the shipped build (int8 + float32
    paths; source identified: holywu's VapourSynth-LGhost, com.holywu.lghost).
    Port + notes: `r82-testset/VapourSynth-LGhost/` (PATCHES.md).
  - `deblock` — **RE-VENDORED, NO EDITS NEEDED + BIT-EXACT** vs the shipped
    build on engaged input. Source identified: HomeOfVapourSynthEvolution/
    VapourSynth-Deblock (holywu, com.holywu.deblock; upstream v9.0 is already
    VS4-native). Notes: `r82-testset/VapourSynth-Deblock/` (REVENDOR.md).
  - **WAVE 2 (2026-11-13):** eedi2, tedgemask, asharp, awarpsharp2, bilateral
    ported + bit-exact; cuts recorded (nnedi3-superseded, wwxd, it,
    vsort/vs-mlrt, dfttest2_gcc, bm3dcpu); queue: ctmf, retinex, tdeintmod,
    rgsf, fftspectrum. Details: `wave2-ports.md`.
  - `dfttest` — **PORTED + BIT-EXACT** vs the shipped build (verified on real
    textured input). R82 API notes: VS_MAKE_VIDEO_ID is #undef'd by the header
    (use queryVideoFormat); getCoreInfo has an out-param in V4.
    Port + notes: `r82-testset/VapourSynth-DFTTest/` (PATCHES.md).
  - `ttmpsm (TTempSmooth)` — **RESOLVED WITHOUT A PORT**: upstream is
    deprecated in favor of zsmooth, which ships in the curated set at API-4
    and provides `TTempSmooth` with byte-identical output (0 differing bytes
    on the test set) + the same call shape (maxr/thresh/mdiff). App recipes +
    availability gates swapped to `core.zsmooth.TTempSmooth` (rides the next
    artifact; safe on the current set too — zsmooth ships today).
- **Unresolved source identification:** bilateral, ctmf,
  dfttest, fftspectrum, knlmeanscl, lghost, neo-f3kdb, removedirtvs,
  retinex, rgsf, tdeintmod, temporalsoften2, vsort.

### Cut-vs-port decision framework (applies the recipe-usage scan)

Recipe usage of the app (grep of core.<ns>. across the companion):
- USED: ttmpsm(8), dfttest(4), deblock(4), tcomb(4), smoothuv(4), rdvs(4),
  neo_f3kdb(4), lghost(4), wnnm(4).
- UNUSED (zero references): wwxd, asharp, awarpsharp2, tedgemask, tdm,
  rgsf, retinex, knlm, eedi2, fftspectrum, it, vsort, ctmf, bilateral,
  dmetrics.

Recommendation: the first R82 test build ships the 11-namespace verified set
+ the 23 existing API-4 plugins; the 9 recipe-used rewrite-tier plugins are
the port worklist (highest usage first: temporalsoften2 → dfttest/deblock/
tcomb/smoothuv/rdvs/neo-f3kdb/lghost/wnnm); unused rewrite-tier plugins are
cut candidates that return only with an upstream port or demonstrated need.
