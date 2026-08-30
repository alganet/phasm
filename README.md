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
which ends in `exit()`. Pick one entry point per module; they cannot be mixed.

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
