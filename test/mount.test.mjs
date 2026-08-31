// SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>
//
// SPDX-License-Identifier: ISC

// mountStore() — PHP running off a filesystem it does not own.
//
// The store here is a plain object carrying the twelve methods of the `fs`
// contract and nothing else, so every test goes through the wrapper an
// embedder's store goes through — a ZenFS filesystem passed straight in takes
// a shorter path, and gets its own test. What backs the object is a real
// implementation rather than a toy written for this file: a store that is
// subtly wrong makes the mount look wrong, which is the one failure mode this
// suite must not have.
//
// What is being asserted throughout is a single claim: the bytes are the
// store's. Not copied in at mount time, not flushed out at the end — read and
// written where they live, so a second guest holding the same store sees every
// change the moment PHP makes it, and the other way round.

import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { freshModule, haveBuild, NO_BUILD_MSG } from './helper.mjs';
import { mountStore } from '../src/mount.mjs';

let core;
try {
  core = await import('@zenfs/core');
  await import('@zenfs/emscripten/plugin.js');
} catch {
  core = null;
}

const NO_ZENFS =
  '@zenfs/core and @zenfs/emscripten are optional peers — npm install to run the mount suite.';

const SKIP = !haveBuild() ? NO_BUILD_MSG : !core ? NO_ZENFS : false;
before((t) => { if (SKIP) t.diagnostic(SKIP); });
const opts = { skip: SKIP };

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * A store in the shape of wasi-sh's `fs` contract: twelve synchronous,
 * path-addressed methods and no inheritance, exactly as a shell hands one
 * over. Delegating to ZenFS's own in-memory filesystem keeps the semantics
 * honest while keeping the object structurally foreign.
 */
function contractStore(files = {}) {
  const fs = core.InMemory.create({ label: 'contract-store' });

  const store = {
    statSync: (p) => fs.statSync(p),
    readdirSync: (p) => fs.readdirSync(p),
    createFileSync: (p, o) => fs.createFileSync(p, o),
    mkdirSync: (p, o) => fs.mkdirSync(p, o),
    rmdirSync: (p) => fs.rmdirSync(p),
    unlinkSync: (p) => fs.unlinkSync(p),
    renameSync: (a, b) => fs.renameSync(a, b),
    linkSync: (a, b) => fs.linkSync(a, b),
    readSync: (p, b, s, e) => fs.readSync(p, b, s, e),
    writeSync: (p, b, o) => fs.writeSync(p, b, o),
    touchSync: (p, m) => fs.touchSync(p, m),
    syncSync: () => fs.syncSync(),
  };

  for (const [path, content] of Object.entries(files)) write(store, path, content);
  return store;
}

/** Write through the contract, as the other guest would. */
function write(store, path, content) {
  const bytes = typeof content === 'string' ? enc.encode(content) : content;
  const parts = path.split('/').slice(1, -1);
  let dir = '';
  for (const part of parts) {
    dir += `/${part}`;
    try { store.mkdirSync(dir, { mode: 0o40777, uid: 0, gid: 0 }); } catch { /* there already */ }
  }
  try { store.createFileSync(path, { mode: 0o100666, uid: 0, gid: 0 }); } catch { /* there already */ }
  store.touchSync(path, { size: 0 });
  store.writeSync(path, bytes, 0);
  store.touchSync(path, { size: bytes.length });
}

/** Read through the contract. */
function read(store, path) {
  const { size } = store.statSync(path);
  const bytes = new Uint8Array(size);
  store.readSync(path, bytes, 0, size);
  return dec.decode(bytes);
}

/** A module with `store` mounted at `path`, both fresh. */
async function mounted(path, files, options) {
  const store = contractStore(files);
  const php = await freshModule();
  const mount = await mountStore(php, store, { path, ...options });
  return { php, store, mount };
}

