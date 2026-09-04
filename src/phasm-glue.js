// SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>
//
// SPDX-License-Identifier: ISC

// Linked into the module by --post-js (see scripts/env.sh), which places this
// inside the MODULARIZE factory after the runtime is up and before the factory
// resolves. So Module.run exists by the time the caller has a module.
//
// This is the embedding API: run() and phasmHandleRequest() are what an
// embedder should reach for, and phasmRun() is the primitive underneath them.
// It lives in the artifact rather than in each consumer because the
// packed-string calling convention is an implementation detail of
// sapi/phasm/phasm.c, and nobody should have to re-derive it — the same reason
// src/phasm-stdio.js owns the standard streams, which is where the output
// run() returns comes from.

/**
 * Pack strings the way phasm_run() reads them: NUL-terminated, back to back.
 * stringToUTF8 writes embedded NULs verbatim, so one conversion does it.
 * Returns 0 for an empty list, which the C side reads as "none".
 *
 * A NUL inside an entry is the one thing this encoding cannot carry: it would
 * arrive as an early terminator and silently truncate the argument, so
 * `-r 'echo "a\0b";'` would reach PHP as `-r 'echo "a'` and fail as a parse
 * error somewhere else entirely. Refuse it instead. Nothing is lost — argv and
 * the environment cannot hold a NUL on a real system either.
 */
function phasmPackStrings(list) {
  if (!list.length) return 0;
  return stringToNewUTF8(list.join('\0') + '\0');
}

/**
 * Run one entry point into the SAPI, and put the instance back together if a
 * wasm trap unwinds out of it.
 *
 * A trap — deep recursion reaching the JS engine's wasm frame limit is the one
 * a script can reach, and no emcc flag sizes that stack — resumes here with the
 * guest's frames gone and PHP still mid-request. Left alone the instance keeps
 * working and prints "Constant PHP_CLI_PROCESS_TITLE already defined" on stderr
 * for every later call, so one bad script costs the rest of the session.
 * phasm_recover() finishes the abandoned request; see the note there for why
 * finishing it is safe rather than merely hopeful.
 *
 * The error is re-thrown either way: this call did fail, and a caller that
 * learned otherwise would report success for a script that never finished.
 *
 * Recovery covers more than it looks like it should — a script that recurses
 * until the module is out of memory comes back too, because the arena it could
 * not allocate in is the abandoned request's own and the shutdown is what
 * releases it. The one case it cannot cover is a trap raised *during* that
 * shutdown, and there the instance is marked spent and says so rather than
 * leaving every later call to fail somewhere less obvious.
 */
let phasmSpent = null;

function phasmEnter(fn) {
  if (phasmSpent) throw phasmSpent;

  // The C stack pointer is a wasm global that each function lowers on entry and
  // raises on return. A trap skips every return, so it stays wherever the
  // deepest abandoned frame left it — and the next call lowers it again from
  // there. That leak is cumulative and completely silent: this build has no
  // STACK_OVERFLOW_CHECK, so the end of it is not a diagnosable crash but the
  // memory corruption scripts/env.sh sizes STACK_SIZE against. Restoring it is
  // also what gives phasm_recover() a stack to run PHP's shutdown on.
  const stack = stackSave();

  try {
    return fn();
  } catch (trap) {
    stackRestore(stack);

    let recovered = -1;
    try {
      recovered = _phasm_recover();
    } catch (e) {
      // Recovery trapped in its turn, which strands the stack pointer again.
      stackRestore(stack);
      recovered = -1;
    }

    // -1 is phasm_recover() declining rather than failing: the trap came from
    // inside PHP's own request shutdown, and running that again would re-run
    // shutdown functions and destructors on a half-freed request. Refusing from
    // here on is the honest answer, and it is a far narrower one than refusing
    // after every trap — an ordinary script recursing too deep never lands here.
    if (recovered < 0) {
      phasmSpent = new Error(
        'phasm: this instance is no longer usable. A call trapped while PHP was '
        + 'shutting the request down, which cannot be finished a second time. '
        + 'Create a new module.',
      );
      phasmSpent.cause = trap;
    }

    throw trap;
  }
}

