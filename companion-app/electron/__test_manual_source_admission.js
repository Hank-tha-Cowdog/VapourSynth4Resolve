// Actual ClipInfoBar callbacks with fake hooks, finite synthetic replies and React
// SSR. No dialogs, media files, Electron/probe/Resolve/provider modules or timers.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const server = require('react-dom/server');
const icons = require(path.join(__dirname, '../node_modules/lucide-react'));
const filename = path.join(__dirname, '../src/components/ClipInfoBar.tsx');
const ast = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const selected = [];
for (const s of ast.statements) {
  if (ts.isVariableStatement(s)) for (const d of s.declarationList.declarations)
    selected.push(`const ${d.name.getText(ast)} = ${d.initializer.getText(ast)};`);
  else if (ts.isFunctionDeclaration(s)) selected.push(s.getText(ast));
}
const code = ts.transpileModule(selected.join('\n') + '\nmodule.exports = ClipInfoBar;', {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.React },
}).outputText;
const forbidden = () => assert.fail('No actual dialog/file/probe/timer/module/host operation');
// Evaluate only the producer's pure digest/fraction declarations on invented
// ffprobe JSON. Full probe.js and its filesystem/process functions never load.
const probeAst = ts.createSourceFile('probe.js', fs.readFileSync(path.join(__dirname, 'probe.js'), 'utf8'),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const producerDeclarations = probeAst.statements.filter(s => ts.isFunctionDeclaration(s)
  && ['parseFraction', 'digestProbeResult'].includes(s.name?.text));
assert.equal(producerDeclarations.length, 2);
const producerModule = { exports: {} };
vm.runInNewContext(producerDeclarations.map(s => s.getText(probeAst)).join('\n') + '\nmodule.exports = digestProbeResult;', {
  module: producerModule, path, require: forbidden,
  Date: function SyntheticDate() { this.toISOString = () => '2026-10-25T00:00:00.000Z'; },
}, { timeout: 1000 });
const fixture = (filePath = 'synthetic-drop.mov') => producerModule.exports({
  streams: [{ codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080,
    avg_frame_rate: '30000/1001', r_frame_rate: '30000/1001', pix_fmt: 'yuv420p', bits_per_raw_sample: '8' }],
  format: { format_name: 'mov', duration: '1', bit_rate: '100000', size: '1234' },
}, filePath);
function find(tree, predicate) {
  if (!React.isValidElement(tree)) return;
  if (predicate(tree)) return tree;
  for (const child of React.Children.toArray(tree.props.children)) {
    const found = find(child, predicate); if (found) return found;
  }
}
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject }; };
function drop(filePath = 'synthetic-drop.mov') {
  let prevented = 0;
  return { event: { preventDefault() { prevented++; }, dataTransfer: { files: [{ path: filePath }] } },
    prevented: () => prevented };
}
function view(bridge, overrides = {}) {
  // This path property is invented fixture data for the fake preload port only;
  // the component must use getDroppedFilePath, never the removed Electron field.
  if (bridge && !Object.hasOwn(bridge, 'getDroppedFilePath')) bridge.getDroppedFilePath = file => file.path;
  const values = [false, null, false], ref = { current: { active: false, uncertain: false } }, adopted = [];
  let hook = 0;
  const module = { exports: {} };
  const globals = { module, exports: module.exports, React,
    useCallback: fn => fn, useRef: () => ref,
    useState() { const index = hook++; assert(index < 3); return [values[index], value => { values[index] = value; }]; },
    deriveScanVerdict: () => null, BrailleSpinner: () => React.createElement('span', { 'data-synthetic-spinner': 'yes' }),
    FileVideo: icons.FileVideo, Activity: icons.Activity, FileQuestion: icons.FileQuestion,
    FileCheck2: icons.FileCheck2, RefreshCw: icons.RefreshCw, X: icons.X, AlertTriangle: icons.AlertTriangle,
    window: { electron: bridge }, require: forbidden, setTimeout: forbidden, clearTimeout: forbidden,
  };
  vm.runInNewContext(code, globals, { filename, timeout: 1000 });
  const props = { metadata: undefined, resolveDiscovery: { status: 'idle' },
    onSourceProbed(value) { adopted.push(value); }, onSourceCleared: forbidden, ...overrides };
  function tree() { hook = 0; const t = module.exports(props); assert.equal(hook, 3); return t; }
  return { values, ref, adopted, globals, props, tree,
    pick() { return find(tree(), e => e.type === 'button' && e.props.onClick !== props.onSourceCleared).props.onClick(); },
    drop(event) { return tree().props.onDrop(event); },
    html() { return server.renderToStaticMarkup(tree()); },
  };
}

