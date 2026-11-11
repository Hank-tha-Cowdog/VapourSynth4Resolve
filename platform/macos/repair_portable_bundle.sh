#!/bin/bash
# Self-containment repair for the staged portable OFX bundle (2026-10-31
# packaging pass). Invoked by the portable_bundle CMake target after all
# copies; performs the load-path surgery that makes the bundle resolve
# through INTERNAL paths only. Fails closed: the final audit sweeps every
# Mach-O image in the bundle for Homebrew / /usr/local / dev-tree refs and
# exits nonzero if any remain. The final passive path-policy check also
# rejects absent required loader-relative targets; contextual tokens remain
# explicitly unqualified and this is not a runtime/ABI closure certificate.
#
# Usage: repair_portable_bundle.sh <bundle-contents-dir> <plugin-list-file> <vendor-plugin-dir>
#        repair_portable_bundle.sh --audit-only <bundle-contents-dir>
# --audit-only runs JUST the fail-closed sweep (no mutation) — used by
# tests/test_bundle_selfcontained.sh to verify the FINAL staged artifact.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname "$0")" && pwd -P)"
AUDIT_ONLY=0
if [ "${1:-}" = "--audit-only" ]; then
    AUDIT_ONLY=1
    shift
fi

CONTENTS="$1"
PLUGIN_LIST="${2:-}"
VENDOR_LIBS="${3:-}"

if [ "$AUDIT_ONLY" -eq 1 ]; then
    # Audit every Mach-O by magic; no payload/tool launch or mutation.
    # A parser/enumeration/read error exits nonzero rather than an empty PASS.
    exec python3 -I -S -B "$SCRIPT_DIR/audit_portable_bundle.py" "$CONTENTS"
fi
LIBS="$CONTENTS/Libraries"
PLUGINS="$CONTENTS/Plugins"
FRW="$CONTENTS/Frameworks/Python.framework/Versions"

log() { printf '  repair: %s\n' "$*"; }

# ── 1. Filter plugins: curated set → Contents/Plugins ──────────────────────
# Curated = the proven-loadable set (scripts/install_vendored_plugins.py
# probe: loads cleanly + registers a namespace). The vendored dylibs were
# built with a non-default toolchain referencing @rpath/libc++.1.0.dylib,
# which does not resolve on stock macOS — repair to /usr/lib/libc++.1.dylib
# (same fix the user-path installer applies). Identity (-id) → @rpath/<name>
# so no build-machine path leaks.
mkdir -p "$PLUGINS"
while IFS= read -r name; do
    [ -z "$name" ] && continue
    cp "$VENDOR_LIBS/$name" "$PLUGINS/$name"
    install_name_tool -change @rpath/libc++.1.0.dylib /usr/lib/libc++.1.dylib "$PLUGINS/$name" 2>/dev/null || true
    install_name_tool -id "@rpath/$name" "$PLUGINS/$name"
done < "$PLUGIN_LIST"
# Any other @rpath/*.dylib a plugin needs stays as-is; a follow-up sweep
# prints anything unresolvable.

# libmvtools genuinely links FFTW (Homebrew fftw — GPL-2+, compatible with
# the project's GPLv3; see docs/SBOM.md). Ship it inside Libraries/ and
# rewrite the reference bundle-internally.
if grep -q '^libmvtools.dylib$' "$PLUGIN_LIST"; then
    cp /opt/homebrew/opt/fftw/lib/libfftw3f.3.dylib "$LIBS/libfftw3f.3.dylib"
    install_name_tool -id @loader_path/libfftw3f.3.dylib "$LIBS/libfftw3f.3.dylib"
    install_name_tool -change \
        /opt/homebrew/opt/fftw/lib/libfftw3f.3.dylib \
        "@loader_path/../Libraries/libfftw3f.3.dylib" \
        "$PLUGINS/libmvtools.dylib"
    log "libmvtools fftw → bundle Libraries/"
fi

