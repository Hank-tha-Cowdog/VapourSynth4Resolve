#!/usr/bin/env python3
"""VS4/arm64 port for removedirtvs (R82 migration, 2026-11-13).

API conversions across shared.h + 5 .cpp files, sse2neon shim for the SSE2
kernels, init2/registration modernisation.
"""
from pathlib import Path

def load(f):
    return Path(f).read_text()

def save(f, t):
    Path(f).write_text(t)
    print(f"saved {f}")

def rep(t, old, new, n=1, label=""):
    c = t.count(old)
    assert c == n, f"{label}: {c} (want {n}): {old[:60]!r}"
    return t.replace(old, new)

# ── shared.h ──
t = load("shared.h")
t = rep(t, '#include "VapourSynth.h"\n#include "VSHelper.h"',
        '#include <VapourSynth4.h>\n#include <VSHelper4.h>', 1, "shared.h includes")
save("shared.h", t)

# ── guard blocks (RemoveDirt.cpp + shared.cpp) ──
SHIM = '''#ifdef VS_TARGET_CPU_X86
#if defined(__aarch64__) || defined(_M_ARM64)
#include "sse2neon.h" /* arm64: SSE2 intrinsics over NEON (VSRes R82 port, 2026-11-13) */
#else
#include <emmintrin.h>
#endif
#else
# error "Please specify VS_TARGET_CPU_X86 to build"
#endif'''
OLD_GUARD = '''#ifdef VS_TARGET_CPU_X86
#include <emmintrin.h>
#else
# error "Please specify VS_TARGET_CPU_X86 to build"
#endif'''
for f in ("RemoveDirt.cpp", "shared.cpp"):
    t = load(f)
    t = rep(t, OLD_GUARD, SHIM, 1, f"{f} guard")
    save(f, t)

# ── init drops + creates (3 filter files) ──
INITS = {
 "SCSelect.cpp": '''static void VS_CC SCSelectInit(VSMap *in, VSMap *out, void **instanceData, VSNode *node, VSCore *core, const VSAPI *vsapi)
{
    SCSelectData *d = (SCSelectData *) *instanceData;
    vsapi->setVideoInfo(d->vi, 1, node);
}

''',
 "RestoreMotionBlocks.cpp": '''static void VS_CC RestoreMotionBlocksInit(VSMap *in, VSMap *out, void **instanceData, VSNode *node, VSCore *core, const VSAPI *vsapi)
{
    RestoreMotionBlocksData *d = (RestoreMotionBlocksData *) *instanceData;
    vsapi->setVideoInfo(d->vi, 1, node);
}

''',
 "DupBlocks.cpp": '''static void VS_CC DupBlocksInit(VSMap *in, VSMap *out, void **instanceData, VSNode *node, VSCore *core, const VSAPI *vsapi)
{
    DupBlocksData *d = (DupBlocksData *) *instanceData;
    vsapi->setVideoInfo(d->vi, 1, node);
}

''',
}
for f, inittext in INITS.items():
    t = load(f)
    t = rep(t, inittext, "", 1, f"{f} drop init")
    save(f, t)

t = load("SCSelect.cpp")
t = rep(t, '    vsapi->createFilter(in, out, "SCSelect", SCSelectInit, SCSelectGetFrame, SCSelectFree, fmParallel, 0, data, core);',
'''    {
        VSFilterDependency deps[] = { { d.input, rpGeneral }, { d.sceneBegin, rpGeneral }, { d.sceneEnd, rpGeneral }, { d.globalMotion, rpGeneral } };
        vsapi->createVideoFilter(out, "SCSelect", d.vi, SCSelectGetFrame, SCSelectFree, fmParallel, deps, 4, data, core);
    }''', 1, "SCSelect create")
save("SCSelect.cpp", t)

t = load("RestoreMotionBlocks.cpp")
t = rep(t, '    vsapi->createFilter(in, out, "RestoreMotionBlocks", RestoreMotionBlocksInit, RestoreMotionBlocksGetFrame, RestoreMotionBlocksFree, fmParallel, 0, data, core);',
'''    {
        std::vector<VSFilterDependency> deps{ { d.input, rpGeneral }, { d.restore, rpGeneral }, { d.before, rpGeneral }, { d.after, rpGeneral } };
        if (d.alternative)
            deps.push_back({ d.alternative, rpGeneral });
        vsapi->createVideoFilter(out, "RestoreMotionBlocks", d.vi, RestoreMotionBlocksGetFrame, RestoreMotionBlocksFree, fmParallel, deps.data(), static_cast<int>(deps.size()), data, core);
    }''', 1, "RMB create")
save("RestoreMotionBlocks.cpp", t)

t = load("DupBlocks.cpp")
t = rep(t, '    vsapi->createFilter(in, out, "DupBlocks", DupBlocksInit, DupBlocksGetFrame, DupBlocksFree, fmParallel, 0, data, core);',
'''    {
        VSFilterDependency deps[] = { { d.input, rpGeneral } };
        vsapi->createVideoFilter(out, "DupBlocks", d.vi, DupBlocksGetFrame, DupBlocksFree, fmParallel, deps, 1, data, core);
    }''', 1, "DupBlocks create")
