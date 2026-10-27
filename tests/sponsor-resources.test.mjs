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
  assert.deepEqual(result.providerResponseFields, ['Error'])
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

  const publicFallbackCalls = []
  const noKey = createSponsorResourceReader({
    env: { SPONSOR_SHASTA_ADDRESS: sponsorAddress },
    tronWebFactory,
    fetchImpl: async (url, options) => {
      publicFallbackCalls.push({ url, options })
      const body = JSON.parse(options.body)
      const payload = url.endsWith('/wallet/getaccountresource')
        ? { EnergyLimit: 1000, EnergyUsed: 250, NetLimit: 500, NetUsed: 100, freeNetLimit: 400, freeNetUsed: 50 }
        : { max_size: body.type === 1 ? '2000000' : '3000000' }
      return { ok: true, status: 200, json: async () => payload }
    },
  })
  const publicFallback = await noKey('shasta', { refresh: true })
  assert.equal(publicFallback.success, true)
  assert.equal(publicFallback.status, 'sponsor-resource-snapshot-read')
  assert.equal(publicFallback.resourceRead, true)
  assert.match(publicFallback.source, /TRONGrid public FullNode/)
  assert.equal(publicFallback.canSubmitSponsoredTransfer, false)
  assert.equal(publicFallback.delegationEnabled, false)
  assert.equal(publicFallbackCalls.length, 3)
  assert.ok(publicFallbackCalls.every(({ url }) => url.startsWith('https://api.shasta.trongrid.io/wallet/')))
  assert.ok(publicFallbackCalls.every(({ options }) => !('TRON-PRO-API-KEY' in options.headers) && !('x-api-key' in options.headers)))
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
  assert.equal(result.providerResponseCategory, 'invalid-resource-fields')
  assert.deepEqual(result.providerResponseFields, ['EnergyLimit', 'EnergyUsed', 'NetLimit', 'NetUsed', 'freeNetLimit', 'freeNetUsed'].sort())
  assert.equal(result.resourceRead, false)
  assert.equal(result.delegationEnabled, false)
})


test('sponsor resource reader distinguishes a provider error envelope from a missing response field', async () => {
  const privateProviderMessage = 'upstream says address is invalid; api-key-secret-never-return'
  const reader = createSponsorResourceReader({
    env: { TATUM_API_KEY: 'server-only-test-key', SPONSOR_NILE_ADDRESS: sponsorAddress },
    tronWebFactory,
    fetchImpl: async (url) => ({
      ok: true,
      json: async () => url.endsWith('/wallet/getaccountresource')
        ? { message: privateProviderMessage }
        : { max_size: '0' },
    }),
  })
  const result = await reader('nile', { refresh: true })
  assert.equal(result.success, false)
  assert.equal(result.failureStage, 'account-resource')
  assert.equal(result.providerResponseCategory, 'invalid-address')
  assert.equal(JSON.stringify(result).includes(privateProviderMessage), false)
  assert.equal(JSON.stringify(result).includes('api-key-secret-never-return'), false)
})

