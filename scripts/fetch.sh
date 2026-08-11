#!/usr/bin/env bash

# SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>
#
# SPDX-License-Identifier: ISC

set -euo pipefail

source "$(dirname "$0")/env.sh"

# Ensure sources directory exists (fetch.sh is responsible for downloads)
mkdir -p "${SOURCES_DIR}"

# Verify a downloaded artifact against its pinned SHA-256 from env.sh. Every
# tarball below comes off the public internet through a fallback URL chain, so
# without this a mirror swap, a truncated download or a hijacked release is
# invisible until it shows up as a mysterious compile error — or doesn't show
# up at all. A mismatch deletes the file so a re-run cannot "succeed" from a
# poisoned cache.
verify_sha256() {
	local file="$1" expected="$2" actual
	if [[ -z "${expected}" ]]; then
		echo "No SHA-256 pinned for $(basename "${file}") — refusing to continue." >&2
		exit 1
	fi
	actual="$(sha256sum "${file}" | cut -d' ' -f1)"
	if [[ "${actual}" != "${expected}" ]]; then
		echo "CHECKSUM MISMATCH for $(basename "${file}")" >&2
		echo "  expected ${expected}" >&2
		echo "  actual   ${actual}" >&2
		rm -f "${file}"
		exit 1
	fi
	echo "  sha256 ok: $(basename "${file}")"
}

if [[ ! -d "${PHP_SRC_DIR}/.git" ]]; then
	git clone --depth 1 https://github.com/php/php-src.git "${PHP_SRC_DIR}"
fi

cd "${PHP_SRC_DIR}"

git fetch --tags origin

# Ensure oniguruma source is available (used by ext/mbstring)
if [[ ! -d "${SOURCES_DIR}/oniguruma" ]]; then
	if [[ "${ONIGURUMA_VERSION:-}" != "master" ]]; then
		# The release tarball (contains configure/autotools generated files).
		# Upstream calls it onig-X.Y.Z.tar.gz — asking for oniguruma-X.Y.Z.tar.gz
		# always 404'd and silently fell through to the source archive below.
		ONIG_TAR="onig-${ONIGURUMA_VERSION}.tar.gz"
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
		if [[ ! -s "${SOURCES_DIR}/${ONIG_TAR}" ]]; then
			echo "Failed to download ${ONIG_TAR} from provided URLs" >&2
			exit 1
		fi
		verify_sha256 "${SOURCES_DIR}/${ONIG_TAR}" "${ONIGURUMA_SHA256}"
		if [[ -f "${SOURCES_DIR}/${ONIG_TAR}" ]]; then
			mkdir -p "${SOURCES_DIR}"
			tar -xf "${SOURCES_DIR}/${ONIG_TAR}" -C "${SOURCES_DIR}"
			# normalize directory name (onig-X.Y.Z from the release tarball,
			# oniguruma-X.Y.Z from a source-archive fallback)
			for candidate in "onig-${ONIGURUMA_VERSION}" "oniguruma-${ONIGURUMA_VERSION}" "oniguruma-${ONIGURUMA_VERSION%.*}"; do
				if [[ -d "${SOURCES_DIR}/${candidate}" ]]; then
					mv "${SOURCES_DIR}/${candidate}" "${SOURCES_DIR}/oniguruma"
					break
				fi
			done
		fi
	fi
fi

# apply-patches.sh leaves the tree modified, and git refuses to switch refs over
# local changes — so bumping PHP_VERSION used to ABORT the checkout and silently
# keep building the previous version. Discard first; every local change here is
# ours to regenerate.
git reset --hard >/dev/null
git clean -fdq

if git rev-parse --verify "refs/tags/${PHP_GIT_REF}" >/dev/null 2>&1; then
	git checkout --detach "refs/tags/${PHP_GIT_REF}"
elif git rev-parse --verify "${PHP_GIT_REF}" >/dev/null 2>&1; then
	git checkout --detach "${PHP_GIT_REF}"
elif git rev-parse --verify "origin/${PHP_GIT_REF}" >/dev/null 2>&1; then
	git checkout --detach "origin/${PHP_GIT_REF}"
else
	echo "PHP ref ${PHP_GIT_REF} not found — is PHP_VERSION=${PHP_VERSION} a real release?" >&2
	exit 1
fi
echo "PHP source at $(git describe --tags --always)"

# Ensure zlib and libzip sources are present in ${SOURCES_DIR} as subdirs

fetch_and_extract() {
	local tarname="$1" dir="$2" sha="$3"
	shift 3
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
		verify_sha256 "${SOURCES_DIR}/${tarname}" "${sha}"
		echo "Extracting ${tarname} into ${SOURCES_DIR}..."
		tar -xf "${SOURCES_DIR}/${tarname}" -C "${SOURCES_DIR}"
	fi
}

# zlib (with GitHub fallback)
fetch_and_extract "zlib-${ZLIB_VERSION}.tar.gz" "${SOURCES_DIR}/zlib-${ZLIB_VERSION}" "${ZLIB_SHA256}" "https://zlib.net/fossils/zlib-${ZLIB_VERSION}.tar.gz" "https://github.com/madler/zlib/archive/refs/tags/v${ZLIB_VERSION}.tar.gz"

# libzip
fetch_and_extract "libzip-${LIBZIP_VERSION}.tar.xz" "${SOURCES_DIR}/libzip-${LIBZIP_VERSION}" "${LIBZIP_SHA256}" "https://libzip.org/download/libzip-${LIBZIP_VERSION}.tar.xz"

# libiconv
fetch_and_extract "libiconv-${LIBICONV_VERSION}.tar.gz" "${SOURCES_DIR}/libiconv-${LIBICONV_VERSION}" "${LIBICONV_SHA256}" "https://ftp.gnu.org/pub/gnu/libiconv/libiconv-${LIBICONV_VERSION}.tar.gz"

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
    verify_sha256 "${SOURCES_DIR}/${SQLITE_ZIP}" "${SQLITE_SHA256}"
    echo "Extracting ${SQLITE_ZIP} into ${SOURCES_DIR}..."
    mkdir -p "${SOURCES_DIR}/sqlite-amalgamation-${SQLITE_AMALG_VERSION}"
    unzip -q "${SOURCES_DIR}/${SQLITE_ZIP}" -d "${SOURCES_DIR}/sqlite-amalgamation-${SQLITE_AMALG_VERSION}" || true
    if [[ -d "${SOURCES_DIR}/sqlite-amalgamation-${SQLITE_AMALG_VERSION}/sqlite-amalgamation-${SQLITE_AMALG_VERSION}" ]]; then
        mv "${SOURCES_DIR}/sqlite-amalgamation-${SQLITE_AMALG_VERSION}/sqlite-amalgamation-${SQLITE_AMALG_VERSION}"/* "${SOURCES_DIR}/sqlite-amalgamation-${SQLITE_AMALG_VERSION}/" || true
    fi
fi

