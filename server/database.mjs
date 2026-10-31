import pg from 'pg'
import { createHash } from 'node:crypto'
import { createSponsorFundingReader } from './sponsor-funding.mjs'
import { reconcileSponsorBudgets } from './sponsor-reconciliation.mjs'
import { isPositiveUint256 } from './base-units.mjs'
import { isValidTronAddress } from './tron-address.mjs'
import { evaluateSponsorResourceCostSettlement, findApprovedSponsorResourceMandate } from './sponsor-resource-cost-settlement.mjs'

const { Pool } = pg
const schema = 'trc20_token_clone'
const readSponsorFundingStatusForReservation = createSponsorFundingReader()
const SPONSOR_CHAIN_SNAPSHOT_SOURCE = 'Tatum TRON SolidityNode account and constant-contract queries'
const SPONSORED_TOKEN_ASSETS = new Set(['USDT'])
const OFFICIAL_MAINNET_USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'

export function isSponsorTokenContractAllowed(network, asset, tokenContract, configuredContracts = []) {
  if (!['mainnet', 'shasta', 'nile'].includes(network)
    || !SPONSORED_TOKEN_ASSETS.has(asset)
    || typeof tokenContract !== 'string' || !tokenContract.trim()) return false
  if (asset === 'USDT' && network === 'mainnet') return tokenContract.trim() === OFFICIAL_MAINNET_USDT_CONTRACT
  // Non-mainnet USDT-labelled test assets require an explicit network-scoped allowlist.
  // They are test assets only and are not Tether-issued Mainnet USDT.
  return Array.isArray(configuredContracts) && configuredContracts.some((item) => typeof item === 'string' && item.trim() === tokenContract.trim())
}

function configuredSponsorTokenContracts(network, asset) {
  return (process.env[`SPONSOR_${asset}_${network.toUpperCase()}_CONTRACTS`] || '')
    .split(',').map((item) => item.trim()).filter(Boolean)
}

function isConfiguredSponsorTokenContractAllowed(network, asset, tokenContract) {
  return isSponsorTokenContractAllowed(network, asset, tokenContract, configuredSponsorTokenContracts(network, asset))
}
let pool
let initPromise

/**
 * Render's same-region internal Postgres host uses private networking and can
 * present a self-signed certificate. Render documents that TLS is optional on
 * internal URLs; do not force strict public-CA validation for those hosts.
 * External hosts keep strict certificate verification when DATABASE_SSL=true.
 */
export function isRenderInternalDatabaseUrl(connectionString) {
  try {
    const host = new URL(connectionString).hostname.toLowerCase()
    return /^dpg-[a-z0-9-]+$/.test(host)
  } catch {
    return false
  }
}

export function normalizeDatabaseConnectionString(connectionString) {
  // Render's internal URL runs over its private network. Internal Postgres
  // TLS uses self-signed certificates and is optional; remove any sslmode query
  // copied from an external URL so node-postgres does not re-enable TLS.
  if (!isRenderInternalDatabaseUrl(connectionString)) return connectionString
  try {
    const url = new URL(connectionString)
    url.searchParams.delete('sslmode')
    url.searchParams.delete('ssl')
    url.searchParams.delete('sslcert')
    url.searchParams.delete('sslkey')
    url.searchParams.delete('sslrootcert')
    return url.toString()
  } catch {
    return connectionString
  }
}

export function databaseSslConfig(connectionString, env = process.env) {
  if (env.DATABASE_SSL !== 'true') return undefined
  if (isRenderInternalDatabaseUrl(connectionString)) return undefined
  return { rejectUnauthorized: true }
}

function getPool() {
  if (pool) return pool
  const configuredConnectionString = process.env.DATABASE_URL
  if (!configuredConnectionString) return null
  const connectionString = normalizeDatabaseConnectionString(configuredConnectionString)
  pool = new Pool({
    connectionString,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    max: 5,
    ssl: databaseSslConfig(connectionString),
  })
  pool.on('error', (error) => {
    // Never log connection strings or provider details that might include secrets.
    console.error('PostgreSQL idle client error:', error?.code || 'unknown')
  })
  return pool
}

