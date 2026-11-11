// Ollama local LLM streaming via REST.
// No SDK — Ollama's API is simple JSON-lines, easier to do with native fetch.
// Default endpoint http://localhost:11434/api/chat — users running `ollama serve`
// locally get this out of the box.

async function streamChat({ modelId, messages, system, baseURL, callbacks }) {
  const apiMessages = [];
  if (system) apiMessages.push({ role: 'system', content: system });
  for (const m of (messages || [])) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    if (!(m.text || '').trim()) continue;
    apiMessages.push({ role: m.role, content: m.text });
  }

  const url = (baseURL || 'http://localhost:11434').replace(/\/+$/, '') + '/api/chat';

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
  let reader;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: modelId,
        messages: apiMessages,
        stream: true,
      }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      reportTerminal('error', `Ollama ${response.status}: ${body || response.statusText}`);
      return;
    }

    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    // A streamed error is a terminal response, even when HTTP status was 200.
    // Malformed lines keep the existing skip policy; callbacks stay outside
    // the parse catch so a provider error cannot be swallowed as bad JSON.
    const consumeLine = (line) => {
      if (!line.trim()) return false;
      let j;
      try { j = JSON.parse(line); } catch (_) { return false; }
      if (typeof j?.error === 'string' && j.error) {
        reportTerminal('error', `Ollama: ${j.error}`);
        return true;
      }
      const text = j?.message?.content;
      if (text) callbacks.onChunk(text);
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
          // Stop consuming this response. Cancellation is best effort, not
          // proof of server termination, and must not delay the error report.
          try { Promise.resolve(reader.cancel()).catch(() => {}); } catch (_) {}
          return;
        }
      }
    }
    // Defensive EOF handling: retain a valid final record without a newline.
    // This does not assert that a particular Ollama build omits its delimiter.
    buffer += decoder.decode();
    if (consumeLine(buffer)) return;
    reportTerminal('complete');
  } catch (err) {
    reportTerminal('error', err?.message || String(err));
  } finally {
    try { reader?.releaseLock(); } catch (_) {}
  }
}

module.exports = { streamChat };
