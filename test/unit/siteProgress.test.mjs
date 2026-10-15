// Unit tests for the connection progress estimate (src/site/progress.ts).
//
//   npm run test:unit

import { test, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { bundleTs } from './bundle.mjs'

let m
before(async () => {
  m = await bundleTs('test/unit/fixtures/siteEntry.ts', 'site-progress')
})

describe('progress tracker', () => {
  test('starts low and idle', () => {
    const t = new m.ProgressTracker()
    assert.equal(t.progress.state, 'idle')
    assert.ok(t.progress.percent > 0 && t.progress.percent < 10)
  })

  test('the normal sequence of log lines only moves the bar forward', () => {
    const t = new m.ProgressTracker()
    t.status({ state: 'bootstrapping' })
    let last = t.progress.percent
    for (const line of [
      'Creating TorClient',
      'Snowflake: opening a session (in parallel with storage initialisation)...',
      'Snowflake: asking the broker for a proxy (NAT: unknown)',
      'Initializing JS storage...',
      'Fast bootstrap: fetching https://x/bootstrap.zip.zst...',
      'Fast bootstrap: received 1234 bytes (compressed)',
      'Fast bootstrap: done',
      'Storage configured (state + directory cache)',
      'Snowflake: data channel to a volunteer proxy is open',
      'Snowflake: ready after 12.0s',
      'Bootstrapping Tor client...',
      '[tor_guardmgr::guard] We have found that guard [192.x.x.x:80+ ed25519:1z…] is usable.',
      'Bootstrap complete!',
      'First circuit through the bridge after 3.1s',
    ]) {
      assert.equal(t.log(line), true, line)
      assert.ok(t.progress.percent > last, line)
      last = t.progress.percent
    }
    assert.ok(last < 100)
  })

  test('the label is plain language per phase, the detail is in Tor terms', () => {
    const t = new m.ProgressTracker()
    t.log('Snowflake: asking the broker for a proxy (NAT: unknown)')
    assert.equal(t.progress.phase, 'network')
    assert.equal(t.progress.label, 'Starting the private network')
    assert.match(t.progress.detail, /Snowflake broker/)
    t.log('Bootstrapping Tor client...')
    assert.equal(t.progress.phase, 'route')
    assert.equal(t.progress.label, 'Finding a route')
    t.log('First circuit through the bridge after 3.1s')
    assert.match(t.progress.detail, /circuit/)
  })

  test('ready means only the server is left', () => {
    const t = new m.ProgressTracker()
    t.status({ state: 'ready' })
    assert.equal(t.progress.phase, 'server')
    assert.equal(t.progress.label, 'Connecting to the server')
  })

  test('the joined-the-network threshold is where "Bootstrap complete" lands', () => {
    const t = new m.ProgressTracker()
    t.log('Bootstrap complete!')
    assert.equal(t.progress.percent, m.TOR_JOINED_PERCENT)
  })

  test('an earlier milestone arriving late does not move the bar back', () => {
    const t = new m.ProgressTracker()
    t.log('Bootstrap complete!')
    const at = t.progress
    assert.equal(t.log('Initializing JS storage...'), false)
    assert.deepEqual(t.progress, at)
  })

  test('a session opened earlier counts as the Snowflake connection being ready', () => {
    const t = new m.ProgressTracker()
    assert.equal(t.log('[tor_js::snowflake::pool] Snowflake: using a session opened earlier'), true)
    assert.equal(t.progress.percent, 66)
  })

  test('unrelated lines change nothing', () => {
    const t = new m.ProgressTracker()
    assert.equal(t.log('Fetching https://example.onion/'), false)
  })

  test('ready is 100 percent and ignores later log lines', () => {
    const t = new m.ProgressTracker()
    t.status({ state: 'bootstrapping' })
    assert.equal(t.status({ state: 'ready' }), true)
    assert.equal(t.progress.percent, 100)
    assert.equal(t.log('Creating TorClient'), false)
    assert.equal(t.progress.percent, 100)
  })

  test('an error keeps the percentage and carries the reason', () => {
    const t = new m.ProgressTracker()
    t.log('Bootstrapping Tor client...')
    const pct = t.progress.percent
    t.status({ state: 'error', message: 'Tor was not ready after 120s' })
    assert.equal(t.progress.state, 'error')
    assert.equal(t.progress.percent, pct)
    assert.equal(t.progress.message, 'Tor was not ready after 120s')
  })

  test('a new attempt after an error starts over', () => {
    const t = new m.ProgressTracker()
    t.log('Bootstrapping Tor client...')
    t.status({ state: 'error', message: 'x' })
    t.status({ state: 'bootstrapping' })
    assert.equal(t.progress.state, 'bootstrapping')
    assert.ok(t.progress.percent < 12)
    assert.equal(t.progress.message, undefined)
    assert.equal(t.log('Creating TorClient'), true)
  })

  test('the bootstrapping state does not undo progress already seen', () => {
    const t = new m.ProgressTracker()
    t.log('Snowflake: ready after 5s')
    const pct = t.progress.percent
    t.status({ state: 'bootstrapping' })
    assert.equal(t.progress.percent, pct)
  })
})
