// Filter-schema contract tests — the schema system is the ONE source driving
// filter controls, so it must be internally valid and its emissions must
// match the templates the qualification harness verified. Static/fixture
// evidence only; no runtime evaluation here (that lives in
// scripts/qualify_filters.py).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function load(relative, dependencies = {}) {
  const filename = path.join(__dirname, '..', 'shared', relative);
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports,
    require(name) { if (name in dependencies) return dependencies[name]; throw new Error(`unadmitted import: ${name}`); },
  }, { filename, timeout: 1000 });
  return module.exports;
}

const cst = load('cst-transform.ts');
const draftComposer = load('draft-composer.ts');
const { FILTER_SCHEMAS, stepMatchesSchema, schemaDefaults } = load('filter-schemas.ts', {
  './cst-transform': cst, './draft-composer': draftComposer });

test('every schema is internally valid with meaningful help and safe ranges', () => {
  for (const [type, schema] of Object.entries(FILTER_SCHEMAS)) {
    assert.equal(schema.type, type);
    assert.ok(schema.label, `${type}: label required`);
    assert.ok(schema.purpose.length > 20, `${type}: purpose must be a real sentence`);
    assert.ok(schema.params.length >= 1, `${type}: at least one parameter`);
    const seen = new Set();
    for (const p of schema.params) {
      assert.ok(!seen.has(p.key), `${type}.${p.key}: duplicate`);
      seen.add(p.key);
      assert.ok(p.label && p.help.length > 20, `${type}.${p.key}: label and a REAL help sentence required`);
      assert.ok(p.default !== undefined, `${type}.${p.key}: default required`);
      if (p.kind === 'enum') assert.ok((p.options ?? []).length >= 2, `${type}.${p.key}: enum needs options`);
      if (p.kind === 'range' || p.kind === 'number') {
        assert.ok(typeof p.min === 'number' && typeof p.max === 'number' && p.max > p.min, `${type}.${p.key}: min<max required`);
        const d = Number(p.default);
        assert.ok(d >= p.min && d <= p.max, `${type}.${p.key}: default within range`);
      }
    }
  }
});

test('schema emissions match the FILTER-LIBRARY qualified template bodies', () => {
  // The library templates were qualified 25/25 through the runtime harness;
  // schema.emit must reproduce the exact same call for default params.
  const libSource = fs.readFileSync(path.join(__dirname, '../src/components/FilterLibrary.tsx'), 'utf8');
  for (const [type, schema] of Object.entries(FILTER_SCHEMAS)) {
    if (type === 'qtgmc') continue;   // QTGMC's typed panel is the QTGMCPanel path
    // Extract the template body from the library entry with this label.
    const marker = `label: '${schema.label}'`;
    assert.ok(libSource.includes(marker), `${type}: library entry with label "${schema.label}" required`);
    // Default-params emission must contain the same core call as the template.
    const defaults = {};
    for (const p of schema.params) defaults[p.key] = p.default;
    const emitted = schema.emit(defaults);
    const template = schema.template();
    // Extract the core call (first non-comment line) from both and compare.
    const core = (s) => s.split('\n').filter(l => l && !l.trim().startsWith('#'))[0]?.trim();
    assert.equal(core(emitted), core(template), `${type}: default emission ≠ qualified template core call`);
  }
});

test('stepMatchesSchema: generated form matches; hand-edited code is CUSTOM', () => {
  const schema = FILTER_SCHEMAS.cas;
  const params = { sharpness: 0.4 };
  assert.equal(stepMatchesSchema(schema, params, schema.template()), true);
  assert.equal(stepMatchesSchema(schema, params, 'clip = clip  # hand-tuned'), false);
  // Param change without code regen = custom (stale code vs new params).
  assert.equal(stepMatchesSchema(schema, { sharpness: 0.7 }, schema.template()), false);
  assert.equal(stepMatchesSchema(null, params, 'x'), false);
});

