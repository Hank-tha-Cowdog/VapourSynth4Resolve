// VM/fake-clock children only. No filesystem/media/model/helper/tool is executed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

class Clock {
  constructor() { this.now = 0; this.next = 1; this.tasks = new Map(); }
  set(fn, ms) { const id = this.next++; this.tasks.set(id, { fn, at: this.now + ms }); return id; }
  clear(id) { this.tasks.delete(id); }
  advance(ms) {
    const end = this.now + ms;
    for (let count = 0; count < 1000; ++count) {
      const due = [...this.tasks].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) { this.now = end; return; }
      this.tasks.delete(due[0]); this.now = due[1].at; due[1].fn();
    }
    throw new Error('Fake timer loop exceeded finite bound');
  }
}
class Signal {
  constructor() { this.aborted = false; this.listeners = new Set(); }
  addEventListener(name, listener) { assert.equal(name, 'abort'); this.listeners.add(listener); }
  removeEventListener(name, listener) { assert.equal(name, 'abort'); this.listeners.delete(listener); }
  abort() { this.aborted = true; for (const listener of [...this.listeners]) listener(); }
}
function fixture({ env = {}, helper = '/fixture/probe_rife.py', weights = true, adapter = true, python = true } = {}) {
  const clock = new Clock(), calls = [], allocations = [], modules = new Map();
  const process = { env: { FFPROBE_BIN: '/fixture/ffprobe', FFMPEG_BIN: '/fixture/ffmpeg',
    MEDIAINFO_BIN: '/fixture/mediainfo', VSRES_SAMPLE_PYTHON: '/fixture/python', ...env },
    versions: {}, resourcesPath: '/fixture/Resources' };
  const home = '/fixture/home';
  const weightsDir = path.join(home, 'Library/Application Support/VapourSynth-OFX/models/vsmlrt-models-v15.16/models/rife');
  const modelsRoot = path.join(home, 'Library/Application Support/VapourSynth-OFX/models');
  const modelDir = path.join(modelsRoot, 'vsmlrt-models-v15.16');
  const modelPaths = [modelDir, path.join(modelDir, 'models'), weightsDir, path.join(weightsDir, 'inert.onnx')];
  const adapterFile = path.join(home, 'Library/Application Support/VapourSynth-OFX/vs-python/vsmlrt.py');
  const fakeFs = {
    lstatSync(file) {
      const index = modelPaths.indexOf(file); assert(index >= 0, 'Only inert model metadata is admitted');
      return { dev: 1, ino: index + 1, size: 1, mtimeMs: 1, ctimeMs: 1, nlink: index === 3 ? 1 : 2,
        isDirectory: () => index !== 3, isFile: () => index === 3, isSymbolicLink: () => false };
    },
    realpathSync(file) { assert(modelPaths.includes(file)); return file; },
    existsSync(file) {
      if (file === weightsDir) return weights;
      if (file === adapterFile) return adapter;
      if (file === '/fixture/python') return python;
      return ['/fixture/ffprobe', '/fixture/ffmpeg', '/fixture/mediainfo'].includes(file);
    },
    readdirSync(file) { assert.equal(file, weightsDir); return ['inert.onnx']; },
    statSync() { throw new Error('Media stat forbidden'); }, openSync() { throw new Error('Media open forbidden'); },
    readSync() { throw new Error('Media read forbidden'); }, closeSync() { throw new Error('Media close forbidden'); },
  };
  function spawn(bin, args, options) {
    assert(bin.startsWith('/fixture/'), 'Only a virtual executable may be selected');
    const child = new EventEmitter();
    Object.assign(child, { stdout: new EventEmitter(), stderr: new EventEmitter(), pid: 100 + calls.length,
      exitCode: null, signalCode: null, closeOnKill: true, killResult: true, kills: [], closed: false });
    child.close = (code = 0, signal = null) => {
      if (child.closed) return;
      child.closed = true; child.exitCode = code; child.signalCode = signal;
      child.emit('exit', code, signal); child.emit('close', code, signal);
    };
    child.kill = signal => {
      child.kills.push(signal);
      if (child.killError) throw new Error(child.killError);
      if (child.closeOnKill) clock.set(() => child.close(null, signal), 0);
      return child.killResult;
    };
    calls.push({ bin, args: [...args], options, child });
    return child;
  }
  function load(name) {
    if (modules.has(name)) return modules.get(name);
    const filename = path.join(__dirname, name);
    const module = { exports: {} };
    const trackedBuffer = {
      isBuffer: Buffer.isBuffer, from: Buffer.from.bind(Buffer), concat: Buffer.concat.bind(Buffer),
      allocUnsafeSlow(size) { allocations.push(size); return Buffer.allocUnsafeSlow(size); },
    };
    const context = { module, exports: module.exports, process, __dirname: '/fixture/electron',
      Buffer: trackedBuffer, setTimeout: (fn, ms) => clock.set(fn, ms), clearTimeout: id => clock.clear(id),
      require(name) {
        if (name === 'child_process') return { spawn };
        if (name === 'fs') return fakeFs;
        if (name === 'path') return path;
        if (name === 'os') return { homedir: () => home };
        if (name === 'crypto') return require('node:crypto');
        if (name === 'buffer') return require('node:buffer');
        if (name === './probe-process') return load('probe-process.js');
        if (name === './model-manager') return { inspectModelForRead(id) {
          assert.equal(id, 'vsmlrt-models-v15.16');
          return { ok: true, root: modelsRoot, dir: modelDir, exists: weights,
            completion: 'missing', legacy: weights, identity: weights ? { dev: 1, ino: 1 } : null };
        } };
        if (name === './prod-paths') return {
          helperScript(script) { assert.equal(script, 'probe_rife.py'); return helper; },
          resolveRuntimes() { return { ffprobe: { exists: true, path: '/fixture/bundled/ffprobe' } }; },
        };
        throw new Error('Unadmitted probe dependency: ' + name);
      },
    };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename, timeout: 1000 });
    modules.set(name, module.exports);
    return module.exports;
  }
  const api = load('probe.js'), neural = load('neural-capability.js');
  return { api, neural, clock, calls, process, allocations,
    closeAll() { for (const c of calls) c.child.close(1); clock.tasks.clear(); } };
}
function observe(promise) {
  const state = { settled: false, settlements: 0 };
  Promise.resolve(promise).then(value => { state.settled = true; state.settlements++; state.value = value; },
    error => { state.settled = true; state.settlements++; state.error = error; });
  return state;
}
async function flush() { for (let i = 0; i < 6; ++i) await Promise.resolve(); }
async function tick(h, ms) { h.clock.advance(ms); await flush(); }
function invoke(h, kind, options = {}) {
  if (kind === 'ffprobe') return h.api.probeFile('/fixture/input.mov', options);
  if (kind === 'idet') return h.api.analyzeFields('/fixture/input.mov', 120, options);
  if (kind === 'mediainfo') return h.api.analyzeMediaInfo('/fixture/input.mov', options);
  return h.neural.capabilitySnapshot(options);
}
function failed(state, kind, reason) {
  assert.equal(state.settled, true, `${kind} must settle within its budget/closure window`);
  const value = kind === 'ffprobe' ? state.error : kind === 'neural' ? state.value?.rife : state.value;
  assert(value, `${kind} must return an explicit failure`);
  if (kind === 'neural') { assert.equal(value.usable, false); assert.equal(value.unknown, true); }
  else if (kind !== 'ffprobe') assert.equal(value.ok, false);
  assert.equal(value.reason, reason);
  assert.equal(value.noAutomaticReplay, true);
  return value;
}
const RAW = JSON.stringify({ streams: [], format: { format_name: 'fixture' } });
const ID = 'Multi frame detection: TFF: 120 BFF: 0 Progressive: 0 Undetermined: 0';
function check(name, body) {
  test(name, async t => {
    const h = fixture(); t.after(() => h.closeAll()); await body(h);
  });
}

