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
      await db.query(`DO $ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'transfer_verifications_network_transaction_hash_token_contract_log_index_key'
            AND conrelid = '${schema}.transfer_verifications'::regclass
        ) THEN
          ALTER TABLE ${schema}.transfer_verifications
          ADD CONSTRAINT transfer_verifications_network_transaction_hash_token_contract_log_index_key
          UNIQUE (network, transaction_hash, token_contract, log_index);
        END IF;
      END $`)
      await db.query(`COMMENT ON COLUMN ${schema}.transfer_verifications.log_index IS 'Zero-based index of the exact matching TRC20 Transfer event in the transaction receipt.'`)
      // Older installations may have a legacy DEFAULT 'TRON'. Drop it so
      // any future direct insert must name its network explicitly. Existing
      // legacy rows are intentionally not relabelled: their chain is unknown.
      await db.query(`ALTER TABLE ${schema}.transfer_verifications ALTER COLUMN network DROP DEFAULT`)
      await db.query(`COMMENT ON COLUMN ${schema}.transfer_verifications.network IS 'Explicit chain environment: mainnet, shasta, or nile. Legacy TRON values are unclassified and must not be assumed to mean Mainnet.'`)
      await db.query(`
        CREATE TABLE IF NOT EXISTS ${schema}.tracked_wallets (
          id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          network TEXT NOT NULL DEFAULT 'TRON',
          wallet_address TEXT NOT NULL,
          display_label TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (network, wallet_address)
        )
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
