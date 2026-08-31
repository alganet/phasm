dnl SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>
dnl
dnl SPDX-License-Identifier: ISC

PHP_ARG_ENABLE([phasm],
  [for phasm SAPI build],
  [AS_HELP_STRING([--enable-phasm],
    [Enable building the re-entrant phasm SAPI (requires --disable-cli)])],
  [no],
  [no])

if test "$PHP_PHASM" != "no"; then
  dnl phasm.c includes sapi/cli/php_cli.c, so building both SAPIs compiles that
  dnl translation unit twice and the link fails on duplicate symbols. sapi/cli
  dnl sorts before sapi/phasm and has already selected itself by this point, so
  dnl there is nothing to turn off here — only a choice between saying so and
  dnl letting the link fail several minutes later with no hint of the cause.
  if test "$PHP_CLI" = "yes"; then
    AC_MSG_ERROR([--enable-phasm requires --disable-cli: the phasm SAPI includes the CLI's php_cli.c, so building both duplicates it.])
  fi

  dnl ps_title.c reads these, and sapi/cli/config.m4 is the only place that
  dnl probes for them — it does not run when the CLI is disabled. Neither is
  dnl found under Emscripten; the point is that the answer comes from a check
  dnl rather than from the check having been skipped. The CLI's third probe
  dnl (PS_STRINGS) is a BSD link test that cannot succeed here, so it is left
  dnl out rather than run for a foregone conclusion.
  AC_CHECK_FUNCS([setproctitle])
  AC_CHECK_HEADERS([sys/pstat.h])

  PHP_ADD_MAKEFILE_FRAGMENT([$abs_srcdir/sapi/phasm/Makefile.frag])

  SAPI_PHASM_PATH=sapi/phasm/php

  PHP_SELECT_SAPI([phasm],
    [program],
    [phasm.c],
    [-DZEND_ENABLE_STATIC_TSRMLS_CACHE=1])

  dnl phasm.c includes sapi/cli/php_cli.c, so the rest of the CLI's objects are
  dnl ours too: ps_title/process_title back save_ps_args() and the process-title
  dnl functions, and the CLI server backs the -S branch of the main() we inherit
  dnl but never call. They are compiled here rather than by sapi/cli's config.m4
  dnl because --enable-phasm requires --disable-cli: php_cli.c must be part of
  dnl exactly one translation unit, and it is part of ours.
  PHP_ADD_BUILD_DIR([sapi/cli])
  PHP_ADD_SOURCES_X([sapi/cli],
    [php_http_parser.c php_cli_server.c ps_title.c php_cli_process_title.c],
    [-DZEND_ENABLE_STATIC_TSRMLS_CACHE=1],
    [PHP_PHASM_OBJS])

  dnl No -export-dynamic, which sapi/cli's equivalent line does carry. It is
  dnl there so a dynamically loaded Zend extension can resolve PHPAPI symbols
  dnl against the running binary — a thing that cannot happen here, since
  dnl nothing dlopens anything into a wasm module. What it does instead is tell
  dnl wasm-ld to export every non-hidden symbol, which costs twice: ~6,000
  dnl symbols are pinned as roots so the linker cannot drop the code behind
  dnl them, and Emscripten then emits a JS assignment per export.
  BUILD_PHASM="\$(LIBTOOL) --tag=CC --mode=link \$(CC) \$(CFLAGS_CLEAN) \$(EXTRA_CFLAGS) \$(EXTRA_LDFLAGS_PROGRAM) \$(LDFLAGS) \$(PHP_RPATHS) \$(PHP_GLOBAL_OBJS:.lo=.o) \$(PHP_BINARY_OBJS:.lo=.o) \$(PHP_PHASM_OBJS:.lo=.o) \$(EXTRA_LIBS) \$(ZEND_EXTRA_LIBS) -o \$(SAPI_PHASM_PATH)"

  PHP_SUBST([SAPI_PHASM_PATH])
  PHP_SUBST([BUILD_PHASM])
fi
