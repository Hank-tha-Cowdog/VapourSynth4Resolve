# Companion process bounds and cancellation

These source changes add visible, configurable failure bounds and retain ownership while a stopped child is unconfirmed. They are local correctness hardening, not a Python sandbox, a native memory/CPU/disk limit, descendant-process closure proof, or owner-footage performance qualification. The retained unsigned `4a866f3` app does not contain these changes.

## Preview budgets

`renderPreviewFrame` accepts optional numeric `timeoutMs` and `maxOutputBytes`, also forwarded by `preview:render-frame`. Selection is explicit API value, then the corresponding startup environment value, then default:

| Setting | Environment | Default |
| --- | --- | --- |
| `timeoutMs` | `VSRES_PREVIEW_TIMEOUT_MS` |30,000ms |
| `maxOutputBytes` | `VSRES_PREVIEW_MAX_OUTPUT_BYTES` |16MiB |

Omission/undefined selects the next source; explicit null, zero, negative, fractional, nonfinite or unsupported values fail visibly. Timers accept integers 1–2,147,483,647ms, the actual Node timer range. Capture budgets accept positive safe integers up to the running Node `buffer.constants.MAX_STRING_LENGTH`; this is a string representation limit, not a product geometry maximum. Values are never silently clamped. No new UI control is added. Trusted module/IPC callers or the app's startup environment can select a larger finite budget when needed.

The persistent worker's deadline runs from request admission through queue waiting and response. Superseded queued requests settle without dispatch. An independent queued deadline does not kill a healthy active request. One-shot rendering keeps its post-spawn clock. Runtime selection's separately bounded selfcheck runs before rendering; neither deadline bounds the whole IPC call or synchronous filesystem latency.

The worker counts UTF-8 stdout bytes for an outstanding response, including ignored chatter and partial lines. Accounting resets for each admitted response/dispatch; healthy worker lifetime output is not cumulatively capped. One-shot capture counts combined stdout/stderr per child and discards bytes after a terminal stop. These text-capture limits are separate from the encoded-PNG acceptance policy below. They do not bound Python/native memory, native writer disk use or child-created descendants.

The 30s default follows the existing one-shot render budget. The 16MiB policy leaves headroom above a synthetic ordinary three-plane scope payload containing 126,976 fixed histogram/grid cells plus four 8192-column profiles. Source dimensions and metadata are not universally bounded to that geometry. This is a conservative operational default with explicit failure and overrides, not a format maximum or proof every valid chain completes inside 30s.

A persistent timeout, capture overflow, malformed matched response, pipe error or disposal requests termination through the retained child handle. Signal acceptance is not close. The worker observes close for 5s after stopping; refused/throwing stop or expired observation returns `closureKnown:false`, `closureUnknown:true`, `noAutomaticReplay:true` and retains the exact child until actual close. Fatal failures settle queued work and do not replay it later. A deliberate source-priority switch may dispatch the newest source only after the previous child closes. Known closed spontaneous crashes preserve the established fallback contract. Returned script errors never acquire fallback permission merely from their text.

One-shot timeout/error/overflow likewise retains its consumed script path while close is unconfirmed and blocks further one-shot admission until the stopped children close. An accepted stop observes actual close for up to 5s; failed/throwing stop or expired observation returns unknown closure without claiming the stop succeeded. Drafts use exclusive UUID filenames, 0600 descriptor writes and dev/inode ownership checks for cleanup. A replaced file is not deleted. The persistent worker consumes inline script text, so its caller-owned draft can be cleaned independently of worker close.

## Metadata and neural probes

Probes collect stdout and stderr separately under a combined byte budget, stop on timeout/cancellation/overflow, and parse only normally completed output. A stopped child quarantines its probe kind until that exact child closes; healthy concurrent probes retain their existing behavior. Multiple already-running stopped children retain independent tokens, so an old close cannot release another child's guard. Public probe failures use `closed` and `cleanupUnconfirmed` (rather than the preview's `closureKnown`/`closureUnknown`) plus `noAutomaticReplay`. The 5s post-stop observation is separate from the operation deadline.

