// Fake-clock/stdio lifecycle tests. No child, runtime, media, UI or network runs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const file = process.env.VSRES_WORKER_TEST_SCRIPT || path.join(__dirname, 'preview-worker.js');
const source = fs.readFileSync(file, 'utf8');
const baselineOnly = process.env.VSRES_WORKER_BASELINE === '1';
function check(name, body, baseline = false) {
    if (!baselineOnly || baseline) test(name, body);
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
function observed(promise) {
    const values = [];
    promise.then(value => values.push(value));
    return values;
}

function harness(options = {}) {
    let now = 0, sequence = 0;
    const timers = new Map(), children = [];
    const clock = {
        set(fn, delay) { const id = ++sequence; timers.set(id, { fn, at: now + delay }); return id; },
        clear(id) { timers.delete(id); },
        tick(ms) {
            const end = now + ms;
            let steps = 0;
            while (true) {
                const due = [...timers.entries()].filter(([, timer]) => timer.at <= end)
                    .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
                if (!due) break;
                assert.ok(++steps < 1000, 'fake timer callbacks remain finite');
                now = due[1].at; timers.delete(due[0]); due[1].fn();
            }
            now = end;
        },
    };
    function spawn() {
        if (options.spawnThrows) throw Object.assign(Error('synthetic spawn refusal'), { code: 'ENOENT' });
        const child = new EventEmitter();
        child.pid = 1000 + children.length;
        child.writes = []; child.kills = [];
        child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
        child.stdout.setEncoding = child.stderr.setEncoding = () => {};
        child.stdin.write = text => {
            if (options.writeThrows) throw Object.assign(Error('synthetic pipe refusal'), { code: 'EPIPE' });
            child.writes.push(text); return true;
        };
        child.kill = signal => {
            child.kills.push(signal);
            if (options.killThrows) throw Object.assign(Error('synthetic kill refusal'), { code: 'EPERM' });
            return options.killAccepted !== false;
        };
        children.push(child);
        return child;
    }
    const module = { exports: {} };
    vm.runInNewContext(source, {
        module, exports: module.exports, Buffer,
        process: { env: {} },
        setTimeout: (fn, delay) => clock.set(fn, delay), clearTimeout: id => clock.clear(id),
        require(name) {
            if (name === 'child_process') return { spawn };
            if (name === 'buffer') return require(name);
            if (['fs', 'os', 'path'].includes(name)) return {}; // Original unused ports stay inert.
            throw Error('Unexpected module port: ' + name);
        },
    }, { filename: 'inert-preview-worker.js', timeout: 1000 });
    const settings = { python: '/fixture/python', renderScript: '/fixture/render.py',
        env: { FIXTURE: 'inert' }, ...options.worker };
    return { api: module.exports, worker: new module.exports.RenderWorker(settings),
        settings, clock, children, timers,
        reply(child, id, extra = {}) { child.stdout.emit('data', JSON.stringify({ id, ok: true, ...extra }) + '\n'); },
    };
}

check('baseline: silent alive worker reaches the existing 30-second render deadline', async () => {
    const h = harness();
    const result = observed(h.worker.request({ id: 1, mode: 'processed' }));
    h.clock.tick(30_000);
    assert.equal(h.children[0].kills.length, 1);
    h.children[0].emit('close', null);
    await flush();
    assert.equal(result[0].timeout, true);
    assert.equal(result[0].closureKnown, true);
    assert.equal(result[0].noAutomaticReplay, true);
}, true);

check('baseline: unframed stdout cannot accumulate beyond the explicit byte budget', async () => {
    const h = harness({ worker: { maxResponseBytes: 64 } });
    const result = observed(h.worker.request({ id: 1 }));
    h.children[0].stdout.emit('data', 'x'.repeat(65));
    assert.ok(Buffer.byteLength(h.worker.buffer, 'utf8') <= 64);
    h.children[0].emit('close', null);
    await flush();
    assert.equal(result[0].outputLimit, true);
}, true);

check('baseline: failed stop settles both promises and refuses overlapping admission', async () => {
    const h = harness({ killAccepted: false });
    const first = observed(h.worker.request({ id: 1, mode: 'processed' }));
    const second = observed(h.worker.request({ id: 2, mode: 'source' }));
    h.clock.tick(5000);
    await flush();
    assert.equal(first.length, 1);
    assert.equal(second.length, 1);
    assert.equal(first[0].closureUnknown, true);
    const refused = await h.worker.request({ id: 3 });
    assert.equal(refused.closureUnknown, true);
    assert.equal(h.children.length, 1);
}, true);

check('baseline: old stdout cannot complete a new generation with a colliding id', async () => {
    const h = harness();
    const first = h.worker.request({ id: 7 }); h.reply(h.children[0], 7); await first;
    h.worker._kill();
    const next = observed(h.worker.request({ id: 7 }));
    h.children[0].emit('close', null);
    assert.equal(h.children.length, 2);
    h.reply(h.children[0], 7, { frame: 666 });
    await flush(); assert.equal(next.length, 0);
    h.reply(h.children[1], 7, { frame: 3 });
    await flush(); assert.equal(next[0].frame, 3);
}, true);

check('baseline: dispose cannot leave an active promise pending after failed closure', async () => {
    const h = harness();
    const result = observed(h.worker.request({ id: 1 }));
    h.worker.dispose(); h.clock.tick(5000); await flush();
    assert.equal(result.length, 1);
    assert.equal(result[0].closureUnknown, true);
    assert.equal(result[0].noAutomaticReplay, true);
}, true);

check('explicit larger render budgets preserve work beyond the 30-second default', async () => {
    const h = harness();
    const result = observed(h.worker.request({ id: 1, timeoutMs: 60_000 }));
    h.clock.tick(30_001); await flush();
    assert.equal(result.length, 0); assert.equal(h.children[0].kills.length, 0);
    h.reply(h.children[0], 1); await flush(); assert.equal(result[0].ok, true);
});

check('invalid budgets refuse before dispatch or timer overflow', async () => {
    const h = harness();
    for (const timeoutMs of [null, 0, -1, Infinity, NaN, '10', 0x80000000]) {
        const result = await h.worker.request({ id: 1, timeoutMs });
        assert.equal(result.invalidBudget, true);
    }
    for (const maxResponseBytes of [null, 0, -1, 1.5, Infinity, '10', require('buffer').constants.MAX_STRING_LENGTH + 1]) {
        assert.equal((await h.worker.request({ id: 2, maxResponseBytes })).invalidBudget, true);
    }
    assert.throws(() => new h.api.RenderWorker({ ...h.settings, timeoutMs: null }), /timeoutMs/);
    assert.throws(() => new h.api.RenderWorker({ ...h.settings, closeGraceMs: 0 }), /closeGraceMs/);
    assert.throws(() => new h.api.RenderWorker({ ...h.settings, maxResponseBytes: null }), /maxResponseBytes/);
    assert.equal(h.children.length, 0); assert.equal(h.timers.size, 0);
});

check('queued expiry is independent and does not kill healthy in-flight work', async () => {
    const h = harness();
    const first = observed(h.worker.request({ id: 1, timeoutMs: 100 }));
    const queued = observed(h.worker.request({ id: 2, timeoutMs: 5 }));
    h.clock.tick(5); await flush();
    assert.equal(queued[0].timeout, true); assert.equal(first.length, 0);
    assert.equal(h.children[0].kills.length, 0);
    h.reply(h.children[0], 1); await flush(); assert.equal(first[0].ok, true);
});

check('latest-wins queue replaces only the never-dispatched middle request', async () => {
    const h = harness();
    const first = h.worker.request({ id: 1 });
    const middle = h.worker.request({ id: 2 });
    const latest = h.worker.request({ id: 3 });
    assert.equal((await middle).superseded, true);
    h.reply(h.children[0], 1); assert.equal((await first).ok, true);
    assert.equal(JSON.parse(h.children[0].writes[1]).id, 3);
    h.reply(h.children[0], 3); assert.equal((await latest).ok, true);
});

check('source priority waits for observed old close before starting its queued source', async () => {
    const h = harness();
    const chain = h.worker.request({ id: 1, mode: 'processed' });
    const src = h.worker.request({ id: 2, mode: 'source' });
    assert.equal(h.children.length, 1); assert.equal(h.worker.proc, h.children[0]);
    h.children[0].emit('close', null);
    assert.equal((await chain).superseded, true);
    assert.equal(h.children.length, 2); h.reply(h.children[1], 2);
    assert.equal((await src).ok, true);
});

check('accepted timeout termination is still pending until close is observed', async () => {
    const h = harness({ worker: { timeoutMs: 10, closeGraceMs: 5 } });
    const result = observed(h.worker.request({ id: 1 }));
    const queued = observed(h.worker.request({ id: 2, timeoutMs: 100 }));
    h.clock.tick(10); await flush(); assert.equal(result.length, 0);
    assert.equal(queued[0].noAutomaticReplay, true);
    assert.equal((await h.worker.request({ id: 3 })).closureUnknown, true);
    h.children[0].emit('close', null); await flush();
    assert.equal(result[0].timeout, true); assert.equal(result[0].closureKnown, true);
    assert.equal(result[0].noAutomaticReplay, true);
    assert.equal(h.children.length, 1, 'failed requests are not replayed on close');
    assert.equal(h.timers.size, 0);
});

check('expired close grace quarantines, and late close never replays settled work', async () => {
    const h = harness({ worker: { timeoutMs: 10, closeGraceMs: 5 } });
    const result = observed(h.worker.request({ id: 1 }));
    h.clock.tick(15); await flush(); assert.equal(result[0].closureUnknown, true);
    assert.equal((await h.worker.request({ id: 2 })).closureUnknown, true);
    h.children[0].emit('close', null); assert.equal(h.children.length, 1);
    const manual = h.worker.request({ id: 3 });
    assert.equal(h.children.length, 2); h.reply(h.children[1], 3);
    assert.equal((await manual).ok, true); assert.equal(result.length, 1);
});

check('throwing kill retains the old child and returns unknown closure without replay', async () => {
    const h = harness({ killThrows: true, worker: { timeoutMs: 10 } });
    const result = observed(h.worker.request({ id: 1 })); h.clock.tick(10); await flush();
    assert.equal(result[0].closureUnknown, true);
    assert.equal(h.worker.proc, h.children[0]);
    assert.equal((await h.worker.request({ id: 2 })).noAutomaticReplay, true);
    assert.equal(h.children.length, 1);
});

check('late old error and close cannot settle or clear a newer generation deadline', async () => {
    const h = harness({ worker: { timeoutMs: 10 } });
    const first = h.worker.request({ id: 1 }); h.reply(h.children[0], 1); await first;
    h.worker._kill(); h.children[0].emit('close', null);
    const next = observed(h.worker.request({ id: 2 }));
    h.children[0].emit('error', Object.assign(Error('late old error'), { code: 'EPIPE' }));
    h.children[0].emit('close', null); await flush(); assert.equal(next.length, 0);
    h.clock.tick(10); assert.equal(h.children[1].kills.length, 1);
    h.children[1].emit('close', null); await flush(); assert.equal(next[0].timeout, true);
});

check('many short chatter lines also consume the cumulative stdout budget', async () => {
    const h = harness({ worker: { maxResponseBytes: 64 } });
    const result = h.worker.request({ id: 1 });
    h.children[0].stdout.emit('data', 'noise\n'.repeat(16));
    assert.equal(h.children[0].kills.length, 1);
    h.children[0].emit('close', null); assert.equal((await result).outputLimit, true);
});

check('stdout retention counts UTF-8 bytes rather than JavaScript character length', async () => {
    const h = harness({ worker: { maxResponseBytes: 8 } });
    const result = h.worker.request({ id: 1 });
    h.children[0].stdout.emit('data', '😀'); h.children[0].stdout.emit('data', '😀');
    assert.equal(h.children[0].kills.length, 0);
    h.children[0].stdout.emit('data', 'x'); assert.equal(h.children[0].kills.length, 1);
    h.children[0].emit('close', null); assert.equal((await result).outputLimit, true);
});

check('default protocol budget accepts the current fixed grids and 8192-column profiles', async () => {
    const h = harness();
    const grid = () => Array.from({ length: 240 }, () => Array(64).fill(67108864));
    const profile = Array.from({ length: 8192 }, (_, x) => [x, -1.7976931348623157e308, 1.7976931348623157e308, 0.12345678901234567]);
    const scopes = { histogram: Array.from({ length: 3 }, () => Array(1024).fill(67108864)),
        wave: { planes: [grid(), grid(), grid()], luma: grid() },
        rgb: { wave: [grid(), grid(), grid()] },
        chroma: { grid: Array(128 * 128).fill(67108864) },
        columns: [profile, profile, profile], luma: { columns: profile } };
    const response = JSON.stringify({ id: 1, ok: true, scopes }) + '\n';
    assert.ok(Buffer.byteLength(response) > 1024 * 1024, 'fixture is a substantive scope-shaped line');
    const result = h.worker.request({ id: 1 });
    h.children[0].stdout.emit('data', response);
    assert.equal((await result).scopes.columns[0].length, 8192);
    assert.equal(h.children[0].kills.length, 0);
});

check('explicit response budget overrides preserve larger legitimate responses and stay off wire', async () => {
    const h = harness({ worker: { maxResponseBytes: 64 } });
    const result = h.worker.request({ id: 1, maxResponseBytes: 4096, timeoutMs: 500 });
    const wire = JSON.parse(h.children[0].writes[0]);
    assert.equal(wire.maxResponseBytes, undefined); assert.equal(wire.timeoutMs, undefined);
    h.reply(h.children[0], 1, { detail: 'x'.repeat(2048) });
    assert.equal((await result).detail.length, 2048);
    const next = h.worker.request({ id: 2, maxResponseBytes: 4096 });
    h.reply(h.children[0], 2, { detail: 'x'.repeat(2048) });
    assert.equal((await next).detail.length, 2048);
    assert.equal(h.children.length, 1, 'no healthy-worker lifetime byte cap');
});

check('malformed matched protocol responses stop rather than permit ambiguous fallback', async () => {
    const h = harness(); const result = h.worker.request({ id: 1 });
    h.children[0].stdout.emit('data', '{"id":1,"ok":"yes"}\n');
    h.children[0].emit('close', null); const reply = await result;
    assert.equal(reply.protocolError, true); assert.equal(reply.noAutomaticReplay, true);
});

check('known closed spontaneous crashes retain bounded recovery and explicit fallback admission', async () => {
    const h = harness();
    for (let id = 1; id <= 3; id++) {
        const request = h.worker.request({ id }); h.children[id - 1].emit('close', 1);
        const response = await request; assert.equal(response.closureKnown, true);
        assert.equal(response.noAutomaticReplay, false);
    }
    const result = await h.worker.request({ id: 4 });
    assert.equal(h.children.length, 3); assert.match(result.error, /repeatedly crashed/);
    assert.equal(result.closureKnown, true); assert.equal(result.noAutomaticReplay, false);
});

check('idle shutdown retains ownership until observed close', async () => {
    const h = harness({ worker: { idleMs: 10 } });
    const result = h.worker.request({ id: 1 }); h.reply(h.children[0], 1); await result;
    h.clock.tick(10); assert.equal(h.worker.proc, h.children[0]);
    h.children[0].emit('close', null); assert.equal(h.worker.proc, null);
});

check('proven failed spawn without a PID settles known closure without signalling another process', async () => {
    const h = harness(); const result = h.worker.request({ id: 1 });
    h.children[0].pid = undefined;
    h.children[0].emit('error', Object.assign(Error('synthetic missing interpreter'), { code: 'ENOENT' }));
    const reply = await result; assert.equal(reply.closureKnown, true);
    assert.equal(h.children[0].kills.length, 0); assert.equal(h.worker.proc, null);
});

check('stdio failures and script error text never permit replay or disturb a later generation', async () => {
    for (const name of ['stdin', 'stdout', 'stderr']) {
        const h = harness(); const result = h.worker.request({ id: 1 });
        const observedResult = observed(result);
        assert.doesNotThrow(() => h.children[0][name].emit('error',
            Object.assign(Error('synthetic pipe error'), { code: 'EPIPE' })));
        assert.equal(h.children[0].kills.length, 1);
        h.children[0].stderr.emit('error', Error('late error while stopping'));
        await flush(); assert.equal(observedResult.length, 0, 'accepted stop still awaits close');
        h.children[0].emit('close', null); const error = await result;
        assert.match(error.error, name === 'stdin' ? /write failed/ : /stream failed/);
        assert.equal(error.noAutomaticReplay, true); assert.equal(error.closureKnown, true);
        const script = h.worker.request({ id: 2 });
        assert.doesNotThrow(() => h.children[0][name].emit('error', Error('late old stream error')));
        assert.equal(h.children[1].kills.length, 0);
        h.reply(h.children[1], 2, { ok: false, error: 'worker exited is only text inside a script exception' });
        assert.equal((await script).noAutomaticReplay, true);
    }
});

check('cache disposal cannot create a replacement while an old child remains unconfirmed', async () => {
    const h = harness();
    const cached = h.api.getWorker('fixture', h.settings);
    const first = observed(cached.request({ id: 1 })); h.api.disposeAllWorkers();
    const retained = h.api.getWorker('fixture', h.settings);
    assert.equal(retained, cached);
    assert.equal((await retained.request({ id: 2 })).closureUnknown, true);
    assert.equal(h.children.length, 1);
    h.children[0].emit('close', null); await flush(); assert.equal(first.length, 1);
    const fresh = h.api.getWorker('fixture', h.settings);
    assert.notEqual(fresh, cached);
    const next = fresh.request({ id: 3 }); h.reply(h.children[1], 3);
    assert.equal((await next).ok, true);
});
