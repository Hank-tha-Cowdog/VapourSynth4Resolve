// Exact production IPC callbacks, VM-loaded with fake filesystem, child and
// renderer ports only. No Electron, runtime, media, provider or real child loads.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const ast = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
function callback(channel) {
  const matches = [];
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && node.expression.expression.getText(ast) === 'ipcMain'
        && ['on', 'handle'].includes(node.expression.name.text)
        && node.arguments[0]?.text === channel) matches.push(node.arguments[1]);
    ts.forEachChild(node, visit);
  }
  visit(ast); assert.equal(matches.length, 1);
  return matches[0].getText(ast);
}
const executeSource = callback('execute-script');
const readSource = callback('plugin:read-composed-script');
const policyFunction = ast.statements.filter(ts.isFunctionDeclaration)
  .find(n => n.name?.text === 'isTrustedSender');
assert(policyFunction, 'isTrustedSender policy helper must exist in main.js');
function evaluate(body, ports) {
  return vm.runInNewContext(`(${body})`, ports, { timeout: 1000 });
}
// Compose the REAL sender policy helper with the extracted production
// callback. The arrow closes over `editorWindow` from the VM global, exactly
// like the production module scope.
function evaluatePolicy(body, ports, { destroyed = false, webContents } = {}) {
  const trustedWebContents = webContents ?? { isDestroyed: () => false };
  const editorWindow = { isDestroyed: () => destroyed, webContents: trustedWebContents };
  const fn = vm.runInNewContext(`(() => { ${policyFunction.getText(ast)}
    return (${body}); })()`, { ...ports, editorWindow }, { timeout: 1000 });
  return { fn, trustedEvent: { sender: trustedWebContents }, untrustedEvent: { sender: {} } };
}

function reader(files, failed = new Set()) {
  const reads = [], exists = [];
  const handle = evaluate(readSource, { path, os: { homedir: () => '/fixture/home' }, fs: {
    existsSync(file) { exists.push(file); return files.has(file); },
    readFileSync(file) { reads.push(file); if (failed.has(file)) throw Error('Synthetic read failure'); return files.get(file); },
  } });
  return { handle, reads, exists };
}
const dir = '/fixture/home/Library/Application Support/VapourSynth-OFX';
const node = dir + '/nodes/node-a.vpy';
const globalScript = dir + '/last-composed.vpy';

test('node script IPC reads its requested node and never the global script', () => {
  const h = reader(new Map([[node, 'NODE A'], [globalScript, 'NODE B']]));
  assert.equal(h.handle({}, { nodeGuid: 'node-a' }), 'NODE A');
  assert.deepEqual(h.reads, [node]);
});
test('missing requested node script never adopts the global script', () => {
  const h = reader(new Map([[globalScript, 'OTHER NODE']]));
  assert.equal(h.handle({}, { nodeGuid: 'node-a' }), '');
  assert.deepEqual(h.reads, []); assert.deepEqual(h.exists, [node]);
});
test('invalid textual node identities cannot fall back or traverse', () => {
  for (const nodeGuid of ['../outside', 'node/a', '', '/absolute']) {
    const h = reader(new Map([[globalScript, 'OTHER NODE']]));
    assert.equal(h.handle({}, { nodeGuid }), '');
    assert.deepEqual(h.reads, []); assert.deepEqual(h.exists, []);
  }
});
test('nontext node identities cannot silently become legacy reads', () => {
  for (const nodeGuid of [1, false, [], {}]) {
    const h = reader(new Map([[globalScript, 'OTHER NODE']]));
    assert.equal(h.handle({}, { nodeGuid }), ''); assert.deepEqual(h.reads, []);
  }
});
test('identity-free legacy requests retain their global-script compatibility', () => {
  for (const request of [undefined, {}, { nodeGuid: null }, { nodeGuid: undefined }]) {
    const h = reader(new Map([[globalScript, 'LEGACY']]));
    assert.equal(h.handle({}, request), 'LEGACY'); assert.deepEqual(h.reads, [globalScript]);
  }
});
test('a requested-node read failure never falls through to another node', () => {
  const h = reader(new Map([[node, 'NODE A'], [globalScript, 'NODE B']]), new Set([node]));
  assert.equal(h.handle({}, { nodeGuid: 'node-a' }), ''); assert.deepEqual(h.reads, [node]);
});

