// Conversation auto-compaction (TKT-A6).
//
// When Skippy chat passes a threshold, we send the older portion to the active
// LLM with a "summarize this" instruction, then replace those messages with a single
// `archived` marker that holds the summary. Subsequent turns retain the summary as
// context but only count toward the recent-tail window from then on.
//
// We deliberately use whichever provider the user currently has selected — same model,
// same cost profile, no surprises. If summarization fails (e.g. transient API error)
// we leave the conversation as-is and retry on the next trigger.

import { streamArchivist } from './archivist';
import type { ChatMessage } from '../types';

export const COMPACTION_THRESHOLD = 22;   // trigger once chat reaches 22 messages
export const KEEP_RECENT = 10;            // last 10 messages stay verbatim

const SUMMARIZE_SYSTEM = `You are a precise conversation summarizer for Skippy, an AI restoration assistant inside VapourSynth-for-Resolve.

You are given a transcript between a colorist and Skippy. Produce a tight summary (under 250 words) that preserves:
- The colorist's stated preferences, taste, working style decisions
- Material context: source format, generation, observed artifacts, color space
- Filter recipes that were decided on, with key parameter values
- Any unresolved questions or open threads

Output plain prose only. No headers, no bullets, no emojis, no preamble. Write as if briefing a successor who must continue this restoration without losing context.`;

export async function summarizeMessages(
    messages: ChatMessage[],
    modelId: string,
): Promise<string> {
    const transcript = messages
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .map(m => `[${m.role.toUpperCase()}] ${m.text}`)
        .join('\n\n');

    const userTurn: ChatMessage = {
        id: 'compactor-prompt',
        role: 'user',
        text: 'Summarize this transcript:\n\n' + transcript,
        timestamp: new Date().toISOString(),
    };

    return new Promise((resolve, reject) => {
        let accumulated = '';
        let errored = false;
        const handle = streamArchivist({
            messages: [userTurn],
            system: SUMMARIZE_SYSTEM,
            modelId,
            onChunk: (chunk) => { accumulated += chunk; },
            onError: (msg) => { errored = true; reject(new Error(msg)); },
        });
        handle.done.then(() => {
            if (errored) return;
            const trimmed = accumulated.trim();
            if (trimmed) resolve(trimmed);
            else reject(new Error('summarizer produced no output'));
        });
    });
}
