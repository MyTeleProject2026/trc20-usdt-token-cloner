import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { Router } from 'express'
import pg from 'pg'
import { TronWeb } from 'tronweb'
import { getWalletAuthSession, normalizeDatabaseConnectionString, databaseSslConfig } from '../database.mjs'
import { isValidTronAddress } from '../tron-address.mjs'
import { estimateTRC20TransferFee, assertTransferTransactionIntent } from '../../src/wallet-transfer.mjs'

const { Pool } = pg
const MAINNET_RPC = 'https://api.trongrid.io'
const USDT_MAINNET = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const ADDRESS_PATTERN = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const TXID_PATTERN = /^[0-9a-f]{64}$/i
const INTENT_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ABI = [
  { constant: true, inputs: [{ name: 'owner', type: 'address' }], name: 'balanceOf', outputs: [{ name: 'balance', type: 'uint256' }], stateMutability: 'view', type: 'function' },
  { constant: true, inputs: [], name: 'decimals', outputs: [{ name: '', type: 'uint8' }], stateMutability: 'view', type: 'function' },
  { constant: true, inputs: [], name: 'symbol', outputs: [{ name: '', type: 'string' }], stateMutability: 'view', type: 'function' },
]

function digest(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex')
}

function parseUsdtAmount(value) {
  if (typeof value !== 'string' || value.length > 86
    || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)) return null
  const [whole, fraction = ''] = value.split('.')
  if (whole.length > 78 || fraction.length > 6) return null
  const units = BigInt(whole) * 1_000_000n + BigInt((fraction + '000000').slice(0, 6))
  const max = (1n << 256n) - 1n
  return units > 0n && units <= max ? units.toString() : null
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validAddress(tronWeb, address, checkAddress = isValidTronAddress) {
  try {
    return typeof address === 'string' && ADDRESS_PATTERN.test(address)
      && checkAddress(address) && tronWeb.isAddress(address)
  } catch {
    return false
  }
}

function normalizeHex(value) {
  return typeof value === 'string' ? value.replace(/^0x/i, '').toLowerCase() : ''
}

