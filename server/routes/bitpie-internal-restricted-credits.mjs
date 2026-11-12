import { createHash, randomUUID } from 'node:crypto'
import { Router } from 'express'
import pg from 'pg'
import {
  getWalletAuthSession,
  normalizeDatabaseConnectionString,
  databaseSslConfig,
} from '../database.mjs'
import { isValidTronAddress } from '../tron-address.mjs'

const { Pool } = pg
const SCHEMA = 'trc20_token_clone'
const MAX_AMOUNT_SUN = 10n ** 24n
let pool

function clean(value, max = 256) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function digest(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex')
}

function noStore(res) {
  res.setHeader('Cache-Control', 'no-store, private')
  res.setHeader('Pragma', 'no-cache')
  res.setHeader('Vary', 'Authorization, Origin')
}

export function parseInternalCreditAmountSun(value) {
  const raw = typeof value === 'string' || typeof value === 'number' ? String(value) : ''
  if (!/^[1-9][0-9]{0,23}$/.test(raw)) throw new Error('invalid-amount-sun')
  const amount = BigInt(raw)
  if (amount > MAX_AMOUNT_SUN) throw new Error('amount-sun-exceeds-platform-limit')
  return amount.toString()
}

function getPool(env) {
  if (pool) return pool
  if (!clean(env.DATABASE_URL, 4096)) return null
  const connectionString = normalizeDatabaseConnectionString(env.DATABASE_URL)
  pool = new Pool({
    connectionString,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    max: 3,
    ssl: databaseSslConfig(connectionString, env),
  })
  pool.on('error', (error) => console.error('Bitpie internal credit ledger database error:', error?.code || 'unknown'))
  return pool
}

async function ensureSchema(db) {
  await db.query('CREATE SCHEMA IF NOT EXISTS ' + SCHEMA)
  await db.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.bitpie_internal_restricted_credits (
      id UUID PRIMARY KEY,
      idempotency_key UUID NOT NULL UNIQUE,
      wallet_provider TEXT NOT NULL CHECK (wallet_provider = 'bitpie'),
      beneficiary_address TEXT NOT NULL,
      asset TEXT NOT NULL CHECK (asset = 'TRX'),
      amount_sun NUMERIC(78,0) NOT NULL CHECK (amount_sun > 0),
      credit_type TEXT NOT NULL CHECK (credit_type = 'display_only_non_asset'),
      status TEXT NOT NULL CHECK (status = 'restricted_internal_only'),
      reason TEXT NOT NULL,
      created_by_owner_address TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)
  await db.query('CREATE INDEX IF NOT EXISTS bitpie_internal_restricted_credits_beneficiary_idx ON ' +
    SCHEMA + '.bitpie_internal_restricted_credits (beneficiary_address, created_at DESC)')
  await db.query(`
    CREATE OR REPLACE FUNCTION ${SCHEMA}.reject_bitpie_internal_credit_mutation()
    RETURNS trigger LANGUAGE plpgsql
    AS 'BEGIN
      RAISE EXCEPTION ''Bitpie internal credit entries are append-only'';
      RETURN NULL;
    END;'
  `)
  try {
    await db.query('CREATE TRIGGER bitpie_internal_restricted_credits_immutable BEFORE UPDATE OR DELETE ON ' +
      SCHEMA + '.bitpie_internal_restricted_credits FOR EACH ROW EXECUTE FUNCTION ' +
      SCHEMA + '.reject_bitpie_internal_credit_mutation()')
  } catch (error) {
    // Concurrent first requests can race on trigger creation; ignore only the duplicate-trigger SQLSTATE.
    if (error?.code !== '42710') throw error
  }
}

async function authorizeOwner(req, env, getSession, now, isValidAddress) {
  const address = clean(env.TREASURY_OWNER_ADDRESS || env.OWNER_WALLET_ADDRESS, 64)
  if (!address || !isValidAddress(address)) return { ok: false, status: 503, error: 'treasury-owner-not-configured' }
  const origin = clean(req.headers?.origin, 512)
  try {
    const parsed = new URL(origin)
    if (parsed.protocol !== 'https:' || parsed.origin !== origin) {
      return { ok: false, status: 401, error: 'owner-session-required' }
    }
  } catch {
    return { ok: false, status: 401, error: 'owner-session-required' }
  }
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(clean(req.headers?.authorization, 4096))
  if (!match) return { ok: false, status: 401, error: 'owner-session-required' }
  let lookup
  try {
    lookup = await getSession({ tokenHash: digest(match[1]), origin, nowMs: now() })
  } catch {
    lookup = null
  }
  if (lookup?.success !== true) return { ok: false, status: 503, error: 'owner-session-storage-unavailable' }
  const session = lookup.session
  if (!session || session.network !== 'mainnet' || session.origin !== origin) {
    return { ok: false, status: 401, error: 'owner-session-invalid-or-expired' }
  }
  if (session.address !== address) return { ok: false, status: 403, error: 'owner-wallet-not-authorized' }
  return { ok: true, address, origin }
}

