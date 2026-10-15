# Code review: correctness, privacy, and reliability

Review date: 2026-10-04.

This review covers the current Tor client, static-site adapter and proof-of-work integration. It records four prioritized findings and suggested fixes. No implementation fixes were made during the review.

Paths are relative to this directory. Line numbers refer to the reviewed working tree and may move. High priority means the issue should be addressed before relying on the affected feature's security or correctness guarantees. Medium priority means a significant reliability issue to address next.

## Findings at a glance

| ID | Priority | Finding | Main location |
| --- | --- | --- | --- |
| R1 | High | Manifest-load failure can forward Tor-bound requests to the static host | `src/site/sw.ts:268` |
| R2 | High | Origin translation and cookie attachment weaken cross-site request protection | `src/site/torHttp.ts:161` |
| R3 | High | The WASM client cannot construct valid 204, 205, or 304 responses | `crates/tor-js-wasm/src/lib.rs:884` |
| R5 | Medium | Abort signals do not reliably interrupt pending requests | `src/TorClient.ts:151`, `crates/tor-js-wasm/src/lib.rs:798` |

## R1: Manifest-load failure can forward private requests to the static host

### Evidence and impact

In [src/site/sw.ts](src/site/sw.ts), the worker reloads its routing manifest after it starts. If that load fails, the fetch handler's rejection branch calls `fetch(request)` at line 268. The comment explicitly chooses plain static-site behavior when the manifest is unavailable.

That behavior loses the distinction between public static files and private Tor routes. Following a worker restart, a temporary manifest outage or invalid manifest can cause a request intended for the onion backend to reach the static host instead. Depending on the request, the exposed data can include its path, query, and POST body. A static host returning an error does not undo that disclosure.

This finding follows directly from the source. No live disclosure test was performed.

### Suggested fix

- Persist the last successfully validated routing configuration so a worker restart does not discard knowledge of private routes.
- When routing cannot be established, return a local error for requests that are not independently known to be public. Do not forward the original request as an error fallback.
- Keep any startup-file allowance explicit and narrowly scoped. Loading the shell or configuration must not require treating arbitrary application requests as public.
- Define how configuration updates become active so an unsuccessful update preserves a coherent routing policy.

### Validation

Use a local fixture to cover worker restart, unavailable or malformed manifests, and recovery after the manifest becomes valid. Verify that requests to private or unknown routes produce no request to the static origin while routing is unavailable. Verify that explicitly public startup files still load.

## R2: Header translation and cookie attachment weaken cross-site request protection

### Evidence and impact

[src/site/torHttp.ts](src/site/torHttp.ts), lines 161–165, replaces any supplied `Origin` with the onion origin, replaces any supplied `Referer` with the onion root, and attaches cookies from the adapter's jar. It does not first validate the original header values against the visible site's origin.

[src/site/cookieJar.ts](src/site/cookieJar.ts) also explicitly stores `SameSite` without enforcing it, on the assumption that every request comes from the site that owns the jar. Requests arriving through the adapter need that assumption checked rather than inferred from the destination alone.

Together, these behaviors can make an external-origin request look authenticated and same-origin to an onion backend. Backends that rely on origin checks or cookie restrictions consequently lose protections they would have with an ordinary browser connection. An independently validated anti-forgery token may still protect a particular endpoint; this finding does not establish that every backend is vulnerable.

This is a source-level finding; no cross-site browser reproduction was performed.

### Suggested fix

- Validate the original request context before rewriting security-relevant headers or selecting session cookies.
- Establish an explicit policy for state-changing requests, including expected origins and how missing or `null` origins are handled. Reject requests that do not meet that policy.
- Translate only origins that have already been accepted as belonging to the visible application.
- Carry the request metadata needed for credential and cookie decisions through the adapter and worker RPC boundary. Honor credential omission and either implement the relevant `SameSite` behavior or enforce an equivalent, documented restriction at the adapter boundary.
- Preserve backend anti-forgery checks and tokens.

