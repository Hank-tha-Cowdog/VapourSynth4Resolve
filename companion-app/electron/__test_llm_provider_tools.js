// Provider tool-loop parity (beta-provider): the OpenAI-compatible and
// Ollama loops turn streams, tool-call accumulation, executor wiring and the
// message history they build. Everything is faked — no network, no SDK calls.
const test = require('node:test');
const assert = require('node:assert/strict');

const openai = require('./llm/openai.js');
const ollama = require('./llm/ollama.js');
const google = require('./llm/google.js');

const TOOLS = [{
  name: 'probe_source',
  description: 'Probe a media file',
  input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
}];

function collect() {
  const events = { chunks: [], toolUse: [], activity: [], complete: 0, errors: [] };
  return {
    events,
    callbacks: {
      onChunk: (t) => events.chunks.push(t),
      onToolUse: (p) => events.toolUse.push(p),
      onToolActivity: (p) => events.activity.push(p),
      onComplete: () => events.complete++,
      onError: (e) => events.errors.push(String(e)),
    },
  };
}

// ---- OpenAI-compatible loop ------------------------------------------------

function fakeOpenAIClient(turns) {
  const calls = [];
  return {
    calls,
    client: {
      chat: {
        completions: {
          create: async (params) => {
            calls.push(params);
            const turn = turns.shift();
            if (!turn) throw new Error('fake client: no scripted turn left');
            return (async function* () { for (const chunk of turn) yield chunk; })();
          },
        },
      },
    },
  };
}

const frag = (parts) => ({ choices: [{ delta: parts }] });

test('openai loop: translates tools, accumulates fragments, executes, feeds back, completes', async () => {
  const fake = fakeOpenAIClient([
    [ frag({ content: 'Checking…' }),
      frag({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'probe_', arguments: '{"pa' } }] }),
      frag({ tool_calls: [{ index: 0, function: { name: 'source', arguments: 'th":"/x.mov"}' } }] }) ],
    [ frag({ content: 'All done.' }) ],
  ]);
  const { events, callbacks } = collect();
  let executed = null;
  await openai.streamChat({
    modelId: 'gpt-x', messages: [{ role: 'user', text: 'hello' }], system: 'sys',
    tools: TOOLS,
    executeAgentTool: async (name, input, meta) => { executed = { name, input, meta }; return JSON.stringify({ ok: true }); },
    apiKey: 'k', baseURL: 'http://fake', callbacks,
    clientFactory: () => fake.client,
  });

  // Tool translation on the request
  assert.deepEqual(fake.calls[0].tools, [{
    type: 'function',
    function: { name: 'probe_source', description: 'Probe a media file', parameters: TOOLS[0].input_schema },
  }]);
  assert.equal(fake.calls[0].tool_choice, 'auto');
  // Fragment accumulation → one call with the full name/args
  assert.deepEqual(executed, { name: 'probe_source', input: { path: '/x.mov' }, meta: { toolUseId: 'call_1' } });
  // History the loop built: assistant tool_calls + tool result
  const secondMessages = fake.calls[1].messages;
  const assistantTurn = secondMessages.find(m => m.role === 'assistant' && m.tool_calls);
  assert.ok(assistantTurn, 'assistant tool_calls turn recorded');
  assert.equal(assistantTurn.tool_calls[0].function.name, 'probe_source');
  const toolTurn = secondMessages.find(m => m.role === 'tool');
  assert.ok(toolTurn, 'tool result message recorded');
  assert.equal(toolTurn.tool_call_id, 'call_1');
  assert.ok(toolTurn.content.includes('ok'));
  // Callbacks
  assert.deepEqual(events.chunks, ['Checking…', 'All done.']);
  assert.equal(events.complete, 1);
  assert.deepEqual(events.errors, []);
  assert.deepEqual(events.activity.map(a => a.phase), ['start', 'end']);
});

test('openai loop: executor failure becomes an is_error tool message and the loop continues', async () => {
  const fake = fakeOpenAIClient([
    [ frag({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'probe_source', arguments: '{}' } }] }) ],
    [ frag({ content: 'recovered' }) ],
  ]);
  const { events, callbacks } = collect();
  await openai.streamChat({
    modelId: 'gpt-x', messages: [], tools: TOOLS,
    executeAgentTool: async () => { throw new Error('boom'); },
    callbacks, clientFactory: () => fake.client,
  });
  const toolTurn = fake.calls[1].messages.find(m => m.role === 'tool');
  assert.ok(toolTurn.content.includes('Tool failed: boom'));
  assert.equal(events.activity.find(a => a.phase === 'end').isError, true);
  assert.deepEqual(events.chunks, ['recovered']);
  assert.equal(events.complete, 1);
});

