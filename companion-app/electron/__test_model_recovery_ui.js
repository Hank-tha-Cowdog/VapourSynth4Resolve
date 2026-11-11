// Actual ModelsPanel TSX/handler source with controlled hooks and bridge ports.
// React static markup/callback evidence only; no browser, storage, IPC or product runs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const server = require('react-dom/server');
const icons = require(path.join(__dirname, '../node_modules/lucide-react'));

const filename = path.join(__dirname, '../src/components/ModelsPanel.tsx');
const text = fs.readFileSync(filename, 'utf8');
const options = { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020,
  jsx: ts.JsxEmit.React, esModuleInterop: true };
const code = ts.transpileModule(text, { fileName: filename, compilerOptions: options }).outputText;
const ast = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const removeNodes = [];
(function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'onRemove') removeNodes.push(node);
  ts.forEachChild(node, visit);
})(ast);
assert.equal(removeNodes.length, 1);
const removeCode = ts.transpileModule('module.exports = ' + removeNodes[0].initializer.getText(ast),
  { compilerOptions: options }).outputText;

const fixture = (overrides = {}) => ({ id: 'inert-model', label: 'Inert model', purpose: 'Synthetic fixture only',
  publisher: 'Synthetic publisher', version: 'fixture', source: 'https://synthetic.invalid/release',
  asset: 'https://synthetic.invalid/model.7z', sha256: '0'.repeat(64), downloadBytes: 1_000_000,
  diskBytesNeeded: 2_000_000, archiveFormat: '7z', compatibleBackend: 'synthetic',
  licenseStatus: 'Unverified fixture', state: 'failed', error: 'Synthetic backend failure',
  recovery: 'Review the files, then discard only if offered.', canDiscard: false, ...overrides });
function findAll(tree, predicate) {
  if (!React.isValidElement(tree)) return [];
  return [...(predicate(tree) ? [tree] : []), ...React.Children.toArray(tree.props.children)
    .flatMap(child => findAll(child, predicate))];
}
function harness(model = fixture(), config = {}) {
  const slots = [[model], true, { ...(config.busy || {}) }, { ...(config.progress || {}) }, null];
  const calls = [], effects = [];
  let cursor = 0;
  const hooks = { ...React,
    useState() {
      const index = cursor++; assert(index < slots.length, 'Review new hook state before extending fixture');
      return [slots[index], update => { slots[index] = typeof update === 'function' ? update(slots[index]) : update; }];
    },
    useCallback: callback => callback,
    useEffect: callback => { effects.push(callback); },
  };
  const port = (name, callback) => async (...args) => { calls.push([name, ...args]); return callback(...args); };
  const bridge = {
    listModels: port('list', async () => {
      if (config.listError) throw new Error(config.listError);
      return { ok: true, models: config.modelsAfter || slots[0], extractionAvailable: true };
    }),
    describeModelRemoval: port('scope', async () => {
      if (config.scopeError) throw new Error(config.scopeError);
      return config.scope === undefined ? { ok: true, dir: '/inert/owned/model', fileCount: 3, bytes: 1_000_000 } : config.scope;
    }),
    removeModel: port('remove', async () => {
      if (config.removeError) throw new Error(config.removeError);
      return config.remove ? config.remove() : config.result === undefined ? { ok: true } : config.result;
    }),
    downloadModel: port('download', () => ({ ok: true })),
    extractModel: port('extract', () => ({ ok: true })),
    cancelModelDownload: port('cancel', () => ({ ok: true })),
    onModelProgress() { assert.fail('Effects are inert until a test explicitly selects them'); },
  };
  if (config.missingRemove) delete bridge.removeModel;
  const window = { electron: bridge, confirm(message) { calls.push(['confirm', message]); return config.confirm !== false; },
    alert(message) { calls.push(['alert', message]); } };
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, window,
    require(name) {
      if (name === 'react') return hooks;
      if (name === 'lucide-react') return icons;
      throw new Error(`Unadmitted ModelsPanel dependency: ${name}`);
    },
  }, { filename, timeout: 1000 });
  const render = () => { cursor = 0; effects.length = 0;
    const result = module.exports.ModelsPanel({ onCapabilityChanged() { calls.push(['capability']); } });
    assert.equal(cursor, slots.length); return result; };
  return { slots, calls, effects, render,
    html: () => server.renderToStaticMarkup(render()),
    button(label) { return findAll(render(), node => node.type === 'button' && node.props['aria-label'] === label)[0]; },
    async guardRemoval() {
      const guarded = { exports: {} };
      vm.runInNewContext(removeCode, { module: guarded, exports: guarded.exports, window,
        models: slots[0], progress: slots[3],
        setBusy(update) { slots[2] = update(slots[2]); },
        reload() { assert.fail('Refused removal cannot refresh or dispatch'); },
      }, { filename: filename + ':onRemove', timeout: 1000 });
      return guarded.exports(model.id);
    },
  };
}
const flush = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };
const labels = h => findAll(h.render(), node => node.type === 'button').map(node => node.props['aria-label']);
const click = (h, label) => { const button = h.button(label); assert(button, label); button.props.onClick(); return button; };
const BASELINE = process.env.VSRES_MODEL_UI_BASELINE === '1';
const CONTROLS = new Set(['failed diagnostics', 'strict discard permission', 'backend removal failure', 'missing removal reply']);
function method(name, run) { if (!BASELINE || CONTROLS.has(name)) test('model recovery UI: ' + name, run); }

