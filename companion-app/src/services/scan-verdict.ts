// Synthesizes ONE authoritative scan-type + field-order verdict across multiple
// sources of evidence, with a confidence level the UI can color-code.
//
// User-surfaced bug being fixed: an SD NTSC clip transcoded into a progressive-
// flagged ProRes/MOV/MP4 was showing as "Progressive" because every metadata
// source (ffprobe + idet + MediaInfo current) reported progressive after the
// transcode, even though the actual pixels and the SD broadcast provenance
// (PAR 0.909, height 480, 29.97 fps, SMPTE 170M, MediaInfo original=Interlaced)
// all said interlaced. The verdict now incorporates these heuristics — when they
// strongly disagree with the metadata sources, the verdict flips to
// "Suspected" with the heuristic reasoning visible in tooltip + system prompt.
//
// Priority (RECONCILED 2026-11-11 with the idet-first contract — pixel
// evidence is measured on frames; heuristics are provenance priors):
//   1. idet ≥ 0.9           — DECISIVE pixel evidence. Heuristics may record
//                             a suspicion (major disagreement, medium
//                             confidence) but cannot flip a decisive reading.
//   2. Heuristic override   — ≥ 0.7 opposite the pick flips the verdict to
//                             Suspicious when pixels are weaker (idet < 0.9)
//                             or absent (MediaInfo/ffprobe/fallback picks) —
//                             the canonical "SD broadcast transcoded as
//                             progressive" case.
//   3. idet ≥ 0.8           — over MediaInfo/ffprobe
//   4. MediaInfo current    — when present and idet absent/low-conf
//   5. idet (low conf)      — still beats container flags
//   6. ffprobe field_order  — last resort
//   7. Heuristic-only       — when no metadata source is available at all

import type { SourceVideoMetadata } from '../types';

export type ScanType = 'Interlaced' | 'Progressive' | 'Ambiguous';
export type FieldOrder = 'TFF' | 'BFF' | 'N/A' | '?';
export type Authority = 'idet' | 'mediainfo' | 'ffprobe' | 'heuristic' | 'fallback';
export type Confidence = 'high' | 'medium' | 'low' | 'suspected';

export interface PerSourceReading {
    scanType: ScanType | null;
    fieldOrder: FieldOrder | null;
    note?: string;
}

export interface HeuristicAnalysis {
    interlacedScore: number;   // 0..1
    progressiveScore: number;  // 0..1
    indicators: string[];      // human-readable signals
}

export interface ScanVerdict {
    scanType: ScanType;
    fieldOrder: FieldOrder;
    authority: Authority;
    confidence: Confidence;
    confidencePct?: number;    // idet's percentage when available
    sources: {
        ffprobe?: PerSourceReading;
        idet?: PerSourceReading & { confidence: number; breakdown?: SourceVideoMetadata['scanBreakdown'] };
        mediainfo?: PerSourceReading;
    };
    heuristics: HeuristicAnalysis;
    /** MediaInfo provenance. Only set when it differs from the verdict. */
    original?: { scanType: ScanType; fieldOrder: FieldOrder } | null;
    disagreement: 'none' | 'minor' | 'major';
    explanation: string;
}

function parseFfprobeFieldOrder(fo: string): PerSourceReading | null {
    if (!fo) return null;
    switch (fo) {
        case 'progressive':  return { scanType: 'Progressive', fieldOrder: 'N/A' };
        case 'tt':           return { scanType: 'Interlaced',  fieldOrder: 'TFF' };
        case 'bb':           return { scanType: 'Interlaced',  fieldOrder: 'BFF' };
        case 'tb':           return { scanType: 'Interlaced',  fieldOrder: 'TFF', note: 'TFF-coded BFF (unusual)' };
        case 'bt':           return { scanType: 'Interlaced',  fieldOrder: 'BFF', note: 'BFF-coded TFF (unusual)' };
        case 'interlaced':   return { scanType: 'Interlaced',  fieldOrder: '?' };
        case 'undetermined': return { scanType: 'Ambiguous',   fieldOrder: '?' };
        case 'unknown':      return { scanType: 'Ambiguous',   fieldOrder: '?' };
        default:             return { scanType: 'Ambiguous',   fieldOrder: '?', note: `unknown token "${fo}"` };
    }
}

