import { createHash } from 'node:crypto'
import { Router } from 'express'
import pg from 'pg'
import { TronWeb } from 'tronweb'
import {
  createFireblocksClient,
  fireblocksConfiguration,
  extractFireblocksAddresses,
  providerAssetAvailableBaseUnits,
  fireblocksAssetIdentifierMatches,
  isOfficialFireblocksUsdtAsset,
  classifyFireblocksTransaction,
  isNativeFireblocksTrxAsset,
} from '../fireblocks-client.mjs'
import { getWalletAuthSession, normalizeDatabaseConnectionString, databaseSslConfig } from '../database.mjs'
import {
  buildTreasuryWithdrawalAuthorizationMessage,
  buildTreasuryTrxWithdrawalAuthorizationMessage,
  isTreasuryAuthorizationExpiryValid,
} from '../../src/treasury-withdrawal-auth.mjs'

const { Pool } = pg
const MAINNET_RPC = 'https://api.trongrid.io'
const USDT_MAINNET = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const ADDRESS_PATTERN = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const TXID_PATTERN = /^[0-9a-f]{64}$/i
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9._:-]{24,128}$/
const SESSION_PATTERN = /^[A-Za-z0-9_-]{43}$/
const OWNER_PAYOUT_SIGNATURE_PATTERN = /^0x[0-9a-f]{130}$/i
const OWNER_PAYOUT_AUTHORIZATION_MAX_FUTURE_MS = 120_000
const UINT256_MAX = (1n << 256n) - 1n
/**
 * Require the console's only permitted owner and the payout authorizer to be
 * the exact same TRON address. This prevents an accidental split-owner setup.
 */