method('failed diagnostics', () => {
  const h = harness(fixture({ error: '<backend failure>', recovery: 'Keep <owned files> until stop is confirmed.' }));
  const html = h.html();
  assert(html.includes('&lt;backend failure&gt;') && html.includes('Keep &lt;owned files&gt; until stop is confirmed.'));
  assert(html.includes('role="alert"') && html.includes('overflow-wrap:anywhere'));
  assert(!labels(h).includes('Discard failed model files'));
  assert.equal(h.calls.length, 0, 'Rendering never starts a model operation');
});

method('strict discard permission', async () => {
  for (const canDiscard of [true, false, undefined, null, 'true', 1]) {
    const h = harness(fixture({ canDiscard }));
    assert.equal(labels(h).includes('Discard failed model files'), canDiscard === true);
    if (canDiscard !== true) {
      await h.guardRemoval();
      assert.equal(h.calls.length, 0, 'Actual onRemove refuses before scope/confirm/removal');
      assert.match(h.slots[2]['inert-model'], /Removal is unavailable/);
    }
  }
});

method('declined confirmation preserves files and limits calls to scope', async () => {
  const h = harness(fixture({ canDiscard: true }), { confirm: false });
  click(h, 'Discard failed model files'); await flush();
  assert.deepEqual(h.calls.map(row => row[0]), ['scope', 'confirm']);
  const message = h.calls[1][1];
  assert(message.includes('Directory: /inert/owned/model') && message.includes('Files: 3') && message.includes('Size: 1 MB'));
  assert.equal(h.slots[0][0].state, 'failed'); assert.equal(h.slots[2]['inert-model'], undefined);
});

method('explicit allowed discard forwards exact id after scope confirmation', async () => {
  const h = harness(fixture({ canDiscard: true }));
  assert.equal(h.calls.length, 0);
  click(h, 'Discard failed model files'); await flush();
  assert.deepEqual(h.calls.map(row => row[0]), ['scope', 'confirm', 'remove', 'list', 'capability']);
  assert.equal(h.calls[0][1].id, 'inert-model'); assert.equal(h.calls[2][1].id, 'inert-model');
  assert.equal(h.slots[2]['inert-model'], undefined);
});

method('failed scope is visible and prevents confirmation and removal', async () => {
  const h = harness(fixture({ state: 'ready' }), { scope: { ok: false, error: 'Synthetic scope denied' } });
  click(h, 'Remove model files from disk'); await flush();
  assert.deepEqual(h.calls.map(row => row[0]), ['scope']);
  assert(h.html().includes('Synthetic scope denied')); assert.equal(h.slots[2]['inert-model'], 'Synthetic scope denied');
});

