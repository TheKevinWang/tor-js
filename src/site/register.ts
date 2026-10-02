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
import { prepareSpare, servePeer } from './peerPage.js';
import { SNOWFLAKE_WEBRTC_STUN } from '../snowflake.js';

export type { SiteStatus } from './backend.js';

export interface RegisterOptions {
  /** URL of the Service Worker script. Default `tor-site-sw.js`, next to the page. */
  sw?: string;
  /** URL of the manifest, relative to the worker script. Default `tor-site.json`. */
  manifest?: string;
  /** Service Worker scope. Default: the script's directory. */
  scope?: string;
  /**
   * URL of the persistent Tor host worker. Default `tor-site-host.js`, next to
   * the page. Unused when the manifest sets `client.host` to "service-worker".
   */
  hostScript?: string;
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
  /**
   * A timeline of the Tor client's log lines and state changes, newest last, each
   * stamped with `performance.now()` (milliseconds since this page began loading).
   * Kept even when debug printing is off, so a slow start can be read afterwards:
   * `(await window.torSite).timeline`. Capped at 500 entries.
   */
  readonly timeline: readonly { t: number; kind: 'log' | 'status'; text: string }[];
  /**
   * Resolves once the Service Worker has been connected to this page's Tor host
   * (at once when no host is used, and after 5 s regardless). Requests that must
   * reach the host should wait for it, or they can be routed to a stale one.
   */
  readonly hostAttached: Promise<void>;
  /** Remove the Service Worker (the site goes back to plain static hosting). */
  unregister(): Promise<boolean>;
}

/** How often a page pings the Service Worker when Tor lives there (the browser's idle limit is ~30 s). */
const KEEPALIVE_MS = 20_000;

export async function registerTorSite(opts: RegisterOptions = {}): Promise<TorSite> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    throw new Error('tor-site: Service Workers are not available in this browser (they need https:// or localhost)');
  }
  const swUrl = new URL(opts.sw ?? 'tor-site-sw.js', document.baseURI);
  swUrl.searchParams.set('manifest', opts.manifest ?? 'tor-site.json');
  const registration = await navigator.serviceWorker.register(swUrl.href, opts.scope ? { scope: opts.scope } : undefined);

  let status: SiteStatus = { state: 'idle' };
  const timeline: { t: number; kind: 'log' | 'status'; text: string }[] = [];
  const note = (kind: 'log' | 'status', text: string) => {
    timeline.push({ t: Math.round(performance.now()), kind, text });
    if (timeline.length > 500) timeline.shift();
  };
  const listeners = new Set<(s: SiteStatus) => void>();
  const debug = opts.debug ?? debugFlag();
  navigator.serviceWorker.addEventListener('message', (event) => {
    const data = event.data as { type?: string; status?: SiteStatus; level?: string; message?: string } | null;
    if (data?.type === 'tor-site-log') {
      note('log', `${data.level} ${data.message}`);
      if (debug) console.log(`[tor-site ${data.level}]`, data.message);
      return;
    }
    if (data?.type !== 'tor-site-status' || !data.status) return;
    status = data.status;
    note('status', `${status.state}${status.where ? ` (${status.where})` : ''}${status.message ? `: ${status.message}` : ''}`);
    for (const cb of listeners) cb(status);
  });

  // Where the Tor client runs. By default in a persistent worker that the
  // Service Worker is connected to; the Service Worker itself only routes.
  // The host does not need the Service Worker to be active, so it is started
  // (and begins loading the WASM and connecting) right away, in parallel with
  // the worker installing; the attachment to the Service Worker follows.
  const manifestUrl = new URL(opts.manifest ?? 'tor-site.json', swUrl).href;
  const client = await manifestClient(manifestUrl);
  const wantHost = client.host !== 'service-worker';
  // WebRTC (the default wherever a page can host it) needs an offer from this page;
  // start preparing one now, while the WASM loads, instead of when it is asked for.
  if (wantHost && client.snowflake !== true && client.snowflake !== 'websocket') prepareSpare(SNOWFLAKE_WEBRTC_STUN);
  const host = wantHost
    ? startHost({
        // Next to the Service Worker script, not the document: a shell served for a deep link
        // such as /forum/1-welcome has a different base URL.
        script: new URL(opts.hostScript ?? 'tor-site-host.js', swUrl).href,
        name: `tor-site:${new URL(registration.scope).pathname}`,
        config: {
          manifestUrl,
          visibleOrigin: location.origin,
          scopePath: new URL(registration.scope).pathname,
        },
      })
    : null;
  if (opts.prewarm !== false && host) host.warm();

  await navigator.serviceWorker.ready;
  await controlled();
  const active = navigator.serviceWorker.controller ?? registration.active;
  active?.postMessage({ type: 'tor-site-hello' });
  if (opts.prewarm !== false && !host) active?.postMessage({ type: 'tor-site-warm' });
  // With Tor inside the Service Worker, an idle worker is stopped by the browser
  // after ~30 s and its Tor client goes with it. Any message resets that timer.
  if (!wantHost) {
    setInterval(() => navigator.serviceWorker.controller?.postMessage({ type: 'tor-site-ping' }), KEEPALIVE_MS);
  }

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
    timeline,
    hostAttached: host ? host.attached : Promise.resolve(),
  };
}

