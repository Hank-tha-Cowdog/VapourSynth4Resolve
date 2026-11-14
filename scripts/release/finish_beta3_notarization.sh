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

# Swap the release asset and remove the notarization caveat from the notes.
gh release upload v2.0.0-beta.3 "$DMG" --clobber -R Hank-tha-Cowdog/VapourSynth4Resolve
REPO_NOTES="$(cd .. && pwd)/docs/release-notes-2.0.0-beta.3.md"
python3 - "$REPO_NOTES" <<'PY'
import sys
from pathlib import Path
p = Path(sys.argv[1]); t = p.read_text()
t = t.replace(
    '''macOS 26.0+ \u00b7 Apple silicon (arm64) \u00b7 **Developer ID-signed DMG** (Apple\nnotarization for this build is pending \u2014 see Install).''',
    '''macOS 26.0+ \u00b7 Apple silicon (arm64) \u00b7 signed + notarized + stapled DMG.''')
t = t.replace(
    '''2. **First launch:** because notarization for this build is still pending,\n   macOS will warn that it cannot verify the app. Right-click the app in\n   Applications \u2192 **Open** \u2192 **Open anyway**. (Terminal alternative:\n   `xattr -d com.apple.quarantine \"/Applications/VapourSynth Companion.app\"`.)\n   The app is Developer ID-signed; a notarized build replaces this DMG on\n   this page as soon as it is available.\n3. Run the setup flow inside the app''',
    '''2. Launch it and run the setup flow inside the app''')
p.write_text(t)
print("notes de-caveated")
PY
gh release edit v2.0.0-beta.3 --notes-file "$REPO_NOTES" -R Hank-tha-Cowdog/VapourSynth4Resolve
echo "ASSET + NOTES SWAPPED" 
