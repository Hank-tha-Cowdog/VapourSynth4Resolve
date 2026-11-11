// MOUNTED-UI interaction tests — the REAL components driven like a user:
// controlled hooks + real React.createElement trees, so elements can be
// FOUND and CLICKED (props invoked) and registered listeners FIRED. This is
// the "mounted UI" layer the Priority-1 review asked for — beyond store
// functions and source greps.
//
//   1. RecipeMenu with a 100-recipe library: open → all entries render;
//      search filters; Save-current form opens, a name draft TYPED into the
//      input SURVIVES Escape dismissal + reopen; outside-click closes; Apply
//      invokes the real load path and closes the popover.
//   2. CompanionChainPreview shortcuts: Shift+Z (registered window listener)
//      resets zoom when focused on a plain element and does NOTHING when
//      typing in a text field; the A/B toggle REGISTERED for the App-level
//      Cmd+W route flips processed→source→processed across repeated calls
//      (key-repeat safe); a bypass pill CLICK flips exactly that step.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const RealReact = require('react');

// ── Controlled React: real createElement, controlled hooks ─────────────────
function makeHarness() {
  const state = [], memos = [], refs = [], effects = [];
  const setterHistory = [];
  let hook = 0, effectIdx = 0;
  const depsChanged = (prev, next) =>
    !prev || prev.length !== next.length || next.some((d, i) => !Object.is(prev[i], d));
  const react = {
    createElement: RealReact.createElement,
    Fragment: RealReact.Fragment,
    useState(initial) {
      const i = hook++;
      if (state[i] === undefined) state[i] = { value: typeof initial === 'function' ? initial() : initial };
      const cell = state[i];
      const setter = (v) => { cell.value = typeof v === 'function' ? v(cell.value) : v; setterHistory.push({ i, value: cell.value }); };
      return [cell.value, setter];
    },
    useMemo(fn, deps) { const i = hook++; if (!memos[i] || depsChanged(memos[i].deps, deps)) memos[i] = { deps, value: fn() }; return memos[i].value; },
    useCallback(fn, deps) { const i = hook++; if (!memos[i] || depsChanged(memos[i].deps, deps)) memos[i] = { deps, value: fn }; return memos[i].value; },
    useRef(initial) { const i = hook++; if (!refs[i]) refs[i] = { current: initial }; return refs[i]; },
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
  return { react, setterHistory, reset: () => { hook = 0; effectIdx = 0; } };
}

// Element-tree walker (real React elements).
function findAll(tree, pred, out = []) {
  if (!RealReact.isValidElement(tree)) return out;
  if (pred(tree)) out.push(tree);
  for (const child of RealReact.Children.toArray(tree.props.children)) findAll(child, pred, out);
  return out;
}
const byText = (tree, text) =>
  findAll(tree, e => typeof e.props.children === 'string' && e.props.children.includes(text));
const byLabel = (tree, label) =>
  findAll(tree, e => {
    const a = e.props['aria-label'];
    return typeof a === 'string' &&
      (label instanceof RegExp ? label.test(a) : a === label);
  });
const byRole = (tree, role) => findAll(tree, e => e.props.role === role);

function loadComponent(relPath, sandboxWindow, sandboxDocument) {
  const filename = path.join(__dirname, '..', relPath);
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.React, esModuleInterop: true },
  }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(code, { module: mod, exports: mod.exports,
    require(name) {
      if (name === 'react') return harnessBridgeFor(filename).react;
      if (name === 'lucide-react') return new Proxy({}, { get: () => RealReact.createElement('i', {}, null) });
      if (name === './BrailleSpinner') return { BrailleSpinner: () => null };
      if (name === './ScopesPanel') return { ScopesPanel: () => null };   // canvas UI — measured separately (__test_scope_metrics)
      if (name === '../types') return {};
      if (name === '../../shared/draft-composer') return draftComposerModule();
      throw new Error(`unadmitted module request: ${name}`);
    },
    window: sandboxWindow,
    document: sandboxDocument,
    performance: { now: () => 0 },
    console, setTimeout: () => 0, clearTimeout: () => {},
    setInterval: () => 0, clearInterval: () => {},
  }, { filename, timeout: 5000 });
  return mod.exports;
}

