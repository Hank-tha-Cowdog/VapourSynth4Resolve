// Synthetic transaction regressions. No archive decoder, process or model runs.
// Host fs is never patched. The evaluated modules receive only this private
// fixture port; callback shapes use bounded sync fixture IO + fake microtasks.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');

const SOURCE_LIMIT = 256 * 1024;
function source(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = fs.fstatSync(fd);
    assert.ok(before.isFile() && before.size <= SOURCE_LIMIT, 'selected source must be a bounded ordinary file');
    const data = Buffer.alloc(before.size);
    let used = 0;
    while (used < data.length) {
      const count = fs.readSync(fd, data, used, data.length - used, used);
      assert.ok(count > 0, 'selected source shortened'); used += count;
    }
    assert.equal(fs.readSync(fd, Buffer.alloc(1), 0, 1, used), 0);
    const after = fs.fstatSync(fd);
    for (const key of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs']) assert.equal(after[key], before[key]);
    return data.toString('utf8');
  } finally { fs.closeSync(fd); }
}
const TRANSACTION_SOURCE = source(process.env.VSRES_MODEL_STAGE_TRANSACTION_SOURCE || path.join(__dirname, 'model-stage-transaction.js'));
const IO_SOURCE = source(process.env.VSRES_MODEL_STAGE_IO_SOURCE || path.join(__dirname, 'model-stage-io.js'));
const PARENT = path.resolve(process.env.VSRES_MODEL_STAGE_TEST_ROOT || process.env.TMPDIR || '');
assert.ok(process.env.VSRES_MODEL_STAGE_TEST_ROOT || process.env.TMPDIR, 'explicit private fixture parent required');
const parentInfo = fs.lstatSync(PARENT);
assert.ok(parentInfo.isDirectory() && !parentInfo.isSymbolicLink() && parentInfo.uid === process.getuid() &&
  (parentInfo.mode & 0o077) === 0 && fs.realpathSync(PARENT) === PARENT, 'fixture parent must be canonical/private/owned');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const injected = name => Object.assign(new Error('injected fixture ' + name), { code: 'EIO' });
const inside = (file, root) => file === root || file.startsWith(root + path.sep);
const describe = (name, fn) => test(name, { concurrency: false, timeout: 5000 }, fn);
const EFFECT = { fixtures: 0, calls: 0, ioBytes: 0, snapshotBytes: 0 };
function byteRequest(length) {
  assert.ok(Number.isSafeInteger(length) && length >= 0 && EFFECT.ioBytes + length <= 16 * 1024 * 1024, 'fixture IO byte effect bound');
}

