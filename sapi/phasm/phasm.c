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

/* Server mode's own needs: response buffers, $_SERVER registration and the
 * percent-decoding the path lookup depends on. */
#include "Zend/zend_smart_str.h"
#include "main/php_variables.h"
#include "ext/standard/url.h"

/* zend_call_stack_init(), re-run in phasm_startup() once ini is loaded. */
#include "Zend/zend_call_stack.h"

#include <ctype.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
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

/* {{{ what a call is in the middle of */

/*
 * A wasm trap does not unwind like a C error: it destroys the frames and
 * resumes in JS, so nothing after the trapping line runs — not the epilogue,
 * not zend_end_try(), not php_request_shutdown(). The reachable one is deep
 * recursion hitting the *JS engine's* wasm frame limit, which no emcc flag
 * sizes (see TODO §4.9); `json_encode()` over a few thousand levels of nesting
 * reaches it, and so would any C recursion an extension does.
 *
 * The instance survives that — measurably — but it is left mid-request, so the
 * next call's startup redeclares what the abandoned one already registered and
 * every later call prints "Constant PHP_CLI_PROCESS_TITLE already defined" on
 * stderr, forever. One bad script would put that on every `php` for the rest of
 * a shell session.
 *
 * So a call's epilogue cannot live in its own frame. Everything the epilogue
 * needs is kept here instead, and phasm_recover() runs it from a live stack
 * after the trap. Calls do not nest — the guest is a synchronous frame below
 * the host — so one set of these is all there is to keep.
 */

/* The lowest descriptor that was free when the call started; -1 when idle. */
static int phasm_call_fd_mark = -1;

/* Where the call was asked to run, so a trapped chdir() does not become the
 * next call's starting directory. */
static char phasm_call_cwd[MAXPATHLEN];
static int phasm_call_cwd_saved = 0;

/*
 * Allocations the call owns. Freeing these in the epilogue rather than at each
 * return is not tidiness: on the trap path there is no return to free them at,
 * and one of them is pointed to by SG(request_info), which the *next* call
 * reads. Four is the most any one call holds (argv, path, script, script_name).
 */
static void *phasm_call_owned[4];
static int phasm_call_owned_count = 0;

static void *phasm_call_own(void *p)
{
	if (p != NULL && phasm_call_owned_count < (int) (sizeof(phasm_call_owned) / sizeof(*phasm_call_owned))) {
		phasm_call_owned[phasm_call_owned_count++] = p;
	}
	return p;
}

static void phasm_call_free_owned(void)
{
	while (phasm_call_owned_count > 0) {
		free(phasm_call_owned[--phasm_call_owned_count]);
		phasm_call_owned[phasm_call_owned_count] = NULL;
	}
}
/* }}} */

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

	/*
	 * The recursion budget. Auto-detection would hand the guard the whole
	 * shadow stack, and that is the wrong size here: the limit deep recursion
	 * actually reaches is the JS engine's wasm frame stack, which is a
	 * different stack that no wasm program can read. The shadow stack is a
	 * proxy for it (see Zend/zend_call_stack.h in the 0005 patch), so the
	 * budget has to be set from where the real limit was MEASURED to be rather
	 * than from how much shadow stack happens to exist.
	 *
	 * 512 KiB, less the ~48 KiB zend.reserved_stack_size auto-detects, is a
	 * depth of ~290 levels of json_encode() and ~680 of the nesting that
	 * re-enters the VM — the two differ because a guarded frame costs what it
	 * spills plus the patch's fixed reservation. What matters is where each
	 * lands against the depth at which the JS engine gives up on that same
	 * recursion, measured at ~3450 and ~2359: the guard fires with a factor of
	 * twelve in hand on one and three on the other. Below it nothing changes;
	 * past it a script gets PHP's own "Maximum call stack size ... reached"
	 * instead of a wasm trap that ends the call from outside PHP entirely.
	 *
	 * Why not simply the whole stack, which is what auto-detection would pick:
	 * a budget only has to be small enough to beat the engine, and every byte
	 * above that is depth the guard is not watching. The margins are deliberately
	 * wide rather than tuned, because the limit on the other side of them belongs
	 * to whichever JS engine is running the module — these cliffs were measured
	 * on one, and a browser with a smaller wasm stack moves them.
	 *
	 * The one place that is visible: json_encode()'s own $depth argument
	 * defaults to 512, so a document between ~290 and 512 levels deep encodes
	 * on stock PHP and reports a depth error here. It is the same error, from
	 * the same function, with the same json_last_error() — reached sooner. A
	 * caller that handles the documented case handles this one, which is the
	 * whole difference between it and the wasm trap it replaced.
	 *
	 * It stays a settable knob, and -1 turns it off: test/sapi.test.mjs uses
	 * that to keep reaching a real trap, which is the only way what
	 * phasm_recover() does can still be tested.
	 */
	INI_DEFAULT("zend.max_allowed_stack_size", "512K");
}
/* }}} */

/* {{{ per-call environment */

/*
 * setenv() outlives a call, so a variable set for one invocation would leak
 * into the next — `FOO=1 php -r ...; php -r ...` must not see FOO the second
 * time. Track what we set and put the environment back before applying the
 * next call's.
 *
 * Putting it *back* rather than unsetting it: a call is free to override a
 * variable the embedder baked into the module at boot, and unsetting is not the
 * inverse of overriding — `PATH=/bin php -r …` would delete PATH outright, for
 * this instance, forever. So the previous value is saved alongside the name and
 * restored; a name that had no value is unset, which is the inverse there.
 */
typedef struct {
	char *name;
	char *previous; /* NULL when the variable did not exist before the call */
} phasm_env_entry;