test('manual source synchronous admission blocks rapid picker/drop entries until reported cancellation', async () => {
  const pending = deferred(); let picks = 0;
  const p = view({ pickClipFile() { picks++; return pending.promise; }, probeClip: forbidden });
  const first = p.pick(); assert.equal(p.values[0], true); assert.equal(p.ref.current.active, true);
  await p.pick(); const event = drop(); await p.drop(event.event);
  assert.equal(event.prevented(), 1); assert.equal(picks, 1);
  pending.resolve({ ok: false, canceled: true }); await first;
  assert.equal(p.ref.current.active, false); assert.equal(p.values[0], false); assert.equal(p.values[1], null);
  await p.pick(); assert.equal(picks, 2, 'A reported cancellation releases only this local admission');
});

test('manual source picker-to-probe keeps one admission and adopts exactly the reported metadata', async () => {
  const pending = deferred(), metadata = fixture(' synthetic-picked.mov '); let picks = 0, probes = 0;
  Object.assign(metadata, { sourceHash: 'synthetic-hash', sourceSize: 1234, sourceMtimeMs: 1,
    sourceInPoint: 0, sourceOutPoint: 29, fileMissing: false, retimeDetected: false });
  Object.assign(metadata.video, { detectedScanType: 'progressive', scanConfidence: 0.9,
    scanBreakdown: { tff: 0, bff: 0, progressive: 10, undetermined: 0, total: 10 },
    mediainfo: { scanType: 'Progressive', scanOrder: null, scanTypeOriginal: null,
      scanOrderOriginal: null, format: null, formatProfile: null, codecId: null } });
  const bridge = { pickClipFile() { assert.equal(this, bridge); picks++; return { ok: true, filePath: ' synthetic-picked.mov ' }; },
    probeClip(file) { assert.equal(this, bridge); assert.equal(file, ' synthetic-picked.mov '); probes++; return pending.promise; } };
  const p = view(bridge), first = p.pick(); await Promise.resolve();
  await p.pick(); await p.drop(drop().event); assert.equal(picks, 1); assert.equal(probes, 1);
  pending.resolve({ ok: true, metadata }); await first;
  assert.equal(p.adopted.length, 1); assert.equal(p.adopted[0], metadata);
  assert.equal(p.ref.current.active, false); assert.equal(p.values[0], false); assert.equal(p.values[1], null);
});

test('manual source picker rejection is caught and holds further requests without reading another dropped path', async () => {
  let picks = 0;
  const p = view({ pickClipFile() { picks++; return Promise.reject(Error('Synthetic picker rejection')); }, probeClip: forbidden });
  await p.pick(); assert.equal(p.values[1], 'Synthetic picker rejection');
  assert.equal(p.ref.current.uncertain, true); assert.equal(p.ref.current.active, true); assert.equal(p.values[0], true);
  await p.pick(); await p.drop({ preventDefault() {}, get dataTransfer() { return forbidden(); } });
  assert.equal(picks, 1); assert.equal(p.adopted.length, 0);
  assert.equal(find(p.tree(), e => e.type === 'button').props.disabled, true);
});

test('manual source drop probe rejection retains cached props and prevents a picker or another probe', async () => {
  const metadata = { source: { fileName: 'synthetic-cached.mov', video: {} } }, before = JSON.stringify(metadata); let probes = 0;
  const p = view({ pickClipFile: forbidden, probeClip() { probes++; return Promise.reject('Synthetic probe rejection'); } }, { metadata });
  await p.drop(drop().event); assert.equal(p.values[1], 'Synthetic probe rejection');
  assert.equal(p.ref.current.uncertain, true); assert.equal(p.adopted.length, 0);
  assert.equal(JSON.stringify(metadata), before); await p.pick(); await p.drop(drop().event); assert.equal(probes, 1);
});

