import test from 'node:test'
import assert from 'node:assert/strict'
import { createTenergyPromoRouter } from '../server/routes/tenergy-promo.mjs'

const OWNER = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'

function fakeResponse(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload }
}

function routeHandler(router, path, method = 'get') {
  const item = router.stack.find((entry) => entry.route?.path === path && entry.route.methods[method])
  assert.ok(item, 'route ' + method.toUpperCase() + ' ' + path + ' exists')
  return item.route.stack[item.route.stack.length - 1].handle
}

function responseHarness() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    setHeader(key, value) { this.headers[key] = value },
    status(code) { this.statusCode = code; return this },
    json(value) { this.body = value; return this },
  }
}

test('promo status reports Energy-only coverage and never represents the provider record as deployed resources', async () => {
  const router = createTenergyPromoRouter({
    allowedAddress: OWNER,
    fetchImpl: async (url) => url.endsWith('/promo')
      ? fakeResponse({ network: 'mainnet', state: 'active', left_today: 12, grant: { resource: 'energy', amount: 65000, duration_seconds: 3600 }, token: { id: '123', name: 'promo' } })
      : fakeResponse({ code: 'promo_not_redeemed' }, 404),
  })
  const res = responseHarness()
  await routeHandler(router, '/tenergy/promo/status')({ query: { address: OWNER } }, res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.promo.state, 'active')
  assert.equal(res.body.promo.grant.resource, 'energy')
  assert.equal(res.body.resourceCoverage.bandwidth, false)
  assert.equal(res.body.resourceCoverage.contractDeploymentFee, false)
  assert.equal(res.body.requiresOwnerMessageSignature, true)
})

test('promo challenge is checked before requesting a wallet signature and reports ineligibility', async () => {
  const router = createTenergyPromoRouter({
    allowedAddress: OWNER,
    fetchImpl: async (url) => {
      if (url.endsWith('/promo')) return fakeResponse({ state: 'active', grant: { resource: 'energy', amount: 65000 } })
      if (url.includes('/redemptions/')) return fakeResponse({ code: 'promo_not_redeemed' }, 404)
      if (url.endsWith('/redeem/challenge')) return fakeResponse({ code: 'promo_not_eligible', message: 'not dropped' }, 403)
      throw new Error('unexpected endpoint')
    },
  })
  const res = responseHarness()
  await routeHandler(router, '/tenergy/promo/challenge', 'post')({ body: { address: OWNER } }, res)
  assert.equal(res.statusCode, 403)
  assert.equal(res.body.status, 'promo-not-eligible')
})

test('challenge returns the exact provider message and never changes it', async () => {
  const challenge = { address: OWNER, purpose: 'promo_redeem', message: 'TEnergy promo redeem exact bytes\nDo not alter.', nonce: 'nonce-12345678', expires_at: new Date(Date.now() + 600000).toISOString() }
  const router = createTenergyPromoRouter({
    allowedAddress: OWNER,
    fetchImpl: async (url) => {
      if (url.endsWith('/promo')) return fakeResponse({ state: 'active', grant: { resource: 'energy', amount: 65000 } })
      if (url.includes('/redemptions/')) return fakeResponse({}, 404)
      if (url.endsWith('/redeem/challenge')) return fakeResponse(challenge, 201)
      throw new Error('unexpected endpoint')
    },
  })
  const res = responseHarness()
  await routeHandler(router, '/tenergy/promo/challenge', 'post')({ body: { address: OWNER } }, res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.message, challenge.message)
  assert.equal(res.body.nonce, challenge.nonce)
  assert.equal(res.body.fee, '0')
  assert.equal(res.body.transactionRequired, false)
})

test('redeem forwards only exact owner, nonce and signature, and discards provider wallet ticket', async () => {
  let captured
  const router = createTenergyPromoRouter({
    allowedAddress: OWNER,
    fetchImpl: async (_url, init) => {
      captured = JSON.parse(init.body)
      return fakeResponse({
        address: OWNER, method: 'signature', status: 'granting', energy: 65000,
        expires_at: new Date(Date.now() + 3600000).toISOString(),
        wallet_ticket: { token: 'do-not-return' },
      }, 201)
    },
  })
  const res = responseHarness()
  await routeHandler(router, '/tenergy/promo/redeem', 'post')({
    body: { address: OWNER, nonce: 'nonce-12345678', signature: 'ab'.repeat(65) },
  }, res)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(captured, { address: OWNER, nonce: 'nonce-12345678', signature: 'ab'.repeat(65) })
  assert.equal(res.body.redemption.status, 'granting')
  assert.equal(res.body.walletTicketDiscarded, true)
  assert.equal(JSON.stringify(res.body).includes('do-not-return'), false)
})

test('promo routes reject other wallets and malformed fields', async () => {
  const router = createTenergyPromoRouter({ allowedAddress: OWNER, fetchImpl: async () => { throw new Error('must not fetch') } })
  const status = responseHarness()
  await routeHandler(router, '/tenergy/promo/status')({ query: { address: 'T' + 'A'.repeat(33) } }, status)
  assert.equal(status.statusCode, 403)
  const invalid = responseHarness()
  await routeHandler(router, '/tenergy/promo/redeem', 'post')({ body: { address: OWNER, nonce: 'x', signature: 'bad', privateKey: 'never' } }, invalid)
  assert.equal(invalid.statusCode, 400)
})
