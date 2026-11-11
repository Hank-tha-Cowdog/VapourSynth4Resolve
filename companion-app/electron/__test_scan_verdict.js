// Scan-authority reconciliation (correctness review "Scan authority" + handoff
// 03_PRIORITIES: "resolve the idet-versus-heuristic scan authority
// discrepancy"). The reconciled contract — idet ≥ 0.9 is DECISIVE pixel
// evidence; heuristics may surface a suspicion but cannot flip it — while
// the heuristic override keeps flipping weaker/absent pixel evidence (the
// canonical SD-broadcast-transcoded-as-progressive case).
//
// Loads the REAL scan-verdict.ts (type-only import; no runtime deps).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const file = path.join(__dirname, '../src/services/scan-verdict.ts');
const module_ = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText, { module: module_, exports: module_.exports,
  require() { throw new Error('scan-verdict must stay dependency-free at runtime'); },
}, { filename: file, timeout: 1000 });
const { deriveScanVerdict, analyzeHeuristics } = module_.exports;

// The reviewer's synthetic: SD provenance signals stacked past 0.7 for
// interlaced, idet at 99% confidence says progressive.
const sdInterlacedSignals = {
  height: 480, sampleAspectRatio: '10:11', fps: 29.97,
  colorSpace: 'smpte170m', mediainfo: { scanTypeOriginal: 'Interlaced' },
};

test('reconciliation: a DECISIVE idet reading (>= 0.9) stands — heuristics record a suspicion, not a flip', () => {
  const v = { ...sdInterlacedSignals, detectedScanType: 'progressive', scanConfidence: 0.99 };
  const h = analyzeHeuristics(v);
  assert.ok(h.interlacedScore >= 0.7, `heuristics must strongly oppose (got ${h.interlacedScore})`);
  const verdict = deriveScanVerdict(v);
  assert.ok(verdict);
  assert.equal(verdict.scanType, 'Progressive', 'pixel evidence is authoritative under the idet-first contract');
  assert.equal(verdict.authority, 'idet');
  assert.equal(verdict.confidence, 'medium', 'contested but decisive: honest medium, not spotted-suspected');
  assert.equal(verdict.disagreement, 'major', 'the suspicion is still surfaced');
  assert.match(verdict.explanation, /PIXEL EVIDENCE STANDS/);
  assert.match(verdict.explanation, /SUSPICION/);
});

test('the heuristic override still flips WEAKER pixel evidence (idet >= 0.8 but < 0.9)', () => {
  const v = { ...sdInterlacedSignals, detectedScanType: 'progressive', scanConfidence: 0.85 };
  const verdict = deriveScanVerdict(v);
  assert.ok(verdict);
  assert.equal(verdict.scanType, 'Interlaced', 'sub-decisive pixel evidence can be overridden');
  assert.equal(verdict.authority, 'heuristic');
  assert.equal(verdict.confidence, 'suspected');
  assert.equal(verdict.disagreement, 'major');
});

test('the motivating SD-transcode case still flips: MediaInfo-progressive, no idet, strong SD heuristics', () => {
  const v = {
    height: 480, sampleAspectRatio: '10:11', fps: 29.97, colorSpace: 'smpte170m',
    mediainfo: { scanType: 'Progressive', scanOrder: 'None', scanTypeOriginal: 'Interlaced' },
  };
  const verdict = deriveScanVerdict(v);
  assert.ok(verdict);
  assert.equal(verdict.scanType, 'Interlaced');
  assert.equal(verdict.authority, 'heuristic');
  assert.equal(verdict.confidence, 'suspected');
  assert.match(verdict.explanation, /HEURISTIC OVERRIDE/);
});

test('agreement stays clean: decisive idet + non-contradicting heuristics is high/none', () => {
  // Mild signals only (height 1080 alone = 0.10) so the heuristic verdict is
  // simply SILENT — the clean agreement path that earns 'high'.
  const v = { height: 1080,
    detectedScanType: 'progressive', scanConfidence: 0.97 };
  const verdict = deriveScanVerdict(v);
  assert.ok(verdict);
  assert.equal(verdict.scanType, 'Progressive');
  assert.equal(verdict.authority, 'idet');
  assert.equal(verdict.confidence, 'high');
  assert.equal(verdict.disagreement, 'none');
  assert.match(verdict.explanation, /Primary source: idet at 97% confidence/);
});

test('decisive idet stays decisive even when heuristics say progressive the other way', () => {
  const v = { height: 1080, fps: 23.976, colorSpace: 'bt709',
    detectedScanType: 'interlaced', scanConfidence: 0.95 };
  const verdict = deriveScanVerdict(v);
  assert.ok(verdict);
  assert.equal(verdict.scanType, 'Interlaced', 'decisive pixels win in both directions');
  assert.equal(verdict.authority, 'idet');
});
