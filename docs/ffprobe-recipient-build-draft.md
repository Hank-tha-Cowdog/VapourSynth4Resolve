# FFprobe recipient source and build instructions — draft for review

**Prepared 2026-11-02; actual reconstruction remains unexecuted and unvalidated.** This draft describes a standalone reconstruction route for the ffprobe helper in local candidate `4a866f39df0da44e0abdfd2c0658ce2aa881fd6e`. It is audit preparation, not distribution clearance, a build launch, or a product minimum-OS decision. The original two source-build allowances are consumed; any managed independent execution needs a separately admitted allowance and reviewed bounds.

The helper is separate from the Electron companion and OFX runtime. It is built from FFmpeg **9.0.2**, with static FFmpeg libraries, GPL/nonfree/version3/network/autodetection disabled. Its Mach-O declaration is arm64/macOS **13.0**. The whole companion still includes Python declaring **26.0**, while the app metadata declares **11.0**; this recipe changes none of those facts and does not qualify the product on macOS 13.

## Included inputs and original output

Within the candidate, the relocatable material root is:

`Contents/Resources/licenses/ffmpeg/`

It contains `manifest.json` and the following relative materials. Copy that complete directory into a new local working location before following any future approved reconstruction; the script accepts that relocated root through `--materials`. Reading or copying the materials does not require launching the app or helper.

| Path relative to the material root | Purpose |
| --- | --- |
| `manifest.json` | Original input/output/configuration identities |
| `materials/source/ffmpeg-9.0.2.tar.xz` | Complete retained upstream source archive |
| `materials/source/ffmpeg-9.0.2.tar.xz.asc` | Detached source signature |
| `materials/source/ffmpeg-devel.asc` | Public release key, not a private signing key |
| `materials/source/signature-verification.json` | Original verification receipt |
| `materials/source/ffmpeg-9.0.2/LICENSE.md` | FFmpeg license selection and additional notices |
| `materials/source/ffmpeg-9.0.2/COPYING.LGPLv2.1` | Retained LGPL-2.1 text |
| `materials/build-repair/invocation.json` | Original configure arguments/environment/runner identity |
| `materials/build-repair/result.json` | Original successful build result and output identity |
| `materials/build-repair/build/ffbuild/config.mak` | Actual generated feature/toolchain configuration |
| `materials/build-repair/build/ffbuild/config.log` | Actual configure probes and their output |

Pinned source archive SHA-256:
`8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e`

Pinned detached-signature SHA-256:
`d617fd94ea354dadd2a8bb16243d37c44e1e9729b06b6ad58fe30bfb0fa943f2`

Expected release-key fingerprint:
`FCF986EA15E6E293A5644F10B4322F04D67658D8`

The original helper is `Contents/Resources/runtime/ffmpeg/ffprobe`, SHA-256
`17aee5da628fcb009a3ee15a007abf77e9506c77b2c84318aff3ced6cd8db632`.
The material manifest SHA-256 is
`8612c766988e09b9a75328728131c430f766dc23e961eda5c683617a30c30c49`.
These identify existing bytes; identical output from a new toolchain is not promised.

## Prerequisites and scope of the draft

A future run needs a macOS Apple Silicon host; an already installed, explicitly selected full Xcode developer toolchain and macOS SDK; Apple command-line tools (`xcrun`, `make`, `ar`, `ranlib`, `file`, `otool`, `lipo`); **Python 3.8 or later with its standard-library lzma module**; and an already installed GnuPG for fresh signature verification. No dependency installation, package-manager operation, keyserver lookup, network fetch or private credential is part of this recipe.

The observed original compiler was **Apple clang 17.0.0 (clang-1700.0.13.3)**. The original helper load command records SDK **15.4.0**. The original invocation selected `/Applications/Xcode.app/Contents/Developer` and its `MacOSX.sdk` alias. A future selected SDK may differ: record its resolved path/version and all tool identities. This portable draft does not identify an exact Xcode release or prove that another SDK reproduces the original output.

