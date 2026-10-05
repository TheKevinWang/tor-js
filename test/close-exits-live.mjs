// Live check (needs network): closing every TorClient lets a Node process exit by itself.
// See .agent/close-releases-everything-execplan.md.
//
//   node test/close-exits-live.mjs
//
// Before the fix, TorClient.close() only dropped the caller's handle: arti's background tasks kept
// sleeping on timers of up to three minutes, which kept the Node event loop alive, so a script that
// closed its client did not end (every live script therefore finishes with process.exit(0)).
//
// Each scenario runs in a child process that never calls process.exit. A scenario passes when the child
// ends with code 0 within its limit of seconds after printing CLOSED.
//
// The limit is generous (90 s) because closing does not abort work arti already has in flight. Typically
// the process ends within a second of close() (0.2 s measured for a client that finished bootstrapping,
// about 1 s for a service closed right after launch), but arti lets in-flight work run out before it lets go
// of the connection (descriptor uploads, circuit builds, directory downloads), and its own timeouts bound
// that at about 60 s: tails of 14 s and 60 s were measured in a minority of runs. A client closed while it
// is still bootstrapping can only be closed when bootstrap finishes. What this test asserts is the part
// that matters: the process ALWAYS ends by itself, in bounded time. Before the fix it did not end at all.

import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const dist = (p) => pathToFileURL(fileURLToPath(new URL(`../dist/${p}`, import.meta.url))).href
const dir = mkdtempSync(join(tmpdir(), 'torjs-close-'))

const head = (entry) => `
import { TorClient, storage } from ${JSON.stringify(dist(entry))}
const mk = () => new TorClient({ snowflake: true, storage: new storage.MemoryStorage(), logLevel: 'error' })
`

const scenarios = {
  'a client that became ready, then closed': { limit: 90, source: `${head('entryPoints/wasm-file/index.js')}
const c = mk()
await c.ready()
c.close()
console.log('CLOSED')` },

  'a client closed while it was still bootstrapping': { limit: 90, source: `${head('entryPoints/wasm-file/index.js')}
const c = mk()
c.ready().catch(() => {})
await new Promise((r) => setTimeout(r, 3000))
c.close()
console.log('CLOSED')` },

  'a hosted onion service, then closed': { limit: 90, source: `${head('entryPoints/host-file/index.js')}
const c = mk()
const service = await c.serve(() => new Response('hi'))
service.close()
await service.done
c.close()
console.log('CLOSED')` },
}

function run(name, { source, limit }) {
  const file = join(dir, `${Math.random().toString(36).slice(2)}.mjs`)
  writeFileSync(file, source)
  return new Promise((resolve) => {
    const t0 = Date.now()
    let closedAt = null
    let out = ''
    const child = spawn(process.execPath, [file], { stdio: ['ignore', 'pipe', 'pipe'] })
    const onData = (d) => {
      out += d
      if (closedAt === null && /CLOSED/.test(out)) closedAt = Date.now()
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    const ceiling = setTimeout(() => child.kill(), 200_000)
    child.on('exit', (code, signal) => {
      clearTimeout(ceiling)
      const tail = closedAt === null ? null : (Date.now() - closedAt) / 1000
      const ok = code === 0 && tail !== null && tail <= limit
      resolve({ name, ok, code, signal, tail, limit, total: (Date.now() - t0) / 1000, out })
    })
  })
}

let failed = false
for (const [name, source] of Object.entries(scenarios)) {
  const r = await run(name, source)
  const quiet = r.out.split('\n').filter((l) => l && !/memquota|CLOSED/.test(l)).slice(-5).join('\n')
  if (r.ok) {
    console.log(`ok   ${name}: the process exited ${r.tail.toFixed(1)} s after close (limit ${r.limit} s)`)
  } else {
    failed = true
    console.log(`FAIL ${name}: ${r.tail === null ? 'never closed' : `still running ${r.limit} s after close`} (exit code ${r.code}, signal ${r.signal})${quiet ? '\n' + quiet : ''}`)
  }
}
rmSync(dir, { recursive: true, force: true })
console.log(failed ? 'FAIL' : 'PASS')
process.exit(failed ? 1 : 0)
