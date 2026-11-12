// render-queue.js — sequential render queue for composed chains, executed by
// the BUNDLED runtimes (`vspipe -c y4m … | ffmpeg …`) with no Resolve
// dependency. This is the "batch/queue" backend (beta-batch, 2026-11-12).
//
// Provenance: a job renders the node's COMPOSED script (the plugin's own
// canonical output at nodes/<guid>.vpy, or a user-picked .vpy) — the same
// artifact the OFX render path evaluates. The queue does not recompose;
// what you reviewed and approved is what renders.
//
// Pipeline (proven 2026-11-12 against the staged bundle): the bundled CPython
// runs scripts/render_chain_runner.py on the vapoursynth module's native
// output() writer (any format — RGB/YUV/Gray, any depth, alpha), piped as
// RAWVIDEO into the bundled ffmpeg with H.273 color tags carried through.
// VAPOURSYNTH_EXTRA_PLUGIN_PATH points at the bundle's curated plugin set.
//
// Encoding presets are LGPL-native ffmpeg encoders (ProRes 422 HQ / FFV1 —
// the editorial masters this tool exists to write; finescale H.264 stays a
// system-ffmpeg option rather than shipping a GPL encoder).
//
// Everything spawn- and clock-dependent is injectable for tests.

'use strict';

const fs = require('fs');
const path = require('path');

const ENCODERS = {
    prores: {
        extension: '.mov', label: 'ProRes 422 HQ (10-bit 4:2:2)',
        args: ['-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le'],
    },
    ffv1: {
        extension: '.mkv', label: 'FFV1 (lossless)',
        args: ['-c:v', 'ffv1', '-level', '3', '-pix_fmt', 'yuv422p10le'],
    },
    h264: {
        extension: '.mp4', label: 'H.264 (system ffmpeg)',
        args: ['-c:v', 'libx264', '-crf', '16', '-preset', 'slow', '-pix_fmt', 'yuv420p'],
    },
};

const MAX_SCRIPT_BYTES = 2 * 1024 * 1024;
const STATES = ['queued', 'running', 'done', 'error', 'cancelled', 'interrupted'];

