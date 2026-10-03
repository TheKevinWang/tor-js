/**
 * Install the proof-of-work solver a site's manifest asks for (`client.pow`), for whichever context
 * hosts the Tor client: the persistent host worker (hostWorker.ts) or the Service Worker (sw.ts).
 * See powPool.ts for what the solver does and install.ts for how it is chosen.
 */

import type { SiteManifest } from '../site/manifest.js';
import { installPowSolver } from './install.js';
import type { PowRelayOptions } from './powRelay.js';

/**
 * Install the solver unless the manifest turns it off. `acquirePort` is how to ask a page to run the
 * workers where this context cannot start them itself (a SharedWorker, a Service Worker).
 */
export function installManifestPow(
  manifest: SiteManifest,
  manifestUrl: string,
  wasmUrl: string,
  acquirePort: PowRelayOptions['acquirePort'],
): () => void {
  const pow = manifest.client.pow;
  if (pow === false) return () => {};
  const options = typeof pow === 'object' ? pow : {};
  return installPowSolver({
    workerUrl: new URL(options.workerUrl ?? 'tor-site-pow.js', manifestUrl).href,
    wasmUrl,
    workers: options.workers,
    maxEffort: options.maxEffort,
    minEffort: options.minEffort,
    acquirePort,
  });
}
