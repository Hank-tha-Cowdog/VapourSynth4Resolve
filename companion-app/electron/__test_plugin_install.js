// vsres-install helper integration tests: path resolution, argv construction,
// output parsing and the spawn wrapper — all without spawning anything real.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const install = require('./plugin-install');

function tmpdir(tag) {
    return fs.mkdtempSync(path.join(os.tmpdir(), `vsres-install-test-${tag}-`));
}

function fakeChild() {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { child.killed = true; };
    return child;
}

test('resolveInstallHelper prefers the packaged Resources/bin copy', () => {
    const res = tmpdir('res');
    const binDir = path.join(res, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const helper = path.join(binDir, 'vsres-install');
    fs.writeFileSync(helper, '#!/bin/sh\n');
    fs.chmodSync(helper, 0o755);
    assert.equal(install.resolveInstallHelper({ resourcesPath: res, devRoot: '/nonexistent' }), helper);
});

test('resolveInstallHelper falls back to the dev cargo output and returns null when absent', () => {
    const dev = tmpdir('dev');
    const rel = path.join(dev, 'tools', 'vsres-install', 'target', 'release', 'vsres-install');
    fs.mkdirSync(path.dirname(rel), { recursive: true });
    fs.writeFileSync(rel, 'bin');
    fs.chmodSync(rel, 0o755);
    assert.equal(install.resolveInstallHelper({ resourcesPath: '/nonexistent', devRoot: dev }), rel);
    assert.equal(install.resolveInstallHelper({ resourcesPath: '/nonexistent', devRoot: '/nonexistent' }), null);
});

test('buildArgs: discrete argv only, install requires the bundle path', () => {
    assert.deepEqual(install.buildArgs('status'), ['status']);
    assert.deepEqual(install.buildArgs('uninstall'), ['uninstall']);
    assert.throws(() => install.buildArgs('install'), /requires the embedded OFX bundle path/);
    assert.throws(() => install.buildArgs('install; rm -rf /'), /unknown install action/);
    assert.deepEqual(
        install.buildArgs('install', { bundlePath: '/res/OFX/VapourSynth.ofx.bundle', tomlHelper: '/res/scripts/install_ofx_toml.py' }),
        ['install', '--source', '/res/OFX/VapourSynth.ofx.bundle', '--toml-helper', '/res/scripts/install_ofx_toml.py'],
    );
    assert.deepEqual(
        install.buildArgs('install', { bundlePath: '/b' }),
        ['install', '--source', '/b'],
    );
});

test('parseInstallerOutput accepts the JSON line and reconciles ok with the exit code', () => {
    assert.deepEqual(parse('{"ok":true,"installed":false}', 0), { ok: true, installed: false });
    assert.equal(parse('noise\n{"ok":true,"version":"2.0.0"}\ntrailing', 0).version, '2.0.0');
    const mismatch = parse('{"ok":true}', 2);
    assert.equal(mismatch.ok, true); // helper said ok; exit code mismatch is the helper's report
    const garbage = parse('not json at all', 3);
    assert.equal(garbage.ok, false);
    assert.match(garbage.error, /exited with code 3/);
    const empty = parse('', 0);
    assert.equal(empty.ok, false);
    assert.match(empty.error, /no JSON output/);
    const plainTrue = parse('true', 0);
    assert.equal(plainTrue.ok, false);
});

function parse(stdout, code) { return install.parseInstallerOutput(stdout, code); }

test('runInstaller resolves the parsed result on close', async () => {
    const child = fakeChild();
    const p = install.runInstaller({
        spawnImpl: () => child, helper: '/h', args: ['status'],
    });
    child.stdout.emit('data', '{"ok":true,"installed":true,"version":"2.0.0"}');
    child.emit('close', 0);
    const res = await p;
    assert.equal(res.ok, true);
    assert.equal(res.installed, true);
});

test('runInstaller surfaces spawn errors and non-zero exits honestly', async () => {
    const bad = install.runInstaller({ spawnImpl: () => { throw new Error('nope'); }, helper: '/h', args: ['status'] });
    assert.equal((await bad).ok, false);

    const child = fakeChild();
    const p = install.runInstaller({ spawnImpl: () => child, helper: '/h', args: ['install'] });
    child.stderr.emit('data', 'authorization was cancelled');
    child.emit('close', 2);
    const res = await p;
    assert.equal(res.ok, false);

    const errChild = fakeChild();
    const p2 = install.runInstaller({ spawnImpl: () => errChild, helper: '/h', args: ['status'] });
    errChild.emit('error', new Error('ENOENT'));
    assert.match((await p2).error, /failed to start/);
});

test('runInstaller times out on a hung child instead of pinning the process', async () => {
    const child = fakeChild();
    const res = await install.runInstaller({
        spawnImpl: () => child, helper: '/h', args: ['install'], timeoutMs: 40,
    });
    assert.equal(res.ok, false);
    assert.match(res.error, /timed out/);
    assert.equal(child.killed, true);
});
