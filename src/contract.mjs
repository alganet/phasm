// SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>
//
// SPDX-License-Identifier: ISC

/**
 * What a runtime has to implement to be hosted by this stack.
 *
 * Everything in `@alganet/phasm` except the wasm itself is language-neutral —
 * the request wire, the service-worker proxy, the CGI router, the store mount,
 * the editor's file channel — and this module is the short list of what any of
 * it actually asks of the thing running the code. It is written down separately
 * because it is *small*, and because nobody can tell that from reading five
 * files that all say `php` in their names.
 *
 * ## The whole of it
 *
 * ```js
 * const runtime = {
 *   // A CLI invocation. `wasi-sh`'s vocabulary, not PHP's, so a shell run and
 *   // a runtime run compose with nothing between them.  → a shell host builtin
 *   run({ args, cwd, env, stdin, interrupted, collect, onOutput }) {
 *     return { stdout, stderr, exitCode };
 *   },
 *
 *   // …and `collect: false` with an `onOutput` means STREAM, do not buffer.
 *   // That is a requirement rather than an optimisation: it is how the shell
 *   // builtin runs every command, because the shell's descriptors are already
 *   // where the output belongs and nobody is waiting for a returned string.
 *   // A runtime that ignores it prints nothing at the prompt and looks broken.
 *
 *   // One HTTP request cycle, SYNCHRONOUSLY.               → an HTTP wire       
 *   phasmHandleRequest({ url, method, headers, body, docroot, fallback, prefix, env, interrupted }) {
 *     return { status, headers, body };   // headers are [name, value] PAIRS
 *   },
 *
 *   // Optional. Route output produced OUTSIDE the response — a warning, the
 *   // text of a fatal — somewhere other than the reply. A runtime that writes
 *   // nothing beside its response needs none.
 *   phasmCapture(fn, { collect, onOutput }) { return { value: fn() }; },
 *
 *   // Optional. Emscripten's filesystem, which the router resolves over.
 *   // A runtime with none passes `files` to the router instead.
 *   FS: { stat(path), readFile(path) },
 * };
 * ```
 *
 * A `Phasm()` module satisfies all of it as it is. Nothing else in the package
 * asks for anything more.
 *
 * ## Synchronous is structural, not a preference
 *
 * A live `wasi-sh` session is one `_start()` frame, so the worker's event loop
 * never turns while the guest runs and there is nothing to await into. A
 * handler returning a promise is not slow, it is *not delivered*. That is the
 * one requirement here a runtime cannot negotiate.
 *
 * ## Why PHP is the hard case and not the representative one
 *
 * PHP's web semantics live in the engine, in C — superglobals are registered by
 * `php_register_variable()`, `header()` goes through a `sapi_module_struct`
 * hook — so `phasmHandleRequest` is ~1,100 lines of hook-swapping in
 * `sapi/phasm/phasm.c`. Almost every other runtime puts the same semantics in
 * library code in its own language: Python's is PEP 3333's `environ` dict,
 * Ruby's is Rack's env hash, and both are about fifty lines of glue over the
 * `PhasmRequest` above. The SAPI is a PHP tax, not a per-language one.
 *
 * The genuinely hard half of `phasm.c` is not the SAPI at all — it is
 * re-entrancy, running hundreds of requests on one warm instance without
 * `main()`'s latched exit status. CPython hands that over for free.
 *
 * ## The one constraint on WHICH runtimes can do this
 *
 * A runtime hosted as a `wasi-sh` host builtin must be **JS-callable and
 * re-entrant** — Emscripten-shaped, not a plain `wasm32-wasi` `_start` binary.
 * Fork-free, one worker runs one guest: a second `_start` module is not a
 * second process, it is a second instance the shell has no way to wait on, on a
 * thread already committed. That is why phasm is Emscripten while busybox is
 * WASI, and it is load-bearing rather than incidental.
 */

/**
 * The status that means "not mine — serve this path yourself". Not an error,
 * and not the absence of a status.
 *
 * It lives here because it is the one piece of vocabulary the whole stack
 * shares: the router produces it, the wire carries it, the service worker acts
 * on it. `./resolve.mjs` and `./sw.mjs` re-export it so that neither has to be
 * imported for the other's sake.
 *
 * **Beware the other zero.** A no-cors cross-origin `fetch()` resolves to an
 * *opaque* `Response` whose status is also 0, and `./sw.mjs` tests for that too
 * — unrelated meaning, same literal. Only the decline is spelled `DECLINE`.
 */
export const DECLINE = 0;

/**
 * Refuse a runtime that cannot serve requests, where it is supplied.
 *
 * At construction rather than at the first fetch, because by then a page is
 * holding a connection open on it and the mistake is in the wiring rather than
 * in the request.
 *
 * @param {object} runtime
 * @param {string} where the caller's name, so the message names the mistake
 */
export function assertServeRuntime(runtime, where = 'this') {
  if (!runtime || typeof runtime.phasmHandleRequest !== 'function') {
    throw new TypeError(
      `${where}: needs a runtime with phasmHandleRequest(req) -> {status, headers, body}. `
      + 'See @alganet/phasm/contract — a Phasm() module satisfies it as it is.',
    );
  }
}

/**
 * Refuse a runtime that cannot run a command.
 *
 * `run()`'s options and result are `wasi-sh`'s vocabulary rather than PHP's,
 * which is why a shell run and a runtime run compose with no adapter between
 * them — and why this check is about a shape rather than about a module.
 */
export function assertRunRuntime(runtime, where = 'this') {
  if (!runtime || typeof runtime.run !== 'function') {
    throw new TypeError(
      `${where}: needs a runtime with run(options) -> {stdout, stderr, exitCode}. `
      + 'See @alganet/phasm/contract — a Phasm() module satisfies it as it is.',
    );
  }
}

export default DECLINE;
