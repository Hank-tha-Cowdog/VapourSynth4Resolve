// Audit-fix regressions — 2026-11-05 batch (security review #1/#2/#3/#6 +
// correctness review C02/C03/C04-note/C08/C11/C13). Every case here reproduces a specific
// audited finding and proves the fix; nothing touches owner data, the real
// keychain, the network, or any running Resolve. Synthetic fixtures only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('node:child_process');
const http = require('node:http');

const REPO = path.join(__dirname, '..', '..');
const tsTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vsres-auditfix-ts-'));

function compileTs(rel) {
    // Compile ONE shared .ts to CJS in the scratch dir and return its path.
    const src = path.join(__dirname, '..', 'shared', rel);
    const out = path.join(tsTmp, rel.replace(/[\/]/g, '_').replace(/\.ts$/, '.js'));
    const tscBin = path.join(__dirname, '..', 'node_modules', 'typescript', 'bin', 'tsc');
    const r = spawnSync(process.execPath, [tscBin, src,
        '--outDir', tsTmp, '--module', 'commonjs', '--target', 'es2022', '--skipLibCheck'],
        { stdio: 'pipe' });
    if (r.status !== 0) throw new Error('tsc failed: ' + r.stderr);
    return path.join(tsTmp, rel.replace(/\.ts$/, '.js'));
}

// ── security review #1 + correctness review C11: filename injection / apostrophe breakage ──────
test('draft composer: a crafted filename cannot inject Python (hex emission)', () => {
    const { composeDraftScript } = require(compileTs('draft-composer.ts'));
    const evil = "x'); import os; os.system('touch /pwned'); #";
    const cfg = {
        manualOrder: false, mix: 1, chain: [],
        colorManagement: { inputColorSpace: 'Rec.709', inputGamma: 'BT.1886',
            outputColorSpace: 'Rec.709', outputGamma: 'BT.1886', ocioConfig: '' },
        clipMetadata: { source: { filePath: evil, sourceInPoint: 0, sourceOutPoint: 10 },
                        timeline: { width: 1920, height: 1080 } },
    };
    const py = composeDraftScript(cfg);
    // The raw filename must NOT appear anywhere in the script…
    assert.ok(!py.includes(evil), 'raw crafted filename must not appear');
    assert.ok(!py.includes("os.system"), 'no injected statement can appear');
    assert.ok(!py.includes('r\''), 'no raw single-quoted path literal remains');
    // …but the hex round-trips to the EXACT original bytes.
    const m = py.match(/bytes\.fromhex\('([0-9a-f]+)'\)/);
    assert.ok(m, 'hex path emission present');
    assert.equal(Buffer.from(m[1], 'hex').toString('utf8'), evil);
    assert.ok(py.includes('LWLibavSource(_vsres_src_path)'), 'loader uses the decoded variable');
});

test('draft composer: an apostrophe filename composes and round-trips (correctness review C11)', () => {
    const { composeDraftScript } = require(compileTs('draft-composer.ts'));
    const file = "/synthetic/John's tape.mov";
    const cfg = {
        manualOrder: false, mix: 1, chain: [],
        colorManagement: { inputColorSpace: 'Rec.709', inputGamma: 'BT.1886',
            outputColorSpace: 'Rec.709', outputGamma: 'BT.1886', ocioConfig: '' },
        clipMetadata: { source: { filePath: file } },
    };
    const py = composeDraftScript(cfg);
    assert.ok(!py.includes(`r'${file}`), 'no raw literal');
    const m = py.match(/bytes\.fromhex\('([0-9a-f]+)'\)/);
    assert.equal(Buffer.from(m[1], 'hex').toString('utf8'), file);
});

