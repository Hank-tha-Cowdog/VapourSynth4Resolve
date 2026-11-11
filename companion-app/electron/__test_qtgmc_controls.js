// Actual QTGMC form, fake events/state and React SSR. Native generator is read as
// static consumer evidence only; no C++/Python/filters, App, Electron, media or IPC.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const server = require('react-dom/server');
const icons = require(path.join(__dirname, '../node_modules/lucide-react'));
const source = fs.readFileSync(path.join(__dirname, '../src/filter-panels/QTGMCPanel.tsx'), 'utf8');
const nativeSource = fs.readFileSync(path.join(__dirname, '../../common/filters/filter_qtgmc.cpp'), 'utf8');
const forbidden = () => assert.fail('No real UI event, native/filter/provider/IPC/media/timer operation');
const code = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.React, esModuleInterop: true,
} }).outputText;
function load(react) {
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports,
    require(name) {
      if (name === 'react') return react;
      if (name === 'lucide-react') return icons;
      return forbidden();
    }, window: new Proxy({}, { get: forbidden }), setTimeout: forbidden, setInterval: forbidden,
  }, { timeout: 1000 });
  return module.exports.QTGMCPanel;
}
function find(tree, predicate) {
  if (!React.isValidElement(tree)) return [];
  return [...(predicate(tree) ? [tree] : []), ...React.Children.toArray(tree.props.children).flatMap(child => find(child, predicate))];
}
function form(params = Object.freeze({}), advanced = false, onWrite) {
  const values = [advanced, null], writes = [];
  let hook = 0;
  const Panel = load({ ...React, useId: () => 'synthetic-panel',
    useState() {
      const index = hook++; assert(index < 2);
      return [values[index], next => { values[index] = typeof next === 'function' ? next(values[index]) : next; }];
    },
  });
  function view() {
    hook = 0;
    const tree = Panel({ params, onChange: next => {
      writes.push(next); params = Object.freeze({ ...next }); if (onWrite) onWrite(next);
    } });
    assert.equal(hook, 2);
    const bySuffix = suffix => find(tree, e => typeof e.props.id === 'string' && e.props.id.endsWith(suffix))[0];
    const choice = label => {
      const row = find(tree, e => typeof e.type === 'function' && e.props.label === label)[0]; assert(row);
      return find(row.type(row.props), e => e.type === 'select')[0];
    };
    return { tree, noise: choice('Noise processing'), preset: choice('Preset'), label: bySuffix('-label'),
      labelClear: bySuffix('-label-clear'),
      advanced: bySuffix('-advanced'), toggle: find(tree, e => e.type === 'button' && e.props['aria-controls'])[0],
      alert: find(tree, e => e.props.role === 'alert')[0],
      numeric(label) {
        const row = find(tree, e => typeof e.type === 'function' && e.props.label === label)[0]; assert(row);
        // Actual NumRow event parser, with fake hooks; no browser event is sent.
        return find(row.type(row.props), e => e.type === 'input')[0];
      },
      numericAuto(label) {
        const row = find(tree, e => typeof e.type === 'function' && e.props.label === label)[0]; assert(row);
        return find(row.type(row.props), e => e.type === 'button' && e.props['aria-label'] === `Use Auto for ${label}`)[0];
      },
      choice,
    };
  }
  return { view, writes, params: () => params, feedback: () => values[1] };
}
function markup(params, advanced = false, count = 1, feedback = null) {
  // State is controlled for the selected presentation; useId is the real React
  // hook, invoked by actual React SSR across multiple concurrently rendered forms.
  const Panel = load({ ...React, useState: initial => [typeof initial === 'boolean' ? advanced : feedback, forbidden] });
  return server.renderToStaticMarkup(React.createElement(React.Fragment, null,
    ...Array.from({ length: count }, (_, i) => React.createElement(Panel, { key: i, params, onChange: forbidden }))));
}
const event = value => ({ target: { value } });
const presets = ['Placebo', 'Very Slow', 'Slower', 'Slow', 'Medium', 'Fast', 'Faster', 'Draft', 'Ultra Fast'];
const boundedTunings = [
  { label: 'Lossless', key: 'lossless', choices: [0, 1, 2], unsupported: 3 },
  { label: 'SourceMatch', key: 'sourceMatch', choices: [0, 1, 2, 3], unsupported: 4 },
];
function selectMarkup(html, label) {
  const id = html.match(new RegExp(`<label[^>]*for="([^"]+)"[^>]*>${label}</label>`))?.[1]; assert(id);
  const start = html.indexOf(`<select id="${id}"`); assert(start >= 0);
  const end = html.indexOf('</select>', start); assert(end > start); return html.slice(start, end + 9);
}

test('QTGMC controls offer every native whitelisted preset including a saved Ultra Fast selection', () => {
  const whitelist = nativeSource.match(/kPresets\[\]\s*=\s*\{([\s\S]*?)\};/); assert(whitelist);
  const native = Array.from(whitelist[1].matchAll(/"([^"]+)"/g), match => match[1]);
  assert.deepEqual(native, presets); // Static C++ text, not a compiled composer oracle.
  const h = form(Object.freeze({ preset: 'Ultra Fast' }));
  assert.deepEqual(React.Children.toArray(h.view().preset.props.children).map(e => e.props.value), presets);
  assert.equal(h.view().preset.props.value, 'Ultra Fast');
  assert(markup({ preset: 'Ultra Fast' }).includes('<option value="Ultra Fast" selected="">Ultra Fast</option>'));
  h.view().preset.props.onChange(event('Ultra Fast')); assert.equal(h.writes[0].preset, 'Ultra Fast');
});

