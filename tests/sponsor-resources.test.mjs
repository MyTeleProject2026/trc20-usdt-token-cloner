import test from 'node:test'
import assert from 'node:assert/strict'
import { createSponsorResourceReader } from '../server/sponsor-resources.mjs'

const sponsorAddress = 'T' + 'A'.repeat(33)
const tronWebFactory = async () => ({
  isAddress: (address) => address === sponsorAddress,
  address: { toHex: () => '41' + 'ab'.repeat(20) },
})

test('sponsor resource reader returns TRON resources and delegation ceilings through Tatum only', async () => {
  const calls = []
  const reader = createSponsorResourceReader({
    env: { TATUM_API_KEY: 'server-only-tatum-test-key', SPONSOR_SHASTA_ADDRESS: sponsorAddress },
    tronWebFactory,
    now: () => 1000,
    fetchImpl: async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) })
      const payload = url.endsWith('/wallet/getaccountresource')
        ? { EnergyLimit: 5000, EnergyUsed: 1200, NetLimit: '900', NetUsed: '200', freeNetLimit: '600', freeNetUsed: '10' }
        : url.endsWith('/wallet/getcandelegatedmaxsize') && JSON.parse(options.body).type === 1
          ? { max_size: '3000000' }
          : { max_size: '6000000' }
      return { ok: true, status: 200, json: async () => payload }
    },
  })
  const result = await reader('shasta', { refresh: true })
  assert.equal(result.success, true)
  assert.equal(result.status, 'sponsor-resource-snapshot-read')
  assert.equal(result.resourceRead, true)
  assert.equal(result.resources.currentlyAvailableEnergy, '3800')
  assert.equal(result.resources.currentlyAvailableBandwidth, '700')
  assert.equal(result.resources.currentlyAvailableFreeBandwidth, '590')
  assert.equal(result.resources.maxDelegatableEnergyStakeSun, '3000000')
  assert.equal(result.resources.maxDelegatableBandwidthStakeSun, '6000000')
  assert.equal(result.delegationEnabled, false)
  assert.equal(result.canSubmitSponsoredTransfer, false)
  assert.equal(calls.length, 3)
  assert.ok(calls.every(({url}) => url.startsWith('https://tron-shasta.gateway.tatum.io/wallet/')))
  assert.ok(calls.every(({options}) => options.headers['x-api-key'] === 'server-only-tatum-test-key'))
  assert.equal(JSON.stringify(result).includes('server-only-tatum-test-key'), false)
})

test('sponsor resource reader categorizes HTTP-200 node errors without exposing provider text', async () => {
  const privateProviderMessage = 'secret-token-cannot-leak invalid address supplied by upstream'
  const reader = createSponsorResourceReader({
    env: { TATUM_API_KEY: 'server-only-tatum-test-key', SPONSOR_NILE_ADDRESS: sponsorAddress },
    tronWebFactory,
    fetchImpl: async (url) => ({
      ok: true,
      status: 200,
      json: async () => url.endsWith('/wallet/getaccountresource') ? { Error: privateProviderMessage } : { max_size: '0' },
    }),
  })
  const result = await reader('nile', { refresh: true })
  assert.equal(result.success, false)
  assert.equal(result.status, 'resource-read-unavailable')
  assert.equal(result.providerResponseCategory, 'invalid-address')
  assert.equal(JSON.stringify(result).includes(privateProviderMessage), false)
})

test('sponsor resource reader sanitizes provider transport errors', async () => {
  const privateTransportMessage = 'private transport context and api-key-like-secret'
  const reader = createSponsorResourceReader({
    env: { TATUM_API_KEY: 'server-only-tatum-test-key', SPONSOR_NILE_ADDRESS: sponsorAddress },
    tronWebFactory,
    fetchImpl: async () => { throw new TypeError(privateTransportMessage) },
  })
  const result = await reader('nile', { refresh: true })
  assert.equal(result.success, false)
  assert.equal(result.status, 'resource-read-unavailable')
  assert.equal(result.providerResponseCategory, 'provider-transport-error')
  assert.equal(JSON.stringify(result).includes(privateTransportMessage), false)
})