Choose a new nonexistent output directory beneath an existing parent. The script creates it exclusively with mode 0700 and retains failures and all output; it never overwrites or cleans an existing directory. It copies and hashes the pinned manifest/source/signature/key before any signature or compiler command, uses only those copied inputs, and rejects archive links, traversal, duplicates and special files. The included archive has 10,525 members and 90,358,343 regular-file bytes; extraction is bounded to 12,000 members/128 MiB. Selected developer/compiler/SDK paths must contain no whitespace because of the compiler-flag format. Supporting those paths requires a separately reviewed change.

The canonical recipe is `scripts/rebuild_ffprobe.py` in a source checkout, or `recipient/rebuild_ffprobe.py` beneath a copied FFmpeg material root in the intended recipient layout. That script is the sole implementation of input verification, tool selection, extraction and command construction. It derives feature switches from the exact hash-pinned shipped manifest, replacing only compiler paths. It records its own hash, each command/cwd/exit status or dispatch error, selected environment, extraction facts and static output observations. Original configuration is retained in the included materials.

A future run executes configure probes and native compilation. This script is not a resource supervisor: managed execution still requires actual time/output/resource admission, stop handling and owned-process closure. The original build used at most two compiler workers and a 30-minute outer window; reusing those numbers is not a fresh admission. `--disable-network` controls FFmpeg features and does not confine configure/make at the OS level. Any required network denial belongs to the reviewed execution environment.

## Draft invocation — not executed for this review

The recipient must receive this document and `rebuild_ffprobe.py` as well as the source materials. The intended future package layout places both files in `Contents/Resources/licenses/ffmpeg/recipient/`, alongside the existing parent `manifest.json` and `materials/` tree. The original ten-material manifest remains byte-for-byte unchanged; these recipient instructions are separate files, so adding the recipe does not create a self-referential manifest hash. **The retained unsigned candidate predates this layout and contains neither instruction file. No new package has verified their inclusion, and no distribution qualification is claimed.** The command below is independent of the current directory: replace the script path with the selected source-checkout or copied recipient script and select local prerequisites explicitly:

```sh
python3 /absolute/path/to/rebuild_ffprobe.py \
  --materials /absolute/path/to/copied/ffmpeg-material-root \
  --output /absolute/path/to/new-nonexistent-output \
  --developer-dir /Applications/Xcode.app/Contents/Developer \
  --gpg /absolute/path/to/already-installed/gpg
```

Use a directly selected installed Python interpreter where uninitialized shims are present. GnuPG must be explicitly selected by absolute executable path; the script uses an empty private public-key store, `--no-options` and `--no-auto-key-retrieve`. No credential or installed signing key is involved. The selected developer directory is passed only to child environments and does not change the machine's developer selection. No production test-mode or tool-root override exists; synthetic tests mock subprocess dispatch from outside the implementation.

The recipe runs source `configure` and `/usr/bin/make -j2 ffprobe`, and never `make install`, the output helper, Electron or Resolve. The exact configure switches remain visible in the pinned material `manifest.json` and generated `config.mak`; there is no second embedded command recipe to drift from the runnable implementation. Static `file`/`lipo`/`otool` observations are retained for review, not scored as compatibility or security acceptance. A completed source build is reported only as `BUILD_COMPLETED_UNQUALIFIED`.

## Differences from the actual original invocation

