const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { harness } = require('./test-fixtures/__test_model_extractor_harness');
const completed = result => { assert.equal(result.done, true, 'failure must settle after actual child close'); assert.equal(result.error, null); return result.value; };

test('staged preservation: failed native overlay preserves original payload bytes and archive identity', async t => {
    const h = harness(t, { onSpawn(h) { fs.writeFileSync(path.join(h.stageDir || h.dir, 'weight.bin'), 'new interrupted output'); } });
    fs.writeFileSync(path.join(h.dir, 'weight.bin'), 'original installed weight'); h.writeReady();
    const archive = fs.lstatSync(path.join(h.dir, 'download.7z')), marker = fs.readFileSync(h.marker);
    const result = h.start(); await h.flush(); assert.equal(h.children.length, 1, 'selected fake writer was admitted');
    h.children[0].close(7); await h.flush(); assert.equal(completed(result).ok, false);
    assert.equal(fs.readFileSync(path.join(h.dir, 'weight.bin'), 'utf8'), 'original installed weight');
    assert.equal(fs.lstatSync(path.join(h.dir, 'download.7z')).ino, archive.ino); assert.deepEqual(fs.readFileSync(h.marker), marker);
});

test('staged preservation: refused output link retains old tree and external stand-in', async t => {
    const h = harness(t, { onSpawn(h) { fs.symlinkSync(path.join(h.root, 'outside'), path.join(h.stageDir || h.dir, 'escape-link')); } });
    fs.mkdirSync(path.join(h.root, 'outside')); fs.writeFileSync(path.join(h.root, 'outside', 'sentinel'), 'keep outside');
    fs.writeFileSync(path.join(h.dir, 'weight.bin'), 'original installed weight'); h.writeReady();
    const result = h.start(); await h.flush(); assert.equal(h.children.length, 1); h.children[0].close(); await h.flush();
    assert.equal(completed(result).ok, false); assert.equal(fs.existsSync(path.join(h.dir, 'weight.bin')), true, 'old tree must survive rejected candidate');
    assert.equal(fs.readFileSync(path.join(h.dir, 'weight.bin'), 'utf8'), 'original installed weight');
    assert.equal(fs.readFileSync(path.join(h.root, 'outside', 'sentinel'), 'utf8'), 'keep outside');
});
