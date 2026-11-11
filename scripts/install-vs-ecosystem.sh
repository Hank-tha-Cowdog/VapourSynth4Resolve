#!/usr/bin/env bash
# Installs the Python modules + VS plugins QTGMC and related havsfunc recipes need.
# Run this once per machine (or every time you want to refresh from upstream).
#
# Drops .py modules into:
#   ~/Library/Application Support/VapourSynth-OFX/vs-python/
# (The chain composer injects sys.path so Python finds them automatically.)
#
# VS *plugins* (mvtools.dylib, znedi3.dylib, fmtconv.dylib, etc.) are the bigger
# unknown — Homebrew has formulas for some, but not all of the QTGMC dependency
# tree. This script installs what brew has + downloads the rest from
# yuygfgg/Macos_vapoursynth_plugins where available, and prints what's left to
# install manually. VS plugins go to:
#   ~/Library/Application Support/VapourSynth/Plugins/
# (VapourSynth's default plugin search path — no env var needed.)

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VS_PY="$HOME/Library/Application Support/VapourSynth-OFX/vs-python"
# We install plugins into the legacy macOS user plugin dir. VS R75 does NOT
# autoload from here by default (it changed to a site-packages-relative model),
# but our OFX plugin's plugin_entry.cpp::ensure_vs_plugin_path() sets
# VAPOURSYNTH_EXTRA_PLUGIN_PATH to this directory at bundle-load time, so
# everything we drop here becomes visible to VS inside Resolve's process.
VS_PLUGINS="$HOME/Library/Application Support/VapourSynth/Plugins"

mkdir -p "$VS_PY" "$VS_PLUGINS"

# --- Python modules (pure .py — no compilation) -----------------------------------
# We pin to the LAST single-file tags of havsfunc / mvsfunc. Upstream `master`
# moved to a package layout (havsfunc/havsfunc/*.py) and the newest r34+ pulls in
# a `vsjetpack` dependency tree we don't want to drag in for the OFX use case.
#
# havsfunc r33 imports only: mvsfunc, adjust, + VS plugins (mvtools, znedi3, fmtconv).
# mvsfunc  r10 requires only: fmtconv, BM3D (VS plugins). Pure-Python otherwise.
HAVSFUNC_TAG="r33"
MVSFUNC_TAG="r10"

echo "▸ Installing havsfunc ($HAVSFUNC_TAG), mvsfunc ($MVSFUNC_TAG), adjust → $VS_PY"

curl -fL --progress-bar -o "$VS_PY/havsfunc.py" \
    "https://raw.githubusercontent.com/HomeOfVapourSynthEvolution/havsfunc/${HAVSFUNC_TAG}/havsfunc.py"
curl -fL --progress-bar -o "$VS_PY/mvsfunc.py" \
    "https://raw.githubusercontent.com/HomeOfVapourSynthEvolution/mvsfunc/${MVSFUNC_TAG}/mvsfunc.py"
curl -fL --progress-bar -o "$VS_PY/adjust.py" \
    https://raw.githubusercontent.com/dubhater/vapoursynth-adjust/master/adjust.py
# nnedi3_resample is used by some QTGMC variants (optional — don't fail the install)
curl -fL --progress-bar -o "$VS_PY/nnedi3_resample.py" \
    https://raw.githubusercontent.com/HomeOfVapourSynthEvolution/nnedi3_resample/master/nnedi3_resample.py || \
    echo "  (nnedi3_resample.py — optional, skipped)"

# --- havsfunc compatibility patch: _lambda/_global → 'lambda'/'global' ------------
# havsfunc r33 passes `_lambda=X` and `_global=Y` to mv.Analyse / mv.Recalculate
# as kwargs, because Python forbids `lambda=` and `global=` (reserved words).
# This convention assumes mvtools registers those args with underscores. But
# VapourSynth's argument-name validator rejects names containing leading
# underscores ("Argument name '_lambda' contains illegal characters"), so a
# stock mvtools (which is what we have) only accepts `lambda` / `global`.
#
# At runtime havsfunc then dies with:
#   "Analyse: Function does not take argument(s) named _lambda, _global"
#
# Fix at install time: rewrite those kwargs into the dict-spread form
#   **{'lambda': X}, **{'global': Y}
# which the dict() constructor will splat into ordinary `lambda` / `global`
# keys when called. End result: havsfunc passes `lambda` / `global` to mvtools
# regardless of mvtools' arg-name convention.
# Use the same Python we configure VSScript with (Resolve's 3.13). Falls
# back through 3.14/3.12 if 3.13 isn't installed. Absolute paths avoid
# asdf/pyenv shim interference. ls + head + set -e is fragile (any missing
# path aborts the pipeline); test each path with [[ -x ]] instead.
PATCH_PY=""
for _candidate in /opt/homebrew/bin/python3.13 /opt/homebrew/bin/python3.14 /opt/homebrew/bin/python3.12 /usr/bin/python3; do
    if [[ -x "$_candidate" ]]; then PATCH_PY="$_candidate"; break; fi
