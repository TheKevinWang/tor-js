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
import { LocalBackend, type SiteBackend, type SiteStatus } from './backend.js';
import { serveBackend } from './rpc.js';

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
  | { t: 'warm'; config: HostConfig };

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

function getBackend(config: HostConfig): Promise<LocalBackend> {
  const key = JSON.stringify(config);
  if (backend && key === backendKey) return backend;
  backendKey = key;
  const attempt = (async () => {
    const res = await fetch(config.manifestUrl, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`cannot load ${config.manifestUrl}: HTTP ${res.status}`);
    const manifest = parseManifest(await res.json());
    setWasmUrl(new URL(manifest.client.wasmUrl ?? 'tor_js_bg.wasm', config.manifestUrl).href);
    return new LocalBackend({
      manifest,
      manifestUrl: config.manifestUrl,
      visibleOrigin: config.visibleOrigin,
      scopePath: config.scopePath,
      where: 'host',
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
    port.onmessage = (e) => control(e.data as HostControl);
    port.start();
  };
} else {
  scope.onmessage = (e) => control(e.data as HostControl);
}
