#!/usr/bin/env node
// include: shell.js
// include: minimum_runtime_check.js
// end include: minimum_runtime_check.js
// The Module object: Our interface to the outside world. We import
// and export values on it. There are various ways Module can be used:
// 1. Not defined. We create it here
// 2. A function parameter, function(moduleArg) => Promise<Module>
// 3. pre-run appended it, var Module = {}; ..generated code..
// 4. External script tag defines var Module.
// We need to check if Module already exists (e.g. case 3 above).
// Substitution will be replaced with actual code on later stage of the build,
// this way Closure Compiler will not mangle it (e.g. case 4. above).
// Note that if you want to run closure, and also to use Module
// after the generated code, you will need to define   var Module = {};
// before the code. Then that object will be used in the code, and you
// can continue to use Module afterwards as well.
var Module = typeof Phasm != 'undefined' ? Phasm : {};

// Determine the runtime environment we are in. You can customize this by
// setting the ENVIRONMENT setting at compile time (see settings.js).

// Attempt to auto-detect the environment
var ENVIRONMENT_IS_WEB = !!globalThis.window;
var ENVIRONMENT_IS_WORKER = !!globalThis.WorkerGlobalScope;
// N.b. Electron.js environment is simultaneously a NODE-environment, but
// also a web environment.
var ENVIRONMENT_IS_NODE = globalThis.process?.versions?.node && globalThis.process?.type != 'renderer';
var ENVIRONMENT_IS_SHELL = !ENVIRONMENT_IS_WEB && !ENVIRONMENT_IS_NODE && !ENVIRONMENT_IS_WORKER;

// --pre-jses are emitted after the Module integration code, so that they can
// refer to Module (if they choose; they can also define Module)


var arguments_ = [];
var thisProgram = './this.program';
var quit_ = (status, toThrow) => {
  throw toThrow;
};

// In MODULARIZE mode _scriptName needs to be captured already at the very top of the page immediately when the page is parsed, so it is generated there
// before the page load. In non-MODULARIZE modes generate it here.
var _scriptName = globalThis.document?.currentScript?.src;

if (typeof __filename != 'undefined') { // Node
  _scriptName = __filename;
} else
if (ENVIRONMENT_IS_WORKER) {
  _scriptName = self.location.href;
}

// `/` should be present at the end if `scriptDirectory` is not empty
var scriptDirectory = '';
function locateFile(path) {
  if (Module['locateFile']) {
    return Module['locateFile'](path, scriptDirectory);
  }
  return scriptDirectory + path;
}

// Hooks that are implemented differently in different runtime environments.
var readAsync, readBinary;

if (ENVIRONMENT_IS_NODE) {

  // These modules will usually be used on Node.js. Load them eagerly to avoid
  // the complexity of lazy-loading.
  var fs = require('node:fs');

  scriptDirectory = __dirname + '/';

// include: node_shell_read.js
readBinary = (filename) => {
  // We need to re-wrap `file://` strings to URLs.
  filename = isFileURI(filename) ? new URL(filename) : filename;
  var ret = fs.readFileSync(filename);
  return ret;
};

readAsync = async (filename, binary = true) => {
  // See the comment in the `readBinary` function.
  filename = isFileURI(filename) ? new URL(filename) : filename;
  var ret = fs.readFileSync(filename, binary ? undefined : 'utf8');
  return ret;
};
// end include: node_shell_read.js
  if (process.argv.length > 1) {
    thisProgram = process.argv[1].replace(/\\/g, '/');
  }

  arguments_ = process.argv.slice(2);

  // MODULARIZE will export the module in the proper place outside, we don't need to export here
  if (typeof module != 'undefined') {
    module['exports'] = Module;
  }

  quit_ = (status, toThrow) => {
    process.exitCode = status;
    throw toThrow;
  };

} else

// Note that this includes Node.js workers when relevant (pthreads is enabled).
// Node.js workers are detected as a combination of ENVIRONMENT_IS_WORKER and
// ENVIRONMENT_IS_NODE.
if (ENVIRONMENT_IS_WEB || ENVIRONMENT_IS_WORKER) {
  try {
    scriptDirectory = new URL('.', _scriptName).href; // includes trailing slash
  } catch {
    // Must be a `blob:` or `data:` URL (e.g. `blob:http://site.com/etc/etc`), we cannot
    // infer anything from them.
  }

  {
// include: web_or_worker_shell_read.js
if (ENVIRONMENT_IS_WORKER) {
    readBinary = (url) => {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', url, false);
      xhr.responseType = 'arraybuffer';
      xhr.send(null);
      return new Uint8Array(/** @type{!ArrayBuffer} */(xhr.response));
    };
  }

  readAsync = async (url) => {
    // Fetch has some additional restrictions over XHR, like it can't be used on a file:// url.
    // See https://github.com/github/fetch/pull/92#issuecomment-140665932
    // Cordova or Electron apps are typically loaded from a file:// url.
    // So use XHR on webview if URL is a file URL.
    if (isFileURI(url)) {
      return new Promise((resolve, reject) => {
        var xhr = new XMLHttpRequest();
        xhr.open('GET', url, true);
        xhr.responseType = 'arraybuffer';
        xhr.onload = () => {
          if (xhr.status == 200 || (xhr.status == 0 && xhr.response)) { // file URLs can return 0
            resolve(xhr.response);
            return;
          }
          reject(xhr.status);
        };
        xhr.onerror = reject;
        xhr.send(null);
      });
    }
    var response = await fetch(url, { credentials: 'same-origin' });
    if (response.ok) {
      return response.arrayBuffer();
    }
    throw new Error(response.status + ' : ' + response.url);
  };
// end include: web_or_worker_shell_read.js
  }
} else
{
}

var out = console.log.bind(console);
var err = console.error.bind(console);

// end include: shell.js

// include: preamble.js
// === Preamble library stuff ===

// Documentation for the public APIs defined in this file must be updated in:
//    site/source/docs/api_reference/preamble.js.rst
// A prebuilt local version of the documentation is available at:
//    site/build/text/docs/api_reference/preamble.js.txt
// You can also build docs locally as HTML or other formats in site/
// An online HTML version (which may be of a different version of Emscripten)
//    is up at http://kripken.github.io/emscripten-site/docs/api_reference/preamble.js.html

var wasmBinary;

// Wasm globals

//========================================
// Runtime essentials
//========================================

// whether we are quitting the application. no code should run after this.
// set in exit() and abort()
var ABORT = false;

// set by exit() and abort().  Passed to 'onExit' handler.
// NOTE: This is also used as the process return code in shell environments
// but only when noExitRuntime is false.
var EXITSTATUS;

// In STRICT mode, we only define assert() when ASSERTIONS is set.  i.e. we
// don't define it at all in release modes.  This matches the behaviour of
// MINIMAL_RUNTIME.
// TODO(sbc): Make this the default even without STRICT enabled.
/** @type {function(*, string=)} */
function assert(condition, text) {
  if (!condition) {
    // This build was created without ASSERTIONS defined.  `assert()` should not
    // ever be called in this configuration but in case there are callers in
    // the wild leave this simple abort() implementation here for now.
    abort(text);
  }
}

/**
 * Indicates whether filename is delivered via file protocol (as opposed to http/https)
 * @noinline
 */
var isFileURI = (filename) => filename.startsWith('file://');

// include: runtime_common.js
// include: runtime_stack_check.js
// end include: runtime_stack_check.js
// include: runtime_exceptions.js
// end include: runtime_exceptions.js
// include: runtime_debug.js
// end include: runtime_debug.js
// Memory management
var
/** @type {!Int8Array} */
  HEAP8,
/** @type {!Uint8Array} */
  HEAPU8,
/** @type {!Int16Array} */
  HEAP16,
/** @type {!Uint16Array} */
  HEAPU16,
/** @type {!Int32Array} */
  HEAP32,
/** @type {!Uint32Array} */
  HEAPU32,
/** @type {!Float32Array} */
  HEAPF32,
/** @type {!Float64Array} */
  HEAPF64;

// BigInt64Array type is not correctly defined in closure
var
/** not-@type {!BigInt64Array} */
  HEAP64,
/* BigUint64Array type is not correctly defined in closure
/** not-@type {!BigUint64Array} */
  HEAPU64;

var runtimeInitialized = false;



function updateMemoryViews() {
  var b = wasmMemory.buffer;
  HEAP8 = new Int8Array(b);
  HEAP16 = new Int16Array(b);
  HEAPU8 = new Uint8Array(b);
  HEAPU16 = new Uint16Array(b);
  HEAP32 = new Int32Array(b);
  HEAPU32 = new Uint32Array(b);
  HEAPF32 = new Float32Array(b);
  HEAPF64 = new Float64Array(b);
  HEAP64 = new BigInt64Array(b);
  HEAPU64 = new BigUint64Array(b);
}

// include: memoryprofiler.js
// end include: memoryprofiler.js
// end include: runtime_common.js
function preRun() {
  if (Module['preRun']) {
    if (typeof Module['preRun'] == 'function') Module['preRun'] = [Module['preRun']];
    while (Module['preRun'].length) {
      addOnPreRun(Module['preRun'].shift());
    }
  }
  // Begin ATPRERUNS hooks
  callRuntimeCallbacks(onPreRuns);
  // End ATPRERUNS hooks
}

function initRuntime() {
  runtimeInitialized = true;

  // Begin ATINITS hooks
  SOCKFS.root = FS.mount(SOCKFS, {}, null);
if (!Module['noFSInit'] && !FS.initialized) FS.init();
TTY.init();
PIPEFS.root = FS.mount(PIPEFS, {}, null);
  // End ATINITS hooks

  wasmExports['__wasm_call_ctors']();

  // Begin ATPOSTCTORS hooks
  FS.ignorePermissions = false;
  // End ATPOSTCTORS hooks
}

function preMain() {
  // No ATMAINS hooks
}

function postRun() {
   // PThreads reuse the runtime from the main thread.

  if (Module['postRun']) {
    if (typeof Module['postRun'] == 'function') Module['postRun'] = [Module['postRun']];
    while (Module['postRun'].length) {
      addOnPostRun(Module['postRun'].shift());
    }
  }

  // Begin ATPOSTRUNS hooks
  callRuntimeCallbacks(onPostRuns);
  // End ATPOSTRUNS hooks
}

/** @param {string|number=} what */
function abort(what) {
  Module['onAbort']?.(what);

  what = 'Aborted(' + what + ')';
  // TODO(sbc): Should we remove printing and leave it up to whoever
  // catches the exception?
  err(what);

  ABORT = true;

  what += '. Build with -sASSERTIONS for more info.';

  // Use a wasm runtime error, because a JS error might be seen as a foreign
  // exception, which means we'd run destructors on it. We need the error to
  // simply make the program stop.
  // FIXME This approach does not work in Wasm EH because it currently does not assume
  // all RuntimeErrors are from traps; it decides whether a RuntimeError is from
  // a trap or not based on a hidden field within the object. So at the moment
  // we don't have a way of throwing a wasm trap from JS. TODO Make a JS API that
  // allows this in the wasm spec.

  // Suppress closure compiler warning here. Closure compiler's builtin extern
  // definition for WebAssembly.RuntimeError claims it takes no arguments even
  // though it can.
  // TODO(https://github.com/google/closure-compiler/pull/3913): Remove if/when upstream closure gets fixed.
  /** @suppress {checkTypes} */
  var e = new WebAssembly.RuntimeError(what);

  // Throw the error whether or not MODULARIZE is set because abort is used
  // in code paths apart from instantiation where an exception is expected
  // to be thrown when abort is called.
  throw e;
}

var wasmBinaryFile;

function findWasmBinary() {
  return locateFile('php.wasm');
}

function getBinarySync(file) {
  if (file == wasmBinaryFile && wasmBinary) {
    return new Uint8Array(wasmBinary);
  }
  if (readBinary) {
    return readBinary(file);
  }
  // Throwing a plain string here, even though it not normally advisable since
  // this gets turning into an `abort` in instantiateArrayBuffer.
  throw 'both async and sync fetching of the wasm failed';
}

async function getWasmBinary(binaryFile) {
  // If we don't have the binary yet, load it asynchronously using readAsync.
  if (!wasmBinary) {
    // Fetch the binary using readAsync
    try {
      var response = await readAsync(binaryFile);
      return new Uint8Array(response);
    } catch {
      // Fall back to getBinarySync below;
    }
  }

  // Otherwise, getBinarySync should be able to get it synchronously
  return getBinarySync(binaryFile);
}

async function instantiateArrayBuffer(binaryFile, imports) {
  try {
    var binary = await getWasmBinary(binaryFile);
    var instance = await WebAssembly.instantiate(binary, imports);
    return instance;
  } catch (reason) {
    err(`failed to asynchronously prepare wasm: ${reason}`);

    abort(reason);
  }
}

async function instantiateAsync(binary, binaryFile, imports) {
  if (!binary
      // Don't use streaming for file:// delivered objects in a webview, fetch them synchronously.
      && !isFileURI(binaryFile)
      // Avoid instantiateStreaming() on Node.js environment for now, as while
      // Node.js v18.1.0 implements it, it does not have a full fetch()
      // implementation yet.
      //
      // Reference:
      //   https://github.com/emscripten-core/emscripten/pull/16917
      && !ENVIRONMENT_IS_NODE
     ) {
    try {
      var response = fetch(binaryFile, { credentials: 'same-origin' });
      var instantiationResult = await WebAssembly.instantiateStreaming(response, imports);
      return instantiationResult;
    } catch (reason) {
      // We expect the most common failure cause to be a bad MIME type for the binary,
      // in which case falling back to ArrayBuffer instantiation should work.
      err(`wasm streaming compile failed: ${reason}`);
      err('falling back to ArrayBuffer instantiation');
      // fall back of instantiateArrayBuffer below
    };
  }
  return instantiateArrayBuffer(binaryFile, imports);
}

function getWasmImports() {
  // prepare imports
  var imports = {
    'env': wasmImports,
    'wasi_snapshot_preview1': wasmImports,
  };
  return imports;
}

// Create the wasm instance.
// Receives the wasm imports, returns the exports.
async function createWasm() {
  // Load the wasm module and create an instance of using native support in the JS engine.
  // handle a generated wasm instance, receiving its exports and
  // performing other necessary setup
  /** @param {WebAssembly.Module=} module*/
  function receiveInstance(instance, module) {
    wasmExports = instance.exports;

    assignWasmExports(wasmExports);

    updateMemoryViews();

    removeRunDependency('wasm-instantiate');
    return wasmExports;
  }
  addRunDependency('wasm-instantiate');

  // Prefer streaming instantiation if available.
  function receiveInstantiationResult(result) {
    // 'result' is a ResultObject object which has both the module and instance.
    // receiveInstance() will swap in the exports (to Module.asm) so they can be called
    // TODO: Due to Closure regression https://github.com/google/closure-compiler/issues/3193, the above line no longer optimizes out down to the following line.
    // When the regression is fixed, can restore the above PTHREADS-enabled path.
    return receiveInstance(result['instance']);
  }

  var info = getWasmImports();

  // User shell pages can write their own Module.instantiateWasm = function(imports, successCallback) callback
  // to manually instantiate the Wasm module themselves. This allows pages to
  // run the instantiation parallel to any other async startup actions they are
  // performing.
  // Also pthreads and wasm workers initialize the wasm instance through this
  // path.
  if (Module['instantiateWasm']) {
    return new Promise((resolve, reject) => {
        Module['instantiateWasm'](info, (inst, mod) => {
          resolve(receiveInstance(inst, mod));
        });
    });
  }

  wasmBinaryFile ??= findWasmBinary();
  var result = await instantiateAsync(wasmBinary, wasmBinaryFile, info);
  var exports = receiveInstantiationResult(result);
  return exports;
}

// end include: preamble.js

// Begin JS library code


  class ExitStatus {
      name = 'ExitStatus';
      constructor(status) {
        this.message = `Program terminated with exit(${status})`;
        this.status = status;
      }
    }

  var callRuntimeCallbacks = (callbacks) => {
      while (callbacks.length > 0) {
        // Pass the module as the first argument.
        callbacks.shift()(Module);
      }
    };
  var onPostRuns = [];
  var addOnPostRun = (cb) => onPostRuns.push(cb);

  var onPreRuns = [];
  var addOnPreRun = (cb) => onPreRuns.push(cb);

  var runDependencies = 0;
  
  
  var dependenciesFulfilled = null;
  var removeRunDependency = (id) => {
      runDependencies--;
  
      Module['monitorRunDependencies']?.(runDependencies);
  
      if (runDependencies == 0) {
        if (dependenciesFulfilled) {
          var callback = dependenciesFulfilled;
          dependenciesFulfilled = null;
          callback(); // can add another dependenciesFulfilled
        }
      }
    };
  var addRunDependency = (id) => {
      runDependencies++;
  
      Module['monitorRunDependencies']?.(runDependencies);
  
    };


  
    /**
   * @param {number} ptr
   * @param {string} type
   */
  function getValue(ptr, type = 'i8') {
    if (type.endsWith('*')) type = '*';
    switch (type) {
      case 'i1': return HEAP8[ptr];
      case 'i8': return HEAP8[ptr];
      case 'i16': return HEAP16[((ptr)>>1)];
      case 'i32': return HEAP32[((ptr)>>2)];
      case 'i64': return HEAP64[((ptr)>>3)];
      case 'float': return HEAPF32[((ptr)>>2)];
      case 'double': return HEAPF64[((ptr)>>3)];
      case '*': return HEAPU32[((ptr)>>2)];
      default: abort(`invalid type for getValue: ${type}`);
    }
  }

  var noExitRuntime = true;


  
    /**
   * @param {number} ptr
   * @param {number} value
   * @param {string} type
   */
  function setValue(ptr, value, type = 'i8') {
    if (type.endsWith('*')) type = '*';
    switch (type) {
      case 'i1': HEAP8[ptr] = value; break;
      case 'i8': HEAP8[ptr] = value; break;
      case 'i16': HEAP16[((ptr)>>1)] = value; break;
      case 'i32': HEAP32[((ptr)>>2)] = value; break;
      case 'i64': HEAP64[((ptr)>>3)] = BigInt(value); break;
      case 'float': HEAPF32[((ptr)>>2)] = value; break;
      case 'double': HEAPF64[((ptr)>>3)] = value; break;
      case '*': HEAPU32[((ptr)>>2)] = value; break;
      default: abort(`invalid type for setValue: ${type}`);
    }
  }

  var stackRestore = (val) => __emscripten_stack_restore(val);

  var stackSave = () => _emscripten_stack_get_current();

  

  var wasmTableMirror = [];
  
  
  var getWasmTableEntry = (funcPtr) => {
      var func = wasmTableMirror[funcPtr];
      if (!func) {
        /** @suppress {checkTypes} */
        wasmTableMirror[funcPtr] = func = wasmTable.get(funcPtr);
      }
      return func;
    };
  var ___call_sighandler = (fp, sig) => getWasmTableEntry(fp)(sig);

  var initRandomFill = () => {
      // This block is not needed on v19+ since crypto.getRandomValues is builtin
      if (ENVIRONMENT_IS_NODE) {
        var nodeCrypto = require('node:crypto');
        return (view) => nodeCrypto.randomFillSync(view);
      }
  
      return (view) => crypto.getRandomValues(view);
    };
  var randomFill = (view) => {
      // Lazily init on the first invocation.
      (randomFill = initRandomFill())(view);
    };
  
  var PATH = {
  isAbs:(path) => path.charAt(0) === '/',
  splitPath:(filename) => {
        var splitPathRe = /^(\/?|)([\s\S]*?)((?:\.{1,2}|[^\/]+?|)(\.[^.\/]*|))(?:[\/]*)$/;
        return splitPathRe.exec(filename).slice(1);
      },
  normalizeArray:(parts, allowAboveRoot) => {
        // if the path tries to go above the root, `up` ends up > 0
        var up = 0;
        for (var i = parts.length - 1; i >= 0; i--) {
          var last = parts[i];
          if (last === '.') {
            parts.splice(i, 1);
          } else if (last === '..') {
            parts.splice(i, 1);
            up++;
          } else if (up) {
            parts.splice(i, 1);
            up--;
          }
        }
        // if the path is allowed to go above the root, restore leading ..s
        if (allowAboveRoot) {
          for (; up; up--) {
            parts.unshift('..');
          }
        }
        return parts;
      },
  normalize:(path) => {
        var isAbsolute = PATH.isAbs(path),
            trailingSlash = path.slice(-1) === '/';
        // Normalize the path
        path = PATH.normalizeArray(path.split('/').filter((p) => !!p), !isAbsolute).join('/');
        if (!path && !isAbsolute) {
          path = '.';
        }
        if (path && trailingSlash) {
          path += '/';
        }
        return (isAbsolute ? '/' : '') + path;
      },
  dirname:(path) => {
        var result = PATH.splitPath(path),
            root = result[0],
            dir = result[1];
        if (!root && !dir) {
          // No dirname whatsoever
          return '.';
        }
        if (dir) {
          // It has a dirname, strip trailing slash
          dir = dir.slice(0, -1);
        }
        return root + dir;
      },
  basename:(path) => path && path.match(/([^\/]+|\/)\/*$/)[1],
join:(...paths) => PATH.normalize(paths.join('/')),
join2:(l, r) => PATH.normalize(l + '/' + r),
};


var PATH_FS = {
resolve:(...args) => {
      var resolvedPath = '',
        resolvedAbsolute = false;
      for (var i = args.length - 1; i >= -1 && !resolvedAbsolute; i--) {
        var path = (i >= 0) ? args[i] : FS.cwd();
        // Skip empty and invalid entries
        if (typeof path != 'string') {
          throw new TypeError('Arguments to path.resolve must be strings');
        } else if (!path) {
          return ''; // an invalid portion invalidates the whole thing
        }
        resolvedPath = path + '/' + resolvedPath;
        resolvedAbsolute = PATH.isAbs(path);
      }
      // At this point the path should be resolved to a full absolute path, but
      // handle relative paths to be safe (might happen when process.cwd() fails)
      resolvedPath = PATH.normalizeArray(resolvedPath.split('/').filter((p) => !!p), !resolvedAbsolute).join('/');
      return ((resolvedAbsolute ? '/' : '') + resolvedPath) || '.';
    },
relative:(from, to) => {
      from = PATH_FS.resolve(from).slice(1);
      to = PATH_FS.resolve(to).slice(1);
      function trim(arr) {
        var start = 0;
        for (; start < arr.length; start++) {
          if (arr[start] !== '') break;
        }
        var end = arr.length - 1;
        for (; end >= 0; end--) {
          if (arr[end] !== '') break;
        }
        if (start > end) return [];
        return arr.slice(start, end - start + 1);
      }
      var fromParts = trim(from.split('/'));
      var toParts = trim(to.split('/'));
      var length = Math.min(fromParts.length, toParts.length);
      var samePartsLength = length;
      for (var i = 0; i < length; i++) {
        if (fromParts[i] !== toParts[i]) {
          samePartsLength = i;
          break;
        }
      }
      var outputParts = [];
      for (var i = samePartsLength; i < fromParts.length; i++) {
        outputParts.push('..');
      }
      outputParts = outputParts.concat(toParts.slice(samePartsLength));
      return outputParts.join('/');
    },
};


var UTF8Decoder = globalThis.TextDecoder && new TextDecoder();

var findStringEnd = (heapOrArray, idx, maxBytesToRead, ignoreNul) => {
    var maxIdx = idx + maxBytesToRead;
    if (ignoreNul) return maxIdx;
    // TextDecoder needs to know the byte length in advance, it doesn't stop on
    // null terminator by itself.
    // As a tiny code save trick, compare idx against maxIdx using a negation,
    // so that maxBytesToRead=undefined/NaN means Infinity.
    while (heapOrArray[idx] && !(idx >= maxIdx)) ++idx;
    return idx;
  };

  /**
   * Given a pointer 'idx' to a null-terminated UTF8-encoded string in the given
   * array that contains uint8 values, returns a copy of that string as a
   * Javascript String object.
   * heapOrArray is either a regular array, or a JavaScript typed array view.
   * @param {number=} idx
   * @param {number=} maxBytesToRead
   * @param {boolean=} ignoreNul - If true, the function will not stop on a NUL character.
   * @return {string}
   */
  var UTF8ArrayToString = (heapOrArray, idx = 0, maxBytesToRead, ignoreNul) => {
  
      var endPtr = findStringEnd(heapOrArray, idx, maxBytesToRead, ignoreNul);
  
      // When using conditional TextDecoder, skip it for short strings as the overhead of the native call is not worth it.
      if (endPtr - idx > 16 && heapOrArray.buffer && UTF8Decoder) {
        return UTF8Decoder.decode(heapOrArray.subarray(idx, endPtr));
      }
      var str = '';
      while (idx < endPtr) {
        // For UTF8 byte structure, see:
        // http://en.wikipedia.org/wiki/UTF-8#Description
        // https://www.ietf.org/rfc/rfc2279.txt
        // https://tools.ietf.org/html/rfc3629
        var u0 = heapOrArray[idx++];
        if (!(u0 & 0x80)) { str += String.fromCharCode(u0); continue; }
        var u1 = heapOrArray[idx++] & 63;
        if ((u0 & 0xE0) == 0xC0) { str += String.fromCharCode(((u0 & 31) << 6) | u1); continue; }
        var u2 = heapOrArray[idx++] & 63;
        if ((u0 & 0xF0) == 0xE0) {
          u0 = ((u0 & 15) << 12) | (u1 << 6) | u2;
        } else {
          u0 = ((u0 & 7) << 18) | (u1 << 12) | (u2 << 6) | (heapOrArray[idx++] & 63);
        }
  
        if (u0 < 0x10000) {
          str += String.fromCharCode(u0);
        } else {
          var ch = u0 - 0x10000;
          str += String.fromCharCode(0xD800 | (ch >> 10), 0xDC00 | (ch & 0x3FF));
        }
      }
      return str;
    };
  
  var FS_stdin_getChar_buffer = [];
  
  var lengthBytesUTF8 = (str) => {
      var len = 0;
      for (var i = 0; i < str.length; ++i) {
        // Gotcha: charCodeAt returns a 16-bit word that is a UTF-16 encoded code
        // unit, not a Unicode code point of the character! So decode
        // UTF16->UTF32->UTF8.
        // See http://unicode.org/faq/utf_bom.html#utf16-3
        var c = str.charCodeAt(i); // possibly a lead surrogate
        if (c <= 0x7F) {
          len++;
        } else if (c <= 0x7FF) {
          len += 2;
        } else if (c >= 0xD800 && c <= 0xDFFF) {
          len += 4; ++i;
        } else {
          len += 3;
        }
      }
      return len;
    };
  
  var stringToUTF8Array = (str, heap, outIdx, maxBytesToWrite) => {
      // Parameter maxBytesToWrite is not optional. Negative values, 0, null,
      // undefined and false each don't write out any bytes.
      if (!(maxBytesToWrite > 0))
        return 0;
  
      var startIdx = outIdx;
      var endIdx = outIdx + maxBytesToWrite - 1; // -1 for string null terminator.
      for (var i = 0; i < str.length; ++i) {
        // For UTF8 byte structure, see http://en.wikipedia.org/wiki/UTF-8#Description
        // and https://www.ietf.org/rfc/rfc2279.txt
        // and https://tools.ietf.org/html/rfc3629
        var u = str.codePointAt(i);
        if (u <= 0x7F) {
          if (outIdx >= endIdx) break;
          heap[outIdx++] = u;
        } else if (u <= 0x7FF) {
          if (outIdx + 1 >= endIdx) break;
          heap[outIdx++] = 0xC0 | (u >> 6);
          heap[outIdx++] = 0x80 | (u & 63);
        } else if (u <= 0xFFFF) {
          if (outIdx + 2 >= endIdx) break;
          heap[outIdx++] = 0xE0 | (u >> 12);
          heap[outIdx++] = 0x80 | ((u >> 6) & 63);
          heap[outIdx++] = 0x80 | (u & 63);
        } else {
          if (outIdx + 3 >= endIdx) break;
          heap[outIdx++] = 0xF0 | (u >> 18);
          heap[outIdx++] = 0x80 | ((u >> 12) & 63);
          heap[outIdx++] = 0x80 | ((u >> 6) & 63);
          heap[outIdx++] = 0x80 | (u & 63);
          // Gotcha: if codePoint is over 0xFFFF, it is represented as a surrogate pair in UTF-16.
          // We need to manually skip over the second code unit for correct iteration.
          i++;
        }
      }
      // Null-terminate the pointer to the buffer.
      heap[outIdx] = 0;
      return outIdx - startIdx;
    };
  /** @type {function(string, boolean=, number=)} */
  var intArrayFromString = (stringy, dontAddNull, length) => {
      var len = length > 0 ? length : lengthBytesUTF8(stringy)+1;
      var u8array = new Array(len);
      var numBytesWritten = stringToUTF8Array(stringy, u8array, 0, u8array.length);
      if (dontAddNull) u8array.length = numBytesWritten;
      return u8array;
    };
  var FS_stdin_getChar = () => {
      if (!FS_stdin_getChar_buffer.length) {
        var result = null;
        if (ENVIRONMENT_IS_NODE) {
          // we will read data by chunks of BUFSIZE
          var BUFSIZE = 256;
          var buf = Buffer.alloc(BUFSIZE);
          var bytesRead = 0;
  
          // For some reason we must suppress a closure warning here, even though
          // fd definitely exists on process.stdin, and is even the proper way to
          // get the fd of stdin,
          // https://github.com/nodejs/help/issues/2136#issuecomment-523649904
          // This started to happen after moving this logic out of library_tty.js,
          // so it is related to the surrounding code in some unclear manner.
          /** @suppress {missingProperties} */
          var fd = process.stdin.fd;
  
          try {
            bytesRead = fs.readSync(fd, buf, 0, BUFSIZE);
          } catch(e) {
            // Cross-platform differences: on Windows, reading EOF throws an
            // exception, but on other OSes, reading EOF returns 0. Uniformize
            // behavior by treating the EOF exception to return 0.
            if (e.toString().includes('EOF')) bytesRead = 0;
            else throw e;
          }
  
          if (bytesRead > 0) {
            result = buf.slice(0, bytesRead).toString('utf-8');
          }
        } else
        if (globalThis.window?.prompt) {
          // Browser.
          result = window.prompt('Input: ');  // returns null on cancel
          if (result !== null) {
            result += '\n';
          }
        } else
        {}
        if (!result) {
          return null;
        }
        FS_stdin_getChar_buffer = intArrayFromString(result, true);
      }
      return FS_stdin_getChar_buffer.shift();
    };
  var TTY = {
  ttys:[],
  init() {
        // https://github.com/emscripten-core/emscripten/pull/1555
        // if (ENVIRONMENT_IS_NODE) {
        //   // currently, FS.init does not distinguish if process.stdin is a file or TTY
        //   // device, it always assumes it's a TTY device. because of this, we're forcing
        //   // process.stdin to UTF8 encoding to at least make stdin reading compatible
        //   // with text files until FS.init can be refactored.
        //   process.stdin.setEncoding('utf8');
        // }
      },
  shutdown() {
        // https://github.com/emscripten-core/emscripten/pull/1555
        // if (ENVIRONMENT_IS_NODE) {
        //   // inolen: any idea as to why node -e 'process.stdin.read()' wouldn't exit immediately (with process.stdin being a tty)?
        //   // isaacs: because now it's reading from the stream, you've expressed interest in it, so that read() kicks off a _read() which creates a ReadReq operation
        //   // inolen: I thought read() in that case was a synchronous operation that just grabbed some amount of buffered data if it exists?
        //   // isaacs: it is. but it also triggers a _read() call, which calls readStart() on the handle
        //   // isaacs: do process.stdin.pause() and i'd think it'd probably close the pending call
        //   process.stdin.pause();
        // }
      },
  register(dev, ops) {
        TTY.ttys[dev] = { input: [], output: [], ops: ops };
        FS.registerDevice(dev, TTY.stream_ops);
      },
  stream_ops:{
  open(stream) {
          var tty = TTY.ttys[stream.node.rdev];
          if (!tty) {
            throw new FS.ErrnoError(43);
          }
          stream.tty = tty;
          stream.seekable = false;
        },
  close(stream) {
          // flush any pending line data
          stream.tty.ops.fsync(stream.tty);
        },
  fsync(stream) {
          stream.tty.ops.fsync(stream.tty);
        },
  read(stream, buffer, offset, length, pos /* ignored */) {
          if (!stream.tty || !stream.tty.ops.get_char) {
            throw new FS.ErrnoError(60);
          }
          var bytesRead = 0;
          for (var i = 0; i < length; i++) {
            var result;
            try {
              result = stream.tty.ops.get_char(stream.tty);
            } catch (e) {
              throw new FS.ErrnoError(29);
            }
            if (result === undefined && bytesRead === 0) {
              throw new FS.ErrnoError(6);
            }
            if (result === null || result === undefined) break;
            bytesRead++;
            buffer[offset+i] = result;
          }
          if (bytesRead) {
            stream.node.atime = Date.now();
          }
          return bytesRead;
        },
  write(stream, buffer, offset, length, pos) {
          if (!stream.tty || !stream.tty.ops.put_char) {
            throw new FS.ErrnoError(60);
          }
          try {
            for (var i = 0; i < length; i++) {
              stream.tty.ops.put_char(stream.tty, buffer[offset+i]);
            }
          } catch (e) {
            throw new FS.ErrnoError(29);
          }
          if (length) {
            stream.node.mtime = stream.node.ctime = Date.now();
          }
          return i;
        },
  },
  default_tty_ops:{
  get_char(tty) {
          return FS_stdin_getChar();
        },
  put_char(tty, val) {
          if (val === null || val === 10) {
            out(UTF8ArrayToString(tty.output));
            tty.output = [];
          } else {
            if (val != 0) tty.output.push(val); // val == 0 would cut text output off in the middle.
          }
        },
  fsync(tty) {
          if (tty.output?.length > 0) {
            out(UTF8ArrayToString(tty.output));
            tty.output = [];
          }
        },
  ioctl_tcgets(tty) {
          // typical setting
          return {
            c_iflag: 25856,
            c_oflag: 5,
            c_cflag: 191,
            c_lflag: 35387,
            c_cc: [
              0x03, 0x1c, 0x7f, 0x15, 0x04, 0x00, 0x01, 0x00, 0x11, 0x13, 0x1a, 0x00,
              0x12, 0x0f, 0x17, 0x16, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
              0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            ]
          };
        },
  ioctl_tcsets(tty, optional_actions, data) {
          // currently just ignore
          return 0;
        },
  ioctl_tiocgwinsz(tty) {
          return [24, 80];
        },
  },
  default_tty1_ops:{
  put_char(tty, val) {
          if (val === null || val === 10) {
            err(UTF8ArrayToString(tty.output));
            tty.output = [];
          } else {
            if (val != 0) tty.output.push(val);
          }
        },
  fsync(tty) {
          if (tty.output?.length > 0) {
            err(UTF8ArrayToString(tty.output));
            tty.output = [];
          }
        },
  },
  };
  
  
  var zeroMemory = (ptr, size) => HEAPU8.fill(0, ptr, ptr + size);
  
  var alignMemory = (size, alignment) => {
      return Math.ceil(size / alignment) * alignment;
    };
  var mmapAlloc = (size) => {
      size = alignMemory(size, 65536);
      var ptr = _emscripten_builtin_memalign(65536, size);
      if (ptr) zeroMemory(ptr, size);
      return ptr;
    };
  var MEMFS = {
  ops_table:null,
  mount(mount) {
        return MEMFS.createNode(null, '/', 16895, 0);
      },
  createNode(parent, name, mode, dev) {
        if (FS.isBlkdev(mode) || FS.isFIFO(mode)) {
          // not supported
          throw new FS.ErrnoError(63);
        }
        MEMFS.ops_table ||= {
          dir: {
            node: {
              getattr: MEMFS.node_ops.getattr,
              setattr: MEMFS.node_ops.setattr,
              lookup: MEMFS.node_ops.lookup,
              mknod: MEMFS.node_ops.mknod,
              rename: MEMFS.node_ops.rename,
              unlink: MEMFS.node_ops.unlink,
              rmdir: MEMFS.node_ops.rmdir,
              readdir: MEMFS.node_ops.readdir,
              symlink: MEMFS.node_ops.symlink
            },
            stream: {
              llseek: MEMFS.stream_ops.llseek
            }
          },
          file: {
            node: {
              getattr: MEMFS.node_ops.getattr,
              setattr: MEMFS.node_ops.setattr
            },
            stream: {
              llseek: MEMFS.stream_ops.llseek,
              read: MEMFS.stream_ops.read,
              write: MEMFS.stream_ops.write,
              mmap: MEMFS.stream_ops.mmap,
              msync: MEMFS.stream_ops.msync
            }
          },
          link: {
            node: {
              getattr: MEMFS.node_ops.getattr,
              setattr: MEMFS.node_ops.setattr,
              readlink: MEMFS.node_ops.readlink
            },
            stream: {}
          },
          chrdev: {
            node: {
              getattr: MEMFS.node_ops.getattr,
              setattr: MEMFS.node_ops.setattr
            },
            stream: FS.chrdev_stream_ops
          }
        };
        var node = FS.createNode(parent, name, mode, dev);
        if (FS.isDir(node.mode)) {
          node.node_ops = MEMFS.ops_table.dir.node;
          node.stream_ops = MEMFS.ops_table.dir.stream;
          node.contents = {};
        } else if (FS.isFile(node.mode)) {
          node.node_ops = MEMFS.ops_table.file.node;
          node.stream_ops = MEMFS.ops_table.file.stream;
          node.usedBytes = 0; // The actual number of bytes used in the typed array, as opposed to contents.length which gives the whole capacity.
          // When the byte data of the file is populated, this will point to either a typed array, or a normal JS array. Typed arrays are preferred
          // for performance, and used by default. However, typed arrays are not resizable like normal JS arrays are, so there is a small disk size
          // penalty involved for appending file writes that continuously grow a file similar to std::vector capacity vs used -scheme.
          node.contents = null; 
        } else if (FS.isLink(node.mode)) {
          node.node_ops = MEMFS.ops_table.link.node;
          node.stream_ops = MEMFS.ops_table.link.stream;
        } else if (FS.isChrdev(node.mode)) {
          node.node_ops = MEMFS.ops_table.chrdev.node;
          node.stream_ops = MEMFS.ops_table.chrdev.stream;
        }
        node.atime = node.mtime = node.ctime = Date.now();
        // add the new node to the parent
        if (parent) {
          parent.contents[name] = node;
          parent.atime = parent.mtime = parent.ctime = node.atime;
        }
        return node;
      },
  getFileDataAsTypedArray(node) {
        if (!node.contents) return new Uint8Array(0);
        if (node.contents.subarray) return node.contents.subarray(0, node.usedBytes); // Make sure to not return excess unused bytes.
        return new Uint8Array(node.contents);
      },
  expandFileStorage(node, newCapacity) {
        var prevCapacity = node.contents ? node.contents.length : 0;
        if (prevCapacity >= newCapacity) return; // No need to expand, the storage was already large enough.
        // Don't expand strictly to the given requested limit if it's only a very small increase, but instead geometrically grow capacity.
        // For small filesizes (<1MB), perform size*2 geometric increase, but for large sizes, do a much more conservative size*1.125 increase to
        // avoid overshooting the allocation cap by a very large margin.
        var CAPACITY_DOUBLING_MAX = 1024 * 1024;
        newCapacity = Math.max(newCapacity, (prevCapacity * (prevCapacity < CAPACITY_DOUBLING_MAX ? 2.0 : 1.125)) >>> 0);
        if (prevCapacity != 0) newCapacity = Math.max(newCapacity, 256); // At minimum allocate 256b for each file when expanding.
        var oldContents = node.contents;
        node.contents = new Uint8Array(newCapacity); // Allocate new storage.
        if (node.usedBytes > 0) node.contents.set(oldContents.subarray(0, node.usedBytes), 0); // Copy old data over to the new storage.
      },
  resizeFileStorage(node, newSize) {
        if (node.usedBytes == newSize) return;
        if (newSize == 0) {
          node.contents = null; // Fully decommit when requesting a resize to zero.
          node.usedBytes = 0;
        } else {
          var oldContents = node.contents;
          node.contents = new Uint8Array(newSize); // Allocate new storage.
          if (oldContents) {
            node.contents.set(oldContents.subarray(0, Math.min(newSize, node.usedBytes))); // Copy old data over to the new storage.
          }
          node.usedBytes = newSize;
        }
      },
  node_ops:{
  getattr(node) {
          var attr = {};
          // device numbers reuse inode numbers.
          attr.dev = FS.isChrdev(node.mode) ? node.id : 1;
          attr.ino = node.id;
          attr.mode = node.mode;
          attr.nlink = 1;
          attr.uid = 0;
          attr.gid = 0;
          attr.rdev = node.rdev;
          if (FS.isDir(node.mode)) {
            attr.size = 4096;
          } else if (FS.isFile(node.mode)) {
            attr.size = node.usedBytes;
          } else if (FS.isLink(node.mode)) {
            attr.size = node.link.length;
          } else {
            attr.size = 0;
          }
          attr.atime = new Date(node.atime);
          attr.mtime = new Date(node.mtime);
          attr.ctime = new Date(node.ctime);
          // NOTE: In our implementation, st_blocks = Math.ceil(st_size/st_blksize),
          //       but this is not required by the standard.
          attr.blksize = 4096;
          attr.blocks = Math.ceil(attr.size / attr.blksize);
          return attr;
        },
  setattr(node, attr) {
          for (const key of ["mode", "atime", "mtime", "ctime"]) {
            if (attr[key] != null) {
              node[key] = attr[key];
            }
          }
          if (attr.size !== undefined) {
            MEMFS.resizeFileStorage(node, attr.size);
          }
        },
  lookup(parent, name) {
          // This error may happen quite a bit. To avoid overhead we reuse it (and
          // suffer a lack of stack info).
          if (!MEMFS.doesNotExistError) {
            MEMFS.doesNotExistError = new FS.ErrnoError(44);
            /** @suppress {checkTypes} */
            MEMFS.doesNotExistError.stack = '<generic error, no stack>';
          }
          throw MEMFS.doesNotExistError;
        },
  mknod(parent, name, mode, dev) {
          return MEMFS.createNode(parent, name, mode, dev);
        },
  rename(old_node, new_dir, new_name) {
          var new_node;
          try {
            new_node = FS.lookupNode(new_dir, new_name);
          } catch (e) {}
          if (new_node) {
            if (FS.isDir(old_node.mode)) {
              // if we're overwriting a directory at new_name, make sure it's empty.
              for (var i in new_node.contents) {
                throw new FS.ErrnoError(55);
              }
            }
            FS.hashRemoveNode(new_node);
          }
          // do the internal rewiring
          delete old_node.parent.contents[old_node.name];
          new_dir.contents[new_name] = old_node;
          old_node.name = new_name;
          new_dir.ctime = new_dir.mtime = old_node.parent.ctime = old_node.parent.mtime = Date.now();
        },
  unlink(parent, name) {
          delete parent.contents[name];
          parent.ctime = parent.mtime = Date.now();
        },
  rmdir(parent, name) {
          var node = FS.lookupNode(parent, name);
          for (var i in node.contents) {
            throw new FS.ErrnoError(55);
          }
          delete parent.contents[name];
          parent.ctime = parent.mtime = Date.now();
        },
  readdir(node) {
          return ['.', '..', ...Object.keys(node.contents)];
        },
  symlink(parent, newname, oldpath) {
          var node = MEMFS.createNode(parent, newname, 0o777 | 40960, 0);
          node.link = oldpath;
          return node;
        },
  readlink(node) {
          if (!FS.isLink(node.mode)) {
            throw new FS.ErrnoError(28);
          }
          return node.link;
        },
  },
  stream_ops:{
  read(stream, buffer, offset, length, position) {
          var contents = stream.node.contents;
          if (position >= stream.node.usedBytes) return 0;
          var size = Math.min(stream.node.usedBytes - position, length);
          if (size > 8 && contents.subarray) { // non-trivial, and typed array
            buffer.set(contents.subarray(position, position + size), offset);
          } else {
            for (var i = 0; i < size; i++) buffer[offset + i] = contents[position + i];
          }
          return size;
        },
  write(stream, buffer, offset, length, position, canOwn) {
          // If the buffer is located in main memory (HEAP), and if
          // memory can grow, we can't hold on to references of the
          // memory buffer, as they may get invalidated. That means we
          // need to copy its contents.
          if (buffer.buffer === HEAP8.buffer) {
            canOwn = false;
          }
  
          if (!length) return 0;
          var node = stream.node;
          node.mtime = node.ctime = Date.now();
  
          if (buffer.subarray && (!node.contents || node.contents.subarray)) { // This write is from a typed array to a typed array?
            if (canOwn) {
              node.contents = buffer.subarray(offset, offset + length);
              node.usedBytes = length;
              return length;
            } else if (node.usedBytes === 0 && position === 0) { // If this is a simple first write to an empty file, do a fast set since we don't need to care about old data.
              node.contents = buffer.slice(offset, offset + length);
              node.usedBytes = length;
              return length;
            } else if (position + length <= node.usedBytes) { // Writing to an already allocated and used subrange of the file?
              node.contents.set(buffer.subarray(offset, offset + length), position);
              return length;
            }
          }
  
          // Appending to an existing file and we need to reallocate, or source data did not come as a typed array.
          MEMFS.expandFileStorage(node, position+length);
          if (node.contents.subarray && buffer.subarray) {
            // Use typed array write which is available.
            node.contents.set(buffer.subarray(offset, offset + length), position);
          } else {
            for (var i = 0; i < length; i++) {
             node.contents[position + i] = buffer[offset + i]; // Or fall back to manual write if not.
            }
          }
          node.usedBytes = Math.max(node.usedBytes, position + length);
          return length;
        },
  llseek(stream, offset, whence) {
          var position = offset;
          if (whence === 1) {
            position += stream.position;
          } else if (whence === 2) {
            if (FS.isFile(stream.node.mode)) {
              position += stream.node.usedBytes;
            }
          }
          if (position < 0) {
            throw new FS.ErrnoError(28);
          }
          return position;
        },
  mmap(stream, length, position, prot, flags) {
          if (!FS.isFile(stream.node.mode)) {
            throw new FS.ErrnoError(43);
          }
          var ptr;
          var allocated;
          var contents = stream.node.contents;
          // Only make a new copy when MAP_PRIVATE is specified.
          if (!(flags & 2) && contents && contents.buffer === HEAP8.buffer) {
            // We can't emulate MAP_SHARED when the file is not backed by the
            // buffer we're mapping to (e.g. the HEAP buffer).
            allocated = false;
            ptr = contents.byteOffset;
          } else {
            allocated = true;
            ptr = mmapAlloc(length);
            if (!ptr) {
              throw new FS.ErrnoError(48);
            }
            if (contents) {
              // Try to avoid unnecessary slices.
              if (position > 0 || position + length < contents.length) {
                if (contents.subarray) {
                  contents = contents.subarray(position, position + length);
                } else {
                  contents = Array.prototype.slice.call(contents, position, position + length);
                }
              }
              HEAP8.set(contents, ptr);
            }
          }
          return { ptr, allocated };
        },
  msync(stream, buffer, offset, length, mmapFlags) {
          MEMFS.stream_ops.write(stream, buffer, 0, length, offset, false);
          // should we check if bytesWritten and length are the same?
          return 0;
        },
  },
  };
  
  var FS_modeStringToFlags = (str) => {
      var flagModes = {
        'r': 0,
        'r+': 2,
        'w': 512 | 64 | 1,
        'w+': 512 | 64 | 2,
        'a': 1024 | 64 | 1,
        'a+': 1024 | 64 | 2,
      };
      var flags = flagModes[str];
      if (typeof flags == 'undefined') {
        throw new Error(`Unknown file open mode: ${str}`);
      }
      return flags;
    };
  
  var FS_getMode = (canRead, canWrite) => {
      var mode = 0;
      if (canRead) mode |= 292 | 73;
      if (canWrite) mode |= 146;
      return mode;
    };
  
  
  var asyncLoad = async (url) => {
      var arrayBuffer = await readAsync(url);
      return new Uint8Array(arrayBuffer);
    };
  
  
  var FS_createDataFile = (...args) => FS.createDataFile(...args);
  
  var getUniqueRunDependency = (id) => {
      return id;
    };
  
  
  
  var preloadPlugins = [];
  var FS_handledByPreloadPlugin = async (byteArray, fullname) => {
      // Ensure plugins are ready.
      if (typeof Browser != 'undefined') Browser.init();
  
      for (var plugin of preloadPlugins) {
        if (plugin['canHandle'](fullname)) {
          return plugin['handle'](byteArray, fullname);
        }
      }
      // If no plugin handled this file then return the original/unmodified
      // byteArray.
      return byteArray;
    };
  var FS_preloadFile = async (parent, name, url, canRead, canWrite, dontCreateFile, canOwn, preFinish) => {
      // TODO we should allow people to just pass in a complete filename instead
      // of parent and name being that we just join them anyways
      var fullname = name ? PATH_FS.resolve(PATH.join2(parent, name)) : parent;
      var dep = getUniqueRunDependency(`cp ${fullname}`); // might have several active requests for the same fullname
      addRunDependency(dep);
  
      try {
        var byteArray = url;
        if (typeof url == 'string') {
          byteArray = await asyncLoad(url);
        }
  
        byteArray = await FS_handledByPreloadPlugin(byteArray, fullname);
        preFinish?.();
        if (!dontCreateFile) {
          FS_createDataFile(parent, name, byteArray, canRead, canWrite, canOwn);
        }
      } finally {
        removeRunDependency(dep);
      }
    };
  var FS_createPreloadedFile = (parent, name, url, canRead, canWrite, onload, onerror, dontCreateFile, canOwn, preFinish) => {
      FS_preloadFile(parent, name, url, canRead, canWrite, dontCreateFile, canOwn, preFinish).then(onload).catch(onerror);
    };
  var FS = {
  root:null,
  mounts:[],
  devices:{
  },
  streams:[],
  nextInode:1,
  nameTable:null,
  currentPath:"/",
  initialized:false,
  ignorePermissions:true,
  filesystems:null,
  syncFSRequests:0,
  readFiles:{
  },
  ErrnoError:class {
        name = 'ErrnoError';
        // We set the `name` property to be able to identify `FS.ErrnoError`
        // - the `name` is a standard ECMA-262 property of error objects. Kind of good to have it anyway.
        // - when using PROXYFS, an error can come from an underlying FS
        // as different FS objects have their own FS.ErrnoError each,
        // the test `err instanceof FS.ErrnoError` won't detect an error coming from another filesystem, causing bugs.
        // we'll use the reliable test `err.name == "ErrnoError"` instead
        constructor(errno) {
          this.errno = errno;
        }
      },
  FSStream:class {
        shared = {};
        get object() {
          return this.node;
        }
        set object(val) {
          this.node = val;
        }
        get isRead() {
          return (this.flags & 2097155) !== 1;
        }
        get isWrite() {
          return (this.flags & 2097155) !== 0;
        }
        get isAppend() {
          return (this.flags & 1024);
        }
        get flags() {
          return this.shared.flags;
        }
        set flags(val) {
          this.shared.flags = val;
        }
        get position() {
          return this.shared.position;
        }
        set position(val) {
          this.shared.position = val;
        }
      },
  FSNode:class {
        node_ops = {};
        stream_ops = {};
        readMode = 292 | 73;
        writeMode = 146;
        mounted = null;
        constructor(parent, name, mode, rdev) {
          if (!parent) {
            parent = this;  // root node sets parent to itself
          }
          this.parent = parent;
          this.mount = parent.mount;
          this.id = FS.nextInode++;
          this.name = name;
          this.mode = mode;
          this.rdev = rdev;
          this.atime = this.mtime = this.ctime = Date.now();
        }
        get read() {
          return (this.mode & this.readMode) === this.readMode;
        }
        set read(val) {
          val ? this.mode |= this.readMode : this.mode &= ~this.readMode;
        }
        get write() {
          return (this.mode & this.writeMode) === this.writeMode;
        }
        set write(val) {
          val ? this.mode |= this.writeMode : this.mode &= ~this.writeMode;
        }
        get isFolder() {
          return FS.isDir(this.mode);
        }
        get isDevice() {
          return FS.isChrdev(this.mode);
        }
      },
  lookupPath(path, opts = {}) {
        if (!path) {
          throw new FS.ErrnoError(44);
        }
        opts.follow_mount ??= true
  
        if (!PATH.isAbs(path)) {
          path = FS.cwd() + '/' + path;
        }
  
        // limit max consecutive symlinks to 40 (SYMLOOP_MAX).
        linkloop: for (var nlinks = 0; nlinks < 40; nlinks++) {
          // split the absolute path
          var parts = path.split('/').filter((p) => !!p);
  
          // start at the root
          var current = FS.root;
          var current_path = '/';
  
          for (var i = 0; i < parts.length; i++) {
            var islast = (i === parts.length-1);
            if (islast && opts.parent) {
              // stop resolving
              break;
            }
  
            if (parts[i] === '.') {
              continue;
            }
  
            if (parts[i] === '..') {
              current_path = PATH.dirname(current_path);
              if (FS.isRoot(current)) {
                path = current_path + '/' + parts.slice(i + 1).join('/');
                // We're making progress here, don't let many consecutive ..'s
                // lead to ELOOP
                nlinks--;
                continue linkloop;
              } else {
                current = current.parent;
              }
              continue;
            }
  
            current_path = PATH.join2(current_path, parts[i]);
            try {
              current = FS.lookupNode(current, parts[i]);
            } catch (e) {
              // if noent_okay is true, suppress a ENOENT in the last component
              // and return an object with an undefined node. This is needed for
              // resolving symlinks in the path when creating a file.
              if ((e?.errno === 44) && islast && opts.noent_okay) {
                return { path: current_path };
              }
              throw e;
            }
  
            // jump to the mount's root node if this is a mountpoint
            if (FS.isMountpoint(current) && (!islast || opts.follow_mount)) {
              current = current.mounted.root;
            }
  
            // by default, lookupPath will not follow a symlink if it is the final path component.
            // setting opts.follow = true will override this behavior.
            if (FS.isLink(current.mode) && (!islast || opts.follow)) {
              if (!current.node_ops.readlink) {
                throw new FS.ErrnoError(52);
              }
              var link = current.node_ops.readlink(current);
              if (!PATH.isAbs(link)) {
                link = PATH.dirname(current_path) + '/' + link;
              }
              path = link + '/' + parts.slice(i + 1).join('/');
              continue linkloop;
            }
          }
          return { path: current_path, node: current };
        }
        throw new FS.ErrnoError(32);
      },
  getPath(node) {
        var path;
        while (true) {
          if (FS.isRoot(node)) {
            var mount = node.mount.mountpoint;
            if (!path) return mount;
            return mount[mount.length-1] !== '/' ? `${mount}/${path}` : mount + path;
          }
          path = path ? `${node.name}/${path}` : node.name;
          node = node.parent;
        }
      },
  hashName(parentid, name) {
        var hash = 0;
  
        for (var i = 0; i < name.length; i++) {
          hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
        }
        return ((parentid + hash) >>> 0) % FS.nameTable.length;
      },
  hashAddNode(node) {
        var hash = FS.hashName(node.parent.id, node.name);
        node.name_next = FS.nameTable[hash];
        FS.nameTable[hash] = node;
      },
  hashRemoveNode(node) {
        var hash = FS.hashName(node.parent.id, node.name);
        if (FS.nameTable[hash] === node) {
          FS.nameTable[hash] = node.name_next;
        } else {
          var current = FS.nameTable[hash];
          while (current) {
            if (current.name_next === node) {
              current.name_next = node.name_next;
              break;
            }
            current = current.name_next;
          }
        }
      },
  lookupNode(parent, name) {
        var errCode = FS.mayLookup(parent);
        if (errCode) {
          throw new FS.ErrnoError(errCode);
        }
        var hash = FS.hashName(parent.id, name);
        for (var node = FS.nameTable[hash]; node; node = node.name_next) {
          var nodeName = node.name;
          if (node.parent.id === parent.id && nodeName === name) {
            return node;
          }
        }
        // if we failed to find it in the cache, call into the VFS
        return FS.lookup(parent, name);
      },
  createNode(parent, name, mode, rdev) {
        var node = new FS.FSNode(parent, name, mode, rdev);
  
        FS.hashAddNode(node);
  
        return node;
      },
  destroyNode(node) {
        FS.hashRemoveNode(node);
      },
  isRoot(node) {
        return node === node.parent;
      },
  isMountpoint(node) {
        return !!node.mounted;
      },
  isFile(mode) {
        return (mode & 61440) === 32768;
      },
  isDir(mode) {
        return (mode & 61440) === 16384;
      },
  isLink(mode) {
        return (mode & 61440) === 40960;
      },
  isChrdev(mode) {
        return (mode & 61440) === 8192;
      },
  isBlkdev(mode) {
        return (mode & 61440) === 24576;
      },
  isFIFO(mode) {
        return (mode & 61440) === 4096;
      },
  isSocket(mode) {
        return (mode & 49152) === 49152;
      },
  flagsToPermissionString(flag) {
        var perms = ['r', 'w', 'rw'][flag & 3];
        if ((flag & 512)) {
          perms += 'w';
        }
        return perms;
      },
  nodePermissions(node, perms) {
        if (FS.ignorePermissions) {
          return 0;
        }
        // return 0 if any user, group or owner bits are set.
        if (perms.includes('r') && !(node.mode & 292)) {
          return 2;
        } else if (perms.includes('w') && !(node.mode & 146)) {
          return 2;
        } else if (perms.includes('x') && !(node.mode & 73)) {
          return 2;
        }
        return 0;
      },
  mayLookup(dir) {
        if (!FS.isDir(dir.mode)) return 54;
        var errCode = FS.nodePermissions(dir, 'x');
        if (errCode) return errCode;
        if (!dir.node_ops.lookup) return 2;
        return 0;
      },
  mayCreate(dir, name) {
        if (!FS.isDir(dir.mode)) {
          return 54;
        }
        try {
          var node = FS.lookupNode(dir, name);
          return 20;
        } catch (e) {
        }
        return FS.nodePermissions(dir, 'wx');
      },
  mayDelete(dir, name, isdir) {
        var node;
        try {
          node = FS.lookupNode(dir, name);
        } catch (e) {
          return e.errno;
        }
        var errCode = FS.nodePermissions(dir, 'wx');
        if (errCode) {
          return errCode;
        }
        if (isdir) {
          if (!FS.isDir(node.mode)) {
            return 54;
          }
          if (FS.isRoot(node) || FS.getPath(node) === FS.cwd()) {
            return 10;
          }
        } else {
          if (FS.isDir(node.mode)) {
            return 31;
          }
        }
        return 0;
      },
  mayOpen(node, flags) {
        if (!node) {
          return 44;
        }
        if (FS.isLink(node.mode)) {
          return 32;
        } else if (FS.isDir(node.mode)) {
          if (FS.flagsToPermissionString(flags) !== 'r' // opening for write
              || (flags & (512 | 64))) { // TODO: check for O_SEARCH? (== search for dir only)
            return 31;
          }
        }
        return FS.nodePermissions(node, FS.flagsToPermissionString(flags));
      },
  checkOpExists(op, err) {
        if (!op) {
          throw new FS.ErrnoError(err);
        }
        return op;
      },
  MAX_OPEN_FDS:4096,
  nextfd() {
        for (var fd = 0; fd <= FS.MAX_OPEN_FDS; fd++) {
          if (!FS.streams[fd]) {
            return fd;
          }
        }
        throw new FS.ErrnoError(33);
      },
  getStreamChecked(fd) {
        var stream = FS.getStream(fd);
        if (!stream) {
          throw new FS.ErrnoError(8);
        }
        return stream;
      },
  getStream:(fd) => FS.streams[fd],
  createStream(stream, fd = -1) {
  
        // clone it, so we can return an instance of FSStream
        stream = Object.assign(new FS.FSStream(), stream);
        if (fd == -1) {
          fd = FS.nextfd();
        }
        stream.fd = fd;
        FS.streams[fd] = stream;
        return stream;
      },
  closeStream(fd) {
        FS.streams[fd] = null;
      },
  dupStream(origStream, fd = -1) {
        var stream = FS.createStream(origStream, fd);
        stream.stream_ops?.dup?.(stream);
        return stream;
      },
  doSetAttr(stream, node, attr) {
        var setattr = stream?.stream_ops.setattr;
        var arg = setattr ? stream : node;
        setattr ??= node.node_ops.setattr;
        FS.checkOpExists(setattr, 63)
        setattr(arg, attr);
      },
  chrdev_stream_ops:{
  open(stream) {
          var device = FS.getDevice(stream.node.rdev);
          // override node's stream ops with the device's
          stream.stream_ops = device.stream_ops;
          // forward the open call
          stream.stream_ops.open?.(stream);
        },
  llseek() {
          throw new FS.ErrnoError(70);
        },
  },
  major:(dev) => ((dev) >> 8),
  minor:(dev) => ((dev) & 0xff),
  makedev:(ma, mi) => ((ma) << 8 | (mi)),
  registerDevice(dev, ops) {
        FS.devices[dev] = { stream_ops: ops };
      },
  getDevice:(dev) => FS.devices[dev],
  getMounts(mount) {
        var mounts = [];
        var check = [mount];
  
        while (check.length) {
          var m = check.pop();
  
          mounts.push(m);
  
          check.push(...m.mounts);
        }
  
        return mounts;
      },
  syncfs(populate, callback) {
        if (typeof populate == 'function') {
          callback = populate;
          populate = false;
        }
  
        FS.syncFSRequests++;
  
        if (FS.syncFSRequests > 1) {
          err(`warning: ${FS.syncFSRequests} FS.syncfs operations in flight at once, probably just doing extra work`);
        }
  
        var mounts = FS.getMounts(FS.root.mount);
        var completed = 0;
  
        function doCallback(errCode) {
          FS.syncFSRequests--;
          return callback(errCode);
        }
  
        function done(errCode) {
          if (errCode) {
            if (!done.errored) {
              done.errored = true;
              return doCallback(errCode);
            }
            return;
          }
          if (++completed >= mounts.length) {
            doCallback(null);
          }
        };
  
        // sync all mounts
        for (var mount of mounts) {
          if (mount.type.syncfs) {
            mount.type.syncfs(mount, populate, done);
          } else {
            done(null);
          }
        }
      },
  mount(type, opts, mountpoint) {
        var root = mountpoint === '/';
        var pseudo = !mountpoint;
        var node;
  
        if (root && FS.root) {
          throw new FS.ErrnoError(10);
        } else if (!root && !pseudo) {
          var lookup = FS.lookupPath(mountpoint, { follow_mount: false });
  
          mountpoint = lookup.path;  // use the absolute path
          node = lookup.node;
  
          if (FS.isMountpoint(node)) {
            throw new FS.ErrnoError(10);
          }
  
          if (!FS.isDir(node.mode)) {
            throw new FS.ErrnoError(54);
          }
        }
  
        var mount = {
          type,
          opts,
          mountpoint,
          mounts: []
        };
  
        // create a root node for the fs
        var mountRoot = type.mount(mount);
        mountRoot.mount = mount;
        mount.root = mountRoot;
  
        if (root) {
          FS.root = mountRoot;
        } else if (node) {
          // set as a mountpoint
          node.mounted = mount;
  
          // add the new mount to the current mount's children
          if (node.mount) {
            node.mount.mounts.push(mount);
          }
        }
  
        return mountRoot;
      },
  unmount(mountpoint) {
        var lookup = FS.lookupPath(mountpoint, { follow_mount: false });
  
        if (!FS.isMountpoint(lookup.node)) {
          throw new FS.ErrnoError(28);
        }
  
        // destroy the nodes for this mount, and all its child mounts
        var node = lookup.node;
        var mount = node.mounted;
        var mounts = FS.getMounts(mount);
  
        for (var [hash, current] of Object.entries(FS.nameTable)) {
          while (current) {
            var next = current.name_next;
  
            if (mounts.includes(current.mount)) {
              FS.destroyNode(current);
            }
  
            current = next;
          }
        }
  
        // no longer a mountpoint
        node.mounted = null;
  
        // remove this mount from the child mounts
        var idx = node.mount.mounts.indexOf(mount);
        node.mount.mounts.splice(idx, 1);
      },
  lookup(parent, name) {
        return parent.node_ops.lookup(parent, name);
      },
  mknod(path, mode, dev) {
        var lookup = FS.lookupPath(path, { parent: true });
        var parent = lookup.node;
        var name = PATH.basename(path);
        if (!name) {
          throw new FS.ErrnoError(28);
        }
        if (name === '.' || name === '..') {
          throw new FS.ErrnoError(20);
        }
        var errCode = FS.mayCreate(parent, name);
        if (errCode) {
          throw new FS.ErrnoError(errCode);
        }
        if (!parent.node_ops.mknod) {
          throw new FS.ErrnoError(63);
        }
        return parent.node_ops.mknod(parent, name, mode, dev);
      },
  statfs(path) {
        return FS.statfsNode(FS.lookupPath(path, {follow: true}).node);
      },
  statfsStream(stream) {
        // We keep a separate statfsStream function because noderawfs overrides
        // it. In noderawfs, stream.node is sometimes null. Instead, we need to
        // look at stream.path.
        return FS.statfsNode(stream.node);
      },
  statfsNode(node) {
        // NOTE: None of the defaults here are true. We're just returning safe and
        //       sane values. Currently nodefs and rawfs replace these defaults,
        //       other file systems leave them alone.
        var rtn = {
          bsize: 4096,
          frsize: 4096,
          blocks: 1e6,
          bfree: 5e5,
          bavail: 5e5,
          files: FS.nextInode,
          ffree: FS.nextInode - 1,
          fsid: 42,
          flags: 2,
          namelen: 255,
        };
  
        if (node.node_ops.statfs) {
          Object.assign(rtn, node.node_ops.statfs(node.mount.opts.root));
        }
        return rtn;
      },
  create(path, mode = 0o666) {
        mode &= 4095;
        mode |= 32768;
        return FS.mknod(path, mode, 0);
      },
  mkdir(path, mode = 0o777) {
        mode &= 511 | 512;
        mode |= 16384;
        return FS.mknod(path, mode, 0);
      },
  mkdirTree(path, mode) {
        var dirs = path.split('/');
        var d = '';
        for (var dir of dirs) {
          if (!dir) continue;
          if (d || PATH.isAbs(path)) d += '/';
          d += dir;
          try {
            FS.mkdir(d, mode);
          } catch(e) {
            if (e.errno != 20) throw e;
          }
        }
      },
  mkdev(path, mode, dev) {
        if (typeof dev == 'undefined') {
          dev = mode;
          mode = 0o666;
        }
        mode |= 8192;
        return FS.mknod(path, mode, dev);
      },
  symlink(oldpath, newpath) {
        if (!PATH_FS.resolve(oldpath)) {
          throw new FS.ErrnoError(44);
        }
        var lookup = FS.lookupPath(newpath, { parent: true });
        var parent = lookup.node;
        if (!parent) {
          throw new FS.ErrnoError(44);
        }
        var newname = PATH.basename(newpath);
        var errCode = FS.mayCreate(parent, newname);
        if (errCode) {
          throw new FS.ErrnoError(errCode);
        }
        if (!parent.node_ops.symlink) {
          throw new FS.ErrnoError(63);
        }
        return parent.node_ops.symlink(parent, newname, oldpath);
      },
  rename(old_path, new_path) {
        var old_dirname = PATH.dirname(old_path);
        var new_dirname = PATH.dirname(new_path);
        var old_name = PATH.basename(old_path);
        var new_name = PATH.basename(new_path);
        // parents must exist
        var lookup, old_dir, new_dir;
  
        // let the errors from non existent directories percolate up
        lookup = FS.lookupPath(old_path, { parent: true });
        old_dir = lookup.node;
        lookup = FS.lookupPath(new_path, { parent: true });
        new_dir = lookup.node;
  
        if (!old_dir || !new_dir) throw new FS.ErrnoError(44);
        // need to be part of the same mount
        if (old_dir.mount !== new_dir.mount) {
          throw new FS.ErrnoError(75);
        }
        // source must exist
        var old_node = FS.lookupNode(old_dir, old_name);
        // old path should not be an ancestor of the new path
        var relative = PATH_FS.relative(old_path, new_dirname);
        if (relative.charAt(0) !== '.') {
          throw new FS.ErrnoError(28);
        }
        // new path should not be an ancestor of the old path
        relative = PATH_FS.relative(new_path, old_dirname);
        if (relative.charAt(0) !== '.') {
          throw new FS.ErrnoError(55);
        }
        // see if the new path already exists
        var new_node;
        try {
          new_node = FS.lookupNode(new_dir, new_name);
        } catch (e) {
          // not fatal
        }
        // early out if nothing needs to change
        if (old_node === new_node) {
          return;
        }
        // we'll need to delete the old entry
        var isdir = FS.isDir(old_node.mode);
        var errCode = FS.mayDelete(old_dir, old_name, isdir);
        if (errCode) {
          throw new FS.ErrnoError(errCode);
        }
        // need delete permissions if we'll be overwriting.
        // need create permissions if new doesn't already exist.
        errCode = new_node ?
          FS.mayDelete(new_dir, new_name, isdir) :
          FS.mayCreate(new_dir, new_name);
        if (errCode) {
          throw new FS.ErrnoError(errCode);
        }
        if (!old_dir.node_ops.rename) {
          throw new FS.ErrnoError(63);
        }
        if (FS.isMountpoint(old_node) || (new_node && FS.isMountpoint(new_node))) {
          throw new FS.ErrnoError(10);
        }
        // if we are going to change the parent, check write permissions
        if (new_dir !== old_dir) {
          errCode = FS.nodePermissions(old_dir, 'w');
          if (errCode) {
            throw new FS.ErrnoError(errCode);
          }
        }
        // remove the node from the lookup hash
        FS.hashRemoveNode(old_node);
        // do the underlying fs rename
        try {
          old_dir.node_ops.rename(old_node, new_dir, new_name);
          // update old node (we do this here to avoid each backend
          // needing to)
          old_node.parent = new_dir;
        } catch (e) {
          throw e;
        } finally {
          // add the node back to the hash (in case node_ops.rename
          // changed its name)
          FS.hashAddNode(old_node);
        }
      },
  rmdir(path) {
        var lookup = FS.lookupPath(path, { parent: true });
        var parent = lookup.node;
        var name = PATH.basename(path);
        var node = FS.lookupNode(parent, name);
        var errCode = FS.mayDelete(parent, name, true);
        if (errCode) {
          throw new FS.ErrnoError(errCode);
        }
        if (!parent.node_ops.rmdir) {
          throw new FS.ErrnoError(63);
        }
        if (FS.isMountpoint(node)) {
          throw new FS.ErrnoError(10);
        }
        parent.node_ops.rmdir(parent, name);
        FS.destroyNode(node);
      },
  readdir(path) {
        var lookup = FS.lookupPath(path, { follow: true });
        var node = lookup.node;
        var readdir = FS.checkOpExists(node.node_ops.readdir, 54);
        return readdir(node);
      },
  unlink(path) {
        var lookup = FS.lookupPath(path, { parent: true });
        var parent = lookup.node;
        if (!parent) {
          throw new FS.ErrnoError(44);
        }
        var name = PATH.basename(path);
        var node = FS.lookupNode(parent, name);
        var errCode = FS.mayDelete(parent, name, false);
        if (errCode) {
          // According to POSIX, we should map EISDIR to EPERM, but
          // we instead do what Linux does (and we must, as we use
          // the musl linux libc).
          throw new FS.ErrnoError(errCode);
        }
        if (!parent.node_ops.unlink) {
          throw new FS.ErrnoError(63);
        }
        if (FS.isMountpoint(node)) {
          throw new FS.ErrnoError(10);
        }
        parent.node_ops.unlink(parent, name);
        FS.destroyNode(node);
      },
  readlink(path) {
        var lookup = FS.lookupPath(path);
        var link = lookup.node;
        if (!link) {
          throw new FS.ErrnoError(44);
        }
        if (!link.node_ops.readlink) {
          throw new FS.ErrnoError(28);
        }
        return link.node_ops.readlink(link);
      },
  stat(path, dontFollow) {
        var lookup = FS.lookupPath(path, { follow: !dontFollow });
        var node = lookup.node;
        var getattr = FS.checkOpExists(node.node_ops.getattr, 63);
        return getattr(node);
      },
  fstat(fd) {
        var stream = FS.getStreamChecked(fd);
        var node = stream.node;
        var getattr = stream.stream_ops.getattr;
        var arg = getattr ? stream : node;
        getattr ??= node.node_ops.getattr;
        FS.checkOpExists(getattr, 63)
        return getattr(arg);
      },
  lstat(path) {
        return FS.stat(path, true);
      },
  doChmod(stream, node, mode, dontFollow) {
        FS.doSetAttr(stream, node, {
          mode: (mode & 4095) | (node.mode & ~4095),
          ctime: Date.now(),
          dontFollow
        });
      },
  chmod(path, mode, dontFollow) {
        var node;
        if (typeof path == 'string') {
          var lookup = FS.lookupPath(path, { follow: !dontFollow });
          node = lookup.node;
        } else {
          node = path;
        }
        FS.doChmod(null, node, mode, dontFollow);
      },
  lchmod(path, mode) {
        FS.chmod(path, mode, true);
      },
  fchmod(fd, mode) {
        var stream = FS.getStreamChecked(fd);
        FS.doChmod(stream, stream.node, mode, false);
      },
  doChown(stream, node, dontFollow) {
        FS.doSetAttr(stream, node, {
          timestamp: Date.now(),
          dontFollow
          // we ignore the uid / gid for now
        });
      },
  chown(path, uid, gid, dontFollow) {
        var node;
        if (typeof path == 'string') {
          var lookup = FS.lookupPath(path, { follow: !dontFollow });
          node = lookup.node;
        } else {
          node = path;
        }
        FS.doChown(null, node, dontFollow);
      },
  lchown(path, uid, gid) {
        FS.chown(path, uid, gid, true);
      },
  fchown(fd, uid, gid) {
        var stream = FS.getStreamChecked(fd);
        FS.doChown(stream, stream.node, false);
      },
  doTruncate(stream, node, len) {
        if (FS.isDir(node.mode)) {
          throw new FS.ErrnoError(31);
        }
        if (!FS.isFile(node.mode)) {
          throw new FS.ErrnoError(28);
        }
        var errCode = FS.nodePermissions(node, 'w');
        if (errCode) {
          throw new FS.ErrnoError(errCode);
        }
        FS.doSetAttr(stream, node, {
          size: len,
          timestamp: Date.now()
        });
      },
  truncate(path, len) {
        if (len < 0) {
          throw new FS.ErrnoError(28);
        }
        var node;
        if (typeof path == 'string') {
          var lookup = FS.lookupPath(path, { follow: true });
          node = lookup.node;
        } else {
          node = path;
        }
        FS.doTruncate(null, node, len);
      },
  ftruncate(fd, len) {
        var stream = FS.getStreamChecked(fd);
        if (len < 0 || (stream.flags & 2097155) === 0) {
          throw new FS.ErrnoError(28);
        }
        FS.doTruncate(stream, stream.node, len);
      },
  utime(path, atime, mtime) {
        var lookup = FS.lookupPath(path, { follow: true });
        var node = lookup.node;
        var setattr = FS.checkOpExists(node.node_ops.setattr, 63);
        setattr(node, {
          atime: atime,
          mtime: mtime
        });
      },
  open(path, flags, mode = 0o666) {
        if (path === "") {
          throw new FS.ErrnoError(44);
        }
        flags = typeof flags == 'string' ? FS_modeStringToFlags(flags) : flags;
        if ((flags & 64)) {
          mode = (mode & 4095) | 32768;
        } else {
          mode = 0;
        }
        var node;
        var isDirPath;
        if (typeof path == 'object') {
          node = path;
        } else {
          isDirPath = path.endsWith("/");
          // noent_okay makes it so that if the final component of the path
          // doesn't exist, lookupPath returns `node: undefined`. `path` will be
          // updated to point to the target of all symlinks.
          var lookup = FS.lookupPath(path, {
            follow: !(flags & 131072),
            noent_okay: true
          });
          node = lookup.node;
          path = lookup.path;
        }
        // perhaps we need to create the node
        var created = false;
        if ((flags & 64)) {
          if (node) {
            // if O_CREAT and O_EXCL are set, error out if the node already exists
            if ((flags & 128)) {
              throw new FS.ErrnoError(20);
            }
          } else if (isDirPath) {
            throw new FS.ErrnoError(31);
          } else {
            // node doesn't exist, try to create it
            // Ignore the permission bits here to ensure we can `open` this new
            // file below. We use chmod below to apply the permissions once the
            // file is open.
            node = FS.mknod(path, mode | 0o777, 0);
            created = true;
          }
        }
        if (!node) {
          throw new FS.ErrnoError(44);
        }
        // can't truncate a device
        if (FS.isChrdev(node.mode)) {
          flags &= ~512;
        }
        // if asked only for a directory, then this must be one
        if ((flags & 65536) && !FS.isDir(node.mode)) {
          throw new FS.ErrnoError(54);
        }
        // check permissions, if this is not a file we just created now (it is ok to
        // create and write to a file with read-only permissions; it is read-only
        // for later use)
        if (!created) {
          var errCode = FS.mayOpen(node, flags);
          if (errCode) {
            throw new FS.ErrnoError(errCode);
          }
        }
        // do truncation if necessary
        if ((flags & 512) && !created) {
          FS.truncate(node, 0);
        }
        // we've already handled these, don't pass down to the underlying vfs
        flags &= ~(128 | 512 | 131072);
  
        // register the stream with the filesystem
        var stream = FS.createStream({
          node,
          path: FS.getPath(node),  // we want the absolute path to the node
          flags,
          seekable: true,
          position: 0,
          stream_ops: node.stream_ops,
          // used by the file family libc calls (fopen, fwrite, ferror, etc.)
          ungotten: [],
          error: false
        });
        // call the new stream's open function
        if (stream.stream_ops.open) {
          stream.stream_ops.open(stream);
        }
        if (created) {
          FS.chmod(node, mode & 0o777);
        }
        if (Module['logReadFiles'] && !(flags & 1)) {
          if (!(path in FS.readFiles)) {
            FS.readFiles[path] = 1;
          }
        }
        return stream;
      },
  close(stream) {
        if (FS.isClosed(stream)) {
          throw new FS.ErrnoError(8);
        }
        if (stream.getdents) stream.getdents = null; // free readdir state
        try {
          if (stream.stream_ops.close) {
            stream.stream_ops.close(stream);
          }
        } catch (e) {
          throw e;
        } finally {
          FS.closeStream(stream.fd);
        }
        stream.fd = null;
      },
  isClosed(stream) {
        return stream.fd === null;
      },
  llseek(stream, offset, whence) {
        if (FS.isClosed(stream)) {
          throw new FS.ErrnoError(8);
        }
        if (!stream.seekable || !stream.stream_ops.llseek) {
          throw new FS.ErrnoError(70);
        }
        if (whence != 0 && whence != 1 && whence != 2) {
          throw new FS.ErrnoError(28);
        }
        stream.position = stream.stream_ops.llseek(stream, offset, whence);
        stream.ungotten = [];
        return stream.position;
      },
  read(stream, buffer, offset, length, position) {
        if (length < 0 || position < 0) {
          throw new FS.ErrnoError(28);
        }
        if (FS.isClosed(stream)) {
          throw new FS.ErrnoError(8);
        }
        if ((stream.flags & 2097155) === 1) {
          throw new FS.ErrnoError(8);
        }
        if (FS.isDir(stream.node.mode)) {
          throw new FS.ErrnoError(31);
        }
        if (!stream.stream_ops.read) {
          throw new FS.ErrnoError(28);
        }
        var seeking = typeof position != 'undefined';
        if (!seeking) {
          position = stream.position;
        } else if (!stream.seekable) {
          throw new FS.ErrnoError(70);
        }
        var bytesRead = stream.stream_ops.read(stream, buffer, offset, length, position);
        if (!seeking) stream.position += bytesRead;
        return bytesRead;
      },
  write(stream, buffer, offset, length, position, canOwn) {
        if (length < 0 || position < 0) {
          throw new FS.ErrnoError(28);
        }
        if (FS.isClosed(stream)) {
          throw new FS.ErrnoError(8);
        }
        if ((stream.flags & 2097155) === 0) {
          throw new FS.ErrnoError(8);
        }
        if (FS.isDir(stream.node.mode)) {
          throw new FS.ErrnoError(31);
        }
        if (!stream.stream_ops.write) {
          throw new FS.ErrnoError(28);
        }
        if (stream.seekable && stream.flags & 1024) {
          // seek to the end before writing in append mode
          FS.llseek(stream, 0, 2);
        }
        var seeking = typeof position != 'undefined';
        if (!seeking) {
          position = stream.position;
        } else if (!stream.seekable) {
          throw new FS.ErrnoError(70);
        }
        var bytesWritten = stream.stream_ops.write(stream, buffer, offset, length, position, canOwn);
        if (!seeking) stream.position += bytesWritten;
        return bytesWritten;
      },
  mmap(stream, length, position, prot, flags) {
        // User requests writing to file (prot & PROT_WRITE != 0).
        // Checking if we have permissions to write to the file unless
        // MAP_PRIVATE flag is set. According to POSIX spec it is possible
        // to write to file opened in read-only mode with MAP_PRIVATE flag,
        // as all modifications will be visible only in the memory of
        // the current process.
        if ((prot & 2) !== 0
            && (flags & 2) === 0
            && (stream.flags & 2097155) !== 2) {
          throw new FS.ErrnoError(2);
        }
        if ((stream.flags & 2097155) === 1) {
          throw new FS.ErrnoError(2);
        }
        if (!stream.stream_ops.mmap) {
          throw new FS.ErrnoError(43);
        }
        if (!length) {
          throw new FS.ErrnoError(28);
        }
        return stream.stream_ops.mmap(stream, length, position, prot, flags);
      },
  msync(stream, buffer, offset, length, mmapFlags) {
        if (!stream.stream_ops.msync) {
          return 0;
        }
        return stream.stream_ops.msync(stream, buffer, offset, length, mmapFlags);
      },
  ioctl(stream, cmd, arg) {
        if (!stream.stream_ops.ioctl) {
          throw new FS.ErrnoError(59);
        }
        return stream.stream_ops.ioctl(stream, cmd, arg);
      },
  readFile(path, opts = {}) {
        opts.flags = opts.flags || 0;
        opts.encoding = opts.encoding || 'binary';
        if (opts.encoding !== 'utf8' && opts.encoding !== 'binary') {
          abort(`Invalid encoding type "${opts.encoding}"`);
        }
        var stream = FS.open(path, opts.flags);
        var stat = FS.stat(path);
        var length = stat.size;
        var buf = new Uint8Array(length);
        FS.read(stream, buf, 0, length, 0);
        if (opts.encoding === 'utf8') {
          buf = UTF8ArrayToString(buf);
        }
        FS.close(stream);
        return buf;
      },
  writeFile(path, data, opts = {}) {
        opts.flags = opts.flags || 577;
        var stream = FS.open(path, opts.flags, opts.mode);
        if (typeof data == 'string') {
          data = new Uint8Array(intArrayFromString(data, true));
        }
        if (ArrayBuffer.isView(data)) {
          FS.write(stream, data, 0, data.byteLength, undefined, opts.canOwn);
        } else {
          abort('Unsupported data type');
        }
        FS.close(stream);
      },
  cwd:() => FS.currentPath,
  chdir(path) {
        var lookup = FS.lookupPath(path, { follow: true });
        if (lookup.node === null) {
          throw new FS.ErrnoError(44);
        }
        if (!FS.isDir(lookup.node.mode)) {
          throw new FS.ErrnoError(54);
        }
        var errCode = FS.nodePermissions(lookup.node, 'x');
        if (errCode) {
          throw new FS.ErrnoError(errCode);
        }
        FS.currentPath = lookup.path;
      },
  createDefaultDirectories() {
        FS.mkdir('/tmp');
        FS.mkdir('/home');
        FS.mkdir('/home/web_user');
      },
  createDefaultDevices() {
        // create /dev
        FS.mkdir('/dev');
        // setup /dev/null
        FS.registerDevice(FS.makedev(1, 3), {
          read: () => 0,
          write: (stream, buffer, offset, length, pos) => length,
          llseek: () => 0,
        });
        FS.mkdev('/dev/null', FS.makedev(1, 3));
        // setup /dev/tty and /dev/tty1
        // stderr needs to print output using err() rather than out()
        // so we register a second tty just for it.
        TTY.register(FS.makedev(5, 0), TTY.default_tty_ops);
        TTY.register(FS.makedev(6, 0), TTY.default_tty1_ops);
        FS.mkdev('/dev/tty', FS.makedev(5, 0));
        FS.mkdev('/dev/tty1', FS.makedev(6, 0));
        // setup /dev/[u]random
        // use a buffer to avoid overhead of individual crypto calls per byte
        var randomBuffer = new Uint8Array(1024), randomLeft = 0;
        var randomByte = () => {
          if (randomLeft === 0) {
            randomFill(randomBuffer);
            randomLeft = randomBuffer.byteLength;
          }
          return randomBuffer[--randomLeft];
        };
        FS.createDevice('/dev', 'random', randomByte);
        FS.createDevice('/dev', 'urandom', randomByte);
        // we're not going to emulate the actual shm device,
        // just create the tmp dirs that reside in it commonly
        FS.mkdir('/dev/shm');
        FS.mkdir('/dev/shm/tmp');
      },
  createSpecialDirectories() {
        // create /proc/self/fd which allows /proc/self/fd/6 => readlink gives the
        // name of the stream for fd 6 (see test_unistd_ttyname)
        FS.mkdir('/proc');
        var proc_self = FS.mkdir('/proc/self');
        FS.mkdir('/proc/self/fd');
        FS.mount({
          mount() {
            var node = FS.createNode(proc_self, 'fd', 16895, 73);
            node.stream_ops = {
              llseek: MEMFS.stream_ops.llseek,
            };
            node.node_ops = {
              lookup(parent, name) {
                var fd = +name;
                var stream = FS.getStreamChecked(fd);
                var ret = {
                  parent: null,
                  mount: { mountpoint: 'fake' },
                  node_ops: { readlink: () => stream.path },
                  id: fd + 1,
                };
                ret.parent = ret; // make it look like a simple root node
                return ret;
              },
              readdir() {
                return Array.from(FS.streams.entries())
                  .filter(([k, v]) => v)
                  .map(([k, v]) => k.toString());
              }
            };
            return node;
          }
        }, {}, '/proc/self/fd');
      },
  createStandardStreams(input, output, error) {
        // TODO deprecate the old functionality of a single
        // input / output callback and that utilizes FS.createDevice
        // and instead require a unique set of stream ops
  
        // by default, we symlink the standard streams to the
        // default tty devices. however, if the standard streams
        // have been overwritten we create a unique device for
        // them instead.
        if (input) {
          FS.createDevice('/dev', 'stdin', input);
        } else {
          FS.symlink('/dev/tty', '/dev/stdin');
        }
        if (output) {
          FS.createDevice('/dev', 'stdout', null, output);
        } else {
          FS.symlink('/dev/tty', '/dev/stdout');
        }
        if (error) {
          FS.createDevice('/dev', 'stderr', null, error);
        } else {
          FS.symlink('/dev/tty1', '/dev/stderr');
        }
  
        // open default streams for the stdin, stdout and stderr devices
        var stdin = FS.open('/dev/stdin', 0);
        var stdout = FS.open('/dev/stdout', 1);
        var stderr = FS.open('/dev/stderr', 1);
      },
  staticInit() {
        FS.nameTable = new Array(4096);
  
        FS.mount(MEMFS, {}, '/');
  
        FS.createDefaultDirectories();
        FS.createDefaultDevices();
        FS.createSpecialDirectories();
  
        FS.filesystems = {
          'MEMFS': MEMFS,
        };
      },
  init(input, output, error) {
        FS.initialized = true;
  
        // Allow Module.stdin etc. to provide defaults, if none explicitly passed to us here
        input ??= Module['stdin'];
        output ??= Module['stdout'];
        error ??= Module['stderr'];
  
        FS.createStandardStreams(input, output, error);
      },
  quit() {
        FS.initialized = false;
        // force-flush all streams, so we get musl std streams printed out
        // close all of our streams
        for (var stream of FS.streams) {
          if (stream) {
            FS.close(stream);
          }
        }
      },
  findObject(path, dontResolveLastLink) {
        var ret = FS.analyzePath(path, dontResolveLastLink);
        if (!ret.exists) {
          return null;
        }
        return ret.object;
      },
  analyzePath(path, dontResolveLastLink) {
        // operate from within the context of the symlink's target
        try {
          var lookup = FS.lookupPath(path, { follow: !dontResolveLastLink });
          path = lookup.path;
        } catch (e) {
        }
        var ret = {
          isRoot: false, exists: false, error: 0, name: null, path: null, object: null,
          parentExists: false, parentPath: null, parentObject: null
        };
        try {
          var lookup = FS.lookupPath(path, { parent: true });
          ret.parentExists = true;
          ret.parentPath = lookup.path;
          ret.parentObject = lookup.node;
          ret.name = PATH.basename(path);
          lookup = FS.lookupPath(path, { follow: !dontResolveLastLink });
          ret.exists = true;
          ret.path = lookup.path;
          ret.object = lookup.node;
          ret.name = lookup.node.name;
          ret.isRoot = lookup.path === '/';
        } catch (e) {
          ret.error = e.errno;
        };
        return ret;
      },
  createPath(parent, path, canRead, canWrite) {
        parent = typeof parent == 'string' ? parent : FS.getPath(parent);
        var parts = path.split('/').reverse();
        while (parts.length) {
          var part = parts.pop();
          if (!part) continue;
          var current = PATH.join2(parent, part);
          try {
            FS.mkdir(current);
          } catch (e) {
            if (e.errno != 20) throw e;
          }
          parent = current;
        }
        return current;
      },
  createFile(parent, name, properties, canRead, canWrite) {
        var path = PATH.join2(typeof parent == 'string' ? parent : FS.getPath(parent), name);
        var mode = FS_getMode(canRead, canWrite);
        return FS.create(path, mode);
      },
  createDataFile(parent, name, data, canRead, canWrite, canOwn) {
        var path = name;
        if (parent) {
          parent = typeof parent == 'string' ? parent : FS.getPath(parent);
          path = name ? PATH.join2(parent, name) : parent;
        }
        var mode = FS_getMode(canRead, canWrite);
        var node = FS.create(path, mode);
        if (data) {
          if (typeof data == 'string') {
            var arr = new Array(data.length);
            for (var i = 0, len = data.length; i < len; ++i) arr[i] = data.charCodeAt(i);
            data = arr;
          }
          // make sure we can write to the file
          FS.chmod(node, mode | 146);
          var stream = FS.open(node, 577);
          FS.write(stream, data, 0, data.length, 0, canOwn);
          FS.close(stream);
          FS.chmod(node, mode);
        }
      },
  createDevice(parent, name, input, output) {
        var path = PATH.join2(typeof parent == 'string' ? parent : FS.getPath(parent), name);
        var mode = FS_getMode(!!input, !!output);
        FS.createDevice.major ??= 64;
        var dev = FS.makedev(FS.createDevice.major++, 0);
        // Create a fake device that a set of stream ops to emulate
        // the old behavior.
        FS.registerDevice(dev, {
          open(stream) {
            stream.seekable = false;
          },
          close(stream) {
            // flush any pending line data
            if (output?.buffer?.length) {
              output(10);
            }
          },
          read(stream, buffer, offset, length, pos /* ignored */) {
            var bytesRead = 0;
            for (var i = 0; i < length; i++) {
              var result;
              try {
                result = input();
              } catch (e) {
                throw new FS.ErrnoError(29);
              }
              if (result === undefined && bytesRead === 0) {
                throw new FS.ErrnoError(6);
              }
              if (result === null || result === undefined) break;
              bytesRead++;
              buffer[offset+i] = result;
            }
            if (bytesRead) {
              stream.node.atime = Date.now();
            }
            return bytesRead;
          },
          write(stream, buffer, offset, length, pos) {
            for (var i = 0; i < length; i++) {
              try {
                output(buffer[offset+i]);
              } catch (e) {
                throw new FS.ErrnoError(29);
              }
            }
            if (length) {
              stream.node.mtime = stream.node.ctime = Date.now();
            }
            return i;
          }
        });
        return FS.mkdev(path, mode, dev);
      },
  forceLoadFile(obj) {
        if (obj.isDevice || obj.isFolder || obj.link || obj.contents) return true;
        if (globalThis.XMLHttpRequest) {
          abort("Lazy loading should have been performed (contents set) in createLazyFile, but it was not. Lazy loading only works in web workers. Use --embed-file or --preload-file in emcc on the main thread.");
        } else { // Command-line.
          try {
            obj.contents = readBinary(obj.url);
          } catch (e) {
            throw new FS.ErrnoError(29);
          }
        }
      },
  createLazyFile(parent, name, url, canRead, canWrite) {
        // Lazy chunked Uint8Array (implements get and length from Uint8Array).
        // Actual getting is abstracted away for eventual reuse.
        class LazyUint8Array {
          lengthKnown = false;
          chunks = []; // Loaded chunks. Index is the chunk number
          get(idx) {
            if (idx > this.length-1 || idx < 0) {
              return undefined;
            }
            var chunkOffset = idx % this.chunkSize;
            var chunkNum = (idx / this.chunkSize)|0;
            return this.getter(chunkNum)[chunkOffset];
          }
          setDataGetter(getter) {
            this.getter = getter;
          }
          cacheLength() {
            // Find length
            var xhr = new XMLHttpRequest();
            xhr.open('HEAD', url, false);
            xhr.send(null);
            if (!(xhr.status >= 200 && xhr.status < 300 || xhr.status === 304)) abort("Couldn't load " + url + ". Status: " + xhr.status);
            var datalength = Number(xhr.getResponseHeader("Content-length"));
            var header;
            var hasByteServing = (header = xhr.getResponseHeader("Accept-Ranges")) && header === "bytes";
            var usesGzip = (header = xhr.getResponseHeader("Content-Encoding")) && header === "gzip";
  
            var chunkSize = 1024*1024; // Chunk size in bytes
  
            if (!hasByteServing) chunkSize = datalength;
  
            // Function to get a range from the remote URL.
            var doXHR = (from, to) => {
              if (from > to) abort("invalid range (" + from + ", " + to + ") or no bytes requested!");
              if (to > datalength-1) abort("only " + datalength + " bytes available! programmer error!");
  
              // TODO: Use mozResponseArrayBuffer, responseStream, etc. if available.
              var xhr = new XMLHttpRequest();
              xhr.open('GET', url, false);
              if (datalength !== chunkSize) xhr.setRequestHeader("Range", "bytes=" + from + "-" + to);
  
              // Some hints to the browser that we want binary data.
              xhr.responseType = 'arraybuffer';
              if (xhr.overrideMimeType) {
                xhr.overrideMimeType('text/plain; charset=x-user-defined');
              }
  
              xhr.send(null);
              if (!(xhr.status >= 200 && xhr.status < 300 || xhr.status === 304)) abort("Couldn't load " + url + ". Status: " + xhr.status);
              if (xhr.response !== undefined) {
                return new Uint8Array(/** @type{Array<number>} */(xhr.response || []));
              }
              return intArrayFromString(xhr.responseText || '', true);
            };
            var lazyArray = this;
            lazyArray.setDataGetter((chunkNum) => {
              var start = chunkNum * chunkSize;
              var end = (chunkNum+1) * chunkSize - 1; // including this byte
              end = Math.min(end, datalength-1); // if datalength-1 is selected, this is the last block
              if (typeof lazyArray.chunks[chunkNum] == 'undefined') {
                lazyArray.chunks[chunkNum] = doXHR(start, end);
              }
              if (typeof lazyArray.chunks[chunkNum] == 'undefined') abort('doXHR failed!');
              return lazyArray.chunks[chunkNum];
            });
  
            if (usesGzip || !datalength) {
              // if the server uses gzip or doesn't supply the length, we have to download the whole file to get the (uncompressed) length
              chunkSize = datalength = 1; // this will force getter(0)/doXHR do download the whole file
              datalength = this.getter(0).length;
              chunkSize = datalength;
              out("LazyFiles on gzip forces download of the whole file when length is accessed");
            }
  
            this._length = datalength;
            this._chunkSize = chunkSize;
            this.lengthKnown = true;
          }
          get length() {
            if (!this.lengthKnown) {
              this.cacheLength();
            }
            return this._length;
          }
          get chunkSize() {
            if (!this.lengthKnown) {
              this.cacheLength();
            }
            return this._chunkSize;
          }
        }
  
        if (globalThis.XMLHttpRequest) {
          if (!ENVIRONMENT_IS_WORKER) abort('Cannot do synchronous binary XHRs outside webworkers in modern browsers. Use --embed-file or --preload-file in emcc');
          var lazyArray = new LazyUint8Array();
          var properties = { isDevice: false, contents: lazyArray };
        } else {
          var properties = { isDevice: false, url: url };
        }
  
        var node = FS.createFile(parent, name, properties, canRead, canWrite);
        // This is a total hack, but I want to get this lazy file code out of the
        // core of MEMFS. If we want to keep this lazy file concept I feel it should
        // be its own thin LAZYFS proxying calls to MEMFS.
        if (properties.contents) {
          node.contents = properties.contents;
        } else if (properties.url) {
          node.contents = null;
          node.url = properties.url;
        }
        // Add a function that defers querying the file size until it is asked the first time.
        Object.defineProperties(node, {
          usedBytes: {
            get: function() { return this.contents.length; }
          }
        });
        // override each stream op with one that tries to force load the lazy file first
        var stream_ops = {};
        for (const [key, fn] of Object.entries(node.stream_ops)) {
          stream_ops[key] = (...args) => {
            FS.forceLoadFile(node);
            return fn(...args);
          };
        }
        function writeChunks(stream, buffer, offset, length, position) {
          var contents = stream.node.contents;
          if (position >= contents.length)
            return 0;
          var size = Math.min(contents.length - position, length);
          if (contents.slice) { // normal array
            for (var i = 0; i < size; i++) {
              buffer[offset + i] = contents[position + i];
            }
          } else {
            for (var i = 0; i < size; i++) { // LazyUint8Array from sync binary XHR
              buffer[offset + i] = contents.get(position + i);
            }
          }
          return size;
        }
        // use a custom read function
        stream_ops.read = (stream, buffer, offset, length, position) => {
          FS.forceLoadFile(node);
          return writeChunks(stream, buffer, offset, length, position)
        };
        // use a custom mmap function
        stream_ops.mmap = (stream, length, position, prot, flags) => {
          FS.forceLoadFile(node);
          var ptr = mmapAlloc(length);
          if (!ptr) {
            throw new FS.ErrnoError(48);
          }
          writeChunks(stream, HEAP8, ptr, length, position);
          return { ptr, allocated: true };
        };
        node.stream_ops = stream_ops;
        return node;
      },
  };
  var SOCKFS = {
  websocketArgs:{
  },
  callbacks:{
  },
  on(event, callback) {
        SOCKFS.callbacks[event] = callback;
      },
  emit(event, param) {
        SOCKFS.callbacks[event]?.(param);
      },
  mount(mount) {
        // The incoming Module['websocket'] can be used for configuring 
        // subprotocol/url, etc
        SOCKFS.websocketArgs = Module['websocket'] || {};
        // Add the Event registration mechanism to the exported websocket configuration
        // object so we can register network callbacks from native JavaScript too.
        // For more documentation see system/include/emscripten/emscripten.h
        (Module['websocket'] ??= {})['on'] = SOCKFS.on;
  
        return FS.createNode(null, '/', 16895, 0);
      },
  createSocket(family, type, protocol) {
        // Emscripten only supports AF_INET
        if (family != 2) {
          throw new FS.ErrnoError(5);
        }
        type &= ~526336; // Some applications may pass it; it makes no sense for a single process.
        // Emscripten only supports SOCK_STREAM and SOCK_DGRAM
        if (type != 1 && type != 2) {
          throw new FS.ErrnoError(28);
        }
        var streaming = type == 1;
        if (streaming && protocol && protocol != 6) {
          throw new FS.ErrnoError(66); // if SOCK_STREAM, must be tcp or 0.
        }
  
        // create our internal socket structure
        var sock = {
          family,
          type,
          protocol,
          server: null,
          error: null, // Used in getsockopt for SOL_SOCKET/SO_ERROR test
          peers: {},
          pending: [],
          recv_queue: [],
          sock_ops: SOCKFS.websocket_sock_ops
        };
  
        // create the filesystem node to store the socket structure
        var name = SOCKFS.nextname();
        var node = FS.createNode(SOCKFS.root, name, 49152, 0);
        node.sock = sock;
  
        // and the wrapping stream that enables library functions such
        // as read and write to indirectly interact with the socket
        var stream = FS.createStream({
          path: name,
          node,
          flags: 2,
          seekable: false,
          stream_ops: SOCKFS.stream_ops
        });
  
        // map the new stream to the socket structure (sockets have a 1:1
        // relationship with a stream)
        sock.stream = stream;
  
        return sock;
      },
  getSocket(fd) {
        var stream = FS.getStream(fd);
        if (!stream || !FS.isSocket(stream.node.mode)) {
          return null;
        }
        return stream.node.sock;
      },
  stream_ops:{
  poll(stream) {
          var sock = stream.node.sock;
          return sock.sock_ops.poll(sock);
        },
  ioctl(stream, request, varargs) {
          var sock = stream.node.sock;
          return sock.sock_ops.ioctl(sock, request, varargs);
        },
  read(stream, buffer, offset, length, position /* ignored */) {
          var sock = stream.node.sock;
          var msg = sock.sock_ops.recvmsg(sock, length);
          if (!msg) {
            // socket is closed
            return 0;
          }
          buffer.set(msg.buffer, offset);
          return msg.buffer.length;
        },
  write(stream, buffer, offset, length, position /* ignored */) {
          var sock = stream.node.sock;
          return sock.sock_ops.sendmsg(sock, buffer, offset, length);
        },
  close(stream) {
          var sock = stream.node.sock;
          sock.sock_ops.close(sock);
        },
  },
  nextname() {
        if (!SOCKFS.nextname.current) {
          SOCKFS.nextname.current = 0;
        }
        return `socket[${SOCKFS.nextname.current++}]`;
      },
  websocket_sock_ops:{
  createPeer(sock, addr, port) {
          var ws;
  
          if (typeof addr == 'object') {
            ws = addr;
            addr = null;
            port = null;
          }
  
          if (ws) {
            // for sockets that've already connected (e.g. we're the server)
            // we can inspect the _socket property for the address
            if (ws._socket) {
              addr = ws._socket.remoteAddress;
              port = ws._socket.remotePort;
            }
            // if we're just now initializing a connection to the remote,
            // inspect the url property
            else {
              var result = /ws[s]?:\/\/([^:]+):(\d+)/.exec(ws.url);
              if (!result) {
                throw new Error('WebSocket URL must be in the format ws(s)://address:port');
              }
              addr = result[1];
              port = parseInt(result[2], 10);
            }
          } else {
            // create the actual websocket object and connect
            try {
              // The default value is 'ws://' the replace is needed because the compiler replaces '//' comments with '#'
              // comments without checking context, so we'd end up with ws:#, the replace swaps the '#' for '//' again.
              var url = 'ws://'.replace('#', '//');
              // Make the WebSocket subprotocol (Sec-WebSocket-Protocol) default to binary if no configuration is set.
              var subProtocols = 'binary'; // The default value is 'binary'
              // The default WebSocket options
              var opts = undefined;
  
              // Fetch runtime WebSocket URL config.
              if (SOCKFS.websocketArgs['url']) {
                url = SOCKFS.websocketArgs['url'];
              }
              // Fetch runtime WebSocket subprotocol config.
              if (SOCKFS.websocketArgs['subprotocol']) {
                subProtocols = SOCKFS.websocketArgs['subprotocol'];
              } else if (SOCKFS.websocketArgs['subprotocol'] === null) {
                subProtocols = 'null'
              }
  
              if (url === 'ws://' || url === 'wss://') { // Is the supplied URL config just a prefix, if so complete it.
                var parts = addr.split('/');
                url = url + parts[0] + ":" + port + "/" + parts.slice(1).join('/');
              }
  
              if (subProtocols !== 'null') {
                // The regex trims the string (removes spaces at the beginning and end), then splits the string by
                // <any space>,<any space> into an Array. Whitespace removal is important for Websockify and ws.
                subProtocols = subProtocols.replace(/^ +| +$/g,"").split(/ *, */);
  
                opts = subProtocols;
              }
  
              // If node we use the ws library.
              var WebSocketConstructor;
              if (ENVIRONMENT_IS_NODE) {
                WebSocketConstructor = /** @type{(typeof WebSocket)} */(require('ws'));
              } else
              {
                WebSocketConstructor = WebSocket;
              }
              ws = new WebSocketConstructor(url, opts);
              ws.binaryType = 'arraybuffer';
            } catch (e) {
              throw new FS.ErrnoError(23);
            }
          }
  
          var peer = {
            addr,
            port,
            socket: ws,
            msg_send_queue: []
          };
  
          SOCKFS.websocket_sock_ops.addPeer(sock, peer);
          SOCKFS.websocket_sock_ops.handlePeerEvents(sock, peer);
  
          // if this is a bound dgram socket, send the port number first to allow
          // us to override the ephemeral port reported to us by remotePort on the
          // remote end.
          if (sock.type === 2 && typeof sock.sport != 'undefined') {
            peer.msg_send_queue.push(new Uint8Array([
                255, 255, 255, 255,
                'p'.charCodeAt(0), 'o'.charCodeAt(0), 'r'.charCodeAt(0), 't'.charCodeAt(0),
                ((sock.sport & 0xff00) >> 8) , (sock.sport & 0xff)
            ]));
          }
  
          return peer;
        },
  getPeer(sock, addr, port) {
          return sock.peers[addr + ':' + port];
        },
  addPeer(sock, peer) {
          sock.peers[peer.addr + ':' + peer.port] = peer;
        },
  removePeer(sock, peer) {
          delete sock.peers[peer.addr + ':' + peer.port];
        },
  handlePeerEvents(sock, peer) {
          var first = true;
  
          var handleOpen = function () {
  
            sock.connecting = false;
            SOCKFS.emit('open', sock.stream.fd);
  
            try {
              var queued = peer.msg_send_queue.shift();
              while (queued) {
                peer.socket.send(queued);
                queued = peer.msg_send_queue.shift();
              }
            } catch (e) {
              // not much we can do here in the way of proper error handling as we've already
              // lied and said this data was sent. shut it down.
              peer.socket.close();
            }
          };
  
          function handleMessage(data) {
            if (typeof data == 'string') {
              var encoder = new TextEncoder(); // should be utf-8
              data = encoder.encode(data); // make a typed array from the string
            } else {
              if (data.byteLength == 0) {
                // An empty ArrayBuffer will emit a pseudo disconnect event
                // as recv/recvmsg will return zero which indicates that a socket
                // has performed a shutdown although the connection has not been disconnected yet.
                return;
              }
              data = new Uint8Array(data); // make a typed array view on the array buffer
            }
  
            // if this is the port message, override the peer's port with it
            var wasfirst = first;
            first = false;
            if (wasfirst &&
                data.length === 10 &&
                data[0] === 255 && data[1] === 255 && data[2] === 255 && data[3] === 255 &&
                data[4] === 'p'.charCodeAt(0) && data[5] === 'o'.charCodeAt(0) && data[6] === 'r'.charCodeAt(0) && data[7] === 't'.charCodeAt(0)) {
              // update the peer's port and its key in the peer map
              var newport = ((data[8] << 8) | data[9]);
              SOCKFS.websocket_sock_ops.removePeer(sock, peer);
              peer.port = newport;
              SOCKFS.websocket_sock_ops.addPeer(sock, peer);
              return;
            }
  
            sock.recv_queue.push({ addr: peer.addr, port: peer.port, data: data });
            SOCKFS.emit('message', sock.stream.fd);
          };
  
          if (ENVIRONMENT_IS_NODE) {
            peer.socket.on('open', handleOpen);
            peer.socket.on('message', function(data, isBinary) {
              if (!isBinary) {
                return;
              }
              handleMessage((new Uint8Array(data)).buffer); // copy from node Buffer -> ArrayBuffer
            });
            peer.socket.on('close', function() {
              SOCKFS.emit('close', sock.stream.fd);
            });
            peer.socket.on('error', function(error) {
              // Although the ws library may pass errors that may be more descriptive than
              // ECONNREFUSED they are not necessarily the expected error code e.g.
              // ENOTFOUND on getaddrinfo seems to be node.js specific, so using ECONNREFUSED
              // is still probably the most useful thing to do.
              sock.error = 14; // Used in getsockopt for SOL_SOCKET/SO_ERROR test.
              SOCKFS.emit('error', [sock.stream.fd, sock.error, 'ECONNREFUSED: Connection refused']);
              // don't throw
            });
          } else {
            peer.socket.onopen = handleOpen;
            peer.socket.onclose = function() {
              SOCKFS.emit('close', sock.stream.fd);
            };
            peer.socket.onmessage = function peer_socket_onmessage(event) {
              handleMessage(event.data);
            };
            peer.socket.onerror = function(error) {
              // The WebSocket spec only allows a 'simple event' to be thrown on error,
              // so we only really know as much as ECONNREFUSED.
              sock.error = 14; // Used in getsockopt for SOL_SOCKET/SO_ERROR test.
              SOCKFS.emit('error', [sock.stream.fd, sock.error, 'ECONNREFUSED: Connection refused']);
            };
          }
        },
  poll(sock) {
          if (sock.type === 1 && sock.server) {
            // listen sockets should only say they're available for reading
            // if there are pending clients.
            return sock.pending.length ? (64 | 1) : 0;
          }
  
          var mask = 0;
          var dest = sock.type === 1 ?  // we only care about the socket state for connection-based sockets
            SOCKFS.websocket_sock_ops.getPeer(sock, sock.daddr, sock.dport) :
            null;
  
          if (sock.recv_queue.length ||
              !dest ||  // connection-less sockets are always ready to read
              (dest && dest.socket.readyState === dest.socket.CLOSING) ||
              (dest && dest.socket.readyState === dest.socket.CLOSED)) {  // let recv return 0 once closed
            mask |= (64 | 1);
          }
  
          if (!dest ||  // connection-less sockets are always ready to write
              (dest && dest.socket.readyState === dest.socket.OPEN)) {
            mask |= 4;
          }
  
          if ((dest && dest.socket.readyState === dest.socket.CLOSING) ||
              (dest && dest.socket.readyState === dest.socket.CLOSED)) {
            // When an non-blocking connect fails mark the socket as writable.
            // Its up to the calling code to then use getsockopt with SO_ERROR to
            // retrieve the error.
            // See https://man7.org/linux/man-pages/man2/connect.2.html
            if (sock.connecting) {
              mask |= 4;
            } else  {
              mask |= 16;
            }
          }
  
          return mask;
        },
  ioctl(sock, request, arg) {
          switch (request) {
            case 21531:
              var bytes = 0;
              if (sock.recv_queue.length) {
                bytes = sock.recv_queue[0].data.length;
              }
              HEAP32[((arg)>>2)] = bytes;
              return 0;
            case 21537:
              var on = HEAP32[((arg)>>2)];
              if (on) {
                sock.stream.flags |= 2048;
              } else {
                sock.stream.flags &= ~2048;
              }
              return 0;
            default:
              return 28;
          }
        },
  close(sock) {
          // if we've spawned a listen server, close it
          if (sock.server) {
            try {
              sock.server.close();
            } catch (e) {
            }
            sock.server = null;
          }
          // close any peer connections
          for (var peer of Object.values(sock.peers)) {
            try {
              peer.socket.close();
            } catch (e) {
            }
            SOCKFS.websocket_sock_ops.removePeer(sock, peer);
          }
          return 0;
        },
  bind(sock, addr, port) {
          if (typeof sock.saddr != 'undefined' || typeof sock.sport != 'undefined') {
            throw new FS.ErrnoError(28);  // already bound
          }
          sock.saddr = addr;
          sock.sport = port;
          // in order to emulate dgram sockets, we need to launch a listen server when
          // binding on a connection-less socket
          // note: this is only required on the server side
          if (sock.type === 2) {
            // close the existing server if it exists
            if (sock.server) {
              sock.server.close();
              sock.server = null;
            }
            // swallow error operation not supported error that occurs when binding in the
            // browser where this isn't supported
            try {
              sock.sock_ops.listen(sock, 0);
            } catch (e) {
              if (!(e.name === 'ErrnoError')) throw e;
              if (e.errno !== 138) throw e;
            }
          }
        },
  connect(sock, addr, port) {
          if (sock.server) {
            throw new FS.ErrnoError(138);
          }
  
          // TODO autobind
          // if (!sock.addr && sock.type == 2) {
          // }
  
          // early out if we're already connected / in the middle of connecting
          if (typeof sock.daddr != 'undefined' && typeof sock.dport != 'undefined') {
            var dest = SOCKFS.websocket_sock_ops.getPeer(sock, sock.daddr, sock.dport);
            if (dest) {
              if (dest.socket.readyState === dest.socket.CONNECTING) {
                throw new FS.ErrnoError(7);
              } else {
                throw new FS.ErrnoError(30);
              }
            }
          }
  
          // add the socket to our peer list and set our
          // destination address / port to match
          var peer = SOCKFS.websocket_sock_ops.createPeer(sock, addr, port);
          sock.daddr = peer.addr;
          sock.dport = peer.port;
  
          // because we cannot synchronously block to wait for the WebSocket
          // connection to complete, we return here pretending that the connection
          // was a success.
          sock.connecting = true;
        },
  listen(sock, backlog) {
          if (!ENVIRONMENT_IS_NODE) {
            throw new FS.ErrnoError(138);
          }
          if (sock.server) {
             throw new FS.ErrnoError(28);  // already listening
          }
          var WebSocketServer = require('ws').Server;
          var host = sock.saddr;
          sock.server = new WebSocketServer({
            host,
            port: sock.sport
            // TODO support backlog
          });
          SOCKFS.emit('listen', sock.stream.fd); // Send Event with listen fd.
  
          sock.server.on('connection', function(ws) {
            if (sock.type === 1) {
              var newsock = SOCKFS.createSocket(sock.family, sock.type, sock.protocol);
  
              // create a peer on the new socket
              var peer = SOCKFS.websocket_sock_ops.createPeer(newsock, ws);
              newsock.daddr = peer.addr;
              newsock.dport = peer.port;
  
              // push to queue for accept to pick up
              sock.pending.push(newsock);
              SOCKFS.emit('connection', newsock.stream.fd);
            } else {
              // create a peer on the listen socket so calling sendto
              // with the listen socket and an address will resolve
              // to the correct client
              SOCKFS.websocket_sock_ops.createPeer(sock, ws);
              SOCKFS.emit('connection', sock.stream.fd);
            }
          });
          sock.server.on('close', function() {
            SOCKFS.emit('close', sock.stream.fd);
            sock.server = null;
          });
          sock.server.on('error', function(error) {
            // Although the ws library may pass errors that may be more descriptive than
            // ECONNREFUSED they are not necessarily the expected error code e.g.
            // ENOTFOUND on getaddrinfo seems to be node.js specific, so using EHOSTUNREACH
            // is still probably the most useful thing to do. This error shouldn't
            // occur in a well written app as errors should get trapped in the compiled
            // app's own getaddrinfo call.
            sock.error = 23; // Used in getsockopt for SOL_SOCKET/SO_ERROR test.
            SOCKFS.emit('error', [sock.stream.fd, sock.error, 'EHOSTUNREACH: Host is unreachable']);
            // don't throw
          });
        },
  accept(listensock) {
          if (!listensock.server || !listensock.pending.length) {
            throw new FS.ErrnoError(28);
          }
          var newsock = listensock.pending.shift();
          newsock.stream.flags = listensock.stream.flags;
          return newsock;
        },
  getname(sock, peer) {
          var addr, port;
          if (peer) {
            if (sock.daddr === undefined || sock.dport === undefined) {
              throw new FS.ErrnoError(53);
            }
            addr = sock.daddr;
            port = sock.dport;
          } else {
            // TODO saddr and sport will be set for bind()'d UDP sockets, but what
            // should we be returning for TCP sockets that've been connect()'d?
            addr = sock.saddr || 0;
            port = sock.sport || 0;
          }
          return { addr, port };
        },
  sendmsg(sock, buffer, offset, length, addr, port) {
          if (sock.type === 2) {
            // connection-less sockets will honor the message address,
            // and otherwise fall back to the bound destination address
            if (addr === undefined || port === undefined) {
              addr = sock.daddr;
              port = sock.dport;
            }
            // if there was no address to fall back to, error out
            if (addr === undefined || port === undefined) {
              throw new FS.ErrnoError(17);
            }
          } else {
            // connection-based sockets will only use the bound
            addr = sock.daddr;
            port = sock.dport;
          }
  
          // find the peer for the destination address
          var dest = SOCKFS.websocket_sock_ops.getPeer(sock, addr, port);
  
          // early out if not connected with a connection-based socket
          if (sock.type === 1) {
            if (!dest || dest.socket.readyState === dest.socket.CLOSING || dest.socket.readyState === dest.socket.CLOSED) {
              throw new FS.ErrnoError(53);
            }
          }
  
          // create a copy of the incoming data to send, as the WebSocket API
          // doesn't work entirely with an ArrayBufferView, it'll just send
          // the entire underlying buffer
          if (ArrayBuffer.isView(buffer)) {
            offset += buffer.byteOffset;
            buffer = buffer.buffer;
          }
  
          var data = buffer.slice(offset, offset + length);
  
          // if we don't have a cached connectionless UDP datagram connection, or
          // the TCP socket is still connecting, queue the message to be sent upon
          // connect, and lie, saying the data was sent now.
          if (!dest || dest.socket.readyState !== dest.socket.OPEN) {
            // if we're not connected, open a new connection
            if (sock.type === 2) {
              if (!dest || dest.socket.readyState === dest.socket.CLOSING || dest.socket.readyState === dest.socket.CLOSED) {
                dest = SOCKFS.websocket_sock_ops.createPeer(sock, addr, port);
              }
            }
            dest.msg_send_queue.push(data);
            return length;
          }
  
          try {
            // send the actual data
            dest.socket.send(data);
            return length;
          } catch (e) {
            throw new FS.ErrnoError(28);
          }
        },
  recvmsg(sock, length) {
          // http://pubs.opengroup.org/onlinepubs/7908799/xns/recvmsg.html
          if (sock.type === 1 && sock.server) {
            // tcp servers should not be recv()'ing on the listen socket
            throw new FS.ErrnoError(53);
          }
  
          var queued = sock.recv_queue.shift();
          if (!queued) {
            if (sock.type === 1) {
              var dest = SOCKFS.websocket_sock_ops.getPeer(sock, sock.daddr, sock.dport);
  
              if (!dest) {
                // if we have a destination address but are not connected, error out
                throw new FS.ErrnoError(53);
              }
              if (dest.socket.readyState === dest.socket.CLOSING || dest.socket.readyState === dest.socket.CLOSED) {
                // return null if the socket has closed
                return null;
              }
              // else, our socket is in a valid state but truly has nothing available
              throw new FS.ErrnoError(6);
            }
            throw new FS.ErrnoError(6);
          }
  
          // queued.data will be an ArrayBuffer if it's unadulterated, but if it's
          // requeued TCP data it'll be an ArrayBufferView
          var queuedLength = queued.data.byteLength || queued.data.length;
          var queuedOffset = queued.data.byteOffset || 0;
          var queuedBuffer = queued.data.buffer || queued.data;
          var bytesRead = Math.min(length, queuedLength);
          var res = {
            buffer: new Uint8Array(queuedBuffer, queuedOffset, bytesRead),
            addr: queued.addr,
            port: queued.port
          };
  
          // push back any unread data for TCP connections
          if (sock.type === 1 && bytesRead < queuedLength) {
            var bytesRemaining = queuedLength - bytesRead;
            queued.data = new Uint8Array(queuedBuffer, queuedOffset + bytesRead, bytesRemaining);
            sock.recv_queue.unshift(queued);
          }
  
          return res;
        },
  },
  };
  
  var getSocketFromFD = (fd) => {
      var socket = SOCKFS.getSocket(fd);
      if (!socket) throw new FS.ErrnoError(8);
      return socket;
    };
  
  var inetPton4 = (str) => {
      var b = str.split('.');
      for (var i = 0; i < 4; i++) {
        var tmp = Number(b[i]);
        if (isNaN(tmp)) return null;
        b[i] = tmp;
      }
      return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
    };
  
  var inetPton6 = (str) => {
      var words;
      var w, offset, z, i;
      /* http://home.deds.nl/~aeron/regex/ */
      var valid6regx = /^((?=.*::)(?!.*::.+::)(::)?([\dA-F]{1,4}:(:|\b)|){5}|([\dA-F]{1,4}:){6})((([\dA-F]{1,4}((?!\3)::|:\b|$))|(?!\2\3)){2}|(((2[0-4]|1\d|[1-9])?\d|25[0-5])\.?\b){4})$/i
      var parts = [];
      if (!valid6regx.test(str)) {
        return null;
      }
      if (str === "::") {
        return [0, 0, 0, 0, 0, 0, 0, 0];
      }
      // Z placeholder to keep track of zeros when splitting the string on ":"
      if (str.startsWith("::")) {
        str = str.replace("::", "Z:"); // leading zeros case
      } else {
        str = str.replace("::", ":Z:");
      }
  
      if (str.indexOf(".") > 0) {
        // parse IPv4 embedded address
        str = str.replace(new RegExp('[.]', 'g'), ":");
        words = str.split(":");
        words[words.length-4] = Number(words[words.length-4]) + Number(words[words.length-3])*256;
        words[words.length-3] = Number(words[words.length-2]) + Number(words[words.length-1])*256;
        words = words.slice(0, words.length-2);
      } else {
        words = str.split(":");
      }
  
      offset = 0; z = 0;
      for (w=0; w < words.length; w++) {
        if (typeof words[w] == 'string') {
          if (words[w] === 'Z') {
            // compressed zeros - write appropriate number of zero words
            for (z = 0; z < (8 - words.length+1); z++) {
              parts[w+z] = 0;
            }
            offset = z-1;
          } else {
            // parse hex field to 16-bit value and write it in network byte-order
            parts[w+offset] = _htons(parseInt(words[w],16));
          }
        } else {
          // parsed IPv4 words
          parts[w+offset] = words[w];
        }
      }
      return [
        (parts[1] << 16) | parts[0],
        (parts[3] << 16) | parts[2],
        (parts[5] << 16) | parts[4],
        (parts[7] << 16) | parts[6]
      ];
    };
  
  
  /** @param {number=} addrlen */
  var writeSockaddr = (sa, family, addr, port, addrlen) => {
      switch (family) {
        case 2:
          addr = inetPton4(addr);
          zeroMemory(sa, 16);
          if (addrlen) {
            HEAP32[((addrlen)>>2)] = 16;
          }
          HEAP16[((sa)>>1)] = family;
          HEAP32[(((sa)+(4))>>2)] = addr;
          HEAP16[(((sa)+(2))>>1)] = _htons(port);
          break;
        case 10:
          addr = inetPton6(addr);
          zeroMemory(sa, 28);
          if (addrlen) {
            HEAP32[((addrlen)>>2)] = 28;
          }
          HEAP32[((sa)>>2)] = family;
          HEAP32[(((sa)+(8))>>2)] = addr[0];
          HEAP32[(((sa)+(12))>>2)] = addr[1];
          HEAP32[(((sa)+(16))>>2)] = addr[2];
          HEAP32[(((sa)+(20))>>2)] = addr[3];
          HEAP16[(((sa)+(2))>>1)] = _htons(port);
          break;
        default:
          return 5;
      }
      return 0;
    };
  
  
  var DNS = {
  address_map:{
  id:1,
  addrs:{
  },
  names:{
  },
  },
  lookup_name(name) {
        // If the name is already a valid ipv4 / ipv6 address, don't generate a fake one.
        var res = inetPton4(name);
        if (res !== null) {
          return name;
        }
        res = inetPton6(name);
        if (res !== null) {
          return name;
        }
  
        // See if this name is already mapped.
        var addr;
  
        if (DNS.address_map.addrs[name]) {
          addr = DNS.address_map.addrs[name];
        } else {
          var id = DNS.address_map.id++;
  
          addr = '172.29.' + (id & 0xff) + '.' + (id & 0xff00);
  
          DNS.address_map.names[addr] = name;
          DNS.address_map.addrs[name] = addr;
        }
  
        return addr;
      },
  lookup_addr(addr) {
        if (DNS.address_map.names[addr]) {
          return DNS.address_map.names[addr];
        }
  
        return null;
      },
  };
  function ___syscall_accept4(fd, addr, addrlen, flags, d1, d2) {
  try {
  
      var sock = getSocketFromFD(fd);
      var newsock = sock.sock_ops.accept(sock);
      if (addr) {
        var errno = writeSockaddr(addr, newsock.family, DNS.lookup_name(newsock.daddr), newsock.dport, addrlen);
      }
      return newsock.stream.fd;
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return -e.errno;
  }
  }

  
  var inetNtop4 = (addr) =>
      (addr & 0xff) + '.' + ((addr >> 8) & 0xff) + '.' + ((addr >> 16) & 0xff) + '.' + ((addr >> 24) & 0xff);
  
  
  var inetNtop6 = (ints) => {
      //  ref:  http://www.ietf.org/rfc/rfc2373.txt - section 2.5.4
      //  Format for IPv4 compatible and mapped  128-bit IPv6 Addresses
      //  128-bits are split into eight 16-bit words
      //  stored in network byte order (big-endian)
      //  |                80 bits               | 16 |      32 bits        |
      //  +-----------------------------------------------------------------+
      //  |               10 bytes               |  2 |      4 bytes        |
      //  +--------------------------------------+--------------------------+
      //  +               5 words                |  1 |      2 words        |
      //  +--------------------------------------+--------------------------+
      //  |0000..............................0000|0000|    IPv4 ADDRESS     | (compatible)
      //  +--------------------------------------+----+---------------------+
      //  |0000..............................0000|FFFF|    IPv4 ADDRESS     | (mapped)
      //  +--------------------------------------+----+---------------------+
      var str = "";
      var word = 0;
      var longest = 0;
      var lastzero = 0;
      var zstart = 0;
      var len = 0;
      var i = 0;
      var parts = [
        ints[0] & 0xffff,
        (ints[0] >> 16),
        ints[1] & 0xffff,
        (ints[1] >> 16),
        ints[2] & 0xffff,
        (ints[2] >> 16),
        ints[3] & 0xffff,
        (ints[3] >> 16)
      ];
  
      // Handle IPv4-compatible, IPv4-mapped, loopback and any/unspecified addresses
  
      var hasipv4 = true;
      var v4part = "";
      // check if the 10 high-order bytes are all zeros (first 5 words)
      for (i = 0; i < 5; i++) {
        if (parts[i] !== 0) { hasipv4 = false; break; }
      }
  
      if (hasipv4) {
        // low-order 32-bits store an IPv4 address (bytes 13 to 16) (last 2 words)
        v4part = inetNtop4(parts[6] | (parts[7] << 16));
        // IPv4-mapped IPv6 address if 16-bit value (bytes 11 and 12) == 0xFFFF (6th word)
        if (parts[5] === -1) {
          str = "::ffff:";
          str += v4part;
          return str;
        }
        // IPv4-compatible IPv6 address if 16-bit value (bytes 11 and 12) == 0x0000 (6th word)
        if (parts[5] === 0) {
          str = "::";
          // special case IPv6 addresses
          if (v4part === "0.0.0.0") v4part = ""; // any/unspecified address
          if (v4part === "0.0.0.1") v4part = "1";// loopback address
          str += v4part;
          return str;
        }
      }
  
      // Handle all other IPv6 addresses
  
      // first run to find the longest contiguous zero words
      for (word = 0; word < 8; word++) {
        if (parts[word] === 0) {
          if (word - lastzero > 1) {
            len = 0;
          }
          lastzero = word;
          len++;
        }
        if (len > longest) {
          longest = len;
          zstart = word - longest + 1;
        }
      }
  
      for (word = 0; word < 8; word++) {
        if (longest > 1) {
          // compress contiguous zeros - to produce "::"
          if (parts[word] === 0 && word >= zstart && word < (zstart + longest) ) {
            if (word === zstart) {
              str += ":";
              if (zstart === 0) str += ":"; //leading zeros case
            }
            continue;
          }
        }
        // converts 16-bit words from big-endian to little-endian before converting to hex string
        str += Number(_ntohs(parts[word] & 0xffff)).toString(16);
        str += word < 7 ? ":" : "";
      }
      return str;
    };
  
  var readSockaddr = (sa, salen) => {
      // family / port offsets are common to both sockaddr_in and sockaddr_in6
      var family = HEAP16[((sa)>>1)];
      var port = _ntohs(HEAPU16[(((sa)+(2))>>1)]);
      var addr;
  
      switch (family) {
        case 2:
          if (salen !== 16) {
            return { errno: 28 };
          }
          addr = HEAP32[(((sa)+(4))>>2)];
          addr = inetNtop4(addr);
          break;
        case 10:
          if (salen !== 28) {
            return { errno: 28 };
          }
          addr = [
            HEAP32[(((sa)+(8))>>2)],
            HEAP32[(((sa)+(12))>>2)],
            HEAP32[(((sa)+(16))>>2)],
            HEAP32[(((sa)+(20))>>2)]
          ];
          addr = inetNtop6(addr);
          break;
        default:
          return { errno: 5 };
      }
  
      return { family: family, addr: addr, port: port };
    };
  
  
  var getSocketAddress = (addrp, addrlen) => {
      var info = readSockaddr(addrp, addrlen);
      if (info.errno) throw new FS.ErrnoError(info.errno);
      info.addr = DNS.lookup_addr(info.addr) || info.addr;
      return info;
    };
  function ___syscall_bind(fd, addr, addrlen, d1, d2, d3) {
  try {
  
      var sock = getSocketFromFD(fd);
      var info = getSocketAddress(addr, addrlen);
      sock.sock_ops.bind(sock, info.addr, info.port);
      return 0;
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return -e.errno;
  }
  }

  
  
  
    /**
   * Given a pointer 'ptr' to a null-terminated UTF8-encoded string in the
   * emscripten HEAP, returns a copy of that string as a Javascript String object.
   *
   * @param {number} ptr
   * @param {number=} maxBytesToRead - An optional length that specifies the
   *   maximum number of bytes to read. You can omit this parameter to scan the
   *   string until the first 0 byte. If maxBytesToRead is passed, and the string
   *   at [ptr, ptr+maxBytesToReadr[ contains a null byte in the middle, then the
   *   string will cut short at that byte index.
   * @param {boolean=} ignoreNul - If true, the function will not stop on a NUL character.
   * @return {string}
   */
  var UTF8ToString = (ptr, maxBytesToRead, ignoreNul) => {
      return ptr ? UTF8ArrayToString(HEAPU8, ptr, maxBytesToRead, ignoreNul) : '';
    };
  var SYSCALLS = {
  calculateAt(dirfd, path, allowEmpty) {
        if (PATH.isAbs(path)) {
          return path;
        }
        // relative path
        var dir;
        if (dirfd === -100) {
          dir = FS.cwd();
        } else {
          var dirstream = SYSCALLS.getStreamFromFD(dirfd);
          dir = dirstream.path;
        }
        if (path.length == 0) {
          if (!allowEmpty) {
            throw new FS.ErrnoError(44);;
          }
          return dir;
        }
        return dir + '/' + path;
      },
  writeStat(buf, stat) {
        HEAPU32[((buf)>>2)] = stat.dev;
        HEAPU32[(((buf)+(4))>>2)] = stat.mode;
        HEAPU32[(((buf)+(8))>>2)] = stat.nlink;
        HEAPU32[(((buf)+(12))>>2)] = stat.uid;
        HEAPU32[(((buf)+(16))>>2)] = stat.gid;
        HEAPU32[(((buf)+(20))>>2)] = stat.rdev;
        HEAP64[(((buf)+(24))>>3)] = BigInt(stat.size);
        HEAP32[(((buf)+(32))>>2)] = 4096;
        HEAP32[(((buf)+(36))>>2)] = stat.blocks;
        var atime = stat.atime.getTime();
        var mtime = stat.mtime.getTime();
        var ctime = stat.ctime.getTime();
        HEAP64[(((buf)+(40))>>3)] = BigInt(Math.floor(atime / 1000));
        HEAPU32[(((buf)+(48))>>2)] = (atime % 1000) * 1000 * 1000;
        HEAP64[(((buf)+(56))>>3)] = BigInt(Math.floor(mtime / 1000));
        HEAPU32[(((buf)+(64))>>2)] = (mtime % 1000) * 1000 * 1000;
        HEAP64[(((buf)+(72))>>3)] = BigInt(Math.floor(ctime / 1000));
        HEAPU32[(((buf)+(80))>>2)] = (ctime % 1000) * 1000 * 1000;
        HEAP64[(((buf)+(88))>>3)] = BigInt(stat.ino);
        return 0;
      },
  writeStatFs(buf, stats) {
        HEAPU32[(((buf)+(4))>>2)] = stats.bsize;
        HEAPU32[(((buf)+(60))>>2)] = stats.bsize;
        HEAP64[(((buf)+(8))>>3)] = BigInt(stats.blocks);
        HEAP64[(((buf)+(16))>>3)] = BigInt(stats.bfree);
        HEAP64[(((buf)+(24))>>3)] = BigInt(stats.bavail);
        HEAP64[(((buf)+(32))>>3)] = BigInt(stats.files);
        HEAP64[(((buf)+(40))>>3)] = BigInt(stats.ffree);
        HEAPU32[(((buf)+(48))>>2)] = stats.fsid;
        HEAPU32[(((buf)+(64))>>2)] = stats.flags;  // ST_NOSUID
        HEAPU32[(((buf)+(56))>>2)] = stats.namelen;
      },
  doMsync(addr, stream, len, flags, offset) {
        if (!FS.isFile(stream.node.mode)) {
          throw new FS.ErrnoError(43);
        }
        if (flags & 2) {
          // MAP_PRIVATE calls need not to be synced back to underlying fs
          return 0;
        }
        var buffer = HEAPU8.slice(addr, addr + len);
        FS.msync(stream, buffer, offset, len, flags);
      },
  getStreamFromFD(fd) {
        var stream = FS.getStreamChecked(fd);
        return stream;
      },
  varargs:undefined,
  getStr(ptr) {
        var ret = UTF8ToString(ptr);
        return ret;
      },
  };
  function ___syscall_chdir(path) {
  try {
  
      path = SYSCALLS.getStr(path);
      FS.chdir(path);
      return 0;
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return -e.errno;
  }
  }

  function ___syscall_chmod(path, mode) {
  try {
  
      path = SYSCALLS.getStr(path);
      FS.chmod(path, mode);
      return 0;
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return -e.errno;
  }
  }

  
  function ___syscall_connect(fd, addr, addrlen, d1, d2, d3) {
  try {
  
      var sock = getSocketFromFD(fd);
      var info = getSocketAddress(addr, addrlen);
      sock.sock_ops.connect(sock, info.addr, info.port);
      return 0;
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return -e.errno;
  }
  }

  function ___syscall_dup(fd) {
  try {
  
      var old = SYSCALLS.getStreamFromFD(fd);
      return FS.dupStream(old).fd;
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return -e.errno;
  }
  }

  function ___syscall_dup3(fd, newfd, flags) {
  try {
  
      var old = SYSCALLS.getStreamFromFD(fd);
      if (old.fd === newfd) return -28;
      // Check newfd is within range of valid open file descriptors.
      if (newfd < 0 || newfd >= FS.MAX_OPEN_FDS) return -8;
      var existing = FS.getStream(newfd);
      if (existing) FS.close(existing);
      return FS.dupStream(old, newfd).fd;
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return -e.errno;
  }
  }

  function ___syscall_faccessat(dirfd, path, amode, flags) {
  try {
  
      path = SYSCALLS.getStr(path);
      path = SYSCALLS.calculateAt(dirfd, path);
      if (amode & ~7) {
        // need a valid mode
        return -28;
      }
      var lookup = FS.lookupPath(path, { follow: true });
      var node = lookup.node;
      if (!node) {
        return -44;
      }
      var perms = '';
      if (amode & 4) perms += 'r';
      if (amode & 2) perms += 'w';
      if (amode & 1) perms += 'x';
      if (perms /* otherwise, they've just passed F_OK */ && FS.nodePermissions(node, perms)) {
        return -2;
      }
      return 0;
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return -e.errno;
  }
  }

  function ___syscall_fchmod(fd, mode) {
  try {
  
      FS.fchmod(fd, mode);
      return 0;
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return -e.errno;
  }
  }

  function ___syscall_fchownat(dirfd, path, owner, group, flags) {
  try {
  
      path = SYSCALLS.getStr(path);
      var nofollow = flags & 256;
      flags = flags & (~256);
      path = SYSCALLS.calculateAt(dirfd, path);
      (nofollow ? FS.lchown : FS.chown)(path, owner, group);
      return 0;
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return -e.errno;
  }
  }

  var syscallGetVarargI = () => {
      // the `+` prepended here is necessary to convince the JSCompiler that varargs is indeed a number.
      var ret = HEAP32[((+SYSCALLS.varargs)>>2)];
      SYSCALLS.varargs += 4;
      return ret;
    };
  var syscallGetVarargP = syscallGetVarargI;
  
  
  function ___syscall_fcntl64(fd, cmd, varargs) {
  SYSCALLS.varargs = varargs;
  try {
  
      var stream = SYSCALLS.getStreamFromFD(fd);
      switch (cmd) {
        case 0: {
          var arg = syscallGetVarargI();
          if (arg < 0) {
            return -28;
          }
          while (FS.streams[arg]) {
            arg++;
          }
          var newStream;
          newStream = FS.dupStream(stream, arg);
          return newStream.fd;
        }
        case 1:
        case 2:
          return 0;  // FD_CLOEXEC makes no sense for a single process.
        case 3:
          return stream.flags;
        case 4: {
          var arg = syscallGetVarargI();
          stream.flags |= arg;
          return 0;
        }
        case 12: {
          var arg = syscallGetVarargP();
          var offset = 0;
          // We're always unlocked.
          HEAP16[(((arg)+(offset))>>1)] = 2;
          return 0;
        }
        case 13:
        case 14:
          // Pretend that the locking is successful. These are process-level locks,
          // and Emscripten programs are a single process. If we supported linking a
          // filesystem between programs, we'd need to do more here.
          // See https://github.com/emscripten-core/emscripten/issues/23697
          return 0;
      }
      return -28;
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return -e.errno;
  }
  }

  function ___syscall_fdatasync(fd) {
  try {
  
      var stream = SYSCALLS.getStreamFromFD(fd);
      return 0; // we can't do anything synchronously; the in-memory FS is already synced to
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return -e.errno;
  }
  }

  function ___syscall_fstat64(fd, buf) {
  try {
  
      return SYSCALLS.writeStat(buf, FS.fstat(fd));
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return -e.errno;
  }
  }

  var INT53_MAX = 9007199254740992;
  
  var INT53_MIN = -9007199254740992;
  var bigintToI53Checked = (num) => (num < INT53_MIN || num > INT53_MAX) ? NaN : Number(num);
  function ___syscall_ftruncate64(fd, length) {
    length = bigintToI53Checked(length);
  
  
  try {
  
      if (isNaN(length)) return -61;
      FS.ftruncate(fd, length);
      return 0;
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return -e.errno;
  }
  ;
  }

  
  var stringToUTF8 = (str, outPtr, maxBytesToWrite) => {
      return stringToUTF8Array(str, HEAPU8, outPtr, maxBytesToWrite);
    };
  function ___syscall_getcwd(buf, size) {
  try {
  
      if (size === 0) return -28;
      var cwd = FS.cwd();
      var cwdLengthInBytes = lengthBytesUTF8(cwd) + 1;
      if (size < cwdLengthInBytes) return -68;
      stringToUTF8(cwd, buf, size);
      return cwdLengthInBytes;
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return -e.errno;
  }
  }

  
  function ___syscall_getdents64(fd, dirp, count) {
  try {
  
      var stream = SYSCALLS.getStreamFromFD(fd)
      stream.getdents ||= FS.readdir(stream.path);
  
      var struct_size = 280;
      var pos = 0;
      var off = FS.llseek(stream, 0, 1);
  
      var startIdx = Math.floor(off / struct_size);
      var endIdx = Math.min(stream.getdents.length, startIdx + Math.floor(count/struct_size))
      for (var idx = startIdx; idx < endIdx; idx++) {
        var id;
        var type;
        var name = stream.getdents[idx];
        if (name === '.') {
          id = stream.node.id;
          type = 4; // DT_DIR
        }
        else if (name === '..') {
          var lookup = FS.lookupPath(stream.path, { parent: true });
          id = lookup.node.id;
          type = 4; // DT_DIR
        }
        else {
          var child;
          try {
            child = FS.lookupNode(stream.node, name);
          } catch (e) {
            // If the entry is not a directory, file, or symlink, nodefs
            // lookupNode will raise EINVAL. Skip these and continue.
            if (e?.errno === 28) {
              continue;
            }
            throw e;
          }
          id = child.id;
          type = FS.isChrdev(child.mode) ? 2 :  // DT_CHR, character device.
                 FS.isDir(child.mode) ? 4 :     // DT_DIR, directory.
                 FS.isLink(child.mode) ? 10 :   // DT_LNK, symbolic link.
                 8;                             // DT_REG, regular file.
        }
        HEAP64[((dirp + pos)>>3)] = BigInt(id);
        HEAP64[(((dirp + pos)+(8))>>3)] = BigInt((idx + 1) * struct_size);
        HEAP16[(((dirp + pos)+(16))>>1)] = 280;
        HEAP8[(dirp + pos)+(18)] = type;
        stringToUTF8(name, dirp + pos + 19, 256);
        pos += struct_size;
      }
      FS.llseek(stream, idx * struct_size, 0);
      return pos;
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return -e.errno;
  }
  }

  
  
  function ___syscall_getpeername(fd, addr, addrlen, d1, d2, d3) {
  try {
  
      var sock = getSocketFromFD(fd);
      if (!sock.daddr) {
        return -53; // The socket is not connected.
      }
      var errno = writeSockaddr(addr, sock.family, DNS.lookup_name(sock.daddr), sock.dport, addrlen);
      return 0;
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return -e.errno;
  }
  }

  
  
  function ___syscall_getsockname(fd, addr, addrlen, d1, d2, d3) {
  try {
  
      var sock = getSocketFromFD(fd);
      // TODO: sock.saddr should never be undefined, see TODO in websocket_sock_ops.getname
      var errno = writeSockaddr(addr, sock.family, DNS.lookup_name(sock.saddr || '0.0.0.0'), sock.sport, addrlen);
      return 0;
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return -e.errno;
  }
  }

  function ___syscall_getsockopt(fd, level, optname, optval, optlen, d1) {
  try {
  
      var sock = getSocketFromFD(fd);
      // Minimal getsockopt aimed at resolving https://github.com/emscripten-core/emscripten/issues/2211
      // so only supports SOL_SOCKET with SO_ERROR.
      if (level === 1) {
        if (optname === 4) {
          HEAP32[((optval)>>2)] = sock.error;
          HEAP32[((optlen)>>2)] = 4;
          sock.error = null; // Clear the error (The SO_ERROR option obtains and then clears this field).
          return 0;
        }
      }
      return -50; // The option is unknown at the level indicated.
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return -e.errno;
  }
  }

  
  function ___syscall_ioctl(fd, op, varargs) {
  SYSCALLS.varargs = varargs;
  try {
  
      var stream = SYSCALLS.getStreamFromFD(fd);
      switch (op) {
        case 21509: {
          if (!stream.tty) return -59;
          return 0;
        }
        case 21505: {
          if (!stream.tty) return -59;
          if (stream.tty.ops.ioctl_tcgets) {
            var termios = stream.tty.ops.ioctl_tcgets(stream);
            var argp = syscallGetVarargP();
            HEAP32[((argp)>>2)] = termios.c_iflag || 0;
            HEAP32[(((argp)+(4))>>2)] = termios.c_oflag || 0;
            HEAP32[(((argp)+(8))>>2)] = termios.c_cflag || 0;
            HEAP32[(((argp)+(12))>>2)] = termios.c_lflag || 0;
            for (var i = 0; i < 32; i++) {
              HEAP8[(argp + i)+(17)] = termios.c_cc[i] || 0;
            }
            return 0;
          }
          return 0;
        }
        case 21510:
        case 21511:
        case 21512: {
          if (!stream.tty) return -59;
          return 0; // no-op, not actually adjusting terminal settings
        }
        case 21506:
        case 21507:
        case 21508: {
          if (!stream.tty) return -59;
          if (stream.tty.ops.ioctl_tcsets) {
            var argp = syscallGetVarargP();
            var c_iflag = HEAP32[((argp)>>2)];
            var c_oflag = HEAP32[(((argp)+(4))>>2)];
            var c_cflag = HEAP32[(((argp)+(8))>>2)];
            var c_lflag = HEAP32[(((argp)+(12))>>2)];
            var c_cc = []
            for (var i = 0; i < 32; i++) {
              c_cc.push(HEAP8[(argp + i)+(17)]);
            }
            return stream.tty.ops.ioctl_tcsets(stream.tty, op, { c_iflag, c_oflag, c_cflag, c_lflag, c_cc });
          }
          return 0; // no-op, not actually adjusting terminal settings
        }
        case 21519: {
          if (!stream.tty) return -59;
          var argp = syscallGetVarargP();
          HEAP32[((argp)>>2)] = 0;
          return 0;
        }
        case 21520: {
          if (!stream.tty) return -59;
          return -28; // not supported
        }
        case 21537:
        case 21531: {
          var argp = syscallGetVarargP();
          return FS.ioctl(stream, op, argp);
        }
        case 21523: {
          // TODO: in theory we should write to the winsize struct that gets
          // passed in, but for now musl doesn't read anything on it
          if (!stream.tty) return -59;
          if (stream.tty.ops.ioctl_tiocgwinsz) {
            var winsize = stream.tty.ops.ioctl_tiocgwinsz(stream.tty);
            var argp = syscallGetVarargP();
            HEAP16[((argp)>>1)] = winsize[0];
            HEAP16[(((argp)+(2))>>1)] = winsize[1];
          }
          return 0;
        }
        case 21524: {
          // TODO: technically, this ioctl call should change the window size.
          // but, since emscripten doesn't have any concept of a terminal window
          // yet, we'll just silently throw it away as we do TIOCGWINSZ
          if (!stream.tty) return -59;
          return 0;
        }
        case 21515: {
          if (!stream.tty) return -59;
          return 0;
        }
        default: return -28; // not supported
      }
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return -e.errno;
  }
  }

  function ___syscall_listen(fd, backlog) {
  try {
  
      var sock = getSocketFromFD(fd);
      sock.sock_ops.listen(sock, backlog);
      return 0;
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return -e.errno;
  }
  }

  function ___syscall_lstat64(path, buf) {
  try {
  
      path = SYSCALLS.getStr(path);
      return SYSCALLS.writeStat(buf, FS.lstat(path));
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return -e.errno;
  }
  }

  function ___syscall_mkdirat(dirfd, path, mode) {
  try {
  
      path = SYSCALLS.getStr(path);
      path = SYSCALLS.calculateAt(dirfd, path);
      FS.mkdir(path, mode, 0);
      return 0;
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return -e.errno;
  }
  }

  function ___syscall_newfstatat(dirfd, path, buf, flags) {
  try {
  
      path = SYSCALLS.getStr(path);
      var nofollow = flags & 256;
      var allowEmpty = flags & 4096;
      flags = flags & (~6400);
      path = SYSCALLS.calculateAt(dirfd, path, allowEmpty);
      return SYSCALLS.writeStat(buf, nofollow ? FS.lstat(path) : FS.stat(path));
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return -e.errno;
  }
  }

  
  function ___syscall_openat(dirfd, path, flags, varargs) {
  SYSCALLS.varargs = varargs;
  try {
  
      path = SYSCALLS.getStr(path);
      path = SYSCALLS.calculateAt(dirfd, path);
      var mode = varargs ? syscallGetVarargI() : 0;
      return FS.open(path, flags, mode).fd;
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return -e.errno;
  }
  }

  var PIPEFS = {
  BUCKET_BUFFER_SIZE:8192,
  mount(mount) {
        // Do not pollute the real root directory or its child nodes with pipes
        // Looks like it is OK to create another pseudo-root node not linked to the FS.root hierarchy this way
        return FS.createNode(null, '/', 16384 | 0o777, 0);
      },
  createPipe() {
        var pipe = {
          buckets: [],
          // refcnt 2 because pipe has a read end and a write end. We need to be
          // able to read from the read end after write end is closed.
          refcnt : 2,
          timestamp: new Date(),
        };
  
        pipe.buckets.push({
          buffer: new Uint8Array(PIPEFS.BUCKET_BUFFER_SIZE),
          offset: 0,
          roffset: 0
        });
  
        var rName = PIPEFS.nextname();
        var wName = PIPEFS.nextname();
        var rNode = FS.createNode(PIPEFS.root, rName, 4096, 0);
        var wNode = FS.createNode(PIPEFS.root, wName, 4096, 0);
  
        rNode.pipe = pipe;
        wNode.pipe = pipe;
  
        var readableStream = FS.createStream({
          path: rName,
          node: rNode,
          flags: 0,
          seekable: false,
          stream_ops: PIPEFS.stream_ops
        });
        rNode.stream = readableStream;
  
        var writableStream = FS.createStream({
          path: wName,
          node: wNode,
          flags: 1,
          seekable: false,
          stream_ops: PIPEFS.stream_ops
        });
        wNode.stream = writableStream;
  
        return {
          readable_fd: readableStream.fd,
          writable_fd: writableStream.fd
        };
      },
  stream_ops:{
  getattr(stream) {
          var node = stream.node;
          var timestamp = node.pipe.timestamp;
          return {
            dev: 14,
            ino: node.id,
            mode: 0o10600,
            nlink: 1,
            uid: 0,
            gid: 0,
            rdev: 0,
            size: 0,
            atime: timestamp,
            mtime: timestamp,
            ctime: timestamp,
            blksize: 4096,
            blocks: 0,
          };
        },
  poll(stream, timeout, notifyCallback) {
          var pipe = stream.node.pipe;
  
          if ((stream.flags & 2097155) === 1) {
            return (256 | 4);
          }
          for (var bucket of pipe.buckets) {
            if (bucket.offset - bucket.roffset > 0) {
              return (64 | 1);
            }
          }
  
          return 0;
        },
  dup(stream) {
          stream.node.pipe.refcnt++;
        },
  ioctl(stream, request, varargs) {
          return 28;
        },
  fsync(stream) {
          return 28;
        },
  read(stream, buffer, offset, length, position /* ignored */) {
          var pipe = stream.node.pipe;
          var currentLength = 0;
  
          for (var bucket of pipe.buckets) {
            currentLength += bucket.offset - bucket.roffset;
          }
  
          var data = buffer.subarray(offset, offset + length);
  
          if (length <= 0) {
            return 0;
          }
          if (currentLength == 0) {
            // Behave as if the read end is always non-blocking
            throw new FS.ErrnoError(6);
          }
          var toRead = Math.min(currentLength, length);
  
          var totalRead = toRead;
          var toRemove = 0;
  
          for (var bucket of pipe.buckets) {
            var bucketSize = bucket.offset - bucket.roffset;
  
            if (toRead <= bucketSize) {
              var tmpSlice = bucket.buffer.subarray(bucket.roffset, bucket.offset);
              if (toRead < bucketSize) {
                tmpSlice = tmpSlice.subarray(0, toRead);
                bucket.roffset += toRead;
              } else {
                toRemove++;
              }
              data.set(tmpSlice);
              break;
            } else {
              var tmpSlice = bucket.buffer.subarray(bucket.roffset, bucket.offset);
              data.set(tmpSlice);
              data = data.subarray(tmpSlice.byteLength);
              toRead -= tmpSlice.byteLength;
              toRemove++;
            }
          }
  
          if (toRemove && toRemove == pipe.buckets.length) {
            // Do not generate excessive garbage in use cases such as
            // write several bytes, read everything, write several bytes, read everything...
            toRemove--;
            pipe.buckets[toRemove].offset = 0;
            pipe.buckets[toRemove].roffset = 0;
          }
  
          pipe.buckets.splice(0, toRemove);
  
          return totalRead;
        },
  write(stream, buffer, offset, length, position /* ignored */) {
          var pipe = stream.node.pipe;
  
          var data = buffer.subarray(offset, offset + length);
  
          var dataLen = data.byteLength;
          if (dataLen <= 0) {
            return 0;
          }
  
          var currBucket = null;
  
          if (pipe.buckets.length == 0) {
            currBucket = {
              buffer: new Uint8Array(PIPEFS.BUCKET_BUFFER_SIZE),
              offset: 0,
              roffset: 0
            };
            pipe.buckets.push(currBucket);
          } else {
            currBucket = pipe.buckets[pipe.buckets.length - 1];
          }
  
          var freeBytesInCurrBuffer = PIPEFS.BUCKET_BUFFER_SIZE - currBucket.offset;
          if (freeBytesInCurrBuffer >= dataLen) {
            currBucket.buffer.set(data, currBucket.offset);
            currBucket.offset += dataLen;
            return dataLen;
          } else if (freeBytesInCurrBuffer > 0) {
            currBucket.buffer.set(data.subarray(0, freeBytesInCurrBuffer), currBucket.offset);
            currBucket.offset += freeBytesInCurrBuffer;
            data = data.subarray(freeBytesInCurrBuffer, data.byteLength);
          }
  
          var numBuckets = (data.byteLength / PIPEFS.BUCKET_BUFFER_SIZE) | 0;
          var remElements = data.byteLength % PIPEFS.BUCKET_BUFFER_SIZE;
  
          for (var i = 0; i < numBuckets; i++) {
            var newBucket = {
              buffer: new Uint8Array(PIPEFS.BUCKET_BUFFER_SIZE),
              offset: PIPEFS.BUCKET_BUFFER_SIZE,
              roffset: 0
            };
            pipe.buckets.push(newBucket);
            newBucket.buffer.set(data.subarray(0, PIPEFS.BUCKET_BUFFER_SIZE));
            data = data.subarray(PIPEFS.BUCKET_BUFFER_SIZE, data.byteLength);
          }
  
          if (remElements > 0) {
            var newBucket = {
              buffer: new Uint8Array(PIPEFS.BUCKET_BUFFER_SIZE),
              offset: data.byteLength,
              roffset: 0
            };
            pipe.buckets.push(newBucket);
            newBucket.buffer.set(data);
          }
  
          return dataLen;
        },
  close(stream) {
          var pipe = stream.node.pipe;
          pipe.refcnt--;
          if (pipe.refcnt === 0) {
            pipe.buckets = null;
          }
        },
  },
  nextname() {
        if (!PIPEFS.nextname.current) {
          PIPEFS.nextname.current = 0;
        }
        return 'pipe[' + (PIPEFS.nextname.current++) + ']';
      },
  };
  function ___syscall_pipe(fdPtr) {
  try {
  
      if (fdPtr == 0) {
        throw new FS.ErrnoError(21);
      }
  
      var res = PIPEFS.createPipe();
  
      HEAP32[((fdPtr)>>2)] = res.readable_fd;
      HEAP32[(((fdPtr)+(4))>>2)] = res.writable_fd;
  
      return 0;
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return -e.errno;
  }
  }

  function ___syscall_poll(fds, nfds, timeout) {
  try {
  
  
      var count = 0;
      for (var i = 0; i < nfds; i++) {
        var pollfd = fds + 8 * i;
        var fd = HEAP32[((pollfd)>>2)];
        var events = HEAP16[(((pollfd)+(4))>>1)];
        var flags = 32;
        var stream = FS.getStream(fd);
        if (stream) {
          if (stream.stream_ops.poll) {
            flags = stream.stream_ops.poll(stream, -1);
          } else {
            flags = 5;
          }
        }
        flags &= events | 8 | 16;
        if (flags) count++;
        HEAP16[(((pollfd)+(6))>>1)] = flags;
      }
  
      return count;
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return -e.errno;
  }
  }

  
  
  function ___syscall_readlinkat(dirfd, path, buf, bufsize) {
  try {
  
      path = SYSCALLS.getStr(path);
      path = SYSCALLS.calculateAt(dirfd, path);
      if (bufsize <= 0) return -28;
      var ret = FS.readlink(path);
  
      var len = Math.min(bufsize, lengthBytesUTF8(ret));
      var endChar = HEAP8[buf+len];
      stringToUTF8(ret, buf, bufsize+1);
      // readlink is one of the rare functions that write out a C string, but does never append a null to the output buffer(!)
      // stringToUTF8() always appends a null byte, so restore the character under the null byte after the write.
      HEAP8[buf+len] = endChar;
      return len;
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return -e.errno;
  }
  }

  
  
  function ___syscall_recvfrom(fd, buf, len, flags, addr, addrlen) {
  try {
  
      var sock = getSocketFromFD(fd);
      var msg = sock.sock_ops.recvmsg(sock, len);
      if (!msg) return 0; // socket is closed
      if (addr) {
        var errno = writeSockaddr(addr, sock.family, DNS.lookup_name(msg.addr), msg.port, addrlen);
      }
      HEAPU8.set(msg.buffer, buf);
      return msg.buffer.byteLength;
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return -e.errno;
  }
  }

  function ___syscall_renameat(olddirfd, oldpath, newdirfd, newpath) {
  try {
  
      oldpath = SYSCALLS.getStr(oldpath);
      newpath = SYSCALLS.getStr(newpath);
      oldpath = SYSCALLS.calculateAt(olddirfd, oldpath);
      newpath = SYSCALLS.calculateAt(newdirfd, newpath);
      FS.rename(oldpath, newpath);
      return 0;
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return -e.errno;
  }
  }

  function ___syscall_rmdir(path) {
  try {
  
      path = SYSCALLS.getStr(path);
      FS.rmdir(path);
      return 0;
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return -e.errno;
  }
  }

  
  function ___syscall_sendto(fd, message, length, flags, addr, addr_len) {
  try {
  
      var sock = getSocketFromFD(fd);
      if (!addr) {
        // send, no address provided
        return FS.write(sock.stream, HEAP8, message, length);
      }
      var dest = getSocketAddress(addr, addr_len);
      // sendto an address
      return sock.sock_ops.sendmsg(sock, HEAP8, message, length, dest.addr, dest.port);
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return -e.errno;
  }
  }

  function ___syscall_socket(domain, type, protocol) {
  try {
  
      var sock = SOCKFS.createSocket(domain, type, protocol);
      return sock.stream.fd;
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return -e.errno;
  }
  }

  function ___syscall_stat64(path, buf) {
  try {
  
      path = SYSCALLS.getStr(path);
      return SYSCALLS.writeStat(buf, FS.stat(path));
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return -e.errno;
  }
  }

  function ___syscall_statfs64(path, size, buf) {
  try {
  
      SYSCALLS.writeStatFs(buf, FS.statfs(SYSCALLS.getStr(path)));
      return 0;
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return -e.errno;
  }
  }

  function ___syscall_symlinkat(target, dirfd, linkpath) {
  try {
  
      target = SYSCALLS.getStr(target);
      linkpath = SYSCALLS.getStr(linkpath);
      linkpath = SYSCALLS.calculateAt(dirfd, linkpath);
      FS.symlink(target, linkpath);
      return 0;
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return -e.errno;
  }
  }

  function ___syscall_unlinkat(dirfd, path, flags) {
  try {
  
      path = SYSCALLS.getStr(path);
      path = SYSCALLS.calculateAt(dirfd, path);
      if (!flags) {
        FS.unlink(path);
      } else if (flags === 512) {
        FS.rmdir(path);
      } else {
        return -28;
      }
      return 0;
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return -e.errno;
  }
  }

  var readI53FromI64 = (ptr) => {
      return HEAPU32[((ptr)>>2)] + HEAP32[(((ptr)+(4))>>2)] * 4294967296;
    };
  
  function ___syscall_utimensat(dirfd, path, times, flags) {
  try {
  
      path = SYSCALLS.getStr(path);
      path = SYSCALLS.calculateAt(dirfd, path, true);
      var now = Date.now(), atime, mtime;
      if (!times) {
        atime = now;
        mtime = now;
      } else {
        var seconds = readI53FromI64(times);
        var nanoseconds = HEAP32[(((times)+(8))>>2)];
        if (nanoseconds == 1073741823) {
          atime = now;
        } else if (nanoseconds == 1073741822) {
          atime = null;
        } else {
          atime = (seconds*1000) + (nanoseconds/(1000*1000));
        }
        times += 16;
        seconds = readI53FromI64(times);
        nanoseconds = HEAP32[(((times)+(8))>>2)];
        if (nanoseconds == 1073741823) {
          mtime = now;
        } else if (nanoseconds == 1073741822) {
          mtime = null;
        } else {
          mtime = (seconds*1000) + (nanoseconds/(1000*1000));
        }
      }
      // null here means UTIME_OMIT was passed. If both were set to UTIME_OMIT then
      // we can skip the call completely.
      if ((mtime ?? atime) !== null) {
        FS.utime(path, atime, mtime);
      }
      return 0;
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return -e.errno;
  }
  }

  var __abort_js = () =>
      abort('');

  
  
  
  var __emscripten_lookup_name = (name) => {
      // uint32_t _emscripten_lookup_name(const char *name);
      var nameString = UTF8ToString(name);
      return inetPton4(DNS.lookup_name(nameString));
    };

  var runtimeKeepaliveCounter = 0;
  var __emscripten_runtime_keepalive_clear = () => {
      noExitRuntime = false;
      runtimeKeepaliveCounter = 0;
    };

  var __emscripten_throw_longjmp = () => {
      throw Infinity;
    };

  function __gmtime_js(time, tmPtr) {
    time = bigintToI53Checked(time);
  
  
      var date = new Date(time * 1000);
      HEAP32[((tmPtr)>>2)] = date.getUTCSeconds();
      HEAP32[(((tmPtr)+(4))>>2)] = date.getUTCMinutes();
      HEAP32[(((tmPtr)+(8))>>2)] = date.getUTCHours();
      HEAP32[(((tmPtr)+(12))>>2)] = date.getUTCDate();
      HEAP32[(((tmPtr)+(16))>>2)] = date.getUTCMonth();
      HEAP32[(((tmPtr)+(20))>>2)] = date.getUTCFullYear()-1900;
      HEAP32[(((tmPtr)+(24))>>2)] = date.getUTCDay();
      var start = Date.UTC(date.getUTCFullYear(), 0, 1, 0, 0, 0, 0);
      var yday = ((date.getTime() - start) / (1000 * 60 * 60 * 24))|0;
      HEAP32[(((tmPtr)+(28))>>2)] = yday;
    ;
  }

  var isLeapYear = (year) => year%4 === 0 && (year%100 !== 0 || year%400 === 0);
  
  var MONTH_DAYS_LEAP_CUMULATIVE = [0,31,60,91,121,152,182,213,244,274,305,335];
  
  var MONTH_DAYS_REGULAR_CUMULATIVE = [0,31,59,90,120,151,181,212,243,273,304,334];
  var ydayFromDate = (date) => {
      var leap = isLeapYear(date.getFullYear());
      var monthDaysCumulative = (leap ? MONTH_DAYS_LEAP_CUMULATIVE : MONTH_DAYS_REGULAR_CUMULATIVE);
      var yday = monthDaysCumulative[date.getMonth()] + date.getDate() - 1; // -1 since it's days since Jan 1
  
      return yday;
    };
  
  function __localtime_js(time, tmPtr) {
    time = bigintToI53Checked(time);
  
  
      var date = new Date(time*1000);
      HEAP32[((tmPtr)>>2)] = date.getSeconds();
      HEAP32[(((tmPtr)+(4))>>2)] = date.getMinutes();
      HEAP32[(((tmPtr)+(8))>>2)] = date.getHours();
      HEAP32[(((tmPtr)+(12))>>2)] = date.getDate();
      HEAP32[(((tmPtr)+(16))>>2)] = date.getMonth();
      HEAP32[(((tmPtr)+(20))>>2)] = date.getFullYear()-1900;
      HEAP32[(((tmPtr)+(24))>>2)] = date.getDay();
  
      var yday = ydayFromDate(date)|0;
      HEAP32[(((tmPtr)+(28))>>2)] = yday;
      HEAP32[(((tmPtr)+(36))>>2)] = -(date.getTimezoneOffset() * 60);
  
      // Attention: DST is in December in South, and some regions don't have DST at all.
      var start = new Date(date.getFullYear(), 0, 1);
      var summerOffset = new Date(date.getFullYear(), 6, 1).getTimezoneOffset();
      var winterOffset = start.getTimezoneOffset();
      var dst = (summerOffset != winterOffset && date.getTimezoneOffset() == Math.min(winterOffset, summerOffset))|0;
      HEAP32[(((tmPtr)+(32))>>2)] = dst;
    ;
  }

  
  var __mktime_js = function(tmPtr) {
  
  var ret = (() => { 
      var date = new Date(HEAP32[(((tmPtr)+(20))>>2)] + 1900,
                          HEAP32[(((tmPtr)+(16))>>2)],
                          HEAP32[(((tmPtr)+(12))>>2)],
                          HEAP32[(((tmPtr)+(8))>>2)],
                          HEAP32[(((tmPtr)+(4))>>2)],
                          HEAP32[((tmPtr)>>2)],
                          0);
  
      // There's an ambiguous hour when the time goes back; the tm_isdst field is
      // used to disambiguate it.  Date() basically guesses, so we fix it up if it
      // guessed wrong, or fill in tm_isdst with the guess if it's -1.
      var dst = HEAP32[(((tmPtr)+(32))>>2)];
      var guessedOffset = date.getTimezoneOffset();
      var start = new Date(date.getFullYear(), 0, 1);
      var summerOffset = new Date(date.getFullYear(), 6, 1).getTimezoneOffset();
      var winterOffset = start.getTimezoneOffset();
      var dstOffset = Math.min(winterOffset, summerOffset); // DST is in December in South
      if (dst < 0) {
        // Attention: some regions don't have DST at all.
        HEAP32[(((tmPtr)+(32))>>2)] = Number(summerOffset != winterOffset && dstOffset == guessedOffset);
      } else if ((dst > 0) != (dstOffset == guessedOffset)) {
        var nonDstOffset = Math.max(winterOffset, summerOffset);
        var trueOffset = dst > 0 ? dstOffset : nonDstOffset;
        // Don't try setMinutes(date.getMinutes() + ...) -- it's messed up.
        date.setTime(date.getTime() + (trueOffset - guessedOffset)*60000);
      }
  
      HEAP32[(((tmPtr)+(24))>>2)] = date.getDay();
      var yday = ydayFromDate(date)|0;
      HEAP32[(((tmPtr)+(28))>>2)] = yday;
      // To match expected behavior, update fields from date
      HEAP32[((tmPtr)>>2)] = date.getSeconds();
      HEAP32[(((tmPtr)+(4))>>2)] = date.getMinutes();
      HEAP32[(((tmPtr)+(8))>>2)] = date.getHours();
      HEAP32[(((tmPtr)+(12))>>2)] = date.getDate();
      HEAP32[(((tmPtr)+(16))>>2)] = date.getMonth();
      HEAP32[(((tmPtr)+(20))>>2)] = date.getYear();
  
      var timeMs = date.getTime();
      if (isNaN(timeMs)) {
        return -1;
      }
      // Return time in microseconds
      return timeMs / 1000;
     })();
  return BigInt(ret);
  };

  
  
  
  
  
  function __mmap_js(len, prot, flags, fd, offset, allocated, addr) {
    offset = bigintToI53Checked(offset);
  
  
  try {
  
      var stream = SYSCALLS.getStreamFromFD(fd);
      var res = FS.mmap(stream, len, offset, prot, flags);
      var ptr = res.ptr;
      HEAP32[((allocated)>>2)] = res.allocated;
      HEAPU32[((addr)>>2)] = ptr;
      return 0;
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return -e.errno;
  }
  ;
  }

  
  function __munmap_js(addr, len, prot, flags, fd, offset) {
    offset = bigintToI53Checked(offset);
  
  
  try {
  
      var stream = SYSCALLS.getStreamFromFD(fd);
      if (prot & 2) {
        SYSCALLS.doMsync(addr, stream, len, flags, offset);
      }
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return -e.errno;
  }
  ;
  }

  var timers = {
  };
  
  var handleException = (e) => {
      // Certain exception types we do not treat as errors since they are used for
      // internal control flow.
      // 1. ExitStatus, which is thrown by exit()
      // 2. "unwind", which is thrown by emscripten_unwind_to_js_event_loop() and others
      //    that wish to return to JS event loop.
      if (e instanceof ExitStatus || e == 'unwind') {
        return EXITSTATUS;
      }
      quit_(1, e);
    };
  
  
  var keepRuntimeAlive = () => noExitRuntime || runtimeKeepaliveCounter > 0;
  var _proc_exit = (code) => {
      EXITSTATUS = code;
      if (!keepRuntimeAlive()) {
        Module['onExit']?.(code);
        ABORT = true;
      }
      quit_(code, new ExitStatus(code));
    };
  /** @param {boolean|number=} implicit */
  var exitJS = (status, implicit) => {
      EXITSTATUS = status;
  
      _proc_exit(status);
    };
  var _exit = exitJS;
  
  
  var maybeExit = () => {
      if (!keepRuntimeAlive()) {
        try {
          _exit(EXITSTATUS);
        } catch (e) {
          handleException(e);
        }
      }
    };
  var callUserCallback = (func) => {
      if (ABORT) {
        return;
      }
      try {
        return func();
      } catch (e) {
        handleException(e);
      } finally {
        maybeExit();
      }
    };
  
  
  var _emscripten_get_now = () => performance.now();
  var __setitimer_js = (which, timeout_ms) => {
      // First, clear any existing timer.
      if (timers[which]) {
        clearTimeout(timers[which].id);
        delete timers[which];
      }
  
      // A timeout of zero simply cancels the current timeout so we have nothing
      // more to do.
      if (!timeout_ms) return 0;
  
      var id = setTimeout(() => {
        delete timers[which];
        callUserCallback(() => __emscripten_timeout(which, _emscripten_get_now()));
      }, timeout_ms);
      timers[which] = { id, timeout_ms };
      return 0;
    };

  var __tzset_js = (timezone, daylight, std_name, dst_name) => {
      // TODO: Use (malleable) environment variables instead of system settings.
      var currentYear = new Date().getFullYear();
      var winter = new Date(currentYear, 0, 1);
      var summer = new Date(currentYear, 6, 1);
      var winterOffset = winter.getTimezoneOffset();
      var summerOffset = summer.getTimezoneOffset();
  
      // Local standard timezone offset. Local standard time is not adjusted for
      // daylight savings.  This code uses the fact that getTimezoneOffset returns
      // a greater value during Standard Time versus Daylight Saving Time (DST).
      // Thus it determines the expected output during Standard Time, and it
      // compares whether the output of the given date the same (Standard) or less
      // (DST).
      var stdTimezoneOffset = Math.max(winterOffset, summerOffset);
  
      // timezone is specified as seconds west of UTC ("The external variable
      // `timezone` shall be set to the difference, in seconds, between
      // Coordinated Universal Time (UTC) and local standard time."), the same
      // as returned by stdTimezoneOffset.
      // See http://pubs.opengroup.org/onlinepubs/009695399/functions/tzset.html
      HEAPU32[((timezone)>>2)] = stdTimezoneOffset * 60;
  
      HEAP32[((daylight)>>2)] = Number(winterOffset != summerOffset);
  
      var extractZone = (timezoneOffset) => {
        // Why inverse sign?
        // Read here https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Date/getTimezoneOffset
        var sign = timezoneOffset >= 0 ? "-" : "+";
  
        var absOffset = Math.abs(timezoneOffset)
        var hours = String(Math.floor(absOffset / 60)).padStart(2, "0");
        var minutes = String(absOffset % 60).padStart(2, "0");
  
        return `UTC${sign}${hours}${minutes}`;
      }
  
      var winterName = extractZone(winterOffset);
      var summerName = extractZone(summerOffset);
      if (summerOffset < winterOffset) {
        // Northern hemisphere
        stringToUTF8(winterName, std_name, 17);
        stringToUTF8(summerName, dst_name, 17);
      } else {
        stringToUTF8(winterName, dst_name, 17);
        stringToUTF8(summerName, std_name, 17);
      }
    };

  
  var _emscripten_date_now = () => Date.now();
  
  var nowIsMonotonic = 1;
  
  var checkWasiClock = (clock_id) => clock_id >= 0 && clock_id <= 3;
  
  function _clock_time_get(clk_id, ignored_precision, ptime) {
    ignored_precision = bigintToI53Checked(ignored_precision);
  
  
      if (!checkWasiClock(clk_id)) {
        return 28;
      }
      var now;
      // all wasi clocks but realtime are monotonic
      if (clk_id === 0) {
        now = _emscripten_date_now();
      } else if (nowIsMonotonic) {
        now = _emscripten_get_now();
      } else {
        return 52;
      }
      // "now" is in ms, and wasi times are in ns.
      var nsec = Math.round(now * 1000 * 1000);
      HEAP64[((ptime)>>3)] = BigInt(nsec);
      return 0;
    ;
  }


  var getHeapMax = () =>
      // Stay one Wasm page short of 4GB: while e.g. Chrome is able to allocate
      // full 4GB Wasm memories, the size will wrap back to 0 bytes in Wasm side
      // for any code that deals with heap sizes, which would require special
      // casing all heap size related code to treat 0 specially.
      2147483648;
  var _emscripten_get_heap_max = () => getHeapMax();


  
  
  var growMemory = (size) => {
      var oldHeapSize = wasmMemory.buffer.byteLength;
      var pages = ((size - oldHeapSize + 65535) / 65536) | 0;
      try {
        // round size grow request up to wasm page size (fixed 64KB per spec)
        wasmMemory.grow(pages); // .grow() takes a delta compared to the previous size
        updateMemoryViews();
        return 1 /*success*/;
      } catch(e) {
      }
      // implicit 0 return to save code size (caller will cast "undefined" into 0
      // anyhow)
    };
  var _emscripten_resize_heap = (requestedSize) => {
      var oldSize = HEAPU8.length;
      // With CAN_ADDRESS_2GB or MEMORY64, pointers are already unsigned.
      requestedSize >>>= 0;
      // With multithreaded builds, races can happen (another thread might increase the size
      // in between), so return a failure, and let the caller retry.
  
      // Memory resize rules:
      // 1.  Always increase heap size to at least the requested size, rounded up
      //     to next page multiple.
      // 2a. If MEMORY_GROWTH_LINEAR_STEP == -1, excessively resize the heap
      //     geometrically: increase the heap size according to
      //     MEMORY_GROWTH_GEOMETRIC_STEP factor (default +20%), At most
      //     overreserve by MEMORY_GROWTH_GEOMETRIC_CAP bytes (default 96MB).
      // 2b. If MEMORY_GROWTH_LINEAR_STEP != -1, excessively resize the heap
      //     linearly: increase the heap size by at least
      //     MEMORY_GROWTH_LINEAR_STEP bytes.
      // 3.  Max size for the heap is capped at 2048MB-WASM_PAGE_SIZE, or by
      //     MAXIMUM_MEMORY, or by ASAN limit, depending on which is smallest
      // 4.  If we were unable to allocate as much memory, it may be due to
      //     over-eager decision to excessively reserve due to (3) above.
      //     Hence if an allocation fails, cut down on the amount of excess
      //     growth, in an attempt to succeed to perform a smaller allocation.
  
      // A limit is set for how much we can grow. We should not exceed that
      // (the wasm binary specifies it, so if we tried, we'd fail anyhow).
      var maxHeapSize = getHeapMax();
      if (requestedSize > maxHeapSize) {
        return false;
      }
  
      // Loop through potential heap size increases. If we attempt a too eager
      // reservation that fails, cut down on the attempted size and reserve a
      // smaller bump instead. (max 3 times, chosen somewhat arbitrarily)
      for (var cutDown = 1; cutDown <= 4; cutDown *= 2) {
        var overGrownHeapSize = oldSize * (1 + 0.2 / cutDown); // ensure geometric growth
        // but limit overreserving (default to capping at +96MB overgrowth at most)
        overGrownHeapSize = Math.min(overGrownHeapSize, requestedSize + 100663296 );
  
        var newSize = Math.min(maxHeapSize, alignMemory(Math.max(requestedSize, overGrownHeapSize), 65536));
  
        var replacement = growMemory(newSize);
        if (replacement) {
  
          return true;
        }
      }
      return false;
    };

  var ENV = {
  };
  
  var getExecutableName = () => thisProgram || './this.program';
  var getEnvStrings = () => {
      if (!getEnvStrings.strings) {
        // Default values.
        // Browser language detection #8751
        var lang = (globalThis.navigator?.language ?? 'C').replace('-', '_') + '.UTF-8';
        var env = {
          'USER': 'web_user',
          'LOGNAME': 'web_user',
          'PATH': '/',
          'PWD': '/',
          'HOME': '/home/web_user',
          'LANG': lang,
          '_': getExecutableName()
        };
        // Apply the user-provided values, if any.
        for (var x in ENV) {
          // x is a key in ENV; if ENV[x] is undefined, that means it was
          // explicitly set to be so. We allow user code to do that to
          // force variables with default values to remain unset.
          if (ENV[x] === undefined) delete env[x];
          else env[x] = ENV[x];
        }
        var strings = [];
        for (var x in env) {
          strings.push(`${x}=${env[x]}`);
        }
        getEnvStrings.strings = strings;
      }
      return getEnvStrings.strings;
    };
  
  var _environ_get = (__environ, environ_buf) => {
      var bufSize = 0;
      var envp = 0;
      for (var string of getEnvStrings()) {
        var ptr = environ_buf + bufSize;
        HEAPU32[(((__environ)+(envp))>>2)] = ptr;
        bufSize += stringToUTF8(string, ptr, Infinity) + 1;
        envp += 4;
      }
      return 0;
    };

  
  var _environ_sizes_get = (penviron_count, penviron_buf_size) => {
      var strings = getEnvStrings();
      HEAPU32[((penviron_count)>>2)] = strings.length;
      var bufSize = 0;
      for (var string of strings) {
        bufSize += lengthBytesUTF8(string) + 1;
      }
      HEAPU32[((penviron_buf_size)>>2)] = bufSize;
      return 0;
    };


  function _fd_close(fd) {
  try {
  
      var stream = SYSCALLS.getStreamFromFD(fd);
      FS.close(stream);
      return 0;
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return e.errno;
  }
  }

  function _fd_fdstat_get(fd, pbuf) {
  try {
  
      var rightsBase = 0;
      var rightsInheriting = 0;
      var flags = 0;
      {
        var stream = SYSCALLS.getStreamFromFD(fd);
        // All character devices are terminals (other things a Linux system would
        // assume is a character device, like the mouse, we have special APIs for).
        var type = stream.tty ? 2 :
                   FS.isDir(stream.mode) ? 3 :
                   FS.isLink(stream.mode) ? 7 :
                   4;
      }
      HEAP8[pbuf] = type;
      HEAP16[(((pbuf)+(2))>>1)] = flags;
      HEAP64[(((pbuf)+(8))>>3)] = BigInt(rightsBase);
      HEAP64[(((pbuf)+(16))>>3)] = BigInt(rightsInheriting);
      return 0;
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return e.errno;
  }
  }

  /** @param {number=} offset */
  var doReadv = (stream, iov, iovcnt, offset) => {
      var ret = 0;
      for (var i = 0; i < iovcnt; i++) {
        var ptr = HEAPU32[((iov)>>2)];
        var len = HEAPU32[(((iov)+(4))>>2)];
        iov += 8;
        var curr = FS.read(stream, HEAP8, ptr, len, offset);
        if (curr < 0) return -1;
        ret += curr;
        if (curr < len) break; // nothing more to read
        if (typeof offset != 'undefined') {
          offset += curr;
        }
      }
      return ret;
    };
  
  function _fd_read(fd, iov, iovcnt, pnum) {
  try {
  
      var stream = SYSCALLS.getStreamFromFD(fd);
      var num = doReadv(stream, iov, iovcnt);
      HEAPU32[((pnum)>>2)] = num;
      return 0;
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return e.errno;
  }
  }

  
  function _fd_seek(fd, offset, whence, newOffset) {
    offset = bigintToI53Checked(offset);
  
  
  try {
  
      if (isNaN(offset)) return 61;
      var stream = SYSCALLS.getStreamFromFD(fd);
      FS.llseek(stream, offset, whence);
      HEAP64[((newOffset)>>3)] = BigInt(stream.position);
      if (stream.getdents && offset === 0 && whence === 0) stream.getdents = null; // reset readdir state
      return 0;
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return e.errno;
  }
  ;
  }

  function _fd_sync(fd) {
  try {
  
      var stream = SYSCALLS.getStreamFromFD(fd);
      var rtn = stream.stream_ops?.fsync?.(stream);
      return rtn;
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return e.errno;
  }
  }

  /** @param {number=} offset */
  var doWritev = (stream, iov, iovcnt, offset) => {
      var ret = 0;
      for (var i = 0; i < iovcnt; i++) {
        var ptr = HEAPU32[((iov)>>2)];
        var len = HEAPU32[(((iov)+(4))>>2)];
        iov += 8;
        var curr = FS.write(stream, HEAP8, ptr, len, offset);
        if (curr < 0) return -1;
        ret += curr;
        if (curr < len) {
          // No more space to write.
          break;
        }
        if (typeof offset != 'undefined') {
          offset += curr;
        }
      }
      return ret;
    };
  
  function _fd_write(fd, iov, iovcnt, pnum) {
  try {
  
      var stream = SYSCALLS.getStreamFromFD(fd);
      var num = doWritev(stream, iov, iovcnt);
      HEAPU32[((pnum)>>2)] = num;
      return 0;
    } catch (e) {
    if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
    return e.errno;
  }
  }

  
  
  
  
  
  
  
  
  var _getaddrinfo = (node, service, hint, out) => {
      // Note getaddrinfo currently only returns a single addrinfo with ai_next defaulting to NULL. When NULL
      // hints are specified or ai_family set to AF_UNSPEC or ai_socktype or ai_protocol set to 0 then we
      // really should provide a linked list of suitable addrinfo values.
      var addrs = [];
      var canon = null;
      var addr = 0;
      var port = 0;
      var flags = 0;
      var family = 0;
      var type = 0;
      var proto = 0;
      var ai, last;
  
      function allocaddrinfo(family, type, proto, canon, addr, port) {
        var sa, salen, ai;
        var errno;
  
        salen = family === 10 ?
          28 :
          16;
        addr = family === 10 ?
          inetNtop6(addr) :
          inetNtop4(addr);
        sa = _malloc(salen);
        errno = writeSockaddr(sa, family, addr, port);
  
        ai = _malloc(32);
        HEAP32[(((ai)+(4))>>2)] = family;
        HEAP32[(((ai)+(8))>>2)] = type;
        HEAP32[(((ai)+(12))>>2)] = proto;
        HEAPU32[(((ai)+(24))>>2)] = canon;
        HEAPU32[(((ai)+(20))>>2)] = sa;
        if (family === 10) {
          HEAP32[(((ai)+(16))>>2)] = 28;
        } else {
          HEAP32[(((ai)+(16))>>2)] = 16;
        }
        HEAP32[(((ai)+(28))>>2)] = 0;
  
        return ai;
      }
  
      if (hint) {
        flags = HEAP32[((hint)>>2)];
        family = HEAP32[(((hint)+(4))>>2)];
        type = HEAP32[(((hint)+(8))>>2)];
        proto = HEAP32[(((hint)+(12))>>2)];
      }
      if (type && !proto) {
        proto = type === 2 ? 17 : 6;
      }
      if (!type && proto) {
        type = proto === 17 ? 2 : 1;
      }
  
      // If type or proto are set to zero in hints we should really be returning multiple addrinfo values, but for
      // now default to a TCP STREAM socket so we can at least return a sensible addrinfo given NULL hints.
      if (proto === 0) {
        proto = 6;
      }
      if (type === 0) {
        type = 1;
      }
  
      if (!node && !service) {
        return -2;
      }
      if (flags & ~(1|2|4|
          1024|8|16|32)) {
        return -1;
      }
      if (hint !== 0 && (HEAP32[((hint)>>2)] & 2) && !node) {
        return -1;
      }
      if (flags & 32) {
        // TODO
        return -2;
      }
      if (type !== 0 && type !== 1 && type !== 2) {
        return -7;
      }
      if (family !== 0 && family !== 2 && family !== 10) {
        return -6;
      }
  
      if (service) {
        service = UTF8ToString(service);
        port = parseInt(service, 10);
  
        if (isNaN(port)) {
          if (flags & 1024) {
            return -2;
          }
          // TODO support resolving well-known service names from:
          // http://www.iana.org/assignments/service-names-port-numbers/service-names-port-numbers.txt
          return -8;
        }
      }
  
      if (!node) {
        if (family === 0) {
          family = 2;
        }
        if ((flags & 1) === 0) {
          if (family === 2) {
            addr = _htonl(2130706433);
          } else {
            addr = [0, 0, 0, _htonl(1)];
          }
        }
        ai = allocaddrinfo(family, type, proto, null, addr, port);
        HEAPU32[((out)>>2)] = ai;
        return 0;
      }
  
      //
      // try as a numeric address
      //
      node = UTF8ToString(node);
      addr = inetPton4(node);
      if (addr !== null) {
        // incoming node is a valid ipv4 address
        if (family === 0 || family === 2) {
          family = 2;
        }
        else if (family === 10 && (flags & 8)) {
          addr = [0, 0, _htonl(0xffff), addr];
          family = 10;
        } else {
          return -2;
        }
      } else {
        addr = inetPton6(node);
        if (addr !== null) {
          // incoming node is a valid ipv6 address
          if (family === 0 || family === 10) {
            family = 10;
          } else {
            return -2;
          }
        }
      }
      if (addr != null) {
        ai = allocaddrinfo(family, type, proto, node, addr, port);
        HEAPU32[((out)>>2)] = ai;
        return 0;
      }
      if (flags & 4) {
        return -2;
      }
  
      //
      // try as a hostname
      //
      // resolve the hostname to a temporary fake address
      node = DNS.lookup_name(node);
      addr = inetPton4(node);
      if (family === 0) {
        family = 2;
      } else if (family === 10) {
        addr = [0, 0, _htonl(0xffff), addr];
      }
      ai = allocaddrinfo(family, type, proto, null, addr, port);
      HEAPU32[((out)>>2)] = ai;
      return 0;
    };

  
  
  var _getnameinfo = (sa, salen, node, nodelen, serv, servlen, flags) => {
      var info = readSockaddr(sa, salen);
      if (info.errno) {
        return -6;
      }
      var port = info.port;
      var addr = info.addr;
  
      var overflowed = false;
  
      if (node && nodelen) {
        var lookup;
        if ((flags & 1) || !(lookup = DNS.lookup_addr(addr))) {
          if (flags & 8) {
            return -2;
          }
        } else {
          addr = lookup;
        }
        var numBytesWrittenExclNull = stringToUTF8(addr, node, nodelen);
  
        if (numBytesWrittenExclNull+1 >= nodelen) {
          overflowed = true;
        }
      }
  
      if (serv && servlen) {
        port = '' + port;
        var numBytesWrittenExclNull = stringToUTF8(port, serv, servlen);
  
        if (numBytesWrittenExclNull+1 >= servlen) {
          overflowed = true;
        }
      }
  
      if (overflowed) {
        // Note: even when we overflow, getnameinfo() is specced to write out the truncated results.
        return -12;
      }
  
      return 0;
    };

  var Protocols = {
  list:[],
  map:{
  },
  };
  
  var stringToAscii = (str, buffer) => {
      for (var i = 0; i < str.length; ++i) {
        HEAP8[buffer++] = str.charCodeAt(i);
      }
      // Null-terminate the string
      HEAP8[buffer] = 0;
    };
  
  var _setprotoent = (stayopen) => {
      // void setprotoent(int stayopen);
  
      // Allocate and populate a protoent structure given a name, protocol number and array of aliases
      function allocprotoent(name, proto, aliases) {
        // write name into buffer
        var nameBuf = _malloc(name.length + 1);
        stringToAscii(name, nameBuf);
  
        // write aliases into buffer
        var j = 0;
        var length = aliases.length;
        var aliasListBuf = _malloc((length + 1) * 4); // Use length + 1 so we have space for the terminating NULL ptr.
  
        for (var i = 0; i < length; i++, j += 4) {
          var alias = aliases[i];
          var aliasBuf = _malloc(alias.length + 1);
          stringToAscii(alias, aliasBuf);
          HEAPU32[(((aliasListBuf)+(j))>>2)] = aliasBuf;
        }
        HEAPU32[(((aliasListBuf)+(j))>>2)] = 0; // Terminating NULL pointer.
  
        // generate protoent
        var pe = _malloc(12);
        HEAPU32[((pe)>>2)] = nameBuf;
        HEAPU32[(((pe)+(4))>>2)] = aliasListBuf;
        HEAP32[(((pe)+(8))>>2)] = proto;
        return pe;
      };
  
      // Populate the protocol 'database'. The entries are limited to tcp and udp, though it is fairly trivial
      // to add extra entries from /etc/protocols if desired - though not sure if that'd actually be useful.
      var list = Protocols.list;
      var map  = Protocols.map;
      if (list.length === 0) {
          var entry = allocprotoent('tcp', 6, ['TCP']);
          list.push(entry);
          map['tcp'] = map['6'] = entry;
          entry = allocprotoent('udp', 17, ['UDP']);
          list.push(entry);
          map['udp'] = map['17'] = entry;
      }
  
      _setprotoent.index = 0;
    };
  
  
  var _getprotobyname = (name) => {
      // struct protoent *getprotobyname(const char *);
      name = UTF8ToString(name);
      _setprotoent(true);
      var result = Protocols.map[name];
      return result;
    };

  
  var _getprotobynumber = (number) => {
      // struct protoent *getprotobynumber(int proto);
      _setprotoent(true);
      var result = Protocols.map[number];
      return result;
    };


  
  var arraySum = (array, index) => {
      var sum = 0;
      for (var i = 0; i <= index; sum += array[i++]) {
        // no-op
      }
      return sum;
    };
  
  
  var MONTH_DAYS_LEAP = [31,29,31,30,31,30,31,31,30,31,30,31];
  
  var MONTH_DAYS_REGULAR = [31,28,31,30,31,30,31,31,30,31,30,31];
  var addDays = (date, days) => {
      var newDate = new Date(date.getTime());
      while (days > 0) {
        var leap = isLeapYear(newDate.getFullYear());
        var currentMonth = newDate.getMonth();
        var daysInCurrentMonth = (leap ? MONTH_DAYS_LEAP : MONTH_DAYS_REGULAR)[currentMonth];
  
        if (days > daysInCurrentMonth-newDate.getDate()) {
          // we spill over to next month
          days -= (daysInCurrentMonth-newDate.getDate()+1);
          newDate.setDate(1);
          if (currentMonth < 11) {
            newDate.setMonth(currentMonth+1)
          } else {
            newDate.setMonth(0);
            newDate.setFullYear(newDate.getFullYear()+1);
          }
        } else {
          // we stay in current month
          newDate.setDate(newDate.getDate()+days);
          return newDate;
        }
      }
  
      return newDate;
    };
  
  
  
  
  var _strptime = (buf, format, tm) => {
      // char *strptime(const char *restrict buf, const char *restrict format, struct tm *restrict tm);
      // http://pubs.opengroup.org/onlinepubs/009695399/functions/strptime.html
      var pattern = UTF8ToString(format);
  
      // escape special characters
      // TODO: not sure we really need to escape all of these in JS regexps
      var SPECIAL_CHARS = '\\!@#$^&*()+=-[]/{}|:<>?,.';
      for (var i=0, ii=SPECIAL_CHARS.length; i<ii; ++i) {
        pattern = pattern.replace(new RegExp('\\'+SPECIAL_CHARS[i], 'g'), '\\'+SPECIAL_CHARS[i]);
      }
  
      // reduce number of matchers
      var EQUIVALENT_MATCHERS = {
        'A':  '%a',
        'B':  '%b',
        'c':  '%a %b %d %H:%M:%S %Y',
        'D':  '%m\\/%d\\/%y',
        'e':  '%d',
        'F':  '%Y-%m-%d',
        'h':  '%b',
        'R':  '%H\\:%M',
        'r':  '%I\\:%M\\:%S\\s%p',
        'T':  '%H\\:%M\\:%S',
        'x':  '%m\\/%d\\/(?:%y|%Y)',
        'X':  '%H\\:%M\\:%S'
      };
      // TODO: take care of locale
  
      var DATE_PATTERNS = {
        /* weekday name */    'a': '(?:Sun(?:day)?)|(?:Mon(?:day)?)|(?:Tue(?:sday)?)|(?:Wed(?:nesday)?)|(?:Thu(?:rsday)?)|(?:Fri(?:day)?)|(?:Sat(?:urday)?)',
        /* month name */      'b': '(?:Jan(?:uary)?)|(?:Feb(?:ruary)?)|(?:Mar(?:ch)?)|(?:Apr(?:il)?)|May|(?:Jun(?:e)?)|(?:Jul(?:y)?)|(?:Aug(?:ust)?)|(?:Sep(?:tember)?)|(?:Oct(?:ober)?)|(?:Nov(?:ember)?)|(?:Dec(?:ember)?)',
        /* century */         'C': '\\d\\d',
        /* day of month */    'd': '0[1-9]|[1-9](?!\\d)|1\\d|2\\d|30|31',
        /* hour (24hr) */     'H': '\\d(?!\\d)|[0,1]\\d|20|21|22|23',
        /* hour (12hr) */     'I': '\\d(?!\\d)|0\\d|10|11|12',
        /* day of year */     'j': '00[1-9]|0?[1-9](?!\\d)|0?[1-9]\\d(?!\\d)|[1,2]\\d\\d|3[0-6]\\d',
        /* month */           'm': '0[1-9]|[1-9](?!\\d)|10|11|12',
        /* minutes */         'M': '0\\d|\\d(?!\\d)|[1-5]\\d',
        /* whitespace */      'n': ' ',
        /* AM/PM */           'p': 'AM|am|PM|pm|A\\.M\\.|a\\.m\\.|P\\.M\\.|p\\.m\\.',
        /* seconds */         'S': '0\\d|\\d(?!\\d)|[1-5]\\d|60',
        /* week number */     'U': '0\\d|\\d(?!\\d)|[1-4]\\d|50|51|52|53',
        /* week number */     'W': '0\\d|\\d(?!\\d)|[1-4]\\d|50|51|52|53',
        /* weekday number */  'w': '[0-6]',
        /* 2-digit year */    'y': '\\d\\d',
        /* 4-digit year */    'Y': '\\d\\d\\d\\d',
        /* whitespace */      't': ' ',
        /* time zone */       'z': 'Z|(?:[\\+\\-]\\d\\d:?(?:\\d\\d)?)'
      };
  
      var MONTH_NUMBERS = {JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11};
      var DAY_NUMBERS_SUN_FIRST = {SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6};
      var DAY_NUMBERS_MON_FIRST = {MON: 0, TUE: 1, WED: 2, THU: 3, FRI: 4, SAT: 5, SUN: 6};
  
      var capture = [];
      var pattern_out = pattern
        .replace(/%(.)/g, (m, c) => EQUIVALENT_MATCHERS[c] || m)
        .replace(/%(.)/g, (_, c) => {
          let pat = DATE_PATTERNS[c];
          if (pat){
            capture.push(c);
            return `(${pat})`;
          } else {
            return c;
          }
        })
        .replace( // any number of space or tab characters match zero or more spaces
          /\s+/g,'\\s*'
        );
  
      var matches = new RegExp('^'+pattern_out, "i").exec(UTF8ToString(buf))
  
      function initDate() {
        function fixup(value, min, max) {
          return (typeof value != 'number' || isNaN(value)) ? min : (value>=min ? (value<=max ? value: max): min);
        };
        return {
          year: fixup(HEAP32[(((tm)+(20))>>2)] + 1900 , 1970, 9999),
          month: fixup(HEAP32[(((tm)+(16))>>2)], 0, 11),
          day: fixup(HEAP32[(((tm)+(12))>>2)], 1, 31),
          hour: fixup(HEAP32[(((tm)+(8))>>2)], 0, 23),
          min: fixup(HEAP32[(((tm)+(4))>>2)], 0, 59),
          sec: fixup(HEAP32[((tm)>>2)], 0, 59),
          gmtoff: 0
        };
      };
  
      if (matches) {
        var date = initDate();
        var value;
  
        var getMatch = (symbol) => {
          var pos = capture.indexOf(symbol);
          // check if symbol appears in regexp
          if (pos >= 0) {
            // return matched value or null (falsy!) for non-matches
            return matches[pos+1];
          }
          return;
        };
  
        // seconds
        if ((value=getMatch('S'))) {
          date.sec = Number(value);
        }
  
        // minutes
        if ((value=getMatch('M'))) {
          date.min = Number(value);
        }
  
        // hours
        if ((value=getMatch('H'))) {
          // 24h clock
          date.hour = Number(value);
        } else if ((value = getMatch('I'))) {
          // AM/PM clock
          var hour = Number(value);
          if ((value=getMatch('p'))) {
            hour += value.toUpperCase()[0] === 'P' ? 12 : 0;
          }
          date.hour = hour;
        }
  
        // year
        if ((value=getMatch('Y'))) {
          // parse from four-digit year
          date.year = Number(value);
        } else if ((value=getMatch('y'))) {
          // parse from two-digit year...
          var year = Number(value);
          if ((value=getMatch('C'))) {
            // ...and century
            year += Number(value)*100;
          } else {
            // ...and rule-of-thumb
            year += year<69 ? 2000 : 1900;
          }
          date.year = year;
        }
  
        // month
        if ((value=getMatch('m'))) {
          // parse from month number
          date.month = Number(value)-1;
        } else if ((value=getMatch('b'))) {
          // parse from month name
          date.month = MONTH_NUMBERS[value.substring(0,3).toUpperCase()] || 0;
          // TODO: derive month from day in year+year, week number+day of week+year
        }
  
        // day
        if ((value=getMatch('d'))) {
          // get day of month directly
          date.day = Number(value);
        } else if ((value=getMatch('j'))) {
          // get day of month from day of year ...
          var day = Number(value);
          var leapYear = isLeapYear(date.year);
          for (var month=0; month<12; ++month) {
            var daysUntilMonth = arraySum(leapYear ? MONTH_DAYS_LEAP : MONTH_DAYS_REGULAR, month-1);
            if (day<=daysUntilMonth+(leapYear ? MONTH_DAYS_LEAP : MONTH_DAYS_REGULAR)[month]) {
              date.day = day-daysUntilMonth;
            }
          }
        } else if ((value=getMatch('a'))) {
          // get day of month from weekday ...
          var weekDay = value.substring(0,3).toUpperCase();
          if ((value=getMatch('U'))) {
            // ... and week number (Sunday being first day of week)
            // Week number of the year (Sunday as the first day of the week) as a decimal number [00,53].
            // All days in a new year preceding the first Sunday are considered to be in week 0.
            var weekDayNumber = DAY_NUMBERS_SUN_FIRST[weekDay];
            var weekNumber = Number(value);
  
            // January 1st
            var janFirst = new Date(date.year, 0, 1);
            var endDate;
            if (janFirst.getDay() === 0) {
              // Jan 1st is a Sunday, and, hence in the 1st CW
              endDate = addDays(janFirst, weekDayNumber+7*(weekNumber-1));
            } else {
              // Jan 1st is not a Sunday, and, hence still in the 0th CW
              endDate = addDays(janFirst, 7-janFirst.getDay()+weekDayNumber+7*(weekNumber-1));
            }
            date.day = endDate.getDate();
            date.month = endDate.getMonth();
          } else if ((value=getMatch('W'))) {
            // ... and week number (Monday being first day of week)
            // Week number of the year (Monday as the first day of the week) as a decimal number [00,53].
            // All days in a new year preceding the first Monday are considered to be in week 0.
            var weekDayNumber = DAY_NUMBERS_MON_FIRST[weekDay];
            var weekNumber = Number(value);
  
            // January 1st
            var janFirst = new Date(date.year, 0, 1);
            var endDate;
            if (janFirst.getDay()===1) {
              // Jan 1st is a Monday, and, hence in the 1st CW
               endDate = addDays(janFirst, weekDayNumber+7*(weekNumber-1));
            } else {
              // Jan 1st is not a Monday, and, hence still in the 0th CW
              endDate = addDays(janFirst, 7-janFirst.getDay()+1+weekDayNumber+7*(weekNumber-1));
            }
  
            date.day = endDate.getDate();
            date.month = endDate.getMonth();
          }
        }
  
        // time zone
        if ((value = getMatch('z'))) {
          // GMT offset as either 'Z' or +-HH:MM or +-HH or +-HHMM
          if (value.toLowerCase() === 'z'){
            date.gmtoff = 0;
          } else {
            var match = value.match(/^((?:\-|\+)\d\d):?(\d\d)?/);
            date.gmtoff = match[1] * 3600;
            if (match[2]) {
              date.gmtoff += date.gmtoff >0 ? match[2] * 60 : -match[2] * 60
            }
          }
        }
  
        /*
      tm_sec  int seconds after the minute  0-61*
      tm_min  int minutes after the hour  0-59
      tm_hour int hours since midnight  0-23
      tm_mday int day of the month  1-31
      tm_mon  int months since January  0-11
      tm_year int years since 1900
      tm_wday int days since Sunday 0-6
      tm_yday int days since January 1  0-365
      tm_isdst  int Daylight Saving Time flag
      tm_gmtoff long offset from GMT (seconds)
      */
  
        var fullDate = new Date(date.year, date.month, date.day, date.hour, date.min, date.sec, 0);
        HEAP32[((tm)>>2)] = fullDate.getSeconds();
        HEAP32[(((tm)+(4))>>2)] = fullDate.getMinutes();
        HEAP32[(((tm)+(8))>>2)] = fullDate.getHours();
        HEAP32[(((tm)+(12))>>2)] = fullDate.getDate();
        HEAP32[(((tm)+(16))>>2)] = fullDate.getMonth();
        HEAP32[(((tm)+(20))>>2)] = fullDate.getFullYear()-1900;
        HEAP32[(((tm)+(24))>>2)] = fullDate.getDay();
        HEAP32[(((tm)+(28))>>2)] = arraySum(isLeapYear(fullDate.getFullYear()) ? MONTH_DAYS_LEAP : MONTH_DAYS_REGULAR, fullDate.getMonth()-1)+fullDate.getDate()-1;
        HEAP32[(((tm)+(32))>>2)] = 0;
        HEAP32[(((tm)+(36))>>2)] = date.gmtoff;
  
        // we need to convert the matched sequence into an integer array to take care of UTF-8 characters > 0x7F
        // TODO: not sure that intArrayFromString handles all unicode characters correctly
        return buf+lengthBytesUTF8(matches[0]);
      }
  
      return 0;
    };



  
  
  var stackAlloc = (sz) => __emscripten_stack_alloc(sz);
  var stringToUTF8OnStack = (str) => {
      var size = lengthBytesUTF8(str) + 1;
      var ret = stackAlloc(size);
      stringToUTF8(str, ret, size);
      return ret;
    };




  FS.createPreloadedFile = FS_createPreloadedFile;
  FS.preloadFile = FS_preloadFile;
  FS.staticInit();;
// End JS library code

// include: postlibrary.js
// This file is included after the automatically-generated JS library code
// but before the wasm module is created.

{

  // Begin ATMODULES hooks
  if (Module['noExitRuntime']) noExitRuntime = Module['noExitRuntime'];
if (Module['preloadPlugins']) preloadPlugins = Module['preloadPlugins'];
if (Module['print']) out = Module['print'];
if (Module['printErr']) err = Module['printErr'];
if (Module['wasmBinary']) wasmBinary = Module['wasmBinary'];
  // End ATMODULES hooks

  if (Module['arguments']) arguments_ = Module['arguments'];
  if (Module['thisProgram']) thisProgram = Module['thisProgram'];

  if (Module['preInit']) {
    if (typeof Module['preInit'] == 'function') Module['preInit'] = [Module['preInit']];
    while (Module['preInit'].length > 0) {
      Module['preInit'].shift()();
    }
  }
}

// Begin runtime exports
  // End runtime exports
  // Begin JS library exports
  // End JS library exports

// end include: postlibrary.js


// Imports from the Wasm binary.
var _php_time,
  _php_date_get_date_ce,
  _php_date_get_immutable_ce,
  _php_date_get_interface_ce,
  _php_date_get_timezone_ce,
  _php_date_get_interval_ce,
  _php_date_get_period_ce,
  _zend_register_ini_entries_ex,
  _zend_register_string_constant,
  _zend_register_long_constant,
  _zend_hash_str_find,
  _zend_add_attribute,
  ___zend_malloc,
  _zend_unregister_ini_entries_ex,
  __efree,
  _php_info_print_table_start,
  _php_info_print_table_row,
  _cfg_get_entry,
  _php_info_print_table_end,
  _display_ini_entries,
  _zend_hash_destroy,
  __efree_48,
  _zend_register_internal_interface,
  _zend_declare_typed_class_constant,
  _zend_register_internal_class_with_flags,
  _zend_class_implements,
  _zend_declare_typed_property,
  _get_timezone_info,
  _zend_throw_error,
  __emalloc_48,
  __zend_hash_init,
  _zend_hash_str_add,
  _php_format_date_obj,
  __estrdup,
  __emalloc_16,
  _ap_php_snprintf,
  _ap_php_slprintf,
  _smart_str_erealloc,
  _php_format_date,
  _php_idate,
  _zend_wrong_parameters_count_error,
  _zend_parse_arg_str_slow,
  _zend_parse_arg_long_slow,
  _zend_wrong_parameter_error,
  _php_error_docref,
  _php_date_set_tzdb,
  _php_version_compare,
  _php_parse_date,
  _php_mktime,
  _php_strftime,
  __emalloc_320,
  __erealloc,
  __emalloc,
  _zend_wrong_parameters_none_error,
  _zend_parse_arg_bool_slow,
  __zend_new_array,
  _add_assoc_long_ex,
  _zend_hash_real_init_packed,
  _add_next_index_long,
  _add_assoc_string_ex,
  _add_index_long,
  _php_date_instantiate,
  _object_init_ex,
  _php_date_initialize,
  _zend_throw_exception_ex,
  _php_date_initialize_from_ts_long,
  _php_date_initialize_from_ts_double,
  _zend_argument_error,
  _instanceof_function_slow,
  _zval_ptr_dtor,
  _zend_parse_arg_number_slow,
  _zend_string_concat3,
  __zend_new_array_0,
  _zend_std_get_properties,
  _zend_hash_add,
  _zend_hash_str_update,
  __emalloc_32,
  _add_index_string,
  _add_assoc_zval_ex,
  _add_assoc_bool_ex,
  _add_assoc_double_ex,
  _zend_parse_method_parameters,
  _zend_replace_error_handling,
  _zend_restore_error_handling,
  _zend_spprintf,
  _add_assoc_str_ex,
  _zend_hash_next_index_insert,
  _zval_get_long_func,
  _zval_get_double_func,
  _zend_oob_double_to_long_error,
  _zend_dval_to_lval_slow,
  _zval_get_string_func,
  _get_active_function_or_method_name,
  _zend_parse_parameters_ex,
  _zend_type_error,
  _zend_error,
  _zend_create_internal_iterator_zval,
  _zend_argument_value_error,
  _add_next_index_string,
  _add_assoc_null_ex,
  __estrndup,
  _zend_parse_arg_double_slow,
  _zend_ini_double,
  _zend_strpprintf,
  _OnUpdateString,
  _zend_error_noreturn,
  _zend_object_std_init,
  _object_properties_init,
  _zend_object_std_dtor,
  _zend_objects_clone_members,
  _zend_std_compare_objects,
  _zend_std_get_properties_for,
  _zend_array_dup,
  _zend_std_has_property,
  _zend_is_true,
  _zend_std_read_property,
  _zend_std_write_property,
  _zend_std_get_property_ptr_ptr,
  __emalloc_96,
  _zend_iterator_init,
  _zend_readonly_property_modification_error_ex,
  _zend_std_unset_property,
  _zend_lazy_object_get_properties,
  _rebuild_object_properties_internal,
  _zend_unmangle_property_name_ex,
  _zend_lookup_class,
  _zend_update_property,
  __ecalloc,
  __emalloc_8,
  _php_pcre2_code_copy,
  _php_pcre2_code_copy_with_tables,
  _php_pcre2_code_free,
  _php_pcre2_compile,
  _php_pcre2_config,
  _malloc,
  _php_pcre2_general_context_create,
  _php_pcre2_compile_context_create,
  _php_pcre2_match_context_create,
  _php_pcre2_convert_context_create,
  _php_pcre2_general_context_copy,
  _php_pcre2_compile_context_copy,
  _php_pcre2_match_context_copy,
  _php_pcre2_convert_context_copy,
  _php_pcre2_general_context_free,
  _php_pcre2_compile_context_free,
  _php_pcre2_match_context_free,
  _php_pcre2_convert_context_free,
  _php_pcre2_set_character_tables,
  _php_pcre2_set_bsr,
  _php_pcre2_set_max_pattern_length,
  _pcre2_set_max_pattern_compiled_length_8,
  _php_pcre2_set_newline,
  _pcre2_set_max_varlookbehind_8,
  _php_pcre2_set_parens_nest_limit,
  _php_pcre2_set_compile_extra_options,
  _php_pcre2_set_compile_recursion_guard,
  _php_pcre2_set_callout,
  _pcre2_set_substitute_callout_8,
  _php_pcre2_set_heap_limit,
  _php_pcre2_set_match_limit,
  _php_pcre2_set_depth_limit,
  _php_pcre2_set_offset_limit,
  _php_pcre2_set_recursion_limit,
  _php_pcre2_set_recursion_memory_management,
  _php_pcre2_set_glob_separator,
  _php_pcre2_set_glob_escape,
  _pcre2_pattern_convert_8,
  _pcre2_converted_pattern_free_8,
  _php_pcre2_dfa_match,
  _php_pcre2_get_error_message,
  _php_pcre2_jit_compile,
  _php_pcre2_jit_match,
  _php_pcre2_jit_free_unused_memory,
  _php_pcre2_jit_stack_create,
  _php_pcre2_jit_stack_assign,
  _php_pcre2_jit_stack_free,
  _php_pcre2_maketables,
  _pcre2_maketables_free_8,
  _php_pcre2_match_data_create,
  _php_pcre2_match_data_create_from_pattern,
  _php_pcre2_match_data_free,
  _php_pcre2_get_mark,
  _php_pcre2_get_ovector_pointer,
  _php_pcre2_get_ovector_count,
  _php_pcre2_get_startchar,
  _pcre2_get_match_data_size_8,
  _pcre2_get_match_data_heapframes_size_8,
  _php_pcre2_match,
  _php_pcre2_pattern_info,
  _php_pcre2_callout_enumerate,
  _php_pcre2_serialize_encode,
  _php_pcre2_serialize_decode,
  _php_pcre2_serialize_get_number_of_codes,
  _php_pcre2_serialize_free,
  _php_pcre2_substitute,
  _php_pcre2_substring_nametable_scan,
  _php_pcre2_substring_length_bynumber,
  _php_pcre2_substring_copy_byname,
  _php_pcre2_substring_copy_bynumber,
  _php_pcre2_substring_get_byname,
  _php_pcre2_substring_get_bynumber,
  _php_pcre2_substring_free,
  _php_pcre2_substring_length_byname,
  _php_pcre2_substring_list_get,
  _php_pcre2_substring_list_free,
  _php_pcre2_substring_number_from_name,
  _pcre_get_compiled_regex_cache_ex,
  _zend_string_concat2,
  _zend_hash_find,
  _zend_hash_apply_with_argument,
  _zend_hash_add_new,
  _pcre_get_compiled_regex_cache,
  _pcre_get_compiled_regex,
  _php_pcre_create_match_data,
  _php_pcre_free_match_data,
  _php_pcre_match_impl,
  _zval_ptr_safe_dtor,
  _zend_try_assign_typed_ref_arr,
  __safe_emalloc,
  _zend_hash_next_index_insert_new,
  _zend_hash_index_add_new,
  _zend_hash_update,
  _zend_new_pair,
  _zend_hash_str_add_new,
  _zend_flf_parse_arg_str_slow,
  _zend_wrong_parameter_type_error,
  _php_pcre_replace,
  _php_pcre_replace_impl,
  _zend_argument_type_error,
  _zend_try_assign_typed_ref_long,
  _zend_fcall_info_init,
  _zend_release_fcall_info_cache,
  _zval_try_get_string_func,
  _zend_is_callable_ex,
  _zend_array_destroy,
  _php_pcre_split_impl,
  _php_pcre_grep_impl,
  _zend_hash_index_update,
  _zend_register_bool_constant,
  _php_pcre_mctx,
  _php_pcre_gctx,
  _php_pcre_cctx,
  _php_pcre_pce_incref,
  _php_pcre_pce_decref,
  _php_pcre_pce_re,
  _zend_call_function,
  _OnUpdateLong,
  _zend_parse_parameters,
  _zend_value_error,
  _zend_zval_type_name,
  _finfo_objects_new,
  _php_check_open_basedir,
  _expand_filepath_with_mode,
  _zend_throw_exception,
  _zend_argument_must_not_be_empty_error,
  _php_le_stream_context,
  _zend_fetch_resource_ex,
  _php_stream_context_alloc,
  _php_stream_locate_url_wrapper,
  __php_stream_open_wrapper_ex,
  __php_stream_stat,
  __php_stream_free,
  _php_file_le_stream,
  _php_file_le_pstream,
  _zend_fetch_resource2_ex,
  __php_stream_tell,
  __php_stream_seek,
  _zend_zval_value_name,
  __emalloc_160,
  __php_stream_write,
  __php_stream_read,
  __emalloc_huge,
  __emalloc_24,
  __php_stream_opendir,
  __php_stream_readdir,
  __php_stream_get_line,
  __emalloc_large,
  _zend_vspprintf,
  __php_stream_cast,
  _zend_str_tolower_dup,
  _zend_memnstr_ex,
  _zend_hash_index_find,
  _sapi_register_input_filter,
  __zend_handle_numeric_str_ex,
  _php_register_variable_ex,
  _zend_is_auto_global,
  __convert_to_string,
  _php_strip_tags_ex,
  _php_escape_html_entities_ex,
  _php_addslashes,
  _get_active_function_name,
  __is_numeric_string_ex,
  _php_uri_get_parser,
  _php_uri_parse_to_struct,
  _zend_binary_strcasecmp,
  _php_uri_struct_free,
  _zend_is_callable,
  __call_user_function_impl,
  _PHP_ADLER32Init,
  _PHP_ADLER32Update,
  _PHP_ADLER32Final,
  _PHP_ADLER32Copy,
  _php_hash_serialize,
  _php_hash_unserialize,
  _PHP_CRC32Init,
  _PHP_CRC32Update,
  _PHP_CRC32BUpdate,
  _PHP_CRC32CUpdate,
  _PHP_CRC32LEFinal,
  _PHP_CRC32BEFinal,
  _PHP_CRC32Copy,
  _PHP_FNV132Init,
  _PHP_FNV132Update,
  _PHP_FNV132Final,
  _PHP_FNV1a32Update,
  _PHP_FNV164Init,
  _PHP_FNV164Update,
  _PHP_FNV164Final,
  _PHP_FNV1a64Update,
  _php_hash_copy,
  _PHP_GOSTInit,
  _PHP_GOSTInitCrypto,
  _PHP_GOSTUpdate,
  _PHP_GOSTFinal,
  _php_hash_unserialize_spec,
  _PHP_3HAVAL128Init,
  _PHP_HAVALUpdate,
  _PHP_HAVAL128Final,
  _PHP_3HAVAL160Init,
  _PHP_HAVAL160Final,
  _PHP_3HAVAL192Init,
  _PHP_HAVAL192Final,
  _PHP_3HAVAL224Init,
  _PHP_HAVAL224Final,
  _PHP_3HAVAL256Init,
  _PHP_HAVAL256Final,
  _PHP_4HAVAL128Init,
  _PHP_4HAVAL160Init,
  _PHP_4HAVAL192Init,
  _PHP_4HAVAL224Init,
  _PHP_4HAVAL256Init,
  _PHP_5HAVAL128Init,
  _PHP_5HAVAL160Init,
  _PHP_5HAVAL192Init,
  _PHP_5HAVAL224Init,
  _PHP_5HAVAL256Init,
  _PHP_JOAATInit,
  _PHP_JOAATUpdate,
  _PHP_JOAATFinal,
  _PHP_MD4InitArgs,
  _PHP_MD4Update,
  _PHP_MD4Final,
  _PHP_MD2InitArgs,
  _PHP_MD2Update,
  _PHP_MD2Final,
  _PHP_MD5InitArgs,
  _PHP_MD5Update,
  _PHP_MD5Final,
  _PHP_MURMUR3AInit,
  _PHP_MURMUR3AUpdate,
  _PHP_MURMUR3AFinal,
  _PHP_MURMUR3ACopy,
  _PHP_MURMUR3CInit,
  _PHP_MURMUR3CUpdate,
  _PHP_MURMUR3CFinal,
  _PHP_MURMUR3CCopy,
  _PHP_MURMUR3FInit,
  _PHP_MURMUR3FUpdate,
  _PHP_MURMUR3FFinal,
  _PHP_MURMUR3FCopy,
  _PHP_RIPEMD128Init,
  _PHP_RIPEMD128Update,
  _PHP_RIPEMD128Final,
  _PHP_RIPEMD160Init,
  _PHP_RIPEMD160Update,
  _PHP_RIPEMD160Final,
  _PHP_RIPEMD256Init,
  _PHP_RIPEMD256Update,
  _PHP_RIPEMD256Final,
  _PHP_RIPEMD320Init,
  _PHP_RIPEMD320Update,
  _PHP_RIPEMD320Final,
  _PHP_SHA256InitArgs,
  _PHP_SHA256Update,
  _PHP_SHA256Final,
  _PHP_SHA224InitArgs,
  _PHP_SHA224Update,
  _PHP_SHA224Final,
  _PHP_SHA384InitArgs,
  _PHP_SHA384Update,
  _PHP_SHA384Final,
  _PHP_SHA512InitArgs,
  _PHP_SHA512_256InitArgs,
  _PHP_SHA512_224InitArgs,
  _PHP_SHA512Update,
  _PHP_SHA512Final,
  _PHP_SHA512_256Final,
  _PHP_SHA512_224Final,
  _PHP_SHA1InitArgs,
  _PHP_SHA1Update,
  _PHP_SHA1Final,
  _PHP_SHA3224Init,
  _PHP_SHA3224Update,
  _php_hash_serialize_spec,
  _PHP_SHA3256Init,
  _PHP_SHA3256Update,
  _PHP_SHA3384Init,
  _PHP_SHA3384Update,
  _PHP_SHA3512Init,
  _PHP_SHA3512Update,
  _PHP_SNEFRUInit,
  _PHP_SNEFRUUpdate,
  _PHP_SNEFRUFinal,
  _PHP_3TIGERInit,
  _PHP_4TIGERInit,
  _PHP_TIGERUpdate,
  _PHP_TIGER128Final,
  _PHP_TIGER160Final,
  _PHP_TIGER192Final,
  _PHP_WHIRLPOOLInit,
  _PHP_WHIRLPOOLUpdate,
  _PHP_WHIRLPOOLFinal,
  _PHP_XXH32Init,
  _PHP_XXH32Update,
  _PHP_XXH32Final,
  _PHP_XXH32Copy,
  _PHP_XXH64Init,
  _PHP_XXH64Update,
  _PHP_XXH64Final,
  _PHP_XXH64Copy,
  _PHP_XXH3_64_Init,
  _PHP_XXH3_64_Update,
  _PHP_XXH3_64_Final,
  _PHP_XXH3_64_Copy,
  _PHP_XXH3_128_Init,
  _PHP_XXH3_128_Update,
  _PHP_XXH3_128_Final,
  _PHP_XXH3_128_Copy,
  _php_hash_fetch_ops,
  _zend_string_tolower_ex,
  _php_hash_register_algo,
  _add_next_index_str,
  _php_safe_bcmp,
  _object_properties_load,
  _php_stream_filter_register_factory,
  _php_output_handler_alias_register,
  _php_output_handler_conflict_register,
  _php_stream_filter_unregister_factory,
  _zend_get_constant_str,
  _php_output_handler_create_internal,
  _php_output_get_level,
  _php_output_handler_conflict,
  _php_iconv_string,
  _libiconv_open,
  _libiconv,
  _libiconv_close,
  _php_get_internal_encoding,
  _php_base64_encode_ex,
  _php_base64_decode_ex,
  _php_quot_print_decode,
  _add_next_index_stringl,
  _add_assoc_stringl_ex,
  __emalloc_40,
  _zend_alter_ini_entry,
  _php_get_input_encoding,
  _php_get_output_encoding,
  _php_output_get_status,
  _sapi_add_header_ex,
  _php_output_handler_hook,
  __php_stream_filter_alloc,
  _php_stream_bucket_unlink,
  _php_stream_bucket_delref,
  _php_stream_bucket_new,
  _php_stream_bucket_append,
  ___zend_realloc,
  _zend_gcvt,
  _php_next_utf8_char,
  _zend_get_recursion_guard,
  _zend_call_known_function,
  _rc_dtor_func,
  _zend_get_properties_for,
  _zend_read_property_ex,
  _object_init,
  _php_json_parser_error_code,
  _php_json_parser_init_ex,
  _php_json_parser_init,
  _php_json_parse,
  _zend_strtod,
  _php_json_encode_string,
  _php_json_encode_ex,
  _php_json_encode,
  _php_json_decode_ex,
  _php_json_validate_ex,
  _lexbor_memory_setup,
  _lexbor_array_obj_create,
  _lexbor_calloc,
  _lexbor_array_obj_init,
  _lexbor_malloc,
  _lexbor_array_obj_clean,
  _lexbor_array_obj_destroy,
  _lexbor_free,
  _lexbor_array_obj_expand,
  _lexbor_realloc,
  _lexbor_array_obj_push,
  _lexbor_array_obj_push_wo_cls,
  _lexbor_array_obj_push_n,
  _lexbor_array_obj_pop,
  _lexbor_array_obj_delete,
  _lexbor_array_obj_erase_noi,
  _lexbor_array_obj_get_noi,
  _lexbor_array_obj_length_noi,
  _lexbor_array_obj_size_noi,
  _lexbor_array_obj_struct_size_noi,
  _lexbor_array_obj_last_noi,
  _lexbor_array_create,
  _lexbor_array_init,
  _lexbor_array_clean,
  _lexbor_array_destroy,
  _lexbor_array_expand,
  _lexbor_array_push,
  _lexbor_array_pop,
  _lexbor_array_insert,
  _lexbor_array_set,
  _lexbor_array_delete,
  _lexbor_array_get_noi,
  _lexbor_array_length_noi,
  _lexbor_array_size_noi,
  _lexbor_avl_create,
  _lexbor_avl_init,
  _lexbor_dobject_create,
  _lexbor_dobject_init,
  _lexbor_avl_clean,
  _lexbor_dobject_clean,
  _lexbor_avl_destroy,
  _lexbor_dobject_destroy,
  _lexbor_avl_node_make,
  _lexbor_dobject_calloc,
  _lexbor_avl_node_clean,
  _lexbor_avl_node_destroy,
  _lexbor_dobject_free,
  _lexbor_avl_insert,
  _lexbor_avl_remove,
  _lexbor_avl_remove_by_node,
  _lexbor_avl_search,
  _lexbor_avl_foreach,
  _lexbor_avl_foreach_recursion,
  _lexbor_bst_create,
  _lexbor_bst_init,
  _lexbor_bst_clean,
  _lexbor_bst_destroy,
  _lexbor_bst_entry_make,
  _lexbor_bst_insert,
  _lexbor_bst_insert_not_exists,
  _lexbor_bst_search,
  _lexbor_bst_search_close,
  _lexbor_bst_remove,
  _lexbor_bst_remove_by_pointer,
  _lexbor_bst_remove_close,
  _lexbor_bst_serialize,
  _lexbor_bst_serialize_entry,
  _lexbor_conv_int64_to_data,
  _lexbor_conv_float_to_data,
  _lexbor_dtoa,
  _lexbor_conv_long_to_data,
  _lexbor_conv_data_to_double,
  _lexbor_strtod_internal,
  _lexbor_conv_data_to_ulong,
  _lexbor_conv_data_to_long,
  _lexbor_conv_data_to_uint,
  _lexbor_conv_dec_to_hex,
  _lexbor_cached_power_dec,
  _lexbor_cached_power_bin,
  _lexbor_mem_create,
  _lexbor_mem_init,
  _lexbor_mem_clean,
  _lexbor_mem_destroy,
  _lexbor_dobject_alloc,
  _lexbor_mem_alloc,
  _lexbor_dobject_by_absolute_position,
  _lexbor_dobject_allocated_noi,
  _lexbor_dobject_cache_length_noi,
  _lexbor_hash_make_id,
  _lexbor_hash_copy,
  _lexbor_mraw_alloc,
  _lexbor_hash_make_id_lower,
  _lexbor_hash_copy_lower,
  _lexbor_hash_make_id_upper,
  _lexbor_hash_copy_upper,
  _lexbor_hash_create,
  _lexbor_hash_init,
  _lexbor_mraw_create,
  _lexbor_mraw_init,
  _lexbor_hash_clean,
  _lexbor_mraw_clean,
  _lexbor_hash_destroy,
  _lexbor_mraw_destroy,
  _lexbor_hash_insert,
  _lexbor_hash_insert_by_entry,
  _lexbor_hash_remove,
  _lexbor_mraw_free,
  _lexbor_hash_remove_by_hash_id,
  _lexbor_hash_search,
  _lexbor_hash_search_by_hash_id,
  _lexbor_str_data_ncmp,
  _lexbor_str_data_nlocmp_right,
  _lexbor_str_data_nupcmp_right,
  _lexbor_mem_chunk_make,
  _lexbor_mem_chunk_destroy,
  _lexbor_mem_chunk_init,
  _lexbor_mem_calloc,
  _lexbor_mem_current_length_noi,
  _lexbor_mem_current_size_noi,
  _lexbor_mem_chunk_length_noi,
  _lexbor_mem_align_noi,
  _lexbor_mem_align_floor_noi,
  _lexbor_mraw_calloc,
  _lexbor_mraw_realloc,
  _lexbor_mraw_data_size_noi,
  _lexbor_mraw_data_size_set_noi,
  _lexbor_mraw_dup_noi,
  _lexbor_plog_init,
  _lexbor_plog_destroy,
  _lexbor_plog_create_noi,
  _lexbor_plog_clean_noi,
  _lexbor_plog_push_noi,
  _lexbor_plog_length_noi,
  _lexbor_printf_size,
  _lexbor_vprintf_size,
  _lexbor_sprintf,
  _lexbor_vsprintf,
  _lexbor_serialize_length_cb,
  _lexbor_serialize_copy_cb,
  _lexbor_shs_entry_get_static,
  _lexbor_shs_entry_get_lower_static,
  _lexbor_shs_entry_get_upper_static,
  _lexbor_str_create,
  _lexbor_str_init,
  _lexbor_str_init_append,
  _lexbor_str_clean,
  _lexbor_str_clean_all,
  _lexbor_str_destroy,
  _lexbor_str_realloc,
  _lexbor_str_check_size,
  _lexbor_str_append,
  _lexbor_str_append_before,
  _lexbor_str_append_one,
  _lexbor_str_append_lowercase,
  _lexbor_str_append_with_rep_null_chars,
  _lexbor_str_copy,
  _lexbor_str_stay_only_whitespace,
  _lexbor_str_strip_collapse_whitespace,
  _lexbor_str_crop_whitespace_from_begin,
  _lexbor_str_whitespace_from_begin,
  _lexbor_str_whitespace_from_end,
  _lexbor_str_data_ncasecmp_first,
  _lexbor_str_data_ncasecmp_end,
  _lexbor_str_data_ncasecmp_contain,
  _lexbor_str_data_ncasecmp,
  _lexbor_str_data_casecmp,
  _lexbor_str_data_ncmp_end,
  _lexbor_str_data_ncmp_contain,
  _lexbor_str_data_cmp,
  _lexbor_str_data_cmp_ws,
  _lexbor_str_data_to_lowercase,
  _lexbor_str_data_to_uppercase,
  _lexbor_str_data_find_lowercase,
  _lexbor_str_data_find_uppercase,
  _lexbor_str_data_noi,
  _lexbor_str_length_noi,
  _lexbor_str_size_noi,
  _lexbor_str_data_set_noi,
  _lexbor_str_length_set_noi,
  _lxb_css_memory_create,
  _lxb_css_memory_init,
  _lxb_css_memory_destroy,
  _lxb_css_memory_clean,
  _lxb_css_memory_ref_inc,
  _lxb_css_memory_ref_dec,
  _lxb_css_memory_ref_dec_destroy,
  _lxb_css_make_data,
  _lxb_css_serialize_char_handler,
  _lxb_css_serialize_str_handler,
  _lxb_css_log_create,
  _lxb_css_log_init,
  _lxb_css_log_clean,
  _lxb_css_log_destroy,
  _lxb_css_log_append,
  _lxb_css_log_push,
  _lxb_css_log_format,
  _lxb_css_log_not_supported,
  _lxb_css_log_type_by_id,
  _lxb_css_log_serialize,
  _lxb_css_log_message_serialize,
  _lxb_css_log_serialize_char,
  _lxb_css_log_message_serialize_char,
  _lxb_css_parser_create,
  _lxb_css_parser_init,
  _lxb_css_syntax_tokenizer_create,
  _lxb_css_syntax_tokenizer_init,
  _lxb_css_parser_clean,
  _lxb_css_syntax_tokenizer_clean,
  _lxb_css_parser_erase,
  _lxb_css_parser_destroy,
  _lxb_css_syntax_tokenizer_destroy,
  _lxb_css_parser_states_push,
  _lxb_css_parser_states_next,
  _lxb_css_parser_types_push,
  _lxb_css_parser_stop,
  _lxb_css_parser_fail,
  _lxb_css_parser_unexpected,
  _lxb_css_parser_unexpected_status,
  _lxb_css_parser_success,
  _lxb_css_state_success,
  _lxb_css_parser_failed,
  _lxb_css_parser_unexpected_data,
  _lxb_css_syntax_token_error,
  _lxb_css_parser_memory_fail,
  _lxb_css_parser_unexpected_data_status,
  _lxb_css_selectors_state_pseudo_class_function__undef,
  _lxb_css_selectors_state_pseudo_class_function_current,
  _lxb_css_selectors_state_complex_list,
  _lxb_css_selectors_state_pseudo_class_function_dir,
  _lxb_css_selectors_state_pseudo_class_function_has,
  _lxb_css_selectors_state_relative_list,
  _lxb_css_selectors_state_pseudo_class_function_is,
  _lxb_css_selectors_state_pseudo_class_function_lang,
  _lxb_css_selectors_state_pseudo_class_function_not,
  _lxb_css_selectors_state_pseudo_class_function_nth_child,
  _lxb_css_syntax_anb_handler,
  _lxb_css_syntax_parser_token,
  _lxb_css_syntax_parser_consume,
  _lxb_css_syntax_token_consume,
  _lxb_css_syntax_parser_components_push,
  _lxb_css_selectors_state_pseudo_class_function_nth_col,
  _lxb_css_selectors_state_pseudo_class_function_nth_last_child,
  _lxb_css_selectors_state_pseudo_class_function_nth_last_col,
  _lxb_css_selectors_state_pseudo_class_function_nth_last_of_type,
  _lxb_css_selectors_state_pseudo_class_function_nth_of_type,
  _lxb_css_selectors_state_pseudo_class_function_where,
  _lxb_css_selectors_state_pseudo_element_function__undef,
  _lxb_css_state_failed,
  _lxb_css_selector_pseudo_class_by_name,
  _lxb_css_selector_pseudo_class_function_by_name,
  _lxb_css_selector_pseudo_class_function_by_id,
  _lxb_css_selector_pseudo_element_by_name,
  _lxb_css_selector_pseudo_element_function_by_name,
  _lxb_css_selector_pseudo_element_function_by_id,
  _lxb_css_selector_pseudo_function_by_id,
  _lxb_css_selector_pseudo_function_can_empty,
  _lxb_css_selectors_state_function_end,
  _lxb_css_selectors_state_function_forgiving_relative,
  _lxb_css_selectors_state_function_forgiving,
  _lxb_css_selector_create,
  _lxb_css_selector_destroy,
  _lxb_css_selector_destroy_chain,
  _lxb_css_selector_remove,
  _lxb_css_selector_list_create,
  _lxb_css_selector_list_remove,
  _lxb_css_selector_list_selectors_remove,
  _lxb_css_selector_list_destroy,
  _lxb_css_selector_list_destroy_chain,
  _lxb_css_selector_list_destroy_memory,
  _lxb_css_selector_serialize,
  _lxb_css_selector_serialize_chain,
  _lxb_css_selector_combinator,
  _lxb_css_selector_serialize_chain_char,
  _lxb_css_selector_serialize_list,
  _lxb_css_selector_serialize_list_chain,
  _lxb_css_selector_serialize_list_chain_char,
  _lxb_css_selector_serialize_anb_of,
  _lxb_css_syntax_anb_serialize,
  _lxb_css_selector_list_append,
  _lxb_css_selector_append_next,
  _lxb_css_selector_list_append_next,
  _lxb_css_selectors_create,
  _lxb_css_selectors_init,
  _lxb_css_selectors_clean,
  _lxb_css_selectors_destroy,
  _lxb_css_selectors_parse,
  _lxb_css_selectors_parse_complex_list,
  _lxb_css_syntax_parser_run,
  _lxb_css_selectors_parse_compound_list,
  _lxb_css_selectors_parse_simple_list,
  _lxb_css_selectors_parse_relative_list,
  _lxb_css_selectors_parse_complex,
  _lxb_css_selectors_parse_compound,
  _lxb_css_selectors_parse_simple,
  _lxb_css_selectors_parse_relative,
  _lxb_css_selectors_state_compound_list,
  _lxb_css_selectors_state_simple_list,
  _lxb_css_selectors_state_complex,
  _lxb_css_selectors_state_compound,
  _lxb_css_selectors_state_simple,
  _lxb_css_selectors_state_relative,
  _lxb_css_syntax_token,
  _lxb_css_syntax_token_next,
  _lxb_css_syntax_token_string_dup,
  _lxb_css_syntax_parser_function_push,
  _lxb_css_state_stop,
  _lxb_css_syntax_anb_parse,
  _lxb_css_syntax_parser_pipe_push,
  _lxb_css_syntax_anb_serialize_char,
  _lxb_css_syntax_parser_token_wo_ws,
  _lxb_css_syntax_parser_list_rules_push,
  _lxb_css_syntax_stack_expand,
  _lxb_css_syntax_parser_end,
  _lxb_css_syntax_parser_at_rule_push,
  _lxb_css_syntax_parser_start_block,
  _lxb_css_syntax_parser_qualified_push,
  _lxb_css_syntax_parser_declarations_push,
  _lxb_css_syntax_tokenizer_lookup_colon,
  _lxb_css_syntax_parser_block_push,
  _lxb_css_syntax_tokenizer_lookup_declaration_ws_end,
  _lxb_css_syntax_tokenizer_lookup_important,
  _lxb_css_syntax_tokenizer_error_add,
  _lxb_css_syntax_codepoint_to_ascii,
  _lxb_css_syntax_parse_list_rules,
  _lxb_css_syntax_ident_serialize,
  _lxb_css_syntax_string_serialize,
  _lxb_css_syntax_ident_or_string_serialize,
  _lxb_css_syntax_token_string_free,
  _lxb_css_syntax_token_consume_n,
  _lxb_css_syntax_token_string_make,
  _lxb_css_syntax_token_type_name_by_id,
  _lxb_css_syntax_token_type_id_by_name,
  _lxb_css_syntax_token_serialize,
  _lxb_css_syntax_token_serialize_str,
  _lxb_css_syntax_token_serialize_char,
  _lxb_css_syntax_token_create_noi,
  _lxb_css_syntax_token_clean_noi,
  _lxb_css_syntax_token_destroy_noi,
  _lxb_css_syntax_token_type_name_noi,
  _lxb_css_syntax_token_type_noi,
  _lxb_css_syntax_tokenizer_status_noi,
  _lxb_dom_interface_create,
  _lxb_dom_element_interface_create,
  _lxb_dom_interface_clone,
  _lxb_dom_element_interface_clone,
  _lxb_dom_text_interface_clone,
  _lxb_dom_processing_instruction_interface_clone,
  _lxb_dom_comment_interface_clone,
  _lxb_dom_document_interface_clone,
  _lxb_dom_document_type_interface_clone,
  _lxb_dom_node_interface_clone,
  _lxb_dom_interface_destroy,
  _lxb_dom_element_interface_destroy,
  _lxb_dom_text_interface_destroy,
  _lxb_dom_cdata_section_interface_destroy,
  _lxb_dom_processing_instruction_interface_destroy,
  _lxb_dom_comment_interface_destroy,
  _lxb_dom_document_interface_destroy,
  _lxb_dom_document_type_interface_destroy,
  _lxb_dom_document_fragment_interface_destroy,
  _lxb_dom_attr_interface_create,
  _lxb_dom_attr_interface_clone,
  _lxb_dom_node_interface_copy,
  _lxb_dom_node_interface_destroy,
  _lxb_dom_attr_data_by_id,
  _lxb_dom_attr_qualified_name_append,
  _lxb_dom_attr_interface_destroy,
  _lxb_dom_attr_set_name,
  _lxb_dom_attr_local_name_append,
  _lxb_ns_append,
  _lxb_ns_prefix_append,
  _lxb_dom_attr_set_value,
  _lxb_dom_attr_set_value_wo_copy,
  _lxb_dom_attr_set_existing_value,
  _lxb_dom_attr_clone_name_value,
  _lxb_dom_attr_compare,
  _lxb_dom_attr_remove,
  _lxb_dom_attr_data_undef,
  _lxb_dom_attr_data_by_local_name,
  _lxb_dom_attr_data_by_qualified_name,
  _lxb_dom_attr_qualified_name,
  _lxb_dom_attr_local_name_noi,
  _lxb_dom_attr_value_noi,
  _lxb_dom_cdata_section_interface_create,
  _lxb_dom_cdata_section_interface_clone,
  _lxb_dom_text_interface_copy,
  _lxb_dom_character_data_interface_create,
  _lxb_dom_character_data_interface_clone,
  _lxb_dom_character_data_interface_copy,
  _lxb_dom_character_data_interface_destroy,
  _lxb_dom_character_data_replace,
  _lxb_dom_comment_interface_create,
  _lxb_dom_comment_interface_copy,
  _lxb_dom_document_fragment_interface_create,
  _lxb_dom_document_type_interface_create,
  _lxb_dom_document_type_name_noi,
  _lxb_dom_document_type_public_id_noi,
  _lxb_dom_document_type_system_id_noi,
  _lxb_dom_document_interface_create,
  _lxb_dom_document_init,
  _lxb_dom_document_create,
  _lxb_dom_document_clean,
  _lxb_dom_document_destroy,
  _lxb_dom_document_attach_doctype,
  _lxb_dom_document_attach_element,
  _lxb_dom_document_create_element,
  _lxb_dom_element_create,
  _lxb_dom_document_destroy_element,
  _lxb_dom_element_destroy,
  _lxb_dom_document_create_document_fragment,
  _lxb_dom_document_create_text_node,
  _lxb_dom_document_create_cdata_section,
  _lxb_dom_document_create_processing_instruction,
  _lxb_dom_processing_instruction_interface_create,
  _lxb_dom_document_create_comment,
  _lxb_dom_document_root,
  _lxb_dom_document_import_node,
  _lxb_dom_node_insert_child,
  _lxb_dom_document_set_default_node_cb,
  _lxb_dom_document_create_interface_noi,
  _lxb_dom_document_destroy_interface_noi,
  _lxb_dom_document_create_struct_noi,
  _lxb_dom_document_destroy_struct_noi,
  _lxb_dom_document_create_text_noi,
  _lxb_dom_document_destroy_text_noi,
  _lxb_dom_document_element_noi,
  _lxb_dom_document_scripting_noi,
  _lxb_dom_document_scripting_set_noi,
  _lxb_dom_element_attr_append,
  _lxb_dom_element_interface_copy,
  _lxb_dom_element_qualified_name_set,
  _lxb_tag_append,
  _lxb_tag_append_lower,
  _lxb_ns_data_by_id,
  _lxb_dom_element_is_set,
  _lxb_dom_element_has_attributes,
  _lxb_dom_element_set_attribute,
  _lxb_dom_element_attr_is_exist,
  _lxb_dom_element_get_attribute,
  _lxb_dom_element_attr_by_name,
  _lxb_dom_element_remove_attribute,
  _lxb_dom_element_attr_remove,
  _lxb_dom_element_has_attribute,
  _lxb_dom_element_attr_by_local_name_data,
  _lxb_dom_element_attr_by_id,
  _lxb_dom_element_compare,
  _lxb_dom_elements_by_tag_name,
  _lxb_dom_node_by_tag_name,
  _lxb_dom_elements_by_class_name,
  _lxb_dom_node_by_class_name,
  _lxb_dom_elements_by_attr,
  _lxb_dom_node_by_attr,
  _lxb_dom_elements_by_attr_begin,
  _lxb_dom_node_by_attr_begin,
  _lxb_dom_elements_by_attr_end,
  _lxb_dom_node_by_attr_end,
  _lxb_dom_elements_by_attr_contain,
  _lxb_dom_node_by_attr_contain,
  _lxb_dom_element_qualified_name,
  _lxb_tag_data_by_id,
  _lxb_dom_element_qualified_name_upper,
  _lxb_dom_element_local_name,
  _lxb_dom_element_prefix,
  _lxb_ns_prefix_data_by_id,
  _lxb_dom_element_tag_name,
  _lxb_dom_element_id_noi,
  _lxb_dom_element_class_noi,
  _lxb_dom_element_is_custom_noi,
  _lxb_dom_element_custom_is_defined_noi,
  _lxb_dom_element_first_attribute_noi,
  _lxb_dom_element_next_attribute_noi,
  _lxb_dom_element_prev_attribute_noi,
  _lxb_dom_element_last_attribute_noi,
  _lxb_dom_element_id_attribute_noi,
  _lxb_dom_element_class_attribute_noi,
  _lxb_dom_node_interface_create,
  _lxb_dom_node_destroy,
  _lxb_dom_node_remove,
  _lxb_dom_node_destroy_deep,
  _lxb_dom_node_clone,
  _lxb_dom_node_name,
  _lxb_dom_node_insert_child_wo_events,
  _lxb_dom_node_insert_before_wo_events,
  _lxb_dom_node_insert_before,
  _lxb_dom_node_insert_after_wo_events,
  _lxb_dom_node_insert_after,
  _lxb_dom_node_remove_wo_events,
  _lxb_dom_node_replace_all,
  _lxb_dom_node_simple_walk,
  _lxb_ns_prefix_data_by_name,
  _lxb_tag_data_by_name,
  _lxb_dom_node_text_content,
  _lxb_dom_node_text_content_set,
  _lxb_dom_node_is_empty,
  _lxb_dom_node_tag_id_noi,
  _lxb_dom_node_next_noi,
  _lxb_dom_node_prev_noi,
  _lxb_dom_node_parent_noi,
  _lxb_dom_node_first_child_noi,
  _lxb_dom_node_last_child_noi,
  _lxb_dom_processing_instruction_copy,
  _lxb_dom_processing_instruction_target_noi,
  _lxb_dom_shadow_root_interface_create,
  _lxb_dom_shadow_root_interface_destroy,
  _lxb_dom_text_interface_create,
  _lxb_encoding_decode_default,
  _lxb_encoding_decode_utf_8,
  _lxb_encoding_decode_auto,
  _lxb_encoding_decode_undefined,
  _lxb_encoding_decode_big5,
  _lxb_encoding_decode_euc_jp,
  _lxb_encoding_decode_euc_kr,
  _lxb_encoding_decode_gbk,
  _lxb_encoding_decode_gb18030,
  _lxb_encoding_decode_ibm866,
  _lxb_encoding_decode_iso_2022_jp,
  _lxb_encoding_decode_iso_8859_10,
  _lxb_encoding_decode_iso_8859_13,
  _lxb_encoding_decode_iso_8859_14,
  _lxb_encoding_decode_iso_8859_15,
  _lxb_encoding_decode_iso_8859_16,
  _lxb_encoding_decode_iso_8859_2,
  _lxb_encoding_decode_iso_8859_3,
  _lxb_encoding_decode_iso_8859_4,
  _lxb_encoding_decode_iso_8859_5,
  _lxb_encoding_decode_iso_8859_6,
  _lxb_encoding_decode_iso_8859_7,
  _lxb_encoding_decode_iso_8859_8,
  _lxb_encoding_decode_iso_8859_8_i,
  _lxb_encoding_decode_koi8_r,
  _lxb_encoding_decode_koi8_u,
  _lxb_encoding_decode_shift_jis,
  _lxb_encoding_decode_utf_16be,
  _lxb_encoding_decode_utf_16le,
  _lxb_encoding_decode_macintosh,
  _lxb_encoding_decode_replacement,
  _lxb_encoding_decode_windows_1250,
  _lxb_encoding_decode_windows_1251,
  _lxb_encoding_decode_windows_1252,
  _lxb_encoding_decode_windows_1253,
  _lxb_encoding_decode_windows_1254,
  _lxb_encoding_decode_windows_1255,
  _lxb_encoding_decode_windows_1256,
  _lxb_encoding_decode_windows_1257,
  _lxb_encoding_decode_windows_1258,
  _lxb_encoding_decode_windows_874,
  _lxb_encoding_decode_x_mac_cyrillic,
  _lxb_encoding_decode_x_user_defined,
  _lxb_encoding_decode_default_single,
  _lxb_encoding_decode_utf_8_single,
  _lxb_encoding_decode_auto_single,
  _lxb_encoding_decode_undefined_single,
  _lxb_encoding_decode_big5_single,
  _lxb_encoding_decode_euc_jp_single,
  _lxb_encoding_decode_euc_kr_single,
  _lxb_encoding_decode_gbk_single,
  _lxb_encoding_decode_gb18030_single,
  _lxb_encoding_decode_ibm866_single,
  _lxb_encoding_decode_iso_2022_jp_single,
  _lxb_encoding_decode_iso_8859_10_single,
  _lxb_encoding_decode_iso_8859_13_single,
  _lxb_encoding_decode_iso_8859_14_single,
  _lxb_encoding_decode_iso_8859_15_single,
  _lxb_encoding_decode_iso_8859_16_single,
  _lxb_encoding_decode_iso_8859_2_single,
  _lxb_encoding_decode_iso_8859_3_single,
  _lxb_encoding_decode_iso_8859_4_single,
  _lxb_encoding_decode_iso_8859_5_single,
  _lxb_encoding_decode_iso_8859_6_single,
  _lxb_encoding_decode_iso_8859_7_single,
  _lxb_encoding_decode_iso_8859_8_single,
  _lxb_encoding_decode_iso_8859_8_i_single,
  _lxb_encoding_decode_koi8_r_single,
  _lxb_encoding_decode_koi8_u_single,
  _lxb_encoding_decode_shift_jis_single,
  _lxb_encoding_decode_utf_16be_single,
  _lxb_encoding_decode_utf_16le_single,
  _lxb_encoding_decode_valid_utf_8_single,
  _lxb_encoding_decode_valid_utf_8_single_reverse,
  _lxb_encoding_decode_utf_8_length,
  _lxb_encoding_decode_macintosh_single,
  _lxb_encoding_decode_replacement_single,
  _lxb_encoding_decode_windows_1250_single,
  _lxb_encoding_decode_windows_1251_single,
  _lxb_encoding_decode_windows_1252_single,
  _lxb_encoding_decode_windows_1253_single,
  _lxb_encoding_decode_windows_1254_single,
  _lxb_encoding_decode_windows_1255_single,
  _lxb_encoding_decode_windows_1256_single,
  _lxb_encoding_decode_windows_1257_single,
  _lxb_encoding_decode_windows_1258_single,
  _lxb_encoding_decode_windows_874_single,
  _lxb_encoding_decode_x_mac_cyrillic_single,
  _lxb_encoding_decode_x_user_defined_single,
  _lxb_encoding_encode_default,
  _lxb_encoding_encode_utf_8,
  _lxb_encoding_encode_auto,
  _lxb_encoding_encode_undefined,
  _lxb_encoding_encode_big5,
  _lxb_encoding_encode_euc_jp,
  _lxb_encoding_encode_euc_kr,
  _lxb_encoding_encode_gbk,
  _lxb_encoding_encode_ibm866,
  _lxb_encoding_encode_iso_2022_jp,
  _lxb_encoding_encode_iso_2022_jp_eof,
  _lxb_encoding_encode_iso_8859_10,
  _lxb_encoding_encode_iso_8859_13,
  _lxb_encoding_encode_iso_8859_14,
  _lxb_encoding_encode_iso_8859_15,
  _lxb_encoding_encode_iso_8859_16,
  _lxb_encoding_encode_iso_8859_2,
  _lxb_encoding_encode_iso_8859_3,
  _lxb_encoding_encode_iso_8859_4,
  _lxb_encoding_encode_iso_8859_5,
  _lxb_encoding_encode_iso_8859_6,
  _lxb_encoding_encode_iso_8859_7,
  _lxb_encoding_encode_iso_8859_8,
  _lxb_encoding_encode_iso_8859_8_i,
  _lxb_encoding_encode_koi8_r,
  _lxb_encoding_encode_koi8_u,
  _lxb_encoding_encode_shift_jis,
  _lxb_encoding_encode_utf_16be,
  _lxb_encoding_encode_utf_16le,
  _lxb_encoding_encode_gb18030,
  _lxb_encoding_encode_macintosh,
  _lxb_encoding_encode_replacement,
  _lxb_encoding_encode_windows_1250,
  _lxb_encoding_encode_windows_1251,
  _lxb_encoding_encode_windows_1252,
  _lxb_encoding_encode_windows_1253,
  _lxb_encoding_encode_windows_1254,
  _lxb_encoding_encode_windows_1255,
  _lxb_encoding_encode_windows_1256,
  _lxb_encoding_encode_windows_1257,
  _lxb_encoding_encode_windows_1258,
  _lxb_encoding_encode_windows_874,
  _lxb_encoding_encode_x_mac_cyrillic,
  _lxb_encoding_encode_x_user_defined,
  _lxb_encoding_encode_default_single,
  _lxb_encoding_encode_utf_8_single,
  _lxb_encoding_encode_auto_single,
  _lxb_encoding_encode_undefined_single,
  _lxb_encoding_encode_big5_single,
  _lxb_encoding_encode_euc_jp_single,
  _lxb_encoding_encode_euc_kr_single,
  _lxb_encoding_encode_gbk_single,
  _lxb_encoding_encode_ibm866_single,
  _lxb_encoding_encode_iso_2022_jp_single,
  _lxb_encoding_encode_iso_2022_jp_eof_single,
  _lxb_encoding_encode_iso_8859_10_single,
  _lxb_encoding_encode_iso_8859_13_single,
  _lxb_encoding_encode_iso_8859_14_single,
  _lxb_encoding_encode_iso_8859_15_single,
  _lxb_encoding_encode_iso_8859_16_single,
  _lxb_encoding_encode_iso_8859_2_single,
  _lxb_encoding_encode_iso_8859_3_single,
  _lxb_encoding_encode_iso_8859_4_single,
  _lxb_encoding_encode_iso_8859_5_single,
  _lxb_encoding_encode_iso_8859_6_single,
  _lxb_encoding_encode_iso_8859_7_single,
  _lxb_encoding_encode_iso_8859_8_single,
  _lxb_encoding_encode_iso_8859_8_i_single,
  _lxb_encoding_encode_koi8_r_single,
  _lxb_encoding_encode_koi8_u_single,
  _lxb_encoding_encode_shift_jis_single,
  _lxb_encoding_encode_utf_16be_single,
  _lxb_encoding_encode_utf_16le_single,
  _lxb_encoding_encode_utf_8_length,
  _lxb_encoding_encode_gb18030_single,
  _lxb_encoding_encode_macintosh_single,
  _lxb_encoding_encode_replacement_single,
  _lxb_encoding_encode_windows_1250_single,
  _lxb_encoding_encode_windows_1251_single,
  _lxb_encoding_encode_windows_1252_single,
  _lxb_encoding_encode_windows_1253_single,
  _lxb_encoding_encode_windows_1254_single,
  _lxb_encoding_encode_windows_1255_single,
  _lxb_encoding_encode_windows_1256_single,
  _lxb_encoding_encode_windows_1257_single,
  _lxb_encoding_encode_windows_1258_single,
  _lxb_encoding_encode_windows_874_single,
  _lxb_encoding_encode_x_mac_cyrillic_single,
  _lxb_encoding_encode_x_user_defined_single,
  _lxb_encoding_data_by_pre_name,
  _lxb_encoding_utf_8_skip_bom,
  _lxb_encoding_utf_16be_skip_bom,
  _lxb_encoding_utf_16le_skip_bom,
  _lxb_encoding_encode_init_noi,
  _lxb_encoding_encode_finish_noi,
  _lxb_encoding_encode_buf_noi,
  _lxb_encoding_encode_buf_set_noi,
  _lxb_encoding_encode_buf_used_set_noi,
  _lxb_encoding_encode_buf_used_noi,
  _lxb_encoding_encode_replace_set_noi,
  _lxb_encoding_encode_buf_add_to_noi,
  _lxb_encoding_decode_init_noi,
  _lxb_encoding_decode_finish_noi,
  _lxb_encoding_decode_buf_noi,
  _lxb_encoding_decode_buf_set_noi,
  _lxb_encoding_decode_buf_used_set_noi,
  _lxb_encoding_decode_buf_used_noi,
  _lxb_encoding_decode_replace_set_noi,
  _lxb_encoding_decode_buf_add_to_noi,
  _lxb_encoding_encode_init_single_noi,
  _lxb_encoding_encode_finish_single_noi,
  _lxb_encoding_decode_init_single_noi,
  _lxb_encoding_decode_finish_single_noi,
  _lxb_encoding_data_by_name_noi,
  _lxb_encoding_data_noi,
  _lxb_encoding_encode_function_noi,
  _lxb_encoding_decode_function_noi,
  _lxb_encoding_data_call_encode_noi,
  _lxb_encoding_data_call_decode_noi,
  _lxb_encoding_data_encoding_noi,
  _lxb_encoding_encode_t_sizeof,
  _lxb_encoding_decode_t_sizeof,
  _lxb_html_encoding_init,
  _lxb_html_encoding_destroy,
  _lxb_html_encoding_determine,
  _lxb_html_encoding_content,
  _lxb_html_encoding_create_noi,
  _lxb_html_encoding_clean_noi,
  _lxb_html_encoding_meta_entry_noi,
  _lxb_html_encoding_meta_length_noi,
  _lxb_html_encoding_meta_result_noi,
  _lxb_html_interface_create,
  _lxb_html_unknown_element_interface_create,
  _lxb_html_interface_clone,
  _lxb_html_interface_destroy,
  _lxb_html_unknown_element_interface_destroy,
  _lxb_html_element_interface_create,
  _lxb_html_document_interface_create,
  _lxb_html_anchor_element_interface_create,
  _lxb_html_area_element_interface_create,
  _lxb_html_audio_element_interface_create,
  _lxb_html_base_element_interface_create,
  _lxb_html_quote_element_interface_create,
  _lxb_html_body_element_interface_create,
  _lxb_html_br_element_interface_create,
  _lxb_html_button_element_interface_create,
  _lxb_html_canvas_element_interface_create,
  _lxb_html_table_caption_element_interface_create,
  _lxb_html_table_col_element_interface_create,
  _lxb_html_data_element_interface_create,
  _lxb_html_data_list_element_interface_create,
  _lxb_html_mod_element_interface_create,
  _lxb_html_details_element_interface_create,
  _lxb_html_dialog_element_interface_create,
  _lxb_html_directory_element_interface_create,
  _lxb_html_div_element_interface_create,
  _lxb_html_d_list_element_interface_create,
  _lxb_html_embed_element_interface_create,
  _lxb_html_field_set_element_interface_create,
  _lxb_html_font_element_interface_create,
  _lxb_html_form_element_interface_create,
  _lxb_html_frame_element_interface_create,
  _lxb_html_frame_set_element_interface_create,
  _lxb_html_heading_element_interface_create,
  _lxb_html_head_element_interface_create,
  _lxb_html_hr_element_interface_create,
  _lxb_html_html_element_interface_create,
  _lxb_html_iframe_element_interface_create,
  _lxb_html_image_element_interface_create,
  _lxb_html_input_element_interface_create,
  _lxb_html_label_element_interface_create,
  _lxb_html_legend_element_interface_create,
  _lxb_html_li_element_interface_create,
  _lxb_html_link_element_interface_create,
  _lxb_html_pre_element_interface_create,
  _lxb_html_map_element_interface_create,
  _lxb_html_marquee_element_interface_create,
  _lxb_html_menu_element_interface_create,
  _lxb_html_meta_element_interface_create,
  _lxb_html_meter_element_interface_create,
  _lxb_html_object_element_interface_create,
  _lxb_html_o_list_element_interface_create,
  _lxb_html_opt_group_element_interface_create,
  _lxb_html_option_element_interface_create,
  _lxb_html_output_element_interface_create,
  _lxb_html_paragraph_element_interface_create,
  _lxb_html_param_element_interface_create,
  _lxb_html_picture_element_interface_create,
  _lxb_html_progress_element_interface_create,
  _lxb_html_script_element_interface_create,
  _lxb_html_select_element_interface_create,
  _lxb_html_slot_element_interface_create,
  _lxb_html_source_element_interface_create,
  _lxb_html_span_element_interface_create,
  _lxb_html_style_element_interface_create,
  _lxb_html_table_element_interface_create,
  _lxb_html_table_section_element_interface_create,
  _lxb_html_table_cell_element_interface_create,
  _lxb_html_template_element_interface_create,
  _lxb_html_text_area_element_interface_create,
  _lxb_html_time_element_interface_create,
  _lxb_html_title_element_interface_create,
  _lxb_html_table_row_element_interface_create,
  _lxb_html_track_element_interface_create,
  _lxb_html_u_list_element_interface_create,
  _lxb_html_video_element_interface_create,
  _lxb_html_element_interface_destroy,
  _lxb_html_document_interface_destroy,
  _lxb_html_anchor_element_interface_destroy,
  _lxb_html_area_element_interface_destroy,
  _lxb_html_audio_element_interface_destroy,
  _lxb_html_base_element_interface_destroy,
  _lxb_html_quote_element_interface_destroy,
  _lxb_html_body_element_interface_destroy,
  _lxb_html_br_element_interface_destroy,
  _lxb_html_button_element_interface_destroy,
  _lxb_html_canvas_element_interface_destroy,
  _lxb_html_table_caption_element_interface_destroy,
  _lxb_html_table_col_element_interface_destroy,
  _lxb_html_data_element_interface_destroy,
  _lxb_html_data_list_element_interface_destroy,
  _lxb_html_mod_element_interface_destroy,
  _lxb_html_details_element_interface_destroy,
  _lxb_html_dialog_element_interface_destroy,
  _lxb_html_directory_element_interface_destroy,
  _lxb_html_div_element_interface_destroy,
  _lxb_html_d_list_element_interface_destroy,
  _lxb_html_embed_element_interface_destroy,
  _lxb_html_field_set_element_interface_destroy,
  _lxb_html_font_element_interface_destroy,
  _lxb_html_form_element_interface_destroy,
  _lxb_html_frame_element_interface_destroy,
  _lxb_html_frame_set_element_interface_destroy,
  _lxb_html_heading_element_interface_destroy,
  _lxb_html_head_element_interface_destroy,
  _lxb_html_hr_element_interface_destroy,
  _lxb_html_html_element_interface_destroy,
  _lxb_html_iframe_element_interface_destroy,
  _lxb_html_image_element_interface_destroy,
  _lxb_html_input_element_interface_destroy,
  _lxb_html_label_element_interface_destroy,
  _lxb_html_legend_element_interface_destroy,
  _lxb_html_li_element_interface_destroy,
  _lxb_html_link_element_interface_destroy,
  _lxb_html_pre_element_interface_destroy,
  _lxb_html_map_element_interface_destroy,
  _lxb_html_marquee_element_interface_destroy,
  _lxb_html_menu_element_interface_destroy,
  _lxb_html_meta_element_interface_destroy,
  _lxb_html_meter_element_interface_destroy,
  _lxb_html_object_element_interface_destroy,
  _lxb_html_o_list_element_interface_destroy,
  _lxb_html_opt_group_element_interface_destroy,
  _lxb_html_option_element_interface_destroy,
  _lxb_html_output_element_interface_destroy,
  _lxb_html_paragraph_element_interface_destroy,
  _lxb_html_param_element_interface_destroy,
  _lxb_html_picture_element_interface_destroy,
  _lxb_html_progress_element_interface_destroy,
  _lxb_html_script_element_interface_destroy,
  _lxb_html_select_element_interface_destroy,
  _lxb_html_slot_element_interface_destroy,
  _lxb_html_source_element_interface_destroy,
  _lxb_html_span_element_interface_destroy,
  _lxb_html_style_element_interface_destroy,
  _lxb_html_table_element_interface_destroy,
  _lxb_html_table_section_element_interface_destroy,
  _lxb_html_table_cell_element_interface_destroy,
  _lxb_html_template_element_interface_destroy,
  _lxb_html_text_area_element_interface_destroy,
  _lxb_html_time_element_interface_destroy,
  _lxb_html_title_element_interface_destroy,
  _lxb_html_table_row_element_interface_destroy,
  _lxb_html_track_element_interface_destroy,
  _lxb_html_u_list_element_interface_destroy,
  _lxb_html_video_element_interface_destroy,
  _lxb_html_parser_unref,
  _lxb_html_document_create,
  _lxb_html_document_clean,
  _lxb_html_document_destroy,
  _lxb_html_document_parse,
  _lxb_html_parser_create,
  _lxb_html_parser_init,
  _lxb_html_parser_destroy,
  _lxb_html_parser_clean,
  _lxb_html_parse_chunk_prepare,
  _lxb_html_parse_chunk_process,
  _lxb_html_parse_chunk_end,
  _lxb_html_document_parse_chunk_begin,
  _lxb_html_document_parse_chunk,
  _lxb_html_document_parse_chunk_end,
  _lxb_html_document_parse_fragment,
  _lxb_html_parse_fragment_chunk_begin,
  _lxb_html_parse_fragment_chunk_process,
  _lxb_html_parse_fragment_chunk_end,
  _lxb_html_document_parse_fragment_chunk_begin,
  _lxb_html_document_parse_fragment_chunk,
  _lxb_html_document_parse_fragment_chunk_end,
  _lxb_html_document_title,
  _lxb_html_title_element_strict_text,
  _lxb_html_document_title_set,
  _lxb_html_document_title_raw,
  _lxb_html_title_element_text,
  _lxb_html_document_import_node,
  _lxb_html_document_head_element_noi,
  _lxb_html_document_body_element_noi,
  _lxb_html_document_original_ref_noi,
  _lxb_html_document_is_original_noi,
  _lxb_html_document_mraw_noi,
  _lxb_html_document_mraw_text_noi,
  _lxb_html_document_opt_set_noi,
  _lxb_html_document_opt_noi,
  _lxb_html_document_create_struct_noi,
  _lxb_html_document_destroy_struct_noi,
  _lxb_html_document_create_element_noi,
  _lxb_html_document_destroy_element_noi,
  _lxb_html_element_inner_html_set,
  _lxb_html_media_element_interface_create,
  _lxb_html_media_element_interface_destroy,
  _lxb_html_window_create,
  _lxb_html_window_destroy,
  _lxb_html_tokenizer_create,
  _lxb_html_tokenizer_init,
  _lxb_html_tree_create,
  _lxb_html_tree_init,
  _lxb_html_tokenizer_clean,
  _lxb_html_tree_clean,
  _lxb_html_tokenizer_unref,
  _lxb_html_tree_unref,
  _lxb_html_parser_ref,
  _lxb_html_parse,
  _lxb_html_parse_chunk_begin,
  _lxb_html_tokenizer_chunk,
  _lxb_html_tokenizer_end,
  _lxb_html_tokenizer_begin,
  _lxb_html_parse_fragment,
  _lxb_html_parse_fragment_by_tag_id,
  _lxb_html_tokenizer_set_state_by_tag,
  _lxb_html_tree_insertion_mode_in_template,
  _lxb_html_tree_reset_insertion_mode_appropriately,
  _lxb_html_parser_tokenizer_noi,
  _lxb_html_parser_tree_noi,
  _lxb_html_parser_status_noi,
  _lxb_html_parser_state_noi,
  _lxb_html_parser_scripting_noi,
  _lxb_html_parser_scripting_set_noi,
  _lxb_html_token_attr_create,
  _lxb_html_token_attr_clean,
  _lxb_html_token_attr_destroy,
  _lxb_html_token_attr_name,
  _lxb_html_token_create,
  _lxb_html_token_destroy,
  _lxb_html_token_attr_append,
  _lxb_html_token_attr_remove,
  _lxb_html_token_attr_delete,
  _lxb_html_token_make_text,
  _lxb_html_token_make_text_drop_null,
  _lxb_html_token_make_text_replace_null,
  _lxb_html_token_data_skip_ws_begin,
  _lxb_html_token_data_skip_one_newline_begin,
  _lxb_html_token_data_split_ws_begin,
  _lxb_html_token_doctype_parse,
  _lxb_html_token_find_attr,
  _lxb_html_token_clean_noi,
  _lxb_html_token_create_eof_noi,
  _lxb_html_tokenizer_state_data_before,
  _lxb_html_tokenizer_inherit,
  _lxb_html_tokenizer_ref,
  _lxb_html_tokenizer_destroy,
  _lxb_html_tokenizer_tags_destroy,
  _lxb_html_tokenizer_attrs_destroy,
  _lxb_html_tokenizer_tags_make,
  _lxb_html_tokenizer_attrs_make,
  _lxb_html_tokenizer_current_namespace,
  _lxb_html_tokenizer_state_plaintext_before,
  _lxb_html_tokenizer_state_rcdata_before,
  _lxb_html_tokenizer_state_rawtext_before,
  _lxb_html_tokenizer_state_script_data_before,
  _lxb_html_tokenizer_status_set_noi,
  _lxb_html_tokenizer_callback_token_done_set_noi,
  _lxb_html_tokenizer_callback_token_done_ctx_noi,
  _lxb_html_tokenizer_state_set_noi,
  _lxb_html_tokenizer_tmp_tag_id_set_noi,
  _lxb_html_tokenizer_tree_noi,
  _lxb_html_tokenizer_tree_set_noi,
  _lxb_html_tokenizer_mraw_noi,
  _lxb_html_tokenizer_tags_noi,
  _lxb_html_tokenizer_error_add,
  _lxb_html_tokenizer_state_comment_before_start,
  _lxb_html_tokenizer_state_cr,
  _lxb_html_tokenizer_state_doctype_before,
  _lxb_html_tokenizer_state_before_attribute_name,
  _lxb_html_tokenizer_state_self_closing_start_tag,
  _lxb_html_tokenizer_state_char_ref,
  _lxb_html_tree_insertion_mode_initial,
  _lxb_html_tree_construction_dispatcher,
  _lxb_html_tree_ref,
  _lxb_html_tree_destroy,
  _lxb_html_tree_stop_parsing,
  _lxb_html_tree_process_abort,
  _lxb_html_tree_parse_error,
  _lxb_html_tree_error_add,
  _lxb_html_tree_html_integration_point,
  _lxb_html_tree_insertion_mode_foreign_content,
  _lxb_html_tree_appropriate_place_inserting_node,
  _lxb_html_tree_insert_foreign_element,
  _lxb_html_tree_create_element_for_token,
  _lxb_html_tree_append_attributes,
  _lxb_html_tree_append_attributes_from_element,
  _lxb_html_tree_adjust_mathml_attributes,
  _lxb_html_tree_adjust_svg_attributes,
  _lxb_html_tree_adjust_foreign_attributes,
  _lxb_html_tree_insert_character,
  _lxb_html_tree_insert_character_for_data,
  _lxb_html_tree_insert_comment,
  _lxb_html_tree_create_document_type_from_token,
  _lxb_html_tree_node_delete_deep,
  _lxb_html_tree_generic_rawtext_parsing,
  _lxb_html_tree_insertion_mode_text,
  _lxb_html_tree_generic_rcdata_parsing,
  _lxb_html_tree_generate_implied_end_tags,
  _lxb_html_tree_generate_all_implied_end_tags_thoroughly,
  _lxb_html_tree_insertion_mode_in_body,
  _lxb_html_tree_insertion_mode_in_select,
  _lxb_html_tree_insertion_mode_in_select_in_table,
  _lxb_html_tree_insertion_mode_in_cell,
  _lxb_html_tree_insertion_mode_in_row,
  _lxb_html_tree_insertion_mode_in_table_body,
  _lxb_html_tree_insertion_mode_in_caption,
  _lxb_html_tree_insertion_mode_in_column_group,
  _lxb_html_tree_insertion_mode_in_table,
  _lxb_html_tree_insertion_mode_in_head,
  _lxb_html_tree_insertion_mode_in_frameset,
  _lxb_html_tree_insertion_mode_before_head,
  _lxb_html_tree_insertion_mode_after_head,
  _lxb_html_tree_element_in_scope,
  _lxb_html_tree_element_in_scope_by_node,
  _lxb_html_tree_element_in_scope_h123456,
  _lxb_html_tree_element_in_scope_tbody_thead_tfoot,
  _lxb_html_tree_element_in_scope_td_th,
  _lxb_html_tree_check_scope_element,
  _lxb_html_tree_close_p_element,
  _lxb_html_tree_adoption_agency_algorithm,
  _lxb_html_tree_open_elements_remove_by_node,
  _lxb_html_tree_adjust_attributes_mathml,
  _lxb_html_tree_adjust_attributes_svg,
  _lxb_html_tree_insertion_mode_after_after_body,
  _lxb_html_tree_insertion_mode_after_after_frameset,
  _lxb_html_tree_insertion_mode_after_body,
  _lxb_html_tree_insertion_mode_after_frameset,
  _lxb_html_tree_insertion_mode_before_html,
  _lxb_html_tree_insertion_mode_in_body_skip_new_line,
  _lxb_html_tree_insertion_mode_in_body_skip_new_line_textarea,
  _lxb_html_tree_insertion_mode_in_body_text_append,
  _lxb_html_tree_insertion_mode_in_head_noscript,
  _lxb_html_tree_insertion_mode_in_table_text,
  _lxb_html_tree_insertion_mode_in_table_anything_else,
  _lxb_ns_by_id,
  _lxb_ns_data_by_link,
  _lxb_punycode_encode,
  _lxb_punycode_encode_cp,
  _lxb_punycode_decode,
  _lxb_punycode_decode_cb_cp,
  _lxb_punycode_decode_cp,
  _lxb_tag_name_by_id_noi,
  _lxb_tag_name_upper_by_id_noi,
  _lxb_tag_id_by_name_noi,
  _lxb_tag_mraw_noi,
  _lxb_unicode_idna_create,
  _lxb_unicode_idna_init,
  _lxb_unicode_normalizer_init,
  _lxb_unicode_idna_clean,
  _lxb_unicode_normalizer_clean,
  _lxb_unicode_idna_destroy,
  _lxb_unicode_normalizer_destroy,
  _lxb_unicode_idna_processing,
  _lxb_unicode_idna_type,
  _lxb_unicode_idna_entry_by_cp,
  _lxb_unicode_idna_map,
  _lxb_unicode_quick_check_cp,
  _lxb_unicode_normalize_cp,
  _lxb_unicode_idna_processing_cp,
  _lxb_unicode_idna_to_ascii,
  _lxb_unicode_idna_to_ascii_cp,
  _lxb_unicode_idna_validity_criteria,
  _lxb_unicode_idna_validity_criteria_cp,
  _lxb_unicode_idna_to_unicode,
  _lxb_unicode_idna_to_unicode_cp,
  _lxb_unicode_normalizer_create,
  _lxb_unicode_normalization_form_set,
  _lxb_unicode_composition_cp,
  _lxb_unicode_flush,
  _lxb_unicode_flush_cp,
  _lxb_unicode_normalize,
  _lxb_unicode_normalize_end,
  _lxb_unicode_normalize_cp_end,
  _lxb_unicode_quick_check,
  _lxb_unicode_normalization_entry_by_cp,
  _lxb_unicode_normalization_is_null,
  _lxb_unicode_quick_check_end,
  _lxb_unicode_quick_check_cp_end,
  _lxb_unicode_compose_entry,
  _lxb_unicode_entry,
  _lxb_unicode_idna_entry,
  _lxb_unicode_normalization_entry,
  _lxb_unicode_normalization_entry_by_index,
  _lxb_unicode_full_canonical,
  _lxb_unicode_full_compatibility,
  _lxb_unicode_idna_entry_by_index,
  _lxb_url_parser_create,
  _lxb_url_parser_init,
  _lxb_url_parser_clean,
  _lxb_url_parser_destroy,
  _lxb_url_parser_memory_destroy,
  _lxb_url_parse,
  _lxb_url_erase,
  _lxb_url_parse_basic,
  _lxb_url_destroy,
  _lxb_url_memory_destroy,
  _lxb_url_api_href_set,
  _lxb_url_api_protocol_set,
  _lxb_url_api_username_set,
  _lxb_url_api_password_set,
  _lxb_url_api_host_set,
  _lxb_url_api_hostname_set,
  _lxb_url_api_port_set,
  _lxb_url_api_pathname_set,
  _lxb_url_api_search_set,
  _lxb_url_api_hash_set,
  _lxb_url_serialize,
  _lxb_url_serialize_host_unicode,
  _lxb_url_serialize_host,
  _lxb_url_serialize_idna,
  _lxb_url_serialize_scheme,
  _lxb_url_serialize_username,
  _lxb_url_serialize_password,
  _lxb_url_serialize_host_ipv6,
  _lxb_url_serialize_host_ipv4,
  _lxb_url_serialize_port,
  _lxb_url_serialize_path,
  _lxb_url_serialize_query,
  _lxb_url_serialize_fragment,
  _lxb_url_clone,
  _lxb_url_search_params_init,
  _lxb_url_search_params_destroy,
  _lxb_url_search_params_append,
  _lxb_url_search_params_delete,
  _lxb_url_search_params_match,
  _lxb_url_search_params_get_entry,
  _lxb_url_search_params_get,
  _lxb_url_search_params_get_all,
  _lxb_url_search_params_get_count,
  _lxb_url_search_params_match_entry,
  _lxb_url_search_params_has,
  _lxb_url_search_params_set,
  _lxb_url_search_params_sort,
  _lxb_url_search_params_serialize,
  _mbstr_treat_data,
  _sapi_register_treat_data,
  _sapi_register_post_entries,
  _zend_multibyte_set_functions,
  _php_rfc1867_set_multibyte_callbacks,
  _zend_multibyte_restore_functions,
  _mbfl_no2encoding,
  _zend_multibyte_set_internal_encoding,
  _php_info_print_table_header,
  _mbfl_name2encoding,
  _mbfl_name2encoding_ex,
  _php_mb_safe_strrchr,
  _mbfl_no_language2name,
  ___zend_calloc,
  _zend_parse_arg_str_or_long_slow,
  _mbfl_encoding_preferred_mime_name,
  _mb_fast_convert,
  _zend_memnrstr_ex,
  _php_mb_stripos,
  _php_unicode_convert_case,
  _mbfl_strcut,
  _php_mb_convert_encoding_ex,
  _php_mb_convert_encoding,
  _mb_guess_encoding_for_strings,
  _php_mb_convert_encoding_recursive,
  _zend_hash_index_add,
  _php_mb_check_encoding,
  _mbfl_get_supported_encodings,
  _zend_lazy_object_get_property_info_for_slot,
  _zend_get_property_info_for_slot_slow,
  _zend_ref_del_type_source,
  _zval_try_get_long,
  _mbfl_no2language,
  _php_mail_build_headers,
  _php_trim,
  _zend_str_tolower,
  _zend_ini_str_ex,
  _php_escape_shell_cmd,
  _php_mail,
  _zend_ini_str,
  _mbfl_no_encoding2name,
  _php_mb_mbchar_bytes,
  _mbfl_name2no_language,
  _OnUpdateBool,
  _sapi_unregister_post_entry,
  _sapi_read_standard_form_data,
  _rfc1867_post_handler,
  _zend_ini_boolean_displayer_cb,
  _php_std_post_handler,
  _php_unicode_is_prop1,
  _php_unicode_is_prop,
  _php_default_treat_data,
  _sapi_handle_post,
  _php_url_decode,
  _php_register_variable_safe,
  __php_stream_copy_to_mem,
  _add_index_stringl,
  _add_index_bool,
  _zend_make_compiled_string_description,
  _mbfl_filt_conv_illegal_output,
  _mb_illegal_output,
  _mbfl_filt_conv_common_ctor,
  _mbfl_filt_conv_common_flush,
  _mbfl_string_init,
  _mbfl_memory_device_output,
  _mbfl_convert_filter_new,
  _mbfl_filter_output_null,
  _mbfl_convert_filter_delete,
  _mbfl_memory_device_init,
  _mbfl_convert_filter_copy,
  _mbfl_memory_device_result,
  _mbfl_filt_conv_pass,
  _mbfl_convert_filter_get_vtbl,
  __emalloc_64,
  _mbfl_convert_filter_new2,
  _mbfl_convert_filter_feed,
  _mbfl_convert_filter_feed_string,
  _mbfl_convert_filter_flush,
  _mbfl_convert_filter_reset,
  _mbfl_convert_filter_devcat,
  _mbfl_convert_filter_strcat,
  _mbfl_filter_output_pipe,
  _mbfl_name2language,
  _mbfl_memory_device_realloc,
  _mbfl_memory_device_clear,
  _mbfl_memory_device_reset,
  _mbfl_memory_device_unput,
  _mbfl_memory_device_strcat,
  _mbfl_memory_device_strncat,
  _mbfl_memory_device_devcat,
  _mbfl_wchar_device_init,
  _mbfl_wchar_device_clear,
  _mbfl_wchar_device_output,
  _mbfl_string_init_set,
  _mbfl_string_clear,
  _opcache_preloading,
  _php_glob,
  _tsrm_realpath,
  _zend_dirname,
  _zend_strndup,
  _expand_filepath_ex,
  _expand_filepath,
  _php_globfree,
  __zend_bailout,
  _zend_string_hash_func,
  _zend_hash_str_find_ptr_lc,
  _setTempRet0,
  _getTempRet0,
  _zend_stream_init_filename_ex,
  _destroy_op_array,
  _zend_destroy_file_handle,
  _zend_ini_parse_bool,
  _zend_ini_parse_quantity_warn,
  _OnUpdateStringUnempty,
  _zend_function_dtor,
  _destroy_zend_class,
  _zend_hash_extend,
  _zend_hash_del_bucket,
  _zend_map_ptr_extend,
  _zend_mangle_property_name,
  _zend_hash_find_known_hash,
  _zend_set_compiled_filename,
  _zend_class_redeclaration_error,
  _zend_try_early_bind,
  __zend_observer_function_declared_notify,
  __zend_observer_class_linked_notify,
  _zend_vm_set_opcode_handler,
  _zend_serialize_opcode_handler,
  _zend_alloc_ce_cache,
  _zend_map_ptr_new,
  _zend_hooked_object_get_iterator,
  _zend_deserialize_opcode_handler,
  _zend_hash_rehash,
  _zend_extensions_op_array_persist_calc,
  _zend_map_ptr_new_static,
  _gc_remove_from_buffer,
  _zend_class_implements_interface,
  _zend_vm_set_opcode_handler_ex,
  _zend_extensions_op_array_persist,
  _zend_hash_clean,
  _zend_hash_discard,
  _zend_signal_handler_unblock,
  _zend_get_executed_filename_ex,
  _zend_message_dispatcher,
  _zend_begin_record_errors,
  _gc_enable,
  _zend_emit_recorded_errors,
  _zend_free_recorded_errors,
  _zend_hash_index_del,
  _zend_emit_recorded_errors_ex,
  _zend_hash_add_empty_element,
  __php_stream_stat_path,
  _zend_optimize_script,
  _sapi_get_request_time,
  _zend_alter_ini_entry_chars,
  _zend_map_ptr_reset,
  _realpath_cache_clean,
  _zend_register_extension,
  _zend_llist_del_element,
  _zend_interned_strings_set_request_storage_handlers,
  _php_child_init,
  _zend_lookup_class_ex,
  _zend_hash_del,
  _php_get_stream_filters_hash_global,
  _php_stream_get_url_stream_wrappers_hash_global,
  _php_stream_xport_get_hash,
  _zend_internal_run_time_cache_reserved_size,
  _zend_interned_strings_switch_storage,
  _php_request_startup,
  _php_output_set_status,
  _php_request_shutdown,
  _sapi_activate,
  _zend_stream_init_filename,
  _zend_execute,
  _zend_exception_restore,
  _zend_user_exception_handler,
  _zend_exception_error,
  __efree_160,
  _php_call_shutdown_functions,
  _zend_call_destructors,
  _php_output_end_all,
  _php_free_shutdown_functions,
  _zend_shutdown_executor_values,
  _init_op_array,
  _zend_hash_sort_ex,
  _zend_do_link_class,
  _zend_hash_set_bucket_key,
  _zend_update_class_constant,
  _zval_update_constant_ex,
  _zend_error_at,
  _zend_register_internal_enum,
  _zend_enum_add_case_cstr,
  _php_add_tick_function,
  __try_convert_to_string,
  _zend_long_to_str,
  _zend_fiber_switch_block,
  _zend_fiber_switch_unblock,
  _zend_sigaction,
  _php_random_bytes_ex,
  _php_random_bytes,
  _php_random_int,
  _php_random_csprng_shutdown,
  _zend_atomic_int_exchange,
  _php_random_mt19937_seed32,
  _php_random_range,
  _php_random_bin2hex_le,
  _php_random_hex2bin_le,
  _php_random_mt19937_seed_default,
  _php_random_generate_fallback_seed,
  _php_random_pcgoneseq128xslrr64_seed128,
  _php_random_pcgoneseq128xslrr64_advance,
  _php_random_xoshiro256starstar_seed256,
  _php_random_xoshiro256starstar_seed64,
  _php_random_xoshiro256starstar_jump,
  _php_random_xoshiro256starstar_jump_long,
  _php_random_gammasection_closed_open,
  _php_random_range64,
  _php_random_gammasection_closed_closed,
  _php_random_gammasection_open_closed,
  _php_random_gammasection_open_open,
  _php_random_range32,
  _php_random_status_alloc,
  _php_random_status_copy,
  _php_random_status_free,
  _php_random_engine_common_init,
  _php_random_engine_common_free_object,
  _php_random_engine_common_clone_object,
  _php_random_default_algo,
  _php_random_default_status,
  _php_combined_lcg,
  _php_random_generate_fallback_seed_ex,
  _php_mt_srand,
  _php_mt_rand,
  _php_mt_rand_range,
  _php_mt_rand_common,
  _zend_objects_store_del,
  _gc_possible_root,
  _php_array_data_shuffle,
  _php_binary_string_shuffle,
  _php_array_pick_keys,
  _zend_read_property,
  _php_random_bytes_insecure_for_zend,
  _zend_reflection_class_factory,
  _zend_get_closure_method_def,
  _zend_str_tolower_copy,
  _zend_fetch_function,
  _smart_str_append_printf,
  _zend_type_to_string,
  _zend_get_closure_this_ptr,
  _zend_create_fake_closure,
  _zval_add_ref,
  _zend_hash_copy,
  __efree_32,
  _zend_generator_update_root,
  _zend_generator_update_current,
  _zend_fetch_debug_backtrace,
  _zend_get_closure_invoke_method,
  _zend_get_default_from_internal_arg_info,
  _zend_separate_class_constants_table,
  _zval_copy_ctor_func,
  _zend_update_class_constants,
  _zend_class_init_statics,
  _zend_std_get_static_property,
  _zend_std_get_static_property_with_info,
  _zend_clear_exception,
  _zend_verify_ref_assignable_zval,
  _zend_verify_property_type,
  _zend_get_properties_no_lazy_init,
  _zend_object_make_lazy,
  _zend_lazy_object_init,
  _zend_lazy_object_mark_as_initialized,
  _zend_fetch_class_by_name,
  _zend_read_static_property_ex,
  _zend_update_static_property_ex,
  _zend_get_property_hook_trampoline,
  _zend_class_can_be_lazy,
  _php_info_print_module,
  _zend_get_extension,
  _smart_str_append_zval,
  _zend_ast_export,
  _smart_str_append_escaped,
  _zend_is_attribute_repeated,
  _zend_get_attribute_value,
  _zend_get_attribute_str,
  _zend_get_attribute_target_names,
  _zend_get_attribute_object,
  _zend_get_constant_ptr,
  _php_stream_open_for_zend_ex,
  _zend_hash_internal_pointer_reset_ex,
  _zend_hash_get_current_data_ex,
  _zend_hash_move_forward_ex,
  _zend_hash_real_init_mixed,
  _add_next_index_object,
  _php_spl_object_hash,
  _zend_call_method,
  _zend_illegal_container_offset,
  _zend_hash_update_ind,
  _zend_hash_iterator_del,
  _zend_parse_arg_class,
  _php_var_serialize_init,
  _php_var_serialize,
  _php_var_serialize_destroy,
  _php_var_unserialize_init,
  _var_tmp_var,
  _php_var_unserialize,
  _php_var_unserialize_destroy,
  _zend_proptable_to_symtable,
  _zend_hash_get_current_key_type_ex,
  _zend_hash_get_current_key_zval_ex,
  _zend_call_known_instance_method_with_2_params,
  _zend_compare_symbol_tables,
  __emalloc_80,
  _zend_incompatible_double_to_long_error,
  _zend_use_resource_as_offset,
  _zend_hash_get_current_key_ex,
  _zend_hash_get_current_pos,
  _zend_hash_iterator_add,
  _zend_get_property_info,
  _zend_ref_add_type_source,
  _spl_filesystem_object_get_path,
  __php_glob_stream_get_path,
  _php_basename,
  _php_stat,
  _object_init_with_constructor,
  __php_glob_stream_get_count,
  __php_stream_eof,
  _php_csv_handle_escape_argument,
  _php_fgetcsv,
  _php_bc_fgetcsv_empty_line,
  _php_fputcsv,
  _php_flock_common,
  __php_stream_flush,
  __php_stream_getc,
  __php_stream_passthru,
  _php_sscanf_internal,
  _zend_wrong_param_count,
  _php_stream_read_to_str,
  _php_fstat,
  __php_stream_set_option,
  __php_stream_truncate_set_size,
  _zend_objects_destroy_object,
  _zend_std_get_method,
  _var_push_dtor,
  _zend_get_gc_buffer_create,
  _zend_get_gc_buffer_grow,
  __safe_erealloc,
  _zend_compare,
  _zend_user_it_invalidate_current,
  _zend_iterator_dtor,
  _zend_get_callable_zval_from_fcc,
  _array_set_zval_key,
  _spl_iterator_apply,
  _zend_is_iterable,
  _zend_array_to_list,
  _php_count_recursive,
  _zend_hash_move_backwards_ex,
  _var_replace,
  _zend_is_identical,
  _zend_hash_compare,
  _zend_std_read_dimension,
  _zend_std_write_dimension,
  _zend_std_has_dimension,
  _zend_nan_coerced_to_type_warning,
  _zend_std_cast_object_tostring,
  _zend_object_is_true,
  _zend_std_unset_dimension,
  _zend_hash_index_lookup,
  _zend_sort,
  _zend_array_sort_ex,
  _zend_hash_internal_pointer_end_ex,
  _zend_hash_minmax,
  _zend_hash_iterator_pos_ex,
  _zend_hash_iterator_pos,
  _zendi_smart_streq,
  _zend_flf_parse_arg_bool_slow,
  _php_prefix_varname,
  _zend_rebuild_symbol_table,
  _zend_try_assign_typed_ref_zval_ex,
  _zend_get_this_object,
  _php_error_docref_unchecked,
  _zend_parse_arg_number_or_str_slow,
  __php_math_round,
  _get_active_function_arg_name,
  _is_numeric_str_function,
  _zend_hash_to_packed,
  _zend_hash_iterators_lower_pos,
  __zend_hash_iterators_update,
  _zend_hash_packed_del_val,
  _zend_hash_iterators_advance,
  _convert_to_array,
  _php_array_merge_recursive,
  _add_next_index_null,
  _zend_cannot_add_element,
  _php_array_merge,
  _php_array_replace_recursive,
  _zend_hash_merge,
  _zend_string_toupper_ex,
  _zend_hash_bucket_swap,
  _php_multisort_compare,
  _add_function,
  _mul_function,
  _zend_binary_strcasecmp_l,
  _zend_binary_strcmp,
  _zendi_smart_strcmp,
  _strnatcmp_ex,
  _numeric_compare_function,
  _string_case_compare_function,
  _string_compare_function,
  _string_locale_compare_function,
  _zend_throw_exception_internal,
  _zend_get_executed_lineno,
  _zend_throw_unwind_exit,
  _zend_alter_ini_entry_ex,
  _php_register_incomplete_class_handlers,
  _php_register_url_stream_wrapper,
  _php_unregister_url_stream_wrapper,
  _zend_reset_lc_ctype_locale,
  _zend_update_current_locale,
  _zend_llist_destroy,
  _php_get_nan,
  _php_get_inf,
  _zend_register_double_constant,
  _zend_get_executed_scope,
  _zend_get_constant_ex,
  _htonl,
  _php_getenv,
  _sapi_getenv,
  _php_getopt,
  _sapi_flush,
  _php_get_current_user,
  _cfg_get_entry_ex,
  __php_error_log_ex,
  _php_log_err_with_severity,
  __php_error_log,
  _zend_get_called_scope,
  _zend_hash_apply,
  _append_user_shutdown_function,
  _register_user_shutdown_function,
  _remove_user_shutdown_function,
  _zend_hash_str_del,
  _php_get_highlight_struct,
  _zend_ini_string_ex,
  _php_output_start_default,
  _highlight_file,
  _php_output_end,
  _php_output_get_contents,
  _php_output_discard,
  _zend_save_lexical_state,
  _open_file_for_scanning,
  _zend_restore_lexical_state,
  _zend_strip,
  _highlight_string,
  _zend_ini_parse_quantity,
  _zend_ini_get_value,
  _zend_ini_sort_entries,
  _zend_restore_ini_entry,
  _zend_ini_string,
  _zend_print_zval_r,
  _zend_print_zval_r_to_str,
  _ntohs,
  _htons,
  _zend_llist_init,
  _zend_llist_add_element,
  _zend_llist_apply,
  _php_copy_file_ex,
  _zend_parse_ini_file,
  _zend_parse_ini_string,
  _add_index_double,
  _zif_rewind,
  _zif_fclose,
  _zif_feof,
  _zif_fgetc,
  _zif_fgets,
  _zif_fread,
  _zif_fpassthru,
  _zif_fseek,
  _zif_ftell,
  _zif_fflush,
  _zif_fwrite,
  _zend_stream_init_fp,
  _object_and_properties_init,
  __safe_realloc,
  _php_crc32_bulk_update,
  _php_crc32_stream_bulk_update,
  _php_print_credits,
  _php_print_info_htmlhead,
  _php_output_write,
  _php_info_print_table_colspan_header,
  _php_crypt,
  __emalloc_128,
  _php_info_print_css,
  _zend_objects_not_comparable,
  _zend_list_delete,
  _zend_list_close,
  _php_clear_stat_cache,
  _php_check_open_basedir_ex,
  _php_stream_dirent_alphasortr,
  _php_stream_dirent_alphasort,
  __php_stream_scandir,
  _zif_dl,
  _php_load_extension,
  _php_dl,
  _php_load_shlib,
  _zend_register_module_ex,
  _zend_startup_module_ex,
  _php_network_gethostbyname,
  _php_exec,
  __php_stream_fopen_from_pipe,
  _php_escape_shell_arg,
  _zend_register_list_destructors_ex,
  _php_stream_context_free,
  __php_stream_copy_to_stream_ex,
  _php_stream_locate_eol,
  _php_open_temporary_fd_ex,
  __php_stream_fopen_tmpfile,
  _php_error_docref2,
  _zend_fetch_resource2,
  __php_stream_mkdir,
  __php_stream_rmdir,
  __php_stream_sync,
  _php_copy_file_ctx,
  _php_copy_file,
  _php_get_temporary_directory,
  _php_get_gid_by_name,
  _php_get_uid_by_name,
  _realpath_cache_del,
  _realpath_cache_size,
  _realpath_cache_get_buckets,
  _realpath_cache_max_buckets,
  _php_stream_bucket_make_writeable,
  _php_strtr,
  ___zend_strdup,
  _php_flock,
  _php_conv_fp,
  _zend_argument_count_error,
  __php_stream_xport_create,
  _zend_try_assign_typed_ref_str,
  _zend_try_assign_typed_ref_empty_string,
  _php_stream_wrapper_log_error,
  _php_stream_context_get_option,
  __php_stream_printf,
  _php_stream_notification_notify,
  _php_stream_context_set,
  _php_stream_xport_crypto_setup,
  _php_stream_xport_crypto_enable,
  _php_stream_context_get_uri_parser,
  _php_raw_url_decode,
  __php_stream_sock_open_host,
  __php_stream_alloc,
  _sapi_header_op,
  _php_header,
  _sapi_send_headers,
  _php_setcookie,
  _php_raw_url_encode,
  _php_output_get_start_lineno,
  _php_output_get_start_filename,
  _zend_try_assign_typed_ref_string,
  _zend_llist_apply_with_argument,
  _php_unescape_html_entities,
  _php_escape_html_entities,
  _zend_set_local_var_str,
  _php_stream_context_set_option,
  _php_stream_filter_free,
  __php_stream_filter_append,
  _php_stream_filter_create,
  _php_url_encode_hash_ex,
  _zend_check_property_access,
  _php_url_encode,
  _php_url_encode_to_smart_str,
  _zend_double_to_str,
  _sapi_read_post_data,
  _php_is_image_avif,
  _php_image_type_to_mime_type,
  _php_getimagetype,
  __php_stream_memory_open,
  _php_image_register_handler,
  _php_image_unregister_handler,
  _zend_objects_new,
  _php_lookup_class_name,
  _php_store_class_name,
  _php_info_print_style,
  _php_get_uname,
  _php_print_info,
  _get_zend_version,
  _php_build_provider,
  _is_zend_mm,
  _zend_multibyte_get_functions,
  __php_stream_get_url_stream_wrappers_hash,
  __php_get_stream_filters_hash,
  _zend_html_puts,
  _php_info_print_box_start,
  _php_info_print_box_end,
  _php_info_print_hr,
  _php_info_print_table_row_ex,
  _zend_get_module_version,
  _zend_get_executed_filename,
  _php_syslog,
  _php_math_round_mode_from_enum,
  _pow_function,
  __php_math_basetolong,
  __php_math_basetozval,
  __php_math_longtobase,
  __php_math_zvaltobase,
  _zend_flf_parse_arg_long_slow,
  __php_math_number_format,
  __php_math_number_format_ex,
  __php_math_number_format_long,
  _make_digest,
  _make_digest_ex,
  __emalloc_56,
  _php_inet_ntop,
  _php_statpage,
  _sapi_get_stat,
  _php_getlastmod,
  _php_password_algo_register,
  _php_password_algo_unregister,
  _php_password_algo_default,
  _php_password_algo_find,
  _php_password_algo_extract_ident,
  _php_password_algo_identify_ex,
  _php_stream_mode_from_str,
  __php_stream_temp_create,
  __php_stream_memory_create,
  __php_stream_temp_create_ex,
  __php_stream_sock_open_from_socket,
  __php_stream_fopen_from_file,
  __php_stream_fopen_from_fd,
  _sapi_read_post_block,
  _zend_fetch_resource,
  _php_socket_error_str,
  _zend_register_resource,
  _php_quot_print_encode,
  _ValidateFormat,
  _convert_to_null,
  _zend_try_assign_typed_ref_stringl,
  _zend_try_assign_typed_ref_double,
  _make_sha1_digest,
  _php_socket_strerror,
  _add_next_index_resource,
  _php_stream_xport_accept,
  _php_stream_xport_get_name,
  _php_network_parse_network_address_with_port,
  _php_stream_xport_sendto,
  _zend_try_assign_typed_ref_null,
  _php_stream_xport_recvfrom,
  __php_emit_fd_setsize_warning,
  _php_stream_notification_free,
  _php_stream_notification_alloc,
  _php_stream_filter_append_ex,
  _php_stream_filter_remove,
  _php_stream_filter_prepend_ex,
  _php_file_le_stream_filter,
  __php_stream_filter_flush,
  _php_stream_get_record,
  _php_stream_xport_shutdown,
  _localeconv_r,
  _php_explode,
  _zend_hash_packed_grow,
  _php_explode_negative_limit,
  __emalloc_256,
  _php_implode,
  _zend_string_only_has_ascii_alphanumeric,
  _php_dirname,
  _php_stristr,
  _php_strspn,
  _php_strcspn,
  _add_index_str,
  _php_str_to_str,
  _php_addcslashes_str,
  _php_stripcslashes,
  _php_stripslashes,
  _php_addcslashes,
  _zend_str_tolower_dup_ex,
  __emalloc_1024,
  _php_strip_tags,
  _zend_binary_strncmp,
  _zend_binary_strncasecmp_l,
  _php_closelog,
  _php_openlog,
  _php_syslog_str,
  _zend_zval_get_legacy_type,
  _zend_rsrc_list_get_rsrc_type,
  _convert_to_long,
  _convert_to_double,
  _convert_to_object,
  _convert_to_boolean,
  _zend_try_assign_typed_ref,
  _zend_is_countable,
  _php_url_scanner_adapt_single_url,
  _php_url_parse_ex,
  _php_url_free,
  _php_url_scanner_add_session_var,
  _php_output_start_internal,
  _php_url_scanner_add_var,
  _php_url_scanner_reset_session_vars,
  _php_url_scanner_reset_vars,
  _php_url_scanner_reset_session_var,
  _php_url_scanner_reset_var,
  _php_url_parse,
  _php_url_parse_ex2,
  _php_url_decode_ex,
  _php_raw_url_decode_ex,
  _zend_update_property_stringl,
  _zend_update_property_long,
  _php_stream_bucket_prepend,
  _php_stream_filter_register_factory_volatile,
  _add_property_string_ex,
  _add_property_zval_ex,
  _add_property_null_ex,
  _zend_call_method_if_exists,
  _php_uuencode,
  _php_uudecode,
  _var_destroy,
  __efree_large,
  _php_var_unserialize_get_allowed_classes,
  _php_var_unserialize_set_allowed_classes,
  _php_var_unserialize_set_max_depth,
  _php_var_unserialize_get_max_depth,
  _php_var_unserialize_set_cur_depth,
  _php_var_unserialize_get_cur_depth,
  _zend_is_valid_class_name,
  _zend_hash_lookup,
  _zend_verify_prop_assignable_by_ref,
  _php_var_dump,
  _php_printf,
  _php_printf_unchecked,
  _zend_array_count,
  _php_debug_zval_dump,
  _php_var_export_ex,
  _smart_str_append_double,
  _php_var_export,
  _php_unserialize_with_options,
  _zend_memory_usage,
  _zend_memory_peak_usage,
  _zend_memory_reset_peak_usage,
  _php_canonicalize_version,
  _zend_prepare_string_for_scanning,
  _zendparse,
  _zend_ast_destroy,
  _lex_scan,
  _php_uri_parse,
  _php_uri_get_scheme,
  _php_uri_get_username,
  _php_uri_get_password,
  _php_uri_get_host,
  _php_uri_get_port,
  _php_uri_get_path,
  _php_uri_get_query,
  _php_uri_get_fragment,
  _php_uri_free,
  _php_uri_instantiate_uri,
  _zend_update_exception_properties,
  _zend_update_property_str,
  _zend_update_property_ex,
  _php_uri_object_create,
  _php_uri_object_handler_free,
  _php_uri_object_handler_clone,
  _php_uri_parser_register,
  _zend_update_property_string,
  _zend_enum_get_case_cstr,
  _virtual_file_ex,
  _OnUpdateBaseDir,
  _php_check_specific_open_basedir,
  _php_fopen_primary_script,
  _zend_stream_open,
  _php_resolve_path,
  _zend_is_executing,
  _php_fopen_with_path,
  _php_strip_url_passwd,
  _php_version,
  _php_version_id,
  _php_get_version,
  _smart_string_append_printf,
  __smart_string_alloc,
  _php_print_version,
  _php_during_module_startup,
  _php_during_module_shutdown,
  _php_get_module_initialized,
  _php_write,
  _php_verror,
  _zend_vstrpprintf,
  _get_active_class_name,
  _zend_strpprintf_unchecked,
  _zend_error_zstr,
  _php_error_docref1,
  _php_html_puts,
  _refresh_memory_manager,
  _zend_interned_strings_activate,
  _php_output_activate,
  _zend_activate,
  _zend_set_timeout,
  _php_output_start_user,
  _php_output_set_implicit_flush,
  _php_hash_environment,
  _zend_activate_modules,
  _zend_observer_fcall_end_all,
  _zend_unset_timeout,
  _zend_deactivate_modules,
  _php_output_deactivate,
  _zend_post_deactivate_modules,
  _sapi_deactivate_module,
  _sapi_deactivate_destroy,
  _virtual_cwd_deactivate,
  _zend_interned_strings_deactivate,
  _shutdown_memory_manager,
  _zend_set_memory_limit,
  _zend_deactivate,
  _php_com_initialize,
  _php_register_extensions,
  _zend_register_internal_module,
  _php_module_startup,
  _sapi_initialize_empty_request,
  _php_output_startup,
  _zend_observer_startup,
  _php_printf_to_smart_str,
  _php_printf_to_smart_string,
  _zend_startup_modules,
  _zend_collect_module_handlers,
  _zend_register_functions,
  _zend_disable_functions,
  _zend_observer_post_startup,
  _zend_init_internal_run_time_cache,
  _cfg_get_long,
  _sapi_deactivate,
  _virtual_cwd_activate,
  _zend_throw_error_exception,
  _zend_trace_to_string,
  _zend_alloc_in_memory_limit_error_reporting,
  _php_output_discard_all,
  _zend_objects_store_mark_destructed,
  __php_stream_open_wrapper_as_file,
  _php_module_shutdown_wrapper,
  _php_module_shutdown,
  _zend_ini_shutdown,
  _php_output_shutdown,
  _zend_interned_strings_dtor,
  _zend_observer_shutdown,
  _php_execute_script_ex,
  _virtual_chdir_file,
  _zend_ini_long,
  _zend_execute_script,
  _php_execute_script,
  _php_execute_simple_script,
  _zend_execute_scripts,
  _php_handle_aborted_connection,
  _php_handle_auth_data,
  _zend_binary_strncasecmp,
  _php_lint_script,
  _OnUpdateStr,
  _zend_ini_parse_uquantity_warn,
  _php_register_internal_extensions,
  _zend_ini_color_displayer_cb,
  _OnUpdateStrNotEmpty,
  _OnUpdateLongGEZero,
  _php_network_freeaddresses,
  _php_network_getaddresses,
  _php_network_connect_socket,
  _php_network_bind_socket_to_local_addr,
  _php_network_populate_name_from_sockaddr,
  _php_network_get_peer_name,
  _php_network_get_sock_name,
  _php_network_accept_incoming,
  _php_network_connect_socket_to_host,
  _php_any_addr,
  _php_sockaddr_size,
  _php_set_sock_blocking,
  _zend_stack_init,
  _zend_stack_top,
  _php_output_handler_dtor,
  _zend_stack_del_top,
  _zend_stack_destroy,
  _zend_is_compiling,
  _zend_get_compiled_filename,
  _zend_get_compiled_lineno,
  _php_output_handler_free,
  _php_output_write_unbuffered,
  _zend_stack_count,
  _zend_stack_apply_with_argument,
  _php_output_flush,
  _zend_stack_push,
  _zend_stack_base,
  _php_output_flush_all,
  _php_output_clean,
  _php_output_clean_all,
  _php_output_get_length,
  _php_output_get_active_handler,
  _php_output_handler_start,
  _php_output_start_devnull,
  _php_output_handler_create_user,
  _php_output_handler_set_context,
  _php_output_handler_alias,
  _php_output_handler_started,
  _php_output_handler_reverse_conflict_register,
  _php_default_post_reader,
  _sapi_register_default_post_reader,
  _php_default_input_filter,
  _php_ini_builder_prepend,
  _php_ini_builder_unquoted,
  _php_ini_builder_quoted,
  _php_ini_builder_define,
  _config_zval_dtor,
  _free_estring,
  _zend_load_extension,
  _zend_load_extension_handle,
  _php_parse_user_ini_file,
  _php_ini_activate_config,
  _php_ini_has_per_dir_config,
  _php_ini_activate_per_dir_config,
  _php_ini_has_per_host_config,
  _php_ini_activate_per_host_config,
  _cfg_get_double,
  _cfg_get_string,
  _php_ini_get_configuration_hash,
  _php_odbc_connstr_is_quoted,
  _php_odbc_connstr_should_quote,
  _php_odbc_connstr_estimate_quote_length,
  _php_odbc_connstr_quote,
  _php_open_temporary_fd,
  _php_open_temporary_file,
  _zend_llist_clean,
  _php_remove_tick_function,
  _php_register_variable,
  _zend_hash_str_update_ind,
  _php_register_known_variable,
  _php_build_argv,
  _zend_activate_auto_globals,
  _zend_register_auto_global,
  _destroy_uploaded_files_hash,
  _zend_multibyte_get_internal_encoding,
  _zend_multibyte_encoding_detector,
  _zend_llist_get_first_ex,
  _zend_llist_get_next_ex,
  _zend_multibyte_encoding_converter,
  _zend_hash_str_add_empty_element,
  _sapi_startup,
  _sapi_shutdown,
  _sapi_free_header,
  _sapi_get_default_content_type,
  _sapi_get_default_content_type_header,
  _sapi_apply_default_charset,
  _sapi_activate_headers_only,
  _sapi_register_post_entry,
  _sapi_get_fd,
  _sapi_force_http_10,
  _sapi_get_target_uid,
  _sapi_get_target_gid,
  _sapi_terminate_process,
  _sapi_add_request_header,
  _ap_php_conv_10,
  _ap_php_conv_p2,
  _ap_php_vslprintf,
  _ap_php_vsnprintf,
  _ap_php_vasprintf,
  _ap_php_asprintf,
  _zend_dtoa,
  _zend_freedtoa,
  __php_stream_make_seekable,
  _php_stream_bucket_split,
  __php_stream_filter_prepend,
  __php_glob_stream_get_pattern,
  __php_stream_mode_to_str,
  __php_stream_memory_get_buffer,
  __php_stream_fopen_temporary_file,
  __php_stream_free_enclosed,
  _php_stream_encloses,
  __php_stream_temp_open,
  __php_stream_mmap_range,
  __php_stream_mmap_unmap,
  __php_stream_mmap_unmap_ex,
  _php_stream_parse_fopen_modes,
  __php_stream_fopen,
  _php_stream_from_persistent_id,
  __php_stream_fopen_with_path,
  _zend_register_persistent_resource,
  __php_stream_fill_read_buffer,
  __php_stream_putc,
  __php_stream_puts,
  __php_stream_copy_to_stream,
  _php_stream_generic_socket_factory,
  _php_stream_xport_register,
  _php_register_url_stream_wrapper_volatile,
  _php_unregister_url_stream_wrapper_volatile,
  _zend_llist_count,
  _php_stream_xport_unregister,
  _php_stream_xport_listen,
  _php_stream_xport_connect,
  _php_stream_xport_bind,
  _add_property_resource_ex,
  __zend_get_special_const,
  _zend_build_cfg,
  _zend_dump_op_array,
  _zend_create_member_string,
  _zend_array_type_info,
  _zend_may_throw,
  _zend_cfg_build_predecessors,
  _zend_cfg_compute_dominators_tree,
  _zend_cfg_identify_loops,
  _zend_build_ssa,
  _zend_ssa_compute_use_def_chains,
  _zend_ssa_find_false_dependencies,
  _zend_ssa_find_sccs,
  _zend_ssa_inference,
  _zend_std_get_constructor,
  _zend_get_call_op,
  _zend_dump_var,
  _increment_function,
  _decrement_function,
  _zend_analyze_calls,
  _zend_build_call_graph,
  _zend_analyze_call_graph,
  _zend_build_call_map,
  _zend_dfg_add_use_def_op,
  _zend_dump_ssa_var,
  _zend_dump_op,
  _zend_get_opcode_name,
  _zend_get_opcode_flags,
  _zend_dump_op_line,
  _zend_get_func_info,
  _zend_get_resource_handle,
  _zend_inference_propagate_range,
  _zend_array_element_type,
  _zend_fetch_arg_info_type,
  _zend_update_type_info,
  _zend_init_func_return_info,
  _zend_may_throw_ex,
  _get_binary_op,
  _zend_binary_op_produces_error,
  _get_unary_op,
  _zend_unary_op_produces_error,
  _zend_recalc_live_ranges,
  _zend_optimizer_register_pass,
  _zend_optimizer_unregister_pass,
  _zend_ssa_rename_op,
  _zend_mm_refresh_key_child,
  _zend_mm_gc,
  _zend_mm_shutdown,
  ___zend_free,
  __zend_mm_alloc,
  __zend_mm_free,
  __zend_mm_realloc,
  __zend_mm_realloc2,
  __zend_mm_block_size,
  _is_zend_ptr,
  __emalloc_112,
  __emalloc_192,
  __emalloc_224,
  __emalloc_384,
  __emalloc_448,
  __emalloc_512,
  __emalloc_640,
  __emalloc_768,
  __emalloc_896,
  __emalloc_1280,
  __emalloc_1536,
  __emalloc_1792,
  __emalloc_2048,
  __emalloc_2560,
  __emalloc_3072,
  __efree_8,
  __efree_16,
  __efree_24,
  __efree_40,
  __efree_56,
  __efree_64,
  __efree_80,
  __efree_96,
  __efree_112,
  __efree_128,
  __efree_192,
  __efree_224,
  __efree_256,
  __efree_320,
  __efree_384,
  __efree_448,
  __efree_512,
  __efree_640,
  __efree_768,
  __efree_896,
  __efree_1024,
  __efree_1280,
  __efree_1536,
  __efree_1792,
  __efree_2048,
  __efree_2560,
  __efree_3072,
  __efree_huge,
  __erealloc2,
  __zend_mem_block_size,
  __safe_malloc,
  _start_memory_manager,
  _zend_mm_set_heap,
  _zend_mm_get_heap,
  _zend_mm_is_custom_heap,
  _zend_mm_set_custom_handlers,
  _zend_mm_set_custom_handlers_ex,
  _zend_mm_get_custom_handlers,
  _zend_mm_get_custom_handlers_ex,
  _zend_mm_get_storage,
  _zend_mm_startup,
  _zend_mm_startup_ex,
  _zend_set_dl_use_deepbind,
  _zend_get_parameters_array_ex,
  _zend_copy_parameters_array,
  _zend_wrong_property_read,
  _zend_get_type_by_const,
  _zend_wrong_callback_error,
  _zend_wrong_callback_or_null_error,
  _zend_wrong_parameter_class_error,
  _zend_wrong_parameter_class_or_null_error,
  _zend_wrong_parameter_class_or_string_error,
  _zend_wrong_parameter_class_or_string_or_null_error,
  _zend_wrong_parameter_class_or_long_error,
  _zend_wrong_parameter_class_or_long_or_null_error,
  _zend_unexpected_extra_named_error,
  _zend_argument_error_variadic,
  _zend_class_redeclaration_error_ex,
  _zend_parse_arg_bool_weak,
  _zend_active_function_ex,
  _zend_parse_arg_long_weak,
  _zend_incompatible_string_to_long_error,
  _zend_parse_arg_double_weak,
  _zend_parse_arg_str_weak,
  _zend_parse_parameter,
  _zend_is_callable_at_frame,
  _zend_parse_method_parameters_ex,
  _zend_merge_properties,
  _zend_verify_class_constant_type,
  _object_properties_init_ex,
  _zend_readonly_property_modification_error,
  _add_assoc_resource_ex,
  _add_assoc_array_ex,
  _add_assoc_object_ex,
  _add_assoc_reference_ex,
  _add_index_null,
  _add_index_resource,
  _add_index_array,
  _add_index_object,
  _add_index_reference,
  _add_next_index_bool,
  _add_next_index_double,
  _add_next_index_array,
  _add_next_index_reference,
  _add_property_long_ex,
  _add_property_bool_ex,
  _add_property_double_ex,
  _add_property_str_ex,
  _add_property_stringl_ex,
  _add_property_array_ex,
  _add_property_object_ex,
  _add_property_reference_ex,
  _zend_destroy_modules,
  _zend_hash_graceful_reverse_destroy,
  _zend_next_free_module,
  _zend_set_function_arg_flags,
  _zend_unregister_functions,
  _zend_check_magic_method_implementation,
  _zend_add_magic_method,
  _zend_startup_module,
  _zend_get_module_started,
  _zend_register_internal_class_ex,
  _zend_do_inheritance_ex,
  _zend_initialize_class_data,
  _zend_do_implement_interface,
  _zend_register_internal_class,
  _zend_register_class_alias_ex,
  _zend_set_hash_symbol,
  _zend_get_callable_name_ex,
  _zend_get_callable_name,
  _zend_check_protected,
  _zend_get_call_trampoline_func,
  _zend_std_get_static_method,
  _zend_make_callable,
  _zend_fcall_info_args_clear,
  _zend_fcall_info_args_save,
  _zend_fcall_info_args_restore,
  _zend_fcall_info_args_ex,
  _zend_fcall_info_args,
  _zend_fcall_info_argp,
  _zend_fcall_info_argv,
  _zend_fcall_info_argn,
  _zend_fcall_info_call,
  _zend_try_assign_typed_ref_ex,
  _zend_try_assign_typed_ref_bool,
  _zend_try_assign_typed_ref_res,
  _zend_try_assign_typed_ref_zval,
  _zend_declare_property_ex,
  _zend_declare_property,
  _zend_declare_property_null,
  _zend_declare_property_bool,
  _zend_declare_property_long,
  _zend_declare_property_double,
  _zend_declare_property_string,
  _zend_declare_property_stringl,
  _zend_declare_class_constant_ex,
  _zend_declare_class_constant,
  _zend_declare_class_constant_null,
  _zend_declare_class_constant_long,
  _zend_declare_class_constant_bool,
  _zend_declare_class_constant_double,
  _zend_declare_class_constant_stringl,
  _zend_declare_class_constant_string,
  _zend_update_property_null,
  _zend_unset_property,
  _zend_update_property_bool,
  _zend_update_property_double,
  _zend_assign_to_typed_ref,
  _zend_update_static_property,
  _zend_update_static_property_null,
  _zend_update_static_property_bool,
  _zend_update_static_property_long,
  _zend_update_static_property_double,
  _zend_update_static_property_string,
  _zend_update_static_property_stringl,
  _zend_read_static_property,
  _zend_save_error_handling,
  _zend_get_object_type_case,
  _zend_compile_string_to_ast,
  _zend_ast_create_znode,
  _zend_ast_create_fcc,
  _zend_ast_create_zval_with_lineno,
  _zend_ast_create_zval_ex,
  _zend_ast_create_zval,
  _zend_ast_create_zval_from_str,
  _zend_ast_create_zval_from_long,
  _zend_ast_create_constant,
  _zend_ast_create_op_array,
  _zend_ast_create_class_const_or_name,
  _zend_ast_create_1,
  _zend_ast_create_2,
  _zend_ast_create_decl,
  _zend_ast_create_0,
  _zend_ast_create_3,
  _zend_ast_create_4,
  _zend_ast_create_5,
  _zend_ast_create_va,
  _zend_ast_create_n,
  _zend_ast_create_ex_n,
  _zend_ast_create_list_0,
  _zend_ast_create_list_1,
  _zend_ast_create_list_2,
  _concat_function,
  _zend_ast_list_add,
  _zend_ast_evaluate_ex,
  _zend_ast_evaluate_inner,
  _is_smaller_function,
  _is_smaller_or_equal_function,
  _zend_std_build_object_properties_array,
  _zend_symtable_to_proptable,
  _zend_create_closure,
  _zend_fetch_class_with_scope,
  _zend_hash_find_ptr_lc,
  _zend_bad_method_call,
  _zend_undefined_method,
  _zend_non_static_method_call,
  _zend_abstract_method_call,
  _zend_fetch_function_str,
  _zend_invalid_class_constant_type_error,
  _zend_get_class_constant_ex,
  _zend_fetch_dimension_const,
  _zend_ast_evaluate,
  _zend_ast_copy,
  _function_add_ref,
  _zend_ast_ref_destroy,
  _zend_ast_apply,
  _zend_atomic_bool_init,
  _zend_atomic_int_init,
  _zend_atomic_bool_exchange,
  _zend_atomic_bool_compare_exchange,
  _zend_atomic_int_compare_exchange,
  _zend_atomic_bool_store,
  _zend_atomic_int_store,
  _zend_atomic_bool_load,
  _zend_atomic_int_load,
  _zend_get_attribute,
  _zend_get_parameter_attribute,
  _zend_get_parameter_attribute_str,
  _zend_vm_stack_extend,
  _zval_internal_ptr_dtor,
  _zend_mark_internal_attribute,
  _zend_internal_attribute_register,
  _zend_internal_attribute_get,
  _zend_register_default_classes,
  _gc_enabled,
  _zend_gc_get_status,
  _zend_register_constant,
  _zend_error_zstr_at,
  _zend_stack_is_empty,
  _zend_stack_int_top,
  _zend_fetch_list_dtor_id,
  _zend_generator_check_placeholder_frame,
  _zend_get_zval_ptr,
  _zend_std_get_class_name,
  _zend_destroy_static_vars,
  _zend_init_rsrc_list,
  _zend_restore_compiled_filename,
  _do_bind_function,
  _zend_bind_class_in_slot,
  _do_bind_class,
  _zend_is_auto_global_str,
  _zend_get_compiled_variable_name,
  _zend_is_smart_branch,
  _execute_ex,
  _zend_multibyte_fetch_encoding,
  _zend_multibyte_set_filter,
  _zend_multibyte_yyinput_again,
  _zend_is_op_long_compatible,
  _zend_type_release,
  _zend_error_noreturn_unchecked,
  _get_function_or_method_name,
  _pass_two,
  _zend_hooked_property_variance_error_ex,
  _zend_verify_property_hook_variance,
  _zend_hooked_property_variance_error,
  _zend_verify_hooked_property,
  _zend_register_null_constant,
  _zend_register_stringl_constant,
  _zend_verify_const_access,
  _zend_get_constant,
  _zend_fetch_class,
  _zend_deprecated_class_constant,
  _zend_deprecated_constant,
  _zend_cpu_supports,
  _zend_register_interfaces,
  _zend_register_iterator_wrapper,
  _zend_enum_get_case_by_value,
  _zend_enum_add_case,
  _zend_enum_get_case,
  _zend_get_exception_base,
  _zend_exception_set_previous,
  _zend_is_unwind_exit,
  _zend_is_graceful_exit,
  _zend_exception_save,
  __zend_observer_error_notify,
  _zend_throw_exception_object,
  _zend_create_unwind_exit,
  _zend_create_graceful_exit,
  _zend_throw_graceful_exit,
  _zend_init_fpu,
  _zend_vm_stack_init,
  _zend_objects_store_init,
  _zend_hash_reverse_apply,
  _zend_objects_store_call_destructors,
  _zend_cleanup_internal_class_data,
  _zend_cleanup_mutable_class_data,
  _zend_stack_clean,
  _zend_objects_store_free_object_storage,
  _zend_vm_stack_destroy,
  _zend_objects_store_destroy,
  _zend_shutdown_fpu,
  _get_function_arg_name,
  _zval_update_constant_with_ctx,
  _zval_update_constant,
  _zend_deprecated_function,
  _zend_handle_undef_args,
  _zend_init_func_execute_data,
  _zend_observer_fcall_begin,
  _zend_observer_fcall_end_prechecked,
  _zend_timeout,
  _zend_free_extra_named_params,
  _zend_hash_index_add_empty_element,
  _zend_eval_stringl,
  _zend_eval_string,
  _zend_eval_stringl_ex,
  _zend_eval_string_ex,
  _zend_signal,
  _zend_delete_global_variable,
  _zend_hash_del_ind,
  _zend_attach_symbol_table,
  _zend_detach_symbol_table,
  _zend_set_local_var,
  _zend_hash_func,
  _zend_vm_stack_init_ex,
  _zend_get_compiled_variable_value,
  _zend_gcc_global_regs,
  _zend_cannot_pass_by_reference,
  _zend_verify_arg_error,
  _zend_verify_scalar_type_hint,
  _zend_readonly_property_indirect_modification_error,
  _zend_object_released_while_assigning_to_property_error,
  _zend_asymmetric_visibility_property_modification_error,
  _zend_check_user_type_slow,
  _zend_missing_arg_error,
  _zend_verify_return_error,
  _zend_verify_never_error,
  _zend_frameless_observed_call,
  _zend_observer_fcall_begin_prechecked,
  _zend_wrong_string_offset_error,
  _zend_error_unchecked,
  _zend_nodiscard_function,
  _zend_use_of_deprecated_trait,
  _zend_false_to_array_deprecated,
  _zend_undefined_offset_write,
  _zend_undefined_index_write,
  __zend_hash_index_find,
  _zend_verify_ref_array_assignable,
  _zend_fetch_static_property,
  _zend_throw_ref_type_error_type,
  _zend_throw_ref_type_error_zval,
  _zend_throw_conflicting_coercion_error,
  _zend_assign_to_typed_ref_ex,
  _zend_verify_prop_assignable_by_ref_ex,
  _execute_internal,
  _zend_clean_and_cache_symbol_table,
  _zend_symtable_clean,
  _zend_free_compiled_variables,
  _zend_fcall_interrupt,
  _zend_init_func_run_time_cache,
  _zend_init_code_execute_data,
  _zend_init_execute_data,
  _zend_unfinished_calls_gc,
  _zend_cleanup_unfinished_execution,
  _zend_unfinished_execution_gc,
  _zend_unfinished_execution_gc_ex,
  _div_function,
  _boolean_xor_function,
  _zend_asymmetric_property_has_set_access,
  _zend_iterator_unwrap,
  _zend_generator_close,
  _compare_function,
  _zend_std_unset_static_property,
  _zend_hash_real_init,
  _zend_get_opcode_handler_func,
  _zend_get_halt_op,
  _zend_vm_kind,
  _zend_vm_call_opcode_handler,
  _zend_set_user_opcode_handler,
  _zend_get_user_opcode_handler,
  _sub_function,
  _mod_function,
  _shift_left_function,
  _shift_right_function,
  _bitwise_or_function,
  _bitwise_and_function,
  _bitwise_xor_function,
  _bitwise_not_function,
  _compile_filename,
  _zend_llist_apply_with_arguments,
  _zend_extension_dispatch_message,
  _zend_llist_apply_with_del,
  _zend_append_version_info,
  _zend_add_system_entropy,
  _zend_get_op_array_extension_handle,
  _zend_get_op_array_extension_handles,
  _zend_get_internal_function_extension_handle,
  _zend_get_internal_function_extension_handles,
  _zend_reset_internal_run_time_cache,
  _zend_fiber_switch_blocked,
  _zend_fiber_init_context,
  _zend_get_page_size,
  _zend_fiber_destroy_context,
  _zend_observer_fiber_destroy_notify,
  _zend_fiber_switch_context,
  _zend_observer_fiber_switch_notify,
  _zend_fiber_start,
  _zend_fiber_resume,
  _zend_fiber_resume_exception,
  _zend_fiber_suspend,
  _zend_ensure_fpu_mode,
  _gc_protect,
  _gc_protected,
  _zend_gc_collect_cycles,
  ___jit_debug_register_code,
  _zend_gdb_register_code,
  _zend_gdb_unregister_all,
  _zend_gdb_present,
  _zend_generator_restore_call_stack,
  _zend_generator_freeze_call_stack,
  _zend_generator_resume,
  _zend_observer_generator_resume,
  _zend_hash_packed_to_hash,
  _zend_hash_get_current_pos_ex,
  _zend_hash_add_or_update,
  _zend_hash_str_add_or_update,
  _zend_hash_index_add_or_update,
  _zend_hash_str_del_ind,
  _zend_hash_graceful_destroy,
  _zend_hash_apply_with_arguments,
  _zend_hash_merge_ex,
  _zend_hash_bucket_renum_swap,
  _zend_hash_bucket_packed_swap,
  _zend_html_putc,
  _zend_highlight,
  _zend_perform_covariant_type_check,
  _zend_error_at_noreturn,
  _zend_get_configuration_directive,
  _zend_stream_fixup,
  _zend_ini_startup,
  _zend_ini_dtor,
  _zend_ini_global_shutdown,
  _zend_ini_deactivate,
  _zend_register_ini_entries,
  _zend_unregister_ini_entries,
  _zend_alter_ini_entry_chars_ex,
  _zend_ini_register_displayer,
  _zend_ini_parse_uquantity,
  _display_link_numbers,
  _OnUpdateReal,
  _zend_user_it_new_iterator,
  _zend_user_it_valid,
  _zend_user_it_get_current_data,
  _zend_user_it_get_current_key,
  _zend_user_it_move_forward,
  _zend_user_it_rewind,
  _zend_user_it_get_gc,
  _zend_user_it_get_new_iterator,
  _zend_user_serialize,
  _zend_user_unserialize,
  _zend_lex_tstring,
  _zend_get_scanned_file_offset,
  _zend_ptr_stack_init,
  _zend_ptr_stack_clean,
  _zend_ptr_stack_destroy,
  _zend_multibyte_check_lexer_compatibility,
  _zend_multibyte_get_encoding_name,
  _compile_file,
  _compile_string,
  _zend_ptr_stack_reverse_apply,
  _zend_hex_strtod,
  _zend_oct_strtod,
  _zend_bin_strtod,
  _zend_objects_clone_obj,
  _zend_list_insert,
  _zend_list_free,
  _zend_register_persistent_resource_ex,
  _zend_llist_prepend_element,
  _zend_llist_remove_tail,
  _zend_llist_copy,
  _zend_llist_sort,
  _zend_llist_get_last_ex,
  _zend_llist_get_prev_ex,
  _zend_multibyte_set_script_encoding_by_string,
  _zend_multibyte_parse_encoding_list,
  _zend_multibyte_get_script_encoding,
  _zend_multibyte_set_script_encoding,
  _zend_std_get_gc,
  _zend_std_get_debug_info,
  _zend_get_property_guard,
  _zend_std_get_closure,
  _zend_hooked_object_build_properties,
  _zend_objects_clone_obj_with,
  _zend_objects_store_put,
  _zend_weakrefs_notify,
  _zend_observer_fcall_register,
  _zend_observer_activate,
  _zend_observer_add_begin_handler,
  _zend_observer_remove_begin_handler,
  _zend_observer_add_end_handler,
  _zend_observer_remove_end_handler,
  _zend_observer_function_declared_register,
  _zend_observer_class_linked_register,
  _zend_observer_error_register,
  _zend_observer_fiber_init_register,
  _zend_observer_fiber_switch_register,
  _zend_observer_fiber_destroy_register,
  _zend_observer_fiber_init_notify,
  _destroy_zend_function,
  _boolean_not_function,
  _is_identical_function,
  _is_not_identical_function,
  _is_equal_function,
  _is_not_equal_function,
  _zend_atol,
  _zend_atoi,
  _convert_scalar_to_number,
  _zend_oob_string_to_long_error,
  _string_compare_function_ex,
  _zend_compare_arrays,
  _zend_str_toupper_copy,
  _zend_str_toupper_dup,
  _zend_str_toupper,
  _zend_str_toupper_dup_ex,
  _zend_binary_zval_strcmp,
  _zend_binary_zval_strncmp,
  _zend_compare_objects,
  _zend_ulong_to_str,
  _zend_u64_to_str,
  _zend_i64_to_str,
  _zend_ptr_stack_init_ex,
  _zend_ptr_stack_n_push,
  _zend_ptr_stack_n_pop,
  _zend_ptr_stack_apply,
  _zend_ptr_stack_num_elements,
  _zend_signal_startup,
  _smart_str_realloc,
  __smart_string_alloc_persistent,
  _smart_str_append_escaped_truncated,
  _smart_str_append_scalar,
  _zend_insert_sort,
  _zend_stack_apply,
  _zend_interned_strings_init,
  _zend_interned_string_find_permanent,
  _zend_shutdown_strtod,
  _virtual_cwd_startup,
  _virtual_cwd_shutdown,
  _virtual_getcwd_ex,
  _virtual_getcwd,
  _realpath_cache_lookup,
  _virtual_chdir,
  _virtual_realpath,
  _virtual_filepath_ex,
  _virtual_filepath,
  _virtual_fopen,
  _virtual_access,
  _virtual_utime,
  _virtual_chmod,
  _virtual_chown,
  _virtual_open,
  _virtual_creat,
  _virtual_rename,
  _virtual_stat,
  _virtual_lstat,
  _virtual_unlink,
  _virtual_mkdir,
  _virtual_rmdir,
  _virtual_opendir,
  _virtual_popen,
  _zend_get_opcode_id,
  _zend_weakrefs_hash_add,
  _zend_weakrefs_hash_del,
  _zend_weakrefs_hash_clean,
  _zend_spprintf_unchecked,
  _zend_make_printable_zval,
  _zend_print_zval,
  _zend_print_flat_zval_r,
  _zend_output_debug_string,
  _zend_strerror_noreturn,
  _php_cli_get_shell_callbacks,
  _sapi_cli_single_write,
  _main,
  _libiconv_open_into,
  _libiconvctl,
  _libiconvlist,
  _iconv_canonicalize,
  __emscripten_memcpy_bulkmem,
  _emscripten_stack_get_end,
  _emscripten_stack_get_base,
  _emscripten_builtin_memalign,
  __emscripten_timeout,
  _setThrew,
  __emscripten_tempret_set,
  __emscripten_tempret_get,
  ___get_temp_ret,
  ___set_temp_ret,
  _emscripten_stack_init,
  _emscripten_stack_set_limits,
  _emscripten_stack_get_free,
  __emscripten_stack_restore,
  __emscripten_stack_alloc,
  _emscripten_stack_get_current,
  memory,
  ___stack_pointer,
  _compiler_globals,
  _zend_known_strings,
  _zend_string_init_interned,
  __indirect_function_table,
  _std_object_handlers,
  _zend_ce_aggregate,
  _zend_ce_error,
  _zend_ce_exception,
  _zend_empty_string,
  _executor_globals,
  _basic_globals,
  _pcre_globals,
  _zend_one_char_string,
  _file_globals,
  _core_globals,
  _php_hashcontext_ce,
  _zend_ce_value_error,
  __libiconv_version,
  _sapi_globals,
  _php_json_serializable_ce,
  _zend_empty_array,
  _php_json_exception_ce,
  _json_globals,
  _lexbor_hash_insert_raw,
  _lexbor_hash_insert_lower,
  _lexbor_hash_insert_upper,
  _lexbor_hash_search_raw,
  _lexbor_hash_search_lower,
  _lexbor_hash_search_upper,
  _lxb_encoding_multi_big5_map,
  _lxb_encoding_multi_jis0208_map,
  _lxb_encoding_multi_jis0212_map,
  _lxb_encoding_multi_euc_kr_map,
  _lxb_encoding_multi_gb18030_map,
  _lxb_encoding_range_index_gb18030,
  _lxb_encoding_single_index_ibm866,
  _lxb_encoding_single_index_iso_8859_10,
  _lxb_encoding_single_index_iso_8859_13,
  _lxb_encoding_single_index_iso_8859_14,
  _lxb_encoding_single_index_iso_8859_15,
  _lxb_encoding_single_index_iso_8859_16,
  _lxb_encoding_single_index_iso_8859_2,
  _lxb_encoding_single_index_iso_8859_3,
  _lxb_encoding_single_index_iso_8859_4,
  _lxb_encoding_single_index_iso_8859_5,
  _lxb_encoding_single_index_iso_8859_6,
  _lxb_encoding_single_index_iso_8859_7,
  _lxb_encoding_single_index_iso_8859_8,
  _lxb_encoding_single_index_koi8_r,
  _lxb_encoding_single_index_koi8_u,
  _lxb_encoding_single_index_macintosh,
  _lxb_encoding_single_index_windows_1250,
  _lxb_encoding_single_index_windows_1251,
  _lxb_encoding_single_index_windows_1252,
  _lxb_encoding_single_index_windows_1253,
  _lxb_encoding_single_index_windows_1254,
  _lxb_encoding_single_index_windows_1255,
  _lxb_encoding_single_index_windows_1256,
  _lxb_encoding_single_index_windows_1257,
  _lxb_encoding_single_index_windows_1258,
  _lxb_encoding_single_index_windows_874,
  _lxb_encoding_single_index_x_mac_cyrillic,
  _lxb_encoding_multi_big5_167_1106_map,
  _lxb_encoding_multi_big5_8211_40882_map,
  _lxb_encoding_multi_big5_64012_65518_map,
  _lxb_encoding_multi_big5_131210_172369_map,
  _lxb_encoding_multi_big5_194708_194727_map,
  _lxb_encoding_multi_jis0208_167_1106_map,
  _lxb_encoding_multi_jis0208_8208_13262_map,
  _lxb_encoding_multi_jis0208_19968_40865_map,
  _lxb_encoding_multi_jis0208_63785_65510_map,
  _lxb_encoding_multi_euc_kr_161_1106_map,
  _lxb_encoding_multi_euc_kr_8213_13278_map,
  _lxb_encoding_multi_euc_kr_19968_55204_map,
  _lxb_encoding_multi_euc_kr_63744_65511_map,
  _lxb_encoding_multi_gb18030_164_1106_map,
  _lxb_encoding_multi_gb18030_7743_40892_map,
  _lxb_encoding_multi_gb18030_57344_65510_map,
  _lxb_encoding_single_hash_ibm866,
  _lxb_encoding_multi_iso_2022_jp_katakana_map,
  _lxb_encoding_single_hash_iso_8859_10,
  _lxb_encoding_single_hash_iso_8859_13,
  _lxb_encoding_single_hash_iso_8859_14,
  _lxb_encoding_single_hash_iso_8859_15,
  _lxb_encoding_single_hash_iso_8859_16,
  _lxb_encoding_single_hash_iso_8859_2,
  _lxb_encoding_single_hash_iso_8859_3,
  _lxb_encoding_single_hash_iso_8859_4,
  _lxb_encoding_single_hash_iso_8859_5,
  _lxb_encoding_single_hash_iso_8859_6,
  _lxb_encoding_single_hash_iso_8859_7,
  _lxb_encoding_single_hash_iso_8859_8,
  _lxb_encoding_single_hash_koi8_r,
  _lxb_encoding_single_hash_koi8_u,
  _lxb_encoding_single_hash_macintosh,
  _lxb_encoding_single_hash_windows_1250,
  _lxb_encoding_single_hash_windows_1251,
  _lxb_encoding_single_hash_windows_1252,
  _lxb_encoding_single_hash_windows_1253,
  _lxb_encoding_single_hash_windows_1254,
  _lxb_encoding_single_hash_windows_1255,
  _lxb_encoding_single_hash_windows_1256,
  _lxb_encoding_single_hash_windows_1257,
  _lxb_encoding_single_hash_windows_1258,
  _lxb_encoding_single_hash_windows_874,
  _lxb_encoding_single_hash_x_mac_cyrillic,
  _lxb_encoding_res_shs_entities,
  _lxb_encoding_res_map,
  _lxb_encoding_multi_iso_2022_jp_katakana_12289_12541_map,
  _lxb_encoding_multi_jis0212_161_1120_map,
  _lxb_encoding_multi_jis0212_8470_8483_map,
  _lxb_encoding_multi_jis0212_19970_40870_map,
  _lxb_encoding_multi_jis0212_65374_65375_map,
  _php_internal_encoding_changed,
  _mbfl_encoding_pass,
  _sapi_module,
  _vtbl_pass,
  _module_registry,
  _smm_shared_globals,
  _zend_ce_closure,
  _zend_resolve_path,
  _zend_observer_function_declared_observed,
  _zend_observer_class_linked_observed,
  _zend_system_id,
  _zend_enum_object_handlers,
  _zend_ce_iterator,
  _zend_map_ptr_static_last,
  _zend_accel_schedule_restart_hook,
  _zend_signal_globals,
  _zend_post_shutdown_cb,
  _zend_compile_file,
  _zend_inheritance_cache_get,
  _zend_inheritance_cache_add,
  _zend_extensions,
  _zend_post_startup_cb,
  _zend_stream_open_function,
  _zend_map_ptr_static_size,
  _zend_observer_fcall_op_array_extension,
  _zend_error_cb,
  _zend_interrupt_function,
  _random_ce_Random_RandomException,
  _php_random_algo_mt19937,
  _php_random_algo_pcgoneseq128xslrr64,
  _php_random_algo_secure,
  _random_ce_Random_BrokenRandomEngineError,
  _php_random_algo_user,
  _php_random_algo_xoshiro256starstar,
  _random_globals,
  _random_ce_Random_Engine,
  _random_ce_Random_CryptoSafeEngine,
  _random_ce_Random_RandomError,
  _random_ce_Random_Engine_Mt19937,
  _random_ce_Random_Engine_PcgOneseq128XslRr64,
  _random_ce_Random_Engine_Xoshiro256StarStar,
  _random_ce_Random_Engine_Secure,
  _random_ce_Random_Randomizer,
  _random_ce_Random_IntervalBoundary,
  _reflection_enum_ptr,
  _reflection_class_ptr,
  _reflection_exception_ptr,
  _reflection_attribute_ptr,
  _reflection_parameter_ptr,
  _reflection_extension_ptr,
  _zend_ce_generator,
  _reflection_function_ptr,
  _reflection_method_ptr,
  _reflection_intersection_type_ptr,
  _reflection_union_type_ptr,
  _reflection_named_type_ptr,
  _reflection_property_ptr,
  _reflection_class_constant_ptr,
  _zend_ce_traversable,
  _reflection_property_hook_type_ptr,
  _reflection_reference_ptr,
  _reflection_enum_backed_case_ptr,
  _reflection_enum_unit_case_ptr,
  _zend_ce_fiber,
  _reflection_ptr,
  _zend_ce_stringable,
  _reflector_ptr,
  _reflection_function_abstract_ptr,
  _reflection_generator_ptr,
  _reflection_type_ptr,
  _reflection_object_ptr,
  _reflection_zend_extension_ptr,
  _reflection_fiber_ptr,
  _reflection_constant_ptr,
  _spl_ce_AppendIterator,
  _spl_ce_ArrayIterator,
  _spl_ce_ArrayObject,
  _spl_ce_BadFunctionCallException,
  _spl_ce_BadMethodCallException,
  _spl_ce_CachingIterator,
  _spl_ce_CallbackFilterIterator,
  _spl_ce_DirectoryIterator,
  _spl_ce_DomainException,
  _spl_ce_EmptyIterator,
  _spl_ce_FilesystemIterator,
  _spl_ce_FilterIterator,
  _spl_ce_GlobIterator,
  _spl_ce_InfiniteIterator,
  _spl_ce_InvalidArgumentException,
  _spl_ce_IteratorIterator,
  _spl_ce_LengthException,
  _spl_ce_LimitIterator,
  _spl_ce_LogicException,
  _spl_ce_MultipleIterator,
  _spl_ce_NoRewindIterator,
  _spl_ce_OuterIterator,
  _spl_ce_OutOfBoundsException,
  _spl_ce_OutOfRangeException,
  _spl_ce_OverflowException,
  _spl_ce_ParentIterator,
  _spl_ce_RangeException,
  _spl_ce_RecursiveArrayIterator,
  _spl_ce_RecursiveCachingIterator,
  _spl_ce_RecursiveCallbackFilterIterator,
  _spl_ce_RecursiveDirectoryIterator,
  _spl_ce_RecursiveFilterIterator,
  _spl_ce_RecursiveIterator,
  _spl_ce_RecursiveIteratorIterator,
  _spl_ce_RecursiveRegexIterator,
  _spl_ce_RecursiveTreeIterator,
  _spl_ce_RegexIterator,
  _spl_ce_RuntimeException,
  _spl_ce_SeekableIterator,
  _spl_ce_SplDoublyLinkedList,
  _spl_ce_SplFileInfo,
  _spl_ce_SplFileObject,
  _spl_ce_SplFixedArray,
  _spl_ce_SplHeap,
  _spl_ce_SplMinHeap,
  _spl_ce_SplMaxHeap,
  _spl_ce_SplObjectStorage,
  _spl_ce_SplObserver,
  _spl_ce_SplPriorityQueue,
  _spl_ce_SplQueue,
  _spl_ce_SplStack,
  _spl_ce_SplSubject,
  _spl_ce_SplTempFileObject,
  _spl_ce_UnderflowException,
  _spl_ce_UnexpectedValueException,
  _zend_autoload,
  _zend_ce_arrayaccess,
  _zend_ce_serializable,
  _zend_ce_countable,
  _php_glob_stream_ops,
  _zend_ce_throwable,
  _assertion_error_ce,
  _php_ce_incomplete_class,
  _rounding_mode_ce,
  _php_stream_php_wrapper,
  _php_plain_files_wrapper,
  _php_glob_stream_wrapper,
  _php_stream_rfc2397_wrapper,
  _php_stream_http_wrapper,
  _php_stream_ftp_wrapper,
  _php_load_environment_variables,
  _php_optidx,
  _zend_tolower_map,
  _zend_standard_class_def,
  _zend_new_interned_string,
  _php_stream_stdio_ops,
  _zend_ce_request_parse_body_exception,
  _php_sig_gif,
  _php_sig_psd,
  _php_sig_bmp,
  _php_sig_swf,
  _php_sig_swc,
  _php_sig_jpg,
  _php_sig_png,
  _php_sig_tif_ii,
  _php_sig_tif_mm,
  _php_sig_jpc,
  _php_sig_jp2,
  _php_sig_iff,
  _php_sig_ico,
  _php_sig_riff,
  _php_sig_webp,
  _php_sig_ftyp,
  _php_sig_mif1,
  _php_sig_heic,
  _php_sig_heix,
  _php_tiff_bytes_per_format,
  _php_ini_opened_path,
  _php_ini_scanned_path,
  _php_ini_scanned_files,
  _zend_ce_division_by_zero_error,
  _zend_ce_arithmetic_error,
  _php_stream_socket_ops,
  _zend_toupper_map,
  _zend_string_init_existing_interned,
  _zend_write,
  _language_scanner_globals,
  _php_uri_parser_rfc3986,
  _php_uri_parser_whatwg,
  _php_uri_parser_php_parse_url,
  _le_index_ptr,
  _php_register_internal_extensions_func,
  _output_globals,
  _php_import_environment_variables,
  _php_rfc1867_callback,
  _php_stream_memory_ops,
  _php_stream_temp_ops,
  _php_stream_rfc2397_ops,
  _php_stream_rfc2397_wops,
  _php_stream_userspace_ops,
  _php_stream_userspace_dir_ops,
  _zend_op_array_extension_handles,
  _zend_func_info_rid,
  _zend_flf_functions,
  _zend_random_bytes_insecure,
  _zend_dl_use_deepbind,
  _zend_ce_type_error,
  _zend_flf_handlers,
  _zend_ast_process,
  _zend_ce_sensitive_parameter_value,
  _zend_ce_deprecated,
  _zend_ce_nodiscard,
  _zend_ce_attribute,
  _zend_ce_return_type_will_change_attribute,
  _zend_ce_allow_dynamic_properties,
  _zend_ce_sensitive_parameter,
  _zend_ce_override,
  _zend_ce_delayed_target_validation,
  _gc_collect_cycles,
  _zend_ce_compile_error,
  _zend_execute_internal,
  _zend_execute_ex,
  _zend_compile_string,
  _zend_ce_unit_enum,
  _zend_ce_backed_enum,
  _zend_ce_parse_error,
  _zend_throw_exception_hook,
  _zend_observer_errors_observed,
  _zend_ce_argument_count_error,
  _zend_ce_error_exception,
  _zend_ce_unhandled_match_error,
  _zend_on_timeout,
  _zend_observer_fcall_internal_function_extension,
  _zend_pass_function,
  _zend_ticks_function,
  _zend_touch_vm_stack_data,
  _zend_extension_flags,
  _zend_internal_function_extension_handles,
  ___jit_debug_descriptor,
  _zend_ce_ClosedGeneratorException,
  _zend_printf,
  _ini_scanner_globals,
  _zend_getenv,
  _zend_uv,
  _zend_ce_internal_iterator,
  _zend_multibyte_encoding_utf32be,
  _zend_multibyte_encoding_utf32le,
  _zend_multibyte_encoding_utf16be,
  _zend_multibyte_encoding_utf16le,
  _zend_multibyte_encoding_utf8,
  _zend_fopen,
  _zend_ce_weakref,
  _zend_random_bytes,
  _zend_dtrace_enabled,
  wasmMemory,
  wasmTable;


function assignWasmExports(wasmExports) {
  _php_time = Module['_php_time'] = wasmExports['php_time'];
  _php_date_get_date_ce = Module['_php_date_get_date_ce'] = wasmExports['php_date_get_date_ce'];
  _php_date_get_immutable_ce = Module['_php_date_get_immutable_ce'] = wasmExports['php_date_get_immutable_ce'];
  _php_date_get_interface_ce = Module['_php_date_get_interface_ce'] = wasmExports['php_date_get_interface_ce'];
  _php_date_get_timezone_ce = Module['_php_date_get_timezone_ce'] = wasmExports['php_date_get_timezone_ce'];
  _php_date_get_interval_ce = Module['_php_date_get_interval_ce'] = wasmExports['php_date_get_interval_ce'];
  _php_date_get_period_ce = Module['_php_date_get_period_ce'] = wasmExports['php_date_get_period_ce'];
  _zend_register_ini_entries_ex = Module['_zend_register_ini_entries_ex'] = wasmExports['zend_register_ini_entries_ex'];
  _zend_register_string_constant = Module['_zend_register_string_constant'] = wasmExports['zend_register_string_constant'];
  _zend_register_long_constant = Module['_zend_register_long_constant'] = wasmExports['zend_register_long_constant'];
  _zend_hash_str_find = Module['_zend_hash_str_find'] = wasmExports['zend_hash_str_find'];
  _zend_add_attribute = Module['_zend_add_attribute'] = wasmExports['zend_add_attribute'];
  ___zend_malloc = Module['___zend_malloc'] = wasmExports['__zend_malloc'];
  _zend_unregister_ini_entries_ex = Module['_zend_unregister_ini_entries_ex'] = wasmExports['zend_unregister_ini_entries_ex'];
  __efree = Module['__efree'] = wasmExports['_efree'];
  _php_info_print_table_start = Module['_php_info_print_table_start'] = wasmExports['php_info_print_table_start'];
  _php_info_print_table_row = Module['_php_info_print_table_row'] = wasmExports['php_info_print_table_row'];
  _cfg_get_entry = Module['_cfg_get_entry'] = wasmExports['cfg_get_entry'];
  _php_info_print_table_end = Module['_php_info_print_table_end'] = wasmExports['php_info_print_table_end'];
  _display_ini_entries = Module['_display_ini_entries'] = wasmExports['display_ini_entries'];
  _zend_hash_destroy = Module['_zend_hash_destroy'] = wasmExports['zend_hash_destroy'];
  __efree_48 = Module['__efree_48'] = wasmExports['_efree_48'];
  _zend_register_internal_interface = Module['_zend_register_internal_interface'] = wasmExports['zend_register_internal_interface'];
  _zend_declare_typed_class_constant = Module['_zend_declare_typed_class_constant'] = wasmExports['zend_declare_typed_class_constant'];
  _zend_register_internal_class_with_flags = Module['_zend_register_internal_class_with_flags'] = wasmExports['zend_register_internal_class_with_flags'];
  _zend_class_implements = Module['_zend_class_implements'] = wasmExports['zend_class_implements'];
  _zend_declare_typed_property = Module['_zend_declare_typed_property'] = wasmExports['zend_declare_typed_property'];
  _get_timezone_info = Module['_get_timezone_info'] = wasmExports['get_timezone_info'];
  _zend_throw_error = Module['_zend_throw_error'] = wasmExports['zend_throw_error'];
  __emalloc_48 = Module['__emalloc_48'] = wasmExports['_emalloc_48'];
  __zend_hash_init = Module['__zend_hash_init'] = wasmExports['_zend_hash_init'];
  _zend_hash_str_add = Module['_zend_hash_str_add'] = wasmExports['zend_hash_str_add'];
  _php_format_date_obj = Module['_php_format_date_obj'] = wasmExports['php_format_date_obj'];
  __estrdup = Module['__estrdup'] = wasmExports['_estrdup'];
  __emalloc_16 = Module['__emalloc_16'] = wasmExports['_emalloc_16'];
  _ap_php_snprintf = Module['_ap_php_snprintf'] = wasmExports['ap_php_snprintf'];
  _ap_php_slprintf = Module['_ap_php_slprintf'] = wasmExports['ap_php_slprintf'];
  _smart_str_erealloc = Module['_smart_str_erealloc'] = wasmExports['smart_str_erealloc'];
  _php_format_date = Module['_php_format_date'] = wasmExports['php_format_date'];
  _php_idate = Module['_php_idate'] = wasmExports['php_idate'];
  _zend_wrong_parameters_count_error = Module['_zend_wrong_parameters_count_error'] = wasmExports['zend_wrong_parameters_count_error'];
  _zend_parse_arg_str_slow = Module['_zend_parse_arg_str_slow'] = wasmExports['zend_parse_arg_str_slow'];
  _zend_parse_arg_long_slow = Module['_zend_parse_arg_long_slow'] = wasmExports['zend_parse_arg_long_slow'];
  _zend_wrong_parameter_error = Module['_zend_wrong_parameter_error'] = wasmExports['zend_wrong_parameter_error'];
  _php_error_docref = Module['_php_error_docref'] = wasmExports['php_error_docref'];
  _php_date_set_tzdb = Module['_php_date_set_tzdb'] = wasmExports['php_date_set_tzdb'];
  _php_version_compare = Module['_php_version_compare'] = wasmExports['php_version_compare'];
  _php_parse_date = Module['_php_parse_date'] = wasmExports['php_parse_date'];
  _php_mktime = Module['_php_mktime'] = wasmExports['php_mktime'];
  _php_strftime = Module['_php_strftime'] = wasmExports['php_strftime'];
  __emalloc_320 = Module['__emalloc_320'] = wasmExports['_emalloc_320'];
  __erealloc = Module['__erealloc'] = wasmExports['_erealloc'];
  __emalloc = Module['__emalloc'] = wasmExports['_emalloc'];
  _zend_wrong_parameters_none_error = Module['_zend_wrong_parameters_none_error'] = wasmExports['zend_wrong_parameters_none_error'];
  _zend_parse_arg_bool_slow = Module['_zend_parse_arg_bool_slow'] = wasmExports['zend_parse_arg_bool_slow'];
  __zend_new_array = Module['__zend_new_array'] = wasmExports['_zend_new_array'];
  _add_assoc_long_ex = Module['_add_assoc_long_ex'] = wasmExports['add_assoc_long_ex'];
  _zend_hash_real_init_packed = Module['_zend_hash_real_init_packed'] = wasmExports['zend_hash_real_init_packed'];
  _add_next_index_long = Module['_add_next_index_long'] = wasmExports['add_next_index_long'];
  _add_assoc_string_ex = Module['_add_assoc_string_ex'] = wasmExports['add_assoc_string_ex'];
  _add_index_long = Module['_add_index_long'] = wasmExports['add_index_long'];
  _php_date_instantiate = Module['_php_date_instantiate'] = wasmExports['php_date_instantiate'];
  _object_init_ex = Module['_object_init_ex'] = wasmExports['object_init_ex'];
  _php_date_initialize = Module['_php_date_initialize'] = wasmExports['php_date_initialize'];
  _zend_throw_exception_ex = Module['_zend_throw_exception_ex'] = wasmExports['zend_throw_exception_ex'];
  _php_date_initialize_from_ts_long = Module['_php_date_initialize_from_ts_long'] = wasmExports['php_date_initialize_from_ts_long'];
  _php_date_initialize_from_ts_double = Module['_php_date_initialize_from_ts_double'] = wasmExports['php_date_initialize_from_ts_double'];
  _zend_argument_error = Module['_zend_argument_error'] = wasmExports['zend_argument_error'];
  _instanceof_function_slow = Module['_instanceof_function_slow'] = wasmExports['instanceof_function_slow'];
  _zval_ptr_dtor = Module['_zval_ptr_dtor'] = wasmExports['zval_ptr_dtor'];
  _zend_parse_arg_number_slow = Module['_zend_parse_arg_number_slow'] = wasmExports['zend_parse_arg_number_slow'];
  _zend_string_concat3 = Module['_zend_string_concat3'] = wasmExports['zend_string_concat3'];
  __zend_new_array_0 = Module['__zend_new_array_0'] = wasmExports['_zend_new_array_0'];
  _zend_std_get_properties = Module['_zend_std_get_properties'] = wasmExports['zend_std_get_properties'];
  _zend_hash_add = Module['_zend_hash_add'] = wasmExports['zend_hash_add'];
  _zend_hash_str_update = Module['_zend_hash_str_update'] = wasmExports['zend_hash_str_update'];
  __emalloc_32 = Module['__emalloc_32'] = wasmExports['_emalloc_32'];
  _add_index_string = Module['_add_index_string'] = wasmExports['add_index_string'];
  _add_assoc_zval_ex = Module['_add_assoc_zval_ex'] = wasmExports['add_assoc_zval_ex'];
  _add_assoc_bool_ex = Module['_add_assoc_bool_ex'] = wasmExports['add_assoc_bool_ex'];
  _add_assoc_double_ex = Module['_add_assoc_double_ex'] = wasmExports['add_assoc_double_ex'];
  _zend_parse_method_parameters = Module['_zend_parse_method_parameters'] = wasmExports['zend_parse_method_parameters'];
  _zend_replace_error_handling = Module['_zend_replace_error_handling'] = wasmExports['zend_replace_error_handling'];
  _zend_restore_error_handling = Module['_zend_restore_error_handling'] = wasmExports['zend_restore_error_handling'];
  _zend_spprintf = Module['_zend_spprintf'] = wasmExports['zend_spprintf'];
  _add_assoc_str_ex = Module['_add_assoc_str_ex'] = wasmExports['add_assoc_str_ex'];
  _zend_hash_next_index_insert = Module['_zend_hash_next_index_insert'] = wasmExports['zend_hash_next_index_insert'];
  _zval_get_long_func = Module['_zval_get_long_func'] = wasmExports['zval_get_long_func'];
  _zval_get_double_func = Module['_zval_get_double_func'] = wasmExports['zval_get_double_func'];
  _zend_oob_double_to_long_error = Module['_zend_oob_double_to_long_error'] = wasmExports['zend_oob_double_to_long_error'];
  _zend_dval_to_lval_slow = Module['_zend_dval_to_lval_slow'] = wasmExports['zend_dval_to_lval_slow'];
  _zval_get_string_func = Module['_zval_get_string_func'] = wasmExports['zval_get_string_func'];
  _get_active_function_or_method_name = Module['_get_active_function_or_method_name'] = wasmExports['get_active_function_or_method_name'];
  _zend_parse_parameters_ex = Module['_zend_parse_parameters_ex'] = wasmExports['zend_parse_parameters_ex'];
  _zend_type_error = Module['_zend_type_error'] = wasmExports['zend_type_error'];
  _zend_error = Module['_zend_error'] = wasmExports['zend_error'];
  _zend_create_internal_iterator_zval = Module['_zend_create_internal_iterator_zval'] = wasmExports['zend_create_internal_iterator_zval'];
  _zend_argument_value_error = Module['_zend_argument_value_error'] = wasmExports['zend_argument_value_error'];
  _add_next_index_string = Module['_add_next_index_string'] = wasmExports['add_next_index_string'];
  _add_assoc_null_ex = Module['_add_assoc_null_ex'] = wasmExports['add_assoc_null_ex'];
  __estrndup = Module['__estrndup'] = wasmExports['_estrndup'];
  _zend_parse_arg_double_slow = Module['_zend_parse_arg_double_slow'] = wasmExports['zend_parse_arg_double_slow'];
  _zend_ini_double = Module['_zend_ini_double'] = wasmExports['zend_ini_double'];
  _zend_strpprintf = Module['_zend_strpprintf'] = wasmExports['zend_strpprintf'];
  _OnUpdateString = Module['_OnUpdateString'] = wasmExports['OnUpdateString'];
  _zend_error_noreturn = Module['_zend_error_noreturn'] = wasmExports['zend_error_noreturn'];
  _zend_object_std_init = Module['_zend_object_std_init'] = wasmExports['zend_object_std_init'];
  _object_properties_init = Module['_object_properties_init'] = wasmExports['object_properties_init'];
  _zend_object_std_dtor = Module['_zend_object_std_dtor'] = wasmExports['zend_object_std_dtor'];
  _zend_objects_clone_members = Module['_zend_objects_clone_members'] = wasmExports['zend_objects_clone_members'];
  _zend_std_compare_objects = Module['_zend_std_compare_objects'] = wasmExports['zend_std_compare_objects'];
  _zend_std_get_properties_for = Module['_zend_std_get_properties_for'] = wasmExports['zend_std_get_properties_for'];
  _zend_array_dup = Module['_zend_array_dup'] = wasmExports['zend_array_dup'];
  _zend_std_has_property = Module['_zend_std_has_property'] = wasmExports['zend_std_has_property'];
  _zend_is_true = Module['_zend_is_true'] = wasmExports['zend_is_true'];
  _zend_std_read_property = Module['_zend_std_read_property'] = wasmExports['zend_std_read_property'];
  _zend_std_write_property = Module['_zend_std_write_property'] = wasmExports['zend_std_write_property'];
  _zend_std_get_property_ptr_ptr = Module['_zend_std_get_property_ptr_ptr'] = wasmExports['zend_std_get_property_ptr_ptr'];
  __emalloc_96 = Module['__emalloc_96'] = wasmExports['_emalloc_96'];
  _zend_iterator_init = Module['_zend_iterator_init'] = wasmExports['zend_iterator_init'];
  _zend_readonly_property_modification_error_ex = Module['_zend_readonly_property_modification_error_ex'] = wasmExports['zend_readonly_property_modification_error_ex'];
  _zend_std_unset_property = Module['_zend_std_unset_property'] = wasmExports['zend_std_unset_property'];
  _zend_lazy_object_get_properties = Module['_zend_lazy_object_get_properties'] = wasmExports['zend_lazy_object_get_properties'];
  _rebuild_object_properties_internal = Module['_rebuild_object_properties_internal'] = wasmExports['rebuild_object_properties_internal'];
  _zend_unmangle_property_name_ex = Module['_zend_unmangle_property_name_ex'] = wasmExports['zend_unmangle_property_name_ex'];
  _zend_lookup_class = Module['_zend_lookup_class'] = wasmExports['zend_lookup_class'];
  _zend_update_property = Module['_zend_update_property'] = wasmExports['zend_update_property'];
  __ecalloc = Module['__ecalloc'] = wasmExports['_ecalloc'];
  __emalloc_8 = Module['__emalloc_8'] = wasmExports['_emalloc_8'];
  _php_pcre2_code_copy = Module['_php_pcre2_code_copy'] = wasmExports['php_pcre2_code_copy'];
  _php_pcre2_code_copy_with_tables = Module['_php_pcre2_code_copy_with_tables'] = wasmExports['php_pcre2_code_copy_with_tables'];
  _php_pcre2_code_free = Module['_php_pcre2_code_free'] = wasmExports['php_pcre2_code_free'];
  _php_pcre2_compile = Module['_php_pcre2_compile'] = wasmExports['php_pcre2_compile'];
  _php_pcre2_config = Module['_php_pcre2_config'] = wasmExports['php_pcre2_config'];
  _malloc = wasmExports['malloc'];
  _php_pcre2_general_context_create = Module['_php_pcre2_general_context_create'] = wasmExports['php_pcre2_general_context_create'];
  _php_pcre2_compile_context_create = Module['_php_pcre2_compile_context_create'] = wasmExports['php_pcre2_compile_context_create'];
  _php_pcre2_match_context_create = Module['_php_pcre2_match_context_create'] = wasmExports['php_pcre2_match_context_create'];
  _php_pcre2_convert_context_create = Module['_php_pcre2_convert_context_create'] = wasmExports['php_pcre2_convert_context_create'];
  _php_pcre2_general_context_copy = Module['_php_pcre2_general_context_copy'] = wasmExports['php_pcre2_general_context_copy'];
  _php_pcre2_compile_context_copy = Module['_php_pcre2_compile_context_copy'] = wasmExports['php_pcre2_compile_context_copy'];
  _php_pcre2_match_context_copy = Module['_php_pcre2_match_context_copy'] = wasmExports['php_pcre2_match_context_copy'];
  _php_pcre2_convert_context_copy = Module['_php_pcre2_convert_context_copy'] = wasmExports['php_pcre2_convert_context_copy'];
  _php_pcre2_general_context_free = Module['_php_pcre2_general_context_free'] = wasmExports['php_pcre2_general_context_free'];
  _php_pcre2_compile_context_free = Module['_php_pcre2_compile_context_free'] = wasmExports['php_pcre2_compile_context_free'];
  _php_pcre2_match_context_free = Module['_php_pcre2_match_context_free'] = wasmExports['php_pcre2_match_context_free'];
  _php_pcre2_convert_context_free = Module['_php_pcre2_convert_context_free'] = wasmExports['php_pcre2_convert_context_free'];
  _php_pcre2_set_character_tables = Module['_php_pcre2_set_character_tables'] = wasmExports['php_pcre2_set_character_tables'];
  _php_pcre2_set_bsr = Module['_php_pcre2_set_bsr'] = wasmExports['php_pcre2_set_bsr'];
  _php_pcre2_set_max_pattern_length = Module['_php_pcre2_set_max_pattern_length'] = wasmExports['php_pcre2_set_max_pattern_length'];
  _pcre2_set_max_pattern_compiled_length_8 = Module['_pcre2_set_max_pattern_compiled_length_8'] = wasmExports['pcre2_set_max_pattern_compiled_length_8'];
  _php_pcre2_set_newline = Module['_php_pcre2_set_newline'] = wasmExports['php_pcre2_set_newline'];
  _pcre2_set_max_varlookbehind_8 = Module['_pcre2_set_max_varlookbehind_8'] = wasmExports['pcre2_set_max_varlookbehind_8'];
  _php_pcre2_set_parens_nest_limit = Module['_php_pcre2_set_parens_nest_limit'] = wasmExports['php_pcre2_set_parens_nest_limit'];
  _php_pcre2_set_compile_extra_options = Module['_php_pcre2_set_compile_extra_options'] = wasmExports['php_pcre2_set_compile_extra_options'];
  _php_pcre2_set_compile_recursion_guard = Module['_php_pcre2_set_compile_recursion_guard'] = wasmExports['php_pcre2_set_compile_recursion_guard'];
  _php_pcre2_set_callout = Module['_php_pcre2_set_callout'] = wasmExports['php_pcre2_set_callout'];
  _pcre2_set_substitute_callout_8 = Module['_pcre2_set_substitute_callout_8'] = wasmExports['pcre2_set_substitute_callout_8'];
  _php_pcre2_set_heap_limit = Module['_php_pcre2_set_heap_limit'] = wasmExports['php_pcre2_set_heap_limit'];
  _php_pcre2_set_match_limit = Module['_php_pcre2_set_match_limit'] = wasmExports['php_pcre2_set_match_limit'];
  _php_pcre2_set_depth_limit = Module['_php_pcre2_set_depth_limit'] = wasmExports['php_pcre2_set_depth_limit'];
  _php_pcre2_set_offset_limit = Module['_php_pcre2_set_offset_limit'] = wasmExports['php_pcre2_set_offset_limit'];
  _php_pcre2_set_recursion_limit = Module['_php_pcre2_set_recursion_limit'] = wasmExports['php_pcre2_set_recursion_limit'];
  _php_pcre2_set_recursion_memory_management = Module['_php_pcre2_set_recursion_memory_management'] = wasmExports['php_pcre2_set_recursion_memory_management'];
  _php_pcre2_set_glob_separator = Module['_php_pcre2_set_glob_separator'] = wasmExports['php_pcre2_set_glob_separator'];
  _php_pcre2_set_glob_escape = Module['_php_pcre2_set_glob_escape'] = wasmExports['php_pcre2_set_glob_escape'];
  _pcre2_pattern_convert_8 = Module['_pcre2_pattern_convert_8'] = wasmExports['pcre2_pattern_convert_8'];
  _pcre2_converted_pattern_free_8 = Module['_pcre2_converted_pattern_free_8'] = wasmExports['pcre2_converted_pattern_free_8'];
  _php_pcre2_dfa_match = Module['_php_pcre2_dfa_match'] = wasmExports['php_pcre2_dfa_match'];
  _php_pcre2_get_error_message = Module['_php_pcre2_get_error_message'] = wasmExports['php_pcre2_get_error_message'];
  _php_pcre2_jit_compile = Module['_php_pcre2_jit_compile'] = wasmExports['php_pcre2_jit_compile'];
  _php_pcre2_jit_match = Module['_php_pcre2_jit_match'] = wasmExports['php_pcre2_jit_match'];
  _php_pcre2_jit_free_unused_memory = Module['_php_pcre2_jit_free_unused_memory'] = wasmExports['php_pcre2_jit_free_unused_memory'];
  _php_pcre2_jit_stack_create = Module['_php_pcre2_jit_stack_create'] = wasmExports['php_pcre2_jit_stack_create'];
  _php_pcre2_jit_stack_assign = Module['_php_pcre2_jit_stack_assign'] = wasmExports['php_pcre2_jit_stack_assign'];
  _php_pcre2_jit_stack_free = Module['_php_pcre2_jit_stack_free'] = wasmExports['php_pcre2_jit_stack_free'];
  _php_pcre2_maketables = Module['_php_pcre2_maketables'] = wasmExports['php_pcre2_maketables'];
  _pcre2_maketables_free_8 = Module['_pcre2_maketables_free_8'] = wasmExports['pcre2_maketables_free_8'];
  _php_pcre2_match_data_create = Module['_php_pcre2_match_data_create'] = wasmExports['php_pcre2_match_data_create'];
  _php_pcre2_match_data_create_from_pattern = Module['_php_pcre2_match_data_create_from_pattern'] = wasmExports['php_pcre2_match_data_create_from_pattern'];
  _php_pcre2_match_data_free = Module['_php_pcre2_match_data_free'] = wasmExports['php_pcre2_match_data_free'];
  _php_pcre2_get_mark = Module['_php_pcre2_get_mark'] = wasmExports['php_pcre2_get_mark'];
  _php_pcre2_get_ovector_pointer = Module['_php_pcre2_get_ovector_pointer'] = wasmExports['php_pcre2_get_ovector_pointer'];
  _php_pcre2_get_ovector_count = Module['_php_pcre2_get_ovector_count'] = wasmExports['php_pcre2_get_ovector_count'];
  _php_pcre2_get_startchar = Module['_php_pcre2_get_startchar'] = wasmExports['php_pcre2_get_startchar'];
  _pcre2_get_match_data_size_8 = Module['_pcre2_get_match_data_size_8'] = wasmExports['pcre2_get_match_data_size_8'];
  _pcre2_get_match_data_heapframes_size_8 = Module['_pcre2_get_match_data_heapframes_size_8'] = wasmExports['pcre2_get_match_data_heapframes_size_8'];
  _php_pcre2_match = Module['_php_pcre2_match'] = wasmExports['php_pcre2_match'];
  _php_pcre2_pattern_info = Module['_php_pcre2_pattern_info'] = wasmExports['php_pcre2_pattern_info'];
  _php_pcre2_callout_enumerate = Module['_php_pcre2_callout_enumerate'] = wasmExports['php_pcre2_callout_enumerate'];
  _php_pcre2_serialize_encode = Module['_php_pcre2_serialize_encode'] = wasmExports['php_pcre2_serialize_encode'];
  _php_pcre2_serialize_decode = Module['_php_pcre2_serialize_decode'] = wasmExports['php_pcre2_serialize_decode'];
  _php_pcre2_serialize_get_number_of_codes = Module['_php_pcre2_serialize_get_number_of_codes'] = wasmExports['php_pcre2_serialize_get_number_of_codes'];
  _php_pcre2_serialize_free = Module['_php_pcre2_serialize_free'] = wasmExports['php_pcre2_serialize_free'];
  _php_pcre2_substitute = Module['_php_pcre2_substitute'] = wasmExports['php_pcre2_substitute'];
  _php_pcre2_substring_nametable_scan = Module['_php_pcre2_substring_nametable_scan'] = wasmExports['php_pcre2_substring_nametable_scan'];
  _php_pcre2_substring_length_bynumber = Module['_php_pcre2_substring_length_bynumber'] = wasmExports['php_pcre2_substring_length_bynumber'];
  _php_pcre2_substring_copy_byname = Module['_php_pcre2_substring_copy_byname'] = wasmExports['php_pcre2_substring_copy_byname'];
  _php_pcre2_substring_copy_bynumber = Module['_php_pcre2_substring_copy_bynumber'] = wasmExports['php_pcre2_substring_copy_bynumber'];
  _php_pcre2_substring_get_byname = Module['_php_pcre2_substring_get_byname'] = wasmExports['php_pcre2_substring_get_byname'];
  _php_pcre2_substring_get_bynumber = Module['_php_pcre2_substring_get_bynumber'] = wasmExports['php_pcre2_substring_get_bynumber'];
  _php_pcre2_substring_free = Module['_php_pcre2_substring_free'] = wasmExports['php_pcre2_substring_free'];
  _php_pcre2_substring_length_byname = Module['_php_pcre2_substring_length_byname'] = wasmExports['php_pcre2_substring_length_byname'];
  _php_pcre2_substring_list_get = Module['_php_pcre2_substring_list_get'] = wasmExports['php_pcre2_substring_list_get'];
  _php_pcre2_substring_list_free = Module['_php_pcre2_substring_list_free'] = wasmExports['php_pcre2_substring_list_free'];
  _php_pcre2_substring_number_from_name = Module['_php_pcre2_substring_number_from_name'] = wasmExports['php_pcre2_substring_number_from_name'];
  _pcre_get_compiled_regex_cache_ex = Module['_pcre_get_compiled_regex_cache_ex'] = wasmExports['pcre_get_compiled_regex_cache_ex'];
  _zend_string_concat2 = Module['_zend_string_concat2'] = wasmExports['zend_string_concat2'];
  _zend_hash_find = Module['_zend_hash_find'] = wasmExports['zend_hash_find'];
  _zend_hash_apply_with_argument = Module['_zend_hash_apply_with_argument'] = wasmExports['zend_hash_apply_with_argument'];
  _zend_hash_add_new = Module['_zend_hash_add_new'] = wasmExports['zend_hash_add_new'];
  _pcre_get_compiled_regex_cache = Module['_pcre_get_compiled_regex_cache'] = wasmExports['pcre_get_compiled_regex_cache'];
  _pcre_get_compiled_regex = Module['_pcre_get_compiled_regex'] = wasmExports['pcre_get_compiled_regex'];
  _php_pcre_create_match_data = Module['_php_pcre_create_match_data'] = wasmExports['php_pcre_create_match_data'];
  _php_pcre_free_match_data = Module['_php_pcre_free_match_data'] = wasmExports['php_pcre_free_match_data'];
  _php_pcre_match_impl = Module['_php_pcre_match_impl'] = wasmExports['php_pcre_match_impl'];
  _zval_ptr_safe_dtor = Module['_zval_ptr_safe_dtor'] = wasmExports['zval_ptr_safe_dtor'];
  _zend_try_assign_typed_ref_arr = Module['_zend_try_assign_typed_ref_arr'] = wasmExports['zend_try_assign_typed_ref_arr'];
  __safe_emalloc = Module['__safe_emalloc'] = wasmExports['_safe_emalloc'];
  _zend_hash_next_index_insert_new = Module['_zend_hash_next_index_insert_new'] = wasmExports['zend_hash_next_index_insert_new'];
  _zend_hash_index_add_new = Module['_zend_hash_index_add_new'] = wasmExports['zend_hash_index_add_new'];
  _zend_hash_update = Module['_zend_hash_update'] = wasmExports['zend_hash_update'];
  _zend_new_pair = Module['_zend_new_pair'] = wasmExports['zend_new_pair'];
  _zend_hash_str_add_new = Module['_zend_hash_str_add_new'] = wasmExports['zend_hash_str_add_new'];
  _zend_flf_parse_arg_str_slow = Module['_zend_flf_parse_arg_str_slow'] = wasmExports['zend_flf_parse_arg_str_slow'];
  _zend_wrong_parameter_type_error = Module['_zend_wrong_parameter_type_error'] = wasmExports['zend_wrong_parameter_type_error'];
  _php_pcre_replace = Module['_php_pcre_replace'] = wasmExports['php_pcre_replace'];
  _php_pcre_replace_impl = Module['_php_pcre_replace_impl'] = wasmExports['php_pcre_replace_impl'];
  _zend_argument_type_error = Module['_zend_argument_type_error'] = wasmExports['zend_argument_type_error'];
  _zend_try_assign_typed_ref_long = Module['_zend_try_assign_typed_ref_long'] = wasmExports['zend_try_assign_typed_ref_long'];
  _zend_fcall_info_init = Module['_zend_fcall_info_init'] = wasmExports['zend_fcall_info_init'];
  _zend_release_fcall_info_cache = Module['_zend_release_fcall_info_cache'] = wasmExports['zend_release_fcall_info_cache'];
  _zval_try_get_string_func = Module['_zval_try_get_string_func'] = wasmExports['zval_try_get_string_func'];
  _zend_is_callable_ex = Module['_zend_is_callable_ex'] = wasmExports['zend_is_callable_ex'];
  _zend_array_destroy = Module['_zend_array_destroy'] = wasmExports['zend_array_destroy'];
  _php_pcre_split_impl = Module['_php_pcre_split_impl'] = wasmExports['php_pcre_split_impl'];
  _php_pcre_grep_impl = Module['_php_pcre_grep_impl'] = wasmExports['php_pcre_grep_impl'];
  _zend_hash_index_update = Module['_zend_hash_index_update'] = wasmExports['zend_hash_index_update'];
  _zend_register_bool_constant = Module['_zend_register_bool_constant'] = wasmExports['zend_register_bool_constant'];
  _php_pcre_mctx = Module['_php_pcre_mctx'] = wasmExports['php_pcre_mctx'];
  _php_pcre_gctx = Module['_php_pcre_gctx'] = wasmExports['php_pcre_gctx'];
  _php_pcre_cctx = Module['_php_pcre_cctx'] = wasmExports['php_pcre_cctx'];
  _php_pcre_pce_incref = Module['_php_pcre_pce_incref'] = wasmExports['php_pcre_pce_incref'];
  _php_pcre_pce_decref = Module['_php_pcre_pce_decref'] = wasmExports['php_pcre_pce_decref'];
  _php_pcre_pce_re = Module['_php_pcre_pce_re'] = wasmExports['php_pcre_pce_re'];
  _zend_call_function = Module['_zend_call_function'] = wasmExports['zend_call_function'];
  _OnUpdateLong = Module['_OnUpdateLong'] = wasmExports['OnUpdateLong'];
  _zend_parse_parameters = Module['_zend_parse_parameters'] = wasmExports['zend_parse_parameters'];
  _zend_value_error = Module['_zend_value_error'] = wasmExports['zend_value_error'];
  _zend_zval_type_name = Module['_zend_zval_type_name'] = wasmExports['zend_zval_type_name'];
  _finfo_objects_new = Module['_finfo_objects_new'] = wasmExports['finfo_objects_new'];
  _php_check_open_basedir = Module['_php_check_open_basedir'] = wasmExports['php_check_open_basedir'];
  _expand_filepath_with_mode = Module['_expand_filepath_with_mode'] = wasmExports['expand_filepath_with_mode'];
  _zend_throw_exception = Module['_zend_throw_exception'] = wasmExports['zend_throw_exception'];
  _zend_argument_must_not_be_empty_error = Module['_zend_argument_must_not_be_empty_error'] = wasmExports['zend_argument_must_not_be_empty_error'];
  _php_le_stream_context = Module['_php_le_stream_context'] = wasmExports['php_le_stream_context'];
  _zend_fetch_resource_ex = Module['_zend_fetch_resource_ex'] = wasmExports['zend_fetch_resource_ex'];
  _php_stream_context_alloc = Module['_php_stream_context_alloc'] = wasmExports['php_stream_context_alloc'];
  _php_stream_locate_url_wrapper = Module['_php_stream_locate_url_wrapper'] = wasmExports['php_stream_locate_url_wrapper'];
  __php_stream_open_wrapper_ex = Module['__php_stream_open_wrapper_ex'] = wasmExports['_php_stream_open_wrapper_ex'];
  __php_stream_stat = Module['__php_stream_stat'] = wasmExports['_php_stream_stat'];
  __php_stream_free = Module['__php_stream_free'] = wasmExports['_php_stream_free'];
  _php_file_le_stream = Module['_php_file_le_stream'] = wasmExports['php_file_le_stream'];
  _php_file_le_pstream = Module['_php_file_le_pstream'] = wasmExports['php_file_le_pstream'];
  _zend_fetch_resource2_ex = Module['_zend_fetch_resource2_ex'] = wasmExports['zend_fetch_resource2_ex'];
  __php_stream_tell = Module['__php_stream_tell'] = wasmExports['_php_stream_tell'];
  __php_stream_seek = Module['__php_stream_seek'] = wasmExports['_php_stream_seek'];
  _zend_zval_value_name = Module['_zend_zval_value_name'] = wasmExports['zend_zval_value_name'];
  __emalloc_160 = Module['__emalloc_160'] = wasmExports['_emalloc_160'];
  __php_stream_write = Module['__php_stream_write'] = wasmExports['_php_stream_write'];
  __php_stream_read = Module['__php_stream_read'] = wasmExports['_php_stream_read'];
  __emalloc_huge = Module['__emalloc_huge'] = wasmExports['_emalloc_huge'];
  __emalloc_24 = Module['__emalloc_24'] = wasmExports['_emalloc_24'];
  __php_stream_opendir = Module['__php_stream_opendir'] = wasmExports['_php_stream_opendir'];
  __php_stream_readdir = Module['__php_stream_readdir'] = wasmExports['_php_stream_readdir'];
  __php_stream_get_line = Module['__php_stream_get_line'] = wasmExports['_php_stream_get_line'];
  __emalloc_large = Module['__emalloc_large'] = wasmExports['_emalloc_large'];
  _zend_vspprintf = Module['_zend_vspprintf'] = wasmExports['zend_vspprintf'];
  __php_stream_cast = Module['__php_stream_cast'] = wasmExports['_php_stream_cast'];
  _zend_str_tolower_dup = Module['_zend_str_tolower_dup'] = wasmExports['zend_str_tolower_dup'];
  _zend_memnstr_ex = Module['_zend_memnstr_ex'] = wasmExports['zend_memnstr_ex'];
  _zend_hash_index_find = Module['_zend_hash_index_find'] = wasmExports['zend_hash_index_find'];
  _sapi_register_input_filter = Module['_sapi_register_input_filter'] = wasmExports['sapi_register_input_filter'];
  __zend_handle_numeric_str_ex = Module['__zend_handle_numeric_str_ex'] = wasmExports['_zend_handle_numeric_str_ex'];
  _php_register_variable_ex = Module['_php_register_variable_ex'] = wasmExports['php_register_variable_ex'];
  _zend_is_auto_global = Module['_zend_is_auto_global'] = wasmExports['zend_is_auto_global'];
  __convert_to_string = Module['__convert_to_string'] = wasmExports['_convert_to_string'];
  _php_strip_tags_ex = Module['_php_strip_tags_ex'] = wasmExports['php_strip_tags_ex'];
  _php_escape_html_entities_ex = Module['_php_escape_html_entities_ex'] = wasmExports['php_escape_html_entities_ex'];
  _php_addslashes = Module['_php_addslashes'] = wasmExports['php_addslashes'];
  _get_active_function_name = Module['_get_active_function_name'] = wasmExports['get_active_function_name'];
  __is_numeric_string_ex = Module['__is_numeric_string_ex'] = wasmExports['_is_numeric_string_ex'];
  _php_uri_get_parser = Module['_php_uri_get_parser'] = wasmExports['php_uri_get_parser'];
  _php_uri_parse_to_struct = Module['_php_uri_parse_to_struct'] = wasmExports['php_uri_parse_to_struct'];
  _zend_binary_strcasecmp = Module['_zend_binary_strcasecmp'] = wasmExports['zend_binary_strcasecmp'];
  _php_uri_struct_free = Module['_php_uri_struct_free'] = wasmExports['php_uri_struct_free'];
  _zend_is_callable = Module['_zend_is_callable'] = wasmExports['zend_is_callable'];
  __call_user_function_impl = Module['__call_user_function_impl'] = wasmExports['_call_user_function_impl'];
  _PHP_ADLER32Init = Module['_PHP_ADLER32Init'] = wasmExports['PHP_ADLER32Init'];
  _PHP_ADLER32Update = Module['_PHP_ADLER32Update'] = wasmExports['PHP_ADLER32Update'];
  _PHP_ADLER32Final = Module['_PHP_ADLER32Final'] = wasmExports['PHP_ADLER32Final'];
  _PHP_ADLER32Copy = Module['_PHP_ADLER32Copy'] = wasmExports['PHP_ADLER32Copy'];
  _php_hash_serialize = Module['_php_hash_serialize'] = wasmExports['php_hash_serialize'];
  _php_hash_unserialize = Module['_php_hash_unserialize'] = wasmExports['php_hash_unserialize'];
  _PHP_CRC32Init = Module['_PHP_CRC32Init'] = wasmExports['PHP_CRC32Init'];
  _PHP_CRC32Update = Module['_PHP_CRC32Update'] = wasmExports['PHP_CRC32Update'];
  _PHP_CRC32BUpdate = Module['_PHP_CRC32BUpdate'] = wasmExports['PHP_CRC32BUpdate'];
  _PHP_CRC32CUpdate = Module['_PHP_CRC32CUpdate'] = wasmExports['PHP_CRC32CUpdate'];
  _PHP_CRC32LEFinal = Module['_PHP_CRC32LEFinal'] = wasmExports['PHP_CRC32LEFinal'];
  _PHP_CRC32BEFinal = Module['_PHP_CRC32BEFinal'] = wasmExports['PHP_CRC32BEFinal'];
  _PHP_CRC32Copy = Module['_PHP_CRC32Copy'] = wasmExports['PHP_CRC32Copy'];
  _PHP_FNV132Init = Module['_PHP_FNV132Init'] = wasmExports['PHP_FNV132Init'];
  _PHP_FNV132Update = Module['_PHP_FNV132Update'] = wasmExports['PHP_FNV132Update'];
  _PHP_FNV132Final = Module['_PHP_FNV132Final'] = wasmExports['PHP_FNV132Final'];
  _PHP_FNV1a32Update = Module['_PHP_FNV1a32Update'] = wasmExports['PHP_FNV1a32Update'];
  _PHP_FNV164Init = Module['_PHP_FNV164Init'] = wasmExports['PHP_FNV164Init'];
  _PHP_FNV164Update = Module['_PHP_FNV164Update'] = wasmExports['PHP_FNV164Update'];
  _PHP_FNV164Final = Module['_PHP_FNV164Final'] = wasmExports['PHP_FNV164Final'];
  _PHP_FNV1a64Update = Module['_PHP_FNV1a64Update'] = wasmExports['PHP_FNV1a64Update'];
  _php_hash_copy = Module['_php_hash_copy'] = wasmExports['php_hash_copy'];
  _PHP_GOSTInit = Module['_PHP_GOSTInit'] = wasmExports['PHP_GOSTInit'];
  _PHP_GOSTInitCrypto = Module['_PHP_GOSTInitCrypto'] = wasmExports['PHP_GOSTInitCrypto'];
  _PHP_GOSTUpdate = Module['_PHP_GOSTUpdate'] = wasmExports['PHP_GOSTUpdate'];
  _PHP_GOSTFinal = Module['_PHP_GOSTFinal'] = wasmExports['PHP_GOSTFinal'];
  _php_hash_unserialize_spec = Module['_php_hash_unserialize_spec'] = wasmExports['php_hash_unserialize_spec'];
  _PHP_3HAVAL128Init = Module['_PHP_3HAVAL128Init'] = wasmExports['PHP_3HAVAL128Init'];
  _PHP_HAVALUpdate = Module['_PHP_HAVALUpdate'] = wasmExports['PHP_HAVALUpdate'];
  _PHP_HAVAL128Final = Module['_PHP_HAVAL128Final'] = wasmExports['PHP_HAVAL128Final'];
  _PHP_3HAVAL160Init = Module['_PHP_3HAVAL160Init'] = wasmExports['PHP_3HAVAL160Init'];
  _PHP_HAVAL160Final = Module['_PHP_HAVAL160Final'] = wasmExports['PHP_HAVAL160Final'];
  _PHP_3HAVAL192Init = Module['_PHP_3HAVAL192Init'] = wasmExports['PHP_3HAVAL192Init'];
  _PHP_HAVAL192Final = Module['_PHP_HAVAL192Final'] = wasmExports['PHP_HAVAL192Final'];
  _PHP_3HAVAL224Init = Module['_PHP_3HAVAL224Init'] = wasmExports['PHP_3HAVAL224Init'];
  _PHP_HAVAL224Final = Module['_PHP_HAVAL224Final'] = wasmExports['PHP_HAVAL224Final'];
  _PHP_3HAVAL256Init = Module['_PHP_3HAVAL256Init'] = wasmExports['PHP_3HAVAL256Init'];
  _PHP_HAVAL256Final = Module['_PHP_HAVAL256Final'] = wasmExports['PHP_HAVAL256Final'];
  _PHP_4HAVAL128Init = Module['_PHP_4HAVAL128Init'] = wasmExports['PHP_4HAVAL128Init'];
  _PHP_4HAVAL160Init = Module['_PHP_4HAVAL160Init'] = wasmExports['PHP_4HAVAL160Init'];
  _PHP_4HAVAL192Init = Module['_PHP_4HAVAL192Init'] = wasmExports['PHP_4HAVAL192Init'];
  _PHP_4HAVAL224Init = Module['_PHP_4HAVAL224Init'] = wasmExports['PHP_4HAVAL224Init'];
  _PHP_4HAVAL256Init = Module['_PHP_4HAVAL256Init'] = wasmExports['PHP_4HAVAL256Init'];
  _PHP_5HAVAL128Init = Module['_PHP_5HAVAL128Init'] = wasmExports['PHP_5HAVAL128Init'];
  _PHP_5HAVAL160Init = Module['_PHP_5HAVAL160Init'] = wasmExports['PHP_5HAVAL160Init'];
  _PHP_5HAVAL192Init = Module['_PHP_5HAVAL192Init'] = wasmExports['PHP_5HAVAL192Init'];
  _PHP_5HAVAL224Init = Module['_PHP_5HAVAL224Init'] = wasmExports['PHP_5HAVAL224Init'];
  _PHP_5HAVAL256Init = Module['_PHP_5HAVAL256Init'] = wasmExports['PHP_5HAVAL256Init'];
  _PHP_JOAATInit = Module['_PHP_JOAATInit'] = wasmExports['PHP_JOAATInit'];
  _PHP_JOAATUpdate = Module['_PHP_JOAATUpdate'] = wasmExports['PHP_JOAATUpdate'];
  _PHP_JOAATFinal = Module['_PHP_JOAATFinal'] = wasmExports['PHP_JOAATFinal'];
  _PHP_MD4InitArgs = Module['_PHP_MD4InitArgs'] = wasmExports['PHP_MD4InitArgs'];
  _PHP_MD4Update = Module['_PHP_MD4Update'] = wasmExports['PHP_MD4Update'];
  _PHP_MD4Final = Module['_PHP_MD4Final'] = wasmExports['PHP_MD4Final'];
  _PHP_MD2InitArgs = Module['_PHP_MD2InitArgs'] = wasmExports['PHP_MD2InitArgs'];
  _PHP_MD2Update = Module['_PHP_MD2Update'] = wasmExports['PHP_MD2Update'];
  _PHP_MD2Final = Module['_PHP_MD2Final'] = wasmExports['PHP_MD2Final'];
  _PHP_MD5InitArgs = Module['_PHP_MD5InitArgs'] = wasmExports['PHP_MD5InitArgs'];
  _PHP_MD5Update = Module['_PHP_MD5Update'] = wasmExports['PHP_MD5Update'];
  _PHP_MD5Final = Module['_PHP_MD5Final'] = wasmExports['PHP_MD5Final'];
  _PHP_MURMUR3AInit = Module['_PHP_MURMUR3AInit'] = wasmExports['PHP_MURMUR3AInit'];
  _PHP_MURMUR3AUpdate = Module['_PHP_MURMUR3AUpdate'] = wasmExports['PHP_MURMUR3AUpdate'];
  _PHP_MURMUR3AFinal = Module['_PHP_MURMUR3AFinal'] = wasmExports['PHP_MURMUR3AFinal'];
  _PHP_MURMUR3ACopy = Module['_PHP_MURMUR3ACopy'] = wasmExports['PHP_MURMUR3ACopy'];
  _PHP_MURMUR3CInit = Module['_PHP_MURMUR3CInit'] = wasmExports['PHP_MURMUR3CInit'];
  _PHP_MURMUR3CUpdate = Module['_PHP_MURMUR3CUpdate'] = wasmExports['PHP_MURMUR3CUpdate'];
  _PHP_MURMUR3CFinal = Module['_PHP_MURMUR3CFinal'] = wasmExports['PHP_MURMUR3CFinal'];
  _PHP_MURMUR3CCopy = Module['_PHP_MURMUR3CCopy'] = wasmExports['PHP_MURMUR3CCopy'];
  _PHP_MURMUR3FInit = Module['_PHP_MURMUR3FInit'] = wasmExports['PHP_MURMUR3FInit'];
  _PHP_MURMUR3FUpdate = Module['_PHP_MURMUR3FUpdate'] = wasmExports['PHP_MURMUR3FUpdate'];
  _PHP_MURMUR3FFinal = Module['_PHP_MURMUR3FFinal'] = wasmExports['PHP_MURMUR3FFinal'];
  _PHP_MURMUR3FCopy = Module['_PHP_MURMUR3FCopy'] = wasmExports['PHP_MURMUR3FCopy'];
  _PHP_RIPEMD128Init = Module['_PHP_RIPEMD128Init'] = wasmExports['PHP_RIPEMD128Init'];
  _PHP_RIPEMD128Update = Module['_PHP_RIPEMD128Update'] = wasmExports['PHP_RIPEMD128Update'];
  _PHP_RIPEMD128Final = Module['_PHP_RIPEMD128Final'] = wasmExports['PHP_RIPEMD128Final'];
  _PHP_RIPEMD160Init = Module['_PHP_RIPEMD160Init'] = wasmExports['PHP_RIPEMD160Init'];
  _PHP_RIPEMD160Update = Module['_PHP_RIPEMD160Update'] = wasmExports['PHP_RIPEMD160Update'];
  _PHP_RIPEMD160Final = Module['_PHP_RIPEMD160Final'] = wasmExports['PHP_RIPEMD160Final'];
  _PHP_RIPEMD256Init = Module['_PHP_RIPEMD256Init'] = wasmExports['PHP_RIPEMD256Init'];
  _PHP_RIPEMD256Update = Module['_PHP_RIPEMD256Update'] = wasmExports['PHP_RIPEMD256Update'];
  _PHP_RIPEMD256Final = Module['_PHP_RIPEMD256Final'] = wasmExports['PHP_RIPEMD256Final'];
  _PHP_RIPEMD320Init = Module['_PHP_RIPEMD320Init'] = wasmExports['PHP_RIPEMD320Init'];
  _PHP_RIPEMD320Update = Module['_PHP_RIPEMD320Update'] = wasmExports['PHP_RIPEMD320Update'];
  _PHP_RIPEMD320Final = Module['_PHP_RIPEMD320Final'] = wasmExports['PHP_RIPEMD320Final'];
  _PHP_SHA256InitArgs = Module['_PHP_SHA256InitArgs'] = wasmExports['PHP_SHA256InitArgs'];
  _PHP_SHA256Update = Module['_PHP_SHA256Update'] = wasmExports['PHP_SHA256Update'];
  _PHP_SHA256Final = Module['_PHP_SHA256Final'] = wasmExports['PHP_SHA256Final'];
  _PHP_SHA224InitArgs = Module['_PHP_SHA224InitArgs'] = wasmExports['PHP_SHA224InitArgs'];
  _PHP_SHA224Update = Module['_PHP_SHA224Update'] = wasmExports['PHP_SHA224Update'];
  _PHP_SHA224Final = Module['_PHP_SHA224Final'] = wasmExports['PHP_SHA224Final'];
  _PHP_SHA384InitArgs = Module['_PHP_SHA384InitArgs'] = wasmExports['PHP_SHA384InitArgs'];
  _PHP_SHA384Update = Module['_PHP_SHA384Update'] = wasmExports['PHP_SHA384Update'];
  _PHP_SHA384Final = Module['_PHP_SHA384Final'] = wasmExports['PHP_SHA384Final'];
  _PHP_SHA512InitArgs = Module['_PHP_SHA512InitArgs'] = wasmExports['PHP_SHA512InitArgs'];
  _PHP_SHA512_256InitArgs = Module['_PHP_SHA512_256InitArgs'] = wasmExports['PHP_SHA512_256InitArgs'];
  _PHP_SHA512_224InitArgs = Module['_PHP_SHA512_224InitArgs'] = wasmExports['PHP_SHA512_224InitArgs'];
  _PHP_SHA512Update = Module['_PHP_SHA512Update'] = wasmExports['PHP_SHA512Update'];
  _PHP_SHA512Final = Module['_PHP_SHA512Final'] = wasmExports['PHP_SHA512Final'];
  _PHP_SHA512_256Final = Module['_PHP_SHA512_256Final'] = wasmExports['PHP_SHA512_256Final'];
  _PHP_SHA512_224Final = Module['_PHP_SHA512_224Final'] = wasmExports['PHP_SHA512_224Final'];
  _PHP_SHA1InitArgs = Module['_PHP_SHA1InitArgs'] = wasmExports['PHP_SHA1InitArgs'];
  _PHP_SHA1Update = Module['_PHP_SHA1Update'] = wasmExports['PHP_SHA1Update'];
  _PHP_SHA1Final = Module['_PHP_SHA1Final'] = wasmExports['PHP_SHA1Final'];
  _PHP_SHA3224Init = Module['_PHP_SHA3224Init'] = wasmExports['PHP_SHA3224Init'];
  _PHP_SHA3224Update = Module['_PHP_SHA3224Update'] = wasmExports['PHP_SHA3224Update'];
  _php_hash_serialize_spec = Module['_php_hash_serialize_spec'] = wasmExports['php_hash_serialize_spec'];
  _PHP_SHA3256Init = Module['_PHP_SHA3256Init'] = wasmExports['PHP_SHA3256Init'];
  _PHP_SHA3256Update = Module['_PHP_SHA3256Update'] = wasmExports['PHP_SHA3256Update'];
  _PHP_SHA3384Init = Module['_PHP_SHA3384Init'] = wasmExports['PHP_SHA3384Init'];
  _PHP_SHA3384Update = Module['_PHP_SHA3384Update'] = wasmExports['PHP_SHA3384Update'];
  _PHP_SHA3512Init = Module['_PHP_SHA3512Init'] = wasmExports['PHP_SHA3512Init'];
  _PHP_SHA3512Update = Module['_PHP_SHA3512Update'] = wasmExports['PHP_SHA3512Update'];
  _PHP_SNEFRUInit = Module['_PHP_SNEFRUInit'] = wasmExports['PHP_SNEFRUInit'];
  _PHP_SNEFRUUpdate = Module['_PHP_SNEFRUUpdate'] = wasmExports['PHP_SNEFRUUpdate'];
  _PHP_SNEFRUFinal = Module['_PHP_SNEFRUFinal'] = wasmExports['PHP_SNEFRUFinal'];
  _PHP_3TIGERInit = Module['_PHP_3TIGERInit'] = wasmExports['PHP_3TIGERInit'];
  _PHP_4TIGERInit = Module['_PHP_4TIGERInit'] = wasmExports['PHP_4TIGERInit'];
  _PHP_TIGERUpdate = Module['_PHP_TIGERUpdate'] = wasmExports['PHP_TIGERUpdate'];
  _PHP_TIGER128Final = Module['_PHP_TIGER128Final'] = wasmExports['PHP_TIGER128Final'];
  _PHP_TIGER160Final = Module['_PHP_TIGER160Final'] = wasmExports['PHP_TIGER160Final'];
  _PHP_TIGER192Final = Module['_PHP_TIGER192Final'] = wasmExports['PHP_TIGER192Final'];
  _PHP_WHIRLPOOLInit = Module['_PHP_WHIRLPOOLInit'] = wasmExports['PHP_WHIRLPOOLInit'];
  _PHP_WHIRLPOOLUpdate = Module['_PHP_WHIRLPOOLUpdate'] = wasmExports['PHP_WHIRLPOOLUpdate'];
  _PHP_WHIRLPOOLFinal = Module['_PHP_WHIRLPOOLFinal'] = wasmExports['PHP_WHIRLPOOLFinal'];
  _PHP_XXH32Init = Module['_PHP_XXH32Init'] = wasmExports['PHP_XXH32Init'];
  _PHP_XXH32Update = Module['_PHP_XXH32Update'] = wasmExports['PHP_XXH32Update'];
  _PHP_XXH32Final = Module['_PHP_XXH32Final'] = wasmExports['PHP_XXH32Final'];
  _PHP_XXH32Copy = Module['_PHP_XXH32Copy'] = wasmExports['PHP_XXH32Copy'];
  _PHP_XXH64Init = Module['_PHP_XXH64Init'] = wasmExports['PHP_XXH64Init'];
  _PHP_XXH64Update = Module['_PHP_XXH64Update'] = wasmExports['PHP_XXH64Update'];
  _PHP_XXH64Final = Module['_PHP_XXH64Final'] = wasmExports['PHP_XXH64Final'];
  _PHP_XXH64Copy = Module['_PHP_XXH64Copy'] = wasmExports['PHP_XXH64Copy'];
  _PHP_XXH3_64_Init = Module['_PHP_XXH3_64_Init'] = wasmExports['PHP_XXH3_64_Init'];
  _PHP_XXH3_64_Update = Module['_PHP_XXH3_64_Update'] = wasmExports['PHP_XXH3_64_Update'];
  _PHP_XXH3_64_Final = Module['_PHP_XXH3_64_Final'] = wasmExports['PHP_XXH3_64_Final'];
  _PHP_XXH3_64_Copy = Module['_PHP_XXH3_64_Copy'] = wasmExports['PHP_XXH3_64_Copy'];
  _PHP_XXH3_128_Init = Module['_PHP_XXH3_128_Init'] = wasmExports['PHP_XXH3_128_Init'];
  _PHP_XXH3_128_Update = Module['_PHP_XXH3_128_Update'] = wasmExports['PHP_XXH3_128_Update'];
  _PHP_XXH3_128_Final = Module['_PHP_XXH3_128_Final'] = wasmExports['PHP_XXH3_128_Final'];
  _PHP_XXH3_128_Copy = Module['_PHP_XXH3_128_Copy'] = wasmExports['PHP_XXH3_128_Copy'];
  _php_hash_fetch_ops = Module['_php_hash_fetch_ops'] = wasmExports['php_hash_fetch_ops'];
  _zend_string_tolower_ex = Module['_zend_string_tolower_ex'] = wasmExports['zend_string_tolower_ex'];
  _php_hash_register_algo = Module['_php_hash_register_algo'] = wasmExports['php_hash_register_algo'];
  _add_next_index_str = Module['_add_next_index_str'] = wasmExports['add_next_index_str'];
  _php_safe_bcmp = Module['_php_safe_bcmp'] = wasmExports['php_safe_bcmp'];
  _object_properties_load = Module['_object_properties_load'] = wasmExports['object_properties_load'];
  _php_stream_filter_register_factory = Module['_php_stream_filter_register_factory'] = wasmExports['php_stream_filter_register_factory'];
  _php_output_handler_alias_register = Module['_php_output_handler_alias_register'] = wasmExports['php_output_handler_alias_register'];
  _php_output_handler_conflict_register = Module['_php_output_handler_conflict_register'] = wasmExports['php_output_handler_conflict_register'];
  _php_stream_filter_unregister_factory = Module['_php_stream_filter_unregister_factory'] = wasmExports['php_stream_filter_unregister_factory'];
  _zend_get_constant_str = Module['_zend_get_constant_str'] = wasmExports['zend_get_constant_str'];
  _php_output_handler_create_internal = Module['_php_output_handler_create_internal'] = wasmExports['php_output_handler_create_internal'];
  _php_output_get_level = Module['_php_output_get_level'] = wasmExports['php_output_get_level'];
  _php_output_handler_conflict = Module['_php_output_handler_conflict'] = wasmExports['php_output_handler_conflict'];
  _php_iconv_string = Module['_php_iconv_string'] = wasmExports['php_iconv_string'];
  _libiconv_open = Module['_libiconv_open'] = wasmExports['libiconv_open'];
  _libiconv = Module['_libiconv'] = wasmExports['libiconv'];
  _libiconv_close = Module['_libiconv_close'] = wasmExports['libiconv_close'];
  _php_get_internal_encoding = Module['_php_get_internal_encoding'] = wasmExports['php_get_internal_encoding'];
  _php_base64_encode_ex = Module['_php_base64_encode_ex'] = wasmExports['php_base64_encode_ex'];
  _php_base64_decode_ex = Module['_php_base64_decode_ex'] = wasmExports['php_base64_decode_ex'];
  _php_quot_print_decode = Module['_php_quot_print_decode'] = wasmExports['php_quot_print_decode'];
  _add_next_index_stringl = Module['_add_next_index_stringl'] = wasmExports['add_next_index_stringl'];
  _add_assoc_stringl_ex = Module['_add_assoc_stringl_ex'] = wasmExports['add_assoc_stringl_ex'];
  __emalloc_40 = Module['__emalloc_40'] = wasmExports['_emalloc_40'];
  _zend_alter_ini_entry = Module['_zend_alter_ini_entry'] = wasmExports['zend_alter_ini_entry'];
  _php_get_input_encoding = Module['_php_get_input_encoding'] = wasmExports['php_get_input_encoding'];
  _php_get_output_encoding = Module['_php_get_output_encoding'] = wasmExports['php_get_output_encoding'];
  _php_output_get_status = Module['_php_output_get_status'] = wasmExports['php_output_get_status'];
  _sapi_add_header_ex = Module['_sapi_add_header_ex'] = wasmExports['sapi_add_header_ex'];
  _php_output_handler_hook = Module['_php_output_handler_hook'] = wasmExports['php_output_handler_hook'];
  __php_stream_filter_alloc = Module['__php_stream_filter_alloc'] = wasmExports['_php_stream_filter_alloc'];
  _php_stream_bucket_unlink = Module['_php_stream_bucket_unlink'] = wasmExports['php_stream_bucket_unlink'];
  _php_stream_bucket_delref = Module['_php_stream_bucket_delref'] = wasmExports['php_stream_bucket_delref'];
  _php_stream_bucket_new = Module['_php_stream_bucket_new'] = wasmExports['php_stream_bucket_new'];
  _php_stream_bucket_append = Module['_php_stream_bucket_append'] = wasmExports['php_stream_bucket_append'];
  ___zend_realloc = Module['___zend_realloc'] = wasmExports['__zend_realloc'];
  _zend_gcvt = Module['_zend_gcvt'] = wasmExports['zend_gcvt'];
  _php_next_utf8_char = Module['_php_next_utf8_char'] = wasmExports['php_next_utf8_char'];
  _zend_get_recursion_guard = Module['_zend_get_recursion_guard'] = wasmExports['zend_get_recursion_guard'];
  _zend_call_known_function = Module['_zend_call_known_function'] = wasmExports['zend_call_known_function'];
  _rc_dtor_func = Module['_rc_dtor_func'] = wasmExports['rc_dtor_func'];
  _zend_get_properties_for = Module['_zend_get_properties_for'] = wasmExports['zend_get_properties_for'];
  _zend_read_property_ex = Module['_zend_read_property_ex'] = wasmExports['zend_read_property_ex'];
  _object_init = Module['_object_init'] = wasmExports['object_init'];
  _php_json_parser_error_code = Module['_php_json_parser_error_code'] = wasmExports['php_json_parser_error_code'];
  _php_json_parser_init_ex = Module['_php_json_parser_init_ex'] = wasmExports['php_json_parser_init_ex'];
  _php_json_parser_init = Module['_php_json_parser_init'] = wasmExports['php_json_parser_init'];
  _php_json_parse = Module['_php_json_parse'] = wasmExports['php_json_parse'];
  _zend_strtod = Module['_zend_strtod'] = wasmExports['zend_strtod'];
  _php_json_encode_string = Module['_php_json_encode_string'] = wasmExports['php_json_encode_string'];
  _php_json_encode_ex = Module['_php_json_encode_ex'] = wasmExports['php_json_encode_ex'];
  _php_json_encode = Module['_php_json_encode'] = wasmExports['php_json_encode'];
  _php_json_decode_ex = Module['_php_json_decode_ex'] = wasmExports['php_json_decode_ex'];
  _php_json_validate_ex = Module['_php_json_validate_ex'] = wasmExports['php_json_validate_ex'];
  _lexbor_memory_setup = Module['_lexbor_memory_setup'] = wasmExports['lexbor_memory_setup'];
  _lexbor_array_obj_create = Module['_lexbor_array_obj_create'] = wasmExports['lexbor_array_obj_create'];
  _lexbor_calloc = Module['_lexbor_calloc'] = wasmExports['lexbor_calloc'];
  _lexbor_array_obj_init = Module['_lexbor_array_obj_init'] = wasmExports['lexbor_array_obj_init'];
  _lexbor_malloc = Module['_lexbor_malloc'] = wasmExports['lexbor_malloc'];
  _lexbor_array_obj_clean = Module['_lexbor_array_obj_clean'] = wasmExports['lexbor_array_obj_clean'];
  _lexbor_array_obj_destroy = Module['_lexbor_array_obj_destroy'] = wasmExports['lexbor_array_obj_destroy'];
  _lexbor_free = Module['_lexbor_free'] = wasmExports['lexbor_free'];
  _lexbor_array_obj_expand = Module['_lexbor_array_obj_expand'] = wasmExports['lexbor_array_obj_expand'];
  _lexbor_realloc = Module['_lexbor_realloc'] = wasmExports['lexbor_realloc'];
  _lexbor_array_obj_push = Module['_lexbor_array_obj_push'] = wasmExports['lexbor_array_obj_push'];
  _lexbor_array_obj_push_wo_cls = Module['_lexbor_array_obj_push_wo_cls'] = wasmExports['lexbor_array_obj_push_wo_cls'];
  _lexbor_array_obj_push_n = Module['_lexbor_array_obj_push_n'] = wasmExports['lexbor_array_obj_push_n'];
  _lexbor_array_obj_pop = Module['_lexbor_array_obj_pop'] = wasmExports['lexbor_array_obj_pop'];
  _lexbor_array_obj_delete = Module['_lexbor_array_obj_delete'] = wasmExports['lexbor_array_obj_delete'];
  _lexbor_array_obj_erase_noi = Module['_lexbor_array_obj_erase_noi'] = wasmExports['lexbor_array_obj_erase_noi'];
  _lexbor_array_obj_get_noi = Module['_lexbor_array_obj_get_noi'] = wasmExports['lexbor_array_obj_get_noi'];
  _lexbor_array_obj_length_noi = Module['_lexbor_array_obj_length_noi'] = wasmExports['lexbor_array_obj_length_noi'];
  _lexbor_array_obj_size_noi = Module['_lexbor_array_obj_size_noi'] = wasmExports['lexbor_array_obj_size_noi'];
  _lexbor_array_obj_struct_size_noi = Module['_lexbor_array_obj_struct_size_noi'] = wasmExports['lexbor_array_obj_struct_size_noi'];
  _lexbor_array_obj_last_noi = Module['_lexbor_array_obj_last_noi'] = wasmExports['lexbor_array_obj_last_noi'];
  _lexbor_array_create = Module['_lexbor_array_create'] = wasmExports['lexbor_array_create'];
  _lexbor_array_init = Module['_lexbor_array_init'] = wasmExports['lexbor_array_init'];
  _lexbor_array_clean = Module['_lexbor_array_clean'] = wasmExports['lexbor_array_clean'];
  _lexbor_array_destroy = Module['_lexbor_array_destroy'] = wasmExports['lexbor_array_destroy'];
  _lexbor_array_expand = Module['_lexbor_array_expand'] = wasmExports['lexbor_array_expand'];
  _lexbor_array_push = Module['_lexbor_array_push'] = wasmExports['lexbor_array_push'];
  _lexbor_array_pop = Module['_lexbor_array_pop'] = wasmExports['lexbor_array_pop'];
  _lexbor_array_insert = Module['_lexbor_array_insert'] = wasmExports['lexbor_array_insert'];
  _lexbor_array_set = Module['_lexbor_array_set'] = wasmExports['lexbor_array_set'];
  _lexbor_array_delete = Module['_lexbor_array_delete'] = wasmExports['lexbor_array_delete'];
  _lexbor_array_get_noi = Module['_lexbor_array_get_noi'] = wasmExports['lexbor_array_get_noi'];
  _lexbor_array_length_noi = Module['_lexbor_array_length_noi'] = wasmExports['lexbor_array_length_noi'];
  _lexbor_array_size_noi = Module['_lexbor_array_size_noi'] = wasmExports['lexbor_array_size_noi'];
  _lexbor_avl_create = Module['_lexbor_avl_create'] = wasmExports['lexbor_avl_create'];
  _lexbor_avl_init = Module['_lexbor_avl_init'] = wasmExports['lexbor_avl_init'];
  _lexbor_dobject_create = Module['_lexbor_dobject_create'] = wasmExports['lexbor_dobject_create'];
  _lexbor_dobject_init = Module['_lexbor_dobject_init'] = wasmExports['lexbor_dobject_init'];
  _lexbor_avl_clean = Module['_lexbor_avl_clean'] = wasmExports['lexbor_avl_clean'];
  _lexbor_dobject_clean = Module['_lexbor_dobject_clean'] = wasmExports['lexbor_dobject_clean'];
  _lexbor_avl_destroy = Module['_lexbor_avl_destroy'] = wasmExports['lexbor_avl_destroy'];
  _lexbor_dobject_destroy = Module['_lexbor_dobject_destroy'] = wasmExports['lexbor_dobject_destroy'];
  _lexbor_avl_node_make = Module['_lexbor_avl_node_make'] = wasmExports['lexbor_avl_node_make'];
  _lexbor_dobject_calloc = Module['_lexbor_dobject_calloc'] = wasmExports['lexbor_dobject_calloc'];
  _lexbor_avl_node_clean = Module['_lexbor_avl_node_clean'] = wasmExports['lexbor_avl_node_clean'];
  _lexbor_avl_node_destroy = Module['_lexbor_avl_node_destroy'] = wasmExports['lexbor_avl_node_destroy'];
  _lexbor_dobject_free = Module['_lexbor_dobject_free'] = wasmExports['lexbor_dobject_free'];
  _lexbor_avl_insert = Module['_lexbor_avl_insert'] = wasmExports['lexbor_avl_insert'];
  _lexbor_avl_remove = Module['_lexbor_avl_remove'] = wasmExports['lexbor_avl_remove'];
  _lexbor_avl_remove_by_node = Module['_lexbor_avl_remove_by_node'] = wasmExports['lexbor_avl_remove_by_node'];
  _lexbor_avl_search = Module['_lexbor_avl_search'] = wasmExports['lexbor_avl_search'];
  _lexbor_avl_foreach = Module['_lexbor_avl_foreach'] = wasmExports['lexbor_avl_foreach'];
  _lexbor_avl_foreach_recursion = Module['_lexbor_avl_foreach_recursion'] = wasmExports['lexbor_avl_foreach_recursion'];
  _lexbor_bst_create = Module['_lexbor_bst_create'] = wasmExports['lexbor_bst_create'];
  _lexbor_bst_init = Module['_lexbor_bst_init'] = wasmExports['lexbor_bst_init'];
  _lexbor_bst_clean = Module['_lexbor_bst_clean'] = wasmExports['lexbor_bst_clean'];
  _lexbor_bst_destroy = Module['_lexbor_bst_destroy'] = wasmExports['lexbor_bst_destroy'];
  _lexbor_bst_entry_make = Module['_lexbor_bst_entry_make'] = wasmExports['lexbor_bst_entry_make'];
  _lexbor_bst_insert = Module['_lexbor_bst_insert'] = wasmExports['lexbor_bst_insert'];
  _lexbor_bst_insert_not_exists = Module['_lexbor_bst_insert_not_exists'] = wasmExports['lexbor_bst_insert_not_exists'];
  _lexbor_bst_search = Module['_lexbor_bst_search'] = wasmExports['lexbor_bst_search'];
  _lexbor_bst_search_close = Module['_lexbor_bst_search_close'] = wasmExports['lexbor_bst_search_close'];
  _lexbor_bst_remove = Module['_lexbor_bst_remove'] = wasmExports['lexbor_bst_remove'];
  _lexbor_bst_remove_by_pointer = Module['_lexbor_bst_remove_by_pointer'] = wasmExports['lexbor_bst_remove_by_pointer'];
  _lexbor_bst_remove_close = Module['_lexbor_bst_remove_close'] = wasmExports['lexbor_bst_remove_close'];
  _lexbor_bst_serialize = Module['_lexbor_bst_serialize'] = wasmExports['lexbor_bst_serialize'];
  _lexbor_bst_serialize_entry = Module['_lexbor_bst_serialize_entry'] = wasmExports['lexbor_bst_serialize_entry'];
  _lexbor_conv_int64_to_data = Module['_lexbor_conv_int64_to_data'] = wasmExports['lexbor_conv_int64_to_data'];
  _lexbor_conv_float_to_data = Module['_lexbor_conv_float_to_data'] = wasmExports['lexbor_conv_float_to_data'];
  _lexbor_dtoa = Module['_lexbor_dtoa'] = wasmExports['lexbor_dtoa'];
  _lexbor_conv_long_to_data = Module['_lexbor_conv_long_to_data'] = wasmExports['lexbor_conv_long_to_data'];
  _lexbor_conv_data_to_double = Module['_lexbor_conv_data_to_double'] = wasmExports['lexbor_conv_data_to_double'];
  _lexbor_strtod_internal = Module['_lexbor_strtod_internal'] = wasmExports['lexbor_strtod_internal'];
  _lexbor_conv_data_to_ulong = Module['_lexbor_conv_data_to_ulong'] = wasmExports['lexbor_conv_data_to_ulong'];
  _lexbor_conv_data_to_long = Module['_lexbor_conv_data_to_long'] = wasmExports['lexbor_conv_data_to_long'];
  _lexbor_conv_data_to_uint = Module['_lexbor_conv_data_to_uint'] = wasmExports['lexbor_conv_data_to_uint'];
  _lexbor_conv_dec_to_hex = Module['_lexbor_conv_dec_to_hex'] = wasmExports['lexbor_conv_dec_to_hex'];
  _lexbor_cached_power_dec = Module['_lexbor_cached_power_dec'] = wasmExports['lexbor_cached_power_dec'];
  _lexbor_cached_power_bin = Module['_lexbor_cached_power_bin'] = wasmExports['lexbor_cached_power_bin'];
  _lexbor_mem_create = Module['_lexbor_mem_create'] = wasmExports['lexbor_mem_create'];
  _lexbor_mem_init = Module['_lexbor_mem_init'] = wasmExports['lexbor_mem_init'];
  _lexbor_mem_clean = Module['_lexbor_mem_clean'] = wasmExports['lexbor_mem_clean'];
  _lexbor_mem_destroy = Module['_lexbor_mem_destroy'] = wasmExports['lexbor_mem_destroy'];
  _lexbor_dobject_alloc = Module['_lexbor_dobject_alloc'] = wasmExports['lexbor_dobject_alloc'];
  _lexbor_mem_alloc = Module['_lexbor_mem_alloc'] = wasmExports['lexbor_mem_alloc'];
  _lexbor_dobject_by_absolute_position = Module['_lexbor_dobject_by_absolute_position'] = wasmExports['lexbor_dobject_by_absolute_position'];
  _lexbor_dobject_allocated_noi = Module['_lexbor_dobject_allocated_noi'] = wasmExports['lexbor_dobject_allocated_noi'];
  _lexbor_dobject_cache_length_noi = Module['_lexbor_dobject_cache_length_noi'] = wasmExports['lexbor_dobject_cache_length_noi'];
  _lexbor_hash_make_id = Module['_lexbor_hash_make_id'] = wasmExports['lexbor_hash_make_id'];
  _lexbor_hash_copy = Module['_lexbor_hash_copy'] = wasmExports['lexbor_hash_copy'];
  _lexbor_mraw_alloc = Module['_lexbor_mraw_alloc'] = wasmExports['lexbor_mraw_alloc'];
  _lexbor_hash_make_id_lower = Module['_lexbor_hash_make_id_lower'] = wasmExports['lexbor_hash_make_id_lower'];
  _lexbor_hash_copy_lower = Module['_lexbor_hash_copy_lower'] = wasmExports['lexbor_hash_copy_lower'];
  _lexbor_hash_make_id_upper = Module['_lexbor_hash_make_id_upper'] = wasmExports['lexbor_hash_make_id_upper'];
  _lexbor_hash_copy_upper = Module['_lexbor_hash_copy_upper'] = wasmExports['lexbor_hash_copy_upper'];
  _lexbor_hash_create = Module['_lexbor_hash_create'] = wasmExports['lexbor_hash_create'];
  _lexbor_hash_init = Module['_lexbor_hash_init'] = wasmExports['lexbor_hash_init'];
  _lexbor_mraw_create = Module['_lexbor_mraw_create'] = wasmExports['lexbor_mraw_create'];
  _lexbor_mraw_init = Module['_lexbor_mraw_init'] = wasmExports['lexbor_mraw_init'];
  _lexbor_hash_clean = Module['_lexbor_hash_clean'] = wasmExports['lexbor_hash_clean'];
  _lexbor_mraw_clean = Module['_lexbor_mraw_clean'] = wasmExports['lexbor_mraw_clean'];
  _lexbor_hash_destroy = Module['_lexbor_hash_destroy'] = wasmExports['lexbor_hash_destroy'];
  _lexbor_mraw_destroy = Module['_lexbor_mraw_destroy'] = wasmExports['lexbor_mraw_destroy'];
  _lexbor_hash_insert = Module['_lexbor_hash_insert'] = wasmExports['lexbor_hash_insert'];
  _lexbor_hash_insert_by_entry = Module['_lexbor_hash_insert_by_entry'] = wasmExports['lexbor_hash_insert_by_entry'];
  _lexbor_hash_remove = Module['_lexbor_hash_remove'] = wasmExports['lexbor_hash_remove'];
  _lexbor_mraw_free = Module['_lexbor_mraw_free'] = wasmExports['lexbor_mraw_free'];
  _lexbor_hash_remove_by_hash_id = Module['_lexbor_hash_remove_by_hash_id'] = wasmExports['lexbor_hash_remove_by_hash_id'];
  _lexbor_hash_search = Module['_lexbor_hash_search'] = wasmExports['lexbor_hash_search'];
  _lexbor_hash_search_by_hash_id = Module['_lexbor_hash_search_by_hash_id'] = wasmExports['lexbor_hash_search_by_hash_id'];
  _lexbor_str_data_ncmp = Module['_lexbor_str_data_ncmp'] = wasmExports['lexbor_str_data_ncmp'];
  _lexbor_str_data_nlocmp_right = Module['_lexbor_str_data_nlocmp_right'] = wasmExports['lexbor_str_data_nlocmp_right'];
  _lexbor_str_data_nupcmp_right = Module['_lexbor_str_data_nupcmp_right'] = wasmExports['lexbor_str_data_nupcmp_right'];
  _lexbor_mem_chunk_make = Module['_lexbor_mem_chunk_make'] = wasmExports['lexbor_mem_chunk_make'];
  _lexbor_mem_chunk_destroy = Module['_lexbor_mem_chunk_destroy'] = wasmExports['lexbor_mem_chunk_destroy'];
  _lexbor_mem_chunk_init = Module['_lexbor_mem_chunk_init'] = wasmExports['lexbor_mem_chunk_init'];
  _lexbor_mem_calloc = Module['_lexbor_mem_calloc'] = wasmExports['lexbor_mem_calloc'];
  _lexbor_mem_current_length_noi = Module['_lexbor_mem_current_length_noi'] = wasmExports['lexbor_mem_current_length_noi'];
  _lexbor_mem_current_size_noi = Module['_lexbor_mem_current_size_noi'] = wasmExports['lexbor_mem_current_size_noi'];
  _lexbor_mem_chunk_length_noi = Module['_lexbor_mem_chunk_length_noi'] = wasmExports['lexbor_mem_chunk_length_noi'];
  _lexbor_mem_align_noi = Module['_lexbor_mem_align_noi'] = wasmExports['lexbor_mem_align_noi'];
  _lexbor_mem_align_floor_noi = Module['_lexbor_mem_align_floor_noi'] = wasmExports['lexbor_mem_align_floor_noi'];
  _lexbor_mraw_calloc = Module['_lexbor_mraw_calloc'] = wasmExports['lexbor_mraw_calloc'];
  _lexbor_mraw_realloc = Module['_lexbor_mraw_realloc'] = wasmExports['lexbor_mraw_realloc'];
  _lexbor_mraw_data_size_noi = Module['_lexbor_mraw_data_size_noi'] = wasmExports['lexbor_mraw_data_size_noi'];
  _lexbor_mraw_data_size_set_noi = Module['_lexbor_mraw_data_size_set_noi'] = wasmExports['lexbor_mraw_data_size_set_noi'];
  _lexbor_mraw_dup_noi = Module['_lexbor_mraw_dup_noi'] = wasmExports['lexbor_mraw_dup_noi'];
  _lexbor_plog_init = Module['_lexbor_plog_init'] = wasmExports['lexbor_plog_init'];
  _lexbor_plog_destroy = Module['_lexbor_plog_destroy'] = wasmExports['lexbor_plog_destroy'];
  _lexbor_plog_create_noi = Module['_lexbor_plog_create_noi'] = wasmExports['lexbor_plog_create_noi'];
  _lexbor_plog_clean_noi = Module['_lexbor_plog_clean_noi'] = wasmExports['lexbor_plog_clean_noi'];
  _lexbor_plog_push_noi = Module['_lexbor_plog_push_noi'] = wasmExports['lexbor_plog_push_noi'];
  _lexbor_plog_length_noi = Module['_lexbor_plog_length_noi'] = wasmExports['lexbor_plog_length_noi'];
  _lexbor_printf_size = Module['_lexbor_printf_size'] = wasmExports['lexbor_printf_size'];
  _lexbor_vprintf_size = Module['_lexbor_vprintf_size'] = wasmExports['lexbor_vprintf_size'];
  _lexbor_sprintf = Module['_lexbor_sprintf'] = wasmExports['lexbor_sprintf'];
  _lexbor_vsprintf = Module['_lexbor_vsprintf'] = wasmExports['lexbor_vsprintf'];
  _lexbor_serialize_length_cb = Module['_lexbor_serialize_length_cb'] = wasmExports['lexbor_serialize_length_cb'];
  _lexbor_serialize_copy_cb = Module['_lexbor_serialize_copy_cb'] = wasmExports['lexbor_serialize_copy_cb'];
  _lexbor_shs_entry_get_static = Module['_lexbor_shs_entry_get_static'] = wasmExports['lexbor_shs_entry_get_static'];
  _lexbor_shs_entry_get_lower_static = Module['_lexbor_shs_entry_get_lower_static'] = wasmExports['lexbor_shs_entry_get_lower_static'];
  _lexbor_shs_entry_get_upper_static = Module['_lexbor_shs_entry_get_upper_static'] = wasmExports['lexbor_shs_entry_get_upper_static'];
  _lexbor_str_create = Module['_lexbor_str_create'] = wasmExports['lexbor_str_create'];
  _lexbor_str_init = Module['_lexbor_str_init'] = wasmExports['lexbor_str_init'];
  _lexbor_str_init_append = Module['_lexbor_str_init_append'] = wasmExports['lexbor_str_init_append'];
  _lexbor_str_clean = Module['_lexbor_str_clean'] = wasmExports['lexbor_str_clean'];
  _lexbor_str_clean_all = Module['_lexbor_str_clean_all'] = wasmExports['lexbor_str_clean_all'];
  _lexbor_str_destroy = Module['_lexbor_str_destroy'] = wasmExports['lexbor_str_destroy'];
  _lexbor_str_realloc = Module['_lexbor_str_realloc'] = wasmExports['lexbor_str_realloc'];
  _lexbor_str_check_size = Module['_lexbor_str_check_size'] = wasmExports['lexbor_str_check_size'];
  _lexbor_str_append = Module['_lexbor_str_append'] = wasmExports['lexbor_str_append'];
  _lexbor_str_append_before = Module['_lexbor_str_append_before'] = wasmExports['lexbor_str_append_before'];
  _lexbor_str_append_one = Module['_lexbor_str_append_one'] = wasmExports['lexbor_str_append_one'];
  _lexbor_str_append_lowercase = Module['_lexbor_str_append_lowercase'] = wasmExports['lexbor_str_append_lowercase'];
  _lexbor_str_append_with_rep_null_chars = Module['_lexbor_str_append_with_rep_null_chars'] = wasmExports['lexbor_str_append_with_rep_null_chars'];
  _lexbor_str_copy = Module['_lexbor_str_copy'] = wasmExports['lexbor_str_copy'];
  _lexbor_str_stay_only_whitespace = Module['_lexbor_str_stay_only_whitespace'] = wasmExports['lexbor_str_stay_only_whitespace'];
  _lexbor_str_strip_collapse_whitespace = Module['_lexbor_str_strip_collapse_whitespace'] = wasmExports['lexbor_str_strip_collapse_whitespace'];
  _lexbor_str_crop_whitespace_from_begin = Module['_lexbor_str_crop_whitespace_from_begin'] = wasmExports['lexbor_str_crop_whitespace_from_begin'];
  _lexbor_str_whitespace_from_begin = Module['_lexbor_str_whitespace_from_begin'] = wasmExports['lexbor_str_whitespace_from_begin'];
  _lexbor_str_whitespace_from_end = Module['_lexbor_str_whitespace_from_end'] = wasmExports['lexbor_str_whitespace_from_end'];
  _lexbor_str_data_ncasecmp_first = Module['_lexbor_str_data_ncasecmp_first'] = wasmExports['lexbor_str_data_ncasecmp_first'];
  _lexbor_str_data_ncasecmp_end = Module['_lexbor_str_data_ncasecmp_end'] = wasmExports['lexbor_str_data_ncasecmp_end'];
  _lexbor_str_data_ncasecmp_contain = Module['_lexbor_str_data_ncasecmp_contain'] = wasmExports['lexbor_str_data_ncasecmp_contain'];
  _lexbor_str_data_ncasecmp = Module['_lexbor_str_data_ncasecmp'] = wasmExports['lexbor_str_data_ncasecmp'];
  _lexbor_str_data_casecmp = Module['_lexbor_str_data_casecmp'] = wasmExports['lexbor_str_data_casecmp'];
  _lexbor_str_data_ncmp_end = Module['_lexbor_str_data_ncmp_end'] = wasmExports['lexbor_str_data_ncmp_end'];
  _lexbor_str_data_ncmp_contain = Module['_lexbor_str_data_ncmp_contain'] = wasmExports['lexbor_str_data_ncmp_contain'];
  _lexbor_str_data_cmp = Module['_lexbor_str_data_cmp'] = wasmExports['lexbor_str_data_cmp'];
  _lexbor_str_data_cmp_ws = Module['_lexbor_str_data_cmp_ws'] = wasmExports['lexbor_str_data_cmp_ws'];
  _lexbor_str_data_to_lowercase = Module['_lexbor_str_data_to_lowercase'] = wasmExports['lexbor_str_data_to_lowercase'];
  _lexbor_str_data_to_uppercase = Module['_lexbor_str_data_to_uppercase'] = wasmExports['lexbor_str_data_to_uppercase'];
  _lexbor_str_data_find_lowercase = Module['_lexbor_str_data_find_lowercase'] = wasmExports['lexbor_str_data_find_lowercase'];
  _lexbor_str_data_find_uppercase = Module['_lexbor_str_data_find_uppercase'] = wasmExports['lexbor_str_data_find_uppercase'];
  _lexbor_str_data_noi = Module['_lexbor_str_data_noi'] = wasmExports['lexbor_str_data_noi'];
  _lexbor_str_length_noi = Module['_lexbor_str_length_noi'] = wasmExports['lexbor_str_length_noi'];
  _lexbor_str_size_noi = Module['_lexbor_str_size_noi'] = wasmExports['lexbor_str_size_noi'];
  _lexbor_str_data_set_noi = Module['_lexbor_str_data_set_noi'] = wasmExports['lexbor_str_data_set_noi'];
  _lexbor_str_length_set_noi = Module['_lexbor_str_length_set_noi'] = wasmExports['lexbor_str_length_set_noi'];
  _lxb_css_memory_create = Module['_lxb_css_memory_create'] = wasmExports['lxb_css_memory_create'];
  _lxb_css_memory_init = Module['_lxb_css_memory_init'] = wasmExports['lxb_css_memory_init'];
  _lxb_css_memory_destroy = Module['_lxb_css_memory_destroy'] = wasmExports['lxb_css_memory_destroy'];
  _lxb_css_memory_clean = Module['_lxb_css_memory_clean'] = wasmExports['lxb_css_memory_clean'];
  _lxb_css_memory_ref_inc = Module['_lxb_css_memory_ref_inc'] = wasmExports['lxb_css_memory_ref_inc'];
  _lxb_css_memory_ref_dec = Module['_lxb_css_memory_ref_dec'] = wasmExports['lxb_css_memory_ref_dec'];
  _lxb_css_memory_ref_dec_destroy = Module['_lxb_css_memory_ref_dec_destroy'] = wasmExports['lxb_css_memory_ref_dec_destroy'];
  _lxb_css_make_data = Module['_lxb_css_make_data'] = wasmExports['lxb_css_make_data'];
  _lxb_css_serialize_char_handler = Module['_lxb_css_serialize_char_handler'] = wasmExports['lxb_css_serialize_char_handler'];
  _lxb_css_serialize_str_handler = Module['_lxb_css_serialize_str_handler'] = wasmExports['lxb_css_serialize_str_handler'];
  _lxb_css_log_create = Module['_lxb_css_log_create'] = wasmExports['lxb_css_log_create'];
  _lxb_css_log_init = Module['_lxb_css_log_init'] = wasmExports['lxb_css_log_init'];
  _lxb_css_log_clean = Module['_lxb_css_log_clean'] = wasmExports['lxb_css_log_clean'];
  _lxb_css_log_destroy = Module['_lxb_css_log_destroy'] = wasmExports['lxb_css_log_destroy'];
  _lxb_css_log_append = Module['_lxb_css_log_append'] = wasmExports['lxb_css_log_append'];
  _lxb_css_log_push = Module['_lxb_css_log_push'] = wasmExports['lxb_css_log_push'];
  _lxb_css_log_format = Module['_lxb_css_log_format'] = wasmExports['lxb_css_log_format'];
  _lxb_css_log_not_supported = Module['_lxb_css_log_not_supported'] = wasmExports['lxb_css_log_not_supported'];
  _lxb_css_log_type_by_id = Module['_lxb_css_log_type_by_id'] = wasmExports['lxb_css_log_type_by_id'];
  _lxb_css_log_serialize = Module['_lxb_css_log_serialize'] = wasmExports['lxb_css_log_serialize'];
  _lxb_css_log_message_serialize = Module['_lxb_css_log_message_serialize'] = wasmExports['lxb_css_log_message_serialize'];
  _lxb_css_log_serialize_char = Module['_lxb_css_log_serialize_char'] = wasmExports['lxb_css_log_serialize_char'];
  _lxb_css_log_message_serialize_char = Module['_lxb_css_log_message_serialize_char'] = wasmExports['lxb_css_log_message_serialize_char'];
  _lxb_css_parser_create = Module['_lxb_css_parser_create'] = wasmExports['lxb_css_parser_create'];
  _lxb_css_parser_init = Module['_lxb_css_parser_init'] = wasmExports['lxb_css_parser_init'];
  _lxb_css_syntax_tokenizer_create = Module['_lxb_css_syntax_tokenizer_create'] = wasmExports['lxb_css_syntax_tokenizer_create'];
  _lxb_css_syntax_tokenizer_init = Module['_lxb_css_syntax_tokenizer_init'] = wasmExports['lxb_css_syntax_tokenizer_init'];
  _lxb_css_parser_clean = Module['_lxb_css_parser_clean'] = wasmExports['lxb_css_parser_clean'];
  _lxb_css_syntax_tokenizer_clean = Module['_lxb_css_syntax_tokenizer_clean'] = wasmExports['lxb_css_syntax_tokenizer_clean'];
  _lxb_css_parser_erase = Module['_lxb_css_parser_erase'] = wasmExports['lxb_css_parser_erase'];
  _lxb_css_parser_destroy = Module['_lxb_css_parser_destroy'] = wasmExports['lxb_css_parser_destroy'];
  _lxb_css_syntax_tokenizer_destroy = Module['_lxb_css_syntax_tokenizer_destroy'] = wasmExports['lxb_css_syntax_tokenizer_destroy'];
  _lxb_css_parser_states_push = Module['_lxb_css_parser_states_push'] = wasmExports['lxb_css_parser_states_push'];
  _lxb_css_parser_states_next = Module['_lxb_css_parser_states_next'] = wasmExports['lxb_css_parser_states_next'];
  _lxb_css_parser_types_push = Module['_lxb_css_parser_types_push'] = wasmExports['lxb_css_parser_types_push'];
  _lxb_css_parser_stop = Module['_lxb_css_parser_stop'] = wasmExports['lxb_css_parser_stop'];
  _lxb_css_parser_fail = Module['_lxb_css_parser_fail'] = wasmExports['lxb_css_parser_fail'];
  _lxb_css_parser_unexpected = Module['_lxb_css_parser_unexpected'] = wasmExports['lxb_css_parser_unexpected'];
  _lxb_css_parser_unexpected_status = Module['_lxb_css_parser_unexpected_status'] = wasmExports['lxb_css_parser_unexpected_status'];
  _lxb_css_parser_success = Module['_lxb_css_parser_success'] = wasmExports['lxb_css_parser_success'];
  _lxb_css_state_success = Module['_lxb_css_state_success'] = wasmExports['lxb_css_state_success'];
  _lxb_css_parser_failed = Module['_lxb_css_parser_failed'] = wasmExports['lxb_css_parser_failed'];
  _lxb_css_parser_unexpected_data = Module['_lxb_css_parser_unexpected_data'] = wasmExports['lxb_css_parser_unexpected_data'];
  _lxb_css_syntax_token_error = Module['_lxb_css_syntax_token_error'] = wasmExports['lxb_css_syntax_token_error'];
  _lxb_css_parser_memory_fail = Module['_lxb_css_parser_memory_fail'] = wasmExports['lxb_css_parser_memory_fail'];
  _lxb_css_parser_unexpected_data_status = Module['_lxb_css_parser_unexpected_data_status'] = wasmExports['lxb_css_parser_unexpected_data_status'];
  _lxb_css_selectors_state_pseudo_class_function__undef = Module['_lxb_css_selectors_state_pseudo_class_function__undef'] = wasmExports['lxb_css_selectors_state_pseudo_class_function__undef'];
  _lxb_css_selectors_state_pseudo_class_function_current = Module['_lxb_css_selectors_state_pseudo_class_function_current'] = wasmExports['lxb_css_selectors_state_pseudo_class_function_current'];
  _lxb_css_selectors_state_complex_list = Module['_lxb_css_selectors_state_complex_list'] = wasmExports['lxb_css_selectors_state_complex_list'];
  _lxb_css_selectors_state_pseudo_class_function_dir = Module['_lxb_css_selectors_state_pseudo_class_function_dir'] = wasmExports['lxb_css_selectors_state_pseudo_class_function_dir'];
  _lxb_css_selectors_state_pseudo_class_function_has = Module['_lxb_css_selectors_state_pseudo_class_function_has'] = wasmExports['lxb_css_selectors_state_pseudo_class_function_has'];
  _lxb_css_selectors_state_relative_list = Module['_lxb_css_selectors_state_relative_list'] = wasmExports['lxb_css_selectors_state_relative_list'];
  _lxb_css_selectors_state_pseudo_class_function_is = Module['_lxb_css_selectors_state_pseudo_class_function_is'] = wasmExports['lxb_css_selectors_state_pseudo_class_function_is'];
  _lxb_css_selectors_state_pseudo_class_function_lang = Module['_lxb_css_selectors_state_pseudo_class_function_lang'] = wasmExports['lxb_css_selectors_state_pseudo_class_function_lang'];
  _lxb_css_selectors_state_pseudo_class_function_not = Module['_lxb_css_selectors_state_pseudo_class_function_not'] = wasmExports['lxb_css_selectors_state_pseudo_class_function_not'];
  _lxb_css_selectors_state_pseudo_class_function_nth_child = Module['_lxb_css_selectors_state_pseudo_class_function_nth_child'] = wasmExports['lxb_css_selectors_state_pseudo_class_function_nth_child'];
  _lxb_css_syntax_anb_handler = Module['_lxb_css_syntax_anb_handler'] = wasmExports['lxb_css_syntax_anb_handler'];
  _lxb_css_syntax_parser_token = Module['_lxb_css_syntax_parser_token'] = wasmExports['lxb_css_syntax_parser_token'];
  _lxb_css_syntax_parser_consume = Module['_lxb_css_syntax_parser_consume'] = wasmExports['lxb_css_syntax_parser_consume'];
  _lxb_css_syntax_token_consume = Module['_lxb_css_syntax_token_consume'] = wasmExports['lxb_css_syntax_token_consume'];
  _lxb_css_syntax_parser_components_push = Module['_lxb_css_syntax_parser_components_push'] = wasmExports['lxb_css_syntax_parser_components_push'];
  _lxb_css_selectors_state_pseudo_class_function_nth_col = Module['_lxb_css_selectors_state_pseudo_class_function_nth_col'] = wasmExports['lxb_css_selectors_state_pseudo_class_function_nth_col'];
  _lxb_css_selectors_state_pseudo_class_function_nth_last_child = Module['_lxb_css_selectors_state_pseudo_class_function_nth_last_child'] = wasmExports['lxb_css_selectors_state_pseudo_class_function_nth_last_child'];
  _lxb_css_selectors_state_pseudo_class_function_nth_last_col = Module['_lxb_css_selectors_state_pseudo_class_function_nth_last_col'] = wasmExports['lxb_css_selectors_state_pseudo_class_function_nth_last_col'];
  _lxb_css_selectors_state_pseudo_class_function_nth_last_of_type = Module['_lxb_css_selectors_state_pseudo_class_function_nth_last_of_type'] = wasmExports['lxb_css_selectors_state_pseudo_class_function_nth_last_of_type'];
  _lxb_css_selectors_state_pseudo_class_function_nth_of_type = Module['_lxb_css_selectors_state_pseudo_class_function_nth_of_type'] = wasmExports['lxb_css_selectors_state_pseudo_class_function_nth_of_type'];
  _lxb_css_selectors_state_pseudo_class_function_where = Module['_lxb_css_selectors_state_pseudo_class_function_where'] = wasmExports['lxb_css_selectors_state_pseudo_class_function_where'];
  _lxb_css_selectors_state_pseudo_element_function__undef = Module['_lxb_css_selectors_state_pseudo_element_function__undef'] = wasmExports['lxb_css_selectors_state_pseudo_element_function__undef'];
  _lxb_css_state_failed = Module['_lxb_css_state_failed'] = wasmExports['lxb_css_state_failed'];
  _lxb_css_selector_pseudo_class_by_name = Module['_lxb_css_selector_pseudo_class_by_name'] = wasmExports['lxb_css_selector_pseudo_class_by_name'];
  _lxb_css_selector_pseudo_class_function_by_name = Module['_lxb_css_selector_pseudo_class_function_by_name'] = wasmExports['lxb_css_selector_pseudo_class_function_by_name'];
  _lxb_css_selector_pseudo_class_function_by_id = Module['_lxb_css_selector_pseudo_class_function_by_id'] = wasmExports['lxb_css_selector_pseudo_class_function_by_id'];
  _lxb_css_selector_pseudo_element_by_name = Module['_lxb_css_selector_pseudo_element_by_name'] = wasmExports['lxb_css_selector_pseudo_element_by_name'];
  _lxb_css_selector_pseudo_element_function_by_name = Module['_lxb_css_selector_pseudo_element_function_by_name'] = wasmExports['lxb_css_selector_pseudo_element_function_by_name'];
  _lxb_css_selector_pseudo_element_function_by_id = Module['_lxb_css_selector_pseudo_element_function_by_id'] = wasmExports['lxb_css_selector_pseudo_element_function_by_id'];
  _lxb_css_selector_pseudo_function_by_id = Module['_lxb_css_selector_pseudo_function_by_id'] = wasmExports['lxb_css_selector_pseudo_function_by_id'];
  _lxb_css_selector_pseudo_function_can_empty = Module['_lxb_css_selector_pseudo_function_can_empty'] = wasmExports['lxb_css_selector_pseudo_function_can_empty'];
  _lxb_css_selectors_state_function_end = Module['_lxb_css_selectors_state_function_end'] = wasmExports['lxb_css_selectors_state_function_end'];
  _lxb_css_selectors_state_function_forgiving_relative = Module['_lxb_css_selectors_state_function_forgiving_relative'] = wasmExports['lxb_css_selectors_state_function_forgiving_relative'];
  _lxb_css_selectors_state_function_forgiving = Module['_lxb_css_selectors_state_function_forgiving'] = wasmExports['lxb_css_selectors_state_function_forgiving'];
  _lxb_css_selector_create = Module['_lxb_css_selector_create'] = wasmExports['lxb_css_selector_create'];
  _lxb_css_selector_destroy = Module['_lxb_css_selector_destroy'] = wasmExports['lxb_css_selector_destroy'];
  _lxb_css_selector_destroy_chain = Module['_lxb_css_selector_destroy_chain'] = wasmExports['lxb_css_selector_destroy_chain'];
  _lxb_css_selector_remove = Module['_lxb_css_selector_remove'] = wasmExports['lxb_css_selector_remove'];
  _lxb_css_selector_list_create = Module['_lxb_css_selector_list_create'] = wasmExports['lxb_css_selector_list_create'];
  _lxb_css_selector_list_remove = Module['_lxb_css_selector_list_remove'] = wasmExports['lxb_css_selector_list_remove'];
  _lxb_css_selector_list_selectors_remove = Module['_lxb_css_selector_list_selectors_remove'] = wasmExports['lxb_css_selector_list_selectors_remove'];
  _lxb_css_selector_list_destroy = Module['_lxb_css_selector_list_destroy'] = wasmExports['lxb_css_selector_list_destroy'];
  _lxb_css_selector_list_destroy_chain = Module['_lxb_css_selector_list_destroy_chain'] = wasmExports['lxb_css_selector_list_destroy_chain'];
  _lxb_css_selector_list_destroy_memory = Module['_lxb_css_selector_list_destroy_memory'] = wasmExports['lxb_css_selector_list_destroy_memory'];
  _lxb_css_selector_serialize = Module['_lxb_css_selector_serialize'] = wasmExports['lxb_css_selector_serialize'];
  _lxb_css_selector_serialize_chain = Module['_lxb_css_selector_serialize_chain'] = wasmExports['lxb_css_selector_serialize_chain'];
  _lxb_css_selector_combinator = Module['_lxb_css_selector_combinator'] = wasmExports['lxb_css_selector_combinator'];
  _lxb_css_selector_serialize_chain_char = Module['_lxb_css_selector_serialize_chain_char'] = wasmExports['lxb_css_selector_serialize_chain_char'];
  _lxb_css_selector_serialize_list = Module['_lxb_css_selector_serialize_list'] = wasmExports['lxb_css_selector_serialize_list'];
  _lxb_css_selector_serialize_list_chain = Module['_lxb_css_selector_serialize_list_chain'] = wasmExports['lxb_css_selector_serialize_list_chain'];
  _lxb_css_selector_serialize_list_chain_char = Module['_lxb_css_selector_serialize_list_chain_char'] = wasmExports['lxb_css_selector_serialize_list_chain_char'];
  _lxb_css_selector_serialize_anb_of = Module['_lxb_css_selector_serialize_anb_of'] = wasmExports['lxb_css_selector_serialize_anb_of'];
  _lxb_css_syntax_anb_serialize = Module['_lxb_css_syntax_anb_serialize'] = wasmExports['lxb_css_syntax_anb_serialize'];
  _lxb_css_selector_list_append = Module['_lxb_css_selector_list_append'] = wasmExports['lxb_css_selector_list_append'];
  _lxb_css_selector_append_next = Module['_lxb_css_selector_append_next'] = wasmExports['lxb_css_selector_append_next'];
  _lxb_css_selector_list_append_next = Module['_lxb_css_selector_list_append_next'] = wasmExports['lxb_css_selector_list_append_next'];
  _lxb_css_selectors_create = Module['_lxb_css_selectors_create'] = wasmExports['lxb_css_selectors_create'];
  _lxb_css_selectors_init = Module['_lxb_css_selectors_init'] = wasmExports['lxb_css_selectors_init'];
  _lxb_css_selectors_clean = Module['_lxb_css_selectors_clean'] = wasmExports['lxb_css_selectors_clean'];
  _lxb_css_selectors_destroy = Module['_lxb_css_selectors_destroy'] = wasmExports['lxb_css_selectors_destroy'];
  _lxb_css_selectors_parse = Module['_lxb_css_selectors_parse'] = wasmExports['lxb_css_selectors_parse'];
  _lxb_css_selectors_parse_complex_list = Module['_lxb_css_selectors_parse_complex_list'] = wasmExports['lxb_css_selectors_parse_complex_list'];
  _lxb_css_syntax_parser_run = Module['_lxb_css_syntax_parser_run'] = wasmExports['lxb_css_syntax_parser_run'];
  _lxb_css_selectors_parse_compound_list = Module['_lxb_css_selectors_parse_compound_list'] = wasmExports['lxb_css_selectors_parse_compound_list'];
  _lxb_css_selectors_parse_simple_list = Module['_lxb_css_selectors_parse_simple_list'] = wasmExports['lxb_css_selectors_parse_simple_list'];
  _lxb_css_selectors_parse_relative_list = Module['_lxb_css_selectors_parse_relative_list'] = wasmExports['lxb_css_selectors_parse_relative_list'];
  _lxb_css_selectors_parse_complex = Module['_lxb_css_selectors_parse_complex'] = wasmExports['lxb_css_selectors_parse_complex'];
  _lxb_css_selectors_parse_compound = Module['_lxb_css_selectors_parse_compound'] = wasmExports['lxb_css_selectors_parse_compound'];
  _lxb_css_selectors_parse_simple = Module['_lxb_css_selectors_parse_simple'] = wasmExports['lxb_css_selectors_parse_simple'];
  _lxb_css_selectors_parse_relative = Module['_lxb_css_selectors_parse_relative'] = wasmExports['lxb_css_selectors_parse_relative'];
  _lxb_css_selectors_state_compound_list = Module['_lxb_css_selectors_state_compound_list'] = wasmExports['lxb_css_selectors_state_compound_list'];
  _lxb_css_selectors_state_simple_list = Module['_lxb_css_selectors_state_simple_list'] = wasmExports['lxb_css_selectors_state_simple_list'];
  _lxb_css_selectors_state_complex = Module['_lxb_css_selectors_state_complex'] = wasmExports['lxb_css_selectors_state_complex'];
  _lxb_css_selectors_state_compound = Module['_lxb_css_selectors_state_compound'] = wasmExports['lxb_css_selectors_state_compound'];
  _lxb_css_selectors_state_simple = Module['_lxb_css_selectors_state_simple'] = wasmExports['lxb_css_selectors_state_simple'];
  _lxb_css_selectors_state_relative = Module['_lxb_css_selectors_state_relative'] = wasmExports['lxb_css_selectors_state_relative'];
  _lxb_css_syntax_token = Module['_lxb_css_syntax_token'] = wasmExports['lxb_css_syntax_token'];
  _lxb_css_syntax_token_next = Module['_lxb_css_syntax_token_next'] = wasmExports['lxb_css_syntax_token_next'];
  _lxb_css_syntax_token_string_dup = Module['_lxb_css_syntax_token_string_dup'] = wasmExports['lxb_css_syntax_token_string_dup'];
  _lxb_css_syntax_parser_function_push = Module['_lxb_css_syntax_parser_function_push'] = wasmExports['lxb_css_syntax_parser_function_push'];
  _lxb_css_state_stop = Module['_lxb_css_state_stop'] = wasmExports['lxb_css_state_stop'];
  _lxb_css_syntax_anb_parse = Module['_lxb_css_syntax_anb_parse'] = wasmExports['lxb_css_syntax_anb_parse'];
  _lxb_css_syntax_parser_pipe_push = Module['_lxb_css_syntax_parser_pipe_push'] = wasmExports['lxb_css_syntax_parser_pipe_push'];
  _lxb_css_syntax_anb_serialize_char = Module['_lxb_css_syntax_anb_serialize_char'] = wasmExports['lxb_css_syntax_anb_serialize_char'];
  _lxb_css_syntax_parser_token_wo_ws = Module['_lxb_css_syntax_parser_token_wo_ws'] = wasmExports['lxb_css_syntax_parser_token_wo_ws'];
  _lxb_css_syntax_parser_list_rules_push = Module['_lxb_css_syntax_parser_list_rules_push'] = wasmExports['lxb_css_syntax_parser_list_rules_push'];
  _lxb_css_syntax_stack_expand = Module['_lxb_css_syntax_stack_expand'] = wasmExports['lxb_css_syntax_stack_expand'];
  _lxb_css_syntax_parser_end = Module['_lxb_css_syntax_parser_end'] = wasmExports['lxb_css_syntax_parser_end'];
  _lxb_css_syntax_parser_at_rule_push = Module['_lxb_css_syntax_parser_at_rule_push'] = wasmExports['lxb_css_syntax_parser_at_rule_push'];
  _lxb_css_syntax_parser_start_block = Module['_lxb_css_syntax_parser_start_block'] = wasmExports['lxb_css_syntax_parser_start_block'];
  _lxb_css_syntax_parser_qualified_push = Module['_lxb_css_syntax_parser_qualified_push'] = wasmExports['lxb_css_syntax_parser_qualified_push'];
  _lxb_css_syntax_parser_declarations_push = Module['_lxb_css_syntax_parser_declarations_push'] = wasmExports['lxb_css_syntax_parser_declarations_push'];
  _lxb_css_syntax_tokenizer_lookup_colon = Module['_lxb_css_syntax_tokenizer_lookup_colon'] = wasmExports['lxb_css_syntax_tokenizer_lookup_colon'];
  _lxb_css_syntax_parser_block_push = Module['_lxb_css_syntax_parser_block_push'] = wasmExports['lxb_css_syntax_parser_block_push'];
  _lxb_css_syntax_tokenizer_lookup_declaration_ws_end = Module['_lxb_css_syntax_tokenizer_lookup_declaration_ws_end'] = wasmExports['lxb_css_syntax_tokenizer_lookup_declaration_ws_end'];
  _lxb_css_syntax_tokenizer_lookup_important = Module['_lxb_css_syntax_tokenizer_lookup_important'] = wasmExports['lxb_css_syntax_tokenizer_lookup_important'];
  _lxb_css_syntax_tokenizer_error_add = Module['_lxb_css_syntax_tokenizer_error_add'] = wasmExports['lxb_css_syntax_tokenizer_error_add'];
  _lxb_css_syntax_codepoint_to_ascii = Module['_lxb_css_syntax_codepoint_to_ascii'] = wasmExports['lxb_css_syntax_codepoint_to_ascii'];
  _lxb_css_syntax_parse_list_rules = Module['_lxb_css_syntax_parse_list_rules'] = wasmExports['lxb_css_syntax_parse_list_rules'];
  _lxb_css_syntax_ident_serialize = Module['_lxb_css_syntax_ident_serialize'] = wasmExports['lxb_css_syntax_ident_serialize'];
  _lxb_css_syntax_string_serialize = Module['_lxb_css_syntax_string_serialize'] = wasmExports['lxb_css_syntax_string_serialize'];
  _lxb_css_syntax_ident_or_string_serialize = Module['_lxb_css_syntax_ident_or_string_serialize'] = wasmExports['lxb_css_syntax_ident_or_string_serialize'];
  _lxb_css_syntax_token_string_free = Module['_lxb_css_syntax_token_string_free'] = wasmExports['lxb_css_syntax_token_string_free'];
  _lxb_css_syntax_token_consume_n = Module['_lxb_css_syntax_token_consume_n'] = wasmExports['lxb_css_syntax_token_consume_n'];
  _lxb_css_syntax_token_string_make = Module['_lxb_css_syntax_token_string_make'] = wasmExports['lxb_css_syntax_token_string_make'];
  _lxb_css_syntax_token_type_name_by_id = Module['_lxb_css_syntax_token_type_name_by_id'] = wasmExports['lxb_css_syntax_token_type_name_by_id'];
  _lxb_css_syntax_token_type_id_by_name = Module['_lxb_css_syntax_token_type_id_by_name'] = wasmExports['lxb_css_syntax_token_type_id_by_name'];
  _lxb_css_syntax_token_serialize = Module['_lxb_css_syntax_token_serialize'] = wasmExports['lxb_css_syntax_token_serialize'];
  _lxb_css_syntax_token_serialize_str = Module['_lxb_css_syntax_token_serialize_str'] = wasmExports['lxb_css_syntax_token_serialize_str'];
  _lxb_css_syntax_token_serialize_char = Module['_lxb_css_syntax_token_serialize_char'] = wasmExports['lxb_css_syntax_token_serialize_char'];
  _lxb_css_syntax_token_create_noi = Module['_lxb_css_syntax_token_create_noi'] = wasmExports['lxb_css_syntax_token_create_noi'];
  _lxb_css_syntax_token_clean_noi = Module['_lxb_css_syntax_token_clean_noi'] = wasmExports['lxb_css_syntax_token_clean_noi'];
  _lxb_css_syntax_token_destroy_noi = Module['_lxb_css_syntax_token_destroy_noi'] = wasmExports['lxb_css_syntax_token_destroy_noi'];
  _lxb_css_syntax_token_type_name_noi = Module['_lxb_css_syntax_token_type_name_noi'] = wasmExports['lxb_css_syntax_token_type_name_noi'];
  _lxb_css_syntax_token_type_noi = Module['_lxb_css_syntax_token_type_noi'] = wasmExports['lxb_css_syntax_token_type_noi'];
  _lxb_css_syntax_tokenizer_status_noi = Module['_lxb_css_syntax_tokenizer_status_noi'] = wasmExports['lxb_css_syntax_tokenizer_status_noi'];
  _lxb_dom_interface_create = Module['_lxb_dom_interface_create'] = wasmExports['lxb_dom_interface_create'];
  _lxb_dom_element_interface_create = Module['_lxb_dom_element_interface_create'] = wasmExports['lxb_dom_element_interface_create'];
  _lxb_dom_interface_clone = Module['_lxb_dom_interface_clone'] = wasmExports['lxb_dom_interface_clone'];
  _lxb_dom_element_interface_clone = Module['_lxb_dom_element_interface_clone'] = wasmExports['lxb_dom_element_interface_clone'];
  _lxb_dom_text_interface_clone = Module['_lxb_dom_text_interface_clone'] = wasmExports['lxb_dom_text_interface_clone'];
  _lxb_dom_processing_instruction_interface_clone = Module['_lxb_dom_processing_instruction_interface_clone'] = wasmExports['lxb_dom_processing_instruction_interface_clone'];
  _lxb_dom_comment_interface_clone = Module['_lxb_dom_comment_interface_clone'] = wasmExports['lxb_dom_comment_interface_clone'];
  _lxb_dom_document_interface_clone = Module['_lxb_dom_document_interface_clone'] = wasmExports['lxb_dom_document_interface_clone'];
  _lxb_dom_document_type_interface_clone = Module['_lxb_dom_document_type_interface_clone'] = wasmExports['lxb_dom_document_type_interface_clone'];
  _lxb_dom_node_interface_clone = Module['_lxb_dom_node_interface_clone'] = wasmExports['lxb_dom_node_interface_clone'];
  _lxb_dom_interface_destroy = Module['_lxb_dom_interface_destroy'] = wasmExports['lxb_dom_interface_destroy'];
  _lxb_dom_element_interface_destroy = Module['_lxb_dom_element_interface_destroy'] = wasmExports['lxb_dom_element_interface_destroy'];
  _lxb_dom_text_interface_destroy = Module['_lxb_dom_text_interface_destroy'] = wasmExports['lxb_dom_text_interface_destroy'];
  _lxb_dom_cdata_section_interface_destroy = Module['_lxb_dom_cdata_section_interface_destroy'] = wasmExports['lxb_dom_cdata_section_interface_destroy'];
  _lxb_dom_processing_instruction_interface_destroy = Module['_lxb_dom_processing_instruction_interface_destroy'] = wasmExports['lxb_dom_processing_instruction_interface_destroy'];
  _lxb_dom_comment_interface_destroy = Module['_lxb_dom_comment_interface_destroy'] = wasmExports['lxb_dom_comment_interface_destroy'];
  _lxb_dom_document_interface_destroy = Module['_lxb_dom_document_interface_destroy'] = wasmExports['lxb_dom_document_interface_destroy'];
  _lxb_dom_document_type_interface_destroy = Module['_lxb_dom_document_type_interface_destroy'] = wasmExports['lxb_dom_document_type_interface_destroy'];
  _lxb_dom_document_fragment_interface_destroy = Module['_lxb_dom_document_fragment_interface_destroy'] = wasmExports['lxb_dom_document_fragment_interface_destroy'];
  _lxb_dom_attr_interface_create = Module['_lxb_dom_attr_interface_create'] = wasmExports['lxb_dom_attr_interface_create'];
  _lxb_dom_attr_interface_clone = Module['_lxb_dom_attr_interface_clone'] = wasmExports['lxb_dom_attr_interface_clone'];
  _lxb_dom_node_interface_copy = Module['_lxb_dom_node_interface_copy'] = wasmExports['lxb_dom_node_interface_copy'];
  _lxb_dom_node_interface_destroy = Module['_lxb_dom_node_interface_destroy'] = wasmExports['lxb_dom_node_interface_destroy'];
  _lxb_dom_attr_data_by_id = Module['_lxb_dom_attr_data_by_id'] = wasmExports['lxb_dom_attr_data_by_id'];
  _lxb_dom_attr_qualified_name_append = Module['_lxb_dom_attr_qualified_name_append'] = wasmExports['lxb_dom_attr_qualified_name_append'];
  _lxb_dom_attr_interface_destroy = Module['_lxb_dom_attr_interface_destroy'] = wasmExports['lxb_dom_attr_interface_destroy'];
  _lxb_dom_attr_set_name = Module['_lxb_dom_attr_set_name'] = wasmExports['lxb_dom_attr_set_name'];
  _lxb_dom_attr_local_name_append = Module['_lxb_dom_attr_local_name_append'] = wasmExports['lxb_dom_attr_local_name_append'];
  _lxb_ns_append = Module['_lxb_ns_append'] = wasmExports['lxb_ns_append'];
  _lxb_ns_prefix_append = Module['_lxb_ns_prefix_append'] = wasmExports['lxb_ns_prefix_append'];
  _lxb_dom_attr_set_value = Module['_lxb_dom_attr_set_value'] = wasmExports['lxb_dom_attr_set_value'];
  _lxb_dom_attr_set_value_wo_copy = Module['_lxb_dom_attr_set_value_wo_copy'] = wasmExports['lxb_dom_attr_set_value_wo_copy'];
  _lxb_dom_attr_set_existing_value = Module['_lxb_dom_attr_set_existing_value'] = wasmExports['lxb_dom_attr_set_existing_value'];
  _lxb_dom_attr_clone_name_value = Module['_lxb_dom_attr_clone_name_value'] = wasmExports['lxb_dom_attr_clone_name_value'];
  _lxb_dom_attr_compare = Module['_lxb_dom_attr_compare'] = wasmExports['lxb_dom_attr_compare'];
  _lxb_dom_attr_remove = Module['_lxb_dom_attr_remove'] = wasmExports['lxb_dom_attr_remove'];
  _lxb_dom_attr_data_undef = Module['_lxb_dom_attr_data_undef'] = wasmExports['lxb_dom_attr_data_undef'];
  _lxb_dom_attr_data_by_local_name = Module['_lxb_dom_attr_data_by_local_name'] = wasmExports['lxb_dom_attr_data_by_local_name'];
  _lxb_dom_attr_data_by_qualified_name = Module['_lxb_dom_attr_data_by_qualified_name'] = wasmExports['lxb_dom_attr_data_by_qualified_name'];
  _lxb_dom_attr_qualified_name = Module['_lxb_dom_attr_qualified_name'] = wasmExports['lxb_dom_attr_qualified_name'];
  _lxb_dom_attr_local_name_noi = Module['_lxb_dom_attr_local_name_noi'] = wasmExports['lxb_dom_attr_local_name_noi'];
  _lxb_dom_attr_value_noi = Module['_lxb_dom_attr_value_noi'] = wasmExports['lxb_dom_attr_value_noi'];
  _lxb_dom_cdata_section_interface_create = Module['_lxb_dom_cdata_section_interface_create'] = wasmExports['lxb_dom_cdata_section_interface_create'];
  _lxb_dom_cdata_section_interface_clone = Module['_lxb_dom_cdata_section_interface_clone'] = wasmExports['lxb_dom_cdata_section_interface_clone'];
  _lxb_dom_text_interface_copy = Module['_lxb_dom_text_interface_copy'] = wasmExports['lxb_dom_text_interface_copy'];
  _lxb_dom_character_data_interface_create = Module['_lxb_dom_character_data_interface_create'] = wasmExports['lxb_dom_character_data_interface_create'];
  _lxb_dom_character_data_interface_clone = Module['_lxb_dom_character_data_interface_clone'] = wasmExports['lxb_dom_character_data_interface_clone'];
  _lxb_dom_character_data_interface_copy = Module['_lxb_dom_character_data_interface_copy'] = wasmExports['lxb_dom_character_data_interface_copy'];
  _lxb_dom_character_data_interface_destroy = Module['_lxb_dom_character_data_interface_destroy'] = wasmExports['lxb_dom_character_data_interface_destroy'];
  _lxb_dom_character_data_replace = Module['_lxb_dom_character_data_replace'] = wasmExports['lxb_dom_character_data_replace'];
  _lxb_dom_comment_interface_create = Module['_lxb_dom_comment_interface_create'] = wasmExports['lxb_dom_comment_interface_create'];
  _lxb_dom_comment_interface_copy = Module['_lxb_dom_comment_interface_copy'] = wasmExports['lxb_dom_comment_interface_copy'];
  _lxb_dom_document_fragment_interface_create = Module['_lxb_dom_document_fragment_interface_create'] = wasmExports['lxb_dom_document_fragment_interface_create'];
  _lxb_dom_document_type_interface_create = Module['_lxb_dom_document_type_interface_create'] = wasmExports['lxb_dom_document_type_interface_create'];
  _lxb_dom_document_type_name_noi = Module['_lxb_dom_document_type_name_noi'] = wasmExports['lxb_dom_document_type_name_noi'];
  _lxb_dom_document_type_public_id_noi = Module['_lxb_dom_document_type_public_id_noi'] = wasmExports['lxb_dom_document_type_public_id_noi'];
  _lxb_dom_document_type_system_id_noi = Module['_lxb_dom_document_type_system_id_noi'] = wasmExports['lxb_dom_document_type_system_id_noi'];
  _lxb_dom_document_interface_create = Module['_lxb_dom_document_interface_create'] = wasmExports['lxb_dom_document_interface_create'];
  _lxb_dom_document_init = Module['_lxb_dom_document_init'] = wasmExports['lxb_dom_document_init'];
  _lxb_dom_document_create = Module['_lxb_dom_document_create'] = wasmExports['lxb_dom_document_create'];
  _lxb_dom_document_clean = Module['_lxb_dom_document_clean'] = wasmExports['lxb_dom_document_clean'];
  _lxb_dom_document_destroy = Module['_lxb_dom_document_destroy'] = wasmExports['lxb_dom_document_destroy'];
  _lxb_dom_document_attach_doctype = Module['_lxb_dom_document_attach_doctype'] = wasmExports['lxb_dom_document_attach_doctype'];
  _lxb_dom_document_attach_element = Module['_lxb_dom_document_attach_element'] = wasmExports['lxb_dom_document_attach_element'];
  _lxb_dom_document_create_element = Module['_lxb_dom_document_create_element'] = wasmExports['lxb_dom_document_create_element'];
  _lxb_dom_element_create = Module['_lxb_dom_element_create'] = wasmExports['lxb_dom_element_create'];
  _lxb_dom_document_destroy_element = Module['_lxb_dom_document_destroy_element'] = wasmExports['lxb_dom_document_destroy_element'];
  _lxb_dom_element_destroy = Module['_lxb_dom_element_destroy'] = wasmExports['lxb_dom_element_destroy'];
  _lxb_dom_document_create_document_fragment = Module['_lxb_dom_document_create_document_fragment'] = wasmExports['lxb_dom_document_create_document_fragment'];
  _lxb_dom_document_create_text_node = Module['_lxb_dom_document_create_text_node'] = wasmExports['lxb_dom_document_create_text_node'];
  _lxb_dom_document_create_cdata_section = Module['_lxb_dom_document_create_cdata_section'] = wasmExports['lxb_dom_document_create_cdata_section'];
  _lxb_dom_document_create_processing_instruction = Module['_lxb_dom_document_create_processing_instruction'] = wasmExports['lxb_dom_document_create_processing_instruction'];
  _lxb_dom_processing_instruction_interface_create = Module['_lxb_dom_processing_instruction_interface_create'] = wasmExports['lxb_dom_processing_instruction_interface_create'];
  _lxb_dom_document_create_comment = Module['_lxb_dom_document_create_comment'] = wasmExports['lxb_dom_document_create_comment'];
  _lxb_dom_document_root = Module['_lxb_dom_document_root'] = wasmExports['lxb_dom_document_root'];
  _lxb_dom_document_import_node = Module['_lxb_dom_document_import_node'] = wasmExports['lxb_dom_document_import_node'];
  _lxb_dom_node_insert_child = Module['_lxb_dom_node_insert_child'] = wasmExports['lxb_dom_node_insert_child'];
  _lxb_dom_document_set_default_node_cb = Module['_lxb_dom_document_set_default_node_cb'] = wasmExports['lxb_dom_document_set_default_node_cb'];
  _lxb_dom_document_create_interface_noi = Module['_lxb_dom_document_create_interface_noi'] = wasmExports['lxb_dom_document_create_interface_noi'];
  _lxb_dom_document_destroy_interface_noi = Module['_lxb_dom_document_destroy_interface_noi'] = wasmExports['lxb_dom_document_destroy_interface_noi'];
  _lxb_dom_document_create_struct_noi = Module['_lxb_dom_document_create_struct_noi'] = wasmExports['lxb_dom_document_create_struct_noi'];
  _lxb_dom_document_destroy_struct_noi = Module['_lxb_dom_document_destroy_struct_noi'] = wasmExports['lxb_dom_document_destroy_struct_noi'];
  _lxb_dom_document_create_text_noi = Module['_lxb_dom_document_create_text_noi'] = wasmExports['lxb_dom_document_create_text_noi'];
  _lxb_dom_document_destroy_text_noi = Module['_lxb_dom_document_destroy_text_noi'] = wasmExports['lxb_dom_document_destroy_text_noi'];
  _lxb_dom_document_element_noi = Module['_lxb_dom_document_element_noi'] = wasmExports['lxb_dom_document_element_noi'];
  _lxb_dom_document_scripting_noi = Module['_lxb_dom_document_scripting_noi'] = wasmExports['lxb_dom_document_scripting_noi'];
  _lxb_dom_document_scripting_set_noi = Module['_lxb_dom_document_scripting_set_noi'] = wasmExports['lxb_dom_document_scripting_set_noi'];
  _lxb_dom_element_attr_append = Module['_lxb_dom_element_attr_append'] = wasmExports['lxb_dom_element_attr_append'];
  _lxb_dom_element_interface_copy = Module['_lxb_dom_element_interface_copy'] = wasmExports['lxb_dom_element_interface_copy'];
  _lxb_dom_element_qualified_name_set = Module['_lxb_dom_element_qualified_name_set'] = wasmExports['lxb_dom_element_qualified_name_set'];
  _lxb_tag_append = Module['_lxb_tag_append'] = wasmExports['lxb_tag_append'];
  _lxb_tag_append_lower = Module['_lxb_tag_append_lower'] = wasmExports['lxb_tag_append_lower'];
  _lxb_ns_data_by_id = Module['_lxb_ns_data_by_id'] = wasmExports['lxb_ns_data_by_id'];
  _lxb_dom_element_is_set = Module['_lxb_dom_element_is_set'] = wasmExports['lxb_dom_element_is_set'];
  _lxb_dom_element_has_attributes = Module['_lxb_dom_element_has_attributes'] = wasmExports['lxb_dom_element_has_attributes'];
  _lxb_dom_element_set_attribute = Module['_lxb_dom_element_set_attribute'] = wasmExports['lxb_dom_element_set_attribute'];
  _lxb_dom_element_attr_is_exist = Module['_lxb_dom_element_attr_is_exist'] = wasmExports['lxb_dom_element_attr_is_exist'];
  _lxb_dom_element_get_attribute = Module['_lxb_dom_element_get_attribute'] = wasmExports['lxb_dom_element_get_attribute'];
  _lxb_dom_element_attr_by_name = Module['_lxb_dom_element_attr_by_name'] = wasmExports['lxb_dom_element_attr_by_name'];
  _lxb_dom_element_remove_attribute = Module['_lxb_dom_element_remove_attribute'] = wasmExports['lxb_dom_element_remove_attribute'];
  _lxb_dom_element_attr_remove = Module['_lxb_dom_element_attr_remove'] = wasmExports['lxb_dom_element_attr_remove'];
  _lxb_dom_element_has_attribute = Module['_lxb_dom_element_has_attribute'] = wasmExports['lxb_dom_element_has_attribute'];
  _lxb_dom_element_attr_by_local_name_data = Module['_lxb_dom_element_attr_by_local_name_data'] = wasmExports['lxb_dom_element_attr_by_local_name_data'];
  _lxb_dom_element_attr_by_id = Module['_lxb_dom_element_attr_by_id'] = wasmExports['lxb_dom_element_attr_by_id'];
  _lxb_dom_element_compare = Module['_lxb_dom_element_compare'] = wasmExports['lxb_dom_element_compare'];
  _lxb_dom_elements_by_tag_name = Module['_lxb_dom_elements_by_tag_name'] = wasmExports['lxb_dom_elements_by_tag_name'];
  _lxb_dom_node_by_tag_name = Module['_lxb_dom_node_by_tag_name'] = wasmExports['lxb_dom_node_by_tag_name'];
  _lxb_dom_elements_by_class_name = Module['_lxb_dom_elements_by_class_name'] = wasmExports['lxb_dom_elements_by_class_name'];
  _lxb_dom_node_by_class_name = Module['_lxb_dom_node_by_class_name'] = wasmExports['lxb_dom_node_by_class_name'];
  _lxb_dom_elements_by_attr = Module['_lxb_dom_elements_by_attr'] = wasmExports['lxb_dom_elements_by_attr'];
  _lxb_dom_node_by_attr = Module['_lxb_dom_node_by_attr'] = wasmExports['lxb_dom_node_by_attr'];
  _lxb_dom_elements_by_attr_begin = Module['_lxb_dom_elements_by_attr_begin'] = wasmExports['lxb_dom_elements_by_attr_begin'];
  _lxb_dom_node_by_attr_begin = Module['_lxb_dom_node_by_attr_begin'] = wasmExports['lxb_dom_node_by_attr_begin'];
  _lxb_dom_elements_by_attr_end = Module['_lxb_dom_elements_by_attr_end'] = wasmExports['lxb_dom_elements_by_attr_end'];
  _lxb_dom_node_by_attr_end = Module['_lxb_dom_node_by_attr_end'] = wasmExports['lxb_dom_node_by_attr_end'];
  _lxb_dom_elements_by_attr_contain = Module['_lxb_dom_elements_by_attr_contain'] = wasmExports['lxb_dom_elements_by_attr_contain'];
  _lxb_dom_node_by_attr_contain = Module['_lxb_dom_node_by_attr_contain'] = wasmExports['lxb_dom_node_by_attr_contain'];
  _lxb_dom_element_qualified_name = Module['_lxb_dom_element_qualified_name'] = wasmExports['lxb_dom_element_qualified_name'];
  _lxb_tag_data_by_id = Module['_lxb_tag_data_by_id'] = wasmExports['lxb_tag_data_by_id'];
  _lxb_dom_element_qualified_name_upper = Module['_lxb_dom_element_qualified_name_upper'] = wasmExports['lxb_dom_element_qualified_name_upper'];
  _lxb_dom_element_local_name = Module['_lxb_dom_element_local_name'] = wasmExports['lxb_dom_element_local_name'];
  _lxb_dom_element_prefix = Module['_lxb_dom_element_prefix'] = wasmExports['lxb_dom_element_prefix'];
  _lxb_ns_prefix_data_by_id = Module['_lxb_ns_prefix_data_by_id'] = wasmExports['lxb_ns_prefix_data_by_id'];
  _lxb_dom_element_tag_name = Module['_lxb_dom_element_tag_name'] = wasmExports['lxb_dom_element_tag_name'];
  _lxb_dom_element_id_noi = Module['_lxb_dom_element_id_noi'] = wasmExports['lxb_dom_element_id_noi'];
  _lxb_dom_element_class_noi = Module['_lxb_dom_element_class_noi'] = wasmExports['lxb_dom_element_class_noi'];
  _lxb_dom_element_is_custom_noi = Module['_lxb_dom_element_is_custom_noi'] = wasmExports['lxb_dom_element_is_custom_noi'];
  _lxb_dom_element_custom_is_defined_noi = Module['_lxb_dom_element_custom_is_defined_noi'] = wasmExports['lxb_dom_element_custom_is_defined_noi'];
  _lxb_dom_element_first_attribute_noi = Module['_lxb_dom_element_first_attribute_noi'] = wasmExports['lxb_dom_element_first_attribute_noi'];
  _lxb_dom_element_next_attribute_noi = Module['_lxb_dom_element_next_attribute_noi'] = wasmExports['lxb_dom_element_next_attribute_noi'];
  _lxb_dom_element_prev_attribute_noi = Module['_lxb_dom_element_prev_attribute_noi'] = wasmExports['lxb_dom_element_prev_attribute_noi'];
  _lxb_dom_element_last_attribute_noi = Module['_lxb_dom_element_last_attribute_noi'] = wasmExports['lxb_dom_element_last_attribute_noi'];
  _lxb_dom_element_id_attribute_noi = Module['_lxb_dom_element_id_attribute_noi'] = wasmExports['lxb_dom_element_id_attribute_noi'];
  _lxb_dom_element_class_attribute_noi = Module['_lxb_dom_element_class_attribute_noi'] = wasmExports['lxb_dom_element_class_attribute_noi'];
  _lxb_dom_node_interface_create = Module['_lxb_dom_node_interface_create'] = wasmExports['lxb_dom_node_interface_create'];
  _lxb_dom_node_destroy = Module['_lxb_dom_node_destroy'] = wasmExports['lxb_dom_node_destroy'];
  _lxb_dom_node_remove = Module['_lxb_dom_node_remove'] = wasmExports['lxb_dom_node_remove'];
  _lxb_dom_node_destroy_deep = Module['_lxb_dom_node_destroy_deep'] = wasmExports['lxb_dom_node_destroy_deep'];
  _lxb_dom_node_clone = Module['_lxb_dom_node_clone'] = wasmExports['lxb_dom_node_clone'];
  _lxb_dom_node_name = Module['_lxb_dom_node_name'] = wasmExports['lxb_dom_node_name'];
  _lxb_dom_node_insert_child_wo_events = Module['_lxb_dom_node_insert_child_wo_events'] = wasmExports['lxb_dom_node_insert_child_wo_events'];
  _lxb_dom_node_insert_before_wo_events = Module['_lxb_dom_node_insert_before_wo_events'] = wasmExports['lxb_dom_node_insert_before_wo_events'];
  _lxb_dom_node_insert_before = Module['_lxb_dom_node_insert_before'] = wasmExports['lxb_dom_node_insert_before'];
  _lxb_dom_node_insert_after_wo_events = Module['_lxb_dom_node_insert_after_wo_events'] = wasmExports['lxb_dom_node_insert_after_wo_events'];
  _lxb_dom_node_insert_after = Module['_lxb_dom_node_insert_after'] = wasmExports['lxb_dom_node_insert_after'];
  _lxb_dom_node_remove_wo_events = Module['_lxb_dom_node_remove_wo_events'] = wasmExports['lxb_dom_node_remove_wo_events'];
  _lxb_dom_node_replace_all = Module['_lxb_dom_node_replace_all'] = wasmExports['lxb_dom_node_replace_all'];
  _lxb_dom_node_simple_walk = Module['_lxb_dom_node_simple_walk'] = wasmExports['lxb_dom_node_simple_walk'];
  _lxb_ns_prefix_data_by_name = Module['_lxb_ns_prefix_data_by_name'] = wasmExports['lxb_ns_prefix_data_by_name'];
  _lxb_tag_data_by_name = Module['_lxb_tag_data_by_name'] = wasmExports['lxb_tag_data_by_name'];
  _lxb_dom_node_text_content = Module['_lxb_dom_node_text_content'] = wasmExports['lxb_dom_node_text_content'];
  _lxb_dom_node_text_content_set = Module['_lxb_dom_node_text_content_set'] = wasmExports['lxb_dom_node_text_content_set'];
  _lxb_dom_node_is_empty = Module['_lxb_dom_node_is_empty'] = wasmExports['lxb_dom_node_is_empty'];
  _lxb_dom_node_tag_id_noi = Module['_lxb_dom_node_tag_id_noi'] = wasmExports['lxb_dom_node_tag_id_noi'];
  _lxb_dom_node_next_noi = Module['_lxb_dom_node_next_noi'] = wasmExports['lxb_dom_node_next_noi'];
  _lxb_dom_node_prev_noi = Module['_lxb_dom_node_prev_noi'] = wasmExports['lxb_dom_node_prev_noi'];
  _lxb_dom_node_parent_noi = Module['_lxb_dom_node_parent_noi'] = wasmExports['lxb_dom_node_parent_noi'];
  _lxb_dom_node_first_child_noi = Module['_lxb_dom_node_first_child_noi'] = wasmExports['lxb_dom_node_first_child_noi'];
  _lxb_dom_node_last_child_noi = Module['_lxb_dom_node_last_child_noi'] = wasmExports['lxb_dom_node_last_child_noi'];
  _lxb_dom_processing_instruction_copy = Module['_lxb_dom_processing_instruction_copy'] = wasmExports['lxb_dom_processing_instruction_copy'];
  _lxb_dom_processing_instruction_target_noi = Module['_lxb_dom_processing_instruction_target_noi'] = wasmExports['lxb_dom_processing_instruction_target_noi'];
  _lxb_dom_shadow_root_interface_create = Module['_lxb_dom_shadow_root_interface_create'] = wasmExports['lxb_dom_shadow_root_interface_create'];
  _lxb_dom_shadow_root_interface_destroy = Module['_lxb_dom_shadow_root_interface_destroy'] = wasmExports['lxb_dom_shadow_root_interface_destroy'];
  _lxb_dom_text_interface_create = Module['_lxb_dom_text_interface_create'] = wasmExports['lxb_dom_text_interface_create'];
  _lxb_encoding_decode_default = Module['_lxb_encoding_decode_default'] = wasmExports['lxb_encoding_decode_default'];
  _lxb_encoding_decode_utf_8 = Module['_lxb_encoding_decode_utf_8'] = wasmExports['lxb_encoding_decode_utf_8'];
  _lxb_encoding_decode_auto = Module['_lxb_encoding_decode_auto'] = wasmExports['lxb_encoding_decode_auto'];
  _lxb_encoding_decode_undefined = Module['_lxb_encoding_decode_undefined'] = wasmExports['lxb_encoding_decode_undefined'];
  _lxb_encoding_decode_big5 = Module['_lxb_encoding_decode_big5'] = wasmExports['lxb_encoding_decode_big5'];
  _lxb_encoding_decode_euc_jp = Module['_lxb_encoding_decode_euc_jp'] = wasmExports['lxb_encoding_decode_euc_jp'];
  _lxb_encoding_decode_euc_kr = Module['_lxb_encoding_decode_euc_kr'] = wasmExports['lxb_encoding_decode_euc_kr'];
  _lxb_encoding_decode_gbk = Module['_lxb_encoding_decode_gbk'] = wasmExports['lxb_encoding_decode_gbk'];
  _lxb_encoding_decode_gb18030 = Module['_lxb_encoding_decode_gb18030'] = wasmExports['lxb_encoding_decode_gb18030'];
  _lxb_encoding_decode_ibm866 = Module['_lxb_encoding_decode_ibm866'] = wasmExports['lxb_encoding_decode_ibm866'];
  _lxb_encoding_decode_iso_2022_jp = Module['_lxb_encoding_decode_iso_2022_jp'] = wasmExports['lxb_encoding_decode_iso_2022_jp'];
  _lxb_encoding_decode_iso_8859_10 = Module['_lxb_encoding_decode_iso_8859_10'] = wasmExports['lxb_encoding_decode_iso_8859_10'];
  _lxb_encoding_decode_iso_8859_13 = Module['_lxb_encoding_decode_iso_8859_13'] = wasmExports['lxb_encoding_decode_iso_8859_13'];
  _lxb_encoding_decode_iso_8859_14 = Module['_lxb_encoding_decode_iso_8859_14'] = wasmExports['lxb_encoding_decode_iso_8859_14'];
  _lxb_encoding_decode_iso_8859_15 = Module['_lxb_encoding_decode_iso_8859_15'] = wasmExports['lxb_encoding_decode_iso_8859_15'];
  _lxb_encoding_decode_iso_8859_16 = Module['_lxb_encoding_decode_iso_8859_16'] = wasmExports['lxb_encoding_decode_iso_8859_16'];
  _lxb_encoding_decode_iso_8859_2 = Module['_lxb_encoding_decode_iso_8859_2'] = wasmExports['lxb_encoding_decode_iso_8859_2'];
  _lxb_encoding_decode_iso_8859_3 = Module['_lxb_encoding_decode_iso_8859_3'] = wasmExports['lxb_encoding_decode_iso_8859_3'];
  _lxb_encoding_decode_iso_8859_4 = Module['_lxb_encoding_decode_iso_8859_4'] = wasmExports['lxb_encoding_decode_iso_8859_4'];
  _lxb_encoding_decode_iso_8859_5 = Module['_lxb_encoding_decode_iso_8859_5'] = wasmExports['lxb_encoding_decode_iso_8859_5'];
  _lxb_encoding_decode_iso_8859_6 = Module['_lxb_encoding_decode_iso_8859_6'] = wasmExports['lxb_encoding_decode_iso_8859_6'];
  _lxb_encoding_decode_iso_8859_7 = Module['_lxb_encoding_decode_iso_8859_7'] = wasmExports['lxb_encoding_decode_iso_8859_7'];
  _lxb_encoding_decode_iso_8859_8 = Module['_lxb_encoding_decode_iso_8859_8'] = wasmExports['lxb_encoding_decode_iso_8859_8'];
  _lxb_encoding_decode_iso_8859_8_i = Module['_lxb_encoding_decode_iso_8859_8_i'] = wasmExports['lxb_encoding_decode_iso_8859_8_i'];
  _lxb_encoding_decode_koi8_r = Module['_lxb_encoding_decode_koi8_r'] = wasmExports['lxb_encoding_decode_koi8_r'];
  _lxb_encoding_decode_koi8_u = Module['_lxb_encoding_decode_koi8_u'] = wasmExports['lxb_encoding_decode_koi8_u'];
  _lxb_encoding_decode_shift_jis = Module['_lxb_encoding_decode_shift_jis'] = wasmExports['lxb_encoding_decode_shift_jis'];
  _lxb_encoding_decode_utf_16be = Module['_lxb_encoding_decode_utf_16be'] = wasmExports['lxb_encoding_decode_utf_16be'];
  _lxb_encoding_decode_utf_16le = Module['_lxb_encoding_decode_utf_16le'] = wasmExports['lxb_encoding_decode_utf_16le'];
  _lxb_encoding_decode_macintosh = Module['_lxb_encoding_decode_macintosh'] = wasmExports['lxb_encoding_decode_macintosh'];
  _lxb_encoding_decode_replacement = Module['_lxb_encoding_decode_replacement'] = wasmExports['lxb_encoding_decode_replacement'];
  _lxb_encoding_decode_windows_1250 = Module['_lxb_encoding_decode_windows_1250'] = wasmExports['lxb_encoding_decode_windows_1250'];
  _lxb_encoding_decode_windows_1251 = Module['_lxb_encoding_decode_windows_1251'] = wasmExports['lxb_encoding_decode_windows_1251'];
  _lxb_encoding_decode_windows_1252 = Module['_lxb_encoding_decode_windows_1252'] = wasmExports['lxb_encoding_decode_windows_1252'];
  _lxb_encoding_decode_windows_1253 = Module['_lxb_encoding_decode_windows_1253'] = wasmExports['lxb_encoding_decode_windows_1253'];
  _lxb_encoding_decode_windows_1254 = Module['_lxb_encoding_decode_windows_1254'] = wasmExports['lxb_encoding_decode_windows_1254'];
  _lxb_encoding_decode_windows_1255 = Module['_lxb_encoding_decode_windows_1255'] = wasmExports['lxb_encoding_decode_windows_1255'];
  _lxb_encoding_decode_windows_1256 = Module['_lxb_encoding_decode_windows_1256'] = wasmExports['lxb_encoding_decode_windows_1256'];
  _lxb_encoding_decode_windows_1257 = Module['_lxb_encoding_decode_windows_1257'] = wasmExports['lxb_encoding_decode_windows_1257'];
  _lxb_encoding_decode_windows_1258 = Module['_lxb_encoding_decode_windows_1258'] = wasmExports['lxb_encoding_decode_windows_1258'];
  _lxb_encoding_decode_windows_874 = Module['_lxb_encoding_decode_windows_874'] = wasmExports['lxb_encoding_decode_windows_874'];
  _lxb_encoding_decode_x_mac_cyrillic = Module['_lxb_encoding_decode_x_mac_cyrillic'] = wasmExports['lxb_encoding_decode_x_mac_cyrillic'];
  _lxb_encoding_decode_x_user_defined = Module['_lxb_encoding_decode_x_user_defined'] = wasmExports['lxb_encoding_decode_x_user_defined'];
  _lxb_encoding_decode_default_single = Module['_lxb_encoding_decode_default_single'] = wasmExports['lxb_encoding_decode_default_single'];
  _lxb_encoding_decode_utf_8_single = Module['_lxb_encoding_decode_utf_8_single'] = wasmExports['lxb_encoding_decode_utf_8_single'];
  _lxb_encoding_decode_auto_single = Module['_lxb_encoding_decode_auto_single'] = wasmExports['lxb_encoding_decode_auto_single'];
  _lxb_encoding_decode_undefined_single = Module['_lxb_encoding_decode_undefined_single'] = wasmExports['lxb_encoding_decode_undefined_single'];
  _lxb_encoding_decode_big5_single = Module['_lxb_encoding_decode_big5_single'] = wasmExports['lxb_encoding_decode_big5_single'];
  _lxb_encoding_decode_euc_jp_single = Module['_lxb_encoding_decode_euc_jp_single'] = wasmExports['lxb_encoding_decode_euc_jp_single'];
  _lxb_encoding_decode_euc_kr_single = Module['_lxb_encoding_decode_euc_kr_single'] = wasmExports['lxb_encoding_decode_euc_kr_single'];
  _lxb_encoding_decode_gbk_single = Module['_lxb_encoding_decode_gbk_single'] = wasmExports['lxb_encoding_decode_gbk_single'];
  _lxb_encoding_decode_gb18030_single = Module['_lxb_encoding_decode_gb18030_single'] = wasmExports['lxb_encoding_decode_gb18030_single'];
  _lxb_encoding_decode_ibm866_single = Module['_lxb_encoding_decode_ibm866_single'] = wasmExports['lxb_encoding_decode_ibm866_single'];
  _lxb_encoding_decode_iso_2022_jp_single = Module['_lxb_encoding_decode_iso_2022_jp_single'] = wasmExports['lxb_encoding_decode_iso_2022_jp_single'];
  _lxb_encoding_decode_iso_8859_10_single = Module['_lxb_encoding_decode_iso_8859_10_single'] = wasmExports['lxb_encoding_decode_iso_8859_10_single'];
  _lxb_encoding_decode_iso_8859_13_single = Module['_lxb_encoding_decode_iso_8859_13_single'] = wasmExports['lxb_encoding_decode_iso_8859_13_single'];
  _lxb_encoding_decode_iso_8859_14_single = Module['_lxb_encoding_decode_iso_8859_14_single'] = wasmExports['lxb_encoding_decode_iso_8859_14_single'];
  _lxb_encoding_decode_iso_8859_15_single = Module['_lxb_encoding_decode_iso_8859_15_single'] = wasmExports['lxb_encoding_decode_iso_8859_15_single'];
  _lxb_encoding_decode_iso_8859_16_single = Module['_lxb_encoding_decode_iso_8859_16_single'] = wasmExports['lxb_encoding_decode_iso_8859_16_single'];
  _lxb_encoding_decode_iso_8859_2_single = Module['_lxb_encoding_decode_iso_8859_2_single'] = wasmExports['lxb_encoding_decode_iso_8859_2_single'];
  _lxb_encoding_decode_iso_8859_3_single = Module['_lxb_encoding_decode_iso_8859_3_single'] = wasmExports['lxb_encoding_decode_iso_8859_3_single'];
  _lxb_encoding_decode_iso_8859_4_single = Module['_lxb_encoding_decode_iso_8859_4_single'] = wasmExports['lxb_encoding_decode_iso_8859_4_single'];
  _lxb_encoding_decode_iso_8859_5_single = Module['_lxb_encoding_decode_iso_8859_5_single'] = wasmExports['lxb_encoding_decode_iso_8859_5_single'];
  _lxb_encoding_decode_iso_8859_6_single = Module['_lxb_encoding_decode_iso_8859_6_single'] = wasmExports['lxb_encoding_decode_iso_8859_6_single'];
  _lxb_encoding_decode_iso_8859_7_single = Module['_lxb_encoding_decode_iso_8859_7_single'] = wasmExports['lxb_encoding_decode_iso_8859_7_single'];
  _lxb_encoding_decode_iso_8859_8_single = Module['_lxb_encoding_decode_iso_8859_8_single'] = wasmExports['lxb_encoding_decode_iso_8859_8_single'];
  _lxb_encoding_decode_iso_8859_8_i_single = Module['_lxb_encoding_decode_iso_8859_8_i_single'] = wasmExports['lxb_encoding_decode_iso_8859_8_i_single'];
  _lxb_encoding_decode_koi8_r_single = Module['_lxb_encoding_decode_koi8_r_single'] = wasmExports['lxb_encoding_decode_koi8_r_single'];
  _lxb_encoding_decode_koi8_u_single = Module['_lxb_encoding_decode_koi8_u_single'] = wasmExports['lxb_encoding_decode_koi8_u_single'];
  _lxb_encoding_decode_shift_jis_single = Module['_lxb_encoding_decode_shift_jis_single'] = wasmExports['lxb_encoding_decode_shift_jis_single'];
  _lxb_encoding_decode_utf_16be_single = Module['_lxb_encoding_decode_utf_16be_single'] = wasmExports['lxb_encoding_decode_utf_16be_single'];
  _lxb_encoding_decode_utf_16le_single = Module['_lxb_encoding_decode_utf_16le_single'] = wasmExports['lxb_encoding_decode_utf_16le_single'];
  _lxb_encoding_decode_valid_utf_8_single = Module['_lxb_encoding_decode_valid_utf_8_single'] = wasmExports['lxb_encoding_decode_valid_utf_8_single'];
  _lxb_encoding_decode_valid_utf_8_single_reverse = Module['_lxb_encoding_decode_valid_utf_8_single_reverse'] = wasmExports['lxb_encoding_decode_valid_utf_8_single_reverse'];
  _lxb_encoding_decode_utf_8_length = Module['_lxb_encoding_decode_utf_8_length'] = wasmExports['lxb_encoding_decode_utf_8_length'];
  _lxb_encoding_decode_macintosh_single = Module['_lxb_encoding_decode_macintosh_single'] = wasmExports['lxb_encoding_decode_macintosh_single'];
  _lxb_encoding_decode_replacement_single = Module['_lxb_encoding_decode_replacement_single'] = wasmExports['lxb_encoding_decode_replacement_single'];
  _lxb_encoding_decode_windows_1250_single = Module['_lxb_encoding_decode_windows_1250_single'] = wasmExports['lxb_encoding_decode_windows_1250_single'];
  _lxb_encoding_decode_windows_1251_single = Module['_lxb_encoding_decode_windows_1251_single'] = wasmExports['lxb_encoding_decode_windows_1251_single'];
  _lxb_encoding_decode_windows_1252_single = Module['_lxb_encoding_decode_windows_1252_single'] = wasmExports['lxb_encoding_decode_windows_1252_single'];
  _lxb_encoding_decode_windows_1253_single = Module['_lxb_encoding_decode_windows_1253_single'] = wasmExports['lxb_encoding_decode_windows_1253_single'];
  _lxb_encoding_decode_windows_1254_single = Module['_lxb_encoding_decode_windows_1254_single'] = wasmExports['lxb_encoding_decode_windows_1254_single'];
  _lxb_encoding_decode_windows_1255_single = Module['_lxb_encoding_decode_windows_1255_single'] = wasmExports['lxb_encoding_decode_windows_1255_single'];
  _lxb_encoding_decode_windows_1256_single = Module['_lxb_encoding_decode_windows_1256_single'] = wasmExports['lxb_encoding_decode_windows_1256_single'];
  _lxb_encoding_decode_windows_1257_single = Module['_lxb_encoding_decode_windows_1257_single'] = wasmExports['lxb_encoding_decode_windows_1257_single'];
  _lxb_encoding_decode_windows_1258_single = Module['_lxb_encoding_decode_windows_1258_single'] = wasmExports['lxb_encoding_decode_windows_1258_single'];
  _lxb_encoding_decode_windows_874_single = Module['_lxb_encoding_decode_windows_874_single'] = wasmExports['lxb_encoding_decode_windows_874_single'];
  _lxb_encoding_decode_x_mac_cyrillic_single = Module['_lxb_encoding_decode_x_mac_cyrillic_single'] = wasmExports['lxb_encoding_decode_x_mac_cyrillic_single'];
  _lxb_encoding_decode_x_user_defined_single = Module['_lxb_encoding_decode_x_user_defined_single'] = wasmExports['lxb_encoding_decode_x_user_defined_single'];
  _lxb_encoding_encode_default = Module['_lxb_encoding_encode_default'] = wasmExports['lxb_encoding_encode_default'];
  _lxb_encoding_encode_utf_8 = Module['_lxb_encoding_encode_utf_8'] = wasmExports['lxb_encoding_encode_utf_8'];
  _lxb_encoding_encode_auto = Module['_lxb_encoding_encode_auto'] = wasmExports['lxb_encoding_encode_auto'];
  _lxb_encoding_encode_undefined = Module['_lxb_encoding_encode_undefined'] = wasmExports['lxb_encoding_encode_undefined'];
  _lxb_encoding_encode_big5 = Module['_lxb_encoding_encode_big5'] = wasmExports['lxb_encoding_encode_big5'];
  _lxb_encoding_encode_euc_jp = Module['_lxb_encoding_encode_euc_jp'] = wasmExports['lxb_encoding_encode_euc_jp'];
  _lxb_encoding_encode_euc_kr = Module['_lxb_encoding_encode_euc_kr'] = wasmExports['lxb_encoding_encode_euc_kr'];
  _lxb_encoding_encode_gbk = Module['_lxb_encoding_encode_gbk'] = wasmExports['lxb_encoding_encode_gbk'];
  _lxb_encoding_encode_ibm866 = Module['_lxb_encoding_encode_ibm866'] = wasmExports['lxb_encoding_encode_ibm866'];
  _lxb_encoding_encode_iso_2022_jp = Module['_lxb_encoding_encode_iso_2022_jp'] = wasmExports['lxb_encoding_encode_iso_2022_jp'];
  _lxb_encoding_encode_iso_2022_jp_eof = Module['_lxb_encoding_encode_iso_2022_jp_eof'] = wasmExports['lxb_encoding_encode_iso_2022_jp_eof'];
  _lxb_encoding_encode_iso_8859_10 = Module['_lxb_encoding_encode_iso_8859_10'] = wasmExports['lxb_encoding_encode_iso_8859_10'];
  _lxb_encoding_encode_iso_8859_13 = Module['_lxb_encoding_encode_iso_8859_13'] = wasmExports['lxb_encoding_encode_iso_8859_13'];
  _lxb_encoding_encode_iso_8859_14 = Module['_lxb_encoding_encode_iso_8859_14'] = wasmExports['lxb_encoding_encode_iso_8859_14'];
  _lxb_encoding_encode_iso_8859_15 = Module['_lxb_encoding_encode_iso_8859_15'] = wasmExports['lxb_encoding_encode_iso_8859_15'];
  _lxb_encoding_encode_iso_8859_16 = Module['_lxb_encoding_encode_iso_8859_16'] = wasmExports['lxb_encoding_encode_iso_8859_16'];
  _lxb_encoding_encode_iso_8859_2 = Module['_lxb_encoding_encode_iso_8859_2'] = wasmExports['lxb_encoding_encode_iso_8859_2'];
  _lxb_encoding_encode_iso_8859_3 = Module['_lxb_encoding_encode_iso_8859_3'] = wasmExports['lxb_encoding_encode_iso_8859_3'];
  _lxb_encoding_encode_iso_8859_4 = Module['_lxb_encoding_encode_iso_8859_4'] = wasmExports['lxb_encoding_encode_iso_8859_4'];
  _lxb_encoding_encode_iso_8859_5 = Module['_lxb_encoding_encode_iso_8859_5'] = wasmExports['lxb_encoding_encode_iso_8859_5'];
  _lxb_encoding_encode_iso_8859_6 = Module['_lxb_encoding_encode_iso_8859_6'] = wasmExports['lxb_encoding_encode_iso_8859_6'];
  _lxb_encoding_encode_iso_8859_7 = Module['_lxb_encoding_encode_iso_8859_7'] = wasmExports['lxb_encoding_encode_iso_8859_7'];
  _lxb_encoding_encode_iso_8859_8 = Module['_lxb_encoding_encode_iso_8859_8'] = wasmExports['lxb_encoding_encode_iso_8859_8'];
  _lxb_encoding_encode_iso_8859_8_i = Module['_lxb_encoding_encode_iso_8859_8_i'] = wasmExports['lxb_encoding_encode_iso_8859_8_i'];
  _lxb_encoding_encode_koi8_r = Module['_lxb_encoding_encode_koi8_r'] = wasmExports['lxb_encoding_encode_koi8_r'];
  _lxb_encoding_encode_koi8_u = Module['_lxb_encoding_encode_koi8_u'] = wasmExports['lxb_encoding_encode_koi8_u'];
  _lxb_encoding_encode_shift_jis = Module['_lxb_encoding_encode_shift_jis'] = wasmExports['lxb_encoding_encode_shift_jis'];
  _lxb_encoding_encode_utf_16be = Module['_lxb_encoding_encode_utf_16be'] = wasmExports['lxb_encoding_encode_utf_16be'];
  _lxb_encoding_encode_utf_16le = Module['_lxb_encoding_encode_utf_16le'] = wasmExports['lxb_encoding_encode_utf_16le'];
  _lxb_encoding_encode_gb18030 = Module['_lxb_encoding_encode_gb18030'] = wasmExports['lxb_encoding_encode_gb18030'];
  _lxb_encoding_encode_macintosh = Module['_lxb_encoding_encode_macintosh'] = wasmExports['lxb_encoding_encode_macintosh'];
  _lxb_encoding_encode_replacement = Module['_lxb_encoding_encode_replacement'] = wasmExports['lxb_encoding_encode_replacement'];
  _lxb_encoding_encode_windows_1250 = Module['_lxb_encoding_encode_windows_1250'] = wasmExports['lxb_encoding_encode_windows_1250'];
  _lxb_encoding_encode_windows_1251 = Module['_lxb_encoding_encode_windows_1251'] = wasmExports['lxb_encoding_encode_windows_1251'];
  _lxb_encoding_encode_windows_1252 = Module['_lxb_encoding_encode_windows_1252'] = wasmExports['lxb_encoding_encode_windows_1252'];
  _lxb_encoding_encode_windows_1253 = Module['_lxb_encoding_encode_windows_1253'] = wasmExports['lxb_encoding_encode_windows_1253'];
  _lxb_encoding_encode_windows_1254 = Module['_lxb_encoding_encode_windows_1254'] = wasmExports['lxb_encoding_encode_windows_1254'];
  _lxb_encoding_encode_windows_1255 = Module['_lxb_encoding_encode_windows_1255'] = wasmExports['lxb_encoding_encode_windows_1255'];
  _lxb_encoding_encode_windows_1256 = Module['_lxb_encoding_encode_windows_1256'] = wasmExports['lxb_encoding_encode_windows_1256'];
  _lxb_encoding_encode_windows_1257 = Module['_lxb_encoding_encode_windows_1257'] = wasmExports['lxb_encoding_encode_windows_1257'];
  _lxb_encoding_encode_windows_1258 = Module['_lxb_encoding_encode_windows_1258'] = wasmExports['lxb_encoding_encode_windows_1258'];
  _lxb_encoding_encode_windows_874 = Module['_lxb_encoding_encode_windows_874'] = wasmExports['lxb_encoding_encode_windows_874'];
  _lxb_encoding_encode_x_mac_cyrillic = Module['_lxb_encoding_encode_x_mac_cyrillic'] = wasmExports['lxb_encoding_encode_x_mac_cyrillic'];
  _lxb_encoding_encode_x_user_defined = Module['_lxb_encoding_encode_x_user_defined'] = wasmExports['lxb_encoding_encode_x_user_defined'];
  _lxb_encoding_encode_default_single = Module['_lxb_encoding_encode_default_single'] = wasmExports['lxb_encoding_encode_default_single'];
  _lxb_encoding_encode_utf_8_single = Module['_lxb_encoding_encode_utf_8_single'] = wasmExports['lxb_encoding_encode_utf_8_single'];
  _lxb_encoding_encode_auto_single = Module['_lxb_encoding_encode_auto_single'] = wasmExports['lxb_encoding_encode_auto_single'];
  _lxb_encoding_encode_undefined_single = Module['_lxb_encoding_encode_undefined_single'] = wasmExports['lxb_encoding_encode_undefined_single'];
  _lxb_encoding_encode_big5_single = Module['_lxb_encoding_encode_big5_single'] = wasmExports['lxb_encoding_encode_big5_single'];
  _lxb_encoding_encode_euc_jp_single = Module['_lxb_encoding_encode_euc_jp_single'] = wasmExports['lxb_encoding_encode_euc_jp_single'];
  _lxb_encoding_encode_euc_kr_single = Module['_lxb_encoding_encode_euc_kr_single'] = wasmExports['lxb_encoding_encode_euc_kr_single'];
  _lxb_encoding_encode_gbk_single = Module['_lxb_encoding_encode_gbk_single'] = wasmExports['lxb_encoding_encode_gbk_single'];
  _lxb_encoding_encode_ibm866_single = Module['_lxb_encoding_encode_ibm866_single'] = wasmExports['lxb_encoding_encode_ibm866_single'];
  _lxb_encoding_encode_iso_2022_jp_single = Module['_lxb_encoding_encode_iso_2022_jp_single'] = wasmExports['lxb_encoding_encode_iso_2022_jp_single'];
  _lxb_encoding_encode_iso_2022_jp_eof_single = Module['_lxb_encoding_encode_iso_2022_jp_eof_single'] = wasmExports['lxb_encoding_encode_iso_2022_jp_eof_single'];
  _lxb_encoding_encode_iso_8859_10_single = Module['_lxb_encoding_encode_iso_8859_10_single'] = wasmExports['lxb_encoding_encode_iso_8859_10_single'];
  _lxb_encoding_encode_iso_8859_13_single = Module['_lxb_encoding_encode_iso_8859_13_single'] = wasmExports['lxb_encoding_encode_iso_8859_13_single'];
  _lxb_encoding_encode_iso_8859_14_single = Module['_lxb_encoding_encode_iso_8859_14_single'] = wasmExports['lxb_encoding_encode_iso_8859_14_single'];
  _lxb_encoding_encode_iso_8859_15_single = Module['_lxb_encoding_encode_iso_8859_15_single'] = wasmExports['lxb_encoding_encode_iso_8859_15_single'];
  _lxb_encoding_encode_iso_8859_16_single = Module['_lxb_encoding_encode_iso_8859_16_single'] = wasmExports['lxb_encoding_encode_iso_8859_16_single'];
  _lxb_encoding_encode_iso_8859_2_single = Module['_lxb_encoding_encode_iso_8859_2_single'] = wasmExports['lxb_encoding_encode_iso_8859_2_single'];
  _lxb_encoding_encode_iso_8859_3_single = Module['_lxb_encoding_encode_iso_8859_3_single'] = wasmExports['lxb_encoding_encode_iso_8859_3_single'];
  _lxb_encoding_encode_iso_8859_4_single = Module['_lxb_encoding_encode_iso_8859_4_single'] = wasmExports['lxb_encoding_encode_iso_8859_4_single'];
  _lxb_encoding_encode_iso_8859_5_single = Module['_lxb_encoding_encode_iso_8859_5_single'] = wasmExports['lxb_encoding_encode_iso_8859_5_single'];
  _lxb_encoding_encode_iso_8859_6_single = Module['_lxb_encoding_encode_iso_8859_6_single'] = wasmExports['lxb_encoding_encode_iso_8859_6_single'];
  _lxb_encoding_encode_iso_8859_7_single = Module['_lxb_encoding_encode_iso_8859_7_single'] = wasmExports['lxb_encoding_encode_iso_8859_7_single'];
  _lxb_encoding_encode_iso_8859_8_single = Module['_lxb_encoding_encode_iso_8859_8_single'] = wasmExports['lxb_encoding_encode_iso_8859_8_single'];
  _lxb_encoding_encode_iso_8859_8_i_single = Module['_lxb_encoding_encode_iso_8859_8_i_single'] = wasmExports['lxb_encoding_encode_iso_8859_8_i_single'];
  _lxb_encoding_encode_koi8_r_single = Module['_lxb_encoding_encode_koi8_r_single'] = wasmExports['lxb_encoding_encode_koi8_r_single'];
  _lxb_encoding_encode_koi8_u_single = Module['_lxb_encoding_encode_koi8_u_single'] = wasmExports['lxb_encoding_encode_koi8_u_single'];
  _lxb_encoding_encode_shift_jis_single = Module['_lxb_encoding_encode_shift_jis_single'] = wasmExports['lxb_encoding_encode_shift_jis_single'];
  _lxb_encoding_encode_utf_16be_single = Module['_lxb_encoding_encode_utf_16be_single'] = wasmExports['lxb_encoding_encode_utf_16be_single'];
  _lxb_encoding_encode_utf_16le_single = Module['_lxb_encoding_encode_utf_16le_single'] = wasmExports['lxb_encoding_encode_utf_16le_single'];
  _lxb_encoding_encode_utf_8_length = Module['_lxb_encoding_encode_utf_8_length'] = wasmExports['lxb_encoding_encode_utf_8_length'];
  _lxb_encoding_encode_gb18030_single = Module['_lxb_encoding_encode_gb18030_single'] = wasmExports['lxb_encoding_encode_gb18030_single'];
  _lxb_encoding_encode_macintosh_single = Module['_lxb_encoding_encode_macintosh_single'] = wasmExports['lxb_encoding_encode_macintosh_single'];
  _lxb_encoding_encode_replacement_single = Module['_lxb_encoding_encode_replacement_single'] = wasmExports['lxb_encoding_encode_replacement_single'];
  _lxb_encoding_encode_windows_1250_single = Module['_lxb_encoding_encode_windows_1250_single'] = wasmExports['lxb_encoding_encode_windows_1250_single'];
  _lxb_encoding_encode_windows_1251_single = Module['_lxb_encoding_encode_windows_1251_single'] = wasmExports['lxb_encoding_encode_windows_1251_single'];
  _lxb_encoding_encode_windows_1252_single = Module['_lxb_encoding_encode_windows_1252_single'] = wasmExports['lxb_encoding_encode_windows_1252_single'];
  _lxb_encoding_encode_windows_1253_single = Module['_lxb_encoding_encode_windows_1253_single'] = wasmExports['lxb_encoding_encode_windows_1253_single'];
  _lxb_encoding_encode_windows_1254_single = Module['_lxb_encoding_encode_windows_1254_single'] = wasmExports['lxb_encoding_encode_windows_1254_single'];
  _lxb_encoding_encode_windows_1255_single = Module['_lxb_encoding_encode_windows_1255_single'] = wasmExports['lxb_encoding_encode_windows_1255_single'];
  _lxb_encoding_encode_windows_1256_single = Module['_lxb_encoding_encode_windows_1256_single'] = wasmExports['lxb_encoding_encode_windows_1256_single'];
  _lxb_encoding_encode_windows_1257_single = Module['_lxb_encoding_encode_windows_1257_single'] = wasmExports['lxb_encoding_encode_windows_1257_single'];
  _lxb_encoding_encode_windows_1258_single = Module['_lxb_encoding_encode_windows_1258_single'] = wasmExports['lxb_encoding_encode_windows_1258_single'];
  _lxb_encoding_encode_windows_874_single = Module['_lxb_encoding_encode_windows_874_single'] = wasmExports['lxb_encoding_encode_windows_874_single'];
  _lxb_encoding_encode_x_mac_cyrillic_single = Module['_lxb_encoding_encode_x_mac_cyrillic_single'] = wasmExports['lxb_encoding_encode_x_mac_cyrillic_single'];
  _lxb_encoding_encode_x_user_defined_single = Module['_lxb_encoding_encode_x_user_defined_single'] = wasmExports['lxb_encoding_encode_x_user_defined_single'];
  _lxb_encoding_data_by_pre_name = Module['_lxb_encoding_data_by_pre_name'] = wasmExports['lxb_encoding_data_by_pre_name'];
  _lxb_encoding_utf_8_skip_bom = Module['_lxb_encoding_utf_8_skip_bom'] = wasmExports['lxb_encoding_utf_8_skip_bom'];
  _lxb_encoding_utf_16be_skip_bom = Module['_lxb_encoding_utf_16be_skip_bom'] = wasmExports['lxb_encoding_utf_16be_skip_bom'];
  _lxb_encoding_utf_16le_skip_bom = Module['_lxb_encoding_utf_16le_skip_bom'] = wasmExports['lxb_encoding_utf_16le_skip_bom'];
  _lxb_encoding_encode_init_noi = Module['_lxb_encoding_encode_init_noi'] = wasmExports['lxb_encoding_encode_init_noi'];
  _lxb_encoding_encode_finish_noi = Module['_lxb_encoding_encode_finish_noi'] = wasmExports['lxb_encoding_encode_finish_noi'];
  _lxb_encoding_encode_buf_noi = Module['_lxb_encoding_encode_buf_noi'] = wasmExports['lxb_encoding_encode_buf_noi'];
  _lxb_encoding_encode_buf_set_noi = Module['_lxb_encoding_encode_buf_set_noi'] = wasmExports['lxb_encoding_encode_buf_set_noi'];
  _lxb_encoding_encode_buf_used_set_noi = Module['_lxb_encoding_encode_buf_used_set_noi'] = wasmExports['lxb_encoding_encode_buf_used_set_noi'];
  _lxb_encoding_encode_buf_used_noi = Module['_lxb_encoding_encode_buf_used_noi'] = wasmExports['lxb_encoding_encode_buf_used_noi'];
  _lxb_encoding_encode_replace_set_noi = Module['_lxb_encoding_encode_replace_set_noi'] = wasmExports['lxb_encoding_encode_replace_set_noi'];
  _lxb_encoding_encode_buf_add_to_noi = Module['_lxb_encoding_encode_buf_add_to_noi'] = wasmExports['lxb_encoding_encode_buf_add_to_noi'];
  _lxb_encoding_decode_init_noi = Module['_lxb_encoding_decode_init_noi'] = wasmExports['lxb_encoding_decode_init_noi'];
  _lxb_encoding_decode_finish_noi = Module['_lxb_encoding_decode_finish_noi'] = wasmExports['lxb_encoding_decode_finish_noi'];
  _lxb_encoding_decode_buf_noi = Module['_lxb_encoding_decode_buf_noi'] = wasmExports['lxb_encoding_decode_buf_noi'];
  _lxb_encoding_decode_buf_set_noi = Module['_lxb_encoding_decode_buf_set_noi'] = wasmExports['lxb_encoding_decode_buf_set_noi'];
  _lxb_encoding_decode_buf_used_set_noi = Module['_lxb_encoding_decode_buf_used_set_noi'] = wasmExports['lxb_encoding_decode_buf_used_set_noi'];
  _lxb_encoding_decode_buf_used_noi = Module['_lxb_encoding_decode_buf_used_noi'] = wasmExports['lxb_encoding_decode_buf_used_noi'];
  _lxb_encoding_decode_replace_set_noi = Module['_lxb_encoding_decode_replace_set_noi'] = wasmExports['lxb_encoding_decode_replace_set_noi'];
  _lxb_encoding_decode_buf_add_to_noi = Module['_lxb_encoding_decode_buf_add_to_noi'] = wasmExports['lxb_encoding_decode_buf_add_to_noi'];
  _lxb_encoding_encode_init_single_noi = Module['_lxb_encoding_encode_init_single_noi'] = wasmExports['lxb_encoding_encode_init_single_noi'];
  _lxb_encoding_encode_finish_single_noi = Module['_lxb_encoding_encode_finish_single_noi'] = wasmExports['lxb_encoding_encode_finish_single_noi'];
  _lxb_encoding_decode_init_single_noi = Module['_lxb_encoding_decode_init_single_noi'] = wasmExports['lxb_encoding_decode_init_single_noi'];
  _lxb_encoding_decode_finish_single_noi = Module['_lxb_encoding_decode_finish_single_noi'] = wasmExports['lxb_encoding_decode_finish_single_noi'];
  _lxb_encoding_data_by_name_noi = Module['_lxb_encoding_data_by_name_noi'] = wasmExports['lxb_encoding_data_by_name_noi'];
  _lxb_encoding_data_noi = Module['_lxb_encoding_data_noi'] = wasmExports['lxb_encoding_data_noi'];
  _lxb_encoding_encode_function_noi = Module['_lxb_encoding_encode_function_noi'] = wasmExports['lxb_encoding_encode_function_noi'];
  _lxb_encoding_decode_function_noi = Module['_lxb_encoding_decode_function_noi'] = wasmExports['lxb_encoding_decode_function_noi'];
  _lxb_encoding_data_call_encode_noi = Module['_lxb_encoding_data_call_encode_noi'] = wasmExports['lxb_encoding_data_call_encode_noi'];
  _lxb_encoding_data_call_decode_noi = Module['_lxb_encoding_data_call_decode_noi'] = wasmExports['lxb_encoding_data_call_decode_noi'];
  _lxb_encoding_data_encoding_noi = Module['_lxb_encoding_data_encoding_noi'] = wasmExports['lxb_encoding_data_encoding_noi'];
  _lxb_encoding_encode_t_sizeof = Module['_lxb_encoding_encode_t_sizeof'] = wasmExports['lxb_encoding_encode_t_sizeof'];
  _lxb_encoding_decode_t_sizeof = Module['_lxb_encoding_decode_t_sizeof'] = wasmExports['lxb_encoding_decode_t_sizeof'];
  _lxb_html_encoding_init = Module['_lxb_html_encoding_init'] = wasmExports['lxb_html_encoding_init'];
  _lxb_html_encoding_destroy = Module['_lxb_html_encoding_destroy'] = wasmExports['lxb_html_encoding_destroy'];
  _lxb_html_encoding_determine = Module['_lxb_html_encoding_determine'] = wasmExports['lxb_html_encoding_determine'];
  _lxb_html_encoding_content = Module['_lxb_html_encoding_content'] = wasmExports['lxb_html_encoding_content'];
  _lxb_html_encoding_create_noi = Module['_lxb_html_encoding_create_noi'] = wasmExports['lxb_html_encoding_create_noi'];
  _lxb_html_encoding_clean_noi = Module['_lxb_html_encoding_clean_noi'] = wasmExports['lxb_html_encoding_clean_noi'];
  _lxb_html_encoding_meta_entry_noi = Module['_lxb_html_encoding_meta_entry_noi'] = wasmExports['lxb_html_encoding_meta_entry_noi'];
  _lxb_html_encoding_meta_length_noi = Module['_lxb_html_encoding_meta_length_noi'] = wasmExports['lxb_html_encoding_meta_length_noi'];
  _lxb_html_encoding_meta_result_noi = Module['_lxb_html_encoding_meta_result_noi'] = wasmExports['lxb_html_encoding_meta_result_noi'];
  _lxb_html_interface_create = Module['_lxb_html_interface_create'] = wasmExports['lxb_html_interface_create'];
  _lxb_html_unknown_element_interface_create = Module['_lxb_html_unknown_element_interface_create'] = wasmExports['lxb_html_unknown_element_interface_create'];
  _lxb_html_interface_clone = Module['_lxb_html_interface_clone'] = wasmExports['lxb_html_interface_clone'];
  _lxb_html_interface_destroy = Module['_lxb_html_interface_destroy'] = wasmExports['lxb_html_interface_destroy'];
  _lxb_html_unknown_element_interface_destroy = Module['_lxb_html_unknown_element_interface_destroy'] = wasmExports['lxb_html_unknown_element_interface_destroy'];
  _lxb_html_element_interface_create = Module['_lxb_html_element_interface_create'] = wasmExports['lxb_html_element_interface_create'];
  _lxb_html_document_interface_create = Module['_lxb_html_document_interface_create'] = wasmExports['lxb_html_document_interface_create'];
  _lxb_html_anchor_element_interface_create = Module['_lxb_html_anchor_element_interface_create'] = wasmExports['lxb_html_anchor_element_interface_create'];
  _lxb_html_area_element_interface_create = Module['_lxb_html_area_element_interface_create'] = wasmExports['lxb_html_area_element_interface_create'];
  _lxb_html_audio_element_interface_create = Module['_lxb_html_audio_element_interface_create'] = wasmExports['lxb_html_audio_element_interface_create'];
  _lxb_html_base_element_interface_create = Module['_lxb_html_base_element_interface_create'] = wasmExports['lxb_html_base_element_interface_create'];
  _lxb_html_quote_element_interface_create = Module['_lxb_html_quote_element_interface_create'] = wasmExports['lxb_html_quote_element_interface_create'];
  _lxb_html_body_element_interface_create = Module['_lxb_html_body_element_interface_create'] = wasmExports['lxb_html_body_element_interface_create'];
  _lxb_html_br_element_interface_create = Module['_lxb_html_br_element_interface_create'] = wasmExports['lxb_html_br_element_interface_create'];
  _lxb_html_button_element_interface_create = Module['_lxb_html_button_element_interface_create'] = wasmExports['lxb_html_button_element_interface_create'];
  _lxb_html_canvas_element_interface_create = Module['_lxb_html_canvas_element_interface_create'] = wasmExports['lxb_html_canvas_element_interface_create'];
  _lxb_html_table_caption_element_interface_create = Module['_lxb_html_table_caption_element_interface_create'] = wasmExports['lxb_html_table_caption_element_interface_create'];
  _lxb_html_table_col_element_interface_create = Module['_lxb_html_table_col_element_interface_create'] = wasmExports['lxb_html_table_col_element_interface_create'];
  _lxb_html_data_element_interface_create = Module['_lxb_html_data_element_interface_create'] = wasmExports['lxb_html_data_element_interface_create'];
  _lxb_html_data_list_element_interface_create = Module['_lxb_html_data_list_element_interface_create'] = wasmExports['lxb_html_data_list_element_interface_create'];
  _lxb_html_mod_element_interface_create = Module['_lxb_html_mod_element_interface_create'] = wasmExports['lxb_html_mod_element_interface_create'];
  _lxb_html_details_element_interface_create = Module['_lxb_html_details_element_interface_create'] = wasmExports['lxb_html_details_element_interface_create'];
  _lxb_html_dialog_element_interface_create = Module['_lxb_html_dialog_element_interface_create'] = wasmExports['lxb_html_dialog_element_interface_create'];
  _lxb_html_directory_element_interface_create = Module['_lxb_html_directory_element_interface_create'] = wasmExports['lxb_html_directory_element_interface_create'];
  _lxb_html_div_element_interface_create = Module['_lxb_html_div_element_interface_create'] = wasmExports['lxb_html_div_element_interface_create'];
  _lxb_html_d_list_element_interface_create = Module['_lxb_html_d_list_element_interface_create'] = wasmExports['lxb_html_d_list_element_interface_create'];
  _lxb_html_embed_element_interface_create = Module['_lxb_html_embed_element_interface_create'] = wasmExports['lxb_html_embed_element_interface_create'];
  _lxb_html_field_set_element_interface_create = Module['_lxb_html_field_set_element_interface_create'] = wasmExports['lxb_html_field_set_element_interface_create'];
  _lxb_html_font_element_interface_create = Module['_lxb_html_font_element_interface_create'] = wasmExports['lxb_html_font_element_interface_create'];
  _lxb_html_form_element_interface_create = Module['_lxb_html_form_element_interface_create'] = wasmExports['lxb_html_form_element_interface_create'];
  _lxb_html_frame_element_interface_create = Module['_lxb_html_frame_element_interface_create'] = wasmExports['lxb_html_frame_element_interface_create'];
  _lxb_html_frame_set_element_interface_create = Module['_lxb_html_frame_set_element_interface_create'] = wasmExports['lxb_html_frame_set_element_interface_create'];
  _lxb_html_heading_element_interface_create = Module['_lxb_html_heading_element_interface_create'] = wasmExports['lxb_html_heading_element_interface_create'];
  _lxb_html_head_element_interface_create = Module['_lxb_html_head_element_interface_create'] = wasmExports['lxb_html_head_element_interface_create'];
  _lxb_html_hr_element_interface_create = Module['_lxb_html_hr_element_interface_create'] = wasmExports['lxb_html_hr_element_interface_create'];
  _lxb_html_html_element_interface_create = Module['_lxb_html_html_element_interface_create'] = wasmExports['lxb_html_html_element_interface_create'];
  _lxb_html_iframe_element_interface_create = Module['_lxb_html_iframe_element_interface_create'] = wasmExports['lxb_html_iframe_element_interface_create'];
  _lxb_html_image_element_interface_create = Module['_lxb_html_image_element_interface_create'] = wasmExports['lxb_html_image_element_interface_create'];
  _lxb_html_input_element_interface_create = Module['_lxb_html_input_element_interface_create'] = wasmExports['lxb_html_input_element_interface_create'];
  _lxb_html_label_element_interface_create = Module['_lxb_html_label_element_interface_create'] = wasmExports['lxb_html_label_element_interface_create'];
  _lxb_html_legend_element_interface_create = Module['_lxb_html_legend_element_interface_create'] = wasmExports['lxb_html_legend_element_interface_create'];
  _lxb_html_li_element_interface_create = Module['_lxb_html_li_element_interface_create'] = wasmExports['lxb_html_li_element_interface_create'];
  _lxb_html_link_element_interface_create = Module['_lxb_html_link_element_interface_create'] = wasmExports['lxb_html_link_element_interface_create'];
  _lxb_html_pre_element_interface_create = Module['_lxb_html_pre_element_interface_create'] = wasmExports['lxb_html_pre_element_interface_create'];
  _lxb_html_map_element_interface_create = Module['_lxb_html_map_element_interface_create'] = wasmExports['lxb_html_map_element_interface_create'];
  _lxb_html_marquee_element_interface_create = Module['_lxb_html_marquee_element_interface_create'] = wasmExports['lxb_html_marquee_element_interface_create'];
  _lxb_html_menu_element_interface_create = Module['_lxb_html_menu_element_interface_create'] = wasmExports['lxb_html_menu_element_interface_create'];
  _lxb_html_meta_element_interface_create = Module['_lxb_html_meta_element_interface_create'] = wasmExports['lxb_html_meta_element_interface_create'];
  _lxb_html_meter_element_interface_create = Module['_lxb_html_meter_element_interface_create'] = wasmExports['lxb_html_meter_element_interface_create'];
  _lxb_html_object_element_interface_create = Module['_lxb_html_object_element_interface_create'] = wasmExports['lxb_html_object_element_interface_create'];
  _lxb_html_o_list_element_interface_create = Module['_lxb_html_o_list_element_interface_create'] = wasmExports['lxb_html_o_list_element_interface_create'];
  _lxb_html_opt_group_element_interface_create = Module['_lxb_html_opt_group_element_interface_create'] = wasmExports['lxb_html_opt_group_element_interface_create'];
  _lxb_html_option_element_interface_create = Module['_lxb_html_option_element_interface_create'] = wasmExports['lxb_html_option_element_interface_create'];
  _lxb_html_output_element_interface_create = Module['_lxb_html_output_element_interface_create'] = wasmExports['lxb_html_output_element_interface_create'];
  _lxb_html_paragraph_element_interface_create = Module['_lxb_html_paragraph_element_interface_create'] = wasmExports['lxb_html_paragraph_element_interface_create'];
  _lxb_html_param_element_interface_create = Module['_lxb_html_param_element_interface_create'] = wasmExports['lxb_html_param_element_interface_create'];
  _lxb_html_picture_element_interface_create = Module['_lxb_html_picture_element_interface_create'] = wasmExports['lxb_html_picture_element_interface_create'];
  _lxb_html_progress_element_interface_create = Module['_lxb_html_progress_element_interface_create'] = wasmExports['lxb_html_progress_element_interface_create'];
  _lxb_html_script_element_interface_create = Module['_lxb_html_script_element_interface_create'] = wasmExports['lxb_html_script_element_interface_create'];
  _lxb_html_select_element_interface_create = Module['_lxb_html_select_element_interface_create'] = wasmExports['lxb_html_select_element_interface_create'];
  _lxb_html_slot_element_interface_create = Module['_lxb_html_slot_element_interface_create'] = wasmExports['lxb_html_slot_element_interface_create'];
  _lxb_html_source_element_interface_create = Module['_lxb_html_source_element_interface_create'] = wasmExports['lxb_html_source_element_interface_create'];
  _lxb_html_span_element_interface_create = Module['_lxb_html_span_element_interface_create'] = wasmExports['lxb_html_span_element_interface_create'];
  _lxb_html_style_element_interface_create = Module['_lxb_html_style_element_interface_create'] = wasmExports['lxb_html_style_element_interface_create'];
  _lxb_html_table_element_interface_create = Module['_lxb_html_table_element_interface_create'] = wasmExports['lxb_html_table_element_interface_create'];
  _lxb_html_table_section_element_interface_create = Module['_lxb_html_table_section_element_interface_create'] = wasmExports['lxb_html_table_section_element_interface_create'];
  _lxb_html_table_cell_element_interface_create = Module['_lxb_html_table_cell_element_interface_create'] = wasmExports['lxb_html_table_cell_element_interface_create'];
  _lxb_html_template_element_interface_create = Module['_lxb_html_template_element_interface_create'] = wasmExports['lxb_html_template_element_interface_create'];
  _lxb_html_text_area_element_interface_create = Module['_lxb_html_text_area_element_interface_create'] = wasmExports['lxb_html_text_area_element_interface_create'];
  _lxb_html_time_element_interface_create = Module['_lxb_html_time_element_interface_create'] = wasmExports['lxb_html_time_element_interface_create'];
  _lxb_html_title_element_interface_create = Module['_lxb_html_title_element_interface_create'] = wasmExports['lxb_html_title_element_interface_create'];
  _lxb_html_table_row_element_interface_create = Module['_lxb_html_table_row_element_interface_create'] = wasmExports['lxb_html_table_row_element_interface_create'];
  _lxb_html_track_element_interface_create = Module['_lxb_html_track_element_interface_create'] = wasmExports['lxb_html_track_element_interface_create'];
  _lxb_html_u_list_element_interface_create = Module['_lxb_html_u_list_element_interface_create'] = wasmExports['lxb_html_u_list_element_interface_create'];
  _lxb_html_video_element_interface_create = Module['_lxb_html_video_element_interface_create'] = wasmExports['lxb_html_video_element_interface_create'];
  _lxb_html_element_interface_destroy = Module['_lxb_html_element_interface_destroy'] = wasmExports['lxb_html_element_interface_destroy'];
  _lxb_html_document_interface_destroy = Module['_lxb_html_document_interface_destroy'] = wasmExports['lxb_html_document_interface_destroy'];
  _lxb_html_anchor_element_interface_destroy = Module['_lxb_html_anchor_element_interface_destroy'] = wasmExports['lxb_html_anchor_element_interface_destroy'];
  _lxb_html_area_element_interface_destroy = Module['_lxb_html_area_element_interface_destroy'] = wasmExports['lxb_html_area_element_interface_destroy'];
  _lxb_html_audio_element_interface_destroy = Module['_lxb_html_audio_element_interface_destroy'] = wasmExports['lxb_html_audio_element_interface_destroy'];
  _lxb_html_base_element_interface_destroy = Module['_lxb_html_base_element_interface_destroy'] = wasmExports['lxb_html_base_element_interface_destroy'];
  _lxb_html_quote_element_interface_destroy = Module['_lxb_html_quote_element_interface_destroy'] = wasmExports['lxb_html_quote_element_interface_destroy'];
  _lxb_html_body_element_interface_destroy = Module['_lxb_html_body_element_interface_destroy'] = wasmExports['lxb_html_body_element_interface_destroy'];
  _lxb_html_br_element_interface_destroy = Module['_lxb_html_br_element_interface_destroy'] = wasmExports['lxb_html_br_element_interface_destroy'];
  _lxb_html_button_element_interface_destroy = Module['_lxb_html_button_element_interface_destroy'] = wasmExports['lxb_html_button_element_interface_destroy'];
  _lxb_html_canvas_element_interface_destroy = Module['_lxb_html_canvas_element_interface_destroy'] = wasmExports['lxb_html_canvas_element_interface_destroy'];
  _lxb_html_table_caption_element_interface_destroy = Module['_lxb_html_table_caption_element_interface_destroy'] = wasmExports['lxb_html_table_caption_element_interface_destroy'];
  _lxb_html_table_col_element_interface_destroy = Module['_lxb_html_table_col_element_interface_destroy'] = wasmExports['lxb_html_table_col_element_interface_destroy'];
  _lxb_html_data_element_interface_destroy = Module['_lxb_html_data_element_interface_destroy'] = wasmExports['lxb_html_data_element_interface_destroy'];
  _lxb_html_data_list_element_interface_destroy = Module['_lxb_html_data_list_element_interface_destroy'] = wasmExports['lxb_html_data_list_element_interface_destroy'];
  _lxb_html_mod_element_interface_destroy = Module['_lxb_html_mod_element_interface_destroy'] = wasmExports['lxb_html_mod_element_interface_destroy'];
  _lxb_html_details_element_interface_destroy = Module['_lxb_html_details_element_interface_destroy'] = wasmExports['lxb_html_details_element_interface_destroy'];
  _lxb_html_dialog_element_interface_destroy = Module['_lxb_html_dialog_element_interface_destroy'] = wasmExports['lxb_html_dialog_element_interface_destroy'];
  _lxb_html_directory_element_interface_destroy = Module['_lxb_html_directory_element_interface_destroy'] = wasmExports['lxb_html_directory_element_interface_destroy'];
  _lxb_html_div_element_interface_destroy = Module['_lxb_html_div_element_interface_destroy'] = wasmExports['lxb_html_div_element_interface_destroy'];
  _lxb_html_d_list_element_interface_destroy = Module['_lxb_html_d_list_element_interface_destroy'] = wasmExports['lxb_html_d_list_element_interface_destroy'];
  _lxb_html_embed_element_interface_destroy = Module['_lxb_html_embed_element_interface_destroy'] = wasmExports['lxb_html_embed_element_interface_destroy'];
  _lxb_html_field_set_element_interface_destroy = Module['_lxb_html_field_set_element_interface_destroy'] = wasmExports['lxb_html_field_set_element_interface_destroy'];
  _lxb_html_font_element_interface_destroy = Module['_lxb_html_font_element_interface_destroy'] = wasmExports['lxb_html_font_element_interface_destroy'];
  _lxb_html_form_element_interface_destroy = Module['_lxb_html_form_element_interface_destroy'] = wasmExports['lxb_html_form_element_interface_destroy'];
  _lxb_html_frame_element_interface_destroy = Module['_lxb_html_frame_element_interface_destroy'] = wasmExports['lxb_html_frame_element_interface_destroy'];
  _lxb_html_frame_set_element_interface_destroy = Module['_lxb_html_frame_set_element_interface_destroy'] = wasmExports['lxb_html_frame_set_element_interface_destroy'];
  _lxb_html_heading_element_interface_destroy = Module['_lxb_html_heading_element_interface_destroy'] = wasmExports['lxb_html_heading_element_interface_destroy'];
  _lxb_html_head_element_interface_destroy = Module['_lxb_html_head_element_interface_destroy'] = wasmExports['lxb_html_head_element_interface_destroy'];
  _lxb_html_hr_element_interface_destroy = Module['_lxb_html_hr_element_interface_destroy'] = wasmExports['lxb_html_hr_element_interface_destroy'];
  _lxb_html_html_element_interface_destroy = Module['_lxb_html_html_element_interface_destroy'] = wasmExports['lxb_html_html_element_interface_destroy'];
  _lxb_html_iframe_element_interface_destroy = Module['_lxb_html_iframe_element_interface_destroy'] = wasmExports['lxb_html_iframe_element_interface_destroy'];
  _lxb_html_image_element_interface_destroy = Module['_lxb_html_image_element_interface_destroy'] = wasmExports['lxb_html_image_element_interface_destroy'];
  _lxb_html_input_element_interface_destroy = Module['_lxb_html_input_element_interface_destroy'] = wasmExports['lxb_html_input_element_interface_destroy'];
  _lxb_html_label_element_interface_destroy = Module['_lxb_html_label_element_interface_destroy'] = wasmExports['lxb_html_label_element_interface_destroy'];
  _lxb_html_legend_element_interface_destroy = Module['_lxb_html_legend_element_interface_destroy'] = wasmExports['lxb_html_legend_element_interface_destroy'];
  _lxb_html_li_element_interface_destroy = Module['_lxb_html_li_element_interface_destroy'] = wasmExports['lxb_html_li_element_interface_destroy'];
  _lxb_html_link_element_interface_destroy = Module['_lxb_html_link_element_interface_destroy'] = wasmExports['lxb_html_link_element_interface_destroy'];
  _lxb_html_pre_element_interface_destroy = Module['_lxb_html_pre_element_interface_destroy'] = wasmExports['lxb_html_pre_element_interface_destroy'];
  _lxb_html_map_element_interface_destroy = Module['_lxb_html_map_element_interface_destroy'] = wasmExports['lxb_html_map_element_interface_destroy'];
  _lxb_html_marquee_element_interface_destroy = Module['_lxb_html_marquee_element_interface_destroy'] = wasmExports['lxb_html_marquee_element_interface_destroy'];
  _lxb_html_menu_element_interface_destroy = Module['_lxb_html_menu_element_interface_destroy'] = wasmExports['lxb_html_menu_element_interface_destroy'];
  _lxb_html_meta_element_interface_destroy = Module['_lxb_html_meta_element_interface_destroy'] = wasmExports['lxb_html_meta_element_interface_destroy'];
  _lxb_html_meter_element_interface_destroy = Module['_lxb_html_meter_element_interface_destroy'] = wasmExports['lxb_html_meter_element_interface_destroy'];
  _lxb_html_object_element_interface_destroy = Module['_lxb_html_object_element_interface_destroy'] = wasmExports['lxb_html_object_element_interface_destroy'];
  _lxb_html_o_list_element_interface_destroy = Module['_lxb_html_o_list_element_interface_destroy'] = wasmExports['lxb_html_o_list_element_interface_destroy'];
  _lxb_html_opt_group_element_interface_destroy = Module['_lxb_html_opt_group_element_interface_destroy'] = wasmExports['lxb_html_opt_group_element_interface_destroy'];
  _lxb_html_option_element_interface_destroy = Module['_lxb_html_option_element_interface_destroy'] = wasmExports['lxb_html_option_element_interface_destroy'];
  _lxb_html_output_element_interface_destroy = Module['_lxb_html_output_element_interface_destroy'] = wasmExports['lxb_html_output_element_interface_destroy'];
  _lxb_html_paragraph_element_interface_destroy = Module['_lxb_html_paragraph_element_interface_destroy'] = wasmExports['lxb_html_paragraph_element_interface_destroy'];
  _lxb_html_param_element_interface_destroy = Module['_lxb_html_param_element_interface_destroy'] = wasmExports['lxb_html_param_element_interface_destroy'];
  _lxb_html_picture_element_interface_destroy = Module['_lxb_html_picture_element_interface_destroy'] = wasmExports['lxb_html_picture_element_interface_destroy'];
  _lxb_html_progress_element_interface_destroy = Module['_lxb_html_progress_element_interface_destroy'] = wasmExports['lxb_html_progress_element_interface_destroy'];
  _lxb_html_script_element_interface_destroy = Module['_lxb_html_script_element_interface_destroy'] = wasmExports['lxb_html_script_element_interface_destroy'];
  _lxb_html_select_element_interface_destroy = Module['_lxb_html_select_element_interface_destroy'] = wasmExports['lxb_html_select_element_interface_destroy'];
  _lxb_html_slot_element_interface_destroy = Module['_lxb_html_slot_element_interface_destroy'] = wasmExports['lxb_html_slot_element_interface_destroy'];
  _lxb_html_source_element_interface_destroy = Module['_lxb_html_source_element_interface_destroy'] = wasmExports['lxb_html_source_element_interface_destroy'];
  _lxb_html_span_element_interface_destroy = Module['_lxb_html_span_element_interface_destroy'] = wasmExports['lxb_html_span_element_interface_destroy'];
  _lxb_html_style_element_interface_destroy = Module['_lxb_html_style_element_interface_destroy'] = wasmExports['lxb_html_style_element_interface_destroy'];
  _lxb_html_table_element_interface_destroy = Module['_lxb_html_table_element_interface_destroy'] = wasmExports['lxb_html_table_element_interface_destroy'];
  _lxb_html_table_section_element_interface_destroy = Module['_lxb_html_table_section_element_interface_destroy'] = wasmExports['lxb_html_table_section_element_interface_destroy'];
  _lxb_html_table_cell_element_interface_destroy = Module['_lxb_html_table_cell_element_interface_destroy'] = wasmExports['lxb_html_table_cell_element_interface_destroy'];
  _lxb_html_template_element_interface_destroy = Module['_lxb_html_template_element_interface_destroy'] = wasmExports['lxb_html_template_element_interface_destroy'];
  _lxb_html_text_area_element_interface_destroy = Module['_lxb_html_text_area_element_interface_destroy'] = wasmExports['lxb_html_text_area_element_interface_destroy'];
  _lxb_html_time_element_interface_destroy = Module['_lxb_html_time_element_interface_destroy'] = wasmExports['lxb_html_time_element_interface_destroy'];
  _lxb_html_title_element_interface_destroy = Module['_lxb_html_title_element_interface_destroy'] = wasmExports['lxb_html_title_element_interface_destroy'];
  _lxb_html_table_row_element_interface_destroy = Module['_lxb_html_table_row_element_interface_destroy'] = wasmExports['lxb_html_table_row_element_interface_destroy'];
  _lxb_html_track_element_interface_destroy = Module['_lxb_html_track_element_interface_destroy'] = wasmExports['lxb_html_track_element_interface_destroy'];
  _lxb_html_u_list_element_interface_destroy = Module['_lxb_html_u_list_element_interface_destroy'] = wasmExports['lxb_html_u_list_element_interface_destroy'];
  _lxb_html_video_element_interface_destroy = Module['_lxb_html_video_element_interface_destroy'] = wasmExports['lxb_html_video_element_interface_destroy'];
  _lxb_html_parser_unref = Module['_lxb_html_parser_unref'] = wasmExports['lxb_html_parser_unref'];
  _lxb_html_document_create = Module['_lxb_html_document_create'] = wasmExports['lxb_html_document_create'];
  _lxb_html_document_clean = Module['_lxb_html_document_clean'] = wasmExports['lxb_html_document_clean'];
  _lxb_html_document_destroy = Module['_lxb_html_document_destroy'] = wasmExports['lxb_html_document_destroy'];
  _lxb_html_document_parse = Module['_lxb_html_document_parse'] = wasmExports['lxb_html_document_parse'];
  _lxb_html_parser_create = Module['_lxb_html_parser_create'] = wasmExports['lxb_html_parser_create'];
  _lxb_html_parser_init = Module['_lxb_html_parser_init'] = wasmExports['lxb_html_parser_init'];
  _lxb_html_parser_destroy = Module['_lxb_html_parser_destroy'] = wasmExports['lxb_html_parser_destroy'];
  _lxb_html_parser_clean = Module['_lxb_html_parser_clean'] = wasmExports['lxb_html_parser_clean'];
  _lxb_html_parse_chunk_prepare = Module['_lxb_html_parse_chunk_prepare'] = wasmExports['lxb_html_parse_chunk_prepare'];
  _lxb_html_parse_chunk_process = Module['_lxb_html_parse_chunk_process'] = wasmExports['lxb_html_parse_chunk_process'];
  _lxb_html_parse_chunk_end = Module['_lxb_html_parse_chunk_end'] = wasmExports['lxb_html_parse_chunk_end'];
  _lxb_html_document_parse_chunk_begin = Module['_lxb_html_document_parse_chunk_begin'] = wasmExports['lxb_html_document_parse_chunk_begin'];
  _lxb_html_document_parse_chunk = Module['_lxb_html_document_parse_chunk'] = wasmExports['lxb_html_document_parse_chunk'];
  _lxb_html_document_parse_chunk_end = Module['_lxb_html_document_parse_chunk_end'] = wasmExports['lxb_html_document_parse_chunk_end'];
  _lxb_html_document_parse_fragment = Module['_lxb_html_document_parse_fragment'] = wasmExports['lxb_html_document_parse_fragment'];
  _lxb_html_parse_fragment_chunk_begin = Module['_lxb_html_parse_fragment_chunk_begin'] = wasmExports['lxb_html_parse_fragment_chunk_begin'];
  _lxb_html_parse_fragment_chunk_process = Module['_lxb_html_parse_fragment_chunk_process'] = wasmExports['lxb_html_parse_fragment_chunk_process'];
  _lxb_html_parse_fragment_chunk_end = Module['_lxb_html_parse_fragment_chunk_end'] = wasmExports['lxb_html_parse_fragment_chunk_end'];
  _lxb_html_document_parse_fragment_chunk_begin = Module['_lxb_html_document_parse_fragment_chunk_begin'] = wasmExports['lxb_html_document_parse_fragment_chunk_begin'];
  _lxb_html_document_parse_fragment_chunk = Module['_lxb_html_document_parse_fragment_chunk'] = wasmExports['lxb_html_document_parse_fragment_chunk'];
  _lxb_html_document_parse_fragment_chunk_end = Module['_lxb_html_document_parse_fragment_chunk_end'] = wasmExports['lxb_html_document_parse_fragment_chunk_end'];
  _lxb_html_document_title = Module['_lxb_html_document_title'] = wasmExports['lxb_html_document_title'];
  _lxb_html_title_element_strict_text = Module['_lxb_html_title_element_strict_text'] = wasmExports['lxb_html_title_element_strict_text'];
  _lxb_html_document_title_set = Module['_lxb_html_document_title_set'] = wasmExports['lxb_html_document_title_set'];
  _lxb_html_document_title_raw = Module['_lxb_html_document_title_raw'] = wasmExports['lxb_html_document_title_raw'];
  _lxb_html_title_element_text = Module['_lxb_html_title_element_text'] = wasmExports['lxb_html_title_element_text'];
  _lxb_html_document_import_node = Module['_lxb_html_document_import_node'] = wasmExports['lxb_html_document_import_node'];
  _lxb_html_document_head_element_noi = Module['_lxb_html_document_head_element_noi'] = wasmExports['lxb_html_document_head_element_noi'];
  _lxb_html_document_body_element_noi = Module['_lxb_html_document_body_element_noi'] = wasmExports['lxb_html_document_body_element_noi'];
  _lxb_html_document_original_ref_noi = Module['_lxb_html_document_original_ref_noi'] = wasmExports['lxb_html_document_original_ref_noi'];
  _lxb_html_document_is_original_noi = Module['_lxb_html_document_is_original_noi'] = wasmExports['lxb_html_document_is_original_noi'];
  _lxb_html_document_mraw_noi = Module['_lxb_html_document_mraw_noi'] = wasmExports['lxb_html_document_mraw_noi'];
  _lxb_html_document_mraw_text_noi = Module['_lxb_html_document_mraw_text_noi'] = wasmExports['lxb_html_document_mraw_text_noi'];
  _lxb_html_document_opt_set_noi = Module['_lxb_html_document_opt_set_noi'] = wasmExports['lxb_html_document_opt_set_noi'];
  _lxb_html_document_opt_noi = Module['_lxb_html_document_opt_noi'] = wasmExports['lxb_html_document_opt_noi'];
  _lxb_html_document_create_struct_noi = Module['_lxb_html_document_create_struct_noi'] = wasmExports['lxb_html_document_create_struct_noi'];
  _lxb_html_document_destroy_struct_noi = Module['_lxb_html_document_destroy_struct_noi'] = wasmExports['lxb_html_document_destroy_struct_noi'];
  _lxb_html_document_create_element_noi = Module['_lxb_html_document_create_element_noi'] = wasmExports['lxb_html_document_create_element_noi'];
  _lxb_html_document_destroy_element_noi = Module['_lxb_html_document_destroy_element_noi'] = wasmExports['lxb_html_document_destroy_element_noi'];
  _lxb_html_element_inner_html_set = Module['_lxb_html_element_inner_html_set'] = wasmExports['lxb_html_element_inner_html_set'];
  _lxb_html_media_element_interface_create = Module['_lxb_html_media_element_interface_create'] = wasmExports['lxb_html_media_element_interface_create'];
  _lxb_html_media_element_interface_destroy = Module['_lxb_html_media_element_interface_destroy'] = wasmExports['lxb_html_media_element_interface_destroy'];
  _lxb_html_window_create = Module['_lxb_html_window_create'] = wasmExports['lxb_html_window_create'];
  _lxb_html_window_destroy = Module['_lxb_html_window_destroy'] = wasmExports['lxb_html_window_destroy'];
  _lxb_html_tokenizer_create = Module['_lxb_html_tokenizer_create'] = wasmExports['lxb_html_tokenizer_create'];
  _lxb_html_tokenizer_init = Module['_lxb_html_tokenizer_init'] = wasmExports['lxb_html_tokenizer_init'];
  _lxb_html_tree_create = Module['_lxb_html_tree_create'] = wasmExports['lxb_html_tree_create'];
  _lxb_html_tree_init = Module['_lxb_html_tree_init'] = wasmExports['lxb_html_tree_init'];
  _lxb_html_tokenizer_clean = Module['_lxb_html_tokenizer_clean'] = wasmExports['lxb_html_tokenizer_clean'];
  _lxb_html_tree_clean = Module['_lxb_html_tree_clean'] = wasmExports['lxb_html_tree_clean'];
  _lxb_html_tokenizer_unref = Module['_lxb_html_tokenizer_unref'] = wasmExports['lxb_html_tokenizer_unref'];
  _lxb_html_tree_unref = Module['_lxb_html_tree_unref'] = wasmExports['lxb_html_tree_unref'];
  _lxb_html_parser_ref = Module['_lxb_html_parser_ref'] = wasmExports['lxb_html_parser_ref'];
  _lxb_html_parse = Module['_lxb_html_parse'] = wasmExports['lxb_html_parse'];
  _lxb_html_parse_chunk_begin = Module['_lxb_html_parse_chunk_begin'] = wasmExports['lxb_html_parse_chunk_begin'];
  _lxb_html_tokenizer_chunk = Module['_lxb_html_tokenizer_chunk'] = wasmExports['lxb_html_tokenizer_chunk'];
  _lxb_html_tokenizer_end = Module['_lxb_html_tokenizer_end'] = wasmExports['lxb_html_tokenizer_end'];
  _lxb_html_tokenizer_begin = Module['_lxb_html_tokenizer_begin'] = wasmExports['lxb_html_tokenizer_begin'];
  _lxb_html_parse_fragment = Module['_lxb_html_parse_fragment'] = wasmExports['lxb_html_parse_fragment'];
  _lxb_html_parse_fragment_by_tag_id = Module['_lxb_html_parse_fragment_by_tag_id'] = wasmExports['lxb_html_parse_fragment_by_tag_id'];
  _lxb_html_tokenizer_set_state_by_tag = Module['_lxb_html_tokenizer_set_state_by_tag'] = wasmExports['lxb_html_tokenizer_set_state_by_tag'];
  _lxb_html_tree_insertion_mode_in_template = Module['_lxb_html_tree_insertion_mode_in_template'] = wasmExports['lxb_html_tree_insertion_mode_in_template'];
  _lxb_html_tree_reset_insertion_mode_appropriately = Module['_lxb_html_tree_reset_insertion_mode_appropriately'] = wasmExports['lxb_html_tree_reset_insertion_mode_appropriately'];
  _lxb_html_parser_tokenizer_noi = Module['_lxb_html_parser_tokenizer_noi'] = wasmExports['lxb_html_parser_tokenizer_noi'];
  _lxb_html_parser_tree_noi = Module['_lxb_html_parser_tree_noi'] = wasmExports['lxb_html_parser_tree_noi'];
  _lxb_html_parser_status_noi = Module['_lxb_html_parser_status_noi'] = wasmExports['lxb_html_parser_status_noi'];
  _lxb_html_parser_state_noi = Module['_lxb_html_parser_state_noi'] = wasmExports['lxb_html_parser_state_noi'];
  _lxb_html_parser_scripting_noi = Module['_lxb_html_parser_scripting_noi'] = wasmExports['lxb_html_parser_scripting_noi'];
  _lxb_html_parser_scripting_set_noi = Module['_lxb_html_parser_scripting_set_noi'] = wasmExports['lxb_html_parser_scripting_set_noi'];
  _lxb_html_token_attr_create = Module['_lxb_html_token_attr_create'] = wasmExports['lxb_html_token_attr_create'];
  _lxb_html_token_attr_clean = Module['_lxb_html_token_attr_clean'] = wasmExports['lxb_html_token_attr_clean'];
  _lxb_html_token_attr_destroy = Module['_lxb_html_token_attr_destroy'] = wasmExports['lxb_html_token_attr_destroy'];
  _lxb_html_token_attr_name = Module['_lxb_html_token_attr_name'] = wasmExports['lxb_html_token_attr_name'];
  _lxb_html_token_create = Module['_lxb_html_token_create'] = wasmExports['lxb_html_token_create'];
  _lxb_html_token_destroy = Module['_lxb_html_token_destroy'] = wasmExports['lxb_html_token_destroy'];
  _lxb_html_token_attr_append = Module['_lxb_html_token_attr_append'] = wasmExports['lxb_html_token_attr_append'];
  _lxb_html_token_attr_remove = Module['_lxb_html_token_attr_remove'] = wasmExports['lxb_html_token_attr_remove'];
  _lxb_html_token_attr_delete = Module['_lxb_html_token_attr_delete'] = wasmExports['lxb_html_token_attr_delete'];
  _lxb_html_token_make_text = Module['_lxb_html_token_make_text'] = wasmExports['lxb_html_token_make_text'];
  _lxb_html_token_make_text_drop_null = Module['_lxb_html_token_make_text_drop_null'] = wasmExports['lxb_html_token_make_text_drop_null'];
  _lxb_html_token_make_text_replace_null = Module['_lxb_html_token_make_text_replace_null'] = wasmExports['lxb_html_token_make_text_replace_null'];
  _lxb_html_token_data_skip_ws_begin = Module['_lxb_html_token_data_skip_ws_begin'] = wasmExports['lxb_html_token_data_skip_ws_begin'];
  _lxb_html_token_data_skip_one_newline_begin = Module['_lxb_html_token_data_skip_one_newline_begin'] = wasmExports['lxb_html_token_data_skip_one_newline_begin'];
  _lxb_html_token_data_split_ws_begin = Module['_lxb_html_token_data_split_ws_begin'] = wasmExports['lxb_html_token_data_split_ws_begin'];
  _lxb_html_token_doctype_parse = Module['_lxb_html_token_doctype_parse'] = wasmExports['lxb_html_token_doctype_parse'];
  _lxb_html_token_find_attr = Module['_lxb_html_token_find_attr'] = wasmExports['lxb_html_token_find_attr'];
  _lxb_html_token_clean_noi = Module['_lxb_html_token_clean_noi'] = wasmExports['lxb_html_token_clean_noi'];
  _lxb_html_token_create_eof_noi = Module['_lxb_html_token_create_eof_noi'] = wasmExports['lxb_html_token_create_eof_noi'];
  _lxb_html_tokenizer_state_data_before = Module['_lxb_html_tokenizer_state_data_before'] = wasmExports['lxb_html_tokenizer_state_data_before'];
  _lxb_html_tokenizer_inherit = Module['_lxb_html_tokenizer_inherit'] = wasmExports['lxb_html_tokenizer_inherit'];
  _lxb_html_tokenizer_ref = Module['_lxb_html_tokenizer_ref'] = wasmExports['lxb_html_tokenizer_ref'];
  _lxb_html_tokenizer_destroy = Module['_lxb_html_tokenizer_destroy'] = wasmExports['lxb_html_tokenizer_destroy'];
  _lxb_html_tokenizer_tags_destroy = Module['_lxb_html_tokenizer_tags_destroy'] = wasmExports['lxb_html_tokenizer_tags_destroy'];
  _lxb_html_tokenizer_attrs_destroy = Module['_lxb_html_tokenizer_attrs_destroy'] = wasmExports['lxb_html_tokenizer_attrs_destroy'];
  _lxb_html_tokenizer_tags_make = Module['_lxb_html_tokenizer_tags_make'] = wasmExports['lxb_html_tokenizer_tags_make'];
  _lxb_html_tokenizer_attrs_make = Module['_lxb_html_tokenizer_attrs_make'] = wasmExports['lxb_html_tokenizer_attrs_make'];
  _lxb_html_tokenizer_current_namespace = Module['_lxb_html_tokenizer_current_namespace'] = wasmExports['lxb_html_tokenizer_current_namespace'];
  _lxb_html_tokenizer_state_plaintext_before = Module['_lxb_html_tokenizer_state_plaintext_before'] = wasmExports['lxb_html_tokenizer_state_plaintext_before'];
  _lxb_html_tokenizer_state_rcdata_before = Module['_lxb_html_tokenizer_state_rcdata_before'] = wasmExports['lxb_html_tokenizer_state_rcdata_before'];
  _lxb_html_tokenizer_state_rawtext_before = Module['_lxb_html_tokenizer_state_rawtext_before'] = wasmExports['lxb_html_tokenizer_state_rawtext_before'];
  _lxb_html_tokenizer_state_script_data_before = Module['_lxb_html_tokenizer_state_script_data_before'] = wasmExports['lxb_html_tokenizer_state_script_data_before'];
  _lxb_html_tokenizer_status_set_noi = Module['_lxb_html_tokenizer_status_set_noi'] = wasmExports['lxb_html_tokenizer_status_set_noi'];
  _lxb_html_tokenizer_callback_token_done_set_noi = Module['_lxb_html_tokenizer_callback_token_done_set_noi'] = wasmExports['lxb_html_tokenizer_callback_token_done_set_noi'];
  _lxb_html_tokenizer_callback_token_done_ctx_noi = Module['_lxb_html_tokenizer_callback_token_done_ctx_noi'] = wasmExports['lxb_html_tokenizer_callback_token_done_ctx_noi'];
  _lxb_html_tokenizer_state_set_noi = Module['_lxb_html_tokenizer_state_set_noi'] = wasmExports['lxb_html_tokenizer_state_set_noi'];
  _lxb_html_tokenizer_tmp_tag_id_set_noi = Module['_lxb_html_tokenizer_tmp_tag_id_set_noi'] = wasmExports['lxb_html_tokenizer_tmp_tag_id_set_noi'];
  _lxb_html_tokenizer_tree_noi = Module['_lxb_html_tokenizer_tree_noi'] = wasmExports['lxb_html_tokenizer_tree_noi'];
  _lxb_html_tokenizer_tree_set_noi = Module['_lxb_html_tokenizer_tree_set_noi'] = wasmExports['lxb_html_tokenizer_tree_set_noi'];
  _lxb_html_tokenizer_mraw_noi = Module['_lxb_html_tokenizer_mraw_noi'] = wasmExports['lxb_html_tokenizer_mraw_noi'];
  _lxb_html_tokenizer_tags_noi = Module['_lxb_html_tokenizer_tags_noi'] = wasmExports['lxb_html_tokenizer_tags_noi'];
  _lxb_html_tokenizer_error_add = Module['_lxb_html_tokenizer_error_add'] = wasmExports['lxb_html_tokenizer_error_add'];
  _lxb_html_tokenizer_state_comment_before_start = Module['_lxb_html_tokenizer_state_comment_before_start'] = wasmExports['lxb_html_tokenizer_state_comment_before_start'];
  _lxb_html_tokenizer_state_cr = Module['_lxb_html_tokenizer_state_cr'] = wasmExports['lxb_html_tokenizer_state_cr'];
  _lxb_html_tokenizer_state_doctype_before = Module['_lxb_html_tokenizer_state_doctype_before'] = wasmExports['lxb_html_tokenizer_state_doctype_before'];
  _lxb_html_tokenizer_state_before_attribute_name = Module['_lxb_html_tokenizer_state_before_attribute_name'] = wasmExports['lxb_html_tokenizer_state_before_attribute_name'];
  _lxb_html_tokenizer_state_self_closing_start_tag = Module['_lxb_html_tokenizer_state_self_closing_start_tag'] = wasmExports['lxb_html_tokenizer_state_self_closing_start_tag'];
  _lxb_html_tokenizer_state_char_ref = Module['_lxb_html_tokenizer_state_char_ref'] = wasmExports['lxb_html_tokenizer_state_char_ref'];
  _lxb_html_tree_insertion_mode_initial = Module['_lxb_html_tree_insertion_mode_initial'] = wasmExports['lxb_html_tree_insertion_mode_initial'];
  _lxb_html_tree_construction_dispatcher = Module['_lxb_html_tree_construction_dispatcher'] = wasmExports['lxb_html_tree_construction_dispatcher'];
  _lxb_html_tree_ref = Module['_lxb_html_tree_ref'] = wasmExports['lxb_html_tree_ref'];
  _lxb_html_tree_destroy = Module['_lxb_html_tree_destroy'] = wasmExports['lxb_html_tree_destroy'];
  _lxb_html_tree_stop_parsing = Module['_lxb_html_tree_stop_parsing'] = wasmExports['lxb_html_tree_stop_parsing'];
  _lxb_html_tree_process_abort = Module['_lxb_html_tree_process_abort'] = wasmExports['lxb_html_tree_process_abort'];
  _lxb_html_tree_parse_error = Module['_lxb_html_tree_parse_error'] = wasmExports['lxb_html_tree_parse_error'];
  _lxb_html_tree_error_add = Module['_lxb_html_tree_error_add'] = wasmExports['lxb_html_tree_error_add'];
  _lxb_html_tree_html_integration_point = Module['_lxb_html_tree_html_integration_point'] = wasmExports['lxb_html_tree_html_integration_point'];
  _lxb_html_tree_insertion_mode_foreign_content = Module['_lxb_html_tree_insertion_mode_foreign_content'] = wasmExports['lxb_html_tree_insertion_mode_foreign_content'];
  _lxb_html_tree_appropriate_place_inserting_node = Module['_lxb_html_tree_appropriate_place_inserting_node'] = wasmExports['lxb_html_tree_appropriate_place_inserting_node'];
  _lxb_html_tree_insert_foreign_element = Module['_lxb_html_tree_insert_foreign_element'] = wasmExports['lxb_html_tree_insert_foreign_element'];
  _lxb_html_tree_create_element_for_token = Module['_lxb_html_tree_create_element_for_token'] = wasmExports['lxb_html_tree_create_element_for_token'];
  _lxb_html_tree_append_attributes = Module['_lxb_html_tree_append_attributes'] = wasmExports['lxb_html_tree_append_attributes'];
  _lxb_html_tree_append_attributes_from_element = Module['_lxb_html_tree_append_attributes_from_element'] = wasmExports['lxb_html_tree_append_attributes_from_element'];
  _lxb_html_tree_adjust_mathml_attributes = Module['_lxb_html_tree_adjust_mathml_attributes'] = wasmExports['lxb_html_tree_adjust_mathml_attributes'];
  _lxb_html_tree_adjust_svg_attributes = Module['_lxb_html_tree_adjust_svg_attributes'] = wasmExports['lxb_html_tree_adjust_svg_attributes'];
  _lxb_html_tree_adjust_foreign_attributes = Module['_lxb_html_tree_adjust_foreign_attributes'] = wasmExports['lxb_html_tree_adjust_foreign_attributes'];
  _lxb_html_tree_insert_character = Module['_lxb_html_tree_insert_character'] = wasmExports['lxb_html_tree_insert_character'];
  _lxb_html_tree_insert_character_for_data = Module['_lxb_html_tree_insert_character_for_data'] = wasmExports['lxb_html_tree_insert_character_for_data'];
  _lxb_html_tree_insert_comment = Module['_lxb_html_tree_insert_comment'] = wasmExports['lxb_html_tree_insert_comment'];
  _lxb_html_tree_create_document_type_from_token = Module['_lxb_html_tree_create_document_type_from_token'] = wasmExports['lxb_html_tree_create_document_type_from_token'];
  _lxb_html_tree_node_delete_deep = Module['_lxb_html_tree_node_delete_deep'] = wasmExports['lxb_html_tree_node_delete_deep'];
  _lxb_html_tree_generic_rawtext_parsing = Module['_lxb_html_tree_generic_rawtext_parsing'] = wasmExports['lxb_html_tree_generic_rawtext_parsing'];
  _lxb_html_tree_insertion_mode_text = Module['_lxb_html_tree_insertion_mode_text'] = wasmExports['lxb_html_tree_insertion_mode_text'];
  _lxb_html_tree_generic_rcdata_parsing = Module['_lxb_html_tree_generic_rcdata_parsing'] = wasmExports['lxb_html_tree_generic_rcdata_parsing'];
  _lxb_html_tree_generate_implied_end_tags = Module['_lxb_html_tree_generate_implied_end_tags'] = wasmExports['lxb_html_tree_generate_implied_end_tags'];
  _lxb_html_tree_generate_all_implied_end_tags_thoroughly = Module['_lxb_html_tree_generate_all_implied_end_tags_thoroughly'] = wasmExports['lxb_html_tree_generate_all_implied_end_tags_thoroughly'];
  _lxb_html_tree_insertion_mode_in_body = Module['_lxb_html_tree_insertion_mode_in_body'] = wasmExports['lxb_html_tree_insertion_mode_in_body'];
  _lxb_html_tree_insertion_mode_in_select = Module['_lxb_html_tree_insertion_mode_in_select'] = wasmExports['lxb_html_tree_insertion_mode_in_select'];
  _lxb_html_tree_insertion_mode_in_select_in_table = Module['_lxb_html_tree_insertion_mode_in_select_in_table'] = wasmExports['lxb_html_tree_insertion_mode_in_select_in_table'];
  _lxb_html_tree_insertion_mode_in_cell = Module['_lxb_html_tree_insertion_mode_in_cell'] = wasmExports['lxb_html_tree_insertion_mode_in_cell'];
  _lxb_html_tree_insertion_mode_in_row = Module['_lxb_html_tree_insertion_mode_in_row'] = wasmExports['lxb_html_tree_insertion_mode_in_row'];
  _lxb_html_tree_insertion_mode_in_table_body = Module['_lxb_html_tree_insertion_mode_in_table_body'] = wasmExports['lxb_html_tree_insertion_mode_in_table_body'];
  _lxb_html_tree_insertion_mode_in_caption = Module['_lxb_html_tree_insertion_mode_in_caption'] = wasmExports['lxb_html_tree_insertion_mode_in_caption'];
  _lxb_html_tree_insertion_mode_in_column_group = Module['_lxb_html_tree_insertion_mode_in_column_group'] = wasmExports['lxb_html_tree_insertion_mode_in_column_group'];
  _lxb_html_tree_insertion_mode_in_table = Module['_lxb_html_tree_insertion_mode_in_table'] = wasmExports['lxb_html_tree_insertion_mode_in_table'];
  _lxb_html_tree_insertion_mode_in_head = Module['_lxb_html_tree_insertion_mode_in_head'] = wasmExports['lxb_html_tree_insertion_mode_in_head'];
  _lxb_html_tree_insertion_mode_in_frameset = Module['_lxb_html_tree_insertion_mode_in_frameset'] = wasmExports['lxb_html_tree_insertion_mode_in_frameset'];
  _lxb_html_tree_insertion_mode_before_head = Module['_lxb_html_tree_insertion_mode_before_head'] = wasmExports['lxb_html_tree_insertion_mode_before_head'];
  _lxb_html_tree_insertion_mode_after_head = Module['_lxb_html_tree_insertion_mode_after_head'] = wasmExports['lxb_html_tree_insertion_mode_after_head'];
  _lxb_html_tree_element_in_scope = Module['_lxb_html_tree_element_in_scope'] = wasmExports['lxb_html_tree_element_in_scope'];
  _lxb_html_tree_element_in_scope_by_node = Module['_lxb_html_tree_element_in_scope_by_node'] = wasmExports['lxb_html_tree_element_in_scope_by_node'];
  _lxb_html_tree_element_in_scope_h123456 = Module['_lxb_html_tree_element_in_scope_h123456'] = wasmExports['lxb_html_tree_element_in_scope_h123456'];
  _lxb_html_tree_element_in_scope_tbody_thead_tfoot = Module['_lxb_html_tree_element_in_scope_tbody_thead_tfoot'] = wasmExports['lxb_html_tree_element_in_scope_tbody_thead_tfoot'];
  _lxb_html_tree_element_in_scope_td_th = Module['_lxb_html_tree_element_in_scope_td_th'] = wasmExports['lxb_html_tree_element_in_scope_td_th'];
  _lxb_html_tree_check_scope_element = Module['_lxb_html_tree_check_scope_element'] = wasmExports['lxb_html_tree_check_scope_element'];
  _lxb_html_tree_close_p_element = Module['_lxb_html_tree_close_p_element'] = wasmExports['lxb_html_tree_close_p_element'];
  _lxb_html_tree_adoption_agency_algorithm = Module['_lxb_html_tree_adoption_agency_algorithm'] = wasmExports['lxb_html_tree_adoption_agency_algorithm'];
  _lxb_html_tree_open_elements_remove_by_node = Module['_lxb_html_tree_open_elements_remove_by_node'] = wasmExports['lxb_html_tree_open_elements_remove_by_node'];
  _lxb_html_tree_adjust_attributes_mathml = Module['_lxb_html_tree_adjust_attributes_mathml'] = wasmExports['lxb_html_tree_adjust_attributes_mathml'];
  _lxb_html_tree_adjust_attributes_svg = Module['_lxb_html_tree_adjust_attributes_svg'] = wasmExports['lxb_html_tree_adjust_attributes_svg'];
  _lxb_html_tree_insertion_mode_after_after_body = Module['_lxb_html_tree_insertion_mode_after_after_body'] = wasmExports['lxb_html_tree_insertion_mode_after_after_body'];
  _lxb_html_tree_insertion_mode_after_after_frameset = Module['_lxb_html_tree_insertion_mode_after_after_frameset'] = wasmExports['lxb_html_tree_insertion_mode_after_after_frameset'];
  _lxb_html_tree_insertion_mode_after_body = Module['_lxb_html_tree_insertion_mode_after_body'] = wasmExports['lxb_html_tree_insertion_mode_after_body'];
  _lxb_html_tree_insertion_mode_after_frameset = Module['_lxb_html_tree_insertion_mode_after_frameset'] = wasmExports['lxb_html_tree_insertion_mode_after_frameset'];
  _lxb_html_tree_insertion_mode_before_html = Module['_lxb_html_tree_insertion_mode_before_html'] = wasmExports['lxb_html_tree_insertion_mode_before_html'];
  _lxb_html_tree_insertion_mode_in_body_skip_new_line = Module['_lxb_html_tree_insertion_mode_in_body_skip_new_line'] = wasmExports['lxb_html_tree_insertion_mode_in_body_skip_new_line'];
  _lxb_html_tree_insertion_mode_in_body_skip_new_line_textarea = Module['_lxb_html_tree_insertion_mode_in_body_skip_new_line_textarea'] = wasmExports['lxb_html_tree_insertion_mode_in_body_skip_new_line_textarea'];
  _lxb_html_tree_insertion_mode_in_body_text_append = Module['_lxb_html_tree_insertion_mode_in_body_text_append'] = wasmExports['lxb_html_tree_insertion_mode_in_body_text_append'];
  _lxb_html_tree_insertion_mode_in_head_noscript = Module['_lxb_html_tree_insertion_mode_in_head_noscript'] = wasmExports['lxb_html_tree_insertion_mode_in_head_noscript'];
  _lxb_html_tree_insertion_mode_in_table_text = Module['_lxb_html_tree_insertion_mode_in_table_text'] = wasmExports['lxb_html_tree_insertion_mode_in_table_text'];
  _lxb_html_tree_insertion_mode_in_table_anything_else = Module['_lxb_html_tree_insertion_mode_in_table_anything_else'] = wasmExports['lxb_html_tree_insertion_mode_in_table_anything_else'];
  _lxb_ns_by_id = Module['_lxb_ns_by_id'] = wasmExports['lxb_ns_by_id'];
  _lxb_ns_data_by_link = Module['_lxb_ns_data_by_link'] = wasmExports['lxb_ns_data_by_link'];
  _lxb_punycode_encode = Module['_lxb_punycode_encode'] = wasmExports['lxb_punycode_encode'];
  _lxb_punycode_encode_cp = Module['_lxb_punycode_encode_cp'] = wasmExports['lxb_punycode_encode_cp'];
  _lxb_punycode_decode = Module['_lxb_punycode_decode'] = wasmExports['lxb_punycode_decode'];
  _lxb_punycode_decode_cb_cp = Module['_lxb_punycode_decode_cb_cp'] = wasmExports['lxb_punycode_decode_cb_cp'];
  _lxb_punycode_decode_cp = Module['_lxb_punycode_decode_cp'] = wasmExports['lxb_punycode_decode_cp'];
  _lxb_tag_name_by_id_noi = Module['_lxb_tag_name_by_id_noi'] = wasmExports['lxb_tag_name_by_id_noi'];
  _lxb_tag_name_upper_by_id_noi = Module['_lxb_tag_name_upper_by_id_noi'] = wasmExports['lxb_tag_name_upper_by_id_noi'];
  _lxb_tag_id_by_name_noi = Module['_lxb_tag_id_by_name_noi'] = wasmExports['lxb_tag_id_by_name_noi'];
  _lxb_tag_mraw_noi = Module['_lxb_tag_mraw_noi'] = wasmExports['lxb_tag_mraw_noi'];
  _lxb_unicode_idna_create = Module['_lxb_unicode_idna_create'] = wasmExports['lxb_unicode_idna_create'];
  _lxb_unicode_idna_init = Module['_lxb_unicode_idna_init'] = wasmExports['lxb_unicode_idna_init'];
  _lxb_unicode_normalizer_init = Module['_lxb_unicode_normalizer_init'] = wasmExports['lxb_unicode_normalizer_init'];
  _lxb_unicode_idna_clean = Module['_lxb_unicode_idna_clean'] = wasmExports['lxb_unicode_idna_clean'];
  _lxb_unicode_normalizer_clean = Module['_lxb_unicode_normalizer_clean'] = wasmExports['lxb_unicode_normalizer_clean'];
  _lxb_unicode_idna_destroy = Module['_lxb_unicode_idna_destroy'] = wasmExports['lxb_unicode_idna_destroy'];
  _lxb_unicode_normalizer_destroy = Module['_lxb_unicode_normalizer_destroy'] = wasmExports['lxb_unicode_normalizer_destroy'];
  _lxb_unicode_idna_processing = Module['_lxb_unicode_idna_processing'] = wasmExports['lxb_unicode_idna_processing'];
  _lxb_unicode_idna_type = Module['_lxb_unicode_idna_type'] = wasmExports['lxb_unicode_idna_type'];
  _lxb_unicode_idna_entry_by_cp = Module['_lxb_unicode_idna_entry_by_cp'] = wasmExports['lxb_unicode_idna_entry_by_cp'];
  _lxb_unicode_idna_map = Module['_lxb_unicode_idna_map'] = wasmExports['lxb_unicode_idna_map'];
  _lxb_unicode_quick_check_cp = Module['_lxb_unicode_quick_check_cp'] = wasmExports['lxb_unicode_quick_check_cp'];
  _lxb_unicode_normalize_cp = Module['_lxb_unicode_normalize_cp'] = wasmExports['lxb_unicode_normalize_cp'];
  _lxb_unicode_idna_processing_cp = Module['_lxb_unicode_idna_processing_cp'] = wasmExports['lxb_unicode_idna_processing_cp'];
  _lxb_unicode_idna_to_ascii = Module['_lxb_unicode_idna_to_ascii'] = wasmExports['lxb_unicode_idna_to_ascii'];
  _lxb_unicode_idna_to_ascii_cp = Module['_lxb_unicode_idna_to_ascii_cp'] = wasmExports['lxb_unicode_idna_to_ascii_cp'];
  _lxb_unicode_idna_validity_criteria = Module['_lxb_unicode_idna_validity_criteria'] = wasmExports['lxb_unicode_idna_validity_criteria'];
  _lxb_unicode_idna_validity_criteria_cp = Module['_lxb_unicode_idna_validity_criteria_cp'] = wasmExports['lxb_unicode_idna_validity_criteria_cp'];
  _lxb_unicode_idna_to_unicode = Module['_lxb_unicode_idna_to_unicode'] = wasmExports['lxb_unicode_idna_to_unicode'];
  _lxb_unicode_idna_to_unicode_cp = Module['_lxb_unicode_idna_to_unicode_cp'] = wasmExports['lxb_unicode_idna_to_unicode_cp'];
  _lxb_unicode_normalizer_create = Module['_lxb_unicode_normalizer_create'] = wasmExports['lxb_unicode_normalizer_create'];
  _lxb_unicode_normalization_form_set = Module['_lxb_unicode_normalization_form_set'] = wasmExports['lxb_unicode_normalization_form_set'];
  _lxb_unicode_composition_cp = Module['_lxb_unicode_composition_cp'] = wasmExports['lxb_unicode_composition_cp'];
  _lxb_unicode_flush = Module['_lxb_unicode_flush'] = wasmExports['lxb_unicode_flush'];
  _lxb_unicode_flush_cp = Module['_lxb_unicode_flush_cp'] = wasmExports['lxb_unicode_flush_cp'];
  _lxb_unicode_normalize = Module['_lxb_unicode_normalize'] = wasmExports['lxb_unicode_normalize'];
  _lxb_unicode_normalize_end = Module['_lxb_unicode_normalize_end'] = wasmExports['lxb_unicode_normalize_end'];
  _lxb_unicode_normalize_cp_end = Module['_lxb_unicode_normalize_cp_end'] = wasmExports['lxb_unicode_normalize_cp_end'];
  _lxb_unicode_quick_check = Module['_lxb_unicode_quick_check'] = wasmExports['lxb_unicode_quick_check'];
  _lxb_unicode_normalization_entry_by_cp = Module['_lxb_unicode_normalization_entry_by_cp'] = wasmExports['lxb_unicode_normalization_entry_by_cp'];
  _lxb_unicode_normalization_is_null = Module['_lxb_unicode_normalization_is_null'] = wasmExports['lxb_unicode_normalization_is_null'];
  _lxb_unicode_quick_check_end = Module['_lxb_unicode_quick_check_end'] = wasmExports['lxb_unicode_quick_check_end'];
  _lxb_unicode_quick_check_cp_end = Module['_lxb_unicode_quick_check_cp_end'] = wasmExports['lxb_unicode_quick_check_cp_end'];
  _lxb_unicode_compose_entry = Module['_lxb_unicode_compose_entry'] = wasmExports['lxb_unicode_compose_entry'];
  _lxb_unicode_entry = Module['_lxb_unicode_entry'] = wasmExports['lxb_unicode_entry'];
  _lxb_unicode_idna_entry = Module['_lxb_unicode_idna_entry'] = wasmExports['lxb_unicode_idna_entry'];
  _lxb_unicode_normalization_entry = Module['_lxb_unicode_normalization_entry'] = wasmExports['lxb_unicode_normalization_entry'];
  _lxb_unicode_normalization_entry_by_index = Module['_lxb_unicode_normalization_entry_by_index'] = wasmExports['lxb_unicode_normalization_entry_by_index'];
  _lxb_unicode_full_canonical = Module['_lxb_unicode_full_canonical'] = wasmExports['lxb_unicode_full_canonical'];
  _lxb_unicode_full_compatibility = Module['_lxb_unicode_full_compatibility'] = wasmExports['lxb_unicode_full_compatibility'];
  _lxb_unicode_idna_entry_by_index = Module['_lxb_unicode_idna_entry_by_index'] = wasmExports['lxb_unicode_idna_entry_by_index'];
  _lxb_url_parser_create = Module['_lxb_url_parser_create'] = wasmExports['lxb_url_parser_create'];
  _lxb_url_parser_init = Module['_lxb_url_parser_init'] = wasmExports['lxb_url_parser_init'];
  _lxb_url_parser_clean = Module['_lxb_url_parser_clean'] = wasmExports['lxb_url_parser_clean'];
  _lxb_url_parser_destroy = Module['_lxb_url_parser_destroy'] = wasmExports['lxb_url_parser_destroy'];
  _lxb_url_parser_memory_destroy = Module['_lxb_url_parser_memory_destroy'] = wasmExports['lxb_url_parser_memory_destroy'];
  _lxb_url_parse = Module['_lxb_url_parse'] = wasmExports['lxb_url_parse'];
  _lxb_url_erase = Module['_lxb_url_erase'] = wasmExports['lxb_url_erase'];
  _lxb_url_parse_basic = Module['_lxb_url_parse_basic'] = wasmExports['lxb_url_parse_basic'];
  _lxb_url_destroy = Module['_lxb_url_destroy'] = wasmExports['lxb_url_destroy'];
  _lxb_url_memory_destroy = Module['_lxb_url_memory_destroy'] = wasmExports['lxb_url_memory_destroy'];
  _lxb_url_api_href_set = Module['_lxb_url_api_href_set'] = wasmExports['lxb_url_api_href_set'];
  _lxb_url_api_protocol_set = Module['_lxb_url_api_protocol_set'] = wasmExports['lxb_url_api_protocol_set'];
  _lxb_url_api_username_set = Module['_lxb_url_api_username_set'] = wasmExports['lxb_url_api_username_set'];
  _lxb_url_api_password_set = Module['_lxb_url_api_password_set'] = wasmExports['lxb_url_api_password_set'];
  _lxb_url_api_host_set = Module['_lxb_url_api_host_set'] = wasmExports['lxb_url_api_host_set'];
  _lxb_url_api_hostname_set = Module['_lxb_url_api_hostname_set'] = wasmExports['lxb_url_api_hostname_set'];
  _lxb_url_api_port_set = Module['_lxb_url_api_port_set'] = wasmExports['lxb_url_api_port_set'];
  _lxb_url_api_pathname_set = Module['_lxb_url_api_pathname_set'] = wasmExports['lxb_url_api_pathname_set'];
  _lxb_url_api_search_set = Module['_lxb_url_api_search_set'] = wasmExports['lxb_url_api_search_set'];
  _lxb_url_api_hash_set = Module['_lxb_url_api_hash_set'] = wasmExports['lxb_url_api_hash_set'];
  _lxb_url_serialize = Module['_lxb_url_serialize'] = wasmExports['lxb_url_serialize'];
  _lxb_url_serialize_host_unicode = Module['_lxb_url_serialize_host_unicode'] = wasmExports['lxb_url_serialize_host_unicode'];
  _lxb_url_serialize_host = Module['_lxb_url_serialize_host'] = wasmExports['lxb_url_serialize_host'];
  _lxb_url_serialize_idna = Module['_lxb_url_serialize_idna'] = wasmExports['lxb_url_serialize_idna'];
  _lxb_url_serialize_scheme = Module['_lxb_url_serialize_scheme'] = wasmExports['lxb_url_serialize_scheme'];
  _lxb_url_serialize_username = Module['_lxb_url_serialize_username'] = wasmExports['lxb_url_serialize_username'];
  _lxb_url_serialize_password = Module['_lxb_url_serialize_password'] = wasmExports['lxb_url_serialize_password'];
  _lxb_url_serialize_host_ipv6 = Module['_lxb_url_serialize_host_ipv6'] = wasmExports['lxb_url_serialize_host_ipv6'];
  _lxb_url_serialize_host_ipv4 = Module['_lxb_url_serialize_host_ipv4'] = wasmExports['lxb_url_serialize_host_ipv4'];
  _lxb_url_serialize_port = Module['_lxb_url_serialize_port'] = wasmExports['lxb_url_serialize_port'];
  _lxb_url_serialize_path = Module['_lxb_url_serialize_path'] = wasmExports['lxb_url_serialize_path'];
  _lxb_url_serialize_query = Module['_lxb_url_serialize_query'] = wasmExports['lxb_url_serialize_query'];
  _lxb_url_serialize_fragment = Module['_lxb_url_serialize_fragment'] = wasmExports['lxb_url_serialize_fragment'];
  _lxb_url_clone = Module['_lxb_url_clone'] = wasmExports['lxb_url_clone'];
  _lxb_url_search_params_init = Module['_lxb_url_search_params_init'] = wasmExports['lxb_url_search_params_init'];
  _lxb_url_search_params_destroy = Module['_lxb_url_search_params_destroy'] = wasmExports['lxb_url_search_params_destroy'];
  _lxb_url_search_params_append = Module['_lxb_url_search_params_append'] = wasmExports['lxb_url_search_params_append'];
  _lxb_url_search_params_delete = Module['_lxb_url_search_params_delete'] = wasmExports['lxb_url_search_params_delete'];
  _lxb_url_search_params_match = Module['_lxb_url_search_params_match'] = wasmExports['lxb_url_search_params_match'];
  _lxb_url_search_params_get_entry = Module['_lxb_url_search_params_get_entry'] = wasmExports['lxb_url_search_params_get_entry'];
  _lxb_url_search_params_get = Module['_lxb_url_search_params_get'] = wasmExports['lxb_url_search_params_get'];
  _lxb_url_search_params_get_all = Module['_lxb_url_search_params_get_all'] = wasmExports['lxb_url_search_params_get_all'];
  _lxb_url_search_params_get_count = Module['_lxb_url_search_params_get_count'] = wasmExports['lxb_url_search_params_get_count'];
  _lxb_url_search_params_match_entry = Module['_lxb_url_search_params_match_entry'] = wasmExports['lxb_url_search_params_match_entry'];
  _lxb_url_search_params_has = Module['_lxb_url_search_params_has'] = wasmExports['lxb_url_search_params_has'];
  _lxb_url_search_params_set = Module['_lxb_url_search_params_set'] = wasmExports['lxb_url_search_params_set'];
  _lxb_url_search_params_sort = Module['_lxb_url_search_params_sort'] = wasmExports['lxb_url_search_params_sort'];
  _lxb_url_search_params_serialize = Module['_lxb_url_search_params_serialize'] = wasmExports['lxb_url_search_params_serialize'];
  _mbstr_treat_data = Module['_mbstr_treat_data'] = wasmExports['mbstr_treat_data'];
  _sapi_register_treat_data = Module['_sapi_register_treat_data'] = wasmExports['sapi_register_treat_data'];
  _sapi_register_post_entries = Module['_sapi_register_post_entries'] = wasmExports['sapi_register_post_entries'];
  _zend_multibyte_set_functions = Module['_zend_multibyte_set_functions'] = wasmExports['zend_multibyte_set_functions'];
  _php_rfc1867_set_multibyte_callbacks = Module['_php_rfc1867_set_multibyte_callbacks'] = wasmExports['php_rfc1867_set_multibyte_callbacks'];
  _zend_multibyte_restore_functions = Module['_zend_multibyte_restore_functions'] = wasmExports['zend_multibyte_restore_functions'];
  _mbfl_no2encoding = Module['_mbfl_no2encoding'] = wasmExports['mbfl_no2encoding'];
  _zend_multibyte_set_internal_encoding = Module['_zend_multibyte_set_internal_encoding'] = wasmExports['zend_multibyte_set_internal_encoding'];
  _php_info_print_table_header = Module['_php_info_print_table_header'] = wasmExports['php_info_print_table_header'];
  _mbfl_name2encoding = Module['_mbfl_name2encoding'] = wasmExports['mbfl_name2encoding'];
  _mbfl_name2encoding_ex = Module['_mbfl_name2encoding_ex'] = wasmExports['mbfl_name2encoding_ex'];
  _php_mb_safe_strrchr = Module['_php_mb_safe_strrchr'] = wasmExports['php_mb_safe_strrchr'];
  _mbfl_no_language2name = Module['_mbfl_no_language2name'] = wasmExports['mbfl_no_language2name'];
  ___zend_calloc = Module['___zend_calloc'] = wasmExports['__zend_calloc'];
  _zend_parse_arg_str_or_long_slow = Module['_zend_parse_arg_str_or_long_slow'] = wasmExports['zend_parse_arg_str_or_long_slow'];
  _mbfl_encoding_preferred_mime_name = Module['_mbfl_encoding_preferred_mime_name'] = wasmExports['mbfl_encoding_preferred_mime_name'];
  _mb_fast_convert = Module['_mb_fast_convert'] = wasmExports['mb_fast_convert'];
  _zend_memnrstr_ex = Module['_zend_memnrstr_ex'] = wasmExports['zend_memnrstr_ex'];
  _php_mb_stripos = Module['_php_mb_stripos'] = wasmExports['php_mb_stripos'];
  _php_unicode_convert_case = Module['_php_unicode_convert_case'] = wasmExports['php_unicode_convert_case'];
  _mbfl_strcut = Module['_mbfl_strcut'] = wasmExports['mbfl_strcut'];
  _php_mb_convert_encoding_ex = Module['_php_mb_convert_encoding_ex'] = wasmExports['php_mb_convert_encoding_ex'];
  _php_mb_convert_encoding = Module['_php_mb_convert_encoding'] = wasmExports['php_mb_convert_encoding'];
  _mb_guess_encoding_for_strings = Module['_mb_guess_encoding_for_strings'] = wasmExports['mb_guess_encoding_for_strings'];
  _php_mb_convert_encoding_recursive = Module['_php_mb_convert_encoding_recursive'] = wasmExports['php_mb_convert_encoding_recursive'];
  _zend_hash_index_add = Module['_zend_hash_index_add'] = wasmExports['zend_hash_index_add'];
  _php_mb_check_encoding = Module['_php_mb_check_encoding'] = wasmExports['php_mb_check_encoding'];
  _mbfl_get_supported_encodings = Module['_mbfl_get_supported_encodings'] = wasmExports['mbfl_get_supported_encodings'];
  _zend_lazy_object_get_property_info_for_slot = Module['_zend_lazy_object_get_property_info_for_slot'] = wasmExports['zend_lazy_object_get_property_info_for_slot'];
  _zend_get_property_info_for_slot_slow = Module['_zend_get_property_info_for_slot_slow'] = wasmExports['zend_get_property_info_for_slot_slow'];
  _zend_ref_del_type_source = Module['_zend_ref_del_type_source'] = wasmExports['zend_ref_del_type_source'];
  _zval_try_get_long = Module['_zval_try_get_long'] = wasmExports['zval_try_get_long'];
  _mbfl_no2language = Module['_mbfl_no2language'] = wasmExports['mbfl_no2language'];
  _php_mail_build_headers = Module['_php_mail_build_headers'] = wasmExports['php_mail_build_headers'];
  _php_trim = Module['_php_trim'] = wasmExports['php_trim'];
  _zend_str_tolower = Module['_zend_str_tolower'] = wasmExports['zend_str_tolower'];
  _zend_ini_str_ex = Module['_zend_ini_str_ex'] = wasmExports['zend_ini_str_ex'];
  _php_escape_shell_cmd = Module['_php_escape_shell_cmd'] = wasmExports['php_escape_shell_cmd'];
  _php_mail = Module['_php_mail'] = wasmExports['php_mail'];
  _zend_ini_str = Module['_zend_ini_str'] = wasmExports['zend_ini_str'];
  _mbfl_no_encoding2name = Module['_mbfl_no_encoding2name'] = wasmExports['mbfl_no_encoding2name'];
  _php_mb_mbchar_bytes = Module['_php_mb_mbchar_bytes'] = wasmExports['php_mb_mbchar_bytes'];
  _mbfl_name2no_language = Module['_mbfl_name2no_language'] = wasmExports['mbfl_name2no_language'];
  _OnUpdateBool = Module['_OnUpdateBool'] = wasmExports['OnUpdateBool'];
  _sapi_unregister_post_entry = Module['_sapi_unregister_post_entry'] = wasmExports['sapi_unregister_post_entry'];
  _sapi_read_standard_form_data = Module['_sapi_read_standard_form_data'] = wasmExports['sapi_read_standard_form_data'];
  _rfc1867_post_handler = Module['_rfc1867_post_handler'] = wasmExports['rfc1867_post_handler'];
  _zend_ini_boolean_displayer_cb = Module['_zend_ini_boolean_displayer_cb'] = wasmExports['zend_ini_boolean_displayer_cb'];
  _php_std_post_handler = Module['_php_std_post_handler'] = wasmExports['php_std_post_handler'];
  _php_unicode_is_prop1 = Module['_php_unicode_is_prop1'] = wasmExports['php_unicode_is_prop1'];
  _php_unicode_is_prop = Module['_php_unicode_is_prop'] = wasmExports['php_unicode_is_prop'];
  _php_default_treat_data = Module['_php_default_treat_data'] = wasmExports['php_default_treat_data'];
  _sapi_handle_post = Module['_sapi_handle_post'] = wasmExports['sapi_handle_post'];
  _php_url_decode = Module['_php_url_decode'] = wasmExports['php_url_decode'];
  _php_register_variable_safe = Module['_php_register_variable_safe'] = wasmExports['php_register_variable_safe'];
  __php_stream_copy_to_mem = Module['__php_stream_copy_to_mem'] = wasmExports['_php_stream_copy_to_mem'];
  _add_index_stringl = Module['_add_index_stringl'] = wasmExports['add_index_stringl'];
  _add_index_bool = Module['_add_index_bool'] = wasmExports['add_index_bool'];
  _zend_make_compiled_string_description = Module['_zend_make_compiled_string_description'] = wasmExports['zend_make_compiled_string_description'];
  _mbfl_filt_conv_illegal_output = Module['_mbfl_filt_conv_illegal_output'] = wasmExports['mbfl_filt_conv_illegal_output'];
  _mb_illegal_output = Module['_mb_illegal_output'] = wasmExports['mb_illegal_output'];
  _mbfl_filt_conv_common_ctor = Module['_mbfl_filt_conv_common_ctor'] = wasmExports['mbfl_filt_conv_common_ctor'];
  _mbfl_filt_conv_common_flush = Module['_mbfl_filt_conv_common_flush'] = wasmExports['mbfl_filt_conv_common_flush'];
  _mbfl_string_init = Module['_mbfl_string_init'] = wasmExports['mbfl_string_init'];
  _mbfl_memory_device_output = Module['_mbfl_memory_device_output'] = wasmExports['mbfl_memory_device_output'];
  _mbfl_convert_filter_new = Module['_mbfl_convert_filter_new'] = wasmExports['mbfl_convert_filter_new'];
  _mbfl_filter_output_null = Module['_mbfl_filter_output_null'] = wasmExports['mbfl_filter_output_null'];
  _mbfl_convert_filter_delete = Module['_mbfl_convert_filter_delete'] = wasmExports['mbfl_convert_filter_delete'];
  _mbfl_memory_device_init = Module['_mbfl_memory_device_init'] = wasmExports['mbfl_memory_device_init'];
  _mbfl_convert_filter_copy = Module['_mbfl_convert_filter_copy'] = wasmExports['mbfl_convert_filter_copy'];
  _mbfl_memory_device_result = Module['_mbfl_memory_device_result'] = wasmExports['mbfl_memory_device_result'];
  _mbfl_filt_conv_pass = Module['_mbfl_filt_conv_pass'] = wasmExports['mbfl_filt_conv_pass'];
  _mbfl_convert_filter_get_vtbl = Module['_mbfl_convert_filter_get_vtbl'] = wasmExports['mbfl_convert_filter_get_vtbl'];
  __emalloc_64 = Module['__emalloc_64'] = wasmExports['_emalloc_64'];
  _mbfl_convert_filter_new2 = Module['_mbfl_convert_filter_new2'] = wasmExports['mbfl_convert_filter_new2'];
  _mbfl_convert_filter_feed = Module['_mbfl_convert_filter_feed'] = wasmExports['mbfl_convert_filter_feed'];
  _mbfl_convert_filter_feed_string = Module['_mbfl_convert_filter_feed_string'] = wasmExports['mbfl_convert_filter_feed_string'];
  _mbfl_convert_filter_flush = Module['_mbfl_convert_filter_flush'] = wasmExports['mbfl_convert_filter_flush'];
  _mbfl_convert_filter_reset = Module['_mbfl_convert_filter_reset'] = wasmExports['mbfl_convert_filter_reset'];
  _mbfl_convert_filter_devcat = Module['_mbfl_convert_filter_devcat'] = wasmExports['mbfl_convert_filter_devcat'];
  _mbfl_convert_filter_strcat = Module['_mbfl_convert_filter_strcat'] = wasmExports['mbfl_convert_filter_strcat'];
  _mbfl_filter_output_pipe = Module['_mbfl_filter_output_pipe'] = wasmExports['mbfl_filter_output_pipe'];
  _mbfl_name2language = Module['_mbfl_name2language'] = wasmExports['mbfl_name2language'];
  _mbfl_memory_device_realloc = Module['_mbfl_memory_device_realloc'] = wasmExports['mbfl_memory_device_realloc'];
  _mbfl_memory_device_clear = Module['_mbfl_memory_device_clear'] = wasmExports['mbfl_memory_device_clear'];
  _mbfl_memory_device_reset = Module['_mbfl_memory_device_reset'] = wasmExports['mbfl_memory_device_reset'];
  _mbfl_memory_device_unput = Module['_mbfl_memory_device_unput'] = wasmExports['mbfl_memory_device_unput'];
  _mbfl_memory_device_strcat = Module['_mbfl_memory_device_strcat'] = wasmExports['mbfl_memory_device_strcat'];
  _mbfl_memory_device_strncat = Module['_mbfl_memory_device_strncat'] = wasmExports['mbfl_memory_device_strncat'];
  _mbfl_memory_device_devcat = Module['_mbfl_memory_device_devcat'] = wasmExports['mbfl_memory_device_devcat'];
  _mbfl_wchar_device_init = Module['_mbfl_wchar_device_init'] = wasmExports['mbfl_wchar_device_init'];
  _mbfl_wchar_device_clear = Module['_mbfl_wchar_device_clear'] = wasmExports['mbfl_wchar_device_clear'];
  _mbfl_wchar_device_output = Module['_mbfl_wchar_device_output'] = wasmExports['mbfl_wchar_device_output'];
  _mbfl_string_init_set = Module['_mbfl_string_init_set'] = wasmExports['mbfl_string_init_set'];
  _mbfl_string_clear = Module['_mbfl_string_clear'] = wasmExports['mbfl_string_clear'];
  _opcache_preloading = Module['_opcache_preloading'] = wasmExports['opcache_preloading'];
  _php_glob = Module['_php_glob'] = wasmExports['php_glob'];
  _tsrm_realpath = Module['_tsrm_realpath'] = wasmExports['tsrm_realpath'];
  _zend_dirname = Module['_zend_dirname'] = wasmExports['zend_dirname'];
  _zend_strndup = Module['_zend_strndup'] = wasmExports['zend_strndup'];
  _expand_filepath_ex = Module['_expand_filepath_ex'] = wasmExports['expand_filepath_ex'];
  _expand_filepath = Module['_expand_filepath'] = wasmExports['expand_filepath'];
  _php_globfree = Module['_php_globfree'] = wasmExports['php_globfree'];
  __zend_bailout = Module['__zend_bailout'] = wasmExports['_zend_bailout'];
  _zend_string_hash_func = Module['_zend_string_hash_func'] = wasmExports['zend_string_hash_func'];
  _zend_hash_str_find_ptr_lc = Module['_zend_hash_str_find_ptr_lc'] = wasmExports['zend_hash_str_find_ptr_lc'];
  _setTempRet0 = Module['_setTempRet0'] = wasmExports['setTempRet0'];
  _getTempRet0 = Module['_getTempRet0'] = wasmExports['getTempRet0'];
  _zend_stream_init_filename_ex = Module['_zend_stream_init_filename_ex'] = wasmExports['zend_stream_init_filename_ex'];
  _destroy_op_array = Module['_destroy_op_array'] = wasmExports['destroy_op_array'];
  _zend_destroy_file_handle = Module['_zend_destroy_file_handle'] = wasmExports['zend_destroy_file_handle'];
  _zend_ini_parse_bool = Module['_zend_ini_parse_bool'] = wasmExports['zend_ini_parse_bool'];
  _zend_ini_parse_quantity_warn = Module['_zend_ini_parse_quantity_warn'] = wasmExports['zend_ini_parse_quantity_warn'];
  _OnUpdateStringUnempty = Module['_OnUpdateStringUnempty'] = wasmExports['OnUpdateStringUnempty'];
  _zend_function_dtor = Module['_zend_function_dtor'] = wasmExports['zend_function_dtor'];
  _destroy_zend_class = Module['_destroy_zend_class'] = wasmExports['destroy_zend_class'];
  _zend_hash_extend = Module['_zend_hash_extend'] = wasmExports['zend_hash_extend'];
  _zend_hash_del_bucket = Module['_zend_hash_del_bucket'] = wasmExports['zend_hash_del_bucket'];
  _zend_map_ptr_extend = Module['_zend_map_ptr_extend'] = wasmExports['zend_map_ptr_extend'];
  _zend_mangle_property_name = Module['_zend_mangle_property_name'] = wasmExports['zend_mangle_property_name'];
  _zend_hash_find_known_hash = Module['_zend_hash_find_known_hash'] = wasmExports['zend_hash_find_known_hash'];
  _zend_set_compiled_filename = Module['_zend_set_compiled_filename'] = wasmExports['zend_set_compiled_filename'];
  _zend_class_redeclaration_error = Module['_zend_class_redeclaration_error'] = wasmExports['zend_class_redeclaration_error'];
  _zend_try_early_bind = Module['_zend_try_early_bind'] = wasmExports['zend_try_early_bind'];
  __zend_observer_function_declared_notify = Module['__zend_observer_function_declared_notify'] = wasmExports['_zend_observer_function_declared_notify'];
  __zend_observer_class_linked_notify = Module['__zend_observer_class_linked_notify'] = wasmExports['_zend_observer_class_linked_notify'];
  _zend_vm_set_opcode_handler = Module['_zend_vm_set_opcode_handler'] = wasmExports['zend_vm_set_opcode_handler'];
  _zend_serialize_opcode_handler = Module['_zend_serialize_opcode_handler'] = wasmExports['zend_serialize_opcode_handler'];
  _zend_alloc_ce_cache = Module['_zend_alloc_ce_cache'] = wasmExports['zend_alloc_ce_cache'];
  _zend_map_ptr_new = Module['_zend_map_ptr_new'] = wasmExports['zend_map_ptr_new'];
  _zend_hooked_object_get_iterator = Module['_zend_hooked_object_get_iterator'] = wasmExports['zend_hooked_object_get_iterator'];
  _zend_deserialize_opcode_handler = Module['_zend_deserialize_opcode_handler'] = wasmExports['zend_deserialize_opcode_handler'];
  _zend_hash_rehash = Module['_zend_hash_rehash'] = wasmExports['zend_hash_rehash'];
  _zend_extensions_op_array_persist_calc = Module['_zend_extensions_op_array_persist_calc'] = wasmExports['zend_extensions_op_array_persist_calc'];
  _zend_map_ptr_new_static = Module['_zend_map_ptr_new_static'] = wasmExports['zend_map_ptr_new_static'];
  _gc_remove_from_buffer = Module['_gc_remove_from_buffer'] = wasmExports['gc_remove_from_buffer'];
  _zend_class_implements_interface = Module['_zend_class_implements_interface'] = wasmExports['zend_class_implements_interface'];
  _zend_vm_set_opcode_handler_ex = Module['_zend_vm_set_opcode_handler_ex'] = wasmExports['zend_vm_set_opcode_handler_ex'];
  _zend_extensions_op_array_persist = Module['_zend_extensions_op_array_persist'] = wasmExports['zend_extensions_op_array_persist'];
  _zend_hash_clean = Module['_zend_hash_clean'] = wasmExports['zend_hash_clean'];
  _zend_hash_discard = Module['_zend_hash_discard'] = wasmExports['zend_hash_discard'];
  _zend_signal_handler_unblock = Module['_zend_signal_handler_unblock'] = wasmExports['zend_signal_handler_unblock'];
  _zend_get_executed_filename_ex = Module['_zend_get_executed_filename_ex'] = wasmExports['zend_get_executed_filename_ex'];
  _zend_message_dispatcher = Module['_zend_message_dispatcher'] = wasmExports['zend_message_dispatcher'];
  _zend_begin_record_errors = Module['_zend_begin_record_errors'] = wasmExports['zend_begin_record_errors'];
  _gc_enable = Module['_gc_enable'] = wasmExports['gc_enable'];
  _zend_emit_recorded_errors = Module['_zend_emit_recorded_errors'] = wasmExports['zend_emit_recorded_errors'];
  _zend_free_recorded_errors = Module['_zend_free_recorded_errors'] = wasmExports['zend_free_recorded_errors'];
  _zend_hash_index_del = Module['_zend_hash_index_del'] = wasmExports['zend_hash_index_del'];
  _zend_emit_recorded_errors_ex = Module['_zend_emit_recorded_errors_ex'] = wasmExports['zend_emit_recorded_errors_ex'];
  _zend_hash_add_empty_element = Module['_zend_hash_add_empty_element'] = wasmExports['zend_hash_add_empty_element'];
  __php_stream_stat_path = Module['__php_stream_stat_path'] = wasmExports['_php_stream_stat_path'];
  _zend_optimize_script = Module['_zend_optimize_script'] = wasmExports['zend_optimize_script'];
  _sapi_get_request_time = Module['_sapi_get_request_time'] = wasmExports['sapi_get_request_time'];
  _zend_alter_ini_entry_chars = Module['_zend_alter_ini_entry_chars'] = wasmExports['zend_alter_ini_entry_chars'];
  _zend_map_ptr_reset = Module['_zend_map_ptr_reset'] = wasmExports['zend_map_ptr_reset'];
  _realpath_cache_clean = Module['_realpath_cache_clean'] = wasmExports['realpath_cache_clean'];
  _zend_register_extension = Module['_zend_register_extension'] = wasmExports['zend_register_extension'];
  _zend_llist_del_element = Module['_zend_llist_del_element'] = wasmExports['zend_llist_del_element'];
  _zend_interned_strings_set_request_storage_handlers = Module['_zend_interned_strings_set_request_storage_handlers'] = wasmExports['zend_interned_strings_set_request_storage_handlers'];
  _php_child_init = Module['_php_child_init'] = wasmExports['php_child_init'];
  _zend_lookup_class_ex = Module['_zend_lookup_class_ex'] = wasmExports['zend_lookup_class_ex'];
  _zend_hash_del = Module['_zend_hash_del'] = wasmExports['zend_hash_del'];
  _php_get_stream_filters_hash_global = Module['_php_get_stream_filters_hash_global'] = wasmExports['php_get_stream_filters_hash_global'];
  _php_stream_get_url_stream_wrappers_hash_global = Module['_php_stream_get_url_stream_wrappers_hash_global'] = wasmExports['php_stream_get_url_stream_wrappers_hash_global'];
  _php_stream_xport_get_hash = Module['_php_stream_xport_get_hash'] = wasmExports['php_stream_xport_get_hash'];
  _zend_internal_run_time_cache_reserved_size = Module['_zend_internal_run_time_cache_reserved_size'] = wasmExports['zend_internal_run_time_cache_reserved_size'];
  _zend_interned_strings_switch_storage = Module['_zend_interned_strings_switch_storage'] = wasmExports['zend_interned_strings_switch_storage'];
  _php_request_startup = Module['_php_request_startup'] = wasmExports['php_request_startup'];
  _php_output_set_status = Module['_php_output_set_status'] = wasmExports['php_output_set_status'];
  _php_request_shutdown = Module['_php_request_shutdown'] = wasmExports['php_request_shutdown'];
  _sapi_activate = Module['_sapi_activate'] = wasmExports['sapi_activate'];
  _zend_stream_init_filename = Module['_zend_stream_init_filename'] = wasmExports['zend_stream_init_filename'];
  _zend_execute = Module['_zend_execute'] = wasmExports['zend_execute'];
  _zend_exception_restore = Module['_zend_exception_restore'] = wasmExports['zend_exception_restore'];
  _zend_user_exception_handler = Module['_zend_user_exception_handler'] = wasmExports['zend_user_exception_handler'];
  _zend_exception_error = Module['_zend_exception_error'] = wasmExports['zend_exception_error'];
  __efree_160 = Module['__efree_160'] = wasmExports['_efree_160'];
  _php_call_shutdown_functions = Module['_php_call_shutdown_functions'] = wasmExports['php_call_shutdown_functions'];
  _zend_call_destructors = Module['_zend_call_destructors'] = wasmExports['zend_call_destructors'];
  _php_output_end_all = Module['_php_output_end_all'] = wasmExports['php_output_end_all'];
  _php_free_shutdown_functions = Module['_php_free_shutdown_functions'] = wasmExports['php_free_shutdown_functions'];
  _zend_shutdown_executor_values = Module['_zend_shutdown_executor_values'] = wasmExports['zend_shutdown_executor_values'];
  _init_op_array = Module['_init_op_array'] = wasmExports['init_op_array'];
  _zend_hash_sort_ex = Module['_zend_hash_sort_ex'] = wasmExports['zend_hash_sort_ex'];
  _zend_do_link_class = Module['_zend_do_link_class'] = wasmExports['zend_do_link_class'];
  _zend_hash_set_bucket_key = Module['_zend_hash_set_bucket_key'] = wasmExports['zend_hash_set_bucket_key'];
  _zend_update_class_constant = Module['_zend_update_class_constant'] = wasmExports['zend_update_class_constant'];
  _zval_update_constant_ex = Module['_zval_update_constant_ex'] = wasmExports['zval_update_constant_ex'];
  _zend_error_at = Module['_zend_error_at'] = wasmExports['zend_error_at'];
  _zend_register_internal_enum = Module['_zend_register_internal_enum'] = wasmExports['zend_register_internal_enum'];
  _zend_enum_add_case_cstr = Module['_zend_enum_add_case_cstr'] = wasmExports['zend_enum_add_case_cstr'];
  _php_add_tick_function = Module['_php_add_tick_function'] = wasmExports['php_add_tick_function'];
  __try_convert_to_string = Module['__try_convert_to_string'] = wasmExports['_try_convert_to_string'];
  _zend_long_to_str = Module['_zend_long_to_str'] = wasmExports['zend_long_to_str'];
  _zend_fiber_switch_block = Module['_zend_fiber_switch_block'] = wasmExports['zend_fiber_switch_block'];
  _zend_fiber_switch_unblock = Module['_zend_fiber_switch_unblock'] = wasmExports['zend_fiber_switch_unblock'];
  _zend_sigaction = Module['_zend_sigaction'] = wasmExports['zend_sigaction'];
  _php_random_bytes_ex = Module['_php_random_bytes_ex'] = wasmExports['php_random_bytes_ex'];
  _php_random_bytes = Module['_php_random_bytes'] = wasmExports['php_random_bytes'];
  _php_random_int = Module['_php_random_int'] = wasmExports['php_random_int'];
  _php_random_csprng_shutdown = Module['_php_random_csprng_shutdown'] = wasmExports['php_random_csprng_shutdown'];
  _zend_atomic_int_exchange = Module['_zend_atomic_int_exchange'] = wasmExports['zend_atomic_int_exchange'];
  _php_random_mt19937_seed32 = Module['_php_random_mt19937_seed32'] = wasmExports['php_random_mt19937_seed32'];
  _php_random_range = Module['_php_random_range'] = wasmExports['php_random_range'];
  _php_random_bin2hex_le = Module['_php_random_bin2hex_le'] = wasmExports['php_random_bin2hex_le'];
  _php_random_hex2bin_le = Module['_php_random_hex2bin_le'] = wasmExports['php_random_hex2bin_le'];
  _php_random_mt19937_seed_default = Module['_php_random_mt19937_seed_default'] = wasmExports['php_random_mt19937_seed_default'];
  _php_random_generate_fallback_seed = Module['_php_random_generate_fallback_seed'] = wasmExports['php_random_generate_fallback_seed'];
  _php_random_pcgoneseq128xslrr64_seed128 = Module['_php_random_pcgoneseq128xslrr64_seed128'] = wasmExports['php_random_pcgoneseq128xslrr64_seed128'];
  _php_random_pcgoneseq128xslrr64_advance = Module['_php_random_pcgoneseq128xslrr64_advance'] = wasmExports['php_random_pcgoneseq128xslrr64_advance'];
  _php_random_xoshiro256starstar_seed256 = Module['_php_random_xoshiro256starstar_seed256'] = wasmExports['php_random_xoshiro256starstar_seed256'];
  _php_random_xoshiro256starstar_seed64 = Module['_php_random_xoshiro256starstar_seed64'] = wasmExports['php_random_xoshiro256starstar_seed64'];
  _php_random_xoshiro256starstar_jump = Module['_php_random_xoshiro256starstar_jump'] = wasmExports['php_random_xoshiro256starstar_jump'];
  _php_random_xoshiro256starstar_jump_long = Module['_php_random_xoshiro256starstar_jump_long'] = wasmExports['php_random_xoshiro256starstar_jump_long'];
  _php_random_gammasection_closed_open = Module['_php_random_gammasection_closed_open'] = wasmExports['php_random_gammasection_closed_open'];
  _php_random_range64 = Module['_php_random_range64'] = wasmExports['php_random_range64'];
  _php_random_gammasection_closed_closed = Module['_php_random_gammasection_closed_closed'] = wasmExports['php_random_gammasection_closed_closed'];
  _php_random_gammasection_open_closed = Module['_php_random_gammasection_open_closed'] = wasmExports['php_random_gammasection_open_closed'];
  _php_random_gammasection_open_open = Module['_php_random_gammasection_open_open'] = wasmExports['php_random_gammasection_open_open'];
  _php_random_range32 = Module['_php_random_range32'] = wasmExports['php_random_range32'];
  _php_random_status_alloc = Module['_php_random_status_alloc'] = wasmExports['php_random_status_alloc'];
  _php_random_status_copy = Module['_php_random_status_copy'] = wasmExports['php_random_status_copy'];
  _php_random_status_free = Module['_php_random_status_free'] = wasmExports['php_random_status_free'];
  _php_random_engine_common_init = Module['_php_random_engine_common_init'] = wasmExports['php_random_engine_common_init'];
  _php_random_engine_common_free_object = Module['_php_random_engine_common_free_object'] = wasmExports['php_random_engine_common_free_object'];
  _php_random_engine_common_clone_object = Module['_php_random_engine_common_clone_object'] = wasmExports['php_random_engine_common_clone_object'];
  _php_random_default_algo = Module['_php_random_default_algo'] = wasmExports['php_random_default_algo'];
  _php_random_default_status = Module['_php_random_default_status'] = wasmExports['php_random_default_status'];
  _php_combined_lcg = Module['_php_combined_lcg'] = wasmExports['php_combined_lcg'];
  _php_random_generate_fallback_seed_ex = Module['_php_random_generate_fallback_seed_ex'] = wasmExports['php_random_generate_fallback_seed_ex'];
  _php_mt_srand = Module['_php_mt_srand'] = wasmExports['php_mt_srand'];
  _php_mt_rand = Module['_php_mt_rand'] = wasmExports['php_mt_rand'];
  _php_mt_rand_range = Module['_php_mt_rand_range'] = wasmExports['php_mt_rand_range'];
  _php_mt_rand_common = Module['_php_mt_rand_common'] = wasmExports['php_mt_rand_common'];
  _zend_objects_store_del = Module['_zend_objects_store_del'] = wasmExports['zend_objects_store_del'];
  _gc_possible_root = Module['_gc_possible_root'] = wasmExports['gc_possible_root'];
  _php_array_data_shuffle = Module['_php_array_data_shuffle'] = wasmExports['php_array_data_shuffle'];
  _php_binary_string_shuffle = Module['_php_binary_string_shuffle'] = wasmExports['php_binary_string_shuffle'];
  _php_array_pick_keys = Module['_php_array_pick_keys'] = wasmExports['php_array_pick_keys'];
  _zend_read_property = Module['_zend_read_property'] = wasmExports['zend_read_property'];
  _php_random_bytes_insecure_for_zend = Module['_php_random_bytes_insecure_for_zend'] = wasmExports['php_random_bytes_insecure_for_zend'];
  _zend_reflection_class_factory = Module['_zend_reflection_class_factory'] = wasmExports['zend_reflection_class_factory'];
  _zend_get_closure_method_def = Module['_zend_get_closure_method_def'] = wasmExports['zend_get_closure_method_def'];
  _zend_str_tolower_copy = Module['_zend_str_tolower_copy'] = wasmExports['zend_str_tolower_copy'];
  _zend_fetch_function = Module['_zend_fetch_function'] = wasmExports['zend_fetch_function'];
  _smart_str_append_printf = Module['_smart_str_append_printf'] = wasmExports['smart_str_append_printf'];
  _zend_type_to_string = Module['_zend_type_to_string'] = wasmExports['zend_type_to_string'];
  _zend_get_closure_this_ptr = Module['_zend_get_closure_this_ptr'] = wasmExports['zend_get_closure_this_ptr'];
  _zend_create_fake_closure = Module['_zend_create_fake_closure'] = wasmExports['zend_create_fake_closure'];
  _zval_add_ref = Module['_zval_add_ref'] = wasmExports['zval_add_ref'];
  _zend_hash_copy = Module['_zend_hash_copy'] = wasmExports['zend_hash_copy'];
  __efree_32 = Module['__efree_32'] = wasmExports['_efree_32'];
  _zend_generator_update_root = Module['_zend_generator_update_root'] = wasmExports['zend_generator_update_root'];
  _zend_generator_update_current = Module['_zend_generator_update_current'] = wasmExports['zend_generator_update_current'];
  _zend_fetch_debug_backtrace = Module['_zend_fetch_debug_backtrace'] = wasmExports['zend_fetch_debug_backtrace'];
  _zend_get_closure_invoke_method = Module['_zend_get_closure_invoke_method'] = wasmExports['zend_get_closure_invoke_method'];
  _zend_get_default_from_internal_arg_info = Module['_zend_get_default_from_internal_arg_info'] = wasmExports['zend_get_default_from_internal_arg_info'];
  _zend_separate_class_constants_table = Module['_zend_separate_class_constants_table'] = wasmExports['zend_separate_class_constants_table'];
  _zval_copy_ctor_func = Module['_zval_copy_ctor_func'] = wasmExports['zval_copy_ctor_func'];
  _zend_update_class_constants = Module['_zend_update_class_constants'] = wasmExports['zend_update_class_constants'];
  _zend_class_init_statics = Module['_zend_class_init_statics'] = wasmExports['zend_class_init_statics'];
  _zend_std_get_static_property = Module['_zend_std_get_static_property'] = wasmExports['zend_std_get_static_property'];
  _zend_std_get_static_property_with_info = Module['_zend_std_get_static_property_with_info'] = wasmExports['zend_std_get_static_property_with_info'];
  _zend_clear_exception = Module['_zend_clear_exception'] = wasmExports['zend_clear_exception'];
  _zend_verify_ref_assignable_zval = Module['_zend_verify_ref_assignable_zval'] = wasmExports['zend_verify_ref_assignable_zval'];
  _zend_verify_property_type = Module['_zend_verify_property_type'] = wasmExports['zend_verify_property_type'];
  _zend_get_properties_no_lazy_init = Module['_zend_get_properties_no_lazy_init'] = wasmExports['zend_get_properties_no_lazy_init'];
  _zend_object_make_lazy = Module['_zend_object_make_lazy'] = wasmExports['zend_object_make_lazy'];
  _zend_lazy_object_init = Module['_zend_lazy_object_init'] = wasmExports['zend_lazy_object_init'];
  _zend_lazy_object_mark_as_initialized = Module['_zend_lazy_object_mark_as_initialized'] = wasmExports['zend_lazy_object_mark_as_initialized'];
  _zend_fetch_class_by_name = Module['_zend_fetch_class_by_name'] = wasmExports['zend_fetch_class_by_name'];
  _zend_read_static_property_ex = Module['_zend_read_static_property_ex'] = wasmExports['zend_read_static_property_ex'];
  _zend_update_static_property_ex = Module['_zend_update_static_property_ex'] = wasmExports['zend_update_static_property_ex'];
  _zend_get_property_hook_trampoline = Module['_zend_get_property_hook_trampoline'] = wasmExports['zend_get_property_hook_trampoline'];
  _zend_class_can_be_lazy = Module['_zend_class_can_be_lazy'] = wasmExports['zend_class_can_be_lazy'];
  _php_info_print_module = Module['_php_info_print_module'] = wasmExports['php_info_print_module'];
  _zend_get_extension = Module['_zend_get_extension'] = wasmExports['zend_get_extension'];
  _smart_str_append_zval = Module['_smart_str_append_zval'] = wasmExports['smart_str_append_zval'];
  _zend_ast_export = Module['_zend_ast_export'] = wasmExports['zend_ast_export'];
  _smart_str_append_escaped = Module['_smart_str_append_escaped'] = wasmExports['smart_str_append_escaped'];
  _zend_is_attribute_repeated = Module['_zend_is_attribute_repeated'] = wasmExports['zend_is_attribute_repeated'];
  _zend_get_attribute_value = Module['_zend_get_attribute_value'] = wasmExports['zend_get_attribute_value'];
  _zend_get_attribute_str = Module['_zend_get_attribute_str'] = wasmExports['zend_get_attribute_str'];
  _zend_get_attribute_target_names = Module['_zend_get_attribute_target_names'] = wasmExports['zend_get_attribute_target_names'];
  _zend_get_attribute_object = Module['_zend_get_attribute_object'] = wasmExports['zend_get_attribute_object'];
  _zend_get_constant_ptr = Module['_zend_get_constant_ptr'] = wasmExports['zend_get_constant_ptr'];
  _php_stream_open_for_zend_ex = Module['_php_stream_open_for_zend_ex'] = wasmExports['php_stream_open_for_zend_ex'];
  _zend_hash_internal_pointer_reset_ex = Module['_zend_hash_internal_pointer_reset_ex'] = wasmExports['zend_hash_internal_pointer_reset_ex'];
  _zend_hash_get_current_data_ex = Module['_zend_hash_get_current_data_ex'] = wasmExports['zend_hash_get_current_data_ex'];
  _zend_hash_move_forward_ex = Module['_zend_hash_move_forward_ex'] = wasmExports['zend_hash_move_forward_ex'];
  _zend_hash_real_init_mixed = Module['_zend_hash_real_init_mixed'] = wasmExports['zend_hash_real_init_mixed'];
  _add_next_index_object = Module['_add_next_index_object'] = wasmExports['add_next_index_object'];
  _php_spl_object_hash = Module['_php_spl_object_hash'] = wasmExports['php_spl_object_hash'];
  _zend_call_method = Module['_zend_call_method'] = wasmExports['zend_call_method'];
  _zend_illegal_container_offset = Module['_zend_illegal_container_offset'] = wasmExports['zend_illegal_container_offset'];
  _zend_hash_update_ind = Module['_zend_hash_update_ind'] = wasmExports['zend_hash_update_ind'];
  _zend_hash_iterator_del = Module['_zend_hash_iterator_del'] = wasmExports['zend_hash_iterator_del'];
  _zend_parse_arg_class = Module['_zend_parse_arg_class'] = wasmExports['zend_parse_arg_class'];
  _php_var_serialize_init = Module['_php_var_serialize_init'] = wasmExports['php_var_serialize_init'];
  _php_var_serialize = Module['_php_var_serialize'] = wasmExports['php_var_serialize'];
  _php_var_serialize_destroy = Module['_php_var_serialize_destroy'] = wasmExports['php_var_serialize_destroy'];
  _php_var_unserialize_init = Module['_php_var_unserialize_init'] = wasmExports['php_var_unserialize_init'];
  _var_tmp_var = Module['_var_tmp_var'] = wasmExports['var_tmp_var'];
  _php_var_unserialize = Module['_php_var_unserialize'] = wasmExports['php_var_unserialize'];
  _php_var_unserialize_destroy = Module['_php_var_unserialize_destroy'] = wasmExports['php_var_unserialize_destroy'];
  _zend_proptable_to_symtable = Module['_zend_proptable_to_symtable'] = wasmExports['zend_proptable_to_symtable'];
  _zend_hash_get_current_key_type_ex = Module['_zend_hash_get_current_key_type_ex'] = wasmExports['zend_hash_get_current_key_type_ex'];
  _zend_hash_get_current_key_zval_ex = Module['_zend_hash_get_current_key_zval_ex'] = wasmExports['zend_hash_get_current_key_zval_ex'];
  _zend_call_known_instance_method_with_2_params = Module['_zend_call_known_instance_method_with_2_params'] = wasmExports['zend_call_known_instance_method_with_2_params'];
  _zend_compare_symbol_tables = Module['_zend_compare_symbol_tables'] = wasmExports['zend_compare_symbol_tables'];
  __emalloc_80 = Module['__emalloc_80'] = wasmExports['_emalloc_80'];
  _zend_incompatible_double_to_long_error = Module['_zend_incompatible_double_to_long_error'] = wasmExports['zend_incompatible_double_to_long_error'];
  _zend_use_resource_as_offset = Module['_zend_use_resource_as_offset'] = wasmExports['zend_use_resource_as_offset'];
  _zend_hash_get_current_key_ex = Module['_zend_hash_get_current_key_ex'] = wasmExports['zend_hash_get_current_key_ex'];
  _zend_hash_get_current_pos = Module['_zend_hash_get_current_pos'] = wasmExports['zend_hash_get_current_pos'];
  _zend_hash_iterator_add = Module['_zend_hash_iterator_add'] = wasmExports['zend_hash_iterator_add'];
  _zend_get_property_info = Module['_zend_get_property_info'] = wasmExports['zend_get_property_info'];
  _zend_ref_add_type_source = Module['_zend_ref_add_type_source'] = wasmExports['zend_ref_add_type_source'];
  _spl_filesystem_object_get_path = Module['_spl_filesystem_object_get_path'] = wasmExports['spl_filesystem_object_get_path'];
  __php_glob_stream_get_path = Module['__php_glob_stream_get_path'] = wasmExports['_php_glob_stream_get_path'];
  _php_basename = Module['_php_basename'] = wasmExports['php_basename'];
  _php_stat = Module['_php_stat'] = wasmExports['php_stat'];
  _object_init_with_constructor = Module['_object_init_with_constructor'] = wasmExports['object_init_with_constructor'];
  __php_glob_stream_get_count = Module['__php_glob_stream_get_count'] = wasmExports['_php_glob_stream_get_count'];
  __php_stream_eof = Module['__php_stream_eof'] = wasmExports['_php_stream_eof'];
  _php_csv_handle_escape_argument = Module['_php_csv_handle_escape_argument'] = wasmExports['php_csv_handle_escape_argument'];
  _php_fgetcsv = Module['_php_fgetcsv'] = wasmExports['php_fgetcsv'];
  _php_bc_fgetcsv_empty_line = Module['_php_bc_fgetcsv_empty_line'] = wasmExports['php_bc_fgetcsv_empty_line'];
  _php_fputcsv = Module['_php_fputcsv'] = wasmExports['php_fputcsv'];
  _php_flock_common = Module['_php_flock_common'] = wasmExports['php_flock_common'];
  __php_stream_flush = Module['__php_stream_flush'] = wasmExports['_php_stream_flush'];
  __php_stream_getc = Module['__php_stream_getc'] = wasmExports['_php_stream_getc'];
  __php_stream_passthru = Module['__php_stream_passthru'] = wasmExports['_php_stream_passthru'];
  _php_sscanf_internal = Module['_php_sscanf_internal'] = wasmExports['php_sscanf_internal'];
  _zend_wrong_param_count = Module['_zend_wrong_param_count'] = wasmExports['zend_wrong_param_count'];
  _php_stream_read_to_str = Module['_php_stream_read_to_str'] = wasmExports['php_stream_read_to_str'];
  _php_fstat = Module['_php_fstat'] = wasmExports['php_fstat'];
  __php_stream_set_option = Module['__php_stream_set_option'] = wasmExports['_php_stream_set_option'];
  __php_stream_truncate_set_size = Module['__php_stream_truncate_set_size'] = wasmExports['_php_stream_truncate_set_size'];
  _zend_objects_destroy_object = Module['_zend_objects_destroy_object'] = wasmExports['zend_objects_destroy_object'];
  _zend_std_get_method = Module['_zend_std_get_method'] = wasmExports['zend_std_get_method'];
  _var_push_dtor = Module['_var_push_dtor'] = wasmExports['var_push_dtor'];
  _zend_get_gc_buffer_create = Module['_zend_get_gc_buffer_create'] = wasmExports['zend_get_gc_buffer_create'];
  _zend_get_gc_buffer_grow = Module['_zend_get_gc_buffer_grow'] = wasmExports['zend_get_gc_buffer_grow'];
  __safe_erealloc = Module['__safe_erealloc'] = wasmExports['_safe_erealloc'];
  _zend_compare = Module['_zend_compare'] = wasmExports['zend_compare'];
  _zend_user_it_invalidate_current = Module['_zend_user_it_invalidate_current'] = wasmExports['zend_user_it_invalidate_current'];
  _zend_iterator_dtor = Module['_zend_iterator_dtor'] = wasmExports['zend_iterator_dtor'];
  _zend_get_callable_zval_from_fcc = Module['_zend_get_callable_zval_from_fcc'] = wasmExports['zend_get_callable_zval_from_fcc'];
  _array_set_zval_key = Module['_array_set_zval_key'] = wasmExports['array_set_zval_key'];
  _spl_iterator_apply = Module['_spl_iterator_apply'] = wasmExports['spl_iterator_apply'];
  _zend_is_iterable = Module['_zend_is_iterable'] = wasmExports['zend_is_iterable'];
  _zend_array_to_list = Module['_zend_array_to_list'] = wasmExports['zend_array_to_list'];
  _php_count_recursive = Module['_php_count_recursive'] = wasmExports['php_count_recursive'];
  _zend_hash_move_backwards_ex = Module['_zend_hash_move_backwards_ex'] = wasmExports['zend_hash_move_backwards_ex'];
  _var_replace = Module['_var_replace'] = wasmExports['var_replace'];
  _zend_is_identical = Module['_zend_is_identical'] = wasmExports['zend_is_identical'];
  _zend_hash_compare = Module['_zend_hash_compare'] = wasmExports['zend_hash_compare'];
  _zend_std_read_dimension = Module['_zend_std_read_dimension'] = wasmExports['zend_std_read_dimension'];
  _zend_std_write_dimension = Module['_zend_std_write_dimension'] = wasmExports['zend_std_write_dimension'];
  _zend_std_has_dimension = Module['_zend_std_has_dimension'] = wasmExports['zend_std_has_dimension'];
  _zend_nan_coerced_to_type_warning = Module['_zend_nan_coerced_to_type_warning'] = wasmExports['zend_nan_coerced_to_type_warning'];
  _zend_std_cast_object_tostring = Module['_zend_std_cast_object_tostring'] = wasmExports['zend_std_cast_object_tostring'];
  _zend_object_is_true = Module['_zend_object_is_true'] = wasmExports['zend_object_is_true'];
  _zend_std_unset_dimension = Module['_zend_std_unset_dimension'] = wasmExports['zend_std_unset_dimension'];
  _zend_hash_index_lookup = Module['_zend_hash_index_lookup'] = wasmExports['zend_hash_index_lookup'];
  _zend_sort = Module['_zend_sort'] = wasmExports['zend_sort'];
  _zend_array_sort_ex = Module['_zend_array_sort_ex'] = wasmExports['zend_array_sort_ex'];
  _zend_hash_internal_pointer_end_ex = Module['_zend_hash_internal_pointer_end_ex'] = wasmExports['zend_hash_internal_pointer_end_ex'];
  _zend_hash_minmax = Module['_zend_hash_minmax'] = wasmExports['zend_hash_minmax'];
  _zend_hash_iterator_pos_ex = Module['_zend_hash_iterator_pos_ex'] = wasmExports['zend_hash_iterator_pos_ex'];
  _zend_hash_iterator_pos = Module['_zend_hash_iterator_pos'] = wasmExports['zend_hash_iterator_pos'];
  _zendi_smart_streq = Module['_zendi_smart_streq'] = wasmExports['zendi_smart_streq'];
  _zend_flf_parse_arg_bool_slow = Module['_zend_flf_parse_arg_bool_slow'] = wasmExports['zend_flf_parse_arg_bool_slow'];
  _php_prefix_varname = Module['_php_prefix_varname'] = wasmExports['php_prefix_varname'];
  _zend_rebuild_symbol_table = Module['_zend_rebuild_symbol_table'] = wasmExports['zend_rebuild_symbol_table'];
  _zend_try_assign_typed_ref_zval_ex = Module['_zend_try_assign_typed_ref_zval_ex'] = wasmExports['zend_try_assign_typed_ref_zval_ex'];
  _zend_get_this_object = Module['_zend_get_this_object'] = wasmExports['zend_get_this_object'];
  _php_error_docref_unchecked = Module['_php_error_docref_unchecked'] = wasmExports['php_error_docref_unchecked'];
  _zend_parse_arg_number_or_str_slow = Module['_zend_parse_arg_number_or_str_slow'] = wasmExports['zend_parse_arg_number_or_str_slow'];
  __php_math_round = Module['__php_math_round'] = wasmExports['_php_math_round'];
  _get_active_function_arg_name = Module['_get_active_function_arg_name'] = wasmExports['get_active_function_arg_name'];
  _is_numeric_str_function = Module['_is_numeric_str_function'] = wasmExports['is_numeric_str_function'];
  _zend_hash_to_packed = Module['_zend_hash_to_packed'] = wasmExports['zend_hash_to_packed'];
  _zend_hash_iterators_lower_pos = Module['_zend_hash_iterators_lower_pos'] = wasmExports['zend_hash_iterators_lower_pos'];
  __zend_hash_iterators_update = Module['__zend_hash_iterators_update'] = wasmExports['_zend_hash_iterators_update'];
  _zend_hash_packed_del_val = Module['_zend_hash_packed_del_val'] = wasmExports['zend_hash_packed_del_val'];
  _zend_hash_iterators_advance = Module['_zend_hash_iterators_advance'] = wasmExports['zend_hash_iterators_advance'];
  _convert_to_array = Module['_convert_to_array'] = wasmExports['convert_to_array'];
  _php_array_merge_recursive = Module['_php_array_merge_recursive'] = wasmExports['php_array_merge_recursive'];
  _add_next_index_null = Module['_add_next_index_null'] = wasmExports['add_next_index_null'];
  _zend_cannot_add_element = Module['_zend_cannot_add_element'] = wasmExports['zend_cannot_add_element'];
  _php_array_merge = Module['_php_array_merge'] = wasmExports['php_array_merge'];
  _php_array_replace_recursive = Module['_php_array_replace_recursive'] = wasmExports['php_array_replace_recursive'];
  _zend_hash_merge = Module['_zend_hash_merge'] = wasmExports['zend_hash_merge'];
  _zend_string_toupper_ex = Module['_zend_string_toupper_ex'] = wasmExports['zend_string_toupper_ex'];
  _zend_hash_bucket_swap = Module['_zend_hash_bucket_swap'] = wasmExports['zend_hash_bucket_swap'];
  _php_multisort_compare = Module['_php_multisort_compare'] = wasmExports['php_multisort_compare'];
  _add_function = Module['_add_function'] = wasmExports['add_function'];
  _mul_function = Module['_mul_function'] = wasmExports['mul_function'];
  _zend_binary_strcasecmp_l = Module['_zend_binary_strcasecmp_l'] = wasmExports['zend_binary_strcasecmp_l'];
  _zend_binary_strcmp = Module['_zend_binary_strcmp'] = wasmExports['zend_binary_strcmp'];
  _zendi_smart_strcmp = Module['_zendi_smart_strcmp'] = wasmExports['zendi_smart_strcmp'];
  _strnatcmp_ex = Module['_strnatcmp_ex'] = wasmExports['strnatcmp_ex'];
  _numeric_compare_function = Module['_numeric_compare_function'] = wasmExports['numeric_compare_function'];
  _string_case_compare_function = Module['_string_case_compare_function'] = wasmExports['string_case_compare_function'];
  _string_compare_function = Module['_string_compare_function'] = wasmExports['string_compare_function'];
  _string_locale_compare_function = Module['_string_locale_compare_function'] = wasmExports['string_locale_compare_function'];
  _zend_throw_exception_internal = Module['_zend_throw_exception_internal'] = wasmExports['zend_throw_exception_internal'];
  _zend_get_executed_lineno = Module['_zend_get_executed_lineno'] = wasmExports['zend_get_executed_lineno'];
  _zend_throw_unwind_exit = Module['_zend_throw_unwind_exit'] = wasmExports['zend_throw_unwind_exit'];
  _zend_alter_ini_entry_ex = Module['_zend_alter_ini_entry_ex'] = wasmExports['zend_alter_ini_entry_ex'];
  _php_register_incomplete_class_handlers = Module['_php_register_incomplete_class_handlers'] = wasmExports['php_register_incomplete_class_handlers'];
  _php_register_url_stream_wrapper = Module['_php_register_url_stream_wrapper'] = wasmExports['php_register_url_stream_wrapper'];
  _php_unregister_url_stream_wrapper = Module['_php_unregister_url_stream_wrapper'] = wasmExports['php_unregister_url_stream_wrapper'];
  _zend_reset_lc_ctype_locale = Module['_zend_reset_lc_ctype_locale'] = wasmExports['zend_reset_lc_ctype_locale'];
  _zend_update_current_locale = Module['_zend_update_current_locale'] = wasmExports['zend_update_current_locale'];
  _zend_llist_destroy = Module['_zend_llist_destroy'] = wasmExports['zend_llist_destroy'];
  _php_get_nan = Module['_php_get_nan'] = wasmExports['php_get_nan'];
  _php_get_inf = Module['_php_get_inf'] = wasmExports['php_get_inf'];
  _zend_register_double_constant = Module['_zend_register_double_constant'] = wasmExports['zend_register_double_constant'];
  _zend_get_executed_scope = Module['_zend_get_executed_scope'] = wasmExports['zend_get_executed_scope'];
  _zend_get_constant_ex = Module['_zend_get_constant_ex'] = wasmExports['zend_get_constant_ex'];
  _htonl = wasmExports['htonl'];
  _php_getenv = Module['_php_getenv'] = wasmExports['php_getenv'];
  _sapi_getenv = Module['_sapi_getenv'] = wasmExports['sapi_getenv'];
  _php_getopt = Module['_php_getopt'] = wasmExports['php_getopt'];
  _sapi_flush = Module['_sapi_flush'] = wasmExports['sapi_flush'];
  _php_get_current_user = Module['_php_get_current_user'] = wasmExports['php_get_current_user'];
  _cfg_get_entry_ex = Module['_cfg_get_entry_ex'] = wasmExports['cfg_get_entry_ex'];
  __php_error_log_ex = Module['__php_error_log_ex'] = wasmExports['_php_error_log_ex'];
  _php_log_err_with_severity = Module['_php_log_err_with_severity'] = wasmExports['php_log_err_with_severity'];
  __php_error_log = Module['__php_error_log'] = wasmExports['_php_error_log'];
  _zend_get_called_scope = Module['_zend_get_called_scope'] = wasmExports['zend_get_called_scope'];
  _zend_hash_apply = Module['_zend_hash_apply'] = wasmExports['zend_hash_apply'];
  _append_user_shutdown_function = Module['_append_user_shutdown_function'] = wasmExports['append_user_shutdown_function'];
  _register_user_shutdown_function = Module['_register_user_shutdown_function'] = wasmExports['register_user_shutdown_function'];
  _remove_user_shutdown_function = Module['_remove_user_shutdown_function'] = wasmExports['remove_user_shutdown_function'];
  _zend_hash_str_del = Module['_zend_hash_str_del'] = wasmExports['zend_hash_str_del'];
  _php_get_highlight_struct = Module['_php_get_highlight_struct'] = wasmExports['php_get_highlight_struct'];
  _zend_ini_string_ex = Module['_zend_ini_string_ex'] = wasmExports['zend_ini_string_ex'];
  _php_output_start_default = Module['_php_output_start_default'] = wasmExports['php_output_start_default'];
  _highlight_file = Module['_highlight_file'] = wasmExports['highlight_file'];
  _php_output_end = Module['_php_output_end'] = wasmExports['php_output_end'];
  _php_output_get_contents = Module['_php_output_get_contents'] = wasmExports['php_output_get_contents'];
  _php_output_discard = Module['_php_output_discard'] = wasmExports['php_output_discard'];
  _zend_save_lexical_state = Module['_zend_save_lexical_state'] = wasmExports['zend_save_lexical_state'];
  _open_file_for_scanning = Module['_open_file_for_scanning'] = wasmExports['open_file_for_scanning'];
  _zend_restore_lexical_state = Module['_zend_restore_lexical_state'] = wasmExports['zend_restore_lexical_state'];
  _zend_strip = Module['_zend_strip'] = wasmExports['zend_strip'];
  _highlight_string = Module['_highlight_string'] = wasmExports['highlight_string'];
  _zend_ini_parse_quantity = Module['_zend_ini_parse_quantity'] = wasmExports['zend_ini_parse_quantity'];
  _zend_ini_get_value = Module['_zend_ini_get_value'] = wasmExports['zend_ini_get_value'];
  _zend_ini_sort_entries = Module['_zend_ini_sort_entries'] = wasmExports['zend_ini_sort_entries'];
  _zend_restore_ini_entry = Module['_zend_restore_ini_entry'] = wasmExports['zend_restore_ini_entry'];
  _zend_ini_string = Module['_zend_ini_string'] = wasmExports['zend_ini_string'];
  _zend_print_zval_r = Module['_zend_print_zval_r'] = wasmExports['zend_print_zval_r'];
  _zend_print_zval_r_to_str = Module['_zend_print_zval_r_to_str'] = wasmExports['zend_print_zval_r_to_str'];
  _ntohs = wasmExports['ntohs'];
  _htons = wasmExports['htons'];
  _zend_llist_init = Module['_zend_llist_init'] = wasmExports['zend_llist_init'];
  _zend_llist_add_element = Module['_zend_llist_add_element'] = wasmExports['zend_llist_add_element'];
  _zend_llist_apply = Module['_zend_llist_apply'] = wasmExports['zend_llist_apply'];
  _php_copy_file_ex = Module['_php_copy_file_ex'] = wasmExports['php_copy_file_ex'];
  _zend_parse_ini_file = Module['_zend_parse_ini_file'] = wasmExports['zend_parse_ini_file'];
  _zend_parse_ini_string = Module['_zend_parse_ini_string'] = wasmExports['zend_parse_ini_string'];
  _add_index_double = Module['_add_index_double'] = wasmExports['add_index_double'];
  _zif_rewind = Module['_zif_rewind'] = wasmExports['zif_rewind'];
  _zif_fclose = Module['_zif_fclose'] = wasmExports['zif_fclose'];
  _zif_feof = Module['_zif_feof'] = wasmExports['zif_feof'];
  _zif_fgetc = Module['_zif_fgetc'] = wasmExports['zif_fgetc'];
  _zif_fgets = Module['_zif_fgets'] = wasmExports['zif_fgets'];
  _zif_fread = Module['_zif_fread'] = wasmExports['zif_fread'];
  _zif_fpassthru = Module['_zif_fpassthru'] = wasmExports['zif_fpassthru'];
  _zif_fseek = Module['_zif_fseek'] = wasmExports['zif_fseek'];
  _zif_ftell = Module['_zif_ftell'] = wasmExports['zif_ftell'];
  _zif_fflush = Module['_zif_fflush'] = wasmExports['zif_fflush'];
  _zif_fwrite = Module['_zif_fwrite'] = wasmExports['zif_fwrite'];
  _zend_stream_init_fp = Module['_zend_stream_init_fp'] = wasmExports['zend_stream_init_fp'];
  _object_and_properties_init = Module['_object_and_properties_init'] = wasmExports['object_and_properties_init'];
  __safe_realloc = Module['__safe_realloc'] = wasmExports['_safe_realloc'];
  _php_crc32_bulk_update = Module['_php_crc32_bulk_update'] = wasmExports['php_crc32_bulk_update'];
  _php_crc32_stream_bulk_update = Module['_php_crc32_stream_bulk_update'] = wasmExports['php_crc32_stream_bulk_update'];
  _php_print_credits = Module['_php_print_credits'] = wasmExports['php_print_credits'];
  _php_print_info_htmlhead = Module['_php_print_info_htmlhead'] = wasmExports['php_print_info_htmlhead'];
  _php_output_write = Module['_php_output_write'] = wasmExports['php_output_write'];
  _php_info_print_table_colspan_header = Module['_php_info_print_table_colspan_header'] = wasmExports['php_info_print_table_colspan_header'];
  _php_crypt = Module['_php_crypt'] = wasmExports['php_crypt'];
  __emalloc_128 = Module['__emalloc_128'] = wasmExports['_emalloc_128'];
  _php_info_print_css = Module['_php_info_print_css'] = wasmExports['php_info_print_css'];
  _zend_objects_not_comparable = Module['_zend_objects_not_comparable'] = wasmExports['zend_objects_not_comparable'];
  _zend_list_delete = Module['_zend_list_delete'] = wasmExports['zend_list_delete'];
  _zend_list_close = Module['_zend_list_close'] = wasmExports['zend_list_close'];
  _php_clear_stat_cache = Module['_php_clear_stat_cache'] = wasmExports['php_clear_stat_cache'];
  _php_check_open_basedir_ex = Module['_php_check_open_basedir_ex'] = wasmExports['php_check_open_basedir_ex'];
  _php_stream_dirent_alphasortr = Module['_php_stream_dirent_alphasortr'] = wasmExports['php_stream_dirent_alphasortr'];
  _php_stream_dirent_alphasort = Module['_php_stream_dirent_alphasort'] = wasmExports['php_stream_dirent_alphasort'];
  __php_stream_scandir = Module['__php_stream_scandir'] = wasmExports['_php_stream_scandir'];
  _zif_dl = Module['_zif_dl'] = wasmExports['zif_dl'];
  _php_load_extension = Module['_php_load_extension'] = wasmExports['php_load_extension'];
  _php_dl = Module['_php_dl'] = wasmExports['php_dl'];
  _php_load_shlib = Module['_php_load_shlib'] = wasmExports['php_load_shlib'];
  _zend_register_module_ex = Module['_zend_register_module_ex'] = wasmExports['zend_register_module_ex'];
  _zend_startup_module_ex = Module['_zend_startup_module_ex'] = wasmExports['zend_startup_module_ex'];
  _php_network_gethostbyname = Module['_php_network_gethostbyname'] = wasmExports['php_network_gethostbyname'];
  _php_exec = Module['_php_exec'] = wasmExports['php_exec'];
  __php_stream_fopen_from_pipe = Module['__php_stream_fopen_from_pipe'] = wasmExports['_php_stream_fopen_from_pipe'];
  _php_escape_shell_arg = Module['_php_escape_shell_arg'] = wasmExports['php_escape_shell_arg'];
  _zend_register_list_destructors_ex = Module['_zend_register_list_destructors_ex'] = wasmExports['zend_register_list_destructors_ex'];
  _php_stream_context_free = Module['_php_stream_context_free'] = wasmExports['php_stream_context_free'];
  __php_stream_copy_to_stream_ex = Module['__php_stream_copy_to_stream_ex'] = wasmExports['_php_stream_copy_to_stream_ex'];
  _php_stream_locate_eol = Module['_php_stream_locate_eol'] = wasmExports['php_stream_locate_eol'];
  _php_open_temporary_fd_ex = Module['_php_open_temporary_fd_ex'] = wasmExports['php_open_temporary_fd_ex'];
  __php_stream_fopen_tmpfile = Module['__php_stream_fopen_tmpfile'] = wasmExports['_php_stream_fopen_tmpfile'];
  _php_error_docref2 = Module['_php_error_docref2'] = wasmExports['php_error_docref2'];
  _zend_fetch_resource2 = Module['_zend_fetch_resource2'] = wasmExports['zend_fetch_resource2'];
  __php_stream_mkdir = Module['__php_stream_mkdir'] = wasmExports['_php_stream_mkdir'];
  __php_stream_rmdir = Module['__php_stream_rmdir'] = wasmExports['_php_stream_rmdir'];
  __php_stream_sync = Module['__php_stream_sync'] = wasmExports['_php_stream_sync'];
  _php_copy_file_ctx = Module['_php_copy_file_ctx'] = wasmExports['php_copy_file_ctx'];
  _php_copy_file = Module['_php_copy_file'] = wasmExports['php_copy_file'];
  _php_get_temporary_directory = Module['_php_get_temporary_directory'] = wasmExports['php_get_temporary_directory'];
  _php_get_gid_by_name = Module['_php_get_gid_by_name'] = wasmExports['php_get_gid_by_name'];
  _php_get_uid_by_name = Module['_php_get_uid_by_name'] = wasmExports['php_get_uid_by_name'];
  _realpath_cache_del = Module['_realpath_cache_del'] = wasmExports['realpath_cache_del'];
  _realpath_cache_size = Module['_realpath_cache_size'] = wasmExports['realpath_cache_size'];
  _realpath_cache_get_buckets = Module['_realpath_cache_get_buckets'] = wasmExports['realpath_cache_get_buckets'];
  _realpath_cache_max_buckets = Module['_realpath_cache_max_buckets'] = wasmExports['realpath_cache_max_buckets'];
  _php_stream_bucket_make_writeable = Module['_php_stream_bucket_make_writeable'] = wasmExports['php_stream_bucket_make_writeable'];
  _php_strtr = Module['_php_strtr'] = wasmExports['php_strtr'];
  ___zend_strdup = Module['___zend_strdup'] = wasmExports['__zend_strdup'];
  _php_flock = Module['_php_flock'] = wasmExports['php_flock'];
  _php_conv_fp = Module['_php_conv_fp'] = wasmExports['php_conv_fp'];
  _zend_argument_count_error = Module['_zend_argument_count_error'] = wasmExports['zend_argument_count_error'];
  __php_stream_xport_create = Module['__php_stream_xport_create'] = wasmExports['_php_stream_xport_create'];
  _zend_try_assign_typed_ref_str = Module['_zend_try_assign_typed_ref_str'] = wasmExports['zend_try_assign_typed_ref_str'];
  _zend_try_assign_typed_ref_empty_string = Module['_zend_try_assign_typed_ref_empty_string'] = wasmExports['zend_try_assign_typed_ref_empty_string'];
  _php_stream_wrapper_log_error = Module['_php_stream_wrapper_log_error'] = wasmExports['php_stream_wrapper_log_error'];
  _php_stream_context_get_option = Module['_php_stream_context_get_option'] = wasmExports['php_stream_context_get_option'];
  __php_stream_printf = Module['__php_stream_printf'] = wasmExports['_php_stream_printf'];
  _php_stream_notification_notify = Module['_php_stream_notification_notify'] = wasmExports['php_stream_notification_notify'];
  _php_stream_context_set = Module['_php_stream_context_set'] = wasmExports['php_stream_context_set'];
  _php_stream_xport_crypto_setup = Module['_php_stream_xport_crypto_setup'] = wasmExports['php_stream_xport_crypto_setup'];
  _php_stream_xport_crypto_enable = Module['_php_stream_xport_crypto_enable'] = wasmExports['php_stream_xport_crypto_enable'];
  _php_stream_context_get_uri_parser = Module['_php_stream_context_get_uri_parser'] = wasmExports['php_stream_context_get_uri_parser'];
  _php_raw_url_decode = Module['_php_raw_url_decode'] = wasmExports['php_raw_url_decode'];
  __php_stream_sock_open_host = Module['__php_stream_sock_open_host'] = wasmExports['_php_stream_sock_open_host'];
  __php_stream_alloc = Module['__php_stream_alloc'] = wasmExports['_php_stream_alloc'];
  _sapi_header_op = Module['_sapi_header_op'] = wasmExports['sapi_header_op'];
  _php_header = Module['_php_header'] = wasmExports['php_header'];
  _sapi_send_headers = Module['_sapi_send_headers'] = wasmExports['sapi_send_headers'];
  _php_setcookie = Module['_php_setcookie'] = wasmExports['php_setcookie'];
  _php_raw_url_encode = Module['_php_raw_url_encode'] = wasmExports['php_raw_url_encode'];
  _php_output_get_start_lineno = Module['_php_output_get_start_lineno'] = wasmExports['php_output_get_start_lineno'];
  _php_output_get_start_filename = Module['_php_output_get_start_filename'] = wasmExports['php_output_get_start_filename'];
  _zend_try_assign_typed_ref_string = Module['_zend_try_assign_typed_ref_string'] = wasmExports['zend_try_assign_typed_ref_string'];
  _zend_llist_apply_with_argument = Module['_zend_llist_apply_with_argument'] = wasmExports['zend_llist_apply_with_argument'];
  _php_unescape_html_entities = Module['_php_unescape_html_entities'] = wasmExports['php_unescape_html_entities'];
  _php_escape_html_entities = Module['_php_escape_html_entities'] = wasmExports['php_escape_html_entities'];
  _zend_set_local_var_str = Module['_zend_set_local_var_str'] = wasmExports['zend_set_local_var_str'];
  _php_stream_context_set_option = Module['_php_stream_context_set_option'] = wasmExports['php_stream_context_set_option'];
  _php_stream_filter_free = Module['_php_stream_filter_free'] = wasmExports['php_stream_filter_free'];
  __php_stream_filter_append = Module['__php_stream_filter_append'] = wasmExports['_php_stream_filter_append'];
  _php_stream_filter_create = Module['_php_stream_filter_create'] = wasmExports['php_stream_filter_create'];
  _php_url_encode_hash_ex = Module['_php_url_encode_hash_ex'] = wasmExports['php_url_encode_hash_ex'];
  _zend_check_property_access = Module['_zend_check_property_access'] = wasmExports['zend_check_property_access'];
  _php_url_encode = Module['_php_url_encode'] = wasmExports['php_url_encode'];
  _php_url_encode_to_smart_str = Module['_php_url_encode_to_smart_str'] = wasmExports['php_url_encode_to_smart_str'];
  _zend_double_to_str = Module['_zend_double_to_str'] = wasmExports['zend_double_to_str'];
  _sapi_read_post_data = Module['_sapi_read_post_data'] = wasmExports['sapi_read_post_data'];
  _php_is_image_avif = Module['_php_is_image_avif'] = wasmExports['php_is_image_avif'];
  _php_image_type_to_mime_type = Module['_php_image_type_to_mime_type'] = wasmExports['php_image_type_to_mime_type'];
  _php_getimagetype = Module['_php_getimagetype'] = wasmExports['php_getimagetype'];
  __php_stream_memory_open = Module['__php_stream_memory_open'] = wasmExports['_php_stream_memory_open'];
  _php_image_register_handler = Module['_php_image_register_handler'] = wasmExports['php_image_register_handler'];
  _php_image_unregister_handler = Module['_php_image_unregister_handler'] = wasmExports['php_image_unregister_handler'];
  _zend_objects_new = Module['_zend_objects_new'] = wasmExports['zend_objects_new'];
  _php_lookup_class_name = Module['_php_lookup_class_name'] = wasmExports['php_lookup_class_name'];
  _php_store_class_name = Module['_php_store_class_name'] = wasmExports['php_store_class_name'];
  _php_info_print_style = Module['_php_info_print_style'] = wasmExports['php_info_print_style'];
  _php_get_uname = Module['_php_get_uname'] = wasmExports['php_get_uname'];
  _php_print_info = Module['_php_print_info'] = wasmExports['php_print_info'];
  _get_zend_version = Module['_get_zend_version'] = wasmExports['get_zend_version'];
  _php_build_provider = Module['_php_build_provider'] = wasmExports['php_build_provider'];
  _is_zend_mm = Module['_is_zend_mm'] = wasmExports['is_zend_mm'];
  _zend_multibyte_get_functions = Module['_zend_multibyte_get_functions'] = wasmExports['zend_multibyte_get_functions'];
  __php_stream_get_url_stream_wrappers_hash = Module['__php_stream_get_url_stream_wrappers_hash'] = wasmExports['_php_stream_get_url_stream_wrappers_hash'];
  __php_get_stream_filters_hash = Module['__php_get_stream_filters_hash'] = wasmExports['_php_get_stream_filters_hash'];
  _zend_html_puts = Module['_zend_html_puts'] = wasmExports['zend_html_puts'];
  _php_info_print_box_start = Module['_php_info_print_box_start'] = wasmExports['php_info_print_box_start'];
  _php_info_print_box_end = Module['_php_info_print_box_end'] = wasmExports['php_info_print_box_end'];
  _php_info_print_hr = Module['_php_info_print_hr'] = wasmExports['php_info_print_hr'];
  _php_info_print_table_row_ex = Module['_php_info_print_table_row_ex'] = wasmExports['php_info_print_table_row_ex'];
  _zend_get_module_version = Module['_zend_get_module_version'] = wasmExports['zend_get_module_version'];
  _zend_get_executed_filename = Module['_zend_get_executed_filename'] = wasmExports['zend_get_executed_filename'];
  _php_syslog = Module['_php_syslog'] = wasmExports['php_syslog'];
  _php_math_round_mode_from_enum = Module['_php_math_round_mode_from_enum'] = wasmExports['php_math_round_mode_from_enum'];
  _pow_function = Module['_pow_function'] = wasmExports['pow_function'];
  __php_math_basetolong = Module['__php_math_basetolong'] = wasmExports['_php_math_basetolong'];
  __php_math_basetozval = Module['__php_math_basetozval'] = wasmExports['_php_math_basetozval'];
  __php_math_longtobase = Module['__php_math_longtobase'] = wasmExports['_php_math_longtobase'];
  __php_math_zvaltobase = Module['__php_math_zvaltobase'] = wasmExports['_php_math_zvaltobase'];
  _zend_flf_parse_arg_long_slow = Module['_zend_flf_parse_arg_long_slow'] = wasmExports['zend_flf_parse_arg_long_slow'];
  __php_math_number_format = Module['__php_math_number_format'] = wasmExports['_php_math_number_format'];
  __php_math_number_format_ex = Module['__php_math_number_format_ex'] = wasmExports['_php_math_number_format_ex'];
  __php_math_number_format_long = Module['__php_math_number_format_long'] = wasmExports['_php_math_number_format_long'];
  _make_digest = Module['_make_digest'] = wasmExports['make_digest'];
  _make_digest_ex = Module['_make_digest_ex'] = wasmExports['make_digest_ex'];
  __emalloc_56 = Module['__emalloc_56'] = wasmExports['_emalloc_56'];
  _php_inet_ntop = Module['_php_inet_ntop'] = wasmExports['php_inet_ntop'];
  _php_statpage = Module['_php_statpage'] = wasmExports['php_statpage'];
  _sapi_get_stat = Module['_sapi_get_stat'] = wasmExports['sapi_get_stat'];
  _php_getlastmod = Module['_php_getlastmod'] = wasmExports['php_getlastmod'];
  _php_password_algo_register = Module['_php_password_algo_register'] = wasmExports['php_password_algo_register'];
  _php_password_algo_unregister = Module['_php_password_algo_unregister'] = wasmExports['php_password_algo_unregister'];
  _php_password_algo_default = Module['_php_password_algo_default'] = wasmExports['php_password_algo_default'];
  _php_password_algo_find = Module['_php_password_algo_find'] = wasmExports['php_password_algo_find'];
  _php_password_algo_extract_ident = Module['_php_password_algo_extract_ident'] = wasmExports['php_password_algo_extract_ident'];
  _php_password_algo_identify_ex = Module['_php_password_algo_identify_ex'] = wasmExports['php_password_algo_identify_ex'];
  _php_stream_mode_from_str = Module['_php_stream_mode_from_str'] = wasmExports['php_stream_mode_from_str'];
  __php_stream_temp_create = Module['__php_stream_temp_create'] = wasmExports['_php_stream_temp_create'];
  __php_stream_memory_create = Module['__php_stream_memory_create'] = wasmExports['_php_stream_memory_create'];
  __php_stream_temp_create_ex = Module['__php_stream_temp_create_ex'] = wasmExports['_php_stream_temp_create_ex'];
  __php_stream_sock_open_from_socket = Module['__php_stream_sock_open_from_socket'] = wasmExports['_php_stream_sock_open_from_socket'];
  __php_stream_fopen_from_file = Module['__php_stream_fopen_from_file'] = wasmExports['_php_stream_fopen_from_file'];
  __php_stream_fopen_from_fd = Module['__php_stream_fopen_from_fd'] = wasmExports['_php_stream_fopen_from_fd'];
  _sapi_read_post_block = Module['_sapi_read_post_block'] = wasmExports['sapi_read_post_block'];
  _zend_fetch_resource = Module['_zend_fetch_resource'] = wasmExports['zend_fetch_resource'];
  _php_socket_error_str = Module['_php_socket_error_str'] = wasmExports['php_socket_error_str'];
  _zend_register_resource = Module['_zend_register_resource'] = wasmExports['zend_register_resource'];
  _php_quot_print_encode = Module['_php_quot_print_encode'] = wasmExports['php_quot_print_encode'];
  _ValidateFormat = Module['_ValidateFormat'] = wasmExports['ValidateFormat'];
  _convert_to_null = Module['_convert_to_null'] = wasmExports['convert_to_null'];
  _zend_try_assign_typed_ref_stringl = Module['_zend_try_assign_typed_ref_stringl'] = wasmExports['zend_try_assign_typed_ref_stringl'];
  _zend_try_assign_typed_ref_double = Module['_zend_try_assign_typed_ref_double'] = wasmExports['zend_try_assign_typed_ref_double'];
  _make_sha1_digest = Module['_make_sha1_digest'] = wasmExports['make_sha1_digest'];
  _php_socket_strerror = Module['_php_socket_strerror'] = wasmExports['php_socket_strerror'];
  _add_next_index_resource = Module['_add_next_index_resource'] = wasmExports['add_next_index_resource'];
  _php_stream_xport_accept = Module['_php_stream_xport_accept'] = wasmExports['php_stream_xport_accept'];
  _php_stream_xport_get_name = Module['_php_stream_xport_get_name'] = wasmExports['php_stream_xport_get_name'];
  _php_network_parse_network_address_with_port = Module['_php_network_parse_network_address_with_port'] = wasmExports['php_network_parse_network_address_with_port'];
  _php_stream_xport_sendto = Module['_php_stream_xport_sendto'] = wasmExports['php_stream_xport_sendto'];
  _zend_try_assign_typed_ref_null = Module['_zend_try_assign_typed_ref_null'] = wasmExports['zend_try_assign_typed_ref_null'];
  _php_stream_xport_recvfrom = Module['_php_stream_xport_recvfrom'] = wasmExports['php_stream_xport_recvfrom'];
  __php_emit_fd_setsize_warning = Module['__php_emit_fd_setsize_warning'] = wasmExports['_php_emit_fd_setsize_warning'];
  _php_stream_notification_free = Module['_php_stream_notification_free'] = wasmExports['php_stream_notification_free'];
  _php_stream_notification_alloc = Module['_php_stream_notification_alloc'] = wasmExports['php_stream_notification_alloc'];
  _php_stream_filter_append_ex = Module['_php_stream_filter_append_ex'] = wasmExports['php_stream_filter_append_ex'];
  _php_stream_filter_remove = Module['_php_stream_filter_remove'] = wasmExports['php_stream_filter_remove'];
  _php_stream_filter_prepend_ex = Module['_php_stream_filter_prepend_ex'] = wasmExports['php_stream_filter_prepend_ex'];
  _php_file_le_stream_filter = Module['_php_file_le_stream_filter'] = wasmExports['php_file_le_stream_filter'];
  __php_stream_filter_flush = Module['__php_stream_filter_flush'] = wasmExports['_php_stream_filter_flush'];
  _php_stream_get_record = Module['_php_stream_get_record'] = wasmExports['php_stream_get_record'];
  _php_stream_xport_shutdown = Module['_php_stream_xport_shutdown'] = wasmExports['php_stream_xport_shutdown'];
  _localeconv_r = Module['_localeconv_r'] = wasmExports['localeconv_r'];
  _php_explode = Module['_php_explode'] = wasmExports['php_explode'];
  _zend_hash_packed_grow = Module['_zend_hash_packed_grow'] = wasmExports['zend_hash_packed_grow'];
  _php_explode_negative_limit = Module['_php_explode_negative_limit'] = wasmExports['php_explode_negative_limit'];
  __emalloc_256 = Module['__emalloc_256'] = wasmExports['_emalloc_256'];
  _php_implode = Module['_php_implode'] = wasmExports['php_implode'];
  _zend_string_only_has_ascii_alphanumeric = Module['_zend_string_only_has_ascii_alphanumeric'] = wasmExports['zend_string_only_has_ascii_alphanumeric'];
  _php_dirname = Module['_php_dirname'] = wasmExports['php_dirname'];
  _php_stristr = Module['_php_stristr'] = wasmExports['php_stristr'];
  _php_strspn = Module['_php_strspn'] = wasmExports['php_strspn'];
  _php_strcspn = Module['_php_strcspn'] = wasmExports['php_strcspn'];
  _add_index_str = Module['_add_index_str'] = wasmExports['add_index_str'];
  _php_str_to_str = Module['_php_str_to_str'] = wasmExports['php_str_to_str'];
  _php_addcslashes_str = Module['_php_addcslashes_str'] = wasmExports['php_addcslashes_str'];
  _php_stripcslashes = Module['_php_stripcslashes'] = wasmExports['php_stripcslashes'];
  _php_stripslashes = Module['_php_stripslashes'] = wasmExports['php_stripslashes'];
  _php_addcslashes = Module['_php_addcslashes'] = wasmExports['php_addcslashes'];
  _zend_str_tolower_dup_ex = Module['_zend_str_tolower_dup_ex'] = wasmExports['zend_str_tolower_dup_ex'];
  __emalloc_1024 = Module['__emalloc_1024'] = wasmExports['_emalloc_1024'];
  _php_strip_tags = Module['_php_strip_tags'] = wasmExports['php_strip_tags'];
  _zend_binary_strncmp = Module['_zend_binary_strncmp'] = wasmExports['zend_binary_strncmp'];
  _zend_binary_strncasecmp_l = Module['_zend_binary_strncasecmp_l'] = wasmExports['zend_binary_strncasecmp_l'];
  _php_closelog = Module['_php_closelog'] = wasmExports['php_closelog'];
  _php_openlog = Module['_php_openlog'] = wasmExports['php_openlog'];
  _php_syslog_str = Module['_php_syslog_str'] = wasmExports['php_syslog_str'];
  _zend_zval_get_legacy_type = Module['_zend_zval_get_legacy_type'] = wasmExports['zend_zval_get_legacy_type'];
  _zend_rsrc_list_get_rsrc_type = Module['_zend_rsrc_list_get_rsrc_type'] = wasmExports['zend_rsrc_list_get_rsrc_type'];
  _convert_to_long = Module['_convert_to_long'] = wasmExports['convert_to_long'];
  _convert_to_double = Module['_convert_to_double'] = wasmExports['convert_to_double'];
  _convert_to_object = Module['_convert_to_object'] = wasmExports['convert_to_object'];
  _convert_to_boolean = Module['_convert_to_boolean'] = wasmExports['convert_to_boolean'];
  _zend_try_assign_typed_ref = Module['_zend_try_assign_typed_ref'] = wasmExports['zend_try_assign_typed_ref'];
  _zend_is_countable = Module['_zend_is_countable'] = wasmExports['zend_is_countable'];
  _php_url_scanner_adapt_single_url = Module['_php_url_scanner_adapt_single_url'] = wasmExports['php_url_scanner_adapt_single_url'];
  _php_url_parse_ex = Module['_php_url_parse_ex'] = wasmExports['php_url_parse_ex'];
  _php_url_free = Module['_php_url_free'] = wasmExports['php_url_free'];
  _php_url_scanner_add_session_var = Module['_php_url_scanner_add_session_var'] = wasmExports['php_url_scanner_add_session_var'];
  _php_output_start_internal = Module['_php_output_start_internal'] = wasmExports['php_output_start_internal'];
  _php_url_scanner_add_var = Module['_php_url_scanner_add_var'] = wasmExports['php_url_scanner_add_var'];
  _php_url_scanner_reset_session_vars = Module['_php_url_scanner_reset_session_vars'] = wasmExports['php_url_scanner_reset_session_vars'];
  _php_url_scanner_reset_vars = Module['_php_url_scanner_reset_vars'] = wasmExports['php_url_scanner_reset_vars'];
  _php_url_scanner_reset_session_var = Module['_php_url_scanner_reset_session_var'] = wasmExports['php_url_scanner_reset_session_var'];
  _php_url_scanner_reset_var = Module['_php_url_scanner_reset_var'] = wasmExports['php_url_scanner_reset_var'];
  _php_url_parse = Module['_php_url_parse'] = wasmExports['php_url_parse'];
  _php_url_parse_ex2 = Module['_php_url_parse_ex2'] = wasmExports['php_url_parse_ex2'];
  _php_url_decode_ex = Module['_php_url_decode_ex'] = wasmExports['php_url_decode_ex'];
  _php_raw_url_decode_ex = Module['_php_raw_url_decode_ex'] = wasmExports['php_raw_url_decode_ex'];
  _zend_update_property_stringl = Module['_zend_update_property_stringl'] = wasmExports['zend_update_property_stringl'];
  _zend_update_property_long = Module['_zend_update_property_long'] = wasmExports['zend_update_property_long'];
  _php_stream_bucket_prepend = Module['_php_stream_bucket_prepend'] = wasmExports['php_stream_bucket_prepend'];
  _php_stream_filter_register_factory_volatile = Module['_php_stream_filter_register_factory_volatile'] = wasmExports['php_stream_filter_register_factory_volatile'];
  _add_property_string_ex = Module['_add_property_string_ex'] = wasmExports['add_property_string_ex'];
  _add_property_zval_ex = Module['_add_property_zval_ex'] = wasmExports['add_property_zval_ex'];
  _add_property_null_ex = Module['_add_property_null_ex'] = wasmExports['add_property_null_ex'];
  _zend_call_method_if_exists = Module['_zend_call_method_if_exists'] = wasmExports['zend_call_method_if_exists'];
  _php_uuencode = Module['_php_uuencode'] = wasmExports['php_uuencode'];
  _php_uudecode = Module['_php_uudecode'] = wasmExports['php_uudecode'];
  _var_destroy = Module['_var_destroy'] = wasmExports['var_destroy'];
  __efree_large = Module['__efree_large'] = wasmExports['_efree_large'];
  _php_var_unserialize_get_allowed_classes = Module['_php_var_unserialize_get_allowed_classes'] = wasmExports['php_var_unserialize_get_allowed_classes'];
  _php_var_unserialize_set_allowed_classes = Module['_php_var_unserialize_set_allowed_classes'] = wasmExports['php_var_unserialize_set_allowed_classes'];
  _php_var_unserialize_set_max_depth = Module['_php_var_unserialize_set_max_depth'] = wasmExports['php_var_unserialize_set_max_depth'];
  _php_var_unserialize_get_max_depth = Module['_php_var_unserialize_get_max_depth'] = wasmExports['php_var_unserialize_get_max_depth'];
  _php_var_unserialize_set_cur_depth = Module['_php_var_unserialize_set_cur_depth'] = wasmExports['php_var_unserialize_set_cur_depth'];
  _php_var_unserialize_get_cur_depth = Module['_php_var_unserialize_get_cur_depth'] = wasmExports['php_var_unserialize_get_cur_depth'];
  _zend_is_valid_class_name = Module['_zend_is_valid_class_name'] = wasmExports['zend_is_valid_class_name'];
  _zend_hash_lookup = Module['_zend_hash_lookup'] = wasmExports['zend_hash_lookup'];
  _zend_verify_prop_assignable_by_ref = Module['_zend_verify_prop_assignable_by_ref'] = wasmExports['zend_verify_prop_assignable_by_ref'];
  _php_var_dump = Module['_php_var_dump'] = wasmExports['php_var_dump'];
  _php_printf = Module['_php_printf'] = wasmExports['php_printf'];
  _php_printf_unchecked = Module['_php_printf_unchecked'] = wasmExports['php_printf_unchecked'];
  _zend_array_count = Module['_zend_array_count'] = wasmExports['zend_array_count'];
  _php_debug_zval_dump = Module['_php_debug_zval_dump'] = wasmExports['php_debug_zval_dump'];
  _php_var_export_ex = Module['_php_var_export_ex'] = wasmExports['php_var_export_ex'];
  _smart_str_append_double = Module['_smart_str_append_double'] = wasmExports['smart_str_append_double'];
  _php_var_export = Module['_php_var_export'] = wasmExports['php_var_export'];
  _php_unserialize_with_options = Module['_php_unserialize_with_options'] = wasmExports['php_unserialize_with_options'];
  _zend_memory_usage = Module['_zend_memory_usage'] = wasmExports['zend_memory_usage'];
  _zend_memory_peak_usage = Module['_zend_memory_peak_usage'] = wasmExports['zend_memory_peak_usage'];
  _zend_memory_reset_peak_usage = Module['_zend_memory_reset_peak_usage'] = wasmExports['zend_memory_reset_peak_usage'];
  _php_canonicalize_version = Module['_php_canonicalize_version'] = wasmExports['php_canonicalize_version'];
  _zend_prepare_string_for_scanning = Module['_zend_prepare_string_for_scanning'] = wasmExports['zend_prepare_string_for_scanning'];
  _zendparse = Module['_zendparse'] = wasmExports['zendparse'];
  _zend_ast_destroy = Module['_zend_ast_destroy'] = wasmExports['zend_ast_destroy'];
  _lex_scan = Module['_lex_scan'] = wasmExports['lex_scan'];
  _php_uri_parse = Module['_php_uri_parse'] = wasmExports['php_uri_parse'];
  _php_uri_get_scheme = Module['_php_uri_get_scheme'] = wasmExports['php_uri_get_scheme'];
  _php_uri_get_username = Module['_php_uri_get_username'] = wasmExports['php_uri_get_username'];
  _php_uri_get_password = Module['_php_uri_get_password'] = wasmExports['php_uri_get_password'];
  _php_uri_get_host = Module['_php_uri_get_host'] = wasmExports['php_uri_get_host'];
  _php_uri_get_port = Module['_php_uri_get_port'] = wasmExports['php_uri_get_port'];
  _php_uri_get_path = Module['_php_uri_get_path'] = wasmExports['php_uri_get_path'];
  _php_uri_get_query = Module['_php_uri_get_query'] = wasmExports['php_uri_get_query'];
  _php_uri_get_fragment = Module['_php_uri_get_fragment'] = wasmExports['php_uri_get_fragment'];
  _php_uri_free = Module['_php_uri_free'] = wasmExports['php_uri_free'];
  _php_uri_instantiate_uri = Module['_php_uri_instantiate_uri'] = wasmExports['php_uri_instantiate_uri'];
  _zend_update_exception_properties = Module['_zend_update_exception_properties'] = wasmExports['zend_update_exception_properties'];
  _zend_update_property_str = Module['_zend_update_property_str'] = wasmExports['zend_update_property_str'];
  _zend_update_property_ex = Module['_zend_update_property_ex'] = wasmExports['zend_update_property_ex'];
  _php_uri_object_create = Module['_php_uri_object_create'] = wasmExports['php_uri_object_create'];
  _php_uri_object_handler_free = Module['_php_uri_object_handler_free'] = wasmExports['php_uri_object_handler_free'];
  _php_uri_object_handler_clone = Module['_php_uri_object_handler_clone'] = wasmExports['php_uri_object_handler_clone'];
  _php_uri_parser_register = Module['_php_uri_parser_register'] = wasmExports['php_uri_parser_register'];
  _zend_update_property_string = Module['_zend_update_property_string'] = wasmExports['zend_update_property_string'];
  _zend_enum_get_case_cstr = Module['_zend_enum_get_case_cstr'] = wasmExports['zend_enum_get_case_cstr'];
  _virtual_file_ex = Module['_virtual_file_ex'] = wasmExports['virtual_file_ex'];
  _OnUpdateBaseDir = Module['_OnUpdateBaseDir'] = wasmExports['OnUpdateBaseDir'];
  _php_check_specific_open_basedir = Module['_php_check_specific_open_basedir'] = wasmExports['php_check_specific_open_basedir'];
  _php_fopen_primary_script = Module['_php_fopen_primary_script'] = wasmExports['php_fopen_primary_script'];
  _zend_stream_open = Module['_zend_stream_open'] = wasmExports['zend_stream_open'];
  _php_resolve_path = Module['_php_resolve_path'] = wasmExports['php_resolve_path'];
  _zend_is_executing = Module['_zend_is_executing'] = wasmExports['zend_is_executing'];
  _php_fopen_with_path = Module['_php_fopen_with_path'] = wasmExports['php_fopen_with_path'];
  _php_strip_url_passwd = Module['_php_strip_url_passwd'] = wasmExports['php_strip_url_passwd'];
  _php_version = Module['_php_version'] = wasmExports['php_version'];
  _php_version_id = Module['_php_version_id'] = wasmExports['php_version_id'];
  _php_get_version = Module['_php_get_version'] = wasmExports['php_get_version'];
  _smart_string_append_printf = Module['_smart_string_append_printf'] = wasmExports['smart_string_append_printf'];
  __smart_string_alloc = Module['__smart_string_alloc'] = wasmExports['_smart_string_alloc'];
  _php_print_version = Module['_php_print_version'] = wasmExports['php_print_version'];
  _php_during_module_startup = Module['_php_during_module_startup'] = wasmExports['php_during_module_startup'];
  _php_during_module_shutdown = Module['_php_during_module_shutdown'] = wasmExports['php_during_module_shutdown'];
  _php_get_module_initialized = Module['_php_get_module_initialized'] = wasmExports['php_get_module_initialized'];
  _php_write = Module['_php_write'] = wasmExports['php_write'];
  _php_verror = Module['_php_verror'] = wasmExports['php_verror'];
  _zend_vstrpprintf = Module['_zend_vstrpprintf'] = wasmExports['zend_vstrpprintf'];
  _get_active_class_name = Module['_get_active_class_name'] = wasmExports['get_active_class_name'];
  _zend_strpprintf_unchecked = Module['_zend_strpprintf_unchecked'] = wasmExports['zend_strpprintf_unchecked'];
  _zend_error_zstr = Module['_zend_error_zstr'] = wasmExports['zend_error_zstr'];
  _php_error_docref1 = Module['_php_error_docref1'] = wasmExports['php_error_docref1'];
  _php_html_puts = Module['_php_html_puts'] = wasmExports['php_html_puts'];
  _refresh_memory_manager = Module['_refresh_memory_manager'] = wasmExports['refresh_memory_manager'];
  _zend_interned_strings_activate = Module['_zend_interned_strings_activate'] = wasmExports['zend_interned_strings_activate'];
  _php_output_activate = Module['_php_output_activate'] = wasmExports['php_output_activate'];
  _zend_activate = Module['_zend_activate'] = wasmExports['zend_activate'];
  _zend_set_timeout = Module['_zend_set_timeout'] = wasmExports['zend_set_timeout'];
  _php_output_start_user = Module['_php_output_start_user'] = wasmExports['php_output_start_user'];
  _php_output_set_implicit_flush = Module['_php_output_set_implicit_flush'] = wasmExports['php_output_set_implicit_flush'];
  _php_hash_environment = Module['_php_hash_environment'] = wasmExports['php_hash_environment'];
  _zend_activate_modules = Module['_zend_activate_modules'] = wasmExports['zend_activate_modules'];
  _zend_observer_fcall_end_all = Module['_zend_observer_fcall_end_all'] = wasmExports['zend_observer_fcall_end_all'];
  _zend_unset_timeout = Module['_zend_unset_timeout'] = wasmExports['zend_unset_timeout'];
  _zend_deactivate_modules = Module['_zend_deactivate_modules'] = wasmExports['zend_deactivate_modules'];
  _php_output_deactivate = Module['_php_output_deactivate'] = wasmExports['php_output_deactivate'];
  _zend_post_deactivate_modules = Module['_zend_post_deactivate_modules'] = wasmExports['zend_post_deactivate_modules'];
  _sapi_deactivate_module = Module['_sapi_deactivate_module'] = wasmExports['sapi_deactivate_module'];
  _sapi_deactivate_destroy = Module['_sapi_deactivate_destroy'] = wasmExports['sapi_deactivate_destroy'];
  _virtual_cwd_deactivate = Module['_virtual_cwd_deactivate'] = wasmExports['virtual_cwd_deactivate'];
  _zend_interned_strings_deactivate = Module['_zend_interned_strings_deactivate'] = wasmExports['zend_interned_strings_deactivate'];
  _shutdown_memory_manager = Module['_shutdown_memory_manager'] = wasmExports['shutdown_memory_manager'];
  _zend_set_memory_limit = Module['_zend_set_memory_limit'] = wasmExports['zend_set_memory_limit'];
  _zend_deactivate = Module['_zend_deactivate'] = wasmExports['zend_deactivate'];
  _php_com_initialize = Module['_php_com_initialize'] = wasmExports['php_com_initialize'];
  _php_register_extensions = Module['_php_register_extensions'] = wasmExports['php_register_extensions'];
  _zend_register_internal_module = Module['_zend_register_internal_module'] = wasmExports['zend_register_internal_module'];
  _php_module_startup = Module['_php_module_startup'] = wasmExports['php_module_startup'];
  _sapi_initialize_empty_request = Module['_sapi_initialize_empty_request'] = wasmExports['sapi_initialize_empty_request'];
  _php_output_startup = Module['_php_output_startup'] = wasmExports['php_output_startup'];
  _zend_observer_startup = Module['_zend_observer_startup'] = wasmExports['zend_observer_startup'];
  _php_printf_to_smart_str = Module['_php_printf_to_smart_str'] = wasmExports['php_printf_to_smart_str'];
  _php_printf_to_smart_string = Module['_php_printf_to_smart_string'] = wasmExports['php_printf_to_smart_string'];
  _zend_startup_modules = Module['_zend_startup_modules'] = wasmExports['zend_startup_modules'];
  _zend_collect_module_handlers = Module['_zend_collect_module_handlers'] = wasmExports['zend_collect_module_handlers'];
  _zend_register_functions = Module['_zend_register_functions'] = wasmExports['zend_register_functions'];
  _zend_disable_functions = Module['_zend_disable_functions'] = wasmExports['zend_disable_functions'];
  _zend_observer_post_startup = Module['_zend_observer_post_startup'] = wasmExports['zend_observer_post_startup'];
  _zend_init_internal_run_time_cache = Module['_zend_init_internal_run_time_cache'] = wasmExports['zend_init_internal_run_time_cache'];
  _cfg_get_long = Module['_cfg_get_long'] = wasmExports['cfg_get_long'];
  _sapi_deactivate = Module['_sapi_deactivate'] = wasmExports['sapi_deactivate'];
  _virtual_cwd_activate = Module['_virtual_cwd_activate'] = wasmExports['virtual_cwd_activate'];
  _zend_throw_error_exception = Module['_zend_throw_error_exception'] = wasmExports['zend_throw_error_exception'];
  _zend_trace_to_string = Module['_zend_trace_to_string'] = wasmExports['zend_trace_to_string'];
  _zend_alloc_in_memory_limit_error_reporting = Module['_zend_alloc_in_memory_limit_error_reporting'] = wasmExports['zend_alloc_in_memory_limit_error_reporting'];
  _php_output_discard_all = Module['_php_output_discard_all'] = wasmExports['php_output_discard_all'];
  _zend_objects_store_mark_destructed = Module['_zend_objects_store_mark_destructed'] = wasmExports['zend_objects_store_mark_destructed'];
  __php_stream_open_wrapper_as_file = Module['__php_stream_open_wrapper_as_file'] = wasmExports['_php_stream_open_wrapper_as_file'];
  _php_module_shutdown_wrapper = Module['_php_module_shutdown_wrapper'] = wasmExports['php_module_shutdown_wrapper'];
  _php_module_shutdown = Module['_php_module_shutdown'] = wasmExports['php_module_shutdown'];
  _zend_ini_shutdown = Module['_zend_ini_shutdown'] = wasmExports['zend_ini_shutdown'];
  _php_output_shutdown = Module['_php_output_shutdown'] = wasmExports['php_output_shutdown'];
  _zend_interned_strings_dtor = Module['_zend_interned_strings_dtor'] = wasmExports['zend_interned_strings_dtor'];
  _zend_observer_shutdown = Module['_zend_observer_shutdown'] = wasmExports['zend_observer_shutdown'];
  _php_execute_script_ex = Module['_php_execute_script_ex'] = wasmExports['php_execute_script_ex'];
  _virtual_chdir_file = Module['_virtual_chdir_file'] = wasmExports['virtual_chdir_file'];
  _zend_ini_long = Module['_zend_ini_long'] = wasmExports['zend_ini_long'];
  _zend_execute_script = Module['_zend_execute_script'] = wasmExports['zend_execute_script'];
  _php_execute_script = Module['_php_execute_script'] = wasmExports['php_execute_script'];
  _php_execute_simple_script = Module['_php_execute_simple_script'] = wasmExports['php_execute_simple_script'];
  _zend_execute_scripts = Module['_zend_execute_scripts'] = wasmExports['zend_execute_scripts'];
  _php_handle_aborted_connection = Module['_php_handle_aborted_connection'] = wasmExports['php_handle_aborted_connection'];
  _php_handle_auth_data = Module['_php_handle_auth_data'] = wasmExports['php_handle_auth_data'];
  _zend_binary_strncasecmp = Module['_zend_binary_strncasecmp'] = wasmExports['zend_binary_strncasecmp'];
  _php_lint_script = Module['_php_lint_script'] = wasmExports['php_lint_script'];
  _OnUpdateStr = Module['_OnUpdateStr'] = wasmExports['OnUpdateStr'];
  _zend_ini_parse_uquantity_warn = Module['_zend_ini_parse_uquantity_warn'] = wasmExports['zend_ini_parse_uquantity_warn'];
  _php_register_internal_extensions = Module['_php_register_internal_extensions'] = wasmExports['php_register_internal_extensions'];
  _zend_ini_color_displayer_cb = Module['_zend_ini_color_displayer_cb'] = wasmExports['zend_ini_color_displayer_cb'];
  _OnUpdateStrNotEmpty = Module['_OnUpdateStrNotEmpty'] = wasmExports['OnUpdateStrNotEmpty'];
  _OnUpdateLongGEZero = Module['_OnUpdateLongGEZero'] = wasmExports['OnUpdateLongGEZero'];
  _php_network_freeaddresses = Module['_php_network_freeaddresses'] = wasmExports['php_network_freeaddresses'];
  _php_network_getaddresses = Module['_php_network_getaddresses'] = wasmExports['php_network_getaddresses'];
  _php_network_connect_socket = Module['_php_network_connect_socket'] = wasmExports['php_network_connect_socket'];
  _php_network_bind_socket_to_local_addr = Module['_php_network_bind_socket_to_local_addr'] = wasmExports['php_network_bind_socket_to_local_addr'];
  _php_network_populate_name_from_sockaddr = Module['_php_network_populate_name_from_sockaddr'] = wasmExports['php_network_populate_name_from_sockaddr'];
  _php_network_get_peer_name = Module['_php_network_get_peer_name'] = wasmExports['php_network_get_peer_name'];
  _php_network_get_sock_name = Module['_php_network_get_sock_name'] = wasmExports['php_network_get_sock_name'];
  _php_network_accept_incoming = Module['_php_network_accept_incoming'] = wasmExports['php_network_accept_incoming'];
  _php_network_connect_socket_to_host = Module['_php_network_connect_socket_to_host'] = wasmExports['php_network_connect_socket_to_host'];
  _php_any_addr = Module['_php_any_addr'] = wasmExports['php_any_addr'];
  _php_sockaddr_size = Module['_php_sockaddr_size'] = wasmExports['php_sockaddr_size'];
  _php_set_sock_blocking = Module['_php_set_sock_blocking'] = wasmExports['php_set_sock_blocking'];
  _zend_stack_init = Module['_zend_stack_init'] = wasmExports['zend_stack_init'];
  _zend_stack_top = Module['_zend_stack_top'] = wasmExports['zend_stack_top'];
  _php_output_handler_dtor = Module['_php_output_handler_dtor'] = wasmExports['php_output_handler_dtor'];
  _zend_stack_del_top = Module['_zend_stack_del_top'] = wasmExports['zend_stack_del_top'];
  _zend_stack_destroy = Module['_zend_stack_destroy'] = wasmExports['zend_stack_destroy'];
  _zend_is_compiling = Module['_zend_is_compiling'] = wasmExports['zend_is_compiling'];
  _zend_get_compiled_filename = Module['_zend_get_compiled_filename'] = wasmExports['zend_get_compiled_filename'];
  _zend_get_compiled_lineno = Module['_zend_get_compiled_lineno'] = wasmExports['zend_get_compiled_lineno'];
  _php_output_handler_free = Module['_php_output_handler_free'] = wasmExports['php_output_handler_free'];
  _php_output_write_unbuffered = Module['_php_output_write_unbuffered'] = wasmExports['php_output_write_unbuffered'];
  _zend_stack_count = Module['_zend_stack_count'] = wasmExports['zend_stack_count'];
  _zend_stack_apply_with_argument = Module['_zend_stack_apply_with_argument'] = wasmExports['zend_stack_apply_with_argument'];
  _php_output_flush = Module['_php_output_flush'] = wasmExports['php_output_flush'];
  _zend_stack_push = Module['_zend_stack_push'] = wasmExports['zend_stack_push'];
  _zend_stack_base = Module['_zend_stack_base'] = wasmExports['zend_stack_base'];
  _php_output_flush_all = Module['_php_output_flush_all'] = wasmExports['php_output_flush_all'];
  _php_output_clean = Module['_php_output_clean'] = wasmExports['php_output_clean'];
  _php_output_clean_all = Module['_php_output_clean_all'] = wasmExports['php_output_clean_all'];
  _php_output_get_length = Module['_php_output_get_length'] = wasmExports['php_output_get_length'];
  _php_output_get_active_handler = Module['_php_output_get_active_handler'] = wasmExports['php_output_get_active_handler'];
  _php_output_handler_start = Module['_php_output_handler_start'] = wasmExports['php_output_handler_start'];
  _php_output_start_devnull = Module['_php_output_start_devnull'] = wasmExports['php_output_start_devnull'];
  _php_output_handler_create_user = Module['_php_output_handler_create_user'] = wasmExports['php_output_handler_create_user'];
  _php_output_handler_set_context = Module['_php_output_handler_set_context'] = wasmExports['php_output_handler_set_context'];
  _php_output_handler_alias = Module['_php_output_handler_alias'] = wasmExports['php_output_handler_alias'];
  _php_output_handler_started = Module['_php_output_handler_started'] = wasmExports['php_output_handler_started'];
  _php_output_handler_reverse_conflict_register = Module['_php_output_handler_reverse_conflict_register'] = wasmExports['php_output_handler_reverse_conflict_register'];
  _php_default_post_reader = Module['_php_default_post_reader'] = wasmExports['php_default_post_reader'];
  _sapi_register_default_post_reader = Module['_sapi_register_default_post_reader'] = wasmExports['sapi_register_default_post_reader'];
  _php_default_input_filter = Module['_php_default_input_filter'] = wasmExports['php_default_input_filter'];
  _php_ini_builder_prepend = Module['_php_ini_builder_prepend'] = wasmExports['php_ini_builder_prepend'];
  _php_ini_builder_unquoted = Module['_php_ini_builder_unquoted'] = wasmExports['php_ini_builder_unquoted'];
  _php_ini_builder_quoted = Module['_php_ini_builder_quoted'] = wasmExports['php_ini_builder_quoted'];
  _php_ini_builder_define = Module['_php_ini_builder_define'] = wasmExports['php_ini_builder_define'];
  _config_zval_dtor = Module['_config_zval_dtor'] = wasmExports['config_zval_dtor'];
  _free_estring = Module['_free_estring'] = wasmExports['free_estring'];
  _zend_load_extension = Module['_zend_load_extension'] = wasmExports['zend_load_extension'];
  _zend_load_extension_handle = Module['_zend_load_extension_handle'] = wasmExports['zend_load_extension_handle'];
  _php_parse_user_ini_file = Module['_php_parse_user_ini_file'] = wasmExports['php_parse_user_ini_file'];
  _php_ini_activate_config = Module['_php_ini_activate_config'] = wasmExports['php_ini_activate_config'];
  _php_ini_has_per_dir_config = Module['_php_ini_has_per_dir_config'] = wasmExports['php_ini_has_per_dir_config'];
  _php_ini_activate_per_dir_config = Module['_php_ini_activate_per_dir_config'] = wasmExports['php_ini_activate_per_dir_config'];
  _php_ini_has_per_host_config = Module['_php_ini_has_per_host_config'] = wasmExports['php_ini_has_per_host_config'];
  _php_ini_activate_per_host_config = Module['_php_ini_activate_per_host_config'] = wasmExports['php_ini_activate_per_host_config'];
  _cfg_get_double = Module['_cfg_get_double'] = wasmExports['cfg_get_double'];
  _cfg_get_string = Module['_cfg_get_string'] = wasmExports['cfg_get_string'];
  _php_ini_get_configuration_hash = Module['_php_ini_get_configuration_hash'] = wasmExports['php_ini_get_configuration_hash'];
  _php_odbc_connstr_is_quoted = Module['_php_odbc_connstr_is_quoted'] = wasmExports['php_odbc_connstr_is_quoted'];
  _php_odbc_connstr_should_quote = Module['_php_odbc_connstr_should_quote'] = wasmExports['php_odbc_connstr_should_quote'];
  _php_odbc_connstr_estimate_quote_length = Module['_php_odbc_connstr_estimate_quote_length'] = wasmExports['php_odbc_connstr_estimate_quote_length'];
  _php_odbc_connstr_quote = Module['_php_odbc_connstr_quote'] = wasmExports['php_odbc_connstr_quote'];
  _php_open_temporary_fd = Module['_php_open_temporary_fd'] = wasmExports['php_open_temporary_fd'];
  _php_open_temporary_file = Module['_php_open_temporary_file'] = wasmExports['php_open_temporary_file'];
  _zend_llist_clean = Module['_zend_llist_clean'] = wasmExports['zend_llist_clean'];
  _php_remove_tick_function = Module['_php_remove_tick_function'] = wasmExports['php_remove_tick_function'];
  _php_register_variable = Module['_php_register_variable'] = wasmExports['php_register_variable'];
  _zend_hash_str_update_ind = Module['_zend_hash_str_update_ind'] = wasmExports['zend_hash_str_update_ind'];
  _php_register_known_variable = Module['_php_register_known_variable'] = wasmExports['php_register_known_variable'];
  _php_build_argv = Module['_php_build_argv'] = wasmExports['php_build_argv'];
  _zend_activate_auto_globals = Module['_zend_activate_auto_globals'] = wasmExports['zend_activate_auto_globals'];
  _zend_register_auto_global = Module['_zend_register_auto_global'] = wasmExports['zend_register_auto_global'];
  _destroy_uploaded_files_hash = Module['_destroy_uploaded_files_hash'] = wasmExports['destroy_uploaded_files_hash'];
  _zend_multibyte_get_internal_encoding = Module['_zend_multibyte_get_internal_encoding'] = wasmExports['zend_multibyte_get_internal_encoding'];
  _zend_multibyte_encoding_detector = Module['_zend_multibyte_encoding_detector'] = wasmExports['zend_multibyte_encoding_detector'];
  _zend_llist_get_first_ex = Module['_zend_llist_get_first_ex'] = wasmExports['zend_llist_get_first_ex'];
  _zend_llist_get_next_ex = Module['_zend_llist_get_next_ex'] = wasmExports['zend_llist_get_next_ex'];
  _zend_multibyte_encoding_converter = Module['_zend_multibyte_encoding_converter'] = wasmExports['zend_multibyte_encoding_converter'];
  _zend_hash_str_add_empty_element = Module['_zend_hash_str_add_empty_element'] = wasmExports['zend_hash_str_add_empty_element'];
  _sapi_startup = Module['_sapi_startup'] = wasmExports['sapi_startup'];
  _sapi_shutdown = Module['_sapi_shutdown'] = wasmExports['sapi_shutdown'];
  _sapi_free_header = Module['_sapi_free_header'] = wasmExports['sapi_free_header'];
  _sapi_get_default_content_type = Module['_sapi_get_default_content_type'] = wasmExports['sapi_get_default_content_type'];
  _sapi_get_default_content_type_header = Module['_sapi_get_default_content_type_header'] = wasmExports['sapi_get_default_content_type_header'];
  _sapi_apply_default_charset = Module['_sapi_apply_default_charset'] = wasmExports['sapi_apply_default_charset'];
  _sapi_activate_headers_only = Module['_sapi_activate_headers_only'] = wasmExports['sapi_activate_headers_only'];
  _sapi_register_post_entry = Module['_sapi_register_post_entry'] = wasmExports['sapi_register_post_entry'];
  _sapi_get_fd = Module['_sapi_get_fd'] = wasmExports['sapi_get_fd'];
  _sapi_force_http_10 = Module['_sapi_force_http_10'] = wasmExports['sapi_force_http_10'];
  _sapi_get_target_uid = Module['_sapi_get_target_uid'] = wasmExports['sapi_get_target_uid'];
  _sapi_get_target_gid = Module['_sapi_get_target_gid'] = wasmExports['sapi_get_target_gid'];
  _sapi_terminate_process = Module['_sapi_terminate_process'] = wasmExports['sapi_terminate_process'];
  _sapi_add_request_header = Module['_sapi_add_request_header'] = wasmExports['sapi_add_request_header'];
  _ap_php_conv_10 = Module['_ap_php_conv_10'] = wasmExports['ap_php_conv_10'];
  _ap_php_conv_p2 = Module['_ap_php_conv_p2'] = wasmExports['ap_php_conv_p2'];
  _ap_php_vslprintf = Module['_ap_php_vslprintf'] = wasmExports['ap_php_vslprintf'];
  _ap_php_vsnprintf = Module['_ap_php_vsnprintf'] = wasmExports['ap_php_vsnprintf'];
  _ap_php_vasprintf = Module['_ap_php_vasprintf'] = wasmExports['ap_php_vasprintf'];
  _ap_php_asprintf = Module['_ap_php_asprintf'] = wasmExports['ap_php_asprintf'];
  _zend_dtoa = Module['_zend_dtoa'] = wasmExports['zend_dtoa'];
  _zend_freedtoa = Module['_zend_freedtoa'] = wasmExports['zend_freedtoa'];
  __php_stream_make_seekable = Module['__php_stream_make_seekable'] = wasmExports['_php_stream_make_seekable'];
  _php_stream_bucket_split = Module['_php_stream_bucket_split'] = wasmExports['php_stream_bucket_split'];
  __php_stream_filter_prepend = Module['__php_stream_filter_prepend'] = wasmExports['_php_stream_filter_prepend'];
  __php_glob_stream_get_pattern = Module['__php_glob_stream_get_pattern'] = wasmExports['_php_glob_stream_get_pattern'];
  __php_stream_mode_to_str = Module['__php_stream_mode_to_str'] = wasmExports['_php_stream_mode_to_str'];
  __php_stream_memory_get_buffer = Module['__php_stream_memory_get_buffer'] = wasmExports['_php_stream_memory_get_buffer'];
  __php_stream_fopen_temporary_file = Module['__php_stream_fopen_temporary_file'] = wasmExports['_php_stream_fopen_temporary_file'];
  __php_stream_free_enclosed = Module['__php_stream_free_enclosed'] = wasmExports['_php_stream_free_enclosed'];
  _php_stream_encloses = Module['_php_stream_encloses'] = wasmExports['php_stream_encloses'];
  __php_stream_temp_open = Module['__php_stream_temp_open'] = wasmExports['_php_stream_temp_open'];
  __php_stream_mmap_range = Module['__php_stream_mmap_range'] = wasmExports['_php_stream_mmap_range'];
  __php_stream_mmap_unmap = Module['__php_stream_mmap_unmap'] = wasmExports['_php_stream_mmap_unmap'];
  __php_stream_mmap_unmap_ex = Module['__php_stream_mmap_unmap_ex'] = wasmExports['_php_stream_mmap_unmap_ex'];
  _php_stream_parse_fopen_modes = Module['_php_stream_parse_fopen_modes'] = wasmExports['php_stream_parse_fopen_modes'];
  __php_stream_fopen = Module['__php_stream_fopen'] = wasmExports['_php_stream_fopen'];
  _php_stream_from_persistent_id = Module['_php_stream_from_persistent_id'] = wasmExports['php_stream_from_persistent_id'];
  __php_stream_fopen_with_path = Module['__php_stream_fopen_with_path'] = wasmExports['_php_stream_fopen_with_path'];
  _zend_register_persistent_resource = Module['_zend_register_persistent_resource'] = wasmExports['zend_register_persistent_resource'];
  __php_stream_fill_read_buffer = Module['__php_stream_fill_read_buffer'] = wasmExports['_php_stream_fill_read_buffer'];
  __php_stream_putc = Module['__php_stream_putc'] = wasmExports['_php_stream_putc'];
  __php_stream_puts = Module['__php_stream_puts'] = wasmExports['_php_stream_puts'];
  __php_stream_copy_to_stream = Module['__php_stream_copy_to_stream'] = wasmExports['_php_stream_copy_to_stream'];
  _php_stream_generic_socket_factory = Module['_php_stream_generic_socket_factory'] = wasmExports['php_stream_generic_socket_factory'];
  _php_stream_xport_register = Module['_php_stream_xport_register'] = wasmExports['php_stream_xport_register'];
  _php_register_url_stream_wrapper_volatile = Module['_php_register_url_stream_wrapper_volatile'] = wasmExports['php_register_url_stream_wrapper_volatile'];
  _php_unregister_url_stream_wrapper_volatile = Module['_php_unregister_url_stream_wrapper_volatile'] = wasmExports['php_unregister_url_stream_wrapper_volatile'];
  _zend_llist_count = Module['_zend_llist_count'] = wasmExports['zend_llist_count'];
  _php_stream_xport_unregister = Module['_php_stream_xport_unregister'] = wasmExports['php_stream_xport_unregister'];
  _php_stream_xport_listen = Module['_php_stream_xport_listen'] = wasmExports['php_stream_xport_listen'];
  _php_stream_xport_connect = Module['_php_stream_xport_connect'] = wasmExports['php_stream_xport_connect'];
  _php_stream_xport_bind = Module['_php_stream_xport_bind'] = wasmExports['php_stream_xport_bind'];
  _add_property_resource_ex = Module['_add_property_resource_ex'] = wasmExports['add_property_resource_ex'];
  __zend_get_special_const = Module['__zend_get_special_const'] = wasmExports['_zend_get_special_const'];
  _zend_build_cfg = Module['_zend_build_cfg'] = wasmExports['zend_build_cfg'];
  _zend_dump_op_array = Module['_zend_dump_op_array'] = wasmExports['zend_dump_op_array'];
  _zend_create_member_string = Module['_zend_create_member_string'] = wasmExports['zend_create_member_string'];
  _zend_array_type_info = Module['_zend_array_type_info'] = wasmExports['zend_array_type_info'];
  _zend_may_throw = Module['_zend_may_throw'] = wasmExports['zend_may_throw'];
  _zend_cfg_build_predecessors = Module['_zend_cfg_build_predecessors'] = wasmExports['zend_cfg_build_predecessors'];
  _zend_cfg_compute_dominators_tree = Module['_zend_cfg_compute_dominators_tree'] = wasmExports['zend_cfg_compute_dominators_tree'];
  _zend_cfg_identify_loops = Module['_zend_cfg_identify_loops'] = wasmExports['zend_cfg_identify_loops'];
  _zend_build_ssa = Module['_zend_build_ssa'] = wasmExports['zend_build_ssa'];
  _zend_ssa_compute_use_def_chains = Module['_zend_ssa_compute_use_def_chains'] = wasmExports['zend_ssa_compute_use_def_chains'];
  _zend_ssa_find_false_dependencies = Module['_zend_ssa_find_false_dependencies'] = wasmExports['zend_ssa_find_false_dependencies'];
  _zend_ssa_find_sccs = Module['_zend_ssa_find_sccs'] = wasmExports['zend_ssa_find_sccs'];
  _zend_ssa_inference = Module['_zend_ssa_inference'] = wasmExports['zend_ssa_inference'];
  _zend_std_get_constructor = Module['_zend_std_get_constructor'] = wasmExports['zend_std_get_constructor'];
  _zend_get_call_op = Module['_zend_get_call_op'] = wasmExports['zend_get_call_op'];
  _zend_dump_var = Module['_zend_dump_var'] = wasmExports['zend_dump_var'];
  _increment_function = Module['_increment_function'] = wasmExports['increment_function'];
  _decrement_function = Module['_decrement_function'] = wasmExports['decrement_function'];
  _zend_analyze_calls = Module['_zend_analyze_calls'] = wasmExports['zend_analyze_calls'];
  _zend_build_call_graph = Module['_zend_build_call_graph'] = wasmExports['zend_build_call_graph'];
  _zend_analyze_call_graph = Module['_zend_analyze_call_graph'] = wasmExports['zend_analyze_call_graph'];
  _zend_build_call_map = Module['_zend_build_call_map'] = wasmExports['zend_build_call_map'];
  _zend_dfg_add_use_def_op = Module['_zend_dfg_add_use_def_op'] = wasmExports['zend_dfg_add_use_def_op'];
  _zend_dump_ssa_var = Module['_zend_dump_ssa_var'] = wasmExports['zend_dump_ssa_var'];
  _zend_dump_op = Module['_zend_dump_op'] = wasmExports['zend_dump_op'];
  _zend_get_opcode_name = Module['_zend_get_opcode_name'] = wasmExports['zend_get_opcode_name'];
  _zend_get_opcode_flags = Module['_zend_get_opcode_flags'] = wasmExports['zend_get_opcode_flags'];
  _zend_dump_op_line = Module['_zend_dump_op_line'] = wasmExports['zend_dump_op_line'];
  _zend_get_func_info = Module['_zend_get_func_info'] = wasmExports['zend_get_func_info'];
  _zend_get_resource_handle = Module['_zend_get_resource_handle'] = wasmExports['zend_get_resource_handle'];
  _zend_inference_propagate_range = Module['_zend_inference_propagate_range'] = wasmExports['zend_inference_propagate_range'];
  _zend_array_element_type = Module['_zend_array_element_type'] = wasmExports['zend_array_element_type'];
  _zend_fetch_arg_info_type = Module['_zend_fetch_arg_info_type'] = wasmExports['zend_fetch_arg_info_type'];
  _zend_update_type_info = Module['_zend_update_type_info'] = wasmExports['zend_update_type_info'];
  _zend_init_func_return_info = Module['_zend_init_func_return_info'] = wasmExports['zend_init_func_return_info'];
  _zend_may_throw_ex = Module['_zend_may_throw_ex'] = wasmExports['zend_may_throw_ex'];
  _get_binary_op = Module['_get_binary_op'] = wasmExports['get_binary_op'];
  _zend_binary_op_produces_error = Module['_zend_binary_op_produces_error'] = wasmExports['zend_binary_op_produces_error'];
  _get_unary_op = Module['_get_unary_op'] = wasmExports['get_unary_op'];
  _zend_unary_op_produces_error = Module['_zend_unary_op_produces_error'] = wasmExports['zend_unary_op_produces_error'];
  _zend_recalc_live_ranges = Module['_zend_recalc_live_ranges'] = wasmExports['zend_recalc_live_ranges'];
  _zend_optimizer_register_pass = Module['_zend_optimizer_register_pass'] = wasmExports['zend_optimizer_register_pass'];
  _zend_optimizer_unregister_pass = Module['_zend_optimizer_unregister_pass'] = wasmExports['zend_optimizer_unregister_pass'];
  _zend_ssa_rename_op = Module['_zend_ssa_rename_op'] = wasmExports['zend_ssa_rename_op'];
  _zend_mm_refresh_key_child = Module['_zend_mm_refresh_key_child'] = wasmExports['zend_mm_refresh_key_child'];
  _zend_mm_gc = Module['_zend_mm_gc'] = wasmExports['zend_mm_gc'];
  _zend_mm_shutdown = Module['_zend_mm_shutdown'] = wasmExports['zend_mm_shutdown'];
  ___zend_free = Module['___zend_free'] = wasmExports['__zend_free'];
  __zend_mm_alloc = Module['__zend_mm_alloc'] = wasmExports['_zend_mm_alloc'];
  __zend_mm_free = Module['__zend_mm_free'] = wasmExports['_zend_mm_free'];
  __zend_mm_realloc = Module['__zend_mm_realloc'] = wasmExports['_zend_mm_realloc'];
  __zend_mm_realloc2 = Module['__zend_mm_realloc2'] = wasmExports['_zend_mm_realloc2'];
  __zend_mm_block_size = Module['__zend_mm_block_size'] = wasmExports['_zend_mm_block_size'];
  _is_zend_ptr = Module['_is_zend_ptr'] = wasmExports['is_zend_ptr'];
  __emalloc_112 = Module['__emalloc_112'] = wasmExports['_emalloc_112'];
  __emalloc_192 = Module['__emalloc_192'] = wasmExports['_emalloc_192'];
  __emalloc_224 = Module['__emalloc_224'] = wasmExports['_emalloc_224'];
  __emalloc_384 = Module['__emalloc_384'] = wasmExports['_emalloc_384'];
  __emalloc_448 = Module['__emalloc_448'] = wasmExports['_emalloc_448'];
  __emalloc_512 = Module['__emalloc_512'] = wasmExports['_emalloc_512'];
  __emalloc_640 = Module['__emalloc_640'] = wasmExports['_emalloc_640'];
  __emalloc_768 = Module['__emalloc_768'] = wasmExports['_emalloc_768'];
  __emalloc_896 = Module['__emalloc_896'] = wasmExports['_emalloc_896'];
  __emalloc_1280 = Module['__emalloc_1280'] = wasmExports['_emalloc_1280'];
  __emalloc_1536 = Module['__emalloc_1536'] = wasmExports['_emalloc_1536'];
  __emalloc_1792 = Module['__emalloc_1792'] = wasmExports['_emalloc_1792'];
  __emalloc_2048 = Module['__emalloc_2048'] = wasmExports['_emalloc_2048'];
  __emalloc_2560 = Module['__emalloc_2560'] = wasmExports['_emalloc_2560'];
  __emalloc_3072 = Module['__emalloc_3072'] = wasmExports['_emalloc_3072'];
  __efree_8 = Module['__efree_8'] = wasmExports['_efree_8'];
  __efree_16 = Module['__efree_16'] = wasmExports['_efree_16'];
  __efree_24 = Module['__efree_24'] = wasmExports['_efree_24'];
  __efree_40 = Module['__efree_40'] = wasmExports['_efree_40'];
  __efree_56 = Module['__efree_56'] = wasmExports['_efree_56'];
  __efree_64 = Module['__efree_64'] = wasmExports['_efree_64'];
  __efree_80 = Module['__efree_80'] = wasmExports['_efree_80'];
  __efree_96 = Module['__efree_96'] = wasmExports['_efree_96'];
  __efree_112 = Module['__efree_112'] = wasmExports['_efree_112'];
  __efree_128 = Module['__efree_128'] = wasmExports['_efree_128'];
  __efree_192 = Module['__efree_192'] = wasmExports['_efree_192'];
  __efree_224 = Module['__efree_224'] = wasmExports['_efree_224'];
  __efree_256 = Module['__efree_256'] = wasmExports['_efree_256'];
  __efree_320 = Module['__efree_320'] = wasmExports['_efree_320'];
  __efree_384 = Module['__efree_384'] = wasmExports['_efree_384'];
  __efree_448 = Module['__efree_448'] = wasmExports['_efree_448'];
  __efree_512 = Module['__efree_512'] = wasmExports['_efree_512'];
  __efree_640 = Module['__efree_640'] = wasmExports['_efree_640'];
  __efree_768 = Module['__efree_768'] = wasmExports['_efree_768'];
  __efree_896 = Module['__efree_896'] = wasmExports['_efree_896'];
  __efree_1024 = Module['__efree_1024'] = wasmExports['_efree_1024'];
  __efree_1280 = Module['__efree_1280'] = wasmExports['_efree_1280'];
  __efree_1536 = Module['__efree_1536'] = wasmExports['_efree_1536'];
  __efree_1792 = Module['__efree_1792'] = wasmExports['_efree_1792'];
  __efree_2048 = Module['__efree_2048'] = wasmExports['_efree_2048'];
  __efree_2560 = Module['__efree_2560'] = wasmExports['_efree_2560'];
  __efree_3072 = Module['__efree_3072'] = wasmExports['_efree_3072'];
  __efree_huge = Module['__efree_huge'] = wasmExports['_efree_huge'];
  __erealloc2 = Module['__erealloc2'] = wasmExports['_erealloc2'];
  __zend_mem_block_size = Module['__zend_mem_block_size'] = wasmExports['_zend_mem_block_size'];
  __safe_malloc = Module['__safe_malloc'] = wasmExports['_safe_malloc'];
  _start_memory_manager = Module['_start_memory_manager'] = wasmExports['start_memory_manager'];
  _zend_mm_set_heap = Module['_zend_mm_set_heap'] = wasmExports['zend_mm_set_heap'];
  _zend_mm_get_heap = Module['_zend_mm_get_heap'] = wasmExports['zend_mm_get_heap'];
  _zend_mm_is_custom_heap = Module['_zend_mm_is_custom_heap'] = wasmExports['zend_mm_is_custom_heap'];
  _zend_mm_set_custom_handlers = Module['_zend_mm_set_custom_handlers'] = wasmExports['zend_mm_set_custom_handlers'];
  _zend_mm_set_custom_handlers_ex = Module['_zend_mm_set_custom_handlers_ex'] = wasmExports['zend_mm_set_custom_handlers_ex'];
  _zend_mm_get_custom_handlers = Module['_zend_mm_get_custom_handlers'] = wasmExports['zend_mm_get_custom_handlers'];
  _zend_mm_get_custom_handlers_ex = Module['_zend_mm_get_custom_handlers_ex'] = wasmExports['zend_mm_get_custom_handlers_ex'];
  _zend_mm_get_storage = Module['_zend_mm_get_storage'] = wasmExports['zend_mm_get_storage'];
  _zend_mm_startup = Module['_zend_mm_startup'] = wasmExports['zend_mm_startup'];
  _zend_mm_startup_ex = Module['_zend_mm_startup_ex'] = wasmExports['zend_mm_startup_ex'];
  _zend_set_dl_use_deepbind = Module['_zend_set_dl_use_deepbind'] = wasmExports['zend_set_dl_use_deepbind'];
  _zend_get_parameters_array_ex = Module['_zend_get_parameters_array_ex'] = wasmExports['zend_get_parameters_array_ex'];
  _zend_copy_parameters_array = Module['_zend_copy_parameters_array'] = wasmExports['zend_copy_parameters_array'];
  _zend_wrong_property_read = Module['_zend_wrong_property_read'] = wasmExports['zend_wrong_property_read'];
  _zend_get_type_by_const = Module['_zend_get_type_by_const'] = wasmExports['zend_get_type_by_const'];
  _zend_wrong_callback_error = Module['_zend_wrong_callback_error'] = wasmExports['zend_wrong_callback_error'];
  _zend_wrong_callback_or_null_error = Module['_zend_wrong_callback_or_null_error'] = wasmExports['zend_wrong_callback_or_null_error'];
  _zend_wrong_parameter_class_error = Module['_zend_wrong_parameter_class_error'] = wasmExports['zend_wrong_parameter_class_error'];
  _zend_wrong_parameter_class_or_null_error = Module['_zend_wrong_parameter_class_or_null_error'] = wasmExports['zend_wrong_parameter_class_or_null_error'];
  _zend_wrong_parameter_class_or_string_error = Module['_zend_wrong_parameter_class_or_string_error'] = wasmExports['zend_wrong_parameter_class_or_string_error'];
  _zend_wrong_parameter_class_or_string_or_null_error = Module['_zend_wrong_parameter_class_or_string_or_null_error'] = wasmExports['zend_wrong_parameter_class_or_string_or_null_error'];
  _zend_wrong_parameter_class_or_long_error = Module['_zend_wrong_parameter_class_or_long_error'] = wasmExports['zend_wrong_parameter_class_or_long_error'];
  _zend_wrong_parameter_class_or_long_or_null_error = Module['_zend_wrong_parameter_class_or_long_or_null_error'] = wasmExports['zend_wrong_parameter_class_or_long_or_null_error'];
  _zend_unexpected_extra_named_error = Module['_zend_unexpected_extra_named_error'] = wasmExports['zend_unexpected_extra_named_error'];
  _zend_argument_error_variadic = Module['_zend_argument_error_variadic'] = wasmExports['zend_argument_error_variadic'];
  _zend_class_redeclaration_error_ex = Module['_zend_class_redeclaration_error_ex'] = wasmExports['zend_class_redeclaration_error_ex'];
  _zend_parse_arg_bool_weak = Module['_zend_parse_arg_bool_weak'] = wasmExports['zend_parse_arg_bool_weak'];
  _zend_active_function_ex = Module['_zend_active_function_ex'] = wasmExports['zend_active_function_ex'];
  _zend_parse_arg_long_weak = Module['_zend_parse_arg_long_weak'] = wasmExports['zend_parse_arg_long_weak'];
  _zend_incompatible_string_to_long_error = Module['_zend_incompatible_string_to_long_error'] = wasmExports['zend_incompatible_string_to_long_error'];
  _zend_parse_arg_double_weak = Module['_zend_parse_arg_double_weak'] = wasmExports['zend_parse_arg_double_weak'];
  _zend_parse_arg_str_weak = Module['_zend_parse_arg_str_weak'] = wasmExports['zend_parse_arg_str_weak'];
  _zend_parse_parameter = Module['_zend_parse_parameter'] = wasmExports['zend_parse_parameter'];
  _zend_is_callable_at_frame = Module['_zend_is_callable_at_frame'] = wasmExports['zend_is_callable_at_frame'];
  _zend_parse_method_parameters_ex = Module['_zend_parse_method_parameters_ex'] = wasmExports['zend_parse_method_parameters_ex'];
  _zend_merge_properties = Module['_zend_merge_properties'] = wasmExports['zend_merge_properties'];
  _zend_verify_class_constant_type = Module['_zend_verify_class_constant_type'] = wasmExports['zend_verify_class_constant_type'];
  _object_properties_init_ex = Module['_object_properties_init_ex'] = wasmExports['object_properties_init_ex'];
  _zend_readonly_property_modification_error = Module['_zend_readonly_property_modification_error'] = wasmExports['zend_readonly_property_modification_error'];
  _add_assoc_resource_ex = Module['_add_assoc_resource_ex'] = wasmExports['add_assoc_resource_ex'];
  _add_assoc_array_ex = Module['_add_assoc_array_ex'] = wasmExports['add_assoc_array_ex'];
  _add_assoc_object_ex = Module['_add_assoc_object_ex'] = wasmExports['add_assoc_object_ex'];
  _add_assoc_reference_ex = Module['_add_assoc_reference_ex'] = wasmExports['add_assoc_reference_ex'];
  _add_index_null = Module['_add_index_null'] = wasmExports['add_index_null'];
  _add_index_resource = Module['_add_index_resource'] = wasmExports['add_index_resource'];
  _add_index_array = Module['_add_index_array'] = wasmExports['add_index_array'];
  _add_index_object = Module['_add_index_object'] = wasmExports['add_index_object'];
  _add_index_reference = Module['_add_index_reference'] = wasmExports['add_index_reference'];
  _add_next_index_bool = Module['_add_next_index_bool'] = wasmExports['add_next_index_bool'];
  _add_next_index_double = Module['_add_next_index_double'] = wasmExports['add_next_index_double'];
  _add_next_index_array = Module['_add_next_index_array'] = wasmExports['add_next_index_array'];
  _add_next_index_reference = Module['_add_next_index_reference'] = wasmExports['add_next_index_reference'];
  _add_property_long_ex = Module['_add_property_long_ex'] = wasmExports['add_property_long_ex'];
  _add_property_bool_ex = Module['_add_property_bool_ex'] = wasmExports['add_property_bool_ex'];
  _add_property_double_ex = Module['_add_property_double_ex'] = wasmExports['add_property_double_ex'];
  _add_property_str_ex = Module['_add_property_str_ex'] = wasmExports['add_property_str_ex'];
  _add_property_stringl_ex = Module['_add_property_stringl_ex'] = wasmExports['add_property_stringl_ex'];
  _add_property_array_ex = Module['_add_property_array_ex'] = wasmExports['add_property_array_ex'];
  _add_property_object_ex = Module['_add_property_object_ex'] = wasmExports['add_property_object_ex'];
  _add_property_reference_ex = Module['_add_property_reference_ex'] = wasmExports['add_property_reference_ex'];
  _zend_destroy_modules = Module['_zend_destroy_modules'] = wasmExports['zend_destroy_modules'];
  _zend_hash_graceful_reverse_destroy = Module['_zend_hash_graceful_reverse_destroy'] = wasmExports['zend_hash_graceful_reverse_destroy'];
  _zend_next_free_module = Module['_zend_next_free_module'] = wasmExports['zend_next_free_module'];
  _zend_set_function_arg_flags = Module['_zend_set_function_arg_flags'] = wasmExports['zend_set_function_arg_flags'];
  _zend_unregister_functions = Module['_zend_unregister_functions'] = wasmExports['zend_unregister_functions'];
  _zend_check_magic_method_implementation = Module['_zend_check_magic_method_implementation'] = wasmExports['zend_check_magic_method_implementation'];
  _zend_add_magic_method = Module['_zend_add_magic_method'] = wasmExports['zend_add_magic_method'];
  _zend_startup_module = Module['_zend_startup_module'] = wasmExports['zend_startup_module'];
  _zend_get_module_started = Module['_zend_get_module_started'] = wasmExports['zend_get_module_started'];
  _zend_register_internal_class_ex = Module['_zend_register_internal_class_ex'] = wasmExports['zend_register_internal_class_ex'];
  _zend_do_inheritance_ex = Module['_zend_do_inheritance_ex'] = wasmExports['zend_do_inheritance_ex'];
  _zend_initialize_class_data = Module['_zend_initialize_class_data'] = wasmExports['zend_initialize_class_data'];
  _zend_do_implement_interface = Module['_zend_do_implement_interface'] = wasmExports['zend_do_implement_interface'];
  _zend_register_internal_class = Module['_zend_register_internal_class'] = wasmExports['zend_register_internal_class'];
  _zend_register_class_alias_ex = Module['_zend_register_class_alias_ex'] = wasmExports['zend_register_class_alias_ex'];
  _zend_set_hash_symbol = Module['_zend_set_hash_symbol'] = wasmExports['zend_set_hash_symbol'];
  _zend_get_callable_name_ex = Module['_zend_get_callable_name_ex'] = wasmExports['zend_get_callable_name_ex'];
  _zend_get_callable_name = Module['_zend_get_callable_name'] = wasmExports['zend_get_callable_name'];
  _zend_check_protected = Module['_zend_check_protected'] = wasmExports['zend_check_protected'];
  _zend_get_call_trampoline_func = Module['_zend_get_call_trampoline_func'] = wasmExports['zend_get_call_trampoline_func'];
  _zend_std_get_static_method = Module['_zend_std_get_static_method'] = wasmExports['zend_std_get_static_method'];
  _zend_make_callable = Module['_zend_make_callable'] = wasmExports['zend_make_callable'];
  _zend_fcall_info_args_clear = Module['_zend_fcall_info_args_clear'] = wasmExports['zend_fcall_info_args_clear'];
  _zend_fcall_info_args_save = Module['_zend_fcall_info_args_save'] = wasmExports['zend_fcall_info_args_save'];
  _zend_fcall_info_args_restore = Module['_zend_fcall_info_args_restore'] = wasmExports['zend_fcall_info_args_restore'];
  _zend_fcall_info_args_ex = Module['_zend_fcall_info_args_ex'] = wasmExports['zend_fcall_info_args_ex'];
  _zend_fcall_info_args = Module['_zend_fcall_info_args'] = wasmExports['zend_fcall_info_args'];
  _zend_fcall_info_argp = Module['_zend_fcall_info_argp'] = wasmExports['zend_fcall_info_argp'];
  _zend_fcall_info_argv = Module['_zend_fcall_info_argv'] = wasmExports['zend_fcall_info_argv'];
  _zend_fcall_info_argn = Module['_zend_fcall_info_argn'] = wasmExports['zend_fcall_info_argn'];
  _zend_fcall_info_call = Module['_zend_fcall_info_call'] = wasmExports['zend_fcall_info_call'];
  _zend_try_assign_typed_ref_ex = Module['_zend_try_assign_typed_ref_ex'] = wasmExports['zend_try_assign_typed_ref_ex'];
  _zend_try_assign_typed_ref_bool = Module['_zend_try_assign_typed_ref_bool'] = wasmExports['zend_try_assign_typed_ref_bool'];
  _zend_try_assign_typed_ref_res = Module['_zend_try_assign_typed_ref_res'] = wasmExports['zend_try_assign_typed_ref_res'];
  _zend_try_assign_typed_ref_zval = Module['_zend_try_assign_typed_ref_zval'] = wasmExports['zend_try_assign_typed_ref_zval'];
  _zend_declare_property_ex = Module['_zend_declare_property_ex'] = wasmExports['zend_declare_property_ex'];
  _zend_declare_property = Module['_zend_declare_property'] = wasmExports['zend_declare_property'];
  _zend_declare_property_null = Module['_zend_declare_property_null'] = wasmExports['zend_declare_property_null'];
  _zend_declare_property_bool = Module['_zend_declare_property_bool'] = wasmExports['zend_declare_property_bool'];
  _zend_declare_property_long = Module['_zend_declare_property_long'] = wasmExports['zend_declare_property_long'];
  _zend_declare_property_double = Module['_zend_declare_property_double'] = wasmExports['zend_declare_property_double'];
  _zend_declare_property_string = Module['_zend_declare_property_string'] = wasmExports['zend_declare_property_string'];
  _zend_declare_property_stringl = Module['_zend_declare_property_stringl'] = wasmExports['zend_declare_property_stringl'];
  _zend_declare_class_constant_ex = Module['_zend_declare_class_constant_ex'] = wasmExports['zend_declare_class_constant_ex'];
  _zend_declare_class_constant = Module['_zend_declare_class_constant'] = wasmExports['zend_declare_class_constant'];
  _zend_declare_class_constant_null = Module['_zend_declare_class_constant_null'] = wasmExports['zend_declare_class_constant_null'];
  _zend_declare_class_constant_long = Module['_zend_declare_class_constant_long'] = wasmExports['zend_declare_class_constant_long'];
  _zend_declare_class_constant_bool = Module['_zend_declare_class_constant_bool'] = wasmExports['zend_declare_class_constant_bool'];
  _zend_declare_class_constant_double = Module['_zend_declare_class_constant_double'] = wasmExports['zend_declare_class_constant_double'];
  _zend_declare_class_constant_stringl = Module['_zend_declare_class_constant_stringl'] = wasmExports['zend_declare_class_constant_stringl'];
  _zend_declare_class_constant_string = Module['_zend_declare_class_constant_string'] = wasmExports['zend_declare_class_constant_string'];
  _zend_update_property_null = Module['_zend_update_property_null'] = wasmExports['zend_update_property_null'];
  _zend_unset_property = Module['_zend_unset_property'] = wasmExports['zend_unset_property'];
  _zend_update_property_bool = Module['_zend_update_property_bool'] = wasmExports['zend_update_property_bool'];
  _zend_update_property_double = Module['_zend_update_property_double'] = wasmExports['zend_update_property_double'];
  _zend_assign_to_typed_ref = Module['_zend_assign_to_typed_ref'] = wasmExports['zend_assign_to_typed_ref'];
  _zend_update_static_property = Module['_zend_update_static_property'] = wasmExports['zend_update_static_property'];
  _zend_update_static_property_null = Module['_zend_update_static_property_null'] = wasmExports['zend_update_static_property_null'];
  _zend_update_static_property_bool = Module['_zend_update_static_property_bool'] = wasmExports['zend_update_static_property_bool'];
  _zend_update_static_property_long = Module['_zend_update_static_property_long'] = wasmExports['zend_update_static_property_long'];
  _zend_update_static_property_double = Module['_zend_update_static_property_double'] = wasmExports['zend_update_static_property_double'];
  _zend_update_static_property_string = Module['_zend_update_static_property_string'] = wasmExports['zend_update_static_property_string'];
  _zend_update_static_property_stringl = Module['_zend_update_static_property_stringl'] = wasmExports['zend_update_static_property_stringl'];
  _zend_read_static_property = Module['_zend_read_static_property'] = wasmExports['zend_read_static_property'];
  _zend_save_error_handling = Module['_zend_save_error_handling'] = wasmExports['zend_save_error_handling'];
  _zend_get_object_type_case = Module['_zend_get_object_type_case'] = wasmExports['zend_get_object_type_case'];
  _zend_compile_string_to_ast = Module['_zend_compile_string_to_ast'] = wasmExports['zend_compile_string_to_ast'];
  _zend_ast_create_znode = Module['_zend_ast_create_znode'] = wasmExports['zend_ast_create_znode'];
  _zend_ast_create_fcc = Module['_zend_ast_create_fcc'] = wasmExports['zend_ast_create_fcc'];
  _zend_ast_create_zval_with_lineno = Module['_zend_ast_create_zval_with_lineno'] = wasmExports['zend_ast_create_zval_with_lineno'];
  _zend_ast_create_zval_ex = Module['_zend_ast_create_zval_ex'] = wasmExports['zend_ast_create_zval_ex'];
  _zend_ast_create_zval = Module['_zend_ast_create_zval'] = wasmExports['zend_ast_create_zval'];
  _zend_ast_create_zval_from_str = Module['_zend_ast_create_zval_from_str'] = wasmExports['zend_ast_create_zval_from_str'];
  _zend_ast_create_zval_from_long = Module['_zend_ast_create_zval_from_long'] = wasmExports['zend_ast_create_zval_from_long'];
  _zend_ast_create_constant = Module['_zend_ast_create_constant'] = wasmExports['zend_ast_create_constant'];
  _zend_ast_create_op_array = Module['_zend_ast_create_op_array'] = wasmExports['zend_ast_create_op_array'];
  _zend_ast_create_class_const_or_name = Module['_zend_ast_create_class_const_or_name'] = wasmExports['zend_ast_create_class_const_or_name'];
  _zend_ast_create_1 = Module['_zend_ast_create_1'] = wasmExports['zend_ast_create_1'];
  _zend_ast_create_2 = Module['_zend_ast_create_2'] = wasmExports['zend_ast_create_2'];
  _zend_ast_create_decl = Module['_zend_ast_create_decl'] = wasmExports['zend_ast_create_decl'];
  _zend_ast_create_0 = Module['_zend_ast_create_0'] = wasmExports['zend_ast_create_0'];
  _zend_ast_create_3 = Module['_zend_ast_create_3'] = wasmExports['zend_ast_create_3'];
  _zend_ast_create_4 = Module['_zend_ast_create_4'] = wasmExports['zend_ast_create_4'];
  _zend_ast_create_5 = Module['_zend_ast_create_5'] = wasmExports['zend_ast_create_5'];
  _zend_ast_create_va = Module['_zend_ast_create_va'] = wasmExports['zend_ast_create_va'];
  _zend_ast_create_n = Module['_zend_ast_create_n'] = wasmExports['zend_ast_create_n'];
  _zend_ast_create_ex_n = Module['_zend_ast_create_ex_n'] = wasmExports['zend_ast_create_ex_n'];
  _zend_ast_create_list_0 = Module['_zend_ast_create_list_0'] = wasmExports['zend_ast_create_list_0'];
  _zend_ast_create_list_1 = Module['_zend_ast_create_list_1'] = wasmExports['zend_ast_create_list_1'];
  _zend_ast_create_list_2 = Module['_zend_ast_create_list_2'] = wasmExports['zend_ast_create_list_2'];
  _concat_function = Module['_concat_function'] = wasmExports['concat_function'];
  _zend_ast_list_add = Module['_zend_ast_list_add'] = wasmExports['zend_ast_list_add'];
  _zend_ast_evaluate_ex = Module['_zend_ast_evaluate_ex'] = wasmExports['zend_ast_evaluate_ex'];
  _zend_ast_evaluate_inner = Module['_zend_ast_evaluate_inner'] = wasmExports['zend_ast_evaluate_inner'];
  _is_smaller_function = Module['_is_smaller_function'] = wasmExports['is_smaller_function'];
  _is_smaller_or_equal_function = Module['_is_smaller_or_equal_function'] = wasmExports['is_smaller_or_equal_function'];
  _zend_std_build_object_properties_array = Module['_zend_std_build_object_properties_array'] = wasmExports['zend_std_build_object_properties_array'];
  _zend_symtable_to_proptable = Module['_zend_symtable_to_proptable'] = wasmExports['zend_symtable_to_proptable'];
  _zend_create_closure = Module['_zend_create_closure'] = wasmExports['zend_create_closure'];
  _zend_fetch_class_with_scope = Module['_zend_fetch_class_with_scope'] = wasmExports['zend_fetch_class_with_scope'];
  _zend_hash_find_ptr_lc = Module['_zend_hash_find_ptr_lc'] = wasmExports['zend_hash_find_ptr_lc'];
  _zend_bad_method_call = Module['_zend_bad_method_call'] = wasmExports['zend_bad_method_call'];
  _zend_undefined_method = Module['_zend_undefined_method'] = wasmExports['zend_undefined_method'];
  _zend_non_static_method_call = Module['_zend_non_static_method_call'] = wasmExports['zend_non_static_method_call'];
  _zend_abstract_method_call = Module['_zend_abstract_method_call'] = wasmExports['zend_abstract_method_call'];
  _zend_fetch_function_str = Module['_zend_fetch_function_str'] = wasmExports['zend_fetch_function_str'];
  _zend_invalid_class_constant_type_error = Module['_zend_invalid_class_constant_type_error'] = wasmExports['zend_invalid_class_constant_type_error'];
  _zend_get_class_constant_ex = Module['_zend_get_class_constant_ex'] = wasmExports['zend_get_class_constant_ex'];
  _zend_fetch_dimension_const = Module['_zend_fetch_dimension_const'] = wasmExports['zend_fetch_dimension_const'];
  _zend_ast_evaluate = Module['_zend_ast_evaluate'] = wasmExports['zend_ast_evaluate'];
  _zend_ast_copy = Module['_zend_ast_copy'] = wasmExports['zend_ast_copy'];
  _function_add_ref = Module['_function_add_ref'] = wasmExports['function_add_ref'];
  _zend_ast_ref_destroy = Module['_zend_ast_ref_destroy'] = wasmExports['zend_ast_ref_destroy'];
  _zend_ast_apply = Module['_zend_ast_apply'] = wasmExports['zend_ast_apply'];
  _zend_atomic_bool_init = Module['_zend_atomic_bool_init'] = wasmExports['zend_atomic_bool_init'];
  _zend_atomic_int_init = Module['_zend_atomic_int_init'] = wasmExports['zend_atomic_int_init'];
  _zend_atomic_bool_exchange = Module['_zend_atomic_bool_exchange'] = wasmExports['zend_atomic_bool_exchange'];
  _zend_atomic_bool_compare_exchange = Module['_zend_atomic_bool_compare_exchange'] = wasmExports['zend_atomic_bool_compare_exchange'];
  _zend_atomic_int_compare_exchange = Module['_zend_atomic_int_compare_exchange'] = wasmExports['zend_atomic_int_compare_exchange'];
  _zend_atomic_bool_store = Module['_zend_atomic_bool_store'] = wasmExports['zend_atomic_bool_store'];
  _zend_atomic_int_store = Module['_zend_atomic_int_store'] = wasmExports['zend_atomic_int_store'];
  _zend_atomic_bool_load = Module['_zend_atomic_bool_load'] = wasmExports['zend_atomic_bool_load'];
  _zend_atomic_int_load = Module['_zend_atomic_int_load'] = wasmExports['zend_atomic_int_load'];
  _zend_get_attribute = Module['_zend_get_attribute'] = wasmExports['zend_get_attribute'];
  _zend_get_parameter_attribute = Module['_zend_get_parameter_attribute'] = wasmExports['zend_get_parameter_attribute'];
  _zend_get_parameter_attribute_str = Module['_zend_get_parameter_attribute_str'] = wasmExports['zend_get_parameter_attribute_str'];
  _zend_vm_stack_extend = Module['_zend_vm_stack_extend'] = wasmExports['zend_vm_stack_extend'];
  _zval_internal_ptr_dtor = Module['_zval_internal_ptr_dtor'] = wasmExports['zval_internal_ptr_dtor'];
  _zend_mark_internal_attribute = Module['_zend_mark_internal_attribute'] = wasmExports['zend_mark_internal_attribute'];
  _zend_internal_attribute_register = Module['_zend_internal_attribute_register'] = wasmExports['zend_internal_attribute_register'];
  _zend_internal_attribute_get = Module['_zend_internal_attribute_get'] = wasmExports['zend_internal_attribute_get'];
  _zend_register_default_classes = Module['_zend_register_default_classes'] = wasmExports['zend_register_default_classes'];
  _gc_enabled = Module['_gc_enabled'] = wasmExports['gc_enabled'];
  _zend_gc_get_status = Module['_zend_gc_get_status'] = wasmExports['zend_gc_get_status'];
  _zend_register_constant = Module['_zend_register_constant'] = wasmExports['zend_register_constant'];
  _zend_error_zstr_at = Module['_zend_error_zstr_at'] = wasmExports['zend_error_zstr_at'];
  _zend_stack_is_empty = Module['_zend_stack_is_empty'] = wasmExports['zend_stack_is_empty'];
  _zend_stack_int_top = Module['_zend_stack_int_top'] = wasmExports['zend_stack_int_top'];
  _zend_fetch_list_dtor_id = Module['_zend_fetch_list_dtor_id'] = wasmExports['zend_fetch_list_dtor_id'];
  _zend_generator_check_placeholder_frame = Module['_zend_generator_check_placeholder_frame'] = wasmExports['zend_generator_check_placeholder_frame'];
  _zend_get_zval_ptr = Module['_zend_get_zval_ptr'] = wasmExports['zend_get_zval_ptr'];
  _zend_std_get_class_name = Module['_zend_std_get_class_name'] = wasmExports['zend_std_get_class_name'];
  _zend_destroy_static_vars = Module['_zend_destroy_static_vars'] = wasmExports['zend_destroy_static_vars'];
  _zend_init_rsrc_list = Module['_zend_init_rsrc_list'] = wasmExports['zend_init_rsrc_list'];
  _zend_restore_compiled_filename = Module['_zend_restore_compiled_filename'] = wasmExports['zend_restore_compiled_filename'];
  _do_bind_function = Module['_do_bind_function'] = wasmExports['do_bind_function'];
  _zend_bind_class_in_slot = Module['_zend_bind_class_in_slot'] = wasmExports['zend_bind_class_in_slot'];
  _do_bind_class = Module['_do_bind_class'] = wasmExports['do_bind_class'];
  _zend_is_auto_global_str = Module['_zend_is_auto_global_str'] = wasmExports['zend_is_auto_global_str'];
  _zend_get_compiled_variable_name = Module['_zend_get_compiled_variable_name'] = wasmExports['zend_get_compiled_variable_name'];
  _zend_is_smart_branch = Module['_zend_is_smart_branch'] = wasmExports['zend_is_smart_branch'];
  _execute_ex = Module['_execute_ex'] = wasmExports['execute_ex'];
  _zend_multibyte_fetch_encoding = Module['_zend_multibyte_fetch_encoding'] = wasmExports['zend_multibyte_fetch_encoding'];
  _zend_multibyte_set_filter = Module['_zend_multibyte_set_filter'] = wasmExports['zend_multibyte_set_filter'];
  _zend_multibyte_yyinput_again = Module['_zend_multibyte_yyinput_again'] = wasmExports['zend_multibyte_yyinput_again'];
  _zend_is_op_long_compatible = Module['_zend_is_op_long_compatible'] = wasmExports['zend_is_op_long_compatible'];
  _zend_type_release = Module['_zend_type_release'] = wasmExports['zend_type_release'];
  _zend_error_noreturn_unchecked = Module['_zend_error_noreturn_unchecked'] = wasmExports['zend_error_noreturn_unchecked'];
  _get_function_or_method_name = Module['_get_function_or_method_name'] = wasmExports['get_function_or_method_name'];
  _pass_two = Module['_pass_two'] = wasmExports['pass_two'];
  _zend_hooked_property_variance_error_ex = Module['_zend_hooked_property_variance_error_ex'] = wasmExports['zend_hooked_property_variance_error_ex'];
  _zend_verify_property_hook_variance = Module['_zend_verify_property_hook_variance'] = wasmExports['zend_verify_property_hook_variance'];
  _zend_hooked_property_variance_error = Module['_zend_hooked_property_variance_error'] = wasmExports['zend_hooked_property_variance_error'];
  _zend_verify_hooked_property = Module['_zend_verify_hooked_property'] = wasmExports['zend_verify_hooked_property'];
  _zend_register_null_constant = Module['_zend_register_null_constant'] = wasmExports['zend_register_null_constant'];
  _zend_register_stringl_constant = Module['_zend_register_stringl_constant'] = wasmExports['zend_register_stringl_constant'];
  _zend_verify_const_access = Module['_zend_verify_const_access'] = wasmExports['zend_verify_const_access'];
  _zend_get_constant = Module['_zend_get_constant'] = wasmExports['zend_get_constant'];
  _zend_fetch_class = Module['_zend_fetch_class'] = wasmExports['zend_fetch_class'];
  _zend_deprecated_class_constant = Module['_zend_deprecated_class_constant'] = wasmExports['zend_deprecated_class_constant'];
  _zend_deprecated_constant = Module['_zend_deprecated_constant'] = wasmExports['zend_deprecated_constant'];
  _zend_cpu_supports = Module['_zend_cpu_supports'] = wasmExports['zend_cpu_supports'];
  _zend_register_interfaces = Module['_zend_register_interfaces'] = wasmExports['zend_register_interfaces'];
  _zend_register_iterator_wrapper = Module['_zend_register_iterator_wrapper'] = wasmExports['zend_register_iterator_wrapper'];
  _zend_enum_get_case_by_value = Module['_zend_enum_get_case_by_value'] = wasmExports['zend_enum_get_case_by_value'];
  _zend_enum_add_case = Module['_zend_enum_add_case'] = wasmExports['zend_enum_add_case'];
  _zend_enum_get_case = Module['_zend_enum_get_case'] = wasmExports['zend_enum_get_case'];
  _zend_get_exception_base = Module['_zend_get_exception_base'] = wasmExports['zend_get_exception_base'];
  _zend_exception_set_previous = Module['_zend_exception_set_previous'] = wasmExports['zend_exception_set_previous'];
  _zend_is_unwind_exit = Module['_zend_is_unwind_exit'] = wasmExports['zend_is_unwind_exit'];
  _zend_is_graceful_exit = Module['_zend_is_graceful_exit'] = wasmExports['zend_is_graceful_exit'];
  _zend_exception_save = Module['_zend_exception_save'] = wasmExports['zend_exception_save'];
  __zend_observer_error_notify = Module['__zend_observer_error_notify'] = wasmExports['_zend_observer_error_notify'];
  _zend_throw_exception_object = Module['_zend_throw_exception_object'] = wasmExports['zend_throw_exception_object'];
  _zend_create_unwind_exit = Module['_zend_create_unwind_exit'] = wasmExports['zend_create_unwind_exit'];
  _zend_create_graceful_exit = Module['_zend_create_graceful_exit'] = wasmExports['zend_create_graceful_exit'];
  _zend_throw_graceful_exit = Module['_zend_throw_graceful_exit'] = wasmExports['zend_throw_graceful_exit'];
  _zend_init_fpu = Module['_zend_init_fpu'] = wasmExports['zend_init_fpu'];
  _zend_vm_stack_init = Module['_zend_vm_stack_init'] = wasmExports['zend_vm_stack_init'];
  _zend_objects_store_init = Module['_zend_objects_store_init'] = wasmExports['zend_objects_store_init'];
  _zend_hash_reverse_apply = Module['_zend_hash_reverse_apply'] = wasmExports['zend_hash_reverse_apply'];
  _zend_objects_store_call_destructors = Module['_zend_objects_store_call_destructors'] = wasmExports['zend_objects_store_call_destructors'];
  _zend_cleanup_internal_class_data = Module['_zend_cleanup_internal_class_data'] = wasmExports['zend_cleanup_internal_class_data'];
  _zend_cleanup_mutable_class_data = Module['_zend_cleanup_mutable_class_data'] = wasmExports['zend_cleanup_mutable_class_data'];
  _zend_stack_clean = Module['_zend_stack_clean'] = wasmExports['zend_stack_clean'];
  _zend_objects_store_free_object_storage = Module['_zend_objects_store_free_object_storage'] = wasmExports['zend_objects_store_free_object_storage'];
  _zend_vm_stack_destroy = Module['_zend_vm_stack_destroy'] = wasmExports['zend_vm_stack_destroy'];
  _zend_objects_store_destroy = Module['_zend_objects_store_destroy'] = wasmExports['zend_objects_store_destroy'];
  _zend_shutdown_fpu = Module['_zend_shutdown_fpu'] = wasmExports['zend_shutdown_fpu'];
  _get_function_arg_name = Module['_get_function_arg_name'] = wasmExports['get_function_arg_name'];
  _zval_update_constant_with_ctx = Module['_zval_update_constant_with_ctx'] = wasmExports['zval_update_constant_with_ctx'];
  _zval_update_constant = Module['_zval_update_constant'] = wasmExports['zval_update_constant'];
  _zend_deprecated_function = Module['_zend_deprecated_function'] = wasmExports['zend_deprecated_function'];
  _zend_handle_undef_args = Module['_zend_handle_undef_args'] = wasmExports['zend_handle_undef_args'];
  _zend_init_func_execute_data = Module['_zend_init_func_execute_data'] = wasmExports['zend_init_func_execute_data'];
  _zend_observer_fcall_begin = Module['_zend_observer_fcall_begin'] = wasmExports['zend_observer_fcall_begin'];
  _zend_observer_fcall_end_prechecked = Module['_zend_observer_fcall_end_prechecked'] = wasmExports['zend_observer_fcall_end_prechecked'];
  _zend_timeout = Module['_zend_timeout'] = wasmExports['zend_timeout'];
  _zend_free_extra_named_params = Module['_zend_free_extra_named_params'] = wasmExports['zend_free_extra_named_params'];
  _zend_hash_index_add_empty_element = Module['_zend_hash_index_add_empty_element'] = wasmExports['zend_hash_index_add_empty_element'];
  _zend_eval_stringl = Module['_zend_eval_stringl'] = wasmExports['zend_eval_stringl'];
  _zend_eval_string = Module['_zend_eval_string'] = wasmExports['zend_eval_string'];
  _zend_eval_stringl_ex = Module['_zend_eval_stringl_ex'] = wasmExports['zend_eval_stringl_ex'];
  _zend_eval_string_ex = Module['_zend_eval_string_ex'] = wasmExports['zend_eval_string_ex'];
  _zend_signal = Module['_zend_signal'] = wasmExports['zend_signal'];
  _zend_delete_global_variable = Module['_zend_delete_global_variable'] = wasmExports['zend_delete_global_variable'];
  _zend_hash_del_ind = Module['_zend_hash_del_ind'] = wasmExports['zend_hash_del_ind'];
  _zend_attach_symbol_table = Module['_zend_attach_symbol_table'] = wasmExports['zend_attach_symbol_table'];
  _zend_detach_symbol_table = Module['_zend_detach_symbol_table'] = wasmExports['zend_detach_symbol_table'];
  _zend_set_local_var = Module['_zend_set_local_var'] = wasmExports['zend_set_local_var'];
  _zend_hash_func = Module['_zend_hash_func'] = wasmExports['zend_hash_func'];
  _zend_vm_stack_init_ex = Module['_zend_vm_stack_init_ex'] = wasmExports['zend_vm_stack_init_ex'];
  _zend_get_compiled_variable_value = Module['_zend_get_compiled_variable_value'] = wasmExports['zend_get_compiled_variable_value'];
  _zend_gcc_global_regs = Module['_zend_gcc_global_regs'] = wasmExports['zend_gcc_global_regs'];
  _zend_cannot_pass_by_reference = Module['_zend_cannot_pass_by_reference'] = wasmExports['zend_cannot_pass_by_reference'];
  _zend_verify_arg_error = Module['_zend_verify_arg_error'] = wasmExports['zend_verify_arg_error'];
  _zend_verify_scalar_type_hint = Module['_zend_verify_scalar_type_hint'] = wasmExports['zend_verify_scalar_type_hint'];
  _zend_readonly_property_indirect_modification_error = Module['_zend_readonly_property_indirect_modification_error'] = wasmExports['zend_readonly_property_indirect_modification_error'];
  _zend_object_released_while_assigning_to_property_error = Module['_zend_object_released_while_assigning_to_property_error'] = wasmExports['zend_object_released_while_assigning_to_property_error'];
  _zend_asymmetric_visibility_property_modification_error = Module['_zend_asymmetric_visibility_property_modification_error'] = wasmExports['zend_asymmetric_visibility_property_modification_error'];
  _zend_check_user_type_slow = Module['_zend_check_user_type_slow'] = wasmExports['zend_check_user_type_slow'];
  _zend_missing_arg_error = Module['_zend_missing_arg_error'] = wasmExports['zend_missing_arg_error'];
  _zend_verify_return_error = Module['_zend_verify_return_error'] = wasmExports['zend_verify_return_error'];
  _zend_verify_never_error = Module['_zend_verify_never_error'] = wasmExports['zend_verify_never_error'];
  _zend_frameless_observed_call = Module['_zend_frameless_observed_call'] = wasmExports['zend_frameless_observed_call'];
  _zend_observer_fcall_begin_prechecked = Module['_zend_observer_fcall_begin_prechecked'] = wasmExports['zend_observer_fcall_begin_prechecked'];
  _zend_wrong_string_offset_error = Module['_zend_wrong_string_offset_error'] = wasmExports['zend_wrong_string_offset_error'];
  _zend_error_unchecked = Module['_zend_error_unchecked'] = wasmExports['zend_error_unchecked'];
  _zend_nodiscard_function = Module['_zend_nodiscard_function'] = wasmExports['zend_nodiscard_function'];
  _zend_use_of_deprecated_trait = Module['_zend_use_of_deprecated_trait'] = wasmExports['zend_use_of_deprecated_trait'];
  _zend_false_to_array_deprecated = Module['_zend_false_to_array_deprecated'] = wasmExports['zend_false_to_array_deprecated'];
  _zend_undefined_offset_write = Module['_zend_undefined_offset_write'] = wasmExports['zend_undefined_offset_write'];
  _zend_undefined_index_write = Module['_zend_undefined_index_write'] = wasmExports['zend_undefined_index_write'];
  __zend_hash_index_find = Module['__zend_hash_index_find'] = wasmExports['_zend_hash_index_find'];
  _zend_verify_ref_array_assignable = Module['_zend_verify_ref_array_assignable'] = wasmExports['zend_verify_ref_array_assignable'];
  _zend_fetch_static_property = Module['_zend_fetch_static_property'] = wasmExports['zend_fetch_static_property'];
  _zend_throw_ref_type_error_type = Module['_zend_throw_ref_type_error_type'] = wasmExports['zend_throw_ref_type_error_type'];
  _zend_throw_ref_type_error_zval = Module['_zend_throw_ref_type_error_zval'] = wasmExports['zend_throw_ref_type_error_zval'];
  _zend_throw_conflicting_coercion_error = Module['_zend_throw_conflicting_coercion_error'] = wasmExports['zend_throw_conflicting_coercion_error'];
  _zend_assign_to_typed_ref_ex = Module['_zend_assign_to_typed_ref_ex'] = wasmExports['zend_assign_to_typed_ref_ex'];
  _zend_verify_prop_assignable_by_ref_ex = Module['_zend_verify_prop_assignable_by_ref_ex'] = wasmExports['zend_verify_prop_assignable_by_ref_ex'];
  _execute_internal = Module['_execute_internal'] = wasmExports['execute_internal'];
  _zend_clean_and_cache_symbol_table = Module['_zend_clean_and_cache_symbol_table'] = wasmExports['zend_clean_and_cache_symbol_table'];
  _zend_symtable_clean = Module['_zend_symtable_clean'] = wasmExports['zend_symtable_clean'];
  _zend_free_compiled_variables = Module['_zend_free_compiled_variables'] = wasmExports['zend_free_compiled_variables'];
  _zend_fcall_interrupt = Module['_zend_fcall_interrupt'] = wasmExports['zend_fcall_interrupt'];
  _zend_init_func_run_time_cache = Module['_zend_init_func_run_time_cache'] = wasmExports['zend_init_func_run_time_cache'];
  _zend_init_code_execute_data = Module['_zend_init_code_execute_data'] = wasmExports['zend_init_code_execute_data'];
  _zend_init_execute_data = Module['_zend_init_execute_data'] = wasmExports['zend_init_execute_data'];
  _zend_unfinished_calls_gc = Module['_zend_unfinished_calls_gc'] = wasmExports['zend_unfinished_calls_gc'];
  _zend_cleanup_unfinished_execution = Module['_zend_cleanup_unfinished_execution'] = wasmExports['zend_cleanup_unfinished_execution'];
  _zend_unfinished_execution_gc = Module['_zend_unfinished_execution_gc'] = wasmExports['zend_unfinished_execution_gc'];
  _zend_unfinished_execution_gc_ex = Module['_zend_unfinished_execution_gc_ex'] = wasmExports['zend_unfinished_execution_gc_ex'];
  _div_function = Module['_div_function'] = wasmExports['div_function'];
  _boolean_xor_function = Module['_boolean_xor_function'] = wasmExports['boolean_xor_function'];
  _zend_asymmetric_property_has_set_access = Module['_zend_asymmetric_property_has_set_access'] = wasmExports['zend_asymmetric_property_has_set_access'];
  _zend_iterator_unwrap = Module['_zend_iterator_unwrap'] = wasmExports['zend_iterator_unwrap'];
  _zend_generator_close = Module['_zend_generator_close'] = wasmExports['zend_generator_close'];
  _compare_function = Module['_compare_function'] = wasmExports['compare_function'];
  _zend_std_unset_static_property = Module['_zend_std_unset_static_property'] = wasmExports['zend_std_unset_static_property'];
  _zend_hash_real_init = Module['_zend_hash_real_init'] = wasmExports['zend_hash_real_init'];
  _zend_get_opcode_handler_func = Module['_zend_get_opcode_handler_func'] = wasmExports['zend_get_opcode_handler_func'];
  _zend_get_halt_op = Module['_zend_get_halt_op'] = wasmExports['zend_get_halt_op'];
  _zend_vm_kind = Module['_zend_vm_kind'] = wasmExports['zend_vm_kind'];
  _zend_vm_call_opcode_handler = Module['_zend_vm_call_opcode_handler'] = wasmExports['zend_vm_call_opcode_handler'];
  _zend_set_user_opcode_handler = Module['_zend_set_user_opcode_handler'] = wasmExports['zend_set_user_opcode_handler'];
  _zend_get_user_opcode_handler = Module['_zend_get_user_opcode_handler'] = wasmExports['zend_get_user_opcode_handler'];
  _sub_function = Module['_sub_function'] = wasmExports['sub_function'];
  _mod_function = Module['_mod_function'] = wasmExports['mod_function'];
  _shift_left_function = Module['_shift_left_function'] = wasmExports['shift_left_function'];
  _shift_right_function = Module['_shift_right_function'] = wasmExports['shift_right_function'];
  _bitwise_or_function = Module['_bitwise_or_function'] = wasmExports['bitwise_or_function'];
  _bitwise_and_function = Module['_bitwise_and_function'] = wasmExports['bitwise_and_function'];
  _bitwise_xor_function = Module['_bitwise_xor_function'] = wasmExports['bitwise_xor_function'];
  _bitwise_not_function = Module['_bitwise_not_function'] = wasmExports['bitwise_not_function'];
  _compile_filename = Module['_compile_filename'] = wasmExports['compile_filename'];
  _zend_llist_apply_with_arguments = Module['_zend_llist_apply_with_arguments'] = wasmExports['zend_llist_apply_with_arguments'];
  _zend_extension_dispatch_message = Module['_zend_extension_dispatch_message'] = wasmExports['zend_extension_dispatch_message'];
  _zend_llist_apply_with_del = Module['_zend_llist_apply_with_del'] = wasmExports['zend_llist_apply_with_del'];
  _zend_append_version_info = Module['_zend_append_version_info'] = wasmExports['zend_append_version_info'];
  _zend_add_system_entropy = Module['_zend_add_system_entropy'] = wasmExports['zend_add_system_entropy'];
  _zend_get_op_array_extension_handle = Module['_zend_get_op_array_extension_handle'] = wasmExports['zend_get_op_array_extension_handle'];
  _zend_get_op_array_extension_handles = Module['_zend_get_op_array_extension_handles'] = wasmExports['zend_get_op_array_extension_handles'];
  _zend_get_internal_function_extension_handle = Module['_zend_get_internal_function_extension_handle'] = wasmExports['zend_get_internal_function_extension_handle'];
  _zend_get_internal_function_extension_handles = Module['_zend_get_internal_function_extension_handles'] = wasmExports['zend_get_internal_function_extension_handles'];
  _zend_reset_internal_run_time_cache = Module['_zend_reset_internal_run_time_cache'] = wasmExports['zend_reset_internal_run_time_cache'];
  _zend_fiber_switch_blocked = Module['_zend_fiber_switch_blocked'] = wasmExports['zend_fiber_switch_blocked'];
  _zend_fiber_init_context = Module['_zend_fiber_init_context'] = wasmExports['zend_fiber_init_context'];
  _zend_get_page_size = Module['_zend_get_page_size'] = wasmExports['zend_get_page_size'];
  _zend_fiber_destroy_context = Module['_zend_fiber_destroy_context'] = wasmExports['zend_fiber_destroy_context'];
  _zend_observer_fiber_destroy_notify = Module['_zend_observer_fiber_destroy_notify'] = wasmExports['zend_observer_fiber_destroy_notify'];
  _zend_fiber_switch_context = Module['_zend_fiber_switch_context'] = wasmExports['zend_fiber_switch_context'];
  _zend_observer_fiber_switch_notify = Module['_zend_observer_fiber_switch_notify'] = wasmExports['zend_observer_fiber_switch_notify'];
  _zend_fiber_start = Module['_zend_fiber_start'] = wasmExports['zend_fiber_start'];
  _zend_fiber_resume = Module['_zend_fiber_resume'] = wasmExports['zend_fiber_resume'];
  _zend_fiber_resume_exception = Module['_zend_fiber_resume_exception'] = wasmExports['zend_fiber_resume_exception'];
  _zend_fiber_suspend = Module['_zend_fiber_suspend'] = wasmExports['zend_fiber_suspend'];
  _zend_ensure_fpu_mode = Module['_zend_ensure_fpu_mode'] = wasmExports['zend_ensure_fpu_mode'];
  _gc_protect = Module['_gc_protect'] = wasmExports['gc_protect'];
  _gc_protected = Module['_gc_protected'] = wasmExports['gc_protected'];
  _zend_gc_collect_cycles = Module['_zend_gc_collect_cycles'] = wasmExports['zend_gc_collect_cycles'];
  ___jit_debug_register_code = Module['___jit_debug_register_code'] = wasmExports['__jit_debug_register_code'];
  _zend_gdb_register_code = Module['_zend_gdb_register_code'] = wasmExports['zend_gdb_register_code'];
  _zend_gdb_unregister_all = Module['_zend_gdb_unregister_all'] = wasmExports['zend_gdb_unregister_all'];
  _zend_gdb_present = Module['_zend_gdb_present'] = wasmExports['zend_gdb_present'];
  _zend_generator_restore_call_stack = Module['_zend_generator_restore_call_stack'] = wasmExports['zend_generator_restore_call_stack'];
  _zend_generator_freeze_call_stack = Module['_zend_generator_freeze_call_stack'] = wasmExports['zend_generator_freeze_call_stack'];
  _zend_generator_resume = Module['_zend_generator_resume'] = wasmExports['zend_generator_resume'];
  _zend_observer_generator_resume = Module['_zend_observer_generator_resume'] = wasmExports['zend_observer_generator_resume'];
  _zend_hash_packed_to_hash = Module['_zend_hash_packed_to_hash'] = wasmExports['zend_hash_packed_to_hash'];
  _zend_hash_get_current_pos_ex = Module['_zend_hash_get_current_pos_ex'] = wasmExports['zend_hash_get_current_pos_ex'];
  _zend_hash_add_or_update = Module['_zend_hash_add_or_update'] = wasmExports['zend_hash_add_or_update'];
  _zend_hash_str_add_or_update = Module['_zend_hash_str_add_or_update'] = wasmExports['zend_hash_str_add_or_update'];
  _zend_hash_index_add_or_update = Module['_zend_hash_index_add_or_update'] = wasmExports['zend_hash_index_add_or_update'];
  _zend_hash_str_del_ind = Module['_zend_hash_str_del_ind'] = wasmExports['zend_hash_str_del_ind'];
  _zend_hash_graceful_destroy = Module['_zend_hash_graceful_destroy'] = wasmExports['zend_hash_graceful_destroy'];
  _zend_hash_apply_with_arguments = Module['_zend_hash_apply_with_arguments'] = wasmExports['zend_hash_apply_with_arguments'];
  _zend_hash_merge_ex = Module['_zend_hash_merge_ex'] = wasmExports['zend_hash_merge_ex'];
  _zend_hash_bucket_renum_swap = Module['_zend_hash_bucket_renum_swap'] = wasmExports['zend_hash_bucket_renum_swap'];
  _zend_hash_bucket_packed_swap = Module['_zend_hash_bucket_packed_swap'] = wasmExports['zend_hash_bucket_packed_swap'];
  _zend_html_putc = Module['_zend_html_putc'] = wasmExports['zend_html_putc'];
  _zend_highlight = Module['_zend_highlight'] = wasmExports['zend_highlight'];
  _zend_perform_covariant_type_check = Module['_zend_perform_covariant_type_check'] = wasmExports['zend_perform_covariant_type_check'];
  _zend_error_at_noreturn = Module['_zend_error_at_noreturn'] = wasmExports['zend_error_at_noreturn'];
  _zend_get_configuration_directive = Module['_zend_get_configuration_directive'] = wasmExports['zend_get_configuration_directive'];
  _zend_stream_fixup = Module['_zend_stream_fixup'] = wasmExports['zend_stream_fixup'];
  _zend_ini_startup = Module['_zend_ini_startup'] = wasmExports['zend_ini_startup'];
  _zend_ini_dtor = Module['_zend_ini_dtor'] = wasmExports['zend_ini_dtor'];
  _zend_ini_global_shutdown = Module['_zend_ini_global_shutdown'] = wasmExports['zend_ini_global_shutdown'];
  _zend_ini_deactivate = Module['_zend_ini_deactivate'] = wasmExports['zend_ini_deactivate'];
  _zend_register_ini_entries = Module['_zend_register_ini_entries'] = wasmExports['zend_register_ini_entries'];
  _zend_unregister_ini_entries = Module['_zend_unregister_ini_entries'] = wasmExports['zend_unregister_ini_entries'];
  _zend_alter_ini_entry_chars_ex = Module['_zend_alter_ini_entry_chars_ex'] = wasmExports['zend_alter_ini_entry_chars_ex'];
  _zend_ini_register_displayer = Module['_zend_ini_register_displayer'] = wasmExports['zend_ini_register_displayer'];
  _zend_ini_parse_uquantity = Module['_zend_ini_parse_uquantity'] = wasmExports['zend_ini_parse_uquantity'];
  _display_link_numbers = Module['_display_link_numbers'] = wasmExports['display_link_numbers'];
  _OnUpdateReal = Module['_OnUpdateReal'] = wasmExports['OnUpdateReal'];
  _zend_user_it_new_iterator = Module['_zend_user_it_new_iterator'] = wasmExports['zend_user_it_new_iterator'];
  _zend_user_it_valid = Module['_zend_user_it_valid'] = wasmExports['zend_user_it_valid'];
  _zend_user_it_get_current_data = Module['_zend_user_it_get_current_data'] = wasmExports['zend_user_it_get_current_data'];
  _zend_user_it_get_current_key = Module['_zend_user_it_get_current_key'] = wasmExports['zend_user_it_get_current_key'];
  _zend_user_it_move_forward = Module['_zend_user_it_move_forward'] = wasmExports['zend_user_it_move_forward'];
  _zend_user_it_rewind = Module['_zend_user_it_rewind'] = wasmExports['zend_user_it_rewind'];
  _zend_user_it_get_gc = Module['_zend_user_it_get_gc'] = wasmExports['zend_user_it_get_gc'];
  _zend_user_it_get_new_iterator = Module['_zend_user_it_get_new_iterator'] = wasmExports['zend_user_it_get_new_iterator'];
  _zend_user_serialize = Module['_zend_user_serialize'] = wasmExports['zend_user_serialize'];
  _zend_user_unserialize = Module['_zend_user_unserialize'] = wasmExports['zend_user_unserialize'];
  _zend_lex_tstring = Module['_zend_lex_tstring'] = wasmExports['zend_lex_tstring'];
  _zend_get_scanned_file_offset = Module['_zend_get_scanned_file_offset'] = wasmExports['zend_get_scanned_file_offset'];
  _zend_ptr_stack_init = Module['_zend_ptr_stack_init'] = wasmExports['zend_ptr_stack_init'];
  _zend_ptr_stack_clean = Module['_zend_ptr_stack_clean'] = wasmExports['zend_ptr_stack_clean'];
  _zend_ptr_stack_destroy = Module['_zend_ptr_stack_destroy'] = wasmExports['zend_ptr_stack_destroy'];
  _zend_multibyte_check_lexer_compatibility = Module['_zend_multibyte_check_lexer_compatibility'] = wasmExports['zend_multibyte_check_lexer_compatibility'];
  _zend_multibyte_get_encoding_name = Module['_zend_multibyte_get_encoding_name'] = wasmExports['zend_multibyte_get_encoding_name'];
  _compile_file = Module['_compile_file'] = wasmExports['compile_file'];
  _compile_string = Module['_compile_string'] = wasmExports['compile_string'];
  _zend_ptr_stack_reverse_apply = Module['_zend_ptr_stack_reverse_apply'] = wasmExports['zend_ptr_stack_reverse_apply'];
  _zend_hex_strtod = Module['_zend_hex_strtod'] = wasmExports['zend_hex_strtod'];
  _zend_oct_strtod = Module['_zend_oct_strtod'] = wasmExports['zend_oct_strtod'];
  _zend_bin_strtod = Module['_zend_bin_strtod'] = wasmExports['zend_bin_strtod'];
  _zend_objects_clone_obj = Module['_zend_objects_clone_obj'] = wasmExports['zend_objects_clone_obj'];
  _zend_list_insert = Module['_zend_list_insert'] = wasmExports['zend_list_insert'];
  _zend_list_free = Module['_zend_list_free'] = wasmExports['zend_list_free'];
  _zend_register_persistent_resource_ex = Module['_zend_register_persistent_resource_ex'] = wasmExports['zend_register_persistent_resource_ex'];
  _zend_llist_prepend_element = Module['_zend_llist_prepend_element'] = wasmExports['zend_llist_prepend_element'];
  _zend_llist_remove_tail = Module['_zend_llist_remove_tail'] = wasmExports['zend_llist_remove_tail'];
  _zend_llist_copy = Module['_zend_llist_copy'] = wasmExports['zend_llist_copy'];
  _zend_llist_sort = Module['_zend_llist_sort'] = wasmExports['zend_llist_sort'];
  _zend_llist_get_last_ex = Module['_zend_llist_get_last_ex'] = wasmExports['zend_llist_get_last_ex'];
  _zend_llist_get_prev_ex = Module['_zend_llist_get_prev_ex'] = wasmExports['zend_llist_get_prev_ex'];
  _zend_multibyte_set_script_encoding_by_string = Module['_zend_multibyte_set_script_encoding_by_string'] = wasmExports['zend_multibyte_set_script_encoding_by_string'];
  _zend_multibyte_parse_encoding_list = Module['_zend_multibyte_parse_encoding_list'] = wasmExports['zend_multibyte_parse_encoding_list'];
  _zend_multibyte_get_script_encoding = Module['_zend_multibyte_get_script_encoding'] = wasmExports['zend_multibyte_get_script_encoding'];
  _zend_multibyte_set_script_encoding = Module['_zend_multibyte_set_script_encoding'] = wasmExports['zend_multibyte_set_script_encoding'];
  _zend_std_get_gc = Module['_zend_std_get_gc'] = wasmExports['zend_std_get_gc'];
  _zend_std_get_debug_info = Module['_zend_std_get_debug_info'] = wasmExports['zend_std_get_debug_info'];
  _zend_get_property_guard = Module['_zend_get_property_guard'] = wasmExports['zend_get_property_guard'];
  _zend_std_get_closure = Module['_zend_std_get_closure'] = wasmExports['zend_std_get_closure'];
  _zend_hooked_object_build_properties = Module['_zend_hooked_object_build_properties'] = wasmExports['zend_hooked_object_build_properties'];
  _zend_objects_clone_obj_with = Module['_zend_objects_clone_obj_with'] = wasmExports['zend_objects_clone_obj_with'];
  _zend_objects_store_put = Module['_zend_objects_store_put'] = wasmExports['zend_objects_store_put'];
  _zend_weakrefs_notify = Module['_zend_weakrefs_notify'] = wasmExports['zend_weakrefs_notify'];
  _zend_observer_fcall_register = Module['_zend_observer_fcall_register'] = wasmExports['zend_observer_fcall_register'];
  _zend_observer_activate = Module['_zend_observer_activate'] = wasmExports['zend_observer_activate'];
  _zend_observer_add_begin_handler = Module['_zend_observer_add_begin_handler'] = wasmExports['zend_observer_add_begin_handler'];
  _zend_observer_remove_begin_handler = Module['_zend_observer_remove_begin_handler'] = wasmExports['zend_observer_remove_begin_handler'];
  _zend_observer_add_end_handler = Module['_zend_observer_add_end_handler'] = wasmExports['zend_observer_add_end_handler'];
  _zend_observer_remove_end_handler = Module['_zend_observer_remove_end_handler'] = wasmExports['zend_observer_remove_end_handler'];
  _zend_observer_function_declared_register = Module['_zend_observer_function_declared_register'] = wasmExports['zend_observer_function_declared_register'];
  _zend_observer_class_linked_register = Module['_zend_observer_class_linked_register'] = wasmExports['zend_observer_class_linked_register'];
  _zend_observer_error_register = Module['_zend_observer_error_register'] = wasmExports['zend_observer_error_register'];
  _zend_observer_fiber_init_register = Module['_zend_observer_fiber_init_register'] = wasmExports['zend_observer_fiber_init_register'];
  _zend_observer_fiber_switch_register = Module['_zend_observer_fiber_switch_register'] = wasmExports['zend_observer_fiber_switch_register'];
  _zend_observer_fiber_destroy_register = Module['_zend_observer_fiber_destroy_register'] = wasmExports['zend_observer_fiber_destroy_register'];
  _zend_observer_fiber_init_notify = Module['_zend_observer_fiber_init_notify'] = wasmExports['zend_observer_fiber_init_notify'];
  _destroy_zend_function = Module['_destroy_zend_function'] = wasmExports['destroy_zend_function'];
  _boolean_not_function = Module['_boolean_not_function'] = wasmExports['boolean_not_function'];
  _is_identical_function = Module['_is_identical_function'] = wasmExports['is_identical_function'];
  _is_not_identical_function = Module['_is_not_identical_function'] = wasmExports['is_not_identical_function'];
  _is_equal_function = Module['_is_equal_function'] = wasmExports['is_equal_function'];
  _is_not_equal_function = Module['_is_not_equal_function'] = wasmExports['is_not_equal_function'];
  _zend_atol = Module['_zend_atol'] = wasmExports['zend_atol'];
  _zend_atoi = Module['_zend_atoi'] = wasmExports['zend_atoi'];
  _convert_scalar_to_number = Module['_convert_scalar_to_number'] = wasmExports['convert_scalar_to_number'];
  _zend_oob_string_to_long_error = Module['_zend_oob_string_to_long_error'] = wasmExports['zend_oob_string_to_long_error'];
  _string_compare_function_ex = Module['_string_compare_function_ex'] = wasmExports['string_compare_function_ex'];
  _zend_compare_arrays = Module['_zend_compare_arrays'] = wasmExports['zend_compare_arrays'];
  _zend_str_toupper_copy = Module['_zend_str_toupper_copy'] = wasmExports['zend_str_toupper_copy'];
  _zend_str_toupper_dup = Module['_zend_str_toupper_dup'] = wasmExports['zend_str_toupper_dup'];
  _zend_str_toupper = Module['_zend_str_toupper'] = wasmExports['zend_str_toupper'];
  _zend_str_toupper_dup_ex = Module['_zend_str_toupper_dup_ex'] = wasmExports['zend_str_toupper_dup_ex'];
  _zend_binary_zval_strcmp = Module['_zend_binary_zval_strcmp'] = wasmExports['zend_binary_zval_strcmp'];
  _zend_binary_zval_strncmp = Module['_zend_binary_zval_strncmp'] = wasmExports['zend_binary_zval_strncmp'];
  _zend_compare_objects = Module['_zend_compare_objects'] = wasmExports['zend_compare_objects'];
  _zend_ulong_to_str = Module['_zend_ulong_to_str'] = wasmExports['zend_ulong_to_str'];
  _zend_u64_to_str = Module['_zend_u64_to_str'] = wasmExports['zend_u64_to_str'];
  _zend_i64_to_str = Module['_zend_i64_to_str'] = wasmExports['zend_i64_to_str'];
  _zend_ptr_stack_init_ex = Module['_zend_ptr_stack_init_ex'] = wasmExports['zend_ptr_stack_init_ex'];
  _zend_ptr_stack_n_push = Module['_zend_ptr_stack_n_push'] = wasmExports['zend_ptr_stack_n_push'];
  _zend_ptr_stack_n_pop = Module['_zend_ptr_stack_n_pop'] = wasmExports['zend_ptr_stack_n_pop'];
  _zend_ptr_stack_apply = Module['_zend_ptr_stack_apply'] = wasmExports['zend_ptr_stack_apply'];
  _zend_ptr_stack_num_elements = Module['_zend_ptr_stack_num_elements'] = wasmExports['zend_ptr_stack_num_elements'];
  _zend_signal_startup = Module['_zend_signal_startup'] = wasmExports['zend_signal_startup'];
  _smart_str_realloc = Module['_smart_str_realloc'] = wasmExports['smart_str_realloc'];
  __smart_string_alloc_persistent = Module['__smart_string_alloc_persistent'] = wasmExports['_smart_string_alloc_persistent'];
  _smart_str_append_escaped_truncated = Module['_smart_str_append_escaped_truncated'] = wasmExports['smart_str_append_escaped_truncated'];
  _smart_str_append_scalar = Module['_smart_str_append_scalar'] = wasmExports['smart_str_append_scalar'];
  _zend_insert_sort = Module['_zend_insert_sort'] = wasmExports['zend_insert_sort'];
  _zend_stack_apply = Module['_zend_stack_apply'] = wasmExports['zend_stack_apply'];
  _zend_interned_strings_init = Module['_zend_interned_strings_init'] = wasmExports['zend_interned_strings_init'];
  _zend_interned_string_find_permanent = Module['_zend_interned_string_find_permanent'] = wasmExports['zend_interned_string_find_permanent'];
  _zend_shutdown_strtod = Module['_zend_shutdown_strtod'] = wasmExports['zend_shutdown_strtod'];
  _virtual_cwd_startup = Module['_virtual_cwd_startup'] = wasmExports['virtual_cwd_startup'];
  _virtual_cwd_shutdown = Module['_virtual_cwd_shutdown'] = wasmExports['virtual_cwd_shutdown'];
  _virtual_getcwd_ex = Module['_virtual_getcwd_ex'] = wasmExports['virtual_getcwd_ex'];
  _virtual_getcwd = Module['_virtual_getcwd'] = wasmExports['virtual_getcwd'];
  _realpath_cache_lookup = Module['_realpath_cache_lookup'] = wasmExports['realpath_cache_lookup'];
  _virtual_chdir = Module['_virtual_chdir'] = wasmExports['virtual_chdir'];
  _virtual_realpath = Module['_virtual_realpath'] = wasmExports['virtual_realpath'];
  _virtual_filepath_ex = Module['_virtual_filepath_ex'] = wasmExports['virtual_filepath_ex'];
  _virtual_filepath = Module['_virtual_filepath'] = wasmExports['virtual_filepath'];
  _virtual_fopen = Module['_virtual_fopen'] = wasmExports['virtual_fopen'];
  _virtual_access = Module['_virtual_access'] = wasmExports['virtual_access'];
  _virtual_utime = Module['_virtual_utime'] = wasmExports['virtual_utime'];
  _virtual_chmod = Module['_virtual_chmod'] = wasmExports['virtual_chmod'];
  _virtual_chown = Module['_virtual_chown'] = wasmExports['virtual_chown'];
  _virtual_open = Module['_virtual_open'] = wasmExports['virtual_open'];
  _virtual_creat = Module['_virtual_creat'] = wasmExports['virtual_creat'];
  _virtual_rename = Module['_virtual_rename'] = wasmExports['virtual_rename'];
  _virtual_stat = Module['_virtual_stat'] = wasmExports['virtual_stat'];
  _virtual_lstat = Module['_virtual_lstat'] = wasmExports['virtual_lstat'];
  _virtual_unlink = Module['_virtual_unlink'] = wasmExports['virtual_unlink'];
  _virtual_mkdir = Module['_virtual_mkdir'] = wasmExports['virtual_mkdir'];
  _virtual_rmdir = Module['_virtual_rmdir'] = wasmExports['virtual_rmdir'];
  _virtual_opendir = Module['_virtual_opendir'] = wasmExports['virtual_opendir'];
  _virtual_popen = Module['_virtual_popen'] = wasmExports['virtual_popen'];
  _zend_get_opcode_id = Module['_zend_get_opcode_id'] = wasmExports['zend_get_opcode_id'];
  _zend_weakrefs_hash_add = Module['_zend_weakrefs_hash_add'] = wasmExports['zend_weakrefs_hash_add'];
  _zend_weakrefs_hash_del = Module['_zend_weakrefs_hash_del'] = wasmExports['zend_weakrefs_hash_del'];
  _zend_weakrefs_hash_clean = Module['_zend_weakrefs_hash_clean'] = wasmExports['zend_weakrefs_hash_clean'];
  _zend_spprintf_unchecked = Module['_zend_spprintf_unchecked'] = wasmExports['zend_spprintf_unchecked'];
  _zend_make_printable_zval = Module['_zend_make_printable_zval'] = wasmExports['zend_make_printable_zval'];
  _zend_print_zval = Module['_zend_print_zval'] = wasmExports['zend_print_zval'];
  _zend_print_flat_zval_r = Module['_zend_print_flat_zval_r'] = wasmExports['zend_print_flat_zval_r'];
  _zend_output_debug_string = Module['_zend_output_debug_string'] = wasmExports['zend_output_debug_string'];
  _zend_strerror_noreturn = Module['_zend_strerror_noreturn'] = wasmExports['zend_strerror_noreturn'];
  _php_cli_get_shell_callbacks = Module['_php_cli_get_shell_callbacks'] = wasmExports['php_cli_get_shell_callbacks'];
  _sapi_cli_single_write = Module['_sapi_cli_single_write'] = wasmExports['sapi_cli_single_write'];
  _main = Module['_main'] = wasmExports['__main_argc_argv'];
  _libiconv_open_into = Module['_libiconv_open_into'] = wasmExports['libiconv_open_into'];
  _libiconvctl = Module['_libiconvctl'] = wasmExports['libiconvctl'];
  _libiconvlist = Module['_libiconvlist'] = wasmExports['libiconvlist'];
  _iconv_canonicalize = Module['_iconv_canonicalize'] = wasmExports['iconv_canonicalize'];
  __emscripten_memcpy_bulkmem = Module['__emscripten_memcpy_bulkmem'] = wasmExports['_emscripten_memcpy_bulkmem'];
  _emscripten_stack_get_end = Module['_emscripten_stack_get_end'] = wasmExports['emscripten_stack_get_end'];
  _emscripten_stack_get_base = Module['_emscripten_stack_get_base'] = wasmExports['emscripten_stack_get_base'];
  _emscripten_builtin_memalign = wasmExports['emscripten_builtin_memalign'];
  __emscripten_timeout = wasmExports['_emscripten_timeout'];
  _setThrew = wasmExports['setThrew'];
  __emscripten_tempret_set = wasmExports['_emscripten_tempret_set'];
  __emscripten_tempret_get = wasmExports['_emscripten_tempret_get'];
  ___get_temp_ret = Module['___get_temp_ret'] = wasmExports['__get_temp_ret'];
  ___set_temp_ret = Module['___set_temp_ret'] = wasmExports['__set_temp_ret'];
  _emscripten_stack_init = Module['_emscripten_stack_init'] = wasmExports['emscripten_stack_init'];
  _emscripten_stack_set_limits = Module['_emscripten_stack_set_limits'] = wasmExports['emscripten_stack_set_limits'];
  _emscripten_stack_get_free = Module['_emscripten_stack_get_free'] = wasmExports['emscripten_stack_get_free'];
  __emscripten_stack_restore = wasmExports['_emscripten_stack_restore'];
  __emscripten_stack_alloc = wasmExports['_emscripten_stack_alloc'];
  _emscripten_stack_get_current = wasmExports['emscripten_stack_get_current'];
  memory = wasmMemory = wasmExports['memory'];
  ___stack_pointer = Module['___stack_pointer'] = wasmExports['__stack_pointer'];
  _compiler_globals = Module['_compiler_globals'] = wasmExports['compiler_globals'].value;
  _zend_known_strings = Module['_zend_known_strings'] = wasmExports['zend_known_strings'].value;
  _zend_string_init_interned = Module['_zend_string_init_interned'] = wasmExports['zend_string_init_interned'].value;
  __indirect_function_table = wasmTable = wasmExports['__indirect_function_table'];
  _std_object_handlers = Module['_std_object_handlers'] = wasmExports['std_object_handlers'].value;
  _zend_ce_aggregate = Module['_zend_ce_aggregate'] = wasmExports['zend_ce_aggregate'].value;
  _zend_ce_error = Module['_zend_ce_error'] = wasmExports['zend_ce_error'].value;
  _zend_ce_exception = Module['_zend_ce_exception'] = wasmExports['zend_ce_exception'].value;
  _zend_empty_string = Module['_zend_empty_string'] = wasmExports['zend_empty_string'].value;
  _executor_globals = Module['_executor_globals'] = wasmExports['executor_globals'].value;
  _basic_globals = Module['_basic_globals'] = wasmExports['basic_globals'].value;
  _pcre_globals = Module['_pcre_globals'] = wasmExports['pcre_globals'].value;
  _zend_one_char_string = Module['_zend_one_char_string'] = wasmExports['zend_one_char_string'].value;
  _file_globals = Module['_file_globals'] = wasmExports['file_globals'].value;
  _core_globals = Module['_core_globals'] = wasmExports['core_globals'].value;
  _php_hashcontext_ce = Module['_php_hashcontext_ce'] = wasmExports['php_hashcontext_ce'].value;
  _zend_ce_value_error = Module['_zend_ce_value_error'] = wasmExports['zend_ce_value_error'].value;
  __libiconv_version = Module['__libiconv_version'] = wasmExports['_libiconv_version'].value;
  _sapi_globals = Module['_sapi_globals'] = wasmExports['sapi_globals'].value;
  _php_json_serializable_ce = Module['_php_json_serializable_ce'] = wasmExports['php_json_serializable_ce'].value;
  _zend_empty_array = Module['_zend_empty_array'] = wasmExports['zend_empty_array'].value;
  _php_json_exception_ce = Module['_php_json_exception_ce'] = wasmExports['php_json_exception_ce'].value;
  _json_globals = Module['_json_globals'] = wasmExports['json_globals'].value;
  _lexbor_hash_insert_raw = Module['_lexbor_hash_insert_raw'] = wasmExports['lexbor_hash_insert_raw'].value;
  _lexbor_hash_insert_lower = Module['_lexbor_hash_insert_lower'] = wasmExports['lexbor_hash_insert_lower'].value;
  _lexbor_hash_insert_upper = Module['_lexbor_hash_insert_upper'] = wasmExports['lexbor_hash_insert_upper'].value;
  _lexbor_hash_search_raw = Module['_lexbor_hash_search_raw'] = wasmExports['lexbor_hash_search_raw'].value;
  _lexbor_hash_search_lower = Module['_lexbor_hash_search_lower'] = wasmExports['lexbor_hash_search_lower'].value;
  _lexbor_hash_search_upper = Module['_lexbor_hash_search_upper'] = wasmExports['lexbor_hash_search_upper'].value;
  _lxb_encoding_multi_big5_map = Module['_lxb_encoding_multi_big5_map'] = wasmExports['lxb_encoding_multi_big5_map'].value;
  _lxb_encoding_multi_jis0208_map = Module['_lxb_encoding_multi_jis0208_map'] = wasmExports['lxb_encoding_multi_jis0208_map'].value;
  _lxb_encoding_multi_jis0212_map = Module['_lxb_encoding_multi_jis0212_map'] = wasmExports['lxb_encoding_multi_jis0212_map'].value;
  _lxb_encoding_multi_euc_kr_map = Module['_lxb_encoding_multi_euc_kr_map'] = wasmExports['lxb_encoding_multi_euc_kr_map'].value;
  _lxb_encoding_multi_gb18030_map = Module['_lxb_encoding_multi_gb18030_map'] = wasmExports['lxb_encoding_multi_gb18030_map'].value;
  _lxb_encoding_range_index_gb18030 = Module['_lxb_encoding_range_index_gb18030'] = wasmExports['lxb_encoding_range_index_gb18030'].value;
  _lxb_encoding_single_index_ibm866 = Module['_lxb_encoding_single_index_ibm866'] = wasmExports['lxb_encoding_single_index_ibm866'].value;
  _lxb_encoding_single_index_iso_8859_10 = Module['_lxb_encoding_single_index_iso_8859_10'] = wasmExports['lxb_encoding_single_index_iso_8859_10'].value;
  _lxb_encoding_single_index_iso_8859_13 = Module['_lxb_encoding_single_index_iso_8859_13'] = wasmExports['lxb_encoding_single_index_iso_8859_13'].value;
  _lxb_encoding_single_index_iso_8859_14 = Module['_lxb_encoding_single_index_iso_8859_14'] = wasmExports['lxb_encoding_single_index_iso_8859_14'].value;
  _lxb_encoding_single_index_iso_8859_15 = Module['_lxb_encoding_single_index_iso_8859_15'] = wasmExports['lxb_encoding_single_index_iso_8859_15'].value;
  _lxb_encoding_single_index_iso_8859_16 = Module['_lxb_encoding_single_index_iso_8859_16'] = wasmExports['lxb_encoding_single_index_iso_8859_16'].value;
  _lxb_encoding_single_index_iso_8859_2 = Module['_lxb_encoding_single_index_iso_8859_2'] = wasmExports['lxb_encoding_single_index_iso_8859_2'].value;
  _lxb_encoding_single_index_iso_8859_3 = Module['_lxb_encoding_single_index_iso_8859_3'] = wasmExports['lxb_encoding_single_index_iso_8859_3'].value;
  _lxb_encoding_single_index_iso_8859_4 = Module['_lxb_encoding_single_index_iso_8859_4'] = wasmExports['lxb_encoding_single_index_iso_8859_4'].value;
  _lxb_encoding_single_index_iso_8859_5 = Module['_lxb_encoding_single_index_iso_8859_5'] = wasmExports['lxb_encoding_single_index_iso_8859_5'].value;
  _lxb_encoding_single_index_iso_8859_6 = Module['_lxb_encoding_single_index_iso_8859_6'] = wasmExports['lxb_encoding_single_index_iso_8859_6'].value;
  _lxb_encoding_single_index_iso_8859_7 = Module['_lxb_encoding_single_index_iso_8859_7'] = wasmExports['lxb_encoding_single_index_iso_8859_7'].value;
  _lxb_encoding_single_index_iso_8859_8 = Module['_lxb_encoding_single_index_iso_8859_8'] = wasmExports['lxb_encoding_single_index_iso_8859_8'].value;
  _lxb_encoding_single_index_koi8_r = Module['_lxb_encoding_single_index_koi8_r'] = wasmExports['lxb_encoding_single_index_koi8_r'].value;
  _lxb_encoding_single_index_koi8_u = Module['_lxb_encoding_single_index_koi8_u'] = wasmExports['lxb_encoding_single_index_koi8_u'].value;
  _lxb_encoding_single_index_macintosh = Module['_lxb_encoding_single_index_macintosh'] = wasmExports['lxb_encoding_single_index_macintosh'].value;
  _lxb_encoding_single_index_windows_1250 = Module['_lxb_encoding_single_index_windows_1250'] = wasmExports['lxb_encoding_single_index_windows_1250'].value;
  _lxb_encoding_single_index_windows_1251 = Module['_lxb_encoding_single_index_windows_1251'] = wasmExports['lxb_encoding_single_index_windows_1251'].value;
  _lxb_encoding_single_index_windows_1252 = Module['_lxb_encoding_single_index_windows_1252'] = wasmExports['lxb_encoding_single_index_windows_1252'].value;
  _lxb_encoding_single_index_windows_1253 = Module['_lxb_encoding_single_index_windows_1253'] = wasmExports['lxb_encoding_single_index_windows_1253'].value;
  _lxb_encoding_single_index_windows_1254 = Module['_lxb_encoding_single_index_windows_1254'] = wasmExports['lxb_encoding_single_index_windows_1254'].value;
  _lxb_encoding_single_index_windows_1255 = Module['_lxb_encoding_single_index_windows_1255'] = wasmExports['lxb_encoding_single_index_windows_1255'].value;
  _lxb_encoding_single_index_windows_1256 = Module['_lxb_encoding_single_index_windows_1256'] = wasmExports['lxb_encoding_single_index_windows_1256'].value;
  _lxb_encoding_single_index_windows_1257 = Module['_lxb_encoding_single_index_windows_1257'] = wasmExports['lxb_encoding_single_index_windows_1257'].value;
  _lxb_encoding_single_index_windows_1258 = Module['_lxb_encoding_single_index_windows_1258'] = wasmExports['lxb_encoding_single_index_windows_1258'].value;
  _lxb_encoding_single_index_windows_874 = Module['_lxb_encoding_single_index_windows_874'] = wasmExports['lxb_encoding_single_index_windows_874'].value;
  _lxb_encoding_single_index_x_mac_cyrillic = Module['_lxb_encoding_single_index_x_mac_cyrillic'] = wasmExports['lxb_encoding_single_index_x_mac_cyrillic'].value;
  _lxb_encoding_multi_big5_167_1106_map = Module['_lxb_encoding_multi_big5_167_1106_map'] = wasmExports['lxb_encoding_multi_big5_167_1106_map'].value;
  _lxb_encoding_multi_big5_8211_40882_map = Module['_lxb_encoding_multi_big5_8211_40882_map'] = wasmExports['lxb_encoding_multi_big5_8211_40882_map'].value;
  _lxb_encoding_multi_big5_64012_65518_map = Module['_lxb_encoding_multi_big5_64012_65518_map'] = wasmExports['lxb_encoding_multi_big5_64012_65518_map'].value;
  _lxb_encoding_multi_big5_131210_172369_map = Module['_lxb_encoding_multi_big5_131210_172369_map'] = wasmExports['lxb_encoding_multi_big5_131210_172369_map'].value;
  _lxb_encoding_multi_big5_194708_194727_map = Module['_lxb_encoding_multi_big5_194708_194727_map'] = wasmExports['lxb_encoding_multi_big5_194708_194727_map'].value;
  _lxb_encoding_multi_jis0208_167_1106_map = Module['_lxb_encoding_multi_jis0208_167_1106_map'] = wasmExports['lxb_encoding_multi_jis0208_167_1106_map'].value;
  _lxb_encoding_multi_jis0208_8208_13262_map = Module['_lxb_encoding_multi_jis0208_8208_13262_map'] = wasmExports['lxb_encoding_multi_jis0208_8208_13262_map'].value;
  _lxb_encoding_multi_jis0208_19968_40865_map = Module['_lxb_encoding_multi_jis0208_19968_40865_map'] = wasmExports['lxb_encoding_multi_jis0208_19968_40865_map'].value;
  _lxb_encoding_multi_jis0208_63785_65510_map = Module['_lxb_encoding_multi_jis0208_63785_65510_map'] = wasmExports['lxb_encoding_multi_jis0208_63785_65510_map'].value;
  _lxb_encoding_multi_euc_kr_161_1106_map = Module['_lxb_encoding_multi_euc_kr_161_1106_map'] = wasmExports['lxb_encoding_multi_euc_kr_161_1106_map'].value;
  _lxb_encoding_multi_euc_kr_8213_13278_map = Module['_lxb_encoding_multi_euc_kr_8213_13278_map'] = wasmExports['lxb_encoding_multi_euc_kr_8213_13278_map'].value;
  _lxb_encoding_multi_euc_kr_19968_55204_map = Module['_lxb_encoding_multi_euc_kr_19968_55204_map'] = wasmExports['lxb_encoding_multi_euc_kr_19968_55204_map'].value;
  _lxb_encoding_multi_euc_kr_63744_65511_map = Module['_lxb_encoding_multi_euc_kr_63744_65511_map'] = wasmExports['lxb_encoding_multi_euc_kr_63744_65511_map'].value;
  _lxb_encoding_multi_gb18030_164_1106_map = Module['_lxb_encoding_multi_gb18030_164_1106_map'] = wasmExports['lxb_encoding_multi_gb18030_164_1106_map'].value;
  _lxb_encoding_multi_gb18030_7743_40892_map = Module['_lxb_encoding_multi_gb18030_7743_40892_map'] = wasmExports['lxb_encoding_multi_gb18030_7743_40892_map'].value;
  _lxb_encoding_multi_gb18030_57344_65510_map = Module['_lxb_encoding_multi_gb18030_57344_65510_map'] = wasmExports['lxb_encoding_multi_gb18030_57344_65510_map'].value;
  _lxb_encoding_single_hash_ibm866 = Module['_lxb_encoding_single_hash_ibm866'] = wasmExports['lxb_encoding_single_hash_ibm866'].value;
  _lxb_encoding_multi_iso_2022_jp_katakana_map = Module['_lxb_encoding_multi_iso_2022_jp_katakana_map'] = wasmExports['lxb_encoding_multi_iso_2022_jp_katakana_map'].value;
  _lxb_encoding_single_hash_iso_8859_10 = Module['_lxb_encoding_single_hash_iso_8859_10'] = wasmExports['lxb_encoding_single_hash_iso_8859_10'].value;
  _lxb_encoding_single_hash_iso_8859_13 = Module['_lxb_encoding_single_hash_iso_8859_13'] = wasmExports['lxb_encoding_single_hash_iso_8859_13'].value;
  _lxb_encoding_single_hash_iso_8859_14 = Module['_lxb_encoding_single_hash_iso_8859_14'] = wasmExports['lxb_encoding_single_hash_iso_8859_14'].value;
  _lxb_encoding_single_hash_iso_8859_15 = Module['_lxb_encoding_single_hash_iso_8859_15'] = wasmExports['lxb_encoding_single_hash_iso_8859_15'].value;
  _lxb_encoding_single_hash_iso_8859_16 = Module['_lxb_encoding_single_hash_iso_8859_16'] = wasmExports['lxb_encoding_single_hash_iso_8859_16'].value;
  _lxb_encoding_single_hash_iso_8859_2 = Module['_lxb_encoding_single_hash_iso_8859_2'] = wasmExports['lxb_encoding_single_hash_iso_8859_2'].value;
  _lxb_encoding_single_hash_iso_8859_3 = Module['_lxb_encoding_single_hash_iso_8859_3'] = wasmExports['lxb_encoding_single_hash_iso_8859_3'].value;
  _lxb_encoding_single_hash_iso_8859_4 = Module['_lxb_encoding_single_hash_iso_8859_4'] = wasmExports['lxb_encoding_single_hash_iso_8859_4'].value;
  _lxb_encoding_single_hash_iso_8859_5 = Module['_lxb_encoding_single_hash_iso_8859_5'] = wasmExports['lxb_encoding_single_hash_iso_8859_5'].value;
  _lxb_encoding_single_hash_iso_8859_6 = Module['_lxb_encoding_single_hash_iso_8859_6'] = wasmExports['lxb_encoding_single_hash_iso_8859_6'].value;
  _lxb_encoding_single_hash_iso_8859_7 = Module['_lxb_encoding_single_hash_iso_8859_7'] = wasmExports['lxb_encoding_single_hash_iso_8859_7'].value;
  _lxb_encoding_single_hash_iso_8859_8 = Module['_lxb_encoding_single_hash_iso_8859_8'] = wasmExports['lxb_encoding_single_hash_iso_8859_8'].value;
  _lxb_encoding_single_hash_koi8_r = Module['_lxb_encoding_single_hash_koi8_r'] = wasmExports['lxb_encoding_single_hash_koi8_r'].value;
  _lxb_encoding_single_hash_koi8_u = Module['_lxb_encoding_single_hash_koi8_u'] = wasmExports['lxb_encoding_single_hash_koi8_u'].value;
  _lxb_encoding_single_hash_macintosh = Module['_lxb_encoding_single_hash_macintosh'] = wasmExports['lxb_encoding_single_hash_macintosh'].value;
  _lxb_encoding_single_hash_windows_1250 = Module['_lxb_encoding_single_hash_windows_1250'] = wasmExports['lxb_encoding_single_hash_windows_1250'].value;
  _lxb_encoding_single_hash_windows_1251 = Module['_lxb_encoding_single_hash_windows_1251'] = wasmExports['lxb_encoding_single_hash_windows_1251'].value;
  _lxb_encoding_single_hash_windows_1252 = Module['_lxb_encoding_single_hash_windows_1252'] = wasmExports['lxb_encoding_single_hash_windows_1252'].value;
  _lxb_encoding_single_hash_windows_1253 = Module['_lxb_encoding_single_hash_windows_1253'] = wasmExports['lxb_encoding_single_hash_windows_1253'].value;
  _lxb_encoding_single_hash_windows_1254 = Module['_lxb_encoding_single_hash_windows_1254'] = wasmExports['lxb_encoding_single_hash_windows_1254'].value;
  _lxb_encoding_single_hash_windows_1255 = Module['_lxb_encoding_single_hash_windows_1255'] = wasmExports['lxb_encoding_single_hash_windows_1255'].value;
  _lxb_encoding_single_hash_windows_1256 = Module['_lxb_encoding_single_hash_windows_1256'] = wasmExports['lxb_encoding_single_hash_windows_1256'].value;
  _lxb_encoding_single_hash_windows_1257 = Module['_lxb_encoding_single_hash_windows_1257'] = wasmExports['lxb_encoding_single_hash_windows_1257'].value;
  _lxb_encoding_single_hash_windows_1258 = Module['_lxb_encoding_single_hash_windows_1258'] = wasmExports['lxb_encoding_single_hash_windows_1258'].value;
  _lxb_encoding_single_hash_windows_874 = Module['_lxb_encoding_single_hash_windows_874'] = wasmExports['lxb_encoding_single_hash_windows_874'].value;
  _lxb_encoding_single_hash_x_mac_cyrillic = Module['_lxb_encoding_single_hash_x_mac_cyrillic'] = wasmExports['lxb_encoding_single_hash_x_mac_cyrillic'].value;
  _lxb_encoding_res_shs_entities = Module['_lxb_encoding_res_shs_entities'] = wasmExports['lxb_encoding_res_shs_entities'].value;
  _lxb_encoding_res_map = Module['_lxb_encoding_res_map'] = wasmExports['lxb_encoding_res_map'].value;
  _lxb_encoding_multi_iso_2022_jp_katakana_12289_12541_map = Module['_lxb_encoding_multi_iso_2022_jp_katakana_12289_12541_map'] = wasmExports['lxb_encoding_multi_iso_2022_jp_katakana_12289_12541_map'].value;
  _lxb_encoding_multi_jis0212_161_1120_map = Module['_lxb_encoding_multi_jis0212_161_1120_map'] = wasmExports['lxb_encoding_multi_jis0212_161_1120_map'].value;
  _lxb_encoding_multi_jis0212_8470_8483_map = Module['_lxb_encoding_multi_jis0212_8470_8483_map'] = wasmExports['lxb_encoding_multi_jis0212_8470_8483_map'].value;
  _lxb_encoding_multi_jis0212_19970_40870_map = Module['_lxb_encoding_multi_jis0212_19970_40870_map'] = wasmExports['lxb_encoding_multi_jis0212_19970_40870_map'].value;
  _lxb_encoding_multi_jis0212_65374_65375_map = Module['_lxb_encoding_multi_jis0212_65374_65375_map'] = wasmExports['lxb_encoding_multi_jis0212_65374_65375_map'].value;
  _php_internal_encoding_changed = Module['_php_internal_encoding_changed'] = wasmExports['php_internal_encoding_changed'].value;
  _mbfl_encoding_pass = Module['_mbfl_encoding_pass'] = wasmExports['mbfl_encoding_pass'].value;
  _sapi_module = Module['_sapi_module'] = wasmExports['sapi_module'].value;
  _vtbl_pass = Module['_vtbl_pass'] = wasmExports['vtbl_pass'].value;
  _module_registry = Module['_module_registry'] = wasmExports['module_registry'].value;
  _smm_shared_globals = Module['_smm_shared_globals'] = wasmExports['smm_shared_globals'].value;
  _zend_ce_closure = Module['_zend_ce_closure'] = wasmExports['zend_ce_closure'].value;
  _zend_resolve_path = Module['_zend_resolve_path'] = wasmExports['zend_resolve_path'].value;
  _zend_observer_function_declared_observed = Module['_zend_observer_function_declared_observed'] = wasmExports['zend_observer_function_declared_observed'].value;
  _zend_observer_class_linked_observed = Module['_zend_observer_class_linked_observed'] = wasmExports['zend_observer_class_linked_observed'].value;
  _zend_system_id = Module['_zend_system_id'] = wasmExports['zend_system_id'].value;
  _zend_enum_object_handlers = Module['_zend_enum_object_handlers'] = wasmExports['zend_enum_object_handlers'].value;
  _zend_ce_iterator = Module['_zend_ce_iterator'] = wasmExports['zend_ce_iterator'].value;
  _zend_map_ptr_static_last = Module['_zend_map_ptr_static_last'] = wasmExports['zend_map_ptr_static_last'].value;
  _zend_accel_schedule_restart_hook = Module['_zend_accel_schedule_restart_hook'] = wasmExports['zend_accel_schedule_restart_hook'].value;
  _zend_signal_globals = Module['_zend_signal_globals'] = wasmExports['zend_signal_globals'].value;
  _zend_post_shutdown_cb = Module['_zend_post_shutdown_cb'] = wasmExports['zend_post_shutdown_cb'].value;
  _zend_compile_file = Module['_zend_compile_file'] = wasmExports['zend_compile_file'].value;
  _zend_inheritance_cache_get = Module['_zend_inheritance_cache_get'] = wasmExports['zend_inheritance_cache_get'].value;
  _zend_inheritance_cache_add = Module['_zend_inheritance_cache_add'] = wasmExports['zend_inheritance_cache_add'].value;
  _zend_extensions = Module['_zend_extensions'] = wasmExports['zend_extensions'].value;
  _zend_post_startup_cb = Module['_zend_post_startup_cb'] = wasmExports['zend_post_startup_cb'].value;
  _zend_stream_open_function = Module['_zend_stream_open_function'] = wasmExports['zend_stream_open_function'].value;
  _zend_map_ptr_static_size = Module['_zend_map_ptr_static_size'] = wasmExports['zend_map_ptr_static_size'].value;
  _zend_observer_fcall_op_array_extension = Module['_zend_observer_fcall_op_array_extension'] = wasmExports['zend_observer_fcall_op_array_extension'].value;
  _zend_error_cb = Module['_zend_error_cb'] = wasmExports['zend_error_cb'].value;
  _zend_interrupt_function = Module['_zend_interrupt_function'] = wasmExports['zend_interrupt_function'].value;
  _random_ce_Random_RandomException = Module['_random_ce_Random_RandomException'] = wasmExports['random_ce_Random_RandomException'].value;
  _php_random_algo_mt19937 = Module['_php_random_algo_mt19937'] = wasmExports['php_random_algo_mt19937'].value;
  _php_random_algo_pcgoneseq128xslrr64 = Module['_php_random_algo_pcgoneseq128xslrr64'] = wasmExports['php_random_algo_pcgoneseq128xslrr64'].value;
  _php_random_algo_secure = Module['_php_random_algo_secure'] = wasmExports['php_random_algo_secure'].value;
  _random_ce_Random_BrokenRandomEngineError = Module['_random_ce_Random_BrokenRandomEngineError'] = wasmExports['random_ce_Random_BrokenRandomEngineError'].value;
  _php_random_algo_user = Module['_php_random_algo_user'] = wasmExports['php_random_algo_user'].value;
  _php_random_algo_xoshiro256starstar = Module['_php_random_algo_xoshiro256starstar'] = wasmExports['php_random_algo_xoshiro256starstar'].value;
  _random_globals = Module['_random_globals'] = wasmExports['random_globals'].value;
  _random_ce_Random_Engine = Module['_random_ce_Random_Engine'] = wasmExports['random_ce_Random_Engine'].value;
  _random_ce_Random_CryptoSafeEngine = Module['_random_ce_Random_CryptoSafeEngine'] = wasmExports['random_ce_Random_CryptoSafeEngine'].value;
  _random_ce_Random_RandomError = Module['_random_ce_Random_RandomError'] = wasmExports['random_ce_Random_RandomError'].value;
  _random_ce_Random_Engine_Mt19937 = Module['_random_ce_Random_Engine_Mt19937'] = wasmExports['random_ce_Random_Engine_Mt19937'].value;
  _random_ce_Random_Engine_PcgOneseq128XslRr64 = Module['_random_ce_Random_Engine_PcgOneseq128XslRr64'] = wasmExports['random_ce_Random_Engine_PcgOneseq128XslRr64'].value;
  _random_ce_Random_Engine_Xoshiro256StarStar = Module['_random_ce_Random_Engine_Xoshiro256StarStar'] = wasmExports['random_ce_Random_Engine_Xoshiro256StarStar'].value;
  _random_ce_Random_Engine_Secure = Module['_random_ce_Random_Engine_Secure'] = wasmExports['random_ce_Random_Engine_Secure'].value;
  _random_ce_Random_Randomizer = Module['_random_ce_Random_Randomizer'] = wasmExports['random_ce_Random_Randomizer'].value;
  _random_ce_Random_IntervalBoundary = Module['_random_ce_Random_IntervalBoundary'] = wasmExports['random_ce_Random_IntervalBoundary'].value;
  _reflection_enum_ptr = Module['_reflection_enum_ptr'] = wasmExports['reflection_enum_ptr'].value;
  _reflection_class_ptr = Module['_reflection_class_ptr'] = wasmExports['reflection_class_ptr'].value;
  _reflection_exception_ptr = Module['_reflection_exception_ptr'] = wasmExports['reflection_exception_ptr'].value;
  _reflection_attribute_ptr = Module['_reflection_attribute_ptr'] = wasmExports['reflection_attribute_ptr'].value;
  _reflection_parameter_ptr = Module['_reflection_parameter_ptr'] = wasmExports['reflection_parameter_ptr'].value;
  _reflection_extension_ptr = Module['_reflection_extension_ptr'] = wasmExports['reflection_extension_ptr'].value;
  _zend_ce_generator = Module['_zend_ce_generator'] = wasmExports['zend_ce_generator'].value;
  _reflection_function_ptr = Module['_reflection_function_ptr'] = wasmExports['reflection_function_ptr'].value;
  _reflection_method_ptr = Module['_reflection_method_ptr'] = wasmExports['reflection_method_ptr'].value;
  _reflection_intersection_type_ptr = Module['_reflection_intersection_type_ptr'] = wasmExports['reflection_intersection_type_ptr'].value;
  _reflection_union_type_ptr = Module['_reflection_union_type_ptr'] = wasmExports['reflection_union_type_ptr'].value;
  _reflection_named_type_ptr = Module['_reflection_named_type_ptr'] = wasmExports['reflection_named_type_ptr'].value;
  _reflection_property_ptr = Module['_reflection_property_ptr'] = wasmExports['reflection_property_ptr'].value;
  _reflection_class_constant_ptr = Module['_reflection_class_constant_ptr'] = wasmExports['reflection_class_constant_ptr'].value;
  _zend_ce_traversable = Module['_zend_ce_traversable'] = wasmExports['zend_ce_traversable'].value;
  _reflection_property_hook_type_ptr = Module['_reflection_property_hook_type_ptr'] = wasmExports['reflection_property_hook_type_ptr'].value;
  _reflection_reference_ptr = Module['_reflection_reference_ptr'] = wasmExports['reflection_reference_ptr'].value;
  _reflection_enum_backed_case_ptr = Module['_reflection_enum_backed_case_ptr'] = wasmExports['reflection_enum_backed_case_ptr'].value;
  _reflection_enum_unit_case_ptr = Module['_reflection_enum_unit_case_ptr'] = wasmExports['reflection_enum_unit_case_ptr'].value;
  _zend_ce_fiber = Module['_zend_ce_fiber'] = wasmExports['zend_ce_fiber'].value;
  _reflection_ptr = Module['_reflection_ptr'] = wasmExports['reflection_ptr'].value;
  _zend_ce_stringable = Module['_zend_ce_stringable'] = wasmExports['zend_ce_stringable'].value;
  _reflector_ptr = Module['_reflector_ptr'] = wasmExports['reflector_ptr'].value;
  _reflection_function_abstract_ptr = Module['_reflection_function_abstract_ptr'] = wasmExports['reflection_function_abstract_ptr'].value;
  _reflection_generator_ptr = Module['_reflection_generator_ptr'] = wasmExports['reflection_generator_ptr'].value;
  _reflection_type_ptr = Module['_reflection_type_ptr'] = wasmExports['reflection_type_ptr'].value;
  _reflection_object_ptr = Module['_reflection_object_ptr'] = wasmExports['reflection_object_ptr'].value;
  _reflection_zend_extension_ptr = Module['_reflection_zend_extension_ptr'] = wasmExports['reflection_zend_extension_ptr'].value;
  _reflection_fiber_ptr = Module['_reflection_fiber_ptr'] = wasmExports['reflection_fiber_ptr'].value;
  _reflection_constant_ptr = Module['_reflection_constant_ptr'] = wasmExports['reflection_constant_ptr'].value;
  _spl_ce_AppendIterator = Module['_spl_ce_AppendIterator'] = wasmExports['spl_ce_AppendIterator'].value;
  _spl_ce_ArrayIterator = Module['_spl_ce_ArrayIterator'] = wasmExports['spl_ce_ArrayIterator'].value;
  _spl_ce_ArrayObject = Module['_spl_ce_ArrayObject'] = wasmExports['spl_ce_ArrayObject'].value;
  _spl_ce_BadFunctionCallException = Module['_spl_ce_BadFunctionCallException'] = wasmExports['spl_ce_BadFunctionCallException'].value;
  _spl_ce_BadMethodCallException = Module['_spl_ce_BadMethodCallException'] = wasmExports['spl_ce_BadMethodCallException'].value;
  _spl_ce_CachingIterator = Module['_spl_ce_CachingIterator'] = wasmExports['spl_ce_CachingIterator'].value;
  _spl_ce_CallbackFilterIterator = Module['_spl_ce_CallbackFilterIterator'] = wasmExports['spl_ce_CallbackFilterIterator'].value;
  _spl_ce_DirectoryIterator = Module['_spl_ce_DirectoryIterator'] = wasmExports['spl_ce_DirectoryIterator'].value;
  _spl_ce_DomainException = Module['_spl_ce_DomainException'] = wasmExports['spl_ce_DomainException'].value;
  _spl_ce_EmptyIterator = Module['_spl_ce_EmptyIterator'] = wasmExports['spl_ce_EmptyIterator'].value;
  _spl_ce_FilesystemIterator = Module['_spl_ce_FilesystemIterator'] = wasmExports['spl_ce_FilesystemIterator'].value;
  _spl_ce_FilterIterator = Module['_spl_ce_FilterIterator'] = wasmExports['spl_ce_FilterIterator'].value;
  _spl_ce_GlobIterator = Module['_spl_ce_GlobIterator'] = wasmExports['spl_ce_GlobIterator'].value;
  _spl_ce_InfiniteIterator = Module['_spl_ce_InfiniteIterator'] = wasmExports['spl_ce_InfiniteIterator'].value;
  _spl_ce_InvalidArgumentException = Module['_spl_ce_InvalidArgumentException'] = wasmExports['spl_ce_InvalidArgumentException'].value;
  _spl_ce_IteratorIterator = Module['_spl_ce_IteratorIterator'] = wasmExports['spl_ce_IteratorIterator'].value;
  _spl_ce_LengthException = Module['_spl_ce_LengthException'] = wasmExports['spl_ce_LengthException'].value;
  _spl_ce_LimitIterator = Module['_spl_ce_LimitIterator'] = wasmExports['spl_ce_LimitIterator'].value;
  _spl_ce_LogicException = Module['_spl_ce_LogicException'] = wasmExports['spl_ce_LogicException'].value;
  _spl_ce_MultipleIterator = Module['_spl_ce_MultipleIterator'] = wasmExports['spl_ce_MultipleIterator'].value;
  _spl_ce_NoRewindIterator = Module['_spl_ce_NoRewindIterator'] = wasmExports['spl_ce_NoRewindIterator'].value;
  _spl_ce_OuterIterator = Module['_spl_ce_OuterIterator'] = wasmExports['spl_ce_OuterIterator'].value;
  _spl_ce_OutOfBoundsException = Module['_spl_ce_OutOfBoundsException'] = wasmExports['spl_ce_OutOfBoundsException'].value;
  _spl_ce_OutOfRangeException = Module['_spl_ce_OutOfRangeException'] = wasmExports['spl_ce_OutOfRangeException'].value;
  _spl_ce_OverflowException = Module['_spl_ce_OverflowException'] = wasmExports['spl_ce_OverflowException'].value;
  _spl_ce_ParentIterator = Module['_spl_ce_ParentIterator'] = wasmExports['spl_ce_ParentIterator'].value;
  _spl_ce_RangeException = Module['_spl_ce_RangeException'] = wasmExports['spl_ce_RangeException'].value;
  _spl_ce_RecursiveArrayIterator = Module['_spl_ce_RecursiveArrayIterator'] = wasmExports['spl_ce_RecursiveArrayIterator'].value;
  _spl_ce_RecursiveCachingIterator = Module['_spl_ce_RecursiveCachingIterator'] = wasmExports['spl_ce_RecursiveCachingIterator'].value;
  _spl_ce_RecursiveCallbackFilterIterator = Module['_spl_ce_RecursiveCallbackFilterIterator'] = wasmExports['spl_ce_RecursiveCallbackFilterIterator'].value;
  _spl_ce_RecursiveDirectoryIterator = Module['_spl_ce_RecursiveDirectoryIterator'] = wasmExports['spl_ce_RecursiveDirectoryIterator'].value;
  _spl_ce_RecursiveFilterIterator = Module['_spl_ce_RecursiveFilterIterator'] = wasmExports['spl_ce_RecursiveFilterIterator'].value;
  _spl_ce_RecursiveIterator = Module['_spl_ce_RecursiveIterator'] = wasmExports['spl_ce_RecursiveIterator'].value;
  _spl_ce_RecursiveIteratorIterator = Module['_spl_ce_RecursiveIteratorIterator'] = wasmExports['spl_ce_RecursiveIteratorIterator'].value;
  _spl_ce_RecursiveRegexIterator = Module['_spl_ce_RecursiveRegexIterator'] = wasmExports['spl_ce_RecursiveRegexIterator'].value;
  _spl_ce_RecursiveTreeIterator = Module['_spl_ce_RecursiveTreeIterator'] = wasmExports['spl_ce_RecursiveTreeIterator'].value;
  _spl_ce_RegexIterator = Module['_spl_ce_RegexIterator'] = wasmExports['spl_ce_RegexIterator'].value;
  _spl_ce_RuntimeException = Module['_spl_ce_RuntimeException'] = wasmExports['spl_ce_RuntimeException'].value;
  _spl_ce_SeekableIterator = Module['_spl_ce_SeekableIterator'] = wasmExports['spl_ce_SeekableIterator'].value;
  _spl_ce_SplDoublyLinkedList = Module['_spl_ce_SplDoublyLinkedList'] = wasmExports['spl_ce_SplDoublyLinkedList'].value;
  _spl_ce_SplFileInfo = Module['_spl_ce_SplFileInfo'] = wasmExports['spl_ce_SplFileInfo'].value;
  _spl_ce_SplFileObject = Module['_spl_ce_SplFileObject'] = wasmExports['spl_ce_SplFileObject'].value;
  _spl_ce_SplFixedArray = Module['_spl_ce_SplFixedArray'] = wasmExports['spl_ce_SplFixedArray'].value;
  _spl_ce_SplHeap = Module['_spl_ce_SplHeap'] = wasmExports['spl_ce_SplHeap'].value;
  _spl_ce_SplMinHeap = Module['_spl_ce_SplMinHeap'] = wasmExports['spl_ce_SplMinHeap'].value;
  _spl_ce_SplMaxHeap = Module['_spl_ce_SplMaxHeap'] = wasmExports['spl_ce_SplMaxHeap'].value;
  _spl_ce_SplObjectStorage = Module['_spl_ce_SplObjectStorage'] = wasmExports['spl_ce_SplObjectStorage'].value;
  _spl_ce_SplObserver = Module['_spl_ce_SplObserver'] = wasmExports['spl_ce_SplObserver'].value;
  _spl_ce_SplPriorityQueue = Module['_spl_ce_SplPriorityQueue'] = wasmExports['spl_ce_SplPriorityQueue'].value;
  _spl_ce_SplQueue = Module['_spl_ce_SplQueue'] = wasmExports['spl_ce_SplQueue'].value;
  _spl_ce_SplStack = Module['_spl_ce_SplStack'] = wasmExports['spl_ce_SplStack'].value;
  _spl_ce_SplSubject = Module['_spl_ce_SplSubject'] = wasmExports['spl_ce_SplSubject'].value;
  _spl_ce_SplTempFileObject = Module['_spl_ce_SplTempFileObject'] = wasmExports['spl_ce_SplTempFileObject'].value;
  _spl_ce_UnderflowException = Module['_spl_ce_UnderflowException'] = wasmExports['spl_ce_UnderflowException'].value;
  _spl_ce_UnexpectedValueException = Module['_spl_ce_UnexpectedValueException'] = wasmExports['spl_ce_UnexpectedValueException'].value;
  _zend_autoload = Module['_zend_autoload'] = wasmExports['zend_autoload'].value;
  _zend_ce_arrayaccess = Module['_zend_ce_arrayaccess'] = wasmExports['zend_ce_arrayaccess'].value;
  _zend_ce_serializable = Module['_zend_ce_serializable'] = wasmExports['zend_ce_serializable'].value;
  _zend_ce_countable = Module['_zend_ce_countable'] = wasmExports['zend_ce_countable'].value;
  _php_glob_stream_ops = Module['_php_glob_stream_ops'] = wasmExports['php_glob_stream_ops'].value;
  _zend_ce_throwable = Module['_zend_ce_throwable'] = wasmExports['zend_ce_throwable'].value;
  _assertion_error_ce = Module['_assertion_error_ce'] = wasmExports['assertion_error_ce'].value;
  _php_ce_incomplete_class = Module['_php_ce_incomplete_class'] = wasmExports['php_ce_incomplete_class'].value;
  _rounding_mode_ce = Module['_rounding_mode_ce'] = wasmExports['rounding_mode_ce'].value;
  _php_stream_php_wrapper = Module['_php_stream_php_wrapper'] = wasmExports['php_stream_php_wrapper'].value;
  _php_plain_files_wrapper = Module['_php_plain_files_wrapper'] = wasmExports['php_plain_files_wrapper'].value;
  _php_glob_stream_wrapper = Module['_php_glob_stream_wrapper'] = wasmExports['php_glob_stream_wrapper'].value;
  _php_stream_rfc2397_wrapper = Module['_php_stream_rfc2397_wrapper'] = wasmExports['php_stream_rfc2397_wrapper'].value;
  _php_stream_http_wrapper = Module['_php_stream_http_wrapper'] = wasmExports['php_stream_http_wrapper'].value;
  _php_stream_ftp_wrapper = Module['_php_stream_ftp_wrapper'] = wasmExports['php_stream_ftp_wrapper'].value;
  _php_load_environment_variables = Module['_php_load_environment_variables'] = wasmExports['php_load_environment_variables'].value;
  _php_optidx = Module['_php_optidx'] = wasmExports['php_optidx'].value;
  _zend_tolower_map = Module['_zend_tolower_map'] = wasmExports['zend_tolower_map'].value;
  _zend_standard_class_def = Module['_zend_standard_class_def'] = wasmExports['zend_standard_class_def'].value;
  _zend_new_interned_string = Module['_zend_new_interned_string'] = wasmExports['zend_new_interned_string'].value;
  _php_stream_stdio_ops = Module['_php_stream_stdio_ops'] = wasmExports['php_stream_stdio_ops'].value;
  _zend_ce_request_parse_body_exception = Module['_zend_ce_request_parse_body_exception'] = wasmExports['zend_ce_request_parse_body_exception'].value;
  _php_sig_gif = Module['_php_sig_gif'] = wasmExports['php_sig_gif'].value;
  _php_sig_psd = Module['_php_sig_psd'] = wasmExports['php_sig_psd'].value;
  _php_sig_bmp = Module['_php_sig_bmp'] = wasmExports['php_sig_bmp'].value;
  _php_sig_swf = Module['_php_sig_swf'] = wasmExports['php_sig_swf'].value;
  _php_sig_swc = Module['_php_sig_swc'] = wasmExports['php_sig_swc'].value;
  _php_sig_jpg = Module['_php_sig_jpg'] = wasmExports['php_sig_jpg'].value;
  _php_sig_png = Module['_php_sig_png'] = wasmExports['php_sig_png'].value;
  _php_sig_tif_ii = Module['_php_sig_tif_ii'] = wasmExports['php_sig_tif_ii'].value;
  _php_sig_tif_mm = Module['_php_sig_tif_mm'] = wasmExports['php_sig_tif_mm'].value;
  _php_sig_jpc = Module['_php_sig_jpc'] = wasmExports['php_sig_jpc'].value;
  _php_sig_jp2 = Module['_php_sig_jp2'] = wasmExports['php_sig_jp2'].value;
  _php_sig_iff = Module['_php_sig_iff'] = wasmExports['php_sig_iff'].value;
  _php_sig_ico = Module['_php_sig_ico'] = wasmExports['php_sig_ico'].value;
  _php_sig_riff = Module['_php_sig_riff'] = wasmExports['php_sig_riff'].value;
  _php_sig_webp = Module['_php_sig_webp'] = wasmExports['php_sig_webp'].value;
  _php_sig_ftyp = Module['_php_sig_ftyp'] = wasmExports['php_sig_ftyp'].value;
  _php_sig_mif1 = Module['_php_sig_mif1'] = wasmExports['php_sig_mif1'].value;
  _php_sig_heic = Module['_php_sig_heic'] = wasmExports['php_sig_heic'].value;
  _php_sig_heix = Module['_php_sig_heix'] = wasmExports['php_sig_heix'].value;
  _php_tiff_bytes_per_format = Module['_php_tiff_bytes_per_format'] = wasmExports['php_tiff_bytes_per_format'].value;
  _php_ini_opened_path = Module['_php_ini_opened_path'] = wasmExports['php_ini_opened_path'].value;
  _php_ini_scanned_path = Module['_php_ini_scanned_path'] = wasmExports['php_ini_scanned_path'].value;
  _php_ini_scanned_files = Module['_php_ini_scanned_files'] = wasmExports['php_ini_scanned_files'].value;
  _zend_ce_division_by_zero_error = Module['_zend_ce_division_by_zero_error'] = wasmExports['zend_ce_division_by_zero_error'].value;
  _zend_ce_arithmetic_error = Module['_zend_ce_arithmetic_error'] = wasmExports['zend_ce_arithmetic_error'].value;
  _php_stream_socket_ops = Module['_php_stream_socket_ops'] = wasmExports['php_stream_socket_ops'].value;
  _zend_toupper_map = Module['_zend_toupper_map'] = wasmExports['zend_toupper_map'].value;
  _zend_string_init_existing_interned = Module['_zend_string_init_existing_interned'] = wasmExports['zend_string_init_existing_interned'].value;
  _zend_write = Module['_zend_write'] = wasmExports['zend_write'].value;
  _language_scanner_globals = Module['_language_scanner_globals'] = wasmExports['language_scanner_globals'].value;
  _php_uri_parser_rfc3986 = Module['_php_uri_parser_rfc3986'] = wasmExports['php_uri_parser_rfc3986'].value;
  _php_uri_parser_whatwg = Module['_php_uri_parser_whatwg'] = wasmExports['php_uri_parser_whatwg'].value;
  _php_uri_parser_php_parse_url = Module['_php_uri_parser_php_parse_url'] = wasmExports['php_uri_parser_php_parse_url'].value;
  _le_index_ptr = Module['_le_index_ptr'] = wasmExports['le_index_ptr'].value;
  _php_register_internal_extensions_func = Module['_php_register_internal_extensions_func'] = wasmExports['php_register_internal_extensions_func'].value;
  _output_globals = Module['_output_globals'] = wasmExports['output_globals'].value;
  _php_import_environment_variables = Module['_php_import_environment_variables'] = wasmExports['php_import_environment_variables'].value;
  _php_rfc1867_callback = Module['_php_rfc1867_callback'] = wasmExports['php_rfc1867_callback'].value;
  _php_stream_memory_ops = Module['_php_stream_memory_ops'] = wasmExports['php_stream_memory_ops'].value;
  _php_stream_temp_ops = Module['_php_stream_temp_ops'] = wasmExports['php_stream_temp_ops'].value;
  _php_stream_rfc2397_ops = Module['_php_stream_rfc2397_ops'] = wasmExports['php_stream_rfc2397_ops'].value;
  _php_stream_rfc2397_wops = Module['_php_stream_rfc2397_wops'] = wasmExports['php_stream_rfc2397_wops'].value;
  _php_stream_userspace_ops = Module['_php_stream_userspace_ops'] = wasmExports['php_stream_userspace_ops'].value;
  _php_stream_userspace_dir_ops = Module['_php_stream_userspace_dir_ops'] = wasmExports['php_stream_userspace_dir_ops'].value;
  _zend_op_array_extension_handles = Module['_zend_op_array_extension_handles'] = wasmExports['zend_op_array_extension_handles'].value;
  _zend_func_info_rid = Module['_zend_func_info_rid'] = wasmExports['zend_func_info_rid'].value;
  _zend_flf_functions = Module['_zend_flf_functions'] = wasmExports['zend_flf_functions'].value;
  _zend_random_bytes_insecure = Module['_zend_random_bytes_insecure'] = wasmExports['zend_random_bytes_insecure'].value;
  _zend_dl_use_deepbind = Module['_zend_dl_use_deepbind'] = wasmExports['zend_dl_use_deepbind'].value;
  _zend_ce_type_error = Module['_zend_ce_type_error'] = wasmExports['zend_ce_type_error'].value;
  _zend_flf_handlers = Module['_zend_flf_handlers'] = wasmExports['zend_flf_handlers'].value;
  _zend_ast_process = Module['_zend_ast_process'] = wasmExports['zend_ast_process'].value;
  _zend_ce_sensitive_parameter_value = Module['_zend_ce_sensitive_parameter_value'] = wasmExports['zend_ce_sensitive_parameter_value'].value;
  _zend_ce_deprecated = Module['_zend_ce_deprecated'] = wasmExports['zend_ce_deprecated'].value;
  _zend_ce_nodiscard = Module['_zend_ce_nodiscard'] = wasmExports['zend_ce_nodiscard'].value;
  _zend_ce_attribute = Module['_zend_ce_attribute'] = wasmExports['zend_ce_attribute'].value;
  _zend_ce_return_type_will_change_attribute = Module['_zend_ce_return_type_will_change_attribute'] = wasmExports['zend_ce_return_type_will_change_attribute'].value;
  _zend_ce_allow_dynamic_properties = Module['_zend_ce_allow_dynamic_properties'] = wasmExports['zend_ce_allow_dynamic_properties'].value;
  _zend_ce_sensitive_parameter = Module['_zend_ce_sensitive_parameter'] = wasmExports['zend_ce_sensitive_parameter'].value;
  _zend_ce_override = Module['_zend_ce_override'] = wasmExports['zend_ce_override'].value;
  _zend_ce_delayed_target_validation = Module['_zend_ce_delayed_target_validation'] = wasmExports['zend_ce_delayed_target_validation'].value;
  _gc_collect_cycles = Module['_gc_collect_cycles'] = wasmExports['gc_collect_cycles'].value;
  _zend_ce_compile_error = Module['_zend_ce_compile_error'] = wasmExports['zend_ce_compile_error'].value;
  _zend_execute_internal = Module['_zend_execute_internal'] = wasmExports['zend_execute_internal'].value;
  _zend_execute_ex = Module['_zend_execute_ex'] = wasmExports['zend_execute_ex'].value;
  _zend_compile_string = Module['_zend_compile_string'] = wasmExports['zend_compile_string'].value;
  _zend_ce_unit_enum = Module['_zend_ce_unit_enum'] = wasmExports['zend_ce_unit_enum'].value;
  _zend_ce_backed_enum = Module['_zend_ce_backed_enum'] = wasmExports['zend_ce_backed_enum'].value;
  _zend_ce_parse_error = Module['_zend_ce_parse_error'] = wasmExports['zend_ce_parse_error'].value;
  _zend_throw_exception_hook = Module['_zend_throw_exception_hook'] = wasmExports['zend_throw_exception_hook'].value;
  _zend_observer_errors_observed = Module['_zend_observer_errors_observed'] = wasmExports['zend_observer_errors_observed'].value;
  _zend_ce_argument_count_error = Module['_zend_ce_argument_count_error'] = wasmExports['zend_ce_argument_count_error'].value;
  _zend_ce_error_exception = Module['_zend_ce_error_exception'] = wasmExports['zend_ce_error_exception'].value;
  _zend_ce_unhandled_match_error = Module['_zend_ce_unhandled_match_error'] = wasmExports['zend_ce_unhandled_match_error'].value;
  _zend_on_timeout = Module['_zend_on_timeout'] = wasmExports['zend_on_timeout'].value;
  _zend_observer_fcall_internal_function_extension = Module['_zend_observer_fcall_internal_function_extension'] = wasmExports['zend_observer_fcall_internal_function_extension'].value;
  _zend_pass_function = Module['_zend_pass_function'] = wasmExports['zend_pass_function'].value;
  _zend_ticks_function = Module['_zend_ticks_function'] = wasmExports['zend_ticks_function'].value;
  _zend_touch_vm_stack_data = Module['_zend_touch_vm_stack_data'] = wasmExports['zend_touch_vm_stack_data'].value;
  _zend_extension_flags = Module['_zend_extension_flags'] = wasmExports['zend_extension_flags'].value;
  _zend_internal_function_extension_handles = Module['_zend_internal_function_extension_handles'] = wasmExports['zend_internal_function_extension_handles'].value;
  ___jit_debug_descriptor = Module['___jit_debug_descriptor'] = wasmExports['__jit_debug_descriptor'].value;
  _zend_ce_ClosedGeneratorException = Module['_zend_ce_ClosedGeneratorException'] = wasmExports['zend_ce_ClosedGeneratorException'].value;
  _zend_printf = Module['_zend_printf'] = wasmExports['zend_printf'].value;
  _ini_scanner_globals = Module['_ini_scanner_globals'] = wasmExports['ini_scanner_globals'].value;
  _zend_getenv = Module['_zend_getenv'] = wasmExports['zend_getenv'].value;
  _zend_uv = Module['_zend_uv'] = wasmExports['zend_uv'].value;
  _zend_ce_internal_iterator = Module['_zend_ce_internal_iterator'] = wasmExports['zend_ce_internal_iterator'].value;
  _zend_multibyte_encoding_utf32be = Module['_zend_multibyte_encoding_utf32be'] = wasmExports['zend_multibyte_encoding_utf32be'].value;
  _zend_multibyte_encoding_utf32le = Module['_zend_multibyte_encoding_utf32le'] = wasmExports['zend_multibyte_encoding_utf32le'].value;
  _zend_multibyte_encoding_utf16be = Module['_zend_multibyte_encoding_utf16be'] = wasmExports['zend_multibyte_encoding_utf16be'].value;
  _zend_multibyte_encoding_utf16le = Module['_zend_multibyte_encoding_utf16le'] = wasmExports['zend_multibyte_encoding_utf16le'].value;
  _zend_multibyte_encoding_utf8 = Module['_zend_multibyte_encoding_utf8'] = wasmExports['zend_multibyte_encoding_utf8'].value;
  _zend_fopen = Module['_zend_fopen'] = wasmExports['zend_fopen'].value;
  _zend_ce_weakref = Module['_zend_ce_weakref'] = wasmExports['zend_ce_weakref'].value;
  _zend_random_bytes = Module['_zend_random_bytes'] = wasmExports['zend_random_bytes'].value;
  _zend_dtrace_enabled = Module['_zend_dtrace_enabled'] = wasmExports['zend_dtrace_enabled'].value;
}

var wasmImports = {
  /** @export */
  __call_sighandler: ___call_sighandler,
  /** @export */
  __syscall_accept4: ___syscall_accept4,
  /** @export */
  __syscall_bind: ___syscall_bind,
  /** @export */
  __syscall_chdir: ___syscall_chdir,
  /** @export */
  __syscall_chmod: ___syscall_chmod,
  /** @export */
  __syscall_connect: ___syscall_connect,
  /** @export */
  __syscall_dup: ___syscall_dup,
  /** @export */
  __syscall_dup3: ___syscall_dup3,
  /** @export */
  __syscall_faccessat: ___syscall_faccessat,
  /** @export */
  __syscall_fchmod: ___syscall_fchmod,
  /** @export */
  __syscall_fchownat: ___syscall_fchownat,
  /** @export */
  __syscall_fcntl64: ___syscall_fcntl64,
  /** @export */
  __syscall_fdatasync: ___syscall_fdatasync,
  /** @export */
  __syscall_fstat64: ___syscall_fstat64,
  /** @export */
  __syscall_ftruncate64: ___syscall_ftruncate64,
  /** @export */
  __syscall_getcwd: ___syscall_getcwd,
  /** @export */
  __syscall_getdents64: ___syscall_getdents64,
  /** @export */
  __syscall_getpeername: ___syscall_getpeername,
  /** @export */
  __syscall_getsockname: ___syscall_getsockname,
  /** @export */
  __syscall_getsockopt: ___syscall_getsockopt,
  /** @export */
  __syscall_ioctl: ___syscall_ioctl,
  /** @export */
  __syscall_listen: ___syscall_listen,
  /** @export */
  __syscall_lstat64: ___syscall_lstat64,
  /** @export */
  __syscall_mkdirat: ___syscall_mkdirat,
  /** @export */
  __syscall_newfstatat: ___syscall_newfstatat,
  /** @export */
  __syscall_openat: ___syscall_openat,
  /** @export */
  __syscall_pipe: ___syscall_pipe,
  /** @export */
  __syscall_poll: ___syscall_poll,
  /** @export */
  __syscall_readlinkat: ___syscall_readlinkat,
  /** @export */
  __syscall_recvfrom: ___syscall_recvfrom,
  /** @export */
  __syscall_renameat: ___syscall_renameat,
  /** @export */
  __syscall_rmdir: ___syscall_rmdir,
  /** @export */
  __syscall_sendto: ___syscall_sendto,
  /** @export */
  __syscall_socket: ___syscall_socket,
  /** @export */
  __syscall_stat64: ___syscall_stat64,
  /** @export */
  __syscall_statfs64: ___syscall_statfs64,
  /** @export */
  __syscall_symlinkat: ___syscall_symlinkat,
  /** @export */
  __syscall_unlinkat: ___syscall_unlinkat,
  /** @export */
  __syscall_utimensat: ___syscall_utimensat,
  /** @export */
  _abort_js: __abort_js,
  /** @export */
  _emscripten_lookup_name: __emscripten_lookup_name,
  /** @export */
  _emscripten_runtime_keepalive_clear: __emscripten_runtime_keepalive_clear,
  /** @export */
  _emscripten_throw_longjmp: __emscripten_throw_longjmp,
  /** @export */
  _gmtime_js: __gmtime_js,
  /** @export */
  _localtime_js: __localtime_js,
  /** @export */
  _mktime_js: __mktime_js,
  /** @export */
  _mmap_js: __mmap_js,
  /** @export */
  _munmap_js: __munmap_js,
  /** @export */
  _setitimer_js: __setitimer_js,
  /** @export */
  _tzset_js: __tzset_js,
  /** @export */
  clock_time_get: _clock_time_get,
  /** @export */
  emscripten_date_now: _emscripten_date_now,
  /** @export */
  emscripten_get_heap_max: _emscripten_get_heap_max,
  /** @export */
  emscripten_get_now: _emscripten_get_now,
  /** @export */
  emscripten_resize_heap: _emscripten_resize_heap,
  /** @export */
  environ_get: _environ_get,
  /** @export */
  environ_sizes_get: _environ_sizes_get,
  /** @export */
  exit: _exit,
  /** @export */
  fd_close: _fd_close,
  /** @export */
  fd_fdstat_get: _fd_fdstat_get,
  /** @export */
  fd_read: _fd_read,
  /** @export */
  fd_seek: _fd_seek,
  /** @export */
  fd_sync: _fd_sync,
  /** @export */
  fd_write: _fd_write,
  /** @export */
  getaddrinfo: _getaddrinfo,
  /** @export */
  getnameinfo: _getnameinfo,
  /** @export */
  getprotobyname: _getprotobyname,
  /** @export */
  getprotobynumber: _getprotobynumber,
  /** @export */
  invoke_i,
  /** @export */
  invoke_ii,
  /** @export */
  invoke_iii,
  /** @export */
  invoke_iiidii,
  /** @export */
  invoke_iiii,
  /** @export */
  invoke_iiiii,
  /** @export */
  invoke_iiiiii,
  /** @export */
  invoke_iiiiiii,
  /** @export */
  invoke_iiiiiiii,
  /** @export */
  invoke_iiiiiiiiii,
  /** @export */
  invoke_jii,
  /** @export */
  invoke_v,
  /** @export */
  invoke_vi,
  /** @export */
  invoke_vii,
  /** @export */
  invoke_viii,
  /** @export */
  invoke_viiii,
  /** @export */
  invoke_viiiii,
  /** @export */
  invoke_viiiiii,
  /** @export */
  invoke_viiiiiii,
  /** @export */
  proc_exit: _proc_exit,
  /** @export */
  strptime: _strptime
};

function invoke_iiii(index,a1,a2,a3) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1,a2,a3);
  } catch(e) {
    stackRestore(sp);
    if (e !== e+0) throw e;
    _setThrew(1, 0);
  }
}

function invoke_viii(index,a1,a2,a3) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)(a1,a2,a3);
  } catch(e) {
    stackRestore(sp);
    if (e !== e+0) throw e;
    _setThrew(1, 0);
  }
}

function invoke_vii(index,a1,a2) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)(a1,a2);
  } catch(e) {
    stackRestore(sp);
    if (e !== e+0) throw e;
    _setThrew(1, 0);
  }
}

function invoke_iii(index,a1,a2) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1,a2);
  } catch(e) {
    stackRestore(sp);
    if (e !== e+0) throw e;
    _setThrew(1, 0);
  }
}

function invoke_vi(index,a1) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)(a1);
  } catch(e) {
    stackRestore(sp);
    if (e !== e+0) throw e;
    _setThrew(1, 0);
  }
}

function invoke_ii(index,a1) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1);
  } catch(e) {
    stackRestore(sp);
    if (e !== e+0) throw e;
    _setThrew(1, 0);
  }
}

function invoke_jii(index,a1,a2) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1,a2);
  } catch(e) {
    stackRestore(sp);
    if (e !== e+0) throw e;
    _setThrew(1, 0);
    return 0n;
  }
}

function invoke_i(index) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)();
  } catch(e) {
    stackRestore(sp);
    if (e !== e+0) throw e;
    _setThrew(1, 0);
  }
}

function invoke_v(index) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)();
  } catch(e) {
    stackRestore(sp);
    if (e !== e+0) throw e;
    _setThrew(1, 0);
  }
}

function invoke_iiiii(index,a1,a2,a3,a4) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1,a2,a3,a4);
  } catch(e) {
    stackRestore(sp);
    if (e !== e+0) throw e;
    _setThrew(1, 0);
  }
}

function invoke_iiiiii(index,a1,a2,a3,a4,a5) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1,a2,a3,a4,a5);
  } catch(e) {
    stackRestore(sp);
    if (e !== e+0) throw e;
    _setThrew(1, 0);
  }
}

function invoke_viiii(index,a1,a2,a3,a4) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)(a1,a2,a3,a4);
  } catch(e) {
    stackRestore(sp);
    if (e !== e+0) throw e;
    _setThrew(1, 0);
  }
}

function invoke_viiiii(index,a1,a2,a3,a4,a5) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)(a1,a2,a3,a4,a5);
  } catch(e) {
    stackRestore(sp);
    if (e !== e+0) throw e;
    _setThrew(1, 0);
  }
}

function invoke_iiidii(index,a1,a2,a3,a4,a5) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1,a2,a3,a4,a5);
  } catch(e) {
    stackRestore(sp);
    if (e !== e+0) throw e;
    _setThrew(1, 0);
  }
}

function invoke_iiiiiiiiii(index,a1,a2,a3,a4,a5,a6,a7,a8,a9) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1,a2,a3,a4,a5,a6,a7,a8,a9);
  } catch(e) {
    stackRestore(sp);
    if (e !== e+0) throw e;
    _setThrew(1, 0);
  }
}

function invoke_iiiiiii(index,a1,a2,a3,a4,a5,a6) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1,a2,a3,a4,a5,a6);
  } catch(e) {
    stackRestore(sp);
    if (e !== e+0) throw e;
    _setThrew(1, 0);
  }
}

function invoke_viiiiii(index,a1,a2,a3,a4,a5,a6) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)(a1,a2,a3,a4,a5,a6);
  } catch(e) {
    stackRestore(sp);
    if (e !== e+0) throw e;
    _setThrew(1, 0);
  }
}

function invoke_iiiiiiii(index,a1,a2,a3,a4,a5,a6,a7) {
  var sp = stackSave();
  try {
    return getWasmTableEntry(index)(a1,a2,a3,a4,a5,a6,a7);
  } catch(e) {
    stackRestore(sp);
    if (e !== e+0) throw e;
    _setThrew(1, 0);
  }
}

function invoke_viiiiiii(index,a1,a2,a3,a4,a5,a6,a7) {
  var sp = stackSave();
  try {
    getWasmTableEntry(index)(a1,a2,a3,a4,a5,a6,a7);
  } catch(e) {
    stackRestore(sp);
    if (e !== e+0) throw e;
    _setThrew(1, 0);
  }
}


// include: postamble.js
// === Auto-generated postamble setup entry stuff ===

function callMain(args = []) {

  var entryFunction = _main;

  args.unshift(thisProgram);

  var argc = args.length;
  var argv = stackAlloc((argc + 1) * 4);
  var argv_ptr = argv;
  for (var arg of args) {
    HEAPU32[((argv_ptr)>>2)] = stringToUTF8OnStack(arg);
    argv_ptr += 4;
  }
  HEAPU32[((argv_ptr)>>2)] = 0;

  try {

    var ret = entryFunction(argc, argv);

    // if we're not running an evented main loop, it's time to exit
    exitJS(ret, /* implicit = */ true);
    return ret;
  } catch (e) {
    return handleException(e);
  }
}

function run(args = arguments_) {

  if (runDependencies > 0) {
    dependenciesFulfilled = run;
    return;
  }

  preRun();

  // a preRun added a dependency, run will be called later
  if (runDependencies > 0) {
    dependenciesFulfilled = run;
    return;
  }

  function doRun() {
    // run may have just been called through dependencies being fulfilled just in this very frame,
    // or while the async setStatus time below was happening
    Module['calledRun'] = true;

    if (ABORT) return;

    initRuntime();

    preMain();

    Module['onRuntimeInitialized']?.();

    var noInitialRun = Module['noInitialRun'] || false;
    if (!noInitialRun) callMain(args);

    postRun();
  }

  if (Module['setStatus']) {
    Module['setStatus']('Running...');
    setTimeout(() => {
      setTimeout(() => Module['setStatus'](''), 1);
      doRun();
    }, 1);
  } else
  {
    doRun();
  }
}

var wasmExports;

// With async instantation wasmExports is assigned asynchronously when the
// instance is received.
createWasm();

run();

// end include: postamble.js

