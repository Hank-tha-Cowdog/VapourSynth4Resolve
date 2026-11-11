// Neural-capability snapshot: ONE authoritative truth for Models UI,
// chatbot tools and the app reference. Levels (never skipped):
//   weights    — model files on disk
//   adapter    — vsmlrt Python adapter importable
//   backend    — ONNX backend dylib registered (core.ort)
//   load       — model loads through the adapter
//   inference  — a real frame rendered through the model  ← "usable"
// Refreshed on Models-tab open and after download/extract/remove.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { helperScript } = require('./prod-paths');
const { runProbeProcess } = require('./probe-process');
const { inspectModelForRead } = require('./model-manager');
const PROBE = () => helperScript('probe_rife.py');
const RIFE_MODEL_ID = 'vsmlrt-models-v15.16';
const MODELS_ROOT = () => path.join(os.homedir(),
    'Library/Application Support/VapourSynth-OFX', 'models');
const VS_PYTHON_DIR = () => path.join(os.homedir(),
    'Library/Application Support/VapourSynth-OFX', 'vs-python');

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

function fileState() {
    const root = path.resolve(MODELS_ROOT());
    const dir = path.join(root, RIFE_MODEL_ID);
    const rifeDir = path.join(dir, 'models', 'rife');
    const state = { weightsPresent: false, adapterInstalled: false, weightsDir: rifeDir, legacy: false };
    const blocked = (error, recovery, reason = 'model-read-unverified') => ({
        state: { ...state, error, recovery, reason }, signature: null,
    });
    try {
        // The Python helper and adapter do not accept this manager test seam.
        // Never inspect one root and silently run inference against another.
        if (path.resolve(process.env.VSRES_MODELS_ROOT || root) !== root) {
            return blocked('Custom model roots are not qualified for the neural helper.',
                'Use the supported model location; no capability helper was dispatched.', 'model-root-unqualified');
        }
        const admitted = inspectModelForRead(RIFE_MODEL_ID);
        if (admitted?.ok !== true) {
            return blocked(admitted?.error || 'Model read admission is unavailable.', admitted?.recovery);
        }
        if (path.resolve(admitted.root) !== root || path.resolve(admitted.dir) !== dir
                || !['verified', 'missing'].includes(admitted.completion)) {
            return blocked('Model read admission does not match the supported location.',
                'No capability helper was dispatched.', 'model-root-unqualified');
        }
        if (!admitted.exists) return { state, signature: null };
        state.legacy = admitted.completion === 'missing';
        const identities = [];
        const capture = info => [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs];
        const realDir = fs.realpathSync(dir);
        for (const current of [dir, path.join(dir, 'models'), rifeDir]) {
            const info = fs.lstatSync(current);
            if (!info.isDirectory() || info.isSymbolicLink()) {
                return blocked('Model weights directories must be ordinary, unlinked directories.');
            }
            if (current === dir && (info.dev !== admitted.identity?.dev || info.ino !== admitted.identity?.ino)) {
                return blocked('Model directory changed after read admission.');
            }
            const canonical = fs.realpathSync(current);
            if (canonical !== realDir && !canonical.startsWith(realDir + path.sep)) {
                return blocked('Model weights directory resolves outside its admitted container.');
            }
            identities.push([current, ...capture(info)]);
        }
        for (const name of fs.readdirSync(rifeDir).filter(name => name.endsWith('.onnx')).sort()) {
            const file = path.join(rifeDir, name);
            const info = fs.lstatSync(file);
            if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
                return blocked('Model weights must be ordinary, unshared ONNX files.');
            }
            const canonical = fs.realpathSync(file);
            if (!canonical.startsWith(realDir + path.sep)) {
                return blocked('Model weights resolve outside their admitted container.');
            }
            identities.push([file, ...capture(info)]);
            state.weightsPresent = true;
        }
        state.adapterInstalled = fs.existsSync(path.join(VS_PYTHON_DIR(), 'vsmlrt.py'));
        // Static snapshots only: extraction can still start while a previously
        // admitted neural child runs. This comparison is not a read lease.
        const completionIdentity = admitted.completionIdentity
            ? [admitted.completionIdentity.dev, admitted.completionIdentity.ino, admitted.completionIdentity.mtimeMs] : null;
        return { state, signature: JSON.stringify([admitted.completion, completionIdentity,
            identities, state.adapterInstalled]) };
    } catch (error) {
        if (error.code === 'ENOENT') return { state: { ...state, weightsPresent: false }, signature: null };
        return blocked(`Model weights could not be inspected: ${error.message}`);
    }
}

