import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'

const { Pool } = pg
const enabled = process.env.SPONSOR_PG_INTEGRATION === '1'
const databaseUrl = process.env.DATABASE_URL || ''

function assertIsolatedDatabaseUrl(value) {
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('SPONSOR_PG_INTEGRATION requires a valid DATABASE_URL')
  }
  const databaseName = decodeURIComponent(parsed.pathname.startsWith('/') ? parsed.pathname.slice(1) : parsed.pathname)
  const localHosts = new Set(['localhost', '127.0.0.1', '::1'])
  if (!localHosts.has(parsed.hostname) || databaseName !== 'sponsor_test') {
    throw new Error('Refusing PostgreSQL integration tests unless DATABASE_URL targets the local dedicated sponsor_test database')
  }
}

if (enabled) assertIsolatedDatabaseUrl(databaseUrl)

const sponsorAddress = 'TKbcs8dYuaZT1VdtrKxnVswNg3DKjSs7u2'
const receiverAddress = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const network = 'shasta'

async function setup() {
  const { initializeDatabase, reserveSponsorTransfer, transitionSponsorTransfer } =
    await import('../server/database.mjs')
  const pool = new Pool({ connectionString: databaseUrl })
  const readiness = await initializeDatabase()
  assert.equal(readiness.ready, true)
  const identity = await pool.query('SELECT current_database() AS name')
  assert.equal(identity.rows[0].name, 'sponsor_test', 'tests must only touch the dedicated sponsor_test database')
  return { pool, reserveSponsorTransfer, transitionSponsorTransfer }
}

async function insertBudget(pool, sponsorReference, budgetBaseUnits) {
  await pool.query(
    `INSERT INTO trc20_token_clone.sponsor_budgets
      (sponsor_reference, sponsor_address, network, asset, token_contract,
       budget_base_units, reserved_base_units, spent_base_units, status)
     VALUES ($1,$2,$3,'TRX',NULL,$4,0,0,'active')`,
    [sponsorReference, sponsorAddress, network, budgetBaseUnits],
  )
}

async function cleanup(pool, sponsorReferences, idempotencyKeys) {
  await pool.query(
    'DELETE FROM trc20_token_clone.audit_events WHERE entity_reference = ANY($1::text[])',
    [idempotencyKeys],
  )
  await pool.query(
    'DELETE FROM trc20_token_clone.sponsor_transfers WHERE idempotency_key = ANY($1::text[])',
    [idempotencyKeys],
  )
  await pool.query(
    'DELETE FROM trc20_token_clone.sponsor_budgets WHERE sponsor_reference = ANY($1::text[])',
    [sponsorReferences],
  )
}

