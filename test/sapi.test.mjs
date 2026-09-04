// SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>
//
// SPDX-License-Identifier: ISC

// The phasm SAPI: what makes one instance safely reusable.
//
// php.test.mjs is about the build — does the interpreter run, are the promised
// extensions linked. This suite is about the embedding contract, and every test
// here maps to a defect measured through Emscripten's callMain(), which
// re-enters the CLI's main() once per call:
//
//   1. the exit status latched on the first non-zero one, forever;
//   2. fatal errors went to stdout, so `2>/dev/null` could not suppress them;
//   3. the instance died at call ~104, deterministically.
//
// A shell calling `php` as a builtin does all three within one page load, so
// these are the tests that decide whether phasm is embeddable at all.

import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { php, evalPhp, sharedModule, freshModule, haveBuild, NO_BUILD_MSG } from './helper.mjs';

const SKIP = !haveBuild();
before((t) => { if (SKIP) t.diagnostic(NO_BUILD_MSG); });
const opts = { skip: SKIP ? NO_BUILD_MSG : false };

// ─── defect 3: the call-104 cliff ────────────────────────────────────────────

describe('repeated invocation', opts, () => {
  // The one that gates everything. Through callMain() this died at call ~104
  // with "memory access out of bounds" — and at ~97 when each call allocated a
  // megabyte, near-identical under a 100x difference, so it was a fixed
  // per-call leak rather than heap exhaustion.
  test('survives 200 calls on one instance, all correct', async () => {
    for (let i = 1; i <= 200; i++) {
      const r = await evalPhp(`echo ${i} * 2;`);
      assert.equal(r.stdout, String(i * 2), `call ${i} produced ${JSON.stringify(r.stdout)}`);
      assert.equal(r.exitCode, 0, `call ${i} exited ${r.exitCode}`);
    }
  });

  test('survives calls that allocate heavily', async () => {
    for (let i = 1; i <= 40; i++) {
      const r = await evalPhp('$a = str_repeat("x", 1048576); echo strlen($a);');
      assert.equal(r.stdout, '1048576', `call ${i}`);
    }
  });

  // Narrow on purpose: this sees PHP's own arena and nothing else. Descriptors
  // and the C heap need the tests below.
  test("does not grow PHP's allocator arena across calls", async () => {
    const usage = async () => Number((await evalPhp('echo memory_get_usage(true);')).stdout);

    await usage(); // first call warms the arena; measure from a steady state
    const early = await usage();
    for (let i = 0; i < 50; i++) await evalPhp('$x = range(1, 1000); echo count($x);');
    const late = await usage();

    assert.equal(late, early, `PHP's arena grew from ${early} to ${late} across 50 calls`);
  });

  // Every request opens php://stdin, php://stdout and php://stderr, and PHP
  // flags them "do not close on shutdown" — correct for a process that is about
  // to exit, a leak of three descriptors per call for one that is not. The SAPI
  // reclaims them, and this is what proves it: the count is exact, so the test
  // fails on the very first leaked descriptor rather than at the cliff.
  //
  // Every invocation mode gets its own case, because the reclaim is a scan of
  // the descriptors above a mark and each mode leaves that range in a different
  // shape. Running a script file is the one that matters most and was the one
  // getting through: PHP opens the script at the mark and closes it at
  // shutdown, so the leaked descriptors sit *above a hole* — and a scan that
  // stopped at the first unused descriptor reclaimed nothing at all, for
  // exactly the invocation the README documents.
  const MODES = {
    '-r': () => evalPhp('echo 1;'),
    'a script file': () => php(['/fd.php'], { files: { '/fd.php': '<?php echo 1;' } }),
    '-f': () => php(['-f', '/fd.php'], { files: { '/fd.php': '<?php echo 1;' } }),
    'a script reading stdin': () => php(['/fd-in.php'], {
      files: { '/fd-in.php': '<?php echo trim(stream_get_contents(STDIN));' },
      stdin: 'x',
    }),
  };

  for (const [mode, run] of Object.entries(MODES)) {
    test(`does not leak file descriptors across calls (${mode})`, async () => {
      const mod = await sharedModule();
      const live = () => mod.FS.streams.filter(Boolean).length;

      await run(); // let one-time registrations settle
      const before = live();
      for (let i = 0; i < 100; i++) await run();

      assert.equal(live(), before, `open descriptors went from ${before} to ${live()} over 100 calls`);
    });
  }

  // Reclaiming descriptors has to be surgical. A persistent connection outlives
  // its request by design and its descriptor sits in exactly the range the
  // leaked ones do, so a reclaim that just closed everything the request opened
  // would quietly break it.
  test('a persistent connection survives the reclaim', async () => {
    const open = '$p = new PDO("sqlite:/persist.sqlite", null, null, [PDO::ATTR_PERSISTENT => true]);';

    const wrote = await evalPhp(
      open + '$p->exec("CREATE TABLE IF NOT EXISTS t (a TEXT)");'
      + '$p->exec("INSERT INTO t VALUES (\'kept\')"); echo "written";'
    );
    assert.equal(wrote.stdout, 'written');

    for (let i = 0; i < 20; i++) await evalPhp('echo 1;');

    const read = await evalPhp(open + 'echo $p->query("SELECT a FROM t")->fetchColumn();');
    assert.equal(read.stdout, 'kept');
  });

  // What the leak actually broke, and why it was worth finding: past ~1365
  // calls the descriptor table filled, PHP gave up registering the standard
  // streams, and STDIN/STDOUT/STDERR stopped existing — with no error until a
  // script touched one. Driven through a script file, because that is the mode
  // that leaked and therefore the only one that ever reached saturation.
  test('the standard streams still exist after 1500 calls', async () => {
    const files = { '/fd-soak.php': '<?php echo 1;' };
    for (let i = 0; i < 1500; i++) await php(['/fd-soak.php'], { files });

    const r = await evalPhp('var_dump(defined("STDIN"), defined("STDOUT"), defined("STDERR"));');
    assert.equal(r.stdout.match(/bool\(true\)/g)?.length, 3, `got ${JSON.stringify(r.stdout)}`);

    const piped = await php(['/late-stdin.php'], {
      files: { '/late-stdin.php': '<?php echo trim(stream_get_contents(STDIN));' },
      stdin: 'still works',
    });
    assert.equal(piped.stdout, 'still works');
  });
});

