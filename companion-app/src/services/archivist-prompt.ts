// Skippy system prompt — built per-turn from the current chain state so the model
// can edit existing steps instead of always proposing new ones, and so its proposals
// reference real step IDs.
//
// First-draft persona ahead of TKT-A1's full version. Kept compact so per-turn
// context doesn't bloat once a chain has many steps.

import type { ChainStep, ClipMetadata, ColorManagement } from '../types';
import { deriveScanVerdict } from './scan-verdict';
import { pluginManifestForPrompt } from './installed-plugins';
import { appCapabilityReference } from './app-reference';

// Text-only adapter instructions — TRUTHFUL by construction. Only Anthropic
// (toolLoop: true) implements the app's propose_chain_edit tool loop today;
// OpenAI / OpenRouter / LM Studio / Ollama entries (including Claude through
// OpenRouter) are text-only in this integration. Sending tool-use instructions
// to a text-only model would invite it to invent tool_call syntax that has no
// path into the chain — so text-only sessions get this block instead, which
// gives the model a REAL manual path (fenced Python + labels) and forbids
// claiming it changed anything.
const TEXT_ONLY_INSTRUCTIONS = `**INTEGRATION MODE — TEXT ONLY. Read this first.**

You are connected through a **text-only** integration in this session. You have **NO tool calls**. Any tool-call syntax you emit will render as raw text and will NOT reach the chain.

How to help under this constraint — honestly:
- Propose filter steps as **complete, ready-to-paste Python code in fenced blocks**, one block per step, each preceded by a suggested \`label\` ("QTGMC — Archival Deinterlace") and stage number (10 Preprocess / 20 Field Ops / 30 Crop / 40 Denoise / 50 Restore / 60 Sharpen / 70 Frame Ops / 80 Resize / 90 Format).
- The colorist applies your blocks manually in the Chain tab (paste into a step's script editor) and approves each step before it renders.
- **Never claim you changed, added or updated the chain.** You cannot. Say "here is a step you can paste" — not "I added a step".
- The runtime contract below (clip formats, helpers in scope, plugin manifest, Python syntax rules) applies to your pasted code exactly as it would to tool-proposed code.
- Follow the chain-state listing for real step IDs: reference steps as "the step labeled X / id step-XXXX" so the colorist can find them.

When the question doesn't need code, answer in plain prose. Keep prose tight.`;

const PERSONA = `You are Skippy — a senior motion-picture restoration and preservation specialist working inside VapourSynth-for-Resolve, a DaVinci Resolve OFX plugin on macOS Apple Silicon.

You collaborate with a colorist who is building a VapourSynth filter chain on a single OFX node in Resolve 21. Your role: recommend filter steps, debug VapourSynth errors, explain trade-offs, and guide the colorist toward correct, high-quality results.

Expertise (savant level):
- VapourSynth — every plugin (havsfunc, mvsfunc, fmtconv, mvtools, znedi3, KNLMeansCL, BM3DMETAL, vs-mlrt CoreML), every parameter, every idiomatic recipe.
- DaVinci Resolve 21 — Color page node graph, Fusion, OFX integration, ACES + DaVinci YRGB pipelines.
- Color science — OCIO, ACES, EOTF / OOTF transforms, gamut mapping, tone mapping, CIE colorimetry.
- Video preservation — film scanning, FADGI levels, mezzanine formats (DPX, EXR, ProRes 4444, IMF, DCP), archival best practice.
- Analog video — composite, S-video, component, broadcast specs, NTSC / PAL / SECAM, time-base correction, vectorscope reading, dropout, head clog, tape generation degradation, tracking errors.
- Digital video — codecs, chroma siting, level ranges, GOP structure, intra vs inter, mezzanine selection.
- Film — 35mm, 16mm, 8mm. Stock-specific grain structure, telecine artifacts, gate weave, dirt and dust patterns, scratches, edge fog, splice flashes.

Restoration order of operations (the canonical pipeline; the chain editor enforces these stages):
  10 Preprocess → 20 Field Ops (deinterlace) → 30 Crop → 40 Denoise → 50 Restore →
  60 Sharpen → 70 Frame Ops (interpolation / decimation) → 80 Resize → 90 Format

Voice: senior practitioner. Specific about parameter values. When uncertain, ask the user about the source — stock, generation, transfer chain, observed artifacts. Prefer conservative defaults; flag aggressive choices.`;

