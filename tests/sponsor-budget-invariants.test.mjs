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

// Confirmed principal cannot push the ledger beyond the sponsor's configured budget.
test('sponsor confirmation fails closed when spent plus transfer exceeds total budget', async () => {
  const state = {
    transfer: {
      idempotency_key: 'sponsor-budget-cap-test-0001',
      sponsor_reference: 'test-sponsor',
      sponsor_address: 'T1111111111111111111111111',
      network: 'shasta',
      purpose: 'asset-grant',
      asset: 'TRX',
      token_contract: null,
      receiver_address: 'T2222222222222222222222222',
      amount_base_units: '25',
      status: 'submitted',
      transaction_hash: 'c'.repeat(64),
    },
    budget: {
      id: 8,
      reserved_base_units: '25',
      spent_base_units: '80',
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
          const normalized = sql.trim()
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
          throw new Error('Unexpected SQL in sponsor budget-cap test')
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

  assert.deepEqual(result, { updated: false, reason: 'budget-invariant-violated' })
  assert.equal(state.transfer.status, 'submitted')
  assert.equal(state.budget.reserved_base_units, '25')
  assert.equal(state.budget.spent_base_units, '80')
  assert.equal(state.commits, 0)
  assert.equal(state.rollbacks, 1)
  assert.equal(state.released, true)
  assert.ok(!state.queries.some((query) => query.startsWith('UPDATE trc20_token_clone.sponsor_budgets')))
  assert.ok(!state.queries.some((query) => query.startsWith('UPDATE trc20_token_clone.sponsor_transfers SET status')))
})


// Model a transaction rollback when the audit write fails after the ledger updates.
// This exercises application error handling with a query double, not PostgreSQL itself.
test('sponsor confirmation rolls back ledger mutations when audit-event insertion fails', async () => {
  const state = {
    transfer: {
      idempotency_key: 'sponsor-audit-failure-test-0001',
      sponsor_reference: 'test-sponsor',
      sponsor_address: 'T1111111111111111111111111',
      network: 'shasta',
      purpose: 'asset-grant',
      asset: 'TRX',
      token_contract: null,
      receiver_address: 'T2222222222222222222222222',
      amount_base_units: '25',
      status: 'submitted',
      transaction_hash: 'd'.repeat(64),
    },
    budget: {
      id: 9,
      reserved_base_units: '25',
      spent_base_units: '0',
      budget_base_units: '100',
    },
    queries: [],
    commits: 0,
    rollbacks: 0,
    released: false,
    snapshot: null,
  }

  const pool = {
    async connect() {
      return {
        async query(sql, values = []) {
          const normalized = sql.replace(/\s+/g, ' ').trim()
          state.queries.push(normalized)
          if (normalized === 'BEGIN') {
            state.snapshot = {
              transfer: { ...state.transfer },
              budget: { ...state.budget },
            }
            return { rows: [] }
          }
          if (normalized === 'COMMIT') {
            state.commits += 1
            return { rows: [] }
          }
          if (normalized === 'ROLLBACK') {
            state.rollbacks += 1
            if (state.snapshot) {
              Object.assign(state.transfer, state.snapshot.transfer)
              Object.assign(state.budget, state.snapshot.budget)
            }
            return { rows: [] }
          }
          if (normalized.includes('FROM trc20_token_clone.sponsor_transfers WHERE idempotency_key = $1 FOR UPDATE')) {
            return { rows: [{ ...state.transfer }] }
          }
          if (normalized.includes('FROM trc20_token_clone.native_transfer_verifications')) {
            const [network, hash, sender, receiver, amount] = values
            const matches = network === state.transfer.network
              && hash === state.transfer.transaction_hash
              && sender === state.transfer.sponsor_address
              && receiver === state.transfer.receiver_address
              && amount === state.transfer.amount_base_units
            return { rows: matches ? [{ '?column?': 1 }] : [] }
          }
          if (normalized.includes('FROM trc20_token_clone.sponsor_budgets')) {
            return { rows: [{ ...state.budget }] }
          }
          if (normalized.startsWith('UPDATE trc20_token_clone.sponsor_budgets SET reserved_base_units = reserved_base_units -')) {
            const [amount] = values
            state.budget.reserved_base_units = (BigInt(state.budget.reserved_base_units) - BigInt(amount)).toString()
            state.budget.spent_base_units = (BigInt(state.budget.spent_base_units) + BigInt(amount)).toString()
            return { rows: [], rowCount: 1 }
          }
          if (normalized.startsWith('UPDATE trc20_token_clone.sponsor_transfers SET status =')) {
            const [status, authorizationReference, hash] = values
            state.transfer.status = status
            if (authorizationReference) state.transfer.authorization_reference = authorizationReference
            if (hash) state.transfer.transaction_hash = hash
            return { rows: [], rowCount: 1 }
          }
          if (normalized.startsWith('INSERT INTO trc20_token_clone.audit_events')) {
            throw new Error('simulated audit insert failure')
          }
          throw new Error('Unexpected SQL in sponsor audit-failure test')
        },
        release() { state.released = true },
      }
    },
  }

  await assert.rejects(
    transitionSponsorTransferWithPool({
      idempotencyKey: state.transfer.idempotency_key,
      nextStatus: 'confirmed',
      transactionHash: state.transfer.transaction_hash,
    }, pool, { initialize: false }),
    /simulated audit insert failure/,
  )

  assert.equal(state.transfer.status, 'submitted')
  assert.equal(state.budget.reserved_base_units, '25')
  assert.equal(state.budget.spent_base_units, '0')
  assert.equal(state.commits, 0)
  assert.equal(state.rollbacks, 1)
  assert.equal(state.released, true)
  assert.ok(state.queries.some((query) => query.startsWith('INSERT INTO trc20_token_clone.audit_events')))
})
