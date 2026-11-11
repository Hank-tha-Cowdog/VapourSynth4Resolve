# Selected macOS release policy — 2026-11-02

The owner selected macOS26.0 or later on Apple Silicon (arm64) as the intended
release baseline. The former13-versus26 policy decision is closed. This is a
target requirement, not proof of qualified26.0 runtime support. Release remains
Not yet qualified until its independent engineering, rights, review and acceptance gates close.

The last preserved candidate was built from9ac4c2f. Its measured app declaration
is11.0, OFX declaration13.0 and embedded Python/native maximum26.0; it has not
been relabeled or rebuilt by this policy record. Saved metadata counted186 arm64
images,87 at26.0 and166 above13.0. Future source metadata must declare the26.0
product requirement and a fresh package must be inspected at its own exact hashes.

Lower component minima remain valid component facts under a26.0 product gate:
Electron/keytar11, ffprobe13 and direct VS/VSScript16 do not need header rewrites
or artificial26.0 labels. Preserve the accepted feature/plugin/PAL payload and
source/notice obligations. No compatible-down-to13 rebuild or feature reduction
is selected. The isolated min16 no-sign VSPipe specimen remains an engineering
variant; its frozen recipe and synthetic evidence do not choose product policy.

Release configuration is arm64 and product metadata26.0. Future project-owned
OFX builds should explicitly configure `CMAKE_OSX_DEPLOYMENT_TARGET=26.0` and
`CMAKE_OSX_ARCHITECTURES=arm64` in a new isolated build. The source default is26.0,
but explicit lower component/engineering overrides remain distinct from the
release configuration; existing caches and copied third-party binaries do not
change when this default changes. Bind and inspect actual compiler/SDK/output
metadata instead of assuming defaults prove support.

Future installer/caller admission must bind actual macOS semantic version26.0+
and arm64 observations, refusing old, unknown or wrong-architecture hosts before
any mutation or runtime launch. A plist key is not proof that Resolve or every
installer path enforces it. The existing transaction module supplies primitives,
not a shipped installer or completed OS preflight. Do not equate a raw Darwin
kernel version with the product OS version without a reviewed observation adapter.

Qualification must use exact current artifacts on the selected OS26.x/Resolve
matrix, including baseline26.0 rather than inferring it from an SDK26.5 build.
Preserve accepted PAL behavior; add current import/autoload/filter/source, UI,
NTSC/export/owner and install/upgrade/recovery/uninstall evidence as separately
required. Clean-Mac, formal security/correctness, provenance/notices/rights,
portability, containment, version/saved-project, signing/notarization and release
gates stay open. No support certification follows from selecting this baseline.

Older dated packets and status rows saying the floor is undecided or26 is only
a recommendation remain historical. This current policy supersedes that decision
status, not their observed component minima, artifact hashes or test attribution.
Actual protected identity/Q/native work still needs its admitted execution guards.
Selecting the floor does not change the saved profile denial, authorize its
omission, install/swap a plugin, sign/publish or permit a new source disclosure.
