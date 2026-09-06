// SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>
//
// SPDX-License-Identifier: ISC

/**
 * The CGI router, as a pure function of a URL and a filesystem.
 *
 * This is `sapi/phasm/phasm.c`'s "resolving the script" — docroot join,
 * directory index, `PATH_INFO` split, front-controller fallback, deployment
 * prefix, and the decline — with nothing of PHP in it, because there never was
 * any. It is `try_files` written down.
 *
 * **It is a port, not a design.** The C is the specification: every rule below
 * was reasoned about once, in a comment, usually because getting it wrong was
 * a source disclosure rather than a 404. `test/resolve-oracle.test.mjs` drives
 * this and the real SAPI over one corpus and asserts they agree, which is the
 * only reason to trust a second implementation of security-shaped code. Change
 * a rule here and that test is what tells you the C no longer agrees.
 *
 * ## Why it can move out of the SAPI at all
 *
 * Resolution needs `stat()` against a filesystem, and a service worker has
 * none — which is the argument that put it in C. What it actually proves is
 * that the router must run where a filesystem is reachable synchronously, and
 * a host builtin is such a place: `wide`'s file wire already does 646 lines
 * of work over one with no runtime involved.
 *
 * **Which filesystem is the whole question, and the answer is the runtime's.**
 * `ctx.fs` — the shell's view — is the tempting one and is wrong: it is the
 * runtime's tree only where an embedder mounted one store into both, and where
 * PHP owns its own MEMFS while the shell merely carries requests, resolving
 * over it means routing against a tree the runtime cannot see. Resolving over
 * the filesystem the runtime will open the script from is correct in every
 * arrangement, which is why this function takes a probe and its caller builds
 * one from the runtime rather than from `ctx`.
 *
 * @module
 */

/** POSIX mode bits, which is what the `fs` contract's `InodeLike.mode` holds. */
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;

/**
 * What the resolver asks of a filesystem, whole: two questions, both about a
 * path it already has.
 *
 * Taking a probe rather than a filesystem is not indirection for its own sake.
 * The two shapes this has to run against are genuinely different — `ctx.fs` in
 * a `wasi-sh` builtin answers `stat()` with `{type: 'file'|'dir'}`, while the
 * `fs` contract and Emscripten's `FS` answer with POSIX mode bits — and a
 * resolver that named one of them would need the other adapted at every call
 * site. Naming what it actually needs costs two adapters, below, and lets a
 * caller with neither shape supply two functions.
 *
 * @typedef {{isFile(path: string): boolean, isDir(path: string): boolean}} Probe
 */

/**
 * A {@link Probe} over a store in `wasi-sh`'s `fs` contract shape — which is
 * also Emscripten's `FS` and ZenFS's `FileSystem`, since all three report mode
 * bits. A throw is read as "nothing there", which is what every one of them
 * does for a missing path.
 */
export function inodeProbe(store) {
  const type = (path) => {
    try {
      return store.statSync(path).mode & S_IFMT;
    } catch {
      return 0;
    }
  };
  return {
    isFile: (path) => type(path) === S_IFREG,
    isDir: (path) => type(path) === S_IFDIR,
  };
}

/**
 * A {@link Probe} over `ctx.fs`, the filesystem a `wasi-sh` host builtin is
 * handed. It answers `null` rather than throwing.
 *
 * **Nothing in this package routes over it, and that is the point of keeping
 * it.** `ctx.fs` is the SHELL's view, which is the runtime's only where an
 * embedder mounted one store into both — so `serve.mjs` resolves over the
 * runtime's own filesystem instead, and has no precondition to state. This is
 * here for an embedder that genuinely wants to route over the shell's tree and
 * knows why; `test/resolve-oracle.test.mjs` pins that it answers alike.
 */
export function hostFsProbe(fs) {
  return {
    isFile: (path) => fs.stat(path)?.type === 'file',
    isDir: (path) => fs.stat(path)?.type === 'dir',
  };
}

/**
 * The status that means "not mine — serve this path yourself". Not an error.
 * It is spelled out here rather than imported from wherever else it is spelled,
 * because this module is deliberately runtime-free and one shared constant would
 * tie it to something for four characters.
 */
export const DECLINE = 0;

