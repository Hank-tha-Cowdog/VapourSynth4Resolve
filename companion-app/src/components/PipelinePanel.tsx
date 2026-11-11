// PipelinePanel — block-diagram view of the complete render pipeline.
//
// Three horizontal rails, left-to-right:
//   1. FILTER chain — Resolve input  →  each enabled+approved step  →  Resolve output
//   2. COLOR SPACE  — source CS       →  composer-injected YUV420P16  →  output CS
//   3. GAMMA        — source γ        →  γ preserved through chain     →  output γ
//
// Each junction is a box. Each connector is a labeled line describing what's
// actually flowing through that point (e.g. "RGB 32-bit float", "YUV420P16
// matrix=709"). Mismatched in/out flash red.

import React from 'react';
import { AlertTriangle } from 'lucide-react';
import type { NodeConfig, ChainStep } from '../types';
import { stageLabelForNumber } from '../types';
import { OCIOBadge } from './OCIOBadge';
import { detectedMatrixLabel, detectedTransferLabel, inferColorDefaults } from '../services/color-heuristic';
import { resolveSourceMode } from '../services/source-mode';
import { playbookForStage, stepSummary } from '../services/stage-playbooks';
import { isStepApproved } from '../../shared/draft-composer';

interface Props {
    config: NodeConfig;
}

