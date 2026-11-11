#include "vs_runtime.h"

#include "../../../common/logging/log.h"
#include "../../../common/marshal/marshal.h"

#include <dlfcn.h>      // dlsym(RTLD_DEFAULT, ...) for Python state diagnostics

#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <filesystem>
#include <string>

#include <cstring>
#include <memory>

namespace vsres::macos {

namespace {

// ── Portable-bundle self-containment helpers ─────────────────────────────────
// The OFX binary's own bundle root, derived from THIS code image (works both
// for the dev build tree layout and any install location). Returns an empty
// path when dladdr cannot resolve — callers must tolerate that.
std::filesystem::path this_bundle_contents() {
    Dl_info info = {};
    if (dladdr(reinterpret_cast<void*>(&this_bundle_contents), &info) == 0 || !info.dli_fname)
        return {};
    // …/VapourSynth.ofx.bundle/Contents/MacOS/VapourSynth.ofx → Contents
    return std::filesystem::path(info.dli_fname).parent_path().parent_path();
}

// ── VSScript Python auto-config (portable bundles) ──────────────────────────
// ROOT CAUSE (live Resolve evidence 2026-10-30): VSScript R75's readEnvConfig
// keys ~/.config/vapoursynth/vapoursynth.toml by the LOADED libvsscript's own
// path. The old installed bundle linked the DEV-TREE libvsscript (absolute
// path with a toml entry) → init worked. The portable bundle relocates it to
// Contents/Libraries/libvsscript.dylib — no entry → getVSScriptAPI fails
// ("Python executable and library path couldn't be determined despite
// automatic configuration") → pre-accept validation REFUSES every Save and
// Close → Resolve keeps original pixels (the owner's render-path blocker),
// and renders fall back to passthrough.
//
// FIX (verified by the isolated harness tests/test_vsscript_init.sh): the
// bundle carries its own Python.framework — self-register the toml entry
// mapping the bundle's libvsscript → the bundle's python pair, idempotently,
// before getVSScriptAPI. Fully bundle-relative: no dev-tree or machine paths.
// A miss (no bundle python / read-only HOME) only logs — never breaks render.
void ensure_vsscript_python_config() {
    std::filesystem::path contents = this_bundle_contents();
    if (contents.empty()) return;
    std::filesystem::path lib = contents / "Libraries" / "libvsscript.dylib";
    std::error_code ec;
    if (!std::filesystem::exists(lib, ec)) return;
    // PREFERRED pair (live evidence 2026-10-30): the ALREADY-LOADED host
    // interpreter. Registering the BUNDLE's Python.framework initialized a
    // SECOND CPython runtime in-process (Resolve embeds Homebrew 3.13 —
    // /tmp/vsres-syspath.log) and the second runtime's import fails
    // ("Failed to import the VapourSynth Python module") — reproduced by
    // the harness's preload mode. Pointing at the running interpreter's own
    // dylib makes realInit's LOAD_LIBRARY return the SAME image (dlopen
    // dedupe, no second init) and import_vapoursynth runs in the host
    // interpreter that the sys.path patch below already prepared. This is
    // the OLD working bundle's exact mechanism, generalized.
    std::filesystem::path fw = contents / "Frameworks" / "Python.framework" / "Versions";
    std::string pyver;
    std::filesystem::path exe, dylib;
    std::filesystem::path host_lib;
    if (auto py_init = reinterpret_cast<void (*)(int)>(dlsym(RTLD_DEFAULT, "Py_InitializeEx"))) {
        Dl_info py_info = {};
        if (dladdr(reinterpret_cast<void*>(py_init), &py_info) && py_info.dli_fname) {
            host_lib = std::filesystem::path(py_info.dli_fname);
            std::error_code ec2;
            std::filesystem::path base = host_lib.parent_path();   // …/Versions/X.Y
            if (std::filesystem::exists(base / "bin", ec2)) {
                const std::string ver = base.filename().string();
                std::filesystem::path hexe = base / "bin" / ("python" + ver);
                if (std::filesystem::exists(hexe, ec2)) { exe = hexe; dylib = host_lib; }
            }
        }
    }
    if (exe.empty()) {
        // Fallback: the bundle's own framework — only correct when NO host
        // python is initialized (standalone processes); the .pth below
        // covers that case's sys.path.
        for (const auto& e : std::filesystem::directory_iterator(fw, ec)) {
            if (ec) break;
            const std::string v = e.path().filename().string();
            if (!v.empty() && std::isdigit(static_cast<unsigned char>(v[0]))) { pyver = v; break; }
        }
        if (pyver.empty()) return;
        std::filesystem::path bexe = fw / pyver / "bin" / ("python" + pyver);
        std::filesystem::path bdylib = fw / pyver / "Python";
        if (!std::filesystem::exists(bexe, ec) || !std::filesystem::exists(bdylib, ec)) return;
        exe = bexe;
        dylib = bdylib;
    }

    const char* home = std::getenv("HOME");
    if (!home || !*home) return;
    std::filesystem::path toml = std::filesystem::path(home) / ".config" / "vapoursynth" / "vapoursynth.toml";
    // Idempotent: an existing line keyed by this lib path means done. The
    // comparison mirrors VSScript's own parser (first quoted string).
    const std::string key = "\"" + lib.string() + "\"";
    {
        std::ifstream in(toml);
        std::string line;
        while (std::getline(in, line)) {
            const auto q = line.find('"');
            const auto qe = q == std::string::npos ? q : line.find('"', q + 1);
            if (q != std::string::npos && qe != std::string::npos &&
                line.substr(q, qe - q + 1) == key)
                return;
        }
    }
    std::filesystem::create_directories(toml.parent_path(), ec);
    std::ofstream out(toml, std::ios::app);
    if (!out.is_open()) {
        log::warn("vs_runtime", "cannot self-register VSScript python config: " + toml.string());
        return;
    }
    out << key << " = [\"" << exe.string() << "\",\"" << dylib.string() << "\"]\n";
    out.close();
    log::info("vs_runtime", "self-registered VSScript python config for portable bundle: "
        + lib.string() + " -> python " + pyver);

    // SECOND HALF of the portable-bundle fix (live Resolve 2026-10-30: after
    // the toml entry, init failed at "Failed to import the VapourSynth
    // Python module" — the SECOND bundle interpreter had nothing on
    // sys.path). A .pth in the bundle python's OWN site-packages adds
    // Resources/vs-python at its site-init — needed when the FALLBACK pair
    // (bundle framework) is used, harmless otherwise. RELATIVE content;
    // idempotent by filename.
    std::string bver;
    for (const auto& e : std::filesystem::directory_iterator(fw, ec)) {
        if (ec) break;
        const std::string v = e.path().filename().string();
        if (!v.empty() && std::isdigit(static_cast<unsigned char>(v[0]))) { bver = v; break; }
    }
    if (bver.empty()) return;
    std::filesystem::path site = fw / bver / "lib" / ("python" + bver) / "site-packages";
    std::filesystem::path pth = site / "vsres-vapoursynth.pth";
    std::error_code sec;
    if (!std::filesystem::exists(pth, sec)) {
        std::filesystem::create_directories(site, ec);
        std::ofstream pout(pth, std::ios::trunc);
        if (pout.is_open()) {
            // site-packages → lib → pythonX → X → Versions → Python.framework
            // → Frameworks → Contents, then Resources/vs-python.
            pout << "../../../../../../../Resources/vs-python\n";
            log::info("vs_runtime", "self-registered bundle-python .pth: " + pth.string());
        }
    }
}

// ── Bundle plugin autoload (self-containment) ──────────────────────────────
// The portable bundle stages the curated VS filter-plugin set at
// Contents/Plugins. VapourSynth autoloads the USER plugin dir
// (~/Library/Application Support/VapourSynth/Plugins) by default — machine
// state that a clean install does not have. VAPOURSYNTH_EXTRA_PLUGIN_PATH
// adds our bundle dir at core creation; the env var must be set before the
// first core is built (VsRuntime ctor precedes every evaluate). Idempotent;
// never overwrites a user-provided value (append with os.pathsep instead).
void ensure_bundle_plugin_path() {
    std::filesystem::path contents = this_bundle_contents();
    if (contents.empty()) return;
    std::filesystem::path plugins = contents / "Plugins";
    std::error_code ec;
    if (!std::filesystem::is_directory(plugins, ec)) return;
    const char* existing = std::getenv("VAPOURSYNTH_EXTRA_PLUGIN_PATH");
    if (existing && *existing) {
        // POSTURE (security review #5 decision, 2026-11-11): an explicit override is
        // honored — it is the user's machine and a deliberate power-user/test
        // path — but it can never be SILENT when a staged bundle is present:
        // the reviewed bundle plugin set is NOT loaded, changing what every
        // chain evaluates. Everything companion-spawned receives the bundle
        // path explicitly (main.js), so only a machine/user shell value can
        // reach this branch. VSRES_ALLOW_PLUGIN_OVERRIDE=1 silences the
        // warning for repeatable local testing.
        const char* ack = std::getenv("VSRES_ALLOW_PLUGIN_OVERRIDE");
        if (std::string(existing) != plugins.string() && !(ack && std::string(ack) == "1")) {
            log::warn("vs_runtime",
                "VAPOURSYNTH_EXTRA_PLUGIN_PATH override active — staged bundle "
                "plugins NOT loaded (using: " + std::string(existing) +
                "; unset it or set VSRES_ALLOW_PLUGIN_OVERRIDE=1 to acknowledge)");
        }
        return;  // single-path var (empirically) — respected verbatim
    }
    // EMPIRICAL (2026-10-31): in this VS R75 macOS build the env var is the
    // ONLY plugin-loading mechanism (single path; no default user-dir
    // autoload — with the env unset, a populated user dir still yields only
    // the 3 builtin namespaces). The staged bundle's Contents/Plugins is a
    // SUPERSET of the curated user set, so pointing the env there loads
    // everything the user dir would have provided — clean machines and dev
    // machines alike. Mirrors render_preview_frame.py.
    setenv("VAPOURSYNTH_EXTRA_PLUGIN_PATH", plugins.string().c_str(), 1);
    log::info("vs_runtime", "bundle plugin autoload: " + plugins.string());
}

// Mirrors v1.x's OfxSourceData struct + ofxSourceGetFrame callback at
// platform/windows/src/VapourSynthPlugin.cpp:110-168 but:
//   - float32 only (no 16-bit int path)
//   - delegates the actual transpose to vsres::marshal so the inner loops can be swapped
//     for vDSP in a follow-up commit without touching this glue.
struct OfxSourceData {
    OFX::Clip* clip = nullptr;
    VSVideoInfo vi{};
    int min_frame = 0;
    int max_frame = 0;
    // Window the OFX host declared for the current render call and the frame
    // being rendered. A temporal filter that reaches past the declared window
    // would otherwise fail the whole graph ("OFX source clip returned no
    // image"); we degrade to the nearest in-window frame instead.
    std::atomic<int>* center_frame = nullptr;
    int radius = 0;
    std::atomic<bool> clamp_logged{false};
};

const VSFrame* VS_CC ofx_source_get_frame(int n, int activation_reason, void* instance_data,
                                          void** /*frame_data*/, VSFrameContext* frame_ctx,
                                          VSCore* core, const VSAPI* vsapi) {
    if (activation_reason != arInitial) return nullptr;
    auto* d = static_cast<OfxSourceData*>(instance_data);
    if (!d || !d->clip) {
        vsapi->setFilterError("Source filter has no OFX clip", frame_ctx);
        return nullptr;
    }

    const double time = static_cast<double>(n) + d->min_frame;

    // CLAMP BEFORE THE FIRST FETCH. An out-of-window fetchImage does not just
    // return null — Resolve may error the whole render action, so a retry at
    // an in-window frame afterwards fails too. QTGMC evaluates motion vectors
    // eagerly at script-evaluation time (evaluateBuffer), requesting frame 0
    // of the super clip while the render action's declared window is around
    // the playhead. Never let that out-of-window request reach the host:
    // retarget it to the nearest in-window frame (the render center) up front.
    const int requested = static_cast<int>(time + (time >= 0.0 ? 0.5 : -0.5));
    int target = requested;
    if (d->center_frame && d->radius > 0) {
        const int center = d->center_frame->load(std::memory_order_relaxed);
        const int lo = std::max(d->min_frame, center - d->radius);
        const int hi = std::min(d->max_frame, center + d->radius);
        if (target < lo) target = lo;
        else if (target > hi) target = hi;
        if (target != requested && !d->clamp_logged.exchange(true)) {
            vsres::log::warn("vs_runtime", "retargeted an out-of-window OFX frame fetch "
                + std::to_string(requested) + " -> " + std::to_string(target)
                + " (render center " + std::to_string(center)
                + ", radius " + std::to_string(d->radius)
                + ", clip range " + std::to_string(d->min_frame) + ".."
                + std::to_string(d->max_frame) + ")"
                + " — motion analysis repeats a frame at the window edge instead of erroring");
        }
    }
    std::unique_ptr<OFX::Image> src(d->clip->fetchImage(static_cast<double>(target)));
    if (!src && target != requested) {
        // The retargeted fetch failed anyway (unexpected: target is in the
        // declared window). One more fallback to the center itself, and a loud
        // full-state diagnostic so the failure is debuggable from the log.
        const int center = d->center_frame ? d->center_frame->load(std::memory_order_relaxed) : -1;
        src.reset(d->clip->fetchImage(static_cast<double>(center)));
        vsres::log::error("vs_runtime", "in-window OFX frame fetch failed too: requested="
            + std::to_string(requested) + " retarget=" + std::to_string(target)
            + " center=" + std::to_string(center) + " clip range "
            + std::to_string(d->min_frame) + ".." + std::to_string(d->max_frame));
    }
    if (!src) {
        vsapi->setFilterError("OFX source clip returned no image", frame_ctx);
        return nullptr;
    }
    if (src->getPixelDepth() != OFX::eBitDepthFloat ||
        src->getPixelComponents() != OFX::ePixelComponentRGBA) {
        vsapi->setFilterError("OFX source clip is not float32 RGBA", frame_ctx);
        return nullptr;
    }

    VSFrame* f = vsapi->newVideoFrame(&d->vi.format, d->vi.width, d->vi.height, nullptr, core);
    if (!f) {
        vsapi->setFilterError("Failed to allocate VS frame", frame_ctx);
        return nullptr;
    }

    auto rect = src->getRegionOfDefinition();
    const int w = rect.x2 - rect.x1;
    const int h = rect.y2 - rect.y1;

    // OFX images are y-up; VS frames are y-down. Walk OFX rows top-to-bottom (= y2-1 down to y1)
    // and write VS rows 0..h-1 in order. This matches the v1.x loop nesting.
    for (int yi = 0; yi < h; ++yi) {
        const int ofx_y = (rect.y2 - 1) - yi;
        const float* src_row = static_cast<const float*>(src->getPixelAddress(rect.x1, ofx_y));
        float* r_row = reinterpret_cast<float*>(vsapi->getWritePtr(f, 0))
                       + yi * (vsapi->getStride(f, 0) / static_cast<int>(sizeof(float)));
        float* g_row = reinterpret_cast<float*>(vsapi->getWritePtr(f, 1))
                       + yi * (vsapi->getStride(f, 1) / static_cast<int>(sizeof(float)));
        float* b_row = reinterpret_cast<float*>(vsapi->getWritePtr(f, 2))
                       + yi * (vsapi->getStride(f, 2) / static_cast<int>(sizeof(float)));
        for (int x = 0; x < w; ++x) {
            r_row[x] = src_row[x * 4 + 0];
            g_row[x] = src_row[x * 4 + 1];
            b_row[x] = src_row[x * 4 + 2];
        }
    }
    return f;
}

void VS_CC ofx_source_free(void* instance_data, VSCore* /*core*/, const VSAPI* /*vsapi*/) {
    delete static_cast<OfxSourceData*>(instance_data);
}

}  // namespace

VsRuntime::VsRuntime() {
    // PORTABLE-BUNDLE python config BEFORE getVSScriptAPI (see
    // ensure_vsscript_python_config above): without the toml entry the
    // relocated libvsscript cannot determine its python pair and every
    // native evaluation fails inside Resolve.
    ensure_vsscript_python_config();
    // Bundle plugin autoload BEFORE any core creation (self-containment).
    ensure_bundle_plugin_path();
    // Resolve embeds its own Python in-process (for the scripting API at
    // /Library/Application Support/Blackmagic Design/.../Scripting/), and that
    // Python is already initialized by the time our OFX bundle's render path
    // runs. Consequence: libvsscript's Py_InitializeEx is a no-op, so site.py
    // doesn't re-execute, so .pth files and PYTHONPATH set by us are never
    // consulted. We confirmed this via Py_IsInitialized() returning TRUE before
    // VSScript init.
    //
    // Workaround: directly mutate sys.path of the running interpreter using
    // PyRun_SimpleString, BEFORE we ask libvsscript to do its PyImport_ImportModule.
    // Python's import machinery walks sys.path at lookup time, so this puts our
    // R75 vapoursynth package ahead of Homebrew's R73 vapoursynth.so even if
    // Resolve never re-runs site.py.
    using Py_IsInitialized_t = int (*)();
    using PyRun_SimpleString_t = int (*)(const char*);
    using PyGILState_Ensure_t = int (*)();
    using PyGILState_Release_t = void (*)(int);

    auto py_is_init    = reinterpret_cast<Py_IsInitialized_t>   (dlsym(RTLD_DEFAULT, "Py_IsInitialized"));
    auto py_run        = reinterpret_cast<PyRun_SimpleString_t> (dlsym(RTLD_DEFAULT, "PyRun_SimpleString"));
    auto py_gil_ensure = reinterpret_cast<PyGILState_Ensure_t>  (dlsym(RTLD_DEFAULT, "PyGILState_Ensure"));
    auto py_gil_release= reinterpret_cast<PyGILState_Release_t> (dlsym(RTLD_DEFAULT, "PyGILState_Release"));

    bool py_was_init = py_is_init && py_is_init();
    log::info("vs_runtime", std::string("Py_IsInitialized() before VSScript = ")
        + (py_was_init ? "TRUE — patching sys.path on Resolve's Python directly"
                       : "FALSE — letting libvsscript do its normal init"));

    if (py_was_init && py_run && py_gil_ensure && py_gil_release) {
        // Resolve's Python is up. PyRun_SimpleString requires the GIL — acquire
        // it, run our sys.path mutation, release. The mutation is idempotent
        // (a duplicate path is harmless) so calling this on every VsRuntime
        // construction is fine, even though once would suffice per process.
        //
        // SELF-CONTAINMENT ORDER (2026-10-31 packaging pass): the BUNDLE's
        // own Resources/vs-python ships the vapoursynth package + chain
        // helpers, so it is the FIRST entry — the install owns everything
        // the import needs. The compile-time VSRES_VS_SITE_PACKAGES path
        // (dev builds only; NOT defined for VSRES_PORTABLE_BUNDLE) and the
        // user vs-python dirs remain as dev/machine fallbacks AFTER it.
        const int gstate = py_gil_ensure();
        std::filesystem::path contents = this_bundle_contents();
        std::error_code spc;
        std::filesystem::path bundle_vs = contents / "Resources" / "vs-python";
        const bool have_bundle_vs = !contents.empty() &&
            std::filesystem::is_directory(bundle_vs, spc);
        {
            std::string code =
                "import sys, os\n"
                "_inject = []\n";
            // SECURITY (security re-review, 2026-11-05): the bundle path is
            // derived from the loaded plugin's location — a path containing
            // a quote could previously terminate this Python literal and
            // inject a statement during interpreter setup. Emit it as HEX
            // bytes like the composers do (injection impossible by
            // construction; UTF-8 round-trips exactly).
            if (have_bundle_vs) {
                std::string hex;
                char buf[3];
                for (unsigned char ch : bundle_vs.string()) {
                    std::snprintf(buf, sizeof buf, "%02x", ch);
                    hex += buf;
                }
                code += "_inject.append(bytes.fromhex('" + hex +
                        "').decode('utf-8', 'surrogateescape'))\n";
            }
#ifdef VSRES_VS_SITE_PACKAGES
            // Dev builds additionally expose the checkout's vendor
            // site-packages; portable builds do NOT define this (the
            // string must not ship inside a release binary).
            // SECURITY (security re-review #4, 2026-11-11): hex-encoded like
            // the bundle path above — this build-prefix path is a real
            // filesystem location and could previously terminate the Python
            // literal if the prefix contained a quote (conditional
            // build-path exposure an extra interpreter-setup statement).
            {
                std::string hex;
                char buf[3];
                for (unsigned char ch : std::string(VSRES_VS_SITE_PACKAGES)) {
                    std::snprintf(buf, sizeof buf, "%02x", ch);
                    hex += buf;
                }
                code += "_inject.append(bytes.fromhex('" + hex +
                        "').decode('utf-8', 'surrogateescape'))\n";
            }
#endif
            code +=
                "_inject += [os.path.expanduser('~/Library/Application Support/VapourSynth-OFX/vs-python'),\n"
                "            '/Library/Application Support/VapourSynth-OFX/vs-python']\n"
                "for _p in reversed(_inject):\n"
                "    if _p in sys.path:\n"
                "        sys.path.remove(_p)\n"
                "    sys.path.insert(0, _p)\n"
                "# Detach any cached import of `vapoursynth` from Homebrew (R73) so a\n"
                "# subsequent import picks up our R75 package via the fresh sys.path.\n"
                "if 'vapoursynth' in sys.modules:\n"
                "    del sys.modules['vapoursynth']\n"
                "# SECURITY (2026-11-05, security review #7): the old unconditional\n"
                "# truncating write to the PREDICTABLE /tmp/vsres-syspath.log\n"
                "# followed pre-planted symlinks and leaked interpreter details\n"
                "# + the full sys.path to any local reader. Diagnostics are now\n"
                "# opt-in via VSRES_LOG_SYSPATH=1 and written to the user's home\n"
                "# (0600) instead of a world-readable /tmp file.\n"
                "import os as _os\n"
                "import stat as _stat\n"
                "if _os.environ.get('VSRES_LOG_SYSPATH') == '1':\n"
                "    _home = _os.path.expanduser('~')\n"
                "    _log = _os.path.join(_home, 'vsres-syspath.log')\n"
                "    _fd = _os.open(_log, _os.O_WRONLY | _os.O_CREAT | _os.O_NOFOLLOW, 0o600)\n"
                "    _st = _os.fstat(_fd)\n"
                "    # Existing-file handling (security review #7 remainder, 2026-11-11):\n"
                "    # only a regular, single-link file owned by this user is\n"
                "    # written; an existing broader mode (old 0644) is tightened\n"
                "    # with fchmod on the SAME open descriptor and truncation\n"
                "    # happens only after those checks pass. Otherwise refuse.\n"
                "    if _stat.S_ISREG(_st.st_mode) and _st.st_uid == _os.geteuid() and _st.st_nlink == 1:\n"
                "        _os.fchmod(_fd, 0o600)\n"
                "        _os.ftruncate(_fd, 0)\n"
                "        with _os.fdopen(_fd, 'w') as _f:\n"
                "            _f.write('sys.executable=' + sys.executable + '\\n'\n"
                "                     'sys.prefix=' + sys.prefix + '\\n'\n"
                "                     'after patch, sys.path:\\n'\n"
                "                     + '\\n'.join('  ' + p for p in sys.path) + '\\n')\n"
                "    else:\n"
                "        _os.close(_fd)\n";
            int rc = py_run(code.c_str());
            log::info("vs_runtime", std::string("sys.path patch via PyRun_SimpleString rc=")
                + std::to_string(rc) + " (0=ok)"
                + (have_bundle_vs ? " (bundle vs-python first)" : " (no bundle vs-python)"));
        }
        py_gil_release(gstate);
    }

    sapi_ = getVSScriptAPI(VSSCRIPT_API_VERSION);
    if (!sapi_) {
        // VS R75 stores the precise reason init failed in a static — e.g.
        // "Python executable and library path couldn't be determined despite
        // automatic configuration. Run `vapoursynth config`..." or
        // "Python library failed to load from <path>". Surface it to the user
        // via the chain-error banner so they can act on it, instead of the
        // useless generic "Failed to acquire VSScript API".
        const char* detail = getVSScriptAPILastError();
        if (detail && *detail) {
            last_error_ = std::string("VSScript init failed: ") + detail;
        } else {
            last_error_ = "Failed to acquire VSScript API (no detail from getVSScriptAPILastError)";
        }
        log::error("vs_runtime", last_error_);
        return;
    }

    api_ = sapi_->getVSAPI(VAPOURSYNTH_API_VERSION);
    if (!api_) {
        last_error_ = "Failed to acquire VSAPI";
        log::error("vs_runtime", last_error_);
    }
}

VsRuntime::~VsRuntime() {
    teardown_all();
}

void VsRuntime::teardown() {
    if (node_ && api_) {
        api_->freeNode(node_);
        node_ = nullptr;
    }
    if (script_ && sapi_) {
        sapi_->freeScript(script_);
        script_ = nullptr;
    }
    core_ = nullptr;  // freed by sapi_->freeScript
}

void VsRuntime::teardown_all() {
    teardown();
    for (const OpenEntry& e : open_cache_) {
        if (e.node && api_) api_->freeNode(e.node);
        if (e.script && sapi_) sapi_->freeScript(e.script);  // frees its core
        else if (e.core && api_) api_->freeCore(e.core);
    }
    open_cache_.clear();
}

void VsRuntime::retire_active_bounded() {
    if (!is_open()) return;
    OpenEntry e{cached_key_, cached_width_, cached_height_, cached_radius_,
                cached_fps_num_, cached_fps_den_, cached_num_frames_,
                core_, script_, node_};
    open_cache_.insert(open_cache_.begin(), std::move(e));
    core_ = nullptr;
    script_ = nullptr;
    node_ = nullptr;
    cached_key_.clear();
    cached_width_ = cached_height_ = cached_radius_ = -1;
    cached_fps_num_ = cached_fps_den_ = cached_num_frames_ = -1;
    while (open_cache_.size() > kMaxCachedEntries) {
        const OpenEntry& evict = open_cache_.back();
        if (evict.node && api_) api_->freeNode(evict.node);
        if (evict.script && sapi_) sapi_->freeScript(evict.script);  // frees core
        else if (evict.core && api_) api_->freeCore(evict.core);
        open_cache_.pop_back();
    }
}

bool VsRuntime::restore_from_cache(const std::string& cache_key, const VsRuntimeConfig& cfg) {
    for (size_t i = 0; i < open_cache_.size(); ++i) {
        const OpenEntry& e = open_cache_[i];
        if (e.key != cache_key || e.width != cfg.width
            || e.height != cfg.height || e.radius != cfg.radius) {
            continue;
        }
        // Copy the match out BEFORE retiring the active graph: retirement may
        // evict from the back of the cache and the match must not be freed.
        const VSCore* core = e.core;
        const VSScript* script = e.script;
        const VSNode* node = e.node;
        const std::string key = e.key;
        const int width = e.width, height = e.height, radius = e.radius;
        const std::int64_t fps_num = e.fps_num, fps_den = e.fps_den, num_frames = e.num_frames;
        open_cache_.erase(open_cache_.begin() + static_cast<std::ptrdiff_t>(i));
        retire_active_bounded();
        core_ = const_cast<VSCore*>(core);
        script_ = const_cast<VSScript*>(script);
        node_ = const_cast<VSNode*>(node);
        cached_key_ = key;
        cached_width_ = width;
        cached_height_ = height;
        cached_radius_ = radius;
        cached_fps_num_ = fps_num;
        cached_fps_den_ = fps_den;
        cached_num_frames_ = num_frames;
        // A previously-failed identical input may have been corrected
        // since; clear the failure marker so a fresh failure logs once.
        failed_key_.clear();
        failed_width_ = failed_height_ = failed_radius_ = -1;
        log::info("vs_runtime", "VS pipeline restored from retired cache: "
            + std::to_string(width) + "x" + std::to_string(height)
            + " radius=" + std::to_string(radius));
        return true;
    }
    return false;
}

bool VsRuntime::open(const std::string& cache_key,
                     const std::string& vs_script,
                     const VsRuntimeConfig& cfg) {
    if (!api_ || !sapi_) return false;

    if (is_open()
        && cached_key_ == cache_key
        && cached_width_ == cfg.width
        && cached_height_ == cfg.height
        && cached_radius_ == cfg.radius) {
        return true;  // hot path: no reparse needed
    }

    // Warm path: the host interleaves render sizes (viewer / thumbnails /
    // UI tiles) and previously-opened graphs for this chain are still alive.
    // Restoring one avoids the multi-second script re-evaluation that a
    // single-slot cache pays on every size alternation.
    if (restore_from_cache(cache_key, cfg)) {
        return true;
    }

    // Failure short-circuit. If the LAST attempt failed with the same
    // (key, dims, radius), don't bother re-evaluating — Resolve hammers
    // render() once per requested frame and an unchanged chain produces
    // an unchanged error. Suppressing here keeps `log stream` readable;
    // last_error_ stays populated so the OFX render path still falls back
    // to passthrough and the status banner still surfaces the message.
    if (!failed_key_.empty()
        && failed_key_ == cache_key
        && failed_width_ == cfg.width
        && failed_height_ == cfg.height
        && failed_radius_ == cfg.radius) {
        return false;
    }

    // Cache miss: retire (not free) the active graph so a size alternation
    // can restore it instantly; then build the requested graph fresh.
    retire_active_bounded();

    VSCore* core = api_->createCore(0);
    if (!core) {
        last_error_ = "Failed to create VS core";
        log::error("vs_runtime", last_error_);
        return false;
    }

    auto* data = new OfxSourceData();
    data->clip = cfg.source_clip;
    data->vi.width = cfg.width;
    data->vi.height = cfg.height;
    data->vi.numFrames = (cfg.max_frame - cfg.min_frame) + 1;  // off-by-one fix vs v1.x:196
    data->min_frame = cfg.min_frame;
    data->max_frame = cfg.max_frame;
    data->center_frame = &center_frame_;
    data->radius = cfg.radius;
    api_->queryVideoFormat(&data->vi.format, cfRGB, stFloat, 32, 0, 0, core);

    VSNode* source_node = api_->createVideoFilter2("OFXSource", &data->vi,
                                                   ofx_source_get_frame, ofx_source_free,
                                                   fmUnordered, nullptr, 0, data, core);
    if (!source_node) {
        last_error_ = "Failed to create OFX source filter";
        log::error("vs_runtime", last_error_);
        delete data;
        api_->freeCore(core);  // no script owns it yet on this failure path
        return false;
    }

    script_ = sapi_->createScript(core);
    VSMap* vars = api_->createMap();
    api_->mapConsumeNode(vars, "source", source_node, maAppend);
    sapi_->setVariables(script_, vars);
    api_->freeMap(vars);

    // Helper to mark this (key, dims, radius) as failed so the next open()
    // call with identical inputs short-circuits silently. Logs ONCE here on
    // first failure; subsequent identical opens won't log again.
    auto record_failure = [&]() {
        failed_key_    = cache_key;
        failed_width_  = cfg.width;
        failed_height_ = cfg.height;
        failed_radius_ = cfg.radius;
    };

    if (sapi_->evaluateBuffer(script_, vs_script.c_str(), "ChainComposed.vpy")) {
        last_error_ = sapi_->getError(script_);
        log::error("vs_runtime", "evaluateBuffer failed: " + last_error_);
        sapi_->freeScript(script_);
        script_ = nullptr;
        record_failure();
        return false;
    }

    node_ = sapi_->getOutputNode(script_, 0);
    if (!node_) {
        last_error_ = "Script did not set_output()";
        log::error("vs_runtime", last_error_);
        sapi_->freeScript(script_);
        script_ = nullptr;
        record_failure();
        return false;
    }

    const VSVideoInfo* out_vi = api_->getVideoInfo(node_);
    if (out_vi->width != cfg.width
        || out_vi->height != cfg.height
        || out_vi->format.bitsPerSample != 32
        || out_vi->format.sampleType != stFloat) {
        last_error_ = "Script output node does not match expected dimensions / float32";
        log::error("vs_runtime", last_error_);
        api_->freeNode(node_);
        node_ = nullptr;
        sapi_->freeScript(script_);
        script_ = nullptr;
        record_failure();
        return false;
    }

    core_ = core;
    cached_key_ = cache_key;
    cached_width_ = cfg.width;
    cached_height_ = cfg.height;
    cached_radius_ = cfg.radius;
    // C06 (2026-11-11): record the graph's OWN cadence/length — the timing
    // contract (rate-match enforcement, end-of-clip clamp) reads these.
    cached_fps_num_ = out_vi->fpsNum;
    cached_fps_den_ = out_vi->fpsDen;
    cached_num_frames_ = out_vi->numFrames;
    // The script we just successfully opened might be a CORRECTED version of
    // one that previously failed. Clear the failure marker so future identical
    // failures still get one fresh log line.
    failed_key_.clear();
    failed_width_ = failed_height_ = failed_radius_ = -1;
    last_error_.clear();
    log::info("vs_runtime", "VS pipeline ready: " + std::to_string(cfg.width) + "x"
                            + std::to_string(cfg.height) + " key=" + cache_key.substr(0, 32) + "...");
    return true;
}

const VSFrame* VsRuntime::get_frame(int frame_index, std::string* out_error) {
    if (!is_open()) {
        if (out_error) *out_error = "VS pipeline not open";
        return nullptr;
    }
    char err[1024]{};
    const VSFrame* f = api_->getFrame(frame_index, node_, err, sizeof(err));
    if (!f) {
        last_error_ = err;
        if (out_error) *out_error = last_error_;
    }
    return f;
}

}  // namespace vsres::macos
