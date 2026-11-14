#!/usr/bin/env python3
"""VS4/API-4 port of the neo-f3kdb dualsynth wrapper (R82 migration, 2026-11-13).

Converts include/dualsynth/{ds_format,ds_videoinfo,ds_frame,ds_filter,vs_wrapper}.hpp
from the V3 API to V4: value VSVideoFormat + queryVideoFormat, mapGet*, VSNode/
VSFrame types, createVideoFilter with deps, Init2 registration, "vnode" clip args.
"""
from pathlib import Path

def load(f): return Path(f).read_text()
def save(f, t): Path(f).write_text(t); print(f"saved {f}")

def rep(t, old, new, n=1, label=""):
    c = t.count(old)
    assert c == n, f"{label}: {c} (want {n}): {old[:60]!r}"
    return t.replace(old, new)

# ── ds_format.hpp ──
t = load("include/dualsynth/ds_format.hpp")
t = rep(t, "  DSFormat(const VSFormat* format)", "  DSFormat(const VSVideoFormat* format)", 1, "ds_format ctor")
t = rep(t, """    IsFamilyYUV = format->colorFamily == cmYUV || format->colorFamily == cmGray;
    IsFamilyRGB = format->colorFamily == cmRGB;
    IsFamilyYCC = format->colorFamily == cmYCoCg;""",
"""    IsFamilyYUV = format->colorFamily == cfYUV || format->colorFamily == cfGray;
    IsFamilyRGB = format->colorFamily == cfRGB;
    IsFamilyYCC = format->colorFamily == cfYCoCg;""", 1, "ds_format families")
t = rep(t, """  const VSFormat* ToVSFormat(const VSCore* vscore, const VSAPI* vsapi) const
  {
    VSColorFamily family = cmYUV;
    if (IsFamilyYUV)
      family = Planes == 1 ? cmGray : cmYUV;
    else if (IsFamilyRGB)
      family = cmRGB;
    else if (IsFamilyYCC)
      family = cmYCoCg;
    return vsapi->registerFormat(family, IsInteger ? stInteger : stFloat, BitsPerSample, SSW, SSH, const_cast<VSCore*>(vscore));
  }""",
"""  VSVideoFormat ToVSFormat(const VSCore* vscore, const VSAPI* vsapi) const
  {
    VSColorFamily family = cfYUV;
    if (IsFamilyYUV)
      family = Planes == 1 ? cfGray : cfYUV;
    else if (IsFamilyRGB)
      family = cfRGB;
    else if (IsFamilyYCC)
      family = cfYCoCg;
    VSVideoFormat format{};
    vsapi->queryVideoFormat(&format, family, IsInteger ? stInteger : stFloat, BitsPerSample, SSW, SSH, const_cast<VSCore*>(vscore));
    return format;
  }""", 1, "ds_format ToVSFormat")
save("include/dualsynth/ds_format.hpp", t)

# ── ds_videoinfo.hpp ──
t = load("include/dualsynth/ds_videoinfo.hpp")
t = rep(t, """  const VSVideoInfo* ToVSVI(const VSCore* vscore, const VSAPI* vsapi) {
    return new VSVideoInfo {Format.ToVSFormat(vscore, vsapi), FPSNum, FPSDenom, Width, Height, Frames, 0};
  }""",
"""  const VSVideoInfo* ToVSVI(const VSCore* vscore, const VSAPI* vsapi) {
    VSVideoInfo* vi = new VSVideoInfo{};
    vi->format = Format.ToVSFormat(vscore, vsapi);
    vi->fpsNum = FPSNum;
    vi->fpsDen = FPSDenom;
    vi->width = Width;
    vi->height = Height;
    vi->numFrames = Frames;
    return vi;
  }""", 1, "ToVSVI")
save("include/dualsynth/ds_videoinfo.hpp", t)

# ── ds_frame.hpp ──
t = load("include/dualsynth/ds_frame.hpp")
t = rep(t, "  const VSFormat* _vsformat {nullptr};", "  const VSVideoFormat* _vsformat {nullptr};", 1, "ds_frame member")
t = rep(t, """      auto vsframe = _vsapi->newVideoFrame(vi.Format.ToVSFormat(_vscore, _vsapi), vi.Width, vi.Height, _vssrc, const_cast<VSCore*>(_vscore));""",
"""      auto out_format = vi.Format.ToVSFormat(_vscore, _vsapi);
      auto vsframe = _vsapi->newVideoFrame(&out_format, vi.Width, vi.Height, _vssrc, const_cast<VSCore*>(_vscore));""", 1, "ds_frame newVideoFrame")
n = t.count("VSFrameRef"); t = t.replace("VSFrameRef", "VSFrame")
print(f"ds_frame VSFrameRef x{n}")
save("include/dualsynth/ds_frame.hpp", t)

# ── ds_filter.hpp: clip param type → vnode ──
t = load("include/dualsynth/ds_filter.hpp")
t = rep(t, 'case Clip: type_name = "clip"; break;', 'case Clip: type_name = "vnode"; break;', 1, "ds_filter vnode")
save("include/dualsynth/ds_filter.hpp", t)

