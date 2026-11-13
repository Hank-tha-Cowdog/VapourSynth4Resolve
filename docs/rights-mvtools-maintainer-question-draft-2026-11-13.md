# mvtools — maintainer question draft (2026-11-13)

Rights-map Conflict 1, option 2 ("ask the maintainer a narrow question").
Post as a GitHub issue at the recorded upstream (mvtools — the
HomeOfVapourSynthEvolution/mvtools repository). Keep it short and answerable.

---

**Title:** Question about the version wording in `MVFlow.cpp` / `MVFinest.c`
vs `meson.build`

Hi — I'm packaging mvtools in a macOS video-processing tool and recording
component notices carefully. Two source files, `MVFlow.cpp` and
`MVFinest.c`, carry GPL **version 2** notices, while the project's
`meson.build` metadata declares **GPL-2.0-or-later**. Could you clarify which
wording is authoritative for the project as a whole — i.e., are those two
files v2-only, or does the project intend or-later across the tree?

If it helps: I don't need a formal legal opinion, just a maintainer
statement of intent I can record alongside the notices. Thanks!

---

**Posting checklist (owner):**
- [ ] Confirm the exact repo the pinned source came from (recorded upstream).
- [ ] Open the issue, paste the text above.
- [ ] Record the response (or absence after a reasonable window) in
      `docs/rights-map-2026-11-12.md` Conflict 1.
- Until a response: the recorded file-notice authority (GPL v2 for those two
  files) stands in the notices — that is option 1 and remains valid.