done
if [[ -n "$PATCH_PY" ]]; then
    "$PATCH_PY" - "$VS_PY/havsfunc.py" <<'PYEOF'
import re, sys
p = sys.argv[1]
src = open(p).read()
before = src
src = re.sub(r"\b_lambda\s*=\s*([A-Za-z_][\w.]*)", r"**{'lambda': \1}", src)
src = re.sub(r"\b_global\s*=\s*([A-Za-z_][\w.]*)", r"**{'global': \1}", src)
if src != before:
    open(p, 'w').write(src)
    print("  → patched _lambda/_global → dict-spread in havsfunc.py")
else:
    print("  → havsfunc.py already patched (or didn't need the rewrite)")
PYEOF
else
    echo "  ⚠ no Python found for havsfunc patch — chain may fail with _lambda/_global error"
fi

echo "  → installed: havsfunc, mvsfunc, adjust, nnedi3_resample"

# --- nnedi3 weights file (hardcoded system path inside libnnedi3) -----------------
# The libnnedi3.dylib binary hardcodes the path /usr/local/share/nnedi3/nnedi3_weights.bin
# (no env var, no plugin-arg override). QTGMC's interpolation step dies with
# "nnedi3: Couldn't open file '/usr/local/share/nnedi3/nnedi3_weights.bin'"
# until those weights are physically present at that path.
#
# Idempotent: only fetches + installs if the target file is missing. Caches the
# download under ~/Library/Application Support/VapourSynth-OFX/nnedi3/ so a
# subsequent reinstall doesn't hit the network if /usr/local/share/nnedi3 was
# wiped (e.g. macOS upgrade flushed /usr/local).
NNEDI3_SYSTEM_PATH="/usr/local/share/nnedi3/nnedi3_weights.bin"
NNEDI3_CACHE_DIR="$HOME/Library/Application Support/VapourSynth-OFX/nnedi3"
NNEDI3_CACHE_PATH="$NNEDI3_CACHE_DIR/nnedi3_weights.bin"

if [[ ! -f "$NNEDI3_SYSTEM_PATH" ]]; then
    echo ""
    echo "▸ Installing nnedi3 weights → $NNEDI3_SYSTEM_PATH (sudo needed once)"

    # Fetch to user cache first (no sudo). Skip the download if we cached it last run.
    if [[ ! -f "$NNEDI3_CACHE_PATH" ]]; then
        mkdir -p "$NNEDI3_CACHE_DIR"
        curl -fL --progress-bar -o "$NNEDI3_CACHE_PATH" \
            https://raw.githubusercontent.com/dubhater/vapoursynth-nnedi3/master/src/nnedi3_weights.bin
    else
        echo "  (using cached weights at $NNEDI3_CACHE_PATH)"
    fi

    # Now sudo-install to the hardcoded system path.
    if sudo -n true 2>/dev/null; then
        SUDO_OK=1
    else
        echo "  (will prompt for your password — needed to write /usr/local/share/nnedi3)"
        SUDO_OK=0
    fi
    sudo mkdir -p /usr/local/share/nnedi3
    sudo cp "$NNEDI3_CACHE_PATH" "$NNEDI3_SYSTEM_PATH"
    sudo chmod 644 "$NNEDI3_SYSTEM_PATH"
    echo "  → installed: $(stat -f '%z bytes' "$NNEDI3_SYSTEM_PATH")"
else
    echo "  → nnedi3 weights already present at $NNEDI3_SYSTEM_PATH"
fi

