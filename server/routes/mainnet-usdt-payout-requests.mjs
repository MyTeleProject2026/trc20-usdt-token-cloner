import { createHash, timingSafeEqual } from 'node:crypto'
import { Router } from 'express'
import pg from 'pg'
import { TronWeb } from 'tronweb'
import { getWalletAuthSession, normalizeDatabaseConnectionString, databaseSslConfig } from '../database.mjs'
import { isValidTronAddress } from '../tron-address.mjs'
import {
  OFFICIAL_TRON_MAINNET_USDT,
  isPayoutRequestExpiryValid,
  parseUsdtAmountBaseUnits,
} from '../../src/treasury-payout-request-auth.mjs'

const { Pool } = pg
const MAINNET_RPC = 'https://api.trongrid.io'
const ADDRESS_PATTERN = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const SESSION_PATTERN = /^[A-Za-z0-9_-]{43}$/
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9._:-]{24,128}$/
const SIGNATURE_PATTERN = /^0x[0-9a-f]{130}$/i
const MAX_EXPIRY_FUTURE_MS = 120_000

function noStore(res) {
  res.setHeader('Cache-Control', 'no-store, private')
  res.setHeader('Pragma', 'no-cache')
  res.setHeader('Vary', 'Authorization')
}

function readBearerToken(req) {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.get('authorization') || '')
  return match ? match[1] : ''
}

function sameOwnerConfiguration(env) {
  const owner = typeof env.OWNER_WALLET_ADDRESS === 'string' ? env.OWNER_WALLET_ADDRESS.trim() : ''
  const treasuryOwner = typeof env.TREASURY_OWNER_ADDRESS === 'string' ? env.TREASURY_OWNER_ADDRESS.trim() : ''
  return ADDRESS_PATTERN.test(owner)
    && ADDRESS_PATTERN.test(treasuryOwner)
    && owner === treasuryOwner
    && isValidTronAddress(owner)
}

