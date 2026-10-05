//! Implementation of [`PowManager`], for tracking proof-of-work seeds and data
//! for adjusting difficulty.

#[cfg_attr(not(feature = "hs-pow-full"), path = "pow/v1_stub.rs")]
pub(crate) mod v1;

use std::{pin::Pin, sync::Arc};

pub(crate) use self::v1::PowManager;

use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};

use futures::{Stream, channel::mpsc};
use tor_async_utils::mpsc_channel_no_memquota;
use tor_hscrypto::time::TimePeriod;

use crate::RendRequest;

/// Struct to hold various things you get when you make a new [`PowManager`].
pub(crate) struct NewPowManager<R> {
    /// The PoW manager.
    pub(crate) pow_manager: Arc<PowManager<R>>,
    /// Sender for rendezvous requests.
    pub(crate) rend_req_tx: mpsc::Sender<RendRequest>,
    /// Receiver for rendezvous requests.
    pub(crate) rend_req_rx: Pin<Box<dyn Stream<Item = RendRequest> + Send + Sync>>,
    /// Receiver used for the publisher to hear when it needs to republish for a TP because of a
    /// seed update.
    pub(crate) publisher_update_rx: mpsc::Receiver<TimePeriod>,
}

/// A reading of what the proof-of-work subsystem has done so far (tor-js patch).
///
/// With proof of work off, or in a build without the `hs-pow-full` feature, `enabled` is false
/// and everything else is zero.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct PowStatsSnapshot {
    /// Whether proof of work is on for this service.
    pub enabled: bool,
    /// Solutions that checked out.
    pub verified: u64,
    /// Solutions refused: unknown or expired seed, a replayed nonce, a malformed or wrong solution.
    pub rejected: u64,
    /// Requests put on the priority queue.
    pub enqueued: u64,
    /// Requests removed from the queue without being served: queue full, or too old.
    pub dropped: u64,
    /// Requests waiting on the queue now.
    pub queue_len: u64,
    /// The effort the service currently asks visitors for (zero when it is not busy).
    pub suggested_effort: u32,
    /// The largest effort seen in a verified solution.
    pub max_effort_seen: u32,
}

/// Counters for the proof-of-work subsystem, shared between the tasks that update them and
/// whoever reads a [`PowStatsSnapshot`] (tor-js patch).
#[derive(Debug, Default)]
pub struct PowStats {
    /// See [`PowStatsSnapshot::enabled`].
    enabled: bool,
    /// See [`PowStatsSnapshot::verified`].
    verified: AtomicU64,
    /// See [`PowStatsSnapshot::rejected`].
    rejected: AtomicU64,
    /// See [`PowStatsSnapshot::enqueued`].
    enqueued: AtomicU64,
    /// See [`PowStatsSnapshot::dropped`].
    dropped: AtomicU64,
    /// See [`PowStatsSnapshot::queue_len`].
    queue_len: AtomicU64,
    /// See [`PowStatsSnapshot::suggested_effort`].
    suggested_effort: AtomicU32,
    /// See [`PowStatsSnapshot::max_effort_seen`].
    max_effort_seen: AtomicU32,
}

impl PowStats {
    /// New counters, all zero.
    pub(crate) fn new(enabled: bool) -> Self {
        Self {
            enabled,
            ..Self::default()
        }
    }

    /// Read the counters.
    pub fn snapshot(&self) -> PowStatsSnapshot {
        PowStatsSnapshot {
            enabled: self.enabled,
            verified: self.verified.load(Ordering::Relaxed),
            rejected: self.rejected.load(Ordering::Relaxed),
            enqueued: self.enqueued.load(Ordering::Relaxed),
            dropped: self.dropped.load(Ordering::Relaxed),
            queue_len: self.queue_len.load(Ordering::Relaxed),
            suggested_effort: self.suggested_effort.load(Ordering::Relaxed),
            max_effort_seen: self.max_effort_seen.load(Ordering::Relaxed),
        }
    }

    /// A solution checked out, at this effort.
    #[cfg_attr(not(feature = "hs-pow-full"), allow(dead_code))]
    pub(crate) fn record_verified(&self, effort: u32) {
        self.verified.fetch_add(1, Ordering::Relaxed);
        self.max_effort_seen.fetch_max(effort, Ordering::Relaxed);
    }

    /// A solution was refused.
    #[cfg_attr(not(feature = "hs-pow-full"), allow(dead_code))]
    pub(crate) fn record_rejected(&self) {
        self.rejected.fetch_add(1, Ordering::Relaxed);
    }

    /// A request went onto the queue.
    #[cfg_attr(not(feature = "hs-pow-full"), allow(dead_code))]
    pub(crate) fn record_enqueued(&self) {
        self.enqueued.fetch_add(1, Ordering::Relaxed);
    }

    /// Requests were removed from the queue unserved.
    #[cfg_attr(not(feature = "hs-pow-full"), allow(dead_code))]
    pub(crate) fn record_dropped(&self, n: u64) {
        self.dropped.fetch_add(n, Ordering::Relaxed);
    }

    /// The queue now holds this many requests.
    #[cfg_attr(not(feature = "hs-pow-full"), allow(dead_code))]
    pub(crate) fn set_queue_len(&self, n: usize) {
        self.queue_len.store(n as u64, Ordering::Relaxed);
    }

    /// The suggested effort is now this.
    #[cfg_attr(not(feature = "hs-pow-full"), allow(dead_code))]
    pub(crate) fn set_suggested_effort(&self, effort: u32) {
        self.suggested_effort.store(effort, Ordering::Relaxed);
    }
}

/// Depth of the [`RendRequest`] queue.
// TODO #1779: allow clients to configure this?
const REND_QUEUE_DEPTH: usize = 32;

/// Make a MPSC channel for the rendevouz request queue.
///
/// This is the underlying object in both the stub and non-stub case, so we share the code.
fn make_rend_queue() -> (mpsc::Sender<RendRequest>, mpsc::Receiver<RendRequest>) {
    // If the HS implementation is stalled somehow, this is a local problem.
    // We shouldn't kill the HS even if this is the oldest data in the system.
    mpsc_channel_no_memquota(REND_QUEUE_DEPTH)
}
