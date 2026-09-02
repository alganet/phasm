<!--
SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>

SPDX-License-Identifier: ISC
-->

# phasm

PHP 8.5 compiled to WebAssembly. Run PHP in the browser or in Node.js.

    npm install @alganet/phasm

## Included Extensions

calendar, ctype, dom, fileinfo, filter, iconv, libxml, mbstring, opcache,
pcntl, pdo, pdo_sqlite, phar, session, simplexml, sqlite3, tokenizer, xml,
xmlwriter, zip, zlib.

Plus PHP's always-on core: Core, date, hash, json, lexbor, pcre, random,
Reflection, SPL, standard, uri.

`get_loaded_extensions()` is the authority; `npm test` asserts this list matches
what the binary actually links, so it cannot drift again.

## Node.js

```js
import Phasm from "@alganet/phasm";

const php = await Phasm();

const { stdout, stderr, exitCode } = php.run({
  script: `<?php echo "Hello from PHP!\\n";`,
});
```

## Browser

```html
<script src="https://unpkg.com/@alganet/phasm/dist/php.js"></script>
<pre id="output"></pre>
<script>
  Phasm().then((php) => {
    const { stdout } = php.run({ code: 'echo "Hello from PHP!";' });
    document.getElementById("output").textContent = stdout;
  });
</script>
```

## TypeScript

Types ship with the package — `Phasm`, `PhasmOptions`, `PhasmModule`, `PhasmFS`,
`PhasmRunOptions`, `PhasmRunResult`, `PhasmRequest` and `PhasmResponse` are all
declared, no `@types` package needed. The subpaths carry their own: `Store` and
`MountOptions` on `@alganet/phasm/mount`.

```ts
import Phasm, { type PhasmModule, type PhasmRunResult } from "@alganet/phasm";

const php: PhasmModule = await Phasm();
const result: PhasmRunResult = php.run({ code: "echo 1;" });
```

## Running PHP

`run()` takes one call's worth of everything and gives back what it produced:

```js
const { stdout, stderr, exitCode } = php.run({
  args: ["app.php", "--verbose"],
  files: { "/project/app.php": '<?php echo getenv("APP_ENV"), $argv[1];' },
  stdin: "piped in",
  cwd: "/project",
  env: { APP_ENV: "dev" },
});
```

| Option       | Description                                                          |
|--------------|----------------------------------------------------------------------|
| `args`       | argv after argv[0]. Wins over `code` and `script`.                   |
| `code`       | A snippet, as `-r` — no `<?php` tag.                                 |
| `script`     | PHP source, mounted at `/main.php` and run.                          |
| `files`      | Written first; missing directories are created.                      |
| `stdin`      | Text, bytes, or a function pulled from as PHP reads.                 |
| `cwd`, `env` | This call only.                                                      |
| `onOutput`   | `(bytes, channel)` as output happens, for streaming.                 |
| `collect`    | `false` to skip buffering when `onOutput` already has the bytes.     |

`onOutput` gets each chunk exactly once, and throwing from it is how a sink
refuses: the write fails for PHP, which normally ends the call, and the error
comes back out of `run()` rather than as a bare non-zero status. That is the
path a shell builtin is on — writing to a device that refuses it — so the
refusal reaches the script instead of looking like output nobody read.

