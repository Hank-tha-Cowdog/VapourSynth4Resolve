// EDITOR LOCK regressions — REAL Electron launches of the actual editor
// (real main process, real preload, real built renderer, real IPC), in an
// ISOLATED HOME with temp session files. Not stubs, not helper functions:
// the production single-window path end to end, including the owner's
// 2026-10-29 failure class (a wedged-but-alive editor stealing Configure).
//
//   1. fresh launch (no lock)  → editor ready, responsive, lock written.
//   2. healthy editor + second Configure (same guid) → DEFERS (sentinel +
//      exit), the healthy editor stays the owner.
//   3. WEDGED editor (renderer frozen via CDP while(true), main alive) →
//      heartbeat stalls → second Configure TAKES OVER the lock and opens a
//      responsive editor. THIS is the owner's frozen-editor repair.
//   4. dead-process lock → takeover (existing behavior preserved).
const test = require('node:test');
const { terminateOwnedChild } = require('../../tests/owned_child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('http');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const APP = path.join(__dirname, '..');
const ELECTRON = path.join(APP, 'node_modules', 'electron', 'dist',
    'Electron.app', 'Contents', 'MacOS', 'Electron');
const GUID_A = 'aaaa1111-2222-3333-4444-555555555555';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'vsres-lock-'));
const HOME = path.join(ROOT, 'home');
fs.mkdirSync(HOME, { recursive: true });
const ownedChildren = new Set();

function sessionDir(name, guid) {
    const d = path.join(ROOT, name);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'config.json'),
        JSON.stringify({ schemaVersion: 1, nodeId: name, nodeGuid: guid, chain: [], mix: 1 }));
    fs.writeFileSync(path.join(d, 'result.json'), '{"schemaVersion":1,"ok":true,"applied":0}');
    fs.writeFileSync(path.join(d, 'status.json'), `{"schemaVersion":1,"sessionId":"${name}","revision":0}`);
    return d;
}

function launch(session, port) {
    const log = path.join(ROOT, `log-${path.basename(session)}-${port || 'x'}.log`);
    const out = fs.openSync(log, 'a');
    const child = spawn(ELECTRON, [
        '.',
        `--config-path=${path.join(session, 'config.json')}`,
        `--result-path=${path.join(session, 'result.json')}`,
        `--status-path=${path.join(session, 'status.json')}`,
        '--host-apply-mode=manual', '--host-recovery-required=0', '--host-config-origin=host',
        '--host-applied-revision=0', `--host-session-id=${path.basename(session)}`,
        ...(port ? [`--remote-debugging-port=${port}`] : []),
    ], { cwd: APP, env: { ...process.env, HOME, VSRES_USE_STATIC: '1',
        // ISOLATION (2026-10-31 audit): these instances launch host-manual
        // mode, whose renderer auto-discovers the source by LIVE-QUERYING the
        // machine's Resolve (resolve-api) and adopting the answer — the exact
        // channel that leaked the owner's media into the viewer journey.
        // Both seams are MANDATORY for every Electron test instance:
        // discovery off at the source, and any render binding a path outside
        // this fixture tree refused before python/media.
        VSRES_DISABLE_RESOLVE_DISCOVERY: '1',
        VSRES_ALLOWED_SOURCE_ROOTS: ROOT,
    }, detached: true, stdio: ['ignore', out, out] });
    ownedChildren.add(child);
    child.unref();
    return { child, log };
}

function cdpTargets(port) {
    return new Promise((res, rej) => {
        http.get({ host: '127.0.0.1', port, path: '/json/list' }, r => {
            let b = ''; r.on('data', d => b += d); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
        }).on('error', rej);
    });
}

async function waitReady(port, timeoutMs = 30000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        try {
            const tg = await cdpTargets(port);
            const page = tg.find(t => t.type === 'page');
            if (page) {
                const ws = new WebSocket(page.webSocketDebuggerUrl);
                await new Promise(r => ws.on('open', r));
                const ready = await new Promise((res) => {
                    const id = 1;
                    ws.on('message', raw => { const m = JSON.parse(raw); if (m.id === id) { ws.close(); res(m.result.result.value); } });
                    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate',
                        params: { expression: "document.querySelectorAll('button').length >= 40", returnByValue: true } }));
                });
                if (ready) return true;
            }
        } catch { /* not up yet */ }
        await new Promise(r => setTimeout(r, 500));
    }
    return false;
}

async function wedgeRenderer(port) {
    // Freeze the REAL renderer's JS thread (main process stays alive):
    // the production heartbeat ping stops → the lock goes stale.
    const tg = await cdpTargets(port);
    const page = tg.find(t => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise(r => ws.on('open', r));
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate',
        params: { expression: 'while (true) {}', returnByValue: true } }));
    // Never replies (thread wedged) — close the socket from our side.
    await new Promise(r => setTimeout(r, 1500));
    ws.terminate();
}

const lockPath = () => path.join(HOME, 'Library/Application Support/VapourSynth-OFX/locks', `${GUID_A}.lock`);
const readLock = () => { try { return JSON.parse(fs.readFileSync(lockPath(), 'utf8')); } catch { return null; } };

test.after(async () => {
    await Promise.all([...ownedChildren].map(child =>
        terminateOwnedChild(child, { group: true })));
    ownedChildren.clear();
    fs.rmSync(ROOT, { recursive: true, force: true });
});

