// Pure UI reconciliation + controlled actual ChainEditor wiring, not mounted React/browser proof.
// Editor/filter panels are inert fixtures; no CodeMirror, backend, provider or approval execution.
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
    window: new Proxy({}, { get() { throw Error('No bridge/provider access in expansion checks'); } }),
  }, { filename, timeout: 1000 });
  return module.exports;
}
function loadShared(relative, dependencies) {
  const filename = path.join(__dirname, '../shared', relative), module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.React, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports,
    require(name) { assert(Object.hasOwn(dependencies, name), `Unadmitted shared import: ${name}`); return dependencies[name]; },
  }, { filename, timeout: 1000 });
  return module.exports;
}
const model = load('services/chain-expansion.ts', {});
const constants = load('constants.ts', { 'lucide-react': icons });
const types = load('types.ts', {});
// The real draft-composer module (pure; no deps) — the editor's approval
// click and the UI badge both route through isStepApproved/executableTextForStep.
const draftComposer = loadShared('draft-composer.ts', {});
const { reconcileChainExpansion } = model;
const step = (id, stage = 10) => ({ id, type: 'script', stage, enabled: true,
  approved: false, params: { label: id, code: '' } });
const members = value => [...value].sort();

test('known collapsed steps remain collapsed on parameter updates or a new array', () => {
  const expanded = new Set(['b']), known = new Set(['a', 'b']);
  assert.strictEqual(reconcileChainExpansion(expanded, known, ['a', 'b']), expanded);
  assert.equal(expanded.has('a'), false);
});

test('only new IDs auto-expand while known collapsed steps remain collapsed', () => {
  assert.deepEqual(members(reconcileChainExpansion(new Set(['b']), new Set(['a', 'b']), ['a', 'b', 'c'])), ['b', 'c']);
});

test('removed steps are pruned without mutating input sets or IDs', () => {
  const expanded = new Set(['a', 'b']), known = new Set(['a', 'b']), ids = Object.freeze(['b']);
  assert.deepEqual(members(reconcileChainExpansion(expanded, known, ids)), ['b']);
  assert.deepEqual(members(expanded), ['a', 'b']); assert.deepEqual(members(known), ['a', 'b']);
});

test('reordering known IDs does not reopen steps or replace unchanged state', () => {
  const expanded = new Set(['b']);
  assert.strictEqual(reconcileChainExpansion(expanded, new Set(['a', 'b']), ['b', 'a']), expanded);
});

test('an empty chain clears UI expansion and a new ID starts expanded', () => {
  assert.deepEqual(members(reconcileChainExpansion(new Set(['a']), new Set(['a']), [])), []);
  assert.deepEqual(members(reconcileChainExpansion(new Set(), new Set(), ['a'])), ['a']);
});

