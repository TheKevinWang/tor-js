//! Client support for the `v1` onion service proof of work scheme, for WebAssembly
//!
//! tor-js patch: this replaces `v1.rs` on `wasm32`. Upstream runs the puzzle solver
//! on an operating-system thread (`std::thread::spawn`), which a single-threaded
//! WASM build does not have. Here the puzzle is handed to JavaScript:
//!
//!     globalThis.__torJsPowSolve(blindId, seed, effort) -> Promise<{ nonce, effort, seedHead, proof }>
//!
//! where `blindId` and `seed` are 32-byte `Uint8Array`s and the result carries a 16-byte `nonce`,
//! the effort as a number, a 4-byte `seedHead` and a 16-byte `proof`. tor-js's pool of Web Workers
//! implements that function (`src/pow/powPool.ts`); each worker runs the same solver this module
//! would have run (`crates/tor-js-wasm/src/pow.rs`).
//!
//! If the function is not installed, or it fails, no solution is offered and the connection
//! proceeds without one, as in a build without the `hs-pow-full` feature (the caller treats an
//! error as "try without"). Settings, read from `globalThis.__torJsPowConfig` when a connection
//! starts:
//!
//!  - `maxEffort` (default 2000): the most effort this client will pay. Upstream's cap is 10000;
//!    in WASM an effort of E costs about E x 0.13 s of one core, so 10000 is minutes even
//!    across several workers.
//!  - `minEffort` (default 0): the least effort to pay whenever the service uses proof of work,
//!    even when it asks for none. A client that wants priority can pay for it, and it lets the
//!    solver be tested against a service that is not under attack.

use crate::err::ProofOfWorkError;
use js_sys::{Function, Promise, Reflect, Uint8Array};
use tor_cell::relaycell::hs::pow::v1::ProofOfWorkV1;
use tor_checkable::{TimeBound, timed::TimeRangeBound};
use tor_hscrypto::pk::HsBlindId;
use tor_hscrypto::pow::v1::{Effort, Instance, Nonce, SeedHead};
use tor_netdoc::doc::hsdesc::pow::v1::PowParamsV1;
use send_wrapper::SendWrapper;
use tracing::debug;
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;
use web_time_compat::{Instant, InstantExt};

/// Double effort at retry until this threshold.
///
/// This could be made configurable, but currently it's hardcoded in c-tor and documented in the
/// spec as a recommended value.
const CLIENT_POW_EFFORT_DOUBLE_UNTIL: Effort = Effort::new(1000);

/// Effort multiplier to use above the doubling threshold.
///
/// This could be made configurable, but currently it's hardcoded in c-tor and documented in the
/// spec as a recommended value.
const CLIENT_POW_RETRY_MULTIPLIER: f32 = 1.5;

/// Minimum effort for retries.
///
/// This could be made configurable, but currently it's hardcoded in c-tor and documented in the
/// spec as a recommended value.
const CLIENT_MIN_RETRY_POW_EFFORT: Effort = Effort::new(8);

/// Client maximum effort in the specification and in c-tor.
const SPEC_MAX_POW_EFFORT: u32 = 10000;

/// Default for the most effort this client pays: see the module documentation.
const DEFAULT_MAX_POW_EFFORT: u32 = 2000;

/// Name of the global function that solves a puzzle.
const SOLVER_GLOBAL: &str = "__torJsPowSolve";

/// Name of the global object holding the settings.
const CONFIG_GLOBAL: &str = "__torJsPowConfig";

/// Read a number setting from `globalThis.__torJsPowConfig`.
fn config_number(name: &str) -> Option<u32> {
    let config = Reflect::get(&js_sys::global(), &JsValue::from_str(CONFIG_GLOBAL)).ok()?;
    let value = Reflect::get(&config, &JsValue::from_str(name)).ok()?.as_f64()?;
    (value.is_finite() && value >= 0.0).then(|| value.min(f64::from(u32::MAX)) as u32)
}

/// The most effort to pay: the configured maximum, never above the specification's.
fn max_effort() -> Effort {
    Effort::new(config_number("maxEffort").unwrap_or(DEFAULT_MAX_POW_EFFORT).min(SPEC_MAX_POW_EFFORT))
}

/// Client-side state for the 'v1' scheme in particular
///
#[derive(Debug)]
pub(super) struct HsPowClientV1 {
    /// Time limited puzzle instance
    instance: TimeRangeBound<Instance>,
    /// Next effort to use
    effort: Effort,
}

impl HsPowClientV1 {
    /// Initialize client state for the `v1` scheme
    ///
    pub(super) fn new(hs_blind_id: &HsBlindId, params: &PowParamsV1) -> Self {
        let min = Effort::new(config_number("minEffort").unwrap_or(0));
        Self {
            // Create a puzzle Instance for this Seed. It doesn't matter whether
            // the seed is valid at this moment. The time bound is preserved, and
            // it's checked before we use the seed at each retry.
            instance: params
                .seed()
                .to_owned()
                .dangerously_map(|seed| Instance::new(hs_blind_id.to_owned(), seed)),
            // The service's suggestion, or the least we choose to pay, whichever is more,
            // and never more than our maximum.
            effort: params.suggested_effort().max(min).clamp(Effort::zero(), max_effort()),
        }
    }

