// Synthetic callback wiring + actual React static semantics; no native keyboard/browser proof.
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
    window: new Proxy({}, { get() { throw Error('No bridge/provider access in library checks'); } }),
  }, { filename, timeout: 1000 });
  return module.exports;
}
const constants = load('constants.ts', { 'lucide-react': icons });
const cst = load(path.join('..', 'shared', 'cst-transform.ts'));
const libraryModule = load('components/FilterLibrary.tsx', {
  react: React, 'lucide-react': icons, '../constants': constants,
  '../../shared/cst-transform': cst,
});
const { FilterLibrary } = libraryModule;
function find(tree, label) {
  if (!React.isValidElement(tree)) return undefined;
  if (tree.props['aria-label'] === label) return tree;
  for (const child of React.Children.toArray(tree.props.children)) {
    const found = find(child, label); if (found) return found;
  }
}
const noAdd = () => assert.fail('Opening/collapsing must not add or execute a filter');

test('collapsed library exposes a native, labelled, enabled reopening button', () => {
  const tree = FilterLibrary({ width: 260, collapsed: true, onToggleCollapse() {}, onAdd: noAdd });
  const control = find(tree, 'Open Filter Library');
  assert(control, 'Collapsed library must retain a reachable native control');
  assert.equal(control.type, 'button'); assert.equal(control.props.type, 'button');
  assert.notEqual(control.props.disabled, true); assert.equal(control.props['aria-expanded'], false);
  assert.equal(tree.props.onClick, undefined, 'Reopening must belong to the button, not a click-only aside');
});

test('actual collapse/reopen callbacks round-trip without adding a filter', () => {
  let collapsed = false, toggles = 0;
  const props = () => ({ width: 260, collapsed, onToggleCollapse() { collapsed = !collapsed; toggles++; }, onAdd: noAdd });
  const collapse = find(FilterLibrary(props()), 'Collapse Filter Library');
  assert.equal(collapse.type, 'button'); assert.equal(collapse.props['aria-expanded'], true);
  collapse.props.onClick(); assert.equal(collapsed, true);
  const reopen = find(FilterLibrary(props()), 'Open Filter Library');
  reopen.props.onClick(); assert.equal(collapsed, false); assert.equal(toggles, 2);
  assert(find(FilterLibrary(props()), 'Collapse Filter Library'));
});

test('real React static markup retains labelled controls and the expanded filter contents', () => {
  for (const collapsed of [true, false]) {
    const html = server.renderToStaticMarkup(React.createElement(FilterLibrary, {
      width: 260, collapsed, onToggleCollapse() {}, onAdd: noAdd,
    }));
    assert(html.includes('aria-label="Filter Library"'));
    const label = collapsed ? 'Open Filter Library' : 'Collapse Filter Library';
    const control = html.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))[0];
    assert(control.includes('type="button"') && control.includes(`aria-expanded="${!collapsed}"`));
    assert(control.includes('min-width:44px') && control.includes('min-height:44px'));
    assert(!control.includes('disabled'));
    assert.equal(html.includes('QTGMC Deinterlace'), !collapsed);
    assert.equal(html.includes('BM3D Denoise'), !collapsed);
  }
});

// ── C09 (2026-11-11): capability TRUTH ─────────────────────────────────────
// Unavailable capabilities must never appear verified: a probe that lacks
// requirements degrades to 'missing' (the static label cannot override it),
// and RIFE's verdict comes ONLY from the live neural snapshot.
const eff = libraryModule.effectiveAvailability;

function walk(node, out = []) {
  if (Array.isArray(node)) { for (const n of node) walk(n, out); return out; }
  if (!React.isValidElement(node)) return out;
  out.push(node);
  // Function components (e.g. FilterRow) are invoked so their rendered
  // subtree — the actual row buttons — is visible. They are pure (no hooks).
  if (typeof node.type === 'function') { walk(node.type(node.props), out); return out; }
  for (const c of React.Children.toArray(node.props.children)) walk(c, out);
  return out;
}

test('C09: a probe missing EVERY requirement degrades to missing — never back to the static label', () => {
  const cas = { type: 'script', label: 'CAS', stage: 'restore', availability: 'verified',
    requires: ['cas'], description: 'd', template: '' };
  assert.equal(eff(cas, new Set()), 'missing', 'empty probe set must not keep CAS verified');
  assert.equal(eff(cas, new Set(['other'])), 'missing');
  assert.equal(eff(cas, new Set(['cas'])), 'verified');
  const multi = { type: 'script', label: 'M', stage: 'restore', availability: 'verified',
    requires: ['a', 'b'], description: 'd', template: '' };
  assert.equal(eff(multi, new Set(['a'])), 'missing', 'partial presence is still missing');
  const sep = { type: 'script', label: 'WNNM', stage: 'denoise', availability: 'separate-install',
    requires: ['wnnm'], description: 'd', template: '' };
  assert.equal(eff(sep, new Set()), 'separate-install', 'nothing-present keeps the honest separate-install label');
  assert.equal(eff(sep, new Set(['wnnm'])), 'verified', 'present requirement follows the pre-existing contract');
  // No probe at all: the curated labels stand until the probe lands.
  assert.equal(eff(cas, undefined), 'verified');
});

test('C09: RIFE availability comes from the live neural snapshot, never the static label', () => {
  const rife = { type: 'script', label: 'RIFE Interpolate (neural)', stage: 'frame-ops',
    availability: 'verified', schemaType: 'rife', requires: [], description: 'd', template: '' };
  assert.equal(eff(rife, new Set(), { rife: { usable: true } }), 'verified');
  assert.equal(eff(rife, new Set(), { rife: { usable: false } }), 'missing', 'unusable snapshot means missing');
  assert.equal(eff(rife, new Set(), { rife: undefined }), 'missing', 'unknown snapshot fails closed');
  assert.equal(eff(rife, new Set(), null), 'missing');
  assert.equal(eff(rife, new Set(), undefined), 'missing', 'no snapshot at all means missing');
});

test('C09: rendered RIFE row is disabled without live inference evidence and addable with it', () => {
  const btn = tree => walk(tree).find(n => n.type === 'button'
    && typeof n.props.title === 'string' && n.props.title.startsWith('vsmlrt.RIFE'));
  const base = { width: 260, collapsed: false, onToggleCollapse() {}, onAdd: noAdd };
  const unusable = btn(FilterLibrary({ ...base, registeredNamespaces: new Set(), neural: { rife: { usable: false } } }));
  assert.ok(unusable, 'RIFE row rendered');
  assert.equal(unusable.props.disabled, true, 'unusable RIFE must not be addable');
  const verified = btn(FilterLibrary({ ...base, registeredNamespaces: new Set(), neural: { rife: { usable: true } } }));
  assert.equal(verified.props.disabled, false, 'inference-verified RIFE is addable');
  const unknown = btn(FilterLibrary({ ...base, registeredNamespaces: new Set() }));
  assert.equal(unknown.props.disabled, true, 'no snapshot: RIFE is NOT presumed usable');
});
