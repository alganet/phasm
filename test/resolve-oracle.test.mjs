// SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>
//
// SPDX-License-Identifier: ISC

// The differential oracle: src/resolve.mjs against the SAPI that specifies it.
//
// A second implementation of security-shaped code is only worth having if
// something proves it agrees with the first. So this drives BOTH over one
// corpus and one filesystem and compares what each resolved to — the C by
// asking a probe script what $_SERVER it was given, the JS by reading its
// return value.
//
// The filesystem is deliberately shared rather than mirrored: the JS resolver
// is handed an adapter over the SAME Emscripten FS the request cycle runs on,
// so a disagreement is a ROUTING disagreement and never two trees drifting.
// What the resolver would do over a wasi-sh store is mount.test.mjs's subject,
// not this file's.
//
// The corpus is branch-shaped, not example-shaped: every refusal in the C has
// a case here, and the ones that exist because getting them wrong discloses
// source are marked. If this file goes red after a change to either side, the
// question is which one is now wrong — not which one to make match.

import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { serve, sharedModule, mkdirp, haveBuild, NO_BUILD_MSG } from './helper.mjs';
import { resolveRequest, inodeProbe, hostFsProbe } from '../src/resolve.mjs';

const SKIP = !haveBuild();
before((t) => { if (SKIP) t.diagnostic(NO_BUILD_MSG); });
const opts = { skip: SKIP ? NO_BUILD_MSG : false };

const DOCROOT = '/oracle';
const THIN = '/oracle-thin';

/**
 * What every .php file in the corpus is: a script that reports the variables
 * the RESOLVER decided, and nothing else.
 *
 * It is the only way to see what the C resolved to. phasm_handle_request()
 * returns a status and a body; SCRIPT_NAME, PATH_INFO and the rest exist only
 * inside the request it ran, so the script it ran has to say.
 */
const PROBE = `<?php
$keys = ['REQUEST_URI', 'QUERY_STRING', 'SCRIPT_NAME', 'PHP_SELF',
         'SCRIPT_FILENAME', 'PATH_INFO', 'PATH_TRANSLATED', 'DOCUMENT_ROOT'];
$out = [];
foreach ($keys as $k) { if (isset($_SERVER[$k])) { $out[$k] = $_SERVER[$k]; } }
echo json_encode($out);
`;

/**
 * A `wasi-sh` fs-contract view of the module's own filesystem — `statSync` and
 * nothing else, which is all the resolver asks for. Emscripten's `stat()`
 * throws for a missing path, which the resolver reads as "nothing there".
 */
function fsView(mod) {
  return inodeProbe({ statSync: (path) => mod.FS.stat(path) });
}

before(async () => {
  if (SKIP) return;
  const mod = await sharedModule();

  const write = (path, content) => {
    const slash = path.lastIndexOf('/');
    if (slash > 0) mkdirp(mod.FS, path.slice(0, slash));
    mod.FS.writeFile(path, content);
  };

  // Every .php is the probe; the rest are there to be resolved against, and
  // to be declined.
  // `/a.php` is a DIRECTORY here and a file in THIN, which is the whole of the
  // contrast the right-to-left walk is about — a name ending in .php is not
  // necessarily a script, and the walk has to stat rather than assume.
  for (const p of [
    '/hello.php', '/a.php/b.php', '/index.php', '/UP.PHP',
    '/my+app.php', '/my app.php', '/q?mark.php', '/app/index.php',
    '/deep/one/two.php',
  ]) write(`${DOCROOT}${p}`, PROBE);

  write(`${DOCROOT}/style.css`, 'body{}');
  write(`${DOCROOT}/README`, 'no suffix');
  mkdirp(mod.FS, `${DOCROOT}/empty`);
  mkdirp(mod.FS, `${DOCROOT}/static-index`);
  write(`${DOCROOT}/static-index/index.html`, '<p>not php</p>');

  // A second tree where /a.php exists and /a.php/b.php does NOT, so the
  // right-to-left walk has something to fall back to.
  write(`${THIN}/a.php`, PROBE);
  write(`${THIN}/index.php`, PROBE);
});