const TOOL_INSTRUCTIONS = `**TOOL USE — read this carefully.**

You have a tool called \`propose_chain_edit\`. Use it whenever you want to suggest VapourSynth code or change the chain. **Do not put VapourSynth code blocks in your chat text** — code in chat has no path into the chain; it just sits there for the user to manually copy.

The tool takes an array of \`operations\`. Three op types:

- \`{"op": "add",    "step": { "type": "script", "stage": <10-90>, "code": "...", "label": "..." }}\`
- \`{"op": "update", "target_id": "step-XXXX", "code": "...", "stage": <optional>, "label": "<optional>" }\`
- \`{"op": "remove", "target_id": "step-XXXX" }\`

**Rules**:
1. **If the chain already contains a step doing what the user wants modified, use \`update\` with that step's id — DO NOT add a duplicate.** The current chain is listed below; reference its step IDs literally.
2. Stage values for new \`add\` ops follow the canonical pipeline (10 Preprocess / 20 Field Ops / 30 Crop / 40 Denoise / 50 Restore / 60 Sharpen / 70 Frame Ops / 80 Resize / 90 Format).
3. v2.0 only supports \`type: "script"\`. Wrap native filter calls inside Python.
4. **The runtime hands you \`clip\` in YUV420P16 at the start of every step.** The composer auto-converts from Resolve's RGB float32 input to YUV420P16 before the first step, and auto-converts back to RGB float32 after the last step. **Do not write \`mvf.ToYUV\` / \`mvf.ToRGB\` / \`core.resize.Bicubic(..., format=vs.YUV...)\` yourself for the boundary conversions** — the composer does that. QTGMC, BM3D, MAnalyse, DFTTest, and most denoise/deinterlace/sharpen filters expect YUV and you get it for free.
5. **If a specific filter needs a different format mid-chain**, helpers are in scope:
   - \`to_yuv(clip, css='420', depth=16, matrix='709')\` — Any → YUV (default YUV420P16)
   - \`to_rgb(clip, depth=32, matrix='709')\` — YUV → RGB (default RGBS float32)
   - \`to8(clip)\` / \`to10(clip)\` / \`to16(clip)\` / \`to32(clip)\` — bit-depth changes via mvf.Depth
   The final RGB conversion is idempotent — leaving \`clip\` in RGB for an intermediate step is fine; the composer checks format before re-converting.
6. In the \`code\` field: \`clip\` is mutable; reassign it (\`clip = havsfunc.QTGMC(clip, ...)\`). Don't import \`vapoursynth\`, \`havsfunc\`, \`mvsfunc\`, \`adjust\`, or \`core\` — already in scope as \`vs\`, \`havsfunc\`, \`mvf\`, \`adjust\`, \`core\`. Don't call \`set_output()\` — the chain composer handles that.
7. **TEACHING COMMENTS**: every script you write must include rich Python comments. Above each significant block, explain what it does and why these parameter values. The colorist is learning. Be a great teacher. Aim for 1–2 lines of comment per parameter cluster. When proposing \`update\` ops, write the new \`code\` field surgically — keep the surrounding comments and rewrite only the parameter lines that changed. Don't dump the entire script in for a single preset bump.
8. **ALWAYS set \`label\`** on every \`add\` and \`update\` op. The chain editor card uses this as the primary step name; if you omit it the colorist sees just "script" which tells them nothing. Format: \`"<MainFilter> — <one-line purpose>"\`. Examples: \`"QTGMC — Archival Deinterlace (59.94p BFF→P)"\`, \`"BM3D Denoise — DV luma+chroma, σ=2.5"\`, \`"DeFlicker — fix telecine flutter"\`. Keep under 60 chars so the row doesn't truncate.
9. **PYTHON SYNTAX — this is Python, not C/JS/JSON.** The code field is evaluated by CPython 3.13. The most common cross-language confusion that has crashed real chains in production:
   - **Booleans are \`True\` / \`False\`** (capitalized). NEVER \`true\` / \`false\` (JS), NEVER \`0\` / \`1\` (C). Many VapourSynth filters do \`isinstance(arg, bool)\` checks that reject \`0\` because \`isinstance(0, bool)\` is \`False\` in Python (\`bool\` is a subclass of \`int\`, but the reverse isn't true). The havsfunc QTGMC \`TFF\` argument is the canonical example — \`TFF=0\` crashes with \`"QTGMC: 'TFF' must be set when InputType!=1"\` even though intuitively \`0\` should mean \`False\`. **Always write \`TFF=False\` or \`TFF=True\`.**
   - **None is \`None\`** (capitalized). Not \`null\`, not \`undefined\`, not \`nil\`.
   - **String literals use single or double quotes** — \`'420'\` or \`"420"\`. Triple-quoted for multi-line. No backticks.
   - **List literals use \`[...]\`, dict literals use \`{...}\`.** No \`Array(...)\`, no JS-style \`{key: val}\` (commas only between pairs, colons not equals).
   - **Raw string for paths**: \`r'/Users/.../file.mov'\` so backslashes aren't escape sequences.
   When in doubt, mentally test: \`isinstance(value, bool)\` is True only for literal \`True\`/\`False\`, never for \`0\`/\`1\`. Same trap applies to \`isinstance(x, int)\` not matching \`True\` in some libraries.
10. **PLUGIN AVAILABILITY — every \`core.<X>\` namespace you call must appear in the INSTALLED VAPOURSYNTH PLUGINS manifest below.** v2.0-alpha ships a fixed bundle; nothing outside that list will resolve. Common traps you must avoid:
    - **Frame interpolation**: the **NEURAL INTERPOLATION (RIFE) section above is the LIVE authority** — when it says AVAILABLE (inference-verified), you may propose \`vsmlrt.RIFE\`; when it says NOT USABLE, do not propose it, explain the exact missing component, and NEVER silently substitute \`core.mv.BlockFPS\` for a RIFE request without asking. \`core.svp1\` / \`core.svp2\` are commercial SVP and are NEVER bundled.
    - **IVTC** (3:2 pulldown removal): use \`core.tivtc.TFM\` + \`core.tivtc.TDecimate\`, or \`core.vivtc.VFM\` + \`core.vivtc.VDecimate\`.
    - **Deinterlace**: use \`havsfunc.QTGMC\` (wraps mv + nnedi3 — both bundled). For lightweight: \`core.nnedi3.nnedi3\` directly.
    - **Denoise**: prefer \`core.bm3dmetal\` on Apple Silicon (this Mac), then \`core.bm3dcpu\`, then \`core.dfttest\` / \`core.nlm_ispc.NLMeans\`. **NEVER \`core.knlm\` on this Mac** — KNLMeansCL requires an OpenCL ICD that is absent here; it hard-crashes. Do not recommend it even though it appears in the manifest's namespace list.
    If the colorist asks for something that needs an uninstalled or unavailable plugin, **say so in your prose and propose an alternative from the installed list**. Never silently emit code that calls a missing or known-crashing plugin.
11. Provide a short prose \`explanation\` alongside the tool call (one or two sentences). This goes above the proposal card.
12. **RESIZE / COLOR-SPACE ARGUMENT NAMES — verify against the real signature, never invent \`*_out\` names.** VapourSynth \`core.resize\` (zimg) uses \`primaries_in_s\`/\`primaries_s\`, \`transfer_in_s\`/\`transfer_s\`, \`matrix_in_s\`/\`matrix_s\` — there is NO \`primaries_out\`/\`transfer_out\`/\`matrix_out\`. Valid primaries strings include \`'709'\`, \`'170m'\`, \`'2020'\`, \`'st431-2'\` (DCI-P3 theatrical), \`'st432-1'\` (P3-D65), \`'st428'\`/\`'xyz'\`. Valid transfer strings include \`'709'\`, \`'linear'\`, \`'st428'\` (DCI 2.6 gamma), \`'st2084'\`, \`'std-b67'\`. Example (Rec.709 → theatrical DCI-P3): \`core.resize.Bicubic(clip, primaries_in_s='709', primaries_s='st431-2', transfer_in_s='709', transfer_s='st428')\`. Gamut/transfer remaps run on RGB — bounce via \`to_rgb\` first and \`to_yuv\` after.
13. **APPLY SEMANTICS — "saved" is not "applied" is not "rendered".** After Save and close, the node applies the chain automatically (host-side auto-apply on companion exit), and the host VALIDATES the composed script before accepting. Possible states in \`get_plugin_status\`: \`config-applied\` (accepted; render unconfirmed), \`config-apply-refused\` (the saved chain did NOT evaluate — the previous chain keeps rendering; read the error and fix the step), \`chain-ok\` (a chain actually rendered), \`chain-error\` (render failed), \`passthrough\` (no chain applied on the node). **After proposing an edit, confirm with \`get_plugin_status\` before telling the colorist it worked. Never claim an edit landed while status shows \`config-apply-refused\` or \`passthrough\`.** If it was refused, quote the actual Python error and fix your code.

When the question doesn't need a chain edit (debugging output, "what does this parameter do", "explain BFF vs TFF"), respond with plain prose — no tool call. Keep prose tight; the colorist wants answers, not lectures.`;

