import test from 'node:test'
import assert from 'node:assert/strict'
import { reconcileTreasuryWithdrawals } from '../scripts/reconcile-treasury-withdrawals.mjs'

const txid = 'a'.repeat(64)
const rows = [
  { id: 1, idempotency_key: 'withdrawal-confirmed', treasury_address: 'T' + 'A'.repeat(33), recipient_address: 'T' + 'B'.repeat(33), amount_base_units: '1000000', status: 'broadcast-accepted', transaction_hash: txid },
  { id: 2, idempotency_key: 'withdrawal-failed', treasury_address: 'T' + 'A'.repeat(33), recipient_address: 'T' + 'C'.repeat(33), amount_base_units: '2000000', status: 'broadcast-unknown', transaction_hash: 'b'.repeat(64) },
  { id: 3, idempotency_key: 'withdrawal-pending', treasury_address: 'T' + 'A'.repeat(33), recipient_address: 'T' + 'D'.repeat(33), amount_base_units: '3000000', status: 'broadcast-accepted', transaction_hash: 'c'.repeat(64) },
]

function fakeDatabase() {
  const updates = []
  return {
    updates,
    async query(sql, params = []) {
      if (/^\s*SELECT/i.test(sql)) return { rows: rows.slice(0, params[0]) }
      updates.push({ sql, params })
      return { rows: [{ id: params[0] }] }
    },
  }
}

function fakeTronWeb() {
  return {
    trx: {
      async getConfirmedTransaction(hash) { return { txID: hash } },
      async getTransactionInfo(hash) { return { id: hash, blockNumber: 100 } },
    },
  }
}

test('receipt reconciler finalizes exact verified success and failure but keeps pending outcomes reserved', async () => {
  const db = fakeDatabase()
  const summary = await reconcileTreasuryWithdrawals({
    db,
    tronWeb: fakeTronWeb(),
    verifyEvidence: (_tronWeb, input) => {
      if (input.transactionHash === txid) return { verified: true, status: 'confirmed', reason: 'exact-official-transfer-event' }
      if (input.transactionHash === 'b'.repeat(64)) return { verified: true, status: 'failed', reason: 'confirmed-failed-receipt' }
      return { verified: false, status: 'awaiting-confirmed-receipt', reason: 'not-indexed' }
    },
  })
  assert.deepEqual(summary, { scanned: 3, confirmed: 1, failed: 1, pending: 1, errors: 0 })
  assert.equal(db.updates.length, 2)
  assert.equal(db.updates[0].params[1], 'confirmed')
  assert.equal(db.updates[1].params[1], 'failed')
  assert.equal(db.updates[1].params[2], 'confirmed-failed-receipt')
})

test('receipt reconciler leaves rows untouched when provider reads fail', async () => {
  const db = fakeDatabase()
  const tronWeb = {
    trx: {
      async getConfirmedTransaction() { throw new Error('provider private detail') },
      async getTransactionInfo() { throw new Error('provider private detail') },
    },
  }
  const summary = await reconcileTreasuryWithdrawals({ db, tronWeb })
  assert.deepEqual(summary, { scanned: 3, confirmed: 0, failed: 0, pending: 3, errors: 0 })
  assert.equal(db.updates.length, 0)
})

test('receipt reconciler enforces bounded batches and requires confirmed read methods', async () => {
  await assert.rejects(() => reconcileTreasuryWithdrawals({ db: fakeDatabase(), tronWeb: fakeTronWeb(), limit: 0 }), /batch size/)
  await assert.rejects(() => reconcileTreasuryWithdrawals({ db: fakeDatabase(), tronWeb: {}, limit: 1 }), /confirmed transaction and receipt reads/)
  await assert.rejects(() => reconcileTreasuryWithdrawals({ db: null, tronWeb: fakeTronWeb() }), /database client/)
})
