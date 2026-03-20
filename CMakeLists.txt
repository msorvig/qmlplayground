cmake_minimum_required(VERSION 3.16)
project(qmlplayground VERSION 0.1 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_AUTOMOC ON)

option(QMLPLAYGROUND_SHARED "Build with shared/dynamic Qt libraries" OFF)

find_package(Qt6 REQUIRED COMPONENTS Core Gui Qml Quick QuickControls2 Quick3D Graphs)

qt_add_executable(qmlruntime_wasm
    src/main.cpp
    src/qmlruntime.cpp
    src/qmlruntime.h
)

if(NOT QMLPLAYGROUND_SHARED)
    # Register imports for static plugin linking
    qt_add_qml_module(qmlruntime_wasm
        URI QmlPlayground
        VERSION 1.0
        QML_FILES src/imports.qml
        NO_RESOURCE_TARGET_PATH
    )
endif()

target_link_libraries(qmlruntime_wasm PRIVATE
    Qt6::Core
    Qt6::Gui
    Qt6::Qml
    Qt6::Quick
)

if(NOT QMLPLAYGROUND_SHARED)
    target_link_libraries(qmlruntime_wasm PRIVATE
        Qt6::QuickControls2
        Qt6::Quick3D
        Qt6::Graphs
    )
endif()

set_target_properties(qmlruntime_wasm PROPERTIES QT_WASM_EXTRA_EXPORTED_METHODS "ENV")

# WebAssembly-specific settings
if(EMSCRIPTEN)
    if(QMLPLAYGROUND_SHARED)
        set(_default_subdir "shared")
    else()
        set(_default_subdir "static")
    endif()
    set(QMLPLAYGROUND_DEPLOY_SUBDIR "${_default_subdir}" CACHE STRING "Deploy subdirectory name")
    set(DEPLOY_DIR ${CMAKE_SOURCE_DIR}/deploy/${QMLPLAYGROUND_DEPLOY_SUBDIR})

    # Deploy target
    add_custom_target(deploy
        DEPENDS qmlruntime_wasm
        COMMENT "Deploying to ${DEPLOY_DIR}/"

        # Create deploy directory
        COMMAND ${CMAKE_COMMAND} -E make_directory ${DEPLOY_DIR}

        # Copy build artifacts
        COMMAND ${CMAKE_COMMAND} -E copy
            ${CMAKE_BINARY_DIR}/qtloader.js
            ${DEPLOY_DIR}/

        # Copy wasm
        COMMAND ${CMAKE_COMMAND} -E copy
            ${CMAKE_BINARY_DIR}/qmlruntime_wasm.wasm
            ${DEPLOY_DIR}/qmlruntime_wasm.wasm

        # Patch qmlruntime_wasm.js for ES modules
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

    if(QMLPLAYGROUND_SHARED)
        if(NOT QMLPLAYGROUND_QT_PREFIX)
            message(FATAL_ERROR "QMLPLAYGROUND_QT_PREFIX must be set for shared builds")
        endif()

        configure_file(${CMAKE_SOURCE_DIR}/src/qt.conf ${CMAKE_BINARY_DIR}/qt.conf COPYONLY)
        configure_file(${CMAKE_SOURCE_DIR}/src/qt_plugins.json ${CMAKE_BINARY_DIR}/qt_plugins.json COPYONLY)

        add_custom_command(TARGET deploy POST_BUILD
            COMMENT "Setting up shared Qt libraries"
            COMMAND ${CMAKE_COMMAND} -E make_directory ${DEPLOY_DIR}/qt
            COMMAND ${CMAKE_COMMAND} -E create_symlink ${QMLPLAYGROUND_QT_PREFIX}/lib ${DEPLOY_DIR}/qt/lib
            COMMAND ${CMAKE_COMMAND} -E create_symlink ${QMLPLAYGROUND_QT_PREFIX}/plugins ${DEPLOY_DIR}/qt/plugins
            COMMAND ${CMAKE_COMMAND} -E create_symlink ${QMLPLAYGROUND_QT_PREFIX}/qml ${DEPLOY_DIR}/qt/qml
            COMMAND ${CMAKE_COMMAND} -E copy
                ${CMAKE_SOURCE_DIR}/src/qt.conf
                ${CMAKE_SOURCE_DIR}/src/qt_plugins.json
                ${DEPLOY_DIR}/
        )
    endif()

    set(FRONTEND_DIR ${CMAKE_SOURCE_DIR}/deploy)

    if(NOT QMLPLAYGROUND_SHARED)
        # Static build deploys the web frontend to deploy/ (root)
        add_custom_command(TARGET deploy POST_BUILD
            COMMENT "Deploying web frontend"

            COMMAND ${CMAKE_COMMAND} -E copy
                ${CMAKE_SOURCE_DIR}/src/index.html
                ${CMAKE_SOURCE_DIR}/src/qmlruntime.js
                ${CMAKE_SOURCE_DIR}/src/qmlplayground.js
                ${FRONTEND_DIR}/

            COMMAND ${CMAKE_COMMAND} -E copy
                ${CMAKE_SOURCE_DIR}/3rdparty/codemirror/codemirror.min.js
                ${CMAKE_SOURCE_DIR}/3rdparty/codemirror/codemirror.min.css
                ${CMAKE_SOURCE_DIR}/3rdparty/codemirror/gruvbox-dark.min.css
                ${FRONTEND_DIR}/

            COMMAND ${CMAKE_COMMAND} -E copy_directory
                ${CMAKE_SOURCE_DIR}/examples
                ${FRONTEND_DIR}/examples
        )
    endif()

    # Optimized deploy: run wasm-opt on the deployed wasm
    add_custom_target(deploy-opt
        DEPENDS deploy
        COMMENT "Optimizing ${DEPLOY_DIR}/qmlruntime_wasm.wasm"
        COMMAND wasm-opt -Oz ${DEPLOY_DIR}/qmlruntime_wasm.wasm -o ${DEPLOY_DIR}/qmlruntime_wasm.wasm
    )
endif()
