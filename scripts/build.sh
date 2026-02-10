#!/usr/bin/env bash

# SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>
#
# SPDX-License-Identifier: ISC

set -euo pipefail

source "$(dirname "$0")/env.sh"

if [[ -n "${EMSDK_ENV}" ]]; then
	source "${EMSDK_ENV}"
fi

if ! command -v emcc >/dev/null 2>&1; then
	echo "emcc not found. Run ./scripts/setup.sh first."
	exit 1
fi

if [[ ! -d "${PHP_SRC_DIR}/.git" ]]; then
	echo "PHP source not found. Run ./scripts/fetch.sh first."
	exit 1
fi

# Ensure libzip is built for WASM; build it unless already present
if [[ ! -f "${BUILD_DIR}/sysroot/lib/libzip.a" ]]; then
	echo "libzip not found for WASM in ${BUILD_DIR}/sysroot. Run ./scripts/deps.sh first."
	exit 1
fi

mkdir -p "${BUILD_DIR}" "${DIST_DIR}"

cd "${PHP_SRC_DIR}"

./buildconf --force || true

pushd "${BUILD_DIR}" >/dev/null

# Export LIBZIP_CFLAGS/LIBZIP_LIBS using sysroot paths (no pkg-config)
export LIBZIP_CFLAGS="-I${BUILD_DIR}/sysroot/include"
export LIBZIP_LIBS="-L${BUILD_DIR}/sysroot/lib -lzip -lz"
export ICONV_CFLAGS="-I${BUILD_DIR}/sysroot/include"
export ICONV_LIBS="-L${BUILD_DIR}/sysroot/lib -liconv"
echo "LIBZIP_CFLAGS=${LIBZIP_CFLAGS}"
echo "LIBZIP_LIBS=${LIBZIP_LIBS}"
echo "ICONV_CFLAGS=${ICONV_CFLAGS}"
echo "ICONV_LIBS=${ICONV_LIBS}"

emconfigure "${PHP_SRC_DIR}/configure" \
	--without-pear \
	--with-iconv="${BUILD_DIR}/sysroot" \
	--without-pcre-jit \
	--disable-all \
	--disable-opcache-jit \
	--disable-phpdbg \
	--disable-fiber-asm \
	--disable-cgi \
	--with-zip \
	--enable-cli \
	--enable-ctype \
	--enable-filter \
	--enable-fileinfo \
	--enable-gmp \
	--enable-tokenizer

emmake make -j"$(nproc)" EMCC_CFLAGS="${EMCC_FLAGS}"

popd >/dev/null

if [[ -f "${BUILD_DIR}/sapi/cli/php.wasm" ]]; then
	if [[ -f "${BUILD_DIR}/sapi/cli/php.js" ]]; then
		cp "${BUILD_DIR}/sapi/cli/php.js" "${DIST_DIR}/php.js"
	elif [[ -f "${BUILD_DIR}/sapi/cli/php" ]]; then
		cp "${BUILD_DIR}/sapi/cli/php" "${DIST_DIR}/php.js"
	else
		echo "Build output not found. Expected php.js or php wrapper in sapi/cli."
		exit 1
	fi
	cp "${BUILD_DIR}/sapi/cli/php.wasm" "${DIST_DIR}/php.wasm"
else
	echo "Build output not found. Expected sapi/cli/php.wasm."
	exit 1
fi

echo "WASM artifacts in ${DIST_DIR}"
