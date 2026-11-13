# macOS Apple Silicon OFX bundle build.
#
# Outputs `VapourSynth.ofx.bundle/Contents/MacOS/VapourSynth.ofx`. Universal binary
# (arm64 primary, x86_64 optional via -DCMAKE_OSX_ARCHITECTURES=arm64;x86_64).

if(NOT CMAKE_OSX_ARCHITECTURES)
    set(CMAKE_OSX_ARCHITECTURES "arm64" CACHE STRING "OFX target architectures" FORCE)
endif()

if(NOT CMAKE_OSX_DEPLOYMENT_TARGET)
    set(CMAKE_OSX_DEPLOYMENT_TARGET "26.0" CACHE STRING "Default OFX deployment target; release baseline macOS 26.0" FORCE)
endif()

set(OFX_BUNDLE_NAME "VapourSynth")

# OFX Support library — Blackmagic-style C++ wrapper that the existing Windows plugin uses.
file(GLOB OFX_SUPPORT_SRC
    ${VSRES_OFX_SDK}/Support/Library/*.cpp
)

add_library(ofx_support STATIC ${OFX_SUPPORT_SRC})
target_include_directories(ofx_support PUBLIC
    ${VSRES_OFX_SDK}/include
    ${VSRES_OFX_SDK}/Support/include
    ${VSRES_OFX_SDK}/Support/Plugins/include
)
target_compile_definitions(ofx_support PUBLIC
    OFX_EXTENSIONS_VEGAS
    OFX_EXTENSIONS_NUKE
    OFX_EXTENSIONS_TUTTLE
)

# Our OFX plugin binary.
add_library(vapoursynth_ofx MODULE
    host/plugin_entry.cpp
    host/popout_launcher.mm
    host/render_overlay.mm
    host/vs_runtime.cpp
    host/frame_io.mm
    host/preview_service.mm
)

set_target_properties(vapoursynth_ofx PROPERTIES
    OUTPUT_NAME "${OFX_BUNDLE_NAME}"
    SUFFIX ".ofx"
    PREFIX ""
)

target_link_libraries(vapoursynth_ofx
    PRIVATE
        vsres_common
        ofx_support
)

# Opt into VSScript API 4.3 so we can call getVSScriptAPILastError(). The default
# VSSCRIPT_API_MINOR (1) hides this entry point, leaving us to log a generic
# "Failed to acquire VSScript API" with no clue about whether Python failed to
# load, the TOML config was missing, or something else inside VS R75 broke.
target_compile_definitions(vapoursynth_ofx PRIVATE
    VSSCRIPT_USE_API_43
)

# Bake the site-packages path so plugin_entry.cpp's ensure_vs_python_path() can
# setenv("PYTHONPATH", ...) before VSScript imports `vapoursynth`. Required
# because our `vapoursynth` package lives in the vendor prefix, NOT in any
# default Python search location.
if(VSRES_VS_SITE_PACKAGES)
    target_compile_definitions(vapoursynth_ofx PRIVATE
        VSRES_VS_SITE_PACKAGES="${VSRES_VS_SITE_PACKAGES}"
    )
endif()

# Frameworks: Metal for OFX 1.5 Metal render suite, IOSurface + Foundation + AppKit
# for popout spawn + frame share with the companion app.
target_link_libraries(vapoursynth_ofx PRIVATE
    "-framework Metal"
    "-framework MetalPerformanceShaders"
    "-framework Accelerate"
    "-framework CoreVideo"
    "-framework CoreGraphics"
    "-framework ImageIO"
    "-framework UniformTypeIdentifiers"
    "-framework IOSurface"
    "-framework Foundation"
    "-framework AppKit"
)

# Bundle layout — OFX expects .ofx.bundle/Contents/MacOS/<name>.ofx
set(BUNDLE_DIR "${CMAKE_BINARY_DIR}/${OFX_BUNDLE_NAME}.ofx.bundle")
set(BUNDLE_MACOS "${BUNDLE_DIR}/Contents/MacOS")
set(BUNDLE_RESOURCES "${BUNDLE_DIR}/Contents/Resources")

add_custom_command(TARGET vapoursynth_ofx POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E make_directory ${BUNDLE_MACOS}
    COMMAND ${CMAKE_COMMAND} -E make_directory ${BUNDLE_RESOURCES}
    COMMAND ${CMAKE_COMMAND} -E copy
        $<TARGET_FILE:vapoursynth_ofx>
        ${BUNDLE_MACOS}/${OFX_BUNDLE_NAME}.ofx
    COMMAND ${CMAKE_COMMAND} -E copy
        ${CMAKE_CURRENT_SOURCE_DIR}/host/Info.plist
        ${BUNDLE_DIR}/Contents/Info.plist
    COMMENT "Assembling ${OFX_BUNDLE_NAME}.ofx.bundle"
)

# ---------------------------------------------------------------------------
# Portable bundle staging (VSRES_PORTABLE_BUNDLE=ON).
#
# The dev bundle links absolute paths into the vendor prefix and loads the
# Python `vapoursynth` package from the compile-time site-packages path — it
# only runs on this machine. The portable staging closes every load path
# inside the bundle:
#
#   Contents/Libraries/libvsscript.dylib        (VS script engine, active prefix)
#   Contents/Libraries/libvapoursynth.4.dylib   (VS core, active prefix)
#   (+ libvapoursynthfilters.dylib when the prefix has it — R82+ splits the
#    standard filters out of the core as a library the core dlopens from its
#    own directory; handled conditionally in repair_portable_bundle.sh because
#    R79 and older cores do not ship it. Shipping core choice: R79 — R80+
#    removed API-3 plugin support and 36/61 curated plugins are still API 3.)
#   Contents/Resources/vs-python/vapoursynth/    (Python package incl. .abi3.so)
#   Contents/Resources/vs-python/<helpers>       (havsfunc/mvsfunc/etc, when found)
#   Contents/Frameworks/Python.framework         (embedded CPython)
#
# Load-path fixups:
#   - the .ofx binary's two VS dylib references → @loader_path/../Libraries
#   - the bundled .abi3.so's libvapoursynth reference → @loader_path/../../../Libraries
#   - libvapoursynth's install id → @loader_path (self-relative)
#
# Python resolution: VSScript R75 finds CPython via
# ~/.config/vapoursynth/vapoursynth.toml keyed by the loaded libvsscript's
# own absolute path (vsscript.cpp getLibraryPath → readEnvConfig), loading
# the framework with RTLD_GLOBAL. A portable install therefore STILL needs
# a TOML entry pointing the bundled libvsscript at the bundled framework —
# see portable_smoke (tests) and docs/packaging.md. This staging builds the
# payload; it does not write user config or claim clean-Mac qualification.
# ---------------------------------------------------------------------------
option(VSRES_PORTABLE_BUNDLE "Stage a self-contained OFX bundle (build/portable)" OFF)
set(VSRES_PYTHON_FRAMEWORK "/opt/homebrew/opt/python@3.14/Frameworks/Python.framework"
    CACHE PATH "CPython framework embedded by VSRES_PORTABLE_BUNDLE")
set(VSRES_VS_HELPERS "$ENV{HOME}/Library/Application Support/VapourSynth-OFX/vs-python"
    CACHE PATH "VapourSynth helper scripts (havsfunc etc.) embedded when present")

if(VSRES_PORTABLE_BUNDLE)
    if(NOT VSRES_VS_PREFIX_REAL)
        message(FATAL_ERROR "VSRES_PORTABLE_BUNDLE requires a project-local VSRES_VS_PREFIX")
    endif()
    set(PORTABLE_DIR "${CMAKE_BINARY_DIR}/portable/${OFX_BUNDLE_NAME}.ofx.bundle")
    set(PORTABLE_LIBS "${PORTABLE_DIR}/Contents/Libraries")
    set(PORTABLE_RES "${PORTABLE_DIR}/Contents/Resources")
    set(PORTABLE_FRW "${PORTABLE_DIR}/Contents/Frameworks")

    # Numeric python version (VSRES_VS_PY_VER is e.g. "python3.14"; the
    # framework's Versions dir uses "3.14").
    string(REPLACE "python" "" VSRES_PY_NUM "${VSRES_VS_PY_VER}")
    set(PORTABLE_SITE
        "${PORTABLE_FRW}/Python.framework/Versions/${VSRES_PY_NUM}/lib/${VSRES_VS_PY_VER}/site-packages")
    # .pth source content (configure time; copied into the staged bundle).
    file(WRITE "${CMAKE_BINARY_DIR}/vsres-vapoursynth.pth"
        "../../../../../../../Resources/vs-python\n")
    set(VS_SP "${VSRES_VS_PREFIX_REAL}/lib/${VSRES_VS_PY_VER}/site-packages/vapoursynth")
    add_custom_target(portable_bundle
        COMMAND ${CMAKE_COMMAND} -E remove_directory ${PORTABLE_DIR}
        COMMAND ${CMAKE_COMMAND} -E copy_directory ${BUNDLE_DIR} ${PORTABLE_DIR}
        COMMAND ${CMAKE_COMMAND} -E make_directory ${PORTABLE_LIBS}
        COMMAND ${CMAKE_COMMAND} -E copy ${VS_SP}/libvsscript.dylib ${PORTABLE_LIBS}/libvsscript.dylib
        COMMAND ${CMAKE_COMMAND} -E copy ${VS_SP}/libvapoursynth.4.dylib ${PORTABLE_LIBS}/libvapoursynth.4.dylib
        COMMAND ${CMAKE_COMMAND} -E make_directory ${PORTABLE_RES}/vs-python
        COMMAND ${CMAKE_COMMAND} -E copy_directory ${VS_SP} ${PORTABLE_RES}/vs-python/vapoursynth
        # Helper scripts: staged from the IN-REPO license-cleared set
        # (vendor/vs-helpers) — havsfunc.py @ pinned Unlicense revision,
        # vsres_conv.py = our MIT replacement for mvsfunc, adjust.py = WTFPL.
        # mvsfunc / nnedi3_resample are deliberately NOT staged
        # (rights-map Conflict 6 resolution, 2026-11-13).
        COMMAND ${CMAKE_COMMAND} -E copy
            "${CMAKE_SOURCE_DIR}/vendor/vs-helpers/havsfunc.py"
            ${PORTABLE_RES}/vs-python/havsfunc.py
        COMMAND ${CMAKE_COMMAND} -E copy
            "${CMAKE_SOURCE_DIR}/platform/macos/vs-helpers/vsres_conv.py"
            ${PORTABLE_RES}/vs-python/vsres_conv.py
        COMMAND ${CMAKE_COMMAND} -E copy
            "${CMAKE_SOURCE_DIR}/vendor/vs-helpers/adjust.py"
            ${PORTABLE_RES}/vs-python/adjust.py
        # vsutil (MIT) — the licensed upstream havsfunc imports it.
        COMMAND ${CMAKE_COMMAND} -E copy_directory
            "${CMAKE_SOURCE_DIR}/vendor/vs-helpers/vsutil"
            ${PORTABLE_RES}/vs-python/vsutil
        COMMAND ${CMAKE_COMMAND} -E make_directory ${PORTABLE_FRW}
        COMMAND ${CMAKE_COMMAND} -E copy_directory
            "${VSRES_PYTHON_FRAMEWORK}" ${PORTABLE_FRW}/Python.framework
        # Portable-bundle python auto-import (see vs_runtime.cpp
        # ensure_vsscript_python_config): a .pth in the bundle python's own
        # site-packages adds Resources/vs-python to sys.path at interpreter
        # init, so VSScript's `import vapoursynth` succeeds on ANY machine.
        # Source content written at CONFIGURE time (no shell-quoting
        # hazards — a /bin/sh -c printf rule was split by make and failed).
        COMMAND ${CMAKE_COMMAND} -E make_directory "${PORTABLE_SITE}"
        COMMAND ${CMAKE_COMMAND} -E copy_if_different
            "${CMAKE_BINARY_DIR}/vsres-vapoursynth.pth"
            "${PORTABLE_SITE}/vsres-vapoursynth.pth"
        # Load-path fixups (@loader_path-relative; codesign-friendly).
        COMMAND install_name_tool -change
            "${VS_SP}/libvsscript.dylib"
            "@loader_path/../Libraries/libvsscript.dylib"
            ${PORTABLE_DIR}/Contents/MacOS/${OFX_BUNDLE_NAME}.ofx
        COMMAND install_name_tool -change
            "${VS_SP}/libvapoursynth.4.dylib"
            "@loader_path/../Libraries/libvapoursynth.4.dylib"
            ${PORTABLE_DIR}/Contents/MacOS/${OFX_BUNDLE_NAME}.ofx
        COMMAND install_name_tool -change
            "${VS_SP}/libvapoursynth.4.dylib"
            "@loader_path/../../../Libraries/libvapoursynth.4.dylib"
            ${PORTABLE_RES}/vs-python/vapoursynth/vapoursynth.abi3.so
        COMMAND install_name_tool -id @loader_path/libvapoursynth.4.dylib
            ${PORTABLE_LIBS}/libvapoursynth.4.dylib
        # Same identity fixup for libvsscript: the copy carries the DEV-TREE
        # path in its LC_ID_DYLIB (install-name identity). Dependents resolve
        # via @loader_path so it does not affect loading, but the shipped
        # binary should not leak the developer's filesystem layout.
        COMMAND install_name_tool -id @loader_path/libvsscript.dylib
            ${PORTABLE_LIBS}/libvsscript.dylib

        # (runs last: after all install_name_tool fixups above)
        # SELF-CONTAINMENT PASS (2026-10-31): stage the curated filter-plugin
        # set into Contents/Plugins, repair every Homebrew/dev-tree load
        # path bundle-internally (plugins + python stdlib deps + framework
        # identity + duplicate-dylib fixups), and AUDIT the result — the
        # repair script fails the staging if any external reference remains.
        # See platform/macos/repair_portable_bundle.sh.
        COMMAND /bin/bash ${CMAKE_CURRENT_LIST_DIR}/repair_portable_bundle.sh
            ${PORTABLE_DIR}/Contents
            ${CMAKE_CURRENT_LIST_DIR}/portable_plugins.txt
            ${CMAKE_SOURCE_DIR}/vendor/Macos_vapoursynth_plugins/lib
            ${VS_SP}
        DEPENDS vapoursynth_ofx
        COMMENT "Staging portable ${OFX_BUNDLE_NAME}.ofx.bundle at ${PORTABLE_DIR}"
    )
endif()