export async function initializeDatabase() {
  const db = getPool()
  if (!db) return { configured: false, ready: false }
  if (!initPromise) {
    initPromise = (async () => {
      await db.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`)
      // Wallet auth stores only the public address, origin, expiry and hashes of
      // one-time challenge/session secrets. Raw bearer tokens and private keys
      // are never persisted. Sessions are shared across Render instances/restarts.
      await db.query(`
        CREATE TABLE IF NOT EXISTS ${schema}.wallet_auth_accounts (
          id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          network TEXT NOT NULL CHECK (network IN ('mainnet','nile','shasta')),
          wallet_address TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          last_authenticated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (network, wallet_address)
        )
      `)
      await db.query(`
        CREATE TABLE IF NOT EXISTS ${schema}.wallet_auth_challenges (
          nonce_hash CHAR(64) PRIMARY KEY,
          wallet_address TEXT NOT NULL,
          network TEXT NOT NULL CHECK (network IN ('mainnet','nile','shasta')),
          origin TEXT NOT NULL,
          message_hash CHAR(64) NOT NULL,
          issued_at TIMESTAMPTZ NOT NULL,
          expires_at TIMESTAMPTZ NOT NULL,
          consumed_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `)
      await db.query(`ALTER TABLE ${schema}.wallet_auth_challenges ADD COLUMN IF NOT EXISTS issued_at TIMESTAMPTZ`)
      await db.query(`ALTER TABLE ${schema}.wallet_auth_challenges ADD COLUMN IF NOT EXISTS message_hash CHAR(64)`)
      // One-use challenges are ephemeral. Invalidate any challenge from the old
      // raw-message schema or the intermediate nonce-only schema, then drop the
      // stored text. New rows retain only hashes plus public metadata/timestamps.
      await db.query(`DELETE FROM ${schema}.wallet_auth_challenges WHERE issued_at IS NULL OR message_hash IS NULL`)
      await db.query(`ALTER TABLE ${schema}.wallet_auth_challenges DROP COLUMN IF EXISTS challenge_message`)
      await db.query(`ALTER TABLE ${schema}.wallet_auth_challenges ALTER COLUMN issued_at SET NOT NULL`)
      await db.query(`ALTER TABLE ${schema}.wallet_auth_challenges ALTER COLUMN message_hash SET NOT NULL`)
      await db.query(`ALTER TABLE ${schema}.wallet_auth_challenges ADD COLUMN IF NOT EXISTS consumed_at TIMESTAMPTZ`)
      await db.query(`CREATE INDEX IF NOT EXISTS idx_ttc_wallet_auth_challenges_expiry
        ON ${schema}.wallet_auth_challenges (expires_at)`)
      await db.query(`CREATE INDEX IF NOT EXISTS idx_ttc_wallet_auth_challenges_rate
        ON ${schema}.wallet_auth_challenges (network, wallet_address, origin, created_at DESC)`)
      await db.query(`
        CREATE TABLE IF NOT EXISTS ${schema}.wallet_auth_sessions (
          token_hash CHAR(64) PRIMARY KEY,
          wallet_address TEXT NOT NULL,
          network TEXT NOT NULL CHECK (network IN ('mainnet','nile','shasta')),
          origin TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          expires_at TIMESTAMPTZ NOT NULL
        )
      `)
      await db.query(`CREATE INDEX IF NOT EXISTS idx_ttc_wallet_auth_sessions_expiry
        ON ${schema}.wallet_auth_sessions (expires_at)`)
      // Expand identity scope from testnets to Mainnet without resetting existing accounts.
      // Recreate named constraints idempotently so services deployed before this migration
      // can safely keep their existing wallet records and active sessions.
      await db.query(`ALTER TABLE ${schema}.wallet_auth_accounts DROP CONSTRAINT IF EXISTS wallet_auth_accounts_network_check`)
      await db.query(`ALTER TABLE ${schema}.wallet_auth_accounts ADD CONSTRAINT wallet_auth_accounts_network_check CHECK (network IN ('mainnet','nile','shasta'))`)
      await db.query(`ALTER TABLE ${schema}.wallet_auth_challenges DROP CONSTRAINT IF EXISTS wallet_auth_challenges_network_check`)
      await db.query(`ALTER TABLE ${schema}.wallet_auth_challenges ADD CONSTRAINT wallet_auth_challenges_network_check CHECK (network IN ('mainnet','nile','shasta'))`)
      await db.query(`ALTER TABLE ${schema}.wallet_auth_sessions DROP CONSTRAINT IF EXISTS wallet_auth_sessions_network_check`)
      await db.query(`ALTER TABLE ${schema}.wallet_auth_sessions ADD CONSTRAINT wallet_auth_sessions_network_check CHECK (network IN ('mainnet','nile','shasta'))`)
      await db.query(`
        CREATE TABLE IF NOT EXISTS ${schema}.token_deployments (
          id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          network TEXT NOT NULL,
          token_name TEXT NOT NULL,
          token_symbol TEXT NOT NULL,
          decimals SMALLINT NOT NULL CHECK (decimals = 18),
          total_supply_base_units NUMERIC(78,0) NOT NULL CHECK (total_supply_base_units > 0),
          contract_address TEXT,
          deployer_address TEXT,
          transaction_hash CHAR(64),
          deployment_status TEXT NOT NULL DEFAULT 'submitted'
            CHECK (deployment_status IN ('submitted','confirmed','failed','unverified')),
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (network, transaction_hash)
        )
      `)
      await db.query(`
        CREATE TABLE IF NOT EXISTS ${schema}.transfer_verifications (
          id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          network TEXT NOT NULL DEFAULT 'TRON',
          transaction_hash CHAR(64) NOT NULL,
          token_contract TEXT NOT NULL,
          from_address TEXT NOT NULL,
          to_address TEXT NOT NULL,
          amount_base_units NUMERIC(78,0) NOT NULL CHECK (amount_base_units > 0),
          verification_status TEXT NOT NULL
            CHECK (verification_status IN ('verified-on-chain','not-verified','awaiting-solidification','awaiting-solidified-receipt','provider-error')),
          block_number BIGINT,
          log_index INTEGER NOT NULL DEFAULT 0 CHECK (log_index >= 0),
          result JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (network, transaction_hash, token_contract, log_index)
        )
      `)
      // Event-level identity migration. Existing rows predate log-index tracking;
      // preserve them as event 0, then replace the coarser transaction-level key.
      await db.query(`ALTER TABLE ${schema}.transfer_verifications ADD COLUMN IF NOT EXISTS log_index INTEGER NOT NULL DEFAULT 0 CHECK (log_index >= 0)`)
      await db.query(`ALTER TABLE ${schema}.transfer_verifications DROP CONSTRAINT IF EXISTS transfer_verifications_network_transaction_hash_token_contract_key`)
      await db.query(`DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'transfer_verifications_network_transaction_hash_token_contract_log_index_key'
            AND conrelid = '${schema}.transfer_verifications'::regclass
        ) THEN
          ALTER TABLE ${schema}.transfer_verifications
          ADD CONSTRAINT transfer_verifications_network_transaction_hash_token_contract_log_index_key
          UNIQUE (network, transaction_hash, token_contract, log_index);
        END IF;
      END; $$`)
      await db.query(`COMMENT ON COLUMN ${schema}.transfer_verifications.log_index IS 'Zero-based index of the exact matching TRC20 Transfer event in the transaction receipt.'`)
      // Older installations may have a legacy DEFAULT 'TRON'. Drop it so
      // any future direct insert must name its network explicitly. Existing
      // legacy rows are intentionally not relabelled: their chain is unknown.
      await db.query(`ALTER TABLE ${schema}.transfer_verifications ALTER COLUMN network DROP DEFAULT`)
      await db.query(`COMMENT ON COLUMN ${schema}.transfer_verifications.network IS 'Explicit chain environment: mainnet, shasta, or nile. Legacy TRON values are unclassified and must not be assumed to mean Mainnet.'`)
      await db.query(`
        CREATE TABLE IF NOT EXISTS ${schema}.tracked_wallets (
          id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          network TEXT NOT NULL,
          wallet_address TEXT NOT NULL,
          display_label TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (network, wallet_address)
        )
      `)
      // Do not let new watchlist rows silently inherit an ambiguous legacy network.
      await db.query(`ALTER TABLE ${schema}.tracked_wallets ALTER COLUMN network DROP DEFAULT`)

      await db.query(`
        CREATE TABLE IF NOT EXISTS ${schema}.receiver_history_events (
          id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          network TEXT NOT NULL CHECK (network IN ('mainnet','shasta','nile')),
          wallet_address TEXT NOT NULL,
          event_key CHAR(64) NOT NULL,
          transaction_hash CHAR(64) NOT NULL,
          token_contract TEXT NOT NULL,
          from_address TEXT NOT NULL,
          to_address TEXT NOT NULL,
          amount_base_units NUMERIC(78,0) NOT NULL CHECK (amount_base_units > 0),
          token_name TEXT,
          token_symbol TEXT,
          token_decimals SMALLINT,
          event_index TEXT,
          block_timestamp BIGINT NOT NULL,
          verification_status TEXT NOT NULL DEFAULT 'indexed-candidate-awaiting-solidified-verification'
            CHECK (verification_status IN ('indexed-candidate-awaiting-solidified-verification','verified-on-chain','not-verified','awaiting-solidified-receipt','provider-error')),
          verified_on_chain BOOLEAN NOT NULL DEFAULT FALSE,
          verification_result JSONB,
          first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (network, wallet_address, event_key)
        )
      `)
      await db.query(`CREATE INDEX IF NOT EXISTS idx_ttc_receiver_history_wallet_time
        ON ${schema}.receiver_history_events (network, wallet_address, block_timestamp DESC)`)

      // Sponsor accounting groundwork only: these tables do not enable payments.
      // Amounts are exact integer base units; no wallet secrets are stored.
      await db.query(`
        CREATE TABLE IF NOT EXISTS ${schema}.native_transfer_verifications (
          id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          network TEXT NOT NULL CHECK (network IN ('mainnet','shasta','nile')),
          transaction_hash CHAR(64) NOT NULL,
          from_address TEXT NOT NULL,
          to_address TEXT NOT NULL,
          amount_sun NUMERIC(78,0) NOT NULL CHECK (amount_sun > 0),
          block_number BIGINT NOT NULL CHECK (block_number > 0),
          verification_status TEXT NOT NULL CHECK (verification_status IN ('verified-on-chain')),
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (network, transaction_hash)
        )
      `)
      await db.query(`
        CREATE TABLE IF NOT EXISTS ${schema}.sponsor_budgets (
          id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          sponsor_reference TEXT NOT NULL,
          network TEXT NOT NULL CHECK (network IN ('mainnet','shasta','nile')),
          asset TEXT NOT NULL CHECK (asset IN ('TRX','USDT')),
          token_contract TEXT,
          purpose TEXT NOT NULL DEFAULT 'asset-grant' CHECK (purpose IN ('network-fee','asset-grant')),
          budget_base_units NUMERIC(78,0) NOT NULL CHECK (budget_base_units >= 0),
          reserved_base_units NUMERIC(78,0) NOT NULL DEFAULT 0 CHECK (reserved_base_units >= 0),
          spent_base_units NUMERIC(78,0) NOT NULL DEFAULT 0 CHECK (spent_base_units >= 0),
          status TEXT NOT NULL DEFAULT 'disabled'
            CHECK (status IN ('disabled','pending-review','active','paused','depleted')),
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          CHECK (reserved_base_units + spent_base_units <= budget_base_units)
        )
      `)
      await db.query(`ALTER TABLE ${schema}.sponsor_budgets ADD COLUMN IF NOT EXISTS sponsor_address TEXT`)
      await db.query(`ALTER TABLE ${schema}.sponsor_budgets ADD COLUMN IF NOT EXISTS approval_reference TEXT`)
      await db.query(`ALTER TABLE ${schema}.sponsor_budgets ADD COLUMN IF NOT EXISTS review_reference TEXT`)
      await db.query(`ALTER TABLE ${schema}.sponsor_budgets ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ`)
      // Keep fee/resource budgets independent from asset principal budgets. Existing
      // rows default to asset-grant; fee sponsorship requires its own explicit budget.
      await db.query(`ALTER TABLE ${schema}.sponsor_budgets ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'asset-grant' CHECK (purpose IN ('network-fee','asset-grant'))`)
      // Keep fee/resource budgets native-TRX-only. NOT VALID allows legacy rows to be audited
      // separately; new and updated rows are checked immediately.
      await db.query(`DO $sponsor_fee_budget$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'sponsor_budgets_network_fee_requires_trx'
            AND conrelid = '${schema}.sponsor_budgets'::regclass
        ) THEN
          ALTER TABLE ${schema}.sponsor_budgets
          ADD CONSTRAINT sponsor_budgets_network_fee_requires_trx
          CHECK (purpose <> 'network-fee' OR asset = 'TRX') NOT VALID;
        END IF;
      END; $sponsor_fee_budget$`)
      // Keep legacy VTRC rows readable for historical audit. The supported-asset-only
      // NOT VALID checks added below reject all new/updated rows outside TRX and USDT.
      await db.query(`ALTER TABLE ${schema}.sponsor_budgets DROP CONSTRAINT IF EXISTS sponsor_budgets_asset_check`)
      await db.query(`ALTER TABLE ${schema}.sponsor_budgets ADD CONSTRAINT sponsor_budgets_asset_check CHECK (asset IN ('TRX','USDT','VTRC'))`)
      // Native TRX has no token contract; a token budget must identify its exact contract.
      await db.query(`DO $sponsor_budget_contract$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'sponsor_budgets_asset_contract_shape'
            AND conrelid = '${schema}.sponsor_budgets'::regclass
        ) THEN
          ALTER TABLE ${schema}.sponsor_budgets
          ADD CONSTRAINT sponsor_budgets_asset_contract_shape
          CHECK ((asset = 'TRX' AND token_contract IS NULL)
            OR (asset IN ('USDT','VTRC') AND token_contract IS NOT NULL AND length(btrim(token_contract)) > 0)) NOT VALID;
        END IF;
      END; $sponsor_budget_contract$`)
      // NOT VALID leaves old VTRC rows readable, but PostgreSQL rejects all new or updated
      // rows outside the actively supported native TRX / USDT asset set.
      await db.query(`DO $sponsor_budget_supported_asset$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'sponsor_budgets_supported_asset_only'
            AND conrelid = '${schema}.sponsor_budgets'::regclass
        ) THEN
          ALTER TABLE ${schema}.sponsor_budgets
          ADD CONSTRAINT sponsor_budgets_supported_asset_only
          CHECK (asset IN ('TRX','USDT')) NOT VALID;
        END IF;
      END; $sponsor_budget_supported_asset$`)
      // One sponsor may have independent budgets for each network/purpose/asset/contract.
      // Migrate the earlier one-budget-per-sponsor constraint without exposing secrets.
      await db.query(`ALTER TABLE ${schema}.sponsor_budgets DROP CONSTRAINT IF EXISTS sponsor_budgets_sponsor_reference_key`)
      await db.query(`DROP INDEX IF EXISTS ${schema}.idx_ttc_sponsor_budget_identity`)
      await db.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_ttc_sponsor_budget_identity
          ON ${schema}.sponsor_budgets (sponsor_reference, network, purpose, asset, COALESCE(token_contract, ''))
      `)
      await db.query(`
        CREATE TABLE IF NOT EXISTS ${schema}.sponsor_transfers (
          id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          idempotency_key TEXT NOT NULL UNIQUE,
          sponsor_reference TEXT NOT NULL,
          network TEXT NOT NULL CHECK (network IN ('mainnet','shasta','nile')),
          purpose TEXT NOT NULL CHECK (purpose IN ('network-fee','asset-grant')),
          asset TEXT NOT NULL CHECK (asset IN ('TRX','USDT')),
          token_contract TEXT,
          receiver_address TEXT NOT NULL,
          amount_base_units NUMERIC(78,0) NOT NULL CHECK (amount_base_units > 0),
          status TEXT NOT NULL DEFAULT 'pending-review'
            CHECK (status IN ('pending-review','authorized','submitted','confirmed','failed','cancelled')),
          transaction_hash CHAR(64),
          authorization_reference TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `)
      await db.query(`ALTER TABLE ${schema}.sponsor_transfers ADD COLUMN IF NOT EXISTS prepared_transaction JSONB`)
      await db.query(`ALTER TABLE ${schema}.sponsor_transfers ADD COLUMN IF NOT EXISTS prepared_raw_data_hex TEXT`)
      await db.query(`ALTER TABLE ${schema}.sponsor_transfers ADD COLUMN IF NOT EXISTS prepared_txid CHAR(64)`)
      await db.query(`ALTER TABLE ${schema}.sponsor_transfers DROP CONSTRAINT IF EXISTS sponsor_transfers_status_check`)
      await db.query(`ALTER TABLE ${schema}.sponsor_transfers
        ADD CONSTRAINT sponsor_transfers_status_check
        CHECK (status IN ('pending-review','authorized','broadcasting','submitted','confirmed','failed','cancelled'))`)
      await db.query(`ALTER TABLE ${schema}.sponsor_transfers DROP CONSTRAINT IF EXISTS sponsor_transfers_asset_check`)
      await db.query(`ALTER TABLE ${schema}.sponsor_transfers ADD CONSTRAINT sponsor_transfers_asset_check CHECK (asset IN ('TRX','USDT','VTRC'))`)
      // The transfer ledger must preserve fee/principal separation and exact token identity too.
      await db.query(`DO $sponsor_transfer_fee$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'sponsor_transfers_network_fee_requires_trx'
            AND conrelid = '${schema}.sponsor_transfers'::regclass
        ) THEN
          ALTER TABLE ${schema}.sponsor_transfers
          ADD CONSTRAINT sponsor_transfers_network_fee_requires_trx
          CHECK (purpose <> 'network-fee' OR asset = 'TRX') NOT VALID;
        END IF;
      END; $sponsor_transfer_fee$`)
      await db.query(`DO $sponsor_transfer_contract$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'sponsor_transfers_asset_contract_shape'
            AND conrelid = '${schema}.sponsor_transfers'::regclass
        ) THEN
          ALTER TABLE ${schema}.sponsor_transfers
          ADD CONSTRAINT sponsor_transfers_asset_contract_shape
          CHECK ((asset = 'TRX' AND token_contract IS NULL)
            OR (asset IN ('USDT','VTRC') AND token_contract IS NOT NULL AND length(btrim(token_contract)) > 0)) NOT VALID;
        END IF;
      END; $sponsor_transfer_contract$`)
      // Preserve legacy rows but reject any new or updated transfer using unsupported assets.
      await db.query(`DO $sponsor_transfer_supported_asset$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'sponsor_transfers_supported_asset_only'
            AND conrelid = '${schema}.sponsor_transfers'::regclass
        ) THEN
          ALTER TABLE ${schema}.sponsor_transfers
          ADD CONSTRAINT sponsor_transfers_supported_asset_only
          CHECK (asset IN ('TRX','USDT')) NOT VALID;
        END IF;
      END; $sponsor_transfer_supported_asset$`)
      await db.query(`ALTER TABLE ${schema}.sponsor_transfers ADD COLUMN IF NOT EXISTS sponsor_address TEXT`)
      await db.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_ttc_sponsor_transfer_tx_identity
          ON ${schema}.sponsor_transfers (network, transaction_hash)
          WHERE transaction_hash IS NOT NULL
      `)
      await db.query(`
        CREATE INDEX IF NOT EXISTS idx_ttc_sponsor_transfers_status_created
          ON ${schema}.sponsor_transfers (status, created_at DESC)
      `)
      // Records immutable, transaction-specific costs observed from the selected testnet's
      // solidified node. These observations are not proof that the distinct resource sponsor
      // was economically debited; resource attribution and fee-budget settlement remain separate.
      await db.query(`
        CREATE TABLE IF NOT EXISTS ${schema}.sponsor_chain_cost_observations (
          id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          network TEXT NOT NULL CHECK (network IN ('shasta','nile')),
          transaction_hash CHAR(64) NOT NULL,
          idempotency_key TEXT NOT NULL REFERENCES ${schema}.sponsor_transfers(idempotency_key) ON DELETE RESTRICT,
          sponsor_reference TEXT NOT NULL,
          fee_sponsor_address TEXT NOT NULL,
          asset_principal_address TEXT NOT NULL,
          receiver_address TEXT NOT NULL,
          asset TEXT NOT NULL CHECK (asset IN ('TRX','USDT','VTRC')),
          token_contract TEXT,
          amount_base_units NUMERIC(78,0) NOT NULL CHECK (amount_base_units > 0),
          block_number BIGINT NOT NULL CHECK (block_number > 0),
          execution_result TEXT NOT NULL CHECK (execution_result = 'SUCCESS'),
          reported_fee_sun NUMERIC(78,0) NOT NULL CHECK (reported_fee_sun >= 0),
          energy_fee_sun NUMERIC(78,0),
          net_fee_sun NUMERIC(78,0),
          energy_usage_total NUMERIC(78,0),
          energy_usage NUMERIC(78,0),
          net_usage NUMERIC(78,0),
          energy_penalty_total NUMERIC(78,0),
          evidence_source TEXT NOT NULL DEFAULT 'Tatum TRON SolidityNode transaction body and receipt',
          observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          CHECK ((asset = 'TRX' AND token_contract IS NULL)
            OR (asset IN ('USDT','VTRC') AND token_contract IS NOT NULL AND length(btrim(token_contract)) > 0)),
          UNIQUE (network, transaction_hash)
        )
      `)
      // Chain-cost evidence is an immutable audit ledger: keep old VTRC observations
      // readable but reject any new observation for an unsupported asset.
      await db.query(`DO $sponsor_observation_supported_asset$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'sponsor_chain_cost_observations_supported_asset_only'
            AND conrelid = '${schema}.sponsor_chain_cost_observations'::regclass
        ) THEN
          ALTER TABLE ${schema}.sponsor_chain_cost_observations
          ADD CONSTRAINT sponsor_chain_cost_observations_supported_asset_only
          CHECK (asset IN ('TRX','USDT')) NOT VALID;
        END IF;
      END; $sponsor_observation_supported_asset$`)
      await db.query(`ALTER TABLE ${schema}.sponsor_chain_cost_observations ADD COLUMN IF NOT EXISTS origin_energy_usage NUMERIC(78,0)`)
      await db.query(`CREATE INDEX IF NOT EXISTS idx_ttc_sponsor_chain_cost_observations_created
        ON ${schema}.sponsor_chain_cost_observations (network, observed_at DESC)`)
      await db.query(`COMMENT ON TABLE ${schema}.sponsor_chain_cost_observations IS
        'TRC20 Token Clone project only: immutable solidified transaction cost observations. Not, by itself, proof of fee-sponsor debit or a settled fee budget.'`)
      await db.query(`
        CREATE TABLE IF NOT EXISTS ${schema}.audit_events (
          id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          event_type TEXT NOT NULL,
          entity_type TEXT,
          entity_reference TEXT,
          details JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `)
      await db.query(`
        CREATE TABLE IF NOT EXISTS ${schema}.sponsor_resource_delegations (
          id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          network TEXT NOT NULL CHECK (network IN ('mainnet','shasta','nile')),
          transaction_hash CHAR(64) NOT NULL,
          sponsor_address TEXT NOT NULL,
          receiver_address TEXT NOT NULL,
          resource_type TEXT NOT NULL CHECK (resource_type IN ('ENERGY','BANDWIDTH')),
          stake_equivalent_sun NUMERIC(78,0) NOT NULL CHECK (stake_equivalent_sun > 0),
          block_number BIGINT NOT NULL CHECK (block_number > 0),
          verification_status TEXT NOT NULL CHECK (verification_status IN ('verified-on-chain')),
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (network, transaction_hash)
        )
      `)
      await db.query(`
        CREATE INDEX IF NOT EXISTS idx_ttc_resource_delegations_created
          ON ${schema}.sponsor_resource_delegations (network, created_at DESC)
      `)
      await db.query(`
        CREATE TABLE IF NOT EXISTS ${schema}.sponsor_resource_budgets (
          id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          mandate_reference TEXT NOT NULL UNIQUE,
          sponsor_reference TEXT NOT NULL,
          network TEXT NOT NULL CHECK (network IN ('nile','shasta')),
          fee_sponsor_address TEXT NOT NULL,
          asset_principal_address TEXT NOT NULL,
          energy_budget_units NUMERIC(78,0) NOT NULL CHECK (energy_budget_units >= 0),
          bandwidth_budget_units NUMERIC(78,0) NOT NULL CHECK (bandwidth_budget_units > 0),
          per_transfer_energy_units NUMERIC(78,0) NOT NULL CHECK (per_transfer_energy_units >= 0),
          per_transfer_bandwidth_units NUMERIC(78,0) NOT NULL CHECK (per_transfer_bandwidth_units > 0),
          energy_reserved_units NUMERIC(78,0) NOT NULL DEFAULT 0 CHECK (energy_reserved_units >= 0),
          bandwidth_reserved_units NUMERIC(78,0) NOT NULL DEFAULT 0 CHECK (bandwidth_reserved_units >= 0),
          energy_spent_units NUMERIC(78,0) NOT NULL DEFAULT 0 CHECK (energy_spent_units >= 0),
          bandwidth_spent_units NUMERIC(78,0) NOT NULL DEFAULT 0 CHECK (bandwidth_spent_units >= 0),
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused')),
          pause_reason TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (sponsor_reference, network, fee_sponsor_address, asset_principal_address)
        )
      `)
      await db.query(`
        CREATE TABLE IF NOT EXISTS ${schema}.sponsor_resource_reservations (
          id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          idempotency_key TEXT NOT NULL UNIQUE REFERENCES ${schema}.sponsor_transfers(idempotency_key) ON DELETE RESTRICT,
          mandate_reference TEXT NOT NULL REFERENCES ${schema}.sponsor_resource_budgets(mandate_reference) ON DELETE RESTRICT,
          network TEXT NOT NULL CHECK (network IN ('nile','shasta')),
          transaction_hash CHAR(64),
          fee_sponsor_address TEXT NOT NULL,
          asset_principal_address TEXT NOT NULL,
          energy_reserved_units NUMERIC(78,0) NOT NULL CHECK (energy_reserved_units >= 0),
          bandwidth_reserved_units NUMERIC(78,0) NOT NULL CHECK (bandwidth_reserved_units > 0),
          energy_consumed_units NUMERIC(78,0),
          bandwidth_consumed_units NUMERIC(78,0),
          capacity_snapshot JSONB NOT NULL,
          status TEXT NOT NULL DEFAULT 'reserved'
            CHECK (status IN ('reserved','settled','manual-review','released')),
          settlement_reason TEXT,
          settlement_block_number BIGINT,
          expires_at TIMESTAMPTZ NOT NULL,
          settled_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `)
      await db.query(`CREATE INDEX IF NOT EXISTS idx_ttc_sponsor_resource_reservations_status
        ON ${schema}.sponsor_resource_reservations (network, status, updated_at DESC)`)
      await db.query(`
        CREATE TABLE IF NOT EXISTS ${schema}.sponsor_resource_budgets (
          id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          mandate_reference TEXT NOT NULL UNIQUE,
          sponsor_reference TEXT NOT NULL,
          network TEXT NOT NULL CHECK (network IN ('nile','shasta')),
          fee_sponsor_address TEXT NOT NULL,
          asset_principal_address TEXT NOT NULL,
          energy_budget_units NUMERIC(78,0) NOT NULL CHECK (energy_budget_units >= 0),
          bandwidth_budget_units NUMERIC(78,0) NOT NULL CHECK (bandwidth_budget_units > 0),
          per_transfer_energy_units NUMERIC(78,0) NOT NULL CHECK (per_transfer_energy_units >= 0),
          per_transfer_bandwidth_units NUMERIC(78,0) NOT NULL CHECK (per_transfer_bandwidth_units > 0),
          energy_reserved_units NUMERIC(78,0) NOT NULL DEFAULT 0 CHECK (energy_reserved_units >= 0),
          bandwidth_reserved_units NUMERIC(78,0) NOT NULL DEFAULT 0 CHECK (bandwidth_reserved_units >= 0),
          energy_spent_units NUMERIC(78,0) NOT NULL DEFAULT 0 CHECK (energy_spent_units >= 0),
          bandwidth_spent_units NUMERIC(78,0) NOT NULL DEFAULT 0 CHECK (bandwidth_spent_units >= 0),
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused')),
          pause_reason TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (sponsor_reference, network, fee_sponsor_address, asset_principal_address)
        )
      `)
      await db.query(`
        CREATE TABLE IF NOT EXISTS ${schema}.sponsor_resource_reservations (
          id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          idempotency_key TEXT NOT NULL UNIQUE REFERENCES ${schema}.sponsor_transfers(idempotency_key) ON DELETE RESTRICT,
          mandate_reference TEXT NOT NULL REFERENCES ${schema}.sponsor_resource_budgets(mandate_reference) ON DELETE RESTRICT,
          network TEXT NOT NULL CHECK (network IN ('nile','shasta')),
          transaction_hash CHAR(64),
          fee_sponsor_address TEXT NOT NULL,
          asset_principal_address TEXT NOT NULL,
          energy_reserved_units NUMERIC(78,0) NOT NULL CHECK (energy_reserved_units >= 0),
          bandwidth_reserved_units NUMERIC(78,0) NOT NULL CHECK (bandwidth_reserved_units > 0),
          energy_consumed_units NUMERIC(78,0),
          bandwidth_consumed_units NUMERIC(78,0),
          capacity_snapshot JSONB NOT NULL,
          status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','settled','manual-review','released')),
          settlement_reason TEXT,
          settlement_block_number BIGINT,
          expires_at TIMESTAMPTZ NOT NULL,
          settled_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `)
      await db.query(`CREATE INDEX IF NOT EXISTS idx_ttc_sponsor_resource_reservations_status
        ON ${schema}.sponsor_resource_reservations (network, status, updated_at DESC)`)
      await db.query(`COMMENT ON TABLE ${schema}.sponsor_resource_budgets IS
        'TRC20 Token Clone project only: operator-allowlisted Energy/Bandwidth allowance caps for an exact fee-sponsor to asset-principal delegation pair. Units are resources, not TRX.'`)
      await db.query(`COMMENT ON TABLE ${schema}.sponsor_resource_reservations IS
        'TRC20 Token Clone project only: idempotent resource-unit reservations and solidified receipt settlement. A settled resource budget is not a verified TRX debit.'`)
      await db.query(`
        CREATE TABLE IF NOT EXISTS ${schema}.sponsor_provider_applications (
          id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          reference UUID NOT NULL UNIQUE,
          provider_name TEXT NOT NULL CHECK (char_length(provider_name) BETWEEN 2 AND 120),
          contact_email TEXT NOT NULL CHECK (char_length(contact_email) BETWEEN 3 AND 254),
          scope TEXT NOT NULL CHECK (scope IN ('network-fees','trx-grant','trc20-grant')),
          status TEXT NOT NULL DEFAULT 'pending-review'
            CHECK (status IN ('pending-review','in-review','accepted-for-due-diligence','declined','closed')),
          review_reference TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          reviewed_at TIMESTAMPTZ
        )
      `)
      await db.query(`
        CREATE INDEX IF NOT EXISTS idx_ttc_provider_applications_status_created
          ON ${schema}.sponsor_provider_applications (status, created_at DESC)
      `)
      await db.query(`CREATE INDEX IF NOT EXISTS idx_ttc_verifications_created_at ON ${schema}.transfer_verifications (created_at DESC)`)
      await db.query(`CREATE INDEX IF NOT EXISTS idx_ttc_deployments_created_at ON ${schema}.token_deployments (created_at DESC)`)
      const comments = [
        ["token_deployments", "TRC20 Token Clone project only: independent token deployment metadata; never official Tether USDT."],
        ["transfer_verifications", "TRC20 Token Clone project only: on-chain verification outcomes; not a balance ledger and not proof unless status is verified-on-chain."],
        ["tracked_wallets", "TRC20 Token Clone project only: optional public TRON wallet watchlist. Do not store private keys or seed phrases."],
        ["audit_events", "TRC20 Token Clone project only: non-secret application audit metadata. Never store credentials, private keys, or seed phrases."],
        ["sponsor_resource_delegations", "TRC20 Token Clone project only: exact sponsor resource delegations independently checked on solidified TRON state. Stores no signing material."],
        ["sponsor_provider_applications", "TRC20 Token Clone project only: provider onboarding contacts and status. Never store provider API secrets, private keys, or signing material."],
      ]
      for (const [table, comment] of comments) {
        const literal = "'" + comment.replace(/'/g, "''") + "'"
        await db.query(`COMMENT ON TABLE ${schema}.${table} IS ${literal}`)
      }
      return { configured: true, ready: true, schema }
    })().catch((error) => {
      initPromise = undefined
      // Avoid logging connection URL or SQL parameter values.
      console.error('PostgreSQL initialization failed:', error?.code || 'unknown')
      throw new Error('Database initialization failed')
    })
  }
  return initPromise
}

export function normalizeVerificationNetwork(network) {
  return ['mainnet', 'shasta', 'nile'].includes(network) ? network : null
}

export function buildTransferVerificationUpsert(input) {
  const network = normalizeVerificationNetwork(input?.network)
  if (!network) throw new TypeError('A supported explicit network is required')

  const transactionHash = typeof input?.transactionHash === 'string' ? input.transactionHash : ''
  const tokenContract = typeof input?.tokenContract === 'string' ? input.tokenContract.trim() : ''
  const fromAddress = typeof input?.fromAddress === 'string' ? input.fromAddress.trim() : ''
  const toAddress = typeof input?.toAddress === 'string' ? input.toAddress.trim() : ''
  const amountBaseUnits = typeof input?.amountBaseUnits === 'string' ? input.amountBaseUnits : ''
  if (!/^[0-9a-f]{64}$/i.test(transactionHash)
    || !tokenContract || !fromAddress || !toAddress
    || !/^[0-9]+$/.test(amountBaseUnits)
    || amountBaseUnits.length > 78
    || !/[1-9]/.test(amountBaseUnits)) {
    throw new TypeError('A valid transfer verification record is required')
  }

  const result = input.result && typeof input.result === 'object' ? input.result : {}
  const status = ['verified-on-chain','not-verified','awaiting-solidification','awaiting-solidified-receipt','provider-error'].includes(input.status)
    ? input.status
    : 'not-verified'
  const logIndex = Number.isSafeInteger(input?.logIndex) && input.logIndex >= 0
    ? input.logIndex
    : (Number.isSafeInteger(result.logIndex) && result.logIndex >= 0 ? result.logIndex : 0)
  const block = typeof result.blockNumber === 'number'
    && Number.isSafeInteger(result.blockNumber)
    && result.blockNumber > 0
    ? result.blockNumber
    : null

  return {
    text: `INSERT INTO ${schema}.transfer_verifications
      (network, transaction_hash, token_contract, from_address, to_address, amount_base_units, verification_status, block_number, result, log_index)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
     ON CONFLICT (network, transaction_hash, token_contract, log_index) DO UPDATE SET
       verification_status=CASE
         WHEN ${schema}.transfer_verifications.verification_status='verified-on-chain'
         THEN ${schema}.transfer_verifications.verification_status
         ELSE EXCLUDED.verification_status
       END,
       from_address=CASE
         WHEN ${schema}.transfer_verifications.verification_status='verified-on-chain'
         THEN ${schema}.transfer_verifications.from_address
         ELSE EXCLUDED.from_address
       END,
       to_address=CASE
         WHEN ${schema}.transfer_verifications.verification_status='verified-on-chain'
         THEN ${schema}.transfer_verifications.to_address
         ELSE EXCLUDED.to_address
       END,
       amount_base_units=CASE
         WHEN ${schema}.transfer_verifications.verification_status='verified-on-chain'
         THEN ${schema}.transfer_verifications.amount_base_units
         ELSE EXCLUDED.amount_base_units
       END,
       block_number=CASE
         WHEN ${schema}.transfer_verifications.verification_status='verified-on-chain'
         THEN ${schema}.transfer_verifications.block_number
         ELSE COALESCE(EXCLUDED.block_number, ${schema}.transfer_verifications.block_number)
       END,
       result=CASE
         WHEN ${schema}.transfer_verifications.verification_status='verified-on-chain'
         THEN ${schema}.transfer_verifications.result
         ELSE EXCLUDED.result
       END`,
    values: [network, transactionHash.toLowerCase(), tokenContract, fromAddress, toAddress, amountBaseUnits, status, block, JSON.stringify(result), logIndex],
  }
}

export async function recordTransferVerification(input) {
  // Never infer Mainnet from a missing or invalid network; doing so could
  // contaminate network-scoped verification history with mislabelled records.
  const network = normalizeVerificationNetwork(input?.network)
  if (!network) return { persisted: false, reason: 'invalid-network' }

  // Validate required identity fields before touching the database. Amounts
  // remain integer base units; floating-point or zero/negative amounts are rejected.
  const transactionHash = typeof input?.transactionHash === 'string' ? input.transactionHash : ''
  const tokenContract = typeof input?.tokenContract === 'string' ? input.tokenContract.trim() : ''
  const fromAddress = typeof input?.fromAddress === 'string' ? input.fromAddress.trim() : ''
  const toAddress = typeof input?.toAddress === 'string' ? input.toAddress.trim() : ''
  // Require a decimal string: JavaScript numbers can lose precision for
  // large token amounts before PostgreSQL ever receives the value.
  const amountBaseUnits = typeof input?.amountBaseUnits === 'string'
    ? input.amountBaseUnits
    : ''
  if (!/^[0-9a-f]{64}$/i.test(transactionHash)
    || !tokenContract
    || !fromAddress
    || !toAddress
    || !/^[0-9]+$/.test(amountBaseUnits)
    || amountBaseUnits.length > 78
    || !/[1-9]/.test(amountBaseUnits)) {
    return { persisted: false, reason: 'invalid-record' }
  }

  const db = getPool()
  if (!db) return { persisted: false, reason: 'database-not-configured' }
  await initializeDatabase()
  const query = buildTransferVerificationUpsert({
    ...input,
    network,
    transactionHash,
    tokenContract,
    fromAddress,
    toAddress,
    amountBaseUnits,
  })
  await db.query(query.text, query.values)
  return { persisted: true }
}


export async function findVerifiedTransfer(input) {
  const network = normalizeVerificationNetwork(input?.network)
  const transactionHash = typeof input?.transactionHash === 'string' ? input.transactionHash : ''
  const tokenContract = typeof input?.tokenContract === 'string' ? input.tokenContract.trim() : ''
  const fromAddress = typeof input?.fromAddress === 'string' ? input.fromAddress.trim() : ''
  const toAddress = typeof input?.toAddress === 'string' ? input.toAddress.trim() : ''
  const amountBaseUnits = typeof input?.amountBaseUnits === 'string' ? input.amountBaseUnits : ''
  const logIndex = input?.logIndex
  if (!network || !/^[0-9a-f]{64}$/i.test(transactionHash)
    || !tokenContract || !fromAddress || !toAddress
    || !/^[0-9]+$/.test(amountBaseUnits) || amountBaseUnits.length > 78
    || !/[1-9]/.test(amountBaseUnits)
    || !Number.isSafeInteger(logIndex) || logIndex < 0) {
    return { found: false, reason: 'invalid-lookup' }
  }

  const db = getPool()
  if (!db) return { found: false, reason: 'database-not-configured' }
  await initializeDatabase()
  const query = await db.query(
    `SELECT network, transaction_hash, token_contract, from_address, to_address,
            amount_base_units::text AS amount_base_units, block_number, log_index, result, created_at
       FROM ${schema}.transfer_verifications
      WHERE network = $1
        AND transaction_hash = $2
        AND lower(token_contract) = lower($3)
        AND lower(from_address) = lower($4)
        AND lower(to_address) = lower($5)
        AND amount_base_units = $6::numeric
        AND log_index = $7
        AND verification_status = 'verified-on-chain'
      LIMIT 1`,
    [network, transactionHash.toLowerCase(), tokenContract, fromAddress, toAddress, amountBaseUnits, logIndex],
  )
  if (!query.rows.length) return { found: false, reason: 'verified-event-not-found' }
  const row = query.rows[0]
  return {
    found: true,
    transfer: {
      network: row.network,
      transactionHash: row.transaction_hash.trim(),
      tokenContract: row.token_contract,
      fromAddress: row.from_address,
      toAddress: row.to_address,
      amountBaseUnits: row.amount_base_units,
      blockNumber: row.block_number === null ? null : Number(row.block_number),
      logIndex: row.log_index,
      result: row.result,
      createdAt: row.created_at,
    },
  }
}

/**
 * Persist a short-lived wallet ownership challenge. Only a SHA-256 digest of
 * the random nonce is stored; the public message is bound to address, network
 * and exact allowed browser origin. Expired challenges are cleaned as new ones
 * are issued so this table cannot grow without bound during normal use.
 */
export async function persistWalletAuthChallenge(input = {}) {
  const { nonceHash, messageHash, address, network, origin, issuedAt, expiresAt } = input
  if (typeof nonceHash !== 'string' || !/^[0-9a-f]{64}$/.test(nonceHash)
    || typeof messageHash !== 'string' || !/^[0-9a-f]{64}$/.test(messageHash)
    || !isValidTronAddress(address) || !['mainnet', 'nile', 'shasta'].includes(network)
    || typeof origin !== 'string' || origin.length < 1 || origin.length > 512
    || !Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)
    || issuedAt > Date.now() + 30_000 || expiresAt <= Date.now()
    || expiresAt <= issuedAt || expiresAt - issuedAt > 5 * 60 * 1000) {
    return { success: false, reason: 'invalid-challenge' }
  }
  const db = getPool()
  if (!db) return { success: false, reason: 'database-not-configured' }
  let client
  try {
    await initializeDatabase()
    client = await db.connect()
    await client.query('BEGIN')
    // Serialize attempts for the same public account/network/origin across
    // Render instances, then enforce a modest five-minute challenge budget.
    const lockKey = network + ':' + address + ':' + origin
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lockKey])
    const recent = await client.query(
      `SELECT COUNT(*)::integer AS count
         FROM ${schema}.wallet_auth_challenges
        WHERE network = $1 AND wallet_address = $2 AND origin = $3
          AND created_at > now() - INTERVAL '5 minutes'`,
      [network, address, origin],
    )
    if (Number(recent.rows[0]?.count || 0) >= 8) {
      await client.query('ROLLBACK')
      return { success: false, reason: 'rate-limited' }
    }
    await client.query(`DELETE FROM ${schema}.wallet_auth_challenges WHERE expires_at <= now()`)
    await client.query(
      `INSERT INTO ${schema}.wallet_auth_challenges
        (nonce_hash, wallet_address, network, origin, message_hash, issued_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [nonceHash, address, network, origin, messageHash, new Date(issuedAt), new Date(expiresAt)],
    )
    await client.query('COMMIT')
    return { success: true }
  } catch (error) {
    try { await client?.query('ROLLBACK') } catch {}
    console.error('Wallet auth challenge persistence failed:', error?.code || 'unknown')
    return { success: false, reason: 'database-unavailable' }
  } finally {
    client?.release()
  }
}

/**
 * Consume a challenge atomically across server instances. DELETE ... RETURNING
 * guarantees a valid nonce cannot be replayed after it has been selected.
 */
export async function consumeWalletAuthChallenge({ nonceHash } = {}) {
  if (typeof nonceHash !== 'string' || !/^[0-9a-f]{64}$/.test(nonceHash)) {
    return { success: false, reason: 'invalid-challenge' }
  }
  const db = getPool()
  if (!db) return { success: false, reason: 'database-not-configured' }
  try {
    await initializeDatabase()
    const result = await db.query(
      `UPDATE ${schema}.wallet_auth_challenges
          SET consumed_at = now()
        WHERE nonce_hash = $1 AND consumed_at IS NULL AND expires_at > now()
        RETURNING wallet_address, network, origin, message_hash, issued_at, expires_at`,
      [nonceHash],
    )
    if (!result.rows.length) return { success: true, challenge: null }
    const row = result.rows[0]
    return {
      success: true,
      challenge: {
        address: row.wallet_address,
        network: row.network,
        origin: row.origin,
        messageHash: String(row.message_hash).trim(),
        issuedAt: new Date(row.issued_at).getTime(),
        expiresAt: new Date(row.expires_at).getTime(),
      },
    }
  } catch (error) {
    console.error('Wallet auth challenge consumption failed:', error?.code || 'unknown')
    return { success: false, reason: 'database-unavailable' }
  }
}

/**
 * Persist a verified login. Store the session token digest rather than the
 * bearer value; upsert a network-scoped account only after signature proof.
 */
export async function persistWalletAuthSession(input = {}) {
  const { tokenHash, address, network, origin, expiresAt } = input
  if (typeof tokenHash !== 'string' || !/^[0-9a-f]{64}$/.test(tokenHash)
    || !isValidTronAddress(address) || !['mainnet', 'nile', 'shasta'].includes(network)
    || typeof origin !== 'string' || origin.length < 1 || origin.length > 512
    || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    return { success: false, reason: 'invalid-session' }
  }
  const db = getPool()
  if (!db) return { success: false, reason: 'database-not-configured' }
  let client
  try {
    await initializeDatabase()
    client = await db.connect()
    await client.query('BEGIN')
    await client.query(`DELETE FROM ${schema}.wallet_auth_sessions WHERE expires_at <= now()`)
    await client.query(
      `INSERT INTO ${schema}.wallet_auth_accounts (network, wallet_address)
       VALUES ($1,$2)
       ON CONFLICT (network, wallet_address)
       DO UPDATE SET last_authenticated_at = now()`,
      [network, address],
    )
    await client.query(
      `INSERT INTO ${schema}.wallet_auth_sessions
        (token_hash, wallet_address, network, origin, expires_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [tokenHash, address, network, origin, new Date(expiresAt)],
    )
    await client.query('COMMIT')
    return { success: true }
  } catch (error) {
    try { await client?.query('ROLLBACK') } catch {}
    console.error('Wallet auth session persistence failed:', error?.code || 'unknown')
    return { success: false, reason: 'database-unavailable' }
  } finally {
    client?.release()
  }
}

/** Read a live session only when both its token digest and origin match. */
export async function getWalletAuthSession({ tokenHash, origin, nowMs = Date.now() } = {}) {
  if (typeof tokenHash !== 'string' || !/^[0-9a-f]{64}$/.test(tokenHash)
    || typeof origin !== 'string' || origin.length < 1 || origin.length > 512
    || !Number.isFinite(nowMs)) {
    return { success: false, reason: 'invalid-session' }
  }
  const db = getPool()
  if (!db) return { success: false, reason: 'database-not-configured' }
  try {
    await initializeDatabase()
    await db.query(`DELETE FROM ${schema}.wallet_auth_sessions WHERE expires_at <= now()`)
    const result = await db.query(
      `SELECT wallet_address, network, origin, expires_at
         FROM ${schema}.wallet_auth_sessions
        WHERE token_hash = $1 AND origin = $2 AND expires_at > $3
        LIMIT 1`,
      [tokenHash, origin, new Date(nowMs)],
    )
    if (!result.rows.length) return { success: true, session: null }
    const row = result.rows[0]
    return {
      success: true,
      session: {
        address: row.wallet_address,
        network: row.network,
        origin: row.origin,
        expiresAt: new Date(row.expires_at).getTime(),
      },
    }
  } catch (error) {
    console.error('Wallet auth session lookup failed:', error?.code || 'unknown')
    return { success: false, reason: 'database-unavailable' }
  }
}

/** Revoke one opaque wallet-auth session by its digest. */
export async function revokeWalletAuthSession({ tokenHash } = {}) {
  if (typeof tokenHash !== 'string' || !/^[0-9a-f]{64}$/.test(tokenHash)) {
    return { success: false, reason: 'invalid-session' }
  }
  const db = getPool()
  if (!db) return { success: false, reason: 'database-not-configured' }
  try {
    await initializeDatabase()
    await db.query(`DELETE FROM ${schema}.wallet_auth_sessions WHERE token_hash = $1`, [tokenHash])
    return { success: true }
  } catch (error) {
    console.error('Wallet auth session revocation failed:', error?.code || 'unknown')
    return { success: false, reason: 'database-unavailable' }
  }
}

export async function getDatabaseStatus() {
  const db = getPool()
  if (!db) return { configured: false, ready: false }
  try {
    await initializeDatabase()
    await db.query('SELECT 1')
    return { configured: true, ready: true, schema }
  } catch {
    return { configured: true, ready: false, schema }
  }
}


/**
 * Persist only a native TRX transfer already checked against a solidified
 * transaction body and receipt. Persistence is required before sponsor-ledger
 * reconciliation may count the transfer as confirmed.
 */
export async function recordNativeTransferVerification(input) {
  const network = normalizeVerificationNetwork(input?.network)
  const { transactionHash, fromAddress, toAddress, amountSun, blockNumber } = input || {}
  if (!network || typeof transactionHash !== 'string' || !/^[0-9a-f]{64}$/i.test(transactionHash)
    || typeof fromAddress !== 'string' || !fromAddress.trim()
    || typeof toAddress !== 'string' || !toAddress.trim()
    || typeof amountSun !== 'string' || !/^[1-9][0-9]*$/.test(amountSun) || amountSun.length > 78
    || !Number.isSafeInteger(blockNumber) || blockNumber <= 0) {
    return { persisted: false, reason: 'invalid-native-transfer-record' }
  }
  const db = getPool()
  if (!db) return { persisted: false, reason: 'database-not-configured' }
  await initializeDatabase()
  await db.query(
    `INSERT INTO ${schema}.native_transfer_verifications
      (network, transaction_hash, from_address, to_address, amount_sun, block_number, verification_status)
     VALUES ($1,$2,$3,$4,$5,$6,'verified-on-chain')
     ON CONFLICT (network, transaction_hash) DO UPDATE SET
       from_address = CASE WHEN ${schema}.native_transfer_verifications.verification_status = 'verified-on-chain'
         THEN ${schema}.native_transfer_verifications.from_address ELSE EXCLUDED.from_address END,
       to_address = CASE WHEN ${schema}.native_transfer_verifications.verification_status = 'verified-on-chain'
         THEN ${schema}.native_transfer_verifications.to_address ELSE EXCLUDED.to_address END,
       amount_sun = CASE WHEN ${schema}.native_transfer_verifications.verification_status = 'verified-on-chain'
         THEN ${schema}.native_transfer_verifications.amount_sun ELSE EXCLUDED.amount_sun END,
       block_number = CASE WHEN ${schema}.native_transfer_verifications.verification_status = 'verified-on-chain'
         THEN ${schema}.native_transfer_verifications.block_number ELSE EXCLUDED.block_number END`,
    [network, transactionHash.toLowerCase(), fromAddress.trim(), toAddress.trim(), amountSun, blockNumber],
  )
  return { persisted: true }
}

/**
 * Persist only a sponsor delegation whose exact DelegateResource transaction,
 * solidified receipt, and resulting confirmed Stake-2.0 delegation were verified.
 * Transaction identity is idempotent per chain environment.
 */
export async function recordSponsorResourceDelegation(input) {
  const network = normalizeVerificationNetwork(input?.network)
  const { transactionHash, sponsorAddress, receiverAddress, resourceType, stakeEquivalentSun, blockNumber } = input || {}
  const addressPattern = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
  if (!network
    || typeof transactionHash !== 'string' || !/^[0-9a-f]{64}$/i.test(transactionHash)
    || typeof sponsorAddress !== 'string' || !addressPattern.test(sponsorAddress)
    || typeof receiverAddress !== 'string' || !addressPattern.test(receiverAddress)
    || sponsorAddress === receiverAddress
    || !['ENERGY', 'BANDWIDTH'].includes(resourceType)
    || typeof stakeEquivalentSun !== 'string' || !/^[1-9][0-9]{0,77}$/.test(stakeEquivalentSun)
    || !Number.isSafeInteger(blockNumber) || blockNumber <= 0) {
    return { persisted: false, reason: 'invalid-resource-delegation-record' }
  }
  const db = getPool()
  if (!db) return { persisted: false, reason: 'database-not-configured' }
  try {
    await initializeDatabase()
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const inserted = await client.query(
        `INSERT INTO ${schema}.sponsor_resource_delegations
          (network, transaction_hash, sponsor_address, receiver_address, resource_type, stake_equivalent_sun, block_number, verification_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'verified-on-chain')
         ON CONFLICT (network, transaction_hash) DO NOTHING
         RETURNING id::text AS id`,
        [network, transactionHash.toLowerCase(), sponsorAddress, receiverAddress, resourceType, stakeEquivalentSun, blockNumber],
      )
      if (!inserted.rowCount) {
        const existing = await client.query(
          `SELECT sponsor_address, receiver_address, resource_type,
                  stake_equivalent_sun::text AS stake_equivalent_sun,
                  block_number, verification_status
             FROM ${schema}.sponsor_resource_delegations
            WHERE network = $1 AND transaction_hash = $2
            FOR UPDATE`,
          [network, transactionHash.toLowerCase()],
        )
        const row = existing.rows[0]
        const same = row
          && row.sponsor_address === sponsorAddress
          && row.receiver_address === receiverAddress
          && row.resource_type === resourceType
          && row.stake_equivalent_sun === stakeEquivalentSun
          && Number(row.block_number) === blockNumber
          && row.verification_status === 'verified-on-chain'
        if (!same) {
          await client.query('ROLLBACK')
          return { persisted: false, reason: 'resource-delegation-identity-conflict' }
        }
        await client.query('COMMIT')
        return { persisted: true, duplicate: true }
      }
      await client.query(
        `INSERT INTO ${schema}.audit_events (event_type, entity_type, entity_reference, details)
         VALUES ('sponsor-resource-delegation-verified', 'sponsor-resource-delegation', $1, $2::jsonb)`,
        [`${network}:${transactionHash.toLowerCase()}`, JSON.stringify({
          network, transactionHash: transactionHash.toLowerCase(), sponsorAddress, receiverAddress,
          resourceType, stakeEquivalentSun, blockNumber, verificationStatus: 'verified-on-chain',
        })],
      )
      await client.query('COMMIT')
      return { persisted: true, duplicate: false }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      console.error('Sponsor resource delegation record failed:', error?.code || 'unknown')
      return { persisted: false, reason: 'database-unavailable' }
    } finally {
      client.release()
    }
  } catch (error) {
    console.error('Sponsor resource delegation persistence initialization failed:', error?.code || 'unknown')
    return { persisted: false, reason: 'database-unavailable' }
  }
}

/** Read previously independently verified, project-persisted sponsor resource delegations. */
export async function listSponsorResourceDelegations({ network, limit = 20 } = {}) {
  const normalizedNetwork = normalizeVerificationNetwork(network)
  if (!normalizedNetwork) return { success: false, reason: 'invalid-network', delegations: [] }
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return { success: false, reason: 'invalid-limit', delegations: [] }
  }
  const db = getPool()
  if (!db) return { success: false, reason: 'database-not-configured', delegations: [] }
  try {
    await initializeDatabase()
    const result = await db.query(
      `SELECT network, transaction_hash, sponsor_address, receiver_address, resource_type,
              stake_equivalent_sun::text AS stake_equivalent_sun, block_number,
              verification_status, created_at
         FROM ${schema}.sponsor_resource_delegations
        WHERE network = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [normalizedNetwork, limit],
    )
    return {
      success: true,
      delegations: result.rows.map((row) => ({
        network: row.network,
        transactionId: row.transaction_hash.trim(),
        sponsorAddress: row.sponsor_address,
        receiverAddress: row.receiver_address,
        resourceType: row.resource_type,
        stakeEquivalentSun: row.stake_equivalent_sun,
        blockNumber: Number(row.block_number),
        status: row.verification_status,
        recordedAt: row.created_at,
      })),
    }
  } catch (error) {
    console.error('Sponsor resource delegation history read failed:', error?.code || 'unknown')
    return { success: false, reason: 'database-unavailable', delegations: [] }
  }
}

function validSponsorTransitionStatus(status) {
  return ['authorized', 'submitted', 'confirmed', 'failed', 'cancelled'].includes(status)
}

/**
 * Atomically creates an idempotent sponsor transfer intent and reserves its
 * budget. This is accounting only: it never signs or broadcasts transactions.
 */
export async function reserveSponsorTransfer(input, {
  fundingSnapshotReader = readSponsorFundingStatusForReservation,
} = {}) {
  const network = normalizeVerificationNetwork(input?.network)
  const { idempotencyKey, sponsorReference, purpose, asset, tokenContract = null, receiverAddress, amountBaseUnits } = input || {}
  if (!network || typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{8,160}$/.test(idempotencyKey)
    || typeof sponsorReference !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(sponsorReference)
    || !['network-fee', 'asset-grant'].includes(purpose)
    || !['TRX', 'USDT'].includes(asset)
    || (purpose === 'network-fee' && asset !== 'TRX')
    || (asset === 'TRX' && tokenContract)
    || (SPONSORED_TOKEN_ASSETS.has(asset) && !isConfiguredSponsorTokenContractAllowed(network, asset, tokenContract))
    || typeof receiverAddress !== 'string' || !receiverAddress.trim() || receiverAddress.length > 128
    || !isPositiveUint256(amountBaseUnits)) {
    return { reserved: false, reason: 'invalid-transfer-intent' }
  }

  const normalizedTokenContract = SPONSORED_TOKEN_ASSETS.has(asset) ? tokenContract.trim() : null
  const { TronWeb } = await import('tronweb')
  const tronWeb = new TronWeb({ fullHost: network === 'mainnet'
    ? 'https://api.trongrid.io'
    : network === 'shasta' ? 'https://api.shasta.trongrid.io' : 'https://nile.trongrid.io' })
  if (!tronWeb.isAddress(receiverAddress.trim())
    || (SPONSORED_TOKEN_ASSETS.has(asset) && !tronWeb.isAddress(normalizedTokenContract))) {
    return { reserved: false, reason: 'invalid-tron-address' }
  }

  const db = getPool()
  if (!db) return { reserved: false, reason: 'database-not-configured' }
  await initializeDatabase()

  // An idempotent retry of an already-recorded request must not need a fresh
  // provider read and must never create a second reservation.
  const readExisting = async (queryable, forUpdate = false) => queryable.query(
    `SELECT idempotency_key, sponsor_reference, network, purpose, asset, token_contract,
            receiver_address, amount_base_units::text AS amount_base_units, status
       FROM ${schema}.sponsor_transfers
      WHERE idempotency_key = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [idempotencyKey],
  )
  const sameIntent = (row) => row.sponsor_reference === sponsorReference.trim()
    && row.network === network && row.purpose === purpose && row.asset === asset
    && (row.token_contract || null) === normalizedTokenContract
    && row.receiver_address === receiverAddress.trim()
    && row.amount_base_units === amountBaseUnits
  const prior = await readExisting(db)
  if (prior.rows.length) {
    return sameIntent(prior.rows[0])
      ? { reserved: true, duplicate: true, status: prior.rows[0].status, idempotencyKey }
      : { reserved: false, reason: 'idempotency-key-conflict' }
  }

  // Preflight the requested budget before asking the chain provider. This does
  // not authorize it: the same row and scoped agreement are rechecked under lock.
  const preflightResult = await db.query(
    `SELECT id::text AS id, sponsor_reference, sponsor_address, network, purpose, asset, token_contract,
            budget_base_units::text AS budget_base_units,
            reserved_base_units::text AS reserved_base_units,
            spent_base_units::text AS spent_base_units, status,
            approval_reference, review_reference, approved_at
       FROM ${schema}.sponsor_budgets
      WHERE sponsor_reference = $1 AND network = $2 AND purpose = $3 AND asset = $4
        AND token_contract IS NOT DISTINCT FROM $5
      LIMIT 1`,
    [sponsorReference.trim(), network, purpose, asset, normalizedTokenContract],
  )
  if (!preflightResult.rows.length) return { reserved: false, reason: 'sponsor-budget-not-found' }
  const preflight = preflightResult.rows[0]
  if (preflight.status !== 'active') return { reserved: false, reason: 'sponsor-budget-not-active' }
  if (typeof preflight.sponsor_address !== 'string' || !tronWeb.isAddress(preflight.sponsor_address.trim())) {
    return { reserved: false, reason: 'invalid-sponsor-address' }
  }
  if (typeof preflight.approval_reference !== 'string' || !preflight.approval_reference
    || typeof preflight.review_reference !== 'string' || !preflight.review_reference
    || preflight.approved_at == null
    || !isApprovedSponsorAgreementScope({
      consentReference: preflight.approval_reference,
      budget: preflight,
    })) {
    return { reserved: false, reason: 'sponsor-budget-activation-required' }
  }
  if (network === 'mainnet' && process.env.SPONSOR_MAINNET_BUDGET_ACTIVATION_ENABLED !== 'true') {
    return { reserved: false, reason: 'mainnet-budget-activation-disabled' }
  }
  if (typeof fundingSnapshotReader !== 'function') {
    return { reserved: false, reason: 'sponsor-funding-reader-unavailable' }
  }

  let fundingSnapshot
  try {
    fundingSnapshot = await fundingSnapshotReader(network)
  } catch {
    return { reserved: false, reason: 'sponsor-funding-snapshot-unavailable' }
  }
  const snapshotAgeMs = Date.now() - Date.parse(fundingSnapshot?.checkedAt || '')
  const snapshotCacheIsFresh = fundingSnapshot?.cache?.status === 'fresh'
    || (fundingSnapshot?.cache?.status === 'cached'
      && Number.isFinite(fundingSnapshot.cache.ageMs)
      && fundingSnapshot.cache.ageMs >= 0
      && fundingSnapshot.cache.ageMs <= 10_000)
  if (!fundingSnapshot || fundingSnapshot.status !== 'solidified-sponsor-balances-read'
    || fundingSnapshot.onChainBalanceRead !== true
    || !snapshotCacheIsFresh
    || !Number.isFinite(snapshotAgeMs) || snapshotAgeMs < -5_000 || snapshotAgeMs > 15_000
    || fundingSnapshot.network !== network
    || fundingSnapshot.source !== SPONSOR_CHAIN_SNAPSHOT_SOURCE) {
    return { reserved: false, reason: 'fresh-sponsor-balance-unavailable' }
  }
  if (fundingSnapshot.sponsorAddress !== preflight.sponsor_address) {
    return { reserved: false, reason: 'funding-snapshot-identity-mismatch' }
  }

  const client = await db.connect()
  try {
    await client.query('BEGIN')

    const existing = await readExisting(client, true)
    if (existing.rows.length) {
      const row = existing.rows[0]
      await client.query('COMMIT')
      return sameIntent(row)
        ? { reserved: true, duplicate: true, status: row.status, idempotencyKey }
        : { reserved: false, reason: 'idempotency-key-conflict' }
    }

    // Use the same per-wallet/network/asset advisory lock as activation. Lock the
    // target and every related budget only after acquiring this common lock to
    // avoid double allocation and inconsistent lock ordering between these paths.
    const lockIdentity = `sponsor-budget-activation:${network}:${preflight.sponsor_address}:${asset}:${normalizedTokenContract || ''}`
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lockIdentity])

    const allocationResult = await client.query(
      `SELECT id::text AS id, sponsor_reference, sponsor_address, network, purpose, asset, token_contract,
              budget_base_units::text AS budget_base_units,
              reserved_base_units::text AS reserved_base_units,
              spent_base_units::text AS spent_base_units, status,
              approval_reference, review_reference, approved_at
         FROM ${schema}.sponsor_budgets
        WHERE sponsor_address = $1 AND network = $2 AND asset = $3
          AND token_contract IS NOT DISTINCT FROM $4
        ORDER BY id
        LIMIT 101
        FOR UPDATE`,
      [preflight.sponsor_address, network, asset, normalizedTokenContract],
    )
    if (allocationResult.rows.length >= 101) {
      await client.query('ROLLBACK')
      return { reserved: false, reason: 'sponsor-budget-ledger-truncated' }
    }
    const allocations = allocationResult.rows
    const budget = allocations.find((row) =>
      row.sponsor_reference === sponsorReference.trim()
      && row.network === network && row.purpose === purpose && row.asset === asset
      && (row.token_contract || null) === normalizedTokenContract)
    if (!budget) {
      await client.query('ROLLBACK')
      return { reserved: false, reason: 'sponsor-budget-not-found' }
    }
    if (budget.status !== 'active') {
      await client.query('ROLLBACK')
      return { reserved: false, reason: 'sponsor-budget-not-active' }
    }
    if (budget.sponsor_address !== preflight.sponsor_address
      || budget.approved_at == null
      || typeof budget.approval_reference !== 'string' || !budget.approval_reference
      || typeof budget.review_reference !== 'string' || !budget.review_reference
      || !isApprovedSponsorAgreementScope({
        consentReference: budget.approval_reference,
        budget,
      })) {
      await client.query('ROLLBACK')
      return { reserved: false, reason: 'sponsor-budget-activation-required' }
    }
    if (network === 'mainnet' && process.env.SPONSOR_MAINNET_BUDGET_ACTIVATION_ENABLED !== 'true') {
      await client.query('ROLLBACK')
      return { reserved: false, reason: 'mainnet-budget-activation-disabled' }
    }
    const currentSnapshotAgeMs = Date.now() - Date.parse(fundingSnapshot.checkedAt)
    if (!Number.isFinite(currentSnapshotAgeMs) || currentSnapshotAgeMs < -5_000 || currentSnapshotAgeMs > 15_000) {
      await client.query('ROLLBACK')
      return { reserved: false, reason: 'funding-snapshot-stale' }
    }

    const reconciliationBudgets = allocations.map((row) => ({
      ...row,
      approvalScopeVerified: row.status === 'active'
        && typeof row.review_reference === 'string' && row.review_reference.length > 0
        && row.approved_at != null
        && isApprovedSponsorAgreementScope({
          consentReference: row.approval_reference,
          budget: row,
        }),
    }))
    const reconciliation = reconcileSponsorBudgets({
      network,
      fundingSnapshot,
      budgets: reconciliationBudgets,
    })
    if (reconciliation.covered !== true) {
      await client.query('ROLLBACK')
      const group = reconciliation.groups?.find((item) =>
        item.asset === asset && (item.tokenContract || null) === normalizedTokenContract)
      if (reconciliation.status === 'underfunded') {
        return {
          reserved: false,
          reason: 'insufficient-onchain-funding',
          requiredBaseUnits: group?.committedBaseUnits,
          chainBalanceBaseUnits: group?.onChainBalanceBaseUnits,
          deficitBaseUnits: group?.deficitBaseUnits,
        }
      }
      if (reconciliation.status === 'approval-required') {
        return { reserved: false, reason: 'sponsor-budget-activation-required' }
      }
      if (reconciliation.status === 'balance-unavailable') {
        return { reserved: false, reason: 'exact-asset-balance-not-verified' }
      }
      if (reconciliation.status === 'wallet-scope-mismatch') {
        return { reserved: false, reason: 'funding-snapshot-identity-mismatch' }
      }
      return { reserved: false, reason: 'sponsor-funding-reconciliation-incomplete' }
    }

    const available = BigInt(budget.budget_base_units) - BigInt(budget.reserved_base_units) - BigInt(budget.spent_base_units)
    const amount = BigInt(amountBaseUnits)
    if (amount > available) {
      await client.query('ROLLBACK')
      return { reserved: false, reason: 'insufficient-sponsor-budget' }
    }

    await client.query(
      `UPDATE ${schema}.sponsor_budgets
          SET reserved_base_units = reserved_base_units + $1::numeric, updated_at = now()
        WHERE id = $2::bigint`,
      [amountBaseUnits, budget.id],
    )
    await client.query(
      `INSERT INTO ${schema}.sponsor_transfers
        (idempotency_key, sponsor_reference, sponsor_address, network, purpose, asset, token_contract,
         receiver_address, amount_base_units, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending-review')`,
      [idempotencyKey, sponsorReference.trim(), budget.sponsor_address, network, purpose, asset,
       normalizedTokenContract, receiverAddress.trim(), amountBaseUnits],
    )
    await client.query(
      `INSERT INTO ${schema}.audit_events (event_type, entity_type, entity_reference, details)
       VALUES ('sponsor-transfer-reserved', 'sponsor-transfer', $1, $2::jsonb)`,
      [idempotencyKey, JSON.stringify({
        sponsorReference: sponsorReference.trim(), network, purpose, asset,
        tokenContract: normalizedTokenContract, amountBaseUnits,
        fundingCheckedAt: fundingSnapshot.checkedAt,
        fundingSnapshotAgeMs: currentSnapshotAgeMs,
      })],
    )
    await client.query('COMMIT')
    return {
      reserved: true, duplicate: false, status: 'pending-review', idempotencyKey,
      fundingReconciled: true,
      canSubmitSponsoredTransfer: false,
      submissionEnabled: false,
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    if (error?.code === '23505') {
      // Concurrent identical retries may race on the unique idempotency key.
      // Re-read after rollback and return the existing result only if the
      // complete transfer intent matches; never hide a conflicting request.
      const raced = await db.query(
        `SELECT sponsor_reference, network, purpose, asset, token_contract,
                receiver_address, amount_base_units::text AS amount_base_units, status
           FROM ${schema}.sponsor_transfers WHERE idempotency_key = $1`,
        [idempotencyKey],
      )
      if (!raced.rows.length) return { reserved: false, reason: 'reservation-conflict' }
      const row = raced.rows[0]
      return sameIntent(row)
        ? { reserved: true, duplicate: true, status: row.status, idempotencyKey }
        : { reserved: false, reason: 'idempotency-key-conflict' }
    }
    throw error
  } finally {
    client.release()
  }
}

/**
 * Applies audited sponsor lifecycle transitions and reconciles budget reservation.
 * Confirmation requires independently verified persisted chain evidence.
 *
 * The current release intentionally rejects new authorized and submitted
 * transitions: a text reference is not a cryptographically verified wallet
 * signature, and a caller-supplied transaction hash is not a provider broadcast
 * receipt. Re-enable those transitions only alongside durable signature
 * verification, replay protection, and provider-adapter implementations and tests.
 */
export async function transitionSponsorTransferWithPool(input, db, { initialize = true } = {}) {
  const { idempotencyKey, nextStatus, authorizationReference = null, transactionHash = null, cancellationReason = null } = input || {}
  if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{8,160}$/.test(idempotencyKey)
    || !validSponsorTransitionStatus(nextStatus)) {
    return { updated: false, reason: 'invalid-transition' }
  }

  // Do not let an opaque operator-supplied string stand in for a cryptographically
  // verified wallet authorization. The live wallet-signature verification and
  // nonce-replay storage path has not been integrated, so no new intent may enter
  // the authorized state.
  if (nextStatus === 'authorized') {
    return { updated: false, reason: 'wallet-signature-verification-not-integrated' }
  }

  // A caller-supplied transaction hash is not proof that a provider actually
  // accepted or broadcast a transfer. Until a provider submission adapter records
  // its own result, no new transition may claim that a transfer was submitted.
  if (nextStatus === 'submitted') {
    return { updated: false, reason: 'provider-submission-adapter-disabled' }
  }
  if (nextStatus === 'confirmed' && (typeof transactionHash !== 'string' || !/^[0-9a-f]{64}$/i.test(transactionHash))) {
    return { updated: false, reason: 'finalized-transaction-hash-required' }
  }
  if (nextStatus === 'cancelled'
    && !['operator-request', 'recipient-request', 'duplicate-request', 'eligibility-expired', 'emergency-stop'].includes(cancellationReason)) {
    return { updated: false, reason: 'invalid-cancellation-reason' }
  }

  if (!db) return { updated: false, reason: 'database-not-configured' }
  if (initialize) await initializeDatabase()
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const result = await client.query(
      `SELECT idempotency_key, sponsor_reference, sponsor_address, network, purpose, asset, token_contract,
              receiver_address, amount_base_units::text AS amount_base_units, status, transaction_hash
         FROM ${schema}.sponsor_transfers WHERE idempotency_key = $1 FOR UPDATE`,
      [idempotencyKey],
    )
    if (!result.rows.length) {
      await client.query('ROLLBACK')
      return { updated: false, reason: 'transfer-not-found' }
    }
    const transfer = result.rows[0]
    if (transfer.status === nextStatus) {
      const sameHash = !['submitted', 'confirmed'].includes(nextStatus)
        || transfer.transaction_hash?.trim().toLowerCase() === transactionHash?.toLowerCase()
      await client.query('COMMIT')
      return sameHash ? { updated: true, duplicate: true, status: nextStatus } : { updated: false, reason: 'transaction-hash-conflict' }
    }
    if (transfer.transaction_hash && transactionHash
      && transfer.transaction_hash.trim().toLowerCase() !== transactionHash.toLowerCase()) {
      await client.query('ROLLBACK')
      return { updated: false, reason: 'transaction-hash-conflict' }
    }
    // A submitted transaction can consume chain fees even when execution fails.
    // Do not release its reservation based only on a caller-supplied "failed" status;
    // fee-aware finalized failure evidence and reconciliation are not implemented yet.
    if (transfer.status === 'submitted' && nextStatus === 'failed') {
      await client.query('ROLLBACK')
      return { updated: false, reason: 'finalized-failure-evidence-and-fee-reconciliation-required' }
    }
    const allowed = {
      'pending-review': ['authorized', 'cancelled'],
      authorized: ['submitted', 'cancelled'],
      // Submitted transfers remain reserved until confirmed with persisted evidence.
      submitted: ['confirmed'],
      confirmed: [],
      failed: [],
      cancelled: [],
    }
    if (!allowed[transfer.status]?.includes(nextStatus)) {
      await client.query('ROLLBACK')
      return { updated: false, reason: 'invalid-state-transition' }
    }

    if (nextStatus === 'confirmed' && transfer.purpose === 'network-fee') {
      // Fee/resource consumption is not principal paid to the receiver. Keep the
      // reservation until a provider-specific finalized fee reconciler exists.
      await client.query('ROLLBACK')
      return {
        updated: false,
        reason: 'purpose-specific-fee-evidence-and-reconciliation-required',
      }
    }
    if (nextStatus === 'confirmed' && transfer.purpose !== 'asset-grant') {
      await client.query('ROLLBACK')
      return { updated: false, reason: 'unsupported-sponsor-transfer-purpose' }
    }

    if (nextStatus === 'confirmed') {
      let evidence
      if (transfer.asset === 'TRX') {
        evidence = await client.query(
          `SELECT 1 FROM ${schema}.native_transfer_verifications
            WHERE network = $1 AND transaction_hash = $2
              AND lower(from_address) = lower($3)
              AND lower(to_address) = lower($4)
              AND amount_sun = $5::numeric
              AND verification_status = 'verified-on-chain'
            LIMIT 1`,
          [transfer.network, transactionHash.toLowerCase(), transfer.sponsor_address, transfer.receiver_address, transfer.amount_base_units],
        )
      } else {
        evidence = await client.query(
          `SELECT 1 FROM ${schema}.transfer_verifications
            WHERE network = $1 AND transaction_hash = $2
              AND lower(token_contract) = lower($3)
              AND lower(from_address) = lower($4)
              AND lower(to_address) = lower($5)
              AND amount_base_units = $6::numeric
              AND verification_status = 'verified-on-chain'
            LIMIT 1`,
          [transfer.network, transactionHash.toLowerCase(), transfer.token_contract, transfer.sponsor_address, transfer.receiver_address, transfer.amount_base_units],
        )
      }
      if (!evidence.rows.length) {
        await client.query('ROLLBACK')
        return { updated: false, reason: 'finalized-transfer-evidence-not-found' }
      }
    }

    const budgetResult = await client.query(
      `SELECT id, sponsor_reference, sponsor_address, network, purpose, asset, token_contract,
              reserved_base_units::text AS reserved_base_units,
              spent_base_units::text AS spent_base_units,
              budget_base_units::text AS budget_base_units, status,
              approval_reference, review_reference, approved_at
         FROM ${schema}.sponsor_budgets
        WHERE sponsor_reference = $1 AND network = $2 AND purpose = $3 AND asset = $4
          AND token_contract IS NOT DISTINCT FROM $5
        FOR UPDATE`,
      [transfer.sponsor_reference, transfer.network, transfer.purpose, transfer.asset, transfer.token_contract],
    )
    if (!budgetResult.rows.length) {
      await client.query('ROLLBACK')
      return { updated: false, reason: 'sponsor-budget-not-found' }
    }
    const budget = budgetResult.rows[0]
    if (['authorized', 'submitted'].includes(nextStatus)) {
      if (budget.status !== 'active') {
        await client.query('ROLLBACK')
        return { updated: false, reason: 'sponsor-budget-not-active' }
      }
      if (typeof budget.approval_reference !== 'string' || !budget.approval_reference
        || typeof budget.review_reference !== 'string' || !budget.review_reference
        || budget.approved_at == null
        || !isApprovedSponsorAgreementScope({
          consentReference: budget.approval_reference,
          budget,
        })) {
        await client.query('ROLLBACK')
        return { updated: false, reason: 'sponsor-budget-activation-required' }
      }
    }
    const amount = BigInt(transfer.amount_base_units)
    const reserved = BigInt(budget.reserved_base_units)
    const spent = BigInt(budget.spent_base_units)
    if (['confirmed', 'failed', 'cancelled'].includes(nextStatus) && reserved < amount) {
      await client.query('ROLLBACK')
      return { updated: false, reason: 'reservation-invariant-violated' }
    }
    if (nextStatus === 'confirmed' && spent + amount + reserved - amount > BigInt(budget.budget_base_units)) {
      await client.query('ROLLBACK')
      return { updated: false, reason: 'budget-invariant-violated' }
    }
    if (nextStatus === 'confirmed') {
      await client.query(
        `UPDATE ${schema}.sponsor_budgets SET reserved_base_units = reserved_base_units - $1::numeric,
          spent_base_units = spent_base_units + $1::numeric, updated_at = now() WHERE id = $2`,
        [amount.toString(), budget.id],
      )
    } else if (nextStatus === 'failed' || nextStatus === 'cancelled') {
      await client.query(
        `UPDATE ${schema}.sponsor_budgets SET reserved_base_units = reserved_base_units - $1::numeric,
          updated_at = now() WHERE id = $2`,
        [amount.toString(), budget.id],
      )
    }
    await client.query(
      `UPDATE ${schema}.sponsor_transfers
          SET status = $1,
              authorization_reference = COALESCE($2, authorization_reference),
              transaction_hash = COALESCE($3, transaction_hash),
              updated_at = now()
        WHERE idempotency_key = $4`,
      [nextStatus, authorizationReference?.trim() || null, transactionHash?.toLowerCase() || null, idempotencyKey],
    )
    await client.query(
      `INSERT INTO ${schema}.audit_events (event_type, entity_type, entity_reference, details)
       VALUES ('sponsor-transfer-status-changed', 'sponsor-transfer', $1, $2::jsonb)`,
      [idempotencyKey, JSON.stringify({ fromStatus: transfer.status, toStatus: nextStatus, network: transfer.network, asset: transfer.asset, ...(nextStatus === 'cancelled' && cancellationReason ? { cancellationReason } : {}) })],
    )
    await client.query('COMMIT')
    return { updated: true, duplicate: false, status: nextStatus }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}


/**
 * Returns one reserved sponsor intent with its currently approved budget scope.
 * This is an internal signing/broadcast adapter input, never a wallet secret.
 */
export async function getSponsorTransferForSubmission(idempotencyKey) {
  if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{24,160}$/.test(idempotencyKey)) {
    return { success: false, reason: 'invalid-idempotency-key' }
  }
  const db = getPool()
  if (!db) return { success: false, reason: 'database-not-configured' }
  try {
    await initializeDatabase()
    const result = await db.query(
      `SELECT t.idempotency_key, t.sponsor_reference, t.sponsor_address, t.network, t.purpose,
              t.asset, t.token_contract, t.receiver_address, t.amount_base_units::text AS amount_base_units,
              t.status, t.transaction_hash, t.prepared_transaction, t.prepared_raw_data_hex, t.prepared_txid, b.status AS budget_status,
              b.budget_base_units::text AS budget_base_units,
              b.reserved_base_units::text AS budget_reserved_base_units,
              b.spent_base_units::text AS budget_spent_base_units,
              b.approval_reference, b.review_reference, b.approved_at
         FROM ${schema}.sponsor_transfers t
         JOIN ${schema}.sponsor_budgets b
           ON b.sponsor_reference = t.sponsor_reference
          AND b.sponsor_address = t.sponsor_address
          AND b.network = t.network AND b.purpose = t.purpose AND b.asset = t.asset
          AND b.token_contract IS NOT DISTINCT FROM t.token_contract
        WHERE t.idempotency_key = $1
        LIMIT 1`,
      [idempotencyKey],
    )
    if (!result.rows.length) return { success: false, reason: 'transfer-not-found' }
    const row = result.rows[0]
    const budgetApproved = row.budget_status === 'active'
      && typeof row.approval_reference === 'string' && row.approval_reference.length > 0
      && typeof row.review_reference === 'string' && row.review_reference.length > 0
      && row.approved_at != null
      && isApprovedSponsorAgreementScope({
        consentReference: row.approval_reference,
        budget: {
          sponsor_reference: row.sponsor_reference,
          sponsor_address: row.sponsor_address,
          network: row.network,
          purpose: row.purpose,
          asset: row.asset,
          token_contract: row.token_contract,
          status: row.budget_status,
          review_reference: row.review_reference,
          approved_at: row.approved_at,
        },
      })
    return {
      success: true,
      transfer: {
        idempotencyKey: row.idempotency_key,
        sponsorReference: row.sponsor_reference,
        sponsorAddress: row.sponsor_address,
        network: row.network,
        purpose: row.purpose,
        asset: row.asset,
        tokenContract: row.token_contract,
        receiverAddress: row.receiver_address,
        amountBaseUnits: row.amount_base_units,
        status: row.status,
        transactionHash: row.transaction_hash?.trim() || null,
        preparedTransaction: row.prepared_transaction,
        preparedRawDataHex: row.prepared_raw_data_hex,
        preparedTxID: row.prepared_txid?.trim() || null,
        budgetStatus: row.budget_status,
        budgetApproved,
        budgetBaseUnits: row.budget_base_units,
        budgetReservedBaseUnits: row.budget_reserved_base_units,
        budgetSpentBaseUnits: row.budget_spent_base_units,
      },
    }
  } catch (error) {
    console.error('Sponsor transfer submission lookup failed:', error?.code || 'unknown')
    return { success: false, reason: 'database-unavailable' }
  }
}