// ─── options the CLI handles outside do_cli() ────────────────────────────────

describe('option handling', opts, () => {
  // The CLI parses these in main(), which this entry point does not run. Left
  // alone they are not rejected but silently skipped, so `php -Z script.php`
  // would run the script and report success.
  test('an invalid option is a usage error, not a silent success', async () => {
    const r = await php(['-Z', '/whatever.php']);
    assert.notEqual(r.exitCode, 0);
    assert.match(r.stdout + r.stderr, /Usage:/);
  });

  test('-h prints usage and exits 0', async () => {
    const r = await php(['-h']);
    assert.equal(r.exitCode, 0);
    assert.match(r.stdout, /Usage:/);
  });

  test('--help does too', async () => {
    assert.match((await php(['--help'])).stdout, /Usage:/);
  });

  // -d is a module-startup setting and there is no module startup per call, so
  // the honest options are to refuse it or to say so. Saying so keeps scripts
  // that pass it working.
  test('-d reports that it cannot apply per call, and still runs', async () => {
    const r = await php(['-d', 'precision=3', '-r', 'echo "ran";']);
    assert.equal(r.stdout, 'ran');
    assert.match(r.stderr, /-d applies to the whole instance/);
  });

  test('-e says so too, rather than silently doing nothing', async () => {
    const r = await php(['-e', '-r', 'echo "ran";']);
    assert.equal(r.stdout, 'ran');
    assert.match(r.stderr, /-e applies to the whole instance/);
  });

  test('-S says there is no built-in web server', async () => {
    const r = await php(['-S', 'localhost:8080']);
    assert.notEqual(r.exitCode, 0);
    assert.match(r.stderr, /built-in web server/);
  });

  test('a bad option does not disturb the next call', async () => {
    await php(['-Z']);
    assert.equal((await evalPhp('echo "fine";')).stdout, 'fine');
  });
});

// ─── instance-wide ini ───────────────────────────────────────────────────────

describe('phasmStartup', opts, () => {
  test('ini given at startup applies for the life of the instance', async () => {
    const r = await php(['-r', 'echo ini_get("precision");'], { fresh: true, ini: 'precision=3' });
    assert.equal(r.stdout, '3');
  });

  test('refuses ini once PHP is running rather than dropping it', async () => {
    const mod = await sharedModule();
    await evalPhp('echo 1;');
    assert.equal(mod.phasmStartup(), 0, 'a no-op start should still succeed');
    assert.equal(mod.phasmStartup('precision=3'), -1);
  });

  test('refuses a NUL in the ini rather than starting on half of it', async () => {
    // The one entry point that skipped the check the other two run. The
    // packing is NUL-terminated, so a NUL is not an error further down: it is
    // an early terminator, and everything after it is silently dropped while
    // the call reports success — an instance running on some of the settings
    // it was given, with nothing to say which.
    const mod = await freshModule();
    assert.throws(
      () => mod.phasmStartup('precision=3\0memory_limit=64M'),
      /may not contain a NUL byte/,
    );
    // Refused before anything started, so the instance is still configurable.
    assert.equal(mod.phasmStartup('precision=3'), 0);
    assert.equal(mod.run({ code: 'echo ini_get("precision");' }).stdout, '3');
  });
});

// ─── defect 1: the latched exit status ───────────────────────────────────────

