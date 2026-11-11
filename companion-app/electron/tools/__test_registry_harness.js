// Closed ports for the full real registry. Fake inode/link operations model the
// consumer contract; they do not qualify an actual filesystem or renderer.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const filename = path.join(__dirname, 'registry.js');
const source = fs.readFileSync(filename, 'utf8');
const SOURCE_FILE = '/sample-fixture/source.mov';
const PYTHON = '/sample-fixture/python';
const FFMPEG = '/sample-fixture/ffmpeg';
const OUTPUT_FILE = '/sample-fixture/output.mov';
const DEFAULT_DIR = '/sample-fixture/home/Movies/VapourSynth-OFX Samples';
const MODES = ['qtgmc_25p', 'pal_recover_srestore', 'raw_script'];
// Modes the sample renderer may actually execute. raw_script is refused before
// any effect: model/MCP input cannot bind user approval to arbitrary Python.
const EXEC_MODES = ['qtgmc_25p', 'pal_recover_srestore'];
const RAW_SCRIPT_REFUSAL = 'raw_script sample execution is unavailable: explicit user approval '
  + 'must be bound to the exact script, source and render arguments';
function error(code) { return Object.assign(new Error(`fixture ${code}`), { code }); }
function file(content = 'SENTINEL', size = content.length) { return { kind: 'file', content, size }; }
function makeDisk() {
  return { counter: 0, entries: new Map([
    [SOURCE_FILE, file('SOURCE')], [PYTHON, file('PYTHON')],
    ['/sample-fixture', { kind: 'directory' }],
  ]) };
}