function isValidReviewToken(req, env) {
  const expectedValue = env.TREASURY_PAYOUT_REVIEW_API_TOKEN
  const header = req.get('authorization') || ''
  if (typeof expectedValue !== 'string' || expectedValue.length < 32
    || !header.startsWith('Bearer ')) return false
  const supplied = Buffer.from(header.slice(7))
  const expected = Buffer.from(expectedValue)
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

function toPublicRequest(row) {
  return {
    id: String(row.id),
    idempotencyKey: row.idempotency_key,
    network: 'mainnet',
    asset: 'Tether USDT',
    tokenContract: OFFICIAL_TRON_MAINNET_USDT,
    decimals: 6,
    requesterAddress: row.requester_address,
    recipientAddress: row.recipient_address,
    amountBaseUnits: String(row.amount_base_units),
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
    expiresAt: Number(row.authorization_expires_at),
  }
}

function sameIntent(row, input) {
  return row
    && row.requester_address === input.requesterAddress
    && row.recipient_address === input.recipientAddress
    && String(row.amount_base_units) === input.amountBaseUnits
    && row.token_contract === OFFICIAL_TRON_MAINNET_USDT
}

export function createMainnetUsdtPayoutRequestStore(env = process.env) {
  let pool
  let schemaPromise

  function getPool() {
    if (pool) return pool
    if (typeof env.DATABASE_URL !== 'string' || !env.DATABASE_URL.trim()) return null
    const connectionString = normalizeDatabaseConnectionString(env.DATABASE_URL)
    pool = new Pool({
      connectionString,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000,
      max: 3,
      ssl: databaseSslConfig(connectionString, env),
    })
    pool.on('error', (error) => console.error('Mainnet USDT payout-request database error:', error?.code || 'unknown'))
    return pool
  }

  async function ensureSchema(db) {
    if (!schemaPromise) {
      schemaPromise = (async () => {
        await db.query('CREATE SCHEMA IF NOT EXISTS trc20_token_clone')
        await db.query(`
          CREATE TABLE IF NOT EXISTS trc20_token_clone.mainnet_usdt_payout_requests (
            id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            idempotency_key TEXT NOT NULL UNIQUE,
            requester_address TEXT NOT NULL,
            recipient_address TEXT NOT NULL,
            token_contract TEXT NOT NULL CHECK (token_contract = '${OFFICIAL_TRON_MAINNET_USDT}'),
            amount_base_units NUMERIC(78,0) NOT NULL CHECK (amount_base_units > 0),
            decimals SMALLINT NOT NULL DEFAULT 6 CHECK (decimals = 6),
            status TEXT NOT NULL DEFAULT 'pending-organization-review'
              CHECK (status = 'pending-organization-review'),
            authorization_expires_at BIGINT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
          )
        `)
        await db.query(`
          CREATE INDEX IF NOT EXISTS mainnet_usdt_payout_requests_owner_idx
          ON trc20_token_clone.mainnet_usdt_payout_requests (requester_address, created_at DESC)
        `)
        await db.query(`
          CREATE INDEX IF NOT EXISTS mainnet_usdt_payout_requests_queue_idx
          ON trc20_token_clone.mainnet_usdt_payout_requests (status, created_at)
        `)
      })().catch((error) => { schemaPromise = null; throw error })
    }
    await schemaPromise
  }

  async function createRequest(input) {
    const db = getPool()
    if (!db) return { success: false, reason: 'database-not-configured' }
    await ensureSchema(db)
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtext($1))',
        ['mainnet-usdt-payout-request:' + input.requesterAddress],
      )
      const existing = await client.query(`
        SELECT * FROM trc20_token_clone.mainnet_usdt_payout_requests
        WHERE idempotency_key = $1
        LIMIT 1
        FOR UPDATE
      `, [input.idempotencyKey])
      if (existing.rows[0]) {
        const row = existing.rows[0]
        const matches = sameIntent(row, input)
        await client.query('COMMIT')
        return matches
          ? { success: true, duplicate: true, request: toPublicRequest(row) }
          : { success: false, reason: 'idempotency-key-conflict' }
      }

      const rate = await client.query(`
        SELECT COUNT(*)::INTEGER AS request_count
        FROM trc20_token_clone.mainnet_usdt_payout_requests
        WHERE requester_address = $1
          AND created_at >= now() - interval '1 hour'
      `, [input.requesterAddress])
      if (Number(rate.rows[0]?.request_count || 0) >= 10) {
        await client.query('ROLLBACK')
        return { success: false, reason: 'request-rate-limit-exceeded' }
      }

      const inserted = await client.query(`
        INSERT INTO trc20_token_clone.mainnet_usdt_payout_requests
          (idempotency_key, requester_address, recipient_address, token_contract, amount_base_units, decimals, authorization_expires_at)
        VALUES ($1,$2,$3,$4,$5,6,$6)
        ON CONFLICT (idempotency_key) DO NOTHING
        RETURNING *
      `, [
        input.idempotencyKey, input.requesterAddress, input.recipientAddress,
        OFFICIAL_TRON_MAINNET_USDT, input.amountBaseUnits, input.requestExpiresAt,
      ])
      if (inserted.rows[0]) {
        await client.query('COMMIT')
        return { success: true, duplicate: false, request: toPublicRequest(inserted.rows[0]) }
      }

      const raced = await client.query(`
        SELECT * FROM trc20_token_clone.mainnet_usdt_payout_requests
        WHERE idempotency_key = $1
        LIMIT 1
      `, [input.idempotencyKey])
      const row = raced.rows[0]
      const matches = sameIntent(row, input)
      await client.query('COMMIT')
      return matches
        ? { success: true, duplicate: true, request: toPublicRequest(row) }
        : { success: false, reason: 'idempotency-key-conflict' }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }

  async function findRequest(idempotencyKey, requesterAddress) {
    const db = getPool()
    if (!db) return { success: false, reason: 'database-not-configured' }
    await ensureSchema(db)
    const result = await db.query(`
      SELECT * FROM trc20_token_clone.mainnet_usdt_payout_requests
      WHERE idempotency_key = $1 AND requester_address = $2
      LIMIT 1
    `, [idempotencyKey, requesterAddress])
    return result.rows[0]
      ? { success: true, request: toPublicRequest(result.rows[0]) }
      : { success: false, reason: 'request-not-found' }
  }

  async function listRequests({ limit = 50 } = {}) {
    const db = getPool()
    if (!db) return { success: false, reason: 'database-not-configured' }
    await ensureSchema(db)
    const result = await db.query(`
      SELECT * FROM trc20_token_clone.mainnet_usdt_payout_requests
      WHERE status = 'pending-organization-review'
      ORDER BY created_at ASC
      LIMIT $1
    `, [limit])
    return { success: true, requests: result.rows.map(toPublicRequest) }
  }

  return { createRequest, findRequest, listRequests }
}