/**
 * One case, run through both.
 *
 * `expect` names only what the case is about; every listed key is compared
 * against BOTH implementations, so a case that pins SCRIPT_NAME pins that the
 * two agree on it as well as that the value is right.
 */
const CASES = [
  // ── the ordinary resolutions ───────────────────────────────────────────────
  { name: 'a plain script', url: '/hello.php', expect: { status: 200, SCRIPT_NAME: '/hello.php', PHP_SELF: '/hello.php' } },
  { name: 'a directory with an index', url: '/app/', expect: { status: 200, SCRIPT_NAME: '/app/index.php' } },
  { name: 'a directory named without its slash', url: '/app', expect: { status: 200, SCRIPT_NAME: '/app/index.php' } },
  { name: 'a nested script', url: '/deep/one/two.php', expect: { status: 200, SCRIPT_NAME: '/deep/one/two.php' } },

  // ── the declines: something is there, it is just not PHP ───────────────────
  { name: 'a stylesheet declines', url: '/style.css', expect: { status: 0 } },
  { name: 'a file with no suffix declines', url: '/README', expect: { status: 0 } },
  { name: 'a directory with no index.php declines', url: '/empty/', expect: { status: 0 } },
  // The one that makes the decline worth having: the embedder serves the
  // index.html sitting right there, but only if it is handed the request back.
  { name: 'a directory with only an index.html declines', url: '/static-index/', expect: { status: 0 } },

  // ── the misses ─────────────────────────────────────────────────────────────
  { name: 'a missing script is a miss', url: '/nope.php', expect: { status: 404 } },
  { name: 'a missing path is a miss', url: '/nope/at/all', expect: { status: 404 } },

  // ── the CGI split ──────────────────────────────────────────────────────────
  {
    name: 'path info reaches the script',
    url: '/hello.php/users/1',
    expect: { status: 200, SCRIPT_NAME: '/hello.php', PATH_INFO: '/users/1', PHP_SELF: '/hello.php/users/1' },
  },
  {
    name: 'the deepest existing script wins',
    url: '/a.php/b.php',
    expect: { status: 200, SCRIPT_NAME: '/a.php/b.php', PATH_INFO: undefined },
  },
  {
    name: 'and falls back to the shallower one when the deeper is not there',
    url: '/a.php/b.php',
    docroot: THIN,
    expect: { status: 200, SCRIPT_NAME: '/a.php', PATH_INFO: '/b.php' },
  },
  // The walk over a path with several slashes in it, where the answer is at
  // neither end. Note what this canNOT test: two candidate scripts along one
  // path, because at most one prefix can be a regular file — every shorter one
  // has to be a directory to contain it. See splitPathInfo()'s note; the
  // right-to-left rule is unobservable, and a corpus that claimed to cover it
  // would be claiming something no filesystem can produce.
  {
    name: 'the walk finds a script that is neither the first nor the last segment',
    url: '/a.php/b.php/extra/bits',
    expect: { status: 200, SCRIPT_NAME: '/a.php/b.php', PATH_INFO: '/extra/bits', PHP_SELF: '/a.php/b.php/extra/bits' },
  },
  {
    name: 'PATH_TRANSLATED is the path info against the DOCROOT, not the script',
    url: '/hello.php/x/y',
    expect: { status: 200, PATH_TRANSLATED: `${DOCROOT}/x/y` },
  },
  // A .css with a component after it must be a MISS and not a decline:
  // declining hands the embedder a path that does not exist, which is the
  // shape that turns into a source disclosure one refactor later.
  { name: 'a non-script with a path component is a miss, not a decline', url: '/style.css/x', expect: { status: 404 } },

  // ── the refusals ───────────────────────────────────────────────────────────
  { name: 'a climb is refused', url: '/../etc/passwd', expect: { status: 403 } },
  { name: 'a climb inside the path is refused', url: '/app/../../etc', expect: { status: 403 } },
  { name: 'an encoded climb is refused, because decoding happens first', url: '/%2e%2e/etc', expect: { status: 403 } },
  { name: 'an encoded NUL is refused outright', url: '/hello%00.php', expect: { status: 400 } },
  // A trailing slash on a file: declining would tell the embedder to serve
  // /hello.php as a static file, i.e. to hand out the source.
  { name: 'a trailing slash on a script is a miss, never a decline', url: '/hello.php/', expect: { status: 404 } },

  // ── normalisation ──────────────────────────────────────────────────────────
  { name: 'a doubled slash is one slash', url: '//hello.php', expect: { status: 200, SCRIPT_NAME: '/hello.php' } },
  { name: 'a dot segment is dropped', url: '/./hello.php', expect: { status: 200, SCRIPT_NAME: '/hello.php' } },
  { name: 'a dot segment mid-path is dropped', url: '/app/./index.php', expect: { status: 200, SCRIPT_NAME: '/app/index.php' } },

  // ── decoding ───────────────────────────────────────────────────────────────
  { name: "'+' is a plus in a path, not a space", url: '/my+app.php', expect: { status: 200, SCRIPT_NAME: '/my+app.php' } },
  { name: '%20 is a space', url: '/my%20app.php', expect: { status: 200, SCRIPT_NAME: '/my app.php' } },
  { name: 'an encoded ? does not start the query string', url: '/q%3Fmark.php', expect: { status: 200, SCRIPT_NAME: '/q?mark.php', QUERY_STRING: '' } },
  { name: 'the suffix match is case-insensitive', url: '/UP.PHP', expect: { status: 200, SCRIPT_NAME: '/UP.PHP' } },

  // ── the query string ───────────────────────────────────────────────────────
  { name: 'a query string survives whole', url: '/hello.php?a=1&b=2', expect: { status: 200, QUERY_STRING: 'a=1&b=2', REQUEST_URI: '/hello.php?a=1&b=2' } },
  { name: 'an empty query is not no query', url: '/hello.php?', expect: { status: 200, QUERY_STRING: '', REQUEST_URI: '/hello.php?' } },

  // ── the front controller ───────────────────────────────────────────────────
  {
    name: 'a pretty URL reaches the front controller',
    url: '/pretty/route', fallback: '/index.php',
    expect: { status: 200, SCRIPT_NAME: '/index.php', REQUEST_URI: '/pretty/route', PATH_INFO: undefined },
  },
  { name: 'a decline is not a miss: a stylesheet still declines under a fallback', url: '/style.css', fallback: '/index.php', expect: { status: 0 } },
  { name: 'and a directory with no index still declines under one', url: '/empty/', fallback: '/index.php', expect: { status: 0 } },
  { name: 'a path that resolves on its own is unaffected by a fallback', url: '/hello.php', fallback: '/index.php', expect: { status: 200, SCRIPT_NAME: '/hello.php' } },
  { name: 'a front controller that is not there 404s the request', url: '/pretty/route', fallback: '/missing.php', expect: { status: 404 } },
  { name: 'a front controller that is not a .php is refused on every request', url: '/hello.php', fallback: '/index.html', expect: { status: 500 } },
  { name: 'a relative front controller is refused', url: '/hello.php', fallback: 'index.php', expect: { status: 500 } },
  { name: 'a climbing front controller is refused', url: '/hello.php', fallback: '/../index.php', expect: { status: 500 } },

  // ── the deployment prefix ──────────────────────────────────────────────────
  {
    name: 'a prefix rejoins the three variables that say WHERE',
    url: '/hello.php', prefix: '/dep',
    expect: { status: 200, SCRIPT_NAME: '/dep/hello.php', PHP_SELF: '/dep/hello.php', REQUEST_URI: '/dep/hello.php', SCRIPT_FILENAME: `${DOCROOT}/hello.php`, DOCUMENT_ROOT: DOCROOT },
  },
  {
    name: 'a prefix with path info keeps PHP_SELF and SCRIPT_NAME different',
    url: '/hello.php/x', prefix: '/dep',
    expect: { status: 200, SCRIPT_NAME: '/dep/hello.php', PHP_SELF: '/dep/hello.php/x', PATH_INFO: '/x', PATH_TRANSLATED: `${DOCROOT}/x` },
  },
  { name: 'a prefix with a trailing slash is refused rather than trimmed', url: '/hello.php', prefix: '/dep/', expect: { status: 500 } },
  { name: 'a relative prefix is refused', url: '/hello.php', prefix: 'dep', expect: { status: 500 } },
  { name: 'a climbing prefix is refused', url: '/hello.php', prefix: '/../dep', expect: { status: 500 } },
];

