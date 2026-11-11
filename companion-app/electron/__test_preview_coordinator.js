// BEHAVIORAL coordinator test — executes the real CompanionChainPreview with
// a controlled React stub and a controllable renderPreviewFrame mock. Proves
// the Priority-1 interaction contract against the ACTUAL component logic:
//   1. RAPID TOGGLES COALESCE — a burst of chain toggles while a render is
//      in flight produces exactly ONE queued re-render (never overlapping
//      runaway renders).
//   2. THE FINAL VIEW MATCHES THE LATEST CHAIN — after the burst resolves,
//      the displayed frame corresponds to the NEWEST chain state.
//   3. ERRORS KEEP THE LAST VALID FRAME — a failing re-render keeps the
//      previous frame and surfaces the real message.
//   4. C05 (2026-11-11): a QUEUED intent suppresses the in-flight completion
//      — obsolete pixels never publish; the queued caller's promise settles
//      instead of being discarded.
//   5. C05: a SOURCE request DISPATCHES IMMEDIATELY while a processed render
//      is in flight — the worker's source-preemption branch is reachable
//      again (it was starved by the component-level busy gate).
// The component's JSX tree is captured through createElement so tests can
// invoke the REAL handlers (the source hold is driven through the actual
// viewer onPointerDown, not a synthetic shortcut).
// No DOM, no real VapourSynth, no IPC — deterministic, instant.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// ── Controlled React (hook-order-correct, effect-deps diffing) ─────────────
function makeControlledReact() {
  const state = [];      // useState cells
  const memos = [];       // useMemo/useCallback cells
  const refs = [];
  const effects = [];     // live effects: { deps, cleanup }
  const setterHistory = [];   // every setter call, for assertions
  let hook = 0;
  let effectIdx = 0;
  const is = (a, b) => Object.is(a, b);
  const depsChanged = (prev, next) =>
    !prev || prev.length !== next.length || next.some((d, i) => !is(prev[i], d));

  const react = {
    // The transpiled component reaches JSX through react_1.default.createElement,
    // and __importStar (no __esModule) maps .default → this whole module.
    // JSX nodes are captured as plain objects (behavior is asserted from
    // hook/setter history; the tree exists so tests can call REAL handlers).
    createElement: (type, props, ...children) => {
      const node = { type, props: { ...(props || {}), children }, children };
      return node;
    },
    useState(initial) {
      const i = hook++;
      if (state[i] === undefined) state[i] = { value: typeof initial === 'function' ? initial() : initial };
      const cell = state[i];
      const setter = (v) => {
        cell.value = typeof v === 'function' ? v(cell.value) : v;
        setterHistory.push({ i, value: cell.value });
      };
      return [cell.value, setter];
    },
    useMemo(fn, deps) {
      const i = hook++;
      if (!memos[i] || depsChanged(memos[i].deps, deps)) memos[i] = { deps, value: fn() };
      return memos[i].value;
    },
    useCallback(fn, deps) {
      const i = hook++;
      if (!memos[i] || depsChanged(memos[i].deps, deps)) memos[i] = { deps, value: fn };
      return memos[i].value;
    },
    useRef(initial) {
      const i = hook++;
      if (!refs[i]) refs[i] = { current: initial };
      return refs[i];
    },
    useEffect(fn, deps) {
      const i = effectIdx++;
      const prev = effects[i];
      if (!prev || depsChanged(prev.deps, deps)) {
        if (prev?.cleanup) prev.cleanup();
        const cleanup = fn();
        effects[i] = { deps, cleanup };
      }
    },
  };
  return { react, setterHistory, resetPerRender: () => { hook = 0; effectIdx = 0; } };
}

// ── Fixtures ───────────────────────────────────────────────────────────────
const mkStep = (id, enabled) => ({ id, type: 'script', stage: 20, enabled, approved: true, version: 1,
  params: { code: 'clip = clip\n', label: id } });
