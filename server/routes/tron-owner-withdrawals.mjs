import { createHash, randomUUID } from 'node:crypto'
import { Router } from 'express'
import pg from 'pg'
import { TronWeb } from 'tronweb'
import { getWalletAuthSession, normalizeDatabaseConnectionString, databaseSslConfig } from '../database.mjs'
import { isValidTronAddress } from '../tron-address.mjs'
import { tatumProviderFetch } from '../tatum-provider-fetch.mjs'
import { verifySolidifiedUsdtTransfer } from './tron-transfer.mjs'

const { Pool } = pg
const SCHEMA = 'trc20_token_clone'
export const MAINNET_USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const MAINNET_GATEWAY = 'https://tron-mainnet.gateway.tatum.io'
// Explicit non-production safety gate. Owner-signed Mainnet withdrawal broadcasts remain disabled.
const REAL_OWNER_DIRECT_MAINNET_BROADCAST_DISABLED = true
const ADDRESS_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const TXID_RE = /^[0-9a-f]{64}$/i
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const TRANSFER_SELECTOR = 'a9059cbb'
const MAX_SIGNED_TRANSACTION_BYTES = 128 * 1024
const MAX_PREPARED_LIFETIME_MS = 10 * 60 * 1000
const DEFAULT_FEE_LIMIT_SUN = '100000000'
export const MIN_OWNER_WITHDRAWAL_USDT_BASE_UNITS = '1000000000'

let pool
let schemaPromise

function clean(value, max = 256) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
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
  pool.on('error', (error) => console.error('TRON owner withdrawal database error:', error?.code || 'unknown'))
  return pool
}

async function ensureSchema(db) {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await db.query('CREATE SCHEMA IF NOT EXISTS ' + SCHEMA)
      await db.query(`
        CREATE TABLE IF NOT EXISTS ${SCHEMA}.owner_direct_withdrawals (
          id UUID PRIMARY KEY,
          idempotency_key UUID NOT NULL UNIQUE,
          owner_address TEXT NOT NULL,
          recipient_address TEXT NOT NULL,
          token_contract TEXT NOT NULL,
          amount_base_units NUMERIC(78,0) NOT NULL CHECK (amount_base_units > 0),
          unsigned_transaction JSONB NOT NULL,
          transaction_hash CHAR(64) NOT NULL,
          status TEXT NOT NULL DEFAULT 'prepared',
          signed_transaction JSONB,
          broadcast_response JSONB,
          failure_code TEXT,
          expires_at TIMESTAMPTZ NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `)
      await db.query('CREATE INDEX IF NOT EXISTS owner_direct_withdrawals_created_idx ON ' + SCHEMA + '.owner_direct_withdrawals (created_at DESC)')
      await db.query('CREATE INDEX IF NOT EXISTS owner_direct_withdrawals_status_idx ON ' + SCHEMA + '.owner_direct_withdrawals (status, updated_at DESC)')
    })().catch((error) => { schemaPromise = null; throw error })
  }
  await schemaPromise
}

export function parseOwnerUsdtAmount(value) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/.test(raw)) {
    throw new Error('Enter a positive USDT amount with no more than six decimal places.')
  }
  const [whole, fraction = ''] = raw.split('.')
  const baseUnits = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0') || '0')
  if (baseUnits <= 0n || baseUnits > 10n ** 30n) {
    throw new Error('The USDT amount is outside the permitted transfer range.')
  }
  return baseUnits.toString()
}

export function isOwnerWithdrawalAmountAtLeastMinimum(amountBaseUnits) {
  return typeof amountBaseUnits === 'string'
    && /^(?:0|[1-9][0-9]*)$/.test(amountBaseUnits)
    && BigInt(amountBaseUnits) >= BigInt(MIN_OWNER_WITHDRAWAL_USDT_BASE_UNITS)
}

export function calculateOwnerWithdrawableUsdtBaseUnits(balanceBaseUnits, reservedBaseUnits) {
  const valid = (value) => /^(0|[1-9][0-9]*)$/.test(String(value))
  if (!valid(balanceBaseUnits) || !valid(reservedBaseUnits)) {
    throw new Error('Invalid USDT balance reservation values.')
  }
  const balance = BigInt(balanceBaseUnits)
  const reserved = BigInt(reservedBaseUnits)
  return (balance > reserved ? balance - reserved : 0n).toString()
}

