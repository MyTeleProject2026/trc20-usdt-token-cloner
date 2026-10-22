import test from 'node:test'
import assert from 'node:assert/strict'
import { transitionSponsorTransferWithPool } from '../server/database.mjs'

// This query double tests the guard path only. It is not a PostgreSQL integration test.
test('sponsor confirmation fails closed when reserved budget is below the transfer amount', async () => {
  const state = {
    transfer: {
      idempotency_key: 'sponsor-invariant-test-0001',
      sponsor_reference: 'test-sponsor',
      sponsor_address: 'T1111111111111111111111111',
      network: 'shasta',
      purpose: 'asset-grant',
      asset: 'TRX',
      token_contract: null,
      receiver_address: 'T2222222222222222222222222',
      amount_base_units: '25',
      status: 'submitted',
      transaction_hash: 'a'.repeat(64),
    },
    budget: {
      id: 7,
      reserved_base_units: '24',
      spent_base_units: '0',
      budget_base_units: '100',
    },
    queries: [],
    commits: 0,
    rollbacks: 0,
    released: false,
  }

  const pool = {
    async connect() {
      return {
        async query(sql) {
          const normalized = sql.replace(/\\s+/g, ' ').trim()
          state.queries.push(normalized)
          if (normalized === 'BEGIN') return { rows: [] }
          if (normalized === 'COMMIT') {
            state.commits += 1
            return { rows: [] }
          }
          if (normalized === 'ROLLBACK') {
            state.rollbacks += 1
            return { rows: [] }
          }
          if (normalized.includes('FROM trc20_token_clone.sponsor_transfers WHERE idempotency_key = $1 FOR UPDATE')) {
            return { rows: [{ ...state.transfer }] }
          }
          if (normalized.includes('FROM trc20_token_clone.native_transfer_verifications')) {
            return { rows: [{ '?column?': 1 }] }
          }
          if (normalized.includes('FROM trc20_token_clone.sponsor_budgets')) {
            return { rows: [{ ...state.budget }] }
          }
          throw new Error('Unexpected SQL in sponsor budget invariant test')
        },
        release() { state.released = true },
      }
    },
  }

  const result = await transitionSponsorTransferWithPool({
    idempotencyKey: state.transfer.idempotency_key,
    nextStatus: 'confirmed',
    transactionHash: state.transfer.transaction_hash,
  }, pool, { initialize: false })

  assert.deepEqual(result, { updated: false, reason: 'reservation-invariant-violated' })
  assert.equal(state.transfer.status, 'submitted')
  assert.equal(state.budget.reserved_base_units, '24')
  assert.equal(state.budget.spent_base_units, '0')
  assert.equal(state.commits, 0)
  assert.equal(state.rollbacks, 1)
  assert.equal(state.released, true)
  assert.ok(!state.queries.some((query) => query.startsWith('UPDATE trc20_token_clone.sponsor_budgets')))
  assert.ok(!state.queries.some((query) => query.startsWith('UPDATE trc20_token_clone.sponsor_transfers SET status')))
})

// TRC20 confirmation must match the complete event identity, not merely a transaction hash.
test('TRC20 sponsor confirmation rejects evidence that does not match contract, parties, and amount', async () => {
  const state = {
    transfer: {
      idempotency_key: 'sponsor-trc20-evidence-0001',
      sponsor_reference: 'test-sponsor',
      sponsor_address: 'T1111111111111111111111111',
      network: 'shasta',
      purpose: 'asset-grant',
      asset: 'USDT',
      token_contract: 'T3333333333333333333333333',
      receiver_address: 'T2222222222222222222222222',
      amount_base_units: '2500000',
      status: 'submitted',
      transaction_hash: 'b'.repeat(64),
    },
    queries: [],
    commits: 0,
    rollbacks: 0,
    released: false,
  }

  const pool = {
    async connect() {
      return {
        async query(sql, values = []) {
          const normalized = sql.replace(/\s+/g, ' ').trim()
          state.queries.push({ sql: normalized, values })
          if (normalized === 'BEGIN') return { rows: [] }
          if (normalized === 'COMMIT') {
            state.commits += 1
            return { rows: [] }
          }
          if (normalized === 'ROLLBACK') {
            state.rollbacks += 1
            return { rows: [] }
          }
          if (normalized.includes('FROM trc20_token_clone.sponsor_transfers WHERE idempotency_key = $1 FOR UPDATE')) {
            return { rows: [{ ...state.transfer }] }
          }
          if (normalized.includes('FROM trc20_token_clone.transfer_verifications')) {
            // Simulate no exact finalized event match. Never fall through to budget reconciliation.
            return { rows: [] }
          }
          throw new Error('Unexpected SQL in TRC20 sponsor evidence test')
        },
        release() { state.released = true },
      }
    },
  }

  const result = await transitionSponsorTransferWithPool({
    idempotencyKey: state.transfer.idempotency_key,
    nextStatus: 'confirmed',
    transactionHash: state.transfer.transaction_hash,
  }, pool, { initialize: false })

  assert.deepEqual(result, { updated: false, reason: 'finalized-transfer-evidence-not-found' })
  assert.equal(state.transfer.status, 'submitted')
  assert.equal(state.commits, 0)
  assert.equal(state.rollbacks, 1)
  assert.equal(state.released, true)
  const evidenceQuery = state.queries.find(({ sql }) => sql.includes('FROM trc20_token_clone.transfer_verifications'))
  assert.ok(evidenceQuery)
  assert.deepEqual(evidenceQuery.values, [
    'shasta',
    state.transfer.transaction_hash,
    state.transfer.token_contract,
    state.transfer.sponsor_address,
    state.transfer.receiver_address,
    state.transfer.amount_base_units,
  ])
  assert.ok(!state.queries.some(({ sql }) => sql.includes('FROM trc20_token_clone.sponsor_budgets')))
  assert.ok(!state.queries.some(({ sql }) => sql.startsWith('UPDATE trc20_token_clone.sponsor_transfers SET status')))
})
