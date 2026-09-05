// SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>
//
// SPDX-License-Identifier: ISC

import type { PhasmFS } from './php.js';

/**
 * One node's metadata, as a store reports it. The file type lives in `mode`,
 * POSIX-style. Declared structurally rather than imported so that
 * `@alganet/phasm` needs no dependency on the store's package — this is
 * ZenFS's `InodeLike`, which is also `wasi-sh`'s.
 */
export interface InodeLike {
  /** UNIQUE per node: loop detection compares `dev:ino`. */
  ino: number;
  nlink: number;
  size: number;
  /** Type bits plus permissions. */
  mode: number;
  uid: number;
  gid: number;
  atimeMs: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs?: number;
}

/**
 * A store phasm can mount: path-addressed, synchronous, in ZenFS's
 * `FileSystem` shape — which is also the shape of `wasi-sh`'s `fs` contract,
 * so a shell's store and a `@zenfs/core` filesystem are both this type.
 *
 * Synchronous is structural, not a preference: PHP is a wasm stack frame below
 * every one of these calls, and there is nothing to await into.
 *
 * Offsets are arguments rather than state, so an open file description's
 * position never reaches the store and two handles on one file cannot share
 * one.
 */
export interface Store {
  statSync(path: string): InodeLike;
  /** Entry names, not paths. Throws ENOTDIR when `path` is a file. */
  readdirSync(path: string): string[];
  createFileSync(path: string, options?: Partial<InodeLike>): InodeLike;
  mkdirSync(path: string, options?: Partial<InodeLike>): InodeLike;
  rmdirSync(path: string): void;
  unlinkSync(path: string): void;
  renameSync(from: string, to: string): void;
  linkSync(target: string, link: string): void;
  /** Read bytes [start, end) into `buffer` at offset 0. */
  readSync(path: string, buffer: Uint8Array, start: number, end: number): void;
  /** Write `buffer` at `offset`, extending the file as needed. */
  writeSync(path: string, buffer: Uint8Array, offset: number): void;
  /** truncate + chmod + chown + utimes: only the fields present apply. */
  touchSync(path: string, metadata: Partial<InodeLike>): void;
  /** Flush whatever is behind the store. A no-op for in-memory ones. */
  syncSync?(): void;
}

/** Where a store was mounted, and how to take it back out. */
export interface Mount {
  /** Where the store appears in PHP's filesystem. */
  path: string;
  /** The directory of the store that landed there. */
  root: string;
  /** Restore the plain in-memory directory that was there before. */
  unmount(): void;
}

export interface MountOptions {
  /**
   * Where the store appears in PHP's filesystem. Absolute, and not `/` —
   * Emscripten's root is already MEMFS and `/dev`, `/tmp` and `/proc` have to
   * stay there. Created if missing.
   */
  path: string;
  /**
   * The directory *of the store* mounted at `path`, defaulting to `path`
   * itself — an identity mapping, which is what two guests sharing one project
   * need: `/app` in the shell is `/app` in PHP.
   */
  root?: string;
  /** Create `root` in the store when it is not there yet. Defaults to true. */
  create?: boolean;
}

/**
 * Mount a foreign, JS-owned store into a phasm module's filesystem.
 *
 * ```ts
 * const store = memoryFs({ '/app/index.php': '<?php echo "hi";' });
 * const php = await Phasm();
 * await mountStore(php, store, { path: '/app' });
 *
 * php.run({ args: ['/app/index.php'] }).stdout;   // 'hi'
 * ```
 *
 * PHP then reads and writes where the bytes live rather than through a copy,
 * so a file the shell just wrote is the file PHP opens, and an edit made
 * outside is the code the next request runs.
 *
 * Requires `@zenfs/core` and `@zenfs/emscripten`, which are optional peers:
 * the Emscripten-side translation is theirs, and embedding PHP in a page
 * without mounting anything installs neither.
 */
export function mountStore(mod: EmscriptenModule, store: Store, options: MountOptions): Promise<Mount>;

/**
 * All this reaches for. A `PhasmModule` is one, and the narrower type is the
 * honest one: a mount is between a JS store and an Emscripten filesystem, and
 * which language is compiled above it never comes up.
 */
export interface EmscriptenModule {
  FS: PhasmFS;
}

export default mountStore;
