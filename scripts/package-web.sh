#!/usr/bin/env bash

# SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>
#
# SPDX-License-Identifier: ISC

set -euo pipefail

source "$(dirname "$0")/env.sh"

mkdir -p "${WEB_DIR}/assets" "${DIST_DIR}"

if [[ ! -f "${DIST_DIR}/php.js" || ! -f "${DIST_DIR}/php.wasm" ]]; then
	echo "Missing dist artifacts. Run ./scripts/build.sh first."
	exit 1
fi

cp "${DIST_DIR}/php.js" "${WEB_DIR}/assets/php.js"
cp "${DIST_DIR}/php.wasm" "${WEB_DIR}/assets/php.wasm"


echo "Web assets updated in ${WEB_DIR}/assets"
echo "npm distribution files ready in ${DIST_DIR}"
