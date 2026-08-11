// SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>
//
// SPDX-License-Identifier: ISC

/**
 * Options accepted by the `Phasm()` factory. These are standard Emscripten
 * Module options; only the ones that matter for running PHP are described
 * here. Anything else you pass is forwarded to the Emscripten module untouched.
 */
export interface PhasmOptions {
  /** Set true to prevent automatic execution on load, then use callMain(). */
  noInitialRun?: boolean;
  /** CLI arguments, e.g. ["script.php"]. argv[0] is supplied for you. */
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

/** The initialized module `Phasm()` resolves to. */
export interface PhasmModule {
  /**
   * Run PHP. `args` is argv without argv[0] — `["hello.php"]` runs that file,
   * `["-r", "echo 1;"]` runs a snippet. Returns the exit status.
   *
   * Note: the module is built with NO_EXIT_RUNTIME, and repeated calls share
   * one PHP process lifetime — state leaks between them. Treat it as one run
   * per module instance until phasm grows a proper re-entrant SAPI.
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
 * php.callMain(['hello.php']);
 * ```
 */
declare function Phasm(options?: PhasmOptions): Promise<PhasmModule>;

export default Phasm;
export as namespace Phasm;