function marker() { return 'rq-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8); }

function createRenderQueue(options = {}) {
    const {
        spawnImpl,                        // (cmd, argv, opts) => ChildProcess-like
        resolveRuntimes,                  // () => { vspipe, ffmpeg, pluginPath, configDir }
        ensureRuntimeConfig,              // () => void  (regenerates the vapoursynth.toml)
        jobsFile = null,                  // optional persistence path
        emit = () => {},                  // (event) => void
        now = () => Date.now(),
        killGraceMs = 4000,
        setTimeoutImpl = setTimeout,
    } = options;
    if (typeof spawnImpl !== 'function') throw new Error('createRenderQueue requires spawnImpl');

    let jobs = [];
    let running = null;      // { job, procs, cancelled }
    let loaded = false;

    const persist = () => {
        if (!jobsFile) return;
        try {
            const tmp = jobsFile + '.tmp-' + process.pid;
            fs.writeFileSync(tmp, JSON.stringify({ schemaVersion: 1, jobs }, null, 1), { mode: 0o600 });
            fs.renameSync(tmp, jobsFile);
        } catch { /* queue persistence is best-effort; never fail a job on it */ }
    };
    const load = () => {
        if (loaded) return; loaded = true;
        if (!jobsFile) return;
        try {
            const data = JSON.parse(fs.readFileSync(jobsFile, 'utf8'));
            if (!data || data.schemaVersion !== 1 || !Array.isArray(data.jobs)) return;
            jobs = data.jobs.filter(j => j && typeof j.id === 'string' && STATES.includes(j.state))
                .map(j => (j.state === 'running' || j.state === 'queued') ? { ...j, state: 'interrupted' } : j);
        } catch { /* absent/corrupt queue file → empty queue */ }
    };
    const snapshot = () => jobs.map(j => ({ ...j }));
    const find = id => jobs.find(j => j.id === id);
    const notify = () => emit({ type: 'queue', jobs: snapshot() });

    function validateAdd(request) {
        if (!request || typeof request !== 'object') return { ok: false, error: 'invalid render request' };
        const scriptPath = request.scriptPath;
        if (typeof scriptPath !== 'string' || !path.isAbsolute(scriptPath) || !scriptPath.endsWith('.vpy')) {
            return { ok: false, error: 'scriptPath must be an absolute .vpy path' };
        }
        let stat;
        try { stat = fs.statSync(scriptPath); } catch { return { ok: false, error: 'composed script not found' }; }
        if (!stat.isFile()) return { ok: false, error: 'composed script is not a file' };
        if (stat.size > MAX_SCRIPT_BYTES) return { ok: false, error: 'composed script exceeds the size cap' };
        const encoder = request.encoder ?? 'prores';
        if (!Object.prototype.hasOwnProperty.call(ENCODERS, encoder)) {
            return { ok: false, error: `unknown encoder "${encoder}" (expected ${Object.keys(ENCODERS).join(', ')})` };
        }
        let outputPath = request.outputPath;
        if (typeof outputPath !== 'string' || !path.isAbsolute(outputPath)) {
            return { ok: false, error: 'outputPath must be an absolute path' };
        }
        if (!outputPath.endsWith(ENCODERS[encoder].extension)) outputPath += ENCODERS[encoder].extension;
        if (!request.overwrite && fs.existsSync(outputPath)) {
            return { ok: false, error: 'output already exists (enable overwrite to replace it)' };
        }
        try {
            const dir = path.dirname(outputPath);
            fs.accessSync(dir, fs.constants.W_OK);
        } catch { return { ok: false, error: 'output directory is not writable' }; }
        return { ok: true, job: {
            id: marker(), state: 'queued', encoder, scriptPath, outputPath,
            label: typeof request.label === 'string' ? request.label.slice(0, 160) : path.basename(scriptPath),
            addedAt: now(), progress: null, error: null, exitCodes: null,
        } };
    }

    function add(request) {
        load();
        const verdict = validateAdd(request);
        if (!verdict.ok) return verdict;
        jobs.push(verdict.job);
        persist(); notify();
        pump();
        return { ok: true, id: verdict.job.id };
    }

    function remove(id) {
        load();
        if (running && running.job.id === id) return { ok: false, error: 'job is running; cancel it first' };
        const before = jobs.length;
        jobs = jobs.filter(j => j.id !== id);
        if (jobs.length === before) return { ok: false, error: 'no such job' };
        persist(); notify();
        return { ok: true };
    }

    function cancel(id) {
        load();
        const job = find(id);
        if (!job) return { ok: false, error: 'no such job' };
        if (running && running.job.id === id) {
            running.cancelled = true;
            const killAll = (signal) => {
                for (const proc of Object.values(running?.procs || {})) {
                    try { proc?.kill(signal); } catch { /* already gone */ }
                }
            };
            killAll('SIGTERM');
            setTimeoutImpl(() => killAll('SIGKILL'), killGraceMs);
            return { ok: true, cancelling: true };
        }
        if (job.state === 'queued' || job.state === 'interrupted') {
            job.state = 'cancelled'; persist(); notify();
            return { ok: true };
        }
        return { ok: false, error: `job is ${job.state}` };
    }

    function clearFinished() {
        load();
        const before = jobs.length;
        jobs = jobs.filter(j => !['done', 'error', 'cancelled', 'interrupted'].includes(j.state));
        persist(); notify();
        return { ok: true, removed: before - jobs.length };
    }

    function parseProgress(line) {
        // vspipe -p emits: "Frame: 123/456 (27.0%)  ..." on stderr
        const m = /Frame:\s*(\d+)\/(\d+)\s*\(([\d.]+)%\)/.exec(line);
        if (!m) return null;
        return { frame: Number(m[1]), total: Number(m[2]), percent: Number(m[3]) };
    }

    function tail(text) { return String(text || '').trim().split('\n').slice(-4).join('\n'); }

    function failJob(job, message) {
        job.state = 'error';
        job.error = message;
        job.finishedAt = now();
        running = null;
        persist(); notify();
        emit({ type: 'job', job: { ...job } });
        pump();
    }

    function pump() {
        if (running) return;
        load();
        const job = jobs.find(j => j.state === 'queued');
        if (!job) return;
        const rt = resolveRuntimes();
        if (!rt || !rt.python || !rt.runner || !rt.ffmpeg) {
            job.state = 'error';
            job.error = 'bundled render runtimes are not available — reinstall the app runtime';
            persist(); notify();
            return pump();
        }
        job.state = 'running';
        job.startedAt = now();
        job.progress = null;
        running = { job, procs: {}, cancelled: false, phase: 'info' };
        persist(); notify();
        emit({ type: 'job', job: { ...job } });

        const env = {
            HOME: process.env.HOME || '',
            PATH: '/usr/bin:/bin',   // runtimes are absolute paths
            VAPOURSYNTH_EXTRA_PLUGIN_PATH: rt.pluginPath,
        };

        // Phase 1 — clip info: the composed script decides its own geometry,
        // frame rate, pix_fmt and color tags; ffmpeg must be told before the
        // first byte of rawvideo flows.
        const info = spawnImpl(rt.python, [rt.runner, '--info', job.scriptPath],
            { stdio: ['ignore', 'pipe', 'pipe'], env });
        running.procs.info = info;
        let infoOut = '';
        let infoErr = '';
        info.stdout.on('data', (b) => { infoOut = (infoOut + String(b)).slice(-65536); });
        info.stderr.on('data', (b) => { infoErr = (infoErr + String(b)).slice(-16384); });
        info.on('error', (e) => { infoErr += '\nspawn: ' + (e?.message || e); });
        info.on('exit', (code) => {
            if (!running) return;
            const j = running.job;
            if (running.cancelled) {
                running = null;
                j.state = 'cancelled'; j.finishedAt = now();
                persist(); notify(); emit({ type: 'job', job: { ...j } });
                return pump();
            }
            if (code !== 0) return failJob(j, `composed script check failed (${code}): ${tail(infoErr) || 'no output'}`);
            let parsed = null;
            try { parsed = JSON.parse(infoOut.trim().split('\n').pop()); } catch { /* below */ }
            if (!parsed || !Number.isFinite(parsed.width) || !Number.isFinite(parsed.height)
                || typeof parsed.pix_fmt !== 'string' || !parsed.pix_fmt) {
                return failJob(j, 'the composed script reported no usable video info');
            }
            j.clipInfo = { width: parsed.width, height: parsed.height, frames: parsed.frames,
                pixFmt: parsed.pix_fmt, formatName: parsed.format || null };
            startRender(rt, j, parsed, env);
        });
    }

    function startRender(rt, job, info, env) {
        running.phase = 'render';
        const ffArgs = ['-y', '-hide_banner', '-loglevel', 'error',
            '-f', 'rawvideo', '-pix_fmt', info.pix_fmt,
            '-s', `${info.width}x${info.height}`, '-r', `${info.fps_num}/${info.fps_den}`];
        // H.273 tags carried from the chain's frame properties (numeric codes
        // are valid -colorspace/-color_trc/-color_primaries/-color_range values).
        if (Number.isInteger(info.matrix) && info.matrix >= 0) ffArgs.push('-colorspace', String(info.matrix));
        if (Number.isInteger(info.transfer) && info.transfer >= 0) ffArgs.push('-color_trc', String(info.transfer));
        if (Number.isInteger(info.primaries) && info.primaries >= 0) ffArgs.push('-color_primaries', String(info.primaries));
        if (Number.isInteger(info.range) && info.range >= 0) ffArgs.push('-color_range', String(info.range));
        ffArgs.push('-i', '-', ...ENCODERS[job.encoder].args, job.outputPath);

        const vs = spawnImpl(rt.python, [rt.runner, job.scriptPath],
            { stdio: ['ignore', 'pipe', 'pipe'], env });
        const ff = spawnImpl(rt.ffmpeg, ffArgs, { stdio: ['pipe', 'ignore', 'pipe'], env });
        running.procs = { ...running.procs, render: vs, ffmpeg: ff };
        notify();

        let renderErr = '';
        let ffmpegErr = '';
        const concluded = new Set();

        // Idempotent per child: a killed process may surface 'error' and
        // 'exit' (or an extra exit from a kill escalation) — conclude at
        // most once per child and only while this run is still current.
        const conclude = (who, code) => {
            if (!running || concluded.has(who)) return;
            concluded.add(who);
            job.exitCodes = { ...(job.exitCodes || {}), [who]: code };
            if (concluded.size < 2) return;
            const { job: j, cancelled } = running;
            running = null;
            if (cancelled) {
                j.state = 'cancelled'; j.error = null;
            } else if (j.exitCodes.render === 0 && j.exitCodes.ffmpeg === 0) {
                j.state = 'done'; j.error = null;
                try { j.bytes = fs.statSync(j.outputPath).size; } catch {}
            } else {
                j.state = 'error';
                j.error = j.exitCodes.render !== 0
                    ? `render failed (${j.exitCodes.render}): ${tail(renderErr) || 'no output'}`
                    : `ffmpeg failed (${j.exitCodes.ffmpeg}): ${tail(ffmpegErr) || 'no output'}`;
            }
            j.finishedAt = now();
            persist(); notify();
            emit({ type: 'job', job: { ...j } });
            pump();
        };

        vs.stdout.pipe(ff.stdin);
        // If ffmpeg dies first, the renderer would otherwise block forever on a full pipe.
        ff.on?.('exit', () => { try { vs.stdout.unpipe(ff.stdin); } catch {} });
        vs.stderr.on('data', (buf) => {
            const text = String(buf);
            renderErr = (renderErr + text).slice(-16384);
            for (const line of text.split('\n')) {
                const p = parseProgress(line);
                if (p) {
                    job.progress = p;
                    emit({ type: 'progress', id: job.id, progress: p });
                }
            }
        });
        ff.stderr.on('data', (buf) => { ffmpegErr = (ffmpegErr + String(buf)).slice(-16384); });
        vs.on('exit', (code) => conclude('render', code ?? 128));
        ff.on('exit', (code) => conclude('ffmpeg', code ?? 128));
        // A spawn failure must not hang the queue: record it and conclude
        // this child (127 = command not found).
        vs.on('error', (e) => { renderErr += '\nspawn: ' + (e?.message || e); conclude('render', 127); });
        ff.on('error', (e) => { ffmpegErr += '\nspawn: ' + (e?.message || e); conclude('ffmpeg', 127); });
    }

    load();
    return {
        add, cancel, remove, clearFinished,
        list: () => { load(); return snapshot(); },
        find: (id) => { load(); const j = find(id); return j ? { ...j } : null; },
        encoders: () => Object.fromEntries(Object.entries(ENCODERS).map(([k, v]) => [k, { label: v.label, extension: v.extension }])),
        _internals: { parseProgress, pump },
    };
}

module.exports = { createRenderQueue, ENCODERS, MAX_SCRIPT_BYTES };
