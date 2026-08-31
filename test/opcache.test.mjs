// SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>
//
// SPDX-License-Identifier: ISC

// opcache — compiled scripts that outlive the compile.
//
// The reason this suite exists at all is that the extension was linked in,
// advertised in the README, reported by extension_loaded(), and had never once
// run: this SAPI answers to the name "cli" (it reuses cli_sapi_module), so
// opcache's own enable_cli gate removed it during startup, silently. Two ini
// defaults in sapi/phasm/phasm.c turn it on, and everything below is about
// what it does once it is.
//
// The shape it has to run in is not the usual one. There is no shared memory
// here — Emscripten defines none of HAVE_SHM_MMAP_ANON, HAVE_SHM_MMAP_POSIX or
// HAVE_SHM_IPC — so the file cache is not the fallback, it is the whole of it,
// and "prewarmed" means the cache directory was populated by an earlier
// instance and handed to this one. That is what a service worker booting a
// fresh module per page load needs, and it is why the seeded-cache test below
// is the one that matters most.
//
// Two of these tests assert that something does NOT get cached. They are the
// valuable ones: a cache that silently stops working looks exactly like a cache
// that is working, and both traps here are reachable from ordinary use.

import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { freshModule, haveBuild, NO_BUILD_MSG, mkdirp } from './helper.mjs';

const SKIP = haveBuild() ? false : NO_BUILD_MSG;
before((t) => { if (SKIP) t.diagnostic(SKIP); });
const opts = { skip: SKIP };

const CACHE = '/cache';

/**
 * A fresh instance with the file cache switched on.
 *
 * The directory has to exist before PHP starts: opcache stats it during module
 * startup and a miss is ACCEL_LOG_FATAL, which on this SAPI ends the module
 * rather than the request. So it is created here, not written by the run.
 *
 * `file_cache_only` is not a tuning choice — without a SHM backend the normal
 * path fails and disables the accelerator, and the automatic fallback to the
 * file cache is compiled in for Windows alone.
 */
async function bootCached(seed = [], extraIni = '') {
  const mod = await freshModule({ printErr() {} });
  mkdirp(mod.FS, CACHE);
  for (const [path, bytes] of seed) {
    mkdirp(mod.FS, path.slice(0, path.lastIndexOf('/')));
    mod.FS.writeFile(path, bytes);
  }
  const rc = mod.phasmStartup(
    `opcache.file_cache=${CACHE}\nopcache.file_cache_only=1\n${extraIni}`,
  );
  assert.equal(rc, 0, 'phasmStartup should accept the opcache settings');
  return mod;
}

/**
 * Write a script and back-date it a second, then run `code`.
 *
 * The back-dating is what makes these tests deterministic rather than slow:
 * file_update_protection is 1, so a file is cacheable from the second after it
 * was written, and touch() reaches that second without waiting for it. A test
 * that wrote and immediately ran would be asserting the opposite thing by
 * accident, which is exactly what the first draft of this file did.
 */
function runAged(mod, path, source, code) {
  mod.FS.writeFile(path, source);
  const res = mod.run({ args: ['-r', `touch(${JSON.stringify(path)}, time() - 1); ${code}`] });
  assert.equal(res.stderr, '', `unexpected stderr: ${res.stderr}`);
  return res;
}

/** Every file under `dir`, as [path, bytes] — the cache, ready to hand on. */
function collect(FS, dir, out = []) {
  for (const name of FS.readdir(dir)) {
    if (name === '.' || name === '..') continue;
    const path = dir === '/' ? `/${name}` : `${dir}/${name}`;
    if ((FS.stat(path).mode & 0o170000) === 0o040000) collect(FS, path, out);
    else out.push([path, FS.readFile(path)]);
  }
  return out;
}

