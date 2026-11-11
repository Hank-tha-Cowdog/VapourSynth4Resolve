// Output safety through the actual consumer, with closed memory-only effect ports.
// No real filesystem mutation, FFmpeg, generated Python or native processing.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { harness, makeDisk, file, SOURCE_FILE, PYTHON, OUTPUT_FILE, DEFAULT_DIR, MODES,
  EXEC_MODES, RAW_SCRIPT_REFUSAL } = require('./__test_registry_harness');
const input = (extra = {}) => ({ filePath: SOURCE_FILE, outputPath: OUTPUT_FILE, ...extra });
const calls = (h, name) => h.effects.filter(e => e[0] === name);
const EXISTS_ERROR = 'output already exists; choose a new outputPath';

test('malformed supplied output paths refuse without any effect or coercion', async () => {
  let coercions = 0;
  const coercible = { [Symbol.toPrimitive]() { coercions++; throw new Error('unexpected coercion'); } };
  for (const entry of ['executor', 'direct']) {
    for (const outputPath of [null, true, false, 1, [], {}, coercible, '', 'file\0.mov']) {
      const h = harness({ forbidEffects: true });
      const result = await h.call(input({ outputPath }), entry);
      assert.equal(result.ok, false);
      assert.equal(result.error, 'outputPath must be a nonempty local file path');
      assert.equal(h.effects.length, 0);
    }
  }
  assert.equal(coercions, 0);
});

for (const entry of ['executor', 'direct']) {
  test(`${entry} refuses every existing destination leaf before discovery or writes`, async () => {
    for (const existing of [file('USER_FILE'), { kind: 'symlink', target: SOURCE_FILE },
      { kind: 'symlink', target: '/sample-fixture/missing' }, { kind: 'directory' }]) {
      const h = harness({ allowedEffects: ['existsSync', 'lstatSync'] });
      h.disk.entries.set(OUTPUT_FILE, existing);
      const result = await h.call(input(), entry);
      assert.equal(result.ok, false); assert.equal(result.error, EXISTS_ERROR);
      assert.equal(h.disk.entries.get(OUTPUT_FILE), existing);
      assert.deepEqual(h.effects.map(e => e[0]), ['existsSync', 'lstatSync']);
      assert.equal(h.spawns.length, 0); assert.equal(h.timers.size, 0);
    }
  });
}

test('an unreadable destination fails closed before executable discovery', async () => {
  const h = harness({ allowedEffects: ['existsSync', 'lstatSync'], faults: { finalLstat: 'EACCES' } });
  const result = await h.call(input());
  assert.equal(result.ok, false); assert.match(result.error, /cannot inspect sample output \(EACCES\)/);
  assert.equal(h.spawns.length, 0); assert.equal(calls(h, 'mkdtempSync').length, 0);
});

test('staging preparation failure cannot spawn or touch the final path', async () => {
  const h = harness({ faults: { mkdtemp: 'ENOSPC' } });
  const result = await h.call(input()); h.assertNoUnexpectedPorts();
  assert.equal(result.ok, false); assert.match(result.error, /temporary sample output \(ENOSPC\)/);
  assert.equal(h.spawns.length, 0); assert.equal(h.disk.entries.has(OUTPUT_FILE), false);
  assert.equal(calls(h, 'linkSync').length, 0); assert.equal(calls(h, 'unlinkSync').length, 0);
});

test('default outputs retain naming and timing in all executable modes', async () => {
  for (const mode of EXEC_MODES) {
    const h = harness();
    const { result, script } = await h.finish(h.call({ filePath: SOURCE_FILE, mode }));
    assert.equal(result.outputPath, `${DEFAULT_DIR}/source_${mode}_rs.mov`);
    assert.equal(result.durationSec, 3); assert.equal(result.warning, undefined);
    assert.ok(script.includes('int(round(10 * fps))'));
    assert.ok(script.includes('int(round(3 * fps))'));
    const staged = h.spawns[1].argv.at(-1);
    assert.equal(path.dirname(path.dirname(staged)), DEFAULT_DIR);
    assert.equal(path.basename(staged), path.basename(result.outputPath));
    assert.equal(calls(h, 'mkdirSync').length, 1);
    assert.equal(calls(h, 'rmdirSync').length, 1);
  }
});

