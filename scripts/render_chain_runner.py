#!/usr/bin/env python3
"""Render a composed VapourSynth chain script to stdout as RAW frames.

Companion render-queue backend (beta-batch, 2026-11-12). Provenance is the
point: this evaluates the node's COMPOSED script — the plugin's canonical
output — and pipes its frames exactly as the chain produced them (no
recompose, no regeneration). Works for ANY output format (RGB/YUV/Gray, any
bit depth, alpha) because it uses the vapoursynth module's native
VideoNode.output() writer instead of the vspipe CLI's y4m container.

Modes:
  --info   print ONE JSON object to stdout describing the clip and exit:
           {"width":…,"height":…,"frames":…,"fps_num":…,"fps_den":…,
            "pix_fmt":"…","format":"RGBS","matrix":N|null,"transfer":N|null,
            "primaries":N|null,"range":N|null}
           (matrix/transfer/primaries/range are H.273 codes read from the
           first frame's properties; null when absent.)
  render   write raw frames to stdout; progress lines "Frame: n/total (p%)"
           on stderr (throttled). Exits non-zero with a stderr explanation
           on any failure.

Read-only with respect to the script: the script file is executed, never
modified.
"""
import argparse
import json
import sys
import time
import traceback
import runpy


def ff_pixfmt(fmt):
    """Map a VapourSynth Format to the ffmpeg rawvideo pix_fmt name."""
    import vapoursynth as vs
    bits = fmt.bits_per_sample
    alpha = fmt.num_planes == 4
    if fmt.color_family == vs.GRAY:
        if alpha:
            raise ValueError("alpha Gray formats have no ffmpeg rawvideo mapping")
        return {8: "gray", 16: "gray16le", 32: "grayf32le"}.get(bits) or f"gray{bits}le"
    if fmt.color_family == vs.YUV:
        sub = {(1, 1): "420", (1, 0): "422", (0, 0): "444",
               (2, 2): "410", (2, 0): "411", (0, 1): "440"}[(fmt.subsampling_w, fmt.subsampling_h)]
        # ffmpeg's planar YUV names carry the trailing 'p' ("yuv420p",
        # "yuv420p10le") — "yuv420" is NOT a valid ffmpeg pix_fmt (A/B
        # caught this on the first YUV-output render).
        base = ("yuva" if alpha else "yuv") + sub + "p"
        if bits == 8:
            return base
        return f"{base}{bits}le"
    if fmt.color_family == vs.RGB:
        base = "gbrap" if alpha else "gbrp"
        if fmt.sample_type == vs.INTEGER:
            return base if bits == 8 else f"{base}{bits}le"
        return f"{base}f{bits}le"   # gbrpf32le / gbrpf16le
    raise ValueError(f"unsupported color family for pix_fmt mapping: {fmt.name}")


def load_clip(script_path):
    import vapoursynth as vs
    namespace = runpy.run_path(script_path)
    try:
        out = vs.get_output(0)
    except Exception:
        raise RuntimeError("the composed script exposed no output clip")
    # R49+: get_output returns VideoOutputTuple (clip, alpha, alt_output);
    # older module versions return the clip directly.
    clip = out[0] if isinstance(out, tuple) else out
    alpha = out[1] if isinstance(out, tuple) and len(out) > 1 else None
    if alpha is not None:
        sys.stderr.write("Note: the output declares an alpha channel; the render uses the main clip only.\n")
    return clip, namespace


def first_frame_props(clip):
    """H.273 codes from frame 0 (None when absent)."""
    out = {}
    try:
        props = clip.get_frame(0).props
    except Exception:
        return out
    named = (("_Matrix", "matrix"), ("_Transfer", "transfer"), ("_Primaries", "primaries"))
    for key, tag in named:
        value = props.get(key) if hasattr(props, "get") else None
        out[tag] = int(value) if isinstance(value, int) and not isinstance(value, bool) else None
    # _Range (newer cores) with _ColorRange fallback (R75-R79); read directly to
    # avoid the deprecation shim's warning noise.
    value = None
    if hasattr(props, "get"):
        value = props.get("_Range")
        if value is None:
            try: value = props["_ColorRange"]
            except Exception: value = None
    out["range"] = int(value) if isinstance(value, int) and not isinstance(value, bool) else None
    return out


def main():
    ap = argparse.ArgumentParser(prog="render_chain_runner")
    ap.add_argument("script")
    ap.add_argument("--info", action="store_true")
    ap.add_argument("--start", type=int, default=None)
    ap.add_argument("--end", type=int, default=None)
    args = ap.parse_args()

    try:
        clip, _namespace = load_clip(args.script)
        if args.start is not None or args.end is not None:
            start = args.start or 0
            end = args.end if args.end is not None else clip.num_frames
            if start < 0 or end <= start:
                raise RuntimeError(f"invalid frame range {start}:{end} (clip has {clip.num_frames})")
            clip = clip[start:end]

        if args.info:
            info = {
                "width": clip.width, "height": clip.height,
                "frames": clip.num_frames,
                "fps_num": clip.fps.numerator, "fps_den": clip.fps.denominator,
                "pix_fmt": ff_pixfmt(clip.format), "format": clip.format.name,
            }
            info.update(first_frame_props(clip))
            sys.stdout.write(json.dumps(info) + "\n")
            sys.stdout.flush()
            return 0

        total = clip.num_frames
        state = {"last": 0.0}

        def progress(done, count):
            now = time.monotonic()
            if done != 0 and done != count and now - state["last"] < 0.2:
                return
            state["last"] = now
            pct = 100.0 * done / count if count else 100.0
            sys.stderr.write(f"Frame: {done}/{count} ({pct:.1f}%)\n")
            sys.stderr.flush()

        clip.output(sys.stdout.buffer, progress_update=progress)
        return 0
    except Exception as exc:
        sys.stderr.write("Render failed: " + str(exc) + "\n")
        traceback.print_exc(file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