| Probe kind | Default timeout | Default combined capture |
| --- | --- | --- |
| FFprobe metadata |60,000ms |16MiB |
| MediaInfo |60,000ms |16MiB |
| idet |max(120,000ms, frame count×1,000ms) |4MiB |
| Neural capability |300,000ms |4MiB |

Each caller accepts explicit numeric `timeoutMs`/`maxOutputBytes` options and startup environment defaults `VSRES_<FFPROBE|MEDIAINFO|IDET|NEURAL>_TIMEOUT_MS` / `VSRES_<FFPROBE|MEDIAINFO|IDET|NEURAL>_MAX_OUTPUT_BYTES`, with explicit options first. Validation uses the same finite timer/string representation bounds. These provisional operator policies have not been benchmarked against owner media or cold models. Metadata/tags have no universal small JSON maximum; decoding 120 frames is not a wall-time guarantee; cold backend/model loading differs from preview selfcheck. Unusually large or slow legitimate work can choose larger explicit bounds and receives a visible failure if a default is insufficient.

FFprobe still rejects primary metadata failure. Optional idet/MediaInfo failures remain unavailable diagnostics; timeout/overflow must not become success from a retained early summary. Neural usability requires a normal successful exit and a successful inference verdict from stdout; stderr JSON cannot fabricate usability. A normal helper exit1 failure verdict remains informative. Timeout does not reveal which backend/load/inference stage completed, so those stages remain unverified.

The source registry waits for metadata and optional analyses together; finite child lifetimes fix the known optional-child hang path. Its preceding synchronous head/tail hashing and other filesystem reads are not made wall-bounded by child timers.

## Model transfer settlement

A model transfer owns one identity-bound attempt across request, response, writer, verification and redirects. Response abort/error/premature close, request/output failure, cancellation and byte-cap rejection share a single terminal path. Publication requires normal response completion, finished/closed writer, verified digest and still-current ownership. Stale callbacks cannot publish or release a newer attempt.

Cancellation acknowledgement means `cancellationRequested:true`; confirmed cancellation returns `cancelled:true,closureKnown:true` only after owned stream closure and verification settlement. A 5s observation window starts only after cancellation/failure/size rejection. Unknown closure returns an explicit error and `closureKnown:false`, retains the guard and partial, and blocks retry/removal/extraction. It intentionally does not return `cancelled:true`, which would hide the error in the existing UI. Actual late close may clean/release the owned attempt without rewriting the earlier returned result. Valid downloads and successful slow writer close receive no new total-duration deadline. The existing registry-derived byte cap is unchanged.

Redirects retain the same attempt, resolve relative locations, require HTTPS and do not mutate registry URLs. The 20-hop limit follows the installed Fetch implementation's redirect bound; failure names the limit. HTTP and stream behavior is tested with fakes, not real model requests. Same-user hostile filesystem races and extractor containment remain separate review items.


## Runtime selection and namespace probes

Runtime selfcheck now uses the same owned-child lifecycle: default 10,000ms, 1MiB combined capture and 5,000ms post-stop close observation. Startup `VSRES_SELFCHECK_TIMEOUT_MS` and `VSRES_SELFCHECK_MAX_OUTPUT_BYTES` select explicit positive supported values; invalid values fail visibly. The helper emits only import-contract metadata or a classified failure, without core/frame/model loading. 1MiB leaves broad metadata/import-diagnostic headroom; version/path/import output is not universally length-bounded, so this is an overridable operational policy. Render request budgets remain separate from these startup settings.