test('QTGMC controls explicit noise modes preserve numeric zero one and two with unrelated parameters', () => {
  assert(nativeSource.includes('if (np >= 0 && np <= 2) call << ", NoiseProcess=" << np;'));
  for (const mode of [0, 1, 2]) {
    const params = Object.freeze({ preset: 'Fast', tff: false, lossless: 0, customField: 'synthetic' });
    const before = JSON.stringify(params), h = form(params, true);
    h.view().noise.props.onChange(event(String(mode)));
    assert.deepEqual({ ...h.writes[0] }, { ...params, noiseProcess: mode });
    assert.equal(typeof h.writes[0].noiseProcess, 'number'); assert.equal(JSON.stringify(params), before);
    assert(markup({ noiseProcess: mode }, true).includes(`<option value="${mode}" selected="">`));
  }
});

test('QTGMC controls auto omits NoiseProcess while merely opening or reading the form never assigns a mode', () => {
  const empty = Object.freeze({ preset: 'Slower' }), h = form(empty);
  assert.equal(h.view().noise.props.value, ''); assert.equal(h.writes.length, 0);
  assert.equal(h.view().advanced.props.hidden, true); h.view().toggle.props.onClick();
  assert.equal(h.view().advanced.props.hidden, false); assert.equal(h.writes.length, 0);
  assert.equal(h.view().toggle.props['aria-expanded'], true); h.view().toggle.props.onClick();
  assert.equal(h.view().advanced.props.hidden, true); assert.equal(h.writes.length, 0);
  const saved = form(Object.freeze({ noiseProcess: 0, preset: 'Placebo', customField: 'synthetic' }), true);
  saved.view().noise.props.onChange(event(''));
  assert(!Object.hasOwn(saved.writes[0], 'noiseProcess'));
  assert.deepEqual({ ...saved.writes[0] }, { preset: 'Placebo', customField: 'synthetic' });
});

test('QTGMC controls editing another field keeps an explicit zero and invalid synthetic noise options do not write', () => {
  const params = Object.freeze({ noiseProcess: 0, label: 'Old', preset: 'Ultra Fast' }), h = form(params);
  h.view().label.props.onChange(event('Synthetic new label'));
  assert.equal(h.writes[0].noiseProcess, 0); assert.equal(h.writes[0].preset, 'Ultra Fast');
  assert.equal(h.writes[0].label, 'Synthetic new label');
  for (const value of ['3', '-1', '0.5', 'false', 'synthetic']) h.view().noise.props.onChange(event(value));
  assert.equal(h.writes.length, 1); assert.equal(params.label, 'Old');
});

test('QTGMC controls label every actual input and select with unique real React IDs across multiple forms', () => {
  const html = markup({ noiseProcess: 0, preset: 'Ultra Fast' }, true, 2);
  const ids = Array.from(html.matchAll(/\bid="([^"]+)"/g), m => m[1]);
  assert.equal(new Set(ids).size, ids.length);
  const labels = Array.from(html.matchAll(/<label\b[^>]*\bfor="([^"]+)"/g), m => m[1]);
  const controls = Array.from(html.matchAll(/<(?:input|select)\b[^>]*\bid="([^"]+)"/g), m => m[1]);
  assert.equal(controls.length, 26); assert.equal(labels.length, controls.length);
  for (const id of controls) assert.equal(labels.filter(label => label === id).length, 1);
  for (const match of html.matchAll(/aria-describedby="([^"]+)"/g)) for (const id of match[1].split(' ')) assert(ids.includes(id));
    assert.equal(Array.from(html.matchAll(/aria-describedby=/g)).length, 16); // Noise + seven tuning hints per form.
});

test('QTGMC controls advanced disclosure targets a persistent region in both states without changing parameters', () => {
  for (const expanded of [false, true]) {
    const params = Object.freeze({ noiseProcess: 2 }), h = form(params, expanded), v = h.view();
    assert.equal(v.toggle.props.type, 'button'); assert.equal(v.toggle.props['aria-expanded'], expanded);
    assert.equal(v.toggle.props['aria-controls'], v.advanced.props.id); assert.equal(v.advanced.props.hidden, !expanded);
    assert.equal(v.noise.props['aria-describedby'], 'synthetic-panel-hint');
    const html = markup(params, expanded);
    assert(html.includes('aria-controls=')); assert.equal(html.includes('hidden=""'), !expanded);
    assert(html.includes('other smoothing settings still apply')); assert.equal(h.writes.length, 0);
  }
});

test('QTGMC noise conflict rejects either newly conflicting edit without parent writes or silently clearing values', () => {
  for (const [initial, field] of [[{ ezDenoise: 2 }, 'EZKeepGrain'], [{ ezKeepGrain: 2 }, 'EZDenoise']]) {
    const params = Object.freeze({ ...initial, preset: 'Fast', noiseProcess: 0 }), before = JSON.stringify(params);
    const h = form(params, true); h.view().numeric(field).props.onChange(event('1.5'));
    assert.equal(h.writes.length, 0); assert.equal(JSON.stringify(params), before); assert.equal(h.params(), params);
    assert(h.feedback().includes('Change not applied.')); assert(h.view().alert);
    assert.equal(h.view().numeric(field).props.value, '');
    assert.equal(h.view().numeric(field).props['aria-invalid'], undefined);
    assert(h.view().numeric(field).props['aria-describedby'].includes('synthetic-panel-setting-error'));
    assert(markup(h.params(), true, 1, h.feedback()).includes('Change not applied.'));
  }
});

