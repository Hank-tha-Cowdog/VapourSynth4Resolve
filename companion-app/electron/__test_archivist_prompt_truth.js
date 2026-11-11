// Skippy prompt TRUTH contract tests — executes the REAL prompt builder.
//
// Covers the Priority-2 provider/tool honesty requirements:
//   1. TEXT-ONLY adapters (OpenAI/OpenRouter/LM Studio/Ollama — everything
//      with toolLoop:false, incl. Claude via OpenRouter) NEVER receive the
//      tool-use block; they get the truthful manual-paste path with its
//      prohibitions (never claim a chain change).
//   2. Tool-loop models get the propose_chain_edit block.
//   3. No stale categorical claims: the RIFE guidance defers to the LIVE
//      neural snapshot (both usable and not-usable phrasings), never a
//      hard-coded "not bundled" — and never silently substitutes BlockFPS.
//   4. knlm is NEVER recommended (OpenCL ICD absent on this Mac — crashes).
//   5. Chain-state order honesty: manual order lists the USER's order as the
//      execution order (no stage re-sort claimed); auto mode says sorted.
//   6. Saved-model recovery is a UI concern covered by __test_model_selection
//      (invalid ID → null → send blocked, draft kept); here we only assert
//      the prompt builds fine with no model selected (text-only default).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// ── Load the real prompt builder with its real (pure) dependencies ────────
function loadModule(rel, extraRequires = {}) {
  const filename = path.join(__dirname, '..', 'src', 'services', rel);
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(code, { module: mod, exports: mod.exports,
    require(name) {
      if (name in extraRequires) return extraRequires[name];
      if (name === './installed-plugins') return loadModule('installed-plugins.ts');
      if (name === './app-reference') return loadModule('app-reference.ts');
      if (name === './scan-verdict') return loadModule('scan-verdict.ts');
      if (name === '../types') return {};
      if (name === '../constants') return { STAGE_ORDER: [] };
      throw new Error(`unadmitted module request: ${name}`);
    },
  }, { filename, timeout: 2000 });
  return mod.exports;
}
const { buildArchivistSystemPrompt } = loadModule('archivist-prompt.ts');

const CM = { inputColorSpace: 'Rec.709', inputGamma: 'BT.1886',
  outputColorSpace: 'Rec.709', outputGamma: 'BT.1886', ocioConfig: 'studio' };
const step = (id, stage) => ({ id, type: 'script', stage, enabled: true, approved: true, version: 1,
  params: { code: 'clip = clip\n', label: id } });
const NS = new Set(['mv', 'bm3d', 'dfttest', 'cas', 'knlm']);

test('text-only adapters NEVER get tool-use instructions; they get the truthful manual path', () => {
  const p = buildArchivistSystemPrompt([step('s1', 40)], CM, undefined, NS, undefined,
    { toolLoop: false, manualOrder: false });
  assert.equal(p.includes('propose_chain_edit'), false,
    'text-only sessions must not be told a tool exists');
  assert.ok(p.includes('TEXT ONLY'), 'integration-mode banner present');
  assert.ok(p.includes('ready-to-paste'), 'manual paste path present');
  assert.ok(p.includes('Never claim you changed, added or updated the chain'),
    'the no-false-control prohibition is explicit');
  assert.ok(p.includes('fenced'), 'fenced-block proposal format described');
});

test('tool-loop models DO get the propose_chain_edit block', () => {
  const p = buildArchivistSystemPrompt([step('s1', 40)], CM, undefined, NS, undefined,
    { toolLoop: true, manualOrder: false });
  assert.ok(p.includes('propose_chain_edit'), 'tool block present');
  assert.ok(p.includes('TOOL USE'), 'tool section present');
  assert.equal(p.includes('TEXT ONLY'), false, 'no text-only banner for tool sessions');
});

