#!/bin/bash
# Self-containment verification for the STAGED portable bundle (gate 2
# evidence). Everything runs under env -i — zero developer PATH/PYTHONPATH/
# user-site assumptions; the bundle must resolve entirely through internal
# paths. Read-only: never mutates the bundle, the machine env, or Resolve.
set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
BUNDLE="$REPO/build-portable/portable/VapourSynth.ofx.bundle"
CONTENTS="$BUNDLE/Contents"
[ -d "$CONTENTS" ] || { echo "no staged bundle — build portable_bundle first"; exit 1; }

echo "── 1. static audit (fail-closed otool/text sweep) ──"
bash "$REPO/platform/macos/repair_portable_bundle.sh" --audit-only "$CONTENTS" || exit 1

PY="$CONTENTS/Frameworks/Python.framework/Versions/Current/bin/python3"
CLEAN=(env -i HOME=/tmp/nowhere PATH=/usr/bin:/bin)
echo "── 2. interpreter + stdlib deps resolve bundle-internally ──"
OUT=$("${CLEAN[@]}" "$PY" -c "import sqlite3, hashlib, ssl, lzma, zlib, decimal, bz2; print('ok')" 2>&1)
echo "$OUT"
case "$OUT" in ok) ;; *) echo "FAIL: stdlib extensions"; exit 1;; esac

echo "── 3. import vapoursynth resolves from the BUNDLE (not dev/user) ──"
OUT=$("${CLEAN[@]}" "$PY" -c "import vapoursynth as vs; print(vs.__file__)" 2>&1)
echo "$OUT"
case "$OUT" in
  *"$CONTENTS/Resources/vs-python/"*) ;;
  *) echo "FAIL: vapoursynth resolved outside the bundle"; exit 1;;
esac

echo "── 4. full plugin set autoloads from the bundle ──"
OUT=$("${CLEAN[@]}" VAPOURSYNTH_EXTRA_PLUGIN_PATH="$CONTENTS/Plugins" "$PY" -c "
import vapoursynth as vs
ns = {p.namespace for p in vs.core.plugins()}
want = ['fmtc','mv','deblock','lsmas','resize2','nnedi3','std','cas','bm3d','ort','fh','misc','fpng']
missing = [n for n in want if n not in ns]
print(len(ns), 'namespaces; missing:', missing)
for f in missing: print('MISSING', f)
import sys; sys.exit(1 if missing else 0)" 2>&1)
echo "$OUT"
case "$OUT" in *"missing: []"*) ;; *) echo "FAIL: plugin set incomplete"; exit 1;; esac

echo "── 5. companion render script discovers bundle plugins with NO env ──"
OUT=$("${CLEAN[@]}" VSRES_VS_PYTHON="$CONTENTS/Resources/vs-python" "$PY" -c "
import sys, os
sys.path.insert(0, '$REPO/scripts')
import render_preview_frame as m
m._resolve_runtime_paths()
resolved = os.environ.get('VAPOURSYNTH_EXTRA_PLUGIN_PATH','')
print('resolved:', resolved)
sys.exit(0 if '$CONTENTS/Plugins' == resolved else 1)" 2>&1)
echo "$OUT"
case "$OUT" in *"resolved: $CONTENTS/Plugins"*) ;; *) echo "FAIL: render script plugin discovery"; exit 1;; esac

echo "── 6. deployment-target report (records the honest floor) ──"
for f in "$CONTENTS/MacOS/VapourSynth.ofx" "$CONTENTS/Frameworks/Python.framework/Versions/"*/Python "$CONTENTS/Plugins/libfmtconv.dylib" "$CONTENTS/Plugins/libmvtools.dylib"; do
    [ -f "$f" ] || continue
    m="$(otool -l "$f" 2>/dev/null | grep -A5 LC_BUILD_VERSION | grep -oE 'minos [0-9.]+' | awk '{print $2}' | head -1)"
    echo "  $(basename "$f"): minos ${m:-unknown}"
done
echo "ALL PASS"