#!/usr/bin/env bash
# Register the dev companion-app/ path so the OFX plugin's Configure… button
# can launch it. Writes to ~/Library/Application Support/VapourSynth-OFX/dev-companion-path.txt
# which popout_launcher.mm reads at runtime.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMPANION="$ROOT/companion-app"

if [[ ! -d "$COMPANION" ]]; then
    echo "error: companion-app/ not found at $COMPANION" >&2
    exit 1
fi
if [[ ! -d "$COMPANION/node_modules/electron" ]]; then
    echo "error: companion-app/node_modules/electron missing — run \`npm install\` in companion-app/ first" >&2
    exit 1
fi

SUPPORT="$HOME/Library/Application Support/VapourSynth-OFX"
mkdir -p "$SUPPORT"
echo "$COMPANION" > "$SUPPORT/dev-companion-path.txt"

echo "registered dev companion-app:"
echo "  $COMPANION"
echo "marker file:"
echo "  $SUPPORT/dev-companion-path.txt"
echo ""
echo "the OFX plugin's Configure… button will now spawn the companion via:"
echo "  $COMPANION/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron $COMPANION"
echo ""
echo "to switch back to a shipped install, delete that marker file."