/**
 * The C stack pointer, for asserting that a trapped call gave it back.
 *
 * Diagnostic rather than API: nothing an embedder does should need it. It is
 * exposed because the leak it detects is invisible until the corruption it
 * causes surfaces somewhere unrelated, which is not a thing a test can wait for.
 *
 * @returns {number}
 */
Module['phasmStackPointer'] = function () {
  return stackSave();
};

/**
 * Name/value pairs out of whatever the caller had.
 *
 * `Object.entries()` alone is not enough, and the shape it misses is the one
 * the docs invite: a `Headers` has no own enumerable keys, so
 * `Object.entries(request.headers)` is `[]` — a POST arriving with no
 * Content-Type and no Cookie, which PHP reports as an empty `$_POST` and a
 * brand-new session rather than as an error. Anything iterable of pairs works
 * now (`Headers`, `Map`, an array of pairs); a plain object still does.
 *
 * A string is iterable too and is never what was meant, so it is refused
 * rather than spread into single characters.
 */
function phasmPairs(value, what) {
  if (value === null || value === undefined) return [];
  if (typeof value === 'string') {
    throw new TypeError(`phasmHandleRequest: ${what} must be an object, a Headers, a Map or an array of pairs, not a string`);
  }
  const entries = typeof value[Symbol.iterator] === 'function' ? [...value] : Object.entries(value);
  return entries.map((pair) => {
    if (!pair || typeof pair[Symbol.iterator] !== 'function') {
      throw new TypeError(`phasmHandleRequest: ${what} must yield [name, value] pairs`);
    }
    const [k, v] = pair;
    return [String(k), String(v)];
  });
}

/**
 * Checked before anything is allocated, so a rejected call leaks nothing.
 *
 * `where` names the entry point rather than always saying phasmRun(), because
 * this is the one message a caller gets for a mistake three layers down and
 * being told the wrong function made it is worse than being told nothing.
 */
function phasmRejectNuls(list, what, where) {
  for (const s of list) {
    if (s.indexOf('\0') !== -1) {
      throw new TypeError(`${where}: ${what} may not contain a NUL byte: ${JSON.stringify(s)}`);
    }
  }
}

/**
 * Run `fn` with the caller's interrupt poll installed.
 *
 * The poll is what makes a running script stoppable at all: PHP samples it at
 * the VM safe points it already checks EG(vm_interrupt) at, because under
 * single-threaded wasm nothing else can be running to raise that flag (the long
 * version is in sapi/phasm/phasm.c). Absent, the sampling is not installed and
 * the VM pays one predictable branch on a null global.
 *
 * It must answer the question "was THIS call interrupted", so it is installed
 * per call rather than per module: wasi-sh's `ctx.interrupted()` closes over the
 * interrupt count the command started at, which is what keeps a ^C typed at an
 * idle prompt from cancelling whatever is typed next.
 *
 * The previous one is put back rather than cleared, because a run() reached
 * from inside another call's output sink is a shape nothing forbids.
 */
function phasmWithInterrupt(interrupted, fn) {
  const previous = Module['phasmInterruptPoll'];
  Module['phasmInterruptPoll'] = typeof interrupted === 'function' ? interrupted : null;
  try {
    return fn();
  } finally {
    Module['phasmInterruptPoll'] = previous;
  }
}

/**
 * Run PHP once on this instance. `args` is argv without argv[0].
 *
 * Unlike callMain(), this can be called any number of times: it never exits the
 * process, the exit status is per call, and cwd and env apply to this call
 * only. The two entry points are mutually exclusive — a module that has run
 * callMain() cannot use phasmRun() and vice versa.
 *
 * `interrupted` is polled while the script runs; answering true stops it with a
 * fatal and an exit status of 130, the status a shell reports for SIGINT. Pass
 * `ctx.interrupted` straight through from a wasi-sh builtin context.
 *
 * @param {string[]} args
 * @param {{cwd?: string, env?: Record<string, string>,
 *          interrupted?: () => boolean}} [opts]
 * @returns {number} the exit status
 */
