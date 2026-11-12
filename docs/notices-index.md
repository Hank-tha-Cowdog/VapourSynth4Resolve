# Notices index — source export (Route A groundwork, 2026-11-11)

**Status: work in progress — the rights-map review continues.** This index is the
release-facing starting point, built from the licensing review, the draft
[SBOM](SBOM.md) and the component inventory. It is NOT legal clearance and NOT a
complete kit; rows marked **OPEN** are tracked for the next distribution gate.

## Scope split (the two different obligations)

| Artifact | What ships | Notice/source duty |
| --- | --- | --- |
| **Source export** (this tooling: `scripts/release/export_source.py`) | Allowlisted PROJECT source only; third-party source only under component terms when opted in | Preserve per-component license texts + authorship + change statements; state what is NOT included |
| **Signed DMG** (later gate) | Companion app + OFX bundle + curated plugin dylibs + embedded Python | Full per-component notices + exact-source correspondence for redistributed binaries (LGPL/GPL duties, license file inclusion, source offer) |

## Project code (in the source export)

| Component | License | Status |
| --- | --- | --- |
| Root native plugin + common/ (OFX, composer, filters) | GPLv3 (root `LICENSE`, preserved from original Windows GPLv3 material) | OK for source export; GPL/Resolve-host compatibility question documented in the notice rows below |
| `companion-app/` | MIT (`companion-app/LICENSE`) | **OPEN**: upstream lineage grant question — see SBOM Q1. Root GPLv3 must not erase this scoped MIT declaration |
| `platform/windows/` | Original GPLv3 project material | Preserve authorship/notices as-is |

## Third-party source actually present in the export

| Component | Location in export | License | Notes |
| --- | --- | --- | --- |
| OpenFX 1.5.1 SDK (headers + support libs) | `docs/ofx-sdk/openfx-1.5.1/` | BSD-3-Clause (root + Support licenses in-tree) | Preserve BOTH applicable notices + any differing file-level notices — do not collapse to "OpenFX is open source" |

## Third-party components NOT included in the source export (binary/embedded — DMG gate)

| Component | License (established) | Duty |
| --- | --- | --- |
| VapourSynth R82 core/VSScript + Python package (bundled in OFX bundle) | LGPL-2.1-or-later [read] | Exact source + changes; §6 linking route; notices. **OPEN**: exact shipped-build correspondence |
| Embedded CPython 3.14.7 | PSF (+ 90 upstream license files in payload) | Keep upstream license files in the payload |
| zimg (inside VapourSynth; separate patched zimg in resize2) | permissive/WTFPL evidence; **hold separate identities** | **OPEN**: bind each included source/config + notices |
| onnxruntime 1.23.2 (+ support dylibs) | MIT core + version-specific third-party notices | **OPEN**: bind origin/build; per-dylib verification before distribution |
| FFmpeg/ffprobe (recipient kit route) | GPL (ffprobe) | Recipient-build kit documented separately (`docs/ffprobe-recipient-build-draft.md`); **OPEN**: final terms per owner |
| Curated VS plugin dylibs (63 staged for install) | per-component — see SBOM + review §"component inventory" | **OPEN (rights map)**: several GPLv2-vs-GPLv3 conflicts (mvtools file notices; FFT3DFilter wording; sangnom dual statements; RGSF/RemoveGrain scope; havsfunc.py whole-file provenance). Distribution-gated — do not ship unqualified copies |
| libgsl.28 | GPL GSL | Pruning candidate — prove unnecessary in final closure or supply source+notices |
| Boost (filesystem/atomic), libc++ | Boost / LLVM | Bind versions/notices for included copies; prefer system libc++ where valid |

## Source export defaults (what `export_source.py` does)

- Allowlist: `common/ platform/ scripts/ tests/ docs/ companion-app/` + root
  files; `vendor/` fully EXCLUDED by default (third-party source inclusion is
  a rights-map decision — `--include-vendor-source PATH` opts in per path).
- Hard exclusions regardless of allowlist: `.git` (no history — a fresh clean
  tree is a different distribution from pushing the repo history), build
  outputs, app/DMG trees, node_modules, model packs, binaries/media by
  extension, large non-text files (reported).
- Docs curation: client-branded material, legal drafts/counsel packages,
  dated internal batch records and review-process records are EXCLUDED by default
  (`--docs-include-all` overrides; hard exclusions still apply).
- Output: tree + `MANIFEST.sha256` (verifies with `shasum -a 256 -c`) +
  `EXPORT-INFO.txt` scope statement.

## Open release-scope decisions

1. Third-party source in the export: none / per-component opts / the full
   curated set once the rights map is settled.
2. Companion-app lineage (SBOM Q1) — grant, independent-authorship claim, or
   re-license.
3. Plugin-set rights map (which dylibs may be redistributed in the DMG).
4. Binary DMG notice kit: which components ship, who authors the notices.
