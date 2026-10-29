import { createHash } from 'node:crypto'
import { Router } from 'express'
import pg from 'pg'
import { TronWeb } from 'tronweb'
import {
  buildTreasuryTrxWithdrawalAuthorizationMessage,
  isTreasuryAuthorizationExpiryValid,
  parsePositiveTrxAmount,
} from '../../src/treasury-withdrawal-auth.mjs'
import {
  createFireblocksClient,
  fireblocksConfiguration,
  extractFireblocksAddresses,
  providerAssetAvailableBaseUnits,
  isOfficialFireblocksNativeTrxAsset,
  classifyFireblocksTransaction,
} from '../fireblocks-client.mjs'
import {
  getWalletAuthSession,
  normalizeDatabaseConnectionString,
  databaseSslConfig,
} from '../database.mjs'
import {
  isUnifiedTreasuryOwnerConfiguration,
  verifyTreasuryOwnerPayoutSignature,
} from './treasury-withdrawals.mjs'

const { Pool } = pg
const MAINNET_RPC = 'https://api.trongrid.io'
const ADDRESS_PATTERN = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const TXID_PATTERN = /^[0-9a-f]{64}$/i
const SESSION_PATTERN = /^[A-Za-z0-9_-]{43}$/
const SIGNATURE_PATTERN = /^0x[0-9a-f]{130}$/i
const IDEMPOTENCY_PATTERN = /^trx-withdrawal-[A-Za-z0-9._:-]{24,128}$/
const ACTIVE_STATUSES = ['broadcasting', 'provider-pending', 'broadcast-accepted', 'broadcast-unknown']
const MAX_FUTURE_AUTH_MS = 120_000

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
  pool.on('error', (error) => console.error('Treasury TRX database error:', error?.code || 'unknown'))
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
          amount_base_units NUMERIC(78,0) NOT NULL CHECK (amount_base_units > 0),
          status TEXT NOT NULL CHECK (status IN ('broadcasting','provider-pending','broadcast-accepted','broadcast-unknown','rejected','confirmed','failed')),
          transaction_hash CHAR(64),
          provider_transaction_id TEXT,
          provider_status TEXT,
          failure_code TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `)
      await db.query(`ALTER TABLE trc20_token_clone.treasury_trx_withdrawal_requests
        ADD COLUMN IF NOT EXISTS provider_transaction_id TEXT`)
      await db.query(`ALTER TABLE trc20_token_clone.treasury_trx_withdrawal_requests
        ADD COLUMN IF NOT EXISTS provider_status TEXT`)
      await db.query(`ALTER TABLE trc20_token_clone.treasury_trx_withdrawal_requests
        ADD COLUMN IF NOT EXISTS failure_code TEXT`)
      await db.query(`ALTER TABLE trc20_token_clone.treasury_trx_withdrawal_requests
        DROP CONSTRAINT IF EXISTS treasury_trx_withdrawal_requests_status_check`)
      await db.query(`ALTER TABLE trc20_token_clone.treasury_trx_withdrawal_requests
        ADD CONSTRAINT treasury_trx_withdrawal_requests_status_check
        CHECK (status IN ('broadcasting','provider-pending','broadcast-accepted','broadcast-unknown','rejected','confirmed','failed'))`)
      await db.query(`CREATE INDEX IF NOT EXISTS idx_treasury_trx_withdrawals_pending
        ON trc20_token_clone.treasury_trx_withdrawal_requests (treasury_address, status, updated_at)`)
      await db.query(`CREATE INDEX IF NOT EXISTS idx_treasury_trx_withdrawals_daily
        ON trc20_token_clone.treasury_trx_withdrawal_requests (created_at, status)`)
    })().catch((error) => { schemaPromise = null; throw error })
  }
  await schemaPromise
}

function validInteger(value, { allowZero = true } = {}) {
  const text = typeof value === 'string' || typeof value === 'number' ? String(value) : ''
  if (!(allowZero ? /^(0|[1-9][0-9]{0,77})$/ : /^[1-9][0-9]{0,77}$/).test(text)) return null
  try { return BigInt(text) } catch { return null }
}

function decimalTrx(sunValue) {
  const value = validInteger(sunValue)
  if (value === null) return null
  const whole = value / 1_000_000n
  const fraction = (value % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
  return fraction ? whole.toString() + '.' + fraction : whole.toString()
}

function parseSunSetting(value, { allowZero = false, maxSun = 1_000_000_000_000n } = {}) {
  const parsed = validInteger(value, { allowZero })
  return parsed !== null && parsed <= maxSun ? parsed : null
}

function validOrigin(req) {
  const origin = typeof req.get === 'function' ? req.get('origin') : req.headers?.origin
  if (typeof origin !== 'string' || !origin.trim() || origin.length > 512) return ''
  try {
    const parsed = new URL(origin)
    return parsed.origin === origin ? origin : ''
  } catch { return '' }
}

function bearerToken(req) {
  const value = typeof req.get === 'function' ? req.get('authorization') || '' : req.headers?.authorization || ''
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(value)
  return match ? match[1] : ''
}

function sameIntent(row, { ownerAddress, treasuryAddress, recipientAddress, amountSun }) {
  return Boolean(row && typeof row === 'object'
    && row.owner_address === ownerAddress
    && row.treasury_address === treasuryAddress
    && row.recipient_address === recipientAddress
    && validInteger(String(row.amount_base_units), { allowZero: false }) === BigInt(amountSun))
}

function safeStatus(row) {
  return {
    idempotencyKey: row.idempotency_key,
    network: 'mainnet',
    asset: 'TRX',
    treasuryAddress: row.treasury_address,
    recipientAddress: row.recipient_address,
    amountSun: String(row.amount_base_units),
    amountTRX: decimalTrx(String(row.amount_base_units)),
    status: row.status,
    ...(row.transaction_hash ? { transactionHash: String(row.transaction_hash).trim() } : {}),
    ...(row.provider_status ? { providerStatus: row.provider_status } : {}),
    ...(row.failure_code ? { failureCode: row.failure_code } : {}),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  }
}

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
    || typeof amountSun !== 'string' || !/^[1-9][0-9]{0,15}$/.test(amountSun)) {
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
    expectedFrom = String(tronWeb.address.toHex(treasuryAddress)).replace(/^0x/i, '').toLowerCase()
    expectedTo = String(tronWeb.address.toHex(recipientAddress)).replace(/^0x/i, '').toLowerCase()
  } catch {
    return { verified: false, status: 'verification-mismatch', reason: 'address-encoding-failed' }
  }
  const from = typeof value?.owner_address === 'string' ? value.owner_address.replace(/^0x/i, '').toLowerCase() : ''
  const to = typeof value?.to_address === 'string' ? value.to_address.replace(/^0x/i, '').toLowerCase() : ''
  if (!expectedFrom || !expectedTo || from !== expectedFrom || to !== expectedTo
    || validInteger(value?.amount, { allowZero: false }) !== BigInt(amountSun)) {
    return { verified: false, status: 'verification-mismatch', reason: 'sender-recipient-or-amount-mismatch' }
  }
  if (!Number.isSafeInteger(transactionInfo?.blockNumber) || transactionInfo.blockNumber < 1) return pending
  const result = Array.isArray(transaction?.ret) ? transaction.ret[0]?.contractRet : undefined
  if (result === 'SUCCESS') {
    return { verified: true, status: 'confirmed', reason: 'confirmed-solidified-native-trx-transfer-success', blockNumber: transactionInfo.blockNumber }
  }
  if (typeof result === 'string' && result.length > 0) {
    return { verified: true, status: 'failed', reason: 'confirmed-solidified-native-trx-transfer-failed', blockNumber: transactionInfo.blockNumber }
  }
  return pending
}

function readRequiredConfiguration(env) {
  const required = [
    'DATABASE_URL',
    'OWNER_WALLET_ADDRESS',
    'TREASURY_OWNER_ADDRESS',
    'TREASURY_ADDRESS',
    'TREASURY_TRX_MAX_PAYOUT',
    'TREASURY_TRX_DAILY_LIMIT',
    'TREASURY_TRX_FEE_RESERVE_SUN',
    'TREASURY_FEE_LIMIT_SUN',
  ]
  const missing = required.filter((key) => typeof env[key] !== 'string' || !env[key].trim())
  const ownerAddressesMatch = isUnifiedTreasuryOwnerConfiguration(env)
  const maxPayoutSun = parsePositiveTrxAmount(env.TREASURY_TRX_MAX_PAYOUT || '')
  const dailyLimitSun = parsePositiveTrxAmount(env.TREASURY_TRX_DAILY_LIMIT || '')
  const feeReserveSun = parseSunSetting(env.TREASURY_TRX_FEE_RESERVE_SUN)
  const usdtFeeLimitSun = parseSunSetting(env.TREASURY_FEE_LIMIT_SUN)
  if (maxPayoutSun === null) missing.push('TREASURY_TRX_MAX_PAYOUT (valid positive TRX amount)')
  if (dailyLimitSun === null) missing.push('TREASURY_TRX_DAILY_LIMIT (valid positive TRX amount)')
  if (feeReserveSun === null) missing.push('TREASURY_TRX_FEE_RESERVE_SUN (positive SUN integer)')
  if (usdtFeeLimitSun === null) missing.push('TREASURY_FEE_LIMIT_SUN (positive SUN integer)')
  const provider = fireblocksConfiguration(env)
  missing.push(...provider.trxMissing)
  const signerSettingsValid = missing.length === 0
    && ownerAddressesMatch
    && ADDRESS_PATTERN.test(env.TREASURY_ADDRESS || '')
    && provider.trxConfigured
  const enabled = env.TREASURY_TRX_WITHDRAWALS_ENABLED === 'true'
    && env.TREASURY_SIGNER_MODE === 'fireblocks'
    && signerSettingsValid
  return {
    enabled,
    missing: [...new Set(missing)],
    ownerAddressesMatch,
    providerConfigured: provider.trxConfigured,
    maxPayoutSun: maxPayoutSun === null ? null : BigInt(maxPayoutSun),
    dailyLimitSun: dailyLimitSun === null ? null : BigInt(dailyLimitSun),
    feeReserveSun,
    usdtFeeLimitSun,
    signerMode: env.TREASURY_SIGNER_MODE === 'fireblocks' ? 'fireblocks-managed' : 'not-configured',
    settingsValid: signerSettingsValid,
  }
}

export function createTreasuryTrxWithdrawalsRouter({
  env = process.env,
  sessionLookup = getWalletAuthSession,
  tronWebFactory = () => new TronWeb({
    fullHost: MAINNET_RPC,
    ...(typeof env.TRONGRID_API_KEY === 'string' && env.TRONGRID_API_KEY.trim()
      ? { headers: { 'TRON-PRO-API-KEY': env.TRONGRID_API_KEY.trim() } }
      : {}),
  }),
  fireblocksClientFactory = (currentEnv) => createFireblocksClient(currentEnv),
  poolFactory = getPool,
  schemaInitializer = ensureSchema,
  now = () => new Date(),
} = {}) {
  const router = Router()
  const fireblocks = () => fireblocksClientFactory(env)

  async function authenticateOwner(req) {
    const origin = validOrigin(req)
    const token = bearerToken(req)
    const expectedOwner = typeof env.TREASURY_OWNER_ADDRESS === 'string' ? env.TREASURY_OWNER_ADDRESS.trim() : ''
    if (!token || !origin || !ADDRESS_PATTERN.test(expectedOwner)) {
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
    } catch { result = null }
    if (!result?.success || !result.session) return { ok: false, status: 401, error: 'invalid-or-expired-session' }
    if (result.session.network !== 'mainnet' || result.session.address !== expectedOwner || result.session.origin !== origin) {
      return { ok: false, status: 403, error: 'treasury-owner-only' }
    }
    return { ok: true, ownerAddress: expectedOwner, origin }
  }

  async function readSnapshot(treasuryAddress) {
    const provider = fireblocks()
    if (typeof provider?.isTrxConfigured !== 'function' || provider.isTrxConfigured() !== true) {
      return { ok: false, reason: 'fireblocks-trx-not-configured' }
    }
    try {
      const tronWeb = tronWebFactory()
      if (!tronWeb?.isAddress?.(treasuryAddress) || typeof tronWeb?.trx?.getBalance !== 'function') {
        return { ok: false, reason: 'tron-read-provider-unavailable' }
      }
      const assetId = typeof env.FIREBLOCKS_TRX_ASSET_ID === 'string' ? env.FIREBLOCKS_TRX_ASSET_ID.trim() : ''
      const [metadata, providerAsset, addressResponse] = await Promise.all([
        provider.getAssetMetadata(assetId),
        provider.getVaultAccountAsset(assetId),
        provider.getAssetAddresses(assetId),
      ])
      if (!isOfficialFireblocksNativeTrxAsset(metadata, assetId)) {
        return { ok: false, reason: 'fireblocks-asset-not-native-trx' }
      }
      const addresses = [...new Set(extractFireblocksAddresses(addressResponse))]
      if (addresses.length !== 1 || addresses[0] !== treasuryAddress) {
        return { ok: false, reason: 'fireblocks-vault-address-mismatch' }
      }
      const providerAvailable = providerAssetAvailableBaseUnits(providerAsset)
      if (providerAvailable === null) return { ok: false, reason: 'fireblocks-trx-available-balance-unavailable' }
      const chainBalanceSun = String(await tronWeb.trx.getBalance(treasuryAddress))
      if (validInteger(chainBalanceSun) === null) return { ok: false, reason: 'treasury-trx-balance-unavailable' }
      const providerBalanceSun = BigInt(providerAvailable)
      const chainBalance = BigInt(chainBalanceSun)
      return {
        ok: true,
        treasuryAddress,
        providerAssetId: assetId,
        providerAvailableSun: providerBalanceSun,
        chainBalanceSun: chainBalance,
        baseAvailableSun: chainBalance < providerBalanceSun ? chainBalance : providerBalanceSun,
      }
    } catch {
      return { ok: false, reason: 'provider-or-chain-read-unavailable' }
    }
  }

  async function readReservations(db, treasuryAddress) {
    const trx = await db.query(`
      SELECT COALESCE(SUM(amount_base_units),0)::text AS amount
        FROM trc20_token_clone.treasury_trx_withdrawal_requests
       WHERE treasury_address=$1 AND status = ANY($2::text[])
    `, [treasuryAddress, ACTIVE_STATUSES])
    const reservedTrx = validInteger(String(trx.rows[0]?.amount ?? '0'))
    if (reservedTrx === null) throw new Error('invalid-trx-reservation-total')

    let pendingUsdtCount = 0n
    const relation = await db.query(`SELECT to_regclass('trc20_token_clone.treasury_withdrawal_requests') AS table_name`)
    if (relation.rows[0]?.table_name) {
      const usdt = await db.query(`
        SELECT COUNT(*)::text AS count
          FROM trc20_token_clone.treasury_withdrawal_requests
         WHERE treasury_address=$1 AND status = ANY($2::text[])
      `, [treasuryAddress, ACTIVE_STATUSES])
      pendingUsdtCount = validInteger(String(usdt.rows[0]?.count ?? '0')) ?? 0n
    }
    return { reservedTrx, pendingUsdtCount }
  }

  async function availableAfterReservations(db, treasuryAddress, snapshot, config) {
    const reservations = await readReservations(db, treasuryAddress)
    const feeForPendingUsdt = config.usdtFeeLimitSun * reservations.pendingUsdtCount
    const totalReserve = reservations.reservedTrx + config.feeReserveSun + feeForPendingUsdt
    const chainAvailable = snapshot.chainBalanceSun > totalReserve ? snapshot.chainBalanceSun - totalReserve : 0n
    const providerAvailable = snapshot.providerAvailableSun > totalReserve ? snapshot.providerAvailableSun - totalReserve : 0n
    return {
      availableSun: chainAvailable < providerAvailable ? chainAvailable : providerAvailable,
      reservedTrxSun: reservations.reservedTrx,
      pendingUsdtPayoutCount: reservations.pendingUsdtCount,
      pendingUsdtFeeReserveSun: feeForPendingUsdt,
      feeReserveSun: config.feeReserveSun,
    }
  }

  async function refreshProviderTransaction(db, row) {
    if (!row || ['confirmed', 'failed', 'rejected'].includes(row.status)) return row
    try {
      const client = fireblocks()
      let providerTx
      if (row.provider_transaction_id) providerTx = await client.getTransaction(String(row.provider_transaction_id))
      else providerTx = await client.findTransactionByExternalId(String(row.idempotency_key))
      const providerId = typeof providerTx?.id === 'string' ? providerTx.id
        : typeof providerTx?.transactionId === 'string' ? providerTx.transactionId : ''
      if (!providerId) return row
      const state = classifyFireblocksTransaction(providerTx)
      const nextStatus = state.localStatus === 'broadcast-accepted' ? 'broadcast-accepted'
        : state.localStatus === 'failed' ? 'failed' : 'provider-pending'
      const updated = await db.query(`
        UPDATE trc20_token_clone.treasury_trx_withdrawal_requests
           SET status=$2, transaction_hash=COALESCE($3, transaction_hash),
               provider_transaction_id=$4, provider_status=$5,
               failure_code=$6, updated_at=now()
         WHERE id=$1 RETURNING *
      `, [row.id, nextStatus, state.transactionHash, providerId, state.providerStatus,
        nextStatus === 'failed' ? 'fireblocks-terminal-' + state.providerStatus.toLowerCase() : null])
      return updated.rows[0] || row
    } catch { return row }
  }

  router.get('/trx-withdrawals/readiness', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    res.setHeader('Pragma', 'no-cache')
    res.setHeader('Vary', 'Authorization, Origin')
    const auth = await authenticateOwner(req)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const config = readRequiredConfiguration(env)
    const db = poolFactory(env)
    let databaseReady = false
    if (db) {
      try { await schemaInitializer(db); await db.query('SELECT 1'); databaseReady = true } catch {}
    }
    const treasuryAddress = ADDRESS_PATTERN.test(env.TREASURY_ADDRESS || '') ? env.TREASURY_ADDRESS.trim() : null
    let snapshot = { ok: false, reason: 'treasury-address-not-configured' }
    let reservations = null
    if (databaseReady && treasuryAddress && config.providerConfigured) {
      snapshot = await readSnapshot(treasuryAddress)
      if (snapshot.ok) {
        try { reservations = await availableAfterReservations(db, treasuryAddress, snapshot, config) } catch {
          snapshot = { ok: false, reason: 'treasury-reservations-unavailable' }
        }
      }
    }
    const blockers = []
    if (!config.enabled) blockers.push(env.TREASURY_TRX_WITHDRAWALS_ENABLED === 'true'
      ? 'trx-withdrawal-configuration-incomplete' : 'trx-withdrawals-disabled-by-configuration')
    if (!databaseReady) blockers.push('database-not-ready')
    if (!treasuryAddress) blockers.push('treasury-address-not-configured')
    if (!snapshot.ok) blockers.push(snapshot.reason || 'provider-funding-unverified')
    if (reservations && reservations.availableSun <= 0n) blockers.push('treasury-trx-insufficient-after-reservations')
    return res.json({
      success: true,
      network: 'mainnet',
      asset: 'TRX',
      unit: 'SUN',
      trxWithdrawalsEnabled: blockers.length === 0,
      configuration: {
        enabled: config.enabled,
        missing: config.missing,
        signerMode: config.signerMode,
        providerConfigured: config.providerConfigured,
      },
      databaseReady,
      treasuryAddress,
      ...(snapshot.ok ? {
        providerAssetId: snapshot.providerAssetId,
        providerAvailableSun: snapshot.providerAvailableSun.toString(),
        treasuryTrxBalanceSun: snapshot.chainBalanceSun.toString(),
        ...(reservations ? {
          availableTrxSun: reservations.availableSun.toString(),
          reservedTrxSun: reservations.reservedTrxSun.toString(),
          pendingUsdtPayoutCount: reservations.pendingUsdtPayoutCount.toString(),
          pendingUsdtFeeReserveSun: reservations.pendingUsdtFeeReserveSun.toString(),
          feeReserveSun: reservations.feeReserveSun.toString(),
        } : {}),
      } : {}),
      payoutBlockers: [...new Set(blockers)],
      limitations: [
        'This route transfers only genuine native TRX already held by the verified managed treasury.',
        'Provider transaction acceptance is not chain confirmation; the exact transaction must be checked against a confirmed solidified block.',
        'TRX fees and pending USDT fee reservations are reserved conservatively from the same treasury.',
        'This route is a treasury payout path, not proof of a separate sponsor donating fees or principal.',
        'An exchange or wallet provider controls any subsequent deposit credit or account display.',
      ],
    })
  })

  router.post('/trx-withdrawals', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    res.setHeader('Vary', 'Authorization, Origin')
    const auth = await authenticateOwner(req)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const config = readRequiredConfiguration(env)
    if (!config.enabled) return res.status(503).json({ success: false, error: 'treasury-trx-withdrawals-disabled', missing: config.missing })

    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
    if (Object.keys(body).some((key) => !['recipientAddress','amountTrx','idempotencyKey','ownerAuthorizationSignature','authorizationExpiresAt'].includes(key))
      || !ADDRESS_PATTERN.test(body.recipientAddress || '')
      || !IDEMPOTENCY_PATTERN.test(body.idempotencyKey || '')
      || typeof body.amountTrx !== 'string'
      || typeof body.ownerAuthorizationSignature !== 'string'
      || !SIGNATURE_PATTERN.test(body.ownerAuthorizationSignature)
      || !Number.isSafeInteger(body.authorizationExpiresAt)) {
      return res.status(400).json({ success: false, error: 'invalid-withdrawal-request' })
    }
    const amountSunText = parsePositiveTrxAmount(body.amountTrx)
    const amountSun = validInteger(amountSunText, { allowZero: false })
    if (amountSun === null || amountSun > config.maxPayoutSun || amountSun > config.dailyLimitSun) {
      return res.status(400).json({ success: false, error: 'amount-outside-configured-limits' })
    }
    const clock = now()
    const nowMs = clock instanceof Date ? clock.getTime() : Number(clock)
    if (!isTreasuryAuthorizationExpiryValid(body.authorizationExpiresAt, nowMs, MAX_FUTURE_AUTH_MS)) {
      return res.status(401).json({ success: false, error: 'owner-payout-authorization-expired-or-outside-window' })
    }
    const db = poolFactory(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })

    try {
      await schemaInitializer(db)
      const tronWeb = tronWebFactory()
      const treasuryAddress = typeof env.TREASURY_ADDRESS === 'string' ? env.TREASURY_ADDRESS.trim() : ''
      if (!tronWeb.isAddress(body.recipientAddress) || !ADDRESS_PATTERN.test(treasuryAddress)
        || !tronWeb.isAddress(treasuryAddress) || treasuryAddress === body.recipientAddress) {
        return res.status(503).json({ success: false, error: 'invalid-treasury-or-recipient' })
      }
      const message = buildTreasuryTrxWithdrawalAuthorizationMessage({
        origin: auth.origin,
        ownerAddress: auth.ownerAddress,
        treasuryAddress,
        recipientAddress: body.recipientAddress,
        amountSun: amountSun.toString(),
        idempotencyKey: body.idempotencyKey,
        authorizationExpiresAt: body.authorizationExpiresAt,
      })
      const signedByOwner = await verifyTreasuryOwnerPayoutSignature(tronWeb, {
        message,
        signature: body.ownerAuthorizationSignature,
        expectedOwnerAddress: auth.ownerAddress,
      })
      if (!signedByOwner) return res.status(403).json({ success: false, error: 'owner-payout-signature-invalid' })

      const dbClient = await db.connect()
      let reservation
      try {
        await dbClient.query('BEGIN')
        // Shares the exact advisory lock with USDT withdrawals so concurrent routes
        // cannot reserve the same treasury TRX for both a payout principal and fees.
        await dbClient.query(`SELECT pg_advisory_xact_lock(hashtext('tron-token-studio-treasury-withdrawals-mainnet'))`)
        const existing = await dbClient.query(`
          SELECT * FROM trc20_token_clone.treasury_trx_withdrawal_requests
           WHERE idempotency_key=$1 FOR UPDATE
        `, [body.idempotencyKey])
        if (existing.rows.length) {
          const prior = existing.rows[0]
          await dbClient.query('COMMIT')
          if (!sameIntent(prior, {
            ownerAddress: auth.ownerAddress,
            treasuryAddress,
            recipientAddress: body.recipientAddress,
            amountSun: amountSun.toString(),
          })) {
            return res.status(409).json({ success: false, error: 'idempotency-key-conflict', message: 'This request key is bound to a different transfer. No second payout was submitted.' })
          }
          return res.status(200).json({ success: true, duplicate: true, withdrawal: safeStatus(prior), note: 'Existing request returned; no second payout was submitted.' })
        }
        const snapshot = await readSnapshot(treasuryAddress)
        if (!snapshot.ok) {
          await dbClient.query('ROLLBACK')
          return res.status(503).json({ success: false, error: 'treasury-trx-funding-not-verified', reason: snapshot.reason })
        }
        const available = await availableAfterReservations(db, treasuryAddress, snapshot, config)
        if (amountSun > available.availableSun) {
          await dbClient.query('ROLLBACK')
          return res.status(409).json({
            success: false,
            error: 'treasury-trx-insufficient-after-reservations',
            treasuryTrxBalanceSun: snapshot.chainBalanceSun.toString(),
            providerAvailableSun: snapshot.providerAvailableSun.toString(),
            availableTrxSun: available.availableSun.toString(),
            requestedAmountSun: amountSun.toString(),
            note: 'The actual chain and provider balances are insufficient after outstanding payouts and fee reserves. Nothing was submitted.',
          })
        }
        const spentResult = await dbClient.query(`
          SELECT COALESCE(SUM(amount_base_units),0)::text AS amount
            FROM trc20_token_clone.treasury_trx_withdrawal_requests
           WHERE created_at >= date_trunc('day',now()) AND status <> 'rejected'
        `)
        const spent = validInteger(String(spentResult.rows[0]?.amount ?? '0'))
        if (spent === null || spent + amountSun > config.dailyLimitSun) {
          await dbClient.query('ROLLBACK')
          return res.status(429).json({ success: false, error: 'treasury-trx-daily-limit-exceeded' })
        }
        const created = await dbClient.query(`
          INSERT INTO trc20_token_clone.treasury_trx_withdrawal_requests
            (idempotency_key,owner_address,treasury_address,recipient_address,amount_base_units,status)
          VALUES ($1,$2,$3,$4,$5,'broadcasting') RETURNING *
        `, [body.idempotencyKey, auth.ownerAddress, treasuryAddress, body.recipientAddress, amountSun.toString()])
        reservation = created.rows[0]
        await dbClient.query('COMMIT')
      } catch (error) {
        try { await dbClient.query('ROLLBACK') } catch {}
        if (error?.code === '23505') {
          const duplicate = await db.query(`
            SELECT * FROM trc20_token_clone.treasury_trx_withdrawal_requests WHERE idempotency_key=$1
          `, [body.idempotencyKey])
          if (duplicate.rows.length) return res.status(200).json({ success: true, duplicate: true, withdrawal: safeStatus(duplicate.rows[0]) })
        }
        throw error
      } finally { dbClient.release() }

      let providerTx
      const client = fireblocks()
      try {
        providerTx = await client.createTrxTransfer({
          recipientAddress: body.recipientAddress,
          amountTrx: decimalTrx(amountSun.toString()),
          externalTxId: body.idempotencyKey,
          note: 'TRON Token Studio owner-authorized native TRX payout',
        })
      } catch {
        // A provider timeout is ambiguous. Look up the same external transaction ID;
        // never create a second payout to "retry" an unknown submission.
        try { providerTx = await client.findTransactionByExternalId(body.idempotencyKey) } catch {}
      }
      const providerId = typeof providerTx?.id === 'string' ? providerTx.id
        : typeof providerTx?.transactionId === 'string' ? providerTx.transactionId : ''
      if (!providerId) {
        await db.query(`
          UPDATE trc20_token_clone.treasury_trx_withdrawal_requests
             SET status='broadcast-unknown', failure_code='provider-transaction-reference-unavailable', updated_at=now()
           WHERE id=$1
        `, [reservation.id])
        return res.status(202).json({
          success: false, status: 'broadcast-unknown', idempotencyKey: body.idempotencyKey,
          error: 'provider-transaction-reference-unavailable',
          note: 'Provider outcome is ambiguous; reconcile this same request before any further action.',
        })
      }
      let state = classifyFireblocksTransaction(providerTx)
      if (!state.transactionHash && !state.terminalFailure) {
        try { providerTx = await client.getTransaction(providerId); state = classifyFireblocksTransaction(providerTx) } catch {}
      }
      const nextStatus = state.localStatus === 'broadcast-accepted' ? 'broadcast-accepted'
        : state.localStatus === 'failed' ? 'failed' : 'provider-pending'
      const saved = await db.query(`
        UPDATE trc20_token_clone.treasury_trx_withdrawal_requests
           SET status=$2, transaction_hash=$3, provider_transaction_id=$4, provider_status=$5,
               failure_code=$6, updated_at=now()
         WHERE id=$1 RETURNING *
      `, [reservation.id, nextStatus, state.transactionHash, providerId, state.providerStatus,
        nextStatus === 'failed' ? 'fireblocks-terminal-' + state.providerStatus.toLowerCase() : null])
      return res.status(202).json({
        success: nextStatus !== 'failed', status: nextStatus, withdrawal: safeStatus(saved.rows[0]),
        note: nextStatus === 'broadcast-accepted'
          ? 'Fireblocks returned a chain transaction ID. Verify the confirmed solidified TRON transaction before treating this payout as complete.'
          : nextStatus === 'failed'
            ? 'Fireblocks reports a terminal failure; no successful chain transfer is claimed.'
            : 'Provider has not returned a chain hash yet. Funds remain reserved; poll this same request reference.',
      })
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
      let found = await db.query(`
        SELECT * FROM trc20_token_clone.treasury_trx_withdrawal_requests
         WHERE idempotency_key=$1 AND owner_address=$2
      `, [key, auth.ownerAddress])
      if (!found.rows.length) return res.status(404).json({ success: false, error: 'withdrawal-not-found' })
      let row = await refreshProviderTransaction(db, found.rows[0])
      if (row.status === 'confirmed') {
        return res.json({ success: true, withdrawal: safeStatus(row), verification: { verified: true, status: 'confirmed', reason: 'previously-verified-solidified-transaction' } })
      }
      if (row.status === 'failed' && String(row.failure_code || '').startsWith('fireblocks-terminal-')) {
        return res.status(409).json({ success: false, withdrawal: safeStatus(row), verification: { verified: false, status: 'failed', reason: 'provider-reported-terminal-failure' } })
      }
      const txid = typeof row.transaction_hash === 'string' ? row.transaction_hash.trim() : ''
      if (!TXID_PATTERN.test(txid)) {
        return res.status(['provider-pending','broadcasting','broadcast-unknown'].includes(row.status) ? 202 : 409).json({
          success: false, status: row.status, error: 'transaction-hash-not-available', withdrawal: safeStatus(row),
          note: 'No chain hash is available yet. The reservation remains held; do not submit a replacement request.',
        })
      }
      const tronWeb = tronWebFactory()
      const [transaction, transactionInfo] = await Promise.all([
        tronWeb.trx.getConfirmedTransaction(txid).catch(() => null),
        tronWeb.trx.getTransactionInfo(txid).catch(() => null),
      ])
      const evidence = verifyTreasuryTrxTransferEvidence(tronWeb, {
        transaction, transactionInfo, transactionHash: txid,
        treasuryAddress: row.treasury_address,
        recipientAddress: row.recipient_address,
        amountSun: String(row.amount_base_units),
      })
      if (evidence.status === 'confirmed' || evidence.status === 'failed') {
        const updated = await db.query(`
          UPDATE trc20_token_clone.treasury_trx_withdrawal_requests
             SET status=$2, failure_code=$3, updated_at=now()
           WHERE id=$1 AND status NOT IN ('confirmed','failed') RETURNING *
        `, [row.id, evidence.status, evidence.status === 'failed' ? evidence.reason : null])
        const saved = updated.rows[0] || row
        return res.status(evidence.status === 'confirmed' ? 200 : 409).json({
          success: evidence.status === 'confirmed',
          withdrawal: safeStatus(saved),
          verification: evidence,
        })
      }
      return res.status(evidence.status === 'verification-mismatch' ? 409 : 202).json({
        success: false, withdrawal: safeStatus(row), verification: evidence,
        note: 'A transaction hash alone does not prove success. Retry verification after the transaction is confirmed and solidified.',
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
      const found = await db.query(`
        SELECT * FROM trc20_token_clone.treasury_trx_withdrawal_requests
         WHERE idempotency_key=$1 AND owner_address=$2
      `, [key, auth.ownerAddress])
      if (!found.rows.length) return res.status(404).json({ success: false, error: 'withdrawal-not-found' })
      const row = await refreshProviderTransaction(db, found.rows[0])
      return res.json({ success: true, withdrawal: safeStatus(row) })
    } catch {
      return res.status(503).json({ success: false, error: 'treasury-trx-withdrawal-unavailable' })
    }
  })

  return router
}

export default createTreasuryTrxWithdrawalsRouter