Module['phasmRun'] = function (args, opts) {
  opts = opts || {};
  phasmRefuseAfterCallMain('phasmRun()');

  const argv = ['php'].concat(args || []).map(String);
  const env = Object.entries(opts.env || {}).map(([k, v]) => `${k}=${v}`);

  phasmRejectNuls(argv, 'an argument', 'phasmRun');
  phasmRejectNuls(env, 'an environment entry', 'phasmRun');
  if (opts.cwd) phasmRejectNuls([opts.cwd], 'cwd', 'phasmRun');

  // Inside the try, so that a second allocation failing does not strand the
  // first. Same reasoning as phasmHandleRequest(); nothing here is reachable
  // by an argument mistake, because phasmRejectNuls() has already run.
  let argvPtr = 0;
  let envPtr = 0;
  let cwdPtr = 0;

  try {
    argvPtr = phasmPackStrings(argv);
    envPtr = phasmPackStrings(env);
    cwdPtr = opts.cwd ? stringToNewUTF8(opts.cwd) : 0;

    return phasmWithInterrupt(opts.interrupted,
      () => phasmEnter(() => _phasm_run(argvPtr, argv.length, cwdPtr, envPtr, env.length)));
  } finally {
    if (argvPtr) _free(argvPtr);
    if (envPtr) _free(envPtr);
    if (cwdPtr) _free(cwdPtr);
  }
};

/** Create every missing directory above `path`, `mkdir -p` fashion. */
function phasmMkdirp(path) {
  const parts = path.split('/').slice(0, -1).filter(Boolean);
  let dir = path.charAt(0) === '/' ? '' : '.';
  for (const part of parts) {
    dir += `/${part}`;
    try {
      FS.mkdir(dir);
    } catch (e) {
      /* already there, or a file is in the way — writeFile reports that one */
    }
  }
}

/** Where `run({script})` puts the script, mirroring wasi-sh's /main.sh. */
const PHASM_MAIN = '/main.php';

/**
 * A `files` key, resolved where the call is going to run.
 *
 * The chdir() to `options.cwd` happens inside phasm_run(), which is after
 * everything here is written — so a relative key used to land wherever the
 * module's directory happened to be, and `run({ cwd: '/app', files: {
 * 'index.php': … }, args: ['index.php'] })` wrote /index.php and then could
 * not open it. The two halves of one call have to agree about what a relative
 * path means, and `cwd` is what the caller said it means.
 *
 * `script` needs none of this: it goes to an absolute path and is run by that
 * absolute path, so it lands the same wherever the call runs.
 */
function phasmAt(path, cwd) {
  if (!cwd || path.charAt(0) === '/') return path;
  return `${cwd.replace(/\/+$/, '')}/${path}`;
}

/**
 * Run PHP once and collect everything it produced.
 *
 * ```js
 * const { stdout, stderr, exitCode } = php.run({ code: 'echo 6 * 7;' });
 * ```
 *
 * The result is `wasi-sh`'s: {stdout, stderr, exitCode}, from options with the
 * same names and meanings, so a shell run and a PHP run compose without an
 * adapter between them. It returns synchronously — the instance is already
 * warm and PHP is a wasm frame below the call — and awaiting it anyway is
 * harmless, which keeps the two interchangeable in ordinary code.
 *
 * Everything here is per call: `env` and `cwd` are gone by the next one, output
 * belongs to this call alone, and stdin is refilled. What survives is the
 * filesystem, the instance and its ini.
 *
 * @param {{args?: string[], code?: string, script?: string,
 *          files?: Record<string, string|Uint8Array>,
 *          stdin?: string|Uint8Array|((max: number) => Uint8Array|null),
 *          cwd?: string, env?: Record<string, string>,
 *          interrupted?: () => boolean,
 *          onOutput?: (bytes: Uint8Array, channel: 'stdout'|'stderr') => void,
 *          collect?: boolean}} [options]
 * @returns {{stdout: string, stderr: string, exitCode: number}}
 */
Module['run'] = function (options) {
  options = options || {};

  for (const [key, content] of Object.entries(options.files || {})) {
    const path = phasmAt(key, options.cwd);
    phasmMkdirp(path);
    FS.writeFile(path, content);
  }

  if (typeof options.script === 'string') {
    FS.writeFile(PHASM_MAIN, options.script);
  }

  // argv wins where it is given, as it does in wasi-sh: `script` is a file that
  // was mounted, and mounting it is worth doing even when something else runs.
  let args = options.args;
  if (!args) {
    if (typeof options.code === 'string') args = ['-r', options.code];
    else if (typeof options.script === 'string') args = [PHASM_MAIN];
    else args = [];
  }

  const captured = Module['phasmCapture'](
    () => Module['phasmRun'](args, {
      cwd: options.cwd,
      env: options.env,
      interrupted: options.interrupted,
    }),
    options,
  );

  return { stdout: captured.stdout, stderr: captured.stderr, exitCode: captured.value };
};