function tronWebForMainnet() {
  return new TronWeb({ fullHost: MAINNET_GATEWAY })
}

function canonicalAddress(value, tronWeb) {
  const candidate = clean(value, 96)
  if (ADDRESS_RE.test(candidate) && isValidTronAddress(candidate)) return candidate
  const hex = candidate.replace(/^0x/i, '').toLowerCase()
  if (!/^(?:41)?[0-9a-f]{40}$/.test(hex)) return null
  try {
    const decoded = tronWeb.address.fromHex(hex.length === 40 ? '41' + hex : hex)
    return ADDRESS_RE.test(decoded) && isValidTronAddress(decoded) ? decoded : null
  } catch {
    return null
  }
}

export function buildOwnerUsdtTransferParameter(recipientAddress, amountBaseUnits, tronWeb = tronWebForMainnet()) {
  if (!isValidTronAddress(recipientAddress) || !/^[1-9][0-9]{0,77}$/.test(String(amountBaseUnits))) {
    throw new Error('Invalid TRON transfer parameter.')
  }
  const recipientHex = tronWeb.address.toHex(recipientAddress).replace(/^41/i, '').toLowerCase()
  if (!/^[0-9a-f]{40}$/.test(recipientHex)) throw new Error('Recipient address could not be encoded.')
  return recipientHex.padStart(64, '0') + BigInt(amountBaseUnits).toString(16).padStart(64, '0')
}

function transactionMatchesIntent(transaction, { ownerAddress, recipientAddress, amountBaseUnits, tronWeb }) {
  if (!transaction || typeof transaction !== 'object' || Array.isArray(transaction)) return false
  if (typeof transaction.txID !== 'string' || !TXID_RE.test(transaction.txID)
    || typeof transaction.raw_data_hex !== 'string' || !/^(?:[0-9a-f]{2})+$/i.test(transaction.raw_data_hex)) return false
  const calculated = createHash('sha256').update(Buffer.from(transaction.raw_data_hex, 'hex')).digest('hex')
  if (calculated.toLowerCase() !== transaction.txID.toLowerCase()) return false
  const contracts = transaction.raw_data?.contract
  if (!Array.isArray(contracts) || contracts.length !== 1 || contracts[0]?.type !== 'TriggerSmartContract') return false
  const value = contracts[0]?.parameter?.value
  if (!value || canonicalAddress(value.owner_address, tronWeb) !== ownerAddress
    || canonicalAddress(value.contract_address, tronWeb) !== MAINNET_USDT_CONTRACT
    || Number(value.call_value || 0) !== 0) return false
  const expectedParameter = buildOwnerUsdtTransferParameter(recipientAddress, amountBaseUnits, tronWeb)
  const expectedData = TRANSFER_SELECTOR + expectedParameter
  if (typeof value.data !== 'string' || value.data.replace(/^0x/i, '').toLowerCase() !== expectedData) return false
  const expiration = Number(transaction.raw_data?.expiration)
  const now = Date.now()
  return Number.isSafeInteger(expiration)
    && expiration > now
    && expiration <= now + MAX_PREPARED_LIFETIME_MS + 30_000
}

function sameUnsignedTransaction(signed, unsigned) {
  if (!signed || typeof signed !== 'object' || Array.isArray(signed) || !unsigned) return false
  if (String(signed.txID || '').toLowerCase() !== String(unsigned.txID || '').toLowerCase()
    || String(signed.raw_data_hex || '').toLowerCase() !== String(unsigned.raw_data_hex || '').toLowerCase()) return false
  const canonical = (value) => Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
      : value
  try {
    return JSON.stringify(canonical(signed.raw_data)) === JSON.stringify(canonical(unsigned.raw_data))
  } catch {
    return false
  }
}

export function validateOwnerSignedTransaction(signed, unsigned, intent) {
  if (!sameUnsignedTransaction(signed, unsigned)) return { ok: false, reason: 'signed-transaction-does-not-match-prepared-intent' }
  if (!Array.isArray(signed.signature) || signed.signature.length !== 1
    || typeof signed.signature[0] !== 'string' || !/^[0-9a-f]{130}$/i.test(signed.signature[0])) {
    return { ok: false, reason: 'owner-signature-required' }
  }
  const tronWeb = intent.tronWeb || tronWebForMainnet()
  if (!transactionMatchesIntent(signed, { ...intent, tronWeb })) {
    return { ok: false, reason: 'signed-transaction-intent-mismatch' }
  }
  return { ok: true }
}

