// Synthetic focus ports + actual component wiring/static React only, not a browser test.
// No settings-loading effect, provider, key value, credential bridge or network is executed.
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
  vm.runInNewContext(code, {
    module, exports: module.exports,
    require(name) {
      assert(Object.hasOwn(dependencies, name), `Unadmitted UI import: ${name}`);
      return dependencies[name];
    },
    window: new Proxy({}, { get() { throw Error('No window/credential bridge access allowed'); } }),
  }, { filename, timeout: 1000 });
  return module.exports;
}
const focus = load('services/settings-dialog-focus.ts', {});
const deps = { react: React, 'lucide-react': icons, '../services/settings-dialog-focus': focus };
const shell = load('components/SettingsDialog.tsx', deps);

function fixture() {
  const listeners = new Set(), focusCalls = [];
  const document = {
    activeElement: null,
    addEventListener(type, callback) { assert.equal(type, 'focusin'); listeners.add(callback); },
    removeEventListener(type, callback) { assert.equal(type, 'focusin'); listeners.delete(callback); },
  };
  function node(name, options = {}) {
    return {
      name, ownerDocument: document, tabIndex: 0, isConnected: true,
      ...options,
      matches(selector) { assert.equal(selector, ':disabled'); return !!this.disabled; },
      closest(selector) {
        assert.equal(selector, '[hidden], [inert], [aria-hidden="true"]');
        return this.excludedAncestor ? {} : null;
      },
      getClientRects() { return this.visible === false ? [] : [{}]; },
      focus(options) {
        assert.equal(options.preventScroll, true);
        document.activeElement = this; focusCalls.push(this.name);
        for (const listener of [...listeners]) listener({ target: this });
      },
    };
  }
  const opener = node('opener'), close = node('close'), input = node('input'), save = node('save');
  let controls = [close, input, save], preferred = close;
  const dialog = node('dialog', {
    tabIndex: -1,
    contains(target) { return target === this || controls.includes(target); },
    querySelectorAll(selector) {
      assert.equal(selector, 'button, input, select, textarea, a[href], [tabindex]');
      return controls;
    },
    querySelector(selector) { assert.equal(selector, '[data-dialog-initial-focus]'); return preferred; },
  });
  document.body = node('body'); document.activeElement = opener;
  return { document, dialog, opener, close, input, save, listeners, focusCalls, node,
    controls(value) { controls = value; }, preferred(value) { preferred = value; } };
}
function key(overrides = {}) {
  const counts = { prevented: 0, stopped: 0, closed: 0 };
  const event = { key: 'Tab', shiftKey: false, defaultPrevented: false,
    preventDefault() { counts.prevented++; }, stopPropagation() { counts.stopped++; }, ...overrides };
  return { event, counts, close() { counts.closed++; } };
}

test('opening focuses Close, escaped focus is contained, cleanup restores opener once', () => {
  const f = fixture(), dispose = focus.mountSettingsDialogFocus(f.dialog);
  assert.equal(f.document.activeElement, f.close); assert.equal(f.listeners.size, 1);
  f.opener.focus({ preventScroll: true });
  assert.equal(f.document.activeElement, f.close);
  dispose(); assert.equal(f.listeners.size, 0); assert.equal(f.document.activeElement, f.opener);
  const calls = f.focusCalls.length; dispose(); assert.equal(f.focusCalls.length, calls);
});

test('initial focus skips unavailable preferred control', () => {
  const f = fixture(); f.close.disabled = true;
  const dispose = focus.mountSettingsDialogFocus(f.dialog);
  assert.equal(f.document.activeElement, f.input); dispose();
});

test('Tab and Shift+Tab wrap at the actual eligible endpoints', () => {
  const f = fixture();
  for (const [active, shiftKey, expected] of [[f.save, false, f.close], [f.close, true, f.save]]) {
    f.document.activeElement = active; const k = key({ shiftKey });
    focus.handleSettingsDialogKey(k.event, f.dialog, k.close);
    assert.equal(f.document.activeElement, expected); assert.equal(k.counts.prevented, 1);
    assert.equal(k.counts.closed, 0);
  }
});

test('interior Tab navigation remains native', () => {
  const f = fixture(); f.document.activeElement = f.input;
  for (const shiftKey of [false, true]) {
    const k = key({ shiftKey }); focus.handleSettingsDialogKey(k.event, f.dialog, k.close);
    assert.equal(k.counts.prevented, 0); assert.equal(f.document.activeElement, f.input);
  }
});

test('disabled, hidden/inert, non-tabstop and non-rendered controls are skipped', () => {
  const f = fixture(); f.controls([f.close,
    f.node('disabled', { disabled: true }), f.node('hidden', { excludedAncestor: true }),
    f.node('no-tabstop', { tabIndex: -1 }), f.node('no-rect', { visible: false }), f.save]);
  f.document.activeElement = f.save; const k = key();
  focus.handleSettingsDialogKey(k.event, f.dialog, k.close);
  assert.equal(f.document.activeElement, f.close);
});

test('no eligible controls focus the dialog and keep Tab contained', () => {
  const f = fixture(); f.controls([]); f.preferred(null);
  const dispose = focus.mountSettingsDialogFocus(f.dialog);
  assert.equal(f.document.activeElement, f.dialog);
  const k = key(); focus.handleSettingsDialogKey(k.event, f.dialog, k.close);
  assert.equal(k.counts.prevented, 1); assert.equal(f.document.activeElement, f.dialog); dispose();
});