test('explicit outputs reach only private staged arguments and retain mode options', async () => {
  const outputPath = '/sample-fixture/choice "name".mov';
  for (const mode of EXEC_MODES) {
    const h = harness();
    const { result, script } = await h.finish(h.call(input({ outputPath, mode,
      startSec: 0, durationSec: 2, tff: false, preset: 'Fast', rawScript: 'out = work # inert fixture' })));
    const args = h.spawns[1].argv;
    assert.equal(result.outputPath, outputPath);
    assert.equal(args.includes(outputPath), false); assert.equal(args.includes('-y'), false);
    assert.equal(args.includes('-n'), true);
    assert.equal(path.dirname(path.dirname(args.at(-1))), path.dirname(outputPath));
    assert.equal(path.basename(args.at(-1)), path.basename(outputPath));
    assert.ok(args.includes('prores_ks')); assert.ok(args.includes('yuv422p10le'));
    assert.ok(script.includes('int(round(0 * fps))'));
    assert.equal(result.durationSec, 2);
    assert.ok(script.includes('Preset="Fast", TFF=False'));
    assert.equal(calls(h, 'mkdirSync').length, 0);
  }
});

test('raw_script output requests are refused before any effect, path read or spawn', async () => {
  for (const entry of ['executor', 'direct']) {
    const h = harness({ forbidEffects: true });
    const result = await h.call(input({ mode: 'raw_script',
      rawScript: 'out = work # inert fixture' }), entry);
    assert.equal(result.ok, false);
    assert.equal(result.error, RAW_SCRIPT_REFUSAL);
    assert.equal(h.effects.length, 0);
    assert.equal(h.spawns.length, 0);
    assert.equal(h.timers.size, 0);
    assert.equal(h.disk.entries.has(OUTPUT_FILE), false);
  }
});

test('relative output keeps its effective local destination resolved once', async () => {
  const h = harness(); const resolved = path.resolve('relative sample.mov');
  h.disk.entries.set(path.dirname(resolved), { kind: 'directory' });
  const { result } = await h.finish(h.call(input({ outputPath: 'relative sample.mov' })));
  assert.equal(result.outputPath, resolved);
  assert.equal(h.spawns[1].argv.includes('relative sample.mov'), false);
  assert.equal(path.dirname(path.dirname(h.spawns[1].argv.at(-1))), path.dirname(resolved));
});

test('a competing creator after precheck keeps its inode and content', async () => {
  const winner = file('OTHER_WRITER_SENTINEL');
  const h = harness({ beforeLink({ disk, to }) { disk.entries.set(to, winner); } });
  const result = await h.complete(h.call(input()));
  assert.equal(result.ok, false); assert.equal(result.error, EXISTS_ERROR);
  assert.equal(h.disk.entries.get(OUTPUT_FILE), winner);
  assert.equal(winner.content, 'OTHER_WRITER_SENTINEL');
  assert.equal(calls(h, 'linkSync').length, 1);
  assert.equal(calls(h, 'unlinkSync').some(e => e[1] === OUTPUT_FILE), false);
  assert.equal(result.cleanupWarning, undefined);
});

test('two pending consumers targeting one path publish exactly one winner', async () => {
  const disk = makeDisk(); const first = harness({ disk }); const second = harness({ disk });
  const p1 = first.call(input()); const p2 = second.call(input());
  const one = file('FIRST_SAMPLE'); const two = file('SECOND_SAMPLE');
  first.close({ entry: one }); second.close({ entry: two });
  const r1 = await p1; const r2 = await p2;
  first.assertNoUnexpectedPorts(); second.assertNoUnexpectedPorts();
  assert.equal(r1.ok, true); assert.equal(r2.ok, false); assert.equal(r2.error, EXISTS_ERROR);
  assert.equal(disk.entries.get(OUTPUT_FILE), one);
  assert.equal(disk.entries.get(OUTPUT_FILE).content, 'FIRST_SAMPLE');
  assert.equal([...disk.entries.keys()].some(p => p.includes('/.vsres-sample-')), false);
});

