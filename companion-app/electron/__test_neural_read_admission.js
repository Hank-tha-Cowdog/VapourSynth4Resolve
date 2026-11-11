// Exact neural source with inert filesystem/admission/helper ports only.
// No model payload, manager filesystem, interpreter, child or helper is touched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, 'neural-capability.js'), 'utf8');

function fixture(config = {}) {
  const home = '/fixture/home';
  const root = path.join(home, 'Library/Application Support/VapourSynth-OFX/models');
  const dir = path.join(root, 'vsmlrt-models-v15.16');
  const models = path.join(dir, 'models'), rife = path.join(models, 'rife'), weight = path.join(rife, 'inert.onnx');
  const adapter = path.join(home, 'Library/Application Support/VapourSynth-OFX/vs-python/vsmlrt.py');
  const python = '/fixture/python', helper = '/fixture/probe_rife.py';
  const nodes = new Map([[dir, { type: 'directory', ino: 1 }], [models, { type: 'directory', ino: 2 }],
    [rife, { type: 'directory', ino: 3 }], [weight, { type: 'file', ino: 4 }]]);
  const calls = { query: [], metadata: [], enumerate: [], helper: [], probe: [] };
  const admission = { ok: true, root, dir, exists: config.exists !== false,
    completion: config.managed ? 'verified' : 'missing', legacy: config.exists !== false && !config.managed,
    identity: config.exists === false ? null : { dev: 1, ino: 1 },
    ...(config.managed ? { completionIdentity: { dev: 1, ino: 10, mtimeMs: 1 } } : {}) };
  const apiPorts = {
    existsSync(file) {
      if (file === rife) return config.exists !== false;
      if (file === adapter || file === python) return true;
      assert.fail('Unadmitted existence lookup: ' + file);
    },
    lstatSync(file) {
      calls.metadata.push(['lstat', file]);
      const node = nodes.get(file);
      if (!node) throw Object.assign(new Error('synthetic missing path'), { code: 'ENOENT' });
      if (node.error) throw Object.assign(new Error(node.error), { code: node.code || 'EACCES' });
      return { dev: 1, ino: node.ino, size: node.size ?? 1, mtimeMs: node.mtimeMs ?? 1, ctimeMs: 1,
        nlink: node.nlink ?? (node.type === 'file' ? 1 : 2),
        isDirectory: () => node.type === 'directory', isFile: () => node.type === 'file',
        isSymbolicLink: () => node.type === 'symlink' };
    },
    realpathSync(file) {
      calls.metadata.push(['realpath', file]);
      const node = nodes.get(file); assert(node, 'Only inert known paths resolve');
      return node.real || file;
    },
    readdirSync(file) {
      calls.enumerate.push(file); assert.equal(file, rife);
      if (config.enumerationError) throw Object.assign(new Error('synthetic directory unreadable'), { code: 'EACCES' });
      return config.names || ['inert.onnx'];
    },
  };
  if (config.configure) config.configure({ nodes, root, dir, models, rife, weight, admission });
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module, exports: module.exports,
    process: { env: { VSRES_SAMPLE_PYTHON: python, ...(config.env || {}) }, resourcesPath: '/fixture/Resources' },
    require(name) {
      if (name === 'fs') return apiPorts;
      if (name === 'path') return path;
      if (name === 'os') return { homedir: () => home };
      if (name === './model-manager') return { inspectModelForRead(id) {
        assert.equal(id, 'vsmlrt-models-v15.16'); calls.query.push(id);
        return config.query ? config.query(calls.query.length, admission) : admission;
      } };
      if (name === './prod-paths') return { helperScript(name) {
        assert.equal(name, 'probe_rife.py'); calls.helper.push(name); return helper;
      } };
      if (name === 'child_process') return { spawn() { assert.fail('No child may spawn in admission tests'); } };
      if (name === './probe-process') return { async runProbeProcess(spawn, binary, argv, options, defaults, overrides) {
        assert.equal(typeof spawn, 'function'); assert.equal(binary, python);
        assert.deepEqual([...argv], [helper]); assert.deepEqual([...options.stdio], ['ignore', 'pipe', 'pipe']);
        assert.equal(defaults.kind, 'neural'); assert.equal(defaults.timeoutMs, 300_000);
        assert.equal(defaults.maxOutputBytes, 4 * 1024 * 1024);
        calls.probe.push({ binary, argv: [...argv], overrides });
        if (config.onProbe) config.onProbe({ nodes, admission });
        return config.result || { ok: true, code: 0, signal: null, closed: true,
          stdout: '{"ok":true,"level":"inference","backend":"inert-backend","model":"inert-model"}\n' };
      } };
      throw new Error('Unadmitted neural dependency: ' + name);
    },
  }, { filename: 'neural-read-admission.js', timeout: 1000 });
  return { api: module.exports, calls, nodes, admission, paths: { root, dir, models, rife, weight } };
}
const BASELINE = process.env.VSRES_NEURAL_ADMISSION_BASELINE === '1';
const CONTROLS = new Set(['owned and managed refusals precede enumeration', 'static directory aliases refuse',
  'ONNX aliases and nonordinary leaves refuse', 'custom roots refuse before query or helper', 'changed admission rejects late inference']);
