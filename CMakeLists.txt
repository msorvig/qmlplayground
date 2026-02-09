cmake_minimum_required(VERSION 3.16)
project(qmlplayground VERSION 0.1 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_AUTOMOC ON)

find_package(Qt6 REQUIRED COMPONENTS Core Gui Qml Quick QuickControls2 Quick3D Graphs)

qt_add_executable(qmlruntime_wasm
    src/main.cpp
    src/qmlruntime.cpp
    src/qmlruntime.h
)

# Add QML module to register imports for static linking
qt_add_qml_module(qmlruntime_wasm
    URI QmlPlayground
    VERSION 1.0
    QML_FILES src/imports.qml
    NO_RESOURCE_TARGET_PATH
)

target_link_libraries(qmlruntime_wasm PRIVATE
    Qt6::Core
    Qt6::Gui
    Qt6::Qml
    Qt6::Quick
    Qt6::QuickControls2
    Qt6::Quick3D
    Qt6::Graphs
)

# WebAssembly-specific settings
if(EMSCRIPTEN)
    target_link_options(qmlruntime_wasm PRIVATE
        -lembind
        -sALLOW_MEMORY_GROWTH=1
        -sFETCH=1
    )

    set(DEPLOY_DIR ${CMAKE_SOURCE_DIR}/deploy)

    # Deploy target
    add_custom_target(deploy
        DEPENDS qmlruntime_wasm
        COMMENT "Deploying to ${DEPLOY_DIR}/"

        # Create deploy directory
        COMMAND ${CMAKE_COMMAND} -E make_directory ${DEPLOY_DIR}

        # Copy build artifacts
        COMMAND ${CMAKE_COMMAND} -E copy
            ${CMAKE_BINARY_DIR}/qmlruntime_wasm.wasm
            ${CMAKE_BINARY_DIR}/qtloader.js
            ${DEPLOY_DIR}/

        # Copy source files
        COMMAND ${CMAKE_COMMAND} -E copy
            ${CMAKE_SOURCE_DIR}/src/index.html
            ${CMAKE_SOURCE_DIR}/src/qmlruntime.js
            ${CMAKE_SOURCE_DIR}/src/qmlplayground.js
            ${DEPLOY_DIR}/

        # Copy 3rdparty
        COMMAND ${CMAKE_COMMAND} -E copy
            ${CMAKE_SOURCE_DIR}/3rdparty/codemirror/codemirror.min.js
            ${CMAKE_SOURCE_DIR}/3rdparty/codemirror/codemirror.min.css
            ${CMAKE_SOURCE_DIR}/3rdparty/codemirror/gruvbox-dark.min.css
            ${DEPLOY_DIR}/

        # Copy examples
        COMMAND ${CMAKE_COMMAND} -E copy_directory
            ${CMAKE_SOURCE_DIR}/examples
            ${DEPLOY_DIR}/examples

        # Patch qmlruntime_wasm.js for ES modules (copy then append if needed)
        COMMAND ${CMAKE_COMMAND} -E copy
            ${CMAKE_BINARY_DIR}/qmlruntime_wasm.js
            ${DEPLOY_DIR}/qmlruntime_wasm.js
        COMMAND ${CMAKE_COMMAND}
            -DFILE=${DEPLOY_DIR}/qmlruntime_wasm.js
            -DSYMBOL=qmlruntime_wasm_entry
            -P ${CMAKE_SOURCE_DIR}/cmake/patch_esm.cmake

        # Patch qtloader.js for ES modules
        COMMAND ${CMAKE_COMMAND}
            -DFILE=${DEPLOY_DIR}/qtloader.js
            -DSYMBOL=qtLoad
            -P ${CMAKE_SOURCE_DIR}/cmake/patch_esm.cmake
    )
endif()
