// Fixed-only manager/IPC/resource controls, all child/clock/network ports fake.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { harness } = require('./test-fixtures/__test_model_extractor_harness');
function done(result) { assert.equal(result.done, true, 'selected terminal condition must settle'); assert.equal(result.error, null); return result.value; }
async function blocked(h) {
    for (const name of ['models:download', 'models:extract', 'models:remove']) assert.equal((await h.handlers[name]({}, { id: h.id })).ok, false, name);
}

test('staged manager: acquired PID-null child error requires its actual close before original-process recovery', async t => {
    let queryOverdue = false;
    const h = harness(t, { monotonic: now => BigInt(now + (queryOverdue ? 7200000 : 0)) * 1000000n });
    const result = h.start(); await h.flush(); assert.equal(h.children.length, 1); const child = h.children[0];
    const anchorBytes = fs.readFileSync(h.anchor); queryOverdue = true;
    const passive = await h.handlers['models:extraction-recovery']({}, { id: h.id, action: 'inspect' });
    assert.equal(passive.canRestore, false); assert.equal(child.kills.length, 0, 'inspection never checks/aborts an overdue action');
    assert.deepEqual(fs.readFileSync(h.anchor), anchorBytes); queryOverdue = false; delete child.pid;
    child.emit('error', new Error('inert acquired child not started')); await h.flush();
    assert.equal(done(result).notStarted, true); assert.equal(done(result).closureKnown, false); assert.equal(fs.existsSync(h.anchor), true); await blocked(h);
    assert.equal((await h.handlers['models:extraction-recovery']({}, { id: h.id, action: 'restore' })).canRestore, false);
    child.close(); await h.flush(); assert.equal(fs.existsSync(h.anchor), true, 'late close alone cannot replay publication');
    const inspected = await h.handlers['models:extraction-recovery']({}, { id: h.id, action: 'inspect' });
    assert.equal(inspected.canRestore, true, 'a finished original action can prospectively acquire recovery after exact late close');
    const restored = await h.handlers['models:extraction-recovery']({}, { id: h.id, action: 'restore' });
    assert.equal(restored.ok, true); assert.equal(fs.existsSync(h.anchor), false);
    const final = await h.handlers['models:extraction-recovery']({}, { id: h.id, action: 'inspect' });
    assert.equal(final.canRestore, false); assert.equal(final.pending, false);
    let physicallyReleased = false, forgedReceipt = false, writesAfterRelease = 0;
    const committed = harness(t, { fileOverrides: h => ({
        renameSync(from, to) {
            if (physicallyReleased) writesAfterRelease++; fs.renameSync(from, to);
            if (from === h.anchor && path.basename(to) === 'journal.json') physicallyReleased = true;
        },
        openSync(file, flags, ...args) { if (physicallyReleased && (flags & fs.constants.O_CREAT)) writesAfterRelease++; return fs.openSync(file, flags, ...args); },
        mkdirSync(file, ...args) { if (physicallyReleased) writesAfterRelease++; return fs.mkdirSync(file, ...args); },
        lstatSync(file) {
            const info = fs.lstatSync(file);
            if (physicallyReleased && !forgedReceipt && path.basename(file) === 'journal.json') {
                forgedReceipt = true; return Object.assign(Object.create(Object.getPrototypeOf(info)), info, { ino: info.ino + 1 });
            }
            return info;
        },
    }) });
    const publication = committed.start(); await committed.flush(); assert.equal(committed.children.length, 1);
    committed.children[0].close(); await committed.flush(); const reported = done(publication);
    assert.equal(reported.ok, false); assert.equal(reported.needsRecovery, false); assert.equal(reported.publicationUncertain, true);
    assert.equal(reported.retainedStorage.status, 'retained'); assert.equal(physicallyReleased, true); assert.equal(forgedReceipt, true);
    assert.equal(committed.list().state, 'ready'); assert.equal(writesAfterRelease, 0, 'post-release receipt failure cannot cause restoration writes');
    assert.equal((await committed.handlers['models:extraction-recovery']({}, { id: committed.id, action: 'restore' })).ok, false);
    assert.equal(writesAfterRelease, 0);
});

test('staged manager: failed hash acquisition settles only after one proven exact descriptor close', async t => {
    let hashFd, closes = 0;
    const h = harness(t, { fileOverrides: () => ({
        fstatSync(fd) { hashFd = fd; throw new Error('inert hash fstat failure'); },
        closeSync(fd) { if (fd === hashFd) closes++; return fs.closeSync(fd); },
    }) });
    const result = h.start(); await h.flush(); assert.equal(done(result).closureKnown, true); assert.match(done(result).error, /hash fstat failure/);
    assert.equal(closes, 1); assert.equal(h.readers.length, 0); assert.equal(h.children.length, 0); assert.equal(fs.existsSync(h.anchor), false);
});

