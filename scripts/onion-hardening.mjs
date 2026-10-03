// Protecting the machine behind an onion service from being found, and the service
// from being flooded, without making ordinary visits slower.
//
// This module holds the pieces that need no network, so they can be tested:
//
//   torrcLines(options)       a hardened torrc for a service that forwards to a local server
//   analyzeTorrc(text)        findings about an existing torrc
//   analyzeResponse(r, opts)  findings about what the origin server says about itself
//
// scripts/audit-onion-origin.mjs runs them against a live origin; the FlaskBB demo
// (examples/flaskbb-demo/run.mjs) uses torrcLines. What each setting does, and why proof
// of work is off by default, is in SERVER-HARDENING.md.

import { isIP } from 'node:net'

/** One result of a check: `fail` is a way the server can be found or knocked over, `warn` a weakness or a trade-off, `ok` a check that passed. */
const finding = (level, message) => ({ level, message })

const LOOPBACK = /^(127\.\d+\.\d+\.\d+|localhost|\[?::1\]?)$/i

// ----------------------------------------------------------------------------
// A hardened torrc
// ----------------------------------------------------------------------------

/**
 * The torrc of a Tor that does nothing but publish one onion service in front of a
 * server on this machine.
 *
 * Every line here costs a normal visitor nothing:
 *  - nothing listens for SOCKS or control connections, and the Tor process cannot act as a
 *    relay, run programs, or be debugged;
 *  - the service is forwarded to a loopback address (a firewall that drops all unsolicited
 *    inbound traffic is still needed for the server itself; see SERVER-HARDENING.md);
 *  - introduction-point rate limiting makes the introduction points drop excess INTRODUCE
 *    requests during a flood, and only then (25 a second per point, bursts of 200, Tor's
 *    own defaults); more introduction points mean a flood has to cover more of them;
 *  - proof of work is ON by default: when the service is overloaded it serves the clients that
 *    solved a puzzle first. The browser client here solves them in Web Workers (src/pow/), at about
 *    0.13 s of one worker per unit of effort, so a flood that pushes the effort up costs visitors
 *    seconds to minutes instead of shutting them out. With the service idle no puzzle is asked for,
 *    and nothing is solved. The queue limits say when it is overloaded: it handles at most
 *    `powQueueRate` introduction requests a second, bursts up to `powQueueBurst`, and raises the
 *    effort it asks for when requests arrive faster than that. Each request is a new visitor
 *    connecting, so the defaults here (25 a second, burst 100: some two million new visitors a day)
 *    are far above any real traffic and far below what a small origin can serve in requests; Tor's
 *    own defaults (250 and 2500) assume a big server. Lower numbers engage the defence sooner and
 *    cost visitors effort sooner.
 */
export function torrcLines({
  dataDir,
  hsDir,
  target = '127.0.0.1:8000',
  virtualPort = 80,
  introPoints = 5,
  pow = true,
  powQueueRate = 25,
  powQueueBurst = 100,
}) {
  if (!dataDir || !hsDir) throw new Error('torrcLines: dataDir and hsDir are required')
  if (!isLoopbackTarget(target)) {
    throw new Error(`torrcLines: the target ${target} is not a loopback address or a unix socket; the origin must not be reachable from outside`)
  }
  if (!Number.isInteger(introPoints) || introPoints < 3 || introPoints > 20) {
    throw new Error('torrcLines: introPoints must be between 3 and 20')
  }
  for (const [name, value] of [['powQueueRate', powQueueRate], ['powQueueBurst', powQueueBurst]]) {
    if (!Number.isInteger(value) || value < 1) throw new Error(`torrcLines: ${name} must be a whole number of at least 1`)
  }
  if (powQueueBurst < powQueueRate) throw new Error('torrcLines: powQueueBurst must be at least powQueueRate')
  const dir = (p) => p.replaceAll('\\', '/')
  return [
    `DataDirectory ${dir(dataDir)}`,
    // Nothing to browse through and nothing to control: no listening ports besides the service.
    'SocksPort 0',
    // Never relay for others, never run programs, never let a debugger attach.
    'ClientOnly 1',
    'NoExec 1',
    'DisableDebuggerAttachment 1',
    // Log to the console, with addresses scrubbed (Tor's default, stated so it stays).
    'Log notice stdout',
    'SafeLogging 1',
    `HiddenServiceDir ${dir(hsDir)}`,
    'HiddenServiceVersion 3',
    `HiddenServicePort ${virtualPort} ${target}`,
    `HiddenServiceNumIntroductionPoints ${introPoints}`,
    'HiddenServiceEnableIntroDoSDefense 1',
    'HiddenServiceEnableIntroDoSRatePerSec 25',
    'HiddenServiceEnableIntroDoSBurstPerSec 200',
    `HiddenServicePoWDefensesEnabled ${pow ? 1 : 0}`,
    ...(pow ? [`HiddenServicePoWQueueRate ${powQueueRate}`, `HiddenServicePoWQueueBurst ${powQueueBurst}`] : []),
  ]
}