test('newly available controls are discovered on each key event', () => {
  const f = fixture(); f.controls([f.close]);
  const dispose = focus.mountSettingsDialogFocus(f.dialog);
  f.controls([f.close, f.input, f.save]); f.document.activeElement = f.save;
  const k = key(); focus.handleSettingsDialogKey(k.event, f.dialog, k.close);
  assert.equal(f.document.activeElement, f.close); dispose();
});

test('focus on the dialog itself enters the first or last control', () => {
  const f = fixture();
  for (const shiftKey of [false, true]) {
    f.document.activeElement = f.dialog; const k = key({ shiftKey });
    focus.handleSettingsDialogKey(k.event, f.dialog, k.close);
    assert.equal(f.document.activeElement, shiftKey ? f.save : f.close);
  }
});

test('Escape consumes the key and closes once; ordinary editing remains native', () => {
  const f = fixture(), k = key({ key: 'Escape' });
  focus.handleSettingsDialogKey(k.event, f.dialog, k.close);
  assert.deepEqual(k.counts, { prevented: 1, stopped: 1, closed: 1 });
  const edit = key({ key: 'a' }); focus.handleSettingsDialogKey(edit.event, f.dialog, edit.close);
  assert.deepEqual(edit.counts, { prevented: 0, stopped: 0, closed: 0 });
});

test('IME Escape and an already handled key do not close settings', () => {
  const f = fixture();
  for (const patch of [{ isComposing: true }, { keyCode: 229 }, { defaultPrevented: true }]) {
    const k = key({ key: 'Escape', ...patch }); focus.handleSettingsDialogKey(k.event, f.dialog, k.close);
    assert.deepEqual(k.counts, { prevented: 0, stopped: 0, closed: 0 });
  }
});

test('cleanup skips a disconnected opener and does not steal another dialog focus', () => {
  for (const scenario of ['disconnected', 'other-dialog']) {
    const f = fixture(), dispose = focus.mountSettingsDialogFocus(f.dialog);
    if (scenario === 'disconnected') f.opener.isConnected = false;
    else f.document.activeElement = f.node('other-dialog'); // Controlled cleanup branch, not browser timing.
    const prior = f.document.activeElement; dispose();
    assert.equal(f.document.activeElement, prior); assert.equal(f.listeners.size, 0);
  }
});

test('cleanup also restores the opener after focus falls to body during removal', () => {
  const f = fixture(), dispose = focus.mountSettingsDialogFocus(f.dialog);
  f.document.activeElement = f.document.body; dispose();
  assert.equal(f.document.activeElement, f.opener);
});

test('actual shell wires its lifecycle, Escape and click controls to local callbacks', () => {
  const f = fixture(), effects = []; let closed = 0, nextId = 0;
  const controlled = load('components/SettingsDialog.tsx', { ...deps, react: {
    ...React, useRef: () => ({ current: f.dialog }), useEffect: effect => effects.push(effect),
    useId: () => `synthetic-${nextId++}`,
  } }).SettingsDialog;
  const tree = controlled({ onClose() { closed++; }, children: React.createElement('p', null, 'Synthetic content') });
  assert.equal(effects.length, 1); const dispose = effects[0]();
  assert.equal(f.document.activeElement, f.close);
  const dialog = tree.props.children, k = key({ key: 'Escape', nativeEvent: { isComposing: false } });
  dialog.props.onKeyDown(k.event); assert.equal(closed, 1);
  let stopped = 0; dialog.props.onClick({ stopPropagation() { stopped++; } });
  assert.equal(stopped, 1); assert.equal(closed, 1);
  const header = React.Children.toArray(dialog.props.children)[0];
  const close = React.Children.toArray(header.props.children).find(child => child.props['data-dialog-initial-focus'] !== undefined);
  assert(close); close.props.onClick(); tree.props.onClick(); assert.equal(closed, 3);
  dispose(); assert.equal(f.document.activeElement, f.opener); assert.equal(f.listeners.size, 0);
});

test('actual SettingsModal renders the labelled shell without invoking its credential effect', () => {
  const spinner = load('components/BrailleSpinner.tsx', { react: React });
  const settings = load('components/SettingsModal.tsx', {
    react: React, 'lucide-react': icons, './BrailleSpinner': spinner, './SettingsDialog': shell,
  });
  const html = server.renderToStaticMarkup(React.createElement(settings.SettingsModal, {
    onClose() { assert.fail('No close action during server rendering'); },
  }));
  const dialog = html.match(/<div[^>]*role="dialog"[^>]*>/)[0];
  assert(dialog.includes('aria-modal="true"') && dialog.includes('tabindex="-1"'));
  for (const attribute of ['aria-labelledby', 'aria-describedby']) {
    const id = dialog.match(new RegExp(`${attribute}="([^"]+)"`))[1];
    assert(html.includes(`id="${id}"`));
  }
  assert(html.includes('LLM Provider Settings') && html.includes('Press Escape to close settings.'));
  assert(html.includes('aria-label="Close provider settings"'));
  assert(html.includes('min-width:44px') && html.includes('min-height:44px'));
  assert(html.includes('Loading providers'));
});
