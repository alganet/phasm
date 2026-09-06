<!--
SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>

SPDX-License-Identifier: ISC
-->

# Contributing to phasm

## Prerequisites

Install the following system packages (Debian/Ubuntu):

```sh
apt-get install -y build-essential autoconf bison re2c libonig-dev cmake wget pkg-config perl python3 git curl zip
```

## Building from Source

The build is split into sequential scripts. Run them in order:

```sh
./scripts/setup.sh           # Install the pinned Emscripten SDK
./scripts/fetch.sh           # Download and verify PHP and dependency sources
./scripts/apply-patches.sh   # Patch PHP for Emscripten compatibility
./scripts/deps.sh            # Build C libraries (zlib, libzip, iconv, oniguruma, sqlite, libxml2, openssl)
./scripts/build.sh           # Compile PHP to WebAssembly
npm test                     # Verify the result actually runs PHP
```

Build output goes to `dist/` (`php.js`, `php.wasm` and `php.d.ts`).

## Testing

```sh
npm test
```

`node --test` against `dist/`, so build first. The suite skips itself with a
diagnostic rather than failing if there is no build yet.

It tests the *build*, not PHP: that the interpreter runs, that every extension
the README advertises is actually linked in, that the virtual filesystem
round-trips (including binary content), that stdin/stdout/stderr and exit codes
behave, that a fatal error is loud, and that the wasm carries no debug info.
Those are the things a dependency bump or a changed `configure` flag can quietly
break — the last one triples the download while every other test still passes.

`test/sapi.test.mjs` covers the other half: the embedding contract that
`sapi/phasm` exists to provide — 200 calls on one instance, per-call exit codes,
errors on stderr, per-call cwd and env, and no state carried between calls.

`test/server.test.mjs` covers server mode — routing, `header()`, status codes
and the superglobals. Those tests are mostly about proving PHP's own request
machinery is doing the work, since the alternative to a real request cycle is
faking `$_SERVER` and hoping.

`test/mount.test.mjs` covers `mountStore()` — PHP reading and writing a store it
does not own. It needs the optional ZenFS peers, so run `npm ci` first; without
them that suite skips with a diagnostic and the rest of the suite still runs, on
a checkout with no `node_modules` at all.

`test/interrupt.test.mjs` is the only suite that runs a **real shell**: busybox
ash from `wasi-sh`, a dev dependency, on a thread of its own, with `php` wired
in as a host builtin by hand. It is the one place ^C into a running script can
be proved, because the answer has to come off a `SharedArrayBuffer` the two
threads share — while `php -r 'while (true);'` runs, the shell's thread is one
synchronous `_start()` frame and a `postMessage` into it is not slow, it is
undelivered. Every case is bounded: a ^C that is not delivered is a hang, and a
test that hangs reports nothing at all.

`test/resolve-oracle.test.mjs` is the differential one: `src/resolve.mjs`
against `sapi/phasm/phasm.c`, the SAPI that specifies it, over one corpus of 44
cases. The router is a port, so the C is the oracle and this is what keeps the
two from drifting.

