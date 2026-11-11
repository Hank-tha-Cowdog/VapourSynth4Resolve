// NEW affected tests: actual consumer, memory-only children/streams/clock/files.
// Fake signals and event-loop timers never reach real subprocesses or Python.
const test = require('node:test');
const assert = require('node:assert/strict');
const { harness, file, SOURCE_FILE, PYTHON, FFMPEG, OUTPUT_FILE } = require('./__test_registry_harness');
const RUN = 600000, GRACE = 2000, CAP = 8192;
const input = () => ({ filePath: SOURCE_FILE, outputPath: OUTPUT_FILE });
const calls = (h, name) => h.effects.filter(e => e[0] === name);
const codedError = (message, code = 'EIO') => Object.assign(new Error(message), { code });
const tick = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
function observed(pending) { let result; pending.then(value => { result = value; }); return () => result; }
async function resultOf(h, pending) { const result = await pending; h.assertNoUnexpectedPorts(); return result; }
function known(result) {
  assert.equal(result.closureKnown, true);
  assert.equal(result.processes.producer.closed, true); assert.equal(result.processes.writer.closed, true);
}

test('producer-first success waits for writer close before one no-replace publication', async () => {
  const h = harness(); const pending = h.call(input()); const peek = observed(pending); h.stage();
  h.closeChild('producer'); await tick();
  assert.equal(peek(), undefined); assert.equal(calls(h, 'linkSync').length, 0); assert.equal(h.timers.size, 1);
  h.closeChild('writer'); const result = await resultOf(h, pending); known(result);
  assert.equal(result.ok, true); assert.equal(result.outputPath, OUTPUT_FILE);
  assert.equal(calls(h, 'linkSync').length, 1); assert.equal(calls(h, 'kill').length, 0);
  assert.equal(h.spawns[1].argv.includes(OUTPUT_FILE), false);
  assert.ok(h.spawns[1].argv.includes('-n')); assert.ok(!h.spawns[1].argv.includes('-y'));
  assert.equal(h.timers.size, 0);
});

test('writer-first success keeps the run timer until producer close', async () => {
  const h = harness(); const pending = h.call(input()); const peek = observed(pending); h.stage();
  h.closeChild('writer'); await tick();
  assert.equal(peek(), undefined); assert.equal(calls(h, 'linkSync').length, 0); assert.equal(h.timers.size, 1);
  h.closeChild('producer'); const result = await resultOf(h, pending); known(result);
  assert.equal(result.ok, true); assert.equal(calls(h, 'linkSync').length, 1); assert.equal(h.timers.size, 0);
});

test('writer zero cannot hide a later producer failure', async () => {
  const h = harness(); const pending = h.call(input()); h.stage(); h.closeChild('writer'); h.closeChild('producer', 7);
  const result = await resultOf(h, pending); known(result);
  assert.equal(result.ok, false); assert.match(result.error, /producer exited with code 7/);
  assert.equal(result.processes.producer.code, 7); assert.equal(result.processes.writer.code, 0);
  assert.equal(calls(h, 'linkSync').length, 0); assert.equal(calls(h, 'kill').length, 0);
  assert.equal(h.disk.entries.has(OUTPUT_FILE), false); assert.equal(h.timers.size, 0);
});

test('producer zero cannot hide a writer failure and keeps writer diagnostics', async () => {
  const h = harness(); const pending = h.call(input()); h.stage();
  h.spawns[1].child.stderr.emit('data', 'writer fixture'); h.closeChild('producer'); h.closeChild('writer', 1);
  const result = await resultOf(h, pending); known(result);
  assert.equal(result.ok, false); assert.equal(result.error, 'render failed (ffmpeg exit 1)');
  assert.equal(result.ffmpegError, 'writer fixture'); assert.equal(calls(h, 'linkSync').length, 0);
});

