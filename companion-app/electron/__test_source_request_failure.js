// Actual selected App effects and ClipInfoBar declarations; synthetic replies,
// fake hooks/ports only. No App/main/Electron/Resolve/probe/provider modules load.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const server = require('react-dom/server');
const icons = require(path.join(__dirname, '../node_modules/lucide-react'));
const root = path.join(__dirname, '../src');
const forbidden = () => assert.fail('No actual bridge/probe/filesystem/host/timer/module operation');
function evaluate(source, globals) {
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.React,
  } }).outputText, { module, exports: module.exports, require: forbidden,
    window: new Proxy({}, { get: forbidden }), setTimeout: forbidden, clearTimeout: forbidden, ...globals,
  }, { timeout: 1000 });
  return module.exports;
}
const parse = file => ts.createSourceFile(file, fs.readFileSync(path.join(root, file), 'utf8'),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const appAst = parse('App.tsx');
function collect(tree, predicate) {
  const result = [];
  function visit(node) { if (predicate(node)) result.push(node); ts.forEachChild(node, visit); }
  visit(tree); return result;
}
function one(items) { assert.equal(items.length, 1); return items[0]; }
const detailNode = one(collect(appAst, n => ts.isFunctionDeclaration(n) && n.name?.text === 'sourceRequestErrorDetail'));
const detail = evaluate(`${detailNode.getText(appAst)}\nmodule.exports = sourceRequestErrorDetail;`, {});
const effect = marker => one(collect(appAst, n => ts.isCallExpression(n) && ts.isIdentifier(n.expression)
  && n.expression.text === 'useEffect' && n.arguments[0].getText(appAst).includes(marker))).arguments[0];
const queryEffect = effect('if (discoveryAttemptedRef.current)');
const probeEffect = effect('const cached = config.clipMetadata?.source');
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
function context(overrides = {}) {
  const statuses = [], failures = [], adopted = [], patched = [], calls = { query: 0, probe: 0 };
  const globals = { isEditorReady: true, startup: { mode: 'host' }, config: {},
    discoveryAttemptedRef: { current: false }, reprobedKeyRef: { current: null },
    setResolveDiscovery(value) { statuses.push(value); }, onSourceProbed(value) { adopted.push(value); },
    patchSourceFromDiscovery(value) { patched.push(value); },
    setSourceRequestFailure(value) { failures.push(value); },
    setConfig: forbidden, sourceRequestErrorDetail: detail, console: { log() {}, warn() {} },
    ...overrides,
  };
  return { statuses, failures, adopted, patched, calls, globals,
    run(node) { evaluate(`module.exports = ${node.getText(appAst)};`, globals)(); } };
}

test('source rejection actual discovery catches rejection and preserves its one-attempt marker', async () => {
  const p = context(); p.globals.window = { electron: {
    queryCurrentClip() { p.calls.query++; return Promise.reject(Error('Synthetic discovery rejection')); }, probeClip: forbidden,
  } };
  p.run(queryEffect); await flush();
  assert.equal(p.statuses[0].status, 'discovering'); assert.equal(p.statuses.at(-1).status, 'request-unconfirmed');
  assert.equal(p.failures.at(-1), 'Synthetic discovery rejection');
  p.run(queryEffect); await flush(); assert.equal(p.calls.query, 1);
  assert.equal(p.adopted.length, 0); assert.equal(p.globals.discoveryAttemptedRef.current, true);
});

test('source rejection actual discovery-to-probe catches rejection without adopting metadata or retrying', async () => {
  const p = context(); p.globals.window = { electron: {
    queryCurrentClip() { p.calls.query++; return Promise.resolve({ ok: true, filePath: 'synthetic-source' }); },
    probeClip(file) { assert.equal(file, 'synthetic-source'); p.calls.probe++; return Promise.reject('Synthetic probe rejection'); },
  } };
  p.run(queryEffect); await flush();
  assert.equal(p.statuses.at(-1).status, 'request-unconfirmed'); assert.equal(p.failures.at(-1), 'Synthetic probe rejection');
  assert.equal(p.adopted.length, 0); p.run(queryEffect); await flush();
  assert.equal(p.calls.query, 1); assert.equal(p.calls.probe, 1);
});

test('source rejection actual cached reprobe retains metadata and dedup key after rejection', async () => {
  const cached = { filePath: 'synthetic-cached-source', sourceHash: 'synthetic-hash', fileName: 'cached.mov' };
  const config = { clipMetadata: { source: cached } }, before = JSON.stringify(config);
  const p = context({ config }); p.globals.window = { electron: {
    probeClip(file) { assert.equal(file, cached.filePath); p.calls.probe++; return Promise.reject(Error('Synthetic cached rejection')); },
  } };
  p.run(probeEffect); await flush();
  assert.equal(p.statuses.at(-1).status, 'request-unconfirmed'); assert.equal(p.adopted.length, 0);
  assert.equal(JSON.stringify(config), before); assert.equal(p.globals.reprobedKeyRef.current, 'synthetic-cached-source|h');
  p.run(probeEffect); await flush(); assert.equal(p.calls.probe, 1);
});

test('source rejection cached failure survives a concurrent query reporting a matching path', async () => {
  const prop = one(collect(appAst, n => ts.isJsxAttribute(n) && n.name.getText(appAst) === 'sourceRequestFailure'));
  assert.equal(prop.initializer.expression.getText(appAst), 'sourceRequestFailure');
  let resolveQuery;
  const pending = new Promise(resolve => { resolveQuery = resolve; });
  const cached = { filePath: 'synthetic-cached', sourceHash: 'synthetic-hash' };
  const p = context({ config: { clipMetadata: { source: cached } } });
  p.globals.window = { electron: {
    queryCurrentClip() { p.calls.query++; return pending; },
    probeClip() { p.calls.probe++; return Promise.reject(Error('Synthetic concurrent probe rejection')); },
  } };
  p.run(queryEffect); p.run(probeEffect); await flush();
  assert.equal(p.statuses.at(-1).status, 'request-unconfirmed');
  resolveQuery({ ok: true, filePath: cached.filePath }); await flush();
  assert.equal(p.statuses.at(-1).status, 'matched');
  assert.equal(p.failures.length, 1); assert.equal(p.failures[0], 'Synthetic concurrent probe rejection');
  assert.equal(p.adopted.length, 0); assert.equal(p.calls.query, 1); assert.equal(p.calls.probe, 1);
  // Trim handles + retime verdict refresh on EVERY discovery hit, matching path included.
  assert.equal(p.patched.length, 1); assert.equal(p.patched[0].filePath, cached.filePath);
});

test('source rejection delta retains reported success and readiness/host gating with fake ports', async () => {
  const metadata = { filePath: 'synthetic-source', sourceHash: 'synthetic-hash' };
  const p = context(); p.globals.window = { electron: {
    queryCurrentClip() { p.calls.query++; return Promise.resolve({ ok: true, filePath: metadata.filePath }); },
    probeClip() { p.calls.probe++; return Promise.resolve({ ok: true, metadata }); },
  } };
  p.run(queryEffect); await flush(); assert.equal(p.adopted.length, 1); assert.equal(p.adopted[0], metadata);
  assert.equal(p.statuses.at(-1).status, 'discovered'); assert.equal(p.failures.length, 0);
  assert.equal(p.patched.length, 1); assert.equal(p.patched[0].filePath, metadata.filePath);
  for (const node of [queryEffect, probeEffect]) {
    for (const override of [{ isEditorReady: false }, { startup: { mode: 'standalone' } }, { startup: { mode: 'legacy' } }]) {
      const held = context(override); held.run(node); await flush(); assert.equal(held.statuses.length, 0);
    }
  }
});

const clipAst = parse('components/ClipInfoBar.tsx'), declarations = [];
for (const statement of clipAst.statements) {
  if (ts.isVariableStatement(statement)) for (const d of statement.declarationList.declarations)
    declarations.push(`const ${d.name.getText(clipAst)} = ${d.initializer.getText(clipAst)};`);
  else if (ts.isFunctionDeclaration(statement)) declarations.push(statement.getText(clipAst));
}
function renderFailure(message, metadata) {
  let hook = 0;
  const component = evaluate(declarations.join('\n') + '\nmodule.exports = ClipInfoBar;', {
    React, useCallback: fn => fn, useState() { assert(hook++ < 3); return [hook === 2 ? null : false, forbidden]; },
    useRef: () => ({ current: { active: false, uncertain: false } }),
    deriveScanVerdict: () => null, BrailleSpinner: () => null,
    FileVideo: icons.FileVideo, Activity: icons.Activity, FileQuestion: icons.FileQuestion,
    FileCheck2: icons.FileCheck2, RefreshCw: icons.RefreshCw, X: icons.X, AlertTriangle: icons.AlertTriangle,
  });
  const tree = component({ metadata, resolveDiscovery: { status: 'matched' }, sourceRequestFailure: message,
    onSourceProbed: forbidden, onSourceCleared: forbidden });
  assert.equal(hook, 3); return server.renderToStaticMarkup(tree);
}

test('source rejection actual details are bounded and escaped; unconfirmed feedback stays visible with cached metadata', () => {
  const message = detail(Error('<script>synthetic()</script>\n' + 'x'.repeat(10000)));
  assert.equal(message.length, 4096); assert(message.includes('[details truncated]'));
  const unreadable = new Proxy({}, { has() { throw Error('Synthetic unreadable detail'); } });
  assert.equal(detail(unreadable), 'No usable error details were returned.');
  assert.equal(detail('  '), 'No usable error details were returned.');
  for (const metadata of [undefined, { source: { fileName: 'cached.mov', filePath: 'synthetic-cached', video: {} } }]) {
    const html = renderFailure(message, metadata);
    assert(html.includes('role="alert"') && html.includes('An automatic source metadata update is unconfirmed.'));
    assert(html.includes('Backend completion is unconfirmed.') && html.includes('No automatic retry is scheduled for this failure.'));
    assert(html.includes('&lt;script&gt;') && !html.includes('<script>'));
    assert(html.includes('aria-label="Automatic source metadata error details" tabindex="0"'));
    assert(html.includes('overflow-y:auto') && html.includes('white-space:pre-wrap'));
    assert.equal(html.includes('Cached source metadata remains displayed.'), !!metadata);
  }
});