method('backend removal failure', async () => {
  const h = harness(fixture({ state: 'ready' }), { result: { ok: false, error: 'Synthetic removal refused' } });
  click(h, 'Remove model files from disk'); await flush();
  assert(h.html().includes('Synthetic removal refused'));
  assert.equal(h.slots[2]['inert-model'], 'Synthetic removal refused');
  assert.equal(h.calls.filter(row => row[0] === 'remove').length, 1);
});

method('missing removal reply', async () => {
  for (const config of [{ missingRemove: true }, { remove: () => undefined }, { result: { ok: 'yes' } }]) {
    const h = harness(fixture({ state: 'ready' }), config);
    click(h, 'Remove model files from disk'); await flush();
    assert(h.html().includes('Removal failed. The files were not confirmed removed.'));
    assert.match(h.slots[2]['inert-model'], /not confirmed removed/);
  }
});

method('scope and removal rejections are contained and visible', async () => {
  for (const config of [{ scopeError: 'Synthetic scope transport failure' }, { removeError: 'Synthetic remove transport failure' }]) {
    const h = harness(fixture({ state: 'ready' }), config);
    click(h, 'Remove model files from disk'); await flush();
    assert(h.html().includes(config.scopeError || config.removeError));
    assert.equal(h.calls.filter(row => row[0] === 'remove').length, config.scopeError ? 0 : 1);
  }
});

method('confirmed success clears prior operation error and reloads only the list', async () => {
  const h = harness(fixture({ state: 'ready' }), { busy: { 'inert-model': 'Prior operation error' },
    modelsAfter: [fixture({ state: 'absent' })] });
  click(h, 'Remove model files from disk'); await flush();
  assert.equal(h.slots[2]['inert-model'], undefined);
  assert(!h.html().includes('Prior operation error'));
  assert(labels(h).some(label => label.startsWith('Download Inert model')));
  assert.equal(h.calls.filter(row => row[0] === 'list').length, 1);
  assert.equal(h.calls.filter(row => ['download', 'extract', 'cancel'].includes(row[0])).length, 0);
});

method('valid existing states keep their explicit actions without automatic operations', async () => {
  for (const [state, action, port] of [['absent', 'Download Inert model (1 MB)', 'download'],
    ['downloading', 'Cancel download', 'cancel'], ['interrupted', 'Retry download of Inert model (overwrites the partial)', 'download'],
    ['downloaded', 'Extract verified archive', 'extract'], ['ready', 'Remove model files from disk', 'remove']]) {
    const h = harness(fixture({ state })); assert.equal(h.calls.length, 0); assert(labels(h).includes(action));
    click(h, action); await flush();
    assert.equal(h.calls.filter(row => row[0] === port).length, 1);
    assert.equal(h.calls.find(row => row[0] === port)[1].id, 'inert-model');
  }
  const interrupted = harness(fixture({ state: 'interrupted' }));
  assert(labels(interrupted).includes('Discard the partial download'));
});

method('active progress suppresses failed discard and pending removal exposes disabled status', async () => {
  const active = harness(fixture({ canDiscard: true }), { progress: { 'inert-model': { phase: 'downloading', received: 5 } } });
  assert(!labels(active).includes('Discard failed model files')); assert(labels(active).includes('Cancel download'));
  await active.guardRemoval(); assert.equal(active.calls.length, 0);
  let finish; const pending = new Promise(resolve => { finish = resolve; });
  const h = harness(fixture({ state: 'interrupted' }), { remove: () => pending });
  click(h, 'Discard the partial download'); await flush();
  assert(h.html().includes('Removing model files…'));
  for (const label of ['Discard the partial download', 'Retry download of Inert model (overwrites the partial)']) {
    assert.equal(h.button(label).props.disabled, true);
  }
  finish({ ok: true }); await flush(); assert.equal(h.slots[2]['inert-model'], undefined);
});

method('list refresh failure after removal is visible without another removal', async () => {
  const h = harness(fixture({ state: 'ready' }), { listError: 'Synthetic list unavailable' });
  click(h, 'Remove model files from disk'); await flush();
  assert(h.html().includes('Model list could not be refreshed: Synthetic list unavailable'));
  assert.equal(h.calls.filter(row => row[0] === 'remove').length, 1);
  assert.equal(h.calls.filter(row => row[0] === 'list').length, 1);
});
