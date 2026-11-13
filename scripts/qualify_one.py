#!/usr/bin/env python3
"""One candidate per process — isolate plugin crashes from the harness.

Args: name fixture. Prints one JSON line. Metrics:
- spatial: d1/d2 (across/same-field vertical deltas), Laplacian band
- temporal: frame-to-frame pixel delta (for flicker fixture)
Fixtures (tests/fixtures, deterministic ProRes): motion (edges), noise
(spatial HF), flicker (low-amplitude temporal), interlaced (fields).
"""
import ctypes
import json
import os
import sys
from fractions import Fraction

os.environ["VAPOURSYNTH_EXTRA_PLUGIN_PATH"] = os.path.expanduser(
    "~/Library/Application Support/VapourSynth/Plugins")
sys.path.insert(0, os.path.expanduser("~/Library/Application Support/VapourSynth-OFX/vs-python"))
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO, "vendor", "vapoursynth", "active",
                                "lib", "python3.14", "site-packages"))

import vapoursynth as vs  # noqa: E402
try:
    import vsres_conv as mvf
except ImportError:  # legacy bundles without the replacement layer
    import mvsfunc as mvf  # noqa: E402
import adjust            # noqa: E402  (PYTHON helper — the native core.adjust
                         #  plugin hard-aborts the process on YUV422P10;
                         #  the helper is the safe path)

core = vs.core
FIX = os.path.join(REPO, "tests", "fixtures")


def load(p):
    return core.lsmas.LWLibavSource(p)


def y8(c):
    if c.format.color_family == vs.RGB:
        return core.resize.Bicubic(c, format=vs.YUV420P8, matrix_s="709")
    if c.format.id != vs.YUV420P8:
        return core.resize.Bicubic(c, format=vs.YUV420P8)
    return c


def raw_rows(frame, plane=0):
    w, h = frame.width, frame.height
    ptr = int(frame.get_read_ptr(plane).value)
    stride = frame.get_stride(plane)
    buf = (ctypes.c_ubyte * (stride * h)).from_address(ptr)
    return bytes(buf), stride, w, h


def metrics(frame):
    raw, stride, w, h = raw_rows(frame)
    t1 = t2 = c = 0
    lap = 0
    for y in range(2, h, 3):
        row = raw[y * stride:y * stride + w]
        r1 = raw[(y - 1) * stride:(y - 1) * stride + w]
        r2 = raw[(y - 2) * stride:(y - 2) * stride + w]
        for x in range(1, w - 1, 3):
            t1 += abs(row[x] - r1[x]); t2 += abs(row[x] - r2[x]); c += 1
    for y in range(40, h - 40, 8):
        row = raw[y * stride:y * stride + w]
        up = raw[(y - 2) * stride:(y - 2) * stride + w]
        dn = raw[(y + 2) * stride:(y + 2) * stride + w]
        for x in range(20, w - 20, 8):
            lap += abs(2 * row[x] - up[x] - dn[x])
    d1, d2 = t1 / max(c, 1), t2 / max(c, 1)
    return {"d1": round(d1, 2), "d2": round(d2, 2),
            "comb_ratio": round(d1 / max(d2, 1e-6), 2), "lap": lap}


def temporal_delta(clip, t0=0.4):
    """Mean |pixel(t0) - pixel(t0+1frame)| — flicker energy."""
    a = raw_rows(_frame_at(clip, t0))[0]
    b = raw_rows(_frame_at(clip, t0 + 1.0 / 25))[0]
    stride_a = _frame_at(clip, t0).get_stride(0)
    # raw includes stride padding; compare per visible row
    w, h = clip.width, clip.height
    fa = _frame_at(clip, t0)
    raw_a, sa, _, _2 = raw_rows(fa)
    fb2 = _frame_at(clip, t0 + 1.0 / 25)
    raw_b, sb, _, _3 = raw_rows(fb2)
    total = cnt = 0
    for y in range(10, h - 10, 4):
        for x in range(10, w - 10, 6):
            total += abs(raw_a[y * sa + x] - raw_b[y * sb + x])
            cnt += 1
    return round(total / max(cnt, 1), 2)


