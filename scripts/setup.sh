#!/usr/bin/env bash

# SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>
#
# SPDX-License-Identifier: ISC

set -euo pipefail

source "$(dirname "$0")/env.sh"

EMSDK_DIR="${ROOT_DIR}/build/emsdk"

if [[ ! -d "${EMSDK_DIR}/.git" ]]; then
	mkdir -p "${ROOT_DIR}/tools"
	git clone --depth=1 https://github.com/emscripten-core/emsdk.git "${EMSDK_DIR}"
fi

cd "${EMSDK_DIR}"

# Install if not installed
if ! ./emsdk list | grep -q 'latest.*(installed)'; then
	./emsdk install latest
fi
# Activate if not activated
if ! ./emsdk list | grep -q 'latest.*(active)'; then
	./emsdk activate latest
fi

echo "Emscripten installed. Source ${EMSDK_DIR}/emsdk_env.sh or set EMSDK_ENV=${EMSDK_DIR}/emsdk_env.sh"
