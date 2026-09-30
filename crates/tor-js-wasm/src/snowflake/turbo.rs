//! Turbo Tunnel framing, as Snowflake's `common/encapsulation` package.
//!
//! A connection opens with the 8-byte Turbo Tunnel token and the session's
//! 8-byte client ID; after that every packet travels as one frame:
//!
//! - header byte 0: bit 7 = data (1) or padding (0); bit 6 = another length
//!   byte follows; bits 5-0 = the high bits of the length
//! - each further header byte: bit 7 = another follows; bits 6-0 = length
//!
//! Ported from andrewtheguy/webtor-rs `crates/webtor-core/src/turbo.rs`
//! (MIT, Copyright (c) 2025-2026 Andrew Chen).

use futures::{AsyncRead, AsyncWrite, AsyncWriteExt};
use std::io;
use std::pin::Pin;
use std::task::{Context, Poll};

/// `turbotunnel.Token` in snowflake/common/turbotunnel/consts.go.
pub(crate) const TURBO_TOKEN: [u8; 8] = [0x12, 0x93, 0x60, 0x5d, 0x27, 0x81, 0x75, 0xf5];

/// Largest length a 3-byte header can express.
const MAX_FRAME_LEN: usize = 0xFFFFF;

/// Encode one data frame carrying `data`.
pub(crate) fn encode_frame(data: &[u8]) -> io::Result<Vec<u8>> {
    let len = data.len();
    let mut out = Vec::with_capacity(len + 3);
    if len <= 0x3F {
        out.push(0x80 | len as u8);
    } else if len <= 0x1FFF {
        out.push(0x80 | 0x40 | (len >> 7) as u8 & 0x3F);
        out.push((len & 0x7F) as u8);
    } else if len <= MAX_FRAME_LEN {
        out.push(0x80 | 0x40 | (len >> 14) as u8 & 0x3F);
        out.push(0x80 | (len >> 7) as u8 & 0x7F);
        out.push((len & 0x7F) as u8);
    } else {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "Turbo frame too large"));
    }
    out.extend_from_slice(data);
    Ok(out)
}

/// Decode one frame from the front of `buf`: `(is_data, payload, consumed)`,
/// `None` if `buf` does not yet hold a whole frame, or an error for a header
/// longer than the 3 bytes `encapsulation.ReadData` accepts.
pub(crate) fn decode_frame(buf: &[u8]) -> io::Result<Option<(bool, &[u8], usize)>> {
    let Some(&b0) = buf.first() else { return Ok(None) };
    let is_data = b0 & 0x80 != 0;
    let mut len = (b0 & 0x3F) as usize;
    let mut header = 1;
    let mut more = b0 & 0x40 != 0;
    while more {
        if header == 3 {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "Turbo frame length too long"));
        }
        let Some(&b) = buf.get(header) else { return Ok(None) };
        len = (len << 7) | (b & 0x7F) as usize;
        more = b & 0x80 != 0;
        header += 1;
    }
    let total = header + len;
    Ok(buf.get(header..total).map(|payload| (is_data, payload, total)))
}

/// One carrier connection speaking Turbo Tunnel framing. Each `poll_write` is
/// one packet (one frame); each `poll_read` returns one packet's payload, so a
/// reader whose buffer holds a whole KCP packet (MTU 1400) never splits one.
pub(crate) struct TurboStream<S> {
    inner: S,
    read_buffer: Vec<u8>,
}

impl<S: AsyncRead + AsyncWrite + Unpin> TurboStream<S> {
    /// Open the connection for the session `client_id` names: the bridge keys
    /// sessions by it, so every connection of one session sends the same ID.
    pub(crate) async fn open(mut inner: S, client_id: [u8; 8]) -> io::Result<Self> {
        let mut init = Vec::with_capacity(16);
        init.extend_from_slice(&TURBO_TOKEN);
        init.extend_from_slice(&client_id);
        inner.write_all(&init).await?;
        inner.flush().await?;
        Ok(Self { inner, read_buffer: Vec::with_capacity(8192) })
    }
}

impl<S: AsyncRead + Unpin> AsyncRead for TurboStream<S> {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut [u8]) -> Poll<io::Result<usize>> {
        loop {
            if let Some((is_data, payload, consumed)) = decode_frame(&self.read_buffer)? {
                if payload.len() > buf.len() {
                    return Poll::Ready(Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        format!("Turbo packet of {} bytes exceeds read buffer", payload.len()),
                    )));
                }
                let n = payload.len();
                if is_data {
                    buf[..n].copy_from_slice(payload);
                }
                self.read_buffer.drain(..consumed);
                if is_data {
                    return Poll::Ready(Ok(n));
                }
                continue; // padding
            }
            let mut temp = [0u8; 8192];
            match Pin::new(&mut self.inner).poll_read(cx, &mut temp) {
                Poll::Ready(Ok(0)) => return Poll::Ready(Ok(0)),
                Poll::Ready(Ok(n)) => self.read_buffer.extend_from_slice(&temp[..n]),
                Poll::Ready(Err(e)) => return Poll::Ready(Err(e)),
                Poll::Pending => return Poll::Pending,
            }
        }
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for TurboStream<S> {
    fn poll_write(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
        // The carriers used here (WebSocket, RTCDataChannel) take a whole
        // message or fail, so a frame is never written in part.
        let encoded = encode_frame(buf)?;
        match Pin::new(&mut self.inner).poll_write(cx, &encoded) {
            Poll::Ready(Ok(n)) if n == encoded.len() => Poll::Ready(Ok(buf.len())),
            Poll::Ready(Ok(_)) => Poll::Ready(Err(io::Error::new(io::ErrorKind::WriteZero, "partial Turbo frame write"))),
            Poll::Ready(Err(e)) => Poll::Ready(Err(e)),
            Poll::Pending => Poll::Pending,
        }
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_close(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_close(cx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_round_trip_at_header_boundaries() {
        for len in [0usize, 1, 0x3F, 0x40, 0x1FFF, 0x2000, 70_000] {
            let data: Vec<u8> = (0..len).map(|i| i as u8).collect();
            let encoded = encode_frame(&data).unwrap();
            let header = encoded.len() - len;
            assert_eq!(header, if len <= 0x3F { 1 } else if len <= 0x1FFF { 2 } else { 3 });
            let (is_data, payload, consumed) = decode_frame(&encoded).unwrap().unwrap();
            assert!(is_data);
            assert_eq!(payload, &data[..]);
            assert_eq!(consumed, encoded.len());
            for split in 0..encoded.len() {
                assert!(decode_frame(&encoded[..split]).unwrap().is_none(), "prefix {split} of {len}");
            }
        }
    }

    /// Matches snowflake's encapsulation.WriteData for a 100-byte packet.
    #[test]
    fn two_byte_header_matches_go_encoding() {
        let encoded = encode_frame(&[0u8; 100]).unwrap();
        assert_eq!(&encoded[..2], &[0xC0, 0x64]);
    }

    #[test]
    fn padding_frames_are_marked() {
        // Padding frame of 5 bytes: data bit clear.
        let frame = [0x05, 1, 2, 3, 4, 5];
        let (is_data, payload, consumed) = decode_frame(&frame).unwrap().unwrap();
        assert!(!is_data);
        assert_eq!(payload.len(), 5);
        assert_eq!(consumed, 6);
    }

    #[test]
    fn four_byte_headers_are_rejected() {
        assert!(decode_frame(&[0xC0, 0x80, 0x80, 0x00]).is_err());
    }
}
