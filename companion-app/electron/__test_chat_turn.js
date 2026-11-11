// Actual App send-handler AST + actual renderer stream client, with local fake IPC only.
// No App module initialization, React mount/effects, Electron, SDK, credential or provider call.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const appPath = path.join(__dirname, '../src/App.tsx');
const appSource = fs.readFileSync(appPath, 'utf8');
const appAST = ts.createSourceFile(appPath, appSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const app = appAST.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'App');
assert(app?.body, 'Use the actual named App function');
const declarations = app.body.statements.filter(ts.isVariableStatement).flatMap(node => [...node.declarationList.declarations]);
const declaration = name => {
  const matches = declarations.filter(node => ts.isIdentifier(node.name) && node.name.text === name);
  assert.equal(matches.length, 1, `Exactly one actual ${name} declaration required`);
  return matches[0];
};
const guard = declaration('chatTurnActive').initializer;
assert(ts.isCallExpression(guard) && guard.expression.getText(appAST) === 'useRef'
  && guard.arguments[0].kind === ts.SyntaxKind.FalseKeyword, 'Guard must be per-App ref, initially unlocked');
const send = declaration('onSendChat').initializer;
assert(ts.isCallExpression(send) && send.expression.getText(appAST) === 'useCallback'
  && ts.isArrowFunction(send.arguments[0]), 'Extract the actual App callback, not a copied implementation');