test('an asynchronous producer error remains failure even when both later close zero', async () => {
  const h = harness(); const pending = h.call(input()); h.stage();
  h.spawns[0].child.emit('error', codedError('producer unavailable', 'ENOENT'));
  h.closeChild('producer'); h.closeChild('writer');
  const result = await resultOf(h, pending); known(result);
  assert.equal(result.ok, false); assert.match(result.error, /producer process error: producer unavailable/);
  assert.equal(result.processes.producer.error.code, 'ENOENT');
  assert.equal(calls(h, 'kill').length, 2); assert.equal(calls(h, 'linkSync').length, 0);
});

test('an asynchronous failed writer acquisition stops only the live producer', async () => {
  const h = harness(); const pending = h.call(input());
  h.spawns[1].child.pid = undefined;
  h.spawns[1].child.emit('error', codedError('writer unavailable', 'ENOENT'));
  h.closeChild('writer', -2); h.closeChild('producer');
  const result = await resultOf(h, pending); known(result);
  assert.equal(result.ok, false); assert.match(result.error, /writer process error: writer unavailable/);
  assert.deepEqual(calls(h, 'kill').map(e => e[1]), [PYTHON]);
  assert.equal(calls(h, 'linkSync').length, 0); assert.equal(h.timers.size, 0);
});

test('first synchronous spawn failure acquires no child and cleans only owned staging', async () => {
  const h = harness({ faults: { spawn: PYTHON } });
  const result = await resultOf(h, h.call(input()));
  assert.equal(result.ok, false); assert.match(result.error, /sample producer spawn error: fixture EACCES/);
  assert.equal(result.closureKnown, true); assert.equal(result.processes.producer.acquired, false);
  assert.equal(result.processes.writer.acquired, false); assert.equal(h.spawns.length, 0);
  assert.equal(calls(h, 'kill').length, 0); assert.equal(h.timers.size, 0);
  assert.equal([...h.disk.entries.keys()].some(p => p.includes('/.vsres-sample-')), false);
});

test('second synchronous spawn failure waits for the acquired producer to close', async () => {
  const h = harness({ faults: { spawn: FFMPEG } }); const pending = h.call(input()); const peek = observed(pending);
  await tick(); assert.equal(peek(), undefined); assert.equal(h.spawns.length, 1);
  assert.equal(calls(h, 'unlinkSync').length, 0); assert.equal(calls(h, 'kill').length, 1);
  h.closeChild('producer'); const result = await resultOf(h, pending);
  assert.equal(result.ok, false); assert.match(result.error, /sample writer spawn error: fixture EACCES/);
  assert.equal(result.closureKnown, true); assert.equal(result.processes.producer.closed, true);
  assert.equal(result.processes.writer.acquired, false); assert.equal(h.timers.size, 0);
});

test('pipe setup failure has handlers installed and waits for both owned closures', async () => {
  const h = harness({ faults: { pipe: 'EPIPE' } }); const pending = h.call(input()); h.stage();
  assert.ok(h.spawns[0].child.stdout.listenerCount('error'));
  assert.ok(h.spawns[0].child.stderr.listenerCount('error'));
  assert.ok(h.spawns[1].child.stdin.listenerCount('error'));
  assert.ok(h.spawns[1].child.stderr.listenerCount('error'));
  assert.equal(calls(h, 'unlinkSync').length, 0);
  h.closeChild('writer'); h.closeChild('producer'); const result = await resultOf(h, pending); known(result);
  assert.equal(result.ok, false); assert.match(result.error, /fixture EPIPE/);
  assert.equal(calls(h, 'kill').length, 2); assert.equal(calls(h, 'linkSync').length, 0);
});

