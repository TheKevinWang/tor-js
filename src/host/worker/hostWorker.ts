/**
 * The hosting worker: a SharedWorker (or a dedicated Worker where SharedWorker does not exist) that runs a
 * Tor client and an onion service, so that the service outlives a page reload and is shared by every tab of
 * the origin. Bundled to `dist/host-worker.js` against the host build of the WASM (build.mjs).
 * See .agent/worker-hosting-execplan.md; the page side is startHostWorker.ts and the message handling is
 * protocol.ts.
 */

import { setWasmSourceProvider, setWasmUrl } from '../../wasm.js';
import { TorClient } from '../../TorClient.js';
import type { Handler } from '../types.js';
import { HostWorkerCore, type HostWorkerStart, type RunningHostedService, type ToHostWorker } from './protocol.js';

// `self` is a SharedWorkerGlobalScope or a DedicatedWorkerGlobalScope; they differ only in how messages arrive.
const scope = self as unknown as {
  onconnect?: ((e: MessageEvent) => void) | null;
  onmessage?: ((e: MessageEvent) => void) | null;
};

// The WASM source can be set once per worker (the first service's), however many services come and go.
let wasmConfigured = false;

async function start(request: HostWorkerStart): Promise<RunningHostedService> {
  if (!wasmConfigured) {
    if (request.wasmBytes) {
      const bytes = request.wasmBytes;
      setWasmSourceProvider(async () => bytes, { variant: 'host' });
    } else if (request.wasmUrl) {
      setWasmUrl(request.wasmUrl);
    } else {
      throw new Error('the page gave the hosting worker no WASM to load');
    }
    wasmConfigured = true;
  }
  const module = (await import(/* @vite-ignore */ request.handlerUrl)) as { default?: unknown };
  if (typeof module.default !== 'function') {
    throw new Error(`${request.handlerUrl} has no default export that is a function: export default (request) => new Response(...)`);
  }
  const handler = module.default as Handler;

  const client = new TorClient({
    snowflake: request.snowflake ?? 'websocket',
    ...(request.bootstrapUrl ? { bootstrapUrl: request.bootstrapUrl } : {}),
    logLevel: 'warn',
    pow: false, // this client hosts, it does not visit; a SharedWorker could not start solver workers anyway
  });
  try {
    await client.ready();
    const listener = await client.serve(handler, {
      identity: request.identity,
      ...(request.ports ? { ports: request.ports } : {}),
      ...(request.maxConnections !== undefined ? { maxConnections: request.maxConnections } : {}),
      ...(request.proofOfWork !== undefined ? { proofOfWork: request.proofOfWork } : {}),
    });
    const done = listener.done.then(() => client.close(), () => client.close());
    return {
      onion: listener.onion,
      get pow() { return listener.pow; },
      close: () => listener.close(),
      done,
    };
  } catch (e) {
    client.close();
    throw e;
  }
}

const core = new HostWorkerCore({ start });

if ('onconnect' in scope) {
  // SharedWorker: every page connects with its own port.
  scope.onconnect = (event) => {
    const port = event.ports[0];
    const id = core.attach({ post: (message) => port.postMessage(message) });
    port.onmessage = (e) => core.receive(id, e.data as ToHostWorker);
    port.start();
  };
} else {
  // Dedicated Worker: the one page that started it.
  const id = core.attach({ post: (message) => (self as unknown as Worker).postMessage(message) });
  scope.onmessage = (e) => core.receive(id, e.data as ToHostWorker);
}
