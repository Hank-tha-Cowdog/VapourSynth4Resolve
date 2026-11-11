// Actual App rail constant only; no App initialization, hooks, IPC or browser execution.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const server = require('react-dom/server');
const icons = require(path.join(__dirname, '../node_modules/lucide-react'));
const source = path.join(__dirname, '../src/App.tsx');
const ast = ts.createSourceFile(source, fs.readFileSync(source, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = ast.statements.filter(ts.isVariableStatement).flatMap(node => [...node.declarationList.declarations]);
const matches = declarations.filter(node => ts.isIdentifier(node.name) && node.name.text === 'CollapsedChatRail');
assert.equal(matches.length, 1, 'Use exactly the actual App rail constant');
assert(ts.isArrowFunction(matches[0].initializer));
const compiled = ts.transpileModule(`const CollapsedChatRail = ${matches[0].initializer.getText(ast)}; module.exports = CollapsedChatRail;`, {
  fileName: 'collapsed-chat-rail.tsx',
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.React },
}).outputText;
const moduleObject = { exports: {} };
vm.runInNewContext(compiled, { module: moduleObject, exports: moduleObject.exports, React, MessageSquare: icons.MessageSquare,
  require() { assert.fail('No App services may load'); },
  window: new Proxy({}, { get() { throw Error('No bridge/browser access'); } }),
}, { filename: `${source}:CollapsedChatRail`, timeout: 1000 });
const Rail = moduleObject.exports;

test('chat rail exposes a labelled native button and preserves the existing expansion callback', () => {
  let expanded = 0;
  const tree = Rail({ onExpand() { expanded++; } });
  assert.equal(tree.type, 'button'); assert.equal(tree.props.type, 'button');
  assert.equal(tree.props['aria-label'], 'Open Skippy'); assert.equal(tree.props['aria-expanded'], false);
  assert.notEqual(tree.props.disabled, true); assert.equal(tree.props.onKeyDown, undefined);
  tree.props.onClick(); assert.equal(expanded, 1);
});

test('real React static rail markup retains its name and source-sized target', () => {
  const html = server.renderToStaticMarkup(React.createElement(Rail, { onExpand() { assert.fail('No action during rendering'); } }));
  assert.match(html, /^<button type="button"/);
  assert(html.includes('aria-label="Open Skippy"') && html.includes('aria-expanded="false"'));
  assert(html.includes('min-width:44px') && html.includes('min-height:44px'));
  assert(!html.includes('disabled') && !html.includes('outline:none'));
});
