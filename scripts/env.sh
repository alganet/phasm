#!/usr/bin/env bash

# SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>
#
# SPDX-License-Identifier: ISC

set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
PHP_VERSION="${PHP_VERSION:-8.5.0}"
PHP_GIT_REF="${PHP_GIT_REF:-php-${PHP_VERSION}}"

SOURCES_DIR="${ROOT_DIR}/sources"
PHP_SRC_DIR="${SOURCES_DIR}/php-src"
BUILD_DIR="${ROOT_DIR}/build/php-wasm"
DIST_DIR="${ROOT_DIR}/dist"
WEB_DIR="${ROOT_DIR}/web"
PATCH_DIR="${ROOT_DIR}/patches/php-${PHP_VERSION}"

# Every dependency is pinned to a version AND a SHA-256. fetch.sh verifies each
# download against the hash and fails hard on mismatch — the tarballs come off
# the public internet through fallback URL chains, and without this a mirror
# swap or a hijacked release is invisible. When you bump a version you MUST bump
# its hash in the same commit; `shasum -a 256 sources/<file>` prints it.
ZLIB_VERSION="${ZLIB_VERSION:-1.2.11}"
ZLIB_SHA256="${ZLIB_SHA256:-c3e5e9fdd5004dcb542feda5ee4f0ff0744628baf8ed2dd5d66f8ca1197cb1a1}"
LIBZIP_VERSION="${LIBZIP_VERSION:-1.9.2}"
LIBZIP_SHA256="${LIBZIP_SHA256:-c93e9852b7b2dc931197831438fee5295976ee0ba24f8524a8907be5c2ba5937}"
LIBICONV_VERSION="${LIBICONV_VERSION:-1.16}"
LIBICONV_SHA256="${LIBICONV_SHA256:-e6a1b1b589654277ee790cce3734f07876ac4ccfaecbee8afa0b649cf529cc04}"
# SQLite amalgamation (used by ext/sqlite3 / pdo_sqlite)
SQLITE_AMALG_VERSION="${SQLITE_AMALG_VERSION:-3380500}"
SQLITE_AMALG_YEAR="${SQLITE_AMALG_YEAR:-2022}"
SQLITE_SHA256="${SQLITE_SHA256:-bebb039b748441e3d25d71d11f7a4a33f5df11f318ec18fa7f343d2083755e2c}"
# Oniguruma (used by ext/mbstring).
# NOTE: this is the hash of GitHub's auto-generated source archive, because the
# release-asset URL fetch.sh tries first has never worked — upstream names the
# asset `onig-X.Y.Z.tar.gz`, not `oniguruma-X.Y.Z.tar.gz`, so that URL 404s and
# the fallback chain silently wins. Fixed together with the version bump.
ONIGURUMA_VERSION="${ONIGURUMA_VERSION:-6.9.4}"
ONIGURUMA_SHA256="${ONIGURUMA_SHA256:-aea68e5843b627f5fe6d3d6b598845b7f3622910e0568408e7cc2fa6b3690b87}"

# Pin the Emscripten SDK. `emsdk install latest` moves under you: every CI run
# and every contributor gets whatever shipped most recently, so a build that
# worked last month breaks with no commit to blame — and that is not
# hypothetical here. This tree last built under 5.0.2 (Feb 2026); by the time
# the pin was added, `latest` had moved to 6.0.6, where PHP's libtool `-fPIC`
# objects now produce R_WASM_TABLE_INDEX_SLEB relocations that need MAIN_MODULE,
# and the link fails outright. Anyone cloning and running setup.sh was getting a
# broken build. Moving to 6.x is a deliberate migration, not a default.
EMSDK_VERSION="${EMSDK_VERSION:-5.0.2}"

DEFAULT_EMSDK_ENV="${ROOT_DIR}/build/emsdk/emsdk_env.sh"
if [[ -z "${EMSDK_ENV:-}" && -f "${DEFAULT_EMSDK_ENV}" ]]; then
	EMSDK_ENV="${DEFAULT_EMSDK_ENV}"
else
	EMSDK_ENV="${EMSDK_ENV:-}"
fi
EMCC_FLAGS="${EMCC_FLAGS:--O2 -s MODULARIZE=1 -s EXPORT_NAME='Phasm' -s EXPORTED_RUNTIME_METHODS=['FS','callMain'] -s ALLOW_MEMORY_GROWTH=1 -s NO_EXIT_RUNTIME=1}"
