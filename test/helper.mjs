// SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>
//
// SPDX-License-Identifier: ISC

// Shared harness for the phasm suite.
//
// Every test runs on ONE warm instance, shared across the whole suite. That is
// only safe because of the phasm SAPI (sapi/phasm/phasm.c): run() runs a full
// request per call without re-entering main(), so nothing exits the process,
// the exit status is per call, and there is no per-call leak. Through
// callMain() the same suite would die partway: the CLI's main() latches the
// exit status on the first non-zero one and the instance stops working
// entirely at call ~104.
//
// So the sharing is not a speed trick — the suite passing at all is itself the
// regression test for the thing the SAPI exists to fix. `fresh: true` gets a
// pristine instance for the rare test that needs one.
//
// This file used to hand-roll the stdio the module now owns: an FS.init() sink
// installed in preRun and swapped per call. It is a wrapper over run() instead,
// which makes the whole suite a test of the shipped API rather than of a
// recipe re-derived here. test/run.test.mjs covers that API's own edges.

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
 * A brand-new instance. `options` reaches the factory untouched, which is how
 * the tests about the module's own stdio get a module wired their way.
 *
 * Nothing is passed by default, and that is deliberate: the build links with
 * INVOKE_RUN=0, so a module makes no run of its own and the whole suite is
 * driving the same plain `Phasm()` a reader of the README would write. It used
 * to pass `noInitialRun: true` here, which meant the one shape nobody tested
 * was the default one — and that shape was broken.
 */
export async function freshModule(options) {
  const Phasm = await loadFactory();
  return Phasm({ ...options });
}

let shared;

/**
 * The instance the whole suite shares. Exposed for tests that measure it.
 *
 * The promise is cached, not the module. Awaiting first and assigning after
 * meant two concurrent callers each got past the guard and booted one — and the
 * suite does run `serve()` under Promise.all, so a fan-out that landed before
 * the first boot finished would have split the suite across instances. Every
 * test that asserts something about accumulated state on the shared module
 * would then have passed by not being tested.
 */
export function sharedModule() {
  if (!shared) shared = freshModule();
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
 * @param {boolean}  [opts.viaCallMain]  the legacy one-shot entry point
 * @returns {Promise<{stdout: string, stderr: string, exitCode: number, FS: object, module: object}>}
 */
export async function php(args, opts = {}) {
  const mod = opts.fresh ? await freshModule() : await sharedModule();

  if (opts.ini) {
    // Only legal before PHP starts, which is why it pairs with `fresh`.
    const rc = mod.phasmStartup(opts.ini);
    if (rc !== 0) throw new Error(`phasmStartup(${JSON.stringify(opts.ini)}) returned ${rc}`);
  }

  // The legacy one-shot path, for the tests that are about it. It ends in
  // exit(), so the instance is spent afterwards — hence `fresh`. run() cannot
  // drive it, but the capture underneath run() can.
  if (opts.viaCallMain) {
    writeFiles(mod, opts.files);
    const captured = mod.phasmCapture(() => mod.callMain(args), { stdin: opts.stdin });
    return { ...captured, exitCode: captured.value, FS: mod.FS, module: mod };
  }

  const result = mod.run({
    args,
    files: opts.files,
    stdin: opts.stdin,
    cwd: opts.cwd,
    env: opts.env,
  });

  return { ...result, FS: mod.FS, module: mod };
}

/** Run a PHP snippet with `-r` and return its stdout. */
export async function evalPhp(code, opts) {
  return php(['-r', code], opts);
}

/**
 * Handle one HTTP request on the shared instance.
 *
 * `body` may be a string for convenience; the module takes bytes either way.
 * `text` is the decoded body, alongside the raw `body` — most assertions want
 * the former and the ones about binary responses need the latter.
 *
 * The module returns headers as pairs because HTTP headers repeat; `headers` is
 * those pairs in a `Headers`, which is what a service worker would build anyway
 * and what makes `getSetCookie()` available. `rawHeaders` keeps the pairs for
 * the tests that need to see exactly what came back.
 *
 * @param {{url: string, method?: string, headers?: Record<string,string>,
 *          body?: string|Uint8Array, docroot?: string,
 *          env?: Record<string,string>, fresh?: boolean}} req
 * A request's own output is the response, but a fatal or a warning still goes
 * to the module's stderr — so this captures around the call, both to keep the
 * suite's console clean and to give the tests about failing requests something
 * to assert on.
 *
 * @returns {Promise<{status: number, headers: Headers, rawHeaders: [string,string][],
 *                    body: Uint8Array, text: string, stderr: string}>}
 */
export async function serve(req) {
  const mod = req.fresh ? await freshModule() : await sharedModule();
  const body = typeof req.body === 'string' ? new TextEncoder().encode(req.body) : req.body;

  if (req.ini) {
    const rc = mod.phasmStartup(req.ini);
    if (rc !== 0) throw new Error(`phasmStartup(${JSON.stringify(req.ini)}) returned ${rc}`);
  }

  // A fresh instance has a fresh filesystem, so anything it must serve has to
  // be written into it rather than into the one the suite shares.
  writeFiles(mod, req.files);

  const captured = mod.phasmCapture(() => mod.phasmHandleRequest({ ...req, body }));
  const res = captured.value;
  return {
    status: res.status,
    headers: new Headers(res.headers),
    rawHeaders: res.headers,
    body: res.body,
    text: new TextDecoder().decode(res.body),
    stderr: captured.stderr,
  };
}

function writeFiles(mod, files) {
  for (const [path, content] of Object.entries(files || {})) {
    const slash = path.lastIndexOf('/');
    if (slash > 0) mkdirp(mod.FS, path.slice(0, slash));
    mod.FS.writeFile(path, content);
  }
}

export function mkdirp(FS, dir) {
  const parts = dir.split('/').filter(Boolean);
  let cur = '';
  for (const p of parts) {
    cur += `/${p}`;
    try { FS.mkdir(cur); } catch { /* already exists */ }
  }
}
