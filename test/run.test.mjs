// SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>
//
// SPDX-License-Identifier: ISC

// The embedding API — run(), and the stdio it is built on.
//
// The rest of the suite exercises run() by using it for everything (see
// helper.mjs), which covers the happy path thoroughly and says nothing about
// the edges. This file is the edges: what each option means, what belongs to
// one call and not the next, what happens when a module's streams are not
// phasm's to route, and what an embedder's own print/printErr/stdin still do.

import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { sharedModule, freshModule, haveBuild, NO_BUILD_MSG } from './helper.mjs';

const SKIP = !haveBuild();
before((t) => { if (SKIP) t.diagnostic(NO_BUILD_MSG); });
const opts = { skip: SKIP ? NO_BUILD_MSG : false };

const dec = new TextDecoder();

// ─── the result shape ────────────────────────────────────────────────────────

describe('run()', opts, () => {
  test('returns stdout, stderr and an exit code', async () => {
    const php = await sharedModule();
    const r = php.run({ code: 'fwrite(STDERR, "warned"); echo "out"; exit(3);' });

    assert.deepEqual(r, { stdout: 'out', stderr: 'warned', exitCode: 3 });
  });

  test('is synchronous, and survives being awaited anyway', async () => {
    const php = await sharedModule();
    const direct = php.run({ code: 'echo 1;' });
    const awaited = await php.run({ code: 'echo 1;' });

    assert.equal(direct.stdout, '1');
    assert.equal(awaited.stdout, '1', 'awaiting a plain object must still work');
  });

  test('collects output that never ended in a newline', async () => {
    const php = await sharedModule();
    // The trap in print/printErr, and the reason the module routes bytes.
    assert.equal(php.run({ code: 'echo 42;' }).stdout, '42');
  });

  test('keeps stdout and stderr apart', async () => {
    const php = await sharedModule();
    const r = php.run({ code: 'echo "a"; trigger_error("b"); echo "c";' });

    assert.equal(r.stdout, 'ac');
    assert.match(r.stderr, /b/);
  });

  test('does not carry output into the next call', async () => {
    const php = await sharedModule();
    php.run({ code: 'echo "first";' });

    assert.deepEqual(php.run({ code: 'echo "second";' }).stdout, 'second');
  });

  // A module that runs main() by itself has spent the one entry point that ends
  // in exit() before the embedder has a reference to it, and every run() after
  // that refuses. That used to be what `await Phasm()` produced, and the cure
  // was a `noInitialRun` flag the caller had to know to pass. INVOKE_RUN=0 in
  // the link is the cure that needs nothing from the caller — so what is
  // asserted here is that the plainest possible embedding works at all.
  test('runs on a module created with no options at all', async () => {
    const php = await freshModule();

    assert.equal(php.run({ code: 'echo 6 * 7;' }).stdout, '42');
    assert.equal(php.run({ code: 'echo "again";' }).stdout, 'again');
  });
});

// ─── what to run ─────────────────────────────────────────────────────────────

describe('run() argv', opts, () => {
  test('code is a -r snippet', async () => {
    const php = await sharedModule();
    assert.equal(php.run({ code: 'echo 6 * 7;' }).stdout, '42');
  });

  test('script is mounted at /main.php and run', async () => {
    const php = await sharedModule();
    const r = php.run({ script: '<?php echo __FILE__;' });

    assert.equal(r.stdout, '/main.php');
  });

  test('args wins, and the script is mounted regardless', async () => {
    const php = await sharedModule();
    const r = php.run({
      script: '<?php echo "not this";',
      args: ['-r', 'echo strlen(file_get_contents("/main.php"));'],
    });

    assert.equal(r.stdout, String('<?php echo "not this";'.length));
  });

  test('argv reaches the script, with argv[0] supplied', async () => {
    const php = await sharedModule();
    const r = php.run({
      files: { '/argv.php': '<?php echo implode(",", $argv);' },
      args: ['/argv.php', 'one', 'two'],
    });

    assert.equal(r.stdout, '/argv.php,one,two');
  });

  test('no argv at all reads the script from stdin, as the CLI does', async () => {
    const php = await sharedModule();
    const r = php.run({ stdin: '<?php echo "from stdin";' });

    assert.equal(r.stdout, 'from stdin');
  });
});