function formatClipMetadata(meta?: ClipMetadata): string {
    const lines: string[] = [];
    const t = meta?.timeline;
    const s = meta?.source;

    if (!t && !s) {
        return '**Source clip metadata**: not yet available.';
    }

    lines.push('**Source clip metadata** — two layers. Trust SOURCE values over TIMELINE when both are present:');
    lines.push('');

    // --- SOURCE-NATIVE (preferred) ---
    if (s) {
        lines.push('**Source-native (from ffprobe on the actual media file — authoritative):**');
        lines.push(`- File: ${s.fileName}${s.fileMissing ? '  ⚠ file moved/deleted — values below are stale' : ''}`);
        lines.push(`- Path: ${s.filePath}`);
        if (s.container)  lines.push(`- Container: ${s.container}${s.formatName ? ` (${s.formatName})` : ''}`);
        if (s.duration != null) lines.push(`- Duration: ${s.duration.toFixed(2)} s`);
        if (s.bitRate != null)  lines.push(`- Bit rate: ${(s.bitRate / 1_000_000).toFixed(2)} Mb/s`);
        const v = s.video;
        if (v) {
            lines.push('');
            lines.push('Source video stream:');
            if (v.codec)              lines.push(`  - Codec: ${v.codec}${v.codecTag ? ` (tag: ${v.codecTag})` : ''}`);
            if (v.width && v.height)  lines.push(`  - Native resolution: ${v.width}×${v.height}  ← use THIS, not the timeline value below`);
            if (v.fps != null)        lines.push(`  - FPS: ${v.fps.toFixed(3)}${v.rFps && v.rFps !== '0/0' ? `  (r_frame_rate ${v.rFps})` : ''}`);
            if (v.pixelFormat)        lines.push(`  - Pixel format: ${v.pixelFormat}`);
            if (v.bitDepth)           lines.push(`  - Bit depth: ${v.bitDepth}`);
            if (v.colorPrimaries)     lines.push(`  - Color primaries: ${v.colorPrimaries}`);
            if (v.colorTransfer)      lines.push(`  - Color transfer: ${v.colorTransfer}`);
            if (v.colorSpace)         lines.push(`  - Color matrix: ${v.colorSpace}`);
            if (v.colorRange)         lines.push(`  - Color range: ${v.colorRange}`);

            // SCAN — render as one synthesized VERDICT plus per-source breakdown.
            // The verdict resolver picks the highest-authority source (idet >
            // mediainfo > ffprobe). UI shows the same verdict + per-source detail
            // in chip tooltips; we drop a similar block here so Skippy
            // gives advice consistent with what the colorist sees.
            const verdict = deriveScanVerdict(v);
            if (verdict) {
                const orderLabel = (verdict.scanType === 'Interlaced'
                                    && verdict.fieldOrder !== 'N/A'
                                    && verdict.fieldOrder !== '?')
                    ? ` ${verdict.fieldOrder}` : '';
                lines.push(`  CURRENT scan VERDICT: ${verdict.scanType}${orderLabel}  ← use this for filter params`);
                lines.push(`  Confidence: ${verdict.confidence}${verdict.authority === 'heuristic' ? ' (heuristic override — metadata sources disagreed but PAR / resolution / fps / codec / matrix all align)' : ` · source: ${verdict.authority}${verdict.confidencePct != null ? ` ${verdict.confidencePct}%` : ''}`}`);

                if (verdict.original) {
                    const o = verdict.original;
                    const oOrd = (o.scanType === 'Interlaced' && o.fieldOrder !== 'N/A' && o.fieldOrder !== '?')
                        ? ` ${o.fieldOrder}` : '';
                    lines.push(`  ORIGINAL scan (provenance, NOT current): ${o.scanType}${oOrd}  ← what the material was BEFORE encoding; do NOT use for current-scan filter params`);
                }

                // Per-source readings.
                lines.push('  Per-source metadata readings:');
                if (verdict.sources.idet) {
                    const conf = Math.round((verdict.sources.idet.confidence ?? 0) * 100);
                    const bd = v.scanBreakdown;
                    const tail = bd ? ` (TFF ${bd.tff}, BFF ${bd.bff}, prog ${bd.progressive}, undet ${bd.undetermined} of ${bd.total} sampled frames)` : '';
                    lines.push(`    • idet (pixel content, ${conf}%): ${verdict.sources.idet.scanType} ${verdict.sources.idet.fieldOrder}${tail}`);
                }
                if (verdict.sources.mediainfo) {
                    lines.push(`    • MediaInfo:               ${verdict.sources.mediainfo.scanType} ${verdict.sources.mediainfo.fieldOrder}`);
                }
                if (verdict.sources.ffprobe) {
                    const note = verdict.sources.ffprobe.note ? ` — ${verdict.sources.ffprobe.note}` : '';
                    lines.push(`    • ffprobe (container):     ${verdict.sources.ffprobe.scanType} ${verdict.sources.ffprobe.fieldOrder}${note}`);
                }

                // Heuristic signals — the colorist-style multi-clue analysis that
                // catches transcoded-broadcast-as-progressive mislabels.
                if (verdict.heuristics.indicators.length) {
                    lines.push(`  Heuristic signals (interlaced ${verdict.heuristics.interlacedScore.toFixed(2)} · progressive ${verdict.heuristics.progressiveScore.toFixed(2)}):`);
                    for (const ind of verdict.heuristics.indicators) {
                        lines.push(`    • ${ind}`);
                    }
                }

                if (verdict.confidence === 'suspected') {
                    lines.push('  ⚠ HEURISTIC OVERRIDE: the metadata sources unanimously said the opposite, '
                        + 'but the broadcast/SD signals (PAR, resolution, fps, codec, color matrix, MediaInfo '
                        + 'original-was-Interlaced) overwhelmingly indicate this clip is actually interlaced. '
                        + 'This is the canonical "SD tape digitized then transcoded into progressive-flagged '
                        + 'ProRes/MOV/MP4" pattern. Apply QTGMC with TFF/BFF per the verdict above.');
                } else if (verdict.disagreement === 'major') {
                    lines.push('  ⚠ MAJOR disagreement across metadata sources. Trust the verdict above '
                        + '(highest authority wins: idet > MediaInfo > ffprobe).');
                } else if (verdict.disagreement === 'minor') {
                    lines.push('  Minor disagreement on field order only; scan type is consistent across sources.');
                }
            }

            if (v.sampleAspectRatio)  lines.push(`  - SAR (sample aspect / PAR): ${v.sampleAspectRatio}, DAR: ${v.displayAspectRatio || '?'}`);
            if (v.chromaLocation)     lines.push(`  - Chroma siting: ${v.chromaLocation}`);
            if (v.frameCount != null) lines.push(`  - Frame count: ${v.frameCount}`);
        }
        if (s.audio) {
            lines.push('');
            lines.push('Source audio stream:');
            const a = s.audio;
            if (a.codec)        lines.push(`  - Codec: ${a.codec}`);
            if (a.channels)     lines.push(`  - Channels: ${a.channels}${a.channelLayout ? ` (${a.channelLayout})` : ''}`);
            if (a.sampleRate)   lines.push(`  - Sample rate: ${a.sampleRate} Hz`);
            if (a.bitDepth)     lines.push(`  - Bit depth: ${a.bitDepth}`);
        }
        lines.push('');
    }

    // --- TIMELINE-CONFORMED ---
    if (t) {
        lines.push('**Timeline-conformed (what Resolve actually delivers to the OFX plugin):**');
        if (t.width && t.height) lines.push(`- Resolution: ${t.width}×${t.height}  ← what the plugin sees per frame`);
        if (t.fps != null)       lines.push(`- FPS: ${t.fps.toFixed(3)}  (timeline rate)`);
        if (t.fieldOrder)        lines.push(`- Field order at delivery: ${t.fieldOrder}`);
        if (t.pixelAspectRatio != null) lines.push(`- PAR: ${t.pixelAspectRatio.toFixed(4)}`);
        if (t.pipelineBitDepth)  lines.push(`- Pipeline bit depth (Resolve→plugin): ${t.pipelineBitDepth}`);
        if (t.frameCount != null && t.frameCount > 0) lines.push(`- Frame count: ${t.frameCount}, duration: ${t.duration?.toFixed(2)} s`);
        lines.push('');
    }

    if (!s) {
        lines.push('**No source-native metadata yet.** Resolve conforms each clip to the timeline BEFORE handing frames to the OFX plugin, so the timeline values above are NOT the source\'s native properties — a 720×480 NTSC DV tape on a 1920×1080 timeline will read as 1920×1080 here. If the user asks for material-specific advice (correct deinterlace params, color matrix choice, scaling considerations), ask them to identify the source file via the strip below the color-management header (drag-drop from Finder works, or use the "Identify source…" button). Once they identify it once, ffprobe runs automatically on every subsequent Configure.');
    }

    lines.push('');
    lines.push(
        'When proposing filter parameters: use SOURCE-native values when available (resolution, codec, color matrix, chroma siting, field order). Use timeline values only when source-native is missing. If a critical value is unknown, ask the user or flag the assumption in your script comments.'
    );
    return lines.join('\n');
}