test('QTGMC noise conflict clearing the old control permits the alternative and clears rejected-edit feedback', () => {
  const h = form(Object.freeze({ ezDenoise: 2, preset: 'Ultra Fast', noiseProcess: 0 }), true);
  h.view().numeric('EZKeepGrain').props.onChange(event('3')); assert.equal(h.writes.length, 0);
  h.view().numeric('EZDenoise').props.onChange(event(''));
  assert.equal(h.writes.length, 1); assert(!Object.hasOwn(h.params(), 'ezDenoise')); assert.equal(h.feedback(), null);
  h.view().numeric('EZKeepGrain').props.onChange(event('3'));
  assert.equal(h.writes.length, 2); assert.equal(h.params().ezKeepGrain, 3); assert(!Object.hasOwn(h.params(), 'ezDenoise'));
  assert.equal(h.params().noiseProcess, 0); assert.equal(h.params().preset, 'Ultra Fast'); assert(!h.view().alert);
});

test('QTGMC noise conflict exposes saved conflicts and lets clearing or zeroing either field preserve the other value', () => {
  for (const clear of ['EZDenoise', 'EZKeepGrain']) for (const repair of ['', '0']) {
    const params = Object.freeze({ ezDenoise: 2, ezKeepGrain: 3, noiseProcess: 0 }), h = form(params);
    assert(h.view().alert); assert.equal(h.writes.length, 0); assert.equal(h.params(), params);
    assert.equal(h.view().numeric('EZDenoise').props['aria-invalid'], true);
    assert.equal(h.view().numeric('EZKeepGrain').props['aria-invalid'], true);
    const html = markup(params); assert(html.includes('Saved settings have positive values for both'));
    assert(html.includes('hidden=""')); // The notice remains outside the collapsed region.
    h.view().noise.props.onChange(event('0')); assert.equal(h.writes.length, 0); // Native check precedes NoiseProcess handling.
    h.view().numeric(clear).props.onChange(event(repair));
    assert.equal(h.writes.length, 1);
    const repairedKey = clear === 'EZDenoise' ? 'ezDenoise' : 'ezKeepGrain';
    if (repair === '') assert(!Object.hasOwn(h.params(), repairedKey));
    else { assert(Object.hasOwn(h.params(), repairedKey)); assert.equal(h.params()[repairedKey], 0); }
    assert.equal(h.params()[clear === 'EZDenoise' ? 'ezKeepGrain' : 'ezDenoise'], clear === 'EZDenoise' ? 3 : 2);
    assert(!h.view().alert); assert.equal(params.ezDenoise, 2); assert.equal(params.ezKeepGrain, 3);
  }
});

test('QTGMC noise conflict permits zero with a positive alternative and does not assign or erase unrelated fields', () => {
  for (const initial of [{ ezDenoise: 0, ezKeepGrain: 3 }, { ezDenoise: 2, ezKeepGrain: 0 }]) {
    const params = Object.freeze({ ...initial, customField: 'synthetic' }), h = form(params, true);
    h.view().label.props.onChange(event('Synthetic label'));
    assert.equal(h.writes.length, 1); assert.equal(h.params().ezDenoise, initial.ezDenoise);
    assert.equal(h.params().ezKeepGrain, initial.ezKeepGrain); assert.equal(h.params().customField, 'synthetic');
    assert(!Object.hasOwn(h.params(), 'noiseProcess')); assert(!h.view().alert);
  }
});

test('QTGMC noise conflict saved-error descriptions target each form uniquely and guidance no longer implies combining controls', () => {
  const html = markup({ ezDenoise: 2, ezKeepGrain: 3 }, true, 2);
  const ids = Array.from(html.matchAll(/\bid="([^"]+)"/g), m => m[1]);
  assert.equal(new Set(ids).size, ids.length); assert.equal((html.match(/role="alert"/g) || []).length, 2);
  const invalid = Array.from(html.matchAll(/<input\b[^>]*aria-invalid="true"[^>]*>/g), m => m[0]);
  assert.equal(invalid.length, 4);
  for (const input of invalid) {
    const description = input.match(/aria-describedby="([^"]+)"/); assert(description);
    const refs = description[1].split(' '); assert.equal(refs.length, 2);
    assert(refs.every(id => ids.includes(id))); assert(refs[1].endsWith('-setting-error'));
  }
  assert(html.includes('Mutually exclusive with positive EZKeepGrain.') && html.includes('Mutually exclusive with positive EZDenoise.'));
  assert(!html.includes('Retain this much grain after EZDenoise'));
});

test('QTGMC bounded tunings expose exactly Auto and the existing supported integer choices', () => {
  assert(nativeSource.includes('if (ll >= 0 && ll <= 2) call << ", Lossless=" << ll;'));
  assert(nativeSource.includes('if (sm >= 1 && sm <= 3) call << ", SourceMatch=" << sm;'));
  // SourceMatch=0 retains the existing UI/default-omission behavior; no C++ or Python executes.
  for (const field of boundedTunings) {
    const h = form(Object.freeze({}), true), control = h.view().choice(field.label);
    assert.equal(control.props.value, ''); assert.equal(h.writes.length, 0);
    assert.deepEqual(React.Children.toArray(control.props.children).map(e => e.props.value), ['', ...field.choices.map(String)]);
    assert.equal(control.props['aria-invalid'], undefined);
    assert(selectMarkup(markup({}, true), field.label).includes('<option value="" selected="">'));
  }
});