# ── 1b. Vendor support libs for the vs-mlrt plugin family ─────────────────
# libvsort (and family) carry LC_RPATH @loader_path/../support and load
# onnxruntime + friends from the vendor's support/ dir — stage it at
# Contents/support so the rpath resolves inside the bundle.
if [ -d "$VENDOR_LIBS/../support" ]; then
    mkdir -p "$CONTENTS/support"
    cp "$VENDOR_LIBS/../support/"*.dylib "$CONTENTS/support/"
    for s in "$CONTENTS/support"/*.dylib; do
        install_name_tool -id "@rpath/$(basename "$s")" "$s" 2>/dev/null || true
    done
    log "vendor support libs → Contents/support"
fi

# ── 1b-2. Missing boost dependency (2026-11-05 strict-audit finding) ────────
# The vendor support set omits libboost_atomic.dylib, which
# libboost_filesystem.dylib loads via @loader_path — a clean Mac would fail
# to load the support set. Stage it from Homebrew boost when needed (same
# build-machine-sourcing pattern as the Homebrew stdlib deps in section 2).
if [ -f "$CONTENTS/support/libboost_filesystem.dylib" ] && [ ! -f "$CONTENTS/support/libboost_atomic.dylib" ]; then
    for _cand in /opt/homebrew/opt/boost/lib/libboost_atomic.dylib /usr/local/opt/boost/lib/libboost_atomic.dylib; do
        if [ -f "$_cand" ]; then
            cp "$_cand" "$CONTENTS/support/libboost_atomic.dylib"
            install_name_tool -id "@loader_path/libboost_atomic.dylib" \
                "$CONTENTS/support/libboost_atomic.dylib"
            log "libboost_atomic.dylib → support/ (dependency of libboost_filesystem)"
            break
        fi
    done
fi

# ── 2. Python stdlib extension deps: Homebrew → bundle Libraries/ ────────
# The Homebrew-built CPython's lib-dynload modules link Homebrew-built
# support libs (mpdecimal / openssl / zstd / xz / sqlite). A clean Mac has
# none of them — copy into Libraries/ and rewrite each reference
# (@loader_path from lib-dynload is six levels up to Contents).
DYNSITE="$FRW/*/lib/python3.*/lib-dynload"
declare -a HB_PAIRS=(
    "/opt/homebrew/opt/mpdecimal/lib/libmpdec.4.dylib|libmpdec.4.dylib"
    "/opt/homebrew/opt/openssl@3/lib/libssl.3.dylib|libssl.3.dylib"
    "/opt/homebrew/opt/openssl@3/lib/libcrypto.3.dylib|libcrypto.3.dylib"
    "/opt/homebrew/opt/zstd/lib/libzstd.1.dylib|libzstd.1.dylib"
    "/opt/homebrew/opt/xz/lib/liblzma.5.dylib|liblzma.5.dylib"
    "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib|libsqlite3.dylib"
)
for pair in "${HB_PAIRS[@]}"; do
    src="${pair%%|*}"; dst="${pair##*|}"
    [ -f "$src" ] || { echo "repair: missing Homebrew dep $src" >&2; exit 1; }
    cp "$src" "$LIBS/$dst"
    install_name_tool -id "@loader_path/$dst" "$LIBS/$dst"
    for so in $DYNSITE/*.so; do
        if otool -L "$so" 2>/dev/null | grep -qF "$src"; then
            install_name_tool -change "$src" \
                "@loader_path/../../../../../../../Libraries/$dst" "$so"
        fi
    done
    log "$dst → bundle Libraries/ (lib-dynload rewritten)"
done

# ── 3. Python framework internals ─────────────────────────────────────────
# 3a. cmake -E copy_directory followed the framework's SYMLINKS and
#     materialized full duplicates (Versions/Current, root Python,
#     Resources, Headers…). Restore the symlink layout — this also halves
#     the staged framework size.
for v in "$FRW"/*/; do
    ver="$(basename "$v")"
    if [ -d "$FRW/Current" ] && [ ! -L "$FRW/Current" ]; then
        rm -rf "$FRW/Current"
        ln -s "$ver" "$FRW/Current"
        log "Versions/Current duplicate → symlink → $ver"
    fi
done
PYVER_DIR="$(for v in "$FRW"/*/; do basename "$v"; done | grep -v Current | head -1)"
FWROOT="$CONTENTS/Frameworks/Python.framework"
# 3a-2. Homebrew's sitecustomize.py rode along in the framework copy and
#     points the interpreter at the HOMEBREW prefix's site-packages (which
#     on the build machine carries dev-injector .pth files — observed live:
#     `import vapoursynth` resolved from the dev tree INSIDE the bundle).
#     The bundled python's own location IS its prefix; delete the brew
#     hook (+ usercustomize) so the bundle resolves only bundle-internally.
for junk in sitecustomize.py usercustomize.py; do
    if [ -f "$FRW/$PYVER_DIR/lib/python3.14/$junk" ]; then
        rm "$FRW/$PYVER_DIR/lib/python3.14/$junk"
        log "removed Homebrew $junk from staged framework"
    fi