test('no stale categorical RIFE claims — the live snapshot governs both ways', () => {
  const usable = buildArchivistSystemPrompt([], CM, undefined, NS,
    { rife: { level: 'inference', usable: true, detail: 'ORT_CPU inference verified', backend: 'ORT_CPU', model: 'rife-v4' } },
    { toolLoop: true, manualOrder: false });
  assert.ok(usable.includes('NEURAL INTERPOLATION (RIFE): AVAILABLE'), 'usable snapshot surfaces');
  assert.ok(usable.includes('vsmlrt.RIFE'), 'RIFE may be proposed when usable');
  const notUsable = buildArchivistSystemPrompt([], CM, undefined, NS,
    { rife: { level: 'weights', usable: false, detail: 'weights not installed' } },
    { toolLoop: true, manualOrder: false });
  assert.ok(notUsable.includes('RIFE): NOT USABLE RIGHT NOW'), 'not-usable snapshot surfaces');
  assert.ok(notUsable.includes('never silently substitute'),
    'never silently substitute BlockFPS for a RIFE request');
  // The STALE categorical phrasing must be gone from the tool rules:
  assert.equal(usable.includes("RIFE isn't bundled"), false,
    'no hard-coded "RIFE isn\'t bundled" — the snapshot is the authority');
  assert.equal(notUsable.includes('core.rife` / `core.mlrt'), false,
    'no categorical rife/mlrt ban that would contradict a usable snapshot');
});

test('knlm is never recommended (OpenCL ICD absent on this Mac)', () => {
  const p = buildArchivistSystemPrompt([], CM, undefined, NS, undefined,
    { toolLoop: true, manualOrder: false });
  assert.ok(p.includes('NEVER `core.knlm`'), 'explicit never-knlm warning');
  assert.ok(p.includes('OpenCL ICD'), 'the real reason is stated');
  // It must NOT appear in the recommended denoise chain (before the NEVER clause):
  const denoise = p.match(/- \*\*Denoise\*\*:[^\n]*/)?.[0] ?? '';
  const recommendation = denoise.split('NEVER')[0];
  assert.equal(recommendation.includes('knlm'), false, 'knlm absent from recommendations');
  assert.ok(denoise.includes('dfttest'), 'a working alternative is recommended');
});

test('chain-state order honesty: manual order is the EXECUTION order, never claimed stage-sorted', () => {
  // Manual order with stages out of order (70 before 20):
  const manual = buildArchivistSystemPrompt([step('sA', 70), step('sB', 20)], CM,
    undefined, NS, undefined, { toolLoop: true, manualOrder: true });
  assert.ok(manual.includes('USER-DEFINED MANUAL ORDER'), 'manual banner');
  assert.ok(manual.includes('NOT re-sorted'), 'no stage re-sort claim');
  const aIdx = manual.indexOf('sA'), bIdx = manual.indexOf('sB');
  assert.ok(aIdx >= 0 && bIdx >= 0 && aIdx < bIdx,
    'listing preserves the USER order (70-stage step listed first)');
  const auto = buildArchivistSystemPrompt([step('sA', 70), step('sB', 20)], CM,
    undefined, NS, undefined, { toolLoop: true, manualOrder: false });
  assert.ok(auto.includes('stage-sorted execution order'), 'auto banner');
  const a2 = auto.indexOf('sA'), b2 = auto.indexOf('sB');
  assert.ok(a2 >= 0 && b2 >= 0 && b2 < a2, 'auto mode sorts by stage (20 first)');
});

test('default (no model context) is text-only — never accidental tool claims', () => {
  const p = buildArchivistSystemPrompt([], CM, undefined, NS, undefined);
  assert.equal(p.includes('propose_chain_edit'), false,
    'an unselected model defaults to the honest text-only path');
});

test('apply-semantics states are present (saved ≠ applied ≠ rendered)', () => {
  const p = buildArchivistSystemPrompt([], CM, undefined, NS, undefined,
    { toolLoop: true, manualOrder: false });
  assert.ok(p.includes('config-apply-refused'), 'refused state explained');
  assert.ok(p.includes('Never claim an edit landed'), 'no false success claims');
});
test('saved-model recovery: a missing saved id is NEVER silently substituted', () => {
  // Contract (App.tsx:126): resolve by exact id ?? null — no fallback to
  // another model. ArchivistChat then blocks send with the honest
  // "Saved model unavailable" message and keeps the draft.
  const app = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'App.tsx'), 'utf8');
  const resolveLine = app.split('\n').find(l => l.includes('LLM_MODELS.find(m => m.id === config.archivist.selectedModelId)'));
  assert.ok(resolveLine, 'saved-model resolution line present');
  assert.ok(resolveLine.includes('?? null'), 'resolution falls to null, never to a substitute model');
  assert.ok(!/\?\? LLM_MODELS\[0\]/.test(resolveLine), 'no silent default-model substitution');
  const chat = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'components', 'ArchivistChat.tsx'), 'utf8');
  assert.ok(chat.includes('Saved model unavailable in this build'), 'honest missing-model message');
  assert.ok(chat.includes('Your draft is kept'), 'draft preserved, not dropped');
});
