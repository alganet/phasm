// SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>
//
// SPDX-License-Identifier: ISC

// Server mode: phasmHandleRequest(), the half of the embedding contract that
// sapi.test.mjs does not reach.
//
// The point of running a real request cycle rather than faking superglobals is
// that everything below arrives by itself — $_GET from the query string, $_POST
// and $_FILES from PHP's own post readers, php://input from the same buffer,
// header() and http_response_code() through a send_headers hook. So these tests
// are mostly about proving that "by itself" is true, and that a request leaves
// no more behind than a command does.

import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { serve, evalPhp, sharedModule, freshModule, mkdirp, haveBuild, NO_BUILD_MSG } from './helper.mjs';

const SKIP = !haveBuild();
before((t) => { if (SKIP) t.diagnostic(NO_BUILD_MSG); });
const opts = { skip: SKIP ? NO_BUILD_MSG : false };

const DOCROOT = '/www';

/** Write a file into the shared instance's filesystem, creating directories. */
async function site(files) {
  const mod = await sharedModule();
  for (const [path, content] of Object.entries(files)) {
    const full = `${DOCROOT}${path}`;
    const slash = full.lastIndexOf('/');
    if (slash > 0) mkdirp(mod.FS, full.slice(0, slash));
    mod.FS.writeFile(full, content);
  }
}

// ─── routing ─────────────────────────────────────────────────────────────────

describe('routing', opts, () => {
  test('runs the script the path resolves to', async () => {
    await site({ '/hello.php': '<?php echo "hello";' });
    const r = await serve({ url: '/hello.php', docroot: DOCROOT });

    assert.equal(r.status, 200);
    assert.equal(r.text, 'hello');
  });

  test('a directory resolves to its index.php', async () => {
    await site({ '/app/index.php': '<?php echo "indexed";' });

    assert.equal((await serve({ url: '/app/', docroot: DOCROOT })).text, 'indexed');
    assert.equal((await serve({ url: '/app', docroot: DOCROOT })).text, 'indexed');
  });

  test('a missing path is 404 and runs nothing', async () => {
    const r = await serve({ url: '/nope.php', docroot: DOCROOT });
    assert.equal(r.status, 404);
    assert.equal(r.text, '');
  });

  // Not an error: PHP has no business guessing that .css is text/css, and a
  // service worker reading the same filesystem is far better placed to serve
  // it. Declining says "not mine" without pretending it does not exist.
  test('declines a file that is not a PHP script', async () => {
    await site({ '/style.css': 'body { color: red }' });
    const r = await serve({ url: '/style.css', docroot: DOCROOT });

    assert.equal(r.status, 0);
    assert.equal(r.text, '');
  });

  // Declining means "serve it as a static file", so a suffix match that is
  // case-sensitive does not merely fail to run /A.PHP — it answers the request
  // with the script's source. php_cli_server.c matches case-insensitively for
  // the same reason.
  test('an uppercase .PHP is still a script', async () => {
    await site({ '/A.PHP': '<?php echo "shouted";' });
    const r = await serve({ url: '/A.PHP', docroot: DOCROOT });

    assert.equal(r.status, 200, 'the source would have been served as a static file');
    assert.equal(r.text, 'shouted');
  });

  // A directory is not a PHP request when it has no index.php, and 404 is a
  // stronger claim than this SAPI is entitled to make: the embedder is reading
  // the same filesystem and can see the index.html sitting right there.
  test('a directory with no index.php is declined, not 404', async () => {
    await site({ '/static/index.html': '<h1>plain</h1>' });
    const r = await serve({ url: '/static/', docroot: DOCROOT });

    assert.equal(r.status, 0);
    assert.equal(r.text, '');
  });

  // The standard no-rewrite front controller: everything under one script,
  // addressed by what follows it. Without the split it is a 404 for a script
  // that is right there, and $_SERVER carries no PATH_INFO at all — so the one
  // routing shape a project can rely on before anybody has configured a server
  // was unreachable.
  test('a path after a script is PATH_INFO, not a 404', async () => {
    await site({
      '/front.php': '<?php echo json_encode(['
        + '"script" => $_SERVER["SCRIPT_NAME"], "self" => $_SERVER["PHP_SELF"],'
        + '"info" => $_SERVER["PATH_INFO"], "translated" => $_SERVER["PATH_TRANSLATED"],'
        + '"file" => $_SERVER["SCRIPT_FILENAME"], "uri" => $_SERVER["REQUEST_URI"]]);',
    });
    const r = await serve({ url: '/front.php/users/1?page=2', docroot: DOCROOT });

    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.text), {
      script: '/front.php',
      // PHP_SELF carries the path info and SCRIPT_NAME does not: that is the
      // whole difference between the two, and it is what a front controller
      // reads to tell "what ran" from "what was asked for".
      self: '/front.php/users/1',
      info: '/users/1',
      // CGI's meaning: the path info against the DOCROOT, not the script's own
      // filename, which is what used to be registered here.
      translated: `${DOCROOT}/users/1`,
      file: `${DOCROOT}/front.php`,
      uri: '/front.php/users/1?page=2',
    });
  });

  // Right to left, so the deepest script that actually exists wins — the same
  // walk php_cli_server.c does.
  test('the deepest existing script takes the path info', async () => {
    await site({
      '/outer.php': '<?php echo "outer:", $_SERVER["PATH_INFO"];',
      '/outer.php.d/inner.php': '<?php echo "inner:", $_SERVER["PATH_INFO"] ?? "none";',
    });

    assert.equal((await serve({ url: '/outer.php/x/y', docroot: DOCROOT })).text, 'outer:/x/y');
    assert.equal(
      (await serve({ url: '/outer.php.d/inner.php/z', docroot: DOCROOT })).text,
      'inner:/z',
    );
  });

  // A prefix that is a file but not a script is a 404 rather than a decline.
  // Declining says "serve this path yourself", and the path the embedder would
  // be handed still has the extra component on it — a file that is not there.
  test('a path after a non-script is 404, not a decline', async () => {
    await site({ '/asset.css': 'body{}' });
    const r = await serve({ url: '/asset.css/extra', docroot: DOCROOT });

    assert.equal(r.status, 404);
    assert.equal(r.text, '');
  });

  // The split runs after the traversal refusal and after normalisation, like
  // everything else that resolves a path here.
  test('path info cannot climb out of the docroot', async () => {
    await site({ '/guard.php': '<?php echo "ran";' });

    assert.equal((await serve({ url: '/guard.php/../../etc', docroot: DOCROOT })).status, 403);
    assert.equal((await serve({ url: '/guard.php/%2e%2e/x', docroot: DOCROOT })).status, 403);
  });

  // Two spellings of one path must not reach a route table as two routes.
  test('duplicate and dot segments collapse', async () => {
    await site({ '/seg.php': '<?php echo $_SERVER["SCRIPT_NAME"];' });

    for (const url of ['//seg.php', '/./seg.php', '/.//./seg.php']) {
      const r = await serve({ url, docroot: DOCROOT });
      assert.equal(r.status, 200, url);
      assert.equal(r.text, '/seg.php', `${url} reached PHP unnormalised`);
    }
  });

  // A trailing slash is not collapsed, because "/seg.php/" asks for a directory
  // and POSIX answers ENOTDIR. Emscripten's stat() answers for the file anyway,
  // so this has to be caught by hand: without it the suffix check fails on the
  // slash, the request is declined, and declining means the embedder serves
  // /seg.php as a static file — the source, to whoever added one character.
  test('a trailing slash on a script is 404, not a decline', async () => {
    await site({ '/seg.php': '<?php echo "ran";' });
    const r = await serve({ url: '/seg.php/', docroot: DOCROOT });

    assert.equal(r.status, 404, 'the embedder would have been asked to serve the source');
    assert.equal(r.text, '');
  });

  // phasm_response_status() is an exported entry point in its own right, and a
  // caller driving the wasm directly rather than through the glue has no other
  // way to ask what the status was. It used to be written only where a request
  // had actually run, so every refusal left it at the 0 phasm_response_reset()
  // cleared it to — and 0 is not "no status" in this ABI, it is the decline
  // that says "serve this path as a static file". A 403 read back that way is
  // the source disclosure the refusal exists to prevent.
  test('a refusal reports its own status, not the decline value', async () => {
    await site({ '/seg.php': '<?php echo "ran";', '/style.css': 'body{}' });
    const mod = await sharedModule();

    for (const [url, expected] of [
      ['/seg.php', 200],
      ['/seg.php/', 404],
      ['/missing.php', 404],
      ['/../etc/passwd', 403],
      ['/style.css', 0], // the genuine decline, which must stay 0
    ]) {
      const returned = mod.phasmHandleRequest({ url, docroot: DOCROOT }).status;
      assert.equal(returned, expected, url);
      assert.equal(mod._phasm_response_status(), expected,
        `${url} returned ${returned} but reported ${mod._phasm_response_status()}`);
    }
  });

  // This runs against the embedder's whole filesystem, so climbing out of the
  // docroot has to be refused rather than normalised — including when the
  // dots arrive percent-encoded, which is why decoding happens first.
  test('refuses a path that climbs out of the docroot', async () => {
    await site({ '/index.php': '<?php echo "inside";' });

    for (const url of ['/../etc/passwd', '/app/../../x', '/%2e%2e/secret.php']) {
      assert.equal((await serve({ url, docroot: DOCROOT })).status, 403, url);
    }
  });

  // An encoded NUL truncates every C string after it, so a check that reads the
  // prefix can pass while something else acts on the whole path — and the
  // traversal guard's strstr() stops at the NUL and never sees the "..".
  test('refuses an encoded NUL in the path', async () => {
    await site({ '/nul.php': '<?php echo "ran";' });

    for (const url of ['/nul.php%00.txt', '/nul.php%00/../../etc/passwd']) {
      const r = await serve({ url, docroot: DOCROOT });
      assert.equal(r.status, 400, url);
      assert.equal(r.text, '', `${url} ran a script`);
    }
  });

  // '+' means a space in a query string and a plain '+' in a path. Decoding the
  // path with the query-string rules 404s a file that is sitting right there.
  test('a + in the path is a plus, not a space', async () => {
    await site({ '/my+app.php': '<?php echo "plus";' });
    const r = await serve({ url: '/my+app.php', docroot: DOCROOT });

    assert.equal(r.status, 200);
    assert.equal(r.text, 'plus');
  });

  test('percent-encoding in the path is decoded', async () => {
    await site({ '/a b.php': '<?php echo "spaced";' });
    assert.equal((await serve({ url: '/a%20b.php', docroot: DOCROOT })).text, 'spaced');
  });

  // The docroot is joined to the path by hand, and "/" is the one value where
  // the obvious join produces "//app.php" — a different path to opcache, to
  // include_once and to anything comparing __FILE__.
  test('a docroot of / does not double the slash', async () => {
    const mod = await sharedModule();
    mod.FS.writeFile('/root.php', '<?php echo $_SERVER["SCRIPT_FILENAME"];');

    assert.equal((await serve({ url: '/root.php', docroot: '/' })).text, '/root.php');
  });
});

