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

fetch_and_extract() {
	local tarname="$1" dir="$2"
	shift 2
	# remaining args are URLs to try in order
	if [[ ! -d "${dir}" ]]; then
		echo "Fetching ${tarname} into ${SOURCES_DIR}..."
		if [[ ! -f "${SOURCES_DIR}/${tarname}" ]] || [[ ! -s "${SOURCES_DIR}/${tarname}" ]]; then
			local success=0
			for url in "$@"; do
				echo "  trying ${url}..."
				if wget -O "${SOURCES_DIR}/${tarname}" "${url}" >/dev/null 2>&1; then
					if [[ -s "${SOURCES_DIR}/${tarname}" ]]; then
						success=1
						break
					fi
				fi
			done
			if [[ ${success} -ne 1 ]]; then
				echo "Failed to download ${tarname} from provided URLs" >&2
				exit 1
			fi
		fi
		echo "Extracting ${tarname} into ${SOURCES_DIR}..."
		tar -xf "${SOURCES_DIR}/${tarname}" -C "${SOURCES_DIR}"
	fi
}

# zlib (with GitHub fallback)
fetch_and_extract "zlib-${ZLIB_VERSION}.tar.gz" "${SOURCES_DIR}/zlib-${ZLIB_VERSION}" "https://zlib.net/fossils/zlib-${ZLIB_VERSION}.tar.gz" "https://github.com/madler/zlib/archive/refs/tags/v${ZLIB_VERSION}.tar.gz"

# libzip
fetch_and_extract "libzip-${LIBZIP_VERSION}.tar.xz" "${SOURCES_DIR}/libzip-${LIBZIP_VERSION}" "https://libzip.org/download/libzip-${LIBZIP_VERSION}.tar.xz"