/**
 * Persist the exact server-built unsigned transaction before returning it to the
 * sponsor wallet. Repeated signing-intent requests must reuse these bytes rather
 * than silently create a second transaction with a different TAPOS/expiration.
 */
export async function persistSponsorUnsignedTransaction({
  idempotencyKey,
  transaction,
} = {}) {
  if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{24,160}$/.test(idempotencyKey)
    || !transaction || typeof transaction !== 'object' || Array.isArray(transaction)
    || typeof transaction.raw_data_hex !== 'string' || !/^(?:[0-9a-f]{2})+$/i.test(transaction.raw_data_hex)
    || typeof transaction.txID !== 'string' || !/^[0-9a-f]{64}$/i.test(transaction.txID)
    || !transaction.raw_data || typeof transaction.raw_data !== 'object'
    || Array.isArray(transaction.raw_data) || (Array.isArray(transaction.signature) && transaction.signature.length > 0)) {
    return { persisted: false, reason: 'invalid-unsigned-transaction' }
  }
  const computedTxID = createHash('sha256')
    .update(Buffer.from(transaction.raw_data_hex, 'hex'))
    .digest('hex')
  if (computedTxID.toLowerCase() !== transaction.txID.toLowerCase()) {
    return { persisted: false, reason: 'transaction-id-mismatch' }
  }
  const db = getPool()
  if (!db) return { persisted: false, reason: 'database-not-configured' }
  await initializeDatabase()
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const result = await client.query(
      `SELECT t.status, t.network, t.purpose, t.sponsor_address, t.receiver_address,
              t.asset, t.token_contract, t.amount_base_units::text AS amount_base_units,
              t.prepared_transaction, t.prepared_raw_data_hex, t.prepared_txid,
              b.status AS budget_status, b.approval_reference, b.review_reference, b.approved_at,
              b.sponsor_reference, b.sponsor_address AS budget_sponsor_address, b.network AS budget_network,
              b.purpose AS budget_purpose, b.asset AS budget_asset, b.token_contract AS budget_token_contract
         FROM ${schema}.sponsor_transfers t
         JOIN ${schema}.sponsor_budgets b
           ON b.sponsor_reference = t.sponsor_reference
          AND b.sponsor_address = t.sponsor_address
          AND b.network = t.network AND b.purpose = t.purpose AND b.asset = t.asset
          AND b.token_contract IS NOT DISTINCT FROM t.token_contract
        WHERE t.idempotency_key = $1 FOR UPDATE OF t, b`,
      [idempotencyKey],
    )
    if (!result.rows.length) {
      await client.query('ROLLBACK')
      return { persisted: false, reason: 'transfer-not-found' }
    }
    const row = result.rows[0]
    const approved = row.budget_status === 'active'
      && typeof row.approval_reference === 'string' && row.approval_reference.length > 0
      && typeof row.review_reference === 'string' && row.review_reference.length > 0
      && row.approved_at != null
      && isApprovedSponsorAgreementScope({
        consentReference: row.approval_reference,
        budget: {
          sponsor_reference: row.sponsor_reference,
          sponsor_address: row.budget_sponsor_address,
          network: row.budget_network,
          purpose: row.budget_purpose,
          asset: row.budget_asset,
          token_contract: row.budget_token_contract,
        },
      })
    if (!['shasta', 'nile'].includes(row.network) || row.purpose !== 'asset-grant'
      || row.status !== 'pending-review' || row.budget_status !== 'active' || !approved) {
      await client.query('ROLLBACK')
      return { persisted: false, reason: 'approved-testnet-pending-transfer-required' }
    }
    if (row.sponsor_address === null || row.receiver_address === null
      || !['TRX','USDT'].includes(row.asset)
      || !/^(0|[1-9][0-9]*)$/.test(row.amount_base_units)) {
      await client.query('ROLLBACK')
      return { persisted: false, reason: 'transfer-identity-incomplete' }
    }
    const hasPreparedMetadata = Boolean(row.prepared_transaction || row.prepared_raw_data_hex || row.prepared_txid)
    if (hasPreparedMetadata) {
      if (!row.prepared_transaction || !row.prepared_raw_data_hex || !row.prepared_txid) {
        await client.query('ROLLBACK')
        return { persisted: false, reason: 'persisted-unsigned-transaction-integrity-failed' }
      }
      const oldTx = row.prepared_transaction
      const oldHash = String(row.prepared_txid).trim().toLowerCase()
      const oldRawHash = typeof oldTx.raw_data_hex === 'string' && /^(?:[0-9a-f]{2})+$/i.test(oldTx.raw_data_hex)
        ? createHash('sha256').update(Buffer.from(oldTx.raw_data_hex, 'hex')).digest('hex')
        : null
      const oldExpiration = oldTx.raw_data?.expiration
      if (oldHash !== String(oldTx.txID || '').toLowerCase()
        || oldRawHash !== oldHash
        || String(row.prepared_raw_data_hex).toLowerCase() !== String(oldTx.raw_data_hex || '').toLowerCase()
        || !Number.isSafeInteger(oldExpiration)) {
        await client.query('ROLLBACK')
        return { persisted: false, reason: 'persisted-unsigned-transaction-integrity-failed' }
      }
      if (oldExpiration > Date.now()) {
        await client.query('COMMIT')
        return { persisted: true, duplicate: true, transaction: oldTx, txID: oldHash }
      }
      // Replacing an expired unsigned intent is safe only while the reservation
      // is still pending-review. The old transaction is past its protocol expiry.
      await client.query(
        `INSERT INTO ${schema}.audit_events (event_type, entity_type, entity_reference, details)
         VALUES ('sponsor-unsigned-transaction-expired', 'sponsor-transfer', $1, $2::jsonb)`,
        [idempotencyKey, JSON.stringify({ network: row.network, expiredTxID: oldHash })],
      )
    }
    const serialized = JSON.stringify(transaction)
    if (serialized.length > 128 * 1024) {
      await client.query('ROLLBACK')
      return { persisted: false, reason: 'unsigned-transaction-too-large' }
    }
    await client.query(
      `UPDATE ${schema}.sponsor_transfers
          SET prepared_transaction = $1::jsonb, prepared_raw_data_hex = $2, prepared_txid = $3,
              updated_at = now()
        WHERE idempotency_key = $4 AND status = 'pending-review'`,
      [serialized, transaction.raw_data_hex.toLowerCase(), transaction.txID.toLowerCase(), idempotencyKey],
    )
    await client.query(
      `INSERT INTO ${schema}.audit_events (event_type, entity_type, entity_reference, details)
       VALUES ('sponsor-unsigned-transaction-prepared', 'sponsor-transfer', $1, $2::jsonb)`,
      [idempotencyKey, JSON.stringify({ network: row.network, sponsorAddress: row.sponsor_address,
        asset: row.asset, receiverAddress: row.receiver_address, amountBaseUnits: row.amount_base_units,
        txID: transaction.txID.toLowerCase() })],
    )
    await client.query('COMMIT')
    return { persisted: true, duplicate: false, transaction, txID: transaction.txID.toLowerCase() }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('Sponsor unsigned transaction persistence failed:', error?.code || 'unknown')
    return { persisted: false, reason: 'database-unavailable' }
  } finally {
    client.release()
  }
}