for (const kind of ['ffprobe', 'idet', 'mediainfo', 'neural']) {
  check(`${kind}: silent child stops once and waits for close`, async h => {
    const state = observe(invoke(h, kind, { timeoutMs: 10, closeTimeoutMs: 5 }));
    const child = h.calls[0].child;
    await tick(h, 10);
    const value = failed(state, kind, 'probe-timeout');
    assert.equal(value.closed, true); assert.equal(value.cleanupUnconfirmed, false);
    assert.deepEqual(child.kills, ['SIGKILL']);
    await tick(h, 1000); assert.deepEqual(child.kills, ['SIGKILL']);
  });
  check(`${kind}: combined output bound never returns truncated success`, async h => {
    const state = observe(invoke(h, kind, { timeoutMs: 100, maxOutputBytes: 64, closeTimeoutMs: 5 }));
    const child = h.calls[0].child;
    for (let i = 0; i < 65; ++i) (i % 2 ? child.stdout : child.stderr).emit('data', Buffer.from('x'));
    await tick(h, 0);
    failed(state, kind, 'probe-output-limit');
    assert.deepEqual(child.kills, ['SIGKILL']);
    assert(h.allocations.length <= 2, 'Capture coalesces tiny chunks into bounded owned blocks');
  });
}
check('already aborted request never spawns', async h => {
  const signal = new Signal(); signal.abort();
  const state = observe(h.api.probeFile('/fixture/input.mov', { signal }));
  await flush(); failed(state, 'ffprobe', 'probe-cancelled'); assert.equal(h.calls.length, 0);
});
check('neural cancellation after JSON never advertises inference', async h => {
  const signal = new Signal(); const state = observe(invoke(h, 'neural', { signal }));
  h.calls[0].child.stdout.emit('data', '{"ok":true,"level":"inference"}\n');
  signal.abort(); await tick(h, 0);
  failed(state, 'neural', 'probe-cancelled'); assert.equal(signal.listeners.size, 0);
});
check('concurrent unconfirmed stops retain separate quarantine tokens', async h => {
  const a = observe(invoke(h, 'ffprobe', { timeoutMs: 10, closeTimeoutMs: 5 }));
  const b = observe(invoke(h, 'ffprobe', { timeoutMs: 10, closeTimeoutMs: 5 }));
  const ca = h.calls[0].child, cb = h.calls[1].child; ca.closeOnKill = cb.closeOnKill = false;
  await tick(h, 15);
  assert.equal(failed(a, 'ffprobe', 'probe-timeout').cleanupUnconfirmed, true);
  failed(b, 'ffprobe', 'probe-timeout'); ca.close(null, 'SIGKILL'); await flush();
  const held = observe(invoke(h, 'ffprobe')); await flush(); failed(held, 'ffprobe', 'probe-stop-pending');
  assert.equal(h.calls.length, 2); cb.close(null, 'SIGKILL'); await flush();
  const next = observe(invoke(h, 'ffprobe')); assert.equal(h.calls.length, 3);
  h.calls[2].child.stdout.emit('data', RAW); h.calls[2].child.close(0); await flush();
  assert.equal(next.value.formatName, 'fixture');
});
check('failed owned stop is bounded and never retried', async h => {
  const state = observe(invoke(h, 'ffprobe', { timeoutMs: 10, closeTimeoutMs: 5 }));
  const child = h.calls[0].child; child.closeOnKill = false; child.killResult = false;
  await tick(h, 15); const value = failed(state, 'ffprobe', 'probe-timeout');
  assert.equal(value.cleanupUnconfirmed, true); assert.match(value.stopError, /not accepted/);
  child.stderr.emit('data', Buffer.from('discard after stop')); child.emit('error', new Error('late'));
  await tick(h, 100); assert.deepEqual(child.kills, ['SIGKILL']);
});
check('spawn failure is explicit and has no replay', async h => {
  const state = observe(invoke(h, 'ffprobe')); const child = h.calls[0].child;
  child.pid = undefined; child.emit('error', new Error('synthetic spawn failure')); await flush();
  const value = failed(state, 'ffprobe', 'probe-spawn-failed'); assert.equal(value.closed, true);
  child.stdout.emit('data', RAW); assert.doesNotThrow(() => child.close(0));
  await flush(); assert(state.error); assert.equal(state.settlements, 1);
});
check('idet nonzero exit cannot turn partial summary into success', async h => {
  const state = observe(invoke(h, 'idet')); const child = h.calls[0].child;
  child.stderr.emit('data', ID); child.close(1); await flush();
  assert.equal(state.value.ok, false); assert.match(state.value.error, /exit 1/);
});
check('neural exit/status contract preserves failure and rejects false success', async h => {
  let state = observe(invoke(h, 'neural')); let child = h.calls.at(-1).child;
  child.stdout.emit('data', '{"ok":false,"level":"backend","error":"fixture missing backend"}\n');
  child.close(1); await flush(); assert.equal(state.value.rife.level, 'backend'); assert.equal(state.value.rife.usable, false);
  state = observe(invoke(h, 'neural')); child = h.calls.at(-1).child;
  child.stdout.emit('data', '{"ok":true,"level":"inference"}\n'); child.close(7); await flush();
  assert.equal(state.value.rife.usable, false); assert.equal(state.value.rife.unknown, true);
  state = observe(invoke(h, 'neural')); child = h.calls.at(-1).child;
  child.stdout.emit('data', '{"ok":false,"level":"load","error":"fixture load failure"}\n');
  child.stderr.emit('data', '{"ok":true,"level":"inference"}\n'); child.close(1); await flush();
  assert.equal(state.value.rife.usable, false); assert.equal(state.value.rife.level, 'load');
});
check('normal packaged metadata preserves split UTF8 without retaining backing views', async h => {
  const state = observe(h.api.probeFile('/fixture/input.mov', { packaged: true, resourcesPath: '/fixture/Resources', maxOutputBytes: 128 }));
  const child = h.calls[0].child; assert.equal(h.calls[0].bin, '/fixture/bundled/ffprobe');
  const bytes = Buffer.from('{"streams":[],"format":{"format_name":"é"}}');
  const backing = Buffer.alloc(512 * 1024); bytes.copy(backing, 0); const split = bytes.indexOf(0xc3) + 1;
  child.stdout.emit('data', backing.subarray(0, split)); child.stdout.emit('data', backing.subarray(split, bytes.length));
  child.close(0); await flush(); assert.equal(state.value.formatName, 'é');
  assert(h.allocations.length > 0 && h.allocations.every(size => size <= 128));
});
check('normal MediaInfo preserves raw track and metadata', async h => {
  const state = observe(invoke(h, 'mediainfo')); const child = h.calls[0].child;
  child.stdout.emit('data', '{"media":{"track":[{"@type":"Video","ScanType":"Interlaced","ScanOrder":"BFF","extra":"keep"}]}}');
  child.close(0); await flush(); assert.equal(state.value.ok, true); assert.equal(state.value.scanOrder, 'BFF');
  assert.equal(state.value.rawVideoTrack.extra, 'keep');
});
check('named operator budget applies and explicit caller budget takes precedence', async h => {
  h.process.env.VSRES_FFPROBE_TIMEOUT_MS = '10';
  const first = observe(invoke(h, 'ffprobe')); await tick(h, 10); failed(first, 'ffprobe', 'probe-timeout');
  const second = observe(invoke(h, 'ffprobe', { timeoutMs: 50 })); const child = h.calls.at(-1).child;
  await tick(h, 11); assert.equal(second.settled, false); assert.equal(child.kills.length, 0);
  child.stdout.emit('data', RAW); child.close(0); await flush(); assert.equal(second.value.formatName, 'fixture');
});
check('invalid explicit or operator budgets refuse before spawning', async h => {
  for (const options of [{timeoutMs: null}, {timeoutMs: 0}, {timeoutMs: Infinity}, {timeoutMs: 2 ** 31},
    {signal: false}, {signal: 0}, {signal: ''}, {maxOutputBytes: 0}, {maxOutputBytes: require('node:buffer').constants.MAX_STRING_LENGTH + 1}, {closeTimeoutMs: null}]) {
    const state = observe(invoke(h, 'ffprobe', options)); await flush(); failed(state, 'ffprobe', 'probe-invalid-budget');
  }
  h.process.env.VSRES_FFPROBE_TIMEOUT_MS = 'not-an-integer';
  const state = observe(invoke(h, 'ffprobe')); await flush(); failed(state, 'ffprobe', 'probe-invalid-budget');
  assert.equal(h.calls.length, 0);
});
check('explicit legitimate long budget survives the metadata default deadline', async h => {
  const state = observe(invoke(h, 'ffprobe', { timeoutMs: 600_000, maxOutputBytes: 32 * 1024 * 1024 }));
  const child = h.calls[0].child; await tick(h, 60_001); assert.equal(child.kills.length, 0);
  child.stdout.emit('data', RAW); child.close(0); await flush(); assert.equal(state.value.formatName, 'fixture');
});
check('pipe errors stop safely and late errors never become unhandled', async h => {
  const state = observe(invoke(h, 'ffprobe')); const child = h.calls[0].child;
  child.stdout.emit('error', new Error('synthetic pipe error')); await tick(h, 0);
  failed(state, 'ffprobe', 'probe-stream-error');
  assert.doesNotThrow(() => child.stderr.emit('error', new Error('late pipe error')));
});
check('throwing abort listener methods cannot strand an acquired child', async h => {
  const badAdd = { aborted: false, addEventListener() { throw new Error('bad add'); }, removeEventListener() {} };
  let state = observe(invoke(h, 'ffprobe', { signal: badAdd })); await tick(h, 0);
  failed(state, 'ffprobe', 'probe-signal-error'); assert.equal(h.calls[0].child.kills.length, 1);
  const badRemove = { aborted: false, addEventListener() {}, removeEventListener() { throw new Error('bad remove'); } };
  state = observe(invoke(h, 'ffprobe', { signal: badRemove })); const child = h.calls.at(-1).child;
  child.stdout.emit('data', RAW); child.close(0); await flush(); failed(state, 'ffprobe', 'probe-signal-error');
});
check('observed exit is never signalled while waiting for pipe closure', async h => {
  const state = observe(invoke(h, 'ffprobe', { timeoutMs: 10, closeTimeoutMs: 5 })); const child = h.calls[0].child;
  child.exitCode = 0; child.emit('exit', 0); await tick(h, 15);
  failed(state, 'ffprobe', 'probe-timeout'); assert.equal(child.kills.length, 0);
  child.close(0); await flush();
});
check('missing neural helper still fails before spawn using the proven presence level', async h => {
  const other = fixture({ helper: null });
  try { const state = observe(invoke(other, 'neural')); await flush();
    assert.equal(state.value.rife.usable, false); assert.equal(state.value.rife.level, 'adapter'); assert.equal(other.calls.length, 0);
  } finally { other.closeAll(); }
});
check('normal close clears cancellation/deadline and first stop wins races', async h => {
  const signal = new Signal(); const state = observe(invoke(h, 'ffprobe', { signal, timeoutMs: 10, maxOutputBytes: 64 }));
  const child = h.calls[0].child; child.stdout.emit('data', RAW); child.close(0); await flush();
  signal.abort(); await tick(h, 100); assert.equal(child.kills.length, 0); assert.equal(signal.listeners.size, 0);
  assert.equal(state.value.formatName, 'fixture');
  const signal2 = new Signal(); const stopped = observe(invoke(h, 'ffprobe', { signal: signal2, timeoutMs: 10, maxOutputBytes: 1 }));
  const second = h.calls.at(-1).child; second.stdout.emit('data', Buffer.from('xx')); signal2.abort(); await tick(h, 10);
  failed(stopped, 'ffprobe', 'probe-output-limit'); assert.deepEqual(second.kills, ['SIGKILL']);
});