export const PipelinePanel: React.FC<Props> = ({ config }) => {
    const { chain, colorManagement: cm, clipMetadata } = config;
    const orderedSteps = config.manualOrder ? chain : [...chain].sort((a, b) => a.stage - b.stage);
    // Keep the chain editor's all-step ordinal, including hidden drafts/disabled
    // steps, so a diagram block still points to the same editable step.
    const stepNumberById = new Map(orderedSteps.map((step, i) => [step.id, i + 1] as const));
    const liveSteps = orderedSteps.filter(s => s.enabled && isStepApproved(s));

    // What the source actually IS (ffprobe). Falls back to friendly placeholders
    // when source hasn't been identified yet so the panel still tells a coherent
    // story instead of dumping "—" everywhere.
    const s = clipMetadata?.source?.video;
    const t = clipMetadata?.timeline;

    const sourceRes = s?.width && s?.height ? `${s.width}×${s.height}` : (t?.width && t?.height ? `${t.width}×${t.height}` : '—');
    const sourceFps = s?.fps ? `${s.fps.toFixed(3)} fps` : (t?.fps ? `${t.fps.toFixed(3)} fps` : '—');
    // SD/NTSC + PAL get Rec.601 by height-based heuristic, not "Rec.709 (assumed)".
    // detectedMatrixLabel / detectedTransferLabel return the tagged value if
    // present, otherwise `unspecified → assume <inferred>` based on height + fps.
    const sourceCS  = detectedMatrixLabel(s);
    const sourceγ   = detectedTransferLabel(s);
    const sourceCodec = s?.codec || '—';

    // The heuristic also drives the mismatch check below: if the user's Input
    // CS dropdown disagrees with the inferred default (Rec.601 vs Rec.709 for
    // a DV NTSC source) we should still flag it as a mismatch.
    const heuristic = s ? inferColorDefaults(s) : null;

    // TKT-SRC: derive source-mode from the cached metadata so the subway map
    // can show the right inflow lane. `vsLoadsDirectly` true means VS reads
    // the file itself via core.lsmas.LWLibavSource — the OFX clip's Resolve
    // pixels are NOT consumed; the chain operates on native source frames.
    const sourceMode = resolveSourceMode(clipMetadata?.source);
    const vsDirect = sourceMode.vsLoadsDirectly;
    const sourceFileName = clipMetadata?.source?.fileName ?? '';

    // Resolve-side input — the OFX plugin always receives 32-bit float RGBA at
    // the TIMELINE resolution, regardless of source. Resolve color-manages
    // before handing us the frames (the input CS dropdown should match what
    // Resolve has assigned to this clip's input color space).
    const resolveInputDescription = t?.width && t?.height
        ? `${t.width}×${t.height} RGB 32-bit float`
        : 'RGB 32-bit float';

    // The chain operates in YUV420P16 (composer auto-conversion). This text
    // appears on the connector LABEL between Input CS and the first filter.
    const internalFormat = 'YUV420P16';

    // Mismatch detection. Compares user's Input CS / Input γ dropdowns against
    // what the heuristic thinks the source actually is — but only when the
    // heuristic is actually confident (tagged, or the SD/PAL height
    // correlation). This handles three cases:
    //   1. Tagged colorSpace="bt709"        + user dropdown = "Rec.709"          → match
    //   2. Untagged source with height=480 + user dropdown = "Rec.709"          → mismatch
    //      (the heuristic infers Rec.601 (525) with high confidence; user should switch)
    //   3. Untagged UHD source + user dropdown = "S-Gamut3.Cine"/"S-Log3"        → NOT a mismatch
    //      (the heuristic's only guess here is "Rec.709 because we don't know better" —
    //      a placeholder, not a finding, and it has no way to know about camera-native
    //      log profiles. Contesting a deliberate, correct choice like this was a real
    //      false-positive bug: flagged even from a still image where the user's own
    //      Input CS/γ dropdowns were visibly correct.)
    // matrixConfident/transferConfident (see color-heuristic.ts) encode exactly that
    // distinction, so case 2 keeps warning and case 3 stops.
    const inputCSMismatch  = !!heuristic && heuristic.matrixConfident   && normalize(heuristic.suggestedMatrix)   !== normalize(cm.inputColorSpace);
    const inputγMismatch   = !!heuristic && heuristic.transferConfident && normalize(heuristic.suggestedTransfer) !== normalize(cm.inputGamma);

    // EFFECTIVE output interpretation, derived from what the chain ACTUALLY
    // does — not from the stored dropdown labels. Script steps may remap
    // gamut/transfer mid-chain (the confirmed theatrical-P3 step:
    // resize with primaries_s='st431-2', transfer_s='st428'). The composer's
    // own output transform then converts with matrix=<outputColorSpace>.
    // Truth rules: a gamut remap changes the pixel VALUES' primaries; a
    // matrix (YUV<->RGB) conversion does NOT. So the effective output
    // gamut/transfer is the LAST primaries_s/transfer_s the chain sets (or,
    // absent a remap, the configured labels — with the standing caveat that
    // the composer applies only matrix conversions, never transfer curves).
    // This is also what makes the labels agree with the DCI-P3 step instead
    // of contradicting it (live feedback Oct 26: the step said P3 while the
    // output blocks still read Rec.709/BT.1886).
    let effectivePrimaries: string | null = null;
    let effectiveTransfer: string | null = null;
    for (const step of liveSteps) {
        if (step.type !== 'script') continue;
        const code = String((step.params as { code?: string }).code ?? '');
        // Last assignment wins — the script runs in order.
        const p = /primaries_s\s*=\s*['"]([^'"]+)['"]/.exec(code);
        if (p) effectivePrimaries = p[1];
        const t = /transfer_s\s*=\s*['"]([^'"]+)['"]/.exec(code);
        if (t) effectiveTransfer = t[1];
    }
    const hasGamutRemap = effectivePrimaries != null || effectiveTransfer != null;
    const effectiveLabel = hasGamutRemap
        ? `${effectivePrimaries ?? cm.outputColorSpace} / ${effectiveTransfer ?? cm.outputGamma} (chain remap)`
        : `${cm.outputColorSpace} / ${cm.outputGamma}`;

    return (
        <section style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            background: '#0a0414',
            padding: 20,
            gap: 18,
            overflow: 'auto',
        }}>
            <style>{ANIMATIONS_CSS}</style>

            <header style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 4 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <h2 style={{ margin: 0, fontSize: 14, color: '#ff2bd6', letterSpacing: 0.4 }}>
                        Pipeline
                    </h2>
                    <OCIOBadge size={13} />
                </div>
                <p style={{ margin: 0, fontSize: 11, opacity: 0.6, lineHeight: 1.5 }}>
                    Configuration diagram of the chain. The composer uses RGB/YUV matrix conversions;
                    OCIO is not integrated and gamma selections do not apply transfer-function transforms.
                    Colored junctions compare source metadata with configured labels, not measured output pixels.
                </p>
            </header>

            {/* TKT-SRC: source-mode banner — tells the colorist in one line
                whether VS is reading direct from disk (bypassing Resolve) or
                consuming Resolve's timeline-conformed pixels via the OFX clip.
                The leading rail below echoes the same state visually. */}
            <SourceModeBanner mode={sourceMode} />

            {/* ───── RAIL 1: FILTER CHAIN ───── */}
            <Rail title="Filter chain" subtitle="What each frame goes through">
                {vsDirect ? (
                    // Subway-map: two stacked inflow lanes. Top lane (live) =
                    // VS reading direct from disk via core.lsmas.LWLibavSource.
                    // Bottom lane (dimmed) = Resolve timeline pixels, which the
                    // chain does NOT consume in source-mode — they only exist
                    // so Resolve's playhead/UI keeps working. Both lanes
                    // converge at the input-transform block where VS hands the
                    // restored output back into Resolve's compositing pipe.
                    <SubwayInflow
                        sourceFileName={sourceFileName}
                        sourceCodec={sourceCodec}
                        sourceRes={sourceRes}
                        sourceFps={sourceFps}
                        timelineDescription={resolveInputDescription}
                    />
                ) : (
                    <Block
                        title="Resolve INPUT"
                        rows={[
                            ['clip', sourceCodec],
                            ['res', sourceRes],
                            ['fps', sourceFps],
                        ]}
                        accent="#44ff99"
                    />
                )}
                <Connector label={vsDirect ? 'native pixel format' : resolveInputDescription} />
                <Block
                    title="Input conversion"
                    subtitle={vsDirect ? 'Normalize to YUV420P16' : 'RGB → YUV420P16'}
                    rows={[
                        ['matrix', matrixSlug(cm.inputColorSpace)],
                        ['γ label', `${transferSlug(cm.inputGamma)} (not applied)`],
                    ]}
                    accent="#c4a8ff"
                    ocio
                />
                <Connector label={internalFormat} />
                {liveSteps.length === 0 ? (
                    <PassthroughBlock />
                ) : (
                    liveSteps.map((step, i) => (
                        <React.Fragment key={step.id}>
                            {i > 0 && <Connector label={internalFormat} />}
                            <FilterBlock step={step} stepNumber={stepNumberById.get(step.id) ?? 0} />
                        </React.Fragment>
                    ))
                )}
                <Connector label={internalFormat} />
                <Block
                    title="Output transform"
                    subtitle="YUV → RGB (if needed)"
                    rows={[
                        ['matrix', matrixSlug(cm.outputColorSpace)],
                        ['γ label', `${transferSlug(cm.outputGamma)} (not applied)`],
                    ]}
                    accent="#c4a8ff"
                    ocio
                />
                <Connector label="RGB 32-bit float" />
                <Block
                    title="Resolve OUTPUT"
                    subtitle={hasGamutRemap ? 'effective after chain remap' : 'labels from settings'}
                    rows={[
                        ['CS label', cm.outputColorSpace],
                        ['γ label',  cm.outputGamma],
                        ...(hasGamutRemap ? [[
                            'effective',
                            `${effectivePrimaries ?? '—'}${effectiveTransfer ? ` / ${effectiveTransfer}` : ''}`,
                        ] as [string, string]] : []),
                    ]}
                    accent={hasGamutRemap ? '#f4ce91' : '#44ff99'}
                />
            </Rail>

            {/* ───── RAIL 2: COLOR SPACE ───── */}
            <Rail title="Color space" subtitle="Gamut + white point through the chain">
                <Block
                    title="Source CS"
                    subtitle="from ffprobe"
                    rows={[['detected', sourceCS]]}
                    accent={inputCSMismatch ? '#ff5577' : '#44ff99'}
                    pulse={inputCSMismatch ? 'mismatch' : 'none'}
                />
                <Connector label="compare labels →" />
                <Block
                    title="Input CS"
                    subtitle="popout dropdown"
                    rows={[['set to', cm.inputColorSpace]]}
                    accent={inputCSMismatch ? '#ff5577' : '#44ff99'}
                    pulse={inputCSMismatch ? 'mismatch' : 'match'}
                    ocio
                />
                <Connector label="composer routes via mvf.ToYUV" wide />
                <Block
                    title="Output CS"
                    subtitle="popout dropdown"
                    rows={[['set to', cm.outputColorSpace]]}
                    accent="#44ff99"
                    pulse="match"
                    ocio
                />
                <Connector label="→ Resolve" />
                <Block
                    title="Resolve OUTPUT"
                    subtitle={hasGamutRemap ? 'effective after chain remap' : 'configured output label'}
                    rows={[['as', hasGamutRemap ? (effectivePrimaries ?? cm.outputColorSpace) : cm.outputColorSpace]]}
                    accent={hasGamutRemap ? '#f4ce91' : '#44ff99'}
                />
            </Rail>

            {/* ───── RAIL 3: GAMMA ───── */}
            <Rail title="Gamma labels" subtitle="Stored selections; no composer transfer-function transform">
                <Block
                    title="Source γ"
                    subtitle="from ffprobe"
                    rows={[['detected', sourceγ]]}
                    accent={inputγMismatch ? '#ff5577' : '#44ff99'}
                    pulse={inputγMismatch ? 'mismatch' : 'none'}
                />
                <Connector label="compare labels →" />
                <Block
                    title="Input γ"
                    subtitle="popout dropdown"
                    rows={[['set to', cm.inputGamma]]}
                    accent={inputγMismatch ? '#ff5577' : '#44ff99'}
                    pulse={inputγMismatch ? 'mismatch' : 'match'}
                    ocio
                />
                <Connector label={effectiveTransfer ? `chain remap → ${effectiveTransfer}` : 'labels only; no gamma transform'} wide />
                <Block
                    title="Output γ"
                    subtitle={effectiveTransfer ? 'effective after chain remap' : 'popout dropdown'}
                    rows={[['set to', cm.outputGamma], ...(effectiveTransfer ? [['effective', effectiveTransfer] as [string, string]] : [])]}
                    accent={effectiveTransfer ? '#f4ce91' : '#44ff99'}
                    pulse="match"
                    ocio
                />
                <Connector label="→ Resolve" />
                <Block
                    title="Resolve OUTPUT"
                    subtitle={effectiveTransfer ? 'effective after chain remap' : 'configured output label'}
                    rows={[['as', effectiveTransfer ?? cm.outputGamma]]}
                    accent={effectiveTransfer ? '#f4ce91' : '#44ff99'}
                />
            </Rail>

            {(inputCSMismatch || inputγMismatch) && (
                <div style={{
                    padding: '12px 14px',
                    background: 'rgba(255, 85, 119, 0.10)',
                    border: '1px solid rgba(255, 85, 119, 0.5)',
                    borderRadius: 6,
                    display: 'flex', alignItems: 'flex-start', gap: 10,
                }}>
                    <AlertTriangle size={16} color="#ff8aa0" style={{ flexShrink: 0, marginTop: 2 }} />
                    <div style={{ fontSize: 12, lineHeight: 1.55, color: '#ff8aa0' }}>
                        <strong>Configured labels differ from source metadata.</strong>{' '}
                        {inputCSMismatch && (
                            <>
                                The source clip {heuristic?.matrixInferred ? 'is untagged, but its resolution/frame rate confidently indicate' : 'is tagged'}{' '}
                                <code>{heuristic?.suggestedMatrix}</code> color space ({heuristic?.rationale}), but Input CS is set to <code>{cm.inputColorSpace}</code>.{' '}
                            </>
                        )}
                        {inputγMismatch && (
                            <>
                                The source clip is tagged <code>{heuristic?.suggestedTransfer}</code> transfer, but Input γ is set to <code>{cm.inputGamma}</code>.{' '}
                            </>
                        )}
                        Review the selected matrix and confirm the interpretation in Resolve.
                        Changing a gamma label does not apply a gamma transform.
                    </div>
                </div>
            )}
        </section>
    );
};