test('QTGMC bounded tunings write numeric choices including explicit zero without changing unrelated parameters', () => {
  for (const field of boundedTunings) for (const choice of field.choices) {
    const params = Object.freeze({ noiseProcess: 0, tff: false, customField: 'synthetic' }), before = JSON.stringify(params);
    const h = form(params, true); h.view().choice(field.label).props.onChange(event(String(choice)));
    assert.equal(h.writes.length, 1); assert.deepEqual({ ...h.params() }, { ...params, [field.key]: choice });
    assert.equal(typeof h.params()[field.key], 'number'); assert.equal(JSON.stringify(params), before);
    assert.equal(h.view().choice(field.label).props.value, String(choice));
    assert(selectMarkup(markup(h.params(), true), field.label).includes(`<option value="${choice}" selected="">`));
  }
});

test('QTGMC bounded tunings refuse invalid or fractional tokens without truncation or parent writes', () => {
  for (const field of boundedTunings) {
    const params = Object.freeze({ [field.key]: 1 }), h = form(params, true);
    for (const token of [String(field.unsupported), '-1', '1.9', '01', 'unsupported', 'synthetic']) {
      h.view().choice(field.label).props.onChange(event(token));
    }
    assert.equal(h.writes.length, 0); assert.equal(h.params(), params);
    assert.equal(h.view().choice(field.label).props.value, '1');
  }
});

test('QTGMC bounded tunings identify unsupported saved values without displaying raw data or rewriting them', () => {
  const secret = 'synthetic-untrusted-value-' + 'x'.repeat(5000);
  for (const field of boundedTunings) for (const value of [field.unsupported, -1, 1.5, '1', Object.freeze({ tag: secret }), secret]) {
    const params = Object.freeze({ [field.key]: value }), h = form(params, true), control = h.view().choice(field.label);
    assert.equal(control.props.value, 'unsupported'); assert.equal(control.props['aria-invalid'], true);
    assert.equal(h.writes.length, 0); assert.equal(h.params(), params);
    const placeholder = React.Children.toArray(control.props.children).find(e => e.props.value === 'unsupported');
    assert.equal(placeholder.props.disabled, true);
    const html = markup(params, true), block = selectMarkup(html, field.label);
    const option = block.match(/<option[^>]*value="unsupported"[^>]*>/)?.[0]; assert(option);
    assert(option.includes('disabled=""') && option.includes('selected=""'));
    assert(html.includes(`${field.label} has an unrecognized saved value.`));
    assert(!html.includes(secret));
  }
});

test('QTGMC bounded tunings explicitly repair saved unsupported values through Auto or zero and preserve the original', () => {
  for (const field of boundedTunings) for (const repair of ['', '0']) {
    const params = Object.freeze({ [field.key]: field.unsupported, customField: 'synthetic', noiseProcess: 0 });
    const h = form(params, true); h.view().choice(field.label).props.onChange(event(repair));
    assert.equal(h.writes.length, 1); assert.equal(h.params().customField, 'synthetic'); assert.equal(h.params().noiseProcess, 0);
    if (repair === '') assert(!Object.hasOwn(h.params(), field.key));
    else { assert(Object.hasOwn(h.params(), field.key)); assert.equal(h.params()[field.key], 0); }
    assert.equal(h.view().choice(field.label).props.value, repair);
    assert.equal(h.view().choice(field.label).props['aria-invalid'], undefined);
    assert.equal(params[field.key], field.unsupported);
  }
});

test('QTGMC bounded tunings connect per-field saved-value errors with unique real React IDs across forms', () => {
  const html = markup({ lossless: 7, sourceMatch: 'synthetic' }, true, 2);
  const ids = Array.from(html.matchAll(/\bid="([^"]+)"/g), m => m[1]); assert.equal(new Set(ids).size, ids.length);
  assert.equal((html.match(/role="alert"/g) || []).length, 4);
  const invalid = Array.from(html.matchAll(/<select\b[^>]*aria-invalid="true"[^>]*>/g), m => m[0]);
  assert.equal(invalid.length, 4);
  for (const control of invalid) {
    const refs = control.match(/aria-describedby="([^"]+)"/)[1].split(' '); assert.equal(refs.length, 2);
    assert(refs.every(id => ids.includes(id))); assert(refs[1].endsWith('-error'));
  }
});