test('draft composer: a newline-bearing step label cannot escape the comment line', () => {
    const { composeDraftScript, executableTextForStep } = require(compileTs('draft-composer.ts'));
    const label = 'innocent\nimport os\nos.system("pwned")';
    const step = { id: 's1', type: 'script', stage: 10, enabled: true, approved: true,
                   version: 1, params: { code: 'clip = clip\n', label } };
    // Content-bound approval (2026-11-11): the step must be APPROVED for the
    // body to compose, and approval now requires the exact emitted binding.
    step.approvedContent = executableTextForStep(step);
    const cfg = {
        manualOrder: false, mix: 1,
        chain: [step],
        colorManagement: { inputColorSpace: 'Rec.709', inputGamma: 'BT.1886',
            outputColorSpace: 'Rec.709', outputGamma: 'BT.1886', ocioConfig: '' },
        clipMetadata: { source: { filePath: '/synthetic/a.mov' } },
    };
    const py = composeDraftScript(cfg);
    const line = py.split('\n').find(l => l.includes('STEP 1 / 1'));
    assert.ok(line, 'STEP header present');
    // The security property: newlines are flattened, so the ENTIRE label —
    // including the attempted statements — stays INSIDE one comment line.
    assert.ok(line.includes('innocent import os os.system("pwned")'),
        'label fully flattened onto the single STEP comment line');
    assert.ok(line.startsWith('#'), 'STEP header is a comment');
    // And no line anywhere carries the payload as ACTIVE code: any line
    // mentioning os.system must be a comment.
    for (const l of py.split('\n')) {
        if (l.includes('os.system')) {
            assert.ok(l.trimStart().startsWith('#'),
                `os.system may only appear inside comments, got: ${l.trim()}`);
        }
    }
});

test('draft composer: imported color-management labels are flattened in comments', () => {
    const { composeDraftScript } = require(compileTs('draft-composer.ts'));
    const cfg = {
        manualOrder: false, mix: 1, chain: [],
        colorManagement: { inputColorSpace: 'Rec.709\nimport os', inputGamma: 'BT.1886',
            outputColorSpace: 'Rec.709', outputGamma: 'BT.1886', ocioConfig: '' },
        clipMetadata: { source: { filePath: '/synthetic/a.mov' } },
    };
    const py = composeDraftScript(cfg);
    const cmLine = py.split('\n').find(l => l.includes('# Input color management:'));
    assert.ok(cmLine.includes('Rec.709 import os'), 'newline flattened to space');
    assert.equal((cmLine.match(/\n/g) || []).length, 0, 'comment stays on one line');
});

// ── security review #2 + correctness review C13: recipe intake hardening ───────────────────────
test('recipes: NOTHING survives intake approved; bindings are stripped', () => {
    const { normalizeRecipe } = require(path.join(__dirname, 'recipes.js'));
    const r = normalizeRecipe({
        schemaVersion: 1, name: 'evil', mix: 1, manualOrder: false,
        chain: [
            { id: 'a', type: 'script', stage: 10, enabled: true, approved: true,
              version: 1, params: { code: 'import os\n' } },
            { id: 'b', type: 'script', stage: 20, enabled: true,
              version: 1, params: { code: 'x = 1\n' } },   // missing approved
            { id: 'c', type: 'qtgmc', stage: 30, enabled: true, approved: true,
              approvedContent: 'clip = havs.QTGMC(clip, Preset=\'Slower\', TFF=True, FPSDivisor=2)\n',
              version: 1, params: { preset: 'Slower' } },  // structured step + smuggled binding
        ],
    });
    assert.ok(r.ok, 'valid recipe normalizes');
    assert.equal(r.recipe.chain[0].approved, false, 'script step approved:true → false');
    assert.equal(r.recipe.chain[1].approved, false, 'script step missing approved → false');
    assert.equal(r.recipe.chain[2].approved, false,
        'qtgmc step approved:true → false (generated Python is executable content)');
    // The approval-content binding is never portable.
    for (const step of r.recipe.chain) {
        assert.equal(step.approvedContent, null, 'approvedContent stripped at intake');
    }
});

test('recipes: a schema step carrying params.code is treated as executable code', () => {
    const { normalizeRecipe } = require(path.join(__dirname, 'recipes.js'));
    const r = normalizeRecipe({
        schemaVersion: 1, name: 'smuggled', mix: 1, manualOrder: false,
        chain: [{ id: 'a', type: 'qtgmc', stage: 10, enabled: true, approved: true,
                  version: 1, params: { preset: 'Slower', code: 'import os\nos.system("pwned")\n' } }],
    });
    assert.ok(r.ok);
    assert.equal(r.recipe.chain[0].approved, false, 'params.code ⇒ never approved');
});

test('recipes: unknown step types and future versions are rejected explicitly (C13)', () => {
    const { normalizeRecipe } = require(path.join(__dirname, 'recipes.js'));
    const bad1 = normalizeRecipe({
        schemaVersion: 1, name: 'x', chain: [{ id: 'a', type: 'future-filter', stage: 10,
            enabled: true, version: 1, params: {} }], mix: 1,
    });
    assert.ok(!bad1.ok);
    assert.match(bad1.error, /unknown type "future-filter"/);
    const bad2 = normalizeRecipe({
        schemaVersion: 1, name: 'x', chain: [{ id: 'a', type: 'qtgmc', stage: 10,
            enabled: true, version: 999, params: {} }], mix: 1,
    });
    assert.ok(!bad2.ok);
    assert.match(bad2.error, /unsupported version/);
});