/** True for 127.x.x.x, localhost, ::1 and unix sockets, with or without a port. */
export function isLoopbackTarget(target) {
  if (/^unix:/i.test(target)) return true
  let host = target
  if (target.startsWith('[')) host = target.slice(0, target.indexOf(']') + 1)
  else if ((target.match(/:/g) ?? []).length === 1) host = target.replace(/:\d+$/, '') // host:port; a bare IPv6 address has several colons
  return LOOPBACK.test(host)
}

// ----------------------------------------------------------------------------
// Auditing a torrc
// ----------------------------------------------------------------------------

/** Settings of a torrc, last one wins, keys lower-cased; `HiddenServicePort` may repeat so all are kept. */
function parseTorrc(text) {
  const values = new Map()
  const ports = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim()
    if (!line) continue
    const [key, ...rest] = line.split(/\s+/)
    const value = rest.join(' ')
    const k = key.toLowerCase()
    if (k === 'hiddenserviceport') ports.push(value)
    else if (k === 'log') (values.get(k) ?? values.set(k, []).get(k)).push(value)
    else values.set(k, value)
  }
  return { values, ports }
}

export function analyzeTorrc(text) {
  const { values, ports } = parseTorrc(text)
  const out = []
  const on = (k) => /^(1|true|yes)$/i.test(values.get(k) ?? '')
  const has = (k) => values.has(k)

  if (on('hiddenservicenonanonymousmode') || on('hiddenservicesinglehopmode')) {
    out.push(finding('fail', 'single-hop / non-anonymous service mode is on: the service no longer hides its location'))
  } else out.push(finding('ok', 'the service keeps its location hidden (no single-hop mode)'))

  if (ports.length === 0) out.push(finding('warn', 'no HiddenServicePort found'))
  for (const p of ports) {
    const target = p.split(/\s+/)[1]
    if (!target) continue // "80" alone forwards to 127.0.0.1:80
    if (isLoopbackTarget(target)) out.push(finding('ok', `HiddenServicePort ${p} forwards to loopback`))
    else out.push(finding('fail', `HiddenServicePort ${p} forwards to ${target}, which is not loopback: the origin is exposed to that network`))
  }

  if (has('orport') && values.get('orport') !== '0') out.push(finding('fail', 'ORPort is set: this Tor is a relay, whose address is public and can be tied to the service'))
  if (on('exitrelay') || has('bridgedistribution') || on('bridgerelay')) out.push(finding('fail', 'this Tor is configured as an exit or bridge relay'))

  if (on('safelogging') === false && has('safelogging')) out.push(finding('fail', 'SafeLogging is off: logs contain addresses'))
  const logs = values.get('log') ?? []
  if (logs.some((l) => /\bfile\b/i.test(l))) out.push(finding('warn', 'Tor logs to a file on disk; prefer stdout or syslog and keep logs short-lived'))
  if (logs.some((l) => /\b(debug|info)\b/i.test(l))) out.push(finding('warn', 'Tor logs at info or debug level, which records circuit and connection detail'))

  const socks = values.get('socksport')
  if (socks !== '0') out.push(finding('warn', `SocksPort is ${socks ?? 'at its default (9050)'}: a listening proxy that a service has no use for; set SocksPort 0`))
  else out.push(finding('ok', 'no SOCKS listener'))
  if (has('controlport') && !has('cookieauthentication') && !has('hashedcontrolpassword')) {
    out.push(finding('fail', 'ControlPort is open without authentication'))
  }

  if (on('hiddenserviceenableintrodosdefense')) out.push(finding('ok', 'introduction-point rate limiting is on'))
  else out.push(finding('warn', 'introduction-point rate limiting is off (HiddenServiceEnableIntroDoSDefense 1 costs a normal visitor nothing)'))

  if (on('hiddenservicepowdefensesenabled')) {
    const rate = values.get('hiddenservicepowqueuerate')
    const burst = values.get('hiddenservicepowqueueburst')
    if (rate === undefined || burst === undefined) {
      out.push(finding('warn', "proof of work is on without HiddenServicePoWQueueRate and HiddenServicePoWQueueBurst: Tor's defaults (250 and 2500 a second) assume a large server; set them to what your origin can serve"))
    } else if (!/^\d+$/.test(rate) || !/^\d+$/.test(burst) || Number(rate) < 1) {
      out.push(finding('fail', `proof-of-work queue limits are not whole numbers (rate ${rate}, burst ${burst})`))
    } else if (Number(burst) < Number(rate)) {
      out.push(finding('fail', `HiddenServicePoWQueueBurst (${burst}) is below HiddenServicePoWQueueRate (${rate})`))
    } else {
      out.push(finding('ok', `proof of work is on, handling at most ${rate} introductions a second (bursts of ${burst}) before it asks for effort`))
    }
  } else {
    out.push(finding('warn', "proof of work is off: a flood is limited only by the introduction points' rate limit, which does not favour anyone"))
  }

  const intro = Number(values.get('hiddenservicenumintroductionpoints') ?? 3)
  if (intro < 3 || intro > 20) out.push(finding('fail', 'HiddenServiceNumIntroductionPoints must be 3 to 20'))
  if (on('clientonly')) out.push(finding('ok', 'ClientOnly: never relays'))

  return out
}

