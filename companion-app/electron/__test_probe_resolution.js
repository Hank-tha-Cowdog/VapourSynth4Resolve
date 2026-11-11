// Pure resolver/metadata tests. Only these two local source files are read.
// Filesystem, Electron and child processes below are mocks; no helper is run.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const RES = '/fixture/Companion.app/Contents/Resources';
const BIN = path.join(RES, 'runtime', 'ffmpeg', 'ffprobe');
const OVERRIDE = '/fixture/dev-ffprobe';
const BREW = '/opt/homebrew/bin/ffprobe';

function fixture({ files = {}, env = {}, resourcesPath = RES, electron, electronError,
    raw = { streams: [], format: {} } } = {}) {
    const calls = [];
    let electronLoads = 0;
    const fakeProcess = { env: { ...env }, resourcesPath,
        versions: electron === undefined && !electronError ? {} : { electron: '33.4.11' } };
    const fakeFs = {
        constants: { X_OK: 1 },
        existsSync: name => Object.hasOwn(files, name),
        lstatSync(name) {
            if (!Object.hasOwn(files, name)) throw new Error('ENOENT');
            return { isFile: () => files[name].kind === 'file' };
        },
        accessSync(name) {
            if (!files[name] || !files[name].executable) throw new Error('EACCES');
        },
        statSync() { throw new Error('Unexpected media filesystem inspection'); },
        openSync() { throw new Error('Unexpected media file open'); },
        readSync() { throw new Error('Unexpected media file read'); },
        closeSync() { throw new Error('Unexpected media file close'); },
    };
    let production;
    function mockedRequire(name) {
        if (name === 'fs') return fakeFs;
        if (name === 'path') return path;
            if (name === './probe-process') return require('./probe-process');
        if (name === 'crypto') return require('node:crypto');
        if (name === 'os') return { homedir: () => '/fixture/isolated-home' };
        if (name === './prod-paths') return production;
        if (name === 'electron') {
            electronLoads++;
            if (electronError) throw electronError;
            if (electron === undefined) throw new Error('Node must not load Electron');
            return electron;
        }
        if (name === 'child_process') return {
            spawn(bin, args, options) {
                calls.push({ bin, args: Array.from(args), stdio: Array.from(options.stdio) });
                const child = new EventEmitter();
                child.stdout = new EventEmitter();
                child.stderr = new EventEmitter();
                queueMicrotask(() => {
                    child.stdout.emit('data', Buffer.from(JSON.stringify(raw)));
                    child.emit('close', 0);
                });
                return child;
            },
        };
        throw new Error('Unexpected require: ' + name);
    }
    function load(name) {
        const filename = path.join(__dirname, name);
        const context = { module: { exports: {} }, require: mockedRequire,
            process: fakeProcess, __dirname, Buffer };
        vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
        return context.module.exports;
    }
    production = load('prod-paths.js');
    const probe = load('probe.js');
    return { probe, production, calls, electronLoads: () => electronLoads };
}

const executable = { kind: 'file', executable: true };

test('packaged resolver selects only the external bundled helper', () => {
    const f = fixture({ files: { [BIN]: executable, [OVERRIDE]: executable, [BREW]: executable },
        env: { FFPROBE_BIN: OVERRIDE } });
    assert.equal(f.probe.findFfprobe({ packaged: true, resourcesPath: RES }), BIN);
    assert.equal(f.electronLoads(), 0, 'pure Node fixture never loads Electron');
    assert.equal(f.calls.length, 0);
});

