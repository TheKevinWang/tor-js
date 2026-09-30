//! The client side of one smux (v2) stream, as github.com/xtaci/smux.
//!
//! Frame: version (2), command, payload length (u16 LE), stream ID (u32 LE),
//! payload. Commands: SYN 0, FIN 1, PSH 2, NOP 3, UPD 4. UPD carries
//! (consumed u32 LE, window u32 LE) for per-stream flow control.
//!
//! Ported from andrewtheguy/webtor-rs `crates/webtor-core/src/smux.rs`
//! (MIT, Copyright (c) 2025-2026 Andrew Chen), with PSH frames capped at
//! smux-go's default `MaxFrameSize` so the 16-bit length can never overflow.

use futures::{AsyncRead, AsyncWrite, AsyncWriteExt};
use gloo_timers::future::TimeoutFuture;
use std::future::Future;
use std::io;
use std::pin::Pin;
use std::task::{Context, Poll, Waker};

const VERSION: u8 = 2;
const CMD_SYN: u8 = 0;
const CMD_FIN: u8 = 1;
const CMD_PSH: u8 = 2;
const CMD_NOP: u8 = 3;
const CMD_UPD: u8 = 4;
const HEADER_LEN: usize = 8;

/// smux-go's `DefaultConfig().MaxFrameSize`.
const MAX_FRAME_SIZE: usize = 32768;
/// Our receive window, advertised in UPD frames. The Snowflake client uses a
/// 1 MB `MaxStreamBuffer`.
const RECEIVE_WINDOW: u32 = 1 << 20;
/// The peer's window until its first UPD arrives (smux-go's initial value).
const INITIAL_PEER_WINDOW: u32 = 262_144;

/// How often to send a NOP. The Snowflake server drops a session it has not
/// heard from in 4 minutes (`KeepAliveTimeout`); smux-go clients ping every 10s.
const KEEPALIVE_MS: u32 = 10_000;

/// The stream the client opens first: smux-go clients start at 1 and add 2.
pub(crate) const FIRST_CLIENT_STREAM: u32 = 3;

fn encode(cmd: u8, stream_id: u32, payload: &[u8]) -> Vec<u8> {
    debug_assert!(payload.len() <= u16::MAX as usize);
    let mut out = Vec::with_capacity(HEADER_LEN + payload.len());
    out.push(VERSION);
    out.push(cmd);
    out.extend_from_slice(&(payload.len() as u16).to_le_bytes());
    out.extend_from_slice(&stream_id.to_le_bytes());
    out.extend_from_slice(payload);
    out
}

fn encode_upd(stream_id: u32, consumed: u32, window: u32) -> Vec<u8> {
    let mut payload = [0u8; 8];
    payload[..4].copy_from_slice(&consumed.to_le_bytes());
    payload[4..].copy_from_slice(&window.to_le_bytes());
    encode(CMD_UPD, stream_id, &payload)
}

/// Decode `(cmd, stream_id, payload range, consumed)` from the front of `buf`.
fn decode(buf: &[u8]) -> io::Result<Option<(u8, u32, std::ops::Range<usize>, usize)>> {
    if buf.len() < HEADER_LEN {
        return Ok(None);
    }
    if buf[0] != VERSION {
        return Err(io::Error::new(io::ErrorKind::InvalidData, format!("bad smux version {}", buf[0])));
    }
    let cmd = buf[1];
    if cmd > CMD_UPD {
        return Err(io::Error::new(io::ErrorKind::InvalidData, format!("bad smux command {cmd}")));
    }
    let len = u16::from_le_bytes([buf[2], buf[3]]) as usize;
    let stream_id = u32::from_le_bytes([buf[4], buf[5], buf[6], buf[7]]);
    let total = HEADER_LEN + len;
    if buf.len() < total {
        return Ok(None);
    }
    Ok(Some((cmd, stream_id, HEADER_LEN..total, total)))
}

