// node-records.js — per-node saved-chain record verification + restore
// planning. Hermetic: every record lives in a per-test temp dir; HOME never
// read (dir passed explicitly).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const nr = require('./node-records');

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'vsres-node-records-'));
}
function writeRecord(dir, guid, payload) {
    fs.writeFileSync(path.join(dir, `${guid}.json`), JSON.stringify(payload));
}
function step(overrides = {}) {
    return { id: 's1', type: 'script', stage: 1, version: 1, enabled: true,
        approved: false, approvedContent: null, params: {}, ...overrides };
}
function record(guid, { chain, source } = {}) {
    return {
        schemaVersion: 1, nodeGuid: guid, nodeId: 'local-dev', manualOrder: false, mix: 1,
        colorManagement: undefined,
        clipMetadata: source ? { source } : undefined,
        chain: chain ?? [step()],
    };
}
const CLIP = { filePath: '/Movies/interlaced.mov', fileName: 'interlaced.mov', sourceHash: 'h1' };

test('guid validation mirrors the native rule', () => {
    assert.ok(nr.isValidNodeGuid('d66bbc41-8f35-4395-8f31-4d301949'));
    assert.ok(nr.isValidNodeGuid('local-dev'));
    for (const bad of ['', 'a/b', '..', 'a b', 'x'.repeat(65), 42, null, undefined, {}, 'x\\y', 'x.json']) {
        assert.ok(!nr.isValidNodeGuid(bad), `must reject ${JSON.stringify(bad)}`);
    }
});

test('clip binding extraction + comparison', () => {
    const cfg = { clipMetadata: { source: CLIP } };
    assert.deepEqual(nr.clipBindingFromConfig(cfg), { filePath: CLIP.filePath, sourceHash: 'h1', fileName: 'interlaced.mov' });
    assert.equal(nr.clipBindingFromConfig({}), null);
    assert.equal(nr.clipBindingFromConfig({ clipMetadata: { source: {} } }), null);

    const a = { filePath: '/Movies/x.mov', sourceHash: null, fileName: 'x.mov' };
    const b = { filePath: '/Movies/x.mov/', sourceHash: null, fileName: null };
    assert.equal(nr.compareClipBindings(a, b), 'match');
    assert.equal(nr.compareClipBindings(a, { filePath: '/Movies/y.mov' }), 'different');
    // hash wins over path: same content, different location
    assert.equal(nr.compareClipBindings(
        { filePath: '/a/x.mov', sourceHash: 'same' }, { filePath: '/b/x.mov', sourceHash: 'same' }), 'match');
    assert.equal(nr.compareClipBindings(
        { filePath: '/a/x.mov', sourceHash: 'same' }, { filePath: '/a/x.mov', sourceHash: 'other' }), 'different');
    assert.equal(nr.compareClipBindings(null, a), 'unknown');
    assert.equal(nr.compareClipBindings({ filePath: null, sourceHash: null }, a), 'unknown');
});

test('approval verification strips inconsistent bindings', () => {
    const { chain, problems } = nr.verifyChainApprovals([
        step({ approved: true, approvedContent: null }),          // approved w/o binding → stripped
        step({ id: 's2', approved: false, approvedContent: 'x' }), // orphan binding → cleared
        step({ id: 's3', approved: true, approvedContent: 'ok' }), // consistent → kept
    ]);
    assert.equal(chain[0].approved, false);
    assert.equal(chain[0].approvedContent, null);
    assert.equal(chain[1].approvedContent, null);
    assert.equal(chain[2].approved, true);
    assert.equal(chain[2].approvedContent, 'ok');
    assert.equal(problems.length, 2);
});

test('readNodeRecord: happy path extracts identity + verifies approvals', () => {
    const dir = tmpDir();
    writeRecord(dir, 'g1', record('g1', { source: CLIP }));
    const r = nr.readNodeRecord('g1', { dir });
    assert.equal(r.ok, true);
    assert.equal(r.record.guid, 'g1');
    assert.equal(r.record.identity.sourceHash, 'h1');
    assert.equal(r.record.chain.length, 1);
    assert.ok(Number.isFinite(r.record.updatedAtMs));
});