function fixture(options = {}) {
  assert.ok(++EFFECT.fixtures <= 64, 'fixture allocation count bound');
  const base = fs.mkdtempSync(path.join(PARENT, 'vs-stage-transaction-'));
  fs.chmodSync(base, 0o700);
  const owner = fs.lstatSync(base);
  const root = path.join(base, 'models'); fs.mkdirSync(root, { mode: 0o700 });
  const id = 'fixture-model'; const live = path.join(root, id); fs.mkdirSync(live, { mode: 0o700 });
  const archiveBytes = Buffer.from('inert bytes; never a decoded archive\n');
  fs.writeFileSync(path.join(live, 'download.7z'), archiveBytes, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(path.join(live, 'weights.bin'), options.primary || Buffer.from('old primary\n'), { flag: 'wx', mode: 0o600 });
  fs.mkdirSync(path.join(live, 'manual'), { mode: 0o700 });
  fs.writeFileSync(path.join(live, 'manual', 'keep.bin'), 'manual extra\n', { flag: 'wx', mode: 0o600 });
  const h = { base, root, id, live, archiveBytes, calls: [], mutations: [], descriptors: new Map(), directories: new Set(), held: [],
    token: 0, fault: null, afterRename: null, beforeLstat: null, holdClose: null, failWrite: null,
    failClose: null, failDirectoryClose: null, tx: null, anchorReleased: false, disposed: false,
    available: 32n * 1024n * 1024n,
    state: { current: true, childClosed: true, stopped: false, unknown: false, failures: [], closures: 0 } };
  function confined(file) {
    assert.equal(typeof file, 'string'); const resolved = path.resolve(file);
    assert.ok(inside(resolved, base), 'VM attempted path outside its fixture');
    return resolved;
  }
  function call(name, detail, mutation = false) {
    assert.ok(!h.disposed, 'fixture port disposed');
    assert.ok(h.calls.length < 10000, 'fixture syscall effect bound');
    assert.ok(++EFFECT.calls <= 100000, 'whole-module fixture syscall effect bound');
    const value = { name, ...detail }; h.calls.push(value);
    if (mutation) h.mutations.push(value);
    return value;
  }
  function owned(fd) { assert.ok(h.descriptors.has(fd), 'VM attempted an unowned fd'); return h.descriptors.get(fd); }
  function deliver(callback, error, values, closePath) {
    const item = { done: false, deliver() { assert.ok(!item.done); item.done = true; callback(error || null, ...values); } };
    if (closePath && h.holdClose?.(closePath)) { h.held.push(item); return; }
    queueMicrotask(() => item.deliver());
  }
  function callbackOperation(name, args, callback) {
    let values = [], error, closePath;
    try {
      if (name === 'lstat') { const file = confined(args[0]); call(name, { path: file }); h.beforeLstat?.(file); values = [fs.lstatSync(file)]; }
      else if (name === 'open') {
        const file = confined(args[0]); const flags = args[1]; call(name, { path: file, flags }, !!(flags & fs.constants.O_CREAT));
        const fd = fs.openSync(file, flags, args[2]); h.descriptors.set(fd, file); values = [fd];
      } else if (name === 'fstat') { const file = owned(args[0]); call(name, { path: file }); values = [fs.fstatSync(args[0])]; }
      else if (name === 'fchmod') { const file = owned(args[0]); call(name, { path: file }, true); fs.fchmodSync(...args); }
      else if (name === 'read') { const file = owned(args[0]); call(name, { path: file, length: args[3] }); byteRequest(args[3]); const count = fs.readSync(...args); EFFECT.ioBytes += count; values = [count, args[1]]; }
      else if (name === 'write') {
        const file = owned(args[0]); call(name, { path: file, length: args[3] }, true);
        const failure = h.failWrite?.(file); if (failure) throw failure;
        byteRequest(args[3]); const count = fs.writeSync(...args); EFFECT.ioBytes += count; values = [count, args[1]];
      } else if (name === 'close') {
        const file = owned(args[0]); call(name, { path: file }); closePath = file;
        // Even an injected unknown/error callback has no real leaked fd: the
        // module sees only the deliberately withheld/failed closure receipt.
        fs.closeSync(args[0]); h.descriptors.delete(args[0]);
        const failure = h.failClose?.(file); if (failure) throw failure;
      } else throw new Error('unsupported fixture callback method: ' + name);
    } catch (caught) { error = caught; }
    deliver(callback, error, values, closePath);
  }
  const methods = {
    constants: fs.constants,
    lstatSync(file) { file = confined(file); call('lstatSync', { path: file }); h.beforeLstat?.(file); return fs.lstatSync(file); },
    mkdirSync(file, opts) { file = confined(file); call('mkdirSync', { path: file }, true); return fs.mkdirSync(file, opts); },
    renameSync(from, to) {
      from = confined(from); to = confined(to); const event = call('renameSync', { from, to }, true);
      const failure = h.fault?.(from, to, event); if (failure) throw failure;
      fs.renameSync(from, to);
      if (h.tx && from === h.tx.names.anchor && to === h.tx.history) h.anchorReleased = true;
      h.afterRename?.(from, to, event);
    },
    statfsSync(file, opts) { file = confined(file); call('statfsSync', { path: file }); assert.equal(opts.bigint, true); return { bavail: h.available, bsize: 1n }; },
    opendirSync(file, opts) {
      file = confined(file); call('opendirSync', { path: file }); const actual = fs.opendirSync(file, opts);
      const wrapper = { readSync() { call('Dir.readSync', { path: file }); return actual.readSync(); }, closeSync() {
        call('Dir.closeSync', { path: file }); actual.closeSync(); h.directories.delete(wrapper);
        const failure = h.failDirectoryClose?.(file); if (failure) throw failure;
      } };
      h.directories.add(wrapper); return wrapper;
    },
    openSync(file, flags, mode) { file = confined(file); call('openSync', { path: file, flags }); const fd = fs.openSync(file, flags, mode); h.descriptors.set(fd, file); return fd; },
    fstatSync(fd) { call('fstatSync', { path: owned(fd) }); return fs.fstatSync(fd); },
    readSync(fd, ...rest) { call('readSync', { path: owned(fd) }); byteRequest(rest[2]); const count = fs.readSync(fd, ...rest); EFFECT.ioBytes += count; return count; },
    closeSync(fd) { call('closeSync', { path: owned(fd) }); fs.closeSync(fd); h.descriptors.delete(fd); },
  };
  for (const name of ['lstat', 'open', 'fstat', 'fchmod', 'read', 'write', 'close']) methods[name] = (...args) => {
    const callback = args.pop(); assert.equal(typeof callback, 'function'); callbackOperation(name, args, callback);
  };
  h.fs = new Proxy(methods, { get(target, key) {
    if (Object.hasOwn(target, key)) return target[key];
    throw new Error('unadmitted VM fs member: ' + String(key));
  } });
  h.load = () => {
    const cryptoPort = Object.freeze({ createHash: crypto.createHash.bind(crypto), randomBytes(length) {
      assert.ok(Number.isInteger(length) && length > 0 && length <= 32);
      return crypto.createHash('sha256').update('fixture-token-' + (++h.token)).digest().subarray(0, length);
    } });
    function evaluate(text, filename, ports) {
      const module = { exports: {} };
      const requirePort = name => { assert.ok(Object.hasOwn(ports, name), 'unadmitted require: ' + name); return ports[name]; };
      const context = { require: requirePort, module, exports: module.exports, Buffer,
        process: Object.freeze({ env: Object.freeze({}), getuid: () => process.getuid() }),
        Date: Object.freeze({ now: () => 1700000000000 }) };
      vm.runInNewContext(text, context, { filename, timeout: 1000 }); return module.exports;
    }
    const io = evaluate(IO_SOURCE, 'selected-model-stage-io.js', {});
    return evaluate(TRANSACTION_SOURCE, 'selected-model-stage-transaction.js', { fs: h.fs, path, crypto: cryptoPort, './model-stage-io': io });
  };
  h.hooks = state => ({ current: () => state.current, knownClosed: () => state.childClosed,
    isStopped: () => state.stopped, returnedUnknown: () => state.unknown,
    checkDeadline() { /* manager deadline port is controlled separately; no native work here */ },
    onFailure(error) { state.failures.push(error.message); state.stopped = true; }, onClosure() { state.closures++; } });
  h.api = h.load();
  h.entry = { id, version: 'fixture-v1', sha256: sha(archiveBytes), diskBytesNeeded: 1024 * 1024, ...options.entry };
  h.construct = (extra = {}, api = h.api, state = h.state) => new api.ModelStageTransaction({ root, id, entry: h.entry,
    originalIdentity: fs.lstatSync(live), archiveIdentity: fs.lstatSync(path.join(live, 'download.7z')),
    hooks: h.hooks(state), stageHeadroomBytes: 0, ...extra });
  h.tx = h.construct(options.transaction);
  h.flush = async () => { for (let count = 0; count < 32; count++) await Promise.resolve(); };
  h.untilHeld = async () => { for (let count = 0; count < 1000 && !h.held.length; count++) await Promise.resolve(); assert.ok(h.held.length, 'selected fake callback was not reached'); };
  h.releaseAll = () => { for (const item of h.held.splice(0)) queueMicrotask(() => item.deliver()); };
  h.prepare = async () => { await h.tx.claim(); await h.tx.prepare(); };
  h.ready = async () => {
    await h.prepare(); await h.tx.beforeWriter(); h.state.childClosed = false;
    fs.writeFileSync(path.join(h.tx.stage, 'weights.bin'), 'new primary\n');
    fs.writeFileSync(path.join(h.tx.stage, 'added.bin'), 'new output\n', { flag: 'wx', mode: 0o600 });
    h.state.childClosed = true; await h.tx.writerClosed(); await h.tx.validateCandidate();
  };
  h.snapshot = file => {
    const result = {}; let entries = 0, bytes = 0;
    function visit(current, relative, depth) {
      assert.ok(depth <= 8 && ++entries <= 128, 'synthetic snapshot traversal bound');
      const info = fs.lstatSync(current);
      const record = { dev: info.dev, ino: info.ino, mode: info.mode, nlink: info.nlink };
      if (info.isSymbolicLink()) record.target = fs.readlinkSync(current);
      else if (info.isDirectory()) { record.directory = true; }
      else { assert.ok(info.isFile()); bytes += info.size; assert.ok(bytes <= 1024 * 1024); assert.ok(EFFECT.snapshotBytes + info.size <= 16 * 1024 * 1024, 'whole-module snapshot byte bound'); EFFECT.snapshotBytes += info.size; record.hex = fs.readFileSync(current).toString('hex'); record.mtimeMs = info.mtimeMs; }
      result[relative] = record;
      if (info.isDirectory()) for (const name of fs.readdirSync(current).sort()) visit(path.join(current, name), path.join(relative, name), depth + 1);
    }
    visit(confined(file), '', 0); return result;
  };
  h.dispose = async () => {
    h.state.current = false; h.state.unknown = true; h.releaseAll(); await h.flush();
    assert.equal(h.descriptors.size, 0, 'fixture must physically close every acquired descriptor');
    assert.equal(h.directories.size, 0, 'fixture must physically close every acquired directory');
    const now = fs.lstatSync(base); assert.equal(now.dev, owner.dev); assert.equal(now.ino, owner.ino);
    assert.ok(now.isDirectory() && !now.isSymbolicLink() && fs.realpathSync(base) === base);
    h.disposed = true; fs.rmSync(base, { recursive: true, force: false });
  };
  return h;
}
async function withFixture(options, work) {
  if (typeof options === 'function') { work = options; options = {}; }
  const h = fixture(options);
  try { await work(h); } finally { await h.dispose(); }
}
function failPhase(h, phase) {
  let used = false;
  h.fault = (from, to) => {
    if (!used && to === h.tx.names.anchor && path.basename(from).startsWith('.journal-') &&
        JSON.parse(fs.readFileSync(from, 'utf8')).phase === phase) { used = true; return injected('phase-' + phase); }
  };
}
async function heldMutation(h, action) {
  const before = h.snapshot(h.base), writes = h.mutations.length;
  await assert.rejects(action, /lease|closed|closure|unknown|changed|replaced|ownership|unavailable|retained|occupied/i);
  assert.equal(h.mutations.length, writes, 'refused mutation must not dispatch filesystem writes');
  assert.deepEqual(h.snapshot(h.base), before);
}

describe('independent archive and payload copies publish without losing old extras or custody', async () => withFixture(async h => {
  const old = h.snapshot(h.live), oldArchive = fs.lstatSync(path.join(h.live, 'download.7z'));
  await h.prepare();
  assert.notEqual(fs.lstatSync(h.tx.archive).ino, oldArchive.ino);
  assert.deepEqual(fs.readFileSync(h.tx.archive), h.archiveBytes);
  assert.equal(fs.lstatSync(path.join(h.live, 'download.7z')).nlink, 1);
  for (const relative of ['weights.bin', 'manual/keep.bin']) {
    assert.notEqual(fs.lstatSync(path.join(h.tx.stage, relative)).ino, fs.lstatSync(path.join(h.live, relative)).ino);
    assert.deepEqual(fs.readFileSync(path.join(h.tx.stage, relative)), fs.readFileSync(path.join(h.live, relative)));
  }
  assert.deepEqual(h.snapshot(h.live), old);
  await h.tx.beforeWriter(); fs.writeFileSync(path.join(h.tx.stage, 'weights.bin'), 'replacement\n');
  await h.tx.writerClosed(); await h.tx.validateCandidate(); const answer = await h.tx.publish();
  assert.equal(answer.ok, true); assert.equal(answer.closureKnown, true); assert.equal(answer.retainedStorage.bytes, null);
  assert.equal(answer.retainedStorage.path, h.tx.names.custody); assert.equal(h.tx.released, true);
  assert.deepEqual(h.snapshot(h.tx.previous), old);
  assert.deepEqual(fs.readFileSync(path.join(h.live, 'download.7z')), h.archiveBytes);
  assert.equal(fs.readFileSync(path.join(h.live, 'manual/keep.bin'), 'utf8'), 'manual extra\n');
  assert.equal(fs.readFileSync(path.join(h.live, 'weights.bin'), 'utf8'), 'replacement\n');
  assert.equal(h.api.pending(h.root, h.id).present, false);
  const afterReload = h.load().retainedStorage(h.root, h.id);
  assert.equal(afterReload.status, 'retained'); assert.equal(afterReload.bytes, null);
}));

describe('known-closed phase failures restore only under the original process lease', async () => {
  for (const phase of ['backup-intent', 'previous-moved', 'install-intent', 'installed', 'committed']) await withFixture(async h => {
    const old = h.snapshot(h.live); await h.ready(); failPhase(h, phase);
    await assert.rejects(h.tx.publish(), /injected fixture phase-/);
    const persisted = h.snapshot(h.base), writes = h.mutations.length;
    const fresh = h.load().inspect(h.root, h.id, h.entry);
    assert.equal(fresh.pending, true); assert.equal(fresh.canRestore, false);
    assert.equal(h.mutations.length, writes); assert.deepEqual(h.snapshot(h.base), persisted);
    h.state.stopped = true; const restored = await h.tx.restore();
    assert.equal(restored.restoredPrevious, true); assert.equal(h.tx.released, true);
    assert.deepEqual(h.snapshot(h.live), old); assert.equal(h.api.pending(h.root, h.id).present, false);
    await heldMutation(h, () => h.tx.restore());
  });
});

describe('failures before and after each namespace rename preserve a guarded restoration path', async () => {
  for (const move of ['old-to-previous', 'candidate-to-live']) for (const after of [false, true]) await withFixture(async h => {
    const old = h.snapshot(h.live); await h.ready(); let used = false;
    const selected = (from, to) => move === 'old-to-previous' ? from === h.live && to === h.tx.previous : from === h.tx.stage && to === h.live;
    if (after) h.afterRename = (from, to) => { if (!used && selected(from, to)) { used = true; throw injected('after-' + move); } };
    else h.fault = (from, to) => { if (!used && selected(from, to)) { used = true; return injected('before-' + move); } };
    await assert.rejects(h.tx.publish(), /injected fixture/); assert.equal(used, true);
    const answer = await h.tx.restore(); assert.equal(answer.restoredPrevious, true);
    assert.deepEqual(h.snapshot(h.live), old); assert.equal(h.tx.released, true);
  });
  for (const replaceReservation of [false, true]) await withFixture(async h => {
    const old = h.snapshot(h.live); await h.ready(); let used = false;
    h.fault = (from, to) => {
      if (!used && from === h.tx.names.anchor && to === h.tx.history) { used = true; return injected('before-anchor-release'); }
    };
    await assert.rejects(h.tx.publish(), /before-anchor-release/);
    assert.equal(used, true); assert.equal(h.tx.released, false); assert.equal(h.tx.releaseUncertain, false);
    assert.equal(fs.statSync(h.tx.history).size, 0); assert.equal(h.api.pending(h.root, h.id).present, true);
    if (replaceReservation) {
      fs.renameSync(h.tx.history, path.join(h.base, 'retained-owned-empty-history'));
      // Same filename and empty contents are insufficient: a different inode
      // must remain foreign and must not be reused or removed.
      fs.writeFileSync(h.tx.history, Buffer.alloc(0), { flag: 'wx', mode: 0o600 });
      await heldMutation(h, () => h.tx.restore());
      assert.equal(h.tx.released, false); assert.equal(h.api.pending(h.root, h.id).present, true);
    } else {
      const result = await h.tx.restore(); assert.equal(result.restoredPrevious, true);
      assert.deepEqual(h.snapshot(h.live), old); assert.equal(h.tx.released, true);
      assert.equal(h.api.pending(h.root, h.id).present, false);
      assert.equal(h.calls.filter(call => call.name === 'open' && call.path === h.tx.history &&
        (call.flags & fs.constants.O_CREAT)).length, 1, 'reuse only the existing owned empty reservation');
    }
  });
});

describe('foreign live previous candidate history archive and custody slots remain untouched', async () => {
  for (const slot of ['live', 'previous', 'stage', 'history', 'archive', 'archive-in-place', 'custody']) await withFixture(async h => {
    await h.ready();
    const target = { live: h.live, previous: h.tx.previous, stage: h.tx.stage, history: h.tx.history,
      archive: path.join(h.tx.stage, 'download.7z'), 'archive-in-place': path.join(h.tx.stage, 'download.7z'), custody: h.tx.names.custody }[slot];
    if (slot === 'archive-in-place') fs.writeFileSync(target, 'in-place foreign archive update');
    else if (fs.existsSync(target)) fs.renameSync(target, path.join(h.base, 'retained-' + slot));
    if (slot === 'archive-in-place') { /* Same inode changed; stable metadata must still be checked. */ }
    else if (slot === 'archive' || slot === 'history') fs.writeFileSync(target, 'foreign fixture leaf', { flag: 'wx', mode: 0o600 });
    else fs.mkdirSync(target, { mode: 0o700 });
    await heldMutation(h, () => h.tx.publish());
    await heldMutation(h, () => h.tx.restore());
  });
});

describe('replaced or linked journals deny the current lease and remain inspection-only', async () => {
  for (const form of ['replacement', 'symlink', 'oversize']) await withFixture(async h => {
    await h.prepare(); const anchor = h.tx.names.anchor;
    fs.renameSync(anchor, path.join(h.base, 'saved-anchor.json'));
    if (form === 'symlink') fs.symlinkSync(path.join(h.base, 'saved-anchor.json'), anchor);
    else fs.writeFileSync(anchor, form === 'oversize' ? Buffer.alloc(64 * 1024 + 1, 32) : '{"foreign":true}', { flag: 'wx', mode: 0o600 });
    await heldMutation(h, () => h.tx.beforeWriter());
    const before = h.snapshot(h.base), writes = h.mutations.length;
    const observed = h.load().inspect(h.root, h.id, h.entry);
    assert.equal(observed.pending, true); assert.equal(observed.canRestore, false); assert.equal(observed.ok, false);
    assert.equal(h.mutations.length, writes); assert.deepEqual(h.snapshot(h.base), before);
  });
});

describe('physical anchor release is irreversible even if its final receipt fails', async () => withFixture(async h => {
  const old = h.snapshot(h.live); await h.ready();
  let failed = false;
  h.beforeLstat = file => { if (h.anchorReleased && file === h.tx.history && !failed) { failed = true; throw injected('post-release-receipt'); } };
  await assert.rejects(h.tx.publish(), /anchor released|receipt|restoration/i);
  assert.equal(failed, true); assert.equal(h.tx.released, true); assert.equal(h.api.pending(h.root, h.id).present, false);
  const current = h.snapshot(h.live); assert.notEqual(current[''].ino, old[''].ino);
  assert.deepEqual(h.snapshot(h.tx.previous), old);
  await heldMutation(h, () => h.tx.restore()); assert.deepEqual(h.snapshot(h.live), current);
}));

describe('unknown child closure and a latched unknown result forbid publication or restoration', async () => {
  for (const unknown of [false, true]) await withFixture(async h => {
    await h.prepare(); await h.tx.beforeWriter(); h.state.childClosed = false;
    if (unknown) { h.state.childClosed = true; h.state.unknown = true; }
    await heldMutation(h, () => h.tx.writerClosed()); await heldMutation(h, () => h.tx.publish());
    await heldMutation(h, () => h.tx.restore()); await heldMutation(h, () => h.tx.retireFailure());
    assert.equal(h.tx.inspection().canRestore, unknown, 'passive prospective query differs from current action admission');
    const writes = h.mutations.length; await h.flush(); assert.equal(h.mutations.length, writes);
  });
});

describe('withheld copy-close receipt keeps transaction IO unknown without native work', async () => withFixture(async h => {
  await h.tx.claim(); let held = false;
  h.holdClose = file => file === h.tx.archive && !held && (held = true);
  const preparing = h.tx.prepare(); preparing.catch(() => {}); await h.untilHeld();
  assert.equal(h.tx.resourcesClosed(), false); assert.equal(h.descriptors.size, 0);
  assert.equal(h.tx.inspection().canRestore, false);
  await heldMutation(h, () => h.tx.publish()); await heldMutation(h, () => h.tx.restore());
  h.state.unknown = true; h.releaseAll(); await assert.rejects(preparing, /stopped|lease|unknown/i);
  await h.flush(); assert.equal(h.tx.resourcesClosed(), true);
  await heldMutation(h, () => h.tx.restore());
}));

describe('failed close receipt is retained as unknown and never retried by fd', async () => withFixture(async h => {
  await h.tx.claim(); let failed = false;
  h.failClose = file => file === h.tx.archive && !failed && (failed = true) ? injected('close-receipt') : null;
  await assert.rejects(h.tx.prepare(), /close-receipt/); assert.equal(h.tx.resourcesClosed(), false);
  assert.equal(h.tx.inspection().canRestore, false);
  const closes = h.calls.filter(call => call.name === 'close' && call.path === h.tx.archive).length;
  await heldMutation(h, () => h.tx.restore()); await heldMutation(h, () => h.tx.retireFailure());
  assert.equal(h.calls.filter(call => call.name === 'close' && call.path === h.tx.archive).length, closes);
  assert.equal(closes, 1); assert.equal(h.descriptors.size, 0);
}));

describe('unknown directory close blocks the same transaction namespace', async () => withFixture(async h => {
  await h.tx.claim(); let failed = false;
  h.failDirectoryClose = file => file === h.live && !failed && (failed = true) ? injected('directory-close') : null;
  await assert.rejects(h.tx.prepare(), /directory-close/); assert.equal(h.tx.resourcesClosed(), false);
  assert.equal(h.tx.inspection().canRestore, false);
  await heldMutation(h, () => h.tx.publish()); await heldMutation(h, () => h.tx.restore());
  assert.equal(h.directories.size, 0);
}));

describe('synthetic interrupted namespace snapshots grant fresh modules no recovery writes', async () => {
  for (const checkpoint of ['extracting', 'previous-moved', 'installed']) await withFixture(async h => {
    if (checkpoint === 'extracting') { await h.prepare(); await h.tx.beforeWriter(); h.state.childClosed = false; }
    else { await h.ready(); failPhase(h, checkpoint); await assert.rejects(h.tx.publish(), /injected fixture/); }
    const before = h.snapshot(h.base), writes = h.mutations.length;
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = h.load().inspect(h.root, h.id, h.entry);
      assert.equal(result.pending, true); assert.equal(result.canRestore, false); assert.match(result.recovery, /inspection|original process|lease|held/i);
    }
    assert.equal(h.mutations.length, writes); assert.deepEqual(h.snapshot(h.base), before);
  });
});

