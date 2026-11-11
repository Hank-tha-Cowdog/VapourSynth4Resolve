import { Sparkles, Bot, Brain, Cpu, Terminal, Globe, Cloud } from 'lucide-react';
import type { LLMModel, FilterStage } from './types';

export const DEFAULT_SCRIPT = `# VapourSynth filter chain script step
# This block runs after stage ${'$'}{stage} of the chain.
# 'clip' is the input frame at this point; assign to 'clip' to emit the result.

clip = clip
`;

// Model IDs are namespaced `<providerId>/<apiModelId>` — the apiModelId is the
// EXACT identifier the provider API expects (never a guessed translation),
// and for OpenRouter it is the provider-prefixed ID OpenRouter itself returns.
// Display names live only in `name`.
//
// CAPABILITY HONESTY (2026-10-27):
//   - toolLoop: ONLY Anthropic implements the app's tool-use loop today.
//     Non-Anthropic entries are text-only; Skippy must NEVER claim a chain
//     changed because a text-only model produced prose.
//   - `unverified` entries: model IDs from user-checked docs that have NOT
//     been live-tested through this app (no paid API calls were made). A
//     saved key is not proof of authentication/availability.
//   - local entries (LM Studio/Ollama) are static examples, not discovered
//     or verified loaded models. Server reachability and inference remain
//     UNVERIFIED; this catalog does not perform local model discovery.
export const LLM_MODELS: LLMModel[] = [
    // Anthropic — tool loop implemented; docs-checked 2026-10-27
    // (claude-sonnet-5-5 / claude-opus-5-5 per platform.claude.com; the
    // 2026-10-21 API version rejects older sampling params).
    { id: 'anthropic/claude-sonnet-5-5',   name: 'Claude Sonnet 5.5',          provider: 'anthropic', icon: Brain, toolLoop: true },
    { id: 'anthropic/claude-opus-5-5',     name: 'Claude Opus 5.5',            provider: 'anthropic', icon: Brain, toolLoop: true },
    { id: 'anthropic/claude-haiku-4-5',   name: 'Claude Haiku 4.5 (fast)',    provider: 'anthropic', icon: Brain, toolLoop: true },
    // OpenAI — GPT-6 family (docs-checked 2026-10-27: gpt-6-astra,
    // gpt-6.1-sol, gpt-6.1-terra, gpt-6-luna). Tool calling needs the
    // Responses integration — NOT yet wired; text-only here.
    { id: 'openai/gpt-6-astra',            name: 'GPT-6 Astra',             provider: 'openai',    icon: Bot,  toolLoop: false, unverified: true },
    { id: 'openai/gpt-6.1-sol',            name: 'GPT-6.1 Sol (flagship)',    provider: 'openai',    icon: Bot,  toolLoop: false, unverified: true },
    { id: 'openai/gpt-6.1-terra',          name: 'GPT-6.1 Terra (balanced)',  provider: 'openai',    icon: Bot,  toolLoop: false, unverified: true },
    { id: 'openai/gpt-6-luna',             name: 'GPT-6 Luna (fast)',          provider: 'openai',    icon: Bot,  toolLoop: false, unverified: true },
    // OpenRouter — provider-prefixed IDs exactly as OpenRouter returns them.
    { id: 'openrouter/openai/gpt-6.1-sol', name: 'OpenRouter · GPT-6.1 Sol',   provider: 'openrouter', icon: Globe, toolLoop: false, unverified: true },
    { id: 'openrouter/anthropic/claude-sonnet-5-5', name: 'OpenRouter · Claude Sonnet 5.5', provider: 'openrouter', icon: Globe, toolLoop: false, unverified: true },
    // Local — static examples. The selected ID is sent unchanged; there is
    // no loaded-model discovery or automatic ID substitution in this UI.
    { id: 'lmstudio/local-model',         name: 'LM Studio · local-model (example)', provider: 'lmstudio', icon: Cpu, toolLoop: false, unverified: true },
    { id: 'ollama/llama3.3',               name: 'Ollama · llama3.3 (example)', provider: 'ollama', icon: Terminal, toolLoop: false, unverified: true },
    { id: 'ollama/mistral',                name: 'Ollama · mistral (example)',  provider: 'ollama', icon: Terminal, toolLoop: false, unverified: true },
    { id: 'ollama/qwen3',                  name: 'Ollama · qwen3 (example)',    provider: 'ollama', icon: Terminal, toolLoop: false, unverified: true },
];

export const STAGE_LABELS: Record<FilterStage, string> = {
    'preprocess': 'Preprocess',
    'field-ops':  'Field Operations',
    'crop':       'Crop / Borders',
    'denoise':    'Denoise',
    'restore':    'Restore',
    'sharpen':    'Sharpen / Detail',
    'frame-ops':  'Frame Operations',
    'resize':     'Resize / Scale',
    'format':     'Format / Output',
};

export const STAGE_ORDER: FilterStage[] = [
    'preprocess', 'field-ops', 'crop', 'denoise', 'restore',
    'sharpen', 'frame-ops', 'resize', 'format',
];

export const ARCHIVIST_GREETING = "Skippy online. Restoration tools loaded.";