// ─── the request reaching PHP ────────────────────────────────────────────────

// ─── the front controller ────────────────────────────────────────────────────

// `fallback` is `try_files $uri /index.php` and Apache's `FallbackResource` in
// one option, and it exists because without it a framework is unusable rather
// than merely awkward: every pretty URL is a 404 for a route that is right
// there. Measured against a real Laravel app before this was written — its
// front controller worked at /index.php/whoami/42 through the PATH_INFO split
// and 404'd at /whoami/42.
//
// The line these tests are really about is **a decline is not a miss**. A file
// that is there and is not PHP, and a directory with no index.php, both keep
// answering 0 so the embedder serves them; only paths with *nothing* behind
// them reach the front controller. Get that wrong and configuring a fallback
// silently stops serving stylesheets and hands the app an HTML 200 instead.
describe('the front controller', opts, () => {
  const FC = {
    '/fc/index.php':
      '<?php echo json_encode(["uri" => $_SERVER["REQUEST_URI"], "script" => $_SERVER["SCRIPT_NAME"],'
      + ' "self" => $_SERVER["PHP_SELF"], "info" => $_SERVER["PATH_INFO"] ?? null,'
      + ' "query" => $_SERVER["QUERY_STRING"], "who" => "front"]);',
    '/fc/real.php': '<?php echo json_encode(["who" => "real", "info" => $_SERVER["PATH_INFO"] ?? null]);',
    '/fc/style.css': 'body{}',
    '/fc/sub/index.php': '<?php echo json_encode(["who" => "sub"]);',
  };
  const ask = async (url, extra = {}) => serve({ url, docroot: `${DOCROOT}/fc`, ...extra });

  test('a path with nothing behind it reaches the front controller', async () => {
    await site(FC);
    const plain = await ask('/users/1');
    assert.equal(plain.status, 404, 'without a fallback this is still a 404');

    const r = await ask('/users/1', { fallback: '/index.php' });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.text), {
      who: 'front',
      // nginx's shape, which is what Laravel's documented config produces and
      // therefore what Symfony's base-URL detection is written against: the
      // URI is what was asked for, the script is the front controller, and
      // PATH_INFO is absent rather than carrying the unmatched path.
      uri: '/users/1',
      script: '/index.php',
      self: '/index.php',
      info: null,
      query: '',
    });
  });

  test('the query string survives the rewrite', async () => {
    await site(FC);
    const r = await ask('/search?q=cats&page=2', { fallback: '/index.php' });
    const got = JSON.parse(r.text);
    assert.equal(got.uri, '/search?q=cats&page=2');
    assert.equal(got.query, 'q=cats&page=2');
  });

  // Everything that already resolved has to keep resolving, or the option is
  // not a fallback, it is a takeover.
  test('a path that resolves on its own is untouched', async () => {
    await site(FC);
    const fb = { fallback: '/index.php' };

    assert.equal(JSON.parse((await ask('/real.php', fb)).text).who, 'real');
    assert.equal(JSON.parse((await ask('/index.php', fb)).text).who, 'front');
    assert.equal(JSON.parse((await ask('/', fb)).text).who, 'front');
    assert.equal(JSON.parse((await ask('/sub', fb)).text).who, 'sub');
  });

  test('the PATH_INFO split still wins over the fallback', async () => {
    await site(FC);
    const r = await ask('/real.php/a/b', { fallback: '/index.php' });
    assert.deepEqual(JSON.parse(r.text), { who: 'real', info: '/a/b' });
  });

  // The one that would be a real outage: a stylesheet swallowed by the front
  // controller is served as an HTML 200, and the page loses its CSS with
  // nothing anywhere reporting an error.
  test('a decline is not a miss — static files and bare directories still decline', async () => {
    await site({ ...FC, '/fc/bare/.keep': '' });
    const fb = { fallback: '/index.php' };

    assert.equal((await ask('/style.css', fb)).status, 0, 'a file that is there is not PHP\u2019s');
    assert.equal((await ask('/bare', fb)).status, 0, 'a directory with no index.php is the embedder\u2019s');
  });

  // Shape is checked on every request, not at the 404 where it is first
  // needed: a misspelled front controller that only misbehaves on the paths
  // that were already failing is one nobody attributes correctly.
  test('a malformed fallback is a 500 even for a path that resolves', async () => {
    await site(FC);
    for (const bad of ['index.php', '/../escape.php', '/index.html', '/a/../../x.php']) {
      const r = await ask('/real.php', { fallback: bad });
      assert.equal(r.status, 500, `expected 500 for fallback ${JSON.stringify(bad)}`);
    }
  });

  // Apache's answer for a FallbackResource that is not there, and deliberately
  // not the 500 above: this is a deleted file, not a mistyped setting.
  test('a well-formed fallback that is missing leaves the 404 alone', async () => {
    await site(FC);
    const r = await ask('/users/1', { fallback: '/not-here.php' });
    assert.equal(r.status, 404);
    assert.equal(r.text, '');
  });

  test('an empty fallback means the same as none', async () => {
    await site(FC);
    assert.equal((await ask('/users/1', { fallback: '' })).status, 404);
  });
});

