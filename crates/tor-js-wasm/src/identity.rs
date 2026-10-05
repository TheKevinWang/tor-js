//! The identity of a hosted onion service, from a 32-byte seed the caller keeps.
//!
//! An onion service's address is derived from its long-term ed25519 key. tor-js has the page
//! hold that key as a 32-byte seed (the standard ed25519 secret key), so it can live wherever the
//! page keeps secrets (IndexedDB, a file) and nothing here writes it down. The seed is expanded
//! to arti's `HsIdKeypair` with the standard ed25519 expansion (SHA-512 and clamping), so the
//! address is the one any ed25519 implementation derives from that seed.
//!
//! No WebAssembly dependencies: this file is unit-tested natively (the full crate's tests do not
//! link on every machine; see `.agent/onion-service-host-execplan.md`).

use safelog::DisplayRedacted as _;
use tor_hscrypto::pk::{HsIdKey, HsIdKeypair};
use tor_llcrypto::pk::ed25519;

/// Length of an identity seed, in bytes.
pub const SEED_LEN: usize = 32;

/// Expand `seed` (which must be exactly [`SEED_LEN`] bytes) to the service's key pair.
pub fn keypair_from_seed(seed: &[u8]) -> Result<HsIdKeypair, String> {
    let seed: &[u8; SEED_LEN] = seed
        .try_into()
        .map_err(|_| format!("identity must be {SEED_LEN} bytes, got {}", seed.len()))?;
    let keypair = ed25519::Keypair::from_bytes(seed);
    Ok(HsIdKeypair::from(ed25519::ExpandedKeypair::from(&keypair)))
}

/// The `.onion` address (56 base32 characters and the suffix) of `keypair`.
pub fn onion_name(keypair: &HsIdKeypair) -> String {
    HsIdKey::from(keypair).id().display_unredacted().to_string()
}

/// The `.onion` address that the identity `seed` hosts at.
pub fn onion_address_for_seed(seed: &[u8]) -> Result<String, String> {
    Ok(onion_name(&keypair_from_seed(seed)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Expected values were computed with Node's crypto (ed25519 public key, SHA3-256 checksum,
    // base32), following the onion address format, not with arti, so these check arti's
    // derivation against an independent one.
    const ZEROS: &str = "hnvcppgow2sc2yvdvdicu3ynonsteflxdxrehjr2ybekdc2z3iu63yid.onion";
    const ZERO_TO_31: &str = "aoqqpp7tzyil4hlq3umoos6atft6jvrqtosq2xy53sdgiesvgg4bqead.onion";

    #[test]
    fn all_zero_seed_has_the_known_address() {
        assert_eq!(onion_address_for_seed(&[0; 32]).unwrap(), ZEROS);
    }

    #[test]
    fn counting_seed_has_the_known_address() {
        let seed: Vec<u8> = (0..32).collect();
        assert_eq!(onion_address_for_seed(&seed).unwrap(), ZERO_TO_31);
    }

    #[test]
    fn same_seed_same_address_and_different_seeds_differ() {
        let a = onion_address_for_seed(&[1; 32]).unwrap();
        assert_eq!(a, onion_address_for_seed(&[1; 32]).unwrap());
        assert_ne!(a, onion_address_for_seed(&[2; 32]).unwrap());
    }

    #[test]
    fn address_is_56_base32_characters_and_the_suffix() {
        let a = onion_address_for_seed(&[9; 32]).unwrap();
        let name = a.strip_suffix(".onion").expect("suffix");
        assert_eq!(name.len(), 56);
        assert!(name.chars().all(|c| matches!(c, 'a'..='z' | '2'..='7')));
    }

    #[test]
    fn wrong_length_seeds_are_rejected_with_a_message() {
        for len in [0, 31, 33, 64] {
            let err = onion_address_for_seed(&vec![0; len]).unwrap_err();
            assert!(err.contains("32 bytes"), "{err}");
        }
    }
}