describe('the resolver agrees with the SAPI that specifies it', opts, () => {
  for (const c of CASES) {
    test(c.name, async () => {
      const mod = await sharedModule();
      const docroot = c.docroot || DOCROOT;
      const options = { docroot, fallback: c.fallback, prefix: c.prefix };

      const sapi = await serve({ url: c.url, ...options });
      const js = resolveRequest(c.url, fsView(mod), options);

      // The statuses first, because everything else is only meaningful when
      // the request resolved the same way in both.
      assert.equal(sapi.status, c.expect.status, `the SAPI answered ${sapi.status}`);
      assert.equal(js.status, c.expect.status, `the resolver answered ${js.status}`);

      if (c.expect.status !== 200) return;

      const server = JSON.parse(sapi.text);
      const mine = {
        REQUEST_URI: js.uri,
        QUERY_STRING: js.query ?? '',
        SCRIPT_NAME: js.scriptName,
        PHP_SELF: js.phpSelf,
        SCRIPT_FILENAME: js.script,
        PATH_INFO: js.pathInfo,
        PATH_TRANSLATED: js.pathTranslated,
        DOCUMENT_ROOT: js.docroot,
      };

      // Every variable the resolver decides, on every 200 — not only the ones
      // the case names. A case about PATH_INFO that silently disagreed about
      // SCRIPT_NAME would be a case that tested nothing.
      for (const key of Object.keys(mine)) {
        assert.equal(
          mine[key], server[key],
          `${key}: the resolver says ${JSON.stringify(mine[key])}, the SAPI says ${JSON.stringify(server[key])}`,
        );
      }

      // And then what the case is actually about, so a corpus that agrees on
      // the wrong answer is still caught.
      for (const [key, want] of Object.entries(c.expect)) {
        if (key === 'status') continue;
        assert.equal(server[key], want, `${key} should be ${JSON.stringify(want)}`);
      }
    });
  }
});

