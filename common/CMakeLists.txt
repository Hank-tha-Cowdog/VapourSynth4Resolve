add_library(vsres_common STATIC
    marshal/marshal.cpp
    color/color.cpp
    filters/filter_registry.cpp
    filters/filter_script.cpp
    filters/filter_qtgmc.cpp
    chain/composer.cpp
    config/config.cpp
    fs/private_io.cpp
    logging/log.cpp
)

target_include_directories(vsres_common
    PUBLIC
        ${CMAKE_CURRENT_SOURCE_DIR}
        ${VSRES_OFX_SDK}/include
        ${VSRES_OFX_SDK}/Support/include
)

target_link_libraries(vsres_common
    PUBLIC
        nlohmann_json::nlohmann_json
        PkgConfig::VAPOURSYNTH
        PkgConfig::VAPOURSYNTH_SCRIPT
)

set_target_properties(vsres_common PROPERTIES
    POSITION_INDEPENDENT_CODE ON
)