function executor({ runtimeExists = true, spawnThrows = false, endThrows = false,
                    sendThrows = false, destroyed = false, failedSpawn = false,
                    killEmitsError = false } = {}) {
  const messages = [], spawns = [], input = [], kills = [], probes = [];
  const child = new EventEmitter(); child.pid = failedSpawn ? undefined : 1234;
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
  child.stdin.write = value => input.push(value);
  child.stdin.end = value => { if (endThrows) throw Error('Synthetic end error'); if (value !== undefined) input.push(value); };
  child.stdin.destroy = () => { child.stdinDestroyed = true; };
  child.kill = signal => {
    kills.push(signal);
    if (killEmitsError) child.emit('error', Error('Synthetic termination refusal'));
    return !killEmitsError;
  };
  const sender = { isDestroyed: () => destroyed, send(channel, payload) { if (sendThrows) throw Error('Synthetic renderer closed'); messages.push({ channel, payload }); } };
  const { fn, trustedEvent } = evaluatePolicy(executeSource, {
    fs: { existsSync(file) { probes.push(file); return runtimeExists; } }, path,
    PATHS: { python: '/fixture/runtime/python', pythonSource: 'ofx-bundle', vsPluginPath: '/fixture/plugins' },
    process: { arch: 'arm64', env: { FIXTURE_ENV: 'inert' } },
    spawn(bin, args, options) {
      spawns.push({ bin, args: [...args], options });
      if (spawnThrows) throw Error('Synthetic synchronous spawn error'); return child;
    },
  }, { webContents: sender });
  return { handle: script => fn(trustedEvent, script), fn, trustedEvent, child, messages, spawns, input, kills, probes,
    complete: () => messages.filter(m => m.channel === 'execution-complete') };
}

// ── Sender policy (security re-review #4, 2026-11-11): execute-script serves
// ONLY this window's own renderer; anything else is refused before the
// runtime probe or spawn.
test('script IPC refuses any sender that is not this window\'s renderer, before probes or spawn', () => {
  const h = executor();
  // The untrusted sender records what (if anything) it receives back.
  const replies = [];
  h.fn({ sender: { send: (channel, payload) => replies.push({ channel, payload }) } }, 'print("synthetic")');
  assert.equal(h.probes.length, 0); assert.equal(h.spawns.length, 0);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].payload.code, 1);
  assert.match(replies[0].payload.error, /Untrusted sender/);
});
test('script IPC refuses a torn-down editor window even for the last sender identity', () => {
  const probes = [], spawns = [];
  const { fn, trustedEvent } = evaluatePolicy(executeSource, {
    fs: { existsSync(file) { probes.push(file); return true; } }, path,
    PATHS: { python: '/fixture/runtime/python', pythonSource: 'ofx-bundle', vsPluginPath: '/p' },
    process: { arch: 'arm64', env: {} },
    spawn() { spawns.push(1); throw Error('must not spawn'); },
  }, { destroyed: true });
  assert.doesNotThrow(() => fn(trustedEvent, 'x'));
  assert.equal(probes.length, 0); assert.equal(spawns.length, 0);
});

test('script IPC rejects nontext payloads before runtime lookup or child creation', () => {
  for (const script of [undefined, null, 12, {}, []]) {
    const h = executor(); h.handle(script);
    assert.equal(h.probes.length, 0); assert.equal(h.spawns.length, 0);
    assert.equal(h.complete().length, 1); assert.match(h.complete()[0].payload.error, /text/);
  }
});
test('missing runtime remains a single explicit failure with no child', () => {
  const h = executor({ runtimeExists: false }); h.handle('print("fixture")');
  assert.equal(h.spawns.length, 0); assert.equal(h.complete().length, 1);
  assert.equal(h.complete()[0].payload.error, 'Runtime Missing');
});
test('valid script is passed as stdin bytes with fixed argv and preserved runtime environment', () => {
  const h = executor(); const script = 'print("--not-an-argument")\n'; h.handle(script);
  assert.equal(h.spawns.length, 1); assert.equal(h.spawns[0].bin, '/fixture/runtime/python');
  assert.deepEqual(h.spawns[0].args, ['-']); assert.deepEqual(h.input, [script]);
  assert.equal(h.spawns[0].options.env.FIXTURE_ENV, 'inert');
  assert.equal(h.spawns[0].options.env.VAPOURSYNTH_EXTRA_PLUGIN_PATH, '/fixture/plugins');
  h.child.emit('close', 0); assert.equal(h.complete().length, 1); assert.equal(h.complete()[0].payload.code, 0);
});
test('synchronous spawn refusal is surfaced once without a completion claim of success', () => {
  const h = executor({ spawnThrows: true }); assert.doesNotThrow(() => h.handle('fixture'));
  assert.equal(h.complete().length, 1); assert.equal(h.complete()[0].payload.code, -1);
  assert.match(h.complete()[0].payload.error, /Spawn Error/);
});
test('asynchronous failed spawn is handled and its later close cannot duplicate completion', () => {
  const h = executor({ failedSpawn: true }); h.handle('fixture');
  assert.doesNotThrow(() => h.child.emit('error', Error('Synthetic EACCES')));
  h.child.emit('close', -2); assert.equal(h.complete().length, 1);
  assert.equal(h.complete()[0].payload.code, -1); assert.match(h.complete()[0].payload.error, /EACCES/);
});
test('stdin error stops only the retained child and waits for close before completion', () => {
  const h = executor(); h.handle('fixture');
  assert.doesNotThrow(() => h.child.stdin.emit('error', Error('Synthetic EPIPE')));
  assert.deepEqual(h.kills, ['SIGKILL']); assert.equal(h.child.stdinDestroyed, true);
  assert.equal(h.complete().length, 0); h.child.emit('close', null); h.child.emit('close', null);
  assert.equal(h.complete().length, 1); assert.equal(h.complete()[0].payload.code, -1);
  assert.match(h.complete()[0].payload.error, /EPIPE/);
});
test('synchronous stdin failure uses the same owned termination and close result', () => {
  const h = executor({ endThrows: true }); assert.doesNotThrow(() => h.handle('fixture'));
  assert.deepEqual(h.kills, ['SIGKILL']); assert.equal(h.complete().length, 0);
  h.child.emit('close', 0); assert.equal(h.complete().length, 1);
  assert.equal(h.complete()[0].payload.code, -1); assert.match(h.complete()[0].payload.error, /end error/);
});
test('a closed renderer cannot turn child output or completion into a main-process exception', () => {
  for (const options of [{ destroyed: true }, { sendThrows: true }]) {
    const h = executor(options); assert.doesNotThrow(() => h.handle('fixture'));
    assert.doesNotThrow(() => h.child.stdout.emit('data', 'synthetic stdout'));
    assert.doesNotThrow(() => h.child.stderr.emit('data', 'synthetic error'));
    assert.doesNotThrow(() => h.child.emit('close', 1));
  }
});
test('termination-control error does not falsely report that a live child completed', () => {
  const h = executor({ killEmitsError: true }); h.handle('fixture');
  assert.doesNotThrow(() => h.child.stdin.emit('error', Error('Synthetic EPIPE')));
  assert.equal(h.complete().length, 0);
  h.child.emit('close', 1); assert.equal(h.complete().length, 1);
  assert.match(h.complete()[0].payload.error, /EPIPE/);
});

