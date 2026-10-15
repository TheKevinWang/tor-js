# tor-js

Make HTTPS requests through Tor from JavaScript. Works in browsers and Node.js.

Uses [Arti](https://gitlab.torproject.org/tpo/core/arti) (the Tor Project's Rust implementation) compiled to WebAssembly.

**[Live Demo](https://ethereum.github.io/tor-js/demo.html)**

## Status

[Experimental](https://github.com/ethereum/tor-js/issues/6).

It is your responsibilty to decide whether tor-js meets your security requirements. This software is provided for free and without warranty, per the MIT license.

Please reach out ([on github](https://github.com/ethereum/tor-js/issues/6) or otherwise) if you'd like to see more security validation for tor-js.

## Quick start

```
npm install tor-js
```

```javascript
import { TorClient } from 'tor-js';

const client = new TorClient({
  // gateway: '198.51.100.7:12298:uEiAxk...9Qw',

  // (A gateway's KPS address, "ip:port:certhash" — printed by
  // the gateway at startup. In NodeJS you can leave this
  // commented, but browsers don't have raw TCP and so require
  // help to connect to the tor network: a gateway, or
  // `snowflake: true` to use Tor's Snowflake bridge with no
  // server of your own. See Gateway and Snowflake below.)
});

const response = await client.fetch('https://check.torproject.org/api/ip');
console.log(await response.json()); // { IsTor: true, IP: "..." }

client.close();
```

## Entry points

The package offers three ways to load the WASM binary. All export the same API.

| Import | WASM loading | Size (gzip) | Best for |
|---|---|---|---|
| `tor-js` | Fetched from CDN, cached locally | 44 kB | Production web apps |
| `tor-js/wasm-base64` | Embedded in the JS bundle | 2.8 MB | Single-file deploys |
| `tor-js/wasm-file` | Loaded from `tor_js_bg.wasm` next to the module | 43 kB + 2.0 MB | Self-hosted, server-side |
| `tor-js/host` | Like `tor-js`, for the build that can host an onion service | 45 kB | Pages that host an onion service |
| `tor-js/host/wasm-base64` | Like `tor-js/wasm-base64`, host build | 3.2 MB | Single-file deploys that host |
| `tor-js/host/wasm-file` | Loaded from `tor_js_host_bg.wasm` next to the module | 44 kB + 2.4 MB | Self-hosted or server-side that host |

Each also has a `/singleton` variant (see [Singleton](#singleton) below).

The three `tor-js/host...` imports are the same API from a second WASM that can also **host** an onion service ([below](#hosting-an-onion-service)). It is about 330 kB (gzip) larger, so use `tor-js` unless you host: the default WASM carries none of the hosting code. The host imports have no `/singleton` variant.

## API

### `new TorClient(options)`

Creates a Tor client and begins bootstrapping immediately.

```typescript
type TorClientOptions = {
  gateway?: string | string[];         // Gateway KPS address(es) "ip:port:certhash" (required in browsers, optional in Node.js/Deno)
  log?: Log;                           // Logger instance (default: silent)
  storage?: TorStorage;                // Persistent storage (default: auto-detected)
  logLevel?: LogLevel;                 // 'trace' | 'debug' | 'info' | 'warn' | 'error'
  socketProvider?: ArtiSocketProvider; // Custom transport (overrides `gateway`)
  snowflake?: boolean | 'websocket' | 'webrtc'; // Reach Tor via Snowflake, no gateway (see below)
  bridges?: string[];                  // Bridge lines to use as the only guards
  bootstrapUrl?: string;               // Directory snapshot (bootstrap.zip.zst) to start from
  pow?: false | { workers?: number; maxEffort?: number; minEffort?: number; workerUrl?: string }; // Pay proof of work when a service asks (default: on; see below)
};
```

The gateway is dialed over [KPS](https://ethereum.github.io/kps/) (WebRTC in browsers; QUIC in Node.js via the optional `@kpstreams/quic-client` package) and tunnels relay connections with HTTP `CONNECT`. In Node.js/Deno, connections go via direct TCP and the gateway is only used for fast bootstrap (optional).

Pass several gateways for redundancy:

```javascript
new TorClient({ gateway: ['198.51.100.7:12298:uEiAxk…9Qw', '203.0.113.4:12298:uEiBz…7Kw'] });
```

The list is an **unordered set** — position implies no priority. Each client shuffles it and prefers one gateway, so independent clients spread across your fleet rather than all choosing the first. Under concurrent load traffic spreads across a small preferred set, favouring whichever gateway is carrying the least, and a gateway that fails is cooled off with exponential backoff and re-admitted once it recovers.

### `client.fetch(url, init?)`

Make an HTTP request through Tor. Returns a standard `Response` object.

Waits for the client to be fully ready before sending the request.

```typescript
const res = await client.fetch('https://example.com', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ key: 'value' }),
  signal: AbortSignal.timeout(30_000),
});
```

```typescript
type FetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array | ArrayBuffer | ReadableStream<Uint8Array>;
  signal?: AbortSignal;
};
```

Response bodies stream: `res.body` is a `ReadableStream` you can consume as it arrives, so a large download needn't be buffered. A body that ends early — fewer bytes than `Content-Length`, or a chunked body without its terminating chunk — errors the stream rather than completing short.

Request bodies stream too. A `ReadableStream` body is sent as it's produced, using `Transfer-Encoding: chunked` — so an upload of unknown or unbounded size never has to fit in memory:

```javascript
await client.fetch('https://example.com/upload', {
  method: 'POST',
  body: fileOrStream,   // any ReadableStream<Uint8Array>
});
```

Bodies of known size (`string`, `Uint8Array`, `ArrayBuffer`) are sent with `Content-Length` instead.

### `client.ready()`

Wait for the client to be ready for traffic (guard connected, usable consensus, sufficient microdescs). Called automatically by `fetch()`, but useful to call early if you want to measure bootstrap time or show a loading state.

```typescript
const client = new TorClient({ ... });
await client.ready();
console.log('Bootstrap complete');
```

### `client.setLogLevel(level)`

Change the log level at runtime. Accepts `'trace'`, `'debug'`, `'info'`, `'warn'`, or `'error'`.

### `client.close()`

Close the client and release resources. Also available as `Symbol.dispose` for use with `using`:

```typescript
{
  using client = new TorClient({ ... });
  await client.fetch('https://example.com');
} // automatically closed
```

### Paying for priority (`pow`)

A busy onion service asks its visitors to prove they did some computation (proof of work) and serves the ones who did the most first. By default a `TorClient` pays when a service asks, with nothing to set up: when it is created in a page or in Node it installs a solver that runs the work on worker threads (Web Workers in a page, `worker_threads` in Node), started only when a puzzle comes. Against an idle service nothing is paid. Where workers cannot be started (a SharedWorker, a Service Worker) it installs nothing and the client connects without a solution, served after those who paid, as before.

```javascript
new TorClient({ snowflake: true, pow: { maxEffort: 500 } });  // pay at most 500
new TorClient({ snowflake: true, pow: { minEffort: 8 } });    // always pay at least 8, to go ahead of the queue
new TorClient({ snowflake: true, pow: false });               // never pay
```

`maxEffort` is the most it will pay (default 2000, about four minutes of one core, divided among the workers), `minEffort` the least whenever the service uses proof of work (default 0), `workers` how many per puzzle (default one less than the core count, at most 8), `workerUrl` where the worker script is (default `pow-worker.js` in a page, or `pow-node-worker.js` in Node, next to the module; the package ships both. A dev server or bundler that does not serve the package's own files needs `workerUrl` pointing at a served copy of `pow-worker.js`). The solver is shared by every client in the same page or process, so the first client's settings apply, and it never replaces a solver that is already installed (the static-site adapter's, or your own function at `globalThis.__torJsPowSolve`). It is removed when the last client that asked for it closes.

## Hosting an onion service

A page or a Node process can be an onion service, not only visit one: a website at a `.onion` address with no server behind it. An onion service never accepts inbound connections (it dials out to Tor relays, so it works behind any firewall and inside a browser tab). Visitors do not learn the host's network address and the host does not learn theirs. This makes anonymous browser-to-browser communication possible: a private file drop, a chat, an API that lives in a tab.

Hosting is a separate build of the WASM, so that pages that only visit onion services do not pay for it. Import from `tor-js/host` (or `tor-js/host/wasm-file`, `tor-js/host/wasm-base64`); calling `listen()` or `serve()` on the default `tor-js` build throws a `HostingUnavailableError` that says so.

```javascript
import { TorClient } from 'tor-js/host';

const client = new TorClient({ snowflake: true });

const service = await client.serve(async (request) => {
  const { pathname } = new URL(request.url);
  return new Response(`hello ${pathname}`);
});

console.log(`http://${service.onion}/`); // visit it with any tor-js client or Tor Browser
// ...
service.close(); // take it offline
```

`client.serve(handler, options?)` answers HTTP requests the way a `fetch` handler does: it gets a standard `Request` and returns a `Response`. Plain `http://` is right for an onion address: the connection is already encrypted end to end. Visitors are other tor-js clients (`client.fetch('http://<address>/')`) or Tor Browser. The returned object has `onion`, `identity`, `close()` and `done` (a promise that resolves after `close()`).

`client.listen(options?)` gives raw byte streams instead of HTTP, for protocols of your own: `await listener.accept()` (or `for await (const connection of listener)`) returns connections with `read()` (a `Uint8Array`, or `null` at the end), `write(chunk)` and `close()`. Always `close()` a connection when done; it releases it, and an open one counts against `maxConnections`.

**Identity.** The address comes from a secret 32-byte key. `TorClient.generateIdentity()` makes one, and `client.serve(handler, { identity })` hosts at the same address every time. Keep the bytes where your page keeps secrets (IndexedDB, a file); anyone who has them can host as you, and losing them retires the address. Without `identity`, a fresh one is made and returned as `service.identity`. `await TorClient.onionAddress(identity)` gives the address without going online.

**Options** (both methods): `identity`, `ports` (default `[80]`; a visitor asking for another is refused), `maxConnections` (default 32; more are refused), `proofOfWork` (below). `serve` also takes `maxHeadBytes` (16 KiB), `maxBodyBytes` (1 MiB), `headTimeoutMs` (30 s) and `bodyTimeoutMs` (60 s): the server is small and strict, answers one request per connection, and rejects ambiguous framing. In a browser, `request.headers` lacks the names browsers treat as forbidden (`Host`, `Cookie`, `Content-Length`, ...); the URL carries the host.

**Proof of work** is a defence against floods. It is on by default; `proofOfWork: false` turns it off. The service publishes a puzzle in its descriptor. While it is idle it asks visitors for no effort and they send no solution. When requests arrive faster than it serves them, it raises the effort it asks for (re-evaluated every five minutes), verifies the solutions it receives, and serves the highest effort first. A visitor that pays nothing is served after those that did, and when the queue is full (`proofOfWork: { queueDepth }`, default 256) the lowest effort is dropped. A visitor that cannot solve still connects while the service is not busy. `service.pow` reports `{ enabled, verified, rejected, enqueued, dropped, queueLength, suggestedEffort, maxEffortSeen }`: read it again for fresh numbers; after `close()` it is the final reading. A visiting tor-js client pays by default (see [Paying for priority](#paying-for-priority-pow)).

**Limits you should know.**

- A service is reachable only while it runs. Closing the tab takes it offline, and a background tab can be throttled by the browser. After `listen()` or `serve()` resolves it can take from a few seconds to a few minutes before visitors can reach it (measured: 9 to 48 seconds); a visitor should retry.
- Everything except the identity is kept in memory: a restarted host picks new introduction points (the relays visitors meet it through), so a visitor holding an old copy of its published details may fail until it fetches the new one.
- Do not host the same identity from two places at once; the last one to publish wins. (The demo page uses a Web Lock to stop two tabs of one browser.)
- Verifying proof of work runs on the host's main thread (WebAssembly has one thread): each check takes some milliseconds, so a flood of bad solutions costs the page that much each. The queue and `maxConnections` limits bound what is held, but a determined flood can still slow the tab.
- Like a client, a host's connection to the Tor network is visible to whoever carries it (the Snowflake proxy and bridge, or your gateway).

Try it at `website/host.html` (`npm run website`): open it in two tabs, host in one, visit from the other. Internals and the arti patch that makes this possible are described in `crates/patches/tor-hsservice/PATCH.md`.

### Hosting from a worker

`client.serve()` runs the service in the page that called it: reload the page and the service is gone. `startHostWorker()` runs the Tor client, the service and your handler in a SharedWorker instead, so that every tab of your site shares one service (one address, one set of Tor circuits) and a reload of one tab does not disturb it while another tab is open.

```javascript
import { startHostWorker } from 'tor-js/host';

const service = await startHostWorker({
  handlerUrl: '/handler.js',        // a module: export default (request) => new Response('hello')
  identity,                         // 32 bytes you keep; omit for a fresh one (service.identity)
  onStatus: (s) => console.log(s.state, s.pow),
});
console.log(`http://${service.onion}/`, service.shared);
// service.stop() ends it for every tab; service.detach() only leaves this one
```

The handler is a module the worker imports (it cannot be a function of your page, because the page can go away while the service goes on): its default export takes a `Request` and returns a `Response`, and it has no `window` or DOM. Tabs that call `startHostWorker` with the same identity connect to the same worker; the later ones find the service already running and are online at once. Pages report `{ state: "starting" | "online" | "closed" | "error", onion, pow, attached }` through `onStatus`/`service.status`. The worker script is `host-worker.js`, shipped next to the package (`tor-js/host-worker.js`); a dev server or bundler that does not serve the package's files needs `workerUrl`. Options besides those above: `wasmUrl` (default: the file this page loaded, or its bytes when it has no URL), `ports`, `maxConnections`, `proofOfWork`, `bootstrapUrl`, `keepAliveMs`. The worker uses the Snowflake WebSocket carrier (workers have no `RTCPeerConnection`), and `startHostWorker` adds about 67 kB of JavaScript in `host-worker.js`, loaded only when you call it.

**What it does not do.** A SharedWorker lasts only while some tab of the origin is open: close every tab and the service is gone, and so is a reload of the *only* tab (measured in Chromium 152: the worker is destroyed with its last page, and the service starts again in about ten seconds under the same address; visitors that hold its old details can take minutes to reach it, see the limits above). It survives reloads and navigations when another tab of the site is open. Where `SharedWorker` does not exist, `startHostWorker` uses a dedicated worker, which belongs to its page (`service.shared` is `false`). Whether a browser slows a hidden tab's service is not settled here: in the desktop app's Chromium a hidden page's service answered every probe for twelve minutes, but that browser does not throttle background timers (`test/hs-probe.mjs` measures it in one that does).

## Gateway

Browsers can't open raw TCP sockets, so to reach Tor relays from a browser you connect through a **gateway** — a small server that proxies relay connections and serves a fast-bootstrap snapshot of the Tor directory. (In Node.js/Deno tor-js opens TCP directly, so a gateway is optional there — used only for fast bootstrap.)

The client dials the gateway by its **KPS address**, `ip:port:certhash` (printed by the gateway at startup), over [KPS](https://ethereum.github.io/kps/) — WebRTC in browsers, QUIC in Node.js. Each Tor relay connection is an HTTP `CONNECT` tunnel on its own KPS stream; fast bootstrap is a zstd-compressed directory snapshot fetched over the same connection. The full wire protocol is specified in [PROTOCOL.md](PROTOCOL.md).

The gateway lives in this repo at [`crates/tor-js-gateway/`](crates/tor-js-gateway/) — see [its README](crates/tor-js-gateway/README.md) to build and run your own. The [live demo](https://ethereum.github.io/tor-js/demo.html) uses a public gateway that is for demonstration only (limited capacity, may disappear at any time); host your own for anything real.

## Snowflake (no gateway)

A page can also reach Tor with no gateway at all, through Tor Project's
[Snowflake](https://snowflake.torproject.org/) bridge. A static site (GitHub
Pages, say) is then all you need — including for `.onion` services:

```javascript
const client = new TorClient({ snowflake: true });
const res = await client.fetch('http://duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion/');
// 301 to the https:// onion — tor-js's fetch does not follow redirects.
```

The Snowflake transport (Turbo Tunnel framing, KCP, smux) runs inside the WASM
module, and arti uses the Snowflake bridge as its only guard, verifying its
fingerprint in the Tor handshake. Two carriers:

- `snowflake: true` (or `'websocket'`): a WebSocket straight to the Snowflake
  server. Fast (a cold start is typically under 10s) and works in Node too. The
  Snowflake server sees your IP address, as any Tor guard does.
- `snowflake: 'webrtc'`: the standard Snowflake path — the Snowflake broker
  matches you with a volunteer proxy, reached over WebRTC. Harder to block;
  slower and more variable to start (broker retries, NAT), and needs
  `RTCPeerConnection` (a window).

WebTunnel bridges cannot be used from a page: their server answers the HTTP
upgrade without `Sec-WebSocket-Accept` and then carries raw bytes, which the
browser `WebSocket` API rejects.

A first visit downloads the Tor directory through the bridge. To skip that,
host a snapshot next to the page and pass `bootstrapUrl` — tor-js verifies it
like any directory document, so the host need not be trusted:

```
node scripts/make-bootstrap.mjs site/bootstrap.zip.zst   # from the directory authorities
```

```javascript
new TorClient({ snowflake: true, bootstrapUrl: new URL('bootstrap.zip.zst', location.href).href });
```

Regenerate it regularly (the consensus in it is valid for 3 hours; an older
snapshot still saves the microdescriptor download). A returning visitor uses it
too: when the consensus saved in their browser is no longer fresh and the
snapshot holds a newer one, the snapshot replaces it, so a visit after hours away
does not wait for a consensus download over the bridge. See
[`website/onion.html`](website/onion.html) for a complete page and
[`examples/tor-fetch-onion-snowflake.js`](examples/tor-fetch-onion-snowflake.js)
for Node.

`bridges` takes Tor bridge lines directly (without the `Bridge` keyword):
`snowflake` lines use the built-in transport (`ws=` for the WebSocket carrier,
or `url=`/`ice=`/`fingerprint=` for WebRTC), and plain `ip:port fingerprint`
lines are dialed like relays.

## Static sites with an onion backend

Snowflake lets a static page reach Tor; the **site adapter** lets an existing
site do it without being rewritten. Add a Service Worker and a manifest that
says which paths are public files (still served by the static host) and which
belong to a backend that is only reachable as an onion service. The site keeps
using ordinary URLs (`fetch('/api/messages')`, `<form action="/login"
method="POST">`, `<a href="/profile">`); the browser still does the HTML, CSS
and JavaScript; only the requests the manifest routes to Tor travel over Tor.

To keep the machine behind the onion service from being found or flooded, without
slowing visits, see [SERVER-HARDENING.md](SERVER-HARDENING.md); `node
scripts/audit-onion-origin.mjs` checks a running origin and its torrc.

```
your-site/
  index.html, app.js, style.css, ...     # unchanged
  tor-site.json                          # the manifest (below)
  tor-site-sw.js  tor-site-host.js  tor-site.js   # from node_modules/tor-js/dist/site/
  tor_js_bg.wasm                         # from node_modules/tor-js/dist/
```

```html
<script src="tor-site.js" data-sw="tor-site-sw.js" data-manifest="tor-site.json"></script>
```

Connecting takes seconds to a minute or more, and the script tag's `data-loading`
decides what visitors see meanwhile:

- **Not set (default):** nothing. Tor connects in the background from the moment the
  page loads.
- **`data-loading="transparent"`:** connect at once, with no loading screen, for a page that
  can keep the visitor busy first. A blog with comments is the example: the post
  loads from the static host and is read while Tor connects, so by the time the reader
  posts a comment the private connection is already up and the request goes straight
  through (about a second, against a minute or more cold in testing). A visitor who is
  quicker than Tor is not left with a hung form: a small notice says that the request is
  waiting for the private connection and will go through as soon as it is ready, and the
  request is then sent. Code can wait for it too (`await (await window.torSite).ready()`),
  for instance to enable a "Post" button. It overrides `data-prewarm="false"`.
- **`data-loading="screen"` (or `"true"`):** a loading screen that covers the page until Tor
  is connected, for a page that is useless without the server. Visitors see "Connecting
  securely…", a route drawn from them to the server that fills as the real steps
  complete, a plain-language step ("Starting the private network", "Finding a route",
  "Connecting to the server"), a note that the first connection takes longer, and a
  "Powered by Tor ⓘ" line explaining why. "Connection details" shows the same thing in
  Tor's terms for technical visitors (browser, Snowflake transport, Tor network, circuit,
  onion service, what goes through Tor and what loads directly, and the Tor client's log).
  Failures say where it stopped ("the private network is connected, but the server isn't
  responding") and offer "Try again".

With either of the last two, a small "Private connection" badge stays in the corner
(`data-badge="false"` hides it); it says only that requests to the server go through Tor,
not that the visitor is anonymous. A frame-shell site (below) always shows the loading
screen, until the site's first page has loaded, because its own first page comes over Tor.
Code can follow the progress with `site.progress` and `site.onProgress(cb)`, and see requests
held for Tor with `site.waiting` and `site.onWaiting(cb)`.

```json
{
  "version": 1,
  "onion": "https://abc...xyz.onion",
  "tor": ["/api/**", "/login", "/logout", "/account/**"],
  "static": ["/api/docs.json"],
  "client": { "snowflake": true, "wasmUrl": "tor_js_bg.wasm", "bootstrapUrl": "bootstrap.zip.zst" }
}
```

`static` patterns are checked first, then `tor` patterns; a path that matches
neither is static. `*` matches within a path segment and `**` across segments
(`/api/**` also matches `/api`). Patterns are relative to the Service Worker's
scope, so a project page at `https://user.github.io/repo/` writes `/api/**` for
`/repo/api/...`. A `tor` entry can also be `{ "match": "/duck/**", "strip":
"/duck", "onion": "https://other.onion" }` to mount a backend under a prefix or
use a different onion service for some paths. Use the onion's `https://` origin
if it redirects `http` to `https` (many do). Manifest errors name the field.

Pages that call a Tor path on their very first visit should wait for the worker
to take control, which happens once per browser: `const site = await
window.torSite;` (or `registerTorSite()` from `tor-js/site`). `site.ready()`
resolves when Tor is connected and `site.onStatus(cb)` reports
`bootstrapping`/`ready`/`error`, so a page can show progress. Set
`localStorage['tor-site-debug'] = '1'` to print the Tor client's log to the
page console. See [`website/public/site-demo/`](website/public/site-demo/) for
a complete site (`node scripts/stage-site-demo.mjs` after a build, then serve
that directory with any static file server).

What the adapter does for you:

- **Routing fails closed.** A request the manifest sends to Tor is only ever
  answered from Tor; if Tor is down the page gets a `502` saying so, never a
  fetch over the clear web. Only the hosts named in the manifest are ever
  contacted, and only `.onion` names are accepted. Browsers restart Service
  Workers all the time, so the worker keeps the last manifest it validated
  (Cache Storage) and routes by it whenever a fresh `tor-site.json` cannot be
  fetched or does not parse; with no valid copy at all it answers every request
  locally with a `503` rather than guess, and a worker that cannot get a valid
  manifest when it installs does not install (`registerTorSite()` rejects). It
  also tells Chromium, through the Static Routing API, to send its whole scope
  to the worker, which stops Chromium from sending a navigation to the static
  host in parallel while it starts a stopped worker. To retire the adapter,
  deploy a `tor-site-sw.js` that unregisters itself: browsers fetch Service
  Worker updates straight from the network.
- **Forms from other sites are refused.** A state-changing request (anything
  but GET, HEAD and OPTIONS) is sent to the onion service only when one of the
  site's own pages made it; a form another site submits into a Tor route gets a
  `403` from the worker and never leaves the browser. (Cross-site form posts into
  Tor routes, such as OAuth `form_post` callbacks, are therefore not supported.)
- **Cookies.** `Set-Cookie` is a forbidden response header for page scripts, and
  a browser would file it under the wrong site, so the adapter keeps its own jar
  (`Path`, `Domain`, `Expires`/`Max-Age`, `Secure`, `HttpOnly`, `SameSite`),
  persisted in IndexedDB, and never sends the site's own cookies to the backend.
  The jar cannot be read through `document.cookie`. `credentials: "omit"` sends
  and keeps no cookies, and `SameSite=Strict` cookies go only with requests the
  site's own pages made (not with a link from another site, a bookmark or a typed
  URL, which the worker cannot tell apart).
- **Redirects** are handed back to the browser with `Location` rewritten to the
  site's own URL, so the address bar and every hop go through the same routing.
- **Headers.** On requests the site's own pages make, `Origin`/`Referer` name
  the onion (so CSRF checks pass); on any other request they are not sent at
  all, so a foreign origin is never relabelled as the onion's. `Accept-
  Encoding: gzip` is decoded, and headers that would act on the *static* site
  (`Strict-Transport-Security`, `Clear-Site-Data`, `Alt-Svc`) are dropped. Every
  visitor sends the same Tor Browser-style `User-Agent` rather than the real
  browser's.
- **Where Tor runs depends on the kind of site.** For a single-page app (the
  page never unloads) the default puts the Tor client in a persistent worker (a
  SharedWorker, one per site, shared by all tabs; a dedicated Worker where
  SharedWorker does not exist), because browsers stop an idle Service Worker
  after ~30 s and its thread stalls while the client works. A **server-rendered,
  multi-page site must set `"client": { "host": "service-worker" }`**: every
  click is a navigation, and a SharedWorker is terminated when the last page
  connected to it navigates away, taking the Tor client with it. In that mode
  the adapter keeps the Service Worker alive for you: it inserts its small page
  script into every HTML page served from the onion (`"client": { "inject":
  false }` turns that off), and the script pings the worker every 20 s. Even in
  the default mode, a navigation served over Tor always uses the Tor client in
  the Service Worker, for the same reason, and the adapter logs a warning
  suggesting `"service-worker"` (or use the frame shell below, which keeps WebRTC
  available). If a worker host dies with requests in flight
  they fail after ~20 s of silence, and safe (GET/HEAD) ones are retried on the
  Service Worker's client.
- **Project pages.** A site at `https://user.github.io/repo/` has the Service
  Worker scope `/repo/`, and patterns are relative to it. Tell the backend its
  public prefix (Flask `SCRIPT_NAME`, Django `FORCE_SCRIPT_NAME`, a base-URL
  setting) so the links and redirects it generates stay under `/repo/`, and set
  `"backendKnowsBase": true` in the manifest so such redirects are not prefixed
  again. A backend that is unaware of the prefix needs neither (the adapter
  prefixes its redirects), but then its absolute links in HTML point outside the
  scope.

Limits, all inherited from what a Service Worker can see: WebSockets and
server-sent events to the backend are not supported; absolute URLs the
backend writes into its HTML (`http://abc.onion/x`) are not rewritten, so serve
relative URLs (or mount the backend at the site root); a document the onion
serves brings the onion's own `Content-Security-Policy` with it; only
`fetch`-style requests, navigations and form posts under the Service Worker's
scope are seen (cross-origin iframes and third-party pages are not); uploads are
buffered in memory. The onion address is public in the manifest: it is a
routing table, not a secret. Anyone who can run script on the static origin can
use the adapter to reach the backend, exactly as they could use its cookies.

### The default carrier, and WebRTC for multi-page sites (the frame shell)

Unless the manifest says otherwise (`"client": { "snowflake": ... }`), the adapter
now uses the **WebRTC** Snowflake carrier (a volunteer proxy, hard to block)
wherever a page can hold the peer connection, which is every placement except
`"host": "service-worker"`; there the default is the WebSocket carrier.
`"snowflake": "websocket"` always opts out. The choice is made from the manifest,
never switched after a failure. WebRTC starts slower and more variably than the
WebSocket carrier (broker match and ICE; 15 s to over a minute depending on the
proxy you get), and it needs a page of the site to stay open.

A server-rendered multi-page site would unload that page on every click, so give
it the **frame shell**: `"client": { "shell": "frame" }`.

- The top-level document becomes a small shell (`tor-shell.html`, which you also
  copy to `index.html` and `404.html` so a first visit, including to a deep link,
  bootstraps) that never navigates. It owns the Tor host worker and the WebRTC
  connection, and the site runs in a full-viewport same-origin `<iframe>`.
- Clicks, form posts and redirects navigate only the iframe, with native
  behaviour (scripts, forms, history, scroll restoration). The shell keeps the
  address bar and title in step, so it looks like an ordinary site; the back
  button steps the iframe. Verified in a browser with a real forum: 10+ navigations
  and a session of register, post, reply and logout without a second Tor client or
  data channel.
- The Service Worker answers a top-level navigation to a Tor route with the shell
  page, and serves iframe navigations from Tor. It removes `X-Frame-Options` and
  any `frame-ancestors` from the backend's headers and adds `frame-ancestors
  'self'`, so the backend cannot break the frame and other sites cannot frame it.
  The page script it inserts into those documents (role `frame`) exposes
  `window.torSite` and sends links that leave the site, or ask for `_top`, to the
  top level.
- **Costs.** A top-level reload, a typed URL, or a `target="_top"` link makes a new
  shell, which starts Tor and the WebRTC connection again; with WebRTC that took
  about 90 s to the first page in testing (about 35 s for the channel, then a
  circuit to the onion). The WebSocket carrier is faster there. Pages that refuse
  framing by JavaScript (frame-busting) do not work. The shell needs a page
  that stays open: if the owning tab closes, another open tab of the site takes
  over; with none, requests fail (they never fall back to another carrier).
- `"shell": "frame"` cannot be combined with `"host": "service-worker"`.

### A worked example: a forum

`examples/flaskbb-demo/` runs FlaskBB as an onion service behind a static host that
imitates GitHub Pages (GET and HEAD only, `404.html`, no server code), root-hosted or
as a project page, with a headless end-to-end check
(`test/site-live-forum.mjs`: register, log in, post, reply, log out, over Tor). See
its README. Things it taught that are now handled or documented: the manifest must
list the adapter's own files as `static` when everything else goes to Tor; a first
visit to any deep link needs a `404.html` shell; multi-page sites need `"host":
"service-worker"`.

### Onion services that ask for proof of work

An onion service under attack can ask every visitor for a solution to a puzzle (proof of work)
before it takes their connection request, and serve the ones who did the most work first. The
adapter's Tor client solves these puzzles, so a static site in front of such a service keeps
working during a flood, at a cost of CPU time. With the service idle it asks for no effort and
nothing is solved: no worker is started and a normal visit is unchanged.

The solving runs in Web Workers that load the same WASM (`tor-site-pow.js`, which the usual
`/tor-site*.js` pattern in `static` already covers), one fewer than the cores, between 1 and 8, and
only while a puzzle is being solved. Where the Tor client lives in a SharedWorker (the default host,
and the frame shell) or in the Service Worker (`"host": "service-worker"`), neither of which can start
workers, a page runs them: a page attached to the host, or a page the Service Worker controls (the one
last focused is asked first; the page script `tor-site.js` answers). With no such page open the client
connects without offering a solution, as before. A browser may stop a Service Worker that has been busy
for minutes, which a very high effort could cause. One unit of effort costs
about 0.13 s of one worker, so an effort of 100 takes seconds and 1000 minutes; the client pays at most
2000 (arti's own cap is 10000).

    "client": { "pow": { "workers": 4, "maxEffort": 2000, "minEffort": 0 } }

`pow` is on by default; `false` turns it off. `minEffort` is the least to pay whenever the service uses
proof of work, even when it asks for none (a client that wants priority can pay for it; it is also how
the solver is tested against a service that is not under attack). The service side, and what it costs,
is in [SERVER-HARDENING.md](SERVER-HARDENING.md). This needs the patched `tor-hsclient` in
`crates/patches/` (see its `PATCH.md`); it adds about 17 kB gzip to the WASM.

### WebRTC carrier in the site adapter

`"client": { "snowflake": "webrtc" }` sends the site's Tor traffic through a
volunteer Snowflake proxy instead of a WebSocket to the Snowflake server, which
a censor can block by name. Workers have no `RTCPeerConnection`, so the **page
hosts the peer connection**: the Tor client (in the host worker) does the broker
exchange and everything above the data channel, and asks an open page of the
site to create the peer connection and relay the data channel's bytes over a
`MessagePort` (`src/site/peerPage.ts`, `src/site/peerRelay.ts`). Consequences:

- A tab of the site must stay open. If the owning tab closes, its connection
  dies, the Snowflake session redials, and the new peer is hosted by another open
  tab; with no tab open, requests fail.
- It cannot be combined with `"host": "service-worker"` (the manifest is
  rejected). When no page is attached (someone opens a Tor path in a new tab with
  the site closed) the Service Worker's fallback refuses WebRTC with an error
  rather than quietly switching to the WebSocket carrier, which exposes you to a
  different party.
- Starting is slower and more variable than the WebSocket carrier (broker match,
  ICE gathering; typically 15 to 30 s cold). `website/public/site-demo/webrtc.html`
  is a working example.

For other uses of tor-js inside a worker, `TorClientOptions.rtcPeerFactory` lets
the WebRTC carrier take its peer connection from anywhere (see `RtcPeer` in
`src/types.ts`); `new TorClient({ snowflake: 'webrtc' })` on a plain page is
unchanged.

## Singleton

For simple use cases, import the singleton wrapper:

```javascript
import { tor } from 'tor-js/singleton';

// tor.configure({
//   gateway: '198.51.100.7:12298:uEiAxk...9Qw',
//
//   (A gateway's KPS address, "ip:port:certhash". In NodeJS
//   you can leave this commented, but browsers don't have
//   raw TCP and so require help to connect to the tor network.
//   See the Gateway section above.)
// });

const response = await tor.fetch('https://check.torproject.org/api/ip');
```

The singleton auto-opens on first `fetch()`. Use `tor.configure(options)` to change settings, or `tor.close()` to shut down.

## Storage

By default, `TorClient` auto-detects the best storage for the environment:

- **Browser**: IndexedDB
- **Node.js**: `~/.local/share/tor-js/`

Cached consensus and microdescriptors are persisted, so subsequent connections bootstrap faster.

You can provide your own storage:

```javascript
import { TorClient, storage } from 'tor-js';

// Explicit IndexedDB
const client = new TorClient({
  storage: new storage.IndexedDBStorage('my-app'),
  // ...
});

// In-memory (no persistence)
const client = new TorClient({
  storage: new storage.MemoryStorage(),
  // ...
});
```

## Logging

Pass a `Log` instance to see bootstrap progress and debug info:

```javascript
import { TorClient, Log } from 'tor-js';

const client = new TorClient({
  log: new Log(),       // logs to console with timestamps
  logLevel: 'info',     // minimum level (default: 'debug')
  // ...
});
```

Custom log sink:

```javascript
const log = new Log({
  rawLog: (level, ...args) => myLogger[level](...args),
});
```

## Verifying the build

The WASM binary is reproducible: a clean-tree `npm run build` of a given commit
produces byte-identical `dist/tor_js_bg.wasm` and `dist/anon-rpc-worker.js` on
any host, including a different CPU architecture (verified across `x86_64` and
`aarch64` Linux). Each CI run prints the commit, the toolchain versions and both
hashes, so you can check a release against your own build.

Two things to know if a hash doesn't match: the toolchain is pinned
(`rust-toolchain.toml`, plus wasm-pack and binaryen versions asserted by
`scripts/build.sh`), and a **dirty working tree deliberately won't reproduce** —
it embeds a build timestamp so an unverifiable build is self-identifying. Build
from a clean checkout, and note that a stale `target/` directory is not
guaranteed canonical.

## License

MIT OR Apache-2.0