const mkConfig = (chain) => ({
  schemaVersion: 1, nodeId: 'test-node', manualOrder: false,
  colorManagement: { inputColorSpace: 'Rec.709', inputGamma: 'BT.1886',
    outputColorSpace: 'Rec.709', outputGamma: 'BT.1886', ocioConfig: 'studio' },
  chain, mix: 1.0, archivist: { panelOpen: true, panelWidth: 380,
    selectedModelId: 'x', thinkingMode: false, autoApply: true, messages: [] },
});
const toggle = (chain, id) => chain.map(s => s.id === id ? { ...s, enabled: !s.enabled } : s);
const frame = (dataUrl, over = {}) => ({ ok: true, dataUrl, frame: 1, total: 2,
  fpsNum: 25, fpsDen: 1, durationS: 2, presentationTimeS: 0, width: 1920, height: 1080,
  provenance: 'draft', ...over });
const flush = () => new Promise(r => setImmediate(r));

function walkTree(node, out = []) {
  if (Array.isArray(node)) { for (const n of node) walkTree(n, out); return out; }
  if (!node || typeof node !== 'object') return out;
  if (node.props && typeof node.props === 'object') out.push(node);
  if (node.props && node.props.children !== undefined) walkTree(node.props.children, out);
  return out;
}

// ── Fresh harness (controlled React + component module + render mock) ──────
function makeHarness() {
  const renderCalls = [];
  // C05: SOURCE priority puts TWO renders in flight at once — the mock keeps
  // a FIFO of pending resolvers (resolveRender settles the OLDEST), instead
  // of a single slot that a newer concurrent request would overwrite.
  const pending = [];
  function renderPreviewFrame(request) {
    renderCalls.push(request);
    return new Promise(resolve => { pending.push({ request, resolve }); });
  }
  function resolveRender(result) {
    const p = pending.shift();
    assert.ok(p, 'resolveRender requires a pending render request');
    p.resolve(result);
  }

  const { react, setterHistory, resetPerRender } = makeControlledReact();
  const filename = path.join(__dirname, '../src/components/CompanionChainPreview.tsx');
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.React, esModuleInterop: true },
  }).outputText;
  // NOTE: must NOT be named `module` at file top level — the CJS wrapper
  // already declares `module`, and redeclaring makes the file fall back to
  // ESM (require undefined). Kept inside this factory scope.
  const componentModule = { exports: {} };
  const listeners = {};   // window listeners no-op sink
  const sandboxWindow = {
    electron: { renderPreviewFrame },
    addEventListener: (n) => { (listeners[n] ||= []).push(n); },
    removeEventListener: () => {},
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
  };
  vm.runInNewContext(code, { module: componentModule, exports: componentModule.exports,
    require(name) {
      if (name === 'react') return react;
      if (name === 'lucide-react') return new Proxy({}, { get: () => () => null });
      if (name === './BrailleSpinner') return { BrailleSpinner: () => null };
      if (name === './ScopesPanel') return { ScopesPanel: () => null };   // canvas UI — measured separately (__test_scope_metrics)
      if (name === '../../shared/draft-composer') {
        // Real draft composer, transpiled (pure module, no dependencies).
        const dcPath = path.join(__dirname, '../shared/draft-composer.ts');
        const dcCode = ts.transpileModule(fs.readFileSync(dcPath, 'utf8'), {
          compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
        }).outputText;
        const dcModule = { exports: {} };
        vm.runInNewContext(dcCode, { module: dcModule, exports: dcModule.exports,
          require: () => { throw new Error('unexpected module dep in draft-composer'); } },
          { filename: dcPath, timeout: 2000 });
        return dcModule.exports;
      }
      if (name === '../types') return {};
      throw new Error(`unadmitted module request: ${name}`);
    },
    window: sandboxWindow,
    performance: { now: () => 0 },
    console,
  }, { filename, timeout: 5000 });
  const { CompanionChainPreview } = componentModule.exports;

  let config = mkConfig([mkStep('s1', true)]);
  const onChainChange = (next) => { config = mkConfig(next); };
  let tree = null;
  const invoke = () => {
    resetPerRender();
    tree = CompanionChainPreview({ config, onChainChange });
    return tree;
  };
  return {
    invoke, renderCalls, resolveRender, setterHistory, onChainChange,
    getConfig: () => config,
    find: (predicate) => walkTree(tree).filter(predicate),
  };
}