describe('a second current-process claim cannot replace the fixed active journal', async () => withFixture(async h => {
  await h.prepare(); const old = h.snapshot(h.base);
  const state = { current: true, childClosed: true, stopped: false, unknown: false, failures: [], closures: 0 };
  const second = h.construct({}, h.load(), state);
  await assert.rejects(second.claim(), /exist|EEXIST/i);
  assert.deepEqual(h.snapshot(h.base), old); assert.equal(h.api.pending(h.root, h.id).present, true);
}));

describe('known-closed copy failure retires only an unchanged original tree', async () => {
  for (const changeOld of [false, true]) await withFixture(async h => {
    const old = h.snapshot(h.live); await h.tx.claim(); let failed = false;
    h.failWrite = file => {
      if (file !== path.join(h.tx.stage, 'weights.bin') || failed) return null;
      failed = true;
      if (changeOld) { fs.writeFileSync(path.join(h.live, 'weights.bin'), 'changed old\n'); return null; }
      return injected('seed-copy');
    };
    await assert.rejects(h.tx.prepare(), /seed-copy|changed/i); assert.equal(h.tx.allClosed(), true);
    if (changeOld) {
      await heldMutation(h, () => h.tx.retireFailure());
      assert.equal(h.api.pending(h.root, h.id).present, true); assert.equal(h.tx.released, false);
      assert.equal(fs.readFileSync(path.join(h.live, 'weights.bin'), 'utf8'), 'changed old\n');
    } else {
      assert.deepEqual(h.snapshot(h.live), old); const answer = await h.tx.retireFailure();
      assert.equal(h.tx.released, true); assert.equal(answer.retainedStorage.bytes, null);
      assert.ok(fs.existsSync(h.tx.transaction)); assert.deepEqual(h.snapshot(h.live), old);
    }
  });
});

