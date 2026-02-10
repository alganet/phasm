<!--
SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>

SPDX-License-Identifier: ISC
-->

# PHP 8.5 → WebAssembly

    npm install @alganet/phasm

## Compilation Instructions

- `apt-get install -y build-essential bison re2c libonig-dev cmake wget pkg-config php-cli git curl` or equivalent.
- ./scripts/setup.sh
- ./scripts/fetch.sh
- ./scripts/apply-patches.sh
- ./scripts/deps.sh
- ./scripts/build.sh
- `composer install`
- ./scripts/package-web.sh
- ./scripts/run-local.sh

