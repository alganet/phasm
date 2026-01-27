#!/usr/bin/env bash

# SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>
#
# SPDX-License-Identifier: ISC

set -euo pipefail

source "$(dirname "$0")/env.sh"

EMSDK_DIR="${ROOT_DIR}/tools/emsdk"

if [[ ! -d "${EMSDK_DIR}/.git" ]]; then
	mkdir -p "${ROOT_DIR}/tools"
	git clone --depth=1 https://github.com/emscripten-core/emsdk.git "${EMSDK_DIR}"
fi

cd "${EMSDK_DIR}"

./emsdk install latest
./emsdk activate latest

echo "Emscripten installed. Source ${EMSDK_DIR}/emsdk_env.sh or set EMSDK_ENV=${EMSDK_DIR}/emsdk_env.sh"
