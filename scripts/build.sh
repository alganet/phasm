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

# ext/phar's path scanner is generated from a .re by re2c, and php-src's git
# tree does not carry the generated file the way a release tarball does. When
# re2c is missing, configure sets `RE2C = exit 0;` and the generation rule
# quietly succeeds while producing nothing — so the build dies hundreds of lines
# later on "no such file or directory: ext/phar/phar_path_check.c", which names
# neither phar nor re2c. CONTRIBUTING.md lists it and CI installs it; this is
# for the machine that skipped a line.
if ! command -v re2c >/dev/null 2>&1; then
	echo "re2c not found. ext/phar's scanner is generated from a .re file and"
	echo "cannot be built without it. See CONTRIBUTING.md for the package list."
	exit 1
fi

# Ensure libzip is built for WASM; build it unless already present
if [[ ! -f "${BUILD_DIR}/sysroot/lib/libzip.a" ]]; then
	echo "libzip not found for WASM in ${BUILD_DIR}/sysroot. Run ./scripts/deps.sh first."
	exit 1
fi

mkdir -p "${BUILD_DIR}" "${DIST_DIR}"

# The phasm SAPI lives in this repo, not in a patch: it is our source, and a
# patch would have to be rebased at every PHP bump for no benefit. Copy it in
# before buildconf, which is what discovers sapi/*/config.m4. fetch.sh runs
# `git reset --hard` on php-src, and that leaves untracked files alone, so this
# survives a re-fetch and is refreshed here on every build regardless.
rm -rf "${PHP_SRC_DIR}/sapi/phasm"
cp -R "${ROOT_DIR}/sapi/phasm" "${PHP_SRC_DIR}/sapi/phasm"

cd "${PHP_SRC_DIR}"

./buildconf --force || true

pushd "${BUILD_DIR}" >/dev/null

# Export LIBZIP_CFLAGS/LIBZIP_LIBS using sysroot paths (no pkg-config)
export LIBZIP_CFLAGS="-I${BUILD_DIR}/sysroot/include"
export LIBZIP_LIBS="-L${BUILD_DIR}/sysroot/lib -lzip -lz"
export ICONV_CFLAGS="-I${BUILD_DIR}/sysroot/include"
export ICONV_LIBS="-L${BUILD_DIR}/sysroot/lib -liconv"
# Oniguruma for ext/mbstring
export ONIG_CFLAGS="-I${BUILD_DIR}/sysroot/include"
export ONIG_LIBS="-L${BUILD_DIR}/sysroot/lib -lonig"
# zlib for ext/zlib. Unlike the others this one is not a bespoke variable:
# PHP_SETUP_ZLIB is a PKG_CHECK_MODULES call, and pkg-config's own convention is
# that a pre-set <MODULE>_CFLAGS/<MODULE>_LIBS pair short-circuits the probe. So
# these two lines are what keep a cross build from asking the host's pkg-config
# about the host's zlib. The library itself has been in the sysroot all along —
# deps.sh builds it because libzip needs it — and only the extension was missing.
export ZLIB_CFLAGS="-I${BUILD_DIR}/sysroot/include"
export ZLIB_LIBS="-L${BUILD_DIR}/sysroot/lib -lz"
# SQLite (headers + static lib installed into sysroot by scripts/deps.sh)
export SQLITE_CFLAGS="-I${BUILD_DIR}/sysroot/include"
export SQLITE_LIBS="-L${BUILD_DIR}/sysroot/lib -lsqlite3"

