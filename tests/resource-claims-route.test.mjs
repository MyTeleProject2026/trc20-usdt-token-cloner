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
  })
  const result = await invoke(router, owner, true)
  assert.equal(result.statusCode, 200)
  assert.equal(result.body.status, 'resource-snapshot-and-provider-readiness-checked')
  assert.equal(result.body.resourceSnapshot.resources.energyAvailable, '0')
  assert.equal(result.body.providerReadiness.canRequestGrant, false)
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