test('readNodeRecord: fail-closed refusals', () => {
    const dir = tmpDir();
    assert.equal(nr.readNodeRecord('../escape', { dir }).ok, false);
    assert.equal(nr.readNodeRecord('missing', { dir }).ok, false);
    fs.writeFileSync(path.join(dir, 'bad.json'), '{not json');
    assert.equal(nr.readNodeRecord('bad', { dir }).ok, false);
    // record that carries a different guid than its filename
    writeRecord(dir, 'misfiled', record('other-guid'));
    const misfiled = nr.readNodeRecord('misfiled', { dir });
    assert.equal(misfiled.ok, false);
    assert.match(misfiled.error, /different node guid/);
    // schema-invalid record
    writeRecord(dir, 'noschema', { nodeGuid: 'noschema', chain: 'not-an-array' });
    assert.equal(nr.readNodeRecord('noschema', { dir }).ok, false);
    // oversized
    fs.writeFileSync(path.join(dir, 'huge.json'), 'x'.repeat(nr.RECORD_SIZE_CAP + 1));
    const huge = nr.readNodeRecord('huge', { dir });
    assert.equal(huge.ok, false);
    assert.match(huge.error, /cap/);
});

test('auto restore: empty chain + matching clip keeps verified bindings', () => {
    const dir = tmpDir();
    writeRecord(dir, 'g2', record('g2', {
        source: CLIP,
        chain: [step({ approved: true, approvedContent: 'ok' })],
    }));
    const r = nr.readNodeRecord('g2', { dir });
    const plan = nr.planRestore({ recordResult: r, currentConfig: { chain: [], clipMetadata: { source: CLIP } }, mode: 'auto' });
    assert.equal(plan.action, 'restore');
    assert.equal(plan.clip, 'match');
    assert.equal(plan.chain[0].approved, true); // same node+clip → bindings survive
    assert.match(plan.note, /Restored this node's saved chain/);
    assert.equal(plan.note.includes('Approvals were stripped'), false);
});

test('auto restore: unknown clip binding restores with approvals stripped', () => {
    const dir = tmpDir();
    writeRecord(dir, 'g3', record('g3', { chain: [step({ approved: true, approvedContent: 'ok' })] })); // no clipMetadata
    const r = nr.readNodeRecord('g3', { dir });
    const plan = nr.planRestore({ recordResult: r, currentConfig: { chain: [], clipMetadata: { source: CLIP } }, mode: 'auto' });
    assert.equal(plan.action, 'restore');
    assert.equal(plan.clip, 'unknown');
    assert.equal(plan.chain[0].approved, false);
    assert.equal(plan.chain[0].approvedContent, null);
    assert.match(plan.note, /Approvals were stripped/);
});

test('auto restore: different clip → stale note, never silent', () => {
    const dir = tmpDir();
    writeRecord(dir, 'g4', record('g4', { source: { filePath: '/Movies/other.mov', fileName: 'other.mov' } }));
    const r = nr.readNodeRecord('g4', { dir });
    const plan = nr.planRestore({ recordResult: r, currentConfig: { chain: [], clipMetadata: { source: CLIP } }, mode: 'auto' });
    assert.equal(plan.action, 'stale');
    assert.match(plan.note, /different clip/);
    assert.match(plan.note, /other\.mov/);
});

test('auto restore: non-empty chain is untouched', () => {
    const dir = tmpDir();
    writeRecord(dir, 'g5', record('g5', { source: CLIP }));
    const r = nr.readNodeRecord('g5', { dir });
    const plan = nr.planRestore({ recordResult: r, currentConfig: { chain: [step()], clipMetadata: { source: CLIP } }, mode: 'auto' });
    assert.equal(plan.action, 'none');
});

test('auto restore: non-empty chain beats a different-clip record (no stale noise)', () => {
    const dir = tmpDir();
    writeRecord(dir, 'g9', record('g9', { source: { filePath: '/Movies/other.mov' } }));
    const r = nr.readNodeRecord('g9', { dir });
    const plan = nr.planRestore({ recordResult: r, currentConfig: { chain: [step()], clipMetadata: { source: CLIP } }, mode: 'auto' });
    assert.equal(plan.action, 'none');
});

test('explicit load: cross-clip strips, same-clip keeps', () => {
    const dir = tmpDir();
    writeRecord(dir, 'g6', record('g6', {
        source: { filePath: '/Movies/other.mov' },
        chain: [step({ approved: true, approvedContent: 'ok' })],
    }));
    const r = nr.readNodeRecord('g6', { dir });
    const cross = nr.planRestore({ recordResult: r, currentConfig: { chain: [step()], clipMetadata: { source: CLIP } }, mode: 'explicit' });
    assert.equal(cross.action, 'restore');
    assert.equal(cross.chain[0].approved, false);

    writeRecord(dir, 'g7', record('g7', { source: CLIP, chain: [step({ approved: true, approvedContent: 'ok' })] }));
    const r7 = nr.readNodeRecord('g7', { dir });
    const same = nr.planRestore({ recordResult: r7, currentConfig: { chain: [step()], clipMetadata: { source: CLIP } }, mode: 'explicit' });
    assert.equal(same.action, 'restore');
    assert.equal(same.chain[0].approved, true);
});

test('unusable record plans are inert', () => {
    const plan = nr.planRestore({ recordResult: { ok: false, error: 'x' }, currentConfig: { chain: [] }, mode: 'auto' });
    assert.equal(plan.action, 'unusable');
});

test('applyRestoreToConfig merges only a restore plan', () => {
    const base = { schemaVersion: 1, nodeGuid: 'g8', chain: [], mix: 0.5, marker: 'keep' };
    const moved = nr.applyRestoreToConfig(base, {
        action: 'restore', chain: [step()], colorManagement: { inputColorSpace: 'a', inputGamma: 'b', outputColorSpace: 'c', outputGamma: 'd', ocioConfig: 'e' },
        mix: 1, manualOrder: true,
    });
    assert.equal(moved.chain.length, 1);
    assert.equal(moved.manualOrder, true);
    assert.equal(moved.mix, 1);
    assert.equal(moved.colorManagement.inputColorSpace, 'a');
    assert.equal(moved.marker, 'keep');
    assert.equal(moved.nodeGuid, 'g8');
    // non-restore plans leave the config identical (same reference)
    assert.equal(nr.applyRestoreToConfig(base, { action: 'none' }), base);
    assert.equal(nr.applyRestoreToConfig(base, { action: 'stale' }), base);
    // invalid colorManagement shape is ignored
    const kept = nr.applyRestoreToConfig(base, { action: 'restore', chain: [step()], colorManagement: [1, 2] });
    assert.equal(kept.colorManagement, undefined);
});

test('round trip: record → read → plan → apply', () => {
    const dir = tmpDir();
    const guid = 'roundtrip-1';
    writeRecord(dir, guid, record(guid, {
        source: CLIP,
        chain: [step({ id: 'a', approved: true, approvedContent: 'ok' }), step({ id: 'b' })],
    }));
    const r = nr.readNodeRecord(guid, { dir });
    const plan = nr.planRestore({ recordResult: r, currentConfig: { chain: [], clipMetadata: { source: CLIP } }, mode: 'auto' });
    const merged = nr.applyRestoreToConfig({ schemaVersion: 1, nodeGuid: guid, chain: [] }, plan);
    assert.equal(merged.chain.length, 2);
    assert.equal(merged.chain[0].id, 'a');
    assert.equal(merged.chain[0].approved, true);
});
