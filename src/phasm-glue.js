// SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>
//
// SPDX-License-Identifier: ISC

// Linked into the module by --post-js (see scripts/env.sh), which places this
// inside the MODULARIZE factory after the runtime is up and before the factory
// resolves. So Module.phasmRun exists by the time the caller has a module.
//
// This is only argv/cwd/env marshalling. It lives in the artifact rather than
// in each consumer because the packed-string calling convention is an
// implementation detail of sapi/phasm/phasm.c, and nobody should have to
// re-derive it. Output is still collected the way Emscripten collects it — via
// FS.init() sinks the caller swaps per invocation.

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

/** Checked before anything is allocated, so a rejected call leaks nothing. */
function phasmRejectNuls(list, what) {
  for (const s of list) {
    if (s.indexOf('\0') !== -1) {
      throw new TypeError(`phasmRun: ${what} may not contain a NUL byte: ${JSON.stringify(s)}`);
    }
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
 * @param {string[]} args
 * @param {{cwd?: string, env?: Record<string, string>}} [opts]
 * @returns {number} the exit status
 */
Module['phasmRun'] = function (args, opts) {
  opts = opts || {};

  const argv = ['php'].concat(args || []).map(String);
  const env = Object.entries(opts.env || {}).map(([k, v]) => `${k}=${v}`);

  phasmRejectNuls(argv, 'an argument');
  phasmRejectNuls(env, 'an environment entry');
  if (opts.cwd) phasmRejectNuls([opts.cwd], 'cwd');

  const argvPtr = phasmPackStrings(argv);
  const envPtr = phasmPackStrings(env);
  const cwdPtr = opts.cwd ? stringToNewUTF8(opts.cwd) : 0;

  try {
    return _phasm_run(argvPtr, argv.length, cwdPtr, envPtr, env.length);
  } finally {
    if (argvPtr) _free(argvPtr);
    if (envPtr) _free(envPtr);
    if (cwdPtr) _free(cwdPtr);
  }
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
 * @param {{method?: string, url: string, headers?: Record<string, string>,
 *          body?: Uint8Array, docroot?: string, env?: Record<string, string>}} req
 * @returns {{status: number, headers: [string, string][], body: Uint8Array}}
 */
Module['phasmHandleRequest'] = function (req) {
  const method = String(req.method || 'GET');
  const url = String(req.url);
  const docroot = String(req.docroot || '/');
  const headers = Object.entries(req.headers || {}).map(([k, v]) => `${k}: ${v}`);
  const env = Object.entries(req.env || {}).map(([k, v]) => `${k}=${v}`);

  phasmRejectNuls([method, url, docroot], 'the request');
  phasmRejectNuls(headers, 'a header');
  phasmRejectNuls(env, 'an environment entry');

  const methodPtr = stringToNewUTF8(method);
  const urlPtr = stringToNewUTF8(url);
  const docrootPtr = stringToNewUTF8(docroot);
  const headersPtr = phasmPackStrings(headers);
  const envPtr = phasmPackStrings(env);

  // The body is copied into the module's heap because PHP reads it during the
  // request, and a JS-side view could be detached by a heap growth mid-call.
  const bodyBytes = req.body || new Uint8Array(0);
  const bodyPtr = bodyBytes.length ? _malloc(bodyBytes.length) : 0;
  if (bodyPtr) HEAPU8.set(bodyBytes, bodyPtr);

  let status;
  try {
    status = _phasm_handle_request(
      methodPtr, urlPtr, headersPtr, headers.length,
      bodyPtr, bodyBytes.length, docrootPtr, envPtr, env.length,
    );
  } finally {
    _free(methodPtr);
    _free(urlPtr);
    _free(docrootPtr);
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
 * @param {string} [ini] newline-separated "name=value" lines
 * @returns {number} 0 on success, -1 if this module already ran callMain()
 */
Module['phasmStartup'] = function (ini) {
  const iniPtr = ini ? stringToNewUTF8(ini) : 0;
  try {
    return _phasm_startup(iniPtr);
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
const phasmCallMain = Module['callMain'];
if (phasmCallMain) {
  Module['callMain'] = function (args) {
    if (_phasm_is_started()) {
      throw new Error(
        'phasm: callMain() and phasmRun() are mutually exclusive, and this '
        + 'module has already started PHP. Use phasmRun().',
      );
    }
    return phasmCallMain.apply(this, arguments);
  };
}

