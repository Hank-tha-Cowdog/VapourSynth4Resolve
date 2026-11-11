#!/bin/bash
# VSScript-init + import regression (the 2026-10-30 render-path blocker):
# the portable bundle's relocated libvsscript must (1) fail init without a
# toml entry with the EXACT live Resolve error text, (2) initialize AND
# evaluate a real script (import vapoursynth — the SECOND live failure)
# with the self-registered toml entry + the staged bundle .pth.
#
# Isolated: temp HOME for the toml; the .pth lives inside the STAGED bundle
# (../../Resources/vs-python relative). Never touches the real config or a
# running Resolve.
set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
BUNDLE="$REPO/build-portable/portable/VapourSynth.ofx.bundle"
LIB="$BUNDLE/Contents/Libraries/libvsscript.dylib"
FW="$BUNDLE/Contents/Frameworks/Python.framework/Versions"
PYVER="$(ls "$FW" | grep -E '^[0-9]' | head -1)"
[ -n "$PYVER" ] || { echo "no bundle python framework"; exit 1; }
PYLIB="$FW/$PYVER/Python"

TMP="$(mktemp -d /tmp/vsres-vssinit.XXXX)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/home/.config/vapoursynth"

cat > "$TMP/probe.cc" <<'EOF'
#include <dlfcn.h>
#include <cstdio>
#include <string>
typedef void* (*GetVSScriptAPI_t)(int);
typedef const char* (*GetLastError_t)(void);
struct VSScriptAPI {
    int (*getAPIVersion)(void);
    const void* (*getVSAPI)(int);
    void* (*createScript)(void*);
    void* (*getCore)(void*);
    int (*evaluateBuffer)(void*, const char*, const char*);
    int (*evaluateFile)(void*, const char*);
    const char* (*getError)(void*);
    int (*getExitCode)(void*);
    int (*getVariable)(void*, const char*, void*);
    int (*setVariables)(void*, const void*);
    void* (*getOutputNode)(void*, int);
    void* (*getOutputAlphaNode)(void*, int);
    int (*getAltOutputMode)(void*, int);
    void (*freeScript)(void*);
};
int main(int argc, char** argv) {
    void* py = dlopen(argv[2], RTLD_NOW | RTLD_GLOBAL);
    if (!py) { printf("dlopen python FAILED\n"); return 2; }
    auto isi = (int (*)())dlsym(py, "Py_IsInitialized");
    auto iex = (void (*)(int))dlsym(py, "Py_InitializeEx");
    if (isi && !isi() && iex) iex(0);
    void* h = dlopen(argv[1], RTLD_NOW | RTLD_GLOBAL);
    if (!h) { printf("dlopen vsscript FAILED\n"); return 2; }
    auto getApi = (GetVSScriptAPI_t)dlsym(h, "getVSScriptAPI");
    auto lastErr = (GetLastError_t)dlsym(h, "getVSScriptAPILastError");
    auto api = (VSScriptAPI*)getApi(0x40003);
    if (!api) {
        const char* e = lastErr ? lastErr() : nullptr;
        printf("INIT FAILED: %s\n", e ? e : "(null)");
        return 1;
    }
    // The live SECOND failure ("Failed to import the VapourSynth Python
    // module") only surfaces at evaluation — prove the full path here.
    void* s = api->createScript(nullptr);
    if (!s) { printf("createScript FAILED\n"); return 1; }
    const char* script =
        "import vapoursynth as vs\n"
        "core = vs.core\n"
        "clip = core.std.BlankClip(width=64, height=48, length=10, format=vs.GRAY16)\n"
        "clip.set_output()\n";
    const int rc = api->evaluateBuffer(s, script, "test.vpy");
    if (rc != 0) { printf("EVAL FAILED: %s\n", api->getError(s)); api->freeScript(s); return 1; }
    api->freeScript(s);
    printf("INIT+EVAL OK\n");
    return 0;
}
EOF
clang++ -std=c++17 -o "$TMP/probe" "$TMP/probe.cc" -ldl || exit 1

echo "── 1. WITHOUT toml entry (expect the live Resolve failure text) ──"
# env -i: the probe must succeed on BUNDLE content alone — no machine
# PATH/PYTHONPATH/user-site can mask a broken bundle.
OUT1="$(env -i HOME="$TMP/home" PATH=/usr/bin:/bin "$TMP/probe" "$LIB" "$PYLIB")"
echo "$OUT1"
case "$OUT1" in
  *"couldn't be determined"*) echo "PASS (exact live failure reproduced)";;
  *) echo "FAIL: expected the path-determination error without an entry"; exit 1;;
esac

echo "── 2. WITH the self-registered toml entry + staged bundle .pth ──"
printf '"%s" = ["%s/bin/python3.14","%s/Python"]\n' "$LIB" "$FW/$PYVER" "$FW/$PYVER" \
  >> "$TMP/home/.config/vapoursynth/vapoursynth.toml"
OUT2="$(env -i HOME="$TMP/home" PATH=/usr/bin:/bin "$TMP/probe" "$LIB" "$PYLIB")"
echo "$OUT2"
case "$OUT2" in
  *"INIT+EVAL OK"*) echo "PASS (init + import vapoursynth + graph build)";;
  *"Failed to import"*) echo "FAIL: bundle python cannot import vapoursynth (missing .pth?)"; exit 1;;
  *) echo "FAIL: unexpected init/eval failure"; exit 1;;
esac
echo "ALL PASS"