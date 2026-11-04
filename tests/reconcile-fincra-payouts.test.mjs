import test from 'node:test'
import assert from 'node:assert/strict'
import { reconcileFincraPayouts } from '../scripts/reconcile-fincra-payouts.mjs'

function database(rows, updateRows = [{ id: 1 }]) {
  const calls = []
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params })
      if (sql.startsWith('SELECT id')) return { rows }
      if (sql.startsWith('SELECT count(*)')) return { rows: [{ count: '2' }] }
      if (sql.startsWith('UPDATE')) return { rows: updateRows }
      throw new Error('unexpected query')
    },
  }
}
function tronWeb() {
  return { trx: {
    getConfirmedTransaction: async txid => ({ txID: txid }),
    getTransactionInfo: async txid => ({ id: txid, blockNumber: 1, receipt: { result: 'SUCCESS' } }),
  } }
}

test('Fincra payout reconciliation confirms only independently verified chain evidence', async () => {
  const db = database([{ id: 1, customer_reference: 'tts-1', recipient_address: 'Trecipient', amount_base_units: '1000000', transaction_hash: 'a'.repeat(64) }])
  const summary = await reconcileFincraPayouts({
    db, tronWeb: tronWeb(),
    verifyEvidence: () => ({ verified: true, status: 'confirmed', reason: 'exact-solidified-usdt-transfer' }),
  })
  assert.deepEqual(summary, { scanned: 1, confirmed: 1, failed: 0, pending: 0, errors: 0, awaitingProviderTransactionHash: 2 })
  assert.ok(db.calls.some(x => x.sql.startsWith('UPDATE') && x.params[1] === 'chain-confirmed'))
})

test('Fincra provider success without transaction hash is reported as awaiting evidence', async () => {
  const db = database([])
  const summary = await reconcileFincraPayouts({ db, tronWeb: tronWeb() })
  assert.deepEqual(summary, { scanned: 0, confirmed: 0, failed: 0, pending: 0, errors: 0, awaitingProviderTransactionHash: 2 })
})

test('Fincra reconciliation does not overwrite a row concurrently finalized elsewhere', async () => {
  const db = database([{ id: 2, recipient_address: 'Trecipient', amount_base_units: '1000000', transaction_hash: 'b'.repeat(64) }], [])
  const summary = await reconcileFincraPayouts({ db, tronWeb: tronWeb(), verifyEvidence: () => ({ verified: true, status: 'confirmed' }) })
  assert.equal(summary.confirmed, 0)
  assert.equal(summary.pending, 1)
})
