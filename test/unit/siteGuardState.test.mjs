// Unit tests for reading Tor's saved guard state without the "disabled" mark
// that permanently locks out a Snowflake bridge (src/site/guardState.ts), and
// for the cookie jar's database name (src/site/cookieJar.ts).
//
//   npm run test:unit

import { test, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { bundleTs } from './bundle.mjs'

let m
before(async () => {
  m = await bundleTs('test/unit/fixtures/siteEntry.ts', 'site-guard')
})

// The shape found in a real browser profile after several failed runs.
const DISABLED = {
  default: { guards: [], confirmed: [] },
  restricted: { guards: [], confirmed: [] },
  bridges: {
    guards: [
      {
        id: { ed25519: '1zOHpg+FxqQfi/6jDLtCpHHqBTH8gjYmCKXkus1D5Ko', rsa: '2b280b23e1107bb62abfc40ddcc8824814f80a72' },
        orports: ['192.0.2.3:80', '193.187.88.42:20153'],
        added_at: '2026-09-25T09:44:40Z',
        disabled: {
          type: 'TooManyIndeterminateFailures',
          history: { n_successes: 0, n_failures: 5, n_indeterminate: 15 },
          failure_ratio: 1.0,
          threshold_ratio: 0.7,
        },
        confirmed_at: '2026-09-25T09:44:40Z',
        unlisted_since: null,
      },
    ],
    confirmed: [0],
  },
}

describe('guard state', () => {
  test('the disabled mark is removed from a bridge guard and nothing else is touched', () => {
    const out = JSON.parse(m.sanitizeGuardState(JSON.stringify(DISABLED, null, 2)))
    const g = out.bridges.guards[0]
    assert.equal('disabled' in g, false)
    assert.deepEqual(g.orports, DISABLED.bridges.guards[0].orports)
    assert.equal(g.confirmed_at, '2026-09-25T09:44:40Z')
    assert.deepEqual(out.bridges.confirmed, [0])
    assert.deepEqual(out.default, DISABLED.default)
  })

  test('state with no disabled guard comes back byte for byte', () => {
    const clean = JSON.stringify({ ...DISABLED, bridges: { guards: [{ id: {}, orports: [] }], confirmed: [] } })
    assert.equal(m.sanitizeGuardState(clean), clean)
  })

  test('input that is not guard state is returned unchanged', () => {
    for (const s of ['not json', '{}', '{"bridges":{}}', '{"bridges":{"guards":"x"}}', 'null', '[]']) {
      assert.equal(m.sanitizeGuardState(s), s, s)
    }
  })

  test('only bridge guards are cleaned: a disabled ordinary guard keeps its mark', () => {
    const state = { default: { guards: [{ id: {}, disabled: { type: 'x' } }] }, bridges: { guards: [] } }
    assert.equal(m.sanitizeGuardState(JSON.stringify(state)), JSON.stringify(state))
  })

  test('the wrapper cleans state:guards on get and getAll and passes everything else through', async () => {
    const stored = new Map([
      ['state:guards', JSON.stringify(DISABLED)],
      ['state:other', 'raw'],
      ['dir:x', 'dirvalue'],
    ])
    const calls = []
    const inner = {
      get: async (k) => stored.get(k) ?? null,
      getAll: async (p) => [...stored].filter(([k]) => k.startsWith(p)),
      set: async (k, v) => { calls.push(['set', k]); stored.set(k, v) },
      delete: async (k) => { calls.push(['delete', k]); stored.delete(k) },
      keys: async (p) => [...stored.keys()].filter((k) => k.startsWith(p)),
      tryLock: async () => true,
      unlock: async () => {},
    }
    const s = m.withSanitizedGuards(inner)
    assert.equal('disabled' in JSON.parse(await s.get('state:guards')).bridges.guards[0], false)
    assert.equal(await s.get('state:other'), 'raw')
    assert.equal(await s.get('missing'), null)
    const all = await s.getAll('state:')
    assert.equal('disabled' in JSON.parse(all.find(([k]) => k === 'state:guards')[1]).bridges.guards[0], false)
    assert.deepEqual(all.find(([k]) => k === 'state:other'), ['state:other', 'raw'])
    await s.set('a', 'b')
    await s.delete('a')
    assert.deepEqual(calls, [['set', 'a'], ['delete', 'a']])
    assert.deepEqual(await s.keys('dir:'), ['dir:x'])
    assert.equal(await s.tryLock(), true)
    // The stored copy is not rewritten by reading.
    assert.equal(JSON.parse(stored.get('state:guards')).bridges.guards[0].disabled.type, 'TooManyIndeterminateFailures')
  })
})

describe('cookie jar database', () => {
  test("is not the Tor client's own database, whose single store would make the jar's store impossible", () => {
    assert.equal(m.COOKIE_DB, 'tor-site-cookies')
    assert.notEqual(m.COOKIE_DB, 'tor-site') // createAutoStorage('tor-site') in backend.ts
  })
})
