import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import pg from 'pg'

const { Pool } = pg
const enabled = process.env.SPONSOR_PG_INTEGRATION === '1'
const databaseUrl = process.env.DATABASE_URL || ''

function assertIsolatedDatabaseUrl(value) {
  let parsed
  try { parsed = new URL(value) } catch {
    throw new Error('SPONSOR_PG_INTEGRATION requires a valid DATABASE_URL')
  }
  const databaseName = decodeURIComponent(parsed.pathname.startsWith('/') ? parsed.pathname.slice(1) : parsed.pathname)
  if (!new Set(['localhost', '127.0.0.1', '::1']).has(parsed.hostname) || databaseName !== 'sponsor_test') {
    throw new Error('Refusing sponsor resource settlement integration tests outside the local dedicated sponsor_test database')
  }
}

if (enabled) assertIsolatedDatabaseUrl(databaseUrl)

const principal = 'TKbcs8dYuaZT1VdtrKxnVswNg3DKjSs7u2'
const receiver = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const feeSponsor = 'TTGhREx2pDSxFX555NWz1YwGpiBVPvQA7e'
const tokenContract = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'

function snapshot() {
  return {
    feeSponsorAddress: feeSponsor,
    assetPrincipalAddress: principal,
    energyStakeSun: '10000000',
    bandwidthStakeSun: '20000000',
    energyExpiry: 0,
    bandwidthExpiry: 0,
    ownEnergySun: '0',
    incomingEnergyLegacySun: '0',
    incomingEnergyV2Sun: '10000000',
    ownBandwidthSun: '0',
    incomingBandwidthLegacySun: '0',
    incomingBandwidthV2Sun: '20000000',
  }
}

async function seedFixture(pool, { feeBurn = '0' } = {}) {
  const suffix = randomUUID()
  const idempotencyKey = 'resource-settlement:' + suffix
  const sponsorReference = 'pg-resource-sponsor-' + suffix
  const mandateReference = 'pg-resource-mandate-' + suffix
  const transactionHash = createHash('sha256').update(suffix).digest('hex')
  const budgetResult = await pool.query(
    `INSERT INTO trc20_token_clone.sponsor_resource_budgets
      (mandate_reference, sponsor_reference, network, fee_sponsor_address, asset_principal_address,
       energy_budget_units, bandwidth_budget_units, energy_per_transfer_limit, bandwidth_per_transfer_limit,
       energy_reserved_units, bandwidth_reserved_units, energy_spent_units, bandwidth_spent_units,
       valid_until, status, approval_reference, review_reference, approved_at)
     VALUES ($1,$2,'nile',$3,$4,1000,1000,100,50,100,50,0,0,now() + interval '1 day',
       'active','pg-test-approval','pg-test-review',now())
     RETURNING id::text AS id`,
    [mandateReference, sponsorReference, feeSponsor, principal],
  )
  const budgetId = budgetResult.rows[0].id
  const blockTimestampMs = Date.now() - 5000
  const preflightCheckedAt = new Date(blockTimestampMs - 1000).toISOString()
  const preflight = {
    success: true,
    network: 'nile',
    sponsorAddress: principal,
    feeSponsorAddress: feeSponsor,
    feeSponsorResourceSourceVerified: true,
    bandwidthCoverageSource: 'exact-active-fee-sponsor-delegation-only',
    energyCoverageSource: 'exact-active-fee-sponsor-delegation-only',
    freeBandwidthUsedAsSponsorCoverage: false,
    delegationSnapshot: snapshot(),
    checkedAt: preflightCheckedAt,
  }

  await pool.query(
    `INSERT INTO trc20_token_clone.sponsor_transfers
      (idempotency_key, sponsor_reference, network, purpose, asset, token_contract,
       receiver_address, amount_base_units, status, transaction_hash, sponsor_address)
     VALUES ($1,$2,'nile','asset-grant','USDT',$3,$4,2500000,'confirmed',$5,$6)`,
    [idempotencyKey, sponsorReference, tokenContract, receiver, transactionHash, principal],
  )
  await pool.query(
    `INSERT INTO trc20_token_clone.sponsor_resource_reservations
      (idempotency_key, budget_id, network, transaction_hash, energy_reserved_units,
       bandwidth_reserved_units, status, expires_at, preflight_evidence, preflight_checked_at)
     VALUES ($1,$2::bigint,'nile',$3,100,50,'reserved',
       to_timestamp(($4::bigint + 600000) / 1000.0),$5::jsonb,to_timestamp($6::bigint / 1000.0))`,
    [idempotencyKey, budgetId, transactionHash, blockTimestampMs, JSON.stringify(preflight), Date.parse(preflightCheckedAt)],
  )
  await pool.query(
    `INSERT INTO trc20_token_clone.sponsor_chain_cost_observations
      (network, transaction_hash, idempotency_key, sponsor_reference, fee_sponsor_address,
       asset_principal_address, receiver_address, asset, token_contract, amount_base_units,
       block_number, block_timestamp_ms, execution_result, reported_fee_sun, energy_fee_sun,
       net_fee_sun, energy_usage_total, energy_usage, net_usage, energy_penalty_total)
     VALUES ('nile',$1,$2,$3,$4,$5,$6,'USDT',$7,2500000,123456,$8,'SUCCESS',$9,0,0,75,70,25,5)`,
    [transactionHash, idempotencyKey, sponsorReference, feeSponsor, principal, receiver, tokenContract,
      blockTimestampMs, feeBurn],
  )
  return { idempotencyKey, sponsorReference, mandateReference, transactionHash, budgetId, blockTimestampMs }
}

