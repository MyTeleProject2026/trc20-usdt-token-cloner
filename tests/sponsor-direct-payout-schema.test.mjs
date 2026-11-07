import test from 'node:test'
import assert from 'node:assert/strict'
import { ensureSponsorDirectPayoutSchema } from '../server/sponsor-direct-payout-schema.mjs'

function makePool({ failAt = null } = {}) {
  const calls = []
  let released = 0
  let sequence = 0
  let shouldFail = failAt !== null
  const client = {
    async query(sql, values = []) {
      calls.push({ sql, values })
      sequence += 1
      if (shouldFail && sequence === failAt) {
        shouldFail = false
        throw new Error('simulated migration failure')
      }
      return { rowCount: 0, rows: [] }
    },
    release() { released += 1 },
  }
  return {
    calls,
    get released() { return released },
    async connect() { return client },
  }
}

test('canonical payout schema migration is transactional and uses a PostgreSQL advisory lock', async () => {
  const db = makePool()
  await ensureSponsorDirectPayoutSchema(db)
  const sql = db.calls.map((call) => call.sql)
  assert.equal(sql[0], 'BEGIN')
  assert.match(sql[1], /pg_advisory_xact_lock/)
  assert.ok(sql.some((item) => item.includes('CREATE TABLE IF NOT EXISTS trc20_token_clone.sponsor_direct_payouts')))
  assert.ok(sql.some((item) => item.includes('LOCK TABLE trc20_token_clone.sponsor_direct_payouts IN ACCESS EXCLUSIVE MODE')))
  assert.ok(sql.some((item) => item.includes('UPDATE trc20_token_clone.sponsor_direct_payouts SET minimum_policy_blocked=TRUE')))
  assert.ok(sql.some((item) => item.includes('sponsor_direct_payouts_minimum_amount_check')))
  assert.equal(sql.at(-1), 'COMMIT')
  assert.equal(db.released, 1)
})

test('concurrent calls using the same pool share one in-flight migration', async () => {
  const db = makePool()
  await Promise.all([
    ensureSponsorDirectPayoutSchema(db),
    ensureSponsorDirectPayoutSchema(db),
    ensureSponsorDirectPayoutSchema(db),
  ])
  assert.equal(db.calls.filter((call) => call.sql === 'BEGIN').length, 1)
  assert.equal(db.released, 1)
})

test('a failed migration rolls back, releases its client and can be retried', async () => {
  const db = makePool({ failAt: 4 })
  await assert.rejects(ensureSponsorDirectPayoutSchema(db), /simulated migration failure/)
  assert.ok(db.calls.some((call) => call.sql === 'ROLLBACK'))
  assert.equal(db.released, 1)
  await ensureSponsorDirectPayoutSchema(db)
  assert.equal(db.calls.at(-1).sql, 'COMMIT')
  assert.equal(db.released, 2)
})
