// Actual producer query in a VM. Filesystem metadata/content, lifecycle maps
// and pending-kind state are inert fake ports; no real model path or helper.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const buffer = require('node:buffer');
const source = fs.readFileSync(path.join(__dirname, 'model-manager.js'), 'utf8');
const stageSources = new Map([
    ['./model-stage-transaction', fs.readFileSync(path.join(__dirname, 'model-stage-transaction.js'), 'utf8')],
    ['./model-stage-io', fs.readFileSync(path.join(__dirname, 'model-stage-io.js'), 'utf8')],
]);

function fixture(options = {}) {
    const root = '/fixture/models', id = 'fixture-model', dir = root + '/' + id;
    const marker = dir + '/extracted.json', flag = dir + '/.extraction-unverified.json';
    const anchor = root + '/.vsres-' + id + '.transaction.json';
    const entry = { id, version: 'fixture', sha256: '0'.repeat(64) };
    const metadata = { id, version: entry.version, sha256: entry.sha256, extractedAt: 1000 };
    const nodes = new Map([[root, { type: 'dir', ino: 1 }], [dir, { type: 'dir', ino: 2 }]]);
    const fds = new Map(), calls = []; let nextFd = 100, pending = false, closes = 0;
    const missing = p => Object.assign(new Error('inert missing path: ' + p), { code: 'ENOENT' });
    const info = node => ({ dev: 1, ino: node.ino, nlink: node.nlink ?? (node.type === 'dir' ? 2 : 1),
        size: node.size ?? node.data?.length ?? 0, mtimeMs: node.mtimeMs ?? 1,
        isFile: () => node.type === 'file', isDirectory: () => node.type === 'dir', isSymbolicLink: () => node.type === 'link' });
    const h = { root, id, dir, marker, flag, anchor, entry, metadata, nodes, calls,
        setPending: value => { pending = value; }, closed: () => closes,
        putMarker: (data = JSON.stringify(metadata), extra = {}) => nodes.set(marker, { type: 'file', ino: 3, data: Buffer.from(data), ...extra }) };
    const filePorts = {
        constants: fs.constants,
        lstatSync(p) { calls.push(['lstat', p]); const node = nodes.get(p); if (!node) throw missing(p);
            if (node.metadataError) throw Object.assign(new Error('inert metadata refusal'), { code: 'EACCES' });
            return info(node); },
        realpathSync(p) { calls.push(['realpath', p]); const node = nodes.get(p); if (!node) throw missing(p);
            if (node.denied) throw Object.assign(new Error('inert permission refusal'), { code: 'EACCES' });
            return node.canonical || p; },
        openSync(p, flags) { calls.push(['open', p]); assert.equal(p, marker); assert.ok(flags & fs.constants.O_NOFOLLOW);
            const node = nodes.get(p); if (!node) throw missing(p); const fd = nextFd++; fds.set(fd, { node, used: 0 }); return fd; },
        fstatSync(fd) { assert(fds.has(fd)); return info(fds.get(fd).node); },
        readSync(fd, buffer, offset, length) { const opened = fds.get(fd); assert(opened); calls.push(['read', length]);
            const count = Math.min(length, opened.node.data.length - opened.used);
            opened.node.data.copy(buffer, offset, opened.used, opened.used + count); opened.used += count;
            options.onRead?.(h); return count; },
        closeSync(fd) { assert(fds.delete(fd)); closes++; options.onClose?.(h); },
    };
    for (const name of ['existsSync', 'readdirSync', 'statSync', 'mkdirSync', 'writeFileSync', 'renameSync', 'unlinkSync', 'rmSync']) {
        filePorts[name] = () => assert.fail('Read admission must never enumerate/discover/measure/mutate: ' + name);
    }
    const stageModules = new Map();
    const processPort = { env: { VSRES_MODELS_ROOT: root },
        getuid() { assert.fail('No transaction constructor is admitted in read query controls'); } };
    const cryptoPort = {
        randomBytes() { assert.fail('No transaction allocation is admitted in read query controls'); },
        createHash() { assert.fail('No payload hashing is admitted in read query controls'); },
    };
    function evaluate(text, filename) {
        const module = { exports: {} };
        vm.runInNewContext(text, {
            module, exports: module.exports, Buffer, URL, process: processPort,
            require(name) {
                if (stageSources.has(name)) {
                    if (!stageModules.has(name)) stageModules.set(name, evaluate(stageSources.get(name), name + '.js'));
                    return stageModules.get(name);
                }
                if (name === 'fs') return filePorts;
                if (name === 'path') return path;
                if (name === 'buffer') return buffer;
                if (name === 'os') return { homedir: () => '/fixture/home' };
                if (name === 'crypto') return cryptoPort;
                if (name === 'child_process') return { spawn() { assert.fail('No actual or fake child dispatch is permitted in producer query controls'); } };
                if (name === './probe-process') return { hasPendingProbeStop: () => pending,
                    runProbeProcess() { assert.fail('No process utility dispatch in read query'); } };
                if (name === '../shared/model-registry.json') return { models: [entry] };
                throw new Error('Unadmitted read query import: ' + name);
            },
        }, { filename, timeout: 1000 });
        return module.exports;
    }
    const api = evaluate(source + '\nmodule.exports.__fixtureMaps = { active, extracting };', 'model-read-admission-contract.js');
    return { ...h, api, query: requested => api.inspectModelForRead(requested === undefined ? id : requested) };
}