async function cleanupFixture(pool, fixture) {
  await pool.query('DELETE FROM trc20_token_clone.audit_events WHERE entity_reference = $1', [fixture.idempotencyKey])
  await pool.query('DELETE FROM trc20_token_clone.sponsor_resource_cost_settlements WHERE idempotency_key = $1', [fixture.idempotencyKey])
  await pool.query('DELETE FROM trc20_token_clone.sponsor_resource_reservations WHERE idempotency_key = $1', [fixture.idempotencyKey])
  await pool.query('DELETE FROM trc20_token_clone.sponsor_chain_cost_observations WHERE idempotency_key = $1', [fixture.idempotencyKey])
  await pool.query('DELETE FROM trc20_token_clone.sponsor_transfers WHERE idempotency_key = $1', [fixture.idempotencyKey])
  await pool.query('DELETE FROM trc20_token_clone.sponsor_resource_budgets WHERE id = $1::bigint', [fixture.budgetId])
}

function validAttribution(fixture) {
  return {
    success: true,
    network: 'nile',
    sponsorAddress: principal,
    feeSponsorAddress: feeSponsor,
    feeSponsorResourceSourceVerified: true,
    bandwidthCoverageSource: 'exact-active-fee-sponsor-delegation-only',
    energyCoverageSource: 'exact-active-fee-sponsor-delegation-only',
    freeBandwidthUsedAsSponsorCoverage: false,
    checkedAt: new Date().toISOString(),
    delegationSnapshot: snapshot(),
  }
}

