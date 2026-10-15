//! tor-js: WebAssembly bindings for arti-client
//!
//! This crate provides JavaScript bindings for making HTTP requests through Tor
//! using arti-client (the official Tor Project client library).
//!
//! # Example
//!
//! ```javascript
//! import { init, TorClient, TorClientOptions } from 'tor-js';
//!
//! // Initialize the WASM module
//! init();
//!
//! // Create client options with gateway URL
//! const options = new TorClientOptions(
//!   'https://tor-js-gateway.pse.dev'
//! );
//!
//! // Create the Tor client (async)
//! const client = await TorClient.create(options);
//!
//! // Make a fetch request through Tor
//! const response = await client.fetch('https://check.torproject.org/api/ip');
//! console.log(await response.text());
//!
//! // Clean up
//! await client.close();
//! ```

// The crate only *runs* on wasm32, but it also compiles for the host under
// `cfg(test)` so the pure logic — the bootstrap zip parser and the HTTP codec —
// is covered by a plain `cargo test` instead of needing a browser/Node harness.
#![cfg(any(target_arch = "wasm32", test))]

mod abort;
mod error;
mod fast_bootstrap;
mod fetch;
mod pow;
mod bridges;
// Hosting an onion service is a separate build (feature `onion-service-host`): see Cargo.toml.
#[cfg(feature = "onion-service-host")]
mod host;
#[cfg(feature = "onion-service-host")]
mod identity;
mod conn_pool;
mod runtime;
mod snapshot_policy;
mod snowflake;
mod storage;

pub use storage::{JsStorage, JsStorageInterface, CachedJsStorage};

use error::JsTorError;

use std::cell::RefCell;
use std::rc::Rc;
use std::collections::HashMap;
use std::sync::Arc;

use arti_client::config::CfgPath;
use arti_client::{TorClient as ArtiTorClient, TorClientConfig};
use serde::Deserialize;
use crate::runtime::{PtRoute, WasmRuntime};
use tracing::{debug, info, error};
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use wasm_bindgen::prelude::*;

// Global log callback (WASM is single-threaded, so thread_local is fine)
thread_local! {
    static LOG_CALLBACK: RefCell<Option<js_sys::Function>> = const { RefCell::new(None) };
    static LOG_LEVEL_HANDLE: RefCell<Option<tracing_subscriber::reload::Handle<
        tracing_subscriber::filter::LevelFilter,
        tracing_subscriber::Registry,
    >>> = const { RefCell::new(None) };
}

/// Parse a log level string into a `LevelFilter`.
fn parse_level(level: &str) -> Result<tracing_subscriber::filter::LevelFilter, JsValue> {
    match level {
        "trace" => Ok(tracing_subscriber::filter::LevelFilter::TRACE),
        "debug" => Ok(tracing_subscriber::filter::LevelFilter::DEBUG),
        "info" => Ok(tracing_subscriber::filter::LevelFilter::INFO),
        "warn" => Ok(tracing_subscriber::filter::LevelFilter::WARN),
        "error" => Ok(tracing_subscriber::filter::LevelFilter::ERROR),
        other => Err(JsValue::from_str(&format!(
            "Invalid log level: {:?}. Must be trace, debug, info, warn, or error.",
            other
        ))),
    }
}

// ============================================================================
// Initialization
// ============================================================================

/// Initialize the tor-js WASM module
///
/// This must be called before creating any TorClient instances.
/// Sets up panic hooks and logging infrastructure.
///
/// The optional `log_level` parameter sets the initial log level:
/// "trace", "debug", "info", "warn", or "error". Defaults to "debug".
/// The level can be changed later with `setLogLevel()`.
#[wasm_bindgen]
pub fn init(log_level: Option<String>) -> Result<(), JsValue> {
    // Set up panic handler for better error messages
    console_error_panic_hook::set_once();

    let initial_filter = match log_level.as_deref() {
        Some(level) => parse_level(level)?,
        None => tracing_subscriber::filter::LevelFilter::DEBUG,
    };

    // Create a reloadable filter so the level can be changed dynamically
    let (filter, reload_handle) = tracing_subscriber::reload::Layer::new(initial_filter);

    // Use try_init() to avoid panicking if init() is called more than once
    let _ = tracing_subscriber::registry()
        .with(filter)
        .with(JsLogLayer)
        .try_init();

    LOG_LEVEL_HANDLE.with(|h| {
        *h.borrow_mut() = Some(reload_handle);
    });

    Ok(())
}

/// Dynamically update the minimum log level.
///
/// Called from JS when the broadest requested level across all clients changes.
#[wasm_bindgen(js_name = setLogLevel)]
pub fn set_log_level(level: String) -> Result<(), JsValue> {
    let new_filter = parse_level(&level)?;
    LOG_LEVEL_HANDLE.with(|h| {
        if let Some(handle) = h.borrow().as_ref() {
            handle.modify(|filter| *filter = new_filter)
                .map_err(|e| JsValue::from_str(&format!("Failed to update log level: {}", e)))
        } else {
            Err(JsValue::from_str("init() must be called before setLogLevel()"))
        }
    })
}

/// Solve an onion service's proof-of-work puzzle (see `pow.rs`).
///
/// Meant to be called from a Web Worker that has loaded this WASM and is
/// dedicated to the puzzle: it runs until it finds a solution, which can take
/// minutes at a high effort, and the caller ends it by terminating the worker.
/// `blind_id` and `seed` are 32 bytes each, `start_nonce` 16 (a different random one
/// for each worker of a pool). Returns `{ nonce, effort, seedHead, proof }`, the
/// fields of the solution as `Uint8Array`s (and the effort as a number).
#[wasm_bindgen(js_name = powSolveV1)]
pub fn pow_solve_v1(blind_id: &[u8], seed: &[u8], effort: u32, start_nonce: &[u8]) -> Result<JsValue, JsValue> {
    fn array<const N: usize>(what: &str, bytes: &[u8]) -> Result<[u8; N], JsValue> {
        <[u8; N]>::try_from(bytes).map_err(|_| JsValue::from_str(&format!("{what} must be {N} bytes, got {}", bytes.len())))
    }
    let parts = pow::solve_v1(
        array::<32>("blind id", blind_id)?,
        array::<32>("seed", seed)?,
        effort,
        array::<16>("start nonce", start_nonce)?,
    )
    .map_err(|e| JsValue::from_str(&e))?;
    let out = js_sys::Object::new();
    let set = |key: &str, value: JsValue| js_sys::Reflect::set(&out, &JsValue::from_str(key), &value).map(|_| ());
    set("nonce", js_sys::Uint8Array::from(&parts.nonce[..]).into())?;
    set("effort", JsValue::from_f64(f64::from(parts.effort)))?;
    set("seedHead", js_sys::Uint8Array::from(&parts.seed_head[..]).into())?;
    set("proof", js_sys::Uint8Array::from(&parts.proof[..]).into())?;
    Ok(out.into())
}