function harness({ forbidEffects = false, allowedEffects, disk = makeDisk(), faults = {}, beforeLink, onKill, filesystemFixture } = {}) {
  // Optional owned-filesystem test fixture; subprocesses/probes/clocks stay fake.
  const samplePython = filesystemFixture?.python || PYTHON;
  const sampleFfmpeg = filesystemFixture?.ffmpeg || FFMPEG;
  const effects = [];
  const spawns = [];
  const timers = new Set();
  let clock = 1000;
  function effect(name, ...args) {
    effects.push([name, ...args]);
    assert.equal(forbidEffects, false, `invalid input reached ${name}`);
    if (allowedEffects) assert.ok(allowedEffects.includes(name), `unexpected effect: ${name}`);
  }
  function fault(operation) { if (faults[operation]) throw error(faults[operation]); }
  const fsPorts = {
    existsSync(target) { effect('existsSync', target); return disk.entries.has(target); },
    lstatSync(target) {
      effect('lstatSync', target);
      fault(target.includes('/.vsres-sample-') ? 'stageLstat' : 'finalLstat');
      const entry = disk.entries.get(target);
      if (!entry) throw error('ENOENT');
      return { size: entry.size || 0, isFile: () => entry.kind === 'file' };
    },
    mkdirSync(target, options) {
      effect('mkdirSync', target, options); fault('mkdir');
      assert.equal(target, DEFAULT_DIR); assert.equal(options.recursive, true);
      disk.entries.set(target, { kind: 'directory' });
    },
    mkdtempSync(prefix) {
      effect('mkdtempSync', prefix); fault('mkdtemp');
      assert.equal(path.basename(prefix), '.vsres-sample-');
      if (disk.entries.get(path.dirname(prefix))?.kind !== 'directory') throw error('ENOENT');
      const dir = `${prefix}${++disk.counter}`;
      assert.equal(disk.entries.has(dir), false);
      disk.entries.set(dir, { kind: 'directory' });
      return dir;
    },
    linkSync(from, to) {
      effect('linkSync', from, to);
      beforeLink?.({ disk, from, to }); fault('link');
      // One synchronous no-replace operation, rather than an overwriting copy.
      if (disk.entries.has(to)) throw error('EEXIST');
      if (!disk.entries.has(from)) throw error('ENOENT');
      disk.entries.set(to, disk.entries.get(from));
    },
    unlinkSync(target) {
      effect('unlinkSync', target); fault('unlink');
      assert.ok(target.includes('/.vsres-sample-'), 'must never unlink final/source');
      const entry = disk.entries.get(target);
      if (!entry) throw error('ENOENT');
      if (entry.kind === 'directory') throw error('EISDIR');
      disk.entries.delete(target);
    },
    rmdirSync(target, options) {
      effect('rmdirSync', target, options); fault('rmdir');
      assert.ok(path.basename(target).startsWith('.vsres-sample-'));
      assert.equal(options, undefined, 'cleanup must be nonrecursive');
      if (!disk.entries.has(target)) throw error('ENOENT');
      if ([...disk.entries.keys()].some(p => p.startsWith(target + '/'))) throw error('ENOTEMPTY');
      disk.entries.delete(target);
    },
  };
  const fakeFs = new Proxy(filesystemFixture?.ports || fsPorts, { get(target, name) {
    if (Object.hasOwn(target, name)) return filesystemFixture
      ? (...args) => { effect(String(name), ...args); return target[name](...args); } : target[name];
    effect('UNEXPECTED_FS_PORT', String(name)); throw new Error(`unexpected fs port: ${String(name)}`);
  } });
  function spawn(command, argv, options) {
    effect('spawn', command);
    assert.equal(command, spawns.length === 0 ? samplePython : sampleFfmpeg);
    if (faults.spawn === command) throw error('EACCES');
    const child = new EventEmitter(); child.stderr = new EventEmitter();
    child.pid = command === samplePython ? 900001 : 900002; // In-memory identities only.
    child.exitCode = null; child.signalCode = null;
    child.kill = signal => {
      effect('kill', command, signal);
      if (faults.kill === false) return false;
      if (typeof faults.kill === 'string') throw error(faults.kill);
      onKill?.({ command, child, signal });
      return true;
    };
    if (command === samplePython) {
      child.stdout = new EventEmitter();
      child.stdout.pipe = target => {
      effect('pipe'); fault('pipe'); assert.equal(target, spawns[1].child.stdin);
      };
    } else {
      assert.ok(spawns[0].child.listenerCount('error') > 0, 'producer error listener precedes writer acquisition');
      assert.ok(spawns[0].child.stdout.listenerCount('error') > 0, 'producer stream errors must be handled first');
      child.stdin = new EventEmitter();
    }
    spawns.push({ command, argv, options, child }); return child;
  }
  const moduleRecord = { exports: {} };
  vm.runInNewContext(source, {
    module: moduleRecord, exports: moduleRecord.exports,
    process: { env: { VSRES_SAMPLE_PYTHON: samplePython } }, Buffer,
    Date: { now() { effect('clock'); return clock; } },
    setTimeout(callback, milliseconds) {
      effect('setTimeout', milliseconds);
      const timer = { callback, milliseconds, due: clock + milliseconds }; timers.add(timer); return timer;
    },
    clearTimeout(timer) { effect('clearTimeout'); timers.delete(timer); },
    require(name) {
      switch (name) {
        case 'child_process': return { spawn };
        case 'fs': return fakeFs;
        case 'os': return { homedir: () => filesystemFixture?.home || '/sample-fixture/home' };
        case 'path': return path;
        case '../probe': return { findFfmpeg() { effect('findFfmpeg'); return sampleFfmpeg; } };
        case '../../shared/stage-playbooks.json': return { stages: [] };
        default: throw new Error(`unexpected registry dependency: ${name}`);
      }
    },
  }, { filename, timeout: 1000 });
  const api = moduleRecord.exports;
  const execute = api.createExecutor({
    getLatestConfig() { throw new Error('unexpected config access'); },
    getStatusPath() { throw new Error('unexpected status access'); },
  });
  function assertNoUnexpectedPorts() {
    assert.equal(effects.some(e => e[0] === 'UNEXPECTED_FS_PORT'), false);
  }
  const childFor = name => spawns[name === 'producer' ? 0 : 1].child;
  function exitChild(name, code = 0, signal = null) {
    const child = childFor(name); child.exitCode = code; child.signalCode = signal;
    child.emit('exit', code, signal);
  }
  function closeChild(name, code = 0, signal = null) {
    const child = childFor(name);
    if (child.exitCode == null && child.signalCode == null) exitChild(name, code, signal);
    child.emit('close', code, signal);
  }
  function stage(entry = file('RENDER_FIXTURE')) {
    assert.equal(spawns.length, 2);
    const stagedFile = spawns[1].argv.at(-1);
    disk.entries.set(stagedFile, entry); return stagedFile;
  }
  function close({ code = 0, entry = file('RENDER_FIXTURE'), missing = false, producerCode = 0 } = {}) {
    if (!missing) stage(entry);
    closeChild('producer', producerCode); closeChild('writer', code);
    return entry;
  }
  function advance(milliseconds) {
    const target = clock + milliseconds; let steps = 0;
    for (;;) {
      const next = [...timers].filter(t => t.due <= target).sort((a, b) => a.due - b.due)[0];
      if (!next) break;
      assert.ok(++steps <= 100, 'unexpected timer loop');
      clock = next.due; timers.delete(next); next.callback();
    }
    clock = target;
  }
  return {
    api, effects, spawns, timers, disk, close, stage, exitChild, closeChild, advance, assertNoUnexpectedPorts,
    call(input, entry = 'executor') {
      return entry === 'executor' ? execute('render_sample', input) : api.renderSample(input);
    },
    async complete(pending, options) {
      close(options); const result = await pending; assertNoUnexpectedPorts(); return result;
    },
    async finish(pending) {
      assert.equal(spawns.length, 2);
      assert.equal(spawns[0].argv[0], '-c');
      assert.equal(typeof spawns[0].argv[1], 'string');
      assert.ok(spawns[1].argv.includes('-n')); assert.ok(!spawns[1].argv.includes('-y'));
      assert.equal(timers.size, 1);
      const result = await this.complete(pending);
      assert.equal(result.ok, true);
      const publication = effects.find(e => e[0] === 'linkSync');
      assert.equal(result.outputPath, publication[2]);
      assert.notEqual(result.outputPath, spawns[1].argv.at(-1));
      assert.equal(disk.entries.get(result.outputPath).kind, 'file');
      assert.equal(disk.entries.has(spawns[1].argv.at(-1)), false);
      assert.equal(timers.size, 0);
      return { result, script: spawns[0].argv[1] };
    },
  };
}

module.exports = { harness, makeDisk, file, SOURCE_FILE, PYTHON, FFMPEG, OUTPUT_FILE, DEFAULT_DIR,
  MODES, EXEC_MODES, RAW_SCRIPT_REFUSAL };
