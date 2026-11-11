// Companion-side chain preview — two truthful paths, never mixed:
//
// DRAFT (live editor state): the CURRENT editor chain composed by
// shared/draft-composer (an exact mirror of the native composer) and
// rendered through the same evaluation environment. The preview reflects
// the draft — toggles, bypasses, parameter edits render immediately —
// explicitly labeled DRAFT, never claimed as applied to the node.
//
// HOST (accepted chain): the node-scoped host-composed script
// (nodes/<guid>.vpy, written by the OFX render_chain on full-size renders).
// The accepted chain is what the node evaluates in Resolve. When a node-scoped
// script is requested and MISSING, that is an explicit error — NEVER a
// cross-node/global fallback result presented as this node's.
//
// Modes: 'processed' (chain result) and 'source' (the script's `src`
// binding — the identified media pre-chain) for A/B comparison.
//
// Honesty contract: every result carries provenance (draft|host), frame
// index, totals and dims; errors carry the actual python message. The
// caller drops obsolete results by request sequence (latest-wins).

const { spawn } = require('child_process');
const { getWorker, disposeAllWorkers } = require('./preview-worker');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Buffer, constants: bufferConstants } = require('buffer');
const { runProbeProcess, hasPendingProbeStop } = require('./probe-process');

const DEFAULT_PREVIEW_TIMEOUT_MS = 30_000;
const DEFAULT_PREVIEW_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
// Operational PNG policy: an 8192x4320 RGB24 raster is ~101.25MiB before
// compression. No geometry limit or owner-footage qualification is implied.
const DEFAULT_PREVIEW_MAX_PNG_BYTES = 128 * 1024 * 1024;
const PNG_DATA_PREFIX = 'data:image/png;base64,';
const stoppedOneShots = new Set();
const SELFCHECK_KIND = 'selfcheck';
const SELFCHECK_TIMEOUT_MS = 10_000; // Existing per-candidate import budget.
// One small verdict with version/platform/module path or a 160-character
// exception tail, plus import chatter. This is an overridable operational
// budget, not a universal path/version/output-format maximum.
const SELFCHECK_MAX_OUTPUT_BYTES = 1024 * 1024;

const { helperScript } = require('./prod-paths');
const RENDER_SCRIPT = () => helperScript('render_preview_frame.py');
const COMPOSED_SCRIPT = () =>
    path.join(process.env.HOME || os.homedir(),
        'Library/Application Support/VapourSynth-OFX', 'last-composed.vpy');