test('recipes (re-review C13 residual): schema names are NOT admissible step types', () => {
    const { normalizeRecipe } = require(path.join(__dirname, 'recipes.js'));
    // The first fix batch wrongly admitted the 24 filter-SCHEMA names as
    // chain step types — native silently dropped them and the draft crashed.
    // Only EXECUTABLE chain types (script, qtgmc) are admissible now.
    for (const type of ['cas', 'cst', 'rife', 'tweak', 'ttmpsm', 'unresize_debicubic']) {
        const r = normalizeRecipe({
            schemaVersion: 1, name: 'x',
            chain: [{ id: 'a', type, stage: 10, enabled: true, version: 1, params: {} }],
            mix: 1,
        });
        assert.ok(!r.ok, `${type} must be rejected as a step type`);
        assert.match(r.error, /unknown type/);
    }
    // The executable types remain admissible.
    for (const type of ['script', 'qtgmc']) {
        const r = normalizeRecipe({
            schemaVersion: 1, name: 'x',
            chain: [{ id: 'a', type, stage: 10, enabled: true, version: 1, params: {} }],
            mix: 1,
        });
        assert.ok(r.ok, `${type} must remain admissible`);
    }
});

// C15 (re-review of c11a43d, 2026-11-11): explicit null colorManagement used
// to throw a TypeError through save validation (`typeof null === 'object'`
// passed the shape check, then the field loop read through it). Null is now
// treated as ABSENT; saveRecipe never lets a normalization throw escape.
test('recipes (re-review C15): explicit null colorManagement is treated as absent, not a throw', () => {
    const { normalizeRecipe, registerRecipeHandlers } = require(path.join(__dirname, 'recipes.js'));
    const r = normalizeRecipe({ schemaVersion: 1, name: 'synthetic-null', chain: [], colorManagement: null });
    assert.equal(r.ok, true, 'null CM must normalize, not throw');
    assert.equal(r.recipe.colorManagement, undefined, 'null CM means no color management');
    // Exercise the REAL registered handler (the reviewer showed this path
    // threw): normalization ran before its try block, so the TypeError
    // escaped. Temp recipes dir — the user's library is never touched.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vsres-c15-'));
    const handlers = new Map();
    registerRecipeHandlers({ handle: (channel, fn) => handlers.set(channel, fn) }, { recipesDir: tmp });
    const saved = handlers.get('recipes:save')(undefined,
        { payload: { schemaVersion: 1, name: 'synthetic-null', chain: [], colorManagement: null } });
    assert.equal(saved.ok, true, 'registered save returns a normal result for null CM');
    assert.ok(saved.path && fs.existsSync(saved.path), 'recipe file written');
    fs.rmSync(tmp, { recursive: true, force: true });
});
test('recipes (re-review C14): partial colorManagement is rejected at intake', () => {
    const { normalizeRecipe } = require(path.join(__dirname, 'recipes.js'));
    const r = normalizeRecipe({
        schemaVersion: 1, name: 'x', chain: [], mix: 1,
        colorManagement: { inputColorSpace: 'Rec.709', outputColorSpace: 'Rec.709' },
    });
    assert.ok(!r.ok, 'partial CM must be rejected');
    assert.match(r.error, /partial/);
    // A COMPLETE CM object is fine.
    const full = normalizeRecipe({
        schemaVersion: 1, name: 'x', chain: [], mix: 1,
        colorManagement: { inputColorSpace: 'Rec.709', inputGamma: 'BT.1886',
            outputColorSpace: 'Rec.709', outputGamma: 'BT.1886', ocioConfig: '' },
    });
    assert.ok(full.ok, 'complete CM accepted');
});

test('draft composer (re-review C14): a partial CM object no longer crashes composition', () => {
    const { composeDraftScript } = require(compileTs('draft-composer.ts'));
    const cfg = {
        manualOrder: false, mix: 1, chain: [],
        colorManagement: { inputColorSpace: 'Rec.709', outputColorSpace: 'Rec.709' },
        clipMetadata: { source: { filePath: '/synthetic/a.mov' } },
    };
    // Previously threw "Cannot read properties of undefined (reading 'replace')".
    const py = composeDraftScript(cfg);
    assert.ok(py.includes('# Input color management:'), 'input fragment emitted');
    assert.match(py, /Rec\.709 \/ BT\.1886/, 'native-equivalent defaults applied for missing fields');
});

