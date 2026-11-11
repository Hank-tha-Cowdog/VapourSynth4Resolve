// Node wrapper: runs scripts/audit_release_payload.py under a WORKING python
// (the dev machine's `python3` is an asdf shim that exits 126 from this cwd —
// documented in docs/packaging.md). Tries, in order: PYTHON_PATH env,
// python3, /usr/bin/python3, the newest asdf-installed python. Exits with the
// audit's status so `npm run dist` fails closed on forbidden payloads.
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const script = path.join(__dirname, 'audit_release_payload.py');

function candidates() {
    const list = [];
    if (process.env.PYTHON_PATH) list.push(process.env.PYTHON_PATH);
    list.push('python3', '/usr/bin/python3');
    const asdfDir = path.join(os.homedir(), '.asdf', 'installs', 'python');
    try {
        for (const v of fs.readdirSync(asdfDir).sort().reverse()) {
            list.push(path.join(asdfDir, v, 'bin', 'python3'));
        }
    } catch { /* no asdf */ }
    return list;
}

// Probe with --version first: a BROKEN shim (asdf without an initialized
// environment prints "No version is set" and exits non-zero) must be
// skipped, not treated as an audit failure.
let chosen = null;
for (const py of candidates()) {
    const probe = spawnSync(py, ['--version'], { encoding: 'utf8' });
    if (probe.status === 0) { chosen = py; break; }
}
if (!chosen) {
    console.error('audit_release_payload: no working python interpreter found');
    process.exit(1);
}
const r = spawnSync(chosen, [script, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(r.status == null ? 1 : r.status);