/**
 * Bridge lines for Tor's Snowflake service, used by `TorClient({ snowflake: true })`.
 *
 * Snowflake lets a client reach the Tor network with no gateway: the client's
 * bytes go to Tor Project's Snowflake server, which hands them to a Tor bridge.
 * tor-js implements the transport inside the WASM module (see
 * crates/tor-js-wasm/src/snowflake/), so nothing but the page is needed.
 *
 * Format: Tor `Bridge` lines without the `Bridge` keyword. The address
 * (192.0.2.x, a documentation range) is a placeholder, as in Tor Browser's
 * Snowflake lines — the real endpoint comes from the settings. The
 * fingerprint is what arti verifies during the Tor handshake.
 *
 * `ws=` is tor-js-specific: open a WebSocket straight to the Snowflake
 * server's proxy-facing endpoint rather than going through a volunteer WebRTC
 * proxy. One fixed endpoint, no broker round trip and no NAT traversal, so it
 * works in Node too. The server then sees the client's IP address, as any Tor
 * guard does.
 */
export const SNOWFLAKE_BRIDGES: readonly string[] = [
  'snowflake 192.0.2.3:80 2B280B23E1107BB62ABFC40DDCC8824814F80A72 '
    + 'fingerprint=2B280B23E1107BB62ABFC40DDCC8824814F80A72 ws=wss://snowflake.torproject.net/',
];