// C07 (re-review of c11a43d, 2026-11-11): schemaDefaults must yield the
// COMPLETE default set — the seeded form of a freshly added step — and it
// must equal the verified CST default params so the initial template reads
// as the schema form (not CUSTOM). The panel-level first-edit regression
// lives in __test_cst_controls.js.
test('schemaDefaults: complete set, equals the verified CST defaults, matches the template (C07)', () => {
  const d = schemaDefaults('cst');
  // CST_DEFAULT_PARAMS additionally carries a display label (metadata, not a
  // schema param) — compare the parameter payload. Spread into this realm so
  // the comparison is between plain objects (the VM module has its own
  // Object.prototype, which strict deep-equality treats as significant).
  const { label: _label, ...cstDefaults } = { ...cst.CST_DEFAULT_PARAMS };
  assert.deepEqual({ ...d }, cstDefaults,
    'schemaDefaults(cst) must equal the independently maintained CST defaults');
  const schema = FILTER_SCHEMAS.cst;
  const templateCode = `# ${schema.label}: ${schema.purpose}\n${cst.cstTemplateBody()}`;
  assert.equal(stepMatchesSchema(schema, d, templateCode), true,
    'seeded defaults match the initial template form');
  for (const p of schema.params) {
    assert.ok(p.key in d, `default for ${p.key} present`);
  }
  assert.ok(Object.keys(schemaDefaults('qtgmc')).length >= 4, 'qtgmc defaults seeded too');
  assert.deepEqual({ ...schemaDefaults('no-such-schema') }, {},
    'unknown schema yields no defaults');
});

// C-unresize (2026-11-11): the DATAFLOW validation — Debicubic must see the
// FULL-RESOLUTION samples (it reconstructs the pre-upscale sampling from
// them). The old emission resized the clip DOWN to the target first and then
// descaled at the same dimensions — a no-op double step that discarded the
// high-resolution information before the inverse filter ran.
test('unresize dataflow: descale runs on full-res samples; only format converts', () => {
  const s = FILTER_SCHEMAS.unresize_debicubic;
  const out = s.emit({ width: 320, height: 240 });
  const resizeArgs = out.match(/core\.resize\.Bicubic\(([^)]*)\)/);
  assert.ok(resizeArgs, 'format-conversion resize present');
  assert.ok(resizeArgs[1].includes('format=vs.YUV444PS'), 'format conversion kept');
  assert.ok(!resizeArgs[1].includes('width=') && !resizeArgs[1].includes('height='),
    'NO pre-resize: the descale must receive the full-resolution clip');
  assert.ok(out.includes(', width=320, height=240)'),
    'Debicubic targets are the true pre-upscale dimensions');
  assert.equal(stepMatchesSchema(s, { width: 320, height: 240 }, s.template()), true,
    'the template matches the schema emission');
});

test('QTGMC schema emission mirrors the native composer argument forms', () => {
  const s = FILTER_SCHEMAS.qtgmc;
  const native = fs.readFileSync(path.join(__dirname, '../../common/filters/filter_qtgmc.cpp'), 'utf8');
  // The native composer's emission strings the schema must reproduce.
  assert.ok(native.includes('TFF='), 'native TFF= emission');
  assert.ok(native.includes('FPSDivisor='), 'native FPSDivisor= emission');
  assert.ok(native.includes('Preset=\''), 'native Preset emission');
  const out = s.emit({ preset: 'Slower', tff: true, fpsDivisor: '2' });
  assert.ok(out.includes("Preset='Slower'"), 'preset string emission');
  assert.ok(out.includes('TFF=True'), 'python boolean True');
  assert.ok(out.includes('FPSDivisor=2'), 'fpsDivisor single-rate');
  // fidelity: 1 (bob) doubles the frame count — enum carries the warning.
  const div = s.params.find(p => p.key === 'fpsDivisor');
  assert.ok(div && div.help.includes('doubled rate'), 'fpsDivisor help must state the timeline consequence');
});