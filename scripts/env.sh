#!/usr/bin/env bash

# SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>
#
# SPDX-License-Identifier: ISC

set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
PHP_VERSION="${PHP_VERSION:-8.5.9}"
PHP_GIT_REF="${PHP_GIT_REF:-php-${PHP_VERSION}}"

SOURCES_DIR="${ROOT_DIR}/sources"
PHP_SRC_DIR="${SOURCES_DIR}/php-src"
BUILD_DIR="${ROOT_DIR}/build/php-wasm"
DIST_DIR="${ROOT_DIR}/dist"
WEB_DIR="${ROOT_DIR}/web"
PATCH_DIR="${ROOT_DIR}/patches/php-${PHP_VERSION}"

# Every dependency is pinned to a version AND a SHA-256. fetch.sh verifies each
# download against the hash and fails hard on mismatch — the tarballs come off
# the public internet through fallback URL chains, and without this a mirror
# swap or a hijacked release is invisible. When you bump a version you MUST bump
# its hash in the same commit; `shasum -a 256 sources/<file>` prints it.
ZLIB_VERSION="${ZLIB_VERSION:-1.3.2}"
ZLIB_SHA256="${ZLIB_SHA256:-bb329a0a2cd0274d05519d61c667c062e06990d72e125ee2dfa8de64f0119d16}"
LIBZIP_VERSION="${LIBZIP_VERSION:-1.11.4}"
LIBZIP_SHA256="${LIBZIP_SHA256:-8a247f57d1e3e6f6d11413b12a6f28a9d388de110adc0ec608d893180ed7097b}"
LIBICONV_VERSION="${LIBICONV_VERSION:-1.19}"
LIBICONV_SHA256="${LIBICONV_SHA256:-88dd96a8c0464eca144fc791ae60cd31cd8ee78321e67397e25fc095c4a19aa6}"
# SQLite amalgamation (used by ext/sqlite3 / pdo_sqlite)
SQLITE_AMALG_VERSION="${SQLITE_AMALG_VERSION:-3530400}"
SQLITE_AMALG_YEAR="${SQLITE_AMALG_YEAR:-2026}"
SQLITE_SHA256="${SQLITE_SHA256:-1e71ddf93849c6a6ecf58b827c0692073d2dd7ee40196158068f7b29f422e87d}"
# Oniguruma (used by ext/mbstring). Upstream names its release asset
# `onig-X.Y.Z.tar.gz`; fetch.sh used to ask for `oniguruma-X.Y.Z.tar.gz`, which
# 404s, so it silently fell back to GitHub's auto-generated source archive —
# whose bytes are not a stable artifact to pin a hash against.
ONIGURUMA_VERSION="${ONIGURUMA_VERSION:-6.9.10}"
ONIGURUMA_SHA256="${ONIGURUMA_SHA256:-2a5cfc5ae259e4e97f86b68dfffc152cdaffe94e2060b770cb827238d769fc05}"
# libxml2 (used by ext/libxml, and therefore by dom, simplexml, xml and
# xmlwriter). 2.15 is the series upstream still fixes: 2.14's last release is
# 2.14.6 from Sep 2025, which predates the five CVE fixes in 2.15.2 and the
# five in 2.15.3. It is also the series that REMOVED the built-in HTTP client
# and LZMA support — neither reachable from a wasm build, both otherwise dead
# weight in the download.
#
# php-src's LIBXML_VERSION guards stop at 21400, so 2.15 is newer than anything
# ext/libxml explicitly knows about. The only thing php-src names that 2.15
# removed is xmlNanoHTTP*, and only in php_libxml2.def, a Windows-only export
# list this build never reads.
#
# The download path is derived from the version: 2.15.3 lives under 2.15/.
LIBXML2_VERSION="${LIBXML2_VERSION:-2.15.3}"
LIBXML2_SHA256="${LIBXML2_SHA256:-78262a6e7ac170d6528ebfe2efccdf220191a5af6a6cd61ea4a9a9a5042c7a07}"

# Pin the Emscripten SDK. `emsdk install latest` moves under you: every CI run
# and every contributor gets whatever shipped most recently, so a build that
# worked last month breaks with no commit to blame — and that is not
# hypothetical here. This tree last built under 5.0.2 (Feb 2026); by the time
# the pin was added, `latest` had moved to 6.0.6, where PHP's libtool `-fPIC`
# objects now produce R_WASM_TABLE_INDEX_SLEB relocations that need MAIN_MODULE,
# and the link fails outright. Anyone cloning and running setup.sh was getting a
# broken build. Moving to 6.x is a deliberate migration, not a default.
EMSDK_VERSION="${EMSDK_VERSION:-5.0.2}"

