> **Current OS policy (2026-11-02):** The owner selected macOS26.0+ on Apple Silicon (arm64) as the release target, pending qualification. See [selected policy](macos-support-policy.md). Earlier floor-decision/recommendation wording is historical; metadata implementation and runtime/release gates remain open.

# Packaging the companion app

**Current source note (2026-11-02):** [local pre-audit evidence](local-preaudit-2026-11-02.md) covers source3a9fe9c. `dist` now checks inputs before builder and requires app-output/ASAR-name validation afterward. Future packages select only the canonical recipient recipe and instructions into `licenses/ffmpeg/recipient`, separately from the unchanged pinned manifest. No new package was built here: retained hygiene-v2 remains4a866f3 and lacks the new runtime fixes/instructions. Minimum-OS, rights, audit, signed/clean-Mac and live gates remain open.

## Python discovery (packaged builds)

Preview/neural/probe python discovery prefers the **embedded framework**
(`process.resourcesPath/OFX/VapourSynth.ofx.bundle/.../Python.framework/Versions/Current/bin/python3`)
and only falls back to Homebrew/system interpreters when the explicit
`VSRES_DEV_PYTHON=1` dev gate is set — a packaged app never silently borrows a
machine install (19 isolated contract tests:
`companion-app/electron/__test_python_discovery.js`). **Known remaining
(B4):** the DMG currently has no `runtime/` tree for main.js `PATHS`, the
bundled `libvsscript.dylib` still carries the dev-tree path in its
`LC_ID_DYLIB` identity, and the user-path filter-plugin install
(`scripts/install_vendored_plugins.py`) is a required clean-machine step —
see docs/SBOM.md.

## Build

```sh
cd companion-app
PYTHON_PATH=/usr/bin/python3 npx electron-builder --mac dmg --arm64
```

`PYTHON_PATH` is required. Without it electron-builder invokes `python` from the
asdf shim, which has no version configured on this machine and exits 126 with no
useful message.

For an unsigned local build, add `CSC_IDENTITY_AUTO_DISCOVERY=false -c.mac.identity=null`.

## Signing — one-time keychain setup needed

The Developer ID certificate is present (`Zachary Holbert (4ZT24C8JQZ)`), the Apple
intermediates are installed, and the login keychain is unlocked. Signing still fails
from a non-interactive shell:

```
Warning: unable to build chain to self-signed root for signer "Developer ID Application: ..."
errSecInternalComponent
```

That is `codesign` being unable to reach the private key without a UI authorisation
prompt. Two ways to fix it, both requiring the account password:

**Either** grant the tools standing access once:

```sh
security set-key-partition-list -S apple-tool:,apple:,codesign: -s \
  -k "<login password>" ~/Library/Keychains/login.keychain-db
```

**Or** run the build from a Terminal window and click **Always Allow** on the prompt.

After that, a plain `npx electron-builder --mac dmg --arm64` signs with the identity
already configured in `package.json`.

## Notarisation

Not enabled yet — `mac.notarize` is `false` because no `AC_PASSWORD` keychain profile
exists. To enable:

```sh
xcrun notarytool store-credentials "AC_PASSWORD" \
  --apple-id "<apple id>" --team-id 4ZT24C8JQZ --password "<app-specific password>"
```

then set `"notarize": true`. Without notarisation the DMG runs here but is blocked by
Gatekeeper on other machines even when signed.

## What the DMG does NOT yet contain

The OFX plugin. `extraResources` is unset, so installing the app does not install
`/Library/OFX/Plugins/VapourSynth.ofx.bundle` — that is still a separate `sudo` step.

More importantly, **the plugin is not yet portable** (TKT-DIST). It links against
absolute paths inside this build tree:

```
/path/to/projects/.../vendor/vapoursynth/install-R75/lib/python3.14/
    site-packages/vapoursynth/libvsscript.dylib
```

The bundle is 684 KB — the binary only, no embedded runtime. On any other Mac it will
fail to load. Shipping to a third party requires embedding the VapourSynth dylibs,
Python, and the plugin set inside the bundle with `@loader_path` install names. Until
then this DMG is for this machine.

## Self-containment status (2026-10-31 — supersedes the caveats below where they conflict)

The staged portable bundle now resolves EVERY runtime component through
internal paths, verified under `env -i` (no PATH/PYTHONPATH/user-site):

- `Contents/Plugins` — the 61-dylib curated filter-plugin set (list:
  `platform/macos/portable_plugins.txt`), each with the
  `@rpath/libc++.1.0.dylib → /usr/lib/libc++.1.dylib` repair and a clean
  `@rpath` identity. `libmvtools` needs FFTW — shipped in `Contents/Libraries`
  (GPL-2+, compatible with the project GPLv3). The vs-mlrt family loads
  onnxruntime from `Contents/support`.
