/**
 * FCRS-002 — Resolve scripting-API adapter (editorial tools -> API).
 *
 * Maps First Cut's editorial tool calls (add_clip / trim_clip / remove_clip /
 * move_clip / set_volume / clear_track / append_clip / add_marker ...) to the
 * correct DaVinci Resolve scripting-API call SEQUENCE over the PROVEN FCRS-001
 * bridge (electron/services/fc/resolve/bridge.{js,py}). It EXTENDS that bridge;
 * it does not reinvent the child/IPC layer.
 *
 * Three disciplines this adapter enforces (the FCRS-001 findings drive all three):
 *
 *   1. VERIFY-AFTER-WRITE (OPT-0040/0041). After every mutation the adapter reads
 *      the relevant timeline state back over the bridge and CONFIRMS the mutation
 *      landed, returning {applied:boolean, observed, expected, ...}. A phantom
 *      success (the bridge said "ok" but the state did not change) is reported as
 *      applied:false — never swallowed. This is exactly what caught the set_volume
 *      no-op in the spike.
 *
 *   2. TRACK-COUNT AGNOSTIC. The adapter NEVER assumes a fixed number of video or
 *      audio tracks. First Cut's flat track model (V1=0,V2=1,V3=2,A1=3..A5=7) is
 *      mapped to a Resolve {trackType, trackIndex} pair, then the destination
 *      track is resolved DYNAMICALLY against the live GetTrackCount (timeline_state)
 *      — adding tracks over the bridge if the timeline currently has fewer than the
 *      target needs. Works on a 1-track and an N-track timeline alike.
 *
 *   3. set_volume -> OTIO-GAIN FALLBACK (binding empirical finding). Per FCRS-001:
 *      a TimelineItem's SetProperty("Volume"/"ClipVolume"/"Gain"/...) is a SILENT
 *      NO-OP on Resolve 20.3.x (GetProperty returns an empty set). The from-state
 *      send_to_resolve.py fire-and-forgets that broken call. This adapter therefore
 *      ROUTES per-clip volume changes through the OTIO/overlay gain layer (an
 *      injectable sink; the real wiring is FCDA-017's OTIO commit) and NEVER issues
 *      the broken scripting-API call. trim_clip is likewise routed to the
 *      OTIO-reimport fallback (no public timeline-item trim exists).
 *
 * FLAG: fc.resolve.adapter (REGISTRY, phase 2, default OFF). With the flag OFF this
 * module is INERT — every public method throws the canonical gate error BEFORE it
 * touches the bridge, so no Resolve call is ever emitted and the existing bridge /
 * send path is byte-identical to the from-state. Nothing shipped requires this file;
 * with all flags off the app is byte-identical. Construction is allowed when OFF
 * (cheap, no I/O); only the verbs are gated, mirroring mediaRegistry / creativeScoring.
 */

'use strict';

const FLAG = 'fc.resolve.adapter';
const TICKET = 'FCRS-002';

// ── First Cut flat track model -> Resolve (trackType, 1-based trackIndex) ────────
// Mirrors electron/scripts/send_to_resolve.py exactly:
//   V1=0,V2=1,V3=2  -> video tracks 1,2,3      (fcIndex + 1)
//   A1=3,A2=4,A3=5,A4=6,A5=7 -> audio tracks 1..5 (fcIndex - 2)
// Kept as a pure function so it is trivially testable and has no fixed-count
// assumption baked in (the COUNT is resolved live; this only maps the address).
function fcTrackToResolve(fcTrackIndex) {
  const i = Number(fcTrackIndex);
  if (!Number.isInteger(i) || i < 0) {
    throw new Error(`${TICKET}: invalid First Cut trackIndex ${fcTrackIndex} (expected integer >= 0)`);
  }
  if (i <= 2) return { trackType: 'video', trackIndex: i + 1, fcTrackIndex: i };
  return { trackType: 'audio', trackIndex: i - 2, fcTrackIndex: i };
}

// Lazy + best-effort logger — never a hard dep on the OFF path.
function _log(msg) {
  try { require('../../../utils/timestampLogger').log(msg); } catch (_) { /* no-op */ }
}

/** Resolve the gate flag. Lazy-require so the OFF path carries zero hard deps. */
function _enabled() {
  try { return require('../flags').isEnabled(FLAG); }
  catch (_) { return false; }
}

/**
 * Default OTIO-gain sink. The REAL gain sink (FCDA-017) bakes clip gain into the
 * OTIO/overlay commit + reimports; this in-memory default just records the
 * intent so the adapter is usable (and testable) before that lands. It is the
 * ONLY place per-clip volume goes — the broken SetProperty path is never called.
 */
