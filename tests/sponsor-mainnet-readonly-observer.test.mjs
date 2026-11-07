import test from 'node:test'
import assert from 'node:assert/strict'
import {
  readAuthenticatedTronMainnetSponsorObservation,
} from '../server/sponsor-mainnet-readonly-observer.mjs'

const address = 'TKbcs8dYuaZT1VdtrKxnVswNg3DKjSs7u2'
const apiKey = 'test-tatum-mainnet-api-key-123'
const now = 1_800_000_000_000

function payloadFor(path) {
  if (path.endsWith('/walletsolidity/getnowblock')) return {
    blockID: 'a'.repeat(64),
    block_header: { raw_data: { number: 99_001_234, timestamp: now - 1000 } },
  }
  if (path.endsWith('/walletsolidity/getaccount')) return { address, balance: '9000000' }
  if (path.endsWith('/wallet/getaccountresource')) return {
    freeNetLimit: 1500, freeNetUsed: 200, NetLimit: 1200, NetUsed: 300,
    EnergyLimit: 5000, EnergyUsed: 1000,
  }
  if (path.endsWith('/walletsolidity/triggerconstantcontract')) {
    return { constant_result: ['00000000000000000000000000000000000000000000000000000000ee6b2800'] }
  }
  throw new Error('unexpected endpoint')
}

function mockFetch(calls, { status = 200, malformedPath = '' } = {}) {
  return async (url, init) => {
    const parsed = new URL(url)
    calls.push({ url: parsed.toString(), path: parsed.pathname, init })
    if (parsed.origin !== 'https://tron-mainnet.gateway.tatum.io') throw new Error('unapproved origin')
    if (malformedPath && parsed.pathname.endsWith(malformedPath)) {
      return { ok: true, json: async () => ({ unexpected: true }) }
    }
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payloadFor(parsed.pathname),
    }
  }
}

