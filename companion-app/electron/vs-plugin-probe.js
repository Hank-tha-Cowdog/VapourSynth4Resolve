// Main-process runtime probe of ACTUALLY registered VapourSynth namespaces.
//
// The curated manifest (src/services/installed-plugins.ts) is a guide, not
// proof. Live fallout (Oct 26): the manifest listed `fft3dfilter` as
// installed; the runtime had no such namespace; a Skippy-generated step
// referencing it was refused with "no attribute or namespace named
// fft3dfilter". This probe spawns scripts/probe_vs_plugins.py under the
// SAME python the sample renderer uses (findSamplePython) and returns the
// real registered set. Consumers: FilterLibrary availability badges, the
// Archivist system-prompt manifest (verified-only), and get_chain_state.
//
// One probe per app run, cached; never blocks startup (lazy, async).

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const { helperScript } = require('./prod-paths');
const { runProbeProcess, hasPendingProbeStop } = require('./probe-process');
const PROBE_SCRIPT = () => helperScript('probe_vs_plugins.py');

function findPython() {
    const candidates = [
        // Test seam (isolated fixtures) — and dev override.
        process.env.VSRES_SAMPLE_PYTHON,
        // PACKAGED app first: the embedded CPython framework inside the OFX
        // bundle shipped in the app's Resources. Never dev-machine paths.
        path.join(process.resourcesPath || '', 'OFX', 'VapourSynth.ofx.bundle',
            'Contents', 'Frameworks', 'Python.framework', 'Versions',
            'Current', 'bin', 'python3'),
        // Dev convenience only (guarded by VSRES_DEV_PYTHON so a packaged app
        // NEVER silently falls back to some machine's Homebrew install).
        ...(process.env.VSRES_DEV_PYTHON === '1' ? [
            '/opt/homebrew/opt/python@3.14/bin/python3.14',
            '/opt/homebrew/bin/python3.14',
            '/usr/bin/python3',
        ] : []),
    ].filter(Boolean);
    for (const p of candidates) if (fs.existsSync(p)) return p;
    return null;
}

// Cache stable completed snapshots (including a known component absence), not
// transient operational failures. Only the latest started refresh may replace it.
let cached = null;
let startedGeneration = 0;
const KIND = 'namespaces';
// Core/plugin registration and a JSON name list, no frame decoding/inference.
// These are provisional operational budgets, not measured runtime maxima.
// Explicit options or VSRES_NAMESPACES_TIMEOUT_MS / _MAX_OUTPUT_BYTES may raise
// them; use force:true to refresh an established cached snapshot with a budget.
const BUDGET = { kind: KIND, timeoutMs: 60_000, maxOutputBytes: 4 * 1024 * 1024 };

function unavailable(error, extra = {}) {
    return { at: Date.now(), namespaces: null, error, noAutomaticReplay: true, ...extra };
}

async function probeNamespaces(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
        return unavailable('namespace probe options must be an object', {
            reason: 'probe-invalid-budget', closed: true, notStarted: true,
        });
    }
    // An old valid cache is not permission to ignore an unconfirmed stopped child.
    if (hasPendingProbeStop(KIND)) {
        return unavailable('Previous namespace probe child close is unconfirmed; no new probe started', {
            reason: 'probe-stop-pending', closed: false, cleanupUnconfirmed: true, notStarted: true,
        });
    }
    if (cached && !options.force) return cached;
    const generation = ++startedGeneration;
    const publish = (result, stable) => {
        if (generation === startedGeneration) cached = stable ? result : null;
        return result;
    };
    const python = findPython();
    if (!python) {
        return publish(unavailable('no VapourSynth-capable python found', {
            reason: 'namespace-runtime-missing', closed: true, notStarted: true,
        }), true);
    }
    const probeScript = PROBE_SCRIPT();
    if (!probeScript) {
        return publish(unavailable('probe script missing from installation (reinstall the companion app)', {
            reason: 'namespace-helper-missing', closed: true, notStarted: true,
        }), true);
    }
    const result = await runProbeProcess(spawn, python, [probeScript],
        { stdio: ['ignore', 'pipe', 'pipe'], env: process.env }, BUDGET, options);
    if (!result.ok) {
        return publish(unavailable(result.error, {
            reason: result.reason, closed: result.closed === true,
            cleanupUnconfirmed: result.cleanupUnconfirmed === true,
            notStarted: result.notStarted === true, stopError: result.stopError || null,
        }), false);
    }
    let parsed;
    try { parsed = JSON.parse(result.stdout.trim()); } catch { /* classified below */ }
    if (result.code !== 0 || result.signal) {
        const detail = parsed?.ok === false && typeof parsed.error === 'string'
            ? parsed.error : result.stderr.trim();
        const failure = unavailable(`probe exited ${result.code}${result.signal ? ` (${result.signal})` : ''}${detail ? `: ${detail.slice(0, 300)}` : ''}`, {
            reason: 'namespace-probe-exit', closed: true, cleanupUnconfirmed: false,
        });
        return publish(failure, !result.signal && Number.isInteger(result.code) && result.code > 0);
    }
    if (parsed?.ok === false && typeof parsed.error === 'string') {
        return publish(unavailable(`probe reported failure: ${parsed.error.slice(0, 300)}`, {
            reason: 'namespace-component-unavailable', closed: true, cleanupUnconfirmed: false,
        }), true);
    }
    if (parsed?.ok !== true || !Array.isArray(parsed.namespaces) ||
        !parsed.namespaces.every(namespace => typeof namespace === 'string')) {
        return publish(unavailable('probe output was not a valid namespace verdict', {
            reason: 'namespace-output-invalid', closed: true, cleanupUnconfirmed: false,
        }), false);
    }
    return publish({ at: Date.now(), namespaces: parsed.namespaces, error: null,
        closed: true, cleanupUnconfirmed: false }, true);
}

module.exports = { probeNamespaces };
