#!/usr/bin/env python3
"""Scoped BM3D Metal-vs-CPU measurement (representative material).

Measures what the chain actually pays: per-frame evaluate+render time on a
real 1080p source frame through the EXACT filter calls the FilterLibrary
templates emit. Reports the backend actually used (bm3dmetal = the bundled
Metal build; bm3dcpu = the CPU reference), wall-clock per frame, and warns
that a GPU label alone proves nothing — this file prints measured numbers.

Usage: benchmark_denoise.py [source.mov]
"""
import os
import sys
import time

os.environ.setdefault("VAPOURSYNTH_EXTRA_PLUGIN_PATH",
    os.path.expanduser("~/Library/Application Support/VapourSynth/Plugins"))
import sys as _sys
_vs_python = os.path.expanduser("~/Library/Application Support/VapourSynth-OFX/vs-python")
if os.path.isdir(_vs_python) and _vs_python not in _sys.path:
    _sys.path.insert(0, _vs_python)

SOURCE = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser(
    "~/Library/Application Support/VapourSynth-OFX/last-config.json")

import json
if SOURCE.endswith(".json"):
    cfg = json.load(open(SOURCE))
    SOURCE = cfg["clipMetadata"]["source"]["filePath"]

import vapoursynth as vs
core = vs.core
print(f"VS core: {vs.core_version() if hasattr(vs, 'core_version') else 'unknown'}")
print(f"source: {SOURCE}")

src = core.lsmas.LWLibavSource(SOURCE)
print(f"source dims: {src.width}x{src.height}, frames: {src.num_frames}")

def bench(name, build, frames=(10, 60, 110)):
    clip = build()
    times = []
    for f in frames:
        t0 = time.perf_counter()
        clip.get_frame(f)
        times.append(time.perf_counter() - t0)
    avg = sum(times) / len(times)
    print(f"{name}: first-ish avg {avg*1000:.0f} ms/frame over {len(times)} sampled frames "
          f"(min {min(times)*1000:.0f}, max {max(times)*1000:.0f})")
    return avg

# The EXACT template shapes from the FilterLibrary (BM3D Metal entry):
# processed via to_rgb float, sigma 3.0 spatial (radius=0).
def metal():
    clip = src
    try:
        import vsres_conv as mvf
    except ImportError:  # legacy bundles without the replacement layer
        import mvsfunc as mvf
    clip = mvf.ToRGB(clip, depth=32)
    clip = core.bm3dmetal.BM3D(clip, sigma=[3.0, 3.0, 3.0], radius=0)
    return clip

def cpu():
    clip = src
    try:
        import vsres_conv as mvf
    except ImportError:  # legacy bundles without the replacement layer
        import mvsfunc as mvf
    clip = mvf.ToRGB(clip, depth=32)
    clip = core.bm3dcpu.BM3D(clip, sigma=[3.0, 3.0, 3.0], radius=0)
    return clip

try:
    bench("bm3dmetal (Metal GPU path)", metal)
except Exception as e:
    print(f"bm3dmetal FAILED: {e}")
try:
    bench("bm3dcpu (CPU reference)", cpu)
except Exception as e:
    print(f"bm3dcpu FAILED: {e}")

# Baseline: the transfer/decode cost without denoise, for honest
# attribution (decoding + ToRGB vs the denoise increment).
def baseline():
    try:
        import vsres_conv as mvf
    except ImportError:  # legacy bundles without the replacement layer
        import mvsfunc as mvf
    return mvf.ToRGB(src, depth=32)
bench("baseline (decode + ToRGB only)", baseline)
print("NOTE: per-frame times include decode+convert; the denoise increment is")
print("the delta vs baseline. A 'Metal' name proves nothing alone — these are")
print("measured numbers on this machine and material.")