# --- VSScript config (tells VS R75 which Python to embed) -------------------------
# Without this, getVSScriptAPI() returns NULL inside the OFX plugin and every
# chain fails with "Failed to acquire VSScript API". The VS Python CLI writes
# ~/.config/vapoursynth/vapoursynth.toml mapping the libvsscript.dylib path →
# the Python interpreter + libpython path it should embed. Idempotent — running
# it again just re-confirms the existing mapping.
VS_INSTALL="$ROOT/vendor/vapoursynth/active"
if [[ -d "$VS_INSTALL" ]]; then
    PYVER=$(ls "$VS_INSTALL/lib" 2>/dev/null | grep -E '^python[0-9.]+$' | head -1)
    VS_BUILD_PY="/opt/homebrew/bin/${PYVER}"

    # CRITICAL: pick the Python VSScript should embed based on what RESOLVE
    # uses in-process, not what we built VS against. Resolve 21 on Apple Silicon
    # bundles its own Python (3.13 as of 2026). When the OFX plugin runs inside
    # Resolve, libvsscript loads libpython per this TOML; if that's a different
    # Python version than the one Resolve already has loaded, we end up with
    # two libpython instances in one process and our sys.path patch (which
    # mutates Resolve's Python) lands on the wrong interpreter → vapoursynth
    # import fails. Confirmed via /tmp/vsres-syspath.log showing sys.prefix is
    # python@3.13 even when our build is against 3.14.
    #
    # vapoursynth.abi3.so uses the stable Python C ABI (Py_LIMITED_API), so it
    # cross-version-compatibly loads in any Python 3.x ≥ the build's minimum.
    # That's how we can build VS against 3.14 but tell vsscript to embed 3.13.
    RESOLVE_PYVER="python3.13"
    PY_BIN="/opt/homebrew/bin/${RESOLVE_PYVER}"
    if [[ ! -x "$PY_BIN" ]]; then
        echo "  ⚠ ${PY_BIN} not found — falling back to build Python ${PYVER}"
        echo "    chain renders may fail with 'Failed to import vapoursynth' if"
        echo "    Resolve's bundled Python doesn't match. Run:"
        echo "      brew install ${RESOLVE_PYVER#python}"
        PY_BIN="$VS_BUILD_PY"
    fi

    if [[ -x "$PY_BIN" && -n "$PYVER" ]]; then
        echo ""
        echo "▸ Configuring VSScript → ~/.config/vapoursynth/vapoursynth.toml"
        echo "  (vsscript will embed $PY_BIN — matches Resolve 21's Python)"
        VS_SITE_PACKAGES="$(cd "$VS_INSTALL/lib/$PYVER/site-packages" && pwd)"
        PYTHONPATH="$VS_SITE_PACKAGES" \
            "$PY_BIN" -m vapoursynth config 2>&1 | sed 's/^/  /'
        # Older versions of this script wrote a vapoursynth.conf (legacy format).
        # VS R75 only reads vapoursynth.toml — clear the stale .conf to avoid confusion.
        rm -f "$HOME/.config/vapoursynth/vapoursynth.conf"

        # The PYTHONPATH env-var path doesn't work inside Resolve's OFX process —
        # observed empirically: setenv("PYTHONPATH", ...) inside getPluginIDs DOES
        # set the env var (confirmed via log), but Python in Resolve's context
        # ignores it. Most likely Resolve has its own embedded Python pre-init'd
        # for the scripting API, so by the time libvsscript calls Py_Initialize,
        # sys.path is already locked and PYTHONPATH no longer matters.
        #
        # Workaround: drop a .pth file in Homebrew Python's site-packages. Python
        # reads .pth files via site.py during init regardless of env vars and
        # regardless of whether Python is being initialized for the first time
        # or re-imported in an already-running interpreter. The `import sys;
        # sys.path.insert(0, ...)` form prepends our path (vs vanilla .pth which
        # only appends, which would lose to Homebrew's own vapoursynth.so).
        BREW_SITE=$(ls -d /opt/homebrew/lib/$PYVER/site-packages 2>/dev/null | head -1)
        if [[ -d "$BREW_SITE" ]]; then
            PTH_FILE="$BREW_SITE/vapoursynth-resolveofx.pth"
            echo "  → writing $PTH_FILE"
            cat > "$PTH_FILE" <<PTHEOF
