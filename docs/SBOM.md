# SBOM — VapourSynth-for-Release candidate (frozen provisionally at 79197cf)

**DRAFT for counsel/owner review. Not legal clearance.** Provenance evidence recorded
per component; license statements where the actual license text was read locally are
marked [read]; unresolved questions are explicit and must not be assumed resolved.

## Distribution forms (what actually ships/installs)

| Form | Contents | Notes |
| --- | --- | --- |
| `VapourSynth Companion.app` (DMG, **current DMG is stale — NOT the candidate**) | Electron renderer/main (MIT, `companion-app/LICENSE` added this pass), Electron runtime + bundled npm deps, embedded OFX bundle below | Signing/notarization NOT done (B3) |
| Embedded `VapourSynth.ofx.bundle` (portable staging, `build-portable/portable`) | OFX binary (our GPLv3), `libvapoursynth.4.dylib`+`libvsscript.dylib` (`@loader_path`), embedded `Python.framework` (3.14.7), `vs-python` helpers | Load paths verified clean this pass (`otool`: `@loader_path`, no dev refs in LC_LOAD_DYLIB/RPATH of the OFX binary; see known-issues) |
| **User-path plugin install** (`scripts/install_vendored_plugins.py`) | 63 filter dylibs copied+repaired into `~/Library/Application Support/VapourSynth/Plugins` | **Part of the distributed product** (our script installs them); NOT inside the DMG payload |
| Runtime config | `~/.config/vapoursynth/vapoursynth.toml` entry written per install | Per-machine, not shipped |

## Component inventory (per-component license status)

### Our code
- Native OFX plugin + common (composer, filters): **GPLv3** [read: root `LICENSE`]. GPL/commercial-host question tracked as distribution gate 2 (see `notices-index.md`).
- Companion app (renderer+main): **MIT** [read: `companion-app/LICENSE`, added this pass materializing `package.json "license": "MIT"`]. Fork attribution: VapourSage (github.com/Hank-tha-Cowdog/vapoursage). **Q1 RESOLVED 2026-11-13**: the upstream repository now carries an explicit MIT `LICENSE` and a README grant note (upstream commits `8d0c4f9c`, `d80f3fdb`) — the companion's MIT declaration is backed by the upstream grant from the same copyright holder; see `docs/authorship-record-2026-11-13.md`. (Original finding, kept for history: [read: GitHub API, 2026-10-28] the upstream was PRIVATE with NO license file, which made the grant a genuine owner decision.)

### VapourSynth core runtime (bundled)
- `libvapoursynth.4.dylib`, `libvsscript.dylib`: **VapourSynth R82**, LGPL-2.1-or-later [read: `vendor/vapoursynth/src-R82/COPYING.LESSER`]. LGPL relocation/source obligations apply to redistribution of these dylibs.
- `vapoursynth` Python package + `.abi3.so`: LGPL, same source.
- zimg (inside resize): the PATCHED zimg inside resize2 still needs wrap/patch/packagefiles binding (Q2). The core zimg inside `libvapoursynth` = Homebrew zimg **3.0.6, statically linked** (upstream sekrit-twc/zimg `release-3.0.6`, commit `f819b14e…`; the in-tree `zimg.wrap` was not materialised — pinned 2026-11-12 anyway).

### Embedded CPython
- `Python.framework` 3.14.7: **PSF license**; the payload carries 90+ upstream license files [verified present in payload]; stdlib test `certdata` .pem fixtures are upstream public test data (noted, acceptable).

### Newly bundled runtime dependencies (2026-10-31 self-containment pass)

Staged into the portable OFX bundle for internal resolution. Redistribution
status per component; none downloaded (all from the build machine's
existing installs / vendor tree):

