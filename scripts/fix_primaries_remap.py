#!/usr/bin/env python3
"""Repair/normalize the cinema-P3 script step to the VERIFIED theatrical form.

Skippy twice generated invalid resize calls (invented argument names —
`primaries_in=`/`primaries_out=`/`transfer_out=` — which VapourSynth's
resize/zimg does not accept; the signature is `primaries_in_s`/`primaries_s`,
`transfer_in_s`/`transfer_s`). Each bad step failed host-side pre-accept
validation, so the chain was refused and the node passed frames through.

The user confirmed intent: THEATRICAL DCI-P3 — SMPTE ST 431-2 primaries +
ST 428 (2.6-power DCI) gamma — as a stage-10 preprocess conversion
(Rec.709 → theatrical DCI-P3). This script rewrites any cinema-P3-flavored
script step in a config to exactly that, using the call form verified live
against VapourSynth R75 + the installed plugin set on Oct 26.

Applies to ~/Library/Application Support/VapourSynth-OFX/last-config.json
(the recovery sidecar) unless --config <path> is given. Does NOT touch the
node's OFX _config parameter — the corrected chain lands on the node via
the next Configure → edit → Save-and-close cycle (auto-apply + validation).
"""
import argparse
import json
import os
import stat
import sys

CONFIG = os.path.expanduser("~/Library/Application Support/VapourSynth-OFX/last-config.json")

# Verified form (R75 + zimg): *_in_s/_s string args; 'st431-2' = theatrical
# DCI-P3 primaries; 'st428' = DCI 2.6-power transfer. 'st432-1' is P3-D65 —
# a DIFFERENT white point, not interchangeable.
REPAIRED = '''# --- Stage 10: Rec.709 -> theatrical DCI-P3 (ST 431-2 primaries, ST 428 gamma) ---
# Gamut/gamma remaps run on RGB tristimulus values, not YUV - bounce to
# RGB, remap, and bounce back so the restoration filters (QTGMC etc.)
# keep their YUV420P16 input.

# Step 1: YUV -> full-range float RGB. matrix='709' here is only the
# YUV<->RGB conversion matrix for THIS leg - it states what the clip
# currently IS, not what it becomes below.
clip = to_rgb(clip, depth=32, matrix='709')

# Step 2: the actual remap to theatrical DCI-P3 (~6300K cinema white,
# 2.6-power DCI gamma). zimg applies the chromatic-adaptation matrix for
# the white-point shift automatically. Argument names are *_in_s/_s -
# resize has NO *_out arguments (common model-generated mistake).
# NOTE: 'st432-1' is P3-D65 (D65 white) - a different flavor, not this.
clip = core.resize.Bicubic(clip, primaries_in_s='709', primaries_s='st431-2',
                           transfer_in_s='709', transfer_s='st428')

# Step 3: back to YUV420P16 16-bit for the rest of the chain.
clip = to_yuv(clip, css='420', depth=16, matrix='709')
'''

# Any cinema-P3-flavored script step (bad or good) is normalized, so the
# confirmed intent is unambiguous and always the verified call form.
MARKERS = ("p3", "primaries", "431", "432")


def is_p3_step(code: str) -> bool:
    low = code.lower()
    return any(m in low for m in MARKERS) and ("resize" in low or "primaries" in low)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=CONFIG)
    args = ap.parse_args()

    with open(args.config) as f:
        cfg = json.load(f)
    fixed = 0
    for step in cfg.get("chain", []):
        if step.get("type") != "script":
            continue
        code = (step.get("params") or {}).get("code", "")
        if code and is_p3_step(code):
            if code.strip() == REPAIRED.strip():
                continue
            step["params"]["code"] = REPAIRED
            if not step["params"].get("label", "").lower().startswith(("cinema", "dci")):
                step["params"]["label"] = "DCI-P3 Theatrical — Rec.709 → ST 431-2/428"
            fixed += 1
    if not fixed:
        print("no cinema-P3 script step found; nothing to do")
        return 0
    st = os.stat(args.config)
    tmp = args.config + ".tmp"
    with open(tmp, "w") as f:
        json.dump(cfg, f)
    os.chmod(tmp, stat.S_IMODE(st.st_mode))
    os.replace(tmp, args.config)
    print(f"normalized {fixed} cinema-P3 step(s) to the verified theatrical form in {args.config}")
    return 0


if __name__ == "__main__":
    sys.exit(main())