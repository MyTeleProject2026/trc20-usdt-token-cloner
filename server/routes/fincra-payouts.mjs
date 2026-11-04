import { createHash } from 'node:crypto'
import { Router } from 'express'
import pg from 'pg'
import { TronWeb } from 'tronweb'
import { createFincraClient, fincraConfiguration } from '../fincra-client.mjs'
import { getWalletAuthSession, normalizeDatabaseConnectionString, databaseSslConfig } from '../database.mjs'
import {
  buildFincraPayoutAuthorizationMessage,
  OFFICIAL_TRON_MAINNET_USDT,
  isFincraPayoutAuthorizationExpiryValid,
} from '../../src/fincra-payout-auth.mjs'

const { Pool } = pg
const TATUM_TRON_MAINNET_GATEWAY = 'https://tron-mainnet.gateway.tatum.io'
const REAL_VALUE_PAYOUT_EXECUTION_DISABLED = true
const ADDRESS_PATTERN = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const TXID_PATTERN = /^[0-9a-f]{64}$/i
const CUSTOMER_REFERENCE_PATTERN = /^[A-Za-z0-9._:-]{12,128}$/
const SIGNATURE_PATTERN = /^0x[0-9a-f]{130}$/i
const UINT256_MAX = (1n << 256n) - 1n
const AUTHORIZATION_MAX_FUTURE_MS = 120_000
const TRANSFER_TOPIC = 'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const TRANSFER_SELECTOR = 'a9059cbb'

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
  pool.on('error', (error) => console.error('Fincra payout database error:', error?.code || 'unknown'))
  return pool
}

async function ensureSchema(db) {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await db.query('CREATE SCHEMA IF NOT EXISTS trc20_token_clone')
      await db.query("CREATE TABLE IF NOT EXISTS trc20_token_clone.fincra_usdt_trc20_payouts (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, customer_reference TEXT NOT NULL UNIQUE, owner_address TEXT NOT NULL, recipient_address TEXT NOT NULL, beneficiary_name TEXT NOT NULL, token_contract TEXT NOT NULL, amount_base_units NUMERIC(78,0) NOT NULL CHECK (amount_base_units > 0), source_currency TEXT NOT NULL CHECK (source_currency = 'USDT'), provider_status TEXT, status TEXT NOT NULL CHECK (status IN ('reserved','provider-pending','provider-successful-awaiting-chain','provider-failed','submission-unknown','chain-confirmed','chain-failed')), provider_reference TEXT, provider_payout_id TEXT, transaction_hash CHAR(64), failure_code TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())")
      await db.query('CREATE INDEX IF NOT EXISTS fincra_usdt_trc20_payouts_owner_created_idx ON trc20_token_clone.fincra_usdt_trc20_payouts (owner_address, created_at DESC)')
    })().catch((error) => { schemaPromise = null; throw error })
  }
  await schemaPromise
}

function parsePositiveUsdt(value) {
  if (typeof value !== 'string' || value.length > 86
    || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/.test(value)) return null
  const [whole, fraction = ''] = value.split('.')
  if (whole.length > 78) return null
  try {
    const units = BigInt(whole) * 1_000_000n + BigInt((fraction + '000000').slice(0, 6))
    return units > 0n && units <= UINT256_MAX ? units : null
  } catch {
    return null
  }
}

function normalizeHex(value) {
  return typeof value === 'string' ? value.replace(/^0x/i, '').toLowerCase() : ''
}

function bearerToken(req) {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.get('authorization') || '')
  return match ? match[1] : ''
}

function mapProviderStatus(value) {
  const status = typeof value === 'string' ? value.toLowerCase() : ''
  if (status === 'successful' || status === 'success') return 'provider-successful-awaiting-chain'
  if (status === 'failed' || status === 'failure') return 'provider-failed'
  return 'provider-pending'
}

