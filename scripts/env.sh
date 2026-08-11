#!/usr/bin/env bash

# SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>
#
# SPDX-License-Identifier: ISC

set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
PHP_VERSION="${PHP_VERSION:-8.5.9}"
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
ZLIB_VERSION="${ZLIB_VERSION:-1.3.2}"
ZLIB_SHA256="${ZLIB_SHA256:-bb329a0a2cd0274d05519d61c667c062e06990d72e125ee2dfa8de64f0119d16}"
LIBZIP_VERSION="${LIBZIP_VERSION:-1.11.4}"
LIBZIP_SHA256="${LIBZIP_SHA256:-8a247f57d1e3e6f6d11413b12a6f28a9d388de110adc0ec608d893180ed7097b}"
LIBICONV_VERSION="${LIBICONV_VERSION:-1.19}"
LIBICONV_SHA256="${LIBICONV_SHA256:-88dd96a8c0464eca144fc791ae60cd31cd8ee78321e67397e25fc095c4a19aa6}"
# SQLite amalgamation (used by ext/sqlite3 / pdo_sqlite)
SQLITE_AMALG_VERSION="${SQLITE_AMALG_VERSION:-3530400}"
SQLITE_AMALG_YEAR="${SQLITE_AMALG_YEAR:-2026}"
SQLITE_SHA256="${SQLITE_SHA256:-1e71ddf93849c6a6ecf58b827c0692073d2dd7ee40196158068f7b29f422e87d}"
# Oniguruma (used by ext/mbstring). Upstream names its release asset
# `onig-X.Y.Z.tar.gz`; fetch.sh used to ask for `oniguruma-X.Y.Z.tar.gz`, which
# 404s, so it silently fell back to GitHub's auto-generated source archive —
# whose bytes are not a stable artifact to pin a hash against.
ONIGURUMA_VERSION="${ONIGURUMA_VERSION:-6.9.10}"
ONIGURUMA_SHA256="${ONIGURUMA_SHA256:-2a5cfc5ae259e4e97f86b68dfffc152cdaffe94e2060b770cb827238d769fc05}"

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
