#!/usr/bin/env bash

# SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>
#
# SPDX-License-Identifier: ISC

set -euo pipefail

source "$(dirname "$0")/env.sh"
# download_verified().
source "$(dirname "$0")/download.sh"

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
		# The release tarball (contains configure/autotools generated files).
		# Upstream calls it onig-X.Y.Z.tar.gz — asking for oniguruma-X.Y.Z.tar.gz
		# always 404'd and silently fell through to the source archive below.
		ONIG_TAR="onig-${ONIGURUMA_VERSION}.tar.gz"
		download_verified "${SOURCES_DIR}/${ONIG_TAR}" "${ONIGURUMA_SHA256}" \
			"https://github.com/kkos/oniguruma/releases/download/v${ONIGURUMA_VERSION}/${ONIG_TAR}"
		tar -xf "${SOURCES_DIR}/${ONIG_TAR}" -C "${SOURCES_DIR}"
		# The release tarball unpacks as onig-X.Y.Z; the rest of the build
		# expects sources/oniguruma.
		mv "${SOURCES_DIR}/onig-${ONIGURUMA_VERSION}" "${SOURCES_DIR}/oniguruma"
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
		download_verified "${SOURCES_DIR}/${tarname}" "${sha}" "$@"
		echo "Extracting ${tarname} into ${SOURCES_DIR}..."
		tar -xf "${SOURCES_DIR}/${tarname}" -C "${SOURCES_DIR}"
	fi
}

# zlib. The GitHub release asset goes first: it is the same artifact zlib.net
# serves (identical bytes, hence the same pin) and it is the mirror that stays
# reachable from CI. zlib.net moves a release from / into /fossils/ when the
# next one lands, so both paths are worth trying — but neither is worth being
# the only one.
fetch_and_extract "zlib-${ZLIB_VERSION}.tar.gz" "${SOURCES_DIR}/zlib-${ZLIB_VERSION}" "${ZLIB_SHA256}" \
	"https://github.com/madler/zlib/releases/download/v${ZLIB_VERSION}/zlib-${ZLIB_VERSION}.tar.gz" \
	"https://zlib.net/zlib-${ZLIB_VERSION}.tar.gz" \
	"https://zlib.net/fossils/zlib-${ZLIB_VERSION}.tar.gz"

# libzip
fetch_and_extract "libzip-${LIBZIP_VERSION}.tar.xz" "${SOURCES_DIR}/libzip-${LIBZIP_VERSION}" "${LIBZIP_SHA256}" "https://libzip.org/download/libzip-${LIBZIP_VERSION}.tar.xz"

# libiconv
fetch_and_extract "libiconv-${LIBICONV_VERSION}.tar.gz" "${SOURCES_DIR}/libiconv-${LIBICONV_VERSION}" "${LIBICONV_SHA256}" "https://ftp.gnu.org/pub/gnu/libiconv/libiconv-${LIBICONV_VERSION}.tar.gz"

# libxml2. GNOME publishes each release under its X.Y series directory, so the
# path carries the version minus its patch component.
LIBXML2_SERIES="${LIBXML2_VERSION%.*}"
fetch_and_extract "libxml2-${LIBXML2_VERSION}.tar.xz" "${SOURCES_DIR}/libxml2-${LIBXML2_VERSION}" "${LIBXML2_SHA256}" \
	"https://download.gnome.org/sources/libxml2/${LIBXML2_SERIES}/libxml2-${LIBXML2_VERSION}.tar.xz" \
	"https://ftp.gnome.org/pub/gnome/sources/libxml2/${LIBXML2_SERIES}/libxml2-${LIBXML2_VERSION}.tar.xz"

# OpenSSL. The GitHub release asset first — it is the artifact upstream signs
# and the one that stays reachable from CI — with openssl.org/source behind it.
# Both publish the same bytes and therefore the same pin, which is how the hash
# above was cross-checked: two independent publishers, one digest.
fetch_and_extract "openssl-${OPENSSL_VERSION}.tar.gz" "${SOURCES_DIR}/openssl-${OPENSSL_VERSION}" "${OPENSSL_SHA256}" \
	"https://github.com/openssl/openssl/releases/download/openssl-${OPENSSL_VERSION}/openssl-${OPENSSL_VERSION}.tar.gz" \
	"https://www.openssl.org/source/openssl-${OPENSSL_VERSION}.tar.gz"

# sqlite amalgamation (zip)
SQLITE_ZIP="sqlite-amalgamation-${SQLITE_AMALG_VERSION}.zip"
if [[ ! -d "${SOURCES_DIR}/sqlite-amalgamation-${SQLITE_AMALG_VERSION}" ]]; then
    download_verified "${SOURCES_DIR}/${SQLITE_ZIP}" "${SQLITE_SHA256}" \
        "https://www.sqlite.org/${SQLITE_AMALG_YEAR}/${SQLITE_ZIP}"
    echo "Extracting ${SQLITE_ZIP} into ${SOURCES_DIR}..."
    mkdir -p "${SOURCES_DIR}/sqlite-amalgamation-${SQLITE_AMALG_VERSION}"
    unzip -q "${SOURCES_DIR}/${SQLITE_ZIP}" -d "${SOURCES_DIR}/sqlite-amalgamation-${SQLITE_AMALG_VERSION}" || true
    if [[ -d "${SOURCES_DIR}/sqlite-amalgamation-${SQLITE_AMALG_VERSION}/sqlite-amalgamation-${SQLITE_AMALG_VERSION}" ]]; then
        mv "${SOURCES_DIR}/sqlite-amalgamation-${SQLITE_AMALG_VERSION}/sqlite-amalgamation-${SQLITE_AMALG_VERSION}"/* "${SOURCES_DIR}/sqlite-amalgamation-${SQLITE_AMALG_VERSION}/" || true
    fi
fi

