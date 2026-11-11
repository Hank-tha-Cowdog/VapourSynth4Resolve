#!/bin/bash
# Template verification harness: runs each FilterLibrary entry's template
# body (wrapped exactly as the composer wraps script steps) against the
# REAL VapourSynth runtime + installed plugin set. Prints PASS/FAIL per
# entry with the actual runtime error on failure. POSIX-ish bash 3 (macOS).
set -u
PY=/opt/homebrew/opt/python@3.14/bin/python3.14
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PYTHONPATH="$ROOT/vendor/vapoursynth/install-R75/lib/python3.14/site-packages"
export VAPOURSYNTH_EXTRA_PLUGIN_PATH="$HOME/Library/Application Support/VapourSynth/Plugins"
SRC="$ROOT/tests/fixtures/mini.mov"
[ -f "$SRC" ] || { echo "FAIL: fixture $SRC missing (generate: scripts/make_test_media.sh)"; exit 1; }

run_body() {
    "$PY" - "$SRC" <<EOF 2>&1
import sys
sys.path.insert(0, "$HOME/Library/Application Support/VapourSynth-OFX/vs-python")
import vapoursynth as vs, havsfunc as haf, mvsfunc as mvf
try:
    import vsmlrt
except ImportError:
    vsmlrt = None  # RIFE checks fail honestly when the adapter is absent.
core = vs.core
src = core.lsmas.LWLibavSource(sys.argv[1])
def to_rgb(c, depth=32, matrix='709'): return mvf.ToRGB(c, depth=depth, matrix=matrix)
def to_yuv(c, css='420', depth=16, matrix='709'): return mvf.ToYUV(c, css=css, depth=depth, matrix=matrix)
clip = mvf.ToYUV(src, css='420', depth=16, matrix='709')
g = dict(clip=clip, core=core, to_rgb=to_rgb, to_yuv=to_yuv, mvf=mvf, havs=haf)
exec("""$1""")
EOF
}

check() {
    local name="$1" body="$2" out
    if out=$(run_body "$body"); then
        echo "PASS  $name"
    else
        echo "FAIL  $name"
        echo "$out" | grep -E "Error|error" | head -2 | sed 's/^/        /'
    fi
}

check qtgmc          "clip = haf.QTGMC(clip, Preset='Slower', TFF=True, FPSDivisor=2)"
check bm3dmetal      "clip = to_rgb(clip, depth=32)
clip = core.bm3dmetal.BM3D(clip, sigma=[3.0, 3.0, 3.0], radius=0)
clip = to_yuv(clip, css='420', depth=16)"
check deband         "clip = core.neo_f3kdb.Deband(clip, range=15, y=64, cb=64, cr=64, grainy=0, grainc=0)"
check tivtc          "clip = core.tivtc.TFM(clip, order=0)
clip = core.tivtc.TDecimate(clip)"
check ttmpsm         "clip = core.ttmpsm.TTempSmooth(clip, maxr=3, thresh=[6, 6, 6])"
check deblock        "clip = core.deblock.Deblock(clip, quant=24)"
check edgefixer      "clip = core.edgefixer.Continuity(clip, left=0, top=2, right=0, bottom=0, radius=3)"
check blockfps       "sup = core.mv.Super(clip, pel=2)
bw = core.mv.Analyse(sup, isb=True, delta=1)
fw = core.mv.Analyse(sup, isb=False, delta=1)
clip = core.mv.BlockFPS(clip, sup, bw, fw, num=24, den=1, mode=3)"
check nnedi3-upscale "clip = core.nnedi3.nnedi3(clip, field=0, dh=True)
clip = core.std.Transpose(clip)
clip = core.nnedi3.nnedi3(clip, field=0, dh=True)
clip = core.std.Transpose(clip)"
check rife           "clip = to_rgb(clip, depth=32)
_pad_w = (-clip.width) % 32
_pad_h = (-clip.height) % 32
clip = core.std.AddBorders(clip, left=_pad_w // 2, right=_pad_w - _pad_w // 2, top=_pad_h // 2, bottom=_pad_h - _pad_h // 2)
clip = vsmlrt.RIFE(clip, multi=2, model=vsmlrt.RIFEModel.v4_4, backend=vsmlrt.Backend.ORT_CPU())
clip = core.std.Crop(clip, left=_pad_w // 2, right=_pad_w - _pad_w // 2, top=_pad_h // 2, bottom=_pad_h - _pad_h // 2) if (_pad_w or _pad_h) else clip"
check fft3d          "clip = core.fft3dfilter.FFT3DFilter(clip, sigma=2.0, bt=3, bw=32, bh=32, ow=16, oh=16)"
check cas            "clip = core.cas.CAS(clip, sharpness=0.4)"
check cas-missing    "clip = core.cas.CAS(clip)"