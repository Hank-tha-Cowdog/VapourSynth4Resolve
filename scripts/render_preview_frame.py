#!/usr/bin/env python3
"""Render one frame of the HOST'S composed chain script to a PNG.

Companion preview backend. Provenance is the point: this evaluates
~/Library/Application Support/VapourSynth-OFX/last-composed.vpy — the exact
script the OFX plugin's render_chain composes and evaluates on every render
— so a preview here IS the processing path, not a parallel re-implementation
that can drift.

Modes (--mode):
  processed  render the script's OUTPUT node (the chain result)   [default]
  source     render the script's `src` variable (the identified
             media, before any chain step) for before/after compare

The frame is converted to RGB24 and written via the bundled fpng plugin.
Exit 0 + {"ok": true, "frame": n, "width": w, "height": h} on success;
non-zero with {"ok": false, "error": "..."} on failure. Never prints the
frame itself; the caller reads the PNG path.
"""
import argparse
import json
import os
import stat
import sys
from fractions import Fraction

DEFAULT_MAX_PNG_BYTES = 128 * 1024 * 1024
_PNG_UNSET = object()


class PreviewPNGTooLarge(ValueError):
    pass


def _png_budget(value=_PNG_UNSET):
    if value is _PNG_UNSET:
        configured = os.environ.get("VSRES_PREVIEW_MAX_PNG_BYTES")
        if configured is None:
            value = DEFAULT_MAX_PNG_BYTES
        elif configured.isascii() and configured.isdigit():
            value = int(configured)
        else:
            raise ValueError("VSRES_PREVIEW_MAX_PNG_BYTES must be a positive integer")
    if type(value) is not int or value <= 0:
        raise ValueError("maxPngBytes must be a positive integer; it is never clamped")
    return value


def _frame_at_time(time_seconds, fps_num, fps_den, total):
    """Presentation time → frame index, exact at frame boundaries.

    C10 (2026-11-11): float multiplication loses the last ulp — frame 29's
    exact 25-fps timestamp (1.16 s) computed to 28.999999999999996 and
    selected frame 28; at 30000/1001 the same drift missed 33 of 999
    boundaries. The timestamp is first snapped to its simplest rational
    (limit_denominator mirrors the precision a timestamp actually carries)
    and the conversion is then exact integer/rational arithmetic. The frame
    CONTAINING the time still wins for mid-frame times (floor semantics);
    the result is clamped to [0, total-1].
    """
    t = Fraction(time_seconds).limit_denominator(1_000_000)
    frame = (t * fps_num) // fps_den
    return max(0, min(int(frame), total - 1))


def _unlink_numbered_png(written, identity=None):
    try:
        current = os.lstat(written)
        if (stat.S_ISREG(current.st_mode) and current.st_uid == os.geteuid()
                and current.st_nlink == 1 and (identity is None or
                (current.st_dev, current.st_ino) == identity)):
            os.unlink(written)
    except OSError:
        pass  # Never follow a link, recurse or mask the original write failure.


def _png_stat_identity(value):
    return (value.st_dev, value.st_ino, value.st_mode, value.st_uid, value.st_nlink,
            value.st_size, value.st_mtime_ns, value.st_ctime_ns)


