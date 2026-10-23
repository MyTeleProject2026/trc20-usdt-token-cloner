import test from 'node:test'
import assert from 'node:assert/strict'
import { createSponsorFundingReader } from '../server/sponsor-funding.mjs'

const sponsorAddress = 'T' + 'A'.repeat(33)
const tokenAddress = 'T' + 'B'.repeat(33)
const hex = 'a'.repeat(40)

function fakeTronWeb(host) {
  assert.match(host, /^https:\/\/tron-(mainnet|shasta|nile)\.gateway\.tatum\.io$/)
  return {
    isAddress(value) { return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(value) },
    address: { toHex(value) { return '41' + (value === sponsorAddress ? hex : 'b'.repeat(40)) } },
  }
}

test('sponsor funding read is fail-closed when no network-specific address is configured', async () => {
  const reader = createSponsorFundingReader({ env: {}, fetchImpl: async () => { throw new Error('must not call') } })
  const result = await reader('nile')
  assert.equal(result.status, 'sponsor-address-not-configured')
  assert.deepEqual(result.requiredEnvironment, ['SPONSOR_NILE_ADDRESS'])
  assert.equal(result.onChainBalanceRead, false)
  assert.equal(result.canSubmitSponsoredTransfer, false)
})

test('sponsor funding read requires server-side Tatum credentials', async () => {
  const reader = createSponsorFundingReader({
    env: { SPONSOR_NILE_ADDRESS: sponsorAddress },
    fetchImpl: async () => { throw new Error('must not call') },
  })
  const result = await reader('nile')
  assert.equal(result.status, 'provider-credentials-missing')
  assert.deepEqual(result.requiredEnvironment, ['TATUM_API_KEY'])
  assert.equal(result.sponsorFundingVerified, false)
})

test('sponsor funding status verifies native TRX and configured token balances without enabling transfer submission', async () => {
  const requests = []
  const env = {
    TATUM_API_KEY: 'server-test-key',
    SPONSOR_NILE_ADDRESS: sponsorAddress,
    SPONSOR_USDT_NILE_CONTRACTS: tokenAddress,
  }
  const reader = createSponsorFundingReader({
    env,
    tronWebFactory: async (host) => fakeTronWeb(host),
    fetchImpl: async (url, options) => {
      requests.push({ url, options })
      if (url.endsWith('/walletsolidity/getaccount')) {
        return { ok: true, json: async () => ({ address: '41' + hex, balance: 1234567 }) }
      }
      if (url.endsWith('/walletsolidity/triggerconstantcontract')) {
        const body = JSON.parse(options.body)
        const isDecimals = body.function_selector === 'decimals()'
        return { ok: true, json: async () => ({ result: { result: true }, constant_result: [(isDecimals ? 6n : 2500000n).toString(16).padStart(64, '0')] }) }
      }
      throw new Error('unexpected URL')
    },
  })
  const result = await reader('nile')
  assert.equal(result.status, 'solidified-sponsor-balances-read')
  assert.equal(result.native.balanceSun, '1234567')
  assert.equal(result.native.balanceTRX, '1.234567')
  assert.equal(result.tokens.length, 1)
  assert.equal(result.tokens[0].asset, 'USDT (testnet)')
  assert.equal(result.tokens[0].balanceBaseUnits, '2500000')
  assert.equal(result.tokens[0].decimals, 6)
  assert.equal(result.tokenBalancesComplete, true)
  assert.equal(result.sponsorFundingVerified, false)
  assert.equal(result.canSubmitSponsoredTransfer, false)
  assert.equal(result.submissionEnabled, false)
  assert.ok(requests.every(({ options }) => options.headers['x-api-key'] === 'server-test-key'))
  assert.equal(JSON.stringify(result).includes('server-test-key'), false)
  assert.ok(requests.every(({ url }) => url.startsWith('https://tron-nile.gateway.tatum.io/')))
})

