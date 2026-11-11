# Clean-Mac qualification plan (executable; NOT yet run — B3/B4 gate)

**Artifact under test:** the signed/notarized DMG produced from a release-approved
commit (the current unsigned DMG at 46a2335, sha256 `6e47970a…`, is the engineering
evidence baseline; clean-Mac proof requires the signed artifact per gate 7).
**Machine:** a genuinely clean macOS 26+ arm64 Mac (fresh user account; no
Homebrew, no dev checkout, no Xcode CLT, no prior VapourSynth). **Never run on the
owner's working Mac.** Every step preserves user-created data (media, recipes,
projects, chat history, models) — the uninstall check proves it.

## Pass/fail discipline
Each numbered check has explicit evidence. A check that cannot produce its
evidence is a FAIL, not a "probably fine". Automated-tool evidence never
substitutes for the human/visual checks marked [HUMAN].

## A. Install (fresh machine, no media library yet)
1. Download/mount the DMG; drag the app to /Applications. **Evidence:** app
   launches from /Applications without any Gatekeeper warning (signed+notarized).
2. Install the OFX bundle per the documented installer path (or first-run
   install flow if implemented). **Evidence:** `/Library/OFX/Plugins/VapourSynth.ofx.bundle`
   exists; `codesign -dv` on the embedded OFX binary shows the release identity;
   recorded md5 equals the shipped candidate hash from the manifest.
3. Fresh Resolve (supported version) start → Effects → VapourSynth. **Evidence:**
   the plugin appears; no "damaged/unidentified developer" dialogs anywhere.
4. WITHOUT installing any Python/Homebrew/ffprobe: add the plugin to a clip →
   Configure. **Evidence:** the companion opens and renders (proves the embedded
   CPython + bundle plugins resolve internally — this is the bundle_selfcontained
   claim verified on real hardware). Plugin-status banner shows the 61-plugin set
   loaded from the bundle path (no user-dir fallback needed).

## B. Dependency resolution (prove absence of machine deps)
5. In the companion, run the documented runtime/plugin status surfaces.
   **Evidence:** python = embedded framework (path inside the .app/OFX bundle);
   plugin path = bundle `Contents/Plugins`; no `/opt/homebrew`, `/usr/local`,
   `/Users/…/development_projects`, or `~/.config/vapoursynth` machine-TOML
   reliance in any reported path (the self-registration path must be exercised).
6. Identify a source file by dragging a media file into the Identify strip.
   **Evidence:** ffprobe-based source analysis reports honestly that no ffprobe
   is available (expected on a clean Mac) while identification via Resolve
   discovery (scripting enabled) works; the preview still renders (lsmas path).

## C. Processing (the core loop)
7. Build a small chain (one deinterlace + one resize); preview; playback.
   **Evidence:** frames render; transport timing 1×; no crashes over a 2-minute
   session; [HUMAN] the preview matches expectations.
8. Save and Close; scrub the Resolve timeline. **Evidence:** the node shows the
   processed chain (gate-3 accepted behavior reproduced on the clean machine);
   [HUMAN] visual check.
9. Neural optional path (only if models were downloaded on the clean machine by
   explicit user action): RIFE interpolation renders. **Evidence:** capability
   snapshot reports usable; a short interpolation renders without crash.

## D. Export (the explicitly OPEN gate — must be proven here)
10. Export/Render-in-Place a short range through the node. **Evidence:** the
    exported file exists; probe it (on a machine WITH ffprobe, or via the
    companion on a second Mac) — dims/fps/codec match the timeline settings;
    [HUMAN] pixel check: the exported frames show the processed chain, not the
    source (this closes the export/Render-in-Place pixel gate).

## E. Upgrade (from the previous release, when one exists)
11. With user data present (recipes created in C, a project saved in Resolve,
    chat history, downloaded models): install the newer DMG over the old.
    **Evidence:** app version bump confirmed; recipes still listed and loadable;
    chat history intact; models still registered (no re-download required);
    node configs in the saved Resolve project reopen with chains intact.

## F. Uninstall (the footprint claim)
12. Run the documented uninstaller (or manual steps from docs/packaging.md).
    **Evidence:** product-owned files removed — the .app, `/Library/OFX/Plugins/VapourSynth.ofx.bundle`,
    product app-support dirs per the manifest; **user-owned data PRESERVED:
    `~/Library/Application Support/VapourSynth-OFX/{recipes,models,projects}`,
    user media, Resolve projects untouched**; a diff-style before/after listing
    of the product directories is captured as proof.
13. Resolve relaunch after uninstall. **Evidence:** the plugin is gone from
    Effects; Resolve opens the earlier project with the node showing an
    offline/missing effect rather than crashing.

## Bounded helper (build when executing this plan — small, isolated)
A read-only `qualify_helper.sh` (to be written with the plan's execution, NOT
now) that snapshots: installed paths + hashes, the before/after file listings for
F12, and the dependency-resolution surfaces of B5/B6 — writing ONLY to the
qualification machine's scratch dir. No helper touches user media or recipes
except to LIST them for the preservation diff.

## Known gaps this plan intentionally exercises
- min-OS: the artifact requires macOS 26 (measured CPython floor) — a
  macOS 25/24 machine must FAIL cleanly (loader error, not corruption); that
  failure mode is itself worth one documented observation on an older Mac if
  available.
- ffprobe absence is BY DESIGN until the owner decides the supply question
  (see docs/distribution-audit-2026-10-31.md §6).
