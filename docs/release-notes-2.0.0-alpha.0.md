# VapourSynth for Resolve — v2.0.0-alpha release notes (DRAFT)

**Status: v2.0.0-alpha.0 — this repository is the public source release; the
signed alpha DMG ships on this repository's releases page.**

## What this is

VapourSynth for Resolve brings VapourSynth filter chains into DaVinci Resolve
21 as an OFX plugin, with a companion Electron app ("VapourSynth Companion")
for building, previewing and approving chains before the host applies them.

Components:

- **OFX plugin** (GPLv3, `platform/` + `common/`) — renders approved chains
  inside Resolve; a portable, self-contained bundle is built by
  `cmake --build <build> --target portable_bundle`.
- **Companion app** (MIT, `companion-app/`) — chain editor, live preview
  (adjacent frame rendering through an embedded Python + VapourSynth runtime),
  recipe library, optional local/neural helpers, and a chat assistant that can
  propose chain edits as drafts that still require explicit approval.

macOS support policy for this cycle: macOS 26.0+, Apple Silicon (arm64).
Sources build with CMake ≥ 3.25 + a project-local VapourSynth prefix
(`scripts/build-vapoursynth.sh`) and Node 24+/npm for the companion.

## Download and install (alpha)

Signed alpha builds are attached to the releases page (prerelease channel).
The app is **Developer ID signed, notarized and stapled** — it installs and
launches with no Gatekeeper prompts on any Mac. The app is self-contained (embedded Python + VapourSynth runtime +
curated plugins), so no Homebrew or system Python is required; installing the
OFX bundle for Resolve itself is documented in `docs/packaging.md`.

## Security model (this candidate)

- **Approval binds executable content.** A chain step executes only when it is
  both approved AND its stored approval byte-matches the freshly emitted
  script body; any edit that changes emitted code clears approval. Recipes,
  chat/MCP operations and library adds never arrive approved.
- **Renderer IPC is sender-gated.** Every execution-capable channel serves
  only the app window's own renderer; navigation and child windows are blocked.
- **Private writes fail closed.** Config/sidecar/diagnostic writes migrate
  existing broader file modes to 0600, refuse symlinks and hardlinks, verify
  directory chains and log honest refusal reasons.
- Machine helper directories are fallbacks; bundled code wins. Keyed LLM
  providers refuse plaintext LAN HTTP without explicit acceptance. The MCP
  token is never logged by default (opt-in prints the registration command
  with an explicit warning).

Details and consequences: `docs/security-posture-2026-11-11.md`.

## Fixes in this candidate (independent reviews of `c11a43d` and earlier)

Correctness: C01 (mix authority: accept-path parameter sync + render-cache
identity includes the effective mix), C05 (preview coordinator: obsolete
completions never publish; SOURCE priority dispatches immediately), C06
(declared host rate contract enforced — matching-rate chains render,
rate-changing chains on mismatched timelines are refused with both rates),
C07 (complete schema defaults make the first structured CST edit safe), C09
(unavailable capabilities can no longer appear verified; RIFE gated on the
live snapshot), C10 (exact rational frame selection at time boundaries),
C12 (QTGMC preset parity pinned by a shared native/draft fixture), C15 (null
colorManagement intake), scan-authority reconciliation (decisive idet ≥ 0.9
outranks provenance heuristics; suspicion still surfaced) and the unresize
dataflow fix (descale now sees full-resolution samples).

Security: approval-content binding, IPC sender/navigation policy, private-write
migration/refusal, build-path interpolation hardening, helper-precedence and
keyed-LAN posture, token-log posture (see above).

## Known limitations / open gates (honest list)

- **Binary/DMG distribution** of the curated plugin set carries per-component
  obligations that are tracked, not yet fully resolved, in `docs/notices-index.md`;
  alpha DMG builds ship as prerelease assets with notices included, and
  corrections are welcome.
- **Notarization** — complete for this alpha: signed, notarized and stapled
  (verify: `spctl -a -vv` reports "Notarized Developer ID").
- **Clean-Mac qualification** on independent hardware and **live-Resolve**
  export/Render-in-Place pixel checks remain open gates.
- The companion's fork lineage question (`docs/SBOM.md` Q1) is an open owner
  decision.
- ffprobe ships via the recipient-build compliance kit
  (`licenses/ffmpeg/recipient/` in the app payload); its public terms remain
  an owner decision.

## Building from source

```sh
# OFX plugin + portable bundle
scripts/build-vapoursynth.sh              # project-local VapourSynth prefix
cmake -S . -B build -DVSRES_VS_PREFIX="$PWD/vendor/vapoursynth/install-R82"
cmake --build build --target vapoursynth_ofx portable_bundle

# Companion app
cd companion-app && npm ci && npm run build

# Tests
ctest --test-dir build                 # native composer + private-io suites
npm test --prefix companion-app        # companion suite (see electron/__test_*.js)
python3 tests/test_macos_ofx_transaction.py tests/test_audit_release_payload.py tests/test_preview_frame_timebase.py
```

## Source export

`scripts/release/export_source.py --out <dir>` produces the clean allowlisted
release tree (no history, no binaries) + `MANIFEST.sha256`.
