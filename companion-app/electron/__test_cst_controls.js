// C07 regression (re-review of c11a43d, 2026-11-11): the FIRST structured
// edit of a sparse (freshly added / legacy) CST step used to throw inside
// the strict emitter before onChange could save anything. The panel now
// merges schema defaults beneath the stored params, so every edit operates
// on a COMPLETE set and regenerates a schema-matching script.
//
// Actual FilterParamsPanel component, fake events/state, React SSR through
// direct function invocation. No real UI event, native/filter/provider/
// IPC/media/timer operation: every missing port fails the test.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const icons = require(path.join(__dirname, '../node_modules/lucide-react'));
const forbidden = () => assert.fail('No real UI event, native/filter/provider/IPC/media/timer operation');

function loadShared(relative, dependencies = {}) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', 'shared', relative), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports,
    require(name) { if (name in dependencies) return dependencies[name]; throw new Error(`unadmitted import: ${name}`); },
  }, { timeout: 1000 });
  return module.exports;
}

const cst = loadShared('cst-transform.ts');
const draftComposer = loadShared('draft-composer.ts');
const schemas = loadShared('filter-schemas.ts', { './cst-transform': cst, './draft-composer': draftComposer });

function loadPanel(react) {
  const source = fs.readFileSync(path.join(__dirname, '../src/components/FilterParamsPanel.tsx'), 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.React, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports,
    require(name) {
      if (name === 'react') return react;
      if (name === 'lucide-react') return icons;
      if (name === '../../shared/filter-schemas') return schemas;
      return forbidden();
    },
    window: new Proxy({}, { get: forbidden }), setTimeout: forbidden, setInterval: forbidden,
  }, { timeout: 1000 });
  return module.exports.FilterParamsPanel;
}

function find(tree, predicate) {
  if (!React.isValidElement(tree)) return [];
  return [...(predicate(tree) ? [tree] : []),
    ...React.Children.toArray(tree.props.children).flatMap(child => find(child, predicate))];
}

test('the sparse-step strictness is real: emit() throws without the defaults (C07 premise)', () => {
  // Producing the pre-fix failure: only the edited key passed to the strict
  // emitter — exactly what the panel used to do with a sparse stored step.
  assert.throws(() => cst.emitCstBody({ outTransfer: 'pq' }),
    /input primaries/i, 'strict emitter refuses sparse params — the panel must never send them');
});

test('first structured edit of a SPARSE CST step regenerates a complete, schema-matching script', () => {
  const writes = [];
  const values = [false, null]; // [showAdvanced, focused]
  let hook = 0;
  const Panel = loadPanel({ ...React,
    useMemo: (fn) => fn(),
    useState() {
      const index = hook++;
      assert.ok(index < 2, 'panel hooks are exactly showAdvanced + focused');
      return [values[index], next => { values[index] = typeof next === 'function' ? next(values[index]) : next; }];
    },
  });
  const schema = schemas.FILTER_SCHEMAS.cst;
  // A freshly added step BEFORE any seeding and with no stored defaults —
  // the exact shape the reviewer reproduced (label only).
  const sparse = Object.freeze({ label: 'Color Space Transform (CST)' });
  const templateCode = `# ${schema.label}: ${schema.purpose}\n${cst.cstTemplateBody()}`;
  hook = 0;
  const tree = Panel({
    filterType: 'cst',
    params: sparse,
    code: templateCode,
    onChange: next => { writes.push(next); },
  });

  // Change "Output transfer" first — the reviewer's exact repro.
  const select = find(tree, e => e.props.id === 'param-cst-outTransfer')[0];
  assert.ok(select, 'output-transfer control rendered');
  assert.doesNotThrow(() => select.props.onChange({ target: { value: 'pq' } }),
    'first edit must not throw (C07)');

  assert.equal(writes.length, 1, 'exactly one onChange write');
  const next = writes[0];
  // COMPLETE set: every schema param key is present with the edited value.
  for (const p of schema.params) {
    assert.ok(p.key in next, `param ${p.key} present after first edit`);
  }
  assert.equal(next.inPrimaries, '709', 'stored defaults were merged beneath the edit');
  assert.equal(next.outTransfer, 'pq', 'the edit itself is kept');
  // The regenerated code is the schema form for the new params — the initial
  // template also stops reading as CUSTOM (defaults == template).
  assert.equal(typeof next.code, 'string');
  assert.equal(schemas.stepMatchesSchema(schema, next, next.code), true,
    'regenerated script matches the schema form');
  assert.equal(schemas.stepMatchesSchema(schema, schemas.schemaDefaults('cst'), templateCode), true,
    'the seeded defaults match the initial template (not CUSTOM)');

  // An individual RESET (repro's second complaint) also goes through the
  // same complete-set path and must not throw.
  const resetButton = find(tree, e => typeof e.props['aria-label'] === 'string'
    && e.props['aria-label'].startsWith('Reset Output transfer')).at(-1);
  assert.ok(resetButton, 'reset control rendered');
  assert.doesNotThrow(() => resetButton.props.onClick());
  assert.equal(writes.length, 2);
  assert.equal(writes[1].outTransfer, '1886', 'reset restores the schema default');
});
