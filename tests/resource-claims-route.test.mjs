import test from 'node:test'
import assert from 'node:assert/strict'
import { createResourceClaimsRouter } from '../server/routes/resource-claims.mjs'

const owner = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const other = 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8'

function invoke(router, address, refresh) {
  const route = router.stack.find((entry) => entry.route?.path === '/resources/claims/readiness')
  const handler = route.route.stack[0].handle
  let statusCode = 200
  let body
  const res = {
    setHeader() {},
    status(code) { statusCode = code; return this },
    json(value) { body = value; return this },
  }
  return handler({ query: { address, ...(refresh ? { refresh: '1' } : {}) } }, res)
    .then(() => ({ statusCode, body }))
}

test('resource claim readiness route combines live snapshot and provider readiness without enabling grant submission', async () => {
  let readOptions
  const router = createResourceClaimsRouter({
    allowedAddress: owner,
    readStatus: async (address, options) => {
      readOptions = { address, options }
      return { success: true, network: 'mainnet', resources: { energyAvailable: '0', freeBandwidthAvailable: '600' } }
    },
    orchestrator: {
      async getReadiness(address) {
        return { success: true, network: 'mainnet', ownerAddress: address, canRequestGrant: false, status: 'no-authorized-provider-adapter' }
      },
    },
    publicProvider: {
      async readResources(address) { return { success: true, address, provider: 'tenergy', capabilities: { freeGrantRequest: false } } },
      async health() { return { success: true, reachable: true, network: 'mainnet', status: 'operational' } },
    },
  })
  const result = await invoke(router, owner, true)
  assert.equal(result.statusCode, 200)
  assert.equal(result.body.status, 'partial-resource-provider-observations-available')
  assert.equal(result.body.resourceSnapshot.resources.energyAvailable, '0')
  assert.equal(result.body.providerReadiness.canRequestGrant, false)
  assert.equal(result.body.publicProviderDiscovery.provider, 'tenergy')
  assert.equal(result.body.publicProviderDiscovery.grantCapability.available, false)
  assert.equal(result.body.publicProviderDiscovery.health.reachable, true)
  assert.equal(result.body.automaticClaim.enabled, false)
  assert.equal(result.body.automaticClaim.requestEndpointEnabled, false)
  assert.equal(result.body.deployment.mayBroadcast, false)
  assert.deepEqual(readOptions, { address: owner, options: { refresh: true } })
})

test('resource claim readiness route denies addresses other than the configured owner', async () => {
  let readCalled = false
  const router = createResourceClaimsRouter({
    allowedAddress: owner,
    readStatus: async () => { readCalled = true; return { success: true } },
    orchestrator: { async getReadiness() { return { success: true } } },
  })
  const result = await invoke(router, other, false)
  assert.equal(result.statusCode, 403)
  assert.equal(result.body.error, 'wallet-not-allowed')
  assert.equal(readCalled, false)
})

test('one unavailable upstream does not suppress successful owner and provider observations', async () => {
  const router = createResourceClaimsRouter({
    allowedAddress: owner,
    readStatus: async () => ({ success: true, resources: { energyAvailable: '12345', freeBandwidthAvailable: '600' } }),
    orchestrator: { async getReadiness() { throw new Error('provider timeout') } },
    publicProvider: {
      async readResources() { return { success: true, provider: 'tenergy', energy: '0' } },
      async health() { throw new Error('health endpoint unavailable') },
    },
  })
  const result = await invoke(router, owner, false)
  assert.equal(result.statusCode, 200)
  assert.equal(result.body.status, 'partial-resource-provider-observations-available')
  assert.equal(result.body.resourceSnapshot.success, true)
  assert.equal(result.body.resourceSnapshot.resources.energyAvailable, '12345')
  assert.equal(result.body.publicProviderDiscovery.resourceObservation.success, true)
  assert.equal(result.body.providerReadiness.status, 'provider-readiness-unavailable')
  assert.equal(result.body.publicProviderDiscovery.health.reachable, false)
  assert.equal(result.body.automaticClaim.enabled, false)
  assert.equal(result.body.deployment.mayBroadcast, false)
})

test('successful provider health/readiness response is not labeled authorized without grant capability', async () => {
  const router = createResourceClaimsRouter({
    allowedAddress: owner,
    readStatus: async () => ({ success: true, resources: { energyAvailable: '10', freeBandwidthAvailable: '10' } }),
    orchestrator: {
      async getReadiness() {
        return {
          success: true,
          providerReachable: true,
          canRequestGrant: false,
          status: 'provider-reachable-eligibility-not-checked',
        }
      },
    },
    publicProvider: {
      async readResources() { return { success: true, provider: 'tenergy' } },
      async health() { return { success: true, reachable: true, network: 'mainnet' } },
    },
  })
  const result = await invoke(router, owner, false)
  assert.equal(result.statusCode, 200)
  assert.equal(result.body.providerReadiness.providerReachable, true)
  assert.equal(result.body.providerReadiness.canRequestGrant, false)
  assert.equal(result.body.checks.authorizedProviderReadiness, 'unavailable')
  assert.equal(result.body.automaticClaim.enabled, false)
  assert.equal(result.body.deployment.mayBroadcast, false)
})
