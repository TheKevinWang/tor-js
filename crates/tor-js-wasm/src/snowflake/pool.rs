//! Snowflake sessions established independently of the arti dial that asked.
//!
//! arti gives a direct connection 5 seconds to finish, TLS and Tor handshake
//! included (`ChanBuilder::connect_via_transport`), and a Snowflake bridge is
//! a direct bridge as far as arti knows. A WebRTC session needs a broker match
//! and ICE first, which often takes longer. So a session is opened by a task
//! of its own: if the dial that started it gives up, the task finishes anyway
//! and parks the session, keeping it alive, for the next dial — arti retries a
//! failed guard after about 30 seconds — to take at once.

use super::{open, CarrierConfig, Stack};
use futures::channel::oneshot;
use futures::future::{select, Either};
use futures::AsyncReadExt;
use gloo_timers::future::TimeoutFuture;
use std::cell::RefCell;
use std::collections::HashMap;
use std::io;
use std::pin::pin;
use std::rc::Rc;
use tracing::{info, warn};

/// How long a parked session waits for a dial before it is closed.
const PARKED_LIFETIME_MS: u32 = 180_000;

enum State {
    Idle,
    Opening { waiters: Vec<oneshot::Sender<()>> },
    /// A session held by its keeper task; send it a reply channel to take it.
    Parked { take: oneshot::Sender<oneshot::Sender<Stack>> },
    /// The last attempt failed; the next dial reports it once.
    Failed(String),
}

struct Pool {
    config: CarrierConfig,
    state: RefCell<State>,
}

thread_local! {
    static POOLS: RefCell<HashMap<CarrierConfig, Rc<Pool>>> = RefCell::new(HashMap::new());
}

fn pool_for(config: &CarrierConfig) -> Rc<Pool> {
    POOLS.with(|pools| {
        pools
            .borrow_mut()
            .entry(config.clone())
            .or_insert_with(|| Rc::new(Pool { config: config.clone(), state: RefCell::new(State::Idle) }))
            .clone()
    })
}

/// Take a session for `config`: a parked one, the one being opened, or a new
/// one. Dropping the returned future does not cancel the opening.
pub(super) async fn take(config: &CarrierConfig) -> io::Result<Stack> {
    let pool = pool_for(config);
    loop {
        let state = std::mem::replace(&mut *pool.state.borrow_mut(), State::Idle);
        match state {
            State::Parked { take } => {
                let (reply, stack) = oneshot::channel();
                if take.send(reply).is_ok() {
                    if let Ok(stack) = stack.await {
                        info!("Snowflake: using a session opened earlier");
                        return Ok(stack);
                    }
                }
                // The keeper had already let it go; open another.
            }
            State::Failed(e) => return Err(io::Error::other(e)),
            State::Idle => {
                *pool.state.borrow_mut() = State::Opening { waiters: Vec::new() };
                wasm_bindgen_futures::spawn_local(open_and_park(pool.clone()));
            }
            State::Opening { mut waiters } => {
                let (tx, rx) = oneshot::channel();
                waiters.push(tx);
                *pool.state.borrow_mut() = State::Opening { waiters };
                let _ = rx.await;
            }
        }
    }
}

/// Open a session for `config` ahead of any dial and wait until it is parked
/// (or has failed). Used before bootstrap, so arti's first dial finds a ready
/// session instead of racing the broker and ICE against its 5 second timeout —
/// a timed-out first dial marks the bridge down for 30 seconds or more.
pub(super) async fn warm(config: &CarrierConfig) -> io::Result<()> {
    let pool = pool_for(config);
    loop {
        let rx = {
            let mut state = pool.state.borrow_mut();
            match &mut *state {
                State::Parked { .. } => return Ok(()),
                State::Failed(e) => {
                    // Reported here; arti's own dial starts afresh.
                    let e = io::Error::other(e.clone());
                    *state = State::Idle;
                    return Err(e);
                }
                State::Idle => {
                    *state = State::Opening { waiters: Vec::new() };
                    wasm_bindgen_futures::spawn_local(open_and_park(pool.clone()));
                    continue;
                }
                State::Opening { waiters } => {
                    let (tx, rx) = oneshot::channel();
                    waiters.push(tx);
                    rx
                }
            }
        };
        let _ = rx.await;
    }
}

async fn open_and_park(pool: Rc<Pool>) {
    let result = open(pool.config.clone()).await;
    let next = match result {
        Ok(stack) => {
            let (take, take_rx) = oneshot::channel();
            wasm_bindgen_futures::spawn_local(keep(stack, take_rx));
            State::Parked { take }
        }
        Err(e) => {
            warn!("Snowflake: could not open a session: {e}");
            State::Failed(e.to_string())
        }
    };
    let previous = std::mem::replace(&mut *pool.state.borrow_mut(), next);
    if let State::Opening { waiters } = previous {
        for w in waiters {
            let _ = w.send(());
        }
    }
}

/// Hold a parked session: keep reading it (which runs KCP's clock and smux
/// keepalives) until a dial takes it, it fails, or it has waited too long.
async fn keep(mut stack: Stack, take_rx: oneshot::Receiver<oneshot::Sender<Stack>>) {
    let expiry = TimeoutFuture::new(PARKED_LIFETIME_MS);
    let mut stop = pin!(select(take_rx, expiry));
    let mut buf = [0u8; 1];
    let reply = {
        let read = pin!(stack.read(&mut buf));
        match select(read, stop.as_mut()).await {
            // A bridge says nothing before the client's TLS ClientHello, so
            // anything here means the session is broken.
            Either::Left((result, _)) => {
                warn!("Snowflake: a parked session ended ({:?})", result.map(|_| "unexpected data"));
                return;
            }
            Either::Right((Either::Left((Ok(reply), _)), _)) => reply,
            Either::Right(_) => {
                info!("Snowflake: closing a session no dial took");
                return;
            }
        }
    };
    let _ = reply.send(stack);
}
