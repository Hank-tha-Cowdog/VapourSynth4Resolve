cmake_minimum_required(VERSION 3.24)
project(VapourSynthForResolve
    VERSION 2.0.0
    DESCRIPTION "VapourSynth OFX plugin for DaVinci Resolve — cross-platform"
    LANGUAGES C CXX
)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

option(VSRES_BUILD_TESTS "Build the test harness" ON)

set(VSRES_OFX_SDK "${CMAKE_SOURCE_DIR}/docs/ofx-sdk/openfx-1.5.1")
set(VSRES_COMMON "${CMAKE_SOURCE_DIR}/common")

include(FetchContent)
FetchContent_Declare(
    nlohmann_json
    GIT_REPOSITORY https://github.com/nlohmann/json.git
    GIT_TAG        v3.11.3
    GIT_SHALLOW    TRUE
)
set(JSON_BuildTests OFF CACHE INTERNAL "")
set(JSON_Install    OFF CACHE INTERNAL "")
FetchContent_MakeAvailable(nlohmann_json)

# VapourSynth — link against either a project-local build (preferred for shipping a known
# version) or whatever Homebrew has (fallback for dev convenience).
#
#   Project-local: scripts/build-vapoursynth.sh R75 builds R75 into
#                  vendor/vapoursynth/install-R75/ and symlinks `active` -> install-R75.
#                  Configure with -DVSRES_VS_PREFIX=$(pwd)/vendor/vapoursynth/active.
#   Homebrew:      leave VSRES_VS_PREFIX unset; pkg-config finds whatever brew has.
#
# Either way, VSAPI4 / VSScript4 are unchanged across R55+ so the source is portable.
set(VSRES_VS_PREFIX "" CACHE PATH "Project-local VapourSynth install prefix (overrides Homebrew)")

find_package(PkgConfig REQUIRED)
if(VSRES_VS_PREFIX)
    if(NOT EXISTS "${VSRES_VS_PREFIX}/lib/pkgconfig/vapoursynth.pc")
        message(FATAL_ERROR
            "VSRES_VS_PREFIX is set to ${VSRES_VS_PREFIX} but vapoursynth.pc is missing.\n"
            "Run scripts/build-vapoursynth.sh first.")
    endif()
    set(ENV{PKG_CONFIG_PATH} "${VSRES_VS_PREFIX}/lib/pkgconfig:$ENV{PKG_CONFIG_PATH}")
    message(STATUS "VapourSynth: using project-local prefix at ${VSRES_VS_PREFIX}")

    # Resolve the prefix through any symlinks (vendor/vapoursynth/active →
    # install-R75) so the baked-in path matches what dyld will see at runtime.
    get_filename_component(VSRES_VS_PREFIX_REAL "${VSRES_VS_PREFIX}" REALPATH)
    # Locate the Python site-packages our `vapoursynth` module lives in, so we
    # can set PYTHONPATH inside the OFX plugin before VSScript imports the
    # module. Without this, libvsscript loads libpython successfully but
    # PyImport_ImportModule("vapoursynth") fails because our private prefix
    # isn't on Python's default sys.path → "Failed to import the VapourSynth
    # Python module." in the chain-error banner.
    file(GLOB VSRES_VS_PY_VER_DIRS RELATIVE "${VSRES_VS_PREFIX_REAL}/lib"
        "${VSRES_VS_PREFIX_REAL}/lib/python*")
    list(LENGTH VSRES_VS_PY_VER_DIRS VSRES_VS_PY_VER_COUNT)
    if(VSRES_VS_PY_VER_COUNT GREATER 0)
        list(GET VSRES_VS_PY_VER_DIRS 0 VSRES_VS_PY_VER)
        set(VSRES_VS_SITE_PACKAGES "${VSRES_VS_PREFIX_REAL}/lib/${VSRES_VS_PY_VER}/site-packages")
        message(STATUS "VapourSynth site-packages: ${VSRES_VS_SITE_PACKAGES}")
    else()
        message(WARNING "VapourSynth: could not find lib/python*/site-packages under ${VSRES_VS_PREFIX_REAL}")
    endif()
endif()

pkg_check_modules(VAPOURSYNTH        REQUIRED IMPORTED_TARGET vapoursynth)
pkg_check_modules(VAPOURSYNTH_SCRIPT REQUIRED IMPORTED_TARGET vapoursynth-script)
message(STATUS "VapourSynth found: ${VAPOURSYNTH_VERSION} at ${VAPOURSYNTH_PREFIX}")

add_subdirectory(common)

if(APPLE)
    add_subdirectory(platform/macos)
elseif(WIN32)
    message(STATUS "Windows build via legacy MSVC project at platform/windows/msvc/")
endif()

if(VSRES_BUILD_TESTS)
    enable_testing()
    add_subdirectory(tests)
endif()
