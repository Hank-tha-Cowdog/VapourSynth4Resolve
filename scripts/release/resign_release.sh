#!/bin/bash
# Inside-out re-sign of the BUILT app with the Developer ID identity.
#
# Why this exists: electron-builder signs outside-in on deep trees like ours —
# it seals the OFX bundle before its Plugins dylibs receive their final
# signatures, so `codesign --verify` reports "a sealed resource is missing or
# invalid" and notarytool rejects the submission ("The signature of the binary
# is invalid", 73 files). This pass re-signs every Mach-O file first (any
# order), then every nested bundle innermost-out, then the app itself — which
# is the order codesign requires.
#
# It also prunes CPython's stdlib test tree: its sparse-zip fixtures cannot be
# unpacked by the notary service ("could not be unpacked" warnings) and the
# directory is dead weight in a shipped runtime.
#
# Usage: resign_release.sh <path to .app>
# Env:   VSRES_SIGN_IDENTITY (default: Developer ID Application: Zachary Holbert)
set -euo pipefail

APP="${1:?usage: resign_release.sh <path to .app>}"
IDENTITY="${VSRES_SIGN_IDENTITY:-Developer ID Application: Zachary Holbert (4ZT24C8JQZ)}"
ENT="$(cd "$(dirname "$0")/../.." && pwd)/companion-app/build-resources/entitlements.mac.plist"

[ -d "$APP" ] || { echo "no app at: $APP" >&2; exit 2; }
[ -f "$ENT" ] || { echo "no entitlements at: $ENT" >&2; exit 2; }

echo "== prune CPython test tree (sparse-zip fixtures break notarization) =="
find "$APP" -type d -path "*/lib/python3*/test" -prune -exec rm -rf {} + 2>/dev/null || true

echo "== collect Mach-O files =="
LIST="$(mktemp)"
find "$APP" -type f -print0 | while IFS= read -r -d '' f; do
    case "$f" in */_CodeSignature/*) continue ;; esac
    if file -b "$f" 2>/dev/null | head -c 80 | grep -q "Mach-O"; then printf '%s\n' "$f" >> "$LIST"; fi
done
TOTAL=$(wc -l < "$LIST" | tr -d ' ')
echo "   $TOTAL Mach-O files"

echo "== sign files =="
n=0
while IFS= read -r f; do
    n=$((n + 1))
    if ! codesign --force --options runtime --timestamp \
        --entitlements "$ENT" --sign "$IDENTITY" "$f" >/dev/null 2>&1; then
        echo "FAILED signing file: $f" >&2; exit 1
    fi
    [ $((n % 50)) -eq 0 ] && echo "   ...$n/$TOTAL"
done < "$LIST"
rm -f "$LIST"

echo "== sign nested bundles (innermost first) =="
find "$APP" -type d \( -name "*.framework" -o -name "*.app" -o -name "*.bundle" -o -name "*.xpc" \) \
    ! -path "$APP" | awk -F/ '{print NF "\t" $0}' | sort -rn | cut -f2- | while IFS= read -r b; do
    echo "   $b"
    if ! codesign --force --options runtime --timestamp \
        --entitlements "$ENT" --sign "$IDENTITY" "$b" >/dev/null 2>&1; then
        echo "FAILED signing bundle: $b" >&2; exit 1
    fi
done

echo "== sign app (outermost) =="
codesign --force --options runtime --timestamp \
    --entitlements "$ENT" --sign "$IDENTITY" "$APP"

echo "== verify (deep strict) =="
codesign --verify --deep --strict --verbose=2 "$APP" 2>&1 | tail -2
OFX="$APP/Contents/Resources/OFX/VapourSynth.ofx.bundle"
if [ -d "$OFX" ]; then
    codesign --verify "$OFX" && echo "   ofx bundle: VERIFY OK"
    codesign --verify "$OFX/Contents/MacOS/VapourSynth.ofx" && echo "   ofx exe:    VERIFY OK"
fi
echo "SIGNING PASS COMPLETE"
