// Companion-side DRAFT chain composer — an exact mirror of the native
// common/chain/composer.cpp + common/color/color.cpp emission.
//
// WHY: in manual-host mode the preview used to replay the HOST-COMPOSED
// script (nodes/<guid>.vpy) — the LAST ACCEPTED revision. Editing a
// parameter, toggling a step or bypassing a filter in the editor changed
// NOTHING in the preview until Save and Close. The draft composer lets the
// preview render the CURRENT editor chain: what you see is the exact
// intended draft, explicitly labeled as a draft (never claimed as applied).
//
// Drift control: every section mirrors the native composer VERBATIM — the
// sys.path injection, imports/aliases, helper defs, SOURCE/INPUT/STEP/OUTPUT
// section headers, the matrix_for mapping (incl. the 525/625 601 split),
// the QTGMC typed emission (mirroring filter_qtgmc.cpp), and the
// stage-sort/manual-order/enable+approve gating. The native composer stays
// the source of truth for what RUNS; when the two disagree, fix the mirror
// here. Section headers match splitSections() in the Script view.
// The QTGMC typed emission is pinned byte-for-byte to the native emitter by
// tests/fixtures/qtgmc_parity.json — the approval-content binding compares
// the two composers' emitted bodies, so a formatting divergence is a real
// failure, not a cosmetic one.
//
// The draft composer only ever runs in the PREVIEW path. The node still
// evaluates the native-composed script after Save and Close.

export interface DraftStep {
    id: string;
    type: string;
    stage: number;
    enabled: boolean;
    approved?: boolean;
    /** The exact executable body (`clip = havs.QTGMC(...)` call or script
     *  code, byte-for-byte as emitted) the approval was granted for.
     *  Missing/empty or mismatched ⇒ NOT approved (fail closed). */
    approvedContent?: string | null;
    version: number;
    params: Record<string, unknown>;
}

export interface DraftChainConfig {
    manualOrder?: boolean;
    mix: number;
    chain: DraftStep[];
    colorManagement: {
        inputColorSpace: string;
        inputGamma: string;
        outputColorSpace: string;
        outputGamma: string;
        ocioConfig: string;
    };
    clipMetadata?: {
        source?: {
            filePath?: string;
            sourceInPoint?: number | null;
            sourceOutPoint?: number | null;
        };
        timeline?: { width?: number; height?: number };
    };
}

// Mirror of matrix_for() in common/color/color.cpp — substring matching
// against UI labels, specific tokens first, 525/625 601 split.
export function matrixFor(cs: string): string {
    const has = (needle: string) => cs.indexOf(needle) !== -1;
    if (has('2020') || has('2100')) return '2020';
    if (has('470BG') || has('470bg')) return '470bg';
    if (has('240M') || has('240m')) return '240m';
    if (has('170M') || has('170m')) return '170m';
    if (has('601')) {
        if (has('625') || has('PAL') || has('pal')) return '470bg';
        return '170m';
    }
    if (has('PAL') || has('pal')) return '470bg';
    if (has('709') || has('sRGB')) return '709';
    return '709';
}

// ── Canonical per-step executable bodies ─────────────────────────────────
// BYTE PARITY between this module and the native composer
// (common/filters/filter_qtgmc.cpp + filter_script.cpp) is a security
// property: approval BINDS CONTENT — `approvedContent` stores the exact body
// below, and the native composer re-emits and compares it before running a
// step. tests/fixtures/qtgmc_parity.json is the shared cross-language matrix
// (the node parity test and the native test consume the SAME file).

// Mirror of py_float() in filter_qtgmc.cpp: std::setprecision(max_digits10)
// default-format — 17 significant digits, trailing zeros dropped, ".0"
// appended to integer-looking values, C++-style exponent (lowercase e,
// explicit sign, >= 2 digits). Verified against the native emitter by the
// parity fixture on every run.
export function pyFloat(value: number): string {
    if (!Number.isFinite(value)) return String(value); // unreachable via JSON; belt only
    if (value === 0) return Object.is(value, -0) ? '-0.0' : '0.0';
    const negative = value < 0;
    const abs = Math.abs(value);
    // 17 significant digits, independent of the JS formatter's own
    // fixed/scientific choice.
    const expanded = abs.toExponential(16); // "d.ddddddddddddddddde±x"
    const [mantissa, expRaw] = expanded.split('e');
    const exp10 = parseInt(expRaw, 10);
    let digits = mantissa.replace('.', '').replace(/0+$/, '') || '0';
    let body: string;
    if (exp10 < -4 || exp10 >= 17) {
        // Mirror of C++ %g-style: scientific when exp < -4 or >= precision.
        const head = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
        const sign = exp10 < 0 ? '-' : '+';
        const magnitude = Math.abs(exp10).toString().padStart(2, '0');
        body = `${head}e${sign}${magnitude}`;
    } else if (exp10 >= 0) {
        const intDigits = digits.length > exp10 + 1 ? digits.slice(0, exp10 + 1) : digits.padEnd(exp10 + 1, '0');
        const fracDigits = digits.length > exp10 + 1 ? digits.slice(exp10 + 1) : '';
        body = fracDigits ? `${intDigits}.${fracDigits}` : `${intDigits}.0`;
    } else {
        body = `0.${'0'.repeat(-exp10 - 1)}${digits}`;
    }
    return negative ? '-' + body : body;
}

