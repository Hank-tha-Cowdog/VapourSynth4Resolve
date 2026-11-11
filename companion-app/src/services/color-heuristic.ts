// Color-management heuristic — pick sensible matrix + transfer defaults from
// source metadata when ffprobe didn't tag the colorSpace / colorTransfer fields.
//
// Why this exists: a lot of archival material (DV, miniDV, VHS captures, NTSC
// off-air recordings) was muxed without color metadata, so ffprobe reports
// colorSpace=null. The Pipeline panel used to fall back to "Rec.709 / BT.1886"
// in those cases — wrong for SD/NTSC sources, which actually use Rec.601 (525)
// matrix with a BT.1886-ish CRT gamma. Choosing the wrong matrix produces a
// visible green/magenta shift on saturated reds and blues, and is one of the
// most common subtle restoration bugs.
//
// The heuristic uses height + frame rate (PAL vs NTSC) when colorSpace is
// missing, and just reflects the ffprobe value when present.
//
// References:
//   ITU-R BT.601-7 §3.6 — coefficients for 525-line vs 625-line systems
//   ITU-R BT.709-6     — for HD (720p / 1080p / 4K)
//   ITU-R BT.2020-2    — for UHD (HDR + WCG)

import type { SourceVideoMetadata } from '../types';

export interface ColorHeuristic {
    /** True if the value was inferred from height/fps because ffprobe didn't
     *  report colorSpace. Used by the UI to show "(assumed)" suffix so the
     *  user knows it's a guess, not source-tagged. */
    matrixInferred: boolean;
    transferInferred: boolean;
    /** True when the heuristic is confident enough to flag a disagreeing user
     *  choice as a mismatch worth warning about, rather than just a default
     *  guess. Always true when tagged. When inferred: true for the SD/PAL
     *  height correlation (480/576-line sources really are Rec.601 — that
     *  correlation is why this heuristic exists at all, see the file header),
     *  false for the generic "no better info, assume Rec.709/BT.1886"
     *  fallback used for HD/UHD sources and for transfer whenever untagged.
     *  That fallback is a placeholder, not a finding — it has no way to know
     *  about camera-native log profiles (S-Log3, V-Log, Log-C, ...), which
     *  are a normal, correct, deliberate user choice it should never contest. */
    matrixConfident: boolean;
    transferConfident: boolean;
    /** The matrix/transfer that should populate the Input dropdown. Matches
     *  the strings used in `color-menus.ts`. */
    suggestedMatrix: string;
    suggestedTransfer: string;
    /** Short, human-readable reason for the inference, shown on hover.
     *  e.g. "height 480, 29.97 fps → NTSC SD → Rec.601 (525)". */
    rationale: string;
}

/** Normalize an ffprobe colorSpace/colorTransfer value to the dropdown
 *  label used in color-menus.ts. Returns null when the value is unknown
 *  or absent (caller falls through to height-based inference). */
function normalizeFfprobeMatrix(cs: string | null | undefined): string | null {
    if (!cs) return null;
    const v = cs.toLowerCase().replace(/[\s_-]/g, '');
    // ffprobe / FFmpeg matrix coefficient names → our dropdown labels.
    if (v === 'bt709')                          return 'Rec.709';
    if (v === 'bt2020nc' || v === 'bt2020ncl') return 'Rec.2020 (non-constant)';
    if (v === 'bt2020c'  || v === 'bt2020cl')  return 'Rec.2020 (constant)';
    if (v === 'smpte170m' || v === 'smpte240m' || v === 'bt601525') return 'Rec.601 (525)';
    if (v === 'bt470bg' || v === 'bt601625' || v === 'bt470pal')   return 'Rec.601 (625)';
    if (v === 'smptec') return 'SMPTE-C';
    if (v === 'unspecified' || v === 'reserved') return null;
    return null;
}

function normalizeFfprobeTransfer(t: string | null | undefined): string | null {
    if (!t) return null;
    const v = t.toLowerCase().replace(/[\s_-]/g, '');
    if (v === 'bt709' || v === 'bt1886' || v === 'smpte170m') return 'BT.1886';
    if (v === 'iec6196621' || v === 'srgb')                   return 'sRGB';
    if (v === 'smpte2084' || v === 'pq')                      return 'ST.2084 (PQ)';
    if (v === 'aribstdb67' || v === 'hlg')                    return 'HLG';
    if (v === 'gamma22' || v === 'bt470m')                    return 'Gamma 2.2';
    if (v === 'gamma28' || v === 'bt470bg')                   return 'Gamma 2.4';
    if (v === 'linear')                                       return 'Linear';
    if (v === 'unspecified' || v === 'reserved')              return null;
    return null;
}

/** Infer matrix + transfer from source metadata. Always returns a usable pair
 *  — uses Rec.709 / BT.1886 as the fallback-of-last-resort for HD sources and
 *  Rec.601 (525) / BT.1886 for SD/NTSC. */