describe('exit status', opts, () => {
  test('is reported per call, not latched', async () => {
    assert.equal((await evalPhp('exit(3);')).exitCode, 3);
    assert.equal((await evalPhp('echo "ok";')).exitCode, 0, 'a previous exit(3) leaked into this call');
    assert.equal((await evalPhp('exit(42);')).exitCode, 42);
    assert.equal((await evalPhp('exit(0);')).exitCode, 0);
  });

  test('a fatal error does not poison the next call', async () => {
    const bad = await evalPhp('no_such_function_at_all();');
    assert.notEqual(bad.exitCode, 0);

    const good = await evalPhp('echo "still alive";');
    assert.equal(good.stdout, 'still alive');
    assert.equal(good.exitCode, 0);
  });

  test('exit() does not shut the module down', async () => {
    await evalPhp('exit(7);');
    const after = await evalPhp('echo PHP_VERSION;');
    assert.match(after.stdout, /^8\.5\./);
  });
});

// ─── defect 2: errors on the wrong stream ────────────────────────────────────

describe('error output', opts, () => {
  // The CLI defaults display_errors to STDOUT. That makes `php x 2>/dev/null`
  // useless and poisons `$(php x)` with the error text, which for a shell
  // builtin is the difference between composable and not.
  test('a fatal error goes to stderr, and stdout stays clean', async () => {
    const r = await evalPhp('echo "output"; no_such_function_at_all();');
    assert.match(r.stderr, /no_such_function_at_all/);
    assert.equal(r.stdout, 'output', 'the error text landed on stdout');
  });

  test('warnings go to stderr too', async () => {
    const r = await evalPhp('echo "x"; $u = $undefined_variable;');
    assert.match(r.stderr, /Warning|Undefined variable/);
    assert.equal(r.stdout, 'x');
  });

  test('a parse error goes to stderr', async () => {
    const r = await php(['/parse-err.php'], { files: { '/parse-err.php': '<?php this is not php ((( ;' } });
    assert.match(r.stderr, /Parse error|syntax error/i);
    assert.notEqual(r.exitCode, 0);
  });
});

// ─── per-call context ────────────────────────────────────────────────────────

describe('per-call cwd and env', opts, () => {
  test('cwd applies to the call that asked for it', async () => {
    const r = await php(['-r', 'echo getcwd();'], { files: { '/work/keep.txt': 'x' }, cwd: '/work' });
    assert.equal(r.stdout, '/work');
  });

  test('a relative include resolves against the call cwd', async () => {
    const r = await php(['-r', 'require "lib.php"; echo greet();'], {
      files: { '/proj/lib.php': '<?php function greet() { return "hi"; }' },
      cwd: '/proj',
    });
    assert.equal(r.stdout, 'hi');
  });

  // The working directory is process state. Without an explicit restore, the
  // directory one call ran in becomes the starting directory of the next.
  test('cwd does not leak into the next call', async () => {
    await php(['-r', 'echo getcwd();'], { files: { '/work/keep.txt': 'x' }, cwd: '/work' });
    const r = await evalPhp('echo getcwd();');
    assert.equal(r.stdout, '/');
  });

  test("a script's own chdir does not leak either", async () => {
    assert.equal((await evalPhp('chdir("/tmp"); echo getcwd();')).stdout, '/tmp');
    assert.equal((await evalPhp('echo getcwd();')).stdout, '/');
  });

  test('env reaches the script', async () => {
    const r = await evalPhp('echo getenv("PHASM_TEST");', { env: { PHASM_TEST: 'present' } });
    assert.equal(r.stdout, 'present');
  });

  // setenv() outlives a call, so without explicit cleanup `FOO=1 php x; php y`
  // would leak FOO into the second command.
  test('env does not leak into the next call', async () => {
    await evalPhp('echo getenv("PHASM_LEAK");', { env: { PHASM_LEAK: 'yes' } });
    const r = await evalPhp('var_export(getenv("PHASM_LEAK"));');
    assert.equal(r.stdout, 'false');
  });

  test('$_SERVER sees the per-call environment', async () => {
    const r = await evalPhp('echo $_SERVER["PHASM_SERVER"] ?? "missing";', { env: { PHASM_SERVER: 'seen' } });
    assert.equal(r.stdout, 'seen');
  });

  // Cleanup used to unset, which is not the inverse of overriding: a call that
  // set a variable the module already had deleted it for the whole instance.
  // `PATH=/bin php -r ...` cost every later call its PATH.
  test('overriding a variable puts the old value back, not nothing', async () => {
    const before = (await evalPhp('echo getenv("PATH");')).stdout;
    assert.notEqual(before, '', 'this test needs a variable the module already has');

    const during = await evalPhp('echo getenv("PATH");', { env: { PATH: '/somewhere-else' } });
    assert.equal(during.stdout, '/somewhere-else');

    assert.equal((await evalPhp('echo getenv("PATH");')).stdout, before);
  });
});

// ─── stdin ───────────────────────────────────────────────────────────────────

