#!/usr/bin/env bash
# Build VapourSynth from upstream source into a project-local prefix.
#
# Usage:   scripts/build-vapoursynth.sh [TAG]
# Example: scripts/build-vapoursynth.sh R75
# Default: R75
#
# Output:  vendor/vapoursynth/install-<TAG>/{include,lib,bin}
#          vendor/vapoursynth/active        symlink -> install-<TAG>
#
# After building, configure CMake with:
#   cmake -S . -B build -DVSRES_VS_PREFIX=$(pwd)/vendor/vapoursynth/active
# or leave the option unset to fall back to Homebrew's VapourSynth.

set -euo pipefail

TAG="${1:-R75}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR="$ROOT/vendor/vapoursynth"
SRC="$VENDOR/src-$TAG"
BUILD="$VENDOR/build-$TAG"
PREFIX="$VENDOR/install-$TAG"
VENV="$VENDOR/.venv"

mkdir -p "$VENDOR"

# --- 1. Native deps ---
need_brew_pkg() {
    if ! brew --prefix "$1" >/dev/null 2>&1; then
        echo "missing brew dep: $1 — install with: brew install $1" >&2
        exit 1
    fi
}
need_brew_pkg zimg

# VS R75+ requires Python >= 3.12. Auto-pick the newest brewed Python in that range.
PYTHON=""
PYVER=""
for v in 3.14 3.13 3.12; do
    candidate="/opt/homebrew/opt/python@$v/bin/python$v"
    if [[ -x "$candidate" ]]; then
        PYTHON="$candidate"
        PYVER="$v"
        break
    fi
done
if [[ -z "$PYTHON" ]]; then
    echo "no compatible Python >=3.12 found; install one of: python@3.12, @3.13, @3.14" >&2
    exit 1
fi
echo "using Python $PYVER from $PYTHON"

# --- 2. Build venv ---
if [[ ! -d "$VENV" ]]; then
    echo "creating build venv at $VENV"
    "$PYTHON" -m venv "$VENV"
fi
# shellcheck disable=SC1091
source "$VENV/bin/activate"
pip install --quiet --upgrade pip
pip install --quiet meson ninja "cython>=3"

# --- 3. Source ---
if [[ ! -d "$SRC/.git" ]]; then
    echo "cloning vapoursynth $TAG into $SRC"
    git clone --depth 1 --branch "$TAG" \
        https://github.com/vapoursynth/vapoursynth.git "$SRC"
else
    echo "vapoursynth $TAG source already present at $SRC"
fi

# --- 4. Configure ---
# zimg headers from brew are at /opt/homebrew/Cellar/zimg/<ver>/include/, libs at lib/
# Meson uses pkg-config to find them, which works because brew links the .pc files.
export PKG_CONFIG_PATH="/opt/homebrew/lib/pkgconfig:${PKG_CONFIG_PATH:-}"

if [[ ! -f "$BUILD/build.ninja" ]]; then
    echo "configuring meson build at $BUILD"
    meson setup "$BUILD" "$SRC" \
        --prefix="$PREFIX" \
        --buildtype=release \
        --default-library=both \
        -Dpython.platlibdir="$PREFIX/lib/python$PYVER/site-packages" \
        -Dpython.purelibdir="$PREFIX/lib/python$PYVER/site-packages"
else
    echo "meson build dir already configured at $BUILD"
fi

# --- 5. Compile + install ---
meson compile -C "$BUILD"
meson install -C "$BUILD"

# --- 6. Flatten the install layout ---
# Meson installs everything under lib/python<X.Y>/site-packages/vapoursynth/ on macOS.
# Mirror it to the canonical brew-style layout (prefix/include/vapoursynth/, prefix/lib/,
# prefix/lib/pkgconfig/) so pkg-config and rpath behave the same as a Homebrew install.
PY_VS="$PREFIX/lib/python$PYVER/site-packages/vapoursynth"
mkdir -p "$PREFIX/include/vapoursynth" "$PREFIX/lib/pkgconfig"

for h in "$PY_VS"/include/*.h; do
    ln -sf "$h" "$PREFIX/include/vapoursynth/$(basename "$h")"
done
for d in "$PY_VS"/lib*.dylib; do
    [[ -f "$d" ]] && ln -sf "$d" "$PREFIX/lib/$(basename "$d")"
done

# Some VS versions ship libvapoursynth.4.dylib without an unversioned alias — add one.
if [[ -f "$PREFIX/lib/libvapoursynth.4.dylib" && ! -e "$PREFIX/lib/libvapoursynth.dylib" ]]; then
    ln -sf "libvapoursynth.4.dylib" "$PREFIX/lib/libvapoursynth.dylib"
fi
# Script API may be libvsscript.dylib upstream; expose as libvapoursynth-script.dylib too
# so pkg-config + our existing CMake module names match.
if [[ -f "$PREFIX/lib/libvsscript.dylib" && ! -e "$PREFIX/lib/libvapoursynth-script.dylib" ]]; then
    ln -sf "libvsscript.dylib" "$PREFIX/lib/libvapoursynth-script.dylib"
fi

# Rewrite the bundled .pc files to include a Libs line and point at the flat layout.
cat > "$PREFIX/lib/pkgconfig/vapoursynth.pc" <<PC
prefix=$PREFIX
exec_prefix=\${prefix}
libdir=\${prefix}/lib
includedir=\${prefix}/include

Name: vapoursynth
Description: A frameserver for the 21st century
Version: ${TAG#R}
Cflags: -I\${includedir}/vapoursynth
Libs: -L\${libdir} -lvapoursynth
PC

cat > "$PREFIX/lib/pkgconfig/vapoursynth-script.pc" <<PC
prefix=$PREFIX
exec_prefix=\${prefix}
libdir=\${prefix}/lib
includedir=\${prefix}/include

Name: vapoursynth-script
Description: VapourSynth scripting API
Version: ${TAG#R}
Requires: vapoursynth
Cflags: -I\${includedir}/vapoursynth
Libs: -L\${libdir} -lvapoursynth-script
PC

# --- 7. Symlink active version ---
ln -sfn "install-$TAG" "$VENDOR/active"

echo ""
echo "==============================================================="
echo "VapourSynth $TAG built at:"
echo "  $PREFIX"
echo ""
echo "Headers: $PREFIX/include/vapoursynth/"
echo "Libs:    $PREFIX/lib/"
echo ""
echo "Configure the plugin build against this VS with:"
echo "  cmake -S . -B build -DVSRES_VS_PREFIX=$VENDOR/active"
echo "==============================================================="
