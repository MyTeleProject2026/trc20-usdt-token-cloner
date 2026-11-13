import test from 'node:test'
import assert from 'node:assert/strict'
import { createBitpieAdapter } from '../server/bitpie-adapter.mjs'

test('Bitpie address validation does not assert wallet ownership', () => {
  const result = createBitpieAdapter().validateTronAddress('not-a-tron-address')
  assert.equal(result.validFormat, false)
  assert.equal(result.ownershipVerified, false)
  assert.equal(result.bitpieAccountVerified, false)
})

test('Bitpie balance, deposit and balance-write capabilities remain unsupported', async () => {
  const adapter = createBitpieAdapter()
  assert.equal((await adapter.getBalance()).supported, false)
  assert.equal((await adapter.createDeposit()).supported, false)
  assert.equal((await adapter.writeWalletBalance()).supported, false)
})
