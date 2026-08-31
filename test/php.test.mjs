// SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>
//
// SPDX-License-Identifier: ISC

// The safety net. Before this suite existed there were zero tests, and
// release.yml published to npm with no verification whatsoever — so a
// dependency bump or a configure-flag change could ship a broken interpreter
// and nothing would notice.
//
// These are deliberately about the BUILD, not about PHP: does the interpreter
// we just produced actually run, is every extension we claim to ship really
// linked in, does the filesystem round-trip, does a failure look like a
// failure. Anything that a version bump could plausibly break.

import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { php, evalPhp, haveBuild, NO_BUILD_MSG, DIST } from './helper.mjs';

const SKIP = !haveBuild();
before((t) => { if (SKIP) t.diagnostic(NO_BUILD_MSG); });
const opts = { skip: SKIP ? NO_BUILD_MSG : false };

// ─── the interpreter runs at all ─────────────────────────────────────────────

describe('interpreter', opts, () => {
  test('reports the PHP version this repo claims to build', async () => {
    const r = await evalPhp('echo PHP_VERSION;');
    assert.match(r.stdout, /^8\.5\./, `expected PHP 8.5.x, got ${JSON.stringify(r.stdout)}`);
  });

  test('runs a snippet with -r', async () => {
    const r = await evalPhp('echo 6 * 7;');
    assert.equal(r.stdout, '42');
    assert.equal(r.exitCode, 0);
  });

  test('runs a script from the virtual filesystem', async () => {
    const r = await php(['/app.php'], { files: { '/app.php': '<?php echo "from a file";' } });
    assert.equal(r.stdout, 'from a file');
  });

  test('is a 32-bit build (wasm32): PHP_INT_SIZE is 4', async () => {
    const r = await evalPhp('echo PHP_INT_SIZE;');
    assert.equal(r.stdout, '4', 'a change here means the target changed under us');
  });
});

// ─── extensions: the README makes promises, this keeps them ──────────────────

// Every name the README's "Included Extensions" list advertises. A configure
// flag silently failing to take effect is exactly the kind of regression a
// dependency bump causes, and it is invisible without an assertion.
const ADVERTISED = [
  'calendar', 'ctype', 'fileinfo', 'filter', 'iconv', 'mbstring',
  'pcntl', 'PDO', 'pdo_sqlite', 'sqlite3', 'tokenizer', 'zip',
];

describe('extensions', opts, () => {
  test('every extension the README advertises is loaded', async () => {
    const r = await evalPhp('echo implode(",", get_loaded_extensions());');
    const loaded = new Set(r.stdout.split(',').map((s) => s.toLowerCase()));
    const missing = ADVERTISED.filter((e) => !loaded.has(e.toLowerCase()));
    assert.deepEqual(missing, [], `README advertises these but they are not loaded: ${missing.join(', ')}`);
  });

  // Loaded is not the same as working: a library bump can link fine and still
  // misbehave, so exercise one real call per C-library-backed extension.
  // gmp is deliberately absent: it was requested as --enable-gmp, which PHP's
  // configure does not recognise (it is --with-gmp) and only warns about, so it
  // never built. Pin that it is still absent, so if someone adds libgmp to
  // deps.sh they are prompted to update the README in the same change.
  test('gmp is NOT built (it needs --with-gmp plus a cross-built libgmp)', async () => {
    const r = await evalPhp('echo function_exists("gmp_init") ? "present" : "absent";');
    assert.equal(r.stdout, 'absent');
  });

  test('mbstring handles multibyte (oniguruma linked correctly)', async () => {
    const r = await evalPhp('echo mb_strlen("日本語"), ":", mb_substr("日本語", 1, 1), ":", mb_strtoupper("áé");');
    assert.equal(r.stdout, '3:本:ÁÉ');
  });

  test('iconv transcodes', async () => {
    const r = await evalPhp('echo bin2hex(iconv("UTF-8", "ISO-8859-1", "é"));');
    assert.equal(r.stdout, 'e9');
  });

  test('sqlite3 creates, writes and reads a database', async () => {
    const r = await evalPhp(
      '$d = new SQLite3(":memory:");'
      + '$d->exec("CREATE TABLE t (a INTEGER, b TEXT)");'
      + '$d->exec("INSERT INTO t VALUES (1, \'one\'), (2, \'two\')");'
      + '$q = $d->query("SELECT b FROM t WHERE a = 2");'
      + 'echo $q->fetchArray()[0], ":", SQLite3::version()["versionString"];'
    );
    assert.match(r.stdout, /^two:\d+\.\d+/);
  });

  test('pdo_sqlite round-trips through the PDO layer', async () => {
    const r = await evalPhp(
      '$p = new PDO("sqlite::memory:");'
      + '$p->exec("CREATE TABLE t (a TEXT)");'
      + '$p->exec("INSERT INTO t VALUES (\'via-pdo\')");'
      + 'echo $p->query("SELECT a FROM t")->fetchColumn();'
    );
    assert.equal(r.stdout, 'via-pdo');
  });

  test('zip writes and reads an archive (libzip + zlib linked correctly)', async () => {
    const r = await evalPhp(
      '$z = new ZipArchive();'
      + '$z->open("/t.zip", ZipArchive::CREATE);'
      + '$z->addFromString("inner.txt", str_repeat("compress me ", 100));'
      + '$z->close();'
      + '$o = new ZipArchive(); $o->open("/t.zip");'
      + 'echo $o->numFiles, ":", strlen($o->getFromName("inner.txt")), ":", filesize("/t.zip") < 1200 ? "compressed" : "raw";'
    );
    assert.equal(r.stdout, '1:1200:compressed');
  });

  test('fileinfo identifies content', async () => {
    const r = await evalPhp('echo (new finfo(FILEINFO_MIME_TYPE))->buffer("<?xml version=\\"1.0\\"?><a/>");');
    assert.match(r.stdout, /xml|text/);
  });

  test('tokenizer parses PHP source', async () => {
    const r = await evalPhp('echo count(token_get_all("<?php echo 1;")) > 3 ? "ok" : "short";');
    assert.equal(r.stdout, 'ok');
  });

  test('calendar, ctype and filter answer correctly', async () => {
    const r = await evalPhp(
      'echo cal_days_in_month(CAL_GREGORIAN, 2, 2024), ":",'
      + 'var_export(ctype_digit("12345"), true), ":",'
      + 'var_export(filter_var("a@b.co", FILTER_VALIDATE_EMAIL), true);'
    );
    assert.equal(r.stdout, "29:true:'a@b.co'");
  });
});

