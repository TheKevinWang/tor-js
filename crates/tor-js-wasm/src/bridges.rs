//! Bridge lines → what arti sees, and what the runtime dials.
//!
//! A bridge line is `[transport] addr id... [key=value...]`, as in torrc
//! (without the `Bridge` keyword). arti's own support for transports needs its
//! PT manager, which spawns PT binaries and cannot run in a browser, so a line
//! naming a transport is split in two:
//!
//! - arti gets a plain bridge `addr id...` and dials it like any relay;
//! - [`WasmRuntime`](crate::runtime::WasmRuntime) gets a route from `addr` to
//!   the transport, and opens the transport when arti dials that address.
//!
//! The address in such lines is a placeholder (Tor Browser's Snowflake lines
//! use 192.0.2.x, a documentation range) and must be unique per bridge.

use std::net::SocketAddr;

/// One parsed bridge line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct BridgeLine {
    /// The line to give arti: `addr id...`, without transport or settings.
    pub(crate) plain: String,
    /// The transport, if the line named one, with the address it answers on.
    pub(crate) transport: Option<Transport>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Transport {
    pub(crate) name: String,
    pub(crate) addr: SocketAddr,
    pub(crate) settings: Vec<(String, String)>,
}

pub(crate) fn parse(line: &str) -> Result<BridgeLine, String> {
    let mut words = line.split_whitespace().peekable();
    if words.peek().is_some_and(|w| w.eq_ignore_ascii_case("bridge")) {
        words.next();
    }
    let first = words.next().ok_or("empty bridge line")?;
    if first.parse::<SocketAddr>().is_ok() {
        // No transport: arti handles it as is.
        return Ok(BridgeLine { plain: std::iter::once(first).chain(words).collect::<Vec<_>>().join(" "), transport: None });
    }

    let name = first.to_owned();
    let addr_word = words.next().ok_or_else(|| format!("{name} bridge line has no address"))?;
    let addr: SocketAddr = addr_word
        .parse()
        .map_err(|_| format!("{name} bridge address {addr_word:?} must be ip:port (a placeholder is fine)"))?;
    let mut ids = Vec::new();
    let mut settings = Vec::new();
    for word in words {
        match word.split_once('=') {
            Some((k, v)) => settings.push((k.to_owned(), v.to_owned())),
            None => ids.push(word),
        }
    }
    if ids.is_empty() {
        return Err(format!("{name} bridge line has no fingerprint; tor-js needs one to verify the bridge"));
    }
    let plain = std::iter::once(addr_word).chain(ids).collect::<Vec<_>>().join(" ");
    Ok(BridgeLine { plain, transport: Some(Transport { name, addr, settings }) })
}

#[cfg(test)]
mod tests {
    use super::*;

    const SNOWFLAKE: &str = "snowflake 192.0.2.3:80 2B280B23E1107BB62ABFC40DDCC8824814F80A72 \
        fingerprint=2B280B23E1107BB62ABFC40DDCC8824814F80A72 ws=wss://snowflake.torproject.net/";

    #[test]
    fn transport_lines_split_into_plain_bridge_and_route() {
        let b = parse(SNOWFLAKE).unwrap();
        assert_eq!(b.plain, "192.0.2.3:80 2B280B23E1107BB62ABFC40DDCC8824814F80A72");
        let t = b.transport.unwrap();
        assert_eq!(t.name, "snowflake");
        assert_eq!(t.addr, "192.0.2.3:80".parse().unwrap());
        assert_eq!(
            t.settings,
            vec![
                ("fingerprint".to_owned(), "2B280B23E1107BB62ABFC40DDCC8824814F80A72".to_owned()),
                ("ws".to_owned(), "wss://snowflake.torproject.net/".to_owned()),
            ]
        );
    }

    #[test]
    fn plain_lines_pass_through() {
        let line = "198.51.100.9:443 0123456789ABCDEF0123456789ABCDEF01234567";
        assert_eq!(parse(line).unwrap(), BridgeLine { plain: line.to_owned(), transport: None });
        assert_eq!(parse(&format!("Bridge {line}")).unwrap().plain, line);
    }

    #[test]
    fn transport_lines_need_an_address_and_fingerprint() {
        assert!(parse("snowflake").is_err());
        assert!(parse("snowflake example.com:80 2B280B23E1107BB62ABFC40DDCC8824814F80A72").is_err());
        assert!(parse("snowflake 192.0.2.3:80 ws=wss://x/").is_err());
        assert!(parse("").is_err());
    }
}