function parseMediaInfoScan(scanType: string | null, scanOrder: string | null): PerSourceReading | null {
    if (!scanType && !scanOrder) return null;
    const lc = (scanType || '').toLowerCase();
    let t: ScanType;
    if (lc.includes('progressive'))                                       t = 'Progressive';
    else if (lc.includes('interlace') || lc === 'mbaff' || lc === 'paff') t = 'Interlaced';
    else                                                                  t = 'Ambiguous';
    let f: FieldOrder = 'N/A';
    if (scanOrder) {
        const so = scanOrder.toUpperCase();
        if      (so === 'TFF') f = 'TFF';
        else if (so === 'BFF') f = 'BFF';
        else                   f = '?';
    } else if (t === 'Interlaced') {
        f = '?';
    }
    return { scanType: t, fieldOrder: f };
}

/**
 * Heuristic scoring. For colorists working with SD broadcast and tape sources,
 * the combination of (non-square PAR + 480/576 height + 29.97/25 fps + analog
 * broadcast color matrix + MediaInfo "original=Interlaced") is a near-certain
 * signal that the material is interlaced at heart, even if a transcode flagged
 * the container as progressive.
 *
 * Returns scores 0..1 for both interlaced and progressive. Don't assume they
 * sum to 1 — they're independent likelihoods.
 */
export function analyzeHeuristics(v: SourceVideoMetadata): HeuristicAnalysis {
    let interlaced = 0;
    let progressive = 0;
    const indicators: string[] = [];

    // PAR — non-square pixels strongly indicate SD broadcast source (NTSC 10:11,
    // PAL 12:11, anamorphic widescreen variants).
    if (v.sampleAspectRatio) {
        const parts = v.sampleAspectRatio.split(/[:/]/).map(Number);
        const ratio = parts.length === 2 && parts[1] ? parts[0] / parts[1]
                    : !isNaN(parseFloat(v.sampleAspectRatio)) ? parseFloat(v.sampleAspectRatio)
                    : NaN;
        if (!isNaN(ratio) && isFinite(ratio)) {
            if (Math.abs(ratio - 1) > 0.05) {
                interlaced += 0.25;
                indicators.push(`PAR ${ratio.toFixed(3)} (non-square → SD broadcast)`);
            } else {
                progressive += 0.05;
            }
        }
    }

    // Frame height — SD broadcast heights are interlaced-flavored; HD is a mild
    // progressive signal (HDV / 1080i is the exception we don't penalize for).
    if (v.height === 480 || v.height === 486) {
        interlaced += 0.30;
        indicators.push(`Height ${v.height} (NTSC SD)`);
    } else if (v.height === 576) {
        interlaced += 0.30;
        indicators.push('Height 576 (PAL SD)');
    } else if (v.height && v.height >= 1440) {
        progressive += 0.10;
        indicators.push(`Height ${v.height} (UHD-ish; almost always progressive)`);
    }

    // Frame rate — NTSC/PAL broadcast rates suggest interlaced; cinema rates
    // suggest progressive; ≥50 fps strongly suggests progressive.
    if (v.fps != null) {
        if      (Math.abs(v.fps - 29.97)  < 0.01) { interlaced  += 0.20; indicators.push('29.97 fps (NTSC broadcast)'); }
        else if (Math.abs(v.fps - 25.000) < 0.01) { interlaced  += 0.20; indicators.push('25 fps (PAL broadcast)'); }
        else if (Math.abs(v.fps - 23.976) < 0.01) { progressive += 0.30; indicators.push('23.976 fps (film/cinema)'); }
        else if (Math.abs(v.fps - 24.000) < 0.01) { progressive += 0.25; indicators.push('24 fps (cinema)'); }
        else if (v.fps >= 47.9)                   { progressive += 0.25; indicators.push(`${v.fps.toFixed(2)} fps (high frame rate)`); }
    }

    // Codec — DV is interlaced-heavy; MPEG-2 is broadcast; H.264 / H.265 / ProRes
    // are codec-neutral and don't score. (DV gets the strongest weight because
    // it's the canonical interlaced source codec.)
    const codec    = (v.codec    || '').toLowerCase();
    const codecTag = (v.codecTag || '').toLowerCase();
    if (codec.includes('dv ')  || codec.startsWith('dvvideo') || codecTag.startsWith('dv')) {
        interlaced += 0.30; indicators.push('DV codec (overwhelmingly interlaced source)');
    } else if (codec.includes('hdv')) {
        interlaced += 0.25; indicators.push('HDV codec (interlaced HD broadcast)');
    } else if (codec.includes('mpeg-2') || codec.includes('mpeg2') || codec.includes('h.262')) {
        interlaced += 0.15; indicators.push('MPEG-2 codec (commonly interlaced broadcast)');
    }

    // Color matrix — analog broadcast matrices are SD-only and imply interlaced
    // source; BT.709 is mildly progressive (HD); BT.2020 is essentially always.
    if      (v.colorSpace === 'smpte170m') { interlaced  += 0.20; indicators.push('SMPTE 170M matrix (NTSC SD)'); }
    else if (v.colorSpace === 'bt470bg')   { interlaced  += 0.20; indicators.push('BT.470BG matrix (PAL SD)'); }
    else if (v.colorSpace === 'bt709')     { progressive += 0.10; indicators.push('BT.709 matrix (HD)'); }
    else if (v.colorSpace === 'bt2020nc' || v.colorSpace === 'bt2020c') {
        progressive += 0.20; indicators.push('BT.2020 matrix (UHD)');
    }

    // MediaInfo provenance — "original was interlaced" is the strongest single
    // signal that residual interlacing may still be present even if the encoder
    // flagged the result as progressive.
    if (v.mediainfo?.scanTypeOriginal) {
        const orig = v.mediainfo.scanTypeOriginal.toLowerCase();
        if (orig.includes('interlace')) {
            interlaced += 0.40;
            indicators.push('MediaInfo original=Interlaced (deinterlace may be incomplete)');
        } else if (orig.includes('progressive')) {
            progressive += 0.20;
            indicators.push('MediaInfo original=Progressive');
        }
    }

    return {
        interlacedScore: Math.min(1, interlaced),
        progressiveScore: Math.min(1, progressive),
        indicators,
    };
}