describe('archive checksum mismatch preserves the original bytes and independent failed copy', async () => withFixture({ entry: { sha256: '0'.repeat(64) } }, async h => {
  const old = h.snapshot(h.live); await h.tx.claim();
  await assert.rejects(h.tx.prepare(), /checksum/); assert.deepEqual(h.snapshot(h.live), old);
  assert.deepEqual(fs.readFileSync(h.tx.archive), h.archiveBytes);
  assert.notEqual(fs.lstatSync(h.tx.archive).ino, fs.lstatSync(path.join(h.live, 'download.7z')).ino);
  await h.tx.retireFailure(); assert.deepEqual(h.snapshot(h.live), old);
}));

describe('ambiguous reserved source names are retained rather than silently omitted', async () => {
  for (const name of ['.completion-foreign', '.extracted-000000000000000000000000.tmp']) await withFixture(async h => {
    fs.writeFileSync(path.join(h.live, name), 'unrecognized fixture bytes', { flag: 'wx', mode: 0o600 });
    h.tx = h.construct(); const old = h.snapshot(h.live); await h.tx.claim();
    await assert.rejects(h.tx.prepare()); assert.deepEqual(h.snapshot(h.live), old);
    assert.ok(!fs.existsSync(h.tx.archive));
  });
});

describe('source symlinks and hardlinks are refused before seeding', async () => {
  for (const alias of ['symlink', 'hardlink']) await withFixture(async h => {
    const target = path.join(h.live, 'weights.bin'), destination = path.join(h.live, 'alias.bin');
    if (alias === 'symlink') fs.symlinkSync('weights.bin', destination); else fs.linkSync(target, destination);
    h.tx = h.construct(); const old = h.snapshot(h.live); await h.tx.claim();
    await assert.rejects(h.tx.prepare(), /linked|unsupported/i); assert.deepEqual(h.snapshot(h.live), old);
  });
});