/// Set a callback function to receive log messages
///
/// The callback receives three arguments: (level: string, target: string, message: string)
#[wasm_bindgen(js_name = setLogCallback)]
pub fn set_log_callback(callback: js_sys::Function) {
    LOG_CALLBACK.with(|cb| {
        *cb.borrow_mut() = Some(callback);
    });
}

/// Custom tracing layer that forwards logs to JavaScript
struct JsLogLayer;

impl<S> tracing_subscriber::Layer<S> for JsLogLayer
where
    S: tracing::Subscriber,
{
    fn on_event(
        &self,
        event: &tracing::Event<'_>,
        _ctx: tracing_subscriber::layer::Context<'_, S>,
    ) {
        // Extract event data
        let level = match *event.metadata().level() {
            tracing::Level::TRACE => "trace",
            tracing::Level::DEBUG => "debug",
            tracing::Level::INFO => "info",
            tracing::Level::WARN => "warn",
            tracing::Level::ERROR => "error",
        };
        let target = event.metadata().target();
        let mut visitor = MessageVisitor::default();
        event.record(&mut visitor);

        // Try to call the JavaScript callback
        LOG_CALLBACK.with(|cb| {
            if let Some(callback) = cb.borrow().as_ref() {
                let _ = callback.call3(
                    &JsValue::NULL,
                    &JsValue::from_str(level),
                    &JsValue::from_str(target),
                    &JsValue::from_str(&visitor.message),
                );
            } else {
                // Fall back to console.log if no callback set
                web_sys::console::log_1(&format!("[{}] {}: {}", level, target, visitor.message).into());
            }
        });
    }
}

/// Visitor to extract message from tracing events
#[derive(Default)]
struct MessageVisitor {
    message: String,
}

impl tracing::field::Visit for MessageVisitor {
    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        if field.name() == "message" {
            self.message = format!("{:?}", value);
            // Remove surrounding quotes if present
            self.message = self.message.trim_matches('"').to_string();
        } else if self.message.is_empty() {
            self.message = format!("{} = {:?}", field.name(), value);
        } else {
            self.message.push_str(&format!(", {} = {:?}", field.name(), value));
        }
    }

    fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
        if field.name() == "message" {
            self.message = value.to_string();
        } else if self.message.is_empty() {
            self.message = format!("{} = {}", field.name(), value);
        } else {
            self.message.push_str(&format!(", {} = {}", field.name(), value));
        }
    }
}

// ============================================================================
// TorClientOptions
// ============================================================================

/// Options for creating a TorClient
#[wasm_bindgen]
pub struct TorClientOptions {
    /// JS callback: `(addr: string) => Promise<RelaySocket>`
    /// The socket must have: send(Uint8Array), onmessage, onclose, close()
    connect: js_sys::Function,
    /// Custom storage implementation (optional)
    storage: Option<JsStorageInterface>,
    /// Optional callback returning bootstrap.zip bytes for fast directory pre-population
    fast_bootstrap: Option<js_sys::Function>,
    /// Bridge lines, plus an optional JS callback implementing transports
    /// other than the built-in ones (see `pt.rs`).
    bridges: Vec<String>,
    connect_pt: Option<js_sys::Function>,
    /// Creates WebRTC peers where `RTCPeerConnection` does not exist (a worker).
    rtc_peer_factory: Option<js_sys::Function>,
}

#[wasm_bindgen]
impl TorClientOptions {
    /// Create options with a connect function.
    ///
    /// The connect function receives a target address string (e.g. "198.51.100.1:9001")
    /// and must return a Promise resolving to a socket object with:
    /// - `send(data: Uint8Array)` — send binary data
    /// - `onmessage: ((data: Uint8Array) => void) | null` — receive callback
    /// - `onclose: (() => void) | null` — close notification
    /// - `close()` — close the socket
    ///
    /// The TS wrapper provides this automatically via the Gateway class.
    #[wasm_bindgen(constructor)]
    pub fn new(connect: js_sys::Function) -> Self {
        Self {
            connect,
            storage: None,
            fast_bootstrap: None,
            bridges: Vec::new(),
            connect_pt: None,
            rtc_peer_factory: None,
        }
    }

    /// Use these bridges (Tor `Bridge` line syntax, without the leading
    /// `Bridge` keyword) as the only guards. `snowflake` bridges are handled
    /// natively; other transport names they use are implemented by
    /// `connectPt(transport, settings, addr) => Promise<ArtiSocket>`.
    #[wasm_bindgen(js_name = withBridges)]
    pub fn with_bridges(mut self, lines: Vec<String>, connect_pt: Option<js_sys::Function>) -> Self {
        self.bridges = lines;
        self.connect_pt = connect_pt;
        self
    }

    /// Create the Snowflake WebRTC carrier's peer connections with `factory`
    /// instead of the global `RTCPeerConnection`, which workers do not have.
    /// `factory() => Promise<peer>`; see `snowflake/webrtc.rs` (`connect_remote`)
    /// for the peer contract.
    #[wasm_bindgen(js_name = withPeerFactory)]
    pub fn with_peer_factory(mut self, factory: js_sys::Function) -> Self {
        self.rtc_peer_factory = Some(factory);
        self
    }