test('staged manager: hash acquisition close error yields one unknown response and keeps ownership without FD retry', async t => {
    let hashFd, closes = 0;
    const h = harness(t, { fileOverrides: () => ({
        fstatSync(fd) { hashFd = fd; throw new Error('inert acquisition failure'); },
        closeSync(fd) { if (fd === hashFd) { closes++; fs.closeSync(fd); throw new Error('inert close receipt failure'); } return fs.closeSync(fd); },
    }) });
    const result = h.start(); await h.flush(); assert.equal(result.done, false); h.clock.advance(5000); await h.flush();
    const value = done(result); assert.equal(value.closureKnown, false); assert.match(value.error, /acquisition failure/); assert.equal(closes, 1);
    assert.equal(h.readers.length, 0); assert.equal(h.children.length, 0); await blocked(h); h.clock.advance(5000); await h.flush();
    assert.equal(result.value, value); assert.equal(closes, 1, 'numeric fd is never retried');
});

test('staged manager: stage policy request overrides reach exact validated capacity arithmetic and survive list reload', async t => {
    const h = harness(t, { env: { VSRES_MODEL_STAGE_HEADROOM_BYTES: 'bad', VSRES_MODEL_STAGE_TIMEOUT_MS: 'bad', VSRES_MODEL_STAGE_MAX_ENTRIES: 'bad', VSRES_MODEL_STAGE_MAX_DEPTH: 'bad', VSRES_MODEL_STAGE_MAX_MANIFEST_BYTES: 'bad' } });
    fs.writeFileSync(path.join(h.dir, 'manual.bin'), 'manual ordinary extra');
    const result = h.start({ stageHeadroomBytes: 0, stageTimeoutMs: 8000, stageMaxEntries: 100, stageMaxDepth: 16, stageMaxManifestBytes: 65536 });
    await h.flush(); assert.equal(h.children.length, 1); h.children[0].close(); await h.flush(); const value = done(result);
    assert.equal(value.ok, true); assert.equal(value.space.headroomBytes, 0);
    const expected = BigInt(h.payload.length) + BigInt(Buffer.byteLength('manual ordinary extra')) + BigInt(h.entry.diskBytesNeeded) + 4n * 65536n;
    assert.equal(value.space.plannedAdditionalBytes, expected.toString());
    assert.equal(fs.readFileSync(path.join(h.dir, 'manual.bin'), 'utf8'), 'manual ordinary extra');
    h.restart(); assert.equal(h.list().state, 'ready'); assert.equal(h.list().retainedStorage.status, 'retained'); assert.equal(h.list().retainedStorage.bytes, null);
});

test('staged manager: invalid stage policy fields fail before hash or journal mutation', async t => {
    for (const [key, value] of [['stageHeadroomBytes', -1], ['stageHeadroomBytes', '0'], ['stageTimeoutMs', 0], ['stageTimeoutMs', Number.MAX_SAFE_INTEGER + 1], ['stageMaxEntries', 0], ['stageMaxDepth', -1], ['stageMaxManifestBytes', '64']]) {
        const h = harness(t); h.writeReady(); const before = fs.readFileSync(h.marker), result = h.start({ [key]: value }); await h.flush();
        assert.equal(done(result).reason, 'probe-invalid-budget'); assert.equal(h.readers.length, 0); assert.equal(h.children.length, 0);
        assert.deepEqual(fs.readFileSync(h.marker), before); assert.equal(fs.existsSync(h.anchor), false);
    }
});

