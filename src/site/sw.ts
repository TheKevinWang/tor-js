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
import { PortBackend } from './rpc.js';
import { injectIntoHtml, pageScriptTag, shouldInject } from './inject.js';
import { adaptForFrame } from './frameHeaders.js';
import { createClientPowAcquirer } from '../pow/clientRelay.js';
import { installManifestPow } from '../pow/manifestPow.js';
import { errorResponse, type SiteRequest, type SiteResponse } from './torHttp.js';

declare const self: ServiceWorkerGlobalScope;

const params = new URL(self.location.href).searchParams;
const manifestUrl = new URL(params.get('manifest') || 'tor-site.json', self.location.href).href;
const scopePath = new URL(self.registration.scope).pathname;
const visibleOrigin = self.location.origin;

interface Loaded {
  manifest: SiteManifest;
  router: SiteRouter;
  /** A Tor client inside this worker: used when no host is attached, or when the manifest asks for it. */
  local: LocalBackend;
  /** The `<script>` tag inserted into HTML documents served from the onion, or null when injection is off. */
  injectTag: string | null;
  /** Same, for documents shown in the shell's iframe (it tells the script it is inside the frame). */
  frameInjectTag: string | null;
  /** The static shell page, when the manifest asks for the persistent frame shell. */
  shell: { url: string } | null;
}

/** Tor hosts (persistent workers) that pages have attached, oldest first. */
const hosts: PortBackend[] = [];
let hostArrived: (() => void) | null = null;

let loaded: Loaded | null = null;
let loading: Promise<Loaded> | null = null;
let lastStatus: SiteStatus = { state: 'idle' };

function load(): Promise<Loaded> {
  if (loading) return loading;
  const attempt = (async (): Promise<Loaded> => {
    const res = await fetch(manifestUrl, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`cannot load ${manifestUrl}: HTTP ${res.status}`);
    const manifest = parseManifest(await res.json());
    const wasmUrl = new URL(manifest.client.wasmUrl ?? 'tor_js_bg.wasm', manifestUrl).href;
    setWasmUrl(wasmUrl);
    // Proof-of-work puzzles are solved for this Tor client (when `client.host` is "service-worker", it is
    // in here) by the pages this Service Worker controls: it cannot start workers, they can.
    installManifestPow(manifest, manifestUrl, wasmUrl, createClientPowAcquirer(() => self.clients.matchAll({ type: 'window' })));
    const router = new SiteRouter(manifest, visibleOrigin, scopePath);
    const local = new LocalBackend({
      manifest, manifestUrl, visibleOrigin, scopePath,
      where: 'service-worker',
      onStatus: publishStatus,
      onLog: publishLog,
    });
    const rel = (u: string | URL) => {
      const url = new URL(u, manifestUrl);
      return url.pathname + url.search;
    };
    const tagUrls = {
      script: rel(manifest.client.pageScript ?? 'tor-site.js'),
      sw: rel(self.location.href),
      manifest: rel(manifestUrl),
    };
    const inject = manifest.client.inject !== false;
    const injectTag = inject ? pageScriptTag(tagUrls) : null;
    const frameInjectTag = inject ? pageScriptTag(tagUrls, 'frame') : null;
    const shell = manifest.client.shell === 'frame'
      ? { url: new URL(manifest.client.shellPage ?? 'tor-shell.html', manifestUrl).href }
      : null;
    return { manifest, router, local, injectTag, frameInjectTag, shell };
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
    // Only sent when no host worker is used. waitUntil keeps this worker alive
    // while Tor connects; without it the browser stops an idle worker after
    // ~30 s and the connection attempt is lost.
    event.waitUntil(load().then((l) => l.local.warm()).catch(reportLoadError));
  } else if (data.type === 'tor-site-ping') {
    // Nothing to do: delivering the message is what resets the browser's idle timer.
  } else if (data.type === 'tor-site-host') {
    const port = (data as { port?: MessagePort }).port;
    if (port) attachHost(port);
    (event.source as Client | null)?.postMessage({ type: 'tor-site-host-ack' });
  }
});