test('PostgreSQL sponsor reservation is idempotent and confirmed ledger changes persist atomically', {
  skip: !enabled && 'Set SPONSOR_PG_INTEGRATION=1 with a dedicated sponsor_test DATABASE_URL',
}, async () => {
  const { pool, reserveSponsorTransfer, transitionSponsorTransfer } = await setup()
  const suffix = randomUUID()
  const sponsorReference = `pg-it-${suffix}`
  const idempotencyKey = `pg-it:${suffix}`
  const transactionHash = 'a'.repeat(64)
  try {
    await insertBudget(pool, sponsorReference, '100')
    const intent = {
      idempotencyKey,
      sponsorReference,
      network,
      purpose: 'asset-grant',
      asset: 'TRX',
      receiverAddress,
      amountBaseUnits: '25',
    }
    const first = await reserveSponsorTransfer(intent)
    assert.equal(first.reserved, true)
    assert.equal(first.duplicate, false)

    const retry = await reserveSponsorTransfer(intent)
    assert.equal(retry.reserved, true)
    assert.equal(retry.duplicate, true)

    let budget = await pool.query(
      `SELECT reserved_base_units::text AS reserved, spent_base_units::text AS spent
         FROM trc20_token_clone.sponsor_budgets WHERE sponsor_reference = $1`,
      [sponsorReference],
    )
    assert.deepEqual(budget.rows[0], { reserved: '25', spent: '0' })

    assert.equal((await transitionSponsorTransfer({
      idempotencyKey, nextStatus: 'authorized', authorizationReference: `approval-${suffix}`,
    })).updated, true)
    assert.equal((await transitionSponsorTransfer({
      idempotencyKey, nextStatus: 'submitted', transactionHash,
    })).updated, true)

    await pool.query(
      `INSERT INTO trc20_token_clone.native_transfer_verifications
        (network, transaction_hash, from_address, to_address, amount_sun, block_number, verification_status)
       VALUES ($1,$2,$3,$4,25,12345,'verified-on-chain')`,
      [network, transactionHash, sponsorAddress, receiverAddress],
    )
    const confirmed = await transitionSponsorTransfer({ idempotencyKey, nextStatus: 'confirmed', transactionHash })
    assert.deepEqual(confirmed, { updated: true, duplicate: false, status: 'confirmed' })

    const duplicateConfirmation = await transitionSponsorTransfer({ idempotencyKey, nextStatus: 'confirmed', transactionHash })
    assert.deepEqual(duplicateConfirmation, { updated: true, duplicate: true, status: 'confirmed' })

    budget = await pool.query(
      `SELECT reserved_base_units::text AS reserved, spent_base_units::text AS spent
         FROM trc20_token_clone.sponsor_budgets WHERE sponsor_reference = $1`,
      [sponsorReference],
    )
    assert.deepEqual(budget.rows[0], { reserved: '0', spent: '25' })
    const transfer = await pool.query(
      'SELECT status FROM trc20_token_clone.sponsor_transfers WHERE idempotency_key = $1',
      [idempotencyKey],
    )
    assert.equal(transfer.rows[0].status, 'confirmed')
  } finally {
    await cleanup(pool, [sponsorReference], [idempotencyKey])
    await pool.query(
      'DELETE FROM trc20_token_clone.native_transfer_verifications WHERE network = $1 AND transaction_hash = $2',
      [network, transactionHash],
    )
    await pool.end()
  }
})

test('concurrent reservations serialize on the budget row and cannot overspend', {
  skip: !enabled && 'Set SPONSOR_PG_INTEGRATION=1 with a dedicated sponsor_test DATABASE_URL',
}, async () => {
  const { pool, reserveSponsorTransfer } = await setup()
  const suffix = randomUUID()
  const sponsorReference = `pg-race-${suffix}`
  const keys = [`pg-race-a:${suffix}`, `pg-race-b:${suffix}`]
  try {
    await insertBudget(pool, sponsorReference, '100')
    const reserve = (idempotencyKey) => reserveSponsorTransfer({
      idempotencyKey,
      sponsorReference,
      network,
      purpose: 'asset-grant',
      asset: 'TRX',
      receiverAddress,
      amountBaseUnits: '60',
    })
    const outcomes = await Promise.all(keys.map(reserve))
    assert.equal(outcomes.filter((item) => item.reserved && !item.duplicate).length, 1)
    assert.equal(outcomes.filter((item) => !item.reserved && item.reason === 'insufficient-sponsor-budget').length, 1)

    const budget = await pool.query(
      `SELECT budget_base_units::text AS budget, reserved_base_units::text AS reserved,
              spent_base_units::text AS spent
         FROM trc20_token_clone.sponsor_budgets WHERE sponsor_reference = $1`,
      [sponsorReference],
    )
    assert.deepEqual(budget.rows[0], { budget: '100', reserved: '60', spent: '0' })
    const transfers = await pool.query(
      'SELECT count(*)::int AS count FROM trc20_token_clone.sponsor_transfers WHERE idempotency_key = ANY($1::text[])',
      [keys],
    )
    assert.equal(transfers.rows[0].count, 1)
  } finally {
    await cleanup(pool, [sponsorReference], keys)
    await pool.end()
  }
})


