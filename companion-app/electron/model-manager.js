// Optional neural-model manager — explicit, in-app downloads.
//
// Users must not need a terminal to obtain neural models. This manager:
//   - reads the curated registry (shared/model-registry.json — pinned
//     upstream release assets with published sha256 digests)
//   - downloads ONLY on explicit request, with progress and cancellation
//   - verifies the sha256 digest before accepting the archive
//   - extracts with a DETECTED 7z (never a downloaded/setup script); a
//     missing extractor is an honest error, never a silent skip
//   - reports the lifecycle states the UI distinguishes:
//       absent → downloading → downloaded+verified → extracted(ready)
//       (+ cancelled / failed with the real error)
//
// Model-card text is DATA. Nothing downloaded is ever executed. Files are
// stored under ~/Library/Application Support/VapourSynth-OFX/models/<id>/.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { runProbeProcess, hasPendingProbeStop } = require('./probe-process');
const stageStore = require('./model-stage-transaction');
const { MAX_STRING_LENGTH } = require('buffer').constants;

const REGISTRY = require('../shared/model-registry.json');
const MODELS_ROOT = () => process.env.VSRES_MODELS_ROOT   // isolated-fixture seam (tests only)
  ? process.env.VSRES_MODELS_ROOT
  : path.join(os.homedir(),
    'Library/Application Support/VapourSynth-OFX', 'models');

// ── ID + path safety (release-hardening: every filesystem operation goes
// through this gate) ────────────────────────────────────────────────────────
// A model id is ONLY ever a REGISTRY key. No path separators, no dots-only
// segments, no absolute paths, no unknown ids, and the resolved directory
// must remain canonically INSIDE the models root (symlink escapes included).
function validateModelId(id) {
    if (typeof id !== 'string' || !id.length) return { ok: false, error: 'model id required' };
    if (!/^[\w][\w.-]*$/.test(id)) {
        return { ok: false, error: `malformed model id: ${JSON.stringify(id).slice(0, 40)}` };
    }
    if (!REGISTRY.models.some(m => m.id === id)) {
        return { ok: false, error: `unknown model id: ${id}` };
    }
    const root = path.resolve(MODELS_ROOT());
    const dir = path.resolve(path.join(root, id));
    if (!dir.startsWith(root + path.sep)) {
        return { ok: false, error: `model directory escapes the models root — refused` };
    }
    // The model owns an ordinary container, never an alias to the root,
    // another model, or a missing/outside target. Missing ordinary paths are
    // valid download destinations; permission/type failures are not absence.
    try {
        const info = fs.lstatSync(dir);
        if (!info.isDirectory() || info.isSymbolicLink()) {
            return { ok: false, error: 'model directory must be an ordinary directory, not a symlink or other file — refused' };
        }
    } catch (error) {
        if (error.code !== 'ENOENT') return { ok: false, error: `cannot inspect model directory: ${error.message}` };
    }
    try {
        const realRoot = fs.realpathSync(root);
        const realDir = fs.realpathSync(dir);
        if (!realDir.startsWith(realRoot + path.sep)) {
            return { ok: false, error: 'model directory resolves outside or at the models root (symlink?) — refused' };
        }
    } catch (error) {
        if (error.code !== 'ENOENT') return { ok: false, error: `cannot resolve model directory: ${error.message}` };
    }
    return { ok: true, dir };
}

function find7z() {
    for (const p of ['/opt/homebrew/bin/7z', '/opt/homebrew/bin/7za', '/usr/local/bin/7z', '/usr/bin/7z']) {
        if (fs.existsSync(p)) return p;
    }
    return null;
}

function modelDir(id) { return path.join(MODELS_ROOT(), id); }

// This is a completion-record bound, not a model/archive size restriction.
// Current product markers have only four metadata fields and are far smaller.
const MAX_MODEL_MARKER_BYTES = 64 * 1024;