/**
 * Atomically claims an already signature-verified testnet transfer before
 * network broadcast. Binding its txid first prevents a concurrent cancel or a
 * second, different transaction from racing the broadcaster.
 */
export async function claimSponsorTransferBroadcast({
  idempotencyKey,
  transactionHash,
  sponsorAddress,
} = {}) {
  if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{24,160}$/.test(idempotencyKey)
    || typeof transactionHash !== 'string' || !/^[0-9a-f]{64}$/i.test(transactionHash)
    || typeof sponsorAddress !== 'string' || !isValidTronAddress(sponsorAddress)) {
    return { claimed: false, reason: 'invalid-broadcast-claim' }
  }
  const db = getPool()
  if (!db) return { claimed: false, reason: 'database-not-configured' }
  await initializeDatabase()
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const result = await client.query(
      `SELECT idempotency_key, sponsor_reference, sponsor_address, network, purpose, asset,
              token_contract, receiver_address, amount_base_units::text AS amount_base_units,
              status, transaction_hash
         FROM ${schema}.sponsor_transfers
        WHERE idempotency_key = $1
        FOR UPDATE`,
      [idempotencyKey],
    )
    if (!result.rows.length) {
      await client.query('ROLLBACK')
      return { claimed: false, reason: 'transfer-not-found' }
    }
    const transfer = result.rows[0]
    if (!['shasta', 'nile'].includes(transfer.network)) {
      await client.query('ROLLBACK')
      return { claimed: false, reason: 'testnet-only-broadcast' }
    }
    if (transfer.purpose !== 'asset-grant' || transfer.sponsor_address !== sponsorAddress) {
      await client.query('ROLLBACK')
      return { claimed: false, reason: 'sponsor-intent-identity-mismatch' }
    }
    const txId = transactionHash.toLowerCase()
    if (transfer.status === 'submitted' && transfer.transaction_hash?.trim().toLowerCase() === txId) {
      await client.query('COMMIT')
      return { claimed: true, duplicate: true, alreadySubmitted: true, status: 'submitted' }
    }
    if (transfer.status === 'broadcasting') {
      if (transfer.transaction_hash?.trim().toLowerCase() !== txId) {
        await client.query('ROLLBACK')
        return { claimed: false, reason: 'transaction-hash-conflict' }
      }
      await client.query('COMMIT')
      return { claimed: true, duplicate: true, retry: true, status: 'broadcasting' }
    }
    if (transfer.status !== 'pending-review') {
      await client.query('ROLLBACK')
      return { claimed: false, reason: 'invalid-state-transition' }
    }

    const budgetResult = await client.query(
      `SELECT id::text AS id, sponsor_reference, sponsor_address, network, purpose, asset,
              token_contract, budget_base_units::text AS budget_base_units,
              reserved_base_units::text AS reserved_base_units,
              spent_base_units::text AS spent_base_units, status,
              approval_reference, review_reference, approved_at
         FROM ${schema}.sponsor_budgets
        WHERE sponsor_reference = $1 AND sponsor_address = $2 AND network = $3
          AND purpose = $4 AND asset = $5 AND token_contract IS NOT DISTINCT FROM $6
        FOR UPDATE`,
      [transfer.sponsor_reference, transfer.sponsor_address, transfer.network,
        transfer.purpose, transfer.asset, transfer.token_contract],
    )
    if (!budgetResult.rows.length) {
      await client.query('ROLLBACK')
      return { claimed: false, reason: 'sponsor-budget-not-found' }
    }
    const budget = budgetResult.rows[0]
    if (budget.status !== 'active'
      || !budget.approval_reference || !budget.review_reference || budget.approved_at == null
      || !isApprovedSponsorAgreementScope({ consentReference: budget.approval_reference, budget })) {
      await client.query('ROLLBACK')
      return { claimed: false, reason: 'sponsor-budget-activation-required' }
    }
    if (BigInt(budget.reserved_base_units) < BigInt(transfer.amount_base_units)) {
      await client.query('ROLLBACK')
      return { claimed: false, reason: 'reservation-invariant-violated' }
    }

    const resourceResult = await client.query(
      `SELECT r.mandate_reference, r.network, r.transaction_hash,
              r.fee_sponsor_address, r.asset_principal_address,
              r.status, r.expires_at, b.status AS resource_budget_status
         FROM ${schema}.sponsor_resource_reservations r
         JOIN ${schema}.sponsor_resource_budgets b ON b.mandate_reference=r.mandate_reference
        WHERE r.idempotency_key=$1 FOR UPDATE OF r,b`,
      [idempotencyKey],
    )
    if (!resourceResult.rows.length) {
      await client.query('ROLLBACK')
      return { claimed: false, reason: 'fee-sponsor-resource-reservation-required' }
    }
    const resource = resourceResult.rows[0]
    const mandate = findApprovedSponsorResourceMandate({
      sponsorReference: transfer.sponsor_reference,
      network: transfer.network,
      feeSponsorAddress: resource.fee_sponsor_address,
      assetPrincipalAddress: transfer.sponsor_address,
    })
    if (resource.status !== 'reserved'
      || resource.network !== transfer.network
      || resource.asset_principal_address !== transfer.sponsor_address
      || (resource.transaction_hash && resource.transaction_hash.trim().toLowerCase() !== txId)
      || new Date(resource.expires_at).getTime() <= Date.now()
      || resource.resource_budget_status !== 'active'
      || !mandate || mandate.mandateReference !== resource.mandate_reference) {
      await client.query('ROLLBACK')
      return { claimed: false, reason: 'fee-sponsor-resource-reservation-invalid-or-expired' }
    }
    await client.query(
      `UPDATE ${schema}.sponsor_resource_reservations
          SET transaction_hash=$2, updated_at=now()
        WHERE idempotency_key=$1 AND status='reserved'
          AND (transaction_hash IS NULL OR lower(transaction_hash)=$2)`,
      [idempotencyKey, txId],
    )

    await client.query(
      `UPDATE ${schema}.sponsor_transfers
          SET status = 'broadcasting', transaction_hash = $1,
              authorization_reference = $2, updated_at = now()
        WHERE idempotency_key = $3 AND status = 'pending-review'`,
      [txId, `verified-wallet-signature:${sponsorAddress}`, idempotencyKey],
    )
    await client.query(
      `INSERT INTO ${schema}.audit_events (event_type, entity_type, entity_reference, details)
       VALUES ('sponsor-transfer-broadcast-claimed', 'sponsor-transfer', $1, $2::jsonb)`,
      [idempotencyKey, JSON.stringify({
        network: transfer.network, sponsorAddress, transactionHash: txId,
        asset: transfer.asset, amountBaseUnits: transfer.amount_base_units,
      })],
    )
    await client.query('COMMIT')
    return { claimed: true, duplicate: false, status: 'broadcasting', transactionHash: txId }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('Sponsor transfer broadcast claim failed:', error?.code || 'unknown')
    return { claimed: false, reason: 'database-unavailable' }
  } finally {
    client.release()
  }
}

