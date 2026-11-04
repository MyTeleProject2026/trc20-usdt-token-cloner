import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'

const { Pool } = pg
const enabled = process.env.SPONSOR_PG_INTEGRATION === '1'
const databaseUrl = process.env.DATABASE_URL || ''
const schema = 'trc20_token_clone'
const sponsorAddress = 'TKbcs8dYuaZT1VdtrKxnVswNg3DKjSs7u2'
const receiverAddress = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const network = 'nile'
const amount = '25'

function assertIsolatedDatabaseUrl(value) {
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('SPONSOR_PG_INTEGRATION requires a valid DATABASE_URL')
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\\//, ''))
  if (!['localhost', '127.0.0.1', '::1'].includes(parsed.hostname) || databaseName !== 'sponsor_test') {
    throw new Error('Refusing reconciliation integration tests unless DATABASE_URL targets the local dedicated sponsor_test database')
  }
}

if (enabled) assertIsolatedDatabaseUrl(databaseUrl)

async function createFixture() {
  const [{ initializeDatabase, transitionSponsorTransfer }, feeModule] = await Promise.all([
    import('../server/database.mjs'),
    import('../server/sponsor-chain-fee-observations.mjs'),
  ])
  const pool = new Pool({ connectionString: databaseUrl })
  await initializeDatabase()
  const identity = await pool.query('SELECT current_database() AS name')
  assert.equal(identity.rows[0].name, 'sponsor_test')
  const ledger = await feeModule.listSponsorChainFeeObservations({ network, limit: 1 })
  assert.equal(ledger.success, true, 'fee ledger must be initialized in the isolated test database')

  const suffix = randomUUID().replaceAll('-', '')
  const sponsorReference = `pg-failed-reconcile-${suffix}`
  const idempotencyKey = `failed-reconcile:${suffix}`
  const transactionHash = suffix.repeat(2)
  const auditReference = `${network}:${transactionHash}`

  await pool.query(
    `INSERT INTO ${schema}.sponsor_budgets
      (sponsor_reference, sponsor_address, network, purpose, asset, token_contract,
       budget_base_units, reserved_base_units, spent_base_units, status)
     VALUES
      ($1,$2,$3,'asset-grant','TRX',NULL,100,25,0,'active'),
      ($1,$2,$3,'network-fee','TRX',NULL,100,9,3,'active')`,
    [sponsorReference, sponsorAddress, network],
  )
  await pool.query(
    `INSERT INTO ${schema}.sponsor_transfers
      (idempotency_key, sponsor_reference, sponsor_address, network, purpose,
       asset, token_contract, receiver_address, amount_base_units, status, transaction_hash)
     VALUES ($1,$2,$3,$4,'asset-grant','TRX',NULL,$5,$6,'submitted',$7)`,
    [idempotencyKey, sponsorReference, sponsorAddress, network, receiverAddress, amount, transactionHash],
  )

  return {
    pool,
    transitionSponsorTransfer,
    feeModule,
    sponsorReference,
    idempotencyKey,
    transactionHash,
    auditReference,
    suffix,
  }
}

function failedReceipt(fixture) {
  return {
    network,
    transactionHash: fixture.transactionHash,
    idempotencyKey: fixture.idempotencyKey,
    blockNumber: 987654,
    executionResult: 'FAILED',
    transactionOwnerAddressHex: '11'.repeat(20),
    reportedFeeSun: '4200',
    energyFeeSun: '2000',
    netFeeSun: '2200',
    energyUsageTotal: '500',
    energyUsage: '400',
    originEnergyUsage: '100',
    netUsage: '300',
    energyPenaltyTotal: null,
  }
}

async function insertFailedReceipt(fixture) {
  const result = await fixture.feeModule.recordSponsorChainFeeObservation(failedReceipt(fixture))
  assert.equal(result.success, true)
  assert.equal(result.duplicate, false)
  assert.equal(result.settled, false)
  return result
}