function attachHost(port: MessagePort): void {
  const host: PortBackend = new PortBackend(port, {
    onStatus: publishStatus,
    onLog: publishLog,
    // It stopped answering with requests waiting (its worker was terminated, as
    // happens when the last page connected to it navigates away): forget it.
    onDead: () => {
      const i = hosts.indexOf(host);
      if (i >= 0) hosts.splice(i, 1);
      publishLog('warn', '[sw] the Tor host stopped responding and was dropped');
    },
  });
  hosts.push(host);
  // Old attachments are for hosts that may be gone; keep a few, newest last.
  while (hosts.length > 4) hosts.shift()!.close();
  hostArrived?.();
}

/** The newest attached host that answers, dropping the ones that do not. */
async function liveHost(): Promise<PortBackend | null> {
  for (let i = hosts.length - 1; i >= 0; i--) {
    const h = hosts[i];
    if (Date.now() - h.lastSeen < 10_000 || (await h.ping())) return h;
    hosts.splice(i, 1);
    h.close();
  }
  return null;
}

let warnedAboutNavigation = false;

/**
 * The WebRTC carrier cannot run in this worker (it needs a page to hold the peer
 * connection), so the host is the only backend that can serve: never fall back
 * to the client in this worker, which could only fail.
 */
const needsHost = (l: Loaded): boolean => l.manifest.client.snowflake === 'webrtc';

/** A live host, asking open pages to attach one and waiting for it, for up to `timeoutMs`; the local client only after that. */
async function waitForHost(l: Loaded, timeoutMs = 30_000): Promise<SiteBackend> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const host = await liveHost();
    if (host) return host;
    const pages = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (pages.length > 0) {
      const arrived = new Promise<void>((resolve) => (hostArrived = resolve));
      for (const p of pages) p.postMessage({ type: 'tor-site-need-host' });
      await Promise.race([arrived, new Promise((r) => setTimeout(r, 2000))]);
      hostArrived = null;
    } else {
      await new Promise((r) => setTimeout(r, 500));
    }
    if (Date.now() > deadline) return l.local; // fails with a message saying a page is needed
  }
}

/**
 * Where a Tor request is served: the persistent host when one is attached and
 * alive; else, if pages are open, ask them to attach one (this worker may have
 * just restarted and forgotten its ports); else Tor inside this worker.
 *
 * Navigations always use Tor inside this worker. A navigation unloads the page
 * that is connected to the host, and the browser terminates a worker host when
 * its last page goes away, so a response streaming from it would be cut off
 * (and the Tor client lost). Only pages that stay (fetch calls, subresources)
 * can use the host.
 */
