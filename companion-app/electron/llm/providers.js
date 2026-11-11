// Provider catalog — the source of truth for what backends the Archivist can talk to.
// Each entry declares the provider type (which streaming impl to use), whether it
// requires an API key, the default endpoint for OpenAI-compatible providers, and the
// curated model list. Local providers (LM Studio / Ollama) ship with static
// examples; this app does not discover loaded models or verify server readiness.

module.exports = {
  anthropic: {
    label: 'Anthropic Claude',
    type: 'anthropic',
    needsApiKey: true,
    keychainAccount: 'anthropic',
    defaultEndpoint: null,
    supportsTools: true,
    models: [
      { id: 'claude-sonnet-5',  name: 'Claude Sonnet 5' },
      { id: 'claude-opus-5',    name: 'Claude Opus 5' },
      { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5 (fast)' },
    ],
  },
  openai: {
    label: 'OpenAI',
    type: 'openai',
    needsApiKey: true,
    keychainAccount: 'openai',
    defaultEndpoint: 'https://api.openai.com/v1',
    supportsTools: false,  // tool-calling exists but uses a different schema — TKT-A4 follow-up
    models: [
      { id: 'gpt-5.6-sol',   name: 'GPT-5.6 Sol (flagship)' },
      { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra (balanced)' },
      { id: 'gpt-5.6-luna',  name: 'GPT-5.6 Luna (fast)' },
    ],
  },
  google: {
    label: 'Google Gemini',
    type: 'google',
    needsApiKey: true,
    keychainAccount: 'google',
    defaultEndpoint: null,
    supportsTools: false,
    models: [
      { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro (preview)' },
      { id: 'gemini-3.6-flash',       name: 'Gemini 3.6 Flash' },
    ],
  },
  openrouter: {
    label: 'OpenRouter',
    type: 'openai',  // OpenAI-compatible API at a different base URL
    needsApiKey: true,
    keychainAccount: 'openrouter',
    defaultEndpoint: 'https://openrouter.ai/api/v1',
    supportsTools: false,
    models: [
      { id: 'openai/gpt-5.6-sol',                name: 'OpenRouter · GPT-5.6 Sol' },
      { id: 'anthropic/claude-sonnet-5',         name: 'OpenRouter · Claude Sonnet 5' },
      { id: 'google/gemini-3.6-flash',           name: 'OpenRouter · Gemini 3.6 Flash' },
      { id: 'meta-llama/llama-3.3-70b-instruct', name: 'OpenRouter · Llama 3.3 70B' },
    ],
  },
  xai: {
    label: 'xAI Grok',
    type: 'openai',
    needsApiKey: true,
    keychainAccount: 'xai',
    defaultEndpoint: 'https://api.x.ai/v1',
    supportsTools: false,
    models: [
      { id: 'grok-4.5', name: 'Grok 4.5' },
      { id: 'grok-4.3', name: 'Grok 4.3 (1M context)' },
    ],
  },
  lmstudio: {
    label: 'LM Studio (local)',
    type: 'openai',
    needsApiKey: false,
    keychainAccount: null,
    defaultEndpoint: 'http://localhost:1234/v1',
    supportsTools: false,
    models: [
      { id: 'local-model', name: 'LM Studio · local-model (example)' },
    ],
  },
  ollama: {
    label: 'Ollama (local)',
    type: 'ollama',
    needsApiKey: false,
    keychainAccount: null,
    defaultEndpoint: 'http://localhost:11434',
    supportsTools: false,
    models: [
      { id: 'llama3.3', name: 'Ollama · llama3.3 (example)' },
      { id: 'mistral',  name: 'Ollama · mistral (example)' },
      { id: 'qwen3',    name: 'Ollama · qwen3 (example)' },
    ],
  },
};
