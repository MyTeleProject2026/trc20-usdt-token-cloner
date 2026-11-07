import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { ensureSponsorDirectPayoutArchiveSchema } from '../server/sponsor-direct-payout-archive.mjs'

const { Pool } = pg
const enabled = process.env.SPONSOR_PG_INTEGRATION === '1'
const databaseUrl = process.env.DATABASE_URL || ''
const minimum = '1000000000'

function assertIsolatedSponsorTestDatabase(value) {
  let parsed
  try { parsed = new URL(value) } catch {
    throw new Error('SPONSOR_PG_INTEGRATION requires a valid DATABASE_URL')
  }
  const databaseName = decodeURIComponent(parsed.pathname.startsWith('/') ? parsed.pathname.slice(1) : parsed.pathname)
  if (!['localhost', '127.0.0.1', '::1'].includes(parsed.hostname) || databaseName !== 'sponsor_test') {
    throw new Error('Refusing payout archive integration tests outside the local dedicated sponsor_test database')
  }
}

test('archive migration fails closed on unresolved legacy rows, then preserves terminal history and global idempotency', {
  skip: !enabled && 'Set SPONSOR_PG_INTEGRATION=1 with a dedicated sponsor_test DATABASE_URL',
  timeout: 30000,
}, async () => {
  assertIsolatedSponsorTestDatabase(databaseUrl)
  const schemaName = 'sponsor_archive_test_' + randomUUID().replace(/-/g, '').slice(0, 12)
  const db = new Pool({ connectionString: databaseUrl, max: 4 })
  const terminalId = randomUUID()
  const confirmedId = randomUUID()
  const unresolvedId = randomUUID()
  const terminalKey = randomUUID()
  const confirmedKey = randomUUID()
  const unresolvedKey = randomUUID()
  const requester = 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8'
  const sponsor = 'TKbcs8dYuaZT1VdtrKxnVswNg3DKjSs7u2'
  const recipient = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
  const contract = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
  const createdAt = '2025-02-03T04:05:06.000Z'
  const confirmedHash = 'a'.repeat(64)

  try {
    // Build a schema matching the pre-Stage-17 table and seed old records.
    const { ensureSponsorDirectPayoutSchema } = await import('../server/sponsor-direct-payout-schema.mjs')
    await ensureSponsorDirectPayoutSchema(db, { schemaName })
    await db.query(
      'ALTER TABLE ' + schemaName + '.sponsor_direct_payouts ' +
      'ADD COLUMN minimum_policy_blocked BOOLEAN NOT NULL DEFAULT FALSE'
    )
    await db.query(
      'ALTER TABLE ' + schemaName + '.sponsor_direct_payouts ' +
      'ADD CONSTRAINT sponsor_direct_payouts_minimum_amount_check ' +
      'CHECK (amount_base_units >= ' + minimum + '::numeric OR minimum_policy_blocked=TRUE) NOT VALID'
    )

    await db.query(
      'INSERT INTO ' + schemaName + '.sponsor_direct_payouts ' +
      '(id,idempotency_key,requester_address,sponsor_address,recipient_address,token_contract,' +
      'amount_base_units,status,minimum_policy_blocked,failure_code,created_at,updated_at) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,\'failed\',TRUE,$8,$9,$9)',
      [terminalId, terminalKey, requester, sponsor, recipient, contract, '999999999',
        'confirmed-solidified-transaction-failed', createdAt],
    )
    await db.query(
      'INSERT INTO ' + schemaName + '.sponsor_direct_payouts ' +
      '(id,idempotency_key,requester_address,sponsor_address,recipient_address,token_contract,' +
      'amount_base_units,status,minimum_policy_blocked,transaction_hash,confirmation_block_number,' +
      'confirmation_log_index,confirmation_verified_at,confirmation_evidence,created_at,updated_at) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,\'confirmed\',TRUE,$8,12345,2,$9,$10::jsonb,$11,$11)',
      [confirmedId, confirmedKey, requester, sponsor, recipient, contract, '999000000',
        confirmedHash, createdAt, JSON.stringify({ source: 'legacy-test-fixture', verified: true }), createdAt],
    )
    await db.query(
      'INSERT INTO ' + schemaName + '.sponsor_direct_payouts ' +
      '(id,idempotency_key,requester_address,sponsor_address,recipient_address,token_contract,' +
      'amount_base_units,status,minimum_policy_blocked,transaction_hash,created_at,updated_at) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,\'submitted\',TRUE,$8,$9,$9)',
      [unresolvedId, unresolvedKey, requester, sponsor, recipient, contract, '998000000', 'b'.repeat(64), createdAt],
    )

    await assert.rejects(
      ensureSponsorDirectPayoutArchiveSchema(db, { schemaName }),
      /unresolved below-minimum payout records require explicit resolution/,
    )
    const archiveBeforeResolution = await db.query(
      'SELECT to_regclass($1) AS archive_table',
      [schemaName + '.sponsor_direct_payouts_archive'],
    )
    assert.equal(archiveBeforeResolution.rows[0]?.archive_table, null,
      'a blocked migration must roll back archive DDL and preserve all legacy rows')

    const unresolvedStillActive = await db.query(
      'SELECT status,transaction_hash FROM ' + schemaName + '.sponsor_direct_payouts WHERE id=$1',
      [unresolvedId],
    )
    assert.equal(unresolvedStillActive.rows[0]?.status, 'submitted')
    assert.equal(String(unresolvedStillActive.rows[0]?.transaction_hash).trim(), 'b'.repeat(64))

    // Simulate explicit resolution to a terminal, chain-failed state, then retry.
    await db.query(
      'UPDATE ' + schemaName + '.sponsor_direct_payouts SET status=\'failed\', failure_code=$2 WHERE id=$1',
      [unresolvedId, 'confirmed-solidified-transaction-failed'],
    )
    await ensureSponsorDirectPayoutArchiveSchema(db, { schemaName })

    const activeRows = await db.query(
      'SELECT COUNT(*)::int AS count FROM ' + schemaName + '.sponsor_direct_payouts ' +
      'WHERE amount_base_units < $1::numeric',
      [minimum],
    )
    assert.equal(activeRows.rows[0].count, 0, 'no below-minimum row may remain in the active payout table')

    const archived = await db.query(
      'SELECT id,idempotency_key,requester_address,sponsor_address,recipient_address,token_contract,' +
      'amount_base_units::text AS amount_base_units,status,transaction_hash,confirmation_block_number,' +
      'confirmation_log_index,confirmation_verified_at,confirmation_evidence,created_at,updated_at,' +
      'archived_at,archive_reason,archive_schema_version ' +
      'FROM ' + schemaName + '.sponsor_direct_payouts_archive ORDER BY id',
    )
    assert.equal(archived.rows.length, 3)
    const confirmed = archived.rows.find((row) => row.id === confirmedId)
    assert.ok(confirmed)
    assert.equal(confirmed.idempotency_key, confirmedKey)
    assert.equal(confirmed.amount_base_units, '999000000')
    assert.equal(String(confirmed.transaction_hash).trim(), confirmedHash)
    assert.equal(Number(confirmed.confirmation_block_number), 12345)
    assert.equal(confirmed.confirmation_log_index, 2)
    assert.deepEqual(confirmed.confirmation_evidence, { source: 'legacy-test-fixture', verified: true })
    assert.equal(new Date(confirmed.created_at).toISOString(), createdAt)
    assert.ok(confirmed.archived_at)
    assert.equal(confirmed.archive_reason, 'below-minimum-terminal-record')
    assert.equal(confirmed.archive_schema_version, 1)

    const history = await db.query(
      'SELECT id,is_archived,archived_at,archive_reason FROM ' +
      schemaName + '.sponsor_direct_payouts_history ORDER BY id',
    )
    assert.equal(history.rows.length, 3)
    assert.ok(history.rows.every((row) => row.is_archived === true && row.archived_at))

    const registry = await db.query(
      'SELECT COUNT(*)::int AS count FROM ' + schemaName + '.sponsor_direct_payout_idempotency_registry',
    )
    assert.equal(registry.rows[0].count, 3)

    const minimumConstraint = await db.query(
      'SELECT convalidated,pg_get_constraintdef(oid) AS definition FROM pg_constraint ' +
      'WHERE conrelid=$1::regclass AND conname=\'sponsor_direct_payouts_minimum_amount_check\'',
      [schemaName + '.sponsor_direct_payouts'],
    )
    assert.equal(minimumConstraint.rows.length, 1)
    assert.equal(minimumConstraint.rows[0].convalidated, true)
    assert.ok(minimumConstraint.rows[0].definition.includes('amount_base_units >= (1000000000)'))
    const markerColumn = await db.query(
      'SELECT 1 FROM information_schema.columns WHERE table_schema=$1 ' +
      'AND table_name=\'sponsor_direct_payouts\' AND column_name=\'minimum_policy_blocked\'',
      [schemaName],
    )
    assert.equal(markerColumn.rows.length, 0)

    await assert.rejects(
      db.query(
        'INSERT INTO ' + schemaName + '.sponsor_direct_payouts ' +
        '(id,idempotency_key,requester_address,recipient_address,token_contract,amount_base_units,status) ' +
        'VALUES ($1,$2,$3,$4,$5,$6,\'requested\')',
        [randomUUID(), randomUUID(), requester, recipient, contract, '999999999'],
      ),
      (error) => error.code === '23514',
    )
    await assert.rejects(
      db.query(
        'INSERT INTO ' + schemaName + '.sponsor_direct_payouts ' +
        '(id,idempotency_key,requester_address,recipient_address,token_contract,amount_base_units,status) ' +
        'VALUES ($1,$2,$3,$4,$5,$6,\'requested\')',
        [randomUUID(), terminalKey, requester, recipient, contract, minimum],
      ),
      (error) => error.code === '23505',
    )
    await assert.rejects(
      db.query('UPDATE ' + schemaName + '.sponsor_direct_payouts_archive SET failure_code=\'changed\' WHERE id=$1', [terminalId]),
      (error) => error.code === '55000',
    )

    await assert.rejects(
      db.query('TRUNCATE TABLE ' + schemaName + '.sponsor_direct_payouts_archive'),
      (error) => error.code === '55000',
    )

    const rerunDb = new Pool({ connectionString: databaseUrl, max: 2 })
    try {
      await ensureSponsorDirectPayoutArchiveSchema(rerunDb, { schemaName })
      const rerun = await rerunDb.query(
        'SELECT COUNT(*)::int AS count FROM ' + schemaName + '.sponsor_direct_payouts_archive',
      )
      assert.equal(rerun.rows[0].count, 3, 'the archive migration must be idempotent across new database pools')
    } finally {
      await rerunDb.end()
    }
  } finally {
    await db.end()
    const cleanup = new Pool({ connectionString: databaseUrl, max: 1 })
    await cleanup.query('DROP SCHEMA IF EXISTS ' + schemaName + ' CASCADE')
    await cleanup.end()
  }
})