function markerStatus(entry, dir, name = 'extracted.json') {
    const marker = path.join(dir, name);
    const invalid = message => ({ present: true, ok: false,
        error: `Unverified model completion marker: ${message}` });
    let opened;
    try { opened = regularFileIdentity(marker); }
    catch (error) { return error.code === 'ENOENT' ? { present: false } : invalid(error.message); }
    let fd;
    let result;
    try {
        if (opened.size > MAX_MODEL_MARKER_BYTES) throw new Error('exceeds the 64 KiB completion-record limit');
        fd = fs.openSync(marker, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        const info = fs.fstatSync(fd);
        if (!info.isFile() || info.nlink !== 1 || info.dev !== opened.dev || info.ino !== opened.ino) {
            throw new Error('changed before the metadata read');
        }
        // Fixed allocation/read ceiling even if the same inode grows after stat.
        const bytes = Buffer.alloc(MAX_MODEL_MARKER_BYTES + 1);
        let used = 0;
        while (used < bytes.length) {
            const count = fs.readSync(fd, bytes, used, bytes.length - used, null);
            if (!count) break;
            used += count;
        }
        if (used > MAX_MODEL_MARKER_BYTES) throw new Error('exceeds the 64 KiB completion-record limit');
        const parsed = JSON.parse(bytes.subarray(0, used).toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
            Object.keys(parsed).sort().join(',') !== 'extractedAt,id,sha256,version' ||
            parsed.id !== entry.id || parsed.version !== entry.version || parsed.sha256 !== entry.sha256 ||
            !Number.isSafeInteger(parsed.extractedAt) || parsed.extractedAt < 0) {
            throw new Error('metadata does not match the current registry completion schema');
        }
        if (!sameRegularFile(marker, opened)) throw new Error('replaced during the metadata read');
        result = { present: true, ok: true, identity: opened };
    } catch (error) { result = invalid(error.message); }
    finally {
        if (fd !== undefined) {
            try { fs.closeSync(fd); }
            catch (error) { result = invalid(`metadata reader close failed: ${error.message}`); }
        }
    }
    return result;
}

function stateFor(entry, dir) {
    const attempt = active.get(entry.id);
    if (attempt) return { state: attempt.closureUnknown ? 'failed' : 'downloading' };
    const extraction = extracting.get(entry.id);
    if (extraction) return { state: 'failed',
        error: extraction.error || 'Extraction is in progress; model completion is unverified.',
        recovery: extraction.closureUnknown
            ? 'Owned resource close is unconfirmed. Retry and removal remain blocked until closure is observed.'
            : 'Wait for this extraction attempt to finish. Retry and removal are currently blocked.' };
    try {
        // Presence alone blocks readiness; never follow/read an aliased flag.
        fs.lstatSync(path.join(dir, UNVERIFIED_MARKER));
        return { state: 'failed', error: 'An earlier extraction did not complete verification.',
            recovery: 'Completion metadata remains unverified. Discard this model explicitly or retry extraction of its verified archive.' };
    } catch (error) {
        if (error.code !== 'ENOENT') return { state: 'failed', error: `Cannot inspect extraction status: ${error.message}`,
            recovery: 'Correct the model directory access before retrying.' };
    }
    const marker = markerStatus(entry, dir);
    if (marker.present) {
        if (marker.ok) return { state: 'ready' };
        return { state: 'failed', error: marker.error,
            recovery: 'The marker was retained. Remove this model explicitly, or extract a verified archive again; availability has not been verified.' };
    }
    if (fs.existsSync(path.join(dir, 'download.7z'))) return { state: 'downloaded' };
    if (fs.existsSync(path.join(dir, 'download.partial'))) {
        // A stale partial has no live owner: retry/remove remain explicit.
        return { state: 'interrupted' };
    }
    return { state: 'absent' };
}

// MEASURED on-disk size of an installed model directory (du-style walk,
// bytes). Shown AFTER installation so the user sees the real footprint,
// not just the registry estimate.
function measuredSize(dir) {
    let total = 0;
    const stack = [dir];
    while (stack.length) {
        const current = stack.pop();
        let entries;
        try {
            if (!fs.lstatSync(current).isDirectory()) continue;
            entries = fs.readdirSync(current, { withFileTypes: true });
        } catch { continue; }
        for (const e of entries) {
            const p = path.join(current, e.name);
            try {
                const info = fs.lstatSync(p);
                if (info.isSymbolicLink()) continue;
                if (info.isDirectory()) stack.push(p);
                else if (info.isFile()) total += info.size;
            } catch { /* unreadable entry: skip */ }
        }
    }
    return total;
}

// Explicit removal scope: exactly what will be deleted — this model's
// directory only, never unrelated user models or shared runtimes.
function removalScope(id) {
    const dir = modelDir(id);
    if (!fs.existsSync(dir)) return null;
    const files = [];
    const stack = [dir];
    while (stack.length) {
        const current = stack.pop();
        let entries;
        try {
            if (!fs.lstatSync(current).isDirectory()) continue;
            entries = fs.readdirSync(current, { withFileTypes: true });
        } catch { continue; }
        for (const e of entries) {
            const p = path.join(current, e.name);
            try {
                const info = fs.lstatSync(p);
                if (info.isDirectory()) stack.push(p);
                else files.push(p); // Count the link itself, never its target.
            } catch { /* unreadable entry: skip */ }
        }
    }
    return { dir, fileCount: files.length, bytes: measuredSize(dir) };
}

function entriesWithState() {
    return REGISTRY.models.map(entry => {
        const valid = validateModelId(entry.id);
        const dir = valid.ok ? valid.dir : null;
        const journal = stageStore.pending(path.resolve(MODELS_ROOT()), entry.id);
        const snapshot = journal.present ? { state: 'failed', error: journal.error || 'A staged model transaction is held for recovery.',
            recovery: 'Current reads, downloads, extraction and removal are blocked. Keep this app open for original-process recovery; restart inspection does not grant repair authority.' }
            : valid.ok ? stateFor(entry, dir) : { state: 'failed', error: valid.error,
                recovery: 'Correct the unsafe model container before retrying. No linked directory was read or removed.' };
        const state = snapshot.state;
        const ownedStage = extracting.get(entry.id)?.transaction;
        const retainedStorage = ownedStage ? ownedStage.notice(ownedStage.released ? 'retained' : 'held')
            : stageStore.retainedStorage(path.resolve(MODELS_ROOT()), entry.id, journal.present);
        let canDiscard = false;
        if (state === 'failed' && valid.ok && !journal.present && !active.has(entry.id) && !extracting.has(entry.id)) {
            try { modelDirectoryIdentity(dir); canDiscard = true; } catch { /* absent or unsafe container */ }
        }
        return {
            ...entry,
            ...snapshot,
            canDiscard,
            ...(retainedStorage ? { retainedStorage } : {}),
            installedDir: state === 'absent' || !valid.ok || journal.present ? null : dir,
            // Measured installed footprint (post-extract), when present.
            installedBytes: (state === 'ready' || state === 'downloaded') ? measuredSize(dir) : null,
            // Temporary extraction headroom estimate: archives need the
            // compressed payload + the extracted tree concurrently.
            tempBytesNeeded: state === 'absent' ? null
                : Math.round((entry.diskBytesNeeded || 0) * 2 + (entry.downloadBytes || 0) + stageStore.METADATA_ALLOWANCE + stageStore.DEFAULT_HEADROOM_BYTES),
        };
    });
}

const active = new Map(); // id -> one identity-bound owned transfer attempt

function listModels() {
    return { ok: true, models: entriesWithState(),
        extractionAvailable: !!find7z() };
}

// Fixed product-owned files must be ordinary, unshared files. Never follow a
// planted link or accept a different inode after asynchronous I/O.
function regularFileIdentity(file) {
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.nlink !== 1) {
        throw new Error('model file must be a regular file with one link');
    }
    return info;
}

