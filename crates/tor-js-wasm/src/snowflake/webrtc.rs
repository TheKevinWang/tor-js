//! The WebRTC carrier: a data channel to a volunteer Snowflake proxy, matched
//! by the Snowflake broker. The proxy relays the channel's bytes to the
//! Snowflake server over a WebSocket.
//!
//! Rendezvous (snowflake/common/messages/client.go): POST `<broker>/client`
//! with body `1.0\n{"offer": <SDP offer JSON>, "nat": ..., "fingerprint": ...}`;
//! the reply is `{"answer": <SDP answer JSON>}` or `{"error": ...}`. The broker
//! sends CORS headers, so a page can call it directly (browsers cannot domain
//! front, so Tor Browser's CDN `url=`/`front=` settings do not apply here).
//!
//! Ported from andrewtheguy/webtor-rs `crates/webtor-core/src/{webrtc_stream,
//! snowflake_broker,snowflake_webrtc}.rs` (MIT, Copyright (c) 2025-2026 Andrew Chen).

use futures::channel::{mpsc, oneshot};
use futures::future::{select, Either};
use futures::{AsyncRead, AsyncWrite, StreamExt};
use gloo_timers::future::TimeoutFuture;
use js_sys::{Array, Object, Reflect};
use std::cell::{Cell, RefCell};
use std::io;
use std::pin::{pin, Pin};
use std::rc::Rc;
use std::task::{Context, Poll};
use std::time::Duration;
use tracing::{info, warn};
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;
use wasm_bindgen_futures::JsFuture;
use web_sys::{
    RtcConfiguration, RtcDataChannel, RtcDataChannelInit, RtcDataChannelState, RtcIceGatheringState,
    RtcPeerConnection, RtcSdpType, RtcSessionDescriptionInit,
};
use web_time_compat::Instant;

use super::Carrier;
use crate::runtime::JsProxyStream;

const DATA_CHANNEL_LABEL: &str = "snowflake";
const ICE_GATHERING_TIMEOUT_MS: u32 = 10_000;
const DATA_CHANNEL_TIMEOUT_MS: u32 = 10_000;
/// Proxies asked for before a dial gives up: the broker often has none for a
/// poll or two, and a matched proxy is often unreachable.
const MAX_ATTEMPTS: u32 = 10;
/// The least time between the starts of two attempts. The official client uses
/// 10 s (`ReconnectTimeout`), which suits a client that retries forever in the
/// background; here a person is waiting, an attempt that fails quickly (a proxy
/// that did not answer) should be replaced quickly, and the broker is only
/// asked once per attempt.
const ATTEMPT_INTERVAL: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) struct WebRtcConfig {
    pub(crate) broker_url: String,
    pub(crate) fingerprint: String,
    pub(crate) stun_urls: Vec<String>,
}

fn net_err(msg: impl Into<String>) -> io::Error {
    io::Error::other(msg.into())
}

// --------------------------------------------------------------------------
// NAT policy
// --------------------------------------------------------------------------

thread_local! {
    /// Set once a proxy matched for an "unrestricted" NAT could not be
    /// reached. A page cannot probe its NAT, so like the official client this
    /// claims "unrestricted" (sparing the scarce open proxies) until that
    /// fails, and "unknown" from then on.
    static UNRESTRICTED_FAILED: Cell<bool> = const { Cell::new(false) };
}

thread_local! {
    /// A JavaScript function returning a Promise of a "peer" (see
    /// [`connect_remote`]). Set where `RTCPeerConnection` does not exist (a
    /// worker) but a page can host the peer connection for us.
    static PEER_FACTORY: RefCell<Option<js_sys::Function>> = const { RefCell::new(None) };
}

/// Use `factory` to create the WebRTC peer connection instead of the global
/// `RTCPeerConnection` (see [`connect_remote`] for the contract).
pub(crate) fn set_peer_factory(factory: js_sys::Function) {
    PEER_FACTORY.with(|f| *f.borrow_mut() = Some(factory));
}

fn nat_type() -> &'static str {
    if UNRESTRICTED_FAILED.with(Cell::get) { "unknown" } else { "unrestricted" }
}

// --------------------------------------------------------------------------
// Broker
// --------------------------------------------------------------------------

fn broker_request(offer: &str, nat: &str, fingerprint: &str) -> String {
    let json = serde_json::json!({ "offer": offer, "nat": nat, "fingerprint": fingerprint });
    format!("1.0\n{json}")
}

