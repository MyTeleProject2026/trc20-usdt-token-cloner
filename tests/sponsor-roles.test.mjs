import test from 'node:test'
import assert from 'node:assert/strict'
import { createSponsorRoleFundingReader } from '../server/sponsor-roles.mjs'

const feeAddress = 'T' + 'A'.repeat(33)
const assetAddress = 'T' + 'C'.repeat(33)
const tokenAddress = 'T' + 'B'.repeat(33)
const markerFor = (value) => value === feeAddress ? 'a'.repeat(40)
  : value === assetAddress ? 'c'.repeat(40)
    : value === tokenAddress ? 'b'.repeat(40)
      : 'd'.repeat(40)

function fakeTronWeb(host) {
  assert.match(host, /^https:\/\/tron-(mainnet|shasta|nile)\.gateway\.tatum\.io$/)
  return {
    isAddress(value) { return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(value) },
    address: { toHex(value) { return '41' + markerFor(value) } },
  }
}

test('independent sponsor roles fail closed when their separate addresses are not configured', async () => {
  let providerCalls = 0
  const readRoles = createSponsorRoleFundingReader({
    env: {},
    fetchImpl: async () => { providerCalls += 1; throw new Error('must not call provider without a sponsor address') },
    tronWebFactory: async () => fakeTronWeb('https://tron-nile.gateway.tatum.io'),
  })
  const result = await readRoles('nile')
  assert.equal(result.success, true)
  assert.equal(result.status, 'read-only-sponsor-roles')
  assert.equal(result.accountsConfigured, false)
  assert.equal(result.configuredAddressesDistinct, false)
  assert.equal(result.roles.networkFeeSponsor.status, 'sponsor-address-not-configured')
  assert.equal(result.roles.networkFeeSponsor.addressConfigured, false)
  assert.deepEqual(result.roles.networkFeeSponsor.requiredEnvironment, ['SPONSOR_FEE_NILE_ADDRESS'])
  assert.equal(result.roles.assetPrincipalSponsor.status, 'sponsor-address-not-configured')
  assert.deepEqual(result.roles.assetPrincipalSponsor.requiredEnvironment, ['SPONSOR_ASSET_NILE_ADDRESS'])
  assert.equal(result.canSubmitSponsoredTransfer, false)
  assert.equal(result.submissionEnabled, false)
  assert.equal(providerCalls, 0)
})

test('fee sponsor resources and asset sponsor balances are read independently without authorizing transfers', async () => {
  const calls = []
  const env = {
    TATUM_API_KEY: 'server-only-test-key',
    SPONSOR_FEE_NILE_ADDRESS: feeAddress,
    SPONSOR_ASSET_NILE_ADDRESS: assetAddress,
    SPONSOR_VTRC_NILE_CONTRACTS: tokenAddress,
  }
  const readRoles = createSponsorRoleFundingReader({
    env,
    tronWebFactory: async (host) => fakeTronWeb(host),
    fetchImpl: async (url, options) => {
      calls.push({ url, options })
      const body = JSON.parse(options.body || '{}')
      if (url.endsWith('/walletsolidity/getaccount')) {
        return { ok: true, json: async () => ({ address: body.address, balance: body.address === '41' + 'a'.repeat(40) ? '1500000' : '4200000' }) }
      }
      if (url.endsWith('/walletsolidity/triggerconstantcontract')) {
        const decimals = body.function_selector === 'decimals()'
        const value = decimals ? 18n : 987654321n
        return { ok: true, json: async () => ({ result: { result: true }, constant_result: [value.toString(16).padStart(64, '0')] }) }
      }
      if (url.endsWith('/walletsolidity/getaccountresource')) {
        return { ok: true, json: async () => ({ EnergyLimit: '1000', EnergyUsed: '200', NetLimit: '400', NetUsed: '50', freeNetLimit: '100', freeNetUsed: '10' }) }
      }
      if (url.endsWith('/walletsolidity/getcandelegatedmaxsize')) {
        return { ok: true, json: async () => ({ max_size: '5000000' }) }
      }
      throw new Error('unexpected provider endpoint')
    },
  })

  const result = await readRoles('nile')
  assert.equal(result.success, true)
  assert.equal(result.accountsConfigured, true)
  assert.equal(result.configuredAddressesDistinct, true)

  const fee = result.roles.networkFeeSponsor
  assert.equal(fee.role, 'network-fee-sponsor')
  assert.equal(fee.addressConfigured, true)
  assert.equal(fee.onChainBalanceRead, true)
  assert.equal(fee.native.balanceTRX, '1.5')
  assert.equal(fee.resourceStatus.resourceRead, true)
  assert.equal(fee.resourceStatus.currentlyAvailableEnergy, '800')
  assert.equal(fee.sponsorFundingVerified, false)
  assert.equal(fee.canSubmitSponsoredTransfer, false)

  const asset = result.roles.assetPrincipalSponsor
  assert.equal(asset.role, 'asset-principal-sponsor')
  assert.equal(asset.addressConfigured, true)
  assert.equal(asset.onChainBalanceRead, true)
  assert.equal(asset.native.balanceTRX, '4.2')
  assert.equal(asset.tokens.length, 1)
  assert.equal(asset.tokens[0].asset, 'VTRC')
  assert.equal(asset.tokens[0].status, 'verified')
  assert.equal(asset.tokens[0].balanceBaseUnits, '987654321')
  assert.equal(asset.sponsorFundingVerified, false)
  assert.equal(asset.canSubmitSponsoredTransfer, false)

  assert.equal(result.canSubmitSponsoredTransfer, false)
  assert.equal(result.submissionEnabled, false)
  assert.ok(calls.every(({ url }) => url.startsWith('https://tron-nile.gateway.tatum.io/')))
  assert.ok(calls.every(({ options }) => options.headers?.['x-api-key'] === 'server-only-test-key'))
  assert.equal(JSON.stringify(result).includes('server-only-test-key'), false)
})

test('the endpoint marks identical fee and asset addresses as not distinct', async () => {
  const env = { SPONSOR_FEE_SHASTA_ADDRESS: feeAddress, SPONSOR_ASSET_SHASTA_ADDRESS: feeAddress }
  const readRoles = createSponsorRoleFundingReader({ env, fetchImpl: async () => { throw new Error('must not call without Tatum API key') } })
  const result = await readRoles('shasta')
  assert.equal(result.accountsConfigured, true)
  assert.equal(result.configuredAddressesDistinct, false)
  assert.equal(result.roles.networkFeeSponsor.onChainBalanceRead, false)
  assert.equal(result.roles.assetPrincipalSponsor.onChainBalanceRead, false)
  assert.equal(result.submissionEnabled, false)
})

test('invalid networks are rejected without querying any provider', async () => {
  let providerCalls = 0
  const readRoles = createSponsorRoleFundingReader({ env: {}, fetchImpl: async () => { providerCalls += 1; throw new Error('must not call') } })
  const result = await readRoles('sideways')
  assert.equal(result.success, false)
  assert.equal(result.status, 'invalid-network')
  assert.equal(providerCalls, 0)
})
