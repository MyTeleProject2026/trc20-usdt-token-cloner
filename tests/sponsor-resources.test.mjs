import test from 'node:test'
import assert from 'node:assert/strict'
import { createSponsorResourceReader } from '../server/sponsor-resources.mjs'

const sponsorAddress = 'T' + 'A'.repeat(33)
const tronWebFactory = async () => ({
  isAddress: (address) => address === sponsorAddress,
  address: { toHex: () => '41' + 'ab'.repeat(20) },
})

test('sponsor resource reader returns TRON resource state and both delegation ceilings without enabling sends', async () => {
  const calls = []
  const reader = createSponsorResourceReader({
    env: { TATUM_API_KEY: 'server-only-test-key', SPONSOR_SHASTA_ADDRESS: sponsorAddress },
    tronWebFactory,
    now: () => 1000,
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) })
      const payload = url.endsWith('/wallet/getaccountresource')
        ? { EnergyLimit: 5000, EnergyUsed: 1200, NetLimit: '900', NetUsed: '200', freeNetLimit: '600', freeNetUsed: '10' }
        : url.endsWith('/wallet/getcandelegatedmaxsize') && JSON.parse(options.body).type === 1
          ? { max_size: '3000000' }
          : { max_size: '6000000' }
      return { ok: true, json: async () => payload }
    },
  })

  const result = await reader('shasta', { refresh: true })
  assert.equal(result.success, true)
  assert.equal(result.status, 'sponsor-resource-snapshot-read')
  assert.equal(result.resourceRead, true)
  assert.equal(result.sponsorAddress, sponsorAddress)
  assert.equal(result.resources.currentlyAvailableEnergy, '3800')
  assert.equal(result.resources.currentlyAvailableBandwidth, '700')
  assert.equal(result.resources.currentlyAvailableFreeBandwidth, '590')
  assert.equal(result.resources.maxDelegatableEnergyStakeSun, '3000000')
  assert.equal(result.resources.maxDelegatableBandwidthStakeSun, '6000000')
  assert.equal(result.delegationEnabled, false)
  assert.equal(result.canSubmitSponsoredTransfer, false)
  assert.equal(calls.length, 3)
  const accountResourceCalls = calls.filter((call) => call.url.endsWith('/wallet/getaccountresource'))
  const delegationCalls = calls.filter((call) => call.url.endsWith('/wallet/getcandelegatedmaxsize'))
  assert.equal(accountResourceCalls.length, 1)
  assert.equal(accountResourceCalls[0].body.address, sponsorAddress)
  assert.equal(accountResourceCalls[0].body.visible, true)
  assert.equal(calls.some((call) => call.url.endsWith('/walletsolidity/getaccountresource')), false)
  assert.equal(delegationCalls.length, 2)
  assert.ok(delegationCalls.every((call) => call.body.owner_address === sponsorAddress && call.body.visible === true))
  assert.deepEqual(delegationCalls.map((call) => call.body.type).sort(), [0, 1])
  assert.equal(JSON.stringify(result).includes('server-only-test-key'), false)
})


test('sponsor resource reader categorizes HTTP-200 node errors without exposing provider text', async () => {
  const privateProviderMessage = 'secret-token-cannot-leak invalid address supplied by upstream'
  const reader = createSponsorResourceReader({
    env: { TATUM_API_KEY: 'server-only-test-key', SPONSOR_NILE_ADDRESS: sponsorAddress },
    tronWebFactory,
    fetchImpl: async (url) => ({
      ok: true,
      status: 200,
      json: async () => url.endsWith('/wallet/getaccountresource')
        ? { Error: privateProviderMessage }
        : { max_size: '0' },
    }),
  })
  const result = await reader('nile', { refresh: true })
  assert.equal(result.success, false)
  assert.equal(result.status, 'resource-read-unavailable')
  assert.equal(result.failureStage, 'account-resource')
  assert.equal(result.providerResponseCategory, 'invalid-address')
  assert.equal(JSON.stringify(result).includes(privateProviderMessage), false)
  assert.equal(JSON.stringify(result).includes('secret-token-cannot-leak'), false)
})


