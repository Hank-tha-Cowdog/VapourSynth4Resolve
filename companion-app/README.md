# VapourSynth Companion

Electron + React popout window for the VapourSynth OFX plugin in DaVinci Resolve.

Forked from [VapourSage](https://github.com/Hank-tha-Cowdog/vapoursage). The standalone-app surfaces (Projects, Assets, Queue, Review) are stripped; the popout focuses on the filter chain editor + scopes + preview + the persistent "Skippy" chat panel.

## Status

Phase 0 scaffolding. The shell mounts a three-pane layout (Filter Library / Chain Editor / Skippy), the synthwave-themed header renders, the runtime spawn path from vapoursage is intact. Filters, IPC sync with the OFX host, IOSurface preview, and the live LLM call wiring are Phase 1 work.

## What was kept from vapoursage

| File | Notes |
|---|---|
| `electron/main.js`, `electron/preload.js` | Portable Python + ffmpeg + VS plugin runtime. Direct copy. |
| `src/components/SystemLog.tsx`, `UI.tsx`, `ModuleCard.tsx`, `SettingsModal.tsx` | Reused. |
| `src/components/ArchivistChat.tsx` | Renamed from `SageComms.tsx`. Resizable right-side chat panel. Phase 1 swaps the Sage-specific copy + plan-confirmation hooks for Skippy + chain-edit-confirmation. |
| `src/services/gemini.ts`, `runtime.ts` | LLM and runtime check services. Phase 1 adds `openai.ts` + `anthropic.ts` siblings. |
| `src/views/EditorView.tsx` | Will become `ScriptPanel` in Phase 1 (Script filter step UI). |
| `src/utils/formatting.ts` | Time / size formatters. |

Imports in the copied files still reference the old vapoursage paths (`'../types'`, `'../constants'`, etc.). Phase 1 rewires them to the new `src/types.ts` and `src/constants.ts` layout in this companion-app.

## What was stripped

`ProjectsView`, `AssetsView`, `QueueView`, `ReviewView` (84 KB), `SourceView`, `PlannerView`, `AssetSidebar`, `MetadataModal`, `ProjectModal`, and all the standalone-app state/types. Resolve owns project / source / queue / review when we run as an OFX popout.

## Run (Phase 1+)

```sh
cd companion-app
npm install
npm run electron:dev
```

The Electron app expects a bundled runtime at `Contents/Resources/runtime/` (Python 3.11, ffmpeg, arm64 VapourSynth + plugins). Phase 0 just exercises the shell — Phase 1 wires the runtime in.
