#!/usr/bin/env python3
"""VS4/arm64 port patch for VapourSynth-WNNM (R82 migration, 2026-11-13)."""
from pathlib import Path

p = Path("source/wnnm.cpp")
t = p.read_text()
done = []

def rep(old, new, n=1, label=""):
    global t
    c = t.count(old)
    assert c == n, f"{label}: {c} (want {n}): {old[:65]!r}"
    t = t.replace(old, new)
    done.append(label)

rep("""#elif defined(__aarch64__) || defined(_M_ARM64)
#include <armpl.h>

#ifdef __ARM_FEATURE_SVE
#include <arm_sve.h>
#endif // __ARM_FEATURE_SVE""",
"""#elif defined(__aarch64__) || defined(_M_ARM64)
#if defined(__APPLE__)
/* macOS arm64 port (VSRes R82 migration, 2026-11-13): use the system
 * Accelerate framework — sgemm_/sgesdd_ are provided natively. */
extern "C" void sgemm_(const char * transa, const char * transb, const int * m, const int * n, const int * k, const float * alpha, const float * a, const int * lda, const float * b, const int * ldb, const float * beta, float * c, const int * ldc);
extern "C" void sgesdd_(const char * jobz, const int * m, const int * n, float * a, const int * lda, float * s, float * u, const int * ldu, float * vt, const int * ldvt, float * work, const int * lwork, int * iwork, int * info);
#else
#include <armpl.h>
#endif // defined(__APPLE__)

#ifdef __ARM_FEATURE_SVE
#include <arm_sve.h>
#endif // __ARM_FEATURE_SVE""", label="include block")

rep("""#include <VapourSynth.h>
#include <VSHelper.h>""",
"""#include <VapourSynth4.h>
#include <VSHelper4.h>""", label="headers")

rep("""#else
        int major, minor, patch;
        const char * tag;
        armplversion(&major, &minor, &patch, &tag);

        std::ostringstream armpl_version;
        armpl_version << major << '.' << minor << '.' << patch << '.' << tag;
        vsapi->propSetData(out, "armpl_version", armpl_version.str().c_str(), -1, paReplace);
#endif""",
"""#else
#if defined(__APPLE__)
        vsapi->mapSetData(out, "blas", "Accelerate (macOS system framework)", -1, maReplace);
#else
        int major, minor, patch;
        const char * tag;
        armplversion(&major, &minor, &patch, &tag);

        std::ostringstream armpl_version;
        armpl_version << major << '.' << minor << '.' << patch << '.' << tag;
        vsapi->mapSetData(out, "armpl_version", armpl_version.str().c_str(), -1, maReplace);
#endif
#endif""", label="version fn")

rep("""    int svd_lwork, svd_lda, svd_ldu, svd_ldvt;

    std::unordered_map<std::thread::id, Workspace> workspaces;""",
"""    int svd_lwork, svd_lda, svd_ldu, svd_ldvt;
    VSVideoInfo out_vi{}; // V4: the filter's declared output (was built in the init callback)

    std::unordered_map<std::thread::id, Workspace> workspaces;""", label="struct out_vi")

rep("""static void VS_CC WNNMRawInit(
    VSMap *in, VSMap *out, void **instanceData, VSNode *node,
    VSCore *core, const VSAPI *vsapi
) noexcept {

    WNNMData * d = static_cast<WNNMData *>(*instanceData);

    if (d->radius > 0) {
        auto vi = *vsapi->getVideoInfo(d->node);
        vi.height *= 2 * (2 * d->radius + 1);
        vsapi->setVideoInfo(&vi, 1, node);
    } else {
        auto vi = vsapi->getVideoInfo(d->node);
        vsapi->setVideoInfo(vi, 1, node);
    }
}

""", "", label="drop WNNMRawInit")

rep("""static void VS_CC VAggregateInit(
    VSMap *in, VSMap *out, void **instanceData, VSNode *node,
    VSCore *core, const VSAPI *vsapi
) noexcept {

    auto * d = static_cast<VAggregateData *>(*instanceData);

    vsapi->setVideoInfo(d->src_vi, 1, node);
}

""", "", label="drop VAggregateInit")

rep("""    vsapi->createFilter(in, out, "WNNMRaw", WNNMRawInit, WNNMRawGetFrame, WNNMRawFree, fmParallel, 0, d.release(), core);""",
"""    {
        if (d->radius > 0) {
            d->out_vi = *vsapi->getVideoInfo(d->node);
            d->out_vi.height *= 2 * (2 * d->radius + 1);
        } else {
            d->out_vi = *vsapi->getVideoInfo(d->node);
        }

        std::vector<VSFilterDependency> deps{ { d->node, rpGeneral } };
        if (d->ref_node)
            deps.push_back({ d->ref_node, rpGeneral });

        vsapi->createVideoFilter(out, "WNNMRaw", &d->out_vi, WNNMRawGetFrame, WNNMRawFree, fmParallel, deps.data(), static_cast<int>(deps.size()), d.release(), core);
    }""", label="WNNMRaw create")

rep("""    vsapi->createFilter(
        in, out, "VAggregate",
        VAggregateInit, VAggregateGetFrame, VAggregateFree,
        fmParallel, 0, d.release(), core);""",
"""    {
        VSFilterDependency deps[] = { { d->node, rpGeneral }, { d->src_node, rpGeneral } };
        vsapi->createVideoFilter(out, "VAggregate", d->src_vi, VAggregateGetFrame, VAggregateFree, fmParallel, deps, 2, d.release(), core);
    }""", label="VAggregate create")