test('sponsor funding read rejects invalid networks and malformed allowlists without reporting tokens', async () => {
  const reader = createSponsorFundingReader({
    env: {
      TATUM_API_KEY: 'server-test-key',
      SPONSOR_NILE_ADDRESS: sponsorAddress,
      SPONSOR_VTRC_NILE_CONTRACTS: 'not-an-address',
    },
    tronWebFactory: async (host) => fakeTronWeb(host),
    fetchImpl: async () => ({ ok: true, json: async () => ({ address: '41' + hex, balance: 0 }) }),
  })
  assert.equal((await reader('shasta')).status, 'sponsor-address-not-configured')
  const invalidNetwork = await reader('attacker')
  assert.equal(invalidNetwork.status, 'invalid-network')
  const malformed = await reader('nile')
  assert.equal(malformed.status, 'invalid-token-contract-allowlist')
  assert.equal(malformed.sponsorFundingVerified, false)
  assert.equal(malformed.canSubmitSponsoredTransfer, false)
})

test('sponsor funding read does not treat a failed token query as a zero balance', async () => {
  const reader = createSponsorFundingReader({
    env: { TATUM_API_KEY: 'server-test-key', SPONSOR_NILE_ADDRESS: sponsorAddress, SPONSOR_USDT_NILE_CONTRACTS: tokenAddress },
    tronWebFactory: async (host) => fakeTronWeb(host),
    fetchImpl: async (url) => {
      if (url.endsWith('/walletsolidity/getaccount')) return { ok: true, json: async () => ({ address: '41' + hex, balance: 0 }) }
      return { ok: false, status: 503 }
    },
  })
  const result = await reader('nile')
  assert.equal(result.native.balanceSun, '0')
  assert.equal(result.tokens[0].status, 'unavailable')
  assert.equal(Object.hasOwn(result.tokens[0], 'balanceBaseUnits'), false)
  assert.equal(result.tokenBalancesComplete, false)
})


test('sponsor funding reader rejects a native balance response for a different sponsor address', async () => {
  const reader = createSponsorFundingReader({
    env: { TATUM_API_KEY: 'server-test-key', SPONSOR_NILE_ADDRESS: sponsorAddress },
    tronWebFactory: async (host) => fakeTronWeb(host),
    fetchImpl: async (url) => {
      assert.ok(url.endsWith('/walletsolidity/getaccount'))
      return { ok: true, json: async () => ({ address: '41' + 'c'.repeat(40), balance: '999999999' }) }
    },
  })
  const result = await reader('nile')
  assert.equal(result.status, 'solidified-balance-read-failed')
  assert.equal(result.onChainBalanceRead, false)
  assert.equal(Object.hasOwn(result, 'native'), false)
  assert.equal(result.canSubmitSponsoredTransfer, false)
})

test('sponsorship funding HTTP route is read-only and reports missing sponsor address without querying a provider', async () => {
  const nativeTronRoutes = (await import('../server/routes/native-tron.mjs')).default
  const layer = nativeTronRoutes.stack.find((item) =>
    item.route?.path === '/sponsorship/funding-status' && item.route.methods?.get,
  )
  assert.ok(layer, 'GET /sponsorship/funding-status route must be registered')

  const savedAddress = process.env.SPONSOR_NILE_ADDRESS
  const savedKey = process.env.TATUM_API_KEY
  delete process.env.SPONSOR_NILE_ADDRESS
  delete process.env.TATUM_API_KEY
  try {
    let statusCode = 200
    let responseBody
    const response = {
      status(code) { statusCode = code; return this },
      json(body) { responseBody = body; return this },
    }
    await layer.route.stack[0].handle({ query: { network: 'nile' } }, response)
    assert.equal(statusCode, 503)
    assert.equal(responseBody.success, false)
    assert.equal(responseBody.funding.status, 'sponsor-address-not-configured')
    assert.equal(responseBody.funding.onChainBalanceRead, false)
    assert.equal(responseBody.funding.canSubmitSponsoredTransfer, false)
    assert.ok(responseBody.limitations.some((item) => item.includes('never is signed') || item.includes('never signed') || item.includes('No transfer is signed')))
  } finally {
    if (savedAddress === undefined) delete process.env.SPONSOR_NILE_ADDRESS
    else process.env.SPONSOR_NILE_ADDRESS = savedAddress
    if (savedKey === undefined) delete process.env.TATUM_API_KEY
    else process.env.TATUM_API_KEY = savedKey
  }
})
