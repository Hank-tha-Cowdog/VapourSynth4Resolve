// Synthetic UI contracts only: no App, Electron, provider, credential or network imports.
// Handler tests replace hooks; server rendering uses real React. Neither proves browser behavior.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const server = require('react-dom/server');
// Use the installed package's ESM main, as in the accepted static-render checker.
// Its exports.require points at CommonJS .js files under a type:module package.
const icons = require(path.join(__dirname, '../node_modules/lucide-react'));

function load(relative, dependencies) {
  const filename = path.join(__dirname, '../src', relative);
  const module = { exports: {} };
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.React, esModuleInterop: true },
  });
  vm.runInNewContext(compiled.outputText, {
    module, exports: module.exports,
    require(name) {
      assert(Object.hasOwn(dependencies, name), `Unadmitted UI import: ${name}`);
      return dependencies[name];
    },
    window: new Proxy({}, { get() { throw Error('UI test must not access window/bridge'); } }),
  }, { filename, timeout: 1000 });
  return module.exports;
}

const composer = load('services/chat-composer.ts', {});
const constants = load('constants.ts', { 'lucide-react': icons });
const chain = load('services/chain-ops.ts', {});
const spinner = load('components/BrailleSpinner.tsx', { react: React });
const dependencies = {
  react: React, 'lucide-react': icons, './BrailleSpinner': spinner,
  '../constants': constants, '../services/chain-ops': chain,
  '../services/chat-composer': composer,
};
const realComponent = load('components/ArchivistChat.tsx', dependencies).ArchivistChat;
const handlerComponent = load('components/ArchivistChat.tsx', {
  ...dependencies,
  react: { ...React, useRef: () => ({ current: null }), useEffect() {}, useId: () => 'synthetic-composer' },
}).ArchivistChat;
const unexpected = () => assert.fail('Unexpected callback during synthetic UI check');
const props = overrides => ({
  width: 380, isResizing: false, startResizing: unexpected,
  messages: [], isThinking: false, inputValue: 'Synthetic draft',
  setInputValue: unexpected, handleSend: unexpected,
  selectedModel: constants.LLM_MODELS[0], setSelectedModel: unexpected,
  autoApply: false, onSetAutoApply: unexpected, onOpenSettings: unexpected,
  onToggleCollapse: unexpected, onApplyChainEdit: unexpected, onDismissChainEdit: unexpected,
  ...overrides,
});
function find(tree, predicate) {
  if (!React.isValidElement(tree)) return undefined;
  if (predicate(tree)) return tree;
  for (const child of React.Children.toArray(tree.props.children)) {
    const result = find(child, predicate);
    if (result) return result;
  }
}
function keyEvent(overrides = {}) {
  let prevented = 0;
  return {
    event: { key: 'Enter', shiftKey: false, repeat: false,
      nativeEvent: { isComposing: false, keyCode: 13 },
      preventDefault() { prevented++; }, ...overrides },
    prevented: () => prevented,
  };
}
function keyResult(overrides, eventOverrides) {
  let sent = 0;
  const tree = handlerComponent(props({ ...overrides, handleSend() { sent++; } }));
  const input = find(tree, element => element.type === 'textarea');
  assert(input, 'Actual component must expose the composer textarea');
  const key = keyEvent(eventOverrides);
  input.props.onKeyDown(key.event);
  return { sent, prevented: key.prevented() };
}

test('send readiness rejects empty/whitespace and busy drafts without changing the text', () => {
  for (const text of ['', '  \n\t', '\u3000']) assert.equal(composer.canSendChatMessage(text, false), false);
  assert.equal(composer.canSendChatMessage(' ready ', false), true);
  assert.equal(composer.canSendChatMessage(' ready ', true), false);
});

test('actual Enter handler consumes Enter and invokes one local send callback', () => {
  assert.deepEqual(keyResult({}, {}), { sent: 1, prevented: 1 });
});

test('Shift+Enter preserves native newline behavior, including while busy', () => {
  for (const isThinking of [false, true]) {
    assert.deepEqual(keyResult({ isThinking }, { shiftKey: true }), { sent: 0, prevented: 0 });
  }
});