/**
 * A path is refused rather than normalised if it can climb: this runs against
 * the embedder's whole filesystem, and `%2e%2e/` is the oldest trick there is.
 * Decoding happens first, so the check sees what the lookup will use.
 */
function escapes(path) {
  let at = 0;
  for (;;) {
    const found = path.indexOf('..', at);
    if (found < 0) return false;
    const atStart = found === 0 || path[found - 1] === '/';
    const atEnd = found + 2 === path.length || path[found + 2] === '/';
    if (atStart && atEnd) return true;
    at = found + 2;
  }
}

/**
 * Collapse `//` and `/./`; the result is never longer than the input. `..`
 * never reaches here — `escapes()` refuses it above — so this cannot climb, it
 * only makes two spellings of one path into one.
 *
 * It matters because `SCRIPT_NAME` and `PHP_SELF` are what a router strips its
 * own prefix from, and `//i.php` arriving at a route table as a different
 * string from `/i.php` is a routing bug the request looks innocent in. A
 * trailing slash is deliberately kept: `/i.php/` is not a request for
 * `/i.php`, and turning it into one would serve a script for a path that was
 * never asked for.
 */
function normalize(path) {
  let out = '';
  let i = 0;
  while (i < path.length) {
    if (path[i] !== '/') {
      out += path[i++];
      continue;
    }
    out += '/';
    i++;
    // Everything after this slash that means "still the same directory".
    for (;;) {
      if (path[i] === '/') {
        i++;
      } else if (path[i] === '.' && (path[i + 1] === '/' || i + 1 === path.length)) {
        i += path[i + 1] === '/' ? 2 : 1;
      } else {
        break;
      }
    }
  }
  return out;
}

/**
 * Case-insensitively, as `php_cli_server.c` does. Getting this wrong is not a
 * missing feature: a case-sensitive match declines `/A.PHP`, and declining
 * means "not a script, embedder — serve it as a static file", so the answer to
 * the request is the PHP source.
 */
function hasPhpSuffix(path) {
  return path.length >= 4 && path.slice(-4).toLowerCase() === '.php';
}

/**
 * `php_raw_url_decode`, byte-exact: `%XX` only, and `+` left alone — it means a
 * plus in a path and a space only in a query string, so decoding `/my+app.php`
 * to `/my app.php` would 404 a file that is right there.
 *
 * Returns the decoded bytes rather than a string, because an encoded NUL has
 * to be detectable: in C it truncates every string that follows it, and the
 * caller refuses the request over it. The UTF-8 decode happens after that
 * check, so a `%00` is caught as a byte and never as a lost character.
 */
