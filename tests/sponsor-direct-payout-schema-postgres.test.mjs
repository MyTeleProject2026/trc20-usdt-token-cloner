import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { ensureSponsorDirectPayoutSchema } from '../server/sponsor-direct-payout-schema.mjs'

const { Pool } = pg
const enabled = process.env.SPONSOR_PG_INTEGRATION === '1'
const databaseUrl = process.env.DATABASE_URL || ''
const lockKey = 'trc20_token_clone:sponsor_direct_payouts:schema:v1'
const migrationApplicationName = 'sponsor-schema-stage16-migration'

function assertIsolatedSponsorTestDatabase(value) {
  let parsed
  try { parsed = new URL(value) } catch {
    throw new Error('SPONSOR_PG_INTEGRATION requires a valid DATABASE_URL')
  }
  const databaseName = decodeURIComponent(parsed.pathname.startsWith('/') ? parsed.pathname.slice(1) : parsed.pathname)
  if (!['localhost', '127.0.0.1', '::1'].includes(parsed.hostname) || databaseName !== 'sponsor_test') {
    throw new Error('Refusing sponsor schema integration tests outside the local dedicated sponsor_test database')
  }
}

test('independent PostgreSQL pools serialize the payout schema migration on the advisory lock', {
  skip: !enabled && 'Set SPONSOR_PG_INTEGRATION=1 with a dedicated sponsor_test DATABASE_URL',
  timeout: 20000,
}, async () => {
  assertIsolatedSponsorTestDatabase(databaseUrl)

  const blockerPool = new Pool({ connectionString: databaseUrl, max: 3 })
  const migrationPool = new Pool({
    connectionString: databaseUrl,
    max: 2,
    application_name: migrationApplicationName,
  })
  const blocker = await blockerPool.connect()
  let blockerTransactionOpen = false
  let migrationPromise

  try {
    // Hold the exact transaction-scoped lock used by the migration, then start
    // the migration through a different pool (and therefore a different DB
    // connection). PostgreSQL must show that migration connection waiting.
    await blocker.query('BEGIN')
    blockerTransactionOpen = true
    await blocker.query('SELECT pg_advisory_xact_lock(hashtext($1))', [lockKey])

    migrationPromise = ensureSponsorDirectPayoutSchema(migrationPool)

    let migrationIsWaiting = false
    const deadline = Date.now() + 8000
    while (!migrationIsWaiting && Date.now() < deadline) {
      const result = await blockerPool.query(
        'SELECT EXISTS (' +
          'SELECT 1 FROM pg_stat_activity ' +
          'WHERE application_name=$1 AND wait_event_type=\'Lock\' AND wait_event=\'advisory\'' +
        ') AS waiting',
        [migrationApplicationName],
      )
      migrationIsWaiting = result.rows?.[0]?.waiting === true
      if (!migrationIsWaiting) await new Promise((resolve) => setTimeout(resolve, 25))
    }

    assert.equal(
      migrationIsWaiting,
      true,
      'the migration connection should wait on the advisory lock held by the independent connection',
    )

    await blocker.query('COMMIT')
    blockerTransactionOpen = false
    await migrationPromise

    const constraint = await blockerPool.query(
      'SELECT convalidated FROM pg_constraint ' +
      'WHERE conname=\'sponsor_direct_payouts_minimum_amount_check\' ' +
      'AND conrelid=\'trc20_token_clone.sponsor_direct_payouts\'::regclass',
    )
    assert.equal(constraint.rows.length, 1, 'the migration should finish with the minimum-policy constraint installed')
  } finally {
    if (blockerTransactionOpen) {
      await blocker.query('ROLLBACK').catch(() => {})
    }
    blocker.release()
    if (migrationPromise) await migrationPromise.catch(() => {})
    await Promise.all([blockerPool.end(), migrationPool.end()])
  }
})
