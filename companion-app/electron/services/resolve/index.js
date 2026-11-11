/**
 * Public surface for Resolve control — Phase 0 of the v3 plan.
 *
 * One place to reach Resolve from. `electron/resolve-api.js` still exists and still
 * does its one job (the source path of the clip at the playhead) by spawning a
 * short-lived python; anything that needs more than one answer, or needs to write,
 * should come through here instead of adding a second one-shot script.
 */

'use strict';

const { ResolveBridge, withBridge, BRIDGE_PY, MAC_API, MAC_LIB } = require('./bridge');
const { ResolveAdapter, InMemoryOtioGainSink, fcTrackToResolve } = require('./adapter');
const { ensureRunning, isInstalled, isRunning, APP } = require('./launch');

/** Commands the bridge refuses without `confirm: true`. Mirrors DESTRUCTIVE in
 *  bridge.py — kept here so callers can ask before they call rather than discovering
 *  it from an error. The bridge remains the enforcement point; this is a courtesy. */
const DESTRUCTIVE = Object.freeze(['delete_timeline', 'delete_clips', 'clear_track']);

function isDestructive(method) {
  return DESTRUCTIVE.includes(method);
}

/**
 * Start Resolve if needed, then a bridge, and hand both to fn. Always stops the
 * bridge; never quits Resolve, which belongs to the operator.
 */
async function withResolve(fn, opts = {}) {
  const up = await ensureRunning(opts);
  if (!up.ok) {
    const e = new Error(up.reason);
    e.code = 'VSR_RESOLVE_UNAVAILABLE';
    throw e;
  }
  return withBridge((bridge, info) => fn(bridge, { ...info, launched: up.launched }), opts);
}

module.exports = {
  ResolveBridge,
  ResolveAdapter,
  InMemoryOtioGainSink,
  fcTrackToResolve,
  withBridge,
  withResolve,
  ensureRunning,
  isInstalled,
  isRunning,
  isDestructive,
  DESTRUCTIVE,
  BRIDGE_PY,
  MAC_API,
  MAC_LIB,
  APP,
};
