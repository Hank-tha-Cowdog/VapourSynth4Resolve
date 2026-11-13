# First-party VapourSynth helper modules

- `vsres_conv.py` — MIT, original work. The conversion layer (`ToYUV`,
  `ToRGB`, `Depth`) that replaces the mvsfunc dependency in every composed
  script. The portable-bundle staging copies it into
  `Contents/Resources/vs-python`; composed preambles import it as
  `vsres_conv as mvf` (alias kept for call-site stability).

Third-party helpers live in `vendor/vs-helpers/` (excluded from the public
source export by policy): havsfunc.py (Unlicense, pinned — see
`vendor/vs-helpers/PATCHES.md`), vsutil (MIT, pinned), adjust.py (WTFPL).