export function createMainnetUsdtPayoutRequestRouter({
  env = process.env,
  sessionLookup = getWalletAuthSession,
  store = createMainnetUsdtPayoutRequestStore(env),
  tronWebFactory = () => new TronWeb({
    fullHost: MAINNET_RPC,
    ...(typeof env.TRONGRID_API_KEY === 'string' && env.TRONGRID_API_KEY.trim()
      ? { headers: { 'TRON-PRO-API-KEY': env.TRONGRID_API_KEY.trim() } }
      : {}),
  }),
  now = () => Date.now(),
} = {}) {
  const router = Router()

  async function authenticateOwner(req) {
    const token = readBearerToken(req)
    const origin = req.get('origin')
    if (!token || !origin) return { ok: false, status: 401, error: 'owner-mainnet-session-required' }
    if (!sameOwnerConfiguration(env)) return { ok: false, status: 503, error: 'unified-owner-address-configuration-required' }
    try {
      const result = await sessionLookup({
        tokenHash: createHash('sha256').update(token, 'utf8').digest('hex'),
        origin,
      })
      const session = result?.session
      const expectedOwner = String(env.TREASURY_OWNER_ADDRESS || '').trim()
      if (result?.success !== true || !session) return { ok: false, status: 401, error: 'invalid-or-expired-owner-session' }
      if (session.network !== 'mainnet' || session.address !== expectedOwner || session.origin !== origin) {
        return { ok: false, status: 403, error: 'treasury-owner-only' }
      }
      return { ok: true, requesterAddress: expectedOwner, origin }
    } catch {
      return { ok: false, status: 503, error: 'owner-session-verification-unavailable' }
    }
  }

  async function verifySignature(message, signature, expectedAddress) {
    try {
      const tronWeb = tronWebFactory()
      if (typeof tronWeb?.trx?.verifyMessageV2 !== 'function') return false
      return await tronWeb.trx.verifyMessageV2(message, signature) === expectedAddress
    } catch {
      return false
    }
  }

  router.post('/payout-requests', async (req, res) => {
    noStore(res)
    const auth = await authenticateOwner(req)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error, transferSubmissionEnabled: false })

    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
    const allowed = new Set(['idempotencyKey', 'recipientAddress', 'amountUsdt', 'requestExpiresAt', 'ownerRequestSignature'])
    if (Object.keys(body).some((key) => !allowed.has(key))) {
      return res.status(400).json({ success: false, error: 'unexpected-request-fields', transferSubmissionEnabled: false })
    }
    if (typeof body.idempotencyKey !== 'string' || !IDEMPOTENCY_PATTERN.test(body.idempotencyKey)
      || typeof body.recipientAddress !== 'string' || !ADDRESS_PATTERN.test(body.recipientAddress)
      || !isValidTronAddress(body.recipientAddress)
      || body.recipientAddress === auth.requesterAddress
      || typeof body.amountUsdt !== 'string'
      || !Number.isSafeInteger(body.requestExpiresAt)
      || typeof body.ownerRequestSignature !== 'string'
      || !SIGNATURE_PATTERN.test(body.ownerRequestSignature)) {
      return res.status(400).json({ success: false, error: 'invalid-mainnet-usdt-payout-request', transferSubmissionEnabled: false })
    }

    const clockValue = now()
    const currentTimeMs = clockValue instanceof Date ? clockValue.getTime() : Number(clockValue)
    if (!isPayoutRequestExpiryValid(body.requestExpiresAt, currentTimeMs, MAX_EXPIRY_FUTURE_MS)) {
      return res.status(401).json({ success: false, error: 'payout-request-signature-expired-or-outside-window', transferSubmissionEnabled: false })
    }

    let amountBaseUnits
    try { amountBaseUnits = parseUsdtAmountBaseUnits(body.amountUsdt) } catch (error) {
      return res.status(400).json({ success: false, error: 'invalid-usdt-amount', message: error.message, transferSubmissionEnabled: false })
    }

    let message
    try {
      const { buildTreasuryPayoutRequestMessage } = await import('../../src/treasury-payout-request-auth.mjs')
      message = buildTreasuryPayoutRequestMessage({
        origin: auth.origin,
        requesterAddress: auth.requesterAddress,
        recipientAddress: body.recipientAddress,
        amountBaseUnits,
        idempotencyKey: body.idempotencyKey,
        requestExpiresAt: body.requestExpiresAt,
      })
    } catch {
      return res.status(400).json({ success: false, error: 'payout-request-message-invalid', transferSubmissionEnabled: false })
    }

    if (!await verifySignature(message, body.ownerRequestSignature, auth.requesterAddress)) {
      return res.status(403).json({ success: false, error: 'owner-request-signature-invalid', transferSubmissionEnabled: false })
    }

    try {
      const stored = await store.createRequest({
        idempotencyKey: body.idempotencyKey,
        requesterAddress: auth.requesterAddress,
        recipientAddress: body.recipientAddress,
        amountBaseUnits,
        requestExpiresAt: body.requestExpiresAt,
      })
      if (stored?.success !== true || !stored.request) {
        const reason = stored?.reason || 'request-storage-unavailable'
        const status = reason === 'idempotency-key-conflict' ? 409
          : reason === 'request-rate-limit-exceeded' ? 429 : 503
        return res.status(status).json({ success: false, error: reason, transferSubmissionEnabled: false })
      }
      return res.status(stored.duplicate ? 200 : 201).json({
        success: true,
        status: 'pending-organization-review',
        duplicate: stored.duplicate === true,
        request: stored.request,
        officialAssetVerifiedByConfiguration: true,
        payoutAuthorized: false,
        transferSubmissionEnabled: false,
        providerSubmissionAttempted: false,
        transactionCreated: false,
        transactionBroadcast: false,
        message: 'The exact official TRON Mainnet Tether USDT request was stored for independent organization review only. It is not an approval, budget reservation, Fireblocks instruction, or token transfer.',
      })
    } catch {
      return res.status(503).json({ success: false, error: 'request-storage-unavailable', transferSubmissionEnabled: false })
    }
  })

  router.get('/payout-requests/:idempotencyKey', async (req, res) => {
    noStore(res)
    const auth = await authenticateOwner(req)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const key = req.params?.idempotencyKey
    if (typeof key !== 'string' || !IDEMPOTENCY_PATTERN.test(key)) {
      return res.status(400).json({ success: false, error: 'invalid-idempotency-key' })
    }
    try {
      const result = await store.findRequest(key, auth.requesterAddress)
      if (!result?.success) return res.status(result?.reason === 'request-not-found' ? 404 : 503).json({ success: false, error: result?.reason || 'request-lookup-unavailable' })
      return res.json({ success: true, request: result.request, transferSubmissionEnabled: false, transactionBroadcast: false })
    } catch {
      return res.status(503).json({ success: false, error: 'request-lookup-unavailable' })
    }
  })

  router.get('/payout-requests', async (req, res) => {
    noStore(res)
    if (!isValidReviewToken(req, env)) {
      const configured = typeof env.TREASURY_PAYOUT_REVIEW_API_TOKEN === 'string'
        && env.TREASURY_PAYOUT_REVIEW_API_TOKEN.length >= 32
      return res.status(configured ? 401 : 503).json({
        success: false,
        error: configured ? 'unauthorized' : 'treasury-payout-review-token-not-configured',
      })
    }
    const rawLimit = req.query?.limit === undefined ? '50' : String(req.query.limit)
    const limit = Number(rawLimit)
    if (!/^(?:[1-9]|[1-9][0-9]|100)$/.test(rawLimit) || !Number.isInteger(limit)) {
      return res.status(400).json({ success: false, error: 'invalid-limit' })
    }
    try {
      const result = await store.listRequests({ limit })
      if (result?.success !== true) return res.status(503).json({ success: false, error: result?.reason || 'request-queue-unavailable' })
      return res.json({
        success: true,
        asset: 'official-tether-usdt-trc20',
        network: 'mainnet',
        requests: result.requests,
        count: result.requests.length,
        transferSubmissionEnabled: false,
        providerSubmissionAttempted: false,
        transactionBroadcast: false,
        message: 'Read-only organization review queue. No request has been approved, funded, signed, or broadcast by this endpoint.',
      })
    } catch {
      return res.status(503).json({ success: false, error: 'request-queue-unavailable' })
    }
  })

  return router
}

export default createMainnetUsdtPayoutRequestRouter()