function requestOrigin(req) {
  const origin = clean(req.headers?.origin, 512)
  try {
    const parsed = new URL(origin)
    if (parsed.origin !== origin || parsed.protocol !== 'https:') return ''
    return origin
  } catch {
    return ''
  }
}

function configuredOrigins(env) {
  return [env.FRONTEND_ORIGIN, env.PACKAGED_APP_ORIGINS, env.OKX_UI_ORIGIN, env.TRON_TRANSFER_UI_ORIGIN]
    .flatMap((value) => typeof value === 'string' ? value.split(',') : [])
    .map((value) => value.trim()).filter(Boolean)
}

async function requireOwner(req, env) {
  const origin = requestOrigin(req)
  if (!origin || !configuredOrigins(env).includes(origin)) return { ok: false, status: 403, error: 'owner-origin-not-allowed' }
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(clean(req.headers?.authorization, 4096))
  if (!match) return { ok: false, status: 401, error: 'owner-session-required' }
  const ownerAddress = clean(env.OWNER_WALLET_ADDRESS, 64)
  if (!isValidTronAddress(ownerAddress)) return { ok: false, status: 503, error: 'owner-wallet-not-configured' }
  let lookup
  try {
    lookup = await getWalletAuthSession({
      tokenHash: createHash('sha256').update(match[1]).digest('hex'),
      origin,
      nowMs: Date.now(),
    })
  } catch {
    return { ok: false, status: 503, error: 'owner-session-storage-unavailable' }
  }
  if (lookup?.success !== true) return { ok: false, status: 503, error: 'owner-session-storage-unavailable' }
  const session = lookup.session
  if (!session || session.network !== 'mainnet' || session.address !== ownerAddress
    || session.origin !== origin || session.expiresAt <= Date.now()) {
    return { ok: false, status: 401, error: 'owner-session-invalid-or-expired' }
  }
  return { ok: true, address: ownerAddress }
}

function tatumApiKey(env) {
  return clean(env.TATUM_MAINNET_API_KEY || env.TATUM_API_KEY, 2048)
}

async function tatumPost(env, path, body) {
  const key = tatumApiKey(env)
  if (!key) throw Object.assign(new Error('Tatum Mainnet API key is not configured.'), { status: 503 })
  const response = await tatumProviderFetch(MAINNET_GATEWAY + '/' + path.replace(/^\/+/, ''), {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'x-api-key': key },
    body: JSON.stringify(body || {}),
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok || !payload || payload.Error || payload.error) {
    const error = new Error('Tatum Mainnet request failed.')
    error.status = response.status || 502
    throw error
  }
  return payload
}

async function readOwnerSnapshot(env, ownerAddress) {
  const tronWeb = tronWebForMainnet()
  const ownerHex = tronWeb.address.toHex(ownerAddress).replace(/^41/i, '').toLowerCase()
  const addressWord = ownerHex.padStart(64, '0')
  const [account, resources, token] = await Promise.all([
    tatumPost(env, 'walletsolidity/getaccount', { address: ownerAddress, visible: true }),
    tatumPost(env, 'wallet/getaccountresource', { address: ownerAddress, visible: true }),
    tatumPost(env, 'walletsolidity/triggerconstantcontract', {
      owner_address: ownerAddress,
      contract_address: MAINNET_USDT_CONTRACT,
      function_selector: 'balanceOf(address)',
      parameter: addressWord,
      visible: true,
    }),
  ])
  const tokenHex = Array.isArray(token?.constant_result) ? token.constant_result[0] : ''
  if (typeof tokenHex !== 'string' || !/^[0-9a-f]{1,64}$/i.test(tokenHex)) {
    throw Object.assign(new Error('Tatum did not return the official USDT balance.'), { status: 502 })
  }
  const balanceBaseUnits = BigInt('0x' + tokenHex).toString()
  const trxBalanceRaw = account?.balance
  const trxBalanceSun = /^(0|[1-9][0-9]*)$/.test(String(trxBalanceRaw ?? ''))
    ? String(trxBalanceRaw) : null
  const readResource = (value) => {
    const parsed = Number(value)
    return value !== undefined && value !== null && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
  }
  const energyLimit = readResource(resources?.EnergyLimit)
  const energyUsed = readResource(resources?.EnergyUsed)
  const netLimit = readResource(resources?.NetLimit)
  const netUsed = readResource(resources?.NetUsed)
  const freeNetLimit = readResource(resources?.freeNetLimit)
  const freeNetUsed = readResource(resources?.freeNetUsed)
  const resourcesReadable = [energyLimit, energyUsed, netLimit, netUsed, freeNetLimit, freeNetUsed]
    .every((value) => value !== null)
  return {
    ownerAddress,
    network: 'mainnet',
    tokenContract: MAINNET_USDT_CONTRACT,
    usdtBalanceBaseUnits: balanceBaseUnits,
    trxBalanceSun,
    energyAvailable: resourcesReadable ? Math.max(0, energyLimit - energyUsed) : null,
    bandwidthAvailable: resourcesReadable
      ? Math.max(0, netLimit - netUsed) + Math.max(0, freeNetLimit - freeNetUsed)
      : null,
    resourcesChecked: resourcesReadable,
    checkedAt: new Date().toISOString(),
  }
}