function method(name, fn) { test('model read producer: ' + name, fn); }
method('actual query export exists', () => {
    assert.equal(typeof fixture().api.inspectModelForRead, 'function', 'the producer must expose the reviewed read-only query contract');
});
method('unknown and malformed registry ids fail before filesystem reads', () => {
    const h = fixture();
    for (const id of ['../other', 'unknown-model', '', '/absolute']) assert.equal(h.query(id).ok, false);
    assert.equal(h.calls.length, 0);
});
method('absent ordinary model location returns existsfalse without enumeration', () => {
    const h = fixture(); h.nodes.delete(h.dir); const result = h.query();
    assert.equal(result.ok, true); assert.equal(result.exists, false); assert.equal(result.completion, 'missing');
    assert.equal(result.identity, null); assert.equal(result.legacy, false); assert.equal(h.closed(), 0);
});
method('ordinary manual no-marker input remains admitted as legacy and unverified', () => {
    const h = fixture(); const result = h.query();
    assert.equal(result.ok, true); assert.equal(result.exists, true); assert.equal(result.legacy, true);
    assert.equal(result.completion, 'missing'); assert.equal(result.root, h.root); assert.equal(result.dir, h.dir);
    assert.equal(result.identity.ino, 2); assert.equal(h.closed(), 0); assert(!h.calls.some(([name]) => name === 'open'));
});
method('valid bounded marker snapshot returns completion identity and closes its nofollow reader', () => {
    const h = fixture(); h.putMarker(); const result = h.query();
    assert.equal(result.ok, true); assert.equal(result.completion, 'verified'); assert.equal(result.legacy, false);
    assert.equal(result.completionIdentity.ino, 3); assert.equal(result.completionIdentity.mtimeMs, 1);
    assert.equal(h.closed(), 1); assert(h.calls.filter(([name]) => name === 'read').every(([, size]) => size <= 65537));
});
method('invalid linked oversized or mismatched marker refuses without following alias', () => {
    for (const [data, extra] of [['not JSON', {}], [JSON.stringify({ bad: true }), {}],
        ['{}', { type: 'link' }], ['{}', { nlink: 2 }], ['{}', { size: 65537 }], ['{}', { type: 'dir' }]]) {
        const h = fixture(); h.putMarker(data, extra); const result = h.query(); assert.equal(result.ok, false); assert.ok(result.error); assert.ok(result.recovery);
        if (extra.type || extra.nlink || extra.size) assert(!h.calls.some(([name]) => name === 'open'));
    }
});
method('unverified record shared pending kind and transaction anchors block before marker or weights reads', () => {
    for (const kind of ['file', 'link', 'pending']) {
        const h = fixture(); h.putMarker();
        if (kind === 'pending') h.setPending(true); else h.nodes.set(h.flag, { type: kind, ino: 4 });
        assert.equal(h.query().ok, false); assert(!h.calls.some(([name]) => name === 'open'));
    }
    // Presence is sufficient: no journal parsing or trust in stored phase/PID.
    // A missing model directory must not turn a pending transaction into absence.
    for (const type of ['file', 'link', 'dir', 'metadata-error']) for (const absent of [false, true]) {
        const h = fixture();
        if (absent) h.nodes.delete(h.dir); else h.putMarker();
        h.nodes.set(h.anchor, { type, ino: 5, data: Buffer.from('not a journal'), metadataError: type === 'metadata-error' });
        const result = h.query();
        assert.equal(result.ok, false); assert.ok(result.error); assert.ok(result.recovery);
        assert(h.calls.some(([name, p]) => name === 'lstat' && p === h.anchor));
        assert(!h.calls.some(([name]) => name === 'open' || name === 'read'));
    }
});
method('active or extracting identity maps block before completion metadata reads', () => {
    for (const map of ['active', 'extracting']) for (const closureUnknown of [false, true]) {
        const h = fixture(); h.putMarker(); h.api.__fixtureMaps[map].set(h.id, { closureUnknown });
        assert.equal(h.query().ok, false); assert(!h.calls.some(([name]) => name === 'open'));
    }
});
method('container aliases nonordinary and canonical permission errors are rejected', () => {
    for (const extra of [{ type: 'link', canonical: '/outside' }, { type: 'file' }, { canonical: '/outside' }, { denied: true }]) {
        const h = fixture(); h.nodes.set(h.dir, { type: 'dir', ino: 2, ...extra }); h.putMarker();
        assert.equal(h.query().ok, false); assert(!h.calls.some(([name]) => name === 'open'));
    }
});
method('directory or completion replacement during metadata read cannot publish stale admission', () => {
    const directory = fixture({ onRead(h) { h.nodes.set(h.dir, { type: 'dir', ino: 22 }); } });
    directory.putMarker(); assert.equal(directory.query().ok, false);
    const marker = fixture({ onClose(h) { h.nodes.set(h.marker, { ...h.nodes.get(h.marker), ino: 33 }); } });
    marker.putMarker(); assert.equal(marker.query().ok, false); assert.equal(marker.closed(), 1);
});