`test/contract.test.mjs` boots nothing at all, deliberately: it holds a runtime
that is **not** PHP to `assertRunRuntime()` and `assertServeRuntime()`, which is
the claim `src/contract.mjs` makes. Its other half — the same toy runtime driven
through a real shell builtin and a real request wire — lives in
[`wide`](https://github.com/alganet/wide), which owns both consumers.

The whole suite shares ONE module instance (`test/helper.mjs`), which is itself
the regression test: through the stock CLI's `main()` the same suite would latch
its exit status on the first non-zero one and stop working entirely at call
~104. `fresh: true` opts a test out.

## Pinning and reproducibility

Everything the build downloads is pinned to a version **and** a SHA-256 in
`scripts/env.sh`, and `fetch.sh` refuses to continue on a mismatch. When you
bump a version you must bump its hash in the same commit:

```sh
shasum -a 256 sources/<file>
```

The Emscripten SDK is pinned too (`EMSDK_VERSION`). This matters more than it
looks: `emsdk install latest` resolves to whatever shipped most recently, and
by the time the pin was introduced `latest` had already moved to a major
version where this build no longer links. An unpinned toolchain means a build
that worked last month breaks with no commit to blame.

## Running the Web Demo Locally

```sh
composer install              # Create vendor/ for the demo's vendor.zip
./scripts/run-local.sh        # Package artifacts and serve on port 8001
```

That install is from a committed lock, so it is deterministic and says "Nothing
to install" without touching the network once `vendor/` is there.

**It resolves against the host, and the guest checks it.** The platform trap
below is exactly this: `composer install` ran on a machine whose PHP has
extensions this build does not, and `test/php.test.mjs` is what turns that into
a failure with a name — it reads `composer.json`'s `config.platform` and its
`lib-*` pins and compares them against what the wasm actually reports.

Then open `http://localhost:8001` in your browser.

`run-local.sh` uses `scripts/serve.mjs` rather than `python3 -m http.server`,
which cannot set response headers — it could not send the cross-origin
isolation headers `SharedArrayBuffer` needs, and it served `.wasm` without the
`application/wasm` MIME type `WebAssembly.compileStreaming` requires.

Cross-origin isolation is **off** by default, matching GitHub Pages, which
cannot send those headers either. Pass `--coi` to preview the isolated world
and see which cross-origin assets stop loading under it.

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

  serve.mjs            # Static dev server (headers + correct MIME types)

patches/               # Emscripten compatibility patches for PHP
sapi/phasm/            # The re-entrant SAPI, copied into php-src at build time
src/                   # Hand-written package sources (the JS halves, types, contract, router, mount)
test/                  # Test suite (node --test)
sources/               # Downloaded source trees (gitignored)
build/                 # Intermediate build artifacts (gitignored)
dist/                  # Final npm output (php.js + php.wasm + the .d.ts, contract, resolve and mount)
web/                   # Live demo website
```

## Configuration

Build versions and compiler flags can be overridden with environment variables.
See `scripts/env.sh` for the full list:

| Variable               | Default                          | Description                 |
|------------------------|----------------------------------|-----------------------------|
| `EMSDK_VERSION`        | `5.0.2`                          | Emscripten SDK version      |
| `PHP_VERSION`          | `8.5.9`                          | PHP version to build        |
| `ZLIB_VERSION`         | `1.3.2`                          | zlib version                |
| `LIBZIP_VERSION`       | `1.11.4`                         | libzip version              |
| `LIBICONV_VERSION`     | `1.19`                           | libiconv version            |
| `SQLITE_AMALG_VERSION` | `3530400`                        | SQLite amalgamation version |
| `ONIGURUMA_VERSION`    | `6.9.10`                         | Oniguruma version           |
| `LIBXML2_VERSION`      | `2.15.3`                         | libxml2 version             |
| `OPENSSL_VERSION`      | `3.5.7`                          | OpenSSL version (LTS series)|
| `EMCC_FLAGS`           | `-O2 -g0 -s EXPORT_NAME='Phasm' ...` | Emscripten codegen flags |
| `PHASM_STACK_SIZE`     | `8MB`                            | C stack for the module      |

Overriding `EMCC_FLAGS` replaces the codegen defaults only. The flags that
make the artifact a phasm build — the exported entry points, the two JS halves,
`INVOKE_RUN=0` and the stack size — are appended afterwards and cannot be
dropped by an override, because a module without them has no `run()` to call or
no first call to make.

`-g0` is in the defaults for size, not tidiness: PHP's own configure puts `-g`
in `CFLAGS`, and the DWARF that produces was two thirds of the shipped wasm —
and made emcc skip its post-link optimizations on top ("running limited
binaryen optimizations because DWARF info requested"). Drop it back in with
`EMCC_FLAGS="-O0 -g ..."` when you need to debug the C.

The halves are not interchangeable. `src/phasm-stdio.js` goes in with
`--pre-js`, which lands before the runtime starts: the only moment fd 0, 1 and
2 can still be claimed, and therefore the only way `run()` can hand back what
one call printed. `src/phasm-glue.js` goes in with `--post-js`, which lands
after it, when the exported entry points it marshals into exist.

## Enabling PHP Extensions

Extensions are toggled in `scripts/build.sh` via `configure` flags. To add an
extension, add the corresponding `--enable-*` or `--with-*` flag. Extensions
that depend on C libraries also need their dependency built in `scripts/deps.sh`.

Where PHP detects that library with `PKG_CHECK_MODULES` — zlib, sqlite, libxml2,
openssl — `build.sh` also exports a `<MODULE>_CFLAGS`/`<MODULE>_LIBS` pair, because
pkg-config's convention is that a preset pair short-circuits the probe. Without
it a cross build asks the *host's* pkg-config about the *host's* library, and
the answer is a host include path plus a bare `-l`, which the sysroot on the
link path can then satisfy with a different version than the headers describe.

OpenSSL is the one dependency that does not build through autotools or CMake.
Its Perl configuration system takes a target name rather than guessing one, and
`linux-generic32` is the honest description of what emcc compiles for. It also
needs `--cross-compile-prefix=` passed empty: `emconfigure` exports both an
absolute `CC` and a `CROSS_COMPILE` prefix, on the GNU convention that a build
system forms one from the other, and OpenSSL honours both — so without it every
compile shells out to the two concatenated and fails as `not found`.

## The Composer platform pin

Composer runs on the **host**, never in the guest. The pipeline is: a host
`composer install` produces `vendor/`, `composer.json`'s `post-install-cmd`
zips it into `web/assets/vendor.zip`, and the guest expands that archive and
`require`s the autoloader — `web/assets/main.php` is the worked example.

That means Composer resolves against a platform that is **not the one the code
will run on**. A full host PHP has extensions this build does not, so a
transitive dependency requiring `ext-curl` or `ext-sodium` resolves green,
ships inside `vendor.zip`, and fails in the guest at run time — far from the
install that chose it, and with nothing pointing back at Composer.

`config.platform` in `composer.json` is the fix. It describes phasm to the
resolver: this build's PHP version, every extension it has at the version it
reports, every extension it does **not** have set to `false`, and the `lib-*`
versions of the C libraries `scripts/env.sh` pins. A dependency that needs
something missing then fails at resolve time, naming it:

```
Root composer.json requires PHP extension ext-curl * but the ext-curl package
is disabled by your platform config.
```

Two things follow for anyone changing the extension list:

- **Adding an extension is a two-file change.** The `configure` flag in
  `scripts/build.sh` and the entry in `composer.json` — flip it from `false` to
  the version the binary reports, or add it if it is not listed. Three tests in
  `test/php.test.mjs` compare the pin against the built artifact in both
  directions and fail if the two disagree, so this cannot drift silently; it is
  still a two-file change.
- **`config.platform` is an override layer, not an allowlist.** Listing what
  this build *has* is not enough — Composer still sees the host's real
  extensions for anything undeclared, which is why absent ones are spelled out
  as `false` rather than left out. The list is the extensions php-src bundles
  plus the widely-required PECL ones; it is finite by construction and not
  exhaustive, so an exotic requirement can still slip through to the host.

## Adding Patches

Place patch files in `patches/php-<version>/`. They are applied in
alphabetical order by `scripts/apply-patches.sh`.

## License

By contributing, you agree that your contributions will be licensed under the
[ISC License](LICENSE).
