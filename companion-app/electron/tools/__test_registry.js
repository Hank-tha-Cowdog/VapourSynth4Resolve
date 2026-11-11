// Scalar regressions for the real registry, using shared closed effect ports.
const test = require('node:test');
const assert = require('node:assert/strict');
const { harness, SOURCE_FILE, OUTPUT_FILE, MODES, EXEC_MODES, RAW_SCRIPT_REFUSAL } = require('./__test_registry_harness');

const invalidTypes = [
  ['true', true], ['false', false], ['numeric string', '1'], ['zero string', '0'],
  ['empty string', ''], ['whitespace', ' '],
  ['Python expression string', '0)); print("SCALAR_FIXTURE")\n#'],
  ['null', null], ['array', []], ['numeric array', [1]], ['object', {}],
  ['boxed number', new Number(1)], ['NaN', NaN], ['positive infinity', Infinity],
  ['negative infinity', -Infinity], ['BigInt', 1n], ['Symbol', Symbol('scalar')],
];

for (const entry of ['executor', 'direct']) {
  for (const [field, invalidRange, expectedError] of [
    ['startSec', [['negative', -0.25]], 'startSec must be a finite number >= 0'],
    ['durationSec', [['negative', -0.25], ['zero', 0], ['negative zero', -0]], 'durationSec must be a finite number > 0'],
  ]) {
    test(`${entry} rejects invalid ${field} before every effect port`, async () => {
      for (const mode of MODES) {
        for (const [label, value] of [...invalidTypes, ...invalidRange]) {
          const h = harness({ forbidEffects: true });
          const result = await h.call(Object.freeze({ filePath: SOURCE_FILE, mode, [field]: value }), entry);
          assert.equal(result.ok, false, `${mode}: ${label}`);
          assert.equal(result.error, expectedError, `${mode}: ${label}`);
          assert.equal(h.effects.length, 0, `${mode}: ${label} touched effects`);
          assert.equal(h.spawns.length, 0);
          assert.equal(h.timers.size, 0);
        }
      }
    });
  }
}

test('scalar objects are rejected without invoking coercion hooks', async () => {
  let coercions = 0;
  const scalar = {
    [Symbol.toPrimitive]() { coercions++; throw new Error('unexpected scalar coercion'); },
    valueOf() { coercions++; throw new Error('unexpected scalar coercion'); },
    toString() { coercions++; throw new Error('unexpected scalar coercion'); },
  };
  for (const field of ['startSec', 'durationSec']) {
    const h = harness({ forbidEffects: true });
    assert.equal((await h.call({ filePath: SOURCE_FILE, [field]: scalar })).ok, false);
    assert.equal(h.effects.length, 0);
  }
  assert.equal(coercions, 0);
});

test('omitted and undefined timing keep defaults and the default output path', async () => {
  for (const input of [{}, { startSec: undefined }, { durationSec: undefined }, { startSec: undefined, durationSec: undefined }]) {
    const h = harness();
    const { result, script } = await h.finish(h.call({ filePath: SOURCE_FILE, ...input }));
    assert.ok(script.includes('int(round(10 * fps))'));
    assert.ok(script.includes('int(round(3 * fps))'));
    assert.ok(script.includes('Preset="Slower", TFF=True'));
    assert.equal(result.mode, 'qtgmc_25p');
    assert.equal(result.durationSec, 3);
    assert.equal(result.warning, undefined);
    assert.equal(result.outputPath, '/sample-fixture/home/Movies/VapourSynth-OFX Samples/source_qtgmc_25p_rs.mov');
    assert.equal(h.effects.filter(e => e[0] === 'mkdirSync').length, 1);
  }
});

