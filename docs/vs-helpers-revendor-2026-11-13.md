# VS helper re-vendor — record (2026-11-13)

Closes rights-map **Conflict 5** (havsfunc whole-file provenance) and
**Conflict 6** (mvsfunc / nnedi3_resample grant gaps) via the review's own
recommended route: replace every bundled helper copy with a licensed,
pinned, hash-recorded source (or our own code), and quantify the change.

## The shipped helper set (staged into every bundle's `vs-python`)

| File | Source | License | Pin | sha256 (first 24) |
|---|---|---|---|---|
| `havsfunc.py` | HomeOfVapourSynthEvolution/havsfunc (last single-file revision, before the 2023 package refactor) | **Unlicense** | commit `40009447073c` (2023-04-29) | `80d952595cf7929ecc28276e…` |
| `vsutil/` (5 modules) | Irrational-Encoding-Wizardry/vsutil | **MIT** | commit `ae630929d767` | `5f830ad9…, 5da17026…, 54c75f88…, 11efd557…, f0c6b74d…` |
| `vsres_conv.py` | **ours** (platform/macos/vs-helpers) | MIT | in-repo | `21d6bde2c4bfde37dc9d7199…` |
| `adjust.py` | existing WTFPL helper (reviewed, unchanged) | WTFPL | unchanged | `22b25995ef37e6d003c2999e…` |

Dropped from staging: `mvsfunc.py` (no upstream license), `nnedi3_resample.py`
(no upstream license; optional, absence already handled by the composers'
guarded import).

## The one patch (documented, mechanical)

Upstream QTGMC hardcodes `core.znedi3.nnedi3`; the curated plugin set does
not ship znedi3. `vendor/vs-helpers/PATCHES.md` records the three-site
replacement with a resolver that prefers znedi3 when registered and falls
back to the bundled `nnedi3` namespace. No other changes to upstream bytes.

## Wiring

- Composed-script preambles (native composer + TS draft composer) import
  `vsres_conv as mvf` — call sites unchanged, module now ours.
- Repo scripts carry a `try: vsres_conv / except: mvsfunc` fallback so they
  work against old bundles during the transition.
- `portable_bundle` stages the set from the in-repo directories (vendor +
  platform); the user-dir copy of helpers is no longer a staging input.

## Acceptance evidence (real renders through the staged bundle)

Test material: `~/Movies/VSResLiveTest/interlaced.mov`, 2 frames, RGB float32
output, QTGMC Slower / TFF / FPSDivisor=2 — mirroring the live Resolve chain.

| Comparison | PSNR avg | SSIM |
|---|---|---|
| Conversions only (old `mvf.ToYUV/ToRGB` vs `vsres_conv`) | **89.10 dB** (min 89.09) | **1.000000** |
| havsfunc lineage (old bundled copy vs Unlicense-2023 + fallback patch, same conversions) | 64.85 dB | — |
| Conversions under QTGMC | 89.12 dB | — |
| **End-to-end (old chain vs new chain)** | **64.83 dB** | **0.999939** |

Interpretation: the replacement layer is transparent (~1 LSB @ 16-bit);
the remaining end-to-end delta is the havsfunc *revision* difference
(circulated 2021-era copy vs upstream 2023) — QTGMC-internal rounding drift
of ~40 LSB @ 16-bit on 2 frames, no structural change (SSIM 0.99994).
Spot-renders show no visible difference; the drift is documented rather
than hidden.

## Residual notes

- The new havsfunc's one lazy `mvf.BM3D` reference (a function this project
  does not call) will raise its import error loudly if ever invoked —
  intentional, documented, not silently degraded.
- The **live /Library install** keeps the r6 helper set until the next
  artifact build (beta.2/1.0) restages bundles; the repo tree and staging
  are transitioned now.