test('PostgreSQL atomically settles verified delegated resource units once and is idempotent', {
  skip: !enabled && 'Set SPONSOR_PG_INTEGRATION=1 with a dedicated local sponsor_test DATABASE_URL',
}, async () => {
  const { initializeDatabase, recordSponsorResourceCostSettlementObservation } = await import('../server/database.mjs')
  const pool = new Pool({ connectionString: databaseUrl })
  let fixture
  try {
    assert.equal((await initializeDatabase()).ready, true)
    assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name, 'sponsor_test')
    fixture = await seedFixture(pool)
    const first = await recordSponsorResourceCostSettlementObservation({
      idempotencyKey: fixture.idempotencyKey,
      transactionHash: fixture.transactionHash,
      attributionEvidence: validAttribution(fixture),
    })
    assert.equal(first.success, true, `settlement should succeed: ${JSON.stringify(first)}`)
    assert.equal(first.status, 'settled')
    assert.equal(first.sponsorResourceBudgetSettled, true)
    assert.equal(first.canSubmitSponsoredTransfer, false)

    const budget = await pool.query(
      `SELECT energy_reserved_units::text AS energy_reserved,
              bandwidth_reserved_units::text AS bandwidth_reserved,
              energy_spent_units::text AS energy_spent,
              bandwidth_spent_units::text AS bandwidth_spent
         FROM trc20_token_clone.sponsor_resource_budgets WHERE id = $1::bigint`,
      [fixture.budgetId],
    )
    assert.deepEqual(budget.rows[0], {
      energy_reserved: '0', bandwidth_reserved: '0', energy_spent: '75', bandwidth_spent: '25',
    })
    const reservation = await pool.query(
      'SELECT status FROM trc20_token_clone.sponsor_resource_reservations WHERE idempotency_key = $1',
      [fixture.idempotencyKey],
    )
    assert.equal(reservation.rows[0].status, 'settled')

    const duplicate = await recordSponsorResourceCostSettlementObservation({
      idempotencyKey: fixture.idempotencyKey,
      transactionHash: fixture.transactionHash,
      attributionEvidence: validAttribution(fixture),
    })
    assert.equal(duplicate.success, true)
    assert.equal(duplicate.duplicate, true)
    assert.equal(duplicate.sponsorResourceBudgetSettled, true)
    const afterDuplicate = await pool.query(
      `SELECT energy_spent_units::text AS energy_spent,
              bandwidth_spent_units::text AS bandwidth_spent
         FROM trc20_token_clone.sponsor_resource_budgets WHERE id = $1::bigint`,
      [fixture.budgetId],
    )
    assert.deepEqual(afterDuplicate.rows[0], { energy_spent: '75', bandwidth_spent: '25' })
  } finally {
    if (fixture) await cleanupFixture(pool, fixture)
    await pool.end()
  }
})

test('PostgreSQL keeps fee-burned transactions in manual review without charging resource budget', {
  skip: !enabled && 'Set SPONSOR_PG_INTEGRATION=1 with a dedicated local sponsor_test DATABASE_URL',
}, async () => {
  const { initializeDatabase, recordSponsorResourceCostSettlementObservation } = await import('../server/database.mjs')
  const pool = new Pool({ connectionString: databaseUrl })
  let fixture
  try {
    assert.equal((await initializeDatabase()).ready, true)
    assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name, 'sponsor_test')
    fixture = await seedFixture(pool, { feeBurn: '1000' })
    const result = await recordSponsorResourceCostSettlementObservation({
      idempotencyKey: fixture.idempotencyKey,
      transactionHash: fixture.transactionHash,
      attributionEvidence: null,
    })
    assert.equal(result.success, true)
    assert.equal(result.status, 'manual-review')
    assert.equal(result.sponsorResourceBudgetSettled, false)

    const budget = await pool.query(
      `SELECT energy_reserved_units::text AS energy_reserved,
              bandwidth_reserved_units::text AS bandwidth_reserved,
              energy_spent_units::text AS energy_spent,
              bandwidth_spent_units::text AS bandwidth_spent
         FROM trc20_token_clone.sponsor_resource_budgets WHERE id = $1::bigint`,
      [fixture.budgetId],
    )
    assert.deepEqual(budget.rows[0], {
      energy_reserved: '100', bandwidth_reserved: '50', energy_spent: '0', bandwidth_spent: '0',
    })
    const reservation = await pool.query(
      'SELECT status FROM trc20_token_clone.sponsor_resource_reservations WHERE idempotency_key = $1',
      [fixture.idempotencyKey],
    )
    assert.equal(reservation.rows[0].status, 'manual-review')
  } finally {
    if (fixture) await cleanupFixture(pool, fixture)
    await pool.end()
  }
})
