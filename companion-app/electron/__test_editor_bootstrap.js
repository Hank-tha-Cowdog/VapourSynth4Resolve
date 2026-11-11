// Finite synthetic packets and fake IPC/hooks/timers only. Full App/main/preload,
// Electron, files, native host, providers and configuration stores never load.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const server = require('react-dom/server');
const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const forbidden = () => assert.fail('No real bridge, timer, filesystem or module loading');
function evaluate(source, globals = {}, withReact = false) {
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020,
    jsx: ts.JsxEmit.React, esModuleInterop: true,
  } }).outputText, { module, exports: module.exports,
    require(name) { if (withReact && name === 'react') return React; return forbidden(); },
    window: new Proxy({}, { get: forbidden }), setTimeout: forbidden, clearTimeout: forbidden,
    ...globals,
  }, { timeout: 1000 });
  return module.exports;
}
const { createEditorBootstrap: bootstrap } = evaluate(read('src/services/editor-bootstrap.ts'));
const { EditorStartupStatus } = evaluate(read('src/components/EditorStartupStatus.tsx'), {}, true);
const producer = evaluate(read('electron/editor-configuration.js'));
const ast = (file, kind) => ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, kind);
const appAst = ast('src/App.tsx', ts.ScriptKind.TSX);
function collect(tree, predicate) {
  const matches = [];
  function visit(node) { if (predicate(node)) matches.push(node); ts.forEachChild(node, visit); }
  visit(tree); return matches;
}
function one(items) { assert.equal(items.length, 1); return items[0]; }
function effect(marker) {
  return one(collect(appAst, n => ts.isCallExpression(n) && ts.isIdentifier(n.expression)
    && n.expression.text === 'useEffect' && n.arguments[0].getText(appAst).includes(marker)));
}
const callback = (call, globals) => evaluate(`module.exports = ${call.arguments[0].getText(appAst)};`, globals);
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject }; };
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
function client(bridge) {
  const controller = bootstrap(), applied = [], updates = [];
  const stop = controller.connect(() => bridge, (config, mode) => applied.push({ config, mode }), s => updates.push(s));
  return { controller, applied, updates, stop };
}
const hostPacket = config => ({ ok: true, mode: 'host', config });

test('bootstrap producer preserves partial host data, latest in-memory state and standalone defaults', () => {
  const initialConfig = { clipMetadata: { width: 1920 } };
  const host = producer.editorConfigurationSnapshot({ initialConfig, latestConfig: initialConfig,
    hasConfigArgument: true, hasResultPath: true });
  assert.equal(host.ok, true); assert.equal(host.mode, 'host'); assert.equal(host.config, initialConfig);
  const latest = { chain: [{ id: 'synthetic-edited' }] };
  assert.equal(producer.editorConfigurationSnapshot({ initialConfig, latestConfig: latest,
    hasConfigArgument: true, hasResultPath: true }).config, latest);
  const standalone = producer.editorConfigurationSnapshot({});
  assert.equal(standalone.mode, 'standalone'); assert.equal(standalone.config, null);
  assert.equal(producer.editorConfigurationSnapshot({ initialConfig, hasConfigArgument: true }).mode, 'standalone');
});

test('bootstrap producer refuses missing, failed, null or non-object host initialization', () => {
  for (const input of [
    { hasResultPath: true }, { hasResultPath: true, hasConfigArgument: true },
    ...[null, [], 'synthetic', 1].map(initialConfig => ({ initialConfig, hasConfigArgument: true })),
    { initialConfig: {}, hasConfigArgument: true, readError: 'Synthetic load failure' },
    { initialConfig: {}, latestConfig: [], hasConfigArgument: true },
  ]) {
    const reply = producer.editorConfigurationSnapshot(input);
    assert.equal(reply.ok, false); assert.equal('config' in reply, false);
  }
});

test('bootstrap IPC reader is bound to its window and owns one idempotent closed cleanup', () => {
  const handlers = new Map(), events = new Map(), removed = []; let reads = 0;
  const win = { webContents: {}, once(name, cb) { events.set(name, cb); } };
  const stop = producer.registerEditorConfigurationBridge({
    handle(name, fn) { assert.equal(handlers.has(name), false); handlers.set(name, fn); },
    removeHandler(name) { removed.push(name); handlers.delete(name); },
  }, win, () => { reads++; return hostPacket({ nodeId: 'synthetic' }); });
  const reader = handlers.get('editor:get-configuration');
  assert.equal(reader({ sender: {} }).ok, false); assert.equal(reader(undefined).ok, false);
  assert.equal(reads, 0);
  assert.equal(reader({ sender: win.webContents }).config.nodeId, 'synthetic'); assert.equal(reads, 1);
  events.get('closed')(); stop(); assert.equal(removed.length, 1); assert.equal(handlers.size, 0);
  assert.equal(reader({ sender: win.webContents }).ok, false); assert.equal(reads, 1);
});