test('manual source bridge absence before invocation releases local admission with an explicit error', async () => {
  const absent = view(undefined); await absent.pick();
  assert.equal(absent.values[1], 'File picker IPC unavailable.'); assert.equal(absent.values[0], false);
  assert.equal(absent.ref.current.active, false); assert.equal(absent.ref.current.uncertain, false);
  absent.globals.window.electron = { pickClipFile: () => ({ ok: false, canceled: true }) };
  await absent.pick(); assert.equal(absent.values[1], null);
  const noProbe = view({ pickClipFile: () => ({ ok: true, filePath: 'synthetic-source.mov' }) });
  await noProbe.pick(); assert.equal(noProbe.values[1], 'ffprobe IPC unavailable.'); assert.equal(noProbe.values[0], false);
  assert.equal(noProbe.ref.current.uncertain, false); assert.equal(noProbe.adopted.length, 0);
});

test('manual source malformed or failed replies retain uncertainty instead of releasing admission', async () => {
  for (const reply of [undefined, {}, [], { ok: true }, { ok: false, error: 'Synthetic refusal' },
    { ok: false, canceled: true, error: 'Synthetic contradiction' },
    { ok: false, canceled: true, filePath: 'synthetic-conflict' },
    { ok: true, canceled: true, filePath: 'synthetic-conflict' }]) {
    const p = view({ pickClipFile: () => reply, probeClip: forbidden }); await p.pick();
    assert.equal(p.ref.current.uncertain, true); assert.equal(p.values[0], true); assert.equal(p.adopted.length, 0);
  }
  for (const reply of [undefined, {}, [], { ok: false, error: 'Synthetic probe failure' },
    { ok: true, metadata: [] }, { ok: true, metadata: {} },
    { ok: true, metadata: fixture(), error: 'Synthetic contradictory metadata' },
    ...[
      { filePath: 'synthetic-other-source' }, { probedAt: 'not-a-date' }, { video: 'wrong shape' }, { video: [] },
      { video: { ...fixture().video, codec: 42 } }, { video: { ...fixture().video, fps: '29.97' } },
      { audio: 'wrong shape' }, { sourceHash: {} },
    ].map(patch => ({ ok: true, metadata: { ...fixture(), ...patch } }))]) {
    const p = view({ probeClip: () => reply }); await p.drop(drop().event);
    assert.equal(p.ref.current.uncertain, true); assert.equal(p.values[0], true); assert.equal(p.adopted.length, 0);
  }
});

test('manual source synchronous invocation or adoption faults cannot silently release a submitted operation', async () => {
  let picks = 0;
  const sync = view({ pickClipFile() { picks++; throw Error('Synthetic invoked throw'); } });
  await sync.pick(); await sync.pick(); assert.equal(picks, 1); assert.equal(sync.ref.current.uncertain, true);
  let adoptions = 0;
  const adoption = view({ probeClip: () => ({ ok: true, metadata: fixture() }) }, {
    onSourceProbed() { adoptions++; throw Error('Synthetic adoption fault'); },
  });
  await adoption.drop(drop().event); assert.equal(adoptions, 1); assert.equal(adoption.ref.current.uncertain, true);
  assert.equal(adoption.values[1], 'Synthetic adoption fault'); assert.equal(adoption.ref.current.active, true);
});

test('manual source actual uncertainty markup keeps bounded escaped details and independent automatic failure feedback', async () => {
  for (const metadata of [undefined, { source: { fileName: 'synthetic-cached.mov', video: {} } }]) {
    const p = view({ pickClipFile: () => Promise.reject('<script>synthetic()</script>\n' + 'x'.repeat(10000)) },
      { metadata, sourceRequestFailure: 'Synthetic earlier automatic failure' });
    await p.pick(); assert.equal(p.values[1].length, 4096); assert(p.values[1].includes('[details truncated]'));
    const html = p.html();
    assert(html.includes('Source identification outcome unconfirmed.') && html.includes('Another manual request is held in this view.'));
    assert(html.includes('Backend completion is unconfirmed') && html.includes('this view does not retry or confirm recovery.'));
    assert(html.includes('&lt;script&gt;') && !html.includes('<script>'));
    assert(html.includes('Source identification error details') && html.includes('tabindex="0"') && html.includes('overflow-y:auto'));
    assert(html.includes('Synthetic earlier automatic failure'));
    assert(!html.includes('Identifying source…') && !html.includes('data-synthetic-spinner'));
    const controls = React.Children.toArray(p.tree().props.children).filter(e => React.isValidElement(e) && e.type === 'button');
    if (!metadata) assert.equal(controls[0].props.disabled, true);
  }
});