// Preview budgets are validated by the preview module. Preserve explicit
// values at IPC so malformed settings cannot silently turn into defaults.
// The sender policy is composed in (2026-11-11): only this window's renderer
// reaches the worker; other senders are refused before forwarding.
const previewSource = callback('preview:render-frame');
test('preview IPC forwards explicit budgets and failure ownership flags unchanged', async () => {
  const forwarded = [];
  const outcome = { ok: false, timeout: true, pngOutputLimit: true,
    closureKnown: false, closureUnknown: true, noAutomaticReplay: true };
  const { fn, trustedEvent } = evaluatePolicy(previewSource,
    { renderPreviewFrame(request) { forwarded.push(request); return Promise.resolve(outcome); } });
  const result = await fn(trustedEvent, { frame: 7, timeoutMs: 60000, maxOutputBytes: 33554432, maxPngBytes: 268435456 });
  assert.equal(forwarded[0].timeoutMs, 60000);
  assert.equal(forwarded[0].maxOutputBytes, 33554432);
  assert.equal(forwarded[0].maxPngBytes, 268435456);
  assert.equal(forwarded[0].frame, 7);
  assert.equal(result, outcome);
  assert.equal(result.pngOutputLimit, true);
});
test('preview IPC refuses an untrusted sender before any worker dispatch', async () => {
  const forwarded = [];
  const { fn, untrustedEvent } = evaluatePolicy(previewSource,
    { renderPreviewFrame(request) { forwarded.push(request); return Promise.resolve({ ok: true }); } });
  const result = await fn(untrustedEvent, { frame: 1 });
  assert.equal(result.ok, false);
  assert.match(result.error, /Untrusted sender/);
  assert.equal(forwarded.length, 0);
});
test('preview IPC leaves malformed explicit budgets for central refusal', async () => {
  const forwarded = [];
  const { fn, trustedEvent } = evaluatePolicy(previewSource,
    { renderPreviewFrame(request) { forwarded.push(request); return Promise.resolve({ ok: false }); } });
  for (const timeoutMs of [0, -1, '60000', null]) {
    await fn(trustedEvent, { timeoutMs, maxOutputBytes: 'unbounded', maxPngBytes: 'unbounded' });
    assert.equal(forwarded.at(-1).timeoutMs, timeoutMs);
    assert.equal(forwarded.at(-1).maxOutputBytes, 'unbounded');
    assert.equal(forwarded.at(-1).maxPngBytes, 'unbounded');
  }
  for (const maxPngBytes of [0, -1, 1.5, NaN, Infinity, '134217728', null, { invalid: true }]) {
    await fn(trustedEvent, { maxPngBytes });
    assert.equal(forwarded.at(-1).maxPngBytes, maxPngBytes);
  }
});
