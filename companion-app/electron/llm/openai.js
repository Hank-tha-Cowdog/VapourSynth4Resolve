// OpenAI-compatible Chat Completions streaming WITH tool parity.
// Used by OpenAI, OpenRouter, xAI Grok, and LM Studio — all expose the same
// /v1/chat/completions surface and the openai SDK lets us point at any of them
// via the `baseURL` constructor option.
//
// Tool parity (beta-provider, 2026-11-12): this provider now runs the SAME
// agentic loop as anthropic.js — stream a turn; when the model requests
// tools, execute each via executeAgentTool, append the assistant tool_calls
// turn plus one `tool` message per call, and continue until the model stops
// calling tools. Tools arrive in the Anthropic shape ({name, description,
// input_schema}) and are translated here. One user turn can therefore do
// probe → propose → render-sample → refine on every OpenAI-compatible
// backend, not just Claude.
//
// Streaming tool calls arrive as FRAGMENTS across chunks (id once, name in
// the first fragment, arguments token-by-token) — accumulate by delta index
// exactly like the OpenAI reference clients do.

const OpenAI = require('openai').default;

// Mirrors anthropic.js: an app-level pacing bound for one user turn's
// probe → edit → verify loop, not a safety limit (render_sample itself is the
// natural wall-clock brake).
const MAX_TOOL_ITERATIONS = 40;

// Anthropic tool shape → OpenAI function-tool shape.
function toOpenAITools(tools) {
  return (tools || []).filter(t => t && typeof t.name === 'string' && t.name).map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: typeof t.description === 'string' ? t.description : '',
      parameters: t.input_schema && typeof t.input_schema === 'object'
        ? t.input_schema : { type: 'object', properties: {} },
    },
  }));
}

// Accumulate streamed tool-call fragments ({index, id?, function?.name?, function?.arguments?}).
function accumulateToolCalls(acc, deltas) {
  for (const d of deltas) {
    if (!d || typeof d.index !== 'number') continue;
    let entry = acc.get(d.index);
    if (!entry) {
      entry = { id: '', type: 'function', function: { name: '', arguments: '' } };
      acc.set(d.index, entry);
    }
    if (typeof d.id === 'string' && d.id) entry.id = d.id;
    if (typeof d.function?.name === 'string' && d.function.name) entry.function.name += d.function.name;
    if (typeof d.function?.arguments === 'string') entry.function.arguments += d.function.arguments;
  }
  return acc;
}

function safeParseArguments(text) {
  try { return JSON.parse(text && text.trim() ? text : '{}'); } catch { return {}; }
}

async function streamChat({ modelId, messages, system, tools, executeAgentTool, apiKey, baseURL, callbacks, clientFactory }) {
  // LM Studio / local backends often accept an empty key; OpenAI/OpenRouter/Grok
  // require one. Always pass *some* string so the SDK doesn't error on construction.
  const makeClient = typeof clientFactory === 'function'
    ? clientFactory
    : (opts) => new OpenAI(opts);
  const client = makeClient({
    apiKey: apiKey || 'sk-local',
    baseURL: baseURL || undefined,
    dangerouslyAllowBrowser: false,
  });

  const apiMessages = [];
  if (system) apiMessages.push({ role: 'system', content: system });
  for (const m of (messages || [])) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    if (!(m.text || '').trim()) continue;
    apiMessages.push({ role: m.role, content: m.text });
  }

  const wantsTools = Array.isArray(tools) && tools.length > 0;
  try {
    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      const stream = await client.chat.completions.create({
        model: modelId,
        messages: apiMessages,
        stream: true,
        ...(wantsTools ? { tools: toOpenAITools(tools), tool_choice: 'auto' } : {}),
      });

      let content = '';
      const toolAcc = new Map();
      for await (const chunk of stream) {
        const delta = chunk?.choices?.[0]?.delta;
        if (delta?.content) {
          content += delta.content;
          callbacks.onChunk(delta.content);
        }
        if (Array.isArray(delta?.tool_calls)) accumulateToolCalls(toolAcc, delta.tool_calls);
      }

      const calls = [...toolAcc.values()].filter(c => c.function.name);

      if (calls.length === 0 || typeof executeAgentTool !== 'function') {
        // Back-compat: without an executor, surface tool calls to the renderer
        // the old one-shot way and end the turn.
        for (const c of calls) {
          callbacks.onToolUse?.({ toolUseId: c.id, name: c.function.name, input: safeParseArguments(c.function.arguments) });
        }
        break;
      }

      // Agentic path: record the assistant tool_calls turn, run every call,
      // and hand results back as `tool` messages (OpenAI's shape for the
      // parallel-call contract) before looping for the next model turn.
      apiMessages.push({
        role: 'assistant',
        content: content || null,
        tool_calls: calls.map(c => ({
          id: c.id || `call_${iteration}_${c.function.name}`,
          type: 'function',
          function: { name: c.function.name, arguments: c.function.arguments || '{}' },
        })),
      });
      for (const c of calls) {
        const input = safeParseArguments(c.function.arguments);
        callbacks.onToolActivity?.({ phase: 'start', name: c.function.name, toolUseId: c.id });
        let resultText;
        let isError = false;
        try {
          resultText = await executeAgentTool(c.function.name, input, { toolUseId: c.id });
        } catch (e) {
          resultText = `Tool failed: ${e?.message || String(e)}`;
          isError = true;
        }
        callbacks.onToolActivity?.({ phase: 'end', name: c.function.name, toolUseId: c.id, isError });
        apiMessages.push({
          role: 'tool',
          tool_call_id: c.id || `call_${iteration}_${c.function.name}`,
          content: typeof resultText === 'string' ? resultText : JSON.stringify(resultText),
        });
      }

      if (iteration === MAX_TOOL_ITERATIONS - 1) {
        callbacks.onChunk('\n[Stopped after the maximum number of tool steps for one turn.]');
      }
    }
    callbacks.onComplete();
  } catch (err) {
    callbacks.onError(err?.message || String(err));
  }
}

module.exports = { streamChat, toOpenAITools, accumulateToolCalls };