export function isUnifiedTreasuryOwnerConfiguration(env = process.env) {
  const consoleOwner = typeof env.OWNER_WALLET_ADDRESS === 'string' ? env.OWNER_WALLET_ADDRESS.trim() : ''
  const treasuryOwner = typeof env.TREASURY_OWNER_ADDRESS === 'string' ? env.TREASURY_OWNER_ADDRESS.trim() : ''
  return ADDRESS_PATTERN.test(consoleOwner)
    && ADDRESS_PATTERN.test(treasuryOwner)
    && consoleOwner === treasuryOwner
}

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
          status TEXT NOT NULL CHECK (status IN ('broadcasting','provider-pending','broadcast-accepted','broadcast-unknown','rejected')),
          transaction_hash CHAR(64),
          provider_transaction_id TEXT,
          provider_status TEXT,
          failure_code TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `)
      await db.query(`ALTER TABLE trc20_token_clone.treasury_withdrawal_requests DROP CONSTRAINT IF EXISTS treasury_withdrawal_requests_status_check`)
      await db.query(`ALTER TABLE trc20_token_clone.treasury_withdrawal_requests
        ADD CONSTRAINT treasury_withdrawal_requests_status_check
        CHECK (status IN ('broadcasting','provider-pending','broadcast-accepted','broadcast-unknown','rejected','confirmed','failed'))`)
      await db.query(`ALTER TABLE trc20_token_clone.treasury_withdrawal_requests ADD COLUMN IF NOT EXISTS provider_transaction_id TEXT`)
      await db.query(`ALTER TABLE trc20_token_clone.treasury_withdrawal_requests ADD COLUMN IF NOT EXISTS provider_status TEXT`)
      await db.query(`
        CREATE TABLE IF NOT EXISTS trc20_token_clone.treasury_trx_withdrawal_requests (
          id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          idempotency_key TEXT NOT NULL UNIQUE,
          owner_address TEXT NOT NULL,
          treasury_address TEXT NOT NULL,
          recipient_address TEXT NOT NULL,
          amount_base_units NUMERIC(78,0) NOT NULL CHECK (amount_base_units > 0),
          status TEXT NOT NULL CHECK (status IN ('broadcasting','provider-pending','broadcast-accepted','broadcast-unknown','rejected')),
          transaction_hash CHAR(64),
          provider_transaction_id TEXT,
          provider_status TEXT,
          failure_code TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `)
      await db.query(`ALTER TABLE trc20_token_clone.treasury_trx_withdrawal_requests DROP CONSTRAINT IF EXISTS treasury_trx_withdrawal_requests_status_check`)
      await db.query(`ALTER TABLE trc20_token_clone.treasury_trx_withdrawal_requests
        ADD CONSTRAINT treasury_trx_withdrawal_requests_status_check
        CHECK (status IN ('broadcasting','provider-pending','broadcast-accepted','broadcast-unknown','rejected','confirmed','failed'))`)
      await db.query(`ALTER TABLE trc20_token_clone.treasury_trx_withdrawal_requests ADD COLUMN IF NOT EXISTS provider_transaction_id TEXT`)
      await db.query(`ALTER TABLE trc20_token_clone.treasury_trx_withdrawal_requests ADD COLUMN IF NOT EXISTS provider_status TEXT`)
    })().catch((error) => { schemaPromise = null; throw error })
  }
  await schemaPromise
}

function parsePositiveDecimal(value, decimals = 6) {
  // Request bodies are bounded by the API, but bound numeric input too: a huge
  // decimal string can waste CPU and a value above uint256 cannot fit a TRC-20.
  if (typeof value !== 'string' || value.length > 86
    || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)) return null
  const [whole, fraction = ''] = value.split('.')
  if (whole.length > 78 || fraction.length > decimals) return null
  const units = BigInt(whole) * (10n ** BigInt(decimals)) + BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals) || '0')
  return units > 0n && units <= UINT256_MAX ? units : null
}

function readLimit(value) {
  return typeof value === 'string' ? parsePositiveDecimal(value, 6) : null
}

function formatUnitsDecimal(value, decimals = 6) {
  let units
  try { units = BigInt(String(value)) } catch { return null }
  if (units < 0n || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null
  const scale = 10n ** BigInt(decimals)
  const whole = units / scale
  const fraction = (units % scale).toString().padStart(decimals, '0').replace(/0+$/, '')
  return fraction ? whole.toString() + '.' + fraction : whole.toString()
}

/**
 * Conservative fee preflight. A treasury payout is enabled only when its actual
 * TRX balance covers the configured maximum fee cap. This route does not assume
 * a gas sponsor exists or treat an unverified delegation as fee coverage.
 */
export function treasuryFeeCapCovered(balanceSun, feeLimitSun) {
  const balance = typeof balanceSun === 'string' || typeof balanceSun === 'number' ? String(balanceSun) : ''
  const limit = typeof feeLimitSun === 'string' || typeof feeLimitSun === 'number' ? String(feeLimitSun) : ''
  if (!/^(0|[1-9][0-9]{0,20})$/.test(balance)
    || !/^[1-9][0-9]{0,9}$/.test(limit)) return false
  return BigInt(balance) >= BigInt(limit)
}

/**
 * Conservative balance available for a new treasury payout. Pending/ambiguous
 * withdrawals remain reserved until their chain outcome is reconciled.
 */
export function unreservedTreasuryBalance(balanceBaseUnits, outstandingReservationBaseUnits) {
  const balance = typeof balanceBaseUnits === 'string' ? balanceBaseUnits : String(balanceBaseUnits ?? '')
  const reserved = typeof outstandingReservationBaseUnits === 'string'
    ? outstandingReservationBaseUnits : String(outstandingReservationBaseUnits ?? '')
  if (!/^(0|[1-9][0-9]{0,77})$/.test(balance)
    || !/^(0|[1-9][0-9]{0,77})$/.test(reserved)) return null
  const balanceValue = BigInt(balance)
  const reservedValue = BigInt(reserved)
  return (balanceValue > reservedValue ? balanceValue - reservedValue : 0n).toString()
}

/** Idempotency keys are bound to the original owner, recipient and amount. */
export function matchesTreasuryWithdrawalRequest(row, {
  ownerAddress,
  treasuryAddress,
  recipientAddress,
  amountBaseUnits,
} = {}) {
  if (!row || typeof row !== 'object') return false
  try {
    return row.owner_address === ownerAddress
      && row.treasury_address === treasuryAddress
      && row.recipient_address === recipientAddress
      && row.token_contract === USDT_MAINNET
      && BigInt(String(row.amount_base_units)) === BigInt(String(amountBaseUnits))
  } catch {
    return false
  }
}

function bearerToken(req) {
  const value = req.get('authorization') || ''
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(value)
  return match ? match[1] : ''
}

function normalizedHex(value) {
  return typeof value === 'string' ? value.replace(/^0x/i, '').toLowerCase() : ''
}

/** Verify a one-request owner signature without ever accepting a private key from the client. */
export async function verifyTreasuryOwnerPayoutSignature(tronWeb, { message, signature, expectedOwnerAddress } = {}) {
  if (typeof message !== 'string' || !message
    || typeof expectedOwnerAddress !== 'string' || !ADDRESS_PATTERN.test(expectedOwnerAddress)
    || typeof signature !== 'string' || !OWNER_PAYOUT_SIGNATURE_PATTERN.test(signature)
    || typeof tronWeb?.trx?.verifyMessageV2 !== 'function') return false
  try {
    const recoveredAddress = await tronWeb.trx.verifyMessageV2(message, signature)
    return recoveredAddress === expectedOwnerAddress
  } catch {
    return false
  }
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
    // A successful VM receipt alone is not enough to report that USDT moved:
    // require the event emitted by the official Tether TRON token contract.
    const transferTopic = 'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
    const contractAddress = expectedContract.replace(/^41(?=[0-9a-f]{40}$)/, '')
    const fromTopic = expectedOwner.replace(/^41(?=[0-9a-f]{40}$)/, '').padStart(64, '0')
    const toTopic = expectedRecipient.replace(/^41(?=[0-9a-f]{40}$)/, '').padStart(64, '0')
    const expectedData = BigInt(amountBaseUnits).toString(16).padStart(64, '0')
    const logs = Array.isArray(transactionInfo?.log) ? transactionInfo.log : []
    const tokenTransferLogs = logs.filter((log) => {
      const logAddress = normalizedHex(log?.address).replace(/^41(?=[0-9a-f]{40}$)/, '')
      return logAddress === contractAddress
        && Array.isArray(log?.topics)
        && normalizedHex(log.topics[0]) === transferTopic
    })
    const exactTransferEvents = tokenTransferLogs.filter((log) =>
      log.topics.length >= 3
      && normalizedHex(log.topics[1]).padStart(64, '0') === fromTopic
      && normalizedHex(log.topics[2]).padStart(64, '0') === toTopic
      && normalizedHex(log.data).padStart(64, '0') === expectedData)
    if (tokenTransferLogs.length !== 1 || exactTransferEvents.length !== 1) {
      return { verified: false, status: 'verification-mismatch', reason: 'official-usdt-transfer-event-missing-or-mismatched' }
    }
    return { verified: true, status: 'confirmed', reason: 'confirmed-solidified-successful-receipt-and-transfer-event', blockNumber: transactionInfo.blockNumber }
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
    ...(row.provider_transaction_id ? { providerTransactionId: String(row.provider_transaction_id) } : {}),
    ...(row.provider_status ? { providerStatus: String(row.provider_status) } : {}),
    ...(row.failure_code ? { failureCode: row.failure_code } : {}),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  }
}

export function matchesTreasuryTrxWithdrawalRequest(row, {
  ownerAddress,
  treasuryAddress,
  recipientAddress,
  amountBaseUnits,
} = {}) {
  if (!row || typeof row !== 'object') return false
  try {
    return row.owner_address === ownerAddress
      && row.treasury_address === treasuryAddress
      && row.recipient_address === recipientAddress
      && BigInt(String(row.amount_base_units)) === BigInt(String(amountBaseUnits))
  } catch {
    return false
  }
}

function safeTrxStatus(row) {
  return {
    idempotencyKey: row.idempotency_key,
    network: 'mainnet',
    asset: 'TRX',
    tokenContract: null,
    treasuryAddress: row.treasury_address,
    recipientAddress: row.recipient_address,
    amountBaseUnits: String(row.amount_base_units),
    decimals: 6,
    status: row.status,
    ...(row.transaction_hash ? { transactionHash: String(row.transaction_hash).trim() } : {}),
    ...(row.provider_transaction_id ? { providerTransactionId: String(row.provider_transaction_id) } : {}),
    ...(row.provider_status ? { providerStatus: String(row.provider_status) } : {}),
    ...(row.failure_code ? { failureCode: row.failure_code } : {}),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  }
}

export function trxConfiguration(env = process.env) {
  const provider = fireblocksConfiguration(env)
  const required = [
    'DATABASE_URL', 'OWNER_WALLET_ADDRESS', 'TREASURY_OWNER_ADDRESS',
    'TREASURY_ADDRESS', 'TREASURY_MAX_PAYOUT_TRX', 'TREASURY_DAILY_LIMIT_TRX',
    'TREASURY_FEE_LIMIT_SUN', 'FIREBLOCKS_TRX_ASSET_ID',
  ]
  const missing = required.filter((key) => typeof env[key] !== 'string' || !env[key].trim())
  if (!provider.configured) missing.push(...provider.missing)
  if (!provider.trxAssetConfigured) missing.push('FIREBLOCKS_TRX_ASSET_ID')
  if (env.TREASURY_SIGNER_MODE !== 'fireblocks') missing.push('TREASURY_SIGNER_MODE=fireblocks')
  if (env.TREASURY_TRX_WITHDRAWALS_ENABLED !== 'true') missing.push('TREASURY_TRX_WITHDRAWALS_ENABLED=true')

  const ownerAddressesMatch = isUnifiedTreasuryOwnerConfiguration(env)
  const maxPayout = readLimit(env.TREASURY_MAX_PAYOUT_TRX)
  const dailyLimit = readLimit(env.TREASURY_DAILY_LIMIT_TRX)
  const feeLimit = typeof env.TREASURY_FEE_LIMIT_SUN === 'string' && /^\d+$/.test(env.TREASURY_FEE_LIMIT_SUN)
    ? BigInt(env.TREASURY_FEE_LIMIT_SUN) : 0n
  const enabled = missing.length === 0
    && ownerAddressesMatch
    && ADDRESS_PATTERN.test(env.TREASURY_ADDRESS || '')
    && maxPayout !== null && dailyLimit !== null
    && feeLimit >= 1n && feeLimit <= 1_000_000_000n
  return {
    enabled,
    missing: [...new Set(missing)],
    ownerAddressesMatch,
    maxPayout,
    dailyLimit,
    feeLimit,
    signerMode: env.TREASURY_SIGNER_MODE === 'fireblocks' ? 'fireblocks-managed' : 'not-configured',
  }
}
function nativeTrxIntentMatches(tronWeb, transaction, {
  treasuryAddress,
  recipientAddress,
  amountBaseUnits,
} = {}) {
  const contracts = transaction?.raw_data?.contract
  if (!Array.isArray(contracts) || contracts.length !== 1 || contracts[0]?.type !== 'TransferContract') return false
  try {
    const expectedFrom = normalizedHex(tronWeb.address.toHex(treasuryAddress))
    const expectedTo = normalizedHex(tronWeb.address.toHex(recipientAddress))
    const value = contracts[0]?.parameter?.value
    if (!expectedFrom || !expectedTo
      || normalizedHex(value?.owner_address) !== expectedFrom
      || normalizedHex(value?.to_address) !== expectedTo
      || !/^(0|[1-9][0-9]{0,77})$/.test(String(value?.amount))) return false
    return BigInt(String(value.amount)) === BigInt(String(amountBaseUnits))
  } catch {
    return false
  }
}

/** Verify an exact native TRX transfer in a confirmed/solidified transaction. */
export function verifyTreasuryTrxTransferEvidence(tronWeb, {
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
    || !nativeTrxIntentMatches(tronWeb, transaction, { treasuryAddress, recipientAddress, amountBaseUnits })) {
    return transaction && transactionInfo ? { verified: false, status: 'verification-mismatch', reason: 'native-transfer-intent-mismatch' } : pending
  }
  if (!Number.isSafeInteger(transactionInfo?.blockNumber) || transactionInfo.blockNumber < 1) return pending
  const executionResults = [
    transaction?.ret?.[0]?.contractRet,
    transactionInfo?.receipt?.result,
  ].filter((value) => typeof value === 'string' && value.length > 0)
  if (executionResults.some((value) => value !== 'SUCCESS')) {
    return { verified: true, status: 'failed', reason: 'confirmed-solidified-failed-transfer', blockNumber: transactionInfo.blockNumber }
  }
  // A confirmed native TransferContract has no contract event. Verify its exact
  // sender, recipient and amount in the solidified transaction instead.
  return {
    verified: true,
    status: 'confirmed',
    reason: executionResults.length ? 'confirmed-solidified-successful-native-transfer' : 'confirmed-solidified-native-transfer-intent',
    blockNumber: transactionInfo.blockNumber,
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
  tronWebFactory = (privateKey) => new TronWeb({
    fullHost: MAINNET_RPC,
    ...(privateKey ? { privateKey } : {}),
    ...(typeof env.TRONGRID_API_KEY === 'string' && env.TRONGRID_API_KEY.trim()
      ? { headers: { 'TRON-PRO-API-KEY': env.TRONGRID_API_KEY.trim() } }
      : {}),
  }),
  fireblocksClientFactory = (currentEnv) => createFireblocksClient(currentEnv),
  now = () => new Date(),
} = {}) {
  const router = Router()
  const managedSigner = () => fireblocksClientFactory(env)

  async function authenticateOwner(req) {
    const origin = req.get('origin')
    const token = bearerToken(req)
    const expectedOwner = typeof env.TREASURY_OWNER_ADDRESS === 'string' ? env.TREASURY_OWNER_ADDRESS.trim() : ''
    if (!token || !origin || !ADDRESS_PATTERN.test(expectedOwner)) return { ok: false, status: 401, error: 'owner-auth-required' }
    // The UI login identity and treasury signing identity must be one and the
    // same configured wallet. Fail closed if environment settings drift apart.
    if (!isUnifiedTreasuryOwnerConfiguration(env)) {
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
    const provider = fireblocksConfiguration(env)
    const required = [
      'DATABASE_URL', 'OWNER_WALLET_ADDRESS', 'TREASURY_OWNER_ADDRESS',
      'TREASURY_ADDRESS', 'TREASURY_MAX_PAYOUT_USDT', 'TREASURY_DAILY_LIMIT_USDT',
      'TREASURY_FEE_LIMIT_SUN',
    ]
    const missing = required.filter((key) => typeof env[key] !== 'string' || !env[key].trim())
    const ownerAddressesMatch = isUnifiedTreasuryOwnerConfiguration(env)
    const maxPayout = readLimit(env.TREASURY_MAX_PAYOUT_USDT)
    const dailyLimit = readLimit(env.TREASURY_DAILY_LIMIT_USDT)
    const feeLimitValid = /^\d+$/.test(env.TREASURY_FEE_LIMIT_SUN || '')
      && Number(env.TREASURY_FEE_LIMIT_SUN) >= 1
      && Number(env.TREASURY_FEE_LIMIT_SUN) <= 1_000_000_000
    if (!provider.configured) missing.push(...provider.missing)
    const enabled = env.TREASURY_WITHDRAWALS_ENABLED === 'true'
      && env.TREASURY_SIGNER_MODE === 'fireblocks'
      && missing.length === 0 && ownerAddressesMatch
      && ADDRESS_PATTERN.test(env.TREASURY_ADDRESS || '')
      && Boolean(maxPayout) && Boolean(dailyLimit) && feeLimitValid
    return {
      enabled, missing: [...new Set(missing)], ownerAddressesMatch,
      signerMode: env.TREASURY_SIGNER_MODE === 'fireblocks' ? 'fireblocks-managed' : 'not-configured',
      providerConfigured: provider.configured,
    }
  }

  async function readManagedTreasurySnapshot(treasuryAddress) {
    const fireblocks = managedSigner()
    if (typeof fireblocks?.isConfigured !== 'function' || fireblocks.isConfigured() !== true) {
      return { ok: false, reason: 'fireblocks-not-configured' }
    }
    try {
      const tronWeb = tronWebFactory()
      if (!tronWeb?.isAddress?.(treasuryAddress) || typeof tronWeb.contract !== 'function'
        || typeof tronWeb?.trx?.getBalance !== 'function') {
        return { ok: false, reason: 'tron-read-provider-unavailable' }
      }
      const [assetMetadata, providerAsset, addressResponse] = await Promise.all([
        fireblocks.getAssetMetadata(), fireblocks.getVaultAccountAsset(), fireblocks.getAssetAddresses(),
      ])
      if (!fireblocksAssetIdentifierMatches(assetMetadata, String(env.FIREBLOCKS_USDT_ASSET_ID || ''))
        || (providerAsset?.id !== undefined && String(providerAsset.id) !== String(env.FIREBLOCKS_USDT_ASSET_ID || ''))
        || !isOfficialFireblocksUsdtAsset(assetMetadata, tronWeb, USDT_MAINNET)) {
        return { ok: false, reason: 'fireblocks-asset-not-official-tron-usdt' }
      }
      const addresses = [...new Set(extractFireblocksAddresses(addressResponse))]
      if (addresses.length !== 1 || addresses[0] !== treasuryAddress) {
        return { ok: false, reason: 'fireblocks-vault-address-mismatch' }
      }
      const providerAvailable = providerAssetAvailableBaseUnits(providerAsset)
      if (providerAvailable === null) return { ok: false, reason: 'fireblocks-available-balance-unavailable' }
      const [nativeBalance, contract] = await Promise.all([
        tronWeb.trx.getBalance(treasuryAddress), tronWeb.contract(ABI).at(USDT_MAINNET),
      ])
      const nativeText = String(nativeBalance)
      if (!/^(0|[1-9][0-9]{0,20})$/.test(nativeText)) return { ok: false, reason: 'treasury-trx-balance-unavailable' }
      const [decimals, symbol, rawBalance] = await Promise.all([
        contract.decimals().call(), contract.symbol().call(), contract.balanceOf(treasuryAddress).call(),
      ])
      const balanceText = String(rawBalance)
      if (Number(decimals) !== 6 || String(symbol).toUpperCase() !== 'USDT'
        || !/^(0|[1-9][0-9]{0,77})$/.test(balanceText)) {
        return { ok: false, reason: 'official-token-balance-unverified' }
      }
      const chainBalance = BigInt(balanceText)
      const providerAvailableUnits = BigInt(providerAvailable)
      const spendable = chainBalance < providerAvailableUnits ? chainBalance : providerAvailableUnits
      const feeCapSun = /^\d+$/.test(env.TREASURY_FEE_LIMIT_SUN || '') ? String(env.TREASURY_FEE_LIMIT_SUN) : null
      return {
        ok: true, treasuryAddress, providerAssetId: String(assetMetadata.id),
        providerAvailableBaseUnits: providerAvailable.toString(),
        treasuryUsdtBalanceBaseUnits: chainBalance.toString(),
        spendableUsdtBaseUnits: spendable.toString(),
        treasuryTrxBalanceSun: nativeText, treasuryFeeLimitSun: feeCapSun,
        networkFeeCapCovered: treasuryFeeCapCovered(nativeText, feeCapSun),
        contractMetadataVerified: true, vaultAddressVerified: true,
      }
    } catch {
      return { ok: false, reason: 'provider-or-chain-read-unavailable' }
    }
  }


  /**
   * Read-only Fireblocks + TRON snapshot for native TRX payouts. The usable
   * amount is the lower of provider-available TRX and actual on-chain TRX.
   */
  async function readManagedTreasuryTrxSnapshot(treasuryAddress) {
    const fireblocks = managedSigner()
    const assetId = typeof env.FIREBLOCKS_TRX_ASSET_ID === 'string' ? env.FIREBLOCKS_TRX_ASSET_ID.trim() : ''
    if (typeof fireblocks?.isConfigured !== 'function' || fireblocks.isConfigured() !== true
      || typeof fireblocks?.isTrxAssetConfigured !== 'function' || fireblocks.isTrxAssetConfigured() !== true
      || !assetId) {
      return { ok: false, reason: 'fireblocks-trx-asset-not-configured' }
    }
    try {
      const tronWeb = tronWebFactory()
      if (!tronWeb?.isAddress?.(treasuryAddress) || typeof tronWeb?.trx?.getBalance !== 'function') {
        return { ok: false, reason: 'tron-read-provider-unavailable' }
      }
      const [assetMetadata, providerAsset, addressResponse] = await Promise.all([
        fireblocks.getAssetMetadata(assetId),
        fireblocks.getVaultAccountAsset(assetId),
        fireblocks.getAssetAddresses(assetId),
      ])
      if (!isNativeFireblocksTrxAsset(assetMetadata, assetId)
        || (providerAsset?.id !== undefined && !fireblocksAssetIdentifierMatches(providerAsset, assetId))) {
        return { ok: false, reason: 'fireblocks-asset-not-native-trx' }
      }
      const addresses = [...new Set(extractFireblocksAddresses(addressResponse))]
      if (addresses.length !== 1 || addresses[0] !== treasuryAddress) {
        return { ok: false, reason: 'fireblocks-vault-address-mismatch' }
      }
      const providerAvailable = providerAssetAvailableBaseUnits(providerAsset)
      if (providerAvailable === null) return { ok: false, reason: 'fireblocks-trx-available-balance-unavailable' }
      const nativeText = String(await tronWeb.trx.getBalance(treasuryAddress))
      if (!/^(0|[1-9][0-9]{0,20})$/.test(nativeText)) return { ok: false, reason: 'treasury-trx-balance-unavailable' }
      const chainUnits = BigInt(nativeText)
      const providerUnits = BigInt(providerAvailable)
      const spendableUnits = chainUnits < providerUnits ? chainUnits : providerUnits
      return {
        ok: true,
        treasuryAddress,
        providerAssetId: String(assetMetadata.legacyId || assetMetadata.id || assetId),
        providerAvailableBaseUnits: providerUnits.toString(),
        treasuryTrxBalanceSun: nativeText,
        spendableTrxBaseUnits: spendableUnits.toString(),
        vaultAddressVerified: true,
        nativeAssetIdentityVerified: true,
      }
    } catch {
      return { ok: false, reason: 'fireblocks-or-tron-trx-read-unavailable' }
    }
  }

  async function refreshProviderTransaction(db, row) {
    if (!row || ['confirmed', 'failed', 'rejected'].includes(row.status)) return row
    try {
      const fireblocks = managedSigner()
      let providerTx
      if (row.provider_transaction_id) {
        providerTx = await fireblocks.getTransaction(String(row.provider_transaction_id))
      } else if (row.idempotency_key) {
        // Resolve unknown outcomes by the provider's external id before allowing
        // any further action. This is lookup-only; it never creates a transfer.
        providerTx = await fireblocks.findTransactionByExternalId(String(row.idempotency_key))
      } else {
        return row
      }
      const providerId = typeof providerTx?.id === 'string' ? providerTx.id
        : typeof providerTx?.transactionId === 'string' ? providerTx.transactionId
          : String(row.provider_transaction_id || '')
      if (!providerId) return row
      const state = classifyFireblocksTransaction(providerTx)
      const nextStatus = state.localStatus === 'broadcast-accepted' ? 'broadcast-accepted'
        : state.localStatus === 'failed' ? 'failed' : 'provider-pending'
      const updated = await db.query(
        `UPDATE trc20_token_clone.treasury_withdrawal_requests
            SET status=$2, transaction_hash=COALESCE($3, transaction_hash),
                provider_transaction_id=$4, provider_status=$5,
                failure_code=$6, updated_at=now()
          WHERE id=$1 RETURNING *`,
        [row.id, nextStatus, state.transactionHash, providerId, state.providerStatus,
          nextStatus === 'failed' ? 'fireblocks-terminal-' + state.providerStatus.toLowerCase() : null],
      )
      return updated.rows[0] || row
    } catch {
      return row
    }
  }


  async function refreshProviderTrxTransaction(db, row) {
    if (!row || ['confirmed', 'failed', 'rejected'].includes(row.status)) return row
    try {
      const fireblocks = managedSigner()
      let providerTx
      if (row.provider_transaction_id) {
        providerTx = await fireblocks.getTransaction(String(row.provider_transaction_id))
      } else if (row.idempotency_key) {
        providerTx = await fireblocks.findTransactionByExternalId(String(row.idempotency_key))
      } else {
        return row
      }
      const providerId = typeof providerTx?.id === 'string' ? providerTx.id
        : typeof providerTx?.transactionId === 'string' ? providerTx.transactionId
          : String(row.provider_transaction_id || '')
      if (!providerId) return row
      const state = classifyFireblocksTransaction(providerTx)
      const nextStatus = state.localStatus === 'broadcast-accepted' ? 'broadcast-accepted'
        : state.localStatus === 'failed' ? 'failed' : 'provider-pending'
      const updated = await db.query(
        \`UPDATE trc20_token_clone.treasury_trx_withdrawal_requests
            SET status=$2, transaction_hash=COALESCE($3, transaction_hash),
                provider_transaction_id=$4, provider_status=$5,
                failure_code=$6, updated_at=now()
          WHERE id=$1 RETURNING *\`,
        [row.id, nextStatus, state.transactionHash, providerId, state.providerStatus,
          nextStatus === 'failed' ? 'fireblocks-terminal-' + state.providerStatus.toLowerCase() : null],
      )
      return updated.rows[0] || row
    } catch {
      return row
    }
  }

  router.get('/withdrawals/readiness', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    res.setHeader('Pragma', 'no-cache')
    const auth = await authenticateOwner(req)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const config = configuration()
    const db = getPool(env)
    let databaseReady = false
    if (db) { try { await ensureSchema(db); await db.query('SELECT 1'); databaseReady = true } catch {} }
    const treasuryAddress = ADDRESS_PATTERN.test(env.TREASURY_ADDRESS || '') ? env.TREASURY_ADDRESS.trim() : null
    let snapshot = { ok: false, reason: 'treasury-address-not-configured' }
    if (config.enabled && treasuryAddress) snapshot = await readManagedTreasurySnapshot(treasuryAddress)
    const blockers = []
    if (!config.enabled) blockers.push('managed-signer-configuration-incomplete')
    if (!databaseReady) blockers.push('database-not-ready')
    if (!treasuryAddress) blockers.push('treasury-address-not-configured')
    if (!snapshot.ok) blockers.push(snapshot.reason || 'provider-funding-unverified')
    if (snapshot.ok) {
      if (BigInt(snapshot.spendableUsdtBaseUnits) <= 0n) blockers.push('treasury-usdt-balance-zero-or-unavailable')
      if (!snapshot.networkFeeCapCovered) blockers.push('treasury-trx-below-fee-cap')
    }
    return res.json({
      success: true, network: 'mainnet', asset: 'USDT', tokenContract: USDT_MAINNET,
      withdrawalsEnabled: blockers.length === 0,
      configuration: { enabled: config.enabled, missing: config.missing, signerMode: config.signerMode, providerConfigured: config.providerConfigured },
      databaseReady, treasuryAddress,
      ...(snapshot.ok ? {
        providerAssetId: snapshot.providerAssetId,
        providerAvailableUsdtBaseUnits: snapshot.providerAvailableBaseUnits,
        treasuryUsdtBalanceBaseUnits: snapshot.treasuryUsdtBalanceBaseUnits,
        spendableUsdtBaseUnits: snapshot.spendableUsdtBaseUnits,
        treasuryTrxBalanceSun: snapshot.treasuryTrxBalanceSun,
        treasuryFeeLimitSun: snapshot.treasuryFeeLimitSun,
        networkFeeCapCovered: snapshot.networkFeeCapCovered,
        providerAssetIdentityVerified: snapshot.contractMetadataVerified,
        providerVaultAddressVerified: snapshot.vaultAddressVerified,
      } : {}),
      payoutBlockers: [...new Set(blockers)],
      limitations: [
        'Transfers are initiated through the configured managed Fireblocks vault; blockchain signing keys are not loaded by the API.',
        'Provider transaction acceptance is not proof of on-chain confirmation; verify the successful solidified receipt and exact official-USDT Transfer event.',
        'The treasury must have genuine USDT and sufficient TRX for the configured fee cap unless a separately verified fee sponsor is integrated.',
        'An exchange deposit may require additional confirmations and is controlled by the receiving exchange.',
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
    if (Object.keys(body).some((key) => !['recipientAddress', 'amountUsdt', 'idempotencyKey', 'ownerAuthorizationSignature', 'authorizationExpiresAt'].includes(key))
      || !ADDRESS_PATTERN.test(body.recipientAddress || '')
      || !IDEMPOTENCY_PATTERN.test(body.idempotencyKey || '')
      || typeof body.amountUsdt !== 'string'
      || typeof body.ownerAuthorizationSignature !== 'string'
      || !OWNER_PAYOUT_SIGNATURE_PATTERN.test(body.ownerAuthorizationSignature)
      || !Number.isSafeInteger(body.authorizationExpiresAt)) {
      return res.status(400).json({ success: false, error: 'invalid-withdrawal-request' })
    }
    const clockValue = now()
    const currentTimeMs = clockValue instanceof Date ? clockValue.getTime() : Number(clockValue)
    if (!isTreasuryAuthorizationExpiryValid(body.authorizationExpiresAt, currentTimeMs, OWNER_PAYOUT_AUTHORIZATION_MAX_FUTURE_MS)) {
      return res.status(401).json({ success: false, error: 'owner-payout-authorization-expired-or-outside-window' })
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
      const tronWeb = tronWebFactory()
      const treasuryAddress = typeof env.TREASURY_ADDRESS === 'string' ? env.TREASURY_ADDRESS.trim() : ''
      if (!tronWeb.isAddress(body.recipientAddress)
        || !ADDRESS_PATTERN.test(treasuryAddress)
        || !tronWeb.isAddress(treasuryAddress)
        || treasuryAddress === body.recipientAddress) {
        return res.status(503).json({ success: false, error: 'invalid-treasury-or-recipient' })
      }
      const authorizationMessage = buildTreasuryWithdrawalAuthorizationMessage({
        origin: req.get('origin'),
        ownerAddress: auth.ownerAddress,
        treasuryAddress,
        recipientAddress: body.recipientAddress,
        amountBaseUnits: amount.toString(),
        idempotencyKey: body.idempotencyKey,
        authorizationExpiresAt: body.authorizationExpiresAt,
      })
      const ownerAuthorizedThisPayout = await verifyTreasuryOwnerPayoutSignature(tronWeb, {
        message: authorizationMessage,
        signature: body.ownerAuthorizationSignature,
        expectedOwnerAddress: auth.ownerAddress,
      })
      if (!ownerAuthorizedThisPayout) {
        return res.status(403).json({ success: false, error: 'owner-payout-signature-invalid' })
      }
      const configuredFeeLimit = Number(env.TREASURY_FEE_LIMIT_SUN)
      const initialSnapshot = await readManagedTreasurySnapshot(treasuryAddress)
      if (!initialSnapshot.ok) return res.status(503).json({ success: false, error: 'treasury-provider-funding-not-verified', reason: initialSnapshot.reason, submissionEnabled: false })
      if (!initialSnapshot.networkFeeCapCovered) return res.status(409).json({ success: false, error: 'treasury-trx-insufficient-for-fee-cap', treasuryTrxBalanceSun: initialSnapshot.treasuryTrxBalanceSun, requiredFeeLimitSun: String(configuredFeeLimit), submissionEnabled: false })
      const chainContract = await tronWeb.contract(ABI).at(USDT_MAINNET)

      const client = await db.connect()
      let reservation
      try {
        await client.query('BEGIN')
        await client.query("SELECT pg_advisory_xact_lock(hashtext('tron-token-studio-treasury-withdrawals-mainnet'))")
        const existing = await client.query('SELECT * FROM trc20_token_clone.treasury_withdrawal_requests WHERE idempotency_key = $1 FOR UPDATE', [body.idempotencyKey])
        if (existing.rows.length) {
          const prior = existing.rows[0]
          await client.query('COMMIT')
          if (!matchesTreasuryWithdrawalRequest(prior, {
            ownerAddress: auth.ownerAddress,
            treasuryAddress,
            recipientAddress: body.recipientAddress,
            amountBaseUnits: amount.toString(),
          })) {
            return res.status(409).json({
              success: false,
              error: 'idempotency-key-conflict',
              message: 'This idempotency key is already bound to a different owner, recipient, treasury, or amount. No second transfer was broadcast.',
            })
          }
          return res.status(200).json({ success: true, duplicate: true, withdrawal: safeStatus(prior), note: 'Matching request returned; no second transfer was broadcast.' })
        }

        // Re-read the treasury's actual native TRX before reserving principal.
        // This path conservatively requires the full configured fee cap to be
        // available, rather than assuming an external gas sponsor will cover it.
        const nativeBalanceSun = String(await tronWeb.trx.getBalance(treasuryAddress))
        if (!treasuryFeeCapCovered(nativeBalanceSun, configuredFeeLimit)) {
          await client.query('ROLLBACK')
          return res.status(409).json({
            success: false,
            error: 'treasury-trx-insufficient-for-fee-cap',
            treasuryTrxBalanceSun: /^(0|[1-9][0-9]{0,20})$/.test(nativeBalanceSun) ? nativeBalanceSun : null,
            requiredFeeLimitSun: String(configuredFeeLimit),
            message: 'The treasury must hold enough real TRX to cover the configured fee cap before the payout is reserved. No USDT was sent.',
          })
        }

        // Read current chain balance while the database advisory lock serializes
        // treasury requests, then subtract all unresolved prior reservations.
        // This conservatively avoids accepting simultaneous payouts against the
        // same on-chain balance. Unknown broadcasts remain reserved until reconciled.
        const balanceValue = await chainContract.balanceOf(treasuryAddress).call()
        const balance = BigInt(String(balanceValue))
        const unsettled = await client.query(`
          SELECT COALESCE(SUM(amount_base_units), 0)::text AS amount
            FROM trc20_token_clone.treasury_withdrawal_requests
           WHERE treasury_address = $1
             AND status IN ('broadcasting','provider-pending','broadcast-accepted','broadcast-unknown')
        `, [treasuryAddress])
        const reservedBaseUnits = BigInt(unsettled.rows[0]?.amount || '0')
        const providerSnapshot = await readManagedTreasurySnapshot(treasuryAddress)
        if (!providerSnapshot.ok || !providerSnapshot.networkFeeCapCovered) {
          await client.query('ROLLBACK')
          return res.status(409).json({ success: false, error: 'treasury-funding-or-fee-coverage-changed', reason: providerSnapshot.reason || 'treasury-trx-below-fee-cap', submissionEnabled: false })
        }
        const chainAvailable = unreservedTreasuryBalance(balance.toString(), reservedBaseUnits.toString())
        const providerAvailable = unreservedTreasuryBalance(providerSnapshot.providerAvailableBaseUnits, reservedBaseUnits.toString())
        const availableBaseUnits = chainAvailable === null || providerAvailable === null ? null
          : (BigInt(chainAvailable) < BigInt(providerAvailable) ? chainAvailable : providerAvailable)
        if (availableBaseUnits === null || amount > BigInt(availableBaseUnits)) {
          await client.query('ROLLBACK')
          return res.status(409).json({
            success: false,
            error: 'treasury-usdt-insufficient-after-reservations',
            treasuryUsdtBalanceBaseUnits: balance.toString(),
            outstandingReservationBaseUnits: reservedBaseUnits.toString(),
            availableUsdtBaseUnits: availableBaseUnits ?? '0',
            requestedAmountBaseUnits: amount.toString(),
            message: 'The verified treasury balance is not sufficient after accounting for other unresolved withdrawals.',
          })
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

      const fireblocks = managedSigner()
      let providerTransaction
      try {
        providerTransaction = await fireblocks.createUsdtTransfer({
          recipientAddress: body.recipientAddress,
          amountUsdt: formatUnitsDecimal(amount, 6),
          externalTxId: body.idempotencyKey,
          note: 'TRON Token Studio owner-authorized treasury payout',
        })
      } catch {
        // Provider timeout is ambiguous. Look up the same externalTxId and never
        // blindly create a second transfer.
        try { providerTransaction = await fireblocks.findTransactionByExternalId(body.idempotencyKey) } catch {}
      }
      const providerTransactionId = typeof providerTransaction?.id === 'string' ? providerTransaction.id
        : typeof providerTransaction?.transactionId === 'string' ? providerTransaction.transactionId : ''
      if (!providerTransactionId) {
        await db.query(`UPDATE trc20_token_clone.treasury_withdrawal_requests
          SET status='broadcast-unknown', failure_code='provider-transaction-reference-unavailable', updated_at=now()
          WHERE id=$1`, [reservation.id])
        return res.status(202).json({ success: false, status: 'broadcast-unknown', error: 'provider-transaction-reference-unavailable', idempotencyKey: body.idempotencyKey, note: 'Provider outcome is ambiguous. Do not submit a replacement request; reconcile using the same external transaction ID.' })
      }

      let providerState = classifyFireblocksTransaction(providerTransaction)
      if (!providerState.transactionHash && !providerState.terminalFailure) {
        try {
          providerTransaction = await fireblocks.getTransaction(providerTransactionId)
          providerState = classifyFireblocksTransaction(providerTransaction)
        } catch {}
      }
      const nextStatus = providerState.localStatus === 'broadcast-accepted' ? 'broadcast-accepted'
        : providerState.localStatus === 'failed' ? 'failed' : 'provider-pending'
      const saved = await db.query(`UPDATE trc20_token_clone.treasury_withdrawal_requests
        SET status=$2, transaction_hash=$3, provider_transaction_id=$4, provider_status=$5,
            failure_code=$6, updated_at=now()
        WHERE id=$1 RETURNING *`,
      [reservation.id, nextStatus, providerState.transactionHash, providerTransactionId,
        providerState.providerStatus, nextStatus === 'failed' ? 'fireblocks-terminal-' + providerState.providerStatus.toLowerCase() : null])
      return res.status(202).json({
        success: nextStatus !== 'failed', status: nextStatus, withdrawal: safeStatus(saved.rows[0]),
        note: nextStatus === 'broadcast-accepted'
          ? 'Provider returned a chain transaction ID. This is not confirmation; verify the solidified TRON receipt and official-USDT Transfer event.'
          : nextStatus === 'failed'
            ? 'Provider reported a terminal failure. No on-chain success is claimed.'
            : 'Provider created a request but no chain transaction ID is available yet. Funds remain reserved; poll this same idempotency key.',
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
    const db = getPool(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })
    try {
      await ensureSchema(db)
      const lookup = await db.query(
        'SELECT * FROM trc20_token_clone.treasury_withdrawal_requests WHERE idempotency_key = $1 AND owner_address = $2',
        [key, auth.ownerAddress],
      )
      if (!lookup.rows.length) return res.status(404).json({ success: false, error: 'withdrawal-not-found' })
      let row = await refreshProviderTransaction(db, lookup.rows[0])
      if (row.status === 'confirmed' || row.status === 'failed') {
        return res.json({ success: true, withdrawal: safeStatus(row), verification: { verified: true, status: row.status, reason: 'previously-verified-solidified-receipt' } })
      }
      const txid = typeof row.transaction_hash === 'string' ? row.transaction_hash.trim() : ''
      if (!TXID_PATTERN.test(txid)) {
        const pending = ['provider-pending', 'broadcasting', 'broadcast-unknown'].includes(row.status)
        return res.status(pending ? 202 : 409).json({
          success: false,
          status: row.status,
          error: 'transaction-hash-not-available',
          withdrawal: safeStatus(row),
          note: 'Provider has not returned a chain transaction hash yet. The request remains reserved; use the same request reference and do not submit a replacement.',
        })
      }
      const tronWeb = tronWebFactory()
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
    const db = getPool(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })
    try {
      await ensureSchema(db)
      const result = await db.query('SELECT * FROM trc20_token_clone.treasury_withdrawal_requests WHERE idempotency_key = $1 AND owner_address = $2', [req.params.idempotencyKey, auth.ownerAddress])
      if (!result.rows.length) return res.status(404).json({ success: false, error: 'withdrawal-not-found' })
      const row = await refreshProviderTransaction(db, result.rows[0])
      return res.json({ success: true, withdrawal: safeStatus(row) })
    } catch {
      return res.status(503).json({ success: false, error: 'treasury-withdrawal-unavailable' })
    }
  })


  // Native TRX treasury payouts are a separate, opt-in path with independent
  // limits. The same owner-only challenge session and per-request signature
  // apply; this route never borrows or fabricates chain balance.
  router.get('/trx-withdrawals/readiness', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    res.setHeader('Pragma', 'no-cache')
    const authResult = await authenticateOwner(req)
    if (!authResult.ok) return res.status(authResult.status).json({ success: false, error: authResult.error })

    const config = trxConfiguration(env)
    const treasuryAddress = typeof env.TREASURY_ADDRESS === 'string' ? env.TREASURY_ADDRESS.trim() : ''
    const db = getPool(env)
    const blockers = []
    let databaseReady = false
    let snapshot = { ok: false, reason: 'treasury-address-not-configured' }
    let reservedNativeSun = '0'
    let reservedFeeCapSun = '0'
    let availableNativeSun = '0'
    let dailyReservedSun = '0'
    let pendingTrxCount = '0'
    let pendingUsdtCount = '0'

    if (env.TREASURY_TRX_WITHDRAWALS_ENABLED !== 'true') blockers.push('trx-payout-feature-disabled')
    if (!config.enabled) blockers.push('trx-withdrawal-configuration-incomplete')
    if (!ADDRESS_PATTERN.test(treasuryAddress)) blockers.push('treasury-address-not-configured')
    if (ADDRESS_PATTERN.test(treasuryAddress)) snapshot = await readManagedTreasuryTrxSnapshot(treasuryAddress)
    if (!snapshot.ok) blockers.push(snapshot.reason || 'fireblocks-trx-funding-unverified')

    try {
      if (db) {
        await ensureSchema(db)
        await db.query('SELECT 1')
        databaseReady = true
        if (ADDRESS_PATTERN.test(treasuryAddress)) {
          const [trxReserved, trxPending, usdtPending, dailyReserved] = await Promise.all([
            db.query(\`SELECT COALESCE(SUM(amount_base_units),0)::text AS amount
              FROM trc20_token_clone.treasury_trx_withdrawal_requests
              WHERE treasury_address=$1 AND status IN ('broadcasting','provider-pending','broadcast-accepted','broadcast-unknown')\`, [treasuryAddress]),
            db.query(\`SELECT COUNT(*)::text AS count
              FROM trc20_token_clone.treasury_trx_withdrawal_requests
              WHERE treasury_address=$1 AND status IN ('broadcasting','provider-pending','broadcast-accepted','broadcast-unknown')\`, [treasuryAddress]),
            db.query(\`SELECT COUNT(*)::text AS count
              FROM trc20_token_clone.treasury_withdrawal_requests
              WHERE treasury_address=$1 AND status IN ('broadcasting','provider-pending','broadcast-accepted','broadcast-unknown')\`, [treasuryAddress]),
            db.query(\`SELECT COALESCE(SUM(amount_base_units),0)::text AS amount
              FROM trc20_token_clone.treasury_trx_withdrawal_requests
              WHERE treasury_address=$1 AND created_at >= date_trunc('day',now()) AND status <> 'rejected'\`, [treasuryAddress]),
          ])
          reservedNativeSun = String(trxReserved.rows[0]?.amount || '0')
          pendingTrxCount = String(trxPending.rows[0]?.count || '0')
          pendingUsdtCount = String(usdtPending.rows[0]?.count || '0')
          dailyReservedSun = String(dailyReserved.rows[0]?.amount || '0')

          const feeReservations = config.feeLimit * (BigInt(pendingTrxCount) + BigInt(pendingUsdtCount) + 1n)
          reservedFeeCapSun = feeReservations.toString()
          if (snapshot.ok) {
            const unreserved = unreservedTreasuryBalance(snapshot.spendableTrxBaseUnits, reservedNativeSun)
            const postFee = unreserved === null ? 0n : BigInt(unreserved) - feeReservations
            availableNativeSun = (postFee > 0n ? postFee : 0n).toString()
          }
        }
      }
    } catch {
      databaseReady = false
      blockers.push('chain-or-database-read-failed')
    }

    if (!databaseReady) blockers.push('database-not-ready')
    if (snapshot.ok) {
      if (BigInt(snapshot.spendableTrxBaseUnits) <= 0n) blockers.push('treasury-trx-balance-zero-or-unavailable')
      if (!treasuryFeeCapCovered(snapshot.treasuryTrxBalanceSun, String(config.feeLimit))) blockers.push('treasury-trx-below-fee-cap')
      if (databaseReady && BigInt(availableNativeSun) <= 0n) blockers.push('treasury-trx-no-unreserved-payout-balance')
    }

    const withdrawalsEnabled = config.enabled && databaseReady && snapshot.ok && blockers.length === 0
    return res.json({
      success: true,
      network: 'mainnet',
      asset: 'TRX',
      decimals: 6,
      withdrawalsEnabled,
      ownerAddress: authResult.ownerAddress,
      treasuryAddress: ADDRESS_PATTERN.test(treasuryAddress) ? treasuryAddress : null,
      configuration: {
        enabled: config.enabled,
        missing: config.missing,
        signerMode: config.signerMode,
        providerConfigured: typeof managedSigner()?.isConfigured === 'function' && managedSigner().isConfigured() === true,
      },
      databaseReady,
      ...(snapshot.ok ? {
        providerAssetId: snapshot.providerAssetId,
        providerAvailableTrxBaseUnits: snapshot.providerAvailableBaseUnits,
        treasuryTrxBalanceSun: snapshot.treasuryTrxBalanceSun,
        spendableTrxBaseUnits: snapshot.spendableTrxBaseUnits,
        providerVaultAddressVerified: snapshot.vaultAddressVerified,
        nativeAssetIdentityVerified: snapshot.nativeAssetIdentityVerified,
      } : {}),
      outstandingTrxPrincipalSun: reservedNativeSun,
      reservedFeeCapSun,
      availableTrxBaseUnits: availableNativeSun,
      dailyReservedTrxBaseUnits: dailyReservedSun,
      maxPayoutTrx: typeof env.TREASURY_MAX_PAYOUT_TRX === 'string' ? env.TREASURY_MAX_PAYOUT_TRX : null,
      dailyLimitTrx: typeof env.TREASURY_DAILY_LIMIT_TRX === 'string' ? env.TREASURY_DAILY_LIMIT_TRX : null,
      payoutBlockers: [...new Set(blockers)],
      note: 'Readiness is not a payout authorization. Every TRX payout requires owner authorization, a configured Fireblocks vault, real TRX covering principal and the reserved fee cap, and a verified chain receipt.',
    })
  })

  router.post('/trx-withdrawals', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    const authResult = await authenticateOwner(req)
    if (!authResult.ok) return res.status(authResult.status).json({ success: false, error: authResult.error })

    const config = trxConfiguration(env)
    if (!config.enabled) {
      return res.status(503).json({
        success: false,
        error: 'treasury-trx-withdrawals-disabled',
        missing: config.missing,
        submissionEnabled: false,
      })
    }

    const origin = req.get('origin')
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
    const amount = parsePositiveDecimal(body.amountTrx, 6)
    const authorizationExpiresAt = body.authorizationExpiresAt
    if (!origin || !ADDRESS_PATTERN.test(body.recipientAddress || '')
      || body.recipientAddress === env.TREASURY_ADDRESS
      || !amount || amount > config.maxPayout
      || typeof body.idempotencyKey !== 'string' || !IDEMPOTENCY_PATTERN.test(body.idempotencyKey)
      || !isTreasuryAuthorizationExpiryValid(authorizationExpiresAt, now().getTime(), OWNER_PAYOUT_AUTHORIZATION_MAX_FUTURE_MS)
      || typeof body.authorizationMessage !== 'string'
      || typeof body.authorizationSignature !== 'string'
      || !OWNER_PAYOUT_SIGNATURE_PATTERN.test(body.authorizationSignature)) {
      return res.status(400).json({ success: false, error: 'invalid-trx-withdrawal-request' })
    }

    const treasuryAddress = typeof env.TREASURY_ADDRESS === 'string' ? env.TREASURY_ADDRESS.trim() : ''
    try {
      const tronWeb = tronWebFactory()
      if (!tronWeb.isAddress(body.recipientAddress) || !ADDRESS_PATTERN.test(treasuryAddress)
        || !tronWeb.isAddress(treasuryAddress) || treasuryAddress === body.recipientAddress) {
        return res.status(400).json({ success: false, error: 'invalid-treasury-or-recipient' })
      }
      const canonicalMessage = buildTreasuryTrxWithdrawalAuthorizationMessage({
        origin,
        ownerAddress: authResult.ownerAddress,
        treasuryAddress,
        recipientAddress: body.recipientAddress,
        amountBaseUnits: amount.toString(),
        idempotencyKey: body.idempotencyKey,
        authorizationExpiresAt,
      })
      if (body.authorizationMessage !== canonicalMessage) {
        return res.status(400).json({ success: false, error: 'payout-authorization-message-mismatch' })
      }
      const signatureValid = await verifyTreasuryOwnerPayoutSignature(tronWeb, {
        message: canonicalMessage,
        signature: body.authorizationSignature,
        expectedOwnerAddress: authResult.ownerAddress,
      })
      if (!signatureValid) return res.status(403).json({ success: false, error: 'invalid-owner-payout-signature' })

      const db = getPool(env)
      if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })
      await ensureSchema(db)

      const client = await db.connect()
      let reservation
      try {
        await client.query('BEGIN')
        await client.query("SELECT pg_advisory_xact_lock(hashtext('tron-token-studio-treasury-withdrawals-mainnet'))")
        const existing = await client.query(
          'SELECT * FROM trc20_token_clone.treasury_trx_withdrawal_requests WHERE idempotency_key=$1 FOR UPDATE',
          [body.idempotencyKey],
        )
        if (existing.rows.length) {
          const prior = existing.rows[0]
          await client.query('COMMIT')
          if (!matchesTreasuryTrxWithdrawalRequest(prior, {
            ownerAddress: authResult.ownerAddress,
            treasuryAddress,
            recipientAddress: body.recipientAddress,
            amountBaseUnits: amount.toString(),
          })) {
            return res.status(409).json({
              success: false,
              error: 'idempotency-key-conflict',
              message: 'This request key is already bound to a different owner, recipient, treasury, or amount. No second transfer was submitted.',
            })
          }
          const refreshed = await refreshProviderTrxTransaction(db, prior)
          return res.status(200).json({
            success: true,
            duplicate: true,
            withdrawal: safeTrxStatus(refreshed),
            note: 'Matching request returned; no second provider transfer was submitted.',
          })
        }

        const snapshot = await readManagedTreasuryTrxSnapshot(treasuryAddress)
        if (!snapshot.ok) {
          await client.query('ROLLBACK')
          return res.status(503).json({
            success: false,
            error: 'treasury-provider-funding-not-verified',
            reason: snapshot.reason,
            submissionEnabled: false,
          })
        }

        const [trxReserved, pendingTrxCount, pendingUsdtCount, dailyReserved] = await Promise.all([
          client.query(\`SELECT COALESCE(SUM(amount_base_units),0)::text AS amount
            FROM trc20_token_clone.treasury_trx_withdrawal_requests
            WHERE treasury_address=$1 AND status IN ('broadcasting','provider-pending','broadcast-accepted','broadcast-unknown')\`, [treasuryAddress]),
          client.query(\`SELECT COUNT(*)::text AS count
            FROM trc20_token_clone.treasury_trx_withdrawal_requests
            WHERE treasury_address=$1 AND status IN ('broadcasting','provider-pending','broadcast-accepted','broadcast-unknown')\`, [treasuryAddress]),
          client.query(\`SELECT COUNT(*)::text AS count
            FROM trc20_token_clone.treasury_withdrawal_requests
            WHERE treasury_address=$1 AND status IN ('broadcasting','provider-pending','broadcast-accepted','broadcast-unknown')\`, [treasuryAddress]),
          client.query(\`SELECT COALESCE(SUM(amount_base_units),0)::text AS amount
            FROM trc20_token_clone.treasury_trx_withdrawal_requests
            WHERE treasury_address=$1 AND created_at >= date_trunc('day',now()) AND status <> 'rejected'\`, [treasuryAddress]),
        ])
        const nativeReserved = BigInt(trxReserved.rows[0]?.amount || '0')
        const pendingFeeCount = BigInt(pendingTrxCount.rows[0]?.count || '0')
          + BigInt(pendingUsdtCount.rows[0]?.count || '0') + 1n
        const reservedFeeSun = config.feeLimit * pendingFeeCount
        const unreservedNative = unreservedTreasuryBalance(snapshot.spendableTrxBaseUnits, nativeReserved.toString())
        const freeForPrincipal = unreservedNative === null ? 0n : BigInt(unreservedNative) - reservedFeeSun
        if (freeForPrincipal < amount) {
          await client.query('ROLLBACK')
          return res.status(409).json({
            success: false,
            error: 'treasury-trx-insufficient-after-reservations',
            treasuryTrxBalanceSun: snapshot.treasuryTrxBalanceSun,
            providerAvailableTrxBaseUnits: snapshot.providerAvailableBaseUnits,
            outstandingTrxPrincipalSun: nativeReserved.toString(),
            reservedFeeCapSun: reservedFeeSun.toString(),
            availableTrxBaseUnits: (freeForPrincipal > 0n ? freeForPrincipal : 0n).toString(),
            requestedAmountBaseUnits: amount.toString(),
            message: 'Verified real treasury TRX is insufficient after outstanding payouts and the conservative fee reserve.',
          })
        }

        const alreadyReserved = BigInt(dailyReserved.rows[0]?.amount || '0')
        if (alreadyReserved + amount > config.dailyLimit) {
          await client.query('ROLLBACK')
          return res.status(429).json({ success: false, error: 'treasury-trx-daily-limit-exceeded' })
        }

        const inserted = await client.query(\`
          INSERT INTO trc20_token_clone.treasury_trx_withdrawal_requests
            (idempotency_key,owner_address,treasury_address,recipient_address,amount_base_units,status)
          VALUES ($1,$2,$3,$4,$5,'broadcasting')
          RETURNING *
        \`, [body.idempotencyKey, authResult.ownerAddress, treasuryAddress, body.recipientAddress, amount.toString()])
        reservation = inserted.rows[0]
        await client.query('COMMIT')
      } catch (error) {
        try { await client.query('ROLLBACK') } catch {}
        if (error?.code === '23505') {
          const existing = await db.query(
            'SELECT * FROM trc20_token_clone.treasury_trx_withdrawal_requests WHERE idempotency_key=$1',
            [body.idempotencyKey],
          )
          if (existing.rows.length) {
            return res.status(200).json({
              success: true,
              duplicate: true,
              withdrawal: safeTrxStatus(existing.rows[0]),
              note: 'Existing native TRX request returned; no second transfer was submitted.',
            })
          }
        }
        throw error
      } finally {
        client.release()
      }

      const fireblocks = managedSigner()
      let providerTransaction
      try {
        providerTransaction = await fireblocks.createTrxTransfer({
          recipientAddress: body.recipientAddress,
          amountTrx: formatUnitsDecimal(amount, 6),
          externalTxId: body.idempotencyKey,
          note: 'TRON Token Studio owner-authorized treasury TRX payout',
        })
      } catch {
        // Fireblocks may have accepted the first request despite a network error.
        // Resolve the original external ID before any new request can be created.
        try { providerTransaction = await fireblocks.findTransactionByExternalId(body.idempotencyKey) } catch {}
      }

      const providerTransactionId = typeof providerTransaction?.id === 'string' ? providerTransaction.id
        : typeof providerTransaction?.transactionId === 'string' ? providerTransaction.transactionId : ''
      if (!providerTransactionId) {
        await db.query(\`UPDATE trc20_token_clone.treasury_trx_withdrawal_requests
          SET status='broadcast-unknown', provider_status='UNKNOWN',
              failure_code='provider-transaction-reference-unavailable', updated_at=now()
          WHERE id=$1\`, [reservation.id])
        return res.status(202).json({
          success: false,
          status: 'broadcast-unknown',
          error: 'provider-transaction-reference-unavailable',
          idempotencyKey: body.idempotencyKey,
          note: 'Provider outcome is ambiguous. Do not submit a replacement; reconcile the same external transaction ID.',
        })
      }

      let providerState = classifyFireblocksTransaction(providerTransaction)
      if (!providerState.transactionHash && !providerState.terminalFailure) {
        try {
          providerTransaction = await fireblocks.getTransaction(providerTransactionId)
          providerState = classifyFireblocksTransaction(providerTransaction)
        } catch {}
      }
      const nextStatus = providerState.localStatus === 'broadcast-accepted' ? 'broadcast-accepted'
        : providerState.localStatus === 'failed' ? 'failed' : 'provider-pending'
      const saved = await db.query(\`UPDATE trc20_token_clone.treasury_trx_withdrawal_requests
        SET status=$2, transaction_hash=$3, provider_transaction_id=$4, provider_status=$5,
            failure_code=$6, updated_at=now()
        WHERE id=$1 RETURNING *\`,
      [reservation.id, nextStatus, providerState.transactionHash, providerTransactionId,
        providerState.providerStatus, nextStatus === 'failed' ? 'fireblocks-terminal-' + providerState.providerStatus.toLowerCase() : null])
      return res.status(202).json({
        success: nextStatus !== 'failed',
        status: nextStatus,
        withdrawal: safeTrxStatus(saved.rows[0]),
        note: nextStatus === 'broadcast-accepted'
          ? 'Fireblocks returned a TRON chain transaction ID. Verify the solidified transaction before treating the transfer as complete.'
          : nextStatus === 'failed'
            ? 'Fireblocks reported a terminal failure. No successful on-chain transfer is claimed.'
            : 'Fireblocks created a request but no chain hash is available yet. Funds remain reserved; look up this same idempotency key.',
      })
    } catch {
      return res.status(503).json({ success: false, error: 'treasury-trx-withdrawal-unavailable' })
    }
  })

  router.post('/trx-withdrawals/:idempotencyKey/verify', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    const authResult = await authenticateOwner(req)
    if (!authResult.ok) return res.status(authResult.status).json({ success: false, error: authResult.error })
    const key = req.params.idempotencyKey
    if (!IDEMPOTENCY_PATTERN.test(key || '')) return res.status(400).json({ success: false, error: 'invalid-idempotency-key' })
    const db = getPool(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })
    try {
      await ensureSchema(db)
      const lookup = await db.query('SELECT * FROM trc20_token_clone.treasury_trx_withdrawal_requests WHERE idempotency_key=$1 AND owner_address=$2', [key, authResult.ownerAddress])
      if (!lookup.rows.length) return res.status(404).json({ success: false, error: 'trx-withdrawal-not-found' })
      const row = lookup.rows[0]
      if (row.status === 'confirmed' || row.status === 'failed') return res.json({ success: row.status === 'confirmed', withdrawal: safeTrxStatus(row), verification: { verified: true, status: row.status, reason: 'previously-verified-solidified-transfer' } })
      const txid = typeof row.transaction_hash === 'string' ? row.transaction_hash.trim() : ''
      if (!TXID_PATTERN.test(txid)) return res.status(409).json({ success: false, error: 'transaction-hash-not-available', withdrawal: safeTrxStatus(row) })
      const tronWeb = tronWebFactory(env.TREASURY_PRIVATE_KEY.trim())
      const [transaction, transactionInfo] = await Promise.all([
        tronWeb.trx.getConfirmedTransaction(txid).catch(() => null),
        tronWeb.trx.getTransactionInfo(txid).catch(() => null),
      ])
      const evidence = verifyTreasuryTrxTransferEvidence(tronWeb, {
        transaction, transactionInfo, transactionHash: txid, treasuryAddress: row.treasury_address,
        recipientAddress: row.recipient_address, amountBaseUnits: String(row.amount_base_units),
      })
      if (evidence.status === 'confirmed' || evidence.status === 'failed') {
        const updated = await db.query(`UPDATE trc20_token_clone.treasury_trx_withdrawal_requests SET status=$2,failure_code=$3,updated_at=now() WHERE id=$1 AND status NOT IN ('confirmed','failed') RETURNING *`, [row.id,evidence.status,evidence.status === 'failed' ? evidence.reason : null])
        const saved = updated.rows[0] || row
        return res.status(evidence.status === 'confirmed' ? 200 : 202).json({ success: evidence.status === 'confirmed', withdrawal: safeTrxStatus(saved), verification: evidence })
      }
      return res.status(evidence.status === 'verification-mismatch' ? 409 : 202).json({
        success: false, withdrawal: safeTrxStatus(row), verification: evidence,
        note: 'A hash alone is not confirmation; retry after this transaction is indexed in a confirmed block.',
      })
    } catch {
      return res.status(503).json({ success: false, error: 'treasury-trx-withdrawal-verification-unavailable' })
    }
  })

  router.get('/trx-withdrawals/:idempotencyKey', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    const authResult = await authenticateOwner(req)
    if (!authResult.ok) return res.status(authResult.status).json({ success: false, error: authResult.error })
    if (!IDEMPOTENCY_PATTERN.test(req.params.idempotencyKey || '')) return res.status(400).json({ success: false, error: 'invalid-idempotency-key' })
    const db = getPool(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })
    try {
      await ensureSchema(db)
      const found = await db.query('SELECT * FROM trc20_token_clone.treasury_trx_withdrawal_requests WHERE idempotency_key=$1 AND owner_address=$2', [req.params.idempotencyKey,authResult.ownerAddress])
      if (!found.rows.length) return res.status(404).json({ success: false, error: 'trx-withdrawal-not-found' })
      return res.json({ success: true, withdrawal: safeTrxStatus(found.rows[0]) })
    } catch {
      return res.status(503).json({ success: false, error: 'treasury-trx-withdrawal-unavailable' })
    }
  })

  return router
}

export { parsePositiveDecimal }

export default createTreasuryWithdrawalsRouter
