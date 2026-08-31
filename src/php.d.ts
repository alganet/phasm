// SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>
//
// SPDX-License-Identifier: ISC

/**
 * Options accepted by the `Phasm()` factory. These are standard Emscripten
 * Module options; only the ones that matter for running PHP are described
 * here. Anything else you pass is forwarded to the Emscripten module untouched.
 */
export interface PhasmOptions {
  /** Set true to prevent automatic execution on load, then use phasmRun(). */
  noInitialRun?: boolean;
  /** CLI arguments for the automatic run, e.g. ["script.php"]. Ignored when
   *  noInitialRun is set — pass arguments to phasmRun() instead. */
  arguments?: string[];
  /** Called once per line of stdout. */
  print?: (text: string) => void;
  /** Called once per line of stderr. */
  printErr?: (text: string) => void;
  /** Return the next character code of stdin, or null for EOF. */
  stdin?: () => number | null;
  /** Override where php.wasm is fetched from. */
  locateFile?: (path: string, prefix: string) => string;
  [key: string]: unknown;
}

/**
 * Emscripten's virtual filesystem. Write your PHP files here before calling
 * callMain(). Everything lives in memory and vanishes with the module.
 * See https://emscripten.org/docs/api_reference/Filesystem-API.html
 */
export interface PhasmFS {
  writeFile(path: string, data: string | Uint8Array, opts?: { encoding?: 'utf8' | 'binary'; flags?: string }): void;
  readFile(path: string, opts: { encoding: 'utf8' }): string;
  readFile(path: string, opts?: { encoding?: 'binary' }): Uint8Array;
  mkdir(path: string, mode?: number): void;
  unlink(path: string): void;
  rmdir(path: string): void;
  readdir(path: string): string[];
  stat(path: string): { size: number; mode: number; mtime: Date };
  rename(oldPath: string, newPath: string): void;
  chdir(path: string): void;
  cwd(): string;
  analyzePath(path: string): { exists: boolean; object?: unknown };
  mount(type: unknown, opts: unknown, mountpoint: string): void;
  syncfs(populate: boolean, callback: (err: Error | null) => void): void;
  [key: string]: unknown;
}

/** Options for a single `phasmRun()` invocation. */
export interface PhasmRunOptions {
  /** Working directory for this call. Restored afterwards. */
  cwd?: string;
  /** Environment for this call only; cleared before the next one. */
  env?: Record<string, string>;
}

/** One HTTP request for `phasmHandleRequest()`. */
export interface PhasmRequest {
  /** Request target, path and query string — e.g. `/blog/?page=2`. */
  url: string;
  /** Defaults to `"GET"`. */
  method?: string;
  /** Request headers. `Cookie` and `Content-Type` are handed to PHP directly;
   *  the rest arrive as `$_SERVER['HTTP_*']`. */
  headers?: Record<string, string>;
  /** Request body. Drives `$_POST`, `php://input` and `$_FILES`. */
  body?: Uint8Array;
  /** Directory the path is resolved against. Defaults to `"/"`. */
  docroot?: string;
  /** Environment for this request only, as with `phasmRun()`. */
  env?: Record<string, string>;
}

/** What PHP produced for a `PhasmRequest`. */
export interface PhasmResponse {
  /** The HTTP status, or `0` when the path is not a PHP script — a decline,
   *  not an error: serve that file from the filesystem yourself. */
  status: number;
  /** Response headers as `[name, value]` pairs, repeats included — HTTP headers
   *  are not a map, and `Set-Cookie` legitimately appears more than once.
   *  `new Headers(res.headers)` accepts this shape directly. */
  headers: [string, string][];
  /** The body as bytes, so binary responses survive. */
  body: Uint8Array;
}

/** The initialized module `Phasm()` resolves to. */
export interface PhasmModule {
  /**
   * Run PHP. `args` is argv without argv[0] — `["hello.php"]` runs that file,
   * `["-r", "echo 1;"]` runs a snippet. Returns the exit status.
   *
   * This is the re-entrant entry point: call it as many times as you like on
   * one warm instance. It never exits the process, so the status is per call
   * and a fatal error or `exit()` leaves the module usable.
   *
   * Errors go to stderr, and PHP_SAPI reports "cli" so that CLI tools which
   * gate on it (composer.phar, phpunit.phar) agree to run.
   *
   * Collect output the way Emscripten collects it — an `FS.init()` sink, or
   * `print`/`printErr` if line buffering is acceptable.
   *
   * Throws if an argument, an `env` value or `cwd` contains a NUL byte: the
   * calling convention is NUL-delimited, so it would arrive truncated.
   */
  phasmRun(args: string[], opts?: PhasmRunOptions): number;
  /**
   * Handle one HTTP request and return the response.
   *
   * A full PHP request cycle, not a command with superglobals filled in after
   * the fact — so `header()`, `http_response_code()`, `$_GET`, `$_POST`,
   * `$_COOKIE`, `php://input` and `$_FILES` all behave as they do under any
   * other web SAPI, because PHP's own machinery produces them.
   *
   * The shape is the web platform's on purpose: a service worker can pass a
   * `Request` almost straight in and build a `Response` almost straight out.
   *
   * Shares the instance with `phasmRun()` — commands and requests interleave
   * freely on one warm module and one filesystem.
   */
  phasmHandleRequest(req: PhasmRequest): PhasmResponse;
  /**
   * Start PHP explicitly with ini settings that apply for the life of the
   * instance, as newline-separated `name=value` lines. `phasmRun()` starts PHP
   * on first use without them, so this is only needed to pass settings —
   * per-call `-d` is not supported on this path.
   *
   * Returns 0, or -1 if this module has already run `callMain()`.
   */
  phasmStartup(ini?: string): number;
  /**
   * Run PHP once through the CLI's main(), as a plain program.
   *
   * Legacy and one-shot: main() ends in exit(), which latches the status for
   * every later call and eventually kills the instance. Mutually exclusive
   * with `phasmRun()` — pick one per module. New code wants `phasmRun()`.
   *
   * Throws once PHP is running, rather than trapping and killing the instance.
   */
  callMain(args: string[]): number;
  /** Emscripten's in-memory filesystem. */
  FS: PhasmFS;
  [key: string]: unknown;
}

/**
 * Create and initialize a PHP module.
 *
 * ```js
 * const php = await Phasm({ noInitialRun: true, print: console.log });
 * php.FS.writeFile('/hello.php', '<?php echo "hi";');
 * php.phasmRun(['hello.php']);
 * ```
 */
declare function Phasm(options?: PhasmOptions): Promise<PhasmModule>;

export default Phasm;
export as namespace Phasm;
