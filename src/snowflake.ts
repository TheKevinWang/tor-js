/**
 * Bridge lines for Tor's Snowflake service, used by `TorClient({ snowflake })`.
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
 */

/**
 * Direct WebSocket carrier. `ws=` is tor-js-specific: open a WebSocket straight
 * to the Snowflake server's proxy-facing endpoint instead of going through a
 * volunteer WebRTC proxy. One fixed endpoint, no broker round trip and no NAT
 * traversal, so it is fast and works in Node too. The server then sees the
 * client's IP address, as any Tor guard does.
 */
export const SNOWFLAKE_BRIDGES: readonly string[] = [
  'snowflake 192.0.2.3:80 2B280B23E1107BB62ABFC40DDCC8824814F80A72 '
    + 'fingerprint=2B280B23E1107BB62ABFC40DDCC8824814F80A72 ws=wss://snowflake.torproject.net/',
];

/**
 * WebRTC carrier: the standard Snowflake path. The broker matches the client
 * with a volunteer proxy, reached over a WebRTC data channel; the proxy (not
 * the Snowflake server) sees the client's IP address. Harder to block, slower
 * to start, and only available where `RTCPeerConnection` exists (a window).
 * Settings as in Tor Browser's lines, but with the broker's own URL: pages
 * cannot domain-front.
 *
 * The placeholder address matches SNOWFLAKE_BRIDGES on purpose. arti's saved
 * guard state remembers a bridge by fingerprint *and* address, so a client
 * that switches carriers must keep the address, or arti dials the remembered
 * one, which no transport answers, and marks the bridge down. (Use one
 * carrier per client; tor-js rejects two bridge lines with the same address.)
 */
export const SNOWFLAKE_WEBRTC_BRIDGES: readonly string[] = [
  'snowflake 192.0.2.3:80 2B280B23E1107BB62ABFC40DDCC8824814F80A72 '
    + 'fingerprint=2B280B23E1107BB62ABFC40DDCC8824814F80A72 url=https://snowflake-broker.torproject.net/ '
    + 'ice=stun:stun.antisip.com:3478,stun:stun.epygi.com:3478,stun:stun.uls.co.za:3478,'
    + 'stun:stun.voipgate.com:3478,stun:stun.mixvoip.com:3478,stun:stun.nextcloud.com:3478,'
    + 'stun:stun.bethesda.net:3478,stun:stun.nextcloud.com:443',
];