describe('stdin', opts, () => {
  test('a script can read stdin to EOF', async () => {
    const r = await php(['/in.php'], {
      files: { '/in.php': '<?php echo strtoupper(trim(stream_get_contents(STDIN)));' },
      stdin: 'hello\n',
    });
    assert.equal(r.stdout, 'HELLO');
  });

  // The stdin position is per call; a second read must not resume where the
  // first stopped, and must not block on an exhausted stream.
  test('stdin is refilled for the next call', async () => {
    const script = { '/in2.php': '<?php echo trim(stream_get_contents(STDIN));' };
    assert.equal((await php(['/in2.php'], { files: script, stdin: 'first' })).stdout, 'first');
    assert.equal((await php(['/in2.php'], { files: script, stdin: 'second' })).stdout, 'second');
    assert.equal((await php(['/in2.php'], { files: script })).stdout, '');
  });
});

// ─── state isolation between calls ───────────────────────────────────────────

describe('isolation', opts, () => {
  test('functions and classes redeclare cleanly', async () => {
    const code = 'function f() { return 1; } class C {} echo f(), (int) class_exists("C");';
    assert.equal((await evalPhp(code)).stdout, '11');
    assert.equal((await evalPhp(code)).stdout, '11', 'a redeclare error means the last call leaked');
  });

  test('ini_set does not persist', async () => {
    await evalPhp('ini_set("precision", "3");');
    const r = await evalPhp('echo ini_get("precision");');
    assert.equal(r.stdout, '14');
  });

  test('globals do not survive', async () => {
    await evalPhp('$GLOBALS["phasm_leak"] = "leaked";');
    const r = await evalPhp('var_export(isset($GLOBALS["phasm_leak"]));');
    assert.equal(r.stdout, 'false');
  });

  test('include_once resets between calls', async () => {
    const files = { '/once.php': '<?php echo "included";' };
    assert.equal((await php(['-r', 'include_once "/once.php";'], { files })).stdout, 'included');
    assert.equal((await php(['-r', 'include_once "/once.php";'], { files })).stdout, 'included');
  });

  // php_cli.c keeps the script name in file-statics that outlive the request
  // and point into argv — which belongs to the caller and is freed as soon as
  // the call returns. $_SERVER is built from them by strlen(), so a stale one
  // is a read of freed memory on the *next* call, not this one.
  test('$_SERVER does not carry pointers from the previous call', async () => {
    await php(['/named.php'], { files: { '/named.php': '<?php echo "ran";' } });

    const r = await evalPhp('echo json_encode([$_SERVER["SCRIPT_FILENAME"], $_SERVER["PHP_SELF"]]);');
    assert.equal(r.stdout, '["","Standard input code"]');
  });

  test('output buffering does not carry over', async () => {
    await evalPhp('ob_start(); echo "buffered";');
    const r = await evalPhp('echo "clean";');
    assert.equal(r.stdout, 'clean');
  });
});

// ─── the recursion guard ─────────────────────────────────────────────────────

/**
 * PHP's own ZEND_CHECK_STACK_LIMIT, which this build has to ask for by hand and
 * then correct.
 *
 * Ask for, because Zend/Zend.m4 decides whether to define it by COMPILING a
 * program and RUNNING it to see which way the stack grows, and a cross build
 * cannot run one — so the guard was compiled out of every extension that has
 * one, silently. scripts/build.sh answers the probe with a cache variable.
 *
 * Correct, because what the guard reads is a frame address, and under wasm that
 * is not a recursion measure: locals live in the VM's own local slots and only
 * address-taken data is spilled to the shadow stack. Measured on this build,
 * the frame address moves 400 bytes per level of php_var_dump() and *zero* per
 * level of php_json_encode_zval() — so an uncorrected guard fires for one
 * recursion and never for the other, which is worse than no guard because it
 * looks present. patches/php-8.5.9/0005-emscripten-stack-limit.patch gives a
 * guarded frame a size so the two agree.
 *
 * What each site does when it fires is upstream's business and deliberately not
 * uniform — json_encode() reports a depth error, serialize() throws, the
 * compiler raises a compile error. The claim these tests make is only that the
 * call ENDS INSIDE PHP, with something a script can see, rather than ending
 * outside it in a trap that takes the request with it.
 */
