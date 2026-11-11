// Anthropic Messages API — streaming agentic loop.
//
// This provider runs a real tool loop: stream a turn; if the model calls tools,
// execute them (via executeAgentTool from main.js — renderer bridge for
// propose_chain_edit, registry executor for probe_source / get_chain_state /
// get_plugin_status / render_sample), append assistant content + tool_results,
// and continue until the model stops calling tools. That lets one user turn do
// probe → propose → render-sample → refine.
//
// Claude 5 family notes (claude-opus-5 / claude-sonnet-5):
//   - Adaptive thinking is ON by default when the `thinking` param is omitted, and
//     thinking tokens count against max_tokens — so max_tokens needs real headroom.
//   - Safety classifiers can decline with HTTP 200 + stop_reason === "refusal";
//     content may be empty. Surface it, don't crash.
//   - temperature / top_p / budget_tokens are rejected on these models; we send none.
// claude-haiku-4-5 predates adaptive thinking; omitting `thinking` there simply
// runs without thinking, which is what we want for the fast tier.

const AnthropicSDK = require('@anthropic-ai/sdk');
const Anthropic = AnthropicSDK.default ?? AnthropicSDK; // CJS shape varies across SDK majors

// This bounds one user turn's probe -> edit -> render-sample -> refine loop —
// not a safety limit, an app-level pacing choice. 6 was too tight for the
// workflow this app is actually built for: a single real iteration session
// (probe a source, check a stage playbook, apply an edit, render_sample to
// verify, adjust, render_sample again) routinely needs 10-20+ tool calls, and
// render_sample itself runs actual VapourSynth renders that take tens of
// seconds to minutes each — so wall-clock time is already the natural brake
// on runaway use; the old cap was cutting off legitimate work mid-task,
// forcing the user to retype "continue" repeatedly to get one task done.
const MAX_TOOL_ITERATIONS = 40;

// claude-opus-5 / claude-sonnet-5 support up to 128,000 max_tokens (streaming
// required at that size to avoid HTTP timeouts — this file already streams).
// Adaptive thinking is on by default for both and shares this same budget
// (see the file header), so it needs real headroom: the previous flat 16000
// was tight enough that an ordinarily detailed Archivist reply — the kind
// this app's own teaching-comment philosophy asks for — could genuinely hit
// stop_reason "max_tokens" and truncate mid-explanation. claude-haiku-4-5
// predates adaptive thinking (nothing eating into this budget from that
// side) and isn't confirmed at the same 128K ceiling, so it keeps a smaller,
// still-improved value rather than inheriting the 5-family number.
const THINKING_MODEL_IDS = new Set(['claude-opus-5', 'claude-sonnet-5']);
function maxTokensFor(modelId) {
  return THINKING_MODEL_IDS.has(modelId) ? 128000 : 64000;
}

async function streamChat({ modelId, messages, system, tools, executeAgentTool, apiKey, callbacks }) {
  if (!apiKey) {
    callbacks.onError('No Anthropic API key. Set one in Settings.');
    return;
  }
  const client = new Anthropic({ apiKey });

  const apiMessages = (messages || [])
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .filter(m => (m.text || '').trim().length > 0)
    .map(m => ({ role: m.role, content: m.text }));

  try {
    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      const stream = client.messages.stream({
        model: modelId,
        // Thinking (on by default for the 5-family) shares this budget with the
        // visible reply — keep generous headroom. Streaming, so no timeout risk.
        max_tokens: maxTokensFor(modelId),
        system,
        tools: tools && tools.length > 0 ? tools : undefined,
        messages: apiMessages,
      });

      stream.on('text', (chunk) => callbacks.onChunk(chunk));

      const finalMessage = await stream.finalMessage();

      // Claude 5 safety classifiers: HTTP 200 + stop_reason "refusal", possibly
      // with empty content. Report as a normal (non-crash) chat outcome.
      if (finalMessage.stop_reason === 'refusal') {
        const why = finalMessage.stop_details?.explanation || 'request declined by safety classifiers';
        callbacks.onChunk(`\n[The model declined this request: ${why}]`);
        break;
      }
      if (finalMessage.stop_reason === 'max_tokens') {
        callbacks.onChunk('\n[Response hit the output-token ceiling and may be truncated.]');
        break;
      }
      // Server-tool pause (none configured today, but harmless to handle): re-send
      // the assistant turn as-is and let the API resume.
      if (finalMessage.stop_reason === 'pause_turn') {
        apiMessages.push({ role: 'assistant', content: finalMessage.content });
        continue;
      }

      const toolUseBlocks = (finalMessage.content || []).filter(b => b.type === 'tool_use');
      if (toolUseBlocks.length === 0 || typeof executeAgentTool !== 'function') {
        // Back-compat: without an executor, surface tool calls to the renderer
        // the old one-shot way and end the turn.
        for (const block of toolUseBlocks) {
          callbacks.onToolUse?.({ toolUseId: block.id, name: block.name, input: block.input });
        }
        break;
      }

      // Agentic path: run every requested tool, then hand all results back in
      // ONE user message (parallel-call contract) and loop for the next turn.
      apiMessages.push({ role: 'assistant', content: finalMessage.content });
      const toolResults = [];
      for (const block of toolUseBlocks) {
        callbacks.onToolActivity?.({ phase: 'start', name: block.name, toolUseId: block.id });
        let resultText;
        let isError = false;
        try {
          resultText = await executeAgentTool(block.name, block.input, { toolUseId: block.id });
        } catch (e) {
          resultText = `Tool failed: ${e?.message || String(e)}`;
          isError = true;
        }
        callbacks.onToolActivity?.({ phase: 'end', name: block.name, toolUseId: block.id, isError });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: typeof resultText === 'string' ? resultText : JSON.stringify(resultText),
          ...(isError ? { is_error: true } : {}),
        });
      }
      apiMessages.push({ role: 'user', content: toolResults });

      if (iteration === MAX_TOOL_ITERATIONS - 1) {
        callbacks.onChunk('\n[Stopped after the maximum number of tool steps for one turn.]');
      }
    }

    callbacks.onComplete();
  } catch (err) {
    // Typed SDK errors → friendlier messages than raw stack strings.
    if (err instanceof Anthropic.AuthenticationError) {
      callbacks.onError('Anthropic rejected the API key. Re-enter it in Settings (gear icon).');
    } else if (err instanceof Anthropic.NotFoundError) {
      callbacks.onError(`Model "${modelId}" not found — it may be retired. Pick another model.`);
    } else if (err instanceof Anthropic.RateLimitError) {
      callbacks.onError('Anthropic rate limit hit. Wait a moment and try again.');
    } else if (err instanceof Anthropic.APIConnectionError) {
      callbacks.onError('Could not reach the Anthropic API. Check your connection.');
    } else {
      callbacks.onError(err?.message || String(err));
    }
  }
}

module.exports = { streamChat };
