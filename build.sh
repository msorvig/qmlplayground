#!/bin/bash
set -e

# Build script for QML Playground.
#
# Expects the following environment variables (set any combination):
#   QT_STATIC_PREFIX      - path to static Qt install
#   QT_EXCEPTIONS_PREFIX  - path to static Qt install with wasm exceptions
#   QT_SHARED_PREFIX      - path to shared Qt install
#
# Omit a variable to skip that variant.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEPLOY_DIR="$SCRIPT_DIR/deploy"
BUILD_STATIC="$SCRIPT_DIR/build-wasm"
BUILD_EXCEPTIONS="$SCRIPT_DIR/build-wasm-exceptions"
BUILD_SHARED="$SCRIPT_DIR/build-wasm-shared"

usage() {
    echo "Usage: $0 [static|exceptions|shared|all|deploy] [--clean] [--opt] [--copy-qt]"
    echo "  static      - Build static (monolithic) variant"
    echo "  exceptions  - Build static with wasm exceptions"
    echo "  shared      - Build shared (dynamic linking) variant"
    echo "  all         - Build all variants (default)"
    echo "  deploy      - Build and deploy all variants"
    echo "  --clean     - Remove build directories before building"
    echo "  --opt       - Run wasm-opt on deployed wasm (slow)"
    echo "  --copy-qt   - Copy Qt libs into deploy instead of symlinking"
    echo ""
    echo "Environment variables:"
    echo "  QT_STATIC_PREFIX      - path to static Qt install"
    echo "  QT_EXCEPTIONS_PREFIX  - path to static Qt install with wasm exceptions"
    echo "  QT_SHARED_PREFIX      - path to shared Qt install"
    exit 1
}

# Configure and build a static variant
# Usage: build_static_variant <qt_prefix> <build_dir> <deploy_subdir> <label>
build_static_variant() {
    local qt_prefix="$1" build_dir="$2" deploy_subdir="$3" label="$4"
    if [ -z "$qt_prefix" ]; then
        echo "Skipping $label (prefix not set)"
        return
    fi
    if [ ! -f "$build_dir/build.ninja" ]; then
        echo "=== Configuring $label ==="
        "$qt_prefix/bin/qt-cmake" -S "$SCRIPT_DIR" -B "$build_dir" \
            -DQMLPLAYGROUND_DEPLOY_SUBDIR="$deploy_subdir" \
            -GNinja
    fi
    echo "=== Building $label ==="
    cmake --build "$build_dir"
}

deploy_static_variant() {
    local qt_prefix="$1" build_dir="$2" deploy_subdir="$3" label="$4"
    if [ -z "$qt_prefix" ]; then return; fi
    build_static_variant "$qt_prefix" "$build_dir" "$deploy_subdir" "$label"
    echo "=== Deploying $label ==="
    cmake --build "$build_dir" --target deploy
    if $OPT; then
        echo "=== Optimizing $label wasm ==="
        cmake --build "$build_dir" --target deploy-opt
    fi
}

build_static()     { build_static_variant "$QT_STATIC_PREFIX" "$BUILD_STATIC" "static" "static"; }
build_exceptions() { build_static_variant "$QT_EXCEPTIONS_PREFIX" "$BUILD_EXCEPTIONS" "exceptions" "exceptions"; }

deploy_static()     { deploy_static_variant "$QT_STATIC_PREFIX" "$BUILD_STATIC" "static" "static"; }
deploy_exceptions() { deploy_static_variant "$QT_EXCEPTIONS_PREFIX" "$BUILD_EXCEPTIONS" "exceptions" "exceptions"; }

build_shared() {
    if [ -z "$QT_SHARED_PREFIX" ]; then
        echo "Skipping shared (QT_SHARED_PREFIX not set)"
        return
    fi
    if [ ! -f "$BUILD_SHARED/build.ninja" ]; then
        echo "=== Configuring shared ==="
        "$QT_SHARED_PREFIX/bin/qt-cmake" -S "$SCRIPT_DIR" -B "$BUILD_SHARED" \
            -DQMLPLAYGROUND_SHARED=ON \
            -DQMLPLAYGROUND_QT_PREFIX="$QT_SHARED_PREFIX" \
            -GNinja
    fi
    echo "=== Building shared ==="
    cmake --build "$BUILD_SHARED"
}

deploy_shared() {
    if [ -z "$QT_SHARED_PREFIX" ]; then return; fi
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
    rm -rf "$BUILD_STATIC" "$BUILD_EXCEPTIONS" "$BUILD_SHARED"
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
    static)     build_static ;;
    exceptions) build_exceptions ;;
    shared)     build_shared ;;
    all)        build_static; build_exceptions; build_shared ;;
    deploy)     deploy_static; deploy_exceptions; deploy_shared ;;
    --clean|--opt|--copy-qt) ;;
    *)          usage ;;
esac
