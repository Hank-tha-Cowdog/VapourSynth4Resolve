// REAL-USER-JOURNEY regression — the ACTUAL Electron editor (real main,
// real preload, real built renderer, real IPC, real render worker with the
// staged bundle python), isolated HOME + synthetic media (nothing of the
// owner's). Exercises the owner journey end to end via CDP:
//   1. Preview tab renders the CHAIN at timeline geometry (draft script).
//   2. A/B GEOMETRY (R1): source PNG = the file's DISPLAY dims (SAR applied
//      exactly once); chain PNG = timeline dims — NO double correction.
//   3. SCRUB (R2): drag with several moves + release → the RELEASE position
//      survives (ref-tracked, not a stale closure); playback stays paused.
//   4. SCOPES (R6/R7): open → native signal-referred payload for the
//      selected mode; view selector switches canvases.
//   5. CHAT (R3): collapse returns width to the workspace; restore works.
//   6. STATUS (R4): title-bar icon popup opens/closes with focus return.
// Recovery: worker crash mid-journey is covered by __test_render_worker.
const test = require('node:test');
const { terminateOwnedChild } = require('../../tests/owned_child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const WebSocket = require('ws');

const APP = path.join(__dirname, '..');
const REPO = path.join(APP, '..');
const ELECTRON = path.join(APP, 'node_modules', 'electron', 'dist',
    'Electron.app', 'Contents', 'MacOS', 'Electron');
const GUID = 'beef0000-1111-2222-3333-444444444444';
// RANDOM per-run CDP port: a leftover instance from a previous run still
// owning a FIXED port made this suite connect to the STALE (already-rendered)
// app — instant false-passes then false-fails (scopes already open → no rail).
// Randomizing the port makes collisions structurally impossible.
const PORT = 9200 + Math.floor(Math.random() * 600) * 2 + 2;

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'vsres-journey-'));
const HOME = path.join(ROOT, 'home');
fs.mkdirSync(HOME, { recursive: true });
// Plugin autoload path the render script uses (~/Library/.../VapourSynth/Plugins).
const PLUGINS = path.join(HOME, 'Library', 'Application Support', 'VapourSynth', 'Plugins');
fs.mkdirSync(PLUGINS, { recursive: true });
for (const lib of ['libfpng.dylib', 'libfmtconv.dylib', 'liblsmashsource.1.dylib', 'libmiscfilters.dylib']) {
    fs.copyFileSync(path.join(REPO, 'vendor', 'Macos_vapoursynth_plugins', 'lib', lib),
        path.join(PLUGINS, lib));
}
// Synthetic anamorphic media: 720x576 SAR 16:15 → display 768x576 (4:3);
    // timeline 1920x1080 → chain at 16:9 after the script upscale.
    // Per-frame-varying content (testsrc2) so played frames are DISTINGUISHABLE
    // for playback measurement; 12s so a 10s play window never hits the end.
const MEDIA = path.join(ROOT, 'anamorphic.mov');
const ff = spawnSync('ffmpeg', ['-y', '-f', 'lavfi',
    '-i', 'testsrc2=s=720x576:r=25:d=12,format=yuv422p10le',
    '-c:v', 'prores_ks', '-profile:v', '4444',
    '-aspect', '16:15', '-an', MEDIA], { encoding: 'utf8' });
if (ff.status !== 0) {
    console.error('ffmpeg fixture failed:', (ff.stderr || '').slice(0, 200));
}

const sessionDir = () => {
    const d = path.join(ROOT, 'session');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify({
        schemaVersion: 1,
        nodeId: 'journey', nodeGuid: GUID,
        chain: [],
        mix: 1,
        colorManagement: {
            inputColorSpace: 'Rec.709', inputGamma: 'BT.1886',
            outputColorSpace: 'Rec.709', outputGamma: 'BT.1886',
        },
        clipMetadata: {
            timeline: { width: 1920, height: 1080, pixelAspectRatio: 1 },
            source: {
                filePath: MEDIA, fileName: 'anamorphic.mov',
                video: {
                    width: 720, height: 576, fps: 25, bitDepth: 10,
                    sampleAspectRatio: '16:15', displayAspectRatio: '4:3',
                    fieldOrder: 'progressive', frameCount: 300, duration: 12,
                },
                sourceInPoint: 0, sourceOutPoint: 299,
            },
        },
        archivist: {
            messages: [], panelOpen: true, panelWidth: 340,
            selectedModelId: null, autoApply: true,
        },
    }));
    fs.writeFileSync(path.join(d, 'result.json'), '{"schemaVersion":1,"ok":true,"applied":0}');
    fs.writeFileSync(path.join(d, 'status.json'), '{"schemaVersion":1,"sessionId":"journey","revision":0}');
    return d;
};

let child = null;
let ws = null;
const appLog = () => { try { return fs.readFileSync(path.join(ROOT, 'app.log'), 'utf8'); } catch { return ''; } };

