// Exact ModelsPanel TSX, controlled hooks and actual React static markup.
// All bridge/confirm ports are inert spies; no browser, model or storage runs.
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
const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { fileName: filename,
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020,
    jsx: ts.JsxEmit.React, esModuleInterop: true } }).outputText;
const retention = (overrides = {}) => ({ status: 'retained', path: '/inert/models/.vsres-custody-inert-model',
  bytes: null, note: 'Retained previous installation, archive and stage data.', ...overrides });
const model = (overrides = {}) => ({ id: 'inert-model', label: 'Inert model', purpose: 'Synthetic fixture only',
  publisher: 'Synthetic publisher', version: 'fixture', source: 'https://synthetic.invalid/release',
  asset: 'https://synthetic.invalid/model.7z', sha256: '0'.repeat(64), downloadBytes: 1_000_000,
  diskBytesNeeded: 2_000_000, archiveFormat: '7z', compatibleBackend: 'synthetic',
  licenseStatus: 'Unverified fixture', state: 'ready', retainedStorage: retention(), ...overrides });
function findAll(tree, predicate) {
  if (!React.isValidElement(tree)) return [];
  return [...(predicate(tree) ? [tree] : []), ...React.Children.toArray(tree.props.children)
    .flatMap(child => findAll(child, predicate))];
}
function harness(entries = [model()]) {
  const state = [entries, true, {}, {}, null], calls = [];
  let cursor = 0;
  const hooks = { ...React,
    useState() {
      const index = cursor++; assert(index < state.length, 'Review hook changes rather than invent fixture state');
      return [state[index], update => { state[index] = typeof update === 'function' ? update(state[index]) : update; }];
    },
    useCallback: callback => callback,
    useEffect() {}, // No mount/read/progress effect is selected by these rendering tests.
  };
  const bridge = {
    describeModelRemoval: async request => { calls.push(['scope', request]);
      return { ok: true, dir: '/inert/current/model', fileCount: 2, bytes: 100 }; },
    removeModel: async request => { calls.push(['remove', request]); return { ok: true }; },
    listModels: async () => { calls.push(['list']); return { ok: true, models: entries }; },
    downloadModel() { assert.fail('Retention information cannot download'); },
    extractModel() { assert.fail('Retention information cannot extract'); },
    cancelModelDownload() { assert.fail('Retention information cannot cancel'); },
    onModelProgress() { assert.fail('No progress effect selected'); },
  };
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports,
    require(name) {
      if (name === 'react') return hooks;
      if (name === 'lucide-react') return icons;
      throw new Error('Unadmitted retention UI dependency: ' + name);
    },
    window: { electron: bridge, confirm(text) { calls.push(['confirm', text]); return true; },
      alert() { assert.fail('No alert expected in display-only retention checks'); } },
  }, { filename, timeout: 1000 });
  const render = () => { cursor = 0; const tree = module.exports.ModelsPanel({});
    assert.equal(cursor, state.length); return tree; };
  return { state, calls, render, html: () => server.renderToStaticMarkup(render()),
    notices: () => findAll(render(), node => node.props['aria-label'] === 'Retained model files'),
    buttons: () => findAll(render(), node => node.type === 'button') };
}
const BASELINE = process.env.VSRES_RETENTION_UI_BASELINE === '1';
const CONTROLS = new Set(['ready retention is visible without Details', 'reported size preserves zero and useful units']);
function method(name, callback) { if (!BASELINE || CONTROLS.has(name)) test('model retention UI: ' + name, callback); }
const flush = async () => { for (let count = 0; count < 20; count++) await Promise.resolve(); };

method('ready retention is visible without Details', () => {
  const h = harness(); const html = h.html();
  assert.equal(h.notices().length, 1); assert.equal(h.state[4], null);
  assert(html.includes('/inert/models/.vsres-custody-inert-model'));
  assert(html.includes('Retained previous installation, archive and stage data.'));
  assert(html.includes('Stored separately from the current model folder.'));
  assert(html.includes('Retained size not measured.')); assert.equal(h.calls.length, 0);
});

method('failed and held metadata coexist with current recovery permission', () => {
  const h = harness([model({ state: 'failed', error: 'Synthetic publication held', recovery: 'Synthetic read-only guidance',
    canDiscard: false, retainedStorage: retention({ status: 'held', note: 'Reserved root metadata remains unverified.' }) })]);
  const html = h.html(); assert.equal(h.notices().length, 1);
  assert(html.includes('Synthetic publication held') && html.includes('Synthetic read-only guidance'));
  assert(html.includes('Retention status: Held') && html.includes('Reserved root metadata remains unverified.'));
  assert(!h.buttons().some(button => button.props['aria-label'] === 'Discard failed model files'));
  assert.equal(h.calls.length, 0);
});

