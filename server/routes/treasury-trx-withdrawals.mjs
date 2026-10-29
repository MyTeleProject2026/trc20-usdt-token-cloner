import { createHash } from 'node:crypto'
import { Router } from 'express'
import pg from 'pg'
import { TronWeb } from 'tronweb'
import { getWalletAuthSession, normalizeDatabaseConnectionString, databaseSslConfig } from '../database.mjs'
import { buildTreasuryTrxWithdrawalAuthorizationMessage, isTreasuryTrxAuthorizationExpiryValid, parsePositiveTrxAmount } from '../../src/treasury-trx-withdrawal-auth.mjs'
import { isUnifiedTreasuryOwnerConfiguration, verifyTreasuryOwnerPayoutSignature } from './treasury-withdrawals.mjs'

const { Pool } = pg
const MAINNET_RPC = 'https://api.trongrid.io'
const ADDRESS_PATTERN = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const TXID_PATTERN = /^[0-9a-f]{64}$/i
const IDEMPOTENCY_PATTERN = /^trx-withdrawal-[A-Za-z0-9._:-]{24,128}$/
const SESSION_PATTERN = /^[A-Za-z0-9_-]{43}$/
const OWNER_PAYOUT_SIGNATURE_PATTERN = /^0x[0-9a-f]{130}$/i
const ACTIVE_STATUSES = ['broadcasting', 'broadcast-accepted', 'broadcast-unknown']

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
  pool.on('error', (error) => console.error('Treasury TRX withdrawal database error:', error?.code || 'unknown'))
  return pool
}

async function ensureSchema(db) {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await db.query('CREATE SCHEMA IF NOT EXISTS trc20_token_clone')
      await db.query(`
        CREATE TABLE IF NOT EXISTS trc20_token_clone.treasury_trx_withdrawal_requests (
          id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          idempotency_key TEXT NOT NULL UNIQUE,
          owner_address TEXT NOT NULL,
          treasury_address TEXT NOT NULL,
          recipient_address TEXT NOT NULL,
          amount_sun NUMERIC(78,0) NOT NULL CHECK (amount_sun > 0),
          status TEXT NOT NULL CHECK (status IN ('broadcasting','broadcast-accepted','broadcast-unknown','rejected','confirmed','failed')),
          transaction_hash CHAR(64),
          failure_code TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `)
      await db.query(`CREATE INDEX IF NOT EXISTS idx_treasury_trx_withdrawals_pending
        ON trc20_token_clone.treasury_trx_withdrawal_requests (treasury_address, status, updated_at)`)
      await db.query(`CREATE INDEX IF NOT EXISTS idx_treasury_trx_withdrawals_daily
        ON trc20_token_clone.treasury_trx_withdrawal_requests (created_at, status)`)
    })().catch((error) => { schemaPromise = null; throw error })
  }
  await schemaPromise
}

function parseLimitTrx(value) {
  return parsePositiveTrxAmount(value)
}

function validSunInteger(value, { allowZero = true } = {}) {
  const text = typeof value === 'string' || typeof value === 'number' ? String(value) : ''
  if (!(allowZero ? /^(0|[1-9][0-9]{0,77})$/ : /^[1-9][0-9]{0,77}$/).test(text)) return null
  try {
    return BigInt(text)
  } catch {
    return null
  }
}

