/*
 * SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>
 *
 * SPDX-License-Identifier: ISC
 */

/*
 * The phasm SAPI — the CLI, made re-entrant.
 *
 * WHY THIS EXISTS
 *
 * phasm is embedded as a *host builtin* of a shell: the shell calls `php`
 * hundreds of times in one page, synchronously, on one warm instance. Driving
 * that through Emscripten's callMain() — which re-enters the CLI's main() —
 * fails in three measured ways:
 *
 *   1. the exit status latches. main() ends in exit(), which under
 *      NO_EXIT_RUNTIME sets Emscripten's EXITSTATUS global; every later call
 *      reports that same status forever, and EXITSTATUS is not resettable from
 *      JS. EG(exit_status) carries over too — nothing in the request cycle
 *      zeroes it (main/main.c resets it only in php_execute_simple_script).
 *   2. fatal errors go to stdout, because sapi_cli_ini_defaults() sets
 *      display_errors=1, which for the CLI means STDOUT. So `php x 2>/dev/null`
 *      cannot suppress them and `$(php x)` captures them.
 *   3. the instance dies at call ~104 with "memory access out of bounds".
 *      Deterministic, and near-identical under a 100x difference in per-call
 *      allocation — a fixed per-call leak, not heap exhaustion.
 *
 * All three come from re-running the *process* lifetime per call. main() is
 * really three things: one-time init, one invocation, teardown-and-exit. Only
 * the middle one is per-call — do_cli() does the whole request cycle
 * (php_request_startup, execute, php_request_shutdown) and returns
 * EG(exit_status).
 *
 * So this file is deliberately thin: include the CLI verbatim, run its
 * one-time half once in phasm_startup(), and expose its middle third as
 * phasm_run(). Argument handling (-r, -f, -v, -m, -i, script, stdin, the line
 * modes) is the CLI's, unmodified — reimplementing ~590 lines of it here would
 * mean re-porting them at every PHP upgrade.
 *
 * WHY IT INCLUDES A .c FILE
 *
 * do_cli(), cli_sapi_module, HARDCODED_INI and additional_functions are all
 * static to php_cli.c. Including the translation unit is what makes them
 * reachable without patching php-src, which keeps the PHP upgrade path a
 * version bump rather than a patch rebase. sapi/phasm/config.m4 therefore
 * compiles this file *instead of* php_cli.c, never both.
 *
 * WHAT IT IS NOT
 *
 * The SAPI still reports itself as "cli". That is not an oversight: PHP_SAPI
 * === 'cli' is what composer.phar, phpunit.phar and most CLI tools test before
 * agreeing to run at all, and a shell builtin named `php` is a command line by
 * any honest reading.
 *
 * Known gap: the ini options -c, -n and -d are per-process in the CLI, handled
 * by main() before module startup. There is no module startup per call here, so
 * they cannot be honoured per call; phasm_check_options() reports them instead
 * of ignoring them. Pass ini settings to phasm_startup(), where they apply for
 * the life of the instance. The built-in web server (-S) is likewise a main()
 * feature and is not available.
 */

#include "../cli/php_cli.c"

#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/stat.h>

#ifdef __EMSCRIPTEN__
# include <emscripten.h>
#else
# define EMSCRIPTEN_KEEPALIVE
#endif

static int phasm_started = 0;

/* Upper bound on descriptors reclaimed after a request; see phasm_run(). */
#define PHASM_FD_RECLAIM_MAX 64

/* {{{ ini defaults */

/*
 * The CLI's own default is "1", which display_errors_mode() reads as STDOUT
 * for this SAPI. "stderr" is what every non-interactive SAPI wants and what
 * makes `php x 2>/dev/null` and `$(php x)` behave: defect 2 above.
 *
 * INI_DEFAULT comes from php_cli.c, included above.
 */
static void phasm_ini_defaults(HashTable *configuration_hash)
{
	zval tmp;
	INI_DEFAULT("display_errors", "stderr");
}
/* }}} */

/* {{{ per-call environment */

