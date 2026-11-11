// Actual model-stage-io source with in-memory Node20 callback ports. No real
// fixture files/descriptors/model/helper/native/process/network effects.
const test = require('node:test');
const assert = require('node:assert/strict');
const hostFS = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createFakeStageFS } = require('./test-fixtures/__test_stage_fs');
const source = hostFS.readFileSync(path.join(__dirname, 'model-stage-io.js'), 'utf8');
const loaded = { exports: {} };
vm.runInNewContext(source, { module: loaded, exports: loaded.exports, Buffer,
    require(name) { throw new Error('Unadmitted stage IO import: ' + name); } },
    { filename: 'actual-model-stage-io.js', timeout: 1000 });
const { createStageIO } = loaded.exports;
const capture = promise => {
    const state = { done: false, value: null, error: null };
    promise.then(value => { state.done = true; state.value = value; }, error => { state.done = true; state.error = error; });
    return state;
};
const flush = async () => { for (let i = 0; i < 512; i++) await Promise.resolve(); };
function fixture(t, options = {}) {
    const h = createFakeStageFS(hostFS.constants, options);
    h.io = createStageIO({ fs: h.fs, crypto,
        isStopped() { if (options.stopThrows) throw new Error('synthetic stop predicate failure'); return h.stopped; },
        onFailure(error) { h.errors.push(error); if (options.failureObserverThrows) throw new Error('synthetic failure observer teardown'); },
        onClosure() { h.closureStates.push(h.io.closed()); if (options.closureObserverThrows) throw new Error('synthetic closure observer teardown'); },
    });
    h.copy = (extra = {}) => capture(h.io.copyRegularFile(h.source, h.destination, h.stats(h.source), extra));
    t.after(() => assert.deepEqual(h.forbidden, [], 'No fallback/discovery/unlink or undeclared filesystem API may run'));
    return h;
}
function settled(state) {
    assert.equal(state.done, true, 'operation must settle after the selected callbacks finish');
    return state;
}
function rejected(state, expression) {
    settled(state); assert(state.error, 'expected a structured operation rejection');
    if (expression) assert.match(state.error.message, expression);
}
function closedOnce(h, file) { assert.equal(h.closeCalls(file).length, 1, 'one close request for each acquired descriptor'); }
const method = (name, fn) => test('model stage IO: ' + name, { timeout: 2000 }, fn);

