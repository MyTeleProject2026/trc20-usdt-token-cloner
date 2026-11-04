import pg from 'pg'
import { TronWeb } from 'tronweb'
import { listSponsorChainFeeObservations } from './sponsor-chain-fee-observations.mjs'
import {
  databaseSslConfig,
  initializeDatabase,
  isApprovedSponsorAgreementScope,
  normalizeDatabaseConnectionString,
} from './database.mjs'

const { Pool } = pg
const schema = 'trc20_token_clone'
const TX_PATTERN = /^[0-9a-f]{64}$/i
const KEY_PATTERN = /^[A-Za-z0-9._:-]{24,160}$/
const LINK_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,160}$/
const HEX_ADDRESS_PATTERN = /^[0-9a-f]{40}$/
const HOSTS = Object.freeze({
  nile: 'https://nile.trongrid.io',
  shasta: 'https://api.shasta.trongrid.io',
})

let pool
let readyPromise

function getPool() {
  if (pool) return pool
  const configured = process.env.DATABASE_URL
  if (!configured) return null
  const connectionString = normalizeDatabaseConnectionString(configured)
  pool = new Pool({
    connectionString,
    ssl: databaseSslConfig(connectionString),
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    max: 3,
  })
  pool.on('error', (error) => {
    console.error('Sponsor fee settlement pool error:', error?.code || 'unknown')
  })
  return pool
}

export function normalizeSponsorFeeSettlementIdentity(input = {}) {
  const network = input.network
  const transactionHash = typeof input.transactionHash === 'string'
    ? input.transactionHash.trim().toLowerCase() : ''
  const idempotencyKey = input.idempotencyKey
  if (!['nile', 'shasta'].includes(network)
    || !TX_PATTERN.test(transactionHash)
    || typeof idempotencyKey !== 'string'
    || !KEY_PATTERN.test(idempotencyKey)) {
    return { success: false, reason: 'invalid-fee-settlement-identity' }
  }
  return { success: true, identity: { network, transactionHash, idempotencyKey } }
}