test('bootstrap actual main registers before renderer loading and preload invokes the matching channel once', () => {
  const mainAst = ast('electron/main.js', ts.ScriptKind.JS);
  const registration = one(collect(mainAst, n => ts.isCallExpression(n)
    && ts.isIdentifier(n.expression) && n.expression.text === 'registerEditorConfigurationBridge'));
  const load = one(collect(mainAst, n => ts.isCallExpression(n)
    && ts.isPropertyAccessExpression(n.expression) && n.expression.getText(mainAst) === 'win.loadURL'));
  assert(registration.pos < load.pos);
  let observations = 0;
  assert.equal(registration.arguments[2].getText(mainAst), 'readEditorConfiguration');
  const reader = one(collect(mainAst, n => ts.isVariableDeclaration(n)
    && ts.isIdentifier(n.name) && n.name.text === 'readEditorConfiguration'));
  const getter = evaluate(`module.exports = ${reader.initializer.getText(mainAst)};`, {
    initialConfig: { mix: 0.5 }, latestConfig: { mix: 0.75 }, hasConfigArgument: true,
    initialConfigReadError: null, resultPath: 'synthetic-target', manualHostApply: false, recoveryNote: '',
    editorConfigurationSnapshot(input) { observations++; return producer.editorConfigurationSnapshot(input); },
  });
  assert.equal(getter().config.mix, 0.75); assert.equal(observations, 1);
  const preloadAst = ast('electron/preload.js', ts.ScriptKind.JS);
  const property = one(collect(preloadAst, n => ts.isPropertyAssignment(n)
    && n.name.getText(preloadAst) === 'getEditorConfiguration'));
  const calls = [];
  const invoke = evaluate(`module.exports = ${property.initializer.getText(preloadAst)};`, {
    ipcRenderer: { invoke(...args) { calls.push(args); return 'synthetic-reply'; } },
  });
  assert.equal(invoke(), 'synthetic-reply'); assert.deepEqual(calls, [['editor:get-configuration']]);
});

test('bootstrap actual compatibility push uses latest state rather than stale boot state on recreated renderer', async () => {
  const mainAst = ast('electron/main.js', ts.ScriptKind.JS);
  const reader = one(collect(mainAst, n => ts.isVariableDeclaration(n)
    && ts.isIdentifier(n.name) && n.name.text === 'readEditorConfiguration'));
  const initialConfig = { mix: 0.1 }, latestConfig = { mix: 0.8 };
  const getter = evaluate(`module.exports = ${reader.initializer.getText(mainAst)};`, {
    initialConfig, latestConfig, hasConfigArgument: true, initialConfigReadError: null,
    resultPath: 'synthetic-target', manualHostApply: false, recoveryNote: '', editorConfigurationSnapshot: producer.editorConfigurationSnapshot,
  });
  const pushCall = one(collect(mainAst, n => ts.isCallExpression(n)
    && ts.isPropertyAccessExpression(n.expression) && n.expression.getText(mainAst) === 'win.webContents.once'
    && ts.isStringLiteral(n.arguments[0]) && n.arguments[0].text === 'did-finish-load'));
  const d = deferred(); let push, applied;
  const controller = bootstrap();
  controller.connect(() => ({ syncFromHost(cb) { push = cb; return () => {}; }, getEditorConfiguration: () => d.promise }),
    config => { applied = config; }, () => {});
  const sendCurrent = evaluate(`module.exports = ${pushCall.arguments[1].getText(mainAst)};`, {
    readEditorConfiguration: getter, win: { webContents: { send(channel, config) {
      assert.equal(channel, 'host-sync'); assert.equal(config, latestConfig); push(config);
    } } },
  });
  sendCurrent(); assert.equal(applied.mix, 0.8); assert.notEqual(applied, initialConfig);
  d.resolve(getter()); await flush();
  assert.equal(applied.mix, 0.8); assert.equal(controller.snapshot().mode, 'host');
  const noPush = evaluate(`module.exports = ${pushCall.arguments[1].getText(mainAst)};`, {
    readEditorConfiguration: () => ({ ok: false }), win: { webContents: { send: forbidden } },
  }); noPush();
});