class InMemoryOtioGainSink {
  constructor() { this.entries = []; }
  /**
   * @returns {{applied:boolean, route:'otio-gain', gainDb:number, ...}}
   */
  writeGain({ timeline, trackType, trackIndex, itemIndex, gainLinear, gainDb }) {
    const entry = { timeline, trackType, trackIndex, itemIndex, gainLinear, gainDb, ts: Date.now() };
    this.entries.push(entry);
    return { applied: true, route: 'otio-gain', ...entry };
  }
  /** Read back the last gain written for a clip address (verify-after-write). */
  readGain({ timeline, trackType, trackIndex, itemIndex }) {
    for (let k = this.entries.length - 1; k >= 0; k -= 1) {
      const e = this.entries[k];
      if (e.timeline === timeline && e.trackType === trackType
          && e.trackIndex === trackIndex && e.itemIndex === itemIndex) return e;
    }
    return null;
  }
}

/** volume (1.0 = 0 dB linear) -> dB, matching send_to_resolve.py's formula. */
function linearToDb(volume) {
  const v = Math.max(0.001, Number(volume));
  return 20 * Math.log10(v);
}

class ResolveAdapter {
  /**
   * @param {object} opts
   * @param {object} opts.bridge      A started ResolveBridge (or a mock exposing .call(method, params)).
   * @param {string} opts.timeline    Name of the target timeline (the bridge addresses timelines by name).
   * @param {object} [opts.otioGain]  Gain sink (defaults to InMemoryOtioGainSink). set_volume routes here.
   * @param {number} [opts.callTimeoutMs]
   */
  constructor({ bridge, timeline, otioGain, callTimeoutMs } = {}) {
    this.bridge = bridge || null;
    this.timeline = timeline || null;
    this.otioGain = otioGain || new InMemoryOtioGainSink();
    this.callTimeoutMs = callTimeoutMs;
    // Span name prefix; tracing is a no-op unless fc.obs.phoenix is ON.
    this._spanPrefix = 'fc.resolve.adapter';
  }

  // ── gate ───────────────────────────────────────────────────────────────────
  _assertEnabled(where) {
    if (!_enabled()) {
      const e = new Error(`${FLAG} is OFF — ResolveAdapter.${where}() is inert (${TICKET}). Enable the flag to map editorial tools onto the Resolve scripting API.`);
      e.code = 'FC_FLAG_OFF';
      throw e;
    }
    if (!this.bridge || typeof this.bridge.call !== 'function') {
      throw new Error(`${TICKET}: ResolveAdapter requires a started bridge with .call(method, params).`);
    }
    if (!this.timeline) {
      throw new Error(`${TICKET}: ResolveAdapter requires a target timeline name.`);
    }
  }

  // ── bridge plumbing (traced when fc.obs.phoenix is ON; no-op otherwise) ──────
  async _call(method, params = {}) {
    const merged = { timeline: this.timeline, ...params };
    let span = null;
    try { span = require('../tracing').startSpan(`${this._spanPrefix}.${method}`, { kind: 'CLIENT', attributes: { 'fc.resolve.method': method } }); }
    catch (_) { span = null; }
    try {
      const r = await this.bridge.call(method, merged, this.callTimeoutMs);
      if (span) span.setVerdict('ok').end();
      return r;
    } catch (e) {
      if (span) span.setStatus('ERROR', e && e.message).setVerdict('failed').end();
      throw e;
    }
  }

  /** Read the full timeline state over the bridge (verify-after-write source). */
  async _state() {
    return this._call('timeline_state', {});
  }

  /** Item count on a resolved (trackType, 1-based index), live — never assumed. */
  _itemCount(state, trackType, trackIndex) {
    const side = state && state[trackType];
    if (!side || !Array.isArray(side.tracks)) return 0;
    const tr = side.tracks.find((t) => t.index === trackIndex);
    return tr ? (tr.itemCount != null ? tr.itemCount : (tr.items ? tr.items.length : 0)) : 0;
  }

  /** Live track count for a side (video/audio) — never assumed. */
  _trackCount(state, trackType) {
    const side = state && state[trackType];
    if (!side) return 0;
    return side.trackCount != null ? side.trackCount : (Array.isArray(side.tracks) ? side.tracks.length : 0);
  }

