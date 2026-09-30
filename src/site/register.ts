/**
 * Page-side entry point of the site adapter: registers the Service Worker and
 * tells the page when Tor is connected.
 *
 *   const site = await registerTorSite();          // defaults: ./tor-site-sw.js, ./tor-site.json
 *   await site.ready();                            // Tor connected
 *   fetch('/api/messages')                         // now travels over Tor, if the manifest says so
 *
 * Until the worker controls the page (the very first visit), requests to Tor
 * paths would reach the static host and 404; `await registerTorSite()` resolves
 * only once the worker is in control, so awaiting it before the first such
 * request is enough.
 */

import type { SiteStatus } from './backend.js';

export type { SiteStatus } from './backend.js';

export interface RegisterOptions {
  /** URL of the Service Worker script. Default `tor-site-sw.js`, next to the page. */
  sw?: string;
  /** URL of the manifest, relative to the worker script. Default `tor-site.json`. */
  manifest?: string;
  /** Service Worker scope. Default: the script's directory. */
  scope?: string;
  /** Start connecting to Tor as soon as the worker is active. Default true. */
  prewarm?: boolean;
  /** Print the Tor client's log to this page's console. Also on when `localStorage["tor-site-debug"]` is set. */
  debug?: boolean;
}

export interface TorSite {
  readonly registration: ServiceWorkerRegistration;
  /** The latest known state of the Tor connection. */
  readonly status: SiteStatus;
  /** Resolves when Tor is connected; rejects if connecting failed. */
  ready(): Promise<void>;
  /** Subscribe to state changes; returns an unsubscribe function. */
  onStatus(cb: (status: SiteStatus) => void): () => void;
  /** Remove the Service Worker (the site goes back to plain static hosting). */
  unregister(): Promise<boolean>;
}

export async function registerTorSite(opts: RegisterOptions = {}): Promise<TorSite> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    throw new Error('tor-site: Service Workers are not available in this browser (they need https:// or localhost)');
  }
  const swUrl = new URL(opts.sw ?? 'tor-site-sw.js', document.baseURI);
  swUrl.searchParams.set('manifest', opts.manifest ?? 'tor-site.json');
  const registration = await navigator.serviceWorker.register(swUrl.href, opts.scope ? { scope: opts.scope } : undefined);

  let status: SiteStatus = { state: 'idle' };
  const listeners = new Set<(s: SiteStatus) => void>();
  const debug = opts.debug ?? debugFlag();
  navigator.serviceWorker.addEventListener('message', (event) => {
    const data = event.data as { type?: string; status?: SiteStatus; level?: string; message?: string } | null;
    if (data?.type === 'tor-site-log') {
      if (debug) console.log(`[tor-site ${data.level}]`, data.message);
      return;
    }
    if (data?.type !== 'tor-site-status' || !data.status) return;
    status = data.status;
    for (const cb of listeners) cb(status);
  });

  await navigator.serviceWorker.ready;
  await controlled();
  const active = navigator.serviceWorker.controller ?? registration.active;
  active?.postMessage({ type: 'tor-site-hello' });
  if (opts.prewarm !== false) active?.postMessage({ type: 'tor-site-warm' });

  return {
    registration,
    get status() {
      return status;
    },
    ready() {
      if (status.state === 'ready') return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const off = () => listeners.delete(cb);
        const cb = (s: SiteStatus) => {
          if (s.state === 'ready') { off(); resolve(); }
          else if (s.state === 'error') { off(); reject(new Error(s.message ?? 'Tor failed to start')); }
        };
        listeners.add(cb);
      });
    },
    onStatus(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    unregister: () => registration.unregister(),
  };
}

function debugFlag(): boolean {
  try {
    return localStorage.getItem('tor-site-debug') !== null;
  } catch {
    return false;
  }
}

/** Resolves once a Service Worker controls this page (immediately when one already does). */
function controlled(timeoutMs = 10_000): Promise<void> {
  if (navigator.serviceWorker.controller) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      navigator.serviceWorker.removeEventListener('controllerchange', done);
      reject(new Error('tor-site: the Service Worker did not take control of the page'));
    }, timeoutMs);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    navigator.serviceWorker.addEventListener('controllerchange', done, { once: true });
  });
}
