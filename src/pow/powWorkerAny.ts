/**
 * Worker entry for solving a proof-of-work puzzle for a plain `TorClient` in a page (bundled to
 * `dist/pow-worker.js`). Like `powWorker.ts` (which the static-site adapter uses, and which only knows the
 * default build of the WASM), but it carries both builds' glue and picks by `request.variant`, because a
 * client created from `tor-js/host` hands its workers the host WASM (see solveCore.ts).
 */

import { solveRequest } from './solveCore.js';
import type { PowWorkerReply, PowWorkerRequest } from './powPool.js';

const scope = self as unknown as {
  onmessage: ((event: { data: PowWorkerRequest }) => void) | null;
  postMessage(message: PowWorkerReply): void;
};

scope.onmessage = async (event) => {
  const request = event.data;
  if (request?.t !== 'solve') return;
  try {
    const solution = await solveRequest(request, async (url) => url);
    scope.postMessage({ t: 'solved', solution });
  } catch (e) {
    scope.postMessage({ t: 'error', message: e instanceof Error ? e.message : String(e) });
  }
};
