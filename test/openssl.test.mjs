// SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>
//
// SPDX-License-Identifier: ISC

// openssl — the extension a real framework refuses to run without.
//
// Laravel names ext-openssl in its platform requirements, so Composer stops
// before any code runs without it; APP_KEY, the encrypter, signed cookies and
// the session guard are all downstream of that. So the assertions below are
// mostly about claims rather than about names: a `configure` flag can take
// effect, an extension can load, `extension_loaded()` can say yes, and the
// thing still not work — which is exactly what happened here on the first
// build that linked.
//
// Two of these are about the cross-compilation rather than about PHP, and they
// are the ones worth reading:
//
//   * **The config file has to be IN the artifact.** libcrypto is compiled with
//     an OPENSSLDIR of /usr/local/ssl — a guest path, since a host path would
//     name a directory that exists on one computer — and PHP's
//     php_openssl_parse_config() returns FAILURE when it cannot read
//     openssl.cnf there. With no file, every function built on php_x509_request
//     fails before doing any work: key generation, CSRs, PKCS#12. Everything
//     that takes its key as an argument keeps working, which is what makes the
//     gap look arbitrary from PHP. The file is embedded at link time; see
//     EMCC_ABI_FLAGS in scripts/env.sh.
//
//   * **Seeding is /dev/urandom and nothing else.** OpenSSL's default `os`
//     seeding is getrandom-then-devrandom, and its getrandom half cannot work
//     under this target at all: the weak-symbol probe for getentropy() is
//     guarded on __ELF__, which a wasm object is not; the DSO_global_lookup
//     fallback is compiled out by no-dso; and the syscall path is guarded on
//     __linux. The build asks for devrandom outright, and Emscripten's
//     /dev/urandom is crypto.getRandomValues() in a browser and randomBytes()
//     under node. `$crypto_strong` is what says so out loud.

import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { evalPhp, haveBuild, NO_BUILD_MSG } from './helper.mjs';

const SKIP = haveBuild() ? false : NO_BUILD_MSG;
before((t) => { if (SKIP) t.diagnostic(SKIP); });
const opts = { skip: SKIP };

/** Run PHP and fail loudly with its own diagnostics rather than on a diff. */
async function ok(code) {
  const r = await evalPhp(code);
  assert.equal(r.stderr, '', `PHP wrote to stderr:\n${r.stderr}`);
  assert.equal(r.exitCode, 0, `PHP exited ${r.exitCode}:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

describe('openssl: the library behind it', opts, () => {
  test('reports the OpenSSL this repo pins', async () => {
    const out = await ok('echo OPENSSL_VERSION_TEXT;');
    assert.match(out, /^OpenSSL 3\.5\./, `expected the pinned 3.5 LTS series, got ${JSON.stringify(out)}`);
  });

  // OPENSSL_VERSION_NUMBER is what a library check in userland actually reads,
  // and it is derived from the headers the extension compiled against — so this
  // catches a build that found the HOST's openssl.pc and compiled against its
  // headers while linking the sysroot's archive.
  test('the version constant agrees with the version string', async () => {
    const out = await ok('printf("%d|%s", OPENSSL_VERSION_NUMBER, OPENSSL_VERSION_TEXT);');
    const [num, text] = out.split('|');
    const [, major, minor] = text.match(/^OpenSSL (\d+)\.(\d+)\./);
    // 3.x packs the version as 0xMNN00PP0; the top byte is the major.
    const packed = Number(num) >>> 0;
    assert.equal(packed >>> 28, Number(major));
    assert.equal((packed >>> 20) & 0xff, Number(minor));
  });
});

describe('openssl: the config file the artifact carries', opts, () => {
  // The path is not ours to choose at run time — libcrypto was compiled with
  // it. Asking OpenSSL where it thinks its config area is, rather than
  // hard-coding /usr/local/ssl here, is what makes this test fail for the right
  // reason when --openssldir changes in scripts/deps.sh.
  test('openssl.cnf is readable at the compiled-in config area', async () => {
    const out = await ok(
      '$dir = openssl_get_cert_locations()["default_default_cert_area"];'
      + 'echo $dir, "|", var_export(is_readable("$dir/openssl.cnf"), true), "|", filesize("$dir/openssl.cnf");'
    );
    const [dir, readable, size] = out.split('|');
    assert.equal(dir, '/usr/local/ssl');
    assert.equal(readable, 'true', 'the --embed-file in EMCC_ABI_FLAGS did not reach the artifact');
    assert.ok(Number(size) > 1000, `openssl.cnf is ${size} bytes — that is not upstream's file`);
  });

  // The one function that fails without it, and the reason the file is shipped
  // at all. It failed on the first build that linked OpenSSL, reporting
  // "error:8000002C:system library::No such file or directory" — an errno with
  // no filename in it.
  test('openssl_pkey_new() works, which is what a missing config file breaks', async () => {
    const out = await ok(
      '$k = openssl_pkey_new(["private_key_bits" => 2048]);'
      + 'if ($k === false) { echo "failed: ", openssl_error_string(); return; }'
      + '$d = openssl_pkey_get_details($k);'
      + 'printf("%d|%d", $d["bits"], $d["type"]);'
    );
    assert.equal(out, `2048|0`, 'OPENSSL_KEYTYPE_RSA is 0');
  });
});