export function deriveScanVerdict(v: SourceVideoMetadata): ScanVerdict | null {
    const sources: ScanVerdict['sources'] = {};
    if (v.fieldOrder) {
        const r = parseFfprobeFieldOrder(v.fieldOrder);
        if (r) sources.ffprobe = r;
    }
    if (v.detectedScanType) {
        const r = parseFfprobeFieldOrder(v.detectedScanType);
        if (r) sources.idet = { ...r, confidence: v.scanConfidence ?? 0, breakdown: v.scanBreakdown ?? undefined };
    }
    if (v.mediainfo?.scanType || v.mediainfo?.scanOrder) {
        const r = parseMediaInfoScan(v.mediainfo.scanType, v.mediainfo.scanOrder);
        if (r) sources.mediainfo = r;
    }

    const heuristics = analyzeHeuristics(v);

    // Initial pick by source priority. We'll potentially override with heuristics below.
    let pick: { authority: Authority; reading: PerSourceReading & { confidence?: number } } | null = null;
    if (sources.idet && sources.idet.confidence >= 0.8) {
        pick = { authority: 'idet', reading: sources.idet };
    } else if (sources.mediainfo) {
        pick = { authority: 'mediainfo', reading: sources.mediainfo };
    } else if (sources.idet) {
        pick = { authority: 'idet', reading: sources.idet };
    } else if (sources.ffprobe) {
        pick = { authority: 'ffprobe', reading: sources.ffprobe };
    } else if (heuristics.interlacedScore >= 0.5 || heuristics.progressiveScore >= 0.5) {
        const winner: ScanType = heuristics.interlacedScore >= heuristics.progressiveScore ? 'Interlaced' : 'Progressive';
        pick = {
            authority: 'heuristic',
            reading: {
                scanType: winner,
                fieldOrder: winner === 'Interlaced'
                    ? (v.mediainfo?.scanOrderOriginal as FieldOrder | undefined ?? '?')
                    : 'N/A',
            },
        };
    }
    if (!pick || !pick.reading.scanType || !pick.reading.fieldOrder) return null;

    // Heuristic override (RECONCILED 2026-11-11): when metadata sources agree
    // on one answer but heuristics STRONGLY disagree (≥ 0.7 in the opposite
    // direction), flag suspicion and flip the verdict — EXCEPT against a
    // DECISIVE idet reading (≥ 0.9): pixel evidence measured on the frames is
    // authoritative under the idet-first contract. In that case the suspicion
    // is still SURFACED (major disagreement, medium confidence, explanation
    // note) but the verdict stands. This is the canonical "SD broadcast
    // transcoded as progressive" case for weaker/absent pixel evidence.
    let overrode = false;
    const heuristicSays: ScanType | null =
        heuristics.interlacedScore  - heuristics.progressiveScore >= 0.4 ? 'Interlaced'
      : heuristics.progressiveScore - heuristics.interlacedScore  >= 0.4 ? 'Progressive'
      : null;

    const strongOpposite = heuristics.interlacedScore >= 0.7 || heuristics.progressiveScore >= 0.7;
    const dissent = !!heuristicSays
        && pick.reading.scanType !== 'Ambiguous'
        && heuristicSays !== pick.reading.scanType
        && strongOpposite;
    const idetDecisive = pick.authority === 'idet' && (pick.reading.confidence ?? 0) >= 0.9;

    if (dissent && !idetDecisive) {
        // Override.
        const newFieldOrder: FieldOrder = heuristicSays === 'Interlaced'
            ? ((v.mediainfo?.scanOrderOriginal as FieldOrder | undefined) === 'BFF' ? 'BFF'
              : (v.mediainfo?.scanOrderOriginal as FieldOrder | undefined) === 'TFF' ? 'TFF'
              : '?')
            : 'N/A';
        pick = {
            authority: 'heuristic',
            reading: { scanType: heuristicSays!, fieldOrder: newFieldOrder },
        };
        overrode = true;
    }

    // Disagreement classification (uses the FINAL chosen verdict).
    const allScans = Object.values(sources)
        .map(s => s.scanType)
        .filter((x): x is ScanType => !!x);
    const allOrders = Object.values(sources)
        .map(s => s.fieldOrder)
        .filter((x): x is FieldOrder => !!x && x !== '?' && x !== 'N/A');
    const uniqueScans  = new Set(allScans);
    const uniqueOrders = new Set(allOrders);
    let disagreement: ScanVerdict['disagreement'] = 'none';
    if (uniqueScans.size > 1 || overrode || dissent) disagreement = 'major';
    else if (uniqueOrders.size > 1)       disagreement = 'minor';

    // Confidence determination.
    let confidence: Confidence;
    if (overrode) {
        confidence = 'suspected';
    } else if (dissent && idetDecisive) {
        // Pixel evidence is decisive but strongly contested by provenance:
        // the verdict stands, the uncertainty is honest (medium), and the
        // suspicion is surfaced in the explanation.
        confidence = 'medium';
    } else if (pick.authority === 'idet' && (pick.reading.confidence ?? 0) >= 0.9
               && uniqueScans.size <= 1
               && heuristicSays !== pick.reading.scanType) {
        confidence = 'high';
    } else if (uniqueScans.size <= 1
               && heuristicSays !== pick.reading.scanType
               && Object.keys(sources).length >= 2) {
        confidence = 'high';
    } else if (uniqueScans.size <= 1) {
        confidence = 'medium';
    } else {
        confidence = 'low';
    }

    // MediaInfo "original" — only attach when it differs from the verdict.
    let original: ScanVerdict['original'] = null;
    if (v.mediainfo?.scanTypeOriginal || v.mediainfo?.scanOrderOriginal) {
        const orig = parseMediaInfoScan(v.mediainfo.scanTypeOriginal, v.mediainfo.scanOrderOriginal);
        if (orig && orig.scanType && orig.fieldOrder) {
            const differs = orig.scanType !== pick.reading.scanType
                || (orig.scanType === 'Interlaced'
                    && pick.reading.fieldOrder !== 'N/A'
                    && orig.fieldOrder !== pick.reading.fieldOrder
                    && orig.fieldOrder !== '?'
                    && pick.reading.fieldOrder !== '?');
            if (differs) original = { scanType: orig.scanType, fieldOrder: orig.fieldOrder };
        }
    }

    const explanation = buildExplanation(pick.authority, pick.reading, sources, heuristics, disagreement, original, overrode, confidence, dissent);

    return {
        // pick.reading.scanType / .fieldOrder are guaranteed non-null at this point
        // (we return null earlier if they're missing, and the override path always
        // assigns non-null replacements). The type narrowing doesn't survive the
        // reassign inside the override block — explicit non-null suffices.
        scanType: pick.reading.scanType!,
        fieldOrder: pick.reading.fieldOrder!,
        authority: pick.authority,
        confidence,
        confidencePct: pick.reading.confidence != null
            ? Math.round(pick.reading.confidence * 100)
            : undefined,
        sources,
        heuristics,
        original,
        disagreement,
        explanation,
    };
}

