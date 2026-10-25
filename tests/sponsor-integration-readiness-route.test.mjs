import test from 'node:test'
import assert from 'node:assert/strict'
import { createSponsorIntegrationReadinessRouter } from '../server/routes/sponsor-integration-readiness.mjs'

function responseRecorder() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) { this.headers[name] = value; return this },
    status(value) { this.statusCode = value; return this },
    json(value) { this.body = value; return this },
  }
}

function handlerFor(router) {
  const layer = router.stack.find((item) =>
    item.route?.path === '/sponsorship/integration-readiness'
      && item.route.methods?.get,
  )
  assert.ok(layer, 'readiness route must be registered')
  return layer.route.stack[0].handle
}

test('readiness runs configured provider probes but never enables transfer submission', async () => {
  const calls = []
  const secret = 'provider-secret-do-not-serialize'
  const sponsorAddress = 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8'
  const router = createSponsorIntegrationReadinessRouter({
    env: {
      GASFREE_MAINNET_API_KEY: 'hidden-key',
      GASFREE_MAINNET_API_SECRET: secret,
      GASFREE_NILE_API_KEY: 'hidden-nile-key',
      GASFREE_NILE_API_SECRET: 'hidden-nile-secret',
      SPONSOR_FEE_NILE_ADDRESS: sponsorAddress,
    },
    gasFreeClient: {
      isConfigured: (network) => ['mainnet', 'nile'].includes(network),
      async getCapabilities(network) {
        calls.push(network)
        if (network === 'mainnet') {
          return { configured: true, reachable: true, providerCount: 3, supportedTokenCount: 4 }
        }
        return { configured: true, reachable: false, reason: 'provider-auth-rejected', providerStatus: 403 }
      },
    },
  })

  const res = responseRecorder()
  await handlerFor(router)({}, res)

  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['Cache-Control'], 'no-store')
  assert.equal(res.headers.Pragma, 'no-cache')
  assert.deepEqual(calls.sort(), ['mainnet', 'nile'])
  assert.equal(res.body.networks.mainnet.gasFree.discoveryReachabilityVerified, true)
  assert.equal(res.body.networks.mainnet.gasFree.discoveryStatus, 'reachable')
  assert.equal(res.body.networks.mainnet.gasFree.providerCount, 3)
  assert.equal(res.body.networks.nile.gasFree.discoveryReachabilityVerified, false)
  assert.equal(res.body.networks.nile.gasFree.discoveryStatus, 'provider-auth-rejected')
  assert.equal(res.body.networks.nile.gasFree.providerStatus, 403)
  assert.equal(res.body.networks.shasta.gasFree.discoveryStatus, 'unsupported-network')
  assert.equal(res.body.submission.enabled, false)
  assert.equal(res.body.submission.canSubmitSponsoredTransfer, false)
  assert.equal(res.body.submission.userFundedFallbackAllowed, false)

  const serialized = JSON.stringify(res.body)
  for (const hidden of [secret, 'hidden-key', 'hidden-nile-key', 'hidden-nile-secret', sponsorAddress]) {
    assert.equal(serialized.includes(hidden), false, `readiness must not return ${hidden}`)
  }
})

test('readiness does not call provider when credentials are missing', async () => {
  let calls = 0
  const router = createSponsorIntegrationReadinessRouter({
    env: {},
    gasFreeClient: {
      isConfigured: () => false,
      async getCapabilities() { calls += 1; throw new Error('should not run') },
    },
  })
  const res = responseRecorder()
  await handlerFor(router)({}, res)

  assert.equal(res.statusCode, 200)
  assert.equal(calls, 0)
  assert.equal(res.body.networks.mainnet.gasFree.discoveryReachabilityVerified, false)
  assert.equal(res.body.networks.mainnet.gasFree.discoveryStatus, 'credentials-missing')
  assert.equal(res.body.networks.nile.gasFree.discoveryStatus, 'credentials-missing')
  assert.equal(res.body.submission.canSubmitSponsoredTransfer, false)
})

test('readiness sanitizes provider errors and fails closed when the probe throws', async () => {
  const router = createSponsorIntegrationReadinessRouter({
    env: {
      GASFREE_MAINNET_API_KEY: 'present',
      GASFREE_MAINNET_API_SECRET: 'present-but-never-return-this',
    },
    gasFreeClient: {
      isConfigured: (network) => network === 'mainnet',
      async getCapabilities() {
        throw new Error('sensitive token=present-but-never-return-this')
      },
    },
  })
  const res = responseRecorder()
  await handlerFor(router)({}, res)

  assert.equal(res.statusCode, 200)
  assert.equal(res.body.networks.mainnet.gasFree.discoveryReachabilityVerified, false)
  assert.equal(res.body.networks.mainnet.gasFree.discoveryStatus, 'provider-discovery-unavailable')
  assert.equal(JSON.stringify(res.body).includes('present-but-never-return-this'), false)
  assert.equal(res.body.submission.enabled, false)
  assert.equal(res.body.submission.canSubmitSponsoredTransfer, false)
})