test('openai loop: without an executor, tool calls surface one-shot and the turn ends', async () => {
  const fake = fakeOpenAIClient([
    [ frag({ tool_calls: [{ index: 0, id: 'c9', function: { name: 'probe_source', arguments: '{"path":"/y"}' } }] }) ],
  ]);
  const { events, callbacks } = collect();
  await openai.streamChat({
    modelId: 'gpt-x', messages: [], tools: TOOLS, callbacks,
    clientFactory: () => fake.client,
  });
  assert.equal(events.toolUse.length, 1);
  assert.deepEqual(events.toolUse[0], { toolUseId: 'c9', name: 'probe_source', input: { path: '/y' } });
  assert.equal(events.complete, 1);
  assert.equal(fake.calls.length, 1);
});

test('openai loop: the iteration cap stops runaway tool loops with a notice', async () => {
  const turn = () => [ frag({ tool_calls: [{ index: 0, id: 'c', function: { name: 'probe_source', arguments: '{}' } }] }) ];
  const turns = Array.from({ length: 60 }, turn);
  const fake = fakeOpenAIClient(turns);
  const { events, callbacks } = collect();
  await openai.streamChat({
    modelId: 'gpt-x', messages: [], tools: TOOLS,
    executeAgentTool: async () => 'ok', callbacks, clientFactory: () => fake.client,
  });
  assert.equal(fake.calls.length, 40);
  assert.ok(events.chunks.some(t => t.includes('maximum number of tool steps')));
  assert.equal(events.complete, 1);
});

test('openai: no tools configured → plain streaming, no tools field', async () => {
  const fake = fakeOpenAIClient([[ frag({ content: 'hi' }) ]]);
  const { events, callbacks } = collect();
  await openai.streamChat({ modelId: 'm', messages: [], callbacks, clientFactory: () => fake.client });
  assert.equal('tools' in fake.calls[0], false);
  assert.deepEqual(events.chunks, ['hi']);
  assert.equal(events.complete, 1);
});

// ---- Ollama loop -----------------------------------------------------------

function ollamaStream(lines) {
  const encoded = lines.map(l => new TextEncoder().encode(l + '\n'));
  let i = 0;
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => '',
    body: {
      getReader: () => ({
        read: async () => (i < encoded.length ? { done: false, value: encoded[i++] } : { done: true, value: undefined }),
        cancel: async () => {},
        releaseLock: () => {},
      }),
    },
  };
}

test('ollama loop: executes tool calls, sends tool messages back, completes', async () => {
  const originalFetch = global.fetch;
  const seen = [];
  const responses = [
    ollamaStream([
      JSON.stringify({ message: { role: 'assistant', content: 'Looking…' }, done: false }),
      JSON.stringify({ message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'probe_source', arguments: { path: '/z.mov' } } }] }, done: false }),
      JSON.stringify({ done: true }),
    ]),
    ollamaStream([
      JSON.stringify({ message: { role: 'assistant', content: 'Finished.' }, done: false }),
      JSON.stringify({ done: true }),
    ]),
  ];
  global.fetch = async (url, opts) => { seen.push({ url, body: JSON.parse(opts.body) }); return responses.shift(); };
  try {
    const { events, callbacks } = collect();
    let executed = null;
    await ollama.streamChat({
      modelId: 'qwen3', messages: [{ role: 'user', text: 'go' }], tools: TOOLS,
      executeAgentTool: async (name, input) => { executed = { name, input }; return 'probe ok'; },
      baseURL: 'http://localhost:11434', callbacks,
    });
    assert.deepEqual(executed, { name: 'probe_source', input: { path: '/z.mov' } });
    assert.deepEqual(events.chunks, ['Looking…', 'Finished.']);
    assert.equal(seen.length, 2);
    assert.deepEqual(seen[0].body.tools, [{
      type: 'function',
      function: { name: 'probe_source', description: 'Probe a media file', parameters: TOOLS[0].input_schema },
    }]);
    const second = seen[1].body.messages;
    assert.ok(second.some(m => m.role === 'assistant' && Array.isArray(m.tool_calls)));
    const toolMsg = second.find(m => m.role === 'tool');
    assert.equal(toolMsg.tool_name, 'probe_source');
    assert.equal(toolMsg.content, 'probe ok');
    assert.equal(events.complete, 1);
    assert.deepEqual(events.errors, []);
  } finally {
    global.fetch = originalFetch;
  }
});

