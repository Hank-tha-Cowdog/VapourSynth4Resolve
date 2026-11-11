// Preview presentation only: controlled hook state; effects, timers and IPC never execute.
// React renders the actual returned elements. No image is read and no render request is sent.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const server = require('react-dom/server');
const icons = require(path.join(__dirname, '../node_modules/lucide-react'));
const source = path.join(__dirname, '../src/components/PreviewPanel.tsx');
const ast = ts.createSourceFile(source, fs.readFileSync(source, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = ast.statements.filter(ts.isVariableStatement).flatMap(node => [...node.declarationList.declarations]);
const selected = ['PreviewPanel', 'EmptyState'].map(name => {
  const matches = declarations.filter(node => ts.isIdentifier(node.name) && node.name.text === name);
  assert.equal(matches.length, 1); assert(ts.isArrowFunction(matches[0].initializer));
  return `const ${name} = ${matches[0].initializer.getText(ast)};`;
});
const code = ts.transpileModule(selected.join('\n') + '\nmodule.exports = PreviewPanel;', {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.React },
}).outputText;
const spinnerModule = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/components/BrailleSpinner.tsx'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.React,
    esModuleInterop: true },
}).outputText, { module: spinnerModule, exports: spinnerModule.exports,
  require(name) { assert.equal(name, 'react'); return React; },
}, { timeout: 1000 });
// Real shared draft-composer isStepApproved (content-bound approval) —
// PreviewPanel's live-step gate routes through it. The install register in
// the editor stores the exact emitted body; the fixture below carries a
// matching binding (scriptBody('# synthetic') === '# synthetic\n').
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
const noEffect = () => assert.fail('No bridge, timer, image, or external effect permitted');
function view({ state = { status: 'idle' }, dim = false, periodic = true, empty = false, unavailableReason } = {}) {
  const values = [state, dim, periodic], writes = [], effects = [];
  let hook = 0;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, React,
    useState() {
      const index = hook++; assert(index < 3);
      return [values[index], next => { values[index] = typeof next === 'function' ? next(values[index]) : next;
        writes.push({ index, next: values[index] }); }];
    },
    useRef: value => ({ current: value }), useCallback: callback => callback,
    useEffect: effect => effects.push(effect),
    Sun: icons.Sun, RefreshCw: icons.RefreshCw, AlertCircle: icons.AlertCircle, Pause: icons.Pause, Play: icons.Play,
    BrailleSpinner: spinnerModule.exports.BrailleSpinner,
    window: new Proxy({}, { get: noEffect }),    performance: new Proxy({}, { get: noEffect }),
    setTimeout: noEffect, clearTimeout: noEffect, setInterval: noEffect, clearInterval: noEffect,
    require: noEffect,
    isStepApproved: draftComposer.isStepApproved,
  }, { filename: source, timeout: 1000 });
  const config = { chain: empty ? [] : [{ id: 'synthetic-step', type: 'script', enabled: true, approved: true,
      version: 1, approvedContent: '# synthetic\n', params: { code: '# synthetic' }, stage: 'main' }],
    mix: 1, colorManagement: {} };
  const tree = module.exports({ config, unavailableReason });
  assert.equal(hook, 3); assert.equal(effects.length, 3); assert.equal(writes.length, 0);
  return { tree, writes, effects, html: server.renderToStaticMarkup(tree) };
}
function find(tree, predicate) {
  if (!React.isValidElement(tree)) return [];
  return [...(predicate(tree) ? [tree] : []),
    ...React.Children.toArray(tree.props.children).flatMap(child => find(child, predicate))];
}
const ready = { status: 'ready', dataUrl: 'data:image/png;base64,c3ludGhldGlj', elapsedMs: 250 };
const button = (tree, label) => find(tree, e => e.type === 'button' && e.props['aria-label'] === label)[0];

test('processed-frame dimming is honestly named and never presented as a source comparison', () => {
  const normal = view({ state: ready });
  const dimmed = view({ state: ready, dim: true });
  assert(normal.html.includes('aria-label="Frame preview"'));
  assert(normal.html.includes('Processed single-frame preview'));
  assert(!normal.html.includes('source approx.') && !normal.html.includes('Showing: A') && !normal.html.includes('Showing: B'));
  assert(normal.html.includes('Source comparison is unavailable.') && normal.html.includes('Dimming does not show the original source.'));
  assert(normal.html.includes('opacity:1') && dimmed.html.includes('opacity:0.35'));
  const dimButton = button(normal.tree, 'Dim preview');
  assert.equal(dimButton.props['aria-pressed'], false); assert.equal(dimButton.props.disabled, false);
  assert.equal(button(dimmed.tree, 'Dim preview').props['aria-pressed'], true);
  dimButton.props.onClick(); assert.deepEqual(normal.writes, [{ index: 1, next: true }]);
});