async fn broker_exchange(config: &WebRtcConfig, offer: &str, nat: &str) -> io::Result<String> {
    let url = format!("{}/client", config.broker_url.trim_end_matches('/'));
    let init = web_sys::RequestInit::new();
    init.set_method("POST");
    init.set_mode(web_sys::RequestMode::Cors);
    init.set_body(&JsValue::from_str(&broker_request(offer, nat, &config.fingerprint)));
    let request = web_sys::Request::new_with_str_and_init(&url, &init)
        .map_err(|e| net_err(format!("bad broker request: {e:?}")))?;
    // A CORS-safelisted content type, so no preflight.
    let _ = request.headers().set("Content-Type", "application/x-www-form-urlencoded");

    let fetch: js_sys::Function = Reflect::get(&js_sys::global(), &"fetch".into())
        .ok()
        .and_then(|f| f.dyn_into().ok())
        .ok_or_else(|| net_err("fetch() is not available"))?;
    let response: web_sys::Response = JsFuture::from(js_sys::Promise::from(
        fetch.call1(&JsValue::NULL, &request).map_err(|e| net_err(format!("broker fetch failed: {e:?}")))?,
    ))
    .await
    .map_err(|e| net_err(format!("Snowflake broker request failed: {e:?}")))?
    .unchecked_into();
    if !response.ok() {
        return Err(net_err(format!("Snowflake broker returned HTTP {}", response.status())));
    }
    let text = JsFuture::from(response.text().map_err(|e| net_err(format!("{e:?}")))?)
        .await
        .map_err(|e| net_err(format!("reading broker response: {e:?}")))?
        .as_string()
        .unwrap_or_default();

    #[derive(serde::Deserialize)]
    struct Reply {
        #[serde(default)]
        answer: String,
        #[serde(default)]
        error: String,
    }
    let reply: Reply = serde_json::from_str(&text).map_err(|e| net_err(format!("bad broker response: {e}")))?;
    if !reply.error.is_empty() {
        return Err(net_err(format!("Snowflake broker: {}", reply.error)));
    }
    if reply.answer.is_empty() {
        return Err(net_err("Snowflake broker returned no answer"));
    }
    Ok(reply.answer)
}

// --------------------------------------------------------------------------
// Data channel stream
// --------------------------------------------------------------------------

pub(crate) struct WebRtcStream {
    peer_connection: RtcPeerConnection,
    data_channel: RtcDataChannel,
    receiver: mpsc::UnboundedReceiver<io::Result<Vec<u8>>>,
    buffered: Vec<u8>,
    _on_message: Closure<dyn FnMut(web_sys::MessageEvent)>,
    _on_error: Closure<dyn FnMut(web_sys::Event)>,
    _on_close: Closure<dyn FnMut(web_sys::Event)>,
}

impl Drop for WebRtcStream {
    fn drop(&mut self) {
        self.data_channel.set_onmessage(None);
        self.data_channel.set_onerror(None);
        self.data_channel.set_onclose(None);
        self.data_channel.set_onopen(None);
        self.data_channel.close();
        self.peer_connection.close();
    }
}

fn new_peer_connection(stun_urls: &[String]) -> io::Result<RtcPeerConnection> {
    // Only a window has RTCPeerConnection (not workers, not Node).
    let ctor: js_sys::Function = Reflect::get(&js_sys::global(), &"RTCPeerConnection".into())
        .ok()
        .and_then(|c| c.dyn_into().ok())
        .ok_or_else(|| net_err("RTCPeerConnection is not available here; use the WebSocket carrier"))?;
    let servers = Array::new();
    for url in stun_urls {
        let server = Object::new();
        let _ = Reflect::set(&server, &"urls".into(), &JsValue::from_str(url));
        servers.push(&server);
    }
    let configuration = RtcConfiguration::new();
    configuration.set_ice_servers(&servers);
    Reflect::construct(&ctor, &Array::of1(&configuration))
        .map(JsCast::unchecked_into)
        .map_err(|e| net_err(format!("creating RTCPeerConnection failed: {e:?}")))
}

/// Resolve when `fire` is sent or after `ms`, whichever comes first; `true`
/// if it fired.
async fn wait_or_timeout(fire: oneshot::Receiver<bool>, ms: u32) -> bool {
    match select(fire, pin!(TimeoutFuture::new(ms))).await {
        Either::Left((Ok(ok), _)) => ok,
        _ => false,
    }
}

