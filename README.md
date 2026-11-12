# VapourSynth for Resolve v2

VapourSynth for Resolve brings a Python filter chain into a DaVinci Resolve OFX node.
An Electron companion provides a chain editor, Script steps, preview controls and the
Skippy chatbot for help writing VapourSynth scripts.

**Development alpha.** Current work targets macOS 26+ on Apple Silicon (arm64).
The project now ships a self-contained OFX plugin bundle and a signed companion app
as an **alpha DMG** via the releases page; clean-Mac and live-Resolve
qualification of the current candidate remain open. Windows and Linux ports are
planned; there is no runtime qualification on those platforms.

The tool is intended to remain free and open source. Optional cloud providers have
their own accounts, terms and billing; an API key is unnecessary for manual chain editing.

## Current status

The October 26+ workflow: **Configure…** → edit in the companion → **Save and
close**. When the dev-launched companion exits, the host observes the process
exit and applies the saved revision on the main thread through the same path as
the **Apply companion changes** button, which remains as the fallback (shipped
app launches have no observable PID and stay manual). Automatic editor sync
keeps edits in memory; it does not publish a pending file. The clip-mode OFX
source now degrades out-of-window temporal fetches to the nearest in-window
frame instead of failing the whole chain, and QTGMC declares a ±10 frame
window to cover its TR0 + vector + SourceMatch reach.
The October 26 local verification rebuilt this exact source end to end: native
Release/arm64 compile (including the opt-in companion-exchange test, which passed
under its required fresh `VSRES_NATIVE_TEST_ROOT` fixture), the 43-case macOS OFX
transaction suite, all 353 companion node test cases (277 across the electron
suites plus 76 across the four registry suites), the TypeScript check, the Vite renderer build, an OFX
bundle load smoke test (`OfxGetPlugin` resolves) and an unsigned local arm64
companion DMG. The sample renderer now refuses `raw_script` before any effect;
its execution tests cover the two declarative modes with explicit refusal coverage.
Live qualification, October 26 (Resolve 21.1.1, Apple Silicon): the installed
bundle renders a QTGMC chain in source-mode at 1080p (~0.7 s/frame on preset
Slower), auto-identify binds the playhead clip's media path on Configure, the
companion's saved revision auto-applies on exit, the clip-mode OFX source
retargets out-of-window temporal fetches instead of erroring, and the
"Synthesizing clip…" courtesy overlay shows/hides around slow first renders.
Remaining limits: the overlay/AppKit work is main-queue-confined but not
qualified under render-cancel races; per-dimension VS cache thrash across
viewer/thumbnail sizes is inherent and unoptimized; clip-mode edge quality
(repeated frames at the window edge) is a degradation, not an error — prefer
identified sources for restoration. Native preview is unavailable through this
workflow. This repository is the public source release; signed alpha DMG builds
ship via the releases page.

The current candidate rebuilt from a clean tree ran the full companion suite (797
tests across 66 files, green), the native composer and private-IO suites, TypeScript
and the Vite renderer build; the portable OFX bundle staged for the alpha DMG passes
its bundled-path policy audit. These checks establish local build/unit behavior.
They do not establish live Resolve rendering, real Keychain/provider integration or
installation on another Mac — a clean-Mac qualification run and live-Resolve pixel
checks remain open.

## Implemented development features

- A chain editor with stage ordering, drag reorder, Manual Order, enabled/draft state
  and a CodeMirror Python editor for Script steps.
- A typed QTGMC panel; other filters depend on the actual installed VapourSynth plugins
  and helpers. The static plugin catalog is a guide, not live availability proof.
- An OFX/companion configuration bridge, preview and log controls, and stored color
  settings. Color controls are not proof of complete OCIO transforms or color fidelity.
- Provider selection and Settings for cloud keys and local endpoints. Anthropic has
  the implemented tool-edit loop; other provider adapters are text-only. Model IDs
  and provider compatibility need verification against actual accounts/endpoints.
- A macOS native implementation using OpenFX, VapourSynth R75 and Apple frameworks.

Script steps execute Python when the chain is evaluated. Review scripts and proposed
edits before approving them, and use isolated test projects and media during alpha testing.

## Settings and credentials

Open **Configure…**, then the gear in Skippy chat header to open provider settings.
Enter a cloud provider key in its password field and select **Save**. The macOS backend
uses Keychain through keytar. Status shows a full mask; **Forget key** removes the entry.

