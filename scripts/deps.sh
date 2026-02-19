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
	source "${EMSDK_ENV}"
fi

# Defaults
SRC_DIR="${SOURCES_DIR}"
SYSROOT_DIR="${BUILD_DIR}/sysroot"
LIBZIP_TAR="libzip-${LIBZIP_VERSION}.tar.xz"

mkdir -p "${SRC_DIR}" "${SYSROOT_DIR}"
pushd "${SRC_DIR}" >/dev/null

# libzip source should be prepared by ./scripts/fetch.sh
if [[ ! -d "${SRC_DIR}/libzip-${LIBZIP_VERSION}" ]]; then
    if [[ -f "${SRC_DIR}/${LIBZIP_TAR}" ]]; then
        echo "Extracting libzip into ${SRC_DIR}..."
        tar -xf "${SRC_DIR}/${LIBZIP_TAR}" -C "${SRC_DIR}"
    else
        echo "libzip source not found in ${SRC_DIR}. Run ./scripts/fetch.sh to download sources." >&2
        exit 1
    fi
fi

# Ensure zlib (WASM) is available in sysroot since libzip requires it
ZLIB_TAR="zlib-${ZLIB_VERSION}.tar.gz"
if [[ ! -d "${SRC_DIR}/zlib-${ZLIB_VERSION}" ]]; then
    if [[ -f "${SRC_DIR}/${ZLIB_TAR}" && -s "${SRC_DIR}/${ZLIB_TAR}" ]]; then
        echo "Extracting zlib into ${SRC_DIR}..."
        tar -xf "${SRC_DIR}/${ZLIB_TAR}" -C "${SRC_DIR}"
    else
        echo "zlib source not found in ${SRC_DIR}. Run ./scripts/fetch.sh to download sources." >&2
        exit 1
    fi
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

# libiconv (GNU libiconv)
LIBICONV_TAR="libiconv-${LIBICONV_VERSION}.tar.gz"
if [[ ! -d "${SRC_DIR}/libiconv-${LIBICONV_VERSION}" ]]; then
    if [[ -f "${SRC_DIR}/${LIBICONV_TAR}" ]]; then
        echo "Extracting libiconv into ${SRC_DIR}..."
        tar -xf "${SRC_DIR}/${LIBICONV_TAR}" -C "${SRC_DIR}"
    else
        echo "libiconv source not found in ${SRC_DIR}. Run ./scripts/fetch.sh to download sources." >&2
        exit 1
    fi
fi
if [[ ! -f "${SYSROOT_DIR}/lib/libiconv.a" ]]; then
    echo "Building libiconv for WASM..."
    pushd "${SRC_DIR}/libiconv-${LIBICONV_VERSION}" >/dev/null
    # Use emconfigure/emmake to cross-build statically
    emconfigure ./configure --prefix="${SYSROOT_DIR}" --disable-shared
    emmake make -j"$(nproc)" || true

    # Try install
    emmake make install || true
    popd >/dev/null
fi

# oniguruma (used by PHP ext/mbstring)
# If sources/oniguruma was populated by fetch.sh (git clone), build and install it
if [[ -d "${SRC_DIR}/oniguruma" && ! -f "${SYSROOT_DIR}/lib/libonig.a" ]]; then
    echo "Building oniguruma for WASM..."
    pushd "${SRC_DIR}/oniguruma" >/dev/null

    # Prepare build system only if configure is missing (release tarballs already include it)
    if [[ ! -f configure && -f autogen.sh ]]; then
        echo "Running autogen.sh to generate configure (git clone detected)"
        ./autogen.sh || true
    fi
    # Prefer CMake build if available (avoids autotools/tooling differences)
    if [[ -f CMakeLists.txt ]]; then
        echo "oniguruma: building with CMake"
        mkdir -p build && pushd build >/dev/null
        emcmake cmake .. -DCMAKE_INSTALL_PREFIX="${SYSROOT_DIR}" -DBUILD_SHARED_LIBS=OFF
        emmake make -j"$(nproc)"
        emmake make install || true
        popd >/dev/null
    else
        if [[ -f configure ]]; then
            emconfigure ./configure --prefix="${SYSROOT_DIR}" --disable-shared || true
        else
            echo "oniguruma: no configure script found; attempting autoreconf..."
            autoreconf -i || true
            emconfigure ./configure --prefix="${SYSROOT_DIR}" --disable-shared || true
        fi

        emmake make -j"$(nproc)" || true
        emmake make install || true
    fi
    popd >/dev/null
fi

# SQLite (build amalgamation into sysroot so PHP --with-sqlite3 / --with-pdo-sqlite work)
SQLITE_ZIP="sqlite-amalgamation-${SQLITE_AMALG_VERSION}.zip"
if [[ ! -d "${SRC_DIR}/sqlite-amalgamation-${SQLITE_AMALG_VERSION}" ]]; then
    if [[ -f "${SRC_DIR}/${SQLITE_ZIP}" ]]; then
        echo "Extracting SQLite amalgamation into ${SRC_DIR}..."
        mkdir -p "${SRC_DIR}/sqlite-amalgamation-${SQLITE_AMALG_VERSION}"
        unzip -q "${SRC_DIR}/${SQLITE_ZIP}" -d "${SRC_DIR}/sqlite-amalgamation-${SQLITE_AMALG_VERSION}" || true
        # unzip may create a nested directory; normalize by moving files if needed
        if [[ -d "${SRC_DIR}/sqlite-amalgamation-${SQLITE_AMALG_VERSION}/sqlite-amalgamation-${SQLITE_AMALG_VERSION}" ]]; then
            mv "${SRC_DIR}/sqlite-amalgamation-${SQLITE_AMALG_VERSION}/sqlite-amalgamation-${SQLITE_AMALG_VERSION}"/* "${SRC_DIR}/sqlite-amalgamation-${SQLITE_AMALG_VERSION}/" || true
        fi
    else
        echo "sqlite-amalgamation-${SQLITE_AMALG_VERSION} not found in ${SRC_DIR}. Run ./scripts/fetch.sh to download sources." >&2
        exit 1
    fi
fi

# Build a tiny static libsqlite3.a for WASM and install into sysroot
if [[ ! -f "${SYSROOT_DIR}/lib/libsqlite3.a" ]]; then
    echo "Building sqlite3 (amalgamation) for WASM..."
    pushd "${SRC_DIR}/sqlite-amalgamation-${SQLITE_AMALG_VERSION}" >/dev/null

    # Compile the amalgamation into an object and archive into static lib
    emcc -c sqlite3.c -Os -fPIC -DSQLITE_CORE -DSQLITE_THREADSAFE=0 -o sqlite3.o || true
    if command -v emar >/dev/null 2>&1; then
        emar rcs libsqlite3.a sqlite3.o || true
    else
        ar rcs libsqlite3.a sqlite3.o || true
    fi

    mkdir -p "${SYSROOT_DIR}/lib" "${SYSROOT_DIR}/include"
    if [[ -f libsqlite3.a ]]; then
        cp libsqlite3.a "${SYSROOT_DIR}/lib/"
    fi
    if [[ -f sqlite3.h ]]; then
        cp sqlite3.h "${SYSROOT_DIR}/include/"
    fi

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