// ───────────────────────────────────────────────────────────────────
// Primitives
// ───────────────────────────────────────────────────────────────────

const ANIMATIONS_CSS = `
@keyframes vsynthMismatchPulse {
    0%, 100% { box-shadow: 0 0 0 0 rgba(255, 85, 119, 0); }
    50%      { box-shadow: 0 0 16px 2px rgba(255, 85, 119, 0.55); }
}
@keyframes vsynthMatchPulse {
    /* Slightly more visible than before — the previous 0.28 alpha peak was
     * almost imperceptible against the panel background, leading the colorist
     * to think the "all-green-all-matching" state had no animation at all.
     * 0.45 reads as a soft breathing glow without competing with the harder
     * mismatch-red pulse. */
    0%, 100% { box-shadow: 0 0 0 0 rgba(68, 255, 153, 0); }
    50%      { box-shadow: 0 0 14px 1px rgba(68, 255, 153, 0.45); }
}
/* Subway-flow stripes. Pattern repeats every 16px (8px dash + 8px gap), so
 * the keyframe must translate by an exact multiple of 16px or the strip
 * "jerks" each cycle as the pattern resets out of phase. 16px == one
 * complete dash-gap unit; 1.0s makes the dashes feel like a paced subway
 * map, not a marquee. */
@keyframes vsynthSubwayFlow {
    0%   { background-position: 0 0; }
    100% { background-position: 16px 0; }
}
.vsynth-pulse-mismatch { animation: vsynthMismatchPulse 1.6s ease-in-out infinite; }
.vsynth-pulse-match    { animation: vsynthMatchPulse 3.0s ease-in-out infinite; }
.vsynth-subway-flow {
    background-image: repeating-linear-gradient(90deg,
        rgba(68, 255, 153, 0.85) 0px, rgba(68, 255, 153, 0.85) 8px,
        transparent 8px, transparent 16px);
    background-size: 16px 100%;
    animation: vsynthSubwayFlow 1.0s linear infinite;
    will-change: background-position;
}
.vsynth-subway-bypass {
    background-image: repeating-linear-gradient(90deg,
        rgba(120, 120, 140, 0.35) 0px, rgba(120, 120, 140, 0.35) 8px,
        transparent 8px, transparent 16px);
    background-size: 16px 100%;
}
`;