The application does not import keys from legacy plaintext secret files or environment
variables. Keys previously configured that way must be entered explicitly in Settings.
Local LM Studio/Ollama backends use endpoint settings and do not require a key.
Endpoint settings accept HTTP(S) base URLs without userinfo, query strings or fragments.

Never commit keys or put them in scripts, issue reports, screenshots or command arguments.
See [provider configuration](docs/llm-providers.md).

## Developer build

This is a development workflow; the build scripts require tools and make changes
to a development environment.

The selected release target is macOS 26.0 or later on Apple Silicon (arm64), pending
qualification. See [selected macOS policy](docs/macos-support-policy.md). Development
requires CMake 3.24+, a C++20 toolchain, VapourSynth/VSScript libraries, Python and
Node/npm. Lower component minima do not change the product requirement; no supported
runtime certification follows from a deployment target or metadata declaration.
The tested local tool versions are those recorded across this repository's build scripts.

Read [macOS build details](docs/building-macos.md) and review the scripts before preparing
VapourSynth and companion dependencies. With those dependencies already available:

```sh
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_OSX_DEPLOYMENT_TARGET=26.0 -DCMAKE_OSX_ARCHITECTURES=arm64 \
  -DVSRES_VS_PREFIX="$PWD/vendor/vapoursynth/active" -DVSRES_BUILD_TESTS=ON
cmake --build build --parallel 2
ctest --test-dir build --output-on-failure --no-tests=error
```

Companion source checks, from `companion-app/` with existing dependencies:

```sh
npm run test:credentials
npx tsc --noEmit --incremental false
npm run build
```

These example commands do not install the plugin into Resolve. The alpha packaging
pipeline (`cmake --build <build> --target portable_bundle` plus the companion's
`npm run dist`) stages the self-contained OFX bundle, the embedded Python/VapourSynth
runtime, curated plugins and per-component notices into the DMG. [Packaging notes](docs/packaging.md)
document the pipeline and its known limits; clean-Mac qualification of the shipped
artifact is still open.

## Project layout

| Path | Purpose |
| --- | --- |
| `common/` | C++ chain schema/composer, filters, color/marshal/config/IPC/logging |
| `platform/macos/` | OFX entry, host integration, native frame I/O, launcher and preview |
| `platform/windows/` | Legacy Windows v1 source; not a tested v2 port |
| `companion-app/` | Electron main/preload, provider adapters and React UI |
| `tests/` | Current standalone C++ composer test runner |
| `scripts/` | Development build/setup and restoration utilities |
| `docs/` | Architecture, developer notes, provider configuration and OpenFX SDK |
| `vendor/` | Ignored local development dependencies; not a redistributable release payload |

The portable core should stay separate from platform adapters for paths/processes,
plugin discovery, Resolve integration, secure credentials and installers. Windows and
Linux require their own dependency/license inventories and actual runtime tests.

See [architecture](docs/architecture.md) for the current design. The development Electron
entry point also starts a loopback MCP listener; hardened external-agent/MCP exposure is
a future-version proposal, not a v2 release acceptance requirement or tested security claim.

## Contributing and reporting problems

Include the source revision, OS/architecture, Resolve version, exact component versions,
steps to reproduce and relevant redacted diagnostics. Label whether a result came from
unit tests, a mock, a local native run or a clean-machine installation. Preserve original
failures and use small synthetic fixtures where possible. Do not include private footage,
project exports or credentials in public reports. Do not disclose a suspected secret publicly.

## License

The existing root [LICENSE](LICENSE) contains GPLv3 for the native project. The companion
package metadata and existing project declaration specify MIT. Each third-party component
retains its own license and notices; no license was changed by the October documentation update.

VapourSynth is LGPL-2.1-or-later. Linking LGPL software does not itself require every caller
to use GPL. Copied-code provenance, the GPL/proprietary Resolve host boundary and exact
per-component distribution obligations are tracked in the notices
([notice index](docs/notices-index.md), [SBOM](docs/SBOM.md)). The entire tree must
not be relabeled with a permissive license to bypass those terms.

## Credits

- Original Windows OFX work and VapourSynth: Fredrik Mellbin and contributors.
- v2 development and companion: Hank-tha-Cowdog.
- Companion shell: VapourSage; Resolve bridge source credits First Cut v3.
- OpenFX: Academy Software Foundation and contributors.
- BM3DMETAL: Sunflower-Dolls.
- vs-mlrt: AmusementClub.
- Filter, helper and runtime authors retain their own credits and notices.