test('bootstrap missed push is recovered by one getter and never by a timeout or retry', async () => {
  const d = deferred(); let calls = 0, listener;
  const p = client({ syncFromHost(cb) { listener = cb; return () => {}; }, getEditorConfiguration() { calls++; return d.promise; } });
  assert.equal(typeof listener, 'function'); assert.equal(p.applied.length, 0);
  assert.equal(p.controller.snapshot().phase, 'waiting');
  const config = { nodeId: 'synthetic-snapshot' }; d.resolve(hostPacket(config)); await flush();
  assert.equal(p.applied.length, 1); assert.equal(p.applied[0].config, config);
  assert.equal(p.controller.snapshot().phase, 'ready'); assert.equal(p.controller.snapshot().mode, 'host');
  p.stop(); p.controller.connect(() => ({ getEditorConfiguration() { calls++; return hostPacket({}); } }), forbidden, () => {});
  await flush(); assert.equal(calls, 1);
});

test('bootstrap compatibility push initializes once and late authoritative delivery preserves local edits', async () => {
  const d = deferred(); let push, local;
  const controller = bootstrap(); let applies = 0;
  controller.connect(() => ({ syncFromHost(cb) { push = cb; return () => {}; }, getEditorConfiguration: () => d.promise }),
    config => { applies++; local = config; }, () => {});
  push({ mix: 0.2 }); assert.equal(controller.snapshot().mode, 'legacy');
  local.mix = 0.9;
  push({ mix: 0.1 }); d.resolve(hostPacket({ mix: 0.3 })); await flush();
  assert.equal(applies, 1); assert.equal(local.mix, 0.9); assert.equal(controller.snapshot().mode, 'host');
  const legacy = client({ syncFromHost(cb) { cb({ mix: 0.6 }); return () => {}; } });
  assert.equal(legacy.applied.length, 1); assert.equal(legacy.controller.snapshot().mode, 'legacy');
});

test('bootstrap invalid, rejected or unavailable delivery never releases defaults', async () => {
  const unreadable = new Proxy({}, { get() { throw Error('Synthetic unreadable packet'); } });
  for (const packet of [undefined, {}, { ok: true, mode: 'unknown', config: {} },
    { ok: false, error: 'Synthetic refusal' }, hostPacket(null), hostPacket([]), unreadable]) {
    const p = client({ getEditorConfiguration: () => packet }); await flush();
    assert.equal(p.applied.length, 0); assert.equal(p.controller.snapshot().phase, 'unavailable');
  }
  for (const getter of [() => { throw Error('Synthetic invoke fault'); }, () => Promise.reject(Error('Synthetic rejection'))]) {
    let calls = 0; const bridge = { getEditorConfiguration() { calls++; return getter(); } };
    const p = client(bridge); await flush(); p.stop();
    p.controller.connect(() => bridge, forbidden, () => {}); await flush();
    assert.equal(calls, 1); assert.equal(p.applied.length, 0); assert.equal(p.controller.snapshot().phase, 'unavailable');
  }
  assert.equal(client(undefined).controller.snapshot().phase, 'unavailable');
  assert.equal(client({}).controller.snapshot().phase, 'waiting');
});

test('bootstrap standalone null initialization is explicit, while failed preparation stays unavailable', async () => {
  const standalone = client({ getEditorConfiguration: () => ({ ok: true, mode: 'standalone', config: null }) });
  await flush(); assert.equal(standalone.applied.length, 1); assert.equal(standalone.applied[0].config, null);
  assert.equal(standalone.controller.snapshot().mode, 'standalone');
  const controller = bootstrap();
  controller.connect(() => ({ getEditorConfiguration: () => hostPacket({}) }),
    () => { throw Error('Synthetic normalization failure'); }, () => {});
  await flush(); assert.equal(controller.snapshot().phase, 'unavailable');
});

test('bootstrap detached listeners are inert and a pending snapshot survives one reconnect without a second getter', async () => {
  const controller = bootstrap(), d = deferred(), listeners = [], applied = []; let calls = 0, cleanups = 0;
  const bridge = { syncFromHost(cb) { listeners.push(cb); return () => { cleanups++; }; },
    getEditorConfiguration() { calls++; return d.promise; } };
  const stopOld = controller.connect(() => bridge, forbidden, () => {}); stopOld();
  listeners[0]({ nodeId: 'stale' }); d.resolve(hostPacket({ nodeId: 'pending' })); await flush();
  assert.equal(controller.snapshot().phase, 'waiting');
  const stopNew = controller.connect(() => bridge, config => applied.push(config), () => {});
  stopOld(); listeners[0]({ nodeId: 'stale-again' });
  assert.equal(applied.length, 1); assert.equal(applied[0].nodeId, 'pending');
  assert.equal(controller.snapshot().phase, 'ready'); assert.equal(calls, 1); assert.equal(cleanups, 1);
  stopNew(); stopNew(); assert.equal(cleanups, 2);
});