test('PostgreSQL rolls back sponsor ledger and status when the audit insert fails', {
  skip: !enabled && 'Set SPONSOR_PG_INTEGRATION=1 with a dedicated sponsor_test DATABASE_URL',
}, async () => {
  const { pool, reserveSponsorTransfer, transitionSponsorTransfer } = await setup()
  const suffix = randomUUID()
  const sponsorReference = `pg-audit-${suffix}`
  const idempotencyKey = `pg-audit:${suffix}`
  const transactionHash = 'b'.repeat(64)
  const triggerName = `fail_audit_${suffix.replaceAll('-', '')}`
  const functionName = `fail_audit_fn_${suffix.replaceAll('-', '')}`
  try {
    await insertBudget(pool, sponsorReference, '100')
    const reserved = await reserveSponsorTransfer({
      idempotencyKey, sponsorReference, network, purpose: 'asset-grant', asset: 'TRX',
      receiverAddress, amountBaseUnits: '25',
    })
    assert.equal(reserved.reserved, true)
    assert.equal((await transitionSponsorTransfer({
      idempotencyKey, nextStatus: 'authorized', authorizationReference: `approval-${suffix}`,
    })).updated, true)
    assert.equal((await transitionSponsorTransfer({
      idempotencyKey, nextStatus: 'submitted', transactionHash,
    })).updated, true)
    await pool.query(
      `INSERT INTO trc20_token_clone.native_transfer_verifications
        (network, transaction_hash, from_address, to_address, amount_sun, block_number, verification_status)
       VALUES ($1,$2,$3,$4,25,12346,'verified-on-chain')`,
      [network, transactionHash, sponsorAddress, receiverAddress],
    )

    await pool.query(`
      CREATE FUNCTION trc20_token_clone.${functionName}() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.event_type = 'sponsor-transfer-status-changed'
           AND NEW.entity_reference = '${idempotencyKey}' THEN
          RAISE EXCEPTION 'intentional integration-test audit failure';
        END IF;
        RETURN NEW;
      END;
      $$`)
    await pool.query(`
      CREATE TRIGGER ${triggerName}
      BEFORE INSERT ON trc20_token_clone.audit_events
      FOR EACH ROW EXECUTE FUNCTION trc20_token_clone.${functionName}()
    `)

    await assert.rejects(
      transitionSponsorTransfer({ idempotencyKey, nextStatus: 'confirmed', transactionHash }),
      /intentional integration-test audit failure/,
    )

    const budget = await pool.query(
      `SELECT reserved_base_units::text AS reserved, spent_base_units::text AS spent
         FROM trc20_token_clone.sponsor_budgets WHERE sponsor_reference = $1`,
      [sponsorReference],
    )
    assert.deepEqual(budget.rows[0], { reserved: '25', spent: '0' })
    const transfer = await pool.query(
      'SELECT status FROM trc20_token_clone.sponsor_transfers WHERE idempotency_key = $1',
      [idempotencyKey],
    )
    assert.equal(transfer.rows[0].status, 'submitted')
    const audit = await pool.query(
      `SELECT count(*)::int AS count FROM trc20_token_clone.audit_events
        WHERE event_type = 'sponsor-transfer-status-changed' AND entity_reference = $1
          AND details->>'toStatus' = 'confirmed'`,
    )
    assert.equal(audit.rows[0].count, 0)
  } finally {
    await pool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON trc20_token_clone.audit_events`).catch(() => {})
    await pool.query(`DROP FUNCTION IF EXISTS trc20_token_clone.${functionName}()`).catch(() => {})
    await cleanup(pool, [sponsorReference], [idempotencyKey])
    await pool.query(
      'DELETE FROM trc20_token_clone.native_transfer_verifications WHERE network = $1 AND transaction_hash = $2',
      [network, transactionHash],
    )
    await pool.end()
  }
})
