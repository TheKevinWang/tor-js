#!/usr/bin/env node

// Fetch an onion service through Tor over Snowflake — no gateway, no direct
// relay connections: every byte goes over a WebSocket to Tor Project's
// Snowflake server, the same path a browser page uses.
//
// Build:   npm run build
// Usage:   examples/tor-fetch-onion-snowflake.js [--in-memory] [--bootstrap-url <url>] [url]
// Example: examples/tor-fetch-onion-snowflake.js --in-memory

import { TorClient, Log, storage } from '../dist/entryPoints/wasm-file/index.js';

const DEFAULT_URL = 'http://duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion/';

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { inMemory: false, url: DEFAULT_URL, bootstrapUrl: undefined, logLevel: 'info' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--in-memory') out.inMemory = true;
    else if (args[i] === '--bootstrap-url') out.bootstrapUrl = args[++i];
    else if (args[i] === '--log-level') out.logLevel = args[++i];
    else out.url = args[i];
  }
  return out;
}

async function main() {
  const { inMemory, url, bootstrapUrl, logLevel } = parseArgs(process.argv);
  const log = new Log();
  const start = performance.now();
  const secs = () => ((performance.now() - start) / 1000).toFixed(1);

  const client = new TorClient({
    snowflake: true,
    log,
    logLevel,
    bootstrapUrl,
    ...(inMemory ? { storage: new storage.MemoryStorage() } : {}),
  });

  await client.ready();
  log.info(`Ready after ${secs()}s; fetching ${url}`);

  // tor-js's fetch does not follow redirects (DuckDuckGo's onion sends
  // http:// to https://), so follow a few here.
  let response;
  let target = url;
  for (let hop = 0; ; hop++) {
    response = await client.fetch(target);
    const location = response.headers.get('location');
    if (!(response.status >= 300 && response.status < 400 && location) || hop === 5) break;
    await response.body?.cancel();
    target = new URL(location, target).href;
    console.log(`${response.status} -> ${target}`);
  }
  const body = await response.text();
  log.info(`Fetched ${target} after ${secs()}s`);

  client.close();
  console.log(`status ${response.status}`);
  console.log(`title: ${(body.match(/<title>([^<]*)<\/title>/i) ?? [])[1] ?? '(none)'}`);
  console.log(`body: ${body.length} bytes; contains "DuckDuckGo": ${body.includes('DuckDuckGo')}`);
  process.exit(response.status === 200 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
