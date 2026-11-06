import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { Router } from 'express'
import pg from 'pg'
import { normalizeDatabaseConnectionString, databaseSslConfig, getWalletAuthSession } from '../database.mjs'
import { isValidTronAddress } from '../tron-address.mjs'
import { tatumProviderFetch } from '../tatum-provider-fetch.mjs'
import { readTronGridIncomingHistory } from '../trongrid-history.mjs'
import { payoutStatusFromProvider } from '../fincra-payout-status.mjs'
import { getUnconfiguredProviderPayoutReadiness } from '../provider-payout-readiness.mjs'

const { Pool } = pg
const SCHEMA = 'trc20_token_clone'
const MAINNET_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const ADDRESS_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const TXID_RE = /^[0-9a-f]{64}$/i
const NETWORKS = Object.freeze({ mainnet: 'tron-mainnet' })
const RPC_METHODS = new Set([
  'wallet/getaccount',
  'wallet/getaccountresource',
  'wallet/getaccountnet',
  'walletsolidity/getaccount',
  'walletsolidity/getaccountresource',
  'walletsolidity/getaccountnet',
  'wallet/triggerconstantcontract',
  'walletsolidity/triggerconstantcontract',
  'wallet/estimateenergy',
  'walletsolidity/estimateenergy',
  'wallet/getchainparameters',
  'walletsolidity/getchainparameters',
  'wallet/getnowblock',
  'walletsolidity/getnowblock',
  'wallet/gettransactionbyid',
  'walletsolidity/gettransactionbyid',
  'wallet/gettransactioninfobyid',
  'walletsolidity/gettransactioninfobyid',
  'wallet/getcontract',
  'walletsolidity/getcontract',
  'wallet/getblockbylatestnum',
  'walletsolidity/getblockbylatestnum',
  'wallet/validateaddress',
])

function cleanString(value, max = 256) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function parseUsdtBalanceBaseUnits(value) {
  const raw = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : ''
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/.test(raw)) return null
  const [whole, fraction = ''] = raw.split('.')
  try { return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0') || '0') } catch { return null }
}

function parseUsdtAmount(value) {
  const raw = typeof value === 'string' ? value.trim() : String(value ?? '')
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/.test(raw)) {
    throw new Error('Amount must be a positive USDT decimal with no more than 6 decimal places.')
  }
  const [whole, fraction = ''] = raw.split('.')
  const baseUnits = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0') || '0')
  // Fincra requires amount as a JSON number. Cap the amount so the six-decimal
  // USDT value remains representable by a JavaScript number without rounding.
  const maxFincraBaseUnits = 1_000_000_000_000_000n
  if (baseUnits <= 0n || baseUnits > maxFincraBaseUnits) {
    throw new Error('Amount must be greater than zero and no more than 1,000,000,000 USDT for exact six-decimal Fincra numeric submission.')
  }
  const normalizedFraction = fraction.padEnd(6, '0').replace(/0+$/, '')
  const decimal = whole + (normalizedFraction ? '.' + normalizedFraction : '')
  return { baseUnits: baseUnits.toString(), decimal }
}

function configuredApiKey(env, network) {
  return network === 'mainnet' ? cleanString(env.TATUM_MAINNET_API_KEY || env.TATUM_API_KEY, 2048) : ''
}

function requestOrigin(req) {
  const origin = cleanString(req.headers?.origin, 512)
  try {
    const parsed = new URL(origin)
    if (parsed.origin !== origin || !['https:', 'http:'].includes(parsed.protocol)) return ''
    return origin
  } catch {
    return ''
  }
}

function allowedOrigins(env) {
  return [
    env.FRONTEND_ORIGIN,
    env.PACKAGED_APP_ORIGINS,
    env.OKX_UI_ORIGIN,
    env.TRON_TRANSFER_UI_ORIGIN,
  ].flatMap((value) => typeof value === 'string' ? value.split(',') : [])
    .map((value) => value.trim()).filter(Boolean)
}

async function requireRequesterWalletSession(req, env) {
  const origin = requestOrigin(req)
  if (!origin || !allowedOrigins(env).includes(origin)) return { ok: false, status: 403, error: 'requester-origin-not-allowed' }
  const header = cleanString(req.headers?.authorization, 4096)
  const match = /^Bearer\s+([A-Za-z0-9_-]{43})$/i.exec(header)
  if (!match) return { ok: false, status: 401, error: 'requester-wallet-session-required' }
  const lookup = await getWalletAuthSession({
    tokenHash: createHash('sha256').update(match[1]).digest('hex'),
    origin,
    nowMs: Date.now(),
  })
  if (lookup?.success !== true) return { ok: false, status: 503, error: 'requester-wallet-session-storage-unavailable' }
  const session = lookup.session
  if (!session || session.network !== 'mainnet' || session.origin !== origin
    || !isValidTronAddress(session.address)) {
    return { ok: false, status: 401, error: 'requester-wallet-session-invalid-or-expired' }
  }
  const configuredOwner = cleanString(env.OWNER_WALLET_ADDRESS || env.TREASURY_OWNER_ADDRESS, 64)
  if (!isValidTronAddress(configuredOwner)) {
    return { ok: false, status: 503, error: 'private-platform-owner-not-configured' }
  }
  if (session.address !== configuredOwner) {
    return { ok: false, status: 403, error: 'private-owner-only-platform' }
  }
  return { ok: true, address: configuredOwner }
}

async function requireOwnerSession(req, env) {
  const origin = requestOrigin(req)
  if (!origin || !allowedOrigins(env).includes(origin)) return { ok: false, status: 403, error: 'owner-origin-not-allowed' }
  const header = cleanString(req.headers?.authorization, 4096)
  const match = /^Bearer\s+([A-Za-z0-9_-]{32,256})$/i.exec(header)
  if (!match) return { ok: false, status: 401, error: 'owner-session-required' }
  const configuredOwner = cleanString(env.OWNER_WALLET_ADDRESS || env.TREASURY_OWNER_ADDRESS, 64)
  if (!configuredOwner || !isValidTronAddress(configuredOwner)) return { ok: false, status: 503, error: 'owner-login-not-configured' }
  const tokenHash = createHash('sha256').update(match[1]).digest('hex')
  const lookup = await getWalletAuthSession({ tokenHash, origin, nowMs: Date.now() })
  if (lookup?.success !== true) return { ok: false, status: 503, error: 'owner-session-storage-unavailable' }
  const session = lookup.session
  if (!session || session.network !== 'mainnet' || session.address !== configuredOwner || session.origin !== origin) {
    return { ok: false, status: 401, error: 'owner-session-invalid-or-expired' }
  }
  return { ok: true, address: configuredOwner }
}

function fincraConfig(env) {
  const mode = env.FINCRA_ENVIRONMENT === 'live' ? 'live' : 'sandbox'
  const baseUrl = mode === 'live' ? 'https://api.fincra.com' : 'https://sandboxapi.fincra.com'
  return {
    mode,
    baseUrl,
    apiKey: cleanString(env.FINCRA_SECRET_KEY, 4096),
    businessId: cleanString(env.FINCRA_BUSINESS_ID, 128),
    sourceCurrency: cleanString(env.FINCRA_SOURCE_CURRENCY || 'USDT', 8).toUpperCase(),
    payoutsEnabled: env.FINCRA_PAYOUTS_ENABLED === 'true',
    liveConfirmed: env.FINCRA_LIVE_STABLECOIN_PAYOUTS_CONFIRMED === 'true',
    webhookConfigured: Boolean(cleanString(env.FINCRA_WEBHOOK_SECRET, 4096)),
  }
}

async function fincraRequest(config, path, options = {}) {
  if (!config.apiKey) throw Object.assign(new Error('Fincra API credentials are not configured.'), { status: 503 })
  const response = await fetch(config.baseUrl + path, {
    method: options.method || 'GET',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'api-key': config.apiKey,
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  })
  const payload = await response.json().catch(() => null)
  return { ok: response.ok, status: response.status, payload }
}

