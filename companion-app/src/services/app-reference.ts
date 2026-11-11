// App capability reference for the chatbot — derived from ACTUAL runtime
// state (probe + config), never from a manual that can drift or invent
// features. Small and fixed-shape so prompt overhead is bounded (~450
// tokens typical); sections that don't apply collapse to a single line.
import type { NodeConfig } from '../types';
import { pluginManifestForPrompt } from './installed-plugins';

export const APP_VERSION = 'v2.0.0-alpha (build Oct 27 2026)';

export interface NeuralCapabilitySnapshot {
    rife?: {
        level: 'weights' | 'adapter' | 'backend' | 'load' | 'inference';
        usable: boolean;
        detail: string;
        backend?: string | null;
        model?: string | null;
    };
}

export function appCapabilityReference(
    config: { chain: NodeConfig['chain']; colorManagement: NodeConfig['colorManagement']; clipMetadata?: NodeConfig['clipMetadata'] },
    registeredNamespaces?: ReadonlySet<string>,
    neural?: NeuralCapabilitySnapshot,
): string {
    const lines: string[] = [];
    lines.push(`**APP VERSION: ${APP_VERSION}.** Answer only from what this app can actually do.`);
    lines.push('');
    lines.push('**WORKING features (verified in this build):**');
    lines.push('- Source auto-identification on Configure (Resolve scripting API) with trim handles + retime verdict.');
    lines.push('- Auto-apply on Save and close, with HOST-SIDE VALIDATION: a chain that does not evaluate is REFUSED (config-apply-refused) and the previous chain keeps rendering.');
    lines.push('- Preview tab: TIME-BASED transport (play/seek/frame-step) rendering the host\'s composed script; hold the image for same-presentation-time source A/B even when the chain changes cadence; wheel zoom, Fit (Shift+Z).');
    lines.push('- Script tab: the exact script the node runs (highlighted, copyable, per-node).');
    lines.push('- Pipeline tab: truthful effective color labels (chain remaps shown).');
    lines.push('- Models tab: optional neural model download (explicit, cancellable, checksum-verified) + live capability snapshot.');
    lines.push('- Chain: stage-ordered steps; drafts need approval before rendering; mix control.');
    lines.push('- Chat history is per-node (nodeGuid) and persists across companion reopen and project save/reopen.');
    lines.push('');
    // NEURAL CAPABILITY — from the authoritative snapshot, never stale text.
    const rife = neural?.rife;
    if (rife && rife.usable) {
        lines.push(`**NEURAL INTERPOLATION (RIFE): AVAILABLE — inference-verified** (${rife.backend || 'backend'}, ${rife.model || 'model'}). You may propose vsmlrt.RIFE for frame interpolation.`);
    } else {
        lines.push(`**NEURAL INTERPOLATION (RIFE): NOT USABLE RIGHT NOW** — capability level: "${rife?.level ?? 'weights'}" (${rife?.detail ?? 'model weights not installed'}). Do NOT propose vsmlrt.RIFE. The installed motion-compensated alternative is core.mv.BlockFPS (mvtools, CPU). If the user asks for RIFE specifically, explain the exact missing component and how to finish installing it — never silently substitute BlockFPS for a RIFE request without asking.`);
    }
    lines.push('');
    lines.push('**NOT available in this build (never claim these):**');
    lines.push('- Timeline frame-rate/cadence changes from inside the chain: an interpolation step produces more frames IN THE SCRIPT, but the OFX node still delivers frames on Resolve\'s timeline clock — a frame-rate conversion must be planned with the Resolve timeline, and you must say so when asked.');
    lines.push('- GPU upscaling (NNEDI3 upscaling is CPU; BM3D Metal denoise is the only measured GPU filter — ~3.5x vs CPU).');
    lines.push('');
    lines.push(pluginManifestForPrompt(registeredNamespaces));
    return lines.join('\n');
}