// ─── the deployment prefix ───────────────────────────────────────────────────

// A service worker strips its own base before handing the path over, so the
// same project serves from any URL prefix without being rebuilt. The cost of
// that was an app that could not build a correct link to itself: SCRIPT_NAME
// said /index.php while the address bar said /phasm/dev/site/index.php, and
// every root-absolute URL a framework generates — Laravel's url(), asset() and
// route() are all of them — pointed at the origin root.
//
// `prefix` puts it back on exactly the three variables that say WHERE the
// request came from, and none that say where the files are. The split is the
// whole design, so it is what these tests assert.
describe('the deployment prefix', opts, () => {
  const DUMP =
    '<?php echo json_encode(["uri" => $_SERVER["REQUEST_URI"], "script" => $_SERVER["SCRIPT_NAME"],'
    + ' "self" => $_SERVER["PHP_SELF"], "info" => $_SERVER["PATH_INFO"] ?? null,'
    + ' "file" => $_SERVER["SCRIPT_FILENAME"], "root" => $_SERVER["DOCUMENT_ROOT"],'
    + ' "trans" => $_SERVER["PATH_TRANSLATED"] ?? null]);';
  const PREFIX = '/phasm/dev/site';
  const ask = async (url, extra = {}) => {
    await site({ '/px/index.php': DUMP, '/px/deep.php': DUMP });
    const r = await serve({ url, docroot: `${DOCROOT}/px`, ...extra });
    return { status: r.status, ...(r.status === 200 ? JSON.parse(r.text) : {}) };
  };

  test('the three URL variables carry it and the three path variables do not', async () => {
    const got = await ask('/deep.php', { prefix: PREFIX });
    assert.deepEqual(got, {
      status: 200,
      uri: `${PREFIX}/deep.php`,
      script: `${PREFIX}/deep.php`,
      self: `${PREFIX}/deep.php`,
      info: null,
      // The guest's filesystem never hears about the prefix — that is what
      // keeps the project portable across wherever it is deployed.
      file: `${DOCROOT}/px/deep.php`,
      root: `${DOCROOT}/px`,
      trans: null,
    });
  });

  // REQUEST_URI and SCRIPT_NAME have to move together. Symfony walks
  // SCRIPT_NAME's directory against REQUEST_URI to find its base URL, so a
  // prefix on one and not the other leaves it matching nothing: routing still
  // works, getBaseUrl() answers "", and the links are wrong again with
  // everything apparently fine.
  test('path info rides on the end of a prefixed PHP_SELF', async () => {
    const got = await ask('/deep.php/users/1', { prefix: PREFIX });
    assert.equal(got.uri, `${PREFIX}/deep.php/users/1`);
    assert.equal(got.script, `${PREFIX}/deep.php`);
    assert.equal(got.self, `${PREFIX}/deep.php/users/1`);
    assert.equal(got.info, '/users/1', 'the path info is after the script, so the prefix is not on it');
    assert.equal(got.trans, `${DOCROOT}/px/users/1`, 'CGI resolves it against the docroot, prefix or no prefix');
  });

  test('it composes with the front controller and the query string', async () => {
    const got = await ask('/users/1?x=2', { prefix: PREFIX, fallback: '/index.php' });
    assert.equal(got.uri, `${PREFIX}/users/1?x=2`);
    assert.equal(got.script, `${PREFIX}/index.php`);
    assert.equal(got.self, `${PREFIX}/index.php`);
    assert.equal(got.file, `${DOCROOT}/px/index.php`);
  });

  test('a directory index gets it too', async () => {
    const got = await ask('/', { prefix: PREFIX });
    assert.equal(got.uri, `${PREFIX}/`);
    assert.equal(got.script, `${PREFIX}/index.php`);
  });

  test('no prefix leaves every variable exactly as it was', async () => {
    const bare = await ask('/deep.php/users/1');
    const empty = await ask('/deep.php/users/1', { prefix: '' });
    assert.deepEqual(empty, bare);
    assert.equal(bare.script, '/deep.php');
    assert.equal(bare.uri, '/deep.php/users/1');
  });

  // One spelling of the setting, checked on every request for the same reason
  // `fallback`'s shape is: a prefix that is silently trimmed or silently
  // ignored produces wrong links, which is the failure nobody traces back here.
  test('a malformed prefix is a 500', async () => {
    for (const bad of ['phasm', '/phasm/', '/a/../..', '/x?y']) {
      const r = await ask('/deep.php', { prefix: bad });
      assert.equal(r.status, 500, `expected 500 for prefix ${JSON.stringify(bad)}`);
    }
  });
});