function formatSun(value) {
  const sun = BigInt(String(value))
  const whole = sun / 1_000_000n
  const fraction = (sun % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
  return whole.toString() + (fraction ? '.' + fraction : '')
}

function publicEntry(row) {
  return {
    id: row.id,
    walletProvider: 'bitpie',
    beneficiaryAddress: row.beneficiary_address,
    asset: 'TRX',
    amountSun: String(row.amount_sun),
    amountTrx: formatSun(row.amount_sun),
    creditType: 'display_only_non_asset',
    status: 'restricted_internal_only',
    reason: row.reason,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    spendableOnBitpie: false,
    blockchainAsset: false,
    withdrawalEnabled: false,
  }
}

/**
 * Owner-only internal bookkeeping ledger. This never calls Bitpie, never
 * changes a Bitpie wallet, never creates TRX, and never enables withdrawals.
 * The displayed amount is an internal non-asset record only.
 */
export function createBitpieInternalRestrictedCreditsRouter({
  env = process.env,
  getSession = getWalletAuthSession,
  getDatabase = () => getPool(env),
  isValidAddress = isValidTronAddress,
  now = () => Date.now(),
} = {}) {
  const router = Router()

  async function ownerContext(req, res) {
    noStore(res)
    const auth = await authorizeOwner(req, env, getSession, now, isValidAddress)
    if (!auth.ok) {
      res.status(auth.status).json({ success: false, error: auth.error })
      return null
    }
    return auth
  }

  router.get('/', async (req, res) => {
    const auth = await ownerContext(req, res)
    if (!auth) return
    const address = clean(req.query?.address, 64)
    if (!isValidAddress(address)) return res.status(400).json({ success: false, error: 'invalid-beneficiary-address' })
    const db = getDatabase()
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured', credits: [] })
    try {
      await ensureSchema(db)
      const result = await db.query(
        'SELECT id, beneficiary_address, amount_sun::text AS amount_sun, reason, created_at ' +
        'FROM ' + SCHEMA + '.bitpie_internal_restricted_credits WHERE beneficiary_address=$1 ' +
        'ORDER BY created_at DESC LIMIT 100',
        [address],
      )
      const total = await db.query(
        'SELECT COALESCE(SUM(amount_sun),0)::text AS total FROM ' +
        SCHEMA + '.bitpie_internal_restricted_credits WHERE beneficiary_address=$1',
        [address],
      )
      return res.json({
        success: true,
        ledgerType: 'tron-transfer-internal-restricted-credit',
        walletProvider: 'bitpie',
        beneficiaryAddress: address,
        asset: 'TRX',
        totalAmountSun: String(total.rows?.[0]?.total || '0'),
        credits: (result.rows || []).map(publicEntry),
        bitpieApiConnected: false,
        bitpieWalletBalanceChanged: false,
        blockchainBalanceChanged: false,
        withdrawalEnabled: false,
        note: 'These are Tron Transfer internal bookkeeping credits only. They are not TRX, not a Bitpie wallet balance or deposit, cannot be spent or withdrawn, and are not reported to Bitpie.',
      })
    } catch {
      return res.status(503).json({ success: false, error: 'internal-credit-ledger-unavailable', credits: [] })
    }
  })

  router.post('/', async (req, res) => {
    const auth = await ownerContext(req, res)
    if (!auth) return
    const address = clean(req.body?.beneficiaryAddress, 64)
    const reason = clean(req.body?.reason, 240)
    const idempotencyKey = clean(req.body?.idempotencyKey, 36).toLowerCase()
    let amountSun
    try {
      if (!isValidAddress(address)) throw new Error('invalid-beneficiary-address')
      amountSun = parseInternalCreditAmountSun(req.body?.amountSun)
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(idempotencyKey)) {
        throw new Error('valid-idempotency-key-required')
      }
      if (!reason || reason.length < 3) throw new Error('credit-reason-required')
      if (req.body?.creditType !== undefined && req.body.creditType !== 'display_only_non_asset') {
        throw new Error('unsupported-credit-type')
      }
    } catch (error) {
      return res.status(400).json({ success: false, error: error instanceof Error ? error.message : 'invalid-credit-entry', created: false })
    }
    const db = getDatabase()
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured', created: false })
    try {
      await ensureSchema(db)
      const inserted = await db.query(
        'INSERT INTO ' + SCHEMA + '.bitpie_internal_restricted_credits ' +
        '(id, idempotency_key, wallet_provider, beneficiary_address, asset, amount_sun, credit_type, status, reason, created_by_owner_address) ' +
        'VALUES ($1,$2,\'bitpie\',$3,\'TRX\',$4,\'display_only_non_asset\',\'restricted_internal_only\',$5,$6) ' +
        'ON CONFLICT (idempotency_key) DO NOTHING RETURNING id, beneficiary_address, amount_sun::text AS amount_sun, reason, created_at',
        [randomUUID(), idempotencyKey, address, amountSun, reason, auth.address],
      )
      if (inserted.rowCount) {
        return res.status(201).json({
          success: true,
          created: true,
          duplicate: false,
          credit: publicEntry(inserted.rows[0]),
          bitpieWalletBalanceChanged: false,
          blockchainBalanceChanged: false,
          withdrawalEnabled: false,
        })
      }
      const existing = await db.query(
        'SELECT id, beneficiary_address, amount_sun::text AS amount_sun, reason, created_at, ' +
        'wallet_provider, asset, credit_type, status FROM ' +
        SCHEMA + '.bitpie_internal_restricted_credits WHERE idempotency_key=$1',
        [idempotencyKey],
      )
      const row = existing.rows?.[0]
      const same = row && row.wallet_provider === 'bitpie' && row.asset === 'TRX'
        && row.beneficiary_address === address && String(row.amount_sun) === amountSun
        && row.credit_type === 'display_only_non_asset' && row.status === 'restricted_internal_only'
        && row.reason === reason
      if (!same) return res.status(409).json({ success: false, error: 'idempotency-key-conflict', created: false })
      return res.status(200).json({
        success: true,
        created: true,
        duplicate: true,
        credit: publicEntry(row),
        bitpieWalletBalanceChanged: false,
        blockchainBalanceChanged: false,
        withdrawalEnabled: false,
      })
    } catch {
      return res.status(503).json({ success: false, error: 'internal-credit-ledger-write-failed', created: false })
    }
  })

  return router
}

export default createBitpieInternalRestrictedCreditsRouter()
