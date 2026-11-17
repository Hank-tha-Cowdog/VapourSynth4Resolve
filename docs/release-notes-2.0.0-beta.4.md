# VapourSynth Companion 2.0.0-beta.4 — release notes

**The seal-safety update.** Same product and plugin set as beta.3 (VapourSynth
R82 core, 47 verified plugins) with a fix for a field-reported issue that could
permanently block **Install for Resolve** after first use.

macOS 26.0+ · Apple silicon (arm64) · signed + notarized + stapled DMG.

## What's fixed since beta.3

**The bytecode seal bug (reported in the field, reproduced, fixed).**

- **Symptom.** On an installed copy, clicking **Install for Resolve** could
  fail with *"source bundle fails codesign verification: … a sealed resource
  is missing or invalid in subcomponent: …/Python.framework"* — and stayed
  failed no matter how often you retried.
- **Cause.** The embedded Python, when it ran from the signed plugin bundle,
  wrote `__pycache__` bytecode caches into its own `Python.framework`. Added
  files break the code-signing seal of the framework *and* of the companion
  app, so the installer's strict verification (correctly) refused the bundle
  from then on.
- **Fix, two layers.** (1) The app now starts its embedded Python with
  bytecode caching disabled (`PYTHONDONTWRITEBYTECODE`, cache prefix outside
  the bundle) — every child process inherits it, so the seal can no longer be
  broken by ordinary use. (2) The install flow removes any such caches left
  by earlier builds from its own bundle *before* the — unchanged, still
  fail-closed — signature verification, so already-affected installs recover
  by themselves.
- **Regression guard.** A new test suite entry proves the unguarded Python
  dirties a copy of the bundle, the guarded one leaves it byte-identical, and
  the sweep removes only bytecode caches (never anything else).

**Already affected installs (beta.2/beta.3 that have been launched)**: this
build repairs them automatically on the first **Install for Resolve** click.
To repair immediately in-place instead, quit the companion and run:

```bash
find "/Applications/VapourSynth Companion.app" -name "__pycache__" -type d -exec rm -rf {} + 2>/dev/null
```

then reopen the app — the signature seal is restored and Install for Resolve
proceeds.

**Unchanged from beta.3:** the R82 core, the 47-plugin curated set, the chain
editor, render queue, node records, and the licensing-cleared helper set.

## Requirements

- macOS 26.0 or later, Apple silicon (arm64).
- DaVinci Resolve with OFX plugin support for the plugin half; the
  companion app runs standalone.

## Install

1. Open the DMG, drag **VapourSynth Companion** to Applications.
2. Launch it and run the setup flow inside the app (it installs/refreshes the OFX plugin
   from the app's own payload).

## Notes

- This remains a **public beta**: the audit/release-gate process
  (independent security + correctness reviews, clean-machine
  qualification) is documented in the repository and not yet fully
  closed.
- The previous releases (beta.2, beta.3) stay available on the releases page.
