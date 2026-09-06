// SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>
//
// SPDX-License-Identifier: ISC

/**
 * What a runtime has to implement to be hosted by this stack — the request
 * wire, the service-worker proxy, the CGI router, the store mount and the
 * editor's file channel are all language-neutral, and this is the short list
 * of what any of them actually asks of the thing running the code.
 *
 * A `PhasmModule` satisfies all of it as it is. See `contract.mjs` for why PHP
 * is the hard case rather than the representative one, and for the constraint
 * on which runtimes can be host builtins at all.
 */

import type { PhasmRequest, PhasmResponse, PhasmRunOptions, PhasmRunResult } from './php.js';

export type { PhasmRequest, PhasmResponse, PhasmRunOptions, PhasmRunResult };

/** The status that means "not mine — serve this path yourself". Not an error. */
export const DECLINE: 0;

/**
 * A runtime that can answer an HTTP request.
 *
 * **Synchronously**, and that is structural rather than a preference: a live
 * `wasi-sh` session is one `_start()` frame, so the worker's event loop never
 * turns while the guest runs and there is nothing to await into.
 */
export interface ServeRuntime {
  /**
   * One request cycle. Answer `DECLINE` for a path that is not this runtime's
   * to serve; the caller knows what a static file is.
   */
  phasmHandleRequest(req: PhasmRequest): PhasmResponse;
  /**
   * Optional. Route output produced OUTSIDE the response — a warning, the text
   * of a fatal — somewhere other than the reply. A runtime that writes nothing
   * beside its response needs none.
   */
  phasmCapture?<T>(
    fn: () => T,
    opts?: { collect?: boolean; onOutput?: (bytes: Uint8Array) => void },
  ): { value: T };
  /**
   * Optional. Emscripten's filesystem, which the router resolves and reads
   * over. A runtime with none passes `files` to the router instead.
   */
  FS?: { stat(path: string): { mode: number }; readFile(path: string): Uint8Array };
}

/**
 * A runtime that can run a command.
 *
 * `run()`'s options and result are `wasi-sh`'s vocabulary rather than PHP's,
 * which is why a shell run and a runtime run compose with nothing between them.
 */
export interface RunRuntime {
  /**
   * One invocation. **`collect: false` with an `onOutput` means stream, not
   * buffer** — that is how the shell builtin runs every command, since the
   * shell's descriptors are already where the output belongs. A runtime that
   * ignores it prints nothing at the prompt and looks broken.
   */
  run(options: PhasmRunOptions): PhasmRunResult;
}

/** What the router needs of a filesystem: two predicates and a read. */
export interface Files {
  isFile(path: string): boolean;
  isDir(path: string): boolean;
  read(path: string): Uint8Array | null;
}

/** Refuse a runtime that cannot serve requests, where it is supplied. */
export function assertServeRuntime(runtime: unknown, where?: string): asserts runtime is ServeRuntime;

/** Refuse a runtime that cannot run a command, where it is supplied. */
export function assertRunRuntime(runtime: unknown, where?: string): asserts runtime is RunRuntime;

export default DECLINE;
