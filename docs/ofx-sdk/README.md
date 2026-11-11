# Vendored OpenFX SDK

This directory vendors the OpenFX SDK we build against. Resolve 21's bundled SDK at `/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/OpenFX/` ships OFX 1.4 headers; we want 1.5 for the Metal render suite property (`kOfxImageEffectPropMetalRenderSupported`) and the color management API (`ofxColour.h`, `kOfxImageEffectPropColourManagementStyle`).

## Layout

- `openfx-1.5.1/` — upstream snapshot of [AcademySoftwareFoundation/openfx](https://github.com/AcademySoftwareFoundation/openfx) at tag `OFX_Release_1.5.1`. License: BSD-3-Clause (see `openfx-1.5.1/LICENSE.md`).
- Key files we link against:
  - `openfx-1.5.1/include/` — public OFX C headers (`ofxImageEffect.h`, `ofxColour.h`, `ofxDrawSuite.h`, etc.)
  - `openfx-1.5.1/Support/include/` — Blackmagic-style C++ wrapper (`ofxsImageEffect.h`, `ofxsParam.h`)
  - `openfx-1.5.1/Support/Library/` — wrapper implementation
  - `openfx-1.5.1/HostSupport/` — host-side library used by our headless test harness
  - `openfx-1.5.1/Examples/` — reference plugins; `ColourSpace/` and `Basic/` are particularly useful

## How we use it

`platform/macos/CMakeLists.txt` adds `docs/ofx-sdk/openfx-1.5.1/include/` and `docs/ofx-sdk/openfx-1.5.1/Support/include/` as include paths and links the Support library.

When Resolve 21 bumps its bundled SDK to 1.5, we can drop this vendored copy and point at Resolve's path instead.

## Updating

To update to a newer OFX release, replace the `openfx-1.5.1/` directory with a fresh clone of the target tag and update this README. We strip `.git/`, `.github/`, `Documentation/`, `logos/`, and `test_package/` from the vendored snapshot to keep the diff small (see [https://openfx.readthedocs.io](https://openfx.readthedocs.io) for full docs).
