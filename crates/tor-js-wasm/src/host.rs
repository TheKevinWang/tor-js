//! Hosting an onion service: `TorClient.listen()`.
//!
//! An onion service is a server reachable only through Tor, at an address ending in `.onion`.
//! It never accepts inbound connections: it dials out to Tor relays (so a browser can host one),
//! publishes where visitors can reach it, and each visitor's circuit is joined to one of its own.
//! arti, the Tor implementation tor-js is built on, has the service half (`tor-hsservice`); this
//! file wires it to a running `TorClient` and to JavaScript. See
//! `.agent/onion-service-host-execplan.md` for the design and its limits.
//!
//! - The service's identity is a 32-byte seed the page keeps (`identity.rs`). It is loaded into
//!   an in-memory keystore for the life of the service.
//! - Everything else the service remembers is in memory too (the vendored `tor-hsservice`,
//!   `crates/patches/tor-hsservice/PATCH.md`), so a restarted host picks new introduction points.
//! - Visitors arrive as `OnionConnection`s: a duplex byte stream. HTTP on top of it is written in
//!   TypeScript (`src/host/http.ts`).

use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::sync::Arc;

use arti_client::TorClient as ArtiTorClient;
use futures::StreamExt;
use futures::channel::mpsc;
use futures::future::{AbortHandle, Abortable};
use futures::io::{AsyncReadExt, AsyncWriteExt};
use futures::lock::Mutex;
use tor_cell::relaycell::msg::{Connected, End, EndReason};
use tor_config_path::CfgPathResolver;
use tor_hsservice::config::OnionServiceConfigBuilder;
use tor_hsservice::mem_state::StateDirectory;
use tor_hsservice::{
    HsIdKeypairSpecifier, HsNickname, OnionService, RunningOnionService, StreamRequest,
    handle_rend_requests,
};
use tor_hscrypto::pk::HsIdKeypair;
use tor_keymgr::{ArtiEphemeralKeystore, KeyMgrBuilder, KeystoreSelector};
use tor_proto::client::stream::{DataReader, DataWriter};
use tor_proto::stream::IncomingStreamRequest;
use tracing::{debug, info, warn};
use wasm_bindgen::prelude::*;

use crate::error::JsTorError;
use crate::identity;
use crate::runtime::WasmRuntime;
use crate::TorClient;

/// The name arti uses internally for the one service a `listen()` call hosts. It is never shown
/// to anyone: the address comes from the identity key.
const NICKNAME: &str = "tor-js-host";

/// Visitors held open at once when the caller does not say.
const DEFAULT_MAX_CONNECTIONS: usize = 32;

/// The port visitors connect to when the caller does not say (the one `http://` uses).
const DEFAULT_PORT: u16 = 80;

/// How many bytes one `read()` returns at most.
const READ_CHUNK: usize = 16 * 1024;

/// An error the caller can match on: `kind` is `host`.
fn host_err(code: &str, message: impl Into<String>) -> JsValue {
    JsTorError::new(code, "host", message, false).into_js_value()
}

/// The address `identity` (a 32-byte seed) hosts at, without going online.
///
/// Exported to JavaScript as `onionAddressFor`.
#[wasm_bindgen(js_name = onionAddressFor)]
pub fn onion_address_for(identity: &[u8]) -> Result<String, JsValue> {
    identity::onion_address_for_seed(identity).map_err(|m| host_err("BAD_IDENTITY", m))
}

/// What a `listen()` caller asked for.
struct ListenOptions {
    /// The identity seed.
    seed: Vec<u8>,
    /// Ports visitors may connect to; a visitor asking for another is turned away.
    ports: Vec<u16>,
    /// The most visitors held open at once; more are turned away.
    max_connections: usize,
}

