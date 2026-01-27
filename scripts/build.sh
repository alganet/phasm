#!/usr/bin/env bash

# SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>
#
# SPDX-License-Identifier: ISC

set -euo pipefail

source "$(dirname "$0")/env.sh"

if [[ -n "${EMSDK_ENV}" ]]; then
	# shellcheck disable=SC1090
	source "${EMSDK_ENV}"
fi

if ! command -v emcc >/dev/null 2>&1; then
	echo "emcc not found. Ensure Emscripten is installed and EMSDK_ENV is set."
	exit 1
fi

if [[ ! -d "${PHP_SRC_DIR}/.git" ]]; then
	echo "PHP source not found. Run ./scripts/fetch.sh first."
	exit 1
fi

rm -rf "${BUILD_DIR}"
mkdir -p "${BUILD_DIR}" "${DIST_DIR}"

cd "${PHP_SRC_DIR}"

./buildconf --force || true

pushd "${BUILD_DIR}" >/dev/null

# Ensure libzip is available for cross-compilation. If not found, build it
SYSROOT_PKGCONFIG="${BUILD_DIR}/sysroot/lib/pkgconfig:${BUILD_DIR}/sysroot/share/pkgconfig"
export PKG_CONFIG_PATH="${SYSROOT_PKGCONFIG}:${PKG_CONFIG_PATH:-}"

if ! command -v pkg-config >/dev/null 2>&1; then
	# pkg-config is required for detection; warn but continue (configure will also error)
	echo "pkg-config not found; install it (e.g. apt-get install pkg-config)" >&2
fi

# Prefer a WASM-built libzip even if a host libzip exists. Try to compile a trivial
# test with the flags from pkg-config to make sure it's usable with Emscripten.
if pkg-config --exists libzip >/dev/null 2>&1; then
	LIBZIP_CFLAGS="$(pkg-config --cflags libzip)"
	LIBZIP_LIBS="$(pkg-config --libs libzip)"
	# Try a small compile to verify the flags are usable by emcc
	TMPTEST="${BUILD_DIR}/tmp_libzip_test.c"
	cat > "${TMPTEST}" <<'EOF'
int main(void){return 0;}
EOF
	set +e
	echo "Trying to compile a test program with system libzip using emcc..."
	if ! ${EMCC:-emcc} ${LIBZIP_CFLAGS} "${TMPTEST}" ${LIBZIP_LIBS} -o "${BUILD_DIR}/tmp_libzip_test.wasm" >/dev/null 2>&1; then
		set -e
		echo "Found host libzip via pkg-config but it's not usable with Emscripten. Building WASM libzip..."
		"${ROOT_DIR}/scripts/build-deps.sh"
		export PKG_CONFIG_PATH="${SYSROOT_PKGCONFIG}:${PKG_CONFIG_PATH:-}"
	else
		echo "pkg-config libzip appears usable with emcc. Using it." 
		rm -f "${BUILD_DIR}/tmp_libzip_test.c" "${BUILD_DIR}/tmp_libzip_test.wasm" || true
		set -e
	fi
else
	echo "libzip not found for cross-compile. Building libzip into ${BUILD_DIR}/sysroot..."
	"${ROOT_DIR}/scripts/build-deps.sh"
	# Ensure new .pc files are visible
	export PKG_CONFIG_PATH="${SYSROOT_PKGCONFIG}:${PKG_CONFIG_PATH:-}"
fi

# Debugging info
echo "PKG_CONFIG_PATH=${PKG_CONFIG_PATH}"
# Export LIBZIP_CFLAGS/LIBZIP_LIBS to avoid PKG_CHECK_MODULES issues during configure
export LIBZIP_CFLAGS="$(PKG_CONFIG_PATH="${SYSROOT_PKGCONFIG}:${PKG_CONFIG_PATH:-}" pkg-config --cflags libzip 2>/dev/null || true)"
export LIBZIP_LIBS="$(PKG_CONFIG_PATH="${SYSROOT_PKGCONFIG}:${PKG_CONFIG_PATH:-}" pkg-config --libs --static libzip 2>/dev/null || true)"
echo "LIBZIP_CFLAGS=${LIBZIP_CFLAGS}"
echo "LIBZIP_LIBS=${LIBZIP_LIBS}"
pkg-config --modversion libzip || true

PKG_CONFIG_PATH="${SYSROOT_PKGCONFIG}:${PKG_CONFIG_PATH:-}" emconfigure "${PHP_SRC_DIR}/configure" \
	--without-pear \
	--without-iconv \
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

emmake make -j"$(nproc)"

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
