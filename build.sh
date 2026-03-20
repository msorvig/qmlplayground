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
DEPLOY_DIR="$SCRIPT_DIR/deploy"
BUILD_STATIC="$SCRIPT_DIR/build-wasm"
BUILD_SHARED="$SCRIPT_DIR/build-wasm-shared"

usage() {
    echo "Usage: $0 [static|shared|all|deploy] [--clean] [--opt] [--copy-qt]"
    echo "  static    - Build static (monolithic) variant"
    echo "  shared    - Build shared (dynamic linking) variant"
    echo "  all       - Build both variants (default)"
    echo "  deploy    - Build and deploy both variants"
    echo "  --clean   - Remove build directories before building"
    echo "  --opt     - Run wasm-opt on deployed wasm (slow)"
    echo "  --copy-qt - Copy Qt libs into deploy instead of symlinking"
    echo ""
    echo "Environment variables:"
    echo "  QT_STATIC_PREFIX  - path to static Qt install"
    echo "  QT_SHARED_PREFIX  - path to shared Qt install"
    exit 1
}

require_static() {
    if [ -z "$QT_STATIC_PREFIX" ]; then
        echo "Error: QT_STATIC_PREFIX not set" >&2
        exit 1
    fi
}

require_shared() {
    if [ -z "$QT_SHARED_PREFIX" ]; then
        echo "Error: QT_SHARED_PREFIX not set" >&2
        exit 1
    fi
}

configure_static() {
    require_static
    if [ ! -f "$BUILD_STATIC/build.ninja" ]; then
        echo "=== Configuring static build ==="
        "$QT_STATIC_PREFIX/bin/qt-cmake" -S "$SCRIPT_DIR" -B "$BUILD_STATIC" -GNinja
    fi
}

configure_shared() {
    require_shared
    if [ ! -f "$BUILD_SHARED/build.ninja" ]; then
        echo "=== Configuring shared build ==="
        "$QT_SHARED_PREFIX/bin/qt-cmake" -S "$SCRIPT_DIR" -B "$BUILD_SHARED" \
            -DQMLPLAYGROUND_SHARED=ON \
            -DQMLPLAYGROUND_QT_PREFIX="$QT_SHARED_PREFIX" \
            -GNinja
    fi
}

build_static() {
    configure_static
    echo "=== Building static ==="
    cmake --build "$BUILD_STATIC"
}

build_shared() {
    configure_shared
    echo "=== Building shared ==="
    cmake --build "$BUILD_SHARED"
}

deploy_static() {
    build_static
    echo "=== Deploying static ==="
    cmake --build "$BUILD_STATIC" --target deploy
    if $OPT; then
        echo "=== Optimizing static wasm ==="
        cmake --build "$BUILD_STATIC" --target deploy-opt
    fi
}

deploy_shared() {
    build_shared
    echo "=== Deploying shared ==="
    cmake --build "$BUILD_SHARED" --target deploy
    if $OPT; then
        echo "=== Optimizing shared wasm ==="
        cmake --build "$BUILD_SHARED" --target deploy-opt
    fi
    if $COPY_QT; then
        copy_qt
    fi
}

# Replace symlinks in deploy/shared/qt/ with actual copies
copy_qt() {
    require_shared
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
OPT=false
COPY_QT=false
for arg in "$@"; do
    case "$arg" in
        --clean)   CLEAN=true ;;
        --opt)     OPT=true ;;
        --copy-qt) COPY_QT=true ;;
    esac
done

if $CLEAN; then
    clean
fi

case "$TARGET" in
    static)  build_static ;;
    shared)  build_shared ;;
    all)     build_static; build_shared ;;
    deploy)  deploy_static; deploy_shared ;;
    --clean|--opt|--copy-qt) ;; # flag-only, already handled
    *)       usage ;;
esac
