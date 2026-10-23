import test from 'node:test'
import assert from 'node:assert/strict'
import { createSponsorResourceDelegationVerifier } from '../server/sponsor-resource-delegation-verifier.mjs'

const sponsorAddress = 'T' + 'A'.repeat(33)
const receiverAddress = 'T' + 'B'.repeat(33)
const txId = 'a'.repeat(64)
const sponsorHex = '41' + 'a'.repeat(40)
const receiverHex = '41' + 'b'.repeat(40)

function fakeTronWeb(host) {
  assert.equal(host, 'https://tron-shasta.gateway.tatum.io')
  return {
    isAddress: (value) => value === sponsorAddress || value === receiverAddress,
    address: {
      toHex: (value) => value === sponsorAddress ? sponsorHex
        : value === receiverAddress ? receiverHex : String(value).toLowerCase(),
      fromHex: (value) => value.toLowerCase() === sponsorHex ? sponsorAddress
        : value.toLowerCase() === receiverHex ? receiverAddress : '',
    },
  }
}

function mockFetch({ transactionOverrides = {}, info = { blockNumber: 100, result: 'SUCCESS' }, delegation = {
  from: sponsorHex, to: receiverHex, frozen_balance_for_energy: '10000000',
} } = {}) {
  const requests = []
  const transaction = {
    txID: txId,
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