async function initialize(db) {
  await initializeDatabase()
  if (!readyPromise) {
    readyPromise = (async () => {
      const feeLedger = await listSponsorChainFeeObservations({ network: 'nile', limit: 1 })
      if (feeLedger?.success !== true) throw new Error('immutable sponsor fee observation ledger unavailable')
      await db.query(
        'CREATE TABLE IF NOT EXISTS trc20_token_clone.sponsor_chain_fee_settlements ('
        + 'id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,'
        + "network TEXT NOT NULL CHECK (network IN ('nile','shasta')),"
        + 'transaction_hash CHAR(64) NOT NULL,'
        + 'observation_id BIGINT NOT NULL REFERENCES trc20_token_clone.sponsor_chain_fee_observations(id) ON DELETE RESTRICT,'
        + 'idempotency_key TEXT NOT NULL REFERENCES trc20_token_clone.sponsor_transfers(idempotency_key) ON DELETE RESTRICT,'
        + 'budget_id BIGINT NOT NULL REFERENCES trc20_token_clone.sponsor_budgets(id) ON DELETE RESTRICT,'
        + 'sponsor_reference TEXT NOT NULL,'
        + 'sponsor_address TEXT NOT NULL,'
        + 'transaction_owner_address_hex CHAR(40) NOT NULL,'
        + 'trx_fee_payer_address_hex CHAR(40) NOT NULL,'
        + 'settled_fee_sun NUMERIC(78,0) NOT NULL CHECK (settled_fee_sun > 0),'
        + "execution_result TEXT NOT NULL CHECK (execution_result IN ('SUCCESS','FAILED')),"
        + 'block_number BIGINT NOT NULL CHECK (block_number > 0),'
        + 'settlement_reference TEXT NOT NULL UNIQUE,'
        + 'settled_at TIMESTAMPTZ NOT NULL DEFAULT now(),'
        + 'CHECK (transaction_owner_address_hex = trx_fee_payer_address_hex),'
        + 'UNIQUE (network, transaction_hash),'
        + 'UNIQUE (observation_id)'
        + ')',
      )
      await db.query('ALTER TABLE trc20_token_clone.sponsor_chain_fee_settlements ADD COLUMN IF NOT EXISTS fee_reservation_idempotency_key TEXT REFERENCES trc20_token_clone.sponsor_transfers(idempotency_key) ON DELETE RESTRICT')
      await db.query('ALTER TABLE trc20_token_clone.sponsor_chain_fee_settlements ADD COLUMN IF NOT EXISTS reserved_fee_sun NUMERIC(78,0)')
      await db.query('ALTER TABLE trc20_token_clone.sponsor_chain_fee_settlements ADD COLUMN IF NOT EXISTS released_fee_reserve_sun NUMERIC(78,0)')
      await db.query(
        'CREATE TABLE IF NOT EXISTS trc20_token_clone.sponsor_fee_reservation_links ('
        + 'id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,'
        + 'asset_transfer_idempotency_key TEXT NOT NULL UNIQUE REFERENCES trc20_token_clone.sponsor_transfers(idempotency_key) ON DELETE RESTRICT,'
        + 'fee_reservation_idempotency_key TEXT NOT NULL UNIQUE REFERENCES trc20_token_clone.sponsor_transfers(idempotency_key) ON DELETE RESTRICT,'
        + 'budget_id BIGINT NOT NULL REFERENCES trc20_token_clone.sponsor_budgets(id) ON DELETE RESTRICT,'
        + 'sponsor_reference TEXT NOT NULL,'
        + "network TEXT NOT NULL CHECK (network IN ('nile','shasta')),"
        + 'sponsor_address TEXT NOT NULL,'
        + 'reserved_fee_sun NUMERIC(78,0) NOT NULL CHECK (reserved_fee_sun > 0),'
        + 'linked_at TIMESTAMPTZ NOT NULL DEFAULT now(),'
        + 'CHECK (asset_transfer_idempotency_key <> fee_reservation_idempotency_key)'
        + ')',
      )
      await db.query(
        "CREATE OR REPLACE FUNCTION trc20_token_clone.reject_sponsor_fee_reservation_link_mutation() "
        + 'RETURNS trigger LANGUAGE plpgsql AS '
        + "'BEGIN RAISE EXCEPTION ''sponsor fee reservation links are immutable''; RETURN NULL; END;'",
      )
      await db.query('DROP TRIGGER IF EXISTS sponsor_fee_reservation_links_immutable ON trc20_token_clone.sponsor_fee_reservation_links')
      await db.query(
        'CREATE TRIGGER sponsor_fee_reservation_links_immutable '
        + 'BEFORE UPDATE OR DELETE ON trc20_token_clone.sponsor_fee_reservation_links '
        + 'FOR EACH ROW EXECUTE FUNCTION trc20_token_clone.reject_sponsor_fee_reservation_link_mutation()',
      )
      await db.query(
        'CREATE INDEX IF NOT EXISTS idx_ttc_sponsor_fee_settlements_budget '
        + 'ON trc20_token_clone.sponsor_chain_fee_settlements (budget_id, settled_at DESC)',
      )
      await db.query(
        "CREATE OR REPLACE FUNCTION trc20_token_clone.reject_sponsor_chain_fee_settlement_mutation() "
        + 'RETURNS trigger LANGUAGE plpgsql AS '
        + "'BEGIN RAISE EXCEPTION ''sponsor chain fee settlements are immutable''; RETURN NULL; END;'",
      )
      await db.query(
        'DROP TRIGGER IF EXISTS sponsor_chain_fee_settlements_immutable '
        + 'ON trc20_token_clone.sponsor_chain_fee_settlements',
      )
      await db.query(
        'CREATE TRIGGER sponsor_chain_fee_settlements_immutable '
        + 'BEFORE UPDATE OR DELETE ON trc20_token_clone.sponsor_chain_fee_settlements '
        + 'FOR EACH ROW EXECUTE FUNCTION trc20_token_clone.reject_sponsor_chain_fee_settlement_mutation()',
      )
      await db.query(
        "COMMENT ON TABLE trc20_token_clone.sponsor_chain_fee_settlements IS "
        + "'Testnet-only direct TRX-burn settlement. Requires approved network-fee budget wallet to equal the transaction owner/observed burn payer. Does not settle delegated Energy/Bandwidth.'",
      )
    })().catch((error) => {
      readyPromise = undefined
      console.error('Sponsor fee settlement schema initialization failed:', error?.code || 'unknown')
      throw error
    })
  }
  return readyPromise
}

function normalizedHexAddress(tronWeb, address) {
  if (typeof address !== 'string' || !tronWeb.isAddress(address.trim())) return null
  const hex = String(tronWeb.address.toHex(address.trim())).replace(/^41/i, '').toLowerCase()
  return HEX_ADDRESS_PATTERN.test(hex) ? hex : null
}


/**
 * Bind one testnet asset-grant to the exact TRX network-fee reservation that
 * covers its direct transaction-owner burn. The link is one-to-one and immutable.
 */
