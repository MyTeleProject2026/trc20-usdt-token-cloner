import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { transitionSponsorTransferWithPool } from '../server/database.mjs'

const routes = await readFile(new URL('../server/routes/native-tron.mjs', import.meta.url), 'utf8')
const database = await readFile(new URL('../server/database.mjs', import.meta.url), 'utf8')

function cancellationPool({ status = 'authorized' } = {}) {
  const transfer = {
    idempotency_key: 'cancel-test-request-0001',
    sponsor_reference: 'test-sponsor',
    sponsor_address: 'TKbcs8dYuaZT1VdtrKxnVswNg3DKjSs7u2',
    network: 'shasta',
    purpose: 'asset-grant',
    asset: 'TRX',
    token_contract: null,
    receiver_address: 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp',
    amount_base_units: '10',
    status,
    transaction_hash: status === 'submitted' ? 'a'.repeat(64) : null,
  }
  const budget = {
    id: 77,
    sponsor_reference: transfer.sponsor_reference,
    sponsor_address: transfer.sponsor_address,
    network: transfer.network,
    purpose: transfer.purpose,
    asset: transfer.asset,
    token_contract: null,
    reserved_base_units: '10',
    spent_base_units: '0',
    budget_base_units: '100',
    status: 'active',
    approval_reference: null,
    review_reference: null,
    approved_at: null,
  }
  const state = { transfer, budget, queries: [], auditDetails: null, commits: 0, rollbacks: 0, releases: 0 }
  const pool = {
    async connect() {
      return {
        async query(sql, values = []) {
          const normalized = sql.replace(/\\s+/g, ' ').trim()
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
          if (normalized.includes('FROM trc20_token_clone.sponsor_budgets')) {
            return { rows: [{ ...state.budget }] }
          }
          if (normalized.startsWith('UPDATE trc20_token_clone.sponsor_budgets SET reserved_base_units = reserved_base_units -')) {
            state.budget.reserved_base_units = (BigInt(state.budget.reserved_base_units) - BigInt(values[0])).toString()
            return { rows: [], rowCount: 1 }
          }
          if (normalized.startsWith('UPDATE trc20_token_clone.sponsor_transfers')) {
            state.transfer.status = values[0]
            return { rows: [], rowCount: 1 }
          }
          if (normalized.startsWith('INSERT INTO trc20_token_clone.audit_events')) {
            state.auditDetails = JSON.parse(values[1])
            return { rows: [], rowCount: 1 }
          }
          throw new Error('Unexpected SQL in sponsor cancellation test: ' + normalized)
        },
        release() { state.releases += 1 },
      }
    },
  }
  return { pool, state }
}

test('sponsor reservation cancellation route is admin-protected and accepts only controlled reason codes', () => {
  const start = routes.indexOf("router.post('/sponsorship/transfers/:idempotencyKey/cancel'")
  const end = routes.indexOf("router.get('/sponsorship/transfers'", start)
  assert.ok(start >= 0 && end > start)
  const endpoint = routes.slice(start, end)
  assert.match(endpoint, /SPONSOR_ADMIN_API_TOKEN/)
  assert.match(endpoint, /hasValidSponsorAdminToken\(req\)/)
  assert.match(endpoint, /cancellationReasons/)
  assert.match(endpoint, /transitionSponsorTransfer\(/)
  assert.match(endpoint, /canSubmitSponsoredTransfer: false/)
  assert.match(endpoint, /transactionBroadcast: false/)
  assert.match(endpoint, /No transaction was signed or broadcast/)
  assert.doesNotMatch(endpoint, /privateKey|sendRawTransaction|broadcasttransaction/i)
})

test('unsubmitted sponsor reservation cancellation atomically releases budget and audits reason', async () => {
  const { pool, state } = cancellationPool()
  const result = await transitionSponsorTransferWithPool({
    idempotencyKey: state.transfer.idempotency_key,
    nextStatus: 'cancelled',
    cancellationReason: 'eligibility-expired',
  }, pool, { initialize: false })

  assert.deepEqual(result, { updated: true, duplicate: false, status: 'cancelled' })
  assert.equal(state.transfer.status, 'cancelled')
  assert.equal(state.budget.reserved_base_units, '0')
  assert.equal(state.budget.spent_base_units, '0')
  assert.equal(state.commits, 1)
  assert.equal(state.rollbacks, 0)
  assert.equal(state.releases, 1)
  assert.deepEqual(state.auditDetails, {
    fromStatus: 'authorized',
    toStatus: 'cancelled',
    network: 'shasta',
    asset: 'TRX',
    cancellationReason: 'eligibility-expired',
  })
})

test('submitted sponsor transactions cannot be cancelled or have their reservation released', async () => {
  const { pool, state } = cancellationPool({ status: 'submitted' })
  const result = await transitionSponsorTransferWithPool({
    idempotencyKey: state.transfer.idempotency_key,
    nextStatus: 'cancelled',
    cancellationReason: 'emergency-stop',
  }, pool, { initialize: false })

  assert.deepEqual(result, { updated: false, reason: 'invalid-state-transition' })
  assert.equal(state.transfer.status, 'submitted')
  assert.equal(state.budget.reserved_base_units, '10')
  assert.equal(state.commits, 0)
  assert.equal(state.rollbacks, 1)
  assert.equal(state.releases, 1)
  assert.ok(!state.queries.some(({ sql }) => sql.includes('FROM trc20_token_clone.sponsor_budgets')))
  assert.ok(!state.queries.some(({ sql }) => sql.startsWith('UPDATE trc20_token_clone.sponsor_budgets')))
  assert.ok(!state.queries.some(({ sql }) => sql.startsWith('INSERT INTO trc20_token_clone.audit_events')))
})

test('sponsor cancellation reason rejects unsupported values before database work', async () => {
  let connected = false
  const pool = { async connect() { connected = true; throw new Error('must not connect') } }
  const result = await transitionSponsorTransferWithPool({
    idempotencyKey: 'cancel-test-request-0001',
    nextStatus: 'cancelled',
    cancellationReason: 'release-anything',
  }, pool, { initialize: false })

  assert.deepEqual(result, { updated: false, reason: 'invalid-cancellation-reason' })
  assert.equal(connected, false)
  assert.match(database, /cancellationReason/)
})
