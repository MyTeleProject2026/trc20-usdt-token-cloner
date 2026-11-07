import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import pg from 'pg'
import { recordPrivateTreasuryVaultReservation } from '../server/private-treasury-vault-ledger.mjs'

const { Pool } = pg
const integrationEnabled = process.env.PRIVATE_TREASURY_VAULT_PG_INTEGRATION === '1'
const databaseUrl = process.env.DATABASE_URL || ''
const minimum = '1000000000'

function assertDedicatedLocalTestDatabase(value) {
  let parsed
  try { parsed = new URL(value) } catch {
    throw new Error('PRIVATE_TREASURY_VAULT_PG_INTEGRATION requires a valid DATABASE_URL')
  }
  const databaseName = decodeURIComponent(parsed.pathname.startsWith('/') ? parsed.pathname.slice(1) : parsed.pathname)
  if (!['localhost', '127.0.0.1', '::1'].includes(parsed.hostname) || databaseName !== 'sponsor_test') {
    throw new Error('Refusing Treasury Vault integration tests outside the local dedicated sponsor_test database')
  }
}

test('isolated PostgreSQL Treasury Vault schema enforces atomic claims, replay protection and monotonic reservations', {
  skip: !integrationEnabled && 'Set PRIVATE_TREASURY_VAULT_PG_INTEGRATION=1 with the dedicated local sponsor_test database',
}, async () => {
  assertDedicatedLocalTestDatabase(databaseUrl)
  const pool = new Pool({ connectionString: databaseUrl, max: 8 })
  const schema = 'private_treasury_vault_test_' + randomUUID().replace(/-/g, '').slice(0, 12)
  const vaultId = randomUUID()
  const migrationUrl = new URL('../server/migrations/20261108_private_treasury_vault_reservation_ledger_stage7c.sql', import.meta.url)
  const migration = await readFile(migrationUrl, 'utf8')
  const isolatedMigration = migration.replaceAll('trc20_token_clone', schema)

  const input = (overrides = {}) => ({
    vaultId,
    requestId: randomUUID(),
    receiptId: 'receipt-' + randomUUID(),
    observationId: 'observation-' + randomUUID(),
    sequence: '1',
    payloadDigest: 'a'.repeat(64),
    amountBaseUnits: minimum,
    ...overrides,
  })

  try {
    await pool.query(isolatedMigration)
    await pool.query(
      'INSERT INTO ' + schema + '.private_treasury_vaults ' +
      '(vault_id, network, asset, token_contract, decimals, vault_address) ' +
      'VALUES ($1,\'mainnet\',\'USDT\',\'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t\',6,$2)',
      [vaultId, 'T' + 'A'.repeat(33)],
    )
    await pool.query(
      'INSERT INTO ' + schema + '.private_treasury_observation_state (vault_id) VALUES ($1)',
      [vaultId],
    )

    const first = input()
    const created = await recordPrivateTreasuryVaultReservation(pool, first, { schema })
    assert.equal(created.payoutAuthorized, false)
    assert.equal(created.executionEnabled, false)
    assert.equal(created.amountBaseUnits, minimum)

    await assert.rejects(
      recordPrivateTreasuryVaultReservation(pool, {
        ...input({ sequence: '2', receiptId: first.receiptId }),
      }, { schema }),
      (error) => error.code === '23505',
      'receipt IDs must not be replayable',
    )

    await assert.rejects(
      recordPrivateTreasuryVaultReservation(pool, {
        ...input({ sequence: '2', observationId: first.observationId }),
      }, { schema }),
      (error) => error.code === '23505',
      'observation IDs must not be replayable',
    )

    await assert.rejects(
      recordPrivateTreasuryVaultReservation(pool, input({ sequence: '1' }), { schema }),
      (error) => error.code === 'PRIVATE_TREASURY_VAULT_SEQUENCE_NOT_MONOTONIC',
      'stale sequences must be rejected',
    )

    await assert.rejects(
      recordPrivateTreasuryVaultReservation(pool, input({ sequence: '2', amountBaseUnits: '999999999' }), { schema }),
      /1,000 USDT minimum/,
      'reservations below 1,000 USDT must be rejected',
    )

    const rollbackCandidate = input({ sequence: '2', requestId: first.requestId })
    await assert.rejects(
      recordPrivateTreasuryVaultReservation(pool, rollbackCandidate, { schema }),
      (error) => error.code === '23505',
      'a duplicate request must roll back its observation claim',
    )
    const rolledBackClaim = await pool.query(
      'SELECT COUNT(*)::int AS count FROM ' + schema + '.private_treasury_observation_claims ' +
      'WHERE vault_id=$1 AND receipt_id=$2',
      [vaultId, rollbackCandidate.receiptId],
    )
    assert.equal(rolledBackClaim.rows[0].count, 0)

    const afterRollback = await recordPrivateTreasuryVaultReservation(pool, {
      ...rollbackCandidate,
      requestId: randomUUID(),
    }, { schema })
    assert.equal(afterRollback.sequence, '2')

    const concurrent = await Promise.allSettled([
      recordPrivateTreasuryVaultReservation(pool, input({ sequence: '3' }), { schema }),
      recordPrivateTreasuryVaultReservation(pool, input({ sequence: '3' }), { schema }),
    ])
    assert.equal(concurrent.filter((item) => item.status === 'fulfilled').length, 1)
    assert.equal(concurrent.filter((item) => item.status === 'rejected').length, 1)
    const rejected = concurrent.find((item) => item.status === 'rejected')
    assert.equal(rejected.reason.code, 'PRIVATE_TREASURY_VAULT_SEQUENCE_NOT_MONOTONIC')

    const cursor = await pool.query(
      'SELECT last_sequence::text AS last_sequence FROM ' + schema + '.private_treasury_observation_state WHERE vault_id=$1',
      [vaultId],
    )
    assert.equal(cursor.rows[0].last_sequence, '3')

    await assert.rejects(
      pool.query(
        'UPDATE ' + schema + '.private_treasury_observation_claims SET payload_digest=$2 WHERE vault_id=$1',
        [vaultId, 'b'.repeat(64)],
      ),
      (error) => error.code === '55000',
      'observation claims must be immutable',
    )

    await assert.rejects(
      pool.query('UPDATE ' + schema + '.private_treasury_observation_state SET last_sequence=2 WHERE vault_id=$1', [vaultId]),
      (error) => error.code === '23514',
      'direct SQL must not move the sequence cursor backwards',
    )
    await assert.rejects(
      pool.query('UPDATE ' + schema + '.private_treasury_observation_state SET last_observation_id=$2 WHERE vault_id=$1', [vaultId, 'forged-at-same-sequence']),
      (error) => error.code === '23514',
      'observation identity must not change at the same sequence',
    )

    const crossLink = { receiptId: 'receipt-cross-link', observationId: 'observation-cross-link', sequence: '4' }
    await pool.query(
      'INSERT INTO ' + schema + '.private_treasury_observation_claims (vault_id, receipt_id, observation_id, reservation_sequence, payload_digest) VALUES ($1,$2,$3,$4,$5)',
      [vaultId, crossLink.receiptId, crossLink.observationId, crossLink.sequence, 'c'.repeat(64)],
    )
    await assert.rejects(
      pool.query(
        'INSERT INTO ' + schema + '.private_treasury_reservations (reservation_id, vault_id, request_id, receipt_id, observation_id, reservation_sequence, amount_base_units) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [randomUUID(), vaultId, randomUUID(), first.receiptId, crossLink.observationId, '4', minimum],
      ),
      (error) => error.code === '23503',
      'receipt, observation and sequence must bind to one claim row',
    )

    const counts = await pool.query(
      'SELECT (SELECT COUNT(*) FROM ' + schema + '.private_treasury_observation_claims WHERE vault_id=$1)::int AS claims, ' +
      '(SELECT COUNT(*) FROM ' + schema + '.private_treasury_reservations WHERE vault_id=$1)::int AS reservations, ' +
      '(SELECT COUNT(*) FROM ' + schema + '.private_treasury_reservation_events WHERE vault_id=$1)::int AS events',
      [vaultId],
    )
    assert.equal(counts.rows[0].claims, 4)
    assert.equal(counts.rows[0].reservations, 3)
    assert.equal(counts.rows[0].events, 3)
  } finally {
    try { await pool.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE') } finally { await pool.end() }
  }
})