// ─── the virtual filesystem ──────────────────────────────────────────────────

describe('filesystem', opts, () => {
  test('PHP reads a file written from JS', async () => {
    const r = await php(['/r.php'], {
      files: { '/r.php': '<?php echo trim(file_get_contents("/data.txt"));', '/data.txt': 'hello from js\n' },
    });
    assert.equal(r.stdout, 'hello from js');
  });

  test('a file PHP writes is visible to JS afterwards', async () => {
    const r = await evalPhp('file_put_contents("/out.txt", "written by php");');
    assert.equal(r.FS.readFile('/out.txt', { encoding: 'utf8' }), 'written by php');
  });

  test('directories, globbing and unlink work', async () => {
    const r = await evalPhp(
      'mkdir("/d"); file_put_contents("/d/a.txt", "a"); file_put_contents("/d/b.txt", "b");'
      + '$g = glob("/d/*.txt"); sort($g); echo implode(",", $g);'
      + 'unlink("/d/a.txt"); echo ":", file_exists("/d/a.txt") ? "still" : "gone";'
    );
    assert.equal(r.stdout, '/d/a.txt,/d/b.txt:gone');
  });

  test('binary content survives a round trip unmangled', async () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255, 10, 13]);
    const r = await php(['/b.php'], {
      files: { '/b.php': '<?php echo bin2hex(file_get_contents("/bin.dat"));', '/bin.dat': bytes },
    });
    assert.equal(r.stdout, '000102fdfeff0a0d');
  });
});

// ─── stdin, stdout, stderr, exit codes ───────────────────────────────────────

describe('io and exit codes', opts, () => {
  test('reads stdin to EOF', async () => {
    const r = await php(['/i.php'], {
      files: { '/i.php': '<?php echo strtoupper(trim(stream_get_contents(STDIN)));' },
      stdin: 'piped input\n',
    });
    assert.equal(r.stdout, 'PIPED INPUT');
  });

  test('stderr is separate from stdout', async () => {
    const r = await evalPhp('fwrite(STDOUT, "to-out"); fwrite(STDERR, "to-err");');
    assert.equal(r.stdout, 'to-out');
    assert.equal(r.stderr, 'to-err');
  });

  test('exit(N) propagates as the exit code', async () => {
    assert.equal((await evalPhp('exit(0);')).exitCode, 0);
    assert.equal((await evalPhp('exit(3);')).exitCode, 3);
    assert.equal((await evalPhp('exit(42);')).exitCode, 42);
  });

  // A fatal must be loud. If it ever starts exiting 0, CI would go green on a
  // build that cannot run PHP.
  test('a fatal error goes to stderr and exits non-zero', async () => {
    const r = await php(['/f.php'], { files: { '/f.php': '<?php no_such_function_at_all();' } });
    assert.notEqual(r.exitCode, 0, 'a fatal error must not exit 0');
    assert.match(r.stdout + r.stderr, /Error|no_such_function_at_all/);
  });

  test('a parse error is reported, not silently ignored', async () => {
    const r = await php(['/p.php'], { files: { '/p.php': '<?php this is not php ((( ;' } });
    assert.notEqual(r.exitCode, 0);
    assert.match(r.stdout + r.stderr, /Parse error|syntax error/i);
  });

  test('argv reaches the script', async () => {
    const r = await php(['/a.php', 'one', 'two'], {
      files: { '/a.php': '<?php echo $argc, ":", implode(",", array_slice($argv, 1));' },
    });
    assert.equal(r.stdout, '3:one,two');
  });
});

