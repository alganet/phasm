#!/usr/bin/env bash

# SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>
#
# SPDX-License-Identifier: ISC

set -euo pipefail

source "$(dirname "$0")/env.sh"

if [[ ! -d "${PHP_SRC_DIR}/.git" ]]; then
	echo "PHP source not found. Run ./scripts/fetch.sh first."
	exit 1
fi

shopt -s nullglob
patches=("${PATCH_DIR}"/*.patch)

if [[ ${#patches[@]} -eq 0 ]]; then
	echo "No patches to apply."
	exit 0
fi

cd "${PHP_SRC_DIR}"

git reset --hard

for patch_file in "${patches[@]}"; do
	if git apply --check "${patch_file}" >/dev/null 2>&1; then
		echo "Applying ${patch_file}"
		git apply "${patch_file}"
	else
		echo "Skipping ${patch_file} (does not apply cleanly)"
	fi
done