test('a default timestamp collision refuses instead of replacing the first sample', async () => {
  const disk = makeDisk(); const first = harness({ disk });
  const { result: original } = await first.finish(first.call({ filePath: SOURCE_FILE }));
  const winner = disk.entries.get(original.outputPath);
  const second = harness({ disk, allowedEffects: ['existsSync', 'clock', 'lstatSync'] });
  const result = await second.call({ filePath: SOURCE_FILE });
  assert.equal(result.ok, false); assert.equal(result.error, EXISTS_ERROR);
  assert.equal(disk.entries.get(original.outputPath), winner);
  assert.equal(second.spawns.length, 0);
});

test('missing empty and nonregular stage outputs are never published', async () => {
  for (const options of [{ missing: true }, { entry: file('', 0) }, { entry: { kind: 'directory' } },
    { entry: { kind: 'symlink', target: SOURCE_FILE, size: 20 } }, { entry: { kind: 'fifo', size: 20 } }]) {
    const h = harness(); const source = h.disk.entries.get(SOURCE_FILE);
    const result = await h.complete(h.call(input()), options);
    assert.equal(result.ok, false); assert.equal(calls(h, 'linkSync').length, 0);
    assert.equal(h.disk.entries.has(OUTPUT_FILE), false);
    assert.equal(h.disk.entries.get(SOURCE_FILE), source);
  }
});

test('failed FFmpeg output retains its primary diagnostics and never publishes', async () => {
  const h = harness({ faults: { unlink: 'EPERM' } }); const pending = h.call(input());
  h.spawns[0].child.stderr.emit('data', 'Traceback: inert Python fixture');
  h.spawns[1].child.stderr.emit('data', 'inert FFmpeg fixture');
  const result = await h.complete(pending, { code: 1 });
  assert.equal(result.ok, false); assert.equal(result.error, 'render failed (ffmpeg exit 1)');
  assert.equal(result.vsError, 'Traceback: inert Python fixture');
  assert.equal(result.ffmpegError, 'inert FFmpeg fixture');
  assert.ok(result.cleanupWarning); assert.equal(result.cleanupErrors[0].code, 'EPERM');
  assert.equal(calls(h, 'linkSync').length, 0); assert.equal(h.disk.entries.has(OUTPUT_FILE), false);
});

test('publication errors fail without a replacing copy rename or unlink fallback', async () => {
  for (const code of ['EXDEV', 'EPERM', 'ENOTSUP', 'ENOSPC']) {
    const h = harness({ faults: { link: code } });
    const result = await h.complete(h.call(input()));
    assert.equal(result.ok, false); assert.equal(result.error, `cannot publish sample output (${code})`);
    assert.equal(calls(h, 'linkSync').length, 1); assert.equal(h.disk.entries.has(OUTPUT_FILE), false);
    assert.equal(calls(h, 'unlinkSync').some(e => e[1] === OUTPUT_FILE), false);
    assert.equal(result.cleanupWarning, undefined);
  }
});

test('unreadable staged output cannot be published', async () => {
  const h = harness({ faults: { stageLstat: 'EACCES' } });
  const result = await h.complete(h.call(input()));
  assert.equal(result.ok, false); assert.equal(result.error, 'cannot publish sample output (EACCES)');
  assert.equal(calls(h, 'linkSync').length, 0); assert.equal(h.disk.entries.has(OUTPUT_FILE), false);
});

