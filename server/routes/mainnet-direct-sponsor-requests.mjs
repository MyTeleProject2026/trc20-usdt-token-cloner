import { createHash, timingSafeEqual } from 'node:crypto'
import { Router } from 'express'
import pg from 'pg'
import { createMainnetDirectSponsorApprovalRouter, createMainnetDirectSponsorApprovalStore } from './mainnet-direct-sponsor-approval.mjs'
import { getWalletAuthSession, normalizeDatabaseConnectionString, databaseSslConfig } from '../database.mjs'
import { isValidTronAddress } from '../tron-address.mjs'

const { Pool } = pg
export const OFFICIAL_MAINNET_USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9._:-]{24,160}$/
const AMOUNT_PATTERN = /^[1-9][0-9]{0,77}$/
const MAX_UINT256 = (1n << 256n) - 1n

function noStore(res) {
  res.setHeader('Cache-Control', 'no-store, private')
  res.setHeader('Pragma', 'no-cache')
  res.setHeader('Vary', 'Origin, Authorization')
}

function readBearerToken(req) {
  const value = req.get('authorization') || ''
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(value)
  return match ? match[1] : ''
}

function isValidAdminToken(req, env) {
  const expectedValue = env.SPONSOR_ADMIN_API_TOKEN
  const header = req.get('authorization') || ''
  if (typeof expectedValue !== 'string' || expectedValue.length < 32
    || typeof header !== 'string' || !header.startsWith('Bearer ')) return false
  const supplied = Buffer.from(header.slice(7))
  const expected = Buffer.from(expectedValue)
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

function sameIntent(row, input) {
  return row
    && row.requester_address === input.requesterAddress
    && row.recipient_address === input.recipientAddress
    && row.token_contract === input.tokenContract
    && String(row.amount_base_units) === input.amountBaseUnits
    && Number(row.decimals) === input.decimals
}

function publicRequest(row, { includeRequester = false } = {}) {
  return {
    id: String(row.id),
    idempotencyKey: row.idempotency_key,
    ...(includeRequester ? { requesterAddress: row.requester_address } : {}),
    recipientAddress: row.recipient_address,
    network: 'mainnet',
    asset: 'USDT',
    tokenContract: row.token_contract,
    amountBaseUnits: String(row.amount_base_units),
    decimals: Number(row.decimals),
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
  }
}

/**
 * Mainnet direct-to-recipient request intake only. The request does not reserve
 * sponsor assets, create a transaction, authorize a signer, or submit to TRON.
 */
export function createMainnetDirectSponsorRequestStore(env = process.env) {
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
    pool.on('error', (error) => console.error('Mainnet direct sponsor request database error:', error?.code || 'unknown'))
    return pool
  }

  async function ensureSchema(db) {
    if (!schemaPromise) {
      schemaPromise = (async () => {
        await db.query('CREATE SCHEMA IF NOT EXISTS trc20_token_clone')
        await db.query(`
          CREATE TABLE IF NOT EXISTS trc20_token_clone.mainnet_direct_sponsor_requests (
            id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            idempotency_key TEXT NOT NULL UNIQUE,
            requester_address TEXT NOT NULL,
            recipient_address TEXT NOT NULL,
            network TEXT NOT NULL DEFAULT 'mainnet' CHECK (network = 'mainnet'),
            asset TEXT NOT NULL DEFAULT 'USDT' CHECK (asset = 'USDT'),
            token_contract TEXT NOT NULL CHECK (token_contract = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'),
            amount_base_units NUMERIC(78,0) NOT NULL CHECK (amount_base_units > 0),
            decimals SMALLINT NOT NULL DEFAULT 6 CHECK (decimals = 6),
            status TEXT NOT NULL DEFAULT 'pending-sponsor-review'
              CHECK (status = 'pending-sponsor-review'),
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
          )
        `)
        await db.query(`
          CREATE INDEX IF NOT EXISTS mainnet_direct_sponsor_requests_owner_idx
          ON trc20_token_clone.mainnet_direct_sponsor_requests (requester_address, created_at DESC)
        `)
        await db.query(`
          CREATE INDEX IF NOT EXISTS mainnet_direct_sponsor_requests_queue_idx
          ON trc20_token_clone.mainnet_direct_sponsor_requests (status, created_at)
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
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [input.requesterAddress])
      const existing = await client.query(`
        SELECT * FROM trc20_token_clone.mainnet_direct_sponsor_requests
        WHERE idempotency_key = $1 LIMIT 1 FOR UPDATE
      `, [input.idempotencyKey])
      if (existing.rows[0]) {
        const row = existing.rows[0]
        const matches = sameIntent(row, input)
        await client.query('COMMIT')
        return matches
          ? { success: true, duplicate: true, request: publicRequest(row) }
          : { success: false, reason: 'idempotency-key-conflict' }
      }

      const rate = await client.query(`
        SELECT COUNT(*)::INTEGER AS request_count
        FROM trc20_token_clone.mainnet_direct_sponsor_requests
        WHERE requester_address = $1 AND created_at >= now() - interval '1 hour'
      `, [input.requesterAddress])
      if (Number(rate.rows[0]?.request_count || 0) >= 10) {
        await client.query('ROLLBACK')
        return { success: false, reason: 'request-rate-limit-exceeded' }
      }

      const inserted = await client.query(`
        INSERT INTO trc20_token_clone.mainnet_direct_sponsor_requests
          (idempotency_key, requester_address, recipient_address, token_contract, amount_base_units)
        VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (idempotency_key) DO NOTHING
        RETURNING *
      `, [input.idempotencyKey, input.requesterAddress, input.recipientAddress,
        input.tokenContract, input.amountBaseUnits])
      if (inserted.rows[0]) {
        await client.query('COMMIT')
        return { success: true, duplicate: false, request: publicRequest(inserted.rows[0]) }
      }

      const raced = await client.query(`
        SELECT * FROM trc20_token_clone.mainnet_direct_sponsor_requests
        WHERE idempotency_key = $1 LIMIT 1
      `, [input.idempotencyKey])
      const row = raced.rows[0]
      const matches = sameIntent(row, input)
      await client.query('COMMIT')
      return matches
        ? { success: true, duplicate: true, request: publicRequest(row) }
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
      SELECT * FROM trc20_token_clone.mainnet_direct_sponsor_requests
      WHERE idempotency_key = $1 AND requester_address = $2 LIMIT 1
    `, [idempotencyKey, requesterAddress])
    return result.rows[0]
      ? { success: true, request: publicRequest(result.rows[0]) }
      : { success: false, reason: 'request-not-found' }
  }

  async function listRequests({ limit = 50 } = {}) {
    const db = getPool()
    if (!db) return { success: false, reason: 'database-not-configured' }
    await ensureSchema(db)
    const result = await db.query(`
      SELECT * FROM trc20_token_clone.mainnet_direct_sponsor_requests
      WHERE status = 'pending-sponsor-review'
      ORDER BY created_at ASC
      LIMIT $1
    `, [limit])
    return { success: true, requests: result.rows.map((row) => publicRequest(row, { includeRequester: true })) }
  }

  async function close() {
    if (!pool) return
    const currentPool = pool
    pool = null
    schemaPromise = null
    await currentPool.end()
  }

  return { createRequest, findRequest, listRequests, close }
}

export function createMainnetDirectSponsorRequestRouter({
  env = process.env,
  sessionLookup = getWalletAuthSession,
  store = createMainnetDirectSponsorRequestStore(env),
  approvalStore = (typeof store.createApprovalChallenge === 'function'
    ? store : createMainnetDirectSponsorApprovalStore(env)),
  readSponsorRoles,
  now,
  nonceFactory,
  verifySponsorMessage,
} = {}) {
  const router = Router()

  async function authenticateMainnetRequester(req) {
    const token = readBearerToken(req)
    const origin = req.get('origin')
    if (!token || !origin) return { ok: false, status: 401, error: 'mainnet-wallet-session-required' }
    try {
      const result = await sessionLookup({
        tokenHash: createHash('sha256').update(token, 'utf8').digest('hex'),
        origin,
      })
      const session = result?.session
      if (result?.success !== true || !session) return { ok: false, status: 401, error: 'invalid-or-expired-wallet-session' }
      if (session.network !== 'mainnet' || session.origin !== origin
        || !isValidTronAddress(session.address)
        || !Number.isFinite(session.expiresAt) || session.expiresAt <= Date.now()) {
        return { ok: false, status: 403, error: 'mainnet-wallet-session-required' }
      }
      return { ok: true, session }
    } catch {
      return { ok: false, status: 503, error: 'wallet-session-verification-unavailable' }
    }
  }

  router.post('/sponsorship/mainnet-direct/requests', async (req, res) => {
    noStore(res)
    const auth = await authenticateMainnetRequester(req)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error, canSubmitSponsoredTransfer: false })

    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
    const allowed = new Set(['idempotencyKey', 'recipientAddress', 'tokenContract', 'amountBaseUnits', 'decimals'])
    if (Object.keys(body).some((key) => !allowed.has(key))) {
      return res.status(400).json({ success: false, error: 'unexpected-fields', canSubmitSponsoredTransfer: false })
    }
    const recipientAddress = typeof body.recipientAddress === 'string' ? body.recipientAddress.trim() : ''
    const requesterAddress = auth.session.address
    const tokenContract = typeof body.tokenContract === 'string' ? body.tokenContract.trim() : ''
    if (typeof body.idempotencyKey !== 'string' || !IDEMPOTENCY_PATTERN.test(body.idempotencyKey)
      || !isValidTronAddress(recipientAddress)
      || recipientAddress === requesterAddress
      || tokenContract !== OFFICIAL_MAINNET_USDT_CONTRACT
      || typeof body.amountBaseUnits !== 'string' || !AMOUNT_PATTERN.test(body.amountBaseUnits)
      || BigInt(body.amountBaseUnits) > MAX_UINT256
      || body.decimals !== 6) {
      return res.status(400).json({
        success: false,
        error: 'invalid-mainnet-direct-usdt-request',
        message: 'Mainnet requests require a different valid recipient, the official Tether USDT contract, a positive integer amount in six-decimal base units, and a valid idempotency key.',
        canSubmitSponsoredTransfer: false,
      })
    }

    try {
      const stored = await store.createRequest({
        idempotencyKey: body.idempotencyKey,
        requesterAddress,
        recipientAddress,
        tokenContract: OFFICIAL_MAINNET_USDT_CONTRACT,
        amountBaseUnits: body.amountBaseUnits,
        decimals: 6,
      })
      if (stored?.success !== true || !stored.request) {
        const reason = stored?.reason || 'request-storage-unavailable'
        const status = reason === 'idempotency-key-conflict' ? 409
          : reason === 'request-rate-limit-exceeded' ? 429 : 503
        return res.status(status).json({ success: false, error: reason, canSubmitSponsoredTransfer: false })
      }
      return res.status(stored.duplicate ? 200 : 201).json({
        success: true,
        status: 'pending-sponsor-review',
        duplicate: stored.duplicate === true,
        request: stored.request,
        sponsorApproved: false,
        budgetReserved: false,
        signingIntentCreated: false,
        canSubmitSponsoredTransfer: false,
        submissionEnabled: false,
        providerSubmissionAttempted: false,
        transactionBroadcast: false,
        unpaidFallbackToUserFunds: false,
        message: 'The Mainnet USDT payout request is stored for independent sponsor review. No sponsor funds were reserved, and no transaction was signed or broadcast.',
      })
    } catch {
      return res.status(503).json({ success: false, error: 'request-storage-unavailable', canSubmitSponsoredTransfer: false })
    }
  })

  router.get('/sponsorship/mainnet-direct/requests/:idempotencyKey', async (req, res) => {
    noStore(res)
    const auth = await authenticateMainnetRequester(req)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const key = req.params?.idempotencyKey
    if (typeof key !== 'string' || !IDEMPOTENCY_PATTERN.test(key)) {
      return res.status(400).json({ success: false, error: 'invalid-idempotency-key' })
    }
    try {
      const result = await store.findRequest(key, auth.session.address)
      if (!result?.success) return res.status(result?.reason === 'request-not-found' ? 404 : 503).json({ success: false, error: result?.reason || 'request-lookup-unavailable' })
      const approvals = typeof approvalStore.findApprovalsForOwner === 'function'
        ? await approvalStore.findApprovalsForOwner(key, auth.session.address)
        : { success: true, sponsorApproval: result.sponsorApproval, feeSponsorApproval: result.feeSponsorApproval }
      if (approvals?.success !== true) return res.status(503).json({ success: false, error: approvals?.reason || 'approval-status-unavailable' })
      return res.json({
        success: true,
        request: result.request,
        sponsorApproved: approvals.sponsorApproval?.status === 'approved-active',
        sponsorApproval: approvals.sponsorApproval,
        feeSponsorApproved: approvals.feeSponsorApproval?.status === 'approved-active',
        feeSponsorApproval: approvals.feeSponsorApproval,
        canCreateSigningIntent: false,
        canSubmitSponsoredTransfer: false,
        transactionBroadcast: false,
        unpaidFallbackToUserFunds: false,
      })
    } catch {
      return res.status(503).json({ success: false, error: 'request-lookup-unavailable' })
    }
  })

  router.get('/sponsorship/mainnet-direct/requests', async (req, res) => {
    noStore(res)
    if (!isValidAdminToken(req, env)) {
      const configured = typeof env.SPONSOR_ADMIN_API_TOKEN === 'string' && env.SPONSOR_ADMIN_API_TOKEN.length >= 32
      return res.status(configured ? 401 : 503).json({
        success: false,
        error: configured ? 'unauthorized' : 'sponsor-admin-not-configured',
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
        status: 'pending-sponsor-review',
        requests: result.requests,
        count: result.requests.length,
        sponsorApprovalEnabled: false,
        canSubmitSponsoredTransfer: false,
        transactionBroadcast: false,
        message: 'This organization queue is review-only. Sponsor consent, independent account authority, funds, policy and transaction approval remain separate gates.',
      })
    } catch {
      return res.status(503).json({ success: false, error: 'request-queue-unavailable' })
    }
  })

  router.use(createMainnetDirectSponsorApprovalRouter({
    env,
    sessionLookup,
    store: approvalStore,
    ...(readSponsorRoles ? { readSponsorRoles } : {}),
    ...(now ? { now } : {}),
    ...(nonceFactory ? { nonceFactory } : {}),
    ...(verifySponsorMessage ? { verifySponsorMessage } : {}),
  }))

  return router
}

export default createMainnetDirectSponsorRequestRouter()
