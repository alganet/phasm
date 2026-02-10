#!/usr/bin/env bash

# SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>
#
# SPDX-License-Identifier: ISC

set -euo pipefail

source "$(dirname "$0")/env.sh"

"${ROOT_DIR}/scripts/package-web.sh"

cd "${WEB_DIR}"

echo "Serving ${WEB_DIR} at http://localhost:8001"
python3 -m http.server 8001