test('sponsor resource reader reports a missing delegation ceiling without returning provider payload', async () => {
  const reader = createSponsorResourceReader({
    env: { TATUM_API_KEY: 'server-only-test-key', SPONSOR_NILE_ADDRESS: sponsorAddress },
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
  assert.deepEqual(result.providerResponseFields, [])
  assert.equal(JSON.stringify(result).includes('provider payload'), false)
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

test('sponsor resource reader prefers configured TRONGrid credentials for network-specific read-only resource calls', async () => {
  const calls = []
  const reader = createSponsorResourceReader({
    env: { TRONGRID_API_KEY: 'server-only-trongrid-test-key', SPONSOR_NILE_ADDRESS: sponsorAddress },
    tronWebFactory,
    now: () => 1000,
    fetchImpl: async (url, options) => {
      calls.push({ url, options })
      const payload = url.endsWith('/wallet/getaccountresource')
        ? { EnergyLimit: 1000, EnergyUsed: 200, NetLimit: 400, NetUsed: 50, freeNetLimit: 100, freeNetUsed: 10 }
        : { max_size: '5000000' }
      return { ok: true, status: 200, json: async () => payload }
    },
  })

  const result = await reader('nile', { refresh: true })
  assert.equal(result.success, true)
  assert.equal(result.resourceRead, true)
  assert.match(result.source, /^TRONGrid FullNode/)
  assert.equal(calls.length, 3)
  assert.ok(calls.every(({ url }) => url.startsWith('https://nile.trongrid.io/wallet/')))
  assert.ok(calls.every(({ options }) => options.headers?.['TRON-PRO-API-KEY'] === 'server-only-trongrid-test-key'))
  assert.ok(calls.every(({ options }) => !('x-api-key' in options.headers)))
  assert.equal(JSON.stringify(result).includes('server-only-trongrid-test-key'), false)
  assert.equal(result.canSubmitSponsoredTransfer, false)
})



test('sponsor resource reader falls back per endpoint from TRONGrid to Tatum while remaining read-only', async () => {
  const calls = []
  const reader = createSponsorResourceReader({
    env: {
      TRONGRID_API_KEY: 'server-only-trongrid-test-key',
      TATUM_API_KEY: 'server-only-tatum-test-key',
      SPONSOR_NILE_ADDRESS: sponsorAddress,
    },
    tronWebFactory,
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body)
      calls.push({ url, headers: options.headers, body })
      if (url.startsWith('https://nile.trongrid.io')
        && url.endsWith('/wallet/getcandelegatedmaxsize')
        && body.type === 1) {
        return { ok: true, status: 200, json: async () => ({ Error: 'method not found' }) }
      }
      const payload = url.endsWith('/wallet/getaccountresource')
        ? { EnergyLimit: 1000, EnergyUsed: 200, NetLimit: 400, NetUsed: 50, freeNetLimit: 100, freeNetUsed: 10 }
        : { max_size: body.type === 1 ? '5000000' : '7000000' }
      return { ok: true, status: 200, json: async () => payload }
    },
  })

  const result = await reader('nile', { refresh: true })
  assert.equal(result.success, true)
  assert.equal(result.resourceRead, true)
  assert.match(result.source, /TRONGrid and Tatum/)
  assert.equal(result.resources.maxDelegatableEnergyStakeSun, '5000000')
  assert.equal(result.resources.maxDelegatableBandwidthStakeSun, '7000000')
  assert.equal(result.canSubmitSponsoredTransfer, false)
  assert.equal(result.delegationEnabled, false)

  const failedTronGridEnergyCall = calls.find(({ url, body }) =>
    url.startsWith('https://nile.trongrid.io')
      && url.endsWith('/wallet/getcandelegatedmaxsize')
      && body.type === 1)
  const successfulTatumEnergyCall = calls.find(({ url, body }) =>
    url.startsWith('https://tron-nile.gateway.tatum.io')
      && url.endsWith('/wallet/getcandelegatedmaxsize')
      && body.type === 1)
  assert.ok(failedTronGridEnergyCall)
  assert.ok(successfulTatumEnergyCall)
  assert.equal(successfulTatumEnergyCall.headers['x-api-key'], 'server-only-tatum-test-key')
  assert.equal(JSON.stringify(result).includes('server-only-trongrid-test-key'), false)
  assert.equal(JSON.stringify(result).includes('server-only-tatum-test-key'), false)
})


test('sponsor resource reader retries an incomplete JSON response through the alternate provider', async () => {
  const calls = []
  const reader = createSponsorResourceReader({
    env: {
      TRONGRID_API_KEY: 'server-only-trongrid-test-key',
      TATUM_API_KEY: 'server-only-tatum-test-key',
      SPONSOR_NILE_ADDRESS: sponsorAddress,
    },
    tronWebFactory,
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body)
      calls.push({ url, body })
      if (url.startsWith('https://nile.trongrid.io')
        && url.endsWith('/wallet/getaccountresource')) {
        return { ok: true, status: 200, json: async () => ({ result: true }) }
      }
      const payload = url.endsWith('/wallet/getaccountresource')
        ? { EnergyLimit: 1000, EnergyUsed: 200, NetLimit: 400, NetUsed: 50, freeNetLimit: 100, freeNetUsed: 10 }
        : { max_size: body.type === 1 ? '5000000' : '7000000' }
      return { ok: true, status: 200, json: async () => payload }
    },
  })

  const result = await reader('nile', { refresh: true })
  assert.equal(result.success, true)
  assert.equal(result.resourceRead, true)
  assert.match(result.source, /TRONGrid and Tatum/)
  assert.equal(result.resources.currentlyAvailableEnergy, '800')
  assert.equal(result.canSubmitSponsoredTransfer, false)
  assert.equal(result.delegationEnabled, false)
  assert.ok(calls.some(({ url }) =>
    url.startsWith('https://nile.trongrid.io') && url.endsWith('/wallet/getaccountresource')))
  assert.ok(calls.some(({ url }) =>
    url.startsWith('https://tron-nile.gateway.tatum.io') && url.endsWith('/wallet/getaccountresource')))
  assert.equal(JSON.stringify(result).includes('server-only-trongrid-test-key'), false)
  assert.equal(JSON.stringify(result).includes('server-only-tatum-test-key'), false)
})
