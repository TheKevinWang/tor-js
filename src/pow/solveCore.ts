/**
 * Solve a proof-of-work puzzle with whichever build of the WASM the request names.
 *
 * tor-js has two builds of its WASM (the default one and the one that can host an onion service), and a
 * WASM file works only with the JavaScript glue generated with it: the glue's import names differ. A
 * client created from `tor-js/host` hands its workers the host WASM, so a worker script has to carry both
 * glues and pick by `request.variant` ("host" or absent for the default). Both builds export the solver.
 */

import initDefault, { powSolveV1 as solveDefault } from '#wasm';
import initHost, { powSolveV1 as solveHost } from '#wasm-host';
import type { PowSolution, PowWorkerRequest } from './powPool.js';

const initialised: { default?: Promise<unknown>; host?: Promise<unknown> } = {};

/**
 * @param loadBytes how this realm gets the WASM when the request has no bytes: it returns bytes, or a URL
 *   the glue can `fetch` (a Web Worker passes the URL through; Node reads `file:` URLs itself).
 */
export async function solveRequest(
  request: PowWorkerRequest,
  loadBytes: (url: string) => Promise<Uint8Array | string>,
): Promise<PowSolution> {
  const host = request.variant === 'host';
  const key = host ? 'host' : 'default';
  initialised[key] ??= (async () => {
    const source = request.wasmBytes ?? await loadBytes(request.wasmUrl);
    return (host ? initHost : initDefault)({ module_or_path: source } as never);
  })();
  await initialised[key];
  return (host ? solveHost : solveDefault)(request.blindId, request.seed, request.effort, request.startNonce) as PowSolution;
}