// ─── the two probes ──────────────────────────────────────────────────────────

// `inodeProbe` reads mode bits and `hostFsProbe` reads `{type}`, and the second
// is the one the serve builtin actually runs on — so a disagreement between
// them would mean the corpus above proves nothing about production. They are
// two ways of asking one filesystem the same two questions, and this is the
// only place that says so.
//
// Written after a test double got exactly this wrong: it reported "nothing
// there" for a directory named with the trailing slash a request carries,
// which made a decline look like a 404.

describe('the two probes answer alike', opts, () => {
  test('over every path in the corpus', async () => {
    const mod = await sharedModule();
    const byInode = inodeProbe({ statSync: (p) => mod.FS.stat(p) });
    const byHostFs = hostFsProbe({
      // `ctx.fs.stat()`'s shape, over the same tree.
      stat: (p) => {
        try {
          const mode = mod.FS.stat(p).mode & 0o170000;
          if (mode === 0o100000) return { type: 'file', size: 0 };
          if (mode === 0o040000) return { type: 'dir', size: 0 };
          return null;
        } catch {
          return null;
        }
      },
    });

    const paths = [
      DOCROOT, `${DOCROOT}/`, `${DOCROOT}/hello.php`, `${DOCROOT}/style.css`,
      `${DOCROOT}/app`, `${DOCROOT}/app/`, `${DOCROOT}/app/index.php`,
      `${DOCROOT}/empty`, `${DOCROOT}/empty/`, `${DOCROOT}/a.php`,
      `${DOCROOT}/a.php/b.php`, `${DOCROOT}/nope`, `${DOCROOT}/README`,
      `${DOCROOT}/static-index/`, '/', '/nowhere/at/all',
    ];

    for (const p of paths) {
      assert.equal(byInode.isFile(p), byHostFs.isFile(p), `isFile disagreed on ${p}`);
      assert.equal(byInode.isDir(p), byHostFs.isDir(p), `isDir disagreed on ${p}`);
    }
  });
});