rep("""VS_EXTERNAL_API(void) VapourSynthPluginInit(
    VSConfigPlugin configFunc, VSRegisterFunction registerFunc, VSPlugin *plugin
) noexcept {

    myself = plugin;

    configFunc(
        "com.wolframrhodium.wnnm",
        "wnnm", "Weighted Nuclear Norm Minimization Denoiser",
        VAPOURSYNTH_API_VERSION, 1, plugin
    );""",
"""VS_EXTERNAL_API(void) VapourSynthPluginInit2(VSPlugin * plugin, const VSPLUGINAPI * vspapi) {

    myself = plugin;

    vspapi->configPlugin(
        "com.wolframrhodium.wnnm",
        "wnnm", "Weighted Nuclear Norm Minimization Denoiser",
        VS_MAKE_VERSION(4, 0), VAPOURSYNTH_API_VERSION, 0, plugin
    );""", label="init2 head")

rep('"clip:clip;"\n        "sigma:float[]:opt;"', '"clip:vnode;"\n        "sigma:float[]:opt;"', label="wnnm_args clip")
rep('"clip:clip;"\n        "src:clip;"', '"clip:vnode;"\n        "src:vnode;"', label="VAggregate args clip/src")
rep('"rclip:clip:opt;"', '"rclip:vnode:opt;"', label="rclip arg")

rep("""    registerFunc("WNNMRaw", wnnm_args, WNNMRawCreate, nullptr, plugin);""",
"""    vspapi->registerFunction("WNNMRaw", wnnm_args, "clip:vnode;", WNNMRawCreate, nullptr, plugin);""", label="reg WNNMRaw")

rep("""    registerFunc(
        "VAggregate",
        "clip:vnode;"
        "src:vnode;"
        "planes:int[];"
        "internal:int:opt;",
        VAggregateCreate, nullptr, plugin);""",
"""    vspapi->registerFunction(
        "VAggregate",
        "clip:vnode;"
        "src:vnode;"
        "planes:int[];"
        "internal:int:opt;",
        "clip:vnode;",
        VAggregateCreate, nullptr, plugin);""", label="reg VAggregate")

rep("""    registerFunc("WNNM", wnnm_args, WNNMCreate, nullptr, plugin);""",
"""    vspapi->registerFunction("WNNM", wnnm_args, "clip:vnode;", WNNMCreate, nullptr, plugin);""", label="reg WNNM")

rep('    registerFunc("Version", "", getVersion, nullptr, plugin);',
    '    vspapi->registerFunction("Version", "", "", getVersion, nullptr, plugin);', label="reg Version")

rep("""    int n, int activationReason, void **instanceData, void **frameData,
    VSFrameContext *frameCtx, VSCore *core, const VSAPI *vsapi
) noexcept {

    auto * d = static_cast<WNNMData *>(*instanceData);""",
"""    int n, int activationReason, void *instanceData, void **frameData,
    VSFrameContext *frameCtx, VSCore *core, const VSAPI *vsapi
) noexcept {

    auto * d = static_cast<WNNMData *>(instanceData);""", label="WNNMRawGetFrame sig")

rep("""    int n, int activationReason, void **instanceData, void **frameData,
    VSFrameContext *frameCtx, VSCore *core, const VSAPI *vsapi
) noexcept {

    auto * d = static_cast<VAggregateData *>(*instanceData);""",
"""    int n, int activationReason, void *instanceData, void **frameData,
    VSFrameContext *frameCtx, VSCore *core, const VSAPI *vsapi
) noexcept {

    auto * d = static_cast<VAggregateData *>(instanceData);""", label="VAggregateGetFrame sig")

n = t.count("VSCoreInfo core_info;")
assert n == 2, f"VSCoreInfo2 sites: {n}"
t = t.replace("VSCoreInfo core_info;", "VSCoreInfo2 core_info;")
done.append(f"VSCoreInfo2 x{n}")

for old, new, label in [("VSFrameRef", "VSFrame", "VSFrameRef"), ("VSNodeRef", "VSNode", "VSNodeRef"),
    ("vsapi->propGet", "vsapi->mapGet", "propGet"), ("vsapi->propSet", "vsapi->mapSet", "propSet"),
    ("paReplace", "maReplace", "paReplace"), ("vsapi->setError(", "vsapi->mapSetError(", "setError"),
    ("vi->format->", "vi->format.", "format deref"), ("cmGray", "cfGray", "cmGray"), ("cmYUV", "cfYUV", "cmYUV"),
    ("cmRGB", "cfRGB", "cmRGB"), ("isConstantFormat(", "vsh::isConstantVideoFormat(", "isConstant"),
    ("int64ToIntS(", "vsh::int64ToIntS(", "int64ToIntS"), ("vs_aligned_malloc", "vsh::vsh_aligned_malloc", "malloc"),
    ("vs_aligned_free", "vsh::vsh_aligned_free", "free")]:
    n = t.count(old)
    if n:
        t = t.replace(old, new)
    done.append(f"{label} x{n}")

p.write_text(t)
print("PATCHED OK:")
for d in done:
    print("  -", d)
print("bytes:", len(t))