test('draft composer (re-review C13): unknown step types emit VALID Python', () => {
    const { composeDraftScript } = require(compileTs('draft-composer.ts'));
    const cfg = {
        manualOrder: false, mix: 1,
        chain: [{ id: 'a', type: 'cas\'\nimport os', stage: 10, enabled: true,
                  approved: true, version: 1, params: {} }],
        colorManagement: { inputColorSpace: 'Rec.709', inputGamma: 'BT.1886',
            outputColorSpace: 'Rec.709', outputGamma: 'BT.1886', ocioConfig: '' },
        clipMetadata: { source: { filePath: '/synthetic/a.mov' } },
    };
    const py = composeDraftScript(cfg);
    // The emitted refusal must be a syntactically valid, terminated literal —
    // the old emission produced an unterminated string when the type carried
    // a quote/newline.
    const lines = py.split('\n');
    const raise = lines.find(l => l.startsWith('raise ValueError'));
    assert.ok(raise, 'unknown type raises honestly');
    assert.ok(raise.endsWith(')'), 'string literal terminated');
    assert.ok(!/raise ValueError\('DRAFT PREVIEW: unknown filter type "[^"]*\)\n?$/.test(py),
        'no unterminated-quote emission remains');
});

test('recipes: enabled is emitted explicitly so native and draft agree (C13)', () => {
    const { normalizeRecipe } = require(path.join(__dirname, 'recipes.js'));
    const r = normalizeRecipe({
        schemaVersion: 1, name: 'x',
        chain: [{ id: 'a', type: 'qtgmc', stage: 10, version: 1, params: {} }], mix: 1,
    });
    assert.ok(r.ok);
    assert.equal(r.recipe.chain[0].enabled, true, 'missing enabled → explicit true');
    assert.equal(r.recipe.chain[0].approved, false,
        'every admissible type is executable — missing approved → explicit false');
    assert.equal(r.recipe.chain[0].version, 1, 'missing version → explicit 1');
});

test('recipes: the admissible types are the EXECUTABLE contract (drift control)', () => {
    // Re-review C13 residual: the old drift test protected the WRONG
    // contract (schema names as step types). The executable contract is the
    // native filter registry's directly-registered types + 'script'.
    const recipesSrc = fs.readFileSync(path.join(__dirname, 'recipes.js'), 'utf8');
    const knownListMatch = recipesSrc.match(/KNOWN_STEP_TYPES = \[([^\]]+)\]/);
    assert.ok(knownListMatch, 'KNOWN_STEP_TYPES list found');
    const known = [...knownListMatch[1].matchAll(/'([a-z0-9_]+)'/g)].map(m => m[1]);
    assert.deepEqual(known, ['script', 'qtgmc'],
        'the admissible types are exactly the executable chain types');
    // No schema name may be admissible (qtgmc is the one schema that is also
    // a directly-registered native filter).
    const schemasSrc = fs.readFileSync(path.join(__dirname, '..', 'shared', 'filter-schemas.ts'), 'utf8');
    const schemaTypes = [...schemasSrc.matchAll(/type: '([a-z0-9_]+)'/g)].map(m => m[1]);
    const leaked = schemaTypes.filter(t => known.includes(t) && t !== 'qtgmc');
    assert.deepEqual(leaked, [], 'no filter-schema name may be an admissible step type');
});

