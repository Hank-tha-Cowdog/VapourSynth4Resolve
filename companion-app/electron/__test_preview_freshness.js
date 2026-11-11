// Actual PreviewPanel effect/callback source with controlled hook commits, fake timers and local IPC.
// This is not a mounted React test. No real timer, bridge, preview image or backend is accessed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const source = path.join(__dirname, '../src/components/PreviewPanel.tsx');
const ast = ts.createSourceFile(source, fs.readFileSync(source, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const matches = ast.statements.filter(ts.isVariableStatement).flatMap(s => [...s.declarationList.declarations])
  .filter(d => ts.isIdentifier(d.name) && d.name.text === 'PreviewPanel');
assert.equal(matches.length, 1); assert(ts.isArrowFunction(matches[0].initializer));
const code = ts.transpileModule(`module.exports = ${matches[0].initializer.getText(ast)};`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.React },
}).outputText;
// Real shared draft-composer isStepApproved (content-bound approval) — the
// extracted PreviewPanel body calls it as a free identifier; the fixture
// below carries a matching binding (scriptBody('# synthetic') === '# synthetic\n').
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
const config = (tag, overrides = {}) => ({
  chain: [{ id: 'synthetic-step', type: 'script', enabled: true, approved: true, version: 1,
    approvedContent: '# synthetic\n', stage: 'main', params: { tag, code: '# synthetic' } }],
  mix: 1, colorManagement: { inputColorSpace: 'synthetic-matrix' }, ...overrides,
});
function driver(reply = async () => ({ ok: false, error: 'Synthetic completed request' })) {
  const slots = [], timers = new Map(), requests = [], reads = [], callbackRuns = [];
  let cursor = 0, pending = [], serial = 0, intervalInstalls = 0, tree;
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  function slot(create) { const index = cursor++; return slots[index] || (slots[index] = create()); }
  function timer(kind, fn, delay) {
    const id = ++serial; timers.set(id, { kind, fn, delay });
    if (kind === 'interval') intervalInstalls++;
    return id;
  }
  const module = { exports: {} };
  const forbidden = () => assert.fail('No real external effect permitted');
  vm.runInNewContext(code, { module, exports: module.exports, React,
    useState(initial) { const s = slot(() => ({ value: initial }));
      return [s.value, next => { s.value = typeof next === 'function' ? next(s.value) : next; }]; },
    useRef(initial) { return slot(() => ({ current: initial })); },
    useCallback(callback, deps) {
      const s = slot(() => ({})); if (!same(s.deps, deps)) {
        s.deps = deps; s.callback = (...args) => {
          const result = callback(...args); callbackRuns.push(result); return result;
        };
      }
      return s.callback;
    },
    useEffect(effect, deps) {
      const s = slot(() => ({})); if (!same(s.deps, deps)) { s.deps = deps; pending.push({ s, effect }); }
    },
    setTimeout: (fn, delay) => timer('timeout', fn, delay), clearTimeout: id => timers.delete(id),
    setInterval: (fn, delay) => timer('interval', fn, delay), clearInterval: id => timers.delete(id),
    performance: { now: () => 100 },
    window: { electron: {
      async previewChain(serialized, mix, frame) {
        requests.push({ config: JSON.parse(serialized), mix, frame }); return reply(requests.length);
      },
      async readPreviewImage() { reads.push('synthetic-image-result');
        return { ok: true, dataUrl: 'data:image/png;base64,c3ludGhldGlj' }; },
    } },
    Sun: 'synthetic-sun', RefreshCw: 'synthetic-refresh', Pause: 'synthetic-pause', Play: 'synthetic-play',
    EmptyState: 'synthetic-empty-state', BrailleSpinner: 'synthetic-spinner', require: forbidden,
    isStepApproved: draftComposer.isStepApproved,
  }, { filename: source, timeout: 1000 });
  return {
    requests, reads, timers,
    render(value) {
      cursor = 0; pending = []; tree = module.exports({ config: value });
      for (const { s, effect } of pending) { s.cleanup?.(); s.cleanup = effect(); }
      assert.equal(cursor, 8); return tree;
    },
    async tickIntervals(waitForCallbacks = true) {
      const active = [...timers.values()].filter(t => t.kind === 'interval');
      for (const t of active) { assert.equal(t.delay, 2000); t.fn(); }
      if (waitForCallbacks) await Promise.all(callbackRuns.splice(0));
    },
    async finishCallbacks() { await Promise.all(callbackRuns.splice(0)); },
    setPeriodic(value) {
      const controls = find(tree, e => e.type === 'button' && e.props['aria-label'] === 'Periodic preview refresh');
      assert.equal(controls.length, 1);
      if (controls[0].props['aria-pressed'] !== value) controls[0].props.onClick();
    },
    get intervalInstalls() { return intervalInstalls; },
    dispose() { for (const s of slots) s.cleanup?.(); assert.equal(timers.size, 0); },
  };
}
function find(tree, predicate) {
  if (!React.isValidElement(tree)) return [];
  return [...(predicate(tree) ? [tree] : []),
    ...React.Children.toArray(tree.props.children).flatMap(child => find(child, predicate))];
}
function intervalCount(d) { return [...d.timers.values()].filter(t => t.kind === 'interval').length; }

