#!/bin/bash
# Notarize + staple the built app and DMG for a release. Version-agnostic —
# pass the version (the old finish_*_notarization.sh scripts baked version
# strings into filenames and went stale between releases).
#
# Usage:  bash scripts/release/notarize_and_finish.sh 2.0.0-beta.4
# Expects the app already signed (resign_release.sh) in companion-app/dist.
set -euo pipefail
VERSION="${1:?usage: notarize_and_finish.sh <version, e.g. 2.0.0-beta.4>}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT/companion-app"
APP="dist/mac-arm64/VapourSynth Companion.app"
DMG="dist/VapourSynth Companion-${VERSION}-arm64.dmg"
[ -d "$APP" ] || { echo "missing $APP — run the build first" >&2; exit 2; }
echo "== notarize + staple APP =="
ditto -c -k --keepParent "$APP" "/tmp/app-${VERSION}.zip"
xcrun notarytool submit "/tmp/app-${VERSION}.zip" --keychain-profile firstcut-notary --wait
xcrun stapler staple "$APP"
xcrun stapler validate "$APP"
echo "== rebuild DMG from the STAPLED app, then notarize + staple DMG =="
rm -f "$DMG" "$DMG.blockmap"
PYTHON_PATH=/usr/bin/python3 npx electron-builder --mac dmg --arm64 --prepackaged "$APP"
xcrun notarytool submit "$DMG" --keychain-profile firstcut-notary --wait
xcrun stapler staple "$DMG"
xcrun stapler validate "$DMG"
echo "== verdicts =="
spctl -a -vvv "$APP"
shasum -a 256 "$DMG"
echo "DONE: $DMG"
