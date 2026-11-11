// Actual color UI declarations and display helper only. No App lifecycle, native composer or IPC runs.
// Source-mode/metadata adapters are controlled pure fixtures; all settings callbacks are local spies.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const server = require('react-dom/server');
const icons = require(path.join(__dirname, '../node_modules/lucide-react'));
const base = path.join(__dirname, '../src');
const forbidden = () => assert.fail('No parent App, service, window or bridge execution permitted');
function declarations(file, names) {
  const ast = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const selected = [];
  for (const statement of ast.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const d of statement.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && (!names || names.includes(d.name.text)))
          selected.push({ name: d.name.text, text: `const ${d.name.text} = ${d.initializer.getText(ast)};` });
      }
    } else if (ts.isFunctionDeclaration(statement) && (!names || names.includes(statement.name.text))) {
      selected.push({ name: statement.name.text, text: statement.getText(ast) });
    }
  }
  if (names) for (const name of names) assert.equal(selected.filter(s => s.name === name).length, 1);
  return selected.map(s => s.text).join('\n');
}
function evaluate(code, exports, globals = {}) {
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(code + `\nmodule.exports = { ${exports.join(',')} };`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.React },
  }).outputText, { module, exports: module.exports, React, require: forbidden,
    window: new Proxy({}, { get: forbidden }), ...globals }, { timeout: 1000 });
  return module.exports;
}
const { OCIOBadge } = evaluate(declarations(path.join(base, 'components/OCIOBadge.tsx')), ['OCIOBadge']);
const menuModule = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(base, 'services/color-menus.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, { module: menuModule, exports: menuModule.exports, require: forbidden }, { timeout: 1000 });
const { ColorManagementBar } = evaluate(declarations(path.join(base, 'App.tsx'), ['ColorManagementBar', 'GroupedSelect']),
  ['ColorManagementBar'], { OCIOBadge, ...menuModule.exports });
function pipeline(direct = false, mismatch = false) {
  return evaluate(declarations(path.join(base, 'components/PipelinePanel.tsx')), ['PipelinePanel', 'matrixSlug'], {
    OCIOBadge, AlertTriangle: icons.AlertTriangle,
    resolveSourceMode: () => ({ vsLoadsDirectly: direct, mode: direct ? 'active' : 'disabled', rationale: 'Synthetic source-mode fixture' }),
    detectedMatrixLabel: () => 'Synthetic source color label', detectedTransferLabel: () => 'Synthetic source gamma label',
    inferColorDefaults: () => ({ matrixConfident: mismatch, transferConfident: mismatch,
      suggestedMatrix: 'Rec.2020', suggestedTransfer: 'PQ', rationale: 'Synthetic metadata fixture' }),
    stageLabelForNumber: forbidden, playbookForStage: forbidden, stepSummary: forbidden,
  });
}
const cm = { inputColorSpace: 'Rec.601 (625)', inputGamma: 'ST.2084 (PQ)', outputColorSpace: 'Rec.709',
  outputGamma: 'Linear', ocioConfig: 'synthetic-config-label' };
function html(element) { return server.renderToStaticMarkup(element); }
function find(tree, predicate) {
  if (!React.isValidElement(tree)) return [];
  return [...(predicate(tree) ? [tree] : []),
    ...React.Children.toArray(tree.props.children).flatMap(child => find(child, predicate))];
}

test('display matrix agrees with the source composer mapping including PAL625, token order and unsupported fallbacks', () => {
  const { matrixSlug } = pipeline();
  const cases = [
    ['Rec.601 (625)', '470bg'], ['Rec.601 (525)', '170m'], ['Rec.601 PAL', '470bg'], ['Rec.601', '170m'],
    ['BT.470BG', '470bg'], ['smpte240m', '240m'], ['SMPTE170M', '170m'], ['Rec.2020', '2020'],
    ['Rec.2100', '2020'], ['Rec.709-A', '709'], ['sRGB', '709'], ['pal legacy', '470bg'],
    ['Rec.601 PAL 2020', '2020'], ['ARRI Wide Gamut 3', '709 (fallback)'],
    ['ACES AP1', '709 (fallback)'], ['matrix470', '709 (fallback)'],
  ];
  for (const [input, expected] of cases) assert.equal(matrixSlug(input), expected, input);
});

test('capability badge visibly identifies matrix-only conversion and retains limits in compact mode', () => {
  const full = html(React.createElement(OCIOBadge));
  assert(full.includes('Matrix only') && full.includes('OCIO is not integrated'));
  assert(full.includes('Gamma selections are stored labels;'));
  assert(full.includes('Unsupported color-space names fall back to the Rec.709 matrix.'));
  assert(!full.includes('manufacturer-') && !full.includes('Bundled into the OFX plugin'));
  const compact = html(React.createElement(OCIOBadge, { showLabel: false }));
  assert(compact.includes('aria-label="Limited color conversion: OCIO is not integrated"'));
});

test('settings color bar makes gamma limits visible while preserving local selection and Swap arguments', () => {
  const changes = [];
  const tree = ColorManagementBar({ cm, onChange: value => changes.push(value) });
  const rendered = html(tree);
  // The matrix-only limitation moved from a permanent paragraph to a compact
  // contextual-help button (live feedback: the full-width sentence consumed a
  // row). The color-science truth must remain in the rendered markup AND be
  // discoverable: aria-label for screen readers, title for hover/focus.
  assert(rendered.includes('aria-label="Color conversion limits"'));
  assert(rendered.includes('Gamma selections do not apply transfer-function transforms.'));
  assert(rendered.includes('title="Color conversion is limited to RGB/YUV matrices. Gamma selections do not apply transfer-function transforms."'));
  assert(rendered.includes('Input γ (label)') && rendered.includes('Output γ (label)'));
  assert.equal((rendered.match(/<select\b/g) || []).length, 4);
  find(tree, e => e.type === 'button')[0].props.onClick();
  assert.equal(changes.length, 1);
  assert.deepEqual({ ...changes[0] }, { ...cm, inputColorSpace: cm.outputColorSpace, inputGamma: cm.outputGamma,
    outputColorSpace: cm.inputColorSpace, outputGamma: cm.inputGamma });
  const select = find(tree, e => typeof e.type === 'function' && e.props.label === 'Input γ (label)')[0];
  select.props.onChange('synthetic-gamma-label');
  assert.deepEqual({ ...changes[1] }, { ...cm, inputGamma: 'synthetic-gamma-label' });
});

test('pipeline displays matrix and gamma-label behavior without OCIO, output-verification or filter-preservation claims', () => {
  const { PipelinePanel } = pipeline();
  const rendered = html(React.createElement(PipelinePanel, { config: { chain: [], colorManagement: cm } }));
  assert(rendered.includes('OCIO is not integrated and gamma selections do not apply transfer-function transforms.'));
  assert(rendered.includes('configured labels, not measured output pixels.'));
  assert(rendered.includes('470bg') && rendered.includes('pq (not applied)') && rendered.includes('linear (not applied)'));
  assert(rendered.includes('configured output label') && rendered.includes('labels only; no gamma transform'));
  assert.equal((rendered.match(/compare labels →/g) || []).length, 2);
  assert(!rendered.includes('must match →'));
  assert(!rendered.includes('route through OpenColorIO') && !rendered.includes('preserved by filters'));
  assert(!rendered.includes('what timeline expects'));
});

test('source-file diagram identifies YUV normalization instead of advertising future native-format passthrough', () => {
  const { PipelinePanel } = pipeline(true);
  const rendered = html(React.createElement(PipelinePanel, { config: { chain: [], colorManagement: cm } }));
  assert(rendered.includes('Normalize to YUV420P16'));
  assert(!rendered.includes('pass-through (Phase 3)'));
  assert(rendered.includes('Matrix only') && rendered.includes('YUV → RGB (if needed)'));
});

test('metadata mismatch guidance does not claim changing gamma labels applies a transform or guarantees output pixels', () => {
  const { PipelinePanel } = pipeline(false, true);
  const rendered = html(React.createElement(PipelinePanel, { config: { chain: [], colorManagement: cm,
    clipMetadata: { source: { video: {} } } } }));
  assert(rendered.includes('Configured labels differ from source metadata.'));
  assert(rendered.includes('Changing a gamma label does not apply a gamma transform.'));
  assert(rendered.includes('confirm the interpretation in Resolve.'));
  assert(!rendered.includes('wrong-colored data') && !rendered.includes('will produce wrong-looking pixels'));
});
