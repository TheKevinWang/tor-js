# Changelog

## Unreleased

No API breaks. The WASM grows about 5% gzip (`tor-js/wasm-base64` 2.5 → 2.7 MB,
`tor-js/wasm-file` 1.9 → 2.0 MB) for bridge support and the Snowflake transport.

### Added

 **Host an onion service from a worker: `startHostWorker()`.** The service, its Tor client and its request
  handler run in a SharedWorker (`tor-js/host-worker.js`, about 67 kB, loaded only when used), so all tabs of an
  origin share one service and a reload of one tab leaves it running while another tab is open. A reload of the
  only tab, or closing every tab, still ends it (measured in Chromium 152: the worker dies with its last
  page). Pages see its state and proof-of-work counters through `onStatus`. The handler is a module URL, not a
  closure. Part of the host build (`tor-js/host`); the default build has the function but it throws
  `HostingUnavailableError`.
- **Visiting clients pay for priority by default (`TorClientOptions.pow`).** A busy onion service serves the
  visitors who did the most proof of work first, but a plain `TorClient` never paid unless the application
  installed a solver. Now a client created in a page or in Node installs one that runs the work on worker
  threads (Web Workers; `worker_threads` through the new `pow-node-worker.js`, exported as
  `tor-js/pow-node-worker.js`), started only when a puzzle comes, and removed when the last client using it
  closes. It never replaces a solver already installed; `pow: false` turns it off; `maxEffort`, `minEffort`,
  `workers` and `workerUrl` tune it. Checked offline with real worker threads and live against a hosted
  service (`test/visitor-pow-live.mjs`). Cost: about 3 kB gzip of JavaScript in every entry point.
- **`TorClient.close()` lets a Node process exit.** Closing a client used to leave arti's background timers
  running, some for three minutes, so a script that closed its client did not end (every live script finished
  with `process.exit(0)`). Now `close()` unreferences the runtime's timers (`WasmRuntime::shutdown`; they still
  fire, so arti can finish tearing itself down, but none holds the event loop open), the pool of spare Snowflake
  sessions is released when the last client using it closes (`snowflake::Lease`), and a hosted service's
  proof-of-work tasks end with the service instead of after a five minute sleep. When the last client using
  Snowflake closes, the Snowflake sessions still in use are ended too, so what arti has in flight (a descriptor
  upload, a circuit build) fails at once instead of running out its timeouts (minutes on a bad network): the
  process ends 0.2 s after `close()`. A client closed while still bootstrapping ends when bootstrap does.
  `test/close-exits-live.mjs` checks all three cases.
- **Hosting is a separate build: `tor-js/host`.** The onion service code is no longer in the default WASM, so
  a page that only visits onion services does not pay for it: `tor-js`, `tor-js/wasm-file` and
  `tor-js/wasm-base64` ship the same WASM as before hosting existed (5,472,447 bytes, 2.12 MB gzip), and
  `tor-js/host`, `tor-js/host/wasm-file` and `tor-js/host/wasm-base64` ship `tor_js_host_bg.wasm`, built with the
  new Cargo feature `onion-service-host` (6,370,381 bytes, 2.45 MB gzip; about 330 kB more). Calling `listen()` or
  `serve()` on the default build throws `HostingUnavailableError`, which names the right import. The CDN loader
  is shared (`src/cdnLoader.ts`); the host one uses only the npm mirrors (the GitHub artifact mirror is filled by
  CI for the default binary only). `scripts/build.sh` and CI build and hash both WASM files; on Windows build
  them with the two `wasm-pack` commands in `scripts/build.sh`.