  /**
   * TRACK-COUNT AGNOSTIC resolution. Map the First Cut flat index to a Resolve
   * {trackType, trackIndex}, then ensure that many tracks exist on the LIVE
   * timeline (adding tracks over the bridge if short). Returns the resolved ref
   * plus the observed track count before/after. Works on 1-track and N-track
   * timelines identically — the count is read, not assumed.
   */
  async resolveTrackRef(fcTrackIndex) {
    const ref = fcTrackToResolve(fcTrackIndex);
    const before = await this._state();
    let have = this._trackCount(before, ref.trackType);
    const added = [];
    while (have < ref.trackIndex) {
      // Dynamically grow — never assume the timeline already has this track.
      const res = await this._call('add_track', { trackType: ref.trackType });
      added.push(res);
      const after = await this._state();
      const now = this._trackCount(after, ref.trackType);
      if (now <= have) {
        throw new Error(`${TICKET}: add_track('${ref.trackType}') did not increase ${ref.trackType} track count (${have} -> ${now}); cannot reach track ${ref.trackIndex}.`);
      }
      have = now;
    }
    return { ...ref, observedTrackCount: have, tracksAdded: added.length };
  }

  // ── verify-after-write core ──────────────────────────────────────────────────
  /**
   * Read the live state back and decide whether `expected` holds. `predicate`
   * receives (state) and returns {applied:boolean, observed:any}. Always returns
   * {applied, observed, expected} so a caller (and the test) can see a mismatch.
   */
  async _verify(expected, predicate) {
    const state = await this._state();
    const { applied, observed } = predicate(state);
    return { applied: !!applied, observed, expected };
  }

  // ── editorial-tool mappings ─────────────────────────────────────────────────

  /**
   * add_clip / append_clip — append an existing media-pool item (by name) to the
   * resolved track, then verify the track's item count grew.
   * @param {object} a {clipName|filename, trackIndex(fc), startFrame, endFrame|perClipFrames}
   */
  async addClip(a = {}) {
    this._assertEnabled('addClip');
    const clipName = a.clipName || a.filename;
    if (!clipName) throw new Error(`${TICKET}: addClip requires clipName/filename.`);
    const ref = await this.resolveTrackRef(a.trackIndex != null ? a.trackIndex : 0);

    const before = await this._state();
    const beforeCount = this._itemCount(before, ref.trackType, ref.trackIndex);

    const callParams = {
      clipNames: [clipName],
      trackIndex: ref.trackIndex,
    };
    // mediaType (Resolve: 1=video-only, 2=audio-only, OMITTED=both video+audio). `a.linkedAudio`
    // OMITS it so the bridge appends the clip's video AND its linked audio — a placed clip lands
    // WITH its sound (the right default for a rough cut; otherwise the timeline is silent). An
    // explicit `a.mediaType` wins. Otherwise keep the flat-track restriction (video-only on a video
    // track / audio-only on an audio track) so existing multi-track callers + tests are byte-identical.
    if (a.mediaType != null) callParams.mediaType = a.mediaType;
    else if (!a.linkedAudio) callParams.mediaType = ref.trackType === 'video' ? 1 : 2;
    if (a.startFrame != null) callParams.startFrame = a.startFrame;
    if (a.endFrame != null) callParams.perClipFrames = a.endFrame;
    else if (a.perClipFrames != null) callParams.perClipFrames = a.perClipFrames;
    // recordFrame (0-based from timeline start) places the clip at a POSITION on its track — for a V2
    // b-roll OVERLAY over the A1 dialogue. Omitted = gapless append (the from-state behavior).
    if (a.recordFrame != null) callParams.recordFrame = a.recordFrame;
    const apiResult = await this._call('append_existing', callParams);

    const verify = await this._verify(
      { trackType: ref.trackType, trackIndex: ref.trackIndex, itemCountAtLeast: beforeCount + 1 },
      (state) => {
        const observedCount = this._itemCount(state, ref.trackType, ref.trackIndex);
        return { applied: observedCount >= beforeCount + 1, observed: { itemCount: observedCount } };
      },
    );
    _log(`[ResolveAdapter] addClip "${clipName}" -> ${ref.trackType}${ref.trackIndex} applied=${verify.applied}`);
    return { tool: 'add_clip', route: 'scripting-api', ref, apiResult, beforeCount, ...verify };
  }

  /** append_clip is add_clip with no explicit record frame — same mapping. */
  async appendClip(a = {}) { return this.addClip(a); }

