// Multi-vendor LLM dispatcher.
//
// Model IDs are namespaced as `<providerId>/<actualModelId>`:
//   anthropic/claude-sonnet-5
//   openai/gpt-5.2
//   google/gemini-2.5-pro
//   openrouter/anthropic/claude-sonnet-5   (3-segment — provider/route)
//   xai/grok-4
//   lmstudio/local-model
//   ollama/llama3.2
//
// Back-compat: a bare id with no slash (e.g. `claude-sonnet-5`) is treated as
// Anthropic. The pre-multi-vendor renderer ships these.

const providers = require('./providers');
const anthropic = require('./anthropic');
const openai = require('./openai');
const google = require('./google');
const ollama = require('./ollama');

function parseModelId(id) {
  if (!id || typeof id !== 'string') return null;
  const i = id.indexOf('/');
  if (i < 0) return { providerId: 'anthropic', apiModelId: id };
  return { providerId: id.slice(0, i), apiModelId: id.slice(i + 1) };
}

async function streamChat({ modelId, messages, system, tools, executeAgentTool, getApiKey, getEndpoint, callbacks }) {
  const parsed = parseModelId(modelId);
  if (!parsed) {
    callbacks.onError('Empty model id');
    return;
  }
  const cfg = providers[parsed.providerId];
  if (!cfg) {
    callbacks.onError(`Unknown provider "${parsed.providerId}"`);
    return;
  }

  const apiKey = cfg.needsApiKey ? await getApiKey(parsed.providerId) : null;
  if (cfg.needsApiKey && !apiKey) {
    callbacks.onError(
      `No API key for ${cfg.label}. Click the gear icon in the chat header and add one.`
    );
    return;
  }
  const endpoint = (await getEndpoint(parsed.providerId)) || cfg.defaultEndpoint;
  // SECURITY (2026-11-05, security review #6): the SET-side validator only
  // guards new writes; refuse at DISPATCH too in case an http: remote
  // endpoint was stored by an older build (the key + prompts would cross
  // the network in plaintext).
  if (endpoint && /^http:\/\//i.test(endpoint.trim())) {
    let host = '';
    try { host = new URL(endpoint).hostname.toLowerCase(); } catch { /* handled below */ }
    const isLoopback = host === 'localhost' || host === '::1' || /^127\./.test(host);
    const isLocal = isLoopback || host.endsWith('.local')
      || /^10\./.test(host) || /^192\.168\./.test(host)
      || /^172\.(1[6-9]|2[0-9]|3[01])\./.test(host);
    if (!isLocal) {
      callbacks.onError('Refusing to send the API key over plaintext http: to a remote host. Change the endpoint to https: (or use a localhost/LAN address).');
      return;
    }
    // POSTURE (security review #5/#6 decision, 2026-11-11): a KEYLESS LAN endpoint
    // (Ollama/LM Studio boxes) may run plaintext http:, but a configured API
    // key over any non-loopback http: would cross the network unencrypted —
    // refused unless the operator explicitly accepts the risk. Loopback
    // traffic never leaves the machine and stays allowed.
    if (!isLoopback && apiKey && process.env.VSRES_ALLOW_INSECURE_LAN_KEY !== '1') {
      callbacks.onError(`Refusing to send the API key over plaintext http: to LAN host ${host}. Use https:, a loopback address, or set VSRES_ALLOW_INSECURE_LAN_KEY=1 to accept that the key crosses your network unencrypted.`);
      return;
    }
  }
  const effectiveTools = cfg.supportsTools ? tools : undefined;

  const fwd = {
    onChunk:        (t) => callbacks.onChunk(t),
    onToolUse:      cfg.supportsTools ? (p) => callbacks.onToolUse?.(p) : undefined,
    onToolActivity: (p) => callbacks.onToolActivity?.(p),
    onComplete: () => callbacks.onComplete(),
    onError:    (e) => callbacks.onError(e),
  };

  switch (cfg.type) {
    case 'anthropic':
      // Anthropic is the agentic provider: tools execute mid-turn via
      // executeAgentTool and results feed back into the model (multi-step
      // probe → propose → verify in a single user turn).
      return anthropic.streamChat({
        modelId: parsed.apiModelId,
        messages, system, tools: effectiveTools, executeAgentTool, apiKey, callbacks: fwd,
      });
    case 'openai':
      // Tool parity (beta-provider): OpenAI-compatible backends run the same
      // agentic loop as Anthropic — tools + executor are forwarded.
      return openai.streamChat({
        modelId: parsed.apiModelId,
        messages, system, tools: effectiveTools, executeAgentTool,
        apiKey, baseURL: endpoint, callbacks: fwd,
      });
    case 'google':
      // Tool parity (beta-provider): Gemini runs the same agentic loop —
      // tools translated to functionDeclarations, functionResponse feedback.
      return google.streamChat({
        modelId: parsed.apiModelId,
        messages, system, tools: effectiveTools, executeAgentTool,
        apiKey, callbacks: fwd,
      });
    case 'ollama':
      return ollama.streamChat({
        modelId: parsed.apiModelId,
        messages, system, tools: effectiveTools, executeAgentTool,
        baseURL: endpoint, callbacks: fwd,
      });
    default:
      callbacks.onError(`Provider type "${cfg.type}" not implemented yet`);
  }
}

module.exports = { streamChat, providers, parseModelId };