test('staged manager: whole-stage expiry aborts owned writer and only actual close permits failure disposition', async t => {
    const h = harness(t); h.writeReady(); const before = fs.readFileSync(h.marker), result = h.start({ timeoutMs: 1000, stageTimeoutMs: 10 }); await h.flush();
    assert.equal(h.children.length, 1); h.clock.advance(10); await h.flush(); assert.deepEqual(Array.from(h.children[0].kills), ['SIGKILL']);
    assert.equal(result.done, false); assert.equal(fs.existsSync(h.anchor), true); h.children[0].close(null, 'SIGKILL'); await h.flush();
    assert.equal(done(result).closureKnown, true); assert.match(done(result).error, /staged extraction exceeded 10 ms/);
    assert.deepEqual(fs.readFileSync(h.marker), before); assert.equal(fs.existsSync(h.anchor), false); assert.equal(h.list().state, 'ready');
    let interruptRestore = false;
    const recovery = harness(t, { fileOverrides: h => ({ openSync(file, ...args) {
        const fd = fs.openSync(file, ...args);
        if (interruptRestore && path.basename(file).startsWith('.journal-')) { interruptRestore = false; h.clock.advance(10); }
        return fd;
    } }) });
    const held = recovery.start({ timeoutMs: 10, stageTimeoutMs: 10 }); await recovery.flush();
    recovery.clock.advance(10); recovery.clock.advance(5000); await recovery.flush(); assert.equal(done(held).closureKnown, false);
    recovery.children[0].close(null, 'SIGKILL'); await recovery.flush(); interruptRestore = true;
    const reply = await recovery.handlers['models:extraction-recovery']({}, { id: recovery.id, action: 'restore' });
    assert.equal(reply.ok, false); assert.match(reply.error, /staged extraction exceeded 10 ms/);
    assert.equal(fs.existsSync(recovery.anchor), true, 'new recovery deadline is not exempted as the old action failure');
    let expireDisposition = false;
    const automatic = harness(t, { fileOverrides: h => ({ openSync(file, ...args) {
        const fd = fs.openSync(file, ...args);
        if (expireDisposition && path.basename(file).startsWith('.journal-')) { expireDisposition = false; h.clock.advance(10); }
        return fd;
    } }) });
    const failure = automatic.start({ stageTimeoutMs: 10 }); await automatic.flush(); expireDisposition = true;
    automatic.children[0].stderr.write('first native failure'); automatic.children[0].close(7); await automatic.flush();
    assert.equal(done(failure).ok, false); assert.match(done(failure).error, /first native failure/);
    assert.equal(fs.existsSync(automatic.anchor), true, 'new expiry stops automatic disposition despite an earlier authoritative error');
});

test('staged manager: long native override retains a longer whole-stage default via safe timer chunks', async t => {
    const h = harness(t); const maximum = 2147483647, result = h.start({ timeoutMs: maximum }); await h.flush(); assert.equal(h.children.length, 1);
    const deadlines = [...h.timers.values()].map(timer => timer.at);
    assert.ok(deadlines.every(value => value <= maximum + 1000), 'first timer chunk stays in native range');
    h.clock.advance(maximum - 1); await h.flush(); assert.equal(h.children[0].kills.length, 0); assert.equal(result.done, false);
    h.children[0].close(); await h.flush(); assert.equal(done(result).ok, true, 'whole default has not silently expired at long child boundary');
});

test('staged manager: fresh module can inspect held journal but gains no recovery mutation authority', async t => {
    const h = harness(t); const result = h.start({ timeoutMs: 10 }); await h.flush(); h.clock.advance(10); h.clock.advance(5000); await h.flush();
    assert.equal(done(result).closureKnown, false); const before = fs.readFileSync(h.anchor); h.restart();
    const inspected = await h.handlers['models:extraction-recovery']({}, { id: h.id, action: 'inspect' });
    assert.equal(inspected.pending, true); assert.equal(inspected.canRestore, false);
    const restore = await h.handlers['models:extraction-recovery']({}, { id: h.id, action: 'restore' }); assert.equal(restore.ok, false); assert.equal(restore.canRestore, false);
    assert.deepEqual(fs.readFileSync(h.anchor), before); await blocked(h);
    let expireAtArm = false, monotonicReads = 0; const writes = [];
    const early = harness(t, { monotonic(now) { return BigInt(now + (expireAtArm && ++monotonicReads > 1 ? 2 : 0)) * 1000000n; },
        fileOverrides: () => ({
            openSync(file, flags, ...args) { if (flags & fs.constants.O_CREAT) writes.push(file); return fs.openSync(file, flags, ...args); },
            mkdirSync(file, ...args) { writes.push(file); return fs.mkdirSync(file, ...args); },
            renameSync(from, to) { writes.push(to); return fs.renameSync(from, to); },
        }) });
    const stopped = early.start({ stageTimeoutMs: 1 }); await early.flush(); early.clock.advance(1); early.clock.advance(5000); await early.flush();
    assert.equal(done(stopped).closureKnown, false); early.children[0].close(null, 'SIGKILL'); await early.flush();
    expireAtArm = true; const beforeWrites = writes.length, anchorBytes = fs.readFileSync(early.anchor);
    const expired = await early.handlers['models:extraction-recovery']({}, { id: early.id, action: 'restore' });
    assert.equal(expired.ok, false); assert.match(expired.error, /staged extraction exceeded 1 ms/);
    assert.equal(writes.length, beforeWrites, 'an expired fresh action admits no recovery writes'); assert.deepEqual(fs.readFileSync(early.anchor), anchorBytes);
});