/// Read `{ identity: Uint8Array, ports?: number[], maxConnections?: number }`.
fn parse_options(options: &JsValue) -> Result<ListenOptions, JsValue> {
    let get = |name: &str| js_sys::Reflect::get(options, &JsValue::from_str(name)).unwrap_or(JsValue::UNDEFINED);

    let identity = get("identity");
    if !identity.is_instance_of::<js_sys::Uint8Array>() {
        return Err(host_err("BAD_IDENTITY", "identity must be a Uint8Array of 32 bytes"));
    }
    let seed = js_sys::Uint8Array::new(&identity).to_vec();

    let ports = get("ports");
    let ports = if ports.is_undefined() || ports.is_null() {
        vec![DEFAULT_PORT]
    } else {
        let list = js_sys::Array::from(&ports);
        let mut out = Vec::with_capacity(list.length() as usize);
        for item in list.iter() {
            match item.as_f64() {
                Some(n) if n >= 1.0 && n <= 65535.0 && n.fract() == 0.0 => out.push(n as u16),
                _ => return Err(host_err("BAD_PORTS", "ports must be integers from 1 to 65535")),
            }
        }
        if out.is_empty() {
            return Err(host_err("BAD_PORTS", "ports must not be empty"));
        }
        out
    };

    let max = get("maxConnections");
    let max_connections = if max.is_undefined() || max.is_null() {
        DEFAULT_MAX_CONNECTIONS
    } else {
        match max.as_f64() {
            Some(n) if n >= 1.0 && n.fract() == 0.0 => n as usize,
            _ => return Err(host_err("BAD_LIMIT", "maxConnections must be a positive integer")),
        }
    };

    Ok(ListenOptions { seed, ports, max_connections })
}

#[wasm_bindgen]
impl TorClient {
    /// Host an onion service with the identity in `options.identity`.
    ///
    /// Resolves to an `OnionListener` once the service is launched. The service is not yet
    /// reachable at that point: it still has to set up introduction points and publish where
    /// they are, which takes from seconds to a few minutes (the visitor retries; see
    /// `test/hs-live-node.mjs`).
    #[wasm_bindgen(js_name = listen)]
    pub fn listen(&self, options: JsValue) -> js_sys::Promise {
        let client = match &self.inner {
            Some(c) => Arc::clone(c),
            None => {
                return wasm_bindgen_futures::future_to_promise(async {
                    Err(JsTorError::not_initialized().into_js_value())
                });
            }
        };
        wasm_bindgen_futures::future_to_promise(async move {
            let listener = launch(client, parse_options(&options)?)?;
            Ok(JsValue::from(listener))
        })
    }
}

