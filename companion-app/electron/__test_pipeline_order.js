// Actual PipelinePanel and pure presentation dependencies, synthetic chains and
// React SSR only. ChainEditor reference uses selected pure ordering statements;
// no full editor/App, Electron, native composer, media, provider or bridge loads.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const server = require('react-dom/server');
const icons = require(path.join(__dirname, '../node_modules/lucide-react'));
const root = path.join(__dirname, '../src');
const forbidden = () => assert.fail('No actual App/editor/native/bridge/timer/provider operation');
function load(file, imports, extra = '') {
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8') + extra, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.React, esModuleInterop: true },
  }).outputText, { module, exports: module.exports,
    require(name) { assert(Object.hasOwn(imports, name), `Unadmitted presentation import: ${name}`); return imports[name]; },
    window: new Proxy({}, { get: forbidden }), setTimeout: forbidden, setInterval: forbidden,
  }, { timeout: 1000 });
  return module.exports;
}
const types = load('types.ts', {});
const colors = load('services/color-heuristic.ts', {});
const modes = load('services/source-mode.ts', {});
const playbooks = load('services/stage-playbooks.ts', {
  '../../shared/stage-playbooks.json': JSON.parse(fs.readFileSync(path.join(__dirname, '../shared/stage-playbooks.json'), 'utf8')),
});
const badge = load('components/OCIOBadge.tsx', { react: React });
// Real shared draft-composer (pure; no deps) — PipelinePanel's live-step
// gating uses isStepApproved (content-bound approval, 2026-11-11).
const draftComposer = (() => {
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../shared/draft-composer.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.React, esModuleInterop: true },
  }).outputText, { module, exports: module.exports,
    require(name) { assert.fail(`Unadmitted shared dependency: ${name}`); },
  }, { timeout: 1000 });
  return module.exports;
})();
const { PipelinePanel, FilterBlock } = load('components/PipelinePanel.tsx', {
  react: React, 'lucide-react': icons, '../types': types, './OCIOBadge': badge,
  '../services/color-heuristic': colors, '../services/source-mode': modes, '../services/stage-playbooks': playbooks,
  '../../shared/draft-composer': draftComposer,
}, '\nexport { FilterBlock };');
const editorAst = ts.createSourceFile('ChainEditor.tsx', fs.readFileSync(path.join(root, 'components/ChainEditor.tsx'), 'utf8'),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function nodes(predicate) {
  const result = [];
  function visit(n) { if (predicate(n)) result.push(n); ts.forEachChild(n, visit); }
  visit(editorAst); return result;
}
function one(items) { assert.equal(items.length, 1); return items[0]; }
const declaration = name => one(nodes(n => ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name));
const numbering = one(nodes(n => ts.isExpressionStatement(n) && ts.isCallExpression(n.expression)
  && n.expression.expression.getText(editorAst) === 'sorted.forEach'
  && n.getText(editorAst).includes('stepNumberById.set')));
function editorOrder(chain, manualOrder) {
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(`const sorted = ${declaration('sorted').initializer.getText(editorAst)};
    const stepNumberById = ${declaration('stepNumberById').initializer.getText(editorAst)};
    ${numbering.getText(editorAst)}\nmodule.exports = { sorted, stepNumberById };`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, { module, chain, manualOrder, require: forbidden }, { timeout: 1000 });
  return module.exports;
}
const step = (id, stage, patch = {}) => Object.freeze({ id, type: 'script', stage, enabled: true,
  approved: true, approvedContent: 'clip = source\n', version: 1,
  params: Object.freeze({ label: `pipeline-fixture-${id}`, code: 'clip = source' }), ...patch });
// 'early-A' carries a LEGACY flag with no binding (approved undefined /
// approvedContent null): content-bound approval fails closed, so it is NOT a
// live step. 'draft' is explicitly unapproved. Everything else is bound.
const chain = Object.freeze([
  step('late-A', 90), step('early-A', 10, { approved: undefined, approvedContent: null }),
  step('disabled', 20, { enabled: false }), step('early-B', 10),
  step('draft', 40, { approved: false, approvedContent: null }), step('late-B', 90),
]);
const colorManagement = Object.freeze({ inputColorSpace: 'Rec.709', inputGamma: 'BT.1886',
  outputColorSpace: 'Rec.709', outputGamma: 'BT.1886', ocioConfig: 'synthetic-config' });
const config = (manualOrder, steps = chain) => Object.freeze({ schemaVersion: 1, chain: steps, manualOrder, colorManagement, mix: 1 });
function find(tree, predicate) {
  if (!React.isValidElement(tree)) return [];
  return [...(predicate(tree) ? [tree] : []), ...React.Children.toArray(tree.props.children).flatMap(child => find(child, predicate))];
}
function blocks(value) {
  return find(PipelinePanel({ config: value }), e => e.type === FilterBlock);
}
const positions = value => blocks(value).map(e => [e.props.step.id, e.props.stepNumber]);
const html = value => server.renderToStaticMarkup(React.createElement(PipelinePanel, { config: value }));
function assertRenderedOrder(value, ids) {
  const markup = html(value); let cursor = -1;
  for (const id of ids) {
    const next = markup.indexOf(`pipeline-fixture-${id}`); assert(next > cursor); cursor = next;
  }
  return markup;
}

test('pipeline order default mode uses canonical stages and stable within-stage order; legacy missing approval fails closed', () => {
  for (const manualOrder of [false, undefined]) {
    const value = config(manualOrder);
    assert.deepEqual(positions(value), [['early-B', 2], ['late-A', 5], ['late-B', 6]]);
    assertRenderedOrder(value, ['early-B', 'late-A', 'late-B']);
  }
});

test('pipeline order manual mode preserves cross-stage configured order and rendered step references', () => {
  const value = config(true);
  assert.deepEqual(positions(value), [['late-A', 1], ['early-B', 4], ['late-B', 6]]);
  const markup = assertRenderedOrder(value, ['late-A', 'early-B', 'late-B']);
  for (const number of [1, 4, 6]) assert(markup.includes(`Step ${number}`));
  assert(!markup.includes('pipeline-fixture-disabled') && !markup.includes('pipeline-fixture-draft')
    && !markup.includes('pipeline-fixture-early-A'));
});

test('pipeline order visible ordinals match actual ChainEditor all-step numbering in both modes', () => {
  for (const manualOrder of [false, true]) {
    const reference = editorOrder(chain, manualOrder), actual = blocks(config(manualOrder));
    const expectedIds = Array.from(reference.sorted)
      .filter(s => s.enabled && s.approved === true && s.approvedContent === 'clip = source\n').map(s => s.id);
    assert.deepEqual(actual.map(e => e.props.step.id), expectedIds);
    for (const block of actual) assert.equal(block.props.stepNumber, reference.stepNumberById.get(block.props.step.id));
  }
});

test('pipeline order toggling manual order never sorts or mutates the supplied configuration', () => {
  const before = JSON.stringify(chain);
  assert.equal(blocks(config(true))[0].props.step, chain[0]);
  assert.equal(blocks(config(false))[0].props.step, chain[3]);
  assert.equal(blocks(config(true))[0].props.step, chain[0]);
  assert.equal(JSON.stringify(chain), before); assert(Object.isFrozen(chain));
});

test('pipeline order changing approval or enablement preserves other step identities and all-step ordinals', () => {
  const changed = Object.freeze(chain.map(s => s.id === 'disabled' ? Object.freeze({ ...s, enabled: true })
    : s.id === 'draft' ? Object.freeze({ ...s, approved: true, approvedContent: 'clip = source\n' }) : s));
  assert.deepEqual(positions(config(true, changed)),
    [['late-A', 1], ['disabled', 3], ['early-B', 4], ['draft', 5], ['late-B', 6]]);
  const hiddenFirst = Object.freeze(chain.map(s => s.id === 'late-A' ? Object.freeze({ ...s, enabled: false }) : s));
  assert.deepEqual(positions(config(true, hiddenFirst)), [['early-B', 4], ['late-B', 6]]);
  assert.equal(chain[0].enabled, true); assert.equal(chain[2].enabled, false); assert.equal(chain[4].approved, false);
});

test('pipeline order empty or wholly inactive chains emit no filter blocks in either ordering mode', () => {
  for (const manualOrder of [false, true]) for (const steps of [Object.freeze([]), Object.freeze([
    step('only-disabled', 90, { enabled: false }), step('only-draft', 10, { approved: false }),
  ])]) {
    const value = config(manualOrder, steps), before = JSON.stringify(value);
    assert.deepEqual(positions(value), []);
    const markup = html(value); assert(!markup.includes('pipeline-fixture-'));
    assert.equal(JSON.stringify(value), before);
  }
});
