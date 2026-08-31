// SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>
//
// SPDX-License-Identifier: ISC

/**
 * Options accepted by the `Phasm()` factory. These are standard Emscripten
 * Module options; only the ones that matter for running PHP are described
 * here. Anything else you pass is forwarded to the Emscripten module untouched.
 */
export interface PhasmOptions {
  /** Default arguments for a bare `callMain()`. There is no automatic run to
   *  configure: the module is built with INVOKE_RUN=0, so a fresh instance has
   *  spent nothing and `run()` is what invokes PHP. */
  arguments?: string[];
  /** Called once per line of stdout, for output produced outside `run()`. */
  print?: (text: string) => void;
  /** Called once per line of stderr, for output produced outside `run()`. */
  printErr?: (text: string) => void;
  /** Return the next character code of stdin, or null for EOF. Consulted for
   *  calls that name no stdin of their own. */
  stdin?: () => number | null;
  /** Raw stdout, a character code at a time, for output produced outside
   *  `run()`. Takes precedence over `print` and is not line buffered. */
  stdout?: (charCode: number | null) => void;
  /** Raw stderr, likewise, taking precedence over `printErr`. */
  stderr?: (charCode: number | null) => void;
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
export interface PhasmCallOptions {
  /** Working directory for this call. Restored afterwards. */
  cwd?: string;
  /** Environment for this call only; cleared before the next one. */
  env?: Record<string, string>;
}

/** Which of a call's two output streams a chunk came from. */
export type PhasmOutputChannel = 'stdout' | 'stderr';

/** How a call's stdio is routed. Shared by `run()` and `phasmCapture()`. */
export interface PhasmCaptureOptions {
  /** Fed to the call, then EOF. A function is asked for more bytes only when
   *  PHP actually reads, and an empty result ends the stream — which is what
   *  keeps a command that never touches stdin from blocking on it. */
  stdin?: string | Uint8Array | ((max: number) => Uint8Array | null);
  /** Output as it happens, a line at a time and whatever is left at the end.
   *  Bytes, not text, so binary output survives. */
  onOutput?: (bytes: Uint8Array, channel: PhasmOutputChannel) => void;
  /** Set false to skip buffering — `stdout` and `stderr` then come back empty.
   *  For an `onOutput` that already has somewhere to put the bytes. */
  collect?: boolean;
}

/** Options for `run()` — `wasi-sh`'s vocabulary, so the two compose. */
export interface PhasmRunOptions extends PhasmCallOptions, PhasmCaptureOptions {
  /** Full argv after argv[0], e.g. `["-r", "echo 1;"]`. Wins over `code` and
   *  `script`. */
  args?: string[];
  /** Sugar for `["-r", code]`: a snippet, no `<?php` tag. */
  code?: string;
  /** PHP source mounted at `/main.php` and run — a file, so it opens with
   *  `<?php`. Written even when `args` says to run something else. */
  script?: string;
  /** Written before the run; missing parent directories are created. */
  files?: Record<string, string | Uint8Array>;
}

/** What `run()` collected. The shape `wasi-sh`'s own `run()` returns. */
export interface PhasmRunResult {
  stdout: string;
  stderr: string;
  /** PHP's exit status for this call alone. */
  exitCode: number;
}

/** What `phasmCapture()` collected, around whatever the callback returned. */
export interface PhasmCaptured<T> {
  stdout: string;
  stderr: string;
  value: T;
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
   * Run PHP once and collect everything it produced.
   *
   * ```js
   * const { stdout, stderr, exitCode } = php.run({ code: 'echo 6 * 7;' });
   * ```
   *
   * Options and result are `wasi-sh`'s, so a shell run and a PHP run compose
   * without an adapter between them. It returns synchronously — the instance is
   * warm and PHP is a wasm frame below the call — and awaiting it anyway is
   * harmless, which keeps the two interchangeable.
   *
   * Everything is per call: `env` and `cwd` are gone by the next one, the
   * output is this call's alone, stdin is refilled. The filesystem, the
   * instance and its ini survive.
   *
   * Throws if the module cannot capture output, which happens only when its
   * standard streams were claimed elsewhere — an `FS.init()` of your own, or
   * `noFSInit`.
   */
  run(options?: PhasmRunOptions): PhasmRunResult;
  /**
   * Run `fn` with the module's stdout, stderr and stdin routed to this call.
   *
   * The primitive under `run()`, exposed because it is the only way to collect
   * output from what `run()` does not cover — a warning raised during
   * `phasmHandleRequest()`, or a one-shot `callMain()`.
   */
  phasmCapture<T>(fn: () => T, opts?: PhasmCaptureOptions): PhasmCaptured<T>;
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
   * The primitive under `run()`, which is what most callers want: this one
   * returns the status and leaves the output wherever the module's stdio
   * points. Reach for it when you are routing stdio yourself.
   *
   * Throws if an argument, an `env` value or `cwd` contains a NUL byte: the
   * calling convention is NUL-delimited, so it would arrive truncated.
   */
  phasmRun(args: string[], opts?: PhasmCallOptions): number;
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
  /**
   * The C stack pointer, for asserting that a trapped call gave it back.
   *
   * Diagnostic rather than API: nothing an embedder does should need it. A wasm
   * trap skips every function's return, so the pointer is left where the deepest
   * abandoned frame put it unless something restores it — a leak with no symptom
   * until the stack runs out and the module quietly overwrites itself.
   */
  phasmStackPointer(): number;
  /** Emscripten's in-memory filesystem. */
  FS: PhasmFS;
  [key: string]: unknown;
}

/**
 * Create and initialize a PHP module.
 *
 * ```js
 * const php = await Phasm();
 * const { stdout } = php.run({ script: '<?php echo "hi";' });
 * ```
 */
declare function Phasm(options?: PhasmOptions): Promise<PhasmModule>;

export default Phasm;
export as namespace Phasm;