static phasm_env_entry *phasm_env_saved = NULL;
static int phasm_env_count = 0;

static void phasm_env_clear(void)
{
	/* Backwards, so that if one call named a variable twice the *earliest*
	 * saved value — the one from before the call — is what is restored last. */
	for (int i = phasm_env_count - 1; i >= 0; i--) {
		if (phasm_env_saved[i].previous != NULL) {
			setenv(phasm_env_saved[i].name, phasm_env_saved[i].previous, 1);
			free(phasm_env_saved[i].previous);
		} else {
			unsetenv(phasm_env_saved[i].name);
		}
		free(phasm_env_saved[i].name);
	}
	free(phasm_env_saved);
	phasm_env_saved = NULL;
	phasm_env_count = 0;
}

/* `packed` is `count` NUL-terminated "NAME=value" entries, back to back. */
static void phasm_env_apply(const char *packed, int count)
{
	phasm_env_clear();

	if (packed == NULL || count <= 0) {
		return;
	}

	phasm_env_saved = calloc((size_t) count, sizeof(phasm_env_entry));
	if (phasm_env_saved == NULL) {
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

				/* Copied before setenv(), which is free to invalidate it. */
				const char *previous = getenv(name);
				char *kept = previous != NULL ? strdup(previous) : NULL;

				setenv(name, sep + 1, 1);
				phasm_env_saved[phasm_env_count].name = name;
				phasm_env_saved[phasm_env_count].previous = kept;
				phasm_env_count++;
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

#ifdef ZEND_CHECK_STACK_LIMIT
	/*
	 * Recompute the recursion budget now that ini has been read.
	 *
	 * zend_startup() ends in zend_call_stack_init(), and main()'s startup runs
	 * it *before* php_init_config() — so EG(stack_limit) is worked out from
	 * whatever zend.max_allowed_stack_size was before anyone said otherwise,
	 * and nothing recomputes it afterwards. That is invisible on a real
	 * platform, where auto-detection reads the OS's own stack bounds and gets
	 * the right answer without being told; here the value is the whole point,
	 * because the budget is a measured proxy for a stack that cannot be read.
	 * Without this line phasm_ini_defaults()'s setting is stored, reported by
	 * ini_get(), and has no effect whatsoever.
	 *
	 * The clamp first. zend_call_stack_limit() subtracts the budget from the
	 * stack base and only refuses to underflow the address space — it does not
	 * check the budget against the stack, because on the platforms it was
	 * written for the two come from the same place. Here they do not: the
	 * budget is an ini setting and the stack is -sSTACK_SIZE, so asking for
	 * more than exists puts EG(stack_limit) BELOW the end of the stack, where
	 * no position can ever be less than it. The guard would then be on, be
	 * reported by ini_get(), and never fire once — while the reservation each
	 * guarded frame makes goes on spending a stack nothing is now watching.
	 * That is the one configuration worse than not having a guard, and it is a
	 * plausible thing to ask for: "give me deeper recursion" reads as raising
	 * this number.
	 *
	 * Clamping rather than refusing because a budget of the whole stack is a
	 * coherent thing to want, and the honest answer to "8M please" on a 4 MiB
	 * stack is 4 MiB. -1 is left alone: that is the documented way to switch
	 * the guard off, and it is checked for explicitly rather than compared,
	 * since ZEND_MAX_ALLOWED_STACK_SIZE_UNCHECKED is negative.
	 *
	 * It is safe to run twice: it derives everything from the shadow stack's
	 * bounds and the current ini, both of which are fixed for the life of the
	 * instance.
	 */
	{
		zend_call_stack stack;

		if (EG(max_allowed_stack_size) > 0 && zend_call_stack_get(&stack)
			&& (size_t) EG(max_allowed_stack_size) > stack.max_size) {
			EG(max_allowed_stack_size) = (zend_long) stack.max_size;
		}
	}

	zend_call_stack_init();
#endif

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

/* {{{ the end of a call, wherever it ends */

/*
 * Everything both entry points do once their request is over, in one place so
 * that phasm_recover() can do it too. Idempotent, and safe on a call that never
 * got far enough to set any of it.
 *
 * The pointer clearing is the part that is not merely tidy. php_self and
 * script_filename are file-statics in php_cli.c that outlive the request and
 * point into argv; SG(request_info) holds the request's uri, script and cookie
 * data the same way. All of it is freed by phasm_call_free_owned() below or by
 * the caller the moment the call returns, and the *next* call reads it —
 * sapi_cli_register_variables() calls strlen() on it to build $_SERVER, and
 * sapi_activate() re-parses cookie_data. Clearing them first is what makes
 * freeing them safe.
 */
static void phasm_call_epilogue(void)
{
	if (phasm_call_fd_mark >= 0) {
		phasm_reclaim_std_dups(phasm_call_fd_mark);
		phasm_call_fd_mark = -1;
	}

	if (phasm_call_cwd_saved) {
		(void) VCWD_CHDIR(phasm_call_cwd);
		phasm_call_cwd_saved = 0;
	}

	php_self = "";
	script_filename = "";

	/* A file-static in php_cli.c that the -R and -F line modes read. It is set
	 * per request by cli_register_file_handles(), so if registration ever fails
	 * those modes would otherwise reach into the previous call's freed stream. */
	s_in_process = NULL;

	SG(request_info).path_translated = NULL;
	SG(request_info).argc = 0;
	SG(request_info).argv = NULL;
	SG(request_info).request_method = NULL;
	SG(request_info).request_uri = NULL;
	SG(request_info).query_string = NULL;
	SG(request_info).content_type = NULL;
	SG(request_info).content_length = 0;
	SG(request_info).cookie_data = NULL;

	/* do_cli() points this at a php_cli_server_context on its own stack and
	 * leaves it there, and phasm_handle_request() points it at a frame that is
	 * equally gone by now. Nothing dereferences it before the next call
	 * overwrites it, but sapi_activate() *branches* on it — `if
	 * (SG(server_context))` is what decides whether a request re-reads its
	 * cookies — so leaving a stale non-NULL pointer here is one refactor away
	 * from mattering. */
	SG(server_context) = NULL;

	phasm_call_free_owned();
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

	char **argv = phasm_call_own(calloc((size_t) argc + 1, sizeof(char *)));
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
	phasm_call_cwd_saved = VCWD_GETCWD(phasm_call_cwd, sizeof(phasm_call_cwd)) != NULL;

	if (cwd != NULL && *cwd != '\0' && VCWD_CHDIR(cwd) != 0) {
		fprintf(stderr, "php: cannot change directory to %s\n", cwd);
		phasm_call_epilogue();
		return 255;
	}

	int early_status = 0;
	if (phasm_check_options(argc, argv, &early_status)) {
		phasm_call_epilogue();
		return early_status;
	}

	/* dup() hands back the lowest free descriptor, so this marks the boundary
	 * between what the embedder already had open and what the request is about
	 * to open. See phasm_reclaim_std_dups(). */
	phasm_call_fd_mark = dup(STDIN_FILENO);
	if (phasm_call_fd_mark >= 0) {
		close(phasm_call_fd_mark);
	}

	s_in_process = NULL;

	/* Nothing in the request cycle zeroes this, so a previous exit(3) would
	 * otherwise be reported by every later call. */
	EG(exit_status) = 0;

	/* Same shape, different field. php_request_startup() reaches
	 * sapi_activate(), and the line there that would reset this is commented
	 * out upstream, so the status a request set stays set — and a command run
	 * afterwards sees http_response_code() return 404 instead of false.
	 * phasm_handle_request() does not need this because it assigns 200 to
	 * every request outright; a command has no status of its own, and 0 is
	 * what "none" is spelled as. */
	SG(sapi_headers).http_response_code = 0;

	zend_first_try {
		status = do_cli(argc, argv);
	} zend_end_try();

	phasm_call_epilogue();

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

/* {{{ server mode */

/*
 * WHY SERVER MODE IS NOT A SECOND SAPI
 *
 * A request needs different plumbing from a command: output has to be captured
 * rather than written to a descriptor, header() has to be recorded rather than
 * discarded, and POST data has to come from a buffer rather than a socket. The
 * CLI SAPI does none of that — sapi_cli_send_headers() throws headers away, and
 * do_cli() sets SG(request_info).no_headers so nothing tries.
 *
 * The obvious answer, a second sapi_module_struct, is the wrong one here: the
 * module started once in phasm_startup() and its extensions, ini and opcache
 * are bound to that startup. Starting a second one means a second module in the
 * same instance, and swapping the global mid-flight means re-running
 * php_module_startup(). Both give up the one thing this SAPI exists for.
 *
 * So the hooks are swapped for the duration of one request and put back — the
 * technique php_cli_server.c itself uses for its own send_headers around
 * ini-set output (see sapi_cli_server_discard_headers). Everything upstream of
 * the hooks is PHP's ordinary request cycle, which is the point: $_GET, $_POST,
 * php://input, $_FILES and the rfc1867 multipart parser all arrive by
 * themselves, because they were never ours to fake.
 */

typedef struct {
	/* request */
	const char *method;
	const char *uri;              /* the target as sent, query string included */
	const char *path;             /* decoded, no query string */
	const char *query;            /* after the '?', or NULL */
	const char *script_filename;  /* absolute, resolved under docroot */
	const char *script_name;      /* what the script sees as SCRIPT_NAME */
	const char *docroot;
	const char *packed_headers;   /* "Name: value" entries, NUL-separated */
	int header_count;
	char *cookies;                /* the Cookie header's value, or NULL */
	const char *host;             /* the Host header's value, or NULL */
	const char *body;
	size_t body_len;
	size_t body_read;

	int status;
} phasm_request;

static phasm_request *phasm_req(void)
{
	return (phasm_request *) SG(server_context);
}

/*
 * The response. These are filled during the request but read after it, so they
 * are allocated persistently — smart_str's default is the request allocator,
 * and php_request_shutdown() frees that whole arena. Getting this wrong does
 * not fail where the response is read; it corrupts the heap and takes the
 * *next* request down inside php_request_shutdown(). Hence the _ex() calls and
 * the matching smart_str_free_ex() in phasm_response_reset().
 *
 * They are file-statics rather than fields of the request above for the same
 * reason the call state is: a trap leaves that struct's frame unreachable, and
 * buffers that were going to be handed over at the end of a call that has no
 * end are simply leaked.
 */
static smart_str phasm_resp_body = {0};
static smart_str phasm_resp_headers = {0};
static int phasm_resp_status = 0;

/* {{{ the swapped hooks */

/*
 * Writing to the response buffer directly, with no reference to the request:
 * php_request_shutdown() flushes output, and phasm_recover() runs that shutdown
 * for a request whose struct is gone. Returning anything less than asked for
 * would be read as a dropped connection, and php_handle_aborted_connection()
 * answers that with zend_bailout() — into a jmp_buf the trap already destroyed.
 */
static size_t phasm_ub_write(const char *str, size_t str_length)
{
	smart_str_appendl_ex(&phasm_resp_body, str, str_length, 1);
	return str_length;
}

/*
 * Deliberately empty. A socket-backed SAPI flushes here, and sends the headers
 * first because after this the body is on the wire; there is no wire here, only
 * a buffer the embedder reads when the request is over.
 *
 * Sending headers from this hook is actively wrong: the CLI's HARDCODED_INI
 * sets implicit_flush=1, and php_request_startup() acts on that by flushing
 * while it is still starting up — before the script has run a single line. That
 * marked the headers sent with an empty list, so every header() the script went
 * on to make was a no-op against an already-sent response, and headers_sent()
 * returned true from the first statement onwards. The output layer already
 * calls sapi_send_headers() before the first body byte, and a response that
 * never writes one still gets its headers from php_request_shutdown(), which
 * reaches the same call through php_output_deactivate().
 */
static void phasm_flush(void *server_context)
{
}

/*
 * Recorded, not written: the embedder synthesises the real Response. Headers
 * come out as "Name: value" lines so the JS side can split them without this
 * file inventing an encoding.
 */
static int phasm_send_headers(sapi_headers_struct *sapi_headers)
{
	phasm_request *r = phasm_req();
	sapi_header_struct *h;
	zend_llist_position pos;

	if (SG(request_info).no_headers) {
		return SAPI_HEADER_SENT_SUCCESSFULLY;
	}

	if (r != NULL && SG(sapi_headers).http_response_code != 0) {
		r->status = SG(sapi_headers).http_response_code;
	}

	h = (sapi_header_struct *) zend_llist_get_first_ex(&sapi_headers->headers, &pos);
	while (h != NULL) {
		if (h->header_len > 0) {
			smart_str_appendl_ex(&phasm_resp_headers, h->header, h->header_len, 1);
			smart_str_appendc_ex(&phasm_resp_headers, '\n', 1);
		}
		h = (sapi_header_struct *) zend_llist_get_next_ex(&sapi_headers->headers, &pos);
	}

	return SAPI_HEADER_SENT_SUCCESSFULLY;
}

/*
 * PHP's own post reader drives this, which is what makes $_POST, php://input
 * and $_FILES work without any of them being special-cased here.
 */
static size_t phasm_read_post(char *buf, size_t count_bytes)
{
	phasm_request *r = phasm_req();
	size_t remaining, n;

	if (r == NULL || r->body == NULL) {
		return 0;
	}

	remaining = r->body_len - r->body_read;
	n = count_bytes < remaining ? count_bytes : remaining;
	if (n > 0) {
		memcpy(buf, r->body + r->body_read, n);
		r->body_read += n;
	}
	return n;
}

static char *phasm_read_cookies(void)
{
	phasm_request *r = phasm_req();
	return r != NULL ? r->cookies : NULL;
}

/* }}} */

/* {{{ $_SERVER */

/* "Content-Type" -> "CONTENT_TYPE"; anything else -> "HTTP_X_FORWARDED_FOR". */
static char *phasm_header_var_name(const char *name, size_t name_len)
{
	int prefixed = !(name_len == sizeof("content-type") - 1
			&& strncasecmp(name, "content-type", name_len) == 0)
		&& !(name_len == sizeof("content-length") - 1
			&& strncasecmp(name, "content-length", name_len) == 0);
	size_t prefix_len = prefixed ? sizeof("HTTP_") - 1 : 0;
	char *var = malloc(prefix_len + name_len + 1);

	if (var == NULL) {
		return NULL;
	}
	if (prefixed) {
		memcpy(var, "HTTP_", prefix_len);
	}
	for (size_t i = 0; i < name_len; i++) {
		char c = name[i];
		var[prefix_len + i] = (c == '-') ? '_' : (char) toupper((unsigned char) c);
	}
	var[prefix_len + name_len] = '\0';
	return var;
}

static void phasm_register_variables(zval *track_vars_array)
{
	phasm_request *r = phasm_req();
	const char *entry;

	/* Whatever the embedder passed as this call's environment, same as CLI. */
	php_import_environment_variables(track_vars_array);

	if (r == NULL) {
		return;
	}

	php_register_variable("REQUEST_METHOD", r->method, track_vars_array);
	/* The target exactly as the client sent it, query string included — a
	 * router reads this, and re-deriving it from path and query loses the
	 * difference between "no query" and "an empty one". */
	php_register_variable("REQUEST_URI", r->uri, track_vars_array);
	php_register_variable("QUERY_STRING", r->query != NULL ? r->query : "", track_vars_array);
	php_register_variable("SCRIPT_NAME", r->script_name, track_vars_array);
	php_register_variable("PHP_SELF", r->script_name, track_vars_array);
	php_register_variable("SCRIPT_FILENAME", r->script_filename, track_vars_array);
	php_register_variable("PATH_TRANSLATED", r->script_filename, track_vars_array);
	php_register_variable("DOCUMENT_ROOT", r->docroot, track_vars_array);
	php_register_variable("SERVER_PROTOCOL", "HTTP/1.1", track_vars_array);
	php_register_variable("SERVER_SOFTWARE", "phasm", track_vars_array);

	/* Split off the Host header's port, because SERVER_NAME and SERVER_PORT are
	 * separate variables and a great deal of code builds a base URL out of the
	 * pair. Without them that code emits "http://:" and two undefined-key
	 * warnings, which looks like a bug in the application. */
	{
		const char *host = r->host != NULL ? r->host : "localhost";
		const char *colon = strrchr(host, ':');
		/* Only a port, never the colons of a bare IPv6 literal. */
		int has_port = colon != NULL && strchr(colon, ']') == NULL && colon[1] != '\0';

		if (has_port) {
			char *name = malloc((size_t) (colon - host) + 1);
			if (name != NULL) {
				memcpy(name, host, (size_t) (colon - host));
				name[colon - host] = '\0';
				php_register_variable("SERVER_NAME", name, track_vars_array);
				free(name);
			}
			php_register_variable("SERVER_PORT", colon + 1, track_vars_array);
		} else {
			php_register_variable("SERVER_NAME", host, track_vars_array);
			php_register_variable("SERVER_PORT", "80", track_vars_array);
		}
	}
	php_register_variable("REMOTE_PORT", "0", track_vars_array);
	php_register_variable("GATEWAY_INTERFACE", "CGI/1.1", track_vars_array);
	php_register_variable("REQUEST_SCHEME", "http", track_vars_array);
	php_register_variable("REMOTE_ADDR", "127.0.0.1", track_vars_array);

	entry = r->packed_headers;
	for (int i = 0; i < r->header_count && entry != NULL; i++) {
		const char *sep = strchr(entry, ':');
		if (sep != NULL && sep != entry) {
			const char *value = sep + 1;
			char *var;

			while (*value == ' ' || *value == '\t') {
				value++;
			}
			var = phasm_header_var_name(entry, (size_t) (sep - entry));
			if (var != NULL) {
				php_register_variable(var, value, track_vars_array);
				free(var);
			}
		}
		entry += strlen(entry) + 1;
	}
}

/* }}} */

/* {{{ swapping the hooks in and out */

/*
 * A request needs different plumbing from a command, and swapping these for the
 * duration of one request is how it gets it without a second sapi_module_struct
 * (see the note above). They are saved here rather than in the request's own
 * frame so that phasm_recover() can put them back after a trap — an instance
 * left with the request hooks installed sends every later command's output into
 * a response buffer nobody reads.
 */
static struct {
	size_t (*ub_write)(const char *, size_t);
	void (*flush)(void *);
	int (*header_handler)(sapi_header_struct *, sapi_header_op_enum, sapi_headers_struct *);
	int (*send_headers)(sapi_headers_struct *);
	size_t (*read_post)(char *, size_t);
	char *(*read_cookies)(void);
	void (*register_server_variables)(zval *);
	int installed;
} phasm_saved_hooks;

static void phasm_hooks_install(void)
{
	phasm_saved_hooks.ub_write = sapi_module.ub_write;
	phasm_saved_hooks.flush = sapi_module.flush;
	phasm_saved_hooks.header_handler = sapi_module.header_handler;
	phasm_saved_hooks.send_headers = sapi_module.send_headers;
	phasm_saved_hooks.read_post = sapi_module.read_post;
	phasm_saved_hooks.read_cookies = sapi_module.read_cookies;
	phasm_saved_hooks.register_server_variables = sapi_module.register_server_variables;
	phasm_saved_hooks.installed = 1;

	sapi_module.ub_write = phasm_ub_write;
	sapi_module.flush = phasm_flush;
	/* NULL means "keep it", which is the default every server SAPI relies on.
	 * The CLI installs a handler that returns 0 instead — that is how `header()`
	 * comes to be accepted and discarded in a command line, and left in place it
	 * drops every header before it ever reaches the list send_headers walks. */
	sapi_module.header_handler = NULL;
	sapi_module.send_headers = phasm_send_headers;
	sapi_module.read_post = phasm_read_post;
	sapi_module.read_cookies = phasm_read_cookies;
	sapi_module.register_server_variables = phasm_register_variables;
}

static void phasm_hooks_restore(void)
{
	if (!phasm_saved_hooks.installed) {
		return;
	}
	sapi_module.ub_write = phasm_saved_hooks.ub_write;
	sapi_module.flush = phasm_saved_hooks.flush;
	sapi_module.header_handler = phasm_saved_hooks.header_handler;
	sapi_module.send_headers = phasm_saved_hooks.send_headers;
	sapi_module.read_post = phasm_saved_hooks.read_post;
	sapi_module.read_cookies = phasm_saved_hooks.read_cookies;
	sapi_module.register_server_variables = phasm_saved_hooks.register_server_variables;
	phasm_saved_hooks.installed = 0;
}

/* }}} */

/* {{{ resolving the script */

/*
 * A path is refused rather than normalised if it can climb: this runs against
 * the embedder's whole filesystem, and "%2e%2e/" is the oldest trick there is.
 * Decoding happens first, so the check sees what the lookup will use.
 */
static int phasm_path_escapes(const char *path)
{
	const char *p = path;

	while ((p = strstr(p, "..")) != NULL) {
		int at_start = (p == path) || (p[-1] == '/');
		int at_end = (p[2] == '\0') || (p[2] == '/');
		if (at_start && at_end) {
			return 1;
		}
		p += 2;
	}
	return 0;
}

/*
 * Collapse "//" and "/./" in place; the result is never longer than the input.
 * ".." never reaches here — phasm_path_escapes() refuses it above — so this
 * cannot climb, it only makes two spellings of one path into one.
 *
 * It matters because $_SERVER['SCRIPT_NAME'] and PHP_SELF are what a router
 * strips its own prefix from, and "//i.php" arriving at a route table as a
 * different string from "/i.php" is a routing bug that the request looks
 * entirely innocent in. A trailing slash is deliberately kept: "/i.php/" is not
 * a request for "/i.php", and turning it into one would serve a script for a
 * path that was never asked for.
 */
static void phasm_normalize_path(char *path)
{
	char *out = path;
	const char *in = path;

	while (*in != '\0') {
		if (*in != '/') {
			*out++ = *in++;
			continue;
		}

		*out++ = '/';
		in++;

		/* Everything after this slash that means "still the same directory". */
		for (;;) {
			if (*in == '/') {
				in++;
			} else if (in[0] == '.' && (in[1] == '/' || in[1] == '\0')) {
				in += in[1] == '/' ? 2 : 1;
			} else {
				break;
			}
		}
	}

	*out = '\0';
}

/*
 * Case-insensitively, as php_cli_server.c does. Getting this wrong is not a
 * missing feature: a case-sensitive match declines "/A.PHP", and declining
 * means "not a script, embedder — serve it as a static file", so the answer to
 * the request is the PHP source.
 */
static int phasm_has_php_suffix(const char *path)
{
	size_t len = strlen(path);
	return len >= 4 && strcasecmp(path + len - 4, ".php") == 0;
}

/* }}} */

/* {{{ phasm_handle_request */

static void phasm_response_reset(void)
{
	smart_str_free_ex(&phasm_resp_body, 1);
	smart_str_free_ex(&phasm_resp_headers, 1);
	memset(&phasm_resp_body, 0, sizeof(phasm_resp_body));
	memset(&phasm_resp_headers, 0, sizeof(phasm_resp_headers));
	phasm_resp_status = 0;
}

/*
 * Run one HTTP request and record the response. `uri` is the request target
 * including any query string; `packed_headers` is `header_count` NUL-terminated
 * "Name: value" entries back to back; `body` may be NULL.
 *
 * Returns the HTTP status, or 0 to decline — the path resolved to something
 * that is not a PHP script, which the embedder should serve from the filesystem
 * itself. Nothing is guessed about content types here: this runs PHP, and a
 * service worker is far better placed to serve a .css file than this is.
 *
 * The response is read back through phasm_response_*() and stays valid until
 * the next call.
 */
EMSCRIPTEN_KEEPALIVE
int phasm_handle_request(const char *method, const char *uri,
	const char *packed_headers, int header_count,
	char *body, int body_len,
	const char *docroot, const char *packed_env, int envc)
{
	phasm_request r;
	char *path = NULL;
	char *script = NULL;
	char *script_name = NULL;
	const char *query = NULL;
	size_t decoded_len = 0;
	struct stat st;
	int status;

	phasm_response_reset();

	if (!phasm_started && phasm_startup(NULL) != 0) {
		return 500;
	}
	if (method == NULL || uri == NULL || docroot == NULL) {
		return 500;
	}

	memset(&r, 0, sizeof(r));

	/* Split the target, then decode only the path: a '?' inside an encoded
	 * path segment must not start the query string, and decoding the query
	 * here would destroy the '&' and '=' that $_GET is parsed from. */
	{
		const char *q = strchr(uri, '?');
		size_t path_len = q != NULL ? (size_t) (q - uri) : strlen(uri);

		query = q != NULL ? q + 1 : NULL;
		path = phasm_call_own(malloc(path_len + 1));
		if (path == NULL) {
			return 500;
		}
		memcpy(path, uri, path_len);
		path[path_len] = '\0';
		/* The *raw* decoder: '+' means a plus in a path and a space only in a
		 * query string, so decoding "/my+app.php" to "/my app.php" would 404 a
		 * file that is right there. php_cli_server.c makes the same choice. */
		decoded_len = php_raw_url_decode(path, path_len);
		path[decoded_len] = '\0';
	}

	/*
	 * An encoded NUL truncates every C string that follows it, so the checks
	 * below would inspect a prefix while something else acted on the whole
	 * thing — and phasm_path_escapes()'s strstr() would stop at the NUL and
	 * never reach the ".." after it. Refusing outright is the only version of
	 * this that stays true as the code around it changes.
	 */
	if (strlen(path) != decoded_len) {
		phasm_call_epilogue();
		return 400;
	}

	if (path[0] != '/' || phasm_path_escapes(path)) {
		phasm_call_epilogue();
		return 403;
	}

	/* Only after the refusal above, so normalisation can never be the thing
	 * that hides a climb. */
	phasm_normalize_path(path);

	/* docroot + path, then index.php for a directory. */
	size_t droot_len = strlen(docroot);
	{
		size_t need = droot_len + strlen(path) + sizeof("/index.php") + 1;

		/* A trailing slash on the docroot would produce "//" here, which is a
		 * different path to opcache and to include_once. */
		while (droot_len > 0 && docroot[droot_len - 1] == '/') {
			droot_len--;
		}

		script = phasm_call_own(malloc(need));
		if (script == NULL) {
			phasm_call_epilogue();
			return 500;
		}
		memcpy(script, docroot, droot_len);
		strcpy(script + droot_len, path);

		if (stat(script, &st) == 0 && S_ISDIR(st.st_mode)) {
			size_t len = strlen(script);
			if (len > 0 && script[len - 1] == '/') {
				len--;
			}
			strcpy(script + len, "/index.php");

			/* A directory with no index.php is not a PHP request, and saying
			 * 404 here makes it unreachable rather than merely not ours: the
			 * embedder can serve the index.html sitting right beside it, but
			 * only if it is handed the request back. */
			if (stat(script, &st) != 0 || !S_ISREG(st.st_mode)) {
				phasm_call_epilogue();
				return 0;
			}
		} else if (path[strlen(path) - 1] == '/') {
			/* A trailing slash asks for a directory, and POSIX answers ENOTDIR
			 * when the name resolves to a file. Emscripten's stat() answers for
			 * the file anyway, so "/app.php/" would reach the suffix check,
			 * fail it on the slash, and be declined — which tells the embedder
			 * to serve /app.php as a static file, i.e. to hand out the source.
			 * 404 is both the POSIX answer and the safe one. `path` always
			 * starts with '/', so indexing its last byte is safe. */
			phasm_call_epilogue();
			return 404;
		}
	}

	if (stat(script, &st) != 0 || !S_ISREG(st.st_mode)) {
		phasm_call_epilogue();
		return 404;
	}
	if (!phasm_has_php_suffix(script)) {
		phasm_call_epilogue();
		return 0; /* not ours — the embedder serves it */
	}

	/* SCRIPT_NAME is the resolved script's own path, which is `path` except
	 * where index.php was appended to a directory — and a router that reads it
	 * to strip its own prefix needs the difference. */
	script_name = phasm_call_own(strdup(script + droot_len));
	if (script_name == NULL) {
		phasm_call_epilogue();
		return 500;
	}

	r.method = method;
	r.uri = uri;
	r.path = path;
	r.query = query;
	r.script_filename = script;
	r.script_name = script_name;
	r.docroot = docroot;
	r.packed_headers = packed_headers;
	r.header_count = header_count;
	r.body = body;
	r.body_len = body_len > 0 ? (size_t) body_len : 0;
	r.status = 200;

	/* Cookie and Content-Type are the two headers PHP wants handed to it
	 * directly rather than found in $_SERVER. */
	{
		const char *entry = packed_headers;
		for (int i = 0; i < header_count && entry != NULL; i++) {
			const char *sep = strchr(entry, ':');
			if (sep != NULL) {
				size_t name_len = (size_t) (sep - entry);
				const char *value = sep + 1;
				while (*value == ' ' || *value == '\t') {
					value++;
				}
				if (name_len == sizeof("cookie") - 1
					&& strncasecmp(entry, "cookie", name_len) == 0) {
					r.cookies = (char *) value;
				} else if (name_len == sizeof("content-type") - 1
					&& strncasecmp(entry, "content-type", name_len) == 0) {
					SG(request_info).content_type = value;
				} else if (name_len == sizeof("host") - 1
					&& strncasecmp(entry, "host", name_len) == 0) {
					r.host = value;
				}
			}
			entry += strlen(entry) + 1;
		}
	}

	phasm_env_apply(packed_env, envc);

	phasm_call_cwd_saved = VCWD_GETCWD(phasm_call_cwd, sizeof(phasm_call_cwd)) != NULL;
	(void) VCWD_CHDIR(docroot);

	phasm_call_fd_mark = dup(STDIN_FILENO);
	if (phasm_call_fd_mark >= 0) {
		close(phasm_call_fd_mark);
	}

	phasm_hooks_install();

	/* do_cli() sets this for the CLI and nothing clears it, so a request that
	 * followed any command inherited "do not chdir to the script's directory" —
	 * making `getcwd()` in /blog/index.php the docroot after a command and
	 * /blog on a fresh instance. A request is a request whatever ran before it,
	 * and every other web SAPI chdirs. */
	SG(options) &= ~SAPI_OPTION_NO_CHDIR;

	SG(server_context) = &r;
	SG(request_info).request_method = method;
	SG(request_info).request_uri = script_name;
	SG(request_info).query_string = (char *) query;
	SG(request_info).path_translated = script;
	SG(request_info).content_length = r.body_len;
	/* Set before startup on purpose: sapi_activate() reads content_type to
	 * decide whether to read the post body, which is what fills $_POST and
	 * $_FILES. Anything sapi_activate() *writes* has to wait until after it. */
	SG(sapi_headers).http_response_code = 200;
	EG(exit_status) = 0;

	if (php_request_startup() == FAILURE) {
		/* Started far enough to need tearing down: RINIT has run for some
		 * modules, sapi_activate() has allocated the header list, and
		 * SG(sapi_started) is set. The stock CLI omits this and gets away with
		 * it by exiting; nothing here exits. */
		php_request_shutdown(NULL);
		status = 500;
	} else {
		zend_file_handle file_handle;

		/* sapi_activate() defaults this to HTTP/1.0, which is not what a
		 * service worker just handed us. */
		SG(request_info).proto_num = 1001;

		zend_stream_init_filename(&file_handle, script);
		file_handle.primary_script = 1;

		/* volatile because zend_first_try is setjmp: a local assigned inside the
		 * try and read after it is otherwise indeterminate on the bailout path. */
		volatile int ran = 0;
		volatile int fatal = 0;

		zend_first_try {
			ran = php_execute_script(&file_handle) ? 1 : 0;
		} zend_end_try();

		zend_destroy_file_handle(&file_handle);

		/* php_execute_script() reports false for a *clean* exit too, because
		 * zend_exception_error() returns FAILURE for the unwind-exit exception.
		 * So "returned false" cannot mean 500 on its own — `<?php render(); exit;`
		 * is how a great many front controllers finish, and calling that a server
		 * error would break the ordinary case rather than an exotic one. An
		 * actual fatal is the one that also left an error behind; PG(last_error_*)
		 * is cleared per request by php_free_request_globals(). */
		fatal = !ran
			&& PG(last_error_message) != NULL
			&& (PG(last_error_type) & E_FATAL_ERRORS) != 0;

		/* Headers are sent by php_request_shutdown() — step 1 runs the shutdown
		 * functions and step 6 deactivates the output layer, which sends them.
		 * Doing it here instead would commit the response *before* a
		 * register_shutdown_function() had its chance to call header(), which
		 * works under every other web SAPI. That is also why the status is read
		 * afterwards: send_headers is what records it. */
		php_request_shutdown(NULL);

		status = r.status;

		/* A fatal is a 500 — but only if the script did not already say
		 * otherwise, because a handler that sends a 403 and then dies still
		 * meant the 403. */
		if (fatal && status == 200) {
			status = 500;
		}
	}

	phasm_hooks_restore();

	/* SG(request_info).cookie_data is the piece of the epilogue below that is
	 * not merely tidy: it points into the packed headers, which the caller frees
	 * the moment this returns — and sapi_activate() only refreshes it `if
	 * (SG(server_context))`, which no command has. So a leftover pointer is not
	 * overwritten by the next call: it is parsed, and `php -r
	 * 'print_r($_COOKIE);'` after a request prints whatever the allocator has
	 * since put in that freed buffer. */
	phasm_call_epilogue();

	phasm_resp_status = status;

	return status;
}
/* }}} */

/* {{{ reading the response back */

EMSCRIPTEN_KEEPALIVE
int phasm_response_status(void)
{
	return phasm_resp_status;
}

/* "Name: value" lines, newline-separated. Empty when the script sent none. */
EMSCRIPTEN_KEEPALIVE
const char *phasm_response_headers(void)
{
	if (phasm_resp_headers.s == NULL) {
		return "";
	}
	/* Only writes the terminator into space smart_str_alloc already reserved,
	 * so it does not care which allocator the buffer came from. */
	smart_str_0(&phasm_resp_headers);
	return ZSTR_VAL(phasm_resp_headers.s);
}

/* Bytes, not a string: a response body is just as likely to be a PNG. */
EMSCRIPTEN_KEEPALIVE
char *phasm_response_body(void)
{
	return phasm_resp_body.s != NULL ? ZSTR_VAL(phasm_resp_body.s) : NULL;
}

EMSCRIPTEN_KEEPALIVE
int phasm_response_body_length(void)
{
	return phasm_resp_body.s != NULL ? (int) ZSTR_LEN(phasm_resp_body.s) : 0;
}

/* }}} */

/* {{{ phasm_recover */

/*
 * Finish a call a wasm trap abandoned.
 *
 * A trap is not an error PHP can see. It destroys the wasm frames and resumes
 * in JS, so the call's zend_end_try() never runs, its epilogue never runs, and
 * — the part that is visible to a user — php_request_shutdown() never runs. The
 * instance keeps working, which is the trap in the other sense: the next call
 * succeeds while printing "Constant PHP_CLI_PROCESS_TITLE already defined" and
 * the same for STDIN, STDOUT and STDERR, because the abandoned request's
 * constants are still registered. That is then true of every `php` for the rest
 * of the session.
 *
 * Two shapes were possible, and the second is only defensible if the first is
 * unsafe: finish the abandoned request, or declare the instance spent. Finishing
 * it is safe, and php_request_shutdown() is where the evidence is — it opens by
 * setting EG(current_execute_data) to NULL, with a comment that it "points into
 * nirvana", and every step after that is individually wrapped in zend_try. It is
 * written to be reachable after a bailout, which is very nearly this. The
 * remaining hazard is ours rather than PHP's, and it is handled below.
 *
 * src/phasm-glue.js calls this from the catch around every entry point, and
 * declares the instance spent if it does not return cleanly — so "refuse" is
 * still the answer where recovery genuinely cannot work, and is not the answer
 * to the ordinary case of one script recursing too deep.
 *
 * Returns 1 if a request was finished, 0 if there was nothing to finish, and
 * -1 if it cannot be finished safely.
 */
EMSCRIPTEN_KEEPALIVE
int phasm_recover(void)
{
	int finished = 0;

	if (!phasm_started) {
		return 0;
	}

	/*
	 * The one case where finishing the request is worse than refusing to: the
	 * trap came from *inside* php_request_shutdown(), which is reachable because
	 * step 1 runs register_shutdown_function() callbacks and step 2 runs
	 * __destruct(), both of them arbitrary userland code that can recurse as
	 * deep as anything else. Running the shutdown again from the top would run
	 * those callbacks and destructors a second time, on a request that is
	 * already half torn down — side effects duplicated, against state that is
	 * partly freed.
	 *
	 * SG(sapi_started) cannot tell that apart, because the shutdown only clears
	 * it at step 12. This flag can: php_request_shutdown() raises it on entry,
	 * and init_executor() clears it at the next request's zend_activate(), so it
	 * means precisely "a shutdown was in progress and did not finish".
	 *
	 * Nothing is cleaned up on the way out, deliberately: the caller's answer to
	 * -1 is to stop using the instance, and unwinding state a half-run shutdown
	 * may still hold is exactly the guessing this branch exists to refuse.
	 */
	if (SG(sapi_started) && (EG(flags) & EG_FLAGS_IN_SHUTDOWN)) {
		return -1;
	}

	/*
	 * The hazard that is ours: zend_first_try's jmp_buf is a local of the frame
	 * the trap destroyed, and EG(bailout) still points at it. Any zend_bailout()
	 * from here on — and php_request_shutdown() runs shutdown functions and
	 * destructors, which is arbitrary userland code — would longjmp into a dead
	 * stack. NULL is how "no handler installed" is spelled, and every zend_try
	 * inside the shutdown installs its own over it.
	 */
	EG(bailout) = NULL;

	/*
	 * The server-mode request struct is a local of that same frame. Clearing it
	 * before the shutdown is what keeps the hooks off it while output is flushed
	 * — they are written to work without it, which is why phasm_ub_write() takes
	 * no reference to the request at all.
	 */
	SG(server_context) = NULL;

	if (SG(sapi_started)) {
		zend_first_try {
			php_request_shutdown(NULL);
		} zend_end_try();
		finished = 1;
	}

	phasm_hooks_restore();
	phasm_call_epilogue();

	return finished;
}
/* }}} */
