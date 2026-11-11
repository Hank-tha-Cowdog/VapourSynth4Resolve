// Actual preload arrow and ClipInfoBar callbacks; fake File/ports/hooks only.
// No Electron, disk-backed File, dialog, probe process, browser or native module.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const server = require('react-dom/server');
const icons = require(path.join(__dirname, '../node_modules/lucide-react'));
const forbidden = () => assert.fail('No actual File/path lookup/dialog/probe/IPC/timer/module operation');
const parse = (relative, kind) => ts.createSourceFile(relative,
  fs.readFileSync(path.join(__dirname, relative), 'utf8'), ts.ScriptTarget.Latest, true, kind);
const clipAst = parse('../src/components/ClipInfoBar.tsx', ts.ScriptKind.TSX);
const declarations = [];
for (const s of clipAst.statements) {
  if (ts.isVariableStatement(s)) for (const d of s.declarationList.declarations)
    declarations.push(`const ${d.name.getText(clipAst)} = ${d.initializer.getText(clipAst)};`);
  else if (ts.isFunctionDeclaration(s)) declarations.push(s.getText(clipAst));
}
const clipCode = ts.transpileModule(declarations.join('\n') + '\nmodule.exports = ClipInfoBar;', {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.React },
}).outputText;
const preloadAst = parse('preload.js', ts.ScriptKind.JS);
function collect(tree, predicate) {
  const result = [];
  function visit(n) { if (predicate(n)) result.push(n); ts.forEachChild(n, visit); }
  visit(tree); return result;
}
function one(values) { assert.equal(values.length, 1); return values[0]; }
const getPathProperty = one(collect(preloadAst, n => ts.isPropertyAssignment(n)
  && n.name.getText(preloadAst) === 'getDroppedFilePath'));
function preloadPort(webUtils) {
  const module = { exports: {} };
  vm.runInNewContext(`module.exports = ${getPathProperty.initializer.getText(preloadAst)};`, {
    module, webUtils, ipcRenderer: new Proxy({}, { get: forbidden }), require: forbidden,
  }, { timeout: 1000 });
  return module.exports;
}
const probeAst = parse('probe.js', ts.ScriptKind.JS);
const digestNodes = probeAst.statements.filter(s => ts.isFunctionDeclaration(s)
  && ['parseFraction', 'digestProbeResult'].includes(s.name?.text)); assert.equal(digestNodes.length, 2);
const digestModule = { exports: {} };
vm.runInNewContext(digestNodes.map(n => n.getText(probeAst)).join('\n') + '\nmodule.exports = digestProbeResult;', {
  module: digestModule, path, require: forbidden,
  Date: function SyntheticDate() { this.toISOString = () => '2026-10-25T00:00:00.000Z'; },
}, { timeout: 1000 });
const metadata = filePath => digestModule.exports({ streams: [{ codec_type: 'video', codec_name: 'h264',
  width: 1920, height: 1080, avg_frame_rate: '24/1', r_frame_rate: '24/1' }], format: { format_name: 'mov' } }, filePath);
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const event = file => ({ preventDefault() {}, dataTransfer: { files: file ? [file] : [] } });
function fileWithoutPath() {
  return Object.defineProperty({ name: 'synthetic-file.mov' }, 'path', { get: forbidden });
}
function find(tree, predicate) {
  if (!React.isValidElement(tree)) return;
  if (predicate(tree)) return tree;
  for (const child of React.Children.toArray(tree.props.children)) {
    const found = find(child, predicate); if (found) return found;
  }
}
function view(bridge, overrides = {}) {
  const values = [false, null, false], ref = { current: { active: false, uncertain: false } }, adopted = [];
  let hook = 0;
  const module = { exports: {} }, window = { electron: bridge };
  vm.runInNewContext(clipCode, { module, exports: module.exports, React, window,
    useState() { const index = hook++; assert(index < 3); return [values[index], value => { values[index] = value; }]; },
    useRef: () => ref, useCallback: fn => fn, deriveScanVerdict: () => null, BrailleSpinner: () => null,
    FileVideo: icons.FileVideo, Activity: icons.Activity, FileQuestion: icons.FileQuestion,
    FileCheck2: icons.FileCheck2, RefreshCw: icons.RefreshCw, X: icons.X, AlertTriangle: icons.AlertTriangle,
    require: forbidden, setTimeout: forbidden, clearTimeout: forbidden,
  }, { timeout: 1000 });
  const props = { resolveDiscovery: { status: 'idle' }, onSourceProbed(value) { adopted.push(value); },
    onSourceCleared: forbidden, ...overrides };
  function tree() { hook = 0; const value = module.exports(props); assert.equal(hook, 3); return value; }
  return { values, ref, adopted, window, tree, drop: e => tree().props.onDrop(e),
    pick: () => find(tree(), e => e.type === 'button' && e.props.onClick !== props.onSourceCleared).props.onClick(),
    html: () => server.renderToStaticMarkup(tree()) };
}