async fn gather_ice(pc: &RtcPeerConnection) {
    if pc.ice_gathering_state() == RtcIceGatheringState::Complete {
        return;
    }
    let (tx, rx) = oneshot::channel();
    let tx = Rc::new(RefCell::new(Some(tx)));
    let pc2 = pc.clone();
    let tx2 = tx.clone();
    let cb = Closure::wrap(Box::new(move |_: web_sys::Event| {
        if pc2.ice_gathering_state() == RtcIceGatheringState::Complete {
            if let Some(tx) = tx2.borrow_mut().take() {
                let _ = tx.send(true);
            }
        }
    }) as Box<dyn FnMut(web_sys::Event)>);
    pc.set_onicegatheringstatechange(Some(cb.as_ref().unchecked_ref()));
    if !wait_or_timeout(rx, ICE_GATHERING_TIMEOUT_MS).await {
        warn!("Snowflake: ICE gathering timed out; using the candidates gathered so far");
    }
    pc.set_onicegatheringstatechange(None);
    drop(tx);
}

async fn wait_for_open(dc: &RtcDataChannel) -> bool {
    if dc.ready_state() == RtcDataChannelState::Open {
        return true;
    }
    let (tx, rx) = oneshot::channel();
    let tx = Rc::new(RefCell::new(Some(tx)));
    let (tx_open, tx_err) = (tx.clone(), tx);
    let on_open = Closure::wrap(Box::new(move |_: web_sys::Event| {
        if let Some(tx) = tx_open.borrow_mut().take() {
            let _ = tx.send(true);
        }
    }) as Box<dyn FnMut(web_sys::Event)>);
    let on_error = Closure::wrap(Box::new(move |_: web_sys::Event| {
        if let Some(tx) = tx_err.borrow_mut().take() {
            let _ = tx.send(false);
        }
    }) as Box<dyn FnMut(web_sys::Event)>);
    dc.set_onopen(Some(on_open.as_ref().unchecked_ref()));
    dc.set_onerror(Some(on_error.as_ref().unchecked_ref()));
    let opened = wait_or_timeout(rx, DATA_CHANNEL_TIMEOUT_MS).await;
    dc.set_onopen(None);
    dc.set_onerror(None);
    opened
}

impl WebRtcStream {
    /// One attempt: a new peer connection, a broker match, and a data channel.
    async fn connect(config: &WebRtcConfig) -> io::Result<Self> {
        let pc = new_peer_connection(&config.stun_urls)?;
        let dc = pc.create_data_channel_with_data_channel_dict(DATA_CHANNEL_LABEL, &RtcDataChannelInit::new());
        dc.set_binary_type(web_sys::RtcDataChannelType::Arraybuffer);

        let (sender, receiver) = mpsc::unbounded();
        let (msg_tx, err_tx, close_tx) = (sender.clone(), sender.clone(), sender);
        let on_message = Closure::wrap(Box::new(move |event: web_sys::MessageEvent| {
            if let Ok(buffer) = event.data().dyn_into::<js_sys::ArrayBuffer>() {
                let bytes = js_sys::Uint8Array::new(&buffer).to_vec();
                if !bytes.is_empty() {
                    let _ = msg_tx.unbounded_send(Ok(bytes));
                }
            }
        }) as Box<dyn FnMut(web_sys::MessageEvent)>);
        dc.set_onmessage(Some(on_message.as_ref().unchecked_ref()));
        let on_error = Closure::wrap(Box::new(move |_: web_sys::Event| {
            let _ = err_tx.unbounded_send(Err(net_err("Snowflake data channel error")));
        }) as Box<dyn FnMut(web_sys::Event)>);
        let on_close = Closure::wrap(Box::new(move |_: web_sys::Event| close_tx.close_channel())
            as Box<dyn FnMut(web_sys::Event)>);
        dc.set_onclose(Some(on_close.as_ref().unchecked_ref()));

        // Own the callbacks first, so every early return cleans up via Drop.
        let stream = Self {
            peer_connection: pc,
            data_channel: dc,
            receiver,
            buffered: Vec::new(),
            _on_message: on_message,
            _on_error: on_error,
            _on_close: on_close,
        };
        let pc = &stream.peer_connection;

        let offer = JsFuture::from(pc.create_offer())
            .await
            .map_err(|e| net_err(format!("createOffer failed: {e:?}")))?;
        JsFuture::from(pc.set_local_description(offer.unchecked_ref()))
            .await
            .map_err(|e| net_err(format!("setLocalDescription failed: {e:?}")))?;
        gather_ice(pc).await;
        let sdp = pc.local_description().map(|d| d.sdp()).unwrap_or_default();
        if !sdp.contains("a=candidate:") {
            return Err(net_err("Snowflake: WebRTC gathered no ICE candidates"));
        }
        let offer_json = serde_json::json!({ "type": "offer", "sdp": sdp }).to_string();

        let nat = nat_type();
        info!("Snowflake: asking the broker for a proxy (NAT: {nat})");
        let answer = broker_exchange(config, &offer_json, nat).await?;
        let answer: serde_json::Value =
            serde_json::from_str(&answer).map_err(|e| net_err(format!("bad SDP answer: {e}")))?;
        let answer_sdp = answer.get("sdp").and_then(|s| s.as_str()).ok_or_else(|| net_err("SDP answer has no sdp"))?;
        let desc = RtcSessionDescriptionInit::new(RtcSdpType::Answer);
        desc.set_sdp(answer_sdp);
        JsFuture::from(pc.set_remote_description(&desc))
            .await
            .map_err(|e| net_err(format!("setRemoteDescription failed: {e:?}")))?;

        if !wait_for_open(&stream.data_channel).await {
            if nat == "unrestricted" && !UNRESTRICTED_FAILED.with(|f| f.replace(true)) {
                info!("Snowflake: a proxy matched for an unrestricted NAT was unreachable; asking for open proxies from now on");
            }
            return Err(net_err("Snowflake: the proxy's data channel did not open"));
        }
        stream.data_channel.set_onerror(Some(stream._on_error.as_ref().unchecked_ref()));
        info!("Snowflake: data channel to a volunteer proxy is open");
        Ok(stream)
    }

}

