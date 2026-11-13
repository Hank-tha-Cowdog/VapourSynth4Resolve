// Ollama local LLM streaming via REST — WITH tool parity (beta-provider).
// No SDK — Ollama's API is simple JSON-lines, easier to do with native fetch.
// Default endpoint http://localhost:11434/api/chat — users running `ollama serve`
// locally get this out of the box.
//
// Tool parity (2026-11-12): models that support tools run the same agentic
// loop as anthropic.js — the model may request tools, each executes via
// executeAgentTool, results come back as `tool` messages, and the turn
// continues. Models without tool support simply never emit tool_calls and
// behave exactly as before.

// Mirrors anthropic.js — a pacing bound for one user turn, not a safety limit.
const MAX_TOOL_ITERATIONS = 40;

// Anthropic tool shape → Ollama function-tool shape (same subset as OpenAI's).
function toOllamaTools(tools) {
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

// One streamed completion turn. Returns { ok, error?, content, toolCalls }.
// onText delivers each content fragment AS IT ARRIVES (the streaming
// contract: partial text must reach the UI before any terminal error, and
// multi-fragment records stay separate chunks); `content` accumulates the
// same text for the assistant turn the tool loop feeds back.
async function oneTurn({ url, modelId, apiMessages, toolDefs, onText }) {
  let reader;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: modelId,
        messages: apiMessages,
        stream: true,
        ...(toolDefs.length > 0 ? { tools: toolDefs } : {}),
      }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return { ok: false, error: `Ollama ${response.status}: ${body || response.statusText}`, content: '', toolCalls: [] };
    }

    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    const toolCalls = [];
    const seen = new Set();
    let streamError = null;

    // A streamed error is terminal for the turn, even when HTTP status was 200.
    // Malformed lines keep the existing skip policy; callbacks stay outside the
    // parse catch so a provider error cannot be swallowed as bad JSON.
    const consumeLine = (line) => {
      if (!line.trim()) return false;
      let j;
      try { j = JSON.parse(line); } catch (_) { return false; }
      if (typeof j?.error === 'string' && j.error) {
        streamError = `Ollama: ${j.error}`;
        return true;
      }
      const msg = j?.message;
      const text = msg?.content;
      if (text) { content += text; if (onText) onText(text); }
      if (Array.isArray(msg?.tool_calls)) {
        for (const call of msg.tool_calls) {
          const key = JSON.stringify(call);
          if (!seen.has(key)) { seen.add(key); toolCalls.push(call); }
        }
      }
      return false;
    };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (consumeLine(line)) {
          try { Promise.resolve(reader.cancel()).catch(() => {}); } catch (_) {}
          return { ok: false, error: streamError, content, toolCalls: [] };
        }
      }
    }
    // Defensive EOF handling: retain a valid final record without a newline.
    buffer += decoder.decode();
    if (consumeLine(buffer)) return { ok: false, error: streamError, content, toolCalls: [] };
    return { ok: true, content, toolCalls };
  } catch (err) {
    return { ok: false, error: err?.message || String(err), content: '', toolCalls: [] };
  } finally {
    try { reader?.releaseLock(); } catch (_) {}
  }
}

async function streamChat({ modelId, messages, system, tools, executeAgentTool, baseURL, callbacks }) {
  const apiMessages = [];
  if (system) apiMessages.push({ role: 'system', content: system });
  for (const m of (messages || [])) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    if (!(m.text || '').trim()) continue;
    apiMessages.push({ role: m.role, content: m.text });
  }

  const url = (baseURL || 'http://localhost:11434').replace(/\/+$/, '') + '/api/chat';
  const toolDefs = Array.isArray(tools) && tools.length > 0 ? toOllamaTools(tools) : [];

  let terminalReported = false;
  const reportTerminal = (kind, error) => {
    if (terminalReported) return;
    terminalReported = true;
    // Renderer teardown may make the main-process observer throw. A terminal
    // report must not be retried or reject this unawaited dispatcher promise.
    try {
      if (kind === 'error') callbacks.onError(error);
      else callbacks.onComplete();
    } catch (_) {}
  };

  try {
    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      const turn = await oneTurn({ url, modelId, apiMessages, toolDefs,
        onText: (t) => callbacks.onChunk(t) });
      if (!turn.ok) {
        // Preceding text already streamed via onText; the streamed error is
        // terminal for the turn and suppresses anything after it.
        reportTerminal('error', turn.error);
        return;
      }

      const calls = turn.toolCalls.filter(c => c && c.function && typeof c.function.name === 'string');
      if (calls.length === 0 || typeof executeAgentTool !== 'function') {
        // Back-compat: without an executor, surface tool calls one-shot and end.
        for (const c of calls) {
          callbacks.onToolUse?.({ toolUseId: null, name: c.function.name, input: c.function.arguments });
        }
        break;
      }

      apiMessages.push({ role: 'assistant', content: turn.content, tool_calls: calls });
      for (const c of calls) {
        callbacks.onToolActivity?.({ phase: 'start', name: c.function.name, toolUseId: null });
        let resultText;
        let isError = false;
        try {
          resultText = await executeAgentTool(c.function.name, c.function.arguments || {}, { toolUseId: null });
        } catch (e) {
          resultText = `Tool failed: ${e?.message || String(e)}`;
          isError = true;
        }
        callbacks.onToolActivity?.({ phase: 'end', name: c.function.name, toolUseId: null, isError });
        apiMessages.push({
          role: 'tool',
          tool_name: c.function.name,
          content: typeof resultText === 'string' ? resultText : JSON.stringify(resultText),
        });
      }

      if (iteration === MAX_TOOL_ITERATIONS - 1) {
        callbacks.onChunk('\n[Stopped after the maximum number of tool steps for one turn.]');
      }
    }
    reportTerminal('complete');
  } catch (err) {
    reportTerminal('error', err?.message || String(err));
  }
}

module.exports = { streamChat, toOllamaTools };
