#!/usr/bin/env node
// Build a fast-bootstrap snapshot (bootstrap.zip.zst) from the Tor directory
// authorities, for a static site to host next to its page:
//
//   new TorClient({ snowflake: true, bootstrapUrl: './bootstrap.zip.zst' })
//
// A first visit then skips downloading the directory over the bridge. The
// archive has the layout tor-js-gateway serves (a Stored zip holding
// bootstrap/consensus-microdesc.txt, authority-certs.txt and microdescs.txt,
// zstd-compressed). tor-js verifies every document as if fetched from the
// network, so the host need not be trusted — but a snapshot older than the
// consensus lifetime (3 hours) is ignored, so regenerate it hourly (e.g. a
// scheduled CI job).
//
// Usage: node scripts/make-bootstrap.mjs <output-file>
// Requires Node 22.15+ (zlib zstd).

import { writeFileSync } from 'node:fs';
import { constants, zstdCompressSync } from 'node:zlib';

// Directory authorities' plain-HTTP DirPorts (as in C tor's auth_dirs.inc).
const AUTHORITIES = [
  '204.13.164.118:80', '199.58.81.140:80', '193.23.244.244:80', '131.188.40.189:80',
  '45.66.35.11:80', '217.196.147.77:80', '128.31.0.39:9231', '171.25.193.9:443',
];
const MICRODESCS_PER_REQUEST = 90; // keeps the request path well under 8 KB
const PARALLEL = 4;

async function get(path) {
  let lastError;
  for (const authority of shuffled(AUTHORITIES)) {
    try {
      const res = await fetch(`http://${authority}${path}`, { signal: AbortSignal.timeout(60_000) });
      if (res.ok) return await res.text();
      lastError = new Error(`${authority}${path.slice(0, 60)}: HTTP ${res.status}`);
    } catch (e) {
      lastError = new Error(`${authority}${path.slice(0, 60)}: ${e.message}`);
    }
  }
  throw lastError;
}

function shuffled(items) {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** A Stored (uncompressed) zip — the only method tor-js's reader accepts. */
function storedZip(files) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.from(text, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 8); // method: stored
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

async function main() {
  const out = process.argv[2];
  if (!out) {
    console.error('usage: node scripts/make-bootstrap.mjs <output-file>');
    process.exit(2);
  }
  const t0 = performance.now();

  const consensus = await get('/tor/status-vote/current/consensus-microdesc');
  const validAfter = consensus.match(/^valid-after (.+)$/m)?.[1];
  const digests = [...consensus.matchAll(/^m (\S+)$/gm)].map((m) => m[1]);
  console.log(`consensus: valid-after ${validAfter}, ${digests.length} microdescriptors`);

  const certs = await get('/tor/keys/all');
  console.log(`authority certificates: ${(certs.match(/^dir-key-certificate-version/gm) ?? []).length}`);

  const batches = [];
  for (let i = 0; i < digests.length; i += MICRODESCS_PER_REQUEST) {
    batches.push(digests.slice(i, i + MICRODESCS_PER_REQUEST));
  }
  const bodies = new Array(batches.length);
  let next = 0;
  await Promise.all(Array.from({ length: PARALLEL }, async () => {
    while (next < batches.length) {
      const i = next++;
      bodies[i] = await get(`/tor/micro/d/${batches[i].join('-')}`);
    }
  }));
  const microdescs = bodies.join('');
  const got = (microdescs.match(/^onion-key$/gm) ?? []).length;
  console.log(`microdescriptors: ${got}/${digests.length}`);

  const zip = storedZip([
    ['bootstrap/consensus-microdesc.txt', consensus],
    ['bootstrap/authority-certs.txt', certs],
    ['bootstrap/microdescs.txt', microdescs],
  ]);
  // Built offline, served often: spend the time on a high compression level.
  const compressed = zstdCompressSync(zip, { params: { [constants.ZSTD_c_compressionLevel]: 19 } });
  writeFileSync(out, compressed);
  console.log(`wrote ${out}: ${(compressed.length / 1e6).toFixed(2)} MB (zip ${(zip.length / 1e6).toFixed(2)} MB) in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