echo "LIBZIP_CFLAGS=${LIBZIP_CFLAGS}"
echo "LIBZIP_LIBS=${LIBZIP_LIBS}"
echo "ICONV_CFLAGS=${ICONV_CFLAGS}"
echo "ICONV_LIBS=${ICONV_LIBS}"
echo "ONIG_CFLAGS=${ONIG_CFLAGS}"
echo "ONIG_LIBS=${ONIG_LIBS}"
echo "ZLIB_CFLAGS=${ZLIB_CFLAGS}"
echo "ZLIB_LIBS=${ZLIB_LIBS}"
echo "SQLITE_CFLAGS=${SQLITE_CFLAGS}"
echo "SQLITE_LIBS=${SQLITE_LIBS}"

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
	`# The zlib LIBRARY has been built and linked since the beginning, because` \
	`# libzip depends on it; the zlib EXTENSION was never enabled, so gzencode,` \
	`# the compress.zlib:// wrapper and phar's compressed archives were all` \
	`# missing while the code to do the work was already in the binary.` \
	--with-zlib \
	--enable-calendar \
	`# The phasm SAPI replaces the CLI rather than joining it: sapi/phasm's` \
	`# phasm.c includes sapi/cli/php_cli.c to reuse its argument handling, so` \
	`# php_cli.c must belong to exactly one translation unit. What ships is the` \
	`# CLI, plus entry points that can be called more than once.` \
	--disable-cli \
	--enable-phasm \
	--enable-ctype \
	--enable-filter \
	--enable-fileinfo \
	`# gmp needs --with-gmp AND a libgmp cross-built into the sysroot. It was` \
	`# passed as --enable-gmp, which configure only WARNS about, so the README` \
	`# advertised an extension that was never built. Adding it for real means` \
	`# building libgmp in deps.sh first — see the roadmap's extensions phase.` \
	--enable-mbstring \
	--enable-pcntl \
	--enable-pdo \
	`# phar is the one that makes tooling exist. composer.phar, phpunit.phar` \
	`# and php-cs-fixer.phar are single-file archives with a PHP stub, so` \
	`# without this extension they are not slow or degraded — they simply do` \
	`# not run, and the "offline phpunit in the terminal" deliverable is` \
	`# unreachable. It needs hash and spl, both always-on, and it reads a` \
	`# compressed archive only when zlib is linked, which is why the two are` \
	`# enabled together.` \
	--enable-phar \
	`# session is a platform requirement of Laravel and of most real apps, and` \
	`# it costs nothing here: the default files handler writes to save_path,` \
	`# which is an ordinary directory in the store phasm already mounts.` \
	--enable-session \
	--with-sqlite3 \
	--with-pdo-sqlite \
	--enable-static \
	--enable-tokenizer

emmake make -j"$(nproc)" EMCC_CFLAGS="${EMCC_FLAGS}"

popd >/dev/null

SAPI_OUT_DIR="${BUILD_DIR}/sapi/phasm"

if [[ -f "${SAPI_OUT_DIR}/php.wasm" ]]; then
	if [[ -f "${SAPI_OUT_DIR}/php.js" ]]; then
		cp "${SAPI_OUT_DIR}/php.js" "${DIST_DIR}/php.js"
	elif [[ -f "${SAPI_OUT_DIR}/php" ]]; then
		cp "${SAPI_OUT_DIR}/php" "${DIST_DIR}/php.js"
	else
		echo "Build output not found. Expected php.js or php wrapper in sapi/phasm."
		exit 1
	fi
	cp "${SAPI_OUT_DIR}/php.wasm" "${DIST_DIR}/php.wasm"
else
	echo "Build output not found. Expected sapi/phasm/php.wasm."
	exit 1
fi

# package.json points `types` at dist/php.d.ts; nothing used to put it there, so
# every published release shipped a types field aimed at a missing file.
cp "${ROOT_DIR}/src/php.d.ts" "${DIST_DIR}/php.d.ts"

# Likewise the store mount: plain JS over the module's FS, and it imports its
# ZenFS peers lazily, so a page that never mounts anything pays nothing to have
# it in the tarball.
cp "${ROOT_DIR}/src/mount.mjs" "${DIST_DIR}/mount.mjs"
cp "${ROOT_DIR}/src/mount.d.ts" "${DIST_DIR}/mount.d.ts"

echo "WASM artifacts in ${DIST_DIR}"
