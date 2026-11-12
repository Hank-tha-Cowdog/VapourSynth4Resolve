// node-records.js — read + verify the native plugin's per-node saved-chain
// records (~/Library/Application Support/VapourSynth-OFX/nodes/<guid>.json)
// and plan their restoration into an editing session.
//
// WHY THIS EXISTS (beta-chains, 2026-11-12)
// The OFX plugin persists each node's accepted configuration to a sidecar
// keyed by its stable node GUID (plugin_entry.cpp accept path). That store is
// the durable copy of a node's chain; the Resolve project's OFX parameters
// are the live copy. When the live copy is lost or reset (effect re-added,
// pasted node, project damage), nothing surfaced the saved copy — the store
// was write-only from the companion's point of view. Continuity rules:
//
//   1. AUTO-RESTORE is conservative: only in host-manual sessions, only when
//      the incoming config's chain is EMPTY, only when the record's clip
//      binding MATCHES (or is unknown on both sides — legacy records).
//   2. A record with a KNOWN clip binding that does NOT match the current
//      clip is never auto-restored (a copied/mis-filed record must not shadow
//      the real node); explicit load may still fetch it, but see rule 3.
//   3. EXPLICIT cross-clip load strips every approval. Same rule as recipes:
//      nothing arrives pre-approved through intake. Same-clip restore keeps
//      verified bindings (the record is the node's own prior accepted state,
//      the same trust class as the --config-path input).
//   4. Everything is fail-closed: invalid GUIDs, oversized files, mismatched
//      record identity, schema problems, and inconsistent approval bindings
//      all refuse or strip — never execute.
//
// This module is READ-ONLY: the native side is the single writer of records.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describeManualHostConfigProblem } = require('./editor-configuration');

const RECORD_SIZE_CAP = 8 * 1024 * 1024; // mirrors the host's 8 MiB exchange cap
// Same rule as common/identity/guid.h (native): a guid is ONLY ever
// [A-Za-z0-9-]{1,64}. Everything that builds a filename from it goes through
// this check so a hostile record name cannot escape the nodes directory.
const GUID_RE = /^[A-Za-z0-9-]{1,64}$/;

function isValidNodeGuid(value) {
    return typeof value === 'string' && GUID_RE.test(value);
}

function nodeRecordsDir(home) {
    return path.join(home || os.homedir(),
        'Library/Application Support/VapourSynth-OFX', 'nodes');
}

// ---- clip binding ----------------------------------------------------------

// The identifying slice of config.clipMetadata.source. filePath is what the
// discovery layer records; sourceHash is ffprobe-derived content identity —
// when both sides carry hashes, the hash decides (a moved file still
// matches); otherwise normalized paths decide; otherwise 'unknown'.
function clipBindingFromConfig(config) {
    const src = config && config.clipMetadata && config.clipMetadata.source;
    if (!src || typeof src !== 'object' || Array.isArray(src)) return null;
    const filePath = typeof src.filePath === 'string' && src.filePath ? src.filePath : null;
    const sourceHash = typeof src.sourceHash === 'string' && src.sourceHash ? src.sourceHash : null;
    const fileName = typeof src.fileName === 'string' && src.fileName ? src.fileName : null;
    if (!filePath && !sourceHash) return null;
    return { filePath, sourceHash, fileName };
}

function compareClipBindings(a, b) {
    if (!a || !b) return 'unknown';
    if (a.sourceHash && b.sourceHash) return a.sourceHash === b.sourceHash ? 'match' : 'different';
    if (a.filePath && b.filePath) {
        const norm = p => path.normalize(p).normalize('NFC').replace(/\/+$/, '');
        return norm(a.filePath) === norm(b.filePath) ? 'match' : 'different';
    }
    return 'unknown';
}

// ---- approval verification -------------------------------------------------

function stripApprovals(chain) {
    return (Array.isArray(chain) ? chain : []).map(step =>
        (step && typeof step === 'object' && !Array.isArray(step))
            ? { ...step, approved: false, approvedContent: null }
            : step);
}

// An approved step MUST carry its content binding (the security posture:
// approval is content-bound). Anything inconsistent is stripped, with a
// problem note — never repaired into "approved".
function verifyChainApprovals(chain) {
    const problems = [];
    const out = (Array.isArray(chain) ? chain : []).map((step, i) => {
        if (!step || typeof step !== 'object' || Array.isArray(step)) return step;
        const approved = step.approved === true;
        const bound = typeof step.approvedContent === 'string' && step.approvedContent.length > 0;
        if (approved && !bound) {
            problems.push(`step ${i + 1}: marked approved without a content binding — marked unapproved`);
            return { ...step, approved: false, approvedContent: null };
        }
        if (!approved && bound) {
            problems.push(`step ${i + 1}: orphaned content binding without approval — binding cleared`);
            return { ...step, approved: false, approvedContent: null };
        }
        return step;
    });
    return { chain: out, problems };
}