function buildExplanation(
    authority: Authority,
    pick: PerSourceReading & { confidence?: number },
    sources: ScanVerdict['sources'],
    h: HeuristicAnalysis,
    disagreement: ScanVerdict['disagreement'],
    original: ScanVerdict['original'],
    overrode: boolean,
    confidence: Confidence,
    dissent: boolean,
): string {
    const lines: string[] = [];
    const subj = `${pick.scanType}${pick.scanType === 'Interlaced'
        && pick.fieldOrder !== 'N/A'
        && pick.fieldOrder !== '?' ? ` (${pick.fieldOrder})` : ''}`;

    lines.push(`Verdict: ${subj}.`);
    lines.push(`Confidence: ${confidence}.`);

    if (overrode) {
        lines.push('');
        lines.push('⚠ HEURISTIC OVERRIDE: metadata sources said the opposite, but PAR / resolution / '
            + 'frame rate / codec / color matrix / MediaInfo-original all point to this answer. This '
            + 'is the canonical "SD broadcast tape transcoded into progressive-flagged ProRes/MOV/MP4" '
            + 'pattern — the encoder said "progressive" but the underlying material is interlaced.');
    } else if (dissent) {
        lines.push('');
        lines.push('⚠ PIXEL EVIDENCE STANDS: idet measured this scan type directly on the frames at '
            + 'decisive confidence, so it outranks the provenance heuristics below (idet-first '
            + 'contract). The strong heuristic disagreement is recorded as a SUSPICION (major '
            + 'disagreement, medium confidence): if you know the source provenance contradicts the '
            + 'verdict (broadcast master, tape capture), verify visually before trusting it.');
    } else {
        lines.push(`Primary source: ${authority}${pick.confidence != null
            ? ` at ${Math.round(pick.confidence * 100)}% confidence` : ''}.`);
    }

    if (Object.keys(sources).length) {
        lines.push('');
        lines.push('Per-source metadata:');
        if (sources.idet) {
            const conf = Math.round((sources.idet.confidence ?? 0) * 100);
            const bd = sources.idet.breakdown;
            const tail = bd ? ` (TFF ${bd.tff}, BFF ${bd.bff}, prog ${bd.progressive}, undet ${bd.undetermined} of ${bd.total})` : '';
            lines.push(`  • idet (pixel content, ${conf}%): ${sources.idet.scanType} ${sources.idet.fieldOrder}${tail}`);
        }
        if (sources.mediainfo) lines.push(`  • MediaInfo:               ${sources.mediainfo.scanType} ${sources.mediainfo.fieldOrder}`);
        if (sources.ffprobe) {
            const note = sources.ffprobe.note ? ` — ${sources.ffprobe.note}` : '';
            lines.push(`  • ffprobe (container):     ${sources.ffprobe.scanType} ${sources.ffprobe.fieldOrder}${note}`);
        }
    }

    if (h.indicators.length) {
        lines.push('');
        lines.push(`Heuristic signals  (interlaced ${h.interlacedScore.toFixed(2)} · progressive ${h.progressiveScore.toFixed(2)}):`);
        for (const s of h.indicators) lines.push(`  • ${s}`);
    }

    if (disagreement === 'major' && !overrode) {
        lines.push('');
        lines.push('⚠ MAJOR disagreement — sources disagree on scan type (interlaced vs progressive). '
            + 'Trust the higher-authority value above.');
    } else if (disagreement === 'minor') {
        lines.push('');
        lines.push('Minor disagreement on field order only.');
    }

    if (original) {
        lines.push('');
        lines.push(`Original (MediaInfo provenance): ${original.scanType}${original.fieldOrder !== 'N/A' ? ` ${original.fieldOrder}` : ''}.`);
        lines.push('What the material was BEFORE encoding. Reflects provenance; the verdict above is the CURRENT scan, which is what matters for filter params.');
    }
    return lines.join('\n');
}
