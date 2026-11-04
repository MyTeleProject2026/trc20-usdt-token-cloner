import pg from 'pg'
import { databaseSslConfig, initializeDatabase, normalizeDatabaseConnectionString } from './database.mjs'

const { Pool } = pg
const schema = 'trc20_token_clone'
let pool
let readyPromise

const TX_PATTERN = /^[0-9a-f]{64}$/i
const KEY_PATTERN = /^[A-Za-z0-9._:-]{24,160}$/
const AMOUNT_PATTERN = /^(0|[1-9][0-9]{0,77})$/
const HEX_ADDRESS_PATTERN = /^[0-9a-f]{40}$/

function getPool() {
  if (pool) return pool
  const configuredConnectionString = process.env.DATABASE_URL
  if (!configuredConnectionString) return null
  const connectionString = normalizeDatabaseConnectionString(configuredConnectionString)
  pool = new Pool({ connectionString, ssl: databaseSslConfig(connectionString), connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000, max: 3 })
  pool.on('error', (error) => {
    console.error('Sponsor fee observation pool error:', error?.code || 'unknown')
  })
  return pool
}

function nullableAmount(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' && AMOUNT_PATTERN.test(value)) return value
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value)
  return undefined
}

export function normalizeSponsorChainFeeObservation(input = {}) {
  const network = input.network
  const transactionHash = typeof input.transactionHash === 'string' ? input.transactionHash.toLowerCase() : ''
  const idempotencyKey = input.idempotencyKey
  const executionResult = input.executionResult
  const transactionOwnerAddressHex = typeof input.transactionOwnerAddressHex === 'string'
    ? input.transactionOwnerAddressHex.replace(/^41/i, '').toLowerCase() : ''
  const reportedFeeSun = nullableAmount(input.reportedFeeSun)
  const amountFields = [
    'energyFeeSun', 'netFeeSun', 'energyUsageTotal', 'energyUsage',
    'originEnergyUsage', 'netUsage', 'energyPenaltyTotal',
  ]
  const amounts = Object.fromEntries(amountFields.map((field) => [field, nullableAmount(input[field] ?? null)]))

  if (!['nile', 'shasta'].includes(network)
    || !TX_PATTERN.test(transactionHash)
    || typeof idempotencyKey !== 'string' || !KEY_PATTERN.test(idempotencyKey)
    || !['SUCCESS', 'FAILED'].includes(executionResult)
    || !Number.isSafeInteger(input.blockNumber) || input.blockNumber <= 0
    || !HEX_ADDRESS_PATTERN.test(transactionOwnerAddressHex)
    || reportedFeeSun == null
    || Object.values(amounts).some((value) => value === undefined)) {
    return { success: false, reason: 'invalid-fee-observation' }
  }

  const componentBurn = BigInt(amounts.energyFeeSun ?? '0') + BigInt(amounts.netFeeSun ?? '0')
  if (componentBurn > BigInt(reportedFeeSun)) return { success: false, reason: 'receipt-fee-components-exceed-total' }

  const positiveBurn = BigInt(reportedFeeSun) > 0n
  const trxFeePayerAddressHex = positiveBurn ? transactionOwnerAddressHex : null
  if (input.trxFeePayerAddressHex !== undefined) {
    const supplied = input.trxFeePayerAddressHex === null ? null
      : typeof input.trxFeePayerAddressHex === 'string'
        ? input.trxFeePayerAddressHex.replace(/^41/i, '').toLowerCase() : undefined
    if (supplied !== trxFeePayerAddressHex) return { success: false, reason: 'fee-payer-evidence-mismatch' }
  }

  const resourceUsage = ['energyUsageTotal', 'energyUsage', 'originEnergyUsage', 'netUsage']
    .some((field) => amounts[field] !== null && BigInt(amounts[field]) > 0n)
  const accountingClassification = positiveBurn
    ? 'trx-burn-payer-observed'
    : resourceUsage ? 'resource-source-unattributed' : 'no-trx-cost-observed'

  return {
    success: true,
    observation: {
      network, transactionHash, idempotencyKey, blockNumber: input.blockNumber,
      executionResult, transactionOwnerAddressHex,
      trxFeePayerAddressHex, reportedFeeSun,
      ...amounts, accountingClassification,
    },
  }
}

