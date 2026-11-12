// Production path resolution — the ONE source for where the packaged app
// finds helper scripts and runtimes. Release-hardening: the packaged app
// previously resolved helper scripts via __dirname/../../scripts — inside
// app.asar, where fs.existsSync() LIES (Electron patches it) but python can
// never read them, and the scripts were not shipped at all.
//
// Resolution order (helper scripts):
//   1. <resourcesPath>/scripts/<name>  — the extraResources copy (packaged)
//   2. dev checkout fallback (repo scripts/, or a per-module dev path)
// Any candidate containing 'app.asar' is REJECTED (existsSync would return
// true for asar members while python gets ENOENT — silently-broken).
'use strict';
const fs = require('fs');
const path = require('path');

function isAsar(p) { return p.includes('app.asar'); }

// Helper (python) script location. Returns an absolute existing non-asar
// path or null (callers must fail honestly, naming the script).
function helperScript(name, devFallback) {
    const candidates = [
        process.resourcesPath ? path.join(process.resourcesPath, 'scripts', name) : null,
        devFallback || path.join(__dirname, '..', '..', 'scripts', name),
    ].filter(Boolean);
    for (const c of candidates) {
        if (isAsar(c)) continue;
        if (fs.existsSync(c)) return c;
    }
    return null;
}

// Only a physical executable outside ASAR is a usable bundled helper.
function executableFile(candidate) {
    if (!path.isAbsolute(candidate) || isAsar(candidate)) return false;
    try {
        if (!fs.lstatSync(candidate).isFile()) return false;
        fs.accessSync(candidate, fs.constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

// Runtime component resolution for the packaged app. The OFX bundle supplies
// embedded CPython; no legacy runtime interpreter tree is assumed (decision B4).
// A separately provisioned ffprobe lives in Resources/runtime/ffmpeg outside
// ASAR. Components are reported usable only when actually present.
function resolveRuntimes({ resourcesPath } = {}) {
    const res = resourcesPath || process.resourcesPath || '';
    const runtimeRoot = path.join(res, 'runtime');
    const runtimePython = path.join(runtimeRoot, 'python', 'bin', 'python3');
    const ffprobe = path.join(runtimeRoot, 'ffmpeg', 'ffprobe');
    const bundlePython = path.join(res, 'OFX', 'VapourSynth.ofx.bundle',
        'Contents', 'Frameworks', 'Python.framework', 'Versions',
        'Current', 'bin', 'python3');
    const python = [
        [runtimePython, 'runtime'],
        [bundlePython, 'ofx-bundle'],
    ].find(([p]) => !isAsar(p) && fs.existsSync(p)) || [runtimePython, 'runtime'];
    return {
        python: { path: python[0], source: python[1], exists: fs.existsSync(python[0]) },
        // pythonHome only meaningful for the legacy runtime/ standalone layout.
        pythonHome: path.join(runtimeRoot, 'python'),
        ffmpeg: { path: path.join(runtimeRoot, 'ffmpeg', 'ffmpeg'), exists: false },
        ffprobe: { path: ffprobe, exists: executableFile(ffprobe) },
        // OFX bundle ROOT — the source for the install-for-Resolve helper.
        // Packaged: Resources/OFX; dev fallback: the staged portable bundle.
        ofxBundle: (function () {
            const bundled = path.join(res, 'OFX', 'VapourSynth.ofx.bundle');
            if (res && !isAsar(bundled)
                && fs.existsSync(path.join(bundled, 'Contents', 'MacOS', 'VapourSynth.ofx'))) {
                return { path: bundled, exists: true };
            }
            const dev = path.join(__dirname, '..', '..', 'build-portable', 'portable',
                'VapourSynth.ofx.bundle');
            if (fs.existsSync(path.join(dev, 'Contents', 'MacOS', 'VapourSynth.ofx'))) {
                return { path: dev, exists: true };
            }
            return { path: bundled, exists: false };
        })(),
        // SELF-CONTAINMENT (2026-10-31): the shipped OFX bundle stages the
        // curated filter-plugin set at Contents/Plugins — prefer it; the
        // user dir (install_vendored_plugins.py output) is the dev/machine
        // fallback. A clean install resolves plugins entirely from the
        // bundle.
        vsPluginPath: (function () {
            const bundlePlugins = path.join(res, 'OFX', 'VapourSynth.ofx.bundle',
                'Contents', 'Plugins');
            if (!isAsar(bundlePlugins) && fs.existsSync(bundlePlugins)) {
                return { path: bundlePlugins, exists: true };
            }
            const userDir = path.join(require('os').homedir(),
                'Library/Application Support/VapourSynth/Plugins');
            return { path: userDir, exists: fs.existsSync(userDir) };
        })(),
    };
}

module.exports = { helperScript, resolveRuntimes, isAsar, executableFile };