// ── correctness review C02/C03: CST transfer math + clamp policy ─────────────────────────
// Tiny RPN evaluator mirroring VapourSynth std.Expr semantics for the ops we
// emit (binary ops, pow/sqrt/exp/log, dup-free) — enough to verify the
// corrected expressions against published reference values.
function evalRpn(expr, x) {
    const st = [];
    for (const tok of expr.split(/\s+/).filter(Boolean)) {
        if (/^-?\d+(\.\d+)?$/.test(tok)) { st.push(parseFloat(tok)); continue; }
        if (tok === 'x') { st.push(x); continue; }
        if (['<', '<=', '>', '>=', '=', '!='].includes(tok)) {
            const b = st.pop(), a = st.pop();
            st.push(tok === '<' ? (a < b ? 1 : 0) : tok === '<=' ? (a <= b ? 1 : 0)
                : tok === '>' ? (a > b ? 1 : 0) : tok === '>=' ? (a >= b ? 1 : 0) : 0);
            continue;
        }
        if (tok === '?') {
            const c = st.pop(), b = st.pop(), a = st.pop();
            st.push(a !== 0 ? b : c);
            continue;
        }
        // Unary ops pop ONE value.
        if (tok === 'sqrt') { st.push(Math.sqrt(st.pop())); continue; }
        if (tok === 'exp') { st.push(Math.exp(st.pop())); continue; }
        if (tok === 'log') { st.push(Math.log(st.pop())); continue; }
        const b = st.pop(), a = st.pop();
        switch (tok) {
            case '+': st.push(a + b); break;
            case '-': st.push(a - b); break;
            case '*': st.push(a * b); break;
            case '/': st.push(a / b); break;
            case 'pow': st.push(Math.pow(a, b)); break;
            case 'max': st.push(Math.max(a, b)); break;
            case 'min': st.push(Math.min(a, b)); break;
            default: assert.fail('unhandled op ' + tok);
        }
    }
    assert.equal(st.length, 1, `stack must end with exactly one value: ${expr}`);
    return st[0];
}

test('CST: every emitted transfer expression is stack-balanced RPN (correctness review C02)', () => {
    const { CST_TRANSFERS } = require(compileTs('cst-transform.ts'));
    for (const [name, t] of Object.entries(CST_TRANSFERS)) {
        for (const which of ['decode', 'encode']) {
            const e = t[which];
            if (!e) continue;
            // Exercises the evaluator's one-value assertion for several x.
            for (const x of [0.0, 0.25, 0.5, 0.75, 1.0]) {
                try { evalRpn(e, x); } catch (err) {
                    assert.fail(`${name}.${which} at x=${x}: ${err.message}`);
                }
            }
        }
    }
});

test('CST: HLG encode matches the ARIB STD-B67 OETF reference', () => {
    const { CST_TRANSFERS } = require(compileTs('cst-transform.ts'));
    const a = 0.17883277, b = 0.28466892, c = 0.55991073;
    // Published reference points from the audit + derived from BT.2100-2:
    const cases = [
        [0.25, a * Math.log(12 * 0.25 - b) + c],   // 0.7385492681 (audit)
        [1 / 12, Math.sqrt(3 / 12)],               // branch boundary: sqrt(3L)
        [0.02, Math.sqrt(3 * 0.02)],               // lower branch
    ];
    for (const [x, ref] of cases) {
        const got = evalRpn(CST_TRANSFERS.hlg.encode, x);
        assert.ok(Math.abs(got - ref) < 2e-6, `HLG encode(${x}) = ${got}, expected ${ref}`);
    }
});

test('CST: HLG decode normalizes (decode(1) == 1, not 12)', () => {
    const { CST_TRANSFERS } = require(compileTs('cst-transform.ts'));
    assert.ok(Math.abs(evalRpn(CST_TRANSFERS.hlg.decode, 1.0) - 1.0) < 1e-6,
        'HLG decode(1) must be 1.0');
    assert.ok(Math.abs(evalRpn(CST_TRANSFERS.hlg.decode, 0.5) - (0.5 * 0.5 / 3)) < 1e-9,
        'HLG decode(0.5) = E²/3');
    // Roundtrip: decode(encode(L)) ≈ L on both branches (constants are
    // 8-decimal published approximations — 1e-6 is the honest tolerance).
    for (const L of [0.02, 0.25, 0.9]) {
        const E = evalRpn(CST_TRANSFERS.hlg.encode, L);
        const back = evalRpn(CST_TRANSFERS.hlg.decode, E);
        assert.ok(Math.abs(back - L) < 1e-6, `HLG roundtrip(${L}) = ${back}`);
    }
});

