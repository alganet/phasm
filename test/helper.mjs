// SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>
//
// SPDX-License-Identifier: ISC

// Shared harness for the phasm suite.
//
// Every test runs on ONE warm instance, shared across the whole suite. That is
// only safe because of the phasm SAPI (sapi/phasm/phasm.c): phasmRun() runs a
// full request per call without re-entering main(), so nothing exits the
// process, the exit status is per call, and there is no per-call leak. Through
// callMain() the same suite would die partway: the CLI's main() latches the
// exit status on the first non-zero one and the instance stops working
// entirely at call ~104.
//
// So the sharing is not a speed trick — the suite passing at all is itself the
// regression test for the thing the SAPI exists to fix. `fresh: true` gets a
// pristine instance for the rare test that needs one.

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

const EMPTY = new Uint8Array(0);

// The stdio sinks are installed once per instance and swapped per call, so the
// module never needs to know which test is running.
const sinks = new WeakMap();

async function makeModule() {
  const Phasm = await loadFactory();
  const sink = { out: [], err: [], input: EMPTY, inPos: 0 };

  const mod = await Phasm({
    noInitialRun: true,
    // NOT the `print`/`printErr` options: those are LINE buffered — they fire
    // only on a newline and hand you the line with the newline stripped. Output
    // that does not end in one is silently never delivered (`php -r 'echo 42;'`
    // produced nothing at all), and multi-line output cannot be reassembled
    // exactly. FS.init gives the raw byte stream, so assertions can be exact.
    preRun: [(m) => m.FS.init(
      () => (sink.inPos < sink.input.length ? sink.input[sink.inPos++] : null),
      (c) => { if (c !== null) sink.out.push(c); },
      (c) => { if (c !== null) sink.err.push(c); },
    )],
  });

  sinks.set(mod, sink);
  return mod;
}

let shared;

/** The instance the whole suite shares. Exposed for tests that measure it. */
export async function sharedModule() {
  if (!shared) shared = await makeModule();
  return shared;
}

/**
 * Run PHP once and collect everything it produced.
 *
 * @param {string[]} args           argv after argv[0], e.g. ['-r', 'echo 1;']
 * @param {object}   [opts]
 * @param {Record<string,string|Uint8Array>} [opts.files]  written before the run
 * @param {string}   [opts.stdin]   fed to the script, then EOF
 * @param {string}   [opts.cwd]     working directory for this call only
 * @param {Record<string,string>} [opts.env]  environment for this call only
 * @param {boolean}  [opts.fresh]   run on a brand-new instance
 * @param {string}   [opts.ini]     ini for the instance, applied before its first call
 * @returns {Promise<{stdout: string, stderr: string, exitCode: number, FS: object, module: object}>}
 */
export async function php(args, opts = {}) {
  const mod = opts.fresh ? await makeModule() : await sharedModule();
  const sink = sinks.get(mod);

  if (opts.ini) {
    // Only legal before PHP starts, which is why it pairs with `fresh`.
    const rc = mod.phasmStartup(opts.ini);
    if (rc !== 0) throw new Error(`phasmStartup(${JSON.stringify(opts.ini)}) returned ${rc}`);
  }

  sink.out.length = 0;
  sink.err.length = 0;
  sink.input = opts.stdin ? new TextEncoder().encode(opts.stdin) : EMPTY;
  sink.inPos = 0;

  for (const [path, content] of Object.entries(opts.files || {})) {
    const slash = path.lastIndexOf('/');
    if (slash > 0) mkdirp(mod.FS, path.slice(0, slash));
    mod.FS.writeFile(path, content);
  }

  const exitCode = mod.phasmRun(args, { cwd: opts.cwd, env: opts.env });

  const dec = new TextDecoder();
  return {
    stdout: dec.decode(Uint8Array.from(sink.out)),
    stderr: dec.decode(Uint8Array.from(sink.err)),
    exitCode,
    FS: mod.FS,
    module: mod,
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
