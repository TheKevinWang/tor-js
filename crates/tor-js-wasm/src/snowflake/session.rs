//! A Turbo Tunnel session that outlives the carrier connection under it.
//!
//! The Snowflake server keys a session by the client ID a connection opens
//! with, not by the connection. A new connection opening with the same ID picks
//! the session up where the last left off, and the server holds the session's
//! packets for a minute while no connection has it. So when a carrier drops or
//! goes quiet this dials another and carries on, as the official client does:
//! KCP above retransmits whatever was lost in between.
//!
//! Ported from andrewtheguy/webtor-rs `crates/webtor-core/src/turbotunnel.rs`
//! (MIT, Copyright (c) 2025-2026 Andrew Chen).

use super::turbo::TurboStream;
use futures::future::{select, Either, LocalBoxFuture};
use futures::{AsyncRead, AsyncWrite, FutureExt};
use gloo_timers::future::TimeoutFuture;
use std::future::Future;
use std::io;
use std::pin::{pin, Pin};
use std::rc::Rc;
use std::task::{ready, Context, Poll};
use std::time::Duration;
use tracing::{info, warn};
use web_time_compat::Instant;

/// How long a connection may deliver nothing before it is replaced (the
/// official client's `SnowflakeTimeout`). The server's smux sends a keepalive
/// every ten seconds, so a working connection is never this quiet.
const SILENCE_TIMEOUT: Duration = Duration::from_secs(20);
/// Connections in a row that may end without delivering anything before the
/// session is taken to be gone at the server.
const MAX_SILENT_CONNECTIONS: u32 = 3;
/// The server forgets a client ID it has not heard for a minute
/// (`clientMapTimeout`); dialing a replacement after that is pointless.
const SESSION_RETENTION: Duration = Duration::from_secs(60);
const FIRST_REDIAL_BACKOFF: Duration = Duration::from_secs(1);
const MAX_REDIAL_BACKOFF: Duration = Duration::from_secs(8);

/// Opens one carrier connection to the Snowflake server.
pub(crate) type Dial<S> = Rc<dyn Fn() -> LocalBoxFuture<'static, io::Result<S>>>;

fn ms(d: Duration) -> u32 {
    d.as_millis().min(u32::MAX as u128) as u32
}

async fn with_timeout<T>(d: Duration, what: &str, f: impl Future<Output = io::Result<T>>) -> io::Result<T> {
    let f = pin!(f);
    let t = pin!(TimeoutFuture::new(ms(d)));
    match select(f, t).await {
        Either::Left((r, _)) => r,
        Either::Right(_) => Err(io::Error::new(io::ErrorKind::TimedOut, format!("{what} timed out after {d:?}"))),
    }
}

enum Connection<S> {
    Up {
        turbo: TurboStream<S>,
        /// When the connection last delivered anything, or opened.
        heard: Instant,
        silence: TimeoutFuture,
        delivered: bool,
    },
    Dialing(LocalBoxFuture<'static, io::Result<TurboStream<S>>>),
    Failed(String),
}

pub(crate) struct TurboSession<S> {
    /// The epoch this session was opened in (see `pool::session_closed`).
    born: u64,
    client_id: [u8; 8],
    dial: Dial<S>,
    connection: Connection<S>,
    silent_connections: u32,
}

async fn connect<S: AsyncRead + AsyncWrite + Unpin>(dial: Dial<S>, client_id: [u8; 8]) -> io::Result<TurboStream<S>> {
    let carrier = dial().await?;
    TurboStream::open(carrier, client_id).await
}

async fn reconnect<S: AsyncRead + AsyncWrite + Unpin>(dial: Dial<S>, client_id: [u8; 8]) -> io::Result<TurboStream<S>> {
    let lost = Instant::now();
    let mut attempt = 0u32;
    loop {
        let remaining = SESSION_RETENTION.saturating_sub(lost.elapsed());
        let error = match with_timeout(remaining, "redialing Snowflake", connect(dial.clone(), client_id)).await {
            Ok(turbo) => return Ok(turbo),
            Err(e) => e,
        };
        let backoff = FIRST_REDIAL_BACKOFF
            .saturating_mul(2u32.saturating_pow(attempt))
            .min(MAX_REDIAL_BACKOFF);
        if lost.elapsed() + backoff >= SESSION_RETENTION {
            return Err(error);
        }
        warn!("Could not dial another Snowflake connection ({error}); retrying in {backoff:?}");
        TimeoutFuture::new(ms(backoff)).await;
        attempt += 1;
    }
}

fn up<S>(turbo: TurboStream<S>) -> Connection<S> {
    Connection::Up {
        turbo,
        heard: Instant::now(),
        silence: TimeoutFuture::new(ms(SILENCE_TIMEOUT)),
        delivered: false,
    }
}

enum Outcome {
    Read(usize),
    Lost(String),
    Waiting,
}

impl<S: AsyncRead + AsyncWrite + Unpin + 'static> TurboSession<S> {
    /// Open a session on its first connection. A failure here is returned to
    /// the caller rather than redialed.
    pub(crate) async fn open(dial: Dial<S>, client_id: [u8; 8]) -> io::Result<Self> {
        let turbo = connect(dial.clone(), client_id).await?;
        Ok(Self { born: super::pool::epoch(), client_id, dial, connection: up(turbo), silent_connections: 0 })
    }

