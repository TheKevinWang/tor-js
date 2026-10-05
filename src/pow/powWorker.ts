/**
 * Worker entry for solving a proof-of-work puzzle (bundled to `tor-site-pow.js`).
 *
 * The pool (powPool.ts) starts this worker, sends one `solve` message with the URL of the
 * project's WASM and the puzzle, and terminates the worker when any worker has a solution.
 * Solving takes as long as it takes (minutes at a high effort) and cannot be interrupted from
 * inside, so there is no cancel message: termination is the cancel.
 */

import initWasm, { powSolveV1 } from '#wasm';
import type { PowWorkerReply, PowWorkerRequest } from './powPool.js';

const scope = self as unknown as {
  onmessage: ((event: { data: PowWorkerRequest }) => void) | null;
  postMessage(message: PowWorkerReply): void;
};

scope.onmessage = async (event) => {
  const request = event.data;
  if (request?.t !== 'solve') return;
  try {
    await initWasm({ module_or_path: request.wasmBytes ?? request.wasmUrl });
    const solution = powSolveV1(request.blindId, request.seed, request.effort, request.startNonce);
    scope.postMessage({ t: 'solved', solution });
  } catch (e) {
    scope.postMessage({ t: 'error', message: e instanceof Error ? e.message : String(e) });
  }
};