function sameRegularFile(file, expected) {
    try {
        const info = regularFileIdentity(file);
        return info.dev === expected.dev && info.ino === expected.ino;
    } catch { return false; }
}

function sha256File(file, expected, onFailure) {
    return new Promise((resolve, reject) => {
        let fd;
        let opened, hash, stream;
        try {
            fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
            opened = fs.fstatSync(fd);
            if (!opened.isFile() || opened.nlink !== 1 ||
                (expected && (opened.dev !== expected.dev || opened.ino !== expected.ino))) {
                throw new Error('model file changed or is not a regular unshared file');
            }
            hash = crypto.createHash('sha256');
            stream = fs.createReadStream(file, { fd, autoClose: true });
        } catch (error) {
            try { onFailure?.(error); } catch { /* observer teardown */ }
            if (fd !== undefined) {
                try { fs.closeSync(fd); }
                catch {
                    // This exact acquired descriptor has no proven close. Keep
                    // the hash promise/ownership pending; the caller observes
                    // failure for5s, then reports unknown. Never retry an fd
                    // number that the OS may already have reused.
                    return;
                }
            }
            reject(error);
            return;
        }
        // end/error describe the hash outcome; only close proves this owned
        // reader has released its descriptor. Keep verification ownership until
        // then, including cancellation in the normal end-before-close gap.
        let outcome = null;
        let closed = false;
        const fail = error => {
            if (closed || outcome?.error) return;
            // A digest from end is provisional until close; a close/read error
            // overrides it. The first actual error remains authoritative.
            outcome = { error };
            try { onFailure?.(error); } catch { /* observer teardown */ }
        };
        stream.on('data', d => { if (!closed && !outcome) hash.update(d); });
        stream.on('error', fail);
        stream.on('end', () => {
            if (closed || outcome) return;
            if (!sameRegularFile(file, opened)) {
                fail(new Error('model file was replaced during verification'));
                return;
            }
            outcome = { digest: hash.digest('hex') };
        });
        stream.on('close', () => {
            if (closed) return;
            if (!outcome) fail(new Error('model reader closed before completing verification'));
            closed = true;
            if (outcome.error) reject(outcome.error);
            else resolve(outcome.digest);
        });
    });
}

function modelDirectoryIdentity(dir) {
    const info = fs.lstatSync(dir);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('model directory is no longer ordinary');
    return info;
}

function sameModelDirectory(id, dir, expected) {
    try {
        const valid = validateModelId(id);
        const info = modelDirectoryIdentity(dir);
        return valid.ok && valid.dir === dir && info.dev === expected.dev && info.ino === expected.ino;
    } catch { return false; }
}

// Fetch's redirect policy uses 20 hops; the registry itself stays immutable.
const MAX_MODEL_REDIRECTS = 20;
// Only a requested stop gets a closure-observation window. Valid downloads and
// successful slow writer-close are never converted into a timeout by this bound.
const MODEL_STOP_OBSERVE_MS = 5000;