// TKT-SRC subway-map components. When source-mode is active the leading
// rail visually forks: top lane = VS direct-from-disk (the live path),
// bottom lane = Resolve timeline frames (bypassed, dimmed). They re-converge
// at the input-transform block. The visual metaphor is two subway lines
// joining at a station: the colorist sees at a glance which pixels are
// actually flowing through the chain.

const SourceModeBanner: React.FC<{ mode: ReturnType<typeof resolveSourceMode> }> = ({ mode }) => {
    const palette = {
        active:           { fg: '#44ff99', bg: 'rgba(68, 255, 153, 0.10)', border: 'rgba(68, 255, 153, 0.5)', label: 'SOURCE-MODE · ACTIVE' },
        'active-trimmed': { fg: '#88ffaa', bg: 'rgba(68, 255, 153, 0.10)', border: 'rgba(68, 255, 153, 0.5)', label: 'SOURCE-MODE · TRIMMED' },
        disabled:         { fg: '#aaa',    bg: 'rgba(170, 170, 170, 0.08)', border: 'rgba(170, 170, 170, 0.3)', label: 'TIMELINE-MODE' },
        'retime-disabled':{ fg: '#ffaa44', bg: 'rgba(255, 170, 68, 0.10)', border: 'rgba(255, 170, 68, 0.5)', label: 'SOURCE-MODE · DISABLED (retime)' },
        'file-missing':   { fg: '#ff5577', bg: 'rgba(255, 85, 119, 0.10)', border: 'rgba(255, 85, 119, 0.5)', label: 'SOURCE-MODE · FILE MISSING' },
    }[mode.mode];
    return (
        <div style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '8px 14px',
            background: palette.bg,
            border: `1px solid ${palette.border}`,
            borderRadius: 6,
            fontSize: 11,
        }}>
            <span style={{
                fontWeight: 700, color: palette.fg,
                fontFamily: 'JetBrains Mono, Menlo, monospace',
                letterSpacing: 0.6,
            }}>
                {palette.label}
            </span>
            <span style={{ opacity: 0.7, color: '#f0e6ff', lineHeight: 1.4 }}>
                {mode.rationale}
            </span>
        </div>
    );
};