/** Persist only an exact node-accepted txid after the chain node's broadcast response. */
export async function finalizeSponsorTransferBroadcast({
  idempotencyKey,
  transactionHash,
  sponsorAddress,
} = {}) {
  if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{24,160}$/.test(idempotencyKey)
    || typeof transactionHash !== 'string' || !/^[0-9a-f]{64}$/i.test(transactionHash)
    || typeof sponsorAddress !== 'string' || !isValidTronAddress(sponsorAddress)) {
    return { updated: false, reason: 'invalid-broadcast-result' }
  }
  const db = getPool()
  if (!db) return { updated: false, reason: 'database-not-configured' }
  await initializeDatabase()
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const result = await client.query(
      `SELECT sponsor_address, network, status, transaction_hash
         FROM ${schema}.sponsor_transfers
        WHERE idempotency_key = $1
        FOR UPDATE`,
      [idempotencyKey],
    )
    if (!result.rows.length) {
      await client.query('ROLLBACK')
      return { updated: false, reason: 'transfer-not-found' }
    }
    const row = result.rows[0]
    const txId = transactionHash.toLowerCase()
    if (row.status === 'submitted' && row.transaction_hash?.trim().toLowerCase() === txId) {
      await client.query('COMMIT')
      return { updated: true, duplicate: true, status: 'submitted' }
    }
    if (!['shasta', 'nile'].includes(row.network) || row.status !== 'broadcasting'
      || row.sponsor_address !== sponsorAddress
      || row.transaction_hash?.trim().toLowerCase() !== txId) {
      await client.query('ROLLBACK')
      return { updated: false, reason: 'broadcast-claim-mismatch' }
    }
    await client.query(
      `UPDATE ${schema}.sponsor_transfers
          SET status = 'submitted', updated_at = now()
        WHERE idempotency_key = $1 AND status = 'broadcasting'
          AND lower(transaction_hash) = $2`,
      [idempotencyKey, txId],
    )
    await client.query(
      `INSERT INTO ${schema}.audit_events (event_type, entity_type, entity_reference, details)
       VALUES ('sponsor-transfer-broadcast-accepted', 'sponsor-transfer', $1, $2::jsonb)`,
      [idempotencyKey, JSON.stringify({ network: row.network, sponsorAddress, transactionHash: txId })],
    )
    await client.query('COMMIT')
    return { updated: true, duplicate: false, status: 'submitted' }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('Sponsor transfer broadcast finalization failed:', error?.code || 'unknown')
    return { updated: false, reason: 'database-unavailable' }
  } finally {
    client.release()
  }
}

/** Production entry point: use the configured pool and initialize the schema. */
export async function transitionSponsorTransfer(input) {
  const db = getPool()
  if (!db) return { updated: false, reason: 'database-not-configured' }
  return transitionSponsorTransferWithPool(input, db)
}

 
/**
 * Creates an operator-requested sponsor budget draft. The row always starts as
 * pending-review; this helper cannot activate budgets or submit transfers.
 */
export async function createSponsorBudgetDraft(input) {
  const network = normalizeVerificationNetwork(input?.network)
  const { sponsorReference, purpose, asset, budgetBaseUnits, sponsorAddress } = input || {}
  const tokenContract = input?.tokenContract ?? null
  if (!network
    || typeof sponsorReference !== 'string' || !sponsorReference.trim() || sponsorReference.length > 128
    || !['network-fee', 'asset-grant'].includes(purpose)
    || !['TRX', 'USDT'].includes(asset)
    || (purpose === 'network-fee' && asset !== 'TRX')
    || (asset === 'TRX' && tokenContract !== null)
    || (asset !== 'TRX' && (typeof tokenContract !== 'string'
      || !isConfiguredSponsorTokenContractAllowed(network, asset, tokenContract)))
    || typeof budgetBaseUnits !== 'string' || !/^[1-9][0-9]{0,77}$/.test(budgetBaseUnits)
    || typeof sponsorAddress !== 'string' || !/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(sponsorAddress)) {
    return { success: false, reason: 'invalid-budget-draft' }
  }

  const { TronWeb } = await import('tronweb')
  const host = network === 'mainnet' ? 'https://api.trongrid.io'
    : network === 'shasta' ? 'https://api.shasta.trongrid.io' : 'https://nile.trongrid.io'
  const tronWeb = new TronWeb({ fullHost: host })
  if (!tronWeb.isAddress(sponsorAddress)
    || (asset !== 'TRX' && !tronWeb.isAddress(tokenContract))) {
    return { success: false, reason: 'invalid-tron-address' }
  }

  const db = getPool()
  if (!db) return { success: false, reason: 'database-not-configured' }
  await initializeDatabase()
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const result = await client.query(
      `INSERT INTO ${schema}.sponsor_budgets
        (sponsor_reference, sponsor_address, network, purpose, asset, token_contract,
         budget_base_units, reserved_base_units, spent_base_units, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7::numeric,0,0,'pending-review')
       ON CONFLICT DO NOTHING
       RETURNING id::text AS id, sponsor_reference, sponsor_address, network, purpose,
                 asset, token_contract, budget_base_units::text AS budget_base_units,
                 reserved_base_units::text AS reserved_base_units,
                 spent_base_units::text AS spent_base_units, status, created_at, updated_at`,
      [sponsorReference.trim(), sponsorAddress, network, purpose, asset, asset === 'TRX' ? null : tokenContract.trim(), budgetBaseUnits],
    )
    if (!result.rows.length) {
      await client.query('ROLLBACK')
      return { success: false, reason: 'budget-already-exists' }
    }
    const budget = result.rows[0]
    await client.query(
      `INSERT INTO ${schema}.audit_events (event_type, entity_type, entity_reference, details)
       VALUES ('sponsor-budget-draft-created', 'sponsor-budget', $1, $2::jsonb)`,
      [`${sponsorReference.trim()}:${network}:${purpose}:${asset}:${asset === 'TRX' ? '' : tokenContract.trim()}`,
       JSON.stringify({ network, purpose, asset, budgetBaseUnits, status: 'pending-review' })],
    )
    await client.query('COMMIT')
    return {
      success: true,
      duplicate: false,
      budget,
      canReserve: false,
      message: 'Budget draft recorded as pending-review. Operator approval, sponsor consent, actual funding reconciliation, and a reviewed transfer path are still required.',
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

function approvedSponsorAgreementScopes() {
  return String(process.env.SPONSOR_APPROVED_AGREEMENT_REFERENCES || '')
    .split(';').map((entry) => entry.trim()).filter(Boolean)
    .map((entry) => {
      const fields = entry.split('|')
      if (fields.length !== 7) return null
      const [reference, sponsorReference, network, sponsorAddress, purpose, asset, tokenContract] = fields
      if (typeof reference !== 'string' || !/^[A-Za-z0-9._:-]{8,160}$/.test(reference)
        || typeof sponsorReference !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(sponsorReference)
        || !['mainnet', 'shasta', 'nile'].includes(network)
        || !/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(sponsorAddress)
        || !['network-fee', 'asset-grant'].includes(purpose)
        || !['TRX', 'USDT'].includes(asset)
        || (purpose === 'network-fee' && asset !== 'TRX')
        || (asset === 'TRX'
          ? tokenContract !== '-'
          : typeof tokenContract !== 'string'
            || !isConfiguredSponsorTokenContractAllowed(network, asset, tokenContract))) {
        return null
      }
      return { reference, sponsorReference, network, sponsorAddress, purpose, asset, tokenContract }
    })
    .filter(Boolean)
}

export function isSponsorAgreementReferenceConfigured(reference) {
  return typeof reference === 'string'
    && approvedSponsorAgreementScopes().some((scope) => scope.reference === reference)
}

export function isApprovedSponsorAgreementScope({ consentReference, budget } = {}) {
  if (typeof consentReference !== 'string' || !budget || typeof budget !== 'object') return false
  return approvedSponsorAgreementScopes().some((scope) =>
    scope.reference === consentReference
      && scope.sponsorReference === budget.sponsor_reference
      && scope.network === budget.network
      && scope.sponsorAddress === budget.sponsor_address
      && scope.purpose === budget.purpose
      && scope.asset === budget.asset
      && scope.tokenContract === (budget.token_contract || '-'))
}

/**
 * Fetch one sponsor budget for operator review. All of its amounts remain
 * ledger values, not independent chain balance evidence.
 */
export async function getSponsorBudgetById(budgetId) {
  if (typeof budgetId !== 'string' || !/^[1-9][0-9]{0,18}$/.test(budgetId)) {
    return { success: false, reason: 'invalid-budget-id' }
  }
  const db = getPool()
  if (!db) return { success: false, reason: 'database-not-configured' }
  try {
    await initializeDatabase()
    const result = await db.query(
      `SELECT id::text AS id, sponsor_reference, sponsor_address, network, purpose, asset,
              token_contract, budget_base_units::text AS budget_base_units,
              reserved_base_units::text AS reserved_base_units,
              spent_base_units::text AS spent_base_units, status,
              approval_reference, review_reference, approved_at, created_at, updated_at
         FROM ${schema}.sponsor_budgets WHERE id = $1::bigint`,
      [budgetId],
    )
    return result.rows.length
      ? { success: true, budget: result.rows[0] }
      : { success: false, reason: 'budget-not-found' }
  } catch {
    return { success: false, reason: 'database-unavailable' }
  }
}

/**
 * Activates a pending-review budget only after a server-allowlisted sponsor
 * agreement reference, operator review reference, and a fresh exact-network
 * on-chain balance snapshot are provided. An advisory lock serializes activations
 * for the same sponsor wallet/network/asset so parallel approvals cannot allocate
 * the same chain balance twice. This never signs or submits a transaction.
 */
export async function activateSponsorBudget({
  budgetId,
  consentReference,
  reviewReference,
  fundingSnapshot,
} = {}) {
  if (typeof budgetId !== 'string' || !/^[1-9][0-9]{0,18}$/.test(budgetId)
    || typeof consentReference !== 'string' || !/^[A-Za-z0-9._:-]{8,160}$/.test(consentReference)
    || typeof reviewReference !== 'string' || !/^[A-Za-z0-9._:-]{8,160}$/.test(reviewReference)) {
    return { success: false, reason: 'invalid-activation-request' }
  }
  // Fast reject unknown references before doing provider or database work. The
  // exact wallet/network/asset scope is checked against the locked row below.
  if (!isSponsorAgreementReferenceConfigured(consentReference)) {
    return { success: false, reason: 'agreement-reference-not-approved' }
  }
  if (!fundingSnapshot || fundingSnapshot.status !== 'solidified-sponsor-balances-read'
    || fundingSnapshot.onChainBalanceRead !== true
    || fundingSnapshot.cache?.status !== 'fresh'
    || !['mainnet', 'shasta', 'nile'].includes(fundingSnapshot.network)
    || fundingSnapshot.source !== 'Tatum TRON SolidityNode account and constant-contract queries'
    || typeof fundingSnapshot.sponsorAddress !== 'string'
    || !/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(fundingSnapshot.sponsorAddress)
    || typeof fundingSnapshot.checkedAt !== 'string') {
    return { success: false, reason: 'fresh-solidified-funding-snapshot-required' }
  }
  const checkedAtMs = Date.parse(fundingSnapshot.checkedAt)
  const snapshotAgeMs = Date.now() - checkedAtMs
  if (!Number.isFinite(checkedAtMs) || snapshotAgeMs < -5_000 || snapshotAgeMs > 15_000) {
    return { success: false, reason: 'funding-snapshot-stale' }
  }

  const db = getPool()
  if (!db) return { success: false, reason: 'database-not-configured' }
  await initializeDatabase()
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    // Read immutable allocation identity without locking the row first. Acquire
    // the wallet/asset advisory lock before row locks, preventing two concurrent
    // activations from deadlocking while each tries to lock the other's draft.
    const identityResult = await client.query(
      `SELECT id::text AS id, sponsor_address, network, asset, token_contract
         FROM ${schema}.sponsor_budgets WHERE id = $1::bigint`,
      [budgetId],
    )
    if (!identityResult.rows.length) {
      await client.query('ROLLBACK')
      return { success: false, reason: 'budget-not-found' }
    }
    const identity = identityResult.rows[0]
    if (identity.network !== fundingSnapshot.network
      || identity.sponsor_address !== fundingSnapshot.sponsorAddress) {
      await client.query('ROLLBACK')
      return { success: false, reason: 'funding-snapshot-identity-mismatch' }
    }
    if (identity.network === 'mainnet' && process.env.SPONSOR_MAINNET_BUDGET_ACTIVATION_ENABLED !== 'true') {
      await client.query('ROLLBACK')
      return { success: false, reason: 'mainnet-budget-activation-disabled' }
    }
    const lockIdentity = `sponsor-budget-activation:${identity.network}:${identity.sponsor_address}:${identity.asset}:${identity.token_contract || ''}`
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lockIdentity])

    const targetResult = await client.query(
      `SELECT id::text AS id, sponsor_reference, sponsor_address, network, purpose, asset,
              token_contract, budget_base_units::text AS budget_base_units,
              reserved_base_units::text AS reserved_base_units,
              spent_base_units::text AS spent_base_units, status,
              approval_reference, review_reference, approved_at
         FROM ${schema}.sponsor_budgets
        WHERE id = $1::bigint
        FOR UPDATE`,
      [budgetId],
    )
    if (!targetResult.rows.length) {
      await client.query('ROLLBACK')
      return { success: false, reason: 'budget-not-found' }
    }
    const budget = targetResult.rows[0]
    if (budget.sponsor_address !== identity.sponsor_address
      || budget.network !== identity.network
      || budget.asset !== identity.asset
      || budget.token_contract !== identity.token_contract) {
      await client.query('ROLLBACK')
      return { success: false, reason: 'budget-identity-changed' }
    }
    if (!isApprovedSponsorAgreementScope({ consentReference, budget })) {
      await client.query('ROLLBACK')
      return { success: false, reason: 'agreement-reference-not-approved' }
    }
    if (budget.status === 'active') {
      const sameApproval = budget.approval_reference === consentReference
        && budget.review_reference === reviewReference
        && budget.approved_at != null
      await client.query('COMMIT')
      return sameApproval
        ? { success: true, duplicate: true, status: 'active', budgetId, canReserve: true }
        : { success: false, reason: 'budget-already-active' }
    }
    if (budget.status !== 'pending-review') {
      await client.query('ROLLBACK')
      return { success: false, reason: budget.status === 'paused' ? 'budget-paused' : 'budget-not-pending-review' }
    }

    let chainBalanceBaseUnits = null
    if (budget.asset === 'TRX') {
      const raw = fundingSnapshot.native?.balanceSun
      if (fundingSnapshot.native?.status !== 'verified'
        || typeof raw !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(raw)) {
        await client.query('ROLLBACK')
        return { success: false, reason: 'exact-asset-balance-not-verified' }
      }
      chainBalanceBaseUnits = BigInt(raw)
    } else {
      const expectedDisplayAsset = budget.asset === 'USDT' && budget.network !== 'mainnet'
        ? 'USDT (testnet)' : budget.asset
      const token = Array.isArray(fundingSnapshot.tokens)
        ? fundingSnapshot.tokens.find((item) => item?.tokenContract === budget.token_contract
          && item?.asset === expectedDisplayAsset && item?.status === 'verified')
        : null
      if (!token || typeof token.balanceBaseUnits !== 'string'
        || !/^(0|[1-9][0-9]{0,77})$/.test(token.balanceBaseUnits)) {
        await client.query('ROLLBACK')
        return { success: false, reason: 'exact-asset-balance-not-verified' }
      }
      if (budget.asset === 'USDT' && budget.network === 'mainnet' && token.decimals !== 6) {
        await client.query('ROLLBACK')
        return { success: false, reason: 'official-mainnet-usdt-decimals-mismatch' }
      }
      chainBalanceBaseUnits = BigInt(token.balanceBaseUnits)
    }

    const commitments = await client.query(
      `SELECT id::text AS id, budget_base_units::text AS budget_base_units,
              reserved_base_units::text AS reserved_base_units,
              spent_base_units::text AS spent_base_units, status
         FROM ${schema}.sponsor_budgets
        WHERE sponsor_address = $1 AND network = $2 AND asset = $3
          AND token_contract IS NOT DISTINCT FROM $4 AND id <> $5::bigint
        FOR UPDATE`,
      [budget.sponsor_address, budget.network, budget.asset, budget.token_contract, budgetId],
    )
    let committedBaseUnits = BigInt(budget.budget_base_units) - BigInt(budget.spent_base_units)
    for (const item of commitments.rows) {
      const reserved = BigInt(item.reserved_base_units)
      const spent = BigInt(item.spent_base_units)
      const total = BigInt(item.budget_base_units)
      // Active/paused budgets reserve their remaining cap. Inactive budgets only
      // contribute actual outstanding reservations, not an unapproved draft cap.
      committedBaseUnits += ['active', 'paused'].includes(item.status) ? total - spent : reserved
    }
    if (chainBalanceBaseUnits < committedBaseUnits) {
      await client.query('ROLLBACK')
      return {
        success: false,
        reason: 'insufficient-onchain-funding',
        chainBalanceBaseUnits: chainBalanceBaseUnits.toString(),
        requiredBaseUnits: committedBaseUnits.toString(),
      }
    }

    await client.query(
      `UPDATE ${schema}.sponsor_budgets
          SET status = 'active', approval_reference = $1, review_reference = $2,
              approved_at = now(), updated_at = now()
        WHERE id = $3::bigint`,
      [consentReference, reviewReference, budgetId],
    )
    await client.query(
      `INSERT INTO ${schema}.audit_events (event_type, entity_type, entity_reference, details)
       VALUES ('sponsor-budget-activated', 'sponsor-budget', $1, $2::jsonb)`,
      [budgetId, JSON.stringify({
        sponsorReference: budget.sponsor_reference,
        network: budget.network,
        purpose: budget.purpose,
        asset: budget.asset,
        tokenContract: budget.token_contract,
        budgetBaseUnits: budget.budget_base_units,
        chainBalanceBaseUnits: chainBalanceBaseUnits.toString(),
        committedBaseUnits: committedBaseUnits.toString(),
        consentReference,
        reviewReference,
        fundingCheckedAt: fundingSnapshot.checkedAt,
        status: 'active',
      })],
    )
    await client.query('COMMIT')
    return {
      success: true,
      duplicate: false,
      status: 'active',
      budgetId,
      canReserve: true,
      canSubmitSponsoredTransfer: false,
      submissionEnabled: false,
      chainBalanceBaseUnits: chainBalanceBaseUnits.toString(),
      committedBaseUnits: committedBaseUnits.toString(),
    }
  } catch {
    await client.query('ROLLBACK').catch(() => {})
    throw new Error('Sponsor budget activation failed')
  } finally {
    client.release()
  }
}

