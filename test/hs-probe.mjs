// Probe: how reliably does a hosted onion service answer over time?
//
//   node test/hs-probe.mjs <address[.onion]> [seconds=720] [intervalSeconds=30]
//
// One visiting client (over Snowflake) fetches http://<address>/probe every `interval` seconds for
// `seconds`, printing one line per attempt and a summary. The service should answer /probe with its own
// clock (Date.now() as text), so the probe can also tell whether the host's event loop was running
// ("host clock lag": how far the host's clock reading is from the visitor's when the answer arrives; a
// host whose timers are throttled answers late, a host that is frozen does not answer).
//
// Use it against website/host.html (host in one browser tab, this script in Node): once with the host tab in
// the foreground (the control) and once with it hidden.

import { TorClient, storage } from '../dist/entryPoints/host-file/index.js'

const arg = process.argv[2]
if (!arg) { console.error('usage: node test/hs-probe.mjs <address[.onion]> [seconds] [intervalSeconds]'); process.exit(2) }
const address = arg.replace(/^https?:\/\//, '').replace(/\/.*$/, '')
const host = address.endsWith('.onion') ? address : `${address}.onion`
const total = Number(process.argv[3] ?? 720)
const every = Number(process.argv[4] ?? 30)

const t0 = Date.now()
const stamp = () => `${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s`
const client = new TorClient({ snowflake: true, storage: new storage.MemoryStorage(), logLevel: 'error' })
await client.ready()
console.log(`${stamp()} probing http://${host}/probe every ${every}s for ${total}s`)

const rows = []
let nextAt = Date.now()
while (Date.now() - t0 < total * 1000) {
  const started = Date.now()
  let row
  try {
    const res = await client.fetch(`http://${host}/probe`, { signal: AbortSignal.timeout(60_000) })
    const text = await res.text()
    const done = Date.now()
    const hostClock = Number(text.trim())
    row = { ok: res.status === 200, status: res.status, ms: done - started, lag: Number.isFinite(hostClock) ? done - hostClock : null }
  } catch (e) {
    row = { ok: false, status: 'error', ms: Date.now() - started, error: String(e?.message ?? e).slice(0, 80) }
  }
  rows.push({ at: Date.now() - t0, ...row })
  console.log(`${stamp()} ${row.ok ? 'ok  ' : 'FAIL'} ${String(row.status).padEnd(5)} ${String(row.ms).padStart(6)} ms${row.lag !== null && row.lag !== undefined ? `  host-clock lag ${row.lag} ms` : ''}${row.error ? `  (${row.error})` : ''}`)
  nextAt += every * 1000
  const wait = nextAt - Date.now()
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
}

const good = rows.filter((r) => r.ok)
const times = good.map((r) => r.ms).sort((a, b) => a - b)
const median = times.length ? times[Math.floor(times.length / 2)] : null
let run = 0, longest = 0
for (const r of rows) { run = r.ok ? 0 : run + 1; longest = Math.max(longest, run) }
console.log(`\nSUMMARY: ${rows.length} attempts, ${good.length} ok, ${rows.length - good.length} failed; median ${median} ms, max ${times.at(-1) ?? null} ms; longest run of failures: ${longest}`)
client.close()
