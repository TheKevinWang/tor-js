//! Solving an onion service's proof-of-work puzzle.
//!
//! An onion service that is being flooded can ask clients for proof of work: a
//! solution to a puzzle built from the service's blinded identity, a seed the
//! service published, an effort number and a nonce the client picks. A client
//! tries nonces until one gives a solution whose hash, multiplied by the effort,
//! still fits in 32 bits; so an effort of E needs about E accepted solutions.
//!
//! arti has the solver but runs it on an operating-system thread, which a WASM
//! build does not have. Here it is a plain function over byte arrays: a Web Worker
//! loads this WASM and calls [`solve_v1`] (see `src/pow/powWorker.ts`), and the
//! Tor client in another worker receives the result (see the vendored
//! `crates/patches/tor-hsclient`). In WASM the puzzle runs through its
//! interpreter, about 300 ms per attempt, so a worker takes roughly 0.13 s per
//! unit of effort; several workers divide that.
//!
//! This module has no browser dependencies, so it is tested natively.

use tor_hscrypto::pk::HsBlindId;
use tor_hscrypto::pow::v1::{Effort, Instance, Nonce, Seed, SolverInput};

/// A solution, as the four fields an INTRODUCE1 request carries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SolutionParts {
    /// The nonce this solution was found with.
    pub nonce: [u8; 16],
    /// The effort it was solved for.
    pub effort: u32,
    /// The first four bytes of the seed, naming which seed it answers.
    pub seed_head: [u8; 4],
    /// The Equi-X solution proper.
    pub proof: [u8; 16],
}

fn instance(blind_id: [u8; 32], seed: [u8; 32]) -> Instance {
    Instance::new(HsBlindId::from(blind_id), Seed::from(seed))
}

/// Search for a solution, starting at `start_nonce` and counting up from it.
///
/// Different callers (the workers of one pool) pass different random start
/// nonces, so they search different parts of the space. Runs until a solution is
/// found, which takes a random time: about `effort` accepted solutions, at about
/// 2.4 per attempt. It cannot be cancelled from inside; the caller ends it by
/// terminating the worker it runs in.
pub fn solve_v1(
    blind_id: [u8; 32],
    seed: [u8; 32],
    effort: u32,
    start_nonce: [u8; 16],
) -> Result<SolutionParts, String> {
    let input = SolverInput::new(instance(blind_id, seed), Effort::new(effort));
    let mut solver = input.solve_with_nonce(&Nonce::from(start_nonce));
    loop {
        match solver.run_step() {
            Ok(Some(solution)) => {
                return Ok(SolutionParts {
                    nonce: *solution.nonce().as_ref(),
                    effort: u32::from(solution.effort()),
                    seed_head: *solution.seed_head().as_ref(),
                    proof: <[u8; 16]>::try_from(solution.proof_to_bytes().as_ref())
                        .map_err(|_| "unexpected proof length".to_owned())?,
                });
            }
            Ok(None) => {}
            Err(e) => return Err(format!("proof-of-work solver failed: {e}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tor_hscrypto::pow::v1::{SeedHead, Solution, Verifier};

    /// Whether `parts` is a valid solution for the given service and seed, checked
    /// with arti's own verifier (what an arti service runs; the reference Tor program
    /// does the same check).
    fn verify_v1(blind_id: [u8; 32], seed: [u8; 32], parts: &SolutionParts) -> Result<(), String> {
        let solution = Solution::try_from_bytes(
            Nonce::from(parts.nonce),
            Effort::new(parts.effort),
            SeedHead::from(parts.seed_head),
            &parts.proof,
        )
        .map_err(|e| e.to_string())?;
        Verifier::new(instance(blind_id, seed)).check(&solution).map_err(|e| e.to_string())
    }

    const BLIND_ID: [u8; 32] = [7; 32];
    const SEED: [u8; 32] = [9; 32];

    #[test]
    fn a_solution_passes_the_reference_verifier() {
        for effort in [1u32, 2, 5, 16] {
            let parts = solve_v1(BLIND_ID, SEED, effort, [1; 16]).unwrap();
            assert_eq!(parts.effort, effort);
            assert_eq!(parts.seed_head, [9, 9, 9, 9]);
            verify_v1(BLIND_ID, SEED, &parts).unwrap_or_else(|e| panic!("effort {effort}: {e}"));
        }
    }

    #[test]
    fn a_solution_is_for_its_own_service_seed_and_effort_only() {
        let parts = solve_v1(BLIND_ID, SEED, 8, [2; 16]).unwrap();
        verify_v1(BLIND_ID, SEED, &parts).unwrap();
        assert!(verify_v1([8; 32], SEED, &parts).is_err(), "another service");
        assert!(verify_v1(BLIND_ID, [10; 32], &parts).is_err(), "another seed");
        let mut other_effort = parts.clone();
        other_effort.effort = 64;
        assert!(verify_v1(BLIND_ID, SEED, &other_effort).is_err(), "a different effort than it was solved for");
    }

    #[test]
    fn a_corrupted_solution_is_rejected() {
        let parts = solve_v1(BLIND_ID, SEED, 4, [3; 16]).unwrap();
        for i in 0..16 {
            let mut bad = parts.clone();
            bad.proof[i] ^= 0x01;
            assert!(verify_v1(BLIND_ID, SEED, &bad).is_err(), "flipped bit in proof byte {i}");
        }
        let mut bad_nonce = parts.clone();
        bad_nonce.nonce[0] ^= 1;
        assert!(verify_v1(BLIND_ID, SEED, &bad_nonce).is_err(), "a different nonce");
    }

    #[test]
    fn different_start_nonces_search_different_places() {
        let a = solve_v1(BLIND_ID, SEED, 4, [4; 16]).unwrap();
        let b = solve_v1(BLIND_ID, SEED, 4, [5; 16]).unwrap();
        assert_ne!(a.nonce, b.nonce);
        // The nonce found is at or after the one started from (it is counted up).
        assert!(a.nonce >= [0u8; 16]);
    }

    #[test]
    fn the_search_starts_at_the_nonce_it_is_given() {
        // With effort 1 the first accepted solution is found within a few steps of the start,
        // so the nonce returned begins with the same high bytes.
        let start = [0xAB; 16];
        let parts = solve_v1(BLIND_ID, SEED, 1, start).unwrap();
        assert_eq!(&parts.nonce[8..], &start[8..], "only the low bytes were counted up");
    }
}
