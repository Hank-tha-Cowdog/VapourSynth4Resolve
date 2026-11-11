/**
 * Phase 0 port check.  node __test_bridge.js
 *
 * Split into two halves on purpose. The first half runs anywhere: it drives the real
 * bridge.py protocol against a fake Resolve, so the framing, id correlation, error
 * shape and the new confirmation gate are all exercised on this machine, in CI, with
 * Resolve absent. The second half only runs when Resolve is actually up, and is
 * skipped loudly rather than silently so a green run never implies more than it tested.
 *
 * The fake is injected by pointing bridge.py's connector at a stub module — the same
 * import path Resolve's own module uses — so the code under test is the shipped file
 * and not a copy of it.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ResolveBridge } = require('./bridge');
const { isRunning } = require('./launch');
const flags = require('../flags');
const { isDestructive, DESTRUCTIVE } = require('./index');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed += 1;
    console.log(`  FAIL ${name}\n       ${e && e.message}`);
  }
}

/** A stub DaVinciResolveScript that satisfies boot and a couple of calls. */
function writeFakeResolve(dir) {
  fs.writeFileSync(path.join(dir, 'DaVinciResolveScript.py'), `
class _Track:
    def __init__(self): self.names = {}
class _TL:
    def __init__(self, name): self.name = name; self._names = {}
    def GetName(self): return self.name
    def GetTrackCount(self, t): return 2
    def GetTrackName(self, t, i): return self._names.get((t, i), "Video %d" % i)
    def SetTrackName(self, t, i, n): self._names[(t, i)] = n; return True
    def GetItemListInTrack(self, t, i): return []
    def GetSetting(self, k): return None
class _MP:
    def __init__(self): self.tls = [_TL("REF_3way_compare")]
    def GetRootFolder(self): return self
    def GetClipList(self): return []
    def GetSubFolderList(self): return []
    def DeleteTimelines(self, tls): return True
class _Proj:
    def __init__(self): self.mp = _MP()
    def GetName(self): return "FakeProject"
    def GetMediaPool(self): return self.mp
    def GetTimelineCount(self): return len(self.mp.tls)
    def GetTimelineByIndex(self, i): return self.mp.tls[i - 1]
    def GetCurrentTimeline(self): return self.mp.tls[0]
    def GetSetting(self, k): return None
class _PM:
    def __init__(self): self.p = _Proj()
    def GetCurrentProject(self): return self.p
class _Resolve:
    def __init__(self): self.pm = _PM()
    def GetProjectManager(self): return self.pm
    def GetProductName(self): return "DaVinci Resolve"
    def GetVersionString(self): return "20.3.0"
    def GetCurrentPage(self): return "edit"
def scriptapp(_name): return _Resolve()
`);
}

async function main() {
  console.log('Phase 0 — Resolve bridge port\n');

  console.log('always:');
  await test('flags shim enables the ported adapter', () => {
    assert.strictEqual(flags.isEnabled('fc.resolve.adapter'), true);
    assert.strictEqual(flags.isEnabled('nonexistent.flag'), false);
  });

  await test('destructive list matches bridge.py', () => {
    const py = fs.readFileSync(path.join(__dirname, 'bridge.py'), 'utf8');
    const block = py.match(/DESTRUCTIVE = frozenset\(\{([^}]*)\}\)/);
    assert.ok(block, 'DESTRUCTIVE not found in bridge.py');
    const inPy = [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
    assert.deepStrictEqual(inPy, [...DESTRUCTIVE].sort(),
      `bridge.py gates ${inPy} but index.js advertises ${DESTRUCTIVE}`);
    assert.ok(isDestructive('delete_timeline'));
    assert.ok(!isDestructive('add_track'));
  });

  await test('set_track_name is registered in the dispatch table', () => {
    const py = fs.readFileSync(path.join(__dirname, 'bridge.py'), 'utf8');
    assert.ok(/"set_track_name": self\.h_set_track_name/.test(py), 'not in dispatch');
    assert.ok(/def h_set_track_name/.test(py), 'handler missing');
  });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vsr-bridge-'));
  writeFakeResolve(dir);
  const bridge = new ResolveBridge({
    watchdog: false,
    maxRestarts: 0,
    bootTimeoutMs: 15000,
    python: process.env.VSR_RESOLVE_PYTHON || '/usr/bin/python3',
  });
  // Put the stub ahead of the real module search path.
  const saved = process.env.PYTHONPATH;
  process.env.PYTHONPATH = dir + (saved ? `:${saved}` : '');

  let booted = false;
  await test('bridge boots against a fake Resolve and reports ready', async () => {
    const info = await bridge.start();
    booted = true;
    assert.ok(info && info.ready === true, `unexpected boot result ${JSON.stringify(info)}`);
  });

  if (booted) {
    await test('ping round-trips', async () => {
      const r = await bridge.call('ping', {});
      assert.ok(r, 'no ping result');
    });

    await test('unknown method returns a structured error, not a crash', async () => {
      await assert.rejects(() => bridge.call('no_such_method', {}), /no_such_method/);
      assert.ok(await bridge.call('ping', {}), 'bridge died after a bad method');
    });

    await test('destructive command is refused without confirm', async () => {
      await assert.rejects(
        () => bridge.call('delete_timeline', { timeline: 'REF_3way_compare' }),
        (e) => e.type === 'ConfirmationRequired',
        'delete_timeline should require confirm:true');
    });

    await test('destructive command proceeds with confirm', async () => {
      const r = await bridge.call('delete_timeline',
        { timeline: 'REF_3way_compare', confirm: true });
      assert.strictEqual(r.ok, true);
    });

    await test('set_track_name writes and verifies', async () => {
      const r = await bridge.call('set_track_name', {
        timeline: 'REF_3way_compare', trackType: 'video', trackIndex: 1, name: 'OURS v4',
      });
      assert.strictEqual(r.after, 'OURS v4');
      assert.strictEqual(r.verified, true);
    });

    await test('set_track_name rejects an out-of-range track', async () => {
      await assert.rejects(() => bridge.call('set_track_name', {
        timeline: 'REF_3way_compare', trackType: 'video', trackIndex: 99, name: 'x',
      }), /out of range/);
    });

    await bridge.stop();
  }
  process.env.PYTHONPATH = saved;
  fs.rmSync(dir, { recursive: true, force: true });

  console.log('\nwith Resolve running:');
  if (!(await isRunning())) {
    console.log('  SKIP  Resolve is not running — the live half did not run.');
  } else {
    const live = new ResolveBridge({ watchdog: false, maxRestarts: 0 });
    let up = false;
    await test('connects to the real Resolve', async () => {
      const info = await live.start();
      up = true;
      assert.ok(info && info.ready === true);
      console.log(`       ${JSON.stringify(info.info)}`);
    });
    if (up) {
      await test('lists timelines', async () => {
        const r = await live.call('list_timelines', {});
        console.log(`       ${JSON.stringify(r).slice(0, 300)}`);
      });
      await live.stop();
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