done
for entry in Python Resources Headers Modules; do
    if [ -e "$FWROOT/$entry" ] && [ ! -L "$FWROOT/$entry" ] && \
       [ -e "$FRW/$PYVER_DIR/$entry" ]; then
        rm -rf "$FWROOT/$entry"
        ln -s "Versions/Current/$entry" "$FWROOT/$entry"
        log "framework root $entry duplicate → symlink"
    fi
done
# 3b. Framework identity + every staged Mach-O under the framework that
#     still references the Homebrew Cellar/opt build tree (bin/python3*,
#     Resources/Python.app CLI, flat libpython copies): rewrite to
#     @loader_path relative to the real framework binary.
PYBIN="$FRW/$PYVER_DIR/Python"
install_name_tool -id "@rpath/Python" "$PYBIN"
CELLAR_RE='(/opt/homebrew/(Cellar|opt)/python@3\.[0-9]+(/[^ ]*)?/Frameworks/Python\.framework/Versions/[0-9.]+/Python)'
COMMON="$FRW/$PYVER_DIR"
while IFS= read -r img; do
    [ "$img" = "$PYBIN" ] && continue
    ref="$(otool -L "$img" 2>/dev/null | grep -oE "$CELLAR_RE" | head -1 || true)"
    [ -n "$ref" ] || continue
    img_dir="$(dirname "$img")"
    rel="${img_dir#"$COMMON"/}"
    if [ "$rel" = "$img_dir" ]; then continue; fi   # outside the version dir
    depth="$(awk -F'/' 'NF>0 {print NF}' <<< "$rel")"
    [ -z "$depth" ] && depth=0
    ups=""
    for _ in $(seq 1 "$depth" 2>/dev/null); do ups="../$ups"; done
    install_name_tool -change "$ref" "@loader_path/${ups}Python" "$img"
    log "${img#$FWROOT/} → @loader_path framework"
done < <(find "$FWROOT" -type f ! -path '*/Headers/*' ! -name '*.py' ! -name '*.pyc' ! -name '*.pyo')
# 3c. IDENTITY repairs: the flat libpython copies (lib/libpython3.x.dylib,
#     config-*/libpython3.x.dylib) carry the Homebrew framework path as
#     their LC_ID_DYLIB — -change cannot fix an identity; -id it instead.
while IFS= read -r img; do
    idref="$(otool -l "$img" 2>/dev/null | grep -A2 LC_ID_DYLIB | grep -oE '/(opt/homebrew|usr/local)/[^ ]*' | head -1 || true)"
    [ -n "$idref" ] || continue
    install_name_tool -id "@rpath/$(basename "$img")" "$img"
    log "${img#$FWROOT/} identity → @rpath/$(basename "$img")"
done < <(find "$FWROOT" -type f ! -path '*/Headers/*' \( -name '*.dylib' -o -name '*.so' \))

# ── 4. vs-python package duplicate dylibs ─────────────────────────────────
# Resources/vs-python/vapoursynth/ ships copies of libvapoursynth.dylib +
# libvsscript.dylib whose load commands still point at the dev tree. The
# import path uses vapoursynth.abi3.so (already fixed); repair these copies
# so no dev-tree string ships and any ctypes/manual load still resolves.
for dup in libvapoursynth.dylib libvsscript.dylib libvapoursynth.4.dylib; do
    f="$CONTENTS/Resources/vs-python/vapoursynth/$dup"
    [ -f "$f" ] || continue
    if otool -L "$f" | grep -qE '/Users/|/opt/homebrew|/usr/local'; then
        # Rewrite every external dylib ref to the bundle Libraries copy.
        while IFS= read -r ref; do
            base="$(basename "$ref")"
            [ -f "$LIBS/$base" ] && install_name_tool -change "$ref" \
                "@loader_path/../../../Libraries/$base" "$f"
        done < <(otool -L "$f" | grep -oE '/(Users|opt/homebrew|usr/local)/[^ ]*\.dylib' || true)
        install_name_tool -id "@rpath/$dup" "$f"
        log "vs-python/$dup repaired"
    fi
done

