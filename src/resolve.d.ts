// SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>
//
// SPDX-License-Identifier: ISC

/**
 * The CGI router, as a pure function of a URL and a filesystem — `try_files`
 * written down, with nothing of PHP in it because there never was any.
 *
 * It is a port of `sapi/phasm/phasm.c`'s "resolving the script", and the C is
 * the specification: `test/resolve-oracle.test.mjs` drives both over one corpus
 * and asserts they agree, which is the only reason to trust a second
 * implementation of code whose refusals exist to prevent source disclosure.
 */

/**
 * What the resolver asks of a filesystem, whole: two questions, both about a
 * path it already has. Naming the questions rather than a filesystem is what
 * lets one resolver run over `ctx.fs`, over the `fs` contract, and over
 * Emscripten's `FS` without an adapter at every call site.
 */
export interface Probe {
  isFile(path: string): boolean;
  isDir(path: string): boolean;
}

/**
 * A {@link Probe} over anything reporting POSIX mode bits — a `wasi-sh` `fs`
 * store, a ZenFS `FileSystem`, Emscripten's `FS`. A throw is "nothing there".
 */
export function inodeProbe(store: { statSync(path: string): { mode: number } }): Probe;

/**
 * A {@link Probe} over `ctx.fs`, the filesystem a `wasi-sh` host builtin is
 * handed — the shell's own view, which is why the router can leave the runtime
 * at all.
 */
export function hostFsProbe(fs: { stat(path: string): { type: 'file' | 'dir' } | null }): Probe;

/** The status that means "not mine — serve this path yourself". Not an error. */
export const DECLINE: 0;

export interface ResolveOptions {
  /** Directory the path is resolved against. Made absolute against `cwd`. */
  docroot?: string;
  /**
   * The front controller: a docroot-relative `.php` answering any path with no
   * file behind it. A malformed one is a **500** on every request, not only the
   * ones it would have answered; one naming a file that is not there leaves the
   * **404** alone, as Apache does.
   */
  fallback?: string;
  /** Where the site sits in the browser's URL space, put back. No trailing slash. */
  prefix?: string;
  /** Resolves a relative `docroot`. Defaults to `/`. */
  cwd?: string;
}

export interface Resolved {
  /**
   * **200** when the request resolved to a script to run, **0** to decline, and
   * 400/403/404/500 for a refusal — exactly as the SAPI answers them.
   */
  status: number;
  /**
   * The resolved file. Present on a 200, and on the decline that named one
   * file — which is the suffix decline, not the directory one.
   */
  script?: string;
  scriptName?: string;
  pathInfo?: string;
  pathTranslated?: string;
  /** The request target with the prefix rejoined; `REQUEST_URI`. */
  uri?: string;
  phpSelf?: string;
  /** Absent when the target had no `?` at all, which is not an empty query. */
  query?: string;
  /** The docroot, made absolute and stripped of trailing slashes. */
  docroot?: string;
}

export function resolveRequest(uri: string, probe: Probe, options?: ResolveOptions): Resolved;

export default resolveRequest;
