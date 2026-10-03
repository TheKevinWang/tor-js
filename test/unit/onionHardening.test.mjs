// scripts/onion-hardening.mjs: the hardened torrc and the checks that tell whether a server
// can be found or says who it is.
//
//   npm run test:unit

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { analyzeResponse, analyzeTorrc, isLoopbackTarget, torrcLines, worst } from '../../scripts/onion-hardening.mjs'

const base = { dataDir: 'C:\\tor\\data', hsDir: 'C:\\tor\\hs', target: '127.0.0.1:8000' }
const levels = (findings) => findings.map((f) => f.level)
const messages = (findings, level) => findings.filter((f) => f.level === level).map((f) => f.message)

describe('torrcLines', () => {
  const lines = torrcLines(base)
  const has = (l) => lines.includes(l)

  test('the service is forwarded to the loopback target and listens for nothing else', () => {
    assert.ok(has('HiddenServicePort 80 127.0.0.1:8000'))
    assert.ok(has('SocksPort 0'))
    assert.ok(!lines.some((l) => /^(ControlPort|ORPort|DirPort|ExitRelay|BridgeRelay)\b/.test(l)))
  })

  test('the process can neither relay, run programs, nor be debugged', () => {
    for (const l of ['ClientOnly 1', 'NoExec 1', 'DisableDebuggerAttachment 1']) assert.ok(has(l), l)
  })

  test('the service keeps its location hidden', () => {
    assert.ok(!lines.some((l) => /NonAnonymousMode|SingleHopMode/i.test(l)))
    assert.ok(has('HiddenServiceVersion 3'))
  })

  test('introduction points rate-limit floods, with more points than the default', () => {
    assert.ok(has('HiddenServiceEnableIntroDoSDefense 1'))
    assert.ok(has('HiddenServiceEnableIntroDoSRatePerSec 25'))
    assert.ok(has('HiddenServiceEnableIntroDoSBurstPerSec 200'))
    assert.ok(has('HiddenServiceNumIntroductionPoints 5'))
  })

  test('proof of work is on, with conservative queue limits: 25 a second, bursts of 100', () => {
    assert.ok(has('HiddenServicePoWDefensesEnabled 1'))
    assert.ok(has('HiddenServicePoWQueueRate 25'))
    assert.ok(has('HiddenServicePoWQueueBurst 100'))
  })

  test('the queue limits can be changed, and proof of work turned off, which leaves out the limits', () => {
    const custom = torrcLines({ ...base, powQueueRate: 10, powQueueBurst: 40 })
    assert.ok(custom.includes('HiddenServicePoWQueueRate 10') && custom.includes('HiddenServicePoWQueueBurst 40'))
    const off = torrcLines({ ...base, pow: false })
    assert.ok(off.includes('HiddenServicePoWDefensesEnabled 0'))
    assert.ok(!off.some((l) => /PoWQueue/.test(l)))
  })

  test('nonsense queue limits are refused', () => {
    for (const bad of [{ powQueueRate: 0 }, { powQueueRate: 2.5 }, { powQueueBurst: -1 }, { powQueueRate: '25' }]) {
      assert.throws(() => torrcLines({ ...base, ...bad }), /must be a whole number of at least 1/, JSON.stringify(bad))
    }
    assert.throws(() => torrcLines({ ...base, powQueueRate: 50, powQueueBurst: 10 }), /at least powQueueRate/)
    assert.doesNotThrow(() => torrcLines({ ...base, powQueueRate: 50, powQueueBurst: 50 }))
  })

  test('logs go to the console with addresses scrubbed, and Windows paths use forward slashes', () => {
    assert.ok(has('Log notice stdout') && has('SafeLogging 1'))
    assert.ok(has('DataDirectory C:/tor/data') && has('HiddenServiceDir C:/tor/hs'))
  })

  test('a target that is not loopback is refused, so the origin cannot be left exposed by mistake', () => {
    for (const target of ['0.0.0.0:8000', '192.168.1.5:8000', '10.0.0.2:80', 'example.com:80']) {
      assert.throws(() => torrcLines({ ...base, target }), /not a loopback/, target)
    }
    for (const target of ['127.0.0.1:8000', 'localhost:80', '[::1]:80', 'unix:/run/app.sock']) {
      assert.doesNotThrow(() => torrcLines({ ...base, target }), target)
    }
  })

  test('introduction points are limited to what Tor accepts (3 to 20)', () => {
    for (const introPoints of [2, 21, 4.5]) assert.throws(() => torrcLines({ ...base, introPoints }), /between 3 and 20/)
    assert.doesNotThrow(() => torrcLines({ ...base, introPoints: 3 }))
    assert.doesNotThrow(() => torrcLines({ ...base, introPoints: 20 }))
  })

  test('its own output passes the audit with nothing to report', () => {
    const found = analyzeTorrc(torrcLines(base).join('\n'))
    assert.deepEqual(messages(found, 'fail'), [])
    assert.deepEqual(messages(found, 'warn'), [])
  })
})