function responseRows(payload) {
  const data = payload?.data
  if (Array.isArray(data)) return data
  if (Array.isArray(data?.wallets)) return data.wallets
  if (Array.isArray(data?.results)) return data.results
  if (Array.isArray(data?.accounts)) return data.accounts
  if (Array.isArray(data?.balances)) return data.balances
  if (Array.isArray(payload?.wallets)) return payload.wallets
  if (Array.isArray(payload?.result)) return payload.result
  // Some Fincra account responses return one wallet object under data.
  if (data && typeof data === 'object'
    && (data.currency || data.sourceCurrency)
    && (data.availableBalance !== undefined || data.available_balance !== undefined)) return [data]
  if (payload && typeof payload === 'object'
    && (payload.currency || payload.sourceCurrency)
    && (payload.availableBalance !== undefined || payload.available_balance !== undefined)) return [payload]
  return []
}

async function readFincraSourceBalance(config) {
  if (!config.apiKey || !config.businessId) return { checked: false, reason: 'fincra-not-configured' }
  const result = await fincraRequest(config, '/wallets?businessID=' + encodeURIComponent(config.businessId))
  if (!result.ok || result.payload?.success === false) return { checked: false, reason: 'fincra-wallets-unavailable', providerStatus: result.status }
  const wallet = responseRows(result.payload).find((item) => String(item?.currency || item?.sourceCurrency || '').toUpperCase() === config.sourceCurrency)
  if (!wallet) return { checked: false, reason: 'source-currency-wallet-not-found' }
  const availableRaw = wallet.availableBalance ?? wallet.available_balance ?? wallet.balance?.availableBalance
  const availableBaseUnits = parseUsdtBalanceBaseUnits(availableRaw)
  if (availableBaseUnits === null) return { checked: false, reason: 'source-balance-not-readable' }
  const lockedRaw = wallet.lockedBalance ?? wallet.locked_balance ?? wallet.balance?.lockedBalance
  const ledgerRaw = wallet.ledgerBalance ?? wallet.ledger_balance ?? wallet.balance?.ledgerBalance
  const lockedBaseUnits = lockedRaw === undefined || lockedRaw === null ? null : parseUsdtBalanceBaseUnits(lockedRaw)
  const ledgerBaseUnits = ledgerRaw === undefined || ledgerRaw === null ? null : parseUsdtBalanceBaseUnits(ledgerRaw)
  const walletNumberRaw = wallet.walletNumber ?? wallet.balanceNumber ?? wallet.wallet_number
  const walletNumber = typeof walletNumberRaw === 'string'
    ? cleanString(walletNumberRaw, 128)
    : Number.isSafeInteger(walletNumberRaw) && walletNumberRaw > 0
      ? String(walletNumberRaw) : ''
  return {
    checked: true,
    currency: config.sourceCurrency,
    availableBalance: String(availableRaw),
    availableBalanceBaseUnits: availableBaseUnits.toString(),
    lockedBalance: lockedBaseUnits === null ? null : String(lockedRaw),
    lockedBalanceBaseUnits: lockedBaseUnits === null ? null : lockedBaseUnits.toString(),
    ledgerBalance: ledgerBaseUnits === null ? null : String(ledgerRaw),
    ledgerBalanceBaseUnits: ledgerBaseUnits === null ? null : ledgerBaseUnits.toString(),
    walletId: cleanString(wallet.id || wallet.walletId, 128) || null,
    walletNumber: walletNumber || null,
  }
}

let pool
function getPool(env) {
  if (pool) return pool
  if (!cleanString(env.DATABASE_URL, 4096)) return null
  const connectionString = normalizeDatabaseConnectionString(env.DATABASE_URL)
  pool = new Pool({
    connectionString,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    max: 3,
    ssl: databaseSslConfig(connectionString, env),
  })
  pool.on('error', (error) => console.error('Tron Transfer database error:', error?.code || 'unknown'))
  return pool
}

const TRANSFER_SELECTOR = 'a9059cbb'
const TRANSFER_EVENT_TOPIC = 'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

function canonicalHexAddress(value) {
  if (typeof value !== 'string') return null
  let hex = value.trim().replace(/^0x/i, '').toLowerCase()
  if (hex.length === 42 && hex.startsWith('41')) hex = hex.slice(2)
  return /^[0-9a-f]{40}$/.test(hex) ? hex : null
}

function canonicalTopicAddress(value) {
  if (typeof value !== 'string') return null
  const topic = value.replace(/^0x/i, '').toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(topic) || !topic.startsWith('0'.repeat(24))) return null
  return topic.slice(24)
}

function readSolidifiedTransferEvent(log, contractBytes) {
  if (!log || typeof log !== 'object' || !Array.isArray(log.topics) || log.topics.length < 3) return null
  if (canonicalHexAddress(log.address) !== contractBytes) return null
  if (typeof log.topics[0] !== 'string'
    || log.topics[0].replace(/^0x/i, '').toLowerCase() !== TRANSFER_EVENT_TOPIC) return null
  const fromBytes = canonicalTopicAddress(log.topics[1])
  const toBytes = canonicalTopicAddress(log.topics[2])
  const data = typeof log.data === 'string' ? log.data.replace(/^0x/i, '') : ''
  if (!fromBytes || !toBytes || !/^[0-9a-f]{64}$/i.test(data)) return null
  try {
    return { fromBytes, toBytes, amountBaseUnits: BigInt('0x' + data).toString() }
  } catch {
    return null
  }
}

/** Verifies one exact transfer from Tatum's solidified TRON transaction body and receipt. */
export async function verifySolidifiedUsdtTransfer(env, { transactionHash, from, to, amountBaseUnits, providerRequest = tatumGatewayRequest, tronWebFactory = async () => { const { TronWeb } = await import('tronweb'); return new TronWeb({ fullHost: 'https://tron-mainnet.gateway.tatum.io' }) } }) {
  if (!TXID_RE.test(transactionHash || '') || !isValidTronAddress(from) || !isValidTronAddress(to)
    || !/^[1-9][0-9]{0,77}$/.test(String(amountBaseUnits))) {
    return { verified: false, status: 'invalid-verification-intent' }
  }
  const [transaction, receipt] = await Promise.all([
    providerRequest({ env, network: 'mainnet', path: 'walletsolidity/gettransactionbyid', body: { value: transactionHash, visible: false } }),
    providerRequest({ env, network: 'mainnet', path: 'walletsolidity/gettransactioninfobyid', body: { value: transactionHash, visible: false } }),
  ])
  const bodyMatches = typeof transaction?.txID === 'string'
    && transaction.txID.toLowerCase() === transactionHash.toLowerCase()
  const receiptMatches = typeof receipt?.id === 'string'
    && receipt.id.toLowerCase() === transactionHash.toLowerCase()
  const blockNumber = Number(receipt?.blockNumber)
  const finalized = receiptMatches && Number.isSafeInteger(blockNumber) && blockNumber > 0
  if (!bodyMatches || !finalized) {
    return { verified: false, status: 'awaiting-solidified-receipt', solidifiedReceiptPresent: false }
  }

  const tronWeb = await tronWebFactory()
  if (!tronWeb.isAddress(from) || !tronWeb.isAddress(to) || !tronWeb.isAddress(MAINNET_USDT)) {
    return { verified: false, status: 'invalid-address-checksum' }
  }
  const fromBytes = canonicalHexAddress(tronWeb.address.toHex(from))
  const toBytes = canonicalHexAddress(tronWeb.address.toHex(to))
  const contractBytes = canonicalHexAddress(tronWeb.address.toHex(MAINNET_USDT))
  const contracts = Array.isArray(transaction?.raw_data?.contract) ? transaction.raw_data.contract : []
  const trigger = contracts.length === 1 && contracts[0]?.type === 'TriggerSmartContract' ? contracts[0] : null
  const value = trigger?.parameter?.value
  const actualSender = canonicalHexAddress(value?.owner_address)
  const actualContract = canonicalHexAddress(value?.contract_address)
  const calldata = typeof value?.data === 'string' ? value.data.replace(/^0x/i, '').toLowerCase() : ''
  const calldataMatch = /^a9059cbb([0-9a-f]{128})$/.exec(calldata)
  const encodedRecipient = calldataMatch ? calldataMatch[1].slice(24, 64) : null
  let encodedAmount = null
  if (calldataMatch) {
    try { encodedAmount = BigInt('0x' + calldataMatch[1].slice(64, 128)).toString() } catch {}
  }
  const transactionSucceeded = transaction?.ret?.some((item) => item?.contractRet === 'SUCCESS') === true
  const receiptSucceeded = receipt?.receipt?.result === 'SUCCESS'
  const logs = Array.isArray(receipt?.log) ? receipt.log : []
  const matches = []
  for (let index = 0; index < logs.length; index += 1) {
    const event = readSolidifiedTransferEvent(logs[index], contractBytes)
    if (event && event.fromBytes === fromBytes && event.toBytes === toBytes
      && event.amountBaseUnits === String(amountBaseUnits)) matches.push({ logIndex: index, ...event })
  }
  const verified = Boolean(fromBytes && toBytes && contractBytes
    && transactionSucceeded && receiptSucceeded
    && contracts.length === 1 && Boolean(trigger)
    && actualSender === fromBytes
    && actualContract === contractBytes
    && Boolean(calldataMatch)
    && encodedRecipient === toBytes
    && encodedAmount === String(amountBaseUnits)
    && matches.length === 1)
  if (!verified) {
    return {
      verified: false,
      status: !transactionSucceeded || !receiptSucceeded ? 'solidified-transaction-failed'
        : matches.length > 1 ? 'ambiguous-transfer-event' : 'solidified-transfer-mismatch',
      blockNumber,
      transactionSucceeded,
      receiptSucceeded,
      transferEventMatches: matches.length,
    }
  }
  return {
    verified: true,
    status: 'solidified-trc20-transfer-verified',
    blockNumber,
    timestamp: Number.isSafeInteger(receipt.blockTimeStamp) ? receipt.blockTimeStamp : null,
    logIndex: matches[0].logIndex,
    transactionHash: transactionHash.toLowerCase(),
    contract: MAINNET_USDT,
    from,
    to,
    amountBaseUnits: String(amountBaseUnits),
  }
}

