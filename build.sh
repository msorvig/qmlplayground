#!/bin/bash
set -e

# Build script for QML Playground.
#
# Expects the following environment variables:
#   QT_STATIC_PREFIX  - path to static Qt install (e.g. /path/to/qt/wasm/qtbase)
#   QT_SHARED_PREFIX  - path to shared Qt install (e.g. /path/to/qt/wasm-shared/qtbase)
#
# Either or both can be set. Omit one to skip that variant.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEPLOY_DIR="$SCRIPT_DIR/dist"
BUILD_STATIC="$SCRIPT_DIR/build-wasm"
BUILD_SHARED="$SCRIPT_DIR/build-wasm-shared"

usage() {
    echo "Usage: $0 [static|shared|all|deploy] [--clean] [--debug] [--opt] [--copy-qt]"
    echo "  static    - Build static (monolithic) variant"
    echo "  shared    - Build shared (dynamic linking) variant"
    echo "  all       - Build both variants (default)"
    echo "  deploy    - Build and deploy both variants"
    echo "  --clean   - Remove build directories before building"
    echo "  --debug   - Debug build (dwarf debug info + source maps)"
    echo "  --opt     - Run wasm-opt on deployed wasm (slow)"
    echo "  --copy-qt - Copy Qt libs into deploy instead of symlinking"
    echo ""
    echo "Environment variables:"
    echo "  QT_STATIC_PREFIX  - path to static Qt install"
    echo "  QT_SHARED_PREFIX  - path to shared Qt install"
    exit 1
}

configure_static() {
    if [ -z "$QT_STATIC_PREFIX" ]; then
        echo "Skipping static (QT_STATIC_PREFIX not set)"
        return 1
    fi
    if [ ! -f "$BUILD_STATIC/build.ninja" ]; then
        echo "=== Configuring static ==="
        "$QT_STATIC_PREFIX/bin/qt-cmake" -S "$SCRIPT_DIR" -B "$BUILD_STATIC" \
            $CMAKE_EXTRA_ARGS -GNinja
    fi
}

configure_shared() {
    if [ -z "$QT_SHARED_PREFIX" ]; then
        echo "Skipping shared (QT_SHARED_PREFIX not set)"
        return 1
    fi
    if [ ! -f "$BUILD_SHARED/build.ninja" ]; then
        echo "=== Configuring shared ==="
        "$QT_SHARED_PREFIX/bin/qt-cmake" -S "$SCRIPT_DIR" -B "$BUILD_SHARED" \
            -DQMLPLAYGROUND_SHARED=ON \
            -DQMLPLAYGROUND_QT_PREFIX="$QT_SHARED_PREFIX" \
            $CMAKE_EXTRA_ARGS -GNinja
    fi
}

build_static() {
    configure_static || return
    echo "=== Building static ==="
    cmake --build "$BUILD_STATIC"
}

build_shared() {
    configure_shared || return
    echo "=== Building shared ==="
    cmake --build "$BUILD_SHARED"
}

deploy_static() {
    build_static || return
    echo "=== Deploying static ==="
    cmake --build "$BUILD_STATIC" --target deploy
    if $OPT; then
        cmake --build "$BUILD_STATIC" --target deploy-opt
    fi
}

deploy_shared() {
    build_shared || return
    echo "=== Deploying shared ==="
    cmake --build "$BUILD_SHARED" --target deploy
    if $OPT; then
        cmake --build "$BUILD_SHARED" --target deploy-opt
    fi
    if $COPY_QT; then
        copy_qt
    fi
}

copy_qt() {
    local qt_dir="$DEPLOY_DIR/shared/qt"
    echo "=== Copying Qt libs (replacing symlinks) ==="
    for dir in lib plugins qml; do
        if [ -L "$qt_dir/$dir" ]; then
            rm "$qt_dir/$dir"
            cp -R "$QT_SHARED_PREFIX/$dir" "$qt_dir/$dir"
        elif [ -d "$qt_dir/$dir" ]; then
            rm -rf "$qt_dir/$dir"
            cp -R "$QT_SHARED_PREFIX/$dir" "$qt_dir/$dir"
        fi
    done
}

clean() {
    echo "=== Cleaning build directories ==="
    rm -rf "$BUILD_STATIC" "$BUILD_SHARED"
}

# Parse args
TARGET="${1:-all}"
CLEAN=false
DEBUG=false
OPT=false
COPY_QT=false
for arg in "$@"; do
    case "$arg" in
        --clean)   CLEAN=true ;;
        --debug)   DEBUG=true ;;
        --opt)     OPT=true ;;
        --copy-qt) COPY_QT=true ;;
    esac
done

CMAKE_EXTRA_ARGS=""
if $DEBUG; then
    CMAKE_EXTRA_ARGS="-DCMAKE_BUILD_TYPE=Debug"
fi

if $CLEAN; then
    clean
fi

case "$TARGET" in
    static)  build_static ;;
    shared)  build_shared ;;
    all)     build_static; build_shared ;;
    deploy)  deploy_static; deploy_shared ;;
    --clean|--debug|--opt|--copy-qt) ;;
    *)       usage ;;
esac