// ---- record reading --------------------------------------------------------

// Read + validate one node record. Returns
// { ok:true, record: { guid, chain, colorManagement, mix, manualOrder, identity, updatedAtMs } }
// or { ok:false, error } — fail-closed on every anomaly.
function readNodeRecord(guid, options = {}) {
    if (!isValidNodeGuid(guid)) return { ok: false, error: 'invalid node guid' };
    const dir = options.dir || nodeRecordsDir(options.home);
    const file = path.join(dir, `${guid}.json`);
    let stat;
    try { stat = fs.statSync(file); } catch { return { ok: false, error: 'no saved record for this node' }; }
    if (!stat.isFile()) return { ok: false, error: 'record is not a file' };
    if (stat.size > RECORD_SIZE_CAP) return { ok: false, error: `record exceeds the ${RECORD_SIZE_CAP} byte cap` };
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { return { ok: false, error: 'record is not readable JSON' }; }
    const problem = describeManualHostConfigProblem(parsed);
    if (problem) return { ok: false, error: `record fails validation: ${problem}` };
    if (parsed.nodeGuid !== guid) return { ok: false, error: 'record carries a different node guid — refusing to serve it' };
    const verified = verifyChainApprovals(parsed.chain);
    return {
        ok: true,
        record: {
            guid,
            chain: verified.chain,
            colorManagement: parsed.colorManagement,
            mix: parsed.mix,
            manualOrder: parsed.manualOrder,
            identity: clipBindingFromConfig(parsed),
            updatedAtMs: stat.mtimeMs,
        },
        problems: verified.problems,
    };
}

// ---- restore planning ------------------------------------------------------

function describeRestored(record, chain, clip) {
    const when = Number.isFinite(record.updatedAtMs)
        ? new Date(record.updatedAtMs).toISOString().replace('T', ' ').slice(0, 16) : 'an earlier session';
    const n = chain.length;
    const approval = clip === 'match' ? '' : ' Approvals were stripped; approve each step to run it.';
    const clipNote = clip === 'match' ? '' : ' (clip binding could not be verified)';
    return `Restored this node's saved chain — ${n} step${n === 1 ? '' : 's'}, saved ${when}${clipNote}.${approval}`;
}

// mode 'auto'   → used at editor boot: untouched unless chain is empty and the
//                 clip binding matches (or is unknown); mismatched-clip records
//                 produce a 'stale' note instead of a silent no-op.
// mode 'explicit'→ user-requested load: always admissible, but cross-clip
//                 loads strip approvals (intake rule).
function planRestore({ recordResult, currentConfig, mode }) {
    if (!recordResult || !recordResult.ok) {
        return { action: 'unusable', note: '' };
    }
    const { record } = recordResult;
    const currentBinding = clipBindingFromConfig(currentConfig);
    const clip = compareClipBindings(record.identity, currentBinding);
    if (mode === 'auto') {
        const chainLen = Array.isArray(currentConfig && currentConfig.chain) ? currentConfig.chain.length : 0;
        // A live chain means the node IS configured; no restore, and no
        // stale-clip noise either — the record simply isn't needed here.
        if (chainLen > 0) return { action: 'none' };
        if (clip === 'different') {
            const other = record.identity && record.identity.fileName ? ` (${record.identity.fileName})` : '';
            return { action: 'stale', note:
                `A saved chain for this node exists but was recorded for a different clip${other}. `
                + 'It was not restored; use Restore saved chain to load it explicitly.' };
        }
    }
    const strip = clip !== 'match';
    const chain = strip ? stripApprovals(record.chain) : record.chain;
    return {
        action: 'restore',
        chain,
        colorManagement: record.colorManagement,
        mix: record.mix,
        manualOrder: record.manualOrder,
        clip,
        note: describeRestored(record, chain, clip),
        problems: recordResult.problems || [],
    };
}

// Pure merge used by the editor boot path and by tests.
function applyRestoreToConfig(config, plan) {
    if (!config || !plan || plan.action !== 'restore' || !Array.isArray(plan.chain)) return config;
    const next = { ...config, chain: plan.chain };
    if (plan.colorManagement && typeof plan.colorManagement === 'object' && !Array.isArray(plan.colorManagement)) {
        next.colorManagement = plan.colorManagement;
    }
    if (typeof plan.mix === 'number' && Number.isFinite(plan.mix)) next.mix = plan.mix;
    if (typeof plan.manualOrder === 'boolean') next.manualOrder = plan.manualOrder;
    return next;
}

module.exports = {
    isValidNodeGuid,
    nodeRecordsDir,
    clipBindingFromConfig,
    compareClipBindings,
    stripApprovals,
    verifyChainApprovals,
    readNodeRecord,
    planRestore,
    applyRestoreToConfig,
    RECORD_SIZE_CAP,
};