for (const [name, port] of [['producer', 'stdout'], ['producer', 'stderr'], ['writer', 'stdin'], ['writer', 'stderr']]) {
  test(`${name} ${port} error is handled as a latched failure`, async () => {
    const h = harness(); const pending = h.call(input()); h.stage();
    const child = h.spawns[name === 'producer' ? 0 : 1].child;
    child[port].emit('error', codedError('pipe fixture', 'EPIPE'));
    h.closeChild('producer'); h.closeChild('writer'); const result = await resultOf(h, pending); known(result);
    assert.equal(result.ok, false); assert.equal(result.error, `${name} ${port} error: pipe fixture`);
    assert.equal(result.processes[name].error.phase, port); assert.equal(calls(h, 'linkSync').length, 0);
    assert.equal(h.timers.size, 0);
  });
}

test('first failure and one-time settlement survive duplicate errors and late events', async () => {
  const h = harness(); const pending = h.call(input()); let settlements = 0; pending.then(() => settlements++); h.stage();
  h.spawns[0].child.stderr.emit('error', codedError('FIRST'));
  h.spawns[1].child.emit('error', codedError('SECOND'));
  h.closeChild('producer'); h.closeChild('writer'); const result = await resultOf(h, pending);
  const before = JSON.stringify(result); const effects = h.effects.length;
  h.spawns[0].child.stderr.emit('data', Buffer.alloc(10000));
  h.spawns[1].child.emit('error', codedError('LATE'));
  h.closeChild('writer', 9); h.advance(RUN + 2 * GRACE); await tick();
  assert.match(result.error, /FIRST/); assert.equal(settlements, 1);
  assert.equal(JSON.stringify(result), before); assert.equal(h.effects.length, effects);
  assert.equal(calls(h, 'linkSync').length, 0); assert.equal(h.timers.size, 0);
});

test('timeout requests TERM then KILL but reports unknown closure instead of success', async () => {
  const h = harness(); const pending = h.call(input()); const peek = observed(pending); const stage = h.stage();
  h.advance(RUN); await tick(); assert.equal(peek(), undefined);
  assert.deepEqual(calls(h, 'kill').map(e => e[2]), ['SIGTERM', 'SIGTERM']);
  h.advance(GRACE); assert.deepEqual(calls(h, 'kill').map(e => e[2]), ['SIGTERM', 'SIGTERM', 'SIGKILL', 'SIGKILL']);
  h.advance(GRACE); const result = await resultOf(h, pending);
  assert.equal(result.ok, false); assert.equal(result.error, 'sample render timed out');
  assert.equal(result.closureKnown, false); assert.equal(result.retryable, false); assert.ok(result.closureWarning);
  assert.equal(result.cleanupErrors[0].code, 'CHILD_CLOSURE_UNKNOWN');
  assert.equal(h.disk.entries.has(stage), true); assert.equal(calls(h, 'unlinkSync').length, 0);
  assert.equal(calls(h, 'linkSync').length, 0); assert.equal(h.timers.size, 0);
});

test('writer zero with an exited but unclosed producer never signals the exited PID', async () => {
  const h = harness(); const pending = h.call(input()); h.stage();
  h.exitChild('producer'); h.closeChild('writer'); h.advance(RUN + 2 * GRACE);
  const result = await resultOf(h, pending);
  assert.equal(result.ok, false); assert.equal(result.closureKnown, false);
  assert.equal(result.processes.producer.exitObserved, true); assert.equal(result.processes.producer.closed, false);
  assert.equal(result.processes.writer.closed, true); assert.equal(calls(h, 'kill').length, 0);
  assert.equal(calls(h, 'unlinkSync').length, 0); assert.equal(calls(h, 'linkSync').length, 0);
});

test('Node exitCode property independently prevents signalling before the exit listener runs', async () => {
  const h = harness(); const pending = h.call(input()); h.stage();
  h.spawns[0].child.exitCode = 0; h.closeChild('writer'); h.advance(RUN + 2 * GRACE);
  const result = await resultOf(h, pending);
  assert.equal(result.closureKnown, false); assert.equal(result.processes.producer.exitObserved, false);
  assert.equal(result.processes.producer.observedExitCode, 0); assert.equal(calls(h, 'kill').length, 0);
});