function safeStatus(row) {
  return {
    customerReference: row.customer_reference,
    network: 'mainnet',
    asset: 'USDT',
    scheme: 'usdt_trc20',
    tokenContract: OFFICIAL_TRON_MAINNET_USDT,
    recipientAddress: row.recipient_address,
    beneficiaryName: row.beneficiary_name,
    amountBaseUnits: String(row.amount_base_units),
    status: row.status,
    ...(row.provider_status ? { providerStatus: row.provider_status } : {}),
    ...(row.provider_reference ? { providerReference: row.provider_reference } : {}),
    ...(row.provider_payout_id ? { providerPayoutId: row.provider_payout_id } : {}),
    ...(row.transaction_hash ? { transactionHash: String(row.transaction_hash).trim() } : {}),
    ...(row.failure_code ? { failureCode: row.failure_code } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function extractTransactionHash(data) {
  const candidates = [data?.transactionHash, data?.txHash, data?.blockchainTransactionHash, data?.networkTransactionHash]
  return candidates.find((value) => typeof value === 'string' && TXID_PATTERN.test(value)) || null
}

export function verifyFincraUsdtTrc20Evidence(tronWeb, {
  transaction, transactionInfo, transactionHash, recipientAddress, amountBaseUnits,
} = {}) {
  const pending = { verified: false, status: 'awaiting-solidified-receipt', reason: 'confirmed-transaction-or-receipt-unavailable' }
  if (!tronWeb || !TXID_PATTERN.test(transactionHash || '')
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
  let expectedRecipient
  let expectedContract
  try {
    expectedRecipient = normalizeHex(tronWeb.address.toHex(recipientAddress))
    expectedContract = normalizeHex(tronWeb.address.toHex(OFFICIAL_TRON_MAINNET_USDT))
  } catch {
    return { verified: false, status: 'verification-mismatch', reason: 'address-encoding-failed' }
  }
  const value = operations[0]?.parameter?.value
  if (normalizeHex(value?.contract_address) !== expectedContract) {
    return { verified: false, status: 'verification-mismatch', reason: 'non-official-token-contract' }
  }
  const transactionOwner = normalizeHex(value?.owner_address)
  const ownerBytes = transactionOwner.startsWith('41') ? transactionOwner.slice(2) : transactionOwner
  if (!/^[0-9a-f]{40}$/.test(ownerBytes)) {
    return { verified: false, status: 'verification-mismatch', reason: 'transaction-owner-address-invalid' }
  }
  const recipientBytes = expectedRecipient.startsWith('41') ? expectedRecipient.slice(2) : expectedRecipient
  if (!/^[0-9a-f]{40}$/.test(recipientBytes)) {
    return { verified: false, status: 'verification-mismatch', reason: 'recipient-address-encoding-invalid' }
  }
  const expectedCallData = TRANSFER_SELECTOR + recipientBytes.padStart(64, '0')
    + BigInt(amountBaseUnits).toString(16).padStart(64, '0')
  if (normalizeHex(value?.data) !== expectedCallData) {
    return { verified: false, status: 'verification-mismatch', reason: 'recipient-or-amount-mismatch' }
  }
  if (!Number.isSafeInteger(transactionInfo?.blockNumber) || transactionInfo.blockNumber < 1) return pending
  if (transactionInfo?.receipt?.result !== 'SUCCESS') {
    if (typeof transactionInfo?.receipt?.result === 'string' && transactionInfo.receipt.result) {
      return { verified: true, status: 'failed', reason: 'solidified-transaction-failed', blockNumber: transactionInfo.blockNumber }
    }
    return pending
  }
  const contractAddress = expectedContract.replace(/^41(?=[0-9a-f]{40}$)/, '')
  const toTopic = recipientBytes.padStart(64, '0')
  const expectedData = BigInt(amountBaseUnits).toString(16).padStart(64, '0')
  const transferLogs = (Array.isArray(transactionInfo?.log) ? transactionInfo.log : []).filter((log) =>
    normalizeHex(log?.address).replace(/^41(?=[0-9a-f]{40}$)/, '') === contractAddress
    && Array.isArray(log?.topics)
    && normalizeHex(log.topics[0]) === TRANSFER_TOPIC)
  const exactEvents = transferLogs.filter((log) =>
    log.topics.length >= 3
    && normalizeHex(log.topics[1]).padStart(64, '0') === ownerBytes.padStart(64, '0')
    && normalizeHex(log.topics[2]).padStart(64, '0') === toTopic
    && normalizeHex(log.data).padStart(64, '0') === expectedData)
  if (transferLogs.length !== 1 || exactEvents.length !== 1) {
    return { verified: false, status: 'verification-mismatch', reason: 'official-usdt-transfer-event-missing-or-mismatched' }
  }
  return {
    verified: true,
    status: 'confirmed',
    reason: 'solidified-official-usdt-transfer-to-exact-recipient-and-amount',
    blockNumber: transactionInfo.blockNumber,
  }
}

export function createFincraPayoutRouter({
  env = process.env,
  sessionLookup = getWalletAuthSession,
  fincraClientFactory = (currentEnv) => createFincraClient({ env: currentEnv }),
  tronWebFactory = () => new TronWeb({
    fullHost: TATUM_TRON_MAINNET_GATEWAY,
    ...(typeof env.TATUM_API_KEY === 'string' && env.TATUM_API_KEY.trim()
      ? { headers: { 'x-api-key': env.TATUM_API_KEY.trim() } }
      : {}),
  }),
  now = () => Date.now(),
} = {}) {
  const router = Router()
  const client = () => fincraClientFactory(env)

  async function authenticateOwner(req) {
    const origin = req.get('origin')
    const token = bearerToken(req)
    const expectedOwner = typeof env.TREASURY_OWNER_ADDRESS === 'string' ? env.TREASURY_OWNER_ADDRESS.trim() : ''
    const consoleOwner = typeof env.OWNER_WALLET_ADDRESS === 'string' ? env.OWNER_WALLET_ADDRESS.trim() : ''
    if (!token || !origin || !ADDRESS_PATTERN.test(expectedOwner)) return { ok: false, status: 401, error: 'owner-auth-required' }
    if (!ADDRESS_PATTERN.test(consoleOwner) || consoleOwner !== expectedOwner) {
      return { ok: false, status: 503, error: 'owner-address-configuration-mismatch' }
    }
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
    const config = fincraConfiguration(env)
    const tatumConfigured = typeof env.TATUM_API_KEY === 'string' && env.TATUM_API_KEY.trim().length > 0
    const maxPayoutConfigured = parsePositiveUsdt(env.FINCRA_MAX_PAYOUT_USDT) !== null
    const dailyLimitConfigured = parsePositiveUsdt(env.FINCRA_DAILY_LIMIT_USDT) !== null
    return {
      ...config,
      tatumConfigured,
      sourceCurrencySupported: config.sourceCurrency === 'USDT',
      maxPayoutConfigured,
      dailyLimitConfigured,
    }
  }

  async function verifyOwnerSignature(tronWeb, message, signature, ownerAddress) {
    if (!SIGNATURE_PATTERN.test(signature || '')
      || typeof tronWeb?.trx?.verifyMessageV2 !== 'function') return false
    try { return await tronWeb.trx.verifyMessageV2(message, signature) === ownerAddress } catch { return false }
  }

  async function refreshProviderStatus(db, row) {
    if (!row || ['provider-failed', 'chain-confirmed', 'chain-failed'].includes(row.status)) return row
    try {
      const response = await client().getPayoutByCustomerReference(row.customer_reference)
      const data = response?.data || response
      const nextStatus = mapProviderStatus(data?.status)
      const txHash = extractTransactionHash(data)
      const updated = await db.query(
        'UPDATE trc20_token_clone.fincra_usdt_trc20_payouts SET status=$2, provider_status=$3, provider_reference=COALESCE($4, provider_reference), provider_payout_id=COALESCE($5, provider_payout_id), transaction_hash=COALESCE($6, transaction_hash), updated_at=now() WHERE id=$1 RETURNING *',
        [row.id, nextStatus, typeof data?.status === 'string' ? data.status.slice(0, 64) : null,
          typeof data?.reference === 'string' ? data.reference.slice(0, 128) : null,
          data?.id == null ? null : String(data.id).slice(0, 128), txHash],
      )
      return updated.rows[0] || row
    } catch { return row }
  }

  router.get('/withdrawals/readiness', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    const auth = await authenticateOwner(req)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const config = configuration()
    const db = getPool(env)
    let databaseReady = false
    if (db) { try { await ensureSchema(db); await db.query('SELECT 1'); databaseReady = true } catch {} }
    const blockers = []
    if (!config.configured) blockers.push('fincra-configuration-incomplete')
    if (!config.sourceCurrencySupported) blockers.push('fincra-source-currency-must-be-usdt')
    if (!config.tatumConfigured) blockers.push('tatum-api-key-missing')
    if (!config.maxPayoutConfigured) blockers.push('fincra-max-payout-limit-missing-or-invalid')
    if (!config.dailyLimitConfigured) blockers.push('fincra-daily-limit-missing-or-invalid')
    if (!databaseReady) blockers.push('database-not-ready')
    if (!config.enabledFlag) blockers.push('fincra-payouts-disabled')
    if (config.environment === 'live' && REAL_VALUE_PAYOUT_EXECUTION_DISABLED) blockers.push('real-value-payout-execution-disabled-in-this-build')
    const sandboxReady = config.environment === 'sandbox' && config.configured
      && config.sourceCurrencySupported && config.tatumConfigured && config.maxPayoutConfigured
      && config.dailyLimitConfigured && databaseReady && config.enabledFlag
    return res.json({
      success: true,
      network: 'mainnet',
      asset: 'USDT',
      tokenContract: OFFICIAL_TRON_MAINNET_USDT,
      provider: 'fincra',
      paymentDestination: 'crypto_wallet',
      paymentScheme: 'usdt_trc20',
      providerEnvironment: config.environment,
      sourceCurrency: config.sourceCurrency,
      configuration: {
        configured: config.configured,
        missing: config.missing,
        sourceCurrencySupported: config.sourceCurrencySupported,
        tatumConfigured: config.tatumConfigured,
        maxPayoutConfigured: config.maxPayoutConfigured,
        dailyLimitConfigured: config.dailyLimitConfigured,
        featureFlagEnabled: config.enabledFlag,
      },
      databaseReady,
      fundingVerified: false,
      livePayoutExecutionEnabled: false,
      sandboxSubmissionEnabled: sandboxReady,
      withdrawalsEnabled: sandboxReady,
      preflightChecksPassed: sandboxReady,
      payoutBlockers: [...new Set(blockers)],
      limitations: [
        'Fincra must enable live USDT stablecoin payouts for the merchant business.',
        'This readiness endpoint does not verify the Fincra source-wallet balance; funding must be confirmed in the authorized Fincra account.',
        'A provider successful status is not an on-chain confirmation. Tatum verifies the exact Mainnet USDT transfer receipt and recipient event before the app reports chain-confirmed.',
        'An exchange deposit credit is controlled by the receiving exchange and is not proven by a TRON transaction receipt.',
      ],
    })
  })

  router.post('/withdrawals', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    const auth = await authenticateOwner(req)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const config = configuration()
    if (!config.configured || !config.enabledFlag || !config.sourceCurrencySupported || !config.tatumConfigured) {
      return res.status(503).json({ success: false, error: 'fincra-payout-not-enabled', missing: config.missing })
    }
    if (config.environment === 'live' && REAL_VALUE_PAYOUT_EXECUTION_DISABLED) {
      return res.status(503).json({ success: false, error: 'real-value-payout-execution-disabled-in-this-build', submissionEnabled: false })
    }
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
    const allowed = ['recipientAddress', 'accountHolderName', 'email', 'amountUsdt', 'idempotencyKey', 'ownerAuthorizationSignature', 'authorizationExpiresAt']
    if (Object.keys(body).some((key) => !allowed.includes(key))
      || !ADDRESS_PATTERN.test(body.recipientAddress || '')
      || typeof body.accountHolderName !== 'string' || !body.accountHolderName.trim()
      || body.accountHolderName.trim().length > 120
      || !CUSTOMER_REFERENCE_PATTERN.test(body.idempotencyKey || '')
      || typeof body.amountUsdt !== 'string'
      || typeof body.ownerAuthorizationSignature !== 'string' || !SIGNATURE_PATTERN.test(body.ownerAuthorizationSignature)
      || !Number.isSafeInteger(body.authorizationExpiresAt)
      || (body.email != null && (typeof body.email !== 'string' || body.email.length > 254))) {
      return res.status(400).json({ success: false, error: 'invalid-fincra-payout-request' })
    }
    const amount = parsePositiveUsdt(body.amountUsdt)
    if (!amount) return res.status(400).json({ success: false, error: 'invalid-usdt-amount' })
    const maxPayout = parsePositiveUsdt(env.FINCRA_MAX_PAYOUT_USDT)
    const dailyLimit = parsePositiveUsdt(env.FINCRA_DAILY_LIMIT_USDT)
    if (!maxPayout || !dailyLimit) return res.status(503).json({ success: false, error: 'fincra-payout-limits-not-configured' })
    if (amount > maxPayout || amount > dailyLimit) return res.status(400).json({ success: false, error: 'amount-outside-configured-limits' })
    const nowValue = Number(now())
    if (!isFincraPayoutAuthorizationExpiryValid(body.authorizationExpiresAt, nowValue, AUTHORIZATION_MAX_FUTURE_MS)) {
      return res.status(401).json({ success: false, error: 'owner-payout-authorization-expired-or-outside-window' })
    }
    const db = getPool(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })
    try {
      await ensureSchema(db)
      const tronWeb = tronWebFactory()
      if (!tronWeb?.isAddress?.(body.recipientAddress)) return res.status(400).json({ success: false, error: 'invalid-tron-recipient-address' })
      const message = buildFincraPayoutAuthorizationMessage({
        origin: req.get('origin'),
        ownerAddress: auth.ownerAddress,
        recipientAddress: body.recipientAddress,
        accountHolderName: body.accountHolderName,
        amountBaseUnits: amount.toString(),
        customerReference: body.idempotencyKey,
        authorizationExpiresAt: body.authorizationExpiresAt,
      })
      const authorized = await verifyOwnerSignature(tronWeb, message, body.ownerAuthorizationSignature, auth.ownerAddress)
      if (!authorized) return res.status(403).json({ success: false, error: 'owner-payout-signature-invalid' })

      const ledgerClient = await db.connect()
      let reservation
      try {
        await ledgerClient.query('BEGIN')
        await ledgerClient.query("SELECT pg_advisory_xact_lock(hashtext('tron-token-studio-fincra-usdt-trc20-payouts'))")
        const existing = await ledgerClient.query(
          'SELECT * FROM trc20_token_clone.fincra_usdt_trc20_payouts WHERE customer_reference=$1 FOR UPDATE',
          [body.idempotencyKey],
        )
        if (existing.rows.length) {
          const prior = existing.rows[0]
          await ledgerClient.query('COMMIT')
          if (prior.owner_address !== auth.ownerAddress) return res.status(409).json({ success: false, error: 'customer-reference-already-used' })
          if (prior.recipient_address !== body.recipientAddress || String(prior.amount_base_units) !== amount.toString()
            || prior.beneficiary_name !== body.accountHolderName.trim()) {
            return res.status(409).json({ success: false, error: 'idempotency-key-conflict' })
          }
          return res.status(200).json({
            success: true,
            duplicate: true,
            payout: safeStatus(await refreshProviderStatus(db, prior)),
            note: 'Existing Fincra request returned. No second payout was created.',
          })
        }
        const daily = await ledgerClient.query(
          "SELECT COALESCE(SUM(amount_base_units),0)::text AS amount FROM trc20_token_clone.fincra_usdt_trc20_payouts WHERE created_at >= date_trunc('day', now()) AND status NOT IN ('provider-failed','chain-failed')",
        )
        const dailyReserved = BigInt(daily.rows[0]?.amount || '0')
        if (dailyReserved + amount > dailyLimit) {
          await ledgerClient.query('ROLLBACK')
          return res.status(429).json({ success: false, error: 'fincra-daily-payout-limit-exceeded' })
        }
        const inserted = await ledgerClient.query(
          "INSERT INTO trc20_token_clone.fincra_usdt_trc20_payouts (customer_reference, owner_address, recipient_address, beneficiary_name, token_contract, amount_base_units, source_currency, status) VALUES ($1,$2,$3,$4,$5,$6,'USDT','reserved') RETURNING *",
          [body.idempotencyKey, auth.ownerAddress, body.recipientAddress, body.accountHolderName.trim(), OFFICIAL_TRON_MAINNET_USDT, amount.toString()],
        )
        reservation = inserted.rows[0]
        await ledgerClient.query('COMMIT')
      } catch (error) {
        try { await ledgerClient.query('ROLLBACK') } catch {}
        throw error
      } finally {
        ledgerClient.release()
      }

      let response
      try {
        response = await client().createUsdtTrc20Payout({
          amount: body.amountUsdt,
          customerReference: body.idempotencyKey,
          walletAddress: body.recipientAddress,
          accountHolderName: body.accountHolderName.trim(),
          sourceCurrency: 'USDT',
          email: body.email,
        })
      } catch (error) {
        let recovered = null
        if (error?.code === 'fincra-network-outcome-unknown' || error?.status === 422) {
          try { recovered = await client().getPayoutByCustomerReference(body.idempotencyKey) } catch {}
        }
        if (!recovered) {
          const updated = await db.query("UPDATE trc20_token_clone.fincra_usdt_trc20_payouts SET status='submission-unknown', failure_code='provider-outcome-unknown', updated_at=now() WHERE id=$1 RETURNING *", [reservation.id])
          return res.status(202).json({
            success: false,
            status: 'submission-unknown',
            payout: safeStatus(updated.rows[0] || reservation),
            note: 'Fincra outcome is unresolved. Re-query this same customer reference; do not create a replacement reference.',
          })
        }
        response = recovered
      }
      const data = response?.data || response
      if (data?.customerReference !== body.idempotencyKey
        || (data?.destinationCurrency && data.destinationCurrency !== 'USDT')
        || (data?.paymentScheme && data.paymentScheme !== 'usdt_trc20')) {
        const updated = await db.query(
          "UPDATE trc20_token_clone.fincra_usdt_trc20_payouts SET status='submission-unknown', failure_code='provider-response-reference-or-scheme-mismatch', updated_at=now() WHERE id=$1 RETURNING *",
          [reservation.id],
        )
        return res.status(202).json({
          success: false,
          status: 'submission-unknown',
          payout: safeStatus(updated.rows[0] || reservation),
          note: 'Fincra response did not echo the exact customer reference and expected payout scheme. Check the same provider reference before retrying.',
        })
      }
      const status = mapProviderStatus(data?.status)
      const transactionHash = extractTransactionHash(data)
      const saved = await db.query(
        'UPDATE trc20_token_clone.fincra_usdt_trc20_payouts SET status=$2, provider_status=$3, provider_reference=$4, provider_payout_id=$5, transaction_hash=$6, updated_at=now() WHERE id=$1 RETURNING *',
        [reservation.id, status, typeof data?.status === 'string' ? data.status.slice(0, 64) : 'processing',
          typeof data?.reference === 'string' ? data.reference.slice(0, 128) : null,
          data?.id == null ? null : String(data.id).slice(0, 128), transactionHash],
      )
      return res.status(202).json({
        success: true,
        payout: safeStatus(saved.rows[0]),
        note: status === 'provider-successful-awaiting-chain'
          ? 'Fincra reports successful processing. Tatum chain verification is still required before this is labelled confirmed.'
          : status === 'provider-failed'
            ? 'Fincra reports a failed payout. No successful transfer is claimed.'
            : 'Fincra accepted or is processing the payout. Track the same customer reference; no on-chain confirmation is claimed.',
      })
    } catch {
      return res.status(503).json({ success: false, error: 'fincra-payout-unavailable' })
    }
  })

  router.get('/withdrawals/:customerReference', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    const auth = await authenticateOwner(req)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    if (!CUSTOMER_REFERENCE_PATTERN.test(req.params.customerReference || '')) return res.status(400).json({ success: false, error: 'invalid-customer-reference' })
    const db = getPool(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })
    try {
      await ensureSchema(db)
      const result = await db.query('SELECT * FROM trc20_token_clone.fincra_usdt_trc20_payouts WHERE customer_reference=$1 AND owner_address=$2', [req.params.customerReference, auth.ownerAddress])
      if (!result.rows.length) return res.status(404).json({ success: false, error: 'payout-not-found' })
      return res.json({ success: true, payout: safeStatus(await refreshProviderStatus(db, result.rows[0])) })
    } catch {
      return res.status(503).json({ success: false, error: 'fincra-payout-status-unavailable' })
    }
  })

  router.post('/withdrawals/:customerReference/verify', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    const auth = await authenticateOwner(req)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    if (!CUSTOMER_REFERENCE_PATTERN.test(req.params.customerReference || '')) return res.status(400).json({ success: false, error: 'invalid-customer-reference' })
    const db = getPool(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })
    try {
      await ensureSchema(db)
      const result = await db.query('SELECT * FROM trc20_token_clone.fincra_usdt_trc20_payouts WHERE customer_reference=$1 AND owner_address=$2', [req.params.customerReference, auth.ownerAddress])
      if (!result.rows.length) return res.status(404).json({ success: false, error: 'payout-not-found' })
      let row = await refreshProviderStatus(db, result.rows[0])
      if (row.status !== 'provider-successful-awaiting-chain') {
        return res.status(202).json({ success: false, payout: safeStatus(row), note: 'Fincra has not reported a successful payout. Chain success is not inferred.' })
      }
      const txid = typeof row.transaction_hash === 'string' ? row.transaction_hash.trim() : ''
      if (!TXID_PATTERN.test(txid)) {
        return res.status(202).json({ success: false, payout: safeStatus(row), note: 'Fincra has not supplied a verifiable TRON transaction hash yet. Continue polling the same payout reference.' })
      }
      if (!env.TATUM_API_KEY) return res.status(503).json({ success: false, error: 'tatum-api-key-missing' })
      const tronWeb = tronWebFactory()
      const [transaction, transactionInfo] = await Promise.all([
        tronWeb.trx.getConfirmedTransaction(txid).catch(() => null),
        tronWeb.trx.getTransactionInfo(txid).catch(() => null),
      ])
      const evidence = verifyFincraUsdtTrc20Evidence(tronWeb, {
        transaction, transactionInfo, transactionHash: txid,
        recipientAddress: row.recipient_address, amountBaseUnits: String(row.amount_base_units),
      })
      if (evidence.status === 'confirmed' || evidence.status === 'failed') {
        const nextStatus = evidence.status === 'confirmed' ? 'chain-confirmed' : 'chain-failed'
        const updated = await db.query('UPDATE trc20_token_clone.fincra_usdt_trc20_payouts SET status=$2, failure_code=$3, updated_at=now() WHERE id=$1 RETURNING *', [
          row.id, nextStatus, evidence.status === 'failed' ? evidence.reason : null,
        ])
        row = updated.rows[0] || row
      }
      return res.status(evidence.status === 'verification-mismatch' ? 409 : evidence.status === 'confirmed' ? 200 : 202).json({
        success: evidence.status === 'confirmed',
        payout: safeStatus(row),
        verification: evidence,
      })
    } catch {
      return res.status(503).json({ success: false, error: 'tatum-chain-verification-unavailable' })
    }
  })

  router.post('/fincra/webhook', async (req, res) => {
    const config = configuration()
    const payload = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null
    const signature = req.get('signature') || ''
    if (!payload || !config.configured || !client().verifyWebhook(payload, signature)) {
      return res.status(401).json({ success: false, error: 'invalid-fincra-webhook-signature' })
    }
    const event = typeof payload.event === 'string' ? payload.event : ''
    const data = payload.data && typeof payload.data === 'object' ? payload.data : {}
    const customerReference = typeof data.customerReference === 'string' ? data.customerReference : ''
    if (!CUSTOMER_REFERENCE_PATTERN.test(customerReference)) return res.status(400).json({ success: false, error: 'webhook-customer-reference-missing' })
    if (!['payout.successful', 'payout.failed', 'payout.processing', 'payout.pending'].includes(event)) {
      return res.status(200).json({ success: true, ignored: true })
    }
    const db = getPool(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })
    try {
      await ensureSchema(db)
      const providerStatus = typeof data.status === 'string' ? data.status.slice(0, 64) : event.slice('payout.'.length)
      const updated = await db.query(
        "UPDATE trc20_token_clone.fincra_usdt_trc20_payouts SET status=CASE WHEN status IN ('provider-failed','chain-confirmed','chain-failed') THEN status ELSE $2 END, provider_status=$3, provider_reference=COALESCE($4, provider_reference), provider_payout_id=COALESCE($5, provider_payout_id), transaction_hash=COALESCE($6, transaction_hash), updated_at=now() WHERE customer_reference=$1 RETURNING id",
        [customerReference, mapProviderStatus(providerStatus), providerStatus,
          typeof data.reference === 'string' ? data.reference.slice(0, 128) : null,
          data.id == null ? null : String(data.id).slice(0, 128), extractTransactionHash(data)],
      )
      return res.status(200).json({ success: true, matched: updated.rows.length === 1 })
    } catch {
      return res.status(503).json({ success: false, error: 'fincra-webhook-processing-unavailable' })
    }
  })

  return router
}
