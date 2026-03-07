<!--
SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>

SPDX-License-Identifier: ISC
-->

# Contributing to phasm

## Prerequisites

Install the following system packages (Debian/Ubuntu):

```sh
apt-get install -y build-essential autoconf bison re2c libonig-dev cmake wget pkg-config python3 git curl zip
```

## Building from Source

The build is split into sequential scripts. Run them in order:

```sh
./scripts/setup.sh           # Install the Emscripten SDK
./scripts/fetch.sh           # Download PHP and dependency sources
./scripts/apply-patches.sh   # Patch PHP for Emscripten compatibility
./scripts/deps.sh            # Build C libraries (zlib, libzip, iconv, oniguruma, sqlite)
./scripts/build.sh           # Compile PHP to WebAssembly
```

Build output goes to `dist/` (`php.js` and `php.wasm`).

## Running the Web Demo Locally

```sh
composer install              # Create vendor/ for the demo's vendor.zip
./scripts/package-web.sh      # Copy artifacts into web/assets/
./scripts/run-local.sh        # Start a local server on port 8001
```

Then open `http://localhost:8001` in your browser.

## Project Structure

```
scripts/
  env.sh               # Shared environment variables and versions
  setup.sh             # Emscripten SDK installer
  fetch.sh             # Source downloader
  apply-patches.sh     # Patch applier
  deps.sh              # Dependency builder
  build.sh             # PHP WASM builder
  package-web.sh       # Web demo packager
  run-local.sh         # Local dev server

patches/               # Emscripten compatibility patches for PHP
sources/               # Downloaded source trees (gitignored)
build/                 # Intermediate build artifacts (gitignored)
dist/                  # Final npm output (php.js + php.wasm)
web/                   # Live demo website
```

## Configuration

Build versions and compiler flags can be overridden with environment variables.
See `scripts/env.sh` for the full list:

| Variable               | Default                          | Description                 |
|------------------------|----------------------------------|-----------------------------|
| `PHP_VERSION`          | `8.5.0`                          | PHP version to build        |
| `ZLIB_VERSION`         | `1.2.11`                         | zlib version                |
| `LIBZIP_VERSION`       | `1.9.2`                          | libzip version              |
| `LIBICONV_VERSION`     | `1.16`                           | libiconv version            |
| `SQLITE_AMALG_VERSION` | `3380500`                        | SQLite amalgamation version |
| `ONIGURUMA_VERSION`    | `6.9.4`                          | Oniguruma version           |
| `EMCC_FLAGS`           | `-O2 -s EXPORT_NAME='Phasm' ...` | Emscripten compiler flags   |

## Enabling PHP Extensions

Extensions are toggled in `scripts/build.sh` via `configure` flags. To add an
extension, add the corresponding `--enable-*` or `--with-*` flag. Extensions
that depend on C libraries also need their dependency built in `scripts/deps.sh`.

## Adding Patches

Place patch files in `patches/php-<version>/`. They are applied in
alphabetical order by `scripts/apply-patches.sh`.

## License

By contributing, you agree that your contributions will be licensed under the
[ISC License](LICENSE).