function formatUnits6(value) {
  const units = BigInt(String(value))
  const whole = units / 1_000_000n
  const fraction = (units % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
  return fraction ? whole.toString() + '.' + fraction : whole.toString()
}

export function platformTreasuryConfiguration(env = process.env, checkAddress = isValidTronAddress) {
  const ownerAddress = typeof env.OWNER_WALLET_ADDRESS === 'string' ? env.OWNER_WALLET_ADDRESS.trim() : ''
  const treasuryOwnerAddress = typeof env.TREASURY_OWNER_ADDRESS === 'string' ? env.TREASURY_OWNER_ADDRESS.trim() : ''
  const treasuryAddress = typeof env.PLATFORM_TREASURY_ADDRESS === 'string' ? env.PLATFORM_TREASURY_ADDRESS.trim() : ''
  const maxPayout = parseUsdtAmount(env.PLATFORM_TREASURY_MAX_PAYOUT_USDT)
  const dailyLimit = parseUsdtAmount(env.PLATFORM_TREASURY_DAILY_LIMIT_USDT)
  const feeText = typeof env.PLATFORM_TREASURY_MAX_FEE_SUN === 'string' ? env.PLATFORM_TREASURY_MAX_FEE_SUN.trim() : ''
  const maxFeeSun = /^[1-9][0-9]{0,8}$/.test(feeText) ? BigInt(feeText) : 0n
  const missing = []
  if (!env.DATABASE_URL) missing.push('DATABASE_URL')
  if (!ownerAddress || !checkAddress(ownerAddress)) missing.push('OWNER_WALLET_ADDRESS')
  if (!treasuryOwnerAddress || !checkAddress(treasuryOwnerAddress) || treasuryOwnerAddress !== ownerAddress) {
    missing.push('TREASURY_OWNER_ADDRESS (must match OWNER_WALLET_ADDRESS)')
  }
  if (!treasuryAddress || !checkAddress(treasuryAddress)) missing.push('PLATFORM_TREASURY_ADDRESS')
  if (maxPayout === null) missing.push('PLATFORM_TREASURY_MAX_PAYOUT_USDT')
  if (dailyLimit === null || (maxPayout !== null && dailyLimit < maxPayout)) {
    missing.push('PLATFORM_TREASURY_DAILY_LIMIT_USDT')
  }
  if (maxFeeSun < 1_000_000n || maxFeeSun > 100_000_000n) {
    missing.push('PLATFORM_TREASURY_MAX_FEE_SUN (1–100 TRX)')
  }
  return {
    ownerAddress, treasuryOwnerAddress, treasuryAddress,
    maxPayoutBaseUnits: maxPayout, dailyLimitBaseUnits: dailyLimit,
    maxFeeSun: maxFeeSun > 0n ? maxFeeSun.toString() : null,
    enabled: env.PLATFORM_TREASURY_SELF_CUSTODY_ENABLED === 'true',
    configurationComplete: missing.length === 0,
    missing,
  }
}

export function hasSufficientTronPermissionWeight(response, expectedTxId) {
  const threshold = Number(response?.permission?.threshold)
  const weight = Number(response?.current_weight)
  const returnedTxId = String(
    response?.transaction?.txid
      || response?.transaction?.transaction?.txID
      || response?.transaction?.transaction?.txid
      || '',
  ).toLowerCase()
  const resultCode = typeof response?.result?.code === 'string' ? response.result.code : ''
  return Number.isSafeInteger(threshold) && threshold > 0
    && Number.isSafeInteger(weight) && weight >= threshold
    && returnedTxId === String(expectedTxId || '').toLowerCase()
    && (!resultCode || resultCode === 'ENOUGH_PERMISSION')
}

export function validateSignedSelfCustodyTransaction(tronWeb, {
  unsignedTransaction, signedTransaction, treasuryAddress, recipientAddress,
  amountBaseUnits, tokenContract = USDT_MAINNET,
} = {}) {
  if (!isPlainObject(unsignedTransaction) || !isPlainObject(signedTransaction)) return false
  const allowedSignedFields = new Set(['visible', 'txID', 'raw_data', 'raw_data_hex', 'signature', 'ret'])
  if (Object.keys(signedTransaction).some((key) => !allowedSignedFields.has(key))
    || signedTransaction.visible === true
    || (signedTransaction.visible !== undefined && typeof signedTransaction.visible !== 'boolean')) return false
  if (!isDeepStrictEqual(unsignedTransaction.raw_data, signedTransaction.raw_data)) return false
  if (typeof unsignedTransaction.raw_data_hex !== 'string'
    || !/^(?:[0-9a-f]{2})+$/i.test(unsignedTransaction.raw_data_hex)
    || signedTransaction.raw_data_hex !== unsignedTransaction.raw_data_hex
    || typeof unsignedTransaction.txID !== 'string' || !TXID_PATTERN.test(unsignedTransaction.txID)
    || String(signedTransaction.txID || '').toLowerCase() !== unsignedTransaction.txID.toLowerCase()
    || !Array.isArray(signedTransaction.signature) || signedTransaction.signature.length < 1
    || signedTransaction.signature.length > 10
    || signedTransaction.signature.some((signature) => typeof signature !== 'string' || !/^(?:0x)?[0-9a-f]{130}$/i.test(signature))) {
    return false
  }
  const expectedTxId = createHash('sha256').update(Buffer.from(unsignedTransaction.raw_data_hex, 'hex')).digest('hex')
  if (expectedTxId.toLowerCase() !== unsignedTransaction.txID.toLowerCase()) return false
  try {
    assertTransferTransactionIntent(tronWeb, signedTransaction, {
      from: treasuryAddress, to: recipientAddress, asset: 'TRC20', amountBaseUnits, tokenContract,
    })
    return true
  } catch {
    return false
  }
}

function createPool(env) {
  if (!env.DATABASE_URL) return null
  const connectionString = normalizeDatabaseConnectionString(env.DATABASE_URL)
  const pool = new Pool({
    connectionString, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000, max: 3,
    ssl: databaseSslConfig(connectionString, env),
  })
  pool.on('error', (error) => console.error('Platform treasury database error:', error?.code || 'unknown'))
  return pool
}

async function ensureSchema(db) {
  await db.query('CREATE SCHEMA IF NOT EXISTS trc20_token_clone')
  await db.query("CREATE TABLE IF NOT EXISTS trc20_token_clone.platform_treasury_withdrawals (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, intent_id UUID NOT NULL UNIQUE, owner_address TEXT NOT NULL, treasury_address TEXT NOT NULL, recipient_address TEXT NOT NULL, token_contract TEXT NOT NULL, amount_base_units NUMERIC(78,0) NOT NULL CHECK (amount_base_units > 0), fee_limit_sun BIGINT NOT NULL CHECK (fee_limit_sun > 0), unsigned_tx_id CHAR(64) NOT NULL, unsigned_raw_data_hex TEXT NOT NULL, unsigned_transaction JSONB NOT NULL, transaction_hash CHAR(64), status TEXT NOT NULL CHECK (status IN ('prepared','broadcasting','broadcast-accepted','broadcast-unknown','confirmed','failed','rejected')), verification_reason TEXT, expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())")
  await db.query('CREATE INDEX IF NOT EXISTS platform_treasury_withdrawals_reserve_idx ON trc20_token_clone.platform_treasury_withdrawals (treasury_address, status, created_at)')
  await db.query('CREATE INDEX IF NOT EXISTS platform_treasury_withdrawals_owner_idx ON trc20_token_clone.platform_treasury_withdrawals (owner_address, created_at DESC)')
}

function safeIntent(row) {
  return {
    intentId: String(row.intent_id), network: 'mainnet', asset: 'USDT',
    tokenContract: USDT_MAINNET, treasuryAddress: row.treasury_address,
    recipientAddress: row.recipient_address, amountBaseUnits: String(row.amount_base_units),
    amountUsdt: formatUnits6(row.amount_base_units), feeLimitSun: String(row.fee_limit_sun),
    status: row.status, transactionHash: row.transaction_hash ? String(row.transaction_hash).trim() : null,
    verificationReason: row.verification_reason || null,
    expiresAt: new Date(row.expires_at).toISOString(),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  }
}

function bearerToken(req) {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.get('authorization') || '')
  return match ? match[1] : ''
}