describe('the recursion guard', opts, () => {
  const nest = (depth, tail) =>
    `$a = 1; for ($i = 0; $i < ${depth}; $i++) { $a = [$a]; } ${tail}`;

  test('is compiled in, and its budget is the one phasm set', async () => {
    // ini_get() reporting a value is not evidence the guard uses it: zend.c
    // works EG(stack_limit) out in zend_startup(), which runs before ini is
    // read, and nothing upstream recomputes it — phasm_startup() does. So the
    // setting is checked here and its EFFECT is checked below.
    const r = await evalPhp('echo ini_get("zend.max_allowed_stack_size");');
    assert.equal(r.stdout, '512K');
  });

  // The calibration, and the test that has to fail if it ever drifts.
  //
  // The guard is a proxy: it counts a reservation the 0005 patch makes in each
  // guarded frame, and the thing it is standing in for is the JS engine's wasm
  // frame stack, which nothing can read. So the two numbers have to be kept in
  // an order that nothing in the build enforces — the guard must fire BELOW the
  // depth at which the engine gives up, or it fires after the call has already
  // stopped existing and might as well not be there.
  //
  // 2000 is chosen to sit in the gap: measured, the guard fires at ~900 and
  // json_encode() reaches the engine's limit at ~3450. A depth in between is
  // the only kind of input that can tell the two apart. It catches the drift in
  // both directions and, most importantly, catches the reservation being
  // optimized away entirely — that would leave the guard reading a frame
  // address that does not move, and this would throw instead of returning.
  test('fires below the engine\'s own limit, not after it', async () => {
    const r = await evalPhp(nest(2000, 'var_dump(json_encode($a, 0, 1000000));'));

    assert.equal(r.stdout.trim(), 'bool(false)',
      'at a depth between the guard and the engine cliff, the guard should be what stops it');
  });

  // The one that used to trap, and the reason this item existed.
  test('deep json_encode reports a depth error instead of trapping', async () => {
    const r = await evalPhp(
      nest(20000, 'var_dump(json_encode($a, 0, 1000000)); echo json_last_error_msg();'),
    );

    assert.equal(r.stdout, 'bool(false)\nMaximum stack depth exceeded');
    assert.equal(r.stderr, '');
  });

  // serialize() is the same guard reached through the site that throws, so the
  // budget is readable from the message — which is what pins that the ini
  // setting is doing something rather than merely being stored.
  test('deep serialize throws an Error naming the budget', async () => {
    const r = await evalPhp(nest(20000,
      'try { serialize($a); } catch (Error $e) { echo $e->getMessage(); }'));

    assert.match(r.stdout, /^Maximum call stack size of (\d+) bytes/, r.stdout);
    const budget = Number(r.stdout.match(/of (\d+) bytes/)[1]);
    // 512 KiB, less whatever zend.reserved_stack_size auto-detected. A guard
    // running on the auto-detected whole shadow stack would report ~4 MiB here
    // and fire too late to be worth having.
    assert.ok(budget > 256 * 1024 && budget <= 512 * 1024,
      `budget ${budget} is not the 512 KiB phasm asked for`);
  });

  // The guard has to be invisible to real data. A thousand levels of nesting is
  // already far past anything a document reaches, and this is two orders below
  // it — if this ever fails the budget has been set wrong, not exceeded.
  test('ordinary nesting is untouched', async () => {
    const r = await evalPhp(nest(100, 'echo strlen(json_encode($a, 0, 1000000));'));

    assert.equal(r.stdout, '201');
    assert.equal(r.stderr, '');
  });

  test('a guarded failure leaves the instance clean', async () => {
    const mod = await freshModule();

    for (let i = 0; i < 5; i++) {
      const r = mod.run({ code: nest(20000, 'json_encode($a, 0, 1000000);') });
      assert.equal(r.stderr, '', `round ${i + 1}`);
    }

    assert.equal(mod.run({ code: 'echo "alive";' }).stdout, 'alive');
  });

  // The knob is load-bearing rather than decorative: an embedder running
  // trusted code may want the depth back, and the README says how.
  //
  // Turning it off has to stay SAFE, which is a stronger claim than it sounds
  // and is what sets PHASM_STACK_SIZE. The reservation each guarded frame makes
  // does not go away when the checking does, so with the guard off a deep
  // json_encode() spends 1621 bytes a level all the way to the engine's limit
  // at ~3450 — 5.3 MiB. On the 4 MiB stack this build used to have, that is not
  // a trap, it is a write past the end of the stack into whatever is below it,
  // and with no STACK_OVERFLOW_CHECK nothing reports it. The stack is 8 MB so
  // that this ends in the recoverable failure it is supposed to.
  test('the budget is a knob, and -1 turns the guard off safely', async () => {
    const mod = await freshModule();
    assert.equal(mod.phasmStartup('zend.max_allowed_stack_size=-1'), 0);

    assert.throws(
      () => mod.run({ code: nest(20000, 'json_encode($a, 0, 1000000);') }),
      RangeError,
      'with the guard off, the same script should reach the engine\'s limit again',
    );

    // Reaching the engine's limit is a trap, and a trap is survivable — but
    // running off the end of the shadow stack on the way there is not, and it
    // would show up here as anything from a wrong answer to a dead instance.
    assert.equal(mod.run({ code: 'echo "alive";' }).stdout, 'alive');
    assert.equal(mod.run({ code: 'echo 6 * 7;' }).stdout, '42');
    assert.equal(mod.run({ code: 'echo json_encode(["a" => [1, 2, 3]]);' }).stdout,
      '{"a":[1,2,3]}');
  });
});

// ─── surviving a wasm trap ───────────────────────────────────────────────────

