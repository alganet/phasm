// SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>
//
// SPDX-License-Identifier: ISC

// Linked into the module by --pre-js (see scripts/env.sh), which places this
// inside the MODULARIZE factory right after `var Module = moduleArg` — before
// the runtime starts. The timing is the entire point: Emscripten wires fd 0, 1
// and 2 up exactly once, during runtime init, from Module.stdin/stdout/stderr,
// and afterwards they cannot be re-pointed without closing them. src/phasm-glue.js
// runs at the other end (--post-js), by which time it is far too late.
//
// WHY THE MODULE CLAIMS THE STANDARD STREAMS
//
// PHP writes to descriptors like any other program — echo, `php -v`, a warning,
// a fatal, the SAPI's own usage errors. So run() returning {stdout, stderr,
// exitCode} needs the descriptors themselves, per call. There is no higher
// place to intercept: the server hook (sapi_module.ub_write) sees what PHP
// prints and none of what argument handling prints, and Emscripten's
// print/printErr are LINE buffered — they fire only on a newline and hand back
// the line with it stripped, so `php -r 'echo 42;'` delivers nothing at all.
//
// Every embedder was therefore hand-rolling the same preRun FS.init() recipe,
// and it has three traps in it: the line buffering above, sinks that are global
// when the interesting thing is which call produced what, and the swap-per-call
// dance re-entrancy needs. Doing it here means run() works on a module built
// the ordinary way, and nobody re-derives the recipe.
//
// Nothing is taken away. Output produced when no run() is in flight — which is
// everything callMain() and phasmRun() produce — is delegated to whatever the
// embedder passed, reproducing Emscripten's own behaviour byte for byte, so
// print, printErr and stdin keep working exactly as they did.