method('omitted metadata preserves existing ready actions without a notice', () => {
  const h = harness([model({ retainedStorage: undefined })]);
  assert.equal(h.notices().length, 0); assert(!h.html().includes('Reported retained size:'));
  assert.deepEqual(h.buttons().map(button => button.props['aria-label']), ['Remove model files from disk', 'Details']);
  assert.equal(h.calls.length, 0);
});

method('reported statuses remain neutral and do not change lifecycle', () => {
  for (const [status, label] of [['retained', 'Retained'], ['pending', 'Pending'], ['held', 'Held']]) {
    const h = harness([model({ retainedStorage: retention({ status }) })]);
    const notice = h.notices()[0]; assert(notice);
    assert.equal(notice.props.role, 'note'); assert(h.html().includes('Retention status: ' + label));
    assert(h.html().includes('Ready — extracted for the runtime'));
    assert.equal(findAll(notice, node => node.type === 'button' || node.type === 'a').length, 0);
    assert.equal(h.calls.length, 0);
  }
});

method('reported size preserves zero and useful units', () => {
  for (const [bytes, expected] of [[0, '0 bytes'], [123, '123 bytes'], [1_000_000, '1 MB'], [2_500_000_000, '2.5 GB']]) {
    const h = harness([model({ retainedStorage: retention({ bytes }) })]);
    assert(h.html().includes('Reported retained size: ' + expected + '.'));
    assert(!h.html().includes('Retained size not measured.')); assert.equal(h.calls.length, 0);
  }
});

method('unknown or malformed numeric footprint is never fabricated as zero', () => {
  for (const bytes of [null, undefined, -1, NaN, Infinity, 1.5, '2500000000']) {
    const h = harness([model({ retainedStorage: retention({ bytes }) })]);
    assert(h.html().includes('Retained size not measured.'));
    assert(!h.html().includes('Reported retained size: 0')); assert.equal(h.calls.length, 0);
  }
});

method('path and note are escaped wrapped text without aggregate invention', () => {
  const literal = '/inert/root  with spaces/é_日本/<retained>&"quotes"\nline';
  const h = harness([model({ retainedStorage: retention({ path: literal, note: '<script>inert</script>', bytes: 1_000_000 }) }),
    model({ id: 'other-inert-model', retainedStorage: retention({ path: '/inert/other-custody', bytes: 2_000_000 }) })]);
  const notices = h.notices(); assert.equal(notices.length, 2);
  const textPath = findAll(notices[0], node => node.type === 'code')[0];
  assert.equal(textPath.props.children, literal); assert.equal(textPath.props.style.whiteSpace, 'pre-wrap');
  assert.equal(textPath.props.style.overflowWrap, 'anywhere');
  const html = h.html(); assert(html.includes('&lt;retained&gt;') && html.includes('&lt;script&gt;inert&lt;/script&gt;'));
  assert(!html.includes('<script>') && !html.includes('Reported retained size: 3 MB'));
  for (const notice of notices) assert.equal(findAll(notice, node => node.type === 'a' || node.type === 'button').length, 0);
  assert.equal(h.calls.length, 0);
});

method('retention information adds no actions and leaves current-model removal scope intact', async () => {
  const old = harness([model({ retainedStorage: undefined })]), h = harness();
  assert.deepEqual(h.buttons().map(button => button.props['aria-label']), old.buttons().map(button => button.props['aria-label']));
  assert.equal(h.calls.length, 0);
  h.buttons().find(button => button.props['aria-label'] === 'Remove model files from disk').props.onClick();
  await flush();
  assert.deepEqual(h.calls.map(call => call[0]), ['scope', 'confirm', 'remove', 'list']);
  assert.deepEqual(Object.keys(h.calls[0][1]), ['id']); assert.equal(h.calls[0][1].id, 'inert-model');
  assert.deepEqual(Object.keys(h.calls[2][1]), ['id']); assert.equal(h.calls[2][1].id, 'inert-model');
  assert(h.calls[1][1].includes('Directory: /inert/current/model'));
  assert(!h.calls[1][1].includes('.vsres-custody-inert-model'));
  assert.equal(h.notices().length, 1, 'Current-model success does not hide reported retained custody');
});
