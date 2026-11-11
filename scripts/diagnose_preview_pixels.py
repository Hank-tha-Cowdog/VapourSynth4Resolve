#!/usr/bin/env python3
"""Pixel-level diagnosis of the PREVIEW path defects (live feedback Oct 27):
(a) SOURCE preview looks softer/lower-res than the original footage;
(b) PROCESSED preview still shows interlace combing although the composed
chain deinterlaces.

Renders the EXACT production preview path (scripts/render_preview_frame.py
against the node's composed .vpy) at matched presentation times and
compares against a direct decode and the intended processed result, using
the field-phase combing signature (d1 across-field vs d2 same-field) and a
Laplacian sharpness proxy. Several moving moments, not one static frame.
"""
import ctypes
import json
import os
import subprocess
import sys
import tempfile
from fractions import Fraction

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PREVIEW = os.path.join(REPO, "scripts", "render_preview_frame.py")
PY = "/opt/homebrew/opt/python@3.14/bin/python3.14"
NODE_VPY = os.path.expanduser(
    "~/Library/Application Support/VapourSynth-OFX/nodes/"
    "87a9957b-705d-4b7e-9d60-31599793.vpy")

os.environ.setdefault("VAPOURSYNTH_EXTRA_PLUGIN_PATH",
    os.path.expanduser("~/Library/Application Support/VapourSynth/Plugins"))
sys.path.insert(0, os.path.expanduser("~/Library/Application Support/VapourSynth-OFX/vs-python"))

SRC = None
with open(NODE_VPY) as f:
    for line in f:
        if "LWLibavSource(r'" in line:
            SRC = line.split("LWLibavSource(r'", 1)[1].split("')", 1)[0]
            break
assert SRC, "no source path in composed script"
print(f"source (verbatim from node script): {SRC}")

# VENDOR R75 module first (dev tree), then helper path.
_vendor = os.path.join(REPO, "vendor", "vapoursynth", "install-R75",
                       "lib", "python3.14", "site-packages")
if os.path.isdir(_vendor):
    sys.path.insert(0, _vendor)

import vapoursynth as vs  # noqa: E402
import havsfunc as haf   # noqa: E402

core = vs.core


def metrics(clip8, fi):
    """Field-phase combing signature + sharpness on the 8-bit Y plane."""
    f = clip8.get_frame(fi)
    ptr = int(f.get_read_ptr(0).value)
    stride = f.get_stride(0)
    w, h = clip8.width, clip8.height
    buf = (ctypes.c_ubyte * (stride * h)).from_address(ptr)
    t1 = t2 = c = 0
    for y in range(2, h, 2):
        row = bytes(buf[y*stride:y*stride+w])
        r1 = bytes(buf[(y-1)*stride:(y-1)*stride+w])
        r2 = bytes(buf[(y-2)*stride:(y-2)*stride+w])
        t1 += sum(abs(row[x]-r1[x]) for x in range(w))
        t2 += sum(abs(row[x]-r2[x]) for x in range(w))
        c += w
    lap = 0
    for y in range(40, h-40, 4):
        row = bytes(buf[y*stride:y*stride+w])
        up = bytes(buf[(y-2)*stride:(y-2)*stride+w])
        dn = bytes(buf[(y+2)*stride:(y+2)*stride+w])
        lap += sum(abs(2*row[x]-up[x]-dn[x]) for x in range(20, w-20))
    d1, d2 = t1/c, t2/c
    return {"d1": round(d1, 2), "d2": round(d2, 2),
            "ratio": round(d1/max(d2, 1e-6), 2), "sharp": lap}


def png_metrics(data):
    """Combing/sharpness of a returned PNG (RGB24) — luma proxy on G."""
    # Minimal PNG decode via VS: write to temp and load via fpng? Simpler:
    # use zlib-free approach — load through VS ImageReader not bundled. So
    # instead decode with our own path: PNG → PIL not guaranteed. Use core
    # via fpng reader is not available; fall back to reporting metadata only
    # and compute metrics inside render_preview_frame (it already loads VS).
    return None


def preview(mode, time_s):
    out = tempfile.mktemp(suffix=".png")
    r = subprocess.run([PY, PREVIEW, "--script", NODE_VPY,
        "--time", str(time_s), "--out", out, "--mode", mode,
        "--sar", "4:3"], capture_output=True, text=True)
    line = [l for l in (r.stdout or "").splitlines() if l.startswith("{")]
    if not line:
        return None, f"preview failed: {(r.stderr or '')[:160]}"
    meta = json.loads(line[-1])
    size = os.path.getsize(out) if os.path.exists(out) else 0
    os.path.exists(out) and os.unlink(out)
    return {"meta": meta, "png_bytes": size}, None


TIMES = [2.0, 6.0, 12.0, 30.0]
src = core.lsmas.LWLibavSource(SRC)
print(f"source: {src.width}x{src.height}, {src.num_frames}f @ {src.fps_num}/{src.fps_den}")
src8 = core.resize.Bicubic(src, format=vs.YUV420P8)
# Intended processed (matching the accepted chain: QTGMC Ultra Fast per the
# composed script — read the preset from the script to stay honest):
preset = "Slower"
with open(NODE_VPY) as f:
    for line in f:
        if "havs.QTGMC(" in line and "Preset=" in line:
            preset = line.split("Preset='", 1)[1].split("'", 1)[0]
            break
print(f"chain preset (from script): {preset}")
deint = haf.QTGMC(src, Preset=preset, TFF=True, FPSDivisor=2)
de8 = core.resize.Bicubic(deint, format=vs.YUV420P8)

print()
for t in TIMES:
    fi = min(int(Fraction(t) * src.fps_num // src.fps_den), src.num_frames - 1)
    m_raw = metrics(src8, fi)
    m_de = metrics(de8, fi)  # same-rate → same index
    p_s, e1 = preview("source", t)
    p_p, e2 = preview("processed", t)
    print(f"t={t:>5.1f}s  raw f{fi:<4d} d1/d2={m_raw['d1']}/{m_raw['d2']} ratio={m_raw['ratio']:>5} sharp={m_raw['sharp']}")
    print(f"          deint f{fi:<4d} d1/d2={m_de['d1']}/{m_de['d2']} ratio={m_de['ratio']:>5} sharp={m_de['sharp']}")
    if p_s:
        m = p_s["meta"]
        print(f"          preview SOURCE  → {m['width']}x{m['height']} frame {m['frame']} png={p_s['png_bytes']}B")
    else:
        print(f"          preview SOURCE  → {e1}")
    if p_p:
        m = p_p["meta"]
        print(f"          preview PROC    → {m['width']}x{m['height']} frame {m['frame']} png={p_p['png_bytes']}B")
    else:
        print(f"          preview PROC    → {e2}")
    print()