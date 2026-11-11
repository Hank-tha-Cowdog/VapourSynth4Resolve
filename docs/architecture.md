# Architecture

Updated October 25, 2026 from the local source. This page describes implementation
and known limits; it does not establish an installed or released candidate.
The development records retain the historical check scope and
distribution gates.

## One OFX node, one companion editor

The macOS source defines one OFX effect with a separate Electron editor opened
through **Configure…**. The editor holds a chain of filter steps, color settings
and Skippy conversation state.

The editor waits for reported configuration before showing its editing controls
or starting automatic writes and setup effects. Its preload requests one snapshot
of configuration already held by Electron main; the older `host-sync` push remains
supported. The first received configuration is used once, so a late duplicate
does not replace local edits. A later snapshot can refine the reported origin.
Missing or unusable delivery keeps the editor waiting or unavailable, without
retrying or releasing defaults to a host target. Standalone mode is explicitly
reported when no host result path was supplied; it can start with defaults.
Automatic Resolve discovery and cached-source probing require reported host mode.
If either automatic request rejects, the renderer reports the update as
unconfirmed, retains cached source data and does not reset its attempt marker.
This feedback is visible with or without cached metadata; it does not establish
backend completion or schedule a retry for that failure.
Failure feedback is retained separately from discovery progress for this editor
view, so an unrelated later path match cannot clear an earlier unconfirmed update.

Manual source identification has a separate per-view admission guard for picker
and drop actions, acquired before awaiting a reply. A reported picker cancellation
or usable metadata result releases that local guard. A missing bridge detected
before invocation reports the error without a submitted request. Invoked requests
that throw, reject or return unusable/failure data retain an unconfirmed state and
hold further manual requests in that view. Draft configuration and cached source
data are not cleared by that error feedback. This guard does not coordinate other
views, automatic discovery or backend work, and does not prove cancellation or
make closing/reopening the editor a recovery mechanism.
Before adoption, manual replies must identify the requested path, include a
nonempty filename and parseable probe timestamp, and match the producer's base
nullable container/video/audio fields plus the optional fields read by current
UI heuristics. This rejects empty or wrong-shape metadata; it does not establish
metadata accuracy, source consent, bounded media resources or backend closure.

