//! A browser (or Node) `WebSocket` as a byte stream.
//!
//! Ported from andrewtheguy/webtor-rs `crates/webtor-core/src/websocket.rs`
//! (MIT, Copyright (c) 2025-2026 Andrew Chen).

use futures::channel::{mpsc, oneshot};
use futures::{AsyncRead, AsyncWrite, StreamExt};
use js_sys::{ArrayBuffer, Uint8Array};
use std::cell::RefCell;
use std::io;
use std::pin::Pin;
use std::rc::Rc;
use std::task::{Context, Poll};
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;
use web_sys::{BinaryType, MessageEvent, WebSocket};

pub(crate) struct WebSocketStream {
    socket: WebSocket,
    receiver: mpsc::UnboundedReceiver<io::Result<Vec<u8>>>,
    read_buffer: Vec<u8>,
    _on_message: Closure<dyn FnMut(MessageEvent)>,
    _on_error: Closure<dyn FnMut(web_sys::Event)>,
    _on_close: Closure<dyn FnMut(web_sys::CloseEvent)>,
}

impl WebSocketStream {
    pub(crate) async fn connect(url: &str) -> io::Result<Self> {
        let socket = WebSocket::new(url)
            .map_err(|e| io::Error::other(format!("WebSocket creation failed: {e:?}")))?;
        socket.set_binary_type(BinaryType::Arraybuffer);

        let (sender, receiver) = mpsc::unbounded();
        let message_sender = sender.clone();
        let error_sender = sender.clone();
        let close_sender = sender;
        let (open_sender, open_receiver) = oneshot::channel::<Result<(), String>>();
        let open_sender = Rc::new(RefCell::new(Some(open_sender)));

        let on_message = Closure::wrap(Box::new(move |event: MessageEvent| {
            if let Ok(buffer) = event.data().dyn_into::<ArrayBuffer>() {
                let _ = message_sender.unbounded_send(Ok(Uint8Array::new(&buffer).to_vec()));
            }
        }) as Box<dyn FnMut(MessageEvent)>);
        socket.set_onmessage(Some(on_message.as_ref().unchecked_ref()));

        // A WebSocket `error` event is a plain `Event` in browsers (no
        // message), so it is not typed as `ErrorEvent` here.
        let error_open_sender = open_sender.clone();
        let error_url = url.to_owned();
        let on_error = Closure::wrap(Box::new(move |_event: web_sys::Event| {
            let message = format!("WebSocket error on {error_url}");
            if let Some(sender) = error_open_sender.borrow_mut().take() {
                let _ = sender.send(Err(message.clone()));
            }
            let _ = error_sender.unbounded_send(Err(io::Error::other(message)));
        }) as Box<dyn FnMut(web_sys::Event)>);
        socket.set_onerror(Some(on_error.as_ref().unchecked_ref()));

        let close_open_sender = open_sender.clone();
        let on_close = Closure::wrap(Box::new(move |event: web_sys::CloseEvent| {
            let message = format!("WebSocket closed with code {}: {}", event.code(), event.reason());
            if let Some(sender) = close_open_sender.borrow_mut().take() {
                let _ = sender.send(Err(message.clone()));
            }
            let _ = close_sender.unbounded_send(if event.was_clean() {
                Ok(Vec::new())
            } else {
                Err(io::Error::new(io::ErrorKind::ConnectionAborted, message))
            });
        }) as Box<dyn FnMut(web_sys::CloseEvent)>);
        socket.set_onclose(Some(on_close.as_ref().unchecked_ref()));

        let on_open = Closure::once(move || {
            if let Some(sender) = open_sender.borrow_mut().take() {
                let _ = sender.send(Ok(()));
            }
        });
        socket.set_onopen(Some(on_open.as_ref().unchecked_ref()));

        // Own the callbacks before waiting, so that a connect given up while
        // the socket opens closes it and unhooks them through Drop.
        let stream = Self {
            socket,
            receiver,
            read_buffer: Vec::new(),
            _on_message: on_message,
            _on_error: on_error,
            _on_close: on_close,
        };

        match open_receiver.await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => return Err(io::Error::new(io::ErrorKind::ConnectionRefused, e)),
            Err(_) => return Err(io::Error::other("WebSocket open callback was dropped")),
        }
        stream.socket.set_onopen(None);
        drop(on_open);
        Ok(stream)
    }
}

impl Drop for WebSocketStream {
    fn drop(&mut self) {
        self.socket.set_onopen(None);
        self.socket.set_onmessage(None);
        self.socket.set_onerror(None);
        self.socket.set_onclose(None);
        let _ = self.socket.close();
    }
}

impl AsyncRead for WebSocketStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        output: &mut [u8],
    ) -> Poll<io::Result<usize>> {
        if self.read_buffer.is_empty() {
            match self.receiver.poll_next_unpin(cx) {
                Poll::Ready(Some(Ok(data))) => self.read_buffer = data,
                Poll::Ready(Some(Err(e))) => return Poll::Ready(Err(e)),
                Poll::Ready(None) => return Poll::Ready(Ok(0)),
                Poll::Pending => return Poll::Pending,
            }
            if self.read_buffer.is_empty() {
                // Clean close.
                return Poll::Ready(Ok(0));
            }
        }
        let count = output.len().min(self.read_buffer.len());
        output[..count].copy_from_slice(&self.read_buffer[..count]);
        self.read_buffer.drain(..count);
        Poll::Ready(Ok(count))
    }
}

impl AsyncWrite for WebSocketStream {
    fn poll_write(self: Pin<&mut Self>, _cx: &mut Context<'_>, data: &[u8]) -> Poll<io::Result<usize>> {
        match self.socket.send_with_u8_array(data) {
            Ok(()) => Poll::Ready(Ok(data.len())),
            Err(e) => Poll::Ready(Err(io::Error::other(format!("WebSocket send failed: {e:?}")))),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_close(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(
            self.socket
                .close()
                .map_err(|e| io::Error::other(format!("WebSocket close failed: {e:?}"))),
        )
    }
}
