// SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>
//
// SPDX-License-Identifier: ISC

// The guest half of interrupt.test.mjs: a real busybox shell with `php` as a
// host builtin, on a thread of its own, reading stdin from a ring the parent
// can write to while the guest is busy.
//
// It builds the shim by hand rather than going through run() or spawn(), for
// the reason the suite exists: run()'s stdin is a fixed buffer with no
// interrupt word in it, and spawn() needs a browser `Worker`. What is between
// the ring and the builtin is wasi-sh's own shim either way.
//
// The builtin is written out below rather than imported, because what this test
// needs of one is a single line — the `interrupted` closure — and a composition
// layer to get it would be the tail wagging the dog. The shape is `wasi-sh`'s
// `run()` options, which is this package's own `run()` and needs no adapter
// between them: argv, cwd, env, stdin and an exit status are POSIX's
// vocabulary, not an interface either side invented.

import { parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { WasiShim, WasiExit } from 'wasi-sh/shim';
import { RingReader } from 'wasi-sh/ring';

const { wasm, sab, script } = workerData;

const require = createRequire(import.meta.url);
const Phasm = require(new URL('../dist/php.js', import.meta.url).pathname);

// Booted before the shell starts, which is what `async builtins()` is for in a
// real embedding: a handler may not return a promise.
const runtime = await Phasm();
// Checked here rather than at the first call, so a wiring mistake names itself.
if (typeof runtime.run !== 'function') {
  throw new TypeError('interrupt-guest: needs a runtime with run(options)');
}
/** `php` as a host builtin: argv through, descriptors through, ^C through. */
const php = (ctx) => runtime.run({
  // argv[0] is the name as typed, which PHP supplies for itself.
  args: ctx.argv.slice(1),
  cwd: ctx.cwd,
  env: ctx.env,

  // Pulled rather than drained: ctx.stdin() blocks, and on a live ring it
  // would park the whole session.
  stdin: (max) => ctx.stdin(max),

  // The line this suite exists for. The shell raises a count and hands it over
  // as this closure; PHP samples it at the VM safe points it already runs, and
  // a script that will not stop comes back with 130 in `$?` and the instance
  // intact. Without it the only way out of `while(true);` is terminate().
  interrupted: typeof ctx.interrupted === 'function' ? () => ctx.interrupted() : undefined,

  collect: false,
  onOutput: (bytes, channel) => {
    if (channel === 'stdout') ctx.stdout(bytes);
    else ctx.stderr(bytes);
  },
}).exitCode;

const dec = new TextDecoder();
let out = '';
const emit = (bytes) => {
  const text = dec.decode(bytes);
  out += text;
  // Streamed as well as accumulated: the parent posts its ^C on seeing a cue
  // the running command printed, and a cue that only arrives at exit is no cue.
  parentPort.postMessage({ type: 'out', text });
};

const shim = new WasiShim({
  args: ['busybox', 'sh', '/t.sh'],
  env: { PATH: '/', HOME: '/', LC_ALL: 'C' },
  files: { '/t.sh': script },
  stdout: emit,
  stderr: emit,
  input: new RingReader(sab).toInput(),
  builtins: {
    lookup: (name) => name === 'php',
    run: (ctx) => php(ctx),
  },
});

const instance = await WebAssembly.instantiate(wasm, shim.imports());
shim.bindMemory(instance.exports.memory);

let code = 0;
try {
  instance.exports._start();
} catch (e) {
  if (e instanceof WasiExit) code = e.code;
  else { parentPort.postMessage({ type: 'error', message: String(e && e.stack || e) }); code = 134; }
}
parentPort.postMessage({ type: 'exit', code, out });