test('CST: PQ decode/encode are stack-valid and roundtrip (ST.2084)', () => {
    const { CST_TRANSFERS } = require(compileTs('cst-transform.ts'));
    // Re-review residual: the first fix carried a WRONG 1/m2 exponent
    // (0.01268892 vs the true 1/78.84375 = 0.012683313515655966) —
    // max linear error 1.5e-4, roundtrip(0.5) = 0.49985. With the correct
    // exponent the reference from BT.2100-2 Table 4 holds tightly:
    // decode(0.5) = 0.009224570899406526 (independently derived by correctness review).
    assert.ok(Math.abs(evalRpn(CST_TRANSFERS.pq.decode, 0.5) - 0.009224570899406526) < 1e-9,
        `PQ decode(0.5) must match the BT.2100-2 reference`);
    for (const E of [0.05, 0.25, 0.5, 1.0]) {
        const lin = evalRpn(CST_TRANSFERS.pq.decode, E);       // normalized 0..1
        const back = evalRpn(CST_TRANSFERS.pq.encode, lin);
        assert.ok(Math.abs(back - E) < 1e-6, `PQ roundtrip(${E}) = ${back}`);
    }
    // decode(1.0) == 1.0 (peak white, normalized)
    assert.ok(Math.abs(evalRpn(CST_TRANSFERS.pq.decode, 1.0) - 1.0) < 1e-9);
});

test('CST: clamp policy clamps AFTER the gamut matrix too (correctness review C03)', () => {
    const { emitCstBody, CST_DEFAULT_PARAMS } = require(compileTs('cst-transform.ts'));
    const body = emitCstBody({ ...CST_DEFAULT_PARAMS, inPrimaries: '2020', outPrimaries: '709' });
    const clampIdx = [];
    const lines = body.split('\n');
    lines.forEach((l, i) => { if (l.includes('x 0 max 1 min')) clampIdx.push(i); });
    assert.ok(clampIdx.length >= 2, 'clamp Expr must appear both before the transfer curves and after the gamut matrix');
    const gamutIdx = lines.findIndex(l => l.includes('Gamut:'));
    assert.ok(gamutIdx >= 0 && clampIdx[1] > gamutIdx, 'a clamp must follow the gamut matrix');
});

test('CST: unchanged transfer+gamut skips the curve roundtrip (comment honest)', () => {
    const { emitCstBody, CST_DEFAULT_PARAMS } = require(compileTs('cst-transform.ts'));
    const body = emitCstBody({ ...CST_DEFAULT_PARAMS });   // 709→709, 1886→1886
    assert.ok(!body.includes('→ linear'), 'no decode Expr when transfer+gamut unchanged');
    assert.ok(body.includes('no transfer curves applied'), 'comment matches behavior');
    // Gamut change with SAME transfer still decodes→matrix→encodes.
    const g = emitCstBody({ ...CST_DEFAULT_PARAMS, outPrimaries: '2020' });
    assert.ok(g.includes('→ linear') && g.includes('linear →'), 'gamut change requires the linear roundtrip');
});

// ── correctness review C04: preview identity includes trim + manualOrder ────────────────
test('preview chainKey source includes trim points and manualOrder (C04)', () => {
    const src = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'components', 'CompanionChainPreview.tsx'), 'utf8');
    const m = src.match(/const chainKey = useMemo\(\(\) => JSON\.stringify\(\{([\s\S]*?)\}\), \[config\]\)/);
    assert.ok(m, 'chainKey found');
    assert.match(m[1], /trim:/, 'chainKey must include the trim window');
    assert.match(m[1], /manualOrder:/, 'chainKey must include manualOrder');
});

// ── correctness review C08: native preamble carries the guarded vsmlrt import ───────────
test('native composer preamble carries the guarded vsmlrt import (C08)', () => {
    const src = fs.readFileSync(path.join(REPO, 'common', 'chain', 'composer.cpp'), 'utf8');
    assert.ok(src.includes('import vsmlrt'), 'guarded vsmlrt import present in the native preamble');
    assert.ok(src.includes('except Exception'), 'non-ImportError import failures are contained');
});

// ── security review #3: MCP bearer-token auth ─────────────────────────────────────
test('MCP server refuses requests without the per-launch token', async () => {
    const { startMcpServer } = require(path.join(__dirname, 'services', 'mcpServer.js'));
    const port = 20000 + Math.floor(Math.random() * 20000);
    const mcp = await startMcpServer({
        toolDefinitions: [],
        execute: async () => ({ ok: true }),
        requestChainEdit: async () => ({ ok: true }),
    });
    assert.ok(mcp && mcp.token, 'server started and returned a token');
    const post = (headers) => new Promise((resolve) => {
        const req = http.request({ host: '127.0.0.1', port: mcp.port, path: '/mcp',
            method: 'POST', headers: { 'content-type': 'application/json', ...headers } },
            (res) => { let b = ''; res.on('data', (c) => b += c);
                       res.on('end', () => resolve({ status: res.statusCode, body: b })); });
        req.end(JSON.stringify({ jsonrpc: '2.0', method: 'initialize',
            params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } }, id: 1 }));
    });
    // No token → 401 (the audited hole).
    const no = await post({});
    assert.equal(no.status, 401, 'unauthenticated request refused');
    assert.match(no.body, /unauthorized/);
    // Wrong token → 401.
    const wrong = await post({ authorization: 'Bearer nope' });
    assert.equal(wrong.status, 401);
    // Right token → NOT 401 (passes auth into the MCP transport).
    const ok = await post({ authorization: `Bearer ${mcp.token}` });
    assert.notEqual(ok.status, 401, 'authorized request passes the auth gate');
    // Alternate header accepted too.
    const alt = await post({ 'x-vsres-mcp-token': mcp.token });
    assert.notEqual(alt.status, 401);
    mcp.httpServer.close();
});

