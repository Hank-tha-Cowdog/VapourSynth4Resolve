# Color management — capability investigation (2026-10-29)

The owner asked for a CST filter with reliable AUTOMATIC input identification.
Investigation first, as instructed; no API was invented.

## What we can actually know (verified)

| Question | Answer | Evidence |
| --- | --- | --- |
| Color representation of pixels ENTERING our Resolve node (via OFX)? | **NOT EXPOSED.** The OFX standard hands the plugin raw frame data + geometry; there is no colorspace/gamma/transfer property on clip or image fetch. | OFX API surface used in platform/macos/host/plugin_entry.cpp (clipFetchImage/param machinery; nothing color-related exists to call) |
| Timeline/project color settings? | Readable ONLY via the Resolve scripting API (resolve-query.py channel) when Resolve runs with scripting enabled — a separate, optional channel. Project settings do NOT describe any node's input: upstream CST/color nodes change it independently. | electron/resolve-api.js + electron/resolve-query.py (used today for clip discovery) |
| The immediately-preceding node's output transform? | **NOT inspectable** — no API exposes another node's CST settings to us. | (absence in both API surfaces above) |
| The original media file's color (companion Source mode)? | KNOWN WITH PROVENANCE: VapourSynth's source loader tags frames (`_Matrix` etc.) from the container/codec — but that describes the FILE, not the image entering the Resolve node (upstream nodes/sizing may have altered it). | render_preview_frame.py source-mode path reads these props (SAR handling uses the same mechanism) |

## Conclusion for AUTO input identification

There is NO trustworthy, general way to identify the color of the image
entering our node. Any "Auto" that guesses from project settings, file tags,
or image appearance would be false certainty. Per the owner's instruction,
Auto is therefore NOT implemented; the design is:

1. **Manual controls** (the honest fallback): an explicit input
   primaries+transfer selection, converting into the working space, with
   the selection VISIBLE in the UI and saved with the chain.
2. **Unknown is shown as Unknown** — no silent default presented as fact.
3. When the Resolve scripting channel is available, project settings may be
   shown as a HINT (labeled as such), never as the node input's definition.

## CST — IMPLEMENTED (2026-10-29, commit of this batch)

The manual CST is a STRUCTURED SCRIPT STEP (schemaType 'cst'): both the
companion preview and the native composer execute the SAME emitted Python
body (ScriptFilter emits params.code verbatim; the draft composer emits the
same string) — preview/final parity is BY CONSTRUCTION, single source
(companion-app/shared/cst-transform.ts).

Controls (all explicit; no auto): input/output GAMUT (Rec.709/sRGB,
Rec.2020, DCI-P3 D65, SMPTE-C — D65 whites, so NO chromatic adaptation is
needed and none is silently applied), input/output TRANSFER (linear,
BT.1886 2.4 power LB=0 per ITU, BT.709 camera OETF, sRGB, PQ ST.2084
normalized 0–1, HLG STD-B67), input YUV matrix + range (auto = VS frame
props), output matrix (EXPLICIT or keep-RGB — 'auto' rejected), output
range + subsampling (420/422/444).

Math facts (verified against the staged VapourSynth R75):
- VS R75 resize has NO transfer_s/transfer_in_s — transfers are std.Expr
  RPN per plane (constants from the ITU/IEC/SMPTE/ARIB specs).
- std.Expr on a single clip cannot mix planes (x=y=z=own plane) — gamut
  3×3 goes through std.ShufflePlanes splits/recombine (verified pattern).
- Gamut pair table = DATA, generated from primaries→XYZ math CHECKED
  against the PUBLISHED BT.709/sRGB and BT.2020 RGB→XYZ matrices (max err
  0 / 4.2e-5); fixture tests/fixtures/cst_gamut_pairs.json is the single
  source; __test_cst_transform.js cross-checks the embedded table against
  the fixture AND against an INDEPENDENT XYZ-path recomputation through
  the real staged python runtime.
- Out-of-range policy: 'clamp' (default — transfer curves are undefined
  outside [0,1]; excursions would be lost) or 'pass' (advanced, opt-in,
  labeled with its misbehavior). Never silent.
- Identity stages skipped + labeled (same gamut → no matrix; same
  transfer → no curves). Unsupported values REJECTED at emit with the
  supported list — never silently Rec.709.
- Float32 (RGBS) throughout; duration/FPS/dims unchanged (tested).
- Alpha: chain working formats carry no alpha (pre-existing composer
  behavior, unchanged).

## CST implementation plan (superseded by the implementation above)

- A CST filter built on the existing conversion facilities (composer
  to_rgb/to_yuv + std.Expr), separating: input primaries (gamut) → 3×3
  matrix to the working gamut; transfer decode (linearize) and re-encode;
   explicit range (legal/full) and RGB/YUV matrix; chromatic adaptation
  (Bradford) where primaries differ. Float precision preserved (no 8-bit
  intermediate), applied identically in preview and final processing.
- The filter catalog is feature-frozen for release hardening; the CST
  enters as the one owner-requested addition, qualified through the same
  real-runtime pipeline as every other filter.
