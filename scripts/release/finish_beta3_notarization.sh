#!/bin/bash
# Resume the beta.3 notarization after the Apple Developer Program License
# Agreement is re-accepted at developer.apple.com (account holder action).
# The previous attempt was blocked by notarytool HTTP 403:
#   "A required agreement is missing or has expired."
# After acceptance:  bash scripts/release/finish_beta3_notarization.sh
set -euo pipefail
cd "$(dirname "$0")/../../companion-app"
APP="dist/mac-arm64/VapourSynth Companion.app"
DMG="dist/VapourSynth Companion-2.0.0-beta.3-arm64.dmg"
ditto -c -k --keepParent "$APP" /tmp/app-beta3.zip
xcrun notarytool submit /tmp/app-beta3.zip --keychain-profile firstcut-notary --wait
xcrun stapler staple "$APP"
xcrun stapler validate "$APP"
rm -f "$DMG" "$DMG.blockmap"
PYTHON_PATH=/usr/bin/python3 npx electron-builder --mac dmg --arm64 --prepackaged "$APP"
xcrun notarytool submit "$DMG" --keychain-profile firstcut-notary --wait
xcrun stapler staple "$DMG"
xcrun stapler validate "$DMG"
spctl -a -vvv "$APP"
shasum -a 256 "$DMG"
# Then swap the release asset (replace <tree> with the repo path):
#   gh release upload v2.0.0-beta.3 "$DMG" --clobber
# and refresh the digest note in docs/release-status.md.