interface SubwayInflowProps {
    sourceFileName: string;
    sourceCodec: string;
    sourceRes: string;
    sourceFps: string;
    timelineDescription: string;
}
const SubwayInflow: React.FC<SubwayInflowProps> = ({
    sourceFileName, sourceCodec, sourceRes, sourceFps, timelineDescription,
}) => (
    <div style={{
        display: 'flex', flexDirection: 'column', gap: 6,
        minWidth: 220,
    }}>
        {/* Live lane: VS reads the file directly */}
        <div style={{
            padding: '8px 12px',
            background: 'rgba(68, 255, 153, 0.10)',
            border: '1px solid rgba(68, 255, 153, 0.5)',
            borderRadius: 6,
            display: 'flex', flexDirection: 'column', gap: 2,
            boxShadow: '0 0 10px rgba(68, 255, 153, 0.15)',
        }}>
            <div style={{
                fontSize: 9, fontWeight: 700,
                color: '#44ff99',
                fontFamily: 'JetBrains Mono, Menlo, monospace',
                letterSpacing: 0.5,
            }}>
                VS · DIRECT FROM DISK
            </div>
            <div style={{
                fontSize: 11, color: '#f0e6ff', fontWeight: 600,
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                maxWidth: 260,
            }} title={sourceFileName}>
                {sourceFileName || '—'}
            </div>
            <div style={{ display: 'flex', gap: 8, fontSize: 9, opacity: 0.7, fontFamily: 'JetBrains Mono, Menlo, monospace' }}>
                <span>{sourceCodec}</span>
                <span>{sourceRes}</span>
                <span>{sourceFps}</span>
            </div>
            <div style={{
                marginTop: 4,
                height: 3,
                borderRadius: 2,
            }} className="vsynth-subway-flow" />
            <div style={{ fontSize: 8, opacity: 0.6, color: '#9be5a0', letterSpacing: 0.4 }}>
                core.lsmas.LWLibavSource(...)
            </div>
        </div>

        {/* Bypassed lane: Resolve's timeline pixels exist but aren't consumed */}
        <div style={{
            padding: '6px 10px',
            background: 'rgba(120, 120, 140, 0.06)',
            border: '1px dashed rgba(170, 170, 190, 0.25)',
            borderRadius: 6,
            display: 'flex', flexDirection: 'column', gap: 2,
            opacity: 0.55,
        }}
             title="In source-mode the OFX clip is still wired to the renderer but VS does not consume its frames — they only exist so Resolve's playhead + UI stay alive.">
            <div style={{
                fontSize: 8, fontWeight: 600,
                color: '#aab', letterSpacing: 0.5,
                fontFamily: 'JetBrains Mono, Menlo, monospace',
            }}>
                RESOLVE TIMELINE · BYPASSED
            </div>
            <div style={{ fontSize: 9, color: '#aab', fontFamily: 'JetBrains Mono, Menlo, monospace' }}>
                {timelineDescription}
            </div>
            <div style={{
                marginTop: 2,
                height: 2,
                borderRadius: 1,
            }} className="vsynth-subway-bypass" />
        </div>
    </div>
);

