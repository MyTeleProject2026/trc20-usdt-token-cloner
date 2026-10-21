import pg from 'pg'

const { Pool } = pg
const schema = 'trc20_token_clone'
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
      // One sponsor may have independent budgets for each network/asset/contract.
      // Migrate the earlier one-budget-per-sponsor constraint without exposing secrets.
      await db.query(`ALTER TABLE ${schema}.sponsor_budgets DROP CONSTRAINT IF EXISTS sponsor_budgets_sponsor_reference_key`)
      await db.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_ttc_sponsor_budget_identity
          ON ${schema}.sponsor_budgets (sponsor_reference, network, asset, COALESCE(token_contract, ''))
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
      await db.query(`ALTER TABLE ${schema}.sponsor_transfers ADD COLUMN IF NOT EXISTS sponsor_address TEXT`)
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
      await db.query(`CREATE INDEX IF NOT EXISTS idx_ttc_verifications_created_at ON ${schema}.transfer_verifications (created_at DESC)`)
      await db.query(`CREATE INDEX IF NOT EXISTS idx_ttc_deployments_created_at ON ${schema}.token_deployments (created_at DESC)`)
      const comments = [
        ["token_deployments", "TRC20 Token Clone project only: independent token deployment metadata; never official Tether USDT."],
        ["transfer_verifications", "TRC20 Token Clone project only: on-chain verification outcomes; not a balance ledger and not proof unless status is verified-on-chain."],
        ["tracked_wallets", "TRC20 Token Clone project only: optional public TRON wallet watchlist. Do not store private keys or seed phrases."],
        ["audit_events", "TRC20 Token Clone project only: non-secret application audit metadata. Never store credentials, private keys, or seed phrases."],
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

function validSponsorTransitionStatus(status) {
  return ['authorized', 'submitted', 'confirmed', 'failed', 'cancelled'].includes(status)
}

/**
 * Atomically creates an idempotent sponsor transfer intent and reserves its
 * budget. This is accounting only: it never signs or broadcasts transactions.
 */
export async function reserveSponsorTransfer(input) {
  const network = normalizeVerificationNetwork(input?.network)
  const { idempotencyKey, sponsorReference, purpose, asset, tokenContract = null, receiverAddress, amountBaseUnits } = input || {}
  if (!network || typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{8,160}$/.test(idempotencyKey)
    || typeof sponsorReference !== 'string' || !sponsorReference.trim() || sponsorReference.length > 128
    || !['network-fee', 'asset-grant'].includes(purpose)
    || !['TRX', 'USDT'].includes(asset)
    || (purpose === 'network-fee' && asset !== 'TRX')
    || (asset === 'TRX' && tokenContract)
    || (asset === 'USDT' && (typeof tokenContract !== 'string' || !tokenContract.trim()))
    || typeof receiverAddress !== 'string' || !receiverAddress.trim() || receiverAddress.length > 128
    || typeof amountBaseUnits !== 'string' || !/^[1-9][0-9]*$/.test(amountBaseUnits) || amountBaseUnits.length > 78) {
    return { reserved: false, reason: 'invalid-transfer-intent' }
  }

  const { TronWeb } = await import('tronweb')
  const tronWeb = new TronWeb({ fullHost: network === 'mainnet'
    ? 'https://api.trongrid.io'
    : network === 'shasta' ? 'https://api.shasta.trongrid.io' : 'https://nile.trongrid.io' })
  if (!tronWeb.isAddress(receiverAddress.trim())
    || (asset === 'USDT' && !tronWeb.isAddress(tokenContract.trim()))) {
    return { reserved: false, reason: 'invalid-tron-address' }
  }

  const db = getPool()
  if (!db) return { reserved: false, reason: 'database-not-configured' }
  await initializeDatabase()
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const existing = await client.query(
      `SELECT idempotency_key, sponsor_reference, network, purpose, asset, token_contract,
              receiver_address, amount_base_units::text AS amount_base_units, status
         FROM ${schema}.sponsor_transfers WHERE idempotency_key = $1 FOR UPDATE`,
      [idempotencyKey],
    )
    if (existing.rows.length) {
      const row = existing.rows[0]
      const same = row.sponsor_reference === sponsorReference.trim()
        && row.network === network && row.purpose === purpose && row.asset === asset
        && (row.token_contract || null) === (asset === 'USDT' ? tokenContract.trim() : null)
        && row.receiver_address === receiverAddress.trim() && row.amount_base_units === amountBaseUnits
      await client.query('COMMIT')
      return same
        ? { reserved: true, duplicate: true, status: row.status, idempotencyKey }
        : { reserved: false, reason: 'idempotency-key-conflict' }
    }

    const budgetResult = await client.query(
      `SELECT id, sponsor_address, budget_base_units::text AS budget_base_units,
              reserved_base_units::text AS reserved_base_units,
              spent_base_units::text AS spent_base_units, status
         FROM ${schema}.sponsor_budgets
        WHERE sponsor_reference = $1 AND network = $2 AND asset = $3
          AND token_contract IS NOT DISTINCT FROM $4
        FOR UPDATE`,
      [sponsorReference.trim(), network, asset, asset === 'USDT' ? tokenContract.trim() : null],
    )
    if (!budgetResult.rows.length) {
      await client.query('ROLLBACK')
      return { reserved: false, reason: 'sponsor-budget-not-found' }
    }
    const budget = budgetResult.rows[0]
    if (budget.status !== 'active') {
      await client.query('ROLLBACK')
      return { reserved: false, reason: 'sponsor-budget-not-active' }
    }
    if (typeof budget.sponsor_address !== 'string' || !budget.sponsor_address.trim()) {
      await client.query('ROLLBACK')
      return { reserved: false, reason: 'sponsor-address-not-configured' }
    }
    if (!tronWeb.isAddress(budget.sponsor_address.trim())) {
      await client.query('ROLLBACK')
      return { reserved: false, reason: 'invalid-sponsor-address' }
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
        WHERE id = $2`,
      [amountBaseUnits, budget.id],
    )
    await client.query(
      `INSERT INTO ${schema}.sponsor_transfers
        (idempotency_key, sponsor_reference, sponsor_address, network, purpose, asset, token_contract,
         receiver_address, amount_base_units, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending-review')`,
      [idempotencyKey, sponsorReference.trim(), budget.sponsor_address, network, purpose, asset,
       asset === 'USDT' ? tokenContract.trim() : null, receiverAddress.trim(), amountBaseUnits],
    )
    await client.query(
      `INSERT INTO ${schema}.audit_events (event_type, entity_type, entity_reference, details)
       VALUES ('sponsor-transfer-reserved', 'sponsor-transfer', $1, $2::jsonb)`,
      [idempotencyKey, JSON.stringify({ sponsorReference: sponsorReference.trim(), network, purpose, asset, amountBaseUnits })],
    )
    await client.query('COMMIT')
    return { reserved: true, duplicate: false, status: 'pending-review', idempotencyKey }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    if (error?.code === '23505') return { reserved: false, reason: 'idempotency-key-conflict' }
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
export async function transitionSponsorTransfer(input) {
  const { idempotencyKey, nextStatus, authorizationReference = null, transactionHash = null } = input || {}
  if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{8,160}$/.test(idempotencyKey)
    || !validSponsorTransitionStatus(nextStatus)) {
    return { updated: false, reason: 'invalid-transition' }
  }
  if (nextStatus === 'authorized' && (typeof authorizationReference !== 'string' || !authorizationReference.trim())) {
    return { updated: false, reason: 'authorization-reference-required' }
  }
  if (nextStatus === 'submitted' && (typeof transactionHash !== 'string' || !/^[0-9a-f]{64}$/i.test(transactionHash))) {
    return { updated: false, reason: 'submitted-transaction-hash-required' }
  }
  if (nextStatus === 'confirmed' && (typeof transactionHash !== 'string' || !/^[0-9a-f]{64}$/i.test(transactionHash))) {
    return { updated: false, reason: 'finalized-transaction-hash-required' }
  }

  const db = getPool()
  if (!db) return { updated: false, reason: 'database-not-configured' }
  await initializeDatabase()
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const result = await client.query(
      `SELECT idempotency_key, sponsor_reference, sponsor_address, network, asset, token_contract,
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
    const allowed = {
      'pending-review': ['authorized', 'cancelled'],
      authorized: ['submitted', 'cancelled'],
      submitted: ['confirmed', 'failed'],
      confirmed: [],
      failed: [],
      cancelled: [],
    }
    if (!allowed[transfer.status]?.includes(nextStatus)) {
      await client.query('ROLLBACK')
      return { updated: false, reason: 'invalid-state-transition' }
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
      `SELECT id, reserved_base_units::text AS reserved_base_units,
              spent_base_units::text AS spent_base_units, budget_base_units::text AS budget_base_units
         FROM ${schema}.sponsor_budgets
        WHERE sponsor_reference = $1 AND network = $2 AND asset = $3
          AND token_contract IS NOT DISTINCT FROM $4
        FOR UPDATE`,
      [transfer.sponsor_reference, transfer.network, transfer.asset, transfer.token_contract],
    )
    if (!budgetResult.rows.length) {
      await client.query('ROLLBACK')
      return { updated: false, reason: 'sponsor-budget-not-found' }
    }
    const budget = budgetResult.rows[0]
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
      [idempotencyKey, JSON.stringify({ fromStatus: transfer.status, toStatus: nextStatus, network: transfer.network, asset: transfer.asset })],
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
