// SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>
//
// SPDX-License-Identifier: ISC

// ^C into a running PHP script, end to end over real shared memory.
//
// This is the one place the mechanism can be proved, and the reason is the law
// the whole design is built on: a running guest owns its worker. While
// `php -r 'while (true);'` runs, the shell's thread is one synchronous
// _start() frame, so a postMessage into it is not slow — it is undelivered.
// The only thing that reaches it is a write into shared memory the busy thread
// itself reads, and the only thing that reads it is PHP, sampling at the VM
// safe points it already checks EG(vm_interrupt) at.
//
// So: the shell runs on a worker thread, and THIS thread — the page, in a
// browser — posts the interrupt. run.test.mjs pins the same path with a
// callback supplied by the test; here nothing is supplied, and the answer
// comes off a SharedArrayBuffer the two threads share.
//
// Every case is bounded. A ^C that is not delivered is a HANG, and a test that
// hangs reports nothing at all.

import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { haveBuild, NO_BUILD_MSG } from './helper.mjs';

// Dynamic because a static import of a missing dev dependency takes the whole
// file down instead of skipping it.
let ring;
try {
  ring = await import('wasi-sh/ring');
} catch {
  ring = null;
}

const NO_WASI_SH = 'wasi-sh is a dev dependency — npm ci to run the interrupt suite.';
const SKIP = !haveBuild() ? NO_BUILD_MSG : !ring ? NO_WASI_SH : false;
before((t) => { if (SKIP) t.diagnostic(SKIP); });
const opts = { skip: SKIP };

const GUEST = new URL('./interrupt-guest.mjs', import.meta.url);

let busybox;
before(async () => {
  if (SKIP) return;
  const require = createRequire(import.meta.url);
  busybox = await WebAssembly.compile(await readFile(require.resolve('wasi-sh/busybox.wasm')));
});

/**
 * Start a shell on a thread of its own, with a stdin ring this thread writes.
 *
 * `awaitOutput` is what removes the race the whole suite would otherwise have:
 * the interrupt count is read when the builtin is DISPATCHED, so a ^C posted
 * before that is one this command did not receive. Waiting for something the
 * running command itself printed is proof that dispatch has happened.
 */
function startShell(script) {
  const sab = ring.createRing();
  const writer = new ring.RingWriter(sab);
  const worker = new Worker(GUEST, { workerData: { wasm: busybox, sab, script } });

  let seen = '';
  let waiters = [];
  const check = () => {
    waiters = waiters.filter((w) => (w.re.test(seen) ? (w.resolve(), false) : true));
  };

  const exited = new Promise((resolve, reject) => {
    worker.on('message', (m) => {
      if (m.type === 'out') { seen += m.text; check(); }
      else if (m.type === 'error') reject(new Error(m.message));
      else if (m.type === 'exit') resolve(m);
    });
    worker.on('error', reject);
  });

  return {
    writer,
    awaitOutput: (re) => new Promise((resolve) => { waiters.push({ re, resolve }); check(); }),
    /** Bounded, because an undelivered ^C is a hang and a hang reports nothing. */
    async finish(ms = 15000) {
      let timer;
      const late = new Promise((r) => { timer = setTimeout(() => r(null), ms); });
      const m = await Promise.race([exited, late]);
      clearTimeout(timer);
      await worker.terminate();
      if (m === null) assert.fail(`nothing was delivered within ${ms}ms; terminal so far:\n${seen}`);
      return m;
    },
  };
}

describe('a ^C into a running php', opts, () => {
  test('stops it, and the shell and the warm instance carry on', async () => {
    // The cue is printed by PHP itself, from inside the builtin — so by the
    // time this thread sees it, the interrupt count has already been read and
    // a ^C posted now is one this command receives. A cue printed by the SHELL
    // would be a race against dispatch.
    const sh = startShell(
      "php -r 'echo \"running\\n\"; while (true) { $n = ($n ?? 0) + 1; }'\n"
      + 'echo "rc=$?"\n'
      + "php -r 'echo \"still here: \", 6 * 7, \"\\n\";'\n",
    );

    await sh.awaitOutput(/running/);
    const t0 = Date.now();
    sh.writer.interrupt();
    const m = await sh.finish();

    assert.match(m.out, /rc=130/, 'the shell read 128 + SIGINT');
    assert.match(m.out, /Fatal error: Interrupted/, 'and PHP said why, on stderr');
    assert.match(m.out, /still here: 42/,
      'the same instance ran the next command — this is not terminate()');
    assert.equal(m.code, 0, 'and the shell exited normally');
    assert.ok(Date.now() - t0 < 10000, 'delivered promptly, not at some deadline');
  });

  test('an interrupt with nothing running does not cancel the command after it', async () => {
    // The count-not-a-flag invariant, reaching all the way into the VM. A ^C
    // typed at an idle prompt is delivered to nobody, and the command typed
    // afterwards takes a fresh baseline; a pending FLAG would be sampled by
    // the loop below within a few hundred opcodes and report 130 for work the
    // user never asked to cancel.
    //
    // `read -t 1` is what makes the ordering a margin rather than an argument:
    // the interrupt is posted while the shell is demonstrably between commands,
    // parked on the ring with nothing dispatched.
    const sh = startShell(
      'echo mark\n'
      + 'read -t 1 _\n'
      + "php -r 'for ($i = 0; $i < 300000; $i++) {} echo \"ran\\n\";'\n"
      + 'echo "rc=$?"\n',
    );

    await sh.awaitOutput(/mark/);
    sh.writer.interrupt();
    const m = await sh.finish();

    assert.match(m.out, /ran/, 'it ran to completion');
    assert.match(m.out, /rc=0/, 'and reported success, not a cancel');
    assert.doesNotMatch(m.out, /Interrupted/);
  });

  test('a second ^C stops the next script too, so a terminal stays usable', async () => {
    // Once per call, and a call is one command: the disarm that keeps a single
    // ^C from firing again inside PHP's own request shutdown must not leave the
    // NEXT command uninterruptible. A terminal where the first ^C works and the
    // second does not is one reload away from being no terminal at all.
    const sh = startShell(
      "php -r 'echo \"first\\n\"; while (true) {}'\n"
      + 'echo "one=$?"\n'
      + "php -r 'echo \"second\\n\"; while (true) {}'\n"
      + 'echo "two=$?"\n',
    );

    await sh.awaitOutput(/first/);
    sh.writer.interrupt();
    await sh.awaitOutput(/second/);
    sh.writer.interrupt();
    const m = await sh.finish();

    assert.match(m.out, /one=130/);
    assert.match(m.out, /two=130/);
  });
});
