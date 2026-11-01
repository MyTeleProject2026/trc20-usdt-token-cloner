import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createSponsorResourceDelegationVerifier } from '../server/sponsor-resource-delegation-verifier.mjs'
import { isValidTronAddress } from '../server/tron-address.mjs'

const sponsorAddress = 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8'
const receiverAddress = 'TTGhREx2pDSxFX555NWz1YwGpiBVPvQA7e'
const rawDataHex = Buffer.from('delegate-resource-test-fixture').toString('hex')
const txId = createHash('sha256').update(Buffer.from(rawDataHex, 'hex')).digest('hex')
const sponsorHex = '41' + 'a'.repeat(40)
const receiverHex = '41' + 'b'.repeat(40)

function fakeTronWeb(host) {
  assert.equal(host, 'https://tron-shasta.gateway.tatum.io')
  return {
    isAddress: (value) => isValidTronAddress(value),
    address: {
      toHex: (value) => value === sponsorAddress ? sponsorHex
        : value === receiverAddress ? receiverHex : String(value).toLowerCase(),
      fromHex: (value) => value.toLowerCase() === sponsorHex ? sponsorAddress
        : value.toLowerCase() === receiverHex ? receiverAddress : '',
    },
  }
}

function mockFetch({ transactionOverrides = {}, info = { id: txId, blockNumber: 100, result: 'SUCCESS' }, delegation = {
  from: sponsorHex, to: receiverHex,
  frozen_balance_for_energy: '10000000',
  expire_time_for_energy: 0,
} } = {}) {
  const requests = []
  const transaction = {
    txID: txId,
    raw_data_hex: rawDataHex,
    ret: [{ contractRet: 'SUCCESS' }],
    raw_data: { contract: [{
      type: 'DelegateResourceContract',
      parameter: { value: {
        owner_address: sponsorHex,
        receiver_address: receiverHex,
        resource: 1,
        balance: 10000000,
        lock: false,
      } },
    }] },
    ...transactionOverrides,
  }
  const fetchImpl = async (url, options) => {
    requests.push({ url, options })
    let body
    if (url.endsWith('/walletsolidity/gettransactionbyid')) body = transaction
    else if (url.endsWith('/walletsolidity/gettransactioninfobyid')) body = info
    else if (url.endsWith('/walletsolidity/getdelegatedresourcev2')) body = delegation
    else throw new Error('unexpected endpoint')
    return { ok: true, json: async () => body }
  }
  return { fetchImpl, requests }
}

test('resource delegation verifier requires credentials and never calls a provider when missing', async () => {
  let calls = 0
  const verifier = createSponsorResourceDelegationVerifier({
    env: {},
    tronWebFactory: fakeTronWeb,
    fetchImpl: async () => { calls += 1; throw new Error('must not call') },
  })
  const result = await verifier({
    network: 'shasta', transactionId: txId, sponsorAddress, receiverAddress,
    resourceType: 'ENERGY', stakeEquivalentSun: '10000000',
  })
  assert.equal(result.status, 'provider-credentials-missing')
  assert.equal(result.verified, false)
  assert.equal(calls, 0)
})

test('resource delegation verifier requires exact solidified transaction and resulting delegation state', async () => {
  const { fetchImpl, requests } = mockFetch()
  const verifier = createSponsorResourceDelegationVerifier({
    env: { TATUM_API_KEY: 'server-only-test-key' },
    tronWebFactory: fakeTronWeb,
    fetchImpl,
  })
  const result = await verifier({
    network: 'shasta', transactionId: txId, sponsorAddress, receiverAddress,
    resourceType: 'ENERGY', stakeEquivalentSun: '10000000',
  })
  assert.equal(result.success, true)
  assert.equal(result.verified, true)
  assert.equal(result.status, 'solidified-resource-delegation-verified')
  assert.equal(result.blockNumber, 100)
  assert.equal(result.observedStakeEquivalentSun, '10000000')
  assert.equal(requests.length, 3)
  assert.ok(requests.every((request) => request.options.headers['x-api-key'] === 'server-only-test-key'))
  assert.equal(JSON.stringify(result).includes('server-only-test-key'), false)
  assert.ok(requests.every((request) => request.url.startsWith('https://tron-shasta.gateway.tatum.io/')))
})

test('resource delegation verifier rejects amount, receiver, resource, and execution mismatches', async (t) => {
  const cases = [
    { name: 'amount mismatch', input: { stakeEquivalentSun: '20000000' } },
    { name: 'resource mismatch', input: { resourceType: 'BANDWIDTH' } },
    { name: 'receiver mismatch', mock: { delegation: { from: sponsorHex, to: receiverHex, frozen_balance_for_bandwidth: '10000000' } }, input: { resourceType: 'ENERGY' } },
    { name: 'failed execution', mock: { info: { blockNumber: 100, result: 'FAILED' } } },
  ]
  for (const item of cases) {
    await t.test(item.name, async () => {
      const mocked = mockFetch(item.mock || {})
      const verifier = createSponsorResourceDelegationVerifier({
        env: { TATUM_API_KEY: 'server-only-test-key' },
        tronWebFactory: fakeTronWeb,
        fetchImpl: mocked.fetchImpl,
      })
      const result = await verifier({
        network: 'shasta', transactionId: txId, sponsorAddress, receiverAddress,
        resourceType: 'ENERGY', stakeEquivalentSun: '10000000', ...(item.input || {}),
      })
      assert.equal(result.verified, false)
    })
  }
})