test('a thrown signal denial is recorded without escalation or alternate signalling', async () => {
  const h = harness({ faults: { kill: 'EPERM' } }); const pending = h.call(input()); h.stage();
  h.advance(RUN + 2 * GRACE); const result = await resultOf(h, pending);
  assert.equal(result.error, 'sample render timed out'); assert.equal(result.closureKnown, false);
  assert.deepEqual(calls(h, 'kill').map(e => e[2]), ['SIGTERM', 'SIGTERM']);
  for (const state of Object.values(result.processes)) {
    assert.equal(state.stopDenied, true); assert.equal(state.stopError.code, 'EPERM');
    assert.equal(state.stopRequests.length, 1); assert.equal(state.stopRequests[0].accepted, false);
  }
});

test('kill false is not closure and is not followed by another signal', async () => {
  const h = harness({ faults: { kill: false } }); const pending = h.call(input()); h.stage();
  h.advance(RUN + 2 * GRACE); const result = await resultOf(h, pending);
  assert.equal(result.closureKnown, false); assert.equal(result.retryable, false);
  assert.equal(calls(h, 'kill').length, 2); assert.equal(result.processes.producer.stopError.message, 'signal was not sent');
  assert.equal(calls(h, 'unlinkSync').length, 0);
});

test('an error emitted during a signal request latches denial and preserves the primary cause', async () => {
  const h = harness({ onKill({ child }) { child.emit('error', codedError('signal rejected', 'EPERM')); } });
  const pending = h.call(input()); h.stage(); h.advance(RUN + 2 * GRACE);
  const result = await resultOf(h, pending);
  assert.equal(result.error, 'sample render timed out'); assert.equal(calls(h, 'kill').length, 2);
  assert.equal(result.processes.writer.stopDenied, true); assert.equal(result.processes.writer.stopError.code, 'EPERM');
  assert.equal(result.processes.writer.error.afterStopRequest, true);
});

test('a later concrete signal errno enriches kill-false evidence without masking the first failure', async () => {
  const h = harness({ faults: { kill: false } }); const pending = h.call(input()); h.stage();
  h.spawns[0].child.stderr.emit('error', codedError('FIRST'));
  h.spawns[0].child.emit('error', codedError('signal permission denied', 'EPERM'));
  h.advance(2 * GRACE); const result = await resultOf(h, pending);
  assert.match(result.error, /FIRST/); assert.equal(result.processes.producer.error.message, 'FIRST');
  const stop = result.processes.producer.stopError;
  assert.equal(stop.code, 'EPERM'); assert.equal(stop.message, 'signal permission denied');
  assert.equal(stop.initialMessage, 'signal was not sent');
  assert.equal(result.processes.producer.stopRequests[0].accepted, false);
  assert.equal(result.closureKnown, false); assert.equal(calls(h, 'kill').length, 2);
});

test('TERM delivery alone does not settle; actual later closes cancel escalation', async () => {
  const h = harness(); const pending = h.call(input()); const peek = observed(pending); h.stage();
  h.advance(RUN); await tick(); assert.equal(peek(), undefined);
  h.closeChild('producer', null, 'SIGTERM'); h.closeChild('writer', null, 'SIGTERM');
  const result = await resultOf(h, pending); known(result); h.advance(2 * GRACE);
  assert.equal(result.ok, false); assert.equal(result.error, 'sample render timed out');
  assert.equal(calls(h, 'kill').length, 2); assert.equal(h.timers.size, 0);
  assert.equal(result.processes.producer.signal, 'SIGTERM'); assert.equal(result.cleanupWarning, undefined);
});

test('KILL requests still require both late close events before known cleanup', async () => {
  const h = harness({ faults: { pipe: 'EPIPE' } }); const pending = h.call(input()); const stage = h.stage();
  h.advance(GRACE); assert.equal(calls(h, 'kill').length, 4);
  h.closeChild('producer', null, 'SIGKILL'); h.closeChild('writer', null, 'SIGKILL');
  const result = await resultOf(h, pending); known(result);
  assert.match(result.error, /fixture EPIPE/); assert.equal(h.disk.entries.has(stage), false);
  assert.equal(calls(h, 'linkSync').length, 0); assert.equal(h.timers.size, 0);
});