describe('candidate faults and changed old data after a failed writer stay held before moves', async () => {
  for (const form of ['symlink', 'hardlink', 'reserved', 'failed-writer-old-change']) await withFixture(async h => {
    const old = h.snapshot(h.live); await h.prepare(); await h.tx.beforeWriter();
    if (form === 'symlink') fs.symlinkSync('weights.bin', path.join(h.tx.stage, 'alias.bin'));
    else if (form === 'hardlink') fs.linkSync(path.join(h.tx.stage, 'weights.bin'), path.join(h.tx.stage, 'alias.bin'));
    else if (form === 'reserved') fs.writeFileSync(path.join(h.tx.stage, 'download.7z'), 'native control collision', { flag: 'wx', mode: 0o600 });
    else {
      fs.writeFileSync(path.join(h.tx.stage, 'weights.bin'), 'partial failed writer output');
      fs.writeFileSync(path.join(h.live, 'weights.bin'), 'external update while fake writer ran');
    }
    await h.tx.writerClosed();
    if (form === 'failed-writer-old-change') {
      h.state.stopped = true; await heldMutation(h, () => h.tx.retireFailure());
      assert.equal(h.api.pending(h.root, h.id).present, true); assert.equal(h.tx.released, false);
      assert.equal(fs.readFileSync(path.join(h.live, 'weights.bin'), 'utf8'), 'external update while fake writer ran');
    } else {
      await assert.rejects(h.tx.validateCandidate(), /linked|unsupported|collides/i);
      assert.deepEqual(h.snapshot(h.live), old);
    }
    assert.ok(!fs.existsSync(h.tx.previous));
  });
});