// ─── what the artifact carries ───────────────────────────────────────────────

/** Wasm section id 0. Its payload begins with the section's name. */
const CUSTOM = 0;
/** Wasm section id 10, the function bodies — proof a walk reached real content. */
const CODE = 10;

/**
 * Walk a wasm module's top-level sections: `{id, name, size}` each.
 *
 * Everything optional in a wasm binary is a custom section — DWARF, the
 * function name table, the producers record — so this answers "what is in here
 * that is not code" directly rather than by watching a byte count. A module is
 * an 8-byte header followed by sections of `id, length, payload`, with lengths
 * LEB128-encoded, and a custom section carries a length-prefixed name at the
 * front of its payload.
 */
function wasmSections(bytes) {
  let at = 8; // magic + version
  const found = [];

  const leb = () => {
    let result = 0;
    let shift = 0;
    let byte;
    do {
      byte = bytes[at++];
      result |= (byte & 0x7f) << shift;
      shift += 7;
    } while (byte & 0x80);
    return result;
  };

  while (at < bytes.length) {
    const id = bytes[at++];
    const size = leb();
    const payloadAt = at;
    let name = '';
    if (id === CUSTOM) {
      const nameLength = leb();
      name = new TextDecoder().decode(bytes.subarray(at, at + nameLength));
    }
    found.push({ id, name, size });
    at = payloadAt + size;
    assert.ok(at <= bytes.length, `section ${id} claims ${size} bytes and runs past the end`);
  }

  return found;
}

describe('the shipped wasm', opts, () => {
  // Two thirds of this file used to be DWARF, because PHP's configure puts `-g`
  // in CFLAGS and nothing took it back out — 35.3 MB shipped where 11.9 MB is
  // the code, and emcc skipping its post-link optimizations on top of that. It
  // is one flag away from coming back, and it is invisible when it does: the
  // build works perfectly, it is just three times the download. Asserted as an
  // absence rather than a size ceiling, because the extension work will move any
  // ceiling and nobody will be sure which of the two moved it.
  test('carries no debug info', () => {
    const sections = wasmSections(readFileSync(join(DIST, 'php.wasm')));

    // A negative assertion needs proof the walk got somewhere: an empty parse
    // has no DWARF in it either.
    assert.ok(
      sections.some((s) => s.id === CODE && s.size > 1_000_000),
      `no code section found among ${sections.length} — the walk, not the wasm, is wrong`,
    );

    const debug = sections.filter((s) => s.name.startsWith('.debug'));
    assert.deepEqual(
      debug.map((s) => `${s.name} (${s.size} bytes)`),
      [],
      'something dropped -g0 from the link (scripts/env.sh)',
    );
  });
});

// ─── things the demo and downstream consumers depend on ──────────────────────

describe('integration surface', opts, () => {
  // web/assets/main.php does exactly this, and it is what the published demo
  // exercises: extract a zip, then autoload out of it.
  test('composer autoloader can be extracted from a zip and required', async () => {
    const r = await evalPhp(
      '$z = new ZipArchive();'
      + '$z->open("/v.zip", ZipArchive::CREATE);'
      + '$z->addFromString("vendor/autoload.php", "<?php return \'autoloaded\';");'
      + '$z->close();'
      + '$o = new ZipArchive(); $o->open("/v.zip"); $o->extractTo("/x/"); $o->close();'
      + 'echo require "/x/vendor/autoload.php";'
    );
    assert.equal(r.stdout, 'autoloaded');
  });

  test('json, hash, pcre and date are present as always-on core', async () => {
    const r = await evalPhp(
      'echo json_encode(["a" => 1]), ":",'
      + 'hash("sha256", ""), ":",'
      + 'preg_replace("/o/", "0", "foo"), ":",'
      + 'date("Y", 0);'
    );
    assert.equal(
      r.stdout,
      '{"a":1}:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855:f00:1970'
    );
  });
});