// ─── files, cwd, env ─────────────────────────────────────────────────────────

describe('run() environment', opts, () => {
  test('files are written before the run', async () => {
    const php = await sharedModule();
    const r = php.run({
      files: { '/one.php': '<?php echo "one";' },
      args: ['/one.php'],
    });

    assert.equal(r.stdout, 'one');
  });

  test('missing parent directories are created', async () => {
    const php = await sharedModule();
    const r = php.run({
      files: { '/deep/er/still/app.php': '<?php echo "deep";' },
      args: ['/deep/er/still/app.php'],
    });

    assert.equal(r.stdout, 'deep');
  });

  test('files take bytes as well as text', async () => {
    const php = await sharedModule();
    const r = php.run({
      files: { '/bytes.bin': new Uint8Array([0, 1, 2, 255]) },
      code: 'echo implode(",", array_values(unpack("C*", file_get_contents("/bytes.bin"))));',
    });

    assert.equal(r.stdout, '0,1,2,255');
  });

  test('cwd applies to the call that asked for it, and no other', async () => {
    const php = await sharedModule();
    php.run({ files: { '/somewhere/x.php': '<?php echo "x";' } });

    assert.equal(php.run({ code: 'echo getcwd();', cwd: '/somewhere' }).stdout, '/somewhere');
    assert.notEqual(php.run({ code: 'echo getcwd();' }).stdout, '/somewhere');
  });

  test('env applies to the call that asked for it, and no other', async () => {
    const php = await sharedModule();

    assert.equal(php.run({ code: 'echo getenv("APP_ENV");', env: { APP_ENV: 'dev' } }).stdout, 'dev');
    assert.equal(php.run({ code: 'var_export(getenv("APP_ENV"));' }).stdout, 'false');
  });
});

// ─── stdin ───────────────────────────────────────────────────────────────────

describe('run() stdin', opts, () => {
  const READ_ALL = 'echo strtoupper(stream_get_contents(STDIN));';

  test('takes a string', async () => {
    const php = await sharedModule();
    assert.equal(php.run({ code: READ_ALL, stdin: 'hello' }).stdout, 'HELLO');
  });

  test('takes bytes', async () => {
    const php = await sharedModule();
    const r = php.run({ code: READ_ALL, stdin: new TextEncoder().encode('bytes') });

    assert.equal(r.stdout, 'BYTES');
  });

  test('ends at EOF, and is refilled for the next call', async () => {
    const php = await sharedModule();
    php.run({ code: READ_ALL, stdin: 'first' });

    assert.equal(php.run({ code: READ_ALL, stdin: 'second' }).stdout, 'SECOND');
  });

  test('a call that names no stdin reads EOF, not the last one', async () => {
    const php = await sharedModule();
    php.run({ code: READ_ALL, stdin: 'leftovers' });

    assert.equal(php.run({ code: 'var_dump(stream_get_contents(STDIN));' }).stdout, 'string(0) ""\n');
  });

  test('a function is pulled from until it returns nothing', async () => {
    const php = await sharedModule();
    const chunks = [new TextEncoder().encode('one '), new TextEncoder().encode('two')];
    const r = php.run({ code: READ_ALL, stdin: () => chunks.shift() || new Uint8Array(0) });

    assert.equal(r.stdout, 'ONE TWO');
  });

  test('a function is never called for a command that does not read', async () => {
    const php = await sharedModule();
    let asked = 0;
    // The whole reason stdin is pulled: ctx.stdin() blocks in wasi-sh, and on an
    // interactive session it parks everything until the embedder writes.
    const r = php.run({ code: 'echo "no reading here";', stdin: () => { asked++; return null; } });

    assert.equal(r.stdout, 'no reading here');
    assert.equal(asked, 0);
  });
});

// ─── streaming ───────────────────────────────────────────────────────────────