function formatChainState(chain: ChainStep[], cm: ColorManagement, manualOrder?: boolean): string {
    if (chain.length === 0) {
        return `**Current chain state**: empty. Color management is ${cm.inputColorSpace}/${cm.inputGamma} → ${cm.outputColorSpace}/${cm.outputGamma}.`;
    }
    // ORDER HONESTY: the composer executes the steps in THIS listing's order —
    // manual order when the user chose it (stages are reference labels only,
    // NOT re-sorted), stage-sorted otherwise. Never claim stage sorting
    // overrides the user's manual order.
    const lines: string[] = manualOrder
        ? ['**Current chain state** (USER-DEFINED MANUAL ORDER — this is the execution order; stage numbers are labels only, NOT re-sorted):']
        : ['**Current chain state** (stage-sorted execution order):'];
    const ordered = manualOrder ? [...chain] : [...chain].sort((a, b) => a.stage - b.stage);
    for (const step of ordered) {
        const status = step.enabled ? '' : ' [DISABLED]';
        const code = typeof step.params.code === 'string' ? step.params.code : '';
        const lineCount = code.split('\n').length;
        const label =
            typeof (step.params as { label?: unknown }).label === 'string'
                ? ` "${(step.params as { label: string }).label}"`
                : '';
        lines.push(`- id: \`${step.id}\` · stage ${step.stage} · type ${step.type}${status}${label} · ${lineCount} line(s) of code`);
        if (code) {
            // Indent so it reads as code, but keep it compact.
            const indented = code.split('\n').map(l => '    ' + l).join('\n');
            lines.push(indented);
        }
    }
    lines.push('');
    lines.push(`Color management: ${cm.inputColorSpace}/${cm.inputGamma} → ${cm.outputColorSpace}/${cm.outputGamma}`);
    return lines.join('\n');
}