test('drop compatibility actual preload imports webUtils and forwards only the supplied File to its API', () => {
  const declaration = one(collect(preloadAst, n => ts.isVariableDeclaration(n) && ts.isObjectBindingPattern(n.name)
    && n.name.elements.some(e => e.name.getText(preloadAst) === 'webUtils')));
  assert.equal(declaration.initializer.getText(preloadAst), "require('electron')");
  const file = fileWithoutPath(); let calls = 0;
  const webUtils = { getPathForFile(value) { assert.equal(this, webUtils); assert.equal(value, file); calls++; return 'synthetic-source.mov'; } };
  assert.equal(preloadPort(webUtils)(file), 'synthetic-source.mov'); assert.equal(calls, 1);
});

test('drop compatibility actual renderer and preload use a pathless File and the exact resolved path once', async () => {
  const file = fileWithoutPath(), pathName = 'synthetic-source.mov', pending = deferred(); let paths = 0, probes = 0;
  const bridge = { getDroppedFilePath: preloadPort({ getPathForFile(value) {
    assert.equal(value, file); paths++; return pathName;
  } }), probeClip(filePath) { assert.equal(this, bridge); assert.equal(filePath, pathName); probes++; return pending.promise; } };
  const p = view(bridge), first = p.drop(event(file));
  assert.equal(paths, 1); assert.equal(probes, 1); assert.equal(p.ref.current.active, true);
  pending.resolve({ ok: true, metadata: metadata(pathName) }); await first;
  assert.equal(p.adopted.length, 1); assert.equal(p.adopted[0].filePath, pathName);
  assert.equal(p.ref.current.active, false); assert.equal(p.values[0], false);
});

test('drop compatibility absent bridge support reports no submission and permits an explicit corrected input', async () => {
  const file = fileWithoutPath(), p = view(undefined);
  await p.drop(event(file)); assert(p.values[1].includes('File drop is unavailable'));
  assert.equal(p.ref.current.active, false); assert.equal(p.ref.current.uncertain, false);
  let probes = 0;
  p.window.electron = { getDroppedFilePath: () => 'synthetic-source.mov', probeClip(filePath) {
    probes++; return { ok: true, metadata: metadata(filePath) };
  } };
  await p.drop(event(file)); assert.equal(probes, 1); assert.equal(p.adopted.length, 1);
});

test('drop compatibility empty, malformed, non-File or absent input never falls back to a spoofed File.path', async () => {
  for (const value of ['', '  ', undefined, [], 42, { then: forbidden }]) {
    const p = view({ getDroppedFilePath: () => value, probeClip: forbidden, pickClipFile: forbidden });
    await p.drop(event({ path: 'synthetic-spoofed-legacy-path' }));
    assert(p.values[1].includes('no disk-backed file path')); assert.equal(p.adopted.length, 0);
    assert.equal(p.ref.current.active, false); assert.equal(p.ref.current.uncertain, false);
  }
  const invalid = view({ getDroppedFilePath: preloadPort({ getPathForFile() { throw Error('Synthetic non-File rejection'); } }),
    probeClip: forbidden, pickClipFile: forbidden });
  await invalid.drop(event({ path: 'synthetic-spoofed-legacy-path' }));
  assert.equal(invalid.values[1], 'Synthetic non-File rejection'); assert.equal(invalid.ref.current.uncertain, false);
  const absent = view({ getDroppedFilePath: forbidden, probeClip: forbidden });
  await absent.drop(event()); assert(absent.values[1].includes('No file was supplied')); assert.equal(absent.ref.current.active, false);
});

test('drop compatibility extraction errors remain escaped and bounded before any probe request', async () => {
  const p = view({ getDroppedFilePath() { throw '<script>synthetic()</script>\n' + 'x'.repeat(10000); }, probeClip: forbidden });
  await p.drop(event(fileWithoutPath())); assert.equal(p.values[1].length, 4096); assert(p.values[1].includes('[details truncated]'));
  assert.equal(p.ref.current.active, false); assert.equal(p.ref.current.uncertain, false); assert.equal(p.values[0], false);
  const html = p.html(); assert(html.includes('&lt;script&gt;') && !html.includes('<script>'));
  assert(html.includes('Source identification error details') && html.includes('tabindex="0"') && html.includes('overflow-y:auto'));
  assert(!html.includes('Source identification outcome unconfirmed.'));
});

test('drop compatibility pending and unconfirmed probes keep later picker/drop actions away from path resolution', async () => {
  const pending = deferred(); let paths = 0, probes = 0;
  const p = view({ getDroppedFilePath() { paths++; return 'synthetic-source.mov'; },
    probeClip() { probes++; return pending.promise; }, pickClipFile: forbidden });
  const first = p.drop(event(fileWithoutPath()));
  const held = { preventDefault() {}, get dataTransfer() { return forbidden(); } };
  await p.drop(held); await p.pick(); assert.equal(paths, 1); assert.equal(probes, 1);
  pending.resolve({ ok: true, metadata: metadata('synthetic-wrong-source.mov') }); await first;
  assert.equal(p.ref.current.uncertain, true); assert.equal(p.adopted.length, 0);
  await p.drop(held); await p.pick(); assert.equal(paths, 1); assert.equal(probes, 1);
});