pub(crate) struct SmuxStream<S> {
    inner: S,
    stream_id: u32,
    /// Bytes read from the peer, and read since our last UPD.
    self_read: u32,
    self_increment: u32,
    /// Bytes written to the peer, and the peer's last (consumed, window).
    self_write: u32,
    peer_consumed: u32,
    peer_window: u32,
    write_waker: Option<Waker>,
    read_buffer: Vec<u8>,
    data_buffer: Vec<u8>,
    /// Control frames (UPD) waiting to be written.
    pending_control: Vec<u8>,
    eof: bool,
    keepalive: TimeoutFuture,
}

impl<S: AsyncRead + AsyncWrite + Unpin> SmuxStream<S> {
    /// Open stream `stream_id`: send SYN and our receive window.
    pub(crate) async fn open(mut inner: S, stream_id: u32) -> io::Result<Self> {
        let mut init = encode(CMD_SYN, stream_id, &[]);
        init.extend_from_slice(&encode_upd(stream_id, 0, RECEIVE_WINDOW));
        inner.write_all(&init).await?;
        inner.flush().await?;
        Ok(Self {
            inner,
            stream_id,
            self_read: 0,
            self_increment: 0,
            self_write: 0,
            peer_consumed: 0,
            peer_window: INITIAL_PEER_WINDOW,
            write_waker: None,
            read_buffer: Vec::with_capacity(8192),
            data_buffer: Vec::new(),
            pending_control: Vec::new(),
            eof: false,
            keepalive: TimeoutFuture::new(KEEPALIVE_MS),
        })
    }

    fn available_window(&self) -> usize {
        let inflight = self.self_write.wrapping_sub(self.peer_consumed);
        self.peer_window.saturating_sub(inflight) as usize
    }

    /// Write queued control frames. `Ready(Ok)` once none are left.
    fn poll_control(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        while !self.pending_control.is_empty() {
            match Pin::new(&mut self.inner).poll_write(cx, &self.pending_control) {
                Poll::Ready(Ok(0)) => return Poll::Ready(Err(io::ErrorKind::WriteZero.into())),
                Poll::Ready(Ok(n)) => {
                    self.pending_control.drain(..n);
                }
                Poll::Ready(Err(e)) => return Poll::Ready(Err(e)),
                Poll::Pending => return Poll::Pending,
            }
        }
        Pin::new(&mut self.inner).poll_flush(cx)
    }
}

impl<S: AsyncRead + AsyncWrite + Unpin> AsyncRead for SmuxStream<S> {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut [u8]) -> Poll<io::Result<usize>> {
        let this = &mut *self;
        while Pin::new(&mut this.keepalive).poll(cx).is_ready() {
            this.pending_control.extend_from_slice(&encode(CMD_NOP, 0, &[]));
            this.keepalive = TimeoutFuture::new(KEEPALIVE_MS);
        }
        if let Poll::Ready(Err(e)) = this.poll_control(cx) {
            return Poll::Ready(Err(e));
        }
        loop {
            if !this.data_buffer.is_empty() {
                let n = buf.len().min(this.data_buffer.len());
                buf[..n].copy_from_slice(&this.data_buffer[..n]);
                this.data_buffer.drain(..n);
                return Poll::Ready(Ok(n));
            }
            if this.eof {
                return Poll::Ready(Ok(0));
            }
            if let Some((cmd, sid, range, consumed)) = decode(&this.read_buffer)? {
                let payload = this.read_buffer[range].to_vec();
                this.read_buffer.drain(..consumed);
                if sid != this.stream_id && sid != 0 {
                    continue;
                }
                match cmd {
                    CMD_PSH => {
                        let len = payload.len() as u32;
                        this.self_read = this.self_read.wrapping_add(len);
                        this.self_increment = this.self_increment.wrapping_add(len);
                        if this.self_increment >= RECEIVE_WINDOW / 2 {
                            let upd = encode_upd(this.stream_id, this.self_read, RECEIVE_WINDOW);
                            this.pending_control.extend_from_slice(&upd);
                            this.self_increment = 0;
                            if let Poll::Ready(Err(e)) = this.poll_control(cx) {
                                return Poll::Ready(Err(e));
                            }
                        }
                        this.data_buffer = payload;
                    }
                    CMD_FIN => this.eof = true,
                    CMD_UPD if payload.len() >= 8 => {
                        this.peer_consumed = u32::from_le_bytes(payload[..4].try_into().expect("4 bytes"));
                        this.peer_window = u32::from_le_bytes(payload[4..8].try_into().expect("4 bytes"));
                        if let Some(w) = this.write_waker.take() {
                            w.wake();
                        }
                    }
                    // SYN from the server and NOP keepalives need no action.
                    _ => {}
                }
                continue;
            }
            let mut temp = [0u8; 16384];
            match Pin::new(&mut this.inner).poll_read(cx, &mut temp) {
                Poll::Ready(Ok(0)) => {
                    this.eof = true;
                }
                Poll::Ready(Ok(n)) => this.read_buffer.extend_from_slice(&temp[..n]),
                Poll::Ready(Err(e)) => return Poll::Ready(Err(e)),
                Poll::Pending => return Poll::Pending,
            }
        }
    }
}