// Mirror of sanitize_preset() in filter_qtgmc.cpp. Unknown/invalid values
// fall back to Slower — but every preset the UI exposes (including Placebo
// and Draft) is emitted verbatim (no silent Slower substitution).
// Exported: filter-schemas.ts reuses this list so the two companion-side
// QTGMGMC emitters can never drift.
export const QTGMC_PRESETS = ['Placebo', 'Very Slow', 'Slower', 'Slow', 'Medium', 'Fast', 'Faster', 'Draft', 'Ultra Fast'];
function sanitizePreset(value: unknown): string {
    return typeof value === 'string' && QTGMC_PRESETS.includes(value) ? value : 'Slower';
}

// Mirror of QTGMCFilter::emit in common/filters/filter_qtgmc.cpp.
export function emitQtgmcBody(params: Record<string, unknown>): string {
    const j = params ?? {};
    const tff = typeof j.tff === 'boolean' ? j.tff : true;
    const fpsDivisor = Number.isInteger(j.fpsDivisor) ? (j.fpsDivisor as number) : 2;
    const inputType = Number.isInteger(j.inputType) && (j.inputType as number) >= 0 && (j.inputType as number) <= 3
        ? (j.inputType as number) : 0;
    const preset = sanitizePreset(j.preset);

    let call = `clip = havs.QTGMC(clip, Preset='${preset}'`;
    if (inputType !== 1) call += `, TFF=${tff ? 'True' : 'False'}`;
    if (inputType !== 0) call += `, InputType=${inputType}`;
    call += `, FPSDivisor=${fpsDivisor === 1 ? 1 : 2}`;

    if (typeof j.sharpness === 'number' && Number.isFinite(j.sharpness)) {
        call += `, Sharpness=${pyFloat(j.sharpness)}`;
    }
    if (Number.isInteger(j.tr2)) call += `, TR2=${j.tr2 as number}`;
    const sm = j.sourceMatch;
    if (Number.isInteger(sm) && (sm as number) >= 1 && (sm as number) <= 3) call += `, SourceMatch=${sm as number}`;
    const ll = j.lossless;
    if (Number.isInteger(ll) && (ll as number) >= 0 && (ll as number) <= 2) call += `, Lossless=${ll as number}`;
    const ts2 = j.thSad2;
    if (Number.isInteger(ts2) && (ts2 as number) > 0) call += `, ThSAD2=${ts2 as number}`;
    const np = j.noiseProcess;
    if (Number.isInteger(np) && (np as number) >= 0 && (np as number) <= 2) call += `, NoiseProcess=${np as number}`;
    if (typeof j.ezDenoise === 'number' && Number.isFinite(j.ezDenoise) && j.ezDenoise > 0) {
        call += `, EZDenoise=${pyFloat(j.ezDenoise)}`;
    }
    if (typeof j.ezKeepGrain === 'number' && Number.isFinite(j.ezKeepGrain) && j.ezKeepGrain > 0) {
        call += `, EZKeepGrain=${pyFloat(j.ezKeepGrain)}`;
    }
    call += ')\n';
    return call;
}

// Mirror of ScriptFilter::emit in common/filters/filter_script.cpp — the
// code is emitted verbatim with exactly one trailing newline. Missing or
// non-string code emits the shared no-op comment default.
export function scriptBody(params: Record<string, unknown>): string {
    const code = typeof params.code === 'string' ? params.code : '# empty script step';
    return code.endsWith('\n') ? code : code + '\n';
}

// The exact executable text of a step — the thing an approval is FOR.
// Returns null for types the composers cannot execute (never approvable).
export function executableTextForStep(step: { type: string; params?: Record<string, unknown> }): string | null {
    if (step.type === 'qtgmc') return emitQtgmcBody(step.params ?? {});
    if (step.type === 'script') return scriptBody(step.params ?? {});
    return null;
}