function method(name, run) { if (!BASELINE || CONTROLS.has(name)) test('neural model admission: ' + name, run); }
function unusable(result) { assert.equal(result.ok, true); assert.equal(result.rife.usable, false); }

method('ordinary legacy weights retain inference with explicit unverified provenance', async () => {
  const h = fixture(); const overrides = { timeoutMs: 600_000 };
  const result = await h.api.capabilitySnapshot(overrides);
  assert.equal(result.rife.usable, true); assert.equal(result.state.legacy, true);
  assert.match(result.rife.detail, /manual weights, provenance unverified/);
  assert.equal(h.calls.query.length, 2); assert.equal(h.calls.probe.length, 1);
  assert.equal(h.calls.probe[0].overrides, overrides);
});

method('ordinary managed weights retain normal inference without a pinned-payload claim', async () => {
  const h = fixture({ managed: true }); const result = await h.api.capabilitySnapshot();
  assert.equal(result.rife.usable, true); assert.equal(result.rife.level, 'inference');
  assert.equal(result.state.legacy, false); assert.equal(h.calls.probe.length, 1);
  assert(!/pinned|trusted payload|checksum verified/i.test(result.rife.detail));
});

method('owned and managed refusals precede enumeration', async () => {
  for (const error of ['container alias refused', 'invalid completion marker', 'extraction unverified flag',
    'download active', 'extraction active', 'owned child close unknown']) {
    const h = fixture({ query: () => ({ ok: false, error, recovery: 'Synthetic recovery' }) });
    const result = await h.api.capabilitySnapshot(); unusable(result);
    assert.equal(result.rife.detail, error); assert.equal(result.rife.noAutomaticReplay, true);
    assert.equal(h.calls.enumerate.length, 0); assert.equal(h.calls.metadata.length, 0);
    assert.equal(h.calls.helper.length, 0); assert.equal(h.calls.probe.length, 0);
  }
});

method('static directory aliases refuse', async () => {
  for (const target of ['dir', 'models', 'rife']) {
    const h = fixture({ configure(ctx) { ctx.nodes.get(ctx[target]).type = 'symlink'; } });
    const result = await h.api.capabilitySnapshot(); unusable(result);
    assert.equal(h.calls.enumerate.length, 0); assert.equal(h.calls.probe.length, 0);
  }
  const h = fixture({ configure(ctx) { ctx.nodes.get(ctx.models).real = '/fixture/outside/models'; } });
  unusable(await h.api.capabilitySnapshot()); assert.equal(h.calls.enumerate.length, 0);
});

