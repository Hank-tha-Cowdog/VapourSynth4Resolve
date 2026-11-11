// Actual PreviewPanel callback and presentation, fake hook storage/IPC/clock and
// inert timer callbacks only. No full App/Electron/main/native/media/provider load.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const server = require('react-dom/server');
const icons = require(path.join(__dirname, '../node_modules/lucide-react'));
const root = path.join(__dirname, '../src/components');
const forbidden = () => assert.fail('No real IPC, clock, timer, image, native or provider operation');
const compile = file => ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020,
    jsx: ts.JsxEmit.React, esModuleInterop: true },
}).outputText;
function load(code, imports, globals = {}) {
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports,
    require(name) { assert(Object.hasOwn(imports, name), `Unadmitted import: ${name}`); return imports[name]; },
    window: new Proxy({}, { get: forbidden }), performance: new Proxy({}, { get: forbidden }),
    setTimeout: forbidden, clearTimeout: forbidden, setInterval: forbidden, clearInterval: forbidden, ...globals,
  }, { timeout: 1000 });
  return module.exports;
}
const spinner = load(compile('BrailleSpinner.tsx'), { react: React });
// Real shared draft-composer (pure; no deps): PreviewPanel's live-step gate
// uses isStepApproved (content-bound approval, 2026-11-11).
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
const compiled = compile('PreviewPanel.tsx');
const config = Object.freeze({ chain: Object.freeze([Object.freeze({ id: 'synthetic-step', type: 'script',
  enabled: true, approved: true, approvedContent: 'clip = source\n',
  params: Object.freeze({ code: 'clip = source' }), stage: 10 })]),
  mix: 0.75, colorManagement: Object.freeze({ inputColorSpace: 'Rec.709' }) });
const image = 'data:image/png;base64,c3ludGhldGlj';
function find(tree, predicate) {
  if (!React.isValidElement(tree)) return [];
  return [...(predicate(tree) ? [tree] : []), ...React.Children.toArray(tree.props.children).flatMap(child => find(child, predicate))];
}
function harness(bridge, initial = { status: 'idle' }) {
  const values = [initial, false, true], refs = [], effects = [], timers = [], writes = [];
  let hook = 0, ref = 0, tick = 0;
  const react = { ...React,
    useState() { const index = hook++; assert(index < 3); return [values[index], next => {
      values[index] = typeof next === 'function' ? next(values[index]) : next; writes.push({ index, value: values[index] });
    }]; },
    useRef(value) { const index = ref++; return refs[index] ??= { current: value }; },
    useCallback: callback => callback,
    useEffect: effect => effects.push(effect),
  };
  const schedule = kind => (callback, delay) => {
    const timer = { kind, callback, delay, cleared: false }; timers.push(timer); return timer;
  };
  const { PreviewPanel } = load(compiled, { react, 'lucide-react': icons, './BrailleSpinner': spinner,
    '../../shared/draft-composer': draftComposer }, {
    window: { electron: bridge }, performance: { now: () => tick += 10 },
    setTimeout: schedule('timeout'), setInterval: schedule('interval'),
    clearTimeout: timer => { timer.cleared = true; }, clearInterval: timer => { timer.cleared = true; },
  });
  function view() {
    hook = 0; ref = 0; effects.length = 0;
    const tree = PreviewPanel({ config }); assert.equal(hook, 3); assert.equal(ref, 1);
    const buttons = find(tree, e => e.type === 'button');
    const render = buttons.find(e => e.props.title === 'Request the current chain as a single-frame preview');
    const periodic = buttons.find(e => e.props['aria-label'] === 'Periodic preview refresh');
    return { tree, render, periodic, html: server.renderToStaticMarkup(tree) };
  }
  return { view, values, refs, effects, timers, writes };
}
function assertUnconfirmed(h, previousImage = false) {
  assert.equal(h.values[0].status, 'unconfirmed'); assert.equal(h.refs[0].current, true);
  const v = h.view(); assert.equal(v.render.props.disabled, true); assert.equal(v.periodic.props.disabled, true);
  assert(v.html.includes('Preview outcome unconfirmed') && v.html.includes('Periodic refresh held'));
  assert(v.html.includes('The earlier request may still be running.'));
  assert(v.html.includes('Further preview requests are held in this view.'));
  assert(v.html.includes('aria-label="Unconfirmed preview request" tabindex="0"'));
  assert.equal((v.html.match(/role="alert"/g) || []).length, 1);
  assert(!v.html.includes('role="status"') && !v.html.includes('aria-label="loading"') && !v.html.includes('Waiting for preview'));
  assert.equal(v.html.includes('Previous preview still shown.'), previousImage);
  return v;
}
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject }; };

test('preview rejection synchronous invocation fault resolves into unconfirmed feedback without releasing admission', async () => {
  let calls = 0;
  const h = harness({ previewChain() { calls++; throw Error('Synthetic invocation fault'); }, readPreviewImage: forbidden });
  await h.view().render.props.onClick();
  const v = assertUnconfirmed(h); assert(v.html.includes('Synthetic invocation fault'));
  await v.render.props.onClick(); assert.equal(calls, 1);
});