/// Launch the service and start accepting visitors.
fn launch(client: Arc<ArtiTorClient<WasmRuntime>>, opts: ListenOptions) -> Result<OnionListener, JsValue> {
    let keypair = identity::keypair_from_seed(&opts.seed).map_err(|m| host_err("BAD_IDENTITY", m))?;
    let onion = identity::onion_name(&keypair);

    let nickname = HsNickname::new(NICKNAME.to_owned()).map_err(|e| host_err("HOST", e.to_string()))?;

    // The identity goes into an in-memory keystore before launch; arti only makes a key of its
    // own when it finds none, so the service gets the address the page's seed names.
    let keymgr = Arc::new(
        KeyMgrBuilder::default()
            .primary_store(Box::new(ArtiEphemeralKeystore::new(NICKNAME.to_owned())))
            .build()
            .map_err(|e| host_err("HOST", format!("keystore: {e}")))?,
    );
    keymgr
        .insert::<HsIdKeypair>(
            keypair,
            &HsIdKeypairSpecifier::new(nickname.clone()),
            KeystoreSelector::Primary,
            false,
        )
        .map_err(|e| host_err("HOST", format!("keystore: {e}")))?;

    let config = OnionServiceConfigBuilder::default()
        .nickname(nickname)
        .build()
        .map_err(|e| host_err("HOST", format!("service config: {e}")))?;
    let service = OnionService::builder()
        .config(config)
        .keymgr(keymgr)
        .state_dir(StateDirectory::new_in_memory())
        .build()
        .map_err(|e| host_err("HOST", format!("service: {e}")))?;

    let runtime = client.runtime().clone();
    let dirmgr = client
        .dirmgr()
        .map_err(|e| host_err("NOT_READY", format!("the Tor client is not running yet: {e}")))?;
    let circ_pool = client
        .hs_circ_pool()
        .map_err(|e| host_err("NOT_READY", format!("the Tor client is not running yet: {e}")))?;
    let (running, rend_requests) = service
        .launch(runtime, dirmgr.upcast_arc(), circ_pool, Arc::new(CfgPathResolver::default()))
        .map_err(|e| host_err("HOST", format!("could not start the service: {e}")))?
        .ok_or_else(|| host_err("HOST", "the service is disabled"))?;
    info!("Hosting onion service {onion} on ports {:?}", opts.ports);

    // Visitors are queued here for `accept()`. The loop below is stopped by `close()`.
    let (visitors, incoming) = mpsc::unbounded::<OnionConnection>();
    let (abort, abort_registration) = AbortHandle::new_pair();
    let closed = Rc::new(Cell::new(false));
    let open = Rc::new(Cell::new(0_usize));
    let ports = Rc::new(opts.ports);
    let max_connections = opts.max_connections;

    let accept_loop = {
        let closed = Rc::clone(&closed);
        async move {
            let mut requests = Box::pin(handle_rend_requests(rend_requests));
            while let Some(request) = requests.next().await {
                wasm_bindgen_futures::spawn_local(admit(
                    request,
                    Rc::clone(&ports),
                    max_connections,
                    Rc::clone(&open),
                    Rc::clone(&closed),
                    visitors.clone(),
                ));
            }
            debug!("Onion service: no more incoming requests");
        }
    };
    wasm_bindgen_futures::spawn_local(async move {
        let _ = Abortable::new(accept_loop, abort_registration).await;
    });

    Ok(OnionListener {
        onion,
        running: RefCell::new(Some(running)),
        abort,
        closed,
        incoming: Rc::new(Mutex::new(incoming)),
    })
}

/// Decide about one visitor's request to open a stream, and queue it for `accept()` if allowed.
///
/// A request for a port the caller did not list, or one that arrives when the limit is reached,
/// is turned away with the `DONE` reason, the one arti's documentation advises so that this
/// service looks like other onion services.
async fn admit(
    request: StreamRequest,
    ports: Rc<Vec<u16>>,
    max_connections: usize,
    open: Rc<Cell<usize>>,
    closed: Rc<Cell<bool>>,
    visitors: mpsc::UnboundedSender<OnionConnection>,
) {
    let wanted = match request.request() {
        IncomingStreamRequest::Begin(begin) => Some(begin.port()),
        _ => None,
    };
    let allowed = wanted.is_some_and(|p| ports.contains(&p)) && !closed.get() && open.get() < max_connections;
    if !allowed {
        debug!("Onion service: turning away a request for port {wanted:?} ({} open)", open.get());
        let _ = request.reject(End::new_with_reason(EndReason::DONE)).await;
        return;
    }

    // Count the visitor before the (slow) accept, so a burst cannot get past the limit.
    let slot = Rc::new(OpenSlot::take(&open));
    let stream = match request.accept(Connected::new_empty()).await {
        Ok(stream) => stream,
        Err(e) => {
            debug!("Onion service: could not accept a stream: {e}");
            return;
        }
    };
    if closed.get() {
        return;
    }
    let (reader, writer) = stream.split();
    let connection = OnionConnection {
        reader: Rc::new(Mutex::new(reader)),
        writer: Rc::new(Mutex::new(writer)),
        _slot: slot,
    };
    if visitors.unbounded_send(connection).is_err() {
        debug!("Onion service: a visitor arrived after the listener was closed");
    }
}

/// One of the open-visitor slots; frees itself when the connection is dropped.
struct OpenSlot(Rc<Cell<usize>>);

