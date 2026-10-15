//! A small pool of idle connections, keyed by host and port.
//!
//! Opening a Tor stream costs a round trip to the far end (for an onion service,
//! across six relays) before the request can even be sent. A page of a site is
//! several requests to the same host, so a connection that has just finished a
//! response is kept for the next one instead of being closed.
//!
//! The pool only stores and hands back items; it knows nothing about HTTP.
//! Time is passed in (as milliseconds from any fixed origin) so tests need no
//! clock. A returned item has never been checked: the caller must confirm it is
//! still open before use, because the server may have closed it while it sat here.

use std::collections::HashMap;

/// An idle connection with the time after which it is not offered any more.
struct Idle<T> {
    item: T,
    expires_at_ms: f64,
}

pub struct IdlePool<T> {
    idle: HashMap<(String, u16), Vec<Idle<T>>>,
    max_per_host: usize,
    max_total: usize,
}

impl<T> IdlePool<T> {
    pub fn new(max_per_host: usize, max_total: usize) -> Self {
        Self { idle: HashMap::new(), max_per_host, max_total }
    }

    /// Take the connection most recently put back for this host, if one is still
    /// within its lifetime. Most recent first: it is the one least likely to have
    /// been closed by the server's idle timeout.
    pub fn take(&mut self, host: &str, port: u16, now_ms: f64) -> Option<T> {
        self.evict_expired(now_ms);
        let key = (host.to_owned(), port);
        let list = self.idle.get_mut(&key)?;
        let taken = list.pop().map(|i| i.item);
        if list.is_empty() {
            self.idle.remove(&key);
        }
        taken
    }

    /// Put a connection back, to be offered until `expires_at_ms`. Over the limits
    /// the oldest connections are dropped (which closes them).
    pub fn put(&mut self, host: &str, port: u16, item: T, now_ms: f64, expires_at_ms: f64) {
        self.evict_expired(now_ms);
        let list = self.idle.entry((host.to_owned(), port)).or_default();
        list.push(Idle { item, expires_at_ms });
        while list.len() > self.max_per_host {
            list.remove(0);
        }
        while self.len() > self.max_total {
            self.drop_oldest();
        }
    }

    /// Drop the idle connections to one host and port, which closes them.
    pub fn remove(&mut self, host: &str, port: u16) {
        self.idle.remove(&(host.to_owned(), port));
    }

    /// Drop every idle connection, which closes them.
    pub fn clear(&mut self) {
        self.idle.clear();
    }

    /// Number of idle connections held.
    pub fn len(&self) -> usize {
        self.idle.values().map(Vec::len).sum()
    }

    fn evict_expired(&mut self, now_ms: f64) {
        self.idle.retain(|_, list| {
            list.retain(|i| i.expires_at_ms > now_ms);
            !list.is_empty()
        });
    }

    /// Drop the connection that expires first, across all hosts.
    fn drop_oldest(&mut self) {
        let oldest = self
            .idle
            .iter()
            .filter_map(|(k, list)| list.first().map(|i| (k.clone(), i.expires_at_ms)))
            .min_by(|a, b| a.1.total_cmp(&b.1))
            .map(|(k, _)| k);
        if let Some(key) = oldest {
            if let Some(list) = self.idle.get_mut(&key) {
                list.remove(0);
                if list.is_empty() {
                    self.idle.remove(&key);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_put_back_connection_is_handed_out_once_for_its_own_host_only() {
        let mut pool = IdlePool::new(4, 16);
        pool.put("a.onion", 80, 1, 0.0, 1000.0);
        assert_eq!(pool.take("b.onion", 80, 1.0), None, "another host");
        assert_eq!(pool.take("a.onion", 443, 1.0), None, "another port");
        assert_eq!(pool.take("a.onion", 80, 1.0), Some(1));
        assert_eq!(pool.take("a.onion", 80, 1.0), None, "gone once taken");
        assert_eq!(pool.len(), 0);
    }

    #[test]
    fn the_most_recently_returned_connection_comes_first() {
        let mut pool = IdlePool::new(4, 16);
        pool.put("h", 80, 1, 0.0, 1000.0);
        pool.put("h", 80, 2, 1.0, 1000.0);
        pool.put("h", 80, 3, 2.0, 1000.0);
        assert_eq!(pool.take("h", 80, 3.0), Some(3));
        assert_eq!(pool.take("h", 80, 3.0), Some(2));
        assert_eq!(pool.take("h", 80, 3.0), Some(1));
    }

    #[test]
    fn an_expired_connection_is_not_offered_and_is_dropped() {
        let mut pool = IdlePool::new(4, 16);
        pool.put("h", 80, 1, 0.0, 100.0);
        assert_eq!(pool.take("h", 80, 100.0), None, "expiry is exclusive: at the deadline it is already stale");
        assert_eq!(pool.len(), 0);
    }

    #[test]
    fn each_connection_has_its_own_lifetime() {
        // A server's Keep-Alive timeout can differ per response.
        let mut pool = IdlePool::new(4, 16);
        pool.put("h", 80, 1, 0.0, 5000.0);
        pool.put("h", 80, 2, 0.0, 50.0);
        assert_eq!(pool.take("h", 80, 100.0), Some(1), "the short-lived one has expired");
        assert_eq!(pool.take("h", 80, 100.0), None);
    }

    #[test]
    fn a_host_keeps_at_most_its_limit_dropping_the_oldest() {
        let mut pool = IdlePool::new(2, 16);
        for n in 1..=4 {
            pool.put("h", 80, n, 0.0, 1000.0);
        }
        assert_eq!(pool.len(), 2);
        assert_eq!(pool.take("h", 80, 1.0), Some(4));
        assert_eq!(pool.take("h", 80, 1.0), Some(3));
    }

    #[test]
    fn clearing_drops_everything_and_the_pool_stays_usable() {
        let mut pool = IdlePool::new(4, 16);
        pool.put("a", 80, 1, 0.0, 1000.0);
        pool.put("b", 80, 2, 0.0, 1000.0);
        pool.clear();
        assert_eq!(pool.len(), 0);
        assert_eq!(pool.take("a", 80, 1.0), None);
        pool.put("a", 80, 3, 2.0, 1000.0);
        assert_eq!(pool.take("a", 80, 3.0), Some(3));
    }

    #[test]
    fn the_total_is_limited_across_hosts_dropping_whatever_expires_first() {
        let mut pool = IdlePool::new(4, 3);
        pool.put("a", 80, 1, 0.0, 100.0);
        pool.put("b", 80, 2, 0.0, 200.0);
        pool.put("c", 80, 3, 0.0, 300.0);
        pool.put("d", 80, 4, 0.0, 400.0);
        assert_eq!(pool.len(), 3);
        assert_eq!(pool.take("a", 80, 1.0), None, "the one nearest its end was dropped");
        assert_eq!(pool.take("d", 80, 1.0), Some(4));
    }

    #[test]
    fn removing_a_host_drops_only_its_connections() {
        let mut pool = IdlePool::new(4, 16);
        pool.put("a", 80, 1, 0.0, 1000.0);
        pool.put("a", 80, 2, 0.0, 1000.0);
        pool.put("a", 443, 3, 0.0, 1000.0);
        pool.put("b", 80, 4, 0.0, 1000.0);
        pool.remove("a", 80);
        assert_eq!(pool.len(), 2);
        assert_eq!(pool.take("a", 80, 1.0), None);
        assert_eq!(pool.take("a", 443, 1.0), Some(3));
        assert_eq!(pool.take("b", 80, 1.0), Some(4));
        pool.remove("nobody", 1); // not an error
    }
}