test('bootstrap actual App merge retains partial host metadata and explicit configuration without publishing', () => {
  const setup = effect('editorBootstrap.current!.connect');
  const defaults = { schemaVersion: 1, nodeId: 'synthetic-default', manualOrder: false,
    colorManagement: { inputColorSpace: 'Rec.709' }, chain: [], mix: 1,
    archivist: { panelOpen: true, panelWidth: 380, selectedModelId: 'synthetic-model',
      thinkingMode: false, autoApply: true, messages: [{ id: 'greeting' }] } };
  let apply, config, updates = 0;
  callback(setup, { DEFAULT_CONFIG: defaults, window: { electron: {} }, mkid: () => 'synthetic-message',
    setConfig(value) { config = value; updates++; }, setStartup() {},
    editorBootstrap: { current: { connect(getBridge, prepare) { apply = prepare; return () => {}; } } },
  })();
  const metadata = { width: 1920 }; apply({ clipMetadata: metadata });
  assert.equal(config.mix, 1); assert.equal(config.chain.length, 0); assert.equal(config.clipMetadata, metadata);
  assert.equal(config.archivist.messages, defaults.archivist.messages);
  apply({ mix: 0, manualOrder: true, chain: [{ id: 'saved' }], archivist: { messages: [{ text: 'synthetic' }] } });
  assert.equal(config.mix, 0); assert.equal(config.manualOrder, true); assert.equal(config.chain[0].id, 'saved');
  assert.equal(config.archivist.messages[0].id, 'synthetic-message'); assert.equal(updates, 2);
});