    /// Set a custom storage implementation for persistent state.
    ///
    /// When set, the Tor client will persist guard selection and other state
    /// to this storage, allowing faster reconnection across page reloads.
    ///
    /// If not set, in-memory storage is used (state lost on page reload).
    ///
    /// # Arguments
    /// * `storage` - A JavaScript object implementing the TorStorage interface
    #[wasm_bindgen(js_name = withStorage)]
    pub fn with_storage(mut self, storage: JsStorageInterface) -> Self {
        self.storage = Some(storage);
        self
    }

    /// Set a callback that provides bootstrap.zip bytes for fast directory pre-population.
    ///
    /// The callback should be `() => Promise<Uint8Array>` returning the
    /// bootstrap archive from a tor-js-gateway server — either raw zip bytes
    /// or zstd-compressed (`bootstrap.zip.zst`); compression is auto-detected.
    ///
    /// When set and storage has no cached consensus, the zip is parsed and the
    /// directory cache is pre-populated before bootstrap begins.
    #[wasm_bindgen(js_name = withFastBootstrap)]
    pub fn with_fast_bootstrap(mut self, callback: js_sys::Function) -> Self {
        self.fast_bootstrap = Some(callback);
        self
    }
}

// ============================================================================
// TorClient
// ============================================================================

/// Tor client for making HTTP requests through the Tor network
#[wasm_bindgen]
pub struct TorClient {
    inner: Option<Arc<ArtiTorClient<WasmRuntime>>>,
    /// Keeps this client's Snowflake sessions alive; released by `close()` (see `snowflake::Lease`).
    snowflake_lease: Option<snowflake::Lease>,
    tls_config: Arc<futures_rustls::rustls::ClientConfig>,
    /// Connections kept open for this client's next requests. Per client, not per
    /// process: another client may have different settings, and must never be
    /// handed a stream that this one opened.
    idle: IdleConnections,
    /// The circuit group each host is being fetched on, for hosts where a request asked for `isolate` (see
    /// `fetch_impl`). Per client, like `idle`.
    circuits: HostCircuits,
}

#[wasm_bindgen]
impl TorClient {
    /// Create a new TorClient with the given options.
    ///
    /// This is an async operation that returns a Promise.
    /// The client will bootstrap and establish a connection to the Tor network.
    ///
    /// Usage from JS: `const client = await TorClient.create(options);`
    pub fn create(options: TorClientOptions) -> js_sys::Promise {
        wasm_bindgen_futures::future_to_promise(async move {
            let client = create_client(options).await?;
            Ok(JsValue::from(client))
        })
    }

    /// Make an HTTP fetch request through Tor
    ///
    /// Returns a Promise that resolves to a standard browser `Response` object
    /// as soon as response headers are received. The body is a `ReadableStream`
    /// that reads from the Tor circuit on demand.
    #[wasm_bindgen(js_name = fetch, skip_typescript)]
    pub fn fetch(&self, url: String, init: JsValue) -> js_sys::Promise {
        let client = match &self.inner {
            Some(c) => Arc::clone(c),
            None => {
                return wasm_bindgen_futures::future_to_promise(async {
                    Err(JsTorError::not_initialized().into_js_value())
                });
            }
        };

        let tls_config = Arc::clone(&self.tls_config);
        let idle = Rc::clone(&self.idle);
        let circuits = Rc::clone(&self.circuits);
        wasm_bindgen_futures::future_to_promise(async move {
            fetch_impl(&client, &url, init, tls_config, idle, circuits).await
        })
    }

    /// Wait until the client is ready for traffic (connection usable + valid directory).
    #[wasm_bindgen(js_name = ready)]
    pub fn ready(&self) -> js_sys::Promise {
        let client = match &self.inner {
            Some(c) => Arc::clone(c),
            None => {
                return wasm_bindgen_futures::future_to_promise(async {
                    Err(JsTorError::not_initialized().into_js_value())
                });
            }
        };

        wasm_bindgen_futures::future_to_promise(async move {
            use futures::StreamExt;

            // Fast path: already ready
            if client.bootstrap_status().ready_for_traffic() {
                return Ok(JsValue::undefined());
            }

            // Poll bootstrap events until ready
            let mut events = client.bootstrap_events();
            while let Some(status) = events.next().await {
                if status.ready_for_traffic() {
                    return Ok(JsValue::undefined());
                }
            }

            Err(JsTorError::bootstrap(
                "Client failed to become ready for traffic"
            ).into_js_value())
        })
    }

    /// Close the TorClient and release resources
    #[wasm_bindgen(js_name = close)]
    pub fn close(&mut self) -> js_sys::Promise {
        // Stop everything arti spawned: dropping our handle alone leaves its background tasks (and the
        // timers they sleep on, which keep a Node process alive) running.
        if let Some(client) = self.inner.take() {
            client.runtime().shutdown();
        }
        self.idle.borrow_mut().clear();
        self.circuits.borrow_mut().clear();
        // Let go of this client's Snowflake sessions, including spares parked for it.
        self.snowflake_lease = None;
        wasm_bindgen_futures::future_to_promise(async {
            info!("TorClient closed");
            Ok(JsValue::undefined())
        })
    }
}