test('resource delegation verifier does not mark absent solidified transactions as successful', async () => {
  const mocked = mockFetch({ transactionOverrides: { txID: '' }, info: {} })
  const verifier = createSponsorResourceDelegationVerifier({
    env: { TATUM_API_KEY: 'server-only-test-key' },
    tronWebFactory: fakeTronWeb,
    fetchImpl: mocked.fetchImpl,
  })
  const result = await verifier({
    network: 'shasta', transactionId: txId, sponsorAddress, receiverAddress,
    resourceType: 'ENERGY', stakeEquivalentSun: '10000000',
  })
  assert.equal(result.status, 'pending-solidification')
  assert.equal(result.verified, false)
})


test('resource delegation verifier rejects a transaction ID not derived from raw_data_hex or receipt identity', async (t) => {
  const cases = [
    { name: 'raw data hash mismatch', mock: { transactionOverrides: { raw_data_hex: 'deadbeef' } } },
    { name: 'receipt transaction ID mismatch', mock: { info: { id: 'f'.repeat(64), blockNumber: 100, result: 'SUCCESS' } } },
  ]
  for (const item of cases) {
    await t.test(item.name, async () => {
      const mocked = mockFetch(item.mock)
      const verifier = createSponsorResourceDelegationVerifier({
        env: { TATUM_API_KEY: 'server-only-test-key' },
        tronWebFactory: fakeTronWeb,
        fetchImpl: mocked.fetchImpl,
      })
      const result = await verifier({
        network: 'shasta', transactionId: txId, sponsorAddress, receiverAddress,
        resourceType: 'ENERGY', stakeEquivalentSun: '10000000',
      })
      assert.equal(result.verified, false)
      assert.equal(result.status, 'solidified-transaction-identity-mismatch')
    })
  }
})

test('resource delegation verifier rejects transactions containing multiple contracts', async () => {
  const mocked = mockFetch({
    transactionOverrides: {
      raw_data: { contract: [
        { type: 'DelegateResourceContract', parameter: { value: {
          owner_address: sponsorHex, receiver_address: receiverHex,
          resource: 1, balance: 10000000, lock: false,
        } } },
        { type: 'TransferContract', parameter: { value: {
          owner_address: sponsorHex, to_address: receiverHex, amount: 1,
        } } },
      ] },
    },
  })
  const verifier = createSponsorResourceDelegationVerifier({
    env: { TATUM_API_KEY: 'server-only-test-key' },
    tronWebFactory: fakeTronWeb,
    fetchImpl: mocked.fetchImpl,
  })
  const result = await verifier({
    network: 'shasta', transactionId: txId, sponsorAddress, receiverAddress,
    resourceType: 'ENERGY', stakeEquivalentSun: '10000000',
  })
  assert.equal(result.verified, false)
  assert.equal(result.status, 'solidified-transaction-mismatch')
})

test('resource delegation verifier does not count expired delegation as active', async () => {
  const mocked = mockFetch({
    delegation: {
      from: sponsorHex, to: receiverHex,
      frozen_balance_for_energy: '10000000',
      expire_time_for_energy: Date.now() - 1000,
    },
  })
  const verifier = createSponsorResourceDelegationVerifier({
    env: { TATUM_API_KEY: 'server-only-test-key' },
    tronWebFactory: fakeTronWeb,
    fetchImpl: mocked.fetchImpl,
  })
  const result = await verifier({
    network: 'shasta', transactionId: txId, sponsorAddress, receiverAddress,
    resourceType: 'ENERGY', stakeEquivalentSun: '10000000',
  })
  assert.equal(result.verified, false)
  assert.equal(result.status, 'delegation-state-not-yet-confirmed')
  assert.equal(result.observedStakeEquivalentSun, '0')
})

test('resource delegation verifier rejects a matching delegation row with missing expiry evidence', async () => {
  const mocked = mockFetch({
    delegation: {
      from: sponsorHex, to: receiverHex,
      frozen_balance_for_energy: '10000000',
    },
  })
  const verifier = createSponsorResourceDelegationVerifier({
    env: { TATUM_API_KEY: 'server-only-test-key' },
    tronWebFactory: fakeTronWeb,
    fetchImpl: mocked.fetchImpl,
  })
  const result = await verifier({
    network: 'shasta', transactionId: txId, sponsorAddress, receiverAddress,
    resourceType: 'ENERGY', stakeEquivalentSun: '10000000',
  })
  assert.equal(result.verified, false)
  assert.equal(result.status, 'delegation-state-unavailable')
  assert.equal(result.reason, 'delegation-resource-or-expiry-invalid')
})
