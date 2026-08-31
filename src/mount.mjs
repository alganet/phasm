// SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>
//
// SPDX-License-Identifier: ISC

/**
 * Mount a foreign, JS-owned store into a phasm module's filesystem.
 *
 * ```js
 * import Phasm from '@alganet/phasm';
 * import { mountStore } from '@alganet/phasm/mount';
 * import { memoryFs } from 'wasi-sh/fs';
 *
 * const store = memoryFs({ '/app/index.php': '<?php echo "hi";' });
 * const php = await Phasm();
 * await mountStore(php, store, { path: '/app' });
 *
 * php.run({ args: ['/app/index.php'] }).stdout;   // 'hi'
 * ```
 *
 * phasm owns an Emscripten MEMFS and a shell owns a JS store; both cannot be
 * the source of truth for a project the two of them edit. This is the seam
 * that settles it — the store stays outside and JS-owned, and PHP reads and
 * writes *through* it, so a file the shell just wrote is the file PHP opens.
 * The alternative, copying a tree in and out, diverges silently and surfaces
 * as a bug an hour later.
 *
 * `store` is anything in the shape of wasi-sh's `fs` contract: twelve
 * synchronous, path-addressed methods returning `InodeLike` metadata. That
 * shape is ZenFS's, deliberately, so `wasi-sh/fs`'s `memoryFs()`, a persistent
 * OPFS-backed store and a `@zenfs/core` `FileSystem` instance are all the same
 * kind of argument here and none of them needs an adapter written for it.
 *
 * ## What this costs
 *
 * `@zenfs/core` and `@zenfs/emscripten` are **optional peers**: the mount is
 * theirs, not ours. `@zenfs/emscripten`'s plugin is the Emscripten-side
 * translation — node_ops and stream_ops over a foreign filesystem — and it is
 * not code worth rewriting to save an install. Embedding PHP in a page without
 * mounting anything installs neither, which is why they are not dependencies.
 *
 * ## Paths are the contract
 *
 * `path` is where the store appears in PHP's filesystem, and `root` is the
 * directory *of the store* that lands there. `root` defaults to `path`, which
 * makes the mount an identity mapping: `/app` in the shell is `/app` in PHP.
 * Get that wrong and everything still works right up until a shell script says
 * `php app/index.php` and PHP resolves it somewhere else.
 *
 * Mounting at `/` is not possible — Emscripten's root is already MEMFS, and
 * `/dev`, `/tmp` and `/proc` have to stay there. Mount the directories the
 * project actually lives in, one call each.
 */

/**
 * Linux errno (what ZenFS and kerium throw) to Emscripten's musl-derived
 * table (what Emscripten's FS checks against).
 *
 * Without this, file *creation* fails while every other operation works:
 * `FS.lookupPath` suppresses a missing final component only when
 * `e.errno === 44`, and ZenFS reports a missing file as 2 — which in
 * Emscripten's table is EACCES, so PHP reports "Permission denied" for a file
 * it was about to create. An upstream bug in `@zenfs/emscripten`; this table
 * goes away when the fix is released there.
 *
 * Everything reaching the translation originates as a Linux errno, because
 * kerium's `Errno` is Linux's numbering and the plugin rethrows `e.errno`
 * untouched — so mapping every one of them is right, not a heuristic.
 */
const LINUX_TO_EMSCRIPTEN = {
  1: 63,   // EPERM
  2: 44,   // ENOENT   <- the one that matters
  5: 29,   // EIO
  9: 8,    // EBADF
  11: 6,   // EAGAIN
  12: 48,  // ENOMEM
  13: 2,   // EACCES
  14: 21,  // EFAULT
  16: 10,  // EBUSY
  17: 20,  // EEXIST
  18: 75,  // EXDEV
  19: 43,  // ENODEV
  20: 54,  // ENOTDIR
  21: 31,  // EISDIR
  22: 28,  // EINVAL
  24: 33,  // EMFILE
  27: 22,  // EFBIG
  28: 51,  // ENOSPC
  29: 70,  // ESPIPE
  30: 69,  // EROFS
  31: 34,  // EMLINK
  32: 64,  // EPIPE
  34: 68,  // ERANGE
  36: 37,  // ENAMETOOLONG
  38: 52,  // ENOSYS
  39: 55,  // ENOTEMPTY
  40: 32,  // ELOOP
  95: 138, // ENOTSUP / EOPNOTSUPP
};

/**
 * Mounts this module made, so two of them never claim one ZenFS path. The
 * store is addressed through ZenFS's namespace, and a name nobody else would
 * pick keeps the embedder's own mounts — theirs to arrange — out of it.
 */
let mountSeq = 0;

/**
 * Mount `store` into `php`'s filesystem.
 *
 * @param {object} php a module from `Phasm()`
 * @param {object} store a synchronous store in wasi-sh's `fs` contract shape
 * @param {object} options
 * @param {string} options.path where the store appears in PHP's filesystem;
 *   absolute, created if missing
 * @param {string} [options.root] the store's directory mounted there,
 *   defaulting to `path` — an identity mapping, which is what two guests
 *   sharing a project need
 * @param {boolean} [options.create] create `root` in the store when it is not
 *   there yet; set false to make a mount of the wrong tree fail loudly
 * @returns {Promise<{path: string, root: string, unmount: () => void}>}
 */
