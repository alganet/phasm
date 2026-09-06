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
 * Mounts this module made, so two of them never claim one ZenFS path. The
 * store is addressed through ZenFS's namespace, and a name nobody else would
 * pick keeps the embedder's own mounts — theirs to arrange — out of it.
 */
let mountSeq = 0;

/**
 * Mount `store` into an Emscripten module's filesystem.
 *
 * The first argument is a `Phasm()` module in every use this repo has, and the
 * type says Emscripten because that is all this reaches for: `.FS`, four
 * methods of it, and nothing of PHP anywhere. A mount is between a JS store
 * and an Emscripten filesystem; which language is compiled above it never
 * comes up.
 *
 * @param {object} mod an Emscripten module — `Phasm()` returns one
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
export async function mountStore(mod, store, options = {}) {
  const { path, root = path, create = true } = options;

  // The check has always been the honest one — `.FS` is Emscripten's, not
  // PHP's — and only the message claimed otherwise. Nothing in this module
  // reaches past it, so a store mounts into any Emscripten module the same way.
  if (!mod || typeof mod.FS !== 'object') {
    throw new TypeError('mountStore: first argument must be an Emscripten module (it needs an .FS)');
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

    // No errno translation here, deliberately. `@zenfs/emscripten` translates at
    // the point it raises — see ../emscripten/src/errno.ts — and a second pass is
    // NOT a no-op: EACCES 13 maps to 2 and 2 maps on to 44, so wrapping an
    // already-translated plugin turns "permission denied" into "no such file".
    const plugin = new EmscriptenPlugin(core.fs, mod.FS);
    mod.FS.mkdirTree(path);
    mod.FS.mount(plugin, { root: zenRoot }, path);

    let live = true;
    return {
      path,
      root,
      unmount() {
        if (!live) throw new Error(`mountStore: ${path} is already unmounted`);
        // Marked spent only once both halves are actually gone. Clearing the
        // flag first meant a throwing FS.unmount() left the ZenFS mountpoint
        // claimed for the life of the page AND refused the retry that would
        // have released it, reporting "already unmounted" for a mount that
        // was still very much there.
        mod.FS.unmount(path);
        core.umount(at);
        live = false;
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