describe('space forecast includes independent archive seed registry metadata and selected headroom', async () => {
  for (const delta of [-1n, 0n]) await withFixture(async h => {
    const seeded = fs.statSync(path.join(h.live, 'weights.bin')).size + fs.statSync(path.join(h.live, 'manual/keep.bin')).size;
    const headroom = 17; h.tx = h.construct({ stageHeadroomBytes: headroom }); await h.tx.claim();
    const planned = BigInt(h.archiveBytes.length + seeded + h.entry.diskBytesNeeded + h.api.METADATA_ALLOWANCE);
    h.available = planned + BigInt(headroom) + delta; const old = h.snapshot(h.live);
    if (delta < 0n) { await assert.rejects(h.tx.prepare(), /headroom|available/i); assert.ok(!fs.existsSync(h.tx.archive)); }
    else { await h.tx.prepare(); assert.equal(h.tx.space.plannedAdditionalBytes, planned.toString()); }
    assert.equal(h.tx.space.availableBytesObserved, h.available.toString()); assert.equal(h.tx.space.headroomBytes, headroom);
    assert.deepEqual(h.snapshot(h.live), old);
  });
});

describe('headroom defaults and explicit overrides validate without clamping', async () => withFixture(async h => {
  assert.equal(h.api.headroomPolicy(), 1024 * 1024 * 1024);
  assert.equal(h.api.headroomPolicy(0), 0); assert.equal(h.api.headroomPolicy(7, { VSRES_MODEL_STAGE_HEADROOM_BYTES: 'bad' }), 7);
  assert.equal(h.api.headroomPolicy(undefined, { VSRES_MODEL_STAGE_HEADROOM_BYTES: '0' }), 0);
  assert.equal(h.api.headroomPolicy(undefined, { VSRES_MODEL_STAGE_HEADROOM_BYTES: '17' }), 17);
  for (const value of [null, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '0']) assert.throws(() => h.api.headroomPolicy(value), /safe integer|headroom/i);
  for (const value of ['', '-1', '1.5', 'Infinity', '9007199254740992']) assert.throws(() => h.api.headroomPolicy(undefined, { VSRES_MODEL_STAGE_HEADROOM_BYTES: value }), /safe integer|headroom/i);
  assert.deepEqual({ ...h.tx.limits }, { maxEntries: 100000, maxDepth: 128, maxManifestBytes: 64 * 1024 * 1024 });
  for (const key of ['maxEntries', 'maxDepth', 'maxManifestBytes']) for (const value of [0, null, -1, 0.5]) assert.throws(() => h.construct({ [key]: value }), /positive|safe integer/i);
}));

