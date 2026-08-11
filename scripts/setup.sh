#!/usr/bin/env bash

# SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>
#
# SPDX-License-Identifier: ISC

set -euo pipefail

source "$(dirname "$0")/env.sh"

EMSDK_DIR="${ROOT_DIR}/build/emsdk"

if [[ ! -d "${EMSDK_DIR}/.git" ]]; then
	git clone --depth=1 https://github.com/emscripten-core/emsdk.git "${EMSDK_DIR}"
fi

cd "${EMSDK_DIR}"

# emsdk itself has to be current enough to know the pinned SDK version.
git fetch --depth=1 origin main >/dev/null 2>&1 && git checkout -q FETCH_HEAD

# Install and activate an EXACT version. `emsdk install latest` resolves to
# whatever shipped most recently, so two runs a month apart get two different
# compilers and a build can break with no commit to blame.
echo "Installing Emscripten ${EMSDK_VERSION}..."
./emsdk install "${EMSDK_VERSION}"
./emsdk activate "${EMSDK_VERSION}"

# Fail loudly rather than silently building with the wrong toolchain.
source ./emsdk_env.sh >/dev/null 2>&1
ACTUAL_VERSION="$(emcc --version | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
if [[ "${ACTUAL_VERSION}" != "${EMSDK_VERSION}" ]]; then
	echo "emcc reports ${ACTUAL_VERSION}, expected ${EMSDK_VERSION}" >&2
	exit 1
fi

echo "Emscripten ${EMSDK_VERSION} installed. Source ${EMSDK_DIR}/emsdk_env.sh or set EMSDK_ENV=${EMSDK_DIR}/emsdk_env.sh"
