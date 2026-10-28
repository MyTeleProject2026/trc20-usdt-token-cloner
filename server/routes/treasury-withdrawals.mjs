import { createHash } from 'node:crypto'
import { Router } from 'express'
import pg from 'pg'
import { TronWeb } from 'tronweb'
import { getWalletAuthSession, normalizeDatabaseConnectionString, databaseSslConfig } from '../database.mjs'
import { isValidTronAddress } from '../tron-address.mjs'

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
    schemaPromise = (async () => {
      await db.query(`
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
      `)
      await db.query(`ALTER TABLE trc20_token_clone.treasury_withdrawal_requests DROP CONSTRAINT IF EXISTS treasury_withdrawal_requests_status_check`)
      await db.query(`ALTER TABLE trc20_token_clone.treasury_withdrawal_requests
        ADD CONSTRAINT treasury_withdrawal_requests_status_check
        CHECK (status IN ('broadcasting','broadcast-accepted','broadcast-unknown','rejected','confirmed','failed'))`)
      await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_ttc_treasury_withdrawal_tx_hash
        ON trc20_token_clone.treasury_withdrawal_requests (transaction_hash)
        WHERE transaction_hash IS NOT NULL`)
    })().catch((error) => { schemaPromise = null; throw error })
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
  const units = typeof value === 'string' ? parsePositiveDecimal(value, 6) : null
  return units !== null && units < (1n << 256n) ? units : null
}

function bearerToken(req) {
  const value = req.get('authorization') || ''
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(value)
  return match ? match[1] : ''
}

function normalizedHex(value) {
  return typeof value === 'string' ? value.replace(/^0x/i, '').toLowerCase() : ''
}

function addressHex(tronWeb, address) {
  try { return normalizedHex(tronWeb.address.toHex(address)) } catch { return '' }
}

/** Fail closed unless the unsigned/signed transaction exactly matches the approved payout. */
export function assertTreasuryPayoutTransactionIntent(tronWeb, transaction, {
  treasuryAddress,
  recipientAddress,
  amountBaseUnits,
  tokenContract = USDT_MAINNET,
} = {}) {
  if (!tronWeb || typeof tronWeb !== 'object'
    || !isValidTronAddress(treasuryAddress) || !isValidTronAddress(recipientAddress)
    || !isValidTronAddress(tokenContract)
    || !ADDRESS_PATTERN.test(treasuryAddress) || !ADDRESS_PATTERN.test(recipientAddress)
    || !ADDRESS_PATTERN.test(tokenContract)
    || typeof amountBaseUnits !== 'string' || !/^[1-9][0-9]{0,77}$/.test(amountBaseUnits)
    || BigInt(amountBaseUnits) >= (1n << 256n)
    || typeof transaction?.txID !== 'string' || !TXID_PATTERN.test(transaction.txID)
    || !Array.isArray(transaction?.raw_data?.contract)
    || transaction.raw_data.contract.length !== 1) {
    throw new Error('Treasury transfer intent is malformed.')
  }
  if (typeof transaction.raw_data_hex === 'string') {
    const raw = transaction.raw_data_hex.replace(/^0x/i, '')
    if (!/^(?:[0-9a-f]{2})+$/i.test(raw)
      || createHash('sha256').update(Buffer.from(raw, 'hex')).digest('hex') !== transaction.txID.toLowerCase()) {
      throw new Error('Treasury transaction ID does not match its raw transaction payload.')
    }
  }
  const operation = transaction.raw_data.contract[0]
  const value = operation?.parameter?.value
  const ownerHex = addressHex(tronWeb, treasuryAddress)
  const recipientHex = addressHex(tronWeb, recipientAddress)
  const tokenHex = addressHex(tronWeb, tokenContract)
  if (operation?.type !== 'TriggerSmartContract' || !ownerHex || !recipientHex || !tokenHex
    || normalizedHex(value?.owner_address) !== ownerHex
    || normalizedHex(value?.contract_address) !== tokenHex) {
    throw new Error('Treasury transaction sender or token contract does not match the approved intent.')
  }
  const receiverBytes = recipientHex.startsWith('41') ? recipientHex.slice(2) : recipientHex
  if (!/^[0-9a-f]{40}$/.test(receiverBytes)) {
    throw new Error('Treasury recipient could not be encoded safely.')
  }
  const expectedData = 'a9059cbb'
    + receiverBytes.padStart(64, '0')
    + BigInt(amountBaseUnits).toString(16).padStart(64, '0')
  if (normalizedHex(value?.data) !== expectedData) {
    throw new Error('Treasury transaction recipient or amount differs from the approved request.')
  }
  return true
}

/**
 * Verify the exact official-USDT transfer intent against a transaction from
 * TRON's confirmed node and its execution receipt. This helper is pure apart
 * from the supplied SDK's address conversion and never trusts local UI status.
 */
export function verifyTreasuryTransferEvidence(tronWeb, {
  transaction,
  transactionInfo,
  transactionHash,
  treasuryAddress,
  recipientAddress,
  amountBaseUnits,
} = {}) {
  const pending = { verified: false, status: 'awaiting-confirmed-receipt', reason: 'confirmed-transaction-or-receipt-unavailable' }
  if (!tronWeb || !TXID_PATTERN.test(transactionHash || '')
    || !ADDRESS_PATTERN.test(treasuryAddress || '')
    || !ADDRESS_PATTERN.test(recipientAddress || '')
    || typeof amountBaseUnits !== 'string' || !/^[1-9][0-9]{0,77}$/.test(amountBaseUnits)) {
    return { verified: false, status: 'verification-mismatch', reason: 'invalid-verification-input' }
  }
  const txid = String(transaction?.txID || transaction?.txid || '').toLowerCase()
  const infoId = String(transactionInfo?.id || transactionInfo?.txID || transactionInfo?.txid || '').toLowerCase()
  if (txid !== transactionHash.toLowerCase() || infoId !== transactionHash.toLowerCase()
    || !Array.isArray(transaction?.raw_data?.contract)) return pending
  const operations = transaction.raw_data.contract
  if (operations.length !== 1 || operations[0]?.type !== 'TriggerSmartContract') {
    return { verified: false, status: 'verification-mismatch', reason: 'unexpected-transaction-operation' }
  }
  let expectedOwner
  let expectedRecipient
  let expectedContract
  try {
    expectedOwner = normalizedHex(tronWeb.address.toHex(treasuryAddress))
    expectedRecipient = normalizedHex(tronWeb.address.toHex(recipientAddress))
    expectedContract = normalizedHex(tronWeb.address.toHex(USDT_MAINNET))
  } catch {
    return { verified: false, status: 'verification-mismatch', reason: 'address-encoding-failed' }
  }
  const value = operations[0]?.parameter?.value
  if (normalizedHex(value?.owner_address) !== expectedOwner
    || normalizedHex(value?.contract_address) !== expectedContract) {
    return { verified: false, status: 'verification-mismatch', reason: 'sender-or-token-contract-mismatch' }
  }
  const receiverBytes = expectedRecipient.startsWith('41') ? expectedRecipient.slice(2) : expectedRecipient
  if (!/^[0-9a-f]{40}$/.test(receiverBytes)) {
    return { verified: false, status: 'verification-mismatch', reason: 'recipient-address-encoding-invalid' }
  }
  const expectedData = 'a9059cbb' + receiverBytes.padStart(64, '0')
    + BigInt(amountBaseUnits).toString(16).padStart(64, '0')
  if (normalizedHex(value?.data) !== expectedData) {
    return { verified: false, status: 'verification-mismatch', reason: 'recipient-or-amount-mismatch' }
  }
  if (!Number.isSafeInteger(transactionInfo?.blockNumber) || transactionInfo.blockNumber < 1) return pending
  const result = transactionInfo?.receipt?.result
  if (result === 'SUCCESS') {
    return { verified: true, status: 'confirmed', reason: 'confirmed-solidified-successful-receipt', blockNumber: transactionInfo.blockNumber }
  }
  if (typeof result === 'string' && result.length > 0) {
    return { verified: true, status: 'failed', reason: 'confirmed-solidified-failed-receipt', blockNumber: transactionInfo.blockNumber }
  }
  return pending
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
  readOnlyTronWebFactory = () => new TronWeb({ fullHost: MAINNET_RPC }),
  databaseProvider = getPool,
  prepareDatabase = ensureSchema,
  now = () => new Date(),
} = {}) {
  const router = Router()

  async function authenticateOwner(req) {
    const origin = req.get('origin')
    const token = bearerToken(req)
    const expectedOwner = typeof env.TREASURY_OWNER_ADDRESS === 'string' ? env.TREASURY_OWNER_ADDRESS.trim() : ''
    if (!token || !origin || !ADDRESS_PATTERN.test(expectedOwner) || !isValidTronAddress(expectedOwner)) return { ok: false, status: 401, error: 'owner-auth-required' }
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
    const required = ['DATABASE_URL', 'TREASURY_OWNER_ADDRESS', 'TREASURY_ADDRESS', 'TREASURY_PRIVATE_KEY', 'TREASURY_MAX_PAYOUT_USDT', 'TREASURY_DAILY_LIMIT_USDT', 'TREASURY_FEE_LIMIT_SUN', 'TREASURY_MIN_TRX_RESERVE']
    const missing = required.filter((key) => typeof env[key] !== 'string' || !env[key].trim())
    const enabled = env.TREASURY_WITHDRAWALS_ENABLED === 'true'
      && env.TREASURY_SIGNER_MODE === 'env-hot-wallet'
      && missing.length === 0
      && ADDRESS_PATTERN.test(env.TREASURY_OWNER_ADDRESS || '')
      && isValidTronAddress(env.TREASURY_OWNER_ADDRESS || '')
      && ADDRESS_PATTERN.test(env.TREASURY_ADDRESS || '')
      && isValidTronAddress(env.TREASURY_ADDRESS || '')
      && env.TREASURY_OWNER_ADDRESS.trim() !== env.TREASURY_ADDRESS.trim()
      && Boolean(readLimit(env.TREASURY_MAX_PAYOUT_USDT))
      && Boolean(readLimit(env.TREASURY_DAILY_LIMIT_USDT))
      && Boolean(readLimit(env.TREASURY_MIN_TRX_RESERVE))
      && /^\d+$/.test(env.TREASURY_FEE_LIMIT_SUN || '')
      && Number.isSafeInteger(Number(env.TREASURY_FEE_LIMIT_SUN))
      && Number(env.TREASURY_FEE_LIMIT_SUN) >= 1
      && Number(env.TREASURY_FEE_LIMIT_SUN) <= 100_000_000
    return { enabled, missing, signerMode: env.TREASURY_SIGNER_MODE === 'env-hot-wallet' ? 'env-hot-wallet' : 'not-configured' }
  }

  router.get('/withdrawals/readiness', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    const auth = await authenticateOwner(req)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const config = configuration()
    const db = databaseProvider(env)
    let databaseReady = false
    if (db) {
      try { await prepareDatabase(db); await db.query('SELECT 1'); databaseReady = true } catch {}
    }
    // Treasury identity is separate from the owner identity. Verify the secret key
    // derives exactly the explicitly configured public treasury address.
    let treasuryAddress = null
    let signerMatchesConfiguredAddress = false
    if (config.enabled) {
      try {
        const tronWeb = tronWebFactory(env.TREASURY_PRIVATE_KEY.trim())
        treasuryAddress = tronWeb.address.fromPrivateKey(env.TREASURY_PRIVATE_KEY.trim())
        signerMatchesConfiguredAddress = ADDRESS_PATTERN.test(treasuryAddress)
          && treasuryAddress === env.TREASURY_ADDRESS.trim()
      } catch {}
    }
    let usdtBalance = null
    let treasuryTrxBalanceSun = null
    const minimumTrxReserveSun = readLimit(env.TREASURY_MIN_TRX_RESERVE)
    const configuredFeeLimitSun = /^\d+$/.test(env.TREASURY_FEE_LIMIT_SUN || '')
      ? BigInt(env.TREASURY_FEE_LIMIT_SUN) : null
    const requiredTrxBalanceSun = minimumTrxReserveSun !== null && configuredFeeLimitSun !== null
      ? minimumTrxReserveSun + configuredFeeLimitSun : null
    if (databaseReady && config.enabled && signerMatchesConfiguredAddress) {
      try {
        const tronWeb = tronWebFactory(env.TREASURY_PRIVATE_KEY.trim())
        const contract = await tronWeb.contract(ABI).at(USDT_MAINNET)
        const [decimals, symbol, rawUsdtBalance, rawTrxBalance] = await Promise.all([
          contract.decimals().call(),
          contract.symbol().call(),
          contract.balanceOf(treasuryAddress).call(),
          tronWeb.trx.getBalance(treasuryAddress),
        ])
        const usdtText = String(rawUsdtBalance)
        const trxText = String(rawTrxBalance)
        if (Number(decimals) === 6 && String(symbol).toUpperCase() === 'USDT'
          && /^(0|[1-9][0-9]*)$/.test(usdtText) && /^(0|[1-9][0-9]*)$/.test(trxText)) {
          usdtBalance = usdtText
          treasuryTrxBalanceSun = trxText
        }
      } catch {}
    }
    const nativeFeeReserveSatisfied = treasuryTrxBalanceSun !== null
      && requiredTrxBalanceSun !== null
      && BigInt(treasuryTrxBalanceSun) >= requiredTrxBalanceSun
    return res.json({
      success: true,
      network: 'mainnet',
      asset: 'USDT',
      tokenContract: USDT_MAINNET,
      withdrawalsEnabled: config.enabled && databaseReady && signerMatchesConfiguredAddress
        && usdtBalance !== null && nativeFeeReserveSatisfied,
      configuration: { enabled: config.enabled, missing: config.missing, signerMode: config.signerMode },
      databaseReady,
      treasuryAddress,
      signerMatchesConfiguredAddress,
      treasuryUsdtBalanceBaseUnits: usdtBalance,
      treasuryTrxBalanceSun,
      minimumTrxReserveSun: minimumTrxReserveSun?.toString() || null,
      requiredTrxBalanceSun: requiredTrxBalanceSun?.toString() || null,
      nativeFeeReserveSatisfied,
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
    if (!amount || amount >= (1n << 256n) || !maxPayout || !dailyLimit || amount > maxPayout || amount > dailyLimit) {
      return res.status(400).json({ success: false, error: 'amount-outside-configured-limits' })
    }
    const db = databaseProvider(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })
    try {
      await prepareDatabase(db)
      // Check an existing idempotency key before current funding checks: a retry of
      // a payout that already consumed USDT must return the original record, not a
      // misleading "insufficient balance" response or a second attempted send.
      const previous = await db.query(
        'SELECT * FROM trc20_token_clone.treasury_withdrawal_requests WHERE idempotency_key = $1',
        [body.idempotencyKey],
      )
      if (previous.rows.length) {
        const prior = previous.rows[0]
        if (prior.owner_address !== auth.ownerAddress
          || prior.recipient_address !== body.recipientAddress
          || String(prior.amount_base_units) !== amount.toString()
          || prior.treasury_address !== String(env.TREASURY_ADDRESS || '').trim()
          || prior.token_contract !== USDT_MAINNET) {
          return res.status(409).json({ success: false, error: 'idempotency-key-conflict' })
        }
        return res.status(200).json({ success: true, duplicate: true, withdrawal: safeStatus(prior), note: 'Existing request returned; no second transfer was broadcast.' })
      }
      const tronWeb = tronWebFactory(env.TREASURY_PRIVATE_KEY.trim())
      const treasuryAddress = tronWeb.address.fromPrivateKey(env.TREASURY_PRIVATE_KEY.trim())
      if (!tronWeb.isAddress(body.recipientAddress) || !isValidTronAddress(body.recipientAddress)
        || !ADDRESS_PATTERN.test(treasuryAddress) || !isValidTronAddress(treasuryAddress)
        || treasuryAddress !== env.TREASURY_ADDRESS.trim()
        || treasuryAddress === body.recipientAddress) {
        return res.status(503).json({ success: false, error: 'invalid-treasury-or-recipient' })
      }
      const configuredFeeLimit = Number(env.TREASURY_FEE_LIMIT_SUN)
      const minimumTrxReserveSun = readLimit(env.TREASURY_MIN_TRX_RESERVE)
      const contract = await tronWeb.contract(ABI).at(USDT_MAINNET)
      const [decimals, symbol, balanceValue, trxBalanceValue] = await Promise.all([
        contract.decimals().call(), contract.symbol().call(), contract.balanceOf(treasuryAddress).call(),
        tronWeb.trx.getBalance(treasuryAddress),
      ])
      if (Number(decimals) !== 6 || String(symbol).toUpperCase() !== 'USDT') {
        return res.status(503).json({ success: false, error: 'official-token-metadata-check-failed' })
      }
      const balanceText = String(balanceValue)
      const trxBalanceText = String(trxBalanceValue)
      if (!/^(0|[1-9][0-9]*)$/.test(balanceText) || !/^(0|[1-9][0-9]*)$/.test(trxBalanceText)
        || !minimumTrxReserveSun) {
        return res.status(503).json({ success: false, error: 'treasury-balance-read-invalid' })
      }
      const balance = BigInt(balanceText)
      if (balance < amount) return res.status(409).json({ success: false, error: 'treasury-usdt-insufficient', treasuryUsdtBalanceBaseUnits: balance.toString() })
      const requiredTrx = minimumTrxReserveSun + BigInt(configuredFeeLimit)
      if (BigInt(trxBalanceText) < requiredTrx) {
        return res.status(409).json({ success: false, error: 'treasury-trx-fee-reserve-insufficient', treasuryTrxBalanceSun: trxBalanceText, requiredTrxBalanceSun: requiredTrx.toString() })
      }

      const client = await db.connect()
      let reservation
      try {
        await client.query('BEGIN')
        await client.query("SELECT pg_advisory_xact_lock(hashtext('tron-token-studio-treasury-withdrawals-mainnet'))")
        const existing = await client.query('SELECT * FROM trc20_token_clone.treasury_withdrawal_requests WHERE idempotency_key = $1 FOR UPDATE', [body.idempotencyKey])
        if (existing.rows.length) {
          const existingRow = existing.rows[0]
          await client.query('COMMIT')
          if (existingRow.owner_address !== auth.ownerAddress
            || existingRow.recipient_address !== body.recipientAddress
            || String(existingRow.amount_base_units) !== amount.toString()
            || existingRow.treasury_address !== treasuryAddress
            || existingRow.token_contract !== USDT_MAINNET) {
            return res.status(409).json({ success: false, error: 'idempotency-key-conflict', note: 'This idempotency key already identifies a different payout. Use a new key only for a genuinely new, separate payout.' })
          }
          return res.status(200).json({ success: true, duplicate: true, withdrawal: safeStatus(existingRow), note: 'Existing request returned; no second transfer was broadcast.' })
        }
        const spent = await client.query(`
          SELECT COALESCE(SUM(amount_base_units), 0)::text AS amount
            FROM trc20_token_clone.treasury_withdrawal_requests
           WHERE created_at >= (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
             AND status <> 'rejected'
        `)
        const alreadyReserved = BigInt(spent.rows[0]?.amount || '0')
        if (alreadyReserved + amount > dailyLimit) {
          await client.query('ROLLBACK')
          return res.status(429).json({ success: false, error: 'treasury-daily-limit-exceeded' })
        }
        const activeReservations = await client.query(`
          SELECT COALESCE(SUM(amount_base_units), 0)::text AS amount
            FROM trc20_token_clone.treasury_withdrawal_requests
           WHERE status IN ('broadcasting','broadcast-accepted','broadcast-unknown')
        `)
        const outstanding = BigInt(activeReservations.rows[0]?.amount || '0')
        // Refresh chain balances while holding the global payout lock, so another
        // payout or external treasury spend cannot consume funds reserved by this request.
        const [freshUsdtBalance, freshTrxBalance] = await Promise.all([
          contract.balanceOf(treasuryAddress).call(),
          tronWeb.trx.getBalance(treasuryAddress),
        ])
        const freshUsdtText = String(freshUsdtBalance)
        const freshTrxText = String(freshTrxBalance)
        if (!/^(0|[1-9][0-9]*)$/.test(freshUsdtText) || !/^(0|[1-9][0-9]*)$/.test(freshTrxText)) {
          await client.query('ROLLBACK')
          return res.status(503).json({ success: false, error: 'treasury-balance-refresh-failed' })
        }
        const currentBalance = BigInt(freshUsdtText)
        if (outstanding + amount > currentBalance) {
          await client.query('ROLLBACK')
          return res.status(409).json({ success: false, error: 'treasury-usdt-reserved-for-pending-withdrawals', availableForNewWithdrawalBaseUnits: (currentBalance > outstanding ? currentBalance - outstanding : 0n).toString() })
        }
        const freshRequiredTrx = minimumTrxReserveSun + BigInt(configuredFeeLimit)
        if (BigInt(freshTrxText) < freshRequiredTrx) {
          await client.query('ROLLBACK')
          return res.status(409).json({ success: false, error: 'treasury-trx-fee-reserve-insufficient', treasuryTrxBalanceSun: freshTrxText, requiredTrxBalanceSun: freshRequiredTrx.toString() })
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

      let unsignedTransaction
      let signedTransaction
      let txid
      try {
        const built = await tronWeb.transactionBuilder.triggerSmartContract(
          USDT_MAINNET,
          'transfer(address,uint256)',
          { feeLimit: configuredFeeLimit, callValue: 0 },
          [
            { type: 'address', value: body.recipientAddress },
            { type: 'uint256', value: amount.toString() },
          ],
          treasuryAddress,
        )
        if (built?.result?.result !== true || !built?.transaction) {
          throw new Error('transaction-build-failed')
        }
        unsignedTransaction = built.transaction
        assertTreasuryPayoutTransactionIntent(tronWeb, unsignedTransaction, {
          treasuryAddress, recipientAddress: body.recipientAddress, amountBaseUnits: amount.toString(),
        })
        signedTransaction = await tronWeb.trx.sign(unsignedTransaction, env.TREASURY_PRIVATE_KEY.trim())
        if (!signedTransaction || !Array.isArray(signedTransaction.signature)
          || signedTransaction.signature.length < 1 || signedTransaction.txID !== unsignedTransaction.txID) {
          throw new Error('transaction-signing-failed')
        }
        assertTreasuryPayoutTransactionIntent(tronWeb, signedTransaction, {
          treasuryAddress, recipientAddress: body.recipientAddress, amountBaseUnits: amount.toString(),
        })
        txid = unsignedTransaction.txID
      } catch {
        await db.query(\`UPDATE trc20_token_clone.treasury_withdrawal_requests
          SET status='rejected', failure_code='transaction-build-or-sign-failed', updated_at=now()
          WHERE id=$1 AND status='broadcasting'\`, [reservation.id]).catch(() => {})
        return res.status(503).json({ success: false, error: 'treasury-transaction-build-or-sign-failed', note: 'No transaction was broadcast.' })
      }

      // Record the locally computed transaction ID before broadcasting, so ambiguous
      // network outcomes can be reconciled without creating a second payout.
      const persisted = await db.query(\`UPDATE trc20_token_clone.treasury_withdrawal_requests
        SET transaction_hash=$2, updated_at=now()
        WHERE id=$1 AND status='broadcasting' RETURNING id\`, [reservation.id, txid])
      if (!persisted.rows.length) {
        return res.status(503).json({ success: false, error: 'transaction-id-not-persisted', note: 'No broadcast was attempted.' })
      }
      let broadcast
      try {
        broadcast = await tronWeb.trx.sendRawTransaction(signedTransaction)
      } catch {
        await db.query(\`UPDATE trc20_token_clone.treasury_withdrawal_requests
          SET status='broadcast-unknown', failure_code='broadcast-outcome-unknown', updated_at=now()
          WHERE id=$1 AND status='broadcasting'\`, [reservation.id]).catch(() => {})
        return res.status(202).json({
          success: false, status: 'broadcast-unknown', idempotencyKey: body.idempotencyKey,
          transactionHash: txid, error: 'broadcast-outcome-unknown',
          note: 'The outcome is ambiguous. Verify the stored transaction hash; do not create a replacement request.',
        })
      }
      const reportedTxid = typeof broadcast?.txid === 'string' ? broadcast.txid
        : typeof broadcast?.txID === 'string' ? broadcast.txID : ''
      if (broadcast?.result !== true || (reportedTxid && reportedTxid.toLowerCase() !== txid.toLowerCase())) {
        await db.query(\`UPDATE trc20_token_clone.treasury_withdrawal_requests
          SET status='broadcast-unknown', failure_code=$2, updated_at=now()
          WHERE id=$1 AND status='broadcasting'\`, [
            reservation.id,
            reportedTxid && reportedTxid.toLowerCase() !== txid.toLowerCase()
              ? 'broadcast-response-id-mismatch' : 'broadcast-outcome-unknown',
          ]).catch(() => {})
        return res.status(202).json({
          success: false, status: 'broadcast-unknown', idempotencyKey: body.idempotencyKey,
          transactionHash: txid, error: 'broadcast-outcome-unknown',
          note: 'The node response did not safely confirm acceptance; reconcile the persisted transaction hash. Do not retry with a new key.',
        })
      }
      const updated = await db.query(\`UPDATE trc20_token_clone.treasury_withdrawal_requests
        SET status='broadcast-accepted', updated_at=now()
        WHERE id=$1 AND status='broadcasting' RETURNING *\`, [reservation.id])
      if (!updated.rows.length) {
        return res.status(202).json({ success: false, status: 'broadcast-unknown', idempotencyKey: body.idempotencyKey, transactionHash: txid })
      }
      return res.status(202).json({
        success: true, status: 'broadcast-accepted', withdrawal: safeStatus(updated.rows[0]),
        note: 'The node accepted the signed transaction. Verify the solidified receipt before treating it as confirmed.',
      })

    } catch {
      return res.status(503).json({ success: false, error: 'treasury-withdrawal-unavailable' })
    }
  })

  router.post('/withdrawals/:idempotencyKey/verify', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    const auth = await authenticateOwner(req)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const key = req.params.idempotencyKey
    if (!IDEMPOTENCY_PATTERN.test(key || '')) return res.status(400).json({ success: false, error: 'invalid-idempotency-key' })
    const db = databaseProvider(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })
    try {
      await prepareDatabase(db)
      const lookup = await db.query(
        'SELECT * FROM trc20_token_clone.treasury_withdrawal_requests WHERE idempotency_key = $1 AND owner_address = $2',
        [key, auth.ownerAddress],
      )
      if (!lookup.rows.length) return res.status(404).json({ success: false, error: 'withdrawal-not-found' })
      const row = lookup.rows[0]
      if (row.status === 'confirmed' || row.status === 'failed') {
        return res.json({ success: true, withdrawal: safeStatus(row), verification: { verified: true, status: row.status, reason: 'previously-verified-solidified-receipt' } })
      }
      const txid = typeof row.transaction_hash === 'string' ? row.transaction_hash.trim() : ''
      if (!TXID_PATTERN.test(txid)) {
        return res.status(409).json({ success: false, error: 'transaction-hash-not-available', withdrawal: safeStatus(row) })
      }
      const tronWeb = readOnlyTronWebFactory()
      const [transaction, transactionInfo] = await Promise.all([
        tronWeb.trx.getConfirmedTransaction(txid).catch(() => null),
        tronWeb.trx.getTransactionInfo(txid).catch(() => null),
      ])
      const evidence = verifyTreasuryTransferEvidence(tronWeb, {
        transaction, transactionInfo, transactionHash: txid,
        treasuryAddress: row.treasury_address,
        recipientAddress: row.recipient_address,
        amountBaseUnits: String(row.amount_base_units),
      })
      if (evidence.status === 'confirmed' || evidence.status === 'failed') {
        const updated = await db.query(
          `UPDATE trc20_token_clone.treasury_withdrawal_requests
              SET status = $2, failure_code = $3, updated_at = now()
            WHERE id = $1 AND status NOT IN ('confirmed','failed')
            RETURNING *`,
          [row.id, evidence.status, evidence.status === 'failed' ? evidence.reason : null],
        )
        const saved = updated.rows[0] || row
        return res.json({ success: evidence.status === 'confirmed', withdrawal: safeStatus(saved), verification: evidence })
      }
      return res.status(evidence.status === 'verification-mismatch' ? 409 : 202).json({
        success: false, withdrawal: safeStatus(row), verification: evidence,
        note: 'No confirmation is inferred from a transaction hash alone. Retry verification after the transaction is indexed/solidified.',
      })
    } catch {
      return res.status(503).json({ success: false, error: 'treasury-withdrawal-verification-unavailable' })
    }
  })

  router.get('/withdrawals/:idempotencyKey', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    const auth = await authenticateOwner(req)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    if (!IDEMPOTENCY_PATTERN.test(req.params.idempotencyKey || '')) return res.status(400).json({ success: false, error: 'invalid-idempotency-key' })
    const db = databaseProvider(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })
    try {
      await prepareDatabase(db)
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

export default createTreasuryWithdrawalsRouter