async function readOwnerUsdtReservations(db, ownerAddress) {
  const result = await db.query(
    'SELECT COALESCE(SUM(amount_base_units), 0)::text AS reserved_base_units FROM ' + SCHEMA
      + ".owner_direct_withdrawals WHERE owner_address=$1 AND ((status='prepared' AND expires_at > now()) OR status IN ('broadcasting','submitted','outcome-unknown','manual-review'))",
    [ownerAddress],
  )
  const reserved = String(result.rows?.[0]?.reserved_base_units ?? '0')
  if (!/^(0|[1-9][0-9]*)$/.test(reserved)) {
    throw new Error('Owner USDT reservation state is unreadable.')
  }
  return reserved
}

function publicWithdrawal(row) {
  return {
    id: row.id,
    network: 'mainnet',
    asset: 'USDT',
    tokenContract: row.token_contract,
    ownerAddress: row.owner_address,
    recipientAddress: row.recipient_address,
    amountBaseUnits: String(row.amount_base_units),
    status: row.status,
    transactionHash: row.transaction_hash ? String(row.transaction_hash).trim() : null,
    failureCode: row.failure_code || null,
    expiresAt: new Date(row.expires_at).toISOString(),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  }
}

export function createTronOwnerWithdrawalsRouter({ env = process.env } = {}) {
  const router = Router()

  router.get('/readiness', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    const auth = await requireOwner(req, env)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    if (!tatumApiKey(env)) return res.status(503).json({ success: false, error: 'tatum-mainnet-key-not-configured' })
    const db = getPool(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })
    try {
      await ensureSchema(db)
      const [snapshot, reservedBaseUnits] = await Promise.all([
        readOwnerSnapshot(env, auth.address),
        readOwnerUsdtReservations(db, auth.address),
      ])
      const availableBaseUnits = calculateOwnerWithdrawableUsdtBaseUnits(snapshot.usdtBalanceBaseUnits, reservedBaseUnits)
      return res.json({
        success: true,
        snapshot: {
          ...snapshot,
          reservedUsdtBaseUnits: reservedBaseUnits,
          availableForWithdrawalBaseUnits: availableBaseUnits,
        },
        canPrepareWithdrawal: BigInt(availableBaseUnits) > 0n,
        note: 'Balances and resources are read from Tatum Mainnet. Active prepared or unresolved withdrawals are reserved to prevent the same USDT from being allocated twice. A snapshot does not guarantee a later transaction will succeed.',
      })
    } catch (error) {
      return res.status(Number.isInteger(error?.status) ? error.status : 502).json({
        success: false,
        error: 'owner-mainnet-snapshot-unavailable',
      })
    }
  })

  router.get('/', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    const auth = await requireOwner(req, env)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const db = getPool(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })
    try {
      await ensureSchema(db)
      const result = await db.query(
        'SELECT * FROM ' + SCHEMA + '.owner_direct_withdrawals WHERE owner_address=$1 ORDER BY created_at DESC LIMIT 50',
        [auth.address],
      )
      return res.json({ success: true, withdrawals: result.rows.map(publicWithdrawal) })
    } catch {
      return res.status(503).json({ success: false, error: 'withdrawal-history-unavailable' })
    }
  })

  router.post('/prepare', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    const auth = await requireOwner(req, env)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
    if (Object.keys(body).some((key) => !['recipientAddress', 'amount', 'idempotencyKey'].includes(key))) {
      return res.status(400).json({ success: false, error: 'unexpected-fields' })
    }
    const recipientAddress = clean(body.recipientAddress, 64)
    const idempotencyKey = clean(body.idempotencyKey, 64)
    if (!ADDRESS_RE.test(recipientAddress) || !isValidTronAddress(recipientAddress) || recipientAddress === auth.address) {
      return res.status(400).json({ success: false, error: 'invalid-or-self-recipient-address' })
    }
    if (!UUID_RE.test(idempotencyKey)) return res.status(400).json({ success: false, error: 'valid-idempotency-key-required' })
    let amountBaseUnits
    try { amountBaseUnits = parseOwnerUsdtAmount(body.amount) } catch (error) {
      return res.status(400).json({ success: false, error: 'invalid-usdt-amount', message: error.message })
    }
    if (!isOwnerWithdrawalAmountAtLeastMinimum(amountBaseUnits)) {
      return res.status(400).json({
        success: false,
        error: 'owner-withdrawal-below-1000-usdt-minimum',
        minimumAmount: '1000',
        minimumBaseUnits: MIN_OWNER_WITHDRAWAL_USDT_BASE_UNITS,
      })
    }
    const db = getPool(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })
    if (!tatumApiKey(env)) return res.status(503).json({ success: false, error: 'tatum-mainnet-key-not-configured' })

    const tronWeb = tronWebForMainnet()
    try {
      await ensureSchema(db)
      const existing = await db.query('SELECT * FROM ' + SCHEMA + '.owner_direct_withdrawals WHERE idempotency_key=$1 LIMIT 1', [idempotencyKey])
      if (existing.rows[0]) {
        const row = existing.rows[0]
        if (row.owner_address !== auth.address || row.recipient_address !== recipientAddress
          || String(row.amount_base_units) !== amountBaseUnits) {
          return res.status(409).json({ success: false, error: 'idempotency-key-reused-for-different-withdrawal' })
        }
        if (row.status !== 'prepared' || new Date(row.expires_at).getTime() <= Date.now()) {
          return res.status(409).json({ success: false, error: 'existing-withdrawal-not-preparable', withdrawal: publicWithdrawal(row) })
        }
        return res.json({
          success: true, duplicate: true, withdrawal: publicWithdrawal(row),
          unsignedTransaction: row.unsigned_transaction,
          note: 'This is the same unexpired prepared transaction; no second withdrawal was created.',
        })
      }

      const snapshot = await readOwnerSnapshot(env, auth.address)
      const reservedBaseUnits = await readOwnerUsdtReservations(db, auth.address)
      const availableBaseUnits = calculateOwnerWithdrawableUsdtBaseUnits(snapshot.usdtBalanceBaseUnits, reservedBaseUnits)
      if (BigInt(availableBaseUnits) < BigInt(amountBaseUnits)) {
        return res.status(409).json({
          success: false,
          error: 'insufficient-mainnet-usdt-balance-after-reservations',
          balanceBaseUnits: snapshot.usdtBalanceBaseUnits,
          reservedBaseUnits,
          availableBaseUnits,
          requestedBaseUnits: amountBaseUnits,
          note: 'The owner wallet must already hold the requested amount of official Mainnet USDT after reserving all other prepared or unresolved withdrawals. Tatum does not supply the token principal.',
        })
      }

      const feeRaw = clean(env.TRON_USDT_FEE_LIMIT_SUN || DEFAULT_FEE_LIMIT_SUN, 32)
      if (!/^[1-9][0-9]{0,9}$/.test(feeRaw) || BigInt(feeRaw) > 1_000_000_000n) {
        return res.status(503).json({ success: false, error: 'invalid-tron-usdt-fee-limit-configuration' })
      }
      const parameter = buildOwnerUsdtTransferParameter(recipientAddress, amountBaseUnits, tronWeb)
      const requestBody = {
        owner_address: auth.address,
        contract_address: MAINNET_USDT_CONTRACT,
        function_selector: 'transfer(address,uint256)',
        parameter,
        fee_limit: Number(feeRaw),
        call_value: 0,
        visible: true,
      }

      const simulation = await tatumPost(env, 'wallet/triggerconstantcontract', requestBody)
      if (simulation?.result?.result !== true) {
        return res.status(409).json({
          success: false,
          error: 'mainnet-usdt-transfer-preflight-failed',
          reason: clean(simulation?.result?.code || simulation?.result?.message, 128) || 'contract-simulation-rejected',
          note: 'Tatum did not confirm that this exact USDT transfer call can be simulated. Nothing was signed or broadcast.',
        })
      }

      const built = await tatumPost(env, 'wallet/triggersmartcontract', requestBody)
      const unsignedTransaction = built?.transaction
      if (built?.result?.result !== true || !transactionMatchesIntent(unsignedTransaction, {
        ownerAddress: auth.address,
        recipientAddress,
        amountBaseUnits,
        tronWeb,
      })) {
        return res.status(502).json({ success: false, error: 'tatum-unsigned-transaction-invalid' })
      }
      const expiration = Number(unsignedTransaction.raw_data.expiration)
      const id = randomUUID()
      const client = await db.connect()
      let savedRow
      try {
        await client.query('BEGIN')
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [auth.address])
        const lockedExisting = await client.query(
          'SELECT * FROM ' + SCHEMA + '.owner_direct_withdrawals WHERE idempotency_key=$1 LIMIT 1',
          [idempotencyKey],
        )
        if (lockedExisting.rows[0]) {
          const row = lockedExisting.rows[0]
          await client.query('COMMIT')
          if (row.owner_address !== auth.address || row.recipient_address !== recipientAddress
            || String(row.amount_base_units) !== amountBaseUnits) {
            return res.status(409).json({ success: false, error: 'idempotency-key-reused-for-different-withdrawal' })
          }
          if (row.status !== 'prepared' || new Date(row.expires_at).getTime() <= Date.now()) {
            return res.status(409).json({ success: false, error: 'existing-withdrawal-not-preparable', withdrawal: publicWithdrawal(row) })
          }
          return res.json({
            success: true, duplicate: true, withdrawal: publicWithdrawal(row),
            unsignedTransaction: row.unsigned_transaction,
            note: 'This is the same unexpired prepared transaction; no second withdrawal was created.',
          })
        }
        const lockedReservations = await readOwnerUsdtReservations(client, auth.address)
        const lockedAvailable = calculateOwnerWithdrawableUsdtBaseUnits(snapshot.usdtBalanceBaseUnits, lockedReservations)
        if (BigInt(lockedAvailable) < BigInt(amountBaseUnits)) {
          await client.query('ROLLBACK')
          return res.status(409).json({
            success: false,
            error: 'insufficient-mainnet-usdt-balance-after-reservations',
            balanceBaseUnits: snapshot.usdtBalanceBaseUnits,
            reservedBaseUnits: lockedReservations,
            availableBaseUnits: lockedAvailable,
            requestedBaseUnits: amountBaseUnits,
            note: 'Another prepared or unresolved withdrawal reserved part of this wallet balance. Refresh readiness and use only the remaining available balance.',
          })
        }
        const saved = await client.query(
          'INSERT INTO ' + SCHEMA + '.owner_direct_withdrawals (id,idempotency_key,owner_address,recipient_address,token_contract,amount_base_units,unsigned_transaction,transaction_hash,status,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10) RETURNING *',
          [id, idempotencyKey, auth.address, recipientAddress, MAINNET_USDT_CONTRACT, amountBaseUnits, JSON.stringify(unsignedTransaction), unsignedTransaction.txID, 'prepared', new Date(expiration).toISOString()],
        )
        savedRow = saved.rows[0]
        await client.query('COMMIT')
      } catch (error) {
        try { await client.query('ROLLBACK') } catch {}
        throw error
      } finally {
        client.release()
      }
      return res.status(201).json({
        success: true,
        withdrawal: publicWithdrawal(savedRow),
        unsignedTransaction,
        snapshot,
        estimatedEnergy: Number.isSafeInteger(Number(simulation.energy_used)) ? Number(simulation.energy_used) : null,
        estimatedEnergyPenalty: Number.isSafeInteger(Number(simulation.energy_penalty)) ? Number(simulation.energy_penalty) : null,
        feeLimitSun: feeRaw,
        note: 'Review the exact network, recipient, amount and fee limit. Only the configured owner wallet can sign. No funds move until TronLink signs and the backend verifies the owner signature.',
      })
    } catch (error) {
      return res.status(Number.isInteger(error?.status) ? error.status : 502).json({
        success: false,
        error: error?.status === 503 ? 'tatum-mainnet-unavailable-or-not-configured' : 'withdrawal-preparation-failed',
      })
    }
  })

  router.post('/:id/broadcast', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    if (REAL_OWNER_DIRECT_MAINNET_BROADCAST_DISABLED) {
      return res.status(503).json({ success:false, error:'owner-direct-mainnet-broadcast-disabled-in-this-build', transactionBroadcast:false })
    }
    const auth = await requireOwner(req, env)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const id = clean(req.params.id, 64)
    if (!UUID_RE.test(id)) return res.status(400).json({ success: false, error: 'invalid-withdrawal-id' })
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
    if (Object.keys(body).some((key) => key !== 'signedTransaction')) {
      return res.status(400).json({ success: false, error: 'unexpected-fields' })
    }
    const signedTransaction = body.signedTransaction
    let serialized
    try { serialized = JSON.stringify(signedTransaction) } catch { serialized = '' }
    if (!serialized || serialized.length > MAX_SIGNED_TRANSACTION_BYTES) {
      return res.status(400).json({ success: false, error: 'invalid-signed-transaction-size' })
    }
    const db = getPool(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })
    try {
      await ensureSchema(db)
      const client = await db.connect()
      let row
      try {
        await client.query('BEGIN')
        const found = await client.query('SELECT * FROM ' + SCHEMA + '.owner_direct_withdrawals WHERE id=$1 AND owner_address=$2 FOR UPDATE', [id, auth.address])
        if (!found.rows.length) {
          await client.query('ROLLBACK')
          return res.status(404).json({ success: false, error: 'withdrawal-not-found' })
        }
        row = found.rows[0]
        if (row.status !== 'prepared') {
          await client.query('COMMIT')
          return res.status(409).json({
            success: false,
            error: 'withdrawal-not-in-prepared-state',
            withdrawal: publicWithdrawal(row),
            note: 'A prepared transfer can only be broadcast once. Refresh its chain status before taking any further action.',
          })
        }
        if (new Date(row.expires_at).getTime() <= Date.now()) {
          await client.query('UPDATE ' + SCHEMA + '.owner_direct_withdrawals SET status=$2,failure_code=$3,updated_at=now() WHERE id=$1',
            [id, 'expired', 'unsigned-transaction-expired'])
          await client.query('COMMIT')
          return res.status(409).json({ success: false, error: 'unsigned-transaction-expired' })
        }
        const unsigned = row.unsigned_transaction
        const intent = {
          ownerAddress: auth.address,
          recipientAddress: row.recipient_address,
          amountBaseUnits: String(row.amount_base_units),
          tronWeb: tronWebForMainnet(),
        }
        const validation = validateOwnerSignedTransaction(signedTransaction, unsigned, intent)
        if (!validation.ok) {
          await client.query('ROLLBACK')
          return res.status(401).json({ success: false, error: validation.reason })
        }

        const approved = await tatumPost(env, 'wallet/getapprovedlist', {
          signature: signedTransaction.signature,
          raw_data: signedTransaction.raw_data,
          visible: true,
        })
        const approvedAddresses = Array.isArray(approved?.approved_list) ? approved.approved_list : []
        if (approved?.result?.result !== true || approved?.result?.code || !approvedAddresses.includes(auth.address)) {
          await client.query('ROLLBACK')
          return res.status(401).json({
            success: false,
            error: 'configured-owner-signature-not-approved',
            note: 'Tatum did not independently recover the configured owner address from the signed transaction.',
          })
        }

        await client.query(
          'UPDATE ' + SCHEMA + '.owner_direct_withdrawals SET status=$2,signed_transaction=$3::jsonb,updated_at=now() WHERE id=$1',
          [id, 'broadcasting', JSON.stringify(signedTransaction)],
        )
        await client.query('COMMIT')
      } catch (error) {
        try { await client.query('ROLLBACK') } catch {}
        throw error
      } finally {
        client.release()
      }

      let broadcast
      try {
        broadcast = await tatumPost(env, 'wallet/broadcasttransaction', signedTransaction)
      } catch {
        await db.query(
          'UPDATE ' + SCHEMA + '.owner_direct_withdrawals SET status=$2,failure_code=$3,updated_at=now() WHERE id=$1 AND status=$4',
          [id, 'outcome-unknown', 'tatum-broadcast-outcome-unknown', 'broadcasting'],
        )
        return res.status(202).json({
          success: true,
          status: 'outcome-unknown',
          transactionHash: row.transaction_hash,
          note: 'Tatum broadcast did not return a conclusive response. The transaction will be checked by its fixed transaction ID; do not create a replacement or sign a second payment.',
        })
      }
      if (broadcast?.result !== true) {
        await db.query(
          'UPDATE ' + SCHEMA + '.owner_direct_withdrawals SET status=$2,failure_code=$3,broadcast_response=$4::jsonb,updated_at=now() WHERE id=$1 AND status=$5',
          [id, 'broadcast-rejected', clean(broadcast?.code || broadcast?.message, 128) || 'tatum-broadcast-rejected', JSON.stringify(broadcast), 'broadcasting'],
        )
        return res.status(409).json({ success: false, error: 'tatum-broadcast-rejected', providerResult: clean(broadcast?.code || broadcast?.message, 128) })
      }
      await db.query(
        'UPDATE ' + SCHEMA + '.owner_direct_withdrawals SET status=$2,transaction_hash=$3,broadcast_response=$4::jsonb,updated_at=now() WHERE id=$1 AND status IN ($5,$6)',
        [id, 'submitted', row.transaction_hash, JSON.stringify(broadcast), 'broadcasting', 'outcome-unknown'],
      )
      return res.status(202).json({
        success: true,
        status: 'submitted',
        transactionHash: row.transaction_hash,
        note: 'Tatum accepted the signed transaction for broadcast. This is not final confirmation; refresh until the exact official USDT transfer is found in a solidified Mainnet receipt.',
      })
    } catch {
      return res.status(503).json({ success: false, error: 'withdrawal-broadcast-processing-failed' })
    }
  })

  async function refreshWithdrawal(db, row) {
    if (!['submitted', 'outcome-unknown', 'broadcasting'].includes(row.status)) return row
    const verification = await verifySolidifiedUsdtTransfer(env, {
      transactionHash: String(row.transaction_hash || row.unsigned_transaction?.txID || '').trim(),
      from: row.owner_address,
      to: row.recipient_address,
      amountBaseUnits: String(row.amount_base_units),
    })
    let status = row.status
    let failureCode = row.failure_code || null
    if (verification.verified) {
      status = 'confirmed'
      failureCode = null
    } else if (verification.status === 'solidified-transaction-failed') {
      status = 'failed'
      failureCode = 'confirmed-solidified-transaction-failed'
    } else if (verification.status === 'solidified-transfer-mismatch' || verification.status === 'ambiguous-transfer-event') {
      status = 'manual-review'
      failureCode = verification.status
    }
    if (status !== row.status || failureCode !== row.failure_code) {
      const updated = await db.query(
        'UPDATE ' + SCHEMA + '.owner_direct_withdrawals SET status=$2,failure_code=$3,updated_at=now() WHERE id=$1 RETURNING *',
        [row.id, status, failureCode],
      )
      return updated.rows[0] || row
    }
    return row
  }

  router.get('/:id', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    const auth = await requireOwner(req, env)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const id = clean(req.params.id, 64)
    if (!UUID_RE.test(id)) return res.status(400).json({ success: false, error: 'invalid-withdrawal-id' })
    const db = getPool(env)
    if (!db) return res.status(503).json({ success: false, error: 'database-not-configured' })
    try {
      await ensureSchema(db)
      const found = await db.query('SELECT * FROM ' + SCHEMA + '.owner_direct_withdrawals WHERE id=$1 AND owner_address=$2 LIMIT 1', [id, auth.address])
      if (!found.rows.length) return res.status(404).json({ success: false, error: 'withdrawal-not-found' })
      const row = await refreshWithdrawal(db, found.rows[0])
      return res.json({
        success: true,
        withdrawal: publicWithdrawal(row),
        confirmation: row.status === 'confirmed' ? { verified: true, source: 'Tatum solidified Mainnet transaction and receipt plus exact USDT Transfer event' } : null,
        note: row.status === 'confirmed'
          ? 'The exact official USDT transfer is confirmed in the solidified TRON Mainnet chain.'
          : 'Broadcast acceptance or a pending transaction is not confirmation. Refresh again to check solidified chain state.',
      })
    } catch {
      return res.status(502).json({ success: false, error: 'withdrawal-status-unavailable' })
    }
  })

  return router
}
