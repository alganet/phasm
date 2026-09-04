#!/usr/bin/env bash

# SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>
#
# SPDX-License-Identifier: ISC

# One verified download, shared by everything here that reaches the network.
#
# This used to live inside fetch.sh, which was fine while the build's tarballs
# were the only thing downloaded. It is its own file because a second copy of a
# checksum routine is the kind of duplication that stays right until the day one
# copy is fixed and the other is not.

# Download a file from the first URL whose bytes match its pinned SHA-256.
# Every download here comes off the public internet, so without the hash a
# mirror swap, a truncated download or a hijacked release is invisible until it
# shows up as a mysterious compile error — or doesn't show up at all.
#
# The verification happens INSIDE the URL loop, and that is the whole point: a
# chain that keeps whatever the first *reachable* URL returned is not a
# fallback, it is a coin flip. This used to take the first non-empty response
# and check it afterwards, so when zlib.net was unreachable from CI the run
# grabbed GitHub's auto-generated /archive/ tarball — a different artifact from
# the release tarball the pin describes, same version, different bytes — and
# aborted on the mismatch instead of trying the next mirror. Pins always
# describe the upstream *release* artifact; never pin an /archive/ URL.
download_verified() {
	local file="$1" expected="$2"
	shift 2
	local name url actual tmp
	name="$(basename "${file}")"

	if [[ -z "${expected}" ]]; then
		echo "No SHA-256 pinned for ${name} — refusing to continue." >&2
		exit 1
	fi

	if [[ -s "${file}" ]]; then
		actual="$(sha256sum "${file}" | cut -d' ' -f1)"
		if [[ "${actual}" == "${expected}" ]]; then
			echo "  sha256 ok: ${name} (cached)"
			return 0
		fi
		# A cached file that stopped matching is either a stale pin or a
		# poisoned cache. Drop it and re-fetch rather than trust it.
		echo "  cached ${name} does not match its pin — re-downloading" >&2
		rm -f "${file}"
	fi

	echo "Fetching ${name} into $(dirname "${file}")..."
	tmp="${file}.part"
	for url in "$@"; do
		echo "  trying ${url}..."
		rm -f "${tmp}"
		if ! wget -O "${tmp}" "${url}" >/dev/null 2>&1 || [[ ! -s "${tmp}" ]]; then
			echo "  download failed: ${url}" >&2
			continue
		fi
		actual="$(sha256sum "${tmp}" | cut -d' ' -f1)"
		if [[ "${actual}" != "${expected}" ]]; then
			echo "  CHECKSUM MISMATCH from ${url}" >&2
			echo "    expected ${expected}" >&2
			echo "    actual   ${actual}" >&2
			rm -f "${tmp}"
			continue
		fi
		mv "${tmp}" "${file}"
		echo "  sha256 ok: ${name}"
		return 0
	done

	rm -f "${tmp}"
	echo "No source for ${name} matched its pinned SHA-256 ${expected}." >&2
	echo "If the version was just bumped, update its hash in scripts/env.sh." >&2
	exit 1
}