test('reads solidified Mainnet USDT/TRX and resource observations through authenticated Tatum RPC only', async () => {
  const calls = []
  const result = await readAuthenticatedTronMainnetSponsorObservation({
    sponsorAddress: address,
    env: { TATUM_MAINNET_API_KEY: apiKey },
    fetchImpl: mockFetch(calls),
    now: () => now,
  })
  assert.equal(calls.length, 4)
  assert.equal(result.source, 'tron-mainnet-readonly-rpc')
  assert.equal(result.network, 'TRON_MAINNET')
  assert.equal(result.finality, 'solidified')
  assert.equal(result.sponsorAddress, address)
  assert.equal(result.accountExists, true)
  assert.equal(result.blockNumber, 99_001_234)
  assert.equal(result.usdtContract, 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t')
  assert.equal(result.usdtDecimals, 6)
  assert.equal(result.usdtBalanceBaseUnits, '4000000000')
  assert.equal(result.trxBalanceSun, '9000000')
  assert.equal(result.resources.freeNetLimit, '1500')
  assert.equal(result.resources.energyLimit, '5000')
  assert.equal(result.sourceCryptographicallyAttested, false)
  assert.equal(result.limitations.payoutAuthorized, false)
  for (const call of calls) {
    assert.equal(call.init.method, 'POST')
    assert.equal(call.init.redirect, 'error')
    assert.equal(call.init.headers['x-api-key'], apiKey)
    assert.equal(call.url.includes(apiKey), false)
  }
})

test('prefers the network-scoped Mainnet key and falls back only to the existing Tatum key', async () => {
  const calls = []
  await readAuthenticatedTronMainnetSponsorObservation({
    sponsorAddress: address,
    env: { TATUM_MAINNET_API_KEY: apiKey, TATUM_API_KEY: 'general-tatum-api-key-456' },
    fetchImpl: mockFetch(calls),
    now: () => now,
  })
  assert.ok(calls.every((call) => call.init.headers['x-api-key'] === apiKey))
  const fallbackCalls = []
  await readAuthenticatedTronMainnetSponsorObservation({
    sponsorAddress: address,
    env: { TATUM_API_KEY: 'general-tatum-api-key-456' },
    fetchImpl: mockFetch(fallbackCalls),
    now: () => now,
  })
  assert.ok(fallbackCalls.every((call) => call.init.headers['x-api-key'] === 'general-tatum-api-key-456'))
})

test('does not issue requests when credentials or a valid sponsor address are absent', async () => {
  let calls = 0
  const fetchImpl = async () => { calls += 1; throw new Error('must not call') }
  await assert.rejects(
    readAuthenticatedTronMainnetSponsorObservation({ sponsorAddress: address, env: {}, fetchImpl, now: () => now }),
    (error) => error.code === 'TATUM_MAINNET_CREDENTIAL_MISSING',
  )
  await assert.rejects(
    readAuthenticatedTronMainnetSponsorObservation({
      sponsorAddress: 'not-an-address', env: { TATUM_API_KEY: apiKey }, fetchImpl, now: () => now,
    }),
    (error) => error.code === 'SPONSOR_ADDRESS_INVALID',
  )
  assert.equal(calls, 0)
})

test('fails closed on provider errors, malformed block, account mismatch and malformed resource readings', async () => {
  await assert.rejects(
    readAuthenticatedTronMainnetSponsorObservation({
      sponsorAddress: address, env: { TATUM_API_KEY: apiKey },
      fetchImpl: mockFetch([], { status: 401 }), now: () => now,
    }),
    (error) => error.code === 'TATUM_MAINNET_READ_FAILED',
  )
  const badBlock = async (url) => ({
    ok: true,
    json: async () => new URL(url).pathname.endsWith('/walletsolidity/getnowblock')
      ? { blockID: 'bad', block_header: { raw_data: { number: 0 } } }
      : payloadFor(new URL(url).pathname),
  })
  await assert.rejects(
    readAuthenticatedTronMainnetSponsorObservation({
      sponsorAddress: address, env: { TATUM_API_KEY: apiKey }, fetchImpl: badBlock, now: () => now,
    }),
    (error) => error.code === 'TRON_SOLIDIFIED_BLOCK_METADATA_INVALID',
  )
  const badAccount = async (url) => ({
    ok: true,
    json: async () => new URL(url).pathname.endsWith('/walletsolidity/getaccount')
      ? { address: 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp', balance: '1' }
      : payloadFor(new URL(url).pathname),
  })
  await assert.rejects(
    readAuthenticatedTronMainnetSponsorObservation({
      sponsorAddress: address, env: { TATUM_API_KEY: apiKey }, fetchImpl: badAccount, now: () => now,
    }),
    (error) => error.code === 'TRON_SPONSOR_ACCOUNT_NOT_CONFIRMED',
  )
  const badResources = async (url) => ({
    ok: true,
    json: async () => new URL(url).pathname.endsWith('/wallet/getaccountresource')
      ? { EnergyLimit: 'NaN' }
      : payloadFor(new URL(url).pathname),
  })
  await assert.rejects(
    readAuthenticatedTronMainnetSponsorObservation({
      sponsorAddress: address, env: { TATUM_API_KEY: apiKey }, fetchImpl: badResources, now: () => now,
    }),
    (error) => error.code === 'TRON_FREE_BANDWIDTH_INVALID',
  )
})

test('observation never claims custody, legal authority, signer approval or payout authorization', async () => {
  const result = await readAuthenticatedTronMainnetSponsorObservation({
    sponsorAddress: address,
    env: { TATUM_API_KEY: apiKey },
    fetchImpl: mockFetch([]),
    now: () => now,
  })
  for (const field of [
    'custodyProviderObserved', 'sponsorLegalAuthorityVerified', 'walletControlVerified',
    'providerSignerAuthorityVerified', 'providerResponseCryptographicallyAttested',
    'payoutAuthorized', 'signerProviderContacted', 'signingRequestCreated',
    'transactionSigned', 'broadcastAttempted', 'mainnetExecutionEnabled',
  ]) assert.equal(result.limitations[field], false, field)
})