  /**
   * remove_clip — delete a timeline item at (fc trackIndex, itemIndex) and verify
   * the item count dropped by one.
   */
  async removeClip(a = {}) {
    this._assertEnabled('removeClip');
    const ref = fcTrackToResolve(a.trackIndex != null ? a.trackIndex : 0);
    const itemIndex = a.itemIndex != null ? a.itemIndex : 0;

    const before = await this._state();
    const beforeCount = this._itemCount(before, ref.trackType, ref.trackIndex);

    const apiResult = await this._call('delete_clips', {
      trackType: ref.trackType,
      trackIndex: ref.trackIndex,
      itemIndices: [itemIndex],
    });

    const verify = await this._verify(
      { trackType: ref.trackType, trackIndex: ref.trackIndex, itemCount: beforeCount - 1 },
      (state) => {
        const observedCount = this._itemCount(state, ref.trackType, ref.trackIndex);
        return { applied: observedCount === beforeCount - 1, observed: { itemCount: observedCount } };
      },
    );
    return { tool: 'remove_clip', route: 'scripting-api', ref, apiResult, beforeCount, ...verify };
  }

  /**
   * clear_track — remove every item on a track, verify it reads empty.
   */
  async clearTrack(a = {}) {
    this._assertEnabled('clearTrack');
    const ref = fcTrackToResolve(a.trackIndex != null ? a.trackIndex : 0);
    const apiResult = await this._call('clear_track', { trackType: ref.trackType, trackIndex: ref.trackIndex });
    const verify = await this._verify(
      { trackType: ref.trackType, trackIndex: ref.trackIndex, itemCount: 0 },
      (state) => {
        const observedCount = this._itemCount(state, ref.trackType, ref.trackIndex);
        return { applied: observedCount === 0, observed: { itemCount: observedCount } };
      },
    );
    return { tool: 'clear_track', route: 'scripting-api', ref, apiResult, ...verify };
  }

  /**
   * move_clip — move an item to a different (fc) track. Resolves BOTH the source
   * and destination tracks dynamically (track-agnostic), then verifies the
   * destination grew. Same-side moves only (video<->video / audio<->audio); a
   * cross-side move is rejected with a clear error rather than silently mis-routed.
   */
  async moveClip(a = {}) {
    this._assertEnabled('moveClip');
    const from = fcTrackToResolve(a.fromTrackIndex != null ? a.fromTrackIndex : 0);
    const toFc = a.toTrackIndex != null ? a.toTrackIndex : a.fromTrackIndex;
    const to = fcTrackToResolve(toFc);
    if (from.trackType !== to.trackType) {
      throw new Error(`${TICKET}: moveClip cannot move across media sides (${from.trackType} -> ${to.trackType}); video and audio tracks are distinct in Resolve.`);
    }
    // Ensure the destination track exists on the LIVE timeline before moving.
    const destRef = await this.resolveTrackRef(toFc);
    const itemIndex = a.itemIndex != null ? a.itemIndex : 0;

    const before = await this._state();
    const beforeDest = this._itemCount(before, to.trackType, destRef.trackIndex);

    const apiResult = await this._call('move_clip', {
      trackType: from.trackType,
      fromTrack: from.trackIndex,
      toTrack: destRef.trackIndex,
      itemIndex,
    });

    const verify = await this._verify(
      { trackType: to.trackType, toTrack: destRef.trackIndex, destItemCountAtLeast: beforeDest + 1 },
      (state) => {
        const observedDest = this._itemCount(state, to.trackType, destRef.trackIndex);
        return { applied: observedDest >= beforeDest + 1, observed: { destItemCount: observedDest } };
      },
    );
    return { tool: 'move_clip', route: 'scripting-api', from, to: destRef, apiResult, ...verify };
  }

  /**
   * set_volume — ROUTED TO THE OTIO-GAIN FALLBACK. Resolve's per-clip volume via
   * SetProperty is a confirmed silent no-op (FCRS-001), and the from-state ships
   * that broken call fire-and-forget. The adapter therefore writes the gain into
   * the OTIO/overlay layer (the gain sink) and NEVER calls the scripting API.
   * Verify-after-write reads the gain BACK from the sink and confirms it landed.
   *
   * @param {object} a {trackIndex(fc), itemIndex, volume} (volume linear, 1.0=0dB)
   */
  async setVolume(a = {}) {
    this._assertEnabled('setVolume');
    if (a.volume == null) throw new Error(`${TICKET}: setVolume requires volume (linear, 1.0 = 0 dB).`);
    const ref = fcTrackToResolve(a.trackIndex != null ? a.trackIndex : 3); // default A1
    const itemIndex = a.itemIndex != null ? a.itemIndex : 0;
    const gainLinear = Number(a.volume);
    const gainDb = linearToDb(gainLinear);

    // The fallback write — the ONLY place clip volume goes. No bridge call.
    const written = this.otioGain.writeGain({
      timeline: this.timeline,
      trackType: ref.trackType,
      trackIndex: ref.trackIndex,
      itemIndex,
      gainLinear,
      gainDb,
    });

    // Verify-after-write against the overlay layer (not the broken API).
    const readback = this.otioGain.readGain({
      timeline: this.timeline,
      trackType: ref.trackType,
      trackIndex: ref.trackIndex,
      itemIndex,
    });
    const applied = !!readback && Number(readback.gainLinear) === gainLinear;
    _log(`[ResolveAdapter] setVolume ${ref.trackType}${ref.trackIndex}#${itemIndex} -> ${gainLinear} (otio-gain) applied=${applied}`);
    return {
      tool: 'set_volume',
      route: 'otio-gain',                 // explicit: NOT scripting-api
      usedBrokenApi: false,               // contract: we never call SetProperty("Volume")
      ref,
      expected: { gainLinear, gainDb },
      observed: readback ? { gainLinear: readback.gainLinear, gainDb: readback.gainDb } : null,
      applied,
      sinkResult: written,
    };
  }