function errorResponse(res, status, error, extra = {}) {
  return res.status(status).json({ success: false, error, ...extra })
}

async function readTreasurySnapshot(tronWeb, treasuryAddress) {
  if (!tronWeb?.isAddress?.(treasuryAddress) || typeof tronWeb.contract !== 'function'
    || typeof tronWeb?.trx?.getBalance !== 'function') return { ok: false, reason: 'mainnet-read-provider-unavailable' }
  try {
    const contract = await tronWeb.contract(ABI).at(USDT_MAINNET)
    const [decimals, symbol, balance, trxBalance] = await Promise.all([
      contract.decimals().call(), contract.symbol().call(),
      contract.balanceOf(treasuryAddress).call(), tronWeb.trx.getBalance(treasuryAddress),
    ])
    const usdtText = String(balance)
    const trxText = String(trxBalance)
    if (Number(decimals) !== 6 || String(symbol).toUpperCase() !== 'USDT'
      || !/^(0|[1-9][0-9]{0,77})$/.test(usdtText)
      || !/^(0|[1-9][0-9]{0,20})$/.test(trxText)) return { ok: false, reason: 'official-mainnet-usdt-or-trx-balance-unverified' }
    return {
      ok: true, treasuryAddress, usdtBalanceBaseUnits: usdtText, usdtBalance: formatUnits6(usdtText),
      trxBalanceSun: trxText, trxBalance: formatUnits6(trxText), checkedAt: new Date().toISOString(),
    }
  } catch {
    return { ok: false, reason: 'mainnet-treasury-read-failed' }
  }
}

async function verifySolidifiedUsdtTransfer(tronWeb, row) {
  const txid = String(row.transaction_hash || '').trim().toLowerCase()
  if (!TXID_PATTERN.test(txid)) return { verified: false, status: 'awaiting-broadcast', reason: 'transaction-hash-unavailable' }
  let transaction
  let info
  try {
    [transaction, info] = await Promise.all([
      tronWeb.trx.getConfirmedTransaction(txid), tronWeb.trx.getTransactionInfo(txid),
    ])
  } catch {
    return { verified: false, status: 'pending', reason: 'solidified-chain-data-unavailable' }
  }
  if (String(transaction?.txID || transaction?.txid || '').toLowerCase() !== txid
    || String(info?.id || info?.txID || info?.txid || '').toLowerCase() !== txid
    || !Number.isSafeInteger(info?.blockNumber) || info.blockNumber < 1) {
    return { verified: false, status: 'pending', reason: 'transaction-not-yet-solidified' }
  }
  try {
    assertTransferTransactionIntent(tronWeb, transaction, {
      from: row.treasury_address, to: row.recipient_address, asset: 'TRC20',
      amountBaseUnits: String(row.amount_base_units), tokenContract: USDT_MAINNET,
    })
  } catch {
    return { verified: false, status: 'verification-mismatch', reason: 'confirmed-transaction-intent-mismatch' }
  }
  const receipt = String(info?.receipt?.result || '').toUpperCase()
  if (receipt !== 'SUCCESS') {
    if (!receipt) return { verified: false, status: 'pending', reason: 'execution-receipt-unavailable' }
    return { verified: true, status: 'failed', reason: 'solidified-execution-failed', blockNumber: info.blockNumber }
  }
  let contractHex
  let fromHex
  let toHex
  try {
    contractHex = normalizeHex(tronWeb.address.toHex(USDT_MAINNET)).replace(/^41(?=[0-9a-f]{40}$)/, '')
    fromHex = normalizeHex(tronWeb.address.toHex(row.treasury_address)).replace(/^41(?=[0-9a-f]{40}$)/, '').padStart(64, '0')
    toHex = normalizeHex(tronWeb.address.toHex(row.recipient_address)).replace(/^41(?=[0-9a-f]{40}$)/, '').padStart(64, '0')
  } catch {
    return { verified: false, status: 'verification-mismatch', reason: 'address-encoding-failed' }
  }
  const transferTopic = 'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
  const logs = Array.isArray(info?.log) ? info.log : []
  const matchingContractLogs = logs.filter((log) =>
    normalizeHex(log?.address).replace(/^41(?=[0-9a-f]{40}$)/, '') === contractHex
    && Array.isArray(log?.topics) && normalizeHex(log.topics[0]) === transferTopic)
  const exactEvents = matchingContractLogs.filter((log) =>
    log.topics.length >= 3
    && normalizeHex(log.topics[1]).padStart(64, '0') === fromHex
    && normalizeHex(log.topics[2]).padStart(64, '0') === toHex
    && normalizeHex(log.data).padStart(64, '0') === BigInt(String(row.amount_base_units)).toString(16).padStart(64, '0'))
  if (matchingContractLogs.length !== 1 || exactEvents.length !== 1) {
    return { verified: false, status: 'verification-mismatch', reason: 'official-usdt-transfer-event-missing-or-mismatched' }
  }
  return { verified: true, status: 'confirmed', reason: 'solidified-official-usdt-transfer-event', blockNumber: info.blockNumber }
}