function debugFlag(): boolean {
  try {
    return localStorage.getItem('tor-site-debug') !== null;
  } catch {
    return false;
  }
}

interface HostConfig {
  manifestUrl: string;
  visibleOrigin: string;
  scopePath: string;
}

/**
 * `client.host` and `client.snowflake` from the manifest, with the defaults the
 * worker will apply when they are absent (the worker validates the file; this is
 * only to decide what to start early). Unreadable manifests count as all defaults.
 */
async function manifestClient(manifestUrl: string): Promise<{ host: string; snowflake: unknown }> {
  let c: { host?: string; snowflake?: unknown } = {};
  try {
    const res = await fetch(manifestUrl);
    c = ((await res.json()) as { client?: typeof c }).client ?? {};
  } catch {
    // keep the defaults
  }
  const host = c.host ?? 'auto';
  return { host, snowflake: c.snowflake ?? (host === 'service-worker' ? true : 'webrtc') };
}

/**
 * Start the persistent host worker (a SharedWorker, or a dedicated Worker where
 * that does not exist) and connect the Service Worker to it. A fresh
 * MessageChannel is made per attachment: one end goes to the host, the other to
 * the Service Worker, which forgets its ports whenever the browser restarts it
 * and then asks (`tor-site-need-host`) for a new one.
 */
function startHost(opts: { script: string; name: string; config: HostConfig }): { warm(): void; attached: Promise<void> } | null {
  let control: MessagePort | Worker;
  try {
    if (typeof SharedWorker !== 'undefined') {
      const shared = new SharedWorker(opts.script, { name: opts.name });
      shared.port.start();
      control = shared.port;
    } else {
      control = new Worker(opts.script, { name: opts.name });
    }
  } catch (e) {
    console.warn('[tor-site] cannot start the Tor host worker; Tor will run inside the Service Worker', e);
    return null;
  }

  // The host borrows this page's RTCPeerConnection for the Snowflake WebRTC
  // carrier (workers have none): see peerRelay.ts. Listen before anything else
  // is sent, so the first request cannot be missed.
  const onHostMessage = (event: MessageEvent) => {
    const data = event.data as { t?: string; port?: MessagePort } | null;
    if (data?.t === 'peer-request' && data.port) servePeer(data.port);
  };
  if (control instanceof MessagePort) control.onmessage = onHostMessage;
  else control.onmessage = onHostMessage;
  addEventListener('pagehide', () => control.postMessage({ t: 'bye' }));

  const attach = () => {
    const sw = navigator.serviceWorker.controller;
    if (!sw) return;
    const channel = new MessageChannel();
    control.postMessage({ t: 'attach', port: channel.port2, config: opts.config }, [channel.port2]);
    sw.postMessage({ type: 'tor-site-host', port: channel.port1 }, [channel.port1]);
  };
  // The Service Worker answers an attachment with `tor-site-host-ack`.
  const attached = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 5000);
    navigator.serviceWorker.addEventListener('message', (event) => {
      if ((event.data as { type?: string } | null)?.type === 'tor-site-host-ack') {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  attach();
  navigator.serviceWorker.addEventListener('controllerchange', attach);
  navigator.serviceWorker.addEventListener('message', (event) => {
    if ((event.data as { type?: string } | null)?.type === 'tor-site-need-host') attach();
  });
  return { warm: () => control.postMessage({ t: 'warm', config: opts.config }), attached };
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