/**
 * Atomically pause a sponsor budget and audit the operator reason. This is an
 * emergency control only: it stops future reservations; it cannot reverse or
 * cancel transfers already submitted to a blockchain.
 */
export async function pauseSponsorBudget({ budgetId, reasonCode } = {}) {
  if (typeof budgetId !== 'string' || !/^[1-9][0-9]{0,18}$/.test(budgetId)
    || !['operator-request', 'funding-mismatch', 'provider-incident', 'emergency-stop'].includes(reasonCode)) {
    return { success: false, reason: 'invalid-pause-request' }
  }
  const db = getPool()
  if (!db) return { success: false, reason: 'database-not-configured' }
  await initializeDatabase()
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const selection = await client.query(
      `SELECT id::text AS id, sponsor_reference, network, purpose, asset, token_contract, status
         FROM ${schema}.sponsor_budgets
        WHERE id = $1::bigint
        FOR UPDATE`,
      [budgetId],
    )
    if (!selection.rows.length) {
      await client.query('ROLLBACK')
      return { success: false, reason: 'budget-not-found' }
    }
    const budget = selection.rows[0]
    if (budget.status === 'paused') {
      await client.query('COMMIT')
      return { success: true, duplicate: true, status: 'paused', budgetId }
    }
    if (budget.status === 'depleted') {
      await client.query('ROLLBACK')
      return { success: false, reason: 'budget-already-depleted' }
    }
    await client.query(
      `UPDATE ${schema}.sponsor_budgets
          SET status = 'paused', updated_at = now()
        WHERE id = $1::bigint`,
      [budgetId],
    )
    await client.query(
      `INSERT INTO ${schema}.audit_events (event_type, entity_type, entity_reference, details)
       VALUES ('sponsor-budget-paused', 'sponsor-budget', $1, $2::jsonb)`,
      [budgetId, JSON.stringify({
        sponsorReference: budget.sponsor_reference,
        network: budget.network,
        purpose: budget.purpose,
        asset: budget.asset,
        previousStatus: budget.status,
        status: 'paused',
        reasonCode,
      })],
    )
    await client.query('COMMIT')
    return { success: true, duplicate: false, status: 'paused', budgetId, previousStatus: budget.status }
  } catch {
    await client.query('ROLLBACK').catch(() => {})
    throw new Error('Sponsor budget pause failed')
  } finally {
    client.release()
  }
}

/**
 * Return only the configured sponsor-ledger budget records for privileged operations.
 * These are operator-set caps, not proof of live on-chain balances or funded resources.
 */
export async function listSponsorBudgets({ network = null, sponsorAddress = null, limit = 50 } = {}) {
  if (network !== null && !normalizeVerificationNetwork(network)) {
    return { success: false, reason: 'invalid-network', budgets: [] }
  }
  if (sponsorAddress !== null
    && (typeof sponsorAddress !== 'string' || !/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(sponsorAddress))) {
    return { success: false, reason: 'invalid-sponsor-address', budgets: [] }
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return { success: false, reason: 'invalid-limit', budgets: [] }
  }
  const db = getPool()
  if (!db) return { success: false, reason: 'database-not-configured', budgets: [] }
  try {
    await initializeDatabase()
    const result = await db.query(
      `SELECT id::text AS id, sponsor_reference, sponsor_address, network, purpose,
              asset, token_contract,
              budget_base_units::text AS budget_base_units,
              reserved_base_units::text AS reserved_base_units,
              spent_base_units::text AS spent_base_units,
              (budget_base_units - reserved_base_units - spent_base_units)::text AS ledger_available_base_units,
              status, approval_reference, review_reference, approved_at, created_at, updated_at
         FROM ${schema}.sponsor_budgets
        WHERE ($1::text IS NULL OR network = $1)
          AND ($2::text IS NULL OR sponsor_address = $2)
        ORDER BY updated_at DESC, id DESC
        LIMIT $3`,
      [network, sponsorAddress, limit],
    )
    return { success: true, budgets: result.rows }
  } catch {
    return { success: false, reason: 'database-unavailable', budgets: [] }
  }
}

/**
 * Read-only, bounded operator view of sponsor transfer lifecycle records.
 * This does not transition states, release reservations, or submit transactions.
 */
export async function listSponsorTransfers({ network = null, status = null, sponsorReference = null, limit = 50 } = {}) {
  if (network !== null && !normalizeVerificationNetwork(network)) {
    return { success: false, reason: 'invalid-network', transfers: [] }
  }
  const allowedStatuses = new Set(['pending-review', 'authorized', 'broadcasting', 'submitted', 'confirmed', 'failed', 'cancelled'])
  if (status !== null && (typeof status !== 'string' || !allowedStatuses.has(status))) {
    return { success: false, reason: 'invalid-status', transfers: [] }
  }
  if (sponsorReference !== null
    && (typeof sponsorReference !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(sponsorReference))) {
    return { success: false, reason: 'invalid-sponsor-reference', transfers: [] }
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return { success: false, reason: 'invalid-limit', transfers: [] }
  }
  const db = getPool()
  if (!db) return { success: false, reason: 'database-not-configured', transfers: [] }
  try {
    await initializeDatabase()
    const result = await db.query(
      `SELECT id::text AS id, idempotency_key, sponsor_reference, network, purpose, asset,
              token_contract, receiver_address, amount_base_units::text AS amount_base_units,
              status, transaction_hash, authorization_reference, created_at, updated_at
         FROM ${schema}.sponsor_transfers
        WHERE ($1::text IS NULL OR network = $1)
          AND ($2::text IS NULL OR status = $2)
          AND ($3::text IS NULL OR sponsor_reference = $3)
        ORDER BY updated_at DESC, id DESC
        LIMIT $4`,
      [network, status, sponsorReference, limit + 1],
    )
    const truncated = result.rows.length > limit
    return { success: true, transfers: result.rows.slice(0, limit), truncated }
  } catch {
    return { success: false, reason: 'database-unavailable', transfers: [] }
  }
}

/** Return bounded persisted receiver-history records. Indexed rows are candidates
 * unless the worker has independently verified a solidified receipt. */
export async function listPersistedReceiverHistory({ network, address, contract = null, limit = 50 } = {}) {
  if (!['mainnet', 'shasta', 'nile'].includes(network)
    || typeof address !== 'string' || !/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)
    || !Number.isInteger(limit) || limit < 1 || limit > 50
    || (contract !== null && (typeof contract !== 'string' || !/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(contract)))) {
    return { success: false, reason: 'invalid-query' }
  }
  const db = getPool()
  if (!db) return { success: false, reason: 'database-not-configured' }
  await initializeDatabase()
  const [historyResult, verifiedTransfersResult] = await Promise.all([
    db.query(
      `SELECT network, wallet_address, transaction_hash, token_contract, from_address, to_address,
              amount_base_units::text AS amount_base_units, token_name, token_symbol, token_decimals,
              block_timestamp, verification_status, verified_on_chain, event_index, first_seen_at, last_seen_at
         FROM ${schema}.receiver_history_events
        WHERE network = $1 AND lower(wallet_address) = lower($2)
          AND ($3::text IS NULL OR lower(token_contract) = lower($3))
        ORDER BY block_timestamp DESC, id DESC
        LIMIT $4`,
      [network, address, contract, limit],
    ),
    db.query(
      `SELECT network, transaction_hash, token_contract, from_address, to_address,
              amount_base_units::text AS amount_base_units, block_number, log_index, result, created_at
         FROM ${schema}.transfer_verifications
        WHERE network = $1 AND lower(to_address) = lower($2)
          AND ($3::text IS NULL OR lower(token_contract) = lower($3))
          AND verification_status = 'verified-on-chain'
        ORDER BY block_number DESC NULLS LAST, created_at DESC, id DESC
        LIMIT $4`,
      [network, address, contract, limit],
    ),
  ])

  const indexedAndWorkerRecords = historyResult.rows.map((row) => ({
    transactionId: row.transaction_hash?.trim() || null,
    network: row.network,
    receiverAddress: row.to_address,
    senderAddress: row.from_address,
    tokenContract: row.token_contract,
    tokenName: row.token_name,
    tokenSymbol: row.token_symbol,
    tokenDecimals: row.token_decimals === null ? null : Number(row.token_decimals),
    amountBaseUnits: row.amount_base_units,
    timestamp: Number(row.block_timestamp),
    verificationStatus: row.verification_status,
    verifiedOnChain: row.verified_on_chain === true,
    eventIndex: row.event_index,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  }))

  const solidifiedVerifiedRecords = verifiedTransfersResult.rows.map((row) => {
    const evidence = row.result && typeof row.result === 'object' ? row.result : {}
    const evidenceTimestamp = Number.isSafeInteger(evidence.timestamp) && evidence.timestamp >= 0
      ? evidence.timestamp
      : new Date(row.created_at).getTime()
    return {
      transactionId: row.transaction_hash?.trim() || null,
      network: row.network,
      receiverAddress: row.to_address,
      senderAddress: row.from_address,
      tokenContract: row.token_contract,
      tokenName: null,
      tokenSymbol: null,
      tokenDecimals: null,
      amountBaseUnits: row.amount_base_units,
      timestamp: evidenceTimestamp,
      verificationStatus: 'verified-on-chain',
      verifiedOnChain: true,
      eventIndex: row.log_index,
      firstSeenAt: row.created_at,
      lastSeenAt: row.created_at,
    }
  })

  const sameTransfer = (left, right) =>
    (left.transactionId || '').toLowerCase() === (right.transactionId || '').toLowerCase()
    && (left.tokenContract || '').toLowerCase() === (right.tokenContract || '').toLowerCase()
    && (left.senderAddress || '').toLowerCase() === (right.senderAddress || '').toLowerCase()
    && (left.receiverAddress || '').toLowerCase() === (right.receiverAddress || '').toLowerCase()
    && left.amountBaseUnits === right.amountBaseUnits

  const merged = [...indexedAndWorkerRecords]
  for (const verified of solidifiedVerifiedRecords) {
    const matching = merged.filter((record) => sameTransfer(record, verified))
    const retainedMetadata = matching[0] || {}
    const authoritative = {
      ...retainedMetadata,
      ...verified,
      tokenName: retainedMetadata.tokenName || verified.tokenName,
      tokenSymbol: retainedMetadata.tokenSymbol || verified.tokenSymbol,
      tokenDecimals: retainedMetadata.tokenDecimals ?? verified.tokenDecimals,
    }
    const remaining = merged.filter((record) => !sameTransfer(record, verified))
    remaining.push(authoritative)
    merged.splice(0, merged.length, ...remaining)
  }

  merged.sort((left, right) => {
    const leftTimestamp = Number(left.timestamp) || 0
    const rightTimestamp = Number(right.timestamp) || 0
    return rightTimestamp - leftTimestamp
  })

  return {
    success: true,
    records: merged.slice(0, limit),
  }
}

 /** Register a receiver for the opt-in history worker. Caller authorization is
 * enforced by the route; this helper only performs a validated, idempotent DB write. */
export async function registerTrackedWallet({ network, address, displayLabel = null } = {}) {
  if (!['mainnet', 'shasta', 'nile'].includes(network)
    || typeof address !== 'string' || !/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)
    || (displayLabel !== null && (typeof displayLabel !== 'string' || displayLabel.length > 80))) {
    return { success: false, reason: 'invalid-query' }
  }
  const db = getPool()
  if (!db) return { success: false, reason: 'database-not-configured' }
  await initializeDatabase()
  const inserted = await db.query(
    `INSERT INTO ${schema}.tracked_wallets (network, wallet_address, display_label)
     VALUES ($1, $2, $3)
     ON CONFLICT (network, wallet_address) DO NOTHING
     RETURNING id`,
    [network, address, displayLabel],
  )
  if (inserted.rowCount > 0) return { success: true, created: true }
  if (displayLabel !== null) {
    await db.query(
      `UPDATE ${schema}.tracked_wallets
          SET display_label = COALESCE($3, display_label)
        WHERE network = $1 AND wallet_address = $2`,
      [network, address, displayLabel],
    )
  }
  return { success: true, created: false }
}

const PROVIDER_APPLICATION_SCOPES = new Set(['network-fees', 'trx-grant', 'trc20-grant'])
const PROVIDER_APPLICATION_REFERENCE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const PROVIDER_APPLICATION_STATUS_TRANSITIONS = Object.freeze({
  'pending-review': ['in-review', 'accepted-for-due-diligence', 'declined', 'closed'],
  'in-review': ['accepted-for-due-diligence', 'declined', 'closed'],
  'accepted-for-due-diligence': ['in-review', 'declined', 'closed'],
  'declined': ['closed'],
  'closed': [],
})

export function isSponsorProviderApplicationStatusTransitionAllowed(currentStatus, nextStatus) {
  const allowed = PROVIDER_APPLICATION_STATUS_TRANSITIONS[currentStatus]
  return Array.isArray(allowed) && allowed.includes(nextStatus)
}


function normalizeProviderApplication(input = {}) {
  const reference = typeof input.reference === 'string' ? input.reference.trim() : ''
  const providerName = typeof input.providerName === 'string' ? input.providerName.trim() : ''
  const contactEmail = typeof input.contactEmail === 'string' ? input.contactEmail.trim().toLowerCase() : ''
  const scope = input.scope
  if (!PROVIDER_APPLICATION_REFERENCE.test(reference)
    || providerName.length < 2 || providerName.length > 120
    || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(contactEmail)
    || contactEmail.length > 254
    || !PROVIDER_APPLICATION_SCOPES.has(scope)) return null
  return { reference, providerName, contactEmail, scope }
}

/** Store a minimal, consent-backed provider onboarding request. This records an
 * application only; it never verifies a sponsor agreement or enables transfers. */
export async function createSponsorProviderApplication(input = {}) {
  const normalized = normalizeProviderApplication(input)
  if (!normalized) return { success: false, reason: 'invalid-provider-application' }
  const db = getPool()
  if (!db) return { success: false, reason: 'database-not-configured' }
  try {
    await initializeDatabase()
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const inserted = await client.query(
        `INSERT INTO ${schema}.sponsor_provider_applications
           (reference, provider_name, contact_email, scope)
         VALUES ($1::uuid, $2, $3, $4)
         RETURNING reference, scope, status, created_at, updated_at`,
        [normalized.reference, normalized.providerName, normalized.contactEmail, normalized.scope],
      )
      await client.query(
        `INSERT INTO ${schema}.audit_events (event_type, entity_type, entity_reference, details)
         VALUES ('sponsor-provider-application-created', 'sponsor-provider-application', $1, $2::jsonb)`,
        [normalized.reference, JSON.stringify({ scope: normalized.scope, status: 'pending-review' })],
      )
      await client.query('COMMIT')
      const row = inserted.rows[0]
      return { success: true, application: {
        reference: row.reference,
        scope: row.scope,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      } }
    } catch (error) {
      try { await client.query('ROLLBACK') } catch {}
      if (error?.code === '23505') return { success: false, reason: 'duplicate-reference' }
      console.error('Provider application write failed:', error?.code || 'unknown')
      return { success: false, reason: 'database-unavailable' }
    } finally {
      client.release()
    }
  } catch (error) {
    console.error('Provider application initialization failed:', error?.code || 'unknown')
    return { success: false, reason: 'database-unavailable' }
  }
}

/** Public lookup exposes only an opaque reference and workflow status, never contact details. */
export async function getSponsorProviderApplicationStatus(reference) {
  if (typeof reference !== 'string' || !PROVIDER_APPLICATION_REFERENCE.test(reference.trim())) {
    return { success: false, reason: 'invalid-reference' }
  }
  const db = getPool()
  if (!db) return { success: false, reason: 'database-not-configured' }
  try {
    await initializeDatabase()
    const result = await db.query(
      `SELECT reference, scope, status, created_at, updated_at, reviewed_at
         FROM ${schema}.sponsor_provider_applications
        WHERE reference = $1::uuid`,
      [reference.trim()],
    )
    if (!result.rowCount) return { success: false, reason: 'application-not-found' }
    const row = result.rows[0]
    return { success: true, application: {
      reference: row.reference,
      scope: row.scope,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      reviewedAt: row.reviewed_at,
    } }
  } catch (error) {
    console.error('Provider application status lookup failed:', error?.code || 'unknown')
    return { success: false, reason: 'database-unavailable' }
  }
}

/** Admin-only listing helper; contact email is returned only to the protected operator route. */
export async function listSponsorProviderApplications({ status = null, limit = 50 } = {}) {
  const allowedStatuses = ['pending-review', 'in-review', 'accepted-for-due-diligence', 'declined', 'closed']
  if ((status !== null && !allowedStatuses.includes(status))
    || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    return { success: false, reason: 'invalid-query', applications: [] }
  }
  const db = getPool()
  if (!db) return { success: false, reason: 'database-not-configured', applications: [] }
  try {
    await initializeDatabase()
    const result = await db.query(
      `SELECT reference, provider_name, contact_email, scope, status, review_reference, created_at, updated_at, reviewed_at
         FROM ${schema}.sponsor_provider_applications
        WHERE ($1::text IS NULL OR status = $1)
        ORDER BY created_at ASC
        LIMIT $2`,
      [status, limit],
    )
    return { success: true, applications: result.rows.map((row) => ({
      reference: row.reference,
      providerName: row.provider_name,
      contactEmail: row.contact_email,
      scope: row.scope,
      status: row.status,
      reviewReference: row.review_reference,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      reviewedAt: row.reviewed_at,
    })) }
  } catch (error) {
    console.error('Provider application admin listing failed:', error?.code || 'unknown')
    return { success: false, reason: 'database-unavailable', applications: [] }
  }
}