async function initialize(poolClient) {
  await initializeDatabase()
  if (!readyPromise) {
    readyPromise = (async () => {
      await poolClient.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`)
      await poolClient.query(`
        CREATE TABLE IF NOT EXISTS ${schema}.sponsor_chain_fee_observations (
          id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          network TEXT NOT NULL CHECK (network IN ('nile','shasta')),
          transaction_hash CHAR(64) NOT NULL,
          idempotency_key TEXT NOT NULL REFERENCES ${schema}.sponsor_transfers(idempotency_key) ON DELETE RESTRICT,
          block_number BIGINT NOT NULL CHECK (block_number > 0),
          execution_result TEXT NOT NULL CHECK (execution_result IN ('SUCCESS','FAILED')),
          transaction_owner_address_hex CHAR(40) NOT NULL,
          trx_fee_payer_address_hex CHAR(40),
          reported_fee_sun NUMERIC(78,0) NOT NULL CHECK (reported_fee_sun >= 0),
          energy_fee_sun NUMERIC(78,0),
          net_fee_sun NUMERIC(78,0),
          energy_usage_total NUMERIC(78,0),
          energy_usage NUMERIC(78,0),
          origin_energy_usage NUMERIC(78,0),
          net_usage NUMERIC(78,0),
          energy_penalty_total NUMERIC(78,0),
          accounting_classification TEXT NOT NULL CHECK (accounting_classification IN (
            'trx-burn-payer-observed','resource-source-unattributed','no-trx-cost-observed'
          )),
          evidence_source TEXT NOT NULL DEFAULT 'Tatum TRON SolidityNode transaction body and receipt',
          observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          CHECK ((reported_fee_sun > 0 AND trx_fee_payer_address_hex = transaction_owner_address_hex)
            OR (reported_fee_sun = 0 AND trx_fee_payer_address_hex IS NULL)),
          UNIQUE (network, transaction_hash)
        )
      `)
      await poolClient.query(`CREATE INDEX IF NOT EXISTS idx_ttc_sponsor_chain_fee_observations_created
        ON ${schema}.sponsor_chain_fee_observations (network, observed_at DESC)`)
      await poolClient.query(`
        CREATE OR REPLACE FUNCTION ${schema}.reject_sponsor_chain_fee_observation_mutation()
        RETURNS trigger LANGUAGE plpgsql
        AS 'BEGIN
          RAISE EXCEPTION ''sponsor chain fee observations are immutable'';
          RETURN NULL;
        END;';
      `)
      await poolClient.query(`
        DROP TRIGGER IF EXISTS sponsor_chain_fee_observations_immutable
          ON ${schema}.sponsor_chain_fee_observations
      `)
      await poolClient.query(`
        CREATE TRIGGER sponsor_chain_fee_observations_immutable
        BEFORE UPDATE OR DELETE ON ${schema}.sponsor_chain_fee_observations
        FOR EACH ROW EXECUTE FUNCTION ${schema}.reject_sponsor_chain_fee_observation_mutation()
      `)
      await poolClient.query(`COMMENT ON TABLE ${schema}.sponsor_chain_fee_observations IS
        'TRC20 Token Clone project only: immutable testnet fee observations, including failed executions. Not proof of separate sponsor debit and never settles a fee budget.'`)
    })().catch((error) => {
      readyPromise = undefined
      console.error('Sponsor fee observation schema initialization failed:', error?.code || 'unknown')
      throw error
    })
  }
  return readyPromise
}

export async function recordSponsorChainFeeObservation(input = {}) {
  const normalized = normalizeSponsorChainFeeObservation(input)
  if (!normalized.success) return normalized
  const db = getPool()
  if (!db) return { success: false, reason: 'database-not-configured' }
  const observation = normalized.observation
  try {
    await initialize(db)
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const transferResult = await client.query(
        `SELECT network, transaction_hash, status
           FROM ${schema}.sponsor_transfers
          WHERE idempotency_key = $1
          FOR UPDATE`,
        [observation.idempotencyKey],
      )
      const transfer = transferResult.rows[0]
      if (!transfer) {
        await client.query('ROLLBACK')
        return { success: false, reason: 'stored-sponsor-transfer-not-found' }
      }
      if (!['nile', 'shasta'].includes(transfer.network)
        || transfer.network !== observation.network
        || transfer.transaction_hash?.trim().toLowerCase() !== observation.transactionHash
        || !['submitted', 'confirmed'].includes(transfer.status)) {
        await client.query('ROLLBACK')
        return { success: false, reason: 'stored-submitted-transfer-identity-mismatch' }
      }

      const values = [
        observation.network, observation.transactionHash, observation.idempotencyKey,
        observation.blockNumber, observation.executionResult, observation.transactionOwnerAddressHex,
        observation.trxFeePayerAddressHex, observation.reportedFeeSun, observation.energyFeeSun,
        observation.netFeeSun, observation.energyUsageTotal, observation.energyUsage,
        observation.originEnergyUsage, observation.netUsage, observation.energyPenaltyTotal,
        observation.accountingClassification,
      ]
      const inserted = await client.query(
        `INSERT INTO ${schema}.sponsor_chain_fee_observations
          (network, transaction_hash, idempotency_key, block_number, execution_result,
           transaction_owner_address_hex, trx_fee_payer_address_hex, reported_fee_sun,
           energy_fee_sun, net_fee_sun, energy_usage_total, energy_usage, origin_energy_usage,
           net_usage, energy_penalty_total, accounting_classification)
         VALUES (${values.map((_, index) => '$' + (index + 1)).join(',')})
         ON CONFLICT (network, transaction_hash) DO NOTHING
         RETURNING id::text AS id`,
        values,
      )
      if (!inserted.rowCount) {
        const existingResult = await client.query(
          `SELECT id::text AS id, idempotency_key, block_number, execution_result,
                  transaction_owner_address_hex, trx_fee_payer_address_hex,
                  reported_fee_sun::text AS reported_fee_sun,
                  energy_fee_sun::text AS energy_fee_sun, net_fee_sun::text AS net_fee_sun,
                  energy_usage_total::text AS energy_usage_total, energy_usage::text AS energy_usage,
                  origin_energy_usage::text AS origin_energy_usage, net_usage::text AS net_usage,
                  energy_penalty_total::text AS energy_penalty_total, accounting_classification
             FROM ${schema}.sponsor_chain_fee_observations
            WHERE network = $1 AND transaction_hash = $2
            FOR UPDATE`,
          [observation.network, observation.transactionHash],
        )
        const row = existingResult.rows[0]
        const comparable = row && [
          row.idempotency_key, String(row.block_number), row.execution_result,
          row.transaction_owner_address_hex.trim(), row.trx_fee_payer_address_hex?.trim() ?? null,
          row.reported_fee_sun, row.energy_fee_sun, row.net_fee_sun, row.energy_usage_total,
          row.energy_usage, row.origin_energy_usage, row.net_usage, row.energy_penalty_total,
          row.accounting_classification,
        ]
        const expected = [
          observation.idempotencyKey, String(observation.blockNumber), observation.executionResult,
          observation.transactionOwnerAddressHex, observation.trxFeePayerAddressHex,
          observation.reportedFeeSun, observation.energyFeeSun, observation.netFeeSun,
          observation.energyUsageTotal, observation.energyUsage, observation.originEnergyUsage,
          observation.netUsage, observation.energyPenaltyTotal, observation.accountingClassification,
        ]
        if (!comparable || comparable.some((value, index) => value !== expected[index])) {
          await client.query('ROLLBACK')
          return { success: false, reason: 'chain-fee-observation-conflict' }
        }
        await client.query('COMMIT')
        return { success: true, duplicate: true, observationId: row.id, settled: false }
      }

      await client.query(
        `INSERT INTO ${schema}.audit_events (event_type, entity_type, entity_reference, details)
         VALUES ('sponsor-chain-fee-observed', 'sponsor-chain-fee-observation', $1, $2::jsonb)`,
        [`${observation.network}:${observation.transactionHash}`, JSON.stringify({
          network: observation.network, transactionHash: observation.transactionHash,
          idempotencyKey: observation.idempotencyKey, blockNumber: observation.blockNumber,
          executionResult: observation.executionResult, reportedFeeSun: observation.reportedFeeSun,
          accountingClassification: observation.accountingClassification,
          feeBudgetSettled: false,
        })],
      )
      await client.query('COMMIT')
      return { success: true, duplicate: false, observationId: inserted.rows[0].id, settled: false }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      console.error('Sponsor fee observation persistence failed:', error?.code || 'unknown')
      return { success: false, reason: 'database-unavailable' }
    } finally {
      client.release()
    }
  } catch {
    return { success: false, reason: 'database-unavailable' }
  }
}

export async function listSponsorChainFeeObservations({ network = null, limit = 50 } = {}) {
  if (network !== null && !['nile', 'shasta'].includes(network)) {
    return { success: false, reason: 'invalid-network', observations: [] }
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return { success: false, reason: 'invalid-limit', observations: [] }
  }
  const db = getPool()
  if (!db) return { success: false, reason: 'database-not-configured', observations: [] }
  try {
    await initialize(db)
    const result = await db.query(
      `SELECT network, transaction_hash, idempotency_key, block_number, execution_result,
              transaction_owner_address_hex, trx_fee_payer_address_hex,
              reported_fee_sun::text AS reported_fee_sun, energy_fee_sun::text AS energy_fee_sun,
              net_fee_sun::text AS net_fee_sun, energy_usage_total::text AS energy_usage_total,
              energy_usage::text AS energy_usage, origin_energy_usage::text AS origin_energy_usage,
              net_usage::text AS net_usage, energy_penalty_total::text AS energy_penalty_total,
              accounting_classification, evidence_source, observed_at
         FROM ${schema}.sponsor_chain_fee_observations
        WHERE ($1::text IS NULL OR network = $1)
        ORDER BY observed_at DESC, id DESC
        LIMIT $2`,
      [network, limit],
    )
    return { success: true, observations: result.rows, settled: false }
  } catch {
    return { success: false, reason: 'database-unavailable', observations: [] }
  }
}

export async function closeSponsorChainFeeObservationPool() {
  if (!pool) return
  const current = pool
  pool = undefined
  readyPromise = undefined
  await current.end()
}
