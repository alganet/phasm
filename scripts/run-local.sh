#!/usr/bin/env bash

# SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>
#
# SPDX-License-Identifier: ISC

set -euo pipefail

source "$(dirname "$0")/env.sh"

"${ROOT_DIR}/scripts/package-web.sh"

# Not `python3 -m http.server`: it cannot set the cross-origin isolation headers
# SharedArrayBuffer needs, and it serves .wasm without the application/wasm MIME
# type. See scripts/serve.mjs.
exec node "${ROOT_DIR}/scripts/serve.mjs" --port 8001 "$@"