test('preview rejection delayed promise rejection blocks duplicate manual and all inert automatic triggers', async () => {
  const d = deferred(); let calls = 0;
  const h = harness({ previewChain() { calls++; return d.promise; }, readPreviewImage: forbidden });
  const first = h.view(), pending = first.render.props.onClick();
  assert.equal(h.values[0].status, 'rendering'); await first.render.props.onClick(); assert.equal(calls, 1);
  d.reject(Error('Synthetic transport rejection')); await pending;
  const v = assertUnconfirmed(h); assert(v.html.includes('Synthetic transport rejection'));
  // Execute only fake scheduling ports, then invoke their captured callbacks directly.
  const cleanup = h.effects.map(effect => effect());
  assert.deepEqual(h.timers.map(t => [t.kind, t.delay]), [['timeout', 600], ['timeout', 200], ['interval', 2000]]);
  for (const timer of h.timers) await timer.callback();
  await v.render.props.onClick(); assert.equal(calls, 1); assert.equal(h.refs[0].current, true);
  cleanup.forEach(stop => stop?.()); assert(h.timers.every(t => t.cleared));
});

test('preview rejection image-read throw or rejection retains the previous frame and exposes the unknown outcome', async () => {
  for (const rejectAsync of [false, true]) {
    let previews = 0, reads = 0;
    const h = harness({ previewChain() { previews++; return Promise.resolve({ ok: true, mtime: 22 }); },
      readPreviewImage() { reads++; const error = Error('Synthetic image transport fault');
        if (rejectAsync) return Promise.reject(error); throw error; },
    }, { status: 'ready', dataUrl: image, lastMtime: 11 });
    await h.view().render.props.onClick(); const v = assertUnconfirmed(h, true);
    assert.equal(h.values[0].dataUrl, image); assert.equal(h.values[0].lastMtime, 11);
    assert.equal(find(v.tree, e => e.type === 'img')[0].props.src, image);
    assert(v.html.includes('Synthetic image transport fault')); await v.render.props.onClick();
    assert.equal(previews, 1); assert.equal(reads, 1);
  }
});

test('preview rejection structurally unreadable resolved replies stay unconfirmed instead of throwing out of the callback', async () => {
  for (const badImageReply of [false, true]) {
    const h = harness({ previewChain: () => Promise.resolve(badImageReply ? { ok: true } : null),
      readPreviewImage: badImageReply ? () => Promise.resolve(null) : forbidden });
    await h.view().render.props.onClick(); assertUnconfirmed(h);
  }
});

test('preview rejection diagnostics are bounded escaped and resilient to absent or unreadable details', async () => {
  const detail = '<img src=x onerror="synthetic()">\n' + 'x'.repeat(5000);
  const longError = Error(detail);
  const unreadable = { get message() { throw Error('Synthetic unreadable error'); } };
  for (const reason of [longError, '', null, unreadable]) {
    const h = harness({ previewChain: () => Promise.reject(reason), readPreviewImage: forbidden });
    await h.view().render.props.onClick(); const v = assertUnconfirmed(h), stored = h.values[0].error;
    assert(stored.length <= 4096); assert(v.html.includes('overflow-wrap:anywhere') && v.html.includes('white-space:pre-wrap'));
    if (reason === longError) {
      assert.equal(stored.length, 4096); assert(stored.endsWith('\n[details truncated]'));
      assert(v.html.includes('&lt;img') && !v.html.includes('<img src=x'));
    } else assert.equal(stored, 'No usable error details were returned.');
  }
});

test('preview rejection handling leaves the existing reported-success image path intact', async () => {
  let previews = 0, reads = 0;
  const h = harness({ previewChain(chain, mix, timecode) {
    previews++; assert.equal(chain, JSON.stringify(config)); assert.equal(mix, 0.75); assert.equal(timecode, 0);
    return Promise.resolve({ ok: true, mtime: previews });
  }, readPreviewImage() { reads++; return Promise.resolve({ ok: true, dataUrl: image }); } });
  for (const count of [1, 2]) {
    await h.view().render.props.onClick(); assert.equal(h.values[0].status, 'ready');
    assert.equal(h.values[0].lastMtime, count); assert.equal(h.values[0].dataUrl, image);
    assert.equal(h.refs[0].current, false); assert.equal(h.view().render.props.disabled, false);
  }
  assert.equal(previews, 2); assert.equal(reads, 2);
});

test('preview rejection known missing bridge method reports unavailable before any request is invoked', async () => {
  for (const bridge of [undefined, { previewChain: forbidden }, { readPreviewImage: forbidden }]) {
    const h = harness(bridge); await h.view().render.props.onClick();
    assert.equal(h.values[0].status, 'error'); assert.equal(h.values[0].error, 'Preview IPC unavailable.');
    assert.equal(h.refs[0].current, false); assert(!h.view().html.includes('Preview outcome unconfirmed'));
  }
});
