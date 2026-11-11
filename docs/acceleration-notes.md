# Measured acceleration notes — this machine, this material

Recorded Oct 26, `scripts/benchmark_denoise.py` (committed). Material: the
user's real ProRes 422 HQ 1440×1080 25p source (frames 10/60/110), VS R75,
Apple Silicon, exact FilterLibrary template shapes (to_rgb float32, sigma 3.0).

| Stage | Backend (actually used) | ms/frame | Notes |
|---|---|---|---|
| decode + ToRGB | CPU (lsmas/zimg) | ~6 | the fixed overhead every path pays |
| BM3D spatial, sigma 3.0 | **bm3dmetal — Metal GPU** | ~100 (min 83) | the bundled Metal build; real GPU dispatch |
| BM3D spatial, sigma 3.0 | **bm3dcpu — CPU reference** | ~352 | |

- **BM3D Metal ≈ 3.5× faster than CPU** on this material at 1080p; that is a
  measured result, not an inference from the name or from "Apple Silicon".
- Decoding and format conversion are CPU (lsmas/zimg). A Metal *label* on one
  filter does not accelerate any other stage.
- NNEDI3 upscaling is **CPU-only** in the current bundle (no Metal/CoreML
  implementation bundled). A GPU upscale comparison remains future work — do
  not describe upscaling as GPU-accelerated.
- No Neural Engine (CoreML/ANE) path exists in the bundle today; vs-mlrt's
  `ort.Model` generic ONNX entry is present (CPU/CoreML execution providers
  would need the model + runtime qualification — see model manager work).
- Startup cost not included above: the first frame of a fresh BM3D Metal
  graph pays one-time initialization (~0.5–1 s), amortized across playback.

## Honest claims guide

- "BM3D Metal is GPU-accelerated" — SUPPORTED by these measurements.
- "The chain is GPU-accelerated" — NOT supported; decode/convert/resize/
  most filters are CPU.
- "Upscaling uses the GPU" — NOT supported; NNEDI3 is CPU here.