method('copy is independent, chunk bounded, mode exact and SHA verified', async t => {
    const input = Buffer.alloc(65536 + 17, 0x5a);
    const h = fixture(t, { sourceBytes: input, umask: 0o077 });
    const result = h.copy({ mode: 0o644 }); assert.equal(h.io.closed(), false); await flush();
    assert.equal(settled(result).error, null); assert.deepEqual(h.bytes(h.destination), input);
    assert.deepEqual(h.bytes(h.source), input); assert.equal(result.value.bytes, input.length);
    assert.equal(result.value.digest, crypto.createHash('sha256').update(input).digest('hex'));
    assert.notEqual(result.value.identity.ino, h.stats(h.source).ino);
    assert.equal(result.value.identity.nlink, 1); assert.equal(result.value.identity.mode & 0o777, 0o644);
    for (const call of h.calls.filter(call => call.name === 'read' || call.name === 'write')) assert(call.length <= 65536);
    const opened = h.calls.filter(call => call.name === 'open');
    assert(opened[0].flags & hostFS.constants.O_NOFOLLOW); assert(opened[0].flags & hostFS.constants.O_NONBLOCK);
    assert(opened[1].flags & hostFS.constants.O_RDWR); assert(opened[1].flags & hostFS.constants.O_EXCL); assert(opened[1].flags & hostFS.constants.O_NOFOLLOW);
    assert.equal(h.io.closed(), true); assert.equal(h.descriptors.size, 0);
    closedOnce(h, h.source); closedOnce(h, h.destination);
});
method('short reads and partial writes preserve all bytes', async t => {
    const input = Buffer.from('sequential partial callback bytes');
    const h = fixture(t, { sourceBytes: input, maxRead: 5, maxWrite: 2 });
    const result = h.copy(); await flush(); assert.equal(settled(result).error, null);
    assert.deepEqual(h.bytes(h.destination), input); assert.equal(result.value.bytes, input.length);
    assert(h.calls.filter(call => call.name === 'write').length > 1); assert.equal(h.io.closed(), true);
});
method('empty regular files still require exact EOF and readback closure', async t => {
    const h = fixture(t, { sourceBytes: Buffer.alloc(0) }); const result = h.copy(); await flush();
    assert.equal(settled(result).error, null); assert.equal(result.value.bytes, 0);
    assert.equal(result.value.digest, crypto.createHash('sha256').digest('hex'));
    assert.equal(h.calls.filter(call => call.name === 'write').length, 0);
    assert.equal(h.calls.filter(call => call.name === 'read').length, 2); assert.equal(h.io.closed(), true);
});
method('source aliases and unsupported pinned sizes fail before open', async t => {
    for (const extra of [{ type: 'symlink', target: '/fixture/outside' }, { nlink: 2 }]) {
        const h = fixture(t); const expected = h.stats(h.source); Object.assign(h.node(h.source), extra);
        const result = capture(h.io.copyRegularFile(h.source, h.destination, expected)); await flush();
        rejected(result); assert.equal(h.calls.filter(call => call.name === 'open').length, 0); assert.equal(h.io.closed(), true);
    }
    for (const size of [-1, Number.MAX_SAFE_INTEGER + 1, NaN, 1.5]) {
        const h = fixture(t); h.node(h.source).size = size;
        const result = capture(h.io.copyRegularFile(h.source, h.destination, h.stats(h.source))); await flush();
        rejected(result); assert.equal(h.calls.length, 0); assert.equal(h.io.closed(), true);
    }
});
method('source replacement between lstat and open is never adopted', async t => {
    let replaced = false;
    const h = fixture(t, { before(call, h) {
        if (!replaced && call.name === 'open' && call.path === h.source) { replaced = true; h.replace(h.source, 'foreign source bytes'); }
    } });
    const result = h.copy(); await flush(); rejected(result, /source descriptor changed/);
    assert.equal(h.files.has(h.destination), false); assert.equal(h.bytes(h.source).toString(), 'foreign source bytes');
    closedOnce(h, h.source); assert.equal(h.io.closed(), true);
});
method('exclusive destination refuses ordinary files and links without truncation', async t => {
    for (const type of ['file', 'symlink', 'hardlink']) {
        const h = fixture(t); const target = h.put('/fixture/outside', 'preserve destination');
        if (type === 'hardlink') { target.nlink = 2; h.files.set(h.destination, target); }
        else h.put(h.destination, 'preserve destination', { type, target: '/fixture/outside' });
        const before = h.bytes(h.destination); const result = h.copy(); await flush(); rejected(result, /exists/);
        assert.deepEqual(h.bytes(h.destination), before); assert.equal(h.bytes('/fixture/outside').toString(), 'preserve destination');
        closedOnce(h, h.source); assert.equal(h.closeCalls(h.destination).length, 0); assert.equal(h.io.closed(), true);
    }
});
method('early EOF aborts without publishing a partial copy', async t => {
    const h = fixture(t, { sourceBytes: Buffer.from('0123456789abcdef'), maxRead: 4,
        before(call, h) { if (call.name === 'read' && call.path === h.source && call.position === 4) h.node(h.source).data = Buffer.from('0123'); } });
    const result = h.copy(); await flush(); rejected(result, /ended before/);
    closedOnce(h, h.source); closedOnce(h, h.destination); assert.equal(h.io.closed(), true); assert.equal(h.errors.length, 1);
});
method('extra byte at pinned EOF is rejected', async t => {
    const h = fixture(t, { before(call, h) {
        if (call.name === 'read' && call.path === h.source && call.length === 1 && call.position === h.node(h.source).data.length) {
            h.node(h.source).data = Buffer.concat([h.node(h.source).data, Buffer.from('x')]);
        }
    } });
    const result = h.copy(); await flush(); rejected(result, /exceeded its pinned size/);
    closedOnce(h, h.source); closedOnce(h, h.destination); assert.equal(h.io.closed(), true);
});
method('destination readback detects wrong bytes independently of stat metadata', async t => {
    let corrupted = false;
    const h = fixture(t, { before(call, h) {
        if (!corrupted && call.name === 'read' && call.path === h.destination) { corrupted = true; h.node(h.destination).data[0] ^= 1; }
    } });
    const result = h.copy(); await flush(); rejected(result, /readback checksum mismatch/);
    assert.equal(h.io.closed(), true); closedOnce(h, h.source); closedOnce(h, h.destination);
});
method('source mode and timestamps remain pinned across copy', async t => {
    for (const field of ['mode', 'mtimeMs', 'ctimeMs']) {
        let changed = false;
        const h = fixture(t, { before(call, h) {
            if (!changed && call.name === 'read' && call.path === h.source) { changed = true; h.node(h.source)[field] += 1; }
        } });
        const result = h.copy(); await flush(); rejected(result, /source descriptor changed/); assert.equal(h.io.closed(), true);
    }
});
method('postclose source or destination replacement stays untouched and rejects success', async t => {
    for (const which of ['source', 'destination']) {
        let replaced = false;
        const h = fixture(t, { before(call, h) {
            if (!replaced && call.name === 'close' && call.path === h[which]) { replaced = true; h.replace(h[which], 'foreign replacement'); }
        } });
        const result = h.copy(); await flush(); rejected(result, /path changed/);
        assert.equal(h.bytes(h[which]).toString(), 'foreign replacement'); assert.equal(h.io.closed(), true);
        closedOnce(h, h.source); closedOnce(h, h.destination);
    }
});
method('zero and impossible write counts fail instead of looping', async t => {
    for (const count of [0, 'too-many']) {
        const h = fixture(t, { writeCount(call) { return count === 'too-many' ? call.length + 1 : count; } });
        const result = h.copy(); await flush(); rejected(result, /valid progress/);
        assert.equal(h.calls.filter(call => call.name === 'write').length, 1);
        closedOnce(h, h.source); closedOnce(h, h.destination); assert.equal(h.io.closed(), true);
    }
});
method('first IO error survives both close errors and the other close is still awaited', async t => {
    const original = new Error('first source read failure');
    const h = fixture(t, { error(call, h) {
        if (call.name === 'read' && call.path === h.source) return original;
        if (call.name === 'close') return new Error('later close failure');
    }, hold: call => call.name === 'close' && call.path.endsWith('destination.bin') });
    const result = h.copy(); await flush(); assert.equal(result.done, false); assert.equal(h.io.closed(), false);
    closedOnce(h, h.source); closedOnce(h, h.destination); assert.equal(h.errors.length, 1); assert.equal(h.errors[0], original);
    h.release(h.held[0]); await flush(); rejected(result); assert.equal(result.error, original);
    assert.equal(h.io.closed(), false, 'failed closes remain owned unknown');
});
method('a failed close cannot suppress the other close or be retried numerically', async t => {
    for (const synchronous of [false, true]) {
        const issue = new Error('synthetic input close failure');
        const selected = call => call.name === 'close' && call.path.endsWith('source.bin');
        const h = fixture(t, { error: call => !synchronous && selected(call) ? issue : null,
            throwSync: call => synchronous && selected(call) ? issue : null });
        const result = h.copy(); await flush(); rejected(result); assert.equal(result.error, issue);
        closedOnce(h, h.source); closedOnce(h, h.destination); assert.equal(h.io.closed(), false);
        await flush(); closedOnce(h, h.source); assert.equal(h.errors.length, 1);
    }
});
method('missing close callback stays owned and a slow successful close has no invented deadline', async t => {
    const h = fixture(t, { hold: call => call.name === 'close' && call.path.endsWith('destination.bin') });
    const result = h.copy(); await flush(); assert.equal(result.done, false); assert.equal(h.io.closed(), false); assert.equal(h.errors.length, 0);
    await flush(); assert.equal(result.done, false); closedOnce(h, h.destination);
    h.release(h.held[0]); await flush(); assert.equal(settled(result).error, null); assert.equal(h.io.closed(), true);
    const never = fixture(t, { hold: call => call.name === 'close' && call.path.endsWith('destination.bin') });
    const pending = never.copy(); await flush(); never.stopped = true; await flush();
    assert.equal(pending.done, false); assert.equal(never.io.closed(), false); closedOnce(never, never.destination);
    // Deliberately retained fake callback: no real fd/timer/process exists.
});
method('missing read callback retains both fds and a late stopped read dispatches no write', async t => {
    for (const withError of [false, true]) {
        const h = fixture(t, { hold: call => call.name === 'read' && call.path.endsWith('source.bin') && call.position === 0 });
        const result = h.copy(); await flush(); assert.equal(result.done, false); assert.equal(h.io.closed(), false);
        assert.equal(h.descriptors.size, 2); assert.equal(h.calls.filter(call => call.name === 'write').length, 0);
        h.stopped = true; h.release(h.held[0], withError ? new Error('late read error') : undefined); await flush();
        rejected(result, withError ? /late read error/ : /stopped/);
        assert.equal(h.calls.filter(call => call.name === 'write').length, 0); assert.equal(h.io.closed(), true);
        closedOnce(h, h.source); closedOnce(h, h.destination);
    }
});
method('late open after stop is registered and closed before ownership release', async t => {
    const h = fixture(t, { hold: call => call.name === 'open' && call.path.endsWith('source.bin') });
    const result = h.copy(); await flush(); assert.equal(h.descriptors.size, 1); assert.equal(h.io.closed(), false);
    h.stopped = true; const mark = h.calls.length; h.release(h.held[0]); await flush(); rejected(result, /stopped/);
    assert(h.calls.slice(mark).every(call => call.name === 'close')); closedOnce(h, h.source);
    assert.equal(h.descriptors.size, 0); assert.equal(h.io.closed(), true);
});
method('an error callback carrying an acquired fd still closes that owned descriptor', async t => {
    const issue = new Error('open failed after fd acquisition');
    const h = fixture(t, { afterError: call => call.name === 'open' && call.path.endsWith('source.bin') ? issue : null });
    const result = h.copy(); await flush(); rejected(result); assert.equal(result.error, issue);
    closedOnce(h, h.source); assert.equal(h.descriptors.size, 0); assert.equal(h.io.closed(), true); assert.equal(h.errors.length, 1);
});
method('already admitted write may finish after stop but no following write is dispatched', async t => {
    const h = fixture(t, { maxWrite: 2, hold: call => call.name === 'write' });
    const result = h.copy(); await flush(); assert.equal(h.held.length, 1); assert.equal(h.io.closed(), false);
    assert.equal(h.calls.filter(call => call.name === 'write').length, 1); h.stopped = true;
    h.release(h.held[0]); await flush(); rejected(result, /stopped/);
    assert.equal(h.calls.filter(call => call.name === 'write').length, 1); assert.equal(h.bytes(h.destination).length, 2);
    assert.equal(h.io.closed(), true); closedOnce(h, h.source); closedOnce(h, h.destination);
});
method('stop before admission and throwing stop predicate cause no filesystem dispatch', async t => {
    for (const throws of [false, true]) {
        const h = fixture(t, { stopThrows: throws }); h.stopped = true;
        const result = h.copy(); await flush(); rejected(result, /stop/); assert.equal(h.calls.length, 0); assert.equal(h.io.closed(), true);
    }
});
method('metadata write is exclusive, bounded, mode exact and snapshots caller bytes', async t => {
    const h = fixture(t, { hold: call => call.name === 'open' });
    const input = Buffer.from('bounded journal bytes'); const expected = Buffer.from(input);
    const result = capture(h.io.writeBytesExclusive(h.metadata, input, 0o640)); await flush(); input.fill(0);
    h.release(h.held[0]); await flush(); assert.equal(settled(result).error, null); assert.deepEqual(h.bytes(h.metadata), expected);
    assert.equal(result.value.mode & 0o777, 0o640); assert.equal(h.io.closed(), true);
    const boundary = fixture(t); const edge = capture(boundary.io.writeBytesExclusive(boundary.metadata, Buffer.alloc(65536, 1)));
    await flush(); assert.equal(settled(edge).error, null); assert.equal(boundary.bytes(boundary.metadata).length, 65536);
    assert(boundary.calls.filter(call => call.name === 'write').every(call => call.length <= 65536));
    let replaced = false;
    const foreign = fixture(t, { before(call, h) {
        if (!replaced && call.name === 'close' && call.path === h.metadata) { replaced = true; h.replace(h.metadata, 'foreign metadata'); }
    } });
    const changed = capture(foreign.io.writeBytesExclusive(foreign.metadata, Buffer.from('own record'))); await flush();
    rejected(changed, /path changed/); assert.equal(foreign.bytes(foreign.metadata).toString(), 'foreign metadata'); assert.equal(foreign.io.closed(), true);
    for (const [buffer, mode] of [[Buffer.alloc(65537), 0o600], [Buffer.from('x'), 0o1000], ['not a buffer', 0o600]]) {
        const bad = fixture(t); const outcome = capture(bad.io.writeBytesExclusive(bad.metadata, buffer, mode)); await flush();
        rejected(outcome); assert.equal(bad.calls.length, 0); assert.equal(bad.io.closed(), true);
    }
});
method('bounded metadata read handles short callbacks, optional identity and exact EOF', async t => {
    const h = fixture(t, { maxRead: 3 }); const data = Buffer.from('owned metadata read'); h.put(h.metadata, data);
    const result = capture(h.io.readBytes(h.metadata, 65536, h.stats(h.metadata))); await flush();
    assert.equal(settled(result).error, null); assert.deepEqual(result.value.data, data);
    assert.equal(result.value.identity.ino, h.stats(h.metadata).ino); closedOnce(h, h.metadata); assert.equal(h.io.closed(), true);
    const boundary = fixture(t); boundary.put(boundary.metadata, Buffer.alloc(65536, 1));
    const edge = capture(boundary.io.readBytes(boundary.metadata)); await flush(); assert.equal(settled(edge).error, null);
    assert.equal(edge.value.data.length, 65536); assert(boundary.calls.filter(call => call.name === 'read').every(call => call.length <= 65536));
});
method('metadata oversize aliases stale identity and extra EOF are never accepted', async t => {
    for (const kind of ['oversize', 'symlink', 'hardlink', 'stale']) {
        const h = fixture(t); h.put(h.metadata, Buffer.from('metadata'));
        const expected = h.stats(h.metadata);
        if (kind === 'oversize') h.node(h.metadata).size = 65537;
        if (kind === 'symlink') h.node(h.metadata).type = 'symlink';
        if (kind === 'hardlink') h.node(h.metadata).nlink = 2;
        if (kind === 'stale') expected.ino += 1;
        const result = capture(h.io.readBytes(h.metadata, 65536, kind === 'stale' ? expected : undefined)); await flush();
        rejected(result); assert.equal(h.calls.filter(call => call.name === 'open').length, 0); assert.equal(h.io.closed(), true);
    }
    for (const limit of [-1, 65537, 1.5, '65536']) {
        const h = fixture(t); h.put(h.metadata, 'small'); const bad = capture(h.io.readBytes(h.metadata, limit)); await flush();
        rejected(bad); assert.equal(h.calls.length, 0); assert.equal(h.io.closed(), true);
    }
    const replaced = fixture(t, { before(call, h) {
        if (call.name === 'close' && call.path === h.metadata) h.replace(h.metadata, 'foreign read record');
    } });
    replaced.put(replaced.metadata, 'own read record'); const changed = capture(replaced.io.readBytes(replaced.metadata)); await flush();
    rejected(changed, /path changed/); assert.equal(replaced.bytes(replaced.metadata).toString(), 'foreign read record'); assert.equal(replaced.io.closed(), true);
    const grown = fixture(t, { before(call, h) {
        if (call.name === 'read' && call.path === h.metadata && call.length === 1) h.node(h.metadata).data = Buffer.concat([h.node(h.metadata).data, Buffer.from('x')]);
    } });
    grown.put(grown.metadata, 'old'); const result = capture(grown.io.readBytes(grown.metadata)); await flush(); rejected(result, /exceeded/); assert.equal(grown.io.closed(), true);
});
method('throwing observers cannot replace first error, duplicate failure or suppress cleanup', async t => {
    const issue = new Error('first real callback error');
    const h = fixture(t, { failureObserverThrows: true, closureObserverThrows: true,
        error: call => call.name === 'read' ? issue : null });
    const result = h.copy(); await flush(); rejected(result); assert.equal(result.error, issue); assert.equal(h.errors.length, 1);
    closedOnce(h, h.source); closedOnce(h, h.destination); assert.equal(h.io.closed(), true);
    const perOperation = fixture(t); perOperation.put(perOperation.metadata, 'existing');
    const one = capture(perOperation.io.writeBytesExclusive(perOperation.metadata, Buffer.from('a')));
    const two = capture(perOperation.io.writeBytesExclusive(perOperation.metadata, Buffer.from('b'))); await flush();
    rejected(one, /exists/); rejected(two, /exists/); assert.equal(perOperation.bytes(perOperation.metadata).toString(), 'existing'); assert.equal(perOperation.errors.length, 2); assert.equal(perOperation.io.closed(), true);
});
