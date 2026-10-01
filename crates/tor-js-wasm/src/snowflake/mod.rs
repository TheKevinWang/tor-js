//! The Snowflake pluggable transport, running inside the page.
//!
//! Stack, bottom up: a carrier connection to Tor's Snowflake server (a direct
//! WebSocket, or a WebRTC data channel through a volunteer proxy), Turbo
//! Tunnel framing with a per-session client ID ([`turbo`], [`session`]), KCP
//! for reliable ordered delivery ([`kcp_stream`]), and one smux stream
//! ([`smux`]). The smux stream's bytes reach the bridge's Tor port, so arti's
//! `ChanBuilder` runs the ordinary Tor link handshake over it and checks the
//! bridge's identity from the bridge line.
//!
//! arti sees a Snowflake bridge as a plain bridge at its placeholder address;
//! `WasmRuntime::connect` recognises that address and calls [`connect`].
//!
//! Selected by bridge-line settings (the `key=value` pairs after the
//! fingerprint):
//!
//! - `ws=wss://...`: dial that WebSocket directly (the Snowflake server's
//!   proxy-facing endpoint). tor-js-specific; the official client never does.
//! - otherwise `url=<broker>` (plus `ice=stun:...,stun:...` and
//!   `fingerprint=`, as in Tor Browser's Snowflake lines): ask the broker for
//!   a volunteer proxy and reach it over a WebRTC data channel. Needs a page
//!   with `RTCPeerConnection`, or a peer factory (a worker has no
//!   `RTCPeerConnection`; a page can host the peer connection for it).
//!
//! Sessions are opened by a task of their own ([`pool`]), so one that takes
//! longer than arti's dial timeout is still there for arti's next attempt.

mod kcp_stream;
mod pool;
mod session;
mod smux;
mod turbo;
mod webrtc;
mod websocket;

use std::io;
use std::pin::Pin;
use std::rc::Rc;
use std::task::{Context, Poll};

use futures::{AsyncRead, AsyncWrite, FutureExt};
use rand_core::TryRng;
use send_wrapper::SendWrapper;
use tracing::info;

use crate::runtime::SendFut;
use session::{Dial, TurboSession};

/// The transport name in bridge lines.
pub(crate) const TRANSPORT_NAME: &str = "snowflake";

/// Any byte stream we can stack Snowflake's layers on.
trait Duplex: AsyncRead + AsyncWrite {}
impl<T: AsyncRead + AsyncWrite> Duplex for T {}

type Carrier = Pin<Box<dyn Duplex>>;

/// The full Snowflake stack: bytes in and out of the bridge's Tor port.
type Stack = Pin<Box<dyn Duplex>>;

/// How to reach the Snowflake server, from the bridge line's settings.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) enum CarrierConfig {
    WebSocket { url: String },
    WebRtc(webrtc::WebRtcConfig),
}

impl CarrierConfig {
    pub(crate) fn from_settings(settings: &[(String, String)]) -> Result<Self, String> {
        let setting = |key: &str| settings.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone());
        if let Some(url) = setting("ws") {
            if !(url.starts_with("wss://") || url.starts_with("ws://")) {
                return Err(format!("snowflake ws= must be a ws:// or wss:// URL, got {url:?}"));
            }
            return Ok(Self::WebSocket { url });
        }
        if let Some(broker_url) = setting("url") {
            if !broker_url.starts_with("https://") {
                return Err(format!("snowflake url= must be an https:// broker URL, got {broker_url:?}"));
            }
            let fingerprint = setting("fingerprint")
                .ok_or("snowflake WebRTC bridge line needs fingerprint= (it picks the bridge at the broker)")?;
            let stun_urls: Vec<String> = setting("ice")
                .unwrap_or_default()
                .split(',')
                .map(str::trim)
                .filter(|u| !u.is_empty())
                .map(str::to_owned)
                .collect();
            if stun_urls.is_empty() || stun_urls.iter().any(|u| !u.starts_with("stun:")) {
                return Err("snowflake WebRTC bridge line needs ice=stun:host:port,...".into());
            }
            return Ok(Self::WebRtc(webrtc::WebRtcConfig { broker_url, fingerprint, stun_urls }));
        }
        Err("snowflake bridge line needs ws=wss://... (direct WebSocket) or url=https://<broker> (WebRTC)".into())
    }

    fn dial(&self) -> Dial<Carrier> {
        match self.clone() {
            Self::WebSocket { url } => {
                let url: Rc<str> = url.into();
                Rc::new(move || {
                    let url = url.clone();
                    async move {
                        let ws = websocket::WebSocketStream::connect(&url).await?;
                        Ok(Box::pin(ws) as Carrier)
                    }
                    .boxed_local()
                })
            }
            Self::WebRtc(config) => {
                let config = Rc::new(config);
                Rc::new(move || {
                    let config = config.clone();
                    async move {
                        webrtc::dial(&config).await
                    }
                    .boxed_local()
                })
            }
        }
    }
}

/// The byte stream to the Snowflake bridge's Tor port.
///
/// Its layers hold browser objects and `Rc`s, so they are not `Send`; arti
/// requires channel streams to be. `SendWrapper` makes that sound by panicking
/// on access from another thread, which cannot happen on single-threaded wasm.
pub struct SnowflakeStream(SendWrapper<Pin<Box<dyn Duplex>>>);

impl AsyncRead for SnowflakeStream {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut [u8]) -> Poll<io::Result<usize>> {
        self.0.as_mut().poll_read(cx, buf)
    }
}

impl AsyncWrite for SnowflakeStream {
    fn poll_write(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
        self.0.as_mut().poll_write(cx, buf)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.0.as_mut().poll_flush(cx)
    }

    fn poll_close(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.0.as_mut().poll_close(cx)
    }
}

/// Build the full Snowflake stack over the configured carrier.
async fn open(config: CarrierConfig) -> io::Result<Stack> {
    let mut client_id = [0u8; 8];
    let Ok(()) = tor_llcrypto::rng::CautiousRng.try_fill_bytes(&mut client_id);
    info!("Snowflake: opening session via {config:?}");
    let session = TurboSession::open(config.dial(), client_id).await?;
    let kcp = kcp_stream::KcpStream::new(session);
    let stream = smux::SmuxStream::open(kcp, smux::FIRST_CLIENT_STREAM).await?;
    info!("Snowflake: session open");
    Ok(Box::pin(stream))
}

/// Create WebRTC peer connections through `factory` (a JS function) instead of
/// the global `RTCPeerConnection`; for workers, which have none. See
/// `webrtc::connect_remote` for what the factory must return.
pub(crate) fn set_peer_factory(factory: js_sys::Function) {
    webrtc::set_peer_factory(factory);
}

/// Open a session ahead of time and wait for it (see [`pool::warm`]).
pub(crate) async fn warm(config: CarrierConfig) -> io::Result<()> {
    pool::warm(&config).await
}

/// Open a byte stream to the Snowflake bridge. The returned future is `Send`
/// (as arti's runtime traits require) for the same reason as [`SnowflakeStream`].
pub(crate) async fn connect(config: CarrierConfig) -> io::Result<SnowflakeStream> {
    let stream = SendFut(SendWrapper::new(async move { pool::take(&config).await })).await?;
    Ok(SnowflakeStream(SendWrapper::new(stream)))
}
