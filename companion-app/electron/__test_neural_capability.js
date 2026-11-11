// Neural capability contract tests: source executes only in a VM with inert
// fs/helper/spawn ports. No models, interpreter, helper, network or UI runs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

function fixture({ weights = true, adapter = true, python = true,
    helper = '/fixture/scripts/probe_rife.py', spawnError = false } = {}) {
    const home = '/fixture/home';
    const weightsDir = path.join(home, 'Library/Application Support/VapourSynth-OFX/models',
        'vsmlrt-models-v15.16/models/rife');
    const modelsRoot = path.join(home, 'Library/Application Support/VapourSynth-OFX/models');
    const modelDir = path.join(modelsRoot, 'vsmlrt-models-v15.16');
    const modelPaths = [modelDir, path.join(modelDir, 'models'), weightsDir, path.join(weightsDir, 'fixture.onnx')];
    const adapterFile = path.join(home, 'Library/Application Support/VapourSynth-OFX/vs-python/vsmlrt.py');
    const interpreter = '/fixture/python3';
    const calls = { helper: [], spawn: [] };
    const module = { exports: {} };
    const source = fs.readFileSync(path.join(__dirname, 'neural-capability.js'), 'utf8');
    vm.runInNewContext(source, {
        module, exports: module.exports,
        process: { env: { VSRES_SAMPLE_PYTHON: interpreter }, resourcesPath: '/fixture/Resources' },
        require(name) {
            if (name === 'path') return path;
            if (name === './probe-process') return require('./probe-process');
            if (name === './model-manager') return { inspectModelForRead(id) {
                assert.equal(id, 'vsmlrt-models-v15.16');
                return { ok: true, root: modelsRoot, dir: modelDir, exists: weights,
                    completion: 'missing', legacy: weights, identity: weights ? { dev: 1, ino: 1 } : null };
            } };
            if (name === 'os') return { homedir: () => home };
            if (name === 'fs') return {
                lstatSync(file) {
                    const index = modelPaths.indexOf(file); assert(index >= 0, 'Only inert model metadata is admitted');
                    return { dev: 1, ino: index + 1, size: 1, mtimeMs: 1, ctimeMs: 1, nlink: index === 3 ? 1 : 2,
                        isDirectory: () => index !== 3, isFile: () => index === 3, isSymbolicLink: () => false };
                },
                realpathSync(file) { assert(modelPaths.includes(file)); return file; },
                existsSync(file) {
                    if (file === weightsDir) return weights;
                    if (file === adapterFile) return adapter;
                    if (file === interpreter) return python;
                    return false;
                },
                readdirSync(dir) {
                    assert.equal(dir, weightsDir, 'only the explicit fake weights directory is inspected');
                    return ['fixture.onnx'];
                },
            };
            if (name === './prod-paths') return { helperScript(helperName) {
                calls.helper.push(helperName);
                assert.equal(helperName, 'probe_rife.py');
                return helper;
            } };
            if (name === 'child_process') return { spawn(executable, argv, options) {
                // Preserve Node's argument contract rather than accepting the
                // old function-valued argv as a successful fake launch.
                assert.equal(executable, interpreter);
                assert.equal(argv.length, 1);
                if (typeof argv[0] !== 'string') throw new TypeError('spawn argv must contain strings');
                calls.spawn.push({ executable, argv: [...argv], stdio: [...options.stdio] });
                const child = new EventEmitter();
                child.stdout = new EventEmitter();
                child.stderr = new EventEmitter();
                queueMicrotask(() => {
                    if (spawnError) {
                        child.emit('error', new Error('synthetic interpreter start failure'));
                        child.emit('close', -1);
                    } else {
                        child.stdout.emit('data', JSON.stringify({ ok: true, level: 'inference',
                            backend: 'fixture-backend', model: 'fixture-model' }) + '\n');
                        child.emit('close', 0);
                    }
                });
                return child;
            } };
            throw new Error('Unadmitted neural-capability dependency: ' + name);
        },
    }, { filename: 'neural-capability-contract.js', timeout: 1000 });
    return { api: module.exports, calls, helper, interpreter };
}

test('neural capability resolves one helper string and passes the exact fixed argv', async () => {
    const h = fixture();
    const result = await h.api.capabilitySnapshot();
    assert.equal(result.ok, true);
    assert.equal(result.rife.usable, true);
    assert.equal(result.rife.level, 'inference');
    assert.equal(result.rife.backend, 'fixture-backend');
    assert.equal(result.rife.model, 'fixture-model');
    assert.deepEqual(h.calls.helper, ['probe_rife.py']);
    assert.deepEqual(h.calls.spawn, [{ executable: h.interpreter, argv: [h.helper],
        stdio: ['ignore', 'pipe', 'pipe'] }]);
});

test('neural capability reports a missing helper honestly without dispatch', async () => {
    const h = fixture({ helper: null });
    const result = await h.api.capabilitySnapshot();
    assert.equal(result.rife.usable, false);
    assert.equal(result.rife.level, 'adapter');
    assert.match(result.rife.detail, /probe_rife\.py helper missing/);
    assert.equal(h.calls.spawn.length, 0);
    assert.equal(h.calls.helper.length, 1);
});

test('neural capability keeps the missing-interpreter failure before helper dispatch', async () => {
    const h = fixture({ python: false });
    const result = await h.api.capabilitySnapshot();
    assert.equal(result.rife.usable, false);
    assert.equal(result.rife.level, 'backend');
    assert.equal(result.rife.detail, 'no python');
    assert.equal(h.calls.helper.length, 0);
    assert.equal(h.calls.spawn.length, 0);
});

test('neural capability does not dispatch before weights exist', async () => {
    const h = fixture({ weights: false });
    const result = await h.api.capabilitySnapshot();
    assert.equal(result.rife.usable, false);
    assert.equal(result.rife.level, 'weights');
    assert.equal(h.calls.helper.length, 0);
    assert.equal(h.calls.spawn.length, 0);
});

test('neural capability does not dispatch before the adapter exists', async () => {
    const h = fixture({ adapter: false });
    const result = await h.api.capabilitySnapshot();
    assert.equal(result.rife.usable, false);
    assert.equal(result.rife.level, 'adapter');
    assert.equal(h.calls.helper.length, 0);
    assert.equal(h.calls.spawn.length, 0);
});

test('neural capability preserves a synthetic child start error as unusable', async () => {
    const h = fixture({ spawnError: true });
    const result = await h.api.capabilitySnapshot();
    assert.equal(result.rife.usable, false);
    assert.equal(result.rife.level, 'adapter');
    assert.equal(result.rife.detail, 'synthetic interpreter start failure');
    assert.equal(h.calls.spawn.length, 1);
});