export function createTronTransferRouter({ env = process.env } = {}) {
  const router = Router()
  let schemaPromise = null

  async function ensureSchema(db) {
    if (!schemaPromise) {
      schemaPromise = (async () => {
        await db.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`)
        await db.query(`
          CREATE TABLE IF NOT EXISTS ${SCHEMA}.tron_transfer_sponsor_requests (
            id UUID PRIMARY KEY,
            customer_reference TEXT NOT NULL UNIQUE,
            requester_address TEXT NOT NULL,
            recipient_address TEXT NOT NULL,
            beneficiary_name TEXT NOT NULL,
            beneficiary_email TEXT,
            asset TEXT NOT NULL DEFAULT 'USDT' CHECK (asset = 'USDT'),
            network TEXT NOT NULL DEFAULT 'mainnet' CHECK (network = 'mainnet'),
            token_contract TEXT NOT NULL DEFAULT '${MAINNET_USDT}',
            amount_base_units NUMERIC(78,0) NOT NULL CHECK (amount_base_units > 0),
            amount_decimal NUMERIC(30,6) NOT NULL CHECK (amount_decimal > 0),
            status TEXT NOT NULL DEFAULT 'pending-organization-review',
            fincra_reference TEXT,
            fincra_status TEXT,
            fincra_webhook_event TEXT,
            fincra_webhook_received_at TIMESTAMPTZ,
            fincra_submitted_at TIMESTAMPTZ,
            fincra_successful_at TIMESTAMPTZ,
            sponsor_mandate_id UUID,
transaction_hash CHAR(64),
            chain_verification_status TEXT NOT NULL DEFAULT 'not-verified',
            chain_verification_reason TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
          )
        `)
        await db.query(`ALTER TABLE ${SCHEMA}.tron_transfer_sponsor_requests
          ADD COLUMN IF NOT EXISTS fincra_submitted_at TIMESTAMPTZ`)
        await db.query(`ALTER TABLE ${SCHEMA}.tron_transfer_sponsor_requests
          ADD COLUMN IF NOT EXISTS fincra_successful_at TIMESTAMPTZ`)
        await db.query(`ALTER TABLE ${SCHEMA}.tron_transfer_sponsor_requests
          ADD COLUMN IF NOT EXISTS fincra_amount_charged_base_units NUMERIC(78,0)`)
        await db.query(`ALTER TABLE ${SCHEMA}.tron_transfer_sponsor_requests
          ADD COLUMN IF NOT EXISTS fincra_amount_received_base_units NUMERIC(78,0)`)
        await db.query(`ALTER TABLE ${SCHEMA}.tron_transfer_sponsor_requests
          ADD COLUMN IF NOT EXISTS fincra_fee_base_units NUMERIC(78,0)`)
        await db.query(`ALTER TABLE ${SCHEMA}.tron_transfer_sponsor_requests ADD COLUMN IF NOT EXISTS sponsor_mandate_id UUID`)
        await db.query(`CREATE INDEX IF NOT EXISTS tron_transfer_sponsor_requests_mandate_daily_idx ON ${SCHEMA}.tron_transfer_sponsor_requests (sponsor_mandate_id, created_at DESC) WHERE sponsor_mandate_id IS NOT NULL`)
        await db.query(`CREATE INDEX IF NOT EXISTS tron_transfer_sponsor_requests_created_idx
          ON ${SCHEMA}.tron_transfer_sponsor_requests (created_at DESC)`)
      })().catch((error) => { schemaPromise = null; throw error })
    }
    await schemaPromise
  }

  function publicRequest(row) {
    return {
      id: row.id,
      customerReference: row.customer_reference,
      requesterAddress: row.requester_address,
      recipientAddress: row.recipient_address,
      beneficiaryName: row.beneficiary_name,
      beneficiaryEmail: row.beneficiary_email || null,
      asset: row.asset,
      network: row.network,
      tokenContract: row.token_contract,
      amountBaseUnits: String(row.amount_base_units),
      amount: String(row.amount_decimal),
      fincraAmountChargedBaseUnits: row.fincra_amount_charged_base_units == null ? null : String(row.fincra_amount_charged_base_units),
      fincraAmountReceivedBaseUnits: row.fincra_amount_received_base_units == null ? null : String(row.fincra_amount_received_base_units),
      fincraFeeBaseUnits: row.fincra_fee_base_units == null ? null : String(row.fincra_fee_base_units),
      status: row.status,
      fincraReference: row.fincra_reference || null,
      fincraStatus: row.fincra_status || null,
      sponsorMandateId: row.sponsor_mandate_id || null,
      transactionHash: row.transaction_hash || null,
      chainVerificationStatus: row.chain_verification_status,
      chainVerificationReason: row.chain_verification_reason || null,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    }
  }

  async function findRequest(db, id) {
    const found = await db.query(
      `SELECT * FROM ${SCHEMA}.tron_transfer_sponsor_requests WHERE id = $1 LIMIT 1`,
      [id],
    )
    return found.rows[0] || null
  }

  function reconcileFincraPayoutIdentity(payout, row) {
    if (!payout || typeof payout !== 'object') return { ok: false, complete: false, reason: 'provider-payout-record-missing' }
    const status = payoutStatusFromProvider(payout.status)
    if (status === 'unknown') {
      return { ok: false, complete: false, status, reason: 'unsupported-payout-status' }
    }
    const customerReference = cleanString(payout.customerReference || payout.customer_reference, 80)
    const sourceCurrency = cleanString(payout.sourceCurrency, 8).toUpperCase()
    const destinationCurrency = cleanString(payout.destinationCurrency, 8).toUpperCase()
    const paymentScheme = cleanString(payout.paymentScheme, 32).toLowerCase()
    const paymentDestination = cleanString(payout.paymentDestination, 32).toLowerCase()
    const recipient = cleanString(payout.beneficiary?.walletAddress || payout.beneficiary?.address || payout.recipient?.walletAddress || payout.recipient?.address || payout.recipient?.accountNumber || payout.walletAddress || payout.beneficiary?.accountNumber, 64)
    const parseOptional = (value) => value === undefined || value === null ? null : parseUsdtBalanceBaseUnits(value)
    const received = parseOptional(payout.amountReceived)
    const charged = parseOptional(payout.amountCharged)
    const fee = parseOptional(payout.fee)
    if ((payout.amountReceived != null && received === null) || (payout.amountCharged != null && charged === null) || (payout.fee != null && fee === null)) {
      return { ok: false, complete: false, status, reason: 'payout-settlement-amount-invalid' }
    }
    if ((received !== null && received <= 0n) || (charged !== null && charged <= 0n) || (fee !== null && fee < 0n) || (received !== null && charged !== null && charged < received) || (fee !== null && charged !== null && fee > charged)) {
      return { ok: false, complete: false, status, reason: 'payout-settlement-amount-inconsistent' }
    }
    const checks = [
      ['customer-reference-mismatch', customerReference, row.customer_reference],
      ['source-currency-mismatch', sourceCurrency, 'USDT'],
      ['destination-currency-mismatch', destinationCurrency, 'USDT'],
      ['payment-scheme-mismatch', paymentScheme, 'usdt_trc20'],
      ['payment-destination-mismatch', paymentDestination, 'crypto_wallet'],
      ['recipient-mismatch', recipient, row.recipient_address],
    ]
    for (const [reason, actual, expected] of checks) {
      if (actual && actual !== expected) return { ok: false, complete: false, status, reason }
    }
    // Fincra amountReceived is the net beneficiary amount after fees; it is distinct from the requested/source amount.
    const complete = checks.every(([, actual]) => Boolean(actual)) && received !== null
    if (status === 'successful' && !complete) return { ok: false, complete: false, status, reason: 'successful-payout-record-incomplete' }
    return { ok: true, complete, status, recipient, amountReceivedBaseUnits: received?.toString() || null, amountChargedBaseUnits: charged?.toString() || null, feeBaseUnits: fee?.toString() || null }
  }
  router.get('/sponsor-funding-history', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    const auth = await requireOwnerSession(req, env)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const config = fincraConfig(env)
    if (!config.apiKey || !config.businessId || config.sourceCurrency !== 'USDT') {
      return res.status(503).json({ success: false, error: 'fincra-usdt-funding-history-not-configured' })
    }
    const dateFrom = cleanString(req.query?.dateFrom, 10)
    const dateTo = cleanString(req.query?.dateTo, 10)
    const datePattern = /^\d{4}-\d{2}-\d{2}$/
    if ((dateFrom && !datePattern.test(dateFrom)) || (dateTo && !datePattern.test(dateTo))) {
      return res.status(400).json({ success: false, error: 'invalid-funding-history-date-range' })
    }
    const query = new URLSearchParams({
      business: config.businessId,
      action: 'credit',
      page: '1',
      perPage: '50',
    })
    if (dateFrom) query.set('dateFrom', dateFrom)
    if (dateTo) query.set('dateTo', dateTo)
    try {
      const result = await fincraRequest(config, '/wallets/logs?' + query.toString())
      if (!result.ok || result.payload?.success === false) {
        return res.status(502).json({ success: false, error: 'fincra-funding-history-unavailable', providerStatus: result.status })
      }
      const payloadRows = result.payload?.data
      const candidates = Array.isArray(payloadRows) ? payloadRows
        : Array.isArray(payloadRows?.logs) ? payloadRows.logs
          : Array.isArray(payloadRows?.transactions) ? payloadRows.transactions
            : Array.isArray(payloadRows?.rows) ? payloadRows.rows
              : Array.isArray(payloadRows?.items) ? payloadRows.items
                : Array.isArray(payloadRows?.data) ? payloadRows.data : []
      const rows = candidates.slice(0, 50).map((item) => ({
        id: cleanString(item?.id || item?._id, 96) || null,
        reference: cleanString(item?.reference || item?.transactionReference, 128) || null,
        customerReference: cleanString(item?.customerReference || item?.customer_reference, 96) || null,
        action: cleanString(item?.action || item?.type, 24).toLowerCase() || 'credit',
        currency: cleanString(item?.currency || item?.sourceCurrency || item?.destinationCurrency, 8).toUpperCase() || null,
        amount: cleanString(String(item?.amountReceived ?? item?.amount ?? item?.destinationAmount ?? ''), 64) || null,
        status: cleanString(item?.status, 32).toLowerCase() || null,
        description: cleanString(item?.description || item?.reason, 180) || null,
        sender: cleanString(item?.customerName || item?.senderName || item?.sender?.name, 120) || null,
        createdAt: cleanString(item?.createdAt || item?.created_at || item?.initiatedAt, 64) || null,
      })).filter((item) => item.action === 'credit' && item.currency === 'USDT')
      return res.json({
        success: true,
        source: 'fincra-business-wallet-ledger',
        sourceCurrency: 'USDT',
        rows,
        hasMore: Boolean(result.payload?.data?.hasMore || result.payload?.data?.pagination?.hasNextPage),
        note: 'These are read-only Fincra business wallet ledger credits. A credit is included only when Fincra returns it; the current available balance remains the authoritative payout liquidity check.',
      })
    } catch {
      return res.status(502).json({ success: false, error: 'fincra-funding-history-request-failed' })
    }
  })

  router.get('/readiness', async (_req, res) => {
    const auth = await requireOwnerSession(_req, env)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const db = getPool(env)
    const fincra = fincraConfig(env)
    const mainnetConfigured = Boolean(configuredApiKey(env, 'mainnet'))
    let databaseReady = false
    if (db) {
      try { await ensureSchema(db); await db.query('SELECT 1'); databaseReady = true } catch {}
    }
    const inspectSolidifiedNode = async (network) => {
      const configured = Boolean(configuredApiKey(env, network))
      if (!configured) return { checked: false, reason: network === 'mainnet' ? 'tatum-mainnet-key-missing' : 'tatum-testnet-key-missing' }
      try {
        const block = await tatumGatewayRequest({ env, network, path: 'walletsolidity/getnowblock', body: {} })
        const number = Number(block?.block_header?.raw_data?.number)
        const blockId = cleanString(block?.blockID, 96)
        return Number.isSafeInteger(number) && number > 0 && TXID_RE.test(blockId)
          ? { checked: true, status: 'solidified-node-reachable', latestSolidifiedBlockNumber: number }
          : { checked: false, reason: 'invalid-solidified-block-response' }
      } catch (error) {
        return {
          checked: false,
          reason: Number.isInteger(error?.status) ? 'tatum-provider-http-error' : 'tatum-provider-unreachable',
          providerStatus: Number.isInteger(error?.status) ? error.status : null,
        }
      }
    }
    const mainnetNode = await inspectSolidifiedNode('mainnet')
    let sourceBalance = { checked: false, reason: 'fincra-not-configured' }
    if (fincra.apiKey && fincra.businessId) {
      try { sourceBalance = await readFincraSourceBalance(fincra) } catch { sourceBalance = { checked: false, reason: 'fincra-wallets-unavailable' } }
    }
    const sourceBalanceBaseUnits = sourceBalance.checked
      ? parseUsdtBalanceBaseUnits(sourceBalance.availableBalance) : null
    const usdtSourceBalanceReady = sourceBalanceBaseUnits !== null
      && sourceBalanceBaseUnits > 0n && fincra.sourceCurrency === 'USDT'
    const canLivePayout = fincra.mode === 'live' && fincra.payoutsEnabled && fincra.liveConfirmed
      && Boolean(fincra.apiKey && fincra.businessId && fincra.webhookConfigured && databaseReady && mainnetNode.checked)
      && usdtSourceBalanceReady
    const automaticPayoutsConfigured = env.FINCRA_AUTO_PAYOUTS_ENABLED === 'true'
      && (env.FINCRA_AUTO_PAYOUT_REQUESTER_ADDRESSES || '').split(',').map((value) => value.trim()).some(isValidTronAddress)
    return res.json({
      success: true,
      status: 'readiness-evaluated',
      tatum: {
        mainnetConfigured,
        mainnetNode,
        supportedNetwork: 'mainnet-only',
        networkRouting: 'server-side-tatum-gateway',
        directWalletBroadcast: false,
      },
      fincra: {
        environment: fincra.mode,
        apiKeyConfigured: Boolean(fincra.apiKey),
        businessIdConfigured: Boolean(fincra.businessId),
        webhookSecretConfigured: fincra.webhookConfigured,
        sourceCurrency: fincra.sourceCurrency,
        payoutsEnabled: fincra.payoutsEnabled,
        liveStablecoinPayoutsConfirmed: fincra.liveConfirmed,
        sourceBalance,
        canSubmitLivePayout: canLivePayout,
        automaticPayoutsGateConfigured: automaticPayoutsConfigured,
        automaticPayoutsRequireStandingMandate: true,
        requiredScheme: 'usdt_trc20',
      },
      tronGrid: {
        apiKeyConfigured: Boolean(cleanString(env.TRONGRID_API_KEY, 2048)),
        incomingHistoryProvider: 'network-specific-v1-account-history',
      },
      storage: { configured: Boolean(env.DATABASE_URL), ready: databaseReady },
      mainnetUsdtContract: MAINNET_USDT,
      limitations: [
        'Tatum signs nothing: wallet transactions are signed locally and only signed raw transactions are submitted.',
        'A Fincra API acceptance is not settlement; query status or accept a verified webhook.',
        'A successful Fincra payout is not an independently verified TRON token transfer.',
        'Live payout requires a funded Fincra USDT source wallet and explicit live stablecoin enablement by Fincra.',
        'Tron Transfer is Mainnet-only; testnet and sandbox payouts are disabled.',
      ],
    })
  })

  router.get('/provider-readiness', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    const auth = await requireOwnerSession(req, env)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })

    // No provider currently has verified authorization plus provider-owned
    // liquidity or an approved credit facility for this owner. This route is
    // deliberately read-only and never probes or submits to an unapproved API.
    const readiness = getUnconfiguredProviderPayoutReadiness()
    return res.json({
      success: true,
      ownerAddress: auth.address,
      readiness,
      funding: {
        ownerDepositRequired: false,
        ownerWalletPrincipalRequired: false,
        providerOwnedLiquidityVerified: false,
        providerApprovedCreditVerified: false,
      },
      blockers: readiness.blockers,
      note: 'Owner funds and deposits are not assumed. A real payout remains disabled until a provider explicitly authorizes this owner, verifies provider-owned USDT liquidity or an approved credit facility, enables USDT TRON Mainnet payouts, and supplies a reviewed broadcast adapter.',
    })
  })

  router.all('/rpc/:network/*', async (req, res) => {
    const network = req.params.network
    const method = String(req.params[0] || '').replace(/^\/+/, '').toLowerCase()
    if (network !== 'mainnet' || !RPC_METHODS.has(method) || req.method !== 'POST') {
      return res.status(404).json({ success: false, error: 'rpc-method-not-allowed' })
    }
    try {
      const payload = await tatumGatewayRequest({ env, network, path: method, body: req.body })
      return res.status(200).json(payload)
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 502
      return res.status(status >= 400 && status <= 599 ? status : 502).json({
        success: false,
        error: 'tatum-rpc-unavailable',
        providerStatus: Number.isInteger(error?.status) ? error.status : null,
      })
    }
  })

  router.post('/broadcast', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    return res.status(410).json({
      success: false,
      error: 'direct-wallet-broadcast-disabled',
      message: 'Tron Transfer processes official USDT TRC20 Mainnet withdrawals through an authorized live Fincra business account. Direct wallet and testnet broadcasts are disabled.',
      transactionSubmitted: false,
    })
  })

  router.get('/recipient', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    const network = cleanString(req.query?.network, 16)
    const address = cleanString(req.query?.address, 64)
    const tokenContract = cleanString(req.query?.tokenContract, 64)
    if (network !== 'mainnet' || !ADDRESS_RE.test(address) || !isValidTronAddress(address)
      || (tokenContract && tokenContract !== MAINNET_USDT)) {
      return res.status(400).json({ success: false, error: 'invalid-recipient-query' })
    }
    try {
      const { TronWeb } = await import('tronweb')
      const tronWeb = new TronWeb({ fullHost: `https://${NETWORKS[network]}.gateway.tatum.io` })
      const account = await tatumGatewayRequest({ env, network, path: 'walletsolidity/getaccount', body: { address, visible: true } })
      const nativeBalanceSun = /^(0|[1-9][0-9]*)$/.test(String(account?.balance ?? '0')) ? String(account?.balance ?? '0') : null
      const contract = tokenContract || (network === 'mainnet' ? MAINNET_USDT : '')
      let tokenBalance = null
      if (contract) {
        const ownerHex = tronWeb.address.toHex(address)
        const contractHex = tronWeb.address.toHex(contract)
        const [balanceResult, decimalsResult] = await Promise.all([
          tatumGatewayRequest({ env, network, path: 'walletsolidity/triggerconstantcontract', body: {
            owner_address: ownerHex, contract_address: contractHex, function_selector: 'balanceOf(address)',
            parameter: ownerHex.replace(/^41/i, '').padStart(64, '0'), visible: false,
          } }),
          tatumGatewayRequest({ env, network, path: 'walletsolidity/triggerconstantcontract', body: {
            owner_address: ownerHex, contract_address: contractHex, function_selector: 'decimals()', parameter: '', visible: false,
          } }),
        ])
        const balanceHex = balanceResult?.constant_result?.[0]
        const decimalsHex = decimalsResult?.constant_result?.[0]
        const decimals = typeof decimalsHex === 'string' && /^[0-9a-f]+$/i.test(decimalsHex) ? Number(BigInt('0x' + decimalsHex)) : null
        const balanceBaseUnits = typeof balanceHex === 'string' && /^[0-9a-f]+$/i.test(balanceHex) ? BigInt('0x' + balanceHex).toString() : null
        if (balanceResult?.result?.result === true && balanceBaseUnits !== null && Number.isInteger(decimals) && decimals >= 0 && decimals <= 36) {
          tokenBalance = { contract, symbol: network === 'mainnet' && contract === MAINNET_USDT ? 'USDT' : 'TRC20', decimals, balanceBaseUnits }
        }
      }
      const historyResult = await readTronGridIncomingHistory({
        network,
        address,
        tokenContract: contract,
        apiKey: cleanString(env.TRONGRID_API_KEY, 2048),
        decodeAddress: (hex) => tronWeb.address.fromHex(hex),
      })
      const history = historyResult.history
      return res.json({
        success: true, network, address, nativeBalanceSun,
        nativeBalanceTRX: nativeBalanceSun === null ? null : (Number(nativeBalanceSun) / 1_000_000).toFixed(6),
        tokenBalance, incomingHistory: history,
        accountExists: Boolean(account?.address),
        nativeHistoryRead: historyResult.nativeHistoryRead,
        tokenHistoryRead: historyResult.tokenHistoryRead,
        historyStatus: historyResult.historyStatus,
        historyProvider: 'trongrid',
        historyProviderErrors: historyResult.providerErrors,
        checkedAt: new Date().toISOString(),
      })
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 502
      return res.status(status >= 400 && status <= 599 ? status : 502).json({
        success: false, error: 'recipient-inspection-unavailable',
        providerStatus: Number.isInteger(error?.status) ? error.status : null,
      })
    }
  })

  router.post('/sponsor-requests', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    const walletAuth = await requireRequesterWalletSession(req, env)
    if (!walletAuth.ok) return res.status(walletAuth.status).json({ success: false, error: walletAuth.error })
    const requesterAddress = walletAuth.address
    const assertedRequester = cleanString(req.body?.requesterAddress, 64)
    if (assertedRequester && assertedRequester !== requesterAddress) {
      return res.status(403).json({ success: false, error: 'requester-address-does-not-match-wallet-session' })
    }
    const recipientAddress = cleanString(req.body?.recipientAddress, 64)
    const beneficiaryName = cleanString(req.body?.beneficiaryName, 120)
    const beneficiaryEmail = cleanString(req.body?.beneficiaryEmail, 254)
    const customerReference = cleanString(req.body?.customerReference, 80)
    let amount
    try { amount = parseUsdtAmount(req.body?.amount) } catch (error) {
      return res.status(400).json({ success: false, error: 'invalid-amount', message: error.message })
    }
    if (!isValidTronAddress(requesterAddress) || !isValidTronAddress(recipientAddress)
      || !beneficiaryName || !/^[A-Za-z0-9._:-]{12,80}$/.test(customerReference)) {
      return res.status(400).json({ success: false, error: 'invalid-sponsor-request' })
    }
    if (beneficiaryEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(beneficiaryEmail)) {
      return res.status(400).json({ success: false, error: 'invalid-beneficiary-email' })
    }
    const db = getPool(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })
    try {
      await ensureSchema(db)
      const id = randomUUID()
      const result = await db.query(`
        INSERT INTO ${SCHEMA}.tron_transfer_sponsor_requests
          (id,customer_reference,requester_address,recipient_address,beneficiary_name,beneficiary_email,amount_base_units,amount_decimal)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (customer_reference) DO NOTHING
        RETURNING *
      `, [id, customerReference, requesterAddress, recipientAddress, beneficiaryName, beneficiaryEmail || null, amount.baseUnits, amount.decimal])
      if (result.rows[0]) return res.status(201).json({ success: true, request: publicRequest(result.rows[0]), note: 'Request recorded for organization review. No payout was initiated.' })
      const existing = await db.query(`SELECT * FROM ${SCHEMA}.tron_transfer_sponsor_requests WHERE customer_reference=$1 LIMIT 1`, [customerReference])
      const prior = existing.rows[0]
      if (prior && prior.requester_address === requesterAddress && prior.recipient_address === recipientAddress
        && String(prior.amount_base_units) === amount.baseUnits) {
        return res.status(200).json({ success: true, duplicate: true, request: publicRequest(prior), note: 'Matching request already exists; no duplicate payout was submitted.' })
      }
      return res.status(409).json({ success: false, error: 'customer-reference-conflict' })
    } catch {
      return res.status(503).json({ success: false, error: 'sponsor-request-storage-unavailable' })
    }
  })

  router.get('/sponsor-requests/mine', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    const auth = await requireRequesterWalletSession(req, env)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const db = getPool(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })
    try {
      await ensureSchema(db)
      const result = await db.query(
        `SELECT * FROM ${SCHEMA}.tron_transfer_sponsor_requests
         WHERE requester_address=$1 ORDER BY created_at DESC LIMIT 50`,
        [auth.address],
      )
      return res.json({ success: true, requests: result.rows.map(publicRequest) })
    } catch {
      return res.status(503).json({ success: false, error: 'requester-sponsor-history-unavailable' })
    }
  })

  router.get('/sponsor-requests', async (req, res) => {
    const auth = await requireOwnerSession(req, env)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const db = getPool(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })
    try {
      await ensureSchema(db)
      const result = await db.query(`SELECT * FROM ${SCHEMA}.tron_transfer_sponsor_requests ORDER BY created_at DESC LIMIT 100`)
      return res.json({ success: true, requests: result.rows.map(publicRequest) })
    } catch {
      return res.status(503).json({ success: false, error: 'sponsor-request-list-unavailable' })
    }
  })

  async function fetchFincraPayoutByCustomerReference(config, customerReference) {
    const path = '/disbursements/payouts/customer-reference/' + encodeURIComponent(customerReference)
    return fincraRequest(config, path)
  }

  async function preflightMainnetUsdtRecipient(address) {
    if (!isValidTronAddress(address)) return { checked: false, reason: 'invalid-recipient-address' }
    try {
      const { TronWeb } = await import('tronweb')
      const tronWeb = new TronWeb({ fullHost: 'https://tron-mainnet.gateway.tatum.io' })
      const account = await tatumGatewayRequest({
        env, network: 'mainnet', path: 'walletsolidity/getaccount',
        body: { address, visible: true },
      })
      if (!account?.address) return { checked: false, reason: 'recipient-mainnet-account-not-activated' }
      const ownerHex = tronWeb.address.toHex(address)
      const contractHex = tronWeb.address.toHex(MAINNET_USDT)
      const [balance, decimals] = await Promise.all([
        tatumGatewayRequest({
          env, network: 'mainnet', path: 'walletsolidity/triggerconstantcontract',
          body: {
            owner_address: ownerHex, contract_address: contractHex,
            function_selector: 'balanceOf(address)',
            parameter: ownerHex.replace(/^41/i, '').padStart(64, '0'), visible: false,
          },
        }),
        tatumGatewayRequest({
          env, network: 'mainnet', path: 'walletsolidity/triggerconstantcontract',
          body: {
            owner_address: ownerHex, contract_address: contractHex,
            function_selector: 'decimals()', parameter: '', visible: false,
          },
        }),
      ])
      const balanceHex = balance?.constant_result?.[0]
      const decimalsHex = decimals?.constant_result?.[0]
      const validBalance = balance?.result?.result === true
        && typeof balanceHex === 'string' && /^[0-9a-f]+$/i.test(balanceHex)
      const validDecimals = decimals?.result?.result === true
        && typeof decimalsHex === 'string' && /^[0-9a-f]+$/i.test(decimalsHex)
        && Number(BigInt('0x' + decimalsHex)) === 6
      if (!validBalance || !validDecimals) {
        return { checked: false, reason: 'official-mainnet-usdt-contract-preflight-failed' }
      }
      return {
        checked: true,
        accountExists: Boolean(account?.address),
        contract: MAINNET_USDT,
        decimals: 6,
        balanceBaseUnits: BigInt('0x' + balanceHex).toString(),
      }
    } catch {
      return { checked: false, reason: 'tatum-recipient-preflight-unavailable' }
    }
  }

  router.post('/sponsor-requests/:id/fincra-payout', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    const ownerAuth = await requireOwnerSession(req, env)
    if (!ownerAuth.ok) return res.status(ownerAuth.status).json({ success: false, error: ownerAuth.error })
    return res.status(410).json({
      success: false,
      error: 'legacy-fincra-payout-disabled',
      payoutSubmitted: false,
      transactionSubmitted: false,
      message: 'Fincra payouts are disabled for this private owner-only deployment. No Fincra credentials, business account, deposit balance or live payout authorization is assumed. Use the owner-only provider readiness endpoint to inspect the remaining funding requirements.',
    })
  })

  router.post('/sponsor-requests/:id/fincra-status', async (req, res) => {
    const ownerAuth = await requireOwnerSession(req, env)
    const requesterAuth = ownerAuth.ok ? null : await requireRequesterWalletSession(req, env)
    if (!ownerAuth.ok && !requesterAuth?.ok) {
      return res.status(requesterAuth?.status || ownerAuth.status)
        .json({ success: false, error: requesterAuth?.error || ownerAuth.error })
    }
    const db = getPool(env)
    const config = fincraConfig(env)
    if (!db || !config.apiKey) return res.status(503).json({ success: false, error: 'fincra-status-unavailable' })
    try {
      await ensureSchema(db)
      const row = await findRequest(db, req.params.id)
      if (!row) return res.status(404).json({ success: false, error: 'sponsor-request-not-found' })
      if (requesterAuth && row.requester_address !== requesterAuth.address) {
        return res.status(403).json({ success: false, error: 'requester-does-not-own-this-payout-request' })
      }
      const result = await fetchFincraPayoutByCustomerReference(config, row.customer_reference)
      if (!result.ok || result.payload?.success === false || !result.payload?.data) {
        return res.status(result.status === 404 ? 404 : 502).json({ success: false, error: 'fincra-status-requery-unavailable', providerStatus: result.status })
      }
      const data = result.payload.data
      const reconciliation = reconcileFincraPayoutIdentity(data, row)
      if (!reconciliation.ok) {
        const statusCode = ['successful-payout-record-incomplete', 'unsupported-payout-status'].includes(reconciliation.reason) ? 202 : 409
        return res.status(statusCode).json({
          success: false, error: reconciliation.reason, request: publicRequest(row),
          note: 'Fincra status was not applied because the provider record did not reconcile to this exact Mainnet USDT TRC20 recipient and settlement details. The net amount received is recorded separately from the requested payout amount and any fee.',
        })
      }
      const status = reconciliation.status
      const saved = await db.query(`UPDATE ${SCHEMA}.tron_transfer_sponsor_requests
        SET status=$2,fincra_reference=COALESCE($3,fincra_reference),fincra_status=$4,
            fincra_amount_received_base_units=COALESCE($5,fincra_amount_received_base_units),
            fincra_amount_charged_base_units=COALESCE($6,fincra_amount_charged_base_units),
            fincra_fee_base_units=COALESCE($7,fincra_fee_base_units),
            fincra_successful_at=CASE WHEN $4='successful' THEN COALESCE(fincra_successful_at, now()) ELSE fincra_successful_at END,
            updated_at=now()
        WHERE id=$1 RETURNING *`,
      [row.id, 'fincra-' + (status === 'unknown' ? 'processing' : status), cleanString(data.reference,128) || null, status, reconciliation.amountReceivedBaseUnits, reconciliation.amountChargedBaseUnits, reconciliation.feeBaseUnits])
      return res.json({ success: true, request: publicRequest(saved.rows[0]) })
    } catch {
      return res.status(502).json({ success: false, error: 'fincra-status-requery-failed' })
    }
  })

  router.post('/fincra/webhook', async (req, res) => {
    const config = fincraConfig(env)
    const secret = cleanString(env.FINCRA_WEBHOOK_SECRET, 4096)
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
    const signature = cleanString(req.headers?.signature, 256).toLowerCase()
    if (!secret || !/^[0-9a-f]{128}$/.test(signature) || raw.length === 0) {
      return res.status(401).json({ success: false, error: 'invalid-fincra-webhook-signature' })
    }
    const expected = createHmac('sha512', secret).update(raw).digest()
    const supplied = Buffer.from(signature, 'hex')
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
      return res.status(401).json({ success: false, error: 'invalid-fincra-webhook-signature' })
    }
    if (config.mode !== 'live' || !config.apiKey) {
      return res.status(503).json({ success: false, error: 'live-fincra-reconciliation-unavailable' })
    }
    let payload
    try { payload = JSON.parse(raw.toString('utf8')) } catch { return res.status(400).json({ success: false, error: 'invalid-webhook-json' }) }
    const eventData = payload?.data || {}
    const customerReference = cleanString(eventData.customerReference || eventData.customer_reference, 80)
    if (!/^[A-Za-z0-9._:-]{12,80}$/.test(customerReference)) {
      return res.status(400).json({ success: false, error: 'invalid-payout-customer-reference' })
    }
    const db = getPool(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })
    try {
      await ensureSchema(db)
      const found = await db.query(`SELECT * FROM ${SCHEMA}.tron_transfer_sponsor_requests WHERE customer_reference=$1 LIMIT 1`, [customerReference])
      const row = found.rows[0]
      if (!row) return res.status(200).json({ success: true, matched: false })

      // A valid signature authenticates the webhook, but status updates are
      // reconciled against Fincra's own payout record to reject stale or
      // mismatched notifications before changing the sponsor ledger.
      const lookup = await fetchFincraPayoutByCustomerReference(config, customerReference)
      const payout = lookup?.payload?.data
      if (!lookup?.ok || lookup.payload?.success === false || !payout
        || cleanString(payout.customerReference || payout.customer_reference, 80) !== customerReference) {
        return res.status(503).json({
          success: false, error: 'fincra-webhook-provider-reconciliation-failed',
          note: 'The signed event was not applied because the authoritative payout record could not be retrieved and matched.',
        })
      }

      const signedRecipient = eventData.recipient || {}
      const destinationCurrency = cleanString(payout.destinationCurrency || eventData.destinationCurrency, 8).toUpperCase()
      const sourceCurrency = cleanString(payout.sourceCurrency || eventData.sourceCurrency, 8).toUpperCase()
      const paymentScheme = cleanString(payout.paymentScheme || eventData.paymentScheme, 32).toLowerCase()
      const paymentDestination = cleanString(payout.paymentDestination || eventData.paymentDestination, 32).toLowerCase()
      const providerReference = cleanString(payout.reference, 128)
      const webhookReference = cleanString(eventData.reference, 128)
      if (sourceCurrency !== 'USDT' || destinationCurrency !== 'USDT'
        || paymentScheme !== 'usdt_trc20' || paymentDestination !== 'crypto_wallet'
        || (webhookReference && providerReference && webhookReference !== providerReference)) {
        return res.status(409).json({
          success: false, error: 'fincra-webhook-payout-identity-mismatch',
          note: 'The signed event and authoritative Fincra payout record must identify this exact USDT TRC20 crypto-wallet settlement.',
        })
      }

      const providerRecipient = cleanString(
        payout.beneficiary?.walletAddress || payout.beneficiary?.address || payout.recipient?.walletAddress
          || payout.recipient?.address || payout.recipient?.accountNumber || payout.walletAddress, 64,
      )
      const signedEventRecipient = cleanString(
        signedRecipient.walletAddress || signedRecipient.address || signedRecipient.accountNumber || eventData.walletAddress, 64,
      )
      if ((providerRecipient && providerRecipient !== row.recipient_address)
        || (signedEventRecipient && signedEventRecipient !== row.recipient_address)) {
        return res.status(409).json({ success: false, error: 'fincra-webhook-recipient-mismatch' })
      }
      const parseOptionalAmount = (value) => value === undefined || value === null ? null : parseUsdtBalanceBaseUnits(value)
      const providerReceived = parseOptionalAmount(payout.amountReceived)
      const signedReceived = parseOptionalAmount(eventData.amountReceived)
      const providerCharged = parseOptionalAmount(payout.amountCharged)
      const signedCharged = parseOptionalAmount(eventData.amountCharged)
      const providerFee = parseOptionalAmount(payout.fee)
      const signedFee = parseOptionalAmount(eventData.fee)
      const parsedAmountPairs = [
        [payout.amountReceived, providerReceived], [eventData.amountReceived, signedReceived],
        [payout.amountCharged, providerCharged], [eventData.amountCharged, signedCharged],
        [payout.fee, providerFee], [eventData.fee, signedFee],
      ]
      if (parsedAmountPairs.some(([raw, parsed]) => raw !== undefined && raw !== null && parsed === null)) {
        return res.status(409).json({ success: false, error: 'fincra-webhook-settlement-amount-invalid' })
      }
      if (providerReceived !== null && signedReceived !== null && providerReceived !== signedReceived) {
        return res.status(409).json({ success: false, error: 'fincra-webhook-provider-event-received-amount-conflict' })
      }
      if (providerCharged !== null && signedCharged !== null && providerCharged !== signedCharged) {
        return res.status(409).json({ success: false, error: 'fincra-webhook-provider-event-charged-amount-conflict' })
      }
      if (providerFee !== null && signedFee !== null && providerFee !== signedFee) {
        return res.status(409).json({ success: false, error: 'fincra-webhook-provider-event-fee-conflict' })
      }
      const verifiedAmount = providerReceived ?? signedReceived
      const chargedAmount = providerCharged ?? signedCharged
      const feeAmount = providerFee ?? signedFee
      if ((verifiedAmount !== null && verifiedAmount <= 0n) || (chargedAmount !== null && chargedAmount <= 0n)
        || (feeAmount !== null && feeAmount < 0n) || (verifiedAmount !== null && chargedAmount !== null && chargedAmount < verifiedAmount)
        || (feeAmount !== null && chargedAmount !== null && feeAmount > chargedAmount)) {
        return res.status(409).json({ success: false, error: 'fincra-webhook-settlement-amount-inconsistent' })
      }
      const signedEventHasRecipient = Boolean(signedEventRecipient)
      const providerHasRecipient = Boolean(providerRecipient)
      const providerStatus = payoutStatusFromProvider(payout.status)
      if (providerStatus === 'unknown') {
        // The payout API has a narrower status contract than generic Fincra
        // transaction events. Acknowledge a validly signed, reconciled event
        // but do not mutate payout state for an unsupported status.
        return res.status(200).json({
          success: true,
          matched: true,
          ignored: true,
          reason: 'unsupported-payout-status',
          stateChanged: false,
        })
      }
      if (providerStatus === 'successful' && !providerHasRecipient && !signedEventHasRecipient) {
        return res.status(503).json({
          success: false, error: 'fincra-webhook-recipient-unverified',
          note: 'Neither the authoritative Fincra payout record nor the signed webhook identifies the actual wallet recipient. No successful payout status was applied.',
        })
      }
      if (providerStatus === 'successful' && verifiedAmount === null) {
        return res.status(503).json({
          success: false, error: 'fincra-webhook-settlement-amount-unverified',
          note: 'Fincra did not return a verifiable received USDT amount. The platform will not record a successful payout until provider reconciliation supplies it.',
        })
      }

      const saved = await db.query(`UPDATE ${SCHEMA}.tron_transfer_sponsor_requests
        SET status=CASE
              WHEN fincra_status IN ('successful','failed') AND fincra_status<>$3 THEN status
              ELSE $2 END,
            fincra_status=CASE
              WHEN fincra_status IN ('successful','failed') AND fincra_status<>$3 THEN fincra_status
              ELSE $3 END,
            fincra_reference=COALESCE($4,fincra_reference),
            fincra_amount_received_base_units=COALESCE($6,fincra_amount_received_base_units),
            fincra_amount_charged_base_units=COALESCE($7,fincra_amount_charged_base_units),
            fincra_fee_base_units=COALESCE($8,fincra_fee_base_units),
            fincra_successful_at=CASE WHEN $3='successful' THEN COALESCE(fincra_successful_at, now()) ELSE fincra_successful_at END,
            fincra_webhook_event=$5,fincra_webhook_received_at=now(),updated_at=now()
        WHERE id=$1 RETURNING id,fincra_status,status`,
      [row.id, 'fincra-' + providerStatus, providerStatus, providerReference || null, cleanString(payload?.event,128) || null,
        verifiedAmount?.toString() || null, chargedAmount?.toString() || null, feeAmount?.toString() || null])
      return res.status(200).json({
        success: true, matched: saved.rowCount > 0,
        reconciledStatus: saved.rows[0]?.fincra_status || row.fincra_status || null,
        note: 'Webhook signature verified and event reconciled against the authoritative Fincra payout record. On-chain recipient delivery remains a separate Tatum verification step.',
      })
    } catch {
      return res.status(503).json({ success: false, error: 'webhook-persistence-or-provider-reconciliation-unavailable' })
    }
  })

  router.post('/sponsor-requests/:id/verify-recipient-transfer', async (req, res) => {
    const ownerAuth = await requireOwnerSession(req, env)
    const requesterAuth = ownerAuth.ok ? null : await requireRequesterWalletSession(req, env)
    if (!ownerAuth.ok && !requesterAuth?.ok) {
      return res.status(requesterAuth?.status || ownerAuth.status)
        .json({ success: false, error: requesterAuth?.error || ownerAuth.error })
    }
    const db = getPool(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })
    try {
      await ensureSchema(db)
      const row = await findRequest(db, req.params.id)
      if (!row) return res.status(404).json({ success: false, error: 'sponsor-request-not-found' })
      if (requesterAuth && row.requester_address !== requesterAuth.address) {
        return res.status(403).json({ success: false, error: 'requester-does-not-own-this-payout-request' })
      }
      if (row.fincra_status !== 'successful') {
        return res.status(409).json({ success: false, error: 'fincra-payout-not-successful', fincraStatus: row.fincra_status })
      }
      const { TronWeb } = await import('tronweb')
      const tronWeb = new TronWeb({ fullHost: 'https://tron-mainnet.gateway.tatum.io' })
      const historyResult = await readTronGridIncomingHistory({
        network: 'mainnet',
        address: row.recipient_address,
        tokenContract: MAINNET_USDT,
        apiKey: cleanString(env.TRONGRID_API_KEY, 2048),
        decodeAddress: (hex) => tronWeb.address.fromHex(hex),
      })
      if (!historyResult.tokenHistoryRead) {
        return res.status(502).json({ success: false, error: 'recipient-transfer-history-unavailable', providerErrors: historyResult.providerErrors })
      }
      const receivedAmountBaseUnits = row.fincra_amount_received_base_units == null ? null : String(row.fincra_amount_received_base_units)
      if (!receivedAmountBaseUnits) {
        return res.status(202).json({
          success: false, error: 'fincra-recipient-amount-not-recorded',
          note: 'Fincra settlement is marked successful, but its actual net recipient amount has not been reconciled. Refresh the authoritative Fincra status or webhook before checking the exact on-chain transfer amount.',
        })
      }
      const payoutStartMs = new Date(row.fincra_submitted_at || row.created_at).getTime() - 120000
      const payoutEndMs = new Date(row.fincra_successful_at || row.updated_at).getTime() + 10 * 60 * 1000
      const rows = historyResult.history.filter((item) => item.to === row.recipient_address
        && item.tokenContract === MAINNET_USDT && item.amountBaseUnits === receivedAmountBaseUnits
        && Number.isFinite(Number(item.timestamp)) && Number(item.timestamp) >= payoutStartMs
        && Number(item.timestamp) <= payoutEndMs)
      if (rows.length === 1) {
        const chain = await verifySolidifiedUsdtTransfer(env, {
          transactionHash: rows[0].txid,
          from: rows[0].from,
          to: row.recipient_address,
          amountBaseUnits: receivedAmountBaseUnits,
        })
        if (chain.verified !== true) {
          await db.query(`UPDATE ${SCHEMA}.tron_transfer_sponsor_requests
            SET transaction_hash=$2,chain_verification_status='not-verified',chain_verification_reason=$3,updated_at=now()
            WHERE id=$1`, [row.id, rows[0].txid, chain.status])
          return res.status(202).json({
            success: false,
            verification: { ...chain, historyCandidate: rows[0].txid },
            note: 'TRON confirmed account history found one candidate, but the Tatum solidified transaction body and successful receipt/Transfer event did not all verify. No recipient credit is claimed.',
          })
        }
        const saved = await db.query(`UPDATE ${SCHEMA}.tron_transfer_sponsor_requests
          SET transaction_hash=$2,chain_verification_status='solidified-recipient-transfer-verified',chain_verification_reason='solidified-transaction-body-success-receipt-and-unique-usdt-transfer-event',updated_at=now()
          WHERE id=$1 RETURNING *`, [row.id, rows[0].txid])
        return res.json({
          success: true, request: publicRequest(saved.rows[0]),
          verification: chain,
          note: 'The exact official Mainnet USDT contract, sender, recipient and amount matched one successful solidified transaction and one matching Transfer event. This proves on-chain transfer to the recipient address; it does not prove an exchange has posted an internal account credit.',
        })
      }
      const reason = rows.length > 1 ? 'multiple-matching-incoming-transfers' : 'no-matching-confirmed-incoming-transfer'
      await db.query(`UPDATE ${SCHEMA}.tron_transfer_sponsor_requests
        SET chain_verification_status='not-verified',chain_verification_reason=$2,updated_at=now() WHERE id=$1`, [row.id, reason])
      return res.status(202).json({
        success: false, verification: { status: rows.length > 1 ? 'ambiguous' : 'not-found', reason, candidates: rows.length },
        note: 'Fincra status and TRON recipient transfer evidence are separate checks. No successful recipient credit is claimed.',
      })
    } catch {
      return res.status(502).json({ success: false, error: 'recipient-transfer-verification-unavailable' })
    }
  })

  return router
}

export default createTronTransferRouter