method('ONNX aliases and nonordinary leaves refuse', async () => {
  for (const patch of [{ type: 'symlink' }, { type: 'directory' }, { type: 'fifo' }, { nlink: 2 },
    { real: '/fixture/outside/weights.onnx' }]) {
    const h = fixture({ configure(ctx) { Object.assign(ctx.nodes.get(ctx.weight), patch); } });
    unusable(await h.api.capabilitySnapshot()); assert.equal(h.calls.probe.length, 0);
  }
});

method('custom roots refuse before query or helper', async () => {
  const h = fixture({ env: { VSRES_MODELS_ROOT: '/fixture/custom/models' } });
  const result = await h.api.capabilitySnapshot(); unusable(result);
  assert.equal(result.rife.reason, 'model-root-unqualified');
  assert.equal(h.calls.query.length, 0); assert.equal(h.calls.enumerate.length, 0);
  assert.equal(h.calls.metadata.length, 0); assert.equal(h.calls.probe.length, 0);
});

method('missing containers and empty ordinary weights stay unavailable without probing', async () => {
  for (const h of [fixture({ exists: false }), fixture({ names: ['notes.txt'] })]) {
    const result = await h.api.capabilitySnapshot(); unusable(result);
    assert.equal(result.rife.level, 'weights'); assert.equal(h.calls.probe.length, 0);
    if (!h.admission.exists) assert.equal(result.state.legacy, false);
  }
});

method('unreadable or missing model paths return structured unavailability', async () => {
  const h = fixture({ enumerationError: true });
  const result = await h.api.capabilitySnapshot(); unusable(result);
  assert.equal(result.rife.unknown, true); assert.match(result.rife.detail, /could not be inspected/);
  assert.equal(h.calls.probe.length, 0);
  const missing = fixture({ configure(ctx) { ctx.nodes.delete(ctx.models); } });
  unusable(await missing.api.capabilitySnapshot()); assert.equal(missing.calls.probe.length, 0);
});

method('changed admission rejects late inference', async () => {
  const h = fixture({ query: (count, admitted) => count === 1 ? admitted
    : { ok: false, error: 'Synthetic extraction began during probe', recovery: 'Wait for completion' } });
  const result = await h.api.capabilitySnapshot(); unusable(result);
  assert.equal(result.rife.unknown, true); assert.equal(result.rife.noAutomaticReplay, true);
  assert.equal(h.calls.query.length, 2); assert.equal(h.calls.probe.length, 1);
});

method('changed fixed-path or completion identity cannot publish stale inference', async () => {
  for (const managed of [false, true]) {
    const h = fixture({ managed, onProbe({ nodes, admission }) {
      if (managed) admission.completionIdentity.ino++;
      else for (const node of nodes.values()) if (node.type === 'file') node.ino++;
    } });
    unusable(await h.api.capabilitySnapshot()); assert.equal(h.calls.probe.length, 1);
  }
});

method('probe stop closure truth survives a later read-admission refusal', async () => {
  const h = fixture({ query: (count, admitted) => count === 1 ? admitted : { ok: false, error: 'Synthetic pending extraction' },
    result: { ok: false, reason: 'probe-timeout', error: 'Synthetic stop', closed: false,
      cleanupUnconfirmed: true, stopError: 'Synthetic kill refusal' } });
  const result = await h.api.capabilitySnapshot(); unusable(result);
  assert.equal(result.rife.reason, 'probe-timeout'); assert.equal(result.rife.closed, false);
  assert.equal(result.rife.cleanupUnconfirmed, true); assert.equal(result.rife.noAutomaticReplay, true);
  assert.equal(h.calls.probe.length, 1);
});

method('mismatched or throwing shared-query results fail before payload reads', async () => {
  for (const query of [(_, admitted) => ({ ...admitted, root: '/fixture/wrong-root' }),
    () => { throw new Error('Synthetic query unavailable'); }, () => ({ ok: false })]) {
    const h = fixture({ query }); unusable(await h.api.capabilitySnapshot());
    assert.equal(h.calls.enumerate.length, 0); assert.equal(h.calls.metadata.length, 0);
    assert.equal(h.calls.probe.length, 0);
  }
});
