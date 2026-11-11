// Actual observer/request code, apply-config callback and two App dispatch callbacks.
// All bridge/filesystem/window/timer ports are local fakes. Full App/main/Electron never load.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const server = require('react-dom/server');
const appRoot = path.join(__dirname, '..');
const forbidden = () => assert.fail('No real module, bridge, filesystem, window or timer allowed');
function evaluate(source, globals = {}, react = false) {
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.React, esModuleInterop: true },
  }).outputText, { module, exports: module.exports,
    require(name) { if (react && name === 'react') return React; return forbidden(); },
    window: new Proxy({}, { get: forbidden }), setTimeout: forbidden, clearTimeout: forbidden,
    ...globals,
  }, { timeout: 1000 });
  return module.exports;
}
const feedback = evaluate(fs.readFileSync(path.join(appRoot, 'src/services/config-write-feedback.ts'), 'utf8'));
const { createConfigWriteFeedbackObserver: observer, requestConfigWrite: request } = feedback;
const { ConfigWriteStatus } = evaluate(fs.readFileSync(path.join(appRoot, 'src/components/ConfigWriteStatus.tsx'), 'utf8'), {}, true);
const mainPath = path.join(__dirname, 'main.js');
const mainAst = ts.createSourceFile(mainPath, fs.readFileSync(mainPath, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const handlers = [];
function visitMain(node) {
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'handle' && ts.isStringLiteral(node.arguments[0])
      && node.arguments[0].text === 'apply-config') handlers.push(node.arguments[1]);
  ts.forEachChild(node, visitMain);
}
visitMain(mainAst); assert.equal(handlers.length, 1); assert(ts.isArrowFunction(handlers[0]));
const reader = mainAst.statements.filter(ts.isFunctionDeclaration).find(n => n.name?.text === 'readManualHostResult');
const policy = mainAst.statements.filter(ts.isFunctionDeclaration).find(n => n.name?.text === 'isTrustedSender');
assert(policy, 'isTrustedSender policy helper must exist in main.js');
const boots = mainAst.statements.filter(n => ts.isIfStatement(n) && n.expression.getText(mainAst) === 'manualHostApply && resultPath');
assert(reader); assert.equal(boots.length, 1);
const startupNames = ['requestedRevisionFloor', 'hostRevisionFloor', 'resultRevision', 'hostRecoveryRequired',
  'recoveryInputDescription', 'pendingRecoveryRequired', 'recoveryNote'];
const startupDeclarations = startupNames.map(name => {
  const matches = mainAst.statements.filter(ts.isVariableStatement).filter(n => n.declarationList.declarations
    .some(d => ts.isIdentifier(d.name) && d.name.text === name));
  assert.equal(matches.length, 1); return matches[0].getText(mainAst);
}).join('\n');
const producer = evaluate(fs.readFileSync(path.join(__dirname, 'editor-configuration.js'), 'utf8'));
const config = { schemaVersion: 1, nodeId: 'synthetic-node', manualOrder: false, chain: [], mix: 1,
  colorManagement: {}, archivist: { messages: [] } };
function port({ hasPath = true, writeFailure = false, scheduleFailure = false, manual = false,
  renameFailure = false, pending = '', revisionFloor = 0, boot = false, readSize, nonregular = false,
  openFailure = false, truncated = false, changed = false, extraByte = false, chunkSize = Infinity,
  hostRecoveryRequired = false, inputIsPending = false,
  resultFile = 'synthetic-result-path', sessionId = 'synthetic-session', sharedFiles } = {}) {
  const writes = [], timers = [], events = [], opens = [], closes = [];
  const files = sharedFiles ?? new Map();
  files.set(resultFile, Buffer.from(typeof pending === 'string' ? pending : JSON.stringify(pending)));
  const descriptors = new Map(); let serial = 0, uuid = 0;
  const fakeFs = {
    constants: fs.constants,
    openSync(file, flags) {
      opens.push({ file, flags });
      if (openFailure || !files.has(file)) throw Error('Synthetic open refusal');
      const fd = ++serial; descriptors.set(fd, { bytes: Buffer.from(files.get(file)), offset: 0, stats: 0 }); return fd;
    },
    fstatSync(fd) {
      const d = descriptors.get(fd); assert(d); d.stats++;
      return { isFile: () => !nonregular, size: readSize ?? d.bytes.length, mtimeMs: changed && d.stats > 1 ? 2 : 1 };
    },
    readSync(fd, bytes, offset, length) {
      const d = descriptors.get(fd); assert(d);
      if (truncated) return 0;
      if (extraByte && d.offset === d.bytes.length) { bytes[offset] = 32; return 1; }
      const n = Math.min(length, chunkSize, d.bytes.length - d.offset);
      d.bytes.copy(bytes, offset, d.offset, d.offset + n); d.offset += n; return n;
    },
    closeSync(fd) { assert(descriptors.delete(fd)); closes.push(fd); },
    writeFileSync(file, data, options) {
      writes.push({ file, data, encoding: options.encoding, flag: options.flag, mode: options.mode });
      if (writeFailure) throw Error('Synthetic write failure; partial effects unknown');
      if (options.flag === 'wx' && files.has(file)) throw Error('Synthetic exclusive-create refusal');
      files.set(file, Buffer.from(data));
    },
    renameSync(from, to) {
      events.push({ from, to });
      if (renameFailure) throw Error('Synthetic publication failure');
      assert(files.has(from)); files.set(to, files.get(from)); files.delete(from);
    },
  };
  const source = `let destroyed = false;
let editorWindow = null;
${policy.getText(mainAst)}
const trustedWebContents = {};
editorWindow = { isDestroyed: () => destroyed, webContents: trustedWebContents };
const trustedEvent = { sender: trustedWebContents };
const untrustedEvent = { sender: {} };
${startupDeclarations}
${reader.getText(mainAst)}
${boot ? boots[0].getText(mainAst) : ''}
module.exports = {
    handler: ${handlers[0].getText(mainAst)}, readPending: readManualHostResult,
    event: trustedEvent, untrustedEvent, setDestroyed: value => { destroyed = value; },
    snapshot: () => ({ initialConfig, latestConfig, resultRevision, pendingRecoveryRequired, recoveryNote }) };`;
  const loaded = evaluate(source, {
    initialConfig: config, latestConfig: config, resultPath: hasPath ? resultFile : null,
    manualHostApply: manual, hostSessionId: sessionId,
    process: { argv: ['synthetic-node', '--host-applied-revision=' + revisionFloor,
      ...(hostRecoveryRequired ? ['--host-recovery-required=1'] : []),
      ...(inputIsPending ? ['--host-config-origin=pending'] : [])] },
    Buffer, isManualHostConfig: producer.isManualHostConfig,
    describeManualHostConfigProblem: producer.describeManualHostConfigProblem,
    crypto: { randomUUID: () => 'synthetic-' + ++uuid }, fs: fakeFs,
    setTimeout(fn, ms) {
      if (scheduleFailure) throw Error('Synthetic close scheduling failure');
      timers.push({ fn, ms }); return timers.length;
    },
    BrowserWindow: { getAllWindows: () => [{ close: () => events.push('synthetic-close') }] },
    console: { log() {}, error() {} },
  });
  return { writes, timers, events, files, opens, closes, descriptors, ...loaded };
}
const good = (closeScheduled = false) => ({ ok: true, writePhase: 'write-reported', closeScheduled });
function render(state) { return server.renderToStaticMarkup(React.createElement(ConfigWriteStatus, { feedback: state })); }
async function observedPort(p, value, close) {
  const o = observer(); let reply;
  await request(() => ({ async applyConfig(payload, options) {
    reply = await p.handler(p.event, payload, options); return reply;
  } }), value, { close }, o);
  return { reply, state: o.snapshot() };
}

test('actual main callback distinguishes absent host path without a file write or close request', async () => {
  const p = port({ hasPath: false });
  const reply = await p.handler(p.event, config, { close: true });
  assert.equal(reply.ok, true); assert.equal(reply.writePhase, 'no-host-path');
  assert.equal(reply.closeScheduled, false); assert.equal(p.writes.length, 0); assert.equal(p.timers.length, 0);
});

test('actual main callback reports its write and schedules closing only when requested', async () => {
  const p = port();
  const auto = await p.handler(p.event, config, { close: false });
  assert.equal(auto.writePhase, 'write-reported'); assert.equal(auto.closeScheduled, false);
  assert.equal(p.writes[0].data, JSON.stringify(config)); assert.equal(p.writes[0].encoding, 'utf8');
  assert.equal(p.timers.length, 0);
  const manual = await p.handler(p.event, config, { close: true });
  assert.equal(manual.closeScheduled, true); assert.equal(p.timers.length, 1);
  assert.equal(p.timers[0].ms, 220); assert.equal(p.events.length, 0, 'Scheduled is not closed');
  p.timers[0].fn(); assert.deepEqual(p.events, ['synthetic-close']);
});

test('actual main callback separates serialization refusal, uncertain write failure and post-write close failure', async () => {
  const prepare = port(); const cyclic = {}; cyclic.self = cyclic;
  const preparation = await observedPort(prepare, cyclic, false), refused = preparation.reply;
  assert.equal(refused.ok, false); assert.equal(refused.writePhase, 'not-attempted');
  assert.equal(prepare.writes.length, 0);
  assert.equal(preparation.state.outcome, 'not-attempted'); assert.equal(preparation.state.unconfirmedDetail, null);
  const write = port({ writeFailure: true });
  const writing = await observedPort(write, config, true), failed = writing.reply;
  assert.equal(failed.ok, false); assert.equal(failed.writePhase, 'unconfirmed');
  assert.equal(write.writes.length, 1); assert.equal(write.timers.length, 0);
  assert.equal(writing.state.outcome, 'unconfirmed'); assert(writing.state.unconfirmedDetail);
  const close = port({ scheduleFailure: true });
  const closing = await observedPort(close, config, true), afterWrite = closing.reply;
  assert.equal(afterWrite.ok, false); assert.equal(afterWrite.writePhase, 'write-reported');
  assert.equal(afterWrite.closeScheduled, false); assert.equal(close.writes.length, 1);
  assert.equal(closing.state.outcome, 'write-reported'); assert.equal(closing.state.error, true);
  assert.equal(closing.state.unconfirmedDetail, null);
});

test('late earlier replies retain pending counts and uncertainty without replacing the latest observation', () => {
  const o = observer(), first = o.begin('automatic'), second = o.begin('automatic');
  second.resolve(good());
  assert.equal(o.snapshot().pending, 1); assert.equal(o.snapshot().outcome, 'write-reported');
  first.reject(Error('Synthetic older request unknown'));
  assert.equal(o.snapshot().pending, 0); assert.equal(o.snapshot().outcome, 'write-reported');
  assert.equal(o.snapshot().unconfirmedDetail, 'Synthetic older request unknown');
  const third = o.begin('automatic'); third.resolve(good());
  assert.equal(o.snapshot().unconfirmedDetail, 'Synthetic older request unknown');
  const html = render(o.snapshot()); assert(html.includes('An earlier write outcome remains unconfirmed.'));
});

test('duplicate settlement cannot decrement pending twice or invent a late rejection', () => {
  const o = observer(), ticket = o.begin('automatic');
  ticket.resolve(good()); ticket.resolve(good()); ticket.reject(Error('Synthetic duplicate'));
  assert.equal(o.snapshot().pending, 0); assert.equal(o.snapshot().unconfirmedDetail, null);
});

test('legacy, malformed and contradictory replies stay unconfirmed rather than becoming success', () => {
  const throwing = new Proxy({}, { get() { throw Error('Synthetic unreadable reply'); } });
  for (const reply of [undefined, { ok: true }, [], throwing,
    { ok: true, writePhase: 'unconfirmed', closeScheduled: false }, good(true)]) {
    const o = observer(); o.begin('automatic').resolve(reply);
    assert.equal(o.snapshot().outcome, 'unconfirmed'); assert(o.snapshot().unconfirmedDetail);
    assert.equal(o.snapshot().pending, 0);
  }
});

test('known no-host and preparation-failure observations do not manufacture an uncertain write', () => {
  const o = observer();
  o.begin('apply-and-close').resolve({ ok: true, writePhase: 'no-host-path', closeScheduled: false });
  assert.equal(o.snapshot().outcome, 'no-host-path'); assert.equal(o.snapshot().unconfirmedDetail, null);
  o.begin('automatic').resolve({ ok: false, writePhase: 'not-attempted', closeScheduled: false, error: 'Synthetic encode failure' });
  assert.equal(o.snapshot().outcome, 'not-attempted'); assert.equal(o.snapshot().error, true);
  assert.equal(o.snapshot().unconfirmedDetail, null);
  o.begin('automatic').resolve({ ok: false, writePhase: 'write-reported', closeScheduled: false });
  assert.equal(o.snapshot().outcome, 'write-reported'); assert.equal(o.snapshot().error, true);
  assert(o.snapshot().detail.includes('configuration request ended with an error'));
  assert(!o.snapshot().detail.includes('close request failed'));
});

test('bridge absence and access failure do not invoke a request', async () => {
  for (const get of [() => undefined, () => ({}), () => { throw Error('Synthetic bridge access failure'); }]) {
    const o = observer(); await request(get, config, { close: false }, o);
    assert.equal(o.snapshot().outcome, 'bridge-unavailable'); assert.equal(o.snapshot().pending, 0);
    assert.equal(o.snapshot().unconfirmedDetail, null);
  }
});

test('dispatch preserves receiver, payload and options and never retries a rejected invocation', async () => {
  const o = observer(); let calls = 0, gets = 0;
  const options = { close: false };
  const bridge = { applyConfig(value, opts) {
    calls++; assert.equal(this, bridge); assert.equal(value, config); assert.equal(opts, options);
    return Promise.reject(Error('Synthetic reply lost'));
  } };
  await request(() => { gets++; return bridge; }, config, options, o);
  assert.equal(calls, 1); assert.equal(gets, 1); assert.equal(o.snapshot().outcome, 'unconfirmed');
  assert.equal(o.snapshot().pending, 0); assert.equal(o.snapshot().unconfirmedDetail, 'Synthetic reply lost');
});

test('invoked synchronous throws and reply-then access failures remain uncertain and consumed once', async () => {
  for (const reply of [() => { throw Error('Synthetic invoked failure'); },
    () => ({ get then() { throw Error('Synthetic then failure'); } })]) {
    let calls = 0; const o = observer();
    await request(() => ({ applyConfig() { calls++; return reply(); } }), config, { close: false }, o);
    assert.equal(calls, 1); assert.equal(o.snapshot().outcome, 'unconfirmed');
    assert.equal(o.snapshot().pending, 0);
  }
});

test('subscription cleanup is owned, resubscription retains outcomes, and listener faults cannot cause resend', async () => {
  const o = observer(), seen = [], stopOld = o.subscribe(() => {});
  const stopNew = o.subscribe(value => seen.push(value)); stopOld();
  const ticket = o.begin('automatic'); assert.equal(seen.at(-1).pending, 1);
  stopNew(); const count = seen.length; ticket.reject(Error('Synthetic detached unknown'));
  assert.equal(seen.length, count);
  o.subscribe(value => seen.push(value)); assert.equal(seen.at(-1).unconfirmedDetail, 'Synthetic detached unknown');
  const copy = o.snapshot(); copy.pending = 999; assert.equal(o.snapshot().pending, 0);
  o.subscribe(() => { throw Error('Synthetic UI notification fault'); });
  let calls = 0;
  await request(() => ({ applyConfig() { calls++; return good(); } }), config, { close: false }, o);
  assert.equal(calls, 1); assert.equal(o.snapshot().outcome, 'write-reported');
  assert.equal(o.snapshot().unconfirmedDetail, 'Synthetic detached unknown');
});

test('actual App manual and debounced automatic paths preserve one invocation per existing dispatch', async () => {
  const sourcePath = path.join(appRoot, 'src/App.tsx');
  const ast = ts.createSourceFile(sourcePath, fs.readFileSync(sourcePath, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let manual, automatic, dependencies;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'onAccept') {
      assert(ts.isCallExpression(node.initializer)); manual = node.initializer.arguments[0];
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'useEffect'
        && node.arguments[0]?.getText(ast).includes('liveSyncDebounce.current = setTimeout')) {
      automatic = node.arguments[0]; dependencies = node.arguments[1].getText(ast);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast); assert(manual && automatic); assert.equal(dependencies, '[config, isEditorReady]');
  const o = observer(), p = port(), clientTimers = new Map(), observed = []; let serial = 0, calls = 0;
  const context = { config, isEditorReady: true, writeObserver: { current: o },
    requestConfigWrite(...args) { const result = request(...args); observed.push(result); return result; },
    seenInitial: { current: false }, liveSyncDebounce: { current: null },
    console: { log() {} }, window: { electron: { applyConfig(value, options) {
      calls++; return p.handler(p.event, value, options);
    } } },
    setTimeout(fn, ms) { const id = ++serial; clientTimers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { clientTimers.delete(id); },
  };
  const accept = evaluate(`module.exports = ${manual.getText(ast)};`, context);
  accept(); await observed.at(-1); assert.equal(calls, 1); assert.equal(o.snapshot().outcome, 'write-reported');
  const sync = evaluate(`module.exports = ${automatic.getText(ast)};`, context);
  sync(); assert.equal(clientTimers.size, 0); assert.equal(calls, 1);
  const cleanup = sync(); assert.equal(clientTimers.size, 1); assert.equal(calls, 1);
  const timer = [...clientTimers.values()][0]; assert.equal(timer.ms, 250);
  timer.fn(); await observed.at(-1); assert.equal(calls, 2); assert.equal(p.writes.length, 2);
  cleanup(); assert.equal(clientTimers.size, 0);
  assert.equal(o.snapshot().pending, 0); assert.equal(o.snapshot().unconfirmedDetail, null);
});

test('actual status markup separates waiting, reported writes, old unknowns and native processing', () => {
  assert.equal(render(observer().snapshot()), '');
  const o = observer(), pending = o.begin('automatic');
  const waiting = render(o.snapshot()); assert(waiting.includes('role="status"') && waiting.includes('Waiting for a companion'));
  pending.reject(Error('Synthetic missing acknowledgement'));
  const next = o.begin('automatic'); next.resolve(good());
  const html = render(o.snapshot());
  assert(html.includes('The companion reported a configuration file write.'));
  assert(html.includes('An earlier write outcome remains unconfirmed.'));
  assert(html.includes('These replies do not confirm that Resolve applied or rendered the configuration.'));
  assert(html.includes('for this window') && !html.includes('Render complete') && !html.includes('Saved successfully'));
});

test('error details are escaped, explicitly bounded and readable in the focusable scroll region', () => {
  const o = observer();
  o.begin('automatic').reject('<script>synthetic()</script> ' + 'x'.repeat(10000));
  assert.equal(o.snapshot().detail.length, 4096); assert(o.snapshot().detail.includes('[details truncated]'));
  const html = render(o.snapshot());
  assert(html.includes('&lt;script&gt;') && !html.includes('<script>'));
  assert(html.includes('tabindex="0"') && html.includes('overflow-y:auto') && html.includes('overflow-wrap:anywhere'));
});


test('manual-host publication binds session/revision, uses private exclusive temporary file and reports only after rename', async () => {
  const p = port({ manual: true });
  const first = await p.handler(p.event, config, { close: true });
  assert.equal(first.writePhase, 'write-reported');
  assert.equal(p.writes[0].file, 'synthetic-result-path.pending-synthetic-1');
  assert.equal(p.writes[0].flag, 'wx'); assert.equal(p.writes[0].mode, 0o600);
  const envelope = JSON.parse(p.writes[0].data);
  assert.equal(envelope.sessionId, 'synthetic-session'); assert.equal(envelope.revision, 1);
  assert.deepEqual(envelope.config, config);
  assert.deepEqual(p.events, [{ from: 'synthetic-result-path.pending-synthetic-1', to: 'synthetic-result-path' }]);
  await p.handler(p.event, config, { close: true });
  assert.equal(JSON.parse(p.writes[1].data).revision, 2); assert.equal(p.timers.length, 2);
});

test('manual-host malformed and oversized configurations never publish or close; rename failure stays unconfirmed', async () => {
  const p = port({ manual: true });
  for (const payload of [{}, { ...config, chain: 'synthetic-invalid' }, { ...config, label: 'x'.repeat(8 * 1024 * 1024) }]) {
    const reply = await p.handler(p.event, payload, { close: true });
    assert.equal(reply.ok, false); assert.equal(reply.writePhase, 'not-attempted');
  }
  assert.equal(p.writes.length, 0); assert.equal(p.events.length, 0); assert.equal(p.timers.length, 0);
  const failed = port({ manual: true, renameFailure: true });
  const reply = await failed.handler(failed.event, config, { close: true });
  assert.equal(reply.writePhase, 'unconfirmed'); assert.equal(reply.ok, false);
  assert.equal(failed.writes.length, 1); assert.equal(failed.timers.length, 0);
});

test('manual-host UI exposes the host action before any file write and never calls saving an apply', () => {
  const html = server.renderToStaticMarkup(React.createElement(ConfigWriteStatus,
    { feedback: observer().snapshot(), manualHostApply: true }));
  assert(html.includes('Save and close'));
  assert(html.includes('applies them automatically'));
  assert(!html.includes('does not apply or render edits'));
  const app = ts.createSourceFile('App.tsx', fs.readFileSync(path.join(appRoot, 'src/App.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = app.statements.filter(ts.isVariableStatement).flatMap(n => [...n.declarationList.declarations])
    .find(n => n.name.getText(app) === 'TitleBar');
  const Title = evaluate(`module.exports = ${declaration.initializer.getText(app)};`, { React }, true);
  const header = server.renderToStaticMarkup(React.createElement(Title, { onAccept() {}, onCancel() {}, manualHostApply: true }));
  assert(header.includes('Save and close')); assert(!header.includes('Apply and close'));
  // Publishing-instructions note removed from the title bar (live feedback:
  // repeated permanent copy); nothing may assert it back into the header.
  assert(!header.includes('applies your edits to the node automatically.'));
});

test('manual-host preview IPC refuses before any filesystem access or native dispatch', async () => {
  for (const channel of ['preview-chain', 'read-preview-image']) {
    let found;
    function scan(n) {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)
          && n.expression.name.text === 'handle' && ts.isStringLiteral(n.arguments[0])
          && n.arguments[0].text === channel) found = n.arguments[1];
      ts.forEachChild(n, scan);
    }
    scan(mainAst); assert(found);
    // preview-chain enforces the sender policy (security re-review #4): the
    // REAL isTrustedSender helper is composed in, so this test drives the
    // actual trusted-window path. read-preview-image loads the same wrapper
    // (the extra bindings are inert for it).
    const callback = evaluate(`let editorWindow = null;
${policy.getText(mainAst)}
const trustedWebContents = {};
editorWindow = { isDestroyed: () => false, webContents: trustedWebContents };
const trustedEvent = { sender: trustedWebContents };
module.exports = { callback: ${found.getText(mainAst)}, event: trustedEvent };`, {
      manualHostApply: true, fs: new Proxy({}, { get: forbidden }),
      setTimeout: forbidden, previewRequestPath: 'synthetic-req', previewResponsePath: 'synthetic-resp',
    });
    const reply = await callback.callback(callback.event, { chain: '{}' });
    assert.equal(reply.ok, false); assert(reply.error.includes('unavailable in this build'));
  }
});

test('preview-chain refuses an untrusted sender before any dispatch or file access', async () => {
  let found;
  function scan(n) {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)
        && n.expression.name.text === 'handle' && ts.isStringLiteral(n.arguments[0])
        && n.arguments[0].text === 'preview-chain') found = n.arguments[1];
    ts.forEachChild(n, scan);
  }
  scan(mainAst); assert(found);
  const callback = evaluate(`let editorWindow = null;
${policy.getText(mainAst)}
const trustedWebContents = {};
editorWindow = { isDestroyed: () => false, webContents: trustedWebContents };
module.exports = ${found.getText(mainAst)};`, {
    manualHostApply: false, fs: new Proxy({}, { get: forbidden }),
    setTimeout: forbidden, previewRequestPath: 'synthetic-req', previewResponsePath: 'synthetic-resp',
  });
  const reply = await callback({ sender: {} }, { chain: '{}' });
  assert.equal(reply.ok, false);
  assert(reply.error.includes('Untrusted sender'), 'refusal must name the sender policy');
});

test('apply-config refuses untrusted or torn-down senders before any write', async () => {
  const untrusted = port();
  const refused = await untrusted.handler(untrusted.untrustedEvent, config, { close: true });
  assert.equal(refused.ok, false); assert(refused.error.includes('Untrusted sender'));
  assert.equal(refused.writePhase, 'not-attempted'); assert.equal(refused.closeScheduled, false);
  assert.equal(untrusted.writes.length, 0); assert.equal(untrusted.timers.length, 0);
  const torn = port();
  torn.setDestroyed(true);
  const afterClose = await torn.handler(torn.event, config, { close: true });
  assert.equal(afterClose.ok, false); assert.equal(torn.writes.length, 0);
});


test('changed Main and pure bootstrap producer have whole-file Node syntax without module execution', () => {
  for (const file of [mainPath, path.join(__dirname, 'editor-configuration.js')]) {
    assert.doesNotThrow(() => new vm.Script(fs.readFileSync(file, 'utf8'), { filename: file }));
  }
  assert.throws(() => new vm.Script('const = ;'), SyntaxError);
});

test('actual bounded pending reader closes its owned fake descriptor on success, empty and every refusal', () => {
  const packet = { sessionId: 'synthetic-session', revision: 8, config };
  const good = port({ manual: true, pending: packet, chunkSize: 7 });
  assert.equal(good.readPending().revision, 8); assert.equal(good.descriptors.size, 0);
  assert.equal(good.opens[0].flags, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  const empty = port(); assert.equal(empty.readPending(), null); assert.equal(empty.closes.length, 1);
  for (const options of [{ pending: '{' }, { pending: { ...packet, sessionId: 'synthetic-other' } },
    { pending: { ...packet, revision: 0 } }, { pending: { ...packet, revision: 1.5 } },
    { pending: packet, readSize: 8 * 1024 * 1024 + 1 }, { pending: packet, nonregular: true },
    { pending: packet, truncated: true }, { pending: packet, changed: true }, { pending: packet, extraByte: true }]) {
    const p = port(options); assert.throws(p.readPending); assert.equal(p.descriptors.size, 0);
    assert.equal(p.closes.length, 1); assert.equal(p.writes.length, 0);
  }
  const refused = port({ openFailure: true }); assert.throws(refused.readPending); assert.equal(refused.closes.length, 0);
});

test('restart reopens a newer pending editor snapshot but publishes only on explicit Save and close', async () => {
  const pendingConfig = { ...config, nodeId: 'synthetic-reopened' };
  const p = port({ manual: true, pending: { sessionId: 'synthetic-session', revision: 12, config: pendingConfig },
    revisionFloor: 10, boot: true });
  assert.equal(p.snapshot().initialConfig.nodeId, 'synthetic-reopened');
  assert.equal(p.snapshot().resultRevision, 12); assert.equal(p.snapshot().pendingRecoveryRequired, false);
  assert(p.snapshot().recoveryNote.includes('Host apply and rendering remain unconfirmed'));
  const auto = await p.handler(p.event, pendingConfig, { close: false });
  assert.equal(auto.writePhase, 'editor-only'); assert.equal(p.writes.length, 0);
  const reply = await p.handler(p.event, pendingConfig, { close: true });
  assert.equal(reply.writePhase, 'write-reported'); assert.equal(JSON.parse(p.writes[0].data).revision, 13);
  assert.equal(p.descriptors.size, 0);
});

test('malformed pending recovery keeps the original file until explicit valid Save and close', async () => {
  const original = '{ synthetic invalid pending';
  const p = port({ manual: true, pending: original, revisionFloor: 23, boot: true });
  assert.equal(p.snapshot().pendingRecoveryRequired, true);
  assert(p.snapshot().recoveryNote.includes('Automatic writes are held'));
  const auto = await p.handler(p.event, config, { close: false });
  assert.equal(auto.writePhase, 'editor-only'); assert.equal(p.writes.length, 0);
  assert.equal(p.files.get('synthetic-result-path').toString(), original);
  const saved = await p.handler(p.event, config, { close: true });
  assert.equal(saved.writePhase, 'write-reported'); assert.equal(JSON.parse(p.writes[0].data).revision, 24);
  assert.equal(p.snapshot().pendingRecoveryRequired, false); assert.equal(p.timers.length, 1);
});

test('known configuration transport shapes are refused before publication; filter-specific values are not qualified here', async () => {
  for (const patch of [{ chain: [null] }, { chain: new Array(1) }, { chain: [{ params: [] }] },
    { chain: [{ params: null }] }, { chain: [{ enabled: 'true' }] }, { chain: [{ stage: 2147483648 }] },
    { mix: Infinity }, { colorManagement: { inputGamma: null } }]) {
    const p = port({ manual: true }); const reply = await p.handler(p.event, { ...config, ...patch }, { close: true });
    assert.equal(reply.writePhase, 'not-attempted'); assert.equal(p.writes.length, 0);
  }
  assert.equal(producer.isManualHostConfig({ ...config, chain: [{ params: { unknownFilterValue: 'synthetic-unqualified' } }] }), true);
});


test('every manual automatic sync is editor-only and cannot access a retained or newly published result', async () => {
  for (const hostRecoveryRequired of [false, true]) {
    const p = port({ manual: true, hostRecoveryRequired, openFailure: true });
    const o = observer();
    await request(() => ({ applyConfig: (value, options) => p.handler(p.event, value, options) }),
      config, { close: false }, o);
    assert.equal(o.snapshot().outcome, 'editor-only'); assert.equal(o.snapshot().error, false);
    assert.equal(p.opens.length, 0); assert.equal(p.writes.length, 0); assert.equal(p.timers.length, 0);
    assert.equal(p.snapshot().latestConfig.nodeId, config.nodeId);
  }
});

test('native-invalid/stale/conflicting dispositions require explicit repair and preserve the original file', async () => {
  const retained = { ...config, nodeId: 'synthetic-retained' };
  for (const patch of [{ revision: 12, revisionFloor: 15, hostRecoveryRequired: false },
    { revision: 15, revisionFloor: 15, hostRecoveryRequired: true },
    { revision: 20, revisionFloor: 15, hostRecoveryRequired: true }]) {
    const pending = { sessionId: 'synthetic-session', revision: patch.revision, config: retained };
    const p = port({ manual: true, pending, revisionFloor: patch.revisionFloor,
      hostRecoveryRequired: patch.hostRecoveryRequired, boot: true });
    assert.equal(p.snapshot().pendingRecoveryRequired, true);
    assert.equal(p.snapshot().initialConfig.nodeId, config.nodeId);
    const original = p.files.get('synthetic-result-path').toString();
    const auto = await p.handler(p.event, retained, { close: false });
    assert.equal(auto.writePhase, 'editor-only'); assert.equal(p.writes.length, 0);
    assert.equal(p.files.get('synthetic-result-path').toString(), original);
    const saved = await p.handler(p.event, retained, { close: true });
    assert.equal(saved.writePhase, 'write-reported');
    assert.equal(JSON.parse(p.writes[0].data).revision, Math.max(patch.revision, patch.revisionFloor) + 1);
  }
});

test('fresh recovery generation starts from supplied pending input, keeps explicit-save intent and does not auto-publish', async () => {
  const p = port({ manual: true, hostRecoveryRequired: true, inputIsPending: true, boot: true });
  assert.equal(p.snapshot().pendingRecoveryRequired, true);
  assert(p.snapshot().recoveryNote.includes('Retained edits are shown for review'));
  const reply = await p.handler(p.event, config, { close: false });
  assert.equal(reply.writePhase, 'editor-only'); assert.equal(p.writes.length, 0);
});

test('editor-only response cannot claim a manual save or resolve an earlier uncertain write', () => {
  const o = observer(); o.begin('automatic').reject(Error('Synthetic earlier uncertain publication'));
  o.begin('automatic').resolve({ ok: true, writePhase: 'editor-only', closeScheduled: false });
  assert.equal(o.snapshot().outcome, 'editor-only'); assert(o.snapshot().unconfirmedDetail);
  const html = render(o.snapshot()); assert(html.includes('no pending file write was requested'));
  assert(html.includes('earlier write outcome remains unconfirmed'));
  const manual = observer(); manual.begin('apply-and-close').resolve({ ok: true, writePhase: 'editor-only', closeScheduled: false });
  assert.equal(manual.snapshot().outcome, 'unconfirmed');
});


test('actual Main publishers respect distinct supplied generation paths and cannot replace the new generation through an older window', async () => {
  const files = new Map();
  const older = port({ manual: true, resultFile: 'synthetic-generation-old/result.json', sessionId: 'synthetic-old', sharedFiles: files });
  const newer = port({ manual: true, resultFile: 'synthetic-generation-new/result.json', sessionId: 'synthetic-new',
    hostRecoveryRequired: true, boot: true, sharedFiles: files });
  await newer.handler(newer.event, { ...config, nodeId: 'synthetic-new-edit' }, { close: true });
  const published = files.get('synthetic-generation-new/result.json').toString();
  assert.equal(JSON.parse(published).sessionId, 'synthetic-new');
  const background = await older.handler(older.event, config, { close: false });
  assert.equal(background.writePhase, 'editor-only'); assert.equal(older.writes.length, 0);
  await older.handler(older.event, { ...config, nodeId: 'synthetic-old-edit' }, { close: true });
  assert.equal(JSON.parse(files.get('synthetic-generation-old/result.json').toString()).sessionId, 'synthetic-old');
  assert.equal(files.get('synthetic-generation-new/result.json').toString(), published);
  assert.equal(older.descriptors.size + newer.descriptors.size, 0);
  // This exercises the consumer path only; native generation allocation is uncompiled.
});