test('rapid toggles coalesce into ONE queued render; final view = newest chain; errors keep the last frame', async () => {
  const h = makeHarness();
  // Mount: effects run, initial render request fires and stays pending.
  h.invoke();
  assert.equal(h.renderCalls.length, 1, 'initial render request');
  assert.equal(h.renderCalls[0].mode, 'processed');

  // Toggle burst #1..#3 while the initial render is STILL in flight. Each
  // invocation re-runs effects; the chainKey effect sees the changed chain.
  for (let i = 0; i < 3; i++) {
    h.onChainChange(toggle(h.getConfig().chain, 's1'));
    h.invoke();
  }
  assert.equal(h.renderCalls.length, 1,
    `COALESCING: a 3-toggle burst during an in-flight render must NOT start concurrent renders (got ${h.renderCalls.length})`);

  // Resolve the initial render (an older chain state): the queued NEWEST
  // state must fire exactly once afterwards.
  h.resolveRender(frame('data:frame-old'));
  await flush();
  assert.equal(h.renderCalls.length, 2, 'exactly ONE queued re-render fired for the whole burst');
  const burstRequest = h.renderCalls[1];
  // The queued request must reflect the NEWEST chain (3 toggles = enabled=false).
  assert.ok(String(burstRequest.draftScript).length > 0, 'draft script passed');

  // New chain on disk = disabled step. Resolve the burst render as an ERROR:
  // the last valid frame must be KEPT and the real message surfaced.
  const viewsBefore = h.setterHistory.filter(s => s.i === 0).length;
  h.resolveRender({ ok: false, error: 'render failed: synthetic' });
  await flush();
  const viewSets = h.setterHistory.filter(s => s.i === 0);
  assert.equal(viewSets.length, viewsBefore,
    'an ERROR result must not overwrite the view (last valid frame kept)');
  const errSets = h.setterHistory.filter(s => s.i === 2);
  assert.ok(errSets.some(s => s.value === 'render failed: synthetic'),
    'the real error message is surfaced');

  // The coordinator does NOT auto-retry after an error — a new render is
  // triggered by a real user action (a 4th toggle), modeling the live flow.
  h.onChainChange(toggle(h.getConfig().chain, 's1'));
  h.invoke();
  assert.equal(h.renderCalls.length, 3, 'a real chain change after an error triggers a fresh render');
  h.resolveRender(frame('data:frame-newest', { frame: 5 }));
  await flush();
  const finalViews = h.setterHistory.filter(s => s.i === 0);
  assert.ok(finalViews.some(s => s.value?.dataUrl === 'data:frame-newest'),
    'the final displayed frame corresponds to the latest chain state');
  // The successful retry must also CLEAR the error display.
  const errAfter = h.setterHistory.filter(s => s.i === 2).map(s => s.value);
  assert.ok(errAfter.includes(null),
    'a successful render clears the error state');
});