    /// Increase effort in response to a failed connection attempt.
    ///
    /// If no proof of work scheme is in use or the effort cannot be increased, this has no effect.
    ///
    /// Specified in <https://spec.torproject.org/hspow-spec/common-protocol.html#client-timeout>
    ///
    pub(super) fn increase_effort(&mut self) {
        let effort = if self.effort < CLIENT_POW_EFFORT_DOUBLE_UNTIL {
            self.effort.saturating_mul_u32(2)
        } else {
            self.effort.saturating_mul_f32(CLIENT_POW_RETRY_MULTIPLIER)
        };
        self.effort = effort.clamp(CLIENT_MIN_RETRY_POW_EFFORT, max_effort().max(CLIENT_MIN_RETRY_POW_EFFORT));
    }

    /// Have JavaScript solve the puzzle, if the effort is nonzero and a solver is installed
    ///
    /// Returns None if the effort was zero or there is no solver.
    /// Returns an Err() if the solver failed, or if the seed is expired.
    pub(super) async fn solve(&self) -> Result<Option<ProofOfWorkV1>, ProofOfWorkError> {
        if self.effort == Effort::zero() {
            return Ok(None);
        }
        #[allow(clippy::disallowed_methods)] // TODO don't call if_valid_now, use mockable time
        let instance = self.instance.as_ref().if_valid_now()?.clone();

        let blind_id: [u8; 32] = *instance.service().as_ref();
        let seed: [u8; 32] = *instance.seed().as_ref();

        let start_time = Instant::get();
        debug!("beginning solve through JavaScript, {:?}", self.effort);

        // Everything that touches JavaScript values happens inside one future, wrapped so that
        // the future of this function stays `Send` as arti requires. A single-threaded WASM
        // build never moves it to another thread, which is what the wrapper checks.
        let outcome = SendWrapper::new(call_solver(blind_id, seed, *self.effort.as_ref())).await;

        let elapsed_time = start_time.elapsed();
        debug!(
            "solve complete, {:?} {:?} duration={}ms (ratio: {} ms)",
            outcome.as_ref().map(|r| r.as_ref().map(|_| ())),
            self.effort,
            elapsed_time.as_millis(),
            (elapsed_time.as_millis() as f32) / (*self.effort.as_ref() as f32),
        );
        match outcome {
            None => Ok(None),
            Some(Ok(proof)) => Ok(Some(proof)),
            Some(Err(())) => Err(ProofOfWorkError::SolverDisconnected),
        }
    }
}

/// Call `globalThis.__torJsPowSolve` and read its answer.
///
/// `None` if no solver is installed; `Some(Err(()))` if it failed or answered nonsense.
async fn call_solver(blind_id: [u8; 32], seed: [u8; 32], effort: u32) -> Option<Result<ProofOfWorkV1, ()>> {
    let solver = Reflect::get(&js_sys::global(), &JsValue::from_str(SOLVER_GLOBAL))
        .ok()
        .and_then(|f| f.dyn_into::<Function>().ok());
    let Some(solver) = solver else {
        debug!("proof of work asked for, but no solver is installed ({SOLVER_GLOBAL}); trying without");
        return None;
    };
    let call = solver.call3(
        &JsValue::NULL,
        &Uint8Array::from(&blind_id[..]),
        &Uint8Array::from(&seed[..]),
        &JsValue::from_f64(f64::from(effort)),
    );
    let result = match call {
        Ok(returned) => JsFuture::from(Promise::resolve(&returned)).await,
        Err(e) => Err(e),
    };
    Some(match result {
        Ok(value) => parse_solution(&value).ok_or(()),
        Err(e) => {
            debug!("the proof-of-work solver failed: {e:?}");
            Err(())
        }
    })
}

/// Read `{ nonce, effort, seedHead, proof }` as returned by the JavaScript solver.
fn parse_solution(value: &JsValue) -> Option<ProofOfWorkV1> {
    fn bytes<const N: usize>(object: &JsValue, key: &str) -> Option<[u8; N]> {
        let field = Reflect::get(object, &JsValue::from_str(key)).ok()?;
        let array = field.dyn_into::<Uint8Array>().ok()?;
        <[u8; N]>::try_from(array.to_vec()).ok()
    }
    let effort = Reflect::get(value, &JsValue::from_str("effort")).ok()?.as_f64()?;
    if !(effort.is_finite() && effort >= 0.0 && effort <= f64::from(u32::MAX)) {
        return None;
    }
    Some(ProofOfWorkV1::new(
        Nonce::from(bytes::<16>(value, "nonce")?),
        Effort::new(effort as u32),
        SeedHead::from(bytes::<4>(value, "seedHead")?),
        bytes::<16>(value, "proof")?,
    ))
}
