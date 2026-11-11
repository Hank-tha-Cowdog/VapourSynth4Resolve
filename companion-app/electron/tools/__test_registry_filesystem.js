// Actual registry publication with real owned fs; children/probe/clock stay fake.
// Dummy bytes are not MOV media. No completed scalar/output/lifecycle suites load.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { harness } = require('./__test_registry_harness');
const ROOT = path.resolve(__dirname, '../../../../../00_docs/verification/VS11_SAMPLE_FILESYSTEM_20261023/fixture');
const WORKSPACE = path.resolve(__dirname, '../../../../..');
const PARENT = path.dirname(ROOT);
const MAX_ENTRIES = 64, MAX_BYTES = 1024 * 1024, MAX_FILE = 4096;
const SAMPLE = Buffer.from('DUMMY OUTPUT, NOT MEDIA\n');
const effectCount = (h, name) => h.effects.filter(e => e[0] === name).length;

test('real filesystem publication through the full registry in one owned fixture', async t => {
  // Read-only custody checks precede every write, including initial acquisition.
  // This detects changed/symlink ancestry, not a hostile concurrent rename race.
  function parentCustody() {
    assert.equal(fs.realpathSync(WORKSPACE), WORKSPACE);
    let current = WORKSPACE;
    for (const part of ['', ...path.relative(WORKSPACE, PARENT).split(path.sep)]) {
      current = part ? path.join(current, part) : current;
      const s = fs.lstatSync(current); assert.ok(s.isDirectory() && !s.isSymbolicLink());
    }
    assert.equal(fs.realpathSync(PARENT), PARENT);
    const s = fs.lstatSync(PARENT); assert.equal(s.uid, process.getuid()); assert.equal(s.mode & 0o777, 0o700);
    return s;
  }
  const parentIdentity = parentCustody();
  // Atomic exclusive root acquisition; no adoption/deletion of a preexisting root.
  fs.mkdirSync(ROOT, { mode: 0o700 });
  const identity = fs.lstatSync(ROOT);
  assert.equal(identity.uid, process.getuid()); assert.equal(identity.mode & 0o777, 0o700);
  assert.ok(identity.isDirectory() && !identity.isSymbolicLink());
  assert.equal(fs.realpathSync(ROOT), ROOT);
  const owned = new Set([ROOT]);
  let allocatedBytes = 0;
  function rootIdentity() {
    const parent = parentCustody(); assert.equal(parent.dev, parentIdentity.dev); assert.equal(parent.ino, parentIdentity.ino);
    const s = fs.lstatSync(ROOT);
    assert.equal(s.dev, identity.dev); assert.equal(s.ino, identity.ino);
    assert.equal(s.uid, identity.uid); assert.equal(s.mode & 0o777, 0o700);
    assert.ok(s.isDirectory() && !s.isSymbolicLink());
  }
  function guard(target, leafLink = false) {
    assert.equal(typeof target, 'string'); assert.ok(path.isAbsolute(target));
    assert.equal(path.resolve(target), target);
    assert.ok(target === ROOT || target.startsWith(ROOT + path.sep), 'outside fixture root');
    rootIdentity();
    const parts = path.relative(ROOT, target).split(path.sep).filter(Boolean);
    let current = ROOT;
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]);
      let s;
      try { s = fs.lstatSync(current); }
      catch (e) { if (e.code === 'ENOENT') break; throw e; }
      assert.ok(!s.isSymbolicLink() || (leafLink && i === parts.length - 1), 'symlink traversal');
      if (i < parts.length - 1) assert.ok(s.isDirectory(), 'non-directory ancestor');
    }
    return target;
  }
  function reserve(target) {
    assert.ok(owned.size < MAX_ENTRIES || owned.has(target), 'entry budget'); owned.add(target);
  }
  function mkdir(target, options = { mode: 0o700 }) {
    guard(target);
    // Reserve every possible recursive ancestor before the real mkdir operation.
    let current = ROOT;
    for (const part of path.relative(ROOT, target).split(path.sep).filter(Boolean)) {
      current = path.join(current, part); reserve(current);
    }
    fs.mkdirSync(target, options);
  }
  function write(target, bytes) {
    guard(target); const data = Buffer.from(bytes);
    assert.ok(data.length <= MAX_FILE); assert.ok(allocatedBytes + data.length <= MAX_BYTES);
    reserve(target); fs.writeFileSync(target, data, { flag: 'wx', mode: 0o600 }); allocatedBytes += data.length;
  }
  const stat = target => fs.lstatSync(guard(target, true));
  const read = target => fs.readFileSync(guard(target));
  function noStage(caseRoot) {
    assert.equal(fs.readdirSync(guard(caseRoot)).some(n => n.startsWith('.vsres-sample-')), false);
  }
  function setup(name) {
    const dir = path.join(ROOT, name); mkdir(dir);
    const source = path.join(dir, 'source.dummy'), python = path.join(dir, 'fake-python');
    const output = path.join(dir, 'output.mov'); write(source, 'DUMMY SOURCE\n'); write(python, 'NOT EXECUTABLE\n');
    const ports = {
      existsSync: target => fs.existsSync(guard(target)),
      lstatSync: target => fs.lstatSync(guard(target, true)),
      mkdirSync: mkdir,
      mkdtempSync(prefix) {
        guard(prefix); assert.equal(path.basename(prefix), '.vsres-sample-');
        assert.ok(owned.size < MAX_ENTRIES); const stage = fs.mkdtempSync(prefix); reserve(stage); return stage;
      },
      linkSync(from, to) { guard(from); guard(to, true); reserve(to); fs.linkSync(from, to); },
      unlinkSync(target) {
        guard(target, true); assert.ok(owned.has(target));
        assert.ok(path.basename(path.dirname(target)).startsWith('.vsres-sample-'));
        fs.unlinkSync(target);
      },
      rmdirSync(target, options) {
        guard(target); assert.ok(owned.has(target)); assert.equal(options, undefined);
        assert.ok(path.basename(target).startsWith('.vsres-sample-')); fs.rmdirSync(target);
      },
    };
    const h = harness({ filesystemFixture: { ports, python, ffmpeg: path.join(dir, 'fake-ffmpeg'), home: path.join(dir, 'home') } });
    return { dir, source, output, h, input: () => ({ filePath: source, outputPath: output }) };
  }
  function stage(f, bytes = SAMPLE) {
    assert.equal(f.h.spawns.length, 2);
    const target = f.h.spawns[1].argv.at(-1); reserve(target); write(target, bytes); return target;
  }
  async function close(f, pending) {
    f.h.closeChild('producer'); f.h.closeChild('writer'); const result = await pending;
    f.h.assertNoUnexpectedPorts(); assert.equal(f.h.timers.size, 0); assert.equal(result.closureKnown, true);
    assert.equal(effectCount(f.h, 'kill'), 0); noStage(f.dir); return result;
  }
  function refused(f, result) {
    assert.equal(result.ok, false); assert.equal(result.error, 'output already exists; choose a new outputPath');
    assert.equal(f.h.spawns.length, 0); assert.equal(effectCount(f.h, 'findFfmpeg'), 0);
    assert.equal(effectCount(f.h, 'mkdtempSync'), 0); assert.equal(effectCount(f.h, 'linkSync'), 0);
    f.h.assertNoUnexpectedPorts(); noStage(f.dir);
  }
  const cases = [
    ['successful publication links correct staged bytes and cleans owned stage', async () => {
      const f = setup('success'); const pending = f.h.call(f.input()); const staged = stage(f); const before = stat(staged);
      const result = await close(f, pending); assert.equal(result.ok, true); assert.equal(result.outputPath, f.output);
      const after = stat(f.output); assert.equal(after.dev, before.dev); assert.equal(after.ino, before.ino);
      assert.deepEqual(read(f.output), SAMPLE); assert.equal(after.nlink, 1); assert.equal(effectCount(f.h, 'linkSync'), 1);
      assert.ok(f.h.spawns[1].argv.includes('-n')); assert.equal(f.h.spawns[1].argv.includes(f.output), false);
    }],
    ['default output and injected HOME stay inside owned fixture', async () => {
      const f = setup('default'); const pending = f.h.call({ filePath: f.source }); stage(f);
      const result = await close(f, pending); assert.equal(result.ok, true);
      assert.equal(path.dirname(result.outputPath), path.join(f.dir, 'home/Movies/VapourSynth-OFX Samples'));
      assert.deepEqual(read(result.outputPath), SAMPLE);
      assert.equal(fs.readdirSync(guard(path.dirname(result.outputPath))).some(n => n.startsWith('.vsres-sample-')), false);
    }],
    ['existing regular final is refused before staging and its inode/content survive', async () => {
      const f = setup('regular'); write(f.output, 'EXISTING'); const before = stat(f.output);
      refused(f, await f.h.call(f.input())); assert.equal(stat(f.output).ino, before.ino); assert.equal(read(f.output).toString(), 'EXISTING');
    }],
    ['dangling final link is refused without following its in-root target', async () => {
      const f = setup('dangling'); const missing = path.join(f.dir, 'missing-target'); guard(missing);
      reserve(f.output); fs.symlinkSync('missing-target', guard(f.output)); const before = stat(f.output);
      refused(f, await f.h.call(f.input())); assert.ok(stat(f.output).isSymbolicLink()); assert.equal(stat(f.output).ino, before.ino);
      assert.equal(fs.readlinkSync(guard(f.output, true)), 'missing-target'); assert.equal(fs.existsSync(guard(missing)), false);
    }],
    ['existing directory final is refused and left empty with the same inode', async () => {
      const f = setup('directory'); mkdir(f.output); const before = stat(f.output);
      refused(f, await f.h.call(f.input())); assert.equal(stat(f.output).ino, before.ino); assert.deepEqual(fs.readdirSync(guard(f.output)), []);
    }],
    ['creator after precheck wins real link race without replacement or fallback', async () => {
      const f = setup('race'); const pending = f.h.call(f.input()); const staged = stage(f); const stagedStat = stat(staged);
      write(f.output, 'RACE WINNER'); const winner = stat(f.output); assert.notEqual(winner.ino, stagedStat.ino);
      const result = await close(f, pending); assert.equal(result.ok, false); assert.equal(result.error, 'output already exists; choose a new outputPath');
      assert.equal(stat(f.output).ino, winner.ino); assert.equal(read(f.output).toString(), 'RACE WINNER');
      assert.equal(effectCount(f.h, 'linkSync'), 1);
      assert.equal(f.h.effects.some(e => e[0] === 'unlinkSync' && e[1] === f.output), false);
    }],
    ['empty real stage fails publication and is removed after simulated closure', async () => {
      const f = setup('empty'); const pending = f.h.call(f.input()); stage(f, Buffer.alloc(0));
      const result = await close(f, pending); assert.equal(result.ok, false);
      assert.equal(result.error, 'render produced no regular nonempty sample output');
      assert.equal(fs.existsSync(guard(f.output)), false); assert.equal(effectCount(f.h, 'linkSync'), 0);
    }],
  ];
  try {
    for (const [name, body] of cases) {
      let completed = false;
      await t.test(name, async () => { await body(); completed = true; });
      assert.ok(completed, 'stop at first unexpected case; retain partial fixture');
    }
    t.diagnostic(JSON.stringify({ fixtureRoot: ROOT, device: identity.dev, inode: identity.ino,
      parentDevice: parentIdentity.dev, parentInode: parentIdentity.ino,
      uid: identity.uid, mode: '0700', reservedEntries: owned.size, allocatedDummyBytes: allocatedBytes,
      allSevenCasesCompleted: true, realChildren: 0 }));
    // Success-only reverse ledger cleanup: no recursion or unknown entry deletion.
    for (const target of [...owned].reverse()) {
      guard(target, true);
      let s; try { s = fs.lstatSync(target); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
      if (s.isDirectory()) fs.rmdirSync(target); else fs.unlinkSync(target);
    }
    assert.equal(fs.existsSync(ROOT), false); t.diagnostic('fixture root removed by nonrecursive owned-entry cleanup');
  } catch (e) {
    t.diagnostic(`unexpected outcome: partial fixture retained at ${ROOT}`); throw e;
  }
});