/*
 * setenv() outlives a call, so a variable set for one invocation would leak
 * into the next — `FOO=1 php -r ...; php -r ...` must not see FOO the second
 * time. Track what we set and unset it before applying the next call's
 * environment. Variables the embedder baked into the module at boot are not
 * tracked and not touched.
 */
static char **phasm_env_keys = NULL;
static int phasm_env_count = 0;

static void phasm_env_clear(void)
{
	for (int i = 0; i < phasm_env_count; i++) {
		unsetenv(phasm_env_keys[i]);
		free(phasm_env_keys[i]);
	}
	free(phasm_env_keys);
	phasm_env_keys = NULL;
	phasm_env_count = 0;
}

/* `packed` is `count` NUL-terminated "NAME=value" entries, back to back. */
static void phasm_env_apply(const char *packed, int count)
{
	phasm_env_clear();

	if (packed == NULL || count <= 0) {
		return;
	}

	phasm_env_keys = calloc((size_t) count, sizeof(char *));
	if (phasm_env_keys == NULL) {
		return;
	}

	const char *entry = packed;
	for (int i = 0; i < count; i++) {
		const char *sep = strchr(entry, '=');
		if (sep != NULL && sep != entry) {
			size_t name_len = (size_t) (sep - entry);
			char *name = malloc(name_len + 1);
			if (name != NULL) {
				memcpy(name, entry, name_len);
				name[name_len] = '\0';
				setenv(name, sep + 1, 1);
				phasm_env_keys[phasm_env_count++] = name;
			}
		}
		entry += strlen(entry) + 1;
	}
}
/* }}} */

/* {{{ phasm_startup */

/*
 * main()'s first third, run exactly once per instance. Everything after
 * do_cli() in main() — php_module_shutdown(), sapi_shutdown(), exit() — is
 * deliberately absent: those are what make a second call impossible.
 *
 * `ini` is an optional block of newline-separated "name=value" lines, applied
 * after the CLI's hardcoded defaults and therefore able to override them.
 *
 * Returns 0 on success, -1 if PHP is already running in this instance.
 */
EMSCRIPTEN_KEEPALIVE
int phasm_startup(const char *ini)
{
	/* sapi_module holds this pointer for the life of the instance. */
	static struct php_ini_builder ini_builder;

	if (phasm_started) {
		/* These are module-startup settings and the module has started, so
		 * there is no honest way to apply them. Say so, rather than returning
		 * success and running with the defaults. */
		return (ini != NULL && *ini != '\0') ? -1 : 0;
	}

	/* callMain() got here first: main() owns the process lifetime and ends in
	 * exit(). The two entry points are mutually exclusive by construction. */
	if (sapi_module.name != NULL) {
		return -1;
	}

	zend_signal_startup();

	php_ini_builder_init(&ini_builder);

	cli_sapi_module.additional_functions = additional_functions;
	cli_sapi_module.ini_defaults = phasm_ini_defaults;
	cli_sapi_module.php_ini_path_override = NULL;
	cli_sapi_module.phpinfo_as_text = 1;
	cli_sapi_module.php_ini_ignore_cwd = 1;

	sapi_startup(&cli_sapi_module);

	cli_sapi_module.php_ini_ignore = 0;
	cli_sapi_module.executable_location = "php";

	/* Prepending twice leaves HARDCODED_INI first and `ini` second, so the
	 * embedder's settings win where they collide. */
	if (ini != NULL && *ini != '\0') {
		php_ini_builder_prepend_literal(&ini_builder, ini);
	}
	php_ini_builder_prepend_literal(&ini_builder, HARDCODED_INI);
	cli_sapi_module.ini_entries = php_ini_builder_finish(&ini_builder);

	if (cli_sapi_module.startup(&cli_sapi_module) == FAILURE) {
		return -1;
	}

	phasm_started = 1;
	return 0;
}
/* }}} */

/* {{{ reclaiming the standard streams */

