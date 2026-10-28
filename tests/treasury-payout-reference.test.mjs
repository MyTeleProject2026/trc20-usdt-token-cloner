import test from 'node:test'
import assert from 'node:assert/strict'
import {
  TREASURY_PAYOUT_REFERENCE_STORAGE_KEY,
  readTreasuryPayoutReference,
  saveTreasuryPayoutReference,
} from '../src/treasury-payout-reference.mjs'

function storageWith(initial = {}) {
  const values = new Map(Object.entries(initial))
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null },
    setItem(key, value) { values.set(key, String(value)) },
  }
}

const ownerAddress = 'T' + 'A'.repeat(33)
const requestKey = 'withdrawal-12345678-1234-1234-1234-123456789abc'

test('treasury payout reference round-trips only the owner address and opaque idempotency key', () => {
  const storage = storageWith()
  assert.equal(saveTreasuryPayoutReference(ownerAddress, requestKey, storage), true)
  const saved = readTreasuryPayoutReference(storage)
  assert.equal(saved.version, 1)
  assert.equal(saved.ownerAddress, ownerAddress)
  assert.equal(saved.idempotencyKey, requestKey)
  const raw = JSON.parse(storage.getItem(TREASURY_PAYOUT_REFERENCE_STORAGE_KEY))
  assert.deepEqual(Object.keys(raw).sort(), ['idempotencyKey', 'ownerAddress', 'savedAt', 'version'])
})

test('treasury payout reference rejects invalid owner addresses and malformed request keys', () => {
  const storage = storageWith()
  assert.equal(saveTreasuryPayoutReference('not-an-address', requestKey, storage), false)
  assert.equal(saveTreasuryPayoutReference(ownerAddress, 'bad', storage), false)
  assert.equal(readTreasuryPayoutReference(storage), null)
})

test('treasury payout reference fails closed for corrupt or mismatched stored values', () => {
  assert.equal(readTreasuryPayoutReference(storageWith({ [TREASURY_PAYOUT_REFERENCE_STORAGE_KEY]: '{bad json' })), null)
  assert.equal(readTreasuryPayoutReference(storageWith({ [TREASURY_PAYOUT_REFERENCE_STORAGE_KEY]: JSON.stringify({ version: 2, ownerAddress, idempotencyKey: requestKey, savedAt: Date.now() }) })), null)
  assert.equal(readTreasuryPayoutReference(null), null)
})

test('storage write failures do not throw into the payout flow', () => {
  const failingStorage = { setItem() { throw new Error('quota') } }
  assert.equal(saveTreasuryPayoutReference(ownerAddress, requestKey, failingStorage), false)
})