describe('openssl: entropy', opts, () => {
  // $crypto_strong false would mean OpenSSL fell back to something it does not
  // vouch for — the exact outcome if the devrandom seed source ever stops
  // resolving under this target.
  test('openssl_random_pseudo_bytes is cryptographically strong', async () => {
    const out = await ok('$b = openssl_random_pseudo_bytes(32, $strong); printf("%d|%s", strlen($b), var_export($strong, true));');
    assert.equal(out, '32|true');
  });

  test('two draws differ, so the DRBG is actually advancing', async () => {
    const out = await ok('echo bin2hex(openssl_random_pseudo_bytes(16)), "|", bin2hex(openssl_random_pseudo_bytes(16));');
    const [a, b] = out.split('|');
    assert.equal(a.length, 32);
    assert.notEqual(a, b);
  });
});

describe('openssl: symmetric', opts, () => {
  test('AES-256-CBC round-trips', async () => {
    const out = await ok(
      '$k = random_bytes(32); $iv = random_bytes(16);'
      + '$c = openssl_encrypt("attack at dawn", "aes-256-cbc", $k, OPENSSL_RAW_DATA, $iv);'
      + 'echo openssl_decrypt($c, "aes-256-cbc", $k, OPENSSL_RAW_DATA, $iv);'
    );
    assert.equal(out, 'attack at dawn');
  });

  // AEAD is a separate code path in ext/openssl and the one Laravel 9+ uses by
  // default, so a tag that comes back empty is a live failure rather than a
  // detail.
  test('AES-256-GCM produces a tag, and a wrong tag is refused', async () => {
    const out = await ok(
      '$k = random_bytes(32); $iv = random_bytes(12);'
      + '$c = openssl_encrypt("secret", "aes-256-gcm", $k, OPENSSL_RAW_DATA, $iv, $tag, "hdr");'
      + '$good = openssl_decrypt($c, "aes-256-gcm", $k, OPENSSL_RAW_DATA, $iv, $tag, "hdr");'
      + '$bad  = @openssl_decrypt($c, "aes-256-gcm", $k, OPENSSL_RAW_DATA, $iv, strrev($tag), "hdr");'
      + 'printf("%d|%s|%s", strlen($tag), $good, var_export($bad, true));'
    );
    assert.equal(out, '16|secret|false');
  });

  test('the ciphers a modern application asks for are all present', async () => {
    const out = await ok('echo implode(",", array_intersect(["aes-256-cbc", "aes-256-gcm", "chacha20-poly1305", "des-ede3-cbc"], openssl_get_cipher_methods()));');
    assert.deepEqual(out.split(',').sort(), ['aes-256-cbc', 'aes-256-gcm', 'chacha20-poly1305', 'des-ede3-cbc']);
  });

  // Two implementations of PBKDF2 in one binary — ext/hash's own C and
  // OpenSSL's — agreeing byte for byte. Worth more than a hard-coded vector:
  // it checks the library against a second implementation that was already
  // here and known good, rather than against a constant that could be copied
  // wrong in the same commit as the bug.
  test('openssl_pbkdf2 agrees with ext/hash on the same input', async () => {
    const out = await ok(
      'printf("%s|%s",'
      + ' bin2hex(openssl_pbkdf2("password", "salt", 32, 1000, "sha256")),'
      + ' bin2hex(hash_pbkdf2("sha256", "password", "salt", 1000, 32, true)));'
    );
    const [openssl, hash] = out.split('|');
    assert.equal(openssl, hash);
    assert.equal(openssl, '632c2812e46d4604102ba7618e9d6d7d2f8128f6266b4a03264d2a0460b7dcb3');
  });
});