/**
 * A script that traps rather than failing.
 *
 * Deep C recursion is the only way ordinary PHP reaches one: the limit it hits
 * is the *JS engine's* wasm frame stack, which no emcc flag sizes and which no
 * wasm program can read. There is no fatal to produce at that point — the call
 * simply stops existing, and only phasm_recover() puts the instance back
 * together.
 *
 * It used to be json_encode() here, and it cannot be any more: the recursion
 * guard turns that one into an ordinary `false` with JSON_ERROR_DEPTH, which is
 * the whole point of it. unserialize() is what is left, because upstream guards
 * the *serialiser* and not the parser — ext/standard/var_unserializer.re has no
 * ZEND_CHECK_STACK_LIMIT check at all — and its own `max_depth` option, which
 * would otherwise stop this at 4096, can be switched off from the script.
 *
 * That is not a gap being exploited for convenience. A guard that covered
 * everything would leave phasm_recover() untestable while doing nothing to make
 * it unnecessary, since the guard is a knob an embedder can turn off. This
 * script keeps the recovery path honest either way.
 *
 * The depth is far past the cliff on purpose — measured at ~5000, run at 20000.
 * It is not a number to tune: a value that only just trapped would start
 * passing the day a build got faster or an engine grew its budget, and the test
 * would go green while testing nothing.
 */
const TRAPPING_SCRIPT =
  '$s = str_repeat("a:1:{i:0;", 20000) . "i:1;" . str_repeat("}", 20000);'
  + ' unserialize($s, ["max_depth" => 0]);';