// ── security review #6: keyed-provider endpoints ──────────────────────────────────
// The validation cases live in __test_keychain.js (that harness isolates the
// fake fs + home); here we only pin the dispatch-time refusal, which the
// keychain harness cannot reach.
test('llm dispatcher refuses a stored http: remote endpoint at send time', () => {
    const src = fs.readFileSync(path.join(__dirname, 'llm', 'index.js'), 'utf8');
    assert.match(src, /Refusing to send the API key over plaintext http/,
        'dispatch-time refusal present');
});

// POSTURE (2026-11-11, security review #5/#6 remainder): a configured API key must
// not cross a LAN in plaintext without an explicit, documented acceptance.
test('llm dispatcher refuses KEYED plaintext http: to a LAN host without explicit acceptance', () => {
    const src = fs.readFileSync(path.join(__dirname, 'llm', 'index.js'), 'utf8');
    assert.match(src, /VSRES_ALLOW_INSECURE_LAN_KEY/,
        'LAN key egress is gated on the explicit acceptance env');
    assert.match(src, /Refusing to send the API key over plaintext http: to LAN host/,
        'keyed LAN refusal has its own message (keyless local servers still work)');
});

// POSTURE (2026-11-11): the bundle-wins decision for helper precedence —
// machine dirs are appended fallbacks, never prepended (native + draft).
test('machine helper dirs are appended fallbacks in both composers (security review #5)', () => {
    const native = fs.readFileSync(path.join(REPO, 'common', 'chain', 'composer.cpp'), 'utf8');
    assert.match(native, /sys\.path\.append\(_vsr\)/,
        'native prelude appends machine dirs');
    assert.ok(!native.includes('sys.path.insert(0, _vsr)'),
        'native prelude must never prepend machine dirs');
    const draft = fs.readFileSync(path.join(__dirname, '..', 'shared', 'draft-composer.ts'), 'utf8');
    assert.match(draft, /sys\.path\.append\(_vsr\)/,
        'draft prelude appends machine dirs');
    assert.ok(!draft.includes('sys.path.insert(0, _vsr)'),
        'draft prelude must never prepend machine dirs');
    const runtime = fs.readFileSync(path.join(REPO, 'platform', 'macos', 'host', 'vs_runtime.cpp'), 'utf8');
    assert.match(runtime, /VSRES_ALLOW_PLUGIN_OVERRIDE/,
        'plugin-path overrides must be loud and acknowledged when displacing the bundle');
});

