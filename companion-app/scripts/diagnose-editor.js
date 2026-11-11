// Bounded CDP diagnostic for the running isolated editor instance.
// Captures renderer boot console (via reload with domains enabled),
// then: input reachability, real click effects, IPC round-trip latency,
// overlay/drag-region inspection, and JS-thread liveness.
'use strict';
const http = require('http');
const fs = require('fs');
const WebSocket = require('ws');

const R = fs.readFileSync('/tmp/vsres-ed-root.txt', 'utf8').trim();
const out = (line) => { fs.appendFileSync(`${R}/diag.txt`, line + '\n'); };

function getJson(path) {
    return new Promise((res, rej) => {
        http.get({ host: '127.0.0.1', port: PORT, path }, (r) => {
            let b = ''; r.on('data', d => b += d); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
        }).on('error', rej);
    });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
    const targets = await getJson('/json/list');
    const page = targets.find(t => t.type === 'page');
    if (!page) { out('NO PAGE TARGET: ' + JSON.stringify(targets.map(t => t.type))); process.exit(1); }
    out('PAGE: ' + page.url);
    const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
    const pending = new Map();
    let seq = 0;
    const consoleLog = [];
    ws.on('message', (raw) => {
        const m = JSON.parse(raw);
        if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
        if (m.method === 'Runtime.consoleAPICalled') {
            consoleLog.push(m.params.type + ': ' + m.params.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 300));
        }
        if (m.method === 'Log.entryAdded') {
            consoleLog.push('LOG-' + m.params.entry.level + ': ' + String(m.params.entry.text).slice(0, 300));
        }
        if (m.method === 'Runtime.exceptionThrown') {
            const d = m.params.exceptionDetails;
            consoleLog.push('EXCEPTION: ' + (d.text || '') + ' ' + ((d.exception && d.exception.description) || '').slice(0, 400));
        }
    });
    await new Promise(r => ws.on('open', r));
    const send = (method, params = {}) => new Promise((res, rej) => {
        const id = ++seq;
        pending.set(id, res);
        ws.send(JSON.stringify({ id, method, params }));
        setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('CDP timeout: ' + method)); } }, 15000);
    });
    const evaluate = async (expr, awaitPromise = false) => {
        const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise });
        return r.result ? r.result.result && r.result.result.value : undefined;
    };

    await send('Runtime.enable');
    await send('Log.enable');
    out('── reloading page with console capture ──');
    await send('Page.enable');
    await send('Page.reload');
    await sleep(5000);

    // 1. Thread liveness + basic mount state
    out('readyState: ' + await evaluate('document.readyState'));
    out('reactRootChildren: ' + await evaluate("document.getElementById('root') ? document.getElementById('root').childElementCount : 'NO ROOT'"));
    out('electron bridge: ' + await evaluate("typeof window.electron + ' keys=' + (window.electron ? Object.keys(window.electron).length : -1)"));
    out('buttons in dom: ' + await evaluate("document.querySelectorAll('button').length"));
    out('js thread alive: ' + await evaluate('1+1'));

    // 2. Input blocking: what element is at the center of a button? drag regions? pointer-events?
    out('elementAtButtonCenter: ' + await evaluate(`(() => {
        const b = document.querySelector('button');
        if (!b) return 'NO BUTTON';
        const r = b.getBoundingClientRect();
        const el = document.elementFromPoint(r.x + r.width/2, r.y + r.height/2);
        const describe = (e) => e ? e.tagName + '.' + (e.className && e.className.toString().slice(0,40)) : 'null';
        return 'button=' + describe(b) + ' topAtPoint=' + describe(el) + ' isButton=' + (el === b || b.contains(el));
    })()`));
    out('rootStyles: ' + await evaluate(`(() => {
        const root = document.getElementById('root');
        const s = getComputedStyle(root);
        return 'pointerEvents=' + s.pointerEvents + ' appRegion=' + s.webkitAppRegion + ' zIndexChildren=' + root.childElementCount;
    })()`));
    out('fullDragCover: ' + await evaluate(`(() => {
        const drag = Array.from(document.querySelectorAll('*')).filter(e => getComputedStyle(e).webkitAppRegion === 'drag');
        return drag.length + ' drag elements, largest area=' + (drag.length ? Math.max(...drag.map(e => { const r = e.getBoundingClientRect(); return r.width*r.height; })) : 0) + ' windowArea=' + (innerWidth*innerHeight);
    })()`));

    // 3. REAL click on a tab button → does UI state change?
    out('clickTest: ' + await evaluate(`(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const target = btns.find(b => /preview|chain|models|logs|settings/i.test(b.textContent)) || btns[0];
        if (!target) return 'NO TARGET';
        const before = document.activeElement && document.activeElement.tagName;
        target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        return 'clicked="' + target.textContent.trim().slice(0, 30) + '" beforeActive=' + before;
    })()`));
    await sleep(1500);
    out('uiAfterClick: ' + await evaluate(`(() => {
        const active = document.querySelector('[aria-selected="true"], [class*="active"], [class*="selected"]');
        return active ? active.textContent.trim().slice(0, 40) : 'no active marker (may be fine)';
    })()`));

    // 4. IPC round-trip (main-process responsiveness)
    out('ipcTest: ' + await evaluate(`(async () => {
        if (!window.electron || !window.electron.listModels) return 'no bridge method';
        const t0 = performance.now();
        try {
            const r = await Promise.race([
                window.electron.listModels(),
                new Promise((_, rej) => setTimeout(() => rej(new Error('IPC TIMEOUT 5000ms')), 5000)),
            ]);
            return 'ok in ' + Math.round(performance.now() - t0) + 'ms ok=' + (r && r.ok);
        } catch (e) { return 'FAILED: ' + e.message; }
    })()`, true));

    // 5. Console evidence (boot + our probes)
    out('── console capture (' + consoleLog.length + ' entries) ──');
    for (const l of consoleLog.slice(0, 60)) out('  ' + l);
    ws.close();
    process.exit(0);
}
main().catch(e => { out('DIAG ERROR: ' + e.message); process.exit(1); });