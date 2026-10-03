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
| `tor-js` | Fetched from CDN, cached locally | 35 kB | Production web apps |
| `tor-js/wasm-base64` | Embedded in the JS bundle | 2.7 MB | Single-file deploys |
| `tor-js/wasm-file` | Loaded from `tor_js_bg.wasm` next to the module | 34 kB + 2.0 MB | Self-hosted, server-side |

Each also has a `/singleton` variant (see [Singleton](#singleton) below).

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
  contacted, and only `.onion` names are accepted.
- **Cookies.** `Set-Cookie` is a forbidden response header for page scripts, and
  a browser would file it under the wrong site, so the adapter keeps its own jar
  (`Path`, `Domain`, `Expires`/`Max-Age`, `Secure`, `HttpOnly`), persisted in
  IndexedDB, and never sends the site's own cookies to the backend. The jar
  cannot be read through `document.cookie`.
- **Redirects** are handed back to the browser with `Location` rewritten to the
  site's own URL, so the address bar and every hop go through the same routing.
- **Headers.** `Origin`/`Referer` name the onion (so CSRF checks pass), `Accept-
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
