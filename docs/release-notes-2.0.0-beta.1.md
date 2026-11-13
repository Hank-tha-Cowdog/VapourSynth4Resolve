# VapourSynth for Resolve — v2.0.0-beta.1 release notes

**Status: v2.0.0-beta.1 (prerelease).** This repository is the public source
release; the signed, notarized beta DMG ships on this repository's releases
page. The beta is the alpha feature set hardened, corrected, and extended —
see "What's new since alpha.0" below.

## What this is

VapourSynth for Resolve brings VapourSynth filter chains into DaVinci Resolve
21 as an OFX plugin, with a companion Electron app ("VapourSynth Companion")
for building, previewing and approving chains before the host applies them.

Components:

- **OFX plugin** (GPLv3, `platform/` + `common/`) — renders approved chains
  inside Resolve; a portable, self-contained bundle is built by
  `cmake --build <build> --target portable_bundle`.
- **Companion app** (MIT, `companion-app/`) — chain editor, live preview, a
  **batch render queue** that encodes chains to ProRes 422 HQ / FFV1 without
  Resolve, a recipe library with import/export, one-click **Install for
  Resolve**, and a chat assistant whose agentic tool loop works across
  providers (Claude, OpenAI-compatible endpoints, Ollama).

macOS support policy for this cycle: macOS 26.0+, Apple Silicon (arm64).

## Download and install (beta)

Signed beta builds are attached to the releases page (prerelease channel).
The app is **Developer ID signed, notarized and stapled** — it installs and
launches with no Gatekeeper prompts. The app is self-contained (embedded
Python + VapourSynth runtime + curated plugins + its own encoder), so no
Homebrew or system Python is required. Installing the OFX bundle for Resolve
is one click from the companion's status popover ("Install for Resolve"),
which verifies the bundle's signature before touching
`/Library/OFX/Plugins` and keeps timestamped backups.

## What's new since alpha.0

- **Render queue (batch encoding).** The companion can render a node's
  composed chain to **ProRes 422 HQ (10-bit 4:2:2)** or **FFV1** masters with
  no Resolve involved: bundled CPython evaluates the composed script through
  the VapourSynth module's native output writer → rawvideo → the app's own
  **LGPL-only ffmpeg** (built from the same pinned, GPG-verified source as the
  ffprobe kit; recipient rebuild recipe ships in `licenses/ffmpeg-encoder/`).
  Live per-job progress, cancel, persistence (crashed runs are marked
  interrupted, never silently resumed), and H.273 color tags carried from the
  chain into the file.
- **Chain continuity.** The plugin's per-node saved-chain records are now
  verified and restored by the companion: a node whose live configuration was
  lost restores its saved chain automatically when the clip matches; records
  for other clips are never applied silently, and cross-clip restores strip
  approvals (nothing arrives pre-approved).
- **Window-edge quality fix.** Composed scripts used to trim the source
  *before* the chain, so temporal filters (QTGMC) deinterlaced a clip's
  first/last frames without their real neighbours. Source windows now apply
  to the chain output for rate-preserving chains; the fix is proven
  empirically (edge frames change, every interior frame bit-identical) and
  rate-changing chains keep the previous, index-safe order.
- **Provider tool-loop parity.** The Archivist's agentic loop (probe →
  propose → render-verify → refine in one turn) now runs on OpenAI,
  OpenRouter, xAI Grok and Ollama — not just Claude. Same pacing cap, same
  failure semantics, verified by a new fake-client test suite.
- **VapourSynth core: R75 → R79.** R79 is the newest release that runs the
  complete curated plugin set; R80+ removed the API-3 plugin interface and 36
  of the 61 shipped plugins are still API-3 today. R82 is built and kept
  in-tree for the API-4 migration. The upgrade also restored a static zimg
  link so the bundle stays self-contained.
- **Engineering hygiene.** CI (companion + python + native jobs) runs on the
  public repo; the portable bundle self-containment audit is enforced in the
  build; the test runner no longer breaks under asdf shims; a dormant
  pix_fmt bug that would have failed any YUV-output queue render was found
  and fixed before release.
- **Live-smoke fixes (all caught on a real Resolve session, all
  regression-tested).** (1) VSScript runtime binding: R79 validates the
  Python-discovery entry's mtime — our writer predated that format and
  stale entries were skipped instead of refreshed. (2) The namespace probe
  behind the Configure filter list resolved a helper-only folder instead of
  the shipped runtime, and it appended to a single-path variable that the
  plugin inherits inside Resolve — either way the list could degrade to the
  two always-available steps. (3) The companion-save auto-apply only ever
  armed for dev launches; for the installed app a saved chain had no apply
  trigger and nodes rendered passthrough. All three are fixed; the full
  loop — Configure → edit → save-and-close → chain applies → frames
  evaluate — is verified live, including the window-rule emission in the
  composed script.

Carried from alpha.0 (unchanged): the security model below, the correctness
fixes C01–C15, live-resolve qualification, and the notarization pipeline.

## Security model

- **Approval binds executable content.** A chain step executes only when it is
  both approved AND its stored approval byte-matches the freshly emitted
  script body; any edit that changes emitted code clears approval. Recipes,
  chat/MCP operations and library adds never arrive approved.
- **Renderer IPC is sender-gated.** Every execution-capable channel serves
  only the app window's own renderer; navigation and child windows are
  blocked. The render queue is no exception.
- **Private writes fail closed.** Config/sidecar/diagnostic writes verify
  directory chains, refuse symlinks, use 0600, and log honest refusal reasons.
- Keyed LLM providers refuse plaintext LAN HTTP without explicit acceptance.

Details: `docs/security-posture-2026-11-11.md`.

## Known limitations / open gates (honest list)

- The curated plugin set's per-component obligations are tracked in
  `docs/notices-index.md` / `docs/rights-map-2026-11-12.md`; the beta DMG
  ships with the notices and compliance kits included, and corrections are
  welcome. Final terms for the ffmpeg helpers remain an owner decision.
- **Clean-Mac qualification** on independent hardware is still pending
  (mimir asleep); the beta DMG is verified on the build machine.
- The companion's fork lineage question (`docs/SBOM.md` Q1) remains an owner
  decision.
- Google Gemini stays text-only for now (function-calling translation is a
  follow-up); LM Studio tools are per-model pending verification.
- Windows/Linux ports remain deferred; this cycle is macOS-only.

## Building from source

```sh
# OFX plugin + portable bundle (R79 = the shipped core)
scripts/build-vapoursynth.sh R79
cmake -S . -B build -DVSRES_VS_PREFIX="$PWD/vendor/vapoursynth/active"
cmake --build build --target vapoursynth_ofx portable_bundle

# Companion app
cd companion-app && npm ci && npm run build

# Encoder payload (render queue): rebuild with the shipped recipient recipe
python3 licenses/ffmpeg-encoder/recipient/rebuild_ffmpeg_encoder.py \
    --materials licenses/ffmpeg-encoder --output /tmp/ffmpeg-encoder-rebuild \
    --developer-dir "$(xcode-select -p)" --gpg /opt/homebrew/bin/gpg

# Tests
ctest --test-dir build
bash companion-app/scripts/run_test_suite.sh
python3 -m unittest discover tests
```

## Source export

`scripts/release/export_source.py --out <dir>` produces the clean allowlisted
release tree (no history, no binaries) + `MANIFEST.sha256`.
