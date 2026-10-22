import test from 'node:test'
import assert from 'node:assert/strict'
import { transitionSponsorTransferWithPool } from '../server/database.mjs'

// A focused behavioral guard: network-fee confirmations must stop before either
// chain-evidence lookup or sponsor-budget reconciliation. No live DB or chain.
test('network-fee confirmation rejects before evidence and budget queries', async () => {
  const queries = []
  let commits = 0
  let rollbacks = 0
  let released = false
  const transfer = {
    idempotency_key: 'network-fee-guard-test-0001',
    sponsor_reference: 'test-sponsor',
    sponsor_address: 'T1111111111111111111111111',
    network: 'shasta',
    purpose: 'network-fee',
    asset: 'TRX',
    token_contract: null,
    receiver_address: 'T2222222222222222222222222',
    amount_base_units: '25',
    status: 'submitted',
    transaction_hash: 'a'.repeat(64),
  }
  const pool = {
    async connect() {
      return {
        async query(sql) {
          const normalized = sql.replace(/\s+/g, ' ').trim()
          queries.push(normalized)
          if (normalized === 'BEGIN') return { rows: [] }
          if (normalized === 'ROLLBACK') {
            rollbacks += 1
            return { rows: [] }
          }
          if (normalized === 'COMMIT') {
            commits += 1
            return { rows: [] }
          }
          if (normalized.includes('FROM trc20_token_clone.sponsor_transfers WHERE idempotency_key = $1 FOR UPDATE')) {
            return { rows: [{ ...transfer }] }
          }
          throw new Error('Unexpected query before network-fee guard: ' + normalized)
        },
        release() { released = true },
      }
    },
  }

  const result = await transitionSponsorTransferWithPool({
    idempotencyKey: transfer.idempotency_key,
    nextStatus: 'confirmed',
    transactionHash: transfer.transaction_hash,
  }, pool, { initialize: false })

  assert.deepEqual(result, {
    updated: false,
    reason: 'purpose-specific-fee-evidence-and-reconciliation-required',
  })
  assert.equal(transfer.status, 'submitted')
  assert.equal(rollbacks, 1)
  assert.equal(commits, 0)
  assert.equal(released, true)
  assert.ok(!queries.some((query) => /native_transfer_verifications|transfer_verifications/.test(query)))
  assert.ok(!queries.some((query) => /sponsor_budgets|UPDATE .*sponsor_transfers SET status/.test(query)))
})
