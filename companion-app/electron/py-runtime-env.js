// Environment + bundle hygiene for the embedded Python runtime.
//
// Field bug (reported 2026-11-17, reproduced): when the embedded Python ran
// from the signed OFX bundle, CPython wrote __pycache__ bytecode caches into
// its own Python.framework. Those ADDITIONS invalidate the code-signing seal
// of BOTH the framework and the companion app ("a sealed resource is missing
// or invalid in subcomponent: .../Python.framework"), which makes the
// Install-for-Resolve trust gate refuse from then on.
//
// Two layers guard against it:
//
//   1. applyPythonNoCacheEnv() — run at app startup; PYTHONDONTWRITEBYTECODE=1
//      (and a bytecode-cache prefix OUTSIDE the bundle) land in process.env,
//      which every spawned child inherits. Python then never writes .pyc
//      files, so the seal cannot be broken by use.
//
//   2. repairUnsealedBytecode() — used by the install flow. NOT a blind
//      sweep: __pycache__ files can be part of the signature itself (if the
//      build re-signed a staged tree that contained them, they are SEALED —
//      deleting those breaks the seal). The repair therefore consults
//      codesign: only files the verifier reports as `file added:` additions
//      (i.e. provably NOT in the signature envelope) and that are
//      bytecode-cache shaped are removed — nothing else — and then the
//      bundle must VERIFY CLEAN before the caller proceeds. Any other
//      failure leaves the bundle untouched and fail-closed.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

/** Force bytecode caching off for Python children; optionally relocate the
 *  cache prefix. Existing values are respected (tests / callers may preset). */
function applyPythonNoCacheEnv(env = process.env, cachePrefixDir) {
    if (!env || typeof env !== 'object') return env;
    if (!env.PYTHONDONTWRITEBYTECODE) env.PYTHONDONTWRITEBYTECODE = '1';
    if (!env.PYTHONPYCACHEPREFIX && cachePrefixDir) env.PYTHONPYCACHEPREFIX = cachePrefixDir;
    return env;
}

/** Extract `file added: <path>` additions under rootPath from codesign
 *  --verify --verbose=4 output. Only bytecode-cache-shaped files (a path
 *  component named __pycache__ + .pyc/.pyo extension) are returned.
 *  Paths are realpath-normalized: macOS TMPDIR is /var/folders/... which is a
 *  symlink to /private/var/folders/..., and codesign reports resolved paths. */
function parseCodesignBytecodeAdditions(output, rootPath) {
    let root;
    try { root = fs.realpathSync(rootPath || ''); } catch { root = path.resolve(rootPath || ''); }
    const found = [];
    for (const line of String(output || '').split('\n')) {
        const m = /^file added:\s*(.+?)\s*$/.exec(line);
        if (!m) continue;
        let p;
        try { p = fs.realpathSync(m[1]); } catch { p = path.resolve(m[1]); }
        if (root && !(p === root || p.startsWith(root + path.sep))) continue;
        if (!p.split(path.sep).includes('__pycache__')) continue;
        if (!/\.(pyc|pyo)$/.test(p)) continue;
        found.push(p);
    }
    return found;
}

/** Blindly remove __pycache__ directories under rootPath. Intended for
 *  STAGING-time cleanup only (before signing); the install path uses
 *  repairUnsealedBytecode, which is signature-aware. Best-effort and
 *  non-throwing; returns what was removed and what failed. */
function sweepBundleBytecode(rootPath, { fsImpl = fs } = {}) {
    const removed = [];
    const errors = [];
    if (!rootPath || typeof rootPath !== 'string') return { removed, errors };
    let stat;
    try { stat = fsImpl.statSync(rootPath); } catch { return { removed, errors }; }
    if (!stat.isDirectory()) return { removed, errors };
    const walk = dir => {
        let entries;
        try { entries = fsImpl.readdirSync(dir, { withFileTypes: true }); }
        catch (err) { errors.push(`${dir}: ${err.message}`); return; }
        for (const entry of entries) {
            const p = path.join(dir, entry.name);
            if (!entry.isDirectory()) continue;
            if (entry.name === '__pycache__') {
                try { fsImpl.rmSync(p, { recursive: true, force: true }); removed.push(p); }
                catch (err) { errors.push(`${p}: ${err.message}`); }
            } else {
                walk(p);
            }
        }
    };
    walk(rootPath);
    return { removed, errors };
}

/** Signature-aware repair for the install trust gate.
 *  runVerify(rootPath) must return { ok, output } from a REAL codesign
 *  verification (verbose enough to print `file added:` lines).
 *
 *  Returns { ok, action, removed, output }:
 *   - verification passed up front      → { ok: true,  action: 'none' }
 *   - additions only, re-verify passes  → { ok: true,  action: 'removed' }
 *   - anything else fails verification  → { ok: false, action: 'none' | 'removed' }
 *  The caller proceeds ONLY on ok:true; the trust model stays fail-closed. */
function repairUnsealedBytecode(rootPath, { runVerify, fsImpl = fs } = {}) {
    if (typeof runVerify !== 'function') return { ok: false, action: 'none', removed: [], output: 'no verifier supplied' };
    const first = runVerify(rootPath) || {};
    if (first.ok) return { ok: true, action: 'none', removed: [], output: first.output };
    const additions = parseCodesignBytecodeAdditions(first.output, rootPath);
    if (!additions.length) return { ok: false, action: 'none', removed: [], output: first.output };
    const removed = [];
    for (const p of additions) {
        try { fsImpl.rmSync(p, { force: true }); removed.push(p); }
        catch { /* best effort; the re-verify below is the gate */ }
        // Drop the __pycache__ directory itself once empty (files are the seal delta).
        const dir = path.dirname(p);
        try { fsImpl.rmdirSync(dir); } catch { /* not empty or already gone */ }
    }
    const second = runVerify(rootPath) || {};
    return { ok: !!second.ok, action: 'removed', removed, output: second.output || first.output };
}

module.exports = {
    applyPythonNoCacheEnv,
    sweepBundleBytecode,
    parseCodesignBytecodeAdditions,
    repairUnsealedBytecode,
};