export async function mountStore(php, store, options = {}) {
  const { path, root = path, create = true } = options;

  if (!php || typeof php.FS !== 'object') {
    throw new TypeError('mountStore: first argument must be a phasm module');
  }
  if (!store || typeof store.statSync !== 'function') {
    throw new TypeError(
      'mountStore: second argument must be a store in the fs contract shape ' +
      '(statSync, readdirSync, readSync, writeSync, …)',
    );
  }
  if (typeof path !== 'string' || !path.startsWith('/') || path === '/') {
    throw new TypeError(
      'mountStore: `path` must be an absolute path other than "/" — it is what ' +
      'both guests have to agree on, and Emscripten\'s root is already MEMFS',
    );
  }
  if (typeof root !== 'string' || !root.startsWith('/')) {
    throw new TypeError('mountStore: `root` must be an absolute path within the store');
  }

  const core = await load('@zenfs/core', () => import('@zenfs/core'));
  const plugins = await load('@zenfs/emscripten', () => import('@zenfs/emscripten/plugin.js'));
  const EmscriptenPlugin = plugins.default ?? plugins.EmscriptenPlugin;

  // A ZenFS filesystem already satisfies the contract, so the wrapper is for
  // everyone else — and it is pure delegation, which is the whole point of
  // wasi-sh having taken this shape rather than inventing one.
  const backend = store instanceof core.FileSystem ? store : new (storeFs(core))(store);

  let at = `/phasm.${mountSeq++}`;
  // Two copies of this module share one ZenFS but not one counter, and a
  // second claim on a mountpoint is a hard error there rather than a warning.
  while (core.mounts.has(at)) at = `/phasm.${mountSeq++}`;
  core.mount(at, backend);

  try {
    // ZenFS addresses the store beneath its own mountpoint; the store itself
    // never sees that prefix, so what it is asked for is exactly what the
    // shell asks it for.
    const zenRoot = join(at, root);
    if (create) core.fs.mkdirSync(zenRoot, { recursive: true });

    const plugin = translateErrno(new EmscriptenPlugin(core.fs, php.FS), php.FS);
    php.FS.mkdirTree(path);
    php.FS.mount(plugin, { root: zenRoot }, path);

    let live = true;
    return {
      path,
      root,
      unmount() {
        if (!live) throw new Error(`mountStore: ${path} is already unmounted`);
        live = false;
        php.FS.unmount(path);
        core.umount(at);
      },
    };
  } catch (e) {
    core.umount(at);
    throw e;
  }
}

/**
 * The store as a ZenFS filesystem. Built on first use and cached against the
 * module it extends, not globally: a page that ends up with two copies of
 * `@zenfs/core` would otherwise get a class extending the wrong one, and the
 * `instanceof` in mountStore() would disagree with it.
 */
const storeFsByCore = new WeakMap();
function storeFs(core) {
  const cached = storeFsByCore.get(core.FileSystem);
  if (cached) return cached;

  // Sync() is ZenFS's published mixin for exactly this: it derives the async
  // half of the interface from the synchronous one. Synchronous is structural
  // here — PHP is a wasm stack frame below every one of these calls, so there
  // is nothing to await into.
  const StoreFS = class extends core.Sync(core.FileSystem) {
    constructor(store) {
      super(0x7068736d /* 'phsm' */, 'phasm-store');
      this.store = store;
    }

    statSync(path) { return this.store.statSync(path); }
    readdirSync(path) { return this.store.readdirSync(path); }
    createFileSync(path, options) { return this.store.createFileSync(path, options); }
    mkdirSync(path, options) { return this.store.mkdirSync(path, options); }
    rmdirSync(path) { this.store.rmdirSync(path); }
    unlinkSync(path) { this.store.unlinkSync(path); }
    renameSync(from, to) { this.store.renameSync(from, to); }
    linkSync(target, link) { this.store.linkSync(target, link); }
    readSync(path, buffer, start, end) { this.store.readSync(path, buffer, start, end); }
    writeSync(path, buffer, offset) { this.store.writeSync(path, buffer, offset); }
    touchSync(path, metadata) { this.store.touchSync(path, metadata); }
    syncSync() { this.store.syncSync?.(); }
  };

  storeFsByCore.set(core.FileSystem, StoreFS);
  return StoreFS;
}

/**
 * Wrap the plugin's operations so a store's errno arrives in the numbering
 * Emscripten reads. Applied to the instance rather than the class: the ops are
 * per-instance objects, and another module's mount is not ours to patch.
 */
function translateErrno(plugin, FS) {
  const wrap = (fn) => function (...args) {
    try {
      return fn.apply(this, args);
    } catch (e) {
      const mapped = LINUX_TO_EMSCRIPTEN[e?.errno];
      if (mapped === undefined) throw e;
      throw new FS.ErrnoError(mapped);
    }
  };

  for (const ops of [plugin.node_ops, plugin.stream_ops]) {
    for (const [name, op] of Object.entries(ops)) {
      if (typeof op === 'function') ops[name] = wrap(op);
    }
  }

  return plugin;
}

function join(base, path) {
  return `${base}/${path}`.replace(/\/+/g, '/').replace(/(.)\/$/, '$1');
}

/**
 * Import an optional peer, and say what to install when it is not there.
 *
 * The import is a thunk holding a literal specifier rather than the `name`
 * beside it: a bundler can follow the first and not the second, and phasm's
 * whole point is running in a page.
 */
async function load(name, importer) {
  try {
    return await importer();
  } catch (e) {
    if (e?.code !== 'ERR_MODULE_NOT_FOUND' && e?.code !== 'MODULE_NOT_FOUND') throw e;
    throw new Error(
      `mountStore() needs ${name}, an optional peer dependency: ` +
      'npm install @zenfs/core @zenfs/emscripten',
      { cause: e },
    );
  }
}

export default mountStore;
