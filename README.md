<!--
SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>

SPDX-License-Identifier: ISC
-->

# phasm

PHP 8.5 compiled to WebAssembly. Run PHP in the browser or in Node.js.

    npm install @alganet/phasm

## Included Extensions

calendar, ctype, fileinfo, filter, iconv, mbstring, opcache, pcntl, pdo,
pdo_sqlite, sqlite3, tokenizer, zip.

Plus PHP's always-on core: Core, date, hash, json, lexbor, pcre, random,
Reflection, SPL, standard, uri.

`get_loaded_extensions()` is the authority; `npm test` asserts this list matches
what the binary actually links, so it cannot drift again.

## Node.js

```js
import Phasm from "@alganet/phasm";

const php = await Phasm({
  noInitialRun: true,
  print: (text) => process.stdout.write(text + "\n"),
  printErr: (text) => process.stderr.write(text + "\n"),
});

php.FS.writeFile("/hello.php", `<?php echo "Hello from PHP!\\n"; ?>`);
php.phasmRun(["hello.php"]);
```

## Browser

```html
<script src="https://unpkg.com/@alganet/phasm/dist/php.js"></script>
<pre id="output"></pre>
<script>
  Phasm({
    noInitialRun: true,
    print: (text) => document.getElementById("output").textContent += text + "\n",
    printErr: (text) => console.error(text),
  }).then((php) => {
    php.FS.writeFile("/hello.php", '<?php echo "Hello from PHP!\\n"; ?>');
    php.phasmRun(["hello.php"]);
  });
</script>
```

## TypeScript

Types ship with the package — `Phasm`, `PhasmOptions`, `PhasmModule` and
`PhasmFS` are all declared, no `@types` package needed.

```ts
import Phasm, { type PhasmModule } from "@alganet/phasm";

const php: PhasmModule = await Phasm({ noInitialRun: true });
```

## Configuration

`Phasm()` is a factory function that accepts standard [Emscripten Module](https://emscripten.org/docs/api_reference/module.html)
options and returns a promise that resolves to the initialized module:

| Option           | Description                                             |
|------------------|---------------------------------------------------------|
| `noInitialRun`   | Set `true` to prevent automatic execution on load.      |
| `arguments`      | Array of CLI arguments (e.g. `["script.php"]`).         |
| `print(text)`    | Callback for stdout output.                             |
| `printErr(text)` | Callback for stderr output.                             |
| `stdin()`        | Callback to provide stdin input. Return `null` for EOF. |

The resolved module exposes `phasmRun()` to run PHP scripts and `FS` for
filesystem access.

```js
php.phasmRun(["script.php", "arg"], { cwd: "/project", env: { APP_ENV: "dev" } });
```

It returns the exit status, and `cwd` and `env` apply to that call alone.

**One instance, many runs.** phasm builds its own SAPI (`sapi/phasm`) rather
than the stock CLI, so `phasmRun()` runs a full request per call without ever
exiting the process: the exit status is per call, errors go to stderr, and a
fatal error or `exit()` leaves the module usable. Booting PHP costs ~70 ms and a
warm call ~1 ms, so reuse the instance.

`callMain()` is still there and still one-shot — it re-enters the CLI's `main()`,
which ends in `exit()`. Pick one entry point per module; they cannot be mixed,
and each refuses the call rather than leaving you with a dead instance.

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

Phasm uses Emscripten's virtual filesystem. Write PHP files before calling
`phasmRun()`:

```js
php.FS.writeFile("/app.php", '<?php echo "works"; ?>');
php.FS.writeFile("/data.json", JSON.stringify({ key: "value" }));
php.phasmRun(["app.php"]);
```

See the [Emscripten File System API](https://emscripten.org/docs/api_reference/Filesystem-API.html) for the full reference.

## Live Demo

A live demo is available at [alganet.github.io/phasm](https://alganet.github.io/phasm/).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for build instructions and development
guidelines.

## License

[ISC](LICENSE)
