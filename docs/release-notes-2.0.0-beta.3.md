# VapourSynth Companion 2.0.0-beta.3 — release notes

**The R82 release.** Same product as beta.2 (OFX plugin + companion, the full
chain editor, render queue, node records, window rule) — now running on the
**newest VapourSynth core (R82 / API 4)** with a fully migrated,
parity-verified plugin set.

macOS 26.0+ · Apple silicon (arm64) · **Developer ID-signed DMG** (Apple
notarization for this build is pending — see Install).

## What's new since beta.2

**The core upgrade (the big one).**

- **VapourSynth R82** replaces R79. R79 was the last core that still loaded
  the legacy plugin API; the entire curated set had to be migrated first —
  and now it is.
- **Every one of the 33 legacy-API plugins was resolved**: 25 ported or
  re-vendored to the modern API and individually verified (raw-frame
  bit-exact against the previous builds wherever a previous build existed),
  the rest cut or deferred with recorded reasons (see below).
- **Verified end to end**: on the standard qualification chain
  (dfttest → tcomb → smoothuv → deblock → neo-f3kdb → zsmooth → znedi3),
  the new engine renders **byte-identical output** to beta.2's engine on
  the same script — a core upgrade with no pixel changes on the verified
  paths.
- **LSMAS (`LWLibavSource`) now ships inside the DMG.** It is relinked
  against the project's own LGPL ffmpeg kit — no external dependencies, and
  frame-identical to the previous build. This clears the last
  shipping blocker for the set's primary source-loading plugin.
- **Curated set: 47 plugins** (was 56). Removed: nnedi3 (superseded by the
  faster znedi3, already bundled), wwxd, it, vsort, dfttest2_gcc, bm3dcpu
  (no functional use; byte-identical or better replacements ship), ttmpsm
  (replaced byte-identically by zsmooth), and three inventory-only plugins
  deferred to a future wave (tdeintmod, rgsf, fftspectrum).
- **Engine housekeeping**: the plugin bundle is audited fail-closed for
  self-containment on every build (zero external references), znedi3's
  weights are now installed by every distribution path, and the
  ffmpeg-FFTW support libraries are bundled consistently for all plugins
  that need them.

**Unchanged from beta.2:** licensing-cleared helper set (havsfunc,
vsutil, MIT `vsres_conv`), the credentials flow, encoder presets, preview
pipeline, and the companion UI.

## Requirements

- macOS 26.0 or later, Apple silicon (arm64).
- DaVinci Resolve with OFX plugin support for the plugin half; the
  companion app runs standalone.

## Install

1. Open the DMG, drag **VapourSynth Companion** to Applications.
2. **First launch:** because notarization for this build is still pending,
   macOS will warn that it cannot verify the app. Right-click the app in
   Applications → **Open** → **Open anyway**. (Terminal alternative:
   `xattr -d com.apple.quarantine "/Applications/VapourSynth Companion.app"`.)
   The app is Developer ID-signed; a notarized build replaces this DMG on
   this page as soon as it is available.
3. Run the setup flow inside the app (it installs/refreshes the OFX plugin
   from the app's own payload).

## Notes

- This remains a **public beta**: the audit/release-gate process
  (independent security + correctness reviews, clean-machine
  qualification) is documented in the repository and not yet fully
  closed. Deferred plugins return when a use case appears or an upstream
  port lands.
- The previous release (beta.2) stays available on the releases page.