/// One attempt: through the JS peer factory if one is set, else natively.
async fn attempt(config: &WebRtcConfig) -> io::Result<Carrier> {
    let factory = PEER_FACTORY.with(|f| f.borrow().clone());
    match factory {
        Some(factory) => connect_remote(config, &factory).await,
        None => Ok(Box::pin(WebRtcStream::connect(config).await?) as Carrier),
    }
}

/// Dial a proxy, retrying as the official client does.
pub(crate) async fn dial(config: &WebRtcConfig) -> io::Result<Carrier> {
    let mut last = None;
    for attempt_no in 1..=MAX_ATTEMPTS {
        let started = Instant::now();
        match attempt(config).await {
            Ok(s) => return Ok(s),
            Err(e) => {
                warn!("Snowflake WebRTC attempt {attempt_no}/{MAX_ATTEMPTS} failed: {e}");
                if e.to_string().contains("not available here") {
                    return Err(e);
                }
                last = Some(e);
                let wait = ATTEMPT_INTERVAL.saturating_sub(started.elapsed());
                if attempt_no < MAX_ATTEMPTS && !wait.is_zero() {
                    TimeoutFuture::new(wait.as_millis() as u32).await;
                }
            }
        }
    }
    Err(last.unwrap_or_else(|| net_err("Snowflake WebRTC failed")))
}

// --------------------------------------------------------------------------
// Remote peer: the peer connection lives in a page
// --------------------------------------------------------------------------

fn js_msg(e: &JsValue) -> String {
    if let Some(err) = e.dyn_ref::<js_sys::Error>() {
        String::from(err.message())
    } else if let Some(s) = e.as_string() {
        s
    } else {
        format!("{e:?}")
    }
}

/// Call `this[method](...args)` and await its result (a Promise or a value).
async fn call_js(this: &JsValue, method: &str, args: &Array) -> io::Result<JsValue> {
    let f: js_sys::Function = Reflect::get(this, &method.into())
        .ok()
        .and_then(|f| f.dyn_into().ok())
        .ok_or_else(|| net_err(format!("WebRTC peer has no {method}()")))?;
    let returned = f.apply(this, args).map_err(|e| net_err(js_msg(&e)))?;
    JsFuture::from(js_sys::Promise::resolve(&returned)).await.map_err(|e| net_err(js_msg(&e)))
}

/// Closes the JS peer when dropped.
struct RemotePeer(JsValue);

impl Drop for RemotePeer {
    fn drop(&mut self) {
        if let Ok(close) = Reflect::get(&self.0, &"close".into()).and_then(|f| f.dyn_into::<js_sys::Function>()) {
            let _ = close.call0(&self.0);
        }
    }
}

/// A data channel living in a page, reached through a JS socket object.
struct RemoteStream {
    stream: JsProxyStream,
    _peer: RemotePeer,
}

impl AsyncRead for RemoteStream {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut [u8]) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.stream).poll_read(cx, buf)
    }
}

impl AsyncWrite for RemoteStream {
    fn poll_write(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.stream).poll_write(cx, buf)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.stream).poll_flush(cx)
    }

    fn poll_close(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.stream).poll_close(cx)
    }
}