describe('the ini defaults', () => {
  test('opcache is enabled for a SAPI that calls itself cli', opts, async () => {
    const mod = await freshModule();
    const { stdout } = mod.run({ code: 'echo ini_get("opcache.enable_cli");' });

    // Upstream's default is 0, and it is right for a process that compiles a
    // script, runs it once and exits. A phasm instance is booted once and asked
    // to run scripts for as long as the page lives, which is the case the
    // accelerator was written for; it inherits the name "cli" only so that
    // composer.phar and phpunit.phar agree to run.
    assert.equal(stdout, '1');
  });

  test('a file is cacheable a second after it is written', opts, async () => {
    const mod = await freshModule();
    const { stdout } = mod.run({ code: 'echo ini_get("opcache.file_update_protection");' });

    // Upstream's 2 seconds is most of an instance's life, and "write a file,
    // then run it" is the shape of every call phasm gets, so at 2 the cache
    // never fills. One rather than zero, because the same setting is what keeps
    // timestamp validation sound: see the staleness test below, which fails at
    // zero and is the reason this is not simply switched off.
    assert.equal(stdout, '1');
  });
});

describe('there is no shared memory', () => {
  test('without a file cache the accelerator does not run', opts, async () => {
    const mod = await freshModule({ printErr() {} });
    const { stdout } = mod.run({ code: 'var_dump(opcache_get_status(false));' });

    // Pinned as an absence, like the DWARF and extension-list assertions: if a
    // future emsdk grows a working SHM backend this fails, and it should — the
    // reasoning in phasm.c, the mandatory file_cache_only, and everything this
    // file says about prewarming all assume the answer is no.
    assert.equal(stdout.trim(), 'bool(false)');
  });

  test('and says nothing about it', opts, async () => {
    // The message opcache logs when it gives up is ACCEL_LOG_INFO, above the
    // default log_verbosity_level. It has to stay there: `php -v` at a shell
    // prompt printing "No available SHM backend" would be a regression in the
    // terminal, not a diagnostic.
    let noise = '';
    const mod = await freshModule({ printErr: (t) => { noise += t; } });
    const { stderr } = mod.run({ code: 'echo 1;' });

    assert.equal(noise, '');
    assert.equal(stderr, '');
  });
});

describe('the file cache', () => {
  test('reports itself once a directory is named', opts, async () => {
    const mod = await bootCached();
    const { stdout } = mod.run({
      code: `$s = opcache_get_status(false);
             echo $s['file_cache'], " ", var_export($s['file_cache_only'], true);`,
    });

    assert.equal(stdout, `${CACHE} true`);
  });

  test('a script a second old is cached', opts, async () => {
    const mod = await bootCached();
    mkdirp(mod.FS, '/app');
    const { stdout } = runAged(
      mod,
      '/app/a.php',
      '<?php class A { function f() { return 1; } }\n',
      'require "/app/a.php"; echo (new A)->f();',
    );
    assert.equal(stdout, '1');

    // The regression this file exists for. Under upstream's defaults this array
    // is empty — enable_cli=0 removes the accelerator outright, and even with it
    // on, file_update_protection=2 declines a file this new. Both times the run
    // still succeeds, which is what makes the absence so quiet.
    const cached = collect(mod.FS, CACHE);
    assert.equal(cached.length, 1);
    assert.match(cached[0][0], /^\/cache\/[0-9a-f]{32}\/app\/a\.php\.bin$/);
  });

  test('the cache is keyed by build, not by run', opts, async () => {
    // Two instances of one build agree on the directory name, which is the
    // whole reason a cache can be carried between them. It is zend_system_id,
    // so a rebuilt php.wasm invalidates every entry — a bundled cache has to
    // be generated by the build that ships with it.
    const first = await bootCached();
    runAged(first, '/x.php', '<?php $x = 1;\n', 'require "/x.php";');

    const second = await bootCached();
    runAged(second, '/x.php', '<?php $x = 1;\n', 'require "/x.php";');

    assert.deepEqual(
      collect(first.FS, CACHE).map(([p]) => p),
      collect(second.FS, CACHE).map(([p]) => p),
    );
  });
});