impl OpenSlot {
    fn take(open: &Rc<Cell<usize>>) -> Self {
        open.set(open.get() + 1);
        Self(Rc::clone(open))
    }
}

impl Drop for OpenSlot {
    fn drop(&mut self) {
        self.0.set(self.0.get().saturating_sub(1));
    }
}

/// A hosted onion service, accepting visitors until closed.
#[wasm_bindgen]
pub struct OnionListener {
    onion: String,
    /// Dropping this stops publishing and accepting new introductions.
    running: RefCell<Option<Arc<RunningOnionService>>>,
    /// Stops the accept loop.
    abort: AbortHandle,
    closed: Rc<Cell<bool>>,
    incoming: Rc<Mutex<mpsc::UnboundedReceiver<OnionConnection>>>,
}

#[wasm_bindgen]
impl OnionListener {
    /// The service's address, `<56 characters>.onion`.
    #[wasm_bindgen(getter)]
    pub fn onion(&self) -> String {
        self.onion.clone()
    }

    /// Wait for the next visitor. Resolves to an `OnionConnection`, or to `null` once the
    /// listener is closed.
    pub fn accept(&self) -> js_sys::Promise {
        let incoming = Rc::clone(&self.incoming);
        wasm_bindgen_futures::future_to_promise(async move {
            match incoming.lock().await.next().await {
                Some(connection) => Ok(JsValue::from(connection)),
                None => Ok(JsValue::NULL),
            }
        })
    }

    /// Take the service offline. Connections already open stay open until their ends close them.
    pub fn close(&self) {
        if self.closed.replace(true) {
            return;
        }
        info!("Closing onion service {}", self.onion);
        self.abort.abort();
        drop(self.running.borrow_mut().take());
    }
}

impl Drop for OnionListener {
    fn drop(&mut self) {
        self.close();
    }
}

/// One visitor: a duplex byte stream, end to end encrypted with the visitor.
#[wasm_bindgen]
pub struct OnionConnection {
    reader: Rc<Mutex<DataReader>>,
    writer: Rc<Mutex<DataWriter>>,
    /// Keeps this connection counted against the listener's limit while it exists.
    _slot: Rc<OpenSlot>,
}

#[wasm_bindgen]
impl OnionConnection {
    /// Read up to 16 KiB. Resolves to a `Uint8Array`, or to `null` when the visitor has closed
    /// its end.
    pub fn read(&self) -> js_sys::Promise {
        let reader = Rc::clone(&self.reader);
        wasm_bindgen_futures::future_to_promise(async move {
            let mut buffer = vec![0_u8; READ_CHUNK];
            match reader.lock().await.read(&mut buffer).await {
                Ok(0) => Ok(JsValue::NULL),
                Ok(n) => Ok(js_sys::Uint8Array::from(&buffer[..n]).into()),
                Err(e) => Err(JsTorError::connection(format!("read failed: {e}")).into_js_value()),
            }
        })
    }

    /// Send `data` to the visitor; resolves once it has been handed to the circuit.
    pub fn write(&self, data: js_sys::Uint8Array) -> js_sys::Promise {
        let writer = Rc::clone(&self.writer);
        let bytes = data.to_vec();
        wasm_bindgen_futures::future_to_promise(async move {
            let mut writer = writer.lock().await;
            let result = async {
                writer.write_all(&bytes).await?;
                writer.flush().await
            }
            .await;
            match result {
                Ok(()) => Ok(JsValue::UNDEFINED),
                Err(e) => Err(JsTorError::connection(format!("write failed: {e}")).into_js_value()),
            }
        })
    }

    /// Finish sending: the visitor sees the end of the stream. Reading stays possible until the
    /// visitor closes its end.
    pub fn close(&self) -> js_sys::Promise {
        let writer = Rc::clone(&self.writer);
        wasm_bindgen_futures::future_to_promise(async move {
            if let Err(e) = writer.lock().await.close().await {
                warn!("Onion service: closing a connection failed: {e}");
            }
            Ok(JsValue::UNDEFINED)
        })
    }
}