- `Contents/Libraries` — libvsscript, libvapoursynth, fftw, and the Python
  stdlib support libs (mpdecimal, openssl, zstd, xz, sqlite) with every
  reference rewritten to `@loader_path`.
- The embedded CPython: Homebrew's `sitecustomize.py` hook REMOVED (it
  pulled the host prefix's site-packages into the interpreter); the
  framework's symlink layout restored (copy_directory had materialized
  Current/Python/Resources/Headers as full duplicates — bundle 226M→160M);
  all touched Mach-O re-signed ad-hoc (arm64 SIGKILLs binaries with
  signatures invalidated by install_name_tool — reproduced live).
- Fail-closed audit in the staging target (`platform/macos/repair_portable_bundle.sh`):
  any `/opt/homebrew`, `/usr/local`, or `/Users/…` reference in any Mach-O,
  any external path in any `.pth`, or any Homebrew sitecustomize hook FAILS
  the staging. `ctest bundle_selfcontained` re-verifies the final artifact
  under `env -i`.
- Native runtime: sys.path puts the bundle's `Resources/vs-python` FIRST;
  `VAPOURSYNTH_EXTRA_PLUGIN_PATH` points at `Contents/Plugins` before any
  core creation. NOTE: this VS R75 macOS build treats that env var as a
  SINGLE path — an os.pathsep-joined list breaks ALL plugin loading (the
  old "append the user dir" code never worked; VS's default user-dir
  autoload did the loading).
- Companion: `render_preview_frame.py` and `prod-paths.js` resolve plugins
  bundle-first with the same precedence (explicit env → bundle → user dir).

STILL OPEN (owner decisions — recorded, not fixed):
1. **Minimum OS**: the bundled Homebrew-built CPython requires macOS 26.0
   (OFX binary: 13.0, fmtconv: 15.0, mvtools: 16.0). Either vendor a
   low-minos CPython (download gated) or document macOS 26 as the floor.
2. **ffprobe**: an official-source 9.0.2 helper has been selected and staged
   for the separate November 1 candidate described below. The existing DMG
   remains unchanged; licensing and release acceptance remain gates.
3. **Plugin-set redistribution rights** (gate 4, yuygfgg repo): plugins are
   staged for TESTING; distribution requires the gate-4 decision.
4. **sysconfigdata** in the staged framework keeps Homebrew BUILD paths
   (build metadata only, no runtime effect — cosmetic, recorded).

Install/upgrade/uninstall footprint (plan, not yet implemented):
- INSTALL: the .app + `/Library/OFX/Plugins/VapourSynth.ofx.bundle` +
  product-owned app-support dirs (models, vs-python helpers as shipped).
- UNINSTALL: remove ONLY product-owned components. NEVER touch user media,
  Resolve projects, recipes (`~/Library/Application Support/VapourSynth-OFX/recipes`),
  chat history, or shared software (Homebrew, Resolve itself). Optional
  separately-approved data removal for sidecars/configs. No Keychain
  changes during uninstall.

## OFX payload — now IN the DMG (portable staging)

`npm run dist` now embeds `build-portable/portable/VapourSynth.ofx.bundle` (built by
`cmake -DVSRES_PORTABLE_BUNDLE=ON --target portable_bundle`) into the app at
`VapourSynth Companion.app/Contents/Resources/OFX/VapourSynth.ofx.bundle`. That bundle
is self-contained:

- `Contents/Libraries/libvsscript.dylib` + `libvapoursynth.4.dylib`, referenced by the
  `.ofx` via `@loader_path` (verified: no dev-tree absolute paths remain)
- `Contents/Resources/vs-python/` — the Python `vapoursynth` package plus helper
  scripts (havsfunc, mvsfunc, …); the plugin prefers this over the dev PYTHONPATH
- `Contents/Frameworks/Python.framework` — embedded CPython (system deps only)

`tests/portable_smoke` (runs under ctest with `VSRES_PORTABLE_BUNDLE=ON`) proves the
payload headlessly: isolated `$HOME` → TOML entry for the bundled libvsscript →
VSScript init through the bundled framework → evaluate BlankClip → render a frame.

### Install steps (documented; still no graphical installer)

These are gated qualification steps, not a runnable general upgrade recipe. The
older `ditto <bundle> /Library/OFX/Plugins/` example was removed: ditto merges
source-directory contents into its destination and may overwrite files; it is not
an atomic bundle replacement. Merely adding the bundle leaf would still merge.

