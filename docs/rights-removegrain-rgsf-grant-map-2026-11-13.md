# RGSF / RemoveGrain — per-file grant map (2026-11-13)

Closes rights-map **Conflict 4** by executing option 1: "complete a
per-file/project grant map over the pinned source trees". Evidence is from
the pinned revisions themselves (raw file headers, fetched 2026-11-13).

## vapoursynth/vs-removegrain @ `89ca38a6971e` (2022-10-28)

| File | Grant found in file |
|---|---|
| `src/clense.cpp` | **MIT-style**: `Copyright(c) 2013 Victor Efimov` + full MIT grant text |
| `src/removegrainvs.cpp` | **WTFPL v2** ("Do What The Fuck You Want To Public License, Version 2") |
| `src/repairvs.cpp` | **WTFPL v2** |
| `src/shared.cpp` | **WTFPL v2** |
| `src/shared.h` | **WTFPL v2** |
| `src/verticalcleaner.cpp` | no individual header; includes `shared.h` (WTFPL v2); same-project, same-lineage code |
| `meson.build`, `msvc_project/*`, `docs/` | build/docs, no license claims asserted |

## IFeelBloated/RGSF @ `657d1e7fb2c4` (2016-01-25)

| File | Grant found in file |
|---|---|
| `Clense.cpp` | **MIT-style**: `Copyright(c) 2013 Victor Efimov` + full MIT grant text |
| `RemoveGrain.cpp` | **WTFPL v2** |
| `Repair.cpp` | **WTFPL v2** |
| `shared.h` | **WTFPL v2** |
| `VerticalCleaner.cpp` | no individual header; includes `shared.h` (WTFPL v2); same-project code |
| `RGVS.cpp` | no individual header; plugin registration file of the same project |
| `README.md`, third-party `VSHelper.h`/`VapourSynth.h` | header/readme; VapourSynth headers are the public SDK headers (LGPL project scope) |

## Conclusion (per FINAL §7.2/§7.3 principles)

- Both pinned trees are **project-wide permissively granted**: WTFPL v2 for
  the RemoveGrain/Repair/Clense/shared portions, MIT-style for the
  Clense-by-Victor-Efimov files.
- Files without individual headers are **same-project files** that either
  include the WTFPL `shared.h` directly or are trivial project glue —
  covered by the project grants; no "all rights reserved" or contradictory
  GPL text exists anywhere in either pinned tree (the earlier GPLv2 leads
  for these components are NOT supported at the pinned revisions).
- Practical consequence: `librgvs.dylib` and `librgsf.dylib` ship as
  **permissive (WTFPL/MIT)** with the notices carrying the per-file grants
  and the pinned revisions above. Conflict 4 is resolved by evidence, not
  by exclusion.
