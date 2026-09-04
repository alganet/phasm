#!/usr/bin/env bash

# SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>
#
# SPDX-License-Identifier: ISC

set -euo pipefail

# Cross-build libzip for Emscripten and install into build sysroot
# Usage: source env.sh first to get BUILD_DIR etc

source "$(dirname "$0")/env.sh"

# If EMSDK env helper is set, source it so emcmake/emmake are on PATH
if [[ -n "${EMSDK_ENV:-}" && -f "${EMSDK_ENV}" ]]; then
	source "${EMSDK_ENV}"
fi

# Defaults
SRC_DIR="${SOURCES_DIR}"
SYSROOT_DIR="${BUILD_DIR}/sysroot"
LIBZIP_TAR="libzip-${LIBZIP_VERSION}.tar.xz"

# Every library built through CMake below needs these, and needs them stated:
# emcmake leaves CMAKE_BUILD_TYPE empty, CMake then passes no -O flag at all,
# and the library compiles at -O0. Nothing downstream can recover that — the
# PHP objects are compiled separately and the link only sees what the archive
# already contains — so libzip and oniguruma shipped unoptimized inside an
# artifact whose size gates the whole demo, with no warning anywhere.
#
# -O2 rather than Release's own -O3, to match what the PHP objects are built
# with (EMCC_FLAGS in scripts/env.sh, where -O2 is a measured choice).
CMAKE_OPT_FLAGS=(-DCMAKE_BUILD_TYPE=Release -DCMAKE_C_FLAGS_RELEASE="-O2 -DNDEBUG")

mkdir -p "${SRC_DIR}" "${SYSROOT_DIR}"
pushd "${SRC_DIR}" >/dev/null

# libzip source should be prepared by ./scripts/fetch.sh
if [[ ! -d "${SRC_DIR}/libzip-${LIBZIP_VERSION}" ]]; then
    if [[ -f "${SRC_DIR}/${LIBZIP_TAR}" ]]; then
        echo "Extracting libzip into ${SRC_DIR}..."
        tar -xf "${SRC_DIR}/${LIBZIP_TAR}" -C "${SRC_DIR}"
    else
        echo "libzip source not found in ${SRC_DIR}. Run ./scripts/fetch.sh to download sources." >&2
        exit 1
    fi
fi

# Ensure zlib (WASM) is available in sysroot since libzip requires it
ZLIB_TAR="zlib-${ZLIB_VERSION}.tar.gz"
if [[ ! -d "${SRC_DIR}/zlib-${ZLIB_VERSION}" ]]; then
    if [[ -f "${SRC_DIR}/${ZLIB_TAR}" && -s "${SRC_DIR}/${ZLIB_TAR}" ]]; then
        echo "Extracting zlib into ${SRC_DIR}..."
        tar -xf "${SRC_DIR}/${ZLIB_TAR}" -C "${SRC_DIR}"
    else
        echo "zlib source not found in ${SRC_DIR}. Run ./scripts/fetch.sh to download sources." >&2
        exit 1
    fi
fi
if [[ ! -f "${SYSROOT_DIR}/lib/libz.a" ]]; then
    echo "Building zlib for WASM..."
    pushd "${SRC_DIR}/zlib-${ZLIB_VERSION}" >/dev/null
    emconfigure ./configure --prefix="${SYSROOT_DIR}"
    # Build; some example/shared link steps may fail under emscripten, so continue
    emmake make -j"$(nproc)" || true

    # Manual install of static lib and headers if `make install` fails
    mkdir -p "${SYSROOT_DIR}/lib" "${SYSROOT_DIR}/include"
    if [[ -f libz.a ]]; then
        cp libz.a "${SYSROOT_DIR}/lib/"
    fi
    if [[ -f zlib.h ]]; then
        cp zlib.h "${SYSROOT_DIR}/include/"
    fi
    if [[ -f zconf.h ]]; then
        cp zconf.h "${SYSROOT_DIR}/include/"
    fi

    # Try 'make install' if it works
    emmake make install || true

    popd >/dev/null
