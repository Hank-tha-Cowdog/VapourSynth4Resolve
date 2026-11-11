// Pure UI report/polling contracts. No Electron, status file, credentials or provider.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const source = path.join(__dirname, '../src/services/plugin-status.ts');
const compiled = ts.transpileModule(fs.readFileSync(source, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
});
const moduleObject = { exports: {} };
vm.runInNewContext(compiled.outputText, {
  module: moduleObject, exports: moduleObject.exports,
  require() { throw new Error('The UI status model must not import services'); },
}, { filename: source, timeout: 1000 });
const { parsePluginReport, pollPluginStatus, reportAge, statusPresentation } = moduleObject.exports;
const NOW = 1_800_000_000_000;
const snapshot = (patch = {}) => ({ state: 'chain-ok', error: null, scriptPreview: '',
  stepCount: 2, timestampMs: NOW, ...patch });
const feed = (report, availability = 'ready') => ({ availability, report: parsePluginReport(report) });
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
function scheduler() {
  const queue = new Map();
  let next = 0;
  return {
    queue,
    schedule(fn) { const id = next++; queue.set(id, fn); return id; },
    cancel(id) { queue.delete(id); },
    advance() { const [id, fn] = queue.entries().next().value; queue.delete(id); fn(); },
  };
}

test('accepts actual plugin states, including host action without render proof', () => {
  for (const state of ['idle', 'passthrough', 'chain-empty', 'chain-disabled',
    'chain-awaiting-approval', 'config-applied', 'config-apply-unconfirmed', 'chain-ok', 'chain-error']) {
    assert.equal(parsePluginReport(snapshot({ state })).state, state);
  }
});

test('malformed reports cannot become a configured or running state', () => {
  for (const value of [null, [], {}, snapshot({ state: 'running' }),
    snapshot({ state: '__proto__' }), snapshot({ scriptPreview: {} }),
    snapshot({ error: {} }), snapshot({ stepCount: -1 }),
    snapshot({ stepCount: 1.5 }), snapshot({ stepCount: Infinity })]) {
    assert.equal(parsePluginReport(value), null);
  }
});

test('chain-ok is reported configuration, never proof of current rendering', () => {
  const view = statusPresentation(feed(snapshot()), NOW);
  assert.equal(view.title, 'Chain configured');
  assert.match(view.message, /2 approved filter steps reported/);
  assert.match(view.message, /verify the output/);
  assert.doesNotMatch(view.title + view.message, /running|live|connected/i);
});

test('age comes from the report timestamp and stale paused reports are not disconnections', () => {
  const value = feed(snapshot({ timestampMs: NOW - 35_000 }));
  const view = statusPresentation(value, NOW);
  assert.equal(view.title, 'No recent status update');
  assert.equal(view.tone, 'warning');
  assert.equal(view.age, 'Updated 35s ago');
  assert.match(view.message, /Last report: chain configured/);
  assert.doesNotMatch(view.message, /disconnect|offline/i);
});

test('future, missing and invalid report times never become fresh green status', () => {
  for (const timestampMs of [NOW + 1, NOW + 60_000, undefined, 0, NaN, Infinity, 'today']) {
    const view = statusPresentation(feed(snapshot({ timestampMs })), NOW);
    assert.equal(view.title, 'Report time unavailable');
    assert.equal(view.tone, 'warning');
    assert.doesNotMatch(view.message, /running|live|connected/i);
  }
});

test('age formatting and stale boundary remain stable without refreshing the timestamp', () => {
  assert.equal(reportAge(NOW - 4999, NOW).label, 'Updated just now');
  assert.equal(reportAge(NOW - 29_999, NOW).stale, false);
  assert.equal(reportAge(NOW - 30_000, NOW).stale, true);
  assert.equal(reportAge(NOW - 61_000, NOW).label, 'Updated 1m ago');
  assert.equal(reportAge(NOW - 3_600_000, NOW).label, 'Updated 1h ago');
  assert.equal(reportAge(NOW - 86_400_000, NOW).label, 'Updated 1d ago');
});

test('loading, unavailable and malformed states explain the next useful action', () => {
  assert.match(statusPresentation({ availability: 'loading', report: null }, NOW).title, /Checking/);
  const absent = statusPresentation({ availability: 'unavailable', report: null }, NOW);
  assert.match(absent.message, /Open the companion from the VapourSynth effect/);
  const invalid = statusPresentation(feed(snapshot(), 'invalid'), NOW);
  assert.match(invalid.message, /incomplete report/);
  assert.match(invalid.message, /Last report: chain configured/);
  assert.equal(invalid.tone, 'warning');
});