File drops use the preload's `webUtils.getPathForFile(File)` bridge rather than
the removed `File.path` field. The installed Electron 33 types include this API;
[Electron's migration guidance](https://www.electronjs.org/docs/latest/breaking-changes#removed-filepath)
places the removal in version 32. Missing bridge support, extraction errors and
items without a disk-backed path produce feedback before a probe is submitted.
The [API documentation](https://www.electronjs.org/docs/latest/api/web-utils)
describes native File validation and empty paths for JavaScript-created files.
This is a source contract; fake File/bridge checks do not qualify an actual
Electron drag/drop, file access or probe. The path is used for the existing probe
and reply-identity check; this bridge is not a general filesystem reader.
These are source contracts, not proof of a current host, native recovery or mounted
React behavior. See [editor bootstrap](../companion-app/src/services/editor-bootstrap.ts).

The reviewed macOS source uses an explicit manual workflow. After readiness,
debounced sync updates the companion's in-memory editor snapshot only; its
`editor-only` reply reports no pending file write. **Save and close** publishes a
session-bound pending configuration and schedules window closing. The user then
clicks **Apply companion changes** in Resolve's Inspector. That supported
InstanceChanged action reads and validates the pending revision before writing
`_config`; render actions do not perform that write. Host undo/redo can update
the applied cache through `_config` changes.

**Close** does not publish unsaved editor state in this manual mode. A reported
file publication is distinct from a host parameter write, project persistence or
rendering. A host write can change state before returning an error; the result
is then unconfirmed, without a rollback claim. Later status-write failures do not
undo an already returned successful configuration write. Existing nonmanual
bridges retain their legacy write behavior and labels.

The relevant code is [App.tsx](../companion-app/src/App.tsx),
[Electron main](../companion-app/electron/main.js),
[configuration feedback](../companion-app/src/services/config-write-feedback.ts)
and the [popout launcher](../platform/macos/host/popout_launcher.mm).
The current native source is uncompiled. Source review and 75 synthetic/SSR cases
plus noEmit do not qualify actual host persistence, app startup or filesystem and
module lifetime behavior.

## Inspector and color configuration

| Control | Current source behavior |
| --- | --- |
| `inputColorSpace`, `inputGamma`, `outputColorSpace`, `outputGamma` | Legacy Inspector choices are disabled and labelled inactive. Use the companion controls. |
| Inspector `swap` | The current macOS handler logs the action and performs no swap. |
| Companion **Swap** | Swaps the stored input/output color-space and gamma selections. |
| `mix` | Master wet/dry setting used by the chain composer. |
| `configure` | Requests a new companion exchange generation. Launch is submitted, not confirmed. |
| `applyCompanion` | Explicitly reads the active generation's saved revision and writes host parameters from InstanceChanged. |
| `status`, `_errorMessage` | Reported configuration/error information; not proof of a successful current render. |
| `_config` | Serialized chain, color settings and Skippy state. |

See [plugin_entry.cpp](../platform/macos/host/plugin_entry.cpp) for Inspector
definitions and callbacks.

The current [color implementation](../common/color/color.cpp) emits
`mvsfunc.ToYUV` / `ToRGB` matrix and format conversions. It does not invoke OCIO
or apply transfer-function transforms from the gamma selections. Those gamma
values are retained as labels and emitted comments. Individual filter scripts
can still change pixel values.

Recognized color-space tokens select a matrix; unsupported names fall back to
the Rec.709 matrix. A camera-gamut, ACES or log label in a menu is therefore not
evidence that its full transform is implemented. The UI identifies these limits
and distinguishes configured labels from measured output.

The stage list below describes ordering and includes planned filter examples.
It is not a statement of qualified runtime availability.

## Canonical filter stages

Each filter type declares a stage. The chain composer stable-sorts by stage before threading the script together.

| Stage | Name | Filters | Why |
|---|---|---|---|
| 10 | Preprocess | Script (flexible stage) | Custom preprocessing before structured stages |
| 20 | Field Operations | QTGMC, IVTC / Detelecine | Field structure must be resolved before any temporal/spatial filter that assumes progressive |
| 30 | Crop / Borders | (future) | Borders after fields |
| 40 | Denoise | BM3D, KNLMeans, MVDenoise (v2.1+) | Before sharpen and frame interpolation, which amplify noise |
| 50 | Restore | DePan, RemoveDirt (v2.3) | After denoise so repair targets aren't masked by noise |
| 60 | Sharpen / Detail | Custom sharpen (Script), LSFmod (future) | After noise/restore |
| 70 | Frame Operations | RIFE (CoreML), SVPFlow, Decimation (v2.2/2.3) | After temporal denoising stabilizes motion vectors |
| 80 | Resize / Scale | fmtconv resize (v2.3) | Geometric changes last |
| 90 | Format / Output | Chroma sub/upsample (v2.3) | Final container conversion before output color transform |

Script steps have a user-selectable stage so power users can splice custom Python anywhere.

The `manualOrder: true` toggle in the chain editor disables stage-sorting and respects the literal array order — for power users who deliberately need to violate the canonical pipeline.

## Source process layout

- **OFX plugin:** owns frame marshaling, synchronous host rendering and private
  companion sessions. Configure registers no result watcher, provider callback
  or in-process preview service.
- **Electron main process:** reads the supplied configuration file, exposes an
  own-window in-memory configuration snapshot and the compatibility `host-sync`
  push, services local IPC and publishes only an explicit manual save in the
  current host mode. Its latest-config snapshot is editor state also used by
  agentic tools; it is not a host-apply acknowledgement.
- **React renderer:** edits local state, presents settings and requests work
  through the [preload bridge](../companion-app/electron/preload.js).
- **VapourSynth/Python/plugins:** remain separate runtime dependencies. Their
  presence or a successful source build does not establish portable packaging
  or current host operation. See [packaging](packaging.md) and
  the development records.

## Single-frame preview

The current manual-host generation supplies no preview request/response paths.
The renderer shows preview unavailable, with no image controls or scheduled
requests. Waiting/legacy/standalone bootstrap states also keep the view gated
until an authoritative host preview mode is reported. Main rejects preview work
in manual mode before file access, including during delayed bootstrap delivery.

The older [preview service](../platform/macos/host/preview_service.mm) remains in
source but Configure does not start it. Its legacy PNG-mtime protocol is not a
correlated terminal acknowledgement. An IPC rejection or timeout cannot prove
native completion, and closing/reopening an editor cannot prove worker or
module cleanup. An external preview worker, stable admission, copied source
transfer, descendant closure and any automatic host wake remain unimplemented
or unqualified. IOSurface/playback transport remains future work.

## Private configuration exchange

Each admitted Configure creates an exclusive private directory with a new token and
config/result/status paths. The companion's explicit save atomically publishes
`{sessionId, revision, config}`. Native reads one bounded regular file with
no-follow custody checks, validates minimum known transport shapes and compares
revision plus canonical accepted configuration. A stale or conflicting body is
not reported already applied. These checks are not a global filter/script safety
validator or a credential audit.

Reopening retained pending work uses a **new generation**, so an older companion
cannot publish over the new result path. A complete stable bounded prior body
is copied into `prior-result.raw.json` when available; unsafe or unreadable input
has no invented snapshot. Earlier session directories remain retained for the
OFX instance lifetime and can still be changed by their old companion. Recovery
flags distinguish retained editor input from the host snapshot. Automatic sync
never publishes in manual mode; repair requires explicit Save and close.

| Argument | Direction | Current source contract |
| --- | --- | --- |
| `--config-path` | OFX → Electron | Initial editor input; retained pending edits or the host snapshot as reported. |
| `--result-path`, `--host-session-id` | OFX → Electron argv; saved file data flows Electron → OFX | OFX supplies the private result path and token. The companion saves an envelope there; the host Apply action reads it. |
| `--host-apply-mode=manual` | OFX → Electron | Editor-only automatic sync and explicit Save and close publication. |
| `--host-recovery-required`, `--host-config-origin` | OFX → Electron | Retained-repair intent and origin guidance; no native completion claim. |
| `--host-applied-revision` | OFX → Electron | Accepted revision floor for the session. |

The source anchors session ownership before any launch submission and commits
the active session without allocating afterward. Failed or unconfirmed launch
attempts retain their slot and reserve. Per instance, admission stops at eight
retained generations or 96 MiB of logical configuration/snapshot/accepted-body
reserve. This is not a total RSS, disk, status-file or orphan-file bound. At the
limit, no new launch is submitted and existing files remain available for
recovery/copy before the effect is reset.

AppKit is asked for a fresh application instance because argv applies only to
new instances. The installed SDK also says sandboxed callers can have argv
ignored. Submission is not proof of startup, argv delivery, companion closure,
module unload safety or a qualified Resolve session. Those native/host checks
and installation remain held.

The `apply-config` reply separates editor-only state, preparation refusal,
unconfirmed publication, reported publication and no host path. Scheduled
window closing is not a closure acknowledgement. A later reported operation
cannot resolve an earlier unknown outcome. Replies with unusable phase
information remain unconfirmed.

## Chain composition

[composer.cpp](../common/chain/composer.cpp) selects source mode, orders steps and
emits enabled steps whose approval is not false. Normal ordering is by stage;
`manualOrder` preserves array order. Format normalization currently produces
YUV420P16 before restoration steps, including in direct-file mode.

This abbreviated default-matrix/full-mix shape illustrates emitted fragments.
It is not a complete generated script or a runnable qualification fixture:

```python
import vapoursynth as vs
import mvsfunc as mvf
core = vs.core

src = source  # injected timeline source; direct-file mode uses lsmas instead
clip = mvf.ToYUV(src, css='420', depth=16, matrix='709')
# enabled, approved step fragments are inserted here
if clip.format.color_family != vs.RGB:
    clip = mvf.ToRGB(clip, depth=32, matrix='709')
if clip.format.bits_per_sample != 32 or clip.format.sample_type != vs.FLOAT:
    clip = mvf.Depth(clip, depth=32, sample=vs.FLOAT)
clip.set_output()
```

Optional mix handling and direct-source timeline resizing are emitted by the
composer outside that example. The preview and OFX paths call the same composer,
but their inputs, frame context and final dimensions can differ.

## Skippy and provider settings

Skippy's collapsible panel stores conversation and editor state in the node
configuration. [Provider setup](llm-providers.md) describes the Settings gear,
saved-key status, blank-entry behavior and endpoint choices.

The main-process [credential module](../companion-app/electron/keychain.js) uses
keytar for macOS Keychain access. The Settings status response contains saved-key
presence and a fixed mask; stored credentials and suffixes are not part of that
response. Real Keychain/provider
qualification and release-bound credential auditing remain separate from
source and mocked checks; see [credential hygiene](credential-hygiene.md).

The [dispatcher](../companion-app/electron/llm/index.js) uses namespaced model IDs
and the [source provider catalog](../companion-app/electron/llm/providers.js).
Model availability and live tool behavior are not established by a catalog
entry. Prompt construction, operation decoding, proposal approval and tool
authority have separate implementation and acceptance boundaries.

The [renderer request client](../companion-app/src/services/archivist.ts) retains
uncertain-request state when setup/cancellation cannot establish completion.
Further dispatch stays blocked until the corresponding existing terminal
observation resolves that state. An abort request does not prove rollback of
responses or changes already received.

Compaction is implemented in [compactor.ts](../companion-app/src/services/compactor.ts).
It can use a provider request; its existence does not authorize or qualify live
provider execution. Installation, licensing, security and publication gates
remain unchanged.