var phasmStdio = (() => {
  const decoder = new TextDecoder();
  const EMPTY = new Uint8Array(0);

  // Read before we overwrite them: these are the embedder's, straight off the
  // options object it passed to the factory.
  const embedderStdin = Module['stdin'];
  const embedderStdout = Module['stdout'];
  const embedderStderr = Module['stderr'];

  /** The call in flight, or null when the module is idle. */
  let active = null;

  /**
   * Whether fd 0/1/2 actually ended up ours. False when the embedder called
   * FS.init() itself or passed noFSInit, in which case run() refuses rather
   * than returning empty output and letting it look like PHP printed nothing.
   */
  let claimed = false;

  /**
   * Emscripten's default tty: a byte at a time in, one string per newline out,
   * NULs dropped, and a null flushes. Delegation reproduces it exactly, because
   * it is what the embedder is getting today.
   */
  function lineBuffered(write) {
    const pending = [];
    return (charCode) => {
      if (charCode === null || charCode === 10) {
        write(decoder.decode(Uint8Array.from(pending)));
        pending.length = 0;
      } else if (charCode !== 0) {
        pending.push(charCode);
      }
    };
  }

  // Emscripten's own defaults for the two, resolved per line so that an
  // embedder which assigns print later still gets it.
  const idleStdout = embedderStdout
    || lineBuffered((text) => (Module['print'] || console.log)(text));
  const idleStderr = embedderStderr
    || lineBuffered((text) => (Module['printErr'] || console.error)(text));

  /**
   * A growable byte buffer.
   *
   * Emscripten hands a device one byte per call, so a call's output arrives
   * byte by byte no matter what; what must not also be per-byte is the storage.
   * A plain array of numbers costs an ~8-byte slot each, and a `php app.php >
   * big.json` through a shell builtin is megabytes — 8 MiB of output held ~400
   * MB that way. Doubling into a Uint8Array keeps it at the size of the output.
   */
  function byteBuffer() {
    let bytes = new Uint8Array(256);
    let length = 0;

    return {
      get length() { return length; },
      push(byte) {
        if (length === bytes.length) {
          const grown = new Uint8Array(bytes.length * 2);
          grown.set(bytes);
          bytes = grown;
        }
        bytes[length++] = byte;
      },
      /** A view for reading now. Only valid until the next push(). */
      view() { return bytes.subarray(0, length); },
      /** An owned copy, for handing to someone who keeps it. */
      take() { return bytes.slice(0, length); },
      reset() { length = 0; },
    };
  }

  /** Hand `onOutput` everything buffered for one channel, if anything is. */
  function flush(call, channel) {
    const pending = channel === 'stdout' ? call.pendingOut : call.pendingErr;
    if (!pending.length) return;
    call.onOutput(pending.take(), channel);
    pending.reset();
  }

  function collector(channel) {
    return (charCode) => {
      const call = active;
      if (!call) return (channel === 'stdout' ? idleStdout : idleStderr)(charCode);

      // A null is Emscripten's flush signal, not a byte. Everything else is
      // one, NULs included: PHP is as likely to be writing a PNG as a page, and
      // the tty's habit of dropping zero bytes would corrupt it.
      if (charCode === null) {
        if (call.onOutput) flush(call, channel);
        return;
      }
      if (call.collect) (channel === 'stdout' ? call.out : call.err).push(charCode);
      if (call.onOutput) {
        (channel === 'stdout' ? call.pendingOut : call.pendingErr).push(charCode);
        // Per line, so a long-running script reports as it goes. Output with no
        // newlines in it at all is one chunk at the end, which is the right
        // answer for a binary response and the wrong one for a progress bar.
        if (charCode === 10) flush(call, channel);
      }
    };
  }

  const stdoutRouter = collector('stdout');
  const stderrRouter = collector('stderr');

  /**
   * One byte of stdin, or null for EOF — the shape FS.createDevice() reads.
   * `undefined` is EAGAIN there, so it is never returned.
   *
   * A call that named no stdin of its own falls through to the embedder's,
   * which is what makes run() a strict addition: a module wired to a terminal
   * or a ring still reaches it.
   */
  function stdinRouter() {
    const call = active;
    if (!call || !call.stdin) return embedderStdin ? embedderStdin() : null;

    const src = call.stdin;
    while (src.pos >= src.bytes.length) {
      if (!src.pull) return null;
      // Chunked, and only when PHP actually asks. Draining up front would park
      // an interactive shell on a `php -v` that never reads a byte.
      const more = src.pull(65536);
      if (!more || !more.length) {
        src.pull = null;
        return null;
      }
      src.bytes = more;
      src.pos = 0;
    }
    return src.bytes[src.pos++];
  }

  Module['stdin'] = stdinRouter;
  Module['stdout'] = stdoutRouter;
  Module['stderr'] = stderrRouter;

  // Did the routers above actually become fd 0/1/2? FS.init() is the one place
  // that decides, whether it is called by the runtime or by an embedder's own
  // preRun hook, and it resolves its arguments against Module.* exactly as
  // repeated here. Wrapping it is the only answer that is not a guess.
  //
  // This hook goes first so that it is installed before any embedder hook can
  // call FS.init; FS is a hoisted var, undefined until the module body runs,
  // which is why the wrapping happens here and not above.
  let preRuns = Module['preRun'];
  if (typeof preRuns === 'function') preRuns = [preRuns];
  Module['preRun'] = [() => {
    const initialize = FS.init;
    FS.init = function (input, output, error) {
      claimed = (input ?? Module['stdin']) === stdinRouter
        && (output ?? Module['stdout']) === stdoutRouter
        && (error ?? Module['stderr']) === stderrRouter;
      FS.init = initialize;
      return initialize.call(FS, input, output, error);
    };
  }].concat(preRuns || []);

  function toBytes(data) {
    if (data == null) return EMPTY;
    return typeof data === 'string' ? new TextEncoder().encode(data) : data;
  }

  return {
    /** Whether run() can capture on this module at all. */
    get claimed() { return claimed; },

    /**
     * Start capturing. `opts` takes `stdin` (bytes, a string, or a pull
     * function returning bytes and an empty result for EOF), `onOutput` and
     * `collect`.
     */
    begin(opts) {
      if (!claimed) {
        throw new Error(
          'phasm: this module cannot capture output, because its standard streams '
          + 'were claimed elsewhere — an FS.init() of your own, or noFSInit. Drop '
          + 'that: the module installs its own stdio, and per-call capture is what '
          + 'run() is for.',
        );
      }
      if (active) {
        throw new Error('phasm: a call is already in flight on this module; capture does not nest.');
      }

      const stdin = typeof opts.stdin === 'function'
        ? { bytes: EMPTY, pos: 0, pull: opts.stdin }
        : opts.stdin != null
          ? { bytes: toBytes(opts.stdin), pos: 0, pull: null }
          : null;

      active = {
        collect: opts.collect !== false,
        onOutput: opts.onOutput || null,
        stdin,
        out: byteBuffer(),
        err: byteBuffer(),
        pendingOut: byteBuffer(),
        pendingErr: byteBuffer(),
      };
    },

    /** Stop capturing and return what the call produced. Always paired with begin(). */
    end() {
      const call = active;
      active = null;
      if (call.onOutput) {
        // Output that never ended in a newline is still buffered here, and it
        // is the common case: `php -r 'echo 42;'`.
        flush(call, 'stdout');
        flush(call, 'stderr');
      }
      return {
        stdout: call.collect ? decoder.decode(call.out.view()) : '',
        stderr: call.collect ? decoder.decode(call.err.view()) : '',
      };
    },
  };
})();