describe('run() onOutput', opts, () => {
  test('streams bytes per channel as they happen', async () => {
    const php = await sharedModule();
    const seen = [];
    const r = php.run({
      code: 'echo "line1\\n"; fwrite(STDERR, "problem\\n"); echo "line2\\n";',
      onOutput: (bytes, channel) => seen.push([channel, dec.decode(bytes)]),
    });

    assert.deepEqual(seen, [
      ['stdout', 'line1\n'],
      ['stderr', 'problem\n'],
      ['stdout', 'line2\n'],
    ]);
    assert.equal(r.stdout, 'line1\nline2\n', 'streaming does not replace collecting');
  });

  test('flushes a trailing chunk with no newline', async () => {
    const php = await sharedModule();
    const seen = [];
    php.run({ code: 'echo "no newline";', onOutput: (bytes) => seen.push(dec.decode(bytes)) });

    assert.deepEqual(seen, ['no newline']);
  });

  test('hands over bytes, so binary survives', async () => {
    const php = await sharedModule();
    let got = new Uint8Array(0);
    php.run({ code: 'echo "\\x00\\x01\\xff";', onOutput: (bytes) => { got = bytes; } });

    assert.deepEqual(Array.from(got), [0, 1, 255]);
  });

  // A sink that throws is the ordinary case on the serving path, not a
  // defensive one: run()'s onOutput is where a wasi-sh builtin writes its
  // stdout, and since wasi-sh 0.5.0 that write throws when a device refuses
  // it. Two things have to hold, and neither did.
  test('hands a chunk over once, even when the sink throws', async () => {
    const php = await freshModule();
    const seen = [];

    // The bytes must be gone from the buffer before the sink is called.
    // Clearing afterwards left them there, so the next flush delivered the same
    // chunk a second time — and the next flush is the one end() does in a
    // `finally`, so the sink threw again from there too.
    assert.throws(() => php.run({
      code: 'echo "one\\n"; echo "two\\n";',
      onOutput: (bytes) => {
        seen.push(dec.decode(bytes));
        throw new Error('the device refused this write');
      },
    }), /the device refused this write/);

    assert.deepEqual(seen, ['one\n'], 'the first chunk, delivered exactly once');
  });

  // And the reason has to survive the trip. The sink runs in a wasm frame, and
  // Emscripten's TTY write catches everything its put_char loop raises and
  // reports EIO — so PHP sees a failed write on stdout and gives up. Failing
  // the call is right; failing it as a bare 255 with nothing to point at is
  // what an embedder cannot diagnose.
  test('raises the sink\'s own error, not a nameless 255', async () => {
    const php = await freshModule();
    const refusal = new Error('/dev/host refused this write');

    assert.throws(
      () => php.run({ code: 'echo "out\\n";', onOutput: () => { throw refusal; } }),
      (e) => e === refusal,
    );
  });

  // The failure belongs to the call that had it, and to no later one.
  test('a sink that threw does not spend the instance', async () => {
    const php = await freshModule();

    assert.throws(() => php.run({ code: 'echo "x\\n";', onOutput: () => { throw new Error('no'); } }));
    assert.deepEqual(php.run({ code: 'echo 42;' }), { stdout: '42', stderr: '', exitCode: 0 });
  });

  test('collect: false skips the buffering and still streams', async () => {
    const php = await sharedModule();
    const seen = [];
    const r = php.run({
      code: 'echo "streamed";',
      collect: false,
      onOutput: (bytes) => seen.push(dec.decode(bytes)),
    });

    assert.deepEqual(seen, ['streamed']);
    assert.deepEqual({ stdout: r.stdout, stderr: r.stderr }, { stdout: '', stderr: '' });
  });
});

// ─── the module's own stdio, when no call is in flight ────────────────────────