def _write_preview_png(core, vs, clip, frame, out, max_png_bytes):
    """One full RGB24 frame; exact numbered scratch cleanup before any retry.

    Caller supplies a fresh private directory. This limits accepted output,
    not fpng's native allocation/disk use before get_frame returns.
    """
    root, _ext = os.path.splitext(out)
    template = root + "%d.png"
    written = template % 0

    def attempt(matrix=None):
        # A pre-existing numbered name was not acquired by this attempt.
        if os.path.lexists(written):
            raise RuntimeError("numbered preview output already exists; select a fresh output path")
        started = False
        identity = None
        target_fd = None
        target_identity = None
        try:
            if not hasattr(os, "O_NOFOLLOW") or not hasattr(os, "O_NONBLOCK"):
                raise RuntimeError("no-follow/nonblocking PNG verification is unavailable")
            if os.path.lexists(out):
                # Direct helper clients historically reuse an explicitly selected
                # regular output. Pin it while rendering; aliases are refused.
                # The private companion lease normally has no existing output.
                target_fd = os.open(out, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
                target = os.fstat(target_fd)
                if (not stat.S_ISREG(target.st_mode) or target.st_uid != os.geteuid()
                        or target.st_nlink != 1):
                    raise RuntimeError("existing PNG output is not an owned single-link regular file")
                target_identity = _png_stat_identity(target)
            rgb = core.resize.Bicubic(clip, format=vs.RGB24, matrix_in_s=matrix) if matrix \
                else core.resize.Bicubic(clip, format=vs.RGB24)
            single = rgb[frame:frame + 1]
            started = True
            written_clip = core.fpng.Write(single, template)
            written_clip.get_frame(0)
            fd = os.open(written, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            try:
                current = os.fstat(fd)
                if (not stat.S_ISREG(current.st_mode) or current.st_uid != os.geteuid()
                        or current.st_nlink != 1 or current.st_size <= 0):
                    raise RuntimeError("fpng output is not an owned single-link regular file")
                identity = (current.st_dev, current.st_ino)
                if current.st_size > max_png_bytes:
                    raise PreviewPNGTooLarge(
                        f"Preview PNG exceeded maxPngBytes ({max_png_bytes}); select a larger "
                        "maxPngBytes or VSRES_PREVIEW_MAX_PNG_BYTES for this full-size frame")
                selected = os.lstat(written)
                if _png_stat_identity(selected) != _png_stat_identity(current):
                    raise RuntimeError("fpng output changed before publication")
                if target_identity is None:
                    if os.path.lexists(out):
                        raise RuntimeError("selected PNG output appeared before publication")
                elif (_png_stat_identity(os.fstat(target_fd)) != target_identity or
                        _png_stat_identity(os.lstat(out)) != target_identity):
                    raise RuntimeError("selected existing PNG changed before publication")
                # Identity checks plus rename are cooperative guards, not atomic
                # compare-and-swap against an adversarial same-UID writer (B1').
                os.replace(written, out)
            finally:
                os.close(fd)
        finally:
            if target_fd is not None:
                os.close(target_fd)
            if started:
                _unlink_numbered_png(written, identity)

    try:
        attempt()
        return None
    except Exception as error:
        if "no path between colorspaces" not in str(error):
            raise
        attempt("709")
        return "709"  # Same explicit display-only assumption as the worker.


def emit(payload):
    print(json.dumps(payload))
    sys.exit(0)


def selfcheck():
    """Bounded runtime capability check — the EXACT import contract the
    render path uses (same path resolution, same import), with NO media,
    NO core instantiation and NO plugin loading. Prints one JSON line:
      {"ok": true,  "version": "R82", "bits": 64, "platform": "..."}
      {"ok": false, "reason": "<classified, sanitized>"}
    Used by the companion to distinguish missing executable / wrong
    architecture / missing module / missing native library — a python that
    merely EXISTS is never called "VapourSynth-capable"."""
    try:
        import struct
        import sysconfig
    except Exception:  # pragma: no cover — stdlib always present
        emit({"ok": False, "reason": "python-stdlib-missing"})
    _resolve_runtime_paths()
    try:
        import vapoursynth  # noqa: F401
    except Exception as e:
        text = str(e)
        if "No module named" in text:
            reason = "vapoursynth-module-missing"
        elif "dylib" in text or "Library not loaded" in text or "image not found" in text:
            reason = "native-library-missing"
        elif "no suitable image found" in text or "Bad CPU type" in text:
            reason = "incompatible-architecture"
        else:
            reason = f"vapoursynth-import-failed: {text[:160]}"
        emit({"ok": False, "reason": reason})
    emit({
        "ok": True,
        "version": getattr(vapoursynth, "__version__", "unknown"),
        "bits": struct.calcsize("P") * 8,
        "platform": sysconfig.get_platform(),
        # WHERE the module loaded from — lets callers/stests prove the
        # intended (staged) copy won precedence, not a dev-machine leak.
        "from": getattr(vapoursynth, "__file__", None),
    })


def _resolve_runtime_paths():
    """The SAME path resolution main() uses, factored out so --selfcheck
    measures the real production import contract."""
    user_plugins = os.path.expanduser("~/Library/Application Support/VapourSynth/Plugins")
    vs_python = os.path.expanduser("~/Library/Application Support/VapourSynth-OFX/vs-python")
    here = os.path.dirname(os.path.abspath(__file__))
    # Bundle-internal candidates (self-containment, 2026-10-31): when the
    # script ships INSIDE the packaged app it sits at <resources>/scripts,
    # so the OFX bundle is at ../OFX; in the dev checkout the staged
    # portable bundle is at ../build-portable/portable. Each candidate is
    # used only when it exists.
    staged_vs = None
    staged_plugins = None
    for _base in (
        # packaged layout
        os.path.join(here, "..", "OFX", "VapourSynth.ofx.bundle", "Contents"),
        # dev-checkout layout (staged portable bundle)
        os.path.join(here, "..", "build-portable", "portable",
                     "VapourSynth.ofx.bundle", "Contents"),
    ):
        if os.path.isdir(_base):
            if staged_vs is None and os.path.isdir(os.path.join(_base, "Resources", "vs-python")):
                staged_vs = os.path.normpath(os.path.join(_base, "Resources", "vs-python"))
            if staged_plugins is None and os.path.isdir(os.path.join(_base, "Plugins")):
                staged_plugins = os.path.normpath(os.path.join(_base, "Plugins"))
    for cand in (os.environ.get("VSRES_VS_PYTHON"), staged_vs):
        if cand and os.path.isdir(cand):
            sys.path.insert(0, cand)
    # Plugin autoload (empirically mapped 2026-10-31, this VS macOS
    # build): VAPOURSYNTH_EXTRA_PLUGIN_PATH is the ONLY plugin-loading
    # mechanism — a SINGLE path (os.pathsep-joined lists break loading
    # entirely) and the DEFAULT user-dir autoload DOES NOT EXIST (with
    # the env unset and a fully populated user dir, only the 3 builtin
    # namespaces register). The old code worked because it set
    # env=user_plugins (single path); not because of any autoload.
    #   1. an EXISTING env value wins untouched (tests inject fixture
    #      dirs; owner override) — single path, respected verbatim
    #   2. else the BUNDLE's Contents/Plugins (superset of the curated
    #      user set — covers journey fixtures AND clean machines)
    #   3. else the legacy user dir
    if not os.environ.get("VAPOURSYNTH_EXTRA_PLUGIN_PATH"):
        for cand in (staged_plugins, user_plugins):
            if cand and os.path.isdir(cand):
                os.environ["VAPOURSYNTH_EXTRA_PLUGIN_PATH"] = cand
                break
    if os.path.isdir(vs_python):
        sys.path.insert(0, vs_python)


def main():
    ap = argparse.ArgumentParser(add_help=False)
    ap.add_argument("--selfcheck", action="store_true",
                    help="bounded capability probe: resolve runtime, import "
                         "vapoursynth, print one JSON line; no media/core")
    ap.add_argument("--server", action="store_true",
                    help="persistent JSON-lines render worker (stdin/stdout)")
    ap.add_argument("--script", required=False)
    ap.add_argument("--frame", type=int, default=0)
    # TIME-BASED MAPPING: the chain can CHANGE CADENCE (QTGMC FPSDivisor=2
    # halves; BlockFPS/RIFE multiply). The same numeric frame index means
    # different presentation times in source vs processed clips (live case:
    # 25fps source → QTGMC 12.5p → BlockFPS 50p made frame 100 = 4s of source
    # but 2s of output). The companion asks by PRESENTATION TIME; each mode
    # resolves time → its own frame index via its own fps. --time (seconds)
    # takes precedence over --frame.
    ap.add_argument("--time", type=float, default=None,
                    help="presentation time in seconds; resolved per-mode "
                         "using the evaluated clip's own frame rate")
    ap.add_argument("--out", required=False)
    ap.add_argument("--max-png-bytes", type=int, default=None)
    ap.add_argument("--mode", choices=("processed", "source"), default="processed")
    ap.add_argument("--sar", default=None,
                    help="storage/sample aspect ratio from the probe metadata "
                         "(e.g. '4:3') applied to source mode so A/B shares "
                         "display geometry; falls back to frame _SAR props")
    args, _unknown = ap.parse_known_args()

    if args.selfcheck:
        selfcheck()
        return
    if not args.script or not args.out:
        emit({"ok": False, "error": "--script and --out are required (or --selfcheck)"})
        return
    try:
        max_png_bytes = _png_budget() if args.max_png_bytes is None else _png_budget(args.max_png_bytes)
    except ValueError as error:
        emit({"ok": False, "error": str(error)})
        return
    _resolve_runtime_paths()

    # (Runtime path resolution lives in _resolve_runtime_paths(); the
    # --selfcheck probe measures the exact same contract.)

    import vapoursynth as vs  # noqa: E402

    core = vs.core
    with open(args.script, "r", encoding="utf-8") as f:
        script_text = f.read()

    namespace = {"__name__": "__vsres_preview__"}
    try:
        exec(compile(script_text, args.script, "exec"), namespace)
    except Exception as e:
        emit({"ok": False, "error": f"script evaluation failed: {e}"})

    # Display-conversion assumption label (one-shot path): set when a
    # prop-less clip forces the BT.709 fallback in the render below.
    display_matrix_assumed = None
    clip = None
    if args.mode == "source":
        # Source-mode scripts bind `src` (lsmas LWLibavSource) before chaining.
        clip = namespace.get("src")
        if clip is not None:
            # DISPLAY-ASPECT CORRECTION for the A/B comparison: the source is
            # at NATIVE storage dims (e.g. HDV 1440x1080, SAR 4:3 -> displays
            # 16:9), while the processed output is at timeline dims. Rendering
            # the source raw made the A/B view look 4:3-distorted (live
            # feedback). Prefer the probe metadata (--sar, from the companion);
            # fall back to the frame props (_SARNum/_SARDen) when unspecific.
            sar_num = sar_den = 0
            if args.sar and ":" in args.sar:
                try:
                    sar_num, sar_den = (int(p) for p in args.sar.split(":", 1))
                except ValueError:
                    sar_num = sar_den = 0
            if not (sar_num and sar_den):
                try:
                    f0 = clip.get_frame(0)
                    sar_num = f0.props.get("_SARNum", 0) or 0
                    sar_den = f0.props.get("_SARDen", 0) or 0
                except Exception:
                    sar_num = sar_den = 0
            if sar_num and sar_den and clip.height:
                display_w = round(clip.width * sar_num / sar_den)
                if display_w != clip.width and display_w > 0:
                    clip = core.resize.Spline36(
                        clip, width=display_w, height=clip.height)
    else:
        clip = namespace.get("clip")
        if clip is None:
            # set_output() style script: read the output node the VS way.
            clip = core.get_output(0)[1] if hasattr(core, "get_output") else None
    if clip is None:
        emit({"ok": False, "error": f"script has no {'src' if args.mode == 'source' else 'clip'} variable to render"})

    # STALE-RENDER GUARD (live defect Oct 27): the per-node .vpy is written by
    # render_chain on EVERY native render — including Resolve's thumbnail/
    # UI-tile renders (observed 576x324, 184x92), whose incidental final
    # resize-to-render-dims gets baked into the script tail. Replaying that
    # script made the PROCESSED preview show a 576x324 image (stretched back
    # up in the viewer = soft + combing-looking), while the source mode
    # showed full-res — the reported A/B defects. Fix: both modes render at
    # the SOURCE's DISPLAY geometry (native dims with the probe's SAR
    # applied), so A/B overlays pixel-identically at the intended detail,
    # independent of whatever render size last wrote the script. The chain
    # (filters, cadence) is untouched; only the final presentational resize
    # is normalized. Fraction rates/trims unchanged.
    if args.mode == "source":
        pass  # clip is already the raw src; SAR correction applied below.
    else:
        # Locate the SOURCE in the same namespace (source-mode scripts bind
        # it; clip-mode scripts bind `source` = the OFXSource filter which we
        # cannot pull here — in that case keep the chain's own output dims).
        # SQUISH FIX (2026-10-29): normalize to the source DISPLAY geometry
        # ONLY when the chain is still at the source's NATIVE storage dims
        # (no timeline upscale). A chain already resized by its own script
        # (e.g. 1920x1080 timeline) is correct display geometry — resizing it
        # to (src display_w, src height) changed its aspect (double
        # correction, the reported vertical squish).
        src_clip = namespace.get("src")
        if src_clip is not None and (
                clip.width == src_clip.width and clip.height == src_clip.height):
            sar_num = sar_den = 0
            if args.sar and ":" in args.sar:
                try:
                    sar_num, sar_den = (int(p) for p in args.sar.split(":", 1))
                except ValueError:
                    sar_num = sar_den = 0
            if not (sar_num and sar_den):
                try:
                    f0 = src_clip.get_frame(0)
                    sar_num = f0.props.get("_SARNum", 0) or 0
                    sar_den = f0.props.get("_SARDen", 0) or 0
                except Exception:
                    sar_num = sar_den = 0
            disp_w = src_clip.width
            if sar_num and sar_den:
                disp_w = round(src_clip.width * sar_num / sar_den)
            if disp_w > 0 and disp_w != clip.width and clip.height > 0:
                clip = core.resize.Spline36(
                    clip, width=disp_w, height=clip.height)

    total = clip.num_frames
    # Per-mode frame resolution. fps from the EVALUATED clip (Fraction-exact):
    # the source clip keeps the media's rate; the processed clip carries
    # whatever cadence the chain produced (BlockFPS/RIFE/FPSDivisor change
    # it). Fractional rates are exact — no float drift.
    fps_num, fps_den = clip.fps_num, clip.fps_den
    if args.time is not None and fps_num and fps_den:
        # Presentation time → this clip's frame index, EXACT at boundaries
        # (C10, 2026-11-11): float floor math selected N−1 for exact frame
        # timestamps; _frame_at_time snaps the timestamp to a rational and
        # converts exactly, clamped to [0, total-1].
        frame = _frame_at_time(args.time, fps_num, fps_den, total)
    else:
        frame = args.frame
    frame = max(0, min(frame, total - 1))
    duration_s = (total * fps_den / fps_num) if fps_num else None
    try:
        display_matrix_assumed = _write_preview_png(core, vs, clip, frame, args.out, max_png_bytes)
    except Exception as e:
        emit({"ok": False, "error": f"render failed: {e}",
              "pngOutputLimit": isinstance(e, PreviewPNGTooLarge)})

    # R6: the ONE-SHOT path computes native-depth metrics TOO — no render
    # path lacks them (the worker path does this in serve(); a fallback to
    # this path must not silently downgrade scope precision).
    scopes_one_shot = None
    try:
        scopes_one_shot = _scope_metrics(core, vs, clip, frame,
                                        {"scopes": True})
    except Exception as _se:
        scopes_one_shot = {"domain": "unavailable", "error": str(_se)[:120]}
    emit({"ok": True, "frame": frame, "total": total,
          "fpsNum": fps_num, "fpsDen": fps_den,
          "durationS": duration_s,
          "presentationTimeS": (frame * fps_den / fps_num) if fps_num else None,
          "width": clip.width, "height": clip.height,
          "displayMatrixAssumed": display_matrix_assumed,
          "scopes": scopes_one_shot})




# ── PERSISTENT RENDER WORKER (--server) ────────────────────────────────────
# Long-lived JSON-lines renderer: one python + one VapourSynth import + ONE
# script evaluation per script-text change. Frame requests reuse the
# evaluated clips (the source stays OPEN + indexed across frames — the
# dominant cost of the one-shot path: every frame used to re-spawn,
# re-import, re-evaluate and re-open the media). Scope metrics are computed
# at NATIVE frame depth on a stride subsample BEFORE the 8-bit display
# conversion — genuine signal-referred measurement (labeled in the payload).
#
# Protocol (stdin → stdout, one JSON object per line):
#   {"id":N, "script":text, "frame":i, "time":s, "mode":"source|processed",
#    "sar":"n:d", "out":path, "scopes":true}
#   → {"id":N, "ok":true, ...frame metadata..., "scopes": {...}|null}
#   → {"id":N, "ok":false, "error":"..."}   (worker survives request errors)
def _hash_text(text):
    import hashlib
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _clip_for_request(core, vs, namespace, req, cache):
    """Evaluate the script only when its text changed; build the per-request
    presentational clip (mode + SAR correction) from the cached namespace."""
    key = _hash_text(req.get("script") or "")
    if cache.get("script_key") != key:
        namespace.clear()
        namespace.update({"__name__": "__vsres_preview__"})
        exec(compile(req["script"], "<worker-script>", "exec"), namespace)
        cache["script_key"] = key
        cache["clips"] = {}
    mode = req.get("mode", "processed")
    sar = req.get("sar")
    ckey = (mode, sar)
    if ckey in cache["clips"]:
        return cache["clips"][ckey]
    clip = namespace.get("src") if mode == "source" else namespace.get("clip")
    if clip is None and mode != "source":
        clip = core.get_output(0)[1] if hasattr(core, "get_output") else None
    if clip is None:
        raise RuntimeError("script has no " + ("src" if mode == "source" else "clip") + " variable to render")
    clip = _apply_sar_display_geometry(core, clip, sar, namespace.get("src") if mode != "source" else None)
    cache["clips"][ckey] = clip
    return clip


def _apply_sar_display_geometry(core, clip, sar, src_clip=None):
    """Display-aspect correction, applied EXACTLY ONCE (squish fix 2026-10-29).

    SOURCE mode (src_clip=None): widen the raw source to its display dims
    (probe SAR or frame _SAR props) — the file's own storage aspect is NOT
    its display aspect (720x576 SAR 16:15 displays 4:3).

    CHAIN mode (src_clip=the source): the script is the geometry authority.
    A chain already resized to TIMELINE dims (1920x1080 square-pixel) is
    correct display geometry — re-applying the source SAR on it was a
    DOUBLE correction (1920*16/15=2048x1080 → 1.9:1 baked into the chain
    PNG → the reported vertical squish). Normalize ONLY when the chain is
    still at the source's NATIVE storage dims (no timeline upscale), so A/B
    shares display geometry in the plain-preview case; never change the
    aspect of a clip the script already resized."""
    if src_clip is not None:
        if (clip.width != src_clip.width) or (clip.height != src_clip.height):
            return clip          # chain at timeline/scaled dims — script authority
    sar_num = sar_den = 0
    if sar and ":" in sar:
        try:
            sar_num, sar_den = (int(p_) for p_ in sar.split(":", 1))
        except ValueError:
            sar_num = sar_den = 0
    if not (sar_num and sar_den):
        try:
            f0 = clip.get_frame(0)
            sar_num = f0.props.get("_SARNum", 0) or 0
            sar_den = f0.props.get("_SARDen", 0) or 0
        except Exception:
            sar_num = sar_den = 0
    if not (sar_num and sar_den) or not clip.height:
        return clip
    display_w = round(clip.width * sar_num / sar_den)
    if display_w != clip.width and display_w > 0:
        clip = core.resize.Spline36(clip, width=display_w, height=clip.height)
    return clip


def _scope_metrics(core, vs, clip, fidx, req):
    """NATIVE-DEPTH, signal-referred scope metrics on a stride subsample,
    taken BEFORE the 8-bit display conversion (verified binding:
    frame[plane] is a memoryview; plane[y, x] returns the sample;
    plane.shape gives that plane's (rows, cols)). Pure-python (no numpy in
    the embedded runtime) — the stride targets ~60k samples so the cost
    stays bounded. One pass accumulates:
      - per-plane histograms (code-value bins at native depth),
      - a per-column min/max/avg profile per plane (parade envelope),
      - a chroma grid (YUV: U/V joint occupancy; RGB: 709-derived B-Y/R-Y,
        labeled as such; GRAY: none),
      - out-of-range excursion counts (never silently clipped).
    The payload LABELS the measurement domain honestly: format, depth,
    sample type, stride, bins and per-plane sample counts."""
    if not req.get("scopes"):
        return None
    frame = clip.get_frame(fidx)
    fmt = frame.format
    depth = fmt.bits_per_sample
    is_float = fmt.sample_type == vs.FLOAT
    fam = "YUV" if fmt.color_family == vs.YUV else ("RGB" if fmt.color_family == vs.RGB else "GRAY")
    rows0, cols0 = frame[0].shape
    step = max(1, int((rows0 * cols0 / 60000) ** 0.5))
    hist_bins = 1024 if (depth > 8 or is_float) else 256
    norm_div = float((1 << depth) - 1) if (depth and not is_float) else 1.0
    # WAVEFORM: per-plane 2-D DENSITY grids — sampled columns × level bins —
    # so the renderer can draw a conventional sample-density waveform (image
    # horizontal position → x axis, signal level → y axis, density = coverage)
    # instead of min–max envelopes (which painted solid filled bands).
    # 240 columns × 64 level bins per plane; density normalized per grid to
    # the column sample count (constant stride ⇒ FIXED scale — no per-frame
    # auto-normalization that would conceal real signal changes).
    wave_cols_n = 240
    wave_levels = 64
    wave = [[[0] * wave_levels for _ in range(wave_cols_n)]
            for _ in range(fmt.num_planes)]
    wave_count_total = 0
    hist = [[0] * hist_bins for _ in range(fmt.num_planes)]
    columns = [[] for _ in range(fmt.num_planes)]   # per plane: [colIndex, min, max, avg]
    excursions = {"low": 0, "high": 0}
    # RGB ANALYSIS CONVENTION (owner 2026-10-30): an RGB-labelled scope view
    # must show ACTUAL R/G/B for BOTH source and chain — like-for-like. For
    # YUV input the worker converts the native clip to RGBS with VapourSynth's
    # OWN resize (the installed version's documented conversion behavior —
    # validated: a hand-rolled matrix formula diverged from VS resize in
    # chroma siting and luma rounding) and samples that, BEFORE any display
    # conversion. Matrix/range come from frame props when specified; an
    # UNSPECIFIED source (_Matrix=2 observed on real ProRes) uses the node's
    # CONFIGURED input matrix as the explicit CONTROLLED assumption (same
    # matrix the chain conversion uses → identity comparisons are
    # like-for-like), labeled in the payload — never an invisible guess.
    plane_samples = {str(i): 0 for i in range(fmt.num_planes)}
    rgb_wave = None
    rgb_excursions = {"low": 0, "high": 0}
    rgb_basis = None
    rgb_matrix = None
    rgb_range = None
    rgb_depth = None
    rgb_sample_type = None
    if fam == "YUV" and fmt.num_planes >= 3:
        props = frame.props
        m = props.get("_Matrix")
        matrix_names = {0: "gbr", 1: "709", 5: "170m", 6: "470bg",
                        8: "YCgCo", 9: "2020ncl", 10: "2020cl"}
        hint = req.get("rgb_matrix") if isinstance(req.get("rgb_matrix"), str) else None
        assumed_matrix = False
        if m in (1, 5, 6):
            rgb_matrix = matrix_names[m]
        elif hint in ("709", "170m", "470bg", "2020ncl"):
            rgb_matrix = hint
            assumed_matrix = True
        else:
            rgb_matrix = "709" if frame.height >= 720 else "470bg"
            assumed_matrix = True
        rng = props.get("_Range", props.get("_ColorRange"))
        # VS convention: 0=limited (studio swing), 1=full.
        if rng in (0, 1):
            rgb_range = "limited" if rng == 0 else "full"
        else:
            rgb_range = "limited"
        rgb_basis = ("RGB via VapourSynth resize conversion from native YUV "
                      "(matrix %s, %s range) before any display conversion"
                      % (rgb_matrix, rgb_range))
        if assumed_matrix:
            rgb_basis += ("; source _Matrix unspecified — matrix ASSUMED from the node's"
                          " configured input color space" if hint else
                          "; source _Matrix unspecified — matrix ASSUMED by resolution heuristic")
        try:
            rgb_clip = core.resize.Bicubic(clip, format=vs.RGBS,
                                           matrix_in_s=rgb_matrix,
                                           range_in_s=rgb_range)
            rframe = rgb_clip.get_frame(fidx)
            rgb_depth = rframe.format.bits_per_sample
            rgb_sample_type = rframe.format.sample_type
            rgb_wave = [[[0] * wave_levels for _ in range(wave_cols_n)]
                        for _ in range(3)]
            rgb_excursions = {"low": 0, "high": 0}
            rh, rw = rframe[0].shape
            for y in range(0, rh, step):
                for x in range(0, rw, step):
                    wc = min(wave_cols_n - 1,
                             int(x * wave_cols_n / max(1, rw - 1)))
                    for ci in range(3):
                        val = rframe[ci][y, x]
                        if val < 0.0:
                            rgb_excursions["low"] += 1
                        elif val > 1.0:
                            rgb_excursions["high"] += 1
                        wl = min(wave_levels - 1,
                                 int(max(0.0, min(0.999999, val)) * (wave_levels - 1)))
                        rgb_wave[ci][wc][wl] += 1
        except Exception as _re:
            rgb_basis = "RGB analysis unavailable: %s" % str(_re)[:120]
            rgb_wave = None
    elif fam == "RGB":
        rgb_basis = "native RGB planes (no derivation)"
        rgb_wave = wave
        rgb_matrix = "gbr"
        rgb_range = "full"
        rgb_excursions = excursions
        rgb_depth = depth
        rgb_sample_type = "float" if is_float else "integer"
    chroma_grid = None
    chroma_size = 128
    if fam in ("YUV", "RGB"):
        chroma_grid = [0] * (chroma_size * chroma_size)
    for p_i in range(fmt.num_planes):
        plane = frame[p_i]
        rows, cols = plane.shape
        col_stats = {}
        for y in range(0, rows, step):
            for x in range(0, cols, step):
                plane_samples[str(p_i)] += 1
                v = plane[y, x]
                nrm = max(0.0, min(0.999999, (v / norm_div) if not is_float else float(v)))
                b = int(nrm * (hist_bins - 1))
                hist[p_i][b] += 1
                # Sample-density waveform accumulation (fixed grids; the
                # LAST column clamps — x==cols-1 maps to wave_cols_n-1, never
                # out of range on step-1 (small-clip) grids).
                wc = min(wave_cols_n - 1, int(x * wave_cols_n / max(1, cols - 1)))
                wl = min(wave_levels - 1, int(nrm * (wave_levels - 1)))
                wave[p_i][wc][wl] += 1
                wave_count_total += 1
                if not is_float and depth:
                    if v <= 0: excursions["low"] += 1
                    if v >= (1 << depth) - 1: excursions["high"] += 1
                else:
                    if v < 0.0: excursions["low"] += 1
                    if v > 1.0: excursions["high"] += 1
                st = col_stats.setdefault(x, [v, v, 0.0, 0])
                if v < st[0]: st[0] = v
                if v > st[1]: st[1] = v
                st[2] += v
                st[3] += 1
        columns[p_i] = [[x, st[0], st[1], st[2] / st[3]] for x, st in sorted(col_stats.items())]
    if fam == "YUV" and fmt.num_planes >= 3:
        u_plane = frame[1]
        v_plane = frame[2]
        ur, uc = u_plane.shape
        # Neutral center for studio-swing chroma: (1 << (depth-1)) for int,
        # 0.0 for float; normalized to the grid.
        center = float(1 << (depth - 1)) if (depth and not is_float) else 0.0
        span = float((1 << depth) - 1) if (depth and not is_float) else 1.0
        for y in range(0, ur, step):
            for x in range(0, uc, step):
                u = (u_plane[y, x] - center) / (span / 2.0)
                v = (v_plane[y, x] - center) / (span / 2.0)
                gx = int(max(0.0, min(0.999999, (u + 1.0) / 2.0)) * (chroma_size - 1))
                gy = int(max(0.0, min(0.999999, (v + 1.0) / 2.0)) * (chroma_size - 1))
                chroma_grid[gy * chroma_size + gx] += 1
        chroma_basis = "U/V from the source's own chroma planes (studio-swing centered; source matrix NOT re-interpreted)"
    elif fam == "RGB" and fmt.num_planes >= 3:
        r_p, g_p, b_p = frame[0], frame[1], frame[2]
        rr, rc = r_p.shape
        for y in range(0, rr, step):
            for x in range(0, rc, step):
                r = (r_p[y, x] / norm_div) if not is_float else r_p[y, x]
                g = (g_p[y, x] / norm_div) if not is_float else g_p[y, x]
                b = (b_p[y, x] / norm_div) if not is_float else b_p[y, x]
                # Rec.709-derived component difference (labeled assumption —
                # no source matrix metadata is read here).
                y709 = 0.2126 * r + 0.7152 * g + 0.0722 * b
                by = (b - y709) * 0.55
                ry = (r - y709) * 0.55
                gx = int(max(0.0, min(0.999999, (by + 1.0) / 2.0)) * (chroma_size - 1))
                gy = int(max(0.0, min(0.999999, (ry + 1.0) / 2.0)) * (chroma_size - 1))
                chroma_grid[gy * chroma_size + gx] += 1
        chroma_basis = "B-Y / R-Y derived via Rec.709 from RGB planes (assumed matrix — labeled)"
    else:
        chroma_grid = None
        chroma_basis = None
    # LUMA profile (for the luma waveform view): YUV plane 0 IS luma;
    # RGB → Rec.709-weighted derivation, LABELED as a derivation with its
    # matrix assumption (gamma-encoded values are NOT physical luminance —
    # the payload says so; no transfer decode is applied here).
    luma_columns = None
    luma_basis = None
    wave_luma = None
    if fam == "YUV":
        luma_columns = columns[0] if columns else None
        luma_basis = "plane 0 (Y) — the signal's own luma"
        wave_luma = wave[0]
    elif fam == "RGB" and fmt.num_planes >= 3:
        luma_basis = ("Rec.709 weighted (0.2126R+0.7152G+0.0722B) derived from RGB "
                      "planes — GAMMA-ENCODED values, NOT physical luminance; "
                      "matrix/transfer assumptions labeled, no decode applied")
        r_p, g_p, b_p = frame[0], frame[1], frame[2]
        col = {}
        for y in range(0, rows0, step):
            for x in range(0, cols0, step):
                if is_float:
                    r_, g_, b_ = r_p[y, x], g_p[y, x], b_p[y, x]
                else:
                    r_ = r_p[y, x] / norm_div
                    g_ = g_p[y, x] / norm_div
                    b_ = b_p[y, x] / norm_div
                l_ = 0.2126 * r_ + 0.7152 * g_ + 0.0722 * b_
                # Luma sample-density grid (same fixed mapping as the planes).
                lwc = min(wave_cols_n - 1, int(x * wave_cols_n / max(1, cols0 - 1)))
                lwl = min(wave_levels - 1, int(max(0.0, min(0.999999, l_)) * (wave_levels - 1)))
                if wave_luma is None:
                    wave_luma = [[0] * wave_levels for _ in range(wave_cols_n)]
                wave_luma[lwc][lwl] += 1
                st = col.setdefault(x, [l_, l_, 0.0, 0])
                if l_ < st[0]:
                    st[0] = l_
                if l_ > st[1]:
                    st[1] = l_
                st[2] += l_
                st[3] += 1
        luma_columns = [[x, st[0], st[1], st[2] / st[3]]
                        for x, st in sorted(col.items())]
    return {
        "domain": "signal-referred",
        "format": str(fmt.name),
        "family": fam,
        "depth": depth,
        "sampleType": "float" if is_float else "integer",
        "subsampleStride": step,
        "histBins": hist_bins,
        "histogram": hist,
        "columns": columns,
        "wave": {
            "cols": wave_cols_n,
            "levels": wave_levels,
            "planes": wave,
            "luma": wave_luma,
            "note": ("sample-density grids (fixed 240x64 mapping, density "
                     "normalized by the per-column sample count — NO per-frame "
                     "auto-normalization)"),
        },
        "luma": {"basis": luma_basis, "columns": luma_columns} if luma_columns else None,
        "chroma": {"size": chroma_size, "grid": chroma_grid, "basis": chroma_basis} if chroma_grid else None,
        "excursions": excursions,
        "planeSamples": plane_samples,
        "rgb": (({"basis": rgb_basis, "matrix": rgb_matrix, "range": rgb_range,
                  "excursions": rgb_excursions,
                  "depth": rgb_depth, "sampleType": rgb_sample_type,
                  "wave": rgb_wave} if (rgb_wave is not None)
                 else ({"basis": rgb_basis, "unavailable": True}
                       if rgb_basis else None))),
        "note": "stride-subsampled native-depth samples taken BEFORE the 8-bit display conversion",
    }


def serve():
    _resolve_runtime_paths()
    import vapoursynth as vs
    core = vs.core
    namespace = {}
    cache = {"script_key": None, "clips": {}}
    import json as _json
    import sys as _sys
    for line in _sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = _json.loads(line)
        except Exception:
            print(_json.dumps({"ok": False, "error": "worker: bad request line"}), flush=True)
            continue
        rid = req.get("id")
        try:
            max_png_bytes = _png_budget(req["maxPngBytes"] if "maxPngBytes" in req else _PNG_UNSET)
            clip = _clip_for_request(core, vs, namespace, req, cache)
            total = clip.num_frames
            fps_num, fps_den = clip.fps_num, clip.fps_den
            if req.get("time") is not None and fps_num and fps_den:
                # Same exact conversion as the one-shot path (C10, 2026-11-11).
                fidx = _frame_at_time(req["time"], fps_num, fps_den, total)
            else:
                fidx = int(req.get("frame") or 0)
            fidx = max(0, min(fidx, total - 1))
            out = req["out"]
            display_matrix_assumed = _write_preview_png(
                core, vs, clip, fidx, out, max_png_bytes)
            scopes = None
            try:
                scopes = _scope_metrics(core, vs, clip, fidx, req)
            except Exception as se:  # scopes are optional telemetry
                scopes = {"domain": "unavailable", "error": str(se)[:120]}
            resp = {"id": rid, "ok": True, "frame": fidx, "total": total,
                    "fpsNum": fps_num, "fpsDen": fps_den,
                    "durationS": (total * fps_den / fps_num) if fps_num else None,
                    "presentationTimeS": (fidx * fps_den / fps_num) if fps_num else None,
                    "width": clip.width, "height": clip.height,
                    "scopes": scopes,
                    "displayMatrixAssumed": display_matrix_assumed}
        except Exception as e:
            resp = {"id": rid, "ok": False, "error": str(e)[:400],
                    "pngOutputLimit": isinstance(e, PreviewPNGTooLarge)}
        print(_json.dumps(resp), flush=True)

if __name__ == "__main__":
    if "--server" in sys.argv:
        serve()
    else:
        main()