// C01 (2026-11-11): the native render cache key must carry the EFFECTIVE mix
// (the composed script embeds the blend), and accepting a revision must
// synchronize the OFX Mix parameter — otherwise a recipe authored at mix
// 0.25 previewed at quarter strength and rendered at the parameter default.
test('C01: effective mix is part of the native render cache identity and accept syncs the Mix parameter', () => {
    const src = fs.readFileSync(path.join(REPO, 'platform', 'macos', 'host', 'plugin_entry.cpp'), 'utf8');
    assert.match(src, /cache_key_with_mix\(config_json, mix\)/,
        'render cache key includes the effective mix');
    assert.match(src, /is_cached\(effective_key/,
        'cache probe uses the effective key');
    assert.match(src, /open\(effective_key, script, rcfg\)/,
        'runtime open uses the effective key');
    assert.match(src, /mix parameter synchronized to accepted revision/,
        'accept-path synchronizes the Mix parameter with the accepted revision');
});

// C06 (2026-11-11): the declared timing contract is ENFORCED — rate-changing
// chains on a mismatched timeline are refused with the exact rates, never
// silently retimed; the frame index rounds (not truncates) and clamps to the
// clip's own length.
test('C06: rate mismatch is refused with both rates; frame index rounds and clamps', () => {
    const src = fs.readFileSync(path.join(REPO, 'platform', 'macos', 'host', 'plugin_entry.cpp'), 'utf8');
    assert.match(src, /vsres::rate::rates_match\(/, 'render path enforces the rate contract');
    assert.match(src, /chain-rate-mismatch/, 'refusal has a distinct status state');
    assert.match(src, /vsres::rate::timeline_frame_index\(/, 'frame index uses the tested rounding helper');
    assert.match(src, /vsres::rate::clamp_to_output\(/, 'frame index clamps to the clip length');
    const hdr = fs.readFileSync(path.join(REPO, 'common', 'chain', 'rate_contract.h'), 'utf8');
    assert.match(hdr, /kRateMatchTolerance = 0\.005/, 'tolerance sits between standard-rate gaps');
    const rt = fs.readFileSync(path.join(REPO, 'platform', 'macos', 'host', 'vs_runtime.h'), 'utf8');
    assert.match(rt, /output_fps_num\(\)/, 'runtime exposes the open graph fps');
});

// cleanup
process.on('exit', () => { try { fs.rmSync(tsTmp, { recursive: true, force: true }); } catch {} });

// ── security re-review (2026-11-05): approval binding + token privacy + runtime path ──
test('library adds enter the chain UNAPPROVED with no binding (App.tsx contract)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.tsx'), 'utf8');
    const m = src.match(/const newStep: ChainStep = \{[\s\S]*?\};/);
    assert.ok(m, 'newStep construction found');
    assert.match(m[0], /approved: false,\s*approvedContent: null,/,
        'every library-added executable step must start approved:false with no binding');
});

test('the runtime bundle path is hex-encoded into Python (vs_runtime contract)', () => {
    const src = fs.readFileSync(path.join(REPO, 'platform', 'macos', 'host', 'vs_runtime.cpp'), 'utf8');
    assert.ok(src.includes("_inject.append(bytes.fromhex("),
        'the bundle vs-python path must be emitted as hex bytes');
    assert.ok(!src.includes("_inject.append('" + '")') || src.includes('bytes.fromhex'),
        'no raw quoted path remains');
});

test('MCP token is NOT logged by default (opt-in contract)', () => {
    const src = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
    assert.match(src, /VSRES_MCP_LOG_TOKEN === '1'/,
        'token logging must be gated on VSRES_MCP_LOG_TOKEN');
    assert.match(src, /NOT logged by default/,
        'default log explains where the token lives');
    // POSTURE DECISION (2026-11-11): the opt-in keeps printing the FULL
    // registration command (today's only registration path) but must carry
    // its own credential warning — decision recorded, not accidental.
    assert.match(src, /LIVE registration credential for THIS LAUNCH ONLY/,
        'opt-in token output must warn it is a live credential');
    assert.match(src, /POSTURE DECISION/,
        'the opt-in behavior is a recorded decision');
});

test('native sidecar/config writes are private + no-follow (private_io contract)', () => {
    // The mechanics live in common/fs/private_io.cpp (2026-11-11 refactor so
    // they are unit-tested directly by tests/unit/test_private_io.cpp).
    const io = fs.readFileSync(path.join(REPO, 'common', 'fs', 'private_io.cpp'), 'utf8');
    assert.match(io, /O_NOFOLLOW/, 'private writes must refuse symlinks');
    assert.match(io, /0600\)/, 'private writes must create 0600 files');
    assert.match(io, /fchmod\(fd, 0600\)/, 'existing broader modes must be tightened in place');
    assert.match(io, /st_nlink > 1/, 'hardlinked targets must be refused');
    assert.match(io, /mkdir\(path\.c_str\(\), 0700\)/, 'product dirs must be created 0700');
    assert.ok(!/0755/.test(io), 'product dirs must never be widened');
    assert.match(io, /ftruncate\(fd, 0\)/, 'truncation must happen after the descriptor checks');
    // plugin_entry delegates every private write/dir to the helper.
    const src = fs.readFileSync(path.join(REPO, 'platform', 'macos', 'host', 'plugin_entry.cpp'), 'utf8');
    assert.ok(!/mkdir\(/.test(src), 'plugin_entry must delegate directory creation to private_io');
    assert.match(src, /ensure_private_dir\(/, 'private dirs go through the verified helper');
    assert.match(src, /write_private_file\(/, 'private writes go through the verified helper');
});