/**
 * Run `fn` with the module's stdout, stderr and stdin routed to this call.
 *
 * The primitive under run(), exposed because it is the only way to collect
 * output from anything run() does not cover — a warning raised during
 * phasmHandleRequest(), or a one-shot callMain().
 *
 * An `onOutput` that throws fails this call, and it says so by throwing that
 * same error back out. It has to be raised from here rather than from where it
 * happened: the sink runs in a wasm frame, and Emscripten's TTY write turns
 * anything raised there into EIO — so PHP sees a failed write, gives up, and
 * without this the call returns a bare 255 with the reason gone. Raised after
 * the capture is finished, so it never displaces a trap that got here first.
 *
 * @param {() => any} fn
 * @param {{stdin?: string|Uint8Array|((max: number) => Uint8Array|null),
 *          onOutput?: (bytes: Uint8Array, channel: 'stdout'|'stderr') => void,
 *          collect?: boolean}} [opts]
 * @returns {{stdout: string, stderr: string, value: any}}
 */
Module['phasmCapture'] = function (fn, opts) {
  phasmStdio.begin(opts || {});

  let value;
  let captured;
  try {
    value = fn();
  } finally {
    captured = phasmStdio.end();
  }

  if (captured.failure) throw captured.failure;

  return { stdout: captured.stdout, stderr: captured.stderr, value };
};

/**
 * Handle one HTTP request and return the response.
 *
 * The shape is deliberately the web platform's, so a service worker can pass
 * `request.method`, `request.url`'s path and `request.headers` straight in and
 * build a `Response` straight out.
 *
 * `body` is bytes, and so is the body that comes back: a response is as likely
 * to be a PNG as a page, and a round trip through a string would corrupt it.
 *
 * A status of 0 means the path resolved to something that is not a PHP script.
 * That is a decline, not an error — serve it from the filesystem yourself.
 * Deciding that a `.css` file is `text/css` is the embedder's job, not PHP's.
 *
 * Response headers come back as [name, value] pairs, repeats included.
 *
 * `interrupted` is polled while the handler runs, exactly as run()'s is. A
 * request stopped that way is a fatal, so it comes back as an ordinary 500
 * rather than as nothing at all — which is the point, since the fetch on the
 * other side of it is being held open.
 *
 * `fallback` is the front controller: a docroot-relative `.php` script that
 * answers any path with no file behind it, which is `try_files $uri
 * /index.php` and Apache's `FallbackResource` in one option. Without it a
 * framework's pretty URLs are 404s for routes that are right there. It changes
 * nothing for a path that does resolve, and a request it does answer gets
 * nginx's shape — REQUEST_URI as asked, SCRIPT_NAME the front controller, no
 * PATH_INFO.
 *
 * `prefix` is where the site sits in the browser's URL space, put back. The
 * docroot never sees it — a service worker strips its own base so the same
 * project serves from anywhere — and the cost of that was an app unable to
 * build a correct link to itself. It rejoins REQUEST_URI, SCRIPT_NAME and
 * PHP_SELF, and nothing that names a file.
 *
 * @param {{method?: string, url: string, headers?: Record<string, string>,
 *          body?: Uint8Array, docroot?: string, fallback?: string,
 *          prefix?: string, env?: Record<string, string>,
 *          interrupted?: () => boolean}} req
 * @returns {{status: number, headers: [string, string][], body: Uint8Array}}
 */
