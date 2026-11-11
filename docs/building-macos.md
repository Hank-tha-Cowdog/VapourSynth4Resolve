> **Current OS policy (2026-11-02):** The owner selected macOS26.0+ on Apple Silicon (arm64) as the release target, pending qualification. See [selected policy](macos-support-policy.md). Earlier floor-decision/recommendation wording is historical; metadata implementation and runtime/release gates remain open.

> The Phase0/1 instructions below are historical. Their macOS13/Python3.11
> assumptions are not the current release recipe. The existing source script
> selects brewed Python3.14/3.13/3.12; the saved candidate embeds3.14.7.
> Future release configure must explicitly pass deployment target26.0 and
> architecture arm64 before compiler initialization, using qualified inputs.

# Building on macOS

> Phase 0: scaffolding only. The build produces a passthrough OFX bundle that loads in Resolve 21. Real filter rendering lands in Phase 1.

## Prerequisites

- macOS 13.0 or later on Apple Silicon
- Xcode 15+ (Command Line Tools is not enough — we need the full Xcode for `xcrun metal`)
- CMake 3.24+ (Homebrew: `brew install cmake ninja`)
- DaVinci Resolve Studio 21 installed (for testing; the build itself doesn't need it)
- Python 3.11 (for the bundled runtime — Phase 1)
- A Developer ID Application code signing identity (for installer signing; not required for local-only testing)

## Build VapourSynth from source (preferred — pin to a known version)

```sh
./scripts/build-vapoursynth.sh R75
```

Builds VapourSynth into `vendor/vapoursynth/install-R75/` and symlinks `vendor/vapoursynth/active -> install-R75`. The script:

- Verifies brew has `zimg` and `python@3.11`
- Creates an isolated Python venv at `vendor/vapoursynth/.venv` and pip-installs `meson`, `ninja`, `cython`
- Clones VapourSynth at the given tag into `vendor/vapoursynth/src-<TAG>/`
- Builds with Meson into `vendor/vapoursynth/build-<TAG>/`
- Installs to `vendor/vapoursynth/install-<TAG>/`

To upgrade later: `./scripts/build-vapoursynth.sh R76` (or whatever the current stable tag is). Multiple versions can coexist side by side — switch the `active` symlink to pick one.

## Build the plugin

```sh
cmake -S . -B build \
    -DCMAKE_BUILD_TYPE=Release \
    -DVSRES_VS_PREFIX=$(pwd)/vendor/vapoursynth/active
cmake --build build
```

Or, for quick dev iteration, omit `VSRES_VS_PREFIX` and fall back to Homebrew's VapourSynth:

```sh
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build
```

Output: `build/VapourSynth.ofx.bundle/`. Copy to `/Library/OFX/Plugins/` to load in Resolve:

```sh
sudo cp -R build/VapourSynth.ofx.bundle /Library/OFX/Plugins/
```

Relaunch Resolve fully (Cmd-Q, not just close window). The plugin appears in the Color page's OpenFX library under the `VapourSynth OFX` group as `VapourSynth`.

## Universal binary

```sh
cmake -S . -B build-univ -G Ninja \
    -DCMAKE_OSX_ARCHITECTURES="arm64;x86_64" \
    -DCMAKE_BUILD_TYPE=Release
cmake --build build-univ
```

## Codesign + notarize (Phase 1+)

```sh
codesign --force --options runtime \
    --sign "Developer ID Application: YOUR NAME (TEAMID)" \
    build/VapourSynth.ofx.bundle
xcrun notarytool submit build/VapourSynth.ofx.bundle.zip --keychain-profile "AC_PASSWORD" --wait
xcrun stapler staple build/VapourSynth.ofx.bundle
```

## Companion app

```sh
cd companion-app
npm install
npm run electron:dev   # development with live reload
npm run dist           # builds a notarizable .dmg
```

## Troubleshooting

**Plugin doesn't appear in Resolve's OpenFX library**

- Confirm the bundle is at `/Library/OFX/Plugins/VapourSynth.ofx.bundle/Contents/MacOS/VapourSynth.ofx`.
- Check Console.app, filter on subsystem `com.vapoursynth.resolveofx`. The plugin emits `os_log` info messages on instance creation.
- Relaunch Resolve fully (not just close-and-reopen the project).

**`ofxsImageEffect.h` not found at build time**

- The build expects `docs/ofx-sdk/openfx-1.5.1/` to be present. If you cloned without `--recurse-submodules` (we don't actually use submodules, but if you partial-cloned), re-vendor the OFX SDK per `docs/ofx-sdk/README.md`.