/// Create a TorClient with the given options
async fn create_client(options: TorClientOptions) -> Result<TorClient, JsValue> {
    debug!("tor-js {} (git: {})", env!("TOR_JS_VERSION"), env!("TOR_JS_GIT_INFO"));
    info!("Creating TorClient");

    // 1. Configure arti-client (no bridge — connects to regular relays via JS connect callback)
    let mut config_builder = TorClientConfig::builder();

    // Storage paths (required by config validation, but not used on WASM)
    config_builder
        .storage()
        .cache_dir(CfgPath::new("/wasm/cache".to_owned()))
        .state_dir(CfgPath::new("/wasm/state".to_owned()));

    // Bridges become the only guards. Lines naming a transport are split into
    // a plain bridge for arti and a route the runtime follows (bridges.rs).
    let mut pt_routes = HashMap::new();
    let mut snowflakes = Vec::new();
    for line in &options.bridges {
        let config_err = |e: String| JsTorError::config(format!("Bad bridge line {:?}: {}", line, e)).into_js_value();
        let parsed = bridges::parse(line).map_err(config_err)?;
        let bridge: arti_client::config::BridgeConfigBuilder =
            parsed.plain.parse().map_err(|e| config_err(format!("{e}")))?;
        config_builder.bridges().bridges().push(bridge);

        let Some(t) = parsed.transport else { continue };
        let route = if t.name == snowflake::TRANSPORT_NAME {
            let config = snowflake::CarrierConfig::from_settings(&t.settings).map_err(config_err)?;
            snowflakes.push(config.clone());
            PtRoute::Snowflake(config)
        } else if let Some(connect_pt) = &options.connect_pt {
            PtRoute::Js { transport: t.name, settings: t.settings, connect_pt: connect_pt.clone() }
        } else {
            return Err(config_err(format!("unsupported transport {:?}", t.name)));
        };
        if pt_routes.insert(t.addr, route).is_some() {
            return Err(config_err(format!("address {} is used by another bridge", t.addr)));
        }
    }
    if !options.bridges.is_empty() {
        info!("Using {} bridge(s)", options.bridges.len());
    }

    // Floor for arti's circuit-build timeout. Its estimator starts from what it
    // learned in earlier runs (state:circuit_timeouts) and can settle on a few
    // hundred ms; over a Snowflake proxy with a 300-1500 ms round trip per hop
    // such a circuit is abandoned before it can finish, and each abandoned one
    // counts as a failure against the only guard. Tor's own default is 10 ms,
    // meant for fast links.
    if !options.bridges.is_empty() {
        config_builder
            .override_net_params()
            .insert("cbtmintimeout".to_owned(), CIRCUIT_TIMEOUT_FLOOR_MS);
    }

    let config = config_builder
        .build()
        .map_err(|e| JsTorError::config(format!("Failed to build config: {}", e)).into_js_value())?;

    if let Some(factory) = options.rtc_peer_factory {
        snowflake::set_peer_factory(factory);
    }

    // Start the Snowflake session now, before storage is read: a WebRTC session
    // needs a broker match and ICE, which take seconds, and reading the cached
    // directory takes seconds of its own (2.2 s in a measured start). Doing them
    // one after the other made the start-up their sum. The result is awaited
    // below, before arti dials: its channel timeout (5s, handshake included) is
    // shorter than a WebRTC broker match.
    // Held until the client is closed (or this function fails): the pool of Snowflake sessions is global,
    // and releases the sessions it parked once no lease is left.
    let snowflake_lease = (!snowflakes.is_empty()).then(snowflake::Lease::new);
    let session_warmup = if snowflakes.is_empty() {
        None
    } else {
        let (tx, rx) = futures::channel::oneshot::channel();
        let started = web_time_compat::Instant::now();
        info!("Snowflake: opening a session (in parallel with storage initialisation)...");
        let configs = snowflakes.clone();
        wasm_bindgen_futures::spawn_local(async move {
            let results = futures::future::join_all(configs.into_iter().map(snowflake::warm)).await;
            let _ = tx.send(results);
        });
        Some((rx, started))
    };

    // 2. Create WASM runtime with JS connect function
    let mut runtime = WasmRuntime::default();
    runtime.set_connect_fn(options.connect);
    runtime.set_pt_routes(pt_routes);

    // 3. Build the client with optional custom storage
    let mut builder = ArtiTorClient::with_runtime(runtime).config(config);

    if let Some(js_storage_interface) = options.storage {
        info!("Initializing JS storage...");
        let js_storage = JsStorage::new(js_storage_interface);

        let cached_storage = CachedJsStorage::new(js_storage)
            .await
            .map_err(|e| {
                JsTorError::internal(format!("Failed to initialize storage: {:?}", e)).into_js_value()
            })?;

        // Pre-populate directory cache from fast bootstrap if available and storage is empty
        if let Some(callback) = options.fast_bootstrap {
            if let Err(e) = fast_bootstrap::maybe_fast_bootstrap(&cached_storage, callback).await {
                tracing::warn!("Fast bootstrap failed (continuing normally): {:?}", e);
            }
        }

        builder = builder.storage(cached_storage);
        info!("Storage configured (state + directory cache)");
    } else {
        error!("Storage not configured");
    }

    let tor_client = builder
        .create_unbootstrapped()
        .map_err(|e| JsTorError::internal(format!("Failed to create client: {}", e)).into_js_value())?;

    info!("TorClient created (unbootstrapped)");

    // Have the Snowflake session ready before arti dials (see above).
    if let Some((rx, started)) = session_warmup {
        use futures::future::{select, Either};
        let limit = std::pin::pin!(gloo_timers::future::TimeoutFuture::new(60_000));
        match select(rx, limit).await {
            Either::Left((Ok(results), _)) => {
                for e in results.into_iter().filter_map(Result::err) {
                    tracing::warn!("Snowflake: could not open a session ahead of bootstrap: {e}");
                }
                info!("Snowflake: ready after {:.1}s", started.elapsed().as_secs_f64());
            }
            Either::Left((Err(_), _)) => tracing::warn!("Snowflake: the session task ended without a result; bootstrapping anyway"),
            Either::Right(_) => tracing::warn!("Snowflake: no session after 60s; bootstrapping anyway"),
        }
    }

    // 4. Bootstrap the client (connects to directory authorities via WS proxy)
    info!("Bootstrapping Tor client...");
    tor_client
        .bootstrap()
        .await
        .map_err(|e| JsTorError::bootstrap(format!("Bootstrap failed: {}", e)).into_js_value())?;
    info!("Bootstrap complete!");

    // With bridges, bootstrap can finish from a cached directory (a hosted
    // snapshot, a return visit) before arti has fetched the bridge's own
    // descriptor, and until it has, no circuit can use the bridge. Exit
    // circuits retry through that window but onion-service connections fail
    // at once, so wait for a first circuit through the bridge. arti keeps it
    // for exit traffic, so the work is not wasted.
    if !options.bridges.is_empty() {
        wait_for_bridge_circuit(&tor_client).await;
    }

    Ok(TorClient {
        inner: Some(tor_client),
        snowflake_lease,
        tls_config: make_tls_config(),
        idle: Rc::new(RefCell::new(conn_pool::IdlePool::new(POOL_MAX_PER_HOST, POOL_MAX_TOTAL))),
        circuits: Rc::new(RefCell::new(HashMap::new())),
    })
}