async function readLedgerState(fixture) {
  const [transfer, budgets, audit, observation] = await Promise.all([
    fixture.pool.query(
      `SELECT status, transaction_hash FROM ${schema}.sponsor_transfers WHERE idempotency_key = $1`,
      [fixture.idempotencyKey],
    ),
    fixture.pool.query(
      `SELECT purpose, reserved_base_units::text AS reserved, spent_base_units::text AS spent
         FROM ${schema}.sponsor_budgets
        WHERE sponsor_reference = $1 AND network = $2
        ORDER BY purpose`,
      [fixture.sponsorReference, network],
    ),
    fixture.pool.query(
      `SELECT count(*)::int AS count, min(details->>'feeBudgetSettled') AS fee_budget_settled
         FROM ${schema}.audit_events
        WHERE event_type = 'sponsor-transfer-status-changed'
          AND entity_reference = $1 AND details->>'toStatus' = 'failed'`,
      [fixture.idempotencyKey],
    ),
    fixture.pool.query(
      `SELECT count(*)::int AS count, min(execution_result) AS execution_result
         FROM ${schema}.sponsor_chain_fee_observations
        WHERE network = $1 AND transaction_hash = $2 AND idempotency_key = $3`,
      [network, fixture.transactionHash, fixture.idempotencyKey],
    ),
  ])
  return {
    transfer: transfer.rows[0],
    budgets: budgets.rows,
    audit: audit.rows[0],
    observation: observation.rows[0],
  }
}