function downloadModel(id, { onProgress }) {
    return new Promise((resolveOuter) => {
        const entry = REGISTRY.models.find(m => m.id === id);
        if (!entry) { resolveOuter({ ok: false, error: `unknown model id: ${id}` }); return; }
        const valid = validateModelId(id);
        if (!valid.ok) { resolveOuter(valid); return; }
        if (stageStore.pending(path.resolve(MODELS_ROOT()), id).present) { resolveOuter({ ok: false, error: 'model transaction recovery is pending; download was not started' }); return; }
        if (active.has(id)) { resolveOuter({ ok: false, error: 'download already in progress for this model' }); return; }
        if (extracting.has(id)) { resolveOuter({ ok: false, error: 'cannot download while extraction is in progress' }); return; }
        const record = { resources: new Set(), terminal: null, released: false,
            returned: false, cancelled: false, closureUnknown: false,
            verifying: false, writer: null, writerFinished: false,
            currentHop: null, stopTimer: null };
        const dir = valid.dir;
        const archive = path.join(dir, 'download.7z');
        const partial = path.join(dir, 'download.partial');
        let partialIdentity;
        const current = () => !record.released && active.get(id) === record;
        const notify = payload => { try { onProgress?.(payload); } catch { /* observer teardown */ } };
        const returnOnce = result => {
            if (record.returned) return;
            record.returned = true;
            resolveOuter(result);
        };
        const allClosed = () => [...record.resources].every(resource => resource.closed);
        const removeOwnedPartial = () => {
            if (partialIdentity && sameRegularFile(partial, partialIdentity)) fs.unlinkSync(partial);
        };
        const finishKnown = () => {
            if (!current() || !record.terminal || record.verifying || !allClosed()) return;
            if (record.stopTimer !== null) clearTimeout(record.stopTimer);
            let cleanupError;
            if (!record.terminal.ok) {
                try { removeOwnedPartial(); } catch (error) { cleanupError = error.message; }
            }
            const result = { ...record.terminal, closureKnown: true,
                ...(cleanupError ? { cleanupError } : {}) };
            const returnedUnknown = record.returned;
            record.released = true;
            // Late events can never delete an active record from a newer try.
            if (active.get(id) === record) active.delete(id);
            if (returnedUnknown) {
                notify({ done: true, ok: false, closureKnown: true, closureObserved: true });
            } else returnOnce(result);
        };
        const destroyOwned = resource => {
            if (!resource || resource.closed) return;
            try { resource.handle.destroy(); } catch { /* closure must still be observed */ }
        };
        const stop = outcome => {
            if (!current() || record.terminal) return;
            record.terminal = outcome;
            const response = record.currentHop?.response;
            if (response && record.writer) {
                try { response.handle.unpipe(record.writer.handle); } catch { /* already detached */ }
            }
            for (const resource of record.resources) destroyOwned(resource);
            finishKnown();
            if (!current()) return;
            record.stopTimer = setTimeout(() => {
                if (!current() || !record.terminal || (!record.verifying && allClosed())) {
                    finishKnown();
                    return;
                }
                record.closureUnknown = true;
                returnOnce({ ok: false, closureKnown: false,
                    cancellationRequested: record.cancelled,
                    error: 'Download stop could not be confirmed; retry, extraction and removal remain blocked until owned streams close.',
                    ...(record.terminal.error ? { primaryError: record.terminal.error } : {}) });
            }, MODEL_STOP_OBSERVE_MS);
        };
        const maybeVerify = () => {
            if (!current() || record.terminal || record.verifying || !record.writer ||
                !record.writerFinished || !record.writer.closed ||
                !record.currentHop?.ended || !allClosed()) return;
            record.verifying = true;
            notify({ phase: 'verifying' });
            sha256File(partial, partialIdentity, error => {
                // Observe a failed reader's close without releasing verifying.
                // A reader error without close uses the existing stop window.
                if (current() && !record.terminal) stop({ ok: false, error: `verification failed: ${error.message}` });
            }).then(digest => {
                if (!current() || record.terminal) return;
                if (digest !== entry.sha256) {
                    stop({ ok: false, error: `checksum mismatch (got ${digest.slice(0, 16)}…, expected ${entry.sha256.slice(0, 16)}…). The archive was discarded; nothing was installed.` });
                    return;
                }
                if (!sameRegularFile(partial, partialIdentity)) throw new Error('partial download was replaced before publication');
                fs.renameSync(partial, archive);
                record.terminal = { ok: true, state: 'downloaded' };
            }).catch(error => {
                if (current() && !record.terminal) stop({ ok: false, error: `verification failed: ${error.message}` });
            }).finally(() => {
                record.verifying = false;
                finishKnown();
            });
        };
        const maybeRedirect = hop => {
            if (!current() || record.terminal || !hop.redirecting || hop.followed ||
                !hop.returned || !hop.request?.closed || !hop.response?.closed) return;
            hop.followed = true;
            startHop(hop.target, hop.redirects + 1);
        };
        const track = (handle, kind, hop) => {
            const resource = { handle, kind, closed: handle.closed === true };
            record.resources.add(resource);
            handle.on('close', () => {
                resource.closed = true;
                if (!current()) return;
                if (record.terminal) { finishKnown(); return; }
                if (hop?.redirecting) { maybeRedirect(hop); return; }
                if (kind === 'writer' && !record.writerFinished) {
                    stop({ ok: false, error: 'download writer closed before finishing' });
                } else if (kind === 'response' && !hop.ended) {
                    stop({ ok: false, error: 'download response closed before completing' });
                } else if (kind === 'request' && !hop.response) {
                    stop({ ok: false, error: 'download request closed before a response' });
                } else maybeVerify();
            });
            // Keep listeners after settlement: a stale emitter must be harmless.
            handle.on('error', error => {
                if (!current() || record.terminal || hop?.redirecting) return;
                const prefix = kind === 'writer' ? 'write failed' : kind === 'response' ? 'response failed' : 'network error';
                stop({ ok: false, error: `${prefix}: ${error.message}` });
            });
            return resource;
        };
        const receive = (hop, response) => {
            if (!current()) {
                response.on('error', () => {});
                try { response.destroy(); } catch { /* stale callback, no writer */ }
                return;
            }
            hop.response = track(response, 'response', hop);
            response.on('aborted', () => {
                if (current() && !record.terminal && !hop.redirecting) stop({ ok: false, error: 'download response aborted' });
            });
            response.on('end', () => { hop.ended = true; maybeVerify(); });
            if (record.terminal) { destroyOwned(hop.response); finishKnown(); return; }
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                try {
                    if (hop.redirects >= MAX_MODEL_REDIRECTS) throw new Error(`redirect limit exceeded (${MAX_MODEL_REDIRECTS})`);
                    const target = new URL(response.headers.location, hop.url);
                    if (target.protocol !== 'https:') throw new Error('model redirects must remain HTTPS');
                    hop.target = target;
                    hop.redirecting = true;
                    destroyOwned(hop.response);
                    destroyOwned(hop.request);
                    maybeRedirect(hop);
                } catch (error) { stop({ ok: false, error: `download redirect failed: ${error.message}` }); }
                return;
            }
            if (response.statusCode !== 200) {
                stop({ ok: false, error: `download failed: HTTP ${response.statusCode}` });
                return;
            }
            const total = parseInt(response.headers['content-length'] || '0', 10);
            let received = 0;
            let lastReport = 0;
            // Existing registry cap is unchanged, including the 50 MiB floor.
            const cap = Math.max((entry.downloadBytes || 0) * 1.5 + (1 << 20), 50 * (1 << 20));
            try {
                try {
                    regularFileIdentity(partial);
                    fs.unlinkSync(partial);
                } catch (error) {
                    if (error.code !== 'ENOENT') throw error;
                }
                const fd = fs.openSync(partial, fs.constants.O_WRONLY | fs.constants.O_CREAT |
                    fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
                let out;
                try {
                    partialIdentity = fs.fstatSync(fd);
                    out = fs.createWriteStream(partial, { fd, autoClose: true });
                } catch (error) {
                    try { fs.closeSync(fd); } catch { /* already closed */ }
                    throw error;
                }
                record.writer = track(out, 'writer', hop);
                out.on('finish', () => {
                    record.writerFinished = true;
                    maybeVerify();
                });
                response.on('data', chunk => {
                    if (!current() || record.terminal) return;
                    received += chunk.length;
                    if (received > cap) {
                        stop({ ok: false, error: 'download exceeded the registry-declared size limit — discarded (possible origin problem).' });
                        return;
                    }
                    const now = Date.now();
                    if (now - lastReport > 250) {
                        lastReport = now;
                        notify({ received, total, fraction: total ? received / total : null });
                    }
                });
                response.pipe(out);
            } catch (error) { stop({ ok: false, error: `unsafe partial download: ${error.message}` }); }
        };
        const startHop = (url, redirects) => {
            if (!current() || record.terminal) return;
            const hop = { url, redirects, request: null, response: null,
                returned: false, ended: false, redirecting: false, followed: false };
            record.currentHop = hop;
            try {
                const request = require('https').get(url, {
                    headers: { 'User-Agent': 'VapourSynth-Companion/2.0-alpha' },
                }, response => receive(hop, response));
                hop.request = track(request, 'request', hop);
                hop.returned = true;
                if (record.terminal || hop.redirecting) destroyOwned(hop.request);
                maybeRedirect(hop);
                finishKnown();
            } catch (error) { stop({ ok: false, error: `network error: ${error.message}` }); }
        };
        record.cancel = () => {
            if (!current()) return { ok: false, error: 'no active download' };
            if (record.terminal && !record.cancelled) return { ok: false, error: 'download stop already requested', closureKnown: false };
            record.cancelled = true;
            stop({ ok: false, cancelled: true });
            return { ok: true, cancellationRequested: true };
        };
        active.set(id, record);
        try {
            fs.mkdirSync(dir, { recursive: true });
            const initial = new URL(entry.asset);
            if (initial.protocol !== 'https:') throw new Error('model downloads require HTTPS');
            startHop(initial, 0);
        } catch (error) { stop({ ok: false, error: `download preparation failed: ${error.message}` }); }
    });
}

