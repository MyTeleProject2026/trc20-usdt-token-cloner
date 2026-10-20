import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeVerificationNetwork, recordTransferVerification } from '../server/database.mjs'

test('refuses to persist a transfer when the network is missing or unsupported', async () => {
  for (const network of [undefined, null, '', 'TRON', 'ethereum', 'MAINNET']) {
    const input = {
      network,
      transactionHash: 'a'.repeat(64),
      tokenContract: 'contract',
      fromAddress: 'sender',
      toAddress: 'receiver',
      amountBaseUnits: '1',
      status: 'verified-on-chain',
      result: { blockNumber: 123 },
    }
    assert.deepEqual(
      await recordTransferVerification(input),
      { persisted: false, reason: 'invalid-network' },
      `network: ${String(network)}`,
    )
  }
})

test('refuses to infer a network when the input object is missing', async () => {
  assert.deepEqual(
    await recordTransferVerification(undefined),
    { persisted: false, reason: 'invalid-network' },
  )
})

test('accepts only explicit supported TRON network identifiers', () => {
  for (const network of ['mainnet', 'shasta', 'nile']) {
    assert.equal(normalizeVerificationNetwork(network), network)
  }
  for (const network of [undefined, null, '', 'TRON', 'ethereum', 'MAINNET', 1]) {
    assert.equal(normalizeVerificationNetwork(network), null, `network: ${String(network)}`)
  }
})

test('rejects malformed transfer identity and non-integer amounts before database access', async () => {
  const valid = {
    network: 'mainnet',
    transactionHash: 'a'.repeat(64),
    tokenContract: 'contract',
    fromAddress: 'sender',
    toAddress: 'receiver',
    amountBaseUnits: '1',
    status: 'verified-on-chain',
    result: { blockNumber: 123 },
  }
  const invalidCases = [
    { transactionHash: 'not-a-hash' },
    { transactionHash: 'a'.repeat(63) },
    { tokenContract: '' },
    { fromAddress: ' ' },
    { toAddress: null },
    { amountBaseUnits: '1.5' },
    { amountBaseUnits: '-1' },
    { amountBaseUnits: '0' },
    { amountBaseUnits: '' },
    { amountBaseUnits: '9'.repeat(79) },
    { amountBaseUnits: 9007199254740993 },
  ]
  for (const overrides of invalidCases) {
    assert.deepEqual(
      await recordTransferVerification({ ...valid, ...overrides }),
      { persisted: false, reason: 'invalid-record' },
      JSON.stringify(overrides),
    )
  }
})