/// Lowest circuit-build timeout (ms) used when connecting through bridges.
/// In six cold starts with it every one reached a circuit; in three without it
/// two ended with the bridge disabled for "mysterious" circuit deaths, both on
/// a slow proxy.
const CIRCUIT_TIMEOUT_FLOOR_MS: i32 = 7_000;

/// Wait (up to a minute) until arti can build a circuit through its bridge.
/// Failure is only logged: the caller's own requests will report it.
async fn wait_for_bridge_circuit(tor_client: &ArtiTorClient<WasmRuntime>) {
    use futures::future::{select, Either};

    let started = web_time_compat::Instant::now();
    let circuit = std::pin::pin!(async {
        let netdir = tor_client.dirmgr().map_err(|e| e.to_string())?.timely_netdir().map_err(|e| e.to_string())?;
        tor_client
            .circmgr()
            .map_err(|e| e.to_string())?
            .get_or_launch_exit(
                tor_circmgr::DirInfo::Directory(&netdir),
                &[],
                tor_circmgr::isolation::StreamIsolation::no_isolation(),
            )
            .await
            .map_err(|e| e.to_string())?;
        Ok::<_, String>(())
    });
    let limit = std::pin::pin!(gloo_timers::future::TimeoutFuture::new(60_000));
    match select(circuit, limit).await {
        Either::Left((Ok(()), _)) => {
            info!("First circuit through the bridge after {:.1}s", started.elapsed().as_secs_f64());
        }
        Either::Left((Err(e), _)) => tracing::warn!("No circuit through the bridge yet: {e}"),
        Either::Right(_) => tracing::warn!("No circuit through the bridge after 60s"),
    }
}

/// Build a rustls ClientConfig with the Mozilla CA bundle (compiled in via webpki-roots)
/// and the pure-Rust crypto provider (rustls-rustcrypto) for WASM compatibility.
fn make_tls_config() -> Arc<futures_rustls::rustls::ClientConfig> {
    use futures_rustls::rustls;

    let provider = rustls_rustcrypto::provider();
    let mut root_store = rustls::RootCertStore::empty();
    root_store.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());

    let mut config = rustls::ClientConfig::builder_with_provider(provider.into())
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_root_certificates(root_store)
        .with_no_client_auth();

    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Arc::new(config)
}

// ============================================================================
// Fetch Implementation
// ============================================================================

/// Fetch init options from JavaScript
#[derive(Debug, Default, Deserialize)]
struct FetchInit {
    method: Option<String>,
    headers: Option<HashMap<String, String>>,
    /// Carry this request on a circuit of its own (see `TorClient.fetch`'s `isolate`).
    isolate: Option<bool>,
    // `body` is a JS object (bytes or a ReadableStream), not serde-decodable —
    // extracted separately via extract_body_from_js.
}

// ----------------------------------------------------------------------------
// Connection reuse
// ----------------------------------------------------------------------------

/// How long a connection waits in the pool when the server did not say. Short
/// enough that it is rarely closed by the server meanwhile (a Gunicorn default is
/// 2 s, most others 5 s or more; an announced `Keep-Alive: timeout` overrides).
const POOL_IDLE_MS: f64 = 15_000.0;
/// Keep-alive timeouts are cut by this much, so a connection is not offered in
/// the last moments before the server closes it.
const POOL_IDLE_MARGIN_MS: f64 = 1_000.0;
const POOL_MAX_PER_HOST: usize = 6;
const POOL_MAX_TOTAL: usize = 16;

/// The isolation group a host's requests use once one of them asked for `isolate`, keyed by `host:port`.
type HostCircuits = Rc<RefCell<HashMap<String, arti_client::IsolationToken>>>;

/// One client's idle connections (see `TorClient::idle`).
type IdleConnections = Rc<RefCell<conn_pool::IdlePool<fetch::BoxedConn>>>;

thread_local! {
    static POOL_EPOCH: web_time_compat::Instant = web_time_compat::Instant::now();
}

fn pool_now_ms() -> f64 {
    POOL_EPOCH.with(|e| e.elapsed().as_secs_f64() * 1000.0)
}

/// A function that puts a finished connection back for `host:port`.
fn release_to_pool(pool: IdleConnections, host: String, port: u16) -> fetch::ReleaseFn {
    Box::new(move |conn, announced_secs| {
        let now = pool_now_ms();
        let idle = match announced_secs {
            Some(secs) => (f64::from(secs) * 1000.0 - POOL_IDLE_MARGIN_MS).clamp(0.0, POOL_IDLE_MS),
            None => POOL_IDLE_MS,
        };
        debug!("Keeping the connection to {host}:{port} for reuse (up to {:.0}s)", idle / 1000.0);
        pool.borrow_mut().put(&host, port, conn, now, now + idle);
    })
}

/// A pooled connection for `host:port` that is still open, if there is one.
async fn take_idle_connection(pool: &IdleConnections, host: &str, port: u16) -> Option<fetch::BoxedConn> {
    use futures::io::AsyncReadExt;
    loop {
        let mut conn = pool.borrow_mut().take(host, port, pool_now_ms())?;
        // A connection the server has closed since it was put back reads as
        // ended (or as an error) at once; one that is still open has nothing to
        // read yet. Anything else (stray bytes) is not a connection to trust.
        let mut probe = [0u8; 1];
        if futures::future::poll_immediate(conn.read(&mut probe)).await.is_none() {
            return Some(conn);
        }
        debug!("Dropping a pooled connection to {host}:{port} that the server closed");
    }
}