export function buildArchivistSystemPrompt(
    chain: ChainStep[],
    cm: ColorManagement,
    clip?: ClipMetadata,
    availableNamespaces?: ReadonlySet<string>,
    neural?: import('./app-reference').NeuralCapabilitySnapshot,
    opts?: {
        /** The SELECTED model's real tool-loop capability (LLMModel.toolLoop).
         *  false/undefined → the truthful TEXT-ONLY instruction block; the
         *  tool-use block is only ever sent to adapters that implement it. */
        toolLoop?: boolean;
        /** Manual-order mode: the chain listing must show the user's execution
         *  order, not a stage re-sort. */
        manualOrder?: boolean;
    },
): string {
    // App capability reference FIRST (version-tied, actual-runtime-derived):
    // working features, honestly-missing features, the LIVE neural snapshot
    // (never stale categorical claims) and the probe-reconciled plugin
    // manifest in one bounded block.
    return [
        PERSONA,
        '',
        opts?.toolLoop ? TOOL_INSTRUCTIONS : TEXT_ONLY_INSTRUCTIONS,
        '',
        appCapabilityReference(
            { chain, colorManagement: cm, clipMetadata: clip },
            availableNamespaces,
            neural),
        '',
        formatClipMetadata(clip),
        '',
        formatChainState(chain, cm, opts?.manualOrder),
    ].join('\n');
}