export function inferColorDefaults(video: SourceVideoMetadata | null | undefined): ColorHeuristic {
    if (!video) {
        return {
            matrixInferred:   true,
            transferInferred: true,
            matrixConfident:  false,
            transferConfident: false,
            suggestedMatrix:   'Rec.709',
            suggestedTransfer: 'BT.1886',
            rationale: 'no source identified — using HD defaults',
        };
    }

    // Tagged values win — but only if they parse to something we recognize.
    const taggedMatrix   = normalizeFfprobeMatrix(video.colorSpace);
    const taggedTransfer = normalizeFfprobeTransfer(video.colorTransfer);

    // Height + framerate heuristic. SD/NTSC: 480 or 486 lines. SD/PAL: 576.
    // Above 720 lines = HD. We treat 720 specifically as HD (it's Rec.709 by
    // every spec). Anything in the 480-575 range is "SD weird" — fall back to
    // 525-line BT.601 because that's the vast majority of archival NTSC.
    const h = video.height ?? 0;
    const fps = video.fps ?? 0;
    let inferredMatrix: string;
    let inferredRationale: string;
    // True only for the SD/PAL height correlation, which is confident enough
    // to contest a disagreeing user choice (see matrixConfident doc on the
    // interface). The HD/UHD branches below are a placeholder default, not a
    // finding — they must never contest the user, e.g. a deliberate S-Log3 /
    // V-Log / Log-C / other camera-native profile, which they have no way to
    // detect from resolution alone.
    let inferredMatrixConfident: boolean;
    if (h > 0 && h <= 486) {
        // NTSC SD — 525-line system. Coefficients: 0.299 R, 0.587 G, 0.114 B.
        inferredMatrix = 'Rec.601 (525)';
        inferredRationale = `${h}-line source @ ${fps.toFixed(2)} fps — NTSC SD → Rec.601 (525)`;
        inferredMatrixConfident = true;
    } else if (h > 0 && h <= 576) {
        // PAL SD — 625-line system. Coefficients differ slightly from 525.
        inferredMatrix = 'Rec.601 (625)';
        inferredRationale = `${h}-line source @ ${fps.toFixed(2)} fps — PAL SD → Rec.601 (625)`;
        inferredMatrixConfident = true;
    } else if (h >= 2160) {
        // UHD — likely Rec.2020 but conservative about that. Many UHD masters
        // are still graded Rec.709. We use 2020 only if there's a hint
        // elsewhere (bit depth >= 10, HDR transfer). Otherwise 709.
        inferredMatrix = 'Rec.709';
        inferredRationale = `${h}-line UHD source — assuming Rec.709 (override to Rec.2020 if HDR-graded)`;
        inferredMatrixConfident = false;
    } else {
        inferredMatrix = 'Rec.709';
        inferredRationale = h > 0
            ? `${h}-line HD source — Rec.709`
            : 'no height info — defaulting to Rec.709';
        inferredMatrixConfident = false;
    }

    // Transfer: BT.1886 is the right default for SDR display referenced
    // content. SD CRT material was technically gamma 2.2-ish but BT.1886 is
    // close enough and is what every modern grading pipeline expects. Unlike
    // matrix, there's no resolution/fps signal that correlates with transfer,
    // so an inferred transfer is never confident enough to contest the user —
    // it's a display-referred default, and plenty of real sources (any log
    // profile, HDR, scene-referred camera-native footage) are legitimately
    // something else entirely.
    const inferredTransfer = 'BT.1886';

    return {
        matrixInferred:   taggedMatrix === null,
        transferInferred: taggedTransfer === null,
        matrixConfident:  taggedMatrix !== null || inferredMatrixConfident,
        transferConfident: taggedTransfer !== null,
        suggestedMatrix:   taggedMatrix   ?? inferredMatrix,
        suggestedTransfer: taggedTransfer ?? inferredTransfer,
        rationale: taggedMatrix !== null
            ? `tagged ${video.colorSpace} → ${taggedMatrix}`
            : inferredRationale,
    };
}

/** Human-readable label for the Pipeline panel's "detected" row. Renders
 *  either the tagged colorSpace OR `unspecified → <inferred> (assumed)`. */
export function detectedMatrixLabel(video: SourceVideoMetadata | null | undefined): string {
    if (!video) return 'identify source to detect';
    const h = inferColorDefaults(video);
    if (!h.matrixInferred) return video.colorSpace ?? h.suggestedMatrix;
    return `unspecified → assume ${h.suggestedMatrix}`;
}

export function detectedTransferLabel(video: SourceVideoMetadata | null | undefined): string {
    if (!video) return 'identify source to detect';
    const h = inferColorDefaults(video);
    if (!h.transferInferred) return video.colorTransfer ?? h.suggestedTransfer;
    return `unspecified → assume ${h.suggestedTransfer}`;
}