function rawUrlDecode(path) {
  const bytes = [];
  for (let i = 0; i < path.length; i++) {
    const c = path[i];
    if (c === '%' && i + 2 < path.length) {
      const hex = path.slice(i + 1, i + 3);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    // Everything else goes through as its UTF-8 bytes, which is what the
    // browser would have sent and what the C had in the buffer already.
    for (const b of new TextEncoder().encode(c)) bytes.push(b);
  }
  return Uint8Array.from(bytes);
}

/**
 * The CGI split: `/index.php/users/1` is `index.php` run with
 * `PATH_INFO=/users/1`.
 *
 * Right to left, so the DEEPEST existing script wins: `/a.php/b.php` is
 * `b.php`'s request when `b.php` is there and `a.php`'s when it is not, which
 * is what every other CGI-shaped SAPI answers.
 *
 * **The direction cannot actually be observed, and that is worth knowing
 * before anyone "simplifies" it.** At most one prefix of a path can be a
 * regular file, because every shorter prefix has to be a directory to contain
 * it — Emscripten answers EEXIST and ENOTDIR to the tree that would break the
 * tie, and so does POSIX. A left-to-right walk returns the same answer on
 * every store this can run against; the mutation was tried against the oracle
 * and passed. It stays right-to-left because the C is right-to-left and this
 * is a port, and because a store that DID allow both would be pathological in
 * a way this is not the place to discover.
 *
 * The prefix has to be a PHP script and not merely a file. A `.css` with a
 * component after it is a 404 rather than a decline, deliberately: declining
 * tells the embedder "serve this path yourself", and the path it would be
 * handed is the one with the extra component still on it — a file that does
 * not exist. Declining a path nobody can serve is the shape that turns into a
 * source disclosure one refactor later, so this stays narrow.
 *
 * @returns {number} the length of the script prefix within `script`, or 0
 */
function splitPathInfo(probe, script, drootLen) {
  let cut = script.length;
  while (cut > drootLen + 1) {
    cut--;
    if (script[cut] !== '/') continue;
    const candidate = script.slice(0, cut);
    if (probe.isFile(candidate) && hasPhpSuffix(candidate)) return cut;
  }
  return 0;
}

/**
 * Resolve one request target against a filesystem.
 *
 * @param {string} uri the request target, path and query — e.g. `/blog/?page=2`
 * @param {Probe} probe two predicates over the filesystem the RUNTIME will
 *   see; {@link hostFsProbe} and {@link inodeProbe} build one
 * @param {{docroot?: string, fallback?: string, prefix?: string, cwd?: string}} [options]
 * @returns {{status: number, script?: string, scriptName?: string,
 *   pathInfo?: string, pathTranslated?: string, uri?: string, phpSelf?: string,
 *   query?: string, docroot?: string}}
 *   `status` is **200** when the request resolved to a script to run,
 *   **0** to decline — the path is something the embedder should serve itself —
 *   and 400/403/404/500 for a refusal, exactly as the SAPI answers them.
 */
export function resolveRequest(uri, probe, options = {}) {
  let { docroot = '/', fallback, prefix, cwd = '/' } = options;

  if (typeof uri !== 'string' || typeof docroot !== 'string') return { status: 500 };

  // A relative docroot is made absolute BEFORE it is used for anything. The
  // resolution below joins docroot + path, and the runtime chdir()s to the
  // docroot afterwards — so a relative name resolved against two different
  // directories is one request disagreeing with itself.
  if (docroot[0] !== '/') {
    const sep = cwd.endsWith('/') ? '' : '/';
    docroot = `${cwd}${sep}${docroot}`;
  }

  // Split the target, then decode only the path: a '?' inside an encoded path
  // segment must not start the query string, and decoding the query here would
  // destroy the '&' and '=' that $_GET is parsed from.
  const q = uri.indexOf('?');
  const query = q < 0 ? undefined : uri.slice(q + 1);
  const rawPath = q < 0 ? uri : uri.slice(0, q);
  const decoded = rawUrlDecode(rawPath);

  // The front controller, validated for SHAPE before anything is served — not
  // at the 404 where it is first needed. A misspelled one is a configuration
  // mistake, and a configuration mistake that only shows up on the paths that
  // were already failing is one nobody attributes correctly: every route 404s
  // and the fallback looks like it is simply not working.
  //
  // Shape only. Whether the file EXISTS is deliberately not checked here — see
  // the fallback site below, where Apache's answer for a missing
  // FallbackResource is the one taken.
  if (fallback === '') fallback = undefined;
  if (fallback !== undefined
    && (fallback[0] !== '/' || escapes(fallback) || !hasPhpSuffix(fallback))) {
    return { status: 500 };
  }

  // Where the site is mounted in the browser's URL space, put back. No
  // trailing slash, because SCRIPT_NAME is built as prefix + a path that
  // already starts with one; refusing that rather than trimming it keeps one
  // spelling of the setting.
  if (prefix === '') prefix = undefined;
  if (prefix !== undefined
    && (prefix[0] !== '/' || prefix.endsWith('/') || escapes(prefix) || prefix.includes('?'))) {
    return { status: 500 };
  }
  const prefixStr = prefix ?? '';

  // An encoded NUL truncates every C string that follows it, so the checks
  // below would inspect a prefix while something else acted on the whole thing.
  // Refusing outright is the only version of this that stays true as the code
  // around it changes.
  if (decoded.includes(0)) return { status: 400 };

  let path = new TextDecoder().decode(decoded);

  if (path[0] !== '/' || escapes(path)) return { status: 403 };

  // Only after the refusal above, so normalisation can never be the thing that
  // hides a climb.
  path = normalize(path);

  // A trailing slash on the docroot would produce "//" here, which is a
  // different path to opcache and to include_once.
  let drootLen = docroot.length;
  while (drootLen > 0 && docroot[drootLen - 1] === '/') drootLen--;
  const droot = docroot.slice(0, drootLen);

  let script = droot + path;
  let pathInfo;

  if (probe.isDir(script)) {
    script = `${script.endsWith('/') ? script.slice(0, -1) : script}/index.php`;
    // A directory with no index.php is not a PHP request, and saying 404 here
    // makes it unreachable rather than merely not ours: the embedder can serve
    // the index.html sitting right beside it, but only if it is handed the
    // request back.
    if (!probe.isFile(script)) return { status: DECLINE };
  } else if (path.endsWith('/')) {
    // A trailing slash asks for a directory, and POSIX answers ENOTDIR when
    // the name resolves to a file. Emscripten's stat() answers for the file
    // anyway, so "/app.php/" would reach the suffix check, fail it on the
    // slash, and be DECLINED — which tells the embedder to serve /app.php as a
    // static file, i.e. to hand out the source. 404 is both the POSIX answer
    // and the safe one.
    return { status: 404 };
  }

  if (!probe.isFile(script)) {
    // Nothing at that path — but a script may be sitting part of the way along
    // it, with the rest addressed to the script rather than to the filesystem.
    const cut = splitPathInfo(probe, script, drootLen);

    if (cut === 0) {
      // Nothing at that path and nothing along it — which for a framework is
      // the ordinary case, not the error one.
      //
      // The shape is nginx's, which is what Laravel's own documented config
      // produces: REQUEST_URI stays exactly what was asked for, SCRIPT_NAME
      // becomes the front controller, and there is **no PATH_INFO** — the app
      // derives its route from the URI it can see. Setting it to the unmatched
      // path would give Symfony's base-URL detection two disagreeing answers.
      //
      // The rule this draws is the one a reader will test: **a decline is not
      // a miss.** A `.css` that is there, and a directory with no index.php,
      // both still decline above — "there is something here, it just is not
      // PHP" — and the embedder serves them exactly as before. The front
      // controller takes only the paths where there is *nothing*.
      if (fallback === undefined) return { status: 404 };

      script = droot + fallback;

      // A configured front controller that is not there is Apache's case, and
      // Apache 404s the request rather than 500ing the server. The shape check
      // at the top is what catches the mistake worth catching; this is a file
      // that was deleted.
      if (!probe.isFile(script)) return { status: 404 };
      pathInfo = undefined;
    } else {
      // `script` is docroot + path, so an offset in one is an offset in the
      // other once the docroot is taken off. `path` itself is left whole:
      // scriptName + pathInfo is exactly it, which is what PHP_SELF is.
      pathInfo = path.slice(cut - drootLen);
      script = script.slice(0, cut);
    }
  }

  // Not ours — and the decline NAMES the file, which the C had no way to do:
  // it answers a single int. A caller that has to serve the file itself, as
  // anything embedding a filesystem the network has never heard of does, would
  // otherwise re-resolve the path to find out which file was meant.
  //
  // Only here, and that is the distinction worth keeping: the other decline is
  // a directory with no index.php, where there is no one file to name and the
  // embedder is choosing among whatever is in there.
  if (!hasPhpSuffix(script)) return { status: DECLINE, script };

  // SCRIPT_NAME is the resolved script's own path, which is `path` except
  // where index.php was appended to a directory or path info was taken off the
  // end — and a router that reads it to strip its own prefix needs the
  // difference.
  const scriptName = prefixStr + script.slice(drootLen);

  // PATH_TRANSLATED is the path info resolved against the DOCROOT, which is
  // CGI's meaning of it and not the script's own filename. It names a file
  // that need not exist; that is the caller's business, not ours.
  const pathTranslated = pathInfo === undefined ? undefined : droot + pathInfo;

  return {
    status: 200,
    script,
    scriptName,
    pathInfo,
    pathTranslated,
    query,
    docroot: droot,
    uri: prefixStr + uri,
    // scriptName + pathInfo is `path`, exactly — the two were cut out of it —
    // so with no prefix PHP_SELF needs no third string built for it.
    phpSelf: pathInfo === undefined ? scriptName : prefixStr + path,
  };
}

export default resolveRequest;