  /**
   * trim_clip — ROUTED TO THE OTIO-REIMPORT FALLBACK. There is no public
   * timeline-item trim/SetStart/SetEnd in the scripting API (FCRS-001 RED). The
   * adapter records the intended in/out edit into the OTIO overlay rather than
   * issuing a phantom scripting call; the OTIO commit (FCDA-017) re-imports.
   * Returns applied:false for the live-API path with an explicit fallback route,
   * so callers never mistake a no-op for success.
   */
  async trimClip(a = {}) {
    this._assertEnabled('trimClip');
    const ref = fcTrackToResolve(a.trackIndex != null ? a.trackIndex : 0);
    const itemIndex = a.itemIndex != null ? a.itemIndex : 0;
    // Record the edit intent on the overlay (gain sink doubles as the overlay
    // store seam here; FCDA-017 owns the real OTIO edit+reimport).
    const intent = { trackType: ref.trackType, trackIndex: ref.trackIndex, itemIndex, inPoint: a.inPoint, outPoint: a.outPoint };
    if (typeof this.otioGain.writeTrim === 'function') {
      this.otioGain.writeTrim({ timeline: this.timeline, ...intent });
    }
    return {
      tool: 'trim_clip',
      route: 'otio-reimport',
      usedBrokenApi: false,
      ref,
      expected: intent,
      observed: null,
      applied: false,                     // live scripting API cannot trim; OTIO commit will
      note: 'No public timeline-item trim in the scripting API (FCRS-001 RED) — queued for the OTIO reimport (FCDA-017).',
    };
  }

  /**
   * add_marker — passthrough to the proven AddMarker handler, verified via
   * GetMarkerByCustomData when customData is supplied (the in-app survival path;
   * customData does NOT survive OTIO export per DB-15).
   */
  async addMarker(a = {}) {
    this._assertEnabled('addMarker');
    const apiResult = await this._call('add_marker', {
      frameId: a.frameId, color: a.color, name: a.name, note: a.note,
      duration: a.duration, customData: a.customData,
    });
    let applied = !!(apiResult && apiResult.added);
    let observed = { added: applied };
    if (a.customData) {
      const found = await this._call('get_marker_by_customdata', { customData: a.customData });
      applied = applied && !!(found && found.found);
      observed = { added: !!(apiResult && apiResult.added), foundByCustomData: !!(found && found.found) };
    }
    return { tool: 'add_marker', route: 'scripting-api', apiResult, applied, observed, expected: { added: true } };
  }

  /**
   * Dispatch an editorial tool by its First Cut name. Lets the supervisor wire
   * the adapter behind the existing ToolExecutor without a switch of its own.
   */
  async applyTool(toolName, input = {}) {
    this._assertEnabled('applyTool');
    switch (toolName) {
      case 'add_clip':     return this.addClip(input);
      case 'append_clip':  return this.appendClip(input);
      case 'remove_clip':  return this.removeClip(input);
      case 'move_clip':    return this.moveClip(input);
      case 'set_volume':   return this.setVolume(input);
      case 'trim_clip':    return this.trimClip(input);
      case 'clear_track':  return this.clearTrack(input);
      case 'add_marker':   return this.addMarker(input);
      default:
        throw new Error(`${TICKET}: ResolveAdapter has no mapping for editorial tool "${toolName}".`);
    }
  }
}

module.exports = {
  ResolveAdapter,
  InMemoryOtioGainSink,
  fcTrackToResolve,
  linearToDb,
  FLAG,
  TICKET,
};
