// Actual ProviderRow + style constants only. No SettingsModal loading/storage effect is evaluated.
// Every input is empty, masks are null, and callbacks are local spies; no credential value is used.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const server = require('react-dom/server');
const icons = require(path.join(__dirname, '../node_modules/lucide-react'));
const source = path.join(__dirname, '../src/components/SettingsModal.tsx');
const ast = ts.createSourceFile(source, fs.readFileSync(source, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = ast.statements.filter(ts.isVariableStatement).flatMap(node => [...node.declarationList.declarations]);
const names = ['inputStyle', 'iconBtnStyle', 'primaryBtn', 'ghostBtn', 'ProviderRow'];
const selected = names.map(name => {
  const matches = declarations.filter(node => ts.isIdentifier(node.name) && node.name.text === name);
  assert.equal(matches.length, 1, `Exactly one actual ${name} required`);
  assert(name === 'ProviderRow' ? ts.isArrowFunction(matches[0].initializer) : ts.isObjectLiteralExpression(matches[0].initializer));
  return `const ${name} = ${matches[0].initializer.getText(ast)};`;
});
const code = ts.transpileModule(selected.join('\n') + '\nmodule.exports = ProviderRow;', {
  fileName: 'provider-row.tsx',
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.React },
}).outputText;
const spinnerPath = path.join(__dirname, '../src/components/BrailleSpinner.tsx');
const spinnerModule = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(spinnerPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.React,
    esModuleInterop: true },
}).outputText, { module: spinnerModule, exports: spinnerModule.exports,
  require(name) { assert.equal(name, 'react'); return React; },
}, { filename: spinnerPath, timeout: 1000 });
function component(useId) {
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, React, useId,
    Check: icons.Check, Key: icons.Key, Globe: icons.Globe, Eye: icons.Eye, EyeOff: icons.EyeOff,
    BrailleSpinner: spinnerModule.exports.BrailleSpinner,
    require() { assert.fail('Provider row must not import storage or services'); },
    window: new Proxy({}, { get() { throw Error('No credential/endpoint bridge access'); } }),
  }, { filename: `${source}:ProviderRow`, timeout: 1000 });
  return module.exports;
}
const Row = component(React.useId);
let id = 0;
const ControlledRow = component(() => `synthetic-row-${id++}`);
const unexpected = () => assert.fail('No settings action expected during render');
const props = (overrides = {}) => ({
  pid: 'synthetic-provider',
  cfg: { label: 'Synthetic Cloud', needsApiKey: true, supportsTools: false,
    defaultEndpoint: 'synthetic endpoint', models: [] },
  row: { keyInput: '', endpointInput: '', masked: null, hasKey: false, showKey: false, saving: 'idle' },
  onUpdate: unexpected, onSave: unexpected, onClear: unexpected, ...overrides,
});
function render(overrides) {
  const p = props(overrides);
  assert.equal(p.row.keyInput, ''); assert.equal(p.row.endpointInput, ''); assert.equal(p.row.masked, null);
  return server.renderToStaticMarkup(React.createElement(Row, p));
}
function row(patch) { return { ...props().row, ...patch }; }
function findAll(tree, predicate) {
  if (!React.isValidElement(tree)) return [];
  return [...(predicate(tree) ? [tree] : []),
    ...React.Children.toArray(tree.props.children).flatMap(child => findAll(child, predicate))];
}

test('full provider error remains visible and associated with both entry fields', () => {
  const message = 'Endpoint URL needs a supported protocol and host. Review the entry, then choose Save again.';
  assert(message.length > 30);
  const html = render({ row: row({ saving: 'error', errorMessage: message }) });
  assert(html.includes(message)); assert(html.includes('Settings need attention:'));
  const alert = html.match(/<p id="([^"]+)" role="alert"/)[1];
  const inputs = html.match(/<input\b[^>]*>/g); assert.equal(inputs.length, 2);
  for (const input of inputs) {
    const described = input.match(/aria-describedby="([^"]+)"/)[1].split(' ');
    assert(described.includes(alert));
    for (const id of described) assert(html.includes(`id="${id}"`));
    assert(!input.includes('aria-invalid'), 'A general storage error must not blame a particular field');
  }
  assert(html.includes('overflow-wrap:anywhere'));
});

test('saved-key guidance explains blank-field retention without filling or revealing a key', () => {
  const html = render({ row: row({ hasKey: true }) });
  assert(html.includes('Key saved') && !html.includes('Configured'));
  assert(html.includes('Leave the API-key field empty to keep the saved key.'));
  assert(html.includes('Use Forget key to remove it.'));
  const input = html.match(/<input[^>]*aria-label="API key for Synthetic Cloud"[^>]*>/)[0];
  assert(input.includes('type="password"') && input.includes('value=""'));
  assert(input.toLowerCase().includes('autocomplete="off"'));
  assert(html.includes('Save stores settings; it does not test the connection.'));
});

