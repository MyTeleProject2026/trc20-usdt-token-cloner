import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { normalizeSponsorChainFeeObservation } from '../server/sponsor-chain-fee-observations.mjs'

const { Pool } = pg
const enabled = process.env.SPONSOR_PG_INTEGRATION === '1'
const databaseUrl = process.env.DATABASE_URL || ''
const ownerHex = '11'.repeat(20)
const txHash = 'ab'.repeat(32)

function observation(overrides = {}) {
  return {
    network: 'nile',
    transactionHash: txHash,
    idempotencyKey: 'fee-observation-unit-test-key-0001',
    blockNumber: 123,
    executionResult: 'FAILED',
    transactionOwnerAddressHex: ownerHex,
    reportedFeeSun: '4200',
    energyFeeSun: '2000',
    netFeeSun: '2200',
    energyUsageTotal: '100',
    energyUsage: '100',
    originEnergyUsage: '0',
    netUsage: '220',
    energyPenaltyTotal: null,
    ...overrides,
  }
}

test('fee observation normalizer records a failed execution without changing its outcome', () => {
  const result = normalizeSponsorChainFeeObservation(observation())
  assert.equal(result.success, true)
  assert.equal(result.observation.executionResult, 'FAILED')
  assert.equal(result.observation.trxFeePayerAddressHex, ownerHex)
  assert.equal(result.observation.accountingClassification, 'trx-burn-payer-observed')
})

test('fee observation normalizer does not invent a TRX payer for zero-fee resource usage', () => {
  const result = normalizeSponsorChainFeeObservation(observation({
    reportedFeeSun: '0', energyFeeSun: '0', netFeeSun: '0',
    trxFeePayerAddressHex: null,
  }))
  assert.equal(result.success, true)
  assert.equal(result.observation.trxFeePayerAddressHex, null)
  assert.equal(result.observation.accountingClassification, 'resource-source-unattributed')
})

test('fee observation normalizer rejects Mainnet, malformed values, and substituted payer claims', () => {
  assert.equal(normalizeSponsorChainFeeObservation(observation({ network: 'mainnet' })).success, false)
  assert.equal(normalizeSponsorChainFeeObservation(observation({ reportedFeeSun: '-1' })).success, false)
  assert.deepEqual(
    normalizeSponsorChainFeeObservation(observation({ reportedFeeSun: '100', energyFeeSun: '101', netFeeSun: '0' })),
    { success: false, reason: 'receipt-fee-components-exceed-total' },
  )
  assert.deepEqual(
    normalizeSponsorChainFeeObservation(observation({ trxFeePayerAddressHex: '22'.repeat(20) })),
    { success: false, reason: 'fee-payer-evidence-mismatch' },
  )
})

test('PostgreSQL stores finalized failed fee observations separately and idempotently', {
  skip: !enabled && 'Set SPONSOR_PG_INTEGRATION=1 with a dedicated sponsor_test DATABASE_URL',
}, async () => {
  const parsed = new URL(databaseUrl)
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ''))
  assert.ok(['localhost', '127.0.0.1', '::1'].includes(parsed.hostname))
  assert.equal(databaseName, 'sponsor_test')

  const { initializeDatabase } = await import('../server/database.mjs')
  const {
    recordSponsorChainFeeObservation,
    listSponsorChainFeeObservations,
    closeSponsorChainFeeObservationPool,
  } = await import('../server/sponsor-chain-fee-observations.mjs')
  const pool = new Pool({ connectionString: databaseUrl })
  const suffix = randomUUID()
  const key = `fee-observation:${suffix}`
  const hash = suffix.replace(/-/g, '').padEnd(64, '0').slice(0, 64)
  try {
    const readiness = await initializeDatabase()
    assert.equal(readiness.ready, true)
    await pool.query(
      `INSERT INTO trc20_token_clone.sponsor_transfers
        (idempotency_key, sponsor_reference, sponsor_address, network, purpose, asset,
         token_contract, receiver_address, amount_base_units, status, transaction_hash)
       VALUES ($1,$2,$3,'nile','asset-grant','TRX',NULL,$4,100,'submitted',$5)`,
      [key, `fee-sponsor-${suffix}`, 'TKbcs8dYuaZT1VdtrKxnVswNg3DKjSs7u2',
        'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp', hash],
    )

    const input = observation({
      transactionHash: hash,
      idempotencyKey: key,
      blockNumber: 321,
      executionResult: 'FAILED',
      reportedFeeSun: '4200',
    })
    const first = await recordSponsorChainFeeObservation(input)
    assert.equal(first.success, true)
    assert.equal(first.duplicate, false)
    assert.equal(first.settled, false)

    const duplicate = await recordSponsorChainFeeObservation(input)
    assert.equal(duplicate.success, true)
    assert.equal(duplicate.duplicate, true)

    const conflict = await recordSponsorChainFeeObservation({ ...input, blockNumber: 322 })
    assert.deepEqual(conflict, { success: false, reason: 'chain-fee-observation-conflict' })

    const stored = await pool.query(
      `SELECT execution_result, reported_fee_sun::text AS fee,
              transaction_owner_address_hex, trx_fee_payer_address_hex,
              accounting_classification
         FROM trc20_token_clone.sponsor_chain_fee_observations
        WHERE network = 'nile' AND transaction_hash = $1`,
      [hash],
    )
    assert.deepEqual(stored.rows[0], {
      execution_result: 'FAILED',
      fee: '4200',
      transaction_owner_address_hex: ownerHex,
      trx_fee_payer_address_hex: ownerHex,
      accounting_classification: 'trx-burn-payer-observed',
    })

    await assert.rejects(
      pool.query(
        `UPDATE trc20_token_clone.sponsor_chain_fee_observations
            SET reported_fee_sun = 1
          WHERE network = 'nile' AND transaction_hash = $1`,
        [hash],
      ),
      /immutable/,
    )

    const transfer = await pool.query(
      `SELECT status FROM trc20_token_clone.sponsor_transfers WHERE idempotency_key = $1`,
      [key],
    )
    assert.equal(transfer.rows[0].status, 'submitted', 'fee observation must not confirm or fail the principal transfer')

    const history = await listSponsorChainFeeObservations({ network: 'nile', limit: 10 })
    assert.equal(history.success, true)
    assert.equal(history.settled, false)
    assert.ok(history.observations.some((item) => item.transaction_hash.trim() === hash))
  } finally {
    await pool.query('ALTER TABLE trc20_token_clone.sponsor_chain_fee_observations DISABLE TRIGGER sponsor_chain_fee_observations_immutable').catch(() => {})
    await pool.query(
      'DELETE FROM trc20_token_clone.sponsor_chain_fee_observations WHERE network = $1 AND transaction_hash = $2',
      ['nile', hash],
    ).catch(() => {})
    await pool.query('ALTER TABLE trc20_token_clone.sponsor_chain_fee_observations ENABLE TRIGGER sponsor_chain_fee_observations_immutable').catch(() => {})
    await pool.query(
      'DELETE FROM trc20_token_clone.audit_events WHERE entity_reference = $1',
      [`nile:${hash}`],
    ).catch(() => {})
    await pool.query('DELETE FROM trc20_token_clone.sponsor_transfers WHERE idempotency_key = $1', [key]).catch(() => {})
    await closeSponsorChainFeeObservationPool().catch(() => {})
    await pool.end()
  }
})