/// One attempt with the peer connection hosted by JavaScript (typically in a
/// page, because workers have no `RTCPeerConnection`). The broker exchange and
/// everything above the data channel stay here; the factory's peer does only
/// what needs the browser object:
///
/// - `factory() -> Promise<peer>`
/// - `peer.offer(stunUrls: string[]) -> Promise<string>`: create the peer
///   connection and data channel, gather ICE, return the offer SDP.
/// - `peer.open(answerSdp: string) -> Promise<{ readable, writable, close() }>`:
///   apply the answer; resolve once the data channel is open (reject if it is
///   not), with a socket whose streams carry the channel's bytes.
/// - `peer.close()`.
async fn connect_remote(config: &WebRtcConfig, factory: &js_sys::Function) -> io::Result<Carrier> {
    let created = factory.call0(&JsValue::NULL).map_err(|e| net_err(js_msg(&e)))?;
    let peer = JsFuture::from(js_sys::Promise::resolve(&created)).await.map_err(|e| net_err(js_msg(&e)))?;
    let guard = RemotePeer(peer.clone());

    let stun = Array::new();
    for url in &config.stun_urls {
        stun.push(&JsValue::from_str(url));
    }
    let offer_sdp = call_js(&peer, "offer", &Array::of1(&stun))
        .await?
        .as_string()
        .ok_or_else(|| net_err("WebRTC peer returned no offer SDP"))?;
    if !offer_sdp.contains("a=candidate:") {
        return Err(net_err("Snowflake: WebRTC gathered no ICE candidates"));
    }
    let offer_json = serde_json::json!({ "type": "offer", "sdp": offer_sdp }).to_string();

    let nat = nat_type();
    info!("Snowflake: asking the broker for a proxy (NAT: {nat}; peer connection hosted by a page)");
    let answer = broker_exchange(config, &offer_json, nat).await?;
    let answer: serde_json::Value =
        serde_json::from_str(&answer).map_err(|e| net_err(format!("bad SDP answer: {e}")))?;
    let answer_sdp = answer.get("sdp").and_then(|s| s.as_str()).ok_or_else(|| net_err("SDP answer has no sdp"))?;

    let socket = match call_js(&peer, "open", &Array::of1(&JsValue::from_str(answer_sdp))).await {
        Ok(socket) => socket,
        Err(e) => {
            if nat == "unrestricted" && !UNRESTRICTED_FAILED.with(|f| f.replace(true)) {
                info!("Snowflake: a proxy matched for an unrestricted NAT was unreachable; asking for open proxies from now on");
            }
            return Err(net_err(format!("Snowflake: the proxy's data channel did not open ({e})")));
        }
    };
    let stream = JsProxyStream::wrap(socket)?;
    info!("Snowflake: data channel to a volunteer proxy is open (hosted by a page)");
    Ok(Box::pin(RemoteStream { stream, _peer: guard }))
}

impl AsyncRead for WebRtcStream {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, out: &mut [u8]) -> Poll<io::Result<usize>> {
        if self.buffered.is_empty() {
            match self.receiver.poll_next_unpin(cx) {
                Poll::Ready(Some(Ok(data))) => self.buffered = data,
                Poll::Ready(Some(Err(e))) => return Poll::Ready(Err(e)),
                Poll::Ready(None) => return Poll::Ready(Ok(0)),
                Poll::Pending => return Poll::Pending,
            }
        }
        let n = out.len().min(self.buffered.len());
        out[..n].copy_from_slice(&self.buffered[..n]);
        self.buffered.drain(..n);
        Poll::Ready(Ok(n))
    }
}

impl AsyncWrite for WebRtcStream {
    fn poll_write(self: Pin<&mut Self>, _cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
        if self.data_channel.ready_state() != RtcDataChannelState::Open {
            return Poll::Ready(Err(io::Error::new(io::ErrorKind::BrokenPipe, "Snowflake data channel is not open")));
        }
        match self.data_channel.send_with_u8_array(buf) {
            Ok(()) => Poll::Ready(Ok(buf.len())),
            Err(e) => Poll::Ready(Err(net_err(format!("data channel send failed: {e:?}")))),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_close(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.data_channel.close();
        Poll::Ready(Ok(()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn broker_request_matches_client_poll_format() {
        let body = broker_request("offer", "unknown", "AAAA");
        let (version, json) = body.split_once('\n').unwrap();
        assert_eq!(version, "1.0");
        let v: serde_json::Value = serde_json::from_str(json).unwrap();
        assert_eq!(v, serde_json::json!({ "offer": "offer", "nat": "unknown", "fingerprint": "AAAA" }));
    }
}
