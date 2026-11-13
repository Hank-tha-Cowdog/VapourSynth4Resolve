// Google Gemini streaming via @google/genai — WITH tool parity (beta-provider).
// Same agentic loop as anthropic/openai/ollama: tools arrive in the Anthropic
// shape ({name, description, input_schema}) and are translated to Gemini
// functionDeclarations; streamed functionCalls accumulate (deduped — the SDK
// may repeat a call across chunks); each executes via executeAgentTool and
// feeds back as a functionResponse part before the loop continues. Models or
// keys without function-calling simply never emit functionCalls and behave
// exactly as before.

// Mirrors the other providers: a pacing bound for one user turn.
const MAX_TOOL_ITERATIONS = 40;

// Anthropic tool shape → Gemini functionDeclaration (the SDK takes the
// OpenAPI-subset schema we already carry as input_schema).
function toGeminiDeclarations(tools) {
  return (tools || [])
    .filter(t => t && typeof t.name === 'string' && t.name)
    .map(t => ({
      name: t.name,
      description: typeof t.description === 'string' ? t.description : '',
      parameters: t.input_schema && typeof t.input_schema === 'object'
        ? t.input_schema : { type: 'object', properties: {} },
    }));
}

// Lazy SDK require: the module stays loadable (and testable with an injected
// clientFactory) even when @google/genai is absent from the tree.
function defaultClientFactory({ apiKey }) {
  const { GoogleGenAI } = require('@google/genai');
  return new GoogleGenAI({ apiKey });
}

function extractText(chunk) {
  try {
    const t = typeof chunk?.text === 'function' ? chunk.text() : chunk?.text;
    return typeof t === 'string' ? t : '';
  } catch { return ''; }
}

function extractFunctionCalls(chunk) {
  try {
    if (Array.isArray(chunk?.functionCalls)) return chunk.functionCalls;
    const parts = chunk?.candidates?.[0]?.content?.parts;
    if (Array.isArray(parts)) return parts.map(p => p?.functionCall).filter(Boolean);
  } catch { /* getter may throw on partial chunks */ }
  return [];
}

async function streamChat({ modelId, messages, system, tools, executeAgentTool, apiKey, callbacks, clientFactory }) {
  if (!apiKey) {
    callbacks.onError('No Gemini API key. Set one in Settings.');
    return;
  }
  const makeClient = typeof clientFactory === 'function' ? clientFactory : defaultClientFactory;
  const ai = makeClient({ apiKey });

  // Gemini's contents shape: array of { role: 'user' | 'model', parts: [...] }
  const contents = [];
  for (const m of (messages || [])) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    if (!(m.text || '').trim()) continue;
    contents.push({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.text }],
    });
  }

  const wantsTools = Array.isArray(tools) && tools.length > 0;
  try {
    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      const config = {};
      if (system) config.systemInstruction = system;
      if (wantsTools) config.tools = [{ functionDeclarations: toGeminiDeclarations(tools) }];

      const response = await ai.models.generateContentStream({
        model: modelId,
        contents,
        config,
      });

      let text = '';
      const calls = [];
      const seen = new Set();
      for await (const chunk of response) {
        const t = extractText(chunk);
        if (t) { text += t; callbacks.onChunk(t); }
        for (const fc of extractFunctionCalls(chunk)) {
          const key = JSON.stringify(fc);
          if (!seen.has(key)) { seen.add(key); calls.push(fc); }
        }
      }

      const usable = calls.filter(c => c && typeof c.name === 'string' && c.name);
      if (usable.length === 0 || typeof executeAgentTool !== 'function') {
        // Back-compat: without an executor, surface tool calls one-shot and end.
        for (const c of usable) {
          callbacks.onToolUse?.({ toolUseId: null, name: c.name, input: c.args || {} });
        }
        break;
      }

      // Record the model turn (text + the calls), run each call, feed results
      // back as functionResponse parts, and continue for the next model turn.
      contents.push({
        role: 'model',
        parts: [
          ...(text ? [{ text }] : []),
          ...usable.map(c => ({ functionCall: { name: c.name, args: c.args || {} } })),
        ],
      });
      for (const c of usable) {
        callbacks.onToolActivity?.({ phase: 'start', name: c.name, toolUseId: null });
        let resultText;
        let isError = false;
        try {
          resultText = await executeAgentTool(c.name, c.args || {}, { toolUseId: null });
        } catch (e) {
          resultText = `Tool failed: ${e?.message || String(e)}`;
          isError = true;
        }
        callbacks.onToolActivity?.({ phase: 'end', name: c.name, toolUseId: null, isError });
        contents.push({
          role: 'user',
          parts: [{
            functionResponse: {
              name: c.name,
              response: isError
                ? { error: resultText }
                : { result: typeof resultText === 'string' ? resultText : JSON.stringify(resultText) },
            },
          }],
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

module.exports = { streamChat, toGeminiDeclarations };