| Component | Source | License | Redistribution |
| --- | --- | --- | --- |
| libfftw3f.3 (FFW fftw) | /opt/homebrew/opt/fftw (brew) | GPL-2.0+ | OK with our GPLv3 (native); needs GPL notice + source offer in the DMG |
| libmpdec.4 (mpdecimal) | /opt/homebrew/opt/mpdecimal | BSD-2-Clause (licensing review §7.3 — corrects the earlier LGPL label) | OK; notice required |
| libssl.3 / libcrypto.3 (OpenSSL 3) | /opt/homebrew/opt/openssl@3 | Apache-2.0 | OK; NOTICE file required |
| libzstd.1 (Zstandard) | /opt/homebrew/opt/zstd | BSD-3-Clause | OK; notice required |
| liblzma.5 (xz/liblzma) | /opt/homebrew/opt/xz | 0BSD (liblzma) | OK |
| libsqlite3 (SQLite) | /opt/homebrew/opt/sqlite | Public Domain | OK |
| onnxruntime 1.23.2 (+ support dylibs) | vendor/Macos_vapoursynth_plugins/support | MIT (onnxruntime) — per-component verification pending | STAGED FOR TESTING; verify each support dylib before distribution |

### Corrections from the 2026-10-31 distribution audit (verified by direct repo reads; see docs/distribution-audit-2026-10-31.md)

- **vs-mlrt (vsort dylib + vsmlrt.py + adapter): GPL-3.0** — previously recorded
  as "MIT-class, verify"; the repo (AmusementClub/vs-mlrt) declares GPL-3.0.
  Compatible with our GPLv3 native code; the earlier MIT assumption is RETIRED.
- **fmtconv: WTFPL** (EleonoreMizo/fmtconv; GitHub archive → GitLab; binary tag r2).
- **vs-miscfilters-obsolete family — miscfilters, ttempsmooth (r2), zsmooth,
  temporalsoften2, bilateral: LGPL-2.1** (vapoursynth/vs-miscfilters-obsolete;
  two dylibs embed the repo URL in their binaries).
- **LSMASHSource (liblsmashsource.1, r9+): ISC source; BINARIES GPL-or-LGPL via
  the statically embedded FFmpeg/L-SMASH decoders** (avisynth.nl wiki + AUR
  evidence). Redistribution of the binary carries FFmpeg (L)GPL obligations —
  a source-offer requirement if GPL variants are embedded.
- **MVTools: GPL-2.0** (dubhater/vapoursynth-mvtools; current canonical
  dubhatervapoursynth/vapoursynth-mvtools).