function cdpEval(expression, awaitPromise = false) {
    return new Promise((resolve, reject) => {
        const id = Math.floor(Math.random() * 1e6) + 1;
        const onMsg = raw => {
            const m = JSON.parse(raw);
            if (m.id === id) {
                ws.off('message', onMsg);
                if (m.error) reject(new Error(JSON.stringify(m.error)));
                else resolve(m.result.result?.value);
            }
        };
        ws.on('message', onMsg);
        ws.send(JSON.stringify({ id, method: 'Runtime.evaluate',
            params: { expression, awaitPromise, returnByValue: true } }));
    });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

test.after(async () => {
    try { if (ws) ws.terminate(); } catch { /* fine */ }
    if (child) await terminateOwnedChild(child, { group: true });
    fs.rmSync(ROOT, { recursive: true, force: true });
});

test('real journey: geometry → A/B → scrub release → scopes → chat collapse → status popup', async () => {
    assert.equal(ff.status, 0, 'ffmpeg fixture created');
    const s = sessionDir();
    const logFd = fs.openSync(path.join(ROOT, 'app.log'), 'a');
    const env = { ...process.env };
    // SANITIZE: suites sharing this process set python/worker env at module
    // load (fixtures, one-shot pinning); the journey must launch the REAL
    // production contract, not inherit another suite's seams.
    for (const k of ['VSRES_SAMPLE_PYTHON', 'VSRES_DEV_PYTHON', 'VSRES_NO_RENDER_WORKER',
                     'VSRES_PACKAGED_SIM', 'PYTHONPATH',
                     'VAPOURSYNTH_EXTRA_PLUGIN_PATH']) delete env[k];
    env.HOME = HOME;
    env.VSRES_USE_STATIC = '1';
    // ISOLATION (root-caused 2026-10-31, fail-closed on three layers):
    //   1. VSRES_DISABLE_RESOLVE_DISCOVERY — the renderer's mount-time
    //      auto-discovery live-queries the MACHINE'S running Resolve and
    //      ADOPTS its playhead clip over this fixture (the captured leak:
    //      the owner's real media + trim composed into the draft). A HOME or
    //      userData override cannot touch that channel; the seam removes it.
    //   2. VSRES_ALLOWED_SOURCE_ROOTS — preview-companion REFUSES any render
    //      whose script binds a path outside these roots (the fixture tree +
    //      the product's fixed vs-python literal every composed draft carries).
    //      If any future channel swaps the source, the render fails closed
    //      instead of opening foreign media.
    //   3. VSRES_USER_DATA_DIR — owns Electron userData (localStorage/session
    //      still resolve to the REAL user dir regardless of HOME).
    env.VSRES_USER_DATA_DIR = path.join(ROOT, 'userdata');
    env.VSRES_DISABLE_RESOLVE_DISCOVERY = '1';
    env.VSRES_ALLOWED_SOURCE_ROOTS = [ROOT, '/Library/Application Support/VapourSynth-OFX']
        .join(path.delimiter);
    child = spawn(ELECTRON, [
        '.',
        `--config-path=${path.join(s, 'config.json')}`,
        `--result-path=${path.join(s, 'result.json')}`,
        `--status-path=${path.join(s, 'status.json')}`,
        '--host-apply-mode=manual', '--host-recovery-required=0', '--host-config-origin=host',
        '--host-applied-revision=0', '--host-session-id=journey',
        `--remote-debugging-port=${PORT}`,
    ], { cwd: APP, env,
        detached: true, stdio: ['ignore', logFd, logFd] });
    child.unref();

    // Connect CDP.
    const t0 = Date.now();
    let page = null;
    while (Date.now() - t0 < 30_000) {
        try {
            const targets = await new Promise((res, rej) => {
                http.get({ host: '127.0.0.1', port: PORT, path: '/json/list' }, r => {
                    let b = ''; r.on('data', d => b += d);
                    r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
                }).on('error', rej);
            });
            page = (targets || []).find(t => t.type === 'page');
            if (page) break;
        } catch { /* not up yet */ }
        await sleep(400);
    }
    assert.ok(page, 'CDP page target appeared');
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise(r => ws.on('open', r));

    // Wait for the app UI (buttons) + preview render capability.
    const ready = await (async () => {
        const t1 = Date.now();
        while (Date.now() - t1 < 40_000) {
            const n = await cdpEval("document.querySelectorAll('button').length");
            if (n >= 20) return true;
            await sleep(400);
        }
        return false;
    })();
    assert.ok(ready, 'editor mounted (buttons rendered)');

    // ── ISOLATION PROOF #1: this instance must be unable to reach the
    // machine's Resolve. The seam short-circuits inside main, so this CDP
    // call itself is the proof — it must come back honestly disabled and
    // must NEVER have spawned the query helper (which would read the
    // owner's live timeline).
    const discovery = JSON.parse(await cdpEval(
        "window.electron.queryCurrentClip().then(r => JSON.stringify(r))", true));
    assert.equal(discovery.ok, false, 'isolated session: discovery must be disabled');
    assert.match(discovery.error, /isolated session/,
        'the disabled marker must be the isolation seam, not a live query result');
    assert.equal(discovery.scriptingUnavailable, true);

    // ── ISOLATION PROOF #2: the editor state must hold the FIXTURE source
    // (the adoption path that caused the leak overwrote exactly this field
    // with the machine's live clip — filePath + trim handles).
    const editorState = JSON.parse(await cdpEval(
        "window.electron.getEditorConfiguration().then(c => JSON.stringify({src: c.config?.clipMetadata?.source?.filePath ?? null, trim: [c.config?.clipMetadata?.source?.sourceInPoint ?? null, c.config?.clipMetadata?.source?.sourceOutPoint ?? null]}))", true));
    assert.equal(editorState.src, MEDIA, 'fixture source preserved (no live-machine adoption)');
    assert.deepEqual(editorState.trim, [0, 299], 'fixture trim handles preserved');

    // Switch to the Preview tab (manual-host → CompanionChainPreview).
    const switched = await cdpEval(`(() => {
        const btns = [...document.querySelectorAll('button')];
        const b = btns.find(x => (x.textContent || '').toLowerCase().includes('preview'));
        if (!b) return 'no-preview-button';
        b.click(); return 'ok';
    })()`);
    assert.equal(switched, 'ok', 'preview tab clicked');

    // Wait for a rendered chain image (the draft renders on mount).
    const chainImg = await (async () => {
        const t2 = Date.now();
        while (Date.now() - t2 < 60_000) {
            const r = await cdpEval(`(() => {
                const img = document.querySelector('section[aria-label="Companion chain preview"] img');
                return img && img.src.startsWith('data:image/png') ?
                    JSON.stringify([img.naturalWidth, img.naturalHeight]) : null;
            })()`);
            if (r) return JSON.parse(r);
            await sleep(500);
        }
        return null;
    })();
    assert.ok(chainImg, 'a chain frame rendered (real worker path)');
    // R1: the chain (empty, conversion-only) is TIMELINE geometry 1920x1080 —
    // the double SAR correction (2048x1080) is gone.
    assert.deepEqual(chainImg, [1920, 1080], `chain dims ${chainImg} = timeline (no squish)`);

    // A/B: switch to Source via the segmented control.
    const srcClicked = await cdpEval(`(() => {
        const btns = [...document.querySelectorAll('button')];
        const b = btns.find(x => x.getAttribute('aria-pressed') !== null &&
            (x.getAttribute('aria-label') || x.title || '').includes('input BEFORE'));
        if (!b) return 'no-source-button';
        b.click(); return 'ok';
    })()`);
    assert.ok(srcClicked === 'ok' || srcClicked === 'no-source-button', `source control: ${srcClicked}`);
    const srcImg = await (async () => {
        const t3 = Date.now();
        while (Date.now() - t3 < 30_000) {
            const r = await cdpEval(`(() => {
                const img = document.querySelector('section[aria-label="Companion chain preview"] img');
                return img && img.src.startsWith('data:image/png') ?
                    JSON.stringify([img.naturalWidth, img.naturalHeight]) : null;
            })()`);
            if (r) {
                const d = JSON.parse(r);
                // different from the chain PNG = the source actually rendered
                if (d[0] === 768) return d;
            }
            await sleep(500);
        }
        return null;
    })();
    // Source = DISPLAY dims of the file: 720x576 SAR 16:15 → 768x576 (4:3),
    // applied EXACTLY ONCE (the R1 fix; old bug: chain double-corrected).
    assert.deepEqual(srcImg, [768, 576], `source display dims ${srcImg}`);

    // Switch back to Chain for the scrub test (playback paused state first).
    await cdpEval(`(() => {
        const btns = [...document.querySelectorAll('button')];
        const b = btns.find(x => x.getAttribute('aria-pressed') !== null &&
            (x.getAttribute('aria-label') || x.title || '').includes('processed output'));
        if (b) b.click();
        return 'ok';
    })()`);
    await sleep(2500);

    // SCRUB (R2): drag along the timeline with several moves; the RELEASE
    // position must survive (the ref-tracked time, not a stale closure).
    const scrubResult = await cdpEval(`(() => {
        const track = document.querySelector('[data-testid="scrub-track"]');
        if (!track) return 'no-track';
        const r = track.getBoundingClientRect();
        const dur = track.getAttribute('aria-valuemax');
        const mk = (type, x) => {
            const e = new PointerEvent(type, { pointerId: 7, clientX: x, clientY: r.top + 5,
                bubbles: true, isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1 });
            track.dispatchEvent(e);
        };
        mk('pointerdown', r.left + r.width * 0.1);
        mk('pointermove', r.left + r.width * 0.3);
        mk('pointermove', r.left + r.width * 0.6);
        mk('pointermove', r.left + r.width * 0.85);
        mk('pointerup', r.left + r.width * 0.85);
        return 'ok:' + dur;
    })()`);
    assert.match(String(scrubResult), /^ok:/, `scrub dispatched (${scrubResult})`);
    // The release render (chain mode = coalesced single render on release)
    // must land on the FINAL pointer position: 0.85 of the 12s clip → ~10.2s.
    const releaseTime = await (async () => {
        const t4 = Date.now();
        while (Date.now() - t4 < 30_000) {
            const txt = await cdpEval(`(() => {
                const bar = document.querySelector('[aria-label="Preview transport info"]');
                return bar ? bar.textContent : null;
            })()`);
            const m = txt && txt.match(/([0-9]+\.[0-9]{2})s/);
            if (m && Math.abs(Number(m[1]) - 10.20) < 0.35) return Number(m[1]);
            await sleep(500);
        }
        return null;
    })();
    assert.ok(releaseTime != null, `release position survived (transport shows ${releaseTime}, expected ~10.20)`);
    // Playback must NOT be running after the scrub.
    const playing = await cdpEval(`(() => {
        const bar = document.querySelector('[aria-label="Preview transport info"]');
        return bar ? (bar.textContent.includes('playing') ? 'playing' : 'paused') : 'no-bar';
    })()`);
    assert.equal(playing, 'paused', 'playback state intentional (paused) after scrub');

    // SCOPES (R6/R7): open the panel; native signal-referred metrics for the
    // selected (chain) signal; view selector present.
    // STATE-TOLERANT: Electron's renderer localStorage lives in the REAL
    // userData dir (NOT the test HOME — verified: no Electron store under
    // the test HOME), so a fresh instance can inherit scopes-open='1' from
    // a previous run. Handle BOTH rails: click "Open Scopes" if present,
    // else scopes are already open.
    const scopesOpenClick = await cdpEval(`(() => {
        const open = [...document.querySelectorAll('button')]
            .find(x => (x.getAttribute('aria-label') || '').includes('Open Scopes'));
        if (open) { open.click(); return 'clicked'; }
        const collapse = [...document.querySelectorAll('button')]
            .find(x => (x.getAttribute('aria-label') || '').includes('Collapse Scopes'));
        return collapse ? 'already-open' : 'no-button';
    })()`);
    if (scopesOpenClick === 'no-button') {
        const dump = await cdpEval(`(() => {
            const ls = Object.fromEntries(Object.entries(localStorage));
            const btns = [...document.querySelectorAll('button')].map(b =>
                (b.getAttribute('aria-label') || b.title || b.textContent || '').slice(0, 40));
            return JSON.stringify({ ls, btns: btns.filter(t => /scope/i.test(t)) });
        })()`);
        console.error('SCOPES-RAIL DUMP:', dump);
    }
    assert.notEqual(scopesOpenClick, 'no-button', 'scopes rail reachable (open or already open)');
    const scopesOk = await (async () => {
        const t5 = Date.now();
        while (Date.now() - t5 < 60_000) {
            const r = await cdpEval(`(() => {
                const el = [...document.querySelectorAll('strong,b')].find(x =>
                    (x.textContent || '').includes('Signal-referred'));
                if (el) return 'signal';
                const un = [...document.querySelectorAll('strong,b')].find(x =>
                    (x.textContent || '').includes('Native measurement unavailable'));
                if (un) return 'unavailable';
                const fb = [...document.querySelectorAll('strong,b')].find(x =>
                    (x.textContent || '').includes('Display-referred fallback'));
                return fb ? 'fallback' : null;
            })()`);
            if (r === 'signal') return r;
            await sleep(500);
        }
        return null;
    })();
    // Diagnostic dump on failure: what did the panel show?
    if (scopesOk !== 'signal') {
        const panelText = await cdpEval(`(() => {
            const el = [...document.querySelectorAll('div,strong,b,span')].find(x =>
                (x.textContent || '').includes('Measured:'));
            const root = el ? el.closest('div[style*="overflowY"], div') : document.body;
            return (root.innerText || '').slice(0, 700);
        })()`);
        console.error('SCOPES PANEL DUMP:', JSON.stringify(panelText));
        console.error('SCOPES STATE:', await cdpEval(`(() => {
            const un = [...document.querySelectorAll('strong,b')].find(x =>
                (x.textContent || '').includes('Native measurement unavailable'));
            const fb = [...document.querySelectorAll('strong,b')].find(x =>
                (x.textContent || '').includes('Display-referred fallback'));
            const sig = [...document.querySelectorAll('strong,b')].find(x =>
                (x.textContent || '').includes('Signal-referred'));
            return JSON.stringify({ unavailable: !!un, fallback: !!fb, signal: !!sig });
        })()`));
        console.error('APP LOG TAIL:', appLog().slice(-600));
    }
    assert.equal(scopesOk, 'signal', 'scopes show the native signal-referred payload');
    const viewSel = await cdpEval(`(() => {
        const g = document.querySelector('[aria-label="Scope view"]');
        return g ? g.querySelectorAll('button').length : 0;
    })()`);
    assert.equal(viewSel, 3, 'scope view selector (Histogram/Waveform/Vectorscope)');
    // Switch to the vectorscope view, then its options render (zoom/graticule/skin line).
    await cdpEval(`(() => {
        const g = document.querySelector('[aria-label="Scope view"]');
        const b = g && [...g.querySelectorAll('button')].find(x => (x.textContent || '').includes('Vectorscope'));
        if (b) b.click(); return b ? 'ok' : 'missing';
    })()`);
    const zoomButtons = await cdpEval(`(() => {
        const g = document.querySelector('[aria-label="Vectorscope display options"]');
        return g ? g.textContent.includes('Graticule') : false;
    })()`);
    assert.equal(zoomButtons, true, 'vectorscope options (zoom/graticule/skin line)');
    // Collapse scopes (state-tolerant: only needed if open).
    await cdpEval(`(() => {
        const b = [...document.querySelectorAll('button')]
            .find(x => (x.getAttribute('aria-label') || '').includes('Collapse Scopes'));
        if (b) b.click(); return 'ok';
    })()`);

    // CHAT (R3): collapse returns the width to the workspace; restore works.
    const previewWidthBefore = await cdpEval(`(() => {
        const s = document.querySelector('section[aria-label="Companion chain preview"]');
        return s ? Math.round(s.getBoundingClientRect().width) : 0;
    })()`);
    await cdpEval(`(() => {
        const b = [...document.querySelectorAll('button')]
            .find(x => (x.getAttribute('aria-label') || '').includes('Collapse Skippy chat'));
        if (b) b.click(); return b ? 'ok' : 'no-button';
    })()`);
    await sleep(600);
    const previewWidthCollapsed = await cdpEval(`(() => {
        const s = document.querySelector('section[aria-label="Companion chain preview"]');
        return s ? Math.round(s.getBoundingClientRect().width) : 0;
    })()`);
    assert.ok(previewWidthCollapsed > previewWidthBefore,
        `collapse returned width to the preview (${previewWidthBefore} → ${previewWidthCollapsed})`);
    await cdpEval(`(() => {
        const b = [...document.querySelectorAll('button')]
            .find(x => (x.getAttribute('aria-label') || '').includes('Open Skippy'));
        if (b) b.click(); return 'ok';
    })()`);
    await sleep(600);

    // STATUS (R4): title-bar icon → popup dialog opens; Escape restores focus.
    const popup = await cdpEval(`(() => {
        const b = [...document.querySelectorAll('button')]
            .find(x => (x.getAttribute('aria-label') || '').startsWith('Plugin status:'));
        if (!b) return 'no-icon';
        b.click();
        return 'ok';
    })()`);
    assert.equal(popup, 'ok', 'title-bar status icon present + clickable');
    const dialogOpen = await cdpEval(`(async () => {
        const t0 = Date.now();
        while (Date.now() - t0 < 3000) {
            const d = document.querySelector('[aria-label="Plugin status details"]');
            if (d) return 'open';
            await new Promise(r => setTimeout(r, 150));
        }
        return 'missing';
    })()`, true);
    assert.equal(dialogOpen, 'open', 'status details popup opened');
    const closed = await cdpEval(`(() => {
        const d = document.querySelector('[aria-label="Plugin status details"]');
        if (!d) return 'missing';
        const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
        d.dispatchEvent(esc);
        return 'sent';
    })()`);
    assert.equal(closed, 'sent');
    const dialogGone = await cdpEval(`(async () => {
        const t0 = Date.now();
        while (Date.now() - t0 < 3000) {
            if (!document.querySelector('[aria-label="Plugin status details"]')) return 'closed';
            await new Promise(r => setTimeout(r, 150));
        }
        return 'still-open';
    })()`, true);
    assert.equal(dialogGone, 'closed', 'Escape closed the popup');
    // Focus returned to the trigger.
    const focusBack = await cdpEval(`(() => {
        const b = [...document.querySelectorAll('button')]
            .find(x => (x.getAttribute('aria-label') || '').startsWith('Plugin status:'));
        return b && document.activeElement === b ? 'focused' : 'not-focused';
    })()`);
    assert.equal(focusBack, 'focused', 'focus returned to the status icon');

    // No horizontal banner above the workspace (R4): the old full-width
    // "Plugin status" section is NOT rendered as a bar in the body.
    const bannerGone = await cdpEval(`(() => {
        const bars = document.querySelectorAll('section[aria-label="Plugin status"]');
        return bars.length;
    })()`);
    assert.equal(bannerGone, 0, 'no horizontal status banner in the body');

    // ── LAYOUT REGRESSION (owner reproduction): scopes open → collapse chat
    // → REOPEN chat with scopes open — the document must NEVER scroll (the
    // old bug scrolled 214px and clipped the title bar). Repeated toggles,
    // both orders.
    const scrollCheck = () => cdpEval(`(() => ({
        scrollY: window.scrollY,
        titleTop: Math.round(document.querySelector('header').getBoundingClientRect().y),
    }))()`);
    const setScopes = (open) => cdpEval(`(() => {
        const b = [...document.querySelectorAll('button')].find(x =>
            (x.getAttribute('aria-label') || '').includes(${open ? "'Open Scopes'" : "'Collapse Scopes'"}));
        if (b) { b.click(); return 'clicked'; }
        return 'no-button';
    })()`);
    const setChat = (open) => cdpEval(`(() => {
        const b = [...document.querySelectorAll('button')].find(x =>
            (x.getAttribute('aria-label') || '').includes(${open ? "'Open Skippy'" : "'Collapse Skippy chat'"}));
        if (b) { b.click(); return 'clicked'; }
        return 'no-button';
    })()`);
    for (let i = 0; i < 3; i++) {
        await setScopes(true); await sleep(500);
        await setChat(false); await sleep(400);
        await setChat(true); await sleep(400);          // the BUG trigger
        let g = await scrollCheck();
        assert.equal(g.scrollY, 0, `toggle ${i}: window did not scroll (chat reopen + scopes open)`);
        assert.ok(g.titleTop >= 0, `toggle ${i}: title bar on screen (top=${g.titleTop})`);
        await setScopes(false); await sleep(400);       // alternate order
        await setScopes(true); await sleep(400);
        g = await scrollCheck();
        assert.equal(g.scrollY, 0, `toggle ${i}: window did not scroll (scopes toggle)`);
        assert.ok(g.titleTop >= 0, `toggle ${i}: title bar on screen after scopes toggle`);
    }

    // ── WAVEFORM pixel verification (sample-density, not a filled band):
    // switch to the Waveform view; the canvas must have signal at the
    // bottom (black levels) and empty regions where no samples exist.
    await setScopes(true); await sleep(700);
    const waveView = await cdpEval(`(() => {
        const g = document.querySelector('[aria-label="Scope view"]');
        const b = g && [...g.querySelectorAll('button')].find(x => (x.textContent || '').includes('Waveform'));
        if (b) { b.click(); return 'ok'; } return 'missing';
    })()`);
    assert.equal(waveView, 'ok', 'waveform view selectable');
    await sleep(900);   // render + draw with the wave payload
    const wavePixels = await cdpEval(`(() => {
        const c = document.querySelector('canvas[aria-label*="Sample-density waveform"]');
        if (!c) return 'no-canvas';
        const ctx = c.getContext('2d');
        const w = c.width, h = c.height;
        const lum = (x, y) => { const d = ctx.getImageData(x, y, 1, 1).data; return d[0] + d[1] + d[2]; };
        // Sample the whole canvas: with a real density plot there must be
        // BOTH lit and unlit pixels (a filled band would be ~all lit).
        let lit = 0, total = 0;
        for (let y = 4; y < h - 4; y += 5) for (let x = 4; x < w - 4; x += 5) {
            total++; if (lum(x, y) > 24) lit++;
        }
        return JSON.stringify({ w, h, lit, total, ratio: lit / total });
    })()`);
    assert.notEqual(wavePixels, 'no-canvas', 'waveform canvas present (real resolution)');
    const wp = JSON.parse(wavePixels);
    assert.ok(wp.total > 100, 'canvas has real pixels to sample');
    assert.ok(wp.lit > 0, 'waveform shows signal somewhere');
    assert.ok(wp.ratio < 0.75, `waveform is density, not a solid band (lit ratio ${(wp.ratio * 100).toFixed(0)}%)`);

    // ── VECTORSCOPE calibration: 1× trace uses the FULL plot area; the
    // graticule R target must sit at its 1× position regardless of gain.
    const vectorView = await cdpEval(`(() => {
        const g = document.querySelector('[aria-label="Scope view"]');
        const b = g && [...g.querySelectorAll('button')].find(x => (x.textContent || '').includes('Vectorscope'));
        if (b) { b.click(); return 'ok'; } return 'missing';
    })()`);
    assert.equal(vectorView, 'ok', 'vectorscope view selectable');
    await sleep(800);
    const targetAt = (zoom) => cdpEval(`(() => {
        const g = document.querySelector('[aria-label="Vectorscope display options"]');
        const b = g && [...g.querySelectorAll('button')].find(x => (x.textContent || '') === ${JSON.stringify(zoom + '×')});
        if (b) b.click();
        return 'ok';
    })()`);
    await targetAt(1);
    await sleep(500);
    const ref1 = await cdpEval(`(() => {
        const c = document.querySelector('canvas[aria-label*="vectorscope"]');
        if (!c) return 'no-canvas';
        const ctx = c.getContext('2d');
        // Find the R label pixel cluster: scan for the 'R' label drawn at
        // (target.x + 7, target.y + 3). Instead: locate the rightmost lit
        // pixel of the trace at 1x (chroma spread) — must use >60% of the
        // half-width (calibrated full-area mapping).
        const w = c.width, h = c.height;
        let maxR = 0;
        for (let y = 0; y < h; y += 3) for (let x = Math.floor(w / 2); x < w; x += 3) {
            const d = ctx.getImageData(x, y, 1, 1).data;
            if (d[0] + d[1] + d[2] > 40) maxR = Math.max(maxR, x - w / 2);
        }
        return JSON.stringify({ w, half: w / 2, spread: maxR });
    })()`);
    assert.notEqual(ref1, 'no-canvas', 'vectorscope canvas present');
    const r1 = JSON.parse(ref1);
    assert.ok(r1.spread > r1.half * 0.5, `1× mapping uses the plot area (trace spread ${r1.spread}/${r1.half})`);
    // Gain changes the TRACE only: with the same signal, zoom must not move
    // the R target box — verify the label 'R' pixel position stays fixed.
    // CALIBRATED graticule check: compute the six 75% target positions
    // from the SAME formula the renderer uses (KR=0.2126, KB=0.0722), then
    // verify the target boxes are DRAWN at those positions at BOTH gains.
    // Box strokes carry alpha 0.35; radial guide lines 0.07; trace ≤1 but
    // green — the ALPHA channel at the box corners separates them cleanly.
    const targetCheck = () => cdpEval(`(async () => {
        const c = document.querySelector('canvas[aria-label*="vectorscope"], canvas[aria-label*="Chroma vectorscope"]');
        if (!c) return 'no-canvas';
        const ctx = c.getContext('2d');
        const w = c.width, h = c.height;
        const cx = w / 2, cy = h / 2;
        const ref = Math.min(w, h) / 2 - 2;
        const KR = 0.2126, KB = 0.0722, A = 0.75;
        const out = [];
        for (const [name, R, G, B] of [
            ['R', A, 0, 0], ['G', 0, A, 0], ['B', 0, 0, A],
            ['C', 0, A, A], ['M', A, 0, A], ['Y', A, A, 0],
        ]) {
            const Y = KR * R + 0.7152 * G + KB * B;
            const u = 2 * 0.5 * (B - Y) / (1 - KB);
            const v = 2 * 0.5 * (R - Y) / (1 - KR);
            const px = Math.round(cx + u * ref), py = Math.round(cy - v * ref);
            // Scan a 15px window around the expected box center for
            // stroke-alpha pixels (0.35 → a ≈ 89; radial lines 0.07 → 18;
            // labels 0.6 → 153 — window (40..120) isolates the box stroke).
            let strokePx = 0;
            for (let dy = -8; dy <= 8; dy++) for (let dx = -8; dx <= 8; dx++) {
                const a = ctx.getImageData(px + dx, py + dy, 1, 1).data[3];
                if (a > 40 && a < 130) strokePx++;
            }
            out.push([name, px, py, strokePx]);
        }
        return JSON.stringify(out);
    })()`, true);
    const setGain = (z) => cdpEval(`(async () => {
        const g = document.querySelector('[aria-label="Vectorscope display options"]');
        const b = g && [...g.querySelectorAll('button')].find(x => (x.textContent || '') === '${z}×');
        if (b) b.click();
        await new Promise(r => setTimeout(r, 400));
        return 'ok';
    })()`, true);
    await setGain(1);
    await sleep(400);
    const t1 = JSON.parse(await targetCheck());
    await setGain(4);
    await sleep(500);
    const t4 = JSON.parse(await targetCheck());
    let bad = 0;
    for (let i = 0; i < t1.length; i++) {
        const [name, , , n1] = t1[i];
        const [, , , n4] = t4[i];
        if (n1 < 8 || n4 < 8) { bad++; console.error('target', name, 'box stroke px:', n1, '(1×),', n4, '(4×)'); }
    }
    assert.equal(bad, 0, 'all six graticule target boxes drawn at 1× AND 4× (gain does not move them)');


    // ── RGB ANALYSIS CONVENTION (owner 2026-10-30): like-for-like scopes ──
    await setScopes(true); await sleep(700);
    // The PANEL ROOT text (the Measured line, Input/Analysis and counts live
    // in sibling divs inside it).
    const caption = await cdpEval(`(async () => {
        const b = [...document.querySelectorAll('button')].find(x => (x.getAttribute('aria-label')||'') === 'Collapse Scopes');
        const panel = b ? b.closest('div[style*="border-left"]') : null;
        return panel ? panel.innerText.slice(0, 900) : 'no-caption';
    })()`, true);
    assert.notEqual(caption, 'no-caption', 'scopes caption present');
    // The caption must distinguish INPUT format from ANALYSIS convention and
    // carry real per-plane counts (the '0 sampled values' bug).
    assert.match(String(caption), /Input: /, 'input format labeled');
    assert.match(String(caption), /Analysis: RGB/, 'analysis convention labeled');
    assert.match(String(caption), /Sampled per native plane:/, 'per-plane counts labeled');
    const counts = String(caption).match(/Sampled per native plane: (?:[RY]) ([\d,]+)/);
    assert.ok(counts && Number(counts[1].replace(/,/g, '')) > 0,
        'native counts are REAL (not 0): ' + JSON.stringify(String(caption).match(/Sampled[^\n]*/)));

    // Explicit Y/U/V native mode (truthful labels, not silent): switch to
    // the Waveform view so the mode row renders; the button exists (enabled
    // for YUV family input; disabled+honest for RGB family).
    await cdpEval(`(async () => {
        const g = document.querySelector('[aria-label="Scope view"]');
        const b = g && [...g.querySelectorAll('button')].find(x => (x.textContent||'').includes('Waveform'));
        if (b) b.click();
        return 'ok'; })()`, true);
    await sleep(700);
    const nativeBtn = await cdpEval(`(async () => {
        const g = document.querySelector('[aria-label="Waveform mode"]');
        const b = g && [...g.querySelectorAll('button')].find(x => (x.textContent||'').includes('Y/U/V native'));
        return b ? (b.disabled ? 'disabled' : 'enabled') : 'missing';
    })()`, true);
    assert.notEqual(nativeBtn, 'missing', 'explicit Y/U/V native mode exists (enabled or honestly disabled)');

    // ── NO HORIZONTAL OVERFLOW (owner repro): panel content fits at any
    // width — walk the panel for scrollWidth > clientWidth offenders.
    const hOver = await cdpEval(`(async () => {
        const b = [...document.querySelectorAll('button')].find(x => (x.getAttribute('aria-label')||'') === 'Collapse Scopes');
        const panel = b ? b.closest('div[style*="border-left"]') : null;
        if (!panel) return 'no-panel';
        const bad = [];
        const walk = (el, d) => {
            if (d > 16 || bad.length > 5) return;
            if (el.clientWidth > 0 && el.scrollWidth - el.clientWidth > 3)
                bad.push(el.tagName + ':' + (el.textContent||'').slice(0, 20));
            for (const c of el.children) walk(c, d + 1);
        };
        walk(panel, 0);
        return bad.length ? JSON.stringify(bad) : 'clean';
    })()`, true);
    assert.equal(hOver, 'clean', 'no horizontal overflow in the scopes panel');

    // ── LIVE SCOPE (playing): honest live label + canvas stability.
    await cdpEval(`(async () => { const t = document.querySelector('[data-testid="scrub-track"]'); const r = t.getBoundingClientRect(); const x = r.left + 3;
        t.dispatchEvent(new PointerEvent('pointerdown', {pointerId:11, clientX:x, clientY:r.top+5, bubbles:true, isPrimary:true, button:0, buttons:1}));
        t.dispatchEvent(new PointerEvent('pointerup', {pointerId:11, clientX:x, clientY:r.top+5, bubbles:true, isPrimary:true, button:0, buttons:0}));
        return 'ok'; })()`, true);
    await sleep(600);
    await cdpEval(`(async () => { const b=[...document.querySelectorAll('button')].find(x => (x.getAttribute('aria-label')||'').includes('Play transport')); if (b) b.click(); return 'ok'; })()`, true);
    let liveSeen = false, canvasMissing = 0;
    for (let i = 0; i < 120; i++) {
        const r = await cdpEval(`(async () => {
            const canvas = document.querySelector('canvas[aria-label*="Sample-density waveform"]')
                || document.querySelector('canvas[aria-label*="histogram"]')
                || document.querySelector('canvas[aria-label*="ectorscope"]');
            return JSON.stringify({ c: !!canvas, live: document.body.innerText.includes('live · frame') });
        })()`, true);
        const j = JSON.parse(r);
        if (j.live) liveSeen = true;
        if (!j.c) canvasMissing++;
        if (liveSeen && canvasMissing === 0 && i > 40) break;
        await sleep(80);
    }
    await cdpEval(`(async () => { const b=[...document.querySelectorAll('button')].find(x => (x.getAttribute('aria-label')||'').includes('Pause transport')); if (b) b.click(); return 'ok'; })()`, true);
    assert.ok(liveSeen, 'LIVE scope label appears during playback (metrics-only ~1/s refresh)');
    assert.equal(canvasMissing, 0, 'scope canvas never unmounted during playback');

    const log = appLog();
    assert.doesNotMatch(log, /render worker spawn failed/i, 'worker healthy');
});