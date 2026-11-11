// Google Gemini streaming via @google/genai.
// Tool calling exists in Gemini but uses yet another schema; deferred to TKT-A4 follow-up.

const { GoogleGenAI } = require('@google/genai');

async function streamChat({ modelId, messages, system, apiKey, callbacks }) {
  if (!apiKey) {
    callbacks.onError('No Gemini API key. Set one in Settings.');
    return;
  }
  const ai = new GoogleGenAI({ apiKey });

  // Gemini's contents shape: array of { role: 'user' | 'model', parts: [{ text }] }
  const contents = [];
  for (const m of (messages || [])) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    if (!(m.text || '').trim()) continue;
    contents.push({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.text }],
    });
  }

  const config = {};
  if (system) config.systemInstruction = system;

  try {
    const response = await ai.models.generateContentStream({
      model: modelId,
      contents,
      config,
    });
    for await (const chunk of response) {
      // The v2 SDK exposes `text` as a getter on the chunk.
      const text = typeof chunk?.text === 'function' ? chunk.text() : chunk?.text;
      if (text) callbacks.onChunk(text);
    }
    callbacks.onComplete();
  } catch (err) {
    callbacks.onError(err?.message || String(err));
  }
}

module.exports = { streamChat };
