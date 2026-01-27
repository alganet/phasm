<!--
SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>

SPDX-License-Identifier: ISC
-->

# PHP 8.5 → WebAssembly

## Quickstart

- `apt-get install -y build-essential bison re2c libonig-dev cmake`
  or equivalent.
- ./scripts/setup-emsdk.sh
- ./scripts/fetch.sh
- ./scripts/apply-patches.sh
- ./scripts/build.sh
- ./scripts/package-web.sh
- ./scripts/run-local.sh

## Config

- PHP_VERSION (default: 8.5.0)
- PHP_GIT_REF (default: php-<version>)
- EMSDK_ENV (path to emsdk_env.sh)
- EMCC_FLAGS (extra emcc flags for final link)