save("DupBlocks.cpp", t)

# ── getFrame sigs + instanceData derefs ──
for f, name in (("SCSelect.cpp", "SCSelect"), ("RestoreMotionBlocks.cpp", "RestoreMotionBlocks"), ("DupBlocks.cpp", "DupBlocks")):
    t = load(f)
    t = rep(t, f"void **instanceData, void **frameData,", f"void *instanceData, void **frameData,", 1, f"{f} getframe sig")
    t = rep(t, f"{name}Data *d = ({name}Data *) *instanceData;", f"{name}Data *d = ({name}Data *) instanceData;", 1, f"{f} deref")
    save(f, t)

# ── shared.cpp: init2 + registrations ──
t = load("shared.cpp")
t = rep(t, '''VS_EXTERNAL_API(void) VapourSynthPluginInit(VSConfigPlugin configFunc, VSRegisterFunction registerFunc, VSPlugin *plugin)
{
    configFunc("com.fakeurl.removedirtvs", "rdvs", "RemoveDirt VapourSynth Port", VAPOURSYNTH_API_VERSION, 1, plugin);''',
'''VS_EXTERNAL_API(void) VapourSynthPluginInit2(VSPlugin *plugin, const VSPLUGINAPI *vspapi)
{
    vspapi->configPlugin("com.fakeurl.removedirtvs", "rdvs", "RemoveDirt VapourSynth Port", VS_MAKE_VERSION(4, 0), VAPOURSYNTH_API_VERSION, 0, plugin);''', 1, "shared.cpp init2")
t = rep(t, 'registerFunc("SCSelect", "input:clip;', 'vspapi->registerFunction("SCSelect", "input:vnode;', 1, "reg SCSelect")
t = rep(t, '"dfactor:float:opt;", SCSelectCreate, 0, plugin);', '"dfactor:float:opt;", "clip:vnode;", SCSelectCreate, 0, plugin);', 1, "ret SCSelect")
t = rep(t, 'registerFunc("RestoreMotionBlocks", "input:clip;', 'vspapi->registerFunction("RestoreMotionBlocks", "input:vnode;', 1, "reg RMB")
t = rep(t, '"grey:int:opt;", RestoreMotionBlocksCreate, 0, plugin);', '"grey:int:opt;", "clip:vnode;", RestoreMotionBlocksCreate, 0, plugin);', 1, "ret RMB")
t = rep(t, 'registerFunc("DupBlocks", "input:clip;', 'vspapi->registerFunction("DupBlocks", "input:vnode;', 1, "reg Dup")
t = rep(t, '"grey:int:opt;", DupBlocksCreate, 0, plugin);', '"grey:int:opt;", "clip:vnode;", DupBlocksCreate, 0, plugin);', 1, "ret Dup")
# remaining clip args (restore/neighbour/neighbour2/alternative/scene clips)
t = t.replace('"restore:clip;"', '"restore:vnode;"')
t = t.replace('"neighbour:clip:opt;"', '"neighbour:vnode:opt;"')
t = t.replace('"neighbour2:clip:opt;"', '"neighbour2:vnode:opt;"')
t = t.replace('"alternative:clip:opt;"', '"alternative:vnode:opt;"')
t = t.replace('"sceneBegin:clip;"', '"sceneBegin:vnode;"')
t = t.replace('"sceneEnd:clip;"', '"sceneEnd:vnode;"')
t = t.replace('"globalMotion:clip;"', '"globalMotion:vnode;"')
save("shared.cpp", t)

# ── bulk renames across all cpp ──
for f in ("SCSelect.cpp", "RestoreMotionBlocks.cpp", "DupBlocks.cpp", "RemoveDirt.cpp", "shared.cpp"):
    t = load(f)
    for old, new in [
        ("VSNodeRef", "VSNode"), ("VSFrameRef", "VSFrame"),
        ("vsapi->propGet", "vsapi->mapGet"),
        ("vsapi->setError(", "vsapi->mapSetError("),
        ("vsapi->getError(", "vsapi->mapGetError("),
        ("propNumElements", "mapNumElements"),
        ("getFramePropsRO", "getFramePropertiesRO"),
        ("getFramePropsRW", "getFramePropertiesRW"),
        ("vi->format->", "vi->format."),
        ("cmGray", "cfGray"), ("cmYUV", "cfYUV"), ("cmRGB", "cfRGB"),
        ("int64ToIntS(", "vsh::int64ToIntS("),
        ("isConstantFormat(", "vsh::isConstantVideoFormat("),
        ("vs_aligned_malloc", "vsh::vsh_aligned_malloc"),
        ("vs_aligned_free", "vsh::vsh_aligned_free"),
    ]:
        c = t.count(old)
        if c:
            t = t.replace(old, new)
            print(f"  {f}: {old} x{c}")
    save(f, t)

print("DONE")
