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
          result JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (network, transaction_hash, token_contract)
        )
      `)
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

export async function recordTransferVerification(input) {
  // Never infer Mainnet from a missing or invalid network; doing so could
  // contaminate network-scoped verification history with mislabelled records.
  const network = ['mainnet', 'shasta', 'nile'].includes(input?.network) ? input.network : null
  if (!network) return { persisted: false, reason: 'invalid-network' }
  const db = getPool()
  if (!db) return { persisted: false, reason: 'database-not-configured' }
  await initializeDatabase()
  const result = input.result && typeof input.result === 'object' ? input.result : {}
  const status = ['verified-on-chain','not-verified','awaiting-solidification','awaiting-solidified-receipt','provider-error'].includes(input.status)
    ? input.status
    : 'not-verified'
  const block = Number.isSafeInteger(Number(result.blockNumber)) && Number(result.blockNumber) >= 0
    ? Number(result.blockNumber)
    : null
  await db.query(
    `INSERT INTO ${schema}.transfer_verifications
      (network, transaction_hash, token_contract, from_address, to_address, amount_base_units, verification_status, block_number, result)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
     ON CONFLICT (network, transaction_hash, token_contract) DO UPDATE SET
       verification_status=EXCLUDED.verification_status,
       from_address=EXCLUDED.from_address,
       to_address=EXCLUDED.to_address,
       amount_base_units=EXCLUDED.amount_base_units,
       block_number=COALESCE(EXCLUDED.block_number, ${schema}.transfer_verifications.block_number),
       result=EXCLUDED.result`,
    [network, input.transactionHash.toLowerCase(), input.tokenContract, input.fromAddress, input.toAddress, input.amountBaseUnits, status, block, JSON.stringify(result)],
  )
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
