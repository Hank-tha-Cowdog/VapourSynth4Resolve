// Stage playbooks — renderer wrapper over shared/stage-playbooks.json.
//
// The same JSON drives (1) the Pipeline panel's teaching layer (per-block
// summaries + hover playbooks) and (2) the Archivist/MCP `get_stage_playbook`
// tool in electron/tools/registry.js. Edit the JSON, both surfaces update.

import playbooksJson from '../../shared/stage-playbooks.json';
import type { ChainStep } from '../types';

export interface StagePlaybook {
    stage: number;
    key: string;
    title: string;
    purpose: string;
    whenToUse: string;
    canonicalFilters: string[];
    keyParams: Record<string, string>;
    notes: string;
    caseStudy?: string;
}

// The JSON's literal types over-narrow (optional keyParams keys infer as
// `undefined`); route through `unknown` to apply our structural interface.
const STAGES: StagePlaybook[] = (playbooksJson as unknown as { stages: StagePlaybook[] }).stages;

export function playbookForStage(stage: number): StagePlaybook | undefined {
    return STAGES.find(s => s.stage === stage);
}

/** One-line "what this block actually does" summary for a Pipeline block.
 *  Native types derive it from typed params; script steps get a light sniff
 *  of the code so the marquee restoration steps (srestore, QTGMC-in-script,
 *  crops) explain themselves in the diagram. */
export function stepSummary(step: ChainStep): string | null {
    const p = step.params as Record<string, unknown>;

    if (step.type === 'qtgmc') {
        const preset = typeof p.preset === 'string' ? p.preset : 'Slower';
        const tff = p.tff !== false ? 'TFF' : 'BFF';
        const dbl = p.fpsDivisor === 1;
        const rate = dbl
            ? 'double-rate bob (2× fps — srestore feed, not a deliverable)'
            : 'single-rate — one MC frame per source frame, no bob';
        return `Motion-compensated deinterlace · ${preset} · ${tff} · ${rate}`;
    }

    if (step.type === 'script') {
        const code = typeof p.code === 'string' ? p.code : '';
        if (/srestore\s*\(/.test(code)) {
            const frate = code.match(/frate\s*=\s*([\d.]+)/)?.[1];
            return `Blend-cadence recovery: locks the standards-converter's repeating blend `
                 + `pattern, discards/reconstructs blended frames, re-times to `
                 + `${frate ?? 'the original'} fps — the pre-conversion motion cadence.`;
        }
        if (/QTGMC\s*\(/.test(code)) {
            const dbl = /FPSDivisor\s*=\s*1\b/.test(code);
            return dbl
                ? 'QTGMC double-rate bob — internal 2× fps feed for the srestore step downstream.'
                : 'QTGMC single-rate motion-compensated deinterlace (no bob).';
        }
        if (/std\.Crop|core\.std\.Crop|\.std\.Crop/.test(code)) {
            return 'Geometry crop — even top-crop preserves field parity when it precedes field ops.';
        }
        if (/bm3d|BM3D/.test(code)) return 'BM3D denoise.';
    }

    return null;
}