fi

# libiconv (GNU libiconv)
LIBICONV_TAR="libiconv-${LIBICONV_VERSION}.tar.gz"
if [[ ! -d "${SRC_DIR}/libiconv-${LIBICONV_VERSION}" ]]; then
    if [[ -f "${SRC_DIR}/${LIBICONV_TAR}" ]]; then
        echo "Extracting libiconv into ${SRC_DIR}..."
        tar -xf "${SRC_DIR}/${LIBICONV_TAR}" -C "${SRC_DIR}"
    else
        echo "libiconv source not found in ${SRC_DIR}. Run ./scripts/fetch.sh to download sources." >&2
        exit 1
    fi
fi
if [[ ! -f "${SYSROOT_DIR}/lib/libiconv.a" ]]; then
    echo "Building libiconv for WASM..."
    pushd "${SRC_DIR}/libiconv-${LIBICONV_VERSION}" >/dev/null
    # Use emconfigure/emmake to cross-build statically
    emconfigure ./configure --prefix="${SYSROOT_DIR}" --disable-shared
    emmake make -j"$(nproc)" || true

    # Try install
    emmake make install || true
    popd >/dev/null
fi

# oniguruma (used by PHP ext/mbstring)
# If sources/oniguruma was populated by fetch.sh (git clone), build and install it
if [[ -d "${SRC_DIR}/oniguruma" && ! -f "${SYSROOT_DIR}/lib/libonig.a" ]]; then
    echo "Building oniguruma for WASM..."
    pushd "${SRC_DIR}/oniguruma" >/dev/null

    # Prepare build system only if configure is missing (release tarballs already include it)
    if [[ ! -f configure && -f autogen.sh ]]; then
        echo "Running autogen.sh to generate configure (git clone detected)"
        ./autogen.sh || true
    fi
    # Prefer CMake build if available (avoids autotools/tooling differences)
    if [[ -f CMakeLists.txt ]]; then
        echo "oniguruma: building with CMake"
        mkdir -p build && pushd build >/dev/null
        emcmake cmake .. -DCMAKE_INSTALL_PREFIX="${SYSROOT_DIR}" "${CMAKE_OPT_FLAGS[@]}" -DBUILD_SHARED_LIBS=OFF
        emmake make -j"$(nproc)"
        emmake make install || true
        popd >/dev/null
    else
        if [[ -f configure ]]; then
            emconfigure ./configure --prefix="${SYSROOT_DIR}" --disable-shared || true
        else
            echo "oniguruma: no configure script found; attempting autoreconf..."
            autoreconf -i || true
            emconfigure ./configure --prefix="${SYSROOT_DIR}" --disable-shared || true
        fi

        emmake make -j"$(nproc)" || true
        emmake make install || true
    fi
    popd >/dev/null
fi