- The per-plugin evidence table for all 63 collection dylibs (61 shipped) now
  lives in docs/distribution-audit-2026-10-31.md — roughly a third of the
  SHIPPED dylibs remain license-unresolved (four with NO license file found:
  dfttest2_gcc, dmetrics, eedi2, eedi3m, plus PickFrames' repo). Q3 remains a
  release blocker; the audit table is the concrete work-list for either a
  rebuild-from-source pass or counsel review.
| CPython 3.14.7 (Homebrew build) | /opt/homebrew/opt/python@3.14 | PSF-2.0 | OK; REQUIRES macOS 26 (minos) — see packaging.md decision item |
| pip 26.2.1 + wheel 0.47.0 (+ `vsres-vapoursynth.pth`) | embedded site-packages | MIT (bundled METADATA) | OK; add notice rows (new in the 2026-11-12 rights map); vendored-dep license files present under `dist-info/licenses/` |

### Filter plugins (63 dylibs; source github.com/yuygfgg/Macos_vapoursynth_plugins @ adb6840 [read: vendored .git])
- **Per-component licenses NOT inventoried** — the collection repo ships one root GPLv3 [read] and `tools/bundle.py` has **no license handling at all**. Upstream licenses for mvtools, fmtconv, nnedi3, tivtc, vivtc, BM3D(+Metal), KNLMeansCL, neo-f3kdb, CAS, lghost, WNNM, vs-nlm_ispc, misc, resize2, … **must be read per project at the exact bundled revisions** → unresolved Q3 (release blocker B2).
- **Provenance/audit concern (unresolved Q4):** the collection is a personal GitHub upload ("Add files via upload"); no per-binary build provenance, upstream-revision tags, or checksums against upstream releases. Redistributing these binaries as-is needs an owner decision.
- The vendored dylibs required an **rpath repair** (`@rpath/libc++.1.0.dylib` → `/usr/lib/libc++.1.dylib`) done at user install time by our script; at least one vendor dylib crashes the VS process when loaded (curated out). This is a binary-quality signal for the review.

### Python helper scripts (bundled in `vs-python`, also `~/…/VapourSynth-OFX/vs-python`)
- (2026-11-13 SUPERSEDED — see `docs/vs-helpers-revendor-2026-11-13.md`:
  `havsfunc.py` was re-vendored from the **Unlicense** upstream @`40009447073c`
  with one documented patch; `mvsfunc.py` / `nnedi3_resample.py` are no longer
  shipped; `vsutil` (MIT) added; `vsres_conv.py` is our own MIT replacement.)
- `havsfunc.py` (historical record): retained source/notice evidence identifies **function-local
  WTFPL comments**, not a whole-file license assignment. The historical
  2026-10-28 upstream API Unlicense declaration does not bind an exact upstream
  revision or grant to the bundled file. **Q5a remains open** for whole-file
  provenance, attribution and grant binding; no redistribution clearance follows
  from those comments or the API label. See the [source/notice follow-up](notice-source-followup-2026-11-02/README.md)
  and [component limits](local-notice-closure-2026-11-02.md#other-shipped-components-and-remaining-bindings).
- `mvsfunc.py`: **no license header in the bundled file** [read]. Upstream
  HomeOfVapourSynthEvolution/mvsfunc declares **no license at all**
  [read: GitHub API, license: null]. Default copyright = ALL RIGHTS RESERVED
  → **redistribution is NOT cleared**; needs owner decision (remove/rewrite
  the dependency, seek an upstream grant, or accept the risk profile).
  This upstream metadata does not close exact bundled-source or whole-file
  notice/grant correspondence; **Q5 is not narrowed to mvsfunc alone**.
- `adjust.py`, `nnedi3_resample.py`: no license headers [read]; upstream
  attribution absent — same all-rights-reserved concern as mvsfunc pending
  per-file upstream verification (adjust originates from VapourSynth core
  examples; nnedi3_resample from the mvsfunc author's collection).
- `vsmlrt.py` (user path, optional): upstream HomeOfVapourSynthBuilds —
  license unverified → remains open (not bundled in the DMG).

### Optional / not-bundled (SBOM lines so the reviewers know they are NOT in the payload)
- **FFmpeg CLI (`ffmpeg`)**: the dev machine build is GPL-v3/x264/x265 and is NEVER redistributed. The shipped encoder helper is a separate LGPL-only build from the same pinned official source as the ffprobe candidate (see the encoder candidate section below); the render queue prefers it over any system ffmpeg.
- **vs-mlrt + ONNX Runtime** (RIFE): optional, user-initiated download (sha256-verified from upstream releases). **vs-mlrt is GPL-3.0 (verified 2026-10-31; previously assumed MIT — corrected above); onnxruntime is MIT.** Model weights remain under unestablished upstream terms.
- **RIFE weights**: optional download; upstream model terms.
- Companion npm deps (Electron/React/CodeMirror/keytar/lucide/electron-builder): aggregated licenses in `node_modules`; **formal third-party notice assembly pending** → unresolved Q6. Electron itself aggregates Chromium + Node.js licensing obligations.

## Required notices / actions for release (status)
- [ ] Companion `LICENSE` — **done this pass** [read].
- [ ] Root GPLv3 — present [read].
- [ ] LGPL notice + source offer for bundled VapourSynth dylibs — **pending Q2 + counsel**.
- [ ] PSF notice for embedded Python — pending (payload carries upstream files; a top-level NOTICE should reference them).
- [ ] Per-plugin NOTICE from Q3 inventory — **pending (blocker)**.
- [ ] Third-party npm notice (Q6) — pending.
- [ ] Branding: must not imply VapourSynth-project endorsement; README naming review — pending owner read.

## Unresolved licensing questions — EVIDENCE vs DECISIONS separated (2026-10-28)

**Evidence gathered this pass (facts, not decisions):**
- E1. zimg: **WTFPL** [read: upstream COPYING, sekrit-twc/zimg, fetched
  shallow 2026-10-28 then discarded]. Redistributable. → Q2 RESOLVED.
- E2. Historical havsfunc upstream API declaration: **Unlicense**. This is
  not a whole-file grant/source binding for the bundled bytes; Q5a remains open.
- E3. mvsfunc upstream: **no license** [GitHub API license: null] → default
  copyright, redistribution NOT cleared; needs a decision.
- E4. VapourSage upstream (companion fork origin): **private repo, no
  license** [GitHub API]. Q1 is a genuine legal decision, not missing
  evidence.
- E5. The bundled yuygfgg plugin collection is a personal "Add files via
  upload" repo (single GPLv3 root, no per-dylib provenance, at least one
  crashing dylib) — evidence complete; the rebuild-vs-redistribute choice
  is an owner decision.

**Remaining OPEN questions:**
1. (LEGAL DECISION) Companion fork-of-private-unlicensed-VapourSage — grant,
   rewrite confirmation, or re-license. Owner + upstream author.
2. ~~zimg~~ RESOLVED (WTFPL).
3. Per-plugin upstream licenses for the 63 dylibs — EVIDENCE STILL MISSING:
   the collection does not map dylib→upstream repo; building that mapping
   (63 lookups against exact bundled revisions) is the next concrete
   research task if the owner does not choose rebuild-from-source.
4. (OWNER DECISION) yuygfgg collection: redistribute as-is vs rebuild.
5. (SOURCE / LEGAL BINDING) Whole-file helper provenance, attribution and
   grants remain open, including havsfunc; the exact helper hashes and current
   input correspondence do not establish historical upstream rights. The
   recorded mvsfunc/adjust/nnedi3_resample questions still require per-file
   evidence and the applicable owner/legal decision.
6. npm dependency notice assembly — mechanical, once a distribution form
   is chosen (B3).

## Known packaging issues (evidence for B3/B4)

- **Dev-machine site-packages injection:** /opt/homebrew/lib/python3.14/
  site-packages/vapoursynth-resolveofx.pth inserts the DEV VENDOR tree into
  every python3.14 process on this machine (and .zshrc exports PYTHONPATH=ToM).
  NOT part of the repo or any release payload; affects test fidelity on this
  machine (tests use -S / explicit precedence). The render script's staged
  insert(0) wins precedence — verified — but a clean machine is the only proof
  environment for "no dev fallback".
- The current DMG predates recent changes; not the candidate.
- `libvsscript.dylib` **LC_ID_DYLIB** (identity, not a load path) still names the dev-tree path; harmless to loading (dependents use `@loader_path`) but leaks the dev layout in the shipped binary → fix in the portable CMake target before release.
- Clean-machine dependency: filter plugins require the user-path install script; the bundle alone registers NO filter plugins (core std only). Clean-machine first-launch flow must run that script (see release-readiness B4).
- Signing: `notarize:false`; non-interactive `codesign` currently blocked (keychain partition-list step needs the owner's password — recorded in docs/packaging.md; NOT performed).

## November 1 ffprobe candidate — separate from the existing DMG

| Item | Candidate evidence |
| --- | --- |
| Component | ffprobe from official FFmpeg 9.0.2 source; separate process, not a new OFX build |
| Source | `https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz` with detached signature |
| Archive SHA-256 | `8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e` |
| Release-key fingerprint | `FCF986EA15E6E293A5644F10B4322F04D67658D8` |
| Helper SHA-256 | `17aee5da628fcb009a3ee15a007abf77e9506c77b2c84318aff3ced6cd8db632` |
| Build | arm64; static FFmpeg libraries; GPL/nonfree/version3/autodetection/network disabled; no external codec libraries |
| Measured helper minimum | macOS 13.0 load command; tested on the current Mac only |
| Dynamic loads | Apple CoreFoundation, CoreMedia, CoreVideo and libSystem only |
| Candidate Resources | `runtime/ffmpeg/ffprobe` and `licenses/ffmpeg/manifest.json` / `materials/` |
| Retained materials | Full source archive/signature/public key, signature-verification receipt, LICENSE.md, COPYING.LGPLv2.1, build invocation/result and actual config.mak/config.log |

The selected configuration uses FFmpeg's LGPL-2.1-or-later source combination,
with other included permissive notices retained in the complete source archive.
This describes the configuration, not a legal or redistribution decision.
The dev machine's GPL/x264/x265 variant is not copied into this candidate.
See [FFmpeg licensing](https://ffmpeg.org/legal.html) and the selected source's
`LICENSE.md` for configuration-dependent obligations. Source/relink/notice,
patent and final distribution review remain open; retaining the archive alone
does not close those gates.

The staged helper passed two tiny generated metadata probes (16×16 video at
24000/1001 fps; 48 kHz mono PCM audio). These do not qualify pixel-level scan
detection, the packaged app, all media formats, macOS 13 execution or a clean
Mac. The complete app's existing measured CPython floor of macOS 26 remains
unchanged and is not newly accepted as release policy. Existing installed,
staged, rollback and DMG identities and every other release gate are preserved.


## November 12 ffmpeg ENCODER candidate — render-queue runtime

| Item | Candidate evidence |
| --- | --- |
| Component | ffmpeg from official FFmpeg 9.0.2 source; **LGPL-only encoder build** (prores_ks + ffv1 encoders; mov + matroska muxers; avfilter/swscale enabled for format conversion) |
| Purpose | encodes the render queue's rawvideo pipe to ProRes 422 HQ / FFV1 masters; preferred over any system ffmpeg |
| Source | `https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz` with detached signature (same pinned archive as the ffprobe candidate) |
| Archive SHA-256 | `8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e` |
| Release-key fingerprint | `FCF986EA15E6E293A5644F10B4322F04D67658D8` |
| Helper SHA-256 | `ec562439dcc31a03374a08128d4633217d56d72de1da49c0e8790a991e464f2c` |
| Manifest SHA-256 | `9ba26e3b08835d50a16973302f3c7e6453bcc7c9d9882bfac7ce91118b9838e0` |
| Build | arm64; static; GPL/nonfree/version3/autodetection/network disabled (configure-verified: configure prints "License: LGPL version 2.1 or later"); no external codec libraries; ffprobe/ffplay disabled |
| Measured helper minimum | macOS 13.0 load command; exercised on the current Mac |
| Dynamic loads | Apple CoreFoundation, CoreMedia, CoreVideo and libSystem only |
| Candidate Resources | `runtime/ffmpeg/ffmpeg` and `licenses/ffmpeg-encoder/manifest.json` / `materials/` |
| Retained materials | Full source archive/signature/public key, signature-verification receipt, LICENSE.md, COPYING.LGPLv2.1, build invocation and actual config.mak/config.log |
| Recipient route | `licenses/ffmpeg-encoder/recipient/rebuild_ffmpeg_encoder.py` + `docs/ffmpeg-encoder-recipient-build-draft.md` |

Verification on 2026-11-12: the staged encoder produced a ProRes 422 HQ file
(1920×1080, 10-bit 4:2:2, 23.976 fps) from the live Resolve-session chain,
byte-identical in size to a reference render made with the dev machine's
Homebrew ffmpeg. As with the ffprobe candidate, this describes the
configuration; source/relink/notice, patent and final distribution review
remain open and retaining the archive alone does not close those gates. The
staging gate (`scripts/stage_ffmpeg_encoder.py`) fails closed on any
configure that carries the probe build's feature disables or relaxes the
license restrictions.
