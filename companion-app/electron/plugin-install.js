// Install/uninstall glue for the OFX plugin, driven by the bundled
// zero-dependency `vsres-install` helper (ships at Resources/bin/vsres-install).
//
// Everything here is injectable so the test suite drives it without spawning
// anything real: path resolution takes its roots as arguments, arg
// construction and output parsing are pure, and runInstaller accepts the
// spawn implementation. main.js supplies the real spawn and the trust gate.
//
// Trust model: the helper refuses while Resolve is running, verifies the
// source bundle's signature (codesign --deep --strict + TeamIdentifier) and
// performs privilege escalation itself via one explicit macOS authorization
// dialog. This module never builds shell strings and always passes discrete
// argv elements.
'use strict';
const path = require('path');
const { executableFile } = require('./prod-paths');

const ACTIONS = new Set(['status', 'install', 'uninstall']);

/** Locate the helper: packaged Resources/bin first, then dev cargo outputs. */
function resolveInstallHelper({ resourcesPath = process.resourcesPath, devRoot = path.join(__dirname, '..', '..') } = {}) {
    const candidates = [
        resourcesPath ? path.join(resourcesPath, 'bin', 'vsres-install') : null,
        path.join(devRoot, 'tools', 'vsres-install', 'target', 'release', 'vsres-install'),
        path.join(devRoot, 'tools', 'vsres-install', 'target', 'debug', 'vsres-install'),
    ].filter(Boolean);
    for (const c of candidates) {
        if (executableFile(c)) return c;
    }
    return null;
}

/** Discrete argv for the helper. Throws on misuse so callers fail closed. */
function buildArgs(action, { bundlePath, tomlHelper } = {}) {
    if (!ACTIONS.has(action)) throw new Error(`unknown install action: ${action}`);
    const args = [action];
    if (action === 'install') {
        if (!bundlePath) throw new Error('install requires the embedded OFX bundle path');
        args.push('--source', bundlePath);
        if (tomlHelper) args.push('--toml-helper', tomlHelper);
    }
    return args;
}

/** The helper prints one JSON object; tolerate leading noise, reject garbage. */
function parseInstallerOutput(stdout, code) {
    const lines = String(stdout || '').split('\n').map(s => s.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
        try {
            const parsed = JSON.parse(lines[i]);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                if (typeof parsed.ok !== 'boolean') parsed.ok = code === 0;
                return parsed;
            }
        } catch { /* not the JSON line; keep looking */ }
    }
    return {
        ok: false,
        error: code === 0
            ? 'installer produced no JSON output'
            : `installer exited with code ${code} and no output`,
    };
}

/** Spawn + collect. Injectable spawnImpl; resolves to the parsed result. */
function runInstaller({ spawnImpl, helper, args, timeoutMs = 180000 }) {
    return new Promise(resolve => {
        let child;
        try {
            child = spawnImpl(helper, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (err) {
            resolve({ ok: false, error: `installer failed to start: ${err}` });
            return;
        }
        let stdout = '';
        let stderr = '';
        let done = false;
        const finish = value => { if (!done) { done = true; resolve(value); } };
        const timer = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch { /* already gone */ }
            finish({ ok: false, error: 'installer timed out (is an authorization dialog waiting?)' });
        }, timeoutMs);
        if (timer.unref) timer.unref();
        child.stdout?.on('data', d => { stdout += d; });
        child.stderr?.on('data', d => { stderr += d; });
        child.on('error', err => {
            clearTimeout(timer);
            finish({ ok: false, error: `installer failed to start: ${err}` });
        });
        child.on('close', code => {
            clearTimeout(timer);
            const parsed = parseInstallerOutput(stdout, code);
            if (!parsed.ok && !parsed.error && stderr.trim()) parsed.error = stderr.trim().slice(0, 400);
            finish(parsed);
        });
    });
}

module.exports = { resolveInstallHelper, buildArgs, parseInstallerOutput, runInstaller, ACTIONS };