describe('openssl: asymmetric', opts, () => {
  test('RSA signs and verifies', async () => {
    const out = await ok(
      '$k = openssl_pkey_new(["private_key_bits" => 2048]);'
      + 'openssl_sign("the message", $sig, $k, OPENSSL_ALGO_SHA256);'
      + '$pub = openssl_pkey_get_details($k)["key"];'
      + 'printf("%d|%d", openssl_verify("the message", $sig, $pub, OPENSSL_ALGO_SHA256),'
      + '                openssl_verify("the messagE", $sig, $pub, OPENSSL_ALGO_SHA256));'
    );
    assert.equal(out, '1|0', 'a verify that says yes to a changed message is worse than one that fails');
  });

  // EC is a different provider path and much cheaper than RSA, which is why
  // anything modern reaches for it — and why it would be its own outage.
  test('EC on prime256v1 signs and verifies', async () => {
    const out = await ok(
      '$k = openssl_pkey_new(["private_key_type" => OPENSSL_KEYTYPE_EC, "curve_name" => "prime256v1"]);'
      + 'openssl_sign("m", $sig, $k, "sha256");'
      + '$d = openssl_pkey_get_details($k);'
      + 'printf("%d|%d|%s", openssl_verify("m", $sig, $d["key"], "sha256"), $d["bits"], $d["ec"]["curve_name"]);'
    );
    assert.equal(out, '1|256|prime256v1');
  });

  test('a public key seals what only the private key opens', async () => {
    const out = await ok(
      '$k = openssl_pkey_new(["private_key_bits" => 2048]);'
      + '$pub = openssl_pkey_get_details($k)["key"];'
      + 'openssl_seal("the envelope", $sealed, $keys, [$pub], "aes-256-cbc", $iv);'
      + 'openssl_open($sealed, $opened, $keys[0], $k, "aes-256-cbc", $iv);'
      + 'echo $opened;'
    );
    assert.equal(out, 'the envelope');
  });
});

describe('openssl: certificates', opts, () => {
  // The whole php_x509_request path in one go: it reads the [req] section out
  // of the embedded openssl.cnf, so a config file that is present but wrong
  // fails here rather than in openssl_pkey_new().
  test('a CSR becomes a self-signed certificate that matches its key', async () => {
    const out = await ok(
      '$k = openssl_pkey_new(["private_key_bits" => 2048]);'
      + '$csr = openssl_csr_new(["commonName" => "phasm.test", "countryName" => "BR"], $k, ["digest_alg" => "sha256"]);'
      + '$crt = openssl_csr_sign($csr, null, $k, 365, ["digest_alg" => "sha256"]);'
      + 'openssl_x509_export($crt, $pem);'
      + '$info = openssl_x509_parse($pem);'
      + 'printf("%s|%s|%s|%s",'
      + ' $info["subject"]["CN"], $info["signatureTypeSN"],'
      + ' var_export(openssl_x509_check_private_key($crt, $k), true),'
      + ' var_export(str_starts_with($pem, "-----BEGIN CERTIFICATE-----"), true));'
    );
    assert.equal(out, 'phasm.test|RSA-SHA256|true|true');
  });

  test('a certificate and its key round-trip through PKCS#12', async () => {
    const out = await ok(
      '$k = openssl_pkey_new(["private_key_bits" => 2048]);'
      + '$csr = openssl_csr_new(["commonName" => "p12.test"], $k, ["digest_alg" => "sha256"]);'
      + '$crt = openssl_csr_sign($csr, null, $k, 1, ["digest_alg" => "sha256"]);'
      + 'openssl_pkcs12_export($crt, $p12, $k, "passphrase");'
      + 'openssl_pkcs12_read($p12, $out, "passphrase");'
      + '$bad = @openssl_pkcs12_read($p12, $nope, "wrong");'
      + 'printf("%s|%s|%s", openssl_x509_parse($out["cert"])["subject"]["CN"],'
      + ' var_export(isset($out["pkey"]), true), var_export($bad, true));'
    );
    assert.equal(out, 'p12.test|true|false');
  });
});