describe('isLoopbackTarget', () => {
  test('loopback addresses, with and without a port, and unix sockets', () => {
    for (const t of ['127.0.0.1', '127.0.0.1:80', '127.1.2.3:9', 'localhost:8000', '::1', '[::1]:80', 'unix:/tmp/s']) {
      assert.equal(isLoopbackTarget(t), true, t)
    }
    for (const t of ['0.0.0.0:80', '8.8.8.8:80', '192.168.0.2:80', 'example.com:80', '[fe80::1]:80']) {
      assert.equal(isLoopbackTarget(t), false, t)
    }
  })
})

describe('analyzeTorrc', () => {
  const POW = 'HiddenServicePoWDefensesEnabled 1\nHiddenServicePoWQueueRate 25\nHiddenServicePoWQueueBurst 100'
  const failing = (text) => messages(analyzeTorrc(text), 'fail')
  const warning = (text) => messages(analyzeTorrc(text), 'warn')

  test('single-hop and non-anonymous modes are failures, whichever way they are written', () => {
    for (const l of ['HiddenServiceNonAnonymousMode 1', 'HiddenServiceSingleHopMode 1', 'hiddenservicesinglehopmode yes']) {
      assert.match(failing(`HiddenServicePort 80 127.0.0.1:80\nSocksPort 0\n${l}`).join(), /single-hop/, l)
    }
  })

  test('forwarding to a non-loopback address is a failure; a bare virtual port is not', () => {
    assert.match(failing('HiddenServicePort 80 192.168.1.5:8000').join(), /not loopback/)
    assert.match(failing('HiddenServicePort 80 0.0.0.0:80').join(), /not loopback/)
    assert.deepEqual(failing('SocksPort 0\nHiddenServicePort 80'), [])
  })

  test('running as a relay is a failure', () => {
    assert.match(failing('ORPort 9001\nHiddenServicePort 80 127.0.0.1:80').join(), /relay/)
    assert.match(failing('ExitRelay 1\nHiddenServicePort 80 127.0.0.1:80').join(), /relay/)
    assert.deepEqual(failing('ORPort 0\nSocksPort 0\nHiddenServicePort 80 127.0.0.1:80'), [])
  })

  test('unscrubbed logs, file logs and verbose logs are reported', () => {
    assert.match(failing('SafeLogging 0').join(), /SafeLogging/)
    assert.match(warning('Log notice file /var/log/tor/notices.log').join(), /file/)
    assert.match(warning('Log debug stdout').join(), /debug/)
    assert.deepEqual(warning(`Log notice stdout\nSocksPort 0\nHiddenServiceEnableIntroDoSDefense 1\nHiddenServicePort 80 127.0.0.1:80\n${POW}`), [])
  })

  test('a listening SOCKS port, an unauthenticated control port and missing flood protection are reported', () => {
    assert.match(warning('HiddenServicePort 80 127.0.0.1:80').join('\n'), /SocksPort is at its default/)
    assert.match(warning('SocksPort 9150').join('\n'), /SocksPort is 9150/)
    assert.match(failing('ControlPort 9051').join(), /ControlPort/)
    assert.deepEqual(failing('ControlPort 9051\nCookieAuthentication 1'), [])
    assert.match(warning('SocksPort 0').join('\n'), /rate limiting is off/)
  })

  test('proof of work with sensible queue limits is fine', () => {
    const found = analyzeTorrc(`SocksPort 0\nHiddenServicePort 80 127.0.0.1:80\n${POW}`)
    assert.match(messages(found, 'ok').join('\n'), /proof of work is on, handling at most 25 introductions a second \(bursts of 100\)/)
    assert.doesNotMatch(messages(found, 'warn').join('\n'), /proof of work/)
    assert.deepEqual(messages(found, 'fail'), [])
  })

  test("proof of work without queue limits warns that Tor's defaults assume a big server", () => {
    const found = analyzeTorrc('SocksPort 0\nHiddenServicePort 80 127.0.0.1:80\nHiddenServicePoWDefensesEnabled 1')
    assert.match(messages(found, 'warn').join('\n'), /without HiddenServicePoWQueueRate and HiddenServicePoWQueueBurst/)
    assert.deepEqual(messages(found, 'fail'), [])
  })

  test('queue limits that make no sense fail', () => {
    const on = 'SocksPort 0\nHiddenServicePort 80 127.0.0.1:80\nHiddenServicePoWDefensesEnabled 1\n'
    assert.match(messages(analyzeTorrc(`${on}HiddenServicePoWQueueRate 50\nHiddenServicePoWQueueBurst 10`), 'fail').join(), /below HiddenServicePoWQueueRate/)
    assert.match(messages(analyzeTorrc(`${on}HiddenServicePoWQueueRate fast\nHiddenServicePoWQueueBurst 10`), 'fail').join(), /not whole numbers/)
    assert.match(messages(analyzeTorrc(`${on}HiddenServicePoWQueueRate 0\nHiddenServicePoWQueueBurst 10`), 'fail').join(), /not whole numbers/)
  })

  test('proof of work off is reported, as a warning', () => {
    assert.match(messages(analyzeTorrc('SocksPort 0\nHiddenServicePort 80 127.0.0.1:80'), 'warn').join('\n'), /proof of work is off/)
    assert.match(messages(analyzeTorrc('SocksPort 0\nHiddenServicePoWDefensesEnabled 0\nHiddenServicePort 80 127.0.0.1:80'), 'warn').join('\n'), /proof of work is off/)
  })

  test('comments and blank lines are ignored, and the last value of a setting wins', () => {
    const found = analyzeTorrc('# HiddenServiceSingleHopMode 1\n\nSocksPort 9050\nSocksPort 0 # now closed\nHiddenServicePort 80 127.0.0.1:80')
    assert.deepEqual(messages(found, 'fail'), [])
    assert.ok(messages(found, 'ok').some((m) => /no SOCKS/.test(m)))
  })
})