# ── vs_wrapper.hpp ──
t = load("include/dualsynth/vs_wrapper.hpp")
# bulks
for old, new in [("VSNodeRef", "VSNode"), ("VSFrameRef", "VSFrame"),
                 ("vsapi->propGet", "vsapi->mapGet"), ("_vsapi->propGet", "_vsapi->mapGet"),
                 ("propNumElements", "mapNumElements"),
                 ("vsapi->setError(", "vsapi->mapSetError(")]:
    c = t.count(old)
    if c:
        t = t.replace(old, new); print(f"vs_wrapper {old} x{c}")

# drop the Initialize template
t = rep(t, """  template<typename FilterType>
  void VS_CC Initialize(VSMap *in, VSMap *out, void **instanceData, VSNode *node, VSCore *core, const VSAPI *vsapi) {
    auto Data = reinterpret_cast<FilterType*>(*instanceData);
    auto output_vi = Data->GetOutputVI();
    vsapi->setVideoInfo(output_vi.ToVSVI(core, vsapi), 1, node);
  }

""", "", 1, "drop Initialize")

# GetFrame: instanceData + deref
t = rep(t, """  const VSFrame* VS_CC GetFrame(int n, int activationReason, void **instanceData, void **frameData, VSFrameContext *frameCtx, VSCore *core, const VSAPI *vsapi) {
    auto filter = reinterpret_cast<FilterType*>(*instanceData);""",
"""  const VSFrame* VS_CC GetFrame(int n, int activationReason, void *instanceData, void **frameData, VSFrameContext *frameCtx, VSCore *core, const VSAPI *vsapi) {
    auto filter = reinterpret_cast<FilterType*>(instanceData);""", 1, "GetFrame sig")

# Create: createFilter → createVideoFilter with deps
t = rep(t, """      filter->Initialize(&argument, input_vi, functor);
      vsapi->createFilter(in, out, filter->VSName(), Initialize<FilterType>, GetFrame<FilterType>, Delete<FilterType>, filter->VSMode(), 0, filter, core);""",
"""      filter->Initialize(&argument, input_vi, functor);
      auto out_vi = filter->GetOutputVI().ToVSVI(core, vsapi);
      VSFilterDependency deps[1];
      int ndeps = 0;
      if (functor) {
        deps[0].source = functor->_vs_clip;
        deps[0].requestPattern = rpGeneral;
        ndeps = 1;
      }
      vsapi->createVideoFilter(out, filter->VSName(), out_vi, GetFrame<FilterType>, Delete<FilterType>, filter->VSMode(), deps, ndeps, filter, core);""", 1, "Create")

# RegisterFilter / RegisterPlugin / entry point
t = rep(t, """  template<typename FilterType>
  void RegisterFilter(VSRegisterFunction registerFunc, VSPlugin* vsplugin) {
    FilterType filter;
    registerFunc(filter.VSName(), filter.VSParams().c_str(), Create<FilterType>, nullptr, vsplugin);
  }

  void RegisterPlugin(VSConfigPlugin configFunc, VSPlugin* vsplugin) {
    configFunc(Plugin::Identifier, Plugin::Namespace, Plugin::Description, VAPOURSYNTH_API_VERSION, 1, vsplugin);
  }
}

VS_EXTERNAL_API(void) VapourSynthPluginInit(VSConfigPlugin configFunc, VSRegisterFunction registerFunc, VSPlugin* vsplugin) {
  VSInterface::RegisterPlugin(configFunc, vsplugin);
  auto filters = RegisterVSFilters();
  for (auto &&RegisterFilter : filters) {
    RegisterFilter(registerFunc, vsplugin);
  }
}""",
"""  template<typename FilterType>
  void RegisterFilter(const VSPLUGINAPI* vspapi, VSPlugin* vsplugin) {
    FilterType filter;
    vspapi->registerFunction(filter.VSName(), filter.VSParams().c_str(), "clip:vnode;", Create<FilterType>, nullptr, vsplugin);
  }

  void RegisterPlugin(const VSPLUGINAPI* vspapi, VSPlugin* vsplugin) {
    vspapi->configPlugin(Plugin::Identifier, Plugin::Namespace, Plugin::Description, VS_MAKE_VERSION(4, 0), VAPOURSYNTH_API_VERSION, 0, vsplugin);
  }
}

VS_EXTERNAL_API(void) VapourSynthPluginInit2(VSPlugin* vsplugin, const VSPLUGINAPI* vspapi) {
  VSInterface::RegisterPlugin(vspapi, vsplugin);
  auto filters = RegisterVSFilters();
  for (auto &&RegisterFilter : filters) {
    RegisterFilter(vspapi, vsplugin);
  }
}""", 1, "registration + entry")
save("include/dualsynth/vs_wrapper.hpp", t)
print("NEO-F3KDB WRAPPER PORTED")