    fn redial(&mut self, reason: &str) {
        if let Connection::Up { delivered, .. } = &self.connection {
            self.silent_connections = if *delivered { 0 } else { self.silent_connections + 1 };
        }
        if self.silent_connections >= MAX_SILENT_CONNECTIONS {
            warn!("Snowflake connection lost ({reason}) and {MAX_SILENT_CONNECTIONS} in a row delivered nothing; giving the session up");
            self.connection = Connection::Failed(format!(
                "Snowflake session lost: {MAX_SILENT_CONNECTIONS} connections in a row delivered nothing"
            ));
            return;
        }
        warn!("Snowflake connection lost ({reason}); dialing another for the same session");
        self.connection = Connection::Dialing(reconnect(self.dial.clone(), self.client_id).boxed_local());
    }

    fn poll_up(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        // Every client that used Snowflake has closed: end the session, so that what arti still has in flight
        // on it fails at once instead of running out its timeouts (and does not redial).
        if super::pool::session_closed(self.born, cx.waker()) && !matches!(self.connection, Connection::Failed(_)) {
            info!("Snowflake: ending a session, the client that used it was closed");
            self.connection = Connection::Failed("the client that used this Snowflake session was closed".to_string());
        }
        loop {
            match &mut self.connection {
                Connection::Up { .. } => return Poll::Ready(Ok(())),
                Connection::Failed(message) => return Poll::Ready(Err(io::Error::other(message.clone()))),
                Connection::Dialing(dialing) => match ready!(dialing.as_mut().poll(cx)) {
                    Ok(turbo) => {
                        info!("Snowflake session resumed on a new connection");
                        self.connection = up(turbo);
                    }
                    Err(e) => {
                        warn!("Could not dial another Snowflake connection ({e}); giving the session up");
                        self.connection = Connection::Failed(format!("Snowflake session lost: {e}"));
                    }
                },
            }
        }
    }

    fn poll_current(&mut self, cx: &mut Context<'_>, buf: &mut [u8]) -> Outcome {
        let Connection::Up { turbo, heard, silence, delivered } = &mut self.connection else {
            return Outcome::Waiting;
        };
        match Pin::new(turbo).poll_read(cx, buf) {
            Poll::Ready(Ok(0)) => Outcome::Lost("the connection closed".to_string()),
            Poll::Ready(Ok(n)) => {
                *heard = Instant::now();
                *delivered = true;
                Outcome::Read(n)
            }
            Poll::Ready(Err(e)) => Outcome::Lost(e.to_string()),
            Poll::Pending => loop {
                if Pin::new(&mut *silence).poll(cx).is_pending() {
                    return Outcome::Waiting;
                }
                let quiet = heard.elapsed();
                if quiet >= SILENCE_TIMEOUT {
                    return Outcome::Lost(format!("nothing arrived for {} seconds", quiet.as_secs()));
                }
                *silence = TimeoutFuture::new(ms(SILENCE_TIMEOUT - quiet));
            },
        }
    }
}

impl<S: AsyncRead + AsyncWrite + Unpin + 'static> AsyncRead for TurboSession<S> {
    fn poll_read(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut [u8]) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        loop {
            ready!(this.poll_up(cx))?;
            match this.poll_current(cx, buf) {
                Outcome::Read(n) => return Poll::Ready(Ok(n)),
                Outcome::Waiting => return Poll::Pending,
                Outcome::Lost(reason) => this.redial(&reason),
            }
        }
    }
}

impl<S: AsyncRead + AsyncWrite + Unpin + 'static> AsyncWrite for TurboSession<S> {
    /// A packet that fails to go out is lost with its connection and KCP sends
    /// it again; while a replacement is dialed, writes wait for it.
    fn poll_write(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        loop {
            ready!(this.poll_up(cx))?;
            let Connection::Up { turbo, .. } = &mut this.connection else { continue };
            match ready!(Pin::new(turbo).poll_write(cx, buf)) {
                Ok(n) => return Poll::Ready(Ok(n)),
                Err(e) => this.redial(&e.to_string()),
            }
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        loop {
            ready!(this.poll_up(cx))?;
            let Connection::Up { turbo, .. } = &mut this.connection else { continue };
            match ready!(Pin::new(turbo).poll_flush(cx)) {
                Ok(()) => return Poll::Ready(Ok(())),
                Err(e) => this.redial(&e.to_string()),
            }
        }
    }

    fn poll_close(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match &mut self.get_mut().connection {
            Connection::Up { turbo, .. } => Pin::new(turbo).poll_close(cx),
            Connection::Dialing(_) | Connection::Failed(_) => Poll::Ready(Ok(())),
        }
    }
}