| Aspect | Actual retained original evidence | Portable draft |
| --- | --- | --- |
| Build entry | Task-local `build_ffprobe.py` under a task-local network-denial profile; wrapper ran source `configure`, then `/usr/bin/make -j2 ffprobe` | Direct Python standard-library recipe invokes source configure/make; no private wrapper or profile prerequisite |
| Source/build paths | Extracted source and out-of-tree build beneath the author's private task directory | Verified copied archive extracted beneath the recipient's exclusively new output location |
| Compiler/SDK | Explicit Xcode-default clang path, clang17.0.0; helper load command SDK15.4.0 | Explicit selected developer directory and its discovered compiler/SDK; no system selection change; identities retained |
| Architecture/deployment | arm64; `MACOSX_DEPLOYMENT_TARGET=13.0`; arch/minimum-OS/isysroot flags for C/C++/Objective-C/assembly/linking | Same intent and explicit flags, with the recipient's selected SDK path |
| Feature selection | Original configure switches bound by manifest/config.mak | Feature switches loaded from hash-pinned manifest; compiler paths are the deliberate substitutions |
| Confinement/accounting | Historical managed network-denial, resource monitor and closure receipts | Not supplied or claimed by this recipe; prospective managed execution must provide its own admitted controls |
| Outcome | Existing helper SHA `17aee5da…`, two synthetic metadata probes retained | No execution or new output exists; hash/behavior equality remains unproved |

## Review needed before recipient publication or a compliance claim

1. Independently execute the reviewed recipe under a new bounded allowance and record failures honestly. Compare source extraction against the pinned archive; preserve any source patches, generated configuration, exact compiler/SDK/linker/make identities, logs and output. The draft itself is not reproduction evidence.
2. Inspect the rebuilt Mach-O for thin baseline arm64, declared minimum OS, system-only dynamic loads, and absence of unexpected rpaths/dyld environment commands. Original allowed dynamic loads were `/usr/lib/libSystem.B.dylib` and CoreFoundation/CoreVideo/CoreMedia system frameworks. Recheck generated feature configuration and enabled libraries against the exact selected source. Static FFmpeg libraries are expected; “fully static executable” is not the claim.
3. Under separately reviewed execution scope, use synthetic fixtures to compare the metadata contract and perform an independent source-modification/rebuild/relink demonstration appropriate to the selected distribution terms. A static-link license conclusion must come from the actual reviewed license/source/object/relink facts, not the presence of these commands. This draft supplies no legal interpretation or clearance.
4. Finish recipient-facing notice/source-route and exact compiled-component attribution, including FFmpeg's additional permissive/IJG-origin notices where applicable. Retain upstream license texts and headers. Resolve the separate companion/OFX/runtime/plugin rights; this helper recipe cannot clear them.
5. Review personal absolute paths in distributable logs/receipts and prepare an appropriate recipient index or redacted copy if needed. Preserve original proof unchanged; do not rewrite original evidence into a cleaner history. Any recipient package must actually include the reviewed instructions and materials rather than point to the author's private filesystem.

Original evidence travels with the chosen `--materials` root: `manifest.json`, `materials/build-repair/invocation.json`, `materials/build-repair/build/ffbuild/config.mak`, and the source/signature/license files listed above. In the intended packaged layout this document is in its `recipient/` subdirectory, so the material root is one directory above the document. Original proof is retained unchanged; no author-specific filesystem path or private build wrapper is a recipient prerequisite.

Preparation evidence: the earlier shell draft passed static review and shell syntax parsing, but was never reconstructed. This revision removes that duplicate shell implementation in favor of the canonical Python script and synthetic tests in `tests/test_rebuild_ffprobe.py`. Mock tests exercise orchestration and rejection paths with inert tiny fixtures and every subprocess replaced; they cannot establish GPG authenticity, compiler/SDK suitability, FFmpeg build success, helper behavior or license compliance. Actual reconstruction remains unexecuted and unvalidated.

Offline regression evidence for this revision: **20/20 synthetic tests passed** in 0.178 seconds (1.894-second outer invocation). All recipe subprocess dispatches were mocked. The approved `/usr/bin/python3` test launch emitted two Apple xcodebuild/DVT startup warnings and left a 1,087-byte `xcrun_db` in the owned temporary root; those original observations are preserved. There was no recipe GPG/compiler/make/helper dispatch. This evidence qualifies control flow with fixtures, not reconstruction or a clean host.