describe('the request', opts, () => {
  test('$_GET comes from the query string', async () => {
    await site({ '/get.php': '<?php echo json_encode($_GET);' });
    const r = await serve({ url: '/get.php?a=1&b=two', docroot: DOCROOT });

    assert.equal(r.text, '{"a":"1","b":"two"}');
  });

  test('$_POST comes from a form-encoded body', async () => {
    await site({ '/post.php': '<?php echo json_encode($_POST);' });
    const r = await serve({
      url: '/post.php',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'name=alex&role=dev',
      docroot: DOCROOT,
    });

    assert.equal(r.text, '{"name":"alex","role":"dev"}');
  });

  test('a string body reaches PHP as its own bytes', async () => {
    // Straight at phasmHandleRequest(), because serve() above encodes strings
    // before they get there and so could never have caught this: a string is
    // array-like, so the copy into the heap indexed it, coerced every character
    // to NaN and wrote that many NUL bytes. The request succeeded, with the
    // right Content-Length, an empty $_POST and a php://input full of nothing.
    await site({ '/rawstr.php': '<?php echo file_get_contents("php://input");' });
    const mod = await sharedModule();
    const res = mod.phasmHandleRequest({
      url: '/rawstr.php',
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'not nul bytes',
      docroot: DOCROOT,
    });

    assert.equal(new TextDecoder().decode(res.body), 'not nul bytes');
  });

  test('a body that is neither string nor bytes is refused', async () => {
    const mod = await sharedModule();
    assert.throws(
      () => mod.phasmHandleRequest({ url: '/rawstr.php', method: 'POST', body: { a: 1 }, docroot: DOCROOT }),
      TypeError,
    );
  });

  test('php://input carries the raw body', async () => {
    await site({ '/raw.php': '<?php echo file_get_contents("php://input");' });
    const r = await serve({
      url: '/raw.php',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"json":true}',
      docroot: DOCROOT,
    });

    assert.equal(r.text, '{"json":true}');
  });

  // The rfc1867 multipart parser is PHP's, driven by the same read_post hook.
  // Faking $_FILES is exactly what running a real request cycle avoids.
  test('$_FILES is populated from a multipart upload', async () => {
    await site({
      '/upload.php': '<?php echo json_encode(['
        + '$_FILES["f"]["name"], $_FILES["f"]["error"],'
        + 'file_get_contents($_FILES["f"]["tmp_name"]), $_POST["caption"]]);',
    });

    const B = '----phasmboundary';
    const body = [
      `--${B}`,
      'Content-Disposition: form-data; name="caption"',
      '',
      'a picture',
      `--${B}`,
      'Content-Disposition: form-data; name="f"; filename="note.txt"',
      'Content-Type: text/plain',
      '',
      'file body',
      `--${B}--`,
      '',
    ].join('\r\n');

    const r = await serve({
      url: '/upload.php',
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${B}` },
      body,
      docroot: DOCROOT,
    });

    assert.equal(r.text, '["note.txt",0,"file body","a picture"]');
  });

  test('$_COOKIE comes from the Cookie header', async () => {
    await site({ '/cookie.php': '<?php echo json_encode($_COOKIE);' });
    const r = await serve({
      url: '/cookie.php',
      headers: { Cookie: 'session=abc; theme=dark' },
      docroot: DOCROOT,
    });

    assert.equal(r.text, '{"session":"abc","theme":"dark"}');
  });

  test('$_SERVER describes the request', async () => {
    await site({ '/server.php': '<?php echo json_encode(array_intersect_key($_SERVER, array_flip(['
      + '"REQUEST_METHOD","REQUEST_URI","QUERY_STRING","SCRIPT_NAME",'
      + '"DOCUMENT_ROOT","HTTP_X_CUSTOM","CONTENT_TYPE"])));' });

    const r = await serve({
      url: '/server.php?q=1',
      method: 'POST',
      headers: { 'X-Custom': 'yes', 'Content-Type': 'text/plain' },
      body: 'x',
      docroot: DOCROOT,
    });
    const s = JSON.parse(r.text);

    assert.equal(s.REQUEST_METHOD, 'POST');
    assert.equal(s.REQUEST_URI, '/server.php?q=1');
    assert.equal(s.QUERY_STRING, 'q=1');
    assert.equal(s.SCRIPT_NAME, '/server.php');
    assert.equal(s.DOCUMENT_ROOT, DOCROOT);
    assert.equal(s.HTTP_X_CUSTOM, 'yes');
    assert.equal(s.CONTENT_TYPE, 'text/plain');
  });

  // A great deal of code builds a base URL out of SERVER_NAME and SERVER_PORT.
  // Leaving them out produces "http://:" plus two undefined-key warnings, which
  // reads as a bug in the application rather than a gap in the SAPI.
  test('SERVER_NAME and SERVER_PORT come from the Host header', async () => {
    await site({ '/host.php': '<?php echo $_SERVER["SERVER_NAME"], "|", $_SERVER["SERVER_PORT"];' });

    const withPort = await serve({
      url: '/host.php', headers: { Host: 'example.test:8080' }, docroot: DOCROOT,
    });
    assert.equal(withPort.text, 'example.test|8080');

    const noPort = await serve({
      url: '/host.php', headers: { Host: 'example.test' }, docroot: DOCROOT,
    });
    assert.equal(noPort.text, 'example.test|80');

    const noHost = await serve({ url: '/host.php', docroot: DOCROOT });
    assert.equal(noHost.text, 'localhost|80');
  });

  // A router reads SCRIPT_NAME to work out its own prefix, so the index.php it
  // resolved to has to be visible there even though the client never sent it.
  test('SCRIPT_NAME names the resolved script, REQUEST_URI what was asked', async () => {
    await site({ '/blog/index.php': '<?php echo $_SERVER["SCRIPT_NAME"], " ", $_SERVER["REQUEST_URI"];' });
    const r = await serve({ url: '/blog/', docroot: DOCROOT });

    assert.equal(r.text, '/blog/index.php /blog/');
  });

  // PATH_INFO is absent rather than empty for an ordinary request, which is
  // what php-cgi and the built-in server both answer — code tests `isset()` on
  // it to decide whether there is any, and an empty string is an answer of
  // "yes, and it is nothing".
  test('a plain script gets no PATH_INFO and no PATH_TRANSLATED', async () => {
    await site({ '/plain.php': '<?php echo json_encode([isset($_SERVER["PATH_INFO"]), isset($_SERVER["PATH_TRANSLATED"])]);' });
    const r = await serve({ url: '/plain.php', docroot: DOCROOT });

    assert.equal(r.text, '[false,false]');
  });
});

// ─── the response coming back ────────────────────────────────────────────────

describe('the response', opts, () => {
  // The whole reason for a send_header hook: under the CLI SAPI header() is
  // accepted and thrown away, so anything calling it directly is broken in a
  // way that only shows up in the browser.
  test('header() reaches the caller', async () => {
    await site({ '/head.php': '<?php header("Content-Type: application/json");'
      + 'header("X-Powered-By: phasm"); echo "{}";' });
    const r = await serve({ url: '/head.php', docroot: DOCROOT });

    assert.equal(r.headers.get('Content-Type'), 'application/json');
    assert.equal(r.headers.get('X-Powered-By'), 'phasm');
  });

  test('http_response_code() sets the status', async () => {
    await site({ '/code.php': '<?php http_response_code(418); echo "teapot";' });
    const r = await serve({ url: '/code.php', docroot: DOCROOT });

    assert.equal(r.status, 418);
    assert.equal(r.text, 'teapot');
  });

  test('a status set through header() works too', async () => {
    await site({ '/redir.php': '<?php header("Location: /elsewhere", true, 302);' });
    const r = await serve({ url: '/redir.php', docroot: DOCROOT });

    assert.equal(r.status, 302);
    assert.equal(r.headers.get('Location'), '/elsewhere');
  });

  // Set-Cookie is the header that legitimately repeats, and every way of
  // collapsing it into a map is lossy: keeping the last drops a cookie, and
  // joining with ", " yields one header a browser reads as a single cookie
  // whose value contains the other — unsplittable, because an Expires date has
  // a comma in it. So the pairs have to survive as pairs, and asserting on the
  // count is what makes that failure visible rather than a substring match.
  test('repeated headers arrive as separate headers', async () => {
    await site({ '/cookies.php': '<?php setcookie("a", "1"); setcookie("b", "2"); echo "ok";' });
    const r = await serve({ url: '/cookies.php', docroot: DOCROOT });

    const set = r.rawHeaders.filter(([n]) => n.toLowerCase() === 'set-cookie');
    assert.equal(set.length, 2, `got ${JSON.stringify(r.rawHeaders)}`);
    assert.match(set[0][1], /^a=1/);
    assert.match(set[1][1], /^b=2/);
  });

  test('the body is bytes, not text', async () => {
    await site({ '/png.php': '<?php header("Content-Type: image/png");'
      + 'echo "\\x89PNG\\r\\n\\x1a\\n", chr(0), chr(255);' });
    const r = await serve({ url: '/png.php', docroot: DOCROOT });

    assert.deepEqual(
      Array.from(r.body),
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff],
    );
  });

  test('a response with no output still has its headers and status', async () => {
    await site({ '/empty.php': '<?php http_response_code(204); header("X-Empty: yes");' });
    const r = await serve({ url: '/empty.php', docroot: DOCROOT });

    assert.equal(r.status, 204);
    assert.equal(r.headers.get('X-Empty'), 'yes');
    assert.equal(r.body.length, 0);
  });

  test('an uncaught fatal is a 500', async () => {
    await site({ '/fatal.php': '<?php no_such_function_at_all();' });
    const r = await serve({ url: '/fatal.php', docroot: DOCROOT });

    assert.equal(r.status, 500);
  });

  // php_execute_script() reports false for a clean exit as well as for a fatal,
  // so "it returned false" cannot mean 500 on its own — and `render(); exit;` is
  // how a great many front controllers finish. Getting this wrong turns every
  // successful page into a server error while still returning the right body.
  test('exit() is a successful response, not a 500', async () => {
    await site({
      '/exit.php': '<?php echo "done"; exit;',
      '/exit0.php': '<?php echo "zero"; exit(0);',
      '/exitc.php': '<?php http_response_code(201); echo "made"; exit;',
      '/die.php': '<?php die("bye");',
    });

    assert.deepEqual(
      await Promise.all(['/exit.php', '/exit0.php', '/exitc.php', '/die.php']
        .map(async (u) => (await serve({ url: u, docroot: DOCROOT })).status)),
      [200, 200, 201, 200],
    );
    assert.equal((await serve({ url: '/exit.php', docroot: DOCROOT })).text, 'done');
  });

  // The response is committed when php_request_shutdown() deactivates the
  // output layer, which is *after* it runs the shutdown functions — so a
  // framework that sends headers from one is not too late. Committing the
  // headers before shutdown, which is the obvious place, breaks this.
  test('a shutdown function can still send headers', async () => {
    await site({ '/late.php': '<?php register_shutdown_function(function () {'
      + 'header("X-Late: yes"); });' });

    assert.equal((await serve({ url: '/late.php', docroot: DOCROOT })).headers.get('X-Late'), 'yes');
  });

  // Once bytes have gone out the headers are committed, exactly as under any
  // other SAPI — and phasm inherits the CLI's output_buffering=0, so "gone out"
  // means the first echo. Buffering is the fix, and it is the embedder's to
  // choose because it applies to the whole instance.
  test('output commits the headers, and buffering defers that', async () => {
    await site({ '/late2.php': '<?php register_shutdown_function(function () {'
      + 'header("X-Late: yes"); }); echo "body";' });

    const unbuffered = await serve({ url: '/late2.php', docroot: DOCROOT });
    assert.equal(unbuffered.text, 'body');
    assert.equal(unbuffered.headers.get('X-Late'), null);

    const buffered = await serve({
      url: '/late2.php',
      docroot: DOCROOT,
      fresh: true,
      ini: 'output_buffering=4096',
      files: { [`${DOCROOT}/late2.php`]: '<?php register_shutdown_function(function () {'
        + 'header("X-Late: yes"); }); echo "body";' },
    });
    assert.equal(buffered.text, 'body');
    assert.equal(buffered.headers.get('X-Late'), 'yes');
  });

  test('a script that sets a status before failing keeps it', async () => {
    await site({ '/guard.php': '<?php http_response_code(403); no_such_function_at_all();' });
    assert.equal((await serve({ url: '/guard.php', docroot: DOCROOT })).status, 403);
  });
});

// ─── re-entrancy, the reason this SAPI exists ────────────────────────────────

describe('repeated requests', opts, () => {
  test('200 requests on one instance, all correct', async () => {
    await site({ '/n.php': '<?php echo $_GET["n"] * 2;' });

    for (let i = 1; i <= 200; i++) {
      const r = await serve({ url: `/n.php?n=${i}`, docroot: DOCROOT });
      assert.equal(r.text, String(i * 2), `request ${i}`);
      assert.equal(r.status, 200, `request ${i}`);
    }
  });

  test('does not leak file descriptors across requests', async () => {
    const mod = await sharedModule();
    const live = () => mod.FS.streams.filter(Boolean).length;
    await site({ '/fd.php': '<?php echo 1;' });

    await serve({ url: '/fd.php', docroot: DOCROOT });
    const before = live();
    for (let i = 0; i < 100; i++) await serve({ url: '/fd.php', docroot: DOCROOT });

    assert.equal(live(), before, `open descriptors went from ${before} to ${live()}`);
  });

  test('one request does not carry into the next', async () => {
    await site({
      '/set.php': '<?php header("X-Once: yes"); $GLOBALS["leak"] = 1; echo "set";',
      '/read.php': '<?php echo json_encode(['
        + 'isset($GLOBALS["leak"]), $_GET, $_POST, $_COOKIE,'
        + 'file_get_contents("php://input")]);',
    });

    await serve({
      url: '/set.php?a=1',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: 'c=1' },
      body: 'p=1',
      docroot: DOCROOT,
    });
    const r = await serve({ url: '/read.php', docroot: DOCROOT });

    assert.equal(r.text, '[false,[],[],[],""]');
    assert.equal(r.headers.get('X-Once'), null, 'a header outlived its request');
  });

  // The two modes share one module, one filesystem and one set of hooks, and
  // the hooks are swapped per request — so a request must leave the command
  // path exactly as it found it.
  test('requests and commands interleave without disturbing each other', async () => {
    await site({ '/mix.php': '<?php echo "served";' });

    assert.equal((await evalPhp('echo "before";')).stdout, 'before');
    assert.equal((await serve({ url: '/mix.php', docroot: DOCROOT })).text, 'served');

    const after = await evalPhp('echo "after";');
    assert.equal(after.stdout, 'after', 'stdout did not go back to the command path');
    assert.equal(after.exitCode, 0);

    const fatal = await evalPhp('no_such_function_at_all();');
    assert.match(fatal.stderr, /no_such_function_at_all/, 'errors stopped reaching stderr');
  });

  test('a fatal request does not poison the next one', async () => {
    await site({ '/boom.php': '<?php no_such_function_at_all();', '/ok.php': '<?php echo "fine";' });

    assert.equal((await serve({ url: '/boom.php', docroot: DOCROOT })).status, 500);
    const r = await serve({ url: '/ok.php', docroot: DOCROOT });
    assert.equal(r.status, 200);
    assert.equal(r.text, 'fine');
  });

  // A request's cookies live in the header buffer the caller frees on return,
  // and sapi_activate() only re-reads cookies for something with a server
  // context — which no command has. So a stale pointer is not overwritten by
  // the next call, it is parsed: $_COOKIE in a command was being built from
  // freed memory, and printed whatever the allocator had put there since.
  test('a request does not leave its cookies in the next command', async () => {
    await site({ '/cookie.php': '<?php echo $_COOKIE["session"] ?? "none";' });

    const served = await serve({
      url: '/cookie.php',
      docroot: DOCROOT,
      headers: { Cookie: 'session=secret-from-the-request' },
    });
    assert.equal(served.text, 'secret-from-the-request');

    const command = await evalPhp('echo count($_COOKIE), ":", json_encode($_COOKIE);');
    assert.equal(command.stdout, '0:[]', 'a command inherited the request\'s cookies');
  });

  // sapi_activate() is where a status would normally be cleared, and the line
  // that does it is commented out upstream — so a request's status stayed set
  // and the next command answered http_response_code() with it. A command has
  // no status of its own; false is the right answer.
  test('a request\'s status does not carry into the next command', async () => {
    await site({ '/gone.php': '<?php http_response_code(404); echo "missing";' });

    assert.equal((await evalPhp('var_export(http_response_code());')).stdout, 'false');
    assert.equal((await serve({ url: '/gone.php', docroot: DOCROOT })).status, 404);

    const after = await evalPhp('var_export(http_response_code());');
    assert.equal(after.stdout, 'false', 'a command inherited the request\'s status');
  });

  // A session is the first thing in server mode that needs both halves of the
  // SAPI in one request: the Cookie header on the way in, and a Set-Cookie
  // through the send_headers hook on the way out. It is also where a
  // re-entrant SAPI would show a leak most plainly — a third request with no
  // cookie must start over, not inherit the session the other two share.
  test('a session survives from one request to the next', async () => {
    await site({
      '/counter.php':
        '<?php @mkdir("/sess"); ini_set("session.save_path", "/sess");'
        + 'session_start(); $_SESSION["n"] = ($_SESSION["n"] ?? 0) + 1; echo $_SESSION["n"];',
    });

    const first = await serve({ url: '/counter.php', docroot: DOCROOT });
    assert.equal(first.text, '1');

    const [setCookie] = first.headers.getSetCookie();
    assert.match(setCookie ?? '', /^PHPSESSID=/, 'session_start() sent no session cookie');
    const cookie = setCookie.split(';')[0];

    const second = await serve({ url: '/counter.php', docroot: DOCROOT, headers: { Cookie: cookie } });
    assert.equal(second.text, '2', 'the session did not come back with the cookie');

    const stranger = await serve({ url: '/counter.php', docroot: DOCROOT });
    assert.equal(stranger.text, '1', 'a request with no cookie inherited someone else\'s session');
  });

  // do_cli() sets SAPI_OPTION_NO_CHDIR for the CLI and nothing clears it, so
  // whether a request ran in the script's directory used to depend on whether
  // any command had ever run on the instance.
  // A request has more to abandon than a command does: the response hooks are
  // swapped in for its duration, and the struct they read is a local of the
  // frame the trap destroyed. Left installed, every later *command* would write
  // its output into a response buffer nobody reads — the shell would see `php`
  // print nothing at all, with no error to explain it.
  test('a request that traps does not take the instance with it', async () => {
    await site({
      '/fine.php': '<?php echo "fine";',
      // Deep enough to exhaust the JS engine's wasm frame stack. unserialize()
      // rather than the json_encode() this used to be, because the recursion
      // guard now turns that one into an ordinary error; see sapi.test.mjs for
      // why this parser is the one left and why the depth is far past the cliff
      // rather than near it.
      '/trap.php': '<?php $s = str_repeat("a:1:{i:0;", 20000) . "i:1;"'
        + ' . str_repeat("}", 20000); unserialize($s, ["max_depth" => 0]);',
    });

    const mod = await sharedModule();
    assert.throws(
      () => mod.phasmHandleRequest({ url: '/trap.php', docroot: DOCROOT }),
      RangeError,
    );

    const after = await serve({ url: '/fine.php', docroot: DOCROOT });
    assert.equal(after.status, 200);
    assert.equal(after.text, 'fine');
    assert.equal(after.stderr, '', 'the abandoned request left warnings behind');

    // And the hooks went back, so a command still reaches the shell's stdout.
    const command = await evalPhp('echo "command after a trapped request";');
    assert.equal(command.stdout, 'command after a trapped request');
    assert.equal(command.stderr, '');
  });

  test('runs in the script directory whatever ran before it', async () => {
    await site({ '/deep/where.php': '<?php echo getcwd();' });

    await evalPhp('echo 1;');
    const r = await serve({ url: '/deep/where.php', docroot: DOCROOT });

    assert.equal(r.text, `${DOCROOT}/deep`);
  });
});

// ─── what a refused request costs ────────────────────────────────────────────

describe('a request that never runs', opts, () => {
  /**
   * The address _malloc() hands back for a fixed size, with the block given
   * straight back. dlmalloc is deterministic, so two probes either side of a
   * refused request agree exactly when the refusal freed everything it took —
   * and differ by whatever it kept. The leak has no other symptom: five short
   * strings per request is invisible until a service worker has retried a
   * malformed one a few thousand times.
   */
  function heapProbe(mod) {
    const p = mod._malloc(64);
    mod._free(p);
    return p;
  }

  // A fresh instance on purpose: on a warm one the leaked blocks are handed
  // out of holes the suite's earlier requests left behind, so the probe reads
  // the same address either way and the measurement says nothing.
  test('an argument mistake leaves nothing allocated', async () => {
    const mod = await freshModule();

    heapProbe(mod); // settle the freelist before measuring it
    const before = heapProbe(mod);

    assert.throws(
      () => mod.phasmHandleRequest({
        method: 'POST',
        url: '/x.php',
        headers: { 'content-type': 'text/plain' },
        body: 12345,
      }),
      TypeError,
    );

    assert.equal(heapProbe(mod), before, 'the refused request kept part of the heap');
  });

  test('a body there is no room for is refused, not passed on as none', async () => {
    const mod = await freshModule();
    mod.FS.writeFile('/still.php', '<?php echo "still here";');

    // Past the module's maximum memory, so _malloc answers 0. The copy into
    // the heap was already guarded on that; the length was not, so PHP read
    // php://input from address 0 with a correct Content-Length. The array is
    // 2 GiB of address space and ~0.3 MB resident — nothing writes to it.
    const body = new Uint8Array(2 ** 31 - 1);

    assert.throws(
      () => mod.phasmHandleRequest({ method: 'POST', url: '/x.php', body }),
      /no room for a 2147483647-byte request body/,
    );

    // And the refusal did not take the instance with it.
    const r = mod.phasmHandleRequest({ url: '/still.php' });
    assert.equal(r.status, 200);
    assert.equal(new TextDecoder().decode(r.body), 'still here');
  });
});

// ─── the cooperative interrupt ───────────────────────────────────────────────

describe('a request that will not finish', opts, () => {
  test('is stopped, and the fetch behind it still gets an answer', async () => {
    let polls = 0;
    const res = await serve({
      url: '/hang.php',
      files: { '/hang.php': '<?php echo "started"; while (true) {}' },
      interrupted: () => ++polls > 20,
      fresh: true,
    });

    // 500 rather than nothing: a handler that hangs is a fetch the page is
    // holding open, so the point of stopping it is that a reply arrives.
    assert.equal(res.status, 500);
    assert.match(res.stderr, /Fatal error: Interrupted/);
  });

  // The window on the other side of the script: a ^C that lands while PHP is
  // running register_shutdown_function() callbacks and destructors. There is
  // nothing left to cancel there — the work the user asked to stop is over —
  // and interrupting it truncates the one teardown the request gets. On this
  // path that is SILENT: the status was settled by a script that finished
  // successfully, so the answer is a 200 with a short body and no error
  // anywhere, which is worse than any ^C that did nothing.
  test('a ^C during the shutdown does not truncate the response', async () => {
    const mod = await freshModule();
    const dec = new TextDecoder();
    // The shutdown function arms the ^C itself, on its first line and through a
    // NOTICE — which this SAPI sends to stderr, so it reaches the sink below
    // while the loop after it is still to run, and it is not part of the
    // response. (STDERR the constant is the CLI's; a request never registers
    // it, and reaching for it here silently ended the shutdown function.)
    // Arming from the outside instead fires during compilation and tests the
    // script, which is the window this is NOT about.
    mod.FS.writeFile('/late.php', '<?php register_shutdown_function(function () {'
      + ' trigger_error("TAIL-START", E_USER_NOTICE);'
      + ' for ($i = 0; $i < 200000; $i++) {}'
      + ' echo "TAIL-END"; });'
      + ' echo "BODY";');

    const whole = mod.phasmCapture(() => mod.phasmHandleRequest({ url: '/late.php' }));
    assert.equal(dec.decode(whole.value.body), 'BODYTAIL-END', 'the control');

    let polls = 0;
    let pollsWhenArmed = null;
    const stopped = mod.phasmCapture(() => mod.phasmHandleRequest({
      url: '/late.php',
      interrupted: () => { polls++; return pollsWhenArmed !== null; },
    }), {
      collect: false,
      onOutput: (bytes) => {
        if (pollsWhenArmed === null && dec.decode(bytes).includes('TAIL-START')) {
          pollsWhenArmed = polls;
        }
      },
    });

    assert.equal(stopped.value.status, 200);
    assert.equal(dec.decode(stopped.value.body), 'BODYTAIL-END',
      'a fatal raised inside the shutdown would have left this at "BODY", with a 200 over it');
    assert.notEqual(pollsWhenArmed, null, 'the shutdown function never ran');
    assert.equal(polls, pollsWhenArmed,
      'the poll is dropped when the shutdown starts, rather than asked and ignored');
  });

  test('the instance serves the next request as if nothing happened', async () => {
    const mod = await freshModule();
    mod.FS.writeFile('/hang.php', '<?php while (true) {}');
    mod.FS.writeFile('/ok.php', '<?php echo "fine";');

    mod.phasmCapture(() => mod.phasmHandleRequest({ url: '/hang.php', interrupted: () => true }));

    const r = mod.phasmHandleRequest({ url: '/ok.php' });
    assert.equal(r.status, 200);
    assert.equal(new TextDecoder().decode(r.body), 'fine');
  });
});

// ─── the docroot, and what a command leaves in the response ──────────────────

describe('the docroot', opts, () => {
  test('a relative one resolves the same way twice', async () => {
    const mod = await freshModule();
    mod.FS.mkdir('/site');
    mod.FS.writeFile('/site/index.php', '<?php echo "served from ", getcwd();');

    // Resolution stat()s docroot + path against the caller's directory, and the
    // chdir() into the docroot happens much later — so a relative name used to
    // be resolved against two different directories in one request, and a
    // script phasm had just confirmed exists 500'd as missing.
    const r = mod.phasmCapture(() => mod.phasmHandleRequest({ url: '/index.php', docroot: 'site' }));

    assert.equal(r.value.status, 200, r.stderr);
    assert.equal(new TextDecoder().decode(r.value.body), 'served from /site');
  });

  test('and DOCUMENT_ROOT is the absolute one', async () => {
    const mod = await freshModule();
    mod.FS.mkdir('/site');
    mod.FS.writeFile('/site/i.php', '<?php echo $_SERVER["DOCUMENT_ROOT"], " ", $_SERVER["SCRIPT_NAME"];');

    const r = mod.phasmHandleRequest({ url: '/i.php', docroot: 'site' });

    assert.equal(new TextDecoder().decode(r.body), '/site /i.php');
  });
});

describe('the response accessors', opts, () => {
  // The JS API reads these only where it has just made a request, so this is
  // about the wasm exports themselves — which are an entry point of their own,
  // and the only way a caller reaching the module directly can ask.
  test('a command clears the response a request left behind', async () => {
    const mod = await freshModule();
    mod.FS.writeFile('/hi.php', '<?php header("X-From: request"); echo "a page";');

    mod.phasmHandleRequest({ url: '/hi.php' });
    assert.equal(mod._phasm_response_status(), 200);
    assert.equal(mod._phasm_response_body_length(), 6);

    mod.run({ code: 'echo "a command";' });

    assert.equal(mod._phasm_response_status(), 0, 'a command has no status of its own');
    assert.equal(mod._phasm_response_body_length(), 0);
    assert.equal(mod.UTF8ToString(mod._phasm_response_headers()), '');
  });
});

describe('the standard descriptors', opts, () => {
  // The reclaim window starts at dup()'s answer, which is the lowest FREE
  // descriptor — so a call that starts with one of 0/1/2 already closed gets a
  // mark inside the standard range, reaches a standard descriptor, and compares
  // it against its own stat. It matches by definition, and the descriptor is
  // closed.
  test('a call does not close one because another is missing', async () => {
    const mod = await freshModule();
    mod.phasmRun(['-r', 'echo 1;']);

    mod.FS.close(mod.FS.streams[1]);
    assert.ok(mod.FS.streams[2], 'stderr should still be open before the call');

    mod.phasmRun(['-r', 'echo 2;']);

    assert.ok(mod.FS.streams[2], 'the call closed the instance\'s real stderr');
    assert.ok(mod.FS.streams[0], 'and stdin with it');
  });
});

// ─── the shape a caller actually has ─────────────────────────────────────────

describe('headers as the web platform hands them over', opts, () => {
  // The docs say a service worker can pass `request.headers` straight in, and
  // it could not: a Headers has no own enumerable keys, so Object.entries()
  // returned [] and the request reached PHP with none of them. Nothing failed —
  // a POST simply arrived with no Content-Type, so $_POST was empty and the
  // form did nothing, and with no Cookie, so session_start() opened a new
  // session every time.
  test('a Headers reaches php, not an empty list', async () => {
    const r = await serve({
      url: '/h.php',
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/x-www-form-urlencoded', 'x-note': 'kept' }),
      body: 'who=world',
      files: { '/h.php': '<?php echo $_POST["who"], "|", $_SERVER["HTTP_X_NOTE"];' },
    });
    assert.equal(r.status, 200, r.stderr);
    assert.equal(r.text, 'world|kept');
  });

  test('a Map and an array of pairs work the same way', async () => {
    const files = { '/h.php': '<?php echo $_SERVER["HTTP_X_NOTE"];' };
    const asMap = await serve({ url: '/h.php', headers: new Map([['x-note', 'map']]), files });
    assert.equal(asMap.text, 'map', asMap.stderr);
    const asPairs = await serve({ url: '/h.php', headers: [['x-note', 'pairs']], files });
    assert.equal(asPairs.text, 'pairs', asPairs.stderr);
  });

  // Repeats are why HTTP headers are pairs and not a map, and the pair form is
  // the only one that can carry them. Keeping the last dropped every cookie
  // but one, which is a session that will not stay logged in — and Cookie is
  // the header that really does arrive split, since HTTP/2 may send each one
  // as its own field line. RFC 6265 says to rejoin with '; '.
  test('a repeated Cookie is one cookie jar, not the last line', async () => {
    const r = await serve({
      url: '/h.php',
      headers: [['cookie', 'a=1'], ['cookie', 'b=2']],
      files: { '/h.php': '<?php echo implode(",", array_keys($_COOKIE));' },
    });
    assert.equal(r.text, 'a,b', r.stderr);
  });

  // Everything else joins with ', ', which is HTTP's general rule and what
  // $_SERVER's HTTP_* entries hold under every other SAPI.
  test('any other repeated header is joined, not resolved', async () => {
    const r = await serve({
      url: '/h.php',
      headers: [['x-note', 'one'], ['x-other', 'kept'], ['x-note', 'two']],
      files: { '/h.php': '<?php echo $_SERVER["HTTP_X_NOTE"], "|", $_SERVER["HTTP_X_OTHER"];' },
    });
    assert.equal(r.text, 'one, two|kept', r.stderr);
  });

  test('a plain object is still a plain object', async () => {
    const r = await serve({
      url: '/h.php',
      headers: { 'x-note': 'object' },
      files: { '/h.php': '<?php echo $_SERVER["HTTP_X_NOTE"];' },
    });
    assert.equal(r.text, 'object', r.stderr);
  });

  // A string is iterable, and spreading one yields single characters — a
  // header per letter rather than an error.
  test('a string is refused rather than spread into characters', async () => {
    const mod = await freshModule();
    assert.throws(
      () => mod.phasmHandleRequest({ url: '/x.php', headers: 'x-note: no' }),
      /must be an object, a Headers, a Map or an array of pairs/,
    );
  });
});