export async function linkSponsorFeeReservation({
  assetTransferIdempotencyKey,
  feeReservationIdempotencyKey,
} = {}) {
  if (typeof assetTransferIdempotencyKey !== 'string' || !LINK_KEY_PATTERN.test(assetTransferIdempotencyKey)
    || typeof feeReservationIdempotencyKey !== 'string' || !LINK_KEY_PATTERN.test(feeReservationIdempotencyKey)
    || assetTransferIdempotencyKey === feeReservationIdempotencyKey) {
    return { success: false, reason: 'invalid-fee-reservation-link-identity' }
  }
  const db = getPool()
  if (!db) return { success: false, reason: 'database-not-configured' }
  try {
    await initialize(db)
    const tronWeb = new TronWeb({ fullHost: HOSTS.nile })
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const assetResult = await client.query(
        'SELECT idempotency_key, sponsor_reference, sponsor_address, network, purpose, asset, token_contract, status '
        + 'FROM trc20_token_clone.sponsor_transfers WHERE idempotency_key = $1 FOR UPDATE',
        [assetTransferIdempotencyKey],
      )
      const assetTransfer = assetResult.rows[0]
      if (!assetTransfer) {
        await client.query('ROLLBACK')
        return { success: false, reason: 'asset-grant-transfer-not-found' }
      }
      if (!['nile', 'shasta'].includes(assetTransfer.network)
        || assetTransfer.purpose !== 'asset-grant'
        || !['TRX', 'USDT'].includes(assetTransfer.asset)
        || !['pending-review', 'authorized', 'broadcasting', 'submitted', 'confirmed', 'failed'].includes(assetTransfer.status)) {
        await client.query('ROLLBACK')
        return { success: false, reason: 'testnet-asset-grant-transfer-required' }
      }

      const feeResult = await client.query(
        'SELECT idempotency_key, sponsor_reference, sponsor_address, network, purpose, asset, token_contract, '
        + 'amount_base_units::text AS amount_base_units, status '
        + 'FROM trc20_token_clone.sponsor_transfers WHERE idempotency_key = $1 FOR UPDATE',
        [feeReservationIdempotencyKey],
      )
      const feeReservation = feeResult.rows[0]
      if (!feeReservation) {
        await client.query('ROLLBACK')
        return { success: false, reason: 'network-fee-reservation-not-found' }
      }
      if (feeReservation.purpose !== 'network-fee'
        || feeReservation.asset !== 'TRX'
        || feeReservation.token_contract != null
        || !['pending-review', 'fee-settled'].includes(feeReservation.status)
        || feeReservation.network !== assetTransfer.network
        || feeReservation.sponsor_reference !== assetTransfer.sponsor_reference
        || feeReservation.sponsor_address !== assetTransfer.sponsor_address
        || !/^[1-9][0-9]{0,77}$/.test(feeReservation.amount_base_units || '')) {
        await client.query('ROLLBACK')
        return { success: false, reason: 'network-fee-reservation-scope-mismatch' }
      }
      const sponsorHex = normalizedHexAddress(tronWeb, assetTransfer.sponsor_address)
      const feeSponsorHex = normalizedHexAddress(tronWeb, feeReservation.sponsor_address)
      if (!sponsorHex || sponsorHex !== feeSponsorHex) {
        await client.query('ROLLBACK')
        return { success: false, reason: 'fee-reservation-sponsor-wallet-mismatch' }
      }

      const existing = await client.query(
        'SELECT l.id::text AS id, l.asset_transfer_idempotency_key, l.fee_reservation_idempotency_key, '
        + 'l.budget_id::text AS budget_id, l.sponsor_reference, l.network, l.sponsor_address, '
        + 'l.reserved_fee_sun::text AS reserved_fee_sun, b.purpose AS budget_purpose, '
        + 'b.asset AS budget_asset, b.token_contract AS budget_token_contract, b.sponsor_address AS budget_sponsor_address '
        + 'FROM trc20_token_clone.sponsor_fee_reservation_links l '
        + 'JOIN trc20_token_clone.sponsor_budgets b ON b.id = l.budget_id '
        + 'WHERE l.asset_transfer_idempotency_key = $1 OR l.fee_reservation_idempotency_key = $2',
        [assetTransferIdempotencyKey, feeReservationIdempotencyKey],
      )
      if (existing.rows.length) {
        const row = existing.rows[0]
        const identical = existing.rows.length === 1
          && row.asset_transfer_idempotency_key === assetTransferIdempotencyKey
          && row.fee_reservation_idempotency_key === feeReservationIdempotencyKey
          && row.sponsor_reference === assetTransfer.sponsor_reference
          && row.network === assetTransfer.network
          && row.sponsor_address === assetTransfer.sponsor_address
          && row.reserved_fee_sun === feeReservation.amount_base_units
          && row.budget_purpose === 'network-fee'
          && row.budget_asset === 'TRX'
          && row.budget_token_contract == null
          && row.budget_sponsor_address === feeReservation.sponsor_address
        if (!identical) {
          await client.query('ROLLBACK')
          return { success: false, reason: 'fee-reservation-link-conflict' }
        }
        await client.query('COMMIT')
        return { success: true, linked: true, duplicate: true, linkId: row.id, reservedFeeSun: row.reserved_fee_sun }
      }
      if (feeReservation.status !== 'pending-review') {
        await client.query('ROLLBACK')
        return { success: false, reason: 'network-fee-reservation-already-consumed' }
      }

      const budgetResult = await client.query(
        'SELECT id::text AS id, sponsor_reference, sponsor_address, network, purpose, asset, token_contract, '
        + 'budget_base_units::text AS budget_base_units, reserved_base_units::text AS reserved_base_units, '
        + 'spent_base_units::text AS spent_base_units, status, approval_reference, review_reference, approved_at '
        + 'FROM trc20_token_clone.sponsor_budgets '
        + "WHERE sponsor_reference = $1 AND network = $2 AND purpose = 'network-fee' "
        + "AND asset = 'TRX' AND token_contract IS NULL FOR UPDATE",
        [assetTransfer.sponsor_reference, assetTransfer.network],
      )
      const budget = budgetResult.rows[0]
      if (!budget || budget.sponsor_address !== feeReservation.sponsor_address) {
        await client.query('ROLLBACK')
        return { success: false, reason: 'network-fee-budget-not-found-or-mismatched' }
      }
      if (budget.status !== 'active'
        || typeof budget.approval_reference !== 'string' || !budget.approval_reference
        || typeof budget.review_reference !== 'string' || !budget.review_reference
        || budget.approved_at == null
        || !isApprovedSponsorAgreementScope({ consentReference: budget.approval_reference, budget })) {
        await client.query('ROLLBACK')
        return { success: false, reason: 'network-fee-budget-approval-required' }
      }
      const held = BigInt(feeReservation.amount_base_units)
      const reserved = BigInt(budget.reserved_base_units)
      const spent = BigInt(budget.spent_base_units)
      const total = BigInt(budget.budget_base_units)
      if (held <= 0n || reserved < held || reserved + spent > total) {
        await client.query('ROLLBACK')
        return { success: false, reason: 'fee-reservation-budget-hold-mismatch' }
      }

      const inserted = await client.query(
        'INSERT INTO trc20_token_clone.sponsor_fee_reservation_links '
        + '(asset_transfer_idempotency_key, fee_reservation_idempotency_key, budget_id, sponsor_reference, network, sponsor_address, reserved_fee_sun) '
        + 'VALUES ($1,$2,$3::bigint,$4,$5,$6,$7::numeric) RETURNING id::text AS id',
        [assetTransferIdempotencyKey, feeReservationIdempotencyKey, budget.id,
          assetTransfer.sponsor_reference, assetTransfer.network, assetTransfer.sponsor_address, held.toString()],
      )
      const linkReference = 'fee-reservation-link:' + assetTransfer.network + ':' + assetTransferIdempotencyKey
      await client.query(
        'INSERT INTO trc20_token_clone.audit_events (event_type, entity_type, entity_reference, details) '
        + "VALUES ('sponsor-fee-reservation-linked', 'sponsor-fee-reservation-link', $1, $2::jsonb)",
        [linkReference, JSON.stringify({
          assetTransferIdempotencyKey,
          feeReservationIdempotencyKey,
          sponsorReference: assetTransfer.sponsor_reference,
          network: assetTransfer.network,
          sponsorAddress: assetTransfer.sponsor_address,
          feeBudgetId: String(budget.id),
          reservedFeeSun: held.toString(),
          approvalReference: budget.approval_reference,
          reviewReference: budget.review_reference,
        })],
      )
      await client.query('COMMIT')
      return {
        success: true, linked: true, duplicate: false,
        linkId: inserted.rows[0].id,
        reservedFeeSun: held.toString(),
        feeReservationIdempotencyKey,
      }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      if (error?.code === '23505') return { success: false, reason: 'fee-reservation-link-conflict' }
      throw error
    } finally {
      client.release()
    }
  } catch (error) {
    console.error('Sponsor fee reservation link failed:', error?.code || 'unknown')
    return { success: false, reason: 'database-unavailable' }
  }
}

