# VapourSynth Companion 2.0.0-beta.2 — release notes

**Second public beta.** Same product as beta.1 (OFX plugin + companion, the
full chain editor, render queue, node records, window rule) with the
licensing cleanup, provider upgrades, and a smaller curated plugin set.

macOS 26.0+ · Apple silicon (arm64) · signed + notarized + stapled DMG.

## What's new since beta.1

**Licensing & provenance (the big one)**
- The bundled Python helper set is now fully license-cleared:
  `havsfunc` re-vendored from its **Unlicense** upstream at the last
  single-file revision (one documented `znedi3 → nnedi3` fallback patch);
  `vsutil` (**MIT**) added as its dependency; the old `mvsfunc.py` and
  `nnedi3_resample.py` are **no longer shipped** — their three used
  conversion functions are now our own MIT `vsres_conv.py`.
- A/B-verified end to end: conversion replacement is transparent
  (89.1 dB PSNR, SSIM 1.000000); the remaining ~65 dB / SSIM 0.99994 delta
  is documented QTGMC-revision drift, not a behavioral change.
- `librgvs` / `librgsf` verified permissive (WTFPL v2 + MIT-style grants,
  per-file record in the repo).
- The companion's retained-lineage grant is filed; authorship record and
  owner decisions published in the repo docs.

**Curated plugin set — 61 → 56 dylibs**
- Removed from every distribution path (staged bundle AND the user-path
  installer): `PSI`, `scxvid`, `vsnlm_ispc` (provenance drop-candidates) and
  `FFT3DFilter`, `sangnom` (notice-wording unresolvable) — including
  scxvid's support-copy twin. Recipes referencing these degrade to an
  accurate "missing" state; everything else is unchanged.

**Providers**
- **Google Gemini** joins Anthropic/OpenAI/Ollama/LM Studio with full
  agentic tool parity (streamed tool calls, tool results fed back, 40-step
  cap, graceful degradation without function-calling).
- **LM Studio** enabled on the shared OpenAI-compatible loop.

**Everything from the beta.1 live-smoke series is included**: the
VSScript always-toml fix (mtime-bound entries), bundle-path stand-down,
Configure probe single-path resolution, shipped-launch auto-apply for
companion saves, and the Ollama stream contract fix.

## Install

1. Download `VapourSynth.Companion-2.0.0-beta.2-arm64.dmg` (asset sha256
   recorded on the release page).
2. Open the DMG, run the installer — it places the OFX plugin in
   `/Library/OFX/Plugins` and the companion in `/Applications`.
3. In Resolve: add the **VapourSynth** OFX filter to a node, hit
   **Configure** — the companion opens; build a chain and save.

## Verification (this build)

- Signed (Developer ID, hardened runtime), notarized + stapled (app and
  DMG), installer `spctl`-accepted.
- Native tests 37/37 + 5/5; companion suite 76/76; provider tool-loop
  tests 11/11; portable-bundle self-containment audit PASS (fail-closed).
- Repo CI green on the published source revision.

## Known notes

- Plugin namespaces you previously relied on from the removed five will
  show as "missing" in the step list — by design; see the licensing docs
  for the per-component reasoning and the revisit conditions.
- The `mvtools` GPLv2-vs-or-later notice question is recorded and a
  maintainer question is drafted; nothing in this build depends on its
  outcome (no GPLv3 combined worker is produced).
