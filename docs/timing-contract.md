# Timing contract — v2 (canonical, measured)

Established Oct 27 from live evidence + exact measurements on the active
source (1440×1080 PAR 4:3, 25/1 fps TFF, 1464 frames = 58.56 s). Rational
arithmetic (`fractions.Fraction`) everywhere; never rounded display labels.

## Pipeline stages (disk path — source mode)

| Stage | Frames | fps tag | Duration | Content |
| --- | --- | --- | --- | --- |
| Disk source (`core.lsmas`) | 1464 | 25/1 | 58.56 s | original fields |
| QTGMC `FPSDivisor=2` | 1464 | 25/1 | **58.56 s** | bobs to 2928@50 then decimates; **frame k = deinterlace of source frame k**; duration preserved by construction |
| `mv.BlockFPS(num=50, den=1)` | 2927 | 50/1 | 58.54 s | 2× interpolated; script frame 2k ≈ source moment k |

**Rule: no manual rate correction after QTGMC.** QTGMC's own decimation is
complete and rate-correct. An `AssumeFPS(fpsden*2)` added on top doubled the
duration (117.12 s) and desynchronized A/B (reverted — see git history).

## The two input paths are different stages, not contradictions

- **Disk path**: native source properties (1440×1080, SAR 4:3 → displays
  1920×1080; 25 fps TFF interlaced). Read directly by the composed script.
- **Resolve host input** (clip-mode / fallback): 1920×1080 square-pixel —
  the TIMELINE-CONFORMED stage, after Resolve's own input transform.
  Resolve's host flags describe THIS stage, never the disk pixels.

## Presentation-time mapping (preview + native)

- **Preview transport**: drives by presentation time t (seconds). Each mode
  resolves `frame = (t · fpsNum) // fpsDen` using its OWN evaluated clip's
  rational fps. A/B compares the same content moment; mode switching never
  moves the logical playhead, zoom, pan or framing. Late replies are dropped
  by request sequence; cache is keyed by (nodeGuid, source path, chain
  identity, mode, time).
- **Native path** (OFX): Resolve requests OUTPUT-frame coordinates
  (`args.time − range.min`), NOT seconds and NOT source frames. For
  same-rate output (current chain: 25/25) this equals the script frame index
  and is correct as implemented.

## Host rate contract (declared and ENFORCED since 2026-11-11)

Resolve requests OUTPUT-frame coordinates; the plugin rounds them to the
intended frame (`llround`, then clamps to the clip's own length — the
end-of-clip slot holds the last frame instead of erroring to passthrough).

The timeline path maps output-frame coordinates 1:1 onto script frames.
That is honest ONLY when the chain's OUTPUT cadence equals the timeline's:

- **Supported (same rate):** the accepted PAL baseline (25/25), all
  fractional NTSC rates compared against Resolve's rounded host values
  (30000/1001 vs 29.97, 24000/1001 vs 23.976, 60000/1001 vs 59.94),
  same-duration decimated deinterlace (QTGMC FPSDivisor=2: 25 in → 25 out),
  and bob/interpolation chains when the timeline (or render output) rate
  MATCHES the chain's output rate (e.g. 50 fps chain on a 50 fps timeline).
- **Refused (mismatched rate):** a rate-CHANGING chain on a different
  timeline rate (bob 2× on 25, IVTC 24000/1001 on 30000/1001, further
  decimation to 12.5). The host writes a `chain-rate-mismatch` status naming
  both rates with the exact fix (set the timeline/output rate, or change the
  chain) and renders the passthrough frame. It never silently retimes the
  timeline, clamps or duplicates frames to fake synchrony, or plays content
  at the wrong speed.

The tolerance (0.005 fps) sits below the smallest gap between standard
rates (24 vs 23.976 = 0.024) and far above fractional-rate float noise
(~3e-5). Arithmetic is unit-tested
(common/chain/rate_contract.h, `tests/unit/test_chain_compose.cpp`).

## Distinct cadence cases (kept distinct)

1. **Progressive passthrough** — no field ops; identity or spatial steps only.
2. **True interlaced video, same-rate deinterlace** — QTGMC `FPSDivisor=2`
   (current default): single-rate progressive, duration preserved.
3. **Field-rate bob** — QTGMC `FPSDivisor=1`: 2928@50 (double-rate), for
   motion smoothness; timeline must run 50 fps to consume it correctly.
4. **Interpolation** — `mv.BlockFPS`/RIFE `multi`: retime to a target rate;
   requires matching timeline/output rate as above.
5. **Telecined film** — `tivtc` TFM+TDecimate (IVTC): recovers the 23.976
   film cadence; NOT "drop one in five" and NOT QTGMC decimation. Determine
   cadence first; mixed/broken cadence needs per-shot handling.

Relabeling fps ≠ duplicate removal ≠ slow motion; each is a distinct user
choice. The plugin never changes the Resolve timeline implicitly.

## Verified Oct 27 ([H], real source through the real runtime)

- QTGMC/2 duration preservation; frame correspondence (src100 = qtgmc100 =
  50p200 @ 4.00 s); BlockFPS duration.
- Combing resolved at pixel level: field-phase signature d1/d2 raw 2.03
  (combed) → post-QTGMC 0.54 (progressive); residual vertical ≈1.4 is
  same-field picture DETAIL (d2=2.63 > d1=1.42), preset-independent
  (Ultra Fast/Fast/Slow ≈ equal). A vertical-energy metric alone would have
  mislabeled this; the field-phase signature distinguishes combing from
  detail.
- NOT yet live-verified: the reverted composer inside Resolve (bundle swap
  staged), A/B gestures in the launched companion at matched moments.

## Window rule — source windows apply to the chain OUTPUT (2026-11-12)

`ActiveTrimmed` composes the clip's source window (`sourceInPoint..sourceOutPoint`)
AFTER the chain for rate-preserving chains: the chain runs on the FULL source
(`src_window` is a sibling variable used only by the mix stage), so temporal
filters — QTGMC above all — keep real source context at the clip's head/tail
instead of deinterlacing from a hard cut. Frame mapping is unchanged: for a
rate-preserving chain, output frame k still equals source frame `in+k`.

Rate-changing steps keep the legacy order (window on the INPUT): the recorded
source coordinates only map 1:1 onto output frames at a preserved cadence.
Detection mirrors the native `rate_preserving_chain` (and its TypeScript
mirror in `draft-composer.ts`): `qtgmc` with `fpsDivisor == 1` is
rate-changing; a `script` step whose code references BlockFPS/AssumeFPS/
ChangeFPS/ConvertFPS/InterFrame/FlowFPS/FrameRate/Interpolate/RIFE is treated
as rate-changing by conservative substring (the same convention
`current_radius` uses).

Both composers emit the rule (native `compose_script` + draft composer), with
native coverage in `tests/unit/test_chain_compose.cpp`
(`active_trimmed_emits_trim`, `active_trimmed_rate_changing_keeps_trim_first`).

Empirical check (2026-11-12, moving 60-frame source, window 12..35, a
deterministic temporal filter): trim-first output differs from window-after
output ONLY at the window edges (first 3 and last 3 frames; RMSE up to ~0.05)
and is bit-identical for every interior frame — the rule restores real source
context at the clip's head/tail and changes nothing where context was already
complete.
