<!--
SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>

SPDX-License-Identifier: ISC
-->

# phasm

PHP 8.5 compiled to WebAssembly. Run PHP in the browser or in Node.js.

    npm install @alganet/phasm

## Included Extensions

calendar, ctype, fileinfo, filter, gmp, iconv, mbstring, pcntl, pdo,
pdo_sqlite, sqlite3, tokenizer, zip.

## Node.js

```js
import Phasm from "@alganet/phasm";

const php = await Phasm({
  noInitialRun: true,
  print: (text) => process.stdout.write(text + "\n"),
  printErr: (text) => process.stderr.write(text + "\n"),
});

php.FS.writeFile("/hello.php", `<?php echo "Hello from PHP!\\n"; ?>`);
php.callMain(["hello.php"]);
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
    php.callMain(["hello.php"]);
  });
</script>
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

The resolved module exposes `callMain()` to run PHP scripts and `FS` for
filesystem access.

## Virtual Filesystem

Phasm uses Emscripten's virtual filesystem. Write PHP files before calling
`callMain()`:

```js
php.FS.writeFile("/app.php", '<?php echo "works"; ?>');
php.FS.writeFile("/data.json", JSON.stringify({ key: "value" }));
php.callMain(["app.php"]);
```

See the [Emscripten File System API](https://emscripten.org/docs/api_reference/Filesystem-API.html) for the full reference.

## Live Demo

A live demo is available at [alganet.github.io/phasm](https://alganet.github.io/phasm/).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for build instructions and development
guidelines.

## License

[ISC](LICENSE)
