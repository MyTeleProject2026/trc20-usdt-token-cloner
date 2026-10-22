import test from 'node:test'
import assert from 'node:assert/strict'
import { createGasFreeRouter } from '../server/routes/gasfree.mjs'

function getRoute(router) {
  const layer = router.stack.find((item) =>
    item.route?.path === '/capabilities' && item.route.methods?.get,
  )
  assert.ok(layer, 'GET /capabilities must be registered')
  return layer.route.stack[0].handle
}

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this },
  }
}

test('GasFree route rejects unknown networks before calling provider', async () => {
  let called = false
  const router = createGasFreeRouter({ getCapabilities: async () => { called = true } })
  const res = responseRecorder()
  await getRoute(router)({ query: { network: 'shasta' } }, res)
  assert.equal(res.statusCode, 400)
  assert.equal(res.body.status, 'invalid-network')
  assert.equal(called, false)
})

test('GasFree route distinguishes missing access from a provider failure and never submits', async () => {
  const notConfigured = createGasFreeRouter({ getCapabilities: async () => ({
    configured: false, reachable: false, network: 'mainnet', reason: 'credentials-not-configured',
    requiredEnvironment: ['GASFREE_API_KEY', 'GASFREE_API_SECRET'],
  }) })
  const first = responseRecorder()
  await getRoute(notConfigured)({ query: { network: 'mainnet' } }, first)
  assert.equal(first.statusCode, 503)
  assert.equal(first.body.status, 'not-configured')

  const failed = createGasFreeRouter({ getCapabilities: async () => ({
    configured: true, reachable: false, network: 'nile', reason: 'provider-auth-rejected', providerStatus: 403,
  }) })
  const second = responseRecorder()
  await getRoute(failed)({ query: { network: 'nile' } }, second)
  assert.equal(second.statusCode, 502)
  assert.equal(second.body.status, 'provider-auth-rejected')
})

test('GasFree success route keeps provider funding and transaction submissions unverified', async () => {
  const router = createGasFreeRouter({ getCapabilities: async () => ({
    configured: true, reachable: true, network: 'mainnet', networkLabel: 'TRON Mainnet',
    providerCount: 1, supportedTokenCount: 1, providers: [], tokens: [],
    providerFundingVerified: false, canSubmitSponsoredTransfer: false,
    feePolicy: 'fees charged in transferred token',
  }) })
  const res = responseRecorder()
  await getRoute(router)({ query: { network: 'mainnet' } }, res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.status, 'provider-capabilities-read')
  assert.equal(res.body.providerFundingVerified, false)
  assert.equal(res.body.canSubmitSponsoredTransfer, false)
})