const numericFields = [
  { key: 'sharpness', label: 'Sharpness', initial: 1, valid: [['.5', .5], ['0', 0], ['-1.25', -1.25], ['1e2', 100], ['1.2345678901234567', 1.2345678901234567]], invalid: [] },
  { key: 'tr2', label: 'TR2', initial: 2, valid: [['1e2', 100], ['1.0', 1], ['0', 0], ['-2', -2], ['-2147483648', -2147483648], ['2147483647', 2147483647]], invalid: ['1.9', '-2147483649', '2147483648'] },
  { key: 'thSad2', label: 'ThSAD2', initial: 96, valid: [['1', 1], ['9.6e1', 96], ['2147483647', 2147483647]], invalid: ['1.9', '0', '-1', '2147483648'] },
  { key: 'ezDenoise', label: 'EZDenoise', initial: 2, valid: [['0', 0], ['1.5', 1.5]], invalid: ['-1'] },
  { key: 'ezKeepGrain', label: 'EZKeepGrain', initial: 2, valid: [['0', 0], ['1.5', 1.5]], invalid: ['-1'] },
];
const selectorFields = [
  { key: 'preset', label: 'Preset', token: 'Draft', value: 'Draft', invalid: 'unknown', defaultToken: 'Slower' },
  { key: 'tff', label: 'Field order', token: 'bff', value: false, invalid: 'false', defaultToken: 'tff' },
  { key: 'fpsDivisor', label: 'Output rate', token: '1', value: 1, invalid: '1', defaultToken: '2' },
  { key: 'inputType', label: 'Input type', token: '3', value: 3, invalid: '1', defaultToken: '0' },
  { key: 'noiseProcess', label: 'Noise processing', token: '0', value: 0, invalid: '0', defaultToken: '', auto: true },
  { key: 'sourceMatch', label: 'SourceMatch', token: '0', value: 0, invalid: '0', defaultToken: '', auto: true },
  { key: 'lossless', label: 'Lossless', token: '0', value: 0, invalid: '0', defaultToken: '', auto: true },
];

test('QTGMC numeric edits accept complete decimals and exponents and serialize finite typed values', () => {
  for (const field of numericFields) for (const [token, expected] of field.valid) {
    const params = Object.freeze({ [field.key]: field.initial, custom: 'synthetic' }), h = form(params, true);
    h.view().numeric(field.label).props.onChange(event(token));
    assert.equal(h.writes.length, 1); assert.equal(h.params()[field.key], expected);
    assert.equal(typeof h.params()[field.key], 'number'); assert(Number.isFinite(h.params()[field.key]));
    assert.equal(JSON.parse(JSON.stringify(h.params()))[field.key], expected);
    assert.equal(params[field.key], field.initial); assert.equal(h.params().custom, 'synthetic');
  }
});

test('QTGMC numeric edits refuse prefixes fractions overflow and nonfinite tokens without clearing old values', () => {
  for (const field of numericFields) {
    const params = Object.freeze({ [field.key]: field.initial }), h = form(params, true);
    for (const token of ['1junk', '1e', 'NaN', 'Infinity', '1e309', '0x10', ' ', '+', '--1', ...field.invalid]) {
      h.view().numeric(field.label).props.onChange(event(token));
      assert.equal(h.writes.length, 0, `${field.label}: ${token}`); assert.equal(h.params(), params);
      assert.equal(h.view().numeric(field.label).props.value, field.initial); assert(h.feedback().startsWith('Change not applied.'));
    }
    assert(markup(h.params(), true, 1, h.feedback()).includes('Change not applied.'));
  }
});

test('QTGMC numeric empty badInput is refused while an intentional empty edit alone selects Auto', () => {
  for (const field of numericFields) {
    const params = Object.freeze({ [field.key]: field.initial, untouched: '' }), h = form(params, true);
    h.view().numeric(field.label).props.onChange({ target: { value: '', validity: { badInput: true } } });
    assert.equal(h.writes.length, 0); assert.equal(h.params(), params); assert(h.feedback());
    h.view().numeric(field.label).props.onChange({ target: { value: '', validity: { badInput: false } } });
    assert.equal(h.writes.length, 1); assert(!Object.hasOwn(h.params(), field.key));
    assert(Object.hasOwn(h.params(), 'untouched')); assert.equal(h.params().untouched, ''); assert.equal(h.feedback(), null);
  }
});

test('QTGMC numeric saved invalid values use fixed feedback without coercion raw disclosure or opening writes', () => {
  const secret = 'synthetic-numeric-private-' + 'x'.repeat(5000);
  const trap = Object.freeze({ toString() { assert.fail('Do not coerce saved objects'); }, tag: secret });
  for (const field of numericFields) for (const value of ['2', null, '', NaN, Infinity, -Infinity, trap, secret,
    ...(field.key === 'tr2' || field.key === 'thSad2' ? [1.5, 4294967297] : []),
    ...(field.key === 'thSad2' ? [0, -1] : []), ...(field.key.startsWith('ez') ? [-1] : [])]) {
    const params = Object.freeze({ [field.key]: value }), h = form(params), input = h.view().numeric(field.label);
    assert.equal(input.props.value, ''); assert.equal(input.props.placeholder, 'Unrecognized saved value');
    assert.equal(input.props['aria-invalid'], true); assert.equal(h.writes.length, 0); assert.equal(h.params(), params);
    assert.equal(h.view().numericAuto(field.label).props.type, 'button');
    const html = markup(params); assert(html.includes('Open Advanced to review')); assert(html.includes(`${field.label} has an unrecognized saved value.`));
    assert(html.includes(`aria-label="Use Auto for ${field.label}"`));
    assert(!html.includes(secret));
  }
});

test('QTGMC numeric Auto and explicit repairs preserve untouched own values separately from normal JSON semantics', () => {
  const nested = Object.freeze({ keep: 'synthetic', empty: '' });
  for (const field of numericFields) for (const token of ['', String(field.initial)]) {
    const params = Object.freeze({ [field.key]: 'unrecognized', blank: '', absent: undefined, nil: null, zero: 0, off: false, nested });
    const h = form(params, true);
    if (token === '') h.view().numericAuto(field.label).props.onClick();
    else h.view().numeric(field.label).props.onChange(event(token));
    assert.equal(h.writes.length, 1); const next = h.params();
    for (const key of ['blank', 'absent', 'nil', 'zero', 'off', 'nested']) { assert(Object.hasOwn(next, key)); assert.equal(next[key], params[key]); }
    if (token === '') assert(!Object.hasOwn(next, field.key)); else assert.equal(next[field.key], field.initial);
    const wire = JSON.parse(JSON.stringify(next)); assert(!Object.hasOwn(wire, 'absent'));
    assert.equal(wire.blank, ''); assert.equal(wire.nil, null); assert.equal(wire.zero, 0); assert.equal(wire.off, false);
    assert.equal(params[field.key], 'unrecognized');
  }
});

