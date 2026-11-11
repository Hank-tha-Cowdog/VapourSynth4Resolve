// Synthetic saved IDs, fake hooks/callbacks and actual React SSR only.
// No App module, Electron, provider, credential, endpoint or network modules load.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const server = require('react-dom/server');
const icons = require(path.join(__dirname, '../node_modules/lucide-react'));
const root = path.join(__dirname, '..');
const forbidden = () => assert.fail('No actual bridge/provider/storage/timer/module operation');
function evaluate(source, globals = {}, imports = {}) {
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020,
    jsx: ts.JsxEmit.React, esModuleInterop: true,
  } }).outputText, { module, exports: module.exports,
    require(name) { assert(Object.hasOwn(imports, name), `Unadmitted import: ${name}`); return imports[name]; },
    window: new Proxy({}, { get: forbidden }), setTimeout: forbidden, clearTimeout: forbidden,
    ...globals,
  }, { timeout: 1000 });
  return module.exports;
}
const read = file => fs.readFileSync(path.join(root, 'src', file), 'utf8');
const load = (file, deps) => evaluate(read(file), {}, deps);
const constants = load('constants.ts', { 'lucide-react': icons });
const deps = { react: React, 'lucide-react': icons,
  './BrailleSpinner': load('components/BrailleSpinner.tsx', { react: React }),
  '../constants': constants, '../services/chain-ops': load('services/chain-ops.ts', {}),
  '../services/chat-composer': load('services/chat-composer.ts', {}),
};
const RealChat = load('components/ArchivistChat.tsx', deps).ArchivistChat;
const HandlerChat = load('components/ArchivistChat.tsx', { ...deps,
  react: { ...React, useRef: () => ({ current: null }), useEffect() {}, useId: () => 'synthetic-model-hint' },
}).ArchivistChat;
const appAst = ts.createSourceFile('App.tsx', read('App.tsx'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function nodes(predicate) {
  const result = [];
  function visit(n) { if (predicate(n)) result.push(n); ts.forEachChild(n, visit); }
  visit(appAst); return result;
}
function one(items) { assert.equal(items.length, 1); return items[0]; }
const declaration = name => one(nodes(n => ts.isVariableDeclaration(n)
  && ts.isIdentifier(n.name) && n.name.text === name));
const expression = (node, globals) => evaluate(`module.exports = ${node.getText(appAst)};`, globals);
const selectedModel = config => expression(declaration('selectedModel').initializer, { config, LLM_MODELS: constants.LLM_MODELS });
const known = constants.LLM_MODELS.find(m => m.provider === 'ollama');
assert(known && known !== constants.LLM_MODELS[0]);
const configuration = id => ({ chain: [], colorManagement: {}, mix: 0.7,
  archivist: { selectedModelId: id, autoApply: false, messages: [] } });
const props = overrides => ({ width: 380, isResizing: false, startResizing: forbidden,
  messages: [], isThinking: false, requestUncertain: false, inputValue: 'Synthetic draft',
  setInputValue: forbidden, handleSend: forbidden, selectedModel: known, setSelectedModel: forbidden,
  autoApply: false, onSetAutoApply: forbidden, onOpenSettings: forbidden, onToggleCollapse: forbidden,
  onApplyChainEdit: forbidden, onDismissChainEdit: forbidden, ...overrides });
function find(tree, predicate) {
  if (!React.isValidElement(tree)) return;
  if (predicate(tree)) return tree;
  for (const child of React.Children.toArray(tree.props.children)) {
    const found = find(child, predicate); if (found) return found;
  }
}
function key(shiftKey = false) {
  let prevented = 0;
  return { event: { key: 'Enter', shiftKey, repeat: false,
    nativeEvent: { isComposing: false, keyCode: 13 }, preventDefault() { prevented++; } },
    prevented: () => prevented };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

test('model selection actual configuration expression follows restored and later chosen IDs without fallback', () => {
  assert.equal(selectedModel(configuration(constants.LLM_MODELS[0].id)), constants.LLM_MODELS[0]);
  assert.equal(selectedModel(configuration(known.id)), known);
  for (const id of ['synthetic/removed-model', '', undefined]) assert.equal(selectedModel(configuration(id)), null);
  assert.equal(selectedModel(configuration(known.id)), known, 'Recompute from config after delivery, no separate state');
});

test('model selection actual picker callback updates only the configuration and selects its catalog entry', () => {
  const attribute = one(nodes(n => ts.isJsxAttribute(n) && n.name.getText(appAst) === 'setSelectedModel'));
  let config = configuration('synthetic/removed-model'); const previous = config;
  const choose = expression(attribute.initializer.expression, { setConfig(update) { config = update(config); } });
  choose(known);
  assert.equal(config.archivist.selectedModelId, known.id); assert.equal(selectedModel(config), known);
  assert.equal(config.mix, previous.mix); assert.equal(config.chain, previous.chain);
  assert.equal(config.archivist.messages, previous.archivist.messages);
  assert.equal(previous.archivist.selectedModelId, 'synthetic/removed-model');
});

test('model selection unavailable model blocks actual App send before draft, turn state or provider effects', () => {
  const active = { current: false };
  const send = expression(declaration('onSendChat').initializer.arguments[0], {
    selectedModel: null, chatInput: 'Synthetic retained draft', chatTurnActive: active,
    setChatInput: forbidden, setConfig: forbidden, setChatTurnUncertain: forbidden, streamArchivist: forbidden,
  });
  send(); assert.equal(active.current, false);
});

test('model selection actual App send forwards the restored model ID exactly once through a fake port', async () => {
  const requests = [], active = { current: false }; let draft = 'Synthetic draft'; let config = configuration(known.id), serial = 0;
  const send = expression(declaration('onSendChat').initializer.arguments[0], {
    selectedModel: selectedModel(config), chatInput: draft, chatTurnActive: active, config,
    setChatTurnUncertain() {}, setIsThinking() {}, setChatInput(value) { draft = value; },
    setConfig(update) { config = update(config); }, mkid: prefix => `${prefix}-${++serial}`,
    buildArchivistSystemPrompt: () => 'Synthetic system',
    registeredNamespaces: null,
    neuralCapability: null,
    streamArchivist(args) { requests.push(args); return { done: Promise.resolve() }; },
  });
  send(); assert.equal(requests.length, 1); assert.equal(requests[0].modelId, known.id);
  assert.equal(draft, ''); assert.equal(config.archivist.messages.length, 2); await flush();
  assert.equal(active.current, false);
});

test('model selection compaction refuses an unavailable model and forwards a known ID only to a fake summary', async () => {
  const effect = one(nodes(n => ts.isCallExpression(n) && ts.isIdentifier(n.expression)
    && n.expression.text === 'useEffect' && n.arguments[0].getText(appAst).includes('const msgs = config.archivist.messages')));
  assert(effect.arguments[1].getText(appAst).includes('selectedModel?.id'));
  expression(effect.arguments[0], { isEditorReady: true, selectedModel: null, summarizeMessages: forbidden })();
  const calls = [], lock = { current: false }; let config = configuration(known.id);
  config.archivist.messages = [{ id: 'old', text: 'Synthetic old' }, { id: 'tail', text: 'Synthetic retained' }];
  expression(effect.arguments[0], { isEditorReady: true, selectedModel: known, isThinking: false,
    config, COMPACTION_THRESHOLD: 2, KEEP_RECENT: 1, compactionLock: lock,
    summarizeMessages(head, id) { calls.push({ head, id }); return Promise.resolve('Synthetic summary'); },
    mkid: () => 'synthetic-compaction', setConfig(update) { config = update(config); }, console: { warn: forbidden },
  })();
  await flush(); assert.equal(calls.length, 1); assert.equal(calls[0].id, known.id);
  assert.equal(calls[0].head[0].id, 'old'); assert.equal(config.archivist.messages[0].kind, 'compaction');
  assert.equal(config.archivist.messages[1].id, 'tail'); assert.equal(lock.current, false);
});

test('model selection actual unavailable composer preserves drafts, blocks Enter and leaves Shift Enter native', () => {
  let sends = 0, draft;
  const value = props({ selectedModel: null, handleSend() { sends++; }, setInputValue(text) { draft = text; } });
  const tree = HandlerChat(value), textarea = find(tree, e => e.type === 'textarea');
  const button = find(tree, e => e.type === 'button' && e.props.onClick === value.handleSend);
  assert.equal(button.props.disabled, true);
  const enter = key(); textarea.props.onKeyDown(enter.event);
  assert.equal(sends, 0); assert.equal(enter.prevented(), 1);
  const newline = key(true); textarea.props.onKeyDown(newline.event); assert.equal(newline.prevented(), 0);
  textarea.props.onChange({ target: { value: '  Draft\n日本語  ' } }); assert.equal(draft, '  Draft\n日本語  ');
  const picker = find(tree, e => e.props.onSelect === value.setSelectedModel && 'selected' in e.props);
  const select = picker.type(picker.props); assert.equal(select.props.value, '');
  let chosen; const chooseTree = HandlerChat(props({ selectedModel: null, setSelectedModel(m) { chosen = m; } }));
  const choosing = find(chooseTree, e => typeof e.props.onSelect === 'function' && 'selected' in e.props);
  const chooseSelect = choosing.type(choosing.props);
  chooseSelect.props.onChange({ target: { value: 'synthetic/unknown' } }); assert.equal(chosen, undefined);
  chooseSelect.props.onChange({ target: { value: known.id } }); assert.equal(chosen, known);
});

test('model selection actual known composer can send while busy or uncertain requests still block', () => {
  for (const [override, expected] of [[{}, 1], [{ isThinking: true }, 0], [{ requestUncertain: true }, 0]]) {
    let sent = 0; const value = props({ ...override, handleSend() { sent++; } });
    const tree = HandlerChat(value), enter = key();
    find(tree, e => e.type === 'textarea').props.onKeyDown(enter.event);
    assert.equal(sent, expected); assert.equal(enter.prevented(), 1);
    const button = find(tree, e => e.type === 'button' && e.props.onClick === value.handleSend);
    assert.equal(button.props.disabled, expected === 0);
  }
});

test('model selection actual SSR shows a selected unavailable placeholder, associated guidance and retained draft', () => {
  const html = server.renderToStaticMarkup(React.createElement(RealChat,
    props({ selectedModel: null, inputValue: '<synthetic draft>' })));
  const placeholder = html.match(/<option\b[^>]*>Choose a model<\/option>/)[0];
  assert(placeholder.includes('disabled=""') && placeholder.includes('selected=""') && placeholder.includes('value=""'));
  assert.equal((html.match(/selected=""/g) || []).length, 1);
  assert(html.includes('Saved model unavailable in this build.') && html.includes('Your draft is kept.'));
  assert(html.includes('&lt;synthetic draft&gt;'));
  const textarea = html.match(/<textarea\b[^>]*>/)[0], hint = textarea.match(/aria-describedby="([^"]+)"/)[1];
  assert(html.includes(`<span id="${hint}"`));
  const knownHtml = server.renderToStaticMarkup(React.createElement(RealChat, props({ selectedModel: known })));
  const option = knownHtml.match(new RegExp(`<option[^>]*value="${known.id}"[^>]*>`))[0];
  assert(option.includes('selected=""')); assert(!knownHtml.includes('Choose a model'));
});