/*
 * php://stdin, php://stdout and php://stderr are opened afresh for every
 * request and flagged PHP_STREAM_FLAG_NO_RSCR_DTOR_CLOSE, so shutdown frees the
 * stream and deliberately leaves the descriptor open — and after the first
 * request each one is a dup() of fd 0, 1 or 2. That is free in a program about
 * to exit; here it is three descriptors per call, and once the table fills,
 * cli_register_file_handles() starts giving up early and STDIN/STDOUT/STDERR
 * quietly stop being defined at all.
 *
 * `mark` is the lowest descriptor that was free before the request, so anything
 * at or above it is something the request opened. That alone would not make
 * closing safe: persistent resources — a persistent PDO handle, say — outlive a
 * request on purpose and would sit in the same range. So the test is positive
 * rather than positional: only descriptors that are demonstrably duplicates of
 * fd 0, 1 or 2 are closed, and everything else is left exactly as it was.
 *
 * The whole window is scanned, because the range is not contiguous and the
 * interesting descriptors are not at the front of it. Running a script file
 * opens it at `mark` and closes it at request shutdown, which leaves a *hole*
 * there with the three std dups above it — so a scan that stopped at the first
 * unused descriptor reclaimed nothing at all for `php script.php` and `php -f`,
 * the two most ordinary ways to invoke PHP. Nor can it stop at the first live
 * non-dup: a persistent handle opened before the std streams sits in front of
 * them and would hide them the same way.
 */
static void phasm_reclaim_std_dups(int mark)
{
	struct stat std_stat[3];
	int std_known[3];

	for (int i = 0; i < 3; i++) {
		std_known[i] = fstat(i, &std_stat[i]) == 0;
	}

	for (int fd = mark; fd < mark + PHASM_FD_RECLAIM_MAX; fd++) {
		struct stat st;
		int is_std_dup = 0;

		if (fstat(fd, &st) != 0) {
			continue; /* a hole, not the end of the range */
		}

		for (int i = 0; i < 3 && !is_std_dup; i++) {
			is_std_dup = std_known[i]
				&& st.st_dev == std_stat[i].st_dev
				&& st.st_ino == std_stat[i].st_ino;
		}

		if (is_std_dup) {
			close(fd);
		}
	}
}
/* }}} */

/* {{{ options that were main()'s job */

/*
 * do_cli() parses the options it acts on and ignores everything else, because
 * the CLI's main() consumed those first: usage, invalid options, the built-in
 * server, and the ini overrides -c/-n/-d. Nothing consumes them here, so
 * without this pass `php -Z script.php` would run the script and report
 * success, `php --help` would print nothing at all, and `php -d x=1 …` would
 * silently run with x unset.
 *
 * Returns 1 if the call is already finished, with its status in *status.
 */
static int phasm_check_options(int argc, char **argv, int *status)
{
	char *arg = NULL;
	int arg_index = 1;
	int finished = 0;
	int c;

	/* This runs to the end even once the outcome is known: php_getopt keeps
	 * static parse state between calls, and only a pass that reaches EOF is
	 * guaranteed to leave it clean for do_cli's own two passes. */
	while ((c = php_getopt(argc, argv, OPTIONS, &arg, &arg_index, 1, 2)) != -1) {
		switch (c) {
			case 'h':
			case '?':
				if (!finished) {
					php_cli_usage(argv[0]);
					*status = 0;
					finished = 1;
				}
				break;

			case PHP_GETOPT_INVALID_ARG:
				/* php_getopt has already named the offending argument. */
				if (!finished) {
					php_cli_usage(argv[0]);
					*status = 1;
					finished = 1;
				}
				break;

			case 'S':
				if (!finished) {
					fprintf(stderr, "php: the built-in web server is not available in this build\n");
					*status = 1;
					finished = 1;
				}
				break;

			case 'e':
				fprintf(stderr,
					"php: -e applies to the whole instance, not one call. Ignoring it.\n");
				break;

			case 'c':
			case 'n':
			case 'd':
				fprintf(stderr,
					"php: -%c applies to the whole instance, not one call; "
					"pass ini settings when starting PHP. Ignoring it.\n", (char) c);
				break;

			default:
				break;
		}
	}

	return finished;
}
/* }}} */

