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

ZLIB_VERSION="${ZLIB_VERSION:-1.2.11}"
LIBZIP_VERSION="${LIBZIP_VERSION:-1.9.2}"
LIBICONV_VERSION="${LIBICONV_VERSION:-1.16}"
# Oniguruma (used by ext/mbstring)
ONIGURUMA_VERSION="${ONIGURUMA_VERSION:-6.9.4}"

DEFAULT_EMSDK_ENV="${ROOT_DIR}/build/emsdk/emsdk_env.sh"
if [[ -z "${EMSDK_ENV:-}" && -f "${DEFAULT_EMSDK_ENV}" ]]; then
	EMSDK_ENV="${DEFAULT_EMSDK_ENV}"
else
	EMSDK_ENV="${EMSDK_ENV:-}"
fi
EMCC_FLAGS="${EMCC_FLAGS:--O2 -s EXPORT_NAME='Phasm' -s ALLOW_MEMORY_GROWTH=1 -s NO_EXIT_RUNTIME=1}"