const handlerCode = ts.transpileModule(`const onSendChat = ${send.getText(appAST)}; module.exports = onSendChat;`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const clientPath = path.join(__dirname, '../src/services/archivist.ts');
const clientCode = ts.transpileModule(fs.readFileSync(clientPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

function harness(options = {}) {
  let nextID = 0;
  const starts = [], acks = [], aborts = [], handles = [], busyEvents = [], listeners = {
    chunk: new Set(), tool: new Set(), complete: new Set(), error: new Set(),
  };
  const state = { input: '  Synthetic draft  ', busy: false, uncertain: false, config: {
    chain: [{ id: 'draft', type: 'script', stage: 10, enabled: true, approved: false, params: { code: '' } }],
    colorManagement: {}, archivist: { autoApply: false,
      messages: [{ id: 'greeting', role: 'assistant', text: 'Synthetic greeting', timestamp: 'synthetic' }] },
  } };
  const turn = { current: false }, acked = { current: new Set() };
  let now = 0, nextTimer = 0;
  const timers = new Map(), allListeners = { chunk: [], tool: [], complete: [], error: [] };
  const clock = {
    setTimeout(callback, delay) { const id = nextTimer++; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    advance(ms) {
      now += ms;
      for (const [id, entry] of [...timers]) if (entry.at <= now) { timers.delete(id); entry.callback(); }
    },
    pending: () => timers.size,
  };
  const subscribe = name => callback => {
    if (options.throwSubscriptionAt === name) throw Error('Synthetic subscription setup failure');
    listeners[name].add(callback); allListeners[name].push(callback); return () => listeners[name].delete(callback);
  };
  const bridge = {
    sendArchivistMessage(payload) {
      if (options.throwSend) throw Error('Synthetic IPC setup failure');
      const requestId = `synthetic-request-${starts.length + 1}`;
      let resolve, reject;
      const response = new Promise((ready, fail) => { resolve = ready; reject = fail; });
      starts.push({ requestId, payload, resolve, reject });
      for (const event of options.earlyEvents ?? []) emit(event.kind, { requestId, ...event.info });
      if (!options.deferSend) {
        if (options.rejectSend) reject(Error('Synthetic send rejection'));
        else resolve({ requestId });
      }
      return response;
    },
    onArchivistChunk: subscribe('chunk'), onArchivistToolUse: subscribe('tool'),
    onArchivistComplete: subscribe('complete'), onArchivistError: subscribe('error'),
    sendArchivistToolAck(payload) { acks.push(payload); },
    abortArchivist(requestId) { aborts.push(requestId); if (options.throwAbort) throw Error('Synthetic abort delivery failure'); },
  };
  const fakeWindow = { electron: options.missingBridge ? undefined : bridge };
  const clientModule = { exports: {} };
  vm.runInNewContext(clientCode, { module: clientModule, exports: clientModule.exports, window: fakeWindow,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    require() { assert.fail('Renderer client must not import a backend/SDK'); },
  }, { filename: clientPath, timeout: 1000 });
  const client = clientModule.exports;
  const renderHandler = () => {
    const module = { exports: {} };
    vm.runInNewContext(handlerCode, {
      module, exports: module.exports, useCallback: callback => callback,
      chatInput: state.input, chatTurnActive: turn, config: state.config,
      selectedModel: { id: 'synthetic/model' }, ackedEditIdsRef: acked,
      mkid: prefix => `${prefix}-${++nextID}`,
      setConfig(update) { state.config = typeof update === 'function' ? update(state.config) : update; },
      setChatInput(value) { state.input = value; },
      setIsThinking(value) { state.busy = value; busyEvents.push(value); },
      setChatTurnUncertain(value) { state.uncertain = value; },
      buildArchivistSystemPrompt() {
        if (options.throwPrompt) throw Error('Synthetic prompt setup failure');
        return 'Synthetic system prompt';
      },
      registeredNamespaces: null,
      neuralCapability: null,
      streamArchivist(args) {
        if (options.throwStream) throw Error('Synthetic stream factory failure');
        if (options.rejectDone) return { cancel() {}, done: Promise.reject(Error('Synthetic rejected completion')) };
        const handle = client.streamArchivist(args); handles.push(handle); return handle;
      },
      ackToolBridge: client.ackToolBridge,
      decodeOperations: () => [], // Tool execution/approval is deliberately outside this fixture.
      applyOperations() { assert.fail('No chain/tool application expected'); },
      require() { assert.fail('Send-handler extraction must not import services'); },
      window: new Proxy({}, { get() { throw Error('App handler must use the injected stream only'); } }),
    }, { filename: `${appPath}:onSendChat`, timeout: 1000 });
    return module.exports;
  };
  const emit = (name, info) => { for (const listener of [...listeners[name]]) listener(info); };
  return { options, state, turn, starts, acks, aborts, handles, busyEvents, fakeWindow, bridge, renderHandler, emit, clock,
    client, limits: client.CHAT_STARTUP_LIMITS,
    resolve(index = starts.length - 1, requestId = starts[index].requestId) { starts[index].resolve({ requestId }); },
    count: name => listeners[name].size,
    late(name, index, info) { allListeners[name][index](info); },
    listenerCount: () => Object.values(listeners).reduce((sum, group) => sum + group.size, 0),
    async complete(index = starts.length - 1) {
      await flush(); emit('complete', { requestId: starts[index].requestId }); await flush();
      assert.equal(turn.current, false); assert.equal(state.busy, false); assert.equal(this.listenerCount(), 0);
    } };
}

test('same-render repeated send starts one stream and appends one user/assistant pair', async () => {
  const h = harness(), send = h.renderHandler(); send(); send();
  assert.equal(h.starts.length, 1); assert.equal(h.state.config.archivist.messages.length, 3);
  assert.equal(h.state.config.archivist.messages[1].text, 'Synthetic draft');
  assert.equal(h.state.input, ''); assert.equal(h.turn.current, true); assert.equal(h.state.busy, true);
  await h.complete(); assert.deepEqual(h.busyEvents, [true, false]);
  h.state.input = 'Next turn'; h.renderHandler()(); assert.equal(h.starts.length, 2); await h.complete();
});

test('a newer busy-render callback preserves the typed draft and existing history', async () => {
  const h = harness(); h.renderHandler()(); h.state.input = 'Keep this next draft';
  const messages = h.state.config.archivist.messages;
  h.renderHandler()(); assert.equal(h.starts.length, 1); assert.equal(h.state.input, 'Keep this next draft');
  assert.strictEqual(h.state.config.archivist.messages, messages); await h.complete();
});

test('chunks and tool-use rounds do not settle or unlock a manual turn', async () => {
  const h = harness(); h.renderHandler()(); await flush();
  const requestId = h.starts[0].requestId;
  h.emit('chunk', { requestId, text: 'Synthetic response' });
  h.emit('tool', { requestId, name: 'propose_chain_edit', editId: 'synthetic-edit', input: {} });
  assert.equal(h.acks.length, 1); assert.equal(h.turn.current, true); assert.equal(h.state.busy, true);
  assert.deepEqual(h.busyEvents, [true]);
  h.state.input = 'Do not overlap'; h.renderHandler()(); assert.equal(h.starts.length, 1);
  assert.equal(h.state.config.chain[0].approved, false); await h.complete();
});

test('actual client terminal error settles the guard and permits a later send', async () => {
  const h = harness(); h.renderHandler()(); await flush();
  h.emit('error', { requestId: h.starts[0].requestId, error: 'Synthetic terminal failure' }); await flush();
  assert.equal(h.turn.current, false); assert.equal(h.state.busy, false); assert.equal(h.listenerCount(), 0);
  assert.match(h.state.config.archivist.messages[2].text, /Synthetic terminal failure/);
  h.state.input = 'Retry after error'; h.renderHandler()(); assert.equal(h.starts.length, 2); await h.complete();
});

for (const kind of ['complete', 'error']) {
  test(`early terminal ${kind} before request correlation settles the guard`, async () => {
    const h = harness({ earlyEvents: [{ kind, info: { error: 'Synthetic early failure' } }] });
    h.renderHandler()(); await flush();
    assert.equal(h.turn.current, false); assert.equal(h.state.busy, false); assert.equal(h.listenerCount(), 0);
    if (kind === 'error') assert.match(h.state.config.archivist.messages[2].text, /Synthetic early failure/);
    h.options.earlyEvents = []; h.state.input = 'Retry after early terminal';
    h.renderHandler()(); await h.complete();
  });
}

test('early chunks and tool events retain order before an early completion', async () => {
  const h = harness({ earlyEvents: [
    { kind: 'chunk', info: { text: 'First ' } },
    { kind: 'tool', info: { name: 'propose_chain_edit', editId: 'synthetic-early-edit', input: {} } },
    { kind: 'chunk', info: { text: 'second' } }, { kind: 'complete', info: {} },
  ] });
  h.renderHandler()(); await flush();
  assert.equal(h.state.config.archivist.messages[2].text, 'First second'); assert.equal(h.acks.length, 1);
  assert.equal(h.turn.current, false); assert.equal(h.state.busy, false); assert.equal(h.listenerCount(), 0);
  assert.equal(h.state.config.chain[0].approved, false);
});

test('an early event for another request cannot settle or write into this conversation', async () => {
  const h = harness({ earlyEvents: [{ kind: 'error', info: { requestId: 'unrelated', error: 'Unrelated failure' } }] });
  h.renderHandler()(); await flush();
  assert.equal(h.turn.current, true); assert.equal(h.state.busy, true);
  assert.equal(h.state.config.archivist.messages[2].text, ''); await h.complete();
});

for (const flag of ['throwSend', 'throwSubscriptionAt']) {
  test(`startup ${flag} distinguishes an attempted dispatch from a local subscription failure`, async () => {
    const h = harness({ [flag]: flag === 'throwSubscriptionAt' ? 'error' : true });
    h.renderHandler()(); await flush();
    assert.equal(h.starts.length, 0); assert.equal(h.clock.pending(), 0);
    if (flag === 'throwSend') {
      assert.equal(h.listenerCount(), 2); assert.equal(h.state.uncertain, true);
      assert.equal(h.turn.current, true); assert.equal(h.state.busy, true);
      assert.match(h.state.config.archivist.messages[2].text, /status is unknown/);
      return; // A throw after invocation cannot prove that backend work never started.
    }
    assert.equal(h.listenerCount(), 0);
    assert.equal(h.turn.current, false); assert.equal(h.state.busy, false);
    assert.match(h.state.config.archivist.messages[2].text, /setup failure/);
    h.options[flag] = false; h.state.input = 'Retry'; h.renderHandler()(); await h.complete();
  });
}

test('startup invoke rejection keeps unknown work blocked instead of assuming termination', async () => {
  const h = harness({ rejectSend: true }); h.renderHandler()(); await flush();
  assert.equal(h.turn.current, true); assert.equal(h.state.busy, true); assert.equal(h.state.uncertain, true);
  assert.equal(h.count('chunk'), 0); assert.equal(h.count('tool'), 0); assert.equal(h.listenerCount(), 2);
  assert.equal(h.clock.pending(), 0); assert.match(h.state.config.archivist.messages[2].text, /status is unknown/);
  h.state.input = 'Keep this retry draft'; h.renderHandler()(); assert.equal(h.starts.length, 1);
  assert.equal(h.state.input, 'Keep this retry draft');
});

test('actual missing-bridge error settles its resolved handle without getting stuck', async () => {
  const h = harness({ missingBridge: true }); h.renderHandler()(); await flush();
  assert.equal(h.starts.length, 0); assert.equal(h.turn.current, false); assert.equal(h.state.busy, false);
  assert.match(h.state.config.archivist.messages[2].text, /bridge missing/);
  h.fakeWindow.electron = h.bridge; h.state.input = 'Retry'; h.renderHandler()(); await h.complete();
});

for (const flag of ['throwPrompt', 'throwStream']) {
  test(`synchronous ${flag} failure releases and reports in the existing assistant slot`, async () => {
    const h = harness({ [flag]: true }); h.renderHandler()();
    assert.equal(h.turn.current, false); assert.equal(h.state.busy, false); assert.equal(h.starts.length, 0);
    assert.equal(h.state.config.archivist.messages.length, 3);
    assert.match(h.state.config.archivist.messages[2].text, /could not start this message/);
    h.options[flag] = false; h.state.input = 'Retry'; h.renderHandler()(); await h.complete();
  });
}

test('a rejected completion promise is handled and permits a later turn', async () => {
  const h = harness({ rejectDone: true }); h.renderHandler()(); await flush();
  assert.equal(h.turn.current, false); assert.equal(h.state.busy, false);
  assert.match(h.state.config.archivist.messages[2].text, /could not finish this message/);
  h.options.rejectDone = false; h.state.input = 'Retry'; h.renderHandler()(); await h.complete();
});

test('empty input does not acquire the guard, clear history or create a stream', () => {
  const h = harness(); h.state.input = '  \n '; const messages = h.state.config.archivist.messages;
  h.renderHandler()(); assert.equal(h.starts.length, 0); assert.equal(h.turn.current, false);
  assert.strictEqual(h.state.config.archivist.messages, messages); assert.deepEqual(h.busyEvents, []);
});

test('manual-turn guards belong to their App conversation rather than a global client lock', async () => {
  const a = harness(), b = harness(); a.renderHandler()(); b.renderHandler()();
  assert.equal(a.starts.length, 1); assert.equal(b.starts.length, 1);
  await a.complete(); assert.equal(b.turn.current, true); assert.equal(b.state.busy, true);
  await b.complete();
});

test('startup event budget accepts exactly the count limit and preserves matching order', async () => {
  const h = harness({ deferSend: true });
  h.options.earlyEvents = Array.from({ length: h.limits.events }, (_, i) => ({ kind: 'chunk', info: { text: `${i},` } }));
  h.renderHandler()(); assert.equal(h.state.uncertain, false); assert.equal(h.clock.pending(), 1);
  h.resolve(); await flush();
  assert.equal(h.state.config.archivist.messages[2].text, Array.from({ length: h.limits.events }, (_, i) => `${i},`).join(''));
  assert.equal(h.clock.pending(), 0); await h.complete();
});

test('startup serialized budget accepts its exact boundary without truncating text', async () => {
  const h = harness({ deferSend: true });
  const overhead = JSON.stringify({ kind: 'chunk', requestId: 'synthetic-request-1', text: '' }).length;
  const text = 'z'.repeat(h.limits.serializedUnits - overhead);
  h.options.earlyEvents = [{ kind: 'chunk', info: { text } }];
  h.renderHandler()(); assert.equal(h.state.uncertain, false);
  h.resolve(); await flush(); assert.equal(h.state.config.archivist.messages[2].text, text); await h.complete();
});

for (const dimension of ['events', 'serializedUnits']) {
  test(`startup ${dimension} overflow explicitly fails, bounds listeners and blocks retries until termination`, async () => {
    const h = harness({ deferSend: true });
    h.options.earlyEvents = dimension === 'events'
      ? Array.from({ length: h.limits.events + 1 }, () => ({ kind: 'chunk', info: { text: 'DISCARDED_PAYLOAD' } }))
      : [{ kind: 'chunk', info: { text: 'x'.repeat(h.limits.serializedUnits + 1) } }];
    h.renderHandler()();
    assert.equal(h.turn.current, true); assert.equal(h.state.uncertain, true); assert.equal(h.clock.pending(), 0);
    assert.equal(h.count('chunk'), 0); assert.equal(h.count('tool'), 0); assert.equal(h.listenerCount(), 2);
    assert.match(h.state.config.archivist.messages[2].text, /buffer limit.*discarded/);
    assert(!h.state.config.archivist.messages[2].text.includes('DISCARDED_PAYLOAD'));
    h.resolve(); await flush(); h.state.input = 'Retain the next draft'; h.renderHandler()();
    assert.equal(h.starts.length, 1); assert.equal(h.state.input, 'Retain the next draft');
    h.emit('complete', { requestId: 'unrelated' }); assert.equal(h.turn.current, true);
    await h.complete(); assert.equal(h.state.uncertain, false);
    assert.match(h.state.config.archivist.messages[2].text, /reported as ended.*Review any response or changes/);
    h.options.earlyEvents = []; h.options.deferSend = false; h.state.input = 'Retry after terminal';
    h.renderHandler()(); assert.equal(h.starts.length, 2); await h.complete();
  });
}

test('startup deadline boundary marks unknown without inventing backend cancellation', async () => {
  const h = harness({ deferSend: true }); h.renderHandler()();
  h.clock.advance(h.limits.setupMs - 1); assert.equal(h.state.uncertain, false);
  h.clock.advance(1); assert.equal(h.state.uncertain, true); assert.equal(h.turn.current, true);
  assert.equal(h.clock.pending(), 0); assert.equal(h.listenerCount(), 2); assert.deepEqual(h.aborts, []);
  assert.match(h.state.config.archivist.messages[2].text, /local startup deadline/);
  h.resolve(); await flush(); assert.equal(h.turn.current, true); await h.complete();
  assert.equal(h.state.uncertain, false); assert(!h.state.config.archivist.messages[2].text.includes('status is unknown'));
});

test('startup never-settling invoke quarantines later callers, including non-App streams', async () => {
  const h = harness({ deferSend: true }); h.renderHandler()(); h.clock.advance(h.limits.setupMs);
  const errors = []; let released = false;
  const blocked = h.client.streamArchivist({ messages: [], system: 'Synthetic', modelId: 'synthetic/model',
    onChunk() { assert.fail('No blocked request output'); }, onError: message => errors.push(message) });
  blocked.done.then(() => { released = true; }); blocked.cancel();
  h.clock.advance(100_000); await flush();
  assert.equal(h.starts.length, 1); assert.equal(released, false); assert.equal(h.turn.current, true);
  assert.match(errors[0], /Message not sent/); assert.equal(h.clock.pending(), 0); assert.equal(h.listenerCount(), 2);
});

for (const kind of ['complete', 'error']) {
  test(`startup delayed ID reconciles an earlier ${kind} even after the local timeout`, async () => {
    const h = harness({ deferSend: true, earlyEvents: [{ kind, info: { error: 'Synthetic early terminal' } }] });
    h.renderHandler()(); h.clock.advance(h.limits.setupMs); assert.equal(h.turn.current, true);
    h.resolve(); await flush();
    assert.equal(h.turn.current, false); assert.equal(h.state.uncertain, false); assert.equal(h.listenerCount(), 0);
    assert.match(h.state.config.archivist.messages[2].text, /Review any response or changes/);
  });
}

test('startup terminal-ID metadata overflow fails closed rather than borrowing unrelated completion', async () => {
  const h = harness({ deferSend: true }); h.renderHandler()(); h.clock.advance(h.limits.setupMs);
  for (let i = 0; i < h.limits.terminalIds + 5; i++) h.emit('complete', { requestId: `unrelated-${i}` });
  assert.match(h.state.config.archivist.messages[2].text, /Terminal status buffer limit exceeded/);
  h.emit('complete', { requestId: h.starts[0].requestId }); // Not retained when bounded metadata is full.
  h.resolve(); await flush(); assert.equal(h.turn.current, true);
  h.emit('error', { requestId: 'unrelated-0', error: 'Unrelated' }); assert.equal(h.turn.current, true);
  await h.complete();
});

test('startup cancellation before correlation requests abort only after ID and still awaits a terminal', async () => {
  const h = harness({ deferSend: true }); h.renderHandler()(); h.handles[0].cancel();
  assert.equal(h.state.uncertain, true); assert.equal(h.turn.current, true); assert.deepEqual(h.aborts, []);
  assert.equal(h.clock.pending(), 0); h.resolve(); await flush();
  assert.deepEqual(h.aborts, [h.starts[0].requestId]); assert.equal(h.turn.current, true);
  h.handles[0].cancel(); assert.equal(h.aborts.length, 1); await h.complete();
});

test('startup cancellation after correlation preserves partial text and does not treat abort delivery as acknowledgement', async () => {
  const h = harness({ throwAbort: true }); h.renderHandler()(); await flush();
  h.emit('chunk', { requestId: h.starts[0].requestId, text: 'Keep partial response' }); h.handles[0].cancel();
  assert.equal(h.state.uncertain, true); assert.equal(h.turn.current, true); assert.equal(h.aborts.length, 1);
  assert.match(h.state.config.archivist.messages[2].text, /^Keep partial response/);
  assert.match(h.state.config.archivist.messages[2].text, /termination is not confirmed/);
  await h.complete(); assert.match(h.state.config.archivist.messages[2].text, /^Keep partial response/);
  assert.equal((h.state.config.archivist.messages[2].text.match(/Review any response or changes/g) || []).length, 1);
});

test('startup unrelated and late callbacks cannot release a newer active turn', async () => {
  const h = harness(); h.renderHandler()(); await h.complete();
  const messages = h.state.config.archivist.messages;
  for (const kind of ['chunk', 'tool', 'complete', 'error']) h.late(kind, 0, {
    requestId: h.starts[0].requestId, text: 'Late', name: 'propose_chain_edit', input: {}, error: 'Late',
  });
  assert.strictEqual(h.state.config.archivist.messages, messages); assert.equal(h.listenerCount(), 0);
  h.state.input = 'New turn'; h.renderHandler()(); await flush();
  h.late('complete', 0, { requestId: h.starts[1].requestId }); assert.equal(h.turn.current, true); await h.complete();
});

test('startup unsupported payload is rejected explicitly and becomes recoverable only on a matched terminal', async () => {
  const input = {}; input.self = input;
  const h = harness({ deferSend: true, earlyEvents: [{ kind: 'tool', info: { name: 'propose_chain_edit', input } }] });
  h.renderHandler()(); assert.equal(h.state.uncertain, true); assert.equal(h.acks.length, 0);
  assert.match(h.state.config.archivist.messages[2].text, /unsupported startup data/);
  h.resolve(); await flush(); await h.complete();
});

test('startup malformed request ID remains unknown and prevents another dispatch', async () => {
  const h = harness({ deferSend: true }); h.renderHandler()(); h.resolve(0, ''); await flush();
  assert.equal(h.state.uncertain, true); assert.equal(h.turn.current, true); assert.equal(h.clock.pending(), 0);
  h.emit('complete', { requestId: h.starts[0].requestId }); assert.equal(h.turn.current, true);
  h.state.input = 'No unsafe retry'; h.renderHandler()(); assert.equal(h.starts.length, 1);
});

test('startup quarantine releases blocked callers only after real terminal reports, without auto-resending', async () => {
  const h = harness({ deferSend: true }), errors = [];
  const first = h.client.streamArchivist({ messages: [], system: 'Synthetic', modelId: 'synthetic/model',
    onChunk() {}, onError: message => errors.push(message) });
  h.clock.advance(h.limits.setupMs);
  h.renderHandler()(); assert.equal(h.starts.length, 1); assert.equal(h.state.uncertain, true);
  h.resolve(); await flush(); assert.equal(h.turn.current, true);
  h.emit('complete', { requestId: h.starts[0].requestId }); await first.done; await flush();
  assert.equal(h.turn.current, false); assert.equal(h.starts.length, 1); assert.equal(h.state.uncertain, false);
  assert.match(h.state.config.archivist.messages[2].text, /message was not sent/);
  h.options.deferSend = false; h.state.input = 'Explicit resend'; h.renderHandler()(); assert.equal(h.starts.length, 2); await h.complete();
});

test('startup callback failure cannot hide an already received matching terminal report', async () => {
  const h = harness({ deferSend: true, earlyEvents: [
    { kind: 'chunk', info: { text: 'Synthetic output' } }, { kind: 'complete', info: {} },
  ] });
  const errors = []; let ended = false;
  const handle = h.client.streamArchivist({ messages: [], system: 'Synthetic', modelId: 'synthetic/model',
    onChunk() { throw Error('Synthetic consumer failure'); }, onError: message => errors.push(message) });
  handle.done.then(() => { ended = true; }); h.resolve(); await flush();
  assert.equal(ended, true); assert.equal(h.listenerCount(), 0); assert.equal(h.clock.pending(), 0);
  assert.match(errors.at(-1), /Review any response or changes/);
});