# SQLite (build amalgamation into sysroot so PHP --with-sqlite3 / --with-pdo-sqlite work)
SQLITE_ZIP="sqlite-amalgamation-${SQLITE_AMALG_VERSION}.zip"
if [[ ! -d "${SRC_DIR}/sqlite-amalgamation-${SQLITE_AMALG_VERSION}" ]]; then
    if [[ -f "${SRC_DIR}/${SQLITE_ZIP}" ]]; then
        echo "Extracting SQLite amalgamation into ${SRC_DIR}..."
        mkdir -p "${SRC_DIR}/sqlite-amalgamation-${SQLITE_AMALG_VERSION}"
        unzip -q "${SRC_DIR}/${SQLITE_ZIP}" -d "${SRC_DIR}/sqlite-amalgamation-${SQLITE_AMALG_VERSION}" || true
        # unzip may create a nested directory; normalize by moving files if needed
        if [[ -d "${SRC_DIR}/sqlite-amalgamation-${SQLITE_AMALG_VERSION}/sqlite-amalgamation-${SQLITE_AMALG_VERSION}" ]]; then
            mv "${SRC_DIR}/sqlite-amalgamation-${SQLITE_AMALG_VERSION}/sqlite-amalgamation-${SQLITE_AMALG_VERSION}"/* "${SRC_DIR}/sqlite-amalgamation-${SQLITE_AMALG_VERSION}/" || true
        fi
    else
        echo "sqlite-amalgamation-${SQLITE_AMALG_VERSION} not found in ${SRC_DIR}. Run ./scripts/fetch.sh to download sources." >&2
        exit 1
    fi
fi

# Build a tiny static libsqlite3.a for WASM and install into sysroot
if [[ ! -f "${SYSROOT_DIR}/lib/libsqlite3.a" ]]; then
    echo "Building sqlite3 (amalgamation) for WASM..."
    pushd "${SRC_DIR}/sqlite-amalgamation-${SQLITE_AMALG_VERSION}" >/dev/null

    # Compile the amalgamation into an object and archive into static lib
    emcc -c sqlite3.c -Os -fPIC -DSQLITE_CORE -DSQLITE_THREADSAFE=0 -o sqlite3.o || true
    if command -v emar >/dev/null 2>&1; then
        emar rcs libsqlite3.a sqlite3.o || true
    else
        ar rcs libsqlite3.a sqlite3.o || true
    fi

    mkdir -p "${SYSROOT_DIR}/lib" "${SYSROOT_DIR}/include"
    if [[ -f libsqlite3.a ]]; then
        cp libsqlite3.a "${SYSROOT_DIR}/lib/"
    fi
    if [[ -f sqlite3.h ]]; then
        cp sqlite3.h "${SYSROOT_DIR}/include/"
    fi

    popd >/dev/null
fi

# libxml2 (ext/libxml, and through it dom, simplexml, xml and xmlwriter)
LIBXML2_TAR="libxml2-${LIBXML2_VERSION}.tar.xz"
if [[ ! -d "${SRC_DIR}/libxml2-${LIBXML2_VERSION}" ]]; then
    if [[ -f "${SRC_DIR}/${LIBXML2_TAR}" ]]; then
        echo "Extracting libxml2 into ${SRC_DIR}..."
        tar -xf "${SRC_DIR}/${LIBXML2_TAR}" -C "${SRC_DIR}"
    else
        echo "libxml2 source not found in ${SRC_DIR}. Run ./scripts/fetch.sh to download sources." >&2
        exit 1
    fi
fi
if [[ ! -f "${SYSROOT_DIR}/lib/libxml2.a" ]]; then
    echo "Building libxml2 for WASM..."
    pushd "${SRC_DIR}/libxml2-${LIBXML2_VERSION}" >/dev/null
    mkdir -p build && pushd build >/dev/null

    # Everything switched off below is either impossible in this target or
    # unreachable from PHP, and libxml2 is large enough that each one is real
    # download:
    #
    #   THREADS   this build is fork-free and single-threaded; the locking is
    #             pure overhead and drags in pthread stubs.
    #   MODULES   dlopen, which does not exist here.
    #   ZLIB      already off by default in 2.15, and 2.15 also made
    #             XML_PARSE_UNZIP mandatory for compressed input — a flag PHP
    #             never sets, so linking zlib in would buy nothing.
    #   CATALOG   resolves external identifiers through /etc/xml/catalog, a
    #             file no browser VFS has; nothing in php-src calls the
    #             catalog API.
    #   DEBUG     debugXML.c, xmlDebugDump* and the xmllint shell; php-src
    #             references none of it.
    #   ICU       an ICU-sized dependency for encodings iconv already covers.
    #
    # Everything left ON is surfaced by PHP: XPath and XPointer (XInclude
    # resolves an xpointer attribute through it), C14N (DOMNode::C14N), XSD and
    # RelaxNG validation, the writer (xmlwriter *is* the writer), HTML parsing
    # (DOMDocument::loadHTML) and SAX1 (the expat-compat layer in ext/xml).
    #
    # READER is the one that looks droppable and is not. ext/xmlreader is
    # deliberately not built, but ext/libxml/image_svg.c pulls SVG dimensions
    # with xmlTextReader — so switching it off would break getimagesize() on an
    # SVG, in ext/standard, nowhere near anything named XML.
    #
    # ICONV stays on and is deliberately not pointed at the sysroot's GNU
    # libiconv: Emscripten's libc carries musl's iconv, so find_package(Iconv)
    # finds it built in and libxml2 costs no extra library for non-UTF-8
    # documents. The two coexist in the final link because GNU libiconv only
    # ever defines libiconv_* symbols, never iconv_open.
    emcmake cmake .. \
        -DCMAKE_INSTALL_PREFIX="${SYSROOT_DIR}" \
        "${CMAKE_OPT_FLAGS[@]}" \
        -DBUILD_SHARED_LIBS=OFF \
        -DLIBXML2_WITH_PROGRAMS=OFF \
        -DLIBXML2_WITH_TESTS=OFF \
        -DLIBXML2_WITH_PYTHON=OFF \
        -DLIBXML2_WITH_THREADS=OFF \
        -DLIBXML2_WITH_MODULES=OFF \
        -DLIBXML2_WITH_ZLIB=OFF \
        -DLIBXML2_WITH_CATALOG=OFF \
        -DLIBXML2_WITH_DEBUG=OFF \
        -DLIBXML2_WITH_ICU=OFF \
        -DLIBXML2_WITH_ICONV=ON

    emmake make -j"$(nproc)"
    emmake make install
    popd >/dev/null
    popd >/dev/null
fi

# OpenSSL (ext/openssl). The only dependency here that does not build through
# autotools or CMake: OpenSSL has its own Perl configuration system, and the
# target name is the first thing to get right. There is no wasm target upstream,
# and `./config`'s guesser would ask uname about the HOST. `linux-generic32` is
# the honest description of what emcc compiles for — 32-bit pointers, no
# assembly, ILP32 with a 64-bit long long, which is exactly the `BN_LLONG`
# arithmetic that target selects.
OPENSSL_TAR="openssl-${OPENSSL_VERSION}.tar.gz"
if [[ ! -d "${SRC_DIR}/openssl-${OPENSSL_VERSION}" ]]; then
    if [[ -f "${SRC_DIR}/${OPENSSL_TAR}" ]]; then
        echo "Extracting OpenSSL into ${SRC_DIR}..."
        tar -xf "${SRC_DIR}/${OPENSSL_TAR}" -C "${SRC_DIR}"
    else
        echo "OpenSSL source not found in ${SRC_DIR}. Run ./scripts/fetch.sh to download sources." >&2
        exit 1
    fi
fi
if [[ ! -f "${SYSROOT_DIR}/lib/libssl.a" ]]; then
    # OpenSSL's Configure IS a Perl script, and so is every generator it drives.
    # Without perl the failure is `./Configure: not found` from a file that is
    # plainly there and executable, which names neither perl nor OpenSSL.
    if ! command -v perl >/dev/null 2>&1; then
        echo "perl not found — OpenSSL's configuration system is written in it. See CONTRIBUTING.md." >&2
        exit 1
    fi
    echo "Building OpenSSL for WASM..."
    pushd "${SRC_DIR}/openssl-${OPENSSL_VERSION}" >/dev/null

    # Everything switched off below is either impossible in this target or
    # unreachable from PHP. OpenSSL is the largest thing this build links, so
    # each one is real download:
    #
    #   asm          there is no wasm perlasm scheme; the target selects none
    #                anyway, and stating it stops a future target inheriting one.
    #   threads      fork-free and single-threaded. It also drops -pthread from
    #                the compile line, which under emcc is not a no-op — it
    #                switches on shared memory and would demand cross-origin
    #                isolation from every page that loads the artifact.
    #   shared/dso/  all four are dlopen. There is no dynamic loader here, and
    #   module/      no-dso is what keeps DSO_global_lookup out of the random
    #   engine       seeding path below.
    #   afalgeng     the Linux kernel crypto socket. linux-generic32 turns it ON
    #   devcryptoeng explicitly, so it has to be turned off explicitly.
    #   ktls         kernel TLS offload, a Linux sendmsg/setsockopt interface.
    #   apps/docs/   the `openssl` command, its manpages and the test suite. We
    #   tests        want two .a files and a header tree; the apps alone are
    #                several minutes of a build nothing here can execute.
    #   legacy       the legacy provider, which is not loaded unless somebody
    #                asks — and PHP's --with-openssl-legacy-provider defaults to
    #                no, so nothing in this build ever would.
    #   comp/zlib/   TLS-level compression. CRIME made it indefensible, OpenSSL
    #   zstd/brotli  disables it at run time regardless, and it is the one place
    #                a second zlib could sneak into the link.
    #   quic         PHP has no QUIC surface at all: no stream wrapper, no
    #                function, no constant.
    #   ui-console   reads a passphrase off a terminal through termios, which
    #                this shim does not implement. PHP passes its own password
    #                callback everywhere it can be prompted, so the console UI
    #                is only ever the fallback that would hang.
    #   secure-mem   an mmap'd, mlock'd arena for private keys. Under wasm there
    #                is one flat linear memory, nothing can be locked out of a
    #                core dump, and the API keeps working as a plain allocator.
    #
    # The last two groups are pure size, and were measured rather than assumed —
    # 64 KiB of the gzipped download between them, against 851 KiB for the
    # library as a whole. Worth taking, and worth knowing they are the small
    # half: what is left is BIGNUM, EVP, ASN.1, X.509, the providers and TLS,
    # and none of that is optional.
    #
    #   ml-dsa       the post-quantum algorithms new in 3.5. They are registered
    #   ml-kem       by the DEFAULT provider, so the linker cannot drop them, and
    #   slh-dsa      ext/openssl has no name for any of them. 44 KiB gzipped.
    #   cmp/ct/ts/   certificate management, certificate transparency, time
    #   srp/rfc3779/ stamping, TLS-SRP, IP-address certificate extensions, OCSP
    #   ocsp/http    and the HTTP client the last two use to fetch responders.
    #                Checked one by one against ext/openssl's sources: not a
    #                symbol from any of them is referenced. 20 KiB gzipped.
    #
    # -DL_ENDIAN because the generic target states no byte order and falls back
    # to the portable path; wasm is little-endian by specification, so this is a
    # known answer rather than an assumption.
    #
    # --with-rand-seed=devrandom, and it is the load-bearing choice. The default
    # is `os`, which is getrandom-then-devrandom, and the getrandom half cannot
    # work here: the weak-symbol probe for getentropy() is guarded on __ELF__,
    # which a wasm object is not, the DSO_global_lookup fallback is compiled out
    # by no-dso, and the syscall path is guarded on __linux. So `os` would spend
    # a failed probe per seed before falling through to exactly where this
    # points it. Emscripten's /dev/urandom is crypto.getRandomValues() in a
    # browser and randomBytes() under node — a real CSPRNG in both.
    #
    # OPENSSLDIR is a guest path, not the sysroot. It is compiled in as where
    # openssl.cnf and the CA bundle are looked for AT RUN TIME, inside the
    # module's filesystem; pointing it at the build machine's sysroot would bake
    # a path that exists on exactly one computer into every artifact.
    #
    # --cross-compile-prefix= (empty, and not droppable) is the one line here
    # that is not about OpenSSL at all. emconfigure exports BOTH an absolute
    # CC=<emsdk>/emcc and CROSS_COMPILE=<emsdk>/em, the second so that a build
    # system following the GNU convention can form ${CROSS_COMPILE}cc. OpenSSL
    # follows that convention AND honours CC, so it concatenates them and every
    # compile shells out to `<emsdk>/em<emsdk>/emcc` — which fails as `not
    # found` per object, naming a path nothing ever wrote down.
    emconfigure ./Configure linux-generic32 \
        --cross-compile-prefix= \
        --prefix="${SYSROOT_DIR}" \
        --openssldir=/usr/local/ssl \
        --libdir=lib \
        -O2 -DL_ENDIAN \
        --with-rand-seed=devrandom \
        no-asm \
        no-threads \
        no-shared \
        no-dso \
        no-module \
        no-engine \
        no-afalgeng \
        no-devcryptoeng \
        no-ktls \
        no-apps \
        no-docs \
        no-tests \
        no-legacy \
        no-comp \
        no-zlib \
        no-zstd \
        no-brotli \
        no-quic \
        no-ui-console \
        no-secure-memory \
        no-ml-dsa \
        no-ml-kem \
        no-slh-dsa \
        no-cmp \
        no-ct \
        no-ts \
        no-srp \
        no-rfc3779 \
        no-ocsp \
        no-http

    emmake make -j"$(nproc)" build_sw
    emmake make install_sw

    # And the config file, which `install_sw` does not install and
    # `install_ssldirs` would install to the HOST's --openssldir. PHP does not
    # treat it as optional: php_openssl_parse_config() ends in
    # NCONF_load(req_config, ...) and returns FAILURE when that file cannot be
    # read, so with no openssl.cnf anywhere, openssl_pkey_new(), openssl_csr_*
    # and everything else built on php_x509_request fail before doing any work
    # — reporting "error:8000002C:system library::No such file or directory",
    # an errno with no filename in it. Everything that takes its key as an
    # argument (encrypt, decrypt, digest, sign, verify) works regardless, which
    # is what makes the gap look random from PHP.
    #
    # Upstream's own apps/openssl.cnf, copied verbatim: it is the file a distro
    # package installs, so this build reads what every other PHP reads rather
    # than a policy we invented. It is embedded into the artifact at the guest
    # path libcrypto was compiled to look in — see EMCC_ABI_FLAGS in env.sh.
    mkdir -p "${SYSROOT_DIR}/ssl"
    cp apps/openssl.cnf "${SYSROOT_DIR}/ssl/openssl.cnf"
    popd >/dev/null
fi

pushd "libzip-${LIBZIP_VERSION}" >/dev/null
mkdir -p build
pushd build >/dev/null

# Use emcmake/emmake (provided by EMSDK) to configure and build
if ! command -v emcmake >/dev/null 2>&1; then
    echo "emcmake not found. Ensure EMSDK_ENV is set and emsdk is activated." >&2
    exit 1
fi

# emcmake wraps cmake; ensure cmake is installed on the host
if ! command -v cmake >/dev/null 2>&1; then
    echo "cmake not found. Install it (e.g. sudo apt-get install cmake) and re-run." >&2
    exit 1
fi

# Configure: disable shared libs (static only) and disable optional compressors
emcmake cmake .. \
    -DCMAKE_INSTALL_PREFIX="${SYSROOT_DIR}" \
    "${CMAKE_OPT_FLAGS[@]}" \
    -DBUILD_SHARED_LIBS=OFF \
    -DZLIB_LIBRARY="${SYSROOT_DIR}/lib/libz.a" \
    -DZLIB_INCLUDE_DIR="${SYSROOT_DIR}/include" \
    -DENABLE_ZLIB=ON \
    -DENABLE_BZIP2=OFF \
    -DENABLE_ZSTD=OFF \
    -DENABLE_LZMA=OFF

emmake make -j"$(nproc)"
emmake make install

popd >/dev/null
popd >/dev/null
popd >/dev/null

echo "libzip installed into ${SYSROOT_DIR}"