export function createPlatformTreasuryRouter({
  env = process.env,
  sessionLookup = getWalletAuthSession,
  tronWebFactory = () => new TronWeb({ fullHost: MAINNET_RPC }),
  poolFactory = createPool,
  isValidAddress = isValidTronAddress,
  now = () => Date.now(),
} = {}) {
  const router = Router()
  let pool
  let schemaReady

  function getDb() {
    if (pool !== undefined) return pool
    pool = poolFactory(env)
    return pool
  }

  async function ensureReady(db) {
    if (!schemaReady) {
      schemaReady = ensureSchema(db).catch((error) => {
        schemaReady = null
        throw error
      })
    }
    await schemaReady
  }

  async function authenticateOwner(req) {
    const token = bearerToken(req)
    const origin = req.get('origin') || ''
    const config = platformTreasuryConfiguration(env, isValidAddress)
    if (!token || !origin || !config.ownerAddress || !config.configurationComplete) {
      return { ok: false, status: 401, error: 'platform-owner-auth-required' }
    }
    let lookup
    try {
      lookup = await sessionLookup({ tokenHash: digest(token), origin, nowMs: now() })
    } catch {
      lookup = null
    }
    if (lookup?.success !== true || !lookup.session) {
      return { ok: false, status: 401, error: 'invalid-or-expired-owner-session' }
    }
    const session = lookup.session
    if (session.network !== 'mainnet' || session.address !== config.ownerAddress || session.origin !== origin) {
      return { ok: false, status: 403, error: 'platform-owner-only' }
    }
    return { ok: true, ownerAddress: config.ownerAddress, config }
  }

  router.get('/self-custody/readiness', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    res.setHeader('Pragma', 'no-cache')
    const auth = await authenticateOwner(req)
    if (!auth.ok) return errorResponse(res, auth.status, auth.error)
    const db = getDb()
    if (!db) return errorResponse(res, 503, 'database-not-configured', { missing: auth.config.missing })
    try {
      await ensureReady(db)
      const tronWeb = tronWebFactory()
      const snapshot = await readTreasurySnapshot(tronWeb, auth.config.treasuryAddress)
      if (!snapshot.ok) return errorResponse(res, 503, snapshot.reason, { executionEnabled: false })
      const pending = await db.query(
        "SELECT COALESCE(SUM(amount_base_units),0)::text AS principal_reserved, COALESCE(SUM(fee_limit_sun),0)::text AS fee_reserved FROM trc20_token_clone.platform_treasury_withdrawals WHERE treasury_address=$1 AND status IN ('prepared','broadcasting','broadcast-accepted','broadcast-unknown')",
        [auth.config.treasuryAddress],
      )
      const reservedPrincipal = BigInt(pending.rows[0]?.principal_reserved || '0')
      const reservedFees = BigInt(pending.rows[0]?.fee_reserved || '0')
      const availableUsdt = BigInt(snapshot.usdtBalanceBaseUnits) > reservedPrincipal
        ? BigInt(snapshot.usdtBalanceBaseUnits) - reservedPrincipal : 0n
      const availableTrx = BigInt(snapshot.trxBalanceSun) > reservedFees
        ? BigInt(snapshot.trxBalanceSun) - reservedFees : 0n
      const blockers = []
      if (!auth.config.enabled) blockers.push('self-custody-execution-flag-disabled')
      if (availableUsdt <= 0n) blockers.push('treasury-usdt-principal-unavailable')
      if (availableTrx <= 0n) blockers.push('treasury-trx-fee-reserve-unavailable')
      else if (availableTrx < BigInt(config.maxFeeSun)) blockers.push('treasury-trx-below-configured-fee-cap')
      return res.json({
        success: true, network: 'mainnet', asset: 'USDT', tokenContract: USDT_MAINNET,
        treasuryAddress: snapshot.treasuryAddress, ownerIdentityAddress: auth.ownerAddress,
        usdtBalanceBaseUnits: snapshot.usdtBalanceBaseUnits, usdtBalance: snapshot.usdtBalance,
        reservedUsdtBaseUnits: reservedPrincipal.toString(),
        availableUsdtBaseUnits: availableUsdt.toString(), availableUsdt: formatUnits6(availableUsdt),
        trxBalanceSun: snapshot.trxBalanceSun, trxBalance: snapshot.trxBalance,
        reservedFeeSun: reservedFees.toString(), availableTrxSun: availableTrx.toString(),
        configurationComplete: auth.config.configurationComplete,
        featureFlagEnabled: auth.config.enabled, missing: auth.config.missing,
        executionEnabled: auth.config.enabled && blockers.length === 0,
        blockers, checkedAt: snapshot.checkedAt,
        note: 'Each withdrawal is rechecked and requires a separate transaction signature from the configured treasury wallet.',
      })
    } catch {
      return errorResponse(res, 503, 'platform-treasury-readiness-unavailable')
    }
  })

  router.post('/self-custody/prepare', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    const auth = await authenticateOwner(req)
    if (!auth.ok) return errorResponse(res, auth.status, auth.error)
    const config = auth.config
    if (!config.enabled) return errorResponse(res, 503, 'self-custody-execution-disabled')
    if (!isPlainObject(req.body) || Object.keys(req.body).some((key) => !['recipientAddress', 'amountUsdt'].includes(key))) {
      return errorResponse(res, 400, 'invalid-withdrawal-request')
    }
    const recipient = typeof req.body.recipientAddress === 'string' ? req.body.recipientAddress.trim() : ''
    const amountBaseUnits = parseUsdtAmount(req.body.amountUsdt)
    if (!amountBaseUnits) return errorResponse(res, 400, 'invalid-usdt-amount')
    if (BigInt(amountBaseUnits) > config.maxPayoutBaseUnits) return errorResponse(res, 400, 'per-payout-limit-exceeded')
    if (!isValidAddress(recipient) || recipient === config.treasuryAddress) return errorResponse(res, 400, 'invalid-recipient-address')

    const db = getDb()
    if (!db) return errorResponse(res, 503, 'database-not-configured')
    let client
    let transactionOpen = false
    try {
      await ensureReady(db)
      const tronWeb = tronWebFactory()
      if (!validAddress(tronWeb, config.treasuryAddress, isValidAddress)
        || !validAddress(tronWeb, recipient, isValidAddress)) return errorResponse(res, 400, 'invalid-mainnet-tron-address')
      const snapshot = await readTreasurySnapshot(tronWeb, config.treasuryAddress)
      if (!snapshot.ok) return errorResponse(res, 503, snapshot.reason)
      const feeEstimate = await estimateTRC20TransferFee({
        tronWeb, from: config.treasuryAddress, to: recipient,
        tokenContract: USDT_MAINNET, amountBaseUnits,
      })
      if (!Number.isSafeInteger(feeEstimate?.recommendedFeeSun)
        || feeEstimate.recommendedFeeSun < 1_000_000
        || feeEstimate.recommendedFeeSun > Number(config.maxFeeSun)) {
        return errorResponse(res, 409, 'estimated-fee-exceeds-platform-cap', {
          estimatedFeeSun: Number.isSafeInteger(feeEstimate?.recommendedFeeSun) ? String(feeEstimate.recommendedFeeSun) : null,
          maximumFeeSun: config.maxFeeSun,
        })
      }
      const feeLimitSun = String(feeEstimate.recommendedFeeSun)
      const built = await tronWeb.transactionBuilder.triggerSmartContract(
        USDT_MAINNET, 'transfer(address,uint256)',
        { feeLimit: Number(feeLimitSun), callValue: 0 },
        [{ type: 'address', value: recipient }, { type: 'uint256', value: amountBaseUnits }],
        config.treasuryAddress,
      )
      const unsignedTransaction = built?.transaction
      if (built?.result?.result !== true || !unsignedTransaction
        || typeof unsignedTransaction.raw_data_hex !== 'string'
        || !/^[0-9a-f]+$/i.test(unsignedTransaction.raw_data_hex)
        || !TXID_PATTERN.test(unsignedTransaction.txID || '')) {
        return errorResponse(res, 503, 'unsigned-transaction-build-failed')
      }
      try {
        assertTransferTransactionIntent(tronWeb, unsignedTransaction, {
          from: config.treasuryAddress, to: recipient, asset: 'TRC20',
          amountBaseUnits, tokenContract: USDT_MAINNET,
        })
      } catch {
        return errorResponse(res, 409, 'unsigned-transaction-intent-mismatch')
      }
      const expiration = Number(unsignedTransaction.raw_data?.expiration)
      if (!Number.isSafeInteger(expiration) || expiration <= now() + 5_000 || expiration > now() + 10 * 60_000) {
        return errorResponse(res, 503, 'unsigned-transaction-expiry-invalid')
      }
      const expectedTxId = createHash('sha256').update(Buffer.from(unsignedTransaction.raw_data_hex, 'hex')).digest('hex')
      if (expectedTxId.toLowerCase() !== unsignedTransaction.txID.toLowerCase()) {
        return errorResponse(res, 503, 'unsigned-transaction-id-invalid')
      }

      client = await db.connect()
      await client.query('BEGIN')
      transactionOpen = true
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [config.treasuryAddress])

      // Re-read balances after acquiring the treasury lock. The earlier
      // preflight was useful for transaction construction, but reservations
      // must be based on the freshest available chain snapshot.
      const currentSnapshot = await readTreasurySnapshot(tronWeb, config.treasuryAddress)
      if (!currentSnapshot.ok) {
        await client.query('ROLLBACK')
        transactionOpen = false
        return errorResponse(res, 503, currentSnapshot.reason)
      }
      await client.query(
        "UPDATE trc20_token_clone.platform_treasury_withdrawals SET status='rejected', verification_reason='unsigned-intent-expired', updated_at=now() WHERE treasury_address=$1 AND status='prepared' AND expires_at <= now()",
        [config.treasuryAddress],
      )
      const [pending, daily] = await Promise.all([
        client.query(
          "SELECT COALESCE(SUM(amount_base_units),0)::text AS principal_reserved, COALESCE(SUM(fee_limit_sun),0)::text AS fee_reserved FROM trc20_token_clone.platform_treasury_withdrawals WHERE treasury_address=$1 AND status IN ('prepared','broadcasting','broadcast-accepted','broadcast-unknown')",
          [config.treasuryAddress],
        ),
        client.query(
          "SELECT COALESCE(SUM(amount_base_units),0)::text AS daily_total FROM trc20_token_clone.platform_treasury_withdrawals WHERE treasury_address=$1 AND created_at >= now() - INTERVAL '24 hours' AND status NOT IN ('rejected','failed')",
          [config.treasuryAddress],
        ),
      ])
      const reservedPrincipal = BigInt(pending.rows[0]?.principal_reserved || '0')
      const reservedFees = BigInt(pending.rows[0]?.fee_reserved || '0')
      const dailyTotal = BigInt(daily.rows[0]?.daily_total || '0')
      if (BigInt(currentSnapshot.usdtBalanceBaseUnits) < reservedPrincipal + BigInt(amountBaseUnits)) {
        await client.query('ROLLBACK'); transactionOpen = false
        return errorResponse(res, 409, 'insufficient-unreserved-usdt-principal')
      }
      if (BigInt(currentSnapshot.trxBalanceSun) < reservedFees + BigInt(feeLimitSun)) {
        await client.query('ROLLBACK'); transactionOpen = false
        return errorResponse(res, 409, 'insufficient-unreserved-trx-for-fees')
      }
      if (dailyTotal + BigInt(amountBaseUnits) > config.dailyLimitBaseUnits) {
        await client.query('ROLLBACK'); transactionOpen = false
        return errorResponse(res, 409, 'daily-payout-limit-exceeded')
      }
      const intentId = randomUUID()
      const inserted = await client.query(
        "INSERT INTO trc20_token_clone.platform_treasury_withdrawals (intent_id, owner_address, treasury_address, recipient_address, token_contract, amount_base_units, fee_limit_sun, unsigned_tx_id, unsigned_raw_data_hex, unsigned_transaction, status, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,to_timestamp($12 / 1000.0)) RETURNING *",
        [intentId, auth.ownerAddress, config.treasuryAddress, recipient, USDT_MAINNET, amountBaseUnits, feeLimitSun, unsignedTransaction.txID.toLowerCase(), unsignedTransaction.raw_data_hex, JSON.stringify(unsignedTransaction), 'prepared', expiration],
      )
      await client.query('COMMIT')
      transactionOpen = false
      return res.status(201).json({
        success: true,
        intent: safeIntent(inserted.rows[0]),
        unsignedTransaction,
        chainSnapshot: {
          treasuryUsdtBalance: currentSnapshot.usdtBalance,
          treasuryTrxBalance: currentSnapshot.trxBalance,
          estimatedFeeSun: feeLimitSun,
          estimatedFeeTrx: formatUnits6(feeLimitSun),
        },
        note: 'Unsigned transaction prepared and reserved. No transaction has been signed or broadcast.',
      })
    } catch (error) {
      if (transactionOpen && client) await client.query('ROLLBACK').catch(() => {})
      return errorResponse(res, 503, 'platform-treasury-prepare-unavailable')
    } finally {
      client?.release?.()
    }
  })

  router.post('/self-custody/submit', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    const auth = await authenticateOwner(req)
    if (!auth.ok) return errorResponse(res, auth.status, auth.error)
    if (!auth.config.enabled) return errorResponse(res, 503, 'self-custody-execution-disabled')
    if (!isPlainObject(req.body) || Object.keys(req.body).some((key) => !['intentId', 'signedTransaction'].includes(key))
      || !INTENT_PATTERN.test(req.body.intentId || '') || !isPlainObject(req.body.signedTransaction)) {
      return errorResponse(res, 400, 'invalid-signed-transaction-submission')
    }
    const db = getDb()
    if (!db) return errorResponse(res, 503, 'database-not-configured')
    try {
      await ensureReady(db)
      const found = await db.query(
        'SELECT * FROM trc20_token_clone.platform_treasury_withdrawals WHERE intent_id=$1 AND owner_address=$2 LIMIT 1',
        [req.body.intentId, auth.ownerAddress],
      )
      if (!found.rows.length) return errorResponse(res, 404, 'withdrawal-intent-not-found')
      const row = found.rows[0]
      if (row.status !== 'prepared') {
        return res.status(202).json({
          success: row.status === 'broadcast-accepted' || row.status === 'confirmed',
          intent: safeIntent(row),
          note: 'This intent has already left the prepared state. It will not be broadcast again.',
        })
      }
      if (new Date(row.expires_at).getTime() <= now()) {
        await db.query("UPDATE trc20_token_clone.platform_treasury_withdrawals SET status='rejected', verification_reason='unsigned-intent-expired', updated_at=now() WHERE intent_id=$1 AND status='prepared'", [req.body.intentId])
        return errorResponse(res, 409, 'withdrawal-intent-expired')
      }
      const unsignedTransaction = isPlainObject(row.unsigned_transaction)
        ? row.unsigned_transaction : JSON.parse(String(row.unsigned_transaction || '{}'))
      const signedTransaction = req.body.signedTransaction
      const tronWeb = tronWebFactory()
      if (!validateSignedSelfCustodyTransaction(tronWeb, {
        unsignedTransaction, signedTransaction, treasuryAddress: row.treasury_address,
        recipientAddress: row.recipient_address, amountBaseUnits: String(row.amount_base_units),
        tokenContract: USDT_MAINNET,
      })) return errorResponse(res, 409, 'signed-transaction-does-not-match-approved-intent')

      // Ask the Mainnet node to recover and evaluate the transaction signatures
      // against the treasury account's active TRON permission before broadcasting.
      // This supports legitimate multi-signature thresholds without handling keys.
      if (typeof tronWeb?.trx?.getSignWeight !== 'function') {
        return errorResponse(res, 503, 'tron-signature-permission-check-unavailable')
      }
      // Forward only the transaction fields required by TronWeb. Unknown
      // wallet-response fields are rejected above and never forwarded to a node.
      const broadcastTransaction = {
        txID: String(signedTransaction.txID).toLowerCase(),
        raw_data: signedTransaction.raw_data,
        raw_data_hex: signedTransaction.raw_data_hex,
        signature: signedTransaction.signature.map((signature) => signature.replace(/^0x/i, '')),
      }
      let permissionWeight
      try {
        permissionWeight = await tronWeb.trx.getSignWeight(broadcastTransaction)
      } catch {
        return errorResponse(res, 503, 'tron-signature-permission-check-unavailable')
      }
      if (!hasSufficientTronPermissionWeight(permissionWeight, row.unsigned_tx_id)) {
        return errorResponse(res, 409, 'treasury-wallet-signature-threshold-not-met')
      }

      const claimed = await db.query(
        "UPDATE trc20_token_clone.platform_treasury_withdrawals SET status='broadcasting', transaction_hash=$2, updated_at=now() WHERE intent_id=$1 AND owner_address=$3 AND status='prepared' AND expires_at > now() RETURNING intent_id",
        [req.body.intentId, String(signedTransaction.txID).toLowerCase(), auth.ownerAddress],
      )
      if (!claimed.rows.length) return errorResponse(res, 409, 'withdrawal-intent-already-claimed')
      try {
        const broadcast = await tronWeb.trx.sendRawTransaction(broadcastTransaction)
        const reportedTxId = String(broadcast?.txid || broadcast?.txID || broadcast?.transaction?.txID || '')
        if (broadcast?.result !== true || (reportedTxId && reportedTxId.toLowerCase() !== String(signedTransaction.txID).toLowerCase())) {
          await db.query("UPDATE trc20_token_clone.platform_treasury_withdrawals SET status='broadcast-unknown', verification_reason='broadcast-response-ambiguous', updated_at=now() WHERE intent_id=$1", [req.body.intentId])
          return res.status(202).json({
            success: false, status: 'broadcast-unknown', intentId: req.body.intentId,
            transactionHash: String(signedTransaction.txID).toLowerCase(),
            note: 'Broadcast outcome is ambiguous. Do not submit again; refresh chain status.',
          })
        }
        const updated = await db.query(
          "UPDATE trc20_token_clone.platform_treasury_withdrawals SET status='broadcast-accepted', verification_reason=NULL, updated_at=now() WHERE intent_id=$1 RETURNING *",
          [req.body.intentId],
        )
        return res.status(202).json({
          success: true, intent: safeIntent(updated.rows[0] || row),
          note: 'The TRON node accepted the signed transaction for broadcast. This is not solidified confirmation or exchange deposit credit.',
        })
      } catch {
        await db.query("UPDATE trc20_token_clone.platform_treasury_withdrawals SET status='broadcast-unknown', verification_reason='broadcast-outcome-unknown', updated_at=now() WHERE intent_id=$1", [req.body.intentId])
        return res.status(202).json({
          success: false, status: 'broadcast-unknown', intentId: req.body.intentId,
          transactionHash: String(signedTransaction.txID).toLowerCase(),
          note: 'The network response was unavailable after submission began. Do not submit again; refresh chain status.',
        })
      }
    } catch {
      return errorResponse(res, 503, 'platform-treasury-submit-unavailable')
    }
  })

  router.get('/self-custody/withdrawals/:intentId', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    const auth = await authenticateOwner(req)
    if (!auth.ok) return errorResponse(res, auth.status, auth.error)
    if (!INTENT_PATTERN.test(req.params.intentId || '')) return errorResponse(res, 400, 'invalid-intent-id')
    const db = getDb()
    if (!db) return errorResponse(res, 503, 'database-not-configured')
    try {
      await ensureReady(db)
      const found = await db.query(
        'SELECT * FROM trc20_token_clone.platform_treasury_withdrawals WHERE intent_id=$1 AND owner_address=$2 LIMIT 1',
        [req.params.intentId, auth.ownerAddress],
      )
      if (!found.rows.length) return errorResponse(res, 404, 'withdrawal-intent-not-found')
      let row = found.rows[0]
      let verification = { verified: false, status: row.status, reason: 'chain-verification-not-requested' }
      if (row.status === 'prepared' && new Date(row.expires_at).getTime() <= now()) {
        const expired = await db.query(
          "UPDATE trc20_token_clone.platform_treasury_withdrawals SET status='rejected', verification_reason='unsigned-intent-expired', updated_at=now() WHERE intent_id=$1 AND status='prepared' RETURNING *",
          [req.params.intentId],
        )
        if (expired.rows[0]) row = expired.rows[0]
      } else if (['broadcasting', 'broadcast-accepted', 'broadcast-unknown'].includes(row.status) && row.transaction_hash) {
        verification = await verifySolidifiedUsdtTransfer(tronWebFactory(), row)
        if (verification.verified && ['confirmed', 'failed'].includes(verification.status)) {
          const updated = await db.query(
            "UPDATE trc20_token_clone.platform_treasury_withdrawals SET status=$2, verification_reason=$3, updated_at=now() WHERE intent_id=$1 AND status NOT IN ('confirmed','failed','rejected') RETURNING *",
            [req.params.intentId, verification.status, verification.reason],
          )
          if (updated.rows[0]) row = updated.rows[0]
        }
      }
      return res.status(verification.status === 'verification-mismatch' ? 409 : 200).json({
        success: row.status === 'confirmed', intent: safeIntent(row), verification,
        exchangeCredit: 'unverified',
        note: row.status === 'confirmed'
          ? 'Exact official USDT transfer confirmed in solidified TRON state. Exchange credit remains unverified.'
          : 'Only a matching solidified receipt and official USDT Transfer event can produce confirmed status.',
      })
    } catch {
      return errorResponse(res, 503, 'platform-treasury-status-unavailable')
    }
  })

  return router
}

export { parseUsdtAmount }
export default createPlatformTreasuryRouter