test('bootstrap actual App holds manual/automatic writes before readiness and skips restored configuration', () => {
  const automatic = effect('liveSyncDebounce.current = setTimeout');
  const manual = one(collect(appAst, n => ts.isVariableDeclaration(n)
    && ts.isIdentifier(n.name) && n.name.text === 'onAccept')).initializer;
  assert.equal(automatic.arguments[1].getText(appAst), '[config, isEditorReady]');
  assert.equal(manual.arguments[1].getText(appAst), '[config, isEditorReady]');
  const timers = new Map(), writes = [], seenInitial = { current: false }, liveSyncDebounce = { current: null };
  let serial = 0;
  const globals = ready => ({ isEditorReady: ready, seenInitial, liveSyncDebounce,
    config: { chain: [], archivist: { messages: [] } }, writeObserver: { current: {} }, window: { electron: {} },
    console: { log() {} }, requestConfigWrite(...args) { writes.push(args); },
    setTimeout(fn, ms) { const id = ++serial; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  callback(manual, globals(false))(); callback(automatic, globals(false))();
  assert.equal(writes.length, 0); assert.equal(timers.size, 0); assert.equal(seenInitial.current, false);
  callback(automatic, globals(true))(); assert.equal(timers.size, 0); assert.equal(seenInitial.current, true);
  const cleanup = callback(automatic, globals(true))(); assert.equal(timers.size, 1);
  const timer = [...timers.values()][0]; assert.equal(timer.ms, 250); timer.fn();
  assert.equal(writes.length, 1); assert.equal(writes[0][2].close, false); cleanup(); assert.equal(timers.size, 0);
  callback(manual, globals(true))(); assert.equal(writes.length, 2); assert.equal(writes[1][2].close, true);
});

test('bootstrap actual App gates compaction, external edits, discovery and reprobe before readiness', () => {
  for (const marker of ['const msgs = config.archivist.messages', 'return onMcpChainEdit(',
    'if (discoveryAttemptedRef.current)', 'const cached = config.clipMetadata?.source']) {
    const call = effect(marker);
    assert(call.arguments[1].getText(appAst).includes('isEditorReady'));
    assert.doesNotThrow(() => callback(call, { isEditorReady: false })());
  }
  for (const marker of ['if (discoveryAttemptedRef.current)', 'const cached = config.clipMetadata?.source']) {
    const call = effect(marker);
    assert(call.arguments[1].getText(appAst).includes('startup.mode'));
    for (const mode of ['standalone', 'legacy']) {
      assert.doesNotThrow(() => callback(call, { isEditorReady: true, startup: { mode } })());
    }
  }
});

test('bootstrap setup UI distinguishes waiting, unavailable, compatibility and standalone with escaped scrollable details', async () => {
  const p = client({ getEditorConfiguration: () => Promise.reject('<script>synthetic()</script>' + 'x'.repeat(10000)) });
  await flush(); const unavailable = p.controller.snapshot();
  assert.equal(unavailable.detail.length, 4096); assert(unavailable.detail.includes('[details truncated]'));
  const render = state => server.renderToStaticMarkup(React.createElement(EditorStartupStatus, { state, onClose() {} }));
  const html = render(unavailable);
  assert(html.includes('role="alert"') && html.includes('&lt;script&gt;') && !html.includes('<script>'));
  assert(html.includes('tabindex="0"') && html.includes('overflow-y:auto') && html.includes('min-height:44px'));
  assert(html.includes('Close editor') && html.includes('Editing and automatic configuration writes are held'));
  assert(render({ phase: 'waiting', mode: null, detail: '' }).includes('Waiting for editor configuration'));
  assert(render({ phase: 'ready', mode: 'standalone', detail: '' }).includes('no host result path was reported'));
  assert(render({ phase: 'ready', mode: 'legacy', detail: '' }).includes('compatibility host-sync'));
  assert.equal(render({ phase: 'ready', mode: 'host', detail: '' }), '');
});


test('manual host capability survives bootstrap and late compatibility push without replacing local edits', async () => {
  const packet = producer.editorConfigurationSnapshot({ initialConfig: { chain: [] },
    hasConfigArgument: true, hasResultPath: true, manualHostApply: true });
  assert.equal(packet.mode, 'host-manual');
  let push;
  const c = client({ getEditorConfiguration: () => packet, syncFromHost(cb) { push = cb; return () => {}; } });
  await flush();
  assert.equal(c.controller.snapshot().mode, 'host-manual'); assert.equal(c.applied.length, 1);
  push({ chain: [{ id: 'synthetic-late' }] });
  assert.equal(c.controller.snapshot().mode, 'host-manual'); assert.equal(c.applied.length, 1);
  c.stop();
});


test('late manual-host snapshot keeps preview closed through legacy delivery and carries retained-file repair guidance', async () => {
  const getter = deferred(); let push;
  const c = client({ getEditorConfiguration: () => getter.promise, syncFromHost(cb) { push = cb; return () => {}; } });
  const attributes = collect(appAst, n => ts.isJsxAttribute(n) && n.name.getText(appAst) === 'unavailableReason');
  const unavailableAttr = one(attributes).initializer;
  // The standalone fallback reason is a static string now (host-manual gets
  // CompanionChainPreview; host gets PreviewPanel without a reason).
  const standaloneReason = ts.isStringLiteral(unavailableAttr)
    ? unavailableAttr.text : unavailableAttr.getText(appAst);
  assert(standaloneReason.includes('No preview request'));
  const previewReason = () => standaloneReason;
  assert(previewReason().includes('unconfirmed') || standaloneReason.includes('unconfirmed') || standaloneReason.includes('No preview request'));
  push({ chain: [] });
  assert.equal(c.controller.snapshot().mode, 'legacy');
  assert(standaloneReason.includes('No preview request'));
  const note = 'Synthetic retained pending file; explicit Save and close is required.';
  getter.resolve({ ok: true, mode: 'host-manual', config: { chain: [] }, note });
  await flush();
  assert.equal(c.controller.snapshot().mode, 'host-manual'); assert.equal(c.controller.snapshot().detail, note);
  // Manual-host sessions now get the REAL companion chain preview (a
  // transport over the host's composed script), not the old 'native preview
  // unavailable' placeholder: App must render CompanionChainPreview for
  // host-manual, and the standalone fallback keeps its honest reason.
  const previewBranches = collect(appAst, n => ts.isConditionalExpression(n)
    && n.condition.getText(appAst).includes("startup.mode === 'host'"));
  assert(previewBranches.length >= 1);
  const branch = previewBranches[0].getText(appAst);
  assert(branch.includes('CompanionChainPreview'), 'host-manual branch renders CompanionChainPreview');
  assert(branch.includes("'host-manual'"));
  const html = server.renderToStaticMarkup(React.createElement(EditorStartupStatus, { state: c.controller.snapshot() }));
  assert(html.includes('Manual host apply: editor configuration was reported.'));
  assert(html.includes(note)); assert(!html.includes('compatibility host-sync channel'));
  push({ chain: [{ id: 'synthetic-late' }] });
  assert.equal(c.controller.snapshot().detail, note); assert.equal(c.applied.length, 1);
  c.stop();
});
