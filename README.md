<!--
SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>

SPDX-License-Identifier: ISC
-->

# PHP 8.5 → WebAssembly

    npm install @alganet/phasm

## Compilation Instructions

- `apt-get install -y build-essential autoconf bison re2c libonig-dev cmake wget pkg-config python3 git curl zip` or equivalent.
- `./scripts/setup.sh` - Setup tools
- `./scripts/fetch.sh` - Fetch source for PHP and dependencies
- `./scripts/apply-patches.sh` - Apply PHP patches for emscripten
- `./scripts/deps.sh` - Build dependencies
- `./scripts/build.sh` - Build PHP itself
- `composer install` - Creates `vendor` folder used for `vendor.zip` (browser composer dir)
- `./scripts/package-web.sh` - Packages for the local web demo
- `./scripts/run-local.sh` - Runs locally