1. Select the exact reviewed/signed artifact and installation plan after its
   audit/licensing gates; the retained unsigned development app is not a release.
2. Coordinate the owner session after he saves and closes Resolve. The intended
   destination is `/Library/OFX/Plugins/VapourSynth.ofx.bundle`, with verified
   recovery/backup and replacement custody. See `docs/owner-live-session-checklist.md`
   and `docs/macos-ofx-transaction.md`. The transaction module supplies reviewed
   primitives; no shipped general installer or complete automatic swap is claimed.
3. Register the exact installed runtime using the reviewed `install_ofx_toml.py`
   maintenance helper and a directly selected Python3.11+ interpreter (the embedded
   Python3.14 supplies tomllib). Its dry-run is read-only, paths are escaped and
   unrelated TOML semantics preserved. An existing multiline own registration
   refuses rather than risking corruption. Unit tests are not live registration.
4. Let the owner perform the coordinated restart and per-item live qualification;
   source/unit/native smoke evidence cannot close that gate.

### Still NOT done (distribution gates)

- **Clean-Mac qualification** — the embedded runtime is verified on this machine only.
- **Signing/notarization** — unsigned (`-c.mac.identity=null`); Gatekeeper will block
  the DMG on other machines.
- **VapourSynth plugin set** — `lsmas`/QTGMC dependencies (`mvtools`, `havcorm` etc.)
  still come from the user's `~/Library/Application Support/VapourSynth/Plugins`, not
  the bundle. Source-mode chains need that path present.
- **License curation** — per-binary hashes/upstream revisions/licenses for the embedded
  dylibs and Python remain gate-3 work (see docs/notices-index.md).

## Entitlements

`build-resources/entitlements.mac.plist` — hardened runtime needs JIT and unsigned
executable memory for Electron, and library-validation disabled plus dyld environment
variables so the app can spawn the system Python used by `render_sample` and (Phase 0)
the Resolve bridge.


## ffprobe candidate provisioning (2026-11-01)

This candidate adds basic metadata probing through an external executable at
`Contents/Resources/runtime/ffmpeg/ffprobe`. It does not provide the separate
`ffmpeg`/idet scan-detection layer or change the installed OFX plugin. Existing
DMG, staged native bundle and rollback artifacts remain separate from this work.

The selected source is official FFmpeg **9.0.2**,
`https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz`, verified with its detached
signature and release-key fingerprint
`FCF986EA15E6E293A5644F10B4322F04D67658D8`.
The archive SHA-256 is
`8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e`.
The arm64 helper SHA-256 is
`17aee5da628fcb009a3ee15a007abf77e9506c77b2c84318aff3ced6cd8db632`.

FFmpeg libraries are linked into the helper with GPL, nonfree, version3,
external-library autodetection and network support disabled. Only ffprobe is
built; ffmpeg, ffplay, encoders, muxers, devices and avfilter are disabled.
The measured load commands declare macOS **13.0** and reference only Apple
system libraries/frameworks. This is a helper deployment declaration, not
qualification on macOS 13. The app's measured CPython floor remains **26.0**;
no overall supported-OS decision changes here.

`scripts/stage_ffprobe.py` consumes a verified local source-root/manifest. It
never downloads or builds dependencies. It checks hashes, source identity,
regular executable mode, arm64 load commands, minimum OS, system-only loads
and bounded provenance materials before atomically creating the new
`build-ffprobe/payload` directory. Existing destinations are not overwritten.
Its manifest retains the source archive, signature, public verification key,
license files and actual build configuration/evidence under
`payload/licenses/ffmpeg`. See the candidate entry in `SBOM.md`.

The `extraResources` entries copy only this helper and the selected compliance
materials. A packaged app must use the bundled executable and fail clearly if
it is absent, unusable or inside ASAR; it must not silently use Homebrew, PATH
or a development override. Development overrides remain available in source
mode. Focused resolver/staging checks and the recorded small synthetic probes
provide metadata evidence; packaged-path validation is recorded with the
separate unsigned candidate artifact.

Use existing installed packaging dependencies, an isolated output tree under
`build-ffprobe`, a sterile environment, explicit local Electron, disabled
rebuild/download hooks, and no Vite environment-file loading. Candidate
packaging disables signing, notarization and publication and does not replace
`companion-app/build`, `companion-app/dist` or the existing DMG. The ordinary
`npm run dist` procedure above is not the candidate-only validation command.

Source/configuration retention is not licensing, patent, redistribution or
release clearance. Preserve audit → fix/review → sign/notarize → clean-Mac
qualification and the coordinated owner-approved installation gate.
