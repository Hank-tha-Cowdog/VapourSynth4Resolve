# Phase 1: lean test harness — plain executables that exit nonzero on failure.
# Catch2 lands when the test count grows.

add_executable(test_chain_compose unit/test_chain_compose.cpp)
target_link_libraries(test_chain_compose PRIVATE vsres_common)
# Cross-language QTGMC emission matrix: the SAME fixture file is consumed by
# the companion's node parity test (companion-app/electron/__test_qtgmc_parity.js),
# so native/draft drift or a formatting change on either side fails loudly.
target_compile_definitions(test_chain_compose PRIVATE
    VSRES_TEST_FIXTURE_DIR="${CMAKE_SOURCE_DIR}/tests/fixtures")
add_test(NAME chain_compose COMMAND test_chain_compose)

# Private-write / private-dir helper contracts (security review #7 remainder,
# 2026-11-11): mode migration, symlink + hardlink refusal, parent-chain
# verification. Real filesystem, synthetic self-owned trees only.
add_executable(test_private_io unit/test_private_io.cpp)
target_link_libraries(test_private_io PRIVATE vsres_common)
add_test(NAME private_io COMMAND test_private_io)

# Opt-in real session-file lifecycle qualification. No OFX host, VapourSynth,
# Python, companion launch or preview is exercised by this executable.
option(VSRES_BUILD_NATIVE_LIFECYCLE_TESTS "Build launch-free macOS session-file checks" OFF)
if(APPLE AND VSRES_BUILD_NATIVE_LIFECYCLE_TESTS)
    add_executable(test_companion_exchange
        unit/test_companion_exchange.cpp
        ${CMAKE_SOURCE_DIR}/platform/macos/host/popout_launcher.mm
        ${CMAKE_SOURCE_DIR}/common/logging/log.cpp
    )
    target_link_libraries(test_companion_exchange PRIVATE
        nlohmann_json::nlohmann_json
        "-framework Foundation"
        "-framework AppKit"
    )
    add_test(NAME companion_exchange COMMAND test_companion_exchange)
endif()

# Portable-bundle smoke (VSRES_PORTABLE_BUNDLE): dlopen the staged bundle's
# libvsscript with an isolated HOME TOML pointing at the embedded Python
# framework, evaluate a BlankClip script via the embedded vs-python package,
# and render one frame. Headless — no Resolve, no user config mutation.
if(APPLE AND VSRES_PORTABLE_BUNDLE)
    # platform/macos owns the bundle assembly; its OFX_BUNDLE_NAME doesn't
    # propagate into this scope, so mirror the staging layout here.
    set(PORTABLE_BUNDLE "${CMAKE_BINARY_DIR}/portable/VapourSynth.ofx.bundle")
    # VSRES_VS_PY_VER is "python3.14"; the framework versions dir is "3.14".
    string(REPLACE "python" "" PY_VER "${VSRES_VS_PY_VER}")
    set(PORTABLE_FRW "${PORTABLE_BUNDLE}/Contents/Frameworks/Python.framework/Versions/${PY_VER}")
    add_executable(portable_smoke unit/portable_smoke.cpp)
    target_include_directories(portable_smoke PRIVATE "${VSRES_VS_PREFIX_REAL}/include")
    # Same opt-in as the plugin target: expose getVSScriptAPILastError for
    # actionable init-failure diagnostics.
    target_compile_definitions(portable_smoke PRIVATE VSSCRIPT_USE_API_43)
    add_test(NAME portable_smoke
        COMMAND portable_smoke
            "${PORTABLE_BUNDLE}"
            "${PORTABLE_FRW}/bin/${VSRES_VS_PY_VER}"
            "${PORTABLE_FRW}/Python")
    add_dependencies(portable_smoke portable_bundle)
    # Self-containment evidence (gate 2): fail-closed audit + clean-env
    # (env -i) resolution of interpreter, stdlib deps, vapoursynth package,
    # and the full plugin set — from the staged bundle alone. Read-only.
    add_test(NAME bundle_selfcontained
        COMMAND /bin/bash "${CMAKE_SOURCE_DIR}/tests/test_bundle_selfcontained.sh")
    set_tests_properties(bundle_selfcontained PROPERTIES
        DEPENDS portable_smoke RUN_SERIAL TRUE)
endif()