describe('a prewarmed instance', () => {
  test('runs a script it never compiled', opts, async () => {
    // The claim behind "prewarmed", proved by making the cache and the source
    // disagree: whichever one answers, says which one was used.
    const warm = await bootCached();
    runAged(warm, '/p.php', '<?php function p() { return "cached"; }\n', 'require "/p.php";');

    const cache = collect(warm.FS, CACHE);
    assert.equal(cache.length, 1, 'the first instance should have cached the script');
    const mtime = Math.floor(warm.FS.stat('/p.php').mtime.getTime() / 1000);

    const cold = await bootCached(cache);
    // Same path, same length, same mtime — a different body. opcache validates
    // by timestamp, so it has no reason to look at the bytes, and it does not.
    cold.FS.writeFile('/p.php', '<?php function p() { return "SOURCE"; }\n');
    cold.run({ args: ['-r', `touch("/p.php", ${mtime});`] });

    const { stdout, stderr } = cold.run({ args: ['-r', 'require "/p.php"; echo p();'] });
    assert.equal(stderr, '');
    assert.equal(stdout, 'cached');
  });

  test('recompiles a script whose source moved on', opts, async () => {
    // The other half of the same mechanism, and the one that keeps "edit a
    // file, reload the frame, see the change" working: an entry whose source
    // has a newer timestamp is not used.
    const warm = await bootCached();
    runAged(warm, '/q.php', '<?php function q() { return "stale"; }\n', 'require "/q.php";');

    const cold = await bootCached(collect(warm.FS, CACHE));
    cold.FS.writeFile('/q.php', '<?php function q() { return "fresh"; }\n');

    const { stdout } = cold.run({ args: ['-r', 'require "/q.php"; echo q();'] });
    assert.equal(stdout, 'fresh');
  });
});

describe('two edits in one second', () => {
  test('the first is not cached, so the second is not shadowed', opts, async () => {
    // mtime has one-second granularity, so an entry stored with the timestamp
    // of a file that is still inside that second can be shadowed by the next
    // write: same mtime, different bytes, cache wins, forever. This is what
    // file_update_protection=1 rules out — an entry is only stored once its
    // source is a full second old, so any later write is in a later second.
    //
    // The assertion is on the mechanism rather than on the timing, because the
    // mechanism is what holds regardless of where the test lands in a second:
    // a file this new is not cacheable at all.
    const mod = await bootCached();
    mod.FS.writeFile('/r.php', '<?php function r() { return "one"; }\n');
    mod.run({ args: ['-r', 'require "/r.php";'] });

    assert.deepEqual(collect(mod.FS, CACHE), [], 'a file written just now must not be cached');

    mod.FS.writeFile('/r.php', '<?php function r() { return "two"; }\n');
    const { stdout } = mod.run({ args: ['-r', 'require "/r.php"; echo r();'] });
    assert.equal(stdout, 'two');
  });
});

describe('a store with no timestamps', () => {
  test('caches nothing at all', opts, async () => {
    // wasi-sh's VFS writes 0 for atim/mtim/ctim, and opcache refuses to cache a
    // file whose timestamp it cannot obtain — it reads 0 as "possibly a socket"
    // and compiles it the ordinary way, every time, for ever.
    //
    // This is the timestamp gap the store contract closes, met from the
    // caching side rather than the invalidation side: even with validation
    // switched off entirely a mtime-less store would be caching entries that
    // can never be invalidated, so the answer is real timestamps in the store
    // rather than a setting here.
    const mod = await bootCached();
    mod.FS.writeFile('/z.php', '<?php function z() { return 1; }\n');

    const { stdout } = mod.run({ args: ['-r', 'touch("/z.php", 0); require "/z.php"; echo z();'] });
    assert.equal(stdout, '1', 'the script still runs — that is what makes this quiet');
    assert.deepEqual(collect(mod.FS, CACHE), []);
  });
});
