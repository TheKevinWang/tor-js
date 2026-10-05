//! Cancelling a fetch from JavaScript.
//!
//! Checking `signal.aborted()` between steps is not enough: a step that is
//! already waiting on the network (building a circuit, the TLS handshake, the
//! response head, the next body chunk) would not notice until data arrived.
//! An [`AbortWatch`] turns the signal's `abort` event into a future that each
//! such step is raced against; the step that loses is dropped, and dropping it
//! closes the Tor stream it held.

use std::cell::RefCell;
use std::future::Future;
use std::pin::{pin, Pin};
use std::task::Poll;

use futures::channel::oneshot;
use futures::future::{self, Either};
use wasm_bindgen::closure::Closure;
use wasm_bindgen::{JsCast, JsValue};

use crate::error::JsTorError;

/// Listens for one `AbortSignal`'s `abort` event for as long as it lives.
pub struct AbortWatch {
    signal: web_sys::AbortSignal,
    listener: Closure<dyn FnMut()>,
    fired: oneshot::Receiver<()>,
    done: bool,
}

impl AbortWatch {
    pub fn new(signal: web_sys::AbortSignal) -> Self {
        let (tx, rx) = oneshot::channel();
        let tx = RefCell::new(Some(tx));
        let listener = Closure::<dyn FnMut()>::new(move || {
            if let Some(tx) = tx.borrow_mut().take() {
                let _ = tx.send(());
            }
        });
        let _ = signal.add_event_listener_with_callback("abort", listener.as_ref().unchecked_ref());
        Self { signal, listener, fired: rx, done: false }
    }

    /// Resolves once the signal has aborted, at once if it already has.
    fn aborted(&mut self) -> impl Future<Output = ()> + '_ {
        future::poll_fn(move |cx| {
            if self.done || self.signal.aborted() {
                self.done = true;
                return Poll::Ready(());
            }
            match Pin::new(&mut self.fired).poll(cx) {
                Poll::Ready(_) => {
                    self.done = true;
                    Poll::Ready(())
                }
                Poll::Pending => Poll::Pending,
            }
        })
    }

    /// `fut`'s result, unless the signal aborts first: then `fut` is dropped
    /// (closing whatever it held open) and the abort error is returned. The
    /// signal is looked at before `fut` is first polled, so an already-aborted
    /// signal never lets `fut` start sending.
    pub async fn guard<T>(&mut self, fut: impl Future<Output = Result<T, JsValue>>) -> Result<T, JsValue> {
        let aborted = pin!(self.aborted());
        let fut = pin!(fut);
        match future::select(aborted, fut).await {
            Either::Left(_) => Err(JsTorError::aborted().into_js_value()),
            Either::Right((result, _)) => result,
        }
    }
}

impl Drop for AbortWatch {
    fn drop(&mut self) {
        let _ = self
            .signal
            .remove_event_listener_with_callback("abort", self.listener.as_ref().unchecked_ref());
    }
}