function findCard(tree, id) {
  if (!React.isValidElement(tree)) return undefined;
  if (tree.props.step?.id === id && typeof tree.props.onToggleExpand === 'function') return tree;
  for (const child of React.Children.toArray(tree.props.children)) {
    const found = findCard(child, id); if (found) return found;
  }
}
function harness(initialChain) {
  let chain = initialChain, expanded, ref, previousDeps, manualOrder = false, writes = 0;
  const effects = [];
  const controlledReact = { ...React,
    useState(initializer) {
      if (expanded === undefined) expanded = initializer();
      return [expanded, update => { expanded = typeof update === 'function' ? update(expanded) : update; }];
    },
    useRef(value) { if (!ref) ref = { current: value }; return ref; },
    useEffect(effect, dependencies) {
      if (!previousDeps || dependencies.some((value, index) => !Object.is(value, previousDeps[index]))) {
        effects.push(effect); previousDeps = dependencies;
      }
    },
  };
  const { ChainEditor } = load('components/ChainEditor.tsx', {
    react: controlledReact, 'lucide-react': icons, '../constants': constants, '../types': types,
    '../services/chain-expansion': model,
    './PythonEditor': { PythonEditor: () => React.createElement('span', { 'data-editor-fixture': 'true' }, 'Synthetic editor') },
    '../filter-panels/QTGMCPanel': { QTGMCPanel() { assert.fail('Native filter panel must not execute'); } },
    './FilterParamsPanel': { FilterParamsPanel: () => React.createElement('span', { 'data-schema-fixture': 'true' }) },
    '../../shared/filter-schemas': { FILTER_SCHEMAS: {}, stepMatchesSchema: () => false },
    '../../shared/draft-composer': draftComposer,
  });
  function render() {
    const props = { chain, manualOrder, setManualOrder() { assert.fail('No mode callback expected'); },
      onChange(next) { writes++; chain = next; } };
    ChainEditor(props);
    for (const effect of effects.splice(0)) effect();
    return ChainEditor({ ...props, chain });
  }
  return { render, card(id) { const card = findCard(render(), id); assert(card, `Missing step ${id}`); return card; },
    chain: () => chain, writes: () => writes, expanded: () => expanded,
    replace(next) { chain = next; }, manual(value) { manualOrder = value; } };
}

test('actual ChainEditor keeps a collapsed card closed through parameter and enabled changes', () => {
  const initial = [step('a'), step('b')], h = harness(initial);
  h.card('a').props.onToggleExpand(); assert.equal(h.card('a').props.isExpanded, false);
  assert.equal(h.writes(), 0, 'Collapsing is UI-only');
  h.card('b').props.onParamsChange({ label: 'b edited', code: '' });
  assert.equal(h.card('a').props.isExpanded, false);
  h.card('b').props.onToggle();
  assert.equal(h.card('a').props.isExpanded, false); assert.equal(h.chain()[1].enabled, false);
  assert.equal(h.writes(), 2); assert.equal(h.chain()[0].approved, false);
  assert.equal(initial[1].enabled, true, 'Source fixture must remain unchanged');
});

test('actual ChainEditor expands additions and reused IDs, pruning removed IDs', () => {
  const h = harness([step('a'), step('b')]); h.card('a').props.onToggleExpand();
  h.replace([...h.chain(), step('c')]);
  assert.equal(h.card('a').props.isExpanded, false); assert.equal(h.card('c').props.isExpanded, true);
  h.card('b').props.onRemove(); h.render();
  assert.equal(h.expanded().has('b'), false);
  h.replace([...h.chain(), step('b')]); assert.equal(h.card('b').props.isExpanded, true);
  assert.equal(h.card('a').props.isExpanded, false);
});

test('actual ChainEditor preserves collapse on reorder and manual-order input changes', () => {
  const h = harness([step('a', 20), step('b', 10)]); h.card('a').props.onToggleExpand();
  h.manual(true); h.replace([...h.chain()].reverse());
  assert.equal(h.card('a').props.isExpanded, false); assert.equal(h.writes(), 0);
  assert.deepEqual(h.chain().map(value => value.id), ['b', 'a']);
});

test('actual card static markup exposes the reconciled disclosure state', () => {
  const h = harness([step('a'), step('b')]); h.card('a').props.onToggleExpand();
  h.replace(h.chain().map(value => ({ ...value, params: { ...value.params } })));
  const html = server.renderToStaticMarkup(h.render());
  assert.equal((html.match(/aria-expanded="false"/g) || []).length, 1);
  assert.equal((html.match(/aria-expanded="true"/g) || []).length, 1);
  assert.equal((html.match(/data-editor-fixture="true"/g) || []).length, 1);
});

// ── SECURITY (security re-review 2026-11-05 → 2026-11-11): approval binds
// executable content — for EVERY executable step type; label-only edits are
// cosmetic and keep approval.
const { isStepApproved, executableTextForStep } = draftComposer;
const bound = (step) => ({ ...step, approvedContent: executableTextForStep(step) });

