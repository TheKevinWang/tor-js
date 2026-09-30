//! KCP over any packet-preserving `AsyncRead + AsyncWrite`.
//!
//! KCP turns the Turbo Tunnel packet stream (which may lose packets when a
//! carrier connection is replaced) into a reliable, ordered byte stream.
//! Settings match the Snowflake client (`client/lib/snowflake.go`): stream
//! mode, no congestion window.
//!
//! Ported from andrewtheguy/webtor-rs `crates/webtor-core/src/kcp_stream.rs`
//! (MIT, Copyright (c) 2025-2026 Andrew Chen).

use futures::{AsyncRead, AsyncWrite};
use gloo_timers::future::TimeoutFuture;
use kcp::Kcp;
use std::collections::VecDeque;
use std::future::Future;
use std::io::{self, Write};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use web_time_compat::Instant;

/// Bounds on how often KCP's clock runs while the transport is quiet.
/// Retransmissions and window probes only leave KCP from `update()`; without a
/// timer a burst that fills the window would wedge once both ends go silent.
const TICK_MIN_MS: u32 = 10;
const TICK_MAX_MS: u32 = 100;

/// Receive and send windows, in packets. KCP's minimum receive window is 128.
const SND_WND: u16 = 256;
const RCV_WND: u16 = 256;

/// Where KCP puts the packets it wants sent. KCP writes once per packet and
/// the peer expects packets back one at a time, so each stays separate and
/// becomes one Turbo frame.
#[derive(Clone)]
struct OutputBuffer {
    packets: Arc<Mutex<VecDeque<Vec<u8>>>>,
}

impl OutputBuffer {
    fn take(&self) -> VecDeque<Vec<u8>> {
        std::mem::take(&mut *self.packets.lock().expect("poisoned"))
    }
}

impl Write for OutputBuffer {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.packets.lock().expect("poisoned").push_back(buf.to_vec());
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn kcp_err(what: &str, e: kcp::Error) -> io::Error {
    io::Error::other(format!("KCP {what} error: {e:?}"))
}

pub(crate) struct KcpStream<S> {
    kcp: Kcp<OutputBuffer>,
    output: OutputBuffer,
    transport: S,
    start: Instant,
    /// Packets KCP produced that the transport has not taken yet.
    pending_write: VecDeque<Vec<u8>>,
    /// Wakes the reader when KCP's clock next needs to run.
    tick: Option<TimeoutFuture>,
}

impl<S> KcpStream<S> {
    pub(crate) fn new(transport: S) -> Self {
        let output = OutputBuffer { packets: Arc::new(Mutex::new(VecDeque::new())) };
        let mut kcp = Kcp::new_stream(0, output.clone());
        // conn.SetNoDelay(0, 0, 0, 1): nodelay off, default 100ms interval,
        // no fast resend, congestion window off.
        kcp.set_nodelay(false, 100, 0, true);
        kcp.set_wndsize(SND_WND, RCV_WND);
        Self {
            kcp,
            output,
            transport,
            start: Instant::now(),
            pending_write: VecDeque::new(),
            tick: None,
        }
    }

    fn now_ms(&self) -> u32 {
        self.start.elapsed().as_millis() as u32
    }
}

impl<S: AsyncWrite + Unpin> KcpStream<S> {
    /// Hand KCP's packets to the transport one at a time, keeping whatever the
    /// transport will not take yet.
    fn drain_output(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.pending_write.append(&mut self.output.take());
        while let Some(packet) = self.pending_write.pop_front() {
            match Pin::new(&mut self.transport).poll_write(cx, &packet) {
                Poll::Ready(Ok(_)) => {}
                Poll::Ready(Err(e)) => return Poll::Ready(Err(e)),
                Poll::Pending => {
                    self.pending_write.push_front(packet);
                    return Poll::Pending;
                }
            }
        }
        Pin::new(&mut self.transport).poll_flush(cx)
    }

    /// Run KCP's clock while the transport has nothing to deliver and arm the
    /// next run. Only ever produces protocol traffic, so it returns `Pending`
    /// unless something failed.
    fn poll_tick(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<usize>> {
        if let Some(tick) = self.tick.as_mut() {
            match Pin::new(tick).poll(cx) {
                Poll::Pending => return Poll::Pending,
                Poll::Ready(()) => self.tick = None,
            }
        }
        let now = self.now_ms();
        self.kcp.update(now).map_err(|e| kcp_err("update", e))?;
        if let Poll::Ready(Err(e)) = self.drain_output(cx) {
            return Poll::Ready(Err(e));
        }
        let delay = self.kcp.check(now).clamp(TICK_MIN_MS, TICK_MAX_MS);
        let mut tick = TimeoutFuture::new(delay);
        // Poll once so the timer holds this task's waker.
        let _ = Pin::new(&mut tick).poll(cx);
        self.tick = Some(tick);
        Poll::Pending
    }
}

impl<S: AsyncRead + AsyncWrite + Unpin> AsyncRead for KcpStream<S> {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut [u8]) -> Poll<io::Result<usize>> {
        let this = &mut *self;
        loop {
            match this.kcp.recv(buf) {
                Ok(n) => return Poll::Ready(Ok(n)),
                Err(kcp::Error::RecvQueueEmpty) => {}
                Err(e) => return Poll::Ready(Err(kcp_err("recv", e))),
            }

            // A whole packet (MTU 1400) always fits.
            let mut temp = [0u8; 4096];
            match Pin::new(&mut this.transport).poll_read(cx, &mut temp) {
                Poll::Ready(Ok(0)) => return Poll::Ready(Ok(0)),
                Poll::Ready(Ok(n)) => {
                    this.kcp
                        .input(&temp[..n])
                        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, format!("KCP input error: {e:?}")))?;
                    let now = this.now_ms();
                    this.kcp.update(now).map_err(|e| kcp_err("update", e))?;
                    // Send what that produced — ACKs above all, or the peer
                    // retransmits.
                    if let Poll::Ready(Err(e)) = this.drain_output(cx) {
                        return Poll::Ready(Err(e));
                    }
                }
                Poll::Ready(Err(e)) => return Poll::Ready(Err(e)),
                // Nothing to read: KCP's own clock has to run.
                Poll::Pending => return this.poll_tick(cx),
            }
        }
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for KcpStream<S> {
    fn poll_write(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
        let this = &mut *self;
        let n = this.kcp.send(buf).map_err(|e| kcp_err("send", e))?;
        let now = this.now_ms();
        this.kcp.update(now).map_err(|e| kcp_err("update", e))?;
        this.kcp.flush().map_err(|e| kcp_err("flush", e))?;
        // KCP owns the bytes now, so report them written even if the
        // transport is busy: answering `Pending` would have the caller offer
        // the same bytes again and queue them twice. Leftover packets go out
        // on the next drain.
        match this.drain_output(cx) {
            Poll::Ready(Err(e)) => Poll::Ready(Err(e)),
            _ => Poll::Ready(Ok(n)),
        }
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let this = &mut *self;
        let now = this.now_ms();
        this.kcp.update(now).map_err(|e| kcp_err("update", e))?;
        this.kcp.flush().map_err(|e| kcp_err("flush", e))?;
        this.drain_output(cx)
    }

    fn poll_close(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        futures::ready!(self.as_mut().poll_flush(cx))?;
        Pin::new(&mut self.transport).poll_close(cx)
    }
}
