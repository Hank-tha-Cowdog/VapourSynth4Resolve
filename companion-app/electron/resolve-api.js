// Spawns resolve-query.py to ask the running DaVinci Resolve for the source file
// path of the clip at the current playhead. Result lands as parsed JSON.
//
// Locating python: macOS ships /usr/bin/python3 as part of Command Line Tools, which
// is enough to import the DaVinciResolveScript Python module (it's a pure-Python
// shim around fusionscript.so). If brew Python is installed we prefer it (faster,
// known-good).
//
// BOUNDED + FAILURE-AWARE (live crash Oct 27 15:22, DiagnosticReports
// Python-…-152216.ips): the helper loads Resolve's fusionscript.so and SIGSEGV'd
// inside Fusion::RemoteApp::FindLocalObject on Fusion's dispatch thread — a
// Fusion-side race while an external helper is connected. Contract here:
//   - ONE attempt, 15s timeout: the helper can never hang the companion.
//   - A crash/timeout is a DISTINCT 'helper failed' state (helperFailed /
//     discoveryTimeout flags) — NEVER presented as 'no clip is selected'
//     (scriptingDisabled) and never retried in a loop.
//   - The manual picker / drop path stays the usable fallback; the renderer
//     shows the error with the manual action, non-blocking.

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const { helperScript } = require('./prod-paths');
const PY_SCRIPT = () => helperScript('resolve-query.py', path.join(__dirname, 'resolve-query.py'));

const RESOLVE_LIB =
    '/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/fusionscript.so';
const RESOLVE_API =
    '/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting';

const QUERY_TIMEOUT_MS = 15_000;

function findPython() {
    const candidates = [
        '/opt/homebrew/bin/python3',
        '/usr/local/bin/python3',
        '/usr/bin/python3',
    ];
    for (const p of candidates) if (fs.existsSync(p)) return p;
    return 'python3';  // last resort: $PATH
}

function queryCurrentClip() {
    return new Promise((resolve) => {
        // TEST ISOLATION SEAM (2026-10-31 journey leak, root-caused): this
        // query reads the LIVE Resolve on this machine — the playhead clip of
        // whatever project happens to be open — and the renderer ADOPTS the
        // answer over its own config (App.tsx mount-time auto-discovery).
        // That channel bypasses HOME/userData isolation entirely, which is
        // exactly how a test instance came to compose the owner's real media
        // + trim instead of its fixture. An isolated session (viewer
        // journey) sets VSRES_DISABLE_RESOLVE_DISCOVERY so the promise
        // resolves honestly WITHOUT spawning the query helper; production
        // never sets it and this branch is dead code there.
        if (process.env.VSRES_DISABLE_RESOLVE_DISCOVERY === '1') {
            resolve({
                ok: false,
                scriptingUnavailable: true,
                error: 'Source discovery is disabled for this isolated session.',
            });
            return;
        }
        if (!PY_SCRIPT()) {
            resolve({ ok: false, error: 'resolve-query.py helper missing from this installation — reinstall the companion app.' });
            return;
        }
        if (!fs.existsSync(RESOLVE_LIB)) {
            resolve({
                ok: false,
                error: 'DaVinci Resolve is not installed at the standard path.',
                notInstalled: true,
            });
            return;
        }

        const env = { ...process.env };
        if (!env.RESOLVE_SCRIPT_API) env.RESOLVE_SCRIPT_API = RESOLVE_API;
        if (!env.RESOLVE_SCRIPT_LIB) env.RESOLVE_SCRIPT_LIB = RESOLVE_LIB;

        let settled = false;
        let out = '', err = '';
        const finish = (value) => {
            if (settled) return;  // one-shot: timeout/close/error race-safe
            settled = true;
            clearTimeout(timer);
            resolve(value);
        };
        const proc = spawn(findPython(), [PY_SCRIPT()], {
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        const timer = setTimeout(() => {
            // Fusion's scripting socket can wedge the helper; kill bounded.
            try { proc.kill('SIGKILL'); } catch { /* already gone */ }
            finish({ ok: false,
                error: 'Source discovery timed out (Resolve scripting did not answer). Use Identify source to pick the file.',
                discoveryTimeout: true });
        }, QUERY_TIMEOUT_MS);
        proc.stdout.on('data', (d) => { out += d; });
        proc.stderr.on('data', (d) => { err += d; });
        proc.on('error', (e) => {
            finish({ ok: false, error: `python spawn failed: ${e.message}`, helperFailed: true });
        });
        proc.on('close', (code, signal) => {
            // The script always emits a single JSON object to stdout and exits 0.
            // Any non-JSON output means something unexpectedly happened.
            const trimmed = out.trim();
            if (!trimmed) {
                finish({
                    ok: false,
                    // Crash/no-output: name the helper; keep the manual path.
                    error: `Source discovery helper ${signal ? `was killed (${signal})` : `exited ${code}`}${err ? `: ${err.slice(0, 200)}` : ''}. `
                        + 'This is a helper failure, not "no clip selected". Use Identify source to pick the file.',
                    helperFailed: true,
                });
                return;
            }
            try {
                const parsed = JSON.parse(trimmed);
                finish(parsed);
            } catch (e) {
                finish({
                    ok: false,
                    error: `python output was not JSON: ${trimmed.slice(0, 300)}`,
                    helperFailed: true,
                });
            }
        });
    });
}

module.exports = { queryCurrentClip };