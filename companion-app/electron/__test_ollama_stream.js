// Pure VM adapter contracts: only this source file is read. fetch/reader are
// inert fakes; no SDK, provider, socket, server, credential or child is used.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { TextDecoder } = require('node:util');

const filename = path.join(__dirname, 'llm/ollama.js');
const source = fs.readFileSync(filename, 'utf8');
function harness(parts, options = {}) {
  const calls = [], events = [];
  let reads = 0, cancels = 0, releases = 0;
  const reader = {
    async read() {
      reads++;
      if (!parts.length) return { done: true };
      const value = parts.shift();
      if (value instanceof Error) throw value;
      return { done: false, value: Buffer.isBuffer(value) ? value : Buffer.from(value) };
    },
    cancel() {
      cancels++;
      if (options.cancel === 'throw') throw new Error('synthetic cancel throw');
      if (options.cancel === 'reject') return Promise.reject(new Error('synthetic cancel rejection'));
      return Promise.resolve();
    },
    releaseLock() { releases++; },
  };
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module, exports: module.exports, TextDecoder,
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (options.fetchError) throw options.fetchError;
      return {
        ok: options.ok !== false, status: options.status ?? 200,
        statusText: options.statusText ?? 'Synthetic status',
        text: async () => options.body ?? '',
        body: { getReader() { assert.notEqual(options.ok, false); return reader; } },
      };
    },
    require(name) { throw new Error(`unadmitted import: ${name}`); },
  }, { filename, timeout: 1000 });
  return {
    async run(args = {}) {
      await module.exports.streamChat({ modelId: 'synthetic-local/model', messages: [], ...args,
        callbacks: { onChunk: text => events.push(['chunk', text]),
          onError: error => { events.push(['error', error]);
            if (options.errorObserverThrows) throw new Error('synthetic detached renderer'); },
          onComplete: () => events.push(['complete']) } });
      await Promise.resolve();
      return events;
    },
    calls, events,
    counts: () => ({ reads, cancels, releases }),
  };
}

test('Ollama real adapter preserves split UTF-8 records, request fields, endpoint and one EOF completion', async () => {
  const bytes = Buffer.from('{"message":{"content":"日本語"}}\n{"message":{"content":" tail"},"done":true}\n');
  const split = bytes.indexOf(Buffer.from('日')) + 1;
  const h = harness([bytes.subarray(0, split), bytes.subarray(split, split + 2), bytes.subarray(split + 2)]);
  assert.deepEqual(await h.run({ system: 'Synthetic system', baseURL: 'http://synthetic.invalid:11434///',
    messages: [{ role: 'user', text: ' question ' }, { role: 'assistant', text: 'answer' },
      { role: 'system', text: 'ignored' }, { role: 'user', text: '  ' }] }),
    [['chunk', '日本語'], ['chunk', ' tail'], ['complete']]);
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].url, 'http://synthetic.invalid:11434/api/chat');
  const init = h.calls[0].init;
  assert.equal(init.method, 'POST'); assert.equal(init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(init.body), { model: 'synthetic-local/model', stream: true,
    messages: [{ role: 'system', content: 'Synthetic system' }, { role: 'user', content: ' question ' },
      { role: 'assistant', content: 'answer' }] });
});

test('Ollama HTTP failure reports one error without reading or completing', async () => {
  const h = harness([], { ok: false, status: 503, body: 'synthetic unavailable' });
  assert.deepEqual(await h.run(), [['error', 'Ollama 503: synthetic unavailable']]);
  assert.equal(h.counts().reads, 0);
});

test('Ollama fetch and reader failures each terminate as one error', async () => {
  for (const h of [harness([], { fetchError: new Error('synthetic fetch failure') }),
    harness([new Error('synthetic reader failure')])]) {
    const events = await h.run();
    assert.equal(events.length, 1); assert.equal(events[0][0], 'error');
    assert.match(events[0][1], /^synthetic (fetch|reader) failure$/);
  }
});

test('Ollama streamed error stays terminal through failed cancellation or renderer teardown', async () => {
  for (const cancel of [undefined, 'throw', 'reject']) for (const errorObserverThrows of [false, true]) {
    const h = harness(['{"error":"synthetic model failure"}\n', '{"message":{"content":"must not arrive"}}\n'],
      { cancel, errorObserverThrows });
    assert.deepEqual(await h.run(), [['error', 'Ollama: synthetic model failure']]);
    assert.equal(h.counts().reads, 1); assert.equal(h.counts().cancels, 1); assert.equal(h.counts().releases, 1);
  }
});

test('Ollama streamed error retains preceding text and suppresses following text in the same chunk', async () => {
  const h = harness(['{"message":{"content":"partial"}}\n{"error":"synthetic stopped"}\n{"message":{"content":"never"}}\n']);
  assert.deepEqual(await h.run(), [['chunk', 'partial'], ['error', 'Ollama: synthetic stopped']]);
  assert.equal(h.counts().reads, 1);
});

test('Ollama defensive EOF tail preserves a complete final JSON record without newline', async () => {
  const h = harness(['{"message":{"content":"tail 日本語"},"done":true}']);
  assert.deepEqual(await h.run(), [['chunk', 'tail 日本語'], ['complete']]);
});

test('Ollama defensive EOF error record cannot become success', async () => {
  const h = harness(['{"error":"synthetic EOF failure"}']);
  assert.deepEqual(await h.run(), [['error', 'Ollama: synthetic EOF failure']]);
  assert.equal(h.counts().reads, 2);
});

test('Ollama existing blank and malformed record skip policy still permits normal EOF completion', async () => {
  const h = harness(['\nnot JSON\n{"message":{"content":"kept"}}\n', '  \n']);
  assert.deepEqual(await h.run(), [['chunk', 'kept'], ['complete']]);
  assert.equal(h.calls[0].url, 'http://localhost:11434/api/chat');
});
