#!/bin/bash
# Deploy + clean-Mac qualification of the signed DMG on the Brooklyn testbed.
#
# Usage: deploy_testbed.sh <path-to-dmg> [ssh-host]   (default host: mimir)
#
# Runs FROM the build Mac over SSH. Copies the DMG to the testbed, verifies
# the hash, mounts it, installs the app, and runs the executable subset of
# docs/clean-mac-qualification-plan.md that does not need Resolve:
#   A1 install/launch, B5 embedded-runtime self-resolution, bundle path-policy
#   audit on the SHIPPED artifact. Results (and their limits) land in
#   ~/vsres-qual-<stamp>/ on the testbed and are pulled back.
#
# The testbed must be awake (Tailscale). The script fails loudly otherwise.
set -euo pipefail

DMG="${1:?usage: deploy_testbed.sh <path-to-dmg> [ssh-host]}"
HOST="${2:-mimir}"
SSH="ssh -o ConnectTimeout=10 -o BatchMode=yes $HOST"

[ -f "$DMG" ] || { echo "DMG not found: $DMG" >&2; exit 2; }
LOCAL_SHA=$(shasum -a 256 "$DMG" | awk '{print $1}')
STAMP=$(date +%Y%m%d-%H%M%S)

echo "== reachability =="
$SSH 'echo up; sw_vers -productVersion; uname -m' || {
    echo "TESTBED UNREACHABLE — wake $HOST and retry." >&2; exit 3; }

REMOTE_SCRATCH="vsres-qual-$STAMP"
echo "== uploading DMG ($LOCAL_SHA) =="
$SSH "rm -rf ~/$REMOTE_SCRATCH && mkdir -p ~/$REMOTE_SCRATCH"
scp -o ConnectTimeout=10 "$DMG" "$HOST:~/$REMOTE_SCRATCH/"

echo "== remote qualification =="
$SSH bash -s -- "$REMOTE_SCRATCH" "$(basename "$DMG")" "$LOCAL_SHA" <<'REMOTE'
set -euo pipefail
SCRATCH="$HOME/$1"; DMGBASE="$2"; LOCAL_SHA="$3"
cd "$SCRATCH"
DMG="./$DMGBASE"
EVID="$SCRATCH/evidence.log"
say() { echo "$@" | tee -a "$EVID"; }

say "# vsres testbed qualification $(date -u +%Y-%m-%dT%H:%M:%SZ)"
say "host: $(hostname) $(sw_vers -productVersion) $(uname -m)"

ROLL_SHA=$(shasum -a 256 "$DMG" | awk '{print $1}')
say "dmg sha256: $ROLL_SHA"
[ "$ROLL_SHA" = "$LOCAL_SHA" ] && say "dmg hash: MATCH" || { say "dmg hash: MISMATCH"; exit 1; }

# clean-state facts (qualification honesty): record what the machine HAS
say "homebrew present: $([ -d /opt/homebrew ] && echo yes || echo no)"
say "prior app-install present: $([ -d '/Applications/VapourSynth Companion.app' ] && echo yes || echo no)"
say "prior OFX bundle present: $([ -d /Library/OFX/Plugins/VapourSynth.ofx.bundle ] && echo yes || echo no)"

say "== mount =="
MP=$(hdiutil attach -nobrowse -readonly "$DMG" | awk '/\/Volumes\// {print $NF}' | tail -1)
say "mounted at: $MP"
ls "$MP" | tee -a "$EVID"

APP="$MP/VapourSynth Companion.app"
say "== signature checks (shipped artifact) =="
codesign -dv "$APP" 2>&1 | tee -a "$EVID" || true
spctl -a -vv "$APP" 2>&1 | tee -a "$EVID" || true   # expected to fail while unnotarized: recorded, not hidden

say "== install to /Applications =="
rm -rf "/Applications/VapourSynth Companion.app" 2>/dev/null || true
if cp -R "$APP" /Applications/ 2>>"$EVID"; then say "installed: /Applications"; INST=/Applications; else
    mkdir -p "$HOME/Applications"; rm -rf "$HOME/Applications/VapourSynth Companion.app"
    cp -R "$APP" "$HOME/Applications/" && say "installed: ~/Applications (no admin write)"; INST="$HOME/Applications"
fi
INSTALLED="$INST/VapourSynth Companion.app"

say "== remove quarantine for qualification (unnotarized artifact) =="
xattr -dr com.apple.quarantine "$INSTALLED" 2>>"$EVID" && say "quarantine attribute cleared" || say "no quarantine attr"

say "== A1: app launch (process-level check) =="
open "$INSTALLED" 2>>"$EVID" && sleep 8
if pgrep -f "VapourSynth Companion" >/dev/null; then
    say "app process: RUNNING"
    osascript -e 'tell application "VapourSynth Companion" to quit' 2>>"$EVID" || pkill -f "VapourSynth Companion" || true
    sleep 3
    pgrep -f "VapourSynth Companion" >/dev/null && say "app process: still running after quit attempt" || say "app process: quit cleanly"
else
    say "app process: NOT RUNNING (see log; headless/ssh GUI launch may be blocked — record honestly)"
fi

say "== B5: embedded-runtime self-resolution (no Homebrew/python deps) =="
PY="$INSTALLED/Contents/Resources/OFX/VapourSynth.ofx.bundle/Contents/Frameworks/Python.framework/Versions/Current/bin/python3"
SC="$INSTALLED/Contents/Resources/scripts/render_preview_frame.py"
if [ -x "$PY" ] && [ -f "$SC" ]; then
    env -i HOME="$HOME" "$PY" "$SC" --selfcheck 2>&1 | tee -a "$EVID"
else
    say "selfcheck SKIPPED: missing $PY or $SC"
fi

say "== bundle path-policy audit on the shipped artifact =="
BC="$INSTALLED/Contents/Resources/OFX/VapourSynth.ofx.bundle/Contents"
if [ -f "$SCRATCH/repair_portable_bundle.sh" ]; then
    bash "$SCRATCH/repair_portable_bundle.sh" --audit-only "$BC" 2>&1 | tail -3 | tee -a "$EVID"
else
    say "audit SKIPPED: repair script not uploaded"
fi

say "== done $(date -u +%Y-%m-%dT%H:%M:%SZ) =="
hdiutil detach "$MP" >/dev/null 2>&1 || true
REMOTE

echo "== pulling evidence =="
OUTDIR="${OUTDIR:-$PWD/testbed-qualification}"
mkdir -p "$OUTDIR"
scp -o ConnectTimeout=10 "$HOST:~/$REMOTE_SCRATCH/evidence.log" "$OUTDIR/qualification-$STAMP.log" || true
rm -f "$REMOTE_SCRATCH/evidence.log" 2>/dev/null || true
echo "evidence: $OUTDIR/qualification-$STAMP.log"
