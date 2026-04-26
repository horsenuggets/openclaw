#!/usr/bin/env bash
# Compile whisper.cpp server into standalone binaries.
#
# Usage:
#   scripts/compile-whisper.sh                         # native build (current platform)
#   scripts/compile-whisper.sh --target linux-x64      # single target via Docker
#   scripts/compile-whisper.sh --all                   # all supported targets
#   scripts/compile-whisper.sh --on-remote             # compile linux targets on MSI (fastest)
#
# Supported targets: linux-x64, linux-arm64, darwin-x64, darwin-arm64
# Windows not yet supported (needs MSVC).
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WHISPER_DIR="$PROJECT_ROOT/whisper"
DIST_DIR="$PROJECT_ROOT/dist"
mkdir -p "$DIST_DIR"

if [ ! -f "$WHISPER_DIR/CMakeLists.txt" ]; then
  echo "Error: whisper submodule not initialized. Run: git submodule update --init whisper"
  exit 1
fi

CMAKE_COMMON="-DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DGGML_OPENMP=OFF -DWHISPER_BUILD_TESTS=OFF"

compile_native() {
  local arch os
  arch="$(uname -m)"
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  [ "$arch" = "x86_64" ] && arch="x64"
  [ "$arch" = "aarch64" ] && arch="arm64"
  local name="${os}-${arch}"
  local outfile="$DIST_DIR/whisper-server-$name"

  echo "Compiling whisper-server for $name (native)..."
  cd "$WHISPER_DIR"
  rm -rf build
  cmake -B build $CMAKE_COMMON 2>&1 | tail -3
  cmake --build build --target whisper-server -j "$(nproc 2>/dev/null || sysctl -n hw.ncpu)" 2>&1 | tail -3
  cp build/bin/whisper-server "$outfile"
  chmod +x "$outfile"
  echo "  -> $outfile ($(du -h "$outfile" | cut -f1))"
}

compile_docker() {
  local name="$1"
  local platform="$2"
  local outfile="$DIST_DIR/whisper-server-$name"

  echo "Compiling whisper-server for $name (docker platform=$platform)..."
  docker run --rm --platform "$platform" \
    -v "$WHISPER_DIR:/src" -w /src \
    ubuntu:24.04 bash -c "
      apt-get update -qq && apt-get install -y -qq cmake g++ make >/dev/null 2>&1 &&
      rm -rf build &&
      cmake -B build $CMAKE_COMMON -DWHISPER_NO_METAL=1 2>&1 | tail -3 &&
      cmake --build build --target whisper-server -j\$(nproc) 2>&1 | tail -3
    "
  cp "$WHISPER_DIR/build/bin/whisper-server" "$outfile"
  chmod +x "$outfile"
  echo "  -> $outfile ($(du -h "$outfile" | cut -f1))"
}

compile_macos_cross() {
  local arch="$1"
  local name="darwin-$arch"
  local outfile="$DIST_DIR/whisper-server-$name"
  local cmake_arch
  [ "$arch" = "x64" ] && cmake_arch="x86_64" || cmake_arch="arm64"

  echo "Compiling whisper-server for $name (macOS cross-compile)..."
  cd "$WHISPER_DIR"
  rm -rf build
  cmake -B build $CMAKE_COMMON -DCMAKE_OSX_ARCHITECTURES="$cmake_arch" 2>&1 | tail -3
  cmake --build build --target whisper-server -j "$(sysctl -n hw.ncpu)" 2>&1 | tail -3
  cp build/bin/whisper-server "$outfile"
  chmod +x "$outfile"
  echo "  -> $outfile ($(du -h "$outfile" | cut -f1))"
}

compile_on_remote() {
  echo "Compiling linux targets on remote (msi-openclaw)..."
  cd "$PROJECT_ROOT"
  tar czf /tmp/whisper-src.tar.gz --exclude='.git' --exclude='build*' whisper/
  scp -C /tmp/whisper-src.tar.gz msi-openclaw:/tmp/whisper-src.tar.gz

  ssh msi-openclaw "
    cd /tmp && tar xzf whisper-src.tar.gz 2>/dev/null
    echo 'Compiling linux-x64...'
    docker run --rm -v /tmp/whisper:/src -w /src ubuntu:24.04 bash -c '
      apt-get update -qq && apt-get install -y -qq cmake g++ make >/dev/null 2>&1 &&
      rm -rf build && cmake -B build $CMAKE_COMMON -DWHISPER_NO_METAL=1 2>&1 | tail -3 &&
      cmake --build build --target whisper-server -j\$(nproc) 2>&1 | tail -3
    '
    cp /tmp/whisper/build/bin/whisper-server /tmp/whisper-server-linux-x64
    ls -lh /tmp/whisper-server-linux-x64
  "

  scp msi-openclaw:/tmp/whisper-server-linux-x64 "$DIST_DIR/whisper-server-linux-x64"
  echo "  -> dist/whisper-server-linux-x64"
}

case "${1:-}" in
  --target)
    case "${2:-}" in
      linux-x64)   compile_docker "linux-x64" "linux/amd64" ;;
      linux-arm64) compile_docker "linux-arm64" "linux/arm64" ;;
      darwin-x64)  compile_macos_cross "x64" ;;
      darwin-arm64) compile_macos_cross "arm64" ;;
      *) echo "Unknown target: ${2:-}. Supported: linux-x64, linux-arm64, darwin-x64, darwin-arm64"; exit 1 ;;
    esac
    ;;
  --all)
    compile_docker "linux-x64" "linux/amd64"
    compile_docker "linux-arm64" "linux/arm64"
    if [ "$(uname)" = "Darwin" ]; then
      compile_macos_cross "arm64"
      compile_macos_cross "x64"
    fi
    ;;
  --on-remote)
    compile_on_remote
    ;;
  *)
    compile_native
    ;;
esac

echo "Done."