test('1. fresh launch: lock written with heartbeat; editor ready', async () => {
    const s = sessionDir('s1', GUID_A);
    launch(s, 9231);
    assert.ok(await waitReady(9231), 'editor mounted (real renderer)');
    // ISOLATION REGRESSION (2026-10-31 audit): this suite launches
    // host-manual editors whose renderer would otherwise live-query the
    // MACHINE'S running Resolve on mount. Prove THIS instance cannot: the
    // discovery seam must answer 'disabled' from inside the real app.
    {
        const tg = await cdpTargets(9231);
        const page = tg.find(t => t.type === 'page');
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise(r => ws.on('open', r));
        const verdict = await new Promise((res) => {
            ws.on('message', raw => { const m = JSON.parse(raw); if (m.id === 11) { ws.close(); res(m.result.result.value); } });
            ws.send(JSON.stringify({ id: 11, method: 'Runtime.evaluate', params: { awaitPromise: true, returnByValue: true,
                expression: "window.electron.queryCurrentClip().then(r => JSON.stringify(r))" } }));
        });
        const parsed = JSON.parse(verdict);
        assert.equal(parsed.ok, false, 'live Resolve discovery must be disabled in test instances');
        assert.match(parsed.error, /isolated session/, 'the seam marker, not a live query result');
    }
    const lock = readLock();
    assert.ok(lock && Number.isInteger(lock.pid), 'lock has pid');
    assert.ok(Number.isFinite(lock.heartbeat), 'lock carries a heartbeat');
    // The renderer ping is the freshness proof: it must ADVANCE while the
    // editor is usable (main's interval must NOT be what keeps it fresh).
    const h1 = readLock().heartbeat;
    await new Promise(r => setTimeout(r, 4000));
    const lock2 = readLock();
    assert.ok(lock2.heartbeat > h1, 'heartbeat advanced via the renderer ping');
    assert.equal(lock2.pid, lock.pid, 'same owner while healthy');
});

test('2. healthy editor + second Configure: DEFERS (sentinel, no takeover)', async () => {
    const before = readLock();
    const s = sessionDir('s1', GUID_A);       // SAME guid — second Configure
    const { log } = launch(s, 9232);
    await new Promise(r => setTimeout(r, 6000));
    const text = fs.readFileSync(log, 'utf8');
    assert.match(text, /already has an editor .* activating it and exiting/, 'deferred to the healthy owner');
    const after = readLock();
    assert.equal(after.pid, before.pid, 'lock NOT taken over from a healthy editor');
    // NOTE: the sentinel is CONSUMED by the healthy editor's 500ms activate
    // poll (show/focus + unlink) — transient by design. The durable proof of
    // correct deferral is: the defer log line + the lock still owned by the
    // healthy pid (both asserted above).
});

test('3. WEDGED editor (renderer frozen, main alive): heartbeat goes STALE and second Configure TAKES OVER', async () => {
    const wedgedPid = readLock().pid;
    fs.writeFileSync(path.join(ROOT, 'wedged-pid.json'), JSON.stringify({ pid: wedgedPid }));
    await wedgeRenderer(9231);               // freeze the REAL renderer thread
    // GENUINE staleness: renderer pings stopped; main rewrites the lock but
    // never advances freshness. Freshness (15s) AND the startup grace (30s)
    // must both lapse before takeover — wait past both.
    const hAtWedge = readLock().heartbeat;
    await new Promise(r => setTimeout(r, 33_000));
    const aged = readLock().heartbeat;
    assert.equal(aged, hAtWedge, 'frozen renderer stops advancing the heartbeat (main must not fake freshness)');
    assert.ok(Date.now() - aged >= 30_000, 'lock is beyond the startup grace');
    const s = sessionDir('s3', GUID_A);
    const { log } = launch(s, 9233);
    assert.ok(await waitReady(9233), 'takeover editor mounted and responsive');
    const text = fs.readFileSync(log, 'utf8');
    assert.match(text, /alive but UNRESPONSIVE .* taking over the lock/, 'takeover logged with the honest reason');
    const lock = readLock();
    assert.notEqual(lock.pid, hAtWedge ? JSON.parse(fs.readFileSync(path.join(ROOT, 'wedged-pid.json'), 'utf8')).pid : -1,
        'lock now owned by the healthy editor, not the wedged one');
    // The healthy takeover editor KEEPS responding (IPC round-trip via CDP).
    const tg = await cdpTargets(9233);
    const page = tg.find(t => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise(r => ws.on('open', r));
    const ipcOk = await new Promise((res) => {
        ws.on('message', raw => { const m = JSON.parse(raw); if (m.id === 7) { ws.close(); res(m.result.result.value); } });
        ws.send(JSON.stringify({ id: 7, method: 'Runtime.evaluate', params: { awaitPromise: true, returnByValue: true,
            expression: "window.electron.listModels().then(r => r && r.ok === true ? 'IPC-OK' : 'IPC-FAIL')" } }));
    });
    assert.equal(ipcOk, 'IPC-OK', 'takeover editor IPC round-trips');
});

test('4. dead-process lock: takeover (pre-existing behavior preserved)', async () => {
    fs.writeFileSync(lockPath(), JSON.stringify({ pid: 999999, heartbeat: Date.now() - 120_000 }));
    const s = sessionDir('s4', GUID_A);
    launch(s, 9234);
    assert.ok(await waitReady(9234), 'editor opens over a dead-pid lock');
    const lock = readLock();
    assert.ok(Number.isInteger(lock.pid) && lock.pid !== 999999, 'dead lock replaced');
});