test('IME confirmation preserves composition and never submits', () => {
  assert.deepEqual(keyResult({}, { nativeEvent: { isComposing: true, keyCode: 13 } }),
    { sent: 0, prevented: 0 });
});

test('legacy IME keyCode 229 also preserves native confirmation', () => {
  assert.deepEqual(keyResult({}, { nativeEvent: { isComposing: false, keyCode: 229 } }),
    { sent: 0, prevented: 0 });
});

test('a held Enter key is consumed without resubmitting', () => {
  assert.deepEqual(keyResult({}, { repeat: true }), { sent: 0, prevented: 1 });
});

test('busy and empty composer Enter never invokes the send callback', () => {
  for (const override of [{ isThinking: true }, { inputValue: '' }, { inputValue: ' \n' }]) {
    assert.deepEqual(keyResult(override, {}), { sent: 0, prevented: 1 });
  }
});

test('other keys preserve native editing', () => {
  for (const key of ['a', 'Escape', 'Tab', 'Process']) {
    assert.deepEqual(keyResult({}, { key }), { sent: 0, prevented: 0 });
  }
});

test('the actual button and keyboard share readiness for ready, empty and busy drafts', () => {
  for (const override of [{}, { inputValue: '' }, { inputValue: '   ' }, { isThinking: true }]) {
    // Give Send its own callback identity, distinct from the unexpected-action sentinel.
    const value = props({ ...override, handleSend() {} });
    const tree = handlerComponent(value);
    const button = find(tree, element => element.type === 'button' && element.props.onClick === value.handleSend);
    assert(button, 'Actual Send button must exist');
    assert.equal(button.props.disabled, !composer.canSendChatMessage(value.inputValue, value.isThinking));
    assert.equal(button.props.type, 'button');
    assert.equal(keyResult(override, {}).sent, button.props.disabled ? 0 : 1);
  }
});

test('draft editing still forwards exact text while busy', () => {
  let draft;
  const tree = handlerComponent(props({ isThinking: true, setInputValue: value => { draft = value; } }));
  const input = find(tree, element => element.type === 'textarea');
  assert.notEqual(input.props.disabled, true);
  input.props.onChange({ target: { value: '  Draft\n日本語  ' } });
  assert.equal(draft, '  Draft\n日本語  ');
  assert.notEqual(input.props.style.outline, 'none');
});

for (const [name, override, disabled] of [
  ['ready', {}, false], ['empty', { inputValue: '' }, true],
  ['busy', { isThinking: true }, true],
]) {
  test(`actual React static ${name} markup labels the composer and explains its state`, () => {
    const html = server.renderToStaticMarkup(React.createElement(realComponent, props(override)));
    assert.match(html, /<aside aria-label="Skippy chat"/);
    const textarea = html.match(/<textarea\b[^>]*>/)[0];
    assert.match(textarea, /aria-label="Message Skippy"/);
    const hintId = textarea.match(/aria-describedby="([^"]+)"/)[1];
    assert(html.includes(`<span id="${hintId}"`), 'Description must reference the rendered hint');
    assert.match(html, /aria-label="Skippy model"/);
    assert.match(html, /aria-label="Open provider settings"/);
    assert.match(html, /aria-label="Collapse Skippy chat to the side"/);
    const send = html.match(/<button\b[^>]*>[^<]*(?:Send|Waiting for Skippy)<\/button>/)[0];
    assert.equal(send.includes('disabled=""'), disabled);
    assert(send.includes('min-height:44px'));
    assert(html.includes(name === 'busy' ? 'Waiting for Skippy. You can keep drafting.'
      : 'Enter to send · Shift+Enter for a new line'));
  });
}

test('server rendering escapes a hostile-looking draft as textarea text', () => {
  const inputValue = '</textarea><img src=x onerror="synthetic()">';
  const html = server.renderToStaticMarkup(React.createElement(realComponent, props({ inputValue })));
  assert(!html.includes('<img'));
  assert(html.includes('&lt;/textarea&gt;&lt;img'));
});