import sys; sys.path.insert(0, '$VS_SITE_PACKAGES')
PTHEOF
            echo "    (prepends our VS R75 site-packages to Python's sys.path"
            echo "     before Homebrew's vapoursynth.so R73 — works inside Resolve"
            echo "     even when env vars are ignored)"
        else
            echo "  ⚠ /opt/homebrew/lib/$PYVER/site-packages not found — skipping .pth"
            echo "    if 'Failed to import VapourSynth Python module' persists,"
            echo "    you need to write that .pth manually"
        fi
    else
        echo "  ⚠ skipping VSScript config — $PY_BIN not found"
        echo "    chain renders will fail with 'Failed to acquire VSScript API'"
        echo "    until you run: $PY_BIN -m vapoursynth config"
    fi
fi

# --- VS native plugins (compiled .dylib) ------------------------------------------
echo ""
echo "▸ VS plugins (compiled .dylib) — QTGMC needs at minimum: mvtools, znedi3, fmtconv"

# Homebrew formulas (when they exist).
if command -v brew >/dev/null 2>&1; then
    for formula in vapoursynth-mvtools vapoursynth-znedi3 vapoursynth-fmtconv; do
        if brew info "$formula" >/dev/null 2>&1; then
            echo "  → brew install $formula"
            brew install "$formula" 2>&1 | sed 's/^/    /' || true
            # brew installs to /opt/homebrew/lib/vapoursynth/. Symlink into our user
            # plugin dir so VS finds them when launched from Resolve's process
            # (which doesn't inherit brew's plugin search path).
            BREW_PREFIX="$(brew --prefix)"
            for f in "$BREW_PREFIX"/lib/vapoursynth/*.dylib; do
                [[ -f "$f" ]] || continue
                ln -sf "$f" "$VS_PLUGINS/$(basename "$f")"
            done
        fi
    done
fi

# Fallback / supplement: yuygfgg/Macos_vapoursynth_plugins ships prebuilt arm64
# .dylibs for mvtools, znedi3, fmtconv, bm3d, nnedi3, eedi3, RemoveGrain — everything
# QTGMC needs and then some. Homebrew has no formulas for these, so this is the
# canonical source on Apple Silicon. Clone-on-first-run, pull-on-subsequent.
VENDOR_DIR="$ROOT/vendor/Macos_vapoursynth_plugins"
if [[ ! -d "$VENDOR_DIR/.git" ]]; then
    echo "  → cloning yuygfgg/Macos_vapoursynth_plugins (one-time, ~hundreds of MB)"
    mkdir -p "$ROOT/vendor"
    git clone --depth 1 https://github.com/yuygfgg/Macos_vapoursynth_plugins "$VENDOR_DIR" \
        2>&1 | sed 's/^/    /'
else
    echo "  → vendor/Macos_vapoursynth_plugins/ already present; skipping clone"
    echo "    (run 'git -C $VENDOR_DIR pull' to refresh)"
fi

if [[ -d "$VENDOR_DIR/lib" ]]; then
    # IMPORTANT: only link from lib/, NOT recursively. The yuygfgg repo has a
    # support/ directory with dependency libs (libfftw3f, libonnxruntime,
    # libboost_filesystem, etc.) that are NOT VS plugins. They're loaded by the
    # plugins themselves via @loader_path/../support. If we drop them into the
    # VS plugin search path, VS scans them as if they were plugins → AMFI on
    # Apple Silicon kills the entire VS process (no error message, just SIGKILL).

    # First, clean up symlinks from any prior (buggy) install run. We only remove
    # symlinks that point into our vendor tree — leave any user-placed files alone.
    cleaned=0
    for link in "$VS_PLUGINS"/*.dylib "$VS_PLUGINS"/*.dylib.disabled; do
        [[ -L "$link" ]] || continue
        tgt=$(readlink "$link" || true)
        if [[ "$tgt" == "$ROOT/vendor/"* ]]; then
            rm "$link"
            cleaned=$((cleaned + 1))
        fi
    done
    [[ $cleaned -gt 0 ]] && echo "  → cleaned $cleaned stale symlink(s) from previous install"

    echo "  → linking arm64 plugins from vendor/Macos_vapoursynth_plugins/lib/"
    linked=0
    skipped_unsigned=()
    skipped_badep=()
    for f in "$VENDOR_DIR/lib"/*.dylib; do
        [[ -f "$f" ]] || continue
        # Filter 1: the plugin itself must be linker-signed. AMFI on Apple Silicon
        # rejects plain ad-hoc dylibs (no linker-signed flag) via SIGKILL when VS
        # tries to dlopen them. As of yuygfgg HEAD: libmvtools (rebuilt below) and
        # libfft3dfilter.
        flags=$(codesign --display --verbose=2 "$f" 2>&1 | grep "flags=" | head -1)
        if [[ "$flags" != *"linker-signed"* ]]; then
            skipped_unsigned+=("$(basename "$f")")
            continue
        fi
        # Filter 2: skip plugins with @rpath deps on OTHER libs (not their own
        # install_name). These deps resolve to vendor/Macos_vapoursynth_plugins/support/
        # via @loader_path/../support, and every dylib in support/ is plain ad-hoc
        # signed (not linker-signed) → AMFI on Apple Silicon SIGKILLs the entire VS
        # process during plugin scan. Affected deps observed in the yuygfgg repo:
        # libfftw3f.3, libfftw3f_threads.3, libc++.1.0, libgsl.28, libboost_filesystem,
        # libonnxruntime.1.23.2. A plugin's @rpath self-reference (e.g. libbm3dcpu
        # → @rpath/libbm3dcpu) is benign and we keep those.
        plugin_basename=$(basename "$f")
        bad_dep=""
        while IFS= read -r dep; do
            dep_base=$(basename "$dep")
            # skip self-references and non-@rpath lines
            if [[ "$dep" == *"@rpath/"* && "$dep_base" != "$plugin_basename" ]]; then
                bad_dep="$dep_base"
                break
            fi
        done < <(otool -L "$f" 2>&1 | awk '/@rpath\// {print $1}')
        if [[ -n "$bad_dep" ]]; then
            skipped_badep+=("$(basename "$f") (→ $bad_dep)")
            continue
        fi
        ln -sf "$f" "$VS_PLUGINS/$(basename "$f")"
        linked=$((linked + 1))
    done
    echo "    linked $linked .dylib plugin(s)"
    if [[ ${#skipped_unsigned[@]} -gt 0 ]]; then
        echo "    skipped (not linker-signed, AMFI would SIGKILL VS):"
        for s in "${skipped_unsigned[@]}"; do echo "      - $s"; done
    fi
    if [[ ${#skipped_badep[@]} -gt 0 ]]; then
        echo "    skipped (links @rpath/<external lib> resolving to vendor/support/,"
        echo "             AMFI would SIGKILL VS during plugin scan):"
        for s in "${skipped_badep[@]}"; do echo "      - $s"; done
    fi
fi

# --- mvtools (build from source — yuygfgg's prebuilt is AMFI-rejected) ------------
# The yuygfgg/Macos_vapoursynth_plugins repo ships libmvtools.dylib re-signed
# without the linker-signed flag, which Apple Silicon's AMFI refuses to load
# via dlopen from a non-system path. mvtools is critical (QTGMC, MAnalyse, MDegrain
# all depend on it), so we build it from source where the linker emits a fresh
# linker-signed signature on this machine — AMFI trusts that.
#
# The dubhater/vapoursynth-mvtools master also has a bug in meson.build where the
# darwin -DPREFIX guard only covers x86, so the aarch64 build links against
# unprefixed asm symbols and fails. We patch it inline.
MVTOOLS_SRC="$ROOT/vendor/vapoursynth-mvtools"
if ! ls "$VS_PLUGINS"/libmvtools.dylib >/dev/null 2>&1 || \
       ! codesign --display --verbose=2 "$VS_PLUGINS"/libmvtools.dylib 2>&1 | grep -q "linker-signed"; then
    echo ""
    echo "▸ Building mvtools from source (yuygfgg's prebuilt is AMFI-rejected)"
    if ! command -v fftw-wisdom >/dev/null 2>&1 && ! brew list fftw >/dev/null 2>&1; then
        echo "  → brew install fftw (needed by mvtools)"
        brew install fftw 2>&1 | sed 's/^/    /'
    fi
    if [[ ! -d "$MVTOOLS_SRC/.git" ]]; then
        git clone --depth 1 https://github.com/dubhater/vapoursynth-mvtools "$MVTOOLS_SRC" \
            2>&1 | sed 's/^/    /'
    fi
    # Pick a Python with explicit absolute path — `python3` alone hits the
    # asdf/pyenv shim which aborts with "No version is set" under set -euo
    # pipefail. Same as PATCH_PY logic above; reused here for the meson patch
    # AND for venv creation later.
    MVTOOLS_PY=""
    for _c in /opt/homebrew/bin/python3.13 /opt/homebrew/bin/python3.14 /opt/homebrew/bin/python3.12 /usr/bin/python3; do
        if [[ -x "$_c" ]]; then MVTOOLS_PY="$_c"; break; fi
    done
    if [[ -z "$MVTOOLS_PY" ]]; then
        echo "  ✗ no Python found for mvtools build — skipping"
        continue 2>/dev/null || true
    fi

    # Patch the aarch64 PREFIX bug if it's still there
    if ! grep -q "aarch64_asm_args" "$MVTOOLS_SRC/meson.build"; then
        "$MVTOOLS_PY" - "$MVTOOLS_SRC/meson.build" <<'PYEOF'
import sys, re
p = sys.argv[1]
src = open(p).read()
old = """elif host_machine.cpu_family() == 'aarch64'
    add_project_arguments('-DMVTOOLS_ARM', language: ['c', 'cpp'])

    libs += static_library('aarch64',
        files('src/asm/aarch64-pixel-a.S'),
        gnu_symbol_visibility: 'hidden',
    )
endif"""
        new = """elif host_machine.cpu_family() == 'aarch64'
    add_project_arguments('-DMVTOOLS_ARM', language: ['c', 'cpp'])

    aarch64_asm_args = []
    if host_machine.system() == 'darwin'
        aarch64_asm_args += ['-DPREFIX']
    endif

    libs += static_library('aarch64',
        files('src/asm/aarch64-pixel-a.S'),
        c_args: aarch64_asm_args,
        gnu_symbol_visibility: 'hidden',
    )
endif"""
        if old in src:
            open(p, 'w').write(src.replace(old, new))
            print("    patched meson.build for aarch64 PREFIX")
        else:
            print("    WARN: meson.build aarch64 block changed upstream — patch skipped", file=sys.stderr)
PYEOF
    fi
    # Build against our VS R75 install. Reuse MVTOOLS_PY from above.
    VS_R75="$ROOT/vendor/vapoursynth/install-R75"
    if [[ ! -d "$MVTOOLS_SRC/.venv" ]]; then
        "$MVTOOLS_PY" -m venv "$MVTOOLS_SRC/.venv"
        "$MVTOOLS_SRC/.venv/bin/pip" install -q meson ninja
    fi
    (
        cd "$MVTOOLS_SRC"
        rm -rf build
        PYTHONPATH="$VS_R75/lib/python$("$MVTOOLS_PY" -c 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}")')/site-packages" \
        PKG_CONFIG_PATH="$VS_R75/lib/pkgconfig:/opt/homebrew/lib/pkgconfig" \
        PATH="$MVTOOLS_SRC/.venv/bin:$PATH" \
        "$MVTOOLS_SRC/.venv/bin/meson" setup build --buildtype=release 2>&1 | tail -3
        PATH="$MVTOOLS_SRC/.venv/bin:$PATH" \
        "$MVTOOLS_SRC/.venv/bin/meson" compile -C build 2>&1 | tail -3
    )
    if [[ -f "$MVTOOLS_SRC/build/mvtools.dylib" ]]; then
        ln -sf "$MVTOOLS_SRC/build/mvtools.dylib" "$VS_PLUGINS/libmvtools.dylib"
        echo "  → installed: libmvtools.dylib (linker-signed, $(du -h "$MVTOOLS_SRC/build/mvtools.dylib" | cut -f1))"
    else
        echo "  ✗ mvtools build failed — QTGMC won't work without it"
    fi
fi

echo ""
echo "✓ Setup complete. Restart Resolve so the OFX plugin re-loads with the new modules."
echo ""
echo "Installed:"
echo "  Python modules:  $VS_PY"
ls -1 "$VS_PY" 2>/dev/null | sed 's/^/    - /' || true
echo "  VS .dylib plugins: $VS_PLUGINS"
ls -1 "$VS_PLUGINS" 2>/dev/null | sed 's/^/    - /' || true
echo ""
echo "QTGMC needs at minimum: mvtools, fmtconv, nnedi3 (or znedi3). All three"
echo "ship in vendor/Macos_vapoursynth_plugins and should be linked above."
echo ""
echo "If a chain still fails, the popout's status banner will show the exact VS"
echo "error (e.g. 'core has no attribute mv' → mvtools failed to load). Use"
echo "'view composed script' to see what was actually evaluated."
