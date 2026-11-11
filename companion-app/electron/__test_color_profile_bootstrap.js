// Actual App bootstrap callback/controller/defaults and Pipeline presentation,
// selected from source. Synthetic packets + React SSR only; full App/Electron,
// IPC, stores, providers, native processing and media never load or run.
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
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const forbidden = () => assert.fail('No real application, bridge, timer, provider or native operation');
const compile = source => ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020,
  jsx: ts.JsxEmit.React, esModuleInterop: true,
} }).outputText;
function evaluate(compiled, globals = {}, imports = {}) {
  const module = { exports: {} };
  vm.runInNewContext(compiled, { module, exports: module.exports,
    require(name) { assert(Object.hasOwn(imports, name), `Unadmitted import: ${name}`); return imports[name]; },
    window: new Proxy({}, { get: forbidden }), setTimeout: forbidden, clearTimeout: forbidden,
    setInterval: forbidden, ...globals,
  }, { timeout: 1000 });
  return module.exports;
}
const load = (file, imports = {}) => evaluate(compile(read(file)), {}, imports);
const appAst = ts.createSourceFile('App.tsx', read('App.tsx'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function select(predicate) {
  const found = [];
  function visit(n) { if (predicate(n)) found.push(n); ts.forEachChild(n, visit); }
  visit(appAst); assert.equal(found.length, 1); return found[0];
}
const initializer = name => select(n => ts.isVariableDeclaration(n)
  && ts.isIdentifier(n.name) && n.name.text === name).initializer.getText(appAst);
const effect = marker => select(n => ts.isCallExpression(n) && ts.isIdentifier(n.expression)
  && n.expression.text === 'useEffect' && n.arguments[0].getText(appAst).includes(marker)).arguments[0].getText(appAst);
const bootstrapEffect = compile(`module.exports = ${effect('editorBootstrap.current!.connect')};`);
const liveWriteEffect = compile(`module.exports = ${effect('liveSyncDebounce.current = setTimeout')};`);
const defaults = evaluate(compile(`const DEFAULT_COLOR_MGMT = ${initializer('DEFAULT_COLOR_MGMT')};
  module.exports = ${initializer('DEFAULT_CONFIG')};`), {
  LLM_MODELS: [{ id: 'synthetic/model' }], ARCHIVIST_GREETING: 'Synthetic greeting',
  mkid: prefix => `${prefix}-synthetic`, Date: class { toISOString() { return '2000-01-01T00:00:00.000Z'; } },
});
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
freeze(defaults);
const { createEditorBootstrap } = load('services/editor-bootstrap.ts');
const types = load('types.ts');
const colors = load('services/color-heuristic.ts');
const modes = load('services/source-mode.ts');
const playbooks = load('services/stage-playbooks.ts', {
  '../../shared/stage-playbooks.json': JSON.parse(fs.readFileSync(path.join(__dirname, '../shared/stage-playbooks.json'), 'utf8')),
});
const badge = load('components/OCIOBadge.tsx', { react: React });
// PipelinePanel's live-step gate uses shared/draft-composer isStepApproved
// (content-bound approval, 2026-11-11).
const draftComposer = load('../shared/draft-composer.ts', {});
const { PipelinePanel } = load('components/PipelinePanel.tsx', {
  react: React, 'lucide-react': icons, '../types': types, './OCIOBadge': badge,
  '../services/color-heuristic': colors, '../services/source-mode': modes, '../services/stage-playbooks': playbooks,
  '../../shared/draft-composer': draftComposer,
});
const render = config => server.renderToStaticMarkup(React.createElement(PipelinePanel, { config }));
const fields = ['inputColorSpace', 'inputGamma', 'outputColorSpace', 'outputGamma', 'ocioConfig'];
const expectedDefaults = { inputColorSpace: 'Rec.709', inputGamma: 'BT.1886',
  outputColorSpace: 'Rec.709', outputGamma: 'BT.1886', ocioConfig: 'studio-config-v2.1.0_aces-v1.3_ocio-v2.3' };
const routes = ['snapshot', 'legacy'];
async function boot(packet, route = 'snapshot', mode = 'host') {
  const controller = createEditorBootstrap(), configs = [], updates = [];
  let push;
  const bridge = route === 'snapshot' ? { getEditorConfiguration: () => ({ ok: true, mode, config: packet }) }
    : { syncFromHost(cb) { push = cb; return () => {}; } };
  const stop = evaluate(bootstrapEffect, {
    editorBootstrap: { current: controller }, window: { electron: bridge }, DEFAULT_CONFIG: defaults,
    mkid: prefix => `${prefix}-synthetic`, setConfig: config => configs.push(config), setStartup: s => updates.push(s),
  })();
  if (route === 'legacy') push(packet);
  await Promise.resolve(); await Promise.resolve();
  const state = controller.snapshot(); stop();
  return { configs, updates, state };
}
function ready(result) {
  assert.equal(result.state.phase, 'ready'); assert.equal(result.configs.length, 1);
  return result.configs[0];
}
function held(result, expectedDetail) {
  assert.equal(result.state.phase, 'unavailable'); assert.equal(result.configs.length, 0);
  assert.equal(result.state.detail, expectedDetail);
  assert(!result.updates.some(s => s.phase === 'ready'));
  evaluate(liveWriteEffect, {
    isEditorReady: result.state.phase === 'ready', config: new Proxy({}, { get: forbidden }),
    seenInitial: new Proxy({}, { get: forbidden }), liveSyncDebounce: new Proxy({}, { get: forbidden }),
    requestConfigWrite: forbidden, writeObserver: new Proxy({}, { get: forbidden }),
  })();
}

test('color bootstrap partial profiles fill every required field through snapshot and compatibility delivery', async () => {
  assert.deepEqual({ ...defaults.colorManagement }, expectedDefaults);
  // Causal negative: the old shallow profile produces an actual presentation fault.
  assert.throws(() => render({ chain: [], colorManagement: { inputColorSpace: 'Rec.2020' }, mix: 1 }),
    error => error.name === 'TypeError' && /undefined/.test(error.message));
  for (const route of routes) for (const field of fields) {
    const profile = freeze({ [field]: `synthetic-${field}` }), before = JSON.stringify(profile);
    const config = ready(await boot(freeze({ colorManagement: profile }), route));
    assert.deepEqual({ ...config.colorManagement }, { ...expectedDefaults, [field]: profile[field] });
    assert(render(config).includes('Pipeline'));
    assert.notEqual(config.colorManagement, profile); assert.equal(JSON.stringify(profile), before);
  }
});

test('color bootstrap absent null empty and undefined fields retain cloned defaults without mutating inputs', async () => {
  const before = JSON.stringify(defaults);
  for (const route of routes) for (const packet of [freeze({}), freeze({ colorManagement: null }),
    freeze({ colorManagement: {} }), freeze({ colorManagement: { inputGamma: undefined } })]) {
    const config = ready(await boot(packet, route));
    assert.deepEqual({ ...config.colorManagement }, expectedDefaults);
    assert.notEqual(config.colorManagement, defaults.colorManagement); assert(render(config).includes('Pipeline'));
  }
  const standalone = ready(await boot(null, 'snapshot', 'standalone'));
  assert.deepEqual({ ...standalone.colorManagement }, expectedDefaults);
  assert.equal(JSON.stringify(defaults), before); assert(Object.isFrozen(defaults.colorManagement));
});

test('color bootstrap preserves full custom labels empty strings and uninterpreted extension values', async () => {
  const profile = freeze({ inputColorSpace: 'custom-input <synthetic>', inputGamma: 'custom-gamma',
    outputColorSpace: '', outputGamma: '', ocioConfig: 'synthetic-config', vendorNote: { tag: 'synthetic' } });
  for (const route of routes) {
    const config = ready(await boot(freeze({ colorManagement: profile }), route));
    assert.deepEqual({ ...config.colorManagement }, { ...profile });
    assert.equal(config.colorManagement.vendorNote, profile.vendorNote);
    const html = render(config); assert(html.includes('custom-input &lt;synthetic&gt;'));
    assert(!html.includes('custom-input <synthetic>')); assert.notEqual(config.colorManagement, profile);
  }
});

test('color bootstrap malformed profile containers remain unavailable before configuration or writes', async () => {
  for (const route of routes) for (const profile of [[], 'synthetic-private-sentinel', 42, false]) {
    held(await boot({ colorManagement: profile }, route), 'Editor colorManagement must be an object.');
  }
});

test('color bootstrap malformed known fields report field names only and never release ready or write', async () => {
  for (const route of routes) for (const field of fields) for (const value of [null, 42, false,
    freeze([]), freeze({ detail: 'synthetic-private-sentinel' })]) {
    const result = await boot({ colorManagement: { [field]: value } }, route);
    held(result, `Editor colorManagement.${field} must be text.`);
    assert(!JSON.stringify(result.updates).includes('synthetic-private-sentinel'));
  }
});

test('color bootstrap nested repair retains other supplied partial configuration and metadata references', async () => {
  const metadata = freeze({ timeline: { width: 1280, height: 720, fps: 24 } });
  const messages = freeze([{ id: 'synthetic-message', role: 'user', text: 'Synthetic draft', timestamp: '2000-01-01' }]);
  const packet = freeze({ nodeId: 'synthetic-node', mix: 0.4, manualOrder: true, clipMetadata: metadata,
    archivist: { panelOpen: false, panelWidth: 420, selectedModelId: 'synthetic/custom-model', messages },
    colorManagement: { inputGamma: 'custom-log' } });
  const before = JSON.stringify(packet);
  for (const route of routes) {
    const config = ready(await boot(packet, route));
    assert.equal(config.nodeId, packet.nodeId); assert.equal(config.mix, 0.4); assert.equal(config.manualOrder, true);
    assert.equal(config.clipMetadata, metadata); assert.equal(config.archivist.messages[0], messages[0]);
    assert.equal(config.archivist.panelOpen, false); assert.equal(config.archivist.panelWidth, 420);
    assert.equal(config.archivist.selectedModelId, 'synthetic/custom-model');
    assert.equal(config.colorManagement.inputGamma, 'custom-log'); assert.equal(config.colorManagement.outputGamma, 'BT.1886');
    assert(render(config).includes('1280×720')); assert.equal(JSON.stringify(packet), before);
  }
});
