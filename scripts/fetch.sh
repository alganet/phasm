#!/usr/bin/env bash

# SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>
#
# SPDX-License-Identifier: ISC

set -euo pipefail

source "$(dirname "$0")/env.sh"

# Ensure sources directory exists (fetch.sh is responsible for downloads)
mkdir -p "${SOURCES_DIR}"

if [[ ! -d "${PHP_SRC_DIR}/.git" ]]; then
	git clone --depth 1 https://github.com/php/php-src.git "${PHP_SRC_DIR}"
fi

cd "${PHP_SRC_DIR}"

git fetch --tags origin

# Ensure oniguruma source is available (used by ext/mbstring)
if [[ ! -d "${SOURCES_DIR}/oniguruma" ]]; then
	if [[ "${ONIGURUMA_VERSION:-}" != "master" ]]; then
		# Try to download a release tarball (contains configure/autotools generated files)
		ONIG_TAR="oniguruma-${ONIGURUMA_VERSION}.tar.gz"
		ONIG_URLS=(
			"https://github.com/kkos/oniguruma/releases/download/v${ONIGURUMA_VERSION}/${ONIG_TAR}"
			"https://github.com/kkos/oniguruma/archive/refs/tags/v${ONIGURUMA_VERSION}.tar.gz"
			"https://github.com/kkos/oniguruma/archive/refs/tags/${ONIGURUMA_VERSION}.tar.gz"
			"https://github.com/kkos/oniguruma/archive/${ONIGURUMA_VERSION}.tar.gz"
		)
		if [[ ! -f "${SOURCES_DIR}/${ONIG_TAR}" ]]; then
			echo "Fetching ${ONIG_TAR} into ${SOURCES_DIR}..."
			for url in "${ONIG_URLS[@]}"; do
				echo "  trying ${url}..."
				if wget -O "${SOURCES_DIR}/${ONIG_TAR}" "${url}" >/dev/null 2>&1; then
					if [[ -s "${SOURCES_DIR}/${ONIG_TAR}" ]]; then
						break
					fi
				fi
			done
		fi
		if [[ -f "${SOURCES_DIR}/${ONIG_TAR}" && ! -d "${SOURCES_DIR}/oniguruma-${ONIGURUMA_VERSION}" ]]; then
			mkdir -p "${SOURCES_DIR}"
			tar -xf "${SOURCES_DIR}/${ONIG_TAR}" -C "${SOURCES_DIR}"
			# normalize directory name
			if [[ -d "${SOURCES_DIR}/oniguruma-${ONIGURUMA_VERSION}" ]]; then
				mv "${SOURCES_DIR}/oniguruma-${ONIGURUMA_VERSION}" "${SOURCES_DIR}/oniguruma"
			elif [[ -d "${SOURCES_DIR}/oniguruma-${ONIGURUMA_VERSION%.*}" ]]; then
				mv "${SOURCES_DIR}/oniguruma-${ONIGURUMA_VERSION%.*}" "${SOURCES_DIR}/oniguruma" || true
			fi
		fi
	fi
fi

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

# libiconv
fetch_and_extract "libiconv-${LIBICONV_VERSION}.tar.gz" "${SOURCES_DIR}/libiconv-${LIBICONV_VERSION}" "https://ftp.gnu.org/pub/gnu/libiconv/libiconv-${LIBICONV_VERSION}.tar.gz"

# sqlite amalgamation (zip)
SQLITE_ZIP="sqlite-amalgamation-${SQLITE_AMALG_VERSION}.zip"
SQLITE_URLS=(
    "https://www.sqlite.org/${SQLITE_AMALG_YEAR}/${SQLITE_ZIP}"
)
if [[ ! -d "${SOURCES_DIR}/sqlite-amalgamation-${SQLITE_AMALG_VERSION}" ]]; then
    echo "Fetching ${SQLITE_ZIP} into ${SOURCES_DIR}..."
    if [[ ! -f "${SOURCES_DIR}/${SQLITE_ZIP}" ]]; then
        success=0
        for url in "${SQLITE_URLS[@]}"; do
            echo "  trying ${url}..."
            if wget -O "${SOURCES_DIR}/${SQLITE_ZIP}" "${url}" >/dev/null 2>&1; then
                if [[ -s "${SOURCES_DIR}/${SQLITE_ZIP}" ]]; then
                    success=1
                    break
                fi
            fi
        done
        if [[ ${success} -ne 1 ]]; then
            echo "Failed to download ${SQLITE_ZIP}" >&2
            exit 1
        fi
    fi
    echo "Extracting ${SQLITE_ZIP} into ${SOURCES_DIR}..."
    mkdir -p "${SOURCES_DIR}/sqlite-amalgamation-${SQLITE_AMALG_VERSION}"
    unzip -q "${SOURCES_DIR}/${SQLITE_ZIP}" -d "${SOURCES_DIR}/sqlite-amalgamation-${SQLITE_AMALG_VERSION}" || true
    if [[ -d "${SOURCES_DIR}/sqlite-amalgamation-${SQLITE_AMALG_VERSION}/sqlite-amalgamation-${SQLITE_AMALG_VERSION}" ]]; then
        mv "${SOURCES_DIR}/sqlite-amalgamation-${SQLITE_AMALG_VERSION}/sqlite-amalgamation-${SQLITE_AMALG_VERSION}"/* "${SOURCES_DIR}/sqlite-amalgamation-${SQLITE_AMALG_VERSION}/" || true
    fi
fi