# ── 4a-2. vspipe executable (strict-audit finding, 2026-11-05) ─────────────
# The staged vspipe copy carried a dev-tree absolute libvsscript load and a
# '$ORIGIN' rpath. Rewrite external dylib refs whose basename sits beside it
# in the same directory to @loader_path (the 4b-2 sweep removes the token
# rpath).
_vspipe="$CONTENTS/Resources/vs-python/vapoursynth/vspipe"
if [ -f "$_vspipe" ]; then
    _vsdir="$(dirname "$_vspipe")"
    while IFS= read -r ref; do
        base="$(basename "$ref")"
        if [ -f "$_vsdir/$base" ]; then
            install_name_tool -change "$ref" "@loader_path/$base" "$_vspipe"
            log "vspipe $base → @loader_path"
        elif [ -f "$LIBS/$base" ]; then
            install_name_tool -change "$ref" "@loader_path/../../../Libraries/$base" "$_vspipe"
            log "vspipe $base → Libraries/"
        fi
    done < <(otool -L "$_vspipe" | grep -oE '/(Users|opt/homebrew|usr/local)/[^ ]*\.dylib' || true)
fi

# ── 4b. Intra-Libraries repairs ────────────────────────────────────────────
# The copied support dylibs carry Homebrew IDs and cross-dependencies
# (e.g. libssl.3 → Cellar libcrypto.3). Rewrite any Homebrew//usr/local ref
# whose basename is ALSO in Libraries/ to @loader_path/<basename>.
for dy in "$LIBS"/*.dylib; do
    [ -f "$dy" ] || continue
    while IFS= read -r ref; do
        base="$(basename "$ref")"
        if [ -f "$LIBS/$base" ]; then
            install_name_tool -change "$ref" "@loader_path/$base" "$dy"
        fi
    done < <(otool -L "$dy" | grep -oE '/(opt/homebrew|usr/local)/[^ ]*\.dylib' || true)
done
log "intra-Libraries references rewritten"

# ── 4b-2. RPATH + identity sweep (strict-audit closure, 2026-11-05) ─────────
# The strict path-policy audit (audit_portable_bundle.py) flags:
#   - LC_RPATH into /opt/homebrew or /usr/local (machine-coupling hazards)
#   - '$ORIGIN' rpaths (a Linux-ism the loader here never expands — an
#     unqualified token)
#   - dead Homebrew-layout rpaths '@loader_path/../lib' and
#     '@loader_path/../unwind' (targets do not exist in the bundle)
# Load commands and IDs are already rewritten bundle-internally by sections
# 2-4b, so these rpaths are dead search paths — delete them everywhere.
# Also fix any remaining absolute Homebrew LC_ID_DYLIB identities that
# escaped section 3c's scope (e.g. config-dir libpython copies).
log "sweeping bundle Mach-O for dead/external rpaths"
while IFS= read -r img; do
    while IFS= read -r rp; do
        [ -n "$rp" ] || continue
        install_name_tool -delete_rpath "$rp" "$img" 2>/dev/null || true
    done < <(otool -l "$img" 2>/dev/null | grep -A2 LC_RPATH \
        | grep -oE "path (/opt/homebrew|/usr/local)/[^ ]*|path \\\$ORIGIN|path @loader_path/\.\./lib|path @loader_path/\.\./unwind" \
        | sed 's/^path //' || true)
    idref="$(otool -l "$img" 2>/dev/null | grep -A2 LC_ID_DYLIB | grep -oE '/(opt/homebrew|usr/local)/[^ ]*' | head -1 || true)"
    if [ -n "$idref" ]; then
        install_name_tool -id "@rpath/$(basename "$img")" "$img"
        log "${img#$CONTENTS/} identity → @rpath/$(basename "$img")"
    fi
done < <(find "$CONTENTS" -type f ! -path '*/Headers/*' \
    \( -name '*.dylib' -o -name '*.so' -o -name '*.ofx' -o -name '*.a' \) -o \
    -type f \( -name Python -o -name python3 -o -name python3.\* -o -name python3-config -o -name vspipe \) 2>/dev/null)

# ── 4b1. Normalize write permissions (2026-11-11) ─────────────────────────
# Homebrew's framework tree ships read-only files; electron-builder's
# nested-code signing then fails with "Permission denied" on files it resigns
# (observed on pip's read-only .py payload). The staged payload must be
# writable for the signing/notarization pass anyway.
chmod -R u+w "$CONTENTS"

# ── 4b2. Prune Windows-only launchers (2026-11-11) ────────────────────────
# The embedded CPython ships pip's distlib win launchers (*.exe). codesign
# cannot sign PE binaries, and electron-builder's nested-code signing fails
# the whole DMG build on them (observed: distlib/t32.exe). They are never
# executed on macOS — remove them from the staged payload.
pruned=0
while IFS= read -r winbin; do
    rm -f "$winbin" && pruned=$((pruned + 1))
done < <(find "$CONTENTS" -type f \( -name '*.exe' -o -name '*.dll' -o -name '*.bat' \) \
    -path '*/site-packages/pip/*' 2>/dev/null)
[ "$pruned" -gt 0 ] && log "pruned $pruned Windows-only pip launcher(s) from the payload"

# ── 4c. Re-sign everything we touched (ad-hoc) ─────────────────────────────
# install_name_tool invalidates signatures; on arm64 macOS the kernel
# SIGKILLs binaries with invalid signatures (verified live: the staged
# bin/python3 died with 'Killed: 9' until re-signed). Ad-hoc is correct
# for local/staged builds; the release signing+notarization pass (gate 7)
# replaces it with the Developer ID identity.
log "re-signing all bundle Mach-O (ad-hoc)"
while IFS= read -r img; do
    codesign --force --sign - --timestamp=none "$img" 2>/dev/null || true
done < <(find "$CONTENTS" -type f ! -path '*/Headers/*' \
    \( -name '*.dylib' -o -name '*.so' -o -name '*.ofx' -o -name '*.a' \) -o \
    -type f \( -name Python -o -name python3 -o -name python3.\* -o -name python3-config -o -name vspipe \) 2>/dev/null; \
    find "$CONTENTS/Plugins" -type f 2>/dev/null)
# Framework binaries specifically (the 'Python' dylib + CLI executables).
for extra in "$FRW/$PYVER_DIR/Python" "$FRW/$PYVER_DIR/bin/"python3 "$FRW/$PYVER_DIR/bin/"python3.*; do
    [ -f "$extra" ] && codesign --force --sign - --timestamp=none "$extra" 2>/dev/null || true
done

# ── 5. Audit: fail closed on any non-internal reference ───────────────────
# Allowed: @loader_path/@rpath/@executable_path, /usr/lib, /System.
# Everything else (Homebrew, /usr/local, dev tree) fails the staging.
log "audit: sweeping bundle for external references"
bad=0
while IFS= read -r img; do
    if otool -L "$img" 2>/dev/null | grep -vE '^\S+:|^$' | \
       grep -E '/(opt/homebrew|usr/local|Users)/' >/dev/null; then
        echo "AUDIT FAIL: $img" >&2
        otool -L "$img" | grep -E '/(opt/homebrew|usr/local|Users)/' >&2
        bad=1
    fi
done < <(find "$CONTENTS" -type f \( -name '*.dylib' -o -name '*.so' -o -name 'Python' -o -name '*.ofx' -o -name 'python3*' \) ! -path '*/Headers/*')
[ "$bad" -eq 0 ] || exit "$bad"
# Text-level audit: .pth files must not inject external paths, and no
# Homebrew sitecustomize hooks may ship. (The staged sysconfigdata keeps
# Homebrew BUILD paths — build metadata only, no runtime effect; recorded
# in docs/packaging.md.)
for pth in $(find "$CONTENTS" -name '*.pth' 2>/dev/null); do
    if grep -qE '/(opt/homebrew|usr/local)/|/Users/' "$pth"; then
        echo "AUDIT FAIL: $pth carries external paths" >&2
        grep -E '/(opt/homebrew|usr/local)/|/Users/' "$pth" >&2
        exit 1
    fi
done
if find "$CONTENTS/Frameworks" -name 'sitecustomize.py' -o -name 'usercustomize.py' | grep -q .; then
    echo "AUDIT FAIL: Homebrew sitecustomize hook present" >&2
    exit 1
fi
# The legacy absolute-string sweep cannot detect a missing sibling such as
# support/libboost_atomic.dylib. Use the same passive parser as --audit-only
# before this mutating staging path can report success. No payload is launched.
python3 -I -S -B "$SCRIPT_DIR/audit_portable_bundle.py" "$CONTENTS"
log "audit: PASS — path policy checked; contextual runtime closure remains unqualified"
exit 0