async function cleanupFixture(fixture, { triggerName = null, functionName = null } = {}) {
  const { pool, feeModule } = fixture
  if (triggerName) {
    await pool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON ${schema}.audit_events`).catch(() => {})
  }
  if (functionName) {
    await pool.query(`DROP FUNCTION IF EXISTS ${schema}.${functionName}()`).catch(() => {})
  }
  await pool.query(`ALTER TABLE ${schema}.sponsor_chain_fee_observations DISABLE TRIGGER sponsor_chain_fee_observations_immutable`).catch(() => {})
  await pool.query(
    `DELETE FROM ${schema}.sponsor_chain_fee_observations
      WHERE network = $1 AND transaction_hash = $2 AND idempotency_key = $3`,
    [network, fixture.transactionHash, fixture.idempotencyKey],
  ).catch(() => {})
  await pool.query(`ALTER TABLE ${schema}.sponsor_chain_fee_observations ENABLE TRIGGER sponsor_chain_fee_observations_immutable`).catch(() => {})
  await pool.query(
    `DELETE FROM ${schema}.audit_events
      WHERE entity_reference = ANY($1::text[])`,
    [[fixture.idempotencyKey, fixture.auditReference]],
  ).catch(() => {})
  await pool.query(`DELETE FROM ${schema}.sponsor_transfers WHERE idempotency_key = $1`, [fixture.idempotencyKey]).catch(() => {})
  await pool.query(`DELETE FROM ${schema}.sponsor_budgets WHERE sponsor_reference = $1`, [fixture.sponsorReference]).catch(() => {})
  await feeModule.closeSponsorChainFeeObservationPool().catch(() => {})
  await pool.end()
}

test('PostgreSQL does not release a submitted principal reservation without a matching immutable FAILED receipt', {
  skip: !enabled && 'Set SPONSOR_PG_INTEGRATION=1 with a dedicated sponsor_test DATABASE_URL',
}, async () => {
  const fixture = await createFixture()
  try {
    const result = await fixture.transitionSponsorTransfer({
      idempotencyKey: fixture.idempotencyKey,
      nextStatus: 'failed',
    })
    assert.deepEqual(result, {
      updated: false,
      reason: 'finalized-failure-fee-observation-required',
    })
    const state = await readLedgerState(fixture)
    assert.equal(state.transfer.status, 'submitted')
    assert.deepEqual(state.budgets, [
      { purpose: 'asset-grant', reserved: '25', spent: '0' },
      { purpose: 'network-fee', reserved: '9', spent: '3' },
    ])
    assert.equal(state.audit.count, 0)
    assert.equal(state.observation.count, 0)
  } finally {
    await cleanupFixture(fixture)
  }
})

test('PostgreSQL reconciles a matching FAILED receipt once under concurrent duplicate requests without settling fee budget', {
  skip: !enabled && 'Set SPONSOR_PG_INTEGRATION=1 with a dedicated sponsor_test DATABASE_URL',
}, async () => {
  const fixture = await createFixture()
  try {
    const observed = await insertFailedReceipt(fixture)
    assert.ok(observed.observationId)

    const results = await Promise.all([
      fixture.transitionSponsorTransfer({ idempotencyKey: fixture.idempotencyKey, nextStatus: 'failed' }),
      fixture.transitionSponsorTransfer({ idempotencyKey: fixture.idempotencyKey, nextStatus: 'failed' }),
    ])
    assert.equal(results.filter((item) => item.updated && item.duplicate === false && item.status === 'failed').length, 1)
    assert.equal(results.filter((item) => item.updated && item.duplicate === true && item.status === 'failed').length, 1)

    const state = await readLedgerState(fixture)
    assert.equal(state.transfer.status, 'failed')
    assert.deepEqual(state.budgets, [
      { purpose: 'asset-grant', reserved: '0', spent: '0' },
      { purpose: 'network-fee', reserved: '9', spent: '3' },
    ])
    assert.equal(state.audit.count, 1)
    assert.equal(state.audit.fee_budget_settled, 'false')
    assert.equal(state.observation.count, 1)
    assert.equal(state.observation.execution_result, 'FAILED')

    const audit = await fixture.pool.query(
      `SELECT details FROM ${schema}.audit_events
        WHERE event_type = 'sponsor-transfer-status-changed'
          AND entity_reference = $1 AND details->>'toStatus' = 'failed'`,
      [fixture.idempotencyKey],
    )
    assert.equal(audit.rows[0].details.failureEvidence, 'immutable-solidified-fee-observation')
    assert.equal(audit.rows[0].details.transactionHash, fixture.transactionHash)
    assert.equal(audit.rows[0].details.blockNumber, '987654')
    assert.equal(audit.rows[0].details.reportedFeeSun, '4200')
    assert.equal(audit.rows[0].details.feeBudgetSettled, false)
  } finally {
    await cleanupFixture(fixture)
  }
})

test('PostgreSQL rolls back failed reconciliation when the audit insert fails', {
  skip: !enabled && 'Set SPONSOR_PG_INTEGRATION=1 with a dedicated sponsor_test DATABASE_URL',
}, async () => {
  const fixture = await createFixture()
  const triggerName = `fail_failed_reconcile_${fixture.suffix}`
  const functionName = `fail_failed_reconcile_fn_${fixture.suffix}`
  try {
    await insertFailedReceipt(fixture)
    await fixture.pool.query(`
      CREATE FUNCTION ${schema}.${functionName}() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.event_type = 'sponsor-transfer-status-changed'
           AND NEW.entity_reference = '${fixture.idempotencyKey}'
           AND NEW.details->>'toStatus' = 'failed' THEN
          RAISE EXCEPTION 'intentional failed-reconciliation audit failure';
        END IF;
        RETURN NEW;
      END;
      $$`)
    await fixture.pool.query(`
      CREATE TRIGGER ${triggerName}
      BEFORE INSERT ON ${schema}.audit_events
      FOR EACH ROW EXECUTE FUNCTION ${schema}.${functionName}()
    `)

    await assert.rejects(
      fixture.transitionSponsorTransfer({
        idempotencyKey: fixture.idempotencyKey,
        nextStatus: 'failed',
      }),
      /intentional failed-reconciliation audit failure/,
    )

    const state = await readLedgerState(fixture)
    assert.equal(state.transfer.status, 'submitted')
    assert.deepEqual(state.budgets, [
      { purpose: 'asset-grant', reserved: '25', spent: '0' },
      { purpose: 'network-fee', reserved: '9', spent: '3' },
    ])
    assert.equal(state.audit.count, 0)
    assert.equal(state.observation.count, 1, 'the independent immutable fee observation must survive principal reconciliation rollback')
  } finally {
    await cleanupFixture(fixture, { triggerName, functionName })
  }
})
