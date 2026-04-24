#!/usr/bin/env bash
# Compile whisper.cpp server into a standalone binary.
#
# Builds the whisper-server target from the whisper submodule.
# The output binary is placed in dist/ alongside the openclaw binary.
#
# Usage:
#   scripts/compile-whisper.sh                    # native build
#   scripts/compile-whisper.sh --target linux-x64 # cross-compile (requires toolchain)
#
# Prerequisites:
#   - CMake, C/C++ compiler
#   - For cross-compilation: appropriate cross-compile toolchain
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WHISPER_DIR="$PROJECT_ROOT/whisper"
BUILD_DIR="$WHISPER_DIR/build"
TARGET="${2:-native}"

if [ ! -f "$WHISPER_DIR/CMakeLists.txt" ]; then
  echo "Error: whisper submodule not initialized. Run: git submodule update --init whisper"
  exit 1
fi

echo "=== Compiling whisper-server ==="

# Parse --target flag
case "${1:-}" in
  --target)
    TARGET="$2"
    echo "Target: $TARGET"
    ;;
  *)
    echo "Target: native"
    ;;
esac

mkdir -p "$BUILD_DIR"

cmake -S "$WHISPER_DIR" -B "$BUILD_DIR" \
  -DCMAKE_BUILD_TYPE=Release \
  -DWHISPER_BUILD_TESTS=OFF \
  -DWHISPER_BUILD_EXAMPLES=ON \
  -DBUILD_SHARED_LIBS=OFF

cmake --build "$BUILD_DIR" --target whisper-server --config Release -j "$(nproc 2>/dev/null || sysctl -n hw.ncpu)"

# Copy binary to dist/
mkdir -p "$PROJECT_ROOT/dist"

if [ "$TARGET" = "native" ]; then
  ARCH="$(uname -m)"
  OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
  [ "$ARCH" = "x86_64" ] && ARCH="x64"
  [ "$ARCH" = "aarch64" ] && ARCH="arm64"
  OUT="$PROJECT_ROOT/dist/whisper-server-${OS}-${ARCH}"
else
  OUT="$PROJECT_ROOT/dist/whisper-server-${TARGET}"
fi

cp "$BUILD_DIR/bin/whisper-server" "$OUT"
chmod +x "$OUT"

echo ""
echo "Output: $OUT ($(du -h "$OUT" | cut -f1))"