describe('idle stdio', opts, () => {
  test('delegates to print and printErr, still line buffered', async () => {
    const out = [];
    const err = [];
    const php = await freshModule({ print: (t) => out.push(t), printErr: (t) => err.push(t) });

    // phasmRun() is the primitive: nothing captures, so this is the path an
    // embedder that never calls run() is on, and it must not have changed.
    php.phasmRun(['-r', 'echo "a line\\n"; fwrite(STDERR, "an error\\n");']);

    assert.deepEqual(out, ['a line']);
    assert.deepEqual(err, ['an error']);
  });

  test('delegates to a raw stdout callback when one was given', async () => {
    const seen = [];
    const php = await freshModule({ stdout: (c) => seen.push(c) });
    php.phasmRun(['-r', 'echo "hi";']);

    assert.equal(dec.decode(Uint8Array.from(seen.filter((c) => c !== null))), 'hi');
  });

  test('delegates to a stdin callback for a call that names none', async () => {
    const input = new TextEncoder().encode('from the embedder');
    let pos = 0;
    const php = await freshModule({ stdin: () => (pos < input.length ? input[pos++] : null) });

    assert.equal(php.run({ code: 'echo stream_get_contents(STDIN);' }).stdout, 'from the embedder');
  });

  test('a call that names its own stdin does not touch the embedder\'s', async () => {
    let asked = 0;
    const php = await freshModule({ stdin: () => { asked++; return null; } });
    const r = php.run({ code: 'echo stream_get_contents(STDIN);', stdin: 'mine' });

    assert.equal(r.stdout, 'mine');
    assert.equal(asked, 0);
  });

  test('run() takes over from print for the duration of the call', async () => {
    const out = [];
    const php = await freshModule({ print: (t) => out.push(t) });
    const r = php.run({ code: 'echo "captured\\n";' });

    assert.equal(r.stdout, 'captured\n');
    assert.deepEqual(out, [], 'a captured call must not also print');
  });
});

// ─── capture, and when it cannot be done ─────────────────────────────────────

describe('phasmCapture()', opts, () => {
  test('collects around any call, and hands back what it returned', async () => {
    const php = await sharedModule();
    const r = php.phasmCapture(() => php.phasmRun(['-r', 'echo "via the primitive";']));

    assert.equal(r.stdout, 'via the primitive');
    assert.equal(r.value, 0);
  });

  test('restores the module even when the call throws', async () => {
    const php = await sharedModule();
    assert.throws(() => php.phasmCapture(() => { throw new Error('boom'); }), /boom/);

    // If end() had been skipped the module would still be capturing, and this
    // would report a call already in flight.
    assert.equal(php.run({ code: 'echo "still fine";' }).stdout, 'still fine');
  });

  test('does not nest', async () => {
    const php = await sharedModule();
    assert.throws(
      () => php.phasmCapture(() => php.run({ code: 'echo 1;' })),
      /already in flight/,
    );
  });

  test('refuses on a module whose streams were claimed elsewhere', async () => {
    // The recipe every embedder used to hand-roll. It still works — it just
    // takes the streams, so the module says so instead of reporting that PHP
    // printed nothing.
    const php = await freshModule({ preRun: [(m) => m.FS.init(() => null, () => {}, () => {})] });

    assert.throws(() => php.run({ code: 'echo 1;' }), /standard streams were claimed/);
  });

  test('refuses on a module built with noFSInit', async () => {
    const php = await freshModule({ noFSInit: true });

    assert.throws(() => php.run({ code: 'echo 1;' }), /standard streams were claimed/);
  });

});

// ─── holding on to output ────────────────────────────────────────────────────

describe('large output', opts, () => {
  test('is held at its own size, not one array slot per byte', async () => {
    const php = await sharedModule();
    const megabytes = 8;

    const before = process.memoryUsage().heapUsed;
    const r = php.run({ code: `echo str_repeat("x", ${megabytes} * 1024 * 1024);` });
    const held = process.memoryUsage().heapUsed - before;

    assert.equal(r.stdout.length, megabytes * 1024 * 1024);
    // A number-per-byte array costs ~8x the output and was measured at ~400 MB
    // for this; the bound is loose because what is being caught is that shape,
    // not a byte count. The decoded string alone is 2 bytes a character.
    assert.ok(
      held < megabytes * 1024 * 1024 * 6,
      `${megabytes} MiB of output held ${Math.round(held / 1024 / 1024)} MB`,
    );
  });
});