test('ollama: streamed error line reports once and stops', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ollamaStream([
    JSON.stringify({ message: { role: 'assistant', content: 'partial' }, done: false }),
    JSON.stringify({ error: 'model crashed' }),
  ]);
  try {
    const { events, callbacks } = collect();
    await ollama.streamChat({ modelId: 'm', messages: [], callbacks });
    assert.equal(events.errors.length, 1);
    assert.ok(events.errors[0].includes('model crashed'));
    assert.equal(events.complete, 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test('ollama: no tools → unchanged single-turn streaming', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ollamaStream([
    JSON.stringify({ message: { role: 'assistant', content: 'Hello' }, done: false }),
    JSON.stringify({ done: true }),
  ]);
  try {
    const { events, callbacks } = collect();
    await ollama.streamChat({ modelId: 'm', messages: [], callbacks });
    assert.deepEqual(events.chunks, ['Hello']);
    assert.equal(events.complete, 1);
  } finally {
    global.fetch = originalFetch;
  }
});


// ---- Google Gemini loop ----------------------------------------------------

function fakeGoogleClient(turns) {
  const calls = [];
  return {
    calls,
    client: {
      models: {
        generateContentStream: async (params) => {
          calls.push(params);
          const turn = turns.shift();
          if (!turn) throw new Error('fake genai: no scripted turn left');
          return (async function* () { for (const chunk of turn) yield chunk; })();
        },
      },
    },
  };
}

test('google loop: translates tools to functionDeclarations, executes calls, feeds functionResponse back, completes', async () => {
  const fake = fakeGoogleClient([
    [ { text: 'Checking the source…' },
      { functionCalls: [{ name: 'probe_source', args: { path: '/g.mov' } }] } ],
    [ { text: 'Done.' } ],
  ]);
  const { events, callbacks } = collect();
  let executed = null;
  await google.streamChat({
    modelId: 'gemini-x', messages: [{ role: 'user', text: 'go' }], system: 'sys',
    tools: TOOLS,
    executeAgentTool: async (name, input, meta) => { executed = { name, input, meta }; return 'probe says ok'; },
    apiKey: 'k', callbacks, clientFactory: () => fake.client,
  });
  // Tool translation
  assert.deepEqual(fake.calls[0].config.tools, [{
    functionDeclarations: [{ name: 'probe_source', description: 'Probe a media file', parameters: TOOLS[0].input_schema }],
  }]);
  assert.equal(fake.calls[0].config.systemInstruction, 'sys');
  // Execution
  assert.deepEqual(executed, { name: 'probe_source', input: { path: '/g.mov' }, meta: { toolUseId: null } });
  // Contents the loop built for turn 2: model turn + functionResponse (role user)
  const c2 = fake.calls[1].contents;
  const modelTurn = c2.find(m => m.role === 'model' && m.parts.some(p => p.functionCall));
  assert.ok(modelTurn, 'model functionCall turn recorded');
  assert.equal(modelTurn.parts.find(p => p.text).text, 'Checking the source…');
  const respTurn = c2.find(m => m.role === 'user' && m.parts.some(p => p.functionResponse));
  assert.ok(respTurn, 'functionResponse turn recorded');
  const fr = respTurn.parts[0].functionResponse;
  assert.equal(fr.name, 'probe_source');
  assert.deepEqual(fr.response, { result: 'probe says ok' });
  // Callbacks
  assert.deepEqual(events.chunks, ['Checking the source…', 'Done.']);
  assert.equal(events.complete, 1);
  assert.deepEqual(events.errors, []);
  assert.deepEqual(events.activity.map(a => a.phase), ['start', 'end']);
});

test('google loop: executor failure feeds {error} and the loop continues', async () => {
  const fake = fakeGoogleClient([
    [ { functionCalls: [{ name: 'probe_source', args: {} }] } ],
    [ { text: 'recovered' } ],
  ]);
  const { events, callbacks } = collect();
  await google.streamChat({
    modelId: 'gemini-x', messages: [], tools: TOOLS,
    executeAgentTool: async () => { throw new Error('boom'); },
    apiKey: 'k', callbacks, clientFactory: () => fake.client,
  });
  const respTurn = fake.calls[1].contents.find(m => m.parts.some(p => p.functionResponse));
  assert.deepEqual(respTurn.parts[0].functionResponse.response, { error: 'Tool failed: boom' });
  assert.equal(events.activity.find(a => a.phase === 'end').isError, true);
  assert.deepEqual(events.chunks, ['recovered']);
  assert.equal(events.complete, 1);
});

test('google: no tools → no tools config, plain streaming, one complete', async () => {
  const fake = fakeGoogleClient([[ { text: 'hi' } ]]);
  const { events, callbacks } = collect();
  await google.streamChat({ modelId: 'm', messages: [], apiKey: 'k', callbacks, clientFactory: () => fake.client });
  assert.equal('tools' in fake.calls[0].config, false);
  assert.deepEqual(events.chunks, ['hi']);
  assert.equal(events.complete, 1);
});