### Validation

Add defensive tests for accepted application requests, rejected unexpected origins, missing-origin policy, credential omission, and cookie selection. Verify that rejected requests never reach the onion backend and that normal sign-in and form submission still work.

## R3: The WASM client rejects valid responses with no body

### Evidence and impact

At [crates/tor-js-wasm/src/lib.rs](crates/tor-js-wasm/src/lib.rs), lines 884–885, `fetch_impl` always passes `Some(&raw_readable)` to the JavaScript `Response` constructor.

The constructor rejects a non-null body for status 204, 205, or 304, including an empty stream. Consequently, a successful no-content API response or a not-modified response becomes a client error before the TypeScript adapter can process it.

The constructor behavior was confirmed locally for all three statuses and is required by the [Fetch standard's response initialization algorithm](https://fetch.spec.whatwg.org/#initialize-a-response). The full WASM/Tor path was not exercised for this finding.

### Suggested fix

- Select a null body in the Rust-to-JavaScript conversion for final responses whose status forbids a body.
- Return a null body for HEAD responses as well, preserving the fetch API's expected semantics.
- Ensure the underlying reader and connection are released appropriately when no response stream is exposed. Preserve safe connection reuse where applicable.
- Fix the conversion before the `Response` constructor runs; handling the status later in the TypeScript transport cannot recover from this exception.

### Validation

Exercise the actual WASM-to-JavaScript response conversion for 204, 205, 304, HEAD, and an ordinary 200 response. Check status, headers, null-body behavior, and resource cleanup.

# R5: Cancellation does not reliably interrupt pending operations

### Evidence and impact

[src/TorClient.ts](src/TorClient.ts), lines 151–152, waits for the client promise and readiness without observing the caller's abort signal. A local check using the existing WASM stub confirmed that aborting while readiness is pending leaves the fetch promise pending.

In [crates/tor-js-wasm/src/lib.rs](crates/tor-js-wasm/src/lib.rs), cancellation is checked before or between operations, but pending connection, HTTP, and body-read operations are not consistently raced against cancellation. In particular, checking the signal before `reader.read_chunk().await` does not interrupt a read already waiting for data.

As a result, a timeout signal may not bound the request's duration, and request-owned work can outlive the caller's interest in it.

### Suggested fix

- Reject already-aborted requests promptly, including before waiting for bootstrap or readiness.
- Allow each caller to cancel its wait for shared readiness without cancelling other callers or the shared Tor client.
- Propagate cancellation through request-owned connection, TLS, upload, response-header, and body-read operations, releasing their resources when cancelled.
- Remove abort listeners when operations settle and preserve a recognizable abort error through adapters and RPC.
- Ensure cancellation does not trigger automatic retries or repeated state-changing requests.

### Validation

Use controlled pending operations to verify cancellation during readiness, connection setup, response-header waiting, upload, and body reading. Assert prompt rejection or stream failure and resource cleanup. Include two callers sharing a client so cancelling one is verified not to cancel the other.

## Test coverage and environment findings

The review produced these results on Windows:

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | Passed |
| `npx tsc --noEmit -p tsconfig.site.json` | Passed |
| `npm run test:unit` | 396 passed, 5 failed, 15 cancelled |
| `npm run test:rust` | Blocked at gateway linking: missing `sqlite3.lib`; no Rust test result |

The unit-suite problems were Windows portability issues: a dynamic import uses a filesystem path rather than a file URL in `test/unit/socketProvider.test.mjs`, and storage tests assume changing `HOME` changes the home directory used by the implementation. Use the existing file-URL-aware bundling helper for imports and an explicit temporary-directory dependency for storage tests. Treat these separately from the product findings above.

The Rust link failure limits this review's validation; it is not evidence that the Rust tests themselves fail. Document or provision the native SQLite build prerequisite before rerunning them.

The highest-value testing improvement is a small integration suite exercising the real WASM conversion and Service Worker behavior. Prioritize ordinary HTTP edge cases, worker restarts, routing-configuration failures, and cancellation. Keep pure unit tests for fast feedback, while avoiding mocks that silently implement behavior missing from production.

## Suggested implementation order

Address R1 and R2 first because they affect privacy and authenticated requests. R3 is a focused correctness fix that should also be done early. Then complete R5 and the corresponding integration coverage.

## Status of the findings (2026-10-05)

All four findings were confirmed against the source and addressed.

| ID | Status | What changed | How it was checked |
| --- | --- | --- | --- |
| R1 | Fixed | `src/site/manifestStore.ts` keeps the last valid manifest in Cache Storage; `sw.ts` routes by it when a fresh one fails, answers `503` locally when there is none, fails installation without a valid manifest (`register.ts` then rejects), and registers a Static Routing API rule for its scope. | `test/unit/siteManifestStore.test.mjs`; in Chromium 152 with a logging static server: worker restarted with the manifest returning 503 served a Tor route over Tor using the saved copy, and with no saved copy answered 503; neither request reached the static host. |
| R2 | Fixed | `src/site/requestPolicy.ts` classifies the initiator (`clients.get(clientId)`, then `Origin`, then `referrer`); unsafe methods not started by the site are refused with 403 in `sw.ts` and again in `torHttp.ts`; foreign `Origin`/`Referer` are dropped; `credentials: "omit"` and `SameSite=Strict` are honoured. | `test/unit/siteRequestPolicy.test.mjs` and new cases in `site.test.mjs` (they fail against the old `torHttp.ts`); in Chromium: a cross-site form post got 403 and nothing was sent, a same-site POST reached DuckDuckGo's onion service over Tor (200). |
| R3 | Fixed | `fetch_impl` builds HEAD, 101, 204, 205 and 304 responses with a null body and drains the reader in the background so keep-alive connections return to the pool. | Rust unit tests for `response_has_body`; live over Tor from Node: 204, 205, 304 and HEAD return `body === null`, a 200 keeps its body, a plain-HTTP GET after a HEAD works. |
| R5 | Fixed | `src/abort.ts`; `TorClient.fetch` and `LocalBackend.handle` race their shared start-up wait against the signal; `crates/tor-js-wasm/src/abort.rs` races connect/TLS/upload/head and each body read; abort errors keep `name: "AbortError"`, `code: "ABORT"`. | `torClient.test.mjs` (abort during readiness, two callers); live over Tor: abort while waiting for headers rejected after 1.5 s (server answers at 10 s), abort during a pending body read after 0.3 s, client usable afterwards. |

Test environment results after the fixes, on Windows: `npm run test:unit` 445 passed (the five failures and fifteen cancellations above are gone); `cargo test --locked -p tor-js` 152 passed when linked against a locally built `sqlite3.lib` (`SQLITE3_LIB_DIR`, `SQLITE3_STATIC=1`). The two unit-suite failures were partly misdiagnosed above: besides `HOME` versus `USERPROFILE` and the file-URL import, Node 24 has `navigator.locks`, so `src/storage/locking.ts` took its browser path and lost the cross-process lock file; that is fixed in the source, not only in the tests. `scripts/build.sh` still cannot run on Windows (its `RUSTC_WRAPPER` is a shell script).

Found during validation and also fixed: Chromium sends a navigation to the network in parallel while it starts a stopped Service Worker, which leaked Tor-route URLs to the static host on cold starts (the Static Routing API rule under R1 stops it); and `FilesystemStorage.getAll` opened every cached file at once, failing with `EMFILE` on Windows once the directory cache was full. Seen but not investigated: a second Node run reusing the saved state of a first run that ended with `process.exit()` failed with "corrupted data in persistent state: Error setting up the guard manager".