// APPROVAL BINDS CONTENT (security re-review, 2026-11-05): a step is
// approved only when `approved === true` AND `approvedContent` equals the
// executable body's CURRENT text. A stale flag on changed content is not
// approval; a missing binding never approves (fail closed — legacy chains
// must be re-approved). Used by every companion surface so the UI can never
// claim a step is live when the composers would skip it.
export function isStepApproved(step: {
    type: string;
    params?: Record<string, unknown>;
    approved?: boolean | null;
    approvedContent?: string | null;
}): boolean {
    if (step.approved !== true) return false;
    if (typeof step.approvedContent !== 'string') return false;
    const text = executableTextForStep(step);
    return text !== null && step.approvedContent === text;
}

// Mirror of vs_input_transform_fragment (common/color/color.cpp).
// SECURITY (2026-11-05, security review #1 route 2): labels are sanitized so a
// recipe-imported color field can never break out of the comment line.
// CORRECTNESS (correctness review C14, 2026-11-05 re-review): recipe intake accepts a
// PARTIAL color-management object, and Apply replaces the destination's CM
// wholesale — the composer must tolerate missing fields exactly like the
// native defaults do (crash fixed: undefined.replace threw).
const cmSanitize = (s: string | undefined): string =>
    (s ?? '').replace(/[\x00-\x1f\x7f]/g, ' ');
const CM_DEFAULTS = {
    inputColorSpace: 'Rec.709',
    inputGamma: 'BT.1886',
    outputColorSpace: 'Rec.709',
    outputGamma: 'BT.1886',
};

function inputFragment(cm: DraftChainConfig['colorManagement']): string {
    const ics = cm?.inputColorSpace || CM_DEFAULTS.inputColorSpace;
    const igm = cm?.inputGamma || CM_DEFAULTS.inputGamma;
    return `# Input color management: ${cmSanitize(ics)} / ${cmSanitize(igm)}
# Auto-convert RGB float32 → YUV420P16 so restoration filters
# (QTGMC, BM3D, ...) get the planar YUV input they expect.
clip = mvf.ToYUV(src, css='420', depth=16, matrix='${matrixFor(ics)}')
`;
}

// Mirror of vs_output_transform_fragment + the source-mode timeline fit.
function outputFragment(cm: DraftChainConfig['colorManagement'],
                       timelineWidth: number, timelineHeight: number): string {
    const ocs = cm?.outputColorSpace || CM_DEFAULTS.outputColorSpace;
    const ogm = cm?.outputGamma || CM_DEFAULTS.outputGamma;
    let code = `# Output color management: ${cmSanitize(ocs)} / ${cmSanitize(ogm)}
# Auto-convert back to RGB float32 if the chain left clip in YUV.
if clip.format.color_family != vs.RGB:
    clip = mvf.ToRGB(clip, depth=32, matrix='${matrixFor(ocs)}')
if clip.format.bits_per_sample != 32 or clip.format.sample_type != vs.FLOAT:
    clip = mvf.Depth(clip, depth=32, sample=vs.FLOAT)
`;
    if (timelineWidth > 0 && timelineHeight > 0) {
        code += `# TKT-SRC: source-mode final upscale to timeline dims
if clip.width != ${timelineWidth} or clip.height != ${timelineHeight}:
    clip = core.resize.Spline36(clip, width=${timelineWidth}, height=${timelineHeight})
`;
    }
    return code;
}