A pending selfcheck stop blocks trusted seams, capability cache hits, candidate fallback, draft allocation and render dispatch, with checks after awaits. Operational timeout/overflow, malformed/signalled output or process/pipe failure aborts resolution as `selfcheck:true, capabilityUnknown:true, noAutomaticReplay:true`; closure flags preserve what was actually observed. Such failures are not cached as missing backends. Normal completed capability negatives retain classified candidate fallthrough and the existing 60s negative TTL; successful capability results remain cached. Latest-started per-key publication tokens and explicit invalidation fence older completed probes from repopulating cache or authorizing stale rendering. The helper's actual exit 0 negative convention and structured ENOENT/EACCES classifications are preserved. Whole-IPC latency, native memory and descendant closure remain outside these guarantees.

Namespace/core-plugin probing defaults to 60,000ms/4MiB combined capture, with `VSRES_NAMESPACES_TIMEOUT_MS` / `VSRES_NAMESPACES_MAX_OUTPUT_BYTES` startup defaults and explicit options through `probeNamespaces({force, timeoutMs, maxOutputBytes, signal})`. Budget settings apply to an actual refresh; use `force:true` to refresh an established healthy cached snapshot with a new budget. Core/plugin loading is heavier than the import-only selfcheck; these defaults are provisional, visibly overridable policies rather than performance qualification. A normal exit 0 and a complete string-array verdict are required for verified namespaces. A verified empty `[]` differs from unavailable `namespaces:null`.

The namespace function stays lazy and retains established cache/force behavior without coalescing concurrent probes. Stable missing-runtime/helper and normally closed component failures remain cached until force; operational failures clear only their current generation's cache and are not negatively cached. Only the latest started refresh may publish or clear the cache; an older close/error cannot replace a newer snapshot. Pending stopped-child tokens block cache reuse/new admission until actual close. A healthy cached read during a healthy forced refresh preserves the earlier behavior. No real plugin/core timing or registration qualification follows from fake-child tests.


## Encoded preview PNG output

`maxPngBytes` is a per-request encoded-PNG acceptance budget, with explicit numeric request first, then startup `VSRES_PREVIEW_MAX_PNG_BYTES`, then 128MiB. Positive integers must fit both Buffer storage and the complete base64 data-URL string representation. Invalid values, including explicit null, fail visibly before dispatch; limits are never silently clamped. An 8192×4320 RGB24 raster is 101.25MiB before PNG overhead. This is operational headroom, not a universal format/geometry maximum or owner-footage qualification. Larger finite budgets remain explicit. No preview resizing, cadence, SAR or scope math changes. Overflow returns `pngOutputLimit:true`.

Each request gets an acquired canonical 0700 output directory and exactly `frame.png` / `frame0.png`. No-follow nonblocking descriptors require a nonempty regular single-link same-UID file with stable identity/metadata, bounded chunks and exact EOF. The worker's non-wire dispatch observer binds the output lease to its exact child generation; a matching normal response or actual owned child close ends cooperative writer ownership. Unknown-close errors retain the lease. Healthy completion detaches its close listener. One-shot observer failure after spawn follows owned stop/close handling; it cannot be relabeled as a never-started child.

The Python common writer checks the selected final path and numbered scratch, validates output size before publication, cleans the exact owned numbered file before fallback/retry, and preserves verified same-UID single-link final-file reuse for direct helper clients. Existing symlink/hardlink/special/foreign targets and preexisting numbered files are refused. The existing display-only 709 matrix fallback is labeled in both paths. Already returned scopes/display assumptions are forwarded; one-shot request-shape/scope-computation differences are separate work.

These checks do not bound fpng allocation or disk writes before frame evaluation returns. Identity checks plus rename are cooperative guards, not atomic compare-and-swap against a same-UID adversary. They are not a Python/native extractor sandbox or a disk quota. B1′ and formal review remain open.

## Completion records and recovery

Model containers must be ordinary strict canonical children of the selected models root. Listing validates before marker reads/measurement and does not follow static nested symlinks for measured scope. Invalid containers report failed with null installed paths. Readiness requires a single-link regular no-follow descriptor, bounded 64KiB completion metadata, stable identity and the current exact id/version/sha256/extractedAt schema. The marker records product completion metadata; it does not prove payload presence, usability or publisher trust. Unrecognized/linked/legacy records remain present and report recovery guidance.