describe('mountStore', opts, () => {
  test('PHP reads what the store already holds', async () => {
    const { php } = await mounted('/app', { '/app/index.php': '<?php echo "seeded";' });

    assert.equal(php.run({ args: ['/app/index.php'] }).stdout, 'seeded');
  });

  test('a file PHP creates is a file in the store', async () => {
    const { php, store } = await mounted('/app', { '/app/keep': 'x' });

    const { exitCode } = php.run({ code: 'file_put_contents("/app/made.txt", "by php");' });

    assert.equal(exitCode, 0);
    assert.equal(read(store, '/app/made.txt'), 'by php');
  });

  test('a file the other guest writes is a file PHP opens', async () => {
    const { php, store } = await mounted('/app', { '/app/keep': 'x' });

    write(store, '/app/from-the-shell.txt', 'written outside');

    assert.equal(
      php.run({ code: 'echo file_get_contents("/app/from-the-shell.txt");' }).stdout,
      'written outside',
    );
  });

  test('an edit made outside is the code PHP runs next', async () => {
    // The whole point of the exercise: edit a file in the shell, reload the
    // page, see the change. opcache with validate_timestamps never invalidates
    // a script whose mtime does not move, and it fails looking like a caching
    // bug somewhere else entirely.
    const { php, store } = await mounted('/app', { '/app/page.php': '<?php echo "first";' });
    assert.equal(php.run({ args: ['/app/page.php'] }).stdout, 'first');

    write(store, '/app/page.php', '<?php echo "second";');

    assert.equal(php.run({ args: ['/app/page.php'] }).stdout, 'second');
  });

  test('a shorter file does not leave the old tail behind', async () => {
    const { php, store } = await mounted('/app', { '/app/page.php': '<?php echo "a long first answer";' });
    php.run({ args: ['/app/page.php'] });

    write(store, '/app/page.php', '<?php echo "short";');

    assert.equal(php.run({ args: ['/app/page.php'] }).stdout, 'short');
  });

  test('include, mkdir, rename, unlink and readdir', async () => {
    const { php, store } = await mounted('/app', {
      '/app/lib/greet.php': '<?php function greet($n) { return "hello $n"; }',
      '/app/old.txt': 'move me',
    });

    const { stdout, stderr, exitCode } = php.run({ code: `
      require '/app/lib/greet.php';
      echo greet('world'), "\\n";
      mkdir('/app/sub/deep', 0777, true);
      echo is_dir('/app/sub/deep') ? "made\\n" : "NOT MADE\\n";
      rename('/app/old.txt', '/app/new.txt');
      echo file_exists('/app/new.txt') && !file_exists('/app/old.txt') ? "moved\\n" : "NOT MOVED\\n";
      file_put_contents('/app/gone.txt', 'x');
      unlink('/app/gone.txt');
      echo file_exists('/app/gone.txt') ? "STILL THERE\\n" : "removed\\n";
      $names = array_diff(scandir('/app'), ['.', '..']);
      sort($names);
      echo implode(',', $names), "\\n";
    ` });

    assert.equal(stderr, '');
    assert.equal(exitCode, 0);
    assert.equal(stdout, [
      'hello world', 'made', 'moved', 'removed', 'lib,new.txt,sub', '',
    ].join('\n'));
    assert.deepEqual(store.readdirSync('/app').sort(), ['lib', 'new.txt', 'sub']);
  });

  test('offsets are per open description, and seeking is not a scan', async () => {
    // phar seeking a 10 MB archive is why offsets are arguments rather than
    // state, and two handles on one file are why the offset cannot live with
    // the path.
    const { php } = await mounted('/app', {});

    const { stdout, stderr } = php.run({ code: `
      $f = fopen('/app/big.bin', 'wb');
      fwrite($f, str_repeat('A', 600000));
      fclose($f);
      $f = fopen('/app/big.bin', 'r+b');
      fseek($f, 500000);
      fwrite($f, 'NEEDLE');
      fclose($f);
      $f = fopen('/app/big.bin', 'rb');
      fseek($f, 500000);
      echo fread($f, 6), ' @ ', ftell($f), "\\n";
      fclose($f);

      $a = fopen('/app/big.bin', 'rb');
      $b = fopen('/app/big.bin', 'rb');
      fread($a, 10);
      echo 'a@', ftell($a), ' b@', ftell($b), "\\n";
    ` });

    assert.equal(stderr, '');
    assert.equal(stdout, 'NEEDLE @ 500006\na@10 b@0\n');
  });

  test('truncate discards, and w+ reads back what it just wrote', async () => {
    const { php, store } = await mounted('/app', { '/app/log.txt': 'line one\n' });

    const { stdout, stderr } = php.run({ code: `
      $f = fopen('/app/rw.txt', 'w+');
      fwrite($f, 'abcdef');
      fseek($f, 2);
      echo fread($f, 2), "\\n";
      fclose($f);
      $f = fopen('/app/log.txt', 'r+');
      ftruncate($f, 4);
      fclose($f);
      clearstatcache();
      echo filesize('/app/log.txt'), ':', file_get_contents('/app/log.txt'), "\\n";
      file_put_contents('/app/log.txt', 'appended', FILE_APPEND);
      echo file_get_contents('/app/log.txt'), "\\n";
    ` });

    assert.equal(stderr, '');
    assert.equal(stdout, 'cd\n4:line\nlineappended\n');
    assert.equal(read(store, '/app/log.txt'), 'lineappended');
  });

  test('timestamps are real and inodes are unique', async () => {
    // A constant inode makes every directory look infinitely recursive to
    // anything detecting loops by dev:ino, which is how busybox find and
    // cp -r do it.
    const { php } = await mounted('/app', { '/app/lib/a.php': '<?php', '/app/b.txt': 'b' });

    const { stdout } = php.run({ code: `
      clearstatcache();
      $a = stat('/app/lib');
      $b = stat('/app/b.txt');
      echo $a['ino'] === $b['ino'] ? "COLLIDE\\n" : "unique\\n";
      echo filemtime('/app/b.txt') > 0 ? "real\\n" : "ZERO\\n";
    ` });

    assert.equal(stdout, 'unique\nreal\n');
  });

  test('SQLite survives a write, a close and a reopen', async () => {
    const { php, store } = await mounted('/app', {});

    const { stdout, stderr } = php.run({ code: `
      $db = new PDO('sqlite:/app/test.db', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
      $db->exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
      $db->exec("INSERT INTO t (v) VALUES ('persisted')");
      $db = null;
      $again = new PDO('sqlite:/app/test.db');
      echo $again->query('SELECT v FROM t')->fetch(PDO::FETCH_ASSOC)['v'];
    ` });

    assert.equal(stderr, '');
    assert.equal(stdout, 'persisted');
    assert.ok(store.statSync('/app/test.db').size > 0, 'the database file is in the store');
  });

  test('a missing file fails like a missing file, and the module lives', async () => {
    const { php } = await mounted('/app', { '/app/there.txt': 'x' });

    const { stdout } = php.run({ code: `
      var_dump(@fopen('/app/nope.txt', 'r'));
      var_dump(@unlink('/app/nope.txt'));
      mkdir('/app/full');
      file_put_contents('/app/full/x', 'x');
      var_dump(@rmdir('/app/full'));
    ` });

    assert.equal(stdout, 'bool(false)\nbool(false)\nbool(false)\n');
    assert.equal(php.run({ code: 'echo 6 * 7;' }).stdout, '42');
  });

  test('only the mountpoint is the store; the rest stays MEMFS', async () => {
    const { php, store } = await mounted('/app', {});

    php.run({ code: 'file_put_contents("/tmp/scratch", "memfs");' });

    assert.equal(php.run({ code: 'echo file_get_contents("/tmp/scratch");' }).stdout, 'memfs');
    assert.throws(() => store.statSync('/tmp/scratch'));
  });

  test('two stores mount side by side and stay apart', async () => {
    const php = await freshModule();
    const app = contractStore({ '/app/who.php': '<?php echo "app";' });
    const lib = contractStore({ '/lib/who.php': '<?php echo "lib";' });

    await mountStore(php, app, { path: '/app' });
    await mountStore(php, lib, { path: '/lib' });

    assert.equal(php.run({ args: ['/app/who.php'] }).stdout, 'app');
    assert.equal(php.run({ args: ['/lib/who.php'] }).stdout, 'lib');
    php.run({ code: 'file_put_contents("/app/only-here", "x");' });
    assert.throws(() => lib.statSync('/lib/only-here'));
  });

  test('root maps a different directory of the store', async () => {
    const store = contractStore({ '/projects/site/index.php': '<?php echo "deep";' });
    const php = await freshModule();

    await mountStore(php, store, { path: '/app', root: '/projects/site' });

    assert.equal(php.run({ args: ['/app/index.php'] }).stdout, 'deep');
    php.run({ code: 'file_put_contents("/app/added", "x");' });
    assert.equal(read(store, '/projects/site/added'), 'x');
  });

  test('a ZenFS filesystem needs no wrapper', async () => {
    const php = await freshModule();
    const fs = core.InMemory.create({ label: 'direct' });
    fs.mkdirSync('/app', { mode: 0o40777, uid: 0, gid: 0 });

    await mountStore(php, fs, { path: '/app' });

    php.run({ code: 'file_put_contents("/app/x.txt", "direct");' });
    const { size } = fs.statSync('/app/x.txt');
    const bytes = new Uint8Array(size);
    fs.readSync('/app/x.txt', bytes, 0, size);
    assert.equal(dec.decode(bytes), 'direct');
  });

  test('the mountpoint is created, and a store root can be too', async () => {
    const store = contractStore({});
    const php = await freshModule();

    await mountStore(php, store, { path: '/fresh' });

    php.run({ code: 'file_put_contents("/fresh/x", "made");' });
    assert.equal(read(store, '/fresh/x'), 'made');
  });

  test('create: false refuses a store root that is not there', async () => {
    const store = contractStore({});
    const php = await freshModule();

    await assert.rejects(() => mountStore(php, store, { path: '/absent', create: false }));
    // The failed mount leaves nothing behind for the next one to trip over.
    await mountStore(php, store, { path: '/absent' });
    assert.equal(php.run({ code: 'echo is_dir("/absent") ? "ok" : "no";' }).stdout, 'ok');
  });

  test('mounting works on an instance that has already run PHP', async () => {
    const php = await freshModule();
    assert.equal(php.run({ code: 'echo "warm";' }).stdout, 'warm');

    await mountStore(php, contractStore({ '/late/x.php': '<?php echo "late";' }), { path: '/late' });

    assert.equal(php.run({ args: ['/late/x.php'] }).stdout, 'late');
  });

  test('unmount takes the store back out', async () => {
    const { php, mount, store } = await mounted('/app', { '/app/x.txt': 'x' });

    mount.unmount();

    const { stdout } = php.run({ code: 'echo is_dir("/app") ? "dir" : "gone", ",", file_exists("/app/x.txt") ? "STILL THERE" : "unmounted";' });
    assert.equal(stdout, 'dir,unmounted');
    assert.equal(read(store, '/app/x.txt'), 'x', 'the store keeps its files');
    // Emscripten answers a second unmount with a bare EINVAL, which reads like
    // a bug in the mount rather than in the caller.
    assert.throws(() => mount.unmount(), /already unmounted/);
  });

  test('a store can be mounted again after being unmounted', async () => {
    const { php, mount, store } = await mounted('/app', { '/app/x.txt': 'first' });
    mount.unmount();

    await mountStore(php, store, { path: '/app' });

    assert.equal(php.run({ code: 'echo file_get_contents("/app/x.txt");' }).stdout, 'first');
  });

  test('a mount nobody can agree on is refused', async () => {
    const php = await freshModule();
    const store = contractStore({});

    await assert.rejects(() => mountStore(php, store, { path: '/' }), TypeError);
    await assert.rejects(() => mountStore(php, store, { path: 'app' }), TypeError);
    await assert.rejects(() => mountStore(php, store, {}), TypeError);
    await assert.rejects(() => mountStore(php, {}, { path: '/app' }), TypeError);
    await assert.rejects(() => mountStore(null, store, { path: '/app' }), TypeError);
  });
});
