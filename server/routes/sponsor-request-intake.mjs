import { createHash, timingSafeEqual } from 'node:crypto'
import { Router } from 'express'
import pg from 'pg'
import { getWalletAuthSession, normalizeDatabaseConnectionString, databaseSslConfig } from '../database.mjs'
import { isValidTronAddress } from '../tron-address.mjs'

const { Pool } = pg
const NETWORKS = new Set(['nile', 'shasta'])
const ADDRESS_PATTERN = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9._:-]{24,160}$/
const AMOUNT_PATTERN = /^[1-9][0-9]{0,77}$/
const TOKEN_ASSETS = ['USDT', 'VTRC']

function noStore(res) {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Pragma', 'no-cache')
  res.setHeader('Vary', 'Authorization')
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

function configuredTokenAssets(env, network) {
  const suffix = network.toUpperCase()
  return Object.fromEntries(TOKEN_ASSETS.map((asset) => {
    const variable = `SPONSOR_${asset}_${suffix}_CONTRACTS`
    const contracts = typeof env[variable] === 'string'
      ? [...new Set(env[variable].split(',').map((value) => value.trim()).filter(isValidTronAddress))]
      : []
    return [asset, contracts]
  }))
}

function resolveTokenAsset(env, network, contract) {
  const configured = configuredTokenAssets(env, network)
  const matches = TOKEN_ASSETS.filter((asset) => configured[asset].includes(contract))
  return matches.length === 1 ? matches[0] : null
}

function sameIntent(row, input) {
  return row
    && row.requester_address === input.requesterAddress
    && row.network === input.network
    && row.recipient_address === input.recipientAddress
    && row.asset === input.asset
    && (row.token_contract || null) === (input.tokenContract || null)
    && String(row.amount_base_units) === input.amountBaseUnits
    && Number(row.decimals) === input.decimals
}

function toPublicRequest(row) {
  return {
    id: String(row.id),
    idempotencyKey: row.idempotency_key,
    requesterAddress: row.requester_address,
    network: row.network,
    recipientAddress: row.recipient_address,
    asset: row.asset,
    tokenContract: row.token_contract || null,
    amountBaseUnits: String(row.amount_base_units),
    decimals: Number(row.decimals),
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
  }
}

/**
 * A persisted, non-executable handoff queue. It cannot reserve sponsor budget,
 * create an unsigned transaction, invoke Fireblocks, sign, or broadcast.
 */
export function createSponsorRequestStore(env = process.env) {
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
    pool.on('error', (error) => console.error('Sponsor request database error:', error?.code || 'unknown'))
    return pool
  }

  async function ensureSchema(db) {
    if (!schemaPromise) {
      schemaPromise = (async () => {
        await db.query('CREATE SCHEMA IF NOT EXISTS trc20_token_clone')
        await db.query(`
          CREATE TABLE IF NOT EXISTS trc20_token_clone.sponsor_payout_intake_requests (
            id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            idempotency_key TEXT NOT NULL UNIQUE,
            requester_address TEXT NOT NULL,
            network TEXT NOT NULL CHECK (network IN ('nile', 'shasta')),
            recipient_address TEXT NOT NULL,
            asset TEXT NOT NULL CHECK (asset IN ('TRX', 'USDT', 'VTRC')),
            token_contract TEXT,
            amount_base_units NUMERIC(78,0) NOT NULL CHECK (amount_base_units > 0),
            decimals SMALLINT NOT NULL CHECK (decimals BETWEEN 0 AND 30),
            status TEXT NOT NULL DEFAULT 'pending-organization-review'
              CHECK (status IN ('pending-organization-review')),
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            CHECK ((asset = 'TRX' AND token_contract IS NULL AND decimals = 6)
              OR (asset IN ('USDT', 'VTRC') AND token_contract IS NOT NULL))
          )
        `)
        await db.query(`
          CREATE INDEX IF NOT EXISTS sponsor_payout_intake_owner_idx
          ON trc20_token_clone.sponsor_payout_intake_requests (requester_address, network, created_at DESC)
        `)
        await db.query(`
          CREATE INDEX IF NOT EXISTS sponsor_payout_intake_queue_idx
          ON trc20_token_clone.sponsor_payout_intake_requests (network, status, created_at)
        `)
      })().catch((error) => { schemaPromise = null; throw error })
    }
    await schemaPromise
  }

  async function findRequest(idempotencyKey, requesterAddress, network) {
    const db = getPool()
    if (!db) return { success: false, reason: 'database-not-configured' }
    await ensureSchema(db)
    const result = await db.query(`
      SELECT * FROM trc20_token_clone.sponsor_payout_intake_requests
      WHERE idempotency_key = $1 AND requester_address = $2 AND network = $3
      LIMIT 1
    `, [idempotencyKey, requesterAddress, network])
    return result.rows[0]
      ? { success: true, request: toPublicRequest(result.rows[0]) }
      : { success: false, reason: 'request-not-found' }
  }

  async function createRequest(input) {
    const db = getPool()
    if (!db) return { success: false, reason: 'database-not-configured' }
    await ensureSchema(db)
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const existing = await client.query(`
        SELECT * FROM trc20_token_clone.sponsor_payout_intake_requests
        WHERE idempotency_key = $1 LIMIT 1 FOR UPDATE
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
        FROM trc20_token_clone.sponsor_payout_intake_requests
        WHERE requester_address = $1 AND created_at >= now() - interval '1 hour'
      `, [input.requesterAddress])
      if (Number(rate.rows[0]?.request_count || 0) >= 10) {
        await client.query('ROLLBACK')
        return { success: false, reason: 'request-rate-limit-exceeded' }
      }

      const inserted = await client.query(`
        INSERT INTO trc20_token_clone.sponsor_payout_intake_requests
          (idempotency_key, requester_address, network, recipient_address, asset, token_contract, amount_base_units, decimals)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (idempotency_key) DO NOTHING
        RETURNING *
      `, [
        input.idempotencyKey, input.requesterAddress, input.network, input.recipientAddress,
        input.asset, input.tokenContract, input.amountBaseUnits, input.decimals,
      ])
      if (inserted.rows[0]) {
        await client.query('COMMIT')
        return { success: true, duplicate: false, request: toPublicRequest(inserted.rows[0]) }
      }

      const raced = await client.query(`
        SELECT * FROM trc20_token_clone.sponsor_payout_intake_requests
        WHERE idempotency_key = $1 LIMIT 1
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

  async function listRequests({ network, limit = 50 } = {}) {
    const db = getPool()
    if (!db) return { success: false, reason: 'database-not-configured' }
    await ensureSchema(db)
    const result = await db.query(`
      SELECT * FROM trc20_token_clone.sponsor_payout_intake_requests
      WHERE status = 'pending-organization-review'
        AND ($1::text IS NULL OR network = $1)
      ORDER BY created_at ASC
      LIMIT $2
    `, [network || null, limit])
    return { success: true, requests: result.rows.map(toPublicRequest) }
  }

  return { findRequest, createRequest, listRequests }
}

export function createSponsorRequestIntakeRouter({
  env = process.env,
  sessionLookup = getWalletAuthSession,
  store = createSponsorRequestStore(env),
} = {}) {
  const router = Router()

  async function authenticateRequester(req) {
    const token = readBearerToken(req)
    const origin = req.get('origin')
    if (!token || !origin) return { ok: false, status: 401, error: 'wallet-session-required' }
    try {
      const result = await sessionLookup({
        tokenHash: createHash('sha256').update(token, 'utf8').digest('hex'),
        origin,
      })
      const session = result?.session
      if (result?.success !== true || !session) return { ok: false, status: 401, error: 'invalid-or-expired-wallet-session' }
      if (!NETWORKS.has(session.network) || session.origin !== origin
        || !ADDRESS_PATTERN.test(session.address || '') || !isValidTronAddress(session.address)) {
        return { ok: false, status: 403, error: 'testnet-wallet-session-required' }
      }
      return { ok: true, session }
    } catch {
      return { ok: false, status: 503, error: 'wallet-session-verification-unavailable' }
    }
  }

  router.post('/sponsorship/requests', async (req, res) => {
    noStore(res)
    const auth = await authenticateRequester(req)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error, submissionEnabled: false })

    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
    const allowed = new Set([
      'idempotencyKey', 'network', 'recipientAddress', 'asset', 'tokenContract',
      'amountBaseUnits', 'decimals',
    ])
    if (Object.keys(body).some((key) => !allowed.has(key))) {
      return res.status(400).json({ success: false, error: 'unexpected-fields', submissionEnabled: false })
    }
    if (!NETWORKS.has(body.network) || body.network !== auth.session.network
      || typeof body.idempotencyKey !== 'string' || !IDEMPOTENCY_PATTERN.test(body.idempotencyKey)
      || typeof body.recipientAddress !== 'string' || !ADDRESS_PATTERN.test(body.recipientAddress)
      || !isValidTronAddress(body.recipientAddress)
      || body.recipientAddress === auth.session.address
      || !['TRX', 'TRC20'].includes(body.asset)
      || typeof body.amountBaseUnits !== 'string' || !AMOUNT_PATTERN.test(body.amountBaseUnits)
      || BigInt(body.amountBaseUnits) > ((1n << 256n) - 1n)
      || !Number.isInteger(body.decimals) || body.decimals < 0 || body.decimals > 30) {
      return res.status(400).json({ success: false, error: 'invalid-testnet-sponsor-request', submissionEnabled: false })
    }

    let asset = body.asset
    let tokenContract = null
    if (body.asset === 'TRX') {
      if (body.tokenContract != null && body.tokenContract !== '' || body.decimals !== 6) {
        return res.status(400).json({ success: false, error: 'invalid-native-trx-request', submissionEnabled: false })
      }
    } else {
      if (typeof body.tokenContract !== 'string' || !ADDRESS_PATTERN.test(body.tokenContract)
        || !isValidTronAddress(body.tokenContract)) {
        return res.status(400).json({ success: false, error: 'invalid-token-contract', submissionEnabled: false })
      }
      const resolvedAsset = resolveTokenAsset(env, auth.session.network, body.tokenContract.trim())
      if (!resolvedAsset) {
        return res.status(422).json({
          success: false,
          error: 'token-contract-not-allowlisted-for-testnet',
          message: 'This contract is not in the sponsor organization’s explicit token allowlist for the selected testnet.',
          submissionEnabled: false,
        })
      }
      asset = resolvedAsset
      tokenContract = body.tokenContract.trim()
    }

    const idempotencyInput = {
      idempotencyKey: body.idempotencyKey,
      requesterAddress: auth.session.address,
      network: auth.session.network,
      recipientAddress: body.recipientAddress.trim(),
      asset,
      tokenContract,
      amountBaseUnits: body.amountBaseUnits,
      decimals: body.decimals,
    }

    try {
      const stored = await store.createRequest(idempotencyInput)
      if (stored?.success !== true || !stored.request) {
        const reason = stored?.reason || 'request-storage-unavailable'
        const status = reason === 'idempotency-key-conflict' ? 409
          : reason === 'request-rate-limit-exceeded' ? 429
            : reason === 'database-not-configured' ? 503 : 503
        return res.status(status).json({ success: false, error: reason, submissionEnabled: false })
      }
      return res.status(stored.duplicate ? 200 : 201).json({
        success: true,
        status: 'pending-organization-review',
        duplicate: stored.duplicate === true,
        request: stored.request,
        payoutAuthorized: false,
        canSubmitSponsoredTransfer: false,
        submissionEnabled: false,
        providerSubmissionAttempted: false,
        transactionBroadcast: false,
        message: 'The testnet request was stored for sponsor-organization review. This is not a budget reservation, approval, transaction, token transfer, or exchange deposit.',
      })
    } catch {
      return res.status(503).json({ success: false, error: 'request-storage-unavailable', submissionEnabled: false })
    }
  })

  router.get('/sponsorship/requests/:idempotencyKey', async (req, res) => {
    noStore(res)
    const auth = await authenticateRequester(req)
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error })
    const key = req.params?.idempotencyKey
    if (typeof key !== 'string' || !IDEMPOTENCY_PATTERN.test(key)) {
      return res.status(400).json({ success: false, error: 'invalid-idempotency-key' })
    }
    try {
      const result = await store.findRequest(key, auth.session.address, auth.session.network)
      if (!result?.success) return res.status(result?.reason === 'request-not-found' ? 404 : 503).json({ success: false, error: result?.reason || 'request-lookup-unavailable' })
      return res.json({ success: true, request: result.request, submissionEnabled: false, transactionBroadcast: false })
    } catch {
      return res.status(503).json({ success: false, error: 'request-lookup-unavailable' })
    }
  })

  router.get('/sponsorship/requests', async (req, res) => {
    noStore(res)
    if (!isValidAdminToken(req, env)) {
      return res.status(typeof env.SPONSOR_ADMIN_API_TOKEN === 'string' && env.SPONSOR_ADMIN_API_TOKEN.length >= 32 ? 401 : 503)
        .json({ success: false, error: typeof env.SPONSOR_ADMIN_API_TOKEN === 'string' && env.SPONSOR_ADMIN_API_TOKEN.length >= 32 ? 'unauthorized' : 'sponsor-admin-not-configured' })
    }
    const network = req.query?.network
    if (network !== undefined && (typeof network !== 'string' || !NETWORKS.has(network))) {
      return res.status(400).json({ success: false, error: 'invalid-network' })
    }
    const rawLimit = req.query?.limit === undefined ? '50' : String(req.query.limit)
    const limit = Number(rawLimit)
    if (!/^(?:[1-9]|[1-9][0-9]|100)$/.test(rawLimit) || !Number.isInteger(limit)) {
      return res.status(400).json({ success: false, error: 'invalid-limit' })
    }
    try {
      const result = await store.listRequests({ network: network || null, limit })
      if (result?.success !== true) {
        return res.status(503).json({ success: false, error: result?.reason || 'request-queue-unavailable' })
      }
      return res.json({
        success: true,
        status: 'pending-organization-review',
        requests: result.requests,
        count: result.requests.length,
        submissionEnabled: false,
        providerSubmissionAttempted: false,
        transactionBroadcast: false,
        message: 'This queue is for review only. Sponsor administrators must separately verify consent, budget, funding, allowlist, and authorization before creating any reservation.',
      })
    } catch {
      return res.status(503).json({ success: false, error: 'request-queue-unavailable' })
    }
  })

  return router
}

export default createSponsorRequestIntakeRouter()
