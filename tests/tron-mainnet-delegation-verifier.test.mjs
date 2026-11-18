import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createTronMainnetDelegationVerifier } from '../server/providers/tron-mainnet-delegation-verifier.mjs'

const owner = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const delegator = 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8'
const txid = 'b'.repeat(64)
const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function addressHex(address) {
  let n = 0n
  for (const char of address) n = n * 58n + BigInt(alphabet.indexOf(char))
  let hex = n.toString(16)
  if (hex.length % 2) hex = '0' + hex
  let payload = Buffer.from(hex, 'hex')
  let zeros = 0
  while (zeros < address.length && address[zeros] === '1') zeros++
  if (zeros) payload = Buffer.concat([Buffer.alloc(zeros), payload])
  const body = payload.subarray(0, 21)
  const checksum = createHash('sha256').update(createHash('sha256').update(body).digest()).digest().subarray(0, 4)
  assert.equal(checksum.equals(payload.subarray(21)), true)
  return body.toString('hex')
}

function response(body) {
  return { ok: true, async json() { return body } }
}

function createFetch({ receiptResult = 'SUCCESS', receiver = addressHex(owner), resource = 'ENERGY', contracts, resourceState = {} } = {}) {
  const calls = []
  const defaultContracts = [{ type: 'DelegateResourceContract', parameter: { value: {
    owner_address: addressHex(delegator), receiver_address: receiver, resource, balance: 1000000,
  } } }]
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push({ path: url.split('/').pop(), body })
    if (url.endsWith('/walletsolidity/gettransactionbyid')) return response({
      txID: txid, raw_data: { contract: contracts || defaultContracts },
    })
    if (url.endsWith('/walletsolidity/gettransactioninfobyid')) return response({
      id: txid, blockNumber: 123456, receipt: { result: receiptResult },
    })
    if (url.endsWith('/walletsolidity/getdelegatedresourcev2')) return response({
      delegatedResource: [{ from: delegator, to: owner, frozen_balance_for_energy: '1000000', frozen_balance_for_bandwidth: '1000000' }],
    })
    if (url.endsWith('/walletsolidity/getaccountresource')) return response({
      EnergyLimit: '1000000', EnergyUsed: '100000',
      NetLimit: '1000', NetUsed: '100',
      freeNetLimit: '600', freeNetUsed: '100', ...resourceState,
    })
    throw new Error('unexpected endpoint')
  }
  return { fetchImpl, calls }
}

test('verifies provider delegation against solidified transaction, receipt, delegation record and live resources', async () => {
  const { fetchImpl, calls } = createFetch()
  const verifier = createTronMainnetDelegationVerifier({ fetchImpl })
  const result = await verifier.verifyDelegation({
    ownerAddress: owner, transactionId: txid,
    required: { ENERGY: '900000', BANDWIDTH: '1400' }, network: 'mainnet',
  })
  assert.equal(result.verified, false)
  assert.equal(result.solidified, true)
  assert.equal(result.delegatorAddress, delegator)
  assert.equal(result.ENERGY, '900000')
  assert.equal(result.BANDWIDTH, '900')
  assert.equal(result.verified, false)
  assert.equal(result.status, 'solidified-delegation-found-resources-insufficient')
  assert.equal(result.blockNumber, 123456)
  assert.deepEqual(calls.map((call) => call.path), [
    'gettransactionbyid', 'gettransactioninfobyid', 'getdelegatedresourcev2', 'getaccountresource',
  ])
})

test('rejects a delegation receipt that is not successful', async () => {
  const { fetchImpl } = createFetch({ receiptResult: 'FAILED' })
  const verifier = createTronMainnetDelegationVerifier({ fetchImpl })
  const result = await verifier.verifyDelegation({
    ownerAddress: owner, transactionId: txid, required: { ENERGY: '1', BANDWIDTH: '1' },
  })
  assert.equal(result.verified, false)
  assert.equal(result.solidified, false)
  assert.equal(result.status, 'solidified-transaction-or-receipt-not-successful')
})