Module['phasmHandleRequest'] = function (req) {
  phasmRefuseAfterCallMain('phasmHandleRequest()');

  const method = String(req.method || 'GET');
  const url = String(req.url);
  const docroot = String(req.docroot || '/');
  // '' rather than a null pointer: the C side treats an empty string as "no
  // front controller", so `fallback: undefined` and `fallback: ''` mean the
  // same thing and neither needs a second allocation path here.
  const fallback = req.fallback == null ? '' : String(req.fallback);
  const prefix = req.prefix == null ? '' : String(req.prefix);
  const headers = phasmPairs(req.headers, 'headers').map(([k, v]) => `${k}: ${v}`);
  const env = phasmPairs(req.env, 'env').map(([k, v]) => `${k}=${v}`);

  phasmRejectNuls([method, url, docroot, fallback, prefix], 'the request', 'phasmHandleRequest');
  phasmRejectNuls(headers, 'a header', 'phasmHandleRequest');
  phasmRejectNuls(env, 'an environment entry', 'phasmHandleRequest');

  // A string is encoded rather than refused, the same way run()'s stdin takes
  // one: `body: 'a=1'` is the obvious thing to write and it used to be the
  // worst possible outcome — a string is array-like, so HEAPU8.set() indexed
  // it, coerced each character to NaN and stored a run of NUL bytes. The
  // request then succeeded, with the right Content-Length, an empty $_POST and
  // a php://input full of nothing.
  //
  // Decided before anything is allocated, for the same reason phasmRejectNuls()
  // runs where it does: this guard's own TypeError is the mistake it exists to
  // catch, and it used to be raised with five allocations already held and no
  // `finally` yet in scope to give them back. A service worker retrying a
  // malformed request leaked the heap away a few hundred bytes at a time.
  const bodyBytes = typeof req.body === 'string'
    ? new TextEncoder().encode(req.body)
    : req.body || new Uint8Array(0);
  if (!(bodyBytes instanceof Uint8Array)) {
    throw new TypeError('phasmHandleRequest: body must be a string or Uint8Array');
  }

  let methodPtr = 0;
  let urlPtr = 0;
  let docrootPtr = 0;
  let fallbackPtr = 0;
  let prefixPtr = 0;
  let headersPtr = 0;
  let envPtr = 0;
  let bodyPtr = 0;

  let status;
  try {
    methodPtr = stringToNewUTF8(method);
    urlPtr = stringToNewUTF8(url);
    docrootPtr = stringToNewUTF8(docroot);
    fallbackPtr = stringToNewUTF8(fallback);
    prefixPtr = stringToNewUTF8(prefix);
    headersPtr = phasmPackStrings(headers);
    envPtr = phasmPackStrings(env);

    // The body is copied into the module's heap because PHP reads it during the
    // request, and a JS-side view could be detached by a heap growth mid-call.
    if (bodyBytes.length) {
      bodyPtr = _malloc(bodyBytes.length);
      // _malloc answers a failure with 0, and the length went to PHP anyway:
      // the copy above was skipped, so php://input was read from address 0
      // with a correct Content-Length and the request served whatever happened
      // to be at the bottom of the heap. Refusing is the only honest answer —
      // there is no shorter body to fall back to.
      if (!bodyPtr) {
        throw new Error(
          `phasmHandleRequest: no room for a ${bodyBytes.length}-byte request body`,
        );
      }
      HEAPU8.set(bodyBytes, bodyPtr);
    }

    status = phasmWithInterrupt(req.interrupted, () => phasmEnter(() => _phasm_handle_request(
      methodPtr, urlPtr, headersPtr, headers.length,
      bodyPtr, bodyBytes.length, docrootPtr, fallbackPtr, prefixPtr, envPtr, env.length,
    )));
  } finally {
    if (methodPtr) _free(methodPtr);
    if (urlPtr) _free(urlPtr);
    if (docrootPtr) _free(docrootPtr);
    if (fallbackPtr) _free(fallbackPtr);
    if (prefixPtr) _free(prefixPtr);
    if (headersPtr) _free(headersPtr);
    if (envPtr) _free(envPtr);
    if (bodyPtr) _free(bodyPtr);
  }

  // Copied out for the same reason the body was copied in: these point into the
  // module's heap and the next call frees them.
  const len = _phasm_response_body_length();
  const ptr = _phasm_response_body();
  const body = len > 0 && ptr
    ? new Uint8Array(HEAPU8.subarray(ptr, ptr + len))
    : new Uint8Array(0);

  // Pairs rather than an object, because HTTP headers are not a map: Set-Cookie
  // legitimately repeats, and neither collapsing choice survives it. Keeping the
  // last one loses cookies; joining with ", " produces a single header a browser
  // reads as one cookie whose value contains the rest — and it cannot be split
  // back out, because an Expires date has a comma in it. `new Headers(pairs)`
  // takes this shape directly, which is where a service worker is going anyway.
  const sent = [];
  const raw = UTF8ToString(_phasm_response_headers());
  for (const line of raw.split('\n')) {
    const colon = line.indexOf(':');
    if (colon > 0) {
      sent.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()]);
    }
  }

  return { status, headers: sent, body };
};