export function composeDraftScript(cfg: DraftChainConfig,
                                   timelineWidth: number, timelineHeight: number): string {
    // Gating mirror: enabled AND content-bound approved only (see
    // isStepApproved — a stale approval flag on changed content never runs);
    // stable stage sort unless manual. UNKNOWN types are always included when
    // enabled: they can never be content-approved, and silently dropping them
    // would hide a corrupted chain — the loop below emits a loud refusal
    // (correctness review C13 residual behavior preserved).
    const ordered = cfg.chain.filter(s =>
        s.enabled && (isStepApproved(s) || executableTextForStep(s) === null));
    const sorted = cfg.manualOrder ? ordered.slice()
        : ordered.slice().sort((a, b) => a.stage - b.stage);

    const src = cfg.clipMetadata?.source;
    const filePath = src?.filePath;
    const hasTrim = typeof src?.sourceInPoint === 'number' && typeof src?.sourceOutPoint === 'number';
    // SECURITY (2026-11-05, security review #1 + correctness review C11) — mirror of the
    // native composer: the source path is emitted as HEX bytes (a crafted
    // filename like  x'); <stmt>; #  previously injected Python, and a plain
    // apostrophe broke the literal); labels are flattened to one line.
    const pyHexPathStmt = (varName: string, raw: string): string => {
        // TextEncoder, NOT Buffer: this module also runs in the RENDERER
        // (browser context) where Buffer is undefined — Buffer here broke
        // the real journey render (caught by __test_viewer_journey).
        const bytes = new TextEncoder().encode(raw);
        let hex = '';
        for (const b of bytes) hex += b.toString(16).padStart(2, '0');
        return `${varName} = bytes.fromhex('${hex}').decode('utf-8', 'surrogateescape')\n`;
    };
    const sanitizeComment = (s: string): string =>
        s.replace(/[\x00-\x1f\x7f]/g, ' ');
    const label = (s: DraftStep) => {
        const base = typeof s.params.label === 'string' && s.params.label
            ? s.params.label as string : s.type;
        return sanitizeComment(base);
    };

    // POSTURE (security review #5 decision, 2026-11-11): both locations are APPENDED
    // as fallbacks so either works — never prepended. Machine-dir modules may
    // satisfy a MISSING import but can never shadow the staged bundle's
    // reviewed helpers or the interpreter's own resolution. Mirrors the
    // native composer's prelude exactly.
    let py = `import sys, os
for _vsr in [
    os.path.expanduser('~/Library/Application Support/VapourSynth-OFX/vs-python'),
    '/Library/Application Support/VapourSynth-OFX/vs-python',
]:
    if _vsr not in sys.path:
        sys.path.append(_vsr)
import vapoursynth as vs
core = vs.core
import havsfunc
havs = havsfunc
import mvsfunc as mvf
import adjust
try:
    import nnedi3_resample
except ImportError:
    nnedi3_resample = None
try:
    import vsmlrt
except ImportError:
    vsmlrt = None
except Exception:
    # vsmlrt can ALSO raise non-ImportError on import (e.g. "cannot load any
    # filters" on machines without its ONNX model paths) — it is OPTIONAL:
    # an import failure must not kill the whole draft script.
    vsmlrt = None

def to_yuv(c, css='420', depth=16, matrix='709'):
    """Any → YUV<css>P<depth>. Default = YUV420P16 (QTGMC-ready)."""
    return mvf.ToYUV(c, css=css, depth=depth, matrix=matrix)
def to_rgb(c, depth=32, matrix='709'):
    """YUV → RGB<depth>. Default = RGBS (32-bit float, Resolve-native)."""
    return mvf.ToRGB(c, depth=depth, matrix=matrix)
def to8(c):  return mvf.Depth(c, depth=8)
def to10(c): return mvf.Depth(c, depth=10)
def to16(c): return mvf.Depth(c, depth=16)
def to32(c): return mvf.Depth(c, depth=32, sample=vs.FLOAT)

`;

    // SOURCE section — mirror native. Draft without an identified source
    // cannot direct-load; the preview refuses honestly rather than binding
    // another node's file.
    py += `# ══════════ SOURCE ══════════\n`;
    if (!filePath) {
        py += `raise ValueError('DRAFT PREVIEW: no source file identified for this node — identify the source first')\n`;
    } else {
        py += pyHexPathStmt('_vsres_src_path', filePath);
        py += `src = core.lsmas.LWLibavSource(_vsres_src_path)\n`;
        if (hasTrim) {
            py += `src = core.std.Trim(src, first=${src!.sourceInPoint}, last=${src!.sourceOutPoint})\n`;
        }
    }

    py += `# ══════════ INPUT ══════════\n`;
    py += inputFragment(cfg.colorManagement);

    sorted.forEach((s, i) => {
        py += `\n# ══════════ STEP ${i + 1} / ${sorted.length} · stage ${s.stage} · ${label(s)} ══════════\n`;
        if (s.type === 'qtgmc') {
            py += emitQtgmcBody(s.params);
        } else if (s.type === 'script') {
            py += scriptBody(s.params);
        } else {
            // CORRECTNESS (correctness review C13 residual, 2026-11-05 re-review): the
            // old emission had an unterminated string literal (a type name
            // containing a quote broke the whole script). Emit a VALID
            // Python literal via JSON.stringify and compose the message
            // from a safely-encoded type token.
            const typeTok = JSON.stringify(String(s.type).replace(/[\x00-\x1f\x7f]/g, ' '));
            py += `raise ValueError('DRAFT PREVIEW: unknown filter type ' + ${typeTok})\n`;
        }
    });

    if (cfg.mix < 1.0) {
        py += `_mix_ref = src
if clip.format.id != _mix_ref.format.id:
    _mix_ref = core.resize.Bicubic(src, format=clip.format.id, matrix_s='709')
clip = core.std.Merge(_mix_ref, clip, weight=${cfg.mix})
`;
    }

    py += `\n# ══════════ OUTPUT ══════════\n`;
    py += outputFragment(cfg.colorManagement, timelineWidth, timelineHeight);
    py += `clip.set_output()\n`;
    return py;
}