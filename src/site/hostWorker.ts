/**
 * The persistent Tor host: a SharedWorker (or a dedicated Worker where
 * SharedWorker is unavailable) that owns the Tor client for the site.
 *
 * Why not the Service Worker: browsers stop an idle Service Worker after about
 * half a minute, throwing away the Tor circuits and guard connection, and
 * while the client is busy on the Service Worker's thread even requests it
 * leaves to the network wait. This worker lives as long as some page of the
 * site is open, is shared by all its tabs, and never handles a fetch event.
 *
 * Pages attach the Service Worker to it: a page posts `{ t: 'attach', port,
 * config }` here and gives the other end of the same MessageChannel to the
 * Service Worker (see register.ts), which then sends it requests
 * (see rpc.ts).
 */

import { setWasmUrl } from '../wasm.js';
import { parseManifest } from './manifest.js';
import { installPowSolver } from '../pow/install.js';
import { LocalBackend, type SiteBackend, type SiteStatus } from './backend.js';
import { serveBackend } from './rpc.js';
import { acquirePeerPort, createRemotePeerFactory, type PageTarget } from './peerRelay.js';

export interface HostConfig {
  /** Absolute URL of tor-site.json. */
  manifestUrl: string;
  /** The site's origin, e.g. "https://user.github.io". */
  visibleOrigin: string;
  /** The Service Worker's scope path, e.g. "/" or "/repo/". */
  scopePath: string;
}

export type HostControl =
  | { t: 'attach'; port: MessagePort; config: HostConfig }
  | { t: 'warm'; config: HostConfig }
  | { t: 'bye' };

// `self` is a SharedWorkerGlobalScope or a DedicatedWorkerGlobalScope; the two
// differ only in how messages arrive, handled below.
const scope = self as unknown as {
  onconnect?: ((e: MessageEvent) => void) | null;
  onmessage?: ((e: MessageEvent) => void) | null;
};

let backend: Promise<LocalBackend> | null = null;
let backendKey = '';
let lastStatus: SiteStatus = { state: 'idle', where: 'host' };
const servers = new Set<ReturnType<typeof serveBackend>>();

// Pages that can host a WebRTC peer connection for the Snowflake WebRTC carrier,
// oldest first (workers have no RTCPeerConnection; see peerRelay.ts).
const pages: PageTarget[] = [];
const peerFactory = createRemotePeerFactory(() => acquirePeerPort(pages));

function getBackend(config: HostConfig): Promise<LocalBackend> {
  const key = JSON.stringify(config);
  if (backend && key === backendKey) return backend;
  // A different site configuration (another manifest): stop the old client.
  backend?.then((old) => old.close(), () => {});
  backendKey = key;
  const attempt = (async () => {
    const res = await fetch(config.manifestUrl, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`cannot load ${config.manifestUrl}: HTTP ${res.status}`);
    const manifest = parseManifest(await res.json());
    const wasmUrl = new URL(manifest.client.wasmUrl ?? 'tor_js_bg.wasm', config.manifestUrl).href;
    setWasmUrl(wasmUrl);
    // Solve proof-of-work puzzles when a service asks for effort (workers start only then).
    const pow = manifest.client.pow;
    if (pow !== false) {
      const o = typeof pow === 'object' ? pow : {};
      installPowSolver({
        workerUrl: new URL(o.workerUrl ?? 'tor-site-pow.js', config.manifestUrl).href,
        wasmUrl,
        workers: o.workers,
        maxEffort: o.maxEffort,
        minEffort: o.minEffort,
        // A SharedWorker cannot start workers: a page does it (see src/pow/powPage.ts).
        // A page that is busy (loading, decompressing a directory snapshot) can take longer than the
        // 3 s a WebRTC peer is given to answer, and one that does not answer is dropped from `pages`.
        acquirePort: (extra) => acquirePeerPort(pages, 10_000, { kind: 'pow', extra }),
      });
    }
    return new LocalBackend({
      manifest,
      manifestUrl: config.manifestUrl,
      visibleOrigin: config.visibleOrigin,
      scopePath: config.scopePath,
      where: 'host',
      peerFactory,
      onStatus(status) {
        lastStatus = status;
        for (const s of servers) s.push({ t: 'status', status });
      },
      onLog(level, message) {
        for (const s of servers) s.push({ t: 'log', level, message });
      },
    });
  })();
  backend = attempt;
  attempt.catch(() => {
    if (backend === attempt) backend = null; // a broken manifest can be fixed and retried
  });
  return attempt;
}

function control(msg: HostControl): void {
  if (msg.t === 'attach') {
    // The backend is created on first use so that attaching costs nothing.
    const lazy: SiteBackend = {
      handle: async (req) => (await getBackend(msg.config)).handle(req),
      warm: async () => {
        try {
          await (await getBackend(msg.config)).warm();
        } catch {
          // reported through the status channel by the failed attempt
        }
      },
    };
    const server = serveBackend(msg.port, lazy);
    servers.add(server);
    server.push({ t: 'status', status: lastStatus });
  } else if (msg.t === 'warm') {
    void getBackend(msg.config).then((b) => b.warm()).catch(() => {});
  }
}

if ('onconnect' in scope) {
  // SharedWorker: every page connects with its own port.
  scope.onconnect = (event) => {
    const port = event.ports[0];
    const target: PageTarget = { post: (msg, transfer) => port.postMessage(msg, transfer) };
    pages.push(target);
    port.onmessage = (e) => {
      const msg = e.data as HostControl;
      if (msg.t === 'bye') {
        // The page is closing: do not wait for it when a peer is needed.
        const i = pages.indexOf(target);
        if (i >= 0) pages.splice(i, 1);
      } else {
        control(msg);
      }
    };
    port.start();
  };
} else {
  // Dedicated Worker: the one page that started it.
  pages.push({ post: (msg, transfer) => (self as unknown as Worker).postMessage(msg, transfer) });
  scope.onmessage = (e) => control(e.data as HostControl);
}