Completion publication uses a random exclusive no-follow temporary and owned-inode checks before rename; it cannot truncate a linked target through the old marker name. Cleanup touches only an acquired unchanged temporary. `canDiscard` is true only for failed rows with a validated existing ordinary container and no tracked transfer/extraction. The UI requires strict true, explicit backend scope and confirmation; false/missing/rejected removal outcomes remain visible. Tracked unknown-close ownership is never a discard capability in the current process. Same-user ancestor races and native pre-scan writes remain separate containment gaps.


## Model extractor lifecycle

Extraction drains stdout and stderr under a combined 4MiB diagnostic budget and a 30-minute direct-child deadline. Explicit numeric `timeoutMs` / `maxOutputBytes`, then startup `VSRES_MODEL_EXTRACT_TIMEOUT_MS` / `VSRES_MODEL_EXTRACT_MAX_OUTPUT_BYTES`, override those provisional defaults; invalid values fail visibly before writer dispatch. Routine/progress output is suppressed with documented 7z `-bso0 -bsp0`, retaining `-bse2` errors. No archive-size formula, hardware benchmark or new cancel UI is implied. Child timeout/capture is separate from valid archive hashing, which retains no total-duration deadline.

A digest at end-of-stream remains provisional until the owned reader closes. The first pre-close error overrides a digest and remains authoritative. A failed hash starts a five-second close observation; an unknown return retains its exact record until reader close. The child path uses the shared five-second stop/close observation, requires normal exit 0 before scan/publication and retains owned records until finalization, hash close and direct-child close/proven no-start. Late close cannot publish success or clear a newer attempt.

After validation and before 7z starts, extraction creates/adopts a pinned `.extraction-unverified.json` record and moves any old completion marker to an exclusive same-parent `.completion-*.record` reservation. Same-parent custody preserves relative marker-link resolution. Active extraction and any persistent status flag block Ready. Only normal successful extraction, postscan, owned completion publication and removal of the exact acquired flag restore readiness. Retained `.completion-*` reservations/records are metadata custody; they are not automatically restored or deleted. In-place 7z may have changed payload files on failure. This is no staged payload transaction, rollback or crash-durability guarantee.

In-memory ownership/quarantine survives only the running application and deliberate module reload with shared tokens. A true app/process restart loses those Maps. A retained flag prevents false Ready across restart; it does not prove an old native child or descendant stopped, and does not serialize explicit retry/removal across application restart. Same-UID races, native writes/allocations, OS/filesystem latency, descendants and hostile-process containment remain separate B1′/formal-review work.

## Neural model-read admission

The capability caller now uses the model manager's read-only `inspectModelForRead` snapshot before payload-name enumeration or helper admission. Unsafe containers, invalid managed completion metadata, a retained extraction-status flag, active transfer/extraction or unconfirmed extractor work return structured unavailable guidance. The query performs no tool discovery, tree measurement, mutation or process dispatch. Ordinary absent locations remain absent; ordinary contained manual/no-marker weights remain eligible as explicitly unverified legacy inputs.

The caller validates ordinary directory and single-link ONNX metadata, refuses static nested aliases, handles filesystem errors structurally and requeries its container/completion/leaf signature after the asynchronous helper. A changed or refused observation cannot publish usable or trigger automatic replay. The supported Python helper still uses its default model location and adapter-controlled resolution. A different `VSRES_MODELS_ROOT` is refused before enumeration/helper dispatch, rather than checking one tree and probing another.

These snapshots are not a read lease: new extraction can begin while an already admitted neural child runs, and same-UID/ancestor races remain possible. A normal inference verdict does not prove the adapter loaded the exact JavaScript-inspected bytes or a registry-pinned payload. Legacy positives stay labeled unverified; managed completion metadata is not payload trust. Actual helper/adapter model-path qualification, interprocess/restart ownership and B1′ containment remain separate work.