def _frame_at(clip, time_s=0.4):
    fi = min(int(Fraction(time_s) * clip.fps_num // clip.fps_den), clip.num_frames - 1)
    return clip.get_frame(fi)


def frame_at(clip, time_s=0.4):
    return _frame_at(clip, time_s)


def fb(clip, time_s=0.4):
    return raw_rows(_frame_at(clip, time_s))[0]


NAME = sys.argv[1]
FIXTURE = sys.argv[2]

BUILDS = {
    # ── spatial denoise (noise fixture, spatial d2) ──────────────────────
    "bm3dmetal": lambda s: mvf.ToYUV(core.bm3dmetal.BM3D(
        mvf.ToRGB(s, depth=32), sigma=[8.0, 8.0, 8.0], radius=0),
        css="420", depth=16, matrix="709"),
    "dfttest": lambda s: core.dfttest.DFTTest(s, tbsize=1, sigma=96.0),
    "nlm_ispc": lambda s: core.nlm_ispc.NLMeans(s, d=0, a=2, s=4, h=8.0),
    "wnnm": lambda s: core.resize.Bicubic(core.wnnm.WNNM(
        core.resize.Bicubic(s, format=vs.YUV420PS), sigma=[12.0, 12.0, 12.0]),
        format=vs.YUV420P10),
    # ── temporal denoise (flicker fixture, temporal delta) ────────────────
    "ttmpsm": lambda s: core.ttmpsm.TTempSmooth(s, maxr=3, thresh=[12, 12, 12], mdiff=[64, 64, 64]),
    "focus2_temporal": lambda s: core.focus2.TemporalSoften2(s, radius=4, luma_threshold=6, chroma_threshold=12),
    "zsmooth_temporal": lambda s: core.zsmooth.FluxSmoothT(s, temporal_threshold=[12.0, 12.0, 12.0]),
    # ── deband / deblock ─────────────────────────────────────────────────
    "neo_f3kdb": lambda s: core.neo_f3kdb.Deband(s, range=15, y=64, cb=64, cr=64, grainy=0, grainc=0),
    "deblock": lambda s: core.deblock.Deblock(s, quant=24),
    # ── sharpen ──────────────────────────────────────────────────────────
    "cas": lambda s: core.cas.CAS(s, sharpness=0.4),
    "asharp": lambda s: core.asharp.ASharp(s, t=2.0, d=0.7),
    "warp_awarpsharp2": lambda s: core.warp.AWarpSharp2(s, depth=8),
    # ── field ops ────────────────────────────────────────────────────────
    "sangnom": lambda s: core.sangnom.SangNom(
        core.resize.Bicubic(s, format=vs.YUV420P16), order=1),
    "eedi2": lambda s: core.eedi2.EEDI2(core.std.SeparateFields(s, tff=True), field=1),
    "eedi3": lambda s: core.eedi3m.EEDI3(core.std.SeparateFields(s, tff=True), field=1),
    # ── restore (8-bit bounce where required) ───────────────────────────
    "lghost": lambda s: core.lghost.LGhost(s, mode=[2, 2, 2], shift=[1, 1, 1], intensity=[12, 12, 12]),
    "tcomb": lambda s: core.tcomb.TComb(y8(s), mode=0, fthreshl=12, fthreshc=12, othreshl=24, othreshc=24),
    "rdvs_restore": lambda s: core.rdvs.RestoreMotionBlocks(y8(s), y8(s), gmthreshold=80, mthreshold=80),
    # ── chroma / levels ──────────────────────────────────────────────────
    "smoothuv": lambda s: core.smoothuv.SmoothUV(y8(s), radius=3, threshold=150, interlaced=True),
    "tweak": lambda s: adjust.Tweak(s, sat=1.1, cont=1.05),
    # ── interpolation / scaling ──────────────────────────────────────────
    "mv_blockfps": lambda s: core.mv.BlockFPS(s, core.mv.Super(s, pel=2),
        core.mv.Analyse(core.mv.Super(s, pel=2), isb=True),
        core.mv.Analyse(core.mv.Super(s, pel=2), isb=False), num=50, den=1),
    "nnedi3_upscale": lambda s: core.std.Transpose(core.nnedi3.nnedi3(
        core.std.Transpose(core.nnedi3.nnedi3(s, field=0, dh=True)), field=0, dh=True)),
    "descale_debicubic": lambda s: core.descale.Debicubic(
        core.resize.Bicubic(s, format=vs.YUV444PS, width=320, height=240),
        width=320, height=240, src_width=320, src_height=240),
    # ── diagnostics (properties, not pixels) ─────────────────────────────
    "text_clipinfo": lambda s: core.text.FrameNum(s, alignment=9),
    "scdetect": lambda s: core.misc.SCDetect(s, threshold=0.2),
}

# EXPECT(name, before, after, src, built, tb, ta): True = filter does its job
def EXPECT(name, b, a, src, built, tb=None, ta=None):
    D2 = lambda m: m["d2"]
    LAP = lambda m: m["lap"]
    if name in ("bm3dmetal", "dfttest", "nlm_ispc", "wnnm"):
        # Measurable spatial-noise reduction on the synthetic fixture. Exact
        # magnitude is material-dependent (these templates' stronger
        # qualification runs against the real tape in verify_templates.sh);
        # a strict quota here would test my threshold, not the filter.
        return D2(a) < D2(b)
    # Temporal trio on the STATIC flicker fixture: MUST reduce flicker.
    if name in ("ttmpsm", "focus2_temporal", "zsmooth_temporal") and tb is not None:
        return ta < tb
    if name in ("cas", "asharp"):
        return LAP(a) > LAP(b) * 1.02
    return True


try:
    src = load(os.path.join(FIX, f"{FIXTURE}.mov"))
    before = metrics(frame_at(y8(src)))
    built = BUILDS[NAME](src)
    out_for_metrics = y8(built) if built.format.color_family != vs.RGB else built
    # wnnm path returns 10-bit; measure at native-ish depth via y8 for comparability
    after = metrics(frame_at(out_for_metrics))
    # temporal flicker metric for the temporal trio
    t_before = temporal_delta(src)
    t_after = temporal_delta(built)
    status, why = "PASS", None
    # Passthrough: same format+dims ⇒ pixels must differ (rate-changers
    # and property writers exempt: they change frame count / props by design).
    same_shape = (built.format.id == src.format.id
                  and built.width == src.width and built.height == src.height)
    rate_changed = built.num_frames != src.num_frames
    if same_shape and not rate_changed and NAME not in ("scdetect",):
        if fb(src) == fb(built):
            status, why = "FAIL-PASSTHROUGH", "output byte-identical to input (no-op)"
    if status == "PASS" and not EXPECT(NAME, before, after, src, built, t_before, t_after):
        status, why = "FAIL-EFFECT", "intended property did not change as asserted"
    print(json.dumps({
        "status": status, "why": why,
        "note": "evaluated through the real runtime",
        "fixture": FIXTURE,
        "before": before, "after": after,
        "temporal_before": t_before, "temporal_after": t_after,
        "dims": f"{built.width}x{built.height}",
        "format": str(built.format.name),
        "frames": built.num_frames,
    }))
except Exception as e:
    print(json.dumps({"status": "FAIL", "why": str(e)[:240]}))
sys.exit(0)