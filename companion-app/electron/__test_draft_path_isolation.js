// The exact preview module runs against in-memory fs, runtime selection,
// worker promises and child/timer ports. No helper, media or real child runs.
const test = require('node:test');
const assert = require('node:assert/strict');
const realFs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const source = realFs.readFileSync(path.join(__dirname, 'preview-companion.js'), 'utf8');
const frozenNow = 1700000000000;
const scriptDir = '/fixture/home/Library/Application Support/VapourSynth-OFX';
const A = 'clip = "DRAFT A"\n';
const B = 'clip = "DRAFT B"\n';
const stringLimit = 0x10000000;

function harness(options = {}) {
  const files = new Map(), fds = new Map(), effects = [], requests = [], responses = [], children = [], spawns = [];
  const timers = new Map(); let inode = 10, fd = 100, uuid = 0, random = 0, timer = 0, outputDir = 0;
  const entry = (body, extra = {}) => ({ body, dev: 7, ino: ++inode, uid: 42, nlink: 1,
    mode: 0o600, mtimeMs: 1, ctimeMs: 1, ...extra });
  const fail = message => { const error = Error(message); error.code = message; throw error; };
  const fakeFs = {
    constants: realFs.constants,
    mkdtempSync(prefix) { const dir = prefix + ++outputDir; files.set(dir, entry('', { directory: true, mode: 0o40700 })); return dir; },
    rmdirSync(dir) { assert.equal([...files.keys()].some(file => file.startsWith(dir + '/')), false); files.delete(dir); },
    existsSync(file) { return files.has(file) || (file === '/fixture/python' && options.runtimeExists !== false); },
    realpathSync(file) { return options.symlinks?.[file] || file; },
    mkdirSync(file) { effects.push(['mkdir', file]); if (options.mkdirError) fail('EACCES mkdir'); },
    openSync(file, flags, mode) {
      effects.push(['open', file, flags, mode]);
      if (options.openError) fail('EACCES open');
      if (typeof flags === 'number') {
        if (!files.has(file)) fail('ENOENT');
        if (files.get(file).link && (flags & realFs.constants.O_NOFOLLOW)) fail('ELOOP');
      } else {
        assert.equal(flags, 'wx');
        if (files.has(file)) fail('EEXIST');
        files.set(file, entry(''));
      }
      const handle = ++fd; fds.set(handle, file); return handle;
    },
    fstatSync(handle) { const file = fds.get(handle); assert.ok(file); const value = files.get(file); return {
      ...value, size: Buffer.byteLength(value.body), isFile: () => !value.directory && !value.link }; },
    lstatSync(file) {
      const value = files.get(file); if (!value) fail('ENOENT');
      return { ...value, size: Buffer.byteLength(value.body), isFile: () => !value.link && !value.directory,
        isDirectory: () => value.directory === true };
    },
    closeSync(handle) { effects.push(['close', handle]); assert.ok(fds.delete(handle)); },
    writeFileSync(target, body) {
      const file = typeof target === 'number' ? fds.get(target) : target;
      assert.ok(file); effects.push(['write', file, String(body)]);
      if (!files.has(file)) files.set(file, entry(''));
      files.get(file).body = options.writeError ? 'PARTIAL' : String(body);
      if (options.writeError) fail('ENOSPC write');
    },
    readFileSync(file, encoding) {
      effects.push(['read', file]); const value = files.get(file); if (!value) fail('ENOENT read');
      return encoding ? String(value.body) : Buffer.from(value.body);
    },
    readSync(handle, target, offset, length, position) {
      effects.push(['read', fds.get(handle)]);
      return Buffer.from(files.get(fds.get(handle)).body).copy(target, offset, position, position + length);
    },
    unlinkSync(file) { effects.push(['unlink', file]); if (!files.delete(file)) fail('ENOENT unlink'); },
  };
  const worker = { request(request, lifecycle) {
    requests.push(request);
    if (options.workerThrows) throw Error('Synthetic request failure');
    const child = new EventEmitter(), done = lifecycle?.onDispatch?.(child);
    const complete = response => {
      if (response.closureKnown === true) child.emit('close', 0);
      else if (!response.timeout && !response.outputLimit && !response.protocolError && !response.superseded
          && response.closureUnknown !== true && response.closureKnown !== false) done?.();
    };
    if (options.deferWorker) return new Promise(resolve => responses.push(response => { complete(response); resolve(response); }));
    const response = options.workerResponse || { ok: false, error: 'synthetic script refusal' };
    if (response.ok === true) files.set(request.out, entry('SYNTHETIC PNG'));
    complete(response);
    return Promise.resolve(response);
  } };
  function spawn(bin, args, settings) {
    spawns.push({ bin, args: [...args], settings });
    const child = new EventEmitter(); child.pid = options.failedSpawn ? undefined : 500 + children.length;
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.kill = signal => {
      effects.push(['kill', child.pid, signal]);
      if (options.killThrows) fail('EACCES kill');
      if (options.killInlineClose) child.emit('close', null);
      if (options.killAsyncClose) queueMicrotask(() => child.emit('close', null));
      return true;
    };
    children.push(child);
    if (options.autoChildClose !== false) queueMicrotask(() => {
      child.stdout.emit('data', JSON.stringify({ ok: false, error: 'synthetic fallback refusal' }));
      child.emit('close', 1);
    });
    return child;
  }
  const env = { HOME: '/fixture/home', VSRES_SAMPLE_PYTHON: '/fixture/python',
    VSRES_ALLOWED_SOURCE_ROOTS: '/fixture', ...(options.env || {}) };
  const module = { exports: {} };
  const math = Object.create(Math); math.random = () => ++random / 1000;
  class ClockDate extends Date { static now() { return frozenNow; } }
  vm.runInNewContext(source, {
    module, exports: module.exports, __dirname: '/fixture/app/electron',
    process: { env, pid: 4242, getuid: () => 42, versions: {}, resourcesPath: '/fixture/resources' },
    Date: ClockDate, Math: math,
    setTimeout(callback, delay) { const id = ++timer; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    require(name) {
      if (name === 'fs') return fakeFs;
      if (name === 'path') return path;
      if (name === 'os') return { tmpdir: () => '/fixture/tmp', homedir: () => '/fixture/home' };
      if (name === 'buffer') return { Buffer, constants: { MAX_STRING_LENGTH: stringLimit, MAX_LENGTH: stringLimit } };
      if (name === 'crypto') return { randomUUID() { uuid++; return options.uuidFixed || `uuid-${uuid}`; } };
      if (name === 'child_process') return { spawn };
      if (name === './preview-worker') return { getWorker: () => worker, disposeAllWorkers() {} };
      if (name === './probe-process') return {
        hasPendingProbeStop(kind) { assert.equal(kind, 'selfcheck'); return false; },
        runProbeProcess() { throw Error('Selfcheck dispatch is not admitted in this trusted fixture'); },
      };
      if (name === './prod-paths') return { helperScript: () => options.helperMissing ? null : '/fixture/render.py' };
      if (name === '../package.json') return { version: 'fixture' };
      throw Error('Unexpected real module: ' + name);
    },
  }, { timeout: 1000, filename: 'preview-companion.js' });
  return { files, fds, effects, requests, children, spawns, timers, cache: module.exports._forTest.capabilityCache,
    render: (draftScript, extra = {}) => module.exports.renderPreviewFrame({ draftScript, ...extra }),
    async flush() { for (let i = 0; i < 6; i++) await Promise.resolve(); },
    respond(index, response = { ok: false, error: 'synthetic refusal' }) {
      if (response.ok === true) files.set(requests[index].out, entry('SYNTHETIC PNG'));
      responses[index](response);
    },
    seed(file, body, extra) { files.set(file, entry(body, extra)); },
    drafts() { return [...files.keys()].filter(file => file.startsWith(scriptDir + '/draft-')); },
    uuidCount: () => uuid,
    fire(delay) { for (const [id, t] of [...timers]) if (t.delay === delay) { timers.delete(id); t.callback(); } },
  };
}

test('same-clock concurrent drafts retain distinct script bytes and independent cleanup', async () => {
  const h = harness({ deferWorker: true }); const first = h.render(A), second = h.render(B);
  await h.flush();
  try {
    assert.equal(h.requests.length, 2);
    assert.deepEqual(h.requests.map(r => r.script), [A, B]);
    const paths = h.drafts(); assert.equal(paths.length, 2); assert.notEqual(paths[0], paths[1]);
    assert.equal(h.fds.size, 0);
    h.respond(0); await first;
    assert.equal(h.drafts().length, 1); assert.equal(h.files.get(h.drafts()[0]).body, B);
    h.respond(1); await second; assert.deepEqual(h.drafts(), []);
  } finally {
    for (let i = 0; i < h.requests.length; i++) h.respond(i);
    await Promise.allSettled([first, second]);
  }
});
test('fixture-path refusal precedes mkdir, UUID, file allocation and runtime work', async () => {
  const h = harness(); const result = await h.render("clip = open('/outside/private.mov')");
  assert.equal(result.ok, false); assert.match(result.error, /outside the allowed fixture roots/);
  assert.deepEqual(h.effects, []); assert.equal(h.uuidCount(), 0); assert.equal(h.requests.length, 0); assert.equal(h.spawns.length, 0);
});
test('invalid explicit budgets refuse visibly before draft allocation or dispatch', async () => {
  for (const timeoutMs of [0, -1, 1.5, 2147483648, NaN, '12', null]) {
    const h = harness(); const result = await h.render(A, { timeoutMs });
    assert.equal(result.ok, false); assert.match(result.error, /Invalid preview timeoutMs/);
    assert.deepEqual(h.effects, []); assert.equal(h.uuidCount(), 0); assert.equal(h.requests.length, 0);
  }
  for (const maxOutputBytes of [0, -1, 1.5, Infinity, stringLimit + 1, Number.MAX_SAFE_INTEGER, '12', null]) {
    const h = harness(); const result = await h.render(A, { maxOutputBytes });
    assert.equal(result.ok, false); assert.match(result.error, /Invalid preview maxOutputBytes/);
    assert.deepEqual(h.effects, []); assert.equal(h.spawns.length, 0);
  }
});
test('exclusive UUID collision refuses without overwriting or deleting preexisting entries', async () => {
  const h = harness({ uuidFixed: 'collision' });
  const collision = scriptDir + '/draft-4242-collision.vpy';
  const historical = scriptDir + `/draft-4242-${frozenNow}.vpy`;
  h.seed(collision, 'KEEP'); h.seed(historical, 'KEEP');
  const result = await h.render(A); assert.equal(result.ok, false); assert.match(result.error, /write failed/);
  assert.equal(h.files.get(collision)?.body, 'KEEP'); assert.equal(h.files.get(historical)?.body, 'KEEP');
  assert.equal(h.requests.length, 0); assert.equal(h.effects.some(e => e[0] === 'unlink'), false);
});
test('parent-directory creation failure is an explicit no-dispatch refusal', async () => {
  const h = harness({ mkdirError: true }); let result;
  await assert.doesNotReject(async () => { result = await h.render(A); });
  assert.equal(result.ok, false); assert.match(result.error, /write failed/);
  assert.equal(h.uuidCount(), 0); assert.equal(h.requests.length, 0); assert.equal(h.spawns.length, 0);
});
test('failed exclusive acquisition cannot clean an unowned path', async () => {
  const h = harness({ openError: true }); const result = await h.render(A);
  assert.equal(result.ok, false); assert.match(result.error, /write failed/);
  assert.equal(h.effects.some(e => e[0] === 'unlink'), false); assert.equal(h.fds.size, 0); assert.equal(h.requests.length, 0);
});
test('partial draft write closes its fd and removes only its acquired file', async () => {
  const h = harness({ writeError: true }); const result = await h.render(A);
  assert.equal(result.ok, false); assert.match(result.error, /ENOSPC/); assert.equal(h.fds.size, 0);
  assert.deepEqual(h.drafts(), []); assert.equal(h.requests.length, 0);
  const open = h.effects.find(e => e[0] === 'open'); assert.equal(open[2], 'wx'); assert.equal(open[3], 0o600);
});
test('successful worker response keeps metadata and releases the owned draft', async () => {
  const h = harness({ workerResponse: { ok: true, frame: 3, total: 10, width: 16, height: 9, fpsNum: 25, fpsDen: 1 } });
  const result = await h.render(A); assert.equal(result.ok, true); assert.equal(result.provenance, 'draft');
  assert.equal(result.frame, 3); assert.match(result.dataUrl, /^data:image\/png;base64,/);
  assert.deepEqual(h.drafts(), []); assert.equal(h.spawns.length, 0);
});
test('runtime absence removes the acquired draft without worker or helper dispatch', async () => {
  const h = harness({ runtimeExists: false }); const result = await h.render(A);
  assert.equal(result.ok, false); assert.match(result.error, /No VapourSynth-capable python/);
  assert.deepEqual(h.drafts(), []); assert.equal(h.requests.length, 0); assert.equal(h.spawns.length, 0);
});
test('cleanup refuses a replaced draft inode rather than deleting the replacement', async () => {
  const h = harness({ deferWorker: true }); const pending = h.render(A); await h.flush();
  const file = h.drafts()[0]; h.seed(file, 'REPLACEMENT'); h.respond(0); await pending;
  assert.equal(h.files.get(file)?.body, 'REPLACEMENT');
  assert.equal(h.effects.some(e => e[0] === 'unlink' && e[1] === file), false);
});
test('numeric API budgets reach worker and the one-shot timer unchanged', async () => {
  const h = harness(); await h.render(A, { timeoutMs: 7, maxOutputBytes: 123 });
  assert.equal(h.requests[0].timeoutMs, 7); assert.equal(h.requests[0].maxResponseBytes, 123);
  const child = harness({ autoChildClose: false, env: { VSRES_NO_RENDER_WORKER: '1' } });
  const pending = child.render(A, { timeoutMs: 2147483647, maxOutputBytes: stringLimit }); await child.flush();
  assert([...child.timers.values()].some(t => t.delay === 2147483647));
  child.children[0].stdout.emit('data', JSON.stringify({ ok: false, error: 'fixture done' }));
  child.children[0].emit('close', 1); await pending; assert.deepEqual(child.drafts(), []);
});
test('unconfirmed worker timeout propagates flags and cleans inline text without fallback', async () => {
  const h = harness({ workerResponse: { ok: false, error: 'render worker exited mid-request', timeout: true,
    closureKnown: false, closureUnknown: true, noAutomaticReplay: true } });
  const result = await h.render(A); assert.equal(result.timeout, true); assert.equal(result.closureKnown, false);
  assert.equal(result.closureUnknown, true); assert.equal(result.noAutomaticReplay, true);
  assert.equal(h.spawns.length, 0); assert.deepEqual(h.drafts(), []);
  const next = await h.render(B); assert.equal(next.closureKnown, false);
  assert.equal(h.requests.length, 2); assert.equal(h.spawns.length, 0); assert.deepEqual(h.drafts(), []);
});
test('environment budgets are selected only when API values are absent', async () => {
  const h = harness({ env: { VSRES_PREVIEW_TIMEOUT_MS: '11', VSRES_PREVIEW_MAX_OUTPUT_BYTES: '456' } });
  await h.render(A); assert.equal(h.requests[0].timeoutMs, 11); assert.equal(h.requests[0].maxResponseBytes, 456);
  await h.render(B, { timeoutMs: 13, maxOutputBytes: 789 });
  assert.equal(h.requests[1].timeoutMs, 13); assert.equal(h.requests[1].maxResponseBytes, 789);
  const defaults = harness(); await defaults.render(A);
  assert.equal(defaults.requests[0].timeoutMs, 30_000); assert.equal(defaults.requests[0].maxResponseBytes, 16 * 1024 * 1024);
  const invalid = harness({ env: { VSRES_PREVIEW_TIMEOUT_MS: 'bad', VSRES_PREVIEW_MAX_OUTPUT_BYTES: 'bad' } });
  assert.match((await invalid.render(A)).error, /Invalid preview timeoutMs/); assert.deepEqual(invalid.effects, []);
  assert.match((await invalid.render(A, { timeoutMs: 3 })).error, /Invalid preview maxOutputBytes/);
  await invalid.render(A, { timeoutMs: 3, maxOutputBytes: 100 }); assert.equal(invalid.requests.length, 1);
});
test('worker and one-shot combined output limits are explicit and forbid replay', async () => {
  const h = harness({ workerResponse: { ok: false, error: 'worker write failed: output limit', outputLimit: true,
    closureKnown: true, closureUnknown: false, noAutomaticReplay: true } });
  const result = await h.render(A); assert.equal(result.outputLimit, true); assert.equal(result.noAutomaticReplay, true);
  assert.equal(h.spawns.length, 0); assert.deepEqual(h.drafts(), []);
  const child = harness({ autoChildClose: false, env: { VSRES_NO_RENDER_WORKER: '1' } });
  const pending = child.render(A, { maxOutputBytes: 10 }); let completed = false;
  pending.then(() => { completed = true; }); await child.flush(); const draft = child.drafts()[0];
  child.children[0].stdout.emit('data', '123456'); child.children[0].stderr.emit('data', '12345');
  await child.flush();
  try {
    assert.equal(completed, false, 'accepted signalling waits for actual close or the bounded grace');
    child.fire(5_000); await child.flush();
    assert.equal(completed, true, 'the combined byte cap settles after bounded close observation');
    const limited = await pending;
    assert.equal(limited.outputLimit, true); assert.equal(limited.closureKnown, false);
    assert.equal(child.files.get(draft)?.body, A); assert.equal(child.spawns.length, 1);
    const poison = { toString() { throw Error('Terminal output must be discarded'); } };
    assert.doesNotThrow(() => child.children[0].stdout.emit('data', poison));
    assert.doesNotThrow(() => child.children[0].stderr.emit('data', poison));
  } finally { child.fire(5_000); child.fire(30_000); child.children[0].emit('close', 1); await pending; }
  assert.deepEqual(child.drafts(), []);
  for (const stream of ['stdout', 'stderr']) {
    const h = harness({ autoChildClose: false, env: { VSRES_NO_RENDER_WORKER: '1' } });
    const request = h.render(A); await h.flush();
    try {
      assert.doesNotThrow(() => h.children[0][stream].emit('error', Error('Synthetic pipe failure')));
      assert.equal(h.effects.filter(e => e[0] === 'kill').length, 1);
      assert([...h.timers.values()].some(t => t.delay === 5_000));
      h.children[0].emit('close', 1); const result = await request;
      assert.equal(result.closureKnown, true); assert.match(result.error, new RegExp(stream + ' failed'));
      assert.doesNotThrow(() => h.children[0][stream].emit('error', Error('Late ignored error')));
      assert.equal(h.effects.filter(e => e[0] === 'kill').length, 1);
    } finally { h.fire(30_000); h.fire(5_000); h.children[0].emit('close', 1); await request; }
  }
});
test('unknown closure and protocol errors retain typed flags without fallback', async () => {
  for (const response of [
    { ok: false, error: 'render worker exited mid-request', closureKnown: false },
    { ok: false, error: 'worker protocol failed', protocolError: true, closureKnown: true, closureUnknown: false, noAutomaticReplay: true },
  ]) {
    const h = harness({ workerResponse: response }); const result = await h.render(A);
    assert.equal(result.closureKnown, response.closureKnown);
    if (response.protocolError) assert.equal(result.protocolError, true);
    assert.equal(h.spawns.length, 0); assert.deepEqual(h.drafts(), []);
  }
});
test('superseded stopped-worker flags survive rather than being reduced to silent supersession', async () => {
  const h = harness({ workerResponse: { ok: false, error: 'worker stopped for source priority', superseded: true,
    closureKnown: true, closureUnknown: false, noAutomaticReplay: true } });
  const result = await h.render(A); assert.equal(result.superseded, true); assert.equal(result.noAutomaticReplay, true);
  assert.equal(result.closureKnown, true); assert.equal(h.spawns.length, 0);
});
test('only explicit known-closed engine failures permit one-shot fallback independent of error wording', async () => {
  for (const error of ['render worker exited mid-request', 'render worker repeatedly crashed — falling back']) {
    const h = harness({ workerResponse: { ok: false, error, closureKnown: true, noAutomaticReplay: false } });
    const result = await h.render(A); assert.equal(result.ok, false); assert.match(result.error, /synthetic fallback refusal/);
    assert.equal(h.spawns.length, 1); const argv = h.spawns[0].args;
    assert.equal(argv[0], '/fixture/render.py'); assert.equal(argv[1], '--script'); assert.match(argv[2], /draft-/);
    assert.deepEqual(h.drafts(), []);
  }
  const unknown = harness({ workerResponse: { ok: false, error: 'render worker exited mid-request' } });
  await unknown.render(A); assert.equal(unknown.spawns.length, 0); assert.deepEqual(unknown.drafts(), []);
});
test('unknown one-shot stops retain only original paths and quarantine until every exact close', async () => {
  const h = harness({ autoChildClose: false, env: { VSRES_NO_RENDER_WORKER: '1' } });
  const pending = [h.render(A), h.render(B)]; await h.flush(); assert.equal(h.spawns.length, 2);
  let settledCount = 0; for (const request of pending) request.then(() => { settledCount++; });
  const originals = h.drafts(); h.fire(30_000); await h.flush();
  try {
    assert.equal(settledCount, 0, 'accepted stops observe close before reporting unknown');
    h.fire(5_000); const results = await Promise.all(pending);
    for (const result of results) { assert.equal(result.timeout, true); assert.equal(result.closureKnown, false); }
    assert.equal(h.drafts().length, 2);
    const effectsBefore = h.effects.length; let refusalSettled = false;
    const refused = h.render('clip = "NEVER DISPATCHED"'); pending.push(refused);
    refused.then(() => { refusalSettled = true; }); await h.flush();
    assert.equal(refusalSettled, true); assert.equal(h.spawns.length, 2);
    assert.equal((await refused).closureUnknown, true); assert.equal(h.effects.length, effectsBefore);
    const poison = { toString() { throw Error('Terminal output must be discarded'); } };
    assert.doesNotThrow(() => h.children[0].stdout.emit('data', poison));
    assert.doesNotThrow(() => h.children[0].stderr.emit('data', poison));
    h.children[0].emit('close', null); h.children[0].emit('close', null);
    let secondRefusalSettled = false;
    const still = h.render('clip = "STILL REFUSED"'); pending.push(still);
    still.then(() => { secondRefusalSettled = true; }); await h.flush();
    assert.equal(secondRefusalSettled, true); assert.equal((await still).closureKnown, false); assert.equal(h.spawns.length, 2);
    h.children[1].emit('close', null); assert.deepEqual(h.drafts(), []);
    for (const file of originals) assert.equal(h.effects.filter(e => e[0] === 'unlink' && e[1] === file).length, 1);
    const next = h.render('clip = "AFTER CLOSE"'); pending.push(next); await h.flush(); assert.equal(h.spawns.length, 3);
    h.children[2].stdout.emit('data', JSON.stringify({ ok: false, error: 'fixture done' })); h.children[2].emit('close', 1);
    await next; assert.deepEqual(h.drafts(), []);
  } finally {
    h.fire(30_000); h.fire(5_000); for (const child of h.children) child.emit('close', 1);
    await Promise.allSettled(pending);
  }
});
test('inline or prompt close preserves timeout truth while failed signalling reports unknown immediately', async () => {
  for (const closeMode of ['killInlineClose', 'killAsyncClose']) {
    const h = harness({ autoChildClose: false, [closeMode]: true, env: { VSRES_NO_RENDER_WORKER: '1' } });
    const pending = h.render(A); await h.flush(); h.fire(30_000); await h.flush(); const result = await pending;
    assert.equal(result.timeout, true); assert.equal(result.closureKnown, true); assert.equal(result.closureUnknown, false);
    assert.deepEqual(h.drafts(), []); assert.equal(h.timers.size, 0);
  }
  const refused = harness({ autoChildClose: false, killThrows: true, env: { VSRES_NO_RENDER_WORKER: '1' } });
  const request = refused.render(A); await refused.flush(); refused.fire(30_000); const result = await request;
  assert.equal(result.timeout, true); assert.equal(result.closureKnown, false); assert.equal(refused.drafts().length, 1);
  assert.equal([...refused.timers.values()].some(t => t.delay === 5_000), false);
  refused.children[0].emit('close', 1); assert.deepEqual(refused.drafts(), []);
});
test('one-shot spawn and close protocol never reports signalled or nonzero partial success', async () => {
  const failed = harness({ autoChildClose: false, failedSpawn: true, env: { VSRES_NO_RENDER_WORKER: '1' } });
  const request = failed.render(A); await failed.flush(); failed.children[0].emit('error', Error('Synthetic ENOENT'));
  const failure = await request; assert.equal(failure.closureKnown, true); assert.match(failure.error, /ENOENT/);
  assert.deepEqual(failed.drafts(), []); failed.children[0].emit('close', -2);
  const cleanup = [];
  for (const [code, signal, ok, payload] of [
    [0, null, true, 'valid'], [1, null, false, 'valid'], [0, 'SIGTERM', false, 'valid'],
    [0, null, false, 'invalid'], [0, null, false, 'negative'],
  ]) {
    const h = harness({ autoChildClose: false, env: { VSRES_NO_RENDER_WORKER: '1' } });
    const cacheKey = '/fixture/python\x00/fixture/render.py'; h.cache.set(cacheKey, { ok: true, at: frozenNow });
    const pending = h.render(A); await h.flush(); const argv = h.spawns[0].args;
    const output = argv[argv.indexOf('--out') + 1]; h.seed(output, 'SYNTHETIC PNG');
    const unrelated = '/outside/owner-source.mov'; h.seed(unrelated, 'KEEP UNRELATED');
    h.children[0].stdout.emit('data', payload === 'invalid' ? 'not-json'
      : payload === 'negative' ? JSON.stringify({ ok: false, error: 'synthetic semantic refusal', path: unrelated })
        : JSON.stringify({ ok: true, frame: 0, width: 16, height: 9 }));
    if (!ok) h.children[0].stderr.emit('data', 'No module named fixture_dependency');
    h.children[0].emit('close', code, signal); const result = await pending; assert.equal(result.ok, ok);
    assert.equal(h.cache.has(cacheKey), ok, 'import-shaped nonzero/signal failure invalidates the cached capability');
    assert.equal(h.effects.some(e => e[0] === 'read' && e[1] === output), ok);
    if (!ok) {
      assert.equal(result.dataUrl, undefined);
      if (code !== 0 || signal) assert.equal(result.closureKnown, true);
      if (payload === 'negative') assert.equal(result.error, 'synthetic semantic refusal');
      if (payload === 'invalid') assert.match(result.error, /preview renderer failed/);
    }
    cleanup.push([code, signal, payload, !h.files.has(output)]);
    assert.equal(h.files.get(unrelated)?.body, 'KEEP UNRELATED');
    assert.equal(h.effects.some(e => ['read', 'unlink'].includes(e[0]) && e[1] === unrelated), false);
    assert.deepEqual(h.drafts(), []);
  }
  assert.deepEqual(cleanup, [
    [0, null, 'valid', true], [1, null, 'valid', true], [0, 'SIGTERM', 'valid', true],
    [0, null, 'invalid', true], [0, null, 'negative', true],
  ], 'every known-close result releases only its selected one-shot output');
});
