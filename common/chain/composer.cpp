#include "composer.h"
#include "../config/config.h"
#include "../filters/filter_registry.h"
#include "../logging/log.h"

#include <algorithm>
#include <cctype>
#include <cstdio>
#include <set>
#include <sstream>

namespace vsres {

namespace {

// ── Python-source safety (2026-11-05, security review #1 + correctness review C11) ────────
// Media paths and user/imported labels are NEVER interpolated raw into
// composed Python: a filename like  x'); <stmt>; #  previously terminated
// the string literal and injected a statement (and a plain apostrophe
// broke both composers). Paths are now emitted as hex bytes and decoded
// with surrogateescape; labels are flattened to a single line.
std::string py_hex(const std::string& raw) {
    std::string hex;
    char buf[3];
    for (unsigned char ch : raw) {
        std::snprintf(buf, sizeof buf, "%02x", ch);
        hex += buf;
    }
    return hex;
}

std::string py_bytes_path_stmt(const std::string& var, const std::string& raw) {
    // var = bytes.fromhex('..').decode('utf-8', 'surrogateescape')
    std::ostringstream os;
    os << var << " = bytes.fromhex('" << py_hex(raw)
       << "').decode('utf-8', 'surrogateescape')\n";
    return os.str();
}

std::string sanitize_comment(const std::string& s) {
    // Comments must stay on ONE line: replace every control char (newline,
    // CR, tab, other C0) with a space. Injection via labels/recipe fields
    // can then never leave the comment.
    std::string out = s;
    for (char& ch : out) {
        unsigned char u = static_cast<unsigned char>(ch);
        if (u < 0x20 || u == 0x7f) ch = ' ';
    }
    return out;
}

ColorManagement parse_color_management(const config::Json& j) {
    ColorManagement cm;
    if (!j.is_object()) return cm;
    cm.input_color_space  = j.value("inputColorSpace",  cm.input_color_space);
    cm.input_gamma        = j.value("inputGamma",       cm.input_gamma);
    cm.output_color_space = j.value("outputColorSpace", cm.output_color_space);
    cm.output_gamma       = j.value("outputGamma",      cm.output_gamma);
    cm.ocio_config        = j.value("ocioConfig",       cm.ocio_config);
    return cm;
}

config::Json serialize_color_management(const ColorManagement& cm) {
    return {
        {"inputColorSpace",  cm.input_color_space},
        {"inputGamma",       cm.input_gamma},
        {"outputColorSpace", cm.output_color_space},
        {"outputGamma",      cm.output_gamma},
        {"ocioConfig",       cm.ocio_config},
    };
}

ChainStep parse_step(const config::Json& j) {
    ChainStep s;
    s.id          = (j.contains("id") && j.at("id").is_string())
                    ? j.at("id").get<std::string>() : std::string{};
    s.type        = (j.contains("type") && j.at("type").is_string())
                    ? j.at("type").get<std::string>() : std::string{};
    s.stage       = (j.contains("stage") && j.at("stage").is_number_integer())
                    ? j.at("stage").get<int>() : 10;
    s.enabled     = (j.contains("enabled") && j.at("enabled").is_boolean())
                    ? j.at("enabled").get<bool>() : true;
    // FAIL CLOSED (security re-review, 2026-11-05): approval is content-bound
    // and is NEVER presumed. A missing or non-boolean `approved`, a missing
    // `approvedContent` binding, or a binding that no longer equals the
    // emitted body means the step does not run — the companion surfaces it
    // as awaiting approval. (Previously a missing field defaulted to
    // approved=true for legacy chains; that compatibility default is
    // deliberately removed.)
    s.approved    = (j.contains("approved") && j.at("approved").is_boolean())
                    ? j.at("approved").get<bool>() : false;
    s.version     = (j.contains("version") && j.at("version").is_number_integer())
                    ? j.at("version").get<int>() : 1;
    // The exact executable body this approval was granted for (byte-compare
    // at composition/status time). Non-string or absent → no binding.
    s.approved_content = (j.contains("approvedContent") && j.at("approvedContent").is_string())
                    ? j.at("approvedContent").get<std::string>() : std::string{};
    if (j.contains("params")) {
        s.params_json = j.at("params").dump();
    } else {
        s.params_json = "{}";
    }
    return s;
}

config::Json serialize_step(const ChainStep& s) {
    config::Json params = config::Json::object();
    try {
        params = config::Json::parse(s.params_json);
    } catch (...) {
        // leave as empty object
    }
    return {
        {"id",       s.id},
        {"type",     s.type},
        {"stage",    s.stage},
        {"enabled",  s.enabled},
        {"approved", s.approved},
        {"approvedContent", s.approved_content},
        {"version",  s.version},
        {"params",   params},
    };
}

// Single source of truth for the per-step gate (compose_script and
// summarize_chain both route through this). Emits the fragment — the
// content binding is defined as a byte-compare against the emitted body,
// so the emission is required regardless — and classifies the step.
enum class Gate { Emittable, Unapproved, Unknown };

Gate gate_step(const ChainStep& s, const StepContext& ctx, ScriptFragment* frag) {
    const IFilter* f = FilterRegistry::instance().find(s.type);
    if (!f) return Gate::Unknown;
    StepParams p{s.params_json};
    *frag = f->emit(p, ctx);
    // APPROVAL BINDS CONTENT (security re-review, 2026-11-05): the stored
    // approval must match the body this exact composition emits. A stale
    // flag on changed parameters/code is NOT permission to run.
    if (s.approved && !s.approved_content.empty() && s.approved_content == frag->body)
        return Gate::Emittable;
    return Gate::Unapproved;
}

}  // namespace

Chain parse_chain(const std::string& config_json) {
    Chain c;
    auto j = config::parse(config_json);
    if (!j.is_object() || j.empty()) return c;

    c.schema_version = j.value("schemaVersion", 1);
    c.node_id        = j.value("nodeId", std::string{});
    c.node_guid      = j.value("nodeGuid", std::string{});
    c.manual_order   = j.value("manualOrder", false);
    c.mix            = j.value("mix", 1.0f);

    if (j.contains("colorManagement")) {
        c.color = parse_color_management(j.at("colorManagement"));
    }

    if (j.contains("chain") && j.at("chain").is_array()) {
        for (const auto& step_json : j.at("chain")) {
            c.steps.push_back(parse_step(step_json));
        }
    }

    // TKT-SRC: hydrate the source-mode config from clipMetadata.source.
    // The composer itself doesn't VALIDATE the source file's existence or
    // hash — that's plugin_entry.cpp's job before it calls compose_script.
    // Here we just extract the path + trim points so compose_script can
    // emit the right Python. plugin_entry overrides c.source_mode.mode
    // based on its file-integrity checks before passing the Chain in.
    if (j.contains("clipMetadata") && j.at("clipMetadata").is_object()) {
        const auto& cm = j.at("clipMetadata");
        if (cm.contains("source") && cm.at("source").is_object()) {
            const auto& src = cm.at("source");
            c.source_mode.source_file_path = src.value("filePath", std::string{});
            // sourceInPoint / sourceOutPoint are nullable on the TS side; default
            // to the full source range when null. plugin_entry compares the trim
            // window against probed clip range to decide ActiveTrimmed vs Active.
            if (src.contains("sourceInPoint") && src.at("sourceInPoint").is_number_integer()) {
                c.source_mode.source_in_point = src.at("sourceInPoint").get<int>();
            }
            if (src.contains("sourceOutPoint") && src.at("sourceOutPoint").is_number_integer()) {
                c.source_mode.source_out_point = src.at("sourceOutPoint").get<int>();
            }
            // retimeDetected is set by the popout from the Resolve scripting
            // API when it can see the clip's retime curve. plugin_entry uses
            // this to decide RetimeDisabled vs Active.
            // Recorded probe fingerprints (sourceSize / sourceMtimeMs from the
            // companion's chunk-hash probe) let plugin_entry detect a changed
            // file and refuse to render a stale trim mapping.
            if (src.contains("sourceSize") && src.at("sourceSize").is_number_integer()) {
                c.source_mode.source_size = src.at("sourceSize").get<int64_t>();
            }
            if (src.contains("sourceMtimeMs") && src.at("sourceMtimeMs").is_number_integer()) {
                c.source_mode.source_mtime_ms = src.at("sourceMtimeMs").get<int64_t>();
            }
        }
        if (cm.contains("timeline") && cm.at("timeline").is_object()) {
            const auto& tl = cm.at("timeline");
            if (tl.contains("width")  && tl.at("width").is_number_integer())  c.source_mode.timeline_width  = tl.at("width").get<int>();
            if (tl.contains("height") && tl.at("height").is_number_integer()) c.source_mode.timeline_height = tl.at("height").get<int>();
        }
    }

    return c;
}

std::string serialize_chain(const Chain& chain) {
    config::Json j;
    j["schemaVersion"]   = chain.schema_version;
    j["nodeId"]          = chain.node_id;
    if (!chain.node_guid.empty()) j["nodeGuid"] = chain.node_guid;
    j["manualOrder"]     = chain.manual_order;
    j["mix"]             = chain.mix;
    j["colorManagement"] = serialize_color_management(chain.color);

    config::Json arr = config::Json::array();
    for (const auto& step : chain.steps) {
        arr.push_back(serialize_step(step));
    }
    j["chain"] = std::move(arr);

    return config::serialize_compact(j);
}

std::string compose_script(const Chain& chain, const StepContext& ctx, ComposeStats* stats) {
    if (stats) *stats = ComposeStats{};
    if (stats) stats->total = static_cast<int>(chain.steps.size());

    // Candidates keep chain order until the stage sort; the gate (enabled +
    // content-bound approval + known filter) is evaluated during this pass so
    // `stats` reflects exactly what the emitted script contains.
    struct Candidate {
        const ChainStep* step;
        ScriptFragment frag;
        bool emittable;
    };
    std::vector<Candidate> candidates;
    candidates.reserve(chain.steps.size());
    for (const auto& s : chain.steps) {
        if (!s.enabled) continue;
        if (stats) ++stats->enabled;
        ScriptFragment frag;
        const Gate gate = gate_step(s, ctx, &frag);
        const bool emittable = gate == Gate::Emittable;
        if (gate == Gate::Unknown) {
            if (stats) ++stats->unknown;
            log::warn("composer", "unknown filter type: " + s.type);
        } else if (!emittable) {
            if (stats) ++stats->unapproved;
            // Honest diagnostics: distinguishes "never approved" from
            // "approval no longer matches the content".
            log::warn("composer", "step " + s.id + " (" + s.type + ") skipped: "
                + (s.approved ? "approval does not match current content"
                              : "not approved"));
        } else {
            if (stats) ++stats->emitted;
        }
        candidates.push_back(Candidate{&s, std::move(frag), emittable});
    }
    if (!chain.manual_order) {
        std::stable_sort(candidates.begin(), candidates.end(),
                         [](const Candidate& a, const Candidate& b) { return a.step->stage < b.step->stage; });
    }

    std::set<std::string> imports;
    // Section bodies carry stage + label so the section headers in the emitted
    // script name what each block is (Script view ties them to chain cards).
    std::vector<std::pair<const ChainStep*, ScriptFragment>> bodies;
    bodies.reserve(candidates.size());
    for (auto& c : candidates) {
        if (!c.emittable) continue;
        if (!c.frag.imports.empty()) imports.insert(c.frag.imports);
        bodies.emplace_back(c.step, std::move(c.frag));
    }

    std::ostringstream py;

    // Inject sys.path entries so Python (the interpreter VSScript embeds) can find
    // the modules QTGMC etc. need — havsfunc, mvsfunc, adjust. Users install those
    // via scripts/install-vs-ecosystem.sh which drops them into either:
    //   ~/Library/Application Support/VapourSynth-OFX/vs-python/   (per-user)
    //   /Library/Application Support/VapourSynth-OFX/vs-python/    (system)
    // POSTURE (security review #5 decision, 2026-11-11): both locations are APPENDED
    // as fallbacks so either works — never prepended. Machine-dir modules may
    // satisfy a MISSING import but can never shadow the staged bundle's
    // reviewed helpers or the interpreter's own resolution.
    // The os.path.expanduser handles the
    // user-home expansion since the OFX plugin runs in Resolve's process and may
    // not have HOME set the way an interactive shell does.
    py <<
        "import sys, os\n"
        "for _vsr in [\n"
        "    os.path.expanduser('~/Library/Application Support/VapourSynth-OFX/vs-python'),\n"
        "    '/Library/Application Support/VapourSynth-OFX/vs-python',\n"
        "]:\n"
        "    if _vsr not in sys.path:\n"
        "        sys.path.append(_vsr)\n";
    py << "import vapoursynth as vs\n";
    py << "core = vs.core\n";
    // Auto-import the Python helper modules the Archivist's scripts conventionally
    // assume are in scope. The system prompt tells the model not to re-import
    // these, so the composer MUST inject them or every QTGMC / Depth / ToRGB
    // call dies with NameError. Wrapped in try-blocks so a missing optional
    // module (nnedi3_resample) doesn't kill the chain.
    py << "import havsfunc\n";        // QTGMC, srestore, deinterlacing recipes
    py << "havs = havsfunc\n";        // alias — docs + Archivist + native nodes write `havs.QTGMC(...)`;
                                      // without this line those scripts die with "name 'havs' is not defined"
    py << "import mvsfunc as mvf\n";  // Depth, ToRGB, ToYUV — color-space + bit-depth helpers
    py << "import adjust\n";          // Tweak — gamma / hue / saturation tweaks (used by some QTGMC variants)
    py << "try:\n    import nnedi3_resample\nexcept ImportError:\n    nnedi3_resample = None\n";
    // CORRECTNESS (2026-11-05, correctness review C08): the draft preamble has a guarded
    // vsmlrt import; the native preamble did not — a RIFE step emitted
    // `vsmlrt.RIFE(...)` into a fresh evaluation where `vsmlrt` was an
    // undefined global. Mirror the draft's guarded import exactly (vsmlrt
    // can raise non-ImportError on machines without its ONNX paths — it is
    // optional; failure must not kill the chain).
    py << "try:\n    import vsmlrt\nexcept ImportError:\n    vsmlrt = None\n"
          "except Exception:\n    vsmlrt = None\n";
    for (const auto& imp : imports) py << imp;
    py << "\n";

    // Helper functions in scope for every chain step. Filter scripts can drop
    // back to RGB for color-grading-style ops, change bit depth for picky
    // filters, or convert to a different chroma subsampling. The composer's
    // input/output transforms call mvf.ToYUV/ToRGB directly; these are the
    // user-facing equivalents with sane defaults.
    py <<
        "def to_yuv(c, css='420', depth=16, matrix='709'):\n"
        "    \"\"\"Any → YUV<css>P<depth>. Default = YUV420P16 (QTGMC-ready).\"\"\"\n"
        "    return mvf.ToYUV(c, css=css, depth=depth, matrix=matrix)\n"
        "def to_rgb(c, depth=32, matrix='709'):\n"
        "    \"\"\"YUV → RGB<depth>. Default = RGBS (32-bit float, Resolve-native).\"\"\"\n"
        "    return mvf.ToRGB(c, depth=depth, matrix=matrix)\n"
        "def to8(c):  return mvf.Depth(c, depth=8)\n"
        "def to10(c): return mvf.Depth(c, depth=10)\n"
        "def to16(c): return mvf.Depth(c, depth=16)\n"
        "def to32(c): return mvf.Depth(c, depth=32, sample=vs.FLOAT)\n"
        "\n";

    // SECTIONED OUTPUT (Oct 27): consistent named sections so the composed
    // script is visually organized and the Script view can tie code to chain
    // stages: ── SOURCE ── / ── INPUT ── / ── STEP n: <label> ── / ── OUTPUT ──.
    // Comments only — formatting never changes execution.
    py << "# ══════════ SOURCE ══════════\n";
    // TKT-SRC: branch the source binding. In timeline mode (Disabled fallback)
    // we use the OFX-registered `source` filter as before — VS pulls already-
    // conformed frames from Resolve via fetchImage. In source-mode (Active /
    // ActiveTrimmed) we bypass Resolve entirely and have VS load the source
    // file directly via lsmas. This is the QTGMC-fix path: mv.Super needs
    // whole-clip random access for its motion-search pyramid, which
    // Resolve's getFramesNeeded window doesn't provide.
    switch (chain.source_mode.mode) {
        case SourceMode::Active: {
            // Direct-load the source file. lsmas/LWLibavSource returns native
            // format (YUV411P8 for DV-NTSC, YUV422P10 for ProRes422HQ, etc.).
            // Phase 3 will preserve that all the way through the chain;
            // Phase 2 still routes through the existing input transform's
            // mvf.ToYUV YUV420P16 normalization (existing behavior) so QTGMC
            // works today, then we drop the coercion in Phase 3.
            // SECURITY: the path is emitted as HEX bytes (never raw) — see
            // py_bytes_path_stmt above; a crafted filename cannot alter the
            // script, and apostrophes/quotes/UTF-8 round-trip exactly.
            py << py_bytes_path_stmt("_vsres_src_path",
                                     chain.source_mode.source_file_path);
            py << "src = core.lsmas.LWLibavSource(_vsres_src_path)\n";
            // Tell VS the framerate is what lsmas reports (preserve metadata).
            // Resolve's expected output framerate is handled at the final
            // output stage in Phase 4 / TKT-SRC's Frame Ops adapter.
            break;
        }
        case SourceMode::ActiveTrimmed: {
            py << py_bytes_path_stmt("_vsres_src_path",
                                     chain.source_mode.source_file_path);
            py << "src = core.lsmas.LWLibavSource(_vsres_src_path)\n";
            py << "src = core.std.Trim(src, first="
               << chain.source_mode.source_in_point << ", last="
               << chain.source_mode.source_out_point << ")\n";
            break;
        }
        case SourceMode::Disabled:
        case SourceMode::RetimeDisabled:
        case SourceMode::FileMissing:
        case SourceMode::FileChanged:
        default:
            // OFX-driven source (current behavior). The C++ side handles the
            // FileMissing / FileChanged paths BEFORE compose_script is called
            // — those produce error frames, not a script — so reaching here
            // means we just fell back to timeline mode.
            py << "src = source\n";
            break;
    }
    py << "# ══════════ INPUT ══════════\n";
    // vs_input_transform_fragment assigns `clip = mvf.ToYUV(src, ...)` directly
    // so the user's first step gets a YUV420P16 clip ready for QTGMC/BM3D/etc.
    // No more `clip = src` here — that would clobber the conversion.
    py << vs_input_transform_fragment(chain.color);

    for (size_t i = 0; i < bodies.size(); ++i) {
        const auto* step = bodies[i].first;
        const auto& frag = bodies[i].second;
        // Label from the step's params when present; else the type.
        // SECURITY (security review #1 route 2): labels can arrive from imported
        // recipes; sanitize_comment flattens control chars so a label can
        // never break out of this comment line.
        std::string label = step->type;
        try {
            auto pj = config::parse(step->params_json);
            if (pj.contains("label") && pj.at("label").is_string())
                label = pj.at("label").get<std::string>();
        } catch (...) { /* optional label */ }
        py << "\n# ══════════ STEP " << (i + 1) << " / " << bodies.size()
           << " · stage " << step->stage << " · " << sanitize_comment(label)
           << " ══════════\n";
        py << frag.body;
    }

    py << "\n# ══════════ OUTPUT ══════════\n";
    if (chain.mix < 1.0f) {
        // Mix happens in whatever color space `clip` ended up in. Convert
        // `src` to match so std.Merge doesn't fail on format mismatch.
        py << "_mix_ref = src\n";
        py << "if clip.format.id != _mix_ref.format.id:\n";
        py << "    _mix_ref = core.resize.Bicubic(src, format=clip.format.id, matrix_s='709')\n";
        py << "clip = core.std.Merge(_mix_ref, clip, weight=" << chain.mix << ")\n";
    }
    py << vs_output_transform_fragment(chain.color);

    // TKT-SRC: in source-mode the chain ran at SOURCE dimensions (e.g. 720x480
    // for NTSC DV) but Resolve expects TIMELINE dimensions (e.g. 1920x1080)
    // back from the OFX render. Final upscale via Spline36 — council's pick
    // for restoration work (good detail preservation, less ringing than
    // Lanczos on small-to-large upscales).
    const bool source_mode_active =
        chain.source_mode.mode == SourceMode::Active ||
        chain.source_mode.mode == SourceMode::ActiveTrimmed;
    if (source_mode_active
        && chain.source_mode.timeline_width  > 0
        && chain.source_mode.timeline_height > 0) {
        py << "# TKT-SRC: source-mode final upscale to timeline dims\n";
        py << "if clip.width != " << chain.source_mode.timeline_width
           << " or clip.height != " << chain.source_mode.timeline_height << ":\n";
        py << "    clip = core.resize.Spline36(clip, width="
           << chain.source_mode.timeline_width << ", height="
           << chain.source_mode.timeline_height << ")\n";
    }

    py << "clip.set_output()\n";
    return py.str();
}

ComposeStats summarize_chain(const Chain& chain, const StepContext& ctx) {
    ComposeStats stats;
    stats.total = static_cast<int>(chain.steps.size());
    for (const auto& s : chain.steps) {
        if (!s.enabled) continue;
        ++stats.enabled;
        ScriptFragment frag;
        switch (gate_step(s, ctx, &frag)) {
            case Gate::Emittable: ++stats.emitted; break;
            case Gate::Unapproved: ++stats.unapproved; break;
            case Gate::Unknown:    ++stats.unknown;    break;
        }
    }
    return stats;
}

}  // namespace vsres