test('genuine zero starts survive all executable modes without becoming the default', async () => {
  for (const mode of EXEC_MODES) {
    for (const startSec of [0, -0]) {
      const h = harness();
      const { result, script } = await h.finish(h.call({ filePath: SOURCE_FILE, mode, startSec,
        durationSec: 2, outputPath: OUTPUT_FILE, preset: 'Fast', tff: false, rawScript: 'out = work # inert fixture' }));
      assert.ok(script.includes('int(round(0 * fps))'));
      assert.ok(!script.includes('int(round(10 * fps))'));
      assert.equal(result.durationSec, 2);
      assert.equal(result.warning, undefined);
      assert.equal(result.outputPath, OUTPUT_FILE);
      assert.equal(h.effects.some(e => e[0] === 'mkdirSync'), false);
      assert.ok(script.includes('Preset="Fast", TFF=False'));
    }
  }
  for (const startSec of [0, -0]) {
    const h = harness({ forbidEffects: true });
    const result = await h.call({ filePath: SOURCE_FILE, mode: 'raw_script', startSec,
      durationSec: 2, outputPath: OUTPUT_FILE, rawScript: 'out = work # inert fixture' });
    assert.equal(result.ok, false);
    assert.equal(result.error, RAW_SCRIPT_REFUSAL);
    assert.equal(h.effects.length, 0);
    assert.equal(h.spawns.length, 0);
  }
});

test('positive fractional timings reach each real script template unchanged', async () => {
  for (const mode of EXEC_MODES) {
    const h = harness();
    const { result, script } = await h.finish(h.call({ filePath: SOURCE_FILE, mode,
      startSec: 0.125, durationSec: 0.25, outputPath: OUTPUT_FILE }));
    assert.ok(script.includes('int(round(0.125 * fps))'));
    assert.ok(script.includes('int(round(0.25 * fps))'));
    if (mode === 'pal_recover_srestore') assert.ok(script.includes('int(round(0.25 * 25))'));
    assert.equal(result.durationSec, 0.25);
    assert.equal(result.warning, undefined);
  }
});

test('the existing 30-second clamp and warning remain intact in all executable modes', async () => {
  for (const mode of EXEC_MODES) {
    for (const durationSec of [30, 30.5, 100, Number.MAX_VALUE]) {
      const h = harness();
      const { result, script } = await h.finish(h.call({ filePath: SOURCE_FILE, mode,
        durationSec, outputPath: OUTPUT_FILE }));
      assert.equal(result.durationSec, 30);
      assert.ok(script.includes('int(round(30 * fps))'));
      if (mode === 'pal_recover_srestore') assert.ok(script.includes('int(round(30 * 25))'));
      assert.equal(result.warning, durationSec === 30 ? undefined
        : `durationSec ${durationSec} exceeds the 30s sample limit — rendered 30s instead`);
    }
  }
});

test('finite timing extremes do not acquire an invented upper start or lower duration cap', async () => {
  const h = harness();
  const { result, script } = await h.finish(h.call({ filePath: SOURCE_FILE,
    startSec: Number.MAX_VALUE, durationSec: Number.MIN_VALUE, outputPath: OUTPUT_FILE }));
  assert.ok(script.includes(`int(round(${Number.MAX_VALUE} * fps))`));
  assert.ok(script.includes(`int(round(${Number.MIN_VALUE} * fps))`));
  assert.equal(result.durationSec, Number.MIN_VALUE);
  assert.equal(result.warning, undefined);
});

test('valid scalars retain existing missing-source and unknown-mode refusals', async () => {
  for (const input of [{ filePath: '/sample-fixture/missing.mov' }, { filePath: SOURCE_FILE, mode: 'unknown' }]) {
    const h = harness();
    const result = await h.call(input);
    assert.equal(result.ok, false);
    assert.match(result.error, /source file not found|unknown mode/);
    assert.equal(h.spawns.length, 0);
    assert.ok(h.effects.every(e => e[0] === 'existsSync'));
  }
});

test('the advertised timing schema matches the consumer without rejecting clamped durations', () => {
  const h = harness({ forbidEffects: true });
  const schema = h.api.TOOL_DEFINITIONS.find(d => d.name === 'render_sample').input_schema;
  assert.equal(schema.properties.startSec.type, 'number');
  assert.equal(schema.properties.startSec.minimum, 0);
  assert.equal(schema.properties.startSec.maximum, undefined);
  assert.equal(schema.properties.durationSec.type, 'number');
  assert.equal(schema.properties.durationSec.exclusiveMinimum, 0);
  assert.equal(schema.properties.durationSec.maximum, undefined);
  assert.ok(schema.properties.startSec.description.includes('Default 10'));
  assert.ok(schema.properties.durationSec.description.includes('Default 3'));
  assert.ok(!schema.required.includes('startSec'));
  assert.ok(!schema.required.includes('durationSec'));
  assert.equal(h.effects.length, 0);
});