Everything there is per call: `cwd` and `env` are gone by the next one, output
belongs to this call alone, stdin is refilled. The filesystem, the instance and
its ini survive. The options and the `{stdout, stderr, exitCode}` result are
[wasi-sh](https://github.com/alganet/wasi-sh)'s, so a shell run and a PHP run
compose without an adapter between them.

**One instance, many runs.** phasm builds its own SAPI (`sapi/phasm`) rather
than the stock CLI, so each call is a full request without ever exiting the
process: the exit status is per call, errors go to stderr, and a fatal error or
`exit()` leaves the module usable. Booting PHP costs ~70 ms and a warm call
~1 ms, so reuse the instance.

**Runaway recursion is a PHP error, not a crash.** Recursion inside the engine
and its extensions — `json_encode()`, `serialize()`, `var_dump()`, the compiler
— is C recursion, and deep enough it reaches a limit belonging to the JS engine
rather than to PHP. phasm builds PHP with its own `zend.max_allowed_stack_size`
guard, `512K` by default, so those stop with the error each of them already
raises for the case — `json_encode()` returns `false` with `JSON_ERROR_DEPTH`,
`serialize()` throws — instead of the call ending from outside PHP. That budget
is a few hundred levels of nesting, far past what real data carries. Raise it,
or pass `-1` to switch the guard off, through
`phasmStartup("zend.max_allowed_stack_size=…")`.

Ordinary PHP recursion is not affected: a function calling itself runs in the
VM, not on the C stack, and goes hundreds of thousands deep.

The guard covers what PHP itself guards, which is not everything — `unserialize()`
with its `max_depth` disabled still gets there, and so does recursion that runs
the module out of memory. Exhausting the stack is the one failure that is not an
exit status: there is no PHP error left to raise, so the call **throws** rather
than returning. Catch it if the call site cares — the instance itself survives,
because the abandoned request is finished before the error reaches you.

Underneath, `phasmRun(args, opts)` returns the status and leaves output wherever
the module's stdio points — reach for it when you are routing stdio yourself,
and for anything else `phasmCapture(fn)` collects around a call `run()` does not
cover. `callMain()` is still there and still one-shot: it re-enters the CLI's
`main()`, which ends in `exit()`. Pick one entry point per module; they cannot
be mixed, and each refuses the call rather than leaving you with a dead
instance.

## Configuration

`Phasm()` is a factory function that accepts standard [Emscripten Module](https://emscripten.org/docs/api_reference/module.html)
options and returns a promise that resolves to the initialized module:

| Option           | Description                                             |
|------------------|---------------------------------------------------------|
| `arguments`      | Default CLI arguments for a bare `callMain()`.          |
| `print(text)`    | Callback for stdout produced outside `run()`.           |
| `printErr(text)` | Callback for stderr produced outside `run()`.           |
| `stdin()`        | Callback to provide stdin input. Return `null` for EOF. |

The module owns its standard streams, which is what lets `run()` return one
call's output rather than a global stream: `print`, `printErr` and `stdin` are
consulted whenever no `run()` is in flight, so they keep behaving as they always
did. Installing your own `FS.init()` sinks still works and still wins — `run()`
then says it cannot capture, rather than reporting that PHP printed nothing.

## Caching compiled scripts

opcache is built in and does nothing until you name a directory for it to cache
into. Two settings, both required, and the directory has to exist before PHP
starts:

```js
const php = await Phasm();
php.FS.mkdir("/cache");
php.phasmStartup("opcache.file_cache=/cache\nopcache.file_cache_only=1");
```

`file_cache_only` is not optional here. opcache normally caches into shared
memory and treats the file cache as a second tier; wasm has no shared memory to
offer it, so without this the accelerator finds no backend and switches itself
off. A file cache is the only mode this build has.

What it buys, over 80 files of ~500 KiB: **first run 31 ms → 10 ms, and every
run after ~13 ms → ~5 ms.** Compiled scripts are ordinary files, so a cache
directory in a [shared or persistent store](#sharing-a-filesystem) survives the
instance that filled it — that is what makes the first number a cold page load
rather than a warm one. Budget for the size: the cache runs several times larger
than the source it was compiled from (3.3 MiB for that 510 KiB).

Entries are keyed by a build id, so a cache is only ever read back by the exact
`php.wasm` that wrote it; a cache built against an older release is ignored, not
mis-read. Sources are validated by timestamp, so **the store has to keep real
mtimes** — against one that reports `0` for everything, nothing is ever cached
and nothing says so. A file is cacheable from the second after it was written,
which is what keeps an edit from being shadowed by the entry compiled from the
version before it; set `opcache.validate_timestamps=0` if a project is genuinely
read-only and you want that check gone.

## As a shell command

`run()` is what a shell needs, and it is deliberately not PHP's own vocabulary —
its options and its result are [wasi-sh](https://github.com/alganet/wasi-sh)'s,
which is why the two compose with almost nothing between them:

```js
const { stdout, stderr, exitCode } = php.run({
  args: ["-r", 'echo getenv("HOME");'],
  cwd: "/site",
  env: { HOME: "/site" },
  collect: false,
  onOutput: (bytes, channel) => channel === "stdout" ? out(bytes) : err(bytes),
});
```

A host builtin over that is about thirty lines, and it comes with pipes,
redirects, `$(…)` and `$?` already working, because by dispatch time the shell
has installed the redirections. What cannot work is anything needing a
*process* — `php &`, `(php x)`, `exec php`, `find -exec php` — because a builtin
is not one. Both guests must share one filesystem: paths are passed through as
typed and nothing is copied. The [shared filesystem](#sharing-a-filesystem)
is one more call.
## Serving HTTP

`phasmHandleRequest()` runs a real PHP request rather than a command, so
`header()`, status codes and the superglobals work as they do under any other
web SAPI — because PHP's own request machinery produces them, rather than them
being filled in afterwards:

```js
const res = php.phasmHandleRequest({
  method: "POST",
  url: "/blog/?page=2",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new TextEncoder().encode("title=hello"),
  docroot: "/site",
});
// { status, headers, body } — body is bytes, so images survive
```

The path resolves under `docroot`, a directory resolves to its `index.php`, and
a missing one is a 404. A status of **0** means the path is not a PHP script:
that is a decline rather than an error, and the caller should serve the file
itself — PHP has no business deciding that a `.css` file is `text/css`.

Resolution stops there: the path names a script or it does not. There is no
`PATH_INFO` split and no front-controller rewrite, so `/users/1` is a 404 rather
than `/index.php` with `PATH_INFO=/users/1`. That is the caller's decision to
make, the same way declining a `.css` file is — a framework that wants every
request to reach one script asks for it directly:

```js
let res = php.phasmHandleRequest({ url, docroot: "/site" });
if (res.status === 404) {
  res = php.phasmHandleRequest({ url: `/index.php?${query}`, docroot: "/site" });
}
```

The shape is the web platform's on purpose, so a service worker can pass a
`Request` almost straight in and build a `Response` almost straight out —
`headers` comes back as `[name, value]` pairs, which `new Headers()` accepts and
which keeps repeated `Set-Cookie` headers intact. Requests and `phasmRun()`
commands share one instance and one filesystem.

One inherited default worth knowing: phasm takes the CLI's `output_buffering=0`,
so the headers are committed as soon as a script echoes anything, and a
`register_shutdown_function()` that calls `header()` after that is too late.
Pass `phasmStartup("output_buffering=4096")` before the first call for the
behaviour php-fpm gives you.

## Virtual Filesystem

Phasm uses Emscripten's virtual filesystem. `run({ files })` writes into it, and
`FS` is there for everything else — it outlives the call, so a script can leave
something behind for the next one:

```js
php.run({ files: { "/data.json": JSON.stringify({ key: "value" }) } });
php.run({ code: 'file_put_contents("/out.txt", file_get_contents("/data.json"));' });

php.FS.readFile("/out.txt", { encoding: "utf8" });
```

See the [Emscripten File System API](https://emscripten.org/docs/api_reference/Filesystem-API.html) for the full reference.

## Sharing a filesystem

That filesystem is phasm's own, which stops being enough the moment something
else — a shell, an editor, a service worker — has to see the same project.
`mountStore()` hands ownership over: the store stays outside and JS-owned, and
PHP reads and writes through it.

```js
import Phasm from "@alganet/phasm";
import { mountStore } from "@alganet/phasm/mount";
import { memoryFs } from "wasi-sh/fs";

const store = memoryFs({ "/app/index.php": '<?php echo "hi";' });
const php = await Phasm();
await mountStore(php, store, { path: "/app" });

php.run({ args: ["/app/index.php"] }).stdout; // 'hi'
```

A store is any object carrying the twelve synchronous, path-addressed methods of
ZenFS's `FileSystem` — which is also
[wasi-sh](https://github.com/alganet/wasi-sh)'s `fs` contract, so a shell's
store, a `@zenfs/core` filesystem and a persistent OPFS-backed one are all the
same argument here. Nothing is copied in at mount time or flushed out at the
end: a file the shell just wrote is the file PHP opens, an edit made outside is
the code the next request runs, and a database PHP writes is a file the page
still has after a reload.

`path` is where the store appears in PHP's filesystem; `root` is the directory
*of the store* that lands there, and it defaults to `path`. That default is the
one to keep — it makes the mount an identity mapping, so `/app` in the shell is
`/app` in PHP, which is what a shell typing `php app/index.php` depends on.
Mounting at `/` is not possible: Emscripten's root is already in memory and
`/dev`, `/tmp` and `/proc` have to stay there. Mount the directories the project
lives in, one call each.

`@zenfs/core` and `@zenfs/emscripten` are optional peer dependencies — the
Emscripten-side translation is theirs, and embedding PHP in a page without
mounting anything installs neither:

```sh
npm install @zenfs/core @zenfs/emscripten
```

## Live Demo

A live demo is available at [alganet.github.io/phasm](https://alganet.github.io/phasm/).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for build instructions and development
guidelines.

## Acknowledgements

`mountStore()` is built on **ZenFS** — [`@zenfs/core`](https://github.com/zen-fs/core)
and [`@zenfs/emscripten`](https://github.com/zen-fs/emscripten), LGPL-3.0-or-later
with a web-application exception, used unmodified.

## License

[ISC](LICENSE)
