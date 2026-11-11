#!/usr/bin/env python3
"""Verify RIFE neural interpolation end-to-end: adapter import, model load,
real inference through the same ONNX backend the chain uses (core.ort).

Exit 0 prints a JSON verdict; non-zero = specific missing component.
Levels: adapter available -> backend registered -> load verified ->
inference verified.
"""
import json
import os
import sys

# Plugin path BEFORE the vapoursynth import: the vs-mlrt ONNX backend dylib
# (libvsort.dylib) must be on VAPOURSYNTH_EXTRA_PLUGIN_PATH at createCore
# time for core.ort to register — setting it after import does nothing.
os.environ["VAPOURSYNTH_EXTRA_PLUGIN_PATH"] = os.path.join(
    os.environ.get("VAPOURSYNTH_EXTRA_PLUGIN_PATH", ""),
    os.path.expanduser("~/Library/Application Support/VapourSynth/Plugins")) \
    if os.environ.get("VAPOURSYNTH_EXTRA_PLUGIN_PATH") else \
    os.path.expanduser("~/Library/Application Support/VapourSynth/Plugins")
sys.path.insert(0, os.path.expanduser("~/Library/Application Support/VapourSynth-OFX/vs-python"))

MODELS = os.path.expanduser(
    "~/Library/Application Support/VapourSynth-OFX/models/vsmlrt-models-v15.16/models/rife")


def emit(ok, level, **extra):
    print(json.dumps({"ok": ok, "level": level, **extra}))
    sys.exit(0 if ok else 1)


try:
    import vsmlrt
except Exception as e:
    emit(False, "adapter", error=f"vsmlrt adapter unavailable: {e}")

try:
    import vapoursynth as vs
    core = vs.core
except Exception as e:
    emit(False, "backend", error=f"vapoursynth unavailable: {e}")

if not hasattr(core, "ort"):
    emit(False, "backend", error="core.ort (vs-mlrt ONNX backend dylib) not registered")

model = os.path.join(MODELS, "rife_v4.4.onnx")
if not os.path.exists(model):
    emit(False, "weights", error=f"model weights missing: {model}")

# Load + run: two tiny RGBS clips through the adapter's RIFE entry point.
clip = core.std.BlankClip(format=vs.RGBS, width=64, height=64, length=4,
                          color=[0.2, 0.4, 0.6])
try:
    rife = vsmlrt.RIFE(clip, multi=2,
                       model=vsmlrt.RIFEModel.v4_4,
                       backend=vsmlrt.Backend.ORT_CPU())
except Exception as e:
    emit(False, "load", error=f"RIFE model load failed: {str(e)[:300]}")

try:
    f = rife.get_frame(2)
    emit(True, "inference", model=model, frames=rife.num_frames,
         backend="vsmlrt ORT.CPU", width=rife.width, height=rife.height)
except Exception as e:
    emit(False, "inference", error=f"RIFE inference failed: {str(e)[:300]}")


if __name__ == "__main__":
    main()