import test from 'node:test'
import assert from 'node:assert/strict'
import { createTenergyPromoClient } from '../server/providers/tenergy-promo.mjs'

const address = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const nonce = 'promo_nonce_12345678'
const signature = 'a'.repeat(130)

function mockFetch(routes) {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url, options })
    const path = new URL(url).pathname
    const value = routes[path]
    if (!value) return { ok: false, status: 404, json: async () => ({ code: 3037 }) }
    return {
      ok: value.status >= 200 && value.status < 300,
      status: value.status ?? 200,
      json: async () => value.body,
    }
  }
  return { fetchImpl, calls }
}

test('promo terms expose only the current Mainnet free Energy offer', async () => {
  const mocked = mockFetch({
    '/v1/promo': { body: {
      network: 'mainnet', state: 'active',
      starts_at: '2026-11-01T00:00:00Z', ends_at: '2026-12-01T00:00:00Z',
      cap_per_day: 100, left_today: 10, resets_at: null,
      grant: { resource: 'energy', amount: 65000, duration_seconds: 3600 },
    } },
  })
  const client = createTenergyPromoClient({ fetchImpl: mocked.fetchImpl })
  const result = await client.getPromo()
  assert.equal(result.success, true)
  assert.equal(result.grant.resource, 'energy')
  assert.equal(result.grant.amount, 65000)
  assert.equal(result.network, 'mainnet')
})

test('challenge returns exact provider message and maps permanent ineligibility', async (t) => {
  const mocked = mockFetch({
    '/v1/promo/redeem/challenge': { body: {
      address, nonce, purpose: 'promo_redeem', message: 'Sign this exact promo challenge message',
      issued_at: '2026-11-18T00:00:00Z', expires_at: '2026-11-18T00:10:00Z',
    } },
  })
  const client = createTenergyPromoClient({ fetchImpl: mocked.fetchImpl })
  const result = await client.createChallenge(address)
  assert.equal(result.success, true)
  assert.equal(result.message, 'Sign this exact promo challenge message')
  assert.equal(result.nonce, nonce)
  assert.equal(mocked.calls[0].options.method, 'POST')
  await t.test('3038 means this owner was not included in the promo drop', async () => {
    const ineligible = createTenergyPromoClient({ fetchImpl: async () => ({
      ok: false, status: 403, json: async () => ({ code: 3038 }),
    }) })
    const rejected = await ineligible.createChallenge(address)
    assert.equal(rejected.status, 'promo-not-eligible')
  })
})

test('redeem sends the exact nonce and wallet signature, but strips provider wallet ticket', async () => {
  const mocked = mockFetch({
    '/v1/promo/redeem': { status: 201, body: {
      address, method: 'signature', redeemed_at: '2026-11-18T00:00:00Z',
      status: 'granting', energy: 65000, expires_at: '2026-11-18T01:00:00Z',
      has_account: true, wallet_ticket: { token: 'must-not-leak' },
    } },
  })
  const client = createTenergyPromoClient({ fetchImpl: mocked.fetchImpl })
  const result = await client.redeem({ address, nonce, signature: '0x' + signature })
  assert.equal(result.success, true)
  assert.equal(result.status, 'granting')
  assert.equal(result.energy, 65000)
  assert.equal(mocked.calls[0].options.body.includes('0x'), false)
  assert.equal(JSON.stringify(result).includes('must-not-leak'), false)
})

test('invalid signatures are rejected before provider network access', async () => {
  let calls = 0
  const client = createTenergyPromoClient({ fetchImpl: async () => { calls += 1; throw new Error('unexpected') } })
  const result = await client.redeem({ address, nonce, signature: 'private-key-is-not-a-signature' })
  assert.equal(result.status, 'invalid-redemption-request')
  assert.equal(calls, 0)
})

test('redemption status distinguishes not claimed from delegated and validates provider shape', async (t) => {
  const delegated = createTenergyPromoClient({ fetchImpl: async () => ({
    ok: true, json: async () => ({
      address, method: 'signature', redeemed_at: '2026-11-18T00:00:00Z',
      status: 'delegated', energy: 65000, expires_at: null, has_account: true,
      wallet_ticket: { token: 'must-not-leak' },
    }),
  }) })
  const result = await delegated.getRedemption(address)
  assert.equal(result.success, true)
  assert.equal(result.status, 'delegated')
  assert.equal(JSON.stringify(result).includes('wallet_ticket'), false)

  await t.test('404 means no promo redemption exists', async () => {
    const missing = createTenergyPromoClient({ fetchImpl: async () => ({
      ok: false, status: 404, json: async () => ({ code: 3037 }),
    }) })
    const absent = await missing.getRedemption(address)
    assert.equal(absent.status, 'not-claimed')
  })
})

test('promo status off is represented as unavailable rather than a zero grant', async () => {
  const client = createTenergyPromoClient({ fetchImpl: async () => ({
    ok: true, json: async () => ({ network: 'mainnet', state: 'off', grant: null }),
  }) })
  const result = await client.getPromo()
  assert.equal(result.success, true)
  assert.equal(result.state, 'off')
  assert.equal(result.grant, null)
})
