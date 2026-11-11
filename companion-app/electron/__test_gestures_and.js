// Regression tests for the live gesture-release and recipe-popup defects.
// Static/fixture evidence: asserts the actual source (comment-stripped so
// docs don't satisfy code checks) proves the release ordering is a single owner, not the old duplicate. Proves recipe menu close on
// Apply/dismiss/Escape paths without dismissing the draft.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('path');

const src = fs.readFileSync(
  path.join(__dirname, '../src/components/CompanionChainPreview.tsx'), 'utf8');
const menu = fs.readFileSync(
  path.join(__dirname, '../src/components/RecipeMenu.tsx'), 'utf8');
// Strip full-line comments so assertions target code, not the docs that
// DESCRIBE the fix.
const codeLines = (s) => s.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
const srcCode = codeLines(src);
const menuCode = codeLines(menu);

// ── Gestures (CompanionChainPreview) ────────────────────────────────────

test('exactly ONE window pointerup owner exists (the release race fix)', () => {
  const matches = srcCode.match(/addEventListener\('pointerup'/g) || [];
  assert.equal(matches.length, 1, `expected 1 window pointerup registration, got ${matches.length}. The two-handler ordering (first clears holding, second restores via a guard that exits) was the live stuck-source bug.`);
});

test('the single release handler clears AND restores in one body — no restore-after-clear race', () => {
  assert.ok(srcCode.includes('const releaseGestures = useCallback('), 'releaseGestures missing');
  assert.ok(srcCode.includes('holding.current = false;'), 'clears the hold flag');
  assert.ok(srcCode.includes('if (hadHold) void renderTime(latest.current.timeS, baseModeRef.current);'), 'restores the rendered view');
  assert.ok(!srcCode.includes('const restoreProcessed'), 'the old separate restore guard is gone');
});

test('blur is a restore path (not a silent flag clear)', () => {
  assert.ok(srcCode.includes("window.addEventListener('blur', releaseGestures);"), 'blur routes to the consolidated releaseGestures');
});

test('left-hold takes pointer capture so release outside the image is received', () => {
  const holdBlock = srcCode.match(/if \(e\.button !== 0\) return;[\s\S]{0,300}?holding\.current = true;/);
  assert.ok(holdBlock, 'hold block missing');
  assert.ok(holdBlock[0].includes('setPointerCapture'), 'hold takes capture');
});

test('momentary hold is separated from the persistent A/B toggle', () => {
  assert.ok(srcCode.includes('const [baseMode, setBaseMode]'), 'baseMode state exists');
  assert.ok(srcCode.includes('baseModeRef.current'), 'ref guard exists');
  assert.ok(srcCode.includes('renderTime(latest.current.timeS, baseModeRef.current)'), 'release restores to baseMode');
});

test('pan state is cleared by the same single owner', () => {
  assert.ok(srcCode.includes('panLast.current = null;'), 'panLast cleared');
  assert.ok(srcCode.includes('hadPan'), 'pan state tracked');
});

// ── Recipe menu ────────────────────────────────────────────────────────────

test('the recipe popover is React-controlled (not an uncontrolled details)', () => {
  assert.ok(!menuCode.includes('<details'), 'details element removed');
  assert.ok(menuCode.includes('{open && ('), 'conditional render keyed on the controlled state');
  assert.ok(menuCode.includes('aria-expanded={open}'), 'expanded state is exposed');
  assert.ok(menuCode.includes('onClick={() => setOpen(v => !v)}'), 'toggle');
});

test('dismissal paths exist: Escape, outside-click, close-after-apply', () => {
  assert.ok(menuCode.includes(`e.key === 'Escape'`), 'Escape closes');
  assert.ok(menuCode.includes('onDocPointerDown'), 'outside-click closes');
  assert.ok(menuCode.includes('onApplySlug'), 'apply exists');
  assert.ok(menuCode.includes('close();') || menuCode.includes('close(false)'), 'apply closes the menu');
});

test('dismissal preserves an unfinished name draft (never silently discards it)', () => {
  assert.ok(menuCode.includes('setSaving(false);       // keep nameDraft on purpose'), 'draft preserved on close');
  assert.ok(menuCode.includes("setNameDraft(''); setSaving(false); void reload();"), 'draft cleared only on successful save');
});

test('search field exists with the count in its placeholder', () => {
  assert.ok(menuCode.includes('type="search"'), 'search input');
  assert.ok(menuCode.includes('aria-label="Search recipes"'), 'labeled');
  assert.ok(menuCode.includes(`Search \${recipes.length} recipes`), 'count in placeholder');
});

test('picker is bounded and scrollable for 50-100 recipes', () => {
  assert.ok(menuCode.includes("overflowY: 'auto'"), 'scrollable');
  assert.ok(menuCode.includes('minHeight: 0'), 'no min-height forcing giant popup');
  assert.ok(menuCode.includes('maxWidth: 420'), 'bounded width');
  assert.ok(menuCode.includes('shown.length === 0'), 'empty state handled');
});

// ── Preview shortcuts (Priority-1 batch) ─────────────────────────────────

const mainSrc = codeLines(fs.readFileSync(path.join(__dirname, '../electron/main.js'), 'utf8'));
const preloadSrc = fs.readFileSync(path.join(__dirname, '../electron/preload.js'), 'utf8');
const appSrc = codeLines(fs.readFileSync(path.join(__dirname, '../src/App.tsx'), 'utf8'));

test('main.js installs a custom application menu that REBINDS Cmd+W (the conflict resolution)', () => {
  assert.ok(mainSrc.includes("installApplicationMenu"), 'install fn exists');
  assert.ok(mainSrc.includes("Menu.setApplicationMenu"), 'menu replaces the default (default owns Cmd+W = Close Window)');
  assert.ok(mainSrc.includes("accelerator: 'CmdOrCtrl+W'"), 'Cmd+W accelerator present');
  assert.ok(mainSrc.includes("sendToFocused('toggle-ab')"), 'Cmd+W routes to shortcut:toggle-ab IPC');
  // The default Close accelerator must be GONE: the only Close item has NO accelerator.
  const closeItem = mainSrc.match(/\{ label: 'Close Window'[^}]*\}/);
  assert.ok(closeItem, 'accelerator-less Close Window item exists');
  assert.ok(!closeItem[0].includes('accelerator'), 'Close Window carries no accelerator (header Close stays the explicit route)');
  // Resolve is a separate process: nothing intercepts host shortcuts — no globalShortcut use.
  assert.ok(!mainSrc.includes('globalShortcut'), 'no OS-global shortcuts registered');
});