async function pickBackend(l: Loaded, request: Request): Promise<SiteBackend> {
  if (l.manifest.client.host === 'service-worker') return l.local;
  if (needsHost(l)) return waitForHost(l);
  if (request.destination === 'document') {
    if (!warnedAboutNavigation) {
      warnedAboutNavigation = true;
      publishLog(
        'warn',
        '[sw] a page was served over Tor, so this looks like a server-rendered (multi-page) site: set "client": { "host": "service-worker" } in tor-site.json so that Tor is not started twice',
      );
    }
    return l.local;
  }
  let host = await liveHost();
  if (!host) {
    const pages = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (pages.length > 0) {
      const arrived = new Promise<void>((resolve) => (hostArrived = resolve));
      for (const p of pages) p.postMessage({ type: 'tor-site-need-host' });
      await Promise.race([arrived, new Promise((r) => setTimeout(r, 2000))]);
      hostArrived = null;
      host = await liveHost();
    }
  }
  return host ?? l.local;
}

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
    event.respondWith(serve(event, loaded));
    return;
  }

  // The worker was just (re)started and has not read the manifest yet, so the
  // route is not known. Decide asynchronously; static requests go straight on.
  event.respondWith(
    load().then(
      (l) => {
        const route = l.router.route(url);
        return route && route.kind === 'tor' ? serve(event, l) : fetch(request);
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

/**
 * With the frame shell, a top-level navigation to a Tor route is answered with
 * the shell page (fetched from the static host, as a 200 even where the static
 * host would say 404 for the path); the shell then loads the real page into its
 * iframe, which comes from Tor.
 */
async function shellResponse(shell: { url: string }): Promise<Response> {
  try {
    const res = await fetch(shell.url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return new Response(res.body, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-tor-site': 'shell' },
    });
  } catch (e) {
    return new Response(`tor-site: cannot load the shell page ${shell.url}: ${e instanceof Error ? e.message : String(e)}\n`, {
      status: 502,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
}

async function serve(event: FetchEvent, l: Loaded): Promise<Response> {
  const request = event.request;
  if (l.shell && request.mode === 'navigate' && request.destination === 'document') return shellResponse(l.shell);
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
    const path = new URL(request.url).pathname;
    request.signal.addEventListener('abort', () => publishLog('warn', `[sw] the browser aborted ${request.method} ${path}`), { once: true });
    const backend = await pickBackend(l, request);
    let response: SiteResponse;
    try {
      response = await backend.handle(siteRequest);
    } catch (e) {
      // A host that died before it answered: a safe request can simply be asked
      // of the Tor client in this worker instead.
      const safe = request.method === 'GET' || request.method === 'HEAD';
      if (backend === l.local || !safe || request.signal.aborted) throw e;
      const why = e instanceof Error ? e.message : String(e);
      if (needsHost(l)) {
        // The failed host has been dropped; ask for another live one rather than the local client.
        publishLog('warn', `[sw] ${path}: the host failed (${why}); retrying with another host`);
        response = await (await waitForHost(l)).handle(siteRequest);
      } else {
        publishLog('warn', `[sw] ${path}: the host failed (${why}); retrying with Tor in the Service Worker`);
        response = await l.local.handle(siteRequest);
      }
    }
    publishLog('debug', `[sw] ${request.method} ${path} -> ${response.status}${request.mode === 'navigate' ? ' (navigation)' : ''}`);
    const inFrame = l.shell !== null && request.destination === 'iframe';
    const tag = inFrame ? l.frameInjectTag : request.destination === 'document' ? l.injectTag : null;
    return toResponse(response, event, `${request.method} ${path}`, tag, inFrame);
  } catch (e) {
    return toResponse(errorResponse(502, `tor-site: ${e instanceof Error ? e.message : String(e)}`), event);
  }
}

function toResponse(
  r: SiteResponse,
  event: FetchEvent,
  label = '',
  injectTag: string | null = null,
  inFrame = false,
): Response {
  const headers = new Headers();
  // In the shell's iframe the document may be framed by this site only.
  for (const [k, v] of inFrame ? adaptForFrame(r.headers) : r.headers) {
    try {
      headers.append(k, v);
    } catch {
      // A header the Headers API rejects is dropped, as browsers do.
    }
  }
  // Lets a page (and the demo) tell a Tor-served response from a static one.
  headers.set('x-tor-site', 'tor');
  let body = r.body;
  if (body && injectTag && shouldInject(inFrame ? 'iframe' : 'document', headers.get('content-type') ?? undefined, inFrame)) {
    body = body.pipeThrough(injectIntoHtml(injectTag));
    headers.delete('content-length'); // the length changes
  }
  if (body) {
    // Keep the worker alive until the body has been delivered.
    let finish!: () => void;
    event.waitUntil(new Promise<void>((resolve) => (finish = resolve)));
    body = withCompletion(body, finish, label);
  }
  return new Response(body, { status: r.status, statusText: r.statusText, headers });
}

function withCompletion(body: ReadableStream<Uint8Array>, onDone: () => void, label: string): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let bytes = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          onDone();
          publishLog('debug', `[sw] ${label}: body complete, ${bytes} bytes`);
        } else {
          bytes += value.byteLength;
          controller.enqueue(value);
        }
      } catch (e) {
        controller.error(e);
        onDone();
        publishLog('warn', `[sw] ${label}: body failed after ${bytes} bytes: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    cancel(reason) {
      onDone();
      publishLog('warn', `[sw] ${label}: the browser cancelled the body after ${bytes} bytes (${String(reason)})`);
      return reader.cancel(reason);
    },
  });
}