test('QTGMC selector defaults and numeric Auto never create settings merely by opening or expanding the form', () => {
  const params = Object.freeze({}), h = form(params);
  for (const field of selectorFields) assert.equal(h.view().choice(field.label).props.value, field.defaultToken);
  for (const field of numericFields) assert.equal(h.view().numeric(field.label).props.value, '');
  h.view().toggle.props.onClick(); h.view(); assert.equal(h.writes.length, 0); assert.equal(h.params(), params);
});

test('QTGMC all selector handlers write exact typed choices and reject unlisted tokens without coercion', () => {
  const trap = Object.freeze({ toString() { assert.fail('No event token coercion'); } });
  for (const field of selectorFields) {
    const params = Object.freeze({ untouched: '' }), h = form(params, true);
    for (const token of ['synthetic', '1.9', '01', 'unsupported', ' 0 ', trap]) h.view().choice(field.label).props.onChange(event(token));
    assert.equal(h.writes.length, 0);
    h.view().choice(field.label).props.onChange(event(field.token));
    assert.equal(h.writes.length, 1); assert.equal(h.params()[field.key], field.value);
    assert.equal(typeof h.params()[field.key], typeof field.value); assert.equal(h.params().untouched, '');
    assert(Object.hasOwn(h.params(), 'untouched')); assert.equal(h.params()[field.key], JSON.parse(JSON.stringify(h.params()))[field.key]);
  }
});

test('QTGMC core selectors accept every declared typed option without assigning other defaults', () => {
  const fixtures = [
    ['Preset', 'preset', presets.map(value => [value, value])],
    ['Field order', 'tff', [['tff', true], ['bff', false]]],
    ['Output rate', 'fpsDivisor', [['1', 1], ['2', 2]]],
    ['Input type', 'inputType', [['0', 0], ['1', 1], ['2', 2], ['3', 3]]],
  ];
  for (const [label, key, choices] of fixtures) for (const [token, expected] of choices) {
    const h = form(Object.freeze({ untouched: '' })); h.view().choice(label).props.onChange(event(token));
    assert.equal(h.writes.length, 1); assert.deepEqual({ ...h.params() }, { untouched: '', [key]: expected });
    assert(selectMarkup(markup(h.params()), label).includes(`<option value="${token}" selected="">`));
  }
});

test('QTGMC every selector flags saved unsupported types and uses fixed nondisclosing selected placeholders', () => {
  const secret = 'synthetic-select-private-' + 'x'.repeat(5000);
  const trap = Object.freeze({ toString() { assert.fail('Do not stringify saved objects'); }, tag: secret });
  for (const field of selectorFields) for (const value of [field.invalid, null, '', trap, secret]) {
    const params = Object.freeze({ [field.key]: value }), h = form(params), control = h.view().choice(field.label);
    assert.equal(control.props.value, 'unsupported'); assert.equal(control.props['aria-invalid'], true);
    assert.equal(h.writes.length, 0); assert.equal(h.params(), params);
    const html = markup(params, true), block = selectMarkup(html, field.label);
    assert(block.includes('value="unsupported"')); assert(block.includes('selected=""'));
    assert(html.includes(`${field.label} has an unrecognized saved value.`)); assert(!html.includes(secret));
  }
});

test('QTGMC explicit selector repairs and Auto change only the selected key including boolean false and numeric zero', () => {
  for (const field of selectorFields) for (const token of [field.token, ...(field.auto ? [''] : [])]) {
    const params = Object.freeze({ [field.key]: field.invalid, blank: '', absent: undefined, nil: null, zero: 0, off: false });
    const h = form(params, true); h.view().choice(field.label).props.onChange(event(token));
    assert.equal(h.writes.length, 1);
    for (const key of ['blank', 'absent', 'nil', 'zero', 'off']) { assert(Object.hasOwn(h.params(), key)); assert.equal(h.params()[key], params[key]); }
    if (token === '') assert(!Object.hasOwn(h.params(), field.key)); else assert.equal(h.params()[field.key], field.value);
    assert.equal(params[field.key], field.invalid);
  }
});

test('QTGMC malformed saved field order remains explicitly repairable in progressive mode', () => {
  const h = form(Object.freeze({ inputType: 1, tff: 'false', label: 'synthetic' }));
  assert.equal(h.view().choice('Field order').props.disabled, false);
  h.view().choice('Field order').props.onChange(event('bff'));
  assert.equal(h.writes.length, 1); assert.equal(h.params().tff, false); assert.equal(h.params().inputType, 1);
  assert.equal(h.view().choice('Field order').props.disabled, true);
  h.view().choice('Field order').props.onChange(event('tff')); assert.equal(h.writes.length, 1);
});

