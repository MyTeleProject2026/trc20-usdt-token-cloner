import { createHash } from 'node:crypto'
import { Router } from 'express'
import pg from 'pg'
import { TronWeb } from 'tronweb'
import { getWalletAuthSession, normalizeDatabaseConnectionString, databaseSslConfig } from '../database.mjs'

const { Pool } = pg
const MAINNET_RPC = 'https://api.trongrid.io'
const USDT_MAINNET = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const ADDRESS_PATTERN = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const TXID_PATTERN = /^[0-9a-f]{64}$/i
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9._:-]{24,128}$/
const SESSION_PATTERN = /^[A-Za-z0-9_-]{43}$/
const ABI = [
  { constant: true, inputs: [{ name: 'owner', type: 'address' }], name: 'balanceOf', outputs: [{ name: 'balance', type: 'uint256' }], stateMutability: 'view', type: 'function' },
  { constant: true, inputs: [], name: 'decimals', outputs: [{ name: '', type: 'uint8' }], stateMutability: 'view', type: 'function' },
  { constant: true, inputs: [], name: 'symbol', outputs: [{ name: '', type: 'string' }], stateMutability: 'view', type: 'function' },
  { constant: false, inputs: [{ name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }], name: 'transfer', outputs: [{ name: '', type: 'bool' }], stateMutability: 'nonpayable', type: 'function' },
]

let pool
let schemaPromise
function getPool(env) {
  if (pool) return pool
  if (!env.DATABASE_URL) return null
  const connectionString = normalizeDatabaseConnectionString(env.DATABASE_URL)
  pool = new Pool({
    connectionString,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    max: 3,
    ssl: databaseSslConfig(connectionString, env),
  })
  pool.on('error', (error) => console.error('Treasury withdrawal database error:', error?.code || 'unknown'))
  return pool
}

async function ensureSchema(db) {
  if (!schemaPromise) {
    schemaPromise = db.query(`
      CREATE TABLE IF NOT EXISTS trc20_token_clone.treasury_withdrawal_requests (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        owner_address TEXT NOT NULL,
        treasury_address TEXT NOT NULL,
        recipient_address TEXT NOT NULL,
        token_contract TEXT NOT NULL,
        amount_base_units NUMERIC(78,0) NOT NULL CHECK (amount_base_units > 0),
        status TEXT NOT NULL CHECK (status IN ('broadcasting','broadcast-accepted','broadcast-unknown','rejected')),
        transaction_hash CHAR(64),
        failure_code TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `).catch((error) => { schemaPromise = null; throw error })
  }
  await schemaPromise
}

function parsePositiveDecimal(value, decimals = 6) {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)) return null
  const [whole, fraction = ''] = value.split('.')
  if (fraction.length > decimals) return null
  const units = BigInt(whole) * (10n ** BigInt(decimals)) + BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals) || '0')
  return units > 0n ? units : null
}

function readLimit(value) {
  return typeof value === 'string' ? parsePositiveDecimal(value, 6) : null
}

function bearerToken(req) {
  const value = req.get('authorization') || ''
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(value)
  return match ? match[1] : ''
}

function safeStatus(row) {
  return {
    idempotencyKey: row.idempotency_key,
    network: 'mainnet',
    asset: 'USDT',
    tokenContract: USDT_MAINNET,
    treasuryAddress: row.treasury_address,
    recipientAddress: row.recipient_address,
    amountBaseUnits: String(row.amount_base_units),
    status: row.status,
    ...(row.transaction_hash ? { transactionHash: String(row.transaction_hash).trim() } : {}),
    ...(row.failure_code ? { failureCode: row.failure_code } : {}),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  }
}

/**
 * Owner-only treasury-backed withdrawals. The owner signs in with the existing
 * wallet-auth challenge; the server signs transfers from a separate treasury
 * key. The signer is disabled unless explicitly opted in. This route never
 * mints tokens and only transfers USDT already held by the configured treasury.
 */
