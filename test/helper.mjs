// SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>
//
// SPDX-License-Identifier: ISC

// Shared harness for the phasm suite.
//
// The module is built with NO_EXIT_RUNTIME and the CLI SAPI's main() does full
// module init AND shutdown, so a single instance is good for exactly one run:
// state leaks across callMain() calls and eventually crashes. Every test
// therefore gets a FRESH instance, and `php()` below is the only way tests are
// allowed to run code. (Making one instance safely reusable is the whole point
// of the planned custom SAPI; when that lands, this harness is where
// the change shows up.)

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DIST = join(HERE, '..', 'dist');
const ENTRY = join(DIST, 'php.js');

/** Is there a build to test? Suites skip rather than fail without one. */
export function haveBuild() {
  return existsSync(ENTRY) && existsSync(join(DIST, 'php.wasm'));
}

export const NO_BUILD_MSG =
  'dist/php.js not found — run ./scripts/build.sh (see CONTRIBUTING.md) before the suite.';

let factory;
async function loadFactory() {
  if (!factory) {
    // The Emscripten output is a CommonJS UMD bundle, not an ES module.
    const require = createRequire(import.meta.url);
    factory = require(ENTRY);
  }
  return factory;
}

/**
 * Run PHP once in a fresh module and collect everything it produced.
 *
 * @param {string[]} args           argv after argv[0], e.g. ['-r', 'echo 1;']
 * @param {object}   [opts]
 * @param {Record<string,string|Uint8Array>} [opts.files]  written before the run
 * @param {string}   [opts.stdin]   fed to the script, then EOF
 * @returns {Promise<{stdout: string, stderr: string, exitCode: number, FS: object}>}
 */
export async function php(args, opts = {}) {
  const Phasm = await loadFactory();
  const out = [];
  const err = [];

  // stdin is delivered one character code at a time; null means EOF.
  const inBytes = opts.stdin ? new TextEncoder().encode(opts.stdin) : new Uint8Array(0);
  let inPos = 0;

  const mod = await Phasm({
    noInitialRun: true,
    // NOT the `print`/`printErr` options: those are LINE buffered — they fire
    // only on a newline and hand you the line with the newline stripped. Output
    // that does not end in one is silently never delivered (`php -r 'echo 42;'`
    // produced nothing at all), and multi-line output cannot be reassembled
    // exactly. FS.init gives the raw byte stream, so assertions can be exact.
    preRun: [(m) => m.FS.init(
      () => (inPos < inBytes.length ? inBytes[inPos++] : null),
      (c) => { if (c !== null) out.push(c); },
      (c) => { if (c !== null) err.push(c); },
    )],
  });

  for (const [path, content] of Object.entries(opts.files || {})) {
    const slash = path.lastIndexOf('/');
    if (slash > 0) mkdirp(mod.FS, path.slice(0, slash));
    mod.FS.writeFile(path, content);
  }

  let exitCode = 0;
  try {
    exitCode = mod.callMain(args) ?? 0;
  } catch (e) {
    // Emscripten signals exit() by throwing ExitStatus when the runtime is kept
    // alive; a real crash is anything else and must not be swallowed.
    if (e && typeof e.status === 'number') exitCode = e.status;
    else throw e;
  }
  const dec = new TextDecoder();
  return {
    stdout: dec.decode(Uint8Array.from(out)),
    stderr: dec.decode(Uint8Array.from(err)),
    exitCode,
    FS: mod.FS,
  };
}

/** Run a PHP snippet with `-r` and return its stdout. */
export async function evalPhp(code, opts) {
  return php(['-r', code], opts);
}

function mkdirp(FS, dir) {
  const parts = dir.split('/').filter(Boolean);
  let cur = '';
  for (const p of parts) {
    cur += `/${p}`;
    try { FS.mkdir(cur); } catch { /* already exists */ }
  }
}