test('QTGMC label invalid state and explicit label clears do not disclose saved objects or normalize other fields', () => {
  const secret = 'synthetic-label-private'; const params = Object.freeze({ label: Object.freeze({ tag: secret }), untouched: '', absent: undefined });
  const h = form(params); assert.equal(h.view().label.props.value, ''); assert.equal(h.view().label.props['aria-invalid'], true);
  assert(!markup(params).includes(secret)); assert.equal(h.writes.length, 0);
  assert.equal(h.view().labelClear.props.type, 'button'); assert(markup(params).includes('aria-label="Clear label"'));
  h.view().labelClear.props.onClick(); assert.equal(h.writes.length, 1); assert(!Object.hasOwn(h.params(), 'label'));
  h.view().label.props.onChange(event('Synthetic label')); assert.equal(h.params().label, 'Synthetic label');
  h.view().label.props.onChange(event('')); assert(!Object.hasOwn(h.params(), 'label'));
  assert.equal(h.params().untouched, ''); assert(Object.hasOwn(h.params(), 'absent')); assert.equal(params.label.tag, secret);
});

test('QTGMC progressive Lossless conflict refuses either introducing edit without changing its counterpart', () => {
  for (const lossless of [1, 2]) for (const direction of ['lossless', 'inputType']) {
    const params = Object.freeze(direction === 'lossless' ? { inputType: 1, lossless: 0 } : { inputType: 0, lossless });
    const h = form(params, true); h.view().choice(direction === 'lossless' ? 'Lossless' : 'Input type').props.onChange(event(String(direction === 'lossless' ? lossless : 1)));
    assert.equal(h.writes.length, 0); assert.equal(h.params(), params); assert(h.feedback().includes('Positive Lossless cannot be combined'));
    assert(h.view().alert); assert(markup(h.params(), true, 1, h.feedback()).includes('Change not applied.'));
  }
});

test('QTGMC saved progressive Lossless conflict is visible collapsed and permits only explicit Auto zero or mode repair', () => {
  for (const [label, token] of [['Lossless', ''], ['Lossless', '0'], ['Input type', '0'], ['Input type', '2'], ['Input type', '3']]) {
    const params = Object.freeze({ inputType: 1, lossless: 2, custom: 'synthetic', blank: '' }), h = form(params);
    assert(h.view().alert); assert.equal(h.writes.length, 0); assert.equal(h.view().advanced.props.hidden, true);
    assert.equal(h.view().choice('Lossless').props['aria-invalid'], true); assert.equal(h.view().choice('Input type').props['aria-invalid'], true);
    const html = markup(params); assert(html.includes('Saved settings combine positive Lossless'));
    assert(html.indexOf('Saved settings combine positive Lossless') < html.indexOf('hidden=""'));
    h.view().choice(label).props.onChange(event(token)); assert.equal(h.writes.length, 1); assert(!h.view().alert);
    if (label === 'Lossless') { assert.equal(h.params().inputType, 1); if (token === '') assert(!Object.hasOwn(h.params(), 'lossless')); else assert.equal(h.params().lossless, 0); }
    else { assert.equal(h.params().lossless, 2); assert.equal(h.params().inputType, Number(token)); }
    assert.equal(h.params().custom, 'synthetic'); assert.equal(h.params().blank, ''); assert.equal(params.lossless, 2);
  }
});

test('QTGMC two independent saved conflicts have sequential explicit repair paths in either order', () => {
  for (const first of ['noise', 'lossless']) {
    const params = Object.freeze({ inputType: 1, lossless: 2, ezDenoise: 2, ezKeepGrain: 3, untouched: '' }), h = form(params);
    const repair = kind => kind === 'noise' ? h.view().numeric('EZDenoise').props.onChange(event('0')) : h.view().choice('Lossless').props.onChange(event('0'));
    repair(first); assert.equal(h.writes.length, 1); assert(h.view().alert);
    repair(first === 'noise' ? 'lossless' : 'noise'); assert.equal(h.writes.length, 2); assert(!h.view().alert);
    assert.equal(h.params().ezDenoise, 0); assert.equal(h.params().lossless, 0); assert.equal(h.params().ezKeepGrain, 3);
    assert.equal(h.params().inputType, 1); assert.equal(h.params().untouched, ''); assert.equal(params.lossless, 2);
  }
});

test('QTGMC saved numeric and cross-field feedback references real unique IDs and TR2 guidance states its dependency', () => {
  const html = markup({ inputType: 1, lossless: 2, thSad2: '96' }, true, 2);
  const ids = Array.from(html.matchAll(/\bid="([^"]+)"/g), m => m[1]); assert.equal(new Set(ids).size, ids.length);
  for (const match of html.matchAll(/aria-describedby="([^"]+)"/g)) for (const id of match[1].split(' ')) assert(ids.includes(id));
  assert.equal((html.match(/aria-invalid="true"/g) || []).length, 6);
  assert(html.includes('At SourceMatch Auto/0, the preset radius is used.'));
  assert(html.includes('Advanced settings contain unrecognized saved values.'));
});

