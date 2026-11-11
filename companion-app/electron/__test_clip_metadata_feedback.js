// Actual ClipInfoBar declarations with controlled state and React SSR only.
// Picker/probe/drop callbacks are never invoked; no real source metadata, files, services or bridge.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const server = require('react-dom/server');
const icons = require(path.join(__dirname, '../node_modules/lucide-react'));
const source = path.join(__dirname, '../src/components/ClipInfoBar.tsx');
const ast = ts.createSourceFile(source, fs.readFileSync(source, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const selected = [];
for (const s of ast.statements) {
  if (ts.isVariableStatement(s)) for (const d of s.declarationList.declarations)
    selected.push(`const ${d.name.getText(ast)} = ${d.initializer.getText(ast)};`);
  else if (ts.isFunctionDeclaration(s)) selected.push(s.getText(ast));
}
const code = ts.transpileModule(selected.join('\n') + '\nmodule.exports = ClipInfoBar;', {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.React },
}).outputText;
const spinnerModule = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/components/BrailleSpinner.tsx'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.React,
    esModuleInterop: true },
}).outputText, { module: spinnerModule, exports: spinnerModule.exports,
  require(name) { assert.equal(name, 'react'); return React; },
}, { timeout: 1000 });
const forbidden = () => assert.fail('No file picker, probe, drag-drop or external effect permitted');
function view({ busy = false, error = null, metadata, discovery = { status: 'idle' }, onClear = forbidden } = {}) {
  const values = [busy, error, false]; let hook = 0, callbackCount = 0;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, React,
    useState() { assert(hook < 3); return [values[hook++], forbidden]; },
    useRef: () => ({ current: { active: false, uncertain: false } }),
    useCallback(fn) { callbackCount++; return fn; },
    deriveScanVerdict: () => null,
    FileVideo: icons.FileVideo, Activity: icons.Activity, FileQuestion: icons.FileQuestion,
    FileCheck2: icons.FileCheck2, RefreshCw: icons.RefreshCw, X: icons.X, AlertTriangle: icons.AlertTriangle,
    BrailleSpinner: spinnerModule.exports.BrailleSpinner,
    window: new Proxy({}, { get: forbidden }), require: forbidden,
  }, { filename: source, timeout: 1000 });
  const tree = module.exports({ metadata, resolveDiscovery: discovery, onSourceProbed: forbidden, onSourceCleared: onClear });
  assert.equal(hook, 3); assert.equal(callbackCount, 3);
  return { tree, html: server.renderToStaticMarkup(tree) };
}
function find(tree, predicate) {
  if (!React.isValidElement(tree)) return [];
  return [...(predicate(tree) ? [tree] : []),
    ...React.Children.toArray(tree.props.children).flatMap(child => find(child, predicate))];
}

test('absent metadata is an honest unavailable state with the opt-in identification control still visible', () => {
  const v = view();
  assert(v.html.includes('No clip metadata available.') && v.html.includes('Identify source…'));
  assert(!v.html.includes('Reading clip metadata') && !v.html.includes('role="status"'));
  const controls = find(v.tree, e => e.type === 'button'); assert.equal(controls.length, 1);
  assert.equal(controls[0].props.disabled, false); assert.equal(controls[0].props.type, 'button');
});

test('probe errors remain fully visible and escaped even when no source or timeline metadata exists', () => {
  const error = 'Synthetic probe failed: <img src=x onerror="synthetic()">\n' + 'diagnostic '.repeat(50);
  for (const metadata of [undefined, { timeline: { width: 1920, height: 1080 } }]) {
    const v = view({ error, metadata });
    assert(v.html.includes('role="alert"') && v.html.includes('diagnostic '.repeat(50)));
    assert(v.html.includes('&lt;img') && !v.html.includes('<img src=x'));
    assert(v.html.includes('overflow-wrap:anywhere') && v.html.includes('white-space:pre-wrap'));
    assert(v.html.includes('aria-label="Source identification error details" tabindex="0"') && v.html.includes('overflow-y:auto'));
    assert(v.html.includes('Identify source…'));
  }
});

test('identification progress remains exposed with absent metadata and disables its action', () => {
  const v = view({ busy: true });
  assert(v.html.includes('role="status"') && v.html.includes('Identifying source…'));
  assert.equal(find(v.tree, e => e.type === 'button')[0].props.disabled, true);
  assert(v.html.includes('No clip metadata available.'));
});

test('actual discovery flags control feedback without an indefinite reading claim or permission-change instruction', () => {
  const pending = view({ discovery: { status: 'discovering' } });
  assert(pending.html.includes('role="status"') && pending.html.includes('Asking Resolve…'));
  const unavailable = view({ discovery: { status: 'scripting-disabled', message: 'Synthetic unavailable' } });
  assert(unavailable.html.includes('Automatic source discovery is unavailable. Use Identify source to choose a file.'));
  assert(unavailable.html.includes('Identify source…') && !unavailable.html.includes('External Scripting → Local'));
  for (const status of ['no-clip', 'unknown-failure']) {
    const message = 'Synthetic discovery diagnostic: ' + 'detail '.repeat(80);
    const v = view({ discovery: { status, message } });
    assert(v.html.includes(message) && v.html.includes('role="status"'));
    assert(!v.html.includes('Reading clip metadata'));
  }
});

test('existing source actions have accessible native names and preserve the local clear callback', () => {
  const cleared = [];
  const metadata = { source: { fileName: 'synthetic.mov', filePath: '', video: {} } };
  const v = view({ metadata, onClear: (...args) => cleared.push(args) });
  const controls = find(v.tree, e => e.type === 'button'); assert.equal(controls.length, 2);
  assert.deepEqual(controls.map(c => c.props['aria-label']), ['Identify a different source file', 'Forget source file']);
  for (const control of controls) assert.equal(control.props.type, 'button');
  controls[1].props.onClick(); assert.deepEqual(cleared, [[]]);
  const busy = view({ metadata, busy: true });
  for (const control of find(busy.tree, e => e.type === 'button')) assert.equal(control.props.disabled, true);
});