// ── Test-isolation guard (fail-closed) ──────────────────────────────────────
// VSRES_ALLOWED_SOURCE_ROOTS (pathsep-separated absolute prefixes): when set,
// any quoted path binding in a preview script outside those roots refuses the
// render BEFORE any python spawn or media open. Root cause this closes: the
// renderer's mount-time auto-discovery live-queries the machine's Resolve and
// ADOPTS its playhead clip over a test fixture (a channel HOME/userData
// isolation cannot cover — 2026-10-31 journey leak).
//
// WHAT THIS GUARD ACTUALLY IS (honest scope — reviewed 2026-10-31 late):
//   - It is a TEST-ISOLATION TRIPWIRE against accidental fixture
//     contamination, NOT a Python sandbox. The script is still arbitrary
//     Python composed by OUR renderer; the guard cannot see paths built at
//     runtime (f-strings, concatenation, os.path.join), paths read from
//     files/env inside the script, or code with side effects that need no
//     path at all. Hostile-script containment is the approved-script
//     isolation gate (B1'), a separate owner decision.
//   - Checks QUOTED strings that look like paths (contain '/'):
//       • absolute '/…' must sit inside the roots LEXICALLY and, when the
//         path exists on disk, must also sit inside after fs.realpathSync —
//         a symlink planted inside the fixture that points outside is
//         refused (symlink-escape closure).
//       • relative-with-slash ('../…', 'sub/dir/x') is refused outright —
//         the composer never emits one, and it resolves against the
//         process CWD, outside any root.
//       • the one '~/…' literal composed scripts carry (the vs-python
//         helper line) is exempt: it expands under the session HOME
//         (inside the isolated tree) and VapourSynth sources cannot open
//         unexpanded '~' paths anyway.
//   - Bare relative names with NO slash ('media.mov') are not flagged:
//     without a slash they cannot traverse, and they only resolve against
//     the companion CWD (a repo dir) — the open fails on its own.
//   - Unicode: matching is byte-exact; an NFC/NFD mismatch refuses
//     (fail-closed direction). Escaped quotes: raw-string bindings cannot
//     contain a quote — the composer's own emission breaks first and the
//     render fails at eval.
//   - Production never sets the env var; the guard is inert there. An
//     EMPTY root list (variable set to nothing) refuses every path-like
//     binding — strictest posture, still fail-closed.
function allowedSourceRoots() {
    const raw = process.env.VSRES_ALLOWED_SOURCE_ROOTS;
    if (raw === undefined) return null;
    return raw.split(path.delimiter).map(r => r.trim()).filter(Boolean);
}
function withinRoots(p, roots) {
    return roots.some(r => p === r || p.startsWith(r.endsWith('/') ? r : r + '/'));
}
function pathsOutsideAllowedRoots(text, roots) {
    const quoted = [...String(text).matchAll(/(['"])([^'"]*)\1/g)]
        .map(m => m[2]).filter(p => p.includes('/'));
    if (!roots || !roots.length) return quoted;   // set-but-empty: refuse all
    const resolvedRoots = [];
    for (const r of roots) {
        resolvedRoots.push(r);
        try { resolvedRoots.push(fs.realpathSync(r)); } catch { /* missing root stays lexical */ }
    }
    const outside = [];
    for (const p of quoted) {
        if (p.startsWith('~')) continue;                        // documented exemption
        if (!p.startsWith('/')) { outside.push(p); continue; }  // relative-with-slash: refuse
        let ok = withinRoots(p, roots);
        if (ok) {
            try {
                const resolved = fs.realpathSync(p);
                if (!withinRoots(resolved, resolvedRoots)) ok = false;   // symlink escape
            } catch { /* nonexistent: the open fails on its own; keep the lexical verdict */ }
        }
        if (!ok) outside.push(p);
    }
    return outside;
}
function refusalOutsideRoots(offenders) {
    const shown = offenders.slice(0, 2).join(', ')
        + (offenders.length > 2 ? `, +${offenders.length - 2} more` : '');
    return { ok: false,
        error: `Preview refused: script binds a path outside the allowed fixture roots (${shown}). Isolation violation — nothing was rendered.` };
}

// ── Runtime resolution ──────────────────────────────────────────────────────
// A python is "VapourSynth-capable" ONLY if it passes the bounded
// --selfcheck probe (real import contract, no media, no core) — existence
// alone proves nothing. Probe results are cached (success forever, failures
// re-probed after a TTL or invalidated on import-shaped render failures) so
// rapid toggles/seeks/A-B never re-run the expensive probe per frame.
//
// Candidates, in order:
//   1. VSRES_SAMPLE_PYTHON  — the TRUSTED test seam (fixture interpreters
//      inject synthetic behavior; exempt from probing by design).
//   2. Packaged: the embedded CPython framework inside the app's shipped OFX
//      bundle (process.resourcesPath/OFX/...). Production isolation: never a
//      machine-global python.
//   3. Development checkout: the SAME staged bundle's framework python
//      (build-portable/portable/...). The dev Electron launch has no
//      Resources/OFX tree, so without this candidate the dev companion
//      cannot render — THE 2026-10-29 live regression. This is the
//      project's OWN runtime (not arbitrary system python) and cannot
//      resolve in a packaged app (asar) or when VSRES_PACKAGED_SIM=1
//      (test modeling of a packaged machine).
//   4. VSRES_DEV_PYTHON=1 only — explicit dev opt-in for machine pythons.
const CHECKOUT_BUNDLE = path.join(__dirname, '..', '..',
    'build-portable', 'portable', 'VapourSynth.ofx.bundle');
const BUNDLE_PY = (bundleRoot) => path.join(bundleRoot, 'Contents', 'Frameworks',
    'Python.framework', 'Versions', 'Current', 'bin', 'python3');
const BUNDLE_VS_PYTHON = (bundleRoot) => path.join(bundleRoot, 'Contents', 'Resources', 'vs-python');

const capabilityCache = new Map();   // key: python\x00script -> {ok, result?, reason?, at}
const capabilityPublications = new Map(); // Latest started probe owns cache publication.
const CAPABILITY_TTL_MS = 60_000;    // cached FAILURES re-probe after this
const _forTest = { capabilityCache };

function isAsarPath(p) { return String(p).includes('app.asar'); }

function launchMode() {
    // process.defaultApp === true only under `electron .` (dev). Node tests
    // report 'development' too — they exercise the dev contract.
    if (process.env.VSRES_PACKAGED_SIM === '1') return 'packaged (simulated)';
    if (process.defaultApp === true || !process.versions.electron) return 'development';
    return 'packaged';
}

// ctx injectable for the discovery-contract tests (isolated fs/env views);
// defaults are the real production environment.
function runtimeCandidates(ctx) {
    const c = ctx || {};
    const env = c.env || process.env;
    const resourcesPath = c.resourcesPath !== undefined ? c.resourcesPath : process.resourcesPath;
    const dirname = c.dirname || __dirname;
    const exists = c.exists || fs.existsSync;
    const packagedBundle = path.join(resourcesPath || '', 'OFX', 'VapourSynth.ofx.bundle');
    const checkoutBundle = path.join(dirname, '..', '..',
        'build-portable', 'portable', 'VapourSynth.ofx.bundle');
    const candidates = [
        { path: env.VSRES_SAMPLE_PYTHON, source: 'test-seam',
            trusted: true, vsPythonDir: null },
        { path: BUNDLE_PY(packagedBundle), source: 'packaged-bundle',
            trusted: false, vsPythonDir: BUNDLE_VS_PYTHON(packagedBundle) },
    ];
    // Dev-checkout candidate: excluded in packaged mode (the asar path never
    // exists) and under VSRES_PACKAGED_SIM (models a clean packaged machine).
    if (env.VSRES_PACKAGED_SIM !== '1' && !isAsarPath(dirname)) {
        candidates.push({ path: BUNDLE_PY(checkoutBundle), source: 'dev-checkout-bundle',
            trusted: false, vsPythonDir: BUNDLE_VS_PYTHON(checkoutBundle) });
    }
    if (env.VSRES_DEV_PYTHON === '1') {
        for (const p of ['/opt/homebrew/opt/python@3.14/bin/python3.14',
            '/opt/homebrew/bin/python3.14', '/usr/bin/python3']) {
            candidates.push({ path: p, source: 'dev-explicit-env', trusted: false, vsPythonDir: null });
        }
    }
    return candidates.filter(x => x.path);
}

function selfcheckFailure(result) {
    const closed = result.closed === true;
    const hint = result.reason === 'probe-timeout'
        ? ' Increase VSRES_SELFCHECK_TIMEOUT_MS for intentionally slow imports.'
        : result.reason === 'probe-output-limit'
            ? ' Increase VSRES_SELFCHECK_MAX_OUTPUT_BYTES for intentionally large import output.' : '';
    return { ok: false, selfcheck: true, capabilityUnknown: true,
        reason: result.reason,
        error: `Preview runtime capability is unverified: ${result.error || result.reason}.${hint} No further candidate fallback or render was dispatched.`,
        closureKnown: closed, closureUnknown: !closed, noAutomaticReplay: true,
        ...(result.reason === 'probe-timeout' ? { timeout: true } : {}),
        ...(result.reason === 'probe-output-limit' ? { outputLimit: true } : {}) };
}

function selfcheckStopFailure() {
    return hasPendingProbeStop(SELFCHECK_KIND) ? selfcheckFailure({
        reason: 'probe-stop-pending', closed: false,
        error: 'a previous runtime selfcheck child has not confirmed close',
    }) : null;
}

function selfcheckLimits() {
    const configured = (key, fallback) => process.env[key] === undefined ? fallback
        : typeof process.env[key] === 'string' && /^\d+$/.test(process.env[key]) ? Number(process.env[key]) : NaN;
    const timeoutMs = configured('VSRES_SELFCHECK_TIMEOUT_MS', SELFCHECK_TIMEOUT_MS);
    const maxOutputBytes = configured('VSRES_SELFCHECK_MAX_OUTPUT_BYTES', SELFCHECK_MAX_OUTPUT_BYTES);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) {
        return selfcheckFailure({ reason: 'probe-invalid-budget', closed: true,
            error: 'VSRES_SELFCHECK_TIMEOUT_MS must be a positive integer no greater than 2147483647; it is never clamped' });
    }
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0 || maxOutputBytes > bufferConstants.MAX_STRING_LENGTH) {
        return selfcheckFailure({ reason: 'probe-invalid-budget', closed: true,
            error: `VSRES_SELFCHECK_MAX_OUTPUT_BYTES must be a positive integer no greater than ${bufferConstants.MAX_STRING_LENGTH}; it is never clamped` });
    }
    return { timeoutMs, maxOutputBytes };
}

async function probeCapability(python, renderScript, vsPythonDir, limits) {
    const env = { ...process.env };
    if (vsPythonDir) env.VSRES_VS_PYTHON = vsPythonDir;
    let spawnCode = null;
    const observedSpawn = (...args) => {
        try {
            const child = spawn(...args);
            child.once('error', error => {
                if (child.pid == null && typeof error.code === 'string') spawnCode = error.code;
            });
            return child;
        } catch (error) { spawnCode = error.code; throw error; }
    };
    const result = await runProbeProcess(observedSpawn, python, [renderScript, '--selfcheck'],
        { env, stdio: ['ignore', 'pipe', 'pipe'] },
        { kind: SELFCHECK_KIND, timeoutMs: SELFCHECK_TIMEOUT_MS,
            maxOutputBytes: SELFCHECK_MAX_OUTPUT_BYTES }, limits);
    if (!result.ok) {
        if (result.reason === 'probe-spawn-failed' && ['ENOENT', 'EACCES'].includes(spawnCode)) {
            return { ok: false, capabilityNegative: true,
                reason: spawnCode === 'ENOENT' ? 'missing-executable' : 'not-executable' };
        }
        return selfcheckFailure(result);
    }
    if (result.signal) return selfcheckFailure({ closed: true, reason: 'selfcheck-signalled',
        error: `runtime selfcheck exited by signal ${result.signal}` });
    let parsed = null;
    try { parsed = JSON.parse(result.stdout.trim().split('\n').pop() || ''); } catch { /* unknown output */ }
    const object = parsed && typeof parsed === 'object' && !Array.isArray(parsed);
    if (result.code === 0 && object && parsed.ok === true) return { ok: true, result: parsed };
    if (/no suitable image found|Bad CPU type/i.test(result.stderr + result.stdout)) {
        return { ok: false, capabilityNegative: true, reason: 'incompatible-architecture' };
    }
    // The actual helper emit() exits 0 even for classified negative results.
    if (object && parsed.ok === false && typeof parsed.reason === 'string' && parsed.reason) {
        return { ok: false, capabilityNegative: true, reason: parsed.reason };
    }
    return selfcheckFailure({ closed: true,
        reason: result.code === 0 ? 'selfcheck-invalid-output' : 'selfcheck-exited',
        error: `runtime selfcheck exited with code ${result.code} without a complete capability verdict` });
}

async function cachedProbe(python, renderScript, vsPythonDir, limits) {
    const stopped = selfcheckStopFailure();
    if (stopped) return stopped;
    const key = `${python}\x00${renderScript}`;
    const hit = capabilityCache.get(key);
    const now = Date.now();
    if (hit && (hit.ok || now - hit.at < CAPABILITY_TTL_MS)) return hit;
    const publication = {};
    capabilityPublications.set(key, publication);
    const verdict = await probeCapability(python, renderScript, vsPythonDir, limits);
    const after = selfcheckStopFailure();
    if (capabilityPublications.get(key) !== publication) {
        if (verdict.capabilityUnknown) return after ? { ...verdict,
            closureKnown: false, closureUnknown: true } : verdict;
        return { ...selfcheckFailure({ reason: 'selfcheck-superseded', closed: true,
            error: 'a newer runtime selfcheck or invalidation superseded this completed verdict' }), superseded: true };
    }
    capabilityPublications.delete(key);
    if (after) return verdict.capabilityUnknown ? { ...verdict,
        closureKnown: false, closureUnknown: true } : after;
    if (verdict.ok || verdict.capabilityNegative === true) capabilityCache.set(key, { ...verdict, at: now });
    return verdict;
}

function invalidateCapability(python, renderScript) {
    const key = `${python}\x00${renderScript}`;
    capabilityCache.delete(key);
    capabilityPublications.delete(key); // Pending old completion cannot repopulate it.
}

// Resolve the (python, renderScript) pair for a render. Returns
// {python, renderScript, vsPythonDir, source} or {error} with EVERY
// candidate + its classified reason (sanitized; no env values, no secrets).
async function resolvePreviewRuntime(renderScript, limits) {
    const diagnostics = [];
    const stopped = selfcheckStopFailure();
    if (stopped) return { ...stopped, diagnostics };
    if (!renderScript) {
        return { error: 'Preview renderer helper script (render_preview_frame.py) is missing from this installation — reinstall the companion app.', diagnostics };
    }
    for (const c of runtimeCandidates()) {
        const pending = selfcheckStopFailure();
        if (pending) return { ...pending, diagnostics };
        if (!fs.existsSync(c.path) || isAsarPath(c.path)) {
            diagnostics.push({ source: c.source, path: c.path, reason: 'missing-executable' });
            continue;
        }
        if (c.trusted) {
            return { python: c.path, renderScript, vsPythonDir: c.vsPythonDir, source: c.source };
        }
        const verdict = await cachedProbe(c.path, renderScript, c.vsPythonDir, limits);
        const after = selfcheckStopFailure();
        if (after) return { ...(verdict.capabilityUnknown ? { ...verdict,
            closureKnown: false, closureUnknown: true } : after), diagnostics };
        if (verdict.ok) {
            return { python: c.path, renderScript, vsPythonDir: c.vsPythonDir,
                source: c.source, capability: verdict.result };
        }
        diagnostics.push({ source: c.source, path: c.path, reason: verdict.reason });
        if (verdict.capabilityUnknown) return { ...verdict, diagnostics };
    }
    const buildId = require('../package.json').version || 'unknown';
    const lines = diagnostics.map((d, i) =>
        `  ${i + 1}. [${d.source}] ${d.path} — ${d.reason}`).join('\n');
    const hint = launchMode() === 'development'
        ? 'Development launch: expected the checkout\'s staged bundle (build-portable/portable). Run the portable CMake build, or set VSRES_DEV_PYTHON=1 to allow machine pythons explicitly.'
        : 'Packaged launch: the shipped OFX bundle (Resources/OFX) must contain the embedded Python framework. Reinstall the companion app.';
    return {
        error: `No VapourSynth-capable python found for the preview renderer [launch mode: ${launchMode()}; companion build ${buildId}].\n` +
            `Checked candidates:\n${lines}\n${hint}`,
        diagnostics,
    };
}

// Legacy name kept for other call sites (returns the first EXISTING
// candidate without probing — do not use for capability decisions).
function findPython() {
    for (const c of runtimeCandidates()) {
        if (c.path && fs.existsSync(c.path) && !isAsarPath(c.path)) return c.path;
    }
    return null;
}

// Public request options override environment defaults. Invalid values refuse
// visibly; do not silently clamp a requested execution budget.
function previewLimits(timeoutMs, maxOutputBytes, maxPngBytes) {
    const selected = (value, name, fallback) => value !== undefined ? value
        : process.env[name] !== undefined ? Number(process.env[name]) : fallback;
    const timeout = selected(timeoutMs, 'VSRES_PREVIEW_TIMEOUT_MS', DEFAULT_PREVIEW_TIMEOUT_MS);
    if (!Number.isInteger(timeout) || timeout <= 0 || timeout > 2147483647) {
        return { error: 'Invalid preview timeoutMs: expected a positive integer no greater than 2147483647.' };
    }
    const bytes = selected(maxOutputBytes, 'VSRES_PREVIEW_MAX_OUTPUT_BYTES', DEFAULT_PREVIEW_MAX_OUTPUT_BYTES);
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > bufferConstants.MAX_STRING_LENGTH) {
        return { error: `Invalid preview maxOutputBytes: expected a positive safe integer no greater than ${bufferConstants.MAX_STRING_LENGTH}.` };
    }
    const envPng = process.env.VSRES_PREVIEW_MAX_PNG_BYTES;
    const png = maxPngBytes !== undefined ? maxPngBytes : envPng === undefined ? DEFAULT_PREVIEW_MAX_PNG_BYTES
        : typeof envPng === 'string' && /^\d+$/.test(envPng) ? Number(envPng) : NaN;
    const pngMaximum = Math.min(bufferConstants.MAX_LENGTH,
        Math.floor((bufferConstants.MAX_STRING_LENGTH - PNG_DATA_PREFIX.length) / 4) * 3);
    if (!Number.isSafeInteger(png) || png <= 0 || png > pngMaximum) {
        return { error: `Invalid preview maxPngBytes: expected a positive integer no greater than ${pngMaximum} (Buffer/base64 representation limit).` };
    }
    return { timeoutMs: timeout, maxOutputBytes: bytes, maxPngBytes: png };
}

function sameFile(a, b) { return a.dev === b.dev && a.ino === b.ino; }

// A private output lease owns only two fixed names and its acquired directory.
// These checks reduce accidental/path races; arbitrary same-UID Python remains
// outside the B1' containment decision, and this is not an OS sandbox.
function previewOutput() {
    const uid = process.getuid();
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'vsres-preview-'));
    const identity = fs.lstatSync(dir);
    if (!identity.isDirectory() || identity.uid !== uid || (identity.mode & 0o777) !== 0o700) {
        throw Error('preview output directory is not a private owned directory');
    }
    const out = path.join(dir, 'frame.png'), numbered = path.join(dir, 'frame0.png');
    const observed = new Map();
    let dispatched = false, closed = false, complete = false, requested = false, removed = false;
    let detachClose = null;
    const ownedDirectory = () => {
        try {
            const current = fs.lstatSync(dir);
            return current.isDirectory() && sameFile(current, identity) && current.uid === uid
                && (current.mode & 0o777) === 0o700 && fs.realpathSync(dir) === dir;
        } catch { return false; }
    };
    const cleanup = () => {
        if (removed || !ownedDirectory()) return;
        for (const file of [out, numbered]) {
            try {
                const current = fs.lstatSync(file), expected = observed.get(file);
                if (!current.isFile() || current.uid !== uid || current.nlink !== 1 ||
                        (expected && !sameFile(current, expected))) continue;
                if (!observed.has(file)) observed.set(file, current);
                fs.unlinkSync(file);
            } catch { /* Missing/unowned entries remain untouched. */ }
        }
        try { if (ownedDirectory()) { fs.rmdirSync(dir); removed = true; } } catch { /* Never recurse. */ }
    };
    const release = () => {
        requested = true;
        if (!dispatched || complete || closed) cleanup();
    };
    const onDispatch = child => {
        dispatched = true; // An acquired one-shot writer may already be running.
        if (!child || typeof child.once !== 'function') throw Error('output has no owned child');
        const onClose = () => { closed = true; detachClose = null; if (requested) cleanup(); };
        child.once('close', onClose);
        detachClose = () => child.removeListener('close', onClose);
        return markComplete;
    };
    const markComplete = () => {
        complete = true;
        detachClose?.(); detachClose = null;
        if (requested) cleanup();
    };
    const read = maximum => {
        if (!ownedDirectory()) throw Error('owned PNG directory was replaced');
        const flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
        if (![fs.constants.O_NOFOLLOW, fs.constants.O_NONBLOCK].every(Number.isInteger)) {
            throw Error('no-follow/nonblocking PNG reads are unavailable');
        }
        let fd;
        try {
            fd = fs.openSync(out, flags);
            const before = fs.fstatSync(fd);
            if (!before.isFile() || before.uid !== uid || before.nlink !== 1) throw Error('PNG is not an owned single-link regular file');
            observed.set(out, before);
            if (!Number.isSafeInteger(before.size) || before.size <= 0) throw Error('PNG has an invalid finite size');
            if (before.size > maximum) {
                const error = Error(`Preview PNG exceeded maxPngBytes (${maximum}); select a larger maxPngBytes or VSRES_PREVIEW_MAX_PNG_BYTES for this full-size frame.`);
                error.pngOutputLimit = true; throw error;
            }
            const data = Buffer.allocUnsafe(before.size);
            let offset = 0;
            while (offset < data.length) {
                const count = fs.readSync(fd, data, offset, Math.min(64 * 1024, data.length - offset), offset);
                if (!count) throw Error('PNG ended before its admitted size');
                offset += count;
            }
            if (fs.readSync(fd, Buffer.alloc(1), 0, 1, offset) !== 0) throw Error('PNG grew beyond its admitted size');
            const after = fs.fstatSync(fd), current = fs.lstatSync(out);
            if (!ownedDirectory() || !current.isFile() || !sameFile(before, current) ||
                    !sameFile(before, after) || after.size !== before.size || after.nlink !== 1 ||
                    after.uid !== uid || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
                throw Error('PNG changed during its bounded read');
            }
            return PNG_DATA_PREFIX + data.toString('base64');
        } finally { if (fd !== undefined) fs.closeSync(fd); }
    };
    return { out, onDispatch, release, markComplete, read };
}