describe('analyzeResponse', () => {
  const ok = { status: 200, headers: { 'content-type': 'text/html', date: new Date().toUTCString() }, body: '<html><a href="/x">x</a></html>' }
  const me = { onion: 'abc.onion', ownAddresses: ['203.0.113.7', '192.168.1.20'], hostname: 'devbox', clearnetHosts: ['forum.example.com'] }

  test('a plain response reports nothing but ok', () => {
    assert.deepEqual(levels(analyzeResponse(ok, me)).filter((l) => l !== 'ok'), [])
  })

  test('a Server header that names software is reported; a missing or generic one is not', () => {
    for (const server of ['waitress', 'nginx/1.25.3', 'Apache/2.4.58 (Unix)', 'gunicorn']) {
      assert.match(messages(analyzeResponse({ ...ok, headers: { ...ok.headers, server } }, me), 'warn').join(), /Server header/, server)
    }
    assert.deepEqual(messages(analyzeResponse({ ...ok, headers: { ...ok.headers, server: 'web' } }, me), 'warn'), [])
  })

  test('headers that expose the proxy chain or the framework are reported', () => {
    const headers = { ...ok.headers, 'x-powered-by': 'Express', via: '1.1 varnish', 'x-forwarded-for': '203.0.113.9' }
    const warned = messages(analyzeResponse({ ...ok, headers }, me), 'warn').join('\n')
    for (const h of ['x-powered-by', 'via', 'x-forwarded-for']) assert.match(warned, new RegExp(h))
  })

  test('this machine’s own addresses and names, anywhere in the response, are failures', () => {
    const leak = (body, headers = {}) => messages(analyzeResponse({ ...ok, body, headers: { ...ok.headers, ...headers } }, me), 'fail').join('\n')
    assert.match(leak('<p>served from 203.0.113.7</p>'), /203\.113\.7|203\.0\.113\.7/)
    assert.match(leak('<p>host devbox</p>'), /devbox/)
    assert.match(leak('<a href="https://Forum.Example.com/x">'), /forum\.example\.com/i)
    assert.match(leak('', { location: 'http://192.168.1.20:8000/login' }), /192\.168\.1\.20/)
    assert.match(leak('', { 'set-cookie': 'a=b; Domain=forum.example.com' }), /forum\.example\.com/)
  })

  test('other IP addresses are warnings, split into private and public', () => {
    const warned = messages(analyzeResponse({ ...ok, body: 'peers 10.1.2.3 and 198.51.100.4, version 5.1.0.2' }, me), 'warn').join('\n')
    assert.match(warned, /private addresses: 10\.1\.2\.3/)
    assert.match(warned, /IP addresses: 198\.51\.100\.4/)
  })

  test('a clock far from this machine’s is reported', () => {
    const skewed = new Date(Date.now() - 3 * 60_000).toUTCString()
    assert.match(messages(analyzeResponse({ ...ok, headers: { ...ok.headers, date: skewed } }, me), 'warn').join(), /Date header/)
  })

  test('a redirect out of the onion service is reported, one within it is not', () => {
    const redirect = (location) => messages(analyzeResponse({ status: 302, headers: { location }, body: '' }, me), 'warn').join()
    assert.match(redirect('https://elsewhere.test/'), /leaves the onion service/)
    assert.doesNotMatch(redirect('http://abc.onion/login'), /leaves/)
    assert.doesNotMatch(redirect('/login'), /leaves/)
  })

  test('worst picks the most serious level', () => {
    assert.equal(worst([]), 'ok')
    assert.equal(worst([{ level: 'ok' }, { level: 'warn' }]), 'warn')
    assert.equal(worst([{ level: 'warn' }, { level: 'fail' }, { level: 'ok' }]), 'fail')
  })
})