test('synchronous closes during owned stop calls settle once with complete request metadata', async () => {
  let h;
  h = harness({ onKill({ command }) { h.closeChild(command === PYTHON ? 'producer' : 'writer'); } });
  const pending = h.call(input()); h.stage(); h.spawns[0].child.stderr.emit('error', codedError('FIRST'));
  const result = await resultOf(h, pending); known(result);
  assert.match(result.error, /FIRST/); assert.equal(calls(h, 'kill').length, 2);
  for (const state of Object.values(result.processes)) assert.equal(state.stopRequests[0].accepted, true);
  assert.equal(h.timers.size, 0); assert.equal(calls(h, 'linkSync').length, 0);
});

test('late closes after an unknown-closure result cannot publish clean or rewrite that result', async () => {
  const h = harness(); const pending = h.call(input()); let settlements = 0; pending.then(() => settlements++); const stage = h.stage();
  h.advance(RUN + 2 * GRACE); const result = await resultOf(h, pending);
  const before = JSON.stringify(result); const effects = h.effects.length;
  h.closeChild('producer'); h.closeChild('writer'); h.spawns[1].child.stderr.emit('error', codedError('late'));
  h.spawns[0].child.stderr.emit('data', '# late'); h.advance(RUN); await tick();
  assert.equal(settlements, 1); assert.equal(JSON.stringify(result), before); assert.equal(h.effects.length, effects);
  assert.equal(h.disk.entries.has(stage), true); assert.equal(calls(h, 'linkSync').length, 0);
});

test('large diagnostic chunks retain only copied byte tails with explicit lost-byte counts', async () => {
  const h = harness(); const pending = h.call(input()); h.stage();
  const py = Buffer.alloc(CAP * 16, 65); Buffer.from('\n# copied tail\n').copy(py, py.length - 15);
  const ff = Buffer.alloc(CAP + 10, 69);
  h.spawns[0].child.stderr.emit('data', py); h.spawns[1].child.stderr.emit('data', ff);
  py.fill(90); ff.fill(90); // A retained subarray view would now expose Z bytes.
  h.spawns[0].child.stderr.emit('data', Buffer.alloc(0));
  h.closeChild('producer', 1); h.closeChild('writer'); const result = await resultOf(h, pending);
  assert.equal(result.ok, false); assert.ok(result.vsInfo.includes('# copied tail'));
  assert.equal(result.ffmpegError, 'E'.repeat(500));
  for (const [name, total] of [['producer', py.length], ['writer', ff.length]]) {
    const info = result.diagnostics[name];
    assert.equal(info.retainedBytes, CAP); assert.equal(info.totalBytes, total);
    assert.equal(info.discardedBytes, total - CAP); assert.equal(info.truncated, true);
  }
  assert.equal(result.diagnostics.maxRetainedBytes, CAP);
});

test('multibyte string and Buffer diagnostics stay byte bounded while a failed run drains', async () => {
  const h = harness(); const pending = h.call(input()); h.stage();
  h.spawns[0].child.emit('error', codedError('FIRST'));
  const text = 'λ👾'.repeat(500); const bytes = Buffer.byteLength(text);
  for (let i = 0; i < 32; i++) h.spawns[0].child.stderr.emit('data', i % 2 ? text : Buffer.from(text));
  h.spawns[1].child.stderr.emit('data', 'short');
  h.closeChild('writer'); h.closeChild('producer'); const result = await resultOf(h, pending);
  assert.match(result.error, /FIRST/); assert.equal(result.diagnostics.producer.totalBytes, bytes * 32);
  assert.equal(result.diagnostics.producer.retainedBytes, CAP);
  assert.equal(result.diagnostics.producer.discardedBytes, bytes * 32 - CAP);
  assert.equal(result.diagnostics.writer.totalBytes, 5); assert.equal(result.diagnostics.writer.truncated, false);
  assert.ok(result.vsError.length <= 1500); assert.equal(result.ffmpegError, 'short');
});