test('rejects a solidified delegation transaction sent to a different recipient', async () => {
  const { fetchImpl } = createFetch({ receiver: addressHex(delegator) })
  const verifier = createTronMainnetDelegationVerifier({ fetchImpl })
  const result = await verifier.verifyDelegation({
    ownerAddress: owner, transactionId: txid, required: { ENERGY: '1', BANDWIDTH: '1' },
  })
  assert.equal(result.verified, false)
  assert.equal(result.status, 'delegation-recipient-or-owner-mismatch')
})

test('does not report sufficient resources when aggregate Mainnet coverage is short', async () => {
  const { fetchImpl } = createFetch()
  const verifier = createTronMainnetDelegationVerifier({
    fetchImpl: async (url, init) => {
      if (url.endsWith('/walletsolidity/getaccountresource')) return response({
        EnergyLimit: '100', EnergyUsed: '50', NetLimit: '10', NetUsed: '10',
        freeNetLimit: '10', freeNetUsed: '10',
      })
      return fetchImpl(url, init)
    },
  })
  const result = await verifier.verifyDelegation({
    ownerAddress: owner, transactionId: txid, required: { ENERGY: '100', BANDWIDTH: '1' },
  })
  assert.equal(result.verified, false)
  assert.equal(result.solidified, true)
  assert.equal(result.status, 'solidified-delegation-found-resources-insufficient')
})

test('rejects malformed transaction IDs without making Mainnet requests', async () => {
  let calls = 0
  const verifier = createTronMainnetDelegationVerifier({
    fetchImpl: async () => { calls++; throw new Error('must-not-call') },
  })
  const result = await verifier.verifyDelegation({
    ownerAddress: owner, transactionId: 'not-a-transaction-id',
    required: { ENERGY: '1', BANDWIDTH: '1' },
  })
  assert.equal(result.verified, false)
  assert.equal(result.status, 'invalid-verification-request')
  assert.equal(calls, 0)
})

test('verifies Energy and Bandwidth delegated by separate contracts in one solidified transaction', async () => {
  const contracts = ['ENERGY', 'BANDWIDTH'].map((resource) => ({
    type: 'DelegateResourceContract',
    parameter: { value: { owner_address: addressHex(delegator), receiver_address: addressHex(owner), resource, balance: 1000000 } },
  }))
  const { fetchImpl } = createFetch({ contracts })
  const verifier = createTronMainnetDelegationVerifier({ fetchImpl })
  const result = await verifier.verifyDelegation({
    ownerAddress: owner, transactionId: txid,
    required: { ENERGY: '800000', BANDWIDTH: '800' },
  })
  assert.equal(result.verified, true)
  assert.equal(result.ENERGY, '900000')
  assert.equal(result.BANDWIDTH, '900')
})

test('does not add free and staked Bandwidth pools to cover one transaction', async () => {
  const { fetchImpl } = createFetch({ resourceState: {
    NetLimit: '600', NetUsed: '0', freeNetLimit: '600', freeNetUsed: '0',
  } })
  const verifier = createTronMainnetDelegationVerifier({ fetchImpl })
  const result = await verifier.verifyDelegation({
    ownerAddress: owner, transactionId: txid,
    required: { ENERGY: '1', BANDWIDTH: '1000' },
  })
  assert.equal(result.verified, false)
  assert.equal(result.BANDWIDTH, '600')
  assert.equal(result.status, 'solidified-delegation-found-resources-insufficient')
})

test('rejects mixed non-delegation operations in a purported resource delegation transaction', async () => {
  const { fetchImpl } = createFetch({ contracts: [
    { type: 'DelegateResourceContract', parameter: { value: {
      owner_address: addressHex(delegator), receiver_address: addressHex(owner), resource: 'ENERGY', balance: 1000000,
    } } },
    { type: 'TransferContract', parameter: { value: {} } },
  ] })
  const verifier = createTronMainnetDelegationVerifier({ fetchImpl })
  const result = await verifier.verifyDelegation({
    ownerAddress: owner, transactionId: txid, required: { ENERGY: '1', BANDWIDTH: '0' },
  })
  assert.equal(result.verified, false)
  assert.equal(result.status, 'not-a-resource-delegation-transaction')
})