/**
 * Start PHP explicitly, with optional ini settings for the life of the
 * instance. phasmRun() does this on first use with no settings, so this is only
 * needed to pass ini — per-call `-d` is not supported on this path.
 *
 * Through phasmEnter() like the other two entry points, which it was not.
 * Startup runs module init and every extension's MINIT, so it is C that can
 * trap like any other — and a trap here stranded the C stack pointer with
 * nothing to put it back, which is the silent cumulative leak §4.8 exists to
 * stop. It also means a spent instance says so here too, instead of being the
 * one door left open into a module that cannot be used.
 *
 * **-1 is not what callMain() gets**, and this used to say it was. A module
 * that already ran callMain() *throws* here, exactly as it does from
 * phasmRun() and phasmHandleRequest(), and for the reason written at
 * phasmRefuseAfterCallMain(): a status is what a script's own failure looks
 * like, and a structural mistake reported as one is a mistake nobody finds.
 * What -1 does mean is settings that cannot be applied — ini passed to an
 * instance where PHP is already up, where these are module-startup settings
 * and there is no honest way to honour them.
 *
 * @param {string} [ini] newline-separated "name=value" lines
 * @returns {number} 0, or -1 if PHP is already up and `ini` cannot be applied
 * @throws {TypeError} if `ini` holds a NUL byte
 * @throws {Error} if this module already ran callMain()
 */
Module['phasmStartup'] = function (ini) {
  phasmRefuseAfterCallMain('phasmStartup()');

  // The one entry point that skipped this. The packing is NUL-terminated, so a
  // NUL in an ini block is not an error anywhere: it is an early terminator,
  // and everything after it is dropped while the call reports success — a
  // module running on half the settings it was given, and nothing said.
  if (ini) phasmRejectNuls([String(ini)], 'ini settings', 'phasmStartup');

  let iniPtr = 0;
  try {
    iniPtr = ini ? stringToNewUTF8(ini) : 0;
    return phasmEnter(() => _phasm_startup(iniPtr));
  } finally {
    if (iniPtr) _free(iniPtr);
  }
};

// callMain() re-enters the CLI's main(), which starts the module. On an
// instance where PHP is already up that traps — "null function or function
// signature mismatch" — and takes the instance with it, so every later
// phasmRun() throws too. phasm_startup() already refuses the opposite order;
// this is the same refusal in the direction Emscripten owns, and it has to live
// here because callMain() is a JS function that never reaches C.
let phasmCallMainCalled = false;

const phasmCallMain = Module['callMain'];
if (phasmCallMain) {
  Module['callMain'] = function (args) {
    if (_phasm_is_started()) {
      throw new Error(
        'phasm: callMain() and phasmRun() are mutually exclusive, and this '
        + 'module has already started PHP. Use phasmRun().',
      );
    }
    phasmCallMainCalled = true;
    return phasmCallMain.apply(this, arguments);
  };
}

// The same refusal in the other direction. The C side already declines — it
// checks sapi_module.name and gives up — but it can only report that as an
// ordinary failure status, and 255 from phasmRun() is indistinguishable from
// `php -l` on a parse error while 500 from a request is indistinguishable from
// a fatal. Silently returning "something went wrong" for a mistake this
// structural is the one case worth an exception.
//
// The wrapper above is the whole answer because it is the only route: the build
// links with INVOKE_RUN=0 (see scripts/env.sh), so nothing calls main() unless
// an embedder asks for it by name. That flag is what made `await Phasm()` with
// no options a working instance instead of one that had already spent its main()
// before the caller got it.
function phasmRefuseAfterCallMain(what) {
  if (!phasmCallMainCalled) return;

  throw new Error(
    `phasm: ${what} and callMain() are mutually exclusive, and this module has `
    + 'already run callMain(). Create a new module.',
  );
}