// ----------------------------------------------------------------------------
// Auditing what the origin says about itself
// ----------------------------------------------------------------------------

const PRIVATE_V4 = /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/
const V4_IN_TEXT = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g

/** Response headers that name the software or reveal the proxy chain. */
const REVEALING_HEADERS = ['x-powered-by', 'x-aspnet-version', 'x-generator', 'via', 'x-forwarded-for', 'x-forwarded-host', 'x-real-ip', 'x-backend', 'x-served-by', 'x-server']

/**
 * What a response lets a visitor learn about the machine.
 *
 * `response`: `{ status, headers: object with lower-case names, body: string }`.
 * `options`: `onion` (the service's own host, to exclude), `ownAddresses` (this machine's
 * interface addresses), `hostname` (this machine's name), `clearnetHosts` (names the same
 * server is, or was, published under).
 */
export function analyzeResponse(response, { onion = '', ownAddresses = [], hostname = '', clearnetHosts = [] } = {}) {
  const out = []
  const headers = response.headers ?? {}
  const body = response.body ?? ''
  const where = (what) => `${what} (HTTP ${response.status})`

  const server = headers.server
  if (server === undefined) out.push(finding('ok', 'no Server header'))
  else if (/\d/.test(server) || /nginx|apache|waitress|gunicorn|uvicorn|werkzeug|caddy|iis|express|jetty|tomcat/i.test(server)) {
    out.push(finding('warn', `the Server header names the software: "${server}"; it lets a visitor match this server against clearnet ones`))
  } else out.push(finding('ok', `Server header is generic ("${server}")`))

  for (const h of REVEALING_HEADERS) {
    if (headers[h] !== undefined) out.push(finding('warn', `the ${h} header is set: "${String(headers[h]).slice(0, 80)}"`))
  }

  // The clock: every origin sends Date, and a clock that is off by a distinctive amount can
  // be matched with the same machine's clearnet responses. Keep it synchronised.
  if (headers.date) {
    const skew = Math.abs(Date.parse(headers.date) - Date.now())
    if (Number.isFinite(skew) && skew > 5000) out.push(finding('warn', `the Date header is ${(skew / 1000).toFixed(0)} s off this machine's clock`))
  }

  const text = [headers.location ?? '', headers['set-cookie'] ?? '', body].join('\n')
  const lower = text.toLowerCase()

  for (const name of [hostname, ...clearnetHosts].filter(Boolean)) {
    if (lower.includes(name.toLowerCase())) out.push(finding('fail', where(`the response mentions ${name}, a name this machine is known by`)))
  }
  for (const addr of ownAddresses) {
    if (addr && text.includes(addr)) out.push(finding('fail', where(`the response contains this machine's own address ${addr}`)))
  }
  const literals = [...new Set(text.match(V4_IN_TEXT) ?? [])].filter((ip) => isIP(ip) === 4)
  const foreign = literals.filter((ip) => !ownAddresses.includes(ip) && !/^0\.|^255\./.test(ip))
  const privateOnes = foreign.filter((ip) => PRIVATE_V4.test(ip))
  const publicOnes = foreign.filter((ip) => !PRIVATE_V4.test(ip))
  if (privateOnes.length) out.push(finding('warn', where(`the response contains private addresses: ${privateOnes.slice(0, 5).join(', ')}`)))
  if (publicOnes.length) out.push(finding('warn', where(`the response contains IP addresses: ${publicOnes.slice(0, 5).join(', ')}; check that none is this server's`)))

  const loc = headers.location
  if (loc && /^https?:\/\//i.test(loc) && onion && !loc.toLowerCase().includes(onion.toLowerCase())) {
    out.push(finding('warn', where(`a redirect leaves the onion service: ${loc}`)))
  }
  return out
}

/** The worst level among findings, for an exit status. */
export function worst(findings) {
  return findings.some((f) => f.level === 'fail') ? 'fail' : findings.some((f) => f.level === 'warn') ? 'warn' : 'ok'
}
