//! When a hosted bootstrap snapshot should replace what the directory cache holds.
//!
//! A snapshot (`bootstrap.zip.zst`, see fast_bootstrap.rs) saves downloading the
//! directory over the bridge, which takes seconds on a good proxy and does not
//! always finish on a poor one. It used to be used only by a client whose cache
//! was empty; a returning visitor, whose cache holds an old consensus, always
//! went to the network instead, however fresh the snapshot the site hosts. These
//! functions decide, from the lifetimes alone, whether to look at the snapshot and
//! whether to take it. They know nothing about storage or arti, so they are testable.

/// The part of a stored or hosted consensus the decision needs, in seconds since
/// the Unix epoch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Lifetime {
    pub valid_after: u64,
    pub fresh_until: u64,
}

/// Read a stored consensus record (as written by fast_bootstrap.rs and by arti's
/// custom storage). Records that are pending (still being downloaded) or that
/// cannot be read count for nothing.
pub fn lifetime_of_stored(json: &str) -> Option<Lifetime> {
    let v: serde_json::Value = serde_json::from_str(json).ok()?;
    if v.get("pending").and_then(serde_json::Value::as_bool).unwrap_or(false) {
        return None;
    }
    Some(Lifetime {
        valid_after: v.get("valid_after_secs")?.as_u64()?,
        fresh_until: v.get("fresh_until_secs")?.as_u64()?,
    })
}

/// The stored consensus arti would load: the one that became valid last.
pub fn newest(stored: impl IntoIterator<Item = Lifetime>) -> Option<Lifetime> {
    stored.into_iter().max_by_key(|l| l.valid_after)
}

/// Whether to fetch the snapshot at all: not while the stored consensus is still
/// fresh (arti has nothing to improve on yet, and the archive is several MB),
/// otherwise yes, including when nothing is stored.
pub fn should_fetch(stored: Option<&Lifetime>, now: u64) -> bool {
    stored.is_none_or(|s| s.fresh_until <= now)
}

/// Whether to store the snapshot once its consensus has been read: always into an
/// empty cache, otherwise only if it is newer than what is there. An older or
/// equal snapshot would add nothing, and arti would keep using the stored one.
pub fn should_use(stored: Option<&Lifetime>, snapshot_valid_after: u64) -> bool {
    stored.is_none_or(|s| snapshot_valid_after > s.valid_after)
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOUR: u64 = 3600;
    const NOW: u64 = 1_790_000_000;

    fn l(valid_after: u64) -> Lifetime {
        Lifetime { valid_after, fresh_until: valid_after + HOUR }
    }

    #[test]
    fn an_empty_cache_always_takes_the_snapshot() {
        assert!(should_fetch(None, NOW));
        assert!(should_use(None, 0), "even a snapshot of any age: arti decides whether it can be used");
    }

    #[test]
    fn a_fresh_stored_consensus_is_left_alone() {
        let stored = l(NOW - HOUR / 2); // fresh for another half hour
        assert!(!should_fetch(Some(&stored), NOW));
    }

    #[test]
    fn the_snapshot_is_looked_at_as_soon_as_the_stored_consensus_stops_being_fresh() {
        assert!(should_fetch(Some(&l(NOW - HOUR)), NOW), "fresh_until is exactly now");
        assert!(should_fetch(Some(&l(NOW - 12 * HOUR)), NOW), "the half-day-old cache that failed to refresh");
        assert!(should_fetch(Some(&l(NOW - 48 * HOUR)), NOW));
    }

    #[test]
    fn only_a_newer_snapshot_replaces_the_stored_consensus() {
        let stored = l(NOW - 12 * HOUR);
        assert!(should_use(Some(&stored), NOW - HOUR), "an hourly snapshot beats a half-day-old cache");
        assert!(!should_use(Some(&stored), stored.valid_after), "the same consensus adds nothing");
        assert!(!should_use(Some(&stored), stored.valid_after - HOUR), "an older snapshot never replaces it");
    }

    #[test]
    fn the_newest_stored_consensus_is_the_one_that_counts() {
        let old = l(NOW - 30 * HOUR);
        let recent = l(NOW - 2 * HOUR);
        assert_eq!(newest([old, recent, old]), Some(recent));
        assert_eq!(newest([]), None);
        // So a leftover old record beside a fresh one does not trigger a fetch.
        let fresh = Lifetime { valid_after: NOW - 600, fresh_until: NOW + HOUR - 600 };
        assert!(!should_fetch(newest([old, fresh]).as_ref(), NOW));
    }

    #[test]
    fn stored_records_are_read_and_unusable_ones_ignored() {
        let rec = |extra: &str| format!(r#"{{"valid_after_secs":100,"fresh_until_secs":200,"valid_until_secs":300{extra}}}"#);
        assert_eq!(lifetime_of_stored(&rec(r#","pending":false"#)), Some(Lifetime { valid_after: 100, fresh_until: 200 }));
        assert_eq!(lifetime_of_stored(&rec("")), Some(Lifetime { valid_after: 100, fresh_until: 200 }), "pending defaults to false");
        assert_eq!(lifetime_of_stored(&rec(r#","pending":true"#)), None, "a download in progress is not a consensus to keep");
        assert_eq!(lifetime_of_stored("not json"), None);
        assert_eq!(lifetime_of_stored(r#"{"valid_after_secs":100}"#), None);
        assert_eq!(lifetime_of_stored(r#"{"valid_after_secs":"soon","fresh_until_secs":200}"#), None);
    }
}
