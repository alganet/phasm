// SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>
//
// SPDX-License-Identifier: ISC

// Linked into the module by --post-js (see scripts/env.sh), which places this
// inside the MODULARIZE factory after the runtime is up and before the factory
// resolves. So Module.phasmRun exists by the time the caller has a module.
//
// This is only argv/cwd/env marshalling. It lives in the artifact rather than
// in each consumer because the packed-string calling convention is an
// implementation detail of sapi/phasm/phasm.c, and nobody should have to
// re-derive it. Output is still collected the way Emscripten collects it — via
// FS.init() sinks the caller swaps per invocation.

/**
 * Pack strings the way phasm_run() reads them: NUL-terminated, back to back.
 * stringToUTF8 writes embedded NULs verbatim, so one conversion does it.
 * Returns 0 for an empty list, which the C side reads as "none".
 */
function phasmPackStrings(list) {
  if (!list.length) return 0;
  return stringToNewUTF8(list.join('\0') + '\0');
}

/**
 * Run PHP once on this instance. `args` is argv without argv[0].
 *
 * Unlike callMain(), this can be called any number of times: it never exits the
 * process, the exit status is per call, and cwd and env apply to this call
 * only. The two entry points are mutually exclusive — a module that has run
 * callMain() cannot use phasmRun() and vice versa.
 *
 * @param {string[]} args
 * @param {{cwd?: string, env?: Record<string, string>}} [opts]
 * @returns {number} the exit status
 */
Module['phasmRun'] = function (args, opts) {
  opts = opts || {};

  const argv = ['php'].concat(args || []).map(String);
  const env = Object.entries(opts.env || {}).map(([k, v]) => `${k}=${v}`);

  const argvPtr = phasmPackStrings(argv);
  const envPtr = phasmPackStrings(env);
  const cwdPtr = opts.cwd ? stringToNewUTF8(opts.cwd) : 0;

  try {
    return _phasm_run(argvPtr, argv.length, cwdPtr, envPtr, env.length);
  } finally {
    if (argvPtr) _free(argvPtr);
    if (envPtr) _free(envPtr);
    if (cwdPtr) _free(cwdPtr);
  }
};

/**
 * Start PHP explicitly, with optional ini settings for the life of the
 * instance. phasmRun() does this on first use with no settings, so this is only
 * needed to pass ini — per-call `-d` is not supported on this path.
 *
 * @param {string} [ini] newline-separated "name=value" lines
 * @returns {number} 0 on success, -1 if this module already ran callMain()
 */
Module['phasmStartup'] = function (ini) {
  const iniPtr = ini ? stringToNewUTF8(ini) : 0;
  try {
    return _phasm_startup(iniPtr);
  } finally {
    if (iniPtr) _free(iniPtr);
  }
};

// callMain() re-enters the CLI's main(), which starts the module. On an
// instance where PHP is already up that traps — "null function or function
// signature mismatch" — and takes the instance with it, so every later
// phasmRun() throws too. phasm_startup() already refuses the opposite order;
// this is the same refusal in the direction Emscripten owns, and it has to live
// here because callMain() is a JS function that never reaches C.
const phasmCallMain = Module['callMain'];
if (phasmCallMain) {
  Module['callMain'] = function (args) {
    if (_phasm_is_started()) {
      throw new Error(
        'phasm: callMain() and phasmRun() are mutually exclusive, and this '
        + 'module has already started PHP. Use phasmRun().',
      );
    }
    return phasmCallMain.apply(this, arguments);
  };
}