function changedAdmission(observed) {
    return { ok: false, level: 'weights', unknown: true, noAutomaticReplay: true,
        reason: observed.state.reason || 'model-read-changed', closed: true, cleanupUnconfirmed: false,
        error: observed.state.error || 'Model read admission changed during the capability check; inference is unverified.',
        observedState: observed.state,
    };
}

// Full probe (load + inference). ~seconds; run on demand, not per keystroke.
async function probeRifeCapability(options = {}, admitted) {
    const python = findPython();
    if (!python) return { ok: false, level: 'backend', error: 'no python' };
    const probe = PROBE();
    if (!probe) return { ok: false, level: 'adapter', error: 'probe_rife.py helper missing; reinstall the companion' };
    // Cold ORT/model initialization is separate from the 64x64 inference input.
    // Five minutes is a provisional operational budget, not a hardware verdict;
    // an explicit caller timeoutMs/maxOutputBytes may be larger.
    const result = await runProbeProcess(spawn, python, [probe], { stdio: ['ignore', 'pipe', 'pipe'] },
        { kind: 'neural', timeoutMs: 300_000, maxOutputBytes: 4 * 1024 * 1024 }, options);
    const after = fileState();
    if (!result.ok) return { ok: false, level: 'adapter', unknown: true,
        error: result.reason === 'probe-spawn-failed' ? result.error : `Capability unknown: ${result.error}`,
        reason: result.reason, closed: result.closed === true, cleanupUnconfirmed: result.cleanupUnconfirmed === true,
        noAutomaticReplay: true, stopError: result.stopError || null, observedState: after.state };
    if (!after.signature || admitted.signature !== after.signature) return changedAdmission(after);
    const unknown = () => ({ ok: false, level: 'adapter', unknown: true,
        reason: 'probe-unverified', closed: true, cleanupUnconfirmed: false, noAutomaticReplay: true,
        error: 'Capability unknown: weights/adapter files are present but backend/load/inference remain unverified',
        observedState: after.state });
    if (result.signal) return unknown();
    const line = result.stdout.trim().split('\n').filter(l => l.startsWith('{')).pop();
    try {
        const parsed = JSON.parse(line || 'null');
        if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object' || !LEVELS.includes(parsed.level)) return unknown();
        if (result.code === 0 && parsed.ok === true && parsed.level === 'inference') return { ...parsed, closed: true, cleanupUnconfirmed: false, observedState: after.state };
        // The actual helper intentionally emits component-failure JSON at exit1.
        if (result.code === 1 && parsed.ok === false && typeof parsed.error === 'string') return { ...parsed, closed: true, cleanupUnconfirmed: false, noAutomaticReplay: true, observedState: after.state };
        return unknown();
    } catch { return unknown(); }
}

// Level order for UI + chat truth.
const LEVELS = ['weights', 'adapter', 'backend', 'load', 'inference'];

async function capabilitySnapshot(options = {}) {
    const admitted = fileState();
    const state = admitted.state;
    if (state.error) {
        return { ok: true, rife: { level: 'weights', usable: false, unknown: true,
            detail: state.error, reason: state.reason, noAutomaticReplay: true }, state };
    }
    if (!state.weightsPresent) {
        return { ok: true, rife: { level: 'weights', usable: false,
            detail: 'model weights not downloaded yet (Models tab)' }, state };
    }
    if (!state.adapterInstalled) {
        return { ok: true, rife: { level: 'adapter', usable: false,
            detail: 'weights present but the vsmlrt adapter is not installed (run scripts/install_vsmlrt_adapter.py or the Models tab adapter install)' }, state };
    }
    const probe = await probeRifeCapability(options, admitted);
    return {
        ok: true,
        rife: {
            level: probe.level || 'weights',
            usable: probe.ok === true,
            detail: probe.ok === true
                ? `inference verified through ${probe.backend || 'vsmlrt'} (${probe.model || ''})${state.legacy ? '; manual weights, provenance unverified' : ''}`
                : (probe.error || 'capability unknown'),
            backend: probe.backend || null,
            model: probe.model || null,
            unknown: probe.unknown === true,
            reason: probe.reason || null,
            closed: probe.closed === true,
            cleanupUnconfirmed: probe.cleanupUnconfirmed === true,
            noAutomaticReplay: probe.noAutomaticReplay === true,
        },
        state: probe.observedState || state,
    };
}

module.exports = { capabilitySnapshot, LEVELS };
