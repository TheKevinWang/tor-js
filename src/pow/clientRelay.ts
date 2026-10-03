/**
 * Asking the pages a Service Worker controls to solve proof-of-work puzzles for it.
 *
 * A Service Worker cannot start workers, but it can message its clients (the pages it controls).
 * With the Tor client inside the Service Worker (`"client": { "host": "service-worker" }`), the
 * puzzle is therefore solved the way it is for a SharedWorker host (powRelay.ts, powPage.ts): the
 * Service Worker asks a page for a `MessagePort` and the page runs the pool of workers. The page
 * script (`tor-site.js`, which a site's pages load) answers the request.
 *
 * The request is the one the WebRTC peer relay makes (`acquirePeerPort`, peerRelay.ts), delivered
 * with `Client.postMessage` instead of a worker port. Clients are asked most recently focused first.
 */

import { acquirePeerPort, type PageTarget } from '../site/peerRelay.js';
import type { PowRelayOptions } from './powRelay.js';

/** The part of a Service Worker `Client` that is used (so tests can supply a fake). */
export interface ClientLike {
  postMessage(message: unknown, transfer: Transferable[]): void;
}

/**
 * An `acquirePort` for `createRemotePowSolver` that asks the clients `listClients` returns.
 * `listClients` is `() => self.clients.matchAll({ type: 'window' })`, which lists the most
 * recently focused client first.
 */
export function createClientPowAcquirer(
  listClients: () => Promise<readonly ClientLike[]>,
  timeoutMs = 10_000,
): PowRelayOptions['acquirePort'] {
  return async (extra) => {
    // `acquirePeerPort` asks the last target first.
    const targets: PageTarget[] = [...(await listClients())]
      .reverse()
      .map((client) => ({ post: (message, transfer) => client.postMessage(message, transfer) }));
    return acquirePeerPort(targets, timeoutMs, { kind: 'pow', extra });
  };
}