/** Apply a protected, auditable onboarding decision. Acceptance is due diligence only. */
export async function reviewSponsorProviderApplication({ reference, status, reviewReference = null } = {}) {
  const normalizedReference = typeof reference === 'string' ? reference.trim() : ''
  const allowedStatuses = new Set(['in-review', 'accepted-for-due-diligence', 'declined', 'closed'])
  const normalizedReviewReference = typeof reviewReference === 'string' ? reviewReference.trim() : null
  if (!PROVIDER_APPLICATION_REFERENCE.test(normalizedReference)
    || !allowedStatuses.has(status)
    || (normalizedReviewReference !== null && (normalizedReviewReference.length < 2 || normalizedReviewReference.length > 160))
    || (status === 'accepted-for-due-diligence' && !normalizedReviewReference)) {
    return { success: false, reason: 'invalid-review' }
  }
  const db = getPool()
  if (!db) return { success: false, reason: 'database-not-configured' }
  try {
    await initializeDatabase()
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const current = await client.query(
        `SELECT reference, status, review_reference FROM ${schema}.sponsor_provider_applications
          WHERE reference = $1::uuid FOR UPDATE`,
        [normalizedReference],
      )
      if (!current.rowCount) {
        await client.query('ROLLBACK')
        return { success: false, reason: 'application-not-found' }
      }
      const row = current.rows[0]
      if (row.status === status && row.review_reference === normalizedReviewReference) {
        await client.query('COMMIT')
        return { success: true, duplicate: true, reference: row.reference, status: row.status }
      }
      if (!isSponsorProviderApplicationStatusTransitionAllowed(row.status, status)) {
        await client.query('ROLLBACK')
        return { success: false, reason: 'invalid-status-transition' }
      }
      const updated = await client.query(
        `UPDATE ${schema}.sponsor_provider_applications
            SET status = $2, review_reference = $3, updated_at = now(), reviewed_at = now()
          WHERE reference = $1::uuid
          RETURNING reference, status, updated_at, reviewed_at`,
        [normalizedReference, status, normalizedReviewReference],
      )
      await client.query(
        `INSERT INTO ${schema}.audit_events (event_type, entity_type, entity_reference, details)
         VALUES ('sponsor-provider-application-reviewed', 'sponsor-provider-application', $1, $2::jsonb)`,
        [normalizedReference, JSON.stringify({ status, reviewReference: normalizedReviewReference })],
      )
      await client.query('COMMIT')
      const reviewed = updated.rows[0]
      return { success: true, duplicate: false, reference: reviewed.reference, status: reviewed.status, updatedAt: reviewed.updated_at, reviewedAt: reviewed.reviewed_at }
    } catch (error) {
      try { await client.query('ROLLBACK') } catch {}
      console.error('Provider application review failed:', error?.code || 'unknown')
      return { success: false, reason: 'database-unavailable' }
    } finally {
      client.release()
    }
  } catch (error) {
    console.error('Provider application review initialization failed:', error?.code || 'unknown')
    return { success: false, reason: 'database-unavailable' }
  }
}


/**
 * Persist observed costs only for a transfer that has already reached confirmed
 * state through the exact-match solidified-chain verifier. This table is an
 * observation log, not a claim that a separate resource sponsor paid those costs.
 */
export async function recordSponsorChainCostObservation(input = {}) {
  const network = input.network;
  const transactionHash = typeof input.transactionHash === 'string' ? input.transactionHash.toLowerCase() : '';
  const idempotencyKey = input.idempotencyKey;
  const feeSponsorAddress = typeof input.feeSponsorAddress === 'string' ? input.feeSponsorAddress.trim() : '';
  const blockNumber = input.blockNumber;
  const amounts = ['amountBaseUnits', 'reportedFeeSun', 'energyFeeSun', 'netFeeSun',
    'energyUsageTotal', 'energyUsage', 'originEnergyUsage', 'netUsage', 'energyPenaltyTotal'];
  const integerValues = {};
  for (const key of amounts) {
    const value = input[key];
    if (value === null && ['energyFeeSun', 'netFeeSun', 'energyUsageTotal', 'energyUsage', 'originEnergyUsage', 'netUsage', 'energyPenaltyTotal'].includes(key)) {
      integerValues[key] = null;
    } else if (typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value)) {
      integerValues[key] = value;
    } else if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
      integerValues[key] = String(value);
    } else {
      return { success: false, reason: 'invalid-chain-cost-observation' };
    }
  }
  const asset = input.asset;
  const tokenContract = asset === 'TRX' ? null : (typeof input.tokenContract === 'string' ? input.tokenContract.trim() : '');
  if (!['nile', 'shasta'].includes(network)
    || !/^[0-9a-f]{64}$/.test(transactionHash)
    || typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{24,160}$/.test(idempotencyKey)
    || typeof input.sponsorReference !== 'string' || input.sponsorReference.length < 1 || input.sponsorReference.length > 128
    || !isValidTronAddress(feeSponsorAddress)
    || !isValidTronAddress(input.assetPrincipalAddress)
    || !isValidTronAddress(input.receiverAddress)
    || feeSponsorAddress === input.assetPrincipalAddress
    || !['TRX', 'USDT'].includes(asset)
    || (asset === 'TRX' && input.tokenContract != null)
    || (asset !== 'TRX' && !isValidTronAddress(tokenContract))
    || typeof blockNumber !== 'number' || !Number.isSafeInteger(blockNumber) || blockNumber <= 0
    || input.executionResult !== 'SUCCESS'
    || integerValues.amountBaseUnits === '0') {
    return { success: false, reason: 'invalid-chain-cost-observation' };
  }

  const db = getPool();
  if (!db) return { success: false, reason: 'database-not-configured' };
  try {
    await initializeDatabase();
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const transferResult = await client.query(
        `SELECT idempotency_key, sponsor_reference, sponsor_address, network, purpose, asset,
                token_contract, receiver_address, amount_base_units::text AS amount_base_units,
                status, transaction_hash
           FROM ${schema}.sponsor_transfers
          WHERE idempotency_key = $1
          FOR UPDATE`,
        [idempotencyKey],
      );
      if (!transferResult.rows.length) {
        await client.query('ROLLBACK');
        return { success: false, reason: 'transfer-not-found' };
      }
      const transfer = transferResult.rows[0];
      if (transfer.network !== network
        || transfer.purpose !== 'asset-grant'
        || transfer.status !== 'confirmed'
        || String(transfer.transaction_hash || '').trim().toLowerCase() !== transactionHash
        || transfer.sponsor_reference !== input.sponsorReference
        || transfer.sponsor_address !== input.assetPrincipalAddress
        || transfer.receiver_address !== input.receiverAddress
        || transfer.asset !== asset
        || (transfer.token_contract || null) !== tokenContract
        || String(transfer.amount_base_units) !== integerValues.amountBaseUnits) {
        await client.query('ROLLBACK');
        return { success: false, reason: 'confirmed-transfer-identity-mismatch' };
      }

      let evidence;
      if (asset === 'TRX') {
        evidence = await client.query(
          `SELECT block_number::text AS block_number
             FROM ${schema}.native_transfer_verifications
            WHERE network = $1 AND transaction_hash = $2
              AND lower(from_address) = lower($3) AND lower(to_address) = lower($4)
              AND amount_sun = $5::numeric AND verification_status = 'verified-on-chain'
            LIMIT 1`,
          [network, transactionHash, input.assetPrincipalAddress, input.receiverAddress, integerValues.amountBaseUnits],
        );
      } else {
        evidence = await client.query(
          `SELECT block_number::text AS block_number
             FROM ${schema}.transfer_verifications
            WHERE network = $1 AND transaction_hash = $2
              AND lower(token_contract) = lower($3)
              AND lower(from_address) = lower($4) AND lower(to_address) = lower($5)
              AND amount_base_units = $6::numeric AND verification_status = 'verified-on-chain'
            LIMIT 1`,
          [network, transactionHash, tokenContract, input.assetPrincipalAddress, input.receiverAddress, integerValues.amountBaseUnits],
        );
      }
      if (!evidence.rows.length || String(evidence.rows[0].block_number) !== String(blockNumber)) {
        await client.query('ROLLBACK');
        return { success: false, reason: 'matching-solidified-transfer-evidence-required' };
      }

      const existingResult = await client.query(
        `SELECT network, transaction_hash, idempotency_key, sponsor_reference, fee_sponsor_address,
                asset_principal_address, receiver_address, asset, token_contract,
                amount_base_units::text AS amount_base_units, block_number::text AS block_number,
                execution_result, reported_fee_sun::text AS reported_fee_sun,
                energy_fee_sun::text AS energy_fee_sun, net_fee_sun::text AS net_fee_sun,
                energy_usage_total::text AS energy_usage_total, energy_usage::text AS energy_usage,
                origin_energy_usage::text AS origin_energy_usage,
                net_usage::text AS net_usage, energy_penalty_total::text AS energy_penalty_total
           FROM ${schema}.sponsor_chain_cost_observations
          WHERE network = $1 AND transaction_hash = $2
          FOR UPDATE`,
        [network, transactionHash],
      );
      const incoming = {
        network, transaction_hash: transactionHash, idempotency_key: idempotencyKey,
        sponsor_reference: input.sponsorReference, fee_sponsor_address: feeSponsorAddress,
        asset_principal_address: input.assetPrincipalAddress, receiver_address: input.receiverAddress,
        asset, token_contract: tokenContract, amount_base_units: integerValues.amountBaseUnits,
        block_number: String(blockNumber), execution_result: 'SUCCESS',
        reported_fee_sun: integerValues.reportedFeeSun,
        energy_fee_sun: integerValues.energyFeeSun, net_fee_sun: integerValues.netFeeSun,
        energy_usage_total: integerValues.energyUsageTotal, energy_usage: integerValues.energyUsage,
        origin_energy_usage: integerValues.originEnergyUsage,
        net_usage: integerValues.netUsage, energy_penalty_total: integerValues.energyPenaltyTotal,
      };
      const same = (row) => Object.keys(incoming).every((key) => {
        const left = row[key] == null ? null : String(row[key]).trim().toLowerCase();
        const right = incoming[key] == null ? null : String(incoming[key]).trim().toLowerCase();
        return left === right;
      });
      if (existingResult.rows.length) {
        if (!same(existingResult.rows[0])) {
          await client.query('ROLLBACK');
          return { success: false, reason: 'chain-cost-observation-conflict' };
        }
        await client.query('COMMIT');
        return { success: true, duplicate: true, observation: incoming };
      }

      await client.query(
        `INSERT INTO ${schema}.sponsor_chain_cost_observations
          (network, transaction_hash, idempotency_key, sponsor_reference, fee_sponsor_address,
           asset_principal_address, receiver_address, asset, token_contract, amount_base_units,
           block_number, execution_result, reported_fee_sun, energy_fee_sun, net_fee_sun,
           energy_usage_total, energy_usage, origin_energy_usage, net_usage, energy_penalty_total)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::numeric,$11,$12,$13::numeric,
                 $14::numeric,$15::numeric,$16::numeric,$17::numeric,$18::numeric,$19::numeric,$20::numeric)`,
        [network, transactionHash, idempotencyKey, input.sponsorReference, feeSponsorAddress,
          input.assetPrincipalAddress, input.receiverAddress, asset, tokenContract,
          integerValues.amountBaseUnits, blockNumber, 'SUCCESS', integerValues.reportedFeeSun,
          integerValues.energyFeeSun, integerValues.netFeeSun, integerValues.energyUsageTotal,
          integerValues.energyUsage, integerValues.originEnergyUsage, integerValues.netUsage, integerValues.energyPenaltyTotal],
      );
      await client.query(
        `INSERT INTO ${schema}.audit_events (event_type, entity_type, entity_reference, details)
         VALUES ('sponsor-chain-cost-observed', 'sponsor-transfer', $1, $2::jsonb)`,
        [idempotencyKey, JSON.stringify({
          network, transactionHash, blockNumber, reportedFeeSun: integerValues.reportedFeeSun,
          energyFeeSun: integerValues.energyFeeSun, netFeeSun: integerValues.netFeeSun,
          observationOnly: true, sponsorFeeBudgetSettled: false,
        })],
      );
      await client.query('COMMIT');
      return { success: true, duplicate: false, observation: incoming };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('Sponsor chain cost observation persistence failed:', error?.code || 'unknown');
      return { success: false, reason: 'database-unavailable' };
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Sponsor chain cost observation initialization failed:', error?.code || 'unknown');
    return { success: false, reason: 'database-unavailable' };
  }
}

/** Read-only list of chain cost observations; it never settles or adjusts budgets. */
export async function listSponsorChainCostObservations({ network = null, limit = 50 } = {}) {
  if (network !== null && !['nile', 'shasta'].includes(network)) {
    return { success: false, reason: 'invalid-network', observations: [] };
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return { success: false, reason: 'invalid-limit', observations: [] };
  }
  const db = getPool();
  if (!db) return { success: false, reason: 'database-not-configured', observations: [] };
  try {
    await initializeDatabase();
    const result = await db.query(
      `SELECT network, transaction_hash, idempotency_key, sponsor_reference, fee_sponsor_address,
              asset_principal_address, receiver_address, asset, token_contract,
              amount_base_units::text AS amount_base_units, block_number::text AS block_number,
              execution_result, reported_fee_sun::text AS reported_fee_sun,
              energy_fee_sun::text AS energy_fee_sun, net_fee_sun::text AS net_fee_sun,
              energy_usage_total::text AS energy_usage_total, energy_usage::text AS energy_usage,
              origin_energy_usage::text AS origin_energy_usage,
              net_usage::text AS net_usage, energy_penalty_total::text AS energy_penalty_total,
              evidence_source, observed_at
         FROM ${schema}.sponsor_chain_cost_observations
        WHERE ($1::text IS NULL OR network = $1)
        ORDER BY observed_at DESC, id DESC
        LIMIT $2`,
      [network, limit],
    );
    const observations = result.rows.map((row) => ({
      network: row.network,
      transactionHash: String(row.transaction_hash).trim().toLowerCase(),
      idempotencyKey: row.idempotency_key,
      sponsorReference: row.sponsor_reference,
      feeSponsorAddress: row.fee_sponsor_address,
      assetPrincipalAddress: row.asset_principal_address,
      receiverAddress: row.receiver_address,
      asset: row.asset,
      tokenContract: row.token_contract,
      amountBaseUnits: row.amount_base_units,
      blockNumber: row.block_number,
      executionResult: row.execution_result,
      reportedFeeSun: row.reported_fee_sun,
      energyFeeSun: row.energy_fee_sun,
      netFeeSun: row.net_fee_sun,
      energyUsageTotal: row.energy_usage_total,
      energyUsage: row.energy_usage,
      originEnergyUsage: row.origin_energy_usage,
      netUsage: row.net_usage,
      energyPenaltyTotal: row.energy_penalty_total,
      evidenceSource: row.evidence_source,
      observedAt: row.observed_at,
      sponsorFeeBudgetSettled: false,
    }));
    return { success: true, observations };
  } catch (error) {
    console.error('Sponsor chain cost observation list failed:', error?.code || 'unknown');
    return { success: false, reason: 'database-unavailable', observations: [] };
  }
}


/**
 * Reserve transaction-specific delegated Energy/Bandwidth against a server-only
 * reviewed resource mandate. The public wallet supplies no costs or sponsor IDs:
 * all transfer identity comes from the persisted reservation and the preflight
 * snapshot is produced by verifySponsorFeeResourceCapacity.
 */
export async function reserveSponsorResourceBudgetForTransfer({
  idempotencyKey,
  feeCapacity,
  transactionExpiresAt,
  env = process.env,
} = {}) {
  if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{24,160}$/.test(idempotencyKey)
    || !feeCapacity || feeCapacity.success !== true
    || feeCapacity.feeSponsorResourceSourceVerified !== true
    || feeCapacity.resourceCapacityPreflightPassed !== true
    || typeof feeCapacity.feeSponsorAddress !== 'string'
    || !Number.isSafeInteger(transactionExpiresAt)
    || transactionExpiresAt <= Date.now()
    || transactionExpiresAt > Date.now() + 10 * 60 * 1000) {
    return { reserved: false, reason: 'invalid-resource-reservation-request' }
  }
  const energyRequired = feeCapacity.requiredEnergyUnits
  const bandwidthRequired = feeCapacity.requiredBandwidthUnits
  if (typeof energyRequired !== 'string' || !/^(0|[1-9][0-9]*)$/.test(energyRequired)
    || typeof bandwidthRequired !== 'string' || !/^[1-9][0-9]*$/.test(bandwidthRequired)
    || feeCapacity.bandwidthCoverageSource !== 'exact-active-fee-sponsor-delegation-only'
    || (BigInt(energyRequired) > 0n && feeCapacity.energyCoverageSource !== 'exact-active-fee-sponsor-delegation-only')) {
    return { reserved: false, reason: 'resource-preflight-source-not-verified' }
  }

  const db = getPool()
  if (!db) return { reserved: false, reason: 'database-not-configured' }
  try {
    await initializeDatabase()
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const result = await client.query(
        `SELECT idempotency_key, sponsor_reference, sponsor_address, network, purpose,
                amount_base_units::text AS amount_base_units, status, transaction_hash
           FROM ${schema}.sponsor_transfers
          WHERE idempotency_key = $1 FOR UPDATE`,
        [idempotencyKey],
      )
      if (!result.rows.length) {
        await client.query('ROLLBACK')
        return { reserved: false, reason: 'transfer-not-found' }
      }
      const transfer = result.rows[0]
      if (!['nile','shasta'].includes(transfer.network) || transfer.purpose !== 'asset-grant'
        || transfer.status !== 'pending-review' || transfer.transaction_hash
        || feeCapacity.network !== transfer.network) {
        await client.query('ROLLBACK')
        return { reserved: false, reason: 'pending-testnet-transfer-required' }
      }
      const mandate = findApprovedSponsorResourceMandate({
        env,
        sponsorReference: transfer.sponsor_reference,
        network: transfer.network,
        feeSponsorAddress: feeCapacity.feeSponsorAddress,
        assetPrincipalAddress: transfer.sponsor_address,
      })
      if (!mandate) {
        await client.query('ROLLBACK')
        return { reserved: false, reason: 'approved-resource-mandate-not-configured' }
      }
      if (BigInt(energyRequired) > BigInt(mandate.perTransferEnergyUnits)
        || BigInt(bandwidthRequired) > BigInt(mandate.perTransferBandwidthUnits)) {
        await client.query('ROLLBACK')
        return { reserved: false, reason: 'resource-per-transfer-cap-exceeded' }
      }
      const capacitySnapshot = {
        resourceCapacityPreflightPassed: true,
        feeSponsorResourceSourceVerified: true,
        feeSponsorAddress: feeCapacity.feeSponsorAddress,
        availableEnergyUnits: String(feeCapacity.availableEnergyUnits ?? '0'),
        requiredEnergyUnits: energyRequired,
        availableBandwidthUnits: String(feeCapacity.availableBandwidthUnits ?? '0'),
        requiredBandwidthUnits: bandwidthRequired,
        bandwidthCoverageSource: feeCapacity.bandwidthCoverageSource,
        energyCoverageSource: feeCapacity.energyCoverageSource ?? null,
        resourceSource: feeCapacity.resourceSource || null,
        checkedAt: new Date().toISOString(),
      }
      if (BigInt(capacitySnapshot.availableEnergyUnits) < BigInt(energyRequired)
        || BigInt(capacitySnapshot.availableBandwidthUnits) < BigInt(bandwidthRequired)) {
        await client.query('ROLLBACK')
        return { reserved: false, reason: 'resource-capacity-below-reservation' }
      }

      await client.query(
        `INSERT INTO ${schema}.sponsor_resource_budgets
          (mandate_reference, sponsor_reference, network, fee_sponsor_address, asset_principal_address,
           energy_budget_units, bandwidth_budget_units, per_transfer_energy_units, per_transfer_bandwidth_units)
         VALUES ($1,$2,$3,$4,$5,$6::numeric,$7::numeric,$8::numeric,$9::numeric)
         ON CONFLICT (mandate_reference) DO NOTHING`,
        [mandate.mandateReference, mandate.sponsorReference, mandate.network, mandate.feeSponsorAddress,
          mandate.assetPrincipalAddress, mandate.energyBudgetUnits, mandate.bandwidthBudgetUnits,
          mandate.perTransferEnergyUnits, mandate.perTransferBandwidthUnits],
      )
      const budgetResult = await client.query(
        `SELECT id::text AS id, mandate_reference, energy_budget_units::text AS energy_budget_units,
                bandwidth_budget_units::text AS bandwidth_budget_units,
                per_transfer_energy_units::text AS per_transfer_energy_units,
                per_transfer_bandwidth_units::text AS per_transfer_bandwidth_units,
                energy_reserved_units::text AS energy_reserved_units,
                bandwidth_reserved_units::text AS bandwidth_reserved_units,
                energy_spent_units::text AS energy_spent_units,
                bandwidth_spent_units::text AS bandwidth_spent_units, status
           FROM ${schema}.sponsor_resource_budgets
          WHERE mandate_reference=$1 FOR UPDATE`,
        [mandate.mandateReference],
      )
      if (!budgetResult.rows.length) {
        await client.query('ROLLBACK')
        return { reserved: false, reason: 'resource-budget-unavailable' }
      }
      const budget = budgetResult.rows[0]
      const exactMandate = budget.energy_budget_units === mandate.energyBudgetUnits
        && budget.bandwidth_budget_units === mandate.bandwidthBudgetUnits
        && budget.per_transfer_energy_units === mandate.perTransferEnergyUnits
        && budget.per_transfer_bandwidth_units === mandate.perTransferBandwidthUnits
      if (!exactMandate || budget.status !== 'active') {
        await client.query('ROLLBACK')
        return { reserved: false, reason: budget.status === 'paused' ? 'resource-budget-paused' : 'resource-mandate-database-conflict' }
      }

      const oldResult = await client.query(
        `SELECT mandate_reference, energy_reserved_units::text AS energy_reserved_units,
                bandwidth_reserved_units::text AS bandwidth_reserved_units, status, expires_at
           FROM ${schema}.sponsor_resource_reservations
          WHERE idempotency_key=$1 FOR UPDATE`,
        [idempotencyKey],
      )
      if (oldResult.rows.length) {
        const old = oldResult.rows[0]
        if (old.status === 'reserved' && new Date(old.expires_at).getTime() > Date.now()
          && old.mandate_reference === mandate.mandateReference
          && old.energy_reserved_units === energyRequired
          && old.bandwidth_reserved_units === bandwidthRequired) {
          await client.query('COMMIT')
          return { reserved: true, duplicate: true, status: 'reserved', mandateReference: mandate.mandateReference }
        }
        if (old.status === 'reserved' && new Date(old.expires_at).getTime() <= Date.now()
          && old.mandate_reference === mandate.mandateReference && transfer.status === 'pending-review') {
          await client.query(
            `UPDATE ${schema}.sponsor_resource_budgets
                SET energy_reserved_units=energy_reserved_units-$1::numeric,
                    bandwidth_reserved_units=bandwidth_reserved_units-$2::numeric, updated_at=now()
              WHERE mandate_reference=$3 AND energy_reserved_units >= $1::numeric
                AND bandwidth_reserved_units >= $2::numeric`,
            [old.energy_reserved_units, old.bandwidth_reserved_units, mandate.mandateReference],
          )
          await client.query(
            `UPDATE ${schema}.sponsor_resource_reservations
                SET status='released', settlement_reason='unsigned-transaction-expired',
                    updated_at=now() WHERE idempotency_key=$1 AND status='reserved'`,
            [idempotencyKey],
          )
        } else if (old.status !== 'released') {
          await client.query('ROLLBACK')
          return { reserved: false, reason: 'resource-reservation-already-consumed-or-held' }
        }
      }

      const refreshedBudgetResult = await client.query(
        `SELECT energy_budget_units::text AS energy_budget_units,
                bandwidth_budget_units::text AS bandwidth_budget_units,
                energy_reserved_units::text AS energy_reserved_units,
                bandwidth_reserved_units::text AS bandwidth_reserved_units,
                energy_spent_units::text AS energy_spent_units,
                bandwidth_spent_units::text AS bandwidth_spent_units, status
           FROM ${schema}.sponsor_resource_budgets
          WHERE mandate_reference=$1 FOR UPDATE`,
        [mandate.mandateReference],
      )
      const refreshedBudget = refreshedBudgetResult.rows[0]
      if (!refreshedBudget || refreshedBudget.status !== 'active') {
        await client.query('ROLLBACK')
        return { reserved: false, reason: 'resource-budget-paused' }
      }
      const energyAvailable = BigInt(refreshedBudget.energy_budget_units) - BigInt(refreshedBudget.energy_reserved_units) - BigInt(refreshedBudget.energy_spent_units)
      const bandwidthAvailable = BigInt(refreshedBudget.bandwidth_budget_units) - BigInt(refreshedBudget.bandwidth_reserved_units) - BigInt(refreshedBudget.bandwidth_spent_units)
      if (BigInt(energyRequired) > energyAvailable || BigInt(bandwidthRequired) > bandwidthAvailable) {
        await client.query('ROLLBACK')
        return { reserved: false, reason: 'insufficient-sponsor-resource-budget' }
      }
      await client.query(
        `UPDATE ${schema}.sponsor_resource_budgets
            SET energy_reserved_units=energy_reserved_units+$1::numeric,
                bandwidth_reserved_units=bandwidth_reserved_units+$2::numeric, updated_at=now()
          WHERE mandate_reference=$3`,
        [energyRequired, bandwidthRequired, mandate.mandateReference],
      )
      if (oldResult.rows.length) {
        await client.query(
          `UPDATE ${schema}.sponsor_resource_reservations
              SET mandate_reference=$2, network=$3, transaction_hash=NULL, fee_sponsor_address=$4,
                  asset_principal_address=$5, energy_reserved_units=$6::numeric,
                  bandwidth_reserved_units=$7::numeric, energy_consumed_units=NULL,
                  bandwidth_consumed_units=NULL, capacity_snapshot=$8::jsonb,
                  status='reserved', settlement_reason=NULL, settlement_block_number=NULL,
                  expires_at=to_timestamp($9::double precision / 1000.0), settled_at=NULL, updated_at=now()
            WHERE idempotency_key=$1`,
          [idempotencyKey, mandate.mandateReference, mandate.network, mandate.feeSponsorAddress,
            mandate.assetPrincipalAddress, energyRequired, bandwidthRequired,
            JSON.stringify(capacitySnapshot), transactionExpiresAt],
        )
      } else {
        await client.query(
          `INSERT INTO ${schema}.sponsor_resource_reservations
            (idempotency_key, mandate_reference, network, fee_sponsor_address, asset_principal_address,
             energy_reserved_units, bandwidth_reserved_units, capacity_snapshot, expires_at)
           VALUES ($1,$2,$3,$4,$5,$6::numeric,$7::numeric,$8::jsonb,to_timestamp($9::double precision / 1000.0))`,
          [idempotencyKey, mandate.mandateReference, mandate.network, mandate.feeSponsorAddress,
            mandate.assetPrincipalAddress, energyRequired, bandwidthRequired,
            JSON.stringify(capacitySnapshot), transactionExpiresAt],
        )
      }
      await client.query(
        `INSERT INTO ${schema}.audit_events (event_type, entity_type, entity_reference, details)
         VALUES ('sponsor-resource-budget-reserved','sponsor-resource-reservation',$1,$2::jsonb)`,
        [idempotencyKey, JSON.stringify({
          mandateReference: mandate.mandateReference, network: mandate.network,
          feeSponsorAddress: mandate.feeSponsorAddress, assetPrincipalAddress: mandate.assetPrincipalAddress,
          energyReservedUnits: energyRequired, bandwidthReservedUnits: bandwidthRequired,
          transactionExpiresAt, feeSponsorResourceSourceVerified: true,
        })],
      )
      await client.query('COMMIT')
      return { reserved: true, duplicate: false, status: 'reserved', mandateReference: mandate.mandateReference }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      console.error('Sponsor resource budget reservation failed:', error?.code || 'unknown')
      return { reserved: false, reason: 'database-unavailable' }
    } finally {
      client.release()
    }
  } catch (error) {
    console.error('Sponsor resource budget initialization failed:', error?.code || 'unknown')
    return { reserved: false, reason: 'database-unavailable' }
  }
}