function oneShotClosureUnknown(provenance) {
    return { ok: false, provenance,
        error: 'A previous preview process has not confirmed closure; no new preview was dispatched.',
        closureKnown: false, closureUnknown: true, noAutomaticReplay: true };
}

// Core renderer: evaluate `scriptPath` and render one frame. `finish(value)`
// settles once. Draft cleanup also runs once, deferred until exact close when
// a one-shot path consumer has unconfirmed closure. Runtime resolution uses the bounded
// capability probe (cached — never per-frame).
function renderFromPath(scriptPath, { frame = 0, time, mode = 'processed', sar, provenance, scopes, analysisMatrix, metricsWorker, timeoutMs, maxOutputBytes, maxPngBytes, selfcheckPolicy }, finish) {
    return new Promise(async (resolve) => {
        let settled = false;
        let timer = null;
        let stopTimer = null;
        let cleanupDone = false;
        let cleanupValue;
        let outputLease = null;
        const cleanupOnce = () => {
            if (cleanupDone) return;
            cleanupDone = true;
            finish && finish(cleanupValue);
        };
        const finishOnce = (value, deferCleanup = false) => {
            if (settled) return;           // one-shot: timeout/close/error race-safe
            settled = true;
            cleanupValue = value;
            outputLease?.release();
            if (timer) clearTimeout(timer);
            if (stopTimer) clearTimeout(stopTimer);
            if (!deferCleanup) cleanupOnce();
            resolve(value);
        };
        try {
            const selfcheckStop = selfcheckStopFailure();
            if (selfcheckStop) { finishOnce({ ...selfcheckStop, provenance }); return; }
            if (stoppedOneShots.size) { finishOnce(oneShotClosureUnknown(provenance)); return; }
            // ISOLATION GUARD (fail-closed, before any runtime resolution,
            // probe, worker spawn or media open): with allowed roots declared,
            // a script binding a path outside them is refused outright. This
            // is the single choke point for every file-based branch (draft,
            // host node, legacy); the draft branch also refuses on the raw
            // string before the temp file is even written.
            const roots = allowedSourceRoots();
            if (roots) {
                let text = null;
                try { text = fs.readFileSync(scriptPath, 'utf8'); } catch { /* missing files surface below */ }
                if (text != null) {
                    const offenders = pathsOutsideAllowedRoots(text, roots);
                    if (offenders.length) { finishOnce(refusalOutsideRoots(offenders)); return; }
                }
            }
            const renderScript = RENDER_SCRIPT();
            const runtime = await resolvePreviewRuntime(renderScript, selfcheckPolicy);
            if (runtime.error) { finishOnce({ ...runtime, ok: false, provenance }); return; }
            const stoppedSelfcheck = selfcheckStopFailure();
            if (stoppedSelfcheck) { finishOnce({ ...stoppedSelfcheck, provenance }); return; }
            // An older one-shot may have become unconfirmed during resolution.
            if (stoppedOneShots.size) { finishOnce(oneShotClosureUnknown(provenance)); return; }
            const { python, vsPythonDir } = runtime;
            outputLease = previewOutput();
            const env = { ...process.env };
            if (vsPythonDir) env.VSRES_VS_PYTHON = vsPythonDir;
            // PERSISTENT WORKER FIRST: one spawn + import + script eval per
            // script change; frames reuse the open source. Falls back to the
            // honest one-shot path if the worker is unhealthy.
            const useWorker = !process.env.VSRES_NO_RENDER_WORKER;
            if (useWorker) {
                const pendingSelfcheck = selfcheckStopFailure();
                if (pendingSelfcheck) { finishOnce({ ...pendingSelfcheck, provenance }); return; }
                const worker = getWorker(`${python}\x00${renderScript}${metricsWorker ? '\x00metrics' : ''}`, { python, renderScript, vsPythonDir });
                const reqOut = outputLease.out;
                const resp = await worker.request({
                    id: Date.now() + Math.floor(Math.random() * 1e6),
                    script: fs.readFileSync(scriptPath, 'utf8'),
                    frame, time, mode, sar: typeof sar === 'string' ? sar : null,
                    out: reqOut,
                    scopes: scopes === true,
                    timeoutMs, maxResponseBytes: maxOutputBytes, maxPngBytes,
                    rgb_matrix: typeof analysisMatrix === 'string' ? analysisMatrix : null,
                }, { onDispatch: outputLease.onDispatch });
                if (resp?.notDispatched) outputLease.markComplete();
                // These worker outcomes forbid automatic replay. The worker already
                // consumed draft TEXT; releasing the caller's file is safe even
                // while the old worker's process closure remains unconfirmed.
                if (resp && (resp.timeout === true || resp.outputLimit === true || resp.protocolError === true
                    || resp.closureUnknown === true || resp.closureKnown === false
                    || resp.noAutomaticReplay === true)) {
                    const boundary = {};
                    for (const key of ['timeout', 'outputLimit', 'pngOutputLimit', 'protocolError', 'closureKnown',
                        'closureUnknown', 'noAutomaticReplay', 'superseded']) {
                        if (typeof resp[key] === 'boolean') boundary[key] = resp[key];
                    }
                    finishOnce({ ok: false, provenance,
                        error: resp.error || 'Preview worker stopped; automatic replay is unavailable.',
                        ...boundary });
                    return;
                }
                if (resp && resp.ok === true) {
                    try {
                        const dataUrl = outputLease.read(maxPngBytes);
                        finishOnce({
                            ok: true, provenance,
                            frame: resp.frame, total: resp.total,
                            fpsNum: resp.fpsNum, fpsDen: resp.fpsDen,
                            durationS: resp.durationS ?? null,
                            presentationTimeS: resp.presentationTimeS ?? null,
                            width: resp.width, height: resp.height,
                            dataUrl,
                            scopes: resp.scopes || null,
                            displayMatrixAssumed: resp.displayMatrixAssumed ?? null,
                        });
                    } catch (e) {
                        finishOnce({ ok: false, provenance, error: `preview PNG read failed: ${e.message}`,
                            ...(e.pngOutputLimit ? { pngOutputLimit: true } : {}) });
                    }
                    return;
                }
                if (resp && resp.superseded) { finishOnce({ ok: false, provenance, superseded: true }); return; }
                // Text is not a closure oracle. Only a structured known-closed
                // engine failure permits the legacy one-shot fallback; ordinary
                // script failures and unstructured replies never trigger replay.
                const safeFallback = resp && resp.ok === false
                    && resp.closureKnown === true && resp.noAutomaticReplay === false;
                if (!safeFallback) {
                    finishOnce({ ok: false, provenance,
                        error: resp?.error || 'Preview worker returned no usable response; no automatic replay was dispatched.' });
                    return;
                }
                // Known spontaneous close/repeated-crash path: fresh owned output.
                outputLease.release();
                outputLease = previewOutput();
            }
            const pendingSelfcheck = selfcheckStopFailure();
            if (pendingSelfcheck) { finishOnce({ ...pendingSelfcheck, provenance }); return; }
            if (stoppedOneShots.size) { finishOnce(oneShotClosureUnknown(provenance)); return; }
            const out = outputLease.out;
            const args = [renderScript, '--script', scriptPath, '--out', out, '--mode', mode];
            // TIME takes precedence over frame: the renderer resolves time per
            // mode's own evaluated fps (cadence-changing chains keep A/B honest).
            if (Number.isFinite(time)) args.push('--time', String(time));
            else args.push('--frame', String(frame));
            // Probe sampleAspectRatio (e.g. '4:3' HDV) so source-mode A/B shares
            // display geometry with the processed output.
            if (typeof sar === 'string' && sar.includes(':')) args.push('--sar', sar);
            args.push('--max-png-bytes', String(maxPngBytes));
            let proc;
            let childClosed = false;
            let terminalState = null;
            try {
                proc = spawn(python, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
            } catch (e) {
                finishOnce({ ok: false, error: `preview renderer spawn failed: ${e.message}` });
                return;
            }
            const stopOneShot = (failure) => {
                if (terminalState || childClosed) return;
                terminalState = { ...failure, ok: false, provenance, noAutomaticReplay: true };
                stoppedOneShots.add(proc);
                let accepted = false;
                try { accepted = proc.kill('SIGKILL') === true; } catch { /* closure remains unconfirmed */ }
                if (childClosed || settled) return;
                const unknown = () => finishOnce({ ...terminalState,
                    closureKnown: false, closureUnknown: true }, true);
                // Accepted signalling is not closure. Observe exact close for up
                // to five seconds; failed signalling reports uncertainty now.
                // The original SCRIPT PATH is retained until that exact close.
                if (accepted) stopTimer = setTimeout(unknown, 5_000);
                else unknown();
            };
            // Existing default is 30s; explicit validated caller/env budgets can
            // select another value. This is a per-request budget, not a global cap.
            timer = setTimeout(() => stopOneShot({
                error: 'Preview render timed out. If it persists, simplify the chain and retry.',
                timeout: true,
            }), timeoutMs);
            let stdout = '', stderr = '', outputBytes = 0;
            const captureOutput = (stream, data) => {
                if (settled || terminalState) return;
                const next = outputBytes + Buffer.byteLength(data);
                if (next > maxOutputBytes) {
                    stopOneShot({ error: `Preview renderer output exceeded ${maxOutputBytes} bytes.`, outputLimit: true });
                    return;
                }
                outputBytes = next;
                if (stream === 'stdout') stdout += data;
                else stderr += data;
            };
            proc.stdout.on('data', (data) => captureOutput('stdout', data));
            proc.stderr.on('data', (data) => captureOutput('stderr', data));
            for (const [name, stream] of [['stdout', proc.stdout], ['stderr', proc.stderr]]) {
                stream.on('error', (error) => {
                    if (settled || terminalState) return;
                    stopOneShot({ error: `preview renderer ${name} failed: ${error.message}` });
                });
            }
            proc.on('error', (e) => {
                if (terminalState) {
                    finishOnce({ ...terminalState, closureKnown: false, closureUnknown: true }, true);
                    return;
                }
                if (proc.pid) {
                    stopOneShot({ error: `preview renderer process error: ${e.message}` });
                } else {
                    outputLease.markComplete(); // Proven pidless spawn failure has no writer.
                    terminalState = { ok: false, provenance,
                        error: `preview renderer spawn failed: ${e.message}`,
                        closureKnown: true, closureUnknown: false, noAutomaticReplay: true };
                    finishOnce(terminalState);
                }
            });
            proc.on('close', (code, signal) => {
                childClosed = true;
                outputLease.markComplete(); // Also releases an observer-bind failure.
                stoppedOneShots.delete(proc);
                if (terminalState) {
                    finishOnce({ ...terminalState, closureKnown: true, closureUnknown: false });
                    cleanupOnce();
                    outputLease.release();
                    return;
                }
                if (settled) { cleanupOnce(); return; }
                if (code !== 0 || signal) {
                    // Preserve capability-cache recovery on import-shaped failures.
                    if (/No module named|dylib|Library not loaded|image not found/i.test(stderr)) {
                        invalidateCapability(python, renderScript);
                    }
                    finishOnce({ ok: false, provenance, closureKnown: true, closureUnknown: false,
                        error: `preview renderer exited with code ${code}${signal ? ` (${signal})` : ''}: `
                            + (stderr || stdout || 'no output').slice(0, 400) });
                    outputLease.release();
                    return;
                }
                const parse = () => {
                    try { return JSON.parse(stdout.trim()); } catch { return null; }
                };
                const result = parse();
                if (!result || result.ok !== true) {
                    // Import-shaped failures mean the cached capability verdict
                    // is stale — invalidate so the NEXT render re-probes
                    // (recovery after a corrected configuration).
                    if (/No module named|dylib|Library not loaded|image not found/i.test(stderr)) {
                        invalidateCapability(python, renderScript);
                    }
                    finishOnce({ ok: false, provenance,
                        error: (result && result.error) || `preview renderer failed: ${(stderr || stdout || 'no output').slice(0, 400)}`,
                        ...(result?.pngOutputLimit ? { pngOutputLimit: true } : {}) });
                    outputLease.release();
                    return;
                }
                try {
                    const dataUrl = outputLease.read(maxPngBytes);
                    finishOnce({
                        ok: true, provenance,
                        frame: result.frame, total: result.total,
                        fpsNum: result.fpsNum, fpsDen: result.fpsDen,
                        durationS: result.durationS ?? null,
                        presentationTimeS: result.presentationTimeS ?? null,
                        width: result.width, height: result.height,
                        dataUrl,
                        scopes: result.scopes || null,
                        displayMatrixAssumed: result.displayMatrixAssumed ?? null,
                    });
                } catch (e) {
                    finishOnce({ ok: false, provenance, error: `preview PNG read failed: ${e.message}`,
                            ...(e.pngOutputLimit ? { pngOutputLimit: true } : {}) });
                } finally {
                    outputLease.release();
                }
            });
            try { outputLease.onDispatch(proc); }
            catch (error) {
                stopOneShot({ error: `preview renderer output observer failed: ${error.message}` });
            }
        } catch (e) {
            finishOnce({ ok: false, error: `preview renderer error: ${e.message}` });
        }
    });
}

function renderPreviewFrame({ frame = 0, time, mode = 'processed', sar, nodeGuid, draftScript, scopes, analysisMatrix, metricsWorker, timeoutMs, maxOutputBytes, maxPngBytes } = {}) {
    const limits = previewLimits(timeoutMs, maxOutputBytes, maxPngBytes);
    if (limits.error) return Promise.resolve({ ok: false, error: limits.error });
    const selfcheckPolicy = selfcheckLimits();
    if (selfcheckPolicy.error) return Promise.resolve(selfcheckPolicy);
    const selfcheckStop = selfcheckStopFailure();
    if (selfcheckStop) return Promise.resolve({ ...selfcheckStop, provenance: draftScript ? 'draft' : 'host' });
    if (stoppedOneShots.size) return Promise.resolve(oneShotClosureUnknown(draftScript ? 'draft' : 'host'));
    // ── DRAFT: current editor chain, composed companion-side. Node-scoped by
    // construction (the config belongs to this session); no cross-node result
    // is possible. Only an unconfirmed path consumer delays owned-file cleanup.
    if (draftScript) {
        // ISOLATION GUARD (earliest layer): refuse a draft that binds any
        // path outside the declared fixture roots BEFORE writing the temp
        // script — the leak this catches (2026-10-31) adopted the machine's
        // LIVE Resolve clip over the fixture, so no storage-based isolation
        // could have stopped it.
        const roots = allowedSourceRoots();
        if (roots) {
            const offenders = pathsOutsideAllowedRoots(draftScript, roots);
            if (offenders.length) return Promise.resolve(refusalOutsideRoots(offenders));
        }
        const dir = path.dirname(COMPOSED_SCRIPT());
        let draftPath;
        let draftIdentity = null;
        const cleanupDraft = () => {
            if (!draftIdentity) return;
            try {
                const current = fs.lstatSync(draftPath);
                if (current.isFile() && current.dev === draftIdentity.dev
                    && current.ino === draftIdentity.ino) fs.unlinkSync(draftPath);
            } catch { /* missing/replaced entries do not belong to this request */ }
        };
        try {
            fs.mkdirSync(dir, { recursive: true });
            draftPath = path.join(dir, `draft-${process.pid}-${crypto.randomUUID()}.vpy`);
            const fd = fs.openSync(draftPath, 'wx', 0o600);
            try {
                draftIdentity = fs.fstatSync(fd);
                fs.writeFileSync(fd, draftScript, 'utf8');
            } finally { fs.closeSync(fd); }
        } catch (e) {
            cleanupDraft();
            return Promise.resolve({ ok: false, error: `draft preview script write failed: ${e.message}` });
        }
        return renderFromPath(draftPath, { frame, time, mode, sar, provenance: 'draft', scopes, analysisMatrix, metricsWorker, ...limits, selfcheckPolicy },
            cleanupDraft);
    }

    // ── HOST: node-scoped accepted chain. A MISSING node script is an
    // explicit error — never the global file presented as this node's result.
    if (nodeGuid && /^[\w-]+$/.test(nodeGuid)) {
        const nodePath = COMPOSED_SCRIPT().replace(/last-composed\.vpy$/, `nodes/${nodeGuid}.vpy`);
        if (!fs.existsSync(nodePath)) {
            return Promise.resolve({ ok: false, provenance: 'host',
                error: 'No composed script for THIS node yet — render a frame in Resolve first. (No cross-node fallback.)' });
        }
        return renderFromPath(nodePath, { frame, time, mode, sar, provenance: 'host', scopes, analysisMatrix, metricsWorker, ...limits, selfcheckPolicy });
    }

    // Legacy (no nodeGuid): the shared file, labeled legacy so the caller can
    // present it honestly rather than as node-scoped.
    const composed = COMPOSED_SCRIPT();
    if (!fs.existsSync(composed)) {
        return Promise.resolve({ ok: false, provenance: 'host',
            error: 'No composed chain script yet — render a frame in Resolve first (the host writes its composed script on every full-size render).' });
    }
    return renderFromPath(composed, { frame, time, mode, sar, provenance: 'host-legacy', scopes, analysisMatrix, metricsWorker, ...limits, selfcheckPolicy });
}

module.exports = { renderPreviewFrame,
    _forTest: { capabilityCache, runtimeCandidates, invalidateCapability,
        allowedSourceRoots, pathsOutsideAllowedRoots } };
