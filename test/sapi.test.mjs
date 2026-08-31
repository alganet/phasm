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
import { php, evalPhp, sharedModule, haveBuild, NO_BUILD_MSG } from './helper.mjs';

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
});
