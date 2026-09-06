// SPDX-FileCopyrightText: 2026 Alexandre Gomes Gaigalas <alganet@gmail.com>
//
// SPDX-License-Identifier: ISC

// The runtime contract — what somebody porting another runtime has to satisfy.
//
// No PHP anywhere in this file, deliberately: the claim it pins is that a
// runtime which is NOT phasm can satisfy the contract, so booting the real
// module here would prove the opposite of the point. The stand-in below is the
// whole of what the stack asks for, written out, and it doubles as the worked
// example the docs describe.
//
// The other half of this suite lives in `wide`, which owns the two consumers —
// the shell builtin and the request wire — and drives this same toy runtime
// through both. What is here is what phasm can still answer on its own: that
// the decline is one value, and that the assertions name the right caller.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DECLINE, assertRunRuntime, assertServeRuntime } from '../src/contract.mjs';
import { DECLINE as DECLINE_FROM_RESOLVE } from '../src/resolve.mjs';

const enc = new TextEncoder();

/**
 * A runtime that is not PHP, implementing the contract and nothing else.
 *
 * It is deliberately trivial — a `run()` that echoes and a handler that answers
 * every request the same way — because the point is the SHAPE. Anything a real
 * port adds sits behind these same two functions.
 */
function toyRuntime() {
  const seen = { requests: [], runs: [] };
  return {
    seen,
    // `collect: false` with an `onOutput` is what a shell builtin passes, and
    // honouring it is part of the contract rather than an optimisation: the
    // shell's descriptors are already where that command's output belongs, so
    // there is no caller waiting for a returned string.
    run({ args, collect, onOutput }) {
      seen.runs.push(args);
      const text = `toy:${args.join(' ')}`;
      if (onOutput) onOutput(enc.encode(text), 'stdout');
      return {
        stdout: collect === false ? '' : text,
        stderr: '',
        exitCode: args[0] === 'fail' ? 3 : 0,
      };
    },
    phasmHandleRequest(req) {
      seen.requests.push(req);
      return {
        status: 200,
        headers: [['Content-Type', 'text/plain'], ['X-Runtime', 'toy']],
        body: enc.encode(`toy saw ${req.url}`),
      };
    },
  };
}

describe('the decline', () => {
  test('is one value, wherever it is imported from', () => {
    // The router exports it and the contract defines it. A copy that drifted
    // would make the two disagree about what 0 means, which is the kind of bug
    // that shows up as a blank page.
    assert.equal(DECLINE, 0);
    assert.equal(DECLINE_FROM_RESOLVE, DECLINE);
  });
});

describe('the worked example', () => {
  test('satisfies both halves of the contract', () => {
    // The assertion a consumer runs at wiring time, run here against the
    // example the docs point at — so a change to either is caught by the other.
    const rt = toyRuntime();
    assert.doesNotThrow(() => assertRunRuntime(rt));
    assert.doesNotThrow(() => assertServeRuntime(rt));
  });

  test('needs no phasmCapture — that is PHP\'s problem, not every runtime\'s', () => {
    assert.equal(typeof toyRuntime().phasmCapture, 'undefined');
  });
});

describe('the assertions on their own', () => {
  test('take the caller\'s name, so the message blames the right function', () => {
    assert.throws(() => assertServeRuntime({}, 'myServer'), /^TypeError: myServer: /);
    assert.throws(() => assertRunRuntime({}, 'myShell'), /^TypeError: myShell: /);
  });

  test('say what is missing, by name', () => {
    assert.throws(() => assertServeRuntime({}), /needs a runtime with phasmHandleRequest/);
    assert.throws(() => assertServeRuntime(null), /phasmHandleRequest/);
    assert.throws(() => assertServeRuntime({ run() {} }), /phasmHandleRequest/);
    assert.throws(() => assertRunRuntime({}), /needs a runtime with run\(options\)/);
    assert.throws(() => assertRunRuntime(null), /run\(options\)/);
  });

  test('and the message says where to look', () => {
    assert.throws(() => assertServeRuntime({}), /@alganet\/phasm\/contract/);
    assert.throws(() => assertRunRuntime({}), /@alganet\/phasm\/contract/);
  });

  test('pass anything of the right shape', () => {
    assert.doesNotThrow(() => assertServeRuntime({ phasmHandleRequest() {} }));
    assert.doesNotThrow(() => assertRunRuntime({ run() {} }));
  });
});
