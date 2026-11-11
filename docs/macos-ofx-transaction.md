# macOS OFX replacement adapter

`scripts/macos_ofx_transaction.py` implements the fixed replacement and inverse
sequence for `VapourSynth.ofx.bundle`. It is a library with **no install CLI**.
Importing it does not load libSystem, inspect the installed bundle, create files,
or contact Resolve. It is not wired into the application or ecosystem installer.

An installation caller must separately bind one operation ID, original deadline,
operator window, the exact staged two-file bundle and the current original (or
verified absence). `DarwinAdapter.open()` is the explicit live acquisition point.
Only an independently reviewed, admitted caller may use it. Binding data and gate
booleans are evidence contracts, not authorization.

The selected release platform is **macOS26.0 or later on arm64**. Every
admission response must now also contain an exact `host_platform` observation:
`schema=macos-product-platform-v1`, operation/window matching the fixed binding,
a conservative observation ID, `operating_system=macOS`, the observed macOS
`product_version`, `architecture=arm64`, and a lowercase SHA256 reference to the
bound observation evidence. The pure validator accepts one to three canonical
ASCII numeric ProductVersion components and compares their normalized tuple
with26.0.0. It does not compare version strings lexically or map Darwin kernel
release numbers to macOS product versions. Unknown/malformed versions, a prior
operation/window, another architecture or missing observation refuse before
backend construction, parent opens, bundle scanning or journal creation.

The first valid observation is copied into a frozen pin and retained in the
initial binding journal row. Every existing fresh-admission gate validates and
compares the entire observation again, including its raw version spelling,
observation ID and evidence reference. Drift stops the next native effect; an
already completed native move remains an actual effect and parks for explicit
recovery instead of being described as unchanged. A legitimate earlier intent
journal write is not undone by a later refusal.

These are supplied-evidence contracts, not OS authentication. A separately
reviewed installation caller must acquire actual, fresh semantic host metadata,
bind its source/provenance and evidence bytes, and keep the original operator
window/deadline. This module performs no OS version query, subprocess, machine
probe or automatic producer selection. A supplied digest does not authenticate
its origin. `platform_metadata_verified` remains a separate required preservation
and evidence gate; setting that boolean alone is insufficient for OS admission.
No actual26.0/Resolve or installer runtime qualification follows from the fake
port tests or the platform metadata declarations.

The caller must already have created an exclusively owned same-filesystem custody
root `/Library/OFX/.vsres-<operation>/`, with `stage`, `original`,
`failed-candidate`, and `backup` directories. Staging and faithful backup creation
are deliberately outside this module. The adapter compares the observed original
and independent backup subset before a move; full preservation still requires
external faithful-backup evidence. It never creates a partial backup silently.

The backend opens directory components relative to owned descriptors using
`O_NOFOLLOW`, validates directory owner/mode/device identities, and uses only the
fixed bundle leaf and four allowed moves. Each move calls the fixed libSystem
`renameatx_np` symbol with `RENAME_EXCL=4`. There is no ordinary rename, overwrite,
delete/copy fallback, privilege escalation, subprocess, or automatic retry.

The bundle scanner bounds entries, depth, total payload bytes, ACL bytes and xattr
bytes. Its pins include inode/device plus relative bodies, modes, owner/group,
file flags, nanosecond modification times, Python-float birth times, binary ACLs
and xattrs (including resource
forks). Symlinks, special files, hardlinked regular files and changing scans refuse.
`ctime` is excluded because rename can change it; `atime` is excluded because
reading bodies can change it. Birth times beyond Python-float precision and
access-time preservation are not established by these pins. The independent
backup/restore mechanism must retain any required native metadata beyond this
observed subset and account for access-time changes from verification reads.
Signature bytes inside the bundle are hashed; signature validity is not checked.
Unsupported metadata inspection refuses. A subset match alone never establishes
faithful platform metadata preservation or recovery.

The journal is an exclusively created, single-link private file. Each row is fully
written, `fsync`/`F_FULLFSYNC` acknowledged, read back and checked against the same
directory entry; the custody directory is also synced. Unsupported sync refuses.
An existing journal refuses the entire operation after restart: there is no
automatic crash recovery or replay. An interrupted or unacknowledged operation
needs a separate reviewed recovery, not deletion of the journal or a new attempt.

That restart barrier is the retained directory entry plus the actual exclusive
`O_CREAT|O_EXCL|O_NOFOLLOW` creation path, not a resettable in-memory consumed
flag. An empty, truncated, unreadable or foreign journal entry is not parsed as
permission to start over. A fresh adapter, new engine or newly supplied operator
window does not reopen the same journal namespace. This is a required filesystem
contract, not a power-loss guarantee from fake tests. If the journal/custody is
deleted or a genuinely new empty namespace is supplied, this library has no
global historical registry and does not authenticate the new operation as safe.
Distinct operation IDs can address the same fixed destination through different
custody roots; external exclusive-source custody remains required.

Forward and rollback reservations are operation-owned and consumed before effects.
An engine can reserve only its own adapter. Native moves must explicitly present
the exact engine holding that adapter's reservation, and that engine must still
point to this adapter. `FixedTransaction` supplies its own identity internally;
the low-level `move()` method refuses an absent, incomplete, foreign or rebound
engine before admission callbacks, intent writes or native effects. Prior invalid
direction/consumed-pair checks retain their refusal order. The engine identity is
a cooperative in-process API contract, not authority, authentication or isolation
against malicious Python that can inspect/alter private state.
Intent precedes the native call; gates, cancellation, parent custody and source/
target identity are checked again after intent retention. The exact native return
and errno are captured before other native calls and journaled before interpretation.
Unknown return, I/O error, lost ACK, post-move drift or ambiguous cleanup parks the
operation. First failures, native outcomes, journal failures and close errors remain
separate. Rollback requires fresh closed-host/window/backup/custody evidence and
is explicit. A missing candidate after verified installation is custody loss.

Parent descriptors and before/after identity checks do **not** provide a
source-inode compare-and-swap. External exclusive-source custody is required.
Two forward renames have an interruption gap. Sync acknowledgment is not a claim
of universal crash/power-loss durability on every filesystem or storage device.
Deadlines are cooperative around blocking OS calls, not hard kernel preemption.

`tests/unit/test_macos_ofx_transaction.py` exercises the successor engine, adapter,
native-call ABI boundary, journal writer, scanner and FD cleanup using fake ports.
It does not invoke libSystem, touch `/Library/OFX`, load OFX, query Resolve, or
replay the separately accepted 45-case inert suite. Passing these tests cannot
qualify real kernel support, backup creation, installation, host behavior,
credential safety, dependency licensing or public release.

Restart/ownership regressions preserve the original 56 method bodies. They drive
the real journal-creation and identity methods through a shared fake directory
namespace across distinct backend instances/descriptors, and separately model
fresh-adapter refusals with retained binding/native-ACK prefixes and rebound
custody. The operation/window variants in `fresh_from` deliberately share the
same retained fake custody/journal namespace; a distinct new empty custody root
is not represented by those cases. These tests distinguish per-instance reservation ownership from a
retained journal barrier; they establish neither real cross-process exclusion
nor durable storage. Previously completed effects and all unacknowledged bytes
remain preserved; no automatic inverse or recovery path is introduced.

Before a real installation: review exact source/caller bindings; qualify the
native and filesystem contracts through a separately selected operation; verify
faithful backup/custody and actual application/job closure; then release the
concrete replacement/rollback and quit/restart window. Resolve testing and public
release remain deferred until their separate gates are satisfied.