/** Reconcile resource units only after an exact solidified transfer and cost observation exist. */
export async function settleSponsorResourceBudgetForTransfer({
  idempotencyKey,
  feeSponsorAddress,
  costs,
} = {}) {
  if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{24,160}$/.test(idempotencyKey)
    || !isValidTronAddress(feeSponsorAddress) || !costs || typeof costs !== 'object') {
    return { success: false, reason: 'invalid-resource-settlement-request' }
  }
  const db = getPool()
  if (!db) return { success: false, reason: 'database-not-configured' }
  try {
    await initializeDatabase()
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const transferResult = await client.query(
        `SELECT idempotency_key, sponsor_reference, sponsor_address, network, purpose, asset,
                token_contract, receiver_address, amount_base_units::text AS amount_base_units,
                status, transaction_hash
           FROM ${schema}.sponsor_transfers WHERE idempotency_key=$1 FOR UPDATE`,
        [idempotencyKey],
      )
      if (!transferResult.rows.length) {
        await client.query('ROLLBACK')
        return { success: false, reason: 'transfer-not-found' }
      }
      const row = transferResult.rows[0]
      if (row.status !== 'confirmed' || row.purpose !== 'asset-grant'
        || !['nile','shasta'].includes(row.network)
        || String(row.transaction_hash || '').trim().toLowerCase() !== String(costs.transactionHash || '').toLowerCase()
        || row.network !== costs.network) {
        await client.query('ROLLBACK')
        return { success: false, reason: 'confirmed-transfer-identity-mismatch' }
      }

      const reservationResult = await client.query(
        `SELECT r.idempotency_key, r.mandate_reference, r.network, r.transaction_hash,
                r.fee_sponsor_address, r.asset_principal_address,
                r.energy_reserved_units::text AS energy_reserved_units,
                r.bandwidth_reserved_units::text AS bandwidth_reserved_units,
                r.energy_consumed_units::text AS energy_consumed_units,
                r.bandwidth_consumed_units::text AS bandwidth_consumed_units,
                r.capacity_snapshot, r.status, r.settlement_block_number,
                b.energy_reserved_units::text AS budget_energy_reserved_units,
                b.bandwidth_reserved_units::text AS budget_bandwidth_reserved_units,
                b.status AS budget_status
           FROM ${schema}.sponsor_resource_reservations r
           JOIN ${schema}.sponsor_resource_budgets b ON b.mandate_reference=r.mandate_reference
          WHERE r.idempotency_key=$1 FOR UPDATE OF r,b`,
        [idempotencyKey],
      )
      if (!reservationResult.rows.length) {
        await client.query('ROLLBACK')
        return { success: false, reason: 'resource-reservation-not-found' }
      }
      const reservation = reservationResult.rows[0]
      const transferTxId = String(row.transaction_hash || '').trim().toLowerCase()
      const resourceTxId = String(reservation.transaction_hash || '').trim().toLowerCase()
      if (reservation.fee_sponsor_address !== feeSponsorAddress
        || reservation.asset_principal_address !== row.sponsor_address
        || reservation.network !== row.network
        || !transferTxId || resourceTxId !== transferTxId
        || String(costs.blockNumber) === '' || !Number.isSafeInteger(costs.blockNumber)) {
        await client.query('ROLLBACK')
        return { success: false, reason: 'resource-reservation-identity-mismatch' }
      }
      if (reservation.status === 'settled') {
        const same = reservation.settlement_block_number === costs.blockNumber
          && reservation.transaction_hash === row.transaction_hash
          && reservation.energy_consumed_units === String(costs.energyUsage ?? '0')
          && reservation.bandwidth_consumed_units === String(costs.netUsage ?? '0')
        await client.query('COMMIT')
        return same
          ? { success: true, settled: true, duplicate: true, status: 'settled', mandateReference: reservation.mandate_reference }
          : { success: false, reason: 'resource-settlement-conflict' }
      }
      if (reservation.status !== 'reserved') {
        await client.query('ROLLBACK')
        return { success: false, reason: 'resource-reservation-not-settleable', status: reservation.status }
      }

      const observation = await client.query(
        `SELECT block_number::text AS block_number, reported_fee_sun::text AS reported_fee_sun,
                energy_fee_sun::text AS energy_fee_sun, net_fee_sun::text AS net_fee_sun,
                energy_usage::text AS energy_usage, net_usage::text AS net_usage
           FROM ${schema}.sponsor_chain_cost_observations
          WHERE network=$1 AND transaction_hash=$2 AND idempotency_key=$3
            AND fee_sponsor_address=$4 AND asset_principal_address=$5 FOR UPDATE`,
        [row.network, String(row.transaction_hash).trim().toLowerCase(), idempotencyKey,
          feeSponsorAddress, row.sponsor_address],
      )
      if (!observation.rows.length || observation.rows[0].block_number !== String(costs.blockNumber)) {
        await client.query('ROLLBACK')
        return { success: false, reason: 'matching-solidified-cost-observation-required' }
      }
      const storedCosts = observation.rows[0]
      const sameOptionalInteger = (stored, supplied) => stored === null || stored === undefined
        ? supplied === null || supplied === undefined
        : String(stored) === String(supplied)
      const observationMatches = sameOptionalInteger(storedCosts.reported_fee_sun, costs.reportedFeeSun)
        && sameOptionalInteger(storedCosts.energy_fee_sun, costs.energyFeeSun)
        && sameOptionalInteger(storedCosts.net_fee_sun, costs.netFeeSun)
        && sameOptionalInteger(storedCosts.energy_usage, costs.energyUsage)
        && sameOptionalInteger(storedCosts.net_usage, costs.netUsage)
      if (!observationMatches) {
        await client.query('ROLLBACK')
        return { success: false, reason: 'cost-observation-conflict' }
      }

      const evaluated = evaluateSponsorResourceCostSettlement({
        transfer: {
          idempotencyKey,
          network: row.network,
          transactionHash: String(row.transaction_hash).trim().toLowerCase(),
          sponsorAddress: row.sponsor_address,
          asset: row.asset,
        },
        costs,
        reservation: {
          idempotencyKey,
          network: reservation.network,
          transactionHash: resourceTxId,
          feeSponsorAddress: reservation.fee_sponsor_address,
          assetPrincipalAddress: reservation.asset_principal_address,
          energyReservedUnits: reservation.energy_reserved_units,
          bandwidthReservedUnits: reservation.bandwidth_reserved_units,
          capacitySnapshot: reservation.capacity_snapshot,
          status: reservation.status,
        },
      })
      if (!evaluated.settled) {
        await client.query(
          `UPDATE ${schema}.sponsor_resource_reservations
              SET status='manual-review', settlement_reason=$2, transaction_hash=$3,
                  settlement_block_number=$4, updated_at=now()
            WHERE idempotency_key=$1 AND status='reserved'`,
          [idempotencyKey, evaluated.reason, row.transaction_hash, costs.blockNumber],
        )
        await client.query(
          `INSERT INTO ${schema}.audit_events (event_type, entity_type, entity_reference, details)
           VALUES ('sponsor-resource-settlement-manual-review','sponsor-resource-reservation',$1,$2::jsonb)`,
          [idempotencyKey, JSON.stringify({
            reason: evaluated.reason, network: row.network, transactionHash: row.transaction_hash,
            blockNumber: costs.blockNumber, reportedFeeSun: costs.reportedFeeSun,
            energyFeeSun: costs.energyFeeSun, netFeeSun: costs.netFeeSun,
            resourceBudgetRetained: true,
          })],
        )
        await client.query('COMMIT')
        return { success: true, settled: false, status: 'manual-review', reason: evaluated.reason, reservationRetained: true }
      }

      if (BigInt(reservation.budget_energy_reserved_units) < BigInt(reservation.energy_reserved_units)
        || BigInt(reservation.budget_bandwidth_reserved_units) < BigInt(reservation.bandwidth_reserved_units)
        || !['active', 'paused'].includes(reservation.budget_status)) {
        await client.query('ROLLBACK')
        return { success: false, reason: 'resource-budget-reservation-invariant-failed' }
      }
      await client.query(
        `UPDATE ${schema}.sponsor_resource_budgets
            SET energy_reserved_units=energy_reserved_units-$1::numeric,
                bandwidth_reserved_units=bandwidth_reserved_units-$2::numeric,
                energy_spent_units=energy_spent_units+$3::numeric,
                bandwidth_spent_units=bandwidth_spent_units+$4::numeric,
                updated_at=now()
          WHERE mandate_reference=$5`,
        [evaluated.energyReservedUnits, evaluated.bandwidthReservedUnits,
          evaluated.energyConsumedUnits, evaluated.bandwidthConsumedUnits, reservation.mandate_reference],
      )
      await client.query(
        `UPDATE ${schema}.sponsor_resource_reservations
            SET status='settled', transaction_hash=$2, energy_consumed_units=$3::numeric,
                bandwidth_consumed_units=$4::numeric, settlement_reason=$5,
                settlement_block_number=$6, settled_at=now(), updated_at=now()
          WHERE idempotency_key=$1 AND status='reserved'`,
        [idempotencyKey, row.transaction_hash, evaluated.energyConsumedUnits,
          evaluated.bandwidthConsumedUnits, evaluated.settlementReason, costs.blockNumber],
      )
      await client.query(
        `INSERT INTO ${schema}.audit_events (event_type, entity_type, entity_reference, details)
         VALUES ('sponsor-resource-budget-settled','sponsor-resource-reservation',$1,$2::jsonb)`,
        [idempotencyKey, JSON.stringify({
          mandateReference: reservation.mandate_reference, network: row.network,
          feeSponsorAddress, assetPrincipalAddress: row.sponsor_address,
          transactionHash: String(row.transaction_hash).trim().toLowerCase(),
          blockNumber: costs.blockNumber, energyConsumedUnits: evaluated.energyConsumedUnits,
          bandwidthConsumedUnits: evaluated.bandwidthConsumedUnits,
          energyReleasedUnits: evaluated.energyReleasedUnits,
          bandwidthReleasedUnits: evaluated.bandwidthReleasedUnits,
          reportedFeeSun: evaluated.reportedFeeSun,
          directFeeSponsorTrxDebitVerified: false,
        })],
      )
      await client.query('COMMIT')
      return {
        success: true, settled: true, duplicate: false, status: 'settled',
        mandateReference: reservation.mandate_reference,
        energyConsumedUnits: evaluated.energyConsumedUnits,
        bandwidthConsumedUnits: evaluated.bandwidthConsumedUnits,
        energyReleasedUnits: evaluated.energyReleasedUnits,
        bandwidthReleasedUnits: evaluated.bandwidthReleasedUnits,
        directFeeSponsorTrxDebitVerified: false,
      }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      console.error('Sponsor resource budget settlement failed:', error?.code || 'unknown')
      return { success: false, reason: 'database-unavailable' }
    } finally {
      client.release()
    }
  } catch (error) {
    console.error('Sponsor resource budget settlement initialization failed:', error?.code || 'unknown')
    return { success: false, reason: 'database-unavailable' }
  }
}

/** Read-only, bounded operator view of resource-unit reservation and settlement states. */
export async function listSponsorResourceBudgetReservations({ network = null, limit = 50 } = {}) {
  if (network !== null && !['nile','shasta'].includes(network)) {
    return { success: false, reason: 'invalid-network', reservations: [] }
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return { success: false, reason: 'invalid-limit', reservations: [] }
  }
  const db = getPool()
  if (!db) return { success: false, reason: 'database-not-configured', reservations: [] }
  try {
    await initializeDatabase()
    const result = await db.query(
      `SELECT r.idempotency_key, r.mandate_reference, r.network, r.transaction_hash,
              r.fee_sponsor_address, r.asset_principal_address,
              r.energy_reserved_units::text AS energy_reserved_units,
              r.bandwidth_reserved_units::text AS bandwidth_reserved_units,
              r.energy_consumed_units::text AS energy_consumed_units,
              r.bandwidth_consumed_units::text AS bandwidth_consumed_units,
              r.status, r.settlement_reason, r.settlement_block_number,
              r.expires_at, r.settled_at, r.created_at, r.updated_at,
              b.energy_budget_units::text AS energy_budget_units,
              b.bandwidth_budget_units::text AS bandwidth_budget_units,
              b.energy_reserved_units::text AS budget_energy_reserved_units,
              b.bandwidth_reserved_units::text AS budget_bandwidth_reserved_units,
              b.energy_spent_units::text AS budget_energy_spent_units,
              b.bandwidth_spent_units::text AS budget_bandwidth_spent_units,
              b.status AS budget_status
         FROM ${schema}.sponsor_resource_reservations r
         JOIN ${schema}.sponsor_resource_budgets b ON b.mandate_reference=r.mandate_reference
        WHERE ($1::text IS NULL OR r.network=$1)
        ORDER BY r.updated_at DESC, r.id DESC LIMIT $2`,
      [network, limit],
    )
    return {
      success: true,
      reservations: result.rows.map((row) => ({
        idempotencyKey: row.idempotency_key,
        mandateReference: row.mandate_reference,
        network: row.network,
        transactionHash: row.transaction_hash?.trim() || null,
        feeSponsorAddress: row.fee_sponsor_address,
        assetPrincipalAddress: row.asset_principal_address,
        energyReservedUnits: row.energy_reserved_units,
        bandwidthReservedUnits: row.bandwidth_reserved_units,
        energyConsumedUnits: row.energy_consumed_units,
        bandwidthConsumedUnits: row.bandwidth_consumed_units,
        status: row.status,
        settlementReason: row.settlement_reason,
        settlementBlockNumber: row.settlement_block_number === null ? null : Number(row.settlement_block_number),
        expiresAt: row.expires_at,
        settledAt: row.settled_at,
        budget: {
          status: row.budget_status,
          energyBudgetUnits: row.energy_budget_units,
          bandwidthBudgetUnits: row.bandwidth_budget_units,
          energyReservedUnits: row.budget_energy_reserved_units,
          bandwidthReservedUnits: row.budget_bandwidth_reserved_units,
          energySpentUnits: row.budget_energy_spent_units,
          bandwidthSpentUnits: row.budget_bandwidth_spent_units,
        },
      })),
    }
  } catch (error) {
    console.error('Sponsor resource reservations read failed:', error?.code || 'unknown')
    return { success: false, reason: 'database-unavailable', reservations: [] }
  }
}

/** Fetch the persisted resource reservation for an exact idempotent transfer. */
export async function getSponsorResourceBudgetReservation(idempotencyKey) {
  if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{24,160}$/.test(idempotencyKey)) {
    return { success: false, reason: 'invalid-idempotency-key' }
  }
  const db = getPool()
  if (!db) return { success: false, reason: 'database-not-configured' }
  try {
    await initializeDatabase()
    const result = await db.query(
      `SELECT r.idempotency_key, r.mandate_reference, r.network, r.transaction_hash,
              r.fee_sponsor_address, r.asset_principal_address,
              r.energy_reserved_units::text AS energy_reserved_units,
              r.bandwidth_reserved_units::text AS bandwidth_reserved_units,
              r.capacity_snapshot, r.status, r.expires_at,
              b.status AS budget_status
         FROM ${schema}.sponsor_resource_reservations r
         JOIN ${schema}.sponsor_resource_budgets b ON b.mandate_reference=r.mandate_reference
        WHERE r.idempotency_key=$1`,
      [idempotencyKey],
    )
    if (!result.rows.length) return { success: false, reason: 'resource-reservation-not-found' }
    const row = result.rows[0]
    return {
      success: true,
      reservation: {
        idempotencyKey: row.idempotency_key,
        mandateReference: row.mandate_reference,
        network: row.network,
        transactionHash: row.transaction_hash?.trim() || null,
        feeSponsorAddress: row.fee_sponsor_address,
        assetPrincipalAddress: row.asset_principal_address,
        energyReservedUnits: row.energy_reserved_units,
        bandwidthReservedUnits: row.bandwidth_reserved_units,
        capacitySnapshot: row.capacity_snapshot,
        status: row.status,
        expiresAt: row.expires_at,
        budgetStatus: row.budget_status,
      },
    }
  } catch (error) {
    console.error('Sponsor resource reservation lookup failed:', error?.code || 'unknown')
    return { success: false, reason: 'database-unavailable' }
  }
}

/** Pause a resource mandate without releasing in-flight reservations. */
export async function pauseSponsorResourceBudget({ mandateReference, reason } = {}) {
  if (typeof mandateReference !== 'string' || !/^[A-Za-z0-9._:-]{8,160}$/.test(mandateReference)
    || !['operator-request','funding-mismatch','provider-incident','emergency-stop'].includes(reason)) {
    return { success: false, reason: 'invalid-pause-request' }
  }
  const db = getPool()
  if (!db) return { success: false, reason: 'database-not-configured' }
  try {
    await initializeDatabase()
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const result = await client.query(
        `UPDATE ${schema}.sponsor_resource_budgets
            SET status='paused', pause_reason=$2, updated_at=now()
          WHERE mandate_reference=$1
          RETURNING mandate_reference, status`,
        [mandateReference, reason],
      )
      if (!result.rowCount) {
        await client.query('ROLLBACK')
        return { success: false, reason: 'resource-budget-not-found' }
      }
      await client.query(
        `INSERT INTO ${schema}.audit_events (event_type, entity_type, entity_reference, details)
         VALUES ('sponsor-resource-budget-paused','sponsor-resource-budget',$1,$2::jsonb)`,
        [mandateReference, JSON.stringify({ reason, status: 'paused' })],
      )
      await client.query('COMMIT')
      return { success: true, status: 'paused', mandateReference }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      return { success: false, reason: 'database-unavailable' }
    } finally {
      client.release()
    }
  } catch (error) {
    return { success: false, reason: 'database-unavailable' }
  }
}