function loadLocal(relative, dependencies) {
  const filename = path.join(__dirname, '../src', relative), module = { exports: {} };
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.React, esModuleInterop: true,
  } }).outputText;
  vm.runInNewContext(output, { module, exports: module.exports,
    require(name) { assert(Object.hasOwn(dependencies, name), `Unadmitted local UI dependency: ${name}`); return dependencies[name]; },
    window: new Proxy({}, { get: forbidden }), setTimeout: forbidden, setInterval: forbidden,
  }, { filename, timeout: 1000 });
  return module.exports;
}
// The real shared draft-composer (pure; no deps) — ChainEditor's approval
// click/badge route through it (content-bound approval, 2026-11-11).
const draftComposerModule = (() => {
  const filename = path.join(__dirname, '../shared/draft-composer.ts'), module = { exports: {} };
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.React, esModuleInterop: true,
  } }).outputText;
  vm.runInNewContext(output, { module, exports: module.exports,
    require(name) { assert.fail(`Unadmitted shared dependency: ${name}`); },
  }, { filename, timeout: 1000 });
  return module.exports;
})();
function chainForm(initial) {
  let chain = initial, writes = 0;
  const controlledReact = { ...React,
    useState: initial => [typeof initial === 'function' ? initial() : initial, forbidden],
    useRef: value => ({ current: value }), useEffect() {}, // This test does not run the expansion lifecycle.
  };
  const { ChainEditor } = loadLocal('components/ChainEditor.tsx', {
    react: controlledReact, 'lucide-react': icons,
    '../constants': loadLocal('constants.ts', { 'lucide-react': icons }), '../types': loadLocal('types.ts', {}),
    '../services/chain-expansion': loadLocal('services/chain-expansion.ts', {}),
    './PythonEditor': { PythonEditor: forbidden }, '../filter-panels/QTGMCPanel': { QTGMCPanel: load(React) },
    './FilterParamsPanel': { FilterParamsPanel: () => React.createElement('span', { 'data-schema-fixture': 'true' }) },
    '../../shared/filter-schemas': { FILTER_SCHEMAS: {}, stepMatchesSchema: () => false },
    '../../shared/draft-composer': draftComposerModule,
  });
  const tree = ChainEditor({ chain, manualOrder: false, setManualOrder: forbidden, onChange: next => { chain = next; writes++; } });
  const card = find(tree, e => e.props.step?.id === 'qtgmc' && typeof e.props.onParamsChange === 'function')[0]; assert(card);
  const cardTree = card.type(card.props);
  const editor = find(cardTree, e => e.props.step?.id === 'qtgmc' && typeof e.props.onChange === 'function')[0]; assert(editor);
  const panel = editor.type(editor.props); assert.equal(panel.props.params, initial.find(step => step.id === 'qtgmc').params);
  return { form: form(panel.props.params, true, panel.props.onChange), chain: () => chain, writes: () => writes };
}
function syntheticChain() {
  return Object.freeze([
    Object.freeze({ id: 'other', type: 'script', stage: 50, enabled: false, approved: false, params: Object.freeze({ code: '# synthetic, never executed', blank: '' }) }),
    Object.freeze({ id: 'qtgmc', type: 'qtgmc', stage: 20, enabled: false, approved: false, mix: .75,
      params: Object.freeze({ noiseProcess: 0, tff: false, sourceMatch: 3, lossless: 0, blank: '', absent: undefined, nil: null, nested: Object.freeze({ keep: 'synthetic' }) }) }),
  ]);
}

test('QTGMC actual ChainEditor params callback preserves whole-chain flags order and finite values through ordinary JSON serialization', () => {
  const initial = syntheticChain(), h = chainForm(initial);
  h.form.view().numeric('ThSAD2').props.onChange(event('9.6e1'));
  h.form.view().choice('Input type').props.onChange(event('2'));
  assert.equal(h.writes(), 2); assert.equal(h.chain()[0], initial[0]);
  const edited = h.chain()[1]; assert.equal(edited.enabled, false); assert.equal(edited.approved, false); assert.equal(edited.mix, .75);
  assert.equal(edited.params.thSad2, 96); assert.equal(edited.params.inputType, 2); assert.equal(edited.params.noiseProcess, 0); assert.equal(edited.params.tff, false);
  assert(Object.hasOwn(edited.params, 'absent')); assert.equal(edited.params.blank, ''); assert.equal(edited.params.nested, initial[1].params.nested);
  const config = { session: 'synthetic', chain: h.chain(), unrelated: { keep: false } }, wire = JSON.parse(JSON.stringify(config));
  assert.deepEqual(wire.chain.map(step => step.id), ['other', 'qtgmc']); assert.equal(wire.chain[0].params.blank, '');
  assert.equal(wire.chain[1].params.thSad2, 96); assert.equal(wire.chain[1].params.inputType, 2); assert.equal(wire.chain[1].params.lossless, 0);
  assert.equal(wire.chain[1].params.nil, null); assert.equal(wire.chain[1].params.blank, ''); assert(!Object.hasOwn(wire.chain[1].params, 'absent'));
  assert.equal(wire.chain[1].enabled, false); assert.equal(wire.chain[1].approved, false); assert.equal(wire.unrelated.keep, false);
  assert(!Object.hasOwn(initial[1].params, 'thSad2'));
});

test('QTGMC actual ChainEditor callback sees no invalid numeric edit and only the explicitly selected Auto key disappears', () => {
  const initial = syntheticChain(), h = chainForm(initial);
  h.form.view().numeric('ThSAD2').props.onChange(event('96.9')); assert.equal(h.writes(), 0); assert.equal(h.chain(), initial);
  h.form.view().choice('Noise processing').props.onChange(event('')); assert.equal(h.writes(), 1);
  const params = h.chain()[1].params; assert(!Object.hasOwn(params, 'noiseProcess')); assert.equal(params.lossless, 0); assert.equal(params.sourceMatch, 3);
  assert.equal(params.tff, false); assert.equal(params.blank, ''); assert(Object.hasOwn(params, 'absent')); assert.equal(h.chain()[0], initial[0]);
});
