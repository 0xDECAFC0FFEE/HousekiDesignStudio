#!/usr/bin/env bash
# Rebuilds src/web/vendor/opencv/opencv.js, the phone scanner's OpenCV (T-0323).
#
# WHAT IT IS
#   OpenCV 4.14.0 (Apache-2.0) compiled to WebAssembly with Emscripten 4.0.23, SIMD on, no
#   threads, the wasm embedded in the one .js file (SINGLE_FILE, so the phone page also works
#   opened from file://, where a separate .wasm cannot be fetched). Only the functions listed in
#   opencv_js.config.py (next to this script) get JavaScript bindings; see that file for what is
#   in and why. QR decoding needs quirc (ISC), which OpenCV's stock JS build switches off; it is
#   switched back on here. One small patch to OpenCV itself, in patches/: without it opencv.js
#   finds markers but no ChArUco corner on real phone frames (the patch explains why).
#
# THE REPOSITORY BUILD DOES NOT RUN THIS
#   opencv.js is committed. ./setup.sh && ./build.sh (and the GitHub Pages workflow) use the
#   committed file and need no Emscripten. Run this only to change OpenCV's version, the build
#   flags or the whitelist, then commit the new opencv.js together with the change.
#
# HOW TO RUN (from anywhere; needs git, make and /usr/bin/python3, and about 2.5 GB of disk under
# build/: emsdk 1.9 GB, OpenCV 0.3 GB, the build 0.13 GB, the cmake venv 0.13 GB)
#   src/web/vendor/opencv/build_opencv_js.sh
#   It clones emsdk and OpenCV at the pinned versions into build/opencv-js/ (gitignored, reused by
#   later runs), applies patches/, builds, and copies the result over
#   src/web/vendor/opencv/opencv.js, printing its size raw and gzipped. Measured on the M1 Pro
#   (2026-10-04): a clean build (OpenCV configure and compile) takes about 200 s after emsdk is
#   installed (~1 min download), a rebuild after a linker-flag or one-file patch change ~20 s; the
#   result is 6.42 MB, 1.83 MB gzipped (-9). Two builds of the same inputs on the same machine
#   are byte-identical.
#
# PINNED VERSIONS (change them here, nowhere else)
OPENCV_TAG=4.14.0
EMSDK_VERSION=4.0.23

CMAKE_VERSION=3.31.6   # from PyPI, into a private venv, so the build never uses a translated cmake

set -euo pipefail

# On Apple silicon, run natively. A shell opened under Rosetta passes its x86_64 preference to
# every child: emsdk then installs x86_64 tools, and the x86_64 `make` shim fails on `xcrun`
# ("unable to load libxcrun ... need 'x86_64'"), which CMake reports only as "Compiler doesn't
# support baseline optimization flags" (kb/toolchain-and-environment.md has the same trap for cargo).
if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ]; then
  exec arch -arm64 /bin/bash "$0" "$@"
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../../.." && pwd)"
WORK="$ROOT/build/opencv-js"
OPENCV_DIR="$WORK/opencv-$OPENCV_TAG"
EMSDK_DIR="$WORK/emsdk"
BUILD_DIR="$WORK/build-$OPENCV_TAG"
VENV="$WORK/venv"

mkdir -p "$WORK"

# A native Python with a pinned cmake, used for emsdk, build_js.py and the configure step.
if [ ! -x "$VENV/bin/cmake" ]; then
  /usr/bin/python3 -m venv "$VENV"
  "$VENV/bin/python3" -m pip install -q "cmake==$CMAKE_VERSION"
fi
export PATH="$VENV/bin:$PATH"
export EMSDK_PYTHON="$VENV/bin/python3"

if [ ! -d "$EMSDK_DIR" ]; then
  git clone https://github.com/emscripten-core/emsdk.git "$EMSDK_DIR"
fi
(cd "$EMSDK_DIR" && git fetch --tags -q && git checkout -q "$EMSDK_VERSION" \
  && ./emsdk install "$EMSDK_VERSION" && ./emsdk activate "$EMSDK_VERSION" >/dev/null)

if [ ! -d "$OPENCV_DIR" ]; then
  git clone --depth 1 --branch "$OPENCV_TAG" https://github.com/opencv/opencv.git "$OPENCV_DIR"
fi