// ─── what this build deliberately does NOT have ──────────────────────────────

// Each of these is a `no-*` in scripts/deps.sh or a `--with-*` not passed in
// scripts/build.sh. Pinned as absences for the same reason gmp and xmlreader
// are: turning one on should be a change that has to touch this file, and a
// silently larger download is the failure mode nothing else catches.
describe('openssl: the parts this build leaves out', opts, () => {
  test('the legacy provider is not built, so RC4 is gone', async () => {
    const out = await ok(
      'printf("%s|%s", var_export(in_array("rc4", openssl_get_cipher_methods()), true),'
      + ' var_export(@openssl_encrypt("x", "rc4", str_repeat("k", 16)), true));'
    );
    assert.equal(out, 'false|false');
  });

  test('argon2 password hashing is not compiled in', async () => {
    // --with-openssl-argon2 is off, so ext/openssl's pwhash functions do not
    // exist. password_hash()'s own argon2 is a separate thing and also absent
    // (that one needs libsodium), so nothing here is shadowing anything.
    const out = await ok('echo var_export(function_exists("openssl_password_hash"), true);');
    assert.equal(out, 'false');
  });

  // The transports register because ext/openssl registers them; there is
  // nothing underneath to connect them to, since this target has no sockets.
  // Pinned as a registration rather than as a connection: what a caller sees is
  // "the scheme exists and the connect fails", and the README says so.
  test('the TLS transports are registered even though nothing can dial out', async () => {
    const out = await ok('echo implode(",", array_intersect(["ssl", "tls", "tlsv1.2", "tlsv1.3"], stream_get_transports()));');
    assert.deepEqual(out.split(',').sort(), ['ssl', 'tls', 'tlsv1.2', 'tlsv1.3']);
  });
});

// ─── the shape the milestone after this one actually needs ───────────────────

describe('openssl: Laravel’s encrypter, end to end', opts, () => {
  // Not a Laravel dependency and not a mock of one — the exact sequence
  // Illuminate\Encryption\Encrypter runs: a 32-byte APP_KEY, AES-256-CBC over
  // a serialized value, an HMAC-SHA256 over the base64 of the IV and the
  // ciphertext, the three carried as JSON, and hash_equals() on the way back.
  // If any one of the pieces is missing this is what fails, and it fails in a
  // way that names which.
  test('encrypt, MAC, transport as JSON, verify and decrypt', async () => {
    const out = await ok(`
      $key = random_bytes(32);
      $iv = random_bytes(16);
      $value = openssl_encrypt(serialize(["user" => 7]), "aes-256-cbc", $key, 0, $iv);
      $iv64 = base64_encode($iv);
      $mac = hash_hmac("sha256", $iv64 . $value, $key);
      $payload = base64_encode(json_encode(compact("iv64", "value", "mac")));

      $back = json_decode(base64_decode($payload), true);
      if (!hash_equals(hash_hmac("sha256", $back["iv64"] . $back["value"], $key), $back["mac"])) {
        echo "mac mismatch"; return;
      }
      $plain = unserialize(openssl_decrypt($back["value"], "aes-256-cbc", $key, 0, base64_decode($back["iv64"])));
      printf("%d|%s", $plain["user"], var_export(hash_equals("a", "b"), true));
    `);
    assert.equal(out, '7|false');
  });

  // A tampered ciphertext has to fail the MAC, not decrypt to something. This
  // is the half of the payload check that a broken hash_hmac would pass.
  //
  // The tamper flips the first base64 character to a DIFFERENT one rather than
  // substituting a chosen letter: the first cut looked for an "A" to swap, and
  // roughly one ciphertext in a few has none, so it passed alone and failed in
  // the suite — where the key is drawn afresh — with nothing to point at.
  test('a tampered payload fails its MAC', async () => {
    const out = await ok(`
      $key = random_bytes(32);
      $iv = random_bytes(16);
      $value = openssl_encrypt("hello", "aes-256-cbc", $key, 0, $iv);
      $mac = hash_hmac("sha256", base64_encode($iv) . $value, $key);
      $tampered = ($value[0] === "A" ? "B" : "A") . substr($value, 1);
      printf("%s|%s", var_export($tampered !== $value, true),
        var_export(hash_equals(hash_hmac("sha256", base64_encode($iv) . $tampered, $key), $mac), true));
    `);
    assert.equal(out, 'true|false');
  });
});