const extracting = new Map(); // id -> identity-bound extraction ownership
const UNVERIFIED_MARKER = '.extraction-unverified.json';
const EXTRACT_KIND = 'model_extract';
// Provisional operational policy for archive decompression, not measured maxima.
// VSRES_MODEL_EXTRACT_TIMEOUT_MS / _MAX_OUTPUT_BYTES and explicit request fields
// permit intentionally longer/larger work. Values are validated, never clamped.
const EXTRACT_BUDGET = { kind: EXTRACT_KIND, timeoutMs: 30 * 60 * 1000, maxOutputBytes: 4 * 1024 * 1024 };

const MAX_TIMER_MS = 2 ** 31 - 1;
function extractionPolicy(options = {}) {
    const select = (name, key, fallback, maximum = Number.MAX_SAFE_INTEGER, minimum = 1) => {
        let value = options[name];
        if (value === undefined && Object.hasOwn(process.env, key)) {
            const text = process.env[key]; value = typeof text === 'string' && /^\d+$/.test(text) ? Number(text) : NaN;
        }
        if (value === undefined) value = fallback;
        if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be an integer from ${minimum} to ${maximum}; values are never clamped`);
        return value;
    };
    const timeoutMs = select('timeoutMs', 'VSRES_MODEL_EXTRACT_TIMEOUT_MS', EXTRACT_BUDGET.timeoutMs, MAX_TIMER_MS);
    const maxOutputBytes = select('maxOutputBytes', 'VSRES_MODEL_EXTRACT_MAX_OUTPUT_BYTES', EXTRACT_BUDGET.maxOutputBytes, MAX_STRING_LENGTH);
    // Whole-stage default preserves an intentionally long accepted child budget.
    // Chunked monotonic timers below avoid the native setTimeout range limit.
    const stageTimeoutMs = select('stageTimeoutMs', 'VSRES_MODEL_STAGE_TIMEOUT_MS', Math.max(60 * 60 * 1000, timeoutMs + 30 * 60 * 1000));
    return { timeoutMs, maxOutputBytes, stageTimeoutMs,
        stageHeadroomBytes: stageStore.headroomPolicy(options.stageHeadroomBytes),
        maxEntries: select('stageMaxEntries', 'VSRES_MODEL_STAGE_MAX_ENTRIES', 100000),
        maxDepth: select('stageMaxDepth', 'VSRES_MODEL_STAGE_MAX_DEPTH', 128),
        maxManifestBytes: select('stageMaxManifestBytes', 'VSRES_MODEL_STAGE_MAX_MANIFEST_BYTES', 64 * 1024 * 1024) };
}
function wholeStageBudget(durationMs, expired) {
    const deadline = process.hrtime.bigint() + BigInt(durationMs) * 1000000n;
    let timer = null, stopped = false, reported = false;
    const check = () => {
        if (stopped || reported) return;
        if (process.hrtime.bigint() >= deadline) { reported = true; expired(); }
    };
    const arm = () => {
        if (stopped || reported) return;
        check(); if (reported) return;
        const remainingNs = deadline - process.hrtime.bigint();
        const roundedMs = (remainingNs + 999999n) / 1000000n;
        const chunk = roundedMs > BigInt(MAX_TIMER_MS) ? MAX_TIMER_MS : Number(roundedMs > 0n ? roundedMs : 1n);
        timer = setTimeout(() => { timer = null; check(); arm(); }, chunk);
    };
    arm();
    return { check, stop() { stopped = true; if (timer !== null) clearTimeout(timer); } };
}
function extractionFailure(error, record) {
    const original = record.action?.firstError || error;
    return { ...(error.outcome || {}), ok: false, error: original?.message || String(original),
        closureKnown: record.closed(), needsRecovery: !!record.transaction && !record.transaction.released,
        noAutomaticReplay: true,
        ...(record.transaction ? { retainedStorage: record.transaction.notice(record.transaction.released ? 'retained' : record.closed() ? 'pending' : 'held'), space: record.transaction.space } : {}) };
}
function runExtractionAction(record, work, wholeDuration) {
    return new Promise(resolve => {
        const action = { responded: false, returnedUnknown: false, done: false, firstError: null, stopRevision: 0, timer: null, budget: null };
        record.action = action; record.finished = false; record.abortWork = false;
        action.fail = error => {
            if (record.action !== action || action.done) return;
            action.stopRevision++;
            if (action.firstError) return;
            action.firstError = error; record.error = error.message || String(error); record.abortWork = true;
            try { record.controller?.abort(); } catch { /* retained helper observes actual close */ }
            action.timer = setTimeout(() => {
                if (action.done || action.responded || !record.current()) return;
                action.responded = true; action.returnedUnknown = true;
                record.closureUnknown = !record.closed();
                resolve({ ...extractionFailure(error, record),
                    error: `${record.error}; failure disposition or owned-resource close remains unconfirmed. Transaction data was retained.` });
            }, MODEL_STOP_OBSERVE_MS);
        };
        if (wholeDuration !== undefined) action.budget = wholeStageBudget(wholeDuration,
            () => action.fail(new Error(`staged extraction exceeded ${wholeDuration} ms; data remains held for known-closed recovery`)));
        const finish = result => {
            if (action.firstError && result.ok === true) result = { ...result, ...extractionFailure(action.firstError, record), ok: false };
            action.done = true; if (action.timer !== null) clearTimeout(action.timer); action.budget?.stop(); record.finished = true;
            if (!action.responded) { action.responded = true; action.returnedUnknown = result.closureKnown === false; resolve(result); }
            record.release();
        };
        Promise.resolve().then(() => work(action)).then(finish, error => finish(extractionFailure(error, record)));
    });
}
async function extractModel(id, options = {}) {
    const valid = validateModelId(id); if (!valid.ok) return valid;
    if (stageStore.pending(path.resolve(MODELS_ROOT()), id).present) return { ok: false, error: 'model transaction recovery is pending; extraction was not started', noAutomaticReplay: true };
    if (extracting.has(id)) return { ok: false, error: 'extraction already in progress for this model' };
    if (active.has(id)) return { ok: false, error: 'cannot extract while a download is active' };
    if (hasPendingProbeStop(EXTRACT_KIND)) return { ok: false, closureKnown: false,
        error: 'An earlier extractor close is unconfirmed; no new extraction was started.', noAutomaticReplay: true };
    let policy;
    try { policy = extractionPolicy(options); } catch (error) { return { ok: false, reason: 'probe-invalid-budget', notStarted: true, closureKnown: true, error: error.message }; }
    const dir = valid.dir, archive = path.join(dir, 'download.7z');
    if (!fs.existsSync(archive)) return { ok: false, error: 'archive missing' };
    const record = { childClosed: true, hashPending: false, finished: false, abortWork: false, closureUnknown: false,
        transaction: null, error: null, controller: new AbortController(), policy };
    record.current = () => extracting.get(id) === record;
    record.closed = () => record.childClosed && !record.hashPending && (!record.transaction || record.transaction.resourcesClosed());
    record.release = () => {
        if (!record.current() || !record.finished || !record.closed()) return;
        if (record.transaction && !record.transaction.released &&
            (record.transaction.anchorIdentity || stageStore.pending(path.resolve(MODELS_ROOT()), id).present)) return;
        extracting.delete(id);
    };
    extracting.set(id, record);
    return runExtractionAction(record, async action => {
        try {
            const directoryIdentity = modelDirectoryIdentity(dir), archiveIdentity = regularFileIdentity(archive);
            const entry = REGISTRY.models.find(model => model.id === id);
            record.hashPending = true;
            let digest;
            try { digest = await sha256File(archive, archiveIdentity, error => action.fail(error)); }
            finally { record.hashPending = false; record.release(); }
            if (record.abortWork || action.returnedUnknown) throw action.firstError || new Error('archive verification stopped');
            if (digest !== entry.sha256) throw new Error('checksum mismatch: archive changed since download; remove it and download again');
            const sevenZ = find7z(); if (!sevenZ) throw new Error('No 7z extractor found. Install 7zip and retry; no downloaded installer is run.');
            // Valid original hashing stays outside the whole-stage deadline.
            action.budget = wholeStageBudget(policy.stageTimeoutMs,
                () => action.fail(new Error(`staged extraction exceeded ${policy.stageTimeoutMs} ms; data remains held for recovery`)));
            const transaction = new stageStore.ModelStageTransaction({ root: path.resolve(MODELS_ROOT()), id, entry,
                originalIdentity: directoryIdentity, archiveIdentity,
                stageHeadroomBytes: policy.stageHeadroomBytes, maxEntries: policy.maxEntries, maxDepth: policy.maxDepth, maxManifestBytes: policy.maxManifestBytes,
                hooks: { current: record.current, knownClosed: () => record.childClosed && !record.hashPending,
                    isStopped: () => record.abortWork, returnedUnknown: () => !!record.action?.returnedUnknown,
                    onFailure: error => record.action?.fail(error), onClosure: record.release, stopToken: () => record.action?.stopRevision,
                    checkDeadline: () => record.action?.budget?.check() } });
            record.transaction = transaction;
            await transaction.claim(); await transaction.prepare(); await transaction.beforeWriter();
            const result = await runProbeProcess((bin, args, spawnOptions) => {
                transaction.assertPrepared();
                if (record.abortWork || action.returnedUnknown) throw new Error('staged writer admission stopped');
                const child = spawn(bin, args, spawnOptions); record.childClosed = false;
                child.on('close', () => { record.childClosed = true; record.release(); }); return child;
            }, sevenZ, ['x', '-y', '-bso0', '-bsp0', '-bse2', `-o${transaction.stage}`, transaction.archive],
                { stdio: ['ignore', 'pipe', 'pipe'] }, EXTRACT_BUDGET,
                { timeoutMs: policy.timeoutMs, maxOutputBytes: policy.maxOutputBytes, signal: record.controller.signal });
            if (!result.ok) {
                const error = new Error(result.error); error.outcome = { reason: result.reason, cleanupUnconfirmed: result.cleanupUnconfirmed === true,
                    notStarted: result.notStarted === true, stopError: result.stopError || null };
                if (!result.closed) { record.abortWork = true; record.closureUnknown = true; record.error = result.error; return extractionFailure(error, record); }
                throw error;
            }
            if (result.code !== 0 || result.signal) throw new Error(`7z exited ${result.code}${result.signal ? ` (${result.signal})` : ''}: ${result.stderr.slice(0, 300)}`);
            if (record.abortWork || action.returnedUnknown) throw action.firstError || new Error('staged transaction stopped');
            await transaction.writerClosed(); await transaction.validateCandidate();
            return await transaction.publish();
        } catch (error) {
            action.fail(error);
            const transaction = record.transaction;
            if (transaction && !transaction.released && !transaction.releaseUncertain && record.closed() && !action.returnedUnknown && !error.held) {
                try {
                    const restored = transaction.publicationStarted ? await transaction.restore() : await transaction.retireFailure();
                    return { ...extractionFailure(error, record), ...restored, ok: false, error: action.firstError?.message || error.message };
                } catch (recoveryError) { record.error = `${record.error}; recovery held: ${recoveryError.message}`; }
            }
            return { ...extractionFailure(error, record), error: record.error || error.message,
                ...(transaction?.released ? { publicationUncertain: true, needsRecovery: false } : {}) };
        }
    });
}
async function recoverExtraction(id, action = 'inspect') {
    const entry = REGISTRY.models.find(model => model.id === id);
    if (typeof id !== 'string' || !/^[\w][\w.-]*$/.test(id) || !entry) return { ok: false, error: 'known model id required' };
    const record = extracting.get(id);
    if (action === 'inspect') {
        if (!record?.transaction?.anchorIdentity) return stageStore.inspect(path.resolve(MODELS_ROOT()), id, entry);
        const result = record.transaction.inspection();
        const eligible = record.finished && !record.recoveryActive && record.closed();
        return { ...result, canRestore: result.canRestore && eligible,
            ...(!eligible ? { recovery: 'The original owned action has not finished with all resources closed; inspection grants no mutation authority.' } : {}) };
    }
    if (action !== 'restore') return { ok: false, error: 'unsupported extraction recovery action' };
    if (!record?.transaction || !record.finished || !record.closed() || record.recoveryActive || record.transaction.released || record.transaction.releaseUncertain) {
        return { ...stageStore.inspect(path.resolve(MODELS_ROOT()), id, entry), ok: false, canRestore: false,
            error: 'the original-process known-closed recovery lease is unavailable; all data was retained' };
    }
    record.recoveryActive = true;
    try {
        return await runExtractionAction(record, async actionState => {
            try {
                actionState.budget?.check();
                if (actionState.firstError || record.abortWork || actionState.returnedUnknown) throw actionState.firstError || new Error('recovery admission stopped');
                return await record.transaction.restore();
            }
            catch (error) { actionState.fail(error); return extractionFailure(error, record); }
        }, record.policy.stageTimeoutMs);
    } finally { record.recoveryActive = false; }
}

function removeModel(id) {
    // ID + PATH SAFETY GATE FIRST: registry-known ids only, canonical
    // containment, symlink-escape refusal. This runs BEFORE any deletion.
    const valid = validateModelId(id);
    if (!valid.ok) return { ok: false, error: valid.error };
    if (stageStore.pending(path.resolve(MODELS_ROOT()), id).present) return { ok: false, error: 'model transaction recovery is pending; removal was not requested' };
    // Lifecycle guards: never remove mid-download / mid-extraction.
    if (active.has(id)) return { ok: false, error: 'cannot remove: a download is active for this model' };
    if (extracting.has(id)) return { ok: false, error: 'cannot remove: extraction is in progress' };
    // EXPLICIT SCOPE: exactly this model's directory, nothing else. The
    // scope is reported to the caller BEFORE any deletion so the UI can
    // show what will be removed (files, bytes, directory) — never a
    // shared runtime or another model's files.
    const dir = modelDir(id);
    if (!fs.existsSync(dir)) return { ok: false, error: 'nothing installed for this model' };
    const scope = removalScope(id);
    try {
        fs.rmSync(dir, { recursive: true, force: true });
        return { ok: true, state: 'absent', removed: scope };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

// Read-only scope preview for the removal confirmation UI.
function describeRemoval(id) {
    const valid = validateModelId(id);
    if (!valid.ok) return { ok: false, error: valid.error };
    if (stageStore.pending(path.resolve(MODELS_ROOT()), id).present) return { ok: false, error: 'model transaction recovery is pending; removal scope is unavailable' };
    const scope = removalScope(id);
    if (!scope) return { ok: false, error: 'nothing installed for this model' };
    return { ok: true, ...scope };
}

function cancelDownload(id) {
    const record = active.get(id);
    if (!record) return { ok: false, error: 'no active download' };
    return record.cancel();
}

function registerModelManager(ipcMain, broadcast) {
    ipcMain.handle('models:list', () => listModels());
    ipcMain.handle('models:download', async (_e, request) => {
        const id = typeof request?.id === 'string' ? request.id : null;
        if (!id) return { ok: false, error: 'model id required' };
        const report = payload => {
            try { broadcast?.('models:progress', { id, ...payload }); } catch { /* renderer teardown */ }
        };
        const result = await downloadModel(id, { onProgress: report });
        report({ done: true, ok: result.ok !== false });
        return { ...result, models: entriesWithState() };
    });
    ipcMain.handle('models:extract', async (_e, request) => {
        const id = typeof request?.id === 'string' ? request.id : null;
        if (!id) return { ok: false, error: 'model id required' };
        const options = {};
        if (request.timeoutMs !== undefined) options.timeoutMs = request.timeoutMs;
        if (request.maxOutputBytes !== undefined) options.maxOutputBytes = request.maxOutputBytes;
        for (const key of ['stageHeadroomBytes', 'stageTimeoutMs', 'stageMaxEntries', 'stageMaxDepth', 'stageMaxManifestBytes']) {
            if (request[key] !== undefined) options[key] = request[key];
        }
        const result = await extractModel(id, options);
        return { ...result, models: entriesWithState() };
    });
    ipcMain.handle('models:extraction-recovery', (_e, request) => recoverExtraction(request?.id, request?.action));
    ipcMain.handle('models:cancel', (_e, request) => cancelDownload(request?.id));
    // Read-only removal scope preview (before any confirmation).
    ipcMain.handle('models:removal-scope', (_e, request) => {
        const id = typeof request?.id === 'string' ? request.id : null;
        if (!id) return { ok: false, error: 'model id required' };
        return describeRemoval(id);
    });
    ipcMain.handle('models:remove', (_e, request) => {
        const id = typeof request?.id === 'string' ? request.id : null;
        if (!id) return { ok: false, error: 'model id required' };
        return { ...removeModel(id), models: entriesWithState() };
    });
}

// Read-only admission snapshot for capability callers. This is neither a read
// lease nor payload/inference verification. No tool discovery/enumeration/writes.
function inspectModelForRead(id) {
    const blocked = error => ({ ok: false, error,
        recovery: 'Wait for owned work to close, or correct/discard unverified model files explicitly before probing.' });
    const valid = validateModelId(id);
    if (!valid.ok) return blocked(valid.error);
    const root = path.resolve(MODELS_ROOT());
    const dir = valid.dir;
    if (stageStore.pending(root, id).present) return blocked('Model read admission is held by a staged transaction journal.');
    const busy = () => stageStore.pending(root, id).present || active.has(id) || extracting.has(id) || hasPendingProbeStop(EXTRACT_KIND);
    if (busy()) return blocked('Model read admission is blocked by active or unconfirmed owned work.');
    let identity;
    try { identity = modelDirectoryIdentity(dir); }
    catch (error) {
        if (error.code === 'ENOENT') return { ok: true, root, dir, exists: false,
            completion: 'missing', legacy: false, identity: null };
        return blocked(`Model container is unavailable: ${error.message}`);
    }
    const statusClear = () => {
        try { fs.lstatSync(path.join(dir, UNVERIFIED_MARKER)); return false; }
        catch (error) { if (error.code === 'ENOENT') return true; throw error; }
    };
    try {
        if (!statusClear()) return blocked('Model completion is unverified after an incomplete extraction.');
        const marker = markerStatus(REGISTRY.models.find(entry => entry.id === id), dir);
        if (marker.present && !marker.ok) return blocked(marker.error);
        if (busy() || !statusClear() || !sameModelDirectory(id, dir, identity) ||
            (marker.present && !sameRegularFile(path.join(dir, 'extracted.json'), marker.identity))) {
            return blocked('Model read admission changed during the metadata snapshot.');
        }
        return { ok: true, root, dir, exists: true,
            completion: marker.present ? 'verified' : 'missing', legacy: !marker.present,
            identity: { dev: identity.dev, ino: identity.ino },
            ...(marker.present ? { completionIdentity: {
                dev: marker.identity.dev, ino: marker.identity.ino, mtimeMs: marker.identity.mtimeMs } } : {}) };
    } catch (error) { return blocked(`Model read admission is unavailable: ${error.message}`); }
}

module.exports = { registerModelManager, listModels, describeRemoval, inspectModelForRead };