/**
 * Settle only a solidified TRX burn directly charged to the transaction owner.
 * A delegated-resource sponsor whose wallet differs from the transaction owner
 * cannot be inferred from receipt aggregates and is deliberately not settled here.
 */
export async function settleSponsorChainFeeObservation(input = {}) {
  const normalized = normalizeSponsorFeeSettlementIdentity(input)
  if (!normalized.success) return normalized
  const { network, transactionHash, idempotencyKey } = normalized.identity
  const db = getPool()
  if (!db) return { success: false, reason: 'database-not-configured' }

  try {
    await initialize(db)
    const tronWeb = new TronWeb({ fullHost: HOSTS[network] })
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const transferResult = await client.query(
        'SELECT idempotency_key, sponsor_reference, sponsor_address, network, purpose, asset, '
        + 'token_contract, status, transaction_hash '
        + 'FROM trc20_token_clone.sponsor_transfers '
        + 'WHERE idempotency_key = $1 FOR UPDATE',
        [idempotencyKey],
      )
      const transfer = transferResult.rows[0]
      if (!transfer) {
        await client.query('ROLLBACK')
        return { success: false, reason: 'stored-sponsor-transfer-not-found' }
      }
      if (transfer.network !== network
        || transfer.purpose !== 'asset-grant'
        || !['TRX', 'USDT'].includes(transfer.asset)
        || !['submitted', 'confirmed', 'failed'].includes(transfer.status)
        || typeof transfer.transaction_hash !== 'string'
        || transfer.transaction_hash.trim().toLowerCase() !== transactionHash) {
        await client.query('ROLLBACK')
        return { success: false, reason: 'stored-submitted-transfer-identity-mismatch' }
      }

      const transferOwnerHex = normalizedHexAddress(tronWeb, transfer.sponsor_address)
      if (!transferOwnerHex) {
        await client.query('ROLLBACK')
        return { success: false, reason: 'stored-principal-sponsor-address-invalid' }
      }

      const observationResult = await client.query(
        'SELECT id::text AS id, network, transaction_hash, idempotency_key, block_number::text AS block_number, '
        + 'execution_result, transaction_owner_address_hex, trx_fee_payer_address_hex, '
        + 'reported_fee_sun::text AS reported_fee_sun '
        + 'FROM trc20_token_clone.sponsor_chain_fee_observations '
        + 'WHERE network = $1 AND transaction_hash = $2 AND idempotency_key = $3 FOR UPDATE',
        [network, transactionHash, idempotencyKey],
      )
      const observation = observationResult.rows[0]
      if (!observation) {
        await client.query('ROLLBACK')
        return { success: false, reason: 'immutable-chain-fee-observation-required' }
      }
      const ownerHex = String(observation.transaction_owner_address_hex || '').trim().toLowerCase()
      const payerHex = String(observation.trx_fee_payer_address_hex || '').trim().toLowerCase()
      if (observation.network !== network
        || String(observation.transaction_hash).trim().toLowerCase() !== transactionHash
        || observation.idempotency_key !== idempotencyKey
        || !['SUCCESS', 'FAILED'].includes(observation.execution_result)
        || !HEX_ADDRESS_PATTERN.test(ownerHex)
        || ownerHex !== transferOwnerHex) {
        await client.query('ROLLBACK')
        return { success: false, reason: 'transaction-owner-and-fee-payer-evidence-mismatch' }
      }
      if (!/^(0|[1-9][0-9]{0,77})$/.test(observation.reported_fee_sun)) {
        await client.query('ROLLBACK')
        return { success: false, reason: 'invalid-observed-fee-amount' }
      }
      const feeSun = BigInt(observation.reported_fee_sun)
      if (feeSun === 0n) {
        await client.query('ROLLBACK')
        return payerHex
          ? { success: false, reason: 'transaction-owner-and-fee-payer-evidence-mismatch' }
          : { success: false, reason: 'no-trx-burn-to-settle' }
      }
      if (payerHex !== ownerHex) {
        await client.query('ROLLBACK')
        return { success: false, reason: 'transaction-owner-and-fee-payer-evidence-mismatch' }
      }

      const feeLinkResult = await client.query(
        'SELECT l.id::text AS link_id, l.fee_reservation_idempotency_key, l.budget_id::text AS linked_budget_id, '
        + 'l.sponsor_reference AS linked_sponsor_reference, l.network AS linked_network, '
        + 'l.sponsor_address AS linked_sponsor_address, l.reserved_fee_sun::text AS reserved_fee_sun, '
        + 'f.sponsor_reference AS fee_sponsor_reference, f.sponsor_address AS fee_sponsor_address, '
        + 'f.network AS fee_network, f.purpose AS fee_purpose, f.asset AS fee_asset, '
        + 'f.token_contract AS fee_token_contract, f.amount_base_units::text AS fee_amount_base_units, '
        + 'f.status AS fee_reservation_status '
        + 'FROM trc20_token_clone.sponsor_fee_reservation_links l '
        + 'JOIN trc20_token_clone.sponsor_transfers f '
        + 'ON f.idempotency_key = l.fee_reservation_idempotency_key '
        + 'WHERE l.asset_transfer_idempotency_key = $1 FOR UPDATE OF f',
        [idempotencyKey],
      )
      const feeLink = feeLinkResult.rows[0] || null
      if (feeLink && (
        feeLink.linked_sponsor_reference !== transfer.sponsor_reference
        || feeLink.linked_network !== network
        || feeLink.linked_sponsor_address !== transfer.sponsor_address
        || feeLink.fee_sponsor_reference !== transfer.sponsor_reference
        || feeLink.fee_sponsor_address !== transfer.sponsor_address
        || feeLink.fee_network !== network
        || feeLink.fee_purpose !== 'network-fee'
        || feeLink.fee_asset !== 'TRX'
        || feeLink.fee_token_contract != null
        || feeLink.fee_amount_base_units !== feeLink.reserved_fee_sun
        || !['pending-review', 'fee-settled'].includes(feeLink.fee_reservation_status)
        || !/^[1-9][0-9]{0,77}$/.test(feeLink.reserved_fee_sun || '')
      )) {
        await client.query('ROLLBACK')
        return { success: false, reason: 'linked-fee-reservation-identity-mismatch' }
      }

      const feeBudgetResult = await client.query(
        'SELECT id, sponsor_reference, sponsor_address, network, purpose, asset, token_contract, '
        + 'budget_base_units::text AS budget_base_units, reserved_base_units::text AS reserved_base_units, '
        + 'spent_base_units::text AS spent_base_units, status, approval_reference, review_reference, approved_at '
        + 'FROM trc20_token_clone.sponsor_budgets '
        + "WHERE sponsor_reference = $1 AND network = $2 AND purpose = 'network-fee' "
        + "AND asset = 'TRX' AND token_contract IS NULL FOR UPDATE",
        [transfer.sponsor_reference, network],
      )
      const feeBudget = feeBudgetResult.rows[0]
      if (!feeBudget) {
        await client.query('ROLLBACK')
        return { success: false, reason: 'network-fee-budget-not-found' }
      }

      if (feeLink && (
        feeLink.linked_budget_id !== String(feeBudget.id)
        || feeLink.fee_sponsor_address !== feeBudget.sponsor_address
      )) {
        await client.query('ROLLBACK')
        return { success: false, reason: 'linked-fee-reservation-budget-mismatch' }
      }

      const feeSponsorHex = normalizedHexAddress(tronWeb, feeBudget.sponsor_address)
      if (!feeSponsorHex || feeSponsorHex !== payerHex) {
        await client.query('ROLLBACK')
        return {
          success: false,
          reason: 'network-fee-sponsor-is-not-trx-burn-payer',
          delegatedResourceSettlement: false,
        }
      }

      const existingResult = await client.query(
        'SELECT id::text AS id, observation_id::text AS observation_id, idempotency_key, budget_id::text AS budget_id, '
        + 'sponsor_reference, sponsor_address, transaction_owner_address_hex, trx_fee_payer_address_hex, '
        + 'settled_fee_sun::text AS settled_fee_sun, execution_result, block_number::text AS block_number, '
        + 'fee_reservation_idempotency_key, reserved_fee_sun::text AS reserved_fee_sun, '
        + 'released_fee_reserve_sun::text AS released_fee_reserve_sun '
        + 'FROM trc20_token_clone.sponsor_chain_fee_settlements '
        + 'WHERE network = $1 AND transaction_hash = $2 FOR UPDATE',
        [network, transactionHash],
      )
      if (existingResult.rows.length) {
        const existing = existingResult.rows[0]
        const identical = existing.observation_id === observation.id
          && existing.idempotency_key === idempotencyKey
          && existing.budget_id === String(feeBudget.id)
          && existing.sponsor_reference === transfer.sponsor_reference
          && existing.sponsor_address === feeBudget.sponsor_address
          && existing.transaction_owner_address_hex.trim().toLowerCase() === ownerHex
          && existing.trx_fee_payer_address_hex.trim().toLowerCase() === payerHex
          && existing.settled_fee_sun === feeSun.toString()
          && existing.execution_result === observation.execution_result
          && existing.block_number === String(observation.block_number)
          && existing.fee_reservation_idempotency_key === (feeLink?.fee_reservation_idempotency_key ?? null)
          && existing.reserved_fee_sun === (feeLink?.reserved_fee_sun ?? null)
          && (feeLink ? /^[0-9]+$/.test(existing.released_fee_reserve_sun || '') : existing.released_fee_reserve_sun == null)
        if (!identical) {
          await client.query('ROLLBACK')
          return { success: false, reason: 'chain-fee-settlement-conflict' }
        }
        await client.query('COMMIT')
        return {
          success: true, duplicate: true, settled: true,
          settlementId: existing.id, settlementReference: 'trx-fee:' + network + ':' + transactionHash,
          settledFeeSun: feeSun.toString(), feeBudgetSettled: true,
          executionResult: observation.execution_result,
        }
      }

      if (feeLink && feeLink.fee_reservation_status !== 'pending-review') {
        await client.query('ROLLBACK')
        return { success: false, reason: 'linked-fee-reservation-already-consumed' }
      }
      if (feeBudget.status !== 'active') {
        await client.query('ROLLBACK')
        return { success: false, reason: 'network-fee-budget-not-active' }
      }
      if (typeof feeBudget.approval_reference !== 'string' || !feeBudget.approval_reference
        || typeof feeBudget.review_reference !== 'string' || !feeBudget.review_reference
        || feeBudget.approved_at == null
        || !isApprovedSponsorAgreementScope({
          consentReference: feeBudget.approval_reference,
          budget: feeBudget,
        })) {
        await client.query('ROLLBACK')
        return { success: false, reason: 'network-fee-budget-approval-required' }
      }

      const budgetBaseUnits = BigInt(feeBudget.budget_base_units)
      const reservedBaseUnits = BigInt(feeBudget.reserved_base_units)
      const spentBaseUnits = BigInt(feeBudget.spent_base_units)
      let reservedFeeSun = null
      let releasedFeeReserveSun = null
      let updated
      if (feeLink) {
        reservedFeeSun = BigInt(feeLink.reserved_fee_sun)
        if (feeSun > reservedFeeSun) {
          await client.query('ROLLBACK')
          return {
            success: false,
            reason: 'observed-fee-exceeds-linked-reservation',
            requiredFeeSun: feeSun.toString(),
            reservedFeeSun: reservedFeeSun.toString(),
          }
        }
        if (reservedBaseUnits < reservedFeeSun) {
          await client.query('ROLLBACK')
          return { success: false, reason: 'linked-fee-reservation-budget-hold-mismatch' }
        }
        releasedFeeReserveSun = reservedFeeSun - feeSun
        updated = await client.query(
          'UPDATE trc20_token_clone.sponsor_budgets '
          + 'SET reserved_base_units = reserved_base_units - $1::numeric, '
          + 'spent_base_units = spent_base_units + $2::numeric, updated_at = now() '
          + 'WHERE id = $3 AND status = \'active\' AND reserved_base_units >= $1::numeric '
          + 'RETURNING id',
          [reservedFeeSun.toString(), feeSun.toString(), feeBudget.id],
        )
        if (updated.rowCount === 1) {
          const consumed = await client.query(
            'UPDATE trc20_token_clone.sponsor_transfers SET status = \'fee-settled\', updated_at = now() '
            + 'WHERE idempotency_key = $1 AND status = \'pending-review\' RETURNING idempotency_key',
            [feeLink.fee_reservation_idempotency_key],
          )
          if (consumed.rowCount !== 1) {
            await client.query('ROLLBACK')
            return { success: false, reason: 'linked-fee-reservation-state-conflict' }
          }
        }
      } else {
        if (reservedBaseUnits + spentBaseUnits + feeSun > budgetBaseUnits) {
          await client.query('ROLLBACK')
          return {
            success: false,
            reason: 'insufficient-unreserved-network-fee-budget',
            requiredFeeSun: feeSun.toString(),
            availableBaseUnits: (budgetBaseUnits - reservedBaseUnits - spentBaseUnits).toString(),
          }
        }
        updated = await client.query(
          'UPDATE trc20_token_clone.sponsor_budgets '
          + 'SET spent_base_units = spent_base_units + $1::numeric, updated_at = now() '
          + 'WHERE id = $2 AND status = \'active\' '
          + 'RETURNING id',
          [feeSun.toString(), feeBudget.id],
        )
      }
      if (updated.rowCount !== 1) {
        await client.query('ROLLBACK')
        return { success: false, reason: 'network-fee-budget-update-conflict' }
      }

      const settlementReference = 'trx-fee:' + network + ':' + transactionHash
      const inserted = await client.query(
        'INSERT INTO trc20_token_clone.sponsor_chain_fee_settlements '
        + '(network, transaction_hash, observation_id, idempotency_key, budget_id, sponsor_reference, '
        + 'sponsor_address, transaction_owner_address_hex, trx_fee_payer_address_hex, settled_fee_sun, '
        + 'execution_result, block_number, settlement_reference, fee_reservation_idempotency_key, '
        + 'reserved_fee_sun, released_fee_reserve_sun) '
        + 'VALUES ($1,$2,$3::bigint,$4,$5::bigint,$6,$7,$8,$9,$10::numeric,$11,$12::bigint,$13,$14,$15::numeric,$16::numeric) '
        + 'RETURNING id::text AS id',
        [network, transactionHash, observation.id, idempotencyKey, feeBudget.id,
          transfer.sponsor_reference, feeBudget.sponsor_address, ownerHex, payerHex,
          feeSun.toString(), observation.execution_result, observation.block_number, settlementReference,
          feeLink?.fee_reservation_idempotency_key ?? null,
          reservedFeeSun?.toString() ?? null,
          releasedFeeReserveSun?.toString() ?? null],
      )
      await client.query(
        'INSERT INTO trc20_token_clone.audit_events (event_type, entity_type, entity_reference, details) '
        + "VALUES ('sponsor-chain-fee-settled', 'sponsor-chain-fee-settlement', $1, $2::jsonb)",
        [settlementReference, JSON.stringify({
          network,
          transactionHash,
          idempotencyKey,
          sponsorReference: transfer.sponsor_reference,
          feeBudgetId: String(feeBudget.id),
          sponsorAddress: feeBudget.sponsor_address,
          transactionOwnerAddressHex: ownerHex,
          trxFeePayerAddressHex: payerHex,
          settledFeeSun: feeSun.toString(),
          executionResult: observation.execution_result,
          blockNumber: String(observation.block_number),
          evidence: 'immutable-solidified-fee-observation',
          feeBudgetSettled: true,
          feeReservationIdempotencyKey: feeLink?.fee_reservation_idempotency_key ?? null,
          reservedFeeSun: reservedFeeSun?.toString() ?? null,
          releasedFeeReserveSun: releasedFeeReserveSun?.toString() ?? null,
          delegatedResourceSettlement: false,
        })],
      )
      await client.query('COMMIT')
      return {
        success: true, duplicate: false, settled: true,
        settlementId: inserted.rows[0].id, settlementReference,
        settledFeeSun: feeSun.toString(), feeBudgetSettled: true,
        feeReservationIdempotencyKey: feeLink?.fee_reservation_idempotency_key ?? null,
        reservedFeeSun: reservedFeeSun?.toString() ?? null,
        releasedFeeReserveSun: releasedFeeReserveSun?.toString() ?? null,
        executionResult: observation.execution_result,
      }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  } catch (error) {
    console.error('Sponsor chain fee settlement failed:', error?.code || 'unknown')
    return { success: false, reason: 'database-unavailable' }
  }
}

