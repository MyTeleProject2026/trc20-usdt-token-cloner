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
    res.setHeader('Cache-Control', 'no-store, private')
    const auth = await requireOwnerSession(req, env)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    return res.status(410).json({
      success: false,
      error: 'legacy-fincra-funding-history-disabled',
      providerRequestMade: false,
      message: 'Fincra funding history is disabled in the private provider-neutral deployment.',
    })
  })

  router.get('/readiness', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    const auth = await requireOwnerSession(req, env)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const readiness = getUnconfiguredProviderPayoutReadiness()
    return res.json({
      success: true,
      status: readiness.status,
      platformMode: 'private-owner-only',
      ownerAddress: auth.address,
      tatumMainnetConfigured: Boolean(configuredApiKey(env, 'mainnet')),
      databaseConfigured: Boolean(env.DATABASE_URL),
      legacyFincra: {
        enabled: false,
        submissionEnabled: false,
        providerRequestsMade: false,
        reason: 'legacy-provider-disabled',
      },
      providerPayout: readiness,
      limitations: [
        'This endpoint does not call Fincra or another payout provider.',
        'A genuine payout requires provider authorization and verified provider-owned USDT liquidity or an approved credit facility.',
        'Tatum supplies TRON infrastructure and verification, not payout principal.',
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
    res.setHeader('Cache-Control', 'no-store, private')
    const auth = await requireOwnerSession(req, env)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
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
    res.setHeader('Cache-Control', 'no-store, private')
    const auth = await requireOwnerSession(req, env)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
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

  router.post('/sponsor-requests', (_req, res) => res.status(410).json({
    success: false, error: 'legacy-sponsor-request-intake-disabled', payoutSubmitted: false,
  }))
  router.get('/sponsor-requests/mine', (_req, res) => res.status(410).json({
    success: false, error: 'legacy-sponsor-request-history-disabled',
  }))
  router.get('/sponsor-requests', (_req, res) => res.status(410).json({
    success: false, error: 'legacy-sponsor-request-review-disabled',
  }))

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
    res.setHeader('Cache-Control', 'no-store, private')
    const auth = await requireOwnerSession(req, env)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    return res.status(410).json({
      success: false,
      error: 'legacy-fincra-status-polling-disabled',
      providerRequestMade: false,
    })
  })

  router.post('/fincra/webhook', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    return res.status(410).json({
      success: false,
      error: 'legacy-fincra-webhook-disabled',
      eventProcessed: false,
    })
  })

  return router
}

export default createTronTransferRouter