- **Proof of work for hosted services.** A hosted onion service now publishes proof-of-work parameters,
  verifies the solutions visitors send, serves the highest effort first, raises the effort it asks for when it
  is busy, and reports what it did in `service.pow`. On by default; `proofOfWork: false` turns it off and
  `proofOfWork: { queueDepth }` sizes the queue (default 256, not arti's 8192, which can take 32 MB). An idle
  service asks for no effort, and visitors that cannot solve are still served. In the vendored `tor-hsservice`
  the two request-handling loops, which arti runs on blocking threads, are async tasks that end when the
  service does. Checked live: a visitor paying effort 4 or 6 was verified (by a Node host and by a browser
  tab), a corrupted solution was rejected and not served (`test/hs-live-pow.mjs`).
- **Host an onion service from a browser tab or a Node process: `client.serve()`, `client.listen()`.** A page
  can now be an onion service, not only visit one: `client.serve(handler)` answers HTTP requests with a
  `Response` and returns a `.onion` address any tor-js client or Tor Browser can visit; `client.listen()`
  gives raw duplex connections for protocols of your own. The address comes from a 32-byte identity the
  caller keeps (`TorClient.generateIdentity()`, `TorClient.onionAddress()`); limits on ports, concurrent
  visitors and request size/time protect the host. Everything but the identity is held in memory, so a
  restarted host picks new introduction points. Needs a vendored `tor-hsservice` with in-memory state
  (`crates/patches/tor-hsservice/PATCH.md`). Demo: `website/host.html`. Live checks:
  `test/hs-live-node.mjs`, `test/hs-live-lifecycle.mjs`. Hosting is in a separate build of the WASM (see the entries above), so the default entry points are
  not larger.
- **A loading screen that explains the Tor connection, for everyone.** While the page connects it says
  "Connecting securely…" with a route from the visitor to the server that fills as the real steps complete,
  a plain-language step, a note that the first connection takes longer, and "Powered by Tor ⓘ". "Connection
  details" shows the technical view: the chain from browser to onion service, what goes through Tor and what
  loads directly, and the Tor client's log. Failures say where they stopped, with a "Try again" button. A
  "Private connection" badge stays afterwards (`data-badge="false"` hides it). The frame shell always shows it
  (replacing its one-line status); a plain page opts in with `data-loading="screen"`.
- **Transparent loading (`data-loading="transparent"`).** No screen: Tor connects at once while the visitor
  uses the page (reading a blog), so a later request that needs the server (leaving a comment) finds it ready.
  A visitor who acts first sees a notice that the request is waiting for the private connection, and it is sent
  when ready. The Service Worker reports held requests (`tor-site-waiting`).
- `TorSite` gains `progress`, `onProgress()`, `waiting` and `onWaiting()` (`src/site/progress.ts`,
  `loading.ts`, `badge.ts`, `ui.ts`).

### Fixed (code review of 2026-10-04, `CODE_REVIEW.md`)

- **The site adapter no longer forwards private requests to the static host when its manifest cannot be
  loaded (R1).** A Service Worker that restarted while `tor-site.json` was unreachable or invalid used to
  treat every path as static, handing a Tor route's path, query and form body to the static host. It now keeps
  the last valid manifest in Cache Storage and routes by it, answers locally with `503` when it has none,
  refuses to install without a valid manifest (`registerTorSite()` rejects instead of hanging), and registers a
  Static Routing API rule so Chromium does not send a navigation to the network in parallel while it starts a
  stopped worker (seen in Chromium 152: a cold-start navigation's URL reached the static host even though the
  worker then answered it).
- **Cross-site request forgery through the adapter (R2).** A form another site posted into a Tor route reached
  the onion service with the site's cookies and an `Origin` rewritten to the onion's own. The worker now works
  out who started each request (`src/site/requestPolicy.ts`): state-changing requests that the site's own pages
  did not make are refused with `403` before anything is sent; foreign `Origin`/`Referer` values are dropped
  instead of relabelled; `credentials: "omit"` is honoured; `SameSite=Strict` cookies go only with the site's
  own requests.
- **`fetch` no longer throws for 204, 205 and 304 responses, and returns a null body for HEAD (R3).** The WASM
  client gave the `Response` constructor a stream for every response, which the constructor rejects for those
  statuses. A keep-alive connection is still returned to the pool.
- **Aborting a request stops it while it waits (R5).** `TorClient.fetch` now rejects at once when its signal
  aborts while Tor is still starting (without cancelling other callers), and the WASM client races connecting,
  the TLS handshake, the upload, the response head and each body read against the signal, closing the Tor
  stream. Abort errors from either layer have `name` `"AbortError"` and `code` `"ABORT"`, and the site adapter
  passes them through instead of turning them into `502`s. The site adapter stops waiting for Tor or a host
  worker when the browser aborts.
 **Node 24 lost the cross-process storage lock.** Node 24 has `navigator.locks`, so `addLocking` took the
  browser path, whose locks only cover one process; Node now always uses the lock file. Found while making the
  unit tests pass on Windows (`os.homedir()` reads `USERPROFILE` there, and an ESM import needs a file URL).
- **Node's filesystem storage could not start with a full directory cache on Windows.** `getAll` opened every
  file at once (one per microdescriptor, about 9,000 after one run) and failed with `EMFILE`; it now reads them
  64 at a time.

### Fixed (fetch)

- **`fetch` over HTTPS reuses its connection.** Connection reuse used to cover plain HTTP only, so every HTTPS
  request paid for a new Tor stream and a TLS handshake: about 1 s each, which made pages with long chains of
  dependent requests very slow. A GET or HEAD without a body now keeps its TLS session for the next request
  to the same host (`fetch.rs`: `wants_keep_alive` accepts `https`; the pool is keyed by scheme as well as host and
  port). Measured in Node, alternating old and new builds on the same machine: median of ten sequential HTTPS
  requests 644 and 668 ms before, 253 and 415 ms after.
- **`TorClient.fetch` takes `isolate: true`.** A request that failed at its exit
  ("timed out at exit") used to be retried on the same circuit, through the same exit, and failed again. With
  `isolate` the request gets a circuit group of its own (Arti `StreamPrefs::set_isolation`); once it connects, that
  group is remembered for the host, so the other requests to it follow the circuit that worked, and the old
  group's kept connections are dropped. Measured: of 16 fresh circuits, 16 reached debian.org, 13 kernel.org and only 1 www.gnu.org, which blocks
  most Tor exits, so gnu.org still often fails.

### Added

- **Static-site adapter (`tor-js/site`).** A Service Worker plus a
  `tor-site.json` manifest route an existing site's backend paths over Tor to an
  onion service while everything else stays on the static host, with no change
  to the site's own code: cookie jar, redirect and header rewriting, gzip, a
  persistent SharedWorker that owns the Tor client, and a page API
  (`registerTorSite()` / `window.torSite`) reporting connection state. Built to
  `dist/site/tor-site-sw.js`, `tor-site-host.js` and `tor-site.js`; demo in
  `website/public/site-demo/`. See the README section "Static sites with an
  onion backend".
- **The browser client solves onion services' proof-of-work puzzles, and a hosted service can turn
  proof of work on.** arti solves puzzles on an operating-system thread, which WASM lacks; a vendored
  patch of `tor-hsclient` (`crates/patches/tor-hsclient`) hands them to JavaScript, which solves them in
  a pool of Web Workers running the same WASM (`tor-site-pow.js`, one fewer than the cores, started only
  while a puzzle is being solved). Where the Tor client is in a SharedWorker, which has no `Worker` in
  Chromium, an attached page runs the pool; with the Tor client in the Service Worker (`"host":
  "service-worker"`), which cannot start workers either, a page it controls does. Idle services ask for
  no effort and cost nothing. Manifest
  setting `client.pow` (`false`, or `workers`, `maxEffort` default 2000, `minEffort`, `workerUrl`).
  Checked against the real Tor program: a solved puzzle is accepted, a corrupted one gets no answer. An
  effort of 100 took 3 to 55 s in a browser with 8 workers. The generated torrc has proof of work on
  with `HiddenServicePoWQueueRate 25` and `HiddenServicePoWQueueBurst 100` (Tor's defaults are 250 and
  2500, for large servers). WASM +43 kB (+17 kB gzip).
- **Server hardening for the onion service behind a site.** `SERVER-HARDENING.md` explains what
  keeps the machine behind an onion service from being found or flooded and what each measure
  costs a visitor; `scripts/onion-hardening.mjs` generates a hardened torrc (nothing listens but
  the service, the origin only on loopback, introduction-point rate limiting, five introduction
  points; proof of work, see the entry above);
  `scripts/audit-onion-origin.mjs` checks a torrc and a running origin (reachability on every
  address, software and proxy headers, the machine's own addresses and names in responses). In a comparison of 16 first visits each
  the hardened torrc was not distinguishable from a minimal one.
- **A fresh `bootstrapUrl` snapshot now refreshes a stale saved directory.** The snapshot
  was only used when the browser had no directory saved, so a returning visitor with a
  consensus a few hours old always downloaded a new one over the bridge, which in one
  session kept failing for two minutes until the host gave up ("Tor was not ready after
  120s"). The snapshot is now fetched when the saved consensus is no longer fresh, and
  stored if its consensus is newer; a fresh saved consensus still skips it, and so does a
  snapshot that is no newer. A site whose snapshot is stale gets no help from this.
- **Connection reuse for `fetch` over plain HTTP.** A GET or HEAD without a body keeps its
  Tor stream after the response and the next request to the same host uses it, instead of
  opening a new stream (a round trip across the whole circuit for an onion service) for
  every request. In a measured session, alternating with and without reuse on the same
  circuits, time to the first byte fell from 2.0 s to 1.2 s and a complete page from
  2.8 s to 1.65 s. A connection is kept only when the response was read to its exact end;
  one the server has closed is dropped, and a request that fails on a reused connection is
  sent again on a new one. POSTs, requests with a body, HTTPS and requests that set their own
  `Connection` header are unchanged. The kept connections belong to the `TorClient` that opened
  them (closing the client drops them): a second client in the same process never takes a stream
  the first opened.
- **Steadier start-up on slow Snowflake proxies.** Circuits through a bridge get at
  least 7 s to build (Tor's default floor of 10 ms let a slow proxy's circuits be
  abandoned until the only bridge was disabled); the first broker request is
  repeated beside itself after 3 s without a proxy; the spare WebRTC peer is replaced
  after use (and closes itself after 20 s unused); IndexedDB reads only the key range
  asked for instead of the whole store. On a good proxy day start-up is unchanged
  (about 2 s to an open channel, 5 s to Tor ready, 12 s to the first page).
- **Faster, steadier start-up for the WebRTC carrier.** Tor's saved guard state could
  mark the only (Snowflake) bridge permanently `disabled` after a few slow or failed
  runs, after which every page load sat silent without dialling it; the mark is now
  dropped when the state is read. ICE gathering no longer waits for its 10 s limit
  (it ends 0.6 s after the first server-reflexive candidate, at most 4 s), a spare peer
  connection is prepared when the page loads, the Snowflake session starts in
  parallel with reading storage, the host starts before the Service Worker has
  finished installing, a proxy whose channel has not opened after 6 s is replaced, and
  failed attempts are retried after 3 s instead of 10 s. A cold start that took over
  a minute (or never finished) now reaches the first page in about 10 to 20 s.
  `(await window.torSite).timeline` records every Tor client log line and state change
  with a timestamp, for reading a slow start afterwards.
- **Fix: the site adapter's cookie jar never saved.** Its IndexedDB database shared a
  name with the Tor client's storage, so its store could not be created; logins did not
  survive a restart of the worker. It now uses `tor-site-cookies`.
- **Frame shell and WebRTC by default in the site adapter.**
  `"client": { "shell": "frame" }` makes the top-level document a persistent shell
  (`tor-shell.html`) that owns the host worker and the WebRTC peer connection while
  the site runs in a same-origin iframe, so server-rendered multi-page sites can use
  the WebRTC Snowflake carrier (a document that holds a peer connection must not
  unload). The Service Worker serves the shell for top-level navigations and Tor
  pages for iframe navigations, drops `X-Frame-Options`, and replaces
  `frame-ancestors` with `'self'`; the shell mirrors the iframe's URL and title.
  The default carrier is now WebRTC wherever a page can host it (WebSocket with
  `"host": "service-worker"`; `"snowflake": "websocket"` opts out). With WebRTC the
  Service Worker never falls back to its own Tor client: it waits for a live host,
  and the shell waits for the Service Worker to acknowledge its host before loading
  the site. Breaking-ish: manifests without a `client.snowflake` now use WebRTC.
- **Multi-page (server-rendered) sites in the site adapter.** Found by running a
  real server-rendered site: `"client": { "host": "service-worker" }`
  keeps the Tor client in the Service Worker, which survives navigation (a
  SharedWorker host does not); HTML pages served from the onion get the adapter's
  page script inserted (`"client": { "inject": false }` opts out), which keeps the
  Service Worker alive with a 20 s ping; navigations served over Tor always use
  the Service Worker's client, even in the default mode; a worker host that goes
  silent with requests in flight fails them after ~20 s and safe requests are
  retried on the Service Worker's client; `"backendKnowsBase": true` for backends
  that were told the path the site is hosted under (GitHub project pages);
  `"client.pageScript"` names the script that is inserted.
- **WebRTC Snowflake in the site adapter.** `"client": { "snowflake": "webrtc" }`
  in `tor-site.json`: a page of the site hosts the `RTCPeerConnection` (workers
  have none) and relays the data channel to the Tor client in the host worker;
  if that page closes the carrier redials through another open page.
  `TorClientOptions.rtcPeerFactory` (and the WASM `withPeerFactory`) exposes the
  seam for other callers. The plain-page WebRTC carrier is unchanged.
- **`response.rawHeaders`.** `TorClient.fetch()` responses now carry the header
  list exactly as received (`[name, value][]`, repeats kept) because the
  `Response` constructor drops `Set-Cookie`.
- **Snowflake: no gateway needed.** `new TorClient({ snowflake: true })` reaches
  Tor through Tor Project's Snowflake bridge, so a page on a static host can use
  tor-js — `.onion` services included — with no gateway. The transport (Turbo
  Tunnel, KCP, smux; ported from andrewtheguy/webtor-rs, MIT) runs in the WASM
  module. `snowflake: 'webrtc'` uses a volunteer proxy found by the Snowflake
  broker instead of a direct WebSocket to the Snowflake server.
- **`bridges`.** Tor bridge lines to use as the only guards: `snowflake` lines
  use the built-in transport, plain `ip:port fingerprint` lines are dialed like
  relays. Only arti's `bridge-client` feature is enabled — not `pt-client`,
  whose PT manager spawns binaries; transports are dialed by the WASM runtime.
- **`bootstrapUrl`.** Pre-fill an empty directory cache from a snapshot fetched
  with plain `fetch()`, e.g. one hosted next to the page.
  `scripts/make-bootstrap.mjs` builds one from the directory authorities.
- **`website/onion.html`.** A demo page that fetches DuckDuckGo's onion service
  over Snowflake, and `examples/tor-fetch-onion-snowflake.js` for Node.

## 0.4.2

No API breaks. One behaviour change to be aware of: setting `logLevel` without a
`log` now prints to the console (see **Changed**). The WASM grows about 10% gzip
for `.onion` support.

### Added

- **`.onion` connections.** `fetch()` now reaches v3 onion services, via
  arti's `onion-service-client` feature. There is nothing to configure: a
  `.onion` URL just works. The cost is roughly 190 KB gzip on the WASM, paid
  whether or not a caller ever dials one: `tor-js/wasm-base64` goes from 2.3 to
  2.5 MB and `tor-js/wasm-file` from 1.7 to 1.9 MB. The default `tor-js` entry
  point's JS is unchanged; its growth is in the WASM it fetches. This is
  client-side connections only: onion-service client authorization and hosting
  an onion service are not enabled.
- **Demo-gateway warning.** A gateway can declare itself a demonstration
  instance (`"demo": true` in `/metadata.json`, [PROTOCOL.md §5](PROTOCOL.md)).
  tor-js checks in the background and warns once per gateway per process,
  pointing at how to run your own. The check never delays or fails a request.
  Because the warning is meant for a person, it is the one message that is not
  silenced by `TorClient`'s quiet default: it goes to your `log` if you set
  one, and to the console otherwise, unless `logLevel` excludes `warn`. This
  is the new `Log.warnOnce(key, ...)`. `ArtiSocketProvider` and `KpsGateway`
  gained an optional `log` option; `TorClient` passes its own, and a provider
  you construct yourself without one skips the check.
- **anon-rpc worker logs reach the host.** `dist/anon-rpc-worker.js` now sends
  its own, tor-js's and arti's logs to the host's log capability (anon-rpc
  SPEC §13); previously only the worker's own lifecycle lines did. The level is
  set with `logLevel` in the object form of the worker config
  (`{ gateways: [...], logLevel: "debug" }`) and defaults to `info`, because
  the host's log buffer is bounded and a debug firehose would evict the lines
  that explain a failure. An unrecognised level fails readiness. The worker's
  bytes changed, so **its keccak256 pin changes** with this release.

### Changed

- **`logLevel` without `log` now logs to the console.** Previously
  `new TorClient({ logLevel: 'debug' })` raised arti's log volume and then
  discarded every line, which read as logging being broken. The level applies
  to tor-js's own lines as well as arti's. With neither option set, the client
  is silent apart from one-time warnings (above).
- The arti fork is pinned to a newer commit (`voltrevo/arti@cc09d69`), which
  moves the WASM client to arti 0.45.
- Repository, homepage and issue links now point at
  [ethereum/tor-js](https://github.com/ethereum/tor-js).

### Gateway (`tor-js-gateway` 0.3.0)

The gateway is a separate crate, not part of the npm package; recorded here
because it ships from the same repo.

- **Worker bundles are mirrored from a GitHub branch.** `keccak_dir` is
  replaced by `keccak_repo` + `keccak_branch` (both required together; unset
  disables the capability), with `keccak_poll_interval` and
  `keccak_manual_sync_min_interval`. Publishing a bundle is a `git push`.
  A config still carrying `keccak_dir` gets a migration message. `tor-js-gateway
  sync` triggers a sync from the command line.
- **`demo` config flag**, advertised in `/metadata.json`. It is a required
  field, like the rest of the config: an existing config needs
  `"demo": false` (or `true`) added before it loads.

## 0.4.1

No API or wire changes from 0.4.0. One behaviour change to be aware of: a
truncated response body is now an error instead of a silently short read (see
**Fixes**).

### Added

- **Streaming request bodies.** `fetch()`'s `body` now accepts a `ReadableStream<Uint8Array>` alongside `string`, `Uint8Array` and `ArrayBuffer`. A stream is sent as it's produced, with `Transfer-Encoding: chunked` framing, instead of being buffered to learn its length — so uploads no longer need to fit in memory. Bodies of known size still use `Content-Length`. (Response bodies already streamed.)
- **Multiple gateways.** `gateway` accepts an array of KPS addresses to fail over and spread load between. The list is an **unordered set** — position implies no priority, and each client shuffles it, so independent clients don't all pile onto the same gateway. Within a preferred set of two, the gateway carrying the fewest connections is chosen, which also serves as the latency signal: a slow or stalled gateway stops being picked. Failures cool a gateway off with exponential backoff and it is re-admitted automatically once it recovers.
- **Fast bootstrap falls over.** Previously bootstrap was pinned to one gateway for the client's lifetime and silently degraded to slow bootstrap if that gateway was down. It now picks per attempt and tries the others. The happy path still contacts exactly one gateway.
- **Gateway attempts are bounded.** Dialing a gateway had no deadline, so one unreachable gateway could stall a relay connection indefinitely. Setup (dial, stream open, response head) now shares a 15s budget. Bootstrap body download is deliberately excluded, so a large snapshot over a slow link isn't mistaken for a dead gateway.
- **Injectable KPS transport.** `ArtiSocketProvider` accepts a `dial` function, and `TorClientOptions` accepts a `socketProvider`. Supplying a dialer means the built-in `@kpstreams` client is never loaded, so an embedder that already holds a KPS transport can bundle tor-js without it. The KPS address parser is vendored to keep that path free of runtime `@kpstreams` deps.
- Relay-connect failover keeps the target fixed across gateways, so a gateway cannot influence relay (guard) selection by refusing `CONNECT`s.
- `dist/anon-rpc-worker.js` is now built into the package: a hash-pinned [anon-rpc](https://github.com/ethereum/anon-rpc) worker that offers anonymized `fetch` from a sandboxed worker, reaching the network only through a host-granted KPS capability. Experimental and not yet a documented API; it is a hosted artifact rather than an import.

### Fixes

- **A truncated response body is now an error.** With `Content-Length` framing, a
  connection that closed with bytes still owed was reported as a clean end, so
  callers received a short body and no indication of it. Chunked framing had the
  same hole twice over: end-of-stream while awaiting the CRLF after a chunk, and
  end-of-stream before the terminating `0`-chunk, both read as a complete body.
  All three now error. Malformed chunk framing is also caught rather than
  silently dropping two bytes and corrupting the next chunk-size line.
  **This is the one behaviour change in the release**: a peer that closes early
  where it previously appeared to succeed now surfaces an error.
- **A `1xx` interim response could hang the request.** After skipping a `100
  Continue`, the reader waited for more bytes before checking what it already
  held — so an interim and final response arriving in the same packet left it
  blocked on data the server had already finished sending.
- **A malformed bootstrap archive could panic the client.** The Stored-zip parser
  computed member offsets in `usize`, which is 32 bits on wasm32: a crafted
  `compressed_size` wrapped past the bounds check and then panicked on a
  backwards slice — reachable by whoever serves the archive. Offsets are now
  accumulated in `u64`, so the check behaves identically on every target.
- **A failed bootstrap no longer crashes a Node host.** `TorClient.ready()`
  cleared its cached promise through a derived promise that nothing awaited, and
  the constructor started bootstrap with no handler attached at all. Either could
  raise an unhandled rejection — fatal in Node — on top of the error the caller
  already received.
- **Gateway: `is_local()` missed several non-routable IPv6 ranges** —
  `fe80::/10`, `fc00::/7`, multicast, and the v4-mapped and (deprecated)
  v4-compatible embeddings of broadcast/unspecified addresses. `CONNECT` targets
  must also appear in the consensus relay allowlist, so this was defence in depth
  rather than a reachable SSRF, but 11 addresses that previously passed the check
  are now refused.

### Build

- **The WASM artifact is reproducible across machines.** `dist/tor_js_bg.wasm`
  and `dist/anon-rpc-worker.js` now hash identically for any clean-tree build of
  a given commit, verified between `x86_64` and `aarch64` Linux hosts — which
  matters because the worker's keccak256 is a pinned, externally verifiable
  identity. This needed the toolchain pinned (`rust-toolchain.toml`, plus
  wasm-pack and binaryen asserted by `scripts/build.sh`), dependency and
  standard-library paths remapped out of panic locations, and a `RUSTC_WRAPPER`
  that makes cargo's `-C metadata` host-independent
  ([rust-lang/cargo#8140](https://github.com/rust-lang/cargo/issues/8140)).
  A dirty working tree deliberately does *not* reproduce: it embeds a timestamp,
  marking the build as unverifiable.
- The test suite grew from 19 tests to 408 across the Rust crates, the TypeScript
  layer, the gateway integration suite and the browser data path. The fixes above
  were all found by writing them.

## 0.4.0

**Breaking: tor-js now connects through gateways over [KPS](https://github.com/ethereum/kps) instead of WebSocket/WebRTC.** A 0.4.0 client requires a KPS gateway and cannot talk to a pre-0.4.0 gateway (or vice versa).

- **`gateway` is now a KPS address, not a URL.** Pass `ip:port:certhash` (printed by the gateway at startup), e.g. `198.51.100.7:12298:uEiAxk…9Qw`, instead of `https://…`. The client dials it over WebRTC in browsers and QUIC in Node.js (via the optional `@kpstreams/quic-client` peer dependency); relay connections are HTTP `CONNECT` tunnels on KPS streams.
- Built on KPS 0.2.1 (`@kpstreams/*` client) with the gateway on the `kps` crate 0.2.2. 0.2.1 specifies read-termination semantics (KPS SPEC §9.2: a read errors on RESET/local-close/connection-loss, EOF only on peer FIN) and stops surfacing a bare `null` on teardown ([kps#3](https://github.com/ethereum/kps/issues/3)). Paired with a tor-js fix: the WASM runtime now drives `reader.cancel()` to completion on stream drop instead of dropping its promise, which under §9.2 rejects (the connection is closed first) and would otherwise crash Node with an unhandled rejection. The gateway's 0.2.2 bump fixes a WebRTC data-channel bug where a browser's reused SCTP stream id was routed to a stale closed channel, hanging reads after ~2 streams per connection ([kps#4](https://github.com/ethereum/kps/issues/4)).
- **Fast bootstrap moved to zstd** (`/bootstrap.zip.zst`), decompressed inside the WASM.
- **`ArtiSocket` is now stream-shaped** (`readable`/`writable`) rather than event-based, preserving backpressure end to end. This affects custom `socketProvider` implementations.
- Updated Arti to 2.5.0 (tor-* 0.44).
- The repository is now a monorepo: the KPS gateway lives in `crates/tor-js-gateway/`, and the website in `website/`.

### Migrating from 0.3.x

Replace your gateway URL with the gateway's KPS address, and run a KPS gateway (see [`crates/tor-js-gateway/`](crates/tor-js-gateway/)):

```js
// 0.3.x
new TorClient({ gateway: 'https://tor-js-gateway.example.com' });
// 0.4.0
new TorClient({ gateway: '198.51.100.7:12298:uEiAxk…9Qw' });
```
