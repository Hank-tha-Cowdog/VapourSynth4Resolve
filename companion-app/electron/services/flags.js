/**
 * Minimal feature-flag shim.
 *
 * The ported Resolve adapter (services/resolve/adapter.js) gates every verb on
 * `flags.isEnabled('fc.resolve.adapter')` and lazy-requires this module, returning
 * false if it is missing. Without this file the adapter would be permanently inert
 * here — silently, because the require is wrapped in a try/catch.
 *
 * The flag names keep their First Cut spelling on purpose. VapourSynth for Resolve
 * converges into First Cut v4, and a renamed flag is a merge conflict for no gain.
 *
 * The defaults differ from First Cut's, and deliberately. There, a flag defaults OFF
 * so that the shipped build stays byte-identical to the pre-flag state; that
 * constraint is about not disturbing an app already in users' hands. This app has no
 * such from-state to protect, so the ported code defaults ON and the flag exists to
 * turn it OFF when something misbehaves.
 */

'use strict';

const DEFAULTS = {
  'fc.resolve.adapter': true,
};

/** VSR_FLAGS=fc.resolve.adapter=0,other.flag=1 overrides the defaults. */
function fromEnv() {
  const out = {};
  for (const pair of String(process.env.VSR_FLAGS || '').split(',')) {
    const [k, v] = pair.split('=');
    if (k && k.trim()) out[k.trim()] = !/^(0|false|off|no)$/i.test((v || '1').trim());
  }
  return out;
}

const overrides = fromEnv();

function isEnabled(name) {
  if (Object.prototype.hasOwnProperty.call(overrides, name)) return overrides[name];
  return DEFAULTS[name] === true;
}

module.exports = { isEnabled, DEFAULTS };