/// Perform a fetch request, returning a real browser `Response` object.
///
/// The Response is created as soon as headers arrive. Its body is a
/// `ReadableStream` that reads decoded body bytes from the Tor circuit
/// on demand (handling Content-Length, chunked, and EOF framing).
async fn fetch_impl(
    client: &ArtiTorClient<WasmRuntime>,
    url_str: &str,
    init: JsValue,
    tls_config: Arc<futures_rustls::rustls::ClientConfig>,
    idle: IdleConnections,
    circuits: HostCircuits,
) -> Result<JsValue, JsValue> {
    // Parse URL
    let url = url::Url::parse(url_str)
        .map_err(|e| JsTorError::new("INVALID_URL", "validation", e.to_string(), false).into_js_value())?;

    // Parse fetch options
    let fetch_init: FetchInit = if init.is_undefined() || init.is_null() {
        FetchInit::default()
    } else {
        serde_wasm_bindgen::from_value(init.clone())
            .map_err(|e| JsTorError::new("INVALID_OPTIONS", "validation", e.to_string(), false).into_js_value())?
    };

    // Extract body and signal separately (JS objects; not handled by serde).
    let request_body = if init.is_undefined() || init.is_null() {
        fetch::RequestBody::None
    } else {
        extract_body_from_js(&init)?
    };
    let signal = extract_signal_from_js(&init)?;

    // Parse method (normalize to uppercase per Fetch spec)
    let method_upper = fetch_init.method.as_deref().map(str::to_ascii_uppercase);
    let method = match method_upper.as_deref() {
        Some("GET") | None => http::Method::GET,
        Some("POST") => http::Method::POST,
        Some("PUT") => http::Method::PUT,
        Some("DELETE") => http::Method::DELETE,
        Some("HEAD") => http::Method::HEAD,
        Some("OPTIONS") => http::Method::OPTIONS,
        Some("PATCH") => http::Method::PATCH,
        Some(other) => {
            return Err(JsTorError::new(
                "INVALID_METHOD",
                "validation",
                format!("Unsupported HTTP method: {}", other),
                false,
            )
            .into_js_value());
        }
    };

    let headers = fetch_init.headers.unwrap_or_default();

    // Get host and port
    let host = url
        .host_str()
        .ok_or_else(|| JsTorError::new("INVALID_URL", "validation", "No host in URL", false).into_js_value())?;
    let port = url
        .port_or_known_default()
        .ok_or_else(|| JsTorError::new("INVALID_URL", "validation", "No port in URL", false).into_js_value())?;
    let is_https = url.scheme() == "https";

    info!("Fetching {} via Tor ({}:{})", url, host, port);

    // Check abort before connecting (circuit building can take several seconds)
    check_aborted(signal.as_ref())?;
    // From here on an abort is noticed while a step is waiting, not only between steps.
    let mut abort = signal.map(abort::AbortWatch::new);
    let head_request = method == http::Method::HEAD;

    // A request that may keep its connection first looks for one already open.
    // Reusing skips the round trip to the far end that opening a stream costs.
    let keep_alive = fetch::wants_keep_alive(&url, &method, &headers, &request_body);
    // A kept HTTPS connection is a TLS session; it must never be handed to a plain HTTP request (or the reverse)
    // for the same host and port, so the pool is keyed by scheme as well.
    let pool_host = if is_https { format!("https:{host}") } else { host.to_owned() };

    // `isolate` (a retry after a failure at the exit) asks for a circuit group this host has not used: Arti then
    // builds or picks a circuit that none of the host's earlier requests used, so the retry can reach the site
    // through a different exit. Once such a connection succeeds the group is remembered, so the rest of the page's
    // requests to the host follow the circuit that worked rather than the shared one that did not, and the
    // connections kept from the old group are dropped. A group whose connection failed is not remembered.
    let circuit_key = format!("{host}:{port}");
    let fresh_group = fetch_init.isolate.unwrap_or(false).then(arti_client::IsolationToken::new);

    let connect = || async {
        debug!("Connecting to {}:{}...", host, port);
        let mut prefs = arti_client::StreamPrefs::new();
        let remembered = circuits.borrow().get(&circuit_key).copied();
        if let Some(group) = fresh_group.or(remembered) {
            prefs.set_isolation(group);
        }
        let stream = client
            .connect_with_prefs((host, port), &prefs)
            .await
            .map_err(|e| JsTorError::connection(format!("Failed to connect: {}", e)).into_js_value())?;
        if let Some(group) = fresh_group {
            circuits.borrow_mut().insert(circuit_key.clone(), group);
            let mut pool = idle.borrow_mut();
            pool.remove(host, port);
            pool.remove(&format!("https:{host}"), port);
        }
        Ok::<fetch::BoxedConn, JsValue>(Box::new(stream))
    };
    let release = || keep_alive.then(|| release_to_pool(Rc::clone(&idle), pool_host.clone(), port));

    // Perform the HTTP request — resolves as soon as headers arrive. Raced as a
    // whole against the abort signal: connecting, TLS, the upload and waiting for
    // the response head are all cut short, and an abort can never be followed by
    // the retry on a fresh connection below.
    let exchange = async {
        // (An isolated request wants a circuit of its own, so it never takes a kept connection.)
        let pooled = if keep_alive && fresh_group.is_none() { take_idle_connection(&idle, &pool_host, port).await } else { None };
        match pooled {
            Some(conn) => {
                info!("Reusing an open connection to {}:{}", host, port);
                // The request is a GET or HEAD without a body, so sending it again is
                // safe: if the reused connection fails (the server closed it just as
                // it was picked), the request goes out once more on a new one.
                // (A pooled HTTPS connection already carries its TLS session: `is_https` is false here.)
                match fetch::fetch_headers(conn, &url, method.clone(), headers.clone(), fetch::RequestBody::None, false, host, Some(tls_config.clone()), release()).await {
                    Ok(result) => Ok(result),
                    Err(e) => {
                        info!("A reused connection failed ({}); retrying on a new one", e.message);
                        let stream = connect().await?;
                        fetch::fetch_headers(stream, &url, method, headers, request_body, is_https, host, Some(tls_config), release())
                            .await
                            .map_err(|e| e.into_js_value())
                    }
                }
            }
            None => {
                let stream = connect().await?;
                debug!("Connected, making HTTP request...");
                fetch::fetch_headers(stream, &url, method, headers, request_body, is_https, host, Some(tls_config), release())
                    .await
                    .map_err(|e| e.into_js_value())
            }
        }
    };
    let result = match abort.as_mut() {
        Some(watch) => watch.guard(exchange).await?,
        None => exchange.await?,
    };

    // Build web_sys::Headers from the parsed headers
    let js_headers = web_sys::Headers::new()
        .map_err(|e| JsTorError::internal(format!("Failed to create Headers: {:?}", e)).into_js_value())?;
    for (key, value) in &result.headers {
        // `Headers` rejects values that are not ByteStrings (e.g. a stray
        // non-Latin-1 character some servers send). One odd header must not
        // lose the whole response, so skip it — as browsers do.
        if let Err(e) = js_headers.append(key, value) {
            tracing::warn!("Dropping response header {:?} the Headers API rejects: {:?}", key, e);
        }
    }

    // The Response constructor throws for any body, even an empty stream, with
    // status 204, 205 or 304, and a HEAD response has none: those get a null body.
    let raw_readable: Option<web_sys::ReadableStream> = if response_has_body(head_request, result.status) {
        // Convert BodyReader → futures::Stream → JS ReadableStream. Each read is
        // raced against the abort signal, so a read already waiting for data ends
        // at once; after an error (an abort included) the reader is dropped, which
        // closes the Tor stream, and nothing more is read.
        let body_stream = futures::stream::unfold(Some((result.body_reader, abort)), |state| async move {
            let (mut reader, mut abort) = state?;
            let read = async { reader.read_chunk().await.map_err(|e| e.into_js_value()) };
            let read = match abort.as_mut() {
                Some(watch) => watch.guard(read).await,
                None => read.await,
            };
            match read {
                Ok(Some(chunk)) => {
                    let arr = js_sys::Uint8Array::from(&chunk[..]);
                    Some((Ok(arr.into()), Some((reader, abort))))
                }
                Ok(None) => None,
                Err(e) => Some((Err(e), None)),
            }
        });
        Some(wasm_streams::ReadableStream::from_stream(body_stream).into_raw())
    } else {
        drain_unused_body(result.body_reader);
        None
    };

    // Create ResponseInit with status + headers
    let response_init = web_sys::ResponseInit::new();
    response_init.set_status(result.status);
    response_init.set_headers(&js_headers.into());

    // Create the real browser Response
    let response = web_sys::Response::new_with_opt_readable_stream_and_init(
        raw_readable.as_ref(),
        &response_init,
    )
    .map_err(|e| JsTorError::internal(format!("Failed to create Response: {:?}", e)).into_js_value())?;

    // The Response constructor silently drops forbidden response headers such
    // as Set-Cookie, so a caller that keeps its own cookie jar (the site
    // adapter in src/site/) could never see them. Hand over the header list
    // exactly as parsed: name/value pairs in wire order, repeats kept.
    let raw_headers = js_sys::Array::new();
    for (key, value) in &result.headers {
        let pair = js_sys::Array::of2(&JsValue::from_str(key), &JsValue::from_str(value));
        raw_headers.push(&pair);
    }
    let _ = js_sys::Reflect::set(&response, &JsValue::from_str("rawHeaders"), &raw_headers);

    Ok(response.into())
}

