#!/usr/bin/env node
// Check, from the machine that runs an onion service, that the server behind it cannot be
// found or reached from outside Tor, and does not say who it is.
//
//   node scripts/audit-onion-origin.mjs [--origin http://127.0.0.1:8000] [--torrc path/to/torrc]
//        [--paths /,/login] [--clearnet-host example.com ...]
//
// It checks, in order:
//   1. the torrc, if given (loopback target, no relay, no single-hop mode, DoS defences, logging);
//   2. that the origin port accepts no connection on any of this machine's other addresses;
//   3. what the origin answers for each path: software and proxy headers, this machine's
//      addresses and names, other IP addresses, redirects out of the service.
//
// It cannot check what a firewall or router does with traffic from the Internet; test that from
// another network (see SERVER-HARDENING.md). Exit status 1 if anything failed, 0 otherwise
// (warnings do not fail it).

import { readFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import { analyzeResponse, analyzeTorrc, isLoopbackTarget, worst } from './onion-hardening.mjs'

const argv = process.argv.slice(2)
const opt = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback)
const opts = (name) => argv.flatMap((a, i) => (a === name ? [argv[i + 1]] : []))

const origin = new URL(opt('--origin', 'http://127.0.0.1:8000'))
const paths = opt('--paths', '/').split(',').filter(Boolean)
const torrcPath = opt('--torrc')
const clearnetHosts = opts('--clearnet-host')
const onion = opt('--onion', '')

const findings = []
const report = (title, list) => {
  console.log(`\n${title}`)
  for (const f of list) console.log(`  ${{ ok: 'ok  ', warn: 'warn', fail: 'FAIL' }[f.level]}  ${f.message}`)
  findings.push(...list)
}

/** This machine's addresses other than loopback. */
function ownAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && !i.internal)
    .map((i) => i.address.replace(/%.*$/, ''))
}

function canConnect(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: timeoutMs })
    const done = (v) => { socket.destroy(); resolve(v) }
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

function get(path) {
  return new Promise((resolve, reject) => {
    const req = http.get(new URL(path, origin), { headers: { host: onion || origin.host }, timeout: 15_000 }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const headers = Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : v]))
        resolve({ status: res.statusCode, headers, body: Buffer.concat(chunks).toString('utf8') })
      })
    })
    req.once('timeout', () => req.destroy(new Error('timed out')))
    req.once('error', reject)
  })
}

// 1. torrc
if (torrcPath) report(`torrc (${torrcPath})`, analyzeTorrc(readFileSync(torrcPath, 'utf8')))

// 2. who can reach the origin
const addresses = ownAddresses()
const port = Number(origin.port || 80)
const exposure = []
if (!isLoopbackTarget(origin.hostname)) {
  exposure.push({ level: 'fail', message: `the origin is addressed as ${origin.host}, not a loopback address` })
} else {
  for (const addr of addresses) {
    const reachable = await canConnect(addr, port)
    exposure.push(reachable
      ? { level: 'fail', message: `the origin port accepts connections on ${addr}:${port}: bind the server to 127.0.0.1 (and firewall the port)` }
      : { level: 'ok', message: `nothing answers on ${addr}:${port}` })
  }
  if (addresses.length === 0) exposure.push({ level: 'warn', message: 'this machine has no non-loopback address to test' })
}
report(`reachability of ${origin.host}`, exposure)

// 3. what the origin says
for (const path of paths) {
  try {
    const response = await get(path)
    report(`response for ${path} (HTTP ${response.status})`, analyzeResponse(response, { onion, ownAddresses: addresses, hostname: os.hostname(), clearnetHosts }))
  } catch (e) {
    report(`response for ${path}`, [{ level: 'warn', message: `could not fetch it: ${e.message}` }])
  }
}

const verdict = worst(findings)
const counts = (l) => findings.filter((f) => f.level === l).length
console.log(`\n${verdict === 'fail' ? 'FAILED' : verdict === 'warn' ? 'passed with warnings' : 'passed'}: ${counts('fail')} failed, ${counts('warn')} warnings, ${counts('ok')} ok`)
process.exit(verdict === 'fail' ? 1 : 0)