test('editing an approved script step\'s code resets flag AND binding', () => {
  const approved = bound({ id: 'a', type: 'script', stage: 20, enabled: true,
    approved: true, params: { label: 'a', code: 'clip = clip\n' } });
  const h = harness([approved]);
  assert.equal(isStepApproved(h.chain()[0]), true, 'fixture starts content-bound approved');
  // A code change through the editor must invalidate the approval and the
  // binding (changed content must not reuse stale approval).
  h.card('a').props.onParamsChange({ label: 'a', code: 'clip = core.std.Invert(clip)\n' });
  assert.equal(h.chain()[0].approved, false, 'code edit resets the flag');
  assert.equal(h.chain()[0].approvedContent, null, 'code edit clears the binding');
  assert.equal(isStepApproved(h.chain()[0]), false, 'stale binding never approves');
  // Explicit re-approval binds the NEW content exactly.
  h.card('a').props.onApprove();
  assert.equal(h.chain()[0].approved, true, 'explicit approve works after the reset');
  assert.equal(h.chain()[0].approvedContent, executableTextForStep(h.chain()[0]),
    'approve stores the exact emitted body');
  assert.equal(isStepApproved(h.chain()[0]), true);
});

test('a non-label params change on a code-bearing step resets approval; a label-only edit keeps it', () => {
  const approved = bound({ id: 'a', type: 'script', stage: 20, enabled: true,
    approved: true, params: { code: 'clip = clip\n', label: 'x' } });
  const h = harness([approved]);
  // Non-label parameter change → executable inputs may differ → reset.
  h.card('a').props.onParamsChange({ code: 'clip = clip\n', label: 'x', mode: 'copy' });
  assert.equal(h.chain()[0].approved, false, 'non-label param edits reset approval');
  assert.equal(h.chain()[0].approvedContent, null);
  // A label-only edit is a section-comment change — approval stands.
  const again = bound({ id: 'a', type: 'script', stage: 20, enabled: true,
    approved: true, params: { code: 'clip = clip\n', label: 'x' } });
  const h2 = harness([again]);
  h2.card('a').props.onParamsChange({ code: 'clip = clip\n', label: 'renamed' });
  assert.equal(h2.chain()[0].approved, true, 'label-only edits keep approval');
  assert.equal(isStepApproved(h2.chain()[0]), true);
});

test('QTGMC param edits reset approval (generated Python changed); label-only keeps it', () => {
  const qtg = bound({ id: 'q', type: 'qtgmc', stage: 20, enabled: true,
    approved: true, params: { preset: 'Slower', label: 'q' } });
  const h = harness([qtg]);
  assert.equal(isStepApproved(h.chain()[0]), true, 'fixture starts content-bound approved');
  // Preset/option edits change the emitted call → reset (security review finding:
  // the editor previously retained approval across QTGMC param edits).
  h.card('q').props.onParamsChange({ preset: 'Draft', label: 'q' });
  assert.equal(h.chain()[0].approved, false, 'QTGMC param edit resets approval');
  assert.equal(h.chain()[0].approvedContent, null, 'QTGMC param edit clears the binding');
  assert.equal(isStepApproved(h.chain()[0]), false);
  // Re-approve binds the NEW call; a label-only edit then keeps it.
  h.card('q').props.onApprove();
  assert.equal(isStepApproved(h.chain()[0]), true);
  h.card('q').props.onParamsChange({ preset: 'Draft', label: 'q renamed' });
  assert.equal(isStepApproved(h.chain()[0]), true, 'label-only QTGMC edit keeps approval');
  // But the binding still matches ONLY the exact body — a stale binding fails.
  const stale = { ...h.chain()[0], approvedContent: 'clip = havs.QTGMC(clip, Preset=\'Placebo\', TFF=True, FPSDivisor=2)\n' };
  assert.equal(isStepApproved(stale), false, 'stale binding for different content never approves');
});