describe('surviving a trap', opts, () => {
  /** Run the trapping script and assert it really did trap. */
  function trap(mod) {
    assert.throws(
      () => mod.run({ code: TRAPPING_SCRIPT }),
      RangeError,
      'the script was supposed to exhaust the engine\'s wasm frame stack',
    );
  }

  // The one this exists for. A trap destroys the guest's frames and resumes in
  // JS, so php_request_shutdown() never runs — and the abandoned request's
  // constants are still registered when the next one starts. Left alone the
  // instance keeps working while printing "Constant PHP_CLI_PROCESS_TITLE
  // already defined" on stderr for every later call, which for a shell builtin
  // means one bad script costs the whole session.
  test('the next call is clean, not merely alive', async () => {
    const mod = await freshModule();
    mod.run({ code: 'echo "warm";' });

    trap(mod);

    const after = mod.run({ code: 'echo "alive";' });
    assert.equal(after.stdout, 'alive');
    assert.equal(after.exitCode, 0);
    assert.equal(after.stderr, '', 'the abandoned request left warnings behind');
  });

  test('and stays clean, call after call', async () => {
    const mod = await freshModule();
    trap(mod);

    for (let i = 0; i < 10; i++) {
      const r = mod.run({ code: 'echo "ok";' });
      assert.equal(r.stderr, '', `call ${i + 1} after the trap`);
    }
  });

  test('repeated traps do not accumulate', async () => {
    const mod = await freshModule();

    for (let i = 0; i < 5; i++) {
      trap(mod);
      const r = mod.run({ code: 'echo "ok";' });
      assert.equal(r.stdout, 'ok', `after trap ${i + 1}`);
      assert.equal(r.stderr, '', `after trap ${i + 1}`);
    }
  });

  // The C stack pointer is a wasm global lowered on entry and raised on return,
  // so a trap — which skips every return — strands it. Nothing reports that:
  // this build has no STACK_OVERFLOW_CHECK, so the leak is silent until the
  // stack runs out thousands of traps later and the module starts overwriting
  // itself. Asserting the pointer directly is the only way to see it while it
  // is still a bug rather than a corruption.
  test('a trapped call gives the C stack back', async () => {
    const mod = await freshModule();
    mod.run({ code: 'echo "warm";' });

    const idle = mod.phasmStackPointer();
    assert.ok(idle > 0, 'expected a stack pointer to compare against');

    for (let i = 1; i <= 5; i++) {
      trap(mod);
      assert.equal(
        mod.phasmStackPointer(), idle,
        `the C stack pointer did not come back after trap ${i}`,
      );
    }

    mod.run({ code: 'echo "ok";' });
    assert.equal(mod.phasmStackPointer(), idle, 'an ordinary call after the traps moved it');
  });

  test('the exit status is still per call afterwards', async () => {
    const mod = await freshModule();
    trap(mod);

    assert.equal(mod.run({ code: 'exit(3);' }).exitCode, 3);
    assert.equal(mod.run({ code: 'echo "x";' }).exitCode, 0);
  });

  // The epilogue a normal call runs at its end has no end to run at here, so
  // everything in it has to be reachable from the recovery path too. These are
  // the three that are observable.
  test('a trapped call leaks no descriptors', async () => {
    const mod = await freshModule();
    mod.run({ code: 'echo "warm";' });
    const before = mod.FS.streams.filter(Boolean).length;

    for (let i = 0; i < 3; i++) trap(mod);

    assert.equal(mod.FS.streams.filter(Boolean).length, before);
  });

  test('a trapped call does not leave its cwd behind', async () => {
    const mod = await freshModule();
    mod.FS.mkdir('/work');

    assert.throws(() => mod.run({ code: TRAPPING_SCRIPT, cwd: '/work' }), RangeError);

    assert.equal(mod.run({ code: 'echo getcwd();' }).stdout, '/');
  });

  // The recovery path runs php_request_shutdown() from a live stack, and a
  // shutdown function is userland code with VM safe points in it — so an
  // interrupt still armed from the trapped call would be sampled there and
  // raise a fatal in the middle of the one shutdown this instance gets. The
  // symptom is a shutdown function that starts and never finishes, which is
  // worse than the trap it is recovering from: the trap loses a call, this
  // loses whatever the script's own teardown was in the middle of.
  test('a trapped call with a ^C outstanding still finishes its shutdown', async () => {
    const mod = await freshModule();
    const dec = new TextDecoder();
    let seen = '';

    // The ^C is armed by the shutdown's own first line, which puts it exactly
    // in the window this is about: false while the script runs, so the trap is
    // what ends the call, and true from the moment the recovery starts running
    // userland code. Timing it any other way is a race — the trapping call is C
    // recursion with no safe point in it, so a poll armed earlier fires in the
    // handful of opcodes before it and interrupts the wrong thing.
    let armed = false;
    // onOutput rather than the returned stdout, because a trapped call returns
    // nothing at all: the recovery's shutdown writes into the capture window
    // and then phasmEnter() rethrows, so a sink is the only thing still holding
    // what it produced.
    assert.throws(
      () => mod.run({
        code: 'register_shutdown_function(function () {'
          + ' fwrite(STDERR, "SHUTDOWN-START\\n");'
          + ' for ($i = 0; $i < 200000; $i++) {}'
          + ' fwrite(STDERR, "SHUTDOWN-END\\n"); });'
          + TRAPPING_SCRIPT,
        interrupted: () => armed,
        // The markers end in a newline on purpose: the sink is fed a line at a
        // time, so an unterminated "SHUTDOWN-START" arrives at the very end
        // alongside everything else — and this test would then arm the poll
        // after the window it is about and pass against the defect.
        onOutput: (bytes) => {
          const text = dec.decode(bytes);
          seen += text;
          if (text.includes('SHUTDOWN-START')) armed = true;
        },
        collect: false,
      }),
      RangeError,
    );

    assert.match(seen, /SHUTDOWN-START/, 'the recovery ran the shutdown function');
    assert.match(seen, /SHUTDOWN-END/,
      'and it ran to the end — an armed poll would have raised a fatal inside it');
    assert.doesNotMatch(seen, /Interrupted/);

    const after = mod.run({ code: 'echo "alive";' });
    assert.equal(after.stdout, 'alive');
    assert.equal(after.exitCode, 0);
  });

  test('a trapped call does not leave its environment behind', async () => {
    const mod = await freshModule();

    assert.throws(
      () => mod.run({ code: TRAPPING_SCRIPT, env: { PHASM_TRAP: 'yes' } }),
      RangeError,
    );

    assert.equal(mod.run({ code: 'var_export(getenv("PHASM_TRAP"));' }).stdout, 'false');
  });

  // The one case where finishing the abandoned request is worse than refusing
  // to. A trap inside php_request_shutdown() — reachable, because that is where
  // register_shutdown_function() callbacks and __destruct() run — cannot be
  // recovered by running the shutdown again: it would re-run those callbacks
  // and destructors against a request that is already half torn down. So the
  // instance is declared spent, and every entry point says which it is instead
  // of failing somewhere less obvious.
  test("a trap inside PHP's own shutdown spends the instance, and says so", async () => {
    const mod = await freshModule();
    mod.run({ code: 'echo "warm";' });

    // The script itself finishes; the callback traps during shutdown.
    assert.throws(
      () => mod.run({ code: `register_shutdown_function(function () { ${TRAPPING_SCRIPT} }); echo "body";` }),
      RangeError,
    );

    assert.throws(() => mod.run({ code: 'echo "x";' }), /no longer usable/);
    assert.throws(() => mod.phasmHandleRequest({ url: '/x.php' }), /no longer usable/);
    assert.throws(() => mod.phasmRun(['-v']), /no longer usable/);
    // The fourth door, and the one that used to be left open: startup did not
    // go through the guard at all, so it ran module init on a dead instance
    // and answered as if nothing were wrong.
    assert.throws(() => mod.phasmStartup('memory_limit=64M'), /no longer usable/);
  });

  // 0 is not "no status" in this ABI: it is the DECLINE that tells an embedder
  // to serve the path as a static file. So a request abandoned by a trap used
  // to leave phasm_response_status() answering "not a script, serve it
  // yourself" for the script that had just failed — the source disclosure the
  // refusals were written to prevent, still open on the recovery path. The JS
  // API never saw it because phasmEnter() rethrows first; an embedder driving
  // the exports has nothing else to ask.
  test('a trapped request is a 500 to the exports, not a decline', async () => {
    const mod = await freshModule();
    mod.FS.mkdir('/trapsite');
    mod.FS.writeFile('/trapsite/boom.php', `<?php ${TRAPPING_SCRIPT}`);

    assert.throws(
      () => mod.phasmHandleRequest({ url: '/boom.php', docroot: '/trapsite' }),
      RangeError,
    );

    assert.equal(mod._phasm_response_status(), 500);
  });

  // And the other half of it: a command has no response, so recovery must not
  // invent a 500 for one. phasm_run() clears the accessors at its start —
  // deliberately, so that they never answer with the previous request's page —
  // and a trapped command has to leave them exactly as cleared.
  test('a trapped command invents no response of its own', async () => {
    const mod = await freshModule();
    mod.FS.mkdir('/quietsite');
    mod.FS.writeFile('/quietsite/i.php', '<?php http_response_code(201); echo "made";');
    mod.phasmHandleRequest({ url: '/i.php', docroot: '/quietsite' });
    assert.equal(mod._phasm_response_status(), 201);

    trap(mod);

    assert.equal(mod._phasm_response_status(), 0);
    assert.equal(mod._phasm_response_body_length(), 0);
  });

  // The instances above are fresh so that a regression names itself instead of
  // cascading. This one is the claim an embedder actually cares about: the
  // shared instance the rest of this suite runs on takes a trap and carries on.
  test('the instance the whole suite shares survives one', async () => {
    const mod = await sharedModule();

    trap(mod);

    assert.equal((await evalPhp('echo "suite still fine";')).stdout, 'suite still fine');
    assert.equal((await evalPhp('echo 1;')).stderr, '');
  });
});

