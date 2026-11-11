# Security posture decisions — 2026-11-11 (independent re-review closure wave)

Scope: the decisions an independent security re-review of `c11a43d` left to the
owner, plus the fixes that implement them. This document is the record of *why*,
so a re-reviewer can test the stated behavior instead of re-deriving intent.
The findings below are closed in this tree; independent re-checks against the
stated behavior are welcome and encouraged.

## 1. Approval binds executable content (High, conditional)

A step executes only when `approved == true` AND `approvedContent` is a
non-empty string AND it byte-equals the freshly emitted body. Missing value,
non-bool value, empty binding or drift ⇒ not approved (fail closed). One
shared gate (`gate_step` / `summarize_chain`) feeds `compose_script`,
`isIdentity` and every status surface, so they cannot disagree. Name, type
and parameter edits that reshape emitted Python clear approval; label-only
edits keep it. Approval is never portable through intake: recipes, MCP/other
composer operations and library adds all arrive `approved:false` with no
binding; only an explicit Approve click in the destination editor sets it.
Cross-language parity is pinned by a shared fixture consumed by both the
native suite and the companion node test.

## 2. Renderer/main IPC sender + navigation policy (High, conditional)

`isTrustedSender(event)` = the request's sender must BE the editor window's
own `webContents` (same identity rule the configuration getter used).
Applied to every execution-capable handler: `execute-script` (Python stdin),
`preview-chain`, `preview:render-frame`, `apply-config`,
`app:save-text-file`, `keychain:set-api-key`/`set-endpoint`, `clip:probe`,
`archivist:send`. Refusals return an explicit "Untrusted sender" error
BEFORE any probe, spawn, file write or provider dispatch; a destroyed
editor window is refused the same way. Navigation away from the app page is
blocked and child windows are denied (a navigated renderer would otherwise
keep the preload bridge).

## 3. Private writes migrate or refuse (Medium)

`common/fs/private_io.{h,cpp}` (unit-tested by `tests/unit/test_private_io.cpp`):

- **New files** ⇒ 0600, `O_NOFOLLOW` (symlink at the final component opens
  fail; the check is on the opened descriptor — no TOCTOU).
- **Existing broader files** (e.g. 0644 from an older build) ⇒ *migrated*:
  fchmod 0600 + truncate on the SAME verified descriptor, then write.
- **Hardlinked targets** (nlink > 1) ⇒ *refused* (writing through them would
  modify content reachable under another name).
- **Foreign owner / non-regular file** ⇒ refused.
- **Directories**: created 0700; existing ones must be real directories
  (never symlinks), owned by this user, and are tightened to 0700; the
  parent chain up to $HOME is verified the same way. A symlinked component
  refuses the write instead of redirecting it.
- The opt-in `VSRES_LOG_SYSPATH` diagnostic applies the same
  fchmod/truncate-after-checks logic (Python side).

Behavior on refusal: best-effort files (sidecars, diagnostics) are skipped
with an honest log line — never written through the unsafe path.

## 4. Build-path interpolation (Medium, conditional)

Both interpreter-setup path injections are now hex-encoded
(`bytes.fromhex(...).decode(...)`), so no build-prefix path can terminate a
Python literal — the bundle path (fixed 2026-11-05) and the conditional
`VSRES_VS_SITE_PACKAGES` path (this wave). The dev-only macro is still
excluded from portable builds; the CMake-side definition remains in the
preserved work-in-progress area and is called out for follow-up review.

## 5. Helper precedence — bundled code wins (Medium, posture)

Decision: **machine helper directories are fallbacks, never overrides.**

- Composed scripts (native `composer.cpp` and the draft emitter, kept
  byte-consistent) now APPEND the two `VapourSynth-OFX/vs-python` machine
  dirs instead of prepending them. A machine-dir module can satisfy a
  missing import but can never shadow the staged bundle's reviewed helpers
  or the interpreter's own resolution.
- Plugin autoload: an explicit `VAPOURSYNTH_EXTRA_PLUGIN_PATH` value is
  still honored when present — it is the user's machine and a deliberate
  power-user/test path — but it is never silent: whenever a staged bundle
  exists and the override displaces its `Contents/Plugins`, a loud warning
  names the running plugin path (`VSRES_ALLOW_PLUGIN_OVERRIDE=1`
  acknowledges it for repeatable local testing). Everything
  companion-spawned already receives the bundle path explicitly.
- Consequence to accept: a user who deliberately points the env var
  elsewhere gets THEIR plugins and a warning — not a silent mix.

## 6. Keyed provider over LAN HTTP (Medium, posture)

Decision: **keys never cross a LAN in plaintext without explicit
acceptance.**

- Loopback (`localhost`, `::1`, `127.*`) plaintext: always allowed (nothing
  leaves the machine; Ollama/LM Studio default setups keep working).
- Non-loopback plaintext (10.*, 192.168.*, 172.16-31.*, `*.local`):
  allowed when the provider carries NO API key (keyless local inference
  boxes are a legitimate use), refused at dispatch when a key IS configured,
  with the explicit acceptance escape `VSRES_ALLOW_INSECURE_LAN_KEY=1`.
- Public-host plaintext remains refused at set time and dispatch (2026-11-05).

## 7. MCP token opt-in (Medium, posture)

Decision: **default stays silent; the opt-in deliberately prints the full
registration command.**

- Unset (default): the log says the token is not logged.
- `VSRES_MCP_LOG_TOKEN=1`: prints the complete `claude mcp add …` command —
  today's only path to register an external MCP client — preceded by an
  explicit line stating the output carries a LIVE credential for THIS
  launch only. The token rotates every launch and the output is local
  stdout, so the accepted consequences are bounded and the operator action
  is explicit. A settings-UI surface that removes even this need remains
  planned, not built.

## Test anchors

- `tests/unit/test_private_io.cpp` — 5 filesystem contracts above.
- `tests/unit/test_chain_compose.cpp` — approval gate, binding parity,
  summarize consistency, source-path injection inertness (33 cases + the
  shared QTGMC fixture also consumed by the companion).
- `companion-app/electron/__test_ipc_script_safety.js` — sender policy
  before side effects (20).
- `__test_config_write_feedback.js` — untrusted/destroyed apply-config (30).
- `__test_audit_fixes_2026-11-05.js` — posture strings: LAN-key gate,
  appended-fallback preludes, token opt-in warning, private_io contract.
- Sweep (2026-11-11): 66 companion files / 797 tests, 0 failures under the
  documented per-test environments.