test('missing, nonexecutable, directory, symlink and ASAR helpers reject before spawn', async () => {
    const cases = [
        { files: {}, resourcesPath: RES },
        { files: { [BIN]: { kind: 'file', executable: false } }, resourcesPath: RES },
        { files: { [BIN]: { kind: 'directory', executable: true } }, resourcesPath: RES },
        { files: { [BIN]: { kind: 'symlink', executable: true } }, resourcesPath: RES },
        { files: { '/fixture/app.asar/runtime/ffmpeg/ffprobe': executable },
            resourcesPath: '/fixture/app.asar' },
        { files: { 'runtime/ffmpeg/ffprobe': executable }, resourcesPath: '' },
    ];
    for (const item of cases) {
        const f = fixture({ ...item, env: { FFPROBE_BIN: OVERRIDE },
            files: { ...item.files, [OVERRIDE]: executable, [BREW]: executable } });
        await assert.rejects(f.probe.probeFile('/fixture/input.mkv',
            { packaged: true, resourcesPath: item.resourcesPath }), /Bundled ffprobe.*ASAR/);
        assert.equal(f.calls.length, 0);
    }
});

test('development retains explicit override, machine selection and PATH fallback', () => {
    const override = fixture({ files: { [OVERRIDE]: executable, [BREW]: executable },
        env: { FFPROBE_BIN: OVERRIDE } });
    assert.equal(override.probe.findFfprobe(), OVERRIDE);
    const machine = fixture({ files: { [BREW]: executable } });
    assert.equal(machine.probe.findFfprobe(), BREW);
    const missing = fixture();
    assert.equal(missing.probe.findFfprobe(), 'ffprobe');
    assert.equal(missing.electronLoads(), 0);
});

test('resourcesPath alone does not turn Electron development into packaged mode', () => {
    const f = fixture({ files: { [BIN]: executable, [OVERRIDE]: executable },
        env: { FFPROBE_BIN: OVERRIDE }, electron: { app: { isPackaged: false } } });
    assert.equal(f.probe.findFfprobe({ packaged: true }), OVERRIDE);
    assert.equal(f.electronLoads(), 1);
});

test('real Electron packaged mode wins over Node fixture overrides', () => {
    const f = fixture({ files: { [BIN]: executable, [OVERRIDE]: executable },
        env: { FFPROBE_BIN: OVERRIDE }, electron: { app: { isPackaged: true } } });
    assert.equal(f.probe.findFfprobe({ packaged: false, resourcesPath: '/other/Resources' }), BIN);
});

test('Electron mode lookup failures never silently select development helpers', async () => {
    for (const options of [{ electron: {} }, { electronError: new Error('Electron unavailable') }]) {
        const f = fixture({ ...options, files: { [OVERRIDE]: executable },
            env: { FFPROBE_BIN: OVERRIDE } });
        await assert.rejects(f.probe.probeFile('/fixture/input.mkv'),
            /Cannot determine Electron launch mode|Electron unavailable/);
        assert.equal(f.calls.length, 0);
    }
});

test('packaged probe preserves the metadata contract with a mocked successful child', async () => {
    const raw = {
        streams: [
            { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080,
                avg_frame_rate: '24000/1001', r_frame_rate: '24000/1001', pix_fmt: 'yuv420p' },
            { codec_type: 'audio', codec_name: 'pcm_s16le', sample_rate: '48000', channels: 1 },
        ],
        format: { format_name: 'matroska,webm', format_long_name: 'Matroska / WebM',
            duration: '1.25', size: '1000' },
    };
    const f = fixture({ files: { [BIN]: executable }, raw });
    const result = JSON.parse(JSON.stringify(await f.probe.probeFile('/fixture/input.mkv',
        { packaged: true, resourcesPath: RES })));
    assert.equal(result.fileName, 'input.mkv');
    assert.equal(result.video.width, 1920);
    assert.equal(result.video.height, 1080);
    assert.equal(result.video.fps, 24000 / 1001);
    assert.equal(result.video.rFps, '24000/1001');
    assert.equal(result.container, 'Matroska / WebM');
    assert.equal(result.formatName, 'matroska,webm');
    assert.equal(result.duration, 1.25);
    assert.equal(result.audio.sampleRate, 48000);
    assert.equal(result.audio.channels, 1);
    assert.deepEqual(result.raw, raw);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].bin, BIN);
    assert.deepEqual(f.calls[0].args, ['-v', 'quiet', '-print_format', 'json',
        '-show_format', '-show_streams', '/fixture/input.mkv']);
});