test('sponsor resource reader categorizes transport failures without echoing exception text', async () => {
  const privateTransportMessage = 'private transport context and api-key-like-secret'
  const reader = createSponsorResourceReader({
    env: { TATUM_API_KEY: 'server-only-test-key', SPONSOR_NILE_ADDRESS: sponsorAddress },
    tronWebFactory,
    fetchImpl: async () => { throw new TypeError(privateTransportMessage) },
  })
  const result = await reader('nile', { refresh: true })
  assert.equal(result.success, false)
  assert.equal(result.status, 'resource-read-unavailable')
  assert.ok(['account-resource', 'energy-delegation-ceiling', 'bandwidth-delegation-ceiling'].includes(result.failureStage))
  assert.equal(result.providerResponseCategory, 'provider-transport-error')
  assert.equal(JSON.stringify(result).includes(privateTransportMessage), false)
  assert.equal(JSON.stringify(result).includes('api-key-like-secret'), false)
})

test('sponsor resource reader fails closed when sponsor address or credentials are absent', async () => {
  const noAddress = createSponsorResourceReader({ env: {}, tronWebFactory, fetchImpl: async () => { throw new Error('must not call provider') } })
  const missingAddress = await noAddress('shasta')
  assert.equal(missingAddress.status, 'sponsor-address-not-configured')
  assert.equal(missingAddress.resourceRead, false)
  assert.equal(missingAddress.delegationEnabled, false)

  const noKey = createSponsorResourceReader({
    env: { SPONSOR_SHASTA_ADDRESS: sponsorAddress },
    tronWebFactory,
    fetchImpl: async () => { throw new Error('must not call provider') },
  })
  const missingKey = await noKey('shasta')
  assert.equal(missingKey.status, 'provider-credentials-missing')
  assert.equal(missingKey.resourceRead, false)
})

test('sponsor resource reader rejects malformed provider resource responses', async () => {
  const reader = createSponsorResourceReader({
    env: { TATUM_API_KEY: 'server-only-test-key', SPONSOR_SHASTA_ADDRESS: sponsorAddress },
    tronWebFactory,
    fetchImpl: async (url) => ({
      ok: true,
      json: async () => url.endsWith('/wallet/getaccountresource')
        ? { EnergyLimit: 'not-an-integer', EnergyUsed: 0, NetLimit: 0, NetUsed: 0, freeNetLimit: 0, freeNetUsed: 0 }
        : { max_size: '0' },
    }),
  })
  const result = await reader('shasta', { refresh: true })
  assert.equal(result.success, false)
  assert.equal(result.status, 'resource-read-unavailable')
  assert.equal(result.failureStage, 'account-resource')
  assert.equal(result.resourceRead, false)
  assert.equal(result.delegationEnabled, false)
})

test('sponsor resource reader exposes only the sanitized provider HTTP status on throttling', async () => {
  const reader = createSponsorResourceReader({
    env: { TATUM_API_KEY: 'never-return-this-secret', SPONSOR_SHASTA_ADDRESS: sponsorAddress },
    tronWebFactory,
    fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({ message: 'never return this body' }) }),
  })
  const result = await reader('shasta', { refresh: true })
  assert.equal(result.success, false)
  assert.equal(result.status, 'resource-read-unavailable')
  assert.equal(result.providerStatus, 429)
  assert.ok(['account-resource', 'energy-delegation-ceiling', 'bandwidth-delegation-ceiling'].includes(result.failureStage))
  assert.equal(result.resourceRead, false)
  assert.equal(JSON.stringify(result).includes('never-return-this-secret'), false)
  assert.equal(JSON.stringify(result).includes('never return this body'), false)
})