describe('entry limit refuses a small synthetic tree and an explicit larger budget admits it', async () => {
  for (const limit of [2, 32]) await withFixture({ transaction: { maxEntries: limit } }, async h => {
    const old = h.snapshot(h.live); await h.tx.claim();
    if (limit === 2) await assert.rejects(h.tx.prepare(), /entries|stageMaxEntries/i); else await h.tx.prepare();
    assert.deepEqual(h.snapshot(h.live), old);
  });
});

describe('depth limit refuses nested fixtures and an explicit larger budget admits them', async () => {
  for (const limit of [1, 4]) await withFixture({ transaction: { maxDepth: limit } }, async h => {
    const old = h.snapshot(h.live); await h.tx.claim();
    if (limit === 1) await assert.rejects(h.tx.prepare(), /depth|stageMaxDepth/i); else await h.tx.prepare();
    assert.deepEqual(h.snapshot(h.live), old);
  });
});

describe('serialized manifest budget is visible and independently overridable', async () => {
  for (const limit of [1, 1024 * 1024]) await withFixture({ transaction: { maxManifestBytes: limit } }, async h => {
    const old = h.snapshot(h.live); await h.tx.claim();
    if (limit === 1) await assert.rejects(h.tx.prepare(), /manifest metadata|stageMaxManifestBytes/i); else await h.tx.prepare();
    assert.deepEqual(h.snapshot(h.live), old);
  });
});