test('short successful diagnostics preserve vsInfo and declare no truncation', async () => {
  const h = harness(); const pending = h.call(input());
  h.spawns[0].child.stderr.emit('data', '# ready\n'); h.spawns[1].child.stderr.emit('data', 'short');
  const { result } = await h.finish(pending); known(result);
  assert.equal(result.vsInfo, '# ready');
  assert.equal(result.diagnostics.producer.totalBytes, 8); assert.equal(result.diagnostics.producer.retainedBytes, 8);
  assert.equal(result.diagnostics.producer.truncated, false); assert.equal(result.diagnostics.writer.truncated, false);
});

test('process error text is bounded separately and later failures cannot grow it', async () => {
  const h = harness(); const pending = h.call(input()); h.stage();
  h.spawns[0].child.emit('error', codedError('X'.repeat(20000)));
  h.spawns[0].child.emit('error', codedError('Y'.repeat(20000)));
  h.closeChild('producer'); h.closeChild('writer'); const result = await resultOf(h, pending);
  assert.equal(result.processes.producer.error.message.length, 512);
  assert.equal(result.processes.producer.error.message, 'X'.repeat(512));
  assert.ok(result.error.length < 600); assert.equal(result.diagnostics.producer.totalBytes, 0);
});

test('signal termination remains failure with explicit status even if the peer is successful', async () => {
  const h = harness(); const pending = h.call(input()); h.stage();
  h.closeChild('producer', null, 'SIGTERM'); h.closeChild('writer');
  const result = await resultOf(h, pending); known(result);
  assert.equal(result.ok, false); assert.equal(result.processes.producer.signal, 'SIGTERM');
  assert.match(result.error, /producer exited with SIGTERM/); assert.equal(calls(h, 'linkSync').length, 0);
});

test('no-replace publication still preserves a competing final entry after both successful closes', async () => {
  const winner = file('WINNER');
  const h = harness({ beforeLink({ disk, to }) { disk.entries.set(to, winner); } });
  const result = await h.complete(h.call(input())); known(result);
  assert.equal(result.ok, false); assert.equal(result.error, 'output already exists; choose a new outputPath');
  assert.equal(h.disk.entries.get(OUTPUT_FILE), winner); assert.equal(calls(h, 'linkSync').length, 1);
  assert.equal(calls(h, 'unlinkSync').some(e => e[1] === OUTPUT_FILE), false);
});

test('both successful closes still require a regular nonempty stage before publication', async () => {
  const h = harness();
  const result = await h.complete(h.call(input()), { entry: file('', 0) }); known(result);
  assert.equal(result.ok, false); assert.equal(result.error, 'render produced no regular nonempty sample output');
  assert.equal(calls(h, 'linkSync').length, 0);
});

test('producer failure stays primary when closed-run staging cleanup also fails', async () => {
  const h = harness({ faults: { unlink: 'EPERM' } });
  const result = await h.complete(h.call(input()), { producerCode: 4 }); known(result);
  assert.equal(result.ok, false); assert.match(result.error, /producer exited with code 4/);
  assert.ok(result.cleanupWarning); assert.equal(result.cleanupErrors[0].code, 'EPERM');
  assert.equal(calls(h, 'linkSync').length, 0);
});

test('a published success keeps its outcome and separate cleanup warning after known closure', async () => {
  const h = harness({ faults: { unlink: 'EPERM' } });
  const result = await h.complete(h.call(input())); known(result);
  assert.equal(result.ok, true); assert.equal(result.outputPath, OUTPUT_FILE); assert.ok(result.cleanupWarning);
  assert.equal(h.disk.entries.has(OUTPUT_FILE), true); assert.equal(h.timers.size, 0);
});
