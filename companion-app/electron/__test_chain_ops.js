// Exercise the actual renderer consumer without React, Electron, providers or Python.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const filename = path.join(__dirname, '../src/services/chain-ops.ts');
const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  fileName: filename,
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  reportDiagnostics: true,
});
assert.equal((compiled.diagnostics || []).filter(d => d.category === ts.DiagnosticCategory.Error).length, 0);
const moduleRecord = { exports: {} };
vm.runInNewContext(compiled.outputText, {
  module: moduleRecord, exports: moduleRecord.exports,
  require() { throw new Error('Unexpected runtime dependency'); },
}, { filename, timeout: 1000 });
const { applyOperations } = moduleRecord.exports;
const json = value => JSON.parse(JSON.stringify(value));
function step(approval = true) {
  const value = { id: 'reviewed', type: 'script', stage: 10, enabled: true, version: 1,
    params: { code: 'clip = source', label: 'Reviewed script' } };
  if (approval !== 'legacy') value.approved = approval;
  return value;
}
function edit(value, patch) {
  return applyOperations([value], [{ op: 'update', targetId: value.id, patch }])[0];
}

test('replacement code in an approved step becomes an inert draft', () => {
  const original = step();
  const changed = edit(original, { params: { code: 'raise RuntimeError("UNTRUSTED_EDIT")' } });
  assert.equal(changed.approved, false);
  assert.equal(changed.params.label, original.params.label);
  assert.equal(changed.params.code, 'raise RuntimeError("UNTRUSTED_EDIT")');
  assert.equal([changed].filter(s => s.enabled && s.approved !== false).length, 0);
  assert.equal(original.params.code, 'clip = source');
  assert.equal(original.approved, true);
});

test('legacy implicit approval is revoked when code changes', () => {
  assert.equal(edit(step('legacy'), { params: { code: 'clip = replacement' } }).approved, false);
});

test('a proposed add cannot supply its own approval', () => {
  for (const approval of [true, 'legacy', false]) {
    const original = step(approval);
    const added = applyOperations([], [{ op: 'add', step: original }])[0];
    assert.equal(added.approved, false);
    assert.notEqual(added, original);
    assert.deepEqual(json(original), step(approval));
  }
});

test('an update cannot grant approval to an unchanged draft', () => {
  assert.equal(edit(step(false), { approved: true }).approved, false);
  assert.equal(edit(step(false), { params: { label: 'Renamed' }, approved: true }).approved, false);
});

test('supplied approval cannot authorize replacement code', () => {
  const changed = edit(step(), { params: { code: 'clip = replacement' }, approved: true });
  assert.equal(changed.approved, false);
});

test('an operation can revoke approval without changing the script', () => {
  assert.equal(edit(step(), { approved: false }).approved, false);
});

test('changed stage, type, enablement and executable parameters require review', () => {
  for (const patch of [{ stage: 20 }, { type: 'qtgmc' }, { enabled: false }, { params: { Preset: 'Fast' } }]) {
    assert.equal(edit(step(), patch).approved, false);
  }
});

test('label-only and idempotent executable updates retain existing approval', () => {
  for (const approval of [true, false, 'legacy']) {
    const original = step(approval);
    const changed = edit(original, { params: { label: 'Renamed', code: original.params.code }, stage: original.stage });
    assert.equal(changed.approved, original.approved);
    assert.equal(changed.params.label, 'Renamed');
    assert.equal(original.params.label, 'Reviewed script');
  }
});

test('a later operation in the batch cannot reapprove changed code', () => {
  const next = applyOperations([step()], [
    { op: 'update', targetId: 'reviewed', patch: { params: { code: 'clip = replacement' } } },
    { op: 'update', targetId: 'reviewed', patch: { approved: true, params: { label: 'Looks approved' } } },
  ]);
  assert.equal(next[0].approved, false);
});

test('unrelated steps keep their identity and approval; removal still works', () => {
  const first = step(); const second = { ...step(), id: 'other' };
  Object.freeze(first.params); Object.freeze(first); Object.freeze(second); const chain = Object.freeze([first, second]);
  const next = applyOperations(chain, [{ op: 'update', targetId: first.id, patch: { params: { code: 'clip = replacement' } } }]);
  assert.equal(next[1], second);
  assert.equal(next[1].approved, true);
  assert.equal(applyOperations(next, [{ op: 'remove', targetId: first.id }])[0], second);
  assert.equal(chain.length, 2);
});

test('a missing target cannot alter a reviewed step', () => {
  const original = step();
  const next = applyOperations([original], [{ op: 'update', targetId: 'missing', patch: { params: { code: 'clip = replacement' } } }]);
  assert.equal(next[0], original);
});
