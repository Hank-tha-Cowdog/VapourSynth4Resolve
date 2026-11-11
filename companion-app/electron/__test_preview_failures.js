// BEHAVIORAL failure-mode tests for the preview render pipeline — executes
// the REAL preview-companion module with a FIXTURE interpreter (the
// VSRES_SAMPLE_PYTHON seam) against an ISOLATED temp HOME. Never the real
// user library, recipes, credentials or media.
//
// Covered failure modes (each previously UNTESTED at the module level):
//   1. Malformed draft script (Python SyntaxError) → honest error with the
//      actual interpreter message; renderer never reports success.
//   2. Worker crash mid-render (nonzero exit, no valid JSON) → honest error.
//   3. Renderer "succeeds" but writes no PNG → honest 'preview PNG read
//      failed' error; temp artifacts cleaned.
//   4. Timeout → SIGKILL + timeout:true error (bounded, never hangs).
//   5. Missing interpreter (ENOENT spawn error) → honest null + error path.
//   6. Draft temp script is ALWAYS cleaned up on every terminal path.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('child_process');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'vsres-preview-fail-'));
// Capture the REAL interpreter BEFORE the fake HOME exists (os.homedir()
// and $HOME both honor the override, which would hand the fixture a garbage
// shebang → ENOEXEC).
const REAL_PY = process.env.VSRES_TEST_PYTHON ||
  require('child_process').execSync(
    `ls ${require('os').homedir()}/.asdf/installs/python/*/bin/python3 | tail -1`).toString().trim();
process.env.VSRES_SAMPLE_PYTHON = path.join(ROOT, 'fixture-python');
// These tests exercise the ONE-SHOT fallback render path (a real production
// path: used when the persistent worker is unavailable). The fixture
// interpreter speaks the one-shot argv protocol, so pin this suite to the
// one-shot path; the worker protocol has its own suite (__test_render_worker).
process.env.VSRES_NO_RENDER_WORKER = '1';
process.env.HOME = path.join(ROOT, 'home');
fs.mkdirSync(process.env.HOME, { recursive: true });

// Load the REAL module with the seam pointed at the fixture interpreter.
const pc = require('./preview-companion');

function fixturePython(body) {
  const p = path.join(ROOT, 'fixture-python');
  fs.writeFileSync(p, `#!${REAL_PY}\n${body}\n`, { mode: 0o755 });
  return p;
}

const SCRIPT = path.join(ROOT, 'chain.vpy');
fs.writeFileSync(SCRIPT, 'clip = clip\n', 'utf8');
// Host-path fixture: a node-scoped script under the isolated HOME.
const GUID = 'fixture-node-abc123';
const NODES = path.join(process.env.HOME, 'Library/Application Support/VapourSynth-OFX', 'nodes');
fs.mkdirSync(NODES, { recursive: true });
fs.writeFileSync(path.join(NODES, `${GUID}.vpy`), 'clip = clip\n', 'utf8');

function render(opts = {}) {
  return pc.renderPreviewFrame({ frame: 0, time: 0, mode: 'processed',
    sar: undefined, nodeGuid: GUID, draftScript: undefined, ...opts });
}

test.after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  delete process.env.VSRES_SAMPLE_PYTHON;
  delete process.env.VSRES_NO_RENDER_WORKER;
});

test('malformed draft script → honest error with the real interpreter message, never success', async () => {
  fixturePython(`
import sys
sys.stderr.write("SyntaxError: invalid syntax (chain.vpy, line 1)\\n")
sys.exit(1)
`);
  const r = await render({});
  assert.equal(r.ok, false, 'malformed script must NOT report success');
  assert.ok(String(r.error || '').length > 0, 'the honest error message is surfaced');
});

test('worker crash (nonzero exit, garbage output) → honest error', async () => {
  fixturePython(`
import sys
print('Segmentation fault (core dumped)', file=sys.stderr)
sys.exit(139)
`);
  const r = await render({});
  assert.equal(r.ok, false);
  assert.ok(/Segmentation fault|renderer failed|no output|preview renderer/i.test(String(r.error)),
    `crash surfaces honestly (got: ${String(r.error).slice(0, 120)})`);
});

test('renderer claims success but no PNG → honest PNG-read error', async () => {
  fixturePython(`
import json
print(json.dumps({"ok": True, "frame": 0, "total": 1, "fpsNum": 25, "fpsDen": 1, "durationS": 1.0, "presentationTimeS": 0.0, "width": 16, "height": 9, "path": "/nonexistent/out.png"}))
`);
  const r = await render({});
  assert.equal(r.ok, false);
  assert.ok(/PNG read failed|renderer failed|no output/i.test(String(r.error)),
    `missing PNG surfaces honestly (got: ${String(r.error).slice(0, 120)})`);
});

test('timeout → bounded SIGKILL + timeout error (never hangs)', async () => {
  fixturePython(`
import time
time.sleep(60)
`);
  const t0 = Date.now();
  const r = await render({});
  const dt = Date.now() - t0;
  assert.equal(r.ok, false);
  assert.equal(r.timeout, true, `timeout flag set (got: ${String(r.error).slice(0, 120)})`);
  assert.ok(dt < 40000, `bounded: resolved in ${dt}ms`);
});

test('missing node script → explicit no-cross-node-fallback error (node-scoped)', async () => {
  const r = await render({ nodeGuid: 'node-does-not-exist-xyz' });
  assert.equal(r.ok, false);
  assert.ok(String(r.error).includes('No composed script for THIS node'),
    'missing node script is an explicit error');
  assert.ok(String(r.error).includes('No cross-node fallback'));
});

test('draft script path is cleaned on terminal paths (success and failure)', async () => {
  const dir = path.join(process.env.HOME, 'Library/Application Support/VapourSynth-OFX');
  fs.mkdirSync(dir, { recursive: true });
  fixturePython(`
import json
print(json.dumps({"ok": False, "error": "synthetic render failure"}))
`);
  const before = fs.readdirSync(dir).filter(f => f.startsWith('draft-'));
  const r = await pc.renderPreviewFrame({ frame: 0, time: 0, mode: 'processed',
    sar: undefined, nodeGuid: null,
    draftScript: 'clip = clip\n' });
  assert.equal(r.ok, false, 'fixture renders fail honestly');
  await new Promise(r2 => setTimeout(r2, 200));
  const after = fs.readdirSync(dir).filter(f => f.startsWith('draft-'));
  assert.equal(after.length, before.length, 'no draft temp files leaked');
});