test('single-frame guidance avoids asserting source-route or current playhead identity and future playback delivery', () => {
  const { html } = view({ state: ready });
  assert(html.includes('SINGLE FRAME · NO PLAYBACK'));
  assert(html.includes('Its position may differ from Resolve&#x27;s current playhead.'));
  assert(!html.includes('This image uses the last source frame cached by the effect.'));
  assert(html.includes('last request: 0.25 s') && !html.includes('last render:'));
  assert(!html.includes('TKT-PREV') && !html.includes('3-frame'));
});

test('periodic-refresh switch identifies its narrow scope instead of promising a frozen image', () => {
  for (const periodic of [true, false]) {
    const v = view({ state: ready, periodic });
    const control = button(v.tree, 'Periodic preview refresh');
    assert.equal(control.props['aria-pressed'], periodic); assert.equal(control.props.disabled, false);
    assert(v.html.includes('Chain edits and Render preview can update the image even with periodic refresh off.'));
    assert(!v.html.includes('auto-following') && !v.html.includes('stable A/B reference'));
    if (!periodic) assert(v.html.includes('an in-flight request continues.'));
    control.props.onClick(); assert.deepEqual(v.writes, [{ index: 2, next: !periodic }]);
  }
});

test('timeout keeps the actual diagnostic without inventing a missing-source diagnosis', () => {
  const diagnostic = 'Preview timed out after waiting for the response. Synthetic worker status is unknown.';
  const { html } = view({ state: { status: 'error', error: diagnostic } });
  assert(html.includes('role="alert"') && html.includes('Preview failed') && html.includes(diagnostic));
  assert(html.includes('A timeout alone does not identify the cause.'));
  assert(html.includes('If a source frame is missing, check that VapourSynth is applied'));
  assert(!html.includes('No source frame cached yet') && !html.includes('will auto-update'));
});

test('failure output is escaped, wrapped and given a fallback without discarding reported errors', () => {
  const diagnostic = '<img src=x onerror="synthetic()">\nSynthetic long diagnostic: ' + 'x'.repeat(300);
  const { html } = view({ state: { status: 'error', error: diagnostic } });
  assert(html.includes('&lt;img') && !html.includes('<img src=x'));
  assert(html.includes('x'.repeat(300)) && html.includes('overflow-wrap:anywhere') && html.includes('white-space:pre-wrap'));
  assert(html.includes('aria-label="Preview error details" tabindex="0"') && html.includes('overflow-y:auto'));
  assert(view({ state: { status: 'error', error: '  ' } }).html.includes('The preview request did not complete.'));
});

test('waiting state has one status message, identifies an older displayed frame and disables duplicate render control', () => {
  for (const dataUrl of [undefined, ready.dataUrl]) {
    const v = view({ state: { status: 'rendering', dataUrl } });
    assert.equal((v.html.match(/role="status"/g) || []).length, 1);
    assert(v.html.includes('Waiting for preview…') && !v.html.includes('5–15 s'));
    assert.equal(v.html.includes('Previous preview still shown.'), !!dataUrl);
    const render = find(v.tree, e => e.type === 'button' && e.props.title?.startsWith('Request the current chain'))[0];
    assert.equal(render.props.disabled, true);
  }
});

test('empty preview disables inapplicable controls and gives setup guidance without promising a result', () => {
  const v = view({ empty: true });
  const controls = find(v.tree, e => e.type === 'button'); assert.equal(controls.length, 3);
  for (const control of controls) { assert.equal(control.props.disabled, true); assert.equal(control.props.type, 'button'); }
  assert(v.html.includes('Add, enable and approve a step'));
  assert(v.html.includes('Timeline input needs a frame cached by the effect in Resolve. An identified source file may be read directly.'));
  assert(v.html.includes('This view has no playback or source comparison.'));
});


test('explicit preview-unavailable capability renders guidance and suppresses every automatic scheduling route', () => {
  const v = view({ state: ready, unavailableReason: 'Synthetic native preview hold. Save and close; edits apply to the node automatically.' });
  assert(v.html.includes('Frame preview unavailable'));
  assert(v.html.includes('edits apply to the node automatically.'));
  assert(v.html.includes('No preview request is sent'));
  assert(!v.html.includes('<img') && !v.html.includes('<button'));
  for (const effect of v.effects) assert.equal(effect(), undefined);
  assert.equal(v.writes.length, 0);
});