/// Whether a response can be given a body in JavaScript. A HEAD response has
/// none, and the Fetch standard's `Response` constructor refuses a body, even an
/// empty one, for the "null body statuses" 101, 204, 205 and 304.
fn response_has_body(head_request: bool, status: u16) -> bool {
    !head_request && !matches!(status, 101 | 204 | 205 | 304)
}

/// The most a response without a body may still put on the connection before it is closed instead.
const UNUSED_BODY_LIMIT: usize = 64 * 1024;
/// How long reading it may take.
const UNUSED_BODY_TIMEOUT_MS: u32 = 10_000;

/// Read off whatever a response that JavaScript gets no body for still sent
/// (nothing, for HEAD, 204 and 304; normally nothing for 205, whose framing the
/// server chooses), so that a keep-alive connection reaches its exact end and
/// goes back to the pool. A server that sends a body anyway, or never finishes,
/// gets its connection closed (dropped) after a bound.
fn drain_unused_body(mut reader: fetch::BodyReader) {
    wasm_bindgen_futures::spawn_local(async move {
        let drain = async {
            let mut seen = 0usize;
            while let Ok(Some(chunk)) = reader.read_chunk().await {
                seen += chunk.len();
                if seen > UNUSED_BODY_LIMIT {
                    break;
                }
            }
        };
        let drain = std::pin::pin!(drain);
        futures::future::select(drain, gloo_timers::future::TimeoutFuture::new(UNUSED_BODY_TIMEOUT_MS)).await;
    });
}

/// Extract body from JavaScript FetchInit object
fn extract_body_from_js(init: &JsValue) -> Result<fetch::RequestBody, JsValue> {
    let body = js_sys::Reflect::get(init, &JsValue::from_str("body"))
        .map_err(|e| JsTorError::new("INVALID_OPTIONS", "validation", format!("Failed to get body: {:?}", e), false).into_js_value())?;

    if body.is_undefined() || body.is_null() {
        return Ok(fetch::RequestBody::None);
    }

    // Handle string body
    if let Some(s) = body.as_string() {
        return Ok(fetch::RequestBody::Bytes(s.into_bytes()));
    }

    // Handle Uint8Array
    if let Ok(arr) = body.clone().dyn_into::<js_sys::Uint8Array>() {
        return Ok(fetch::RequestBody::Bytes(arr.to_vec()));
    }

    // Handle ArrayBuffer
    if let Ok(buf) = body.clone().dyn_into::<js_sys::ArrayBuffer>() {
        let arr = js_sys::Uint8Array::new(&buf);
        return Ok(fetch::RequestBody::Bytes(arr.to_vec()));
    }

    // Handle a ReadableStream<Uint8Array> — streamed with chunked encoding, so
    // a large upload isn't buffered. Backpressure rides the underlying stream.
    if let Ok(rs) = body.clone().dyn_into::<web_sys::ReadableStream>() {
        use futures::StreamExt;
        let chunks = wasm_streams::ReadableStream::from_raw(rs)
            .into_stream()
            .map(|item| match item {
                Ok(chunk) => chunk
                    .dyn_into::<js_sys::Uint8Array>()
                    .map(|a| a.to_vec())
                    .map_err(|_| JsTorError::http_request(
                        "request body stream must yield Uint8Array chunks",
                    )),
                Err(e) => Err(JsTorError::http_request(format!(
                    "request body stream error: {:?}",
                    e
                ))),
            });
        return Ok(fetch::RequestBody::Stream(Box::pin(chunks)));
    }

    Err(JsTorError::new(
        "INVALID_BODY",
        "validation",
        "Body must be a string, Uint8Array, ArrayBuffer, or ReadableStream",
        false,
    )
    .into_js_value())
}