test('missing-key guidance gives an explicit entry action and does not claim connectivity', () => {
  const html = render();
  assert(html.includes('No key saved') && html.includes('Enter your own API key, then choose Save.'));
  assert(!html.includes('Configured') && html.includes('does not test the connection'));
});

test('local backend row has endpoint guidance and no key-entry controls', () => {
  const cfg = { ...props().cfg, label: 'Synthetic Local', needsApiKey: false, defaultEndpoint: '' };
  const html = render({ cfg, row: row({ hasKey: true }) });
  assert(html.includes('No key needed') && html.includes('No API key is needed; enter the endpoint URL'));
  assert(!html.includes('aria-label="API key for'));
  assert(!html.includes('Forget saved API key'));
  assert(html.includes('aria-label="Endpoint URL for Synthetic Local"'));
});

test('pending update exposes progress and disables rendered editing and competing actions', () => {
  const p = props({ row: row({ hasKey: true, saving: 'saving' }) });
  const tree = ControlledRow(p);
  const controls = findAll(tree, element => element.type === 'input' || element.type === 'button');
  assert.equal(controls.length, 5); for (const control of controls) assert.equal(control.props.disabled, true);
  const html = render({ row: p.row });
  assert(html.includes('role="status"') && html.includes('Updating settings…'));
  assert(html.includes('aria-label="Updating settings for Synthetic Cloud"'));
});

test('successful stored-settings feedback never claims a tested connection', () => {
  const html = render({ row: row({ saving: 'saved' }) });
  assert(html.includes('role="status"') && html.includes('Settings updated'));
  assert(html.includes('does not test the connection') && !html.includes('Connected'));
  assert(!html.includes('disabled=""'));
});

test('empty error has an actionable fallback and stale error text stays hidden outside error state', () => {
  const error = render({ row: row({ saving: 'error' }) });
  assert(error.includes('The operation did not complete. Review the entries and try again.'));
  const idle = render({ row: row({ errorMessage: 'Synthetic old failure' }) });
  assert(!idle.includes('role="alert"') && !idle.includes('Synthetic old failure'));
  for (const input of idle.match(/<input\b[^>]*>/g)) {
    assert.equal(input.match(/aria-describedby="([^"]+)"/)[1].split(' ').length, 1);
  }
});

test('named Save, Forget and visibility controls preserve callback arguments using empty fields', () => {
  const saved = [], cleared = [], updated = [];
  const p = props({ row: row({ hasKey: true }), onSave: (...args) => saved.push(args),
    onClear: (...args) => cleared.push(args), onUpdate: (...args) => updated.push(args) });
  const tree = ControlledRow(p);
  const button = label => findAll(tree, e => e.type === 'button' && e.props['aria-label'] === label)[0];
  button('Save settings for Synthetic Cloud').props.onClick();
  button('Forget saved API key for Synthetic Cloud').props.onClick();
  const visibility = button('Show entered API key for Synthetic Cloud');
  assert.equal(visibility.props['aria-pressed'], false); visibility.props.onClick();
  assert.deepEqual(saved, [['synthetic-provider']]); assert.deepEqual(cleared, [['synthetic-provider']]);
  assert.equal(updated[0][0], 'synthetic-provider'); assert.equal(updated[0][1].showKey, true);
  assert.deepEqual(Object.keys(updated[0][1]), ['showKey']);
  const shown = ControlledRow(props({ row: row({ showKey: true }) }));
  assert.equal(findAll(shown, e => e.type === 'input' && e.props['aria-label'] === 'API key for Synthetic Cloud')[0].props.type, 'text');
  assert.equal(findAll(shown, e => e.type === 'button' && e.props['aria-pressed'] === true).length, 1);
});

test('multiple providers get unique feedback targets and provider-specific action names', () => {
  const html = server.renderToStaticMarkup(React.createElement(React.Fragment, null,
    React.createElement(Row, props({ row: row({ saving: 'error', errorMessage: 'Synthetic A failure' }) })),
    React.createElement(Row, props({ pid: 'synthetic-b', cfg: { ...props().cfg, label: 'Synthetic B' },
      row: row({ saving: 'error', errorMessage: 'Synthetic B failure' }) }))));
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(ids.length, 6); assert.equal(new Set(ids).size, 6);
  assert(html.includes('Save settings for Synthetic Cloud') && html.includes('Save settings for Synthetic B'));
});

test('error and provider-label text remain escaped in actual React markup', () => {
  const hostile = '<img src=x onerror="synthetic()">';
  const html = render({ cfg: { ...props().cfg, label: `Synthetic ${hostile}` },
    row: row({ saving: 'error', errorMessage: hostile }) });
  assert(!html.includes('<img') && html.includes('&lt;img'));
});