test('sponsor resource reader fails closed when sponsor address or Tatum credential is absent', async () => {
  let calls = 0
  const noAddress = createSponsorResourceReader({ env: { TATUM_API_KEY: 'key' }, tronWebFactory, fetchImpl: async () => { calls++; throw new Error('must not call') } })
  assert.equal((await noAddress('shasta')).status, 'sponsor-address-not-configured')
  const noKey = createSponsorResourceReader({ env: { SPONSOR_SHASTA_ADDRESS: sponsorAddress }, tronWebFactory, fetchImpl: async () => { calls++; throw new Error('must not call') } })
  const missing = await noKey('shasta', { refresh: true })
  assert.equal(missing.status, 'provider-credentials-missing')
  assert.deepEqual(missing.requiredEnvironment, ['TATUM_API_KEY'])
  assert.equal(missing.resourceRead, false)
  assert.equal(missing.delegationEnabled, false)
  assert.equal(calls, 0)
})

test('sponsor resource reader rejects malformed provider resource responses', async () => {
  const reader = createSponsorResourceReader({
    env: { TATUM_API_KEY: 'server-only-tatum-test-key', SPONSOR_SHASTA_ADDRESS: sponsorAddress },
    tronWebFactory,
    fetchImpl: async (url) => ({
      ok: true,
      json: async () => url.endsWith('/wallet/getaccountresource')
        ? { EnergyLimit: 'not-an-integer', EnergyUsed: 0, NetLimit: 10, NetUsed: 0, freeNetLimit: 10, freeNetUsed: 0 }
        : { max_size: '1000' },
    }),
  })
  const result = await reader('shasta', { refresh: true })
  assert.equal(result.success, false)
  assert.equal(result.failureStage, 'account-resource')
  assert.equal(result.providerResponseCategory, 'invalid-resource-fields')
})

test('sponsor resource reader reports missing delegation ceilings without provider payload', async () => {
  const reader = createSponsorResourceReader({
    env: { TATUM_API_KEY: 'server-only-tatum-test-key', SPONSOR_NILE_ADDRESS: sponsorAddress },
    tronWebFactory,
    fetchImpl: async (url) => ({
      ok: true,
      json: async () => url.endsWith('/wallet/getaccountresource')
        ? { EnergyLimit: 5000, EnergyUsed: 0, NetLimit: 100, NetUsed: 0, freeNetLimit: 500, freeNetUsed: 0 }
        : {},
    }),
  })
  const result = await reader('nile', { refresh: true })
  assert.equal(result.success, false)
  assert.equal(result.failureStage, 'energy-delegation-ceiling')
  assert.equal(result.providerResponseCategory, 'missing-delegation-ceiling')
})

test('sponsor resource reader exposes only sanitized provider HTTP status on throttling', async () => {
  const reader = createSponsorResourceReader({
    env: { TATUM_API_KEY: 'never-return-this-secret', SPONSOR_SHASTA_ADDRESS: sponsorAddress },
    tronWebFactory,
    fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({ message: 'never return this body' }) }),
  })
  const result = await reader('shasta', { refresh: true })
  assert.equal(result.success, false)
  assert.equal(result.providerStatus, 429)
  assert.equal(JSON.stringify(result).includes('never-return-this-secret'), false)
  assert.equal(JSON.stringify(result).includes('never return this body'), false)
})

test('Tatum failure never falls back to a public TRON node', async () => {
  const calls = []
  const reader = createSponsorResourceReader({
    env: { TATUM_API_KEY: 'server-only-tatum-test-key', SPONSOR_NILE_ADDRESS: sponsorAddress },
    tronWebFactory,
    fetchImpl: async (url, options) => {
      calls.push(url)
      return { ok: false, status: 503, json: async () => ({ message: 'provider unavailable' }) }
    },
  })
  const result = await reader('nile', { refresh: true })
  assert.equal(result.success, false)
  assert.equal(result.status, 'resource-read-unavailable')
  assert.equal(calls.length, 1)
  assert.ok(calls[0].startsWith('https://tron-nile.gateway.tatum.io/'))
})
