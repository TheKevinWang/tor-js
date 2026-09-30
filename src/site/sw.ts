/**
 * The site adapter's Service Worker.
 *
 * Registered by `registerTorSite()` (or the `tor-site.js` script tag). It
 * reads the site manifest, and from then on answers every request the
 * manifest sends to Tor by fetching it from the onion service; every other
 * request is left alone, so the browser (and its HTTP cache) talks to the
 * static host exactly as if this worker did not exist.
 *
 * Failing closed: a request routed to Tor is only ever answered from Tor. If
 * Tor is unavailable the page gets a 502 that says so, never a fallback fetch.
 */

import { setWasmUrl } from '../wasm.js';
import { parseManifest, type SiteManifest } from './manifest.js';
import { SiteRouter } from './router.js';
import { LocalBackend, type SiteBackend, type SiteStatus } from './backend.js';
import { errorResponse, type SiteRequest, type SiteResponse } from './torHttp.js';

declare const self: ServiceWorkerGlobalScope;

const params = new URL(self.location.href).searchParams;
const manifestUrl = new URL(params.get('manifest') || 'tor-site.json', self.location.href).href;
const scopePath = new URL(self.registration.scope).pathname;
const visibleOrigin = self.location.origin;

interface Loaded {
  manifest: SiteManifest;
  router: SiteRouter;
  backend: SiteBackend;
}

let loaded: Loaded | null = null;
let loading: Promise<Loaded> | null = null;
let lastStatus: SiteStatus = { state: 'idle' };

function load(): Promise<Loaded> {
  if (loading) return loading;
  const attempt = (async (): Promise<Loaded> => {
    const res = await fetch(manifestUrl, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`cannot load ${manifestUrl}: HTTP ${res.status}`);
    const manifest = parseManifest(await res.json());
    setWasmUrl(new URL(manifest.client.wasmUrl ?? 'tor_js_bg.wasm', manifestUrl).href);
    const router = new SiteRouter(manifest, visibleOrigin, scopePath);
    const backend = new LocalBackend({
      manifest, manifestUrl, visibleOrigin, scopePath,
      where: 'service-worker',
      onStatus: publishStatus,
      onLog: publishLog,
    });
    return { manifest, router, backend };
  })();
  loading = attempt.then(
    (v) => (loaded = v),
    (e) => {
      loading = null; // a broken manifest can be fixed and picked up on the next request
      throw e;
    },
  );
  return loading;
}

function publishLog(level: string, message: string): void {
  self.clients.matchAll({ includeUncontrolled: true, type: 'window' }).then((all) => {
    for (const c of all) c.postMessage({ type: 'tor-site-log', level, message });
  });
}

function publishStatus(status: SiteStatus): void {
  lastStatus = status;
  self.clients.matchAll({ includeUncontrolled: true, type: 'window' }).then((all) => {
    for (const c of all) c.postMessage({ type: 'tor-site-status', status });
  });
}

// --- lifecycle -------------------------------------------------------------

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
  const data = event.data as { type?: string } | null;
  if (!data) return;
  if (data.type === 'tor-site-hello') {
    (event.source as Client | null)?.postMessage({ type: 'tor-site-status', status: lastStatus });
  } else if (data.type === 'tor-site-warm') {
    // waitUntil keeps the worker alive while Tor connects; without it the browser
    // stops an idle worker after ~30 s and the connection attempt is lost.
    event.waitUntil(load().then((l) => l.backend.warm()).catch(reportLoadError));
  }
});

function reportLoadError(e: unknown): void {
  const message = e instanceof Error ? e.message : String(e);
  console.error('[tor-site]', message);
  publishStatus({ state: 'error', message, where: 'service-worker' });
}

// --- fetch -----------------------------------------------------------------

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  // Only the site's own origin and onion hosts can ever be routed to Tor.
  if (url.origin !== self.location.origin && !url.hostname.endsWith('.onion')) return;

  if (loaded) {
    const route = loaded.router.route(url);
    if (!route || route.kind !== 'tor') return; // static: the browser handles it
    event.respondWith(serve(event, loaded.backend));
    return;
  }

  // The worker was just (re)started and has not read the manifest yet, so the
  // route is not known. Decide asynchronously; static requests go straight on.
  event.respondWith(
    load().then(
      (l) => {
        const route = l.router.route(url);
        return route && route.kind === 'tor' ? serve(event, l.backend) : fetch(request);
      },
      (e) => {
        reportLoadError(e);
        // Without a manifest nothing is known to be private, so behave as a
        // plain static site rather than break every page.
        return fetch(request);
      },
    ),
  );
});

async function serve(event: FetchEvent, backend: SiteBackend): Promise<Response> {
  const request = event.request;
  try {
    const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
    const siteRequest: SiteRequest = {
      url: request.url,
      method: request.method,
      headers: [...request.headers.entries()],
      body: hasBody ? new Uint8Array(await request.arrayBuffer()) : null,
      redirect: request.redirect,
      signal: request.signal,
    };
    const response = await backend.handle(siteRequest);
    return toResponse(response, event);
  } catch (e) {
    return toResponse(errorResponse(502, `tor-site: ${e instanceof Error ? e.message : String(e)}`), event);
  }
}

function toResponse(r: SiteResponse, event: FetchEvent): Response {
  const headers = new Headers();
  for (const [k, v] of r.headers) {
    try {
      headers.append(k, v);
    } catch {
      // A header the Headers API rejects is dropped, as browsers do.
    }
  }
  // Lets a page (and the demo) tell a Tor-served response from a static one.
  headers.set('x-tor-site', 'tor');
  let body = r.body;
  if (body) {
    // Keep the worker alive until the body has been delivered.
    let finish!: () => void;
    event.waitUntil(new Promise<void>((resolve) => (finish = resolve)));
    body = withCompletion(body, finish);
  }
  return new Response(body, { status: r.status, statusText: r.statusText, headers });
}

function withCompletion(body: ReadableStream<Uint8Array>, onDone: () => void): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          onDone();
        } else {
          controller.enqueue(value);
        }
      } catch (e) {
        controller.error(e);
        onDone();
      }
    },
    cancel(reason) {
      onDone();
      return reader.cancel(reason);
    },
  });
}