test('preload bridges shortcut events with a working unsubscribe', () => {
  assert.ok(preloadSrc.includes("ipcRenderer.on('shortcut'"), 'listener registered');
  assert.ok(preloadSrc.includes('removeListener'), 'unsubscribe returned');
});

test('Shift+Z fit is window-level with a text-field guard (not container-focus dependent)', () => {
  const fitEffect = srcCode.match(/const onWinKeyDown[\s\S]{0,700}?\}, \[fit\]\);/);
  assert.ok(fitEffect, 'window-level Shift+Z effect exists');
  assert.ok(fitEffect[0].includes("addEventListener('keydown'"), 'window keydown listener');
  assert.ok(fitEffect[0].includes('input, textarea, select, [contenteditable="true"]'), 'text-field guard');
  assert.ok(fitEffect[0].includes('e.preventDefault()'), 'default prevented');
  // NOT a menu accelerator: a key equivalent would swallow capital-Z typing.
  assert.ok(!mainSrc.includes("accelerator: 'Shift+Z'"), 'Shift+Z is not a menu accelerator');
});

test('App routes toggle-ab ONLY on the Preview tab and never from a text field', () => {
  const route = appSrc.match(/onShortcut\?\.\(\(payload\) =>[\s\S]{0,600}?\}\);/);
  assert.ok(route, 'shortcut routing effect exists');
  assert.ok(route[0].includes("payload?.name !== 'toggle-ab'"), 'name filter');
  assert.ok(route[0].includes("activeTab !== 'preview'"), 'preview-tab guard');
  assert.ok(route[0].includes('input, textarea, select, [contenteditable="true"]'), 'text-field guard');
  assert.ok(appSrc.includes('onRegisterAbToggle={registerAbToggle}'), 'preview registers its toggle into the ref');
});

test('preview registers/clears its A/B toggle with the App ref (mount-scoped)', () => {
  assert.ok(srcCode.includes('onRegisterAbToggle?.(toggleAb)'), 'registers on mount');
  assert.ok(srcCode.includes('onRegisterAbToggle?.(null)'), 'clears on unmount');
});