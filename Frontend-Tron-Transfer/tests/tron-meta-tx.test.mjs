import test from 'node:test'
import assert from 'node:assert/strict'
import { createTronMetaTypedData, signTronMetaTypedData, TRON_MAINNET_CHAIN_ID } from '../src/tron-meta-tx.mjs'

const OWNER = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const FORWARDER = 'TKmwZgALZPatKVJpcAx93XVNu6DiaauPFk'
const TARGET = 'TKmwZgALZPatKVJpcAx93XVNu6DiaauPFk'
const tronWeb = { isAddress: (value) => [OWNER, FORWARDER, TARGET].includes(value) }

test('builds exact Mainnet ForwardRequest typed data matching the Solidity schema', () => {
  const result = createTronMetaTypedData({
    tronWeb, from: OWNER, forwarder: FORWARDER, to: TARGET,
    data: '0x12345678', nonce: 7, deadline: 1900, gasLimit: 90000,
    nowSeconds: 1000,
  })
  assert.equal(result.typedData.domain.chainId, TRON_MAINNET_CHAIN_ID)
  assert.equal(result.typedData.domain.verifyingContract, FORWARDER)
  assert.equal(result.typedData.primaryType, 'ForwardRequest')
  assert.deepEqual(result.typedData.types.ForwardRequest.map((x) => x.type), [
    'address','address','uint256','uint256','uint256','uint256','bytes',
  ])
  assert.equal(result.request.value, '0')
  assert.equal(result.request.data, '0x12345678')
})

test('rejects wrong network, bad addresses, malformed calldata, and excessive expiry', () => {
  const base = { tronWeb, from: OWNER, forwarder: FORWARDER, to: TARGET, data: '0x12345678', nonce: 0, deadline: 1100, nowSeconds: 1000 }
  assert.throws(() => createTronMetaTypedData({ ...base, chainId: 2494104990 }), /TRON Mainnet/)
  assert.throws(() => createTronMetaTypedData({ ...base, from: 'T123' }), /owner address/)
  assert.throws(() => createTronMetaTypedData({ ...base, data: '0xxyz' }), /Calldata/)
  assert.throws(() => createTronMetaTypedData({ ...base, deadline: 3000 }), /15 minutes/)
  assert.throws(() => createTronMetaTypedData({ ...base, deadline: 1000 }), /15 minutes/)
})

test('uses only TronLink TIP-712 signing and checks the active owner account', async () => {
  let called = false
  const wallet = {
    defaultAddress: { base58: OWNER },
    trx: { _signTypedData: async (_domain, _types, _message) => { called = true; return 'a'.repeat(130) } },
  }
  const { typedData } = createTronMetaTypedData({
    tronWeb, from: OWNER, forwarder: FORWARDER, to: TARGET,
    data: '0x12345678', nonce: 0, deadline: 1100, nowSeconds: 1000,
  })
  const signature = await signTronMetaTypedData({ tronWeb: wallet, expectedOwner: OWNER, typedData })
  assert.equal(called, true)
  assert.equal(signature, '0x' + 'a'.repeat(130))
  await assert.rejects(() => signTronMetaTypedData({ tronWeb: wallet, expectedOwner: TARGET, typedData }), /account changed/)
})

test('refuses insecure personal-sign fallback if TIP-712 is unavailable', async () => {
  const wallet = { defaultAddress: { base58: OWNER }, trx: {} }
  const { typedData } = createTronMetaTypedData({
    tronWeb, from: OWNER, forwarder: FORWARDER, to: TARGET,
    data: '0x12345678', nonce: 0, deadline: 1100, nowSeconds: 1000,
  })
  await assert.rejects(() => signTronMetaTypedData({ tronWeb: wallet, expectedOwner: OWNER, typedData }), /no fallback/)
})