export function createTreasuryWithdrawalsRouter({
  env = process.env,
  sessionLookup = getWalletAuthSession,
  tronWebFactory = (privateKey) => new TronWeb({ fullHost: MAINNET_RPC, privateKey }),
  now = () => new Date(),
} = {}) {
  const router = Router()

  async function authenticateOwner(req) {
    const origin = req.get('origin')
    const token = bearerToken(req)
    const expectedOwner = typeof env.TREASURY_OWNER_ADDRESS === 'string' ? env.TREASURY_OWNER_ADDRESS.trim() : ''
    if (!token || !origin || !ADDRESS_PATTERN.test(expectedOwner)) return { ok: false, status: 401, error: 'owner-auth-required' }
    const result = await sessionLookup({
      tokenHash: createHash('sha256').update(token, 'utf8').digest('hex'),
      origin,
    })
    if (!result?.success || !result.session) return { ok: false, status: 401, error: 'invalid-or-expired-session' }
    if (result.session.network !== 'mainnet' || result.session.address !== expectedOwner || result.session.origin !== origin) {
      return { ok: false, status: 403, error: 'treasury-owner-only' }
    }
    return { ok: true, ownerAddress: expectedOwner }
  }

  function configuration() {
    const required = ['DATABASE_URL', 'TREASURY_OWNER_ADDRESS', 'TREASURY_PRIVATE_KEY', 'TREASURY_MAX_PAYOUT_USDT', 'TREASURY_DAILY_LIMIT_USDT', 'TREASURY_FEE_LIMIT_SUN']
    const missing = required.filter((key) => typeof env[key] !== 'string' || !env[key].trim())
    const enabled = env.TREASURY_WITHDRAWALS_ENABLED === 'true'
      && env.TREASURY_SIGNER_MODE === 'env-hot-wallet'
      && missing.length === 0
      && ADDRESS_PATTERN.test(env.TREASURY_OWNER_ADDRESS || '')
      && Boolean(readLimit(env.TREASURY_MAX_PAYOUT_USDT))
      && Boolean(readLimit(env.TREASURY_DAILY_LIMIT_USDT))
      && /^\d+$/.test(env.TREASURY_FEE_LIMIT_SUN || '')
      && Number(env.TREASURY_FEE_LIMIT_SUN) >= 1
      && Number(env.TREASURY_FEE_LIMIT_SUN) <= 1_000_000_000
    return { enabled, missing, signerMode: env.TREASURY_SIGNER_MODE === 'env-hot-wallet' ? 'env-hot-wallet' : 'not-configured' }
  }

  router.get('/withdrawals/readiness', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    const auth = await authenticateOwner(req)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const config = configuration()
    const db = getPool(env)
    let databaseReady = false
    if (db) {
      try { await ensureSchema(db); await db.query('SELECT 1'); databaseReady = true } catch {}
    }
    let treasuryAddressMatches = false
    if (config.enabled) {
      try {
        const tronWeb = tronWebFactory(env.TREASURY_PRIVATE_KEY.trim())
        treasuryAddressMatches = tronWeb.address.fromPrivateKey(env.TREASURY_PRIVATE_KEY.trim()) === auth.ownerAddress
      } catch {}
    }
    // Treasury address is separate from the owner identity; do not require the
    // owner wallet to equal the treasury wallet. The configured signer address is
    // returned only as a public address after the private key has been checked.
    let treasuryAddress = null
    let signerMatchesConfiguredAddress = false
    if (config.enabled) {
      try {
        const tronWeb = tronWebFactory(env.TREASURY_PRIVATE_KEY.trim())
        treasuryAddress = tronWeb.address.fromPrivateKey(env.TREASURY_PRIVATE_KEY.trim())
        signerMatchesConfiguredAddress = ADDRESS_PATTERN.test(treasuryAddress)
      } catch {}
    }
    let usdtBalance = null
    if (databaseReady && config.enabled && signerMatchesConfiguredAddress) {
      try {
        const tronWeb = tronWebFactory(env.TREASURY_PRIVATE_KEY.trim())
        const contract = await tronWeb.contract(ABI, USDT_MAINNET).at(USDT_MAINNET)
        const decimals = Number(await contract.decimals().call())
        const symbol = String(await contract.symbol().call())
        if (decimals === 6 && symbol.toUpperCase() === 'USDT') {
          usdtBalance = String(await contract.balanceOf(treasuryAddress).call())
        }
      } catch {}
    }
    return res.json({
      success: true,
      network: 'mainnet',
      asset: 'USDT',
      tokenContract: USDT_MAINNET,
      withdrawalsEnabled: config.enabled && databaseReady && signerMatchesConfiguredAddress && usdtBalance !== null,
      configuration: { enabled: config.enabled, missing: config.missing, signerMode: config.signerMode },
      databaseReady,
      treasuryAddress,
      signerMatchesConfiguredAddress,
      treasuryUsdtBalanceBaseUnits: usdtBalance,
      limitations: [
        'This is a treasury-funded withdrawal service, not a token minting mechanism.',
        'A broadcast-accepted response is not proof of confirmation; verify the transaction receipt on TRON.',
        'An exchange deposit may require additional confirmations and may be subject to the exchange own policies.',
        'An environment hot-wallet signer carries custody risk; use a dedicated low-balance treasury and independent security review.',
      ],
    })
  })

  router.post('/withdrawals', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    const auth = await authenticateOwner(req)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const config = configuration()
    if (!config.enabled) return res.status(503).json({ success: false, error: 'treasury-withdrawals-disabled', missing: config.missing })
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
    if (Object.keys(body).some((key) => !['recipientAddress', 'amountUsdt', 'idempotencyKey'].includes(key))
      || !ADDRESS_PATTERN.test(body.recipientAddress || '')
      || !IDEMPOTENCY_PATTERN.test(body.idempotencyKey || '')
      || typeof body.amountUsdt !== 'string') {
      return res.status(400).json({ success: false, error: 'invalid-withdrawal-request' })
    }
    const amount = parsePositiveDecimal(body.amountUsdt)
    const maxPayout = readLimit(env.TREASURY_MAX_PAYOUT_USDT)
    const dailyLimit = readLimit(env.TREASURY_DAILY_LIMIT_USDT)
    if (!amount || !maxPayout || !dailyLimit || amount > maxPayout || amount > dailyLimit) {
      return res.status(400).json({ success: false, error: 'amount-outside-configured-limits' })
    }
    const db = getPool(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })
    try {
      await ensureSchema(db)
      const tronWeb = tronWebFactory(env.TREASURY_PRIVATE_KEY.trim())
      const treasuryAddress = tronWeb.address.fromPrivateKey(env.TREASURY_PRIVATE_KEY.trim())
      if (!ADDRESS_PATTERN.test(treasuryAddress) || treasuryAddress === body.recipientAddress) {
        return res.status(503).json({ success: false, error: 'invalid-treasury-or-recipient' })
      }
      const configuredFeeLimit = Number(env.TREASURY_FEE_LIMIT_SUN)
      const contract = await tronWeb.contract(ABI, USDT_MAINNET).at(USDT_MAINNET)
      const [decimals, symbol, balanceValue] = await Promise.all([
        contract.decimals().call(), contract.symbol().call(), contract.balanceOf(treasuryAddress).call(),
      ])
      if (Number(decimals) !== 6 || String(symbol).toUpperCase() !== 'USDT') {
        return res.status(503).json({ success: false, error: 'official-token-metadata-check-failed' })
      }
      const balance = BigInt(String(balanceValue))
      if (balance < amount) return res.status(409).json({ success: false, error: 'treasury-usdt-insufficient', treasuryUsdtBalanceBaseUnits: balance.toString() })

      const client = await db.connect()
      let reservation
      try {
        await client.query('BEGIN')
        await client.query("SELECT pg_advisory_xact_lock(hashtext('tron-token-studio-treasury-withdrawals-mainnet'))")
        const existing = await client.query('SELECT * FROM trc20_token_clone.treasury_withdrawal_requests WHERE idempotency_key = $1 FOR UPDATE', [body.idempotencyKey])
        if (existing.rows.length) {
          await client.query('COMMIT')
          return res.status(200).json({ success: true, duplicate: true, withdrawal: safeStatus(existing.rows[0]), note: 'Existing request returned; no second transfer was broadcast.' })
        }
        const spent = await client.query(`
          SELECT COALESCE(SUM(amount_base_units), 0)::text AS amount
            FROM trc20_token_clone.treasury_withdrawal_requests
           WHERE created_at >= date_trunc('day', now())
             AND status <> 'rejected'
        `)
        const alreadyReserved = BigInt(spent.rows[0]?.amount || '0')
        if (alreadyReserved + amount > dailyLimit) {
          await client.query('ROLLBACK')
          return res.status(429).json({ success: false, error: 'treasury-daily-limit-exceeded' })
        }
        const inserted = await client.query(`
          INSERT INTO trc20_token_clone.treasury_withdrawal_requests
            (idempotency_key, owner_address, treasury_address, recipient_address, token_contract, amount_base_units, status)
          VALUES ($1,$2,$3,$4,$5,$6,'broadcasting')
          RETURNING *
        `, [body.idempotencyKey, auth.ownerAddress, treasuryAddress, body.recipientAddress, USDT_MAINNET, amount.toString()])
        reservation = inserted.rows[0]
        await client.query('COMMIT')
      } catch (error) {
        try { await client.query('ROLLBACK') } catch {}
        if (error?.code === '23505') {
          const existing = await db.query('SELECT * FROM trc20_token_clone.treasury_withdrawal_requests WHERE idempotency_key = $1', [body.idempotencyKey])
          if (existing.rows.length) return res.status(200).json({ success: true, duplicate: true, withdrawal: safeStatus(existing.rows[0]), note: 'Existing request returned; no second transfer was broadcast.' })
        }
        throw error
      } finally {
        client.release()
      }

      try {
        const result = await contract.transfer(body.recipientAddress, amount.toString()).send({
          feeLimit: configuredFeeLimit,
          shouldPollResponse: false,
        })
        const txid = typeof result === 'string' ? result : (result?.txid || result?.txID || result?.transaction?.txID)
        if (typeof txid !== 'string' || !TXID_PATTERN.test(txid)) {
          await db.query(`UPDATE trc20_token_clone.treasury_withdrawal_requests
            SET status='broadcast-unknown', failure_code='provider-returned-no-valid-transaction-id', updated_at=now()
            WHERE id=$1`, [reservation.id])
          return res.status(202).json({ success: false, status: 'broadcast-unknown', error: 'transaction-id-unavailable', note: 'Do not submit a new request; reconcile this idempotency key before retrying.' })
        }
        const updated = await db.query(`UPDATE trc20_token_clone.treasury_withdrawal_requests
          SET status='broadcast-accepted', transaction_hash=$2, updated_at=now()
          WHERE id=$1 RETURNING *`, [reservation.id, txid])
        return res.status(202).json({
          success: true,
          status: 'broadcast-accepted',
          withdrawal: safeStatus(updated.rows[0]),
          note: 'The node accepted the broadcast response. This does not mean the transfer is confirmed or credited by an exchange.',
        })
      } catch {
        await db.query(`UPDATE trc20_token_clone.treasury_withdrawal_requests
          SET status='broadcast-unknown', failure_code='broadcast-outcome-unknown', updated_at=now()
          WHERE id=$1`, [reservation.id])
        return res.status(202).json({
          success: false,
          status: 'broadcast-unknown',
          error: 'broadcast-outcome-unknown',
          idempotencyKey: body.idempotencyKey,
          note: 'The network outcome is ambiguous. Do not create a new idempotency key or resubmit; reconcile the stored request and chain before any retry.',
        })
      }
    } catch {
      return res.status(503).json({ success: false, error: 'treasury-withdrawal-unavailable' })
    }
  })

  router.get('/withdrawals/:idempotencyKey', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    const auth = await authenticateOwner(req)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    if (!IDEMPOTENCY_PATTERN.test(req.params.idempotencyKey || '')) return res.status(400).json({ success: false, error: 'invalid-idempotency-key' })
    const db = getPool(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })
    try {
      await ensureSchema(db)
      const result = await db.query('SELECT * FROM trc20_token_clone.treasury_withdrawal_requests WHERE idempotency_key = $1 AND owner_address = $2', [req.params.idempotencyKey, auth.ownerAddress])
      if (!result.rows.length) return res.status(404).json({ success: false, error: 'withdrawal-not-found' })
      return res.json({ success: true, withdrawal: safeStatus(result.rows[0]) })
    } catch {
      return res.status(503).json({ success: false, error: 'treasury-withdrawal-unavailable' })
    }
  })

  return router
}

export { parsePositiveDecimal }