test('periodic request uses the latest parameters, mix and color settings after a config commit', async () => {
  const d = driver();
  try {
    d.render(config('old')); const old = [...d.timers.keys()];
    const latest = config('new', { mix: 0.25, colorManagement: { inputColorSpace: 'synthetic-new' } });
    d.render(latest); assert.equal(intervalCount(d), 1);
    assert(old.some(id => !d.timers.has(id)), 'Old effect timers must be cleaned up');
    await d.tickIntervals(); assert.equal(d.requests.length, 1);
    assert.deepEqual(d.requests[0], { config: latest, mix: 0.25, frame: 0 });
  } finally { d.dispose(); }
});

test('config changes outside the debounce projection also refresh the periodic callback', async () => {
  const d = driver();
  try {
    const initial = config('same', { syntheticMetadata: 'old' }); d.render(initial);
    const latest = { ...initial, syntheticMetadata: 'new' }; d.render(latest);
    await d.tickIntervals(); assert.equal(d.requests[0].config.syntheticMetadata, 'new');
    assert.equal(d.intervalInstalls, 2);
  } finally { d.dispose(); }
});

test('unchanged callback identity keeps one interval without rescheduling it on UI state renders', async () => {
  const d = driver();
  try {
    const value = config('stable'); d.render(value); d.render(value);
    assert.equal(d.intervalInstalls, 1); assert.equal(intervalCount(d), 1);
    await d.tickIntervals(); d.render(value);
    assert.equal(d.intervalInstalls, 1); assert.equal(intervalCount(d), 1);
  } finally { d.dispose(); }
});

test('periodic switch off clears its timer and on resumes using the newest config', async () => {
  const d = driver();
  try {
    const first = config('old'); d.render(first); d.setPeriodic(false); d.render(first);
    const latest = config('new'); d.render(latest); assert.equal(intervalCount(d), 0);
    await d.tickIntervals(); assert.equal(d.requests.length, 0);
    d.setPeriodic(true); d.render(latest); await d.tickIntervals();
    assert.equal(d.requests.length, 1); assert.deepEqual(d.requests[0].config, latest);
  } finally { d.dispose(); }
});

test('live-step guard still suppresses intervals until an enabled approved step exists', async () => {
  const d = driver();
  try {
    for (const chain of [[], [{ ...config('draft').chain[0], approved: false }],
      [{ ...config('disabled').chain[0], enabled: false }]]) {
      d.render(config('none', { chain })); assert.equal(intervalCount(d), 0);
      await d.tickIntervals(); assert.equal(d.requests.length, 0);
    }
    const live = config('live'); d.render(live); await d.tickIntervals();
    assert.equal(d.requests.length, 1); assert.deepEqual(d.requests[0].config, live);
  } finally { d.dispose(); }
});

test('changing config while a local request is pending does not bypass the existing inflight guard', async () => {
  let settle;
  const d = driver(count => count === 1 ? new Promise(resolve => { settle = resolve; })
    : Promise.resolve({ ok: true, mtime: 1 }));
  try {
    d.render(config('old')); await d.tickIntervals(false); assert.equal(d.requests.length, 1);
    const latest = config('new'); d.render(latest); await d.tickIntervals(false);
    assert.equal(d.requests.length, 1); assert.equal(d.reads.length, 0);
    settle({ ok: true, mtime: 1 });
    await d.finishCallbacks();
    await d.tickIntervals(); assert.equal(d.requests.length, 2);
    assert.deepEqual(d.requests[1].config, latest); assert.equal(d.reads.length, 2);
  } finally { d.dispose(); }
});