/* {{{ phasm_run */

/*
 * One invocation. `packed_argv` is `argc` NUL-terminated strings back to back,
 * argv[0] included; `packed_env` is the same shape for the environment.
 * `cwd` and `env` may be NULL, meaning "leave as is" and "empty".
 *
 * Returns the exit status. It does not call exit(), so Emscripten's EXITSTATUS
 * is never set and the module stays usable: defect 1.
 */
EMSCRIPTEN_KEEPALIVE
int phasm_run(char *packed_argv, int argc, const char *cwd, const char *packed_env, int envc)
{
	volatile int status = 255;

	if (!phasm_started && phasm_startup(NULL) != 0) {
		return 255;
	}

	if (argc <= 0 || packed_argv == NULL) {
		return 255;
	}

	char **argv = calloc((size_t) argc + 1, sizeof(char *));
	if (argv == NULL) {
		return 255;
	}
	char *arg = packed_argv;
	for (int i = 0; i < argc; i++) {
		argv[i] = arg;
		arg += strlen(arg) + 1;
	}

	phasm_env_apply(packed_env, envc);

	/* The working directory is process state, so without this a call that
	 * chdir()s — whether the embedder asked for it or the script did it — would
	 * silently become the starting directory of the next one. The embedder is
	 * the only thing that gets to say where a call runs. */
	char saved_cwd[MAXPATHLEN];
	bool cwd_saved = VCWD_GETCWD(saved_cwd, sizeof(saved_cwd)) != NULL;

	if (cwd != NULL && *cwd != '\0' && VCWD_CHDIR(cwd) != 0) {
		fprintf(stderr, "php: cannot change directory to %s\n", cwd);
		free(argv);
		return 255;
	}

	int early_status = 0;
	if (phasm_check_options(argc, argv, &early_status)) {
		if (cwd_saved) {
			(void) VCWD_CHDIR(saved_cwd);
		}
		free(argv);
		return early_status;
	}

	/* dup() hands back the lowest free descriptor, so this marks the boundary
	 * between what the embedder already had open and what the request is about
	 * to open. See phasm_reclaim_std_dups(). */
	int fd_mark = dup(STDIN_FILENO);
	if (fd_mark >= 0) {
		close(fd_mark);
	}

	/* A file-static in php_cli.c that the -R and -F line modes read. It is set
	 * per request by cli_register_file_handles(), so if registration ever fails
	 * those modes would otherwise reach into the previous call's freed stream. */
	s_in_process = NULL;

	/* Nothing in the request cycle zeroes this, so a previous exit(3) would
	 * otherwise be reported by every later call. */
	EG(exit_status) = 0;

	zend_first_try {
		status = do_cli(argc, argv);
	} zend_end_try();

	if (fd_mark >= 0) {
		phasm_reclaim_std_dups(fd_mark);
	}

	if (cwd_saved) {
		(void) VCWD_CHDIR(saved_cwd);
	}

	/* Everything below points into argv, which is about to be freed by the
	 * caller — php_self and script_filename are file-statics in php_cli.c that
	 * survive the request, and do_cli only resets php_self, only on the branch
	 * that has no script file. Left alone, the next call's
	 * sapi_cli_register_variables() calls strlen() on freed memory to build
	 * $_SERVER. Their initial values are the empty string, so that is what they
	 * go back to. */
	php_self = "";
	script_filename = "";
	SG(request_info).path_translated = NULL;
	SG(request_info).argc = 0;
	SG(request_info).argv = NULL;
	free(argv);

	return status;
}
/* }}} */

/* {{{ phasm_is_started */

/*
 * Whether PHP is up in this instance. src/phasm-glue.js uses it to refuse a
 * callMain() that would re-enter module startup on a live module — a trap that
 * kills the instance and every later phasm_run() with it. The guard lives in JS
 * because callMain() is Emscripten's own JS entry point and never reaches C.
 */
EMSCRIPTEN_KEEPALIVE
int phasm_is_started(void)
{
	return phasm_started;
}
/* }}} */