describe('overlay may shrink old payload before the existing final candidate byte cap applies', async () => withFixture({ primary: Buffer.alloc(1024, 7), entry: { diskBytesNeeded: 256 } }, async h => {
  const old = h.snapshot(h.live); await h.prepare(); await h.tx.beforeWriter();
  fs.writeFileSync(path.join(h.tx.stage, 'weights.bin'), 'x');
  await h.tx.writerClosed(); await h.tx.validateCandidate(); await h.tx.publish();
  assert.equal(fs.readFileSync(path.join(h.live, 'weights.bin'), 'utf8'), 'x');
  assert.deepEqual(h.snapshot(h.tx.previous), old);
}));

describe('valid ordinary or linked completion controls stay in previous custody and are reissued', async () => {
  for (const form of ['ordinary', 'symlink', 'hardlink']) await withFixture(async h => {
    const marker = path.join(h.live, 'extracted.json');
    const target = path.join(h.base, 'linked-completion.json');
    const bytes = JSON.stringify({ id: h.id, version: h.entry.version, sha256: h.entry.sha256, extractedAt: 123 });
    if (form === 'ordinary') fs.writeFileSync(marker, bytes, { flag: 'wx', mode: 0o600 });
    else {
      fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
      if (form === 'symlink') fs.symlinkSync(target, marker); else fs.linkSync(target, marker);
    }
    h.tx = h.construct(); const old = h.snapshot(h.live); await h.prepare();
    assert.equal(fs.existsSync(path.join(h.tx.stage, 'extracted.json')), false);
    assert.equal(h.calls.some(call => ['open', 'openSync'].includes(call.name) && call.path === target), false);
    await h.tx.beforeWriter(); await h.tx.writerClosed(); await h.tx.validateCandidate(); await h.tx.publish();
    assert.deepEqual(h.snapshot(h.tx.previous), old);
    const current = fs.lstatSync(path.join(h.live, 'extracted.json'));
    assert.ok(current.isFile() && !current.isSymbolicLink()); assert.equal(current.nlink, 1);
    const completion = JSON.parse(fs.readFileSync(path.join(h.live, 'extracted.json'), 'utf8'));
    assert.equal(completion.id, h.id); assert.equal(completion.sha256, h.entry.sha256);
    assert.notEqual(completion.extractedAt, 123);
  });
});