const Rail: React.FC<{ title: string; subtitle: string; children: React.ReactNode }> = ({ title, subtitle, children }) => (
    <div style={{
        background: 'rgba(26, 8, 48, 0.5)',
        border: '1px solid #2a1850',
        borderRadius: 8,
        padding: 14,
        display: 'flex', flexDirection: 'column', gap: 12,
    }}>
        <div>
            <h3 style={{ margin: 0, fontSize: 11, color: '#c4a8ff', letterSpacing: 0.6, textTransform: 'uppercase' }}>{title}</h3>
            <p style={{ margin: '2px 0 0 0', fontSize: 10, opacity: 0.55 }}>{subtitle}</p>
        </div>
        <div style={{
            display: 'flex', alignItems: 'center', gap: 0,
            flexWrap: 'wrap', rowGap: 12,
        }}>
            {children}
        </div>
    </div>
);

interface BlockProps {
    title: string;
    subtitle?: string;
    rows: [string, string][];
    accent: string;
    pulse?: 'match' | 'mismatch' | 'none';
    /** Show the matrix-only capability note in this block. */
    ocio?: boolean;
}
const Block: React.FC<BlockProps> = ({ title, subtitle, rows, accent, pulse = 'none', ocio = false }) => {
    const pulseClass = pulse === 'mismatch' ? 'vsynth-pulse-mismatch'
                     : pulse === 'match'    ? 'vsynth-pulse-match'
                     : '';
    return (
        <div className={pulseClass} style={{
            padding: '8px 12px',
            background: '#0d0418',
            border: `1px solid ${accent}80`,  // accent with ~50% alpha (hex8)
            borderRadius: 6,
            minWidth: 140,
            display: 'flex', flexDirection: 'column', gap: 4,
        }}>
            <div style={{
                display: 'flex', alignItems: 'center', gap: 6,
                fontSize: 9, opacity: 0.75,
                textTransform: 'uppercase', letterSpacing: 0.7,
                color: accent,
                fontWeight: 600,
            }}>
                <span>{title}</span>
                {ocio && <OCIOBadge size={11} />}
            </div>
            {subtitle && (
                <div style={{ fontSize: 9, opacity: 0.45, letterSpacing: 0.3 }}>{subtitle}</div>
            )}
            {rows.map(([k, v]) => (
                <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 11 }}>
                    <span style={{ opacity: 0.5 }}>{k}</span>
                    <span style={{ fontWeight: 600, color: accent === '#ff5577' ? '#ff8aa0' : '#f0e6ff', fontFamily: 'JetBrains Mono, Menlo, monospace', fontSize: 10.5 }}>
                        {v}
                    </span>
                </div>
            ))}
        </div>
    );
};