function decimalTrx(sunValue) {
  const value = validSunInteger(sunValue)
  if (value === null) return null
  const whole = value / 1_000_000n
  const fraction = (value % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
  return fraction ? whole.toString() + '.' + fraction : whole.toString()
}

function normalizedHex(value) {
  return typeof value === 'string' ? value.replace(/^0x/i, '').toLowerCase() : ''
}

function sameTrxIntent(row, { ownerAddress, treasuryAddress, recipientAddress, amountSun }) {
  return Boolean(row && typeof row === 'object'
    && row.owner_address === ownerAddress
    && row.treasury_address === treasuryAddress
    && row.recipient_address === recipientAddress
    && validSunInteger(row.amount_sun, { allowZero: false }) === BigInt(amountSun))
}

function safeStatus(row) {
  return {
    idempotencyKey: row.idempotency_key,
    network: 'mainnet',
    asset: 'TRX',
    treasuryAddress: row.treasury_address,
    recipientAddress: row.recipient_address,
    amountSun: String(row.amount_sun),
    amountTRX: decimalTrx(String(row.amount_sun)),
    status: row.status,
    ...(row.transaction_hash ? { transactionHash: String(row.transaction_hash).trim() } : {}),
    ...(row.failure_code ? { failureCode: row.failure_code } : {}),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  }
}

/**
 * Confirms a native TRX transfer by matching the confirmed transaction body
 * and solidified block index. A tx hash or broadcast response alone is not success.
 */
export function verifyTreasuryTrxTransferEvidence(tronWeb, {
  transaction,
  transactionInfo,
  transactionHash,
  treasuryAddress,
  recipientAddress,
  amountSun,
} = {}) {
  const pending = { verified: false, status: 'awaiting-confirmed-transaction', reason: 'confirmed-transaction-or-block-unavailable' }
  if (!tronWeb || !TXID_PATTERN.test(transactionHash || '')
    || !ADDRESS_PATTERN.test(treasuryAddress || '')
    || !ADDRESS_PATTERN.test(recipientAddress || '')
    || typeof amountSun !== 'string' || !/^[1-9][0-9]{0,77}$/.test(amountSun)) {
    return { verified: false, status: 'verification-mismatch', reason: 'invalid-verification-input' }
  }
  const txid = String(transaction?.txID || transaction?.txid || '').toLowerCase()
  const infoId = String(transactionInfo?.id || transactionInfo?.txID || transactionInfo?.txid || '').toLowerCase()
  if (txid !== transactionHash.toLowerCase() || infoId !== transactionHash.toLowerCase()
    || !Array.isArray(transaction?.raw_data?.contract)) return pending
  const operations = transaction.raw_data.contract
  if (operations.length !== 1 || operations[0]?.type !== 'TransferContract') {
    return { verified: false, status: 'verification-mismatch', reason: 'unexpected-transaction-operation' }
  }
  const value = operations[0]?.parameter?.value
  let expectedFrom
  let expectedTo
  try {
    expectedFrom = normalizedHex(tronWeb.address.toHex(treasuryAddress))
    expectedTo = normalizedHex(tronWeb.address.toHex(recipientAddress))
  } catch {
    return { verified: false, status: 'verification-mismatch', reason: 'address-encoding-failed' }
  }
  if (!expectedFrom || !expectedTo
    || normalizedHex(value?.owner_address) !== expectedFrom
    || normalizedHex(value?.to_address) !== expectedTo
    || validSunInteger(value?.amount, { allowZero: false }) !== BigInt(amountSun)) {
    return { verified: false, status: 'verification-mismatch', reason: 'sender-recipient-or-amount-mismatch' }
  }
  if (!Number.isSafeInteger(transactionInfo?.blockNumber) || transactionInfo.blockNumber < 1) return pending
  const result = Array.isArray(transaction?.ret) ? transaction.ret[0]?.contractRet : undefined
  if (result === 'SUCCESS') {
    return { verified: true, status: 'confirmed', reason: 'confirmed-solidified-native-transfer-success', blockNumber: transactionInfo.blockNumber }
  }
  if (typeof result === 'string' && result.length > 0) {
    return { verified: true, status: 'failed', reason: 'confirmed-solidified-native-transfer-failed', blockNumber: transactionInfo.blockNumber }
  }
  return pending
}

function validOrigin(req) {
  const origin = typeof req.get === 'function' ? req.get('origin') : req.headers?.origin
  if (typeof origin !== 'string' || !origin.trim() || origin.length > 512) return ''
  try {
    const parsed = new URL(origin)
    return parsed.origin === origin ? origin : ''
  } catch {
    return ''
  }
}

function bearerToken(req) {
  const value = typeof req.get === 'function' ? req.get('authorization') || '' : req.headers?.authorization || ''
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(value)
  return match ? match[1] : ''
}

function configFor(env) {
  const required = [
    'DATABASE_URL', 'OWNER_WALLET_ADDRESS', 'TREASURY_OWNER_ADDRESS',
    'TREASURY_ADDRESS', 'TREASURY_PRIVATE_KEY', 'TREASURY_TRX_MAX_PAYOUT',
    'TREASURY_TRX_DAILY_LIMIT', 'TREASURY_TRX_FEE_RESERVE_SUN',
  ]
  const missing = required.filter((key) => typeof env[key] !== 'string' || !env[key].trim())
  const ownerAddressesMatch = isUnifiedTreasuryOwnerConfiguration(env)
  const maxPayoutSun = parseLimitTrx(env.TREASURY_TRX_MAX_PAYOUT || '')
  const dailyLimitSun = parseLimitTrx(env.TREASURY_TRX_DAILY_LIMIT || '')
  const feeReserveSun = validSunInteger(env.TREASURY_TRX_FEE_RESERVE_SUN, { allowZero: false })
  const enabled = env.TREASURY_TRX_WITHDRAWALS_ENABLED === 'true'
    && env.TREASURY_SIGNER_MODE === 'env-hot-wallet'
    && missing.length === 0
    && ownerAddressesMatch
    && ADDRESS_PATTERN.test(env.TREASURY_ADDRESS || '')
    && maxPayoutSun !== null && dailyLimitSun !== null
    && feeReserveSun !== null && feeReserveSun <= 1_000_000_000n
  return {
    enabled,
    missing,
    ownerAddressesMatch,
    signerMode: env.TREASURY_SIGNER_MODE === 'env-hot-wallet' ? 'env-hot-wallet' : 'not-configured',
    maxPayoutSun,
    dailyLimitSun,
    feeReserveSun,
  }
}

/**
 * Owner-only native TRX payouts from the same explicitly configured treasury
 * wallet as the USDT payout route. Disabled by default and limited to real
 * Mainnet TRX already held by that treasury.
 */
export function createTreasuryTrxWithdrawalsRouter({
  env = process.env,
  sessionLookup = getWalletAuthSession,
  tronWebFactory = (privateKey) => new TronWeb({ fullHost: MAINNET_RPC, privateKey }),
  poolFactory = getPool,
  schemaInitializer = ensureSchema,
  now = () => new Date(),
} = {}) {
  const router = Router()

  async function authenticateOwner(req) {
    const origin = validOrigin(req)
    const token = bearerToken(req)
    const expectedOwner = typeof env.TREASURY_OWNER_ADDRESS === 'string' ? env.TREASURY_OWNER_ADDRESS.trim() : ''
    if (!token || !SESSION_PATTERN.test(token) || !origin || !ADDRESS_PATTERN.test(expectedOwner)) {
      return { ok: false, status: 401, error: 'owner-auth-required' }
    }
    if (!isUnifiedTreasuryOwnerConfiguration(env)) {
      return { ok: false, status: 503, error: 'owner-address-configuration-mismatch' }
    }
    let result
    try {
      result = await sessionLookup({
        tokenHash: createHash('sha256').update(token, 'utf8').digest('hex'),
        origin,
      })
    } catch {
      result = null
    }
    if (!result?.success || !result.session) return { ok: false, status: 401, error: 'invalid-or-expired-session' }
    if (result.session.network !== 'mainnet' || result.session.address !== expectedOwner || result.session.origin !== origin) {
      return { ok: false, status: 403, error: 'treasury-owner-only' }
    }
    return { ok: true, ownerAddress: expectedOwner, origin }
  }

  async function readReservationState(db, treasuryAddress, balanceSun, config) {
    const activeTrx = await db.query(`
      SELECT COALESCE(SUM(amount_sun),0)::text AS amount
        FROM trc20_token_clone.treasury_trx_withdrawal_requests
       WHERE treasury_address = $1 AND status = ANY($2::text[])
    `, [treasuryAddress, ACTIVE_STATUSES])
    const reservedTrx = validSunInteger(activeTrx.rows[0]?.amount || '0')
    if (reservedTrx === null) throw new Error('invalid-trx-reservation-total')

    let pendingUsdtCount = 0n
    let usdtFeeLimitSun = 0n
    const relation = await db.query(`SELECT to_regclass('trc20_token_clone.treasury_withdrawal_requests') AS table_name`)
    if (relation.rows[0]?.table_name) {
      const activeUsdt = await db.query(`
        SELECT COUNT(*)::text AS count
          FROM trc20_token_clone.treasury_withdrawal_requests
         WHERE treasury_address = $1 AND status = ANY($2::text[])
      `, [treasuryAddress, ACTIVE_STATUSES])
      const countText = String(activeUsdt.rows[0]?.count ?? '0')
      if (!/^(0|[1-9][0-9]*)$/.test(countText)) throw new Error('invalid-usdt-reservation-count')
      pendingUsdtCount = BigInt(countText)
      if (pendingUsdtCount > 0n) {
        const feeText = typeof env.TREASURY_FEE_LIMIT_SUN === 'string' ? env.TREASURY_FEE_LIMIT_SUN : ''
        if (!/^[1-9][0-9]{0,9}$/.test(feeText) || BigInt(feeText) > 1_000_000_000n) {
          throw new Error('pending-usdt-fee-reservations-unavailable')
        }
        usdtFeeLimitSun = BigInt(feeText) * pendingUsdtCount
      }
    }

    const feeReserve = config.feeReserveSun
    const totalReserve = reservedTrx + usdtFeeLimitSun + feeReserve
    const available = BigInt(balanceSun) > totalReserve ? BigInt(balanceSun) - totalReserve : 0n
    return {
      reservedTrxSun: reservedTrx.toString(),
      pendingUsdtPayoutCount: pendingUsdtCount.toString(),
      pendingUsdtFeeReserveSun: usdtFeeLimitSun.toString(),
      feeReserveSun: feeReserve.toString(),
      availableBalanceSun: available.toString(),
    }
  }

  router.get('/trx-withdrawals/readiness', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    res.setHeader('Pragma', 'no-cache')
    res.setHeader('Vary', 'Authorization, Origin')
    const auth = await authenticateOwner(req)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const config = configFor(env)
    const db = poolFactory(env)
    let databaseReady = false
    if (db) {
      try { await schemaInitializer(db); await db.query('SELECT 1'); databaseReady = true } catch {}
    }
    let treasuryAddress = null
    let signerMatchesConfiguredAddress = false
    let balanceSun = null
    let reservations = null
    if (databaseReady && config.enabled) {
      try {
        const tronWeb = tronWebFactory(env.TREASURY_PRIVATE_KEY.trim())
        treasuryAddress = tronWeb.address.fromPrivateKey(env.TREASURY_PRIVATE_KEY.trim())
        signerMatchesConfiguredAddress = ADDRESS_PATTERN.test(treasuryAddress)
          && treasuryAddress === env.TREASURY_ADDRESS.trim()
        if (signerMatchesConfiguredAddress) {
          const rawBalance = String(await tronWeb.trx.getBalance(treasuryAddress))
          if (validSunInteger(rawBalance) !== null) {
            balanceSun = rawBalance
            reservations = await readReservationState(db, treasuryAddress, balanceSun, config)
          }
        }
      } catch {}
    }
    const blockers = []
    if (!config.enabled) blockers.push('trx-withdrawal-configuration-incomplete')
    if (!databaseReady) blockers.push('database-not-ready')
    if (!signerMatchesConfiguredAddress) blockers.push('treasury-signer-address-mismatch')
    if (balanceSun === null) blockers.push('treasury-trx-balance-unavailable')
    if (reservations && BigInt(reservations.availableBalanceSun) <= 0n) blockers.push('treasury-trx-insufficient-after-reservations')
    const trxWithdrawalsEnabled = blockers.length === 0
    return res.json({
      success: true,
      network: 'mainnet',
      asset: 'TRX',
      unit: 'SUN',
      trxWithdrawalsEnabled,
      configuration: { enabled: config.enabled, missing: config.missing, signerMode: config.signerMode },
      databaseReady,
      treasuryAddress,
      signerMatchesConfiguredAddress,
      treasuryTrxBalanceSun: balanceSun,
      treasuryTrxBalance: balanceSun === null ? null : decimalTrx(balanceSun),
      ...(reservations || {}),
      maxPayoutSun: config.maxPayoutSun?.toString() || null,
      dailyLimitSun: config.dailyLimitSun?.toString() || null,
      payoutBlockers: blockers,
      limitations: [
        'This route pays only real TRX already held by the treasury; it does not mint USDT or TRX.',
        'Pending USDT transfers reserve their configured maximum TRX fee; unresolved TRX transfers and a configured fee reserve are also deducted from available balance.',
        'Broadcast acceptance is not confirmation. Use the verification endpoint to check the exact transaction on TRON.',
        'A recipient exchange controls deposit credit and spendability.',
        'The environment hot-wallet signer is a high-risk custody arrangement and has not been independently audited.',
      ],
    })
  })

  router.post('/trx-withdrawals', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    res.setHeader('Pragma', 'no-cache')
    res.setHeader('Vary', 'Authorization, Origin')
    const auth = await authenticateOwner(req)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const config = configFor(env)
    if (!config.enabled) return res.status(503).json({ success: false, error: 'treasury-trx-withdrawals-disabled', missing: config.missing })
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
    if (Object.keys(body).some((key) => !['recipientAddress', 'amountTrx', 'idempotencyKey', 'ownerAuthorizationSignature', 'authorizationExpiresAt'].includes(key))
      || !ADDRESS_PATTERN.test(body.recipientAddress || '')
      || !IDEMPOTENCY_PATTERN.test(body.idempotencyKey || '')
      || typeof body.amountTrx !== 'string'
      || typeof body.ownerAuthorizationSignature !== 'string'
      || !OWNER_PAYOUT_SIGNATURE_PATTERN.test(body.ownerAuthorizationSignature)
      || !Number.isSafeInteger(body.authorizationExpiresAt)) {
      return res.status(400).json({ success: false, error: 'invalid-withdrawal-request' })
    }
    const amountSunText = parsePositiveTrxAmount(body.amountTrx)
    const amountSun = validSunInteger(amountSunText, { allowZero: false })
    if (amountSun === null || amountSun > config.maxPayoutSun || amountSun > config.dailyLimitSun
      || amountSun > BigInt(Number.MAX_SAFE_INTEGER)) {
      return res.status(400).json({ success: false, error: 'amount-outside-configured-limits' })
    }
    const clockValue = now()
    const currentTimeMs = clockValue instanceof Date ? clockValue.getTime() : Number(clockValue)
    if (!isTreasuryTrxAuthorizationExpiryValid(body.authorizationExpiresAt, currentTimeMs, 120_000)) {
      return res.status(401).json({ success: false, error: 'owner-payout-authorization-expired-or-outside-window' })
    }
    const db = poolFactory(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })

    let tronWeb
    let treasuryAddress
    try {
      await schemaInitializer(db)
      tronWeb = tronWebFactory(env.TREASURY_PRIVATE_KEY.trim())
      treasuryAddress = tronWeb.address.fromPrivateKey(env.TREASURY_PRIVATE_KEY.trim())
      if (!tronWeb.isAddress(body.recipientAddress)
        || !ADDRESS_PATTERN.test(treasuryAddress)
        || treasuryAddress !== env.TREASURY_ADDRESS.trim()
        || treasuryAddress === body.recipientAddress) {
        return res.status(503).json({ success: false, error: 'invalid-treasury-or-recipient' })
      }
      const authorizationMessage = buildTreasuryTrxWithdrawalAuthorizationMessage({
        origin: auth.origin,
        ownerAddress: auth.ownerAddress,
        treasuryAddress,
        recipientAddress: body.recipientAddress,
        amountSun: amountSun.toString(),
        idempotencyKey: body.idempotencyKey,
        authorizationExpiresAt: body.authorizationExpiresAt,
      })
      const ownerAuthorizedThisPayout = await verifyTreasuryOwnerPayoutSignature(tronWeb, {
        message: authorizationMessage,
        signature: body.ownerAuthorizationSignature,
        expectedOwnerAddress: auth.ownerAddress,
      })
      if (!ownerAuthorizedThisPayout) return res.status(403).json({ success: false, error: 'owner-payout-signature-invalid' })

      const client = await db.connect()
      let reservation
      try {
        await client.query('BEGIN')
        // Use the same global lock as the USDT route to serialize claims on the
        // treasury's native TRX balance and prevent cross-asset race conditions.
        await client.query("SELECT pg_advisory_xact_lock(hashtext('tron-token-studio-treasury-withdrawals-mainnet'))")
        const existing = await client.query('SELECT * FROM trc20_token_clone.treasury_trx_withdrawal_requests WHERE idempotency_key = $1 FOR UPDATE', [body.idempotencyKey])
        if (existing.rows.length) {
          const prior = existing.rows[0]
          await client.query('COMMIT')
          if (!sameTrxIntent(prior, {
            ownerAddress: auth.ownerAddress,
            treasuryAddress,
            recipientAddress: body.recipientAddress,
            amountSun: amountSun.toString(),
          })) {
            return res.status(409).json({ success: false, error: 'idempotency-key-conflict', message: 'This request key is already bound to a different transfer. No second transaction was broadcast.' })
          }
          return res.status(200).json({ success: true, duplicate: true, withdrawal: safeStatus(prior), note: 'Existing matching request returned; no second transfer was broadcast.' })
        }

        const currentBalanceSun = String(await tronWeb.trx.getBalance(treasuryAddress))
        if (validSunInteger(currentBalanceSun) === null) {
          await client.query('ROLLBACK')
          return res.status(503).json({ success: false, error: 'treasury-trx-balance-unavailable' })
        }
        const reservations = await readReservationState(db, treasuryAddress, currentBalanceSun, config)
        if (amountSun > BigInt(reservations.availableBalanceSun)) {
          await client.query('ROLLBACK')
          return res.status(409).json({
            success: false,
            error: 'treasury-trx-insufficient-after-reservations',
            treasuryTrxBalanceSun: currentBalanceSun,
            availableBalanceSun: reservations.availableBalanceSun,
            requestedAmountSun: amountSun.toString(),
            note: 'The available native TRX balance excludes unresolved transfers, pending USDT fee caps and the configured TRX fee reserve. No TRX was sent.',
          })
        }
        const daily = await client.query(`
          SELECT COALESCE(SUM(amount_sun),0)::text AS amount
            FROM trc20_token_clone.treasury_trx_withdrawal_requests
           WHERE created_at >= date_trunc('day', now())
             AND status <> 'rejected'
        `)
        const spentToday = validSunInteger(daily.rows[0]?.amount || '0')
        if (spentToday === null || spentToday + amountSun > config.dailyLimitSun) {
          await client.query('ROLLBACK')
          return res.status(429).json({ success: false, error: 'treasury-trx-daily-limit-exceeded' })
        }
        const inserted = await client.query(`
          INSERT INTO trc20_token_clone.treasury_trx_withdrawal_requests
            (idempotency_key, owner_address, treasury_address, recipient_address, amount_sun, status)
          VALUES ($1,$2,$3,$4,$5,'broadcasting') RETURNING *
        `, [body.idempotencyKey, auth.ownerAddress, treasuryAddress, body.recipientAddress, amountSun.toString()])
        reservation = inserted.rows[0]
        await client.query('COMMIT')
      } catch (error) {
        try { await client.query('ROLLBACK') } catch {}
        if (error?.code === '23505') {
          const existing = await db.query('SELECT * FROM trc20_token_clone.treasury_trx_withdrawal_requests WHERE idempotency_key = $1', [body.idempotencyKey])
          if (existing.rows.length) return res.status(200).json({ success: true, duplicate: true, withdrawal: safeStatus(existing.rows[0]), note: 'Existing request returned; no second transaction was broadcast.' })
        }
        throw error
      } finally {
        client.release()
      }

      let signed
      let txid
      try {
        const unsigned = await tronWeb.transactionBuilder.sendTrx(body.recipientAddress, Number(amountSun), treasuryAddress)
        const operations = unsigned?.raw_data?.contract
        const value = operations?.[0]?.parameter?.value
        if (!Array.isArray(operations) || operations.length !== 1 || operations[0]?.type !== 'TransferContract'
          || normalizedHex(value?.owner_address) !== normalizedHex(tronWeb.address.toHex(treasuryAddress))
          || normalizedHex(value?.to_address) !== normalizedHex(tronWeb.address.toHex(body.recipientAddress))
          || validSunInteger(value?.amount, { allowZero: false }) !== amountSun) {
          throw new Error('unsigned-native-transfer-intent-mismatch')
        }
        signed = await tronWeb.trx.sign(unsigned, env.TREASURY_PRIVATE_KEY.trim())
        txid = String(signed?.txID || signed?.txid || '')
        if (!TXID_PATTERN.test(txid) || txid.toLowerCase() !== String(unsigned?.txID || '').toLowerCase()
          || !Array.isArray(signed?.signature) || signed.signature.length < 1) {
          throw new Error('signed-transaction-invalid')
        }
        await db.query(`
          UPDATE trc20_token_clone.treasury_trx_withdrawal_requests
             SET transaction_hash = $2, updated_at = now()
           WHERE id = $1 AND status = 'broadcasting'
        `, [reservation.id, txid])
      } catch {
        await db.query(`
          UPDATE trc20_token_clone.treasury_trx_withdrawal_requests
             SET status = 'rejected', failure_code = 'transaction-build-or-signing-failed', updated_at = now()
           WHERE id = $1 AND status = 'broadcasting'
        `, [reservation.id])
        return res.status(503).json({ success: false, error: 'treasury-trx-transaction-signing-failed', note: 'The transfer was not broadcast. Correct the signer or node configuration before trying a new request.' })
      }

      try {
        const broadcast = await tronWeb.trx.sendRawTransaction(signed)
        const broadcastTxid = String(broadcast?.txid || broadcast?.txID || broadcast?.transaction?.txID || txid)
        if (broadcast?.result === true && broadcastTxid.toLowerCase() === txid.toLowerCase()) {
          const updated = await db.query(`
            UPDATE trc20_token_clone.treasury_trx_withdrawal_requests
               SET status = 'broadcast-accepted', transaction_hash = $2, failure_code = NULL, updated_at = now()
             WHERE id = $1 RETURNING *
          `, [reservation.id, txid])
          return res.status(202).json({
            success: true,
            status: 'broadcast-accepted',
            withdrawal: safeStatus(updated.rows[0]),
            note: 'The node accepted the signed transaction. Verify the confirmed native TransferContract and solidified block before treating it as complete.',
          })
        }
        await db.query(`
          UPDATE trc20_token_clone.treasury_trx_withdrawal_requests
             SET status = 'broadcast-unknown', failure_code = $2, updated_at = now()
           WHERE id = $1
        `, [reservation.id, broadcast?.result === true ? 'broadcast-transaction-id-mismatch' : 'broadcast-not-confirmed-by-provider'])
        return res.status(202).json({
          success: false,
          status: 'broadcast-unknown',
          error: 'broadcast-outcome-unknown',
          idempotencyKey: body.idempotencyKey,
          transactionHash: txid,
          note: 'Do not retry with a new key. Verify this stored transaction before any further action.',
        })
      } catch {
        await db.query(`
          UPDATE trc20_token_clone.treasury_trx_withdrawal_requests
             SET status = 'broadcast-unknown', failure_code = 'broadcast-outcome-unknown', updated_at = now()
           WHERE id = $1
        `, [reservation.id])
        return res.status(202).json({
          success: false,
          status: 'broadcast-unknown',
          error: 'broadcast-outcome-unknown',
          idempotencyKey: body.idempotencyKey,
          transactionHash: txid,
          note: 'The request outcome is ambiguous. Do not submit a replacement; verify the stored signed transaction on TRON.',
        })
      }
    } catch {
      return res.status(503).json({ success: false, error: 'treasury-trx-withdrawal-unavailable' })
    }
  })

  router.post('/trx-withdrawals/:idempotencyKey/verify', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    const auth = await authenticateOwner(req)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const key = req.params?.idempotencyKey
    if (!IDEMPOTENCY_PATTERN.test(key || '')) return res.status(400).json({ success: false, error: 'invalid-idempotency-key' })
    const db = poolFactory(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })
    try {
      await schemaInitializer(db)
      const lookup = await db.query('SELECT * FROM trc20_token_clone.treasury_trx_withdrawal_requests WHERE idempotency_key = $1 AND owner_address = $2', [key, auth.ownerAddress])
      if (!lookup.rows.length) return res.status(404).json({ success: false, error: 'withdrawal-not-found' })
      const row = lookup.rows[0]
      if (row.status === 'confirmed' || row.status === 'failed') {
        return res.json({ success: true, withdrawal: safeStatus(row), verification: { verified: true, status: row.status, reason: 'previously-verified-solidified-transaction' } })
      }
      const txid = typeof row.transaction_hash === 'string' ? row.transaction_hash.trim() : ''
      if (!TXID_PATTERN.test(txid)) return res.status(409).json({ success: false, error: 'transaction-hash-not-available', withdrawal: safeStatus(row) })
      const tronWeb = tronWebFactory(env.TREASURY_PRIVATE_KEY.trim())
      const [transaction, transactionInfo] = await Promise.all([
        tronWeb.trx.getConfirmedTransaction(txid).catch(() => null),
        tronWeb.trx.getTransactionInfo(txid).catch(() => null),
      ])
      const evidence = verifyTreasuryTrxTransferEvidence(tronWeb, {
        transaction, transactionInfo, transactionHash: txid,
        treasuryAddress: row.treasury_address,
        recipientAddress: row.recipient_address,
        amountSun: String(row.amount_sun),
      })
      if (evidence.status === 'confirmed' || evidence.status === 'failed') {
        const updated = await db.query(`
          UPDATE trc20_token_clone.treasury_trx_withdrawal_requests
             SET status = $2, failure_code = $3, updated_at = now()
           WHERE id = $1 AND status NOT IN ('confirmed','failed')
           RETURNING *
        `, [row.id, evidence.status, evidence.status === 'failed' ? evidence.reason : null])
        const saved = updated.rows[0] || row
        return res.json({ success: evidence.status === 'confirmed', withdrawal: safeStatus(saved), verification: evidence })
      }
      return res.status(evidence.status === 'verification-mismatch' ? 409 : 202).json({
        success: false, withdrawal: safeStatus(row), verification: evidence,
        note: 'No confirmation is inferred from the transaction hash alone. Retry verification after the transaction is included in the solidified chain.',
      })
    } catch {
      return res.status(503).json({ success: false, error: 'treasury-trx-withdrawal-verification-unavailable' })
    }
  })

  router.get('/trx-withdrawals/:idempotencyKey', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    const auth = await authenticateOwner(req)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const key = req.params?.idempotencyKey
    if (!IDEMPOTENCY_PATTERN.test(key || '')) return res.status(400).json({ success: false, error: 'invalid-idempotency-key' })
    const db = poolFactory(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })
    try {
      await schemaInitializer(db)
      const result = await db.query('SELECT * FROM trc20_token_clone.treasury_trx_withdrawal_requests WHERE idempotency_key = $1 AND owner_address = $2', [key, auth.ownerAddress])
      if (!result.rows.length) return res.status(404).json({ success: false, error: 'withdrawal-not-found' })
      return res.json({ success: true, withdrawal: safeStatus(result.rows[0]) })
    } catch {
      return res.status(503).json({ success: false, error: 'treasury-trx-withdrawal-unavailable' })
    }
  })

  return router
}

export default createTreasuryTrxWithdrawalsRouter
