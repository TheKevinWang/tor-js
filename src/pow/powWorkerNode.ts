/**
 * Worker entry for solving a proof-of-work puzzle in Node (bundled to `dist/pow-node-worker.js`).
 *
 * The same job as `powWorkerAny.ts` (the Web Worker script), for `node:worker_threads`: the pool
 * (powPool.ts) starts one per core, sends each a `solve` message, takes the first solution and
 * terminates the rest. In Node, `fetch` cannot read a `file:` URL, so the WASM bytes come either in the
 * message (`wasmBytes`) or from reading the file the message names.
 */

import { parentPort } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { solveRequest } from './solveCore.js';
import type { PowWorkerReply, PowWorkerRequest } from './powPool.js';

const port = parentPort;

if (port) {
  port.on('message', async (request: PowWorkerRequest) => {
    if (request?.t !== 'solve') return;
    try {
      const solution = await solveRequest(request, async (url) => (url.startsWith('file:') ? readFile(fileURLToPath(url)) : url));
      const reply: PowWorkerReply = { t: 'solved', solution };
      port.postMessage(reply);
    } catch (e) {
      const reply: PowWorkerReply = { t: 'error', message: e instanceof Error ? e.message : String(e) };
      port.postMessage(reply);
    }
  });
}