test('error without a script remains an error with inspectable report content', () => {
  const value = feed(snapshot({ state: 'chain-error', error: 'getFrame: synthetic error', scriptPreview: '' }));
  assert.equal(value.report.error, 'getFrame: synthetic error');
  const view = statusPresentation(value, NOW);
  assert.equal(view.tone, 'error');
  assert.match(view.message, /Open the report/);
});

test('only one bridge read is active, and polling waits for completion', async () => {
  const timers = scheduler();
  let resolve, reads = 0;
  const results = [];
  const stop = pollPluginStatus(() => { reads++; return new Promise(r => { resolve = r; }); },
    value => results.push(value), timers);
  assert.equal(reads, 1);
  assert.equal(timers.queue.size, 0);
  resolve({ ok: true, status: snapshot() });
  await flush();
  assert.equal(results.length, 1);
  assert.equal(timers.queue.size, 1);
  timers.advance();
  assert.equal(reads, 2);
  assert.equal(timers.queue.size, 0);
  stop(); resolve({ ok: true, status: snapshot() }); await flush();
  assert.equal(results.length, 1);
});

test('dispose suppresses late results and schedules no replacement read', async () => {
  const timers = scheduler(), results = [];
  let resolve;
  const stop = pollPluginStatus(() => new Promise(r => { resolve = r; }), x => results.push(x), timers);
  stop(); resolve({ ok: true, status: snapshot() }); await flush();
  assert.equal(results.length, 0);
  assert.equal(timers.queue.size, 0);
});

test('dispose also cancels timer handle zero', async () => {
  const timers = scheduler();
  const stop = pollPluginStatus(() => ({ ok: true, status: snapshot() }), () => {}, timers);
  await flush();
  assert.equal(timers.queue.has(0), true);
  stop();
  assert.equal(timers.queue.size, 0);
});

test('sync throws and rejected reads become unavailable and retry serially', async () => {
  for (const read of [() => { throw new Error('synthetic bridge throw'); },
    () => Promise.reject(new Error('synthetic bridge rejection'))]) {
    const timers = scheduler(), results = [];
    const stop = pollPluginStatus(read, x => results.push(x), timers);
    await flush();
    assert.equal(results[0].availability, 'unavailable');
    assert.equal(timers.queue.size, 1);
    stop();
  }
});

test('read failure retains the last valid report explicitly without renewing its age', async () => {
  const timers = scheduler(), results = [];
  let reads = 0;
  const stop = pollPluginStatus(() => ++reads === 1
    ? { ok: true, status: snapshot({ timestampMs: NOW - 40_000 }) }
    : { ok: false, error: 'synthetic missing report' }, x => results.push(x), timers);
  await flush(); timers.advance(); await flush(); stop();
  const value = results[1];
  assert.equal(value.availability, 'unavailable');
  assert.equal(value.report.timestampMs, NOW - 40_000);
  const view = statusPresentation(value, NOW);
  assert.equal(view.title, 'Plugin status unavailable');
  assert.equal(view.age, 'Updated 40s ago');
  assert.match(view.message, /Last report: chain configured/);
});

test('successful reads of the same old report do not imply renewed activity', async () => {
  const timers = scheduler(), results = [];
  const stop = pollPluginStatus(() => ({ ok: true, status: snapshot({ timestampMs: NOW - 10_000 }) }),
    x => results.push(x), timers);
  await flush(); timers.advance(); await flush(); stop();
  assert.equal(statusPresentation(results[1], NOW + 25_000).title, 'No recent status update');
});


test('host-action acceptance stays separate from rendering, persistence and later pending edits', () => {
  const view = statusPresentation(feed(snapshot({ state: 'config-applied' })), NOW);
  assert.equal(view.title, 'Host apply reported');
  assert.match(view.message, /Rendering and project persistence are unconfirmed/);
  assert.match(view.message, /later companion edits apply automatically on save and close/);
  assert.doesNotMatch(view.title + view.message, /render complete|saved successfully|running/i);
});


test('unknown host-write outcome warns about partial change without claiming rollback or failure before effects', () => {
  const view = statusPresentation(feed(snapshot({ state: 'config-apply-unconfirmed' })), NOW);
  assert.equal(view.title, 'Host apply outcome unconfirmed'); assert.equal(view.tone, 'error');
  assert.match(view.message, /may have changed state/); assert.match(view.message, /no rollback/);
  assert.doesNotMatch(view.message, /unchanged|not applied|safe to retry|render complete/);
});