test('publication success survives cleanup failure and preserves the clamp warning', async () => {
  const h = harness({ faults: { unlink: 'EPERM' } });
  const result = await h.complete(h.call(input({ durationSec: 40 })));
  assert.equal(result.ok, true); assert.equal(result.outputPath, OUTPUT_FILE);
  assert.equal(result.durationSec, 30); assert.match(result.warning, /rendered 30s instead/);
  assert.ok(result.cleanupWarning); assert.ok(result.temporaryOutputPath.includes('/.vsres-sample-'));
  assert.equal(h.disk.entries.get(OUTPUT_FILE), h.disk.entries.get(result.temporaryOutputPath));
  assert.equal(result.cleanupErrors[0].code, 'EPERM'); assert.equal(result.cleanupErrors[1].code, 'ENOTEMPTY');
  assert.equal(h.timers.size, 0);
});

test('publication collision and cleanup error remain distinct without touching the winner', async () => {
  const winner = file('WINNER');
  const h = harness({ faults: { unlink: 'EPERM' }, beforeLink({ disk, to }) { disk.entries.set(to, winner); } });
  const result = await h.complete(h.call(input()));
  assert.equal(result.ok, false); assert.equal(result.error, EXISTS_ERROR);
  assert.ok(result.cleanupWarning); assert.equal(h.disk.entries.get(OUTPUT_FILE), winner);
  assert.equal(calls(h, 'unlinkSync').some(e => e[1] === OUTPUT_FILE), false);
});

test('an unclosed writer retains staging instead of racing cleanup', async () => {
  const h = harness({ faults: { pipe: 'EPIPE' } });
  const pending = h.call(input()); h.advance(4000);
  const result = await pending; h.assertNoUnexpectedPorts();
  assert.equal(result.ok, false); assert.match(result.error, /fixture EPIPE/);
  assert.ok(result.cleanupWarning); assert.equal(result.cleanupErrors[0].code, 'CHILD_CLOSURE_UNKNOWN');
  assert.equal(calls(h, 'unlinkSync').length, 0); assert.equal(calls(h, 'rmdirSync').length, 0);
  assert.equal(h.disk.entries.has(path.dirname(result.temporaryOutputPath)), true);
  assert.equal(h.disk.entries.has(OUTPUT_FILE), false);
});

test('a synchronous startup refusal preserves its error and removes only owned staging', async () => {
  const h = harness({ faults: { spawn: PYTHON } });
  const result = await h.call(input()); h.assertNoUnexpectedPorts();
  assert.equal(result.ok, false); assert.match(result.error, /fixture EACCES/);
  assert.equal(result.cleanupWarning, undefined); assert.equal(h.spawns.length, 0);
  assert.equal(h.disk.entries.has(OUTPUT_FILE), false);
  assert.equal([...h.disk.entries.keys()].some(p => p.includes('/.vsres-sample-')), false);
});

test('empty-directory cleanup failure is reported after a successful publication', async () => {
  const h = harness({ faults: { rmdir: 'EPERM' } });
  const result = await h.complete(h.call(input()));
  assert.equal(result.ok, true); assert.equal(result.outputPath, OUTPUT_FILE);
  assert.ok(result.cleanupWarning); assert.equal(result.cleanupErrors[0].operation, 'rmdirSync');
  assert.equal(h.disk.entries.has(result.temporaryOutputPath), false);
  assert.equal(h.disk.entries.has(path.dirname(result.temporaryOutputPath)), true);
});

test('schema advertises no overwrite and hard-link compatibility without adding an overwrite switch', () => {
  const h = harness({ forbidEffects: true });
  const schema = h.api.TOOL_DEFINITIONS.find(d => d.name === 'render_sample').input_schema;
  assert.equal(schema.properties.outputPath.type, 'string');
  assert.match(schema.properties.outputPath.description, /never replaced/);
  assert.match(schema.properties.outputPath.description, /hard-link support/);
  assert.equal(schema.properties.overwrite, undefined); assert.equal(schema.properties.output_path, undefined);
  assert.equal(schema.required.includes('outputPath'), false); assert.equal(h.effects.length, 0);
});
