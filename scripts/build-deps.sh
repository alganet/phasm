#!/usr/bin/env bash

# SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>
#
# SPDX-License-Identifier: ISC

set -euo pipefail

# Cross-build libzip for Emscripten and install into build sysroot
# Usage: source env.sh first to get BUILD_DIR etc

source "$(dirname "$0")/env.sh"

# If EMSDK env helper is set, source it so emcmake/emmake are on PATH
if [[ -n "${EMSDK_ENV:-}" && -f "${EMSDK_ENV}" ]]; then
	# shellcheck disable=SC1090
	source "${EMSDK_ENV}"
fi

# Defaults
SRC_DIR="${SOURCES_DIR}"
SYSROOT_DIR="${BUILD_DIR}/sysroot"
LIBZIP_TAR="libzip-${LIBZIP_VERSION}.tar.xz"
LIBZIP_URL="https://libzip.org/download/${LIBZIP_TAR}"

mkdir -p "${SRC_DIR}" "${SYSROOT_DIR}"
pushd "${SRC_DIR}" >/dev/null

if [[ ! -f "${LIBZIP_TAR}" ]]; then
    echo "Downloading libzip ${LIBZIP_VERSION} into ${SRC_DIR}..."
    if ! command -v wget >/dev/null 2>&1; then
        echo "wget not found. Install wget or change this script to use curl." >&2
        exit 1
    fi
    wget "${LIBZIP_URL}"
fi

if [[ ! -d "libzip-${LIBZIP_VERSION}" ]]; then
    echo "Extracting libzip into ${SRC_DIR}..."
    tar -xf "${LIBZIP_TAR}"
fi

# Ensure zlib (WASM) is available in sysroot since libzip requires it
ZLIB_VERSION="1.2.11"
ZLIB_TAR="zlib-${ZLIB_VERSION}.tar.gz"
ZLIB_URL="https://zlib.net/fossils/${ZLIB_TAR}"
if [[ ! -f "${SRC_DIR}/${ZLIB_TAR}" ]] || [[ ! -s "${SRC_DIR}/${ZLIB_TAR}" ]]; then
    echo "Downloading zlib ${ZLIB_VERSION} into ${SRC_DIR}..."
    wget -O "${SRC_DIR}/${ZLIB_TAR}" "${ZLIB_URL}" || true
    # If file is empty/invalid, try GitHub tag tarball
    if [[ ! -s "${SRC_DIR}/${ZLIB_TAR}" ]]; then
        echo "Primary zlib URL failed; trying GitHub release tarball..."
        GITHUB_URL="https://github.com/madler/zlib/archive/refs/tags/v${ZLIB_VERSION}.tar.gz"
        wget -O "${SRC_DIR}/${ZLIB_TAR}" "${GITHUB_URL}"
        # GitHub tarball may have a different top-level dir name when extracted
    fi
fi
if [[ ! -d "${SRC_DIR}/zlib-${ZLIB_VERSION}" ]]; then
    echo "Extracting zlib into ${SRC_DIR}..."
    tar -xf "${SRC_DIR}/${ZLIB_TAR}" -C "${SRC_DIR}"
fi
if [[ ! -f "${SYSROOT_DIR}/lib/libz.a" ]]; then
    echo "Building zlib for WASM..."
    pushd "${SRC_DIR}/zlib-${ZLIB_VERSION}" >/dev/null
    emconfigure ./configure --prefix="${SYSROOT_DIR}"
    # Build; some example/shared link steps may fail under emscripten, so continue
    emmake make -j"$(nproc)" || true

    # Manual install of static lib and headers if `make install` fails
    mkdir -p "${SYSROOT_DIR}/lib" "${SYSROOT_DIR}/include"
    if [[ -f libz.a ]]; then
        cp libz.a "${SYSROOT_DIR}/lib/"
    fi
    if [[ -f zlib.h ]]; then
        cp zlib.h "${SYSROOT_DIR}/include/"
    fi
    if [[ -f zconf.h ]]; then
        cp zconf.h "${SYSROOT_DIR}/include/"
    fi

    # Try 'make install' if it works
    emmake make install || true

    popd >/dev/null
fi

pushd "libzip-${LIBZIP_VERSION}" >/dev/null
mkdir -p build
pushd build >/dev/null

# Use emcmake/emmake (provided by EMSDK) to configure and build
if ! command -v emcmake >/dev/null 2>&1; then
    echo "emcmake not found. Ensure EMSDK_ENV is set and emsdk is activated." >&2
    exit 1
fi

# emcmake wraps cmake; ensure cmake is installed on the host
if ! command -v cmake >/dev/null 2>&1; then
    echo "cmake not found. Install it (e.g. sudo apt-get install cmake) and re-run." >&2
    exit 1
fi

# Configure: disable shared libs (static only) and disable optional compressors
emcmake cmake .. \
    -DCMAKE_INSTALL_PREFIX="${SYSROOT_DIR}" \
    -DBUILD_SHARED_LIBS=OFF \
    -DZLIB_LIBRARY="${SYSROOT_DIR}/lib/libz.a" \
    -DZLIB_INCLUDE_DIR="${SYSROOT_DIR}/include" \
    -DENABLE_ZLIB=ON \
    -DENABLE_BZIP2=OFF \
    -DENABLE_ZSTD=OFF \
    -DENABLE_LZMA=OFF

emmake make -j"$(nproc)"
emmake make install

popd >/dev/null
popd >/dev/null
popd >/dev/null

echo "libzip installed into ${SYSROOT_DIR}"