/// Extract an AbortSignal from a JavaScript FetchInit object.
fn extract_signal_from_js(init: &JsValue) -> Result<Option<web_sys::AbortSignal>, JsValue> {
    if init.is_undefined() || init.is_null() {
        return Ok(None);
    }
    let signal = js_sys::Reflect::get(init, &JsValue::from_str("signal"))
        .map_err(|e| JsTorError::new("INVALID_OPTIONS", "validation", format!("Failed to get signal: {:?}", e), false).into_js_value())?;
    if signal.is_undefined() || signal.is_null() {
        return Ok(None);
    }
    signal
        .dyn_into::<web_sys::AbortSignal>()
        .map(Some)
        .map_err(|_| JsTorError::new("INVALID_OPTIONS", "validation", "signal must be an AbortSignal", false).into_js_value())
}

/// Return an abort error if the signal has already been triggered.
fn check_aborted(signal: Option<&web_sys::AbortSignal>) -> Result<(), JsValue> {
    if let Some(s) = signal {
        if s.aborted() {
            return Err(JsTorError::aborted().into_js_value());
        }
    }
    Ok(())
}

// ============================================================================
// TypeScript definitions
// ============================================================================

#[wasm_bindgen(typescript_custom_section)]
const TS_TYPES: &str = r#"
/**
 * Storage interface for persisting Tor client state.
 *
 * Implement this interface to provide custom storage (IndexedDB, filesystem, etc.).
 * All methods must return Promises.
 *
 * When storage is provided, the Tor client will persist guard selection and other
 * state, allowing faster reconnection across page reloads.
 *
 * @example
 * ```typescript
 * class IndexedDBStorage implements TorStorage {
 *   async get(key: string): Promise<string | null> {
 *     // Load from IndexedDB
 *   }
 *   async set(key: string, value: string): Promise<void> {
 *     // Save to IndexedDB
 *   }
 *   async delete(key: string): Promise<void> {
 *     // Delete from IndexedDB
 *   }
 *   async keys(prefix: string): Promise<string[]> {
 *     // List keys matching prefix
 *   }
 *   async tryLock(): Promise<boolean> {
 *     // addLocking is available in tor-js to solve locking with in-memory
 *     // overlay
 *     // true:   newly acquired
 *     // false:  already held
 *     // reject: couldn't lock
 *   }
 *   async unlock(): Promise<void> {
 *   }
 * }
 *
 * const options = new TorClientOptions(gatewayUrl)
 *   .withStorage(new IndexedDBStorage());
 * const client = await TorClient.create(options);
 * ```
 */
export interface TorStorage {
    /**
     * Get a value by key.
     * @param key - The storage key
     * @returns The stored value as a string, or null if not found
     */
    get(key: string): Promise<string | null>;

    /**
     * Get all key-value pairs matching a prefix.
     * @param prefix - The key prefix to match
     * @returns Array of [key, value] pairs
     */
    getAll(prefix: string): Promise<[string, string][]>;

    /**
     * Set a value by key.
     * @param key - The storage key
     * @param value - The value to store (JSON string)
     */
    set(key: string, value: string): Promise<void>;

    /**
     * Delete a value by key.
     * @param key - The storage key
     */
    delete(key: string): Promise<void>;

    /**
     * List all keys with a given prefix.
     * @param prefix - The key prefix to match
     * @returns Array of matching keys
     */
    keys(prefix: string): Promise<string[]>;

    /**
     * Try to acquire an exclusive write lock.
     * @returns true if newly acquired, false if already held.
     * Implement using Web Locks API (browser) or lock files (Node.js).
     */
    tryLock(): Promise<boolean>;

    /**
     * Release the write lock.
     */
    unlock(): Promise<void>;
}

export interface FetchInit {
    method?: string;
    headers?: Record<string, string>;
    body?: string | Uint8Array | ArrayBuffer | ReadableStream<Uint8Array>;
    signal?: AbortSignal;
}

export interface TorClient {
    /** Make an HTTP fetch request through Tor. Returns a standard Response. */
    fetch(url: string, init?: FetchInit): Promise<Response>;
    close(): Promise<void>;
}

export interface TorClientOptions {
    /**
     * Set a custom storage implementation for persistent state.
     * If not provided, in-memory storage is used (state lost on page reload).
     */
    withStorage(storage: TorStorage): TorClientOptions;
}
"#;

#[cfg(test)]
mod tests {
    use super::response_has_body;

    #[test]
    fn null_body_statuses_get_no_body() {
        for status in [101, 204, 205, 304] {
            assert!(!response_has_body(false, status), "status {status}");
        }
    }

    #[test]
    fn a_head_response_gets_no_body_whatever_its_status() {
        for status in [200, 404, 500] {
            assert!(!response_has_body(true, status), "status {status}");
        }
    }

    #[test]
    fn other_responses_keep_their_body() {
        for status in [200, 201, 206, 301, 302, 400, 404, 500, 502] {
            assert!(response_has_body(false, status), "status {status}");
        }
    }
}