// Connector — a horizontal line with a label above it. The line gets a small
// arrowhead on the right via CSS borders so we don't need an SVG file. Width
// adapts to its label.
const Connector: React.FC<{ label: string; wide?: boolean }> = ({ label, wide = false }) => (
    <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        minWidth: wide ? 130 : 70,
        padding: '0 4px',
        position: 'relative',
    }}>
        <div style={{
            fontSize: 9,
            opacity: 0.65,
            textTransform: 'lowercase',
            letterSpacing: 0.3,
            color: '#c4a8ff',
            marginBottom: 2,
            whiteSpace: 'nowrap',
            fontFamily: 'JetBrains Mono, Menlo, monospace',
        }}>
            {label}
        </div>
        <div style={{
            position: 'relative',
            width: '100%',
            height: 1,
            background: 'linear-gradient(90deg, rgba(196, 168, 255, 0.6) 0%, rgba(196, 168, 255, 0.3) 100%)',
        }}>
            {/* Right-pointing chevron made from CSS borders */}
            <div style={{
                position: 'absolute', right: -1, top: -3,
                width: 0, height: 0,
                borderTop: '3px solid transparent',
                borderBottom: '3px solid transparent',
                borderLeft: '5px solid rgba(196, 168, 255, 0.6)',
            }} />
        </div>
    </div>
);

