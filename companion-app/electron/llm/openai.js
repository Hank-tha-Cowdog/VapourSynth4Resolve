// OpenAI-compatible Chat Completions streaming.
// Used by OpenAI, OpenRouter, xAI Grok, and LM Studio — all expose the same
// /v1/chat/completions surface and the openai SDK lets us point at any of them
// via the `baseURL` constructor option.
//
// Tool-calling is intentionally NOT forwarded here. OpenAI's tools schema differs
// from Anthropic's — a clean cross-provider tool adapter is part of TKT-A4 follow-up.

const OpenAI = require('openai').default;

async function streamChat({ modelId, messages, system, apiKey, baseURL, callbacks }) {
  // LM Studio / local backends often accept an empty key; OpenAI/OpenRouter/Grok
  // require one. Always pass *some* string so the SDK doesn't error on construction.
  const client = new OpenAI({
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

  try {
    const stream = await client.chat.completions.create({
      model: modelId,
      messages: apiMessages,
      stream: true,
    });
    for await (const chunk of stream) {
      const delta = chunk?.choices?.[0]?.delta;
      if (delta?.content) callbacks.onChunk(delta.content);
    }
    callbacks.onComplete();
  } catch (err) {
    callbacks.onError(err?.message || String(err));
  }
}

module.exports = { streamChat };
