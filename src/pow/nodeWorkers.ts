/**
 * Node workers for the proof-of-work pool (powPool.ts): `node:worker_threads` adapted to the small
 * `PowWorkerLike` interface the pool uses (`postMessage`, `terminate`, and `onmessage` / `onerror`
 * properties the pool sets), which is the shape of a Web Worker.
 */

import type { PowWorkerLike } from './powPool.js';

/** Loads `node:worker_threads` (only ever in Node) and returns a function that starts a worker at `url`. */
export async function createNodeWorkerFactory(): Promise<(url: string) => PowWorkerLike> {
  const { Worker } = await import('node:worker_threads');
  return (url: string) => {
    const worker = new Worker(url.startsWith('file:') ? new URL(url) : url);
    const like: PowWorkerLike = {
      postMessage: (message) => worker.postMessage(message),
      // terminate() returns a promise; the pool does not wait for it.
      terminate: () => { void worker.terminate(); },
      onmessage: null,
      onerror: null,
    };
    worker.on('message', (data) => like.onmessage?.({ data }));
    worker.on('error', (error: unknown) => like.onerror?.({ message: error instanceof Error ? error.message : String(error) }));
    return like;
  };
}