# Our patches to OpenCV (patches/*.patch, applied in name order; each says why in its diff).
# Applied once: a patch that is already in the checkout is skipped, one that fails stops the build.
for patch in "$HERE"/patches/*.patch; do
  if git -C "$OPENCV_DIR" apply --reverse --check "$patch" 2>/dev/null; then
    echo "already applied: $(basename "$patch")"
  else
    git -C "$OPENCV_DIR" apply "$patch"
    echo "applied: $(basename "$patch")"
  fi
done

# shellcheck disable=SC1091
source "$EMSDK_DIR/emsdk_env.sh" >/dev/null 2>&1
export PATH="$VENV/bin:$PATH"   # emsdk_env.sh prepends its own dirs; keep the venv's cmake first

START=$(date +%s)

# build_js.py's own defaults (Release, static, no IPP/TBB/OpenCL/codecs ...) plus:
#   --build_wasm --simd            wasm with 128-bit SIMD (every phone browser of the last years has it)
#   (no --threads)                 pthreads need cross-origin isolation, which the page does not have
#   (no --disable_single_file)     the wasm is embedded as base64: one file, works from file://
#   -DWITH_QUIRC=ON                QR decoding (OpenCV's JS build turns it off by default)
#   -DCMAKE_CXX_STANDARD=17        Embind needs C++17 from Emscripten 4.0.20 (modules/js/CMakeLists.txt)
#   -DBUILD_opencv_{dnn,photo,video,ml}=OFF, tests and perf off: nothing of theirs is bound
#   -s ENVIRONMENT=web,worker      no Node.js code paths (smaller; Deno loads it as a web runtime)
#   -DOPENCV_TIMESTAMP=            no build time in cv.getBuildInformation(), so a rebuild of the
#                                  same inputs on the same machine gives the same bytes (measured:
#                                  two builds differed only in that timestamp)
#   EXPORTED_FUNCTIONS += _mallinfo (as a LINKER flag, which comes after build_js.py's own
#                                  EXPORTED_FUNCTIONS and so wins, without recompiling): the
#                                  allocator's in-use byte count, which the tests read to prove a
#                                  detector leaks no Mat over many frames
emcmake "$VENV/bin/python3" "$OPENCV_DIR/platforms/js/build_js.py" "$BUILD_DIR" \
  --build_wasm --simd \
  --config "$HERE/opencv_js.config.py" \
  --cmake_option="-DWITH_QUIRC=ON" \
  --cmake_option="-DCMAKE_CXX_STANDARD=17" \
  --cmake_option="-DBUILD_opencv_dnn=OFF" \
  --cmake_option="-DBUILD_opencv_photo=OFF" \
  --cmake_option="-DBUILD_opencv_video=OFF" \
  --cmake_option="-DBUILD_opencv_ml=OFF" \
  --cmake_option="-DBUILD_opencv_gapi=OFF" \
  --cmake_option="-DBUILD_TESTS=OFF" \
  --cmake_option="-DBUILD_PERF_TESTS=OFF" \
  --cmake_option="-DBUILD_EXAMPLES=OFF" \
  --cmake_option="-DCMAKE_EXE_LINKER_FLAGS=-sEXPORTED_FUNCTIONS=_malloc,_free,_mallinfo" \
  --cmake_option="-DOPENCV_TIMESTAMP=" \
  --build_flags="-s ENVIRONMENT=web,worker"

END=$(date +%s)

{
  printf '/* opencv.js: OpenCV %s (Apache-2.0, https://opencv.org) built with Emscripten %s,\n' "$OPENCV_TAG" "$EMSDK_VERSION"
  printf '   SIMD, single file, whitelist src/web/vendor/opencv/opencv_js.config.py; includes quirc (ISC)\n'
  printf '   and zlib (zlib licence). Generated by src/web/vendor/opencv/build_opencv_js.sh; do not edit. */\n'
  cat "$BUILD_DIR/bin/opencv.js"
} > "$HERE/opencv.js"

RAW=$(wc -c < "$HERE/opencv.js" | tr -d ' ')
GZ=$(gzip -9 -c "$HERE/opencv.js" | wc -c | tr -d ' ')
echo "built in $((END - START)) s: $HERE/opencv.js is $RAW bytes, $GZ gzipped (-9)"