DEFAULT_EMSDK_ENV="${ROOT_DIR}/build/emsdk/emsdk_env.sh"
if [[ -z "${EMSDK_ENV:-}" && -f "${DEFAULT_EMSDK_ENV}" ]]; then
	EMSDK_ENV="${DEFAULT_EMSDK_ENV}"
else
	EMSDK_ENV="${EMSDK_ENV:-}"
fi
# Codegen and packaging knobs. Override these to experiment (`-O0 -g` for a
# debuggable build). `-Oz` and `-flto` were both measured against `-O2` and
# neither earns its place: `-Oz` takes 1.6% off the gzipped wasm for 2.4% of the
# interpreter's throughput, and `-flto` makes the wasm 8% *bigger* here for no
# runtime gain at all.
#
# `-g0` is load-bearing, not tidiness. PHP's configure puts `-g` in CFLAGS, so
# every object carried DWARF into the link and the shipped wasm was two thirds
# debug info: 35.3 MB where 12.0 MB is the code. Worse, emcc says so and gives
# up — "running limited binaryen optimizations because DWARF info requested" —
# because the post-link optimizer cannot keep line tables honest across the
# transforms it wants to make. So the debug info was costing size twice: its own
# bulk, and the optimization it suppressed. It is also the figure that gates the
# demo, since gzipped is what a first-time visitor downloads.
#
# `ENVIRONMENT` drops the runtime detection for targets this build has no story
# for. `node` stays: the suite and CI run there, and a build nobody can test is
# the one thing worse than a slightly larger one.
EMCC_FLAGS="${EMCC_FLAGS:--O2 -g0 -s MODULARIZE=1 -s EXPORT_NAME='Phasm' -s ENVIRONMENT=web,worker,node -s ALLOW_MEMORY_GROWTH=1 -s NO_EXIT_RUNTIME=1}"

# The C stack, which is not the same stack as the one a runaway PHP recursion
# hits. Emscripten's default is 64 KiB — sized for a program that keeps its data
# on the heap, which PHP mostly does, and overflowing it is silent memory
# corruption rather than a diagnosable crash. PHP's own guard against that
# (ZEND_CHECK_STACK_LIMIT) is compiled out here: configure detects it by running
# a probe, and a cross build cannot run one. So this is the only line of defence
# there is, and it is cheap — address space in a module that already reserves
# ~15 MB for static data.
PHASM_STACK_SIZE="${PHASM_STACK_SIZE:-4MB}"

# The embedding ABI, appended AFTER any override rather than living inside it:
# a build without phasm_run and the glue that marshals into it is not a phasm
# build, and overriding EMCC_FLAGS for an unrelated experiment should not
# silently produce one. EXPORTED_FUNCTIONS replaces the default ['_main']
# outright, so _main has to be named here or callMain() disappears with it;
# _malloc/_free are what src/phasm-glue.js allocates its packed argv through.
#
# The two JS halves are not interchangeable. --pre-js lands before the runtime
# starts, which is the only moment the standard streams can still be claimed;
# --post-js lands after it, which is the only moment the exported functions
# exist. src/phasm-stdio.js needs the first and src/phasm-glue.js the second.
#
# INVOKE_RUN=0 belongs here for the same reason phasm_run does. A module that
# runs main() on its own has spent the one entry point that ends in exit(), and
# every phasmRun() afterwards refuses — so `await Phasm()` with no options used
# to produce an instance that could not run PHP, and the fix was a `noInitialRun`
# flag the embedder had to know to pass. The build knows. STACK_SIZE rides along
# because a phasm build on the 64 KiB default is one deep C recursion away from
# overwriting memory with nothing to show for it; PHASM_STACK_SIZE above is the
# knob for experimenting with it.
EMCC_ABI_FLAGS="-s INVOKE_RUN=0 -s STACK_SIZE=${PHASM_STACK_SIZE} -s EXPORTED_RUNTIME_METHODS=['FS','callMain','stringToNewUTF8','UTF8ToString','HEAPU8'] -s EXPORTED_FUNCTIONS=['_main','_phasm_startup','_phasm_run','_phasm_is_started','_phasm_handle_request','_phasm_response_status','_phasm_response_headers','_phasm_response_body','_phasm_response_body_length','_malloc','_free'] --pre-js ${ROOT_DIR}/src/phasm-stdio.js --post-js ${ROOT_DIR}/src/phasm-glue.js"
EMCC_FLAGS="${EMCC_FLAGS} ${EMCC_ABI_FLAGS}"
