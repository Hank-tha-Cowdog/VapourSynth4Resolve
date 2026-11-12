// vs-runtime-config.js — write the hermetic VSScript Python-discovery config
// for the BUNDLED VapourSynth runtimes.
//
// VSScript (libvsscript) locates CPython via a TOML entry keyed by the LOADED
// libvsscript's own absolute path; without it, vspipe refuses to start
// ("Python executable and library path couldn't be determined"). The entry is
// mtime-bound: VSScript only accepts it while the recorded python executable
// mtime matches the file on disk, so a re-staged bundle silently invalidates
// a stale entry. This module therefore REGENERATES the file on every queue
// start (idempotent: same content, no churn) instead of writing user config
// once.
//
// The config lives under a private XDG root owned by the app
// (<app-support>/vsconfig-xdg) — the user's real ~/.config is never touched.
// Format mirrors VSScript's parser (raw line scan of quoted strings):
//   "<libvsscript path>" = ["<python exe>", "<python framework lib>", "<mtime>"]
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_SUPPORT = () => path.join(os.homedir(), 'Library/Application Support/VapourSynth-OFX');

function defaultConfigHome() { return path.join(APP_SUPPORT(), 'vsconfig-xdg'); }

// Paths inside a staged OFX bundle.
function bundleRuntimePaths(bundlePath) {
    const contents = path.join(bundlePath, 'Contents');
    return {
        vsscript: path.join(contents, 'Resources', 'vs-python', 'vapoursynth', 'libvsscript.dylib'),
        pythonExe: path.join(contents, 'Frameworks', 'Python.framework', 'Versions', 'Current', 'bin', 'python3'),
        pythonLib: path.join(contents, 'Frameworks', 'Python.framework', 'Versions', 'Current', 'Python'),
    };
}

// Returns { ok, path, written } or { ok:false, error }. Never throws.
function ensureVapourSynthConfig({ bundlePath, configHome } = {}) {
    try {
        if (typeof bundlePath !== 'string' || !bundlePath) return { ok: false, error: 'bundlePath required' };
        const home = configHome || defaultConfigHome();
        const p = bundleRuntimePaths(bundlePath);
        for (const key of ['vsscript', 'pythonExe', 'pythonLib']) {
            if (!fs.existsSync(p[key])) return { ok: false, error: `bundle runtime missing: ${p[key]}` };
        }
        const mtime = Math.floor(fs.statSync(p.pythonExe).mtimeMs / 1000);
        const line = `"${p.vsscript}" = ["${p.pythonExe}", "${p.pythonLib}", "${mtime}"]\n`;
        const dir = path.join(home, 'vapoursynth');
        const file = path.join(dir, 'vapoursynth.toml');
        try {
            if (fs.readFileSync(file, 'utf8') === line) return { ok: true, path: file, written: false };
        } catch { /* absent or unreadable → rewrite */ }
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const tmp = file + '.tmp-' + process.pid;
        fs.writeFileSync(tmp, line, { mode: 0o600 });
        fs.renameSync(tmp, file);
        return { ok: true, path: file, written: true };
    } catch (e) {
        return { ok: false, error: e?.message || String(e) };
    }
}

module.exports = { ensureVapourSynthConfig, bundleRuntimePaths, defaultConfigHome };
