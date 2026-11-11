// Portable-bundle smoke test — headless, no Resolve.
//
// Verifies the VSRES_PORTABLE_BUNDLE staging end to end:
//   1. dlopen the bundle's Contents/Libraries/libvsscript.dylib (the path the
//      .ofx references via @loader_path) and resolve the VSScript API.
//   2. VSScript's realInit resolves CPython through
//      $HOME/.config/vapoursynth/vapoursynth.toml keyed by the loaded
//      libvsscript path — we point it at the bundle's embedded Python
//      framework, never the user's config.
//   3. Evaluate a BlankClip script through the bundle's embedded
//      Resources/vs-python package (PYTHONPATH) and render one frame via
//      libvapoursynth (no external plugins needed).
//
// Exit 0 = the portable payload works outside the build tree's absolute
// paths. It does NOT qualify Resolve hosting, signing, or other-Mac deps.
//
// Usage: portable_smoke <bundle_dir> <python_exe> <python_lib>
//   bundle_dir — staging bundle root (…/VapourSynth.ofx.bundle)
//   python_exe — embedded framework bin (…/Frameworks/Python.framework/Versions/X.Y/bin/pythonX.Y)
//   python_lib — embedded framework dylib (…/Versions/X.Y/Python)

#include <vapoursynth/VapourSynth4.h>
#include <vapoursynth/VSScript4.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>
#include <sys/stat.h>
#include <fstream>
#include <dlfcn.h>
#include <unistd.h>
#include <climits>

namespace {

int fail(const std::string& msg) {
    std::fprintf(stderr, "FAIL: %s\n", msg.c_str());
    return 1;
}

// VSScript's TOML key is the dladdr-resolved absolute path of the loaded
// libvsscript; canonicalize every input so the key matches exactly.
std::string resolve_path(const std::string& p) {
    char resolved[PATH_MAX] = {0};
    if (!realpath(p.c_str(), resolved)) return p;
    return std::string(resolved);
}

bool write_toml(const std::string& home, const std::string& vsscript_path,
                const std::string& py_exe, const std::string& py_lib) {
    const std::string config_dir = home + "/.config/vapoursynth";
    std::string mkdir_cmd = "mkdir -p '" + config_dir + "'";
    if (std::system(mkdir_cmd.c_str()) != 0) return false;
    const std::string toml = config_dir + "/vapoursynth.toml";
    std::ofstream out(toml, std::ios::trunc);
    if (!out.is_open()) return false;
    out << "\"" << vsscript_path << "\" = [\"" << py_exe << "\",\"" << py_lib << "\"]\n";
    return true;
}

}  // namespace

int main(int argc, char** argv) {
    if (argc != 4) return fail("usage: portable_smoke <bundle_dir> <python_exe> <python_lib>");
    const std::string bundle = resolve_path(argv[1]);
    const std::string py_exe = resolve_path(argv[2]);
    const std::string py_lib = resolve_path(argv[3]);

    const std::string libs = bundle + "/Contents/Libraries/libvsscript.dylib";
    const std::string vs_python = bundle + "/Contents/Resources/vs-python";
    struct stat st {};
    if (stat(libs.c_str(), &st) != 0) return fail("missing " + libs);
    if (stat(vs_python.c_str(), &st) != 0) return fail("missing " + vs_python);
    if (stat(py_exe.c_str(), &st) != 0) return fail("missing " + py_exe);
    if (stat(py_lib.c_str(), &st) != 0) return fail("missing " + py_lib);

    // Isolated HOME: VSScript reads $HOME/.config/vapoursynth/vapoursynth.toml
    // keyed by the loaded libvsscript path. Point it at the embedded framework
    // so this verifies the bundle payload, not this machine's dev config.
    std::string tmp_home = "/tmp/vsres-portable-smoke.XXXXXX";
    std::vector<char> tmpl(tmp_home.begin(), tmp_home.end());
    tmpl.push_back('\0');
    if (mkdtemp(tmpl.data()) == nullptr) return fail("mkdtemp failed");
    tmp_home = tmpl.data();
    if (!write_toml(tmp_home, libs, py_exe, py_lib))
        return fail("could not write isolated vapoursynth.toml");
    setenv("HOME", tmp_home.c_str(), 1);
    setenv("PYTHONPATH", vs_python.c_str(), 1);

    // VSScript resolves Python inside getVSScriptAPI → realInit.
    void* handle = dlopen(libs.c_str(), RTLD_NOW);
    if (!handle) return fail("dlopen libvsscript: " + std::string(dlerror() ? dlerror() : "?"));
    using GetVSScriptAPIFn = const VSSCRIPTAPI* (*)(int) noexcept;
    auto* get_api = reinterpret_cast<GetVSScriptAPIFn>(dlsym(handle, "getVSScriptAPI"));
    if (!get_api) return fail("getVSScriptAPI not exported");
    const VSSCRIPTAPI* sapi = get_api(VSSCRIPT_API_VERSION);
    if (!sapi) {
        // Resolved via dlsym (not linked): the smoke must not grow a link-time
        // dependency on the bundle's dylib — everything loads at runtime.
        using LastErrorFn = const char* (*)();
        auto last_error = reinterpret_cast<LastErrorFn>(dlsym(handle, "getVSScriptAPILastError"));
        const char* detail = last_error ? last_error() : nullptr;
        return fail(std::string("VSScript init failed: ") + (detail ? detail : "no detail"));
    }
    const VSAPI* api = sapi->getVSAPI(VAPOURSYNTH_API_VERSION);
    if (!api) return fail("VSAPI unavailable");

    VSCore* core = api->createCore(0);
    if (!core) return fail("createCore");
    VSScript* script = sapi->createScript(core);
    if (!script) return fail("createScript");

    const char* blank = "import vapoursynth as vs\n"
                        "core = vs.core\n"
                        "clip = core.std.BlankClip(width=64, height=64, format=vs.YUV420P8, length=4)\n"
                        "clip.set_output()\n";
    if (sapi->evaluateBuffer(script, blank, "portable_smoke.vpy")) {
        const std::string err = sapi->getError(script) ? sapi->getError(script) : "(none)";
        sapi->freeScript(script);
        api->freeCore(core);
        return fail("evaluateBuffer: " + err);
    }
    VSNode* node = sapi->getOutputNode(script, 0);
    if (!node) return fail("script set no output");
    char ferr[512] = {0};
    const VSFrame* frame = api->getFrame(0, node, ferr, sizeof(ferr));
    const bool ok = frame != nullptr;
    if (frame) api->freeFrame(frame);
    sapi->freeScript(script);  // frees core with it (script-owned)
    if (!ok) return fail(std::string("getFrame: ") + ferr);

    std::printf("PASS: portable bundle evaluates and renders via embedded runtime\n"
                "  libvsscript: %s\n  vs-python:   %s\n  python:      %s\n",
                libs.c_str(), vs_python.c_str(), py_lib.c_str());
    return 0;
}