let currentHarness = null;
function harnessBridgeFor(_filename) { return currentHarness; }

const draftComposerModule = (() => {
  const dcPath = path.join(__dirname, '../shared/draft-composer.ts');
  const dcCode = ts.transpileModule(fs.readFileSync(dcPath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  const dcModule = { exports: {} };
  vm.runInNewContext(dcCode, { module: dcModule, exports: dcModule.exports,
    require: () => { throw new Error('unexpected module request in draft-composer'); } },
    { filename: dcPath, timeout: 2000 });
  return () => dcModule.exports;
})();

// ══════════════════════════════════════════════════════════════════════════
// 1. RecipeMenu — mounted 100-recipe workflow
// ════════════════════════════════════════════════════════════════════════
test('mounted RecipeMenu: 100 recipes — open, search, draft survival, dismissal, apply', async () => {
  const N = 100;
  const recipes = Array.from({ length: N }, (_, i) => ({
    name: `Recipe ${String(i + 1).padStart(3, '0')}`, slug: `recipe-${String(i + 1).padStart(3, '0')}`,
    stepCount: (i % 7) + 1,
  }));
  const applied = [];
  const saved = [];
  const docListeners = {};   // capture-phase listeners we can FIRE
  const sandboxDocument = {
    addEventListener: (n, f) => { (docListeners[n] ||= []).push(f); },
    removeEventListener: () => {},
  };
  const sandboxWindow = {
    electron: {
      listRecipes: async () => ({ ok: true, recipes }),
      loadRecipe: async ({ slug }) => {
        const r = recipes.find(x => x.slug === slug);
        const chain = Array.from({ length: r.stepCount }, (_, k) => ({
          id: `s${k}`, type: 'script', stage: 20, enabled: true, approved: true, version: 1,
          params: { code: 'clip = clip\n' },
        }));
        return { ok: true, recipe: { schemaVersion: 1, name: r.name, chain } };
      },
      deleteRecipe: async () => ({ ok: true }),
      saveRecipe: async ({ payload }) => { saved.push(payload); return { ok: true, path: '/x', recipe: { name: payload.name, chain: [] } }; },
      saveTextFile: async () => ({ ok: true, path: '/x' }),
      openTextFile: async () => ({ ok: false, canceled: true }),
    },
    setTimeout: () => 0, clearTimeout: () => {},
  };
  const harness = makeHarness();
  currentHarness = harness;
  const { RecipeMenu } = loadComponent('src/components/RecipeMenu.tsx', sandboxWindow, sandboxDocument);
  const reset = harness.reset;
  let tree;
  const render = (props) => { reset(); tree = RecipeMenu(props); return tree; };
  const props = {
    onApply: (recipe) => applied.push(recipe),
    onSaveCurrent: async (name) => { await sandboxWindow.electron.saveRecipe({ payload: { schemaVersion: 1, name, chain: [] } }); return `Saved "${name}".`; },
  };

  render(props);
  // Async list load resolves on microtask; flush then re-render.
  await new Promise(r => setImmediate(r));
  render(props);
  const trigger = byLabel(tree, 'Recipe menu — save, apply, export or import portable chain recipes')[0];
  assert.ok(trigger, 'trigger button rendered');
  trigger.props.onClick();                       // user clicks Recipes
  render(props);
  const dialog = byRole(tree, 'dialog')[0];
  assert.ok(dialog, 'popover opens on click');
  const applyButtons = byLabel(tree, /undefined/).length; // placeholder — real check below
  // All 100 entries render in the picker (find by apply aria-labels).
  const applyAll = findAll(tree, e => typeof e.props['aria-label'] === 'string' && e.props['aria-label'].startsWith('Apply recipe '));
  assert.equal(applyAll.length, N, `all ${N} recipes are listed`);

  // Search narrows to matching names.
  const search = byLabel(tree, 'Search recipes')[0];
  assert.ok(search, 'search input rendered');
  search.props.onChange({ target: { value: '007' } });
  render(props);
  const matches = findAll(tree, e => typeof e.props['aria-label'] === 'string' && e.props['aria-label'].startsWith('Apply recipe '));
  assert.equal(matches.length, 1, 'search filters to the single matching recipe');
  assert.ok(matches[0].props['aria-label'].includes('Recipe 007'));
  search.props.onChange({ target: { value: '' } });
  render(props);

  // Save-current: open the inline form and TYPE a draft.
  const saveBtn = byLabel(tree, 'Save current chain as recipe')[0];
  assert.ok(saveBtn, 'Save current… button');
  saveBtn.props.onClick();
  render(props);
  const nameInput = byLabel(tree, 'Recipe name')[0];
  assert.ok(nameInput, 'inline name form opened');
  nameInput.props.onChange({ target: { value: 'My precious draft' } });
  render(props);
  assert.equal(byLabel(tree, 'Recipe name')[0].props.value, 'My precious draft', 'draft typed');

  // ESCAPE dismissal — the captured capture-phase keydown listener fires.
  (docListeners['keydown'] || []).forEach(f => f({ key: 'Escape', defaultPrevented: false }));
  render(props);
  assert.equal(byRole(tree, 'dialog').length, 0, 'Escape closes the popover');
  assert.equal(byLabel(tree, 'Recipe name').length, 0, 'form closed');

  // Reopen: the UNFINISHED DRAFT SURVIVED dismissal.
  byLabel(tree, 'Recipe menu — save, apply, export or import portable chain recipes')[0].props.onClick();
  render(props);
  assert.ok(byRole(tree, 'dialog')[0], 'popover reopens');
  byLabel(tree, 'Save current chain as recipe')[0].props.onClick();
  render(props);
  assert.equal(byLabel(tree, 'Recipe name')[0].props.value, 'My precious draft',
    'dismissal did NOT discard the unfinished name draft');

  // Submit the draft → real save path invoked with the draft name. The
  // popover STAYS open (showing the saved note) — close it explicitly before
  // the outside-click test instead of assuming it auto-closed.
  const form = findAll(tree, e => e.type === 'form')[0];
  form.props.onSubmit({ preventDefault() {} });
  await new Promise(r => setImmediate(r));
  render(props);
  assert.equal(saved.length, 1, 'the real saveRecipe path was invoked');
  assert.equal(saved[0].name, 'My precious draft', 'saved under the preserved draft name');
  assert.ok(byRole(tree, 'dialog')[0], 'popover stays open after save (note visible)');

  // Toggle closed, then reopen for the outside-click dismissal test.
  byLabel(tree, 'Recipe menu — save, apply, export or import portable chain recipes')[0].props.onClick();
  render(props);
  assert.equal(byRole(tree, 'dialog').length, 0, 'trigger toggles the popover closed');
  byLabel(tree, 'Recipe menu — save, apply, export or import portable chain recipes')[0].props.onClick();
  render(props);
  assert.ok(byRole(tree, 'dialog')[0]);
  (docListeners['pointerdown'] || []).forEach(f => f({ target: { nodeType: 1, ancestorOf: null } }));
  render(props);
  assert.equal(byRole(tree, 'dialog').length, 0, 'outside click closes the popover');

  // Apply from the list: real load path + onApply + close.
  byLabel(tree, 'Recipe menu — save, apply, export or import portable chain recipes')[0].props.onClick();
  render(props);
  const target = findAll(tree, e => e.props['aria-label'] === 'Apply recipe Recipe 042')[0];
  assert.ok(target, 'target recipe present');
  target.props.onClick();
  await new Promise(r => setImmediate(r));
  render(props);
  assert.equal(applied.length, 1, 'onApply received the recipe');
  assert.equal(applied[0].name, 'Recipe 042');
  assert.equal(applied[0].chain.length, recipes[41].stepCount, 'chain steps loaded');
  assert.equal(byRole(tree, 'dialog').length, 0, 'popover closes after Apply');
});

// ════════════════════════════════════════════════════════════════════════
// 2. CompanionChainPreview — mounted shortcuts + pill interaction
// ════════════════════════════════════════════════════════════════════════
test('mounted preview: Shift+Z fits (window listener), never from a text field; registered A/B flips on repeat; pill click flips one step', async () => {
  let renderCalls = [], pending = null;
  const winListeners = {};
  const sandboxWindow = {
    electron: {
      renderPreviewFrame: (req) => { renderCalls.push(req); return new Promise(r => { pending = r; }); },
    },
    addEventListener: (n, f) => { (winListeners[n] ||= []).push(f); },
    removeEventListener: () => {},
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
  };
  const harness = makeHarness();
  currentHarness = harness;
  const { CompanionChainPreview } = loadComponent('src/components/CompanionChainPreview.tsx', sandboxWindow, {
    addEventListener: () => {}, removeEventListener: () => {},
  });
  const reset = harness.reset;
  const config = {
    schemaVersion: 1, nodeId: 't', manualOrder: false,
    colorManagement: { inputColorSpace: 'Rec.709', inputGamma: 'BT.1886', outputColorSpace: 'Rec.709', outputGamma: 'BT.1886', ocioConfig: 's' },
    chain: [
      { id: 's1', type: 'script', stage: 40, enabled: true, approved: true, approvedContent: 'clip = clip\n', version: 1, params: { code: 'clip = clip\n', label: 'Denoise step' } },
      { id: 's2', type: 'script', stage: 60, enabled: true, approved: true, approvedContent: 'clip = clip\n', version: 1, params: { code: 'clip = clip\n', label: 'Sharpen step' } },
    ],
    mix: 1.0, archivist: { panelOpen: true, panelWidth: 380, selectedModelId: 'x', thinkingMode: false, autoApply: true, messages: [] },
  };
  const chainChanges = [];
  const registrations = [];
  let tree;
  const render = () => { reset(); tree = CompanionChainPreview({ config, onChainChange: c => chainChanges.push(c), onRegisterAbToggle: fn => registrations.push(fn) }); return tree; };
  render();
  await new Promise(r => setImmediate(r));
  render();
  assert.equal(renderCalls.length, 1, 'initial render started');

  // Zoom in via the wheel so Fit has something to reset.
  const viewer = byLabel(tree, /Preview viewer/)[0];
  assert.ok(viewer, 'viewer element present');
  viewer.props.onWheel({ deltaY: -100, preventDefault() {}, target: { closest: () => null } });
  render();
  let zoomSets = harness.setterHistory.filter(s => typeof s.value === 'object' && s.value && 'scale' in s.value);
  assert.equal(zoomSets[zoomSets.length - 1].value.scale, 1.15, 'wheel zoom applied');

  // Shift+Z from a NON-text target → fit resets scale to 1.
  (winListeners['keydown'] || []).forEach(f => f({
    shiftKey: true, metaKey: false, ctrlKey: false, altKey: false, preventDefault() {},
    key: 'Z', target: { closest: () => null, nodeType: 1 } }));
  zoomSets = harness.setterHistory.filter(s => typeof s.value === 'object' && s.value && 'scale' in s.value);
  assert.equal(zoomSets[zoomSets.length - 1].value.scale, 1, 'Shift+Z fits (zoom reset)');

  // Wheel again, then Shift+Z with focus in a TEXT FIELD → NO fit.
  viewer.props.onWheel({ deltaY: -100, preventDefault() {}, target: { closest: () => null } });
  render();
  (winListeners['keydown'] || []).forEach(f => f({
    shiftKey: true, metaKey: false, ctrlKey: false, altKey: false,
    key: 'Z', target: { closest: sel => sel ? { text: true } : null, nodeType: 1 } }));
  zoomSets = harness.setterHistory.filter(s => typeof s.value === 'object' && s.value && 'scale' in s.value);
  assert.equal(zoomSets[zoomSets.length - 1].value.scale, 1.15,
    'Shift+Z does NOT fire while a text field has focus');

  // A/B toggle registered for the App-level Cmd+W route; repeated calls flip.
  // Resolve the initial in-flight render first — the toggle must COALESCE
  // behind it (latest-request-wins), not start a concurrent render.
  pending?.({ ok: true, dataUrl: 'init', frame: 1, total: 2, fpsNum: 25, fpsDen: 1,
    durationS: 2, presentationTimeS: 0, width: 16, height: 9, provenance: 'draft' });
  await new Promise(r => setImmediate(r));
  assert.equal(renderCalls.length, 1, 'no extra render from the initial resolution');
  const registered = registrations.filter(f => typeof f === 'function');
  assert.equal(registered.length >= 1, true, 'the preview registered its A/B toggle');
  registered[registered.length - 1]();       // processed → source
  await new Promise(r => setImmediate(r));
  assert.equal(renderCalls.length, 2, 'A/B toggle rendered a request');
  assert.equal(renderCalls[1].mode, 'source', 'first Cmd+W shows source');
  pending?.({ ok: true, dataUrl: 'x', frame: 1, total: 2, fpsNum: 25, fpsDen: 1,
    durationS: 2, presentationTimeS: 0, width: 16, height: 9, provenance: 'draft' });
  await new Promise(r => setImmediate(r));
  render();   // sync baseModeRef with the settled state (as React would)
  registered[registered.length - 1]();       // source → processed (key repeat safe)
  await new Promise(r => setImmediate(r));
  // The second flip lands on a CACHED frame ('processed'@t0 from the initial
  // render): renderTime returns early — ZERO new render calls, zero runaway
  // renders on repeated presses. The persistent mode state still flips.
  assert.equal(renderCalls.length, 2, 'cached flip: no new render call (coalesced from cache)');
  // Identify the persistent baseMode cell by VALUE PATTERN (cell indices are
  // hook-order artifacts): some state cell ≠ shownMode(3) received 'source'
  // (toggle 1) and then 'processed' (toggle 2) — the persistent mode flipped
  // both ways across repeated presses.
  const byCell = new Map();
  for (const s of harness.setterHistory) {
    if (s.value === 'source' || s.value === 'processed') {
      if (!byCell.has(s.i)) byCell.set(s.i, []);
      byCell.get(s.i).push(s.value);
    }
  }
  const flippedMode = [...byCell.entries()].find(([i, vals]) =>
    i !== 3 && vals[vals.length - 1] === 'processed' && vals.includes('source'));
  assert.ok(flippedMode, 'the persistent A/B mode flipped source → processed across repeated Cmd+W presses');

  // Bypass pill CLICK flips exactly the targeted step, nothing else.
  render();
  const pillBtn = byLabel(tree, /^Bypass Denoise step/)[0];
  assert.ok(pillBtn, 'bypass pill for the denoise step rendered');
  pillBtn.props.onClick();
  assert.equal(chainChanges.length, 1, 'onChainChange fired once');
  const flipped = chainChanges[0].find(s => s.id === 's1');
  const untouched = chainChanges[0].find(s => s.id === 's2');
  assert.equal(flipped.enabled, false, 'the clicked step is bypassed');
  assert.equal(untouched.enabled, true, 'the other step is untouched');
});