// ─── the entry point itself ──────────────────────────────────────────────────

describe('phasmRun', opts, () => {
  test('is present on the module', async () => {
    const mod = await sharedModule();
    assert.equal(typeof mod.phasmRun, 'function');
    assert.equal(typeof mod.phasmStartup, 'function');
  });

  test('reports the CLI SAPI, which is what CLI tools test for', async () => {
    // composer.phar and phpunit.phar refuse to run unless PHP_SAPI is 'cli'.
    const r = await evalPhp('echo PHP_SAPI;');
    assert.equal(r.stdout, 'cli');
  });

  test('handles the CLI informational flags', async () => {
    assert.match((await php(['-v'])).stdout, /^PHP 8\.5\./);
    assert.match((await php(['-m'])).stdout, /\[PHP Modules\]/);
    assert.equal((await php(['-r', 'echo "direct";'])).stdout, 'direct');
  });

  test('argv reaches the script with argv[0] supplied', async () => {
    const r = await php(['/argv.php', 'one', 'two'], {
      files: { '/argv.php': '<?php echo $argc, ":", implode(",", array_slice($argv, 1));' },
    });
    assert.equal(r.stdout, '3:one,two');
  });

  test('a missing script is an error, not a crash', async () => {
    const r = await php(['/does-not-exist.php']);
    assert.notEqual(r.exitCode, 0);
    assert.equal((await evalPhp('echo "fine";')).stdout, 'fine');
  });

  // The packing is NUL-delimited, so a NUL inside an argument is not merely
  // unsupported — it truncates the argument at the NUL and PHP fails somewhere
  // else entirely. Refusing it keeps the failure at the call site.
  test('refuses an argument containing a NUL rather than truncating it', async () => {
    const mod = await sharedModule();
    assert.throws(() => mod.phasmRun(['-r', 'echo "a\0b";']), /NUL/);
    assert.throws(() => mod.phasmRun(['-r', 'echo 1;'], { env: { X: 'a\0b' } }), /NUL/);
    assert.equal((await evalPhp('echo "fine";')).stdout, 'fine', 'a refused call disturbed the next one');
  });

  // callMain() re-enters main(), which starts the module — on an instance that
  // already has one running that traps and takes every later phasmRun() with
  // it. The docs call the two entry points mutually exclusive; this is the
  // direction that used to be unenforced.
  test('refuses callMain() on an instance that has run phasmRun()', async () => {
    const mod = await sharedModule();
    await evalPhp('echo 1;');

    assert.throws(() => mod.callMain(['-r', 'echo "nope";']), /mutually exclusive/);
    assert.equal((await evalPhp('echo "still alive";')).stdout, 'still alive');
  });

  // And the other direction. The C side already declines, but it can only say
  // so as a status — and 255 is also what `php -l` returns for a parse error,
  // so a mistake this structural would look like an ordinary failure.
  test('refuses phasmRun() on an instance that has run callMain()', async () => {
    const { module: mod } = await php(['-r', 'echo "once";'], { fresh: true, viaCallMain: true });

    assert.throws(() => mod.phasmRun(['-r', 'echo 1;']), /mutually exclusive/);
    assert.throws(() => mod.phasmHandleRequest({ url: '/x.php' }), /mutually exclusive/);
    assert.throws(() => mod.phasmStartup('precision=3'), /mutually exclusive/);
  });
});
