import pg from 'pg'
import { createSponsorFundingReader } from './sponsor-funding.mjs'
import { reconcileSponsorBudgets } from './sponsor-reconciliation.mjs'

const { Pool } = pg
const schema = 'trc20_token_clone'
const readSponsorFundingStatusForReservation = createSponsorFundingReader()
const SPONSOR_CHAIN_SNAPSHOT_SOURCE = 'Tatum TRON SolidityNode account and constant-contract queries'
const SPONSORED_TOKEN_ASSETS = new Set(['USDT', 'VTRC'])
const OFFICIAL_MAINNET_USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'

export function isSponsorTokenContractAllowed(network, asset, tokenContract, configuredContracts = []) {
  if (!['mainnet', 'shasta', 'nile'].includes(network)
    || !SPONSORED_TOKEN_ASSETS.has(asset)
    || typeof tokenContract !== 'string' || !tokenContract.trim()) return false
  if (asset === 'USDT' && network === 'mainnet') return tokenContract.trim() === OFFICIAL_MAINNET_USDT_CONTRACT
  // Non-mainnet USDT and all VTRC deployments require an explicit operator-configured,
  // network-scoped allowlist. Symbols and plausible addresses do not prove token identity.
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

function getPool() {
  if (pool) return pool
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) return null
  pool = new Pool({
    connectionString,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    max: 5,
    // Render's internal PostgreSQL URL is preferred. If SSL is explicitly
    // required by the provider, use DATABASE_SSL=true rather than weakening it.
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : undefined,
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
      // VTRC is an independent project token. Expand sponsor ledger constraints so
      // it can be budgeted separately from official USDT and native TRX.
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
    || !['TRX', 'USDT', 'VTRC'].includes(asset)
    || (purpose === 'network-fee' && asset !== 'TRX')
    || (asset === 'TRX' && tokenContract)
    || (SPONSORED_TOKEN_ASSETS.has(asset) && !isConfiguredSponsorTokenContractAllowed(network, asset, tokenContract))
    || typeof receiverAddress !== 'string' || !receiverAddress.trim() || receiverAddress.length > 128
    || typeof amountBaseUnits !== 'string' || !/^[1-9][0-9]*$/.test(amountBaseUnits) || amountBaseUnits.length > 78) {
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
 * Applies an explicit, audited lifecycle transition and reconciles budget
 * reservation atomically. Authorization requires a non-empty approval reference.
 * A confirmed transition requires an externally verified finalized transaction hash.
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
    || !['TRX', 'USDT', 'VTRC'].includes(asset)
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
        || !['TRX', 'USDT', 'VTRC'].includes(asset)
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
  const allowedStatuses = new Set(['pending-review', 'authorized', 'submitted', 'confirmed', 'failed', 'cancelled'])
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
  const result = await db.query(
    `SELECT network, wallet_address, transaction_hash, token_contract, from_address, to_address,
            amount_base_units::text AS amount_base_units, token_name, token_symbol, token_decimals,
            block_timestamp, verification_status, verified_on_chain, event_index, first_seen_at, last_seen_at
       FROM ${schema}.receiver_history_events
      WHERE network = $1 AND lower(wallet_address) = lower($2)
        AND ($3::text IS NULL OR lower(token_contract) = lower($3))
      ORDER BY block_timestamp DESC, id DESC
      LIMIT $4`,
    [network, address, contract, limit],
  )
  return {
    success: true,
    records: result.rows.map((row) => ({
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
    })),
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
