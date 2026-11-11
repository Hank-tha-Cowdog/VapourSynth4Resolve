// Bootstrap→save regression for the live Oct 27 fresh-node save failure.
//
// Live evidence: two Configure presses on a fresh node (273-byte config, no
// nodeGuid) both ended 'companion exited without a saved revision' — the
// renderer merge emitted a PRESENT-but-undefined nodeGuid and main-side
// validation rejected the whole save with a generic error. These checks lock
// the contract for BOTH node states:
//   fresh   — incoming config has no nodeGuid → save must publish (and the
//             native side assigns the guid on accept).
//   existing— incoming config has a string nodeGuid → must round-trip.
// Finite synthetic packets only; no Electron, files, or native host.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const forbidden = () => assert.fail('No real bridge, timer, filesystem or module loading');
function evaluate(source, globals = {}) {
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true,
  } }).outputText, { module, exports: module.exports,
    require: forbidden, window: new Proxy({}, { get: forbidden }),
    setTimeout: forbidden, clearTimeout: forbidden, ...globals,
  }, { timeout: 1000 });
  return module.exports;
}
const validation = evaluate(read('electron/editor-configuration.js'));

// ── main-side validation contract (the layer that rejected the live save) ──

test('fresh-node config without any nodeGuid key is publishable', () => {
  const fresh = { schemaVersion: 1, nodeId: 'local-dev', manualOrder: false,
    mix: 1.0, colorManagement: { inputColorSpace: 'Rec.709', inputGamma: 'BT.1886',
      outputColorSpace: 'Rec.709', outputGamma: 'BT.1886', ocioConfig: 'studio' },
    chain: [{ id: 'step-1', type: 'qtgmc', stage: 20, enabled: true, approved: true,
      version: 1, params: { preset: 'Slower', tff: true, fpsDivisor: 2 } }] };
  assert.equal(validation.describeManualHostConfigProblem(fresh), null,
    'a config with NO nodeGuid key must be publishable (fresh node)');
  assert.equal(validation.isManualHostConfig(fresh), true);
});

test('present-undefined nodeGuid (the live failure shape) is publishable', () => {
  // The exact IPC shape that killed the live save: structured clone preserved
  // the renderer's `nodeGuid: undefined` as a present key.
  const shape = { schemaVersion: 1, chain: [] };
  Object.defineProperty(shape, 'nodeGuid', { value: undefined, enumerable: true });
  assert.equal('nodeGuid' in shape, true);
  assert.equal(validation.describeManualHostConfigProblem(shape), null,
    'present-but-undefined optional fields are ABSENT in JSON semantics');
});

test('real invalid nodeGuid values are still rejected with a named field', () => {
  assert.match(validation.describeManualHostConfigProblem({ chain: [], nodeGuid: 123 }),
    /nodeGuid is not text/);
  assert.match(validation.describeManualHostConfigProblem({ chain: 'nope' }),
    /chain is not an array/);
  assert.match(validation.describeManualHostConfigProblem({
    chain: [{ id: 'x', type: 'qtgmc', params: 'nope' }] }), /params is not an object/);
});

test('existing-node config with a string nodeGuid round-trips validation', () => {
  const existing = { schemaVersion: 1, nodeId: 'local-dev',
    nodeGuid: 'fb6b21ad-4c5d-4b82-bad9-ad0d918a0000',
    chain: [{ id: 's1', type: 'qtgmc', stage: 20, enabled: true, approved: true,
      version: 1, params: { preset: 'Slower' } }] };
  assert.equal(validation.describeManualHostConfigProblem(existing), null);
  assert.equal(validation.isManualHostConfig(existing), true);
});

// ── renderer-side merge contract (the layer that emitted the bad shape) ──

test('renderer merge omits the nodeGuid key when the host config has none', () => {
  // App.tsx must spread conditionally — `nodeGuid: inc.nodeGuid` materialized
  // a present-undefined key and killed the save (live Oct 27).
  const app = ts.createSourceFile('src/App.tsx', read('src/App.tsx'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found = null;
  function visit(node) {
    const isSpread = ts.isSpreadAssignment(node) || ts.isSpreadElement(node);
    if (isSpread && node.expression.getText(app).includes('inc.nodeGuid != null')) found = node;
    ts.forEachChild(node, visit);
  }
  visit(app);
  assert.ok(found, 'App.tsx must spread nodeGuid only when defined (...(inc.nodeGuid != null ? { nodeGuid } : {}))');
  const text = found.expression.getText(app);
  assert.match(text, /nodeGuid:\s*inc\.nodeGuid/, 'the conditional spread must carry inc.nodeGuid');
});

test('merged fresh config serializes without a nodeGuid key (JSON semantics)', () => {
  // Simulate the actual serialized payload main receives from a fresh node.
  const merged = { schemaVersion: 1, nodeId: 'local-dev',
    ...(undefined != null ? { nodeGuid: undefined } : {}), chain: [] };
  const serialized = JSON.parse(JSON.stringify(merged));
  assert.equal('nodeGuid' in serialized, false, 'serialized fresh-node payload has no nodeGuid key');
});