const FilterBlock: React.FC<{ step: ChainStep; stepNumber: number }> = ({ step, stepNumber }) => {
    const label = typeof step.params.label === 'string' && step.params.label.trim().length > 0
        ? (step.params.label as string)
        : step.type;
    // Stage playbooks: hover any block for the full stage skill (purpose / when
    // to use / key params / notes) — the same content the Archivist reads via
    // its get_stage_playbook tool. The summary line explains what THIS step is
    // doing (derived from typed params, or a sniff of script code).
    const playbook = playbookForStage(step.stage);
    const summary = stepSummary(step);
    const hoverText = playbook
        ? `${playbook.title} — ${playbook.purpose}\n\nWhen: ${playbook.whenToUse}\n\n${playbook.notes}`
        : `Canonical pipeline stage ${step.stage}`;
    return (
        <div
            title={hoverText}
            style={{
                padding: '8px 12px',
                background: 'linear-gradient(135deg, rgba(255, 43, 214, 0.12) 0%, rgba(138, 43, 226, 0.12) 100%)',
                border: '1px solid rgba(255, 43, 214, 0.4)',
                borderRadius: 6,
                minWidth: 130,
                maxWidth: 240,
                display: 'flex', flexDirection: 'column', gap: 2,
                boxShadow: '0 0 12px rgba(255, 43, 214, 0.15)',
            }}>
            {/* "Step N · type · stage" — leading ordinal so the user maps each
                block back to its place in the chain editor. */}
            <div style={{
                fontSize: 10, fontWeight: 700,
                color: '#ff2bd6',
                fontFamily: 'JetBrains Mono, Menlo, monospace',
                letterSpacing: 0.4,
            }}>
                Step {stepNumber}
            </div>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#f0e6ff' }}>
                {label}
            </div>
            <div style={{ fontSize: 9, opacity: 0.5, fontFamily: 'JetBrains Mono, Menlo, monospace' }}>
                {step.type}
            </div>
            {summary && (
                <div style={{ fontSize: 9.5, lineHeight: 1.45, color: '#2bffd6', opacity: 0.85 }}>
                    {summary}
                </div>
            )}
            <div style={{
                fontSize: 8, opacity: 0.5,
                textTransform: 'uppercase', letterSpacing: 0.7,
                color: '#c4a8ff',
            }}>
                {stageLabelForNumber(step.stage)}
            </div>
        </div>
    );
};

const PassthroughBlock: React.FC = () => (
    <div style={{
        flex: 1, minWidth: 200,
        padding: '12px 16px',
        background: 'transparent',
        border: '1px dashed rgba(255, 255, 255, 0.18)',
        borderRadius: 6,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 11, opacity: 0.5, fontStyle: 'italic',
    }}>
        passthrough — no approved steps
    </div>
);

// ───────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────

// Convert "Rec.709" → "709", "Rec.2020" → "2020ncl", etc. — mirrors
// matrix_for() in common/color/color.cpp so the displayed slug matches what
// the composer actually emits to mvf.ToYUV.
function matrixSlug(cs: string): string {
    const has = (token: string) => cs.includes(token);
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
    return '709 (fallback)';
}

function transferSlug(γ: string): string {
    if (γ === 'BT.1886') return 'bt1886';
    if (γ === 'sRGB')    return 'srgb';
    if (γ === 'Linear')  return 'linear';
    if (γ.startsWith('Gamma')) return γ.replace('Gamma ', 'γ');
    if (γ.startsWith('ST.2084')) return 'pq';
    if (γ === 'HLG')     return 'hlg';
    return γ.toLowerCase();
}

// Loose label match. ffprobe's "bt709" should match "Rec.709"; "smpte170m"
// should match "Rec.601 (525)". This is intentionally fuzzy — the user can
// override the dropdowns to a more specific value.
function normalize(s: string): string {
    const x = s.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (['bt709', 'rec709', 'rec709a', '709'].includes(x)) return 'rec709';
    if (['bt2020', 'rec2020', '2020'].includes(x)) return 'rec2020';
    if (['smpte170m', 'bt601', 'rec601', '601', '170m', 'ntsc'].includes(x)) return 'rec601';
    if (['bt470bg', 'pal', '470bg'].includes(x)) return 'pal';
    if (['bt1886', '1886'].includes(x)) return 'bt1886';
    if (['srgb', 'srgbiec', 'srgbiec6196621'].includes(x)) return 'srgb';
    if (['linear', 'lin'].includes(x)) return 'linear';
    return x;
}