impl<S: AsyncRead + AsyncWrite + Unpin> AsyncWrite for SmuxStream<S> {
    fn poll_write(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
        let this = &mut *self;
        futures::ready!(this.poll_control(cx))?;
        // Respect the peer's window: a peer that receives past it stops
        // reading the whole session, not just this stream.
        let available = this.available_window();
        if available == 0 {
            this.write_waker = Some(cx.waker().clone());
            return Poll::Pending;
        }
        let chunk = &buf[..buf.len().min(available).min(MAX_FRAME_SIZE)];
        let frame = encode(CMD_PSH, this.stream_id, chunk);
        match Pin::new(&mut this.inner).poll_write(cx, &frame) {
            // KCP (below) takes whole writes.
            Poll::Ready(Ok(n)) if n == frame.len() => {
                this.self_write = this.self_write.wrapping_add(chunk.len() as u32);
                Poll::Ready(Ok(chunk.len()))
            }
            Poll::Ready(Ok(_)) => Poll::Ready(Err(io::Error::new(io::ErrorKind::WriteZero, "partial smux write"))),
            Poll::Ready(Err(e)) => Poll::Ready(Err(e)),
            Poll::Pending => Poll::Pending,
        }
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        futures::ready!(self.poll_control(cx))?;
        Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_close(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let this = &mut *self;
        if this.stream_id != 0 {
            this.pending_control.extend_from_slice(&encode(CMD_FIN, this.stream_id, &[]));
            // Only send FIN once.
            this.stream_id = 0;
        }
        futures::ready!(this.poll_control(cx))?;
        Pin::new(&mut this.inner).poll_close(cx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_use_little_endian_header() {
        let f = encode(CMD_PSH, 3, b"hi");
        assert_eq!(f, vec![2, 2, 2, 0, 3, 0, 0, 0, b'h', b'i']);
        let (cmd, sid, range, consumed) = decode(&f).unwrap().unwrap();
        assert_eq!((cmd, sid, &f[range], consumed), (CMD_PSH, 3, &b"hi"[..], 10));
        assert!(decode(&f[..9]).unwrap().is_none());
    }

    #[test]
    fn upd_payload_is_consumed_then_window() {
        let f = encode_upd(3, 1000, 65535);
        assert_eq!(&f[8..], &[0xE8, 0x03, 0, 0, 0xFF, 0xFF, 0, 0]);
    }

    #[test]
    fn bad_version_is_rejected() {
        let mut f = encode(CMD_NOP, 0, &[]);
        f[0] = 1;
        assert!(decode(&f).is_err());
    }
}