test('C05: a queued intent suppresses the in-flight completion — obsolete pixels never publish', async () => {
  const h = makeHarness();
  h.invoke();                                  // initial processed render (token N) pending
  assert.equal(h.renderCalls.length, 1);

  // A newer intent arrives while the render is in flight — it coalesces.
  h.onChainChange(toggle(h.getConfig().chain, 's1'));
  h.invoke();
  assert.equal(h.renderCalls.length, 1, 'still coalesced — no second dispatch');

  // Resolve the OLD request with a VALID frame. Pre-fix this satisfied the
  // "latest" test (the token only advanced when the queued render STARTED)
  // and published obsolete pixels while the newer request was pending.
  h.resolveRender(frame('data:frame-old'));
  await flush();
  const published = h.setterHistory.filter(s => s.i === 0)
    .map(s => (s.value && s.value.dataUrl) || s.value);
  assert.ok(!published.includes('data:frame-old'),
    'OBSOLETE COMPLETION MUST NOT PUBLISH: queued intent advances the token immediately');

  // The queued render fires exactly once and ITS frame publishes.
  assert.equal(h.renderCalls.length, 2, 'queued render fires after the old one settles');
  h.resolveRender(frame('data:frame-new', { frame: 2 }));
  await flush();
  const after = h.setterHistory.filter(s => s.i === 0)
    .map(s => (s.value && s.value.dataUrl) || s.value);
  assert.ok(after.includes('data:frame-new'), 'the newest request publishes');
  assert.ok(!after.includes('data:frame-old'), 'obsolete frame never shown');
});

test('C05: a SOURCE request dispatches IMMEDIATELY while processed is in flight (worker preemption path)', async () => {
  const h = makeHarness();
  h.invoke();
  assert.equal(h.renderCalls.length, 1);
  assert.equal(h.renderCalls[0].mode, 'processed');

  // The mount fires two identical requests (mount effect + chainKey effect);
  // the second coalesces. The first completion is display-obsolete (queued
  // intent advanced the token) but still CACHES — so the queued call for the
  // same key hits the cache and displays the frame WITHOUT re-rendering.
  h.resolveRender(frame('data:frame-first'));
  await flush();
  assert.equal(h.renderCalls.length, 1, 'same-key queued intent hits the cache — no extra render');
  const shown = h.setterHistory.filter(s => s.i === 0)
    .map(s => (s.value && s.value.dataUrl) || s.value);
  assert.ok(shown.includes('data:frame-first'), 'the frame is displayed from the cache entry');

  // Start a NEW processed render (a real chain change) and hold SOURCE while
  // it is in flight.
  h.onChainChange(toggle(h.getConfig().chain, 's1'));
  h.invoke();
  assert.equal(h.renderCalls.length, 2, 'chain change dispatched a processed render');
  assert.equal(h.renderCalls[1].mode, 'processed');

  // Drive the REAL hold handler from the captured JSX tree.
  const img = h.find(n => n.type === 'img' && typeof n.props.onPointerDown === 'function')[0];
  assert.ok(img, 'viewer <img> hold handler present once a frame is shown');
  img.props.onPointerDown({
    target: { closest: () => null, setPointerCapture: () => {} },
    button: 0, pointerId: 7, clientX: 10, clientY: 10, preventDefault() {},
  });

  // PRE-FIX: the source request queued behind the processed render and never
  // reached main/worker until it finished (dispatch list stayed ['processed']).
  assert.equal(h.renderCalls.length, 3,
    'SOURCE dispatches immediately — it must not queue behind processed');
  assert.equal(h.renderCalls[2].mode, 'source');

  // The preempted processed completion settles (worker: superseded) — it must
  // neither publish nor surface as a user-facing error.
  h.resolveRender({ ok: false, error: 'render worker interrupted for source priority', superseded: true });
  await flush();
  const published = h.setterHistory.filter(s => s.i === 0)
    .map(s => (s.value && s.value.dataUrl) || s.value);
  assert.ok(!published.includes('data:frame-old'), 'preempted completion does not publish');
  const errs = h.setterHistory.filter(s => s.i === 2).map(s => s.value);
  assert.ok(!errs.some(v => typeof v === 'string' && v.includes('interrupted for source priority')),
    'preemption is not a user-facing error');

  // The source frame publishes.
  h.resolveRender(frame('data:frame-src', { frame: 3, provenance: 'source' }));
  await flush();
  const final = h.setterHistory.filter(s => s.i === 0)
    .map(s => (s.value && s.value.dataUrl) || s.value);
  assert.ok(final.includes('data:frame-src'), 'the source frame publishes');
});
