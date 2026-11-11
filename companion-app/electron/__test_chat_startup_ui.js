// Actual composer handlers and React static markup only; no mounted browser or stream.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const server = require('react-dom/server');
const icons = require(path.join(__dirname, '../node_modules/lucide-react'));
function load(relative, dependencies) {
  const filename = path.join(__dirname, '../src', relative), module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.React, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports,
    require(name) { assert(Object.hasOwn(dependencies, name), `Unadmitted UI import: ${name}`); return dependencies[name]; },
    window: new Proxy({}, { get() { throw Error('No bridge/provider in startup presentation check'); } }),
  }, { filename, timeout: 1000 });
  return module.exports;
}
const constants = load('constants.ts', { 'lucide-react': icons });
const deps = { react: React, 'lucide-react': icons, '../constants': constants,
  '../services/chain-ops': load('services/chain-ops.ts', {}),
  '../services/chat-composer': load('services/chat-composer.ts', {}),
  './BrailleSpinner': load('components/BrailleSpinner.tsx', { react: React }) };
const real = load('components/ArchivistChat.tsx', deps).ArchivistChat;
const unexpected = () => assert.fail('No external action expected');
const props = overrides => ({
  width: 380, isResizing: false, startResizing: unexpected, messages: [], isThinking: false,
  requestUncertain: true, inputValue: 'Keep drafting', setInputValue: unexpected, handleSend: unexpected,
  selectedModel: constants.LLM_MODELS[0], setSelectedModel: unexpected, autoApply: false,
  onSetAutoApply: unexpected, onOpenSettings: unexpected, onToggleCollapse: unexpected,
  onApplyChainEdit: unexpected, onDismissChainEdit: unexpected, ...overrides,
});
function find(tree, predicate) {
  if (!React.isValidElement(tree)) return undefined;
  if (predicate(tree)) return tree;
  for (const child of React.Children.toArray(tree.props.children)) {
    const result = find(child, predicate); if (result) return result;
  }
}

test('startup unknown state independently blocks Enter/Send while retaining draft editing', () => {
  const controlled = load('components/ArchivistChat.tsx', { ...deps, react: {
    ...React, useRef: () => ({ current: null }), useEffect() {}, useId: () => 'synthetic-startup',
  } }).ArchivistChat;
  let sent = 0, draft, prevented = 0;
  const send = () => { sent++; };
  const tree = controlled(props({ handleSend: send, setInputValue: value => { draft = value; } }));
  const input = find(tree, element => element.type === 'textarea');
  const button = find(tree, element => element.type === 'button' && element.props.onClick === send);
  assert.equal(button.props.disabled, true); assert.equal(button.props.children, 'Waiting for status');
  assert.notEqual(input.props.disabled, true);
  const event = { key: 'Enter', shiftKey: false, repeat: false,
    nativeEvent: { isComposing: false, keyCode: 13 }, preventDefault() { prevented++; } };
  input.props.onKeyDown(event); assert.equal(sent, 0); assert.equal(prevented, 1);
  input.props.onKeyDown({ ...event, shiftKey: true }); assert.equal(prevented, 1);
  input.props.onChange({ target: { value: 'Exact new draft\n日本語' } });
  assert.equal(draft, 'Exact new draft\n日本語');
});

test('startup unknown markup describes uncertainty instead of claiming model activity', () => {
  for (const isThinking of [false, true]) {
    const html = server.renderToStaticMarkup(React.createElement(real, props({ isThinking })));
    assert(html.includes('Request status unknown. Sending is paused.'));
    assert(html.includes('Sending stays blocked until the request is confirmed ended.'));
    assert(html.includes('Waiting for status') && html.includes('role="status"'));
    assert(!html.includes('Skippy is thinking') && !html.includes('aria-label="loading"'));
    const textarea = html.match(/<textarea\b[^>]*>/)[0];
    const id = textarea.match(/aria-describedby="([^"]+)"/)[1];
    assert(html.includes(`id="${id}"`));
  }
});

test('startup known streaming markup retains the normal busy presentation', () => {
  const html = server.renderToStaticMarkup(React.createElement(real, props({ isThinking: true, requestUncertain: false })));
  assert(html.includes('Skippy is thinking') && html.includes('Waiting for Skippy'));
  assert(!html.includes('Request status unknown'));
});