export async function listSponsorChainFeeSettlements({ network = null, limit = 50 } = {}) {
  if (network !== null && !['nile', 'shasta'].includes(network)) {
    return { success: false, reason: 'invalid-network', settlements: [] }
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return { success: false, reason: 'invalid-limit', settlements: [] }
  }
  const db = getPool()
  if (!db) return { success: false, reason: 'database-not-configured', settlements: [] }
  try {
    await initialize(db)
    const result = await db.query(
      'SELECT network, transaction_hash, idempotency_key, sponsor_reference, sponsor_address, '
      + 'transaction_owner_address_hex, trx_fee_payer_address_hex, settled_fee_sun::text AS settled_fee_sun, '
      + 'execution_result, block_number::text AS block_number, settlement_reference, settled_at, '
      + 'fee_reservation_idempotency_key, reserved_fee_sun::text AS reserved_fee_sun, '
      + 'released_fee_reserve_sun::text AS released_fee_reserve_sun '
      + 'FROM trc20_token_clone.sponsor_chain_fee_settlements '
      + 'WHERE ($1::text IS NULL OR network = $1) ORDER BY settled_at DESC, id DESC LIMIT $2',
      [network, limit],
    )
    return { success: true, settlements: result.rows, feeBudgetSettled: true }
  } catch {
    return { success: false, reason: 'database-unavailable', settlements: [] }
  }
}

export async function closeSponsorChainFeeSettlementPool() {
  if (!pool) return
  const current = pool
  pool = undefined
  readyPromise = undefined
  await current.end()
}
