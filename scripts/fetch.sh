#!/usr/bin/env bash

# SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>
#
# SPDX-License-Identifier: ISC

set -euo pipefail

source "$(dirname "$0")/env.sh"

mkdir -p "${ROOT_DIR}/sources"

if [[ ! -d "${PHP_SRC_DIR}/.git" ]]; then
	git clone --depth 1 https://github.com/php/php-src.git "${PHP_SRC_DIR}"
fi

cd "${PHP_SRC_DIR}"

git fetch --tags origin

if git rev-parse --verify "${PHP_GIT_REF}" >/dev/null 2>&1; then
	git checkout "${PHP_GIT_REF}"
elif git rev-parse --verify "origin/${PHP_GIT_REF}" >/dev/null 2>&1; then
	git checkout -b "${PHP_GIT_REF}" "origin/${PHP_GIT_REF}"
else
	git checkout master
fi

# Ensure zlib and libzip sources are present in ${SOURCES_DIR} as subdirs
# zlib
if [[ ! -d "${SOURCES_DIR}/zlib-${ZLIB_VERSION}" ]]; then
	echo "Fetching zlib ${ZLIB_VERSION} into ${SOURCES_DIR}..."
	ZLIB_TAR="zlib-${ZLIB_VERSION}.tar.gz"
	ZLIB_URL="https://zlib.net/fossils/${ZLIB_TAR}"
	if [[ ! -f "${SOURCES_DIR}/${ZLIB_TAR}" ]] || [[ ! -s "${SOURCES_DIR}/${ZLIB_TAR}" ]]; then
		wget -O "${SOURCES_DIR}/${ZLIB_TAR}" "${ZLIB_URL}" || true
		if [[ ! -s "${SOURCES_DIR}/${ZLIB_TAR}" ]]; then
			echo "Primary zlib URL failed; trying GitHub release..."
			GITHUB_URL="https://github.com/madler/zlib/archive/refs/tags/v${ZLIB_VERSION}.tar.gz"
			wget -O "${SOURCES_DIR}/${ZLIB_TAR}" "${GITHUB_URL}"
		fi
	fi
	echo "Extracting zlib into ${SOURCES_DIR}..."
	tar -xf "${SOURCES_DIR}/${ZLIB_TAR}" -C "${SOURCES_DIR}"
fi

# libzip
if [[ ! -d "${SOURCES_DIR}/libzip-${LIBZIP_VERSION}" ]]; then
	echo "Fetching libzip ${LIBZIP_VERSION} into ${SOURCES_DIR}..."
	LIBZIP_TAR="libzip-${LIBZIP_VERSION}.tar.xz"
	LIBZIP_URL="https://libzip.org/download/${LIBZIP_TAR}"
	if [[ ! -f "${SOURCES_DIR}/${LIBZIP_TAR}" ]]; then
		wget -O "${SOURCES_DIR}/${LIBZIP_TAR}" "${LIBZIP_URL}"
	fi
	echo "Extracting libzip into ${SOURCES_DIR}..."
	tar -xf "${SOURCES_DIR}/${LIBZIP_TAR}" -C "